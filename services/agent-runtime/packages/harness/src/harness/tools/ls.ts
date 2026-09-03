// Ported from @earendil-works/pi-coding-agent 0.84.3 `core/tools/ls.ts` onto the
// harness tool contract (see grep.ts for what changed); the listing goes through
// the execution env, so it needs no binary.

import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "../utils/truncate.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

export function createLsTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof lsSchema,
	LsToolDetails | undefined
> {
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: lsSchema,
		async execute(_toolCallId, { path, limit }, signal, _onUpdate, { env }) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const dirPath = await resolveToolPath(env, path || ".", signal);
			const effectiveLimit = limit ?? DEFAULT_LIMIT;

			const info = await env.fileInfo(dirPath, signal);
			if (!info.ok) throw new Error(`Path not found: ${dirPath}`);
			if (info.value.kind !== "directory") throw new Error(`Not a directory: ${dirPath}`);
			const listed = await env.listDir(dirPath, signal);
			if (!listed.ok) throw new Error(`Cannot read directory: ${listed.error.message}`);

			const entries = [...listed.value].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
			const results: string[] = [];
			let entryLimitReached = false;
			for (const entry of entries) {
				if (results.length >= effectiveLimit) {
					entryLimitReached = true;
					break;
				}
				let isDirectory = entry.kind === "directory";
				if (entry.kind === "symlink") {
					// pi stat()ed each entry, so a symlink reports what it points at.
					const target = await env.canonicalPath(entry.path, signal);
					const targetInfo = target.ok ? await env.fileInfo(target.value, signal) : target;
					if (!targetInfo.ok) continue;
					isDirectory = targetInfo.value.kind === "directory";
				}
				results.push(entry.name + (isDirectory ? "/" : ""));
			}
			if (results.length === 0) return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };

			const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: LsToolDetails = {};
			const notices: string[] = [];
			if (entryLimitReached) {
				notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
				details.entryLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
		},
	};
}
