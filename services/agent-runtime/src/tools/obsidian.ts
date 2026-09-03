// obsidian — the user's Obsidian vault, which is a folder of markdown files. No
// process, no API: Obsidian is a viewer over a directory and picks changes up on
// its own. Writes are conservative: no delete, no overwrite (`obsidian_create`
// opens with `wx`), `obsidian_append` refuses a missing note, and every
// model-supplied path is resolved against the vault root and re-checked after
// symlinks (src/tools/obsidian-notes.ts). Registered only where Obsidian has a
// vault (the runtime's gate).
//
// Ported from pi-extensions/obsidian.ts; names, descriptions and schemas unchanged.

import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import { asText, type HarnessTool, type ToolContext, type ToolResult } from "./context";
import {
  buildIndex,
  configPath,
  type Env,
  EXCERPTS_PER_NOTE,
  excerptsFor,
  fieldList,
  inFolder,
  limitOf,
  linksOf,
  listNotes,
  MAX_BODY_CHARS,
  MAX_NOTES,
  NOTE_EXT,
  notePath,
  noVault,
  openVault,
  readNote,
  readVaults,
  Refusal,
  resolveLink,
  splitFrontmatter,
  tagsOf,
  titleOf,
  truncate,
  type Vault,
} from "./obsidian-notes";

// ─── tools ────────────────────────────────────────────────────────────────

type ToolSpec<S extends TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: S;
  run: (params: Static<S>, vaults: Vault[], env: Env) => Promise<unknown>;
};

const define = <S extends TSchema>(spec: ToolSpec<S>): ToolSpec<S> => spec;

const vaultParam = Type.Optional(
  Type.String({
    description: "Which vault, by folder name or full path. Omit for the vault open in Obsidian, or the most recently opened one.",
  }),
);
const noteParam = Type.String({
  description:
    'Vault-relative path ("Projects/Roadmap.md") or just the note name ("Roadmap"), resolved by name across the vault the way a [[wikilink]] is.',
});
const limitNotesParam = Type.Optional(Type.Number({ description: "Maximum notes to return (default 20)" }));

