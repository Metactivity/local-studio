"use client";

import { useRef, useState } from "react";
import { useProjects } from "@/features/agent/projects/context";
import { IdeAgentPanel } from "@/features/ide/ide-agent-panel";
import { useMountSubscription } from "@/hooks/use-mount-subscription";
import { tuumStudioTheme } from "@/lib/tuum-identity";
import { useAppStore } from "@/store";
import { cx } from "@/ui/utils";

const TUUM_SIGNALS = new Set(["tuum.ready", "tuum.focus"]);

// Right column width: M4 fixed it at clamp(400px, 26vw, 480px); M9 makes it a
// drag handle in this range, remembered per browser.
const PANEL_MIN = 360;
const PANEL_MAX = 640;
const PANEL_DEFAULT = 440;
const PANEL_KEY = "local-studio.idePanelWidth";

const clampPanel = (width: number) => Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(width)));

function storedPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(PANEL_KEY);
    return raw ? clampPanel(Number(raw)) : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

function storePanelWidth(width: number): void {
  try {
    window.localStorage.setItem(PANEL_KEY, String(width));
  } catch {
    /* private mode — the width simply is not remembered */
  }
}

function ideWorkbenchUrl(ideOrigin: string, folder: string, themeId: string): string {
  return `${ideOrigin}/ide/?folder=${encodeURIComponent(folder)}&theme=${encodeURIComponent(themeId)}`;
}

export function IdePage({ ideOrigin }: { ideOrigin: string }) {
  const { selectedProject, loaded } = useProjects();
  const themeId = useAppStore((s) => s.themeId);
  // The workbench boots on the theme of first render; later changes travel by
  // postMessage so a theme switch never reloads the editor.
  const [bootThemeId] = useState(themeId);
  const [connected, setConnected] = useState(false);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const folder = selectedProject?.path ?? "";
  const expectedOrigin = ideOrigin || (typeof window === "undefined" ? "" : window.location.origin);

  useMountSubscription(() => {
    setPanelWidth(storedPanelWidth());
  }, []);

  useMountSubscription(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (typeof type === "string" && TUUM_SIGNALS.has(type)) setConnected(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [expectedOrigin]);

  // Theme hand-off (M9): `{type: "tuum.theme", theme}` to the workbench on
  // every change. The ace-agent extension does not listen yet (M10 follow-up).
  useMountSubscription(() => {
    if (!expectedOrigin) return;
    frame.current?.contentWindow?.postMessage(
      { type: "tuum.theme", theme: tuumStudioTheme(themeId) },
      expectedOrigin,
    );
  }, [themeId, connected, expectedOrigin]);

  const commitWidth = (width: number) => {
    const next = clampPanel(width);
    setPanelWidth(next);
    storePanelWidth(next);
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = panelWidth;
    let width = startWidth;
    handle.setPointerCapture(event.pointerId);
    setResizing(true);
    const onMove = (move: PointerEvent) => {
      width = clampPanel(startWidth - (move.clientX - startX));
      setPanelWidth(width);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setResizing(false);
      commitWidth(width);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onHandleKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") commitWidth(panelWidth + step);
    else if (event.key === "ArrowRight") commitWidth(panelWidth - step);
    else if (event.key === "Home") commitWidth(PANEL_MAX);
    else if (event.key === "End") commitWidth(PANEL_MIN);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className={cx(
        "grid h-full min-h-0 w-full bg-(--agent-bg) text-(--fg)",
        // The iframe would swallow pointer events mid-drag.
        resizing && "select-none [&_iframe]:pointer-events-none",
      )}
      style={{ gridTemplateColumns: `minmax(0,1fr) 6px ${panelWidth}px` }}
    >
      <div className="min-h-0 min-w-0">
        {loaded && folder ? (
          <iframe
            ref={frame}
            key={folder}
            src={ideWorkbenchUrl(ideOrigin, folder, bootThemeId)}
            title="Tuum"
            allow="clipboard-read; clipboard-write"
            onLoad={() => setConnected(true)}
            className="block h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[length:var(--fs-md)] text-(--dim)">
            {loaded ? "Select a project to open it in the IDE." : "Loading projects..."}
          </div>
        )}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize agent panel"
        aria-valuemin={PANEL_MIN}
        aria-valuemax={PANEL_MAX}
        aria-valuenow={panelWidth}
        tabIndex={0}
        title="Resize agent panel"
        onPointerDown={startResize}
        onKeyDown={onHandleKey}
        className={cx(
          "cursor-col-resize border-l border-(--border)/60 transition-colors hover:bg-(--fg)/8",
          resizing && "bg-(--fg)/10",
        )}
      />
      <IdeAgentPanel connected={connected} />
    </div>
  );
}
