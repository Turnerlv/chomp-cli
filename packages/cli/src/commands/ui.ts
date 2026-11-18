import { Command } from "commander";
import express from "express";
import cors from "cors";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, watch } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { createSQLiteStorage } from "@chomp/db";
import {
  applyActivePluginProjections,
  discoverPluginsInDir,
  getChompPlugin,
  getPluginEnvStatus,
  getPluginMcpToolSummaries,
  getPluginStateDirRel,
  isRegisteredStructuralPluginOverlay,
  listChompPlugins,
  loadPluginSettings,
  readPluginLastRun,
  runChompPlugin,
  savePluginSettings,
} from "@chomp/mcp";
import {
  CORE_EXTRACTOR_VERSION,
  analyzeTarget,
  compareGraphs,
} from "@chomp/core";
import type { GraphDelta, RepresentationGraph } from "@chomp/core";

import { validateLayoutPayload } from "../utils/visualLinter.js";
import { computeGraphHealthMetrics } from "../visualizer/healthMetrics.js";
import {
  requestStatelessCloudLayout,
  stripEvidenceSnippetsFromGraph,
} from "../visualizer/cloudLayoutClient.js";
import {
  DEFAULT_CLOUD_API_URL,
  DEFAULT_HOSTED_UI_URL,
  hasLocalMasterLayoutEngine,
  loadLocalMasterLayoutEngine,
  resolveLocalMasterWebDir,
} from "../visualizer/localEngineBridge.js";
import {
  openInLocalEditor,
  readSingleSourceLine,
} from "../visualizer/sourceAccess.js";
import {
  clearDiskLayoutCache,
  computeWorkingTreeFingerprint,
  readDiskLayoutCache,
  writeDiskLayoutCache,
} from "../visualizer/layoutCache.js";
import {
  getRulesFingerprint,
  loadRulesConfig,
  saveRulesConfig,
  type ChompRulesConfig,
} from "../visualizer/rulesConfig.js";
import type {
  DiffSummaryStats,
  EntityOverlayItem,
  LayoutData,
  LayoutEntitlement,
} from "../visualizer/types.js";
import {
  clearChompCredentials,
  decodeJwtPayloadUnsafe,
  loadChompCredentials,
  resolveActiveBearerToken,
  saveChompCredentials,
} from "../utils/credentials.js";
import {
  buildEntityPresentations,
  buildPluginsOverview,
  computePluginFingerprint,
  computeStructureFingerprint,
  failPluginRun,
  finishPluginRun,
  getPluginRun,
  isPluginRunning,
  overlaysForStructureFingerprint,
  rulesReferenceOverlays,
  snapshotPluginRuns,
  splitOverlays,
  startPluginRun,
  type PluginRunMap,
} from "../visualizer/pluginPresentationApi.js";
import {
  ansi,
  loadExcludeWorkspaces,
  openBrowserUrl,
} from "../utils/branding.js";
import { getGitInfo, resolveRepoName } from "../utils/git.js";
import {
  readMasterContext,
  resolveDefaultCliTarget,
  setActiveChompTarget,
} from "../utils/masterContext.js";
import { runAnalyze } from "./analyze.js";
import { runDiffCheck } from "./diff.js";
import { runHealthCheck } from "./health.js";
import {
  hydrateRepositoryPortValves,
  type HydratePortValvesResult,
} from "../ports/portHydrator.js";

// ---------------------------------------------------------------------------
// Topological Unrolling Pipeline Orchestrator
//
// Strategy: Treat layout as a 1D array-sequencing problem, not a 2D physics problem.
//
// Stage 1 — Story Tracer    (pipeline-topo/1-storyTracer.ts)
//   DFS over the entity graph (contracts / classes / INIT_BLOCKs). Each path = one Story array.
//   Operates on the raw v4 RepresentationGraph — files are no longer graph primitives.
//
// Stage 2 — Zip Merge       (pipeline-topo/2-zipMerge.ts)
//   Badge high-frequency utility nodes. Merge shared terminal nodes into Anchors.
//
// Stage 3 — Grid Mapper     (pipeline-topo/3-gridMapper.ts)
//   x = column * COLUMN_WIDTH, y = storyIndex * ROW_HEIGHT. Pure arithmetic.
//
// Stage 4 — Visual Linter   (utils/visualLinter.ts)
//   Unchanged — validates the LayoutData payload.
//
// ─── Session tuning ─────────────────────────────────────────────────────────
// Adjust BADGE_FAN_IN_THRESHOLD in pipeline-topo/types.ts between sessions.
// Document each threshold in .project/story_sessions.md.
//
// ─── Diff mode ([PAT-VIS-24] / [PAT-VIS-22]) ─────────────────────────────────
// When `diffMode === true`, `buildLayout` compares the saved `baseGraph` from
// `.chomp/graph.db` against a live extraction of `repoPath`, merges `REMOVED`
// base nodes/edges into a union graph, and annotates `LayoutNode`, `LayoutEdge`,
// `PackageBounds`, and `MacroPackageEdge` with `diffStatus`.
// ---------------------------------------------------------------------------

