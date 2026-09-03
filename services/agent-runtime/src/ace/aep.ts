// AEP projection (ADR-023): harness loop events → @metactivity/protocol
// events, folded through the shared reducer. One projector per session; the
// future SSE layer consumes `events()`.

import type { AgentEvent as LoopEvent } from "@local-studio/harness";
import {
  type AgentEvent,
  type AnyAgentEvent,
  type EventPayloads,
  type EventType,
  initialState,
  PROTOCOL_VERSION,
  type ProviderId,
  reduceEvent,
  type TimelineState,
  type ToolKind,
} from "@metactivity/protocol";

export class AepProjector {
  readonly sessionId: string;
  readonly source: ProviderId;
  state: TimelineState;
  readonly #queue: AnyAgentEvent[] = [];
  readonly #waiters: ((result: IteratorResult<AnyAgentEvent>) => void)[] = [];
  #seq = 0;
  #closed = false;

  constructor(sessionId: string, source: ProviderId = "pi") {
    this.sessionId = sessionId;
    this.source = source;
    this.state = initialState(sessionId);
  }

  emit<T extends EventType>(type: T, payload: EventPayloads[T], turnId?: string): AgentEvent<T> {
    const event = {
      v: PROTOCOL_VERSION,
      seq: ++this.#seq,
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
      ts: new Date().toISOString(),
      source: this.source,
      type,
      payload,
    } as AgentEvent<T>;
    const anyEvent = event as unknown as AnyAgentEvent;
    this.state = reduceEvent(this.state, anyEvent);
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: anyEvent, done: false });
    else this.#queue.push(anyEvent);
    return event;
  }

  /** Pull iterator over emitted events; ends after `close()` once the queue drains. */
  events(): AsyncIterableIterator<AnyAgentEvent> {
    const next = (): Promise<IteratorResult<AnyAgentEvent>> => {
      const queued = this.#queue.shift();
      if (queued) return Promise.resolve({ value: queued, done: false });
      if (this.#closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => this.#waiters.push(resolve));
    };
    return {
      next,
      return: () => Promise.resolve({ value: undefined, done: true }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

export function toolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
    case "ace_retrieve_context":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "exec";
    default:
      return "other";
  }
}

const OUTPUT_CAP = 8_000;

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: string }).text ?? "") : ""))
    .join("")
    .slice(0, OUTPUT_CAP);
}

/** Map one harness loop event onto AEP. `turn.started`/`turn.completed` are the harness's to emit — it knows the prompt and the outcome. */
export function projectLoopEvent(aep: AepProjector, event: LoopEvent, turnId: string): void {
  switch (event.type) {
    case "message_end": {
      if (event.message.role !== "assistant") return;
      for (const block of event.message.content) {
        if (block.type === "text" && block.text.length > 0) {
          aep.emit("assistant.text", { text: block.text, messageId: crypto.randomUUID() }, turnId);
        } else if (block.type === "thinking" && block.thinking.length > 0) {
          aep.emit("assistant.reasoning", { text: block.thinking }, turnId);
        }
      }
      if (event.message.errorMessage) {
        aep.emit("error.terminal", { code: event.message.stopReason, message: event.message.errorMessage }, turnId);
      }
      return;
    }
    case "tool_execution_start":
      aep.emit(
        "tool.requested",
        { toolCallId: event.toolCallId, name: event.toolName, input: event.args, kind: toolKind(event.toolName) },
        turnId,
      );
      return;
    case "tool_execution_end":
      aep.emit(
        "tool.completed",
        {
          toolCallId: event.toolCallId,
          status: event.isError ? "error" : "ok",
          output: contentText((event.result as { content?: unknown })?.content),
        },
        turnId,
      );
      return;
    default:
      return;
  }
}
