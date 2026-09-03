// The runtime sessions this process holds, keyed by the opaque runtime session
// id the frontend addresses (`default`, `subagent:<parent>:<run>`, …). Each is a
// HarnessSession with the goal driver attached; `piSessionId` is the persisted
// session it currently drives.

import { attachGoalDriver } from "./goal-driver";
import { HarnessSession, type PiAgentSession } from "./harness-runtime";
import { getGlobalSingleton } from "./instances";

type RuntimeLookupEntry = {
  sessionId: string;
  session: PiAgentSession;
};

function findRuntimeSessionForLookup(
  entries: Iterable<RuntimeLookupEntry>,
  sessionId: string,
  piSessionId?: string | null,
): RuntimeLookupEntry | null {
  const snapshot = [...entries];
  const exact = snapshot.find((entry) => entry.sessionId === sessionId);
  const target = piSessionId?.trim();
  if (!target) return exact ?? null;
  const matches = snapshot.filter(
    (entry) =>
      entry.session.status.piSessionId === target ||
      (entry.sessionId === sessionId && !entry.session.status.piSessionId),
  );
  return matches.reduce<RuntimeLookupEntry | null>(
    (best, candidate) =>
      !best || runtimeLookupOutranks(candidate, best, sessionId) ? candidate : best,
    null,
  );
}

function runtimeLookupOutranks(
  candidate: RuntimeLookupEntry,
  current: RuntimeLookupEntry,
  requestedSessionId: string,
): boolean {
  const candidateRank = runtimeLookupRank(candidate, requestedSessionId);
  const currentRank = runtimeLookupRank(current, requestedSessionId);
  for (let index = 0; index < candidateRank.length; index += 1) {
    if (candidateRank[index] !== currentRank[index]) {
      return candidateRank[index] > currentRank[index];
    }
  }
  return false;
}

function runtimeLookupRank(
  entry: RuntimeLookupEntry,
  requestedSessionId: string,
): [number, number, number, number] {
  return [
    entry.session.status.active === true ? 1 : 0,
    entry.session.status.running === true ? 1 : 0,
    entry.sessionId === requestedSessionId ? 1 : 0,
    entry.session.status.eventSeq ?? 0,
  ];
}

const DEFAULT_SESSION_ID = "default";

class RuntimeManager {
  private sessions = new Map<string, PiAgentSession>();

  getSession(sessionId = DEFAULT_SESSION_ID): PiAgentSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const created: PiAgentSession = new HarnessSession();
    attachGoalDriver(created);
    this.sessions.set(sessionId, created);
    return created;
  }

  getSessionForLookup(
    sessionId = DEFAULT_SESSION_ID,
    piSessionId?: string | null,
  ): { sessionId: string; session: PiAgentSession } {
    const resolved = this.findSessionForLookup(sessionId, piSessionId);
    if (resolved) return resolved;
    const target = piSessionId?.trim();
    const exactPiSessionId = this.sessions.get(sessionId)?.status.piSessionId;
    const runtimeSessionId =
      target && exactPiSessionId && exactPiSessionId !== target
        ? `${sessionId}:${target}`
        : sessionId;
    const session = this.getSession(runtimeSessionId);
    session.adoptPiSessionId(target);
    return { sessionId: runtimeSessionId, session };
  }

  findSessionForLookup(
    sessionId = DEFAULT_SESSION_ID,
    piSessionId?: string | null,
  ): { sessionId: string; session: PiAgentSession } | null {
    return findRuntimeSessionForLookup(this.listSessions(), sessionId, piSessionId);
  }

  listSessions(): Array<{ sessionId: string; session: PiAgentSession }> {
    return [...this.sessions.entries()].map(([sessionId, session]) => ({ sessionId, session }));
  }
}

/** Kept under its historical name: the http handlers, the scheduler and the subagent tools all address it. */
export const piRuntimeManager = getGlobalSingleton("piRuntimeManager", () => new RuntimeManager());
