import { describe, expect, test } from "bun:test";
import { createToolLoopGuard, decideToolCall, type ProjectRules } from "../src/ace/ace-gate";

const NO_RULES: ProjectRules = { commandAllowlist: [], toolAllowlist: [], toolDenylist: [] };
const cwd = "/tmp/ace-gate-test";

describe("ACE permission gate", () => {
  test("safe: reads pass, edits and shell writes are blocked unless the project allowlists them", () => {
    expect(decideToolCall({ profile: "safe", cwd, toolName: "read", args: { path: "a.ts" } }, NO_RULES).allow).toBe(true);
    expect(decideToolCall({ profile: "safe", cwd, toolName: "edit", args: { path: "a.ts" } }, NO_RULES).allow).toBe(false);
    expect(decideToolCall({ profile: "safe", cwd, toolName: "bash", args: { command: "ls -la" } }, NO_RULES).allow).toBe(false);
    const allowlisted = decideToolCall(
      { profile: "safe", cwd, toolName: "bash", args: { command: "git status --short" } },
      { ...NO_RULES, commandAllowlist: ["git status"] },
    );
    expect(allowlisted.allow).toBe(true);
  });

  test("standard: edits and read-only shell pass, mutating shell is blocked", () => {
    expect(decideToolCall({ profile: "standard", cwd, toolName: "edit", args: { path: "a.ts" } }, NO_RULES).allow).toBe(true);
    expect(decideToolCall({ profile: "standard", cwd, toolName: "bash", args: { command: "bun test" } }, NO_RULES).allow).toBe(true);
    const blocked = decideToolCall({ profile: "standard", cwd, toolName: "bash", args: { command: "rm -rf dist" } }, NO_RULES);
    expect(blocked).toMatchObject({ allow: false, access: "exec-write", source: "profile" });
  });

  test("autonomous: everything passes except the denylist and the safety gates", () => {
    expect(decideToolCall({ profile: "autonomous", cwd, toolName: "bash", args: { command: "rm -rf dist" } }, NO_RULES).allow).toBe(true);
    expect(
      decideToolCall({ profile: "autonomous", cwd, toolName: "bash", args: { command: "ls" } }, { ...NO_RULES, toolDenylist: ["bash"] }),
    ).toMatchObject({ allow: false, source: "denylist" });
    expect(
      decideToolCall({ profile: "autonomous", cwd, toolName: "bash", args: { command: "git commit --no-verify -m x" } }, NO_RULES),
    ).toMatchObject({ allow: false, source: "block-no-verify" });
    expect(
      decideToolCall({ profile: "autonomous", cwd, toolName: "bash", args: { command: "sed -i 's/a/b/' .eslintrc.json" } }, NO_RULES),
    ).toMatchObject({ allow: false, source: "config-protection" });
  });

  test("tool-loop guard trips on the Nth identical call and resets on a different one", () => {
    const guard = createToolLoopGuard(3);
    expect(guard.observe("bash", { command: "ls" }).tripped).toBe(false);
    expect(guard.observe("bash", { command: "ls" }).tripped).toBe(false);
    expect(guard.observe("bash", { command: "ls" })).toEqual({ tripped: true, count: 3 });
    expect(guard.observe("bash", { command: "pwd" })).toEqual({ tripped: false, count: 1 });
  });
});
