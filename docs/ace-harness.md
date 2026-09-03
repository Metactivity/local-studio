# ACE-rooted harness (agent-runtime)

ADR-033 §2.4 in code: ACE (`@metactivity/ace`) is the context builder, the gate, the tool-result
compaction and the run-end evaluation of the vendored pi-agent-core loop. Code: `services/agent-runtime/src/ace/`
and `src/harness/spark-model.ts`. Nothing in `http/` uses it yet (W3).

## Architecture

```
prompt ─► transform_context ─► Agent loop (pi-ai streamSimple → llama-server :8000)
              │                    │ before_tool ─ gate ─► block / allow
              │                    │ after_tool  ─ observe + compact (≥ 4000 chars → ide_tool_results)
              │                    │ prepareNextTurn ─ before_compaction ─► history summary when over budget
              └─ router + prepareTask     agent_end ─► before_run_end ─ evaluateResult + reflectAndFile
Session (SQLite, one row per mutation) ◄── every message ── AEP projector ── reducer ── events()
```

The vendored `AgentHarness` (0.84.3) is a scaffold — its `hooks.on` throws. `createAceHarness` therefore runs the
vendored `Agent` and owns a `Hooks` registry with the same `HookName` vocabulary; ACE registers through it like any
subscriber. Hook map (name → Agent seam → ACE handler):

| Hook | Seam | ACE |
|---|---|---|
| `before_run` | `prompt()` | — |
| `transform_context` | before the first request | `classifyPrompt` → journal; `prepareTask` → `<ace-context>` block prepended to the system prompt, Context Lens journaled, `markConsulted` |
| `before_payload` / `after_response` | `Agent.onPayload` / `onResponse` | — |
| `before_tool` | `Agent.beforeToolCall` | permission profile + `.metactivity/permissions.json` + `blockNoVerify` + `configProtection`; tool-loop guard (`maxIdenticalCalls`) blocks with `terminate` |
| `after_tool` | `Agent.afterToolCall` | `observeAgentEvent`; result ≥ `COMPACTION_MIN_CHARS` → `storeToolResult`, content replaced by summary + `ace_retrieve_context {"id"}` |
| `before_compaction` | `Agent.prepareNextTurn` | fires before the harness history summary; a handler may `{ skip: true }` |
| `before_run_end` | after `agent_end` | `evaluateResult(phase)`, `reflectAndFile`, `recordRouterVeto` when `--class` disagreed |
| `before_resume`, `before_request`, `before_navigation` | — | accepted, not wired (no seam in `Agent`) |

**Compaction split.** ACE owns tool results (the bulk of context growth; the original stays one tool call away).
Message-history compaction has no ACE equivalent, so it stays the vendored `prepareCompaction`/`compact` summary path,
driven from `prepareNextTurn` when `shouldCompact(estimate, profile.contextWindow)` — run at effort `low`, entry
appended to the session, Agent transcript rebuilt from the session (`buildSessionContext`).

**Model profile.** `spark-model.ts` turns a `ModelProfile` into the pi-ai `Model`: sampling as `samplingParams`,
effort through `compat.thinkingFormat: "chat-template"` → `chat_template_kwargs.reasoning_effort` mapped by
`thinkingLevelMap` (`high` → `medium`, `max` → `xhigh`, `off` omitted); `supportsReasoningEffort: false` so no
top-level `reasoning_effort` is sent.

## Environment

| Variable | Default | Role |
|---|---|---|
| `ACE_RUNTIME_KIND` | `external` | `external` (endpoints below) or `supervised` (ACE's own llama-server) |
| `ACE_CHAT_BASE_URL` / `ACE_EMBED_BASE_URL` | required for `external` | llama-server origins (`:8000` / `:8001` on the Spark) |
| `ACE_API_KEY` | — | bearer for both ACE role calls and user turns |
| `ACE_CHAT_MODEL` / `ACE_EMBED_MODEL` | `spark-qwen38-27b-rvn-q8` / `qwen3-embedding` | served ids; the chat id selects the `ModelProfile` |
| `ACE_STORE_ROOT` | `<data dir>/ace-store` | ACE stores, router prototypes, `sessions.db` |
| `ACE_VEC_EXTENSION` | — | sqlite-vec path (dense retrieval arm) |
| `ACE_PERMISSION_PROFILE` | `standard` | `safe` / `standard` / `autonomous` |
| `ACE_SESSION_STORE` | `sqlite` | `jsonl` keeps the vendored JSONL repo |

## Degradation

| Failure | Effect |
|---|---|
| Env incomplete / invalid | `aceService()` is `null`; the harness runs without ACE; `aceStatus().problems` says why |
| Runtime unreachable | ACE `degraded`: retrieval/graph/gate/compaction/reflection still run (local); router → `stage: "none"` |
| `prepareTask` / `classifyPrompt` throw | journaled as `ace.degraded`; turn continues without the context block |
| Any hook handler throws | journaled, skipped; the turn never fails because of a hook |
| History summary fails | journaled; context left as is |
| Compacted result rotated out | `ace_retrieve_context` returns a tool error; the summary stays in context |

## Running the driver

```sh
cd services/agent-runtime
bun test/support/fake-llama-server.ts &      # local: prints the ACE_* exports to use
bun run harness-turn -- --cwd /path/to/project "List the numbers 1 to 2000 and commit the work."
# Spark: ACE_CHAT_BASE_URL=http://127.0.0.1:8000 ACE_EMBED_BASE_URL=http://127.0.0.1:8001 ACE_API_KEY=… ACE_CHAT_MODEL=spark-qwen38-27b-rvn-q8
```

It prints the router verdict, the Context Lens, each gate decision, compaction records, the evaluation and the
reflection tally. Tests: `bun test` in `services/agent-runtime` (gate, compaction round-trip, SQLite conformance,
profile → model, one scripted turn end to end).
