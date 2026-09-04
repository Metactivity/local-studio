// The graph bootstrap (MET-933): one rebuild per folder per process when the
// store never indexed it, the indexing flag while it runs, the periodic
// refresh held by the sessions of that folder.

import { afterEach, describe, expect, test } from "bun:test";
import { bootstrapGraphOnce, type GraphEngine, graphIndexing, resetGraphMaintenance, startGraphMaintenance } from "../src/ace/ace-graph-bootstrap";

function fakeEngine(indexed: boolean) {
  const calls = { rebuild: 0, refresh: 0 };
  let release: () => void = () => undefined;
  const engine: GraphEngine = {
    controlSnapshot: async () => ({ graph: { last_indexed_at: indexed ? "2026-09-04T00:00:00Z" : null } }),
    rebuildGraph: () => {
      calls.rebuild += 1;
      return new Promise((resolve) => {
        release = () => resolve({ indexedFiles: 3, pendingFiles: 0 });
      });
    },
    refreshGraph: async () => {
      calls.refresh += 1;
      return { indexedFiles: 3, pendingFiles: 0 };
    },
  };
  return { engine, calls, release: () => release() };
}

afterEach(() => resetGraphMaintenance());

describe("ACE graph bootstrap", () => {
  test("a never-indexed folder is rebuilt once, the flag is up while it runs, the result is journaled", async () => {
    const { engine, calls, release } = fakeEngine(false);
    const records: unknown[] = [];
    const first = bootstrapGraphOnce(engine, "/p/a", { onBootstrap: (record) => records.push(record) });
    const second = bootstrapGraphOnce(engine, "/p/a");
    await Bun.sleep(5);
    expect(graphIndexing("/p/a")).toBe(true);
    expect(calls.rebuild).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(graphIndexing("/p/a")).toBe(false);
    expect(records).toEqual([{ cwd: "/p/a", indexedFiles: 3, pendingFiles: 0, ms: expect.any(Number) }]);
    expect(calls.rebuild).toBe(1);
  });

  test("an indexed folder is left alone; the refresh timer lives while a session holds the folder", async () => {
    const { engine, calls } = fakeEngine(true);
    const releaseA = startGraphMaintenance(engine, "/p/b", { refreshIntervalMs: 10 });
    const releaseB = startGraphMaintenance(engine, "/p/b", { refreshIntervalMs: 10 });
    await Bun.sleep(35);
    expect(calls.rebuild).toBe(0);
    expect(calls.refresh).toBeGreaterThanOrEqual(2);
    releaseA();
    const afterFirstRelease = calls.refresh;
    await Bun.sleep(25);
    expect(calls.refresh).toBeGreaterThan(afterFirstRelease);
    releaseB();
    const afterLastRelease = calls.refresh;
    await Bun.sleep(25);
    expect(calls.refresh).toBe(afterLastRelease);
  });
});
