// What every built-in harness tool is built from (MET-915, W4).
//
// These modules are the former bundled pi extensions ported onto the vendored
// Agent's tool contract. Tool names, descriptions and parameter schemas are
// byte-identical to the pi versions — the model prompts and skills/*/SKILL.md
// name them — only the plumbing changed:
//
//   * pi read per-session values off process.env (the runtime injected them
//     before each session); here they arrive on `ToolContext.env`.
//   * pi reached the runtime through the frontend proxy
//     (LOCAL_STUDIO_FRONTEND_BASE + /api/agent/...); the proxy forwards verbatim,
//     so here the same paths go straight to the runtime's own Hono app through
//     `ToolContext.request`. Same handlers, same JSON, no socket.

import type { AgentTool, AgentToolResult } from "@local-studio/harness";
import type { BuiltinToolGates } from "../pi-runtime-helpers";

export type HarnessTool = AgentTool<any, any>;

/** The pi extensions' result shape; the vendored Agent accepts it unchanged. */
export type ToolResult = AgentToolResult<Record<string, unknown>> & {
  content: Array<{ type: "text"; text: string }>;
};

/** Same predicates as the pi driver's extension gates (`buildAgentSessionOptionsSync().toolGates`). */
export type ToolGates = BuiltinToolGates;

export interface ToolContext {
  cwd: string;
  /** The session id the tools attribute their work to (what pi called the pi session id). */
  sessionId: string;
  /** The composer model id; connector grants and automation defaults are per model. */
  modelId: string;
  /** process.env plus the per-session injections (`runtimeEnvInjections`). */
  env: Record<string, string | undefined>;
  /** A request to the runtime's own HTTP surface, in process. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  gates: ToolGates;
}

export const textResult = (text: string, details: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  details,
});

export const failure = (text: string, details: Record<string, unknown> = {}): ToolResult =>
  textResult(text, { ...details, failed: true });

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  // JSON.stringify(undefined) is undefined, not a string — a tool that returned
  // an empty result would hand the Agent a content block with no text.
  return JSON.stringify(value ?? null, null, 2);
}

/** A signal that fires on the turn's abort or after `timeoutMs`, whichever comes first. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

export function readMs(env: ToolContext["env"], name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
