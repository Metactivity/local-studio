import type { ReactNode } from "react";
import { cx } from "@/ui/utils";

export function AcePanelNotice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error";
  children: ReactNode;
}) {
  return (
    <p
      className={cx(
        "mt-3 text-[length:var(--fs-sm)] leading-5 [overflow-wrap:anywhere]",
        tone === "error" ? "text-(--err)" : "text-(--dim)",
      )}
    >
      {children}
    </p>
  );
}
