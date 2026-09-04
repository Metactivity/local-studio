// The Browser Bridge relay (MET-921, W10): the backend of the `chrome_*` tools.
//
// A "Tuum Browser Bridge" extension dials the runtime OUTBOUND over a
// WebSocket (`GET /bridge/ws`, src/browser-bridge/ws.ts) and the tools post
// JSON-RPC 2.0 to `POST /bridge/rpc`; this module owns what sits between:
// pairing codes, the bearer tokens they mint, the registry of connected
// browsers per session id, and the request/response matching over the socket.
//
// Wire (text frames, JSON):
//   extension → relay, first frame   {type:"pair", code, methods?}
//                                    {type:"auth", token, methods?}
//   relay → extension                {type:"paired", token, sessionId} | {type:"ready", sessionId}
//                                    {type:"error", message} then close
//   extension → relay, any time      {type:"state", readOnly} · {type:"ping"} → {type:"pong"}
//   relay → extension                JSON-RPC request {jsonrpc, id, method, params}
//   extension → relay                JSON-RPC response {jsonrpc, id, result | error}
//
// The relay never logs frames: page text and screenshots pass through only.

import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcResponse,
  rpcFailure,
  rpcRequest,
  rpcSuccess,
} from "@metactivity/protocol";
import { resolveDataDir } from "../data-dir";

export const BROWSER_METHODS = [
  "browser.navigate",
  "browser.url",
  "browser.text",
  "browser.html",
  "browser.screenshot",
  "browser.click",
  "browser.fill",
  "browser.scroll",
  "browser.eval",
  "browser.tabs.list",
  "browser.tabs.new",
  "browser.tabs.switch",
  "browser.tabs.close",
] as const;
const ALLOWED = new Set<string>(BROWSER_METHODS);

/** Bridge error codes, distinct from the IDE bridge's -32000/-32001. */
export const BRIDGE_TIMEOUT = -32000;
export const BROWSER_NOT_PAIRED = -32001;
/** Raised by the extension, never by the relay: its switch is read-only. */
export const BROWSER_READ_ONLY = -32002;

export const DEFAULT_SESSION = "default";
const PAIR_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_FRAME_CHARS = 64 * 1024 * 1024;

export class BridgeError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BrowserSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: NodeJS.Timeout;
}

interface TokenRecord {
  sessionId: string;
  pairedAt: string;
}

export interface BridgeStatus {
  sessionId: string;
  paired: boolean;
  connected: boolean;
  /** The extension's approval switch, known only while it is connected. */
  readOnly: boolean | null;
  pairing: { code: string; expiresAt: string } | null;
}

/** One connected extension. Frames arrive through `message`, the socket's close through `close`. */
export class BrowserLink {
  sessionId: string | null = null;
  readOnly = false;
  methods = new Set<string>(BROWSER_METHODS);
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(
    readonly socket: BrowserSocket,
    private readonly bridge: BrowserBridge,
  ) {}

