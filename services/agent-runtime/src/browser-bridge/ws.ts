// `GET /bridge/ws`: the WebSocket the Tuum Browser Bridge extension dials.
// Hono has no upgrade hook under @hono/node-server, so the upgrade is taken on
// the node server itself (works under node and bun alike). Same loopback Host
// rule as the HTTP app: the runtime is reached through a tunnel or the
// machine itself, never by name.

import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { isLoopbackHost } from "../http/app";
import { browserBridge } from "./relay";

export const BRIDGE_WS_PATH = "/bridge/ws";

export function attachBrowserBridgeWs(server: Server, bridge = browserBridge()): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== BRIDGE_WS_PATH || !isLoopbackHost(request.headers.host)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const link = bridge.attach({
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      });
      ws.on("message", (data) => link.message(data.toString()));
      ws.on("close", () => link.close());
      ws.on("error", () => undefined);
    });
  });
  return wss;
}
