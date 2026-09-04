// ADR-034 M7 on the runtime side: the validation-command classifier behind the
// `bash` → IDE terminal re-route, the gate class of `ide_run_terminal`, the
// terminal tool against the fake extension (streamed chunks, exit codes, the
// no-capture fallback), and a scripted turn whose phase report carries the
// IDE's diagnostics for the file it wrote.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rpcNotification } from "@metactivity/protocol";
import { classifyToolAccess, decideToolCall, type ProjectRules } from "../src/ace/ace-gate";
import { type BeforeRunEndEvent, createAceHarness, createDefaultTools } from "../src/ace/ace-harness";
import { resetAceService } from "../src/ace/ace-service";
import { SqliteSessionRepo } from "../src/ace/sqlite-session-repo";
import { QWEN38_RVN_PROFILE } from "../src/harness/model-profile";
import { createHarnessModel, createHarnessModels } from "../src/harness/spark-model";
import { resetHarnessSessions } from "../src/harness-sessions";
import { turnDiagnostics } from "../src/ide-bridge/diagnostics";
import { IdeBridgeServer, resetIdeBridge } from "../src/ide-bridge/server";
import { resetTerminalRuns, terminalCaptureAvailable, terminalRuns } from "../src/ide-bridge/terminals";
import type { HarnessTool, ToolResult } from "../src/tools/context";
import { ideTools } from "../src/tools/ide";
import { isValidationCommand, withTerminalRoute } from "../src/tools/terminal-route";
import { FakeExtension } from "./support/fake-extension";
import { startFakeLlamaServer } from "./support/fake-llama-server";

const NO_RULES: ProjectRules = { commandAllowlist: [], toolAllowlist: [], toolDenylist: [] };
let root: string;
let cwd: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ide-terminal-")));
  cwd = join(root, "project");
  Bun.spawnSync(["mkdir", "-p", cwd]);
  process.env.WORKSPACE_ROOTS = root;
  process.env.LOCAL_STUDIO_DATA_DIR = join(root, "data");
  process.env.ACE_STORE_ROOT = join(root, "ace-store");
  resetAceService();
  resetHarnessSessions();
});

afterAll(async () => {
  await resetIdeBridge();
  resetHarnessSessions();
  resetAceService();
  resetTerminalRuns();
  rmSync(root, { recursive: true, force: true });
});

describe("validation-command classifier", () => {
  test("test / build / run commands are re-routed, everything else stays local", () => {
    expect(isValidationCommand("bun test test/ide-write.test.ts")).toBe(true);
    expect(isValidationCommand("cd services/agent-runtime && npm run check")).toBe(true);
    expect(isValidationCommand("CI=1 pytest -q tests/")).toBe(true);
    expect(isValidationCommand("go test ./... 2>&1 | tail -20")).toBe(true);
    expect(isValidationCommand("make build && cargo test")).toBe(true);
    expect(isValidationCommand("ls -la src")).toBe(false);
    expect(isValidationCommand("cat package.json | grep test")).toBe(false);
    expect(isValidationCommand("git status && bun test")).toBe(false);
    expect(isValidationCommand("bun install")).toBe(false);
  });
});

describe("gate: ide_run_terminal", () => {
  test("the command decides the class; standard asks for a mutating one instead of blocking", () => {
    expect(classifyToolAccess("ide_run_terminal", { command: "bun test" })).toBe("exec-read");
    expect(classifyToolAccess("ide_run_terminal", { command: "rm -rf dist && bun run build" })).toBe("exec-write");
    expect(classifyToolAccess("ide_run_task", { name: "build" })).toBe("exec-read");
    expect(classifyToolAccess("ide_git_diff", {})).toBe("read");
    expect(decideToolCall({ profile: "standard", cwd, toolName: "ide_run_terminal", args: { command: "bun test" } }, NO_RULES)).toEqual({ allow: true, access: "exec-read" });
    expect(decideToolCall({ profile: "standard", cwd, toolName: "ide_run_terminal", args: { command: "rm -rf dist" } }, NO_RULES)).toMatchObject({ allow: false, ask: true, access: "exec-write" });
    expect(decideToolCall({ profile: "standard", cwd, toolName: "bash", args: { command: "rm -rf dist" } }, NO_RULES)).toMatchObject({ allow: false, ask: true, access: "exec-write" });
    expect(decideToolCall({ profile: "safe", cwd, toolName: "ide_run_terminal", args: { command: "bun test" } }, NO_RULES)).toMatchObject({ allow: false, source: "profile" });
    expect(decideToolCall({ profile: "standard", cwd, toolName: "ide_run_terminal", args: { command: "git commit --no-verify -m x" } }, NO_RULES)).toMatchObject({ source: "block-no-verify" });
  });
});

