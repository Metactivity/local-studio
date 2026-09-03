export type AssistantMediaKind = "image" | "video" | "audio";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "mpeg", "mpg", "ogv", "webm"]);
const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  "wave",
]);
const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].join("|");
const MEDIA_TOKEN_PATTERN = new RegExp(
  `(^|[\\s([{\"'])([^\\s\\x60'\")<>]+\\.(?:${MEDIA_EXTENSIONS}))(?=$|[\\s)\\]}\",.!?;:])`,
  "gi",
);
const SKIPPED_MARKDOWN_NODES = new Set(["code", "inlineCode", "link", "image"]);

export function cleanFileReference(value: string): string {
  let clean = value.trim().replace(/^`+|`+$/g, "");
  if (/^file:\/\//i.test(clean)) {
    try {
      clean = decodeURIComponent(new URL(clean).pathname);
    } catch {
      clean = clean.replace(/^file:\/\//i, "");
    }
  } else {
    try {
      clean = decodeURIComponent(clean);
    } catch {
      return clean.replace(/:\d+(?::\d+)?$/, "");
    }
  }
  return clean.replace(/:\d+(?::\d+)?$/, "");
}

export function assistantMediaKind(value: string | undefined): AssistantMediaKind | null {
  if (!value || /^(?:https?|data|blob):/i.test(value.trim())) return null;
  const clean = cleanFileReference(value).split(/[?#]/, 1)[0] ?? "";
  const extension = /\.([A-Za-z0-9]+)$/.exec(clean)?.[1]?.toLowerCase();
  if (!extension) return null;
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return null;
}

export function assistantMediaSource(reference: string, cwd: string | null): string | null {
  if (!assistantMediaKind(reference)) return null;
  const target = resolveFileOpenTarget(cleanFileReference(reference), cwd);
  if (!target || target.kind !== "file") return null;
  return `/api/agent/fs/raw?cwd=${encodeURIComponent(target.root)}&path=${encodeURIComponent(target.rel)}`;
}

export function assistantMediaName(reference: string): string {
  const clean = cleanFileReference(reference).replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1) || clean;
}

function splitMediaReferences(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  MEDIA_TOKEN_PATTERN.lastIndex = 0;
  for (
    let match = MEDIA_TOKEN_PATTERN.exec(value);
    match;
    match = MEDIA_TOKEN_PATTERN.exec(value)
  ) {
    const prefix = match[1] ?? "";
    const reference = match[2] ?? "";
    if (!assistantMediaKind(reference)) continue;
    const start = match.index + prefix.length;
    if (start > cursor) nodes.push({ type: "text", value: value.slice(cursor, start) });
    nodes.push({
      type: "link",
      url: reference,
      children: [{ type: "text", value: reference }],
    });
    cursor = start + reference.length;
  }
  if (cursor === 0) return [{ type: "text", value }];
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

function transformMarkdownNode(node: MarkdownNode): void {
  if (!node.children || SKIPPED_MARKDOWN_NODES.has(node.type)) return;
  node.children = node.children.flatMap((child) =>
    child.type === "text" && child.value ? splitMediaReferences(child.value) : [child],
  );
  for (const child of node.children) transformMarkdownNode(child);
}

export function remarkLocalMediaReferences() {
  return (tree: MarkdownNode) => transformMarkdownNode(tree);
}

export type FileOpenTarget = { root: string; rel: string; kind: "file" | "directory" };

// Resolve a clicked reference into a root and the path under it. References
// arrive the way assistants write them: `file://` URLs, `path:line:col`,
// `~/…`, `./…`, repo-relative, or absolute paths that point somewhere else
// entirely (a PDF on the Desktop while the session runs in a project).
// Absolute paths outside the session root resolve against their own parent
// directory rather than returning null.
export function resolveFileOpenTarget(
  requestPath: string,
  cwd: string | null,
): FileOpenTarget | null {
  const projectRoot = cwd ? cwd.replace(/\/+$/, "") : null;
  const raw = normalizeReference(requestPath, projectRoot);
  if (!raw) return null;
  const isDirectory = raw.endsWith("/");
  const clean = isDirectory ? raw.replace(/\/+$/, "") : raw;
  if (!clean) return null;

  if (projectRoot && (clean === projectRoot || clean.startsWith(`${projectRoot}/`))) {
    return {
      root: projectRoot,
      rel: clean === projectRoot ? "" : clean.slice(projectRoot.length + 1),
      kind: isDirectory ? "directory" : "file",
    };
  }
  if (clean.startsWith("/")) {
    if (isDirectory) return { root: clean, rel: "", kind: "directory" };
    const slash = clean.lastIndexOf("/");
    const parent = clean.slice(0, slash);
    const name = clean.slice(slash + 1);
    if (!name) return null;
    return { root: parent || "/", rel: name, kind: "file" };
  }
  if (!projectRoot) return null;
  const rel = clean.startsWith("./") ? clean.slice(2) : clean;
  if (!rel || rel.startsWith("../")) return null;
  return { root: projectRoot, rel, kind: isDirectory ? "directory" : "file" };
}

// Strip the decorations references arrive with (backticks, a `file://` scheme,
// a `:line:col` suffix) and expand `~`. The renderer has no `os.homedir()`, but
// the session cwd is an absolute path under the same home, so `/Users/<name>` /
// `/home/<name>` recovers it — enough to make `~/…` paths clickable.
function normalizeReference(requestPath: string, projectRoot: string | null): string | null {
  let raw = requestPath.trim();
  if (!raw) return null;
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname);
    } catch {
      return null;
    }
  }
  raw = raw.replace(/^`|`$/g, "").replace(/:\d+(?::\d+)?$/, "");
  if (!raw || raw.includes("\0")) return null;
  if (raw !== "~" && !raw.startsWith("~/")) return raw;
  const home = projectRoot?.match(/^(\/(?:Users|home)\/[^/]+)/)?.[1];
  if (!home) return raw;
  return raw === "~" ? `${home}/` : `${home}/${raw.slice(2)}`;
}
