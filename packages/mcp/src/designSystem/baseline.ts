/**
 * packages/mcp/src/designSystem/baseline.ts
 *
 * Diff baseline for the Closed-Loop Frontend Gate ("Query before write, diff after write").
 *
 * The baseline is a *pinned snapshot file* (`.chomp/design-system-baseline.json` by default,
 * or any path in `designSystem.baseline.path`, so it can be committed). It is written only by
 * an explicit snapshot action and is deliberately independent from the `entity_overlays`
 * display layer, which is refreshed by every audit. A tool that re-audits the dirty working
 * tree therefore can never silently move the goalposts of the diff gate.
 *
 * Findings are keyed by *identity* (`category|file|component|value`), not by line number, and
 * compared by *occurrence count*, so a second use of an already-present value is still "new".
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type FindingCategory =
  | "undefinedToken"
  | "arbitraryTailwind"
  | "primitiveSkip"
  | "hardcodedLiteral"
  | "invariantViolation"
  | "rawPrimitive"
  | "callSiteOverride"
  | "composability";

export interface FindingRecord {
  category: FindingCategory;
  /** Stable identity (no line numbers). */
  key: string;
  filePath: string;
  lineNumber: number;
  label: string;
  snippet?: string;
}

export interface DesignSystemBaselineSnapshot {
  schemaVersion: 1;
  createdAt: string;
  pluginVersion: string;
  commitSha?: string;
  /** True when the snapshot was pinned from a working tree with uncommitted changes in scope (explicit override). */
  workingTreeDirty?: boolean;
  mode: string;
  /** `FindingRecord.key` → occurrence count. */
  counts: Record<string, number>;
  /** `pairId::theme` identities failing contrast at snapshot time. */
  failingContrast: string[];
  /** Totals per category at snapshot time (for human review of the file). */
  totals: Record<string, number>;
}

export function findingKey(
  category: FindingCategory,
  filePath: string,
  component: string,
  value: string
): string {
  return `${category}|${filePath}|${component}|${value}`;
}

export function countFindings(records: FindingRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.key] = (counts[r.key] ?? 0) + 1;
  return counts;
}

export function totalsByCategory(records: FindingRecord[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const r of records) totals[r.category] = (totals[r.category] ?? 0) + 1;
  return totals;
}

export const DEFAULT_DESIGN_SYSTEM_BASELINE_REL =
  ".chomp/plugins/design-system/baseline.json" as const;
export const LEGACY_DESIGN_SYSTEM_BASELINE_REL =
  ".chomp/design-system-baseline.json" as const;

export function resolveBaselinePath(repoPath: string, configured: string): string {
  const primary = resolve(repoPath, configured);
  if (
    configured === DEFAULT_DESIGN_SYSTEM_BASELINE_REL &&
    !existsSync(primary) &&
    existsSync(resolve(repoPath, LEGACY_DESIGN_SYSTEM_BASELINE_REL))
  ) {
    return resolve(repoPath, LEGACY_DESIGN_SYSTEM_BASELINE_REL);
  }
  return primary;
}

export function readBaselineSnapshot(path: string): DesignSystemBaselineSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed &&
      parsed.schemaVersion === 1 &&
      parsed.counts &&
      typeof parsed.counts === "object" &&
      Array.isArray(parsed.failingContrast)
    ) {
      return parsed as DesignSystemBaselineSnapshot;
    }
  } catch {
    /* fallthrough: unreadable baseline is treated as missing */
  }
  return null;
}

export function writeBaselineSnapshot(
  path: string,
  snapshot: DesignSystemBaselineSnapshot
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

export interface FindingDiff {
  /** Live records whose key now occurs more often than in the baseline. */
  added: FindingRecord[];
  /** Baseline keys that now occur less often (or not at all): `key` → occurrences removed. */
  resolved: Array<{ key: string; removed: number }>;
}

export function diffFindings(
  baseCounts: Record<string, number>,
  live: FindingRecord[]
): FindingDiff {
  const liveCounts = countFindings(live);
  const added: FindingRecord[] = [];
  const seenForKey = new Map<string, number>();
  for (const r of live) {
    const baseN = baseCounts[r.key] ?? 0;
    const n = (seenForKey.get(r.key) ?? 0) + 1;
    seenForKey.set(r.key, n);
    if (n > baseN) added.push(r);
  }
  const resolved: FindingDiff["resolved"] = [];
  for (const [key, baseN] of Object.entries(baseCounts)) {
    const liveN = liveCounts[key] ?? 0;
    if (liveN < baseN) resolved.push({ key, removed: baseN - liveN });
  }
  resolved.sort((a, b) => a.key.localeCompare(b.key));
  return { added, resolved };
}

export interface WorkingTreeCheck {
  /** `null` when cleanliness cannot be determined (not a git repo, git unavailable). */
  clean: boolean | null;
  /** Uncommitted paths inside the checked directories (capped). */
  dirtyFiles: string[];
  commitSha?: string;
}

/**
 * Is the in-scope part of the working tree clean? Only the given directories are checked, so an
 * unrelated backend edit never blocks pinning a frontend baseline.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_PREFIX;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}

export function checkWorkingTreeClean(repoPath: string, dirs: string[]): WorkingTreeCheck {
  const gitEnv = cleanGitEnv();
  const run = (args: string[]): string =>
    execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv,
    });
  try {
    run(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { clean: null, dirtyFiles: [] };
  }
  let commitSha: string | undefined;
  try {
    commitSha = run(["rev-parse", "HEAD"]).trim() || undefined;
  } catch {
    /* repo without commits */
  }
  try {
    const pathspec = dirs.length > 0 ? dirs : ["."];
    const out = run(["status", "--porcelain", "--untracked-files=normal", "--", ...pathspec]);
    const dirtyFiles = out
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    return {
      clean: dirtyFiles.length === 0,
      dirtyFiles: dirtyFiles.slice(0, 20),
      ...(commitSha ? { commitSha } : {}),
    };
  } catch {
    return { clean: null, dirtyFiles: [], ...(commitSha ? { commitSha } : {}) };
  }
}
