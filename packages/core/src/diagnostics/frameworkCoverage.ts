// packages/core/src/diagnostics/frameworkCoverage.ts
//
// Shared framework detection & post-extraction convention coverage / accuracy diagnostics.
//
// Principle of Incomplete Truth:
// 1. When a repository depends on a framework that has NO registered convention set in @chomp/core
//    (e.g. Fastify, NestJS, Hono), Chomp must warn that only generic TypeScript/ES module structure
//    is extracted and framework-specific conventions may be missing (`UNHANDLED_FRAMEWORK`).
// 2. When a repository depends on a supported framework (e.g. Next.js, Express, MCP SDK, Drizzle,
//    Payload CMS) in a package that contains extracted source entities, yet 0 entities from that
//    framework's convention set were produced, Chomp flags a suspected custom convention or
//    unhandled variant (`SUSPECTED_CUSTOM_CONVENTION`).
// 3. When a framework config file (e.g. `next.config.js` `pageExtensions`) uses a dynamic expression
//    that cannot be statically proven, Chomp surfaces `UNRESOLVED_CONVENTION_CONFIG`.

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { RepresentationGraph, StructuralNode } from '../types/index.js';
import { buildWorkspaceRegistry } from '../extractor/workspaceResolver.js';
import { getCachedSourceFile, preprocessAstroOrMdxSource } from '../extractor/visitors/targetResolver.js';
import { extractSymbolFromNodeName } from '../extractor/visitors/unresolvedConnectionVisitor.js';
import {
  CONVENTION_SETS,
  createConventionConfigResolver,
} from '../extractor/conventions/index.js';

export type FrameworkRuleCategory =
  | 'framework-adapter'
  | 'unhandled-framework'
  | 'library';

export interface FrameworkDetectionRule {
  label: string;
  deps: readonly string[];
  category: FrameworkRuleCategory;
  /** Matches `ConventionSet.framework` when `category === 'framework-adapter'`. */
  conventionSetId?: string;
}

export const FRAMEWORK_DETECTION_RULES: readonly FrameworkDetectionRule[] = [
  // Supported frameworks with declarative convention sets in `packages/core/src/extractor/conventions/`
  { label: 'Next.js', deps: ['next'], category: 'framework-adapter', conventionSetId: 'nextjs' },
  { label: 'React', deps: ['react', 'react-dom'], category: 'framework-adapter', conventionSetId: 'react' },
  { label: 'Express', deps: ['express'], category: 'framework-adapter', conventionSetId: 'express' },
  { label: 'Hono', deps: ['hono'], category: 'framework-adapter', conventionSetId: 'express' },
  {
    label: 'MCP SDK',
    deps: ['@modelcontextprotocol/sdk'],
    category: 'framework-adapter',
    conventionSetId: 'mcp',
  },
  {
    label: 'Payload CMS',
    deps: ['payload', '@payloadcms/next'],
    category: 'framework-adapter',
    conventionSetId: 'payload',
  },
  {
    label: 'Drizzle',
    deps: ['drizzle-orm'],
    category: 'framework-adapter',
    conventionSetId: 'drizzle',
  },
  {
    label: 'Astro',
    deps: ['astro'],
    category: 'framework-adapter',
    conventionSetId: 'astro',
  },
  {
    label: 'Svelte',
    deps: ['svelte', '@sveltejs/kit'],
    category: 'framework-adapter',
    conventionSetId: 'sveltekit',
  },

  // Known frameworks without a dedicated convention adapter yet (emit accuracy warnings)
  { label: 'Fastify', deps: ['fastify'], category: 'unhandled-framework' },
  { label: 'NestJS', deps: ['@nestjs/core'], category: 'unhandled-framework' },
  { label: 'Koa', deps: ['koa'], category: 'unhandled-framework' },
  {
    label: 'Remix',
    deps: ['@remix-run/react', '@remix-run/node'],
    category: 'unhandled-framework',
  },
  { label: 'tRPC', deps: ['@trpc/server'], category: 'unhandled-framework' },
  {
    label: 'GraphQL',
    deps: ['@apollo/server', 'type-graphql'],
    category: 'unhandled-framework',
  },
  { label: 'Vue', deps: ['vue', 'nuxt'], category: 'unhandled-framework' },
  { label: 'Angular', deps: ['@angular/core'], category: 'unhandled-framework' },

  // Standard libraries / runtimes displayed in workspace discovery
  { label: 'PixiJS', deps: ['pixi.js', 'pixi-viewport'], category: 'library' },
  { label: 'SQLite', deps: ['better-sqlite3', 'sqlite3'], category: 'library' },
  { label: 'Prisma', deps: ['prisma', '@prisma/client'], category: 'library' },
  { label: 'Supabase', deps: ['@supabase/supabase-js'], category: 'library' },
  { label: 'Commander CLI', deps: ['commander'], category: 'library' },
  { label: 'Tailwind CSS', deps: ['tailwindcss', '@tailwindcss/postcss'], category: 'library' },
];

