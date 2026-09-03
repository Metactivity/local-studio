// The extension side of the IDE bridge, reduced to what the contract needs:
// a socket, frames in, frames out, handlers for the runtime's `ide.*` actions.

import { createConnection, type Socket } from "node:net";
import { encodeFrame, type JsonRpcMessage, parseJsonRpc, rpcRequest, rpcSuccess } from "@metactivity/protocol";

/** The extension side, reduced to what the contract needs: a socket, frames in, frames out. */
export class FakeExtension {
  readonly frames: JsonRpcMessage[] = [];
  readonly handlers: Record<string, (params: unknown) => unknown> = {};
  #socket: Socket | undefined;
  #waiters: ((message: JsonRpcMessage) => void)[] = [];

  connect(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path, resolve);
      this.#socket = socket;
      socket.setEncoding("utf8");
      socket.on("error", reject);
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (const line of buffer.split("\n").slice(0, -1)) {
          const message = parseJsonRpc(line);
          if (message === null) continue;
          this.frames.push(message);
          if ("method" in message && "id" in message) {
            const handler = this.handlers[message.method];
            if (handler) this.send(rpcSuccess(message.id, handler(message.params)));
          }
          for (const waiter of this.#waiters.splice(0)) waiter(message);
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      });
    });
  }

  send(message: JsonRpcMessage): void {
    this.#socket?.write(encodeFrame(message));
  }

  next(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no matching frame")), 2_000);
      const waiter = (message: JsonRpcMessage) => {
        if (!predicate(message)) return this.#waiters.push(waiter);
        clearTimeout(timer);
        resolve(message);
      };
      this.#waiters.push(waiter);
    });
  }

  async hello(folder: string, id = 1) {
    const ack = this.next((frame) => "id" in frame && frame.id === id);
    this.send(rpcRequest(id, "ide.hello", { sessionId: "s1", folder, extensionVersion: "0.1.0", protocolVersion: 1 }));
    return ack;
  }

  close(): void {
    this.#socket?.destroy();
  }
}

export const until = (check: () => boolean, timeoutMs = 2_000) =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = () => (check() ? resolve() : Date.now() - started > timeoutMs ? reject(new Error("condition not met")) : setTimeout(tick, 5));
    tick();
  });

