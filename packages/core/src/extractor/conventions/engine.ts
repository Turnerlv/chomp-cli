// packages/core/src/extractor/conventions/engine.ts
//
// Interprets `ConventionSet` data. Pure and framework-agnostic: it knows AST *forms*
// (exported function, `export { X as Y }`, call to an identifier, ...), never a framework.

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { stableEntityId } from '../../utils/id.js';
import type {
  CallArg0Matcher,
  ConventionRule,
  ConventionSet,
  EdgeMatcher,
  EdgeTargetResolvers,
  NodeMatch,
  NodeMatcher,
} from './types.js';
import { extractConventionPortValves } from './portConventions.js';

// ── Framework version matching (`meta.versions`, `[PAT-EXT-28]`) ────────────────────────────

const FRAMEWORK_PACKAGE_NAMES: Readonly<Record<string, readonly string[]>> = {
  nextjs: ['next'],
  react: ['react', 'react-dom'],
  express: ['express'],
  mcp: ['@modelcontextprotocol/sdk'],
  drizzle: ['drizzle-orm'],
  payload: ['payload', '@payloadcms/next'],
  astro: ['astro'],
  sveltekit: ['@sveltejs/kit', 'svelte'],
};

type SemverTuple = readonly [number, number, number];

function parseConcreteVersion(raw: string): SemverTuple | null {
  const m = /(?:^|[^\d])v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] !== undefined ? Number(m[2]) : 0;
  const patch = m[3] !== undefined ? Number(m[3]) : 0;
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return [major, minor, patch];
}

function compareSemver(a: SemverTuple, b: SemverTuple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

interface ParsedComparator {
  op: '>=' | '>' | '<=' | '<' | '=' | '^' | '~' | 'wildcard';
  major: number;
  minor?: number;
  patch?: number;
}

function parseComparatorToken(token: string): ParsedComparator | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (trimmed === '*' || trimmed === 'x' || trimmed === 'X') {
    return { op: 'wildcard', major: -1 };
  }
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    trimmed
  );
  if (!m) return null;
  const rawOp = m[1] ?? '';
  const majStr = m[2];
  const minStr = m[3];
  const patStr = m[4];

  if (majStr === 'x' || majStr === 'X' || majStr === '*') {
    return rawOp ? null : { op: 'wildcard', major: -1 };
  }
  const major = Number(majStr);
  const minorIsWild = minStr === 'x' || minStr === 'X' || minStr === '*';
  const patchIsWild = patStr === 'x' || patStr === 'X' || patStr === '*';
  const minor = minStr !== undefined && !minorIsWild ? Number(minStr) : undefined;
  const patch = patStr !== undefined && !patchIsWild ? Number(patStr) : undefined;

  if (!rawOp && (minorIsWild || patchIsWild || minStr === undefined)) {
    return { op: 'wildcard', major, ...(minor !== undefined ? { minor } : {}) };
  }

  const op = (rawOp || '=') as ParsedComparator['op'];
  return {
    op,
    major,
    ...(minor !== undefined ? { minor } : {}),
    ...(patch !== undefined ? { patch } : {}),
  };
}

function evalComparator(ver: SemverTuple, comp: ParsedComparator): boolean {
  if (comp.op === 'wildcard') {
    if (comp.major < 0) return true;
    if (ver[0] !== comp.major) return false;
    if (comp.minor !== undefined && ver[1] !== comp.minor) return false;
    return true;
  }

  const target: SemverTuple = [comp.major, comp.minor ?? 0, comp.patch ?? 0];
  switch (comp.op) {
    case '>=':
      return compareSemver(ver, target) >= 0;
    case '>': {
      if (comp.minor === undefined) return ver[0] > comp.major;
      if (comp.patch === undefined) {
        return ver[0] > comp.major || (ver[0] === comp.major && ver[1] > comp.minor);
      }
      return compareSemver(ver, target) > 0;
    }
    case '<=': {
      if (comp.minor === undefined) return ver[0] <= comp.major;
      if (comp.patch === undefined) {
        return ver[0] < comp.major || (ver[0] === comp.major && ver[1] <= comp.minor);
      }
      return compareSemver(ver, target) <= 0;
    }
    case '<':
      return compareSemver(ver, target) < 0;
    case '=': {
      if (comp.minor === undefined) return ver[0] === comp.major;
      if (comp.patch === undefined) return ver[0] === comp.major && ver[1] === comp.minor;
      return compareSemver(ver, target) === 0;
    }
    case '^': {
      if (compareSemver(ver, target) < 0) return false;
      if (comp.major > 0) return ver[0] === comp.major;
      if ((comp.minor ?? 0) > 0) return ver[0] === 0 && ver[1] === comp.minor;
      return ver[0] === 0 && ver[1] === 0 && ver[2] === (comp.patch ?? 0);
    }
    case '~': {
      if (compareSemver(ver, target) < 0) return false;
      if (comp.minor === undefined) return ver[0] === comp.major;
      return ver[0] === comp.major && ver[1] === comp.minor;
    }
  }
}

function parseVersionRangeClauses(range: string): ParsedComparator[][] | null {
  const trimmed = range.trim();
  if (!trimmed) return null;
  const orParts = trimmed.split('||');
  const clauses: ParsedComparator[][] = [];
  for (const rawClause of orParts) {
    const normalized = rawClause
      .trim()
      .replace(/(v?\d+(?:\.\d+)*)\s+-\s+(v?\d+(?:\.\d+)*)/g, '>=$1 <=$2')
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
    if (!normalized) return null;
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const comps: ParsedComparator[] = [];
    for (const tok of tokens) {
      const parsed = parseComparatorToken(tok);
      if (!parsed) return null;
      comps.push(parsed);
    }
    clauses.push(comps);
  }
  return clauses.length > 0 ? clauses : null;
}

/** True when `range` is a syntactically valid semver range expression for `ConventionRule.meta.versions`. */
export function isValidVersionRange(range: string): boolean {
  return parseVersionRangeClauses(range) !== null;
}

/**
 * Checks whether an installed package version specifier (from `package.json`, e.g. `"^14.2.0"`, `"13.3.0"`)
 * satisfies a `ConventionRule.meta.versions` range (e.g. `">=13.4"`, `">=14"`).
 *
 * By the Principle of Incomplete Truth, if the project does not declare an installed version for the
 * framework (or uses a non-semver specifier such as `"workspace:*"` or `"latest"`), returns `true`
 * so convention rules are only suppressed when concrete version evidence disproves applicability.
 */
export function satisfiesConventionVersion(
  installedSpecifier: string | undefined,
  requiredRange: string | undefined
): boolean {
  if (!requiredRange || !requiredRange.trim()) return true;
  if (!installedSpecifier || !installedSpecifier.trim()) return true;

  const concrete = parseConcreteVersion(installedSpecifier);
  if (!concrete) return true;

  const clauses = parseVersionRangeClauses(requiredRange);
  if (!clauses) return true;

  return clauses.some((clause) => clause.every((comp) => evalComparator(concrete, comp)));
}

const packageVersionCache = new Map<string, Readonly<Record<string, string>>>();

/**
 * Resolves installed framework version specifiers by walking up from `sourceFilePath` to enclosing
 * `package.json` manifests (nearest manifest wins). Cached per directory.
 */
export function resolveInstalledFrameworkVersions(
  sourceFilePath: string | undefined
): Readonly<Record<string, string>> {
  if (!sourceFilePath || !path.isAbsolute(sourceFilePath)) return {};
  const startDir = path.dirname(sourceFilePath);
  const cached = packageVersionCache.get(startDir);
  if (cached) return cached;

  const merged: Record<string, string> = {};
  let curDir = startDir;
  for (let depth = 0; depth < 7; depth++) {
    const pkgJsonPath = path.join(curDir, 'package.json');
    try {
      if (fs.existsSync(pkgJsonPath)) {
        const raw = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
        for (const sectionKey of ['dependencies', 'devDependencies', 'peerDependencies']) {
          const section = raw[sectionKey];
          if (section && typeof section === 'object') {
            for (const [pkgName, ver] of Object.entries(section as Record<string, unknown>)) {
              if (typeof ver === 'string' && merged[pkgName] === undefined) {
                merged[pkgName] = ver;
              }
            }
          }
        }
      }
    } catch {
      // Ignore unreadable or malformed package.json files
    }
    const parent = path.dirname(curDir);
    if (parent === curDir) break;
    curDir = parent;
  }

  for (const [framework, pkgNames] of Object.entries(FRAMEWORK_PACKAGE_NAMES)) {
    if (merged[framework] !== undefined) continue;
    for (const pkgName of pkgNames) {
      if (merged[pkgName] !== undefined) {
        merged[framework] = merged[pkgName];
        break;
      }
    }
  }

  packageVersionCache.set(startDir, merged);
  return merged;
}

function lookupFrameworkVersion(
  framework: string,
  versions: Readonly<Record<string, string>>
): string | undefined {
  if (versions[framework] !== undefined) return versions[framework];
  for (const pkgName of FRAMEWORK_PACKAGE_NAMES[framework] ?? []) {
    if (versions[pkgName] !== undefined) return versions[pkgName];
  }
  return undefined;
}

// ── File roles ───────────────────────────────────────────────────────────────────────────────

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds the extension alternation for file roles: the set's base extensions plus any extensions
 * the project configured. Longest first, so `dev.tsx` is never shadowed by `tsx`.
 */
function extensionPattern(set: ConventionSet, configuredExtensions: readonly string[]): string {
  const all = [...new Set([...set.baseExtensions, ...configuredExtensions])];
  return all
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
}

export interface ClassifyFileRoleOptions {
  /** Absolute source file path used to check installed framework version (e.g. Next.js `< 13.4` before `_folder` opt-out). */
  sourceFilePath?: string;
  /** Underscore-prefixed route subtrees (e.g. `app/_hooks`, `app/_patterns`) proven to host a nested layout/page route hierarchy. */
  routedUnderscorePrefixes?: ReadonlySet<string>;
}

function hasAncestorConfigFile(
  sourceFilePath: string | undefined,
  configNames: readonly string[]
): boolean {
  if (!sourceFilePath || !path.isAbsolute(sourceFilePath)) return false;
  let curDir = path.dirname(sourceFilePath);
  for (let depth = 0; depth < 7; depth++) {
    for (const cfg of configNames) {
      try {
        if (fs.existsSync(path.join(curDir, cfg))) return true;
      } catch {
        // Ignore stat errors
      }
    }
    const parent = path.dirname(curDir);
    if (parent === curDir) break;
    curDir = parent;
  }
  return false;
}

/**
 * Classifies a relative file path into the structural role it plays in the framework, or null.
 * Rules are tried in declaration order; the first match wins.
 *
 * @param configuredExtensions Extra extensions the project's own config enabled (e.g. `dev.tsx`).
 */
export function classifyFileRole(
  set: ConventionSet,
  relativeFilePath: string,
  configuredExtensions: readonly string[] = [],
  options?: ClassifyFileRoleOptions
): string | null {
  const normalized = relativeFilePath.replace(/\\/g, '/');
  const ext = extensionPattern(set, configuredExtensions);

  for (const rule of set.fileRoles) {
    const svelteLayoutResetSuffix =
      set.framework === 'sveltekit' && rule.fileName.startsWith('+') ? '(?:@[A-Za-z0-9_-]*)?' : '';
    const name =
      rule.fileName === '*'
        ? '([^/]+)'
        : `${escapeRegExp(rule.fileName)}${svelteLayoutResetSuffix}`;
    if (rule.under) {
      const underEsc = escapeRegExp(rule.under);
      const match = new RegExp(
        `(?:^|\\/)${underEsc}\\/((?:.*\\/)?)${name}\\.(?:${ext})$`
      ).exec(normalized);
      if (!match) continue;
      // Next.js App Router Private Folders (`_folder`, introduced in Next.js 13.4) opt the folder
      // and its subfolders out of routing unless:
      // 1. The installed `next` version predates `< 13.4.0`, OR
      // 2. The repository explicitly structures `app/_<seg>/...` as a multi-file route subtree
      //    (`layout.<ext>` + nested `<child>/page.<ext>`, e.g. `vercel/next-app-router-playground`
      //    `app/_hooks/**` and `app/_patterns/**`).
      if (set.framework === 'nextjs') {
        const subSegments = (match[1] ?? '').split('/').filter(Boolean);
        if (subSegments.some((seg) => seg.startsWith('_'))) {
          const versions = resolveInstalledFrameworkVersions(options?.sourceFilePath);
          const nextVer = lookupFrameworkVersion('nextjs', versions);
          const isPrePrivateFolderNext =
            nextVer !== undefined && !satisfiesConventionVersion(nextVer, '>=13.4.0');
          const fullMatchedPrefix = `${rule.under}/${subSegments[0]}`;
          const isRoutedSubtree = Boolean(
            subSegments.length >= 1 &&
              subSegments[0].startsWith('_') &&
              !subSegments.slice(1).some((seg) => seg.startsWith('_')) &&
              options?.routedUnderscorePrefixes?.has(fullMatchedPrefix)
          );
          if (!isPrePrivateFolderNext && !isRoutedSubtree) {
            continue;
          }
        }
      } else if (set.framework === 'astro') {
        // Astro excludes `_`-prefixed directories and filenames under `pages/` from routing.
        const subSegments = (match[1] ?? '').split('/').filter(Boolean);
        const leafName = match[2] ?? path.posix.basename(normalized);
        if (subSegments.some((seg) => seg.startsWith('_')) || leafName.startsWith('_')) {
          continue;
        }
        // Non-`.astro` files under `pages/` (`.ts`, `.js`, `.mdx`) require Astro project evidence
        // when `sourceFilePath` is provided so Next.js Pages Router `pages/**` files never match.
        if (!normalized.toLowerCase().endsWith('.astro') && options?.sourceFilePath) {
          const versions = resolveInstalledFrameworkVersions(options.sourceFilePath);
          const hasAstroDep = versions['astro'] !== undefined;
          const hasAstroCfg = hasAncestorConfigFile(options.sourceFilePath, [
            'astro.config.mjs',
            'astro.config.ts',
            'astro.config.js',
            'astro.config.cjs',
          ]);
          if (!hasAstroDep && !hasAstroCfg) {
            continue;
          }
        }
      }
      return rule.role;
    }
    if (set.framework === 'sveltekit' && rule.role === 'HOOKS' && rule.fileName === 'hooks') {
      if (!new RegExp(`^(?:src\\/)?hooks\\.(?:${ext})$`).test(normalized)) {
        continue;
      }
      if (options?.sourceFilePath) {
        const versions = resolveInstalledFrameworkVersions(options.sourceFilePath);
        const hasSvelteKitDep = versions['@sveltejs/kit'] !== undefined;
        const hasSvelteCfg = hasAncestorConfigFile(options.sourceFilePath, [
          'svelte.config.js',
          'svelte.config.ts',
          'svelte.config.mjs',
          'svelte.config.cjs',
        ]);
        if (!hasSvelteKitDep && !hasSvelteCfg) {
          continue;
        }
      }
      return rule.role;
    }
    const pattern = `(?:^|\\/)${name}\\.(?:${ext})$`;
    if (new RegExp(pattern).test(normalized)) return rule.role;
  }
  return null;
}

