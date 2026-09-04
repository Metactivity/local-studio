// The IDE Bridge server against a fake `ace-agent` extension client (ADR-034
// M5): hello/ack, events folding into the per-folder context, an action round
// trip and its timeout, the bounded <ide-context> block, and the `ide_*` tools
// joining a turn only while an IDE is connected for the session folder.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpcNotification, rpcRequest } from "@metactivity/protocol";
import { resetAceService } from "../src/ace/ace-service";
import { resetHarnessSessions } from "../src/harness-sessions";
import { applyIdeEvent, emptyContext, IDE_CONTEXT_MAX_CHARS, ideContextBlock } from "../src/ide-bridge/context";
import { IdeBridgeServer, resetIdeBridge, ideBridge } from "../src/ide-bridge/server";
import { HarnessSession } from "../src/harness-runtime";
import { ideTools } from "../src/tools/ide";
import { FakeExtension, until } from "./support/fake-extension";
import { startFakeLlamaServer } from "./support/fake-llama-server";

let root: string;
let cwd: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ide-bridge-")));
  cwd = join(root, "project");
  Bun.spawnSync(["mkdir", "-p", cwd]);
  process.env.WORKSPACE_ROOTS = root;
  process.env.LOCAL_STUDIO_DATA_DIR = join(root, "data");
  process.env.ACE_STORE_ROOT = join(root, "ace-store");
  delete process.env.ACE_CHAT_BASE_URL;
  delete process.env.ACE_EMBED_BASE_URL;
  resetAceService();
  resetHarnessSessions();
});

afterAll(async () => {
  await resetIdeBridge();
  resetHarnessSessions();
  resetAceService();
  rmSync(root, { recursive: true, force: true });
});

