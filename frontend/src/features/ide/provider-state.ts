import type { Session } from "@/features/agent/runtime/types";
import type { TuumProviderState } from "@/ui/tuum";

/** The provider badge state, read off the runtime session (ADR-034 M9). */
export function providerBadgeState(session: Session | null, waiting: boolean): TuumProviderState {
  if (!session) return "idle";
  if (session.error) return "error";
  if (waiting || session.extensionUiRequest) return "waiting";
  const busy =
    session.status === "running" || session.status === "starting" || session.status === "stopping";
  if (busy) {
    const last = session.messages.at(-1);
    const toolRunning = last?.blocks?.some(
      (block) => block.kind === "tool" && block.status === "running",
    );
    return toolRunning ? "tool-use" : "thinking";
  }
  return session.messages.some((message) => message.role === "assistant") ? "completed" : "idle";
}
