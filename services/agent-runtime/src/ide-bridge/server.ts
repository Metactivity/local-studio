// The IDE Bridge server (ADR-034 §2.2): a Unix socket the `ace-agent`
// extension of the embedded workbench connects to, newline-delimited JSON-RPC
// 2.0. One connection per workspace folder (a new hello for the same folder
// replaces the old one); events update the per-folder context, `ace/*`
// requests hit the runtime's ACE, and the harness sends `ide.*` actions back.

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import {
  BRIDGE_TIMEOUT,
  BRIDGE_UNAVAILABLE,
  encodeFrame,
  IDE_HELLO_METHOD,
  IDE_PROTOCOL_VERSION,
  type IdeActionName,
  type IdeActionParams,
  type IdeActionResult,
  type IdeHelloAck,
  isAceBridgeMethod,
  isIdeEventName,
  isIdeHello,
  isRpcNotification,
  isRpcRequest,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  parseJsonRpc,
  rpcFailure,
  rpcRequest,
  rpcSuccess,
} from "@metactivity/protocol";
import { resolveDataDir } from "../data-dir";
import { resolveAllowedWorkspace } from "../projects-store";
import { AceEndpointError, serveAceRequest } from "./ace-endpoint";
import { applyIdeEvent, emptyContext, type IdeContext } from "./context";

export const HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const MAX_FRAME_CHARS = 4 * 1024 * 1024;

