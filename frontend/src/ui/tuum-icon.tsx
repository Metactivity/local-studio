"use client";

// Tuum Production Design Kit glyphs, served from public/tuum (see
// scripts/sync-tuum-assets.sh). Product icons are `currentColor` SVGs: drawn
// through a CSS mask so they take the surrounding text colour like a Lucide
// icon. Brand marks keep their own colours and render as plain images.

import { TUUM } from "@/lib/tuum-identity";
import { cx } from "./utils";

export type TuumIconName =
  | "agent-session"
  | "agentic-context-engine"
  | "context-lens"
  | "handoff"
  | "local-runtime"
  | "memory"
  | "orchestration"
  | "verified-change"
  | "worktree";

const mask = (url: string) => ({
  maskImage: `url(${url})`,
  WebkitMaskImage: `url(${url})`,
  maskSize: "contain",
  WebkitMaskSize: "contain",
  maskRepeat: "no-repeat",
  WebkitMaskRepeat: "no-repeat",
  maskPosition: "center",
  WebkitMaskPosition: "center",
});

export function TuumIcon({ name, className }: { name: TuumIconName; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block shrink-0 bg-current", className ?? "h-4 w-4")}
      style={mask(`${TUUM.assets}/icons/tuum-${name}.svg`)}
    />
  );
}

/** A kit icon shaped like the Lucide components the nav consumes. */
export function tuumIcon(name: TuumIconName) {
  const Icon = ({ className }: { className?: string; strokeWidth?: number }) => (
    <TuumIcon name={name} className={className} />
  );
  Icon.displayName = `TuumIcon(${name})`;
  return Icon;
}

/** The modular-matrix symbol (kit `tuum-symbol-20` geometry): modules follow the
 *  text colour so the mark reads on dark and light canvases alike; the T core
 *  stays Mineral Teal through `--brand-teal`, whatever the theme accent is. */
export function TuumSymbol({
  size = 20,
  className,
}: {
  size?: 8 | 12 | 16 | 20;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      aria-hidden
      className={cx("shrink-0", className)}
    >
      <g fill="currentColor">
        <rect width="5" height="5" rx="0.833" />
        <rect x="6.667" width="5" height="5" rx="0.833" />
        <rect x="13.333" width="5" height="5" rx="0.833" />
        <rect y="6.667" width="5" height="5" rx="0.833" />
        <rect x="13.333" y="6.667" width="5" height="5" rx="0.833" />
        <rect y="13.333" width="5" height="5" rx="0.833" />
        <rect x="13.333" y="13.333" width="5" height="5" rx="0.833" />
      </g>
      <g fill="var(--brand-teal)">
        <rect x="6.667" y="6.667" width="5" height="5" rx="0.833" />
        <rect x="8.333" y="11.25" width="1.667" height="6.667" rx="0.625" />
      </g>
    </svg>
  );
}

/** The wordmark as a mask so it follows the text colour on every theme. */
export function TuumWordmark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label={TUUM.name}
      className={cx("inline-block bg-current", className ?? "h-3 w-[26px]")}
      style={mask(`${TUUM.assets}/brand/tuum-wordmark.svg`)}
    />
  );
}
