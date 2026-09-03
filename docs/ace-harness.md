# ACE-rooted harness (agent-runtime)

ADR-033 §2.4 in code: ACE (`@metactivity/ace`) is the context builder, the gate, the tool-result
compaction and the run-end evaluation of the vendored pi-agent-core loop. Code: `services/agent-runtime/src/ace/`
and `src/harness/spark-model.ts`. The runtime drives it behind `LOCAL_STUDIO_AGENT_CORE=harness` (W3, below); the
default core is still the pi-coding-agent SDK.

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

## Runtime driver (`LOCAL_STUDIO_AGENT_CORE=harness`)

`src/harness-runtime.ts` — `HarnessSession` implements the same `PiAgentSession` contract the http handlers call on the
pi driver (`ensureStarted` / `prompt` / `steer` / `followUp` / `mutateQueuedFollowUp` / `abort` / `compact` / `status` /
`getEventsAfter` / `onLoggedEvent`), so `http/handlers.ts` and the SSE loop are untouched; `piRuntimeManager` picks the
class from the flag (`src/agent-core.ts`). Per session: `resolveHarnessEndpoint` maps the composer model id to the
controller that listed it (`/api/agent/models`), or to `ACE_CHAT_BASE_URL` when the id is not listed; the bearer follows
the origin (ACE key for the ACE endpoint, settings key for the primary controller). Then `resolveModelProfile` →
`createHarnessModel` / `createHarnessModels` (pi-ai registry, no `ModelRuntime`) → `createAceHarness` with the process
ACE service (started once) and the SQLite repo. A `piSessionId` reopens that session (`SqliteSessionRepo.open`); a new
session gets a `model_change` entry so lists and replays know the model. `toolAccess: "read_only"` keeps `read` and
`ace_retrieve_context` only. Thinking level → `toPiThinkingLevel` → the profile map (`high` → `medium`, never `high`).

`src/harness-sessions.ts` — the session store the http session handlers read under the flag (`sessions-store.ts`
dispatches `listSessions` / `loadSession`): summaries from `sessions.db` (first/last user prompt, model, updated-at via
`json_extract`), archive flags from the same metadata store as pi, and replays as pi-shaped events — one synthesized
`{type:"session"}` header, then the branch entries (`message`, `compaction`, `model_change`) with `tail` / `before`
paging on entry `seq`. Session data lives under `ACE_STORE_ROOT`; the pi JSONL store is untouched for `pi`. The repo uses `node:sqlite`, so the
same code runs under bun (dev, tests) and node (the packaged `standalone.mjs`); the harness modules are imported lazily
behind the flag because `@metactivity/ace` ships TypeScript sources that node loads only from the bundle.

Not on this core yet: composer prompt templates, extension UI prompts (`respondExtensionUi` returns false); the
goal-driver continuation runs on it unchanged. `findSessionFile` (automations run summaries) still reads the pi JSONL;
`lastAssistantResult` (subagent reports) reads `sessions.db` under the flag.

### Built-in tools (W4, MET-915)

The nine bundled pi extensions run on this core as in-process tools (`src/tools/`, one module per former extension,
`builtinTools(ctx)` assembles them). Names, labels, descriptions and parameter schemas are byte-identical to the pi
versions — the skills under `frontend/desktop/resources/skills/*` and the model prompts name them — so a session
sees the same inventory on either core. Gates are the pi driver's (`buildAgentSessionOptionsSync().toolGates`, same
predicates as `runtimeExtensionPaths`); per-session values arrive on `ToolContext.env` (the same `runtimeEnvInjections`
pi exported to its extensions) instead of `process.env`.

| Module | Tools | Gate | Transport / env |
|---|---|---|---|
| `automations` | `list_automations` `read_automation` `schedule_automation` `update_automation` `set_automation_status` `run_automation_now` `delete_automation` | always | `/api/agent/automations…` in process; `LOCAL_STUDIO_CWD`, session model id for defaults |
| `subagents` | `subagent` `subagent_list` `subagent_status` `subagent_stop` | always | `/api/agent/subagents…` in process, scoped to the harness session id; a child is a second `HarnessSession` under `subagent:<parent>:<run>` (`src/subagents.ts`) |
| `cua` | `browser_navigate` `browser_get_url` `browser_get_text` `browser_get_html` `browser_screenshot` `browser_click` `browser_fill` `browser_scroll` `browser_back` `browser_forward` `browser_reload` `browser_history` | Browser tool on | `/api/agent/browser/:verb` in process; `LOCAL_STUDIO_BROWSER_SESSION_ID`, `LOCAL_STUDIO_BROWSER_TOOL_TIMEOUT_MS` |
| `chrome` | `chrome_navigate` `chrome_get_url` `chrome_get_text` `chrome_get_html` `chrome_screenshot` `chrome_click` `chrome_fill` `chrome_scroll` `chrome_eval` `chrome_tabs_list` `chrome_tabs_new` `chrome_tabs_switch` `chrome_tabs_close` `chrome_history` | Browser on + backend `chrome` + relay answers a 3 s `relay.capabilities` probe (only advertised methods) | JSON-RPC to the relay; `LOCAL_STUDIO_CHROME_RELAY_URL` / `_TOKEN` / `_SESSION`, `LOCAL_STUDIO_CHROME_TOOL_TIMEOUT_MS` (W10 renames) |
| `github` | `github_status` `github_search` `github_issue_list` `github_issue_view` `github_pr_list` `github_pr_view` `github_pr_diff` `github_pr_checks` `github_run_list` `github_run_view` `github_api` `github_cli` | `gh` binary found | `execFile` argv, no shell; `LOCAL_STUDIO_GH_PATH`, `LOCAL_STUDIO_CWD` |
| `obsidian` | `obsidian_vaults` `obsidian_search` `obsidian_read` `obsidian_recent` `obsidian_backlinks` `obsidian_create` `obsidian_append` | Obsidian registered a vault | filesystem; `LOCAL_STUDIO_OBSIDIAN_VAULTS` (fallback `LOCAL_STUDIO_OBSIDIAN_CONFIG` / obsidian.json) |
| `connectors` | `<connector_id>_<tool>` per granted MCP tool | ≥ 1 connector enabled | `/api/agent/connectors/call` in process, `model_id` = session model |

