// What ACE evaluates and reflects on: one observation per tool call, and the
// phase report for the run — read off the transcript, never inferred from
// output text.

import type { AgentMessage } from "@local-studio/harness";
import type { AcePhaseReport } from "@metactivity/ace";

const VALIDATION_COMMAND = /\b(test|tsc|lint|eslint|biome|check|build|vitest|jest|pytest|cargo (test|check|build)|go (test|vet|build))\b/;
const EXIT_CODE = /exited with code (\d+)/;
/** Local bash and the IDE terminal (M7) both read as shell runs. */
const SHELL_TOOLS = new Set(["bash", "ide_run_terminal"]);
const EDIT_TOOLS = new Set(["write", "edit", "ide_apply_edit", "ide_create_file"]);

export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: string }).text ?? "") : ""))
    .join("\n");
}

export function observationOf(toolName: string, args: unknown, text: string, isError: boolean): Record<string, unknown> {
  const params = (args ?? {}) as Record<string, unknown>;
  if (SHELL_TOOLS.has(toolName)) {
    const code = EXIT_CODE.exec(text)?.[1];
    return { kind: "shell", command: String(params.command ?? ""), exit_code: isError ? Number(code ?? 1) : 0 };
  }
  if (EDIT_TOOLS.has(toolName)) {
    return { kind: "edit", file: String(params.path ?? ""), failed: isError };
  }
  return { kind: isError ? "tool_failed" : "tool_completed", tool: toolName };
}

export function phaseReport(messages: readonly AgentMessage[], runError: string | undefined): AcePhaseReport {
  const changed = new Set<string>();
  const errors: string[] = runError ? [runError] : [];
  const validations: { command: string; verdict: string }[] = [];
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") calls.set(block.id, { name: block.name, args: (block.arguments ?? {}) as Record<string, unknown> });
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      if (EDIT_TOOLS.has(call.name) && !message.isError) changed.add(String(call.args.path ?? ""));
      if (SHELL_TOOLS.has(call.name)) {
        const command = String(call.args.command ?? "");
        if (VALIDATION_COMMAND.test(command)) validations.push({ command, verdict: message.isError ? "fail" : "pass" });
      }
      if (message.isError) errors.push(`${call.name}: ${textOf(message.content).split("\n")[0]?.slice(0, 200) ?? "error"}`);
    }
  }
  return { intent: "turn", provider: "pi", changed_files: [...changed].filter(Boolean), errors, validations };
}

