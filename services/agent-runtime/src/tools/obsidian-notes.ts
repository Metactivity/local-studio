// The Obsidian vault as notes, for src/tools/obsidian.ts: vault discovery
// (Obsidian's own obsidian.json, or the list the runtime injected), path safety
// against the vault root, and the parts of a note a naive file-reader gets
// wrong — [[wikilinks]] resolve by NAME across the vault, frontmatter is
// metadata, #tags live in both places, `.obsidian/` is never touched.

import { readFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ToolContext } from "./context";

export type Vault = { path: string; name: string; open: boolean; lastOpened: string | null };

export const NOTE_EXT = ".md";
// A vault of a few thousand notes scans in well under a second; these bounds
// exist so a vault of a hundred thousand cannot stall a turn or bury the answer.
export const MAX_NOTES = 5_000;
export const MAX_NOTE_BYTES = 512 * 1024;
export const MAX_OUTPUT_CHARS = 60_000;
export const MAX_BODY_CHARS = 100_000;
export const EXCERPTS_PER_NOTE = 3;
export const EXCERPT_RADIUS = 70;

// ─── vault discovery ──────────────────────────────────────────────────────

export type Env = ToolContext["env"];

export function configPath(env: Env): string | null {
  const override = env.LOCAL_STUDIO_OBSIDIAN_CONFIG?.trim();
  if (override) return override;
  const home = homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  if (process.platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "obsidian", "obsidian.json");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "obsidian", "obsidian.json");
}

/** Parse obsidian.json ourselves — the fallback when no runtime injected a list. */
export function vaultsFromConfig(env: Env): Vault[] {
  const file = configPath(env);
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { vaults?: Record<string, unknown> };
    return Object.values(parsed.vaults ?? {})
      .map((entry) => entry as { path?: unknown; ts?: unknown; open?: unknown })
      .flatMap((entry): Vault[] => {
        if (typeof entry.path !== "string" || !entry.path.trim()) return [];
        const ts = typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : null;
        return [{ path: entry.path, name: path.basename(entry.path), open: entry.open === true, lastOpened: ts === null ? null : new Date(ts).toISOString() }];
      });
  } catch {
    // Missing file, or Obsidian mid-write. Either way: no vaults, not an error.
    return [];
  }
}

export function readVaults(env: Env): Vault[] {
  const injected = env.LOCAL_STUDIO_OBSIDIAN_VAULTS?.trim();
  if (injected) {
    try {
      const parsed = JSON.parse(injected) as Vault[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // Fall through to reading the config ourselves.
    }
  }
  return vaultsFromConfig(env).sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return (b.lastOpened ?? "").localeCompare(a.lastOpened ?? "");
  });
}

export const noVault = (env: Env) =>
  `No Obsidian vault found on this machine. Obsidian records its vaults in ${configPath(env) ?? "its config directory"}, and that file is missing, unreadable, or lists no folder that still exists. Obsidian is probably not installed, or has never opened a vault. Say that plainly — do not guess at a notes folder and do not create one.`;

/** A refusal is an answer, not a failure: a message the model can act on. */
export class Refusal extends Error {}

