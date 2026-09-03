// The ACE journal: what ACE did to a turn (router verdict, Context Lens,
// gate decisions, compaction, evaluation, reflection). In-memory ring, one
// record per fact; records are AEP-shaped (seq / ts / type / payload) so the
// SSE layer can forward them beside the protocol events without a reshape.

import type { PreparationLens, RouterVerdict } from "@metactivity/ace";
import type { GateDecision } from "./ace-gate";

export interface JournalPayloads {
  "ace.router": { prompt: string; verdict: RouterVerdict; forcedClass?: string };
  "ace.lens": { lens: PreparationLens; injectedChars: number; bulletIds: string[] };
  "ace.gate": { toolCallId: string; toolName: string; decision: GateDecision; loopCount: number };
  "ace.compaction": {
    toolCallId: string;
    toolName: string;
    retrievalId: string;
    kind: string;
    originalChars: number;
    compactedChars: number;
  };
  "ace.history-compaction": { tokensBefore: number; retainedMessages: number; summaryChars: number };
  "ace.evaluation": { outcome: string; signals: string[]; rationale: string };
  "ace.reflection": { proposals: number; new: number };
  "ace.degraded": { where: string; error: string };
}

export type JournalType = keyof JournalPayloads;

export interface JournalRecord<T extends JournalType = JournalType> {
  seq: number;
  ts: string;
  turnId: string;
  type: T;
  payload: JournalPayloads[T];
}

export type AnyJournalRecord = { [K in JournalType]: JournalRecord<K> }[JournalType];

export class AceJournal {
  readonly #records: AnyJournalRecord[] = [];
  readonly #listeners = new Set<(record: AnyJournalRecord) => void>();
  readonly #cap: number;
  #seq = 0;

  constructor(cap = 500) {
    this.#cap = cap;
  }

  push<T extends JournalType>(turnId: string, type: T, payload: JournalPayloads[T]): JournalRecord<T> {
    const record = { seq: ++this.#seq, ts: new Date().toISOString(), turnId, type, payload } as JournalRecord<T>;
    this.#records.push(record as AnyJournalRecord);
    if (this.#records.length > this.#cap) this.#records.shift();
    for (const listener of this.#listeners) listener(record as AnyJournalRecord);
    return record;
  }

  records(turnId?: string): AnyJournalRecord[] {
    return turnId === undefined ? [...this.#records] : this.#records.filter((record) => record.turnId === turnId);
  }

  subscribe(listener: (record: AnyJournalRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
