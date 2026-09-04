// Product identity (ADR-034 M9): the one place the name, title, favicon and
// empty-state copy live. Assets are the Production Design Kit exports copied
// into public/tuum by scripts/sync-tuum-assets.sh — never a remote URL.

export const TUUM = {
  name: "Tuum",
  /** The local runtime, as the status line and attribution name it. */
  provider: "Tuum Core",
  title: "Tuum",
  description: "Local-first Agentic Development",
  themeColor: "#0d1117",
  favicon: "/tuum/brand/tuum-symbol.svg",
  assets: "/tuum",
  copy: {
    noContext: "No reliable additional context found",
    localUnavailable: "Local services unavailable",
    sessionComplete: "Session complete",
  },
} as const;

export type TuumStudioTheme = "Tuum Dark" | "Tuum Light" | "Tuum High Contrast";

const LIGHT_THEME_IDS = new Set(["tuum-light", "zai-light", "nordic-light", "paper"]);

/** Local Studio theme id → the Tuum Studio theme the embedded workbench should show. */
export function tuumStudioTheme(themeId: string): TuumStudioTheme {
  if (themeId === "tuum-hc") return "Tuum High Contrast";
  return LIGHT_THEME_IDS.has(themeId) ? "Tuum Light" : "Tuum Dark";
}
