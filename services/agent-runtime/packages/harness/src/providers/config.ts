// Local replacement for pi-coding-agent's `config.ts`: the vendored provider
// modules import three symbols from it, and nothing else of the CLI config
// applies here. `getAgentDir` keeps pi's contract (PI_CODING_AGENT_DIR, else
// ~/.pi/agent) so auth.json and models.json stay shared with the pi CLI.

import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "./utils/paths.ts";

/** Upstream version the vendored modules were taken from (sent as the catalog User-Agent). */
export const VERSION = "0.84.3";

export function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return normalizePath(envDir);
	return join(homedir(), ".pi", "agent");
}
