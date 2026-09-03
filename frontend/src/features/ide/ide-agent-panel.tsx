"use client";

// The right column of /ide (ADR-034 M4/M8): the chat pane — composer,
// timeline, queue strip, Stop — on the owned harness, bound to the selected
// project, the embedded browser, and the ACE surfaces (Context Lens, Memory,
// status). One pane, memory-only layout state; `?project=&session=&new=` in
// the URL open a session the way the old /agent workbench did.

import { lazy, Suspense, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AceContextTab } from "@/features/ace/ace-context-tab";
import { AceMemoryTab } from "@/features/ace/ace-memory-tab";
import { AceStatusTab } from "@/features/ace/ace-status-tab";
import { IdeChangesStrip } from "@/features/ide/ide-changes-strip";
import { providerBadgeState } from "@/features/ide/provider-state";
import { loadAceProposals, loadIdeContext } from "@/features/ace/api";
import { useAceResource } from "@/features/ace/use-ace-resource";
import { useProjects } from "@/features/agent/projects/context";
import type { Project } from "@/features/agent/projects/types";
import { focusedSession } from "@/features/agent/runtime/selectors";
import { safeJson } from "@/features/agent/safe-json";
import {
  sanitizeBrowserPaneUrl,
  sanitizeLocalFileUrl,
} from "@/features/agent/sanitize-embedded-browser-url";
import { normalizeBrowserInput } from "@/features/agent/tools/browser-url";
import type { SessionSummary } from "@/features/agent/session-summary";
import { useTools } from "@/features/agent/tools/context";
import { workspaceNavigationAction } from "@/features/agent/ui/agent-workspace-navigation";
import { renderWorkspacePane } from "@/features/agent/ui/render-workspace-pane";
import { useWorkspace } from "@/features/agent/ui/use-workspace";
import { useMountSubscription } from "@/hooks/use-mount-subscription";
import { Globe } from "@/ui/icon-registry";
import { TuumProviderBadge } from "@/ui/tuum";
import { TuumIcon, type TuumIconName } from "@/ui/tuum-icon";
import { cx } from "@/ui/utils";

const LazyAgentBrowser = lazy(() =>
  import("@/features/agent/ui/agent-browser").then(({ AgentBrowser }) => ({
    default: AgentBrowser,
  })),
);

type PanelTab = "chat" | "browser" | "context" | "memory" | "ace";