export function detectFrameworkRulesFromDependencies(
  deps: Iterable<string>
): FrameworkDetectionRule[] {
  const allDeps = deps instanceof Set ? deps : new Set<string>(deps);
  const matched: FrameworkDetectionRule[] = [];
  for (const rule of FRAMEWORK_DETECTION_RULES) {
    if (rule.deps.some((d) => allDeps.has(d))) {
      matched.push(rule);
    }
  }
  return matched;
}

export function detectFrameworkRulesFromPackageJson(
  pkgJsonPath: string
): FrameworkDetectionRule[] {
  if (!fs.existsSync(pkgJsonPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const allDeps = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    return detectFrameworkRulesFromDependencies(allDeps);
  } catch {
    return [];
  }
}

export function detectFrameworksFromPackageJson(pkgJsonPath: string): string[] {
  if (!fs.existsSync(pkgJsonPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const allDeps = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    const found = detectFrameworkRulesFromPackageJson(pkgJsonPath).map((r) => r.label);
    if (found.length === 0 && allDeps.has('typescript')) {
      found.push('TypeScript');
    }
    return found;
  } catch {
    return [];
  }
}

export type FrameworkWarningKind =
  | 'UNHANDLED_FRAMEWORK'
  | 'SUSPECTED_CUSTOM_CONVENTION'
  | 'UNRESOLVED_CONVENTION_CONFIG';

export interface FrameworkCoverageWarning {
  kind: FrameworkWarningKind;
  packageName: string;
  packagePath: string;
  framework: string;
  conventionSetId?: string;
  configFile?: string;
  configKey?: string;
  message: string;
}

export interface PackageFrameworkCoverage {
  packageName: string;
  packagePath: string;
  frameworks: string[];
  supportedAdapters: string[];
  unhandledFrameworks: string[];
}

export interface UnextractedExportRecord {
  filePath: string;
  lineNumber: number;
  exportName: string;
  exportSyntax: string;
  snippet: string;
}

export interface FrameworkCoverageReport {
  packages: PackageFrameworkCoverage[];
  warnings: FrameworkCoverageWarning[];
  /**
   * Source files in USER scope (`analyzedFiles`) that produced 0 extracted Contracts,
   * 0 Class/Namespace boundaries, and 0 originating Relationships (Signal 4: Dark Files).
   */
  darkFiles: string[];
  /**
   * Top-level non-type, non-scalar `export` declarations in USER-scope source files that did not
   * produce any `CONTRACT` or `CLASS`/`NAMESPACE` `BOUNDARY` node (even if the file is only
   * partially dark or no other file imports the export).
   */
  unextractedExports: UnextractedExportRecord[];
}

function parseDuAnalyzedFiles(meta: unknown): string[] {
  if (!meta) return [];
  let obj: any = meta;
  if (typeof meta === 'string') {
    try {
      obj = JSON.parse(meta);
    } catch {
      return [];
    }
  }
  if (obj && Array.isArray(obj.analyzedFiles)) {
    return obj.analyzedFiles.filter((f: unknown): f is string => typeof f === 'string');
  }
  return [];
}

/**
 * Signal 4 (Dark Files): returns sorted relative file paths of non-barrel USER-scope source files
 * that produced 0 extracted Contracts, 0 Class/Namespace boundaries, and 0 originating Relationships
 * (including `INIT_BLOCK` edges).
 *
 * Works both on in-memory graphs (`graph.analyzedFiles`) and on graphs loaded from SQLite
 * (`DEPLOYMENT_UNIT` boundary `metadata.analyzedFiles`), without introducing `FILE` nodes into `nodes`.
 */
export function findDarkFiles(
  graph: Pick<RepresentationGraph, 'nodes' | 'edges' | 'analyzedFiles'>
): string[] {
  const candidates = new Set<string>();
  if (Array.isArray(graph.analyzedFiles) && graph.analyzedFiles.length > 0) {
    for (const f of graph.analyzedFiles) {
      candidates.add(f.replace(/\\/g, '/'));
    }
  } else {
    for (const n of graph.nodes) {
      if (n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT') {
        for (const f of parseDuAnalyzedFiles(n.metadata)) {
          candidates.add(f.replace(/\\/g, '/'));
        }
      }
    }
  }
  if (candidates.size === 0) return [];

  const activeFiles = new Set<string>();
  for (const n of graph.nodes) {
    if ((n.scope ?? 'USER') !== 'USER') continue;
    const isContract = n.type === 'CONTRACT';
    const isCodeBoundary =
      n.type === 'BOUNDARY' && (n.entityType === 'CLASS' || n.entityType === 'NAMESPACE');
    if (!isContract && !isCodeBoundary) continue;
    for (const fp of getEntityFilePaths(n)) {
      activeFiles.add(fp);
    }
  }

  for (const e of graph.edges) {
    if ((e.scope ?? 'USER') !== 'USER') continue;
    const ev = e.evidence;
    const list = Array.isArray(ev) ? ev : ev ? [ev] : [];
    for (const rec of list) {
      if (
        rec &&
        typeof rec.filePath === 'string' &&
        rec.evidenceRole !== 'import-match' &&
        rec.evidenceRole !== 'target-signature'
      ) {
        activeFiles.add(rec.filePath.replace(/\\/g, '/'));
      }
    }
  }

  return [...candidates].filter((f) => !activeFiles.has(f)).sort();
}

function unwrapTypeAssertions(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isAwaitExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function isScalarOrLiteralArray(expr: ts.Expression, depth = 0): boolean {
  if (depth > 6) return false;
  const e = unwrapTypeAssertions(expr);
  if (
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isTemplateExpression(e) ||
    ts.isRegularExpressionLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(e)) {
    return isScalarOrLiteralArray(e.operand, depth + 1);
  }
  if (ts.isBinaryExpression(e)) {
    return isScalarOrLiteralArray(e.left, depth + 1) && isScalarOrLiteralArray(e.right, depth + 1);
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.every((el) => ts.isExpression(el) && isScalarOrLiteralArray(el, depth + 1));
  }
  if (
    ts.isNewExpression(e) &&
    ts.isIdentifier(e.expression) &&
    (e.expression.text === 'Set' || e.expression.text === 'Map')
  ) {
    return (e.arguments ?? []).every((arg) => isScalarOrLiteralArray(arg, depth + 1));
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((prop) => {
      if (ts.isPropertyAssignment(prop)) {
        const init = unwrapTypeAssertions(prop.initializer);
        if (depth <= 1 && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          return false;
        }
        return (
          isScalarOrLiteralArray(init, depth + 1) ||
          (depth >= 2 && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
        );
      }
      if (ts.isSpreadAssignment(prop)) {
        return ts.isIdentifier(prop.expression) || isScalarOrLiteralArray(prop.expression, depth + 1);
      }
      return false;
    });
  }
  return false;
}

function formatCalleeLabel(expr: ts.Expression): string {
  const e = unwrapTypeAssertions(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const head = formatCalleeLabel(e.expression);
    return head ? `${head}.${e.name.text}` : e.name.text;
  }
  return 'anonymous';
}

function classifyExportInitializerSyntax(expr: ts.Expression): string {
  const e = unwrapTypeAssertions(expr);
  if (ts.isCallExpression(e)) {
    return `Call(${formatCalleeLabel(e.expression)})`;
  }
  if (ts.isNewExpression(e)) {
    return `New(${formatCalleeLabel(e.expression)})`;
  }
  if (ts.isObjectLiteralExpression(e)) return 'ObjectLiteral';
  if (ts.isArrayLiteralExpression(e)) return 'ArrayLiteral';
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return 'FunctionExpr';
  if (ts.isClassExpression(e)) return 'ClassExpr';
  if (ts.isTaggedTemplateExpression(e)) {
    return `TaggedTemplate(${formatCalleeLabel(e.tag)})`;
  }
  if (ts.isIdentifier(e)) return `Identifier(${e.text})`;
  return ts.SyntaxKind[e.kind] ?? 'Expression';
}

/**
 * Inspects every USER-scope source file (`analyzedFiles`) and returns top-level non-type,
 * non-scalar `export` declarations (`export const x = factory(...)`, `export const cfg = { ... }`,
 * `export default ...`) that did not produce any `CONTRACT` or `CLASS`/`NAMESPACE` `BOUNDARY` node.
 *
 * Catches unhandled export patterns even when:
 *   1. The file is only partially dark (another export or `INIT_BLOCK` edge made the file active).
 *   2. No other file in the repository imports the export yet.
 */
export function findUnextractedExports(
  repoRoot: string,
  graph: Pick<RepresentationGraph, 'nodes' | 'edges' | 'analyzedFiles'>
): UnextractedExportRecord[] {
  const absRoot = path.resolve(repoRoot);
  const rootDir =
    fs.existsSync(absRoot) && fs.statSync(absRoot).isFile()
      ? path.dirname(absRoot)
      : absRoot;

  const candidates = new Set<string>();
  if (Array.isArray(graph.analyzedFiles) && graph.analyzedFiles.length > 0) {
    for (const f of graph.analyzedFiles) {
      candidates.add(f.replace(/\\/g, '/'));
    }
  } else {
    for (const n of graph.nodes) {
      if (n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT') {
        for (const f of parseDuAnalyzedFiles(n.metadata)) {
          candidates.add(f.replace(/\\/g, '/'));
        }
      }
    }
  }
  if (candidates.size === 0) return [];

  const extractedSymbolsByFile = new Map<string, Set<string>>();
  const extractedLinesByFile = new Map<string, Set<number>>();

  for (const n of graph.nodes) {
    if ((n.scope ?? 'USER') !== 'USER') continue;
    const isContract = n.type === 'CONTRACT';
    const isCodeBoundary =
      n.type === 'BOUNDARY' && (n.entityType === 'CLASS' || n.entityType === 'NAMESPACE');
    if (!isContract && !isCodeBoundary) continue;

    const syms = extractSymbolFromNodeName(n as StructuralNode);
    const orig = (n.metadata as any)?.originalName;
    if (typeof orig === 'string' && orig.length > 0) syms.push(orig);
    const comp = (n.metadata as any)?.componentName;
    if (typeof comp === 'string' && comp.length > 0) syms.push(comp);

    const evList = Array.isArray(n.evidence) ? n.evidence : n.evidence ? [n.evidence] : [];
    for (const ev of evList) {
      if (!ev || typeof ev.filePath !== 'string') continue;
      const fp = ev.filePath.replace(/\\/g, '/');
      let symSet = extractedSymbolsByFile.get(fp);
      if (!symSet) {
        symSet = new Set<string>();
        extractedSymbolsByFile.set(fp, symSet);
      }
      for (const s of syms) symSet.add(s);

      if (typeof ev.lineNumber === 'number') {
        let lineSet = extractedLinesByFile.get(fp);
        if (!lineSet) {
          lineSet = new Set<number>();
          extractedLinesByFile.set(fp, lineSet);
        }
        lineSet.add(ev.lineNumber);
      }
    }
  }

  const results: UnextractedExportRecord[] = [];
  const sortedFiles = [...candidates].sort();

  for (const relFile of sortedFiles) {
    const absFile = path.resolve(rootDir, relFile);
    if (!fs.existsSync(absFile)) continue;

    let sf: ts.SourceFile;
    try {
      sf =
        getCachedSourceFile(absFile) ??
        ts.createSourceFile(
          absFile,
          preprocessAstroOrMdxSource(absFile, fs.readFileSync(absFile, 'utf8')),
          ts.ScriptTarget.Latest,
          true,
          /\.(?:astro|mdx|vue|svelte)$/i.test(absFile) ? ts.ScriptKind.TSX : undefined
        );
    } catch {
      continue;
    }

    const symSet = extractedSymbolsByFile.get(relFile) ?? new Set<string>();
    const lineSet = extractedLinesByFile.get(relFile) ?? new Set<number>();

    const hasExtractedInSpan = (node: ts.Node): boolean => {
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      for (const l of lineSet) {
        if (l >= startLine && l <= endLine) return true;
      }
      return false;
    };

    const makeSnippet = (node: ts.Node): { lineNumber: number; snippet: string } => {
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const snippet = node.getText(sf).slice(0, 80).replace(/\s+/g, ' ').trim();
      return { lineNumber: startLine, snippet };
    };

    for (const stmt of sf.statements) {
      const modifiers = (stmt as ts.HasModifiers).modifiers;
      const hasExport = Boolean(
        modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      );

      if (ts.isVariableStatement(stmt) && hasExport) {
        if (hasExtractedInSpan(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (!decl.initializer || isScalarOrLiteralArray(decl.initializer)) continue;
          const names: string[] = [];
          if (ts.isIdentifier(decl.name)) {
            names.push(decl.name.text);
          } else if (ts.isObjectBindingPattern(decl.name)) {
            for (const el of decl.name.elements) {
              if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                names.push(el.name.text);
              }
            }
          }
          if (names.length > 0 && names.every((n) => !symSet.has(n))) {
            const { lineNumber, snippet } = makeSnippet(stmt);
            results.push({
              filePath: relFile,
              lineNumber,
              exportName: names.join(', '),
              exportSyntax: classifyExportInitializerSyntax(decl.initializer),
              snippet,
            });
          }
        }
      } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        if (symSet.has('default') || hasExtractedInSpan(stmt)) continue;
        if (isScalarOrLiteralArray(stmt.expression)) continue;
        const unwrapped = unwrapTypeAssertions(stmt.expression);
        if (ts.isIdentifier(unwrapped) && symSet.has(unwrapped.text)) continue;
        const { lineNumber, snippet } = makeSnippet(stmt);
        results.push({
          filePath: relFile,
          lineNumber,
          exportName: 'default',
          exportSyntax: classifyExportInitializerSyntax(stmt.expression),
          snippet,
        });
      }
    }
  }

  return results;
}

function patternIdsForConventionSet(conventionSetId: string): Set<string> {
  const ids = new Set<string>();
  const set = CONVENTION_SETS.find((s) => s.framework === conventionSetId);
  if (!set) return ids;
  for (const r of set.rules) {
    ids.add(r.emit.patternId);
    if (r.emit.companionRelationship) {
      ids.add(r.emit.companionRelationship.patternId);
    }
  }
  for (const er of set.edgeRules ?? []) {
    ids.add(er.emit.patternId);
  }
  if (conventionSetId === 'react') {
    ids.add('contract.react-functional-component');
    ids.add('contract.react-context');
    ids.add('contract.styled-component');
  } else if (conventionSetId === 'astro') {
    ids.add('contract.astro-svg-component-import');
  }
  return ids;
}

function getEntityFilePaths(entity: { evidence?: any }): string[] {
  const ev = entity.evidence;
  if (!ev) return [];
  const list = Array.isArray(ev) ? ev : [ev];
  return list
    .map((r) => (typeof r?.filePath === 'string' ? r.filePath.replace(/\\/g, '/') : ''))
    .filter(Boolean);
}

function pathBelongsToPackage(filePath: string, relPkgPath: string): boolean {
  if (relPkgPath === '.' || relPkgPath === '') return true;
  const normFile = filePath.replace(/\\/g, '/');
  const normPkg = relPkgPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normFile === normPkg || normFile.startsWith(`${normPkg}/`);
}

/**
 * Evaluates a repository's `package.json` dependencies and convention configs against the extracted
 * `RepresentationGraph` to surface accuracy warnings for unhandled frameworks, suspected custom
 * conventions (0 framework contracts extracted despite the framework dependency), and dynamic
 * convention config values.
 */
export function auditFrameworkCoverage(
  repoRoot: string,
  graph: Pick<RepresentationGraph, 'nodes' | 'edges' | 'analyzedFiles'>,
  excludeWorkspaces: readonly string[] = []
): FrameworkCoverageReport {
  const absRoot = path.resolve(repoRoot);
  const rootDir =
    fs.existsSync(absRoot) && fs.statSync(absRoot).isFile()
      ? path.dirname(absRoot)
      : absRoot;

  const registry = buildWorkspaceRegistry(rootDir);
  const excludedSet = new Set(excludeWorkspaces.map((w) => w.trim()).filter(Boolean));
  const entries = Object.entries(registry);

  const packageTargets: Array<{ name: string; relPath: string; absPath: string }> = [];
  if (entries.length === 0) {
    const rootPkgJson = path.join(rootDir, 'package.json');
    let rootName = path.basename(rootDir);
    if (fs.existsSync(rootPkgJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(rootPkgJson, 'utf8'));
        if (parsed.name) rootName = parsed.name;
      } catch {
        // ignore
      }
    }
    packageTargets.push({ name: rootName, relPath: '.', absPath: rootDir });
  } else {
    for (const [name, absPath] of entries) {
      const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/') || '.';
      const shortName = name.replace(/^@[^/]+\//, '');
      if (
        excludedSet.has(name) ||
        excludedSet.has(relPath) ||
        excludedSet.has(shortName)
      ) {
        continue;
      }
      packageTargets.push({ name, relPath, absPath });
    }
    packageTargets.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  const packages: PackageFrameworkCoverage[] = [];
  const warnings: FrameworkCoverageWarning[] = [];

  for (const pkg of packageTargets) {
    const pkgJsonPath = path.join(pkg.absPath, 'package.json');
    const matchedRules = detectFrameworkRulesFromPackageJson(pkgJsonPath);
    const frameworks = detectFrameworksFromPackageJson(pkgJsonPath);
    const supportedAdapters = matchedRules
      .filter((r) => r.category === 'framework-adapter')
      .map((r) => r.label);
    const unhandledFrameworks = matchedRules
      .filter((r) => r.category === 'unhandled-framework')
      .map((r) => r.label);

    packages.push({
      packageName: pkg.name,
      packagePath: pkg.relPath,
      frameworks,
      supportedAdapters,
      unhandledFrameworks,
    });

    // 1. Accuracy warning for unhandled frameworks
    for (const rule of matchedRules) {
      if (rule.category === 'unhandled-framework') {
        warnings.push({
          kind: 'UNHANDLED_FRAMEWORK',
          packageName: pkg.name,
          packagePath: pkg.relPath,
          framework: rule.label,
          message: `Package "${pkg.name}" (${pkg.relPath}) depends on ${rule.label}, which has no dedicated convention adapter yet. Generic TypeScript/ES module structure is extracted, but ${rule.label}-specific conventions may be missing.`,
        });
      }
    }

    // 2. Coverage check for supported framework adapters
    const pkgNodes = graph.nodes.filter(
      (n) =>
        (n.scope ?? 'USER') === 'USER' &&
        n.entityType !== 'DEPLOYMENT_UNIT' &&
        n.type !== 'OPEN_CONNECTOR' &&
        getEntityFilePaths(n).some((fp) => pathBelongsToPackage(fp, pkg.relPath))
    );
    const pkgEdges = graph.edges.filter(
      (e) =>
        (e.scope ?? 'USER') === 'USER' &&
        getEntityFilePaths(e).some((fp) => pathBelongsToPackage(fp, pkg.relPath))
    );

    const pkgConnectorNodes = graph.nodes.filter(
      (n) =>
        (n.scope ?? 'USER') === 'USER' &&
        n.type === 'OPEN_CONNECTOR' &&
        getEntityFilePaths(n).some((fp) => pathBelongsToPackage(fp, pkg.relPath))
    );

    if (pkgNodes.length > 0) {
      for (const rule of matchedRules) {
        if (rule.category !== 'framework-adapter' || !rule.conventionSetId) continue;
        const patternIds = patternIdsForConventionSet(rule.conventionSetId);
        const astroPageNodeCount =
          rule.conventionSetId === 'astro'
            ? pkgNodes.filter((n) =>
                getEntityFilePaths(n).some((fp) => fp.toLowerCase().endsWith('.astro'))
              ).length
            : 0;
        const matchCount =
          pkgNodes.filter((n) => patternIds.has(n.patternId)).length +
          pkgEdges.filter((e) => patternIds.has(e.patternId)).length +
          astroPageNodeCount;

        if (matchCount === 0) {
          let runtimeDeps = new Set<string>();
          if (fs.existsSync(pkgJsonPath)) {
            try {
              const parsedPkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
              runtimeDeps = new Set<string>(Object.keys(parsedPkg.dependencies ?? {}));
            } catch {
              // ignore
            }
          }
          const isRuntimeDep = rule.deps.some((d) => runtimeDeps.has(d));
          const hasFrameworkImport = pkgConnectorNodes.some((n) =>
            rule.deps.some(
              (dep) => n.name === `Package: ${dep}` || n.name.startsWith(`Package: ${dep}/`)
            )
          );
          // Skip warning if the framework is only declared in peerDependencies / devDependencies
          // (e.g. a plugin or optional integration) and never imported at runtime, or if the
          // package never imports any of the framework's packages when package connectors exist.
          if (!isRuntimeDep && !hasFrameworkImport) continue;
          if ((packageTargets.length > 1 || pkgConnectorNodes.length > 0) && !hasFrameworkImport) {
            continue;
          }
          if (rule.conventionSetId === 'mcp') {
            const mcpEvSnippets = pkgConnectorNodes
              .filter(
                (n) =>
                  n.name === 'Package: @modelcontextprotocol/sdk' ||
                  n.name.startsWith('Package: @modelcontextprotocol/sdk/')
              )
              .flatMap((n) =>
                Array.isArray(n.evidence) ? n.evidence : n.evidence ? [n.evidence] : []
              )
              .map((ev) => (typeof ev?.snippet === 'string' ? ev.snippet : ''))
              .filter(Boolean);
            if (
              mcpEvSnippets.length > 0 &&
              mcpEvSnippets.every((s) => s.includes('@modelcontextprotocol/sdk/client')) &&
              !mcpEvSnippets.some((s) => s.includes('@modelcontextprotocol/sdk/server'))
            ) {
              continue;
            }
          }
          warnings.push({
            kind: 'SUSPECTED_CUSTOM_CONVENTION',
            packageName: pkg.name,
            packagePath: pkg.relPath,
            framework: rule.label,
            conventionSetId: rule.conventionSetId,
            message: `Package "${pkg.name}" (${pkg.relPath}) declares ${rule.label} (convention set "${rule.conventionSetId}"), but 0 ${rule.label} conventions were extracted across ${pkgNodes.length} entities. Check for custom wrappers or non-standard directory conventions.`,
          });
        }
      }
    }
  }

  // 3. Check for statically unresolved convention configs (e.g. dynamic `pageExtensions` in `next.config.js`)
  const configResolver = createConventionConfigResolver(rootDir);
  for (const set of CONVENTION_SETS) {
    if (!set.extensionConfig) continue;
    for (const pkg of packageTargets) {
      const probeFile = path.join(pkg.absPath, 'index.ts');
      configResolver.extensionsFor(set, probeFile);
    }
  }
  const seenConfigKeys = new Set<string>();
  for (const unres of configResolver.unresolved) {
    const dedupKey = `${unres.framework}:${unres.file}:${unres.key}`;
    if (seenConfigKeys.has(dedupKey)) continue;
    seenConfigKeys.add(dedupKey);
    warnings.push({
      kind: 'UNRESOLVED_CONVENTION_CONFIG',
      packageName: path.basename(rootDir),
      packagePath: path.dirname(unres.file) || '.',
      framework: unres.framework,
      conventionSetId: unres.framework,
      configFile: unres.file,
      configKey: unres.key,
      message: `Convention config "${unres.key}" in ${unres.file} (${unres.framework}) is not a static string-literal array (${unres.reason}); falling back to default extensions.`,
    });
  }

  const darkFiles = findDarkFiles(graph);
  const unextractedExports = findUnextractedExports(rootDir, graph);
  return { packages, warnings, darkFiles, unextractedExports };
}