describe("terminal tool against the fake extension", () => {
  test("streams the chunks, keeps the tail in the registry, reads like bash on exit codes, remembers a terminal without capture", async () => {
    resetTerminalRuns();
    const bridge = new IdeBridgeServer({ socketPath: join(root, "term.sock"), log: () => undefined });
    await bridge.listen();
    const ide = new FakeExtension();
    let script: { exitCode: number | null; captured: boolean } = { exitCode: 0, captured: true };
    const seen: unknown[] = [];
    ide.handlers["ide.runTerminal"] = (params) => {
      seen.push(params);
      if (script.captured) {
        ide.send(rpcNotification("ide.terminal.output", { termId: "t1", chunk: "$ bun test\n" }));
        ide.send(rpcNotification("ide.terminal.output", { termId: "t1", chunk: "1 pass\n" }));
      }
      return { termId: "t1", exitCode: script.exitCode, output: script.captured ? "$ bun test\n1 pass\n" : null, captured: script.captured };
    };
    try {
      await ide.connect(bridge.socketPath);
      await ide.hello(cwd);
      const terminal = ideTools(cwd, bridge, { sessionId: "s7", env: {} }).find((tool) => tool.name === "ide_run_terminal")!;
      const updates: string[] = [];
      const result = (await terminal.execute("t", { command: "bun test", name: "tests" }, undefined, (partial: ToolResult) => updates.push(partial.content[0]?.text ?? ""))) as ToolResult;
      expect(result.content[0]?.text).toBe('$ bun test\n1 pass\n\n[ran in the IDE terminal "[tuum] tests"]');
      expect(result.details).toMatchObject({ termId: "t1", exitCode: 0, captured: true, name: "tests" });
      expect(updates).toEqual(["$ bun test\n", "$ bun test\n1 pass\n"]);
      expect(seen[0]).toMatchObject({ cmd: "bun test", cwd, name: "tests", captureOutput: true, timeoutMs: 120_000 });
      expect(terminalRuns(cwd, "s7")).toMatchObject([{ termId: "t1", name: "tests", command: "bun test", exitCode: 0, captured: true, tail: "$ bun test\n1 pass\n" }]);
      expect(terminalRuns(cwd, "other")).toEqual([]);

      script = { exitCode: 1, captured: true };
      await expect(terminal.execute("t", { command: "bun test" })).rejects.toThrow(/1 pass\n\nCommand exited with code 1$/);
      script = { exitCode: null, captured: true };
      await expect(terminal.execute("t", { command: "bun test", timeout: 5 })).rejects.toThrow(/timed out after 5 seconds/);

      script = { exitCode: null, captured: false };
      expect(terminalCaptureAvailable(cwd)).toBe(true);
      const uncaptured = (await terminal.execute("t", { command: "bun test" })) as ToolResult;
      expect(uncaptured.content[0]?.text).toContain("no shell integration");
      expect(terminalCaptureAvailable(cwd)).toBe(false);
    } finally {
      ide.close();
      await bridge.close();
      resetTerminalRuns();
    }
  });

  test("bash is re-routed only while an IDE with capture is connected and the command is a validation run", async () => {
    resetTerminalRuns();
    const bridge = new IdeBridgeServer({ socketPath: join(root, "route.sock"), log: () => undefined });
    await bridge.listen();
    const local: string[] = [];
    const bash: HarnessTool = {
      name: "bash",
      label: "bash",
      description: "",
      parameters: {} as never,
      async execute(_id, params) {
        local.push((params as { command: string }).command);
        return { content: [{ type: "text", text: "local" }], details: {} };
      },
    };
    const [routed] = withTerminalRoute([bash], { cwd, sessionId: "s", env: {}, bridge });
    const text = async (command: string) => ((await routed!.execute("t", { command })) as ToolResult).content[0]?.text;
    expect(await text("bun test")).toBe("local");
    const ide = new FakeExtension();
    ide.handlers["ide.runTerminal"] = () => ({ termId: "t2", exitCode: 0, output: "ok\n", captured: true });
    try {
      await ide.connect(bridge.socketPath);
      await ide.hello(cwd);
      expect(await text("bun test")).toContain('ok\n\n[ran in the IDE terminal "[tuum] tests"]');
      expect(await text("ls")).toBe("local");
      ide.handlers["ide.runTerminal"] = () => ({ termId: "t2", exitCode: null, output: null, captured: false });
      expect(await text("bun test")).toContain("no shell integration");
      expect(await text("bun test")).toBe("local");
      expect(local).toEqual(["bun test", "ls", "bun test"]);
    } finally {
      ide.close();
      await bridge.close();
      resetTerminalRuns();
    }
  });
});

