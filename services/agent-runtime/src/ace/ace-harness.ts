// ACE rooted in the harness (ADR-033 §2.4). The vendored `AgentHarness`
// class is still a scaffold at 0.84.3 (its `hooks.on` throws
// HarnessNotImplemented), so the loop underneath is the vendored `Agent`, and
// the `Hooks` registry — same `HookName` vocabulary — is owned here and wired
// onto the Agent's real interception points. ACE registers through that
// registry like any other subscriber; nothing about it is special-cased in
// the loop.
//
// Hook map (name → Agent seam → ACE handler):
//   before_run         prompt()                       —
//   transform_context  prompt(), before the request   classifyPrompt + prepareTask → system context, lens, markConsulted
//   before_payload     Agent.onPayload                —
//   after_response     Agent.onResponse               —
//   before_tool        Agent.beforeToolCall           permission gate + safety gates + tool-loop guard
//   after_tool         Agent.afterToolCall            observeAgentEvent + tool-result compaction (≥ COMPACTION_MIN_CHARS)
//   before_compaction  Agent.prepareNextTurn          — (fires before the harness history summary)
//   before_run_end     after agent_end                evaluateResult + reflectAndFile (+ router veto)
//   before_resume / before_request / before_navigation: accepted, not wired (no seam in Agent yet).

import type { Api, ImageContent, Model, Models } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  Agent,
  type AgentEvent as LoopEvent,
  type AgentHarnessTool,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  buildSessionContext,
  type CompactionEntry,
  type CompactionPreparation,
  type CompactionSettings,
  compact,
  type ExecutionEnv,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_COMPACTION_SETTINGS,
  type Events,
  estimateContextTokens,
  type ExecutionToolContext,
  type HookName,
  type Hooks,
  type PrepareNextTurnContext,
  prepareCompaction,
  type Session,
  shouldCompact,
  type ThinkingLevel,
  uuidv7,
} from "@local-studio/harness";
import { NodeExecutionEnv } from "@local-studio/harness/node";
import {
  type AceEvaluation,
  type AcePhaseReport,
  type AceTaskPreparation,
  COMPACTION_MIN_CHARS,
  compactToolResult,
  type NativeService,
  type PreparationLens,
  type RouterClass,
  type RouterVerdict,
} from "@metactivity/ace";
import type { ModelProfile } from "../harness/model-profile";
import { askPermission, createToolLoopGuard, decideToolCall, loadProjectRules, type PermissionProfile, readPermissionProfile } from "./ace-gate";
import { AceJournal, type JournalRecord } from "./ace-journal";
import { observationOf, phaseReport, textOf } from "./ace-phase";
import { aceService } from "./ace-service";
import type { HarnessSessionRepo } from "./sqlite-session-repo";
import { AepProjector, projectLoopEvent } from "./aep";

export { COMPACTION_MIN_CHARS };

// ---------------------------------------------------------------------------
// Hooks / events registries
// ---------------------------------------------------------------------------

type HookHandler = (event: unknown) => unknown | Promise<unknown>;

export interface BeforeRunEvent {
  turnId: string;
  prompt: string;
  forcedClass?: RouterClass;
}
export interface TransformContextEvent {
  turnId: string;
  prompt: string;
  messages: AgentMessage[];
}
/** What a transform_context handler may return: leading system entries and/or a replacement transcript. */
export interface TransformContextResult {
  systemContext?: string[];
  messages?: AgentMessage[];
}
export type BeforeToolEvent = BeforeToolCallContext & { turnId: string };
export type AfterToolEvent = AfterToolCallContext & { turnId: string };
export interface BeforeCompactionEvent {
  turnId: string;
  tokens: number;
  contextWindow: number;
  preparation: CompactionPreparation;
}
export interface BeforeRunEndEvent {
  turnId: string;
  prompt: string;
  messages: AgentMessage[];
  stopReason: string;
  phase: AcePhaseReport;
}

class HookRegistry implements Hooks {
  readonly #handlers = new Map<HookName, { id?: string; handler: HookHandler }[]>();
  readonly #onError: (name: HookName, error: unknown) => void;

  constructor(onError: (name: HookName, error: unknown) => void) {
    this.#onError = onError;
  }