// ── Node matchers ────────────────────────────────────────────────────────────────────────────

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.FunctionDeclaration | ts.VariableStatement).modifiers;
  return !!modifiers?.some((m) => m.kind === kind);
}

/** True when `statement` is the string-literal directive prologue entry `'<directive>'`. */
function isDirective(statement: ts.Statement | undefined, directive: string): boolean {
  return (
    !!statement &&
    ts.isExpressionStatement(statement) &&
    ts.isStringLiteral(statement.expression) &&
    statement.expression.text === directive
  );
}

/** Function-level directive (first statement of the function/arrow body). */
function hasFunctionBodyDirective(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  directive: string
): boolean {
  return !!fn.body && ts.isBlock(fn.body) && isDirective(fn.body.statements[0], directive);
}

/** File-level directive (first statement of the file) or function-level (first statement of the body). */
function hasDirective(fn: ts.FunctionDeclaration, directive: string): boolean {
  const sourceFile = fn.getSourceFile();
  if (isDirective(sourceFile.statements[0], directive)) return true;
  return hasFunctionBodyDirective(fn, directive);
}

/** Text of a callee that is a bare identifier (`memo`) or a dotted path (`React.memo`), else null. */
function calleePath(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(expr)) {
    const head = calleePath(expr.expression);
    return head ? `${head}.${expr.name.text}` : null;
  }
  return null;
}

/** Known client-side HTTP library receiver identifiers that must not be extracted as server routes. */
export const KNOWN_HTTP_CLIENT_IDENTIFIERS: readonly string[] = [
  'axios',
  'apiClient',
  'axiosInstance',
  'httpInstance',
  'httpClient',
  'client',
  'api',
  'http',
  'got',
  'ky',
  'superagent',
  'fetch',
];

/**
 * Checks if a receiver path refers to a known HTTP client identifier or matches custom receiver exclusions.
 * Matches exact identifier name or any dotted segment (e.g. `window.axios`, `this.client`, `api.v1`).
 */
export function isHttpClientReceiver(recv: string | null, extraExclusions?: readonly string[]): boolean {
  if (!recv) return false;
  const list = extraExclusions
    ? [...KNOWN_HTTP_CLIENT_IDENTIFIERS, ...extraExclusions]
    : KNOWN_HTTP_CLIENT_IDENTIFIERS;
  const lowerTargets = new Set(list.map((s) => s.toLowerCase()));
  const segments = recv.split('.');
  return segments.some((seg) => {
    const lower = seg.toLowerCase();
    return (
      lowerTargets.has(lower) ||
      lower === 'interceptors' ||
      lower.endsWith('client') ||
      lower.endsWith('request') ||
      lower.endsWith('api')
    );
  });
}

function isEnclosingFunctionParam(node: ts.Node, identName: string): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      for (const param of cur.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === identName) {
          return true;
        }
      }
    }
    cur = cur.parent;
  }
  return false;
}

/**
 * Returns all public exported names for a top-level statement's declared identifier (`localName`),
 * accounting for both direct `export` modifiers and same-file `export { localName, localName as alias }`
 * declarations without a module specifier (`[PAT-EXT-13]`, `[PAT-EXT-25]`).
 */
function exportedNamesForStatement(stmt: ts.Statement, localName: string): string[] {
  const names: string[] = [];
  if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
    names.push(localName);
  }
  const sourceFile = stmt.parent && ts.isSourceFile(stmt.parent) ? stmt.parent : undefined;
  if (sourceFile) {
    for (const s of sourceFile.statements) {
      if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
        for (const el of s.exportClause.elements) {
          const origName = (el.propertyName ?? el.name).text;
          if (origName === localName) {
            names.push(el.name.text);
          }
        }
      } else if (ts.isExportAssignment(s) && !s.isExportEquals && ts.isIdentifier(s.expression)) {
        if (s.expression.text === localName) {
          names.push(localName);
        }
      }
    }
  }
  return Array.from(new Set(names));
}

/** Resolves a local identifier to a function declaration or function-initialized variable in `sourceFile`. */
function findSameFileFunctionByName(
  name: string,
  sourceFile: ts.SourceFile | undefined,
  wrappers: readonly string[]
): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null {
  if (!sourceFile) return null;
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      return stmt;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            return decl.initializer;
          }
          const inner = unwrapWrappedFunction(decl.initializer, wrappers);
          if (inner) return inner;
        }
      }
    }
  }
  return null;
}

/**
 * Unwraps `WRAP(fn)` (possibly nested: `memo(forwardRef(fn))`) to the function/arrow expression
 * inside (or same-file function declaration when `sourceFile` is supplied), or null when `expr` is
 * not a wrapper call around a proven function. Only the FIRST argument is followed: that is where a
 * higher-order component keeps the function it wraps.
 */
export function unwrapWrappedFunction(
  expr: ts.Expression,
  wrappers: readonly string[],
  sourceFile?: ts.SourceFile
): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null {
  let current = expr;
  let unwrapped = false;
  while (ts.isCallExpression(current)) {
    const callee = calleePath(current.expression);
    if (!callee || !wrappers.includes(callee) || current.arguments.length === 0) return null;
    current = current.arguments[0];
    unwrapped = true;
  }
  if (!unwrapped) return null;
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return current;
  if (sourceFile && ts.isIdentifier(current)) {
    return findSameFileFunctionByName(current.text, sourceFile, wrappers);
  }
  return null;
}

function isRawNodeHttpServerInFile(sourceFile: ts.SourceFile): boolean {
  if (
    !/\bexpress\b/i.test(sourceFile.text) &&
    sourceFile.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        /^(?:node:)?(?:http|https|http2|net|tls)$|^stoppable$/.test(s.moduleSpecifier.text)
    )
  ) {
    return true;
  }
  let foundRawServerDecl = false;
  const checkCall = (call: ts.CallExpression): boolean => {
    const callee = calleePath(call.expression);
    if (
      callee === 'stoppable' &&
      call.arguments.length > 0 &&
      ts.isCallExpression(call.arguments[0])
    ) {
      return checkCall(call.arguments[0]);
    }
    if (
      callee !== 'createServer' &&
      callee !== 'http.createServer' &&
      callee !== 'https.createServer' &&
      callee !== 'net.createServer' &&
      callee !== 'tls.createServer'
    ) {
      return false;
    }
    if (
      call.arguments.some((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) ||
      !/\bexpress\b/i.test(sourceFile.text)
    ) {
      return true;
    }
    return false;
  };
  const visit = (n: ts.Node) => {
    if (foundRawServerDecl) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'server' &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      checkCall(n.initializer)
    ) {
      foundRawServerDecl = true;
      return;
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === 'server' &&
      ts.isCallExpression(n.right) &&
      checkCall(n.right)
    ) {
      foundRawServerDecl = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return foundRawServerDecl;
}

const drizzleTableCreatorCache = new WeakMap<ts.SourceFile, Set<string>>();
const DRIZZLE_CREATOR_FACTORIES = new Set([
  'pgTableCreator',
  'mysqlTableCreator',
  'sqliteTableCreator',
]);

function isSameFileDrizzleTableCreator(
  sourceFile: ts.SourceFile | undefined,
  identName: string
): boolean {
  if (!sourceFile) return false;
  if (!drizzleTableCreatorCache.has(sourceFile)) {
    const built = new Set<string>();
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isCallExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          DRIZZLE_CREATOR_FACTORIES.has(decl.initializer.expression.text)
        ) {
          built.add(decl.name.text);
        }
      }
    }
    drizzleTableCreatorCache.set(sourceFile, built);
  }
  return drizzleTableCreatorCache.get(sourceFile)?.has(identName) ?? false;
}

