import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { resolveRepoName } from "./git.js";

export { resolveRepoName };

export interface RecentChompRepo {
  id: string;
  name: string;
  path: string;
  lastConnectedAt: string;
}

export interface ChompMasterContext {
  activeRepoId: string;
  activeRepoPath: string;
  activeRepoName: string;
  masterRoot: string;
  updatedAt: string;
  recentRepos: RecentChompRepo[];
}

function toRepoId(repoName: string): string {
  return repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

export function getChompMasterRoot(): string {
  if (process.env.CHOMP_MASTER_ROOT && existsSync(process.env.CHOMP_MASTER_ROOT)) {
    return resolve(process.env.CHOMP_MASTER_ROOT);
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, "../../../..");
}

export function getGlobalContextPath(): string {
  return resolve(homedir(), ".chomp", "context.json");
}

export function getWorkspaceFallbackContextPath(): string {
  return resolve(getChompMasterRoot(), ".chomp", "master_context.json");
}

export function resolveGitRepoRoot(inputPath: string): string {
  const abs = resolve(inputPath);
  const dir = existsSync(abs) && !statSync(abs).isDirectory() ? dirname(abs) : abs;
  const masterRoot = getChompMasterRoot();

  // 1. If dir is inside <masterRoot>/fixtures/cloned-repos/<repo> or <masterRoot>/fixtures/test-repos/<repo>,
  //    resolve strictly to that fixture repo root — never let `git rev-parse` walk up to masterRoot!
  for (const fixtureBucket of ["cloned-repos", "test-repos"]) {
    const bucketPrefix = resolve(masterRoot, "fixtures", fixtureBucket) + "/";
    if (dir.startsWith(bucketPrefix)) {
      const rel = dir.slice(bucketPrefix.length);
      const repoFolder = rel.split("/")[0];
      if (repoFolder) {
        return resolve(masterRoot, "fixtures", fixtureBucket, repoFolder);
      }
    }
  }

  if (existsSync(resolve(dir, ".git")) || existsSync(resolve(dir, ".chomp"))) {
    return dir;
  }

  try {
    const gitTop = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (
      resolve(gitTop) === resolve(masterRoot) &&
      resolve(dir) !== resolve(masterRoot) &&
      existsSync(resolve(dir, "package.json")) &&
      !dir.startsWith(resolve(masterRoot, "packages") + "/") &&
      !dir.startsWith(resolve(masterRoot, "apps") + "/")
    ) {
      return dir;
    }
    return gitTop;
  } catch {
    return dir;
  }
}

export function readMasterContext(): ChompMasterContext | null {
  const candidates = [getGlobalContextPath(), getWorkspaceFallbackContextPath()]
    .filter((p) => existsSync(p))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

  for (const ctxPath of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(ctxPath, "utf8"));
      if (parsed && typeof parsed.activeRepoPath === "string") {
        const canonicalActiveName = resolveRepoName(parsed.activeRepoPath);
        const activeRepoName =
          parsed.activeRepoName && parsed.activeRepoName !== basename(parsed.activeRepoPath)
            ? parsed.activeRepoName
            : canonicalActiveName || parsed.activeRepoName || basename(parsed.activeRepoPath);
        const activeRepoId =
          parsed.activeRepoId && parsed.activeRepoId !== toRepoId(basename(parsed.activeRepoPath))
            ? parsed.activeRepoId
            : toRepoId(activeRepoName);
        return {
          activeRepoId,
          activeRepoPath: parsed.activeRepoPath,
          activeRepoName,
          masterRoot: parsed.masterRoot || getChompMasterRoot(),
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          recentRepos: Array.isArray(parsed.recentRepos)
            ? parsed.recentRepos.map((r: any) => {
                const rPath = typeof r?.path === "string" ? r.path : "";
                const canonicalRecentName = rPath ? resolveRepoName(rPath) : "";
                const rName =
                  r?.name && rPath && r.name !== basename(rPath)
                    ? r.name
                    : canonicalRecentName || r?.name || basename(rPath);
                const rId =
                  r?.id && rPath && r.id !== toRepoId(basename(rPath))
                    ? r.id
                    : toRepoId(rName);
                return {
                  id: rId,
                  name: rName,
                  path: r?.path,
                  lastConnectedAt: r?.lastConnectedAt || new Date().toISOString(),
                };
              })
            : [],
        };
      }
    } catch {
      // Ignore malformed context file
    }
  }
  return null;
}

