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
import {
  type AgentMessage,
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
import { type AceHarness, createAceHarness, createDefaultTools, DEFAULT_SYSTEM_PROMPT } from "./ace/ace-harness";
import { aceService, readAceConfig } from "./ace/ace-service";
import type { ModelProfile } from "./harness/model-profile";
import { resolveModelProfile } from "./harness/model-profile";
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
import { builtinTools, type ToolContext, withAgentPolicy, withTimeoutPolicy } from "./tools";
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

let aceStart: Promise<unknown> | null = null;

/** The process-wide ACE service, started once; null when the environment does not describe one. */
async function startedAceService() {
  const ace = aceService();
  if (ace && aceStart === null) aceStart = ace.start().catch(() => undefined);
  if (aceStart) await aceStart;
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
    const tools = [
      ...withTimeoutPolicy(createDefaultTools(resolvedCwd, ace), env),
      ...(await builtinTools({ cwd: resolvedCwd, sessionId, modelId, env, request: this.#request, gates: sessionOptions.toolGates })),
    ];
    const executionEnv = new NodeExecutionEnv({ cwd: resolvedCwd });
    const { skills } = await loadSkills(executionEnv, sessionOptions.skills);
    const { promptTemplates } = await loadPromptTemplates(executionEnv, sessionOptions.promptTemplatePaths);
    const systemPrompt = withAgentPolicy(
      [DEFAULT_SYSTEM_PROMPT, ...(profile.vision ? [VISION_GUIDANCE] : []), ...(skills.length > 0 ? [formatSkillsForSystemPrompt(skills)] : [])].join(
        "\n\n",
      ),
    );

    const harness = await createAceHarness({
      cwd: resolvedCwd,
      sessionRepo: store.repo,
      model,
      models: createHarnessModels(model, endpoint.apiKey),
      profile,
      ace,
      thinkingLevel: level,
      systemPrompt,
      ...(startOptions.toolAccess === "read_only"
        ? { tools: tools.filter((tool) => tool.name === "read" || tool.name === "ace_retrieve_context") }
        : { tools }),
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

    const offLoop = harness.events.on("loop", (event) => this.onLoopEvent(event as PiEvent));
    const offJournal = harness.journal.subscribe((record) => {
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
    this.harness = harness;
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
