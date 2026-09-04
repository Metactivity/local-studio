// The agent core behind the runtime manager: the PiAgentSession contract the
// http handlers call, on the ACE-rooted vendored Agent (src/ace/ace-harness.ts)
// with the SQLite session store.
//
// Wire compatibility: the vendored loop already emits the pi event shapes the
// frontend renders (agent_start/end, message_start/update/end,
// tool_execution_*), so they go out untouched. This file adds the events the
// SSE and the UI rely on that the former pi-coding-agent driver synthesized —
// `agent_settled` (closes the stream), `queue_update` (steer / follow-up
// queue), and `compaction_end` (history summary) — and reports a turn failure
// as a `notice`. See docs/ace-harness.md, "Wire compatibility".

import { EventEmitter } from "node:events";
import { Effect } from "effect";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { NativeService } from "@metactivity/ace";
import {
  type AgentMessage,
  type AgentTool,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  formatSkillsForSystemPrompt,
  loadPromptTemplates,
  loadSkills,
  parseCommandArgs,
  type PromptTemplate,
  shouldCompact,
  substituteArgs,
  type ThinkingLevel,
  uuidv7,
} from "@local-studio/harness";
import { NodeExecutionEnv } from "@local-studio/harness/node";
import { type AceHarness, type AfterToolEvent, type BeforeToolEvent, createAceHarness, createDefaultTools, createRetrieveContextTool, DEFAULT_SYSTEM_PROMPT, GENERAL_SYSTEM_PROMPT } from "./ace/ace-harness";
import type { AnyJournalRecord } from "./ace/ace-journal";
import { aceService, readAceConfig } from "./ace/ace-service";
import { bootstrapGraphOnce, startGraphMaintenance } from "./ace/ace-graph-bootstrap";
import type { ModelProfile } from "./harness/model-profile";
import { resolveModelProfile } from "./harness/model-profile";
import { formatProjectContext, loadProjectContextFiles } from "./harness/context-files";
import { createHarnessModel, createHarnessModels } from "./harness/spark-model";
import { goalSystemContext } from "./goal-prompt";
import { harnessSessions, harnessStoreRoot } from "./harness-sessions";
import { getGlobalSingleton } from "./instances";
import {
  buildAgentSessionOptionsSync,
  comparableQueuedText,
  planQueuedFollowUpMutation,
  resolveAgentCwdEffect,
  runtimeOptionsFingerprint,
  type RuntimeStartOptions,
} from "./pi-runtime-helpers";
import { refreshPiModels, selectPiRuntimeModel, toPiThinkingLevel } from "./pi-runtime-models";
import { notifySessionListChanged } from "./session-list-changed";
import { getApiSettings } from "./settings-service";
import { resolvePiAgentDir } from "./user-plugins";
import { classifyToolAccess } from "./ace/ace-gate";
import { createTurnCheckpoint } from "./ide-bridge/checkpoints";
import { ideContextBlock } from "./ide-bridge/context";
import { turnDiagnostics } from "./ide-bridge/diagnostics";
import { IdeAwareExecutionEnv } from "./ide-bridge/env";
import { resolveDataDir } from "./data-dir";
import { ideBridge } from "./ide-bridge/server";
import { canonicalDirectory } from "./projects-store";
import { builtinTools, type ToolContext, withAgentPolicy, withTimeoutPolicy } from "./tools";
import { ideTools } from "./tools/ide";
import { withTerminalRoute } from "./tools/terminal-route";
import type { AgentImageInput } from "../../../shared/agent/agent-image-input";
import type { AgentQueueAction } from "../../../shared/agent/agent-turn";
import type { RuntimeContextUsage } from "../../../shared/agent/context-usage";

export type { RuntimeStartOptions };

// The event surface the rest of the app sees. Consumers duck-type on string
// event names (`sessions/engine.ts`, `pane-controller.ts`, …), hence the loose
// index signature.
type PiEvent = Record<string, unknown> & { type?: string };

export type LoggedPiEvent = {
  seq: number;
  event: PiEvent;
  timestamp: string;
};

export type PiPromptOptions = {
  streamingBehavior?: "steer" | "followUp";
  images?: AgentImageInput[];
};

export type PiAgentStatus = {
  running: boolean;
  active: boolean;
  modelId: string;
  cwd: string;
  piSessionId: string | null;
  agentDir: string;
  eventSeq: number;
  lastError: string | null;
  contextUsage: RuntimeContextUsage | null;
};

