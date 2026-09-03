// Terminal runs through the IDE (ADR-034 M7): `ide.runTerminal` on the bridge,
// the streamed `ide.terminal.output` chunks fed to the tool result as progress,
// and a per-folder registry of the runs (bounded tail, exit code) the Changes
// strip lists. One shape for the `ide_run_terminal` tool and the `bash`
// re-route, so both read like the harness `bash` tool to the model and to the
// phase report ("Command exited with code N").

import { BRIDGE_UNAVAILABLE } from "@metactivity/protocol";
import type { ToolResult } from "../tools/context";
import { ideBridge, IdeBridgeError, type IdeBridgeServer } from "./server";

export const TERMINAL_TAIL_CHARS = 64 * 1024;
const MAX_RUNS_PER_FOLDER = 50;
/** The bridge request outlives the terminal's own budget by this much. */
const ACTION_GRACE_MS = 10_000;

export interface TerminalRun {
  termId: string | null;
  name: string;
  command: string;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  captured: boolean;
  /** The last 64 KB of the captured output. */
  tail: string;
}

export interface TerminalRunRequest {
  cwd: string;
  sessionId: string;
  command: string;
  name?: string;
  timeoutMs: number;
}

const runsByFolder = new Map<string, TerminalRun[]>();
/** Folders whose `[tuum]` terminal has no shell integration: the `bash` re-route stops for them. */
const noCapture = new Set<string>();

export function terminalRuns(folder: string, sessionId?: string): TerminalRun[] {
  return (runsByFolder.get(folder) ?? []).filter((run) => sessionId === undefined || run.sessionId === sessionId);
}

export function terminalCaptureAvailable(folder: string): boolean {
  return !noCapture.has(folder);
}

/** Test seam. */
export function resetTerminalRuns(): void {
  runsByFolder.clear();
  noCapture.clear();
}

export const isBridgeUnavailable = (error: unknown): boolean => error instanceof IdeBridgeError && error.code === BRIDGE_UNAVAILABLE;

/**
 * Runs the command in the IDE terminal and returns a `bash`-shaped tool result:
 * output text, a thrown Error carrying the output on a non-zero exit or a
 * timeout, and a note that it ran in the editor. Rejects with `IdeBridgeError`
 * when no IDE is connected — the caller decides whether to fall back.
 */
export async function runInIdeTerminal(
  request: TerminalRunRequest,
  onUpdate?: (partial: ToolResult) => void,
  bridge: IdeBridgeServer = ideBridge(),
): Promise<ToolResult> {
  const name = request.name?.trim() || "agent";
  const run: TerminalRun = {
    termId: null,
    name,
    command: request.command,
    sessionId: request.sessionId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    captured: false,
    tail: "",
  };
  const runs = runsByFolder.get(request.cwd) ?? [];
  runs.push(run);
  if (runs.length > MAX_RUNS_PER_FOLDER) runs.shift();
  runsByFolder.set(request.cwd, runs);

  // ponytail: every chunk of the folder is taken as this run's progress —
  // tools run sequentially per session, and the final text comes from the
  // result, so a concurrent run in another session only blurs the live view.
  let progress = "";
  const off = bridge.subscribe((folder, method, params) => {
    if (folder !== request.cwd || method !== "ide.terminal.output") return;
    const chunk = (params as { chunk?: unknown } | null)?.chunk;
    if (typeof chunk !== "string") return;
    progress = (progress + chunk).slice(-TERMINAL_TAIL_CHARS);
    run.tail = progress;
    onUpdate?.({ content: [{ type: "text", text: progress }], details: { name } });
  });
  let result: Awaited<ReturnType<IdeBridgeServer["action"]>> & { termId: string; exitCode: number | null; output: string | null; captured: boolean };
  try {
    result = await bridge.action(
      request.cwd,
      "ide.runTerminal",
      { cmd: request.command, cwd: request.cwd, name, captureOutput: true, timeoutMs: request.timeoutMs },
      request.timeoutMs + ACTION_GRACE_MS,
    );
  } finally {
    off();
    run.endedAt = new Date().toISOString();
  }
  run.termId = result.termId;
  run.exitCode = result.exitCode;
  run.captured = result.captured;
  run.tail = (result.output ?? progress).slice(-TERMINAL_TAIL_CHARS);
  const where = `[ran in the IDE terminal "[tuum] ${name}"]`;
  const details = { termId: result.termId, exitCode: result.exitCode, captured: result.captured, name };
  if (!result.captured) {
    noCapture.add(request.cwd);
    return {
      content: [{ type: "text", text: `${where} The terminal has no shell integration, so the output was not captured. Run the command again to read its output.` }],
      details,
    };
  }
  const output = run.tail.trimEnd();
  const status = (line: string) => `${output ? `${output}\n\n` : ""}${line}`;
  if (result.exitCode === null) throw new Error(status(`Command timed out after ${Math.round(request.timeoutMs / 1000)} seconds (still running in the IDE terminal)`));
  if (result.exitCode !== 0) throw new Error(status(`Command exited with code ${result.exitCode}`));
  return { content: [{ type: "text", text: `${output || "(no output)"}\n\n${where}` }], details };
}
