// The agent panel's view of /api/agent/ace/* (ADR-034 M4). Shapes mirror the
// runtime's ace-handlers; only the fields the panel renders are typed.

import { safeJson } from "@/features/agent/safe-json";

export type AceHealth = { health: string; detail: string };

export type AceStatusReport = {
  configured: boolean;
  runtime: "external" | "supervised" | null;
  storeRoot: string | null;
  chatModel: string | null;
  embedModel: string | null;
  problems: string[];
  health: AceHealth | null;
  status: {
    available: boolean;
    model?: { available: boolean; name: string; loaded: boolean | null };
    embeddings_available?: boolean;
    degraded?: string | null;
    error?: string | null;
  } | null;
  runtimeSnapshot: { mode: string; chatUrl: string | null; embedUrl: string | null } | null;
  control: {
    graph?: { indexed_files: number; entities: number; last_indexed_at: string | null };
    memory?: { project_bullets: number; global_bullets: number; pending_proposals: number };
    error?: string;
  } | null;
};

export type AceProposal = {
  id: number;
  createdAt: string;
  section: string;
  content: string;
  confidence: string;
  guardrail: boolean;
  status: string;
  duplicateCount: number;
  provenance: { commands: string[]; files: string[] };
};

export type AceBullet = {
  id: string;
  section: string;
  content: string;
  helpful: number;
  harmful: number;
  scope: "project" | "global";
};

export type AceMemory = {
  playbook: { project: string | null; global: string | null };
  bullets: { project: AceBullet[]; global: AceBullet[] };
};

export type AceJournalRecord = {
  seq: number;
  ts: string;
  turnId: string;
  type: string;
  payload: Record<string, unknown>;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await safeJson<T & { error?: string }>(response);
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const post = <T>(url: string, body: Record<string, unknown>) =>
  call<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const withCwd = (path: string, cwd: string) => `${path}?cwd=${encodeURIComponent(cwd)}`;

export const loadAceStatus = (cwd: string) =>
  call<AceStatusReport>(withCwd("/api/agent/ace/status", cwd));

export const loadAceProposals = (cwd: string) =>
  call<{ proposals: AceProposal[] }>(withCwd("/api/agent/ace/proposals", cwd)).then(
    (payload) => payload.proposals,
  );

export const resolveAceProposal = (
  cwd: string,
  id: number,
  action: "accept" | "reject",
  content?: string,
) =>
  post<{ ok: boolean; bulletId: string | null }>(`/api/agent/ace/proposals/${id}`, {
    cwd,
    action,
    content,
  });

export const loadAceMemory = (cwd: string) =>
  call<AceMemory>(withCwd("/api/agent/ace/memory", cwd));

export const loadAceLens = (sessionId: string, piSessionId: string | null) => {
  const params = new URLSearchParams({ sessionId });
  if (piSessionId) params.set("piSessionId", piSessionId);
  return call<{ records: AceJournalRecord[] }>(`/api/agent/ace/lens?${params}`).then(
    (payload) => payload.records,
  );
};

export type IdeContextReport = {
  connected: boolean;
  socketPath: string;
  context: {
    sessionId: string;
    extensionVersion: string;
    connectedAt: string;
    updatedAt: string;
    activeEditor: {
      uri: string;
      languageId: string;
      selection: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    } | null;
    tabs: string[];
    lastSaved: string | null;
    dirty: string[];
    /** Per-uri error/warning counts, only files with at least one. */
    diagnostics: Record<string, { errors: number; warnings: number }>;
    scm: {
      branch: string | null;
      ahead: number;
      behind: number;
      changes: { uri: string; status: string }[];
    } | null;
  } | null;
  totals: { errors: number; warnings: number; files: number } | null;
};

export const loadIdeContext = (cwd: string) =>
  call<IdeContextReport>(withCwd("/api/agent/ide/context", cwd));

/** One `[tuum]` terminal run the agent started in the editor (ADR-034 M7). */
export type IdeTerminalRun = {
  termId: string | null;
  name: string;
  command: string;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  captured: boolean;
  tail: string;
};

export const loadIdeTerminals = (cwd: string, sessionId: string) =>
  call<{ runs: IdeTerminalRun[] }>(
    `/api/agent/ide/terminals?${new URLSearchParams({ cwd, sessionId })}`,
  ).then((payload) => payload.runs);

export const rebuildAceGraph = (cwd: string) =>
  post<{ indexedFiles: number; pendingFiles: number }>("/api/agent/ace/rebuild-graph", { cwd });

export const restartAce = () =>
  post<{ ok: boolean; health: AceHealth }>("/api/agent/ace/restart", {});

// ─── M6: turn checkpoints + permission asks (the Changes strip) ───────────

export type CheckpointsReport = {
  sessionId: string;
  repo: boolean;
  checkpoints: { n: number; commit: string; ref: string }[];
  /** Paths changed since the last checkpoint. */
  changed: string[];
};

export type PendingPermission = {
  requestId: string;
  cwd: string;
  sessionId: string;
  toolName: string;
  args: unknown;
  reason: string;
  createdAt: string;
};

export const loadCheckpoints = (cwd: string, sessionId: string) =>
  call<CheckpointsReport>(`/api/agent/checkpoints?${new URLSearchParams({ cwd, sessionId })}`);

export const revertCheckpoint = (cwd: string, sessionId: string, n: number) =>
  post<{ ok: boolean }>("/api/agent/checkpoints/revert", { cwd, sessionId, n });

export const showCheckpointFile = (
  cwd: string,
  sessionId: string,
  n: number | null,
  path: string,
  mode: "open" | "diff",
) => post<{ ok: boolean }>("/api/agent/checkpoints/show", { cwd, sessionId, n, path, mode });

export const loadPendingPermissions = (cwd: string) =>
  call<{ pending: PendingPermission[] }>(withCwd("/api/agent/permissions", cwd)).then(
    (payload) => payload.pending,
  );

export const answerPermission = (requestId: string, decision: "allow" | "deny") =>
  post<{ ok: boolean }>(`/api/agent/permissions/${encodeURIComponent(requestId)}`, { decision });
