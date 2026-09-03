// The IDE actions as harness tools (ADR-034 M5), read/navigate only: they
// exist for a turn only while an IDE is connected for the session's folder.
// The ACE gate classifies them as reads (not in its write set), so every
// profile allows them.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import type { IdeActionName, IdeActionParams } from "@metactivity/protocol";
import { ideBridge, type IdeBridgeServer } from "../ide-bridge/server";
import { asText, failure, type HarnessTool, textResult } from "./context";

type ToolSpec<S extends TSchema, M extends IdeActionName> = {
  name: string;
  label: string;
  description: string;
  parameters: S;
  method: M;
  /** Model params → wire params; throws to reject a call before it reaches the IDE. */
  params: (params: Static<S>, cwd: string) => IdeActionParams<M>;
  timeoutMs?: number;
};

const define = <S extends TSchema, M extends IdeActionName>(spec: ToolSpec<S, M>): ToolSpec<S, M> => spec;

const position = Type.Object({ line: Type.Number({ description: "0-based line" }), character: Type.Number({ description: "0-based column" }) });
const range = Type.Object({ start: position, end: position });
const pathParam = Type.String({ description: "Workspace-relative or absolute file path" });

/** The extension speaks URIs; the model speaks paths. */
export function toUri(cwd: string, file: string): string {
  return pathToFileURL(path.isAbsolute(file) ? file : path.join(cwd, file)).toString();
}

const TOOLS = [
  define({
    name: "ide_open_file",
    label: "IDE open file",
    description: "Open a file in the user's editor, optionally selecting a range. Use it to show the user where something is.",
    parameters: Type.Object({ path: pathParam, range: Type.Optional(range), preview: Type.Optional(Type.Boolean()) }),
    method: "ide.openFile",
    params: (p, cwd) => ({ uri: toUri(cwd, p.path), ...(p.range ? { range: p.range } : {}), ...(p.preview !== undefined ? { preview: p.preview } : {}) }),
  }),
  define({
    name: "ide_read_file",
    label: "IDE read file",
    description: "Read a file as the editor sees it, including unsaved changes (dirty buffers). Prefer it over `read` when the user is editing the file.",
    parameters: Type.Object({ path: pathParam }),
    method: "ide.readFile",
    params: (p, cwd) => ({ uri: toUri(cwd, p.path) }),
  }),
  define({
    name: "ide_search",
    label: "IDE search",
    description: "Search text across the workspace with the editor's exclude rules. Returns file, range and a preview per hit.",
    parameters: Type.Object({
      query: Type.String(),
      include: Type.Optional(Type.String({ description: "Glob of files to search, e.g. src/**/*.ts" })),
      exclude: Type.Optional(Type.String()),
      maxResults: Type.Optional(Type.Number()),
    }),
    method: "ide.searchWorkspace",
    params: (p) => ({
      query: p.query,
      ...(p.include ? { include: p.include } : {}),
      ...(p.exclude ? { exclude: p.exclude } : {}),
      maxResults: p.maxResults ?? 50,
    }),
    timeoutMs: 30_000,
  }),
  define({
    name: "ide_symbols",
    label: "IDE symbols",
    description: "The document symbols (outline) of a file from the editor's language service.",
    parameters: Type.Object({ path: pathParam }),
    method: "ide.symbols",
    params: (p, cwd) => ({ uri: toUri(cwd, p.path) }),
  }),
  define({
    name: "ide_references",
    label: "IDE references",
    description: "Find references to the symbol at a position, from the editor's language service.",
    parameters: Type.Object({ path: pathParam, position }),
    method: "ide.references",
    params: (p, cwd) => ({ uri: toUri(cwd, p.path), position: p.position }),
  }),
  define({
    name: "ide_reveal",
    label: "IDE reveal",
    description: "Scroll the editor to a range of a file without stealing focus.",
    parameters: Type.Object({ path: pathParam, range }),
    method: "ide.reveal",
    params: (p, cwd) => ({ uri: toUri(cwd, p.path), range: p.range }),
  }),
  define({
    name: "ide_show_diff",
    label: "IDE show diff",
    description: "Show a diff in the editor between a file and proposed content (or between two files). Nothing is written.",
    parameters: Type.Object({
      path: pathParam,
      content: Type.Optional(Type.String({ description: "Proposed content for the right side" })),
      rightPath: Type.Optional(Type.String({ description: "A second file for the right side, instead of content" })),
      title: Type.Optional(Type.String()),
    }),
    method: "ide.showDiff",
    params: (p, cwd) => {
      if (p.content === undefined && p.rightPath === undefined) throw new Error("ide_show_diff needs content or rightPath");
      return {
        left: { uri: toUri(cwd, p.path) },
        right: p.rightPath !== undefined ? { uri: toUri(cwd, p.rightPath) } : { content: p.content ?? "" },
        title: p.title ?? `${p.path} (proposed)`,
      };
    },
  }),
  define({
    name: "ide_diagnostics",
    label: "IDE diagnostics",
    description: "The editor's current diagnostics (errors, warnings) for one file or the whole workspace.",
    parameters: Type.Object({ path: Type.Optional(pathParam) }),
    method: "ide.getDiagnostics",
    params: (p, cwd) => (p.path ? { uri: toUri(cwd, p.path) } : {}),
  }),
];

export const IDE_TOOL_NAMES = TOOLS.map((tool) => tool.name);

export function ideTools(cwd: string, bridge: IdeBridgeServer = ideBridge()): HarnessTool[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id, params) {
      let wire: IdeActionParams<IdeActionName>;
      try {
        wire = (tool.params as (p: unknown, cwd: string) => IdeActionParams<IdeActionName>)(params, cwd);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error), { method: tool.method });
      }
      try {
        const result = await bridge.action(cwd, tool.method, wire as never, tool.timeoutMs);
        return textResult(asText(result), { method: tool.method, params: wire });
      } catch (error) {
        return failure(`IDE action failed: ${error instanceof Error ? error.message : String(error)}`, { method: tool.method, params: wire });
      }
    },
  }));
}
