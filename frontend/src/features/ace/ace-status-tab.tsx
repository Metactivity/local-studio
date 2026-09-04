"use client";

import { useState } from "react";
import { Button } from "@/ui";
import { StatusGroup, StatusLine, type MeterTone } from "@/features/agent/ui/status-panel-parts";
import {
  loadAceStatus,
  rebuildAceGraph,
  restartAce,
  type AceStatusReport,
} from "@/features/ace/api";
import { useAceResource } from "@/features/ace/use-ace-resource";
import { AcePanelNotice } from "@/features/ace/ace-panel-notice";
import { BrowserBridgePairing } from "@/features/ace/browser-bridge-pairing";

function healthTone(health: string | undefined): MeterTone {
  if (health === "ready") return "ok";
  if (health === "degraded" || health === "starting") return "warn";
  if (health === "unavailable") return "err";
  return "dim";
}

function relative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return iso;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function shortUrl(url: string | null | undefined): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function StatusCard({ report }: { report: AceStatusReport }) {
  const graph = report.control?.graph;
  const memory = report.control?.memory;
  return (
    <>
      <StatusGroup title="Health">
        <StatusLine
          label="Service"
          value={report.health?.health ?? "not configured"}
          tone={healthTone(report.health?.health)}
          title={report.health?.detail}
        />
        <StatusLine
          label="Model"
          value={report.status?.model?.name ?? report.chatModel ?? "—"}
          tone={report.status?.model?.available === false ? "err" : "ok"}
        />
        <StatusLine
          label="Embeddings"
          value={report.status?.embeddings_available ? "available" : "unavailable"}
          tone={report.status?.embeddings_available ? "ok" : "warn"}
        />
        {report.status?.degraded ? (
          <StatusLine label="Degraded" value={report.status.degraded} tone="warn" />
        ) : null}
      </StatusGroup>
      <StatusGroup title="Endpoints">
        <StatusLine label="Mode" value={report.runtimeSnapshot?.mode ?? report.runtime ?? "—"} />
        <StatusLine
          label="Chat"
          value={shortUrl(report.runtimeSnapshot?.chatUrl)}
          title={report.runtimeSnapshot?.chatUrl ?? undefined}
        />
        <StatusLine
          label="Embed"
          value={shortUrl(report.runtimeSnapshot?.embedUrl)}
          title={report.runtimeSnapshot?.embedUrl ?? undefined}
        />
      </StatusGroup>
      <StatusGroup title="Graph">
        <StatusLine label="Files" value={String(graph?.indexed_files ?? 0)} />
        <StatusLine label="Symbols" value={String(graph?.entities ?? 0)} />
        <StatusLine
          label="Indexed"
          value={relative(graph?.last_indexed_at)}
          tone={graph?.last_indexed_at ? "ok" : "dim"}
        />
      </StatusGroup>
      <StatusGroup title="Store">
        <StatusLine
          label="Root"
          value={report.storeRoot ?? "—"}
          title={report.storeRoot ?? undefined}
        />
        <StatusLine
          label="Bullets"
          value={`${memory?.project_bullets ?? 0} project · ${memory?.global_bullets ?? 0} global`}
        />
        <StatusLine
          label="Inbox"
          value={`${memory?.pending_proposals ?? 0} pending`}
          tone={memory?.pending_proposals ? "warn" : "dim"}
        />
      </StatusGroup>
    </>
  );
}

export function AceStatusTab({ cwd }: { cwd: string }) {
  const status = useAceResource(cwd ? () => loadAceStatus(cwd) : null, [cwd]);
  const [busy, setBusy] = useState<"rebuild" | "restart" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (action: "rebuild" | "restart") => {
    setBusy(action);
    setNotice(null);
    try {
      if (action === "rebuild") {
        const result = await rebuildAceGraph(cwd);
        setNotice(
          `Graph rebuilt: ${result.indexedFiles} files indexed, ${result.pendingFiles} pending.`,
        );
      } else {
        const result = await restartAce();
        setNotice(result.ok ? "ACE restarted." : `ACE restart failed: ${result.health.detail}`);
      }
      status.reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4">
      {status.error ? <AcePanelNotice tone="error">{status.error}</AcePanelNotice> : null}
      {status.data ? (
        <StatusCard report={status.data} />
      ) : status.loading ? (
        <AcePanelNotice>Loading ACE status…</AcePanelNotice>
      ) : null}
      {status.data?.problems.length ? (
        <AcePanelNotice tone="error">{status.data.problems.join(" · ")}</AcePanelNotice>
      ) : null}
      <div className="mt-4 flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!cwd || busy !== null}
          loading={busy === "rebuild"}
          onClick={() => void run("rebuild")}
        >
          Rebuild graph
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy !== null}
          loading={busy === "restart"}
          onClick={() => void run("restart")}
        >
          Restart
        </Button>
        <Button size="sm" variant="ghost" disabled={status.loading} onClick={status.reload}>
          Refresh
        </Button>
      </div>
      {notice ? <AcePanelNotice>{notice}</AcePanelNotice> : null}
      <BrowserBridgePairing />
    </div>
  );
}
