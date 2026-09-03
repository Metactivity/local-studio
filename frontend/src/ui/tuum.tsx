"use client";

// Design Kit components (ADR-034 M9, MET-834): status is said twice — by the
// text and by the colour — never by colour alone.

import { useSyncExternalStore, type ReactNode } from "react";
import { TUUM } from "@/lib/tuum-identity";
import { cx } from "./utils";

export type TuumProviderState =
  | "idle"
  | "thinking"
  | "tool-use"
  | "waiting"
  | "completed"
  | "error";

const PROVIDER_LABEL: Record<TuumProviderState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  "tool-use": "Running tool",
  waiting: "Waiting for you",
  completed: "Completed",
  error: "Error",
};

const PROVIDER_DOT: Record<TuumProviderState, string> = {
  idle: "bg-(--hl2)",
  thinking: "bg-(--running)",
  "tool-use": "bg-(--running)",
  waiting: "bg-(--warn)",
  completed: "bg-(--ok)",
  error: "bg-(--err)",
};

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const pageVisible = () => document.visibilityState === "visible";

/** 1200 ms linear arc; static ring + "Thinking…" under reduced motion; paused while the tab is hidden. */
export function TuumThinkingIndicator({ className }: { className?: string }) {
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)} role="status">
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden>
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="2"
        />
        <path
          d="M8 2a6 6 0 0 1 6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="tuum-arc origin-center"
          style={{ animationPlayState: visible ? "running" : "paused" }}
        />
      </svg>
      <span className="motion-safe:sr-only">Thinking…</span>
    </span>
  );
}

export function TuumProviderBadge({
  state,
  className,
}: {
  state: TuumProviderState;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center gap-1.5 rounded-full border border-(--border) px-2 text-[length:var(--fs-xs)] text-(--fg)",
        className,
      )}
      title={`${TUUM.provider} · ${PROVIDER_LABEL[state]}`}
    >
      {state === "thinking" ? (
        <TuumThinkingIndicator className="text-(--running)" />
      ) : (
        <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", PROVIDER_DOT[state])} />
      )}
      <span className="text-(--dim)">{TUUM.provider}</span>
      <span aria-hidden className="text-(--hl2)">
        ·
      </span>
      <span>{PROVIDER_LABEL[state]}</span>
    </span>
  );
}

/** Provider · model · local time under a settled assistant turn. */
export function TuumResponseAttribution({
  model,
  timestamp,
}: {
  model: string;
  timestamp?: string;
}) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 font-mono text-[length:var(--fs-xs)] text-(--fg)/45">
      <span>{TUUM.provider}</span>
      <span aria-hidden>·</span>
      <span className="text-(--fg)/60">{model}</span>
      {timestamp ? (
        <>
          <span aria-hidden>·</span>
          <time>{timestamp}</time>
        </>
      ) : null}
    </p>
  );
}

export type TuumStatusState = "ready" | "busy" | "warning" | "unavailable";

const STATUS_LABEL: Record<TuumStatusState, string> = {
  ready: "Ready",
  busy: "Busy",
  warning: "Warning",
  unavailable: "Unavailable",
};

const STATUS_DOT: Record<TuumStatusState, string> = {
  ready: "bg-(--ok)",
  busy: "bg-(--running)",
  warning: "bg-(--warn)",
  unavailable: "bg-(--err)",
};

/** Text-first "Tuum Core · Ready" line for the ACE state machine. */
export function TuumStatusIndicator({
  state,
  detail,
}: {
  state: TuumStatusState;
  detail?: string;
}) {
  return (
    <p className="flex items-center gap-2 text-[length:var(--fs-sm)] text-(--fg)" title={detail}>
      <span aria-hidden className={cx("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[state])} />
      <span className="text-(--dim)">{TUUM.provider}</span>
      <span aria-hidden className="text-(--hl2)">
        ·
      </span>
      <span className="font-medium">{STATUS_LABEL[state]}</span>
      {detail ? <span className="truncate text-(--dim)">— {detail}</span> : null}
    </p>
  );
}

export type TuumEmptyIllustration = "no-context" | "local-unavailable" | "session-complete";

/** One sentence + one action; the illustration is decorative and hidden from assistive tech. */
export function TuumEmptyState({
  illustration,
  title,
  children,
}: {
  illustration: TuumEmptyIllustration;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <img
        src={`${TUUM.assets}/illustrations/tuum-empty-${illustration}.svg`}
        alt=""
        aria-hidden
        width={240}
        height={100}
        className="max-w-full opacity-90"
      />
      <p className="text-[length:var(--fs-sm)] text-(--fg)">{title}</p>
      {children ? <div className="text-[length:var(--fs-xs)] text-(--dim)">{children}</div> : null}
    </div>
  );
}
