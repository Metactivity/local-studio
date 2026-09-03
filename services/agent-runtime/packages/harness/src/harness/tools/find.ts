// Ported from @earendil-works/pi-coding-agent 0.84.3 `core/tools/find.ts` onto
// the harness tool contract (see grep.ts for what changed). fd comes from PATH.

import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "../utils/truncate.ts";
import { FD, requireExecutable } from "./binaries.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

/** Relativize a find result against the search root and normalize it to posix separators. */
export function relativizeFindResultPath(resultPath: string, searchPath: string): string {
	const hadTrailingSeparator = resultPath.endsWith(path.sep) || (path.sep === "\\" && resultPath.endsWith("/"));
	const relativePath = path.isAbsolute(resultPath) ? path.relative(searchPath, resultPath) : resultPath;
	const posixPath = relativePath.split(path.sep).join("/");
	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

export function createFindTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof findSchema,
	FindToolDetails | undefined
> {
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: findSchema,
		async execute(_toolCallId, { pattern, path: searchDir, limit }, signal, _onUpdate, { env }) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const fdPath = requireExecutable(FD);
			const searchPath = await resolveToolPath(env, searchDir || ".", signal);
			const exists = await env.exists(searchPath, signal);
			if (!exists.ok || !exists.value) throw new Error(`Path not found: ${searchPath}`);
			const effectiveLimit = limit ?? DEFAULT_LIMIT;

			const args: string[] = ["--glob", "--color=never", "--hidden"];
			// fd normally ignores .gitignore outside git repos, so keep --no-require-git
			// there. Inside repos, use fd's default git-aware behavior so parent
			// .gitignore rules stop at nested repo boundaries.
			let insideGitRepo = false;
			for (let current = searchPath; ; ) {
				const git = await env.exists(path.join(current, ".git"), signal);
				if (git.ok && git.value) {
					insideGitRepo = true;
					break;
				}
				const parent = path.dirname(current);
				if (parent === current) break;
				current = parent;
			}
			if (!insideGitRepo) args.push("--no-require-git");
			args.push("--max-results", String(effectiveLimit));

			// fd --glob matches against the basename unless --full-path is set; in --full-path
			// mode it matches against the absolute candidate path, so a path-containing
			// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
			let effectivePattern = pattern;
			if (pattern.includes("/")) {
				args.push("--full-path");
				if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
					effectivePattern = `**/${pattern}`;
				}
				if (process.platform === "win32") effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
			}
			args.push("--", effectivePattern, searchPath);

			const { lines, code, stderr } = await new Promise<{ lines: string[]; code: number | null; stderr: string }>(
				(resolve, reject) => {
					const child = spawn(fdPath, args, { cwd: env.cwd, stdio: ["ignore", "pipe", "pipe"] });
					const rl = createInterface({ input: child.stdout });
					const lines: string[] = [];
					let stderr = "";
					const onAbort = () => child.kill();
					signal?.addEventListener("abort", onAbort, { once: true });
					child.stderr.on("data", (chunk) => {
						stderr += chunk.toString();
					});
					rl.on("line", (line) => lines.push(line));
					child.on("error", (error) => {
						rl.close();
						signal?.removeEventListener("abort", onAbort);
						reject(new Error(`Failed to run fd: ${error.message}`));
					});
					child.on("close", (code) => {
						rl.close();
						signal?.removeEventListener("abort", onAbort);
						if (signal?.aborted) return reject(new Error("Operation aborted"));
						resolve({ lines, code, stderr });
					});
				},
			);

			const relativized = lines
				.map((line) => line.replace(/\r$/, "").trim())
				.filter(Boolean)
				.map((line) => relativizeFindResultPath(line, searchPath));
			if (code !== 0 && relativized.length === 0) throw new Error(stderr.trim() || `fd exited with code ${code}`);
			if (relativized.length === 0) {
				return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
			}

			const resultLimitReached = relativized.length >= effectiveLimit;
			const truncation = truncateHead(relativized.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: FindToolDetails = {};
			const notices: string[] = [];
			if (resultLimitReached) {
				notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
				details.resultLimitReached = effectiveLimit;
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
