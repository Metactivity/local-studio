// The IDE bridge's HTTP surface for the panel (ADR-034 M5/M6): the live IDE
// state of a folder (context chips), the turn checkpoints of a session
// (Changes strip: list / open / diff / revert) and the pending permission asks
// of the Standard profile. Same workspace check as the ACE routes.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { answerPermission, pendingPermissions } from "../ace/ace-gate";
import { checkpointFile, revertToCheckpoint, sessionCheckpoints } from "../ide-bridge/checkpoints";
import { diagnosticsTotals } from "../ide-bridge/context";
import { ideBridge } from "../ide-bridge/server";
import { terminalRuns } from "../ide-bridge/terminals";
import { workspaceCwd } from "./ace-handlers";
import { errorMessage, jsonError, readJsonBody } from "./helpers";

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

/** The `[tuum]` terminal runs of a session in this folder (M7): name, command, exit code, output tail. */
export function handleIdeTerminals(request: Request): Response {
  const cwd = workspaceCwd(request);
  if (cwd instanceof Response) return cwd;
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() || undefined;
  return Response.json({ runs: terminalRuns(cwd, sessionId) });
}

// ─── Checkpoints ──────────────────────────────────────────────────────────

const sessionOf = (value: unknown): string | Response => (typeof value === "string" && value.trim() ? value.trim() : jsonError("sessionId is required"));

/** A workspace-relative path that stays inside the workspace. */
function insidePath(cwd: string, value: unknown): string | Response {
  if (typeof value !== "string" || !value.trim()) return jsonError("path is required");
  const relative = path.relative(cwd, path.resolve(cwd, value));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return jsonError("path is outside the workspace", 403);
  return relative;
}

export function handleCheckpointsList(request: Request): Response {
  const cwd = workspaceCwd(request);
  if (cwd instanceof Response) return cwd;
  const sessionId = sessionOf(new URL(request.url).searchParams.get("sessionId"));
  if (sessionId instanceof Response) return sessionId;
  try {
    return Response.json({ sessionId, ...sessionCheckpoints(cwd, sessionId) });
  } catch (error) {
    return jsonError(errorMessage(error, "checkpoints unavailable"), 500);
  }
}

export async function handleCheckpointRevert(request: Request): Promise<Response> {
  const body = await readJsonBody(request, { maxChars: 4_096 });
  const cwd = workspaceCwd(request, body);
  if (cwd instanceof Response) return cwd;
  const sessionId = sessionOf(body?.sessionId);
  if (sessionId instanceof Response) return sessionId;
  const n = Number(body?.n);
  if (!Number.isInteger(n) || n < 1) return jsonError("n must be a positive integer");
  try {
    const checkpoint = revertToCheckpoint(cwd, sessionId, n);
    return Response.json({ ok: true, checkpoint: { n, commit: checkpoint.commit, ref: checkpoint.ref } });
  } catch (error) {
    return jsonError(errorMessage(error, "revert failed"), 500);
  }
}

/** `mode: "open"` reveals the current file in the IDE; `mode: "diff"` shows checkpoint `n` (left) against the current file (right). */
export async function handleCheckpointShow(request: Request): Promise<Response> {
  const body = await readJsonBody(request, { maxChars: 4_096 });
  const cwd = workspaceCwd(request, body);
  if (cwd instanceof Response) return cwd;
  const file = insidePath(cwd, body?.path);
  if (file instanceof Response) return file;
  const uri = pathToFileURL(path.join(cwd, file)).toString();
  try {
    if (body?.mode === "diff") {
      const sessionId = sessionOf(body?.sessionId);
      if (sessionId instanceof Response) return sessionId;
      const n = Number(body?.n);
      if (!Number.isInteger(n) || n < 1) return jsonError("n must be a positive integer");
      const { content } = checkpointFile(cwd, sessionId, n, file);
      await ideBridge().action(cwd, "ide.showDiff", { left: { content: content ?? "" }, right: { uri }, title: `${file} (checkpoint ${n} ↔ now)` });
    } else {
      await ideBridge().action(cwd, "ide.openFile", { uri, preview: true });
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(errorMessage(error, "IDE action failed"), 502);
  }
}

// ─── Permission asks (Standard profile, IDE write actions) ────────────────

export function handlePermissionsList(request: Request): Response {
  const cwd = workspaceCwd(request);
  if (cwd instanceof Response) return cwd;
  return Response.json({ pending: pendingPermissions(cwd) });
}

export async function handlePermissionAnswer(request: Request, requestId: string): Promise<Response> {
  const body = await readJsonBody(request, { maxChars: 1_024 });
  const decision = body?.decision;
  if (decision !== "allow" && decision !== "deny") return jsonError('decision must be "allow" or "deny"');
  if (!answerPermission(requestId, decision)) return jsonError("no pending permission request with that id", 404);
  return Response.json({ ok: true });
}
