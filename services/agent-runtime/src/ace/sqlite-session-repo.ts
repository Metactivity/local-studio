// Harness SessionRepo / SessionStorage on bun:sqlite (ADR-015, ADR-033 §2.4).
//
// Same shape as the vendored JSONL backend: the in-memory `SessionState` holds
// the tree and enforces every invariant; this file only makes the mutation
// log durable — one row per mutation, replayed on open. Reusing `SessionState`
// is what lets the vendored conformance suite run unchanged against it.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  type BranchBounds,
  type Entry,
  type EntryQuery,
  type ForkOptions,
  JsonlSessionRepo,
  type LanePointer,
  type LaneRecord,
  type LogItem,
  type LogOptions,
  type NewRecord,
  type OperationStartedRecord,
  type ProvisionedEntry,
  type RecordQuery,
  Session,
  type SessionCreateOptions,
  SessionError,
  type SessionMetadata,
  type SessionRepo,
  type SessionStats,
  type SessionStorage,
  uuidv7,
} from "@local-studio/harness";
import { NodeExecutionEnv } from "@local-studio/harness/node";
import { type SessionMutation, SessionState } from "@local-studio/harness/session/state";

export interface SqliteSessionMetadata extends SessionMetadata {
  cwd?: string;
}

export interface SqliteSessionCreateOptions extends SessionCreateOptions {
  cwd?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  parent_session_id TEXT,
  cwd TEXT
);
CREATE TABLE IF NOT EXISTS mutations (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
`;

export function openSessionsDatabase(file: string): Database {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

interface SessionRow {
  id: string;
  created_at: number;
  parent_session_id: string | null;
  cwd: string | null;
}

function metadataFromRow(row: SessionRow): SqliteSessionMetadata {
  return {
    id: row.id,
    createdAt: row.created_at,
    ...(row.parent_session_id !== null ? { parentSessionId: row.parent_session_id } : {}),
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
  };
}

export class SqliteSessionStorage implements SessionStorage<SqliteSessionMetadata> {
  readonly #db: Database;
  readonly #metadata: SqliteSessionMetadata;
  readonly #state = new SessionState();

  constructor(db: Database, metadata: SqliteSessionMetadata) {
    this.#db = db;
    this.#metadata = structuredClone(metadata);
  }

  /** Replays the durable log into a fresh state. */
  static load(db: Database, metadata: SqliteSessionMetadata): SqliteSessionStorage {
    const storage = new SqliteSessionStorage(db, metadata);
    const rows = db
      .query<{ json: string }, [string]>("SELECT json FROM mutations WHERE session_id = ? ORDER BY seq")
      .all(metadata.id);
    for (const row of rows) storage.#state.applyMutation(JSON.parse(row.json) as SessionMutation);
    return storage;
  }

  forkInto(metadata: SqliteSessionMetadata, options: ForkOptions): SqliteSessionStorage {
    const mutations = this.#state.createForkMutations(options);
    const target = new SqliteSessionStorage(this.#db, metadata);
    this.#db.transaction(() => {
      for (const mutation of mutations) target.#commit(mutation);
    })();
    return target;
  }

  #commit(mutation: SessionMutation): void {
    const seq = mutation.kind === "entry" ? mutation.entry.seq : mutation.kind === "record" ? mutation.record.seq : mutation.seq;
    this.#db
      .query("INSERT INTO mutations (session_id, seq, json) VALUES (?, ?, ?)")
      .run(this.#metadata.id, seq, JSON.stringify(mutation));
    this.#state.applyMutation(mutation);
  }

  async getMetadata(): Promise<SqliteSessionMetadata> {
    return structuredClone(this.#metadata);
  }

  async getLanes(): Promise<LanePointer[]> {
    return this.#state.getLanes();
  }

  async createLane(lane: string, at: string | null): Promise<void> {
    this.#state.validateNewLane(lane);
    this.#state.validateTarget(at);
    this.#commit({ kind: "lane", seq: this.#state.nextSequence, lane, leafId: at });
  }

  async moveLane(lane: string, to: string | null): Promise<void> {
    this.#state.requireLane(lane);
    this.#state.validateTarget(to);
    this.#commit({ kind: "lane", seq: this.#state.nextSequence, lane, leafId: to });
  }

  async appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
    const parentId = this.#state.requireLane(lane);
    this.#state.validateUnusedId(newEntry.id);
    const entry = {
      ...structuredClone(newEntry),
      parentId,
      seq: this.#state.nextSequence,
      timestamp: Date.now(),
    } as unknown as TEntry;
    this.#commit({ kind: "entry", lane, entry });
    return structuredClone(entry);
  }

  async appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
    this.#state.requireLane(newRecord.lane);
    this.#state.validateUnusedId(newRecord.id);
    const openOperationId = this.#state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
    if (newRecord.type === "operation_started" && openOperationId !== undefined) {
      throw new SessionError("storage", `Lane ${newRecord.lane} already has an open operation ${openOperationId}`);
    }
    const record = {
      ...structuredClone(newRecord),
      seq: this.#state.nextSequence,
      timestamp: Date.now(),
    } as unknown as TRecord;
    this.#commit({ kind: "record", record });
    return structuredClone(record);
  }

  async getEntry(id: string): Promise<Entry | undefined> {
    const entry = this.#state.getEntry(id);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
    return structuredClone(this.#state.findEntries(query));
  }

  async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
    return structuredClone(this.#state.findEntriesOnBranch(query));
  }

  async findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]>;
  async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
  async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
    return structuredClone(this.#state.findRecords(query));
  }

  async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
    return structuredClone(this.#state.findOpenOperations(lane, options));
  }

  async getLog(options: LogOptions = {}): Promise<LogItem[]> {
    return structuredClone(this.#state.getLog(options));
  }

  async getName(): Promise<string | undefined> {
    return this.#state.getName();
  }

  async setName(name: string | undefined): Promise<void> {
    this.#commit({ kind: "fact", seq: this.#state.nextSequence, fact: "name", name });
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.#state.getLabel(id);
  }

  async setLabel(id: string, label: string | undefined): Promise<void> {
    this.#state.validateTarget(id);
    this.#commit({ kind: "fact", seq: this.#state.nextSequence, fact: "label", targetId: id, label });
  }

  async getStats(): Promise<SessionStats> {
    return structuredClone(this.#state.getStats());
  }
}

/** The repo shape the harness persists into — SQLite or the vendored JSONL fallback. */
export type HarnessSessionRepo = SessionRepo<SessionMetadata, SessionCreateOptions & { cwd: string }, unknown>;

export class SqliteSessionRepo implements SessionRepo<SqliteSessionMetadata, SqliteSessionCreateOptions> {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** `<storeRoot>/sessions.db`, WAL. */
  static open(storeRoot: string): SqliteSessionRepo {
    return new SqliteSessionRepo(openSessionsDatabase(path.join(storeRoot, "sessions.db")));
  }

  async create(options: SqliteSessionCreateOptions = {}): Promise<Session<SqliteSessionMetadata>> {
    const metadata = this.#insert(options);
    return new Session(new SqliteSessionStorage(this.#db, metadata));
  }

  async open(metadata: SqliteSessionMetadata): Promise<Session<SqliteSessionMetadata>> {
    return new Session(SqliteSessionStorage.load(this.#db, this.#require(metadata.id)));
  }

  async list(): Promise<SqliteSessionMetadata[]> {
    return this.#db
      .query<SessionRow, []>("SELECT id, created_at, parent_session_id, cwd FROM sessions ORDER BY created_at DESC")
      .all()
      .map(metadataFromRow);
  }

  async delete(metadata: SqliteSessionMetadata): Promise<void> {
    this.#db.query("DELETE FROM sessions WHERE id = ?").run(metadata.id);
  }

  async fork(
    source: SqliteSessionMetadata,
    options: ForkOptions & SqliteSessionCreateOptions,
  ): Promise<Session<SqliteSessionMetadata>> {
    const sourceStorage = SqliteSessionStorage.load(this.#db, this.#require(source.id));
    const metadata = this.#insert({ ...options, parentSessionId: options.parentSessionId ?? source.id });
    return new Session(sourceStorage.forkInto(metadata, options));
  }

  #insert(options: SqliteSessionCreateOptions): SqliteSessionMetadata {
    const id = options.id ?? uuidv7();
    if (this.#db.query("SELECT 1 FROM sessions WHERE id = ?").get(id) !== null) {
      throw new SessionError("already_exists", `Session already exists: ${id}`);
    }
    const metadata: SqliteSessionMetadata = {
      id,
      createdAt: Date.now(),
      ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    };
    this.#db
      .query("INSERT INTO sessions (id, created_at, parent_session_id, cwd) VALUES (?, ?, ?, ?)")
      .run(id, metadata.createdAt, metadata.parentSessionId ?? null, metadata.cwd ?? null);
    return metadata;
  }

  #require(id: string): SqliteSessionMetadata {
    const row = this.#db
      .query<SessionRow, [string]>("SELECT id, created_at, parent_session_id, cwd FROM sessions WHERE id = ?")
      .get(id);
    if (row === null) throw new SessionError("not_found", `Session not found: ${id}`);
    return metadataFromRow(row);
  }

  close(): void {
    this.#db.close();
  }
}

/** The repo the harness persists into: SQLite unless `ACE_SESSION_STORE=jsonl`. */
export function createSessionRepo(
  storeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): HarnessSessionRepo {
  if (env.ACE_SESSION_STORE?.trim().toLowerCase() === "jsonl") {
    const sessionsRoot = path.join(storeRoot, "sessions");
    return new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot });
  }
  return SqliteSessionRepo.open(storeRoot);
}