  on(name: HookName, handler: HookHandler, options?: { id?: string }): () => void {
    const list = this.#handlers.get(name) ?? [];
    const entry = { ...(options?.id !== undefined ? { id: options.id } : {}), handler };
    list.push(entry);
    this.#handlers.set(name, list);
    return () => {
      const current = this.#handlers.get(name) ?? [];
      this.#handlers.set(
        name,
        current.filter((candidate) => candidate !== entry),
      );
    };
  }

  /** Runs handlers in registration order; a throwing handler is reported and skipped — hooks never break a turn. */
  async run<T>(name: HookName, event: unknown): Promise<T[]> {
    const results: T[] = [];
    for (const { handler } of this.#handlers.get(name) ?? []) {
      try {
        const result = await handler(event);
        if (result !== undefined) results.push(result as T);
      } catch (error) {
        this.#onError(name, error);
      }
    }
    return results;
  }
}

export type HarnessEventType = "loop" | "aep" | "journal";

class EventBus implements Events {
  readonly #listeners = new Map<string, Set<(event: unknown) => void | Promise<void>>>();

  on(type: string, listener: (event: unknown) => void | Promise<void>): () => void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
    return () => set.delete(listener);
  }

  emit(type: HarnessEventType, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) void listener(event);
  }
}

// ---------------------------------------------------------------------------
// Options / results
// ---------------------------------------------------------------------------

export interface AceHarnessOptions {
  cwd: string;
  sessionRepo: HarnessSessionRepo;
  model: Model<Api>;
  /** Supplies `streamSimple` (user turns) and `completeSimple` (history summaries). */
  models: Models;
  profile: ModelProfile;
  /** Default: the process-wide service from the environment; `null` runs without ACE. */
  ace?: NativeService | null;
  /** Default: the vendored read/grep/find/ls/write/edit/bash bound to `cwd`, plus `ace_retrieve_context`. */
  tools?: AgentTool[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  permissionProfile?: PermissionProfile;
  compaction?: CompactionSettings;
  /** Provider request timeout for user turns. Default 10 min — local models write long answers. */
  streamTimeoutMs?: number;
  sessionId?: string;
  /** Resume an already-open session instead of creating one; its branch seeds the transcript. */
  session?: Session;
  /** Facts the transcript cannot carry (M7: the IDE's diagnostics), merged into the phase report before `before_run_end`. */
  phaseExtras?: (turnId: string) => Partial<AcePhaseReport>;
}

export interface TurnOptions {
  images?: ImageContent[];
  /** The user forced a router class; a mismatch with the verdict is recorded as a veto. */
  forcedClass?: RouterClass;
}

export interface TurnResult {
  turnId: string;
  stopReason: string;
  text: string;
  errorMessage?: string;
  verdict: RouterVerdict | null;
  lens: PreparationLens | null;
  gates: JournalRecord<"ace.gate">[];
  compactions: JournalRecord<"ace.compaction">[];
  evaluation: AceEvaluation | null;
  reflection: { proposals: number; new: number } | null;
}

export interface AceHarness {
  readonly hooks: Hooks;
  readonly events: Events;
  readonly agent: Agent;
  readonly session: Session;
  readonly journal: AceJournal;
  readonly aep: AepProjector;
  prompt(text: string, options?: TurnOptions): Promise<TurnResult>;
  /** Manual history compaction; resolves with the summary, or null when there was nothing to compact. */
  compact(customInstructions?: string): Promise<string | null>;
  close(): Promise<void>;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a coding agent working in the user's project directory. Use the tools to read, edit and run; be precise and brief.";
const DEFAULT_STREAM_TIMEOUT_MS = 600_000;
const BULLET_ID = /^\[([^\]]+)\]/;

function bindTool<TContext extends object>(tool: AgentHarnessTool<TContext, any, any>, context: TContext): AgentTool {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate, context),
  } as AgentTool;
}

export function createDefaultTools(cwd: string, ace: NativeService | null, env: ExecutionEnv = new NodeExecutionEnv({ cwd })): AgentTool[] {
  const context: ExecutionToolContext = { env };
  const tools = [
    bindTool(createReadTool(), context),
    bindTool(createGrepTool(), context),
    bindTool(createFindTool(), context),
    bindTool(createLsTool(), context),
    bindTool(createWriteTool(), context),
    bindTool(createEditTool(), context),
    bindTool(createBashTool(), context),
  ];
  if (ace !== null) tools.push(createRetrieveContextTool(ace, cwd));
  return tools;
}

