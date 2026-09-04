// The Browser Bridge relay (MET-921) against a fake extension over a real
// WebSocket: pairing (code → token → auth), JSON-RPC forwarding and its
// timeout, the not-paired and unknown-method errors, the read-only refusal
// passing through, and the chrome_* tools registering only while a browser is
// connected.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  BRIDGE_TIMEOUT,
  BROWSER_METHODS,
  BROWSER_NOT_PAIRED,
  BROWSER_READ_ONLY,
  BrowserBridge,
  browserBridge,
  resetBrowserBridge,
} from "../src/browser-bridge/relay";
import { attachBrowserBridgeWs } from "../src/browser-bridge/ws";
import { createAgentRuntimeApp } from "../src/http/app";
import { chromeTools } from "../src/tools/chrome";
import type { ToolContext } from "../src/tools/context";

let root: string;
let previousEnv: Record<string, string | undefined>;
let bridge: BrowserBridge;
let app: Hono;
let server: Server;
/** The WebSocket base; HTTP goes through `app.request` in process, as the tools do. */
let base: string;

/** The extension side, reduced to the contract: one socket, a handler table, frames in and out. */
class FakeBrowser {
  readonly ws: WebSocket;
  readonly frames: Record<string, unknown>[] = [];
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {};
  #waiters: ((frame: Record<string, unknown>) => void)[] = [];

  constructor(first: Record<string, unknown>) {
    this.ws = new WebSocket(`${base.replace("http", "ws")}/bridge/ws`);
    this.ws.onopen = () => this.ws.send(JSON.stringify(first));
    this.ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      this.frames.push(frame);
      if (frame.jsonrpc === "2.0" && typeof frame.method === "string") {
        const handler = this.handlers[frame.method];
        if (handler) {
          try {
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: handler((frame.params ?? {}) as Record<string, unknown>) }));
          } catch (error) {
            const { code, message } = error as { code: number; message: string };
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code, message } }));
          }
        }
      }
      for (const waiter of this.#waiters.splice(0)) waiter(frame);
    };
  }

  next(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const seen = this.frames.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no matching frame")), 2_000);
      const waiter = (frame: Record<string, unknown>) => {
        if (!predicate(frame)) return this.#waiters.push(waiter);
        clearTimeout(timer);
        resolve(frame);
      };
      this.#waiters.push(waiter);
    });
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  closed(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => this.ws.addEventListener("close", () => resolve(), { once: true }));
  }
}

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { host: "127.0.0.1", ...(init.headers as Record<string, string> | undefined) } });

const rpc = (method: string, params: Record<string, unknown> = {}, session = "default", headers: Record<string, string> = {}) =>
  request("/bridge/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tuum-Session": session, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  }).then((response) => response.json() as Promise<Record<string, unknown>>);

const toolContext = (env: Record<string, string | undefined> = {}): ToolContext => ({
  cwd: root,
  sessionId: "s1",
  modelId: "m",
  env,
  request,
  gates: { browser: true, chrome: true, github: false, obsidian: false, connectors: false },
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "browser-bridge-"));
  previousEnv = { LOCAL_STUDIO_DATA_DIR: process.env.LOCAL_STUDIO_DATA_DIR, LOCAL_STUDIO_CHROME_TOOL_TIMEOUT_MS: process.env.LOCAL_STUDIO_CHROME_TOOL_TIMEOUT_MS };
  process.env.LOCAL_STUDIO_DATA_DIR = root;
  process.env.LOCAL_STUDIO_CHROME_TOOL_TIMEOUT_MS = "300";
  resetBrowserBridge();
  bridge = browserBridge();
  app = createAgentRuntimeApp().app;
  // A bare node server for the upgrade only (@hono/node-server would swap the
  // global Response for its lightweight one and break the other test files).
  server = createServer((_, response) => {
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  attachBrowserBridgeWs(server, bridge);
});

