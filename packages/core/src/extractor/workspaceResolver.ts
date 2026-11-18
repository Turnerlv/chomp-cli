import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

export interface WorkspaceRegistry {
  [packageName: string]: string; // "@payloadcms/config" -> "/absolute/path/packages/config"
}

export interface ResolvedFileBoundary {
  label: string;
  evidencePath: string;
  isWorkspaceMatch: boolean;
  isSubBoundary: boolean;
}

export interface DecomposedBoundaryRule {
  name: string;
  label: string;
  evidencePath: string;
  globs?: string[];
  matches: (relPosixPath: string) => boolean;
}

export interface DecomposedBoundaryPlan {
  baseLabel: string;
  mode: 'config';
  rules: DecomposedBoundaryRule[];
  byRelPath: Map<string, { label: string; evidencePath: string }>;
  defaultUnit: { label: string; evidencePath: string };
}

const decomposedBoundaryPlans = new WeakMap<WorkspaceRegistry, DecomposedBoundaryPlan>();

const WORKSPACE_CONTAINER_DIRS = [
  'packages',
  'package',
  'apps',
  'services',
  'workers',
  'libs',
  'modules',
  'plugins',
  'adapters',
];

const DIRECT_SUBPACKAGE_DIRS = [
  'server',
  'client',
  'web',
  'api',
  'frontend',
  'backend',
  'admin',
  'mobile',
  'worker',
  'shared',
  'common',
  'src/server',
  'src/client',
  'src/web',
  'src/api',
];

/**
 * Extracts explicit workspace globs from `pnpm-workspace.yaml`, `package.json` (`workspaces` array
 * or `{ packages: [...] }` object syntax), or `lerna.json` in `dir`.
 */
