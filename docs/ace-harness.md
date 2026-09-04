# ACE-rooted harness (agent-runtime)

ADR-033 §2.4 in code: ACE (`@metactivity/ace`) is the context builder, the gate, the tool-result
compaction and the run-end evaluation of the vendored pi-agent-core loop. Code: `services/agent-runtime/src/ace/`
and `src/harness/spark-model.ts`. It is the runtime's only agent core (MET-914 W3b): the pi-coding-agent SDK driver,
its JSONL session store and the bundled pi extensions are gone and `@earendil-works/pi-coding-agent` is no longer a
dependency (the pieces still wanted were vendored — see "pi-coding-agent audit" below); `LOCAL_STUDIO_AGENT_CORE` is
accepted for one more release and any value other than `harness` logs a deprecation warning (`src/agent-core.ts`).

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

| Hook                                                   | Seam                             | ACE                                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_run`                                           | `prompt()`                       | —                                                                                                                                                          |
| `transform_context`                                    | before the first request         | `classifyPrompt` → journal; `prepareTask` → `<ace-context>` block prepended to the system prompt, Context Lens journaled, `markConsulted`                  |
| `before_payload` / `after_response`                    | `Agent.onPayload` / `onResponse` | —                                                                                                                                                          |
| `before_tool`                                          | `Agent.beforeToolCall`           | permission profile + `.metactivity/permissions.json` + `blockNoVerify` + `configProtection`; tool-loop guard (`maxIdenticalCalls`) blocks with `terminate` |
| `after_tool`                                           | `Agent.afterToolCall`            | `observeAgentEvent`; result ≥ `COMPACTION_MIN_CHARS` → `storeToolResult`, content replaced by summary + `ace_retrieve_context {"id"}`                      |
| `before_compaction`                                    | `Agent.prepareNextTurn`          | fires before the harness history summary; a handler may `{ skip: true }`                                                                                   |
| `before_run_end`                                       | after `agent_end`                | `evaluateResult(phase)`, `reflectAndFile`, `recordRouterVeto` when `--class` disagreed                                                                     |
| `before_resume`, `before_request`, `before_navigation` | —                                | accepted, not wired (no seam in `Agent`)                                                                                                                   |

**Compaction split.** ACE owns tool results (the bulk of context growth; the original stays one tool call away).
Message-history compaction has no ACE equivalent, so it stays the vendored `prepareCompaction`/`compact` summary path,
driven from `prepareNextTurn` when `shouldCompact(estimate, profile.contextWindow)` — run at effort `low`, entry
appended to the session, Agent transcript rebuilt from the session (`buildSessionContext`).

**Model profile.** `spark-model.ts` turns a `ModelProfile` into the pi-ai `Model`: sampling as `samplingParams`,
effort through `compat.thinkingFormat: "chat-template"` → `chat_template_kwargs.reasoning_effort` mapped by
`thinkingLevelMap` (`high` → `medium`, `max` → `xhigh`, `off` omitted); `supportsReasoningEffort: false` so no
top-level `reasoning_effort` is sent.

## Runtime driver

`src/harness-runtime.ts` — `HarnessSession` implements the `PiAgentSession` contract the http handlers call
(`ensureStarted` / `prompt` / `steer` / `followUp` / `mutateQueuedFollowUp` / `abort` / `compact` / `status` /
`getEventsAfter` / `onLoggedEvent`), the contract the pi-coding-agent driver used to satisfy, so `http/handlers.ts` and
the SSE loop did not change across the flip; `piRuntimeManager` (`src/runtime-manager.ts`, name kept) creates one per
runtime session id. Per session: `resolveHarnessEndpoint` maps the composer model id to the
controller that listed it (`/api/agent/models`), or to `ACE_CHAT_BASE_URL` when the id is not listed; the bearer follows
the origin (ACE key for the ACE endpoint, settings key for the primary controller). Then `resolveModelProfile` →
`createHarnessModel` / `createHarnessModels` (pi-ai registry, no `ModelRuntime`) → `createAceHarness` with the process
ACE service (started once) and the SQLite repo. A `piSessionId` reopens that session (`SqliteSessionRepo.open`); a new
session gets a `model_change` entry so lists and replays know the model. `toolAccess: "read_only"` keeps `read` and
`ace_retrieve_context` only. Thinking level → `toPiThinkingLevel` → the profile map (`high` → `medium`, never `high`).

`src/harness-sessions.ts` — the session store the http session handlers read (`listSessions` / `loadSession`): summaries from `sessions.db` (first/last user prompt, model, updated-at via
`json_extract`), archive flags from the same metadata store as pi, and replays as pi-shaped events — one synthesized
`{type:"session"}` header, then the branch entries (`message`, `compaction`, `model_change`) with `tail` / `before`
paging on entry `seq`. Session data lives under `ACE_STORE_ROOT`. The repo uses `node:sqlite`, so the same code runs under
bun (dev, tests) and node (the packaged `standalone.mjs`). `@metactivity/ace` ships TypeScript sources, so node runs the
runtime from the bun bundle only (`dist/standalone.mjs`, what `start.mjs` and the systemd unit launch); `dist/server.js`
(the tsc output) is a typecheck artefact, not a boot target. Old pi JSONL rollouts are not migrated or listed.

Also on this core: **composer prompt templates** — the selected `.md` files load through the vendored `loadPromptTemplates`
once per session start and a message that is exactly `/name args` expands with pi's rule (`expandPromptTemplate`:
`$1`, `$@`, `$ARGUMENTS`, shell-style quoting; an unknown name is sent as typed); the **session goal** — a
`transform_context` contribution (`goalSystemContext`) re-read on every turn, so `/goal` steers the turns the user
types too; **automation run summaries and subagent reports** — `lastAssistantResult(sessionId)` reads `sessions.db`;
the automation target lookup asks the store (`hasSession`). Decisions taken at the flip:

- **Extension UI prompts** (`select` / `confirm` / `input` / `editor` dialogs) existed for pi extensions; no built-in
  tool asks the user anything mid-turn, so the session contract lost `respondExtensionUi` and the runtime never emits
  `extension_ui_request`. `POST /api/agent/runtime/extension-ui` stays and answers 204 so an older client's reply is a
  no-op; the frontend dialog code is untouched and simply never triggers.
- **Core tools** are pi's seven: `read` / `write` / `edit` / `bash` from agent-core plus `grep` / `find` / `ls` vendored
  from pi-coding-agent onto the harness tool contract (`packages/harness/src/harness/tools/{grep,find,ls}.ts`, same
  names, schemas and output). `grep` needs `rg` and `find` needs `fd` on PATH (`PI_RG_PATH` / `PI_FD_PATH` override);
  pi downloaded a missing binary at first use, this runtime reports an install hint instead.
  **`toolAccess: "read_only"`** is pi's set — `read` / `grep` / `find` / `ls` — plus `ace_retrieve_context`.
- **System prompt** gains what pi's resource loader added: the project context files (`src/harness/context-files.ts`:
  `<agentDir>/AGENTS.md` first, then one `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` per ancestor directory from
  the root down to cwd, in pi's `<project_context>` block) and the `Current working directory:` line. Order: base →
  vision guidance → project context → skills → cwd → artifact policy → per-turn goal. pi's linked-worktree dedupe rule
  and its pi-documentation section were not ported.
- **User plugins** (`<agentDir>/extensions`, the Plugins tab) were pi extensions and do not load on this core; the tab
  still lists them and the nine built-in tool modules (`src/builtin-plugins.ts`).
- **Cloud provider sign-in** (`src/provider-hub.ts`) runs on the vendored `ModelRuntime`
  (`@local-studio/harness/providers`, same `auth.json` / `models.json` under `~/.pi/agent`); every
  `/api/agent/providers/*` endpoint is unchanged (`test/provider-hub.test.ts` drives the login-job state machine over a
  fake runtime). A provider model is listed in the picker but not routable by `resolveHarnessEndpoint` yet.

### pi-coding-agent audit (what the runtime kept when the dependency left)

| Module (`dist/core`)                                                                                                                                                                                                                                                                                                       | Outcome                                          | Reason                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools/grep`, `tools/find`, `tools/ls`                                                                                                                                                                                                                                                                                     | vendored → `packages/harness/src/harness/tools/` | agent-core ships read/write/edit/bash/image only; the model lost grep/find/ls and had to shell out                                                                                                                                                     |
| `tools/truncate`, `tools/output-accumulator`, `tools/render-utils`, `tools/path-utils`, `tools/tool-definition-wrapper`, `tools/file-mutation-queue`, `tools/read`/`write`/`edit`/`edit-diff`                                                                                                                              | covered by agent-core                            | `utils/truncate.ts`, `utils/shell-output.ts` and `tools/*` in the vendored package are the same code; render-utils/wrapper are TUI plumbing                                                                                                            |
| `bash-executor`                                                                                                                                                                                                                                                                                                            | dropped — agent-core `bash` kept                 | agent-core's `executeShellWithCapture` + `NodeExecutionEnv.exec` has everything pi's executor had (rolling 100 KB tail, temp file, sanitizing) plus a timeout that kills the process group and abort handling; pi's executor had no timeout of its own |
| `output-guard`                                                                                                                                                                                                                                                                                                             | dropped                                          | stdout takeover for the TUI process; no terminal here                                                                                                                                                                                                  |
| `model-runtime`, `auth-storage`, `models-store`, `model-config`, `provider-composer`, `resolve-config-value`, `remote-catalog-provider`, `runtime-credentials`                                                                                                                                                             | vendored → `packages/harness/src/providers/`     | provider-hub's sign-in, credential store and model catalog; pi-ai has the OAuth flows but not the store or the composer                                                                                                                                |
| `model-registry`, `auth-guidance`                                                                                                                                                                                                                                                                                          | dropped                                          | extension-facing facade over ModelRuntime; CLI `/login` help text                                                                                                                                                                                      |
| `resource-loader` (context files)                                                                                                                                                                                                                                                                                          | ported → `src/harness/context-files.ts`          | the system prompt lost AGENTS.md / CLAUDE.md discovery; same candidates and precedence, worktree dedupe skipped                                                                                                                                        |
| `resource-loader` (extensions, themes, packages), `package-manager`, `settings-manager`                                                                                                                                                                                                                                    | dropped                                          | pi extension/theme/package loading and pi settings.json; tools are native, settings are Local Studio's                                                                                                                                                 |
| `system-prompt`                                                                                                                                                                                                                                                                                                            | partially ported                                 | `<project_context>` block and cwd line reproduced in `HarnessSession`; pi's tool list, guidelines and pi-docs section not wanted                                                                                                                       |
| `prompt-templates`, `skills`, `session-manager`, `compaction/*`, `messages`                                                                                                                                                                                                                                                | covered by agent-core                            | `prompt-templates.ts`, `skills.ts`, the session tree with branch summarization, `compaction/` and `messages.ts` are all in the vendored package                                                                                                        |
| `provider-attribution`                                                                                                                                                                                                                                                                                                     | dropped                                          | pi.dev attribution headers for OpenRouter/NVIDIA/Cloudflare telemetry                                                                                                                                                                                  |
| `usage-totals`, `cache-stats`                                                                                                                                                                                                                                                                                              | dropped                                          | per-model cost breakdown and cache-miss heuristics for pi's footer; `session-usage.ts` already totals input/output/cache/cost/calls/compactions from the transcript                                                                                    |
| `project-trust`, `trust-manager`                                                                                                                                                                                                                                                                                           | dropped                                          | ACE's gate and permission profiles cover it                                                                                                                                                                                                            |
| `agent-session`, `agent-session-runtime`, `agent-session-services`, `sdk`, `extensions/*`, `slash-commands`, `keybindings`, `footer-data-provider`, `export-html`, `event-bus`, `exec`, `http-dispatcher`, `telemetry`, `timings`, `session-cwd`, `source-info`, `pi-manifest`, `radius`, `model-resolver`, `experimental` | dropped                                          | the pi session/TUI/SDK layer the harness replaces, or CLI-only helpers                                                                                                                                                                                 |

### Built-in tools (W4, MET-915)

The nine former bundled pi extensions run as in-process tools (`src/tools/`, one module per former extension,
`builtinTools(ctx)` assembles them). Names, labels, descriptions and parameter schemas are byte-identical to the pi
versions — the skills under `frontend/desktop/resources/skills/*` and the model prompts name them — so a session
sees the same inventory it did before the flip. Gates come from `buildAgentSessionOptionsSync().toolGates`; per-session
values arrive on `ToolContext.env` (the same `runtimeEnvInjections` pi exported to its extensions) instead of `process.env`.

| Module        | Tools                                                                                                                                                                                                                                                | Gate                                                                                                     | Transport / env                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automations` | `list_automations` `read_automation` `schedule_automation` `update_automation` `set_automation_status` `run_automation_now` `delete_automation`                                                                                                      | always                                                                                                   | `/api/agent/automations…` in process; `LOCAL_STUDIO_CWD`, session model id for defaults                                                                         |
| `subagents`   | `subagent` `subagent_list` `subagent_status` `subagent_stop`                                                                                                                                                                                         | always                                                                                                   | `/api/agent/subagents…` in process, scoped to the harness session id; a child is a second `HarnessSession` under `subagent:<parent>:<run>` (`src/subagents.ts`) |
| `cua`         | `browser_navigate` `browser_get_url` `browser_get_text` `browser_get_html` `browser_screenshot` `browser_click` `browser_fill` `browser_scroll` `browser_back` `browser_forward` `browser_reload` `browser_history`                                  | Browser tool on                                                                                          | `/api/agent/browser/:verb` in process; `LOCAL_STUDIO_BROWSER_SESSION_ID`, `LOCAL_STUDIO_BROWSER_TOOL_TIMEOUT_MS`                                                |
| `chrome`      | `chrome_navigate` `chrome_get_url` `chrome_get_text` `chrome_get_html` `chrome_screenshot` `chrome_click` `chrome_fill` `chrome_scroll` `chrome_eval` `chrome_tabs_list` `chrome_tabs_new` `chrome_tabs_switch` `chrome_tabs_close` `chrome_history` | Browser on + backend `chrome` + a paired browser answers the 3 s `relay.capabilities` probe (only advertised methods) | JSON-RPC to the Browser Bridge (below); `LOCAL_STUDIO_BRIDGE_URL` / `_TOKEN` / `_SESSION`, legacy `LOCAL_STUDIO_CHROME_RELAY_*`, `LOCAL_STUDIO_CHROME_TOOL_TIMEOUT_MS` |
| `github`      | `github_status` `github_search` `github_issue_list` `github_issue_view` `github_pr_list` `github_pr_view` `github_pr_diff` `github_pr_checks` `github_run_list` `github_run_view` `github_api` `github_cli`                                          | `gh` binary found                                                                                        | `execFile` argv, no shell; `LOCAL_STUDIO_GH_PATH`, `LOCAL_STUDIO_CWD`                                                                                           |
| `obsidian`    | `obsidian_vaults` `obsidian_search` `obsidian_read` `obsidian_recent` `obsidian_backlinks` `obsidian_create` `obsidian_append`                                                                                                                       | Obsidian registered a vault                                                                              | filesystem; `LOCAL_STUDIO_OBSIDIAN_VAULTS` (fallback `LOCAL_STUDIO_OBSIDIAN_CONFIG` / obsidian.json)                                                            |
| `connectors`  | `<connector_id>_<tool>` per granted MCP tool                                                                                                                                                                                                         | ≥ 1 connector enabled                                                                                    | `/api/agent/connectors/call` in process, `model_id` = session model                                                                                             |

The in-process transport is `ToolContext.request` → the runtime's own Hono app (`app.request`, lazily created singleton);
the pi extensions reached the same handlers through the frontend proxy (`proxyToAgentRuntime`, verbatim), so replies
and error texts are unchanged and the ~5-minute response-header timeout no longer applies.

**Policies** (`src/tools/policies.ts`): `local-studio-agent-policy` → `withAgentPolicy` appends the artifact policy
text to the system prompt once; `local-studio-timeouts` → `withTimeoutPolicy` gives the vendored `bash` tool the
default `timeout` (`LOCAL_STUDIO_BASH_TIMEOUT_SECONDS`, 120) and cap (`LOCAL_STUDIO_BASH_MAX_TIMEOUT_SECONDS`, 900).
Neither touches ACE's gate. **Skills**: the composer's selected skills plus the gated bundled skill directories
(`buildAgentSessionOptionsSync().skills`, discovered by `skill-discovery.ts`) load through the vendored `loadSkills`
and are advertised with `formatSkillsForSystemPrompt`. System prompt order: base (+ vision guidance) → skills → policy.
`toolAccess: "read_only"` keeps `read` and `ace_retrieve_context` only (see the decisions above).

### Wire compatibility

The frontend decodes `{type:"pi", seq, event}` and reads a handful of pi event types (`pi-event-applier.ts`,
`block-event.ts`, `helpers.ts`, `goal-driver.ts`, the SSE close on `agent_settled`). The vendored loop already emits
those shapes, so the driver forwards them as is and synthesizes the ones the pi-coding-agent driver used to add:

| Source                                                                                                                   | Event on the wire                                                                         | Frontend use                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| loop `agent_start` / `agent_end`                                                                                         | unchanged                                                                                 | run boundaries (goal driver, tool badge settle)                                                         |
| loop `turn_start` / `turn_end`                                                                                           | unchanged                                                                                 | ignored                                                                                                 |
| loop `message_start` / `message_update` / `message_end`                                                                  | unchanged (`message.role/content/stopReason/errorMessage/usage`, `assistantMessageEvent`) | bubbles, deltas, token stats, steer echo, errors                                                        |
| loop `tool_execution_start` / `_update` / `_end`                                                                         | unchanged (`toolCallId`, `toolName`, `args`, `result`, `isError`)                         | tool blocks                                                                                             |
| harness `prompt()` resolved or rejected                                                                                  | `agent_settled`                                                                           | SSE `status: done`, session idle                                                                        |
| `steer` / `followUp` / queue mutation / abort / queued message injected                                                  | `queue_update {steering, followUp}`                                                       | queue strip                                                                                             |
| journal `ace.history-compaction`                                                                                         | `compaction_end {reason: manual\|threshold, result: {summary, tokensBefore}}`             | "Context compacted" block, context reset                                                                |
| harness `prompt()` threw                                                                                                 | `notice {level: "error", message}`                                                        | session error banner                                                                                    |
| AEP (`turn.*`, `tool.*`, `assistant.*`, `permission.*`, `context.limit`)                                                 | not on this wire                                                                          | ADR-023 SSE (`AepProjector.events()`); a gate denial is visible as the tool result error                |
| journal `ace.router` / `ace.lens` / `ace.gate` / `ace.compaction` / `ace.evaluation` / `ace.reflection` / `ace.degraded` | not on this wire                                                                          | `harness.journal` (`ace.compaction` must not reach the UI: its name would read as a history compaction) |

Replay (`GET /api/agent/sessions/:id`) is the same vocabulary pi writes: `session` header, `message` entries,
`compaction` entries (`summary`), `model_change`.

## Browser Bridge (W10, MET-921)

The backend of the `chrome_*` tools: a relay inside the runtime (`src/browser-bridge/`) and the **Tuum Browser
Bridge** Chrome extension (`frontend/desktop/browser-bridge-extension/`, MV3, unpacked; its README has the load and
pairing steps). The extension dials the runtime **outbound**; nothing listens in the browser.

| Surface                                | Role                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /bridge/rpc`                     | JSON-RPC 2.0 from the tools: `relay.capabilities` + the 13 `browser.*` methods (fixed allow-list, anything else → `-32601`); session from `X-Tuum-Session` (or the legacy `X-Sitegeist-Session`), default `default`; `Authorization: Bearer` required only when `LOCAL_STUDIO_BRIDGE_TOKEN` is set |
| `GET /bridge/ws`                       | The extension's WebSocket (upgrade taken on the node server, same loopback-Host rule as the app). First frame `{type:"pair", code}` or `{type:"auth", token}`, then JSON-RPC requests relay → browser, `{type:"state", readOnly}` / `{type:"ping"}` browser → relay |
| `POST /api/agent/bridge/pair/start`    | One-time 6-digit code (5 min, one outstanding per session) shown by the panel's ACE tab card; redeemed once, it mints a bearer token persisted in `<data dir>/browser-bridge.json` (0600) |
| `GET /api/agent/bridge/status`         | `{paired, connected, readOnly, pairing, stationUrl}`; the card polls it every 3 s                                                                        |

Errors are decided fast, never by hanging: no browser connected for the session → `-32001 browser not paired` (the
probe then registers no `chrome_*` tool for the next session); the browser did not answer within
`LOCAL_STUDIO_CHROME_TOOL_TIMEOUT_MS` (120 s) → `-32000`; the extension's approval switch off → `-32002 read-only mode`
for `browser.eval` / `click` / `fill` (the switch lives in the extension, the relay only reports it). The relay logs no
frame: page text and screenshots pass through and are never stored. Tokens travel in the first WebSocket frame, never in
a URL; the extension keeps its token in `chrome.storage.local` only.

Tool-side env: `LOCAL_STUDIO_BRIDGE_URL` (unset or empty = this runtime's own relay, in process; a base URL = that
runtime's `/bridge/rpc`), `LOCAL_STUDIO_BRIDGE_TOKEN`, `LOCAL_STUDIO_BRIDGE_SESSION` (default `default`). The legacy
`LOCAL_STUDIO_CHROME_RELAY_URL` / `_TOKEN` / `_SESSION` (Sitegeist `~/.config/sitegeist-relay/env`) still select an
external relay when set and no bridge URL is. `LOCAL_STUDIO_BRIDGE_PUBLIC_URL` overrides the station URL the card shows
(default `http://127.0.0.1:<PORT>`); the runtime binds loopback, so a browser on another machine reaches it through a
tunnel (`ssh -L 18081:127.0.0.1:8081`) until the edge forwards `/bridge/ws`.

## Workspace identity

One identity per call (ADR-034 §2.5, MET-927): the Local Studio project folder is the `?folder=` of the IDE iframe, the
harness `cwd`, the ACE project hash and, from M5, the bridge session key. It reaches the runtime as `X-Tuum-Session` /
`X-Tuum-Folder` (`shared/agent/workspace-identity.ts`; the folder is percent-encoded) — set by the frontend on `turn` and
`compact`, filled in by the Next proxy from `?sessionId=` / `?cwd=` on the query-addressed routes — and falls back to the
body/query fields. `sessionIdentity()` is the single resolver; `ensureStarted` then runs `resolveAgentCwdEffect`
(realpath + `WORKSPACE_ROOTS`) on the result. `tuum-server` no longer needs `--default-folder` since the iframe always
passes `?folder=` — dropping the flag from the Spark unit is an M10 item (`docs/ide/architecture-tuum-web.md` §6).

## Panel + /ace API

The `/ide` right column (ADR-034 M4, `frontend/src/features/ide/ide-agent-panel.tsx`) is the `/agent` chat pane on the
owned harness — composer, timeline, queue strip, Stop — bound to the selected project: `cwd` = the project path, one
session per folder (the latest one of that folder reopens on a project switch, a fresh one otherwise; a session picker
at the top of the column). It is the same `useWorkspace` controller and `renderWorkspacePane` as `/agent`, in memory-only
mode, so nothing about the chat is duplicated. The composer's reasoning picker lists the served model's profile efforts
(`controllerModelThinkingLevels` → Qwen3.8: `low | medium | xhigh`, default `medium`, never `high`); every settled
assistant turn carries a provenance line (`message.model` from the pi message + the local time).

The other tabs are the first ACE surfaces (`frontend/src/features/ace/*`), read through `/api/agent/ace/*`
(`services/agent-runtime/src/http/ace-handlers.ts`, proxied one-to-one by `frontend/src/app/api/agent/ace/*`). The
folder is the workspace identity (`X-Tuum-Folder`, or `?cwd=` / `body.cwd`) and is checked against `WORKSPACE_ROOTS`;
an unconfigured ACE answers 503 with `aceStatus().problems`.

| Route                                                                                 | Tab                                                                                             | NativeService                                                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/agent/ace/status?cwd=`                                                      | ACE — health, model, endpoints, graph freshness, store, inbox count                             | `aceStatus()` + `runtimeSnapshot()` + `controlSnapshot(cwd)`                                         |
| `GET /api/agent/ace/proposals?cwd=&status=pending`                                    | Memory — inbox (badge = pending count)                                                          | `listProposals`                                                                                      |
| `POST /api/agent/ace/proposals/:id` `{cwd, action: accept\|reject, content?, scope?}` | Memory — accept (editable) / reject                                                             | `resolveProposal`                                                                                    |
| `GET /api/agent/ace/memory?cwd=`                                                      | Memory — project + global playbook bullets                                                      | `readPlaybook` + `listMemory`                                                                        |
| `GET /api/agent/ace/lens?sessionId=&piSessionId=`                                     | Context — Context Lens of the last turn: router verdict, sources, gates, compaction, evaluation | `HarnessSession.aceJournal()` (the running harness's journal; empty when the session is not running) |
| `POST /api/agent/ace/rebuild-graph` `{cwd}`                                           | ACE — Rebuild graph                                                                             | `rebuildGraph`                                                                                       |
| `POST /api/agent/ace/restart`                                                         | ACE — Restart                                                                                   | `restart`                                                                                            |

Tests: `test/ace-handlers.test.ts` (status shape, accept/reject round trip on a temp store, lens of a scripted turn).

## IDE Bridge (ADR-034 M5)

The embedded Tuum workbench (reh-web on the Spark) talks to this runtime over a Unix socket, newline-delimited
JSON-RPC 2.0, contract `@metactivity/protocol` `ide.ts` (`protocolVersion` 1). Code: `src/ide-bridge/`
(`server.ts` socket + sessions, `context.ts` latest editor state per folder + the `<ide-context>` block,
`ace-endpoint.ts` the `ace/*` methods served by the process-wide `NativeService`), `src/tools/ide.ts` (the
`ide_*` harness tools), `src/http/ide-handlers.ts` (`GET /api/agent/ide/context?cwd=`).

| Piece | Behaviour |
| --- | --- |
| Socket | `IDE_BRIDGE_SOCKET`, default `<data dir>/ide-bridge.sock`, mode 600, a stale file is unlinked at boot; the `ace-agent` extension connects out with `TUUM_BRIDGE_SOCKET` set to the same path (`/etc/ai/tuum-web.env` on the Spark) and `TUUM_ACE_MODE=bridge` |
| Handshake | `ide.hello {sessionId, folder, extensionVersion, protocolVersion}` → `{protocolVersion, runtimeVersion}`; `folder` must pass `WORKSPACE_ROOTS`; every tab keeps its own connection per folder, the most recently active one (last hello or `ide.*` event, heartbeats aside) serves the context and actions; `ide.heartbeat` every 15 s, the runtime closes after 45 s of silence |
| Events (IDE → runtime) | `ide.workspace.changed`, `ide.editor.active`, `ide.editor.tabs`, `ide.document.saved`, `ide.diagnostics.changed`, `ide.scm.changed`, `ide.search.results` fold into the per-folder context; the next turn gets a bounded `<ide-context>` block (≤ 1 500 chars: active file + selection, diagnostics totals, git branch/changes, tabs, last save) beside `<ace-context>` |
| Actions (runtime → IDE) | `ide.openFile`, `ide.readFile`, `ide.searchWorkspace`, `ide.symbols`, `ide.references`, `ide.reveal`, `ide.showDiff`, `ide.getDiagnostics` — exposed to the model as `ide_open_file`, `ide_read_file`, `ide_search`, `ide_symbols`, `ide_references`, `ide_reveal`, `ide_show_diff`, `ide_diagnostics`, added to the tool list per turn only while an IDE is connected for the session folder (read access under every permission profile); 10 s timeout (30 s for search) |
| ACE over the bridge | `ace/getStatus`, `ace/prepareTask`, `ace/retrieveRelevantContext`, `ace/listProposals`, `ace/resolveProposal`, `ace/observeAgentEvent` (notification) — the extension's AcePort on the single ACE this runtime owns |
| Panel | `GET /api/agent/ide/context?cwd=` → `{connected, context, totals}` for the Context tab chips and the "IDE connected" pill |

Degradation: no socket listener → logged at boot, everything else runs; no IDE for a folder → no `ide_*` tools,
no `<ide-context>`; an action that times out or hits a disconnected IDE returns a tool failure, the turn goes on.
M7 adds `runTerminal`, `runTask` and `ide.terminal.output`.

Tests: `test/ide-bridge.test.ts` (fake extension client: hello/ack, event → context, action round trip, timeout,
context block bound, `ide_*` tools only while connected).

### M6 — edit / diff / apply (MET-929, packages 0.3.0)

| Piece | Behaviour |
| --- | --- |
| Write tools | `ide_apply_edit {path, text, range?}`, `ide_apply_patch {unifiedDiff}`, `ide_create_file`, `ide_rename`, `ide_delete`, `ide_run_command {id}` (only the protocol's `IDE_RUN_COMMAND_ALLOWLIST`) → `ide.applyEdit` / `ide.applyPatch` / `ide.fs.*` / `ide.runCommand`; paths must stay inside the session folder (refused before the IDE is asked). Gate class **write** (`IDE_WRITE_TOOLS` in `ace-gate.ts`): Safe blocks, **Standard asks**, Autonomous allows |
| The ask path | A gate decision with `ask` parks the tool call in `askPermission` (AEP `permission.requested` with `allow-once`/`deny`); the panel answers with `POST /api/agent/permissions/:id {decision}` (`GET /api/agent/permissions?cwd=` lists what waits); an abort or 10 min of silence denies. The plain `edit`/`write` tools keep their M5 classes (Standard auto-accepts them) |
| Dirty-buffer rule | `ide-bridge/env.ts` (`IdeAwareExecutionEnv`, the env of `read`/`edit`/`write`/…): a file the IDE reports **open and dirty** (`ide.document.dirty`, kept in `context.dirty`) is read through `ide.readFile` and written through `ide.applyEdit` (whole-document replace), so the edit is based on the user's unsaved buffer and never clobbers it; the buffer stays dirty for the user to save. Any other file is read/written on disk as before (the IDE watcher picks it up). `<ide-context>` carries an `[unsaved]` line |
| Checkpoints | Before the first write of a turn (`before_tool`, class ≠ read — also when the gate then blocks it) the runtime snapshots the worktree with `@metactivity/runtime/git` under `refs/ace-ide/checkpoints/<piSessionId>/<n>` (tracked + untracked, throwaway index; HEAD, index and branch untouched) and emits AEP `checkpoint.created`; a folder without git gets an `ace.degraded {where: "checkpoint"}` journal note instead. `GET /api/agent/checkpoints?cwd=&sessionId=` → `{repo, checkpoints:[{n, commit, ref}], changed}` (paths changed since the last one), `POST /api/agent/checkpoints/revert {cwd, sessionId, n}` restores the whole snapshot (files created after it removed), `POST /api/agent/checkpoints/show {cwd, sessionId, path, mode: open\|diff, n?}` → `ide.openFile` / `ide.showDiff` (left = `git show <commit>:<path>`, right = the current file) |
| Panel | `frontend/src/features/ide/ide-changes-strip.tsx` under the chat pane: pending asks as Allow/Deny cards, the changed files with Open / Diff, Revert to checkpoint; polled every 2 s while a turn runs |

Tests: `test/ide-write.test.ts` (gate classes + ask registry, dirty → IDE / clean → disk routing, checkpoint
create/list/diff-content/revert over the HTTP surface, patch tool round trip against the fake extension, a scripted
turn whose `write` on a dirty buffer goes through `ide.applyEdit` and leaves one checkpoint ref).

### M7 — terminal / diagnostics / git (MET-930, packages 0.4.0)

| Piece | Behaviour |
| --- | --- |
| Terminal tool | `ide_run_terminal {command, name?, timeout?}` → `ide.runTerminal` on a `[tuum] <name>` terminal of the editor (one per name, reused; default `agent`). With shell integration the extension streams `ide.terminal.output {termId, chunk}` — fed to the tool result as progress — and returns the bounded tail + a first-hand exit code; the tool reads like `bash` (`Command exited with code N` on failure, a timeout error when the run outlives its budget — the command keeps running in the terminal). A terminal without shell integration only gets the command typed (`captured: false`): the result says so, and the folder is remembered as "no capture" so the `bash` re-route below stops for it. Gate class: the same command classifier as `bash` (`EXEC_TOOLS` in `ace-gate.ts`); **Standard asks** for a mutating command, exactly like local `bash` since MET-933 (before it, local `bash` was a hard block) |
| `bash` re-route | `tools/terminal-route.ts`: while an IDE with capture is connected for the folder, a `bash` call whose first real segment (after `cd …`, env assignments, `time`) is a test / build / run command — `bun\|npm\|pnpm\|yarn\|deno test\|run\|x\|exec\|check`, `bunx`, `npx`, `pytest`, `python -m pytest\|unittest`, `go test\|build\|vet\|run`, `make`, `cargo test\|build\|run\|check\|clippy\|bench`, `tsc`, `vitest`, `jest`, `mvn`, `gradle(w)`, `dotnet test\|build\|run` — runs through `ide.runTerminal` instead (`[tuum] tests`), with the gate decision already taken on the `bash` call; the result carries `[ran in the IDE terminal …]`. A bridge that goes away mid-turn falls back to local bash. Everything else stays `bash` |
| Registry | `ide-bridge/terminals.ts` keeps the runs per folder (last 50; name, command, session, exit code, `captured`, 64 KB tail) — `GET /api/agent/ide/terminals?cwd=&sessionId=` → `{runs}` |
| Tasks / git | `ide_run_task {name}` → `ide.runTask` (`{exitCode, problemsAfter}`, class exec-read), `ide_git_status {}` → `ide.git.status`, `ide_git_diff {path?, staged?}` → `ide.git.diff` (read) |
| Diagnostics | `ide-bridge/diagnostics.ts` (`turnDiagnostics`): after every write (`write`, `edit`, `ide_apply_edit`, `ide_create_file`) and after every run (`bash`, `ide_run_terminal`, `ide_run_task`, `ide_apply_patch`) the runtime pulls `ide.getDiagnostics` for the files the turn touched; at the end of the turn `AceHarnessOptions.phaseExtras` merges `diagnostics: [{file, errors, warnings}]` into the phase report (the IDE's pushed `ide.diagnostics.changed` summary wins over the pulled count when present), so `evaluateResult` (ace 0.4.0) flags a file left with errors. `ide_run_terminal` and the re-routed `bash` feed `validations` like local `bash` |
| Panel | The Changes strip shows `nE mW` beside each changed file (from `/api/agent/ide/context`) and one **Terminal** row per run (name · command, exit / running / timeout / no capture, the tail behind a toggle) |

Tests: `test/ide-terminal.test.ts` (classifier, gate classes incl. the Standard ask, terminal tool round trip against the
fake extension with streamed chunks / exit codes / no-capture memo, the `bash` re-route on and off, a scripted turn whose
phase report carries the validation verdict and the IDE's error count for the written file).

### M8 — what Local Studio no longer implements (MET-931)

The IDE is the workbench: nothing in the frontend or the runtime duplicates Code-OSS for files, git, terminal or
diff any more. `/agent` redirects to `/chat` (query params carry over: `?project=&session=&new=`); `/agent/automations`
and `/quick` stay. The IDE is one of two modes since MET-934 — see [Modes](#modes-met-934).

| Gone | Replaced by |
| --- | --- |
| Files pane (`filesystem-*`, file viewer, comments) + `GET /api/agent/fs`, `PUT /api/agent/fs/file`, `/api/agent/comments` | The explorer and editor; a file reference in the timeline opens through `POST /api/agent/checkpoints/show {mode: open}` (`ide.openFile`) |
| Review pane (`git-diff-*`), the composer's branch / diff-count / init-git widgets and branch / worktree switching, `git.ts`, `/api/agent/git*`, `/api/agent/pr*` (frontend) | The SCM view; the model has `ide_git_status` / `ide_git_diff` |
| xterm terminal (`terminal-panel`, `web-pty-bridge`, persistent terminal owners, the nav's Terminals section, `/terminal` slash command, terminal key-binding settings), `/api/agent/terminal*`, runtime `pty-service.ts` + `pty-handlers.ts`, `@lydell/node-pty` in the runtime, `@xterm/*` | The editor's terminal; the model has `ide_run_terminal` and the `bash` re-route (M7) |
| The `/agent` computer panel (status, tools launcher, side chat, browser tab) and the pane grid | The `/ide` right column: Chat, Browser (the embedded browser stays Local Studio-native), Context, Memory, ACE; a subagent row links to its session on `/ide` |

Still here on purpose: `GET /api/agent/fs/search` and `GET /api/agent/fs/file` (the composer's `@file` mention
picker), `GET /api/agent/fs/raw` (inline media in the timeline), `highlight-cache.ts` (code blocks in the timeline),
the harness `read` / `edit` / `grep` / `bash` tools (runtime tools, not UI), every `ide_*` tool, the runtime's
project branch lookup for the nav, and the Electron desktop's own pty manager (`frontend/desktop/logic/`).

## Modes (MET-934)

The IDE is one mode, not the mandatory one. `/chat` is the classic full-width workspace — composer, timeline,
queue strip, changes strip, with Browser / Context / Memory / ACE as a resizable right column and no workbench
iframe (no reh-web connection, no bridge session for that tab). `/ide` is the same components with the Code-OSS
workbench in the centre and the chat as a tab of the right column. Both routes share one `(workspace)` layout, so
the sessions, the running turn and its SSE subscription survive a mode switch; `/agent` redirects to `/chat`.

The mode is remembered per project (`shared/agent/agent-mode.ts`, localStorage `local-studio.agentMode.<id>`):
a bare `/chat` or `/ide` (nav rail, panel switch) is an explicit choice, a deep link (`?project=&session=&new=`)
reopens the project in its last mode, chat by default. In Chat mode the Context tab offers the switch, and a
file link in the timeline switches to IDE mode and opens the file once the bridge reports the folder connected
(`tuum:open-in-ide` window event, bounded 60 s wait). `ide_*` tools stay unregistered while no IDE is connected.

## Identity (ADR-034 M9)

Local Studio reads as Tuum from the Production Design Kit (Figma `AahVHwpjlIx6UpHyklf8Gw`); the kit governs colour,
type, icons, badges, motion and empty states — layouts stay Local Studio's.

| Piece | Where |
| --- | --- |
| Theme ids | `tuum-dark` (default), `tuum-light`, `tuum-hc` — `frontend/src/lib/themes-data.ts` (surfaces, inlined by the theme runtime) + the `:root[data-theme="tuum-*"]` blocks in `frontend/src/app/styles/globals/tokens.css` (accent-as-link, status hues, focus ring). `--radius-base` stays 10 px. |
| Identity strings | `frontend/src/lib/tuum-identity.ts` — name, title, favicon, empty-state copy, `tuumStudioTheme(themeId)` (LS id → Tuum Studio theme name). |
| Assets | `frontend/public/tuum/{brand,icons,illustrations,providers}` — committed copies of the kit exports vendored in the tuum checkout. Refresh with `scripts/sync-tuum-assets.sh [tuum-checkout]` (default `~/Work/Metactivity/tuum`). Never a Figma URL at runtime. |
| Components | `frontend/src/ui/tuum.tsx` (`TuumProviderBadge`, `TuumThinkingIndicator`, `TuumResponseAttribution`, `TuumStatusIndicator`, `TuumEmptyState`) and `frontend/src/ui/tuum-icon.tsx` (product icons as `currentColor` masks, symbol, wordmark). |
| Workbench theme hand-off | `/ide` boots the iframe with `?theme=<ls id>` and posts `{type: "tuum.theme", theme: "Tuum Dark" \| "Tuum Light" \| "Tuum High Contrast"}` (same origin) on every theme change. The `ace-agent` extension does not listen yet — M10 follow-up. |
| Keyboard scoping | Unchanged from M1: the shell ignores ⌘K / ⌘N while the iframe holds focus (`left-sidebar.tsx`). |

Every new string is English only: the frontend has no i18n mechanism (no FR bundle to feed).

## Environment

| Variable                                   | Default                                       | Role                                                                                                |
| ------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `LOCAL_STUDIO_AGENT_CORE`                  | —                                             | Deprecated, one release: any value other than `harness` logs a warning; the harness runs regardless |
| `ACE_RUNTIME_KIND`                         | `external`                                    | `external` (endpoints below) or `supervised` (ACE's own llama-server)                               |
| `ACE_CHAT_BASE_URL` / `ACE_EMBED_BASE_URL` | required for `external`                       | llama-server origins (`:8000` / `:8001` on the Spark)                                               |
| `ACE_API_KEY`                              | —                                             | bearer for both ACE role calls and user turns                                                       |
| `ACE_CHAT_MODEL` / `ACE_EMBED_MODEL`       | `spark-qwen38-27b-rvn-q8` / `qwen3-embedding` | served ids; the chat id selects the `ModelProfile`                                                  |
| `ACE_STORE_ROOT`                           | `<data dir>/ace-store`                        | ACE stores, router prototypes, `sessions.db`                                                        |
| `ACE_VEC_EXTENSION`                        | —                                             | sqlite-vec path (dense retrieval arm)                                                               |
| `ACE_PERMISSION_PROFILE`                   | `standard`                                    | `safe` / `standard` / `autonomous`                                                                  |
| `ACE_SESSION_STORE`                        | `sqlite`                                      | `jsonl` keeps the vendored JSONL repo                                                               |

## Degradation

| Failure                                | Effect                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Env incomplete / invalid               | `aceService()` is `null`; the harness runs without ACE; `aceStatus().problems` says why                |
| Runtime unreachable                    | ACE `degraded`: retrieval/graph/gate/compaction/reflection still run (local); router → `stage: "none"` |
| `prepareTask` / `classifyPrompt` throw | journaled as `ace.degraded`; turn continues without the context block                                  |
| Any hook handler throws                | journaled, skipped; the turn never fails because of a hook                                             |
| History summary fails                  | journaled; context left as is                                                                          |
| Compacted result rotated out           | `ace_retrieve_context` returns a tool error; the summary stays in context                              |

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
