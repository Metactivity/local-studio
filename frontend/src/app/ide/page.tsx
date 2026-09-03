import { Suspense } from "react";
import { ToolsProvider } from "@/features/agent/tools/context";
import { IdePage } from "@/features/ide/ide-page";

export default function IdeRoutePage() {
  return (
    <ToolsProvider>
      <Suspense fallback={null}>
        <IdePage ideOrigin={process.env.LOCAL_STUDIO_IDE_ORIGIN?.trim() ?? ""} />
      </Suspense>
    </ToolsProvider>
  );
}