export function selectVault(vaults: Vault[], requested: string | undefined, env: Env): Vault {
  if (vaults.length === 0) throw new Refusal(noVault(env));
  const wanted = requested?.trim();
  if (!wanted) return vaults[0]!;
  const byPath = vaults.find((vault) => path.resolve(vault.path) === path.resolve(wanted));
  if (byPath) return byPath;
  const byName = vaults.filter((vault) => vault.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  const known = vaults.map((vault) => `${vault.name} (${vault.path})`).join(", ");
  if (byName.length > 1) throw new Refusal(`More than one vault is named "${wanted}". Pass its full path instead: ${known}.`);
  throw new Refusal(`No vault called "${wanted}". Known vaults: ${known}.`);
}

export type OpenVault = { vault: Vault; root: string };

/** Resolve the vault root through symlinks ONCE, so every containment check compares real paths. */
export async function openVault(vaults: Vault[], requested: string | undefined, env: Env): Promise<OpenVault> {
  const vault = selectVault(vaults, requested, env);
  try {
    return { vault, root: await realpath(vault.path) };
  } catch {
    throw new Refusal(
      `The vault "${vault.name}" is listed at ${vault.path}, but that directory cannot be read right now — an external or cloud volume is probably not mounted.`,
    );
  }
}

// ─── path safety ──────────────────────────────────────────────────────────

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A model-supplied note reference becomes an absolute path inside the vault, or a
 *  refusal. Traversal is rejected outright rather than clamped. */
export async function notePath(root: string, input: string): Promise<string> {
  const raw = input.trim();
  if (!raw) throw new Refusal("`note` is empty. Pass a vault-relative path or a note name.");
  if (path.isAbsolute(raw) || raw.startsWith("~")) {
    throw new Refusal(
      `"${raw}" is an absolute path. These tools take vault-relative paths ("Projects/Roadmap.md") or bare note names ("Roadmap"); the vault root is implicit.`,
    );
  }
  const target = path.resolve(root, raw.toLowerCase().endsWith(NOTE_EXT) ? raw : `${raw}${NOTE_EXT}`);
  if (!isInside(root, target)) throw new Refusal(`"${raw}" resolves outside the vault. These tools only touch files inside it.`);
  const hidden = path.relative(root, target).split(path.sep).find((segment) => segment.startsWith("."));
  if (hidden) {
    throw new Refusal(
      `"${raw}" is inside "${hidden}", which is not notes — .obsidian is the app's own configuration, .trash is deleted notes. These tools never read or write there.`,
    );
  }
  await assertRealPathInside(root, target);
  return target;
}

/** The textual check is defeated by a symlinked folder inside the vault, so re-check
 *  the deepest existing part of the path after resolving links. */
export async function assertRealPathInside(root: string, target: string): Promise<void> {
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!isInside(root, real)) {
        throw new Refusal(`"${path.relative(root, target)}" leaves the vault through a symlink (it resolves to ${real}). Refused.`);
      }
      return;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }
  }
}

// ─── the vault as notes ───────────────────────────────────────────────────

export type NoteFile = { rel: string; abs: string; name: string; modified: string; bytes: number };

/** Every note in the vault. Dot-directories and symlinks are skipped whole. */
export async function listNotes(root: string): Promise<{ notes: NoteFile[]; truncated: boolean }> {
  const notes: NoteFile[] = [];
  const queue: string[] = [""];
  let truncated = false;
  while (queue.length > 0) {
    const relDir = queue.shift()!;
    const entries = await readdir(path.join(root, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        queue.push(rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(NOTE_EXT)) continue;
      if (notes.length >= MAX_NOTES) {
        truncated = true;
        continue;
      }
      const abs = path.join(root, rel);
      const info = await stat(abs).catch(() => null);
      if (!info) continue;
      notes.push({ rel, abs, name: entry.name.slice(0, -NOTE_EXT.length), modified: new Date(info.mtimeMs).toISOString(), bytes: info.size });
    }
  }
  return { notes, truncated };
}

export async function readNote(note: NoteFile): Promise<string | null> {
  if (note.bytes > MAX_NOTE_BYTES) return null;
  return readFile(note.abs, "utf8").catch(() => null);
}

export type Fields = Record<string, string | string[]>;
export type Frontmatter = { fields: Fields; body: string; present: boolean };

/** Split the leading `---` block off. Everything after it is the note's prose. */
export function splitFrontmatter(text: string): Frontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { fields: {}, body: text, present: false };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { fields: {}, body: text, present: false };
  return { fields: parseFields(lines.slice(1, end)), body: lines.slice(end + 1).join("\n"), present: true };
}

export const unquote = (value: string): string => value.trim().replace(/^["']|["']$/g, "").trim();

/** A deliberate subset of YAML: `key: value`, `key: [a, b]`, and `key:` followed by
 *  `- item` lines — what Obsidian's own property editor writes. Nested maps are not
 *  parsed rather than half-parsed into something wrong. */
export function parseFields(lines: string[]): Fields {
  const fields: Fields = {};
  let key: string | null = null;
  for (const line of lines) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key) {
      const current = fields[key];
      const value = unquote(item[1] ?? "");
      if (!value) continue;
      fields[key] = Array.isArray(current) ? [...current, value] : current ? [current, value] : [value];
      continue;
    }
    const pair = /^([A-Za-z0-9_.\- ]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    key = (pair[1] ?? "").trim();
    const raw = (pair[2] ?? "").trim();
    if (!raw) {
      fields[key] = [];
      continue;
    }
    fields[key] = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1).split(",").map(unquote).filter(Boolean) : unquote(raw);
  }
  return fields;
}

