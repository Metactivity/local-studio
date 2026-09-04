import { Suspense, type ReactNode } from "react";
import { ToolsProvider } from "@/features/agent/tools/context";
import { AgentWorkspaceHost } from "@/features/agent/ui/agent-workspace-host";

// One layout for /chat and /ide (MET-934): the workspace — sessions, the
// running turn's SSE subscription, panel state — lives here, so switching
// mode only swaps the page segment and never remounts the agent.
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <ToolsProvider>
      <Suspense fallback={null}>
        <AgentWorkspaceHost ideOrigin={process.env.LOCAL_STUDIO_IDE_ORIGIN?.trim() ?? ""} />
      </Suspense>
      {children}
    </ToolsProvider>
  );
}
