"use client";

// The right column of /ide (ADR-034 M4): the /agent chat pane — composer,
// timeline, queue strip, Stop — on the owned harness, bound to the selected
// project, plus the first ACE surfaces (Context Lens, Memory, status). Same
// workspace controller as /agent, one pane, memory-only layout state.

import { useState } from "react";
import { AceContextTab } from "@/features/ace/ace-context-tab";
import { AceMemoryTab } from "@/features/ace/ace-memory-tab";
import { AceStatusTab } from "@/features/ace/ace-status-tab";
import { loadAceProposals } from "@/features/ace/api";
import { useAceResource } from "@/features/ace/use-ace-resource";
import { useProjects } from "@/features/agent/projects/context";
import type { Project } from "@/features/agent/projects/types";
import { focusedSession } from "@/features/agent/runtime/selectors";
import { safeJson } from "@/features/agent/safe-json";
import type { SessionSummary } from "@/features/agent/session-summary";
import { useTools } from "@/features/agent/tools/context";
import { workspaceNavigationAction } from "@/features/agent/ui/agent-workspace-navigation";
import { renderWorkspacePane } from "@/features/agent/ui/render-workspace-pane";
import { useWorkspace } from "@/features/agent/ui/use-workspace";
import { useMountSubscription } from "@/hooks/use-mount-subscription";
import { cx } from "@/ui/utils";

type PanelTab = "chat" | "context" | "memory" | "ace";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "context", label: "Context" },
  { id: "memory", label: "Memory" },
  { id: "ace", label: "ACE" },
];

async function loadRecentSessions(cwd: string): Promise<SessionSummary[]> {
  const response = await fetch(
    `/api/agent/sessions?cwd=${encodeURIComponent(cwd)}&since=30d&limit=20`,
    { cache: "no-store" },
  );
  const payload = await safeJson<{ sessions?: SessionSummary[]; error?: string }>(response);
  if (!response.ok) throw new Error(payload.error || "Failed to load sessions");
  return payload.sessions ?? [];
}

/** Open `sessionId` in the single pane, or a fresh session when null — the same action the /agent URL params dispatch. */
function openSession(project: Project, sessionId: string | null, nonce?: number) {
  const params = new Map<string, string>([
    ["project", project.id],
    sessionId ? ["session", sessionId] : ["new", "1"],
  ]);
  const action = workspaceNavigationAction({ get: (key) => params.get(key) ?? null }, project)!;
  return nonce === undefined ? action : { ...action, key: `${action.key}#${nonce}` };
}

function sessionLabel(session: SessionSummary): string {
  const text = (session.lastUserPromptText ?? session.firstUserMessage ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 60) : `Session ${session.id.slice(0, 8)}`;
}

export function IdeAgentPanel({ connected }: { connected: boolean }) {
  const projects = useProjects();
  const tools = useTools();
  const { state, dispatch, handles } = useWorkspace({ ephemeral: true });
  const project = projects.selectedProject;
  const cwd = project?.path ?? "";
  const focused = focusedSession(state);
  const piSessionId = focused?.piSessionId ?? null;
  const [tab, setTab] = useState<PanelTab>("chat");
  const [pickNonce, setPickNonce] = useState(0);

  const sessions = useAceResource(cwd ? () => loadRecentSessions(cwd) : null, [cwd, piSessionId]);
  const proposals = useAceResource(cwd ? () => loadAceProposals(cwd) : null, [
    cwd,
    tab === "memory",
  ]);

  // A project switch reopens that folder's latest session, or starts a fresh one.
  useMountSubscription(() => {
    if (!project) return;
    let cancelled = false;
    loadRecentSessions(project.path).then(
      (recent) => {
        if (!cancelled) dispatch(openSession(project, recent[0]?.id ?? null));
      },
      () => {
        if (!cancelled) dispatch(openSession(project, null));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project?.id, dispatch]);

  const pickSession = (sessionId: string | null) => {
    if (!project) return;
    setPickNonce((nonce) => nonce + 1);
    dispatch(openSession(project, sessionId, pickNonce + 1));
    setTab("chat");
  };

  const listed = sessions.data ?? [];
  const options =
    piSessionId && !listed.some((session) => session.id === piSessionId)
      ? [
          { id: piSessionId, label: "Current session" },
          ...listed.map((session) => ({ id: session.id, label: sessionLabel(session) })),
        ]
      : listed.map((session) => ({ id: session.id, label: sessionLabel(session) }));
  const pending = proposals.data?.length ?? 0;

  return (
    <aside className="flex min-h-0 flex-col border-l border-(--border)/60 bg-(--agent-bg)">
      <nav
        className="flex h-10 shrink-0 items-center gap-1 border-b border-(--border)/60 px-2"
        aria-label="Agent panel"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={cx(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[length:var(--fs-sm)] transition-colors",
              tab === item.id ? "bg-(--active) text-(--fg)" : "text-(--dim) hover:text-(--fg)",
            )}
          >
            {item.label}
            {item.id === "memory" && pending > 0 ? (
              <span className="rounded-full bg-(--warn)/20 px-1.5 text-[length:var(--fs-xs)] tabular-nums text-(--fg)">
                {pending}
              </span>
            ) : null}
          </button>
        ))}
        <span
          className={cx(
            "ml-auto rounded-full px-2 py-0.5 text-[length:var(--fs-xs)]",
            connected ? "bg-(--active) text-(--fg)" : "bg-(--surface-2)/40 text-(--dim)",
          )}
        >
          {connected ? "IDE connected" : "IDE loading"}
        </span>
      </nav>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--border)/60 px-2">
        <select
          value={piSessionId ?? ""}
          disabled={!project}
          aria-label="Session"
          onChange={(event) => pickSession(event.target.value || null)}
          className="h-6 min-w-0 flex-1 rounded-md border border-(--border) bg-transparent px-1.5 text-[length:var(--fs-sm)] text-(--fg)"
        >
          <option value="">New chat</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!project}
          onClick={() => pickSession(null)}
          className="h-6 shrink-0 rounded-md px-2 text-[length:var(--fs-sm)] text-(--dim) hover:bg-(--hover) hover:text-(--fg) disabled:opacity-50"
        >
          New
        </button>
      </div>
      {state.error ? (
        <p className="shrink-0 border-b border-(--border)/60 px-3 py-1.5 text-[length:var(--fs-xs)] text-(--err)">
          {state.error}
        </p>
      ) : null}
      <div className={cx("min-h-0 flex-1 flex-col", tab === "chat" ? "flex" : "hidden")}>
        {project ? (
          renderWorkspacePane({
            paneId: state.focusedPaneId,
            state,
            projects,
            tools,
            dispatch,
            handles,
            compact: true,
          })
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[length:var(--fs-sm)] text-(--dim)">
            Select a project to chat about it.
          </div>
        )}
      </div>
      {tab === "context" ? (
        <AceContextTab sessionId={focused?.id ?? null} piSessionId={piSessionId} />
      ) : null}
      {tab === "memory" ? <AceMemoryTab cwd={cwd} proposals={proposals} /> : null}
      {tab === "ace" ? <AceStatusTab cwd={cwd} /> : null}
    </aside>
  );
}