/** Finds every place `node` matches `matcher`. Order is source order within the node. */
export function matchNode(node: ts.Node, matcher: NodeMatcher): NodeMatch[] {
  const matches: NodeMatch[] = [];

  switch (matcher.kind) {
    case 'exportedFunction': {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        (matcher.names === '*' || matcher.names.includes(node.name.text)) &&
        ((hasModifier(node, ts.SyntaxKind.ExportKeyword) &&
          (!matcher.directive || hasDirective(node, matcher.directive))) ||
          (Boolean(matcher.directive) && hasFunctionBodyDirective(node, matcher.directive!)))
      ) {
        matches.push({ bindings: { name: node.name.text, originalName: node.name.text }, evidenceNode: node });
      } else if (Boolean(matcher.directive) && ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          if (matcher.names !== '*' && !matcher.names.includes(decl.name.text)) continue;
          if (!ts.isArrowFunction(decl.initializer) && !ts.isFunctionExpression(decl.initializer)) continue;
          if (hasFunctionBodyDirective(decl.initializer, matcher.directive!)) {
            matches.push({
              bindings: { name: decl.name.text, originalName: decl.name.text },
              evidenceNode: node,
              innerFunction: decl.initializer,
            });
          }
        }
      }
      break;
    }

    case 'exportedWrappedFunction': {
      if (ts.isVariableStatement(node)) {
        const sf = node.parent && ts.isSourceFile(node.parent) ? node.parent : undefined;
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const exportedNames = exportedNamesForStatement(node, decl.name.text);
          if (exportedNames.length === 0) continue;
          const inner = unwrapWrappedFunction(decl.initializer, matcher.wrappers, sf);
          if (inner) {
            for (const expName of exportedNames) {
              matches.push({
                bindings: { name: expName, originalName: decl.name.text },
                evidenceNode: node,
                innerFunction: inner,
              });
            }
          }
        }
      } else if (ts.isExportAssignment(node) && !node.isExportEquals) {
        const sf = node.parent && ts.isSourceFile(node.parent) ? node.parent : undefined;
        const inner = unwrapWrappedFunction(node.expression, matcher.wrappers, sf);
        const fnName =
          inner && (ts.isFunctionDeclaration(inner) || ts.isFunctionExpression(inner)) && inner.name
            ? inner.name.text
            : null;
        if (inner && fnName) {
          matches.push({
            bindings: { name: fnName, originalName: fnName },
            evidenceNode: node,
            innerFunction: inner,
          });
        }
      }
      break;
    }

    case 'exportedDestructured': {
      if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isObjectBindingPattern(decl.name)) continue;
          for (const element of decl.name.elements) {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name) && matcher.names.includes(element.name.text)) {
              matches.push({
                bindings: { name: element.name.text, originalName: element.name.text },
                evidenceNode: node,
              });
            }
          }
        }
      }
      break;
    }

    case 'defaultExportedFunction': {
      if (
        ts.isFunctionDeclaration(node) &&
        (!matcher.requireName || node.name) &&
        hasModifier(node, ts.SyntaxKind.ExportKeyword) &&
        hasModifier(node, ts.SyntaxKind.DefaultKeyword)
      ) {
        const componentName = node.name?.text ?? 'anonymous';
        matches.push({ bindings: { componentName, originalName: componentName }, evidenceNode: node });
      }
      break;
    }

    case 'exportAlias': {
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const specifier of node.exportClause.elements) {
          if (specifier.name.text === matcher.exportedName) {
            matches.push({
              bindings: {
                originalName: specifier.propertyName?.text ?? specifier.name.text,
                exportedName: specifier.name.text,
              },
              evidenceNode: node,
            });
          }
        }
      }
      break;
    }

    case 'exportedConst': {
      if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && matcher.names.includes(decl.name.text)) {
            matches.push({ bindings: { name: decl.name.text, originalName: decl.name.text }, evidenceNode: node });
          }
        }
      }
      break;
    }

    case 'callToIdentifier': {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && matcher.names.includes(node.expression.text)) {
        matches.push({
          bindings: { name: node.expression.text, originalName: node.expression.text },
          evidenceNode: node,
        });
      }
      break;
    }

    case 'callToMember': {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) break;
      const method = node.expression.name.text;
      if (matcher.methods !== '*' && !matcher.methods.includes(method)) break;
      if (matcher.minArgs !== undefined && node.arguments.length < matcher.minArgs) break;
      if (matcher.maxArgs !== undefined && node.arguments.length > matcher.maxArgs) break;

      const recv = calleePath(node.expression.expression);
      if (matcher.receivers && (!recv || !matcher.receivers.includes(recv))) break;
      if (method === 'listen' && recv === 'server' && isRawNodeHttpServerInFile(node.getSourceFile())) {
        break;
      }
      if (
        matcher.receiverEndsWith &&
        (!recv || !matcher.receiverEndsWith.some((suffix) => recv === suffix || recv.endsWith(`.${suffix}`)))
      ) {
        break;
      }
      if (matcher.excludeReceivers && recv && isHttpClientReceiver(recv, matcher.excludeReceivers)) {
        break;
      }
      if (matcher.arg0 === 'routePathLiteral' && recv && isHttpClientReceiver(recv)) {
        break;
      }

      const baseBindings: Record<string, string> = {
        method,
        METHOD: method.toUpperCase(),
        callee: calleePath(node.expression) ?? method,
        originalName: method,
      };

      if (matcher.arg0) {
        const arg0 = matchCallArg0(node, matcher.arg0);
        if (arg0 === null) break;
        baseBindings.arg0 = arg0;
      }

      if (matcher.schemaObjectArg) {
        const schemaInfo = extractSchemaObjectArg(node, method, matcher.schemaObjectArg);
        if (schemaInfo) Object.assign(baseBindings, schemaInfo);
      }

      if (matcher.expandValues) {
        for (const value of matcher.expandValues) {
          matches.push({
            bindings: { ...baseBindings, value, VALUE: value.toUpperCase() },
            evidenceNode: node,
          });
        }
      } else {
        matches.push({ bindings: baseBindings, evidenceNode: node });
      }
      break;
    }

    case 'callUseTarget': {
      const parsed = parseCallUseTarget(node);
      if (!parsed) break;
      const wantMiddleware = matcher.targetKind === 'middleware';
      if (parsed.isMiddleware === wantMiddleware) {
        matches.push({
          bindings: {
            pathPrefix: parsed.pathPrefix,
            target: parsed.target,
            originalName: parsed.target,
          },
          evidenceNode: node,
        });
      }
      break;
    }

    case 'variableInitializedByCall': {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression)
      ) {
        const calleeName = node.initializer.expression.text;
        const isDrizzleTableCreatorCall =
          calleeName === 'createTable'
            ? node.initializer.arguments.length >= 2 &&
              ts.isStringLiteralLike(node.initializer.arguments[0])
            : matcher.callees.includes('createTable') &&
              node.initializer.arguments.length >= 2 &&
              ts.isStringLiteralLike(node.initializer.arguments[0]) &&
              isSameFileDrizzleTableCreator(node.getSourceFile(), calleeName);
        if (
          (matcher.callees.includes(calleeName) &&
            (calleeName !== 'createTable' || isDrizzleTableCreatorCall)) ||
          isDrizzleTableCreatorCall
        ) {
          matches.push({
            bindings: {
              name: node.name.text,
              callee: calleeName,
              originalName: node.name.text,
            },
            evidenceNode: node,
          });
        }
      }
      break;
    }

    case 'fluentCallChain': {
      if (!ts.isCallExpression(node)) break;
      // Only match the topmost call of a fluent chain.
      if (
        node.parent &&
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.parent &&
        ts.isCallExpression(node.parent.parent)
      ) {
        break;
      }
      const { rootName, entryMethod, schemaName, isRelational } = unwindFluentChain(
        node,
        matcher.schemaArgMethods,
        matcher.relationalQueryMethods
      );
      if (!rootName || !entryMethod) break;
      if (!matcher.roots.includes(rootName)) break;
      const validEntry = isRelational
        ? (matcher.relationalQueryMethods?.includes(entryMethod) ?? false)
        : matcher.entryMethods.includes(entryMethod);
      if (!validEntry) break;

      const bindings: Record<string, string> = {
        root: rootName,
        entryMethod,
        originalName: entryMethod,
      };
      if (schemaName) {
        const isMutate = !isRelational && matcher.mutateMethods.includes(entryMethod);
        bindings.schema = schemaName;
        bindings.relType = isMutate ? 'MUTATES' : 'READS';
        bindings.relTypeLower = isMutate ? 'mutates' : 'reads';
      }
      matches.push({ bindings, evidenceNode: node });
      break;
    }

    case 'typedObjectVariable': {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.type &&
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        matcher.typeNames.includes(node.type.typeName.text) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        matches.push({
          bindings: {
            name: node.name.text,
            typeName: node.type.typeName.text,
            originalName: node.name.text,
          },
          evidenceNode: node,
        });
      }
      break;
    }

    case 'propertyAssignment': {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        matcher.names.includes(node.name.text) &&
        isWithinPayloadConfigContext(node)
      ) {
        const ok =
          matcher.valueKind === 'array'
            ? ts.isArrayLiteralExpression(node.initializer)
            : ts.isObjectLiteralExpression(node.initializer);
        if (ok) {
          matches.push({
            bindings: { name: node.name.text, originalName: node.name.text },
            evidenceNode: node,
          });
        }
      }
      break;
    }

    case 'sideEffectImport': {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        matcher.modules.includes(node.moduleSpecifier.text)
      ) {
        matches.push({
          bindings: {
            module: node.moduleSpecifier.text,
            originalName: node.moduleSpecifier.text,
          },
          evidenceNode: node,
        });
      }
      break;
    }

    case 'definePropertyCall': {
      if (ts.isCallExpression(node) && node.arguments.length >= 2) {
        const callee = calleePath(node.expression);
        const propArg = node.arguments[1];
        const descArg = node.arguments[2];
        const hasGetterDescriptor =
          callee !== 'Object.defineProperty' ||
          !descArg ||
          !ts.isObjectLiteralExpression(descArg) ||
          descArg.properties.some(
            (p) =>
              (ts.isPropertyAssignment(p) ||
                ts.isShorthandPropertyAssignment(p) ||
                ts.isMethodDeclaration(p) ||
                ts.isGetAccessorDeclaration(p)) &&
              (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
              p.name.text === 'get'
          );
        const isThisTarget = node.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword;
        const propNameText =
          propArg &&
          (ts.isStringLiteral(propArg) ||
            ts.isNoSubstitutionTemplateLiteral(propArg) ||
            (!isThisTarget && ts.isIdentifier(propArg)))
            ? propArg.text
            : null;
        if (
          callee &&
          matcher.callees.includes(callee) &&
          hasGetterDescriptor &&
          propNameText
        ) {
          matches.push({
            bindings: { prop: propNameText, originalName: propNameText },
            evidenceNode: node,
          });
        }
      }
      break;
    }

    case 'exportedFactoryCall': {
      if (!ts.isVariableStatement(node) || !hasModifier(node, ts.SyntaxKind.ExportKeyword)) break;
      const syntaxMode = matcher.calleeSyntax ?? 'any';
      const ZOD_CHAIN_MODIFIERS = new Set([
        'extend',
        'passthrough',
        'strict',
        'strip',
        'partial',
        'deepPartial',
        'pick',
        'omit',
        'merge',
        'optional',
        'nullable',
        'nullish',
        'default',
        'catch',
        'refine',
        'superRefine',
        'transform',
        'describe',
        'readonly',
        'brand',
        'keys',
        'withBrand',
        'withConstraint',
        'and',
        'or',
        'pipe',
        'preprocess',
        'coerce',
        'min',
        'max',
        'length',
        'email',
        'url',
        'emoji',
        'uuid',
        'nanoid',
        'cuid',
        'cuid2',
        'ulid',
        'regex',
        'includes',
        'startsWith',
        'endsWith',
        'datetime',
        'ip',
        'cidr',
        'trim',
        'toLowerCase',
        'toUpperCase',
        'gt',
        'gte',
        'lt',
        'lte',
        'int',
        'positive',
        'nonnegative',
        'negative',
        'nonpositive',
        'multipleOf',
        'finite',
        'safe',
        'nonempty',
        'overwrite',
        'check',
      ]);
      const ZOD_PRIMITIVE_BUILDERS = new Set([
        'string',
        'number',
        'boolean',
        'date',
        'bigint',
        'any',
        'unknown',
        'literal',
      ]);
      for (const decl of node.declarationList.declarations) {
        if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
        let callExpr = decl.initializer;
        let unwrappedChainCount = 0;
        if (syntaxMode === 'member') {
          while (
            ts.isPropertyAccessExpression(callExpr.expression) &&
            ZOD_CHAIN_MODIFIERS.has(callExpr.expression.name.text) &&
            ts.isCallExpression(callExpr.expression.expression)
          ) {
            callExpr = callExpr.expression.expression;
            unwrappedChainCount++;
          }
        }
        let fnName = '';
        if (ts.isIdentifier(callExpr.expression)) {
          if (syntaxMode === 'member') continue;
          fnName = callExpr.expression.text;
        } else if (ts.isPropertyAccessExpression(callExpr.expression)) {
          if (syntaxMode === 'identifier') continue;
          const recv = callExpr.expression.expression;
          if (ts.isIdentifier(recv)) {
            fnName = callExpr.expression.name.text;
            if (
              !matcher.callees.includes(fnName) &&
              recv.text === 'z' &&
              unwrappedChainCount > 0 &&
              ZOD_PRIMITIVE_BUILDERS.has(fnName) &&
              matcher.callees.includes('object')
            ) {
              fnName = 'object';
            }
          } else if (
            ts.isPropertyAccessExpression(recv) &&
            ts.isIdentifier(recv.expression) &&
            recv.expression.text === 'z' &&
            recv.name.text === 'coerce' &&
            ZOD_PRIMITIVE_BUILDERS.has(callExpr.expression.name.text) &&
            matcher.callees.includes('object')
          ) {
            fnName = 'object';
          } else {
            continue;
          }
        } else {
          continue;
        }
        if (!matcher.callees.includes(fnName)) continue;

        if (ts.isIdentifier(decl.name)) {
          matches.push({
            bindings: { name: decl.name.text, callee: fnName, originalName: decl.name.text },
            evidenceNode: node,
          });
        } else if (ts.isObjectBindingPattern(decl.name)) {
          for (const element of decl.name.elements) {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
              matches.push({
                bindings: {
                  name: element.name.text,
                  callee: fnName,
                  originalName: element.name.text,
                },
                evidenceNode: node,
              });
            }
          }
        }
      }
      break;
    }

    case 'commonjsAssignment': {
      if (
        matcher.form === 'moduleExports' &&
        (ts.isMethodDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
        node.parent &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const sourceFile = node.getSourceFile();
        if (sourceFile && isCjsModuleExportsObjectLiteral(node.parent, sourceFile)) {
          const propName = getCallableCjsObjectPropertyName(node, sourceFile);
          if (propName) {
            matches.push({
              bindings: {
                exportName: propName,
                entityType: 'EXPORTED_FUNCTION',
                className: 'Object',
                methodName: '',
                receiver: '',
                name: propName,
                originalName: propName,
              },
              evidenceNode: node,
            });
          }
        }
        break;
      }

      if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        break;
      }
      const left = node.left;
      const sf = node.getSourceFile();
      const rhsUnwrapped = unwrapCjsExpr(node.right);
      const isFn =
        ts.isFunctionExpression(rhsUnwrapped) ||
        ts.isArrowFunction(rhsUnwrapped) ||
        Boolean(ts.isIdentifier(rhsUnwrapped) && sf && isSameFileCallableSymbol(rhsUnwrapped.text, sf));
      const baseBindings = (overrides: Record<string, string>): Record<string, string> => ({
        exportName: 'default',
        entityType: isFn ? 'EXPORTED_FUNCTION' : 'EXPORTED_MODULE',
        className: 'Object',
        methodName: '',
        receiver: '',
        name: 'default',
        originalName: 'default',
        ...overrides,
      });

      if (matcher.form === 'prototypeMethod') {
        if (
          ts.isPropertyAccessExpression(left) &&
          ts.isPropertyAccessExpression(left.expression) &&
          left.expression.name.text === 'prototype'
        ) {
          const className = ts.isIdentifier(left.expression.expression)
            ? left.expression.expression.text
            : 'Object';
          const methodName = left.name.text;
          matches.push({
            bindings: baseBindings({
              className,
              methodName,
              entityType: isFn ? 'PROTOTYPE_METHOD' : 'EXPORTED_MODULE',
              name: methodName,
              originalName: methodName,
            }),
            evidenceNode: node,
          });
        }
      } else if (matcher.form === 'dynamicElement') {
        if (
          ts.isElementAccessExpression(left) &&
          ts.isIdentifier(left.expression) &&
          ['app', 'req', 'res'].includes(left.expression.text) &&
          isFn
        ) {
          matches.push({
            bindings: baseBindings({
              receiver: left.expression.text,
              entityType: 'CJS_METHOD',
              name: `${left.expression.text}[method]`,
              originalName: left.expression.text,
            }),
            evidenceNode: node,
          });
        }
      } else if (matcher.form === 'moduleExports') {
        let isCjsExport = false;
        let exportName = 'default';
        if (ts.isPropertyAccessExpression(left)) {
          if (
            ts.isIdentifier(left.expression) &&
            left.expression.text === 'module' &&
            left.name.text === 'exports'
          ) {
            isCjsExport = true;
          } else if (
            ts.isPropertyAccessExpression(left.expression) &&
            ts.isIdentifier(left.expression.expression) &&
            left.expression.expression.text === 'module' &&
            left.expression.name.text === 'exports'
          ) {
            isCjsExport = true;
            exportName = left.name.text;
          } else if (ts.isIdentifier(left.expression) && left.expression.text === 'exports') {
            isCjsExport = true;
            exportName = left.name.text;
          } else if (
            ts.isIdentifier(left.expression) &&
            ['app', 'req', 'res'].includes(left.expression.text) &&
            isFn &&
            !isEnclosingFunctionParam(node, left.expression.text)
          ) {
            isCjsExport = true;
            exportName = left.name.text;
          }
        } else if (ts.isIdentifier(left) && left.text === 'exports') {
          isCjsExport = true;
        }
        if (isCjsExport && exportName === 'default') {
          const sourceFile = node.getSourceFile();
          if (sourceFile) {
            const exportedObj = findCjsExportedObjectLiteralFromRhs(node.right, sourceFile);
            if (
              exportedObj &&
              exportedObj.properties.some((p) => getCallableCjsObjectPropertyName(p, sourceFile) !== null)
            ) {
              isCjsExport = false;
            }
          }
        }
        if (isCjsExport) {
          matches.push({
            bindings: baseBindings({
              exportName,
              name: exportName,
              originalName: exportName,
            }),
            evidenceNode: node,
          });
        }
      } else if (matcher.form === 'exportAlias') {
        if (
          ts.isPropertyAccessExpression(left) &&
          ts.isIdentifier(left.expression) &&
          !['module', 'exports', 'app', 'req', 'res', 'this'].includes(left.expression.text) &&
          isFn &&
          isValidCjsExportAliasAssignment(node, left.expression.text, left.name.text, node.getSourceFile())
        ) {
          matches.push({
            bindings: baseBindings({
              receiver: left.expression.text,
              name: left.name.text,
              exportName: left.name.text,
              entityType: 'EXPORTED_FUNCTION',
              originalName: left.name.text,
            }),
            evidenceNode: node,
          });
        }
      }
      break;
    }
  }

  return matches;
}

