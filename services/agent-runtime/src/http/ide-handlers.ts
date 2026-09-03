// GET /api/agent/ide/context?cwd= — the live IDE state of a folder for the
// panel's context chips (ADR-034 M5). Same workspace check as the ACE routes.

import { ideBridge } from "../ide-bridge/server";
import { diagnosticsTotals } from "../ide-bridge/context";
import { workspaceCwd } from "./ace-handlers";

export function handleIdeContext(request: Request): Response {
  const cwd = workspaceCwd(request);
  if (cwd instanceof Response) return cwd;
  const context = ideBridge().context(cwd);
  return Response.json({
    connected: context !== null,
    socketPath: ideBridge().socketPath,
    context,
    totals: context ? diagnosticsTotals(context) : null,
  });
}
