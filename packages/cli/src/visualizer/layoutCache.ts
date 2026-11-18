import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LayoutData } from "./types.js";

const DISK_LAYOUT_CACHE_VERSION = "v2";
const MAX_DISK_CACHE_FILES = 4;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "out",
  ".chomp",
  ".turbo",
  "coverage",
]);

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/i;

/**
 * Computes a fast, deterministic fingerprint of the working tree at `repoPath`
 * so `GET /api/layout?diff=true` can be served from memory in <5ms whenever
 * no source files have been modified since the last diff layout build.
 */
export function computeWorkingTreeFingerprint(repoPath?: string): string {
  if (!repoPath || !existsSync(repoPath)) {
    return "no-repo";
  }

  try {
    const headSha = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const branchOut = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const statusOut = execSync("git status --porcelain -uall", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const hash = createHash("sha1");
    hash.update(`head:${headSha}:${branchOut}\n`);

    const lines = statusOut.split("\n").filter(Boolean);
    for (const line of lines) {
      // Porcelain format: XY PATH or XY ORIG -> PATH
      const rawPath = line.slice(3).trim();
      const relPath = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop()!.trim()
        : rawPath;
      // Ignore ephemeral UI/debug files inside .chomp/ while still tracking .chomp/plugins/** (and legacy .chomp/shims.json)
      if (
        ((relPath.startsWith(".chomp/") || relPath === ".chomp") &&
          !relPath.startsWith(".chomp/plugins/") &&
          relPath !== ".chomp/shims.json") ||
        relPath.endsWith("layout_debug.csv") ||
        relPath.endsWith("matrix_debug.csv")
      ) {
        continue;
      }
      const absPath = resolve(repoPath, relPath);
      let fileMeta = "deleted";
      try {
        if (existsSync(absPath)) {
          const st = statSync(absPath);
          fileMeta = `${Math.trunc(st.mtimeMs)}:${st.size}`;
        }
      } catch {
        // Ignore stat race
      }
      hash.update(`${line.slice(0, 2)}:${relPath}:${fileMeta}\n`);
    }

    // Track .chomp/plugins/** (and legacy .chomp/shims.json) explicitly even when .chomp/ is gitignored
    const pluginsDir = resolve(repoPath, ".chomp", "plugins");
    if (existsSync(pluginsDir)) {
      const walkPlugins = (dir: string, prefix: string, depth: number) => {
        if (depth > 4) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
          );
        } catch {
          return;
        }
        for (const e of entries) {
          const full = join(dir, e.name);
          const rel = `${prefix}/${e.name}`;
          if (e.isDirectory()) {
            walkPlugins(full, rel, depth + 1);
          } else if (e.isFile()) {
            try {
              const st = statSync(full);
              hash.update(`plugin:${rel}:${Math.trunc(st.mtimeMs)}:${st.size}\n`);
            } catch {
              // Ignore stat race
            }
          }
        }
      };
      walkPlugins(pluginsDir, ".chomp/plugins", 0);
    }

    const legacyShimsPath = resolve(repoPath, ".chomp", "shims.json");
    if (existsSync(legacyShimsPath)) {
      try {
        const st = statSync(legacyShimsPath);
        hash.update(`shims:${Math.trunc(st.mtimeMs)}:${st.size}\n`);
      } catch {
        // Ignore stat race
      }
    }

    return hash.digest("hex").slice(0, 16);
  } catch {
    // Fallback when git CLI is unavailable or directory is not a git repo:
    // walk source files and hash their count, total size, and max mtimeMs.
    let fileCount = 0;
    let totalSize = 0;
    let maxMtime = 0;

    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && SOURCE_EXT_RE.test(entry.name)) {
          try {
            const st = statSync(full);
            fileCount++;
            totalSize += st.size;
            if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
          } catch {
            // Ignore transient file errors
          }
        }
      }
    };

    walk(repoPath, 0);
    return `fs:${fileCount}:${totalSize}:${Math.trunc(maxMtime)}`;
  }
}

function resolveDiskCacheDir(dbPath: string): string {
  return join(dirname(dbPath), "cache");
}

function buildDiskCacheFilename(cacheSeed: string): string {
  const digest = createHash("sha1")
    .update(`${DISK_LAYOUT_CACHE_VERSION}:${cacheSeed}`)
    .digest("hex")
    .slice(0, 20);
  return `layout-${digest}.json`;
}

export function readDiskLayoutCache(
  dbPath: string,
  cacheSeed: string,
): LayoutData | null {
  try {
    const filePath = join(
      resolveDiskCacheDir(dbPath),
      buildDiskCacheFilename(cacheSeed),
    );
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
      version?: string;
      layout?: LayoutData;
    };
    if (
      raw?.version !== DISK_LAYOUT_CACHE_VERSION ||
      !raw.layout ||
      !Array.isArray(raw.layout.nodes)
    ) {
      return null;
    }
    return raw.layout;
  } catch {
    return null;
  }
}

export function writeDiskLayoutCache(
  dbPath: string,
  cacheSeed: string,
  layout: LayoutData,
): void {
  try {
    const cacheDir = resolveDiskCacheDir(dbPath);
    mkdirSync(cacheDir, { recursive: true });
    const filename = buildDiskCacheFilename(cacheSeed);
    const targetFile = join(cacheDir, filename);
    writeFileSync(
      targetFile,
      JSON.stringify({
        version: DISK_LAYOUT_CACHE_VERSION,
        savedAt: new Date().toISOString(),
        layout,
      }),
      "utf8",
    );

    // Prune older cached layout files so `.chomp/cache/` stays bounded
    const entries = readdirSync(cacheDir)
      .filter((f) => f.startsWith("layout-") && f.endsWith(".json"))
      .map((f) => {
        const full = join(cacheDir, f);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch {
          // ignore
        }
        return { f, full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const stale of entries.slice(MAX_DISK_CACHE_FILES)) {
      try {
        unlinkSync(stale.full);
      } catch {
        // ignore
      }
    }
  } catch {
    // Non-fatal if `.chomp/cache` is read-only
  }
}

export function clearDiskLayoutCache(dbPath: string): void {
  try {
    const cacheDir = resolveDiskCacheDir(dbPath);
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal
  }
}
