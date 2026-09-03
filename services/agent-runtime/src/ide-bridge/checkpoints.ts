// Turn checkpoints (ADR-034 M6) on `@metactivity/runtime` git.ts: before the
// first write of a turn the worktree is snapshotted under
// `refs/ace-ide/checkpoints/<session>/<n>`; the panel lists what changed since,
// shows a file's checkpoint content against the current one, and reverts. A
// folder without git gets no checkpoint — the caller journals it.

import { execFileSync } from "node:child_process";
import {
  changedPaths,
  type Checkpoint,
  createCheckpoint,
  isGitRepo,
  listCheckpoints,
  restoreCheckpoint,
} from "@metactivity/runtime/git";

export type { Checkpoint };

const GIT_TIMEOUT_MS = 30_000;

export interface CheckpointEntry {
  n: number;
  commit: string;
  ref: string;
}

const indexOf = (checkpoint: Checkpoint): number => Number(checkpoint.ref.split("/").pop());

/** Null when the folder is not a git repository. */
export function createTurnCheckpoint(cwd: string, sessionId: string, label: string): Checkpoint | null {
  if (!isGitRepo(cwd)) return null;
  const next = listCheckpoints(cwd, sessionId).reduce((max, checkpoint) => Math.max(max, indexOf(checkpoint)), 0) + 1;
  return createCheckpoint(cwd, sessionId, next, label);
}

export function sessionCheckpoints(cwd: string, sessionId: string): { repo: boolean; checkpoints: CheckpointEntry[]; changed: string[] } {
  if (!isGitRepo(cwd)) return { repo: false, checkpoints: [], changed: [] };
  const checkpoints = listCheckpoints(cwd, sessionId)
    .map((checkpoint) => ({ n: indexOf(checkpoint), commit: checkpoint.commit, ref: checkpoint.ref }))
    .sort((a, b) => a.n - b.n);
  const last = listCheckpoints(cwd, sessionId).find((checkpoint) => indexOf(checkpoint) === checkpoints.at(-1)?.n);
  return { repo: true, checkpoints, changed: last ? changedPaths(cwd, last) : [] };
}

function find(cwd: string, sessionId: string, n: number): Checkpoint {
  const checkpoint = listCheckpoints(cwd, sessionId).find((candidate) => indexOf(candidate) === n);
  if (!checkpoint) throw new Error(`no checkpoint ${n} for session ${sessionId}`);
  return checkpoint;
}

/** Restores the whole worktree to checkpoint `n` (files created after it are removed). */
export function revertToCheckpoint(cwd: string, sessionId: string, n: number): Checkpoint {
  const checkpoint = find(cwd, sessionId, n);
  restoreCheckpoint(cwd, checkpoint);
  return checkpoint;
}

/** The file as it was at checkpoint `n`; null when it did not exist there. */
export function checkpointFile(cwd: string, sessionId: string, n: number, file: string): { checkpoint: Checkpoint; content: string | null } {
  const checkpoint = find(cwd, sessionId, n);
  try {
    const content = execFileSync("git", ["show", `${checkpoint.commit}:${file}`], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
    return { checkpoint, content };
  } catch {
    return { checkpoint, content: null };
  }
}
