// The W2 DoD driver: one turn end to end with ACE rooted.
//
//   bun run harness-turn -- --cwd <dir> [--model <served id>] [--thinking <level>] [--class <router class>] "<prompt>"
//
// Environment: ACE_CHAT_BASE_URL, ACE_EMBED_BASE_URL, ACE_API_KEY, ACE_CHAT_MODEL,
// ACE_EMBED_MODEL, ACE_STORE_ROOT, ACE_PERMISSION_PROFILE (see docs/ace-harness.md).
// Locally: `bun test/support/fake-llama-server.ts` prints the env to export.

import { parseArgs } from "node:util";
import path from "node:path";
import type { RouterClass } from "@metactivity/ace";
import type { ThinkingLevel } from "@local-studio/harness";
import { createAceHarness } from "./ace-harness";
import { aceService, aceStatus, readAceConfig } from "./ace-service";
import { createSessionRepo } from "./sqlite-session-repo";
import { resolveModelProfile } from "../harness/model-profile";
import { createHarnessModel, createHarnessModels } from "../harness/spark-model";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: "string", default: process.cwd() },
    model: { type: "string" },
    thinking: { type: "string", default: "medium" },
    class: { type: "string" },
  },
});

const prompt = positionals.join(" ").trim();
if (prompt.length === 0) {
  console.error('usage: bun run harness-turn -- --cwd <dir> "<prompt>"');
  process.exit(2);
}

const { config, problems } = readAceConfig();
if (config === null) {
  console.error(`ACE is not configured: ${problems.join("; ")}`);
  process.exit(2);
}
const cwd = path.resolve(values.cwd);
const modelId = values.model ?? config.chatModel;
const profile = resolveModelProfile(modelId);
const model = createHarnessModel({ id: modelId, baseUrl: config.chatBaseUrl, profile });
const ace = aceService();
if (ace) await ace.start();

const harness = await createAceHarness({
  cwd,
  sessionRepo: createSessionRepo(config.storeRoot),
  model,
  models: createHarnessModels(model, config.apiKey),
  profile,
  ace,
  thinkingLevel: values.thinking as ThinkingLevel,
});

const section = (title: string) => console.log(`\n== ${title} ==`);
harness.events.on("loop", (raw) => {
  const event = raw as { type: string; toolName?: string; isError?: boolean };
  if (event.type === "tool_execution_start") console.log(`  → tool ${event.toolName}`);
  if (event.type === "tool_execution_end") console.log(`  ← tool ${event.toolName}${event.isError ? " (error)" : ""}`);
});

section("ACE");
const status = await aceStatus();
console.log(JSON.stringify({ health: status.health?.health, detail: status.health?.detail, runtime: status.runtime, profile: profile.id, problems: status.problems }, null, 2));

section("turn");
const started = Date.now();
const result = await harness.prompt(prompt, values.class ? { forcedClass: values.class as RouterClass } : {});
console.log(`stop=${result.stopReason} in ${Date.now() - started} ms${result.errorMessage ? ` error=${result.errorMessage}` : ""}`);
console.log(result.text);

section("router");
console.log(JSON.stringify(result.verdict));
section("context lens");
console.log(JSON.stringify(result.lens, null, 2));
section("gate decisions");
for (const gate of result.gates) {
  const d = gate.payload.decision;
  console.log(`${d.allow ? "allow" : "BLOCK"} ${gate.payload.toolName} [${d.access}]${d.allow ? "" : ` — ${d.source}: ${d.reason}`}`);
}
section("compaction");
for (const record of harness.journal.records(result.turnId)) {
  if (record.type === "ace.compaction" || record.type === "ace.history-compaction") console.log(JSON.stringify(record.payload));
}
section("evaluation");
console.log(JSON.stringify(result.evaluation));
section("reflection");
console.log(JSON.stringify(result.reflection), ace ? `pending proposals: ${ace.listProposals(cwd).length}` : "");
section("degraded");
for (const record of harness.journal.records(result.turnId)) if (record.type === "ace.degraded") console.log(JSON.stringify(record.payload));

await harness.close();
ace?.dispose();
process.exit(result.stopReason === "stop" ? 0 : 1);