The in-process transport is `ToolContext.request` → the runtime's own Hono app (`app.request`, lazily created singleton);
the pi extensions reached the same handlers through the frontend proxy (`proxyToAgentRuntime`, verbatim), so replies
and error texts are unchanged and the ~5-minute response-header timeout no longer applies.

**Policies** (`src/tools/policies.ts`): `local-studio-agent-policy` → `withAgentPolicy` appends the artifact policy
text to the system prompt once; `local-studio-timeouts` → `withTimeoutPolicy` gives the vendored `bash` tool the
default `timeout` (`LOCAL_STUDIO_BASH_TIMEOUT_SECONDS`, 120) and cap (`LOCAL_STUDIO_BASH_MAX_TIMEOUT_SECONDS`, 900).
Neither touches ACE's gate. **Skills**: the composer's selected skills plus the gated bundled skill directories
(`buildAgentSessionOptionsSync().skills`, discovered by `skill-discovery.ts`) load through the vendored `loadSkills`
and are advertised with `formatSkillsForSystemPrompt`. System prompt order: base (+ vision guidance) → skills → policy.
`toolAccess: "read_only"` still keeps `read` and `ace_retrieve_context` only.

The pi driver is still the default core, so `frontend/desktop/resources/pi-extensions/` and `runtimeExtensionPaths()`
stay until the flip; the two implementations are held byte-identical on the tool surface until then.

### Wire compatibility

The frontend decodes `{type:"pi", seq, event}` and reads a handful of pi event types (`pi-event-applier.ts`,
`block-event.ts`, `helpers.ts`, `goal-driver.ts`, the SSE close on `agent_settled`). The vendored loop already emits
those shapes, so the driver forwards them as is and synthesizes the pi-coding-agent-only ones:

| Source | Event on the wire | Frontend use |
|---|---|---|
| loop `agent_start` / `agent_end` | unchanged | run boundaries (goal driver, tool badge settle) |
| loop `turn_start` / `turn_end` | unchanged | ignored |
| loop `message_start` / `message_update` / `message_end` | unchanged (`message.role/content/stopReason/errorMessage/usage`, `assistantMessageEvent`) | bubbles, deltas, token stats, steer echo, errors |
| loop `tool_execution_start` / `_update` / `_end` | unchanged (`toolCallId`, `toolName`, `args`, `result`, `isError`) | tool blocks |
| harness `prompt()` resolved or rejected | `agent_settled` | SSE `status: done`, session idle |
| `steer` / `followUp` / queue mutation / abort / queued message injected | `queue_update {steering, followUp}` | queue strip |
| journal `ace.history-compaction` | `compaction_end {reason: manual\|threshold, result: {summary, tokensBefore}}` | "Context compacted" block, context reset |
| harness `prompt()` threw | `notice {level: "error", message}` | session error banner |
| AEP (`turn.*`, `tool.*`, `assistant.*`, `permission.*`, `context.limit`) | not on this wire | ADR-023 SSE (`AepProjector.events()`); a gate denial is visible as the tool result error |
| journal `ace.router` / `ace.lens` / `ace.gate` / `ace.compaction` / `ace.evaluation` / `ace.reflection` / `ace.degraded` | not on this wire | `harness.journal` (`ace.compaction` must not reach the UI: its name would read as a history compaction) |

Replay (`GET /api/agent/sessions/:id`) is the same vocabulary pi writes: `session` header, `message` entries,
`compaction` entries (`summary`), `model_change`.

## Environment

| Variable | Default | Role |
|---|---|---|
| `LOCAL_STUDIO_AGENT_CORE` | `pi` | `harness` drives sessions with this file's harness and the SQLite session store |
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
