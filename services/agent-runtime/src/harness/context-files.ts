// Project context files for the system prompt, as pi-coding-agent's resource
// loader collected them (`loadProjectContextFiles`, 0.84.3): the agent dir's
// own file first, then one file per ancestor directory from the filesystem
// root down to cwd. Candidates per directory, first hit wins:
// AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD.
//
// Not ported: pi's linked-worktree rule that skips the main checkout's copy
// when a nested worktree carries its own (a dedupe for one git layout).

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface ContextFile {
  path: string;
  content: string;
}

function contextFileIn(dir: string): ContextFile | null {
  for (const filename of CANDIDATES) {
    const filePath = path.join(dir, filename);
    try {
      if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
      return { path: filePath, content: readFileSync(filePath, "utf8") };
    } catch {
      // Unreadable file: pi warned and moved on; so do we.
    }
  }
  return null;
}

export function loadProjectContextFiles(cwd: string, agentDir: string): ContextFile[] {
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  const global = contextFileIn(path.resolve(agentDir));
  if (global) {
    files.push(global);
    seen.add(global.path);
  }
  const ancestors: ContextFile[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = contextFileIn(dir);
    if (file && !seen.has(file.path)) {
      ancestors.unshift(file);
      seen.add(file.path);
    }
    if (path.dirname(dir) === dir) break;
  }
  return [...files, ...ancestors];
}

/** The `<project_context>` block pi appended to its system prompt, or null without context files. */
export function formatProjectContext(files: readonly ContextFile[]): string | null {
  if (files.length === 0) return null;
  const sections = files.map(
    (file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n`,
  );
  return `<project_context>\n\nProject-specific instructions and guidelines:\n\n${sections.join("\n")}\n</project_context>`;
}
