import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORE_EXTRACTOR_VERSION, analyzeTarget } from "@chomp/core";
import { createSQLiteStorage } from "@chomp/db";
import { computeGraphDeltaWithShims, invalidateMcpGraphCache } from "./index.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const FIXTURE_DIR = resolve(REPO_ROOT, "fixtures/test-repos/diff-export-removal");

const SCRATCH = mkdtempSync(join(tmpdir(), "chomp-diff-trust-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

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

function runGit(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanGitEnv(),
  }).trim();
}

function setupGitFixtureCopy(subName: string): { repoDir: string; commitSha: string; dbPath: string; repoId: string } {
  const holder = join(SCRATCH, subName);
  const repoDir = join(holder, "diff-export-removal");
  mkdirSync(holder, { recursive: true });
  cpSync(FIXTURE_DIR, repoDir, { recursive: true });
  writeFileSync(join(repoDir, ".gitignore"), ".chomp/\n", "utf8");
  runGit(repoDir, ["init", "-q"]);
  runGit(repoDir, ["config", "user.email", "test@chomp.local"]);
  runGit(repoDir, ["config", "user.name", "Chomp Test"]);
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-q", "-m", "initial fixture"]);
  const commitSha = runGit(repoDir, ["rev-parse", "HEAD"]);
  const dbPath = join(repoDir, ".chomp", "graph.db");
  return { repoDir, commitSha, dbPath, repoId: "diff-export-removal" };
}

function summarizeStatuses(record: Record<string, { status: string }>) {
  const counts: Record<string, number> = {
    ADDED: 0,
    MODIFIED: 0,
    REMOVED: 0,
    LEXICAL_SHIFT: 0,
    UNCHANGED: 0,
  };
  for (const entry of Object.values(record)) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}

