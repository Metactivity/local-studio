// Subagent tools. `subagent` spawns an independent child session in the runtime
// (same project, own context) and returns its final report; `subagent_list` /
// `subagent_status` / `subagent_stop` supervise children that outlived the call
// that spawned them. The safety properties live in src/subagents.ts (at most
// four children per parent, no nesting, management scoped to the caller's own
// session id); these tools only speak to its HTTP surface.
//
// Ported from pi-extensions/subagents.ts; names, descriptions and schemas unchanged.

import { Type } from "@earendil-works/pi-ai";
import { failure, type HarnessTool, textResult, type ToolContext, withTimeout } from "./context";

const RUN_TIMEOUT_MS = 15 * 60_000;
const MANAGE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
/** Consecutive failed status polls tolerated before giving up (~1 minute). */
const MAX_POLL_FAILURES = 12;
const SAFETY_NOTE = "At most 4 subagents run at once per session, and subagents cannot spawn their own subagents.";

type SubagentSummary = {
  id?: string;
  name?: string;
  status?: string;
  active?: boolean;
  piSessionId?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  error?: string | null;
  report?: string;
};

/** One request shape for every route: abort on the turn's signal, always time
 *  out, always come back with parsed JSON or a message — never a throw. */
async function callRuntime(
  ctx: ToolContext,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string }> {
  const bounded = withTimeout(signal, timeoutMs);
  try {
    const response = await ctx.request(path, {
      method: init.method,
      ...(init.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
      signal: bounded.signal,
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) return { ok: false, error: String(payload.error ?? response.status) };
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    bounded.done();
  }
}

function formatRun(run: SubagentSummary): string {
  const state = run.status === "running" && run.active === false ? "running (idle)" : run.status;
  const detail = run.error ? ` — ${run.error}` : "";
  return `- ${run.id ?? "?"}  ${run.name ?? "subagent"}  [${state}]  ${run.finishedAt ?? run.startedAt ?? ""}${detail}`;
}

function readRunId(params: unknown): string {
  const raw = (params as { runId?: unknown } | undefined)?.runId;
  return typeof raw === "string" ? raw.trim() : "";
}

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const runIdParam = Type.Object({ runId: Type.String({ description: "The run id from subagent_list, e.g. '4f2a1c9d'." }) });

export function subagentTools(ctx: ToolContext): HarnessTool[] {
  const piSessionId = ctx.sessionId;
  const statusPath = (runId: string) => `/api/agent/subagents/${encodeURIComponent(runId)}?piSessionId=${encodeURIComponent(piSessionId)}`;
  return [
    {
      name: "subagent",
      label: "Subagent",
      description:
        "Delegate a self-contained task to an independent subagent with its own fresh context. " +
        "Use for parallelizable research, reviews, or implementation chunks — call this tool " +
        "multiple times in one turn to fan out. Give each subagent a short name and a complete, " +
        "standalone task description; it cannot see this conversation. Returns the subagent's " +
        "final report, waiting up to 15 minutes; a subagent still working after that keeps " +
        "running and is reachable through subagent_list and subagent_status. " +
        SAFETY_NOTE,
      parameters: Type.Object({
        name: Type.String({ description: "Short display name, e.g. 'API auditor'" }),
        task: Type.String({ description: "Complete standalone task instructions" }),
      }),
      async execute(_id, params, signal) {
        const args = (params ?? {}) as { name?: string; task?: string };
        if (!piSessionId) return failure("Subagents are unavailable: the session id is unknown.");
        // Spawn-then-poll, never one long request: the spawn returns once the
        // child is prompting; the report comes from polling.
        const spawned = await callRuntime(
          ctx,
          "/api/agent/subagents",
          { method: "POST", body: { parentPiSessionId: piSessionId, name: args.name ?? "Subagent", task: args.task ?? "", wait: false } },
          signal,
          MANAGE_TIMEOUT_MS,
        );
        if (!spawned.ok) return failure(`Subagent failed: ${spawned.error}`, { name: args.name });
        const runId = typeof spawned.payload.runId === "string" ? spawned.payload.runId : "";
        const childSessionId = spawned.payload.piSessionId ?? null;
        if (!runId) return failure("Subagent failed: the runtime returned no run id.");

        const deadline = Date.now() + RUN_TIMEOUT_MS;
        let pollFailures = 0;
        while (Date.now() < deadline && !signal?.aborted) {
          await sleep(POLL_INTERVAL_MS, signal);
          if (signal?.aborted) break;
          const polled = await callRuntime(ctx, statusPath(runId), { method: "GET" }, signal, MANAGE_TIMEOUT_MS);
          if (!polled.ok) {
            pollFailures += 1;
            if (pollFailures >= MAX_POLL_FAILURES) {
              return failure(`Subagent ${runId} is unreachable: ${polled.error}. It may still be running — check subagent_status.`, {
                runId,
                name: args.name,
              });
            }
            continue;
          }
          pollFailures = 0;
          const run = (polled.payload.subagent ?? {}) as SubagentSummary;
          if (run.status === "running") continue;
          if (run.status === "done") {
            return textResult(run.report || "(the subagent produced no final text)", {
              runId,
              name: args.name,
              piSessionId: run.piSessionId ?? childSessionId,
            });
          }
          const partial = run.report ? `\n\nPartial work:\n${run.report}` : "";
          if (run.status === "cancelled") {
            return textResult(`Subagent "${args.name ?? runId}" was stopped before it reported.${partial}`, { runId, status: "cancelled" });
          }
          return failure(`Subagent failed: ${run.error ?? "unknown error"}${partial}`, { runId, name: args.name });
        }
        const why = signal?.aborted ? "The turn was stopped" : "The 15-minute wait elapsed";
        return textResult(
          `${why} while subagent ${runId} was still working. It keeps running — check on it with subagent_status ${runId}, or stop it with subagent_stop.`,
          { runId, name: args.name, piSessionId: childSessionId, status: "running" },
        );
      },
    },
    {
      name: "subagent_list",
      label: "List subagents",
      description:
        "List every subagent this session has spawned — running and finished — with its run id, " +
        "name, state, and when it started or finished. Call this before subagent_status or " +
        "subagent_stop: both take the run id printed here. Only this session's own children are " +
        "listed. " +
        SAFETY_NOTE,
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        if (!piSessionId) return failure("Subagents are unavailable: the session id is unknown.");
        const called = await callRuntime(
          ctx,
          `/api/agent/subagents?piSessionId=${encodeURIComponent(piSessionId)}`,
          { method: "GET" },
          signal,
          MANAGE_TIMEOUT_MS,
        );
        if (!called.ok) return failure(`Could not list subagents: ${called.error}`);
        const runs = Array.isArray(called.payload.subagents) ? (called.payload.subagents as SubagentSummary[]) : [];
        if (runs.length === 0) return textResult("This session has not spawned any subagents.", { count: 0 });
        const running = runs.filter((run) => run.status === "running").length;
        return textResult(`${runs.length} subagent(s), ${running} running:\n${runs.map(formatRun).join("\n")}`, { count: runs.length, running });
      },
    },
    {
      name: "subagent_status",
      label: "Subagent status",
      description:
        "Inspect one subagent this session spawned: its state and the report it has written so " +
        "far. Works while the subagent is still running, so use it to check on a long task " +
        "instead of waiting on it. Takes a run id from subagent_list.",
      parameters: runIdParam,
      async execute(_id, params, signal) {
        if (!piSessionId) return failure("Subagents are unavailable: the session id is unknown.");
        const runId = readRunId(params);
        if (!runId) return failure("subagent_status needs a runId (see subagent_list).");
        const called = await callRuntime(ctx, statusPath(runId), { method: "GET" }, signal, MANAGE_TIMEOUT_MS);
        if (!called.ok) return failure(`Could not read subagent ${runId}: ${called.error}`);
        const run = (called.payload.subagent ?? {}) as SubagentSummary;
        const report = run.report ? `\n\nReport so far:\n${run.report}` : "\n\nIt has not written a report yet.";
        return textResult(`${formatRun(run)}${report}`, { runId, status: run.status ?? null, piSessionId: run.piSessionId ?? null });
      },
    },
    {
      name: "subagent_stop",
      label: "Stop subagent",
      description:
        "Stop one running subagent this session spawned and free the slot it holds against the " +
        "4-subagent limit. Returns whatever partial work it had written. Use it on a subagent " +
        "that is no longer needed or has run too long; a subagent that already finished is left " +
        "as it is. Takes a run id from subagent_list.",
      parameters: runIdParam,
      async execute(_id, params, signal) {
        if (!piSessionId) return failure("Subagents are unavailable: the session id is unknown.");
        const runId = readRunId(params);
        if (!runId) return failure("subagent_stop needs a runId (see subagent_list).");
        const called = await callRuntime(
          ctx,
          `/api/agent/subagents/${encodeURIComponent(runId)}/stop`,
          { method: "POST", body: { piSessionId } },
          signal,
          MANAGE_TIMEOUT_MS,
        );
        if (!called.ok) return failure(`Could not stop subagent ${runId}: ${called.error}`);
        const run = (called.payload.subagent ?? {}) as SubagentSummary;
        const report = run.report ? `\n\nWhat it had written:\n${run.report}` : "";
        return textResult(`${formatRun(run)}${report}`, { runId, status: run.status ?? null });
      },
    },
  ];
}