/**
 * Resolves the target repository path for CLI commands (`chomp ui`, `chomp analyze`, `chomp health`, `chomp diff`).
 *
 * - When `inputPath` is explicitly passed (`.`, `./subpath`, `express`, `chomp`), resolves that explicit target
 *   (including short names inside `fixtures/cloned-repos/<name>`).
 * - When `inputPath` is omitted (`undefined`): if `preferTetherWhenNoArg` is true (e.g. `chomp ui`) OR the caller's
 *   current working directory is the Chomp master repository itself, resolves to the active Master Tether
 *   (`~/.chomp/context.json`) so running `chomp connect express` followed by `chomp ui` / `chomp health` / `chomp diff`
 *   from anywhere in `chomp` operates on `express` instead of overwriting the tether back to `chomp`.
 */
export function resolveDefaultCliTarget(
  inputPath: string | undefined,
  baseDir: string = process.env.INIT_CWD ?? process.cwd(),
  preferTetherWhenNoArg = false,
): { targetPath: string; explicit: boolean } {
  const masterRoot = getChompMasterRoot();
  if (inputPath !== undefined && inputPath.trim().length > 0) {
    const trimmed = inputPath.trim();
    if (trimmed === "chomp" || trimmed === "master") {
      return { targetPath: masterRoot, explicit: true };
    }
    if (trimmed.startsWith("~/")) {
      const homeCandidate = resolve(homedir(), trimmed.slice(2));
      if (existsSync(homeCandidate)) {
        return { targetPath: homeCandidate, explicit: true };
      }
    }
    const localCandidate = resolve(baseDir, trimmed);
    if (existsSync(localCandidate)) {
      return { targetPath: localCandidate, explicit: true };
    }
    const clonedCandidate = resolve(masterRoot, "fixtures", "cloned-repos", trimmed);
    if (existsSync(clonedCandidate)) {
      return { targetPath: clonedCandidate, explicit: true };
    }
    const testCandidate = resolve(masterRoot, "fixtures", "test-repos", trimmed);
    if (existsSync(testCandidate)) {
      return { targetPath: testCandidate, explicit: true };
    }
    const ctx = readMasterContext();
    if (ctx) {
      const normalized = trimmed.toLowerCase();
      const normalizedId = toRepoId(trimmed);
      if (
        ctx.activeRepoPath &&
        existsSync(ctx.activeRepoPath) &&
        (ctx.activeRepoName?.toLowerCase() === normalized ||
          ctx.activeRepoId?.toLowerCase() === normalized ||
          ctx.activeRepoId?.toLowerCase() === normalizedId ||
          basename(ctx.activeRepoPath).toLowerCase() === normalized)
      ) {
        return { targetPath: resolve(ctx.activeRepoPath), explicit: true };
      }
      for (const r of ctx.recentRepos ?? []) {
        if (!r?.path || !existsSync(r.path)) continue;
        if (
          r.name?.toLowerCase() === normalized ||
          r.id?.toLowerCase() === normalized ||
          r.id?.toLowerCase() === normalizedId ||
          basename(r.path).toLowerCase() === normalized
        ) {
          return { targetPath: resolve(r.path), explicit: true };
        }
      }
    }
    return { targetPath: localCandidate, explicit: true };
  }

  const ctx = readMasterContext();
  if (ctx?.activeRepoPath && existsSync(ctx.activeRepoPath)) {
    const callerRepoRoot = resolveGitRepoRoot(baseDir);
    const inMasterRepo = resolve(callerRepoRoot) === resolve(masterRoot);
    if (preferTetherWhenNoArg || inMasterRepo) {
      return { targetPath: ctx.activeRepoPath, explicit: false };
    }
  }

  return { targetPath: resolve(baseDir, "."), explicit: false };
}

