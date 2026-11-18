/**
 * @fileoverview CLI command for listing, running, and diffing Chomp analysis-time plugins
 * (e.g., `chomp plugin list`, `chomp plugin run design-system [path]`, `chomp plugin diff [path]`).
 *
 * Enforces [PAT-DB-03], [PAT-DB-05], and [PAT-CLI-13].
 */

import { existsSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Command } from "commander";
import {
  diffDesignSystem,
  getChompPlugin,
  getPluginMcpToolSummaries,
  getPluginStateDirRel,
  listChompPlugins,
  runAllChompPlugins,
  runChompPlugin,
  snapshotDesignSystemBaseline,
  type RunChompPluginResult,
} from "@chomp/mcp";
import { ansi, loadExcludeWorkspaces } from "../utils/branding.js";
import { resolveDefaultCliTarget, resolveRepoName } from "../utils/masterContext.js";
import { runAnalyze } from "./analyze.js";

function printPluginRunSummary(res: RunChompPluginResult): void {
  console.log(
    `\n  ${ansi.yellowBold("◆")} ${ansi.bold(`Chomp Plugin: ${res.pluginName}`)} ${ansi.dim(`v${res.pluginVersion}`)} (${ansi.cyan(res.layer)})`
  );
  console.log(
    `    ${ansi.dim("Files scanned:")} ${res.acceptedFileCount}  ·  ${ansi.dim("Overlays written:")} ${ansi.green(String(res.overlayCount))}  ·  ${ansi.dim("Duration:")} ${res.durationMs}ms`
  );

  const plugin = getChompPlugin(res.pluginName);
  const summaryLines = plugin?.formatCliSummary?.(res, ansi) ?? [];
  for (const line of summaryLines) {
    console.log(`    ${line}`);
  }
  console.log("");
}

