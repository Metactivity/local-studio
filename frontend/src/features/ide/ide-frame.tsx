"use client";

import { useRef, useState } from "react";
import { useMountSubscription } from "@/hooks/use-mount-subscription";
import { tuumStudioTheme } from "@/lib/tuum-identity";
import { useAppStore } from "@/store";

const TUUM_SIGNALS = new Set(["tuum.ready", "tuum.focus"]);

function ideWorkbenchUrl(ideOrigin: string, folder: string, themeId: string): string {
  return `${ideOrigin}/ide/?folder=${encodeURIComponent(folder)}&theme=${encodeURIComponent(themeId)}`;
}

/** The embedded Code-OSS workbench (ADR-034 M1): mounted in IDE mode only. */
export function IdeFrame({
  ideOrigin,
  folder,
  loaded,
  onConnected,
}: {
  ideOrigin: string;
  folder: string;
  loaded: boolean;
  onConnected: () => void;
}) {
  const themeId = useAppStore((s) => s.themeId);
  // The workbench boots on the theme of first render; later changes travel by
  // postMessage so a theme switch never reloads the editor.
  const [bootThemeId] = useState(themeId);
  const [connected, setConnected] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const expectedOrigin = ideOrigin || (typeof window === "undefined" ? "" : window.location.origin);
  const connect = () => {
    setConnected(true);
    onConnected();
  };

  useMountSubscription(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (typeof type === "string" && TUUM_SIGNALS.has(type)) connect();
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

  if (!loaded || !folder) {
    return (
      <div className="flex h-full items-center justify-center text-[length:var(--fs-md)] text-(--dim)">
        {loaded
          ? "Pick a project in the panel header to open it in the IDE — the chat keeps its session."
          : "Loading projects..."}
      </div>
    );
  }
  return (
    <iframe
      ref={frame}
      key={folder}
      src={ideWorkbenchUrl(ideOrigin, folder, bootThemeId)}
      title="Tuum"
      allow="clipboard-read; clipboard-write"
      onLoad={connect}
      className="block h-full w-full border-0"
    />
  );
}
