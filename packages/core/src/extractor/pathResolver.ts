import path from 'path';
import fs from 'fs';
import ts from 'typescript';
import { WorkspaceRegistry } from './workspaceResolver.js';

interface TsConfigPathMapping {
  configDir: string;
  pathsBaseDir: string;
  hasExplicitBaseUrl: boolean;
  paths: Record<string, string[]>;
}

const tsConfigCache = new Map<string, { mtimeMs: number; mapping: TsConfigPathMapping | null }>();
const tsConfigDirLookupCache = new Map<string, TsConfigPathMapping | null>();
const modulePathResolutionCache = new Map<string, string | null>();

/**
 * Resets per-run filesystem lookup caches in the path resolver.
 * Called at the start of `analyzeTarget()` so repeated lookups within a run are O(1)
 * while subsequent analysis runs always observe fresh filesystem state.
 */
export function clearPathResolverCache(): void {
  tsConfigDirLookupCache.clear();
  modulePathResolutionCache.clear();
}

function loadTsConfigFromFile(configFilePath: string, depth = 0): TsConfigPathMapping | null {
  if (depth > 4 || !fs.existsSync(configFilePath)) return null;
  try {
    const stat = fs.statSync(configFilePath);
    const cached = tsConfigCache.get(configFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.mapping;
    }

    const readResult = ts.readConfigFile(configFilePath, (p) => fs.readFileSync(p, 'utf8'));
    if (readResult.error || !readResult.config || typeof readResult.config !== 'object') {
      tsConfigCache.set(configFilePath, { mtimeMs: stat.mtimeMs, mapping: null });
      return null;
    }

    const configDir = path.dirname(configFilePath);
    const rawConfig = readResult.config as Record<string, any>;
    let baseMapping: TsConfigPathMapping | null = null;
    if (typeof rawConfig.extends === 'string' && rawConfig.extends.startsWith('.')) {
      const extendedPath = rawConfig.extends.endsWith('.json')
        ? path.resolve(configDir, rawConfig.extends)
        : path.resolve(configDir, `${rawConfig.extends}.json`);
      baseMapping = loadTsConfigFromFile(extendedPath, depth + 1);
    }

    const compilerOptions =
      rawConfig.compilerOptions && typeof rawConfig.compilerOptions === 'object'
        ? (rawConfig.compilerOptions as Record<string, any>)
        : {};

    const hasExplicitBaseUrl = typeof compilerOptions.baseUrl === 'string';
    const pathsBaseDir = hasExplicitBaseUrl
      ? path.resolve(configDir, compilerOptions.baseUrl)
      : baseMapping?.hasExplicitBaseUrl
        ? baseMapping.pathsBaseDir
        : configDir;

    const mergedPaths: Record<string, string[]> = {
      ...(baseMapping?.paths ?? {}),
    };
    if (compilerOptions.paths && typeof compilerOptions.paths === 'object') {
      for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
        if (Array.isArray(targets)) {
          mergedPaths[pattern] = targets.filter((t): t is string => typeof t === 'string');
        }
      }
    }

    const mapping: TsConfigPathMapping | null =
      hasExplicitBaseUrl || baseMapping?.hasExplicitBaseUrl || Object.keys(mergedPaths).length > 0
        ? {
            configDir,
            pathsBaseDir,
            hasExplicitBaseUrl: hasExplicitBaseUrl || Boolean(baseMapping?.hasExplicitBaseUrl),
            paths: mergedPaths,
          }
        : null;

    tsConfigCache.set(configFilePath, { mtimeMs: stat.mtimeMs, mapping });
    return mapping;
  } catch {
    return null;
  }
}

