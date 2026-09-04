"use client";

// The Changes strip under the chat pane of /ide (ADR-034 M6/M7): the files
// this session changed since its last turn checkpoint — each with the IDE's
// error/warning count — with Open / Diff in the editor and Revert to
// checkpoint, the `[tuum]` terminal runs of the session (exit code, output
// tail), plus the Standard profile's pending permission asks (Allow / Deny) —
// the runtime parks the tool call until one is answered. Polled while a turn
// runs; one fetch otherwise.

import { useState } from "react";
import { Button } from "@/ui";
import {
  answerPermission,
  type IdeTerminalRun,
  loadCheckpoints,
  loadIdeContext,
  loadIdeTerminals,
  loadPendingPermissions,
  revertCheckpoint,
  showCheckpointFile,
} from "@/features/ace/api";
import { useAceResource } from "@/features/ace/use-ace-resource";
import { useMountSubscription } from "@/hooks/use-mount-subscription";
import { cx } from "@/ui/utils";

const POLL_MS = 2_000;

const fileOf = (uri: string): string => {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:" ? decodeURIComponent(parsed.pathname) : uri;
  } catch {
    return uri;
  }
};

function runStatus(run: IdeTerminalRun): { label: string; tone: "ok" | "err" | "dim" } {
  if (run.exitCode === 0) return { label: "exit 0", tone: "ok" };
  if (run.exitCode !== null) return { label: `exit ${run.exitCode}`, tone: "err" };
  if (!run.endedAt) return { label: "running", tone: "dim" };
  return { label: run.captured ? "timeout" : "no capture", tone: "dim" };
}

export function IdeChangesStrip({
  cwd,
  sessionId,
  active,
}: {
  cwd: string;
  sessionId: string;
  active: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const checkpoints = useAceResource(() => loadCheckpoints(cwd, sessionId), [cwd, sessionId]);
  const permissions = useAceResource(() => loadPendingPermissions(cwd), [cwd, sessionId]);
  const terminals = useAceResource(() => loadIdeTerminals(cwd, sessionId), [cwd, sessionId]);
  const ide = useAceResource(() => loadIdeContext(cwd), [cwd, sessionId]);

  useMountSubscription(() => {
    if (!active) return;
    const timer = setInterval(() => {
      checkpoints.reload();
      permissions.reload();
      terminals.reload();
      ide.reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, checkpoints.reload, permissions.reload, terminals.reload, ide.reload]);

  const run = (action: () => Promise<unknown>) => {
    setNotice(null);
    action().then(
      () => {
        checkpoints.reload();
        permissions.reload();
        terminals.reload();
        ide.reload();
      },
      (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
    );
  };

  const pending = permissions.data ?? [];
  const report = checkpoints.data;
  const last = report?.checkpoints.at(-1) ?? null;
  const changed = report?.changed ?? [];
  const runs = terminals.data ?? [];
  const diagnostics = Object.entries(ide.data?.context?.diagnostics ?? {});
  const diagnosticsFor = (path: string) =>
    diagnostics.find(([uri]) => fileOf(uri) === `${cwd}/${path}`)?.[1] ?? null;
  if (pending.length === 0 && changed.length === 0 && runs.length === 0 && !notice) return null;

  return (
    <section
      aria-label="Changes"
      className="shrink-0 border-t border-(--border)/60 px-3 py-2 text-[length:var(--fs-sm)]"
    >
      {pending.map((ask) => (
        <div
          key={ask.requestId}
          className="mb-2 rounded-md border border-(--warn)/40 bg-(--warn)/10 px-2 py-1.5"
        >
          <p className="text-(--fg)">
            <span className="font-mono">{ask.toolName}</span>{" "}
            {ask.toolName === "bash" || ask.toolName === "ide_run_terminal"
              ? "wants to run a command that modifies state."
              : "wants to write in the editor."}
          </p>
          {typeof (ask.args as { command?: unknown })?.command === "string" ? (
            <pre className="my-1 max-h-24 overflow-auto rounded-md bg-(--surface-2)/40 p-1.5 font-mono text-[length:var(--fs-xs)] text-(--fg)/80 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {(ask.args as { command: string }).command}
            </pre>
          ) : null}
          <p className="text-[length:var(--fs-xs)] text-(--dim) [overflow-wrap:anywhere]">
            {ask.reason}
          </p>
          <div className="mt-1 flex gap-1">
            <Button size="sm" onClick={() => run(() => answerPermission(ask.requestId, "allow"))}>
              Allow
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => run(() => answerPermission(ask.requestId, "deny"))}
            >
              Deny
            </Button>
          </div>
        </div>
      ))}
      {changed.length > 0 ? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-(--dim)">
              {changed.length} file{changed.length > 1 ? "s" : ""} changed since checkpoint{" "}
              {last?.n ?? "?"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={!last}
              onClick={() => last && run(() => revertCheckpoint(cwd, sessionId, last.n))}
            >
              Revert to checkpoint
            </Button>
          </div>
          <ul className="mt-1 grid gap-0.5">
            {changed.map((path) => {
              const counts = diagnosticsFor(path);
              return (
                <li key={path} className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-xs)] text-(--fg)/80">
                    {path}
                  </span>
                  {counts ? (
                    <span
                      title={`${counts.errors} error(s), ${counts.warnings} warning(s) in the editor`}
                      className={cx(
                        "shrink-0 rounded-full px-1.5 text-[length:var(--fs-xs)] tabular-nums",
                        counts.errors > 0
                          ? "bg-(--err)/15 text-(--err)"
                          : "bg-(--warn)/15 text-(--fg)",
                      )}
                    >
                      {counts.errors}E {counts.warnings}W
                    </span>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      run(() => showCheckpointFile(cwd, sessionId, null, path, "open"))
                    }
                  >
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!last}
                    onClick={() =>
                      last && run(() => showCheckpointFile(cwd, sessionId, last.n, path, "diff"))
                    }
                  >
                    Diff
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {runs.length > 0 ? (
        <ul className="mt-1 grid gap-0.5">
          {runs.map((entry) => {
            const status = runStatus(entry);
            return (
              <li key={`${entry.startedAt}-${entry.name}`}>
                <details>
                  <summary className="flex cursor-pointer items-center gap-2 text-[length:var(--fs-xs)]">
                    <span className="shrink-0 text-(--dim)">Terminal</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-(--fg)/80">
                      [tuum] {entry.name} · {entry.command}
                    </span>
                    <span
                      className={cx(
                        "shrink-0 tabular-nums",
                        status.tone === "ok" && "text-(--fg)",
                        status.tone === "err" && "text-(--err)",
                        status.tone === "dim" && "text-(--dim)",
                      )}
                    >
                      {status.label}
                    </span>
                  </summary>
                  {entry.tail ? (
                    <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-(--surface-2)/40 p-2 font-mono text-[length:var(--fs-xs)] text-(--fg)/80 whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {entry.tail}
                    </pre>
                  ) : null}
                </details>
              </li>
            );
          })}
        </ul>
      ) : null}
      {notice ? <p className="mt-1 text-[length:var(--fs-xs)] text-(--err)">{notice}</p> : null}
    </section>
  );
}
