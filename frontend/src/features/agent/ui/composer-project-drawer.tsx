"use client";

import { useCallback, useState, type ReactNode } from "react";
import { ChevronDown, FolderOpen, ListChecks, Plus } from "@/ui/icon-registry";
import { useMountSubscription } from "@/hooks/use-mount-subscription";
import { useProjects } from "@/features/agent/projects/context";
import type { Project } from "@/features/agent/projects/types";
import { GoalCard, type GoalDraft } from "@/features/agent/ui/goal-card";
import { GoalStrip } from "@/features/agent/ui/goal-strip";
import { useSessionGoal } from "@/features/agent/ui/use-session-goal";
import { ADD_PROJECT_EVENT } from "@/lib/workspace-events";
import { cx } from "@/ui/utils";
import { QueuedMessageStack } from "@/features/agent/ui/queued-message-stack";
import type { QueuedMessage } from "@/features/agent/messages";

const iconButtonClass =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-(--fg)/42 transition-colors hover:bg-(--hover) hover:text-(--fg)/82 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--fg)/25";

const listRowClass =
  "flex h-8 w-full items-center gap-2 rounded-[10px] px-2 text-left transition-colors";

const searchInputClass =
  "h-7 w-full min-w-0 rounded-md bg-(--fg)/[0.04] px-2 text-[length:var(--fs-xs)] text-(--fg) outline-none placeholder:text-(--fg)/30 focus:bg-(--fg)/[0.06]";

export function ComposerProjectDrawer({
  piSessionId,
  revision,
  projectName,
  cwd,
  canPickProject,
  onProjectPicked,
  queueItems,
  running,
  onEditQueued,
  onRemoveQueued,
  onSteerQueued,
}: {
  piSessionId: string | null;
  revision: number;
  projectName: string | null;
  cwd: string;
  canPickProject: boolean;
  onProjectPicked: (project: Project) => void;
  queueItems: QueuedMessage[];
  running: boolean;
  onEditQueued: (queueId: string, text: string) => void;
  onRemoveQueued: (queueId: string) => void;
  onSteerQueued: (queueId: string) => void;
}) {
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const {
    goal,
    error: goalError,
    patch: patchGoal,
    clear: clearGoal,
  } = useSessionGoal(piSessionId, revision);

  const submitGoal = useCallback(
    (draft: GoalDraft) => {
      void patchGoal({
        objective: draft.objective,
        turnBudget: draft.turnBudget,
        status: "active",
        resetTurns: draft.resetProgress,
      });
    },
    [patchGoal],
  );

  const activeProject = projects.findByPath(cwd) ?? projects.selectedProject;
  const [hydrated, setHydrated] = useState(false);
  useMountSubscription(() => setHydrated(true), []);
  const label = hydrated
    ? (projectName ?? activeProject?.name ?? "Choose project")
    : "Choose project";
  const hasQueue = queueItems.length > 0;

  const pickProject = (project: Project) => {
    projects.selectProject(project);
    onProjectPicked(project);
    setOpen(false);
  };

  const addProject = () => {
    setOpen(false);
    window.dispatchEvent(new Event(ADD_PROJECT_EVENT));
  };

  return (
    <>
      {goal ? (
        <GoalStrip
          goal={goal}
          onTogglePause={() =>
            void patchGoal({ status: goal.status === "paused" ? "active" : "paused" })
          }
          onClear={() => void clearGoal()}
          onOpen={() => setOpen(true)}
        />
      ) : null}
      <section
        data-testid="composer-drawer"
        className="relative z-0 mx-auto -mb-3 w-[calc(100%_-_26px)] max-w-[calc(var(--composer-w)*0.9_-_26px)] overflow-hidden rounded-[var(--composer-radius-inner)] border border-(--border) bg-(--fg)/[0.022] pb-2 text-[length:var(--fs-xs)] md:pb-3 md:text-[length:var(--fs-sm)] [corner-shape:superellipse(1.5)] sm:w-[calc(90%_-_26px)]"
      >
        <div className="flex items-center px-1.5 pt-1">
          <DrawerSummaryButton
            open={open}
            onToggle={() => setOpen((value) => !value)}
            label={label}
            queueCount={queueItems.length}
          />
        </div>
        {hasQueue ? (
          <div className="px-1.5 pb-0.5">
            <QueuedMessageStack
              items={queueItems}
              running={running}
              onEdit={onEditQueued}
              onRemove={onRemoveQueued}
              onSteer={onSteerQueued}
            />
          </div>
        ) : null}
        {open ? (
          <div className="flex max-h-[62vh] flex-col gap-0.5 overflow-y-auto px-1.5 pt-1">
            <GoalCard
              goal={goal}
              running={running}
              error={goalError}
              onSubmit={submitGoal}
              onTogglePause={() =>
                void patchGoal({ status: goal?.status === "paused" ? "active" : "paused" })
              }
              onRestart={() => void patchGoal({ status: "active", resetTurns: true })}
              onClear={() => void clearGoal()}
            />
            <div className="my-1 h-px shrink-0 bg-(--separator)" />
            <ProjectList
              canPickProject={canPickProject}
              cwd={cwd}
              projects={projects.projects}
              activeProjectId={activeProject?.id ?? null}
              onPick={pickProject}
              onAdd={addProject}
            />
          </div>
        ) : null}
      </section>
    </>
  );
}

