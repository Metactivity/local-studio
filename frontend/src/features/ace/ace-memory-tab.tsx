"use client";

import { useState } from "react";
import { Button } from "@/ui";
import { StatusGroup } from "@/features/agent/ui/status-panel-parts";
import {
  loadAceMemory,
  resolveAceProposal,
  type AceBullet,
  type AceProposal,
} from "@/features/ace/api";
import { useAceResource, type AceResource } from "@/features/ace/use-ace-resource";
import { AcePanelNotice } from "@/features/ace/ace-panel-notice";

function ProposalCard({
  proposal,
  onResolve,
}: {
  proposal: AceProposal;
  onResolve: (action: "accept" | "reject", content: string) => Promise<void>;
}) {
  const [content, setContent] = useState(proposal.content);
  const [busy, setBusy] = useState(false);
  const act = async (action: "accept" | "reject") => {
    setBusy(true);
    try {
      await onResolve(action, content);
    } finally {
      setBusy(false);
    }
  };
  const evidence = [...proposal.provenance.commands, ...proposal.provenance.files];
  return (
    <li className="rounded-[var(--rad-md)] border border-(--border) bg-(--surface) p-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[length:var(--fs-xs)] text-(--fg)/45">
        <span className="font-medium uppercase tracking-wide">{proposal.section}</span>
        <span>{proposal.confidence}</span>
        {proposal.guardrail ? <span>guardrail</span> : null}
        {proposal.duplicateCount > 0 ? (
          <span className="text-(--warn)">{proposal.duplicateCount} duplicate</span>
        ) : null}
      </div>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={3}
        aria-label="Proposal text"
        className="w-full resize-y rounded-[var(--rad-sm)] border border-(--border) bg-transparent px-2 py-1 text-[length:var(--fs-sm)] leading-5 text-(--fg) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--ring)"
      />
      {evidence.length ? (
        <p
          className="mt-1 truncate font-mono text-[length:var(--fs-xs)] text-(--dim)"
          title={evidence.join("\n")}
        >
          {evidence.join(" · ")}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !content.trim()}
          onClick={() => void act("accept")}
        >
          Accept
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("reject")}>
          Reject
        </Button>
      </div>
    </li>
  );
}

function BulletRow({ bullet }: { bullet: AceBullet }) {
  return (
    <li className="text-[length:var(--fs-sm)] leading-5 text-(--fg)/80 [overflow-wrap:anywhere]">
      <span className="font-mono text-[length:var(--fs-xs)] uppercase text-(--fg)/45">
        {bullet.section}
      </span>{" "}
      {bullet.content}
      <span className="text-(--dim)">
        {" "}
        · +{bullet.helpful}/−{bullet.harmful}
      </span>
    </li>
  );
}

export function AceMemoryTab({
  cwd,
  proposals,
}: {
  cwd: string;
  proposals: AceResource<AceProposal[]>;
}) {
  const memory = useAceResource(cwd ? () => loadAceMemory(cwd) : null, [cwd]);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (id: number, action: "accept" | "reject", content: string) => {
    setError(null);
    try {
      await resolveAceProposal(cwd, id, action, content);
      proposals.reload();
      memory.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const pending = proposals.data ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4">
      {error || proposals.error ? (
        <AcePanelNotice tone="error">{error ?? proposals.error}</AcePanelNotice>
      ) : null}
      <StatusGroup
        title="Inbox"
        count={pending.length}
        right={
          <Button size="sm" variant="ghost" disabled={proposals.loading} onClick={proposals.reload}>
            Refresh
          </Button>
        }
      >
        {pending.length ? (
          <ul className="grid gap-2">
            {pending.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                onResolve={(action, content) => resolve(proposal.id, action, content)}
              />
            ))}
          </ul>
        ) : (
          <AcePanelNotice>
            {proposals.loading ? "Loading proposals…" : "Nothing waiting for review."}
          </AcePanelNotice>
        )}
      </StatusGroup>
      {memory.error ? <AcePanelNotice tone="error">{memory.error}</AcePanelNotice> : null}
      {(["project", "global"] as const).map((scope) => (
        <StatusGroup
          key={scope}
          title={`${scope} playbook`}
          count={memory.data?.bullets[scope].length}
        >
          {memory.data?.bullets[scope].length ? (
            <ul className="grid gap-1">
              {memory.data.bullets[scope].map((bullet) => (
                <BulletRow key={bullet.id} bullet={bullet} />
              ))}
            </ul>
          ) : (
            <AcePanelNotice>{memory.loading ? "Loading…" : "No bullets yet."}</AcePanelNotice>
          )}
        </StatusGroup>
      ))}
    </div>
  );
}
