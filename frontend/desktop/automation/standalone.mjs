// The Next standalone lifecycle: clean before build, repair after build,
// assert the result is complete and minimal, and re-assert inside the packaged
// app (afterPack, called by electron-builder).

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { frontendDir, repoRoot, walkUnder } from "./lib.mjs";

const standaloneBase = path.resolve(frontendDir, ".next", "standalone");

const RUNTIME_PREFIXES = [
  "server.js",
  "package.json",
  ".next/",
  "public/",
  "node_modules/",
  "frontend/server.js",
  "frontend/package.json",
  "frontend/.next/",
  "frontend/public/",
  "frontend/node_modules/",
];

function isRuntimeFile(file) {
  const rel = path.relative(standaloneBase, file).replaceAll("\\", "/");
  return RUNTIME_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix));
}

const filesUnder = (directory) => walkUnder(readdirSync, directory, (entry) => entry.isFile());
const symlinksUnder = (directory) =>
  walkUnder(readdirSync, directory, (entry) => entry.isSymbolicLink());

export function prepareNext() {
  rmSync(path.join(frontendDir, ".next"), { recursive: true, force: true });
}

/**
 * Post-`next build` repair: prune every traced file that is a verified copy of
 * a repo source — refusing to prune anything it cannot verify, because deleting
 * an unrecognized file silently would be worse than failing the build.
 */
export function completeStandalone() {
  const standaloneRoots = [path.resolve(standaloneBase, "frontend"), standaloneBase];
  const standaloneRoot = standaloneRoots.find((root) => existsSync(path.resolve(root, "server.js")));
  if (!standaloneRoot) throw Error(`Missing standalone server under: ${standaloneBase}`);

  const isVerifiedCopy = (file, repoRelativePath) => {
    const source = path.resolve(repoRoot, repoRelativePath);
    if (!existsSync(source)) return false;
    const sourceStat = statSync(source);
    const copyStat = statSync(file);
    if (!sourceStat.isFile() || sourceStat.size !== copyStat.size) return false;
    if (!(repoRelativePath === "data" || /(^|\/)data\//.test(repoRelativePath))) return true;
    return readFileSync(source).equals(readFileSync(file));
  };

  const unverified = [];
  let pruned = 0;
  for (const file of filesUnder(standaloneBase)) {
    if (isRuntimeFile(file)) continue;
    const repoRelativePath = path.relative(standaloneBase, file).replaceAll("\\", "/");
    if (!isVerifiedCopy(file, repoRelativePath)) {
      unverified.push(repoRelativePath);
      continue;
    }
    unlinkSync(file);
    pruned += 1;
  }
  if (unverified.length > 0) {
    throw Error(
      `Standalone output contains non-runtime files with no matching repo source; refusing to prune them (move them aside manually if expected):\n${unverified.join("\n")}`,
    );
  }

  const removeEmptyDirectories = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) removeEmptyDirectories(path.resolve(directory, entry.name));
    }
    if (directory !== standaloneBase && readdirSync(directory).length === 0) rmdirSync(directory);
  };
  removeEmptyDirectories(standaloneBase);
  console.log(`  standalone repaired: -${pruned} traced non-runtime files`);
}

/** Verify the standalone tree is complete, self-contained, and minimal. */
export function assertStandalone() {
  const candidates = [
    path.resolve(standaloneBase, "frontend", "server.js"),
    path.resolve(standaloneBase, "server.js"),
  ];
  const runtimeRoots = [path.resolve(standaloneBase, "frontend"), standaloneBase];
  if (!candidates.some((candidate) => existsSync(candidate))) {
    throw Error(`Missing standalone server: ${candidates.join(", ")}`);
  }

  const runtimeRoot = runtimeRoots.find((root) => existsSync(path.resolve(root, "server.js")));
  const unsafeRuntimeLinks = runtimeRoot
    ? symlinksUnder(runtimeRoot).filter((link) => {
        if (path.isAbsolute(readlinkSync(link)) || !existsSync(link)) return true;
        const resolvedLink = path.relative(runtimeRoot, realpathSync(link));
        return (
          resolvedLink === ".." ||
          resolvedLink.startsWith(`..${path.sep}`) ||
          path.isAbsolute(resolvedLink)
        );
      })
    : [];
  if (unsafeRuntimeLinks.length > 0) {
    throw Error(`Unsafe standalone runtime links: ${unsafeRuntimeLinks.join(", ")}`);
  }

  const tracedPackageDirectory = runtimeRoot
    ? path.resolve(runtimeRoot, ".next/node_modules/@earendil-works")
    : undefined;
  const danglingTracedPackages =
    tracedPackageDirectory && existsSync(tracedPackageDirectory)
      ? readdirSync(tracedPackageDirectory)
          .map((entry) => path.resolve(tracedPackageDirectory, entry))
          .filter((entry) => lstatSync(entry).isSymbolicLink() && !existsSync(entry))
      : [];
  if (danglingTracedPackages.length > 0) {
    throw Error(`Dangling traced runtime packages: ${danglingTracedPackages.join(", ")}`);
  }

  const unexpected = filesUnder(standaloneBase).filter((file) => !isRuntimeFile(file));
  if (unexpected.length > 0) {
    throw Error(
      `Standalone build contains non-runtime files:\n${unexpected
        .map((file) => path.relative(standaloneBase, file))
        .join("\n")}`,
    );
  }
  console.log("  standalone server build is minimal");
}

