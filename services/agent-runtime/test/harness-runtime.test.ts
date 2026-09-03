// The harness driver behind the runtime manager, against the scripted
// llama-server: the logged event sequence a scripted turn produces (the wire
// the frontend renders), the steer queue, and an abort mid-stream.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAceService } from "../src/ace/ace-service";
import { HarnessSession } from "../src/harness-runtime";
import { startFakeLlamaServer, type FakeLlamaServer, type ScriptedReply } from "./support/fake-llama-server";

let root: string;
let cwd: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harness-runtime-")));
  cwd = join(root, "project");
  Bun.spawnSync(["mkdir", "-p", cwd]);
  process.env.WORKSPACE_ROOTS = root;
  process.env.LOCAL_STUDIO_DATA_DIR = join(root, "data");
  process.env.ACE_STORE_ROOT = join(root, "ace-store");
  // No ACE endpoints: the harness runs without ACE, which is the degradation this driver must survive.
  delete process.env.ACE_CHAT_BASE_URL;
  delete process.env.ACE_EMBED_BASE_URL;
  resetAceService();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function driver(server: FakeLlamaServer): HarnessSession {
  return new HarnessSession({
    resolveEndpoint: async (modelId) => ({ servedId: modelId, baseUrl: server.url, apiKey: "fake-key" }),
  });
}

const types = (session: HarnessSession) => session.getEventsAfter(0).map((logged) => String(logged.event.type));

describe("HarnessSession", () => {
  test("a scripted turn logs the pi event sequence the frontend renders, then settles", async () => {
    const server = startFakeLlamaServer([
      { toolCall: { name: "bash", args: { command: "echo hi" } } },
      { text: "Said hi." },
    ]);
    const session = driver(server);
    try {
      await session.ensureStarted("fake-qwen3.8", cwd, null, { thinkingLevel: "high", toolAccess: "full" });
      expect(session.status).toMatchObject({ running: true, active: false, modelId: "fake-qwen3.8", cwd });
      const sessionId = session.status.piSessionId!;
      expect(sessionId).toBeTruthy();

      const seen: number[] = [];
      await session.prompt("Say hi.", (_event, seq) => seen.push(seq));

      const sequence = types(session);
      expect(sequence[0]).toBe("agent_start");
      expect(sequence.at(-2)).toBe("agent_end");
      expect(sequence.at(-1)).toBe("agent_settled");
      expect(sequence).toEqual(
        expect.arrayContaining(["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end"]),
      );
      expect(seen).toEqual(sequence.map((_, index) => index + 1));

      const assistant = session
        .getEventsAfter(0)
        .map((logged) => logged.event as { type: string; message?: { role: string; content: { type: string; text?: string }[] } })
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant");
      expect(assistant.at(-1)?.message?.content.some((block) => block.text === "Said hi.")).toBe(true);
      expect(session.status).toMatchObject({ active: false, lastError: null });
      expect(session.status.contextUsage).toMatchObject({ contextWindow: 262144, shouldCompact: false });

      // The wire: the profile's sampling and the mapped effort reached the server with the bearer.
      const chat = server.seen.filter((request) => request.path === "/v1/chat/completions");
      expect(chat).toHaveLength(2);
      expect(chat[0]!.auth).toBe("Bearer fake-key");
      expect(chat[0]!.body).toMatchObject({ model: "fake-qwen3.8", chat_template_kwargs: { reasoning_effort: "medium" } });

      // A second turn on the same session id resumes it instead of starting over.
      await session.ensureStarted("fake-qwen3.8", cwd, sessionId, { thinkingLevel: "high", toolAccess: "full" });
      expect(session.status.piSessionId).toBe(sessionId);
      expect(session.status.eventSeq).toBe(0);
    } finally {
      await session.stop();
      server.stop();
    }
  }, 30_000);

  test("steer and follow-up queue while a turn runs and are handed back on abort", async () => {
    const slow: ScriptedReply[] = [{ toolCall: { name: "bash", args: { command: "sleep 5" } } }, { text: "Never reached." }];
    const server = startFakeLlamaServer(slow);
    const session = driver(server);
    try {
      await session.ensureStarted("fake-qwen3.8", cwd, null, { thinkingLevel: "low", toolAccess: "full" });
      const turn = session.prompt("Take your time.", () => undefined).catch(() => undefined);
      await waitFor(() => types(session).includes("tool_execution_start"));
      expect(session.status.active).toBe(true);

      await session.steer("Actually, stop.");
      await session.followUp("Then summarise.");
      const queueUpdates = session
        .getEventsAfter(0)
        .map((logged) => logged.event as { type: string; steering?: string[]; followUp?: string[] })
        .filter((event) => event.type === "queue_update");
      expect(queueUpdates.at(-1)).toMatchObject({ steering: ["Actually, stop."], followUp: ["Then summarise."] });

      const started = Date.now();
      const cleared = await session.abort();
      await turn;
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(cleared).toEqual({ steering: ["Actually, stop."], followUp: ["Then summarise."] });
      expect(types(session).at(-1)).toBe("agent_settled");
      expect(session.status.active).toBe(false);
      expect(server.seen.filter((request) => request.path === "/v1/chat/completions")).toHaveLength(1);
    } finally {
      await session.stop();
      server.stop();
    }
  }, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
