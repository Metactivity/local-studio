import { Suspense } from "react";
import { IdePage } from "@/features/ide/ide-page";

export default function IdeRoutePage() {
  return (
    <Suspense fallback={null}>
      <IdePage ideOrigin={process.env.LOCAL_STUDIO_IDE_ORIGIN?.trim() ?? ""} />
    </Suspense>
  );
}
