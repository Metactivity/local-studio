export type ThemeId =
  | "tuum-dark"
  | "tuum-light"
  | "tuum-hc"
  | "zai-light"
  | "zai-dark"
  | "chatgpt-dark"
  | "zai-sky"
  | "zai-violet"
  | "zai-emerald"
  | "zai-rose"
  | "absolutely-dark"
  | "raycast-dark"
  | "cursor-dark"
  | "midnight"
  | "slate"
  | "graphite"
  | "espresso"
  | "forest"
  | "nordic-light"
  | "solarized-dark"
  | "paper";

export type FontFamilyId = "openai" | "geist" | "system" | "avenir" | "serif" | "mono" | "rounded";

export interface ThemeTokens {
  bg: string;
  fg: string;
  dim: string;
  border: string;
  surface: string;
  accent: string;
  hl1: string;
  hl2: string;
  hl3: string;
  err: string;
}

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  description: string;
  group: string;
  swatches: [string, string, string, string];
  tokens: ThemeTokens;
  fontFamilyId: FontFamilyId;
  ui?: Partial<ThemeUiTokens>;
}

export interface ThemeUiTokens {
  "surface-2": string;
  "surface-3": string;
  rail: string;
  border: string;
  separator: string;
  hover: string;
  active: string;
  composer: string;
  "composer-footer": string;
  bubble: string;
}

const THEME_FONT_FAMILY_BY_ID: Partial<Record<ThemeId, FontFamilyId>> = {
  // The kit specifies Inter; the app ships no font files, so the system stack
  // (Inter-class on every desktop) is the closest bundled equivalent.
  "tuum-dark": "system",
  "tuum-light": "system",
  "tuum-hc": "system",
  "chatgpt-dark": "openai",
  "absolutely-dark": "system",
  "raycast-dark": "system",
  "cursor-dark": "system",
  midnight: "avenir",
  slate: "system",
  espresso: "serif",
  forest: "rounded",
  "nordic-light": "avenir",
  "solarized-dark": "system",
  paper: "serif",
};

const createTheme = (
  id: ThemeId,
  name: string,
  description: string,
  group: string,
  tokens: ThemeTokens,
): ThemeMeta => ({
  id,
  name,
  description,
  group,
  swatches: [tokens.bg, tokens.surface, tokens.accent, tokens.fg],
  tokens,
  fontFamilyId: THEME_FONT_FAMILY_BY_ID[id] ?? "geist",
});

// Canonical surfaces, expressed as concrete values (the bootstrap script
// writes them inline before paint). These mirror the `.theme-zai-*` blocks in
// tokens.css exactly.
const ZAI_LIGHT: ThemeTokens = {
  bg: "#ffffff",
  fg: "#1a1c1f",
  dim: "#5f6165",
  border: "#1a1c1f14",
  surface: "#ffffff",
  accent: "#0d0d0d",
  hl1: "#5f6165",
  hl2: "#8c8e91",
  hl3: "#8f8f8f",
  err: "#e02e2a",
};

const ZAI_DARK: ThemeTokens = {
  bg: "#181818",
  fg: "#ffffff",
  dim: "#ffffffb3",
  border: "#ffffff14",
  surface: "#212121",
  accent: "#ffffff",
  hl1: "#ffffffb3",
  hl2: "#ffffff80",
  hl3: "#8f8f8f",
  err: "#ff6764",
};

const CHATGPT_DARK: ThemeTokens = {
  bg: "#191919",
  fg: "#d9d9d8",
  dim: "#a0a09f",
  border: "#ffffff0d",
  surface: "#202020",
  accent: "#d9d9d8",
  hl1: "#a0a09f",
  hl2: "#7b7b7b",
  hl3: "#626262",
  err: "#ff6764",
};

const CHATGPT_DARK_UI: Partial<ThemeUiTokens> = {
  "surface-2": "#202020",
  "surface-3": "#282828",
  rail: "#212121",
  border: "#ffffff0d",
  separator: "#ffffff08",
  hover: "#282828",
  active: "#2e2e2e",
  composer: "#282828",
  "composer-footer": "#282828",
  bubble: "#232323",
};

// Accent variants keep the canonical dark surfaces; only the brand
// accent + hl1 (the data/links color) shift.
const skyAccent = (base: ThemeTokens): ThemeTokens => ({
  ...base,
  accent: "#339cff",
});

const violetAccent = (base: ThemeTokens): ThemeTokens => ({
  ...base,
  accent: "#ad7bf9",
});

const emeraldAccent = (base: ThemeTokens): ThemeTokens => ({
  ...base,
  accent: "#40c977",
});

const roseAccent = (base: ThemeTokens): ThemeTokens => ({
  ...base,
  accent: "#ff6764",
});

