import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import * as readline from "node:readline";
import Database from "better-sqlite3";
import {
  auditFrameworkCoverage,
  buildWorkspaceRegistry,
  collectLedgerSignalCandidates,
  computeStructuralHealthMetrics,
  detectFrameworksFromPackageJson as coreDetectFrameworksFromPackageJson,
  type FrameworkCoverageWarning,
  type RepresentationGraph,
  type StructuralEdge,
} from "@chomp/core";
import { getChompMasterRoot, resolveRepoName } from "./masterContext.js";

// ---------------------------------------------------------------------------
// Zero-Dependency ANSI Terminal Styling (Chomp Brand Yellow: #face1d)
// ---------------------------------------------------------------------------

const isColorEnabled =
  !process.env.NO_COLOR &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === "1");

export const ansi = {
  yellow: (s: string) =>
    isColorEnabled ? `\x1b[38;2;250;206;29m${s}\x1b[0m` : s,
  yellowBold: (s: string) =>
    isColorEnabled ? `\x1b[1m\x1b[38;2;250;206;29m${s}\x1b[0m` : s,
  bold: (s: string) => (isColorEnabled ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isColorEnabled ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (isColorEnabled ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s: string) => (isColorEnabled ? `\x1b[36m${s}\x1b[0m` : s),
  amber: (s: string) => (isColorEnabled ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (isColorEnabled ? `\x1b[31m${s}\x1b[0m` : s),
};

// ---------------------------------------------------------------------------
// Chomp Unicode Logo Mark & Chomping Animation Frames (Authoritative Brand Art)
// ---------------------------------------------------------------------------

/**
 * Primary Chomp logo mark (Open Mouth — 13 lines).
 * Normalized to a 2-space left margin while preserving exact relative geometry.
 */
export const CHOMP_UNICODE_LOGO_LINES: readonly string[] = [
  "             ◿◺",
  "           ◿◸  ◹◺",
  "         ◿◸   ◢◣ ◹◺",
  "       ◿◸   ◢◣ ◥◤ ◿◸",
  "     ◿◸   ◢◣ ◥◤ ◿◸",
  "   ◿◸      ◥◤ ◿◸",
  "  ⬦   ●      ⬦",
  "   ◹◺      ◢◣ ◹◺",
  "     ◹◺   ◥◤ ◢◣ ◹◺",
  "       ◹◺   ◥◤ ◢◣ ◹◺",
  "         ◹◺   ◥◤ ◿◸",
  "           ◹◺  ◿◸",
  "             ◹◸",
];

/**
 * Chomping animation frame (Closed Mouth — 13 lines, padded 3 top / 3 bottom
 * so the eye `●` stays anchored on row index 6).
 */
export const CHOMP_CHOMPING_FRAME_LINES: readonly string[] = [
  "",
  "",
  "",
  "   ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭",
  "  ▯                ▯",
  "  ▯     ██  ██  ██ ▯",
  "  ▯  ●  ～～～～～ ⧼",
  "  ▯     ██  ██  ██ ▯",
  "  ▯                ▯",
  "  ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭",
  "",
  "",
  "",
];

export type ChompLogoFrame = "open" | "chomp";

/**
 * Computes terminal column width, accounting for fullwidth Unicode characters
 * such as `～` (U+FF5E) which occupy 2 columns in monospace terminals.
 */
function visualWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function visualPadEnd(str: string, targetCols: number): string {
  const trimmed = str.trimEnd();
  const w = visualWidth(trimmed);
  return w >= targetCols ? trimmed : trimmed + " ".repeat(targetCols - w);
}

/**
 * Renders the Chomp Unicode logo mark (or chomping frame) in brand yellow
 * alongside the wordmark and tagline.
 */
export function renderChompBanner(
  subtitle?: string,
  frame: ChompLogoFrame = "open",
): string {
  const sideText: Record<number, string> = {
    3: `${ansi.yellowBold("c h o m p")}  ${ansi.dim("v0.1.0")}`,
    5: ansi.bold("Bite-sized software representation."),
    6: ansi.dim(
      subtitle || "Sink your teeth into your codebase's real structure.",
    ),
    8: ansi.dim("Code is ephemeral · The Graph is the truth."),
  };

  const sourceLines =
    frame === "chomp" ? CHOMP_CHOMPING_FRAME_LINES : CHOMP_UNICODE_LOGO_LINES;

  const lines = sourceLines.map((rawLine, idx) => {
    const padded = visualPadEnd(rawLine, 24);
    const coloredLogo = ansi.yellow(padded);
    const right = sideText[idx] ? `   ${sideText[idx]}` : "";
    return `${coloredLogo}${right}`;
  });

  return ["", ...lines, ""].join("\n");
}

export function printChompBanner(
  subtitle?: string,
  frame: ChompLogoFrame = "open",
): void {
  console.log(renderChompBanner(subtitle, frame));
}

/**
 * Plays a live terminal chomping animation that alternates between the open-mouth
 * Chomp logo and the closed-mouth chomping frame in-place, settling on the open-mouth logo.
 * Falls back to printing the static banner once when stdout is not an interactive TTY.
 */
export async function playChompBannerAnimation(
  subtitle?: string,
  options: { cycles?: number; frameMs?: number } = {},
): Promise<void> {
  if (!process.stdout.isTTY || !process.env.NO_COLOR) {
    printChompBanner(subtitle, "open");
    return;
  }

  const cycles = options.cycles ?? 2;
  const frameMs = options.frameMs ?? 190;
  const sequence: ChompLogoFrame[] = ["open"];
  for (let i = 0; i < cycles; i++) {
    sequence.push("chomp", "open");
  }

  const totalLines = CHOMP_UNICODE_LOGO_LINES.length + 2; // leading + 13 art lines + trailing blank line
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  // Hide cursor during animation
  process.stdout.write("\x1b[?25l");
  try {
    for (let step = 0; step < sequence.length; step++) {
      const frame = sequence[step];
      if (step > 0) {
        // Move cursor up to top of banner
        process.stdout.write(`\x1b[${totalLines}A\r`);
      }
      const renderedLines = renderChompBanner(subtitle, frame).split("\n");
      for (const line of renderedLines) {
        process.stdout.write(`\x1b[2K${line}\n`);
      }
      if (step < sequence.length - 1) {
        await sleep(frameMs);
      }
    }
  } finally {
    // Always restore cursor visibility
    process.stdout.write("\x1b[?25h");
  }
}

// ---------------------------------------------------------------------------
// Workspace & Framework Detection + `chomp.config.json` Exclusions
// ---------------------------------------------------------------------------

export interface DetectedWorkspacePackage {
  name: string;
  relPath: string;
  absPath: string;
  frameworks: string[];
  currentlyExcluded: boolean;
}

export function detectFrameworksFromPackageJson(pkgJsonPath: string): string[] {
  return coreDetectFrameworksFromPackageJson(pkgJsonPath);
}

export function loadExcludeWorkspaces(repoRoot: string): string[] {
  const configPath = resolve(repoRoot, "chomp.config.json");
  if (!existsSync(configPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return Array.isArray(parsed.excludeWorkspaces)
      ? parsed.excludeWorkspaces.filter((x: unknown) => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveExcludeWorkspaces(
  repoRoot: string,
  excludeWorkspaces: string[],
): void {
  const configPath = resolve(repoRoot, "chomp.config.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      existing = {};
    }
  }
  const updated = {
    ...existing,
    excludeWorkspaces,
  };
  writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
}

const FRONTEND_SCAFFOLD_DEPENDENCIES = new Set([
  "react",
  "react-dom",
  "preact",
  "next",
  "vue",
  "nuxt",
  "svelte",
  "@sveltejs/kit",
  "solid-js",
  "astro",
  "@remix-run/react",
  "react-router",
  "react-router-dom",
  "@angular/core",
  "lit",
  "tailwindcss",
  "styled-components",
  "@emotion/react",
  "@emotion/styled",
  "@stitches/react",
  "@vanilla-extract/css",
  "pixi.js",
]);

export interface ScaffoldDesignSystemResult {
  written: boolean;
  wouldWrite: boolean;
  alreadyConfigured: boolean;
  frontendPackages: string[];
  configRelPath: string | null;
}

/**
 * Scaffolds a starter `designSystem` configuration block when frontend packages are detected.
 * - Normal mode (`stealth: false`): merges `designSystem` into root `chomp.config.json`.
 * - Stealth mode (`stealth: true`): writes `.chomp/plugins/design-system/config.json` so tracked files remain 100% git-clean.
 * Never overwrites an existing `designSystem` configuration in either location.
 */
export function scaffoldDesignSystemConfig(
  repoRoot: string,
  options: {
    stealth?: boolean;
    dryRun?: boolean;
    excludeWorkspaces?: string[];
  } = {},
): ScaffoldDesignSystemResult {
  const stealth = Boolean(options.stealth);
  const dryRun = Boolean(options.dryRun);
  const rootConfigPath = resolve(repoRoot, "chomp.config.json");
  const stealthConfigPath = resolve(
    repoRoot,
    ".chomp",
    "plugins",
    "design-system",
    "config.json",
  );

  let rootParsed: Record<string, unknown> = {};
  if (existsSync(rootConfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(rootConfigPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rootParsed = parsed as Record<string, unknown>;
      }
    } catch {
      rootParsed = {};
    }
  }

  if (rootParsed.designSystem && typeof rootParsed.designSystem === "object") {
    return {
      written: false,
      wouldWrite: false,
      alreadyConfigured: true,
      frontendPackages: [],
      configRelPath: "chomp.config.json",
    };
  }
  if (existsSync(stealthConfigPath)) {
    return {
      written: false,
      wouldWrite: false,
      alreadyConfigured: true,
      frontendPackages: [],
      configRelPath: ".chomp/plugins/design-system/config.json",
    };
  }

  const excludedSet = new Set(
    options.excludeWorkspaces ?? loadExcludeWorkspaces(repoRoot),
  );
  const packages = detectWorkspacePackages(repoRoot).filter(
    (p) =>
      !p.currentlyExcluded &&
      !excludedSet.has(p.name) &&
      !excludedSet.has(p.relPath),
  );

  const frontendPackages: string[] = [];
  for (const pkg of packages) {
    const pkgJsonPath = resolve(pkg.absPath, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const allDeps = [
        ...Object.keys(pkgJson.dependencies ?? {}),
        ...Object.keys(pkgJson.devDependencies ?? {}),
        ...Object.keys(pkgJson.peerDependencies ?? {}),
      ];
      if (allDeps.some((d) => FRONTEND_SCAFFOLD_DEPENDENCIES.has(d))) {
        frontendPackages.push(pkg.name || pkg.relPath);
      }
    } catch {
      // Ignore unreadable package.json
    }
  }

  if (frontendPackages.length === 0) {
    return {
      written: false,
      wouldWrite: false,
      alreadyConfigured: false,
      frontendPackages: [],
      configRelPath: null,
    };
  }

  const designSystemBlock = {
    mode: "auto",
    scope: {
      packages: frontendPackages,
    },
    tokens: {
      sources: [] as string[],
    },
    baseline: {
      path: ".chomp/design-system-baseline.json",
    },
  };

  const configRelPath = stealth
    ? ".chomp/plugins/design-system/config.json"
    : "chomp.config.json";

  if (dryRun) {
    return {
      written: false,
      wouldWrite: true,
      alreadyConfigured: false,
      frontendPackages,
      configRelPath,
    };
  }

  if (stealth) {
    mkdirSync(dirname(stealthConfigPath), { recursive: true });
    writeFileSync(
      stealthConfigPath,
      JSON.stringify(designSystemBlock, null, 2) + "\n",
      "utf8",
    );
  } else {
    const updated = {
      ...rootParsed,
      designSystem: designSystemBlock,
    };
    writeFileSync(
      rootConfigPath,
      JSON.stringify(updated, null, 2) + "\n",
      "utf8",
    );
  }

  return {
    written: true,
    wouldWrite: false,
    alreadyConfigured: false,
    frontendPackages,
    configRelPath,
  };
}

export function detectWorkspacePackages(
  repoRoot: string,
): DetectedWorkspacePackage[] {
  const registry = buildWorkspaceRegistry(repoRoot);
  const existingExclusions = new Set(loadExcludeWorkspaces(repoRoot));
  const entries = Object.entries(registry);

  if (entries.length === 0) {
    const rootPkgJson = resolve(repoRoot, "package.json");
    let rootName = resolveRepoName(repoRoot);
    if (existsSync(rootPkgJson)) {
      try {
        const parsed = JSON.parse(readFileSync(rootPkgJson, "utf8"));
        if (parsed.name) rootName = parsed.name;
      } catch {
        // ignore
      }
    }
    return [
      {
        name: rootName,
        relPath: ".",
        absPath: repoRoot,
        frameworks: detectFrameworksFromPackageJson(rootPkgJson),
        currentlyExcluded: false,
      },
    ];
  }

  return entries
    .map(([name, absPath]) => {
      const relPath = relative(repoRoot, absPath).replace(/\\/g, "/") || ".";
      const shortName = name.replace(/^@[^/]+\//, "");
      const frameworks = detectFrameworksFromPackageJson(
        resolve(absPath, "package.json"),
      );
      const currentlyExcluded =
        existingExclusions.has(name) ||
        existingExclusions.has(relPath) ||
        existingExclusions.has(shortName);
      return {
        name,
        relPath,
        absPath,
        frameworks,
        currentlyExcluded,
      };
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ---------------------------------------------------------------------------
// Structural Bite Report (Replaces 4,000-row console.table dump by default)
// ---------------------------------------------------------------------------

export interface BiteReportOptions {
  repoName: string;
  repoId: string;
  dbPath: string;
  repoPath?: string;
  excludeWorkspaces?: string[];
  commitSha?: string;
  branchName?: string;
  durationMs?: number;
  graph: RepresentationGraph;
}

export function printFrameworkWarnings(
  warnings: readonly FrameworkCoverageWarning[],
): void {
  if (warnings.length === 0) return;
  console.log(
    `  ${ansi.amber("▲")} ${ansi.bold("Framework & Convention Accuracy Warnings")}`,
  );
  for (const w of warnings) {
    console.log(`    ${ansi.amber("•")} ${ansi.dim(`[${w.kind}]`)} ${w.message}`);
  }
  console.log("");
}

function readRegisteredLedgerShapeKeys(): Set<string> {
  const keys = new Set<string>();
  try {
    const ledgerPath = resolve(
      getChompMasterRoot(),
      "fixtures/research/pattern_ledger.db",
    );
    if (!existsSync(ledgerPath)) return keys;
    const db = new Database(ledgerPath, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT shape_key FROM pattern_ledger WHERE shape_key IS NOT NULL")
        .all() as Array<{ shape_key: string | null }>;
      for (const r of rows) {
        if (r.shape_key) keys.add(r.shape_key);
      }
    } finally {
      db.close();
    }
  } catch {
    // Non-fatal if pattern_ledger.db does not exist or cannot be read
  }
  return keys;
}

/**
 * Surfaces a concise CLI hint when extraction detects unregistered knowable shape clusters
 * that are not yet tracked in `fixtures/research/pattern_ledger.db`.
 */
export function printUnregisteredShapeHint(
  graph: RepresentationGraph,
  repoName: string,
  darkFiles: readonly string[] = [],
): void {
  const registeredShapeKeys = readRegisteredLedgerShapeKeys();
  const candidates = collectLedgerSignalCandidates(graph, {
    registeredShapeKeys,
    onlyKnowable: true,
    onlyActionableOrphans: true,
    darkFiles,
  });
  if (candidates.length === 0) return;

  const totalUnresolved = candidates.reduce((sum, c) => sum + c.unresolved, 0);
  const topPreview = candidates
    .slice(0, 3)
    .map((c) => `${c.shapeKey} (${c.unresolved})`)
    .join(", ");
  console.log(
    `  ${ansi.amber("◆")} ${ansi.bold(`${candidates.length} unregistered knowable shape cluster${candidates.length === 1 ? "" : "s"} found`)} ${ansi.dim(`(${totalUnresolved} unresolved: ${topPreview}${candidates.length > 3 ? `, +${candidates.length - 3} more` : ""})`)}`,
  );
  console.log(
    `    ${ansi.dim("Run")} ${ansi.cyan(`chomp ledger sync ${repoName}`)} ${ansi.dim("or")} ${ansi.cyan(`pnpm chomp-research ledger pattern measure --repo ${repoName} --ingest`)} ${ansi.dim("to sync into pattern_ledger.db")}\n`,
  );
}

export function computeQuickConnectivity(graph: RepresentationGraph): {
  connectivityRate: number;
  unresolvedCount: number;
} {
  const { connectivityRate, callResolutionCounts } = computeStructuralHealthMetrics(graph);
  const unresolvedCount =
    callResolutionCounts.provableCallCount - callResolutionCounts.resolvedCount;
  return { connectivityRate, unresolvedCount };
}

/**
 * Prints a clear, concise Polaris-style welcome message before workspace detection begins.
 */
export function printWelcomeMessage(repoName: string, isDryRun = false): void {
  console.log(
    `  ${ansi.bold("Welcome to Chomp!")} Let's set up the architecture graph for ${ansi.cyan(repoName)}.`,
  );
  console.log(
    `  ${ansi.dim("We'll scan your packages, set up automatic Git sync, and connect your AI coding agents.")}`,
  );
  if (isDryRun) {
    console.log(
      `  ${ansi.amber("⚡ Sandbox mode")} ${ansi.dim("— previewing setup without changing any files or databases.")}`,
    );
  }
  console.log("");
}

/**
 * Runs a paced, single-line thinking ticker directly underneath the opening Chomp logo
 * so the user has time to take in the brand mark while system discovery runs.
 */
export async function runDiscoveryTicker(
  repoName: string,
  customMessages?: string[],
): Promise<void> {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return;
  }

  const messages = customMessages ?? [
    `Checking package.json and TypeScript config in ${repoName}...`,
    "Detecting workspace packages and frameworks...",
    "Checking Git repository and AI agent settings...",
  ];
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const stepMs = 680;
  const tickMs = 80;
  const ticksPerStep = Math.max(1, Math.round(stepMs / tickMs));
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  process.stdout.write("\x1b[?25l");
  try {
    let spinIdx = 0;
    for (const msg of messages) {
      for (let t = 0; t < ticksPerStep; t++) {
        const frame = spinnerFrames[spinIdx % spinnerFrames.length];
        spinIdx++;
        process.stdout.write(
          `\r\x1b[2K  ${ansi.yellowBold(frame)} ${ansi.dim(msg)}`,
        );
        await sleep(tickMs);
      }
    }
    process.stdout.write("\r\x1b[2K");
  } finally {
    process.stdout.write("\x1b[?25h");
  }
}

function truncateCell(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text.padEnd(maxLen);
  return text.slice(0, Math.max(1, maxLen - 1)) + "…";
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function padAnsiCell(str: string, targetCols: number): string {
  const plainWidth = visualWidth(stripAnsi(str));
  return plainWidth >= targetCols
    ? str
    : str + " ".repeat(targetCols - plainWidth);
}

/**
 * Renders the detected repository & package configuration inside a structured
 * read-only box table so it is visually distinct from interactive wizard prompts.
 */
export function printDetectedWorkspaceTable(
  repoName: string,
  packages: DetectedWorkspacePackage[],
  vaultNotes: string[] = [],
): void {
  const colPkg = 20;
  const colPath = 16;
  const colStack = 40;
  const innerWidth = colPkg + colPath + colStack + 8; // 2 leading + 2 gap + 2 gap + 2 trailing
  const footerContentWidth = innerWidth - 4;

  const titlePlain = ` Workspace Configuration · ${repoName} (${packages.length} package${packages.length === 1 ? "" : "s"}) `;
  const topDashCount = Math.max(2, innerWidth - titlePlain.length - 1);

  console.log(
    `  ${ansi.dim("┌─")}${ansi.bold(titlePlain)}${ansi.dim("─".repeat(topDashCount) + "┐")}`,
  );
  console.log(
    `  ${ansi.dim("│")}  ${ansi.dim("PACKAGE".padEnd(colPkg))}  ${ansi.dim("PATH".padEnd(colPath))}  ${ansi.dim("DETECTED STACK".padEnd(colStack))}  ${ansi.dim("│")}`,
  );
  console.log(`  ${ansi.dim("├" + "─".repeat(innerWidth) + "┤")}`);

  for (const pkg of packages) {
    const rawStack =
      pkg.frameworks.length > 0
        ? pkg.frameworks.join(", ")
        : "TypeScript / JS";
    const stackWithStatus = pkg.currentlyExcluded
      ? `${rawStack} (excluded)`
      : rawStack;

    const c1 = ansi.bold(truncateCell(pkg.name, colPkg));
    const c2 = ansi.dim(truncateCell(pkg.relPath, colPath));
    const c3 = pkg.currentlyExcluded
      ? ansi.amber(truncateCell(stackWithStatus, colStack))
      : pkg.frameworks.length > 0
        ? ansi.cyan(truncateCell(stackWithStatus, colStack))
        : ansi.dim(truncateCell(stackWithStatus, colStack));

    console.log(
      `  ${ansi.dim("│")}  ${c1}  ${c2}  ${c3}  ${ansi.dim("│")}`,
    );
  }

  console.log(`  ${ansi.dim("├" + "─".repeat(innerWidth) + "┤")}`);
  for (const note of vaultNotes) {
    console.log(
      `  ${ansi.dim("│")}  ${padAnsiCell(note, footerContentWidth)}  ${ansi.dim("│")}`,
    );
  }
  const tipText = ansi.dim(
    "ℹ Update package exclusions anytime in chomp.config.json",
  );
  console.log(
    `  ${ansi.dim("│")}  ${padAnsiCell(tipText, footerContentWidth)}  ${ansi.dim("│")}`,
  );
  console.log(`  ${ansi.dim("└" + "─".repeat(innerWidth) + "┘")}`);
}

export interface ChompExtractionAnimationOptions {
  repoName: string;
  repoPath: string;
  dbPath: string;
  commitSha?: string;
  branchName?: string;
  excludeWorkspaces?: string[];
  isSandbox?: boolean;
  executeExtraction: () => Promise<{
    graph: RepresentationGraph;
    durationMs: number;
  }>;
}

function resolvePackageNameForNode(
  nodeId: string,
  nodeById: Map<string, RepresentationGraph["nodes"][number]>,
): string | undefined {
  let cursor = nodeById.get(nodeId);
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (cursor.entityType === "DEPLOYMENT_UNIT") {
      return cursor.name.replace(/^Deployment Unit:\s*/i, "").trim();
    }
    cursor = cursor.parentBoundaryId
      ? nodeById.get(cursor.parentBoundaryId)
      : undefined;
  }
  return undefined;
}

function renderChompFrameWithSideLines(
  frame: ChompLogoFrame,
  sideLines: Record<number, string>,
): string {
  const sourceLines =
    frame === "chomp" ? CHOMP_CHOMPING_FRAME_LINES : CHOMP_UNICODE_LOGO_LINES;
  const lines = sourceLines.map((rawLine, idx) => {
    const padded = visualPadEnd(rawLine, 24);
    const coloredLogo = ansi.yellow(padded);
    const right = sideLines[idx] ? `   ${sideLines[idx]}` : "";
    return `${coloredLogo}${right}`;
  });
  return ["", ...lines, ""].join("\n");
}

function formatAnalysisTimestamp(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

/**
 * Runs the 2-frame Chomp mouth animation continuously during code analysis
 * (guaranteed minimum of 2 full chomp cycles, and more if extraction takes longer)
 * while streaming a live sequence of package & contract discovery events to the right.
 */
export async function runChompExtractionWithAnimation(
  opts: ChompExtractionAnimationOptions,
): Promise<{ graph: RepresentationGraph; durationMs: number }> {
  const {
    repoName,
    repoPath,
    dbPath,
    commitSha,
    branchName,
    excludeWorkspaces = [],
    isSandbox = false,
    executeExtraction,
  } = opts;

  const excludedSet = new Set(excludeWorkspaces);
  const allPackages = detectWorkspacePackages(repoPath);
  const activePackages = allPackages.filter(
    (p) =>
      !excludedSet.has(p.name) &&
      !excludedSet.has(p.relPath) &&
      !excludedSet.has(p.name.replace(/^@[^/]+\//, "")),
  );
  const packagesToDisplay =
    activePackages.length > 0 ? activePackages : allPackages;

  const gitTag = commitSha
    ? `${ansi.cyan(branchName ?? "detached")} ${ansi.dim(`(${commitSha.slice(0, 7)})`)}`
    : ansi.dim("untracked");

  const isTTY = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  const totalLines = CHOMP_UNICODE_LOGO_LINES.length + 2;
  const frameMs = 200;
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  let hasRendered = false;

  const drawFrame = (
    frame: ChompLogoFrame,
    sideLines: Record<number, string>,
  ) => {
    if (!isTTY) return;
    if (hasRendered) {
      process.stdout.write(`\x1b[${totalLines}A\r`);
    }
    const rendered = renderChompFrameWithSideLines(frame, sideLines).split("\n");
    for (const line of rendered) {
      process.stdout.write(`\x1b[2K${line}\n`);
    }
    hasRendered = true;
  };

  if (isTTY) {
    process.stdout.write("\x1b[?25l");
  }

  try {
    let worker: Worker | null = null;
    const animStartMs = Date.now();

    if (isTTY) {
      const firstPkg = packagesToDisplay[0]?.name ?? repoName;
      drawFrame("open", {
        0: `${ansi.yellowBold("◆")} ${ansi.bold(`Chomping ${repoName}...`)}${isSandbox ? ansi.dim(" [sandbox in-memory]") : ""}`,
        1: `${ansi.dim("Branch chomped:")} ${gitTag}`,
        2: ansi.dim("──────────────────────────────────────────────────────────────"),
        3: `${ansi.yellowBold("▸")} Analyzing ${ansi.bold(firstPkg)}...`,
      });

      // Pre-render live chomping frames for a background Worker thread using direct
      // OS file descriptor 1 writes (`fs.writeSync(1, ...)`) so the mouth chomps
      // continuously at 5fps even while the main thread is busy parsing ASTs.
      const maxVisible =
        packagesToDisplay.length <= 5 ? packagesToDisplay.length : 4;
      const visiblePkgs = packagesToDisplay.slice(0, maxVisible);
      const workerFrames: string[] = [];
      let nextLogoFrame: ChompLogoFrame = "chomp";

      const totalSteps = Math.max(4, visiblePkgs.length * 2);
      for (let step = 0; step < totalSteps; step++) {
        const pkgIdx = Math.min(
          visiblePkgs.length - 1,
          Math.floor(step / 2),
        );
        const side: Record<number, string> = {
          0: `${ansi.yellowBold("◆")} ${ansi.bold(`Chomping ${repoName}...`)}${isSandbox ? ansi.dim(" [sandbox in-memory]") : ""}`,
          1: `${ansi.dim("Branch chomped:")} ${gitTag}`,
          2: ansi.dim("──────────────────────────────────────────────────────────────"),
        };
        for (let j = 0; j < pkgIdx; j++) {
          const p = visiblePkgs[j];
          const fw =
            p.frameworks.length > 0
              ? ansi.dim(` [${p.frameworks.slice(0, 2).join(", ")}]`)
              : "";
          side[3 + j] = `${ansi.green("✓")} Scanned ${ansi.bold(p.name)}${fw}`;
        }
        const activePkg = visiblePkgs[pkgIdx];
        if (activePkg) {
          const fw =
            activePkg.frameworks.length > 0
              ? ansi.dim(` [${activePkg.frameworks.slice(0, 2).join(", ")}]`)
              : "";
          side[3 + pkgIdx] =
            `${ansi.yellowBold("▸")} Analyzing ${ansi.bold(activePkg.name)}${fw} — extracting AST contracts...`;
        }
        const renderedLines = renderChompFrameWithSideLines(
          nextLogoFrame,
          side,
        ).split("\n");
        const payload =
          `\x1b[${totalLines}A\r` +
          renderedLines.map((l) => `\x1b[2K${l}\n`).join("");
        workerFrames.push(payload);
        nextLogoFrame = nextLogoFrame === "open" ? "chomp" : "open";
      }

      try {
        worker = new Worker(
          `
          const fs = require("node:fs");
          const { workerData } = require("node:worker_threads");
          const { frames, intervalMs } = workerData;
          let i = 0;
          setInterval(() => {
            try {
              fs.writeSync(1, frames[i % frames.length]);
              i++;
            } catch {}
          }, intervalMs);
          `,
          {
            eval: true,
            workerData: { frames: workerFrames, intervalMs: frameMs },
          },
        );
      } catch {
        worker = null;
      }
    }

    let graph: RepresentationGraph;
    let durationMs: number;
    try {
      const res = await executeExtraction();
      graph = res.graph;
      durationMs = res.durationMs;
    } finally {
      if (worker) {
        try {
          await worker.terminate();
        } catch {
          // ignore
        }
      }
    }

    // Compute real per-package and overall metrics from the extracted graph
    const userNodes = graph.nodes.filter((n) => (n.scope ?? "USER") === "USER");
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const contracts = userNodes.filter((n) => n.type === "CONTRACT");
    const routesAndTools = contracts.filter((c) =>
      [
        "HTTP_ENDPOINT",
        "NEXTJS_PAGE",
        "NEXTJS_LAYOUT",
        "MCP_TOOL",
        "CLI_COMMAND",
        "GRAPHQL_RESOLVER",
        "EVENT_LISTENER",
      ].includes(c.entityType ?? ""),
    );
    const classes = userNodes.filter((n) => n.entityType === "CLASS");
    const openConnectors = userNodes.filter((n) => n.type === "OPEN_CONNECTOR");
    const { connectivityRate, unresolvedCount } = computeQuickConnectivity(graph);

    const contractsByPkgKey = new Map<string, number>();
    for (const c of contracts) {
      const unitName = resolvePackageNameForNode(c.id, nodeById);
      if (unitName) {
        contractsByPkgKey.set(
          unitName,
          (contractsByPkgKey.get(unitName) ?? 0) + 1,
        );
        const shortUnit = unitName.replace(/^@[^/]+\//, "");
        if (shortUnit !== unitName) {
          contractsByPkgKey.set(
            shortUnit,
            (contractsByPkgKey.get(shortUnit) ?? 0) + 1,
          );
        }
      }
    }

    const getPkgContractCount = (pkg: DetectedWorkspacePackage): number => {
      const shortName = pkg.name.replace(/^@[^/]+\//, "");
      const direct =
        contractsByPkgKey.get(pkg.name) ?? contractsByPkgKey.get(shortName);
      if (typeof direct === "number") return direct;
      if (packagesToDisplay.length === 1) return contracts.length;
      return 0;
    };

    const maxVisiblePackages = packagesToDisplay.length <= 5 ? packagesToDisplay.length : 4;
    const visiblePackages = packagesToDisplay.slice(0, maxVisiblePackages);
    const hiddenPackages = packagesToDisplay.slice(maxVisiblePackages);

    const completedPkgLines: string[] = visiblePackages.map((pkg) => {
      const count = getPkgContractCount(pkg);
      const fwHint =
        pkg.frameworks.length > 0
          ? ansi.dim(` [${pkg.frameworks.slice(0, 2).join(", ")}]`)
          : "";
      return `${ansi.green("✓")} Analyzed ${ansi.bold(pkg.name)}${fwHint} ${ansi.dim("—")} ${ansi.yellowBold(String(count))} contracts discovered`;
    });

    if (hiddenPackages.length > 0) {
      const extraContracts = hiddenPackages.reduce(
        (sum, p) => sum + getPkgContractCount(p),
        0,
      );
      completedPkgLines.push(
        `${ansi.green("✓")} Analyzed +${hiddenPackages.length} more package${hiddenPackages.length === 1 ? "" : "s"} ${ansi.dim("—")} ${ansi.yellowBold(String(extraContracts))} contracts discovered`,
      );
    }

    const timeTag = ansi.dim(` in ${(durationMs / 1000).toFixed(2)}s`);
    const healthBadge =
      connectivityRate >= 80
        ? ansi.green(`● ${connectivityRate.toFixed(1)}% PASS`)
        : ansi.amber(`▲ ${connectivityRate.toFixed(1)}% WARN`);
    const shortDb = relative(repoPath, dbPath) || dbPath;
    const analysisTimestamp = formatAnalysisTimestamp();

    if (isTTY) {
      // Ensure a minimum of 2 full chomp cycles (4 frame transitions = ~800ms)
      // plus progressive package-by-package completion reveal
      const elapsedDuringExtract = Date.now() - animStartMs;
      const minTotalAnimMs = frameMs * 4;
      const remainingSteps = Math.max(
        completedPkgLines.length,
        elapsedDuringExtract < minTotalAnimMs ? 4 : completedPkgLines.length,
      );

      let currentFrame: ChompLogoFrame = "chomp";
      for (let step = 0; step < remainingSteps; step++) {
        const revealedCount = Math.min(
          completedPkgLines.length,
          Math.floor(((step + 1) / remainingSteps) * completedPkgLines.length) || 1,
        );
        const frameSide: Record<number, string> = {
          0: `${ansi.yellowBold("◆")} ${ansi.bold(`Chomping ${repoName}...`)}${isSandbox ? ansi.dim(" [sandbox in-memory]") : ""}`,
          1: `${ansi.dim("Branch chomped:")} ${gitTag}`,
          2: ansi.dim("──────────────────────────────────────────────────────────────"),
        };
        for (let j = 0; j < revealedCount; j++) {
          frameSide[3 + j] = completedPkgLines[j];
        }
        if (revealedCount < completedPkgLines.length) {
          const nextPkg = visiblePackages[revealedCount]?.name ?? "remaining packages";
          frameSide[3 + revealedCount] = `${ansi.yellowBold("▸")} Analyzing ${ansi.bold(nextPkg)}...`;
        } else {
          frameSide[3 + revealedCount] = `${ansi.yellowBold("▸")} Wiring ${graph.edges.length.toLocaleString()} structural relationships...`;
        }
        drawFrame(currentFrame, frameSide);
        currentFrame = currentFrame === "open" ? "chomp" : "open";
        await sleep(frameMs);
      }
    }

    // Final settled frame ("open") with Branch chomped at top, package results, and Local chomp storage + timestamp at bottom
    const finalSide: Record<number, string> = {
      0: `${ansi.green("✓")} ${ansi.bold(`Chomped ${repoName}`)}${timeTag}`,
      1: `${ansi.dim("Branch chomped:")} ${gitTag}`,
      2: ansi.dim("──────────────────────────────────────────────────────────────"),
    };
    let rowCursor = 3;
    for (const line of completedPkgLines) {
      finalSide[rowCursor++] = line;
    }
    finalSide[rowCursor++] = ansi.dim(
      "──────────────────────────────────────────────────────────────",
    );
    finalSide[rowCursor++] =
      `${ansi.yellowBold("◆")} ${ansi.bold(String(contracts.length))} contracts ${ansi.dim(`(${routesAndTools.length} entrypoints · ${classes.length} classes · ${openConnectors.length} connectors)`)}`;
    finalSide[rowCursor++] =
      `${ansi.yellowBold("◆")} ${ansi.bold(graph.edges.length.toLocaleString())} relationships wired  ·  Connectivity: ${healthBadge}${unresolvedCount > 0 ? ansi.dim(` (${unresolvedCount} unresolved)`) : ""}`;
    finalSide[rowCursor++] =
      `${ansi.dim("Local chomp storage:")} ${ansi.cyan(shortDb)} ${ansi.dim(`(${analysisTimestamp})`)}`;

    if (isTTY) {
      drawFrame("open", finalSide);
    } else {
      console.log(renderChompFrameWithSideLines("open", finalSide));
    }

    const coverage = auditFrameworkCoverage(repoPath, graph, excludeWorkspaces);
    if (coverage.warnings.length > 0) {
      printFrameworkWarnings(coverage.warnings);
    }
    printUnregisteredShapeHint(graph, repoName, coverage.darkFiles);

    return { graph, durationMs };
  } finally {
    if (isTTY) {
      process.stdout.write("\x1b[?25h");
    }
  }
}

export function printBiteReport(opts: BiteReportOptions): void {
  const { repoName, dbPath, commitSha, branchName, durationMs, graph } = opts;

  const userNodes = graph.nodes.filter((n) => (n.scope ?? "USER") === "USER");
  const deploymentUnits = userNodes
    .filter((n) => n.entityType === "DEPLOYMENT_UNIT")
    .map((n) =>
      n.name.replace(/^Deployment Unit:\s*/i, "").trim(),
    );
  const contracts = userNodes.filter((n) => n.type === "CONTRACT");
  const routesAndTools = contracts.filter((c) =>
    [
      "HTTP_ENDPOINT",
      "NEXTJS_PAGE",
      "NEXTJS_LAYOUT",
      "MCP_TOOL",
      "CLI_COMMAND",
      "GRAPHQL_RESOLVER",
      "EVENT_LISTENER",
    ].includes(c.entityType ?? ""),
  );
  const classes = userNodes.filter((n) => n.entityType === "CLASS");
  const openConnectors = userNodes.filter((n) => n.type === "OPEN_CONNECTOR");
  const { connectivityRate, unresolvedCount } = computeQuickConnectivity(graph);

  const timeTag =
    typeof durationMs === "number"
      ? ansi.dim(` in ${(durationMs / 1000).toFixed(2)}s`)
      : "";
  const gitTag = commitSha
    ? `${ansi.cyan(branchName ?? "detached")} ${ansi.dim(`(${commitSha.slice(0, 7)})`)}`
    : ansi.dim("untracked");
  const healthBadge =
    connectivityRate >= 80
      ? ansi.green(`● ${connectivityRate.toFixed(1)}% PASS`)
      : ansi.amber(`▲ ${connectivityRate.toFixed(1)}% WARN`);

  const pkgPreview =
    deploymentUnits.length <= 5
      ? deploymentUnits.join(", ")
      : `${deploymentUnits.slice(0, 5).join(", ")} (+${deploymentUnits.length - 5} more)`;

  const analysisTimestamp = formatAnalysisTimestamp();

  console.log(
    `\n  ${ansi.yellowBold("◆")} ${ansi.bold(`Chomped ${repoName}`)}${timeTag}`,
  );
  console.log(
    `  ${ansi.dim("┌──────────────────────────────────────────────────────────────────┐")}`,
  );
  console.log(
    `  ${ansi.dim("│")}  ${ansi.dim("Branch chomped:")}       ${gitTag}`,
  );
  console.log(
    `  ${ansi.dim("│")}  ${ansi.dim("Packages:")}             ${ansi.bold(String(deploymentUnits.length))} ${ansi.dim(`(${pkgPreview || repoName})`)}`,
  );
  console.log(
    `  ${ansi.dim("│")}  ${ansi.dim("Contracts:")}            ${ansi.bold(String(contracts.length))} ${ansi.dim(`(${routesAndTools.length} entrypoints · ${classes.length} classes · ${openConnectors.length} connectors)`)}`,
  );
  console.log(
    `  ${ansi.dim("│")}  ${ansi.dim("Relationships:")}        ${ansi.bold(String(graph.edges.length))} wired  ·  Connectivity: ${healthBadge}${unresolvedCount > 0 ? ansi.dim(` (${unresolvedCount} unresolved)`) : ""}`,
  );
  console.log(
    `  ${ansi.dim("│")}  ${ansi.dim("Local chomp storage:")}  ${ansi.cyan(dbPath)} ${ansi.dim(`(${analysisTimestamp})`)}`,
  );
  console.log(
    `  ${ansi.dim("└──────────────────────────────────────────────────────────────────┘")}\n`,
  );

  if (opts.repoPath) {
    const coverage = auditFrameworkCoverage(
      opts.repoPath,
      graph,
      opts.excludeWorkspaces ?? [],
    );
    printFrameworkWarnings(coverage.warnings);
    printUnregisteredShapeHint(graph, repoName, coverage.darkFiles);
  } else {
    printUnregisteredShapeHint(graph, repoName);
  }
}

// ---------------------------------------------------------------------------
// Interactive Terminal Prompts (Confirm & Multi-Select with Arrow Keys)
// ---------------------------------------------------------------------------

export async function confirmPrompt(
  question: string,
  defaultYes = true,
  description?: string,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultYes;
  }
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  if (description) {
    console.log(`  ${ansi.yellowBold("?")} ${ansi.bold(question)}`);
    for (const line of description.split("\n")) {
      console.log(`    ${ansi.dim(line)}`);
    }
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptLine = description
    ? `    ${ansi.yellowBold("❯")} ${ansi.dim(hint)} `
    : `  ${ansi.yellowBold("?")} ${ansi.bold(question)} ${ansi.dim(hint)} `;

  return new Promise<boolean>((resolvePromise) => {
    rl.question(
      promptLine,
      (answer) => {
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        if (!trimmed) {
          resolvePromise(defaultYes);
        } else if (trimmed === "y" || trimmed === "yes") {
          resolvePromise(true);
        } else if (trimmed === "n" || trimmed === "no") {
          resolvePromise(false);
        } else {
          resolvePromise(defaultYes);
        }
      },
    );
  });
}

export interface MultiSelectOption<T = string> {
  value: T;
  label: string;
  hint?: string;
  selected: boolean;
}

/**
 * Interactive multi-select checklist in the terminal.
 * Supports Up/Down arrows (or j/k), Space to toggle, 'a' to toggle all, and Enter to confirm.
 * Gracefully falls back to comma-separated numbers if raw mode is unavailable.
 */
export async function multiSelectPrompt<T = string>(
  title: string,
  subtitle: string,
  options: MultiSelectOption<T>[],
): Promise<T[]> {
  if (
    options.length === 0 ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== "function"
  ) {
    return options.filter((o) => o.selected).map((o) => o.value);
  }

  return new Promise<T[]>((resolvePromise) => {
    const items = options.map((o) => ({ ...o }));
    let cursor = 0;
    let renderedLineCount = 0;

    const render = () => {
      if (renderedLineCount > 0) {
        process.stdout.write(`\x1b[${renderedLineCount}A\x1b[J`);
      }
      const lines: string[] = [];
      lines.push(`  ${ansi.yellowBold("?")} ${ansi.bold(title)}`);
      lines.push(`    ${ansi.dim(subtitle)}`);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isCurrent = i === cursor;
        const pointer = isCurrent ? ansi.yellowBold("❯") : " ";
        const check = item.selected
          ? ansi.green("◉")
          : ansi.dim("◯");
        const labelText = isCurrent ? ansi.bold(item.label) : item.label;
        const hintText = item.hint ? `  ${ansi.dim(item.hint)}` : "";
        lines.push(`    ${pointer} ${check} ${labelText}${hintText}`);
      }
      process.stdout.write(lines.join("\n") + "\n");
      renderedLineCount = lines.length;
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString("utf8");

      // Ctrl+C
      if (key === "\u0003") {
        cleanup();
        process.exit(130);
      }

      // Enter
      if (key === "\r" || key === "\n") {
        cleanup();
        resolvePromise(items.filter((i) => i.selected).map((i) => i.value));
        return;
      }

      // Space
      if (key === " ") {
        items[cursor].selected = !items[cursor].selected;
        render();
        return;
      }

      // Toggle all ('a')
      if (key === "a" || key === "A") {
        const allSelected = items.every((i) => i.selected);
        for (const item of items) {
          item.selected = !allSelected;
        }
        render();
        return;
      }

      // Up arrow or 'k'
      if (key === "\u001b[A" || key === "k") {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
        return;
      }

      // Down arrow or 'j'
      if (key === "\u001b[B" || key === "j") {
        cursor = (cursor + 1) % items.length;
        render();
        return;
      }
    };

    process.stdout.write("\x1b[?25l");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}

// ---------------------------------------------------------------------------
// Cross-Platform Browser Opener
// ---------------------------------------------------------------------------

export function openBrowserUrl(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      const child = spawn("open", [url], { stdio: "ignore", detached: true });
      child.unref();
    } else if (platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
    } else {
      const child = spawn("xdg-open", [url], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
    }
  } catch {
    // Non-fatal if browser opener is unavailable
  }
}
