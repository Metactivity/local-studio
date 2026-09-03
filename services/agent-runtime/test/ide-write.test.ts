// ADR-034 M6 on the runtime side: the gate's write class and ask path for the
// `ide_*` write tools, the dirty-buffer routing rule of the harness env
// (dirty → ide.applyEdit / ide.readFile, else disk), turn checkpoints on a
// temp git repo through the HTTP surface, and a patch tool round trip.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rpcNotification } from "@metactivity/protocol";
import { answerPermission, askPermission, decideToolCall, IDE_WRITE_TOOLS, pendingPermissions, type ProjectRules } from "../src/ace/ace-gate";
import { resetAceService } from "../src/ace/ace-service";
import { resetHarnessSessions } from "../src/harness-sessions";
import { HarnessSession } from "../src/harness-runtime";
import { createAgentRuntimeApp } from "../src/http/app";
import { createTurnCheckpoint } from "../src/ide-bridge/checkpoints";
import { IdeAwareExecutionEnv } from "../src/ide-bridge/env";
import { IdeBridgeServer, ideBridge, resetIdeBridge } from "../src/ide-bridge/server";
import { ideTools } from "../src/tools/ide";
import { FakeExtension, until } from "./support/fake-extension";
import { startFakeLlamaServer } from "./support/fake-llama-server";

const NO_RULES: ProjectRules = { commandAllowlist: [], toolAllowlist: [], toolDenylist: [] };
let root: string;
let cwd: string;
let app: ReturnType<typeof createAgentRuntimeApp>["app"];

const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
const request = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { host: "127.0.0.1", "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ide-write-")));
  cwd = join(root, "project");
  Bun.spawnSync(["mkdir", "-p", cwd]);
  process.env.WORKSPACE_ROOTS = root;
  process.env.LOCAL_STUDIO_DATA_DIR = join(root, "data");
  process.env.ACE_STORE_ROOT = join(root, "ace-store");
  delete process.env.ACE_CHAT_BASE_URL;
  delete process.env.ACE_EMBED_BASE_URL;
  resetAceService();
  resetHarnessSessions();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(cwd, "a.txt"), "disk\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  app = createAgentRuntimeApp().app;
});

afterAll(async () => {
  await resetIdeBridge();
  resetHarnessSessions();
  resetAceService();
  rmSync(root, { recursive: true, force: true });
});

