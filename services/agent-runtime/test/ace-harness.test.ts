// One turn end to end against the scripted llama-server: ACE context in the
// system prompt, the gate blocking `--no-verify`, a bulky tool result
// compacted and retrievable verbatim through `ace_retrieve_context`, the
// reflection filed, the AEP stream reduced.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createAceHarness } from "../src/ace/ace-harness";
import { createAceService } from "../src/ace/ace-service";
import { SqliteSessionRepo } from "../src/ace/sqlite-session-repo";
import { QWEN38_RVN_PROFILE } from "../src/harness/model-profile";
import { createHarnessModel, createHarnessModels } from "../src/harness/spark-model";
import { type FakeLlamaServer, startFakeLlamaServer } from "./support/fake-llama-server";

let server: FakeLlamaServer;
let root: string;
let cwd: string;

beforeAll(() => {
  server = startFakeLlamaServer();
  root = mkdtempSync(join(tmpdir(), "ace-harness-"));
  cwd = join(root, "project");
  execSync(`mkdir -p "${cwd}" && cd "${cwd}" && git init -q`);
  writeFileSync(join(cwd, "index.ts"), "export function hello(): string {\n  return 'hi';\n}\n");
});

afterAll(() => {
  server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("ACE-rooted harness", () => {
  test("runs a turn with context, gate, compaction round-trip and reflection", async () => {
    const ace = createAceService({
      runtime: "external",
      chatBaseUrl: server.url,
      embedBaseUrl: server.url,
      apiKey: "fake-key",
      chatModel: "fake-qwen3.8",
      embedModel: "qwen3-embedding",
      storeRoot: join(root, "ace-store"),
    });
    const model = createHarnessModel({ id: "fake-qwen3.8", baseUrl: server.url, profile: QWEN38_RVN_PROFILE });
    const repo = SqliteSessionRepo.open(join(root, "ace-store"));
    const harness = await createAceHarness({
      cwd,
      sessionRepo: repo,
      model,
      models: createHarnessModels(model, "fake-key"),
      profile: QWEN38_RVN_PROFILE,
      ace,
      permissionProfile: "standard",
      thinkingLevel: "high",
    });

    const result = await harness.prompt("List the numbers 1 to 2000 and commit the work.");

    expect(result.stopReason).toBe("stop");
    expect(result.text).toContain("Done");
    expect(result.verdict?.stage).toBe("none");
    expect(result.lens?.promptOriginal).toBe("List the numbers 1 to 2000 and commit the work.");

    // Gate: the bulky read-only command passes, the hook bypass is denied with ACE's reason.
    expect(result.gates.map((gate) => gate.payload.decision.allow)).toEqual([true, false]);
    expect(result.gates[1]?.payload.decision).toMatchObject({ source: "block-no-verify" });

    // Compaction: the 2000-line output was stored and the model saw the summary + retrieval id.
    expect(result.compactions).toHaveLength(1);
    const compaction = result.compactions[0]!.payload;
    expect(compaction.originalChars).toBeGreaterThan(4_000);
    expect(compaction.compactedChars).toBeLessThan(compaction.originalChars);
    const retrieve = harness.agent.state.tools.find((tool) => tool.name === "ace_retrieve_context")!;
    const verbatim = await retrieve.execute("t", { id: compaction.retrievalId });
    expect((verbatim.content[0] as { text: string }).text.trim().split("\n")).toHaveLength(2000);

    // The wire: profile sampling and the mapped effort (high → medium) reached the server, never `high`.
    const chat = server.seen.filter((request) => request.path === "/v1/chat/completions");
    expect(chat).toHaveLength(3);
    expect(chat[0]!.auth).toBe("Bearer fake-key");
    expect(chat[0]!.body).toMatchObject({ top_k: 20, temperature: 0.6, chat_template_kwargs: { reasoning_effort: "medium" } });
    expect(chat[0]!.body).not.toHaveProperty("reasoning_effort");
    const thirdMessages = chat[2]!.body!.messages as { role: string; content: string }[];
    expect(thirdMessages.find((message) => message.role === "tool")?.content).toContain("ace_retrieve_context");

    // Run end: evaluation + reflection ran; the session is durable; AEP folded the turn.
    expect(result.evaluation?.outcome).toBeDefined();
    expect(result.reflection).toEqual({ proposals: expect.any(Number), new: expect.any(Number) });
    expect((await harness.session.findEntries()).filter((entry) => entry.type === "message").length).toBeGreaterThanOrEqual(6);
    expect(harness.aep.state).toMatchObject({ status: "idle", turnIds: [result.turnId], model: "fake-qwen3.8", permissionProfile: "standard" });
    expect(harness.aep.state.items.length).toBeGreaterThan(0);
    expect(harness.aep.state.anomalies).toEqual([]);
    const types = new Set<string>();
    harness.aep.close();
    for await (const event of harness.aep.events()) types.add(event.type);
    expect([...types]).toEqual(
      expect.arrayContaining(["session.created", "turn.started", "tool.requested", "tool.completed", "permission.resolved", "assistant.text", "turn.completed"]),
    );

    await harness.close();
    ace.dispose();
    repo.close();
  }, 30_000);
});