  message(text: string): void {
    if (text.length > MAX_FRAME_CHARS) return this.#fail("frame too large");
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      frame = parsed as Record<string, unknown>;
    } catch {
      return this.#fail("malformed frame");
    }
    if (this.sessionId === null) return this.#hello(frame);
    if (frame.jsonrpc === "2.0" && (typeof frame.id === "number" || typeof frame.id === "string")) return this.#settle(frame);
    if (frame.type === "state") {
      this.readOnly = frame.readOnly === true;
      return;
    }
    if (frame.type === "ping") this.socket.send(JSON.stringify({ type: "pong" }));
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError(BROWSER_NOT_PAIRED, "browser disconnected"));
    }
    this.#pending.clear();
    if (this.sessionId !== null) this.bridge.detach(this.sessionId, this);
  }

  call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeError(BRIDGE_TIMEOUT, `browser did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(rpcRequest(id, method, params)));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new BridgeError(BROWSER_NOT_PAIRED, error instanceof Error ? error.message : "browser send failed"));
      }
    });
  }

  #hello(frame: Record<string, unknown>): void {
    const claimed = Array.isArray(frame.methods) ? frame.methods.filter((m): m is string => typeof m === "string" && ALLOWED.has(m)) : null;
    let sessionId: string;
    let reply: Record<string, unknown>;
    if (frame.type === "pair" && typeof frame.code === "string") {
      const minted = this.bridge.redeemPairing(frame.code);
      if (!minted) return this.#fail("invalid or expired pairing code");
      sessionId = minted.sessionId;
      reply = { type: "paired", token: minted.token, sessionId };
    } else if (frame.type === "auth" && typeof frame.token === "string") {
      const found = this.bridge.sessionForToken(frame.token);
      if (!found) return this.#fail("unknown token, pair again");
      sessionId = found;
      reply = { type: "ready", sessionId };
    } else {
      return this.#fail("first frame must be pair or auth");
    }
    if (claimed && claimed.length > 0) this.methods = new Set(claimed);
    this.readOnly = frame.readOnly === true;
    this.sessionId = sessionId;
    this.bridge.attachLink(sessionId, this);
    this.socket.send(JSON.stringify(reply));
  }

  #settle(frame: Record<string, unknown>): void {
    const pending = this.#pending.get(Number(frame.id));
    if (!pending) return;
    this.#pending.delete(Number(frame.id));
    clearTimeout(pending.timer);
    const error = frame.error as { code?: unknown; message?: unknown } | undefined;
    if (error && typeof error === "object") {
      pending.reject(
        new BridgeError(
          typeof error.code === "number" ? error.code : BRIDGE_TIMEOUT,
          typeof error.message === "string" ? error.message : "browser error",
        ),
      );
    } else {
      pending.resolve(frame.result);
    }
  }

  #fail(message: string): void {
    try {
      this.socket.send(JSON.stringify({ type: "error", message }));
      this.socket.close(4001, message);
    } catch {
      // socket already gone
    }
  }
}

export class BrowserBridge {
  readonly #pairings = new Map<string, { sessionId: string; expiresAt: number }>();
  readonly #links = new Map<string, BrowserLink>();
  #tokens: Record<string, TokenRecord> = {};

  constructor(
    readonly storePath: string,
    readonly timeoutMs: number,
  ) {
    if (existsSync(storePath)) {
      try {
        const parsed = JSON.parse(readFileSync(storePath, "utf8")) as { tokens?: Record<string, TokenRecord> };
        if (parsed && typeof parsed.tokens === "object" && parsed.tokens) this.#tokens = parsed.tokens;
      } catch {
        // unreadable store: pair again
      }
    }
  }

  /** A fresh 6-digit code; only one outstanding per session, 5 minutes to use it. */
  startPairing(sessionId: string): { code: string; expiresAt: string } {
    for (const [code, pairing] of this.#pairings) if (pairing.sessionId === sessionId) this.#pairings.delete(code);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = Date.now() + PAIR_TTL_MS;
    this.#pairings.set(code, { sessionId, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  redeemPairing(code: string): { token: string; sessionId: string } | null {
    const pairing = this.#pairings.get(code);
    this.#pairings.delete(code);
    if (!pairing || pairing.expiresAt < Date.now()) return null;
    const token = randomBytes(32).toString("base64url");
    this.#tokens[token] = { sessionId: pairing.sessionId, pairedAt: new Date().toISOString() };
    this.#persist();
    return { token, sessionId: pairing.sessionId };
  }

  sessionForToken(token: string): string | null {
    return this.#tokens[token]?.sessionId ?? null;
  }

  /** The socket layer hands every accepted socket here; the first frame decides the session. */
  attach(socket: BrowserSocket): BrowserLink {
    return new BrowserLink(socket, this);
  }

  attachLink(sessionId: string, link: BrowserLink): void {
    const previous = this.#links.get(sessionId);
    if (previous && previous !== link) {
      this.#links.delete(sessionId);
      previous.close();
      previous.socket.close(4000, "replaced by a newer connection");
    }
    this.#links.set(sessionId, link);
  }

  detach(sessionId: string, link: BrowserLink): void {
    if (this.#links.get(sessionId) === link) this.#links.delete(sessionId);
  }

  isConnected(sessionId: string): boolean {
    return this.#links.has(sessionId);
  }

  status(sessionId: string): BridgeStatus {
    const link = this.#links.get(sessionId);
    let pairing: BridgeStatus["pairing"] = null;
    for (const [code, entry] of this.#pairings) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.expiresAt < Date.now()) this.#pairings.delete(code);
      else pairing = { code, expiresAt: new Date(entry.expiresAt).toISOString() };
    }
    return {
      sessionId,
      paired: Object.values(this.#tokens).some((record) => record.sessionId === sessionId),
      connected: link !== undefined,
      readOnly: link ? link.readOnly : null,
      pairing,
    };
  }

  /** Serve one JSON-RPC request for a session: capabilities locally, `browser.*` through the socket. */
  async rpc(sessionId: string, id: JsonRpcId | null, method: unknown, params: unknown): Promise<JsonRpcResponse> {
    if (typeof method !== "string") return rpcFailure(id, JSON_RPC_INVALID_REQUEST, "method is required");
    const link = this.#links.get(sessionId);
    if (method === "relay.capabilities") {
      if (!link) return rpcFailure(id, BROWSER_NOT_PAIRED, "browser not paired");
      return rpcSuccess(id ?? 0, { methods: [...link.methods], readOnly: link.readOnly, session: sessionId });
    }
    if (!ALLOWED.has(method)) return rpcFailure(id, JSON_RPC_METHOD_NOT_FOUND, `unknown method ${method}`);
    if (!link) return rpcFailure(id, BROWSER_NOT_PAIRED, "browser not paired");
    if (!link.methods.has(method)) return rpcFailure(id, JSON_RPC_METHOD_NOT_FOUND, `browser does not support ${method}`);
    try {
      return rpcSuccess(id ?? 0, await link.call(method, params ?? {}, this.timeoutMs));
    } catch (error) {
      if (error instanceof BridgeError) return rpcFailure(id, error.code, error.message);
      return rpcFailure(id, BRIDGE_TIMEOUT, error instanceof Error ? error.message : String(error));
    }
  }

  /** Drops every socket and pairing; tokens stay on disk. */
  close(): void {
    for (const link of [...this.#links.values()]) {
      link.close();
      link.socket.close(1001, "relay closing");
    }
    this.#links.clear();
    this.#pairings.clear();
  }

  #persist(): void {
    writeFileSync(this.storePath, JSON.stringify({ tokens: this.#tokens }, null, 2), "utf8");
    try {
      chmodSync(this.storePath, 0o600);
    } catch {
      // best-effort
    }
  }
}

let singleton: BrowserBridge | null = null;

export function browserBridge(): BrowserBridge {
  if (!singleton) {
    const raw = Number(process.env.LOCAL_STUDIO_CHROME_TOOL_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_TIMEOUT_MS;
    singleton = new BrowserBridge(path.join(resolveDataDir(), "browser-bridge.json"), timeoutMs);
  }
  return singleton;
}

export function resetBrowserBridge(): void {
  singleton?.close();
  singleton = null;
}
