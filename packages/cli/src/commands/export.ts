/**
 * @fileoverview Zero-Backend Static Site Export (`chomp export [path] -o <outDir>`) ([PAT-CLI-13], [PAT-VIS-28]).
 *
 * Exports a self-contained static HTML/JS + JSON representation bundle deployable to GitHub Pages,
 * S3, Vercel/Netlify static hosting, or CI build artifacts without an Express server or SQLite runtime.
 */

import { Command } from "commander";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSQLiteStorage } from "@chomp/db";
import {
  applyActivePluginProjections,
  discoverPluginsInDir,
  getPluginEnvStatus,
  getPluginMcpToolSummaries,
  getPluginStateDirRel,
  isRegisteredStructuralPluginOverlay,
  listChompPlugins,
  loadPluginSettings,
} from "@chomp/mcp";
import type { EntityPluginPresentation } from "@chomp/core";

import { stripEvidenceSnippetsFromGraph } from "../visualizer/cloudLayoutClient.js";
import { computeWorkingTreeFingerprint } from "../visualizer/layoutCache.js";
import {
  buildEntityPresentations,
  buildPluginsOverview,
  computePluginFingerprint,
  computeStructureFingerprint,
  overlaysForStructureFingerprint,
  rulesReferenceOverlays,
  snapshotPluginRuns,
  splitOverlays,
  type PluginRunMap,
} from "../visualizer/pluginPresentationApi.js";
import {
  getRulesFingerprint,
  loadRulesConfig,
  type ChompRulesConfig,
} from "../visualizer/rulesConfig.js";
import type { EntityOverlayItem, LayoutData } from "../visualizer/types.js";
import { ansi, loadExcludeWorkspaces } from "../utils/branding.js";
import { getGitInfo, resolveRepoName } from "../utils/git.js";
import {
  getChompMasterRoot,
  resolveDefaultCliTarget,
} from "../utils/masterContext.js";
import { runAnalyze } from "./analyze.js";
import { buildLayout } from "./ui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RunExportOptions {
  out?: string;
  db?: string;
  uiDir?: string;
  skipAnalyze?: boolean;
  forceAnalyze?: boolean;
  quiet?: boolean;
  cloudUrl?: string;
}

export interface RunExportResult {
  repoId: string;
  repoName: string;
  repoPath: string;
  outDir: string;
  copiedStaticApp: boolean;
  normalNodeCount: number;
  diffNodeCount: number;
  snapshotJsPath: string;
  snapshotJsonPath: string;
}

function resolveBundledUiDir(explicitUiDir?: string): string | null {
  if (explicitUiDir) {
    const resolved = resolve(explicitUiDir);
    return existsSync(resolved) ? resolved : null;
  }
  const masterUiOut = resolve(getChompMasterRoot(), "apps/web/out");
  if (existsSync(join(masterUiOut, "index.html"))) {
    return masterUiOut;
  }
  const prodUiOut = resolve(__dirname, "../ui");
  if (existsSync(join(prodUiOut, "index.html"))) {
    return prodUiOut;
  }
  return null;
}

