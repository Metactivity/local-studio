// The built-in tool inventory of a session, assembled per the enable gates in
// pi-runtime-helpers `builtinToolGates` (the same inventory src/builtin-plugins.ts
// lists for the Plugins tab): automations and subagents always; cua (`browser_*`)
// when the Browser tool is on; chrome (`chrome_*`) on top of it when the backend
// is the user's own Chrome AND the relay answers; github where a gh binary
// exists; obsidian where Obsidian registered a vault; connectors when at least
// one is enabled. The two policy extensions are src/tools/policies.ts.

import { automationsTools } from "./automations";
import { chromeTools } from "./chrome";
import { connectorTools } from "./connectors";
import type { HarnessTool, ToolContext } from "./context";
import { cuaTools } from "./cua";
import { githubTools } from "./github";
import { obsidianTools } from "./obsidian";
import { subagentTools } from "./subagents";

export type { HarnessTool, ToolContext, ToolGates } from "./context";
export { ARTIFACT_POLICY, withAgentPolicy, withTimeoutPolicy } from "./policies";

export async function builtinTools(ctx: ToolContext): Promise<HarnessTool[]> {
  const { gates } = ctx;
  const [chrome, connectors] = await Promise.all([
    gates.browser && gates.chrome ? chromeTools(ctx) : [],
    gates.connectors ? connectorTools(ctx) : [],
  ]);
  return [
    ...(gates.browser ? cuaTools(ctx) : []),
    ...chrome,
    ...(gates.github ? githubTools(ctx) : []),
    ...(gates.obsidian ? obsidianTools(ctx) : []),
    ...connectors,
    ...subagentTools(ctx),
    ...automationsTools(ctx),
  ];
}
