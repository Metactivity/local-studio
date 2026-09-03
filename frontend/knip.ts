const config = {
  entry: [
    "src/app/**/{page,layout,route,error,global-error,loading,not-found,template,default}.{ts,tsx}",
    "desktop/main.ts",
    "desktop/preload.ts",
    "desktop/app-identity.ts",
  ],
  project: ["src/**/*.{ts,tsx}", "desktop/**/*.{ts,tsx}"],
  ignore: [".next/**", ".next-dev/**", "node_modules/**"],
  ignoreIssues: {
    "desktop/interfaces.ts": ["types"],
  },
  ignoreDependencies: [
    // Not imported by frontend code since the pi extensions left: kept because
    // desktop/automation/standalone.mjs copies and asserts them in the packaged
    // standalone and the bootstrap route reports the SDK version.
    "@earendil-works/pi-coding-agent",
    "typebox",
    "tailwindcss",
    "postcss",
    "@local-studio/contracts",
    "@local-studio/agent-runtime",
    "@hono/node-server",
    "@modelcontextprotocol/sdk",
    "@lydell/node-pty",
    "playwright-core",
    "chromium-bidi",
    "proper-lockfile",
    "semver",
    "@types/proper-lockfile",
    "@types/semver",
  ],
  ignoreExportsUsedInFile: true,
};

export default config;
