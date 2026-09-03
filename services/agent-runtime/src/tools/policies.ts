// The two pi policy extensions as harness policies (MET-915 W4):
//   local-studio-agent-policy → a system-prompt contribution (same text);
//   local-studio-timeouts     → the default / maximum `timeout` of the bash tool.
// Nothing here touches ACE's gate; policy = prompt + timeout only.

import type { HarnessTool, ToolContext } from "./context";

export const ARTIFACT_POLICY = `
Local Studio artifact policy:
When you use a write, edit, file, or artifact tool to create or update content,
that tool call is the artifact output. Do not repeat the same file body, HTML,
source code, patch, or edit payload in assistant text after the tool result.
After a successful write, edit, file, or artifact tool, answer with a concise
confirmation and the changed path(s) or a short summary. If the user asks for
"output only code", "output only HTML", or "output only one file", satisfy that
by writing the file and keep the final assistant message concise instead of
pasting the payload again.
Only paste a full file or patch in chat when you did not use a write, edit,
file, or artifact tool for that same content, or when the user explicitly asks
to print or show it after it has already been written.
`.trim();

/** The system prompt with the artifact policy appended once. */
export function withAgentPolicy(systemPrompt: string): string {
  if (systemPrompt.includes("Local Studio artifact policy:")) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${ARTIFACT_POLICY}`;
}

const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
const MAX_BASH_TIMEOUT_SECONDS = 900;

function readSeconds(env: ToolContext["env"], name: string, fallback: number): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/** A missing or invalid bash `timeout` becomes the default; a larger one is capped. */
export function bashTimeoutFor(env: ToolContext["env"], requested: unknown): number {
  const defaultTimeout = readSeconds(env, "LOCAL_STUDIO_BASH_TIMEOUT_SECONDS", DEFAULT_BASH_TIMEOUT_SECONDS);
  const maxTimeout = readSeconds(env, "LOCAL_STUDIO_BASH_MAX_TIMEOUT_SECONDS", MAX_BASH_TIMEOUT_SECONDS);
  const current = Number(requested);
  if (!Number.isFinite(current) || current <= 0) return defaultTimeout;
  return Math.min(Math.trunc(current), maxTimeout);
}

/** The core tools with the timeout policy applied to `bash`; every other tool passes through. */
export function withTimeoutPolicy(tools: HarnessTool[], env: ToolContext["env"]): HarnessTool[] {
  return tools.map((tool) =>
    tool.name !== "bash"
      ? tool
      : {
          ...tool,
          execute: (toolCallId, params, signal, onUpdate) => {
            const args = params as { timeout?: unknown };
            return tool.execute(toolCallId, { ...args, timeout: bashTimeoutFor(env, args.timeout) }, signal, onUpdate);
          },
        },
  );
}
