import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProjectContext, loadProjectContextFiles } from "../src/harness/context-files";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "context-files-"));
  mkdirSync(join(root, "agent"));
  mkdirSync(join(root, "repo", "pkg"), { recursive: true });
  writeFileSync(join(root, "agent", "AGENTS.md"), "global rules");
  writeFileSync(join(root, "repo", "CLAUDE.md"), "repo rules");
  writeFileSync(join(root, "repo", "AGENTS.override.md"), "override wins");
  writeFileSync(join(root, "repo", "pkg", "AGENTS.md"), "pkg rules");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("project context files", () => {
  test("agent dir first, then ancestors root-down, first candidate per directory", () => {
    const files = loadProjectContextFiles(join(root, "repo", "pkg"), join(root, "agent"));
    expect(files.map((file) => [file.path.slice(root.length), file.content])).toEqual([
      ["/agent/AGENTS.md", "global rules"],
      ["/repo/AGENTS.override.md", "override wins"],
      ["/repo/pkg/AGENTS.md", "pkg rules"],
    ]);
    expect(formatProjectContext(files)).toContain(`<project_instructions path="${join(root, "repo", "pkg", "AGENTS.md")}">\npkg rules\n</project_instructions>`);
    expect(formatProjectContext([])).toBeNull();
  });
});
