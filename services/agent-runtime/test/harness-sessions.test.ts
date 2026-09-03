// The SQLite-backed session store the http session handlers read under
// LOCAL_STUDIO_AGENT_CORE=harness: list summaries, the pi-shaped replay
// (header + entries), tail paging with cursors, and cwd isolation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@local-studio/harness";
import { createHarnessSessionStore, type HarnessSessionStore } from "../src/harness-sessions";

let root: string;
let store: HarnessSessionStore;
const cwd = "/work/project";

const text = (role: "user" | "assistant", body: string, extra: Record<string, unknown> = {}) =>
  ({ role, content: [{ type: "text", text: body }], timestamp: Date.now(), ...extra }) as never;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "harness-sessions-"));
  process.env.LOCAL_STUDIO_DATA_DIR = join(root, "data");
  store = createHarnessSessionStore(root);
  const session = await store.repo.create({ id: "s1", cwd });
  await session.appendEntry({ type: "model_change", id: uuidv7(), provider: "spark", modelId: "qwen3.8" }, "main");
  await session.appendMessage(text("user", "Fix the failing build"));
  await session.appendMessage(
    text("assistant", "On it.", { stopReason: "stop", usage: { input: 100, output: 20, totalTokens: 120 } }),
  );
  await session.appendMessage(text("user", "Now add a test"));
  await session.appendMessage(text("assistant", "Done.", { stopReason: "stop", usage: { input: 200, output: 30, totalTokens: 230 } }));
  const other = await store.repo.create({ id: "s2", cwd: "/work/elsewhere" });
  await other.appendMessage(text("user", "Unrelated"));
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("harness session store", () => {
  test("lists a cwd's sessions as pi-shaped summaries", async () => {
    const sessions = await store.listSessions(cwd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "s1",
      cwd,
      modelId: "qwen3.8",
      provider: "spark",
      firstUserMessage: "Fix the failing build",
      lastUserPromptText: "Now add a test",
      archived: false,
    });
    expect(Date.parse(sessions[0]!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(sessions[0]!.startedAt));
    expect(await store.listSessions(cwd, { ids: ["nope"] })).toEqual([]);
    expect(await store.listSessions("/work/elsewhere")).toHaveLength(1);
  });

  test("loads the header plus entries, pages a tail by user turn, and isolates cwds", async () => {
    const full = await store.loadSession(cwd, "s1");
    expect(full.events[0]).toMatchObject({ type: "session", id: "s1", cwd, modelId: "qwen3.8" });
    expect(full.events.slice(1).map((event) => event.type)).toEqual(["model_change", "message", "message", "message", "message"]);
    expect(full.cursor).toBeNull();

    const tail = await store.loadSession(cwd, "s1", { tail: 1 });
    const tailMessages = tail.events.filter((event) => event.type === "message");
    expect(tailMessages).toHaveLength(2);
    expect((tailMessages[0] as { message: { role: string } }).message.role).toBe("user");
    expect(tail.cursor).not.toBeNull();
    expect(tail.meta).toMatchObject({ title: "Fix the failing build", modelId: "qwen3.8", piSessionId: "s1" });
    expect(tail.meta?.usage).toMatchObject({ input: 300, output: 50, total: 350, calls: 2, compactions: 0 });

    const earlier = await store.loadSession(cwd, "s1", { before: tail.cursor! });
    expect(earlier.meta).toBeNull();
    expect(earlier.events.map((event) => event.type)).toEqual(["model_change", "message", "message"]);
    expect(earlier.cursor).toBeNull();

    expect(await store.loadSession("/work/elsewhere", "s1")).toEqual({ events: [], cursor: null, meta: null });
  });
});
