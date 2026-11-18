/**
 * @fileoverview CLI command implementation for deterministic AST analysis and representation graph generation.
 *
 * The `analyze` command parses a given TypeScript or JavaScript source file or directory,
 * extracts structural nodes (Boundaries, Contracts, Open Connectors) and edges (Relationships),
 * persists the resulting Representation Graph into an SQLite database, and prints
 * a concise structural Bite Report (or a full evidence table when `--verbose` is passed).
 *
 * @module @chomp/cli/commands/analyze
 */

import { existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { Command } from "commander";
import { CORE_EXTRACTOR_VERSION, analyzeTarget, type RepresentationGraph } from "@chomp/core";
import { createSQLiteStorage } from "@chomp/db";
import { runAllChompPlugins } from "@chomp/mcp";

import { getGitInfo, resolveRepoName } from "../utils/git.js";
import { hydrateRepositoryPortValves } from "../ports/portHydrator.js";
import {
  ansi,
  loadExcludeWorkspaces,
  runChompExtractionWithAnimation,
} from "../utils/branding.js";
import {
  ensureGitExcludeHasChomp,
  resolveDefaultCliTarget,
  setActiveChompTarget,
} from "../utils/masterContext.js";

export interface RunAnalyzeOptions {
  db?: string;
  verbose?: boolean;
  quiet?: boolean;
  animateBanner?: boolean;
  plugins?: boolean;
  noPlugins?: boolean;
  verifyPorts?: boolean;
}

export interface PluginRunFailureSummary {
  pluginName: string;
  error: string;
}

export interface PluginRunWarningSummary {
  pluginName: string;
  warnings: string[];
}

export interface RunAnalyzeResult {
  repoId: string;
  repoName: string;
  repoPath: string;
  dbPath: string;
  commitSha?: string;
  branchName?: string;
  durationMs: number;
  graph: RepresentationGraph;
  pluginOverlayCount?: number;
  pluginFailures?: PluginRunFailureSummary[];
  pluginWarnings?: PluginRunWarningSummary[];
  portHydratedCount?: number;
  portDiagnosticCount?: number;
}

/**
 * Runs deterministic AST extraction on `targetPath` and persists the RepresentationGraph to `.chomp/graph.db`.
 */
export async function runAnalyze(
  targetPath: string,
  options: RunAnalyzeOptions = {},
): Promise<RunAnalyzeResult> {
  const stat = statSync(targetPath);
  const isDir = stat.isDirectory();
  const repoPath = isDir ? targetPath : dirname(targetPath);
  const repoName = resolveRepoName(repoPath);
  const repoId = repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

  const { commitSha, branchName } = getGitInfo(repoPath);
  const excludeWorkspaces = loadExcludeWorkspaces(repoPath);

  const defaultDbDir = resolve(repoPath, ".chomp");
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const dbPath = options.db
    ? resolve(baseDir, options.db)
    : resolve(defaultDbDir, "graph.db");
  const targetDbDir = dirname(dbPath);
  if (!existsSync(targetDbDir)) {
    mkdirSync(targetDbDir, { recursive: true });
  }
  if (!options.db) {
    ensureGitExcludeHasChomp(repoPath);
  }
  if (!options.quiet && !options.db) {
    setActiveChompTarget(repoPath);
  }

  const inspectWorkingTreeState = (): { workingTreeDirty: boolean; dirtyFiles: string[] } => {
    if (!existsSync(resolve(repoPath, ".git"))) {
      return { workingTreeDirty: false, dirtyFiles: [] };
    }
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    delete env.GIT_OBJECT_DIRECTORY;
    delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    delete env.GIT_CEILING_DIRECTORIES;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_PREFIX;
    try {
      const out = execFileSync(
        "git",
        ["-C", repoPath, "status", "--porcelain", "--untracked-files=normal"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env },
      );
      const dirtyFiles = out
        .split(/\r?\n/)
        .filter((l) => l.length > 3)
        .map((l) => l.slice(3).trim())
        .filter((p) => Boolean(p) && !p.startsWith(".chomp/") && p !== ".chomp");
      return {
        workingTreeDirty: dirtyFiles.length > 0,
        dirtyFiles: dirtyFiles.slice(0, 50),
      };
    } catch {
      return { workingTreeDirty: false, dirtyFiles: [] };
    }
  };

  const executeExtractionAndSave = async () => {
    const t0 = Date.now();
    const graph = analyzeTarget(
      targetPath,
      CORE_EXTRACTOR_VERSION,
      commitSha,
      excludeWorkspaces,
    );

    const storage = createSQLiteStorage(dbPath);
    const repoInfo = {
      id: repoId,
      name: repoName,
      path: repoPath,
      extractorVersion: graph.extractorVersion,
      commitSha,
      branchName,
    };

    await storage.saveRepresentationGraph(repoInfo, graph);
    const savedGraph = (await storage.getRepresentationGraph(repoId)) ?? graph;

    if (!options.db || basename(dirname(dbPath)) === ".chomp") {
      try {
        const treeState = inspectWorkingTreeState();
        writeFileSync(
          resolve(dirname(dbPath), "base_snapshot.json"),
          JSON.stringify(
            {
              commitSha: commitSha ?? null,
              analyzedAt: savedGraph.analyzedAt,
              extractorVersion: savedGraph.extractorVersion,
              workingTreeDirty: treeState.workingTreeDirty,
              dirtyFiles: treeState.dirtyFiles,
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
      } catch {
        // Non-fatal if snapshot metadata cannot be written
      }
    }

    let pluginOverlayCount = 0;
    const pluginFailures: PluginRunFailureSummary[] = [];
    const pluginWarnings: PluginRunWarningSummary[] = [];
    if (options.plugins !== false && !options.noPlugins) {
      try {
        const pluginResults = await runAllChompPlugins({
          repoPath,
          repoId,
          repoName,
          storage,
          graph: savedGraph,
          excludeWorkspaces,
          persist: true,
          continueOnError: true,
          onPluginError: (plugin, err) => {
            pluginFailures.push({
              pluginName: plugin.name,
              error: err.message,
            });
          },
        });
        pluginOverlayCount = pluginResults.reduce(
          (sum, r) => sum + r.overlayCount,
          0
        );
        for (const r of pluginResults) {
          if (r.presentationWarnings.length > 0) {
            pluginWarnings.push({
              pluginName: r.pluginName,
              warnings: r.presentationWarnings,
            });
          }
        }
      } catch (err: any) {
        pluginFailures.push({
          pluginName: "plugin-runner",
          error: String(err?.message ?? err),
        });
      }
    }

    let portHydratedCount = 0;
    let portDiagnosticCount = 0;
    if (options.verifyPorts) {
      try {
        const portRes = await hydrateRepositoryPortValves({
          repoPath,
          repoId,
          storage,
          graph: savedGraph,
        });
        portHydratedCount = portRes.hydratedCount;
        portDiagnosticCount = portRes.diagnosticCount;
      } catch {
        // Non-fatal: Layer 0 syntactic ports remain intact
      }
    }

    await storage.close();
    const durationMs = Date.now() - t0;
    return {
      graph: savedGraph,
      durationMs,
      pluginOverlayCount,
      pluginFailures,
      pluginWarnings,
      portHydratedCount,
      portDiagnosticCount,
    };
  };

  let savedGraph: RepresentationGraph;
  let durationMs: number;
  let pluginOverlayCount = 0;
  let pluginFailures: PluginRunFailureSummary[] = [];
  let pluginWarnings: PluginRunWarningSummary[] = [];
  let portHydratedCount = 0;
  let portDiagnosticCount = 0;

  if (!options.quiet) {
    const res = await runChompExtractionWithAnimation({
      repoName,
      repoPath,
      dbPath,
      excludeWorkspaces,
      commitSha,
      branchName,
      executeExtraction: executeExtractionAndSave,
    });
    savedGraph = res.graph;
    durationMs = res.durationMs;
    pluginOverlayCount = (res as any).pluginOverlayCount ?? 0;
    pluginFailures = (res as any).pluginFailures ?? [];
    pluginWarnings = (res as any).pluginWarnings ?? [];
    portHydratedCount = (res as any).portHydratedCount ?? 0;
    portDiagnosticCount = (res as any).portDiagnosticCount ?? 0;

    for (const pf of pluginFailures) {
      console.warn(
        `  ${ansi.yellow("⚠")} Plugin '${pf.pluginName}' failed: ${pf.error} ${ansi.dim(`(.chomp/plugins/${pf.pluginName}/last-run.json)`)}`
      );
    }
    for (const pw of pluginWarnings) {
      console.warn(
        `  ${ansi.yellow("⚠")} Plugin '${pw.pluginName}' reported ${pw.warnings.length} presentation warning(s): ${pw.warnings[0]}`
      );
    }

    if (options.verbose) {
      const allEntities = [...savedGraph.nodes, ...savedGraph.edges];
      const summaryTable = allEntities.map((entity) => {
        const ev = Array.isArray(entity.evidence)
          ? entity.evidence[0]
          : entity.evidence;
        return {
          Type: entity.type,
          ID: entity.id,
          Name: entity.name,
          File: ev?.filePath ?? "-",
          Line: ev?.lineNumber ?? "-",
          Snippet: ev?.snippet
            ? ev.snippet.length > 40
              ? `${ev.snippet.slice(0, 37)}...`
              : ev.snippet
            : "-",
        };
      });
      console.table(summaryTable);
    }
  } else {
    const res = await executeExtractionAndSave();
    savedGraph = res.graph;
    durationMs = res.durationMs;
    pluginOverlayCount = res.pluginOverlayCount ?? 0;
    pluginFailures = res.pluginFailures ?? [];
    pluginWarnings = res.pluginWarnings ?? [];
    portHydratedCount = res.portHydratedCount ?? 0;
    portDiagnosticCount = res.portDiagnosticCount ?? 0;
  }

  return {
    repoId,
    repoName,
    repoPath,
    dbPath,
    commitSha,
    branchName,
    durationMs,
    graph: savedGraph,
    pluginOverlayCount,
    ...(pluginFailures.length > 0 ? { pluginFailures } : {}),
    ...(pluginWarnings.length > 0 ? { pluginWarnings } : {}),
    ...(options.verifyPorts
      ? { portHydratedCount, portDiagnosticCount }
      : {}),
  };
}

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze [path]")
    .description(
      "Analyze a TypeScript/JavaScript source file or directory (defaults to current directory)",
    )
    .option(
      "--db <path>",
      "Path to SQLite database file (default: <path>/.chomp/graph.db)",
    )
    .option(
      "-v, --verbose",
      "Print full entity evidence table after extraction",
      false,
    )
    .option("-q, --quiet", "Suppress console output (for git hooks)", false)
    .option("--no-plugins", "Skip running analysis-time overlay plugins")
    .option(
      "--verify-ports",
      "Run Speed 2 TypeScript TypeChecker verification on Contract Port Valves",
      false,
    )
    .action(async (inputPath: string | undefined, options: RunAnalyzeOptions) => {
      const baseDir = process.env.INIT_CWD ?? process.cwd();
      const { targetPath } = resolveDefaultCliTarget(
        inputPath,
        baseDir,
        !options.quiet,
      );

      if (!existsSync(targetPath)) {
        console.error(`Error: Path does not exist: ${targetPath}`);
        process.exit(1);
      }

      await runAnalyze(targetPath, { ...options, animateBanner: true });
    });
}
