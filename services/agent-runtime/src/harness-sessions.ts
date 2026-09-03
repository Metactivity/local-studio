// Sessions for the harness core: list / load over the SQLite session repo
// (src/ace/sqlite-session-repo.ts), shaped exactly like the pi JSONL store so
// the http session handlers and the frontend fold need no change. The events
// a load returns are the session's own entries (`{type:"message", message}`,
// `{type:"compaction", summary}`, `{type:"model_change"}`) behind one
// synthesized `{type:"session"}` header — the same vocabulary pi writes.

import { realpathSync } from "node:fs";
import path from "node:path";
import type { Entry } from "@local-studio/harness";
import { type Database, openSessionsDatabase, SqliteSessionRepo } from "./ace/sqlite-session-repo";
import { harnessStoreRoot } from "./data-dir";
import { getGlobalSingleton } from "./instances";
import { readSessionListMetadata } from "./session-metadata-store";
import { accumulateUsageLine, emptyUsageTotals } from "./session-usage";
import {
  applySessionMetadata,
  type ListSessionsOptions,
  type LoadSessionOptions,
  type LoadSessionResult,
  normalizeListOptions,
  type SessionEvent,
  summaryMatchesListOptions,
  summaryStartTime,
} from "./sessions-store";
import {
  cleanSessionTitle,
  sessionTitleFromUserPrompt,
} from "../../../shared/agent/session-title";
import type { SessionSummary } from "../../../shared/agent/session-summary";

const DEFAULT_TAIL = 500;

export { harnessStoreRoot };

type SessionRow = { id: string; created_at: number; cwd: string | null };

function cwdVariants(cwd: string): Set<string> {
  const variants = new Set([path.resolve(cwd)]);
  try {
    variants.add(realpathSync(cwd));
  } catch {
    // A cwd that no longer exists still matches its lexical path.
  }
  return variants;
}

function sameCwd(stored: string | null, cwd: string): boolean {
  if (!stored) return false;
  const expected = cwdVariants(cwd);
  return [...cwdVariants(stored)].some((candidate) => expected.has(candidate));
}

function userText(message: unknown): string | null {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ")
    .trim();
  return text || null;
}

function isUserMessage(entry: Entry): boolean {
  return entry.type === "message" && entry.message.role === "user";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Index of the entry a `tail`-message page starts at, snapped back to a user turn so tool results stay with their turn. */
function tailStart(entries: readonly Entry[], tail: number): number {
  let messages = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message") continue;
    messages += 1;
    if (messages >= tail && entry.message.role === "user") return index;
  }
  return 0;
}

export interface HarnessSessionStore {
  readonly repo: SqliteSessionRepo;
  listSessions(cwd: string, options?: ListSessionsOptions): Promise<SessionSummary[]>;
  loadSession(cwd: string, sessionId: string, options?: LoadSessionOptions): Promise<LoadSessionResult>;
  close(): void;
}

