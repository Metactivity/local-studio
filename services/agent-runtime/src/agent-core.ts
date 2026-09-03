// The agent core is the ACE-rooted harness (src/harness-runtime.ts). The
// LOCAL_STUDIO_AGENT_CORE flag that selected it during the migration off the
// pi-coding-agent SDK (MET-914) is accepted for one more release: any other
// value logs a deprecation warning and the harness runs the session anyway.

export function agentCore(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): "harness" {
  const requested = env.LOCAL_STUDIO_AGENT_CORE?.trim().toLowerCase();
  if (requested && requested !== "harness") {
    warn(
      `[agent-runtime] LOCAL_STUDIO_AGENT_CORE=${requested} is deprecated: the pi-coding-agent driver was removed and the harness core drives every session. Unset the variable.`,
    );
  }
  return "harness";
}