/** The session contract the http handlers, the goal driver and the scheduler drive. */
export interface PiAgentSession {
  ensureStarted(
    modelId: string,
    cwd?: string,
    piSessionId?: string | null,
    options?: RuntimeStartOptions,
  ): Promise<void>;
  prompt(
    message: string,
    onEvent: (event: PiEvent, seq: number) => void,
    options?: PiPromptOptions,
  ): Promise<void>;
  steer(message: string, images?: AgentImageInput[]): Promise<void>;
  mutateQueuedFollowUp(
    message: string,
    action: AgentQueueAction,
    replacement?: string,
    images?: AgentImageInput[],
  ): Promise<void>;
  followUp(message: string, images?: AgentImageInput[]): Promise<void>;
  /** Resolves with the messages that were still queued, so the caller can
   *  restore them rather than losing them to the stop. */
  abort(): Promise<{ steering: string[]; followUp: string[] }>;
  compact(customInstructions?: string): Promise<unknown>;
  stop(): Promise<void>;
  readonly status: PiAgentStatus;
  getEventsAfter(seq: number): LoggedPiEvent[];
  onLoggedEvent(listener: (event: LoggedPiEvent) => void): () => void;
  adoptPiSessionId(piSessionId: string | null | undefined): void;
}

const EVENT_LOG_CAP = 2_000;

/** Appended for vision-capable models, same wording as the pi driver. */
const VISION_GUIDANCE =
  "When an image is attached, inspect it carefully before answering. State only details visible in the image. Never invent labels, UI elements, text, or facts. Say when details are too small or uncertain. Give a concise answer. Use available tools to inspect supplied files when helpful.";

/** The pi driver's read-only set (read/grep/find/ls) plus ACE's retrieval tool. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "ace_retrieve_context"]);

export interface HarnessEndpoint {
  /** The id the server expects in the request body. */
  servedId: string;
  baseUrl: string;
  apiKey: string | undefined;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Where a composer model id is served: the controller that listed it, or the
 * ACE llama-server when the id is not in the list. The bearer follows the
 * origin — the ACE key for the ACE endpoint, the settings key for the primary
 * controller.
 */
export async function resolveHarnessEndpoint(modelId: string): Promise<HarnessEndpoint> {
  const ace = readAceConfig().config;
  const settings = await getApiSettings();
  const { models } = await refreshPiModels().catch(() => ({ models: [] }));
  const selected = selectPiRuntimeModel(models, modelId);
  const baseUrl = selected?.controllerUrl ?? ace?.chatBaseUrl;
  if (!baseUrl) {
    throw new Error(`Model '${modelId}' is not available from /v1/models and ACE_CHAT_BASE_URL is not set.`);
  }
  const apiKey =
    ace && sameOrigin(baseUrl, ace.chatBaseUrl)
      ? ace.apiKey
      : sameOrigin(baseUrl, settings.backendUrl)
        ? settings.apiKey || undefined
        : undefined;
  return { servedId: selected?.rawId ?? selected?.id ?? modelId, baseUrl, apiKey };
}

let aceStart: { service: NativeService; started: Promise<unknown> } | null = null;
let workspaceWatch: (() => void) | null = null;

/** The IDE opened another folder (`ide.workspace.changed`): its graph gets the same first-session bootstrap. */
export function watchWorkspaceChanges(): void {
  workspaceWatch ??= ideBridge().subscribe((_folder, method, params) => {
    const folder = (params as { folder?: unknown } | null)?.folder;
    if (method !== "ide.workspace.changed" || typeof folder !== "string" || !folder) return;
    void startedAceService().then((ace) => ace && bootstrapGraphOnce(ace, folder));
  });
}

/** The process-wide ACE service, started once per instance; null when the environment does not describe one. */
export async function startedAceService(): Promise<NativeService | null> {
  const ace = aceService();
  if (ace && aceStart?.service !== ace) aceStart = { service: ace, started: ace.start().catch(() => undefined) };
  if (ace) await aceStart!.started;
  return ace;
}

/**
 * The built-in tools reach the runtime's own routes (automations, subagents,
 * connectors, browser host) in process: the pi extensions went through the
 * frontend proxy to the same handlers. Imported lazily — http/app sits on the
 * pi-runtime graph, which imports this module behind the core flag.
 */
async function requestRuntime(path: string, init?: RequestInit): Promise<Response> {
  const app = await getGlobalSingleton("harnessToolsApp", async () => (await import("./http/app")).createAgentRuntimeApp().app);
  const headers = new Headers(init?.headers);
  headers.set("host", "127.0.0.1");
  return app.request(path, { ...init, headers });
}