const retrieveSchema = Type.Object({
  id: Type.String({ description: "The retrieval id printed at the end of a compacted tool result" }),
});

export function createRetrieveContextTool(ace: NativeService, cwd: string): AgentTool<typeof retrieveSchema> {
  return {
    name: "ace_retrieve_context",
    label: "ACE retrieve",
    description:
      "Return the full, verbatim text of a tool result that ACE compacted. Only use it when the compacted summary lacks a detail you need.",
    parameters: retrieveSchema,
    async execute(_toolCallId, { id }) {
      const text = await ace.retrieveToolResult(cwd, id);
      if (text === null) throw new Error(`ACE has no stored result for id ${id} (unknown or rotated out)`);
      return { content: [{ type: "text", text }], details: { id, chars: text.length } };
    },
  };
}

function contextBlock(preparation: AceTaskPreparation): string | null {
  const { context } = preparation;
  if (context.items.length === 0 && context.constraints.length === 0 && context.relevant_files.length === 0) return null;
  const lines = ["<ace-context>", ...context.items.map((item) => `- [${item.kind}] ${item.content}`)];
  if (context.constraints.length > 0) lines.push(...context.constraints.map((constraint) => `- [constraint] ${constraint}`));
  if (context.relevant_files.length > 0) lines.push(`- [files] ${context.relevant_files.join(", ")}`);
  lines.push("</ace-context>");
  return lines.join("\n");
}