function extractExplicitWorkspaceGlobs(dir: string): string[] {
  const pnpmWorkspacePath = path.join(dir, 'pnpm-workspace.yaml');
  const packageJsonPath = path.join(dir, 'package.json');
  const lernaJsonPath = path.join(dir, 'lerna.json');

  if (fs.existsSync(pnpmWorkspacePath)) {
    try {
      const content = fs.readFileSync(pnpmWorkspacePath, 'utf8');
      const parsed = parsePnpmWorkspaceGlobs(content);
      if (parsed.length > 0) return parsed;
    } catch {
      // Ignore parse errors
    }
  }

  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (Array.isArray(pkg.workspaces)) {
        const globs = pkg.workspaces.filter((g: unknown): g is string => typeof g === 'string');
        if (globs.length > 0) return globs;
      } else if (
        pkg.workspaces &&
        typeof pkg.workspaces === 'object' &&
        Array.isArray(pkg.workspaces.packages)
      ) {
        const globs = pkg.workspaces.packages.filter(
          (g: unknown): g is string => typeof g === 'string'
        );
        if (globs.length > 0) return globs;
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (fs.existsSync(lernaJsonPath)) {
    try {
      const lerna = JSON.parse(fs.readFileSync(lernaJsonPath, 'utf8'));
      if (Array.isArray(lerna.packages)) {
        const globs = lerna.packages.filter((g: unknown): g is string => typeof g === 'string');
        if (globs.length > 0) return globs;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return [];
}

/**
 * Discovers implicit multi-shape workspace container globs (`packages/*`, `apps/*`, `services/*`,
 * `workers/*`, `libs/*`, `modules/*`, `plugins/*`) and direct sub-package directories (`client`,
 * `server`, `web`, `api`, `frontend`, `backend`, `admin`, `mobile`, `worker`, `shared`, `common`).
 */
function discoverMultiShapeSubPackageGlobs(repoRoot: string): string[] {
  const globs: string[] = [];

  for (const container of WORKSPACE_CONTAINER_DIRS) {
    const candidate = path.join(repoRoot, container);
    if (fs.existsSync(candidate)) {
      try {
        if (fs.statSync(candidate).isDirectory()) {
          globs.push(`${container}/*`);
        }
      } catch {
        // Ignore stat errors
      }
    }
  }

  for (const subDir of DIRECT_SUBPACKAGE_DIRS) {
    const pkgJsonCandidate = path.join(repoRoot, subDir, 'package.json');
    if (fs.existsSync(pkgJsonCandidate)) {
      globs.push(subDir);
    }
  }

  // Also scan direct child directories of repoRoot that contain their own package.json
  // (e.g. `cli/package.json` alongside `www/package.json`, or `back-end/` alongside `front-end/`).
  const IGNORED_CHILD_PACKAGE_DIRS = new Set([
    ...WORKSPACE_CONTAINER_DIRS,
    ...DIRECT_SUBPACKAGE_DIRS,
    'node_modules',
    'dist',
    'build',
    'out',
    'coverage',
    'fixtures',
    'test',
    'tests',
    '__tests__',
    'examples',
    'example',
    'templates',
    'template',
    'docs',
    'scripts',
  ]);
  try {
    const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (IGNORED_CHILD_PACKAGE_DIRS.has(entry.name)) continue;
      const childPkgJson = path.join(repoRoot, entry.name, 'package.json');
      if (fs.existsSync(childPkgJson)) {
        globs.push(entry.name);
      }
    }
  } catch {
    // Ignore readdir errors
  }

  return globs;
}

/**
 * Discovers workspace globs from nested language/SDK sub-roots up to 2 levels deep
 * (e.g. `libraries/typescript/pnpm-workspace.yaml` or `sdks/ts/package.json` `workspaces`).
 */
function discoverNestedWorkspaceSubRootGlobs(repoRoot: string): string[] {
  const SKIPPED_SUBROOT_DIRS = new Set([
    'node_modules',
    'dist',
    'build',
    'out',
    'coverage',
    'fixtures',
    'test',
    'tests',
    '__tests__',
    'examples',
    'example',
    'templates',
    'template',
    'docs',
    'scripts',
  ]);
  const globs: string[] = [];

  const scanDir = (dir: string, relPrefix: string, depth: number) => {
    if (depth > 2) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (SKIPPED_SUBROOT_DIRS.has(entry.name)) continue;
      const childAbs = path.join(dir, entry.name);
      const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const subGlobs = extractExplicitWorkspaceGlobs(childAbs);
      if (subGlobs.length > 0) {
        for (const g of subGlobs) {
          const clean = g.trim().replace(/\\/g, '/').replace(/^\.\//, '');
          if (!clean) continue;
          if (clean.startsWith('!')) {
            globs.push(`!${childRel}/${clean.slice(1).replace(/^\.\//, '')}`);
          } else {
            globs.push(`${childRel}/${clean}`);
          }
        }
        continue;
      }
      for (const container of ['packages', 'apps']) {
        const containerAbs = path.join(childAbs, container);
        if (fs.existsSync(containerAbs)) {
          try {
            if (fs.statSync(containerAbs).isDirectory()) {
              globs.push(`${childRel}/${container}/*`);
            }
          } catch {
            // Ignore stat errors
          }
        }
      }
      if (depth < 2) {
        scanDir(childAbs, childRel, depth + 1);
      }
    }
  };

  scanDir(repoRoot, '', 1);
  return globs;
}

/**
 * Checks whether `absRepoRoot` is a sub-package inside a parent monorepo root (up to 3 levels up).
 * Only matches when a parent directory declares explicit workspace globs (`pnpm-workspace.yaml`,
 * `package.json` `workspaces`, or `lerna.json`) whose expanded workspace directories contain `absRepoRoot`.
 */
function findParentMonorepoWorkspacePackage(
  absRepoRoot: string
): { pkgName: string; pkgDir: string } | null {
  let current = absRepoRoot;
  for (let depth = 0; depth < 3; depth++) {
    const parentDir = path.dirname(current);
    if (!parentDir || parentDir === current) break;
    current = parentDir;

    const parentGlobs = extractExplicitWorkspaceGlobs(parentDir);
    if (parentGlobs.length === 0) continue;

    let wsDirs: string[] = [];
    try {
      wsDirs = fg.sync(parentGlobs, {
        cwd: parentDir,
        onlyDirectories: true,
        absolute: true,
      });
    } catch {
      continue;
    }

    wsDirs.sort((a, b) => b.length - a.length);
    for (const wsDir of wsDirs) {
      const normWsDir = path.resolve(wsDir);
      if (absRepoRoot === normWsDir || absRepoRoot.startsWith(normWsDir + path.sep)) {
        const pkgJsonPath = path.join(normWsDir, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
            if (typeof pkg.name === 'string' && pkg.name.trim()) {
              return { pkgName: pkg.name.trim(), pkgDir: normWsDir };
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  }
  return null;
}

/**
 * Builds an in-memory registry mapping workspace package names to their absolute paths.
 * Supports:
 * - `pnpm-workspace.yaml`
 * - `package.json` `workspaces` (both array `["packages/*"]` and Yarn/npm object `{ packages: ["packages/*"] }`)
 * - `lerna.json`
 * - Multi-shape sub-package discovery (`packages/*`, `apps/*`, `services/*`, `workers/*`, `libs/*`,
 *   `modules/*`, `plugins/*`, and direct sub-package directories like `client/`, `server/`, `web/`, `api/`)
 * - Parent monorepo sub-package detection when `repoRoot` targets a sub-package inside a monorepo.
 *
 * @param repoRoot The absolute path of the repository root
 */
export function buildWorkspaceRegistry(repoRoot: string): WorkspaceRegistry {
  const absRepoRoot = path.resolve(repoRoot);
  const registry: WorkspaceRegistry = {};
  let globs = extractExplicitWorkspaceGlobs(absRepoRoot);

  // Fallback to multi-shape monorepo & sub-package patterns when no explicit workspace globs exist
  if (globs.length === 0) {
    globs = discoverMultiShapeSubPackageGlobs(absRepoRoot);
  }
  if (globs.length === 0) {
    globs = discoverNestedWorkspaceSubRootGlobs(absRepoRoot);
  }

  if (globs.length > 0) {
    const directories = fg
      .sync(globs, {
        cwd: absRepoRoot,
        onlyDirectories: true,
        absolute: true,
      })
      .sort((a, b) => a.localeCompare(b));

    for (const dir of directories) {
      const pkgJsonPath = path.join(dir, 'package.json');
      const projectJsonPath = path.join(dir, 'project.json');
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          const rawName =
            typeof pkg.name === 'string' && pkg.name.trim()
              ? pkg.name.trim()
              : path.basename(dir);
          if (rawName) {
            if (registry[rawName] && registry[rawName] !== dir) {
              const relDir = path.relative(absRepoRoot, dir).replace(/\\/g, '/');
              registry[`${rawName}/${relDir}`] = dir;
            } else {
              registry[rawName] = dir;
            }
          }
        } catch {
          // Ignore parse errors
        }
      } else if (fs.existsSync(projectJsonPath)) {
        try {
          const proj = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
          const rawName =
            typeof proj.name === 'string' && proj.name.trim()
              ? proj.name.trim()
              : path.basename(dir);
          if (rawName) {
            if (registry[rawName] && registry[rawName] !== dir) {
              const relDir = path.relative(absRepoRoot, dir).replace(/\\/g, '/');
              registry[`${rawName}/${relDir}`] = dir;
            } else {
              registry[rawName] = dir;
            }
          }
        } catch {
          const fallbackName = path.basename(dir);
          if (fallbackName && !registry[fallbackName]) {
            registry[fallbackName] = dir;
          }
        }
      }
    }
  }

  // If no child workspace packages were found, check if `repoRoot` itself is a sub-package inside a parent monorepo
  if (Object.keys(registry).length === 0) {
    const parentMatch = findParentMonorepoWorkspacePackage(absRepoRoot);
    if (parentMatch) {
      registry[parentMatch.pkgName] = parentMatch.pkgDir;
    }
  } else {
    // When a repository has both child workspace packages (e.g. `adapters/*` or `packages/*`) and a
    // root `package.json` with its own `exports` / `main` / `src` directory (e.g. `hono` importing
    // `hono/serve-static` from `adapters/bun`), register the root package name at `absRepoRoot`.
    const rootPkgJsonPath = path.join(absRepoRoot, 'package.json');
    if (fs.existsSync(rootPkgJsonPath)) {
      try {
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgJsonPath, 'utf8'));
        const rootName = typeof rootPkg.name === 'string' ? rootPkg.name.trim() : '';
        const hasRootExportsOrSource =
          Boolean(rootPkg.exports || rootPkg.main || rootPkg.module) ||
          fs.existsSync(path.join(absRepoRoot, 'src'));
        if (rootName && !registry[rootName] && hasRootExportsOrSource && !rootPkg.private) {
          registry[rootName] = absRepoRoot;
        }
      } catch {
        // Ignore malformed root package.json
      }
    }
  }

  return registry;
}

/**
 * Very rudimentary parser for pnpm-workspace.yaml to extract packages array.
 */
function parsePnpmWorkspaceGlobs(content: string): string[] {
  const globs: string[] = [];
  let inPackages = false;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('packages:')) {
      inPackages = true;
      continue;
    }

    if (inPackages) {
      // If it's a new top-level key or un-indented, we left packages
      if (trimmed && !line.startsWith(' ') && !line.startsWith('-')) {
        inPackages = false;
        continue;
      }

      if (trimmed.startsWith('-')) {
        let pattern = trimmed.substring(1).trim();
        // Remove quotes
        if (
          (pattern.startsWith("'") && pattern.endsWith("'")) ||
          (pattern.startsWith('"') && pattern.endsWith('"'))
        ) {
          pattern = pattern.substring(1, pattern.length - 1);
        }
        globs.push(pattern);
      }
    }
  }

  return globs;
}

function toRelPosixPath(filePath: string, repoRoot: string): string {
  const absRoot = path.resolve(repoRoot || process.cwd());
  const absFile = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(absRoot, filePath);
  const rel = path.relative(absRoot, absFile).replace(/\\/g, '/');
  return rel.replace(/^\.\//, '');
}

/**
 * Converts a glob pattern (e.g. `src/api/**`, `components/*.tsx`, `app/db.ts`) into a RegExp
 * matching normalized repo-relative POSIX paths.
 */
function globToRegExp(globPattern: string): RegExp {
  const norm = globPattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!norm || norm === '.' || norm === '**' || norm === '**/*') {
    return /^.+$/;
  }
  // If pattern is a bare directory prefix without wildcards or file extension (e.g. "src/api"), match directory prefix
  if (!norm.includes('*') && !norm.includes('?') && !/\.[a-z0-9]+$/i.test(norm)) {
    const escapedDir = norm.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escapedDir}(?:\\/.*)?$`);
  }

  let regexStr = '^';
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') {
          regexStr += '(?:.+\\/)?';
          i += 3;
          continue;
        }
        regexStr += '.*';
        i += 2;
        continue;
      }
      regexStr += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
      continue;
    }
    regexStr += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

function deriveEvidencePathFromGlobs(globs: string[]): string {
  for (const g of globs) {
    const norm = g.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const wildcardIdx = norm.search(/[*?]/);
    const prefix = (wildcardIdx === -1 ? norm : norm.slice(0, wildcardIdx)).replace(/\/+$/, '');
    if (prefix) return prefix;
  }
  return '.';
}

/**
 * Parses explicit user-configured `boundaries` rules from a parsed `chomp.config.json` value.
 * Supports object map `{ "api": ["src/api/**"] | { "globs"|"include": ... } }`
 * and array `[{ "name": "api", "globs"|"include": ["src/api/**"], "path": "src/api" }]`.
 */
export function parseUserBoundaryRules(
  raw: unknown,
  baseLabel: string
): DecomposedBoundaryRule[] {
  if (!raw || typeof raw !== 'object') return [];

  const rawBoundaries = (raw as Record<string, unknown>).boundaries;
  if (!rawBoundaries || typeof rawBoundaries !== 'object') return [];

  const rules: DecomposedBoundaryRule[] = [];

  const addRule = (rawName: string, rawPatterns: string[], explicitPath?: string) => {
    const cleanName = rawName.trim();
    if (!cleanName || rawPatterns.length === 0) return;
    const label = cleanName.includes('/') ? cleanName : `${baseLabel}/${cleanName}`;
    const compiled = rawPatterns.map(globToRegExp);
    const evidencePath = explicitPath?.trim() || deriveEvidencePathFromGlobs(rawPatterns);
    rules.push({
      name: cleanName,
      label,
      evidencePath,
      globs: rawPatterns,
      matches: (relPosix: string) => compiled.some((re) => re.test(relPosix)),
    });
  };

  const extractPatternsFromObject = (rec: Record<string, unknown>): string[] => {
    const patterns: string[] = [];
    for (const key of ['globs', 'include'] as const) {
      const val = rec[key];
      if (typeof val === 'string') patterns.push(val);
      else if (Array.isArray(val)) {
        patterns.push(...val.filter((g): g is string => typeof g === 'string'));
      }
    }
    if (typeof rec.glob === 'string') patterns.push(rec.glob);
    if (typeof rec.path === 'string' && patterns.length === 0) {
      patterns.push(rec.path);
    }
    return patterns;
  };

  if (Array.isArray(rawBoundaries)) {
    for (const item of rawBoundaries) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name : '';
      const patterns = extractPatternsFromObject(rec);
      addRule(name, patterns, typeof rec.path === 'string' ? rec.path : undefined);
    }
  } else {
    for (const [name, val] of Object.entries(rawBoundaries as Record<string, unknown>)) {
      if (typeof val === 'string') {
        addRule(name, [val]);
      } else if (Array.isArray(val)) {
        addRule(
          name,
          val.filter((g): g is string => typeof g === 'string')
        );
      } else if (val && typeof val === 'object') {
        const rec = val as Record<string, unknown>;
        const patterns = extractPatternsFromObject(rec);
        addRule(name, patterns, typeof rec.path === 'string' ? rec.path : undefined);
      }
    }
  }

  return rules;
}

/**
 * Loads user-configured `boundaries` from `chomp.config.json` when present.
 * Supports object map and array formats (`globs`, `include`, `glob`, or `path`).
 */
export function loadUserBoundaryRules(
  repoRoot: string,
  baseLabel: string
): DecomposedBoundaryRule[] {
  const configPath = path.join(path.resolve(repoRoot), 'chomp.config.json');
  if (!fs.existsSync(configPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }
  return parseUserBoundaryRules(raw, baseLabel);
}

/**
 * Computes and attaches explicit `chomp.config.json` `boundaries` decomposition rules to
 * `workspaceRegistry` (`[PAT-EXT-30]`). Single-package repositories without explicit config
 * return `undefined` and remain a single `DEPLOYMENT_UNIT` by default.
 */
export function attachDecomposedBoundaries(
  workspaceRegistry: WorkspaceRegistry,
  repoRoot: string,
  files: readonly string[]
): DecomposedBoundaryPlan | undefined {
  const absRepoRoot = path.resolve(repoRoot);
  const wsEntries = Object.entries(workspaceRegistry);

  // Determine the base label for this repository or single sub-package
  let baseLabel = path.basename(absRepoRoot);
  if (wsEntries.length === 1 && path.resolve(wsEntries[0][1]) === absRepoRoot) {
    baseLabel = wsEntries[0][0];
  }

  // Explicit `boundaries` in `chomp.config.json` is the only sub-package decomposition mode
  const explicitRules = loadUserBoundaryRules(absRepoRoot, baseLabel);
  if (explicitRules.length === 0) return undefined;

  const byRelPath = new Map<string, { label: string; evidencePath: string }>();
  const defaultUnit = { label: `${baseLabel}/core`, evidencePath: '.' };
  for (const filePath of files) {
    const relPosix = toRelPosixPath(filePath, absRepoRoot);
    const matched = explicitRules.find((r) => r.matches(relPosix));
    byRelPath.set(
      relPosix,
      matched
        ? { label: matched.label, evidencePath: matched.evidencePath }
        : defaultUnit
    );
  }
  const plan: DecomposedBoundaryPlan = {
    baseLabel,
    mode: 'config',
    rules: explicitRules,
    byRelPath,
    defaultUnit,
  };
  decomposedBoundaryPlans.set(workspaceRegistry, plan);
  return plan;
}

/**
 * Returns the decomposed boundary plan attached to `workspaceRegistry`, if any.
 */
export function getDecomposedBoundaryPlan(
  workspaceRegistry?: WorkspaceRegistry
): DecomposedBoundaryPlan | undefined {
  if (!workspaceRegistry) return undefined;
  return decomposedBoundaryPlans.get(workspaceRegistry);
}

/**
 * Resolves the owning `DEPLOYMENT_UNIT` label and relative `evidencePath` for `filePath`.
 * Shared between `analyzeTarget` (`index.ts`) and `resolveLogicalBoundaryScope` (`utils/id.ts`)
 * so node creation and cross-file relationship target resolution always hash against the exact
 * same logical boundary scope.
 */
export function resolveBoundaryForFile(
  filePath: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  fallbackRootLabel?: string
): ResolvedFileBoundary {
  const absRepoRoot = repoRoot ? path.resolve(repoRoot) : process.cwd();
  const decomposed = getDecomposedBoundaryPlan(workspaceRegistry);
  if (decomposed) {
    const relPosix = toRelPosixPath(filePath, absRepoRoot);
    const direct = decomposed.byRelPath.get(relPosix);
    if (direct) {
      return {
        label: direct.label,
        evidencePath: direct.evidencePath,
        isWorkspaceMatch: false,
        isSubBoundary: true,
      };
    }
    const matchedRule = decomposed.rules.find((r) => r.matches(relPosix));
    if (matchedRule) {
      return {
        label: matchedRule.label,
        evidencePath: matchedRule.evidencePath,
        isWorkspaceMatch: false,
        isSubBoundary: true,
      };
    }
    return {
      label: decomposed.defaultUnit.label,
      evidencePath: decomposed.defaultUnit.evidencePath,
      isWorkspaceMatch: false,
      isSubBoundary: true,
    };
  }

  if (workspaceRegistry) {
    const entries = Object.entries(workspaceRegistry);
    if (entries.length > 0) {
      const absFilePath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(absRepoRoot, filePath);

      // Sort by path length descending so nested sub-packages match before outer packages
      entries.sort((a, b) => b[1].length - a[1].length);
      for (const [pkgName, pkgPath] of entries) {
        const absPkgPath = path.resolve(pkgPath);
        if (absFilePath === absPkgPath || absFilePath.startsWith(absPkgPath + path.sep)) {
          return {
            label: pkgName,
            evidencePath: path.relative(absRepoRoot, absPkgPath).replace(/\\/g, '/') || '.',
            isWorkspaceMatch: true,
            isSubBoundary: false,
          };
        }
      }
    }
  }

  let rootLabel = fallbackRootLabel || (repoRoot ? path.basename(absRepoRoot) : 'default');
  if (
    workspaceRegistry &&
    Object.prototype.hasOwnProperty.call(workspaceRegistry, rootLabel) &&
    path.resolve(workspaceRegistry[rootLabel]) !== absRepoRoot
  ) {
    rootLabel = `${rootLabel}-root`;
  }

  return {
    label: rootLabel,
    evidencePath: '.',
    isWorkspaceMatch: false,
    isSubBoundary: false,
  };
}