export function createHarnessSessionStore(storeRoot: string): HarnessSessionStore {
  const db: Database = openSessionsDatabase(path.join(storeRoot, "sessions.db"));
  const repo = new SqliteSessionRepo(db);

  // node:sqlite statements are untyped; each query names its row shape once here.
  const prepare = <Row>(sql: string) => {
    const statement = db.prepare(sql);
    return {
      all: (...params: string[]) => statement.all(...params) as unknown as Row[],
      get: (...params: string[]) => statement.get(...params) as unknown as Row | undefined,
    };
  };
  const rowsQuery = prepare<SessionRow>("SELECT id, created_at, cwd FROM sessions ORDER BY created_at DESC");
  const rowQuery = prepare<SessionRow>("SELECT id, created_at, cwd FROM sessions WHERE id = ?");
  // ponytail: json_extract scans every mutation of a session per listing; add an
  // entries index / summary columns if the sidebar refresh gets slow.
  const userMessageQuery = (order: "ASC" | "DESC") =>
    prepare<{ json: string }>(
      `SELECT json FROM mutations WHERE session_id = ? AND json_extract(json, '$.entry.type') = 'message'
         AND json_extract(json, '$.entry.message.role') = 'user' ORDER BY seq ${order} LIMIT 1`,
    );
  const firstUserQuery = userMessageQuery("ASC");
  const lastUserQuery = userMessageQuery("DESC");
  const modelQuery = prepare<{ provider: string; model_id: string }>(
    `SELECT json_extract(json, '$.entry.provider') AS provider, json_extract(json, '$.entry.modelId') AS model_id
       FROM mutations WHERE session_id = ? AND json_extract(json, '$.entry.type') = 'model_change' ORDER BY seq DESC LIMIT 1`,
  );
  const updatedQuery = prepare<{ at: number | null }>(
    `SELECT MAX(COALESCE(json_extract(json, '$.entry.timestamp'), json_extract(json, '$.record.timestamp'))) AS at
       FROM mutations WHERE session_id = ?`,
  );

  const userTurn = (row: { json: string } | undefined) => {
    if (row === undefined) return null;
    const entry = (JSON.parse(row.json) as { entry: Entry }).entry;
    const text = entry.type === "message" ? userText(entry.message) : null;
    return text === null ? null : { text, at: iso(entry.timestamp) };
  };

  function summarize(row: SessionRow): SessionSummary {
    const first = userTurn(firstUserQuery.get(row.id));
    const last = userTurn(lastUserQuery.get(row.id));
    const model = modelQuery.get(row.id);
    const updatedAt = updatedQuery.get(row.id)?.at ?? row.created_at;
    return {
      id: row.id,
      filename: "",
      cwd: row.cwd ?? "",
      startedAt: iso(row.created_at),
      updatedAt: iso(updatedAt),
      modelId: model?.model_id ?? null,
      provider: model?.provider ?? null,
      firstUserMessage: first ? cleanSessionTitle(sessionTitleFromUserPrompt(first.text).slice(0, 120)) || null : null,
      ...(last && sessionTitleFromUserPrompt(last.text) ? { lastUserPromptText: sessionTitleFromUserPrompt(last.text) } : {}),
      ...(last ? { lastUserPromptAt: last.at } : {}),
      archived: false,
      archivedAt: null,
      parentSessionId: null,
      subagentName: null,
    };
  }

  async function listSessions(cwd: string, options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const normalized = normalizeListOptions(options);
    const metadataFor = readSessionListMetadata();
    const summaries: SessionSummary[] = [];
    for (const row of rowsQuery.all()) {
      if (!sameCwd(row.cwd, cwd)) continue;
      if (normalized.wantedIds.size > 0 && !normalized.wantedIds.has(row.id)) continue;
      const summary = applySessionMetadata(summarize(row), metadataFor);
      if (normalized.sinceMs !== undefined && !normalized.archivedOnly && Date.parse(summary.updatedAt) < normalized.sinceMs) continue;
      if (summaryMatchesListOptions(summary, normalized)) summaries.push(summary);
    }
    summaries.sort((a, b) => summaryStartTime(b) - summaryStartTime(a));
    return options.limit && options.limit > 0 ? summaries.slice(0, options.limit) : summaries;
  }

  async function loadSession(cwd: string, sessionId: string, options: LoadSessionOptions = {}): Promise<LoadSessionResult> {
    const row = rowQuery.get(sessionId);
    if (row === undefined || !sameCwd(row.cwd, cwd)) return { events: [], cursor: null, meta: null };
    const session = await repo.open({ id: row.id, createdAt: row.created_at });
    const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
    const model = modelQuery.get(row.id);
    const header: SessionEvent = {
      type: "session",
      id: row.id,
      timestamp: iso(row.created_at),
      cwd: row.cwd ?? "",
      ...(model ? { modelId: model.model_id, provider: model.provider } : {}),
    };
    const events = entries as unknown as SessionEvent[];
    const tail = options.tail && options.tail > 0 ? Math.floor(options.tail) : undefined;
    const paging = options.before !== undefined;
    if (!tail && !paging) return { events: [header, ...events], cursor: null, meta: null };

    const end = paging ? entries.findIndex((entry) => entry.seq >= options.before!) : -1;
    const visible = end === -1 ? entries : entries.slice(0, end);
    const start = tailStart(visible, tail ?? DEFAULT_TAIL);
    const page = visible.slice(start) as unknown as SessionEvent[];
    const cursor = start > 0 ? visible[start]!.seq : null;
    if (paging) return { events: page, cursor, meta: null };

    const first = entries.find(isUserMessage);
    const title = first?.type === "message" ? userText(first.message) : null;
    const usage = entries.reduce((totals, entry) => accumulateUsageLine(totals, JSON.stringify(entry)), emptyUsageTotals());
    return {
      events: [header, ...page],
      cursor,
      meta: {
        title: title ? cleanSessionTitle(title.slice(0, 120)) || null : null,
        modelId: model?.model_id ?? null,
        startedAt: header.timestamp as string,
        piSessionId: row.id,
        usage,
      },
    };
  }

  return { repo, listSessions, loadSession, close: () => repo.close() };
}

/** The process-wide store under `ACE_STORE_ROOT` — shared by the harness driver and the http session handlers. */
export function harnessSessions(): HarnessSessionStore {
  return getGlobalSingleton("harnessSessionStore", () => createHarnessSessionStore(harnessStoreRoot()));
}
