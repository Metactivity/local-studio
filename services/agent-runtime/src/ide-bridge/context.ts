// The latest editor state per workspace folder (ADR-034 M5): what the IDE last
// told us, kept as state rather than a stream so a reconnect costs nothing and
// the next turn reads one snapshot. Pure — no socket, no ACE — so the block
// bound and the event folding are unit-testable.

import type { IdeEvents } from "@metactivity/protocol";

export interface IdeContext {
  sessionId: string;
  extensionVersion: string;
  connectedAt: string;
  updatedAt: string;
  activeEditor: IdeEvents["ide.editor.active"];
  tabs: string[];
  lastSaved: string | null;
  /** Per-uri summaries, only files with at least one error or warning. */
  diagnostics: Record<string, { errors: number; warnings: number }>;
  scm: IdeEvents["ide.scm.changed"] | null;
}

export const IDE_CONTEXT_MAX_CHARS = 1_500;

export function emptyContext(hello: { sessionId: string; extensionVersion: string }, now = new Date()): IdeContext {
  const at = now.toISOString();
  return {
    sessionId: hello.sessionId,
    extensionVersion: hello.extensionVersion,
    connectedAt: at,
    updatedAt: at,
    activeEditor: null,
    tabs: [],
    lastSaved: null,
    diagnostics: {},
    scm: null,
  };
}

/** Folds one IDE event into the context; unknown or malformed events leave it untouched. */
export function applyIdeEvent(context: IdeContext, method: string, params: unknown, now = new Date()): IdeContext {
  const next: IdeContext = { ...context, updatedAt: now.toISOString() };
  const record = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "ide.editor.active":
      next.activeEditor = params === null || typeof record.uri === "string" ? (params as IdeContext["activeEditor"]) : context.activeEditor;
      break;
    case "ide.editor.tabs":
      next.tabs = Array.isArray(record.uris) ? record.uris.filter((uri): uri is string => typeof uri === "string") : context.tabs;
      break;
    case "ide.document.saved":
      if (typeof record.uri === "string") next.lastSaved = record.uri;
      break;
    case "ide.diagnostics.changed": {
      const summary = record.summary as { errors?: unknown; warnings?: unknown } | undefined;
      if (typeof record.uri !== "string" || !summary) break;
      const errors = Number(summary.errors) || 0;
      const warnings = Number(summary.warnings) || 0;
      const diagnostics = { ...context.diagnostics };
      if (errors + warnings > 0) diagnostics[record.uri] = { errors, warnings };
      else delete diagnostics[record.uri];
      next.diagnostics = diagnostics;
      break;
    }
    case "ide.scm.changed":
      if (Array.isArray(record.changes)) next.scm = params as IdeContext["scm"];
      break;
    default:
      return context;
  }
  return next;
}

const fsPath = (uri: string): string => {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:" ? decodeURIComponent(parsed.pathname) : uri;
  } catch {
    return uri;
  }
};

const relative = (uri: string, folder: string): string => {
  const path = fsPath(uri);
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
};

export function diagnosticsTotals(context: IdeContext): { errors: number; warnings: number; files: number } {
  let errors = 0;
  let warnings = 0;
  for (const summary of Object.values(context.diagnostics)) {
    errors += summary.errors;
    warnings += summary.warnings;
  }
  return { errors, warnings, files: Object.keys(context.diagnostics).length };
}

/**
 * The `<ide-context>` block for the system prompt, next to `<ace-context>`.
 * Bounded: lines are added in priority order until the budget is spent.
 */
export function ideContextBlock(context: IdeContext, folder: string, maxChars = IDE_CONTEXT_MAX_CHARS): string | null {
  const lines: string[] = [];
  const editor = context.activeEditor;
  if (editor) {
    const { start, end } = editor.selection;
    const selection =
      start.line === end.line && start.character === end.character
        ? `cursor at line ${start.line + 1}`
        : `selection lines ${start.line + 1}-${end.line + 1}`;
    lines.push(`- [active] ${relative(editor.uri, folder)} (${editor.languageId}, ${selection})`);
  }
  const totals = diagnosticsTotals(context);
  if (totals.files > 0) {
    const worst = Object.entries(context.diagnostics)
      .sort((a, b) => b[1].errors - a[1].errors || b[1].warnings - a[1].warnings)
      .slice(0, 5)
      .map(([uri, summary]) => `${relative(uri, folder)} (${summary.errors}E/${summary.warnings}W)`);
    lines.push(`- [diagnostics] ${totals.errors} error(s), ${totals.warnings} warning(s) in ${totals.files} file(s): ${worst.join(", ")}`);
  }
  if (context.scm) {
    const changed = context.scm.changes.slice(0, 10).map((change) => relative(change.uri, folder));
    const more = context.scm.changes.length > 10 ? `, +${context.scm.changes.length - 10} more` : "";
    lines.push(
      `- [git] branch ${context.scm.branch ?? "(detached)"} +${context.scm.ahead}/-${context.scm.behind}, ${context.scm.changes.length} change(s)${changed.length ? `: ${changed.join(", ")}${more}` : ""}`,
    );
  }
  if (context.tabs.length > 0) lines.push(`- [tabs] ${context.tabs.slice(0, 10).map((uri) => relative(uri, folder)).join(", ")}`);
  if (context.lastSaved) lines.push(`- [saved] ${relative(context.lastSaved, folder)}`);
  if (lines.length === 0) return null;

  const budget = maxChars - "<ide-context>\n</ide-context>".length;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > budget) {
      if (kept.length === 0) kept.push(`${line.slice(0, Math.max(0, budget - 2))}…`);
      break;
    }
    kept.push(line);
    used += cost;
  }
  return ["<ide-context>", ...kept, "</ide-context>"].join("\n");
}