const PAYLOAD_CONFIG_TYPE_NAMES = new Set([
  'CollectionConfig',
  'GlobalConfig',
  'Block',
  'TaskConfig',
  'Field',
  'Tab',
  'SanitizedCollectionConfig',
  'SanitizedGlobalConfig',
]);

function isWithinPayloadConfigContext(node: ts.Node): boolean {
  const sf = node.getSourceFile();
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      (stmt.moduleSpecifier.text === 'payload' ||
        stmt.moduleSpecifier.text.startsWith('payload/') ||
        stmt.moduleSpecifier.text.startsWith('@payloadcms/'))
    ) {
      return true;
    }
  }

  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isVariableDeclaration(cur) && cur.type && ts.isTypeReferenceNode(cur.type)) {
      const typeName = ts.isIdentifier(cur.type.typeName)
        ? cur.type.typeName.text
        : cur.type.typeName.right.text;
      if (PAYLOAD_CONFIG_TYPE_NAMES.has(typeName)) {
        return true;
      }
    }
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === 'buildConfig') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'buildConfig')
      ) {
        return true;
      }
    }
    cur = cur.parent;
  }

  return false;
}

const validCjsExportAliasCache = new WeakMap<ts.SourceFile, Set<string>>();

function isModuleExportsExpr(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr) && expr.text === 'exports') return true;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'module' &&
    expr.name.text === 'exports'
  ) {
    return true;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return isModuleExportsExpr(expr.left) || isModuleExportsExpr(expr.right);
  }
  return false;
}

function getValidCjsExportAliasReceivers(sourceFile: ts.SourceFile): Set<string> {
  const cached = validCjsExportAliasCache.get(sourceFile);
  if (cached) return cached;

  const valid = new Set<string>();

  for (const stmt of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.name &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      valid.add(stmt.name.text);
    } else if (
      ts.isVariableStatement(stmt) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          valid.add(decl.name.text);
        }
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause) {
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          valid.add((el.propertyName ?? el.name).text);
          valid.add(el.name.text);
        }
      }
    } else if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      valid.add(stmt.expression.text);
    }
  }

  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (isModuleExportsExpr(n.initializer)) {
        valid.add(n.name.text);
      }
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isModuleExportsExpr(n.left)) {
        let rhs: ts.Expression = n.right;
        while (ts.isBinaryExpression(rhs) && rhs.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (ts.isIdentifier(rhs.left)) valid.add(rhs.left.text);
          rhs = rhs.right;
        }
        if (ts.isIdentifier(rhs)) {
          valid.add(rhs.text);
        } else if (ts.isFunctionExpression(rhs) || ts.isArrowFunction(rhs)) {
          for (const param of rhs.parameters) {
            if (ts.isIdentifier(param.name)) {
              valid.add(param.name.text);
            }
          }
        }
      } else if (ts.isIdentifier(n.left) && isModuleExportsExpr(n.right)) {
        valid.add(n.left.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);

  validCjsExportAliasCache.set(sourceFile, valid);
  return valid;
}

const DOM_EVENT_HANDLER_PROPS = new Set([
  'onloadstart',
  'onload',
  'onloadend',
  'onerror',
  'onabort',
  'onprogress',
  'ontimeout',
  'onmessage',
  'onmessageerror',
  'onopen',
  'onclose',
  'onreadystatechange',
  'onupgradeneeded',
  'onsuccess',
  'onblocked',
  'onversionchange',
]);

function isValidCjsExportAliasReceiver(recvName: string, sourceFile: ts.SourceFile): boolean {
  return getValidCjsExportAliasReceivers(sourceFile).has(recvName);
}

function isValidCjsExportAliasAssignment(
  node: ts.BinaryExpression,
  recvName: string,
  propName: string,
  sourceFile: ts.SourceFile
): boolean {
  if (DOM_EVENT_HANDLER_PROPS.has(propName)) return false;
  if (!isValidCjsExportAliasReceiver(recvName, sourceFile)) return false;

  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      // Allow `module.exports = function(recvName) { recvName.prop = ... }`
      const parent = cur.parent;
      if (
        parent &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExportsExpr(parent.left) &&
        cur.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === recvName)
      ) {
        cur = cur.parent;
        continue;
      }
      // Allow IIFE wrapper `(function(recvName) { ... })(module.exports)`
      if (
        parent &&
        ts.isParenthesizedExpression(parent) &&
        parent.parent &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      ) {
        cur = cur.parent;
        continue;
      }
      return false;
    }
    cur = cur.parent;
  }
  return true;
}

function isModuleExportsRootLeft(left: ts.Expression): boolean {
  if (ts.isIdentifier(left) && left.text === 'exports') return true;
  if (
    ts.isPropertyAccessExpression(left) &&
    ts.isIdentifier(left.expression) &&
    left.expression.text === 'module' &&
    left.name.text === 'exports'
  ) {
    return true;
  }
  return false;
}

function unwrapCjsExpr(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
    }
    if (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      ts.isIdentifier(cur.expression.expression) &&
      cur.expression.expression.text === 'Object' &&
      cur.expression.name.text === 'freeze' &&
      cur.arguments.length > 0
    ) {
      cur = cur.arguments[0];
      continue;
    }
    break;
  }
  return cur;
}

function isSameFileCallableSymbol(identName: string, sourceFile: ts.SourceFile): boolean {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === identName) {
      return true;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === identName && decl.initializer) {
          const init = unwrapCjsExpr(decl.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            return true;
          }
          if (
            ts.isCallExpression(init) &&
            init.arguments.some((a) => {
              const u = unwrapCjsExpr(a);
              return ts.isArrowFunction(u) || ts.isFunctionExpression(u);
            })
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function getCallableCjsObjectPropertyName(prop: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (ts.isMethodDeclaration(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
    return prop.name.text;
  }
  if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
    const init = unwrapCjsExpr(prop.initializer);
    if (
      ts.isArrowFunction(init) ||
      ts.isFunctionExpression(init) ||
      (ts.isCallExpression(init) &&
        init.arguments.some((a) => {
          const u = unwrapCjsExpr(a);
          return ts.isArrowFunction(u) || ts.isFunctionExpression(u);
        })) ||
      (ts.isIdentifier(init) && isSameFileCallableSymbol(init.text, sourceFile))
    ) {
      return prop.name.text;
    }
    return null;
  }
  if (ts.isShorthandPropertyAssignment(prop)) {
    if (isSameFileCallableSymbol(prop.name.text, sourceFile)) {
      return prop.name.text;
    }
    return null;
  }
  return null;
}

function isCjsModuleExportsObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile
): boolean {
  let holder: ts.Node | undefined = obj.parent;
  while (
    holder &&
    (ts.isParenthesizedExpression(holder) ||
      ts.isAsExpression(holder) ||
      ts.isSatisfiesExpression(holder) ||
      ts.isTypeAssertionExpression(holder) ||
      ts.isNonNullExpression(holder) ||
      (ts.isCallExpression(holder) &&
        ts.isPropertyAccessExpression(holder.expression) &&
        ts.isIdentifier(holder.expression.expression) &&
        holder.expression.expression.text === 'Object' &&
        holder.expression.name.text === 'freeze'))
  ) {
    holder = holder.parent;
  }
  if (!holder) return false;

  if (ts.isBinaryExpression(holder) && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    let cur: ts.Node | undefined = holder;
    while (cur && ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isModuleExportsRootLeft(cur.left)) return true;
      cur = cur.parent;
    }
    return false;
  }

  if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
    const varName = holder.name.text;
    for (const stmt of sourceFile.statements) {
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        let bin: ts.BinaryExpression = stmt.expression;
        let hasRootLeft = isModuleExportsRootLeft(bin.left);
        while (
          ts.isBinaryExpression(bin.right) &&
          bin.right.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          if (isModuleExportsRootLeft(bin.right.left)) hasRootLeft = true;
          bin = bin.right;
        }
        if (hasRootLeft) {
          const rhs = unwrapCjsExpr(bin.right);
          if (ts.isIdentifier(rhs) && rhs.text === varName) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function findCjsExportedObjectLiteralFromRhs(
  rhs: ts.Expression,
  sourceFile: ts.SourceFile
): ts.ObjectLiteralExpression | null {
  let unwrapped = unwrapCjsExpr(rhs);
  while (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    unwrapped = unwrapCjsExpr(unwrapped.right);
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped;
  }
  if (ts.isIdentifier(unwrapped)) {
    const varName = unwrapped.text;
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === varName && decl.initializer) {
          const init = unwrapCjsExpr(decl.initializer);
          if (ts.isObjectLiteralExpression(init)) {
            return init;
          }
        }
      }
    }
  }
  return null;
}

function extractSqlTemplateTableIdentifier(expr: ts.Expression): string | null {
  const template = ts.isTaggedTemplateExpression(expr) ? expr.template : expr;
  if (!ts.isTemplateExpression(template)) return null;

  const identSpans: string[] = [];
  for (let i = 0; i < template.templateSpans.length; i++) {
    const span = template.templateSpans[i];
    if (!ts.isIdentifier(span.expression)) continue;
    const identName = span.expression.text;
    identSpans.push(identName);
    const prevSql = i === 0 ? template.head.text : template.templateSpans[i - 1].literal.text;
    if (/\b(?:from|into|update|join|table)\s*$/i.test(prevSql)) {
      return identName;
    }
  }

  return identSpans.length === 1 ? identSpans[0] : null;
}

/**
 * Unwinds a fluent call chain `root.entry(...).step(...)` or relational query
 * `root.query.<schema>.<method>(...)` to its root identifier, entry method, and schema arg.
 */