export function setActiveChompTarget(targetPath: string): ChompMasterContext {
  const repoRoot = resolveGitRepoRoot(targetPath);
  const repoName = resolveRepoName(repoRoot);
  const repoId = toRepoId(repoName);
  const now = new Date().toISOString();
  const prev = readMasterContext();
  const existingRecents = prev?.recentRepos ?? [];

  const filtered = existingRecents.filter((r) => r && r.path && resolve(r.path) !== repoRoot);
  const recentRepos: RecentChompRepo[] = [
    { id: repoId, name: repoName, path: repoRoot, lastConnectedAt: now },
    ...filtered,
  ].slice(0, 25);

  const nextCtx: ChompMasterContext = {
    activeRepoId: repoId,
    activeRepoPath: repoRoot,
    activeRepoName: repoName,
    masterRoot: getChompMasterRoot(),
    updatedAt: now,
    recentRepos,
  };

  const payload = JSON.stringify(nextCtx, null, 2) + "\n";

  // Always write to the master workspace fallback so sandboxed shells & MCP can read it
  try {
    const fallbackPath = getWorkspaceFallbackContextPath();
    mkdirSync(dirname(fallbackPath), { recursive: true });
    writeFileSync(fallbackPath, payload, "utf8");
  } catch {
    // Ignore if master workspace is read-only
  }

  // Also write to ~/.chomp/context.json when permitted
  try {
    const ctxPath = getGlobalContextPath();
    mkdirSync(dirname(ctxPath), { recursive: true });
    writeFileSync(ctxPath, payload, "utf8");
  } catch {
    // Ignore EPERM when running inside a restricted sandbox
  }

  return nextCtx;
}

/**
 * Resolves the `.git` directory for a repository or git worktree and adds `.chomp/`
 * (and optional extra patterns) to `.git/info/exclude` so Chomp never dirties `.gitignore`
 * or `git status` in external repositories.
 */