const TOOLS = [
  define({
    name: "obsidian_vaults",
    label: "Obsidian: Vaults",
    description:
      "List the Obsidian vaults on this machine: path, folder name, whether each is open in Obsidian right now, when it was last opened, and how many notes it holds. The first is the default every other obsidian_* tool uses when no `vault` is given. Call it when the user has more than one vault, or when a note you were sure existed cannot be found — the usual cause is looking in the wrong vault, not a bad name.",
    parameters: Type.Object({}),
    run: async (_params, vaults, env) => {
      if (vaults.length === 0) throw new Refusal(noVault(env));
      const listed = await Promise.all(
        vaults.map(async (vault, index) => {
          const root = await realpath(vault.path).catch(() => null);
          if (!root) return { ...vault, default: index === 0, readable: false as const };
          const { notes, truncated } = await listNotes(root);
          return { ...vault, default: index === 0, readable: true as const, notes: notes.length, ...(truncated ? { notesTruncatedAt: MAX_NOTES } : {}) };
        }),
      );
      return { vaults: listed, config: configPath(env) };
    },
  }),
  define({
    name: "obsidian_search",
    label: "Obsidian: Search",
    description:
      "Search the vault for notes by title, by content, or both, and return each hit's vault-relative path with the passages that matched. This is the way in: note paths are the user's own folder and naming habits, so search before you read rather than guessing a filename. Matching is case-insensitive substring. A query starting with `#` also matches tags declared in a note's YAML frontmatter, not only the inline ones in its text, and a match in frontmatter or in an alias is reported as such instead of being passed off as a passage from the note. `.obsidian/` is the app's own configuration and is never searched.",
    parameters: Type.Object({
      query: Type.String({ description: "Text to look for; `#tag` also matches frontmatter tags" }),
      vault: vaultParam,
      scope: Type.Optional(
        Type.Union([Type.Literal("both"), Type.Literal("title"), Type.Literal("content")], { description: "Where to look (default both)" }),
      ),
      folder: Type.Optional(Type.String({ description: 'Restrict to a vault-relative folder, e.g. "Daily Notes"' })),
      limit: limitNotesParam,
    }),
    run: async (params, vaults, env) => {
      const query = params.query.trim();
      if (!query) throw new Refusal("`query` is empty.");
      const { vault, root } = await openVault(vaults, params.vault, env);
      const scope = params.scope ?? "both";
      const limit = limitOf(params.limit, 20, 100);
      const { notes, truncated } = await listNotes(root);
      const needle = query.toLowerCase();
      const tagQuery = query.startsWith("#") ? query.slice(1).toLowerCase() : null;
      const scoped = inFolder(notes, params.folder);

      const matches: Array<Record<string, unknown>> = [];
      for (const note of scoped) {
        const titleHit = scope !== "content" && note.name.toLowerCase().includes(needle);
        const text = scope === "title" && !titleHit ? null : await readNote(note);
        if (text === null) {
          if (titleHit) matches.push({ path: note.rel, title: note.name, modified: note.modified, matched: ["title"] });
          continue;
        }
        const { fields, body } = splitFrontmatter(text);
        const tags = tagsOf(fields, body);
        const aliases = fieldList(fields, "aliases", "alias");
        const title = titleOf(note.name, fields);
        const matched: string[] = [];
        if (scope !== "content" && (titleHit || title.toLowerCase().includes(needle))) matched.push("title");
        if (aliases.some((alias) => alias.toLowerCase().includes(needle))) matched.push("alias");
        if (tagQuery && tags.some((tag) => tag.toLowerCase().includes(tagQuery))) matched.push("tag");
        const excerpts = scope === "title" ? [] : excerptsFor(body, query);
        if (excerpts.length > 0) matched.push("body");
        if (matched.length === 0) continue;
        matches.push({
          path: note.rel,
          title,
          modified: note.modified,
          matched,
          ...(tags.length > 0 ? { tags } : {}),
          ...(aliases.length > 0 ? { aliases } : {}),
          ...(excerpts.length > 0 ? { excerpts } : {}),
        });
      }

      // Title hits first, then the notes with the most passages, then the most recent.
      matches.sort((a, b) => {
        const titleDelta = Number((b.matched as string[]).includes("title")) - Number((a.matched as string[]).includes("title"));
        if (titleDelta !== 0) return titleDelta;
        const excerptDelta = ((b.excerpts as string[] | undefined)?.length ?? 0) - ((a.excerpts as string[] | undefined)?.length ?? 0);
        if (excerptDelta !== 0) return excerptDelta;
        return String(b.modified).localeCompare(String(a.modified));
      });

      return {
        vault: vault.name,
        query,
        scope,
        scanned: scoped.length,
        found: matches.length,
        ...(truncated ? { vaultTruncatedAt: MAX_NOTES } : {}),
        matches: matches.slice(0, limit),
      };
    },
  }),
  define({
    name: "obsidian_read",
    label: "Obsidian: Read Note",
    description:
      "Read one note: its body, its YAML frontmatter split out as metadata with tags and aliases pulled from it, the inline #tags in its text, and its [[wikilinks]] already resolved to the vault paths they point at. Takes a vault-relative path or a bare note name, so a link you saw in another note can be passed straight through. Frontmatter is returned as fields rather than left at the top of the body, because it is metadata — quoting it back as if the note opened with it misreads the note.",
    parameters: Type.Object({ note: noteParam, vault: vaultParam }),
    run: async (params, vaults, env) => {
      const { vault, root } = await openVault(vaults, params.vault, env);
      const { notes } = await listNotes(root);
      const index = buildIndex(notes);
      const resolved = resolveLink(index, params.note.trim());
      const rel = resolved.path;
      if (!rel) {
        // Fall back to the literal path so traversal is refused rather than reported as "not found".
        await notePath(root, params.note);
        throw new Refusal(
          `No note matching "${params.note}" in vault "${vault.name}". Search for it with obsidian_search — vault paths follow the user's own folder names.`,
        );
      }
      const abs = await notePath(root, rel);
      const text = await readFile(abs, "utf8").catch(() => null);
      if (text === null) throw new Refusal(`"${rel}" could not be read.`);
      const { fields, body, present } = splitFrontmatter(text);
      const links = linksOf(body).map((link) => {
        const target = resolveLink(index, link.target);
        return {
          text: link.text,
          target: link.target,
          ...(link.alias ? { alias: link.alias } : {}),
          ...(link.heading ? { heading: link.heading } : {}),
          ...(link.embed ? { embed: true } : {}),
          path: target.path,
          ...(target.ambiguous ? { alsoMatches: target.ambiguous } : {}),
          ...(target.path ? {} : { unresolved: true }),
        };
      });
      const info = notes.find((note) => note.rel === rel);
      return {
        vault: vault.name,
        path: rel,
        ...(resolved.ambiguous ? { alsoMatches: resolved.ambiguous } : {}),
        title: titleOf(path.basename(rel, NOTE_EXT), fields),
        modified: info?.modified ?? null,
        frontmatter: present ? fields : null,
        tags: tagsOf(fields, body),
        aliases: fieldList(fields, "aliases", "alias"),
        links,
        body: body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body,
        ...(body.length > MAX_BODY_CHARS ? { bodyTruncatedAt: MAX_BODY_CHARS } : {}),
      };
    },
  }),
  define({
    name: "obsidian_recent",
    label: "Obsidian: Recent Notes",
    description:
      'List the notes modified most recently, newest first, with their paths, titles, tags and a first line of preview. The right first call when the user talks about their notes without naming one — it shows what they have actually been working on, which is usually what they mean by "my notes".',
    parameters: Type.Object({
      vault: vaultParam,
      limit: limitNotesParam,
      folder: Type.Optional(Type.String({ description: "Restrict to a vault-relative folder" })),
    }),
    run: async (params, vaults, env) => {
      const { vault, root } = await openVault(vaults, params.vault, env);
      const limit = limitOf(params.limit, 20, 100);
      const { notes, truncated } = await listNotes(root);
      const scoped = inFolder(notes, params.folder);
      const recent = [...scoped].sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit);
      const detailed = await Promise.all(
        recent.map(async (note) => {
          const text = await readNote(note);
          if (text === null) return { path: note.rel, title: note.name, modified: note.modified, bytes: note.bytes };
          const { fields, body } = splitFrontmatter(text);
          const preview = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
          const tags = tagsOf(fields, body);
          return {
            path: note.rel,
            title: titleOf(note.name, fields),
            modified: note.modified,
            bytes: note.bytes,
            ...(tags.length > 0 ? { tags } : {}),
            ...(preview ? { preview: preview.slice(0, 160) } : {}),
          };
        }),
      );
      return { vault: vault.name, total: scoped.length, ...(truncated ? { vaultTruncatedAt: MAX_NOTES } : {}), notes: detailed };
    },
  }),
  define({
    name: "obsidian_backlinks",
    label: "Obsidian: Backlinks",
    description:
      "List the notes that link TO a given note, with the line each link sits on. Backlinks are how a vault is actually organised: Obsidian resolves [[wikilinks]] by note name across the whole vault, so a note's real neighbours are rarely the files next to it in a folder. Use it to find the context a note is used in before summarizing or changing it.",
    parameters: Type.Object({ note: noteParam, vault: vaultParam }),
    run: async (params, vaults, env) => {
      const { vault, root } = await openVault(vaults, params.vault, env);
      const { notes } = await listNotes(root);
      const index = buildIndex(notes);
      const resolved = resolveLink(index, params.note.trim());
      if (!resolved.path) throw new Refusal(`No note matching "${params.note}" in vault "${vault.name}".`);
      const targetRel = resolved.path;
      const backlinks: Array<Record<string, unknown>> = [];
      for (const note of notes) {
        if (note.rel === targetRel) continue;
        const text = await readNote(note);
        if (text === null) continue;
        const contexts: string[] = [];
        for (const line of splitFrontmatter(text).body.split(/\r?\n/)) {
          if (linksOf(line).some((link) => resolveLink(index, link.target).path === targetRel)) contexts.push(line.trim().slice(0, 240));
          if (contexts.length >= EXCERPTS_PER_NOTE) break;
        }
        if (contexts.length > 0) backlinks.push({ path: note.rel, title: note.name, contexts });
      }
      return { vault: vault.name, note: targetRel, count: backlinks.length, backlinks };
    },
  }),
  define({
    name: "obsidian_create",
    label: "Obsidian: Create Note",
    description:
      "Create a NEW note in the vault. Refuses if anything already exists at that path — it will never overwrite a note, and the refusal names the existing file so you can obsidian_append to it or pick another name. Missing folders in the path are created. `tags` and `aliases` are written as YAML frontmatter at the top, which is where Obsidian reads metadata from; putting them in the body instead makes them invisible to its search and graph. Only ever create a note the user asked for, in the vault and folder they meant.",
    parameters: Type.Object({
      note: Type.String({
        description: 'Vault-relative path for the new note, e.g. "Projects/Roadmap" or "Roadmap.md". Folders are created as needed.',
      }),
      content: Type.String({ description: "Markdown body of the note" }),
      vault: vaultParam,
      tags: Type.Optional(Type.Array(Type.String(), { description: "Frontmatter tags, without the leading #" })),
      aliases: Type.Optional(Type.Array(Type.String(), { description: "Frontmatter aliases — other names this note answers to" })),
    }),
    run: async (params, vaults, env) => {
      const { vault, root } = await openVault(vaults, params.vault, env);
      const abs = await notePath(root, params.note);
      const rel = path.relative(root, abs);
      const tags = (params.tags ?? []).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean);
      const aliases = (params.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
      const frontmatter =
        tags.length === 0 && aliases.length === 0
          ? ""
          : `---\n${tags.length > 0 ? `tags: [${tags.join(", ")}]\n` : ""}${aliases.length > 0 ? `aliases: [${aliases.join(", ")}]\n` : ""}---\n\n`;
      const body = params.content.endsWith("\n") ? params.content : `${params.content}\n`;
      await mkdir(path.dirname(abs), { recursive: true });
      try {
        // "wx" makes the filesystem itself refuse an existing path — no check-then-write race.
        await writeFile(abs, `${frontmatter}${body}`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
          throw new Refusal(
            `"${rel}" already exists in vault "${vault.name}" and was NOT touched. Add to it with obsidian_append, or create the note under a different name.`,
          );
        }
        throw error;
      }
      return { vault: vault.name, created: rel, bytes: Buffer.byteLength(`${frontmatter}${body}`) };
    },
  }),
  define({
    name: "obsidian_append",
    label: "Obsidian: Append to Note",
    description:
      "Append text to the end of an existing note, separated from what is already there by a blank line. Refuses when the note does not exist, so a mistyped name creates nothing — use obsidian_create for a new note. This is the only way these tools change a note that already exists: there is no overwrite, no edit-in-place, and no delete, because the vault is the user's own writing and a wrong edit is not recoverable from here.",
    parameters: Type.Object({ note: noteParam, content: Type.String({ description: "Markdown to append" }), vault: vaultParam }),
    run: async (params, vaults, env) => {
      const { vault, root } = await openVault(vaults, params.vault, env);
      const { notes } = await listNotes(root);
      const resolved = resolveLink(buildIndex(notes), params.note.trim());
      const abs = await notePath(root, resolved.path ?? params.note);
      const existing = await readFile(abs, "utf8").catch(() => null);
      if (existing === null) {
        throw new Refusal(
          `No note at "${path.relative(root, abs)}" in vault "${vault.name}", so nothing was appended. Create it with obsidian_create, or find the right note with obsidian_search.`,
        );
      }
      const addition = params.content.endsWith("\n") ? params.content : `${params.content}\n`;
      const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      await appendFile(abs, `${separator}${addition}`, "utf8");
      return { vault: vault.name, appended: path.relative(root, abs), bytes: Buffer.byteLength(`${separator}${addition}`) };
    },
  }),
];

// ─── registration ─────────────────────────────────────────────────────────

export function obsidianTools(ctx: ToolContext): HarnessTool[] {
  // Resolved once per session; an empty list means the config went away
  // mid-session and every tool then answers with the NO_VAULT report.
  const vaults = readVaults(ctx.env);
  return TOOLS.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id, params): Promise<ToolResult> {
      const detailBase = { tool: tool.name, params: (params ?? {}) as Record<string, unknown> };
      try {
        const data = await tool.run(params as never, vaults, ctx.env);
        return { content: [{ type: "text", text: truncate(asText(data)) }], details: { ...detailBase, data } };
      } catch (error) {
        if (error instanceof Refusal) {
          return { content: [{ type: "text", text: error.message }], details: { ...detailBase, refused: true, failed: true } };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `${tool.name} failed: ${message}` }], details: { ...detailBase, error: message, failed: true } };
      }
    },
  }));
}
