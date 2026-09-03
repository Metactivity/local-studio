"use client";

// The Changes strip under the chat pane of /ide (ADR-034 M6): the files this
// session changed since its last turn checkpoint, with Open / Diff in the
// editor and Revert to checkpoint, plus the Standard profile's pending
// permission asks (Allow / Deny) — the runtime parks the tool call until one
// is answered. Polled while a turn runs; one fetch otherwise.

import { useState } from "react";
import { Button } from "@/ui";
import {
  answerPermission,
  loadCheckpoints,
  loadPendingPermissions,
  revertCheckpoint,
  showCheckpointFile,
} from "@/features/ace/api";
import { useAceResource } from "@/features/ace/use-ace-resource";
import { useMountSubscription } from "@/hooks/use-mount-subscription";

const POLL_MS = 2_000;

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

  useMountSubscription(() => {
    if (!active) return;
    const timer = setInterval(() => {
      checkpoints.reload();
      permissions.reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, checkpoints.reload, permissions.reload]);

  const run = (action: () => Promise<unknown>) => {
    setNotice(null);
    action().then(
      () => {
        checkpoints.reload();
        permissions.reload();
      },
      (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
    );
  };

  const pending = permissions.data ?? [];
  const report = checkpoints.data;
  const last = report?.checkpoints.at(-1) ?? null;
  const changed = report?.changed ?? [];
  if (pending.length === 0 && changed.length === 0 && !notice) return null;

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
            <span className="font-mono">{ask.toolName}</span> wants to write in the editor.
          </p>
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
            {changed.map((path) => (
              <li key={path} className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-xs)] text-(--fg)/80">
                  {path}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => run(() => showCheckpointFile(cwd, sessionId, null, path, "open"))}
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
            ))}
          </ul>
        </>
      ) : null}
      {notice ? <p className="mt-1 text-[length:var(--fs-xs)] text-(--err)">{notice}</p> : null}
    </section>
  );
}