function ProjectList({
  canPickProject,
  cwd,
  projects,
  activeProjectId,
  onPick,
  onAdd,
}: {
  canPickProject: boolean;
  cwd: string;
  projects: Project[];
  activeProjectId: string | null;
  onPick: (project: Project) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const filtered = projects.filter(
    (project) =>
      !text ||
      project.name.toLowerCase().includes(text) ||
      project.path.toLowerCase().includes(text),
  );

  if (!canPickProject) {
    return (
      <div className={cx(listRowClass, "text-(--fg)/56")}>
        <FolderOpen className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-xs)]">
          {cwd || "No working directory"}
        </span>
      </div>
    );
  }
  return (
    <div>
      <div className="flex h-7 w-full items-center gap-1.5 rounded-[10px] px-2 text-[length:var(--fs-sm)] font-medium text-(--fg)/52">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-(--fg)/46" strokeWidth={1.7} />
        <span className="min-w-0 flex-1 truncate">Projects</span>
        {projects.length > 0 ? <span className="text-(--fg)/34">{projects.length}</span> : null}
        <button
          type="button"
          onClick={onAdd}
          className={iconButtonClass}
          aria-label="Add project"
          title="Add project"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="px-2 pb-0.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search projects…"
          className={searchInputClass}
        />
      </div>
      <div className="flex max-h-44 flex-col overflow-y-auto">
        {filtered.map((project) => {
          const active = project.id === activeProjectId;
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => onPick(project)}
              className={cx(listRowClass, active ? "bg-(--hover)/60" : "hover:bg-(--hover)")}
            >
              <span
                className={cx(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  active ? "bg-(--accent)" : "bg-(--dim)/35",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-(--fg)/78">{project.name}</span>
            </button>
          );
        })}
        {filtered.length === 0 ? (
          <div className={cx(listRowClass, "text-(--fg)/40")}>No matching projects</div>
        ) : null}
        <button
          type="button"
          onClick={onAdd}
          className={cx(listRowClass, "text-(--fg)/56 hover:bg-(--hover) hover:text-(--fg)/82")}
        >
          <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          Add project…
        </button>
      </div>
    </div>
  );
}

function DrawerSummaryButton({
  open,
  onToggle,
  label,
  queueCount,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  queueCount: number;
}) {
  const hasQueue = queueCount > 0;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-8 max-w-full min-w-0 items-center gap-2 rounded-[10px] px-2 text-left text-(--fg)/78 transition-colors hover:bg-(--hover)"
    >
      {hasQueue ? (
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-(--fg)/56" strokeWidth={1.7} />
      ) : (
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-(--fg)/56" strokeWidth={1.7} />
      )}
      <span className="min-w-0 truncate">
        {hasQueue ? `${queueCount} queued message${queueCount === 1 ? "" : "s"}` : label}
      </span>
      <ChevronDown
        className={cx(
          "h-3.5 w-3.5 shrink-0 text-(--fg)/36 transition-transform",
          open && "rotate-180",
        )}
        strokeWidth={1.75}
      />
    </button>
  );
}