describe("diagnostics into the phase report", () => {
  test("a write then a re-routed test run: the phase carries the validation verdict and the IDE's error count for the file", async () => {
    resetTerminalRuns();
    const bridge = new IdeBridgeServer({ socketPath: join(root, "phase.sock"), log: () => undefined });
    await bridge.listen();
    const ide = new FakeExtension();
    const uri = pathToFileURL(join(cwd, "a.txt")).toString();
    const pulled: unknown[] = [];
    ide.handlers["ide.getDiagnostics"] = (params) => {
      pulled.push(params);
      return { diagnostics: [{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: "error", message: "nope" }] };
    };
    ide.handlers["ide.runTerminal"] = () => ({ termId: "t3", exitCode: 0, output: "1 pass\n", captured: true });
    const server = startFakeLlamaServer([
      { toolCall: { name: "write", args: { path: "a.txt", content: "hello\n" } } },
      { toolCall: { name: "bash", args: { command: "bun test" } } },
      { text: "Tests pass." },
    ]);
    const model = createHarnessModel({ id: "fake-qwen3.8", baseUrl: server.url, profile: QWEN38_RVN_PROFILE });
    const repo = SqliteSessionRepo.open(join(root, "phase-store"));
    const diagnostics = turnDiagnostics(cwd, bridge);
    let phase: BeforeRunEndEvent["phase"] | undefined;
    try {
      await ide.connect(bridge.socketPath);
      await ide.hello(cwd);
      const harness = await createAceHarness({
        cwd,
        sessionRepo: repo,
        model,
        models: createHarnessModels(model, "fake-key"),
        profile: QWEN38_RVN_PROFILE,
        ace: null,
        tools: withTerminalRoute(createDefaultTools(cwd, null), { cwd, sessionId: "s", env: {}, bridge }),
        phaseExtras: diagnostics.phaseExtras,
      });
      harness.hooks.on("after_tool", (raw) => diagnostics.afterTool(raw as never));
      harness.hooks.on("before_run_end", (raw) => {
        phase = (raw as BeforeRunEndEvent).phase;
      });
      const result = await harness.prompt("run the tests");
      expect(result.text).toBe("Tests pass.");
      expect(phase).toMatchObject({
        changed_files: ["a.txt"],
        validations: [{ command: "bun test", verdict: "pass" }],
        diagnostics: [{ file: "a.txt", errors: 1, warnings: 0 }],
      });
      // Pulled after the write and again after the run.
      expect(pulled).toEqual([{ uri }, { uri }]);
      expect(terminalRuns(cwd, "s")).toMatchObject([{ command: "bun test", exitCode: 0, tail: "1 pass\n" }]);
      await harness.close();
    } finally {
      server.stop();
      ide.close();
      await bridge.close();
      resetTerminalRuns();
    }
  }, 30_000);
});