function writeJsonArtifact(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

function injectSnapshotScriptIntoHtml(html: string): string {
  const scriptTag = '<script src="./chomp-snapshot.js"></script>';
  if (html.includes("chomp-snapshot.js")) {
    return html;
  }
  if (html.includes("</head>")) {
    return html.replace("</head>", `${scriptTag}</head>`);
  }
  if (html.includes("<body")) {
    return `${scriptTag}\n${html}`;
  }
  return `${scriptTag}\n${html}`;
}

export async function runExport(
  targetPath: string,
  options: RunExportOptions = {},
): Promise<RunExportResult> {
  const resolvedTarget = resolve(targetPath);
  if (!existsSync(resolvedTarget)) {
    throw new Error(`Target path does not exist: ${resolvedTarget}`);
  }
  const isDir = statSync(resolvedTarget).isDirectory();
  const repoPath = isDir ? resolvedTarget : dirname(resolvedTarget);
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const dbPath = options.db
    ? resolve(baseDir, options.db)
    : resolve(repoPath, ".chomp", "graph.db");
  const outDir = options.out
    ? resolve(baseDir, options.out)
    : resolve(repoPath, "chomp-export");

  await discoverPluginsInDir(resolve(repoPath, ".chomp", "plugins")).catch(
    () => [],
  );

  const liveGit = getGitInfo(repoPath);
  let shouldAnalyze = Boolean(options.forceAnalyze) || !existsSync(dbPath);

  if (!shouldAnalyze && !options.skipAnalyze && existsSync(dbPath)) {
    const probeStorage = createSQLiteStorage(dbPath);
    try {
      const repos = await probeStorage.listRepositories();
      if (repos.length === 0) {
        shouldAnalyze = true;
      } else if (
        liveGit.commitSha &&
        repos[0].commitSha &&
        repos[0].commitSha !== liveGit.commitSha
      ) {
        shouldAnalyze = true;
      }
    } finally {
      await probeStorage.close();
    }
  }

  if (shouldAnalyze && !options.skipAnalyze) {
    if (!options.quiet) {
      console.log(
        `  ${ansi.cyan("↻")} Refreshing structural graph in ${ansi.dim(dbPath)}...`,
      );
    }
    await runAnalyze(repoPath, {
      db: dbPath,
      quiet: true,
    });
  }

  if (!existsSync(dbPath)) {
    throw new Error(`Chomp database not found at ${dbPath}`);
  }

  const storage = createSQLiteStorage(dbPath);
  let repo: {
    id: string;
    name?: string;
    path?: string;
    commitSha?: string;
    branchName?: string;
  };
  let graph: Awaited<ReturnType<typeof storage.getRepresentationGraph>>;
  let overlays: EntityOverlayItem[] = [];

  try {
    const repos = await storage.listRepositories();
    if (repos.length === 0) {
      throw new Error(`No repositories found in ${dbPath}`);
    }
    const canonicalName = resolveRepoName(repoPath);
    const canonicalId = canonicalName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    repo =
      repos.find((r) => r.id === canonicalId || r.name === canonicalName) ??
      repos[0];
    graph = await storage.getRepresentationGraph(repo.id);
    if (!graph) {
      throw new Error(`Representation graph missing for repository '${repo.id}'`);
    }
    try {
      overlays = (await storage.getEntityOverlays(
        repo.id,
      )) as EntityOverlayItem[];
    } catch {
      overlays = [];
    }
  } finally {
    await storage.close();
  }

  const canonicalRepoName = resolveRepoName(repoPath);
  const resolvedRepoName =
    repo.name && repo.name !== basename(repoPath)
      ? repo.name
      : canonicalRepoName || repo.name || "repository";
  const resolvedRepoId =
    repo.id || resolvedRepoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const resolvedBranchName =
    liveGit.branchName || repo.branchName || graph.branchName;
  const resolvedCommitSha =
    liveGit.commitSha || repo.commitSha || graph.commitSha;
  const resolvedCommitMessage = liveGit.commitMessage;
  const resolvedRemoteUrl = liveGit.remoteUrl;
  const dbMtime = existsSync(dbPath) ? statSync(dbPath).mtimeMs : Date.now();
  const resolvedUpdatedAt = dbMtime || Date.now();

  const rulesConfig: ChompRulesConfig = loadRulesConfig(dbPath);
  const split = splitOverlays(overlays);
  const structuralOverlays = split.layout;
  const pluginOverlays = split.plugin;

  // Build both normalLayout (diffMode = false) and diffLayout (diffMode = true)
  const normalBuilt = await buildLayout(
    graph,
    repoPath,
    false,
    resolvedRepoName,
    undefined,
    rulesConfig,
    structuralOverlays,
    false,
    options.cloudUrl,
  );
  const diffBuilt = await buildLayout(
    graph,
    repoPath,
    true,
    resolvedRepoName,
    undefined,
    rulesConfig,
    structuralOverlays,
    false,
    options.cloudUrl,
  );

  const decorateLayoutMeta = (layout: LayoutData): LayoutData => {
    (layout as any).repoId = resolvedRepoId;
    if (resolvedBranchName) {
      layout.branchName = resolvedBranchName;
      if (layout.healthSummary) {
        layout.healthSummary.branchName = resolvedBranchName;
      }
    }
    if (resolvedCommitSha) {
      layout.commitSha = resolvedCommitSha;
      if (layout.healthSummary) {
        layout.healthSummary.commitSha = resolvedCommitSha;
      }
    }
    if (resolvedCommitMessage) {
      layout.commitMessage = resolvedCommitMessage;
      if (layout.healthSummary) {
        layout.healthSummary.commitMessage = resolvedCommitMessage;
      }
    }
    if (resolvedRemoteUrl) {
      layout.remoteUrl = resolvedRemoteUrl;
    }
    layout.updatedAt = resolvedUpdatedAt;
    if (layout.healthSummary) {
      layout.healthSummary.updatedAt = resolvedUpdatedAt;
    }
    return layout;
  };

  const normalLayout = decorateLayoutMeta(normalBuilt.layout);
  const diffLayout = decorateLayoutMeta(diffBuilt.layout);
  if (diffLayout.diffSummary && !normalLayout.diffSummary) {
    normalLayout.diffSummary = diffLayout.diffSummary;
  }

  // Build snippet-free /api/graph payload
  const projectedGraph = applyActivePluginProjections(graph, {
    repoPath,
    overlays: structuralOverlays,
    overlayLayers: rulesConfig.overlayLayers,
  });
  const sanitizedGraph = stripEvidenceSnippetsFromGraph(projectedGraph);
  const graphPayload = {
    nodes: sanitizedGraph.nodes,
    edges: sanitizedGraph.edges,
    overlays: structuralOverlays,
    gridLayout: null,
  };

  // Resolve /api/view (.chomp/current_view.json) if valid for this repo
  let activeViewPayload: Record<string, unknown> | null = null;
  const viewPath = join(dirname(dbPath), "current_view.json");
  if (existsSync(viewPath)) {
    try {
      const rawView = JSON.parse(readFileSync(viewPath, "utf-8"));
      if (
        rawView &&
        typeof rawView === "object" &&
        (!rawView.repoId || rawView.repoId === resolvedRepoId) &&
        (!rawView.repoName || rawView.repoName === resolvedRepoName)
      ) {
        const isBranchMismatch = Boolean(
          rawView.branchName &&
            resolvedBranchName &&
            rawView.branchName !== resolvedBranchName,
        );
        activeViewPayload = {
          ...rawView,
          repoId: resolvedRepoId,
          repoName: resolvedRepoName,
          ...(resolvedBranchName ? { currentBranchName: resolvedBranchName } : {}),
          ...(isBranchMismatch
            ? { expired: true, expiredReason: "branch_mismatch" }
            : { expired: false }),
        };
      }
    } catch {
      activeViewPayload = null;
    }
  }

  // Build plugin overview + per-entity presentations for 0ms static drawer hydration
  const pluginRuns: PluginRunMap = new Map();
  const registryMeta = listChompPlugins().map((p) => {
    const settings = p.settingsSchema ? loadPluginSettings(repoPath, p) : undefined;
    const envStatus = settings ? getPluginEnvStatus(p, settings) : undefined;
    return {
      name: p.name,
      displayName: p.displayName,
      description: p.description,
      version: p.version,
      layer: p.layer as string,
      defaultEnabled: p.defaultEnabled ?? true,
      stateDir: getPluginStateDirRel(p.name),
      ...(p.settingsSchema ? { settingsSchema: p.settingsSchema } : {}),
      ...(settings ? { settings } : {}),
      ...(envStatus ? { envStatus } : {}),
      ...(p.mcpTools && p.mcpTools.length > 0
        ? { mcpTools: getPluginMcpToolSummaries(p) }
        : {}),
    };
  });

  const structureFp = computeStructureFingerprint(
    graph.nodes as any,
    graph.edges as any,
    overlaysForStructureFingerprint(
      split,
      rulesReferenceOverlays(rulesConfig.customRules as any),
      isRegisteredStructuralPluginOverlay,
    ),
  );
  const pluginFp = computePluginFingerprint(
    pluginOverlays,
    snapshotPluginRuns(pluginRuns),
    registryMeta,
  );
  const fingerprintPayload = {
    dbMtime,
    rulesFp: `static:${getRulesFingerprint(dbPath)}`,
    wtFingerprint: computeWorkingTreeFingerprint(repoPath),
    structureFp,
    pluginFp,
    staticExport: true,
  };

  const pluginsOverview = buildPluginsOverview({
    pluginOverlays,
    nodes: graph.nodes as any,
    registry: registryMeta,
    runs: snapshotPluginRuns(pluginRuns),
    structureFp,
  });

  const presentations: Record<string, EntityPluginPresentation[]> = {};
  const entityIdsWithPlugins = new Set<string>();
  for (const ov of pluginOverlays) {
    if (typeof ov.entityId === "string" && ov.entityId) {
      entityIdsWithPlugins.add(ov.entityId);
    }
  }
  for (const entityId of entityIdsWithPlugins) {
    const items = buildEntityPresentations({
      pluginOverlays,
      entityId,
      registry: registryMeta,
    });
    if (items.length > 0) {
      presentations[entityId] = items;
    }
  }

  mkdirSync(outDir, { recursive: true });

  // 1. Copy pre-built static Next.js bundle (`apps/web/out`) if available
  const uiDir = resolveBundledUiDir(options.uiDir);
  let copiedStaticApp = false;
  if (uiDir && resolve(uiDir) !== resolve(outDir)) {
    cpSync(uiDir, outDir, { recursive: true });
    copiedStaticApp = true;
    const indexHtmlPath = join(outDir, "index.html");
    if (existsSync(indexHtmlPath)) {
      const currentHtml = readFileSync(indexHtmlPath, "utf-8");
      writeFileSync(
        indexHtmlPath,
        injectSnapshotScriptIntoHtml(currentHtml),
        "utf-8",
      );
    }
  }

  // 2. Write static /api/* endpoints for static hosts & fetch compatibility
  writeJsonArtifact(join(outDir, "api", "layout.json"), normalLayout);
  writeJsonArtifact(join(outDir, "api", "layout", "index.json"), normalLayout);
  writeJsonArtifact(join(outDir, "api", "layout-diff.json"), diffLayout);
  writeJsonArtifact(join(outDir, "api", "layout", "fingerprint"), fingerprintPayload);
  writeJsonArtifact(join(outDir, "api", "layout", "fingerprint.json"), fingerprintPayload);
  writeJsonArtifact(join(outDir, "api", "graph"), graphPayload);
  writeJsonArtifact(join(outDir, "api", "graph.json"), graphPayload);
  writeJsonArtifact(join(outDir, "api", "view"), activeViewPayload);
  writeJsonArtifact(join(outDir, "api", "view.json"), activeViewPayload);
  writeJsonArtifact(join(outDir, "api", "rules"), rulesConfig);
  writeJsonArtifact(join(outDir, "api", "rules.json"), rulesConfig);
  writeJsonArtifact(join(outDir, "api", "overlays"), overlays);
  writeJsonArtifact(join(outDir, "api", "overlays.json"), overlays);
  writeJsonArtifact(join(outDir, "api", "plugins"), pluginsOverview);
  writeJsonArtifact(join(outDir, "api", "plugins.json"), pluginsOverview);

  // 3. Write chomp-snapshot.json & chomp-snapshot.js (0ms window.__CHOMP_STATIC_SNAPSHOT__)
  const snapshotPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    layout: normalLayout,
    diffLayout,
    fingerprint: fingerprintPayload,
    graph: graphPayload,
    view: activeViewPayload,
    rules: rulesConfig,
    overlays,
    plugins: pluginsOverview,
    presentations,
  };

  const snapshotJsonPath = join(outDir, "chomp-snapshot.json");
  const snapshotJsPath = join(outDir, "chomp-snapshot.js");
  writeJsonArtifact(snapshotJsonPath, snapshotPayload);

  const safeJsLiteral = JSON.stringify(snapshotPayload).replace(
    /<\//g,
    "<\\/",
  );
  writeFileSync(
    snapshotJsPath,
    `window.__CHOMP_STATIC_SNAPSHOT__ = ${safeJsLiteral};\n`,
    "utf-8",
  );

  if (!options.quiet) {
    console.log(
      `\n  ${ansi.green("✓")} ${ansi.bold("Chomp static bundle exported")} to ${ansi.yellowBold(outDir)}`,
    );
    console.log(
      `  ${ansi.dim("Repository:")} ${resolvedRepoName}  ${ansi.dim("·")}  ${ansi.dim("Stations:")} ${normalLayout.nodes.length}  ${ansi.dim("·")}  ${ansi.dim("UI Shell:")} ${copiedStaticApp ? "bundled" : "data-only (build @chomp/web to include HTML shell)"}\n`,
    );
  }

  return {
    repoId: resolvedRepoId,
    repoName: resolvedRepoName,
    repoPath,
    outDir,
    copiedStaticApp,
    normalNodeCount: normalLayout.nodes.length,
    diffNodeCount: diffLayout.nodes.length,
    snapshotJsPath,
    snapshotJsonPath,
  };
}