// Derive the supporting tokens from a bg/fg/surface/accent quartet so new
// themes stay consistent with the workbench ratios.
const darkTheme = (bg: string, fg: string, surface: string, accent: string): ThemeTokens => ({
  bg,
  fg,
  dim: `${fg}b3`,
  border: `${fg}14`,
  surface,
  accent,
  hl1: `${fg}b3`,
  hl2: `${fg}80`,
  hl3: "#8f8f8f",
  err: "#ff6764",
});

const lightTheme = (bg: string, fg: string, surface: string, accent: string): ThemeTokens => ({
  bg,
  fg,
  dim: `${fg}b3`,
  border: `${fg}1f`,
  surface,
  accent,
  hl1: `${fg}b3`,
  hl2: `${fg}80`,
  hl3: "#8f8f8f",
  err: "#e02e2a",
});

// Tuum Production Design Kit semantics (Figma AahVHwpjlIx6UpHyklf8Gw, page 01B)
// mapped onto the surface quartet: canvas / raised / border / text / accent.
// `ui` pins the kit's selected + hover surfaces instead of the derived overlays.
const TUUM_DARK: ThemeTokens = {
  bg: "#0d1117",
  fg: "#f6f7f8",
  dim: "#a1a7ae",
  border: "#2a323b",
  surface: "#171c22",
  accent: "#1da7b8",
  hl1: "#a1a7ae",
  hl2: "#a1a7ae99",
  hl3: "#5f6872",
  err: "#e5534b",
};

const TUUM_DARK_UI: Partial<ThemeUiTokens> = {
  "surface-2": "#ffffff14",
  "surface-3": "#ffffff0a",
  rail: "#171c22",
  border: "#2a323b",
  separator: "#2a323b80",
  hover: "#ffffff0f",
  active: "#0e2b30",
  composer: "#171c22",
  "composer-footer": "#171c22",
  bubble: "#171c22",
};

const TUUM_LIGHT: ThemeTokens = {
  bg: "#f6f7f8",
  fg: "#0d1117",
  dim: "#5f6872",
  border: "#d7dce1",
  surface: "#ffffff",
  accent: "#087c8a",
  hl1: "#5f6872",
  hl2: "#5f687299",
  hl3: "#8a929b",
  err: "#c93d36",
};

const TUUM_LIGHT_UI: Partial<ThemeUiTokens> = {
  "surface-2": "#0d111714",
  "surface-3": "#0d11170a",
  rail: "#ffffff",
  border: "#d7dce1",
  separator: "#d7dce180",
  hover: "#0d11170d",
  active: "#dff0f2",
  composer: "#ffffff",
  "composer-footer": "#ffffff",
  bubble: "#ffffff",
};

// High contrast: pure black canvas, opaque borders, no translucent overlays.
const TUUM_HC: ThemeTokens = {
  bg: "#000000",
  fg: "#ffffff",
  dim: "#d0d4d8",
  border: "#a1a7ae",
  surface: "#0d1117",
  accent: "#1da7b8",
  hl1: "#d0d4d8",
  hl2: "#a1a7ae",
  hl3: "#a1a7ae",
  err: "#ff6b63",
};

const TUUM_HC_UI: Partial<ThemeUiTokens> = {
  "surface-2": "#171c22",
  "surface-3": "#0d1117",
  rail: "#0d1117",
  border: "#a1a7ae",
  separator: "#5f6872",
  hover: "#1e242b",
  active: "#0e2b30",
  composer: "#0d1117",
  "composer-footer": "#0d1117",
  bubble: "#0d1117",
};