describe("IDE bridge server", () => {
  test("hello is acked and checked; events fold into the folder context; actions round-trip or time out", async () => {
    const logs: string[] = [];
    const bridge = new IdeBridgeServer({ socketPath: join(root, "bridge.sock"), runtimeVersion: "test", log: (m) => logs.push(m) });
    await bridge.listen();
    const ide = new FakeExtension();
    try {
      await ide.connect(bridge.socketPath);
      // Before hello: no folder, so no ace/* request is served.
      ide.send(rpcRequest(9, "ace/getStatus", {}));
      expect(await ide.next((f) => "id" in f && f.id === 9)).toMatchObject({ error: { message: "ide.hello first" } });
      // A folder outside WORKSPACE_ROOTS is refused.
      ide.send(rpcRequest(8, "ide.hello", { sessionId: "s1", folder: "/", extensionVersion: "0.1.0", protocolVersion: 1 }));
      expect(await ide.next((f) => "id" in f && f.id === 8)).toMatchObject({ error: { code: -32602 } });

      expect(await ide.hello(cwd)).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, runtimeVersion: "test" } });
      expect(bridge.isConnected(cwd)).toBe(true);
      expect(logs.some((line) => line.includes(`hello from ${cwd}`))).toBe(true);

      ide.send(
        rpcNotification("ide.editor.active", {
          uri: `file://${cwd}/src/a.ts`,
          languageId: "typescript",
          selection: { start: { line: 3, character: 0 }, end: { line: 5, character: 4 } },
          cursor: { line: 5, character: 4 },
          visibleRanges: [],
        }),
      );
      ide.send(rpcNotification("ide.diagnostics.changed", { uri: `file://${cwd}/src/a.ts`, summary: { errors: 2, warnings: 1 } }));
      ide.send(rpcNotification("ide.scm.changed", { branch: "spark", ahead: 1, behind: 0, changes: [{ uri: `file://${cwd}/src/a.ts`, status: "modified" }] }));
      await until(() => bridge.context(cwd)?.scm !== null);
      const context = bridge.context(cwd)!;
      expect(context.activeEditor?.languageId).toBe("typescript");
      expect(context.diagnostics[`file://${cwd}/src/a.ts`]).toEqual({ errors: 2, warnings: 1 });
      expect(ideContextBlock(context, cwd)).toBe(
        ["<ide-context>", "- [active] src/a.ts (typescript, selection lines 4-6)", "- [diagnostics] 2 error(s), 1 warning(s) in 1 file(s): src/a.ts (2E/1W)", "- [git] branch spark +1/-0, 1 change(s): src/a.ts", "</ide-context>"].join("\n"),
      );

      // ACE is not configured in this process: the ace/* request is a clean error, not a hang.
      ide.send(rpcRequest(2, "ace/prepareTask", { task: "x", cwd }));
      expect(await ide.next((f) => "id" in f && f.id === 2)).toMatchObject({ error: { code: -32000 } });

      ide.handlers["ide.readFile"] = (params) => ({ text: `read ${(params as { uri: string }).uri}`, languageId: "typescript", dirty: true });
      await expect(bridge.action(cwd, "ide.readFile", { uri: "file:///x" })).resolves.toEqual({ text: "read file:///x", languageId: "typescript", dirty: true });
      await expect(bridge.action(cwd, "ide.symbols", { uri: "file:///x" }, 50)).rejects.toThrow(/timed out after 50 ms/);
      await expect(bridge.action(join(root, "other"), "ide.symbols", { uri: "file:///x" })).rejects.toThrow(/no IDE connected/);

      ide.close();
      await until(() => !bridge.isConnected(cwd));
      expect(bridge.context(cwd)).toBeNull();
    } finally {
      ide.close();
      await bridge.close();
    }
  });

  test("two tabs on one folder both stay connected; the most recently active one serves, the other takes over when it closes", async () => {
    const logs: string[] = [];
    const bridge = new IdeBridgeServer({ socketPath: join(root, "tabs.sock"), runtimeVersion: "test", log: (m) => logs.push(m) });
    await bridge.listen();
    const first = new FakeExtension();
    const second = new FakeExtension();
    const editor = (name: string) => rpcNotification("ide.editor.active", { uri: `file://${cwd}/${name}`, languageId: "typescript", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, cursor: { line: 0, character: 0 }, visibleRanges: [] });
    try {
      await first.connect(bridge.socketPath);
      await first.hello(cwd);
      await second.connect(bridge.socketPath);
      await second.hello(cwd);
      first.handlers["ide.readFile"] = () => ({ text: "first", languageId: "typescript", dirty: false });
      second.handlers["ide.readFile"] = () => ({ text: "second", languageId: "typescript", dirty: false });
      // The second hello did not evict the first tab; the second is the active one.
      expect(await bridge.action(cwd, "ide.readFile", { uri: "file:///x" })).toMatchObject({ text: "second" });
      expect(await bridge.action(cwd, "ide.readFile", { uri: "file:///x" })).toMatchObject({ text: "second" });
      expect(logs.filter((line) => line.includes("disconnected"))).toEqual([]);
      // An event on the first tab makes it active again, with its own context; a heartbeat does not.
      first.send(editor("a.ts"));
      await until(() => bridge.context(cwd)?.activeEditor?.uri === `file://${cwd}/a.ts`);
      expect(await bridge.action(cwd, "ide.readFile", { uri: "file:///x" })).toMatchObject({ text: "first" });
      second.send(rpcNotification("ide.heartbeat", { at: new Date().toISOString() }));
      first.send(rpcRequest(7, "ace/getStatus", {}));
      await first.next((f) => "id" in f && f.id === 7);
      expect(await bridge.action(cwd, "ide.readFile", { uri: "file:///x" })).toMatchObject({ text: "first" });
      // The active tab closes: the folder falls back to the remaining one, no "disconnected" yet.
      first.close();
      await until(() => bridge.context(cwd)?.activeEditor === null);
      expect(bridge.isConnected(cwd)).toBe(true);
      expect(await bridge.action(cwd, "ide.readFile", { uri: "file:///x" })).toMatchObject({ text: "second" });
      expect(logs.filter((line) => line.includes("disconnected"))).toEqual([]);
      second.close();
      await until(() => !bridge.isConnected(cwd));
      expect(logs.filter((line) => line.includes("disconnected"))).toEqual([`disconnected ${cwd}`]);
    } finally {
      first.close();
      second.close();
      await bridge.close();
    }
  });

  test("the context block never exceeds its budget", () => {
    let context = emptyContext({ sessionId: "s", extensionVersion: "0" });
    for (let index = 0; index < 400; index += 1) {
      context = applyIdeEvent(context, "ide.diagnostics.changed", { uri: `file:///w/${"long-directory-name/".repeat(4)}file-${index}.ts`, summary: { errors: index, warnings: 0 } });
    }
    context = applyIdeEvent(context, "ide.editor.tabs", { uris: Array.from({ length: 50 }, (_, i) => `file:///w/tab-${i}.ts`) });
    context = applyIdeEvent(context, "ide.scm.changed", { branch: "b", ahead: 0, behind: 0, changes: Array.from({ length: 300 }, (_, i) => ({ uri: `file:///w/${"deep/".repeat(10)}c-${i}.ts`, status: "modified" })) });
    const block = ideContextBlock(context, "/w")!;
    expect(block.length).toBeLessThanOrEqual(IDE_CONTEXT_MAX_CHARS);
    expect(block.startsWith("<ide-context>\n")).toBe(true);
    expect(block.endsWith("\n</ide-context>")).toBe(true);
    expect(ideContextBlock(context, "/w", 80)!.length).toBeLessThanOrEqual(80);
    expect(ideContextBlock(emptyContext({ sessionId: "s", extensionVersion: "0" }), "/w")).toBeNull();
    // Malformed events leave the context untouched; a resolved diagnostic drops out.
    expect(applyIdeEvent(context, "ide.editor.active", { nope: true })).toBe(context);
    expect(applyIdeEvent(context, "ide.diagnostics.changed", { uri: "file:///w/tab-1.ts", summary: { errors: 0, warnings: 0 } }).diagnostics["file:///w/tab-1.ts"]).toBeUndefined();
  });

  test("ide_* tools join a turn only while an IDE is connected for the folder", async () => {
    await resetIdeBridge();
    process.env.IDE_BRIDGE_SOCKET = join(root, "process.sock");
    await ideBridge().listen();
    const ide = new FakeExtension();
    const server = startFakeLlamaServer([
      { toolCall: { name: "ide_read_file", args: { path: "src/a.ts" } } },
      { text: "First." },
      { toolCall: { name: "ide_read_file", args: { path: "src/a.ts" } } },
      { text: "Second." },
    ]);
    const session = new HarnessSession({ resolveEndpoint: async (modelId) => ({ servedId: modelId, baseUrl: server.url, apiKey: "k" }) });
    const advertised = (index: number) =>
      ((server.seen.filter((seen) => seen.path === "/v1/chat/completions")[index]?.body?.tools as Array<{ function: { name: string } }>) ?? []).map((tool) => tool.function.name);
    const results = () =>
      session
        .getEventsAfter(0)
        .map((logged) => logged.event as { type: string; toolName?: string; isError?: boolean; result?: { content: Array<{ text?: string }> } })
        .filter((event) => event.type === "tool_execution_end")
        .map((event) => [event.toolName, event.isError, event.result?.content[0]?.text?.slice(0, 40)]);
    try {
      await session.ensureStarted("fake-qwen3.8", cwd, null, { thinkingLevel: "low", toolAccess: "full" });
      // No IDE: the tool is not advertised, the model's call fails as unknown, the turn still ends.
      await session.prompt("Read it.", () => undefined);
      expect(advertised(0)).not.toContain("ide_read_file");
      expect(results()[0]?.[1]).toBe(true);

      await ide.connect(ideBridge().socketPath);
      await ide.hello(cwd);
      ide.handlers["ide.readFile"] = (params) => ({ text: `dirty buffer of ${(params as { uri: string }).uri}`, languageId: "typescript", dirty: true });
      await session.prompt("Read it again.", () => undefined);
      expect(advertised(2)).toEqual(expect.arrayContaining(["ide_read_file", "ide_open_file", "ide_search", "ide_show_diff", "ide_diagnostics"]));
      const second = results()[1]!;
      expect(second[0]).toBe("ide_read_file");
      expect(second[1]).toBe(false);
      expect(second[2]).toContain("dirty buffer of file://");
      // The system prompt of the second turn carried the IDE context block.
      const system = (server.seen.filter((seen) => seen.path === "/v1/chat/completions")[2]!.body!.messages as Array<{ role: string; content: string }>)[0]!;
      expect(system.content).not.toContain("<ide-context>");
      ide.send(rpcNotification("ide.editor.active", { uri: `file://${cwd}/src/a.ts`, languageId: "typescript", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, cursor: { line: 0, character: 0 }, visibleRanges: [] }));
      await until(() => ideBridge().context(cwd)?.activeEditor !== null);
      const tool = ideTools(cwd).find((candidate) => candidate.name === "ide_diagnostics")!;
      ide.handlers["ide.getDiagnostics"] = () => ({ diagnostics: [] });
      expect(await tool.execute("t", {})).toMatchObject({ content: [{ type: "text", text: '{\n  "diagnostics": []\n}' }] });
    } finally {
      await session.stop();
      server.stop();
      ide.close();
      await resetIdeBridge();
      delete process.env.IDE_BRIDGE_SOCKET;
    }
  }, 30_000);
});
