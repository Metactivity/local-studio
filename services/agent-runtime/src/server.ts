import { serve } from "@hono/node-server";
import { agentCore } from "./agent-core";
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

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(
    `[agent-runtime] listening on http://127.0.0.1:${info.port} (pid ${process.pid}, node ${process.version})`,
  );
});

process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
