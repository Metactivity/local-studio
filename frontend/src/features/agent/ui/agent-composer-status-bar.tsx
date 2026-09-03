"use client";

import { formatTokenCount } from "@/features/agent/messages";

export function AgentComposerStatusBar({
  cwd,
  currentContextTokens,
  contextWindow,
  onOpenStatus,
}: {
  cwd: string;
  currentContextTokens: number;
  contextWindow: number;
  onOpenStatus: () => void;
}) {
  const displayCwd = formatHomeRelativePath(cwd);

  return (
    <div className="relative z-20 mx-auto mt-1.5 flex w-full max-w-[calc(var(--composer-w)*0.9)] items-center gap-2 overflow-visible font-mono text-[length:var(--fs-xs)] text-(--dim) sm:w-[90%]">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-visible">
        <div className="min-w-0 max-w-[42%] shrink overflow-visible">
          {displayCwd ? (
            <span className="block min-w-0 truncate text-(--dim)" title={cwd}>
              {displayCwd}
            </span>
          ) : null}
        </div>
      </div>
      <ContextReadout
        current={currentContextTokens}
        contextWindow={contextWindow}
        onClick={onOpenStatus}
      />
    </div>
  );
}

function ContextReadout({
  current,
  contextWindow,
  onClick,
}: {
  current: number;
  contextWindow: number;
  onClick: () => void;
}) {
  const title = `Open status · Context ${formatTokenCount(current)} / ${formatTokenCount(contextWindow)}`;

  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-auto inline-flex shrink-0 items-center rounded-sm px-1 text-(--dim) hover:text-(--fg)/80"
      title={title}
      aria-label={title}
    >
      <span className="tabular-nums">
        {formatTokenCount(current)}/{formatTokenCount(contextWindow)}
      </span>
    </button>
  );
}

function formatHomeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return "";
  const homeMatch = normalized.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (homeMatch) return `~${homeMatch[1] ?? ""}`;
  return normalized;
}
