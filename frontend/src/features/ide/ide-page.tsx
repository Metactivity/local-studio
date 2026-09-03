"use client";

import { useState } from "react";
import { useProjects } from "@/features/agent/projects/context";
import { IdeAgentPanel } from "@/features/ide/ide-agent-panel";
import { useMountSubscription } from "@/hooks/use-mount-subscription";
import { useAppStore } from "@/store";

const TUUM_SIGNALS = new Set(["tuum.ready", "tuum.focus"]);

function ideWorkbenchUrl(ideOrigin: string, folder: string, themeId: string): string {
  return `${ideOrigin}/ide/?folder=${encodeURIComponent(folder)}&theme=${encodeURIComponent(themeId)}`;
}

export function IdePage({ ideOrigin }: { ideOrigin: string }) {
  const { selectedProject, loaded } = useProjects();
  const themeId = useAppStore((s) => s.themeId);
  const [connected, setConnected] = useState(false);
  const folder = selectedProject?.path ?? "";

  useMountSubscription(() => {
    const expectedOrigin = ideOrigin || window.location.origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (typeof type === "string" && TUUM_SIGNALS.has(type)) setConnected(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [ideOrigin]);

  return (
    <div className="grid h-full min-h-0 w-full grid-cols-[minmax(0,1fr)_clamp(400px,26vw,480px)] bg-(--agent-bg) text-(--fg)">
      <div className="min-h-0 min-w-0">
        {loaded && folder ? (
          <iframe
            key={folder}
            src={ideWorkbenchUrl(ideOrigin, folder, themeId)}
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
      <IdeAgentPanel connected={connected} />
    </div>
  );
}
