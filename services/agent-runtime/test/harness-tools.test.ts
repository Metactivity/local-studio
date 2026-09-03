// The grep / find / ls tools vendored from pi-coding-agent, on the harness
// execution env: output format, limits and the missing-binary error.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFindTool, createGrepTool, createLsTool } from "@local-studio/harness";
import { NodeExecutionEnv } from "@local-studio/harness/node";

let root: string;
let env: NodeExecutionEnv;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harness-tools-")));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "src", "a.ts"), "const alpha = 1;\nexport const beta = alpha + 1;\n");
  writeFileSync(join(root, "src", "deep", "b.ts"), "// beta again\nlet gamma = 'ALPHA';\n");
  writeFileSync(join(root, "README.md"), "# readme\n");
  env = new NodeExecutionEnv({ cwd: root });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = <T>(tool: { execute: (id: string, params: T, signal: undefined, onUpdate: undefined, ctx: { env: NodeExecutionEnv }) => Promise<{ content: Array<{ text?: string }>; details?: unknown }> }, params: T) =>
  tool.execute("call", params, undefined, undefined, { env });

const text = (result: { content: Array<{ text?: string }> }) => result.content[0]!.text!;

describe("vendored search tools", () => {
  test("grep returns file:line: text, honours ignoreCase, literal, context and the match limit", async () => {
    const grep = createGrepTool();
    expect(text(await run(grep, { pattern: "beta" }))).toBe("src/a.ts:2: export const beta = alpha + 1;\nsrc/deep/b.ts:1: // beta again");
    expect(text(await run(grep, { pattern: "alpha", ignoreCase: true, path: "src/deep" }))).toBe("b.ts:2: let gamma = 'ALPHA';");
    expect(text(await run(grep, { pattern: "alpha + 1", literal: true, glob: "*.ts" }))).toBe("src/a.ts:2: export const beta = alpha + 1;");
    expect(text(await run(grep, { pattern: "gamma", context: 1 }))).toBe("src/deep/b.ts-1- // beta again\nsrc/deep/b.ts:2: let gamma = 'ALPHA';\nsrc/deep/b.ts-3- ");
    const limited = await run(grep, { pattern: "beta", limit: 1 });
    expect(text(limited)).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
    expect(limited.details).toEqual({ matchLimitReached: 1 });
    expect(text(await run(grep, { pattern: "nothing-here" }))).toBe("No matches found");
    await expect(run(grep, { pattern: "x", path: "missing" })).rejects.toThrow("Path not found");
  });

  test("ls lists sorted entries with a directory suffix, dotfiles included, and caps entries", async () => {
    const ls = createLsTool();
    expect(text(await run(ls, {}))).toBe(".hidden/\nREADME.md\nsrc/");
    const capped = await run(ls, { path: "src", limit: 1 });
    expect(text(capped)).toBe("a.ts\n\n[1 entries limit reached. Use limit=2 for more]");
    expect(capped.details).toEqual({ entryLimitReached: 1 });
    await expect(run(ls, { path: "README.md" })).rejects.toThrow("Not a directory");
  });

  test.skipIf(Bun.which("fd") === null && Bun.which("fdfind") === null)("find matches globs relative to the search root", async () => {
    const find = createFindTool();
    expect(text(await run(find, { pattern: "*.ts" })).split("\n").sort()).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(text(await run(find, { pattern: "deep/*.ts", path: "src" }))).toBe("deep/b.ts");
    expect(text(await run(find, { pattern: "*.py" }))).toBe("No files found matching pattern");
  });

  test("a missing binary is an install hint, not a download", async () => {
    const previous = process.env.PI_FD_PATH;
    process.env.PI_FD_PATH = join(root, "no-such-fd");
    try {
      await expect(run(createFindTool(), { pattern: "*" })).rejects.toThrow("fd is not installed or not on PATH");
    } finally {
      if (previous === undefined) delete process.env.PI_FD_PATH;
      else process.env.PI_FD_PATH = previous;
    }
  });
});
