//
// Server-side session-goal injection.
//
// `/goal <objective>` stores an objective per session; goal-driver.ts
// re-prompts the agent whenever it settles. On a turn the user types
// themselves the model would never see the objective, so the harness driver
// registers `goalSystemContext` as a transform_context contribution
// (src/harness-runtime.ts): it runs once per prompt and reads the goal live,
// keyed by the same canonical session id the store writes, so mid-session
// edits and budget/turn changes land on the next turn.
//

import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir";

const MARKER = "Local Studio session goal:";

/** The one status where the goal steers the turn. Every other status stays in
 *  the store (so the UI can show and resume it) but must not keep pushing the
 *  model — including `budget_limited`, which used to keep injecting "the budget
 *  is spent, do not start new work" into every later turn the USER typed, long
 *  after the automatic pursuit had stopped. */
const STEERING_STATUSES = new Set(["active"]);

/** Loose shape: the on-disk goal is normalized elsewhere, but the pure builder
 *  must tolerate partial/legacy documents so a bad field never crashes a turn. */
export type GoalPromptInput = {
  objective?: unknown;
  status?: unknown;
  turnBudget?: unknown;
  turnsUsed?: unknown;
};

/** Codex wraps the objective in tags and states plainly that it is instruction,
 *  not data, then reports budget so the model can pace itself.
 *
 *  This is the only copy. A second, byte-identical builder used to sit in
 *  frontend/desktop/resources/pi-extensions/goal.ts from when injection was a
 *  bundled extension; it was registered nowhere and could only drift. */
export function goalSystemPromptSection(goal: GoalPromptInput): string | null {
  const objective = typeof goal.objective === "string" ? goal.objective.trim() : "";
  if (!objective) return null;
  const status = typeof goal.status === "string" ? goal.status : "active";
  if (!STEERING_STATUSES.has(status)) return null;

  const lines = [
    MARKER,
    "You are working toward a standing objective for this session. It applies to",
    "every turn, including ones the user starts. Keep it in view when you decide",
    "what to do next, and prefer work that advances it.",
    "",
    `<objective>${objective}</objective>`,
  ];

  const turnsUsed = typeof goal.turnsUsed === "number" ? goal.turnsUsed : 0;
  const turnBudget = typeof goal.turnBudget === "number" ? goal.turnBudget : null;
  if (turnBudget !== null) {
    lines.push("", `Turn budget: ${turnsUsed} of ${turnBudget} used.`);
  } else if (turnsUsed > 0) {
    lines.push("", `Turns spent on this goal so far: ${turnsUsed}.`);
  }

  lines.push(
    "",
    "Before claiming the objective is met, audit it against concrete evidence —",
    "files written, command output, and runtime evidence — not intent. Say GOAL_COMPLETE only",
    "when that evidence exists, and GOAL_BLOCKED with the reason only when you",
    "genuinely cannot proceed.",
  );

  return lines.join("\n");
}

/** goals-store keys files as <dataDir>/goals/<piSessionId>.json (see
 *  session-json-store). readGoal there is async; the per-turn hook needs a
 *  synchronous read, so mirror the same path + id rules here. */
function goalFilePath(piSessionId: string): string | null {
  const id = piSessionId.trim();
  if (!id || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) return null;
  return path.join(resolveDataDir(), "goals", `${id}.json`);
}

export function readGoalSync(piSessionId: string): GoalPromptInput | null {
  const file = goalFilePath(piSessionId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as GoalPromptInput) : null;
  } catch {
    // No goal for this session (the common case) — stay silent.
    return null;
  }
}

/** The steering section for `piSessionId`, or null when there is nothing to add
 *  (no goal, or a non-steering status). */
export function goalSystemContext(piSessionId: string): string | null {
  const goal = readGoalSync(piSessionId);
  return goal ? goalSystemPromptSection(goal) : null;
}
