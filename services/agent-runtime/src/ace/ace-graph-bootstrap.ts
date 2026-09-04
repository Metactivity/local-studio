// The code graph bootstrap (MET-933, after Tuum.app ADR-030 §1): the first
// session for a folder rebuilds a graph the store never indexed, in the
// background, then a bounded refresh pass runs every 10 min while a session
// for that folder is alive. A turn never waits on it.

export interface GraphEngine {
  controlSnapshot(cwd: string): Promise<Record<string, unknown>>;
  rebuildGraph(cwd: string): Promise<{ indexedFiles: number; pendingFiles: number }>;
  refreshGraph(cwd: string): Promise<{ indexedFiles: number; pendingFiles: number }>;
}

export interface GraphBootstrapRecord {
  cwd: string;
  indexedFiles: number;
  pendingFiles: number;
  ms: number;
}

export interface GraphMaintenanceOptions {
  /** Where the bootstrap result is journaled (the session that triggered it). */
  onBootstrap?: (record: GraphBootstrapRecord) => void;
  onError?: (where: "bootstrap" | "refresh", error: unknown) => void;
  refreshIntervalMs?: number;
}

export const GRAPH_REFRESH_INTERVAL_MS = 10 * 60_000;

interface FolderState {
  bootstrapped: Promise<void> | null;
  indexing: boolean;
  sessions: number;
  timer: ReturnType<typeof setInterval> | null;
}

const folders = new Map<string, FolderState>();

function state(cwd: string): FolderState {
  let entry = folders.get(cwd);
  if (!entry) {
    entry = { bootstrapped: null, indexing: false, sessions: 0, timer: null };
    folders.set(cwd, entry);
  }
  return entry;
}

/** True while a rebuild or refresh pass runs for `cwd` — the ACE tab's "indexing…". */
export function graphIndexing(cwd: string): boolean {
  return folders.get(cwd)?.indexing === true;
}

async function neverIndexed(engine: GraphEngine, cwd: string): Promise<boolean> {
  const snapshot = await engine.controlSnapshot(cwd);
  const graph = snapshot.graph as { last_indexed_at?: unknown } | undefined;
  return !graph?.last_indexed_at;
}

/** Once per folder per process: rebuild the graph when the store never indexed it. Resolves when the pass is over; never throws. */
export function bootstrapGraphOnce(engine: GraphEngine, cwd: string, options: GraphMaintenanceOptions = {}): Promise<void> {
  const entry = state(cwd);
  entry.bootstrapped ??= (async () => {
    const started = Date.now();
    entry.indexing = true;
    try {
      if (!(await neverIndexed(engine, cwd))) return;
      const result = await engine.rebuildGraph(cwd);
      options.onBootstrap?.({ cwd, ...result, ms: Date.now() - started });
    } catch (error) {
      options.onError?.("bootstrap", error);
    } finally {
      entry.indexing = false;
    }
  })();
  return entry.bootstrapped;
}

/**
 * A session for `cwd` is alive: bootstrap in the background and keep the
 * periodic refresh running until the last session releases the folder.
 */
export function startGraphMaintenance(engine: GraphEngine, cwd: string, options: GraphMaintenanceOptions = {}): () => void {
  const entry = state(cwd);
  entry.sessions += 1;
  void bootstrapGraphOnce(engine, cwd, options);
  entry.timer ??= setInterval(() => {
    if (entry.indexing) return;
    entry.indexing = true;
    engine
      .refreshGraph(cwd)
      .catch((error: unknown) => options.onError?.("refresh", error))
      .finally(() => {
        entry.indexing = false;
      });
  }, options.refreshIntervalMs ?? GRAPH_REFRESH_INTERVAL_MS);
  entry.timer.unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.sessions -= 1;
    if (entry.sessions > 0 || !entry.timer) return;
    clearInterval(entry.timer);
    entry.timer = null;
  };
}

/** Test seam: forget every folder (timers cleared). */
export function resetGraphMaintenance(): void {
  for (const entry of folders.values()) if (entry.timer) clearInterval(entry.timer);
  folders.clear();
}
