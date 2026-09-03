// The M7 harness policy: while an IDE is connected, a `bash` call that looks
// like a test / build / run command goes to the IDE terminal instead
// (`ide.runTerminal`, visible to the user, same gate decision since the tool
// is still `bash` when the gate runs). Everything else stays local bash.

import type { IdeBridgeServer } from "../ide-bridge/server";
import { isBridgeUnavailable, runInIdeTerminal, terminalCaptureAvailable } from "../ide-bridge/terminals";
import { bashTimeoutFor } from "./policies";
import type { HarnessTool, ToolContext } from "./context";

// ponytail: a prefix list on the first real segment (after `cd …`, env
// assignments and `time`); grow it when a project's runner is missed.
const VALIDATION_RUNNER =
  /^(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:test|run|x|exec|check)\b|bunx\s|npx\s|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|go\s+(?:test|build|vet|run)\b|make\b|cargo\s+(?:test|build|run|check|clippy|bench)\b|tsc\b|vitest\b|jest\b|mvn\b|gradle\b|\.\/gradlew\b|dotnet\s+(?:test|build|run)\b)/;

/** `bun test`, `npm run …`, `pytest`, `go test`, `make …`, `cargo …` and kin — the commands whose output belongs in the real terminal. */
export function isValidationCommand(command: string): boolean {
  const segments = command
    .split(/&&|\|\||[;|]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !/^cd(\s|$)/.test(segment));
  const first = (segments[0] ?? "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").replace(/^time\s+/, "");
  return VALIDATION_RUNNER.test(first);
}

export interface TerminalRouteOptions {
  cwd: string;
  sessionId: string;
  env: ToolContext["env"];
  bridge: IdeBridgeServer;
}

/** `bash` re-routed to the IDE terminal for validation commands; falls back to local bash when the IDE is gone. */
export function withTerminalRoute(tools: HarnessTool[], options: TerminalRouteOptions): HarnessTool[] {
  return tools.map((tool) =>
    tool.name !== "bash"
      ? tool
      : {
          ...tool,
          execute: async (toolCallId, params, signal, onUpdate) => {
            const { command, timeout } = params as { command: string; timeout?: unknown };
            const local = () => tool.execute(toolCallId, params, signal, onUpdate);
            if (!options.bridge.isConnected(options.cwd) || !terminalCaptureAvailable(options.cwd) || !isValidationCommand(command)) return local();
            try {
              return await runInIdeTerminal(
                { cwd: options.cwd, sessionId: options.sessionId, command, name: "tests", timeoutMs: bashTimeoutFor(options.env, timeout) * 1000 },
                onUpdate,
                options.bridge,
              );
            } catch (error) {
              if (isBridgeUnavailable(error)) return local();
              throw error;
            }
          },
        },
  );
}