export class IdeBridgeError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function ideBridgeSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.IDE_BRIDGE_SOCKET?.trim() || path.join(resolveDataDir(), "ide-bridge.sock");
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class IdeConnection {
  context: IdeContext | null = null;
  folder: string | null = null;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<JsonRpcId, Pending>();
  #idle: NodeJS.Timeout | null = null;

  constructor(
    readonly socket: Socket,
    private readonly bridge: IdeBridgeServer,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => this.#onClose());
    this.#touch();
  }

  #touch(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      this.bridge.log(`heartbeat timeout${this.folder ? ` for ${this.folder}` : ""}, closing`);
      this.socket.destroy();
    }, this.bridge.heartbeatTimeoutMs);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_FRAME_CHARS) {
      this.bridge.log("frame too large, closing");
      this.socket.destroy();
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) void this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  async #onLine(line: string): Promise<void> {
    this.#touch();
    const message = parseJsonRpc(line);
    if (message === null) {
      this.write(rpcFailure(null, JSON_RPC_INVALID_REQUEST, "malformed JSON-RPC frame"));
      return;
    }
    if (isRpcRequest(message)) return this.#onRequest(message);
    if (isRpcNotification(message)) return this.#onNotification(message.method, message.params);
    this.#settle(message);
  }

  async #onRequest(request: JsonRpcRequest): Promise<void> {
    if (request.method === IDE_HELLO_METHOD) return this.#onHello(request);
    if (this.folder === null) {
      this.write(rpcFailure(request.id, JSON_RPC_INVALID_REQUEST, "ide.hello first"));
      return;
    }
    if (!isAceBridgeMethod(request.method)) {
      this.write(rpcFailure(request.id, JSON_RPC_METHOD_NOT_FOUND, `unknown method ${request.method}`));
      return;
    }
    try {
      this.write(rpcSuccess(request.id, await serveAceRequest(request.method, request.params)));
    } catch (error) {
      const code = error instanceof AceEndpointError ? error.code : JSON_RPC_INTERNAL_ERROR;
      this.write(rpcFailure(request.id, code, error instanceof Error ? error.message : String(error)));
    }
  }

  #onHello(request: JsonRpcRequest): void {
    if (!isIdeHello(request.params)) {
      this.write(rpcFailure(request.id, JSON_RPC_INVALID_PARAMS, "hello needs sessionId, folder, extensionVersion, protocolVersion"));
      return;
    }
    if (request.params.protocolVersion !== IDE_PROTOCOL_VERSION) {
      this.write(rpcFailure(request.id, JSON_RPC_INVALID_PARAMS, `protocol ${request.params.protocolVersion} is not supported (runtime speaks ${IDE_PROTOCOL_VERSION})`));
      return;
    }
    let folder: string;
    try {
      folder = resolveAllowedWorkspace(request.params.folder);
    } catch (error) {
      this.write(rpcFailure(request.id, JSON_RPC_INVALID_PARAMS, error instanceof Error ? error.message : "folder is not allowed"));
      return;
    }
    this.folder = folder;
    this.context = emptyContext(request.params);
    this.bridge.attach(folder, this);
    const ack: IdeHelloAck = { protocolVersion: IDE_PROTOCOL_VERSION, runtimeVersion: this.bridge.runtimeVersion };
    this.write(rpcSuccess(request.id, ack));
    this.bridge.log(`hello from ${folder} (session ${request.params.sessionId}, extension ${request.params.extensionVersion})`);
  }

  async #onNotification(method: string, params: unknown): Promise<void> {
    if (this.folder === null || this.context === null) return;
    if (isIdeEventName(method)) {
      this.context = applyIdeEvent(this.context, method, params);
      this.bridge.onEvent(this.folder, method, params);
      return;
    }
    if (method === "ace/observeAgentEvent") {
      await serveAceRequest(method, params).catch(() => undefined);
    }
  }

  #settle(response: JsonRpcResponse): void {
    if (response.id === null) return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if ("error" in response) pending.reject(new IdeBridgeError(response.error.code, response.error.message));
    else pending.resolve(response.result);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new IdeBridgeError(BRIDGE_TIMEOUT, `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.write(rpcRequest(id, method, params));
    });
  }

  write(message: JsonRpcMessage): void {
    if (!this.socket.destroyed) this.socket.write(encodeFrame(message));
  }

  #onClose(): void {
    if (this.#idle) clearTimeout(this.#idle);
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new IdeBridgeError(BRIDGE_UNAVAILABLE, "IDE disconnected"));
      this.#pending.delete(id);
    }
    if (this.folder !== null) this.bridge.detach(this.folder, this);
  }
}

export interface IdeBridgeOptions {
  socketPath?: string;
  runtimeVersion?: string;
  heartbeatTimeoutMs?: number;
  log?: (message: string) => void;
}

export class IdeBridgeServer {
  readonly socketPath: string;
  readonly runtimeVersion: string;
  readonly heartbeatTimeoutMs: number;
  readonly log: (message: string) => void;
  readonly #connections = new Map<string, IdeConnection>();
  readonly #listeners = new Set<(folder: string, method: string, params: unknown) => void>();
  #server: Server | null = null;

  constructor(options: IdeBridgeOptions = {}) {
    this.socketPath = options.socketPath ?? ideBridgeSocketPath();
    this.runtimeVersion = options.runtimeVersion ?? "local-studio-agent-runtime";
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.log = options.log ?? ((message) => console.log(`[ide-bridge] ${message}`));
  }

  async listen(): Promise<void> {
    if (this.#server) return;
    // ponytail: a stale socket file is unlinked unconditionally — one runtime
    // per data dir is the deployment; probe-before-unlink if that changes.
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    const server = createServer((socket) => new IdeConnection(socket, this));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
    this.#server = server;
    this.log(`listening on ${this.socketPath}`);
  }

  async close(): Promise<void> {
    for (const connection of this.#connections.values()) connection.socket.destroy();
    this.#connections.clear();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }

  attach(folder: string, connection: IdeConnection): void {
    const previous = this.#connections.get(folder);
    if (previous && previous !== connection) {
      previous.folder = null;
      previous.socket.destroy();
    }
    this.#connections.set(folder, connection);
  }

  detach(folder: string, connection: IdeConnection): void {
    if (this.#connections.get(folder) === connection) {
      this.#connections.delete(folder);
      this.log(`disconnected ${folder}`);
    }
  }

  onEvent(folder: string, method: string, params: unknown): void {
    for (const listener of this.#listeners) listener(folder, method, params);
  }

  subscribe(listener: (folder: string, method: string, params: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isConnected(folder: string): boolean {
    return this.#connections.has(folder);
  }

  context(folder: string): IdeContext | null {
    return this.#connections.get(folder)?.context ?? null;
  }

  /** One typed action to the IDE of `folder`; rejects with `IdeBridgeError` when none is connected or on timeout. */
  action<M extends IdeActionName>(folder: string, method: M, params: IdeActionParams<M>, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS): Promise<IdeActionResult<M>> {
    const connection = this.#connections.get(folder);
    if (!connection) return Promise.reject(new IdeBridgeError(BRIDGE_UNAVAILABLE, `no IDE connected for ${folder}`));
    return connection.request(method, params, timeoutMs) as Promise<IdeActionResult<M>>;
  }
}

let processBridge: IdeBridgeServer | null = null;

/** The process-wide bridge; `listen()` is the caller's (server boot) — tests build their own. */
export function ideBridge(): IdeBridgeServer {
  processBridge ??= new IdeBridgeServer();
  return processBridge;
}

/** Test seam. */
export async function resetIdeBridge(): Promise<void> {
  await processBridge?.close();
  processBridge = null;
}