describe("gate: IDE write tools", () => {
  test("safe blocks, standard asks, autonomous allows; the ask settles on the answer or the abort", async () => {
    for (const toolName of IDE_WRITE_TOOLS) {
      expect(decideToolCall({ profile: "safe", cwd, toolName, args: {} }, NO_RULES)).toMatchObject({ allow: false, access: "write", source: "profile" });
      expect(decideToolCall({ profile: "safe", cwd, toolName, args: {} }, NO_RULES)).not.toHaveProperty("ask");
      expect(decideToolCall({ profile: "standard", cwd, toolName, args: {} }, NO_RULES)).toMatchObject({ allow: false, ask: true, access: "write" });
      expect(decideToolCall({ profile: "autonomous", cwd, toolName, args: {} }, NO_RULES)).toEqual({ allow: true, access: "write" });
    }
    // The read ones and the plain edit tool keep their M5 classes.
    expect(decideToolCall({ profile: "safe", cwd, toolName: "ide_read_file", args: {} }, NO_RULES)).toEqual({ allow: true, access: "read" });
    expect(decideToolCall({ profile: "standard", cwd, toolName: "edit", args: {} }, NO_RULES)).toEqual({ allow: true, access: "write" });

    const ask = { cwd, sessionId: "s", toolName: "ide_apply_edit", args: { path: "a.txt" }, reason: "why", createdAt: "now" };
    const answered = askPermission({ ...ask, requestId: "r1" });
    expect(pendingPermissions(cwd).map((pending) => pending.requestId)).toEqual(["r1"]);
    expect(pendingPermissions("/elsewhere")).toEqual([]);
    expect(answerPermission("r1", "allow")).toBe(true);
    expect(answerPermission("r1", "allow")).toBe(false);
    await expect(answered).resolves.toBe("allow");
    const controller = new AbortController();
    const aborted = askPermission({ ...ask, requestId: "r2" }, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toBe("deny");
    await expect(askPermission({ ...ask, requestId: "r3" }, undefined, 5)).resolves.toBe("deny");
    expect(pendingPermissions()).toEqual([]);
  });
});

describe("dirty-buffer routing", () => {
  test("a file open and dirty in the IDE is read and written through the editor, everything else hits the disk", async () => {
    const bridge = new IdeBridgeServer({ socketPath: join(root, "env.sock"), log: () => undefined });
    await bridge.listen();
    const ide = new FakeExtension();
    const uri = pathToFileURL(join(cwd, "a.txt")).toString();
    const edits: unknown[] = [];
    ide.handlers["ide.readFile"] = () => ({ text: "buffer\n", languageId: "plaintext", dirty: true });
    ide.handlers["ide.applyEdit"] = (params) => {
      edits.push(params);
      return { applied: 1, failed: [] };
    };
    try {
      await ide.connect(bridge.socketPath);
      await ide.hello(cwd);
      const env = new IdeAwareExecutionEnv({ cwd }, bridge);
      expect(await env.readTextFile("a.txt")).toEqual({ ok: true, value: "disk\n" });

      ide.send(rpcNotification("ide.document.dirty", { uri, dirty: true }));
      await until(() => bridge.context(cwd)?.dirty.length === 1);
      expect(await env.readTextFile("a.txt")).toEqual({ ok: true, value: "buffer\n" });
      expect(await env.writeFile("a.txt", "agent\n")).toEqual({ ok: true, value: undefined });
      expect(edits).toEqual([{ edits: [{ uri, text: "agent\n" }] }]);
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("disk\n");
      // Another file is not dirty: disk as before.
      expect(await env.writeFile("b.txt", "b\n")).toEqual({ ok: true, value: undefined });
      expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("b\n");

      ide.send(rpcNotification("ide.document.saved", { uri }));
      await until(() => bridge.context(cwd)?.dirty.length === 0);
      expect(await env.writeFile("a.txt", "after save\n")).toEqual({ ok: true, value: undefined });
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("after save\n");

      // An IDE failure is a FileError, never a throw.
      ide.send(rpcNotification("ide.document.dirty", { uri, dirty: true }));
      await until(() => bridge.context(cwd)?.dirty.length === 1);
      ide.handlers["ide.applyEdit"] = () => ({ applied: 0, failed: [{ uri, reason: "editor refused" }] });
      const failed = await env.writeFile("a.txt", "x");
      expect(failed.ok).toBe(false);
      expect(String(!failed.ok && failed.error.message)).toContain("editor refused");
    } finally {
      ide.close();
      await bridge.close();
      rmSync(join(cwd, "b.txt"), { force: true });
      writeFileSync(join(cwd, "a.txt"), "disk\n");
    }
  });
});

describe("checkpoints", () => {
  test("create → list changed → diff content → revert, over /api/agent/checkpoints; not a repo → null", async () => {
    expect(createTurnCheckpoint(root, "s", "x")).toBeNull();
    const q = `cwd=${encodeURIComponent(cwd)}&sessionId=s1`;
    expect(await (await request(`/api/agent/checkpoints?${q}`)).json()).toEqual({ sessionId: "s1", repo: true, checkpoints: [], changed: [] });

    const first = createTurnCheckpoint(cwd, "s1", "turn 1")!;
    expect(first.ref).toBe("refs/ace-ide/checkpoints/s1/1");
    writeFileSync(join(cwd, "a.txt"), "changed\n");
    writeFileSync(join(cwd, "new.txt"), "new\n");
    const listed = (await (await request(`/api/agent/checkpoints?${q}`)).json()) as { checkpoints: { n: number }[]; changed: string[] };
    expect(listed.checkpoints.map((entry) => entry.n)).toEqual([1]);
    expect(listed.changed.sort()).toEqual(["a.txt", "new.txt"]);
    expect(createTurnCheckpoint(cwd, "s1", "turn 2")?.ref).toBe("refs/ace-ide/checkpoints/s1/2");
    expect(git(["for-each-ref", "--format=%(refname)", "refs/ace-ide/checkpoints/s1"]).split("\n")).toHaveLength(2);

    // Show: no IDE connected for the folder → 502, the path guard fires before the bridge.
    expect((await post("/api/agent/checkpoints/show", { cwd, sessionId: "s1", n: 1, path: "../etc/passwd", mode: "diff" })).status).toBe(403);
    expect((await post("/api/agent/checkpoints/show", { cwd, sessionId: "s1", n: 1, path: "a.txt", mode: "diff" })).status).toBe(502);

    expect((await post("/api/agent/checkpoints/revert", { cwd, sessionId: "s1", n: 9 })).status).toBe(500);
    expect(await (await post("/api/agent/checkpoints/revert", { cwd, sessionId: "s1", n: 1 })).json()).toMatchObject({ ok: true, checkpoint: { n: 1 } });
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("disk\n");
    expect(existsSync(join(cwd, "new.txt"))).toBe(false);
    expect(git(["status", "--porcelain"])).toBe("");
    for (const n of [1, 2]) git(["update-ref", "-d", `refs/ace-ide/checkpoints/s1/${n}`]);
  });

  test("permission asks are listed per folder and answered over /api/agent/permissions", async () => {
    const asked = askPermission({ requestId: "p1", cwd, sessionId: "s", toolName: "ide_delete", args: {}, reason: "r", createdAt: "t" });
    const listed = (await (await request(`/api/agent/permissions?cwd=${encodeURIComponent(cwd)}`)).json()) as { pending: { requestId: string }[] };
    expect(listed.pending.map((pending) => pending.requestId)).toEqual(["p1"]);
    expect((await post("/api/agent/permissions/p1", { decision: "maybe" })).status).toBe(400);
    expect(await (await post("/api/agent/permissions/p1", { decision: "deny" })).json()).toEqual({ ok: true });
    expect((await post("/api/agent/permissions/p1", { decision: "deny" })).status).toBe(404);
    await expect(asked).resolves.toBe("deny");
  });
});

describe("write tools against the fake extension", () => {
  test("patch round trip; a path outside the workspace never reaches the IDE", async () => {
    const bridge = new IdeBridgeServer({ socketPath: join(root, "tools.sock"), log: () => undefined });
    await bridge.listen();
    const ide = new FakeExtension();
    const seen: unknown[] = [];
    ide.handlers["ide.applyPatch"] = (params) => {
      seen.push(params);
      return { applied: 1, failed: [] };
    };
    try {
      await ide.connect(bridge.socketPath);
      await ide.hello(cwd);
      const tools = ideTools(cwd, bridge);
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([...IDE_WRITE_TOOLS]));
      const patch = tools.find((tool) => tool.name === "ide_apply_patch")!;
      const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-disk\n+patched\n";
      expect(await patch.execute("t", { unifiedDiff: diff })).toMatchObject({ content: [{ type: "text", text: '{\n  "applied": 1,\n  "failed": []\n}' }] });
      expect(seen).toEqual([{ unifiedDiff: diff }]);
      const create = tools.find((tool) => tool.name === "ide_create_file")!;
      const outside = (await create.execute("t", { path: "../outside.txt" })) as { details?: { failed?: boolean }; content: { text?: string }[] };
      expect(outside.details?.failed).toBe(true);
      expect(outside.content[0]?.text).toContain("outside the workspace");
      const run = tools.find((tool) => tool.name === "ide_run_command")!;
      expect(run.description).toContain("workbench.action.files.saveAll");
    } finally {
      ide.close();
      await bridge.close();
    }
  });

  test("a turn's first write takes a checkpoint; the harness `write` goes through the IDE when the buffer is dirty", async () => {
    await resetIdeBridge();
    process.env.IDE_BRIDGE_SOCKET = join(root, "turn.sock");
    await ideBridge().listen();
    const ide = new FakeExtension();
    const uri = pathToFileURL(join(cwd, "a.txt")).toString();
    const applied: unknown[] = [];
    ide.handlers["ide.applyEdit"] = (params) => {
      applied.push(params);
      return { applied: 1, failed: [] };
    };
    const server = startFakeLlamaServer([
      { toolCall: { name: "write", args: { path: "a.txt", content: "from the agent\n" } } },
      { text: "Written." },
    ]);
    const session = new HarnessSession({ resolveEndpoint: async (modelId) => ({ servedId: modelId, baseUrl: server.url, apiKey: "k" }) });
    try {
      await ide.connect(ideBridge().socketPath);
      await ide.hello(cwd);
      ide.send(rpcNotification("ide.document.dirty", { uri, dirty: true }));
      await until(() => ideBridge().context(cwd)?.dirty.length === 1);
      await session.ensureStarted("fake-qwen3.8", cwd, null, { thinkingLevel: "low", toolAccess: "full" });
      await session.prompt("Write it.", () => undefined);
      const sessionId = session.status.piSessionId!;
      expect(applied).toEqual([{ edits: [{ uri, text: "from the agent\n" }] }]);
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("disk\n");
      const refs = git(["for-each-ref", "--format=%(refname)", `refs/ace-ide/checkpoints/${sessionId}`]);
      expect(refs).toBe(`refs/ace-ide/checkpoints/${sessionId}/1`);
      git(["update-ref", "-d", refs]);
    } finally {
      await session.stop();
      server.stop();
      ide.close();
      await resetIdeBridge();
      delete process.env.IDE_BRIDGE_SOCKET;
    }
  }, 30_000);
});
