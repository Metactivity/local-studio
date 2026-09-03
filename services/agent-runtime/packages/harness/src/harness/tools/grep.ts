// Ported from @earendil-works/pi-coding-agent 0.84.3 `core/tools/grep.ts` onto
// the harness tool contract: the TUI renderers, `wrapToolDefinition` and the
// pluggable `GrepOperations` are gone; paths resolve through the execution env
// and ripgrep comes from PATH (see binaries.ts). Name, description, schema and
// output format are unchanged.

import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "../utils/truncate.ts";
import { requireExecutable, RIPGREP } from "./binaries.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

type Match = { filePath: string; lineNumber: number; lineText?: string };

export function createGrepTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof grepSchema,
	GrepToolDetails | undefined
> {
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		parameters: grepSchema,
		async execute(_toolCallId, { pattern, path: searchDir, glob, ignoreCase, literal, context, limit }, signal, _onUpdate, { env }) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const rgPath = requireExecutable(RIPGREP);
			const searchPath = await resolveToolPath(env, searchDir || ".", signal);
			const info = await env.fileInfo(searchPath, signal);
			if (!info.ok) throw new Error(`Path not found: ${searchPath}`);
			const isDirectory = info.value.kind === "directory";

			const contextValue = context && context > 0 ? context : 0;
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
			const formatPath = (filePath: string): string => {
				if (isDirectory) {
					const relative = path.relative(searchPath, filePath);
					if (relative && !relative.startsWith("..")) return relative.replace(/\\/g, "/");
				}
				return path.basename(filePath);
			};

			const fileCache = new Map<string, string[]>();
			const getFileLines = async (filePath: string): Promise<string[]> => {
				let lines = fileCache.get(filePath);
				if (!lines) {
					const content = await env.readTextFile(filePath, signal);
					lines = content.ok ? content.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : [];
					fileCache.set(filePath, lines);
				}
				return lines;
			};

			const args: string[] = ["--json", "--line-number", "--color=never", "--hidden", "--sort", "path"];
			if (ignoreCase) args.push("--ignore-case");
			if (literal) args.push("--fixed-strings");
			if (glob) args.push("--glob", glob);
			args.push("--", pattern, searchPath);

			const { matches, matchLimitReached, code, stderr } = await new Promise<{
				matches: Match[];
				matchLimitReached: boolean;
				code: number | null;
				stderr: string;
			}>((resolve, reject) => {
				const child = spawn(rgPath, args, { cwd: env.cwd, stdio: ["ignore", "pipe", "pipe"] });
				const rl = createInterface({ input: child.stdout });
				const matches: Match[] = [];
				let stderr = "";
				let matchCount = 0;
				let matchLimitReached = false;
				let killedDueToLimit = false;
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				rl.on("line", (line) => {
					if (!line.trim() || matchCount >= effectiveLimit) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					if (event.type !== "match") return;
					matchCount++;
					const filePath = event.data?.path?.text;
					const lineNumber = event.data?.line_number;
					if (filePath && typeof lineNumber === "number") {
						matches.push({ filePath, lineNumber, lineText: event.data?.lines?.text });
					}
					if (matchCount >= effectiveLimit) {
						matchLimitReached = true;
						killedDueToLimit = true;
						child.kill();
					}
				});
				child.on("error", (error) => {
					rl.close();
					signal?.removeEventListener("abort", onAbort);
					reject(new Error(`Failed to run ripgrep: ${error.message}`));
				});
				child.on("close", (code) => {
					rl.close();
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) return reject(new Error("Operation aborted"));
					resolve({ matches, matchLimitReached, code: killedDueToLimit ? 0 : code, stderr });
				});
			});

			if (code !== 0 && code !== 1) throw new Error(stderr.trim() || `ripgrep exited with code ${code}`);
			if (matches.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

			let linesTruncated = false;
			const outputLines: string[] = [];
			for (const match of matches) {
				const relativePath = formatPath(match.filePath);
				if (contextValue === 0 && match.lineText !== undefined) {
					const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
					const { text, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					outputLines.push(`${relativePath}:${match.lineNumber}: ${text}`);
					continue;
				}
				const lines = await getFileLines(match.filePath);
				if (!lines.length) {
					outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
					continue;
				}
				const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
				const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
				for (let current = start; current <= end; current++) {
					const { text, wasTruncated } = truncateLine((lines[current - 1] ?? "").replace(/\r/g, ""));
					if (wasTruncated) linesTruncated = true;
					outputLines.push(
						current === match.lineNumber ? `${relativePath}:${current}: ${text}` : `${relativePath}-${current}- ${text}`,
					);
				}
			}

			const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: GrepToolDetails = {};
			const notices: string[] = [];
			if (matchLimitReached) {
				notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
				details.matchLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
		},
	};
}