export function fieldList(fields: Fields, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = fields[key];
    if (Array.isArray(value)) out.push(...value);
    else if (typeof value === "string") out.push(...value.split(/[,\s]+/));
  }
  return out.map((entry) => entry.replace(/^#/, "").trim()).filter(Boolean);
}

// Inline tags: `#project/alpha` in the prose. The leading boundary keeps `#` in a
// URL fragment and a markdown heading (`# Title`, which has a space) out.
export const INLINE_TAG = /(?:^|[\s(\[>])#([\p{L}\p{N}][\p{L}\p{N}_\-/]*)/gu;

/** Obsidian requires a tag to contain a non-numeric character — `PR #425` is not a tag. */
export const isTag = (value: string): boolean => value.length > 0 && !/^\d+$/.test(value);

/** A note's tags are the union of its frontmatter tags and its inline ones. */
export function tagsOf(fields: Fields, body: string): string[] {
  const tags = new Set(fieldList(fields, "tags", "tag").filter(isTag));
  for (const match of body.matchAll(INLINE_TAG)) if (match[1] && isTag(match[1])) tags.add(match[1]);
  return [...tags].sort((a, b) => a.localeCompare(b));
}

export type Wikilink = { text: string; target: string; heading: string | null; alias: string | null; embed: boolean };

export const WIKILINK = /(!?)\[\[([^\]\n]+)\]\]/g;

export function linksOf(body: string): Wikilink[] {
  const links: Wikilink[] = [];
  for (const match of body.matchAll(WIKILINK)) {
    const [beforeAlias, alias] = splitOnce(match[2] ?? "", "|");
    const [target, heading] = splitOnce(beforeAlias, "#");
    if (!target.trim()) continue;
    links.push({ text: match[0], target: target.trim(), heading: heading?.trim() || null, alias: alias?.trim() || null, embed: match[1] === "!" });
  }
  return links;
}

export function splitOnce(value: string, separator: string): [string, string | null] {
  const index = value.indexOf(separator);
  return index === -1 ? [value, null] : [value.slice(0, index), value.slice(index + 1)];
}

export type NoteIndex = { byPath: Map<string, NoteFile>; byName: Map<string, NoteFile[]> };

export function buildIndex(notes: NoteFile[]): NoteIndex {
  const byPath = new Map<string, NoteFile>();
  const byName = new Map<string, NoteFile[]>();
  for (const note of notes) {
    byPath.set(note.rel.slice(0, -NOTE_EXT.length).split(path.sep).join("/").toLowerCase(), note);
    const key = note.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), note]);
  }
  return { byPath, byName };
}

export type Resolution = { path: string | null; ambiguous?: string[] };

/** Obsidian's order: an exact path when the link contains one, else the shortest
 *  path among notes sharing the name; an ambiguous name says so. */
export function resolveLink(index: NoteIndex, target: string): Resolution {
  const cleaned = target.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "");
  const exact = index.byPath.get(cleaned.toLowerCase());
  if (exact) return { path: exact.rel };
  const base = cleaned.split("/").pop() ?? cleaned;
  const matches = [...(index.byName.get(base.toLowerCase()) ?? [])].sort((a, b) => a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  if (matches.length === 0) return { path: null };
  const [best, ...rest] = matches;
  return rest.length > 0 ? { path: best!.rel, ambiguous: rest.map((note) => note.rel) } : { path: best!.rel };
}

/** A note's title is its filename unless the frontmatter names another. */
export function titleOf(name: string, fields: Fields): string {
  const title = fields.title;
  return typeof title === "string" && title ? title : name;
}

export function excerptsFor(body: string, query: string): string[] {
  const haystack = body.toLowerCase();
  const needle = query.toLowerCase();
  const out: string[] = [];
  let from = 0;
  while (out.length < EXCERPTS_PER_NOTE) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    const start = Math.max(0, at - EXCERPT_RADIUS);
    const end = Math.min(body.length, at + needle.length + EXCERPT_RADIUS);
    const snippet = body.slice(start, end).replace(/\s+/g, " ").trim();
    out.push(`${start > 0 ? "…" : ""}${snippet}${end < body.length ? "…" : ""}`);
    from = at + needle.length;
  }
  return out;
}

export const inFolder = (notes: NoteFile[], folder: string | undefined): NoteFile[] => {
  const cleaned = folder?.trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) return notes;
  return notes.filter((note) => note.rel.split(path.sep).join("/").toLowerCase().startsWith(`${cleaned.toLowerCase()}/`));
};

// ─── result plumbing ──────────────────────────────────────────────────────

export function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated at ${MAX_OUTPUT_CHARS} characters — narrow the query or lower the limit]`;
}

export function limitOf(value: number | undefined, fallback: number, max: number): number {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(requested)));
}

