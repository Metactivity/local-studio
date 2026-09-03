// The harness driver behind the runtime manager, against the scripted
// llama-server: the logged event sequence a scripted turn produces (the wire
// the frontend renders), the steer queue, and an abort mid-stream.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAceService } from "../src/ace/ace-service";
import { writeGoal } from "../src/goals-store";
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

  test("built-in tools, skills and the artifact policy reach the wire; tools run in process", async () => {
    const skillDir = join(root, "skills", "demo-skill");
    Bun.spawnSync(["mkdir", "-p", skillDir]);
    await Bun.write(join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: Demo skill for the harness test.\n---\nUse it wisely.\n");
    const server = startFakeLlamaServer([
      { toolCall: { name: "list_automations", args: {} } },
      { toolCall: { name: "subagent_list", args: {} } },
      { text: "Nothing scheduled, no children." },
    ]);
    const session = driver(server);
    try {
      await session.ensureStarted("fake-qwen3.8", cwd, null, { thinkingLevel: "low", skills: [{ name: "demo-skill", path: skillDir }] });
      await session.prompt("What is scheduled?", () => undefined);

      const request = server.seen.find((seen) => seen.path === "/v1/chat/completions")!.body!;
      const system = (request.messages as Array<{ role: string; content: string }>)[0]!;
      expect(system.role).toBe("system");
      expect(system.content).toContain("Local Studio artifact policy:");
      expect(system.content).toContain("<available_skills>");
      expect(system.content).toContain("<name>demo-skill</name>");
      const advertised = (request.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
      expect(advertised).toEqual(expect.arrayContaining(["bash", "list_automations", "subagent", "delete_automation"]));
      expect(advertised.some((name) => name.startsWith("browser_"))).toBe(false);

      const results = session
        .getEventsAfter(0)
        .map((logged) => logged.event as { type: string; toolName?: string; result?: { content: Array<{ text?: string }> }; isError?: boolean })
        .filter((event) => event.type === "tool_execution_end");
      expect(results.map((event) => [event.toolName, event.isError, event.result?.content[0]?.text])).toEqual([
        ["list_automations", false, "No automations are scheduled. Use schedule_automation to create one."],
        ["subagent_list", false, "This session has not spawned any subagents."],
      ]);
    } finally {
      await session.stop();
      server.stop();
    }
  }, 30_000);

  test("a /template message expands like pi did and the session goal reaches the system prompt", async () => {
    const templateDir = join(root, "prompts");
    Bun.spawnSync(["mkdir", "-p", templateDir]);
    const templatePath = join(templateDir, "greet.md");
    await Bun.write(templatePath, "---\ndescription: Greet people.\n---\nSay hello to $1, then to $2. All: $@\n");
    const server = startFakeLlamaServer([{ text: "Hello Alice, hello Bob." }, { text: "Still here." }]);
    const session = driver(server);
    try {
      await session.ensureStarted("fake-qwen3.8", cwd, null, {
        thinkingLevel: "low",
        promptTemplates: [{ id: "local-studio:greet", name: "greet", path: templatePath }],
      });
      await writeGoal(session.status.piSessionId!, { objective: "Greet everyone in the room", status: "active" });
      await session.prompt('/greet Alice "Bob Jr"', () => undefined);
      await session.prompt("/missing template stays as typed", () => undefined);

      const chats = server.seen.filter((seen) => seen.path === "/v1/chat/completions").map((seen) => seen.body!);
      const messages = (index: number) => chats[index]!.messages as Array<{ role: string; content: string | Array<{ text: string }> }>;
      const userText = (index: number) => (messages(index).at(-1)!.content as Array<{ text: string }>)[0]!.text;
      expect(messages(0)[0]!.content).toContain("<objective>Greet everyone in the room</objective>");
      expect(userText(0)).toBe("Say hello to Alice, then to Bob Jr. All: Alice Bob Jr");
      expect(userText(1)).toBe("/missing template stays as typed");
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
