import { Command } from "commander";
import { resolve, dirname, join, relative, basename } from "node:path";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { CORE_EXTRACTOR_VERSION, analyzeTarget, compareGraphs, type GraphDelta } from "@chomp/core";
import { applyActivePluginProjections } from "@chomp/mcp";
import { getGitInfo } from "../utils/git.js";
import { ansi, loadExcludeWorkspaces } from "../utils/branding.js";
import { resolveDefaultCliTarget } from "../utils/masterContext.js";

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

/**
 * Computes the structural `GraphDelta` between `HEAD` (archived under a directory
 * matching the repository root basename so single-package hashes align) and the
 * dirty working tree at `targetPath`.
 */
export function computeWorkingTreeVsHeadDelta(targetPath: string): {
  commitSha: string;
  branchName?: string;
  delta: GraphDelta;
} | null {
  const gitEnv = cleanGitEnv();
  let repoPath = targetPath;
  try {
    repoPath = execSync("git rev-parse --show-toplevel", {
      cwd: targetPath,
      encoding: "utf8",
      env: gitEnv,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    repoPath = existsSync(join(targetPath, ".git"))
      ? targetPath
      : dirname(targetPath);
  }

  const { commitSha, branchName } = getGitInfo(repoPath);
  if (!commitSha) {
    return null;
  }

  const excludeWorkspaces = loadExcludeWorkspaces(repoPath);
  const tempId = `chomp-head-${commitSha.substring(0, 7)}-${Date.now()}`;
  const tempDir = join(tmpdir(), tempId);
  const archiveRoot = join(tempDir, basename(resolve(repoPath)) || "repo");

  mkdirSync(archiveRoot, { recursive: true });

  try {
    execSync(`git archive HEAD | tar -x -C "${archiveRoot}"`, {
      cwd: repoPath,
      stdio: "ignore",
      env: gitEnv,
    });

    const safeReal = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
      }
    };
    const relTarget = relative(safeReal(repoPath), safeReal(targetPath));
    const tempTarget = relTarget ? join(archiveRoot, relTarget) : archiveRoot;

    const rawHeadGraph = applyActivePluginProjections(
      analyzeTarget(
        tempTarget,
        CORE_EXTRACTOR_VERSION,
        commitSha,
        excludeWorkspaces,
      ),
      { repoPath: tempTarget }
    );
    const headGraph = {
      ...rawHeadGraph,
      nodes: rawHeadGraph.nodes.filter((n) => (n.scope ?? "USER") === "USER"),
      edges: rawHeadGraph.edges.filter((e) => (e.scope ?? "USER") === "USER"),
    };
    const rawDirtyGraph = applyActivePluginProjections(
      analyzeTarget(
        targetPath,
        CORE_EXTRACTOR_VERSION,
        undefined,
        excludeWorkspaces,
      ),
      { repoPath: targetPath }
    );
    const dirtyGraph = {
      ...rawDirtyGraph,
      nodes: rawDirtyGraph.nodes.filter((n) => (n.scope ?? "USER") === "USER"),
      edges: rawDirtyGraph.edges.filter((e) => (e.scope ?? "USER") === "USER"),
    };

    return {
      commitSha,
      branchName,
      delta: compareGraphs(headGraph, dirtyGraph),
    };
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Compares the dirty working tree against the committed HEAD snapshot and prints structural deltas.
 */
export function runDiffCheck(targetPath: string): void {
  try {
    const result = computeWorkingTreeVsHeadDelta(targetPath);
    if (!result) {
      console.error("Error: Not a git repository or no commits found.");
      return;
    }

    const { commitSha, branchName, delta } = result;
    console.log(
      `\n  ${ansi.yellowBold("◆")} Comparing Working Tree vs HEAD (${ansi.cyan(branchName ?? "HEAD")} · ${commitSha.substring(0, 7)})...`,
    );

    const nodeValues = Object.values(delta.nodes);
    const addedNodes = nodeValues.filter((n: any) => n.status === "ADDED").length;
    const removedNodes = nodeValues.filter(
      (n: any) => n.status === "REMOVED",
    ).length;
    const modifiedNodes = nodeValues.filter(
      (n: any) => n.status === "MODIFIED" || n.status === "LEXICAL_SHIFT",
    ).length;
    const unchangedNodes = nodeValues.filter(
      (n: any) => n.status === "UNCHANGED",
    ).length;

    const edgeValues = Object.values(delta.edges);
    const addedEdges = edgeValues.filter((e: any) => e.status === "ADDED").length;
    const removedEdges = edgeValues.filter(
      (e: any) => e.status === "REMOVED",
    ).length;
    const modifiedEdges = edgeValues.filter(
      (e: any) => e.status === "MODIFIED" || e.status === "LEXICAL_SHIFT",
    ).length;

    console.log(
      `  ${ansi.dim("┌──────────────────────────────────────────────────────────────────┐")}`,
    );
    console.log(
      `  ${ansi.dim("│")}  ${ansi.bold("NODES")}  ${ansi.green(`+${addedNodes} added`)}  ·  ${ansi.amber(`~${modifiedNodes} modified`)}  ·  ${ansi.red(`-${removedNodes} removed`)}  ${ansi.dim(`(${unchangedNodes} unchanged)`)}`,
    );
    console.log(
      `  ${ansi.dim("│")}  ${ansi.bold("EDGES")}  ${ansi.green(`+${addedEdges} added`)}  ·  ${ansi.amber(`~${modifiedEdges} modified`)}  ·  ${ansi.red(`-${removedEdges} removed`)}`,
    );
    console.log(
      `  ${ansi.dim("└──────────────────────────────────────────────────────────────────┘")}`,
    );
    console.log(
      `  ${ansi.dim("Tip: Toggle 'Diff view' in the Chomp Visualizer HUD to inspect these changes on the canvas.")}\n`,
    );
  } catch (e: any) {
    console.error("Diff failed:", e.message);
  }
}

export function registerDiffCommand(program: Command): void {
  program
    .command("diff [path]")
    .description(
      "Compare the dirty working tree against the HEAD commit (defaults to current directory)",
    )
    .action((inputPath?: string) => {
      const baseDir = process.env.INIT_CWD ?? process.cwd();
      const { targetPath } = resolveDefaultCliTarget(inputPath, baseDir);

      if (!existsSync(targetPath)) {
        console.error(`Error: Path does not exist: ${targetPath}`);
        process.exit(1);
      }

      runDiffCheck(targetPath);
    });
}