function getDirtyRepoPathsForDiff(repoPath: string): Set<string> | null {
  try {
    const out = execSync("git status --porcelain -uall", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dirty = new Set<string>();
    for (const line of out.split("\n")) {
      if (!line) continue;
      const raw = line.slice(3).trim();
      if (!raw) continue;
      if (raw.includes(" -> ")) {
        const [orig, dest] = raw.split(" -> ");
        if (orig) dirty.add(orig.trim().replace(/\\/g, "/"));
        if (dest) dirty.add(dest.trim().replace(/\\/g, "/"));
      } else {
        dirty.add(raw.replace(/\\/g, "/"));
      }
    }
    return dirty;
  } catch {
    return null;
  }
}

function readGitBlobForDiff(
  repoPath: string,
  commitSha: string,
  relPath: string,
  dirtyPaths: Set<string> | null,
): string | null {
  const normRel = relPath.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (dirtyPaths && !dirtyPaths.has(normRel)) {
    const absPath = resolve(repoPath, normRel);
    try {
      return existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
    } catch {
      // Fall back to git show if disk read fails
    }
  }
  try {
    return execSync(`git show ${commitSha}:${normRel}`, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function hasGitCommitForDiff(repoPath: string, commitSha: string | undefined): commitSha is string {
  if (!commitSha || !/^[0-9a-f]{7,40}$/i.test(commitSha.trim())) return false;
  try {
    execSync(`git cat-file -e ${commitSha.trim()}^{commit}`, {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export type LayoutBuildStageId =
  | "extracting_ast"
  | "tracing_stories"
  | "zip_merge"
  | "mapping_grid"
  | "computing_health_diff";

export interface LayoutBuildStageDef {
  id: LayoutBuildStageId;
  step: number;
  total: number;
  label: string;
}

export const LAYOUT_BUILD_STAGES: readonly LayoutBuildStageDef[] = [
  { id: "extracting_ast", step: 1, total: 5, label: "Reading repository structure..." },
  { id: "tracing_stories", step: 2, total: 5, label: "Connecting routes & contracts..." },
  { id: "zip_merge", step: 3, total: 5, label: "Consolidating shared flows..." },
  { id: "mapping_grid", step: 4, total: 5, label: "Arranging architecture board..." },
  { id: "computing_health_diff", step: 5, total: 5, label: "Finalizing health checks..." },
];

export interface LayoutBuildStatusSnapshot {
  connected: true;
  state: "idle" | "building" | "ready" | "error";
  building: boolean;
  repoName: string;
  branchName?: string;
  diffMode: boolean;
  stageId: LayoutBuildStageId | null;
  stageLabel: string;
  step: number;
  totalSteps: number;
  contractCount?: number;
  packageCount?: number;
  startedAt?: number;
  updatedAt: number;
  durationMs?: number;
  error?: string;
}

export interface BuildStatusTracker {
  getSnapshot: () => LayoutBuildStatusSnapshot;
  begin: (meta: {
    repoName: string;
    branchName?: string;
    diffMode: boolean;
    contractCount?: number;
    packageCount?: number;
  }) => void;
  advance: (stage: LayoutBuildStageDef) => void;
  complete: (durationMs: number) => void;
  fail: (errorMessage: string) => void;
  subscribe: (listener: (snap: LayoutBuildStatusSnapshot) => void) => () => void;
}

export function createBuildStatusTracker(initialRepoName = "repository"): BuildStatusTracker {
  let snapshot: LayoutBuildStatusSnapshot = {
    connected: true,
    state: "idle",
    building: false,
    repoName: initialRepoName,
    diffMode: false,
    stageId: null,
    stageLabel: "Idle",
    step: 0,
    totalSteps: LAYOUT_BUILD_STAGES.length,
    updatedAt: Date.now(),
  };
  const listeners = new Set<(snap: LayoutBuildStatusSnapshot) => void>();

  const notify = () => {
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch {
        // Ignore listener errors
      }
    }
  };

  return {
    getSnapshot: () => ({ ...snapshot }),
    begin: ({ repoName, branchName, diffMode, contractCount, packageCount }) => {
      const first = LAYOUT_BUILD_STAGES[0];
      const now = Date.now();
      snapshot = {
        connected: true,
        state: "building",
        building: true,
        repoName,
        ...(branchName ? { branchName } : {}),
        diffMode,
        stageId: first.id,
        stageLabel: first.label,
        step: first.step,
        totalSteps: first.total,
        ...(typeof contractCount === "number" ? { contractCount } : {}),
        ...(typeof packageCount === "number" ? { packageCount } : {}),
        startedAt: now,
        updatedAt: now,
      };
      notify();
    },
    advance: (stage) => {
      snapshot = {
        ...snapshot,
        state: "building",
        building: true,
        stageId: stage.id,
        stageLabel: stage.label,
        step: stage.step,
        totalSteps: stage.total,
        updatedAt: Date.now(),
      };
      notify();
    },
    complete: (durationMs) => {
      snapshot = {
        ...snapshot,
        state: "ready",
        building: false,
        stageId: "computing_health_diff",
        stageLabel: "Ready",
        step: LAYOUT_BUILD_STAGES.length,
        totalSteps: LAYOUT_BUILD_STAGES.length,
        durationMs,
        updatedAt: Date.now(),
      };
      delete snapshot.error;
      notify();
    },
    fail: (errorMessage) => {
      snapshot = {
        ...snapshot,
        state: "error",
        building: false,
        error: errorMessage,
        updatedAt: Date.now(),
      };
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const yieldEventLoop = () =>
  new Promise<void>((resolveYield) => setImmediate(resolveYield));

export async function buildLayout(
  graph: RepresentationGraph,
  repoPath: string | undefined,
  diffMode: boolean,
  repoName = "repository",
  cachedLiveGraph?: RepresentationGraph,
  rulesConfig?: ChompRulesConfig,
  overlays?: EntityOverlayItem[],
  debugMode = false,
  cloudApiUrl?: string,
  onStage?: (stage: LayoutBuildStageDef) => void | Promise<void>,
  remoteMode = false,
): Promise<{ layout: LayoutData; liveGraph?: RepresentationGraph }> {
  const reportStage = async (idx: number) => {
    if (!onStage) return;
    await onStage(LAYOUT_BUILD_STAGES[idx]);
    await yieldEventLoop();
  };

  await reportStage(0);
  const overlayLayers = rulesConfig?.overlayLayers;
  let targetGraph = applyActivePluginProjections(graph, {
    repoPath,
    overlays: overlays ?? [],
    overlayLayers,
  });
  let diffDelta: GraphDelta | undefined;
  let resolvedLiveGraph: RepresentationGraph | undefined = cachedLiveGraph;

  if (diffMode && repoPath && existsSync(repoPath)) {
    if (!resolvedLiveGraph) {
      const excludeWorkspaces = loadExcludeWorkspaces(repoPath);
      const rawLive = analyzeTarget(
        repoPath,
        CORE_EXTRACTOR_VERSION,
        undefined,
        excludeWorkspaces,
      );
      resolvedLiveGraph = {
        ...rawLive,
        nodes: rawLive.nodes.filter(n => (n.scope ?? "USER") === "USER"),
        edges: rawLive.edges.filter(e => (e.scope ?? "USER") === "USER"),
      };
    }

    const dirtyPaths = getDirtyRepoPathsForDiff(repoPath);
    const baseForDiff = hasGitCommitForDiff(repoPath, graph.commitSha)
      ? applyActivePluginProjections(graph, {
          repoPath,
          overlayLayers,
          readRepoFileOverride: (rel) =>
            readGitBlobForDiff(repoPath, graph.commitSha!.trim(), rel, dirtyPaths),
        })
      : graph;

    const projectedLiveGraph = applyActivePluginProjections(resolvedLiveGraph, {
      repoPath,
      overlayLayers,
    });

    diffDelta = compareGraphs(baseForDiff, projectedLiveGraph);

    const removedNodes = Object.values(diffDelta.nodes)
      .filter(entry => entry.status === "REMOVED" && entry.base)
      .map(entry => entry.base!);
    const removedEdges = Object.values(diffDelta.edges)
      .filter(entry => entry.status === "REMOVED" && entry.base)
      .map(entry => entry.base!);

    targetGraph = {
      ...projectedLiveGraph,
      nodes: [...projectedLiveGraph.nodes, ...removedNodes],
      edges: [...projectedLiveGraph.edges, ...removedEdges],
    };
  }

  // Strip raw source code snippets from evidence so only filePath:lineNumber is exposed
  targetGraph = stripEvidenceSnippetsFromGraph(targetGraph);

  const hasLocalMaster = hasLocalMasterLayoutEngine();
  const explicitCloudUrl = (
    cloudApiUrl ??
    process.env.CHOMP_LAYOUT_API_URL ??
    ""
  ).trim();
  const shouldUseRemoteCloud =
    remoteMode || Boolean(explicitCloudUrl) || !hasLocalMaster;

  if (shouldUseRemoteCloud) {
    const targetCloudUrl = explicitCloudUrl || DEFAULT_CLOUD_API_URL;
    try {
      await reportStage(1);
      await reportStage(2);
      await reportStage(3);
      const cloudLayout = await requestStatelessCloudLayout(
        targetGraph,
        repoName,
        diffDelta,
        rulesConfig,
        overlays,
        {
          cloudApiUrl: targetCloudUrl,
          remote: true,
        },
      );
      await reportStage(4);
      return { layout: cloudLayout, liveGraph: resolvedLiveGraph };
    } catch (cloudErr: any) {
      if (!hasLocalMaster || remoteMode) {
        throw cloudErr;
      }
      console.warn(
        `  ${ansi.yellowBold("⚠")} Cloud layout worker (${targetCloudUrl}) unreachable (${cloudErr?.cause?.code || cloudErr?.message || "fetch error"}) — falling back to local master layout pipeline.`,
      );
    }
  }

  const {
    runStoryTracer,
    runZipMerge,
    runGridMapper,
    writeMatrixCsv,
    writeLayoutCsv,
  } = await loadLocalMasterLayoutEngine();

  // Stage 1 — Story Tracer: entity-level DFS over the v4 graph → Story[]
  await reportStage(1);
  const storyGraph = runStoryTracer(targetGraph, diffDelta, rulesConfig, overlays);
  const verbosePipelineLogs = debugMode || process.env.CHOMP_DEBUG_LAYOUT === "1";

  if (verbosePipelineLogs) {
    console.log(
      `  📖  Stories: ${storyGraph.stories.length} | ` +
      `Raw nodes: ${storyGraph.totalRawNodeCount} | ` +
      `Orphans: ${storyGraph.orphanNodes.length}`
    );
  }

  // Stage 2 — Zip Merge: badge utilities, merge shared terminals
  await reportStage(2);
  const mergedGraph = runZipMerge(storyGraph);

  if (verbosePipelineLogs) {
    console.log(
      `  🔗  Anchors: ${mergedGraph.anchorCount} | ` +
      `Badged: ${mergedGraph.badgedCount} | ` +
      `Stories after merge: ${mergedGraph.stories.length}`
    );
  }

  // Debug artefact: sparse matrix AFTER compression (only written when --debug is enabled)
  if (debugMode) {
    writeMatrixCsv(mergedGraph);
  }

  // Stage 3 — Grid Mapper: assign x/y coordinates
  await reportStage(3);
  const layoutData = runGridMapper(mergedGraph, rulesConfig);
  layoutData.repoName = repoName;
  layoutData.entitlement = {
    tier: "master",
    status: "active",
    previewMode: false,
    gatingMode: "early_access",
  };
  if (overlays) {
    layoutData.overlays = overlays;
  }
  layoutData.islandNodes = storyGraph.orphanNodes.map((o, idx) => ({
    ...o,
    role: "ISLAND" as const,
    x: 0,
    y: idx * 36,
    width: 240,
    height: 32,
  }));

  await reportStage(4);
  const { systemHealth, packageHealthByPkg } = computeGraphHealthMetrics(
    targetGraph,
    repoName,
    storyGraph.orphanNodes,
    layoutData,
    overlays,
  );
  layoutData.healthSummary = systemHealth;
  if (layoutData.packageBounds) {
    for (const [pkg, bounds] of Object.entries(layoutData.packageBounds)) {
      if (packageHealthByPkg[pkg]) {
        bounds.health = packageHealthByPkg[pkg];
      }
    }
  }
  if (diffDelta) {
    const renderedNodes = layoutData.nodes.filter(n => !n.isPackage);
    layoutData.diffSummary = {
      baseCommitSha: diffDelta.baseCommitSha,
      addedNodes: renderedNodes.filter(n => n.diffStatus === "ADDED").length,
      modifiedNodes: renderedNodes.filter(n => n.diffStatus === "MODIFIED").length,
      removedNodes: renderedNodes.filter(n => n.diffStatus === "REMOVED").length,
      addedEdges: layoutData.edges.filter(e => e.diffStatus === "ADDED").length,
      modifiedEdges: layoutData.edges.filter(e => e.diffStatus === "MODIFIED").length,
      removedEdges: layoutData.edges.filter(e => e.diffStatus === "REMOVED").length,
    };
  }

  // Debug artefact: 2D matrix of the final canvas layout (only written when --debug is enabled)
  if (debugMode) {
    writeLayoutCsv(layoutData);
  }

  // Stage 4 — Visual Rules Ledger validation
  const lintIssues = validateLayoutPayload(layoutData);
  const fatalErrors = lintIssues.filter(msg => !msg.includes("[PAT-VIS-07]"));
  const warnings = lintIssues.filter(msg => msg.includes("[PAT-VIS-07]"));
  if (warnings.length > 0 && verbosePipelineLogs) {
    console.warn("  ⚠️  Visual Linter Warnings:", warnings);
  }
  if (fatalErrors.length > 0) {
    console.error("Visual Linter Failed:", fatalErrors);
    throw Object.assign(
      new Error("Layout generation failed rules ledger"),
      { lintErrors: fatalErrors }
    );
  }

  return { layout: layoutData, liveGraph: resolvedLiveGraph };
}


// ---------------------------------------------------------------------------
// Server Runner & Command Registration
// ---------------------------------------------------------------------------

export interface StartUiServerOptions {
  port?: string | number;
  host?: string;
  db?: string;
  open?: boolean;
  watch?: boolean;
  debug?: boolean;
  cloudUrl?: string;
  hostedUi?: string | boolean;
  remote?: boolean;
}

const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const HOSTED_CHOMP_ORIGIN_RE =
  /^https:\/\/(?:(?:[a-z0-9-]+\.)*getchomp\.dev|(?:[a-z0-9-]+\.)*chomp-visualizer\.pages\.dev)$/i;

/**
 * Validates that the HTTP `Host` header targets a loopback interface (`localhost`, `127.0.0.1`, `[::1]`),
 * blocking DNS rebinding attacks against the local Visualizer server.
 */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader || typeof hostHeader !== "string") return false;
  return LOOPBACK_HOST_RE.test(hostHeader.trim());
}

/**
 * Validates that the HTTP `Origin` header (when present) originates from a local loopback port
 * (`http://localhost:3000`, `http://127.0.0.1:5555`, etc.) or the official hosted Cloudflare Visualizer
 * (`https://app.getchomp.dev`), blocking cross-origin requests from arbitrary external websites.
 */
export function isAllowedLocalhostOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  const trimmed = originHeader.trim();
  return LOCALHOST_ORIGIN_RE.test(trimmed) || HOSTED_CHOMP_ORIGIN_RE.test(trimmed);
}

export async function startUiServer(
  targetPath: string,
  options: StartUiServerOptions = {},
): Promise<void> {
  const port =
    typeof options.port === "number"
      ? options.port
      : parseInt(options.port ?? "5555", 10);
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const resolvedTarget = resolve(baseDir, targetPath);

  const repoName = resolveRepoName(resolvedTarget);

  const defaultDbDir = resolve(resolvedTarget, ".chomp");
  const dbPath = options.db
    ? resolve(baseDir, options.db)
    : resolve(defaultDbDir, "graph.db");

  // Self-healing: if .chomp/graph.db does not exist yet, run initial extraction automatically ([PAT-CLI-13])
  if (!existsSync(dbPath)) {
    console.log(
      `\n  ${ansi.yellowBold("◆")} No graph found at ${ansi.cyan(dbPath)} — running initial extraction...`,
    );
    await runAnalyze(resolvedTarget, { db: options.db });
  } else if (!options.db) {
    setActiveChompTarget(resolvedTarget);
  }

  const getActiveUiTarget = () => {
    if (!options.db) {
      const ctx = readMasterContext();
      if (ctx?.activeRepoPath && existsSync(ctx.activeRepoPath)) {
        const tetheredDb = resolve(ctx.activeRepoPath, ".chomp", "graph.db");
        if (existsSync(tetheredDb)) {
          return {
            target: ctx.activeRepoPath,
            repoName: resolveRepoName(ctx.activeRepoPath),
            dbPath: tetheredDb,
          };
        }
      }
    }
    return {
      target: resolvedTarget,
      repoName,
      dbPath,
    };
  };

  const app = express();
  const host = options.host ?? process.env.CHOMP_UI_HOST ?? "127.0.0.1";

  // Loopback Host & Origin Guard (blocks external origins and DNS rebinding
  // while preserving cross-port localhost CORS and Chrome Private Network Access for `https://app.getchomp.dev`)
  app.use((req, res, next) => {
    if (!isLoopbackHostHeader(req.headers.host)) {
      return res.status(403).json({ error: "Forbidden: non-loopback Host header" });
    }
    const originHeader =
      typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!isAllowedLocalhostOrigin(originHeader)) {
      return res.status(403).json({ error: "Forbidden: non-localhost Origin header" });
    }
    // Support Chrome/Edge Private Network Access preflights (`https://app.getchomp.dev` -> `http://127.0.0.1:5555`)
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    return next();
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || isAllowedLocalhostOrigin(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by Chomp localhost CORS policy"));
        }
      },
    }),
  );
  app.use(express.json({ limit: "15mb" }));

  // 1. Serve the local Next.js static export when running inside the master monorepo
  const localWebDir = options.remote ? null : resolveLocalMasterWebDir();
  if (localWebDir) {
    app.use(express.static(localWebDir));
  }

  const resolvedCloudApiUrl = (
    options.cloudUrl ??
    process.env.CHOMP_LAYOUT_API_URL ??
    DEFAULT_CLOUD_API_URL
  )
    .trim()
    .replace(/\/+$/, "");
  const isMasterLocalMode = Boolean(
    !options.remote &&
      !options.cloudUrl &&
      !process.env.CHOMP_LAYOUT_API_URL &&
      hasLocalMasterLayoutEngine(),
  );
  const localDaemonUrl = `http://localhost:${port}`;
  const rawHostedUi =
    options.hostedUi === true
      ? DEFAULT_HOSTED_UI_URL
      : typeof options.hostedUi === "string" && options.hostedUi.trim()
        ? options.hostedUi.trim()
        : process.env.CHOMP_HOSTED_UI_URL?.trim() ||
          (!localWebDir ? DEFAULT_HOSTED_UI_URL : "");
  const url = rawHostedUi
    ? `${rawHostedUi.replace(/\/+$/, "")}?port=${port}`
    : localDaemonUrl;

  let latestEntitlement: LayoutEntitlement | undefined = isMasterLocalMode
    ? {
        tier: "master",
        status: "active",
        previewMode: false,
        gatingMode: "early_access",
      }
    : undefined;

  // -----------------------------------------------------------------------
  // GET /api/layout  — primary endpoint for the Topological Unrolling visualization
  // Query params:
  //   diff=true  — overlay diffStatus from comparing DB graph vs live tree
  // -----------------------------------------------------------------------
  const layoutCache = new Map<string, LayoutData>();
  const layoutInFlight = new Map<string, Promise<LayoutData>>();
  const loggedBoardRevisions = new Set<string>();
  const statusTracker = createBuildStatusTracker(repoName);
  const chompSpinnerFrames = ["◐", "◓", "◑", "◒"];
  let ttyProgressActive = false;

  statusTracker.subscribe((snap) => {
    if (!process.stdout.isTTY) return;
    if (snap.building) {
      ttyProgressActive = true;
      const frame = chompSpinnerFrames[(snap.step - 1) % chompSpinnerFrames.length];
      const modeLabel = snap.diffMode ? " · diff" : "";
      process.stdout.write(
        `\r\x1b[2K  ${ansi.yellowBold(frame)} ${ansi.bold("Chomping layout")} ${ansi.dim(`(${snap.repoName}${modeLabel})`)}  ${ansi.cyan(`[${snap.step}/${snap.totalSteps}]`)} ${snap.stageLabel}...`,
      );
    } else if (ttyProgressActive) {
      ttyProgressActive = false;
      process.stdout.write("\r\x1b[2K");
    }
  });

  app.get("/api/status", (req, res) => {
    const { repoName: activeRepoName } = getActiveUiTarget();
    const current = statusTracker.getSnapshot();
    const enriched =
      current.state === "idle" && current.repoName !== activeRepoName
        ? { ...current, repoName: activeRepoName }
        : current;

    const wantsStream =
      req.query.stream === "true" ||
      (typeof req.headers.accept === "string" &&
        req.headers.accept.includes("text/event-stream"));

    if (!wantsStream) {
      return res.json(enriched);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify(enriched)}\n\n`);

    const unsubscribe = statusTracker.subscribe((nextSnap) => {
      try {
        res.write(`data: ${JSON.stringify(nextSnap)}\n\n`);
      } catch {
        // Client disconnected
      }
    });
    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // Ignore write error on closed socket
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
  type BaseGraphCacheEntry = {
    key: string;
    mtime: number;
    repo: {
      id: string;
      name?: string;
      path?: string;
      commitSha?: string;
      branchName?: string;
    };
    graph: RepresentationGraph;
    /** Every overlay, as stored (used by the dedicated `/api/overlays` storage API). */
    overlays: EntityOverlayItem[];
    /** Overlays as `/api/layout` and `/api/graph` carry them: plugin presentations deferred to `/api/plugins/*`. */
    structuralOverlays: EntityOverlayItem[];
    /** Overlays carrying a plugin presentation, served separately by `/api/plugins/*` ([PAT-VIS-36]). */
    pluginOverlays: EntityOverlayItem[];
    /** Content fingerprint of the structure; unaffected by plugin writes. */
    structureFp: string;
  } | null;
  const pluginRuns: PluginRunMap = new Map();
  let baseGraphCache: BaseGraphCacheEntry = null;
  let baseGraphInFlight: Promise<BaseGraphCacheEntry> | null = null;
  let liveGraphCache: {
    key: string;
    liveGraph: RepresentationGraph;
  } | null = null;
  let latestDiffSummary: {
    fingerprintKey: string;
    summary: DiffSummaryStats;
  } | null = null;

  const invalidateAllServerCaches = () => {
    layoutCache.clear();
    layoutInFlight.clear();
    loggedBoardRevisions.clear();
    baseGraphCache = null;
    baseGraphInFlight = null;
    liveGraphCache = null;
  };

  const getCurrentDbMtime = (targetDbPath: string) =>
    existsSync(targetDbPath) ? statSync(targetDbPath).mtimeMs : 0;

  const loadBaseGraphCached = async () => {
    const { target: activeTarget, dbPath: activeDbPath } = getActiveUiTarget();
    const currentMtime = getCurrentDbMtime(activeDbPath);
    const dbKey = `${activeDbPath}:${currentMtime}`;
    if (baseGraphCache && baseGraphCache.key === dbKey) {
      return baseGraphCache;
    }
    if (baseGraphInFlight) {
      return baseGraphInFlight;
    }
    baseGraphInFlight = (async () => {
      try {
        const storage = createSQLiteStorage(activeDbPath);
        const repos = await storage.listRepositories();
        if (repos.length === 0) {
          await storage.close();
          return null;
        }
        const repo = repos[0];
        const graph = await storage.getRepresentationGraph(repo.id);
        const overlays = await storage.getEntityOverlays(repo.id);
        await storage.close();
        if (!graph) return null;
        // Closing a WAL-mode SQLite connection checkpoints `-wal` into `graph.db`,
        // updating `mtimeMs`. Record the post-close `mtimeMs` so subsequent reads hit cache.
        const postCloseMtime = getCurrentDbMtime(activeDbPath);
        const finalKey = `${activeDbPath}:${postCloseMtime}`;
        const split = splitOverlays(overlays);
        const repoPathForPlugins = repo.path || activeTarget;
        const repoLocalPluginsDir = resolve(repoPathForPlugins, ".chomp", "plugins");
        if (existsSync(repoLocalPluginsDir)) {
          await discoverPluginsInDir(repoLocalPluginsDir);
        }
        baseGraphCache = {
          key: finalKey,
          mtime: postCloseMtime,
          repo,
          graph,
          overlays,
          structuralOverlays: split.layout,
          pluginOverlays: split.plugin,
          structureFp: computeStructureFingerprint(
            graph.nodes as any,
            graph.edges as any,
            overlaysForStructureFingerprint(
              split,
              rulesReferenceOverlays(loadRulesConfig(activeDbPath).customRules as any),
              isRegisteredStructuralPluginOverlay
            )
          ),
        };
        return baseGraphCache;
      } finally {
        baseGraphInFlight = null;
      }
    })();
    return baseGraphInFlight;
  };

  const getAuthModeFingerprint = () => {
    const activeBearer = resolveActiveBearerToken();
    const bearerTag = activeBearer
      ? createHash("sha1").update(activeBearer).digest("hex").slice(0, 12)
      : "anon";
    return `${isMasterLocalMode ? "master" : resolvedCloudApiUrl}:${bearerTag}`;
  };

  const buildAuthStatusPayload = () => {
    const creds = loadChompCredentials();
    const activeToken = resolveActiveBearerToken();
    const jwtClaims = creds?.token
      ? decodeJwtPayloadUnsafe(creds.token)
      : activeToken?.startsWith("chomp_tok_")
        ? decodeJwtPayloadUnsafe(activeToken)
        : null;
    const githubHandle =
      creds?.githubHandle ||
      (typeof jwtClaims?.github_login === "string"
        ? jwtClaims.github_login
        : undefined);
    const expiresAt =
      typeof jwtClaims?.exp === "number"
        ? new Date(jwtClaims.exp * 1000).toISOString()
        : undefined;
    const tokenExpired =
      typeof jwtClaims?.exp === "number"
        ? jwtClaims.exp * 1000 <= Date.now()
        : false;
    const claimedTier =
      typeof jwtClaims?.tier === "string" ? jwtClaims.tier : undefined;

    return {
      authenticated: Boolean(activeToken && !tokenExpired),
      hasToken: Boolean(creds?.token),
      hasApiKey: Boolean(creds?.apiKey),
      ...(githubHandle ? { githubHandle } : {}),
      ...(claimedTier ? { claimedTier } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      tokenExpired,
      ...(creds?.updatedAt ? { updatedAt: creds.updatedAt } : {}),
      mode: isMasterLocalMode ? ("master" as const) : ("cloud" as const),
      cloudApiUrl: resolvedCloudApiUrl,
      port: Number(port),
      ...(latestEntitlement ? { entitlement: latestEntitlement } : {}),
    };
  };

  // -----------------------------------------------------------------------
  // Loopback Auth Endpoints (`~/.chomp/credentials.json`, 0600 perms)
  // -----------------------------------------------------------------------
  app.get("/api/auth/status", (_req, res) => {
    return res.json(buildAuthStatusPayload());
  });

  app.get("/api/auth/callback", (req, res) => {
    try {
      const rawToken =
        typeof req.query.token === "string" ? req.query.token.trim() : "";
      const rawHandle =
        typeof req.query.handle === "string" ? req.query.handle.trim() : "";
      if (!rawToken) {
        return res
          .status(400)
          .json({ error: "Missing ?token= query parameter on auth callback." });
      }
      const claims = decodeJwtPayloadUnsafe(rawToken);
      const githubHandle =
        rawHandle ||
        (typeof claims?.github_login === "string"
          ? claims.github_login
          : undefined);
      saveChompCredentials({
        token: rawToken,
        ...(githubHandle ? { githubHandle } : {}),
      });
      const { dbPath: activeDbPath } = getActiveUiTarget();
      clearDiskLayoutCache(activeDbPath);
      invalidateAllServerCaches();
      return res.redirect(302, url);
    } catch (err: any) {
      return res
        .status(500)
        .json({ error: err?.message || "Failed to persist GitHub trial token." });
    }
  });

  app.post("/api/auth/token", (req, res) => {
    try {
      const rawKey =
        typeof req.body?.apiKey === "string"
          ? req.body.apiKey.trim()
          : typeof req.body?.token === "string"
            ? req.body.token.trim()
            : "";
      if (!rawKey) {
        return res
          .status(400)
          .json({ error: "A license key (chomp_live_...) or token is required." });
      }
      if (rawKey.startsWith("chomp_tok_")) {
        const claims = decodeJwtPayloadUnsafe(rawKey);
        const githubHandle =
          typeof claims?.github_login === "string"
            ? claims.github_login
            : undefined;
        saveChompCredentials({
          token: rawKey,
          apiKey: "",
          ...(githubHandle ? { githubHandle } : {}),
        });
      } else {
        saveChompCredentials({ apiKey: rawKey });
      }
      const { dbPath: activeDbPath } = getActiveUiTarget();
      clearDiskLayoutCache(activeDbPath);
      invalidateAllServerCaches();
      return res.json({ ok: true, ...buildAuthStatusPayload() });
    } catch (err: any) {
      return res
        .status(500)
        .json({ error: err?.message || "Failed to save license key." });
    }
  });

  app.delete("/api/auth/token", (_req, res) => {
    try {
      clearChompCredentials();
      const { dbPath: activeDbPath } = getActiveUiTarget();
      clearDiskLayoutCache(activeDbPath);
      invalidateAllServerCaches();
      if (!isMasterLocalMode) {
        latestEntitlement = undefined;
      }
      return res.json({ ok: true, ...buildAuthStatusPayload() });
    } catch (err: any) {
      return res
        .status(500)
        .json({ error: err?.message || "Failed to clear credentials." });
    }
  });

  app.get("/api/layout/fingerprint", async (_req, res) => {
    try {
      const { target: activeTarget, dbPath: activeDbPath } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      const dbMtime = baseData?.mtime ?? getCurrentDbMtime(activeDbPath);
      const repoPath = baseData?.repo?.path || activeTarget;
      const rulesFp = `${activeDbPath}:${getRulesFingerprint(activeDbPath)}:${getAuthModeFingerprint()}`;
      const wtFingerprint = computeWorkingTreeFingerprint(repoPath);
      return res.json({
        dbMtime,
        rulesFp,
        wtFingerprint,
        // Structure and plugins revalidate independently: plugin writes never force a re-layout.
        structureFp: baseData?.structureFp ?? "",
        pluginFp: computePluginFingerprint(
          baseData?.pluginOverlays ?? [],
          hydratePluginRuns(repoPath),
          pluginRegistryMeta(repoPath)
        ),
      });
    } catch (error: any) {
      return res.status(500).json({
        error: error?.message || "Failed to compute fingerprint",
      });
    }
  });

  let initialPortHydrationTriggered = false;
  const triggerInitialPortHydrationAfterLayout = () => {
    if (initialPortHydrationTriggered) return;
    initialPortHydrationTriggered = true;
    setTimeout(() => {
      void scheduleBackgroundPortHydration(false);
    }, 350);
  };

  app.get("/api/layout", async (req, res) => {
    try {
      const { target: activeTarget, repoName: activeRepoName, dbPath: activeDbPath } =
        getActiveUiTarget();
      const diffMode = req.query.diff === "true";
      const forceRefresh = req.query.refresh === "true";
      if (forceRefresh) {
        clearDiskLayoutCache(activeDbPath);
        invalidateAllServerCaches();
      }

      const baseData = await loadBaseGraphCached();
      if (!baseData) {
        return res.status(404).json({ error: "No repositories or graph found in database." });
      }

      const { mtime: dbMtime, repo, graph, structuralOverlays: overlays, structureFp } = baseData;
      const repoPath = repo.path || activeTarget;
      const liveGit = getGitInfo(repoPath);
      const resolvedBranchName =
        liveGit.branchName || repo.branchName || graph.branchName;
      const resolvedCommitSha =
        liveGit.commitSha || repo.commitSha || graph.commitSha;
      const resolvedCommitMessage = liveGit.commitMessage;
      const resolvedRemoteUrl = liveGit.remoteUrl;
      const resolvedUpdatedAt = dbMtime || Date.now();
      const rulesFp = getRulesFingerprint(activeDbPath);
      const authModeFp = getAuthModeFingerprint();
      const wtFingerprint = diffMode
        ? computeWorkingTreeFingerprint(repoPath)
        : "normal";
      const cacheKey = diffMode
        ? `${activeDbPath}:${dbMtime}:${rulesFp}:${authModeFp}:diff:${wtFingerprint}`
        : `${activeDbPath}:${dbMtime}:${rulesFp}:${authModeFp}:normal`;
      const diskCacheSeed = `${structureFp}:${rulesFp}:${authModeFp}`;

      const stampLiveGitMetadata = (targetLayout: LayoutData) => {
        if (!diffMode && !targetLayout.diffSummary && latestDiffSummary) {
          targetLayout.diffSummary = latestDiffSummary.summary;
        }
        if (resolvedBranchName) {
          targetLayout.branchName = resolvedBranchName;
          if (targetLayout.healthSummary) {
            targetLayout.healthSummary.branchName = resolvedBranchName;
          }
        }
        if (resolvedCommitSha) {
          targetLayout.commitSha = resolvedCommitSha;
          if (targetLayout.healthSummary) {
            targetLayout.healthSummary.commitSha = resolvedCommitSha;
          }
        }
        if (resolvedCommitMessage) {
          targetLayout.commitMessage = resolvedCommitMessage;
          if (targetLayout.healthSummary) {
            targetLayout.healthSummary.commitMessage = resolvedCommitMessage;
          }
        }
        if (resolvedRemoteUrl) {
          targetLayout.remoteUrl = resolvedRemoteUrl;
        }
        targetLayout.updatedAt = resolvedUpdatedAt;
        if (targetLayout.healthSummary) {
          targetLayout.healthSummary.updatedAt = resolvedUpdatedAt;
        }
        if (targetLayout.entitlement) {
          latestEntitlement = targetLayout.entitlement;
        }
      };

      if (layoutCache.has(cacheKey)) {
        const cached = layoutCache.get(cacheKey)!;
        stampLiveGitMetadata(cached);
        triggerInitialPortHydrationAfterLayout();
        return res.json(cached);
      }

      if (!diffMode && !forceRefresh) {
        const diskHit = readDiskLayoutCache(activeDbPath, diskCacheSeed);
        if (diskHit) {
          stampLiveGitMetadata(diskHit);
          layoutCache.set(cacheKey, diskHit);
          statusTracker.complete(1);
          triggerInitialPortHydrationAfterLayout();
          return res.json(diskHit);
        }
      }

      if (layoutInFlight.has(cacheKey)) {
        const pending = await layoutInFlight.get(cacheKey)!;
        triggerInitialPortHydrationAfterLayout();
        return res.json(pending);
      }

      const buildPromise = (async () => {
        if (options.debug) {
          console.log(
            `\n📐 Layout request — ${graph.nodes.length} nodes, ${graph.edges.length} edges` +
              (diffMode ? ` [diff mode · wt=${wtFingerprint}]` : "")
          );
        }

        const liveCacheKey = `${repoPath}:${wtFingerprint}`;
        const cachedLive =
          diffMode && liveGraphCache?.key === liveCacheKey
            ? liveGraphCache.liveGraph
            : undefined;

        const canonicalRepoName = repoPath ? resolveRepoName(repoPath) : activeRepoName;
        const resolvedRepoName =
          repo.name && (!repoPath || repo.name !== basename(repoPath))
            ? repo.name
            : canonicalRepoName || repo.name || activeRepoName || "repository";
        const resolvedRepoId =
          repo.id || resolvedRepoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const rulesConfig = loadRulesConfig(activeDbPath);
        const contractCount =
          graph.nodes.filter((n) => n.type === "CONTRACT").length ||
          graph.nodes.length;
        const packageCount =
          graph.nodes.filter((n) => n.entityType === "DEPLOYMENT_UNIT").length ||
          1;
        const buildStartMs = Date.now();
        statusTracker.begin({
          repoName: resolvedRepoName,
          branchName: resolvedBranchName,
          diffMode,
          contractCount,
          packageCount,
        });
        let layout: LayoutData;
        let liveGraph: RepresentationGraph | undefined;
        try {
          const built = await buildLayout(
            graph,
            repoPath,
            diffMode,
            resolvedRepoName,
            cachedLive,
            rulesConfig,
            overlays,
            Boolean(options.debug),
            options.cloudUrl,
            (stage) => statusTracker.advance(stage),
            Boolean(options.remote),
          );
          layout = built.layout;
          liveGraph = built.liveGraph;
        } catch (buildErr: any) {
          statusTracker.fail(buildErr?.message || "Layout build failed");
          throw buildErr;
        }
        statusTracker.complete(Date.now() - buildStartMs);
        (layout as any).repoId = resolvedRepoId;
        stampLiveGitMetadata(layout);

        if (diffMode && liveGraph) {
          liveGraphCache = { key: liveCacheKey, liveGraph };
        }
        if (diffMode && layout.diffSummary) {
          latestDiffSummary = {
            fingerprintKey: `${activeDbPath}:${dbMtime}:${wtFingerprint}`,
            summary: layout.diffSummary,
          };
          const normalCached = layoutCache.get(`${activeDbPath}:${dbMtime}:${rulesFp}:${authModeFp}:normal`);
          if (normalCached) {
            normalCached.diffSummary = layout.diffSummary;
          }
        } else if (!diffMode) {
          writeDiskLayoutCache(activeDbPath, diskCacheSeed, layout);
        }

        // Bounded LRU eviction (retain normal + recent diff layouts)
        if (layoutCache.size >= 6) {
          const oldestKey = layoutCache.keys().next().value;
          if (oldestKey) layoutCache.delete(oldestKey);
        }
        layoutCache.set(cacheKey, layout);

        const revisionLogKey = `${activeDbPath}:${dbMtime}:${rulesFp}:${authModeFp}`;
        if (options.debug || process.env.CHOMP_DEBUG_LAYOUT === "1") {
          console.log(
            `✅  Layout complete — ${layout.nodes.length} positioned nodes, ` +
              `${layout.islandNodes.length} islands, ${layout.badgeNodes.length} badge hubs`
          );
        } else if (!loggedBoardRevisions.has(revisionLogKey)) {
          loggedBoardRevisions.add(revisionLogKey);
          const pkgCount = Object.keys(layout.packageBounds ?? {}).length || 1;
          console.log(
            `  ${ansi.green("✓")} ${ansi.bold("Visualizer board ready")} ${ansi.dim(`— mapped ${layout.nodes.length} components & contracts across ${pkgCount} package${pkgCount === 1 ? "" : "s"}`)}`,
          );
        }

        return layout;
      })().finally(() => {
        layoutInFlight.delete(cacheKey);
      });

      layoutInFlight.set(cacheKey, buildPromise);
      const resultLayout = await buildPromise;
      triggerInitialPortHydrationAfterLayout();
      return res.json(resultLayout);
    } catch (error: any) {
      console.error("Layout error:", error);
      if (error.lintErrors) {
        return res.status(500).json({
          error: error.message,
          details: error.lintErrors,
        });
      }
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/graph  — kept for backwards compatibility & inspector evidence
  // -----------------------------------------------------------------------
  app.get("/api/graph", async (req, res) => {
    try {
      const { target: activeTarget, dbPath: activeDbPath } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      if (!baseData) {
        return res.status(404).json({ error: "No repositories or graph found in database." });
      }
      const { repo, graph, structuralOverlays: overlays } = baseData;
      const projectedGraph = applyActivePluginProjections(graph, {
        repoPath: repo.path || activeTarget,
        overlays,
        overlayLayers: loadRulesConfig(activeDbPath).overlayLayers,
      });

      // Attach grid layout if it exists (backwards compat for old renderer)
      let gridLayout = null;
      const gridLayoutPath = join(dirname(activeDbPath), "grid_layout.json");
      if (existsSync(gridLayoutPath)) {
        try {
          gridLayout = JSON.parse(readFileSync(gridLayoutPath, "utf-8"));
        } catch (e) {
          console.error("Failed to parse grid_layout.json");
        }
      }

      const sanitizedGraph = stripEvidenceSnippetsFromGraph(projectedGraph);
      res.json({
        nodes: sanitizedGraph.nodes,
        edges: sanitizedGraph.edges,
        overlays,
        gridLayout,
      });
    } catch (error) {
      console.error("Error fetching graph:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/source-line — localhost-only 1-line call-shape lookup for UNKNOWN / LIKELY tooltips
  // -----------------------------------------------------------------------
  app.get("/api/source-line", async (req, res) => {
    try {
      const filePath = typeof req.query.file === "string" ? req.query.file.trim() : "";
      const rawLine = typeof req.query.line === "string" ? Number(req.query.line) : NaN;
      if (!filePath || !Number.isInteger(rawLine) || rawLine < 1) {
        return res.status(400).json({ error: "Valid file and 1-based line query parameters are required." });
      }
      const { target: activeTarget } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      const repoPath = baseData?.repo.path || activeTarget;
      const hit = readSingleSourceLine(repoPath, filePath, rawLine);
      if (!hit) {
        return res.status(404).json({ error: "Source line unavailable." });
      }
      return res.json(hit);
    } catch (e) {
      console.error("Error reading source line:", e);
      return res.status(500).json({ error: "Failed to read source line" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/open-in-ide — localhost-only IDE deep-link launcher (with editorUri + remoteFileUrl fallback)
  // -----------------------------------------------------------------------
  app.post("/api/open-in-ide", async (req, res) => {
    try {
      const body = req.body ?? {};
      const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
      const lineNumber =
        typeof body.lineNumber === "number" && Number.isInteger(body.lineNumber) && body.lineNumber >= 1
          ? body.lineNumber
          : undefined;
      if (!filePath) {
        return res.status(400).json({ error: "filePath is required." });
      }
      const { target: activeTarget } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      const repoPath = baseData?.repo.path || activeTarget;
      const liveGit = getGitInfo(repoPath);
      const result = await openInLocalEditor({
        repoRoot: repoPath,
        relFilePath: filePath,
        lineNumber,
        remoteUrl: liveGit.remoteUrl,
        commitSha: liveGit.commitSha || baseData?.repo.commitSha || baseData?.graph.commitSha,
      });
      if (!result.ok) {
        return res.status(404).json(result);
      }
      return res.json(result);
    } catch (e) {
      console.error("Error opening file in IDE:", e);
      return res.status(500).json({ error: "Failed to open file in IDE" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/telemetry — debug telemetry (unchanged)
  // -----------------------------------------------------------------------
  app.post("/api/telemetry", (req, res) => {
    try {
      const { dbPath: activeDbPath } = getActiveUiTarget();
      const telemetryPath = join(dirname(activeDbPath), "telemetry.json");
      writeFileSync(telemetryPath, JSON.stringify(req.body, null, 2));
      res.json({ success: true });
    } catch (e) {
      console.error("Telemetry error:", e);
      res.status(500).json({ error: "Failed to write telemetry" });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/view — read agentic view state (with repoId, branch-awareness + node-existence failsafe)
  // -----------------------------------------------------------------------
  app.get("/api/view", async (req, res) => {
    try {
      const {
        target: activeTarget,
        repoName: activeRepoName,
        dbPath: activeDbPath,
      } = getActiveUiTarget();
      const viewPath = join(dirname(activeDbPath), "current_view.json");
      if (!existsSync(viewPath)) {
        return res.json(null);
      }
      const data = JSON.parse(readFileSync(viewPath, "utf-8"));
      if (!data || typeof data !== "object") {
        return res.json(null);
      }
      const baseData = await loadBaseGraphCached();
      if (!baseData) {
        return res.json(null);
      }
      const resolvedRepoName = baseData.repo.name || activeRepoName;
      const activeRepoId =
        baseData.repo.id ||
        resolvedRepoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

      // Failsafe 1: Reject if view explicitly declares a mismatched repoId or repoName
      if (data.repoId && data.repoId !== activeRepoId) {
        return res.json(null);
      }
      if (
        data.repoName &&
        data.repoName !== resolvedRepoName &&
        data.repoName !== activeRepoName
      ) {
        return res.json(null);
      }

      // Branch-Aware Expiration Check:
      // If the view records a branchName and it does not match the current active branch,
      // mark the view as expired so the UI can show an expiration message instead of stale highlights.
      const repoPath = baseData.repo.path || activeTarget;
      const liveGit = getGitInfo(repoPath);
      const currentBranchName =
        liveGit.branchName || baseData.repo.branchName || baseData.graph.branchName;
      const isBranchMismatch = Boolean(
        data.branchName &&
          currentBranchName &&
          data.branchName !== currentBranchName,
      );

      // Failsafe 2: Reject if view specifies highlightNodeIds and 0 of them exist in the active graph
      // (unless expired due to branch mismatch, in which case return the expired payload so the UI displays the expiration notice)
      if (
        !isBranchMismatch &&
        Array.isArray(data.highlightNodeIds) &&
        data.highlightNodeIds.length > 0
      ) {
        const projectedForView = applyActivePluginProjections(baseData.graph, {
          repoPath,
          overlays: baseData.structuralOverlays,
        });
        const graphNodeIdSet = new Set(
          projectedForView.nodes.map((n) => String(n.id).split("::")[0].split("@")[0]),
        );
        const hasAnyMatchingNode = data.highlightNodeIds.some((rawId: any) =>
          graphNodeIdSet.has(String(rawId).split("::")[0].split("@")[0]),
        );
        if (!hasAnyMatchingNode) {
          return res.json(null);
        }
      }

      return res.json({
        ...data,
        repoId: activeRepoId,
        repoName: resolvedRepoName,
        ...(currentBranchName ? { currentBranchName } : {}),
        ...(isBranchMismatch
          ? { expired: true, expiredReason: "branch_mismatch" }
          : { expired: false }),
      });
    } catch (e) {
      console.error("Error reading view:", e);
      res.json(null);
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/view — activate an agentic or plugin spotlight view
  // -----------------------------------------------------------------------
  app.post("/api/view", async (req, res) => {
    try {
      const {
        target: activeTarget,
        repoName: activeRepoName,
        dbPath: activeDbPath,
      } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      const resolvedRepoName = baseData?.repo.name || activeRepoName;
      const activeRepoId =
        baseData?.repo.id ||
        resolvedRepoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
      const repoPath = baseData?.repo.path || activeTarget;
      const liveGit = getGitInfo(repoPath);
      const currentBranchName =
        liveGit.branchName || baseData?.repo.branchName || baseData?.graph.branchName;

      const body = req.body ?? {};
      const payload = {
        title: typeof body.title === "string" ? body.title : "Spotlight View",
        description: typeof body.description === "string" ? body.description : "",
        highlightNodeIds: Array.isArray(body.highlightNodeIds)
          ? body.highlightNodeIds.filter((id: unknown): id is string => typeof id === "string")
          : [],
        ...(body.viewLevel === "package" || body.viewLevel === "system"
          ? { viewLevel: body.viewLevel }
          : {}),
        ...(typeof body.packageName === "string" ? { packageName: body.packageName } : {}),
        ...(body.nodeAnnotations && typeof body.nodeAnnotations === "object"
          ? { nodeAnnotations: body.nodeAnnotations }
          : {}),
        ...(typeof body.layer === "string" ? { layer: body.layer } : {}),
        ...(typeof body.source === "string" ? { source: body.source } : {}),
        repoId: activeRepoId,
        repoName: resolvedRepoName,
        ...(currentBranchName ? { branchName: currentBranchName, currentBranchName } : {}),
        createdAt: new Date().toISOString(),
        expired: false,
      };
      const viewPath = join(dirname(activeDbPath), "current_view.json");
      writeFileSync(viewPath, JSON.stringify(payload, null, 2), "utf-8");
      return res.json(payload);
    } catch (e) {
      console.error("Error writing view:", e);
      return res.status(500).json({ error: "Failed to save view" });
    }
  });

  // -----------------------------------------------------------------------
  // DELETE /api/view — clear agentic view state
  // -----------------------------------------------------------------------
  app.delete("/api/view", (req, res) => {
    try {
      const { dbPath: activeDbPath } = getActiveUiTarget();
      const viewPath = join(dirname(activeDbPath), "current_view.json");
      if (existsSync(viewPath)) {
        unlinkSync(viewPath);
      }
      res.json({ success: true });
    } catch (e) {
      console.error("Error deleting view:", e);
      res.status(500).json({ error: "Failed to delete view" });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/rules & PUT /api/rules — classification & folding rules (.chomp/rules.json)
  // -----------------------------------------------------------------------
  app.get("/api/rules", (req, res) => {
    try {
      const { dbPath: activeDbPath } = getActiveUiTarget();
      const config = loadRulesConfig(activeDbPath);
      return res.json(config);
    } catch (e) {
      console.error("Error reading rules config:", e);
      return res.status(500).json({ error: "Failed to read rules config" });
    }
  });

  app.put("/api/rules", (req, res) => {
    try {
      const { dbPath: activeDbPath } = getActiveUiTarget();
      const saved = saveRulesConfig(activeDbPath, req.body);
      layoutCache.clear();
      return res.json(saved);
    } catch (e) {
      console.error("Error saving rules config:", e);
      return res.status(500).json({ error: "Failed to save rules config" });
    }
  });

  // -----------------------------------------------------------------------
  // /api/plugins — Plugin Presentation Contract, served AFTER the structural graph ([PAT-VIS-36])
  //   GET  /api/plugins                      HUD cards: per-plugin summary, per-package summaries, run state
  //   GET  /api/plugins/presentation?entityId=…   inspector sections for one entity (lazy)
  //   POST /api/plugins/:name/run            run a plugin in the background (202); poll /status or the fingerprint
  //   GET  /api/plugins/:name/status
  // -----------------------------------------------------------------------
  const hydratePluginRuns = (repoPath?: string) => {
    const snap = snapshotPluginRuns(pluginRuns);
    if (!repoPath) return snap;
    for (const p of listChompPlugins()) {
      const mem = snap[p.name];
      if (mem?.state === "running") continue;
      const disk = readPluginLastRun(repoPath, p.name);
      if (!disk) continue;
      if (!mem || !mem.finishedAt || disk.finishedAt >= mem.finishedAt) {
        snap[p.name] = {
          state: disk.status === "error" ? "error" : "idle",
          startedAt: disk.startedAt,
          finishedAt: disk.finishedAt,
          ...(disk.error ? { error: disk.error } : {}),
        };
      }
    }
    return snap;
  };

  const pluginRegistryMeta = (repoPath?: string) =>
    listChompPlugins().map((p) => {
      const settings = p.settingsSchema ? loadPluginSettings(repoPath, p) : undefined;
      const envStatus = settings ? getPluginEnvStatus(p, settings) : undefined;
      const lastRun = readPluginLastRun(repoPath, p.name);
      return {
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        version: p.version,
        ...(p.order !== undefined ? { order: p.order } : {}),
        layer: p.layer as string,
        defaultEnabled: p.defaultEnabled ?? true,
        ...(p.inspectorScopes ? { inspectorScopes: p.inspectorScopes } : {}),
        stateDir: getPluginStateDirRel(p.name),
        ...(p.settingsSchema ? { settingsSchema: p.settingsSchema } : {}),
        ...(settings ? { settings } : {}),
        ...(envStatus ? { envStatus } : {}),
        ...(p.mcpTools && p.mcpTools.length > 0 ? { mcpTools: getPluginMcpToolSummaries(p) } : {}),
        ...(lastRun
          ? {
              lastRun: {
                status: lastRun.status,
                startedAt: lastRun.startedAt,
                finishedAt: lastRun.finishedAt,
                durationMs: lastRun.durationMs,
                ...(lastRun.overlayCount !== undefined ? { overlayCount: lastRun.overlayCount } : {}),
                ...(lastRun.presentationWarnings.length > 0
                  ? { presentationWarnings: lastRun.presentationWarnings }
                  : {}),
                ...(lastRun.error ? { error: lastRun.error } : {}),
              },
            }
          : {}),
      };
    });

  app.get("/api/plugins", async (req, res) => {
    try {
      const requestedEnv =
        typeof req.query.environment === "string" ? req.query.environment.trim() : undefined;
      const { target: activeTarget } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      if (!baseData) {
        return res.json({
          plugins: [],
          environment: requestedEnv || "default",
          fingerprint: {
            structureFp: "",
            pluginFp: computePluginFingerprint([], hydratePluginRuns(activeTarget), pluginRegistryMeta(activeTarget)),
          },
        });
      }
      const repoPath = baseData.repo.path || activeTarget;
      return res.json(
        buildPluginsOverview({
          pluginOverlays: baseData.pluginOverlays,
          nodes: baseData.graph.nodes as any,
          registry: pluginRegistryMeta(repoPath),
          runs: hydratePluginRuns(repoPath),
          structureFp: baseData.structureFp,
          environment: requestedEnv,
        })
      );
    } catch (e) {
      console.error("Error building plugins overview:", e);
      return res.status(500).json({ error: "Failed to load plugin data" });
    }
  });

  app.get("/api/plugins/presentation", async (req, res) => {
    try {
      const entityId = typeof req.query.entityId === "string" ? req.query.entityId : "";
      if (!entityId) return res.status(400).json({ error: "entityId is required" });
      const requestedEnv =
        typeof req.query.environment === "string" ? req.query.environment.trim() : undefined;
      const { target: activeTarget } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      if (!baseData) return res.json([]);
      const repoPath = baseData.repo.path || activeTarget;
      return res.json(
        buildEntityPresentations({
          pluginOverlays: baseData.pluginOverlays,
          entityId,
          registry: pluginRegistryMeta(repoPath),
          nodes: baseData.graph.nodes as any,
          environment: requestedEnv,
        })
      );
    } catch (e) {
      console.error("Error loading plugin presentation:", e);
      return res.status(500).json({ error: "Failed to load plugin presentation" });
    }
  });

  app.get("/api/plugins/:name/settings", async (req, res) => {
    try {
      const name = String(req.params.name);
      const plugin = getChompPlugin(name);
      if (!plugin) return res.status(404).json({ error: `Unknown plugin '${name}'` });
      const { target: activeTarget } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      const repoPath = baseData?.repo.path || activeTarget;
      const settings = loadPluginSettings(repoPath, plugin);
      const envStatus = getPluginEnvStatus(plugin, settings);
      return res.json({
        plugin: plugin.name,
        stateDir: getPluginStateDirRel(plugin.name),
        settingsSchema: plugin.settingsSchema ?? [],
        settings,
        ...(envStatus ? { envStatus } : {}),
      });
    } catch (e) {
      console.error("Error reading plugin settings:", e);
      return res.status(500).json({ error: "Failed to read plugin settings" });
    }
  });

  app.put("/api/plugins/:name/settings", async (req, res) => {
    try {
      const name = String(req.params.name);
      const plugin = getChompPlugin(name);
      if (!plugin) return res.status(404).json({ error: `Unknown plugin '${name}'` });
      const { target: activeTarget, dbPath: activeDbPath } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      const repoPath = baseData?.repo.path || activeTarget;
      const patch = req.body && typeof req.body === "object" ? req.body : {};
      const settings = savePluginSettings(repoPath, plugin, patch);
      const envStatus = getPluginEnvStatus(plugin, settings);
      layoutCache.clear();

      if (baseData && !isPluginRunning(pluginRuns, plugin.name)) {
        startPluginRun(pluginRuns, plugin.name);
        void (async () => {
          try {
            await runChompPlugin(plugin, {
              repoPath,
              repoId: baseData.repo.id,
              repoName:
                baseData.repo.name && baseData.repo.name !== basename(repoPath)
                  ? baseData.repo.name
                  : resolveRepoName(repoPath),
              dbPath: activeDbPath,
              graph: baseData.graph,
              excludeWorkspaces: loadExcludeWorkspaces(repoPath),
              persist: true,
            });
            finishPluginRun(pluginRuns, plugin.name);
          } catch (err: any) {
            failPluginRun(pluginRuns, plugin.name, err?.message ?? String(err));
          } finally {
            baseGraphCache = null;
            layoutCache.clear();
          }
        })();
      }

      return res.json({
        plugin: plugin.name,
        stateDir: getPluginStateDirRel(plugin.name),
        settings,
        ...(envStatus ? { envStatus } : {}),
      });
    } catch (e) {
      console.error("Error saving plugin settings:", e);
      return res.status(500).json({ error: "Failed to save plugin settings" });
    }
  });

  app.get("/api/plugins/:name/status", async (req, res) => {
    const name = String(req.params.name);
    const mem = getPluginRun(pluginRuns, name);
    if (mem.state === "running") {
      return res.json(mem);
    }
    const { target: activeTarget } = getActiveUiTarget();
    const baseData = await loadBaseGraphCached();
    const repoPath = baseData?.repo.path || activeTarget;
    const disk = readPluginLastRun(repoPath, name);
    if (disk && (!mem.finishedAt || disk.finishedAt >= mem.finishedAt)) {
      return res.json({
        state: disk.status === "error" ? "error" : "idle",
        startedAt: disk.startedAt,
        finishedAt: disk.finishedAt,
        durationMs: disk.durationMs,
        ...(disk.presentationWarnings.length > 0
          ? { presentationWarnings: disk.presentationWarnings }
          : {}),
        ...(disk.error ? { error: disk.error } : {}),
      });
    }
    return res.json(mem);
  });

  app.post("/api/plugins/:name/run", async (req, res) => {
    try {
      const name = String(req.params.name);
      const plugin = getChompPlugin(name);
      if (!plugin) return res.status(404).json({ error: `Unknown plugin '${name}'` });
      if (isPluginRunning(pluginRuns, name)) {
        return res.status(202).json(getPluginRun(pluginRuns, name));
      }
      const runEnv =
        typeof req.body?.environment === "string" && req.body.environment.trim()
          ? req.body.environment.trim()
          : undefined;
      const { target: activeTarget, dbPath: activeDbPath } = getActiveUiTarget();
      const baseData = await loadBaseGraphCached();
      if (!baseData) return res.status(404).json({ error: "No repositories or graph found in database." });
      const repoPath = baseData.repo.path || activeTarget;
      const status = startPluginRun(pluginRuns, name);
      // Fire and forget: the client sees progress through `/api/layout/fingerprint` (pluginFp) and `/status`.
      void (async () => {
        try {
          await runChompPlugin(plugin, {
            repoPath,
            repoId: baseData.repo.id,
            repoName:
              baseData.repo.name && baseData.repo.name !== basename(repoPath)
                ? baseData.repo.name
                : resolveRepoName(repoPath),
            dbPath: activeDbPath,
            graph: baseData.graph,
            excludeWorkspaces: loadExcludeWorkspaces(repoPath),
            environment: runEnv,
            persist: true,
          });
          finishPluginRun(pluginRuns, name);
        } catch (err: any) {
          failPluginRun(pluginRuns, name, err?.message ?? String(err));
        } finally {
          baseGraphCache = null;
        }
      })();
      return res.status(202).json(status);
    } catch (e) {
      console.error("Error starting plugin run:", e);
      return res.status(500).json({ error: "Failed to start plugin run" });
    }
  });

  // -----------------------------------------------------------------------
  // GET/POST/DELETE /api/overlays — Dedicated entity_overlays & plugin storage ([PAT-DB-03])
  // -----------------------------------------------------------------------
  app.get("/api/overlays", async (req, res) => {
    try {
      const baseData = await loadBaseGraphCached();
      if (!baseData) {
        return res.json([]);
      }
      const entityId = typeof req.query.entityId === "string" ? req.query.entityId : undefined;
      const layer = typeof req.query.layer === "string" ? req.query.layer : undefined;
      const source = typeof req.query.source === "string" ? req.query.source : undefined;
      const environment = typeof req.query.environment === "string" ? req.query.environment : undefined;
      const filtered = baseData.overlays.filter((ov) => {
        if (entityId && ov.entityId !== entityId) return false;
        if (layer && ov.layer !== layer) return false;
        if (source && ov.source !== source) return false;
        if (environment && ov.environment !== environment) return false;
        return true;
      });
      return res.json(filtered);
    } catch (e) {
      console.error("Error fetching overlays:", e);
      return res.status(500).json({ error: "Failed to fetch entity overlays" });
    }
  });

  app.post("/api/overlays", async (req, res) => {
    try {
      const { dbPath: activeDbPath } = getActiveUiTarget();
      const storage = createSQLiteStorage(activeDbPath);
      const repos = await storage.listRepositories();
      if (repos.length === 0) {
        await storage.close();
        return res.status(404).json({ error: "No repository found in database" });
      }
      const repo = repos[0];
      const items = Array.isArray(req.body) ? req.body : req.body?.overlays ? req.body.overlays : [req.body];
      const valid = items.filter((item: any) => item && typeof item.entityId === "string" && typeof item.layer === "string");
      const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
      const pruneStaleBySource = typeof req.body?.pruneStaleBySource === "boolean" ? req.body.pruneStaleBySource : undefined;
      await storage.upsertEntityOverlays(valid, {
        repositoryId: repo.id,
        ...(runId ? { runId } : {}),
        ...(pruneStaleBySource !== undefined ? { pruneStaleBySource } : {}),
      });
      await storage.close();
      layoutCache.clear();
      baseGraphCache = null;
      return res.json({ success: true, count: valid.length });
    } catch (e) {
      console.error("Error saving overlays:", e);
      return res.status(500).json({ error: "Failed to save entity overlays" });
    }
  });

  app.delete("/api/overlays", async (req, res) => {
    try {
      const { dbPath: activeDbPath } = getActiveUiTarget();
      const storage = createSQLiteStorage(activeDbPath);
      const repos = await storage.listRepositories();
      if (repos.length === 0) {
        await storage.close();
        return res.status(404).json({ error: "No repository found in database" });
      }
      const repo = repos[0];
      const entityId = (req.body?.entityId ?? req.query.entityId) as string | undefined;
      const layer = (req.body?.layer ?? req.query.layer) as string | undefined;
      const source = (req.body?.source ?? req.query.source) as string | undefined;
      const environment = (req.body?.environment ?? req.query.environment) as string | undefined;
      const activeRunId = (req.body?.activeRunId ?? req.query.activeRunId) as string | undefined;
      if (activeRunId && layer && source) {
        const pruned = await storage.pruneEntityOverlays({
          repositoryId: repo.id,
          layer,
          source,
          environment,
          activeRunId,
        });
        await storage.close();
        layoutCache.clear();
        baseGraphCache = null;
        return res.json({ success: true, pruned });
      }
      if (!entityId || !layer) {
        await storage.close();
        return res.status(400).json({ error: "entityId and layer are required" });
      }
      await storage.deleteEntityOverlay({
        repositoryId: repo.id,
        entityId,
        layer,
        source,
        environment,
      });
      await storage.close();
      layoutCache.clear();
      baseGraphCache = null;
      return res.json({ success: true });
    } catch (e) {
      console.error("Error deleting overlay:", e);
      return res.status(500).json({ error: "Failed to delete entity overlay" });
    }
  });

  // Speed 2 Background Port Valve Verification (`[PAT-VIS-14]`, `[PAT-DB-03]`)
  let portHydrationInFlight: Promise<HydratePortValvesResult | null> | null = null;
  let portHydrationQueued = false;
  let portHydrationForceQueued = false;

  const scheduleBackgroundPortHydration = (
    force = false,
  ): Promise<HydratePortValvesResult | null> => {
    if (portHydrationInFlight) {
      portHydrationQueued = true;
      portHydrationForceQueued = portHydrationForceQueued || force;
      return portHydrationInFlight;
    }

    portHydrationInFlight = (async () => {
      try {
        const { target: activeTarget, dbPath: activeDbPath } = getActiveUiTarget();
        if (!existsSync(activeDbPath)) return null;
        const storage = createSQLiteStorage(activeDbPath);
        try {
          const repos = await storage.listRepositories();
          if (repos.length === 0) return null;
          const repo = repos[0];
          const graph = await storage.getRepresentationGraph(repo.id);
          if (!graph) return null;
          const result = await hydrateRepositoryPortValves({
            repoPath: repo.path || activeTarget,
            repoId: repo.id,
            storage,
            graph,
            force,
          });
          return result;
        } finally {
          await storage.close();
        }
      } catch {
        // Non-fatal: syntactic Layer 0 port schemas remain available
        return null;
      }
    })().then(async (result) => {
      if (result && (result.hydratedCount > 0 || result.prunedCount > 0)) {
        invalidateAllServerCaches();
      }
      portHydrationInFlight = null;
      if (portHydrationQueued) {
        const nextForce = portHydrationForceQueued;
        portHydrationQueued = false;
        portHydrationForceQueued = false;
        return scheduleBackgroundPortHydration(nextForce);
      }
      return result;
    });

    return portHydrationInFlight;
  };

  app.post("/api/ports/verify", async (req, res) => {
    try {
      const force = Boolean(req.body?.force);
      const result = await scheduleBackgroundPortHydration(force);
      if (!result) {
        return res.status(404).json({ error: "No repository graph available to verify ports." });
      }
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to verify port valves" });
    }
  });

  // 4. Fallback for React Router / SPA (or redirect to hosted UI in published NPM mode)
  app.use((_req, res) => {
    if (localWebDir) {
      return res.sendFile(join(localWebDir, "index.html"));
    }
    return res.redirect(302, url);
  });

  const printServerBannerAndShortcuts = () => {
    const { target: activeTarget, dbPath: activeDbPath } = getActiveUiTarget();
    console.log(
      `\n  ${ansi.green("●")} ${ansi.bold("Chomp Visualizer")} running at ${ansi.yellowBold(url)}`,
    );
    if (rawHostedUi) {
      console.log(
        `  ${ansi.dim("Local Daemon:")} ${localDaemonUrl}`,
      );
    }
    console.log(
      `  ${ansi.dim("Workspace:")} ${activeTarget}  ${ansi.dim("·")}  ${ansi.dim("DB:")} ${activeDbPath}`,
    );
    if (options.watch) {
      console.log(
        `  ${ansi.cyan("👀")} Watching source files for structural changes...`,
      );
    }
    if (process.stdin.isTTY) {
      console.log(
        `\n  ${ansi.dim("Shortcuts:")}  ${ansi.bold("[o]")} open browser   ${ansi.bold("[a]")} re-analyze graph   ${ansi.bold("[d]")} diff working tree`,
      );
      console.log(
        `              ${ansi.bold("[h]")} health check   ${ansi.bold("[c]")} clear console      ${ansi.bold("[q]")} quit\n`,
      );
    } else {
      console.log("");
    }
  };

  const server = app.listen(port, host, () => {
    try {
      const { dbPath: activeDbPath } = getActiveUiTarget();
      const serverMetaPath = join(dirname(activeDbPath), "ui_server.json");
      writeFileSync(
        serverMetaPath,
        JSON.stringify(
          {
            url,
            port: Number(port),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf-8",
      );
    } catch {
      // Non-fatal if .chomp directory is read-only
    }
    printServerBannerAndShortcuts();
    if (options.open) {
      openBrowserUrl(url);
    }
    // Note: Speed-2 port hydration is deferred until AFTER the first `/api/layout` response
    // completes (`triggerInitialPortHydrationAfterLayout`) so cold boots render in <2s (`W2.0f`).
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Optional --watch mode: re-analyze automatically on source file changes (debounced)
  let watchDebounce: ReturnType<typeof setTimeout> | null = null;
  if (options.watch) {
    try {
      watch(
        resolvedTarget,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          const normalized = filename.replace(/\\/g, "/");
          if (
            normalized.startsWith(".git/") ||
            normalized.startsWith(".chomp/") ||
            normalized.includes("node_modules/") ||
            normalized.includes("/dist/") ||
            normalized.includes("/.next/") ||
            normalized.includes("/out/")
          ) {
            return;
          }
          if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(normalized)) {
            return;
          }
          if (watchDebounce) clearTimeout(watchDebounce);
          watchDebounce = setTimeout(async () => {
            const { target: activeTarget } = getActiveUiTarget();
            console.log(
              `  ${ansi.cyan("↻")} File changed (${normalized}) — re-chomping graph...`,
            );
            await runAnalyze(activeTarget, {
              db: options.db,
              quiet: true,
            });
            invalidateAllServerCaches();
            setImmediate(() => {
              void scheduleBackgroundPortHydration(false);
            });
            console.log(
              `  ${ansi.green("✓")} Graph updated for ${ansi.yellowBold(url)}`,
            );
          }, 450);
        },
      );
    } catch {
      // Recursive fs.watch may not be supported on all platforms
    }
  }

  // Interactive Hotkey Loop while server is running
  if (
    process.stdin.isTTY &&
    typeof process.stdin.setRawMode === "function"
  ) {
    let busy = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const shutdown = () => {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
      process.stdin.pause();
      console.log(`\n  ${ansi.dim("Shutting down Chomp Visualizer...")}`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 300);
    };

    process.stdin.on("data", async (key: string) => {
      if (key === "\u0003" || key === "q" || key === "Q") {
        shutdown();
        return;
      }
      if (busy) return;
      const lower = key.toLowerCase();
      const { target: activeTarget } = getActiveUiTarget();
      if (lower === "o") {
        console.log(`  ${ansi.yellowBold("↗")} Opening ${url} in browser...`);
        openBrowserUrl(url);
      } else if (lower === "a") {
        busy = true;
        try {
          await runAnalyze(activeTarget, { db: options.db });
          invalidateAllServerCaches();
          setImmediate(() => {
            void scheduleBackgroundPortHydration(false);
          });
        } finally {
          busy = false;
        }
      } else if (lower === "d") {
        busy = true;
        try {
          runDiffCheck(activeTarget);
        } finally {
          busy = false;
        }
      } else if (lower === "h") {
        busy = true;
        try {
          runHealthCheck(activeTarget);
        } finally {
          busy = false;
        }
      } else if (lower === "c") {
        console.clear();
        printServerBannerAndShortcuts();
          } else if (lower === "?") {
            printServerBannerAndShortcuts();
          }
        });
      }
}

export function registerUiCommand(program: Command): void {
  program
    .command("ui [path]")
    .description(
      "Start the local Chomp server and open the Visualizer (defaults to active Master Tether or current directory)",
    )
    .option("-p, --port <number>", "Port to run the local server on", "5555")
    .option(
      "--db <path>",
      "Path to SQLite database file (default: <path>/.chomp/graph.db)",
    )
    .option("-o, --open", "Automatically open the Visualizer in your browser", false)
    .option(
      "-w, --watch",
      "Watch source files and automatically re-analyze on changes",
      false,
    )
    .option(
      "--debug",
      "Write matrix_debug.csv and layout_debug.csv debug artifacts",
      false,
    )
    .option(
      "--cloud-url <url>",
      "Stateless Cloudflare Layout Worker URL (or set CHOMP_LAYOUT_API_URL, e.g. https://api.getchomp.dev)",
    )
    .option(
      "--hosted-ui [url]",
      "Open the Cloudflare-hosted Visualizer (defaults to https://app.getchomp.dev?port=<port>)",
    )
    .option(
      "--remote",
      "Simulate published NPM cloud mode against https://api.getchomp.dev & https://app.getchomp.dev",
      false,
    )
    .action(
      async (
        inputPath: string | undefined,
        options: {
          port: string;
          db?: string;
          open?: boolean;
          watch?: boolean;
          debug?: boolean;
          cloudUrl?: string;
          hostedUi?: string | boolean;
          remote?: boolean;
        },
      ) => {
        const baseDir = process.env.INIT_CWD ?? process.cwd();
        const { targetPath } = resolveDefaultCliTarget(inputPath, baseDir, true);
        await startUiServer(targetPath, options);
      },
    );
}
