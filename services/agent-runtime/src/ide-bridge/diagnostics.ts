// The IDE's diagnostics for the files a turn touched (ADR-034 M7): pulled with
// `ide.getDiagnostics` after every write and after every terminal run, then
// handed to the phase report so `evaluateResult` sees a file left with errors
// beside the validation verdicts.

import type { AcePhaseReport } from "@metactivity/ace";
import type { AfterToolEvent } from "../ace/ace-harness";
import { toUri } from "../tools/ide";
import { ideBridge, type IdeBridgeServer } from "./server";

const WRITE_TOOLS = new Set(["write", "edit", "ide_apply_edit", "ide_create_file"]);
const RUN_TOOLS = new Set(["bash", "ide_run_terminal", "ide_run_task", "ide_apply_patch"]);
const PULL_TIMEOUT_MS = 5_000;

type Counts = { errors: number; warnings: number };

export function turnDiagnostics(cwd: string, bridge: IdeBridgeServer = ideBridge()) {
  const touched = new Map<string, Set<string>>();
  const counts = new Map<string, Map<string, Counts>>();

  return {
    /** The after_tool handler: never alters the tool result, never throws past the hook registry. */
    async afterTool(event: AfterToolEvent): Promise<undefined> {
      const name = event.toolCall.name;
      const files = touched.get(event.turnId) ?? new Set<string>();
      touched.set(event.turnId, files);
      if (WRITE_TOOLS.has(name)) {
        const path = (event.args as { path?: unknown } | null)?.path;
        if (typeof path === "string" && path) files.add(path);
      } else if (!RUN_TOOLS.has(name)) return undefined;
      if (files.size === 0 || !bridge.isConnected(cwd)) return undefined;
      const summaries = counts.get(event.turnId) ?? new Map<string, Counts>();
      counts.set(event.turnId, summaries);
      for (const file of files) {
        try {
          const { diagnostics } = await bridge.action(cwd, "ide.getDiagnostics", { uri: toUri(cwd, file) }, PULL_TIMEOUT_MS);
          summaries.set(file, {
            errors: diagnostics.filter((entry) => entry.severity === "error").length,
            warnings: diagnostics.filter((entry) => entry.severity === "warning").length,
          });
        } catch {
          // The IDE went away mid-turn: the last pulled count stands.
        }
      }
      return undefined;
    },
    /** The `diagnostics` slice of the phase report; the IDE's pushed summaries win over the pulled ones (the language server may have re-checked since). */
    phaseExtras(turnId: string): Pick<AcePhaseReport, "diagnostics"> {
      const summaries = counts.get(turnId);
      touched.delete(turnId);
      counts.delete(turnId);
      if (!summaries || summaries.size === 0) return {};
      const pushed = bridge.context(cwd)?.diagnostics ?? {};
      return { diagnostics: [...summaries].map(([file, pulled]) => ({ file, ...(pushed[toUri(cwd, file)] ?? pulled) })) };
    },
  };
}