function resolveResourcesDir(appOutDir, productFilename, electronPlatformName) {
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    return path.join(appOutDir, `${productFilename}.app`, "Contents", "Resources");
  }
  return path.join(appOutDir, "resources");
}

/**
 * electron-builder afterPack hook: refuse to ship a bundle that is missing any
 * runtime piece, because electron-builder can log "file source doesn't exist"
 * for extraResources and still exit 0.
 */
export async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const productFilename = packager.appInfo.productFilename;
  const resourcesDir = resolveResourcesDir(appOutDir, productFilename, electronPlatformName);
  const packagedStandaloneBase = path.join(resourcesDir, "app", "frontend", ".next", "standalone");
  const candidates = [
    path.join(packagedStandaloneBase, "frontend", "server.js"),
    path.join(packagedStandaloneBase, "server.js"),
  ];
  const standaloneServer = candidates.find((candidate) => existsSync(candidate));

  const appArchive = path.join(resourcesDir, "app.asar");
  const appArchiveBytes = statSync(appArchive).size;
  if (appArchiveBytes > 5 * 1024 * 1024) {
    throw Error(`Packaged app.asar is unexpectedly large: ${appArchiveBytes} bytes`);
  }
  if (!standaloneServer) {
    throw Error(
      [
        "Packaged app is missing the embedded Next standalone server — refusing to sign/ship a broken bundle.",
        `Looked for: ${candidates.join(" or ")}`,
        `electron-builder failed to copy extraResources from .next/standalone (it can log "file source doesn't exist" yet still exit 0).`,
        "Re-run the build (run `npm run build` first if .next/standalone is absent).",
      ].join("\n  "),
    );
  }

  const agentRuntimeRoot = path.join(resourcesDir, "app", "agent-runtime");
  const agentRuntime = path.join(agentRuntimeRoot, "standalone.mjs");
  const missingAgentRuntimeFile = [
    agentRuntime,
    path.join(agentRuntimeRoot, "node_modules", "playwright-core", "package.json"),
    path.join(agentRuntimeRoot, "node_modules", "chromium-bidi", "package.json"),
    path.join(agentRuntimeRoot, "node_modules", "chromium-bidi", "node_modules", "zod", "package.json"),
    path.join(agentRuntimeRoot, "node_modules", "mitt", "package.json"),
    path.join(agentRuntimeRoot, "node_modules", "devtools-protocol", "package.json"),
    path.join(agentRuntimeRoot, "node_modules", "@silvia-odwyer", "photon-node", "package.json"),
    path.join(agentRuntimeRoot, "node_modules", "undici", "package.json"),
  ].find((file) => !existsSync(file));
  if (missingAgentRuntimeFile) {
    throw Error(`Packaged app is missing an agent runtime dependency: ${missingAgentRuntimeFile}`);
  }

  const desktopRuntimeRoot = path.join(resourcesDir, "desktop-runtime", "node_modules", "@lydell");
  const missingDesktopRuntimeFile = [
    path.join(desktopRuntimeRoot, "node-pty", "package.json"),
    path.join(desktopRuntimeRoot, `node-pty-${process.platform}-${process.arch}`, "package.json"),
  ].find((file) => !existsSync(file));
  if (missingDesktopRuntimeFile) {
    throw Error(`Packaged app is missing a desktop runtime dependency: ${missingDesktopRuntimeFile}`);
  }

  const unwantedRuntimeFile = [packagedStandaloneBase, agentRuntimeRoot].flatMap((directory) =>
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:map|[cm]?ts)$/.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name)),
  )[0];
  if (unwantedRuntimeFile) {
    throw Error(`Packaged app contains a non-runtime source artifact: ${unwantedRuntimeFile}`);
  }

  const agentRuntimeSource = readFileSync(agentRuntime, "utf8");
  if (/["'](?:[A-Za-z]:\\|\/(?:Users|home|root)\/)[^"'\n]*node_modules[\\/]/.test(agentRuntimeSource)) {
    throw Error("Packaged agent runtime contains a build-machine dependency path");
  }

  if (electronPlatformName === "darwin") {
    const helperExecutable = path.join(
      path.dirname(resourcesDir),
      "Frameworks",
      `${productFilename} Helper.app`,
      "Contents",
      "MacOS",
      `${productFilename} Helper`,
    );
    if (!existsSync(helperExecutable)) {
      throw Error(`Packaged app is missing its helper executable: ${helperExecutable}`);
    }
  }

  console.log(
    `  afterPack: embedded frontend and agent runtime present, app.asar ${appArchiveBytes} bytes (${electronPlatformName})`,
  );
}
