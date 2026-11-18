import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeWorkingTreeVsHeadDelta } from "./diff.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const FIXTURE_DIR = resolve(REPO_ROOT, "fixtures/test-repos/diff-export-removal");

const SCRATCH = mkdtempSync(join(tmpdir(), "chomp-cli-diff-"));
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

describe("computeWorkingTreeVsHeadDelta (chomp diff)", () => {
  it("preserves repo root basename when archiving HEAD so single-package export removal reports exactly -1 removed", () => {
    const holder = join(SCRATCH, "case");
    const repoDir = join(holder, "diff-export-removal");
    mkdirSync(holder, { recursive: true });
    cpSync(FIXTURE_DIR, repoDir, { recursive: true });
    runGit(repoDir, ["init", "-q"]);
    runGit(repoDir, ["config", "user.email", "test@chomp.local"]);
    runGit(repoDir, ["config", "user.name", "Chomp Test"]);
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-q", "-m", "initial"]);

    const registryPath = join(repoDir, "src/content/registry.ts");
    const updated = readFileSync(registryPath, "utf8").replace(
      /\nexport function markdownRoutes\(\): string\[\] \{[\s\S]*?\}\n/,
      "\n"
    );
    writeFileSync(registryPath, updated, "utf8");

    const res = computeWorkingTreeVsHeadDelta(repoDir);
    assert.ok(res);
    const nodes = Object.values(res.delta.nodes);
    const added = nodes.filter((n) => n.status === "ADDED");
    const modified = nodes.filter((n) => n.status === "MODIFIED" || n.status === "LEXICAL_SHIFT");
    const removed = nodes.filter((n) => n.status === "REMOVED");
    assert.deepEqual(added, []);
    assert.deepEqual(modified, []);
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.base?.name, "Exported Function: markdownRoutes");

    const edges = Object.values(res.delta.edges).filter((e) => e.status !== "UNCHANGED");
    assert.deepEqual(edges, []);
  });
});
