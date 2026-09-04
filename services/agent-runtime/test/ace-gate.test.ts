import { describe, expect, test } from "bun:test";
import { createToolLoopGuard, decideToolCall, isMutatingCommand, type ProjectRules } from "../src/ace/ace-gate";

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

  test("standard: edits and read-only shell pass, mutating shell asks the user (MET-933)", () => {
    expect(decideToolCall({ profile: "standard", cwd, toolName: "edit", args: { path: "a.ts" } }, NO_RULES).allow).toBe(true);
    expect(decideToolCall({ profile: "standard", cwd, toolName: "bash", args: { command: "bun test" } }, NO_RULES).allow).toBe(true);
    const asked = decideToolCall({ profile: "standard", cwd, toolName: "bash", args: { command: "rm -rf dist" } }, NO_RULES);
    expect(asked).toMatchObject({ allow: false, ask: true, access: "exec-write", source: "profile" });
    expect(decideToolCall({ profile: "safe", cwd, toolName: "bash", args: { command: "rm -rf dist" } }, NO_RULES)).not.toHaveProperty("ask");
  });

  test("bash classifier: read-only pipelines and null redirects are reads, real writes are writes", () => {
    const reads = [
      "find . -name '*.ts' 2>/dev/null; echo '---'; find . -name '*.md' | head -20",
      "ls -la > /dev/null 2>&1 && echo ok",
      "cat package.json | grep test | sort | uniq -c | wc -l",
      "git log --oneline | head -5; git status --short",
      "sed -n '1,20p' src/index.ts | tr -s ' ' | cut -d' ' -f1 | awk '{print $1}' | less",
      "find . -type f -newer a.txt -exec ls -l {} \\;",
      "curl -sS https://example.test/health | head -c 200",
    ];
    for (const command of reads) expect({ command, mutating: isMutatingCommand(command) }).toEqual({ command, mutating: false });
    const writes = [
      "echo hi > notes.txt",
      "cat a.txt >> log.txt",
      "ls | tee listing.txt",
      "find . -name '*.log' -delete",
      "find . -name '*.tmp' -exec rm {} \\;",
      "sed -i 's/a/b/' src/index.ts",
      "curl -o out.bin https://example.test/x",
      "npm install left-pad",
      "git checkout -b feature",
      "mkdir -p build 2>/dev/null",
    ];
    for (const command of writes) expect({ command, mutating: isMutatingCommand(command) }).toEqual({ command, mutating: true });
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
