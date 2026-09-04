import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { agentCore } from "./agent-core";
import { attachBrowserBridgeWs } from "./browser-bridge/ws";
import { startAutomationScheduler } from "./automation-scheduler";
import "./harness";
import { createAgentRuntimeApp } from "./http/app";
import { ideBridge } from "./ide-bridge/server";

agentCore();
startAutomationScheduler();
// The embedded workbench connects here (ADR-034 M5); a failed listen is logged, the runtime still serves.
ideBridge()
  .listen()
  .catch((error: unknown) => console.warn(`[ide-bridge] not listening: ${error instanceof Error ? error.message : String(error)}`));

const { app } = createAgentRuntimeApp();
const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8081;
// Loopback unless the operator opens it for the edge (the Browser Bridge WebSocket, MET-921);
// the runtime has no auth of its own, so a non-loopback bind relies on the host firewall.
const hostname = process.env.LOCAL_STUDIO_AGENT_RUNTIME_HOST?.trim() || "127.0.0.1";

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(
    `[agent-runtime] listening on http://${hostname}:${info.port} (pid ${process.pid}, node ${process.version})`,
  );
});

// The browser extension's WebSocket rides the same listener (MET-921).
attachBrowserBridgeWs(server as Server);

process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