afterAll(async () => {
  resetBrowserBridge();
  // bun test runs every file in one process: leave the env as it was found.
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("browser bridge relay", () => {
  test("unpaired: capabilities and browser.* fail fast with -32001; unknown methods are -32601", async () => {
    expect(await rpc("relay.capabilities")).toMatchObject({ id: 7, error: { code: BROWSER_NOT_PAIRED, message: "browser not paired" } });
    expect(await rpc("browser.url")).toMatchObject({ error: { code: BROWSER_NOT_PAIRED } });
    expect(await rpc("chrome.debugger.attach")).toMatchObject({ error: { code: -32601 } });
    expect(await chromeTools(toolContext())).toEqual([]);
    const bad = await request("/bridge/rpc", { method: "POST", body: "nope" });
    expect(bad.status).toBe(400);
    const spoofed = await fetch(`${base}/bridge/ws`, { headers: { Host: "evil.example", Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "AAAAAAAAAAAAAAAAAAAAAA==", "Sec-WebSocket-Version": "13" } }).then(
      (response) => response.status,
      () => "refused",
    );
    expect(spoofed).not.toBe(101);
  });

  test("pairing: a wrong code is refused; the right one mints a token that re-authenticates; then RPC round-trips", async () => {
    const wrong = new FakeBrowser({ type: "pair", code: "000000" });
    expect(await wrong.next((f) => f.type === "error")).toMatchObject({ message: "invalid or expired pairing code" });
    await wrong.closed();

    const { code } = bridge.startPairing("default");
    expect(code).toMatch(/^\d{6}$/);
    expect(bridge.status("default").pairing?.code).toBe(code);
    const first = new FakeBrowser({ type: "pair", code, methods: ["browser.url", "browser.text", "browser.click"] });
    const paired = await first.next((f) => f.type === "paired");
    expect(paired).toMatchObject({ sessionId: "default" });
    const token = paired.token as string;
    expect(bridge.status("default")).toMatchObject({ paired: true, connected: true, readOnly: false, pairing: null });
    // A second redeem of the same code fails: one-time.
    const replay = new FakeBrowser({ type: "pair", code });
    expect(await replay.next((f) => f.type === "error")).toBeTruthy();

    // Only the advertised methods are offered to the model.
    expect(await rpc("relay.capabilities")).toMatchObject({ result: { methods: ["browser.url", "browser.text", "browser.click"] } });
    const tools = await chromeTools(toolContext());
    expect(tools.map((t) => t.name)).toEqual(["chrome_get_url", "chrome_get_text", "chrome_click", "chrome_history"]);

    first.handlers["browser.url"] = () => ({ url: "https://example.test/", title: "Example" });
    expect(await rpc("browser.url")).toEqual({ jsonrpc: "2.0", id: 7, result: { url: "https://example.test/", title: "Example" } });
    const viaTool = await tools[0].execute("call-1", {});
    expect(viaTool.details).toMatchObject({ data: { url: "https://example.test/" } });
    // Legacy header name still addresses the session.
    expect(await rpc("browser.url", {}, "ignored", { "X-Sitegeist-Session": "default", "X-Tuum-Session": "" })).toMatchObject({ result: { title: "Example" } });

    // Read-only refusal comes from the extension and reaches the tool as a failure.
    first.send({ type: "state", readOnly: true });
    first.handlers["browser.click"] = () => {
      throw { code: BROWSER_READ_ONLY, message: "read-only mode" };
    };
    expect(await rpc("browser.click", { selector: "button" })).toMatchObject({ error: { code: BROWSER_READ_ONLY, message: "read-only mode" } });
    const clicked = await tools[2].execute("call-2", { selector: "button" });
    expect(clicked.details).toMatchObject({ failed: true, error: "read-only mode" });
    expect(bridge.status("default").readOnly).toBe(true);

    // An unanswered request times out at the relay's bound, not the tool's.
    expect(await rpc("browser.text")).toMatchObject({ error: { code: BRIDGE_TIMEOUT } });
    // A method the browser did not advertise is refused without a round trip.
    expect(await rpc("browser.tabs.list")).toMatchObject({ error: { code: -32601 } });

    // A later connection authenticates with the token as its first frame and replaces the old one.
    const second = new FakeBrowser({ type: "auth", token });
    expect(await second.next((f) => f.type === "ready")).toMatchObject({ sessionId: "default" });
    await first.closed();
    expect(await rpc("relay.capabilities")).toMatchObject({ result: { methods: [...BROWSER_METHODS] } });
    // The token survives a relay restart (the store file), the socket does not.
    const restarted = new BrowserBridge(bridge.storePath, 300);
    expect(restarted.sessionForToken(token)).toBe("default");
    expect(restarted.status("default")).toMatchObject({ paired: true, connected: false });

    second.ws.close();
    await second.closed();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await rpc("browser.url")).toMatchObject({ error: { code: BROWSER_NOT_PAIRED } });
    expect(await chromeTools(toolContext())).toEqual([]);
    const bogus = new FakeBrowser({ type: "auth", token: "nope" });
    expect(await bogus.next((f) => f.type === "error")).toMatchObject({ message: "unknown token, pair again" });
  });

  test("the tools prefer LOCAL_STUDIO_BRIDGE_* and fall back to the legacy relay names only when a bridge address is absent", async () => {
    const { readEnv } = await import("../src/tools/chrome");
    expect(readEnv(toolContext({}))).toMatchObject({ rpcUrl: null, sessionId: "default" });
    expect(readEnv(toolContext({ LOCAL_STUDIO_BRIDGE_URL: "http://spark:8081/", LOCAL_STUDIO_BRIDGE_TOKEN: "t", LOCAL_STUDIO_BRIDGE_SESSION: "s" }))).toMatchObject({
      rpcUrl: "http://spark:8081/bridge/rpc",
      token: "t",
      sessionId: "s",
    });
    expect(readEnv(toolContext({ LOCAL_STUDIO_CHROME_RELAY_URL: "http://127.0.0.1:7717", LOCAL_STUDIO_CHROME_RELAY_SESSION: "legacy" }))).toMatchObject({
      rpcUrl: "http://127.0.0.1:7717/rpc",
      sessionId: "legacy",
    });
    expect(readEnv(toolContext({ LOCAL_STUDIO_CHROME_RELAY_URL: "http://127.0.0.1:7717", LOCAL_STUDIO_BRIDGE_URL: "" }))).toMatchObject({ rpcUrl: null });
  });
});