export const THEMES: ThemeMeta[] = [
  {
    ...createTheme(
      "tuum-dark",
      "Tuum Dark",
      "Graphite canvas, raised panels, Mineral Teal accent",
      "Tuum",
      TUUM_DARK,
    ),
    ui: TUUM_DARK_UI,
  },
  {
    ...createTheme(
      "tuum-light",
      "Tuum Light",
      "Off-white canvas, white panels, deep teal accent",
      "Tuum",
      TUUM_LIGHT,
    ),
    ui: TUUM_LIGHT_UI,
  },
  {
    ...createTheme(
      "tuum-hc",
      "Tuum High Contrast",
      "Black canvas, opaque borders, Mineral Teal accent",
      "Tuum",
      TUUM_HC,
    ),
    ui: TUUM_HC_UI,
  },
  createTheme(
    "zai-dark",
    "Studio Dark",
    "Unified charcoal canvas, hairline borders, one blue accent",
    "Studio",
    ZAI_DARK,
  ),
  createTheme(
    "zai-light",
    "Studio Light",
    "Pure white canvas, near-black brand, one blue accent",
    "Studio",
    ZAI_LIGHT,
  ),
  {
    ...createTheme(
      "chatgpt-dark",
      "ChatGPT Dark",
      "ChatGPT app charcoal surfaces paired with OpenAI Sans",
      "Reference",
      CHATGPT_DARK,
    ),
    ui: CHATGPT_DARK_UI,
  },
  createTheme(
    "zai-sky",
    "Sky",
    "Dark with a sky-blue brand accent",
    "Accents",
    skyAccent(ZAI_DARK),
  ),
  createTheme(
    "zai-violet",
    "Violet",
    "Dark with a violet brand accent",
    "Accents",
    violetAccent(ZAI_DARK),
  ),
  createTheme(
    "zai-emerald",
    "Emerald",
    "Dark with an emerald brand accent",
    "Accents",
    emeraldAccent(ZAI_DARK),
  ),
  createTheme("zai-rose", "Rose", "Dark with a rose brand accent", "Accents", roseAccent(ZAI_DARK)),
  createTheme(
    "absolutely-dark",
    "Absolutely Dark",
    "Warm charcoal with a terracotta accent, ported from Codex",
    "Ported",
    darkTheme("#2d2d2b", "#f9f9f7", "#373735", "#cc7d5e"),
  ),
  createTheme(
    "raycast-dark",
    "Raycast Dark",
    "Near-black launcher tones with an electric blue accent",
    "Ported",
    darkTheme("#141414", "#ffffff", "#1e1e1e", "#4fa3f8"),
  ),
  {
    // Cursor's real Glass palette, extracted from the app bundle
    // (docs/research/cursor/01-cursor-design-tokens.md): #141414 chrome,
    // #181818 canvas, #F0F0F0 text with 74/36 % opacity tiers, steel-blue
    // accent, and its hairline #F0F0F013 borders.
    ...createTheme(
      "cursor-dark",
      "Cursor Dark",
      "Cursor's Glass palette — graphite chrome and a steel-blue accent",
      "Ported",
      {
        bg: "#181818",
        fg: "#F0F0F0",
        dim: "#F0F0F099",
        border: "#F0F0F013",
        surface: "#1f1f1f",
        accent: "#599CE7",
        hl1: "#F0F0F0bd",
        hl2: "#F0F0F05c",
        hl3: "#8f8f8f",
        err: "#E34671",
      },
    ),
    ui: {
      "surface-2": "#1f1f1f",
      "surface-3": "#262626",
      rail: "#141414",
      border: "#F0F0F013",
      separator: "#F0F0F00d",
      hover: "#F0F0F011",
      active: "#F0F0F01e",
      composer: "#1c1c1c",
      "composer-footer": "#1c1c1c",
      bubble: "#202020",
    },
  },
  createTheme(
    "midnight",
    "Midnight",
    "Blue-black canvas with a soft azure accent",
    "Atmosphere",
    darkTheme("#0d1117", "#e6edf3", "#161b22", "#58a6ff"),
  ),
  createTheme(
    "slate",
    "Slate",
    "Cool graphite blues with a periwinkle accent",
    "Atmosphere",
    darkTheme("#12151a", "#e2e8f0", "#1a1f27", "#7aa2f7"),
  ),
  createTheme(
    "graphite",
    "Graphite",
    "Ultra-dark neutral with a pure white accent",
    "Atmosphere",
    darkTheme("#0d0d0d", "#ededed", "#171717", "#ffffff"),
  ),
  createTheme(
    "espresso",
    "Espresso",
    "Roasted browns with a caramel accent",
    "Atmosphere",
    darkTheme("#1a1512", "#f2e9df", "#241d18", "#d9954a"),
  ),
  createTheme(
    "forest",
    "Forest",
    "Deep evergreen with a spring-green accent",
    "Atmosphere",
    darkTheme("#0f1512", "#e8f2ec", "#18211b", "#4fd08a"),
  ),
  createTheme(
    "nordic-light",
    "Nordic Light",
    "Cool daylight neutrals with crisp indigo controls",
    "Studio",
    lightTheme("#f4f6f8", "#20242a", "#ffffff", "#5e6ad2"),
  ),
  createTheme(
    "solarized-dark",
    "Solarized Dark",
    "Low-contrast blue-green surfaces with a cyan accent",
    "Reference",
    darkTheme("#002b36", "#eee8d5", "#073642", "#2aa198"),
  ),
  createTheme(
    "paper",
    "Paper",
    "Warm paper white with a burnt-sienna accent",
    "Studio",
    lightTheme("#faf8f2", "#2a2723", "#ffffff", "#b05f2d"),
  ),
];
