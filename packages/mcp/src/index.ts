import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createSQLiteStorage, type ChompStorage } from "@chomp/db";
import { basename, resolve, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import {
  CORE_EXTRACTOR_VERSION,
  SHIM_OVERLAY_LAYER,
  analyzeTarget,
  applyShimOverlaysToGraph,
  compareGraphs,
  type BaseStalenessReason,
  type GraphDelta,
  type RepresentationGraph,
} from "@chomp/core";
import {
  auditGraphHealth,
  buildActiveViewUrl,
  checkGraphBoundaries,
  computeBlastRadius,
  filterNodesForMcp,
  findGraphRedundancies,
  formatEnrichNodesSummary,
  hydrateNodeOverlays,
  resolveViewNodeIds,
  resolveViewTargetAltitude,
  type ActiveViewLevel,
  type ResolvedViewTargetAltitude,
} from "./intelligence.js";
import {
  PLUGINS_STATE_DIR_REL,
  PLUGIN_LAST_RUN_FILENAME,
  applyActivePluginProjections,
  buildOverlayEvidence,
  collectPluginRepoFiles,
  collectPluginStateFiles,
  computeFileOverlayHash,
  defineChompPlugin,
  discoverPluginsInDir,
  getChompPlugin,
  getPluginEnvStatus,
  getPluginLastRunPath,
  getPluginMcpToolSummaries,
  getPluginSettingsPath,
  getPluginStateDir,
  getPluginStateDirRel,
  getRegisteredPluginDefaultLayers,
  isPluginLayerEnabled,
  isRegisteredStructuralPluginOverlay,
  listChompPlugins,
  loadPluginSettings,
  readPluginLastRun,
  readRepoOverlayLayerToggles,
  registerChompPlugin,
  resolveActiveUiBaseUrl,
  resolvePluginSecret,
  resolveRepoGitBranch,
  resolveRepoName,
  runAllChompPlugins,
  runChompPlugin,
  savePluginSettings,
  unregisterChompPlugin,
  writePluginActiveView,
  writePluginLastRun,
  type ChompCliAnsiHelpers,
  type ChompPlugin,
  type ChompPluginContext,
  type ChompPluginExtractResult,
  type ChompPluginMcpTool,
  type ChompPluginMcpToolResult,
  type ChompPluginProjectionContext,
  type ChompPluginProjectionOverlayLike,
  type ChompPluginToolContext,
  type PersistedPluginRunRecord,
  type PluginActiveViewRequest,
  type RunAllChompPluginsOptions,
  type RunChompPluginOptions,
  type RunChompPluginResult,
} from "./pluginRunner.js";
import "./plugins/index.js";
import { BUILTIN_PLUGINS_DIR, discoverBuiltInPlugins } from "./plugins/index.js";
import {
  analyzeRepositoryDesignSystem,
  auditDesignSystem,
  classifyTokenTier,
  computeRelativeLuminance,
  computeWcagContrastRatio,
  createDesignSystemPlugin,
  designSystemPlugin,
  diffDesignSystem,
  evaluateContrast,
  frontendPackageLabels,
  parseCssColorString,
  parseCssStylesheet,
  type AtomicConsolidationCandidate,
  type ComponentDesignProfile,
  type ContrastAuditItem,
  type CssTokenDeclaration,
  type DesignSystemAnalysisReport,
  type DesignSystemDiffResult,
  snapshotDesignSystemBaseline,
  type DuplicateTokenDiagnostic,
  type UndefinedTokenDiagnostic,
} from "./designSystemPlugin.js";
import {
  LEGACY_LOCAL_SHIMS_FILE_REL,
  LOCAL_SHIMS_FILE_REL,
  LOCAL_SHIMS_PLUGIN_NAME,
  deriveShimId,
  evaluateShimsAgainstGraph,
  loadLocalShimsFromTexts,
  localShimsPlugin,
  manageLocalShims,
  type LocalGraphShim,
  type LocalGraphShimInput,
  type LocalShimsAction,
  type LocalShimsManifest,
  type LocalTargetConnectorSpec,
  type ManageLocalShimsOptions,
  type ResolvedShimRecord,
  type SuggestedShimCandidate,
  type UnmatchedShimRecord,
} from "./shimsPlugin.js";
import {
  ENRICH_NODES_PLUGIN_NAME,
  SEMANTIC_OVERLAY_LAYER,
  enrichNodesPlugin,
} from "./enrichNodesPlugin.js";
import {
  getConventionsReference,
  type BuiltInFrameworkCatalog,
  type ConventionSignalKind,
  type ConventionsReferenceReport,
  type GetConventionsReferenceOptions,
  type ShapeKeyRemediationAdvice,
  type SignalRemediationPlaybookEntry,
  type UserConventionSetStatus,
} from "./conventionsReference.js";

export {
  auditGraphHealth,
  buildActiveViewUrl,
  checkGraphBoundaries,
  computeBlastRadius,
  filterNodesForMcp,
  findGraphRedundancies,
  formatEnrichNodesSummary,
  hydrateNodeOverlays,
  resolveViewNodeIds,
  resolveViewTargetAltitude,
  type ActiveViewLevel,
  type ResolvedViewTargetAltitude,
} from "./intelligence.js";

export {
  PLUGINS_STATE_DIR_REL,
  PLUGIN_LAST_RUN_FILENAME,
  applyActivePluginProjections,
  buildOverlayEvidence,
  collectPluginRepoFiles,
  collectPluginStateFiles,
  computeFileOverlayHash,
  defineChompPlugin,
  discoverPluginsInDir,
  getChompPlugin,
  getPluginEnvStatus,
  getPluginLastRunPath,
  getPluginMcpToolSummaries,
  getPluginSettingsPath,
  getPluginStateDir,
  getPluginStateDirRel,
  getRegisteredPluginDefaultLayers,
  isPluginLayerEnabled,
  isRegisteredStructuralPluginOverlay,
  listChompPlugins,
  loadPluginSettings,
  readPluginLastRun,
  readRepoOverlayLayerToggles,
  registerChompPlugin,
  resolveActiveUiBaseUrl,
  resolvePluginSecret,
  resolveRepoGitBranch,
  resolveRepoName,
  runAllChompPlugins,
  runChompPlugin,
  savePluginSettings,
  unregisterChompPlugin,
  writePluginActiveView,
  writePluginLastRun,
  type ChompCliAnsiHelpers,
  type ChompPlugin,
  type ChompPluginContext,
  type ChompPluginExtractResult,
  type ChompPluginMcpTool,
  type ChompPluginMcpToolResult,
  type ChompPluginProjectionContext,
  type ChompPluginProjectionOverlayLike,
  type ChompPluginToolContext,
  type PersistedPluginRunRecord,
  type PluginActiveViewRequest,
  type RunAllChompPluginsOptions,
  type RunChompPluginOptions,
  type RunChompPluginResult,
} from "./pluginRunner.js";

export { BUILTIN_PLUGINS_DIR, discoverBuiltInPlugins } from "./plugins/index.js";

export {
  analyzeRepositoryDesignSystem,
  auditDesignSystem,
  classifyTokenTier,
  computeRelativeLuminance,
  computeWcagContrastRatio,
  createDesignSystemPlugin,
  designSystemPlugin,
  diffDesignSystem,
  evaluateContrast,
  frontendPackageLabels,
  parseCssColorString,
  parseCssStylesheet,
  type AtomicConsolidationCandidate,
  type ComponentDesignProfile,
  type ContrastAuditItem,
  type CssTokenDeclaration,
  type DesignSystemAnalysisReport,
  type DesignSystemDiffResult,
  snapshotDesignSystemBaseline,
  type DuplicateTokenDiagnostic,
  type UndefinedTokenDiagnostic,
} from "./designSystemPlugin.js";

export {
  LEGACY_LOCAL_SHIMS_FILE_REL,
  LOCAL_SHIMS_FILE_REL,
  LOCAL_SHIMS_PLUGIN_NAME,
  deriveShimId,
  evaluateShimsAgainstGraph,
  loadLocalShimsFromTexts,
  localShimsPlugin,
  manageLocalShims,
  type LocalGraphShim,
  type LocalGraphShimInput,
  type LocalShimsAction,
  type LocalShimsManifest,
  type LocalTargetConnectorSpec,
  type ManageLocalShimsOptions,
  type ResolvedShimRecord,
  type SuggestedShimCandidate,
  type UnmatchedShimRecord,
} from "./shimsPlugin.js";

export {
  ENRICH_NODES_PLUGIN_NAME,
  SEMANTIC_OVERLAY_LAYER,
  enrichNodesPlugin,
} from "./enrichNodesPlugin.js";

export {
  getConventionsReference,
  type BuiltInFrameworkCatalog,
  type ConventionSignalKind,
  type ConventionsReferenceReport,
  type GetConventionsReferenceOptions,
  type ShapeKeyRemediationAdvice,
  type SignalRemediationPlaybookEntry,
  type UserConventionSetStatus,
} from "./conventionsReference.js";

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.GIT_CEILING_DIRECTORIES;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_PREFIX;
  return env;
}

