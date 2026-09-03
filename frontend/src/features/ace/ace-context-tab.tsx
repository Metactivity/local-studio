"use client";

import { Button } from "@/ui";
import { StatusGroup, StatusLine } from "@/features/agent/ui/status-panel-parts";
import { loadAceLens, type AceJournalRecord } from "@/features/ace/api";
import { useAceResource } from "@/features/ace/use-ace-resource";
import { AcePanelNotice } from "@/features/ace/ace-panel-notice";

type LensItem = { kind: string; source: string; raison?: string };
type Lens = {
  promptOriginal: string;
  selections: LensItem[];
  rejetes: { source: string; raison?: string }[];
  exclusions: LensItem[];
  verdictGate: { usable: boolean; why: string } | null;
  usedLocalModel: boolean;
  dureeMs: number | null;
  degraded: string[];
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** The journal of the newest turn, split by record type. */
function lastTurn(records: AceJournalRecord[]) {
  const turnId = records.at(-1)?.turnId;
  const turn = turnId ? records.filter((entry) => entry.turnId === turnId) : [];
  const of = (type: string) => turn.filter((entry) => entry.type === type);
  return {
    turnId,
    turn,
    lens: of("ace.lens").at(-1),
    router: of("ace.router").at(-1),
    gates: of("ace.gate"),
    compactions: of("ace.compaction"),
    evaluation: of("ace.evaluation").at(-1),
  };
}

function SourceRow({ item }: { item: LensItem }) {
  return (
    <li className="text-[length:var(--fs-sm)] leading-5 text-(--fg)/80 [overflow-wrap:anywhere]">
      <span className="font-mono text-[length:var(--fs-xs)] uppercase text-(--fg)/45">
        {item.kind}
      </span>{" "}
      {item.source}
      {item.raison ? <span className="text-(--dim)"> — {item.raison}</span> : null}
    </li>
  );
}

function TurnLens({ records }: { records: AceJournalRecord[] }) {
  const turn = lastTurn(records);
  if (!turn.turnId)
    return (
      <AcePanelNotice>
        No turn yet in this session — the lens fills after the first prompt.
      </AcePanelNotice>
    );
  const lens = record(turn.lens?.payload.lens) as unknown as Lens | undefined;
  const verdict = record(turn.router?.payload.verdict);
  const evaluation = record(turn.evaluation?.payload);
  return (
    <>
      <StatusGroup title="Prompt">
        <p className="text-[length:var(--fs-sm)] leading-5 text-(--fg)/80 [overflow-wrap:anywhere]">
          {lens?.promptOriginal ?? "—"}
        </p>
        <StatusLine
          label="Router"
          value={
            verdict.class
              ? `${String(verdict.class)} · ${String(verdict.stage)} · ${Math.round(Number(verdict.confidence ?? 0) * 100)}%`
              : "—"
          }
        />
        <StatusLine
          label="Injected"
          value={`${Number(turn.lens?.payload.injectedChars ?? 0)} chars · ${(turn.lens?.payload.bulletIds as unknown[] | undefined)?.length ?? 0} bullets`}
        />
      </StatusGroup>
      <StatusGroup title="Sources" count={lens?.selections.length ?? 0}>
        {lens?.selections.length ? (
          <ul className="grid gap-1">
            {lens.selections.map((item, index) => (
              <SourceRow key={`${item.source}-${index}`} item={item} />
            ))}
          </ul>
        ) : (
          <AcePanelNotice>No context injected for this turn.</AcePanelNotice>
        )}
        {lens?.rejetes.length ? (
          <StatusLine
            label="Rejected"
            value={lens.rejetes.map((item) => item.source).join(", ")}
            tone="dim"
          />
        ) : null}
        {lens?.exclusions.length ? (
          <StatusLine
            label="Excluded"
            value={lens.exclusions.map((item) => item.source).join(", ")}
            tone="dim"
          />
        ) : null}
      </StatusGroup>
      <StatusGroup title="Gates" count={turn.gates.length}>
        <StatusLine
          label="Discovery"
          value={
            lens?.verdictGate
              ? lens.verdictGate.usable
                ? "usable"
                : `fallback — ${lens.verdictGate.why}`
              : lens?.usedLocalModel
                ? "local model"
                : "not run"
          }
          tone={lens?.verdictGate && !lens.verdictGate.usable ? "warn" : "dim"}
        />
        {lens?.dureeMs != null ? (
          <StatusLine label="Duration" value={`${lens.dureeMs} ms`} />
        ) : null}
        {turn.gates.map((gate) => {
          const decision = record(gate.payload.decision);
          return (
            <StatusLine
              key={gate.seq}
              label={String(gate.payload.toolName)}
              value={
                decision.allow
                  ? "allowed"
                  : `blocked · ${String(decision.source ?? decision.reason ?? "gate")}`
              }
              tone={decision.allow ? "ok" : "err"}
            />
          );
        })}
        {lens?.degraded.length ? (
          <StatusLine label="Degraded" value={lens.degraded.join(", ")} tone="warn" />
        ) : null}
      </StatusGroup>
      {turn.compactions.length ? (
        <StatusGroup title="Compaction" count={turn.compactions.length}>
          {turn.compactions.map((entry) => (
            <StatusLine
              key={entry.seq}
              label={String(entry.payload.toolName)}
              value={`${Number(entry.payload.originalChars)} → ${Number(entry.payload.compactedChars)} chars`}
            />
          ))}
        </StatusGroup>
      ) : null}
      {turn.evaluation ? (
        <StatusGroup title="Evaluation">
          <StatusLine
            label="Outcome"
            value={String(evaluation.outcome)}
            tone={evaluation.outcome === "completed" ? "ok" : "warn"}
          />
          {(evaluation.signals as string[] | undefined)?.map((signal) => (
            <StatusLine key={signal} label="Signal" value={signal} tone="dim" />
          ))}
        </StatusGroup>
      ) : null}
    </>
  );
}

export function AceContextTab({
  sessionId,
  piSessionId,
}: {
  sessionId: string | null;
  piSessionId: string | null;
}) {
  const lens = useAceResource(sessionId ? () => loadAceLens(sessionId, piSessionId) : null, [
    sessionId,
    piSessionId,
  ]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4">
      {lens.error ? <AcePanelNotice tone="error">{lens.error}</AcePanelNotice> : null}
      {lens.data ? (
        <TurnLens records={lens.data} />
      ) : lens.loading ? (
        <AcePanelNotice>Loading the Context Lens…</AcePanelNotice>
      ) : (
        <AcePanelNotice>Open a session to see what ACE injected.</AcePanelNotice>
      )}
      <div className="mt-4">
        <Button
          size="sm"
          variant="ghost"
          disabled={!sessionId || lens.loading}
          onClick={lens.reload}
        >
          Refresh
        </Button>
      </div>
    </div>
  );
}
