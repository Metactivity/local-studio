import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarnessSessionStore, type HarnessSessionStore } from "../src/harness-sessions";
import { subagentReport, type SubagentRun } from "../src/subagents";

let root: string;
let store: HarnessSessionStore;
const cwd = "/work/project";

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "subagents-"));
  process.env.ACE_STORE_ROOT = root;
  store = createHarnessSessionStore(root);
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** A child transcript whose last assistant entry is the abort marker the
 *  harness writes when a run is stopped mid-flight. */
async function writeAbortedTranscript(piSessionId: string): Promise<void> {
  const session = await store.repo.create({ id: piSessionId, cwd });
  await session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "partial work" }],
    timestamp: Date.now(),
  } as never);
  await session.appendMessage({
    role: "assistant",
    content: [],
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  } as never);
}

function runWith(status: SubagentRun["status"], piSessionId: string, cwd: string): SubagentRun {
  return {
    id: "run-1",
    parentPiSessionId: "parent-1",
    name: "smoke",
    task: "test task",
    piSessionId,
    runtimeSessionId: "subagent:parent-1:run-1",
    cwd,
    status,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

describe("subagentReport", () => {
  test("a cancelled run does not adopt the transcript's abort marker as an error", async () => {
    const piSessionId = "01a02222-0000-7000-8000-000000000001";
    await writeAbortedTranscript(piSessionId);
    const report = subagentReport(runWith("cancelled", piSessionId, cwd));
    expect(report.error).toBeNull();
    expect(report.text).toBe("partial work");
  });

  test("a failed run still surfaces the transcript error", async () => {
    const piSessionId = "01a02222-0000-7000-8000-000000000002";
    await writeAbortedTranscript(piSessionId);
    const report = subagentReport(runWith("error", piSessionId, cwd));
    expect(report.error).toBe("Request was aborted");
    expect(report.text).toBe("partial work");
  });
});