export interface HarnessSessionOptions {
  /** Test seam: where a model id is served. Default: `resolveHarnessEndpoint`. */
  resolveEndpoint?: (modelId: string) => Promise<HarnessEndpoint>;
  /** Test seam: the runtime's HTTP surface the built-in tools call. Default: in process. */
  request?: ToolContext["request"];
}

function userMessage(text: string, images: AgentImageInput[] = []): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }, ...(images as ImageContent[])],
    timestamp: Date.now(),
  };
}

/**
 * Same rule as pi's `expandPromptTemplate`: a message that is exactly
 * `/name [args]` becomes the template body with `$1`, `$@`, `$ARGUMENTS`
 * substituted; anything else is sent as typed.
 */
export function expandPromptTemplate(text: string, templates: readonly PromptTemplate[]): string {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  const template = match ? templates.find((candidate) => candidate.name === match[1]) : undefined;
  return template ? substituteArgs(template.content, parseCommandArgs(match![2] ?? "")) : text;
}

function textOf(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

export class HarnessSession extends EventEmitter implements PiAgentSession {
  readonly #resolveEndpoint: (modelId: string) => Promise<HarnessEndpoint>;
  readonly #request: ToolContext["request"];
  private harness: AceHarness | null = null;
  private unsubscribe: (() => void) | null = null;
  private profile: ModelProfile | null = null;
  private eventSeq = 0;
  private eventLog: LoggedPiEvent[] = [];
  private activePromptCount = 0;
  private lastError: string | null = null;
  private currentFingerprint = "";
  private currentModelId = "";
  private currentCwd = "";
  private currentSessionId: string | null = null;
  private currentStartOptions: RuntimeStartOptions = {};
  private manualCompaction = false;
  /** The composer's selected prompt templates, loaded once per session start like pi did. */
  private promptTemplates: PromptTemplate[] = [];
  /** Texts waiting in the Agent's queues, in order — the Agent does not expose them. */
  private queued: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  /** The session's tools without the IDE ones; `ide_*` join per turn while an IDE is connected for the folder. */
  private baseTools: AgentTool[] = [];
  /** The turn that already has its checkpoint (or its "no git" note). */
  private checkpointTurnId: string | null = null;
  /** Releases this session's hold on the folder's graph maintenance (ace-graph-bootstrap.ts). */
  private releaseGraph: (() => void) | null = null;

  constructor(options: HarnessSessionOptions = {}) {
    super();
    this.#resolveEndpoint = options.resolveEndpoint ?? resolveHarnessEndpoint;
    this.#request = options.request ?? requestRuntime;
  }

  async ensureStarted(
    modelId: string,
    cwd?: string,
    piSessionId?: string | null,
    options?: RuntimeStartOptions,
  ): Promise<void> {
    const startOptions = structuredClone(options ?? (this.harness ? this.currentStartOptions : {}));
    const resolvedCwd = await Effect.runPromise(resolveAgentCwdEffect(cwd));
    const wantedSessionId = piSessionId?.trim() || null;
    const fingerprint = JSON.stringify({
      modelId,
      cwd: resolvedCwd,
      sessionId: wantedSessionId ?? "",
      options: runtimeOptionsFingerprint(startOptions),
    });
    if (this.harness && this.currentFingerprint === fingerprint) return;

    await this.stop();
    this.eventSeq = 0;
    this.eventLog = [];
    this.activePromptCount = 0;
    this.lastError = null;

    const endpoint = await this.#resolveEndpoint(modelId);
    const profile = resolveModelProfile(endpoint.servedId);
    const model = createHarnessModel({ id: endpoint.servedId, baseUrl: endpoint.baseUrl, profile });
    const ace = await startedAceService();
    const store = harnessSessions();
    const session = wantedSessionId
      ? await store.repo.open({ id: wantedSessionId, createdAt: 0 }).catch(() => undefined)
      : undefined;
    // Known before the harness exists: the subagent tools attribute their children to it.
    const sessionId = session ? (await session.getMetadata()).id : uuidv7();
    const level = toPiThinkingLevel(startOptions.thinkingLevel ?? "high") as ThinkingLevel;

    // Same gates, skill directories and env the pi driver hands its extensions.
    const sessionOptions = buildAgentSessionOptionsSync({ options: startOptions, cwd: resolvedCwd });
    const env = { ...process.env, ...sessionOptions.envInjections };
    // The runtime data dir is the "Chats" scope (MET-934): a general assistant with no project, so no
    // file tools and no workspace framing; browser, connectors, skills and ACE memory stay.
    const general = resolvedCwd === canonicalDirectory(resolveDataDir());
    const tools = [
      ...(general
        ? ace
          ? [createRetrieveContextTool(ace, resolvedCwd)]
          : []
        : // Files open and dirty in the IDE are read and written through the editor (ADR-034 M6, ide-bridge/env.ts);
          // test / build / run commands go to the IDE terminal while one is connected (M7, tools/terminal-route.ts).
          withTerminalRoute(withTimeoutPolicy(createDefaultTools(resolvedCwd, ace, new IdeAwareExecutionEnv({ cwd: resolvedCwd })), env), {
            cwd: resolvedCwd,
            sessionId,
            env,
            bridge: ideBridge(),
          })),
      ...(await builtinTools({ cwd: resolvedCwd, sessionId, modelId, env, request: this.#request, gates: sessionOptions.toolGates })),
    ];
    const executionEnv = new NodeExecutionEnv({ cwd: resolvedCwd });
    const { skills } = await loadSkills(executionEnv, sessionOptions.skills);
    const { promptTemplates } = await loadPromptTemplates(executionEnv, sessionOptions.promptTemplatePaths);
    // Same order as pi's system prompt: base, project context files, skills, then the policy; cwd last.
    const projectContext = general ? "" : formatProjectContext(loadProjectContextFiles(resolvedCwd, resolvePiAgentDir()));
    const systemPrompt = withAgentPolicy(
      [
        general ? GENERAL_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT,
        ...(profile.vision ? [VISION_GUIDANCE] : []),
        ...(projectContext ? [projectContext] : []),
        ...(skills.length > 0 ? [formatSkillsForSystemPrompt(skills)] : []),
        ...(general ? [] : [`Current working directory: ${resolvedCwd.replace(/\\/g, "/")}`]),
      ].join("\n\n"),
    );

    // The IDE's diagnostics for the files this turn touched ride into the phase report (M7).
    const diagnostics = turnDiagnostics(resolvedCwd);
    const harness = await createAceHarness({
      cwd: resolvedCwd,
      sessionRepo: store.repo,
      model,
      models: createHarnessModels(model, endpoint.apiKey),
      profile,
      ace,
      thinkingLevel: level,
      systemPrompt,
      phaseExtras: diagnostics.phaseExtras,
      ...(startOptions.toolAccess === "read_only" ? { tools: tools.filter((tool) => READ_ONLY_TOOLS.has(tool.name)) } : { tools }),
      ...(session ? { session } : { sessionId }),
    });
    if (!session) {
      // The header the session list and the frontend fold read the model from.
      await harness.session.appendEntry(
        { type: "model_change", id: uuidv7(), provider: model.provider, modelId: endpoint.servedId },
        "main",
      );
    }

    // The session goal steers every turn, including the ones the user types, and
    // is re-read per turn so a mid-session edit lands on the next prompt.
    harness.hooks.on(
      "transform_context",
      () => {
        const section = goalSystemContext(sessionId);
        return section ? { systemContext: [section] } : undefined;
      },
      { id: "local-studio-goal" },
    );
    // The IDE's latest state (ADR-034 M5) rides beside <ace-context>; nothing when no IDE is connected.
    harness.hooks.on(
      "transform_context",
      () => {
        const context = ideBridge().context(resolvedCwd);
        const block = context ? ideContextBlock(context, resolvedCwd) : null;
        return block ? { systemContext: [block] } : undefined;
      },
      { id: "local-studio-ide" },
    );

    // One git checkpoint per turn, before its first write (ADR-034 M6); a folder without git is journaled once per turn.
    harness.hooks.on(
      "before_tool",
      (raw) => {
        const event = raw as BeforeToolEvent;
        if (this.checkpointTurnId === event.turnId || classifyToolAccess(event.toolCall.name, event.args) === "read") return;
        this.checkpointTurnId = event.turnId;
        const checkpoint = createTurnCheckpoint(resolvedCwd, sessionId, `turn ${event.turnId} before ${event.toolCall.name}`);
        if (checkpoint) harness.aep.emit("checkpoint.created", { checkpointId: checkpoint.id, label: checkpoint.label, gitRef: checkpoint.ref }, event.turnId);
        else harness.journal.push(event.turnId, "ace.degraded", { where: "checkpoint", error: `${resolvedCwd} is not a git repository — no checkpoint for this turn` });
      },
      { id: "local-studio-checkpoint" },
    );

    harness.hooks.on("after_tool", (raw) => diagnostics.afterTool(raw as AfterToolEvent), { id: "local-studio-diagnostics" });

    const offLoop = harness.events.on("loop", (event) => this.onLoopEvent(event as PiEvent));
    const offJournal = harness.journal.subscribe((record) => {
      // A gate block or a user denial is a visible timeline notice (MET-933); a pending ask has its own card.
      if (record.type === "ace.gate" && !record.payload.decision.allow && !record.payload.decision.ask) {
        this.recordEvent({ type: "notice", level: "warn", message: `${record.payload.toolName}: ${record.payload.decision.reason}` });
      }
      if (record.type !== "ace.history-compaction") return;
      this.recordEvent({
        type: "compaction_end",
        reason: this.manualCompaction ? "manual" : "threshold",
        result: { summary: record.payload.summary, tokensBefore: record.payload.tokensBefore },
        aborted: false,
        willRetry: false,
      });
    });
    this.unsubscribe = () => {
      offLoop();
      offJournal();
    };
    if (ace) {
      this.releaseGraph = startGraphMaintenance(ace, resolvedCwd, {
        onBootstrap: (record) => harness.journal.push("boot", "ace.graph.bootstrap", record),
        onError: (where, error) => harness.journal.push("boot", "ace.degraded", { where: `graph-${where}`, error: error instanceof Error ? error.message : String(error) }),
      });
    }
    this.harness = harness;
    this.baseTools = harness.agent.state.tools;
    this.profile = profile;
    this.promptTemplates = promptTemplates;
    this.currentModelId = modelId;
    this.currentCwd = resolvedCwd;
    this.currentSessionId = sessionId;
    this.currentFingerprint = fingerprint;
    this.currentStartOptions = startOptions;
  }

  private onLoopEvent(event: PiEvent): void {
    // A queued message the Agent just injected leaves the queue.
    if (event.type === "message_start") {
      const message = (event as { message?: AgentMessage }).message;
      if (message?.role === "user" && this.dequeue(textOf(message))) this.recordQueueUpdate();
    }
    this.recordEvent(event);
  }

  private dequeue(text: string): boolean {
    const target = comparableQueuedText(text);
    for (const queue of [this.queued.steering, this.queued.followUp]) {
      const index = queue.findIndex((candidate) => comparableQueuedText(candidate) === target);
      if (index >= 0) {
        queue.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  async prompt(
    text: string,
    onEvent: (event: PiEvent, seq: number) => void,
    options: PiPromptOptions = {},
  ): Promise<void> {
    const listener = (logged: LoggedPiEvent) => onEvent(logged.event, logged.seq);
    this.on("loggedEvent", listener);
    try {
      const harness = this.requireHarness();
      const message = expandPromptTemplate(text, this.promptTemplates);
      if (this.status.active) {
        // Same as pi: a prompt during a run is queued, steering unless told otherwise.
        if (options.streamingBehavior === "followUp") await this.followUp(message, options.images);
        else await this.steer(message, options.images);
        return;
      }
      this.activePromptCount += 1;
      this.lastError = null;
      harness.agent.state.tools = this.toolsForTurn();
      try {
        await harness.prompt(message, options.images ? { images: options.images as ImageContent[] } : {});
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.recordEvent({ type: "notice", level: "error", message: this.lastError });
        throw error;
      } finally {
        this.activePromptCount = Math.max(0, this.activePromptCount - 1);
        this.recordEvent({ type: "agent_settled" });
        notifySessionListChanged();
      }
    } finally {
      this.off("loggedEvent", listener);
    }
  }

  async steer(message: string, images: AgentImageInput[] = []): Promise<void> {
    this.requireHarness().agent.steer(userMessage(message, images));
    this.queued.steering.push(message);
    this.recordQueueUpdate();
  }

  async followUp(message: string, images: AgentImageInput[] = []): Promise<void> {
    this.requireHarness().agent.followUp(userMessage(message, images));
    this.queued.followUp.push(message);
    this.recordQueueUpdate();
  }

  async mutateQueuedFollowUp(
    message: string,
    action: AgentQueueAction,
    replacement?: string,
    images: AgentImageInput[] = [],
  ): Promise<void> {
    const { agent } = this.requireHarness();
    const mutation = planQueuedFollowUpMutation(this.queued.followUp, message, action, replacement);
    if (!mutation) throw new Error("Queued follow-up is no longer pending.");
    agent.clearFollowUpQueue();
    this.queued.followUp = [];
    if (mutation.promoted) {
      agent.steer(userMessage(mutation.promoted, images));
      this.queued.steering.push(mutation.promoted);
    }
    for (const queued of mutation.followUp) {
      agent.followUp(userMessage(queued));
      this.queued.followUp.push(queued);
    }
    this.recordQueueUpdate();
  }

  adoptPiSessionId(piSessionId: string | null | undefined): void {
    const next = piSessionId?.trim();
    if (next && !this.currentSessionId) this.currentSessionId = next;
  }

  /** The base tools, plus the `ide_*` actions while an IDE is connected for this folder (like the chrome probe, per turn). */
  private toolsForTurn(): AgentTool[] {
    if (this.currentStartOptions.toolAccess === "read_only" || !ideBridge().isConnected(this.currentCwd)) return this.baseTools;
    return [...this.baseTools, ...ideTools(this.currentCwd, ideBridge(), { sessionId: this.currentSessionId ?? "", env: process.env })];
  }

  /** What ACE did to this session's turns (router, lens, gates, compaction, evaluation) — the Context Lens source. */
  aceJournal(): AnyJournalRecord[] {
    return this.harness?.journal.records() ?? [];
  }

  async compact(customInstructions?: string): Promise<unknown> {
    if (this.status.active) throw new Error("Cannot compact while the agent is running.");
    this.manualCompaction = true;
    try {
      const summary = await this.requireHarness().compact(customInstructions);
      return summary === null ? null : { summary };
    } finally {
      this.manualCompaction = false;
    }
  }

  /** Stop the run and hand back what was still queued, so the client can restore it. */
  async abort(): Promise<{ steering: string[]; followUp: string[] }> {
    const cleared = { steering: [...this.queued.steering], followUp: [...this.queued.followUp] };
    const harness = this.harness;
    if (!harness) return cleared;
    harness.agent.clearAllQueues();
    this.queued = { steering: [], followUp: [] };
    harness.agent.abort();
    await harness.agent.waitForIdle().catch(() => undefined);
    this.recordQueueUpdate();
    return cleared;
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.releaseGraph?.();
    this.releaseGraph = null;
    const harness = this.harness;
    this.harness = null;
    this.queued = { steering: [], followUp: [] };
    if (harness) await harness.close().catch(() => undefined);
  }

  get status(): PiAgentStatus {
    const agent = this.harness?.agent;
    return {
      running: this.harness !== null,
      active: this.activePromptCount > 0 || Boolean(agent?.state.isStreaming) || Boolean(agent?.hasQueuedMessages()),
      modelId: this.currentModelId,
      cwd: this.currentCwd,
      piSessionId: this.currentSessionId,
      agentDir: harnessStoreRoot(),
      eventSeq: this.eventSeq,
      lastError: this.lastError,
      contextUsage: this.computeContextUsage(),
    };
  }

  private computeContextUsage() {
    if (!this.harness || !this.profile) return null;
    const { tokens } = estimateContextTokens(this.harness.agent.state.messages);
    const contextWindow = this.profile.contextWindow;
    return {
      tokens,
      contextWindow,
      percent: contextWindow > 0 ? Math.round((tokens / contextWindow) * 1000) / 10 : null,
      shouldCompact: contextWindow > 0 && shouldCompact(tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS),
    };
  }

  getEventsAfter(seq: number): LoggedPiEvent[] {
    const floor = Number.isFinite(seq) ? Math.max(0, Math.trunc(seq)) : 0;
    return this.eventLog.filter((entry) => entry.seq > floor);
  }

  onLoggedEvent(listener: (event: LoggedPiEvent) => void): () => void {
    this.on("loggedEvent", listener);
    return () => this.off("loggedEvent", listener);
  }

  private requireHarness(): AceHarness {
    if (!this.harness) throw new Error("harness session is not running");
    return this.harness;
  }

  private recordQueueUpdate(): void {
    this.recordEvent({ type: "queue_update", steering: [...this.queued.steering], followUp: [...this.queued.followUp] });
  }

  private recordEvent(event: PiEvent): void {
    const logged: LoggedPiEvent = { seq: ++this.eventSeq, event, timestamp: new Date().toISOString() };
    this.eventLog.push(logged);
    if (this.eventLog.length > EVENT_LOG_CAP) this.eventLog.splice(0, this.eventLog.length - EVENT_LOG_CAP);
    this.emit("loggedEvent", logged);
    this.emit("event", event);
  }
}