function unwindFluentChain(
  node: ts.Expression,
  schemaArgMethods: readonly string[],
  relationalQueryMethods?: readonly string[]
): { rootName: string | null; entryMethod: string | null; schemaName: string | null; isRelational: boolean } {
  let current: ts.Expression = node;
  let schemaName: string | null = null;
  const trailingProps: string[] = [];

  while (current) {
    if (ts.isCallExpression(current)) {
      trailingProps.length = 0;
      if (ts.isPropertyAccessExpression(current.expression)) {
        const method = current.expression.name.text;
        // Synchronous 0-parameter `.transaction(() => ...)` is a `better-sqlite3` transaction
        // factory (`const saveTx = db.transaction(() => ...)`), and `.transaction('store', 'readonly')`
        // or `.transaction(['a', 'b'], 'readwrite')` is an IndexedDB `IDBDatabase.transaction()` call,
        // whereas Drizzle transactions pass a callback `(tx) => ...`.
        if (method === 'transaction') {
          if (current.arguments.length === 0) {
            return { rootName: null, entryMethod: null, schemaName: null, isRelational: false };
          }
          const arg0 = current.arguments[0];
          const arg1 = current.arguments.length >= 2 ? current.arguments[1] : undefined;
          if (
            ((ts.isArrowFunction(arg0) || ts.isFunctionExpression(arg0)) &&
              arg0.parameters.length === 0 &&
              !arg0.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) ||
            ts.isStringLiteral(arg0) ||
            ts.isNoSubstitutionTemplateLiteral(arg0) ||
            ts.isTemplateExpression(arg0) ||
            ts.isArrayLiteralExpression(arg0) ||
            (arg1 &&
              ts.isStringLiteral(arg1) &&
              (arg1.text === 'readonly' || arg1.text === 'readwrite' || arg1.text === 'versionchange'))
          ) {
            return { rootName: null, entryMethod: null, schemaName: null, isRelational: false };
          }
        }
        if (schemaArgMethods.includes(method) && current.arguments.length > 0) {
          const arg = current.arguments[0];
          if (ts.isIdentifier(arg)) {
            schemaName = arg.text;
          } else if (method === 'execute') {
            const sqlTable = extractSqlTemplateTableIdentifier(arg);
            if (sqlTable) schemaName = sqlTable;
          }
        }
      }
      current = current.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      trailingProps.unshift(current.name.text);
      current = current.expression;
      continue;
    }
    if (ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword) {
      let rootName: string;
      let props = trailingProps;
      if (current.kind === ts.SyntaxKind.ThisKeyword) {
        if (trailingProps.length < 2) {
          return { rootName: null, entryMethod: null, schemaName: null, isRelational: false };
        }
        rootName = trailingProps[0];
        props = trailingProps.slice(1);
      } else {
        rootName = (current as ts.Identifier).text;
      }

      if (
        relationalQueryMethods &&
        props.length === 3 &&
        props[0] === 'query' &&
        relationalQueryMethods.includes(props[2])
      ) {
        return {
          rootName,
          entryMethod: props[2],
          schemaName: props[1],
          isRelational: true,
        };
      }
      if (props.length === 1) {
        return {
          rootName,
          entryMethod: props[0],
          schemaName,
          isRelational: false,
        };
      }
      return { rootName: null, entryMethod: null, schemaName: null, isRelational: false };
    }
    break;
  }
  return { rootName: null, entryMethod: null, schemaName: null, isRelational: false };
}

/** Extracts schema name and read/mutate relationship bindings from a call's first object-literal argument. */
function extractSchemaObjectArg(
  node: ts.CallExpression,
  method: string,
  spec: { keys: readonly string[]; mutateMethods: readonly string[] }
): Record<string, string> | null {
  if (node.arguments.length === 0 || !ts.isObjectLiteralExpression(node.arguments[0])) return null;
  for (const prop of node.arguments[0].properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      spec.keys.includes(prop.name.text) &&
      ts.isStringLiteral(prop.initializer)
    ) {
      const isMutate = spec.mutateMethods.includes(method);
      const isGlobal = method.includes('Global') || prop.name.text === 'global';
      return {
        schema: prop.initializer.text,
        relType: isMutate ? 'MUTATES' : 'READS',
        relTypeLower: isMutate ? 'mutates' : 'reads',
        targetKind: isGlobal ? 'Global' : 'Collection',
      };
    }
  }
  return null;
}

/** Matches and extracts `arguments[0]` of a `callToMember` expression, or returns null. */
function matchCallArg0(node: ts.CallExpression, kind: CallArg0Matcher): string | null {
  const firstArg = node.arguments[0];
  switch (kind) {
    case 'stringLiteral':
      return firstArg && ts.isStringLiteral(firstArg) ? firstArg.text : null;

    case 'optionalStringLiteral':
      return firstArg && ts.isStringLiteral(firstArg) ? firstArg.text : 'Unknown';

    case 'routePathLiteral': {
      if (!firstArg || (!ts.isStringLiteral(firstArg) && !ts.isRegularExpressionLiteral(firstArg))) return null;
      const pathText = firstArg.text;
      // Express server routes never start with http:// or https:// (full URLs are client HTTP calls).
      if (
        pathText.startsWith('http://') ||
        pathText.startsWith('https://') ||
        /^https?:\/\//i.test(pathText)
      ) {
        return null;
      }
      if (!ts.isRegularExpressionLiteral(firstArg) && !pathText.startsWith('/') && pathText !== '*') {
        return null;
      }
      const methodName = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : '';
      if (methodName === 'route') {
        if (node.arguments.length > 1) return null;
      } else if (node.arguments.length < 2) {
        return null;
      } else {
        const trailingArgs = node.arguments.slice(1);
        const allPlainConfigObjects = trailingArgs.every(
          (arg) =>
            ts.isObjectLiteralExpression(arg) &&
            !arg.properties.some(
              (p) =>
                (ts.isPropertyAssignment(p) ||
                  ts.isShorthandPropertyAssignment(p) ||
                  ts.isMethodDeclaration(p)) &&
                (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
                (p.name.text === 'handler' ||
                  p.name.text === 'preHandler' ||
                  p.name.text === 'onRequest')
            )
        );
        if (allPlainConfigObjects) return null;
      }
      return pathText;
    }

    case 'stringOrStringArray': {
      if (!firstArg) return 'Unknown';
      if (ts.isStringLiteral(firstArg)) return firstArg.text;
      if (ts.isArrayLiteralExpression(firstArg)) {
        return firstArg.elements
          .filter(ts.isStringLiteral)
          .map((e) => e.text)
          .join(', ');
      }
      return 'Unknown';
    }

    case 'objectLiteralKeys': {
      if (!firstArg || !ts.isObjectLiteralExpression(firstArg)) return null;
      return firstArg.properties
        .map((prop) => {
          if (ts.isPropertyAssignment(prop) && (ts.isStringLiteral(prop.name) || ts.isIdentifier(prop.name))) {
            return prop.name.text;
          }
          return null;
        })
        .filter((k): k is string => Boolean(k))
        .join(', ');
    }
  }
}

const NON_EXPRESS_USE_RECEIVERS = new Set([
  'i18n',
  'i18next',
  'chai',
  'marked',
  'remark',
  'rehype',
  'unified',
  'vue',
  'pinia',
  'dayjs',
  'msw',
]);

function isNonExpressUseReceiver(receiverExpr: ts.Expression): boolean {
  let baseExpr: ts.Expression = receiverExpr;
  while (
    ts.isCallExpression(baseExpr) &&
    ts.isPropertyAccessExpression(baseExpr.expression) &&
    baseExpr.expression.name.text === 'use'
  ) {
    baseExpr = baseExpr.expression.expression;
  }

  const baseRecv = calleePath(baseExpr);
  if (baseRecv) {
    const lowerRecv = baseRecv.toLowerCase();
    for (const blocked of NON_EXPRESS_USE_RECEIVERS) {
      if (lowerRecv === blocked || lowerRecv.startsWith(`${blocked}.`)) {
        return true;
      }
    }
    if (
      lowerRecv.endsWith('procedure') ||
      lowerRecv.includes('.interceptors.') ||
      lowerRecv.endsWith('.interceptors') ||
      isHttpClientReceiver(baseRecv)
    ) {
      return true;
    }
  }

  if (ts.isIdentifier(baseExpr)) {
    const identName = baseExpr.text;
    if (identName.toLowerCase().endsWith('procedure') || isHttpClientReceiver(identName)) return true;
    const sf = baseExpr.getSourceFile();
    let isNonExpressFactory = false;
    const checkVar = (n: ts.Node) => {
      if (isNonExpressFactory) return;
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === identName &&
        n.initializer &&
        ts.isCallExpression(n.initializer)
      ) {
        const initCallee = calleePath(n.initializer.expression);
        if (
          initCallee &&
          (initCallee === 'setupServer' ||
            initCallee === 'setupWorker' ||
            initCallee === 'createInstance' ||
            initCallee === 'axios.create' ||
            initCallee.endsWith('.setupServer') ||
            initCallee.endsWith('.setupWorker') ||
            initCallee.endsWith('.createInstance') ||
            initCallee.endsWith('.create') ||
            initCallee.endsWith('.procedure'))
        ) {
          isNonExpressFactory = true;
          return;
        }
      }
      ts.forEachChild(n, checkVar);
    };
    checkVar(sf);
    if (isNonExpressFactory) return true;
  }

  return false;
}

/**
 * Parses `RECEIVER.use([pathPrefix], target)` into its path prefix (`'Root'` when omitted), target
 * display label, and whether the target is middleware (`true`) or a mounted sub-router (`false`).
 */
function parseCallUseTarget(
  node: ts.Node
): { pathPrefix: string; target: string; isMiddleware: boolean } | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.expression.name.text !== 'use' || node.arguments.length < 1) return null;

  const recv = calleePath(node.expression.expression);
  if (recv && (isHttpClientReceiver(recv) || recv === 'instance' || recv.endsWith('.instance'))) {
    return null;
  }
  if (isNonExpressUseReceiver(node.expression.expression)) return null;

  const firstArg = node.arguments[0];
  if (
    node.arguments.length >= 2 &&
    ts.isIdentifier(firstArg) &&
    /^(?:req|request|ctx|context)$/i.test(firstArg.text) &&
    ts.isIdentifier(node.arguments[1]) &&
    /^(?:res|response|next)$/i.test(node.arguments[1].text)
  ) {
    return null;
  }
  let pathPrefix = 'Root';
  let targetNode = firstArg;

  if ((ts.isStringLiteral(firstArg) || ts.isRegularExpressionLiteral(firstArg)) && node.arguments.length >= 2) {
    pathPrefix = firstArg.text;
    targetNode = node.arguments[1];
  } else if (
    (ts.isNoSubstitutionTemplateLiteral(firstArg) || ts.isTemplateExpression(firstArg)) &&
    node.arguments.length >= 2
  ) {
    pathPrefix = firstArg.getText(node.getSourceFile());
    targetNode = node.arguments[1];
  } else if (
    (ts.isIdentifier(firstArg) || ts.isPropertyAccessExpression(firstArg)) &&
    node.arguments.length >= 2
  ) {
    const firstArgText = firstArg.getText(node.getSourceFile());
    if (/path|prefix|url|base|pattern/i.test(firstArgText) || /^(?:route|endpoint)$/i.test(firstArgText)) {
      pathPrefix = firstArgText;
      targetNode = node.arguments[1];
    }
  }

  if (pathPrefix !== '*' && node.arguments.length >= 3) {
    const lastArg = node.arguments[node.arguments.length - 1];
    if (
      ts.isIdentifier(lastArg) &&
      (/(?:router|routes|controller|api)$/i.test(lastArg.text) ||
        lastArg.text.toLowerCase().includes('router'))
    ) {
      targetNode = lastArg;
    }
  }

  let target = 'Unknown Middleware';
  let isMiddleware = true;

  if (ts.isCallExpression(targetNode)) {
    if (
      ts.isIdentifier(targetNode.expression) &&
      targetNode.expression.text === 'require' &&
      targetNode.arguments.length > 0 &&
      ts.isStringLiteral(targetNode.arguments[0])
    ) {
      target = targetNode.arguments[0].text;
      isMiddleware = false;
    } else if (ts.isIdentifier(targetNode.expression)) {
      target = `${targetNode.expression.text}()`;
    } else if (ts.isPropertyAccessExpression(targetNode.expression)) {
      if (ts.isIdentifier(targetNode.expression.expression)) {
        target = `${targetNode.expression.expression.text}.${targetNode.expression.name.text}()`;
      } else {
        target = `${targetNode.expression.name.text}()`;
      }
    }
  } else if (ts.isIdentifier(targetNode)) {
    target = targetNode.text;
    if (
      /(?:router|routes|controller|api)$/i.test(target) ||
      target.toLowerCase().includes('router')
    ) {
      isMiddleware = false;
    }
  } else if (ts.isFunctionExpression(targetNode) || ts.isArrowFunction(targetNode)) {
    target = 'Inline Middleware';
  }

  return { pathPrefix, target, isMiddleware };
}