export function resolveActiveMcpRepo(fallbackTargetPath: string = process.cwd()): {
  repoPath: string;
  repoName: string;
  repoId: string;
  dbPath: string;
} {
  let candidatePath = fallbackTargetPath;
  const masterRootEnv = process.env.CHOMP_MASTER_ROOT?.trim();
  const ctxPaths = Array.from(
    new Set([
      resolve(homedir(), ".chomp", "context.json"),
      resolve(fallbackTargetPath, ".chomp", "master_context.json"),
      ...(masterRootEnv
        ? [resolve(masterRootEnv, ".chomp", "master_context.json")]
        : []),
    ]),
  )
    .filter((p) => existsSync(p))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

  for (const ctxPath of ctxPaths) {
    try {
      const parsed = JSON.parse(readFileSync(ctxPath, "utf8"));
      if (
        parsed &&
        typeof parsed.activeRepoPath === "string" &&
        existsSync(parsed.activeRepoPath)
      ) {
        candidatePath = parsed.activeRepoPath;
        break;
      }
    } catch {
      // Fall back to next candidate or fallbackTargetPath
    }
  }

  let repoPath = candidatePath;
  try {
    const stat = statSync(candidatePath);
    const isDir = stat.isDirectory();
    const startDir = isDir ? candidatePath : dirname(candidatePath);
    if (
      existsSync(resolve(startDir, ".chomp")) ||
      existsSync(resolve(startDir, ".git")) ||
      startDir.includes("/fixtures/cloned-repos/") ||
      startDir.includes("/fixtures/test-repos/")
    ) {
      repoPath = startDir;
    } else {
      repoPath = execSync("git rev-parse --show-toplevel", {
        cwd: startDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: cleanGitEnv(),
      }).trim();
    }
  } catch {
    try {
      const stat = statSync(candidatePath);
      repoPath = stat.isDirectory() ? candidatePath : dirname(candidatePath);
    } catch {
      repoPath = candidatePath;
    }
  }

  const repoName = resolveRepoName(repoPath);
  const repoId = repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const dbPath = resolve(repoPath, ".chomp", "graph.db");
  return { repoPath, repoName, repoId, dbPath };
}

interface CachedGraphEntry {
  mtimeMs: number;
  graph: RepresentationGraph;
}

const mcpGraphCache = new Map<string, CachedGraphEntry>();

function getDbMtimeMs(dbPath: string): number {
  try {
    const mainMtime = statSync(dbPath).mtimeMs;
    const walPath = `${dbPath}-wal`;
    const walMtime = existsSync(walPath) ? statSync(walPath).mtimeMs : 0;
    return Math.max(mainMtime, walMtime);
  } catch {
    return -1;
  }
}

/**
 * Executes an async callback against a `ChompStorage` instance and guarantees
 * `await storage.close()` in a `finally` block even when `fn` throws.
 */
export async function withStorage<T>(
  dbPath: string,
  fn: (storage: ChompStorage) => Promise<T>,
  storageFactory: (dbPath: string) => ChompStorage = createSQLiteStorage
): Promise<T> {
  const storage = storageFactory(dbPath);
  try {
    return await fn(storage);
  } finally {
    await storage.close();
  }
}

/**
 * Invalidates the in-memory MCP `RepresentationGraph` cache (either for a
 * specific `dbPath` or across all cached repositories).
 */
export function invalidateMcpGraphCache(dbPath?: string): void {
  if (!dbPath) {
    mcpGraphCache.clear();
    return;
  }
  const resolved = resolve(dbPath);
  for (const key of mcpGraphCache.keys()) {
    if (key.startsWith(`${resolved}::`)) {
      mcpGraphCache.delete(key);
    }
  }
}

/**
 * Loads `RepresentationGraph` for `(dbPath, repoId)` with an in-memory cache
 * invalidated whenever `dbPath` (or `${dbPath}-wal`) mtime changes.
 */
export async function loadActiveGraphCached(
  dbPath: string,
  repoId: string,
  storageFactory: (dbPath: string) => ChompStorage = createSQLiteStorage
): Promise<RepresentationGraph | null> {
  const resolvedDbPath = resolve(dbPath);
  const cacheKey = `${resolvedDbPath}::${repoId}`;
  const currentMtime = getDbMtimeMs(resolvedDbPath);
  const cached = mcpGraphCache.get(cacheKey);
  if (cached && currentMtime > 0 && cached.mtimeMs === currentMtime) {
    return cached.graph;
  }

  const graph = await withStorage(
    resolvedDbPath,
    async (storage) => {
      const direct = await storage.getRepresentationGraph(repoId);
      if (direct) return direct;
      const repos = await storage.listRepositories();
      return repos[0] ? storage.getRepresentationGraph(repos[0].id) : null;
    },
    storageFactory
  );
  if (graph && currentMtime > 0) {
    mcpGraphCache.set(cacheKey, {
      mtimeMs: currentMtime,
      graph,
    });
  } else {
    mcpGraphCache.delete(cacheKey);
  }
  return graph;
}

/**
 * Checks `.chomp/rules.json` to see whether the `L1_SHIMS` plugin overlay layer is enabled
 * (defaults to `true` when unset or when `.chomp/rules.json` does not exist).
 */
export function isShimLayerEnabled(repoPath: string): boolean {
  try {
    const rulesPath = resolve(repoPath, ".chomp", "rules.json");
    if (!existsSync(rulesPath)) return true;
    const parsed = JSON.parse(readFileSync(rulesPath, "utf8"));
    return parsed?.overlayLayers?.[SHIM_OVERLAY_LAYER] !== false;
  } catch {
    return true;
  }
}

/**
 * Pure helper that evaluates `.chomp/shims.json` and `chomp.config.json#shims` text against a
 * Layer 0 `RepresentationGraph` and projects matched `L1_SHIMS` edges/connectors in memory.
 */
export function projectGraphWithShimTexts(
  graph: RepresentationGraph,
  shimsJsonText: string | null,
  chompConfigText: string | null
): RepresentationGraph {
  const { shims } = loadLocalShimsFromTexts(shimsJsonText, chompConfigText);
  if (shims.length === 0) return graph;
  const { resolved } = evaluateShimsAgainstGraph(graph, shims);
  if (resolved.length === 0) return graph;
  const provisionalOverlays = resolved.map((r) => ({
    entityId: r.sourceNode.id,
    layer: SHIM_OVERLAY_LAYER,
    payload: {
      shimmedEdges: [r.edgeEntry],
      ...(r.syntheticConnector ? { syntheticConnectors: [r.syntheticConnector] } : {}),
    },
  }));
  return applyShimOverlaysToGraph(graph, provisionalOverlays, { enabled: true });
}

/**
 * Loads the persisted `RepresentationGraph` for `(dbPath, repoId)` and runs every enabled
 * registered plugin's `projectGraph` hook (e.g. `local-shims` `L1_SHIMS` overlays and `.chomp/plugins/<name>/` files).
 */