// Kit product icons where one fits the tab; Lucide for the browser.
const TABS: { id: PanelTab; label: string; icon: TuumIconName | null }[] = [
  { id: "chat", label: "Chat", icon: "agent-session" },
  { id: "browser", label: "Browser", icon: null },
  { id: "context", label: "Context", icon: "context-lens" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "ace", label: "ACE", icon: "agentic-context-engine" },
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

/** Open `sessionId` in the single pane, or a fresh session when null. The nonce keeps repeated opens distinct. */
function openSession(project: Project, sessionId: string | null, nonce: number) {
  const params = new Map<string, string>([
    ["project", project.id],
    sessionId ? ["session", sessionId] : ["new", "1"],
  ]);
  const action = workspaceNavigationAction({ get: (key) => params.get(key) ?? null }, project)!;
  return { ...action, key: `${action.key}#${nonce}` };
}

/** Address-bar navigation: the runtime is the policy authority, so private hosts pass the client-side syntax check. */
function navigateBrowser(tools: ReturnType<typeof useTools>, cwd: string, value: string) {
  const next = normalizeBrowserInput(value, cwd);
  if (!next) return;
  const accepted = /^file:\/\//i.test(next)
    ? sanitizeLocalFileUrl(next)
    : sanitizeBrowserPaneUrl(next, { allowPrivate: true });
  if (!accepted) return;
  tools.setBrowserUrl(accepted, accepted);
  if (/^file:\/\//i.test(accepted)) return;
  void fetch("/api/agent/browser/navigate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: accepted }),
  }).catch(() => undefined);
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
  const searchParams = useSearchParams();
  const nonce = useRef(0);
  const handled = useRef({ nav: "", projectId: "" });

  const sessions = useAceResource(cwd ? () => loadRecentSessions(cwd) : null, [cwd, piSessionId]);
  const proposals = useAceResource(cwd ? () => loadAceProposals(cwd) : null, [
    cwd,
    tab === "memory",
  ]);
  // The bridge pill: the extension host of the embedded workbench has said hello for this folder.
  const bridge = useAceResource(cwd ? () => loadIdeContext(cwd) : null, [cwd, tab, piSessionId]);
  const bridged = bridge.data?.connected === true;

  const open = (target: Project, sessionId: string | null) =>
    dispatch(openSession(target, sessionId, ++nonce.current));
  const openLatest = (target: Project) =>
    loadRecentSessions(target.path).then(
      (recent) => open(target, recent[0]?.id ?? null),
      () => open(target, null),
    );

  // A fresh `?project=&session=|new=` URL wins once (sidebar rows, ⌘N); any
  // other project switch reopens that folder's latest session.
  useMountSubscription(() => {
    if (!projects.loaded) return;
    const nav = searchParams.toString();
    if (nav && handled.current.nav !== nav) {
      handled.current.nav = nav;
      const target = projects.findById(searchParams.get("project") ?? "") ?? project;
      if (!target) return;
      handled.current.projectId = target.id;
      if (target !== project) projects.selectProject(target);
      if (searchParams.get("new") !== null) open(target, null);
      else if (searchParams.get("session")) open(target, searchParams.get("session"));
      else void openLatest(target);
      return;
    }
    if (!project || handled.current.projectId === project.id) return;
    handled.current.projectId = project.id;
    void openLatest(project);
  }, [projects.loaded, project?.id, searchParams, dispatch]);

  // The composer's browser toggle (and a model-driven navigation) lands on the
  // Browser tab, the way it opened the old computer panel.
  useMountSubscription(() => {
    if (tools.computer.open && tools.computer.tab === "browser") setTab("browser");
  }, [tools.computer.open, tools.computer.tab]);

  const pickSession = (sessionId: string | null) => {
    if (!project) return;
    open(project, sessionId);
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
        className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-(--border)/60 px-2"
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
            {item.icon ? (
              <TuumIcon name={item.icon} className="h-3.5 w-3.5 opacity-80" />
            ) : (
              <Globe className="h-3.5 w-3.5 opacity-80" strokeWidth={1.6} />
            )}
            {item.label}
            {item.id === "memory" && pending > 0 ? (
              <span className="rounded-full bg-(--warn)/20 px-1.5 text-[length:var(--fs-xs)] tabular-nums text-(--fg)">
                {pending}
              </span>
            ) : null}
          </button>
        ))}
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
        <TuumProviderBadge
          state={providerBadgeState(focused ?? null, false)}
          className="shrink-0"
        />
        <button
          type="button"
          disabled={!project}
          onClick={() => pickSession(null)}
          className="h-6 shrink-0 rounded-md px-2 text-[length:var(--fs-sm)] text-(--dim) hover:bg-(--hover) hover:text-(--fg) disabled:opacity-50"
        >
          New
        </button>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--border)/60 px-2">
        <TuumProviderBadge state={providerBadgeState(focused ?? null, false)} className="min-w-0" />
        <span className="ml-auto" />
        <span
          className={cx(
            "whitespace-nowrap rounded-full px-2 py-0.5 text-[length:var(--fs-xs)]",
            connected ? "bg-(--active) text-(--fg)" : "bg-(--surface-2)/40 text-(--dim)",
          )}
        >
          {connected ? "IDE loaded" : "IDE loading"}
        </span>
        <span
          title={
            bridged
              ? "The editor is connected to the agent runtime (IDE bridge)"
              : "No IDE bridge connection for this folder"
          }
          className={cx(
            "whitespace-nowrap rounded-full px-2 py-0.5 text-[length:var(--fs-xs)]",
            bridged ? "bg-(--active) text-(--fg)" : "bg-(--surface-2)/40 text-(--dim)",
          )}
        >
          {bridged ? "IDE connected" : "IDE offline"}
        </span>
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
        {project && piSessionId ? (
          <IdeChangesStrip
            cwd={cwd}
            sessionId={piSessionId}
            active={focused?.status === "running"}
          />
        ) : null}
      </div>
      {tab === "browser" ? (
        <Suspense fallback={null}>
          <LazyAgentBrowser
            url={tools.browser.url}
            inputValue={tools.browser.input}
            onInputChange={tools.setBrowserInput}
            onNavigate={(value) => navigateBrowser(tools, cwd, value)}
            onLocationChange={(next) => tools.setBrowserUrl(next, next)}
            visible={tab === "browser"}
            onClose={() => {
              tools.setComputerOpen(false);
              setTab("chat");
            }}
          />
        </Suspense>
      ) : null}
      {tab === "context" ? (
        <AceContextTab
          sessionId={focused?.id ?? null}
          piSessionId={piSessionId}
          cwd={cwd}
          finished={Boolean(piSessionId) && focused?.status === "idle"}
        />
      ) : null}
      {tab === "memory" ? <AceMemoryTab cwd={cwd} proposals={proposals} /> : null}
      {tab === "ace" ? <AceStatusTab cwd={cwd} /> : null}
    </aside>
  );
}
