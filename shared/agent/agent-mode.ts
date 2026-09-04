/**
 * The agent workspace has two layouts (MET-934): `chat` (full-width classic
 * workspace, no editor) and `ide` (the same panel next to the embedded
 * Code-OSS workbench). The route is the mode; the last mode is remembered per
 * project so a deep link reopens a project the way it was last used.
 */
export type AgentMode = "chat" | "ide";

type ModeStorage = Pick<Storage, "getItem" | "setItem">;

const storageKey = (projectId: string) => `local-studio.agentMode.${projectId}`;

export function agentModeFromPath(pathname: string): AgentMode | null {
  if (pathname === "/ide" || pathname.startsWith("/ide/")) return "ide";
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return "chat";
  return null;
}

/** The remembered mode for a project, null when none or when storage is unavailable. */
export function readAgentMode(storage: ModeStorage | null, projectId: string): AgentMode | null {
  try {
    const raw = storage?.getItem(storageKey(projectId));
    return raw === "chat" || raw === "ide" ? raw : null;
  } catch {
    return null;
  }
}

export function writeAgentMode(storage: ModeStorage | null, projectId: string, mode: AgentMode) {
  try {
    storage?.setItem(storageKey(projectId), mode);
  } catch {
    /* private mode — the choice simply is not remembered */
  }
}

/**
 * Where a navigation lands. A bare `/chat` or `/ide` (nav rail, brand link) is
 * an explicit choice; a deep link with a query (`?project=`, `?session=`,
 * `?new=`) opens the project in the mode it was last used in, chat by default.
 */
export function resolveAgentMode(
  pathMode: AgentMode,
  search: string,
  stored: AgentMode | null,
): AgentMode {
  return search && stored ? stored : pathMode;
}

/** The landing href for a project (and optionally a session or a fresh chat). */
export function agentWorkspaceHref(
  projectId: string,
  target: { session: string } | { new: true } | null = null,
): string {
  const params = new URLSearchParams({ project: projectId });
  if (target && "session" in target) params.set("session", target.session);
  if (target && "new" in target) params.set("new", "1");
  params.set("replace", "1");
  return `/chat?${params}`;
}
