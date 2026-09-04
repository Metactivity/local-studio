"use client";

// The Browser Bridge card (MET-921): is a browser paired and connected, and
// the one-time code to pair one. Polls the runtime while mounted; the code
// itself comes from the status so it disappears once used or expired.

import { useState } from "react";
import { Button } from "@/ui";
import { StatusGroup, StatusLine, type MeterTone } from "@/features/agent/ui/status-panel-parts";
import {
  loadBrowserBridgeStatus,
  startBrowserBridgePairing,
  type BrowserBridgeStatus,
} from "@/features/ace/api";
import { useAceResource } from "@/features/ace/use-ace-resource";
import { AcePanelNotice } from "@/features/ace/ace-panel-notice";
import { useMountSubscription } from "@/hooks/use-mount-subscription";

const POLL_MS = 3_000;

function browserLine(status: BrowserBridgeStatus): { value: string; tone: MeterTone } {
  if (status.connected) return { value: "connected", tone: "ok" };
  if (status.paired) return { value: "paired, extension offline", tone: "warn" };
  return { value: "not paired", tone: "dim" };
}

export function BrowserBridgePairing() {
  const status = useAceResource(loadBrowserBridgeStatus, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useMountSubscription(() => {
    const timer = setInterval(status.reload, POLL_MS);
    return () => clearInterval(timer);
  }, [status.reload]);

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      await startBrowserBridgePairing();
      status.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const report = status.data;
  const browser = report ? browserLine(report) : null;
  return (
    <>
      <StatusGroup
        title="Browser bridge"
        right={
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !report}
            loading={busy}
            onClick={() => void pair()}
          >
            Pair a browser
          </Button>
        }
      >
        {browser && report ? (
          <>
            <StatusLine label="Browser" value={browser.value} tone={browser.tone} />
            <StatusLine label="Station" value={report.stationUrl} />
            {report.connected ? (
              <StatusLine
                label="Mode"
                value={report.readOnly ? "read-only" : "actions allowed"}
                tone={report.readOnly ? "dim" : "warn"}
              />
            ) : null}
            {report.pairing ? (
              <StatusLine
                label="Code"
                value={report.pairing.code}
                title={`Enter it in the extension popup before ${new Date(report.pairing.expiresAt).toLocaleTimeString()}`}
                tone="warn"
              />
            ) : null}
          </>
        ) : (
          <StatusLine
            label="Browser"
            value={status.error ? "unavailable" : "…"}
            tone={status.error ? "err" : "dim"}
          />
        )}
      </StatusGroup>
      {(error ?? status.error) ? (
        <AcePanelNotice tone="error">{error ?? status.error}</AcePanelNotice>
      ) : null}
    </>
  );
}