function findTsConfigMapping(currentFilePath: string, repoRoot: string): TsConfigPathMapping | null {
  const absRepoRoot = path.resolve(repoRoot);
  const absCurrent = path.isAbsolute(currentFilePath)
    ? currentFilePath
    : path.resolve(absRepoRoot, currentFilePath);

  const startDir = path.dirname(absCurrent);
  const cacheKey = `${absRepoRoot}::${startDir}`;
  if (tsConfigDirLookupCache.has(cacheKey)) {
    return tsConfigDirLookupCache.get(cacheKey) ?? null;
  }

  let dir = startDir;
  while (dir.startsWith(absRepoRoot)) {
    for (const fileName of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = path.join(dir, fileName);
      if (fs.existsSync(candidate)) {
        const mapping = loadTsConfigFromFile(candidate);
        if (mapping) {
          tsConfigDirLookupCache.set(cacheKey, mapping);
          return mapping;
        }
      }
    }
    if (dir === absRepoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const fileName of ['tsconfig.json', 'jsconfig.json']) {
    const rootCandidate = path.join(absRepoRoot, fileName);
    if (fs.existsSync(rootCandidate)) {
      const mapping = loadTsConfigFromFile(rootCandidate);
      if (mapping) {
        tsConfigDirLookupCache.set(cacheKey, mapping);
        return mapping;
      }
    }
  }
  tsConfigDirLookupCache.set(cacheKey, null);
  return null;
}

function tryResolveFileCandidate(targetAbsolutePath: string, repoRoot: string): string | null {
  if (targetAbsolutePath.endsWith('.d.ts')) {
    const base = targetAbsolutePath.slice(0, -5);
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx']) {
      if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) {
        return path.relative(repoRoot, base + ext);
      }
    }
  } else if (targetAbsolutePath.endsWith('.d.mts')) {
    const base = targetAbsolutePath.slice(0, -6);
    for (const ext of ['.mts', '.ts']) {
      if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) {
        return path.relative(repoRoot, base + ext);
      }
    }
  } else if (targetAbsolutePath.endsWith('.d.cts')) {
    const base = targetAbsolutePath.slice(0, -6);
    for (const ext of ['.cts', '.ts']) {
      if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) {
        return path.relative(repoRoot, base + ext);
      }
    }
  } else if (targetAbsolutePath.endsWith('.mjs')) {
    const base = targetAbsolutePath.slice(0, -4);
    for (const ext of ['.mts', '.ts', '.tsx', '.js']) {
      if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) {
        return path.relative(repoRoot, base + ext);
      }
    }
  } else if (targetAbsolutePath.endsWith('.cjs')) {
    const base = targetAbsolutePath.slice(0, -4);
    for (const ext of ['.cts', '.ts', '.tsx', '.js']) {
      if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) {
        return path.relative(repoRoot, base + ext);
      }
    }
  } else if (targetAbsolutePath.endsWith('.js')) {
    // Handle TypeScript ES module imports where .js implies .ts/.tsx/.mts/.cts
    const base = targetAbsolutePath.slice(0, -3);
    for (const ext of [
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.native.ts',
      '.native.tsx',
      '.ios.ts',
      '.ios.tsx',
      '.android.ts',
      '.android.tsx',
      '.web.ts',
      '.web.tsx',
    ]) {
      if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) {
        return path.relative(repoRoot, base + ext);
      }
    }
  }

  const extensions = [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.vue',
    '.svelte',
    '.astro',
    '.mdx',
    '.native.tsx',
    '.native.ts',
    '.native.jsx',
    '.native.js',
    '.ios.tsx',
    '.ios.ts',
    '.android.tsx',
    '.android.ts',
    '.web.tsx',
    '.web.ts',
    '.web.jsx',
    '.web.js',
    '/index.ts',
    '/index.tsx',
    '/index.mts',
    '/index.cts',
    '/index.js',
    '/index.jsx',
    '/index.mjs',
    '/index.cjs',
    '/index.vue',
    '/index.svelte',
    '/index.astro',
    '/index.mdx',
    '/index.native.tsx',
    '/index.native.ts',
    '/index.native.jsx',
    '/index.native.js',
    '/index.ios.tsx',
    '/index.ios.ts',
    '/index.android.tsx',
    '/index.android.ts',
    '/index.web.tsx',
    '/index.web.ts',
    '/index.web.jsx',
    '/index.web.js',
  ];

  for (const ext of extensions) {
    const checkPath = targetAbsolutePath + ext;
    if (fs.existsSync(checkPath) && fs.statSync(checkPath).isFile()) {
      return path.relative(repoRoot, checkPath);
    }
  }

  if (fs.existsSync(targetAbsolutePath) && fs.statSync(targetAbsolutePath).isFile()) {
    return path.relative(repoRoot, targetAbsolutePath);
  }

  return null;
}

/**
 * Resolves an import literal to a canonical repository-relative path.
 * 
 * @param importLiteral The string path from the import statement (e.g. '../services/user')
 * @param currentFilePath The absolute path of the current file
 * @param repoRoot The absolute path of the repository root
 * @param workspaceRegistry Optional registry of monorepo workspace packages
 * @returns The repository-relative path to the target file, or null if it cannot be resolved.
 */