describe("computeGraphDeltaWithShims trust & staleness ([PAT-MCP-02], [PAT-DB-03])", () => {
  it("reports exact 1 REMOVED and 0 false MODIFIED when deleting a single unused exported function", async () => {
    const { repoDir, commitSha, dbPath, repoId } = setupGitFixtureCopy("fresh-removal");
    const baseGraph = analyzeTarget(repoDir, CORE_EXTRACTOR_VERSION, commitSha);
    const storage = createSQLiteStorage(dbPath);
    try {
      await storage.saveRepresentationGraph(
        { id: repoId, name: "diff-export-removal", path: repoDir, extractorVersion: CORE_EXTRACTOR_VERSION, commitSha },
        baseGraph
      );
    } finally {
      await storage.close();
    }

    writeFileSync(
      join(repoDir, ".chomp", "base_snapshot.json"),
      JSON.stringify({
        commitSha,
        analyzedAt: baseGraph.analyzedAt,
        extractorVersion: baseGraph.extractorVersion,
        workingTreeDirty: false,
        dirtyFiles: [],
      }),
      "utf8"
    );

    // Delete only `markdownRoutes` from src/content/registry.ts
    const registryPath = join(repoDir, "src/content/registry.ts");
    const updatedRegistry = readFileSync(registryPath, "utf8").replace(
      /\nexport function markdownRoutes\(\): string\[\] \{[\s\S]*?\}\n/,
      "\n"
    );
    writeFileSync(registryPath, updatedRegistry, "utf8");

    const delta = await computeGraphDeltaWithShims(repoDir, dbPath, repoId);
    assert.equal(delta.baseStatus, "FRESH");
    assert.deepEqual(summarizeStatuses(delta.nodes), {
      ADDED: 0,
      MODIFIED: 0,
      REMOVED: 1,
      LEXICAL_SHIFT: 0,
      UNCHANGED: baseGraph.nodes.length - 1,
    });
    assert.deepEqual(summarizeStatuses(delta.edges), {
      ADDED: 0,
      MODIFIED: 0,
      REMOVED: 0,
      LEXICAL_SHIFT: 0,
      UNCHANGED: summarizeStatuses(delta.edges).UNCHANGED,
    });

    const removedNodes = Object.values(delta.nodes).filter((n) => n.status === "REMOVED");
    assert.equal(removedNodes.length, 1);
    assert.equal(removedNodes[0]?.base?.name, "Exported Function: markdownRoutes");

    const modifiedNodes = Object.values(delta.nodes).filter((n) => n.status === "MODIFIED");
    assert.deepEqual(modifiedNodes, []);
  });

  it("ignores excluded workspaces and *.test.ts files instead of surfacing them as diff noise", async () => {
    const { repoDir, commitSha, dbPath, repoId } = setupGitFixtureCopy("excluded-and-tests");
    writeFileSync(
      join(repoDir, "chomp.config.json"),
      JSON.stringify({ excludeWorkspaces: ["packages/ignored-pkg"] }, null, 2),
      "utf8"
    );
    mkdirSync(join(repoDir, "packages/ignored-pkg/src"), { recursive: true });
    writeFileSync(
      join(repoDir, "packages/ignored-pkg/package.json"),
      JSON.stringify({ name: "@acme/ignored-pkg", version: "1.0.0" }, null, 2),
      "utf8"
    );
    writeFileSync(
      join(repoDir, "packages/ignored-pkg/src/helper.ts"),
      `export function ignoredHelper() { return 1; }\n`,
      "utf8"
    );
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-q", "-m", "add config and excluded workspace"]);
    const nextSha = runGit(repoDir, ["rev-parse", "HEAD"]);

    const baseGraph = analyzeTarget(repoDir, CORE_EXTRACTOR_VERSION, nextSha, ["packages/ignored-pkg"]);
    const storage = createSQLiteStorage(dbPath);
    try {
      await storage.saveRepresentationGraph(
        { id: repoId, name: "diff-export-removal", path: repoDir, extractorVersion: CORE_EXTRACTOR_VERSION, commitSha: nextSha },
        baseGraph
      );
    } finally {
      await storage.close();
    }

    // Mutate excluded workspace and add a test file
    writeFileSync(
      join(repoDir, "packages/ignored-pkg/src/helper.ts"),
      `export function ignoredHelper() { return 2; }\nexport function extraIgnored() { return 3; }\n`,
      "utf8"
    );
    writeFileSync(
      join(repoDir, "src/content/registry.test.ts"),
      `export function fakeTestHelper() { return 42; }\n`,
      "utf8"
    );

    const delta = await computeGraphDeltaWithShims(repoDir, dbPath, repoId);
    assert.equal(delta.baseStatus, "FRESH");
    const nodeCounts = summarizeStatuses(delta.nodes);
    const edgeCounts = summarizeStatuses(delta.edges);
    assert.equal(nodeCounts.ADDED, 0);
    assert.equal(nodeCounts.MODIFIED, 0);
    assert.equal(nodeCounts.REMOVED, 0);
    assert.equal(edgeCounts.ADDED, 0);
    assert.equal(edgeCounts.MODIFIED, 0);
    assert.equal(edgeCounts.REMOVED, 0);
  });

  it("reports STALE base when HEAD advances past baseCommitSha", async () => {
    const { repoDir, commitSha, dbPath, repoId } = setupGitFixtureCopy("stale-commit");
    const baseGraph = analyzeTarget(repoDir, CORE_EXTRACTOR_VERSION, commitSha);
    const storage = createSQLiteStorage(dbPath);
    try {
      await storage.saveRepresentationGraph(
        { id: repoId, name: "diff-export-removal", path: repoDir, extractorVersion: CORE_EXTRACTOR_VERSION, commitSha },
        baseGraph
      );
    } finally {
      await storage.close();
    }

    writeFileSync(join(repoDir, "README.md"), "# updated\n", "utf8");
    runGit(repoDir, ["add", "README.md"]);
    runGit(repoDir, ["commit", "-q", "-m", "advance HEAD"]);
    const headSha = runGit(repoDir, ["rev-parse", "HEAD"]);
    assert.notEqual(headSha, commitSha);

    invalidateMcpGraphCache(dbPath);
    const delta = await computeGraphDeltaWithShims(repoDir, dbPath, repoId);
    assert.equal(delta.baseStatus, "STALE");
    assert.ok(delta.stalenessReasons?.some((r) => r.code === "BASE_COMMIT_BEHIND_HEAD"));
    assert.deepEqual(delta.nodes, {});
    assert.deepEqual(delta.edges, {});
  });

  it("reports STALE base when base extractorVersion differs from live CORE_EXTRACTOR_VERSION", async () => {
    const { repoDir, commitSha, dbPath, repoId } = setupGitFixtureCopy("stale-version");
    const baseGraph = analyzeTarget(repoDir, "1.0.0", commitSha);
    const storage = createSQLiteStorage(dbPath);
    try {
      await storage.saveRepresentationGraph(
        { id: repoId, name: "diff-export-removal", path: repoDir, extractorVersion: "1.0.0", commitSha },
        baseGraph
      );
    } finally {
      await storage.close();
    }

    const delta = await computeGraphDeltaWithShims(repoDir, dbPath, repoId);
    assert.equal(delta.baseStatus, "STALE");
    assert.ok(delta.stalenessReasons?.some((r) => r.code === "EXTRACTOR_VERSION_MISMATCH"));
    assert.deepEqual(delta.nodes, {});
    assert.deepEqual(delta.edges, {});
  });

  it("reports STALE base when base_snapshot.json records workingTreeDirty: true", async () => {
    const { repoDir, commitSha, dbPath, repoId } = setupGitFixtureCopy("stale-dirty-base");
    const baseGraph = analyzeTarget(repoDir, CORE_EXTRACTOR_VERSION, commitSha);
    const storage = createSQLiteStorage(dbPath);
    try {
      await storage.saveRepresentationGraph(
        { id: repoId, name: "diff-export-removal", path: repoDir, extractorVersion: CORE_EXTRACTOR_VERSION, commitSha },
        baseGraph
      );
    } finally {
      await storage.close();
    }

    writeFileSync(
      join(repoDir, ".chomp", "base_snapshot.json"),
      JSON.stringify({
        commitSha,
        analyzedAt: baseGraph.analyzedAt,
        extractorVersion: baseGraph.extractorVersion,
        workingTreeDirty: true,
        dirtyFiles: ["src/content/registry.ts"],
      }),
      "utf8"
    );

    const delta = await computeGraphDeltaWithShims(repoDir, dbPath, repoId);
    assert.equal(delta.baseStatus, "STALE");
    assert.ok(delta.stalenessReasons?.some((r) => r.code === "DIRTY_BASE_SNAPSHOT"));
    assert.deepEqual(delta.nodes, {});
    assert.deepEqual(delta.edges, {});
  });
});