/** Formats a route middleware or handler argument into its deterministic target label. */
function formatRouteArgTarget(arg: ts.Expression, isHandler: boolean): string {
  if (ts.isIdentifier(arg)) return arg.text;
  if (ts.isPropertyAccessExpression(arg)) {
    return ts.isIdentifier(arg.expression) ? `${arg.expression.text}.${arg.name.text}` : arg.name.text;
  }
  if (ts.isCallExpression(arg)) {
    if (ts.isIdentifier(arg.expression)) return `${arg.expression.text}()`;
    if (ts.isPropertyAccessExpression(arg.expression)) return `${arg.expression.name.text}()`;
    return isHandler ? 'Unknown Handler' : 'Unknown Middleware';
  }
  if (ts.isFunctionExpression(arg) || ts.isArrowFunction(arg)) return 'Inline Middleware';
  return arg.getText(arg.getSourceFile());
}

// ── Templating ───────────────────────────────────────────────────────────────────────────────

/** A rule's AST forms as a list (a rule may declare one form or several). */
function matchersOf(rule: ConventionRule): readonly NodeMatcher[] {
  return Array.isArray(rule.match) ? rule.match : [rule.match as NodeMatcher];
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Placeholder names a rule's templates reference. */
export function templatePlaceholders(rule: ConventionRule): string[] {
  const found = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(PLACEHOLDER)) found.add(m[1]);
  };
  scan(rule.emit.name);
  scan(rule.emit.entityType);
  if (rule.emit.idScope) scan(rule.emit.idScope);
  for (const v of Object.values(rule.emit.metadata ?? {})) scan(v);
  const comp = rule.emit.companionRelationship;
  if (comp) {
    scan(comp.name);
    scan(comp.entityType);
    scan(comp.patternId);
    if (comp.targetContract) {
      scan(comp.targetContract.idScope);
      scan(comp.targetContract.contractName);
    }
  }
  return [...found];
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Convention template references unknown placeholder {${key}}`);
    return value;
  });
}

function canRender(template: string, values: Record<string, string>): boolean {
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (values[m[1]] === undefined) return false;
  }
  return true;
}

/** An emitted entity together with the AST match that produced it (for adapters that enrich it). */
export interface AppliedConvention {
  entity: StructuralEntity;
  match: NodeMatch;
}

/**
 * Applies the named rules of `set` to one AST node and returns every entity they produce together
 * with the match that proved it, in rule order then source order. Returns [] when nothing matches.
 * A rule scoped to roles only fires when the file plays one of them.
 * A rule scoped to `meta.versions` only fires when the project's installed framework version satisfies the range.
 */
export function applyConventionRulesDetailed(
  set: ConventionSet,
  ruleIds: readonly string[],
  node: ts.Node,
  fileRole: string | null,
  relativeFilePath: string,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  installedVersions?: Readonly<Record<string, string>>
): AppliedConvention[] {
  const results: AppliedConvention[] = [];
  let resolvedVersions: Readonly<Record<string, string>> | undefined = installedVersions;

  for (const ruleId of ruleIds) {
    const rule = set.rules.find((r) => r.id === ruleId);
    if (!rule) throw new Error(`Unknown convention rule '${ruleId}' in set '${set.framework}'`);
    if (rule.roles && (fileRole === null || !rule.roles.includes(fileRole))) continue;
    if (rule.meta.versions) {
      if (!resolvedVersions) {
        resolvedVersions = resolveInstalledFrameworkVersions(node.getSourceFile()?.fileName);
      }
      const installed = lookupFrameworkVersion(rule.meta.framework, resolvedVersions);
      if (!satisfiesConventionVersion(installed, rule.meta.versions)) continue;
    }

    for (const match of matchersOf(rule).flatMap((matcher) => matchNode(node, matcher))) {
      const values: Record<string, string> = { ...match.bindings };
      for (const key of templatePlaceholders(rule)) {
        if (values[key] === undefined && set.derivers[key]) values[key] = set.derivers[key](relativeFilePath);
      }

      const name = render(rule.emit.name, values);
      const renderedIdScope = rule.emit.idScope ? render(rule.emit.idScope, values) : null;
      const sf = node.getSourceFile();
      const sfFileKey = sf?.fileName?.replace(/\\/g, '/') ?? '';
      const inlineLineSuffix =
        values.target === 'Inline Middleware' && sf
          ? `:${sf.getLineAndCharacterOfPosition(match.evidenceNode.getStart(sf)).line + 1}`
          : '';
      const scopedIdScope =
        renderedIdScope && renderedIdScope.startsWith('middleware:') && sfFileKey
          ? `${sfFileKey}${inlineLineSuffix}::${renderedIdScope}`
          : renderedIdScope;
      const id = scopedIdScope
        ? stableEntityId(scopedIdScope, rule.emit.type, name)
        : nextId();
      const renderedEntityType = render(rule.emit.entityType, values);
      const baseMetadata = rule.emit.metadata
        ? Object.fromEntries(Object.entries(rule.emit.metadata).map(([k, v]) => [k, render(v, values)]))
        : undefined;
      const portMeta =
        rule.emit.type === 'CONTRACT'
          ? extractConventionPortValves(node, match, renderedEntityType) ??
            (match.evidenceNode !== node
              ? extractConventionPortValves(match.evidenceNode, match, renderedEntityType)
              : undefined)
          : undefined;
      const metadata =
        baseMetadata || portMeta
          ? { ...(portMeta ?? {}), ...(baseMetadata ?? {}) }
          : undefined;
      const evidence = getEvidence(match.evidenceNode);

      results.push({
        match,
        entity: {
          id,
          name,
          type: rule.emit.type,
          entityType: renderedEntityType,
          patternId: rule.emit.patternId,
          evidence,
          ...(metadata ? { metadata } : {}),
        },
      });

      const comp = rule.emit.companionRelationship;
      if (
        comp &&
        canRender(comp.name, values) &&
        canRender(comp.entityType, values) &&
        canRender(comp.patternId, values) &&
        (!comp.targetContract ||
          (canRender(comp.targetContract.idScope, values) && canRender(comp.targetContract.contractName, values)))
      ) {
        const targetId = comp.targetContract
          ? stableEntityId(
              render(comp.targetContract.idScope, values),
              'CONTRACT',
              render(comp.targetContract.contractName, values)
            )
          : '';
        results.push({
          match,
          entity: {
            id: nextId(),
            name: render(comp.name, values),
            type: 'RELATIONSHIP',
            entityType: render(comp.entityType, values),
            patternId: render(comp.patternId, values),
            ...(comp.targetContract ? { sourceId: id } : {}),
            targetId,
            evidence,
          },
        });
      }
    }
  }

  return results;
}

/** Like {@link applyConventionRulesDetailed}, returning only the entities. */
export function applyConventionRules(
  set: ConventionSet,
  ruleIds: readonly string[],
  node: ts.Node,
  fileRole: string | null,
  relativeFilePath: string,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  installedVersions?: Readonly<Record<string, string>>
): StructuralEntity[] {
  return applyConventionRulesDetailed(
    set,
    ruleIds,
    node,
    fileRole,
    relativeFilePath,
    getEvidence,
    nextId,
    installedVersions
  ).map((applied) => applied.entity);
}

/** Alias for {@link applyConventionRules} (`[PAT-EXT-28]`). */
export const runConventionNodes = applyConventionRules;

// ── Edge rules ───────────────────────────────────────────────────────────────────────────────

/** Matches an edge rule's AST form; returns all matches in source order. */
function matchEdgeNode(node: ts.Node, matcher: EdgeMatcher): NodeMatch[] {
  switch (matcher.kind) {
    case 'jsxComponentElement': {
      if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return [];
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
      if (matcher.tagSyntax === 'member') {
        if (!ts.isPropertyAccessExpression(tag)) return [];
        const fullTag = calleePath(tag);
        if (!fullTag) return [];
        const dotIdx = fullTag.indexOf('.');
        const lastDotIdx = fullTag.lastIndexOf('.');
        if (dotIdx <= 0 || lastDotIdx <= 0) return [];
        const rootName = fullTag.slice(0, dotIdx);
        const memberName = fullTag.slice(lastDotIdx + 1);
        return [{ bindings: { tagName: fullTag, rootName, memberName }, evidenceNode: node }];
      }
      // DOM elements (lowercase) are platform primitives, never components ([PAT-EXT-05]).
      if (!ts.isIdentifier(tag) || !/^[A-Z]/.test(tag.text)) return [];
      return [{ bindings: { tagName: tag.text, rootName: tag.text, memberName: tag.text }, evidenceNode: node }];
    }

    case 'callUseTarget': {
      const parsed = parseCallUseTarget(node);
      if (!parsed) return [];
      const wantMiddleware = matcher.targetKind === 'middleware';
      if (parsed.isMiddleware !== wantMiddleware) return [];
      return [{ bindings: { pathPrefix: parsed.pathPrefix, target: parsed.target }, evidenceNode: node }];
    }

    case 'callRouteTargets': {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return [];
      const method = node.expression.name.text;
      if (method === 'route' || !matcher.methods.includes(method) || node.arguments.length < 1) return [];
      let pathText: string | null = null;
      let isChainedRoute = false;
      let argStartIdx = 1;
      const firstArg = node.arguments[0];
      if (firstArg && (ts.isStringLiteral(firstArg) || ts.isRegularExpressionLiteral(firstArg))) {
        pathText = firstArg.text;
      } else {
        let cur: ts.Expression = node.expression.expression;
        while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
          if (
            cur.expression.name.text === 'route' &&
            cur.arguments.length >= 1 &&
            (ts.isStringLiteral(cur.arguments[0]) || ts.isRegularExpressionLiteral(cur.arguments[0]))
          ) {
            pathText = cur.arguments[0].text;
            isChainedRoute = true;
            argStartIdx = 0;
            break;
          }
          cur = cur.expression.expression;
        }
      }
      if (!pathText) return [];
      if (!isChainedRoute && node.arguments.length < 2) return [];
      if (
        pathText.startsWith('http://') ||
        pathText.startsWith('https://') ||
        /^https?:\/\//i.test(pathText)
      ) {
        return [];
      }
      if (
        method === 'get' &&
        !isChainedRoute &&
        !pathText.startsWith('/') &&
        (!firstArg || !ts.isRegularExpressionLiteral(firstArg))
      ) {
        return [];
      }

      const recv = calleePath(node.expression.expression);
      if (recv && isHttpClientReceiver(recv, matcher.excludeReceivers)) return [];
      if (!isChainedRoute) {
        const trailingArgs = node.arguments.slice(1);
        const allPlainConfigObjects = trailingArgs.every(
          (arg) =>
            ts.isObjectLiteralExpression(arg) &&
            !arg.properties.some(
              (p) =>
                (ts.isPropertyAssignment(p) ||
                  ts.isShorthandPropertyAssignment(p) ||
                  ts.isMethodDeclaration(p)) &&
                (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
                (p.name.text === 'handler' ||
                  p.name.text === 'preHandler' ||
                  p.name.text === 'onRequest')
            )
        );
        if (allPlainConfigObjects) return [];
      }

      const matches: NodeMatch[] = [];
      if (matcher.position === 'middleware') {
        for (let i = argStartIdx; i < node.arguments.length - 1; i++) {
          const arg = node.arguments[i];
          if (ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
                (prop.name.text === 'preHandler' ||
                  prop.name.text === 'onRequest' ||
                  prop.name.text === 'preValidation')
              ) {
                const hookVal = prop.initializer;
                const hookEls = ts.isArrayLiteralExpression(hookVal) ? hookVal.elements : [hookVal];
                for (const el of hookEls) {
                  if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) continue;
                  const target = formatRouteArgTarget(el, false);
                  matches.push({
                    bindings: { path: pathText, target, method, METHOD: method.toUpperCase() },
                    evidenceNode: node,
                  });
                }
              }
            }
            continue;
          }
          if (ts.isArrayLiteralExpression(arg)) {
            for (const el of arg.elements) {
              if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) continue;
              const target = formatRouteArgTarget(el, false);
              matches.push({
                bindings: { path: pathText, target, method, METHOD: method.toUpperCase() },
                evidenceNode: node,
              });
            }
          } else {
            const target = formatRouteArgTarget(arg, false);
            matches.push({
              bindings: { path: pathText, target, method, METHOD: method.toUpperCase() },
              evidenceNode: node,
            });
          }
        }
      } else {
        const lastArg = node.arguments[node.arguments.length - 1];
        if (!ts.isFunctionExpression(lastArg) && !ts.isArrowFunction(lastArg)) {
          const target = formatRouteArgTarget(lastArg, true);
          matches.push({
            bindings: { path: pathText, target, method, METHOD: method.toUpperCase() },
            evidenceNode: node,
          });
        }
      }
      return matches;
    }

    case 'propertyArrayElements': {
      const props: ts.PropertyAssignment[] = [];
      if (matcher.enclosingCall) {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === matcher.enclosingCall &&
          node.arguments.length > 0 &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          for (const prop of node.arguments[0].properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && matcher.names.includes(prop.name.text)) {
              props.push(prop);
            }
          }
        }
      } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && matcher.names.includes(node.name.text)) {
        props.push(node);
      }

      const matches: NodeMatch[] = [];
      for (const prop of props) {
        if (!ts.isArrayLiteralExpression(prop.initializer) || !ts.isIdentifier(prop.name)) continue;
        for (const el of prop.initializer.elements) {
          let target = '';
          if (ts.isIdentifier(el)) {
            target = el.text;
          } else if (matcher.allowCallElements && ts.isCallExpression(el) && ts.isIdentifier(el.expression)) {
            target = el.expression.text;
          }
          if (target) {
            matches.push({ bindings: { propName: prop.name.text, target }, evidenceNode: node });
          }
        }
      }
      return matches;
    }
  }
}

/**
 * Applies the named edge rules to one AST node. An edge is emitted ONLY when one of the rule's
 * target strategies resolves; an unresolved strategy is skipped (Principle of Incomplete Truth).
 *
 * @param sourceId  The entity that owns the AST node (resolved by the orchestrator).
 */
export function applyEdgeRules(
  set: ConventionSet,
  ruleIds: readonly string[],
  node: ts.Node,
  sourceId: string,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  resolvers: EdgeTargetResolvers = {},
  installedVersions?: Readonly<Record<string, string>>
): StructuralEntity[] {
  const results: StructuralEntity[] = [];
  let resolvedVersions: Readonly<Record<string, string>> | undefined = installedVersions;

  for (const ruleId of ruleIds) {
    const rule = (set.edgeRules ?? []).find((r) => r.id === ruleId);
    if (!rule) throw new Error(`Unknown edge rule '${ruleId}' in set '${set.framework}'`);
    if (rule.meta.versions) {
      if (!resolvedVersions) {
        resolvedVersions = resolveInstalledFrameworkVersions(node.getSourceFile()?.fileName);
      }
      const installed = lookupFrameworkVersion(rule.meta.framework, resolvedVersions);
      if (!satisfiesConventionVersion(installed, rule.meta.versions)) continue;
    }

    for (const match of matchEdgeNode(node, rule.match)) {
      const targetSymbol = match.bindings.tagName ?? match.bindings.target;
      for (const strategy of rule.target) {
        let resolved: { targetId: string | undefined; evidences: EvidenceRecord[] } | null = null;
        if (strategy === 'importedComponent') {
          resolved = targetSymbol ? (resolvers.importedComponent?.(targetSymbol, node) ?? null) : null;
        } else if (strategy === 'lazyComponent') {
          resolved = targetSymbol ? (resolvers.lazyComponent?.(targetSymbol, node, 'lazy') ?? null) : null;
        } else if (strategy === 'nextDynamicComponent') {
          resolved = targetSymbol ? (resolvers.lazyComponent?.(targetSymbol, node, 'dynamic') ?? null) : null;
        } else if (strategy === 'namespacedComponent') {
          resolved =
            match.bindings.rootName && match.bindings.memberName
              ? (resolvers.namespacedComponent?.(match.bindings.rootName, match.bindings.memberName, node) ?? null)
              : null;
        } else if (strategy === 'sameFileExport') {
          resolved = targetSymbol ? (resolvers.sameFileExport?.(targetSymbol, node) ?? null) : null;
        } else if (strategy === 'routerMount') {
          if (resolvers.routerMount && ts.isCallExpression(node)) {
            resolved = { targetId: resolvers.routerMount(node), evidences: [] };
          }
        } else if (strategy === 'unlinked') {
          resolved = { targetId: undefined, evidences: [] };
        } else if (strategy.kind === 'syntheticContract') {
          const renderedStratScope = render(strategy.idScope, match.bindings);
          const sf = node.getSourceFile();
          const sfFileKey = sf?.fileName?.replace(/\\/g, '/') ?? '';
          const inlineLineSuffix =
            match.bindings.target === 'Inline Middleware' && sf
              ? `:${sf.getLineAndCharacterOfPosition(match.evidenceNode.getStart(sf)).line + 1}`
              : '';
          const scopedStratScope =
            renderedStratScope.startsWith('middleware:') && sfFileKey
              ? `${sfFileKey}${inlineLineSuffix}::${renderedStratScope}`
              : renderedStratScope;
          resolved = {
            targetId: stableEntityId(
              scopedStratScope,
              'CONTRACT',
              render(strategy.contractName, match.bindings)
            ),
            evidences: [],
          };
        }
        if (!resolved) continue;

        const evidence =
          resolved.evidences.length > 0
            ? [{ ...getEvidence(match.evidenceNode), evidenceRole: 'syntax-call' as const }, ...resolved.evidences]
            : getEvidence(match.evidenceNode);

        const renderedMeta = rule.emit.metadata
          ? Object.fromEntries(
              Object.entries(rule.emit.metadata).map(([k, v]) => [
                k,
                typeof v === 'string' ? render(v, match.bindings) : v,
              ])
            )
          : undefined;

        results.push({
          id: nextId(),
          name: render(rule.emit.name, match.bindings),
          type: 'RELATIONSHIP',
          entityType: rule.emit.entityType,
          patternId: rule.emit.patternId,
          ...(sourceId ? { sourceId } : {}),
          ...(resolved.targetId !== undefined ? { targetId: resolved.targetId } : {}),
          status: rule.emit.status,
          confidence: rule.emit.confidence,
          evidence,
          ...(renderedMeta ? { metadata: renderedMeta } : {}),
        });
        break;
      }
    }
  }

  return results;
}

/** Alias for {@link applyEdgeRules} (`[PAT-EXT-28]`). */
export const runConventionEdges = applyEdgeRules;

// ── Integrity & catalog ──────────────────────────────────────────────────────────────────────

/** Placeholder names bound by a node matcher instance. */
function matcherBindings(matcher: NodeMatcher): string[] {
  switch (matcher.kind) {
    case 'exportedFunction':
    case 'exportedDestructured':
    case 'exportedConst':
    case 'exportedWrappedFunction':
    case 'callToIdentifier':
    case 'propertyAssignment':
      return ['name', 'originalName'];
    case 'defaultExportedFunction':
      return ['componentName', 'originalName'];
    case 'exportAlias':
      return ['originalName', 'exportedName'];
    case 'variableInitializedByCall':
      return ['name', 'callee', 'originalName'];
    case 'typedObjectVariable':
      return ['name', 'typeName', 'originalName'];
    case 'fluentCallChain':
      return ['root', 'entryMethod', 'originalName', 'schema', 'relType', 'relTypeLower'];
    case 'callToMember': {
      const bound = ['method', 'METHOD', 'callee', 'originalName'];
      if (matcher.arg0) bound.push('arg0');
      if (matcher.expandValues) bound.push('value', 'VALUE');
      if (matcher.schemaObjectArg) bound.push('schema', 'relType', 'relTypeLower', 'targetKind');
      return bound;
    }
    case 'callUseTarget':
      return ['pathPrefix', 'target', 'originalName'];
    case 'sideEffectImport':
      return ['module', 'originalName'];
    case 'definePropertyCall':
      return ['prop', 'originalName'];
    case 'exportedFactoryCall':
      return ['name', 'callee', 'originalName'];
    case 'commonjsAssignment':
      return [
        'exportName',
        'entityType',
        'className',
        'methodName',
        'receiver',
        'name',
        'originalName',
      ];
  }
}

/** Edge-matcher-bound placeholder names, per edge matcher kind. */
const EDGE_MATCHER_BINDINGS: Record<EdgeMatcher['kind'], readonly string[]> = {
  jsxComponentElement: ['tagName', 'rootName', 'memberName'],
  callUseTarget: ['pathPrefix', 'target'],
  callRouteTargets: ['path', 'target', 'method', 'METHOD'],
  propertyArrayElements: ['propName', 'target'],
};

/** Returns a list of integrity problems with a set (empty = valid). Does not touch the filesystem. */
export function validateConventionSet(set: ConventionSet): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const roles = new Set(set.fileRoles.map((r) => r.role));

  for (const rule of set.rules) {
    if (ids.has(rule.id)) problems.push(`duplicate rule id '${rule.id}'`);
    ids.add(rule.id);

    if (rule.meta.framework !== set.framework) {
      problems.push(`rule '${rule.id}' declares framework '${rule.meta.framework}', set is '${set.framework}'`);
    }
    if (rule.meta.versions !== undefined && !isValidVersionRange(rule.meta.versions)) {
      problems.push(`rule '${rule.id}' declares invalid version range '${rule.meta.versions}'`);
    }
    for (const role of rule.roles ?? []) {
      if (!roles.has(role)) problems.push(`rule '${rule.id}' references unknown file role '${role}'`);
    }
    // Every placeholder must be bound by EVERY AST form of the rule (or be a deriver).
    for (const matcher of matchersOf(rule)) {
      const known = new Set([...matcherBindings(matcher), ...Object.keys(set.derivers)]);
      for (const placeholder of templatePlaceholders(rule)) {
        if (!known.has(placeholder)) {
          problems.push(`rule '${rule.id}' uses placeholder {${placeholder}} not bound by its '${matcher.kind}' form`);
        }
      }
    }
  }

  for (const rule of set.edgeRules ?? []) {
    if (ids.has(rule.id)) problems.push(`duplicate rule id '${rule.id}'`);
    ids.add(rule.id);

    if (rule.meta.framework !== set.framework) {
      problems.push(`edge rule '${rule.id}' declares framework '${rule.meta.framework}', set is '${set.framework}'`);
    }
    if (rule.meta.versions !== undefined && !isValidVersionRange(rule.meta.versions)) {
      problems.push(`edge rule '${rule.id}' declares invalid version range '${rule.meta.versions}'`);
    }
    if (rule.target.length === 0) problems.push(`edge rule '${rule.id}' declares no target strategy`);
    const known = new Set(EDGE_MATCHER_BINDINGS[rule.match.kind]);
    const scanEdgeTemplate = (tpl: string) => {
      for (const m of tpl.matchAll(PLACEHOLDER)) {
        if (!known.has(m[1])) problems.push(`edge rule '${rule.id}' uses placeholder {${m[1]}} not bound by its '${rule.match.kind}' form`);
      }
    };
    scanEdgeTemplate(rule.emit.name);
    for (const strategy of rule.target) {
      if (typeof strategy === 'object' && strategy.kind === 'syntheticContract') {
        scanEdgeTemplate(strategy.idScope);
        scanEdgeTemplate(strategy.contractName);
      }
    }
  }
  return problems;
}

/** One catalog row per rule — the shape a public "supported conventions" page is generated from. */
export interface ConventionCatalogRow {
  id: string;
  framework: string;
  versions?: string;
  description: string;
  roles: readonly string[] | null;
  produces: { type: string; entityType: string; patternId: string };
  fixture: string;
  specRef?: string;
}

export function describeConventions(set: ConventionSet): ConventionCatalogRow[] {
  const nodeRows: ConventionCatalogRow[] = set.rules.map((rule) => ({
    id: rule.id,
    framework: rule.meta.framework,
    ...(rule.meta.versions ? { versions: rule.meta.versions } : {}),
    description: rule.meta.description,
    roles: rule.roles,
    produces: { type: rule.emit.type, entityType: rule.emit.entityType, patternId: rule.emit.patternId },
    fixture: rule.meta.fixture,
    ...(rule.meta.specRef ? { specRef: rule.meta.specRef } : {}),
  }));
  const edgeRows: ConventionCatalogRow[] = (set.edgeRules ?? []).map((rule) => ({
    id: rule.id,
    framework: rule.meta.framework,
    ...(rule.meta.versions ? { versions: rule.meta.versions } : {}),
    description: rule.meta.description,
    roles: null,
    produces: { type: 'RELATIONSHIP', entityType: rule.emit.entityType, patternId: rule.emit.patternId },
    fixture: rule.meta.fixture,
    ...(rule.meta.specRef ? { specRef: rule.meta.specRef } : {}),
  }));
  return [...nodeRows, ...edgeRows];
}

export interface ConventionNodeMatcherDoc {
  kind: NodeMatcher['kind'];
  syntaxExample: string;
  fields: Record<string, string>;
  bindings: readonly string[];
  typicalUseCase: string;
}

export interface ConventionEdgeMatcherDoc {
  kind: EdgeMatcher['kind'];
  syntaxExample: string;
  fields: Record<string, string>;
  bindings: readonly string[];
  typicalUseCase: string;
}

export interface ConventionSchemaReference {
  configLocation: string;
  fileRoleSchema: {
    fields: Record<string, string>;
    example: { role: string; fileName: string; under: string | null };
  };
  nodeMatchers: readonly ConventionNodeMatcherDoc[];
  edgeMatchers: readonly ConventionEdgeMatcherDoc[];
  targetStrategies: ReadonlyArray<{ strategy: string; description: string }>;
  emitTypes: {
    CONTRACT: readonly string[];
    OPEN_CONNECTOR: readonly string[];
    RELATIONSHIP: readonly string[];
  };
  templates: ReadonlyArray<{
    title: string;
    solvesSignals: readonly string[];
    configSnippet: Record<string, unknown>;
  }>;
}

const NODE_MATCHER_DOCS: readonly ConventionNodeMatcherDoc[] = [
  {
    kind: 'exportedFunction',
    syntaxExample: "export async function GET(req: Request) { ... }",
    fields: { names: "string[] | '*'", 'directive?': "string (e.g. 'use server')" },
    bindings: ['name', 'originalName'],
    typicalUseCase: 'Exported route handlers, lifecycle hooks, or directive-scoped server actions.',
  },
  {
    kind: 'exportedDestructured',
    syntaxExample: 'export const { GET, POST } = handlers;',
    fields: { names: 'string[]' },
    bindings: ['name', 'originalName'],
    typicalUseCase: 'Destructured exports from auth/RPC factories.',
  },
  {
    kind: 'defaultExportedFunction',
    syntaxExample: 'export default function DashboardPage() { ... }',
    fields: { requireName: 'boolean' },
    bindings: ['componentName', 'originalName'],
    typicalUseCase: 'Framework file-role default exports (pages, layouts, middleware).',
  },
  {
    kind: 'exportAlias',
    syntaxExample: 'export { proxy as middleware }',
    fields: { exportedName: 'string' },
    bindings: ['originalName', 'exportedName'],
    typicalUseCase: 'Aliased framework convention exports.',
  },
  {
    kind: 'exportedConst',
    syntaxExample: "export const runtime = 'edge';",
    fields: { names: 'string[]' },
    bindings: ['name', 'originalName'],
    typicalUseCase: 'Named configuration or metadata constants.',
  },
  {
    kind: 'exportedWrappedFunction',
    syntaxExample: 'export const listUsers = withTenantAuth(async (ctx) => { ... });',
    fields: { wrappers: 'string[] (e.g. ["withTenantAuth", "createProcedure"])' },
    bindings: ['name', 'originalName'],
    typicalUseCase: 'Higher-order wrapper functions around exported contracts or components.',
  },
  {
    kind: 'exportedFactoryCall',
    syntaxExample: 'export const userQueue = createWorkerQueue("users", processor);',
    fields: { callees: 'string[]', 'calleeSyntax?': "'identifier' | 'member' | 'any'" },
    bindings: ['name', 'callee', 'originalName'],
    typicalUseCase: 'Exported contracts/queues/schemas created by project factory functions.',
  },
  {
    kind: 'callToIdentifier',
    syntaxExample: 'revalidateTag("posts");',
    fields: { names: 'string[]' },
    bindings: ['name', 'originalName'],
    typicalUseCase: 'Bare function calls acting as open connectors (cache, telemetry, pub/sub).',
  },
  {
    kind: 'callToMember',
    syntaxExample: "bus.publish('orders.created', payload)",
    fields: {
      'receivers?': 'string[]',
      'receiverEndsWith?': 'string[]',
      'excludeReceivers?': 'string[]',
      methods: "string[] | '*'",
      'arg0?': "'stringLiteral' | 'optionalStringLiteral' | 'routePathLiteral' | 'stringOrStringArray' | 'objectLiteralKeys'",
      'minArgs?': 'number',
      'maxArgs?': 'number',
    },
    bindings: ['method', 'METHOD', 'callee', 'originalName', 'arg0'],
    typicalUseCase: 'Custom router endpoints (`router.rpc("/x", fn)`) or broker/RPC open connectors (`bus.publish(...)`).',
  },
  {
    kind: 'callUseTarget',
    syntaxExample: "app.use('/v1', authMiddleware)",
    fields: { targetKind: "'middleware' | 'router'", 'excludeReceivers?': 'string[]' },
    bindings: ['pathPrefix', 'target', 'originalName'],
    typicalUseCase: 'Middleware or sub-router registration calls.',
  },
  {
    kind: 'variableInitializedByCall',
    syntaxExample: 'const ordersTable = defineEntity("orders", { ... });',
    fields: { callees: 'string[]' },
    bindings: ['name', 'callee', 'originalName'],
    typicalUseCase: 'Local or exported schema/entity definitions created via builder functions.',
  },
  {
    kind: 'fluentCallChain',
    syntaxExample: 'repo.select().from(orders)',
    fields: {
      roots: 'string[]',
      entryMethods: 'string[]',
      schemaArgMethods: 'string[]',
      mutateMethods: 'string[]',
      'relationalQueryMethods?': 'string[]',
    },
    bindings: ['root', 'entryMethod', 'originalName', 'schema', 'relType', 'relTypeLower'],
    typicalUseCase: 'Fluent ORM/query-builder chains emitting DB_QUERY open connectors + READS/MUTATES companion edges.',
  },
  {
    kind: 'typedObjectVariable',
    syntaxExample: 'export const UsersCollection: CollectionConfig = { ... };',
    fields: { typeNames: 'string[]' },
    bindings: ['name', 'typeName', 'originalName'],
    typicalUseCase: 'Typed declarative config objects (collections, workflows, resources).',
  },
  {
    kind: 'propertyAssignment',
    syntaxExample: 'endpoints: [{ path: "/sync", handler }]',
    fields: { names: 'string[]', valueKind: "'array' | 'object'" },
    bindings: ['name', 'originalName'],
    typicalUseCase: 'Object literal config sections declaring routes, fields, or access policies.',
  },
  {
    kind: 'sideEffectImport',
    syntaxExample: "import 'server-only';",
    fields: { modules: 'string[]' },
    bindings: ['module', 'originalName'],
    typicalUseCase: 'Boundary-enforcing side-effect imports.',
  },
  {
    kind: 'definePropertyCall',
    syntaxExample: "Object.defineProperty(req, 'tenant', { get() { ... } });",
    fields: { callees: 'string[]' },
    bindings: ['prop', 'originalName'],
    typicalUseCase: 'Prototype/object property getter contracts.',
  },
  {
    kind: 'commonjsAssignment',
    syntaxExample: 'module.exports = createService;',
    fields: { form: "'moduleExports' | 'prototypeMethod' | 'dynamicElement' | 'exportAlias'" },
    bindings: ['exportName', 'entityType', 'className', 'methodName', 'receiver', 'name', 'originalName'],
    typicalUseCase: 'CommonJS exports and prototype method contracts.',
  },
];

const EDGE_MATCHER_DOCS: readonly ConventionEdgeMatcherDoc[] = [
  {
    kind: 'jsxComponentElement',
    syntaxExample: '<CustomCard />',
    fields: { 'tagSyntax?': "'identifier' | 'member'" },
    bindings: ['tagName', 'rootName', 'memberName'],
    typicalUseCase: 'JSX component render edges (`RENDERS`).',
  },
  {
    kind: 'callUseTarget',
    syntaxExample: "server.use('/admin', adminPlugin)",
    fields: { targetKind: "'middleware' | 'router'" },
    bindings: ['pathPrefix', 'target'],
    typicalUseCase: 'Plugin/middleware/router mount edges (`MOUNT` or `INTERCEPTS`).',
  },
  {
    kind: 'callRouteTargets',
    syntaxExample: "rpc.command('/billing/charge', requireAuth, chargeHandler)",
    fields: {
      methods: 'string[]',
      position: "'middleware' | 'handler'",
      'excludeReceivers?': 'string[]',
    },
    bindings: ['path', 'target', 'method', 'METHOD'],
    typicalUseCase: 'Wiring custom route/RPC registrations to imported or same-file handler/middleware contracts.',
  },
  {
    kind: 'propertyArrayElements',
    syntaxExample: 'defineApp({ plugins: [ billingPlugin, auditPlugin ], handlers: [ syncHandler ] })',
    fields: {
      names: 'string[]',
      'allowCallElements?': 'boolean',
      'enclosingCall?': 'string',
    },
    bindings: ['propName', 'target'],
    typicalUseCase: 'Wiring config-array registries (`handlers`, `subscribers`, `plugins`, `jobs`) to their contracts.',
  },
];

/**
 * Returns the complete declarative convention & matcher schema reference (`[PAT-MCP-10]`, `[PAT-EXT-28]`)
 * used by coding agents to author paved-road TypeScript or `chomp.config.json#conventions` rules.
 */
