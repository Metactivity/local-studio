"use client";

import { cx } from "@/ui/utils";

// Right column width: M4 fixed it at clamp(400px, 26vw, 480px); M9 makes it a
// drag handle in this range, remembered per browser.
export const PANEL_MIN = 360;
export const PANEL_MAX = 640;
export const PANEL_DEFAULT = 440;
const PANEL_KEY = "local-studio.idePanelWidth";

export const clampPanel = (width: number) =>
  Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(width)));

export function storedPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(PANEL_KEY);
    return raw ? clampPanel(Number(raw)) : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

export function storePanelWidth(width: number): void {
  try {
    window.localStorage.setItem(PANEL_KEY, String(width));
  } catch {
    /* private mode — the width simply is not remembered */
  }
}

export function PanelResizeHandle({
  width,
  resizing,
  onResizing,
  onCommit,
}: {
  width: number;
  resizing: boolean;
  onResizing: (width: number | null) => void;
  onCommit: (width: number) => void;
}) {
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    let next = width;
    handle.setPointerCapture(event.pointerId);
    onResizing(next);
    const onMove = (move: PointerEvent) => {
      next = clampPanel(width - (move.clientX - startX));
      onResizing(next);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      onResizing(null);
      onCommit(next);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") onCommit(width + step);
    else if (event.key === "ArrowRight") onCommit(width - step);
    else if (event.key === "Home") onCommit(PANEL_MAX);
    else if (event.key === "End") onCommit(PANEL_MIN);
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize agent panel"
      aria-valuemin={PANEL_MIN}
      aria-valuemax={PANEL_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Resize agent panel"
      onPointerDown={startResize}
      onKeyDown={onKey}
      className={cx(
        "cursor-col-resize border-l border-(--border)/60 transition-colors hover:bg-(--fg)/8",
        resizing && "bg-(--fg)/10",
      )}
    />
  );
}