export function ensureGitExcludeHasChomp(
  repoRoot: string,
  extraEntries: string[] = [],
): boolean {
  const dotGit = resolve(repoRoot, ".git");
  if (!existsSync(dotGit)) return false;

  let gitDir = dotGit;
  try {
    const stat = statSync(dotGit);
    if (!stat.isDirectory()) {
      const pointer = readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(pointer);
      if (match) {
        gitDir = resolve(repoRoot, match[1].trim());
      } else {
        return false;
      }
    }
  } catch {
    return false;
  }

  const infoDir = resolve(gitDir, "info");
  if (!existsSync(infoDir)) {
    try {
      mkdirSync(infoDir, { recursive: true });
    } catch {
      return false;
    }
  }

  // If .gitignore already ignores .chomp, no need to modify .git/info/exclude
  const gitignorePath = resolve(repoRoot, ".gitignore");
  if (extraEntries.length === 0 && existsSync(gitignorePath)) {
    try {
      const gitignoreLines = readFileSync(gitignorePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim());
      if (
        gitignoreLines.includes(".chomp") ||
        gitignoreLines.includes(".chomp/") ||
        gitignoreLines.includes("/.chomp") ||
        gitignoreLines.includes("/.chomp/")
      ) {
        return false;
      }
    } catch {
      // continue
    }
  }

  const excludePath = resolve(infoDir, "exclude");
  const raw = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const required = [".chomp/", ".chomp", ...extraEntries];
  const missing = required.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return false;

  const prefix = raw.length > 0 && !raw.endsWith("\n") ? `${raw}\n` : raw;
  const block = `\n# --- BEGIN CHOMP IGNORE ---\n${missing.join("\n")}\n# --- END CHOMP IGNORE ---\n`;
  try {
    writeFileSync(excludePath, prefix + block, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Discovers all cloned repos under `<masterRoot>/fixtures/cloned-repos/*` plus `recentRepos`.
 */
export function listKnownTargetRepos(): Array<{
  name: string;
  path: string;
  source: "active" | "recent" | "cloned-fixture" | "master";
  isActive: boolean;
  hasGraphDb: boolean;
}> {
  const masterRoot = getChompMasterRoot();
  const ctx = readMasterContext();
  const activePath = ctx?.activeRepoPath ? resolve(ctx.activeRepoPath) : resolve(masterRoot);
  const byPath = new Map<
    string,
    {
      name: string;
      path: string;
      source: "active" | "recent" | "cloned-fixture" | "master";
      isActive: boolean;
      hasGraphDb: boolean;
    }
  >();

  const addCandidate = (
    repoPath: string,
    source: "active" | "recent" | "cloned-fixture" | "master",
  ) => {
    const abs = resolve(repoPath);
    if (!existsSync(abs)) return;
    const isAct = activePath === abs;
    const existing = byPath.get(abs);
    if (existing) {
      if (isAct) existing.isActive = true;
      if (source === "master" || source === "cloned-fixture") {
        existing.source = source;
      }
      return;
    }
    byPath.set(abs, {
      name: resolveRepoName(abs),
      path: abs,
      source,
      isActive: isAct,
      hasGraphDb: existsSync(resolve(abs, ".chomp", "graph.db")),
    });
  };

  addCandidate(masterRoot, "master");
  if (activePath) {
    addCandidate(activePath, "recent");
  }
  for (const r of ctx?.recentRepos ?? []) {
    if (r?.path) addCandidate(r.path, "recent");
  }

  const clonedDir = resolve(masterRoot, "fixtures", "cloned-repos");
  if (existsSync(clonedDir)) {
    try {
      for (const entry of readdirSync(clonedDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          addCandidate(resolve(clonedDir, entry.name), "cloned-fixture");
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return Array.from(byPath.values());
}

/**
 * Installs global `chomp` and `chomp-research` CLI shims into `~/.local/bin` (which is on PATH)
 * so the user can run `chomp init`, `chomp connect`, `chomp analyze`, `chomp health`, `chomp diff`,
 * and `chomp ui` from any directory on the machine without installing `@chomp/cli` into target repos.
 */
export function installGlobalChompShims(
  binDir = resolve(homedir(), ".local", "bin"),
): {
  chompShimPath: string;
  researchShimPath: string;
  chompBin: string;
  researchBin: string;
} {
  const masterRoot = getChompMasterRoot();
  const tsxBin = [
    resolve(masterRoot, "packages/db/node_modules/.bin/tsx"),
    resolve(masterRoot, "packages/cli/node_modules/.bin/tsx"),
    resolve(masterRoot, "node_modules/.bin/tsx"),
  ].find((p) => existsSync(p)) ?? "npx tsx";

  const cliEntry = resolve(masterRoot, "packages/cli/src/index.ts");
  const researchEntry = resolve(masterRoot, "fixtures/research/research-cli/src/index.ts");

  const chompShimPath = resolve(binDir, "chomp");
  const researchShimPath = resolve(binDir, "chomp-research");

  try {
    if (!existsSync(binDir)) {
      mkdirSync(binDir, { recursive: true });
    }

    const chompScript = [
      "#!/usr/bin/env bash",
      "# Auto-generated Chomp Master CLI shim — runs live TypeScript source from master repo",
      'export INIT_CWD="${INIT_CWD:-$(pwd)}"',
      `export CHOMP_MASTER_ROOT="${masterRoot}"`,
      `exec "${tsxBin}" "${cliEntry}" "$@"`,
      "",
    ].join("\n");
    writeFileSync(chompShimPath, chompScript, "utf8");
    chmodSync(chompShimPath, 0o755);

    const researchScript = [
      "#!/usr/bin/env bash",
      "# Auto-generated Chomp Research CLI shim — runs live TypeScript source from master repo",
      'export INIT_CWD="${INIT_CWD:-$(pwd)}"',
      `export CHOMP_MASTER_ROOT="${masterRoot}"`,
      `exec "${tsxBin}" "${researchEntry}" "$@"`,
      "",
    ].join("\n");
    writeFileSync(researchShimPath, researchScript, "utf8");
    chmodSync(researchShimPath, 0o755);
  } catch {
    // Ignore EPERM when running inside a restricted agent sandbox
  }

  return {
    chompShimPath,
    researchShimPath,
    chompBin: chompShimPath,
    researchBin: researchShimPath,
  };
}
