// The /api/agent/ace/* surface against the real NativeService on a temp store:
// the status shape, a proposal accepted and one rejected end to end, and the
// Context Lens of a running harness session.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aceService, resetAceService } from "../src/ace/ace-service";
import { resetHarnessSessions } from "../src/harness-sessions";
import { createAgentRuntimeApp } from "../src/http/app";
import { piRuntimeManager } from "../src/runtime-manager";
import { type FakeLlamaServer, startFakeLlamaServer } from "./support/fake-llama-server";

let server: FakeLlamaServer;
let root: string;
let cwd: string;
let app: ReturnType<typeof createAgentRuntimeApp>["app"];

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { host: "127.0.0.1", "content-type": "application/json", ...(init.headers ?? {}) } });

beforeAll(() => {
  server = startFakeLlamaServer([{ text: "Hi." }]);
  root = realpathSync(mkdtempSync(join(tmpdir(), "ace-handlers-")));
  cwd = join(root, "project");
  Bun.spawnSync(["mkdir", "-p", cwd]);
  process.env.WORKSPACE_ROOTS = root;
  process.env.LOCAL_STUDIO_DATA_DIR = join(root, "data");
  process.env.ACE_STORE_ROOT = join(root, "ace-store");
  process.env.ACE_CHAT_BASE_URL = server.url;
  process.env.ACE_EMBED_BASE_URL = server.url;
  process.env.ACE_API_KEY = "fake-key";
  process.env.ACE_CHAT_MODEL = "fake-qwen3.8";
  resetAceService();
  resetHarnessSessions();
  app = createAgentRuntimeApp().app;
});

afterAll(() => {
  resetAceService();
  resetHarnessSessions();
  delete process.env.ACE_CHAT_BASE_URL;
  delete process.env.ACE_EMBED_BASE_URL;
  delete process.env.ACE_API_KEY;
  delete process.env.ACE_CHAT_MODEL;
  server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("/api/agent/ace", () => {
  test("status carries the report, the runtime snapshot and the control snapshot of the folder", async () => {
    const response = await request(`/api/agent/ace/status?cwd=${encodeURIComponent(cwd)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ configured: true, runtime: "external", chatModel: "fake-qwen3.8", problems: [] });
    expect(body.health).toMatchObject({ health: "ready" });
    expect(body.runtimeSnapshot).toMatchObject({ mode: "external", chatUrl: server.url, embedUrl: server.url });
    expect(body.control).toMatchObject({ graph: { indexed_files: expect.any(Number) }, memory: { pending_proposals: 0 } });
    expect(JSON.stringify(body)).not.toContain("fake-key");
  });

  test("rejects a folder outside WORKSPACE_ROOTS", async () => {
    const response = await request(`/api/agent/ace/proposals?cwd=${encodeURIComponent(tmpdir())}`);
    expect(response.status).toBe(403);
  });

  test("a pending proposal is accepted with edits, another rejected, and memory reflects it", async () => {
    // Two unresolved failures of the same command is the deterministic guardrail signature.
    const ace = aceService()!;
    for (const command of ["npm test", "npm test", "make lint", "make lint"]) {
      ace.observeAgentEvent({ kind: "shell", command, exit_code: 1 }, cwd);
    }
    expect(ace.reflectAndFile(cwd).new).toBe(2);

    const listed = (await (await request(`/api/agent/ace/proposals?cwd=${encodeURIComponent(cwd)}`)).json()) as {
      proposals: { id: number; status: string; content: string }[];
    };
    expect(listed.proposals.map((proposal) => proposal.status)).toEqual(["pending", "pending"]);
    const [first, second] = listed.proposals;

    const accepted = await request(`/api/agent/ace/proposals/${first!.id}`, {
      method: "POST",
      body: JSON.stringify({ cwd, action: "accept", content: "Run the suite once, read the failure, then fix." }),
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { bulletId: string | null }).bulletId).toBeTruthy();

    const rejected = await request(`/api/agent/ace/proposals/${second!.id}`, {
      method: "POST",
      body: JSON.stringify({ cwd, action: "reject" }),
    });
    expect(rejected.status).toBe(200);

    const pending = (await (await request(`/api/agent/ace/proposals?cwd=${encodeURIComponent(cwd)}`)).json()) as {
      proposals: unknown[];
    };
    expect(pending.proposals).toEqual([]);

    const memory = (await (await request(`/api/agent/ace/memory?cwd=${encodeURIComponent(cwd)}`)).json()) as {
      playbook: { project: string | null };
      bullets: { project: { content: string }[] };
    };
    expect(memory.bullets.project.map((bullet) => bullet.content)).toEqual(["Run the suite once, read the failure, then fix."]);
    expect(memory.playbook.project).toContain("Run the suite once");

    const invalid = await request(`/api/agent/ace/proposals/${first!.id}`, { method: "POST", body: JSON.stringify({ cwd, action: "maybe" }) });
    expect(invalid.status).toBe(400);
  });

  test("lens returns the journal of the running session and nothing for an unknown one", async () => {
    const session = piRuntimeManager.getSession("ace-lens-test");
    await session.ensureStarted("fake-qwen3.8", cwd, null, { thinkingLevel: "medium", toolAccess: "full" });
    await session.prompt("Say hi.", () => undefined);

    const response = await request(`/api/agent/ace/lens?sessionId=ace-lens-test&piSessionId=${session.status.piSessionId}`);
    const body = (await response.json()) as { sessionId: string; records: { type: string; turnId: string; payload: Record<string, unknown> }[] };
    expect(body.sessionId).toBe("ace-lens-test");
    const types = body.records.map((record) => record.type);
    expect(types).toEqual(expect.arrayContaining(["ace.router", "ace.lens", "ace.evaluation"]));
    const lens = body.records.find((record) => record.type === "ace.lens")!;
    expect(lens.payload).toMatchObject({ lens: { promptOriginal: "Say hi." }, injectedChars: expect.any(Number) });

    const unknown = (await (await request("/api/agent/ace/lens?sessionId=nobody")).json()) as { records: unknown[] };
    expect(unknown.records).toEqual([]);
    await session.stop();
  }, 30_000);
});