export function resolveModulePath(
  importLiteral: string, 
  currentFilePath: string, 
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): string | null {
  if (typeof importLiteral !== 'string' || !importLiteral) return null;
  const absoluteCurrentFile = path.isAbsolute(currentFilePath)
    ? currentFilePath
    : path.resolve(repoRoot, currentFilePath);
  const currentDir = path.dirname(absoluteCurrentFile);
  const wsKey = workspaceRegistry ? Object.keys(workspaceRegistry).join(',') : '';
  const cacheKey = `${repoRoot}::${currentDir}::${importLiteral}::${wsKey}`;
  if (modulePathResolutionCache.has(cacheKey)) {
    return modulePathResolutionCache.get(cacheKey) ?? null;
  }

  let targetAbsolutePath: string | null = null;
  const workspaceCandidates: string[] = [];

  if (importLiteral.startsWith('.')) {
    targetAbsolutePath = path.resolve(currentDir, importLiteral);
  } else if (workspaceRegistry) {
    // Check if it's a workspace package or a deep import into a workspace package
    for (const [pkgName, pkgPath] of Object.entries(workspaceRegistry)) {
      if (importLiteral === pkgName || importLiteral.startsWith(`${pkgName}/`)) {
        const subPath = importLiteral === pkgName ? '.' : importLiteral.substring(pkgName.length + 1);
        const pkgJsonPath = path.join(pkgPath, 'package.json');
        
        let resolvedRelativePath: string | null = null;
        
        if (fs.existsSync(pkgJsonPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
            if (pkg.exports) {
               resolvedRelativePath = resolveExport(pkg.exports, subPath);
            }
            if (!resolvedRelativePath && subPath === '.' && pkg.main) {
               resolvedRelativePath = pkg.main;
            }
          } catch(e) {}
        }
        
        if (resolvedRelativePath) {
          const normRel = resolvedRelativePath.replace(/\\/g, '/').replace(/^\.\//, '');
          const buildPrefixMatch = normRel.match(/^(?:dist|build|out|lib|esm|cjs)\/(.+)$/);
          if (buildPrefixMatch) {
            workspaceCandidates.push(path.join(pkgPath, 'src', buildPrefixMatch[1]));
          }
          workspaceCandidates.push(path.join(pkgPath, resolvedRelativePath));
        }
        workspaceCandidates.push(path.join(pkgPath, subPath === '.' ? 'index' : subPath));
        workspaceCandidates.push(path.join(pkgPath, 'src', subPath === '.' ? 'index' : subPath));
        break;
      }
    }
  }

  for (const cand of workspaceCandidates) {
    const resolved = tryResolveFileCandidate(cand, repoRoot);
    if (resolved) {
      modulePathResolutionCache.set(cacheKey, resolved);
      return resolved;
    }
  }

  if (targetAbsolutePath) {
    const resolved = tryResolveFileCandidate(targetAbsolutePath, repoRoot);
    if (resolved) {
      modulePathResolutionCache.set(cacheKey, resolved);
      return resolved;
    }
  }

  // Try tsconfig.json / jsconfig.json compilerOptions.paths and compilerOptions.baseUrl ([PAT-EXT-29])
  if (!importLiteral.startsWith('.')) {
    const tsMapping = findTsConfigMapping(currentFilePath, repoRoot);
    if (tsMapping) {
      for (const [pattern, targets] of Object.entries(tsMapping.paths)) {
        const starIdx = pattern.indexOf('*');
        if (starIdx === -1) {
          if (pattern === importLiteral) {
            for (const target of targets) {
              const candidateAbs = path.resolve(tsMapping.pathsBaseDir, target);
              const resolved = tryResolveFileCandidate(candidateAbs, repoRoot);
              if (resolved) {
                modulePathResolutionCache.set(cacheKey, resolved);
                return resolved;
              }
            }
          }
        } else {
          const prefix = pattern.slice(0, starIdx);
          const suffix = pattern.slice(starIdx + 1);
          if (
            importLiteral.startsWith(prefix) &&
            importLiteral.endsWith(suffix) &&
            importLiteral.length >= prefix.length + suffix.length
          ) {
            const matchedWildcard = importLiteral.slice(
              prefix.length,
              importLiteral.length - suffix.length
            );
            for (const target of targets) {
              const substituted = target.replace(/\*/g, matchedWildcard);
              const candidateAbs = path.resolve(tsMapping.pathsBaseDir, substituted);
              const resolved = tryResolveFileCandidate(candidateAbs, repoRoot);
              if (resolved) {
                modulePathResolutionCache.set(cacheKey, resolved);
                return resolved;
              }
            }
          }
        }
      }

      if (tsMapping.hasExplicitBaseUrl) {
        const candidateAbs = path.resolve(tsMapping.pathsBaseDir, importLiteral);
        const absRepoRoot = path.resolve(repoRoot);
        if (
          (candidateAbs === absRepoRoot || candidateAbs.startsWith(absRepoRoot + path.sep)) &&
          !candidateAbs.split(path.sep).includes('node_modules')
        ) {
          const resolved = tryResolveFileCandidate(candidateAbs, repoRoot);
          if (resolved) {
            modulePathResolutionCache.set(cacheKey, resolved);
            return resolved;
          }
        }
      }
    }

    // Conventional SvelteKit `$lib/...` alias fallback when `.svelte-kit/tsconfig.json` is not generated.
    if (importLiteral === '$lib' || importLiteral.startsWith('$lib/')) {
      const subPath = importLiteral === '$lib' ? 'index' : importLiteral.slice('$lib/'.length);
      const absRepoRoot = path.resolve(repoRoot);
      let pkgRoot = path.dirname(path.resolve(currentFilePath));
      while (pkgRoot.startsWith(absRepoRoot)) {
        if (fs.existsSync(path.join(pkgRoot, 'package.json'))) break;
        if (pkgRoot === absRepoRoot) break;
        const parent = path.dirname(pkgRoot);
        if (parent === pkgRoot) break;
        pkgRoot = parent;
      }
      if (!pkgRoot.startsWith(absRepoRoot)) {
        pkgRoot = absRepoRoot;
      }
      for (const baseCandidate of [
        path.join(pkgRoot, 'src', 'lib', subPath),
        path.join(pkgRoot, 'lib', subPath),
      ]) {
        const resolved = tryResolveFileCandidate(baseCandidate, repoRoot);
        if (resolved) {
          modulePathResolutionCache.set(cacheKey, resolved);
          return resolved;
        }
      }
    }

    // Conventional Nuxt 4 / Vite / Next.js root alias fallback (`~/...` or `@/...`)
    // when `.nuxt/tsconfig.json` is not committed or `paths` is absent.
    if (importLiteral.startsWith('~/') || importLiteral.startsWith('@/')) {
      const subPath = importLiteral.slice(2);
      const absRepoRoot = path.resolve(repoRoot);
      let pkgRoot = path.dirname(path.resolve(currentFilePath));
      while (pkgRoot.startsWith(absRepoRoot)) {
        if (fs.existsSync(path.join(pkgRoot, 'package.json'))) break;
        if (pkgRoot === absRepoRoot) break;
        const parent = path.dirname(pkgRoot);
        if (parent === pkgRoot) break;
        pkgRoot = parent;
      }
      if (!pkgRoot.startsWith(absRepoRoot)) {
        pkgRoot = absRepoRoot;
      }
      for (const baseCandidate of [
        path.join(pkgRoot, 'app', subPath),
        path.join(pkgRoot, 'src', subPath),
        path.join(pkgRoot, subPath),
      ]) {
        const resolved = tryResolveFileCandidate(baseCandidate, repoRoot);
        if (resolved) {
          modulePathResolutionCache.set(cacheKey, resolved);
          return resolved;
        }
      }
    }
  }

  modulePathResolutionCache.set(cacheKey, null);
  return null;
}
export function resolveExport(exportsObj: any, subPath: string): string | null {
  if (!exportsObj) return null;
  const key = subPath === '.' ? '.' : `./${subPath}`;
  
  if (typeof exportsObj === 'string') {
    return subPath === '.' ? exportsObj : null;
  }

  // If subPath is '.' and there are no subpath keys (i.e. keys starting with '.'), 
  // it might be a conditional export block directly.
  const hasSubpathKeys = Object.keys(exportsObj).some(k => k.startsWith('.'));
  if (subPath === '.' && !hasSubpathKeys) {
    return resolveExportValue(exportsObj);
  }

  // Handle exact subpath match
  if (exportsObj[key]) {
    return resolveExportValue(exportsObj[key]);
  }

  // Handle wildcard mapping (e.g. "./*": "./src/*.ts")
  for (const [exportKey, exportVal] of Object.entries(exportsObj)) {
    if (exportKey.includes('*')) {
      const regex = new RegExp('^' + exportKey.replace(/\*/g, '(.*)') + '$');
      const match = key.match(regex);
      if (match && match[1]) {
        const resolvedVal = resolveExportValue(exportVal);
        if (resolvedVal) {
          return resolvedVal.replace(/\*/g, match[1]);
        }
      }
    }
  }

  return null;
}

function resolveExportValue(value: any): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    // Priority for AST extraction: types, source, default, import, require
    if (value.types) return resolveExportValue(value.types);
    if (value.source) return resolveExportValue(value.source);
    if (value.import) return resolveExportValue(value.import);
    if (value.require) return resolveExportValue(value.require);
    if (value.default) return resolveExportValue(value.default);
  }
  return null;
}