export async function loadActiveGraphWithShims(
  repoPath: string,
  dbPath: string,
  repoId: string,
  storageFactory: (dbPath: string) => ChompStorage = createSQLiteStorage
): Promise<RepresentationGraph | null> {
  const baseGraph = await loadActiveGraphCached(dbPath, repoId, storageFactory);
  if (!baseGraph) return null;

  const projectingLayers = listChompPlugins()
    .filter((p) => Boolean(p.projectGraph))
    .map((p) => p.layer);
  const overlays =
    projectingLayers.length > 0
      ? await withStorage(
          resolve(dbPath),
          (storage) => storage.getEntityOverlays(repoId, { layers: projectingLayers }),
          storageFactory
        )
      : [];

  return applyActivePluginProjections(baseGraph, {
    repoPath,
    overlays,
  });
}

const MCP_THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MONOREPO_CORE_ROOT = resolve(MCP_THIS_DIR, "../../core");

function collectCoreFilesSorted(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      collectCoreFilesSorted(abs, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
  return out;
}

function computeCoreSourceFingerprint(): string | null {
  try {
    const coreEntry = resolve(MONOREPO_CORE_ROOT, "src/index.ts");
    if (!existsSync(coreEntry)) return null;
    const files = [
      resolve(MONOREPO_CORE_ROOT, "package.json"),
      resolve(MONOREPO_CORE_ROOT, "src/version.ts"),
      resolve(MONOREPO_CORE_ROOT, "src/utils/id.ts"),
      ...collectCoreFilesSorted(resolve(MONOREPO_CORE_ROOT, "src/differ")),
      ...collectCoreFilesSorted(resolve(MONOREPO_CORE_ROOT, "src/extractor")),
    ]
      .filter((f) => existsSync(f))
      .sort();
    return files
      .map((f) => {
        const s = statSync(f);
        return `${relative(MONOREPO_CORE_ROOT, f)}:${s.mtimeMs}:${s.size}`;
      })
      .join("|");
  } catch {
    return null;
  }
}

const STARTUP_CORE_FINGERPRINT = computeCoreSourceFingerprint();

function findTsxBinary(): string | null {
  const monoRoot = resolve(MCP_THIS_DIR, "../../..");
  const candidates = [
    resolve(monoRoot, "packages/mcp/node_modules/.bin/tsx"),
    resolve(monoRoot, "packages/db/node_modules/.bin/tsx"),
    resolve(monoRoot, "packages/cli/node_modules/.bin/tsx"),
    resolve(monoRoot, "node_modules/.bin/tsx"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function loadRepoExcludeWorkspaces(repoPath: string): string[] {
  try {
    const cfgPath = resolve(repoPath, "chomp.config.json");
    if (!existsSync(cfgPath)) return [];
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    return Array.isArray(parsed?.excludeWorkspaces)
      ? parsed.excludeWorkspaces.filter((x: unknown): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function extractLiveUserGraph(
  repoPath: string,
  headCommitSha: string | undefined,
  excludeWorkspaces: string[],
): RepresentationGraph {
  const currentFp = computeCoreSourceFingerprint();
  if (
    STARTUP_CORE_FINGERPRINT !== null &&
    currentFp !== null &&
    currentFp !== STARTUP_CORE_FINGERPRINT
  ) {
    const tsxBin = findTsxBinary();
    const coreEntry = resolve(MONOREPO_CORE_ROOT, "src/index.ts");
    if (tsxBin && existsSync(coreEntry)) {
      try {
        const childScript = `
          import { pathToFileURL } from "node:url";
          const [entryPath, targetRepo, commitArg, exclJson] = process.argv.slice(1);
          const mod = await import(pathToFileURL(entryPath).href);
          const g = mod.analyzeTarget(targetRepo, mod.CORE_EXTRACTOR_VERSION, commitArg || undefined, JSON.parse(exclJson));
          process.stdout.write(JSON.stringify({
            ...g,
            nodes: g.nodes.filter((n) => (n.scope ?? "USER") === "USER"),
            edges: g.edges.filter((e) => (e.scope ?? "USER") === "USER"),
          }));
        `;
        const stdout = execFileSync(
          tsxBin,
          ["-e", childScript, coreEntry, repoPath, headCommitSha ?? "", JSON.stringify(excludeWorkspaces)],
          {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        return JSON.parse(stdout) as RepresentationGraph;
      } catch {
        // Fall through to in-process extractor
      }
    }
  }

  const raw = analyzeTarget(
    repoPath,
    CORE_EXTRACTOR_VERSION,
    headCommitSha,
    excludeWorkspaces,
  );
  return {
    ...raw,
    nodes: raw.nodes.filter((n) => (n.scope ?? "USER") === "USER"),
    edges: raw.edges.filter((e) => (e.scope ?? "USER") === "USER"),
  };
}

function readGitBlobAtCommit(repoPath: string, commitSha: string, relPath: string): string | null {
  try {
    return execFileSync("git", ["-C", repoPath, "show", `${commitSha}:${relPath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: cleanGitEnv(),
    });
  } catch {
    return null;
  }
}

function hasGitCommit(repoPath: string, commitSha: string | undefined): commitSha is string {
  if (!existsSync(resolve(repoPath, ".git"))) return false;
  if (!commitSha || !/^[0-9a-f]{7,40}$/i.test(commitSha.trim())) return false;
  try {
    execFileSync("git", ["-C", repoPath, "cat-file", "-e", `${commitSha.trim()}^{commit}`], {
      stdio: ["ignore", "ignore", "ignore"],
      env: cleanGitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

function readGitHeadState(repoPath: string): {
  headCommitSha?: string;
  headCommitEpochMs?: number;
} {
  if (!existsSync(resolve(repoPath, ".git"))) return {};
  const env = cleanGitEnv();
  try {
    const headCommitSha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();
    if (!headCommitSha) return {};
    let headCommitEpochMs: number | undefined;
    try {
      const ctRaw = execFileSync("git", ["-C", repoPath, "show", "-s", "--format=%ct", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env,
      }).trim();
      const secs = Number(ctRaw);
      if (Number.isFinite(secs) && secs > 0) {
        headCommitEpochMs = secs * 1000;
      }
    } catch {
      // Ignore timestamp lookup error
    }
    return { headCommitSha, headCommitEpochMs };
  } catch {
    return {};
  }
}

interface BaseSnapshotRecord {
  commitSha?: string | null;
  analyzedAt?: string;
  extractorVersion?: string;
  workingTreeDirty?: boolean;
  dirtyFiles?: string[];
}

function readBaseSnapshotIfMatching(
  dbPath: string,
  baseRaw: RepresentationGraph,
): BaseSnapshotRecord | null {
  try {
    const snapPath = resolve(dirname(dbPath), "base_snapshot.json");
    if (!existsSync(snapPath)) return null;
    const parsed = JSON.parse(readFileSync(snapPath, "utf8")) as BaseSnapshotRecord;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.analyzedAt && baseRaw.analyzedAt && parsed.analyzedAt !== baseRaw.analyzedAt) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Computes structural delta between the saved base graph (projected with baseline plugin files at
 * `baseGraph.commitSha` when available) and the live working tree (`analyzeTarget` + active plugin projections).
 * Checks staleness (`[PAT-DB-03]`, Principle of Incomplete Truth) before reporting a delta.
 */
export async function computeGraphDeltaWithShims(
  repoPath: string,
  dbPath: string,
  repoId: string,
  storageFactory: (dbPath: string) => ChompStorage = createSQLiteStorage
): Promise<GraphDelta> {
  const baseRaw = await loadActiveGraphCached(dbPath, repoId, storageFactory);
  if (!baseRaw) {
    throw new Error(
      `Base graph data for repository '${repoId}' not found in the database. Please run 'chomp analyze .' first.`
    );
  }

  const { headCommitSha, headCommitEpochMs } = readGitHeadState(repoPath);
  const excludeWorkspaces = loadRepoExcludeWorkspaces(repoPath);
  const currentRaw = extractLiveUserGraph(repoPath, headCommitSha, excludeWorkspaces);
  const baseSnapshot = readBaseSnapshotIfMatching(dbPath, baseRaw);

  const stalenessReasons: BaseStalenessReason[] = [];
  if (
    baseRaw.extractorVersion &&
    currentRaw.extractorVersion &&
    baseRaw.extractorVersion !== currentRaw.extractorVersion
  ) {
    stalenessReasons.push({
      code: "EXTRACTOR_VERSION_MISMATCH",
      message: `Base graph was extracted with version '${baseRaw.extractorVersion}', while live extractor is '${currentRaw.extractorVersion}'.`,
    });
  }
  if (headCommitSha && baseRaw.commitSha) {
    const baseSha = baseRaw.commitSha.trim();
    if (!headCommitSha.startsWith(baseSha) && !baseSha.startsWith(headCommitSha)) {
      stalenessReasons.push({
        code: "BASE_COMMIT_BEHIND_HEAD",
        message: `Base graph was analyzed at commit ${baseSha.slice(0, 7)}, which does not match HEAD ${headCommitSha.slice(0, 7)}.`,
      });
    }
  } else if (!baseRaw.commitSha && headCommitEpochMs && baseRaw.analyzedAt) {
    const analyzedMs = Date.parse(baseRaw.analyzedAt);
    if (Number.isFinite(analyzedMs) && analyzedMs + 1000 < headCommitEpochMs) {
      stalenessReasons.push({
        code: "ANALYZED_BEFORE_HEAD",
        message: `Base graph analyzedAt (${baseRaw.analyzedAt}) precedes HEAD commit timestamp.`,
      });
    }
  }
  if (baseSnapshot?.workingTreeDirty === true) {
    stalenessReasons.push({
      code: "DIRTY_BASE_SNAPSHOT",
      message: `Base graph was captured while the working tree had uncommitted changes${
        baseSnapshot.dirtyFiles?.length
          ? ` (${baseSnapshot.dirtyFiles.slice(0, 5).join(", ")})`
          : ""
      }.`,
    });
  }

  if (stalenessReasons.length > 0) {
    return {
      baseCommitSha: baseRaw.commitSha,
      targetCommitSha: headCommitSha,
      headCommitSha,
      baseExtractorVersion: baseRaw.extractorVersion,
      targetExtractorVersion: currentRaw.extractorVersion,
      baseStatus: "STALE",
      stalenessReasons,
      nodes: {},
      edges: {},
    };
  }

  const overlayLayers = readRepoOverlayLayerToggles(repoPath);

  const baseProjected = hasGitCommit(repoPath, baseRaw.commitSha)
    ? applyActivePluginProjections(baseRaw, {
        repoPath,
        overlayLayers,
        readRepoFileOverride: (rel) => readGitBlobAtCommit(repoPath, baseRaw.commitSha!.trim(), rel),
      })
    : baseRaw;

  const currentProjected = applyActivePluginProjections(currentRaw, {
    repoPath,
    overlayLayers,
  });

  const delta = compareGraphs(baseProjected, currentProjected);
  return {
    ...delta,
    headCommitSha,
    baseExtractorVersion: baseRaw.extractorVersion,
    targetExtractorVersion: currentRaw.extractorVersion,
    baseStatus: "FRESH",
  };
}

/**
 * Wraps an MCP tool handler so uncaught errors return a structured
 * `{ isError: true, content: [{ type: "text", text }] }` payload rather than
 * crashing the stdio transport or leaking resources.
 */
export function withMcpToolErrorBoundary<A>(
  handler: (args: A) => Promise<any>
): (args: A) => Promise<any> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err ?? "Unknown MCP tool error");
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  };
}

export async function runMcpServer(targetPath: string = process.cwd()) {
  const initialRepo = resolveActiveMcpRepo(targetPath);
  const repoLocalPluginsDir = resolve(initialRepo.repoPath, ".chomp", "plugins");
  if (existsSync(repoLocalPluginsDir)) {
    await discoverPluginsInDir(repoLocalPluginsDir);
  }

  const server = new McpServer({
    name: "chomp-mcp-server",
    version: "0.1.0",
  });

  server.tool(
    "chomp_get_nodes",
    "MANDATORY FIRST STEP (MAP-FIRST NAVIGATION): Retrieves structural nodes from the persisted Chomp graph. Pass `search_term` and/or `packageName` BEFORE reading any files to resolve the exact node IDs of target Services, Routes, Components, and Functions. Only follow up with `chomp_create_view` when the user is asking an architectural question, querying how a flow works, or explicitly requesting a visual highlight/walkthrough (do NOT invoke `chomp_create_view` on routine coding or implementation prompts). Files and directories are not graph nodes (Ontology v4.0): each node's source file and line live in its evidence records, and BOUNDARY nodes are only DEPLOYMENT_UNIT, CLASS, NAMESPACE or INIT_BLOCK.",
    {
      search_term: z.string().optional().describe("Fast-path case-insensitive search term matching node name, id, humanLabel, domain, summary, or evidence filePath (use this to quickly resolve target node IDs)"),
      searchTerm: z.string().optional().describe("Alias for search_term (camelCase)"),
      packageName: z.string().optional().describe("Optional filter by owning package / DEPLOYMENT_UNIT name (e.g., 'mcp', '@chomp/mcp', 'core', 'web', 'cli', 'db')"),
      package_name: z.string().optional().describe("Alias for packageName (snake_case)"),
      type: z.string().optional().describe("Optional filter by node type (e.g., BOUNDARY, CONTRACT, OPEN_CONNECTOR)"),
      entityType: z.string().optional().describe("Optional filter by entity type (e.g., DEPLOYMENT_UNIT, CLASS, NAMESPACE, INIT_BLOCK, EXPORTED_FUNCTION, PUBLIC_METHOD, EXPORTED_MODULE, HTTP_ENDPOINT, MIDDLEWARE, EXTERNAL_PACKAGE)"),
      entity_type: z.string().optional().describe("Alias for entityType (snake_case)"),
      parent_boundary_id: z.string().optional().describe("Optional filter by parent boundary ID (the owning DEPLOYMENT_UNIT, CLASS, or NAMESPACE node ID — never a file)"),
      parentBoundaryId: z.string().optional().describe("Alias for parent_boundary_id (camelCase)"),
      name: z.string().optional().describe("Optional case-insensitive substring filter on node name (e.g., 'visitContract', 'SQLiteStorage', '/api/layout')"),
      file_path: z.string().optional().describe("Optional case-insensitive substring filter on the node's evidence filePath (e.g., 'contractVisitor.ts', 'packages/core')"),
      filePath: z.string().optional().describe("Alias for file_path (camelCase)"),
      include_overlays: z.boolean().optional().describe("When true, attaches entity_overlays records onto each returned node. Defaults to false unless layers/layer is specified, keeping structural queries compact."),
      includeOverlays: z.boolean().optional().describe("Alias for include_overlays (camelCase)"),
      layers: z.array(z.string()).optional().describe("Optional list of overlay layers to hydrate on returned nodes (e.g. ['L1_SEMANTIC', 'L1_DESIGN_SYSTEM']). Implicitly enables overlay hydration for those layers."),
      layer: z.string().optional().describe("Optional single overlay layer to hydrate on returned nodes")
    },
    withMcpToolErrorBoundary(async (args) => {
      const { repoPath, repoId, dbPath } = resolveActiveMcpRepo(targetPath);
      if (!existsSync(dbPath)) {
        throw new Error(`Chomp database not found at ${dbPath}. Please ask the user to run 'chomp analyze .' in the repository root first.`);
      }

      const requestedLayers = [
        ...(args.layers ?? []),
        ...(args.layer ? [args.layer] : []),
      ]
        .map((l) => l.trim())
        .filter(Boolean);
      const includeOverlays =
        args.include_overlays ?? args.includeOverlays ?? (requestedLayers.length > 0);
      const searchTerm = args.search_term ?? args.searchTerm;

      const graph = await loadActiveGraphWithShims(repoPath, dbPath, repoId);
      const overlays =
        includeOverlays || Boolean(searchTerm)
          ? await withStorage(dbPath, (storage) =>
              storage.getEntityOverlays(
                repoId,
                requestedLayers.length > 0 && !searchTerm
                  ? { layers: requestedLayers }
                  : undefined
              )
            )
          : [];

      if (!graph) {
        throw new Error(`Graph data for repository '${repoId}' not found in the database. Please run 'chomp analyze .' first.`);
      }

      const overlaysByEntityId = new Map<string, any[]>();
      for (const ov of overlays) {
        let list = overlaysByEntityId.get(ov.entityId);
        if (!list) {
          list = [];
          overlaysByEntityId.set(ov.entityId, list);
        }
        list.push(ov);
      }

      const matchedNodes = filterNodesForMcp(graph, {
        type: args.type,
        entityType: args.entityType ?? args.entity_type,
        parentBoundaryId: args.parent_boundary_id ?? args.parentBoundaryId,
        name: args.name,
        filePath: args.file_path ?? args.filePath,
        searchTerm,
        packageName: args.packageName ?? args.package_name,
        overlaysByEntityId,
      });

      const filteredNodes = hydrateNodeOverlays(matchedNodes, overlays, {
        includeOverlays,
        layers: requestedLayers,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(filteredNodes, null, 2) }]
      };
    })
  );

  server.tool(
    "chomp_get_edges",
    "Use this tool to trace execution paths. If you need to know what a function calls, or what calls a function, pass the node ID here instead of using global text search. Under Ontology v4.0 edges originate from contracts, classes, public methods, or INIT_BLOCKs (top-level code run on module load) — never from files or DEPLOYMENT_UNITs — and calls into imported packages target `Package: X` OPEN_CONNECTORs.",
    {
      source_id: z.string().optional().describe("Optional filter by the source node ID"),
      sourceId: z.string().optional().describe("Alias for source_id (camelCase)"),
      target_id: z.string().optional().describe("Optional filter by the target node ID"),
      targetId: z.string().optional().describe("Alias for target_id (camelCase)"),
      name: z.string().optional().describe("Optional case-insensitive substring filter on the edge name (e.g., 'visitContract', 'INTERCEPTS', 'db.prepare')"),
      resolved_only: z.boolean().optional().describe("When true, returns only edges with a resolved targetId, suppressing unresolved LOW-confidence platform method calls"),
      resolvedOnly: z.boolean().optional().describe("Alias for resolved_only (camelCase)"),
      min_confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().describe("Optional minimum confidence threshold (LOW, MEDIUM, or HIGH). DETERMINISTIC edges always count as HIGH."),
      minConfidence: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().describe("Alias for min_confidence (camelCase)")
    },
    withMcpToolErrorBoundary(async (args) => {
      const { repoPath, repoId, dbPath } = resolveActiveMcpRepo(targetPath);
      if (!existsSync(dbPath)) {
        throw new Error(`Chomp database not found at ${dbPath}. Please ask the user to run 'chomp analyze .' in the repository root first.`);
      }

      const graph = await loadActiveGraphWithShims(repoPath, dbPath, repoId);

      if (!graph) {
        throw new Error(`Graph data for repository '${repoId}' not found in the database. Please run 'chomp analyze .' first.`);
      }

      const sourceFilter = args.source_id ?? args.sourceId;
      const targetFilter = args.target_id ?? args.targetId;
      const nameFilter = args.name?.toLowerCase();
      const resolvedOnly = args.resolved_only ?? args.resolvedOnly;
      const minConfidence = args.min_confidence ?? args.minConfidence;

      const confidenceRank: Record<string, number> = {
        LOW: 1,
        MEDIUM: 2,
        HIGH: 3,
      };

      let filteredEdges = graph.edges;
      if (sourceFilter) {
        filteredEdges = filteredEdges.filter((e: any) => e.sourceId === sourceFilter);
      }
      if (targetFilter) {
        filteredEdges = filteredEdges.filter((e: any) => e.targetId === targetFilter);
      }
      if (nameFilter) {
        filteredEdges = filteredEdges.filter((e: any) =>
          typeof e.name === "string" && e.name.toLowerCase().includes(nameFilter)
        );
      }
      if (resolvedOnly) {
        filteredEdges = filteredEdges.filter((e: any) => Boolean(e.targetId));
      }
      if (minConfidence) {
        const minRank = confidenceRank[minConfidence] ?? 1;
        filteredEdges = filteredEdges.filter((e: any) => {
          const edgeRank =
            e.entityType === "DETERMINISTIC" || e.confidence === "HIGH"
              ? 3
              : e.confidence === "MEDIUM"
              ? 2
              : 1;
          return edgeRank >= minRank;
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify(filteredEdges, null, 2) }]
      };
    })
  );

  server.tool(
    "chomp_get_diff",
    "Compares the dirty working directory tree against the last saved graph in the Chomp SQLite database (base). Returns a structural delta summary and the ADDED, REMOVED, and MODIFIED entities (excluding UNCHANGED and LEXICAL_SHIFT noise by default).",
    {
      include_lexical_shift: z.boolean().optional().describe("When true, includes LEXICAL_SHIFT entries (line-number-only shifts) in nodes/edges"),
      includeLexicalShift: z.boolean().optional().describe("Alias for include_lexical_shift (camelCase)"),
      include_unchanged: z.boolean().optional().describe("When true, includes UNCHANGED entries in nodes/edges"),
      includeUnchanged: z.boolean().optional().describe("Alias for include_unchanged (camelCase)")
    },
    withMcpToolErrorBoundary(async (args) => {
      const { repoPath, repoId, dbPath } = resolveActiveMcpRepo(targetPath);
      if (!existsSync(dbPath)) {
        throw new Error(`Chomp database not found at ${dbPath}. Please ask the user to run 'chomp analyze .' in the repository root first to establish a base graph.`);
      }

      const delta = await computeGraphDeltaWithShims(repoPath, dbPath, repoId);

      if (delta.baseStatus === "STALE") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "STALE_BASE_UNKNOWN",
                  baseStatus: "STALE",
                  stale: true,
                  baseCommitSha: delta.baseCommitSha,
                  headCommitSha: delta.headCommitSha,
                  baseExtractorVersion: delta.baseExtractorVersion,
                  targetExtractorVersion: delta.targetExtractorVersion,
                  stalenessReasons: delta.stalenessReasons ?? [],
                  remediation:
                    "Base graph in .chomp/graph.db is stale or was captured from a dirty working tree. Run 'chomp analyze .' on a clean HEAD to refresh the baseline (or run 'chomp diff' to compare the working tree directly against committed HEAD).",
                  summary: null,
                  nodes: {},
                  edges: {},
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const includeLexical = Boolean(args?.include_lexical_shift ?? args?.includeLexicalShift);
      const includeUnchanged = Boolean(args?.include_unchanged ?? args?.includeUnchanged);

      const countStatuses = (record: Record<string, { status: string }>) => {
        const counts = { ADDED: 0, MODIFIED: 0, REMOVED: 0, LEXICAL_SHIFT: 0, UNCHANGED: 0 };
        for (const entry of Object.values(record)) {
          if (entry.status in counts) {
            counts[entry.status as keyof typeof counts]++;
          }
        }
        return counts;
      };

      const filterEntries = <T extends { status: string }>(record: Record<string, T>): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const [id, entry] of Object.entries(record)) {
          if (entry.status === "UNCHANGED" && !includeUnchanged) continue;
          if (entry.status === "LEXICAL_SHIFT" && !includeLexical) continue;
          out[id] = entry;
        }
        return out;
      };

      const compactDelta = {
        baseStatus: delta.baseStatus ?? "FRESH",
        baseCommitSha: delta.baseCommitSha,
        targetCommitSha: delta.targetCommitSha,
        headCommitSha: delta.headCommitSha,
        baseExtractorVersion: delta.baseExtractorVersion,
        targetExtractorVersion: delta.targetExtractorVersion,
        summary: {
          nodes: countStatuses(delta.nodes),
          edges: countStatuses(delta.edges),
        },
        nodes: filterEntries(delta.nodes),
        edges: filterEntries(delta.edges),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(compactDelta, null, 2) }]
      };
    })
  );

  server.tool(
    "chomp_create_view",
    "QUERY-SCOPED UI HIGHLIGHT ([PAT-MCP-03], [PAT-MCP-08], [PAT-VIS-28]): Controls the frontend UI state by highlighting specific nodes (ACTIVE state) in the graph view, selecting the topological height (`viewLevel: 'system' | 'package'`), and returning a one-click markdown deep-link URL (`viewUrl`) that you can share directly in chat. Invoke this tool ONLY when the user is asking an architectural question, querying how a flow works, or explicitly requesting a visual highlight/walkthrough—do NOT auto-fire this tool on routine coding, refactoring, or implementation prompts. When invoked for a question or walkthrough, call it immediately after resolving target node IDs via `chomp_get_nodes` (or pass `search_term` / `packageName` directly here) before reading source files or composing explanations. Pass the IDs of CONTRACT nodes (functions, public methods, endpoints, components), CLASS / NAMESPACE / INIT_BLOCK boundary nodes, or OPEN_CONNECTOR nodes. Files and directories are not graph nodes (Ontology v4.0).",
    {
      title: z.string().describe("Title for the view banner"),
      description: z.string().describe("Description for the view banner"),
      highlightNodeIds: z.array(z.string()).optional().describe("List of node IDs to highlight (set to ACTIVE state) in the graph"),
      highlight_node_ids: z.array(z.string()).optional().describe("Alias for highlightNodeIds (snake_case)"),
      search_term: z.string().optional().describe("Optional fast-path search term to automatically resolve and highlight matching node IDs without a separate round-trip"),
      searchTerm: z.string().optional().describe("Alias for search_term (camelCase)"),
      packageName: z.string().optional().describe("Optional package filter when resolving nodes via search_term, or target package when viewLevel is 'package' (e.g., 'mcp', 'core', 'web', 'cli', 'db')"),
      package_name: z.string().optional().describe("Alias for packageName (snake_case)"),
      viewLevel: z.enum(["system", "package"]).optional().describe("Optional topological height for the view ('system' = Bird's-Eye Macro View across packages; 'package' = Circuit-Board View inside a single package). Defaults to 'system' when highlighted nodes span multiple packages, and 'package' for single-package flows."),
      view_level: z.enum(["system", "package"]).optional().describe("Alias for viewLevel (snake_case)"),
      layer: z.string().optional().describe("Optional overlay layer associated with this view (e.g., 'L1_DESIGN_SYSTEM', 'L2_RUNTIME', 'PLUGIN:a11y'). Automatically enables this overlay layer in the UI while the Active View is open."),
      source: z.string().optional().describe("Optional plugin/producer source label for the view banner"),
      pills: z.array(z.string()).optional().describe("Optional summary pills/badges rendered in the Agent Spotlight banner"),
      metrics: z.record(z.union([z.string(), z.number()])).optional().describe("Optional key-value metric summary rendered in the Agent Spotlight banner"),
      nodeAnnotations: z.record(z.string()).optional().describe("Optional map of nodeId -> short annotation note displayed for highlighted stations in the Agent Spotlight banner")
    },
    withMcpToolErrorBoundary(async (args) => {
      const { repoPath, repoName, repoId, dbPath } = resolveActiveMcpRepo(targetPath);
      const explicitIds = args.highlightNodeIds ?? args.highlight_node_ids ?? [];
      const searchTerm = args.search_term ?? args.searchTerm;
      const packageName = args.packageName ?? args.package_name;
      const explicitViewLevel = args.viewLevel ?? args.view_level;

      let resolvedGraph: RepresentationGraph | null = null;
      if (existsSync(dbPath)) {
        resolvedGraph = await loadActiveGraphWithShims(repoPath, dbPath, repoId);
      }

      const highlightIds = resolveViewNodeIds(
        resolvedGraph,
        explicitIds,
        searchTerm,
        packageName
      );

      const altitude = resolveViewTargetAltitude(
        resolvedGraph,
        highlightIds,
        explicitViewLevel,
        packageName
      );
      const branchName = resolveRepoGitBranch(repoPath, resolvedGraph?.branchName);
      const viewUrl = buildActiveViewUrl({
        baseUrl: resolveActiveUiBaseUrl(repoPath),
        viewLevel: altitude.viewLevel,
        packageName: altitude.packageName,
      });
      const createdAt = new Date().toISOString();

      const viewData = {
        repoId,
        repoName,
        ...(branchName ? { branchName } : {}),
        createdAt,
        viewLevel: altitude.viewLevel,
        ...(altitude.packageName ? { packageName: altitude.packageName } : {}),
        viewUrl,
        title: args.title,
        description: args.description,
        highlightNodeIds: highlightIds,
        ...(args.layer ? { layer: args.layer } : {}),
        ...(args.source ? { source: args.source } : {}),
        ...(args.pills && args.pills.length > 0 ? { pills: args.pills } : {}),
        ...(args.metrics && Object.keys(args.metrics).length > 0
          ? { metrics: args.metrics }
          : {}),
        ...(args.nodeAnnotations && Object.keys(args.nodeAnnotations).length > 0
          ? { nodeAnnotations: args.nodeAnnotations }
          : {}),
      };
      const viewPath = resolve(repoPath, ".chomp", "current_view.json");
      mkdirSync(dirname(viewPath), { recursive: true });
      writeFileSync(viewPath, JSON.stringify(viewData, null, 2), "utf8");
      return {
        content: [
          {
            type: "text",
            text: `View successfully created (${highlightIds.length} node(s) highlighted, level: ${altitude.viewLevel}${altitude.packageName ? `, package: ${altitude.packageName}` : ""}).\nOpen in Chomp Visualizer: [${args.title}](${viewUrl})`
          }
        ]
      };
    })
  );

  server.tool(
    "chomp_visualizer_audit",
    "Compares the raw Chomp database graph against the final visual LayoutData to identify where the visualizer is dropping data, misrepresenting packages, or failing the Circuit Board ideal.",
    withMcpToolErrorBoundary(async () => {
      const { repoPath } = resolveActiveMcpRepo(targetPath);
      const globalChompBin = resolve(homedir(), ".local", "bin", "chomp");
      const cmd = existsSync(globalChompBin)
        ? `"${globalChompBin}" _audit-visualizer`
        : "pnpm chomp _audit-visualizer";
      try {
        const output = execSync(cmd, { cwd: repoPath, encoding: "utf8" });
        return { content: [{ type: "text", text: output }] };
      } catch (e: any) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error running visualizer audit:\n" + (e.stdout || e.message) }]
        };
      }
    })
  );

  server.tool(
    "chomp_audit_health",
    "ARCHITECTURAL INTELLIGENCE & AGENT-READINESS AUDIT ([PAT-MCP-08], [PAT-MCP-09], [PAT-VIS-15]): Synthesizes system and per-package health metrics (connectivity rate, entity type coverage, parent coverage, scope purity) and surfaces self-diagnostic graph & seam signals: (1) unresolved call hotspots (`? N unresolved` bespoke indirection candidates), (2) opaque contract bodies (`astCallCount > 0 && resolvedOutDegree === 0`), (3) dead-end ingress nodes, (4) unreachable orphan contracts, and (5) inter-package seam & 'missing glue' diagnostics (`ISOLATED_DEPLOYMENT_UNITS`, `UNSTITCHED_PROTOCOL_SEAM`, `INIT_BLOCK_CONNECTOR_LEAK`). Frames all findings as Agent-Readiness / Map Visibility opportunities with concrete refactor guidance.",
    {
      packageName: z.string().optional().describe("Optional filter by package / DEPLOYMENT_UNIT name (e.g., 'core', 'cli', 'mcp', 'web', 'db')"),
      package_name: z.string().optional().describe("Alias for packageName (snake_case)"),
      limit: z.number().optional().describe("Maximum diagnostic entries per category (default: 25)"),
      create_view: z.boolean().optional().describe("When true, updates the UI active view (.chomp/current_view.json) to highlight top diagnostic hotspots. Leave false (default) during coding tasks; pass true only when answering user questions or walkthrough requests."),
      createView: z.boolean().optional().describe("Alias for create_view (camelCase)")
    },
    withMcpToolErrorBoundary(async (args) => {
      const { repoPath, repoName, repoId, dbPath } = resolveActiveMcpRepo(targetPath);
      if (!existsSync(dbPath)) {
        throw new Error(`Chomp database not found at ${dbPath}. Please run 'chomp analyze .' first.`);
      }

      const graph = await loadActiveGraphWithShims(repoPath, dbPath, repoId);

      if (!graph) {
        throw new Error(`Graph data for repository '${repoId}' not found in the database. Please run 'chomp analyze .' first.`);
      }

      const pkgName = args.packageName ?? args.package_name;
      const report = auditGraphHealth(graph, {
        packageName: pkgName,
        limit: args.limit,
        repoPath,
      });

      if ((args.create_view ?? args.createView) && report.recommendedHighlightNodeIds.length > 0) {
        const viewPath = resolve(repoPath, ".chomp", "current_view.json");
        mkdirSync(dirname(viewPath), { recursive: true });
        const altitude = resolveViewTargetAltitude(
          graph,
          report.recommendedHighlightNodeIds,
          pkgName ? "package" : undefined,
          pkgName
        );
        const branchName = resolveRepoGitBranch(repoPath, graph.branchName);
        const viewUrl = buildActiveViewUrl({
          baseUrl: resolveActiveUiBaseUrl(repoPath),
          viewLevel: altitude.viewLevel,
          packageName: altitude.packageName,
        });
        writeFileSync(
          viewPath,
          JSON.stringify(
            {
              repoId,
              repoName,
              ...(branchName ? { branchName } : {}),
              createdAt: new Date().toISOString(),
              viewLevel: altitude.viewLevel,
              ...(altitude.packageName ? { packageName: altitude.packageName } : {}),
              viewUrl,
              title: pkgName ? `Health Audit: ${pkgName}` : "System Health & Map Visibility Audit",
              description: `Connectivity: ${report.healthGate.connectivityRate}% | Hotspots: ${report.healthGate.unresolvedHotspotCount} | Orphans: ${report.healthGate.orphanContractCount}`,
              highlightNodeIds: report.recommendedHighlightNodeIds,
            },
            null,
            2
          ),
          "utf8"
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
      };
    })
  );

  server.tool(
    "chomp_find_redundancies",
    "ARCHITECTURAL REDUNDANCY & PATTERN ALIGNMENT DETECTOR ([PAT-MCP-08], [PAT-MCP-09]): Scans the structural graph for (1) 1-to-1 pass-through middlemen contracts that add indirection without branching or side effects, (2) parallel/duplicate story sequences where multiple contracts invoke the exact same downstream target set, (3) duplicate contract symbol names across files/packages, and (4) outlier routes/endpoints that deviate from their package's dominant canonical wiring pattern.",
    {
      packageName: z.string().optional().describe("Optional filter by package / DEPLOYMENT_UNIT name (e.g., 'core', 'cli', 'mcp', 'web', 'db')"),
      package_name: z.string().optional().describe("Alias for packageName (snake_case)"),
      limit: z.number().optional().describe("Maximum entries per redundancy category (default: 25)")
    },
    withMcpToolErrorBoundary(async (args) => {
      const { repoPath, repoId, dbPath } = resolveActiveMcpRepo(targetPath);
      if (!existsSync(dbPath)) {
        throw new Error(`Chomp database not found at ${dbPath}. Please run 'chomp analyze .' first.`);
      }

      const graph = await loadActiveGraphWithShims(repoPath, dbPath, repoId);

      if (!graph) {
        throw new Error(`Graph data for repository '${repoId}' not found in the database. Please run 'chomp analyze .' first.`);
      }

      const report = findGraphRedundancies(graph, {
        packageName: args.packageName ?? args.package_name,
        limit: args.limit,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
      };
    })
  );

  server.tool(
    "chomp_check_boundaries",
    "BOUNDARY & TOPOLOGICAL LAYER CHECKER ([PAT-MCP-08], [PAT-MCP-09], [PAT-VIS-15]): Analyzes cross-package dependency topology, assigns each DEPLOYMENT_UNIT to an architectural tier (ENTRY_APPLICATION, SERVICE_ORCHESTRATOR, INFRASTRUCTURE_ADAPTER, FOUNDATION_CORE, ISOLATED_PACKAGE), detects package-level and contract-level circular dependencies and self-loops ([PAT-VIS-08]), flags boundary isolation or upward layer violations, and surfaces inter-package seam & 'missing glue' diagnostics (`ISOLATED_DEPLOYMENT_UNITS`, `UNSTITCHED_PROTOCOL_SEAM`, `INIT_BLOCK_CONNECTOR_LEAK`).",
    {
      packageName: z.string().optional().describe("Optional filter by package / DEPLOYMENT_UNIT name (e.g., 'core', 'cli', 'mcp', 'web', 'db')"),
      package_name: z.string().optional().describe("Alias for packageName (snake_case)")
    },
    withMcpToolErrorBoundary(async (args) => {
      const { repoPath, repoId, dbPath } = resolveActiveMcpRepo(targetPath);
      if (!existsSync(dbPath)) {
        throw new Error(`Chomp database not found at ${dbPath}. Please run 'chomp analyze .' first.`);
      }

      const graph = await loadActiveGraphWithShims(repoPath, dbPath, repoId);

      if (!graph) {
        throw new Error(`Graph data for repository '${repoId}' not found in the database. Please run 'chomp analyze .' first.`);
      }

      const report = checkGraphBoundaries(graph, {
        packageName: args.packageName ?? args.package_name,
        repoPath,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
      };
    })
  );

  server.tool(
    "chomp_get_blast_radius",
    "MANDATORY PRE-EDIT IMPACT ANALYSIS ([PAT-MCP-08], [PAT-MCP-09]): Call this tool BEFORE modifying or refactoring a contract, class, or boundary to compute its upstream dependent callers, downstream dependencies, external OPEN_CONNECTOR side effects, affected INGRESS entry points, affected packages, and Port Valve type schemas. Leave `create_view: false` (default) during coding/refactoring tasks; pass `create_view: true` only when answering user questions about impact or blast radius.",
    {
      node_id: z.string().optional().describe("Target node ID to compute the blast radius for"),
      nodeId: z.string().optional().describe("Alias for node_id (camelCase)"),
      node_ids: z.array(z.string()).optional().describe("Optional list of target node IDs to compute combined blast radius for"),
      nodeIds: z.array(z.string()).optional().describe("Alias for node_ids (camelCase)"),
      search_term: z.string().optional().describe("Case-insensitive search term to resolve target node(s) if node_id is not yet known (e.g., 'runStoryTracer', 'SQLiteStorage')"),
      searchTerm: z.string().optional().describe("Alias for search_term (camelCase)"),
      packageName: z.string().optional().describe("Optional package filter when resolving target node(s) via search_term"),
      package_name: z.string().optional().describe("Alias for packageName (snake_case)"),
      max_depth: z.number().optional().describe("Maximum BFS traversal depth upstream and downstream (default: 4)"),
      maxDepth: z.number().optional().describe("Alias for max_depth (camelCase)"),
      create_view: z.boolean().optional().describe("When true, updates .chomp/current_view.json to highlight the target node(s) and their blast radius in the UI. Leave false (default) during coding tasks; pass true only when answering user questions about impact."),
      createView: z.boolean().optional().describe("Alias for create_view (camelCase)")
    },
    withMcpToolErrorBoundary(async (args) => {
      const { repoPath, repoName, repoId, dbPath } = resolveActiveMcpRepo(targetPath);
      if (!existsSync(dbPath)) {
        throw new Error(`Chomp database not found at ${dbPath}. Please run 'chomp analyze .' first.`);
      }

      const graph = await loadActiveGraphWithShims(repoPath, dbPath, repoId);

      if (!graph) {
        throw new Error(`Graph data for repository '${repoId}' not found in the database. Please run 'chomp analyze .' first.`);
      }

      const portOverlays = await withStorage(dbPath, (s) =>
        s.getEntityOverlays(repoId, { layer: "L1_PORTS" })
      ).catch(() => []);

      const report = computeBlastRadius(
        graph,
        {
          nodeId: args.node_id ?? args.nodeId,
          nodeIds: args.node_ids ?? args.nodeIds,
          searchTerm: args.search_term ?? args.searchTerm,
          packageName: args.packageName ?? args.package_name,
          maxDepth: args.max_depth ?? args.maxDepth,
        },
        portOverlays
      );

      if ((args.create_view ?? args.createView) && report.found && report.highlightNodeIds.length > 0) {
        const viewPath = resolve(repoPath, ".chomp", "current_view.json");
        mkdirSync(dirname(viewPath), { recursive: true });
        const targetLabel = report.targetNodes.map((t) => t.label).slice(0, 3).join(", ");
        const altitude = resolveViewTargetAltitude(
          graph,
          report.highlightNodeIds,
          undefined,
          args.packageName ?? args.package_name
        );
        const branchName = resolveRepoGitBranch(repoPath, graph.branchName);
        const viewUrl = buildActiveViewUrl({
          baseUrl: resolveActiveUiBaseUrl(repoPath),
          viewLevel: altitude.viewLevel,
          packageName: altitude.packageName,
        });
        writeFileSync(
          viewPath,
          JSON.stringify(
            {
              repoId,
              repoName,
              ...(branchName ? { branchName } : {}),
              createdAt: new Date().toISOString(),
              viewLevel: altitude.viewLevel,
              ...(altitude.packageName ? { packageName: altitude.packageName } : {}),
              viewUrl,
              title: `Blast Radius: ${targetLabel}`,
              description: `Risk: ${report.summary?.riskLevel} | ${report.summary?.totalUpstreamCallerCount} upstream caller(s) across [${report.summary?.affectedPackages.join(", ")}]`,
              highlightNodeIds: report.highlightNodeIds,
            },
            null,
            2
          ),
          "utf8"
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
      };
    })
  );

  // Auto-register MCP tools owned by discovered plugins (`packages/mcp/src/plugins/<name>/` & `.chomp/plugins/<name>/`)
  const registeredToolNames = new Set<string>();
  for (const plugin of listChompPlugins()) {
    for (const pluginTool of plugin.mcpTools ?? []) {
      if (registeredToolNames.has(pluginTool.name)) continue;
      registeredToolNames.add(pluginTool.name);
      server.tool(
        pluginTool.name,
        pluginTool.description,
        pluginTool.inputSchema,
        withMcpToolErrorBoundary(async (args) => {
          const { repoPath, repoName, repoId, dbPath } = resolveActiveMcpRepo(targetPath);
          const settings = loadPluginSettings(repoPath, plugin);
          const ctx: ChompPluginToolContext = {
            repoPath,
            repoName,
            repoId,
            dbPath,
            settings,
            resolveSecret: (key) => resolvePluginSecret(plugin, settings, key),
            loadRawGraph: () => loadActiveGraphCached(dbPath, repoId),
            loadProjectedGraph: () => loadActiveGraphWithShims(repoPath, dbPath, repoId),
            withStorage: (fn) => withStorage(dbPath, fn),
            invalidateCache: () => invalidateMcpGraphCache(dbPath),
            runSelf: (opts) =>
              runChompPlugin(plugin, {
                repoPath,
                repoId,
                repoName,
                dbPath,
                persist: existsSync(dbPath),
                ...opts,
              }),
            setActiveView: (spec) =>
              writePluginActiveView(
                {
                  repoPath,
                  repoId,
                  repoName,
                  pluginName: plugin.name,
                  layer: plugin.layer,
                },
                spec
              ),
          };

          const out = await pluginTool.handler(args, ctx);
          if (
            out &&
            typeof out === "object" &&
            "content" in out &&
            Array.isArray((out as any).content)
          ) {
            return out as any;
          }
          const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
          return {
            content: [{ type: "text" as const, text }],
          };
        })
      );
    }
  }

  server.tool(
    "chomp_get_conventions",
    "PAVED-ROAD CONVENTION DISCOVERY & `chomp.config.json` SCHEMA REFERENCE ([PAT-EXT-28], [PAT-MCP-08], [PAT-MCP-09]): Pure MCP reference tool for coding agents (works even before `chomp analyze` has run). Returns: (1) Chomp's built-in framework conventions (`nextjs`, `react`, `express`, `mcp`, `drizzle`, `payload`, `core`) so new code aligns to deterministic zero-config patterns, (2) active custom conventions & validation diagnostics from `chomp.config.json#conventions`, (3) remediation playbooks mapping `chomp_audit_health` signals (`UNRESOLVED_CALL`, `ORPHAN_CONTRACT`, `OPAQUE_BODY`, `DARK_FILE`) and `sk1/...` shape keys to either paved-road code alignment, declarative `chomp.config.json#conventions` rules, or `chomp_local_shims` runtime bridges, and (4) the complete `NodeMatcher` / `EdgeMatcher` / `EmitTemplate` schema and copy-ready config templates.",
    {
      framework: z
        .string()
        .optional()
        .describe(
          "Optional filter by framework name (e.g., 'nextjs', 'react', 'express', 'mcp', 'drizzle', 'payload', 'core')"
        ),
      entity_type: z
        .string()
        .optional()
        .describe(
          "Optional filter by produced entityType or primitive type (e.g., 'HTTP_ENDPOINT', 'REACT_COMPONENT', 'DB_QUERY', 'OPEN_CONNECTOR', 'RELATIONSHIP')"
        ),
      entityType: z.string().optional().describe("Alias for entity_type (camelCase)"),
      signal_kind: z
        .enum(["UNRESOLVED_CALL", "ORPHAN_CONTRACT", "OPAQUE_BODY", "DARK_FILE"])
        .optional()
        .describe(
          "Optional filter by self-diagnostic graph signal from chomp_audit_health"
        ),
      signalKind: z
        .enum(["UNRESOLVED_CALL", "ORPHAN_CONTRACT", "OPAQUE_BODY", "DARK_FILE"])
        .optional()
        .describe("Alias for signal_kind (camelCase)"),
      shape_key: z
        .string()
        .optional()
        .describe(
          "Optional sk1/... call shapeKey from chomp_audit_health signalClusters to receive targeted matcher vs. local-shim guidance"
        ),
      shapeKey: z.string().optional().describe("Alias for shape_key (camelCase)"),
      search_term: z
        .string()
        .optional()
        .describe(
          "Optional case-insensitive search term across rule id, description, entityType, patternId, and specRef"
        ),
      searchTerm: z.string().optional().describe("Alias for search_term (camelCase)"),
      include_schema: z
        .boolean()
        .optional()
        .describe(
          "When true (default), includes the full NodeMatcher / EdgeMatcher / EmitTemplate schema reference and config templates; pass false for compact paved-road lookups."
        ),
      includeSchema: z.boolean().optional().describe("Alias for include_schema (camelCase)"),
    },
    withMcpToolErrorBoundary(async (args) => {
      const { repoPath } = resolveActiveMcpRepo(targetPath);
      const report = getConventionsReference({
        repoPath,
        framework: args.framework,
        entityType: args.entity_type ?? args.entityType,
        signalKind: args.signal_kind ?? args.signalKind,
        shapeKey: args.shape_key ?? args.shapeKey,
        searchTerm: args.search_term ?? args.searchTerm,
        includeSchema: args.include_schema ?? args.includeSchema ?? true,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
