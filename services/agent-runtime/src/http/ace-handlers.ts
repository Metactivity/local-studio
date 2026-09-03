// The ACE surfaces of the agent panel (ADR-034 M4): status, memory, the
// proposals inbox and the Context Lens, each a thin read or write over the
// process-wide NativeService. The workspace folder arrives as the workspace
// identity (X-Tuum-Folder, or ?cwd= / body.cwd) and is checked against
// WORKSPACE_ROOTS like every other folder-addressed route.

import path from "node:path";
import { sessionIdentity } from "../../../../shared/agent/workspace-identity";
import { aceStatus } from "../ace/ace-service";
import type { AnyJournalRecord } from "../ace/ace-journal";
import { startedAceService } from "../harness-runtime";
import { resolveAllowedWorkspace } from "../projects-store";
import { piRuntimeManager } from "../runtime-manager";
import { errorMessage, jsonError, readJsonBody } from "./helpers";

async function requireAce() {
  const ace = await startedAceService();
  if (ace) return ace;
  const { problems } = await aceStatus();
  return jsonError(`ACE is not configured: ${problems.join("; ") || "no service"}`, 503);
}

export function workspaceCwd(request: Request, body: Record<string, unknown> | null = null): string | Response {
  const query = new URL(request.url).searchParams.get("cwd");
  const { cwd } = sessionIdentity(request.headers, { cwd: typeof body?.cwd === "string" ? body.cwd : query });
  if (!cwd) return jsonError("cwd is required");
  if (!path.isAbsolute(cwd)) return jsonError("cwd must be absolute");
  try {
    return resolveAllowedWorkspace(cwd);
  } catch (error) {
    return jsonError(errorMessage(error, "cwd is not allowed"), 403);
  }
}

// ─── GET /api/agent/ace/status ────────────────────────────────────────────

export async function handleAceStatus(request: Request): Promise<Response> {
  const ace = await startedAceService();
  const report = await aceStatus();
  const query = new URL(request.url).searchParams.get("cwd");
  const { cwd } = sessionIdentity(request.headers, { cwd: query });
  let control: Record<string, unknown> | null = null;
  if (ace && cwd) {
    try {
      control = await ace.controlSnapshot(resolveAllowedWorkspace(cwd));
    } catch (error) {
      control = { error: errorMessage(error, "control snapshot failed") };
    }
  }
  return Response.json({ ...report, runtimeSnapshot: ace?.runtimeSnapshot() ?? null, control });
}

// ─── GET /api/agent/ace/proposals ─────────────────────────────────────────

export async function handleAceProposals(request: Request): Promise<Response> {
  const ace = await requireAce();
  if (ace instanceof Response) return ace;
  const cwd = workspaceCwd(request);
  if (cwd instanceof Response) return cwd;
  const status = new URL(request.url).searchParams.get("status")?.trim() || "pending";
  return Response.json({ proposals: ace.listProposals(cwd, status) });
}

// ─── POST /api/agent/ace/proposals/:id ────────────────────────────────────

export async function handleAceProposalResolve(request: Request, id: string): Promise<Response> {
  const ace = await requireAce();
  if (ace instanceof Response) return ace;
  const body = await readJsonBody(request, { maxChars: 64 * 1024 });
  if (!body) return jsonError("Invalid JSON body");
  const cwd = workspaceCwd(request, body);
  if (cwd instanceof Response) return cwd;
  const proposalId = Number.parseInt(id, 10);
  if (!Number.isInteger(proposalId) || proposalId <= 0) return jsonError("proposal id must be a positive integer");
  if (body.action !== "accept" && body.action !== "reject") return jsonError('action must be "accept" or "reject"');
  const content = typeof body.content === "string" && body.content.trim() ? body.content.trim() : undefined;
  const scope = body.scope === "global" ? "global" : "project";
  const result = ace.resolveProposal(cwd, proposalId, body.action, content, scope);
  return result.error ? jsonError(result.error) : Response.json({ ok: true, bulletId: result.bulletId ?? null });
}

// ─── GET /api/agent/ace/memory ────────────────────────────────────────────

export async function handleAceMemory(request: Request): Promise<Response> {
  const ace = await requireAce();
  if (ace instanceof Response) return ace;
  const cwd = workspaceCwd(request);
  if (cwd instanceof Response) return cwd;
  return Response.json({ playbook: ace.readPlaybook(cwd), bullets: ace.listMemory(cwd) });
}

// ─── GET /api/agent/ace/lens ──────────────────────────────────────────────

/** The journal lives on the running harness; a session that is not running has no lens to show. */
export function handleAceLens(request: Request): Response {
  const searchParams = new URL(request.url).searchParams;
  const { sessionId } = sessionIdentity(request.headers, { sessionId: searchParams.get("sessionId") });
  const piSessionId = searchParams.get("piSessionId")?.trim() || null;
  const resolved = piRuntimeManager.findSessionForLookup(sessionId, piSessionId);
  const journal = (resolved?.session as { aceJournal?: () => AnyJournalRecord[] } | undefined)?.aceJournal;
  return Response.json({ sessionId: resolved?.sessionId ?? sessionId, records: journal ? journal.call(resolved!.session) : [] });
}

// ─── POST /api/agent/ace/rebuild-graph · /api/agent/ace/restart ──────────

export async function handleAceRebuildGraph(request: Request): Promise<Response> {
  const ace = await requireAce();
  if (ace instanceof Response) return ace;
  const cwd = workspaceCwd(request, await readJsonBody(request, { maxChars: 4_096 }));
  if (cwd instanceof Response) return cwd;
  try {
    return Response.json(await ace.rebuildGraph(cwd));
  } catch (error) {
    return jsonError(errorMessage(error, "graph rebuild failed"), 500);
  }
}

export async function handleAceRestart(): Promise<Response> {
  const ace = await requireAce();
  if (ace instanceof Response) return ace;
  const ok = await ace.restart();
  return Response.json({ ok, health: ace.state });
}
