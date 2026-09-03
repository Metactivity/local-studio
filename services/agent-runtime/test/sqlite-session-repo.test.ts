import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionBackendConformance, type SessionBackendFixture } from "@local-studio/harness/session/testing";
import { SqliteSessionRepo, createSessionRepo } from "../src/ace/sqlite-session-repo";

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ace-sessions-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// The vendored backend contract, run unchanged against the SQLite implementation.
const conformance = createSessionBackendConformance(async () => {
  const repository = SqliteSessionRepo.open(tempDir());
  return { repository, [Symbol.asyncDispose]: async () => repository.close() } satisfies SessionBackendFixture;
});

describe("SqliteSessionRepo conformance", () => {
  for (const group of new Set(conformance.map((testCase) => testCase.group))) {
    describe(group, () => {
      for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
        it(testCase.name, () => testCase.run());
      }
    });
  }
});

describe("SqliteSessionRepo durability", () => {
  it("replays the log from disk after reopening and honours the jsonl fallback switch", async () => {
    const root = tempDir();
    const repo = SqliteSessionRepo.open(root);
    const session = await repo.create({ id: "s1", cwd: "/work" });
    await session.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 });
    await session.setName("first");
    repo.close();

    const reopened = SqliteSessionRepo.open(root);
    const [metadata] = await reopened.list();
    expect(metadata).toMatchObject({ id: "s1", cwd: "/work" });
    const loaded = await reopened.open(metadata!);
    expect(await loaded.getName()).toBe("first");
    expect((await loaded.findEntries()).map((entry) => entry.type)).toEqual(["message"]);
    expect(existsSync(join(root, "sessions.db"))).toBe(true);
    reopened.close();

    const jsonl = createSessionRepo(root, { ACE_SESSION_STORE: "jsonl" });
    const jsonlSession = await jsonl.create({ cwd: root });
    expect((await jsonlSession.getMetadata()).id).toBeString();
    expect(existsSync(join(root, "sessions"))).toBe(true);
  });
});