export function describeConventionSchema(): ConventionSchemaReference {
  return {
    configLocation: 'chomp.config.json -> { "conventions": [ ConventionSet ] }',
    fileRoleSchema: {
      fields: {
        role: 'Uppercase role identifier referenced in ConventionRule.roles (e.g. "WORKER")',
        fileName: 'Exact base file name without extension (e.g. "worker")',
        under: 'Required ancestor directory segment (e.g. "jobs"), or null to match anywhere',
      },
      example: { role: 'WORKER', fileName: 'worker', under: 'jobs' },
    },
    nodeMatchers: NODE_MATCHER_DOCS,
    edgeMatchers: EDGE_MATCHER_DOCS,
    targetStrategies: [
      {
        strategy: 'importedComponent',
        description:
          'Resolves `{target}` or `{tagName}` via ES module imports to the target file contract (or external package connector).',
      },
      {
        strategy: 'sameFileExport',
        description: 'Resolves `{target}` or `{tagName}` to an exported contract declared in the same source file.',
      },
      {
        strategy: 'routerMount',
        description: 'Resolves a mounted router/plugin call argument to the target module router/contract.',
      },
      {
        strategy: 'lazyComponent',
        description: 'Resolves `React.lazy(() => import(...))` bindings.',
      },
      {
        strategy: 'nextDynamicComponent',
        description: 'Resolves `dynamic(() => import(...))` bindings.',
      },
      {
        strategy: 'namespacedComponent',
        description: 'Resolves `<Namespace.Member />` JSX compound component references.',
      },
      {
        strategy: '{ "kind": "syntheticContract", "idScope": "...", "contractName": "..." }',
        description:
          'Computes a deterministic contract ID from `{idScope}` and `{contractName}` templates (stripped automatically if target contract does not exist).',
      },
    ],
    emitTypes: {
      CONTRACT: [
        'EXPORTED_FUNCTION',
        'HTTP_ENDPOINT',
        'RPC_PROCEDURE',
        'SERVER_ACTION',
        'MIDDLEWARE',
        'REACT_COMPONENT',
        'DB_SCHEMA',
        'QUEUE_CONSUMER',
        'CLI_COMMAND',
        'MCP_TOOL',
      ],
      OPEN_CONNECTOR: [
        'HTTP_FETCH',
        'DB_QUERY',
        'MESSAGE_PUBLISH',
        'CACHE_OPERATION',
        'EXTERNAL_SDK_CALL',
        'EXTERNAL_PACKAGE',
      ],
      RELATIONSHIP: [
        'CALL',
        'RENDERS',
        'MOUNT',
        'INTERCEPTS',
        'HANDLES',
        'READS',
        'MUTATES',
        'REGISTERS',
      ],
    },
    templates: [
      {
        title: 'Custom HOF / Procedure Wrapper -> CONTRACT',
        solvesSignals: ['DARK_FILE', 'ORPHAN_CONTRACT'],
        configSnippet: {
          framework: 'custom-rpc',
          rules: [
            {
              id: 'custom-rpc.procedure',
              roles: null,
              match: {
                kind: 'exportedWrappedFunction',
                wrappers: ['defineProcedure', 'withAuthHandler'],
              },
              emit: {
                type: 'CONTRACT',
                entityType: 'RPC_PROCEDURE',
                patternId: 'custom-rpc.procedure',
                name: 'RPC Procedure: {name}',
              },
            },
          ],
        },
      },
      {
        title: 'Custom Event Bus / Broker Client -> OPEN_CONNECTOR',
        solvesSignals: ['UNRESOLVED_CALL', 'OPAQUE_BODY'],
        configSnippet: {
          framework: 'custom-bus',
          rules: [
            {
              id: 'custom-bus.publish',
              roles: null,
              match: {
                kind: 'callToMember',
                receivers: ['eventBus', 'broker'],
                methods: ['publish', 'dispatch'],
                arg0: 'optionalStringLiteral',
              },
              emit: {
                type: 'OPEN_CONNECTOR',
                entityType: 'MESSAGE_PUBLISH',
                patternId: 'custom-bus.publish',
                name: 'Event Publish: {arg0}',
              },
            },
          ],
        },
      },
      {
        title: 'Custom Route / Handler Registry -> CONTRACT + RELATIONSHIP EdgeRule',
        solvesSignals: ['ORPHAN_CONTRACT', 'UNRESOLVED_CALL'],
        configSnippet: {
          framework: 'custom-router',
          rules: [
            {
              id: 'custom-router.endpoint',
              roles: null,
              match: {
                kind: 'callToMember',
                receivers: ['rpcRouter'],
                methods: ['query', 'mutation'],
                arg0: 'stringLiteral',
              },
              emit: {
                type: 'CONTRACT',
                entityType: 'HTTP_ENDPOINT',
                patternId: 'custom-router.endpoint',
                name: 'RPC Endpoint: {METHOD} {arg0}',
              },
            },
          ],
          edgeRules: [
            {
              id: 'custom-router.handler-edge',
              match: {
                kind: 'callRouteTargets',
                methods: ['query', 'mutation'],
                position: 'handler',
              },
              target: ['importedComponent', 'sameFileExport'],
              emit: {
                entityType: 'HANDLES',
                patternId: 'custom-router.handler-edge',
                name: 'RPC Handler: {path} -> {target}',
                status: 'DETERMINISTIC',
                confidence: 'HIGH',
              },
            },
          ],
        },
      },
    ],
  };
}