function bulletIds(preparation: AceTaskPreparation): string[] {
  return preparation.context.items
    .filter((item) => item.kind === "playbook")
    .map((item) => BULLET_ID.exec(item.content)?.[1])
    .filter((id): id is string => id !== undefined);
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export async function createAceHarness(options: AceHarnessOptions): Promise<AceHarness> {
  const { cwd, model, models, profile } = options;
  const ace = options.ace === undefined ? aceService() : options.ace;
  const permissionProfile = options.permissionProfile ?? readPermissionProfile();
  const compaction = options.compaction ?? DEFAULT_COMPACTION_SETTINGS;
  const baseSystemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const streamTimeoutMs = options.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

  const session =
    options.session ?? (await options.sessionRepo.create({ cwd, ...(options.sessionId ? { id: options.sessionId } : {}) }));
  const sessionId = (await session.getMetadata()).id;
  const branchMessages = async () => buildSessionContext(await session.findEntriesOnBranch({ order: "oldestFirst" })).messages;
  const journal = new AceJournal();
  const aep = new AepProjector(sessionId);
  const events = new EventBus();
  const hooks = new HookRegistry((name, error) => {
    journal.push(currentTurnId, "ace.degraded", { where: `hook:${name}`, error: error instanceof Error ? error.message : String(error) });
  });
  journal.subscribe((record) => events.emit("journal", record));

  let currentTurnId = "boot";
  const turnFacts = new Map<string, { verdict: RouterVerdict | null; preparation: AceTaskPreparation | null; forcedClass?: RouterClass }>();
  const loopGuard = createToolLoopGuard(profile.toolLoopGuard.maxIdenticalCalls);

  aep.emit("session.created", {
    cwd,
    provider: "pi",
    model: model.id,
    mode: "agent",
    permissionProfile,
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: baseSystemPrompt,
      model,
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: options.tools ?? createDefaultTools(cwd, ace),
      messages: options.session ? await branchMessages() : [],
    },
    streamFn: (streamModel, context, streamOptions) =>
      models.streamSimple(streamModel, context, { timeoutMs: streamTimeoutMs, ...streamOptions }),
    sessionId,
    toolExecution: "sequential",
    onPayload: async (payload, payloadModel) => {
      const patches = await hooks.run<unknown>("before_payload", { turnId: currentTurnId, payload, model: payloadModel });
      return patches.at(-1);
    },
    onResponse: async (response, responseModel) => {
      await hooks.run("after_response", { turnId: currentTurnId, response, model: responseModel });
    },
    beforeToolCall: async (context) => {
      const results = await hooks.run<BeforeToolCallResult>("before_tool", { ...context, turnId: currentTurnId } satisfies BeforeToolEvent);
      return results.find((result) => result.block) ?? results.at(-1);
    },
    afterToolCall: async (context) => {
      const results = await hooks.run<AfterToolCallResult>("after_tool", { ...context, turnId: currentTurnId } satisfies AfterToolEvent);
      return results.length === 0 ? undefined : Object.assign({}, ...results);
    },
    prepareNextTurnWithContext: (context, signal) => compactHistoryIfNeeded(context, signal),
  });

  // Every message is durable before the next request; the session is the transcript of record.
  const runMessages: AgentMessage[] = [];
  agent.subscribe(async (event: LoopEvent) => {
    events.emit("loop", event);
    projectLoopEvent(aep, event, currentTurnId);
    if (event.type === "message_end") {
      runMessages.push(event.message);
      try {
        // Tool results carry `details: undefined`; the durable log refuses undefined, JSON round-trip drops it.
        await session.appendMessage(JSON.parse(JSON.stringify(event.message)) as AgentMessage);
      } catch (error) {
        journal.push(currentTurnId, "ace.degraded", { where: "session.appendMessage", error: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  async function compactHistoryIfNeeded(context: PrepareNextTurnContext, signal: AbortSignal | undefined) {
    const estimate = estimateContextTokens(context.context.messages);
    if (!shouldCompact(estimate.tokens, profile.contextWindow, compaction)) return undefined;
    const summary = await compactHistory(estimate.tokens, undefined, signal);
    return summary === null ? undefined : { context: { ...context.context, messages: await branchMessages() } };
  }

  /** Summarise the branch into a compaction entry; null when there is nothing to compact or the summary failed. */
  async function compactHistory(tokens: number, customInstructions: string | undefined, signal: AbortSignal | undefined) {
    const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
    const prepared = prepareCompaction(entries, compaction);
    if (!prepared.ok || prepared.value === undefined) return null;
    const vetoes = await hooks.run<{ skip?: boolean }>("before_compaction", {
      turnId: currentTurnId,
      tokens,
      contextWindow: profile.contextWindow,
      preparation: prepared.value,
    } satisfies BeforeCompactionEvent);
    if (vetoes.some((veto) => veto.skip)) return null;
    aep.emit("context.limit", { usedTokens: tokens, maxTokens: profile.contextWindow, action: "compacting" }, currentTurnId);
    // ACE role calls run at low effort (plan W2).
    const result = await compact(prepared.value, models, model, customInstructions, signal, "low");
    if (!result.ok) {
      journal.push(currentTurnId, "ace.degraded", { where: "history-compaction", error: result.error.message });
      return null;
    }
    await session.appendEntry<CompactionEntry>(
      {
        type: "compaction",
        id: uuidv7(),
        summary: result.value.summary,
        retainedTail: result.value.retainedTail,
        tokensBefore: result.value.tokensBefore,
        details: result.value.details,
        ...(result.value.usage ? { usage: result.value.usage } : {}),
      },
      "main",
    );
    journal.push(currentTurnId, "ace.history-compaction", {
      tokensBefore: result.value.tokensBefore,
      retainedMessages: result.value.retainedTail.length,
      summaryChars: result.value.summary.length,
      summary: result.value.summary,
    });
    return result.value.summary;
  }

  // ---- ACE handlers, registered through the same registry as any subscriber ----
  if (ace !== null) {
    hooks.on(
      "transform_context",
      async (raw): Promise<TransformContextResult | undefined> => {
        const event = raw as TransformContextEvent;
        const facts = turnFacts.get(event.turnId)!;
        try {
          facts.verdict = await ace.classifyPrompt(event.prompt);
          journal.push(event.turnId, "ace.router", { prompt: event.prompt, verdict: facts.verdict, ...(facts.forcedClass ? { forcedClass: facts.forcedClass } : {}) });
        } catch (error) {
          journal.push(event.turnId, "ace.degraded", { where: "classifyPrompt", error: String(error instanceof Error ? error.message : error) });
        }
        const preparation = await ace.prepareTask(event.prompt, cwd, false, false, [], agent.signal);
        if (preparation === null) {
          journal.push(event.turnId, "ace.degraded", { where: "prepareTask", error: "returned null" });
          return undefined;
        }
        facts.preparation = preparation;
        const ids = bulletIds(preparation);
        ace.markConsulted(ids, cwd, sessionId);
        const block = contextBlock(preparation);
        journal.push(event.turnId, "ace.lens", { lens: preparation.lens, injectedChars: block?.length ?? 0, bulletIds: ids });
        return block === null ? undefined : { systemContext: [block] };
      },
      { id: "ace" },
    );

    hooks.on(
      "before_tool",
      async (raw): Promise<BeforeToolCallResult | undefined> => {
        const event = raw as BeforeToolEvent;
        const toolName = event.toolCall.name;
        const loop = loopGuard.observe(toolName, event.args);
        const decision = decideToolCall({ profile: permissionProfile, cwd, toolName, args: event.args }, loadProjectRules(cwd));
        journal.push(event.turnId, "ace.gate", { toolCallId: event.toolCall.id, toolName, decision, loopCount: loop.count });
        if (loop.tripped) {
          const reason = `ACE: the same ${toolName} call was issued ${loop.count} times in a row — stopping this run. Change approach or ask the user.`;
          return { block: true, terminate: true, reason };
        }
        if (decision.allow) return undefined;
        const requestId = uuidv7();
        const capability = decision.access === "read" ? "read" : decision.access === "write" ? "write-workspace" : "exec";
        if (!decision.ask) {
          aep.emit("permission.requested", { requestId, toolCallId: event.toolCall.id, capability, detail: decision.reason, options: ["deny"] }, event.turnId);
          aep.emit("permission.resolved", { requestId, decision: "deny", by: "policy" }, event.turnId);
          return { block: true, reason: decision.reason };
        }
        // The ask path: the turn waits for the panel (POST /api/agent/permissions/:id), an abort or the timeout.
        aep.emit("permission.requested", { requestId, toolCallId: event.toolCall.id, capability, detail: decision.reason, options: ["allow-once", "deny"] }, event.turnId);
        const answer = await askPermission({ requestId, cwd, sessionId, toolName, args: event.args, reason: decision.reason, createdAt: new Date().toISOString() }, agent.signal);
        aep.emit("permission.resolved", { requestId, decision: answer === "allow" ? "allow-once" : "deny", by: "user" }, event.turnId);
        journal.push(event.turnId, "ace.gate", { toolCallId: event.toolCall.id, toolName, decision: answer === "allow" ? { allow: true, access: decision.access } : { ...decision, reason: `${decision.reason} (denied)` }, loopCount: loop.count });
        return answer === "allow" ? undefined : { block: true, reason: `${decision.reason} The user denied it.` };
      },
      { id: "ace" },
    );

    hooks.on(
      "after_tool",
      async (raw): Promise<AfterToolCallResult | undefined> => {
        const event = raw as AfterToolEvent;
        const toolName = event.toolCall.name;
        const text = textOf(event.result.content);
        ace.observeAgentEvent(observationOf(toolName, event.args, text, event.isError), cwd);
        if (toolName === "ace_retrieve_context" || event.isError) return undefined;
        const compacted = compactToolResult(text);
        if (compacted === null) return undefined;
        const retrievalId = await ace.storeToolResult(cwd, toolName, text);
        const replacement =
          `${compacted.compacted}\n\n[ACE compacted this ${compacted.kind} result: ${text.length} chars → ${compacted.compacted.length}. ` +
          `Full text: ace_retrieve_context {"id":"${retrievalId}"}]`;
        journal.push(event.turnId, "ace.compaction", {
          toolCallId: event.toolCall.id,
          toolName,
          retrievalId,
          kind: compacted.kind,
          originalChars: text.length,
          compactedChars: replacement.length,
        });
        return { content: [{ type: "text", text: replacement }] };
      },
      { id: "ace" },
    );

    hooks.on(
      "before_run_end",
      async (raw) => {
        const event = raw as BeforeRunEndEvent;
        const facts = turnFacts.get(event.turnId)!;
        const evaluation = await ace.evaluateResult(event.phase, cwd);
        if (evaluation !== null) {
          journal.push(event.turnId, "ace.evaluation", { outcome: evaluation.outcome, signals: evaluation.signals, rationale: evaluation.rationale });
        }
        journal.push(event.turnId, "ace.reflection", ace.reflectAndFile(cwd));
        if (facts.forcedClass !== undefined && facts.verdict !== null && facts.verdict.class !== facts.forcedClass) {
          const veto = await ace.recordRouterVeto(event.prompt, facts.forcedClass);
          if (!veto.ok || veto.error !== null) {
            journal.push(event.turnId, "ace.degraded", { where: "recordRouterVeto", error: veto.error ?? "not recorded" });
          }
        }
      },
      { id: "ace" },
    );
  }

  async function prompt(text: string, turnOptions: TurnOptions = {}): Promise<TurnResult> {
    if (agent.state.isStreaming) throw new Error("A turn is already running on this harness");
    const turnId = uuidv7();
    currentTurnId = turnId;
    turnFacts.set(turnId, { verdict: null, preparation: null, ...(turnOptions.forcedClass ? { forcedClass: turnOptions.forcedClass } : {}) });
    runMessages.length = 0;

    await hooks.run("before_run", { turnId, prompt: text, ...(turnOptions.forcedClass ? { forcedClass: turnOptions.forcedClass } : {}) } satisfies BeforeRunEvent);

    const transforms = await hooks.run<TransformContextResult>("transform_context", {
      turnId,
      prompt: text,
      messages: agent.state.messages,
    } satisfies TransformContextEvent);
    const systemContext = transforms.flatMap((transform) => transform.systemContext ?? []);
    agent.state.systemPrompt = [baseSystemPrompt, ...systemContext].join("\n\n");
    const replacement = transforms.map((transform) => transform.messages).filter((messages) => messages !== undefined).at(-1);
    if (replacement) agent.state.messages = replacement;

    const facts = turnFacts.get(turnId)!;
    aep.emit(
      "turn.started",
      { userMessage: text, attachments: [], contextRefs: facts.preparation?.context.items.map((item) => item.source) ?? [] },
      turnId,
    );

    await agent.prompt(text, turnOptions.images);

    const assistant = [...runMessages].reverse().find((message) => message.role === "assistant");
    const stopReason = assistant?.role === "assistant" ? assistant.stopReason : "error";
    const errorMessage = assistant?.role === "assistant" ? assistant.errorMessage : "no assistant message";
    const phase = { ...phaseReport(runMessages, errorMessage), ...options.phaseExtras?.(turnId) };
    await hooks.run("before_run_end", { turnId, prompt: text, messages: [...runMessages], stopReason, phase } satisfies BeforeRunEndEvent);
    aep.emit("turn.completed", { stopReason, model: model.id }, turnId);

    // The session is the transcript of record: rebuild the Agent view from it (compactions included).
    agent.state.messages = await branchMessages();

    const records = journal.records(turnId);
    const evaluation = records.find((record): record is JournalRecord<"ace.evaluation"> => record.type === "ace.evaluation");
    const reflection = records.find((record): record is JournalRecord<"ace.reflection"> => record.type === "ace.reflection");
    return {
      turnId,
      stopReason,
      text: assistant ? textOf(assistant.content) : "",
      ...(errorMessage ? { errorMessage } : {}),
      verdict: facts.verdict,
      lens: facts.preparation?.lens ?? null,
      gates: records.filter((record): record is JournalRecord<"ace.gate"> => record.type === "ace.gate"),
      compactions: records.filter((record): record is JournalRecord<"ace.compaction"> => record.type === "ace.compaction"),
      evaluation: evaluation ? (evaluation.payload as AceEvaluation) : null,
      reflection: reflection ? reflection.payload : null,
    };
  }

  return {
    hooks,
    events,
    agent,
    session,
    journal,
    aep,
    prompt,
    async compact(customInstructions) {
      if (agent.state.isStreaming) throw new Error("Cannot compact while the agent is running.");
      const summary = await compactHistory(estimateContextTokens(agent.state.messages).tokens, customInstructions, undefined);
      if (summary !== null) agent.state.messages = await branchMessages();
      return summary;
    },
    async close() {
      agent.abort();
      await agent.waitForIdle();
      aep.emit("session.ended", { reason: "completed" });
      aep.close();
    },
  };
}
