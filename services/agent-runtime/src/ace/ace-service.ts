// One ACE NativeService per process, configured from the environment
// (ADR-033 §7: ACE receives endpoints, it supervises nothing). Every failure
// here degrades — the harness keeps running without ACE and `aceStatus()`
// says why.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AceStatus, NativeService, setWasmDirectory } from "@metactivity/ace";
import { resolveDataDir } from "../data-dir";

export interface AceConfig {
  runtime: "external" | "supervised";
  chatBaseUrl: string;
  embedBaseUrl: string;
  apiKey?: string;
  chatModel: string;
  embedModel: string;
  storeRoot: string;
  vecExtensionPath?: string;
}

export interface AceConfigResult {
  config: AceConfig | null;
  problems: string[];
}

const DEFAULT_CHAT_MODEL = "spark-qwen38-27b-rvn-q8";
const DEFAULT_EMBED_MODEL = "qwen3-embedding";

function readUrl(env: NodeJS.ProcessEnv, name: string, problems: string[]): string {
  const value = env[name]?.trim() ?? "";
  if (value.length === 0) {
    problems.push(`${name} is not set`);
    return "";
  }
  try {
    new URL(value);
  } catch {
    problems.push(`${name} is not a valid URL`);
  }
  return value.replace(/\/+$/, "");
}

export function readAceConfig(env: NodeJS.ProcessEnv = process.env): AceConfigResult {
  const problems: string[] = [];
  const runtime = env.ACE_RUNTIME_KIND?.trim() || "external";
  if (runtime !== "external" && runtime !== "supervised") {
    problems.push(`ACE_RUNTIME_KIND must be "external" or "supervised", got "${runtime}"`);
  }
  const chatBaseUrl = runtime === "external" ? readUrl(env, "ACE_CHAT_BASE_URL", problems) : "";
  const embedBaseUrl = runtime === "external" ? readUrl(env, "ACE_EMBED_BASE_URL", problems) : "";
  if (problems.length > 0) return { config: null, problems };
  return {
    config: {
      runtime: runtime as AceConfig["runtime"],
      chatBaseUrl,
      embedBaseUrl,
      apiKey: env.ACE_API_KEY?.trim() || undefined,
      chatModel: env.ACE_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL,
      embedModel: env.ACE_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
      storeRoot: env.ACE_STORE_ROOT?.trim() || path.join(resolveDataDir(), "ace-store"),
      vecExtensionPath: env.ACE_VEC_EXTENSION?.trim() || undefined,
    },
    problems,
  };
}

/** `<@metactivity/ace>/wasm` — resolved from the package entry, works for a linked or installed package. */
export function aceWasmDirectory(): string {
  const entry = fileURLToPath(import.meta.resolve("@metactivity/ace"));
  return path.join(path.dirname(entry), "..", "wasm");
}

export function createAceService(config: AceConfig): NativeService {
  setWasmDirectory(aceWasmDirectory());
  return new NativeService({
    sessionsRoot: config.storeRoot,
    discoveryModel: config.chatModel,
    embeddingModel: config.embedModel,
    ...(config.vecExtensionPath ? { vecExtensionPath: config.vecExtensionPath } : {}),
    ...(config.runtime === "external"
      ? {
          runtime: {
            kind: "external" as const,
            chatBaseUrl: config.chatBaseUrl,
            embedBaseUrl: config.embedBaseUrl,
            ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          },
        }
      : {}),
  });
}

interface AceProcessState {
  config: AceConfig | null;
  problems: string[];
  service: NativeService | null;
}

let processState: AceProcessState | undefined;

/** The process-wide ACE service, or null when the environment does not describe one. Never throws. */
export function aceService(env: NodeJS.ProcessEnv = process.env): NativeService | null {
  if (processState === undefined) {
    const { config, problems } = readAceConfig(env);
    let service: NativeService | null = null;
    if (config !== null) {
      try {
        service = createAceService(config);
      } catch (error) {
        problems.push(`ACE failed to start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    processState = { config, problems, service };
  }
  return processState.service;
}

export interface AceStatusReport {
  configured: boolean;
  runtime: AceConfig["runtime"] | null;
  storeRoot: string | null;
  chatModel: string | null;
  embedModel: string | null;
  problems: string[];
  health: NativeService["state"] | null;
  status: AceStatus | null;
}

/** For the future `/ace/status` — never carries the key. */
export async function aceStatus(): Promise<AceStatusReport> {
  const service = aceService();
  const state = processState!;
  return {
    configured: service !== null,
    runtime: state.config?.runtime ?? null,
    storeRoot: state.config?.storeRoot ?? null,
    chatModel: state.config?.chatModel ?? null,
    embedModel: state.config?.embedModel ?? null,
    problems: [...state.problems],
    health: service?.state ?? null,
    status: service === null ? null : await service.getStatus(),
  };
}

/** Test seam: forget the process-wide instance. */
export function resetAceService(): void {
  processState?.service?.dispose();
  processState = undefined;
}