export function registerPluginCommand(program: Command): void {
  const pluginCmd = program
    .command("plugin")
    .description(
      "Manage and run Chomp modular overlay plugins (e.g., design-system, local-shims, enrich-nodes)"
    );

  pluginCmd
    .command("list")
    .description("List registered Chomp plugins")
    .action(() => {
      const plugins = listChompPlugins();
      console.log(
        `\n  ${ansi.yellowBold("◆")} ${ansi.bold(`Registered Chomp Plugins (${plugins.length})`)}\n`
      );
      for (const p of plugins) {
        const tools = getPluginMcpToolSummaries(p).map((t) => t.name);
        console.log(
          `  • ${ansi.bold(p.name)} ${ansi.dim(`v${p.version}`)} → ${ansi.cyan(p.layer)}  ${ansi.dim(`[${getPluginStateDirRel(p.name)}/]`)}`
        );
        console.log(`    ${ansi.dim(p.description)}`);
        if (tools.length > 0) {
          console.log(`    ${ansi.dim("MCP Tools:")} ${tools.join(", ")}`);
        }
        console.log("");
      }
    });

  pluginCmd
    .command("run [pluginName] [path]")
    .description(
      "Run a Chomp plugin (e.g. 'design-system' or 'all') against a repository and persist EXTRACTED overlays to .chomp/graph.db"
    )
    .option(
      "--db <path>",
      "Path to SQLite database file (default: <path>/.chomp/graph.db)"
    )
    .option("--json", "Output full plugin report as JSON", false)
    .action(
      async (
        pluginNameOrPath: string | undefined,
        maybePath: string | undefined,
        options: { db?: string; json?: boolean }
      ) => {
        const baseDir = process.env.INIT_CWD ?? process.cwd();
        let pluginName = "design-system";
        let rawTargetPath = maybePath;

        if (pluginNameOrPath) {
          const matched = getChompPlugin(pluginNameOrPath);
          if (matched || pluginNameOrPath.toLowerCase() === "all") {
            pluginName = pluginNameOrPath.toLowerCase();
          } else if (!maybePath) {
            rawTargetPath = pluginNameOrPath;
          } else {
            pluginName = pluginNameOrPath;
          }
        }

        const { targetPath } = resolveDefaultCliTarget(
          rawTargetPath,
          baseDir,
          !options.json
        );
        if (!existsSync(targetPath)) {
          console.error(`Error: Path does not exist: ${targetPath}`);
          process.exit(1);
        }

        const stat = statSync(targetPath);
        const repoPath = stat.isDirectory() ? targetPath : dirname(targetPath);
        const repoName = resolveRepoName(repoPath);
        const repoId = repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const dbPath = options.db
          ? resolve(baseDir, options.db)
          : resolve(repoPath, ".chomp", "graph.db");

        if (!existsSync(dbPath)) {
          await runAnalyze(repoPath, { db: dbPath, quiet: true });
        }

        const excludeWorkspaces = loadExcludeWorkspaces(repoPath);

        if (pluginName === "all") {
          const results = await runAllChompPlugins({
            repoPath,
            repoId,
            repoName,
            dbPath,
            excludeWorkspaces,
            persist: true,
          });
          if (options.json) {
            console.log(JSON.stringify(results, null, 2));
            return;
          }
          for (const r of results) {
            printPluginRunSummary(r);
          }
        } else {
          const res = await runChompPlugin(pluginName, {
            repoPath,
            repoId,
            repoName,
            dbPath,
            excludeWorkspaces,
            persist: true,
          });
          if (options.json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          printPluginRunSummary(res);
        }
      }
    );

  pluginCmd
    .command("diff [path]")
    .description(
      "Compare working-tree Design System adherence against the pinned baseline snapshot (see `chomp plugin baseline`)"
    )
    .option(
      "--db <path>",
      "Path to SQLite database file (default: <path>/.chomp/graph.db)"
    )
    .option("--baseline <path>", "Path to the baseline snapshot (default: designSystem.baseline.path)")
    .option("--json", "Output diff report as JSON", false)
    .action(
      async (
        inputPath: string | undefined,
        options: { db?: string; json?: boolean; baseline?: string }
      ) => {
        const baseDir = process.env.INIT_CWD ?? process.cwd();
        const { targetPath } = resolveDefaultCliTarget(
          inputPath,
          baseDir,
          !options.json
        );
        if (!existsSync(targetPath)) {
          console.error(`Error: Path does not exist: ${targetPath}`);
          process.exit(1);
        }

        const stat = statSync(targetPath);
        const repoPath = stat.isDirectory() ? targetPath : dirname(targetPath);
        const repoName = resolveRepoName(repoPath);
        const repoId = repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const dbPath = options.db
          ? resolve(baseDir, options.db)
          : resolve(repoPath, ".chomp", "graph.db");

        const diffRes = await diffDesignSystem({
          repoPath,
          repoId,
          repoName,
          dbPath,
          baselinePath: options.baseline,
        });

        if (options.json) {
          console.log(JSON.stringify(diffRes, null, 2));
          return;
        }

        const badge =
          diffRes.gateStatus === "PASS"
            ? ansi.green("PASS")
            : diffRes.gateStatus === "NO_BASELINE"
              ? ansi.yellow("NO BASELINE (unknown, not a pass)")
              : ansi.yellow("WARN");
        console.log(
          `\n  ${ansi.yellowBold("◆")} ${ansi.bold("Design System Diff Gate:")} ${badge}`
        );
        console.log(
          `    ${ansi.dim("New undefined var():")} ${diffRes.summary.newUndefinedTokenCount}  ·  ${ansi.dim("New arbitrary Tw:")} ${diffRes.summary.newArbitraryTailwindCount}  ·  ${ansi.dim("New hardcoded:")} ${diffRes.summary.newHardcodedLiteralCount}  ·  ${ansi.dim("New raw atoms:")} ${diffRes.summary.newRawPrimitiveCount}  ·  ${ansi.dim("Contrast failures:")} ${diffRes.summary.newContrastFailureCount}`
        );
        console.log(
          `    ${ansi.dim("Components improved:")} ${ansi.green(String(diffRes.summary.improvedComponentCount))}  ·  ${ansi.dim("Components regressed:")} ${
            diffRes.summary.regressedComponentCount === 0
              ? "0"
              : ansi.yellow(String(diffRes.summary.regressedComponentCount))
          }`
        );
        for (const msg of diffRes.remediationGuidance) {
          console.log(`    • ${msg}`);
        }
        console.log("");
      }
    );

  pluginCmd
    .command("baseline [path]")
    .description(
      "Pin the current working tree as the Design System diff baseline snapshot (run on a clean checkout)"
    )
    .option("--db <path>", "Path to SQLite database file (default: <path>/.chomp/graph.db)")
    .option("--out <path>", "Baseline file path (default: designSystem.baseline.path in chomp.config.json)")
    .option("--json", "Output the snapshot totals as JSON", false)
    .action(
      async (
        inputPath: string | undefined,
        options: { db?: string; out?: string; json?: boolean }
      ) => {
        const baseDir = process.env.INIT_CWD ?? process.cwd();
        const { targetPath } = resolveDefaultCliTarget(inputPath, baseDir, !options.json);
        if (!existsSync(targetPath)) {
          console.error(`Error: Path does not exist: ${targetPath}`);
          process.exit(1);
        }
        const stat = statSync(targetPath);
        const repoPath = stat.isDirectory() ? targetPath : dirname(targetPath);
        const repoName = resolveRepoName(repoPath);
        const repoId = repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const dbPath = options.db
          ? resolve(baseDir, options.db)
          : resolve(repoPath, ".chomp", "graph.db");

        const { path, snapshot, workingTree } = await snapshotDesignSystemBaseline({
          repoPath,
          repoId,
          repoName,
          dbPath: existsSync(dbPath) ? dbPath : undefined,
          baselinePath: options.out,
        });
        if (options.json) {
          console.log(JSON.stringify({ path, totals: snapshot.totals, createdAt: snapshot.createdAt }, null, 2));
          return;
        }
        if (workingTree.clean === false) {
          console.log(
            `\n  ${ansi.yellow("!")} ${ansi.bold("Working tree is dirty")} in scope (${workingTree.dirtyFiles.slice(0, 5).join(", ")}${workingTree.dirtyFiles.length > 5 ? ", …" : ""}). Drift in those changes is now part of the baseline (recorded as workingTreeDirty). Re-pin from a clean checkout to avoid hiding it.`
          );
        }
        const total = Object.values(snapshot.totals).reduce((n, v) => n + v, 0);
        console.log(
          `\n  ${ansi.yellowBold("◆")} ${ansi.bold("Design System baseline pinned")} → ${ansi.cyan(path)}`
        );
        console.log(
          `    ${ansi.dim("Findings recorded:")} ${total}  ·  ${ansi.dim("mode:")} ${snapshot.mode}${snapshot.commitSha ? `  ·  ${ansi.dim("commit:")} ${snapshot.commitSha.slice(0, 8)}` : ""}`
        );
        console.log(
          `    ${ansi.dim("Commit this file to share the baseline; `chomp plugin diff` only reports findings beyond it.")}\n`
        );
      }
    );
}
