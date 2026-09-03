// Which agent core drives a runtime session (MET-914, W3). `pi` is the
// pi-coding-agent SDK driver; `harness` is the ACE-rooted vendored Agent
// (src/harness-runtime.ts) with its SQLite session store. Both stay alive
// behind this flag until the harness is the default.

export type AgentCore = "pi" | "harness";

export function agentCore(env: NodeJS.ProcessEnv = process.env): AgentCore {
  return env.LOCAL_STUDIO_AGENT_CORE?.trim().toLowerCase() === "harness" ? "harness" : "pi";
}
