import { CHATS_PROJECT_ID } from "./project-ids";

/**
 * Which project a surface opens by default (MET-933): the selected one when it
 * is a real registered project, else the first real project (an existing
 * folder first). The synthetic "Chats" entry is the runtime data dir and is
 * never a default — a workbench must not open `~/.local-studio`.
 */
export function defaultProjectId<T extends { id: string; exists?: boolean }>(
  projects: readonly T[],
  selectedId: string | null | undefined,
): string | null {
  const selected = selectedId ? projects.find((project) => project.id === selectedId) : undefined;
  if (selected && selected.id !== CHATS_PROJECT_ID) return selected.id;
  const real = projects.filter((project) => project.id !== CHATS_PROJECT_ID);
  return (real.find((project) => project.exists !== false) ?? real[0])?.id ?? null;
}