export function registerExportCommand(program: Command): void {
  program
    .command("export [path]")
    .description(
      "Export a zero-backend static HTML/JS + JSON representation bundle for GitHub Pages, S3, or CI artifacts",
    )
    .option(
      "-o, --out <dir>",
      "Output directory for the exported static bundle (default: <path>/chomp-export)",
    )
    .option(
      "--db <path>",
      "Path to SQLite database file (default: <path>/.chomp/graph.db)",
    )
    .option(
      "--ui-dir <dir>",
      "Optional pre-built Next.js static export directory (defaults to apps/web/out)",
    )
    .option(
      "--force-analyze",
      "Force re-extraction before exporting even if graph.db matches HEAD",
      false,
    )
    .option(
      "--skip-analyze",
      "Skip automatic AST extraction refresh check",
      false,
    )
    .option("-q, --quiet", "Suppress console output", false)
    .option(
      "--cloud-url <url>",
      "Stateless Cloudflare Layout Worker URL (optional)",
    )
    .action(
      async (
        inputPath: string | undefined,
        options: {
          out?: string;
          db?: string;
          uiDir?: string;
          forceAnalyze?: boolean;
          skipAnalyze?: boolean;
          quiet?: boolean;
          cloudUrl?: string;
        },
      ) => {
        const baseDir = process.env.INIT_CWD ?? process.cwd();
        const { targetPath } = resolveDefaultCliTarget(inputPath, baseDir, true);
        await runExport(targetPath, options);
      },
    );
}
