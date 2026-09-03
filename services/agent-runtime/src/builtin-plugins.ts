import { hasEnabledConnectorsSync } from "./connectors-service";
import { hasGithubCliSync } from "./github-cli";
import { hasObsidianVaultSync } from "./obsidian-vault";
import type { PluginRow } from "./plugin-contract";

/**
 * The built-in tool modules, listed so the Plugins tab tells the whole truth.
 *
 * Every session registers the in-process tools under src/tools/ (see
 * `builtinTools`), which means the agent runs nine tool families the user never
 * wrote. A plugin page that lists only `<agentDir>/extensions` hides all of
 * them — exactly the "page that hides half of what actually runs" the contract
 * warns against. So this module describes the same inventory, read-only, with
 * each row's gate evaluated the same way the session evaluates it (same helper
 * for the sync gates; a note for the per-session ones, whose state genuinely
 * differs between sessions and has no single answer here).
 *
 * Kept as its own module rather than folded into user-plugins.ts so the
 * writable store stays what it says it is: the contents of one directory.
 */

type BuiltinModule = {
  id: string;
  /** Where the tools live, for the row's path column. */
  source: string;
  /** True/false from the same sync gate the session uses; null = per-session. */
  loads: () => boolean | null;
  note: string;
};

const TOOLS_DIR = "services/agent-runtime/src/tools";

const BUILTIN_MODULES: BuiltinModule[] = [
  {
    id: "local-studio-timeouts",
    source: `${TOOLS_DIR}/policies.ts:withTimeoutPolicy`,
    loads: () => true,
    note: "Always loaded — enforces the session time limits.",
  },
  {
    id: "local-studio-agent-policy",
    source: `${TOOLS_DIR}/policies.ts:withAgentPolicy`,
    loads: () => true,
    note: "Always loaded — applies Local Studio's agent policy.",
  },
  {
    id: "subagents",
    source: `${TOOLS_DIR}/subagents.ts`,
    loads: () => true,
    note: "Always loaded — lets the agent spawn subagent sessions.",
  },
  {
    id: "automations",
    source: `${TOOLS_DIR}/automations.ts`,
    loads: () => true,
    note: "Always loaded — lets the agent manage scheduled automations.",
  },
  {
    id: "cua",
    source: `${TOOLS_DIR}/cua.ts`,
    loads: () => null,
    note: "Loads per session, when the Browser tool is on.",
  },
  {
    id: "chrome",
    source: `${TOOLS_DIR}/chrome.ts`,
    loads: () => null,
    note: "Loads per session, when the browser backend is your own Chrome.",
  },
  {
    id: "github",
    source: `${TOOLS_DIR}/github.ts`,
    loads: hasGithubCliSync,
    note: "Loads when the gh CLI is installed.",
  },
  {
    id: "obsidian",
    source: `${TOOLS_DIR}/obsidian.ts`,
    loads: hasObsidianVaultSync,
    note: "Loads when Obsidian has registered a vault.",
  },
  {
    id: "connectors",
    source: `${TOOLS_DIR}/connectors.ts`,
    loads: hasEnabledConnectorsSync,
    note: "Loads when at least one connector is enabled.",
  },
];

/** The built-in rows are part of the runtime, not files on disk: no size, no mtime. */
export async function listBuiltinPlugins(): Promise<PluginRow[]> {
  return BUILTIN_MODULES.map((module) => ({
    id: module.id,
    file: module.source.split("/").at(-1)!.split(":")[0]!,
    path: module.source,
    // A per-session gate has no single answer outside a session; the row
    // shows "built in" either way and the note carries the condition.
    enabled: module.loads() !== false,
    bytes: 0,
    updated_at: new Date(0).toISOString(),
    read_only: true,
    builtin: true,
    note: module.note,
  }));
}
