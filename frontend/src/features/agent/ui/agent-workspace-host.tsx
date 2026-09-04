"use client";

import { usePathname } from "next/navigation";
import { agentModeFromPath } from "@shared/agent/agent-mode";
import { AgentWorkspace } from "@/features/agent/ui/agent-workspace";

/** The route picks the layout; the workspace itself persists across /chat ↔ /ide. */
export function AgentWorkspaceHost({ ideOrigin }: { ideOrigin: string }) {
  const layout = agentModeFromPath(usePathname()) ?? "chat";
  return <AgentWorkspace layout={layout} ideOrigin={ideOrigin} />;
}
