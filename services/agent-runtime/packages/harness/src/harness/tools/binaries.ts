// Where the grep and find tools get their ripgrep / fd binary. pi-coding-agent
// downloaded a missing binary from GitHub at first use (utils/tools-manager.ts);
// this harness only looks on PATH (plus an explicit override), so a missing
// binary is a clear install hint instead of a network fetch inside a tool call.

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const cache = new Map<string, string | null>();

function isExecutable(candidate: string): boolean {
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** First executable found on PATH among `names`, or the `override` when set; null when neither exists. */
export function findExecutable(names: readonly string[], override?: string): string | null {
	if (override) return isExecutable(override) ? override : null;
	const key = names.join("|");
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const name of names) {
		for (const dir of dirs) {
			for (const suffix of suffixes) {
				const candidate = join(dir, name + suffix);
				if (isExecutable(candidate)) {
					cache.set(key, candidate);
					return candidate;
				}
			}
		}
	}
	cache.set(key, null);
	return null;
}

export const RIPGREP = { names: ["rg"], override: "PI_RG_PATH", install: "ripgrep (rg)" } as const;
export const FD = { names: ["fd", "fdfind"], override: "PI_FD_PATH", install: "fd" } as const;

export function requireExecutable(tool: typeof RIPGREP | typeof FD): string {
	const found = findExecutable(tool.names, process.env[tool.override]);
	if (!found) {
		throw new Error(`${tool.install} is not installed or not on PATH (set ${tool.override} to point at the binary)`);
	}
	return found;
}
