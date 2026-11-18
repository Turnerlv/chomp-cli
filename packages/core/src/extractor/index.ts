// packages/core/src/extractor/index.ts
// Extraction orchestrator — walks source files, dispatches to visitors, and assembles the RepresentationGraph.

import fs from 'fs';
import ignore from 'ignore';
import path from 'path';
import ts from 'typescript';
import {
  EvidenceRecord,
  RepresentationGraph,
  StructuralNode,
  StructuralEdge,
} from '../types/index.js';
import { visitBoundary } from './visitors/boundaryVisitor.js';
import { visitContract } from './visitors/contractVisitor.js';
import { visitRelationship, createUserEdgeTargetResolvers } from './visitors/relationshipVisitor.js';
import { visitOpenConnector, stitchIntraRepoHttpCalls } from './visitors/openConnectorVisitor.js';
import { extractDirectiveRuntime } from './visitors/directiveVisitor.js';
import { createInitBlock, findScopeOwnerId, isFunctionLikeNode, ownershipAnchors, propagateLocalHelperOwners, SCOPE_SOURCE_PLACEHOLDER } from './visitors/initBlockVisitor.js';
import { clearTargetResolverCache, getCachedSourceFile, packageConnectorId } from './visitors/targetResolver.js';
import { clearPathResolverCache } from './pathResolver.js';
import { CORE_EXTRACTOR_VERSION } from '../version.js';
import {
  reconcileUnresolvedConnections,
  isStaticAssetPath,
  STATIC_ASSET_EXTENSIONS,
  type ParsedSourceUnit,
  type UnresolvedConnectionReason,
  type ImportUsageKind,
  type UnresolvedIncomingReference,
  type UnresolvedOutgoingReference,
} from './visitors/unresolvedConnectionVisitor.js';
import {
  classifyNextjsFile,
  collectRoutedUnderscorePrefixes,
  NextjsFileRole,
} from './adapters/nextjsAdapter.js';
import { createConventionConfigResolver, loadUserConventionSets } from './conventions/config.js';
import { applyConventionRules, applyEdgeRules, classifyFileRole, unwrapWrappedFunction } from './conventions/engine.js';
import { NEXTJS_CONVENTIONS } from './conventions/nextjs.js';
import { REACT_HOC_WRAPPERS } from './conventions/react.js';
import {
  HTTP_ROUTE_CONTRACT_PATTERN_ID,
  HTTP_ROUTE_HANDLER_EDGE_PATTERN_ID,
  HTTP_ROUTE_MIDDLEWARE_EDGE_PATTERN_ID,
  ROUTE_HANDLER_CONTRACT_PATTERN_ID,
  collectReferencedSvgComponentNodes,
  disambiguateCollidingOpenConnectors,
  findTopLevelCliInvocationStatements,
  unwrapCachedFunctionInitializer,
} from './conventions/index.js';
import { SUPPORTED_SOURCE_EXTENSIONS } from './sourcePreprocessor.js';
import {
  attachDecomposedBoundaries,
  buildWorkspaceRegistry,
  getDecomposedBoundaryPlan,
  loadUserBoundaryRules,
  parseUserBoundaryRules,
  resolveBoundaryForFile,
  type DecomposedBoundaryPlan,
  type DecomposedBoundaryRule,
  type ResolvedFileBoundary,
  type WorkspaceRegistry,
} from './workspaceResolver.js';
import {
  stableEntityId,
  cjsContractEntityId,
  contractEntityId,
  boundaryEntityId,
  setActiveCollidingContractKeys,
  setActiveCollidingBoundaryKeys,
  computeAstBodyHash,
  formatLogicalBoundaryScope,
  findEnclosingNamespaceScope,
  resolveLogicalBoundaryScope,
} from '../utils/id.js';

export {
  stableEntityId,
  cjsContractEntityId,
  contractEntityId,
  boundaryEntityId,
  computeAstBodyHash,
  formatLogicalBoundaryScope,
  findEnclosingNamespaceScope,
  resolveLogicalBoundaryScope,
  attachDecomposedBoundaries,
  buildWorkspaceRegistry,
  getDecomposedBoundaryPlan,
  loadUserBoundaryRules,
  parseUserBoundaryRules,
  resolveBoundaryForFile,
  type DecomposedBoundaryPlan,
  type DecomposedBoundaryRule,
  type ResolvedFileBoundary,
  type WorkspaceRegistry,
  isStaticAssetPath,
  STATIC_ASSET_EXTENSIONS,
  type UnresolvedConnectionReason,
  type ImportUsageKind,
  type UnresolvedIncomingReference,
  type UnresolvedOutgoingReference,
};

const TOOLING_CONFIG_STEM_RE =
  /^(?:jest|vitest|cypress|playwright|karma|mocha|ava|tsup|rollup|vite|webpack|rspack|esbuild|babel|swc|postcss|tailwind|eslint|prettier|stylelint|commitlint|lint-staged|nano-staged|husky|nodemon|pm2|ecosystem|turbo|nx|lerna|gulpfile|gruntfile)(?:\.[a-z0-9_-]+)*$/i;

/**
 * Recursively collects all TypeScript and JavaScript source files under the given path.
 *
 * Skips node_modules, .git, dist, and build directories automatically.
 * If targetPath points to a single file, that file is returned directly.
 *
 * @param targetPath  Absolute or relative path to a file or directory.
 * @returns Sorted list of absolute file paths to analyze.
 */
export function collectFiles(targetPath: string): string[] {
  const absolutePath = path.resolve(targetPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Target path does not exist: ${targetPath}`);
  }

  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    return [absolutePath];
  }

  // Load .chompignore if it exists
  const ig = (ignore as any).default ? (ignore as any).default() : (ignore as any)();
  const ignorePath = path.join(absolutePath, '.chompignore');
  const hasIgnoreFile = fs.existsSync(ignorePath);
  if (hasIgnoreFile) {
    ig.add(fs.readFileSync(ignorePath, 'utf8'));
  }

  const files: string[] = [];

  function walkDir(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      
      // Calculate path relative to root target for ignore testing
      const relativePath = path.relative(absolutePath, fullPath);
      const relSegments = relativePath.toLowerCase().split(/[/\\]/);
      const inSrcOrApp = relSegments.slice(0, -1).some((s) => s === 'src' || s === 'app');

      if (entry.isDirectory()) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'out' ||
          entry.name === 'out-tsc' ||
          entry.name === 'build' ||
          entry.name === 'coverage' ||
          entry.name === 'test' ||
          entry.name === 'tests' ||
          entry.name === '__tests__' ||
          entry.name === 'spec' ||
          entry.name === 'specs' ||
          entry.name === '__mocks__' ||
          entry.name === 'fixtures' ||
          entry.name === 'fixture' ||
          entry.name === '__fixtures__' ||
          entry.name === 'templates' ||
          entry.name === 'template' ||
          entry.name === 'benchmarks' ||
          entry.name === 'benchmark' ||
          entry.name === 'perf-measures' ||
          entry.name === 'vendor' ||
          entry.name === 'vendors' ||
          entry.name === 'migrations' ||
          entry.name === 'migration' ||
          entry.name === 'upgrades' ||
          (!inSrcOrApp &&
            (entry.name === 'examples' ||
              entry.name === 'example' ||
              entry.name === 'sample' ||
              entry.name === 'samples' ||
              entry.name === 'integration' ||
              entry.name === 'integrations' ||
              entry.name === 'e2e' ||
              entry.name === 'upgrade'))
        ) {
          continue;
        }

        // Apply .chompignore for directories
        if (hasIgnoreFile && ig.ignores(relativePath + '/')) {
          continue;
        }

        walkDir(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        // Apply .chompignore for files
        if (hasIgnoreFile && ig.ignores(relativePath)) {
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!inSrcOrApp && relSegments.includes('docs') && ext === '.mdx') {
          continue;
        }
        if (SUPPORTED_SOURCE_EXTENSIONS.has(ext)) {
          const lowerName = entry.name.toLowerCase();
          const stem = lowerName.slice(0, lowerName.length - ext.length);
          if (
            !lowerName.includes('.test.') &&
            !lowerName.includes('.spec.') &&
            !lowerName.includes('.mock.') &&
            !lowerName.includes('.d.ts') &&
            !lowerName.endsWith('.d.mts') &&
            !lowerName.endsWith('.d.cts') &&
            !lowerName.endsWith('.min.js') &&
            !lowerName.endsWith('.min.cjs') &&
            !lowerName.endsWith('.min.mjs') &&
            !lowerName.includes('.bundle.js') &&
            !((ext === '.mjs' || ext === '.cjs') && stem.endsWith('.config')) &&
            !TOOLING_CONFIG_STEM_RE.test(stem)
          ) {
            files.push(fullPath);
          }
        }
      }
    }
  }

  walkDir(absolutePath);
  return files;
}

/**
 * Classifies a file's logical scope from its path segments (USER by default).
 *
 * @param relativePath Path relative to the analysis root.
 */
function detectScope(relativePath: string): 'USER' | 'TEST' | 'MOCK' | 'CONFIG' | 'EXAMPLE' | 'BENCHMARK' {
  const lowerPath = relativePath.toLowerCase();
  const pathSegments = lowerPath.split(/[/\\]/);
  const fileName = pathSegments[pathSegments.length - 1] ?? '';
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  const inSrcOrApp = pathSegments.some((s) => s === 'src' || s === 'app');
  if (
    pathSegments.includes('test') ||
    pathSegments.includes('tests') ||
    pathSegments.includes('__tests__') ||
    pathSegments.includes('spec') ||
    pathSegments.includes('specs') ||
    pathSegments.includes('fixtures') ||
    pathSegments.includes('__fixtures__') ||
    (!inSrcOrApp &&
      (pathSegments.includes('integration') ||
        pathSegments.includes('integrations') ||
        pathSegments.includes('e2e'))) ||
    lowerPath.includes('.test.') ||
    lowerPath.includes('.spec.')
  ) {
    return 'TEST';
  } else if (
    pathSegments.includes('__mocks__') ||
    lowerPath.includes('.mock.') ||
    (!inSrcOrApp && (pathSegments.includes('mock') || pathSegments.includes('mocks')))
  ) {
    return 'MOCK';
  } else if (
    pathSegments.includes('templates') ||
    pathSegments.includes('template') ||
    fileName.startsWith('.') ||
    TOOLING_CONFIG_STEM_RE.test(stem)
  ) {
    return 'CONFIG';
  } else if (
    !inSrcOrApp &&
    (pathSegments.includes('example') ||
      pathSegments.includes('examples') ||
      pathSegments.includes('sample') ||
      pathSegments.includes('samples'))
  ) {
    return 'EXAMPLE';
  } else if (
    pathSegments.includes('benchmark') ||
    pathSegments.includes('benchmarks') ||
    pathSegments.includes('perf-measures')
  ) {
    return 'BENCHMARK';
  }
  return 'USER';
}

/** Book-keeping for one DEPLOYMENT_UNIT and its lazily created INIT_BLOCK. */
interface DeploymentUnitRef {
  id: string;
  label: string;
  initId?: string;
  initNode?: StructuralNode;
}

function isPureStaticDataExpr(expr: ts.Expression, depth = 0): boolean {
  if (depth > 12) return false;
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    (ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      ts.isIdentifier(cur.expression.expression) &&
      cur.expression.expression.text === 'Object' &&
      cur.expression.name.text === 'freeze' &&
      cur.arguments.length >= 1)
  ) {
    cur = ts.isCallExpression(cur) ? cur.arguments[0] : cur.expression;
  }
  if (
    ts.isStringLiteral(cur) ||
    ts.isNumericLiteral(cur) ||
    ts.isBigIntLiteral(cur) ||
    ts.isNoSubstitutionTemplateLiteral(cur) ||
    ts.isTemplateExpression(cur) ||
    ts.isRegularExpressionLiteral(cur) ||
    cur.kind === ts.SyntaxKind.TrueKeyword ||
    cur.kind === ts.SyntaxKind.FalseKeyword ||
    cur.kind === ts.SyntaxKind.NullKeyword ||
    cur.kind === ts.SyntaxKind.UndefinedKeyword ||
    ts.isIdentifier(cur)
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(cur)) {
    return isPureStaticDataExpr(cur.operand, depth + 1);
  }
  if (ts.isBinaryExpression(cur)) {
    return isPureStaticDataExpr(cur.left, depth + 1) && isPureStaticDataExpr(cur.right, depth + 1);
  }
  if (ts.isArrayLiteralExpression(cur)) {
    return cur.elements.every((el) => ts.isExpression(el) && isPureStaticDataExpr(el, depth + 1));
  }
  if (
    ts.isNewExpression(cur) &&
    ts.isIdentifier(cur.expression) &&
    (cur.expression.text === 'Set' || cur.expression.text === 'Map')
  ) {
    return (cur.arguments ?? []).every((arg) => isPureStaticDataExpr(arg, depth + 1));
  }
  if (ts.isObjectLiteralExpression(cur)) {
    return cur.properties.every((prop) => {
      if (ts.isPropertyAssignment(prop)) {
        const init = prop.initializer;
        if (depth <= 1 && isFunctionLikeNode(init)) return false;
        return isPureStaticDataExpr(init, depth + 1) || (depth >= 2 && isFunctionLikeNode(init));
      }
      if (ts.isShorthandPropertyAssignment(prop)) return true;
      if (ts.isSpreadAssignment(prop)) return isPureStaticDataExpr(prop.expression, depth + 1);
      return false;
    });
  }
  return false;
}

/**
 * Returns true when `sourceFile` contains only empty statements, imports with an importClause,
 * re-export / type-only declarations (`export * from ...`, `export { x } from ...`, `export type ...`),
 * or pure static data/constant `VariableStatement` tables (`ConventionSet`, constant arrays/sets).
 * Pure re-export barrels and static constant tables have no executable contracts or module-init calls
 * of their own, so they should not be flagged as Dark Files.
 */
function isPureBarrelOrEmptyFile(sourceFile: ts.SourceFile): boolean {
  if (sourceFile.statements.length === 0) return true;
  return sourceFile.statements.every((stmt) => {
    if (ts.isEmptyStatement(stmt)) return true;
    if (ts.isImportDeclaration(stmt) && Boolean(stmt.importClause)) return true;
    if (ts.isImportEqualsDeclaration(stmt)) return true;
    if (ts.isExportDeclaration(stmt)) return true;
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
      const hasExport = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      return !hasExport;
    }
    if (ts.isVariableStatement(stmt)) {
      return stmt.declarationList.declarations.every(
        (decl) => Boolean(decl.initializer && isPureStaticDataExpr(decl.initializer))
      );
    }
    return false;
  });
}

/**
 * Core extraction entry point (Ontology v4.0 — Ephemeral Code).
 *
 * Walks every source file in targetPath and passes each AST node through all four primitive
 * visitors in a single traversal pass. Files and directories are NOT graph primitives: they
 * survive only as positional metadata in `evidence.filePath`.
 *
 * Structure produced:
 * - One DEPLOYMENT_UNIT boundary per workspace package (or one for the analysis root when the
 *   repository declares no workspace packages). Top-level contracts/classes are parented to it.
 * - CLASS / NAMESPACE boundaries and Contracts (incl. PUBLIC_METHOD parented to its class).
 * - A lazily created INIT_BLOCK boundary per deployment unit: the source of every relationship
 *   that executes at module-evaluation time (not inside an extracted contract / class).
 * - Relationships whose source is the nearest enclosing extracted contract/class, or the INIT_BLOCK.
 * - External packages and Node built-ins as OPEN_CONNECTOR nodes (exit points); IMPORT/REQUIRE
 *   statements emit no relationship of their own.
 *
 * Visitor pattern:
 * - Each visitor receives a no-op `nextId` closure. Returned entities have their IDs
 *   replaced immediately by stableEntityId() before being pushed to the result arrays.
 * - All visitors are called for every node — null returns are skipped cheaply.
 * - ts.forEachChild recurses the full AST tree depth-first.
 *
 * Unknown is a valid state: after traversal, any relationship `targetId` that does not point at an
 * emitted node is dropped rather than left dangling.
 *
 * @param targetPath  Path to a file or directory to analyze.
 * @returns A RepresentationGraph with all four primitive arrays populated.
 */
export function analyzeTarget(
  targetPath: string,
  extractorVersion: string = CORE_EXTRACTOR_VERSION,
  commitSha?: string,
  excludeWorkspaces: string[] = []
): RepresentationGraph {
  clearPathResolverCache();
  clearTargetResolverCache();
  const nodes: StructuralNode[] = [];
  const edges: StructuralEdge[] = [];
  
  const repoRoot = path.resolve(targetPath);
  const isTargetFile = fs.statSync(repoRoot).isFile();
  const actualRepoRoot = isTargetFile ? path.dirname(repoRoot) : repoRoot;

  // 1. Build Workspace Registry — then apply exclusions (by package name, short name, or relative path)
  const rawRegistry = buildWorkspaceRegistry(actualRepoRoot);
  const workspaceRegistry: WorkspaceRegistry = {};
  const excludedDirs: string[] = [];
  const excludedSet = new Set(
    excludeWorkspaces.map((w) => w.trim()).filter(Boolean),
  );

  for (const [pkgName, pkgPath] of Object.entries(rawRegistry)) {
    const relPkgPath = path.relative(actualRepoRoot, pkgPath).replace(/\\/g, '/');
    const shortName = pkgName.replace(/^@[^/]+\//, '');
    if (
      excludedSet.has(pkgName) ||
      excludedSet.has(relPkgPath) ||
      excludedSet.has(shortName)
    ) {
      excludedDirs.push(pkgPath);
    } else {
      workspaceRegistry[pkgName] = pkgPath;
    }
  }

  for (const rawExcl of excludedSet) {
    const candidate = path.resolve(actualRepoRoot, rawExcl);
    if (
      candidate !== actualRepoRoot &&
      fs.existsSync(candidate) &&
      !excludedDirs.includes(candidate)
    ) {
      excludedDirs.push(candidate);
    }
  }

  const allFiles = collectFiles(targetPath);
  let files =
    excludedDirs.length > 0
      ? allFiles.filter(
          (filePath) =>
            !excludedDirs.some(
              (dir) => filePath === dir || filePath.startsWith(dir + path.sep),
            ),
        )
      : allFiles;

  // 1b. Attach explicit chomp.config.json boundary overrides when configured ([PAT-EXT-30])
  const decomposedPlan = attachDecomposedBoundaries(workspaceRegistry, actualRepoRoot, files);
  if (decomposedPlan && excludedSet.size > 0) {
    files = files.filter((filePath) => {
      const resolved = resolveBoundaryForFile(filePath, actualRepoRoot, workspaceRegistry);
      const shortName = resolved.label.split('/').pop() ?? resolved.label;
      return (
        !excludedSet.has(resolved.label) &&
        !excludedSet.has(shortName) &&
        !excludedSet.has(resolved.evidencePath)
      );
    });
  }

  // 2. Deployment units are emitted lazily — one per workspace package / sub-boundary, or one for the root.
  const deploymentUnits = new Map<string, DeploymentUnitRef>();
  const ensureDeploymentUnit = (label: string, evidencePath: string): DeploymentUnitRef => {
    let du = deploymentUnits.get(label);
    if (!du) {
      du = { id: stableEntityId(`deployment-unit:${label}`, 'BOUNDARY', `Deployment Unit: ${label}`), label };
      deploymentUnits.set(label, du);
      nodes.push({
        id: du.id,
        name: `Deployment Unit: ${label}`,
        type: 'BOUNDARY',
        entityType: 'DEPLOYMENT_UNIT',
        patternId: 'boundary.deployment-unit',
        scope: 'USER',
        evidence: { filePath: evidencePath },
      });
    }
    return du;
  };

  /** Creates (once per deployment unit) the INIT_BLOCK that owns module-evaluation-time execution. */
  const ensureInitBlock = (du: DeploymentUnitRef, triggerEvidence: EvidenceRecord | EvidenceRecord[], scope: StructuralNode['scope']): string => {
    const first = Array.isArray(triggerEvidence) ? triggerEvidence[0] : triggerEvidence;
    if (!du.initId) {
      const init = createInitBlock(du.label, { filePath: first.filePath, lineNumber: first.lineNumber, snippet: first.snippet });
      init.id = stableEntityId(`init:${du.label}`, 'BOUNDARY', init.name);
      init.parentBoundaryId = du.id;
      init.scope = scope;
      nodes.push(init as StructuralNode);
      du.initId = init.id;
      du.initNode = init as StructuralNode;
    } else if (du.initNode && first?.filePath) {
      const existingEv = Array.isArray(du.initNode.evidence)
        ? du.initNode.evidence
        : du.initNode.evidence
          ? [du.initNode.evidence]
          : [];
      const normFirst = first.filePath.replace(/\\/g, '/');
      const newEvRecord = { filePath: first.filePath, lineNumber: first.lineNumber, snippet: first.snippet };
      if (scope === 'USER' && du.initNode.scope !== 'USER') {
        du.initNode.scope = 'USER';
        du.initNode.evidence = [
          newEvRecord,
          ...existingEv.filter((ev) => ev?.filePath?.replace(/\\/g, '/') !== normFirst),
        ];
      } else if (!existingEv.some((ev) => ev?.filePath?.replace(/\\/g, '/') === normFirst)) {
        du.initNode.evidence = [...existingEv, newEvRecord];
      }
    }
    return du.initId;
  };

  const rootLabel = path.basename(actualRepoRoot);
  const astNodesByContractId = new Map<string, Array<{ sourceFile: ts.SourceFile; node: ts.Node }>>();
  const recordContractAst = (contractId: string, sf: ts.SourceFile, astNode: ts.Node) => {
    let list = astNodesByContractId.get(contractId);
    if (!list) {
      list = [];
      astNodesByContractId.set(contractId, list);
    }
    if (!list.some((entry) => entry.node === astNode)) {
      list.push({ sourceFile: sf, node: astNode });
    }
  };

  // Framework-owned config that extends a convention (Next.js `pageExtensions`). One resolver per
  // analysis run, so its cache never outlives the files it read.
  const conventionConfig = createConventionConfigResolver(actualRepoRoot);
  const userConventions = loadUserConventionSets(actualRepoRoot);
  const analyzedFiles: string[] = [];
  const analyzedFilesByDuId = new Map<string, string[]>();
  const parsedUnits: ParsedSourceUnit[] = [];
  const logicalScopeByConnector = new WeakMap<StructuralNode, string>();
  const routedUnderscorePrefixes = collectRoutedUnderscorePrefixes(
    files.map((f) => path.relative(actualRepoRoot, f) || f)
  );

  // Pre-pass: detect `(logicalScope, canonicalName)` contract and boundary pairs that appear in >= 2 distinct
  // files within the same logical boundary scope so `contractEntityId` / `boundaryEntityId` disambiguate them by file path.
  const preParsedSourceFiles = new Map<string, ts.SourceFile>();
  const collidingContractKeys = new Set<string>();
  const collidingBoundaryKeys = new Set<string>();
  if (files.length > 1) {
    const filesByScopeAndContractName = new Map<string, Set<string>>();
    const filesByScopeAndBoundaryName = new Map<string, Set<string>>();
    const dummyEvidence = (): EvidenceRecord => ({ filePath: '' });
    const dummyId = () => '';
    for (const filePath of files) {
      const sf =
        getCachedSourceFile(filePath) ??
        ts.createSourceFile(
          filePath,
          fs.readFileSync(filePath, 'utf8'),
          ts.ScriptTarget.Latest,
          true
        );
      preParsedSourceFiles.set(filePath, sf);
      const relativePath = path.relative(actualRepoRoot, filePath) || filePath;
      const normRelPath = relativePath.replace(/\\/g, '/');
      const resolvedBoundary = resolveBoundaryForFile(
        filePath,
        actualRepoRoot,
        workspaceRegistry,
        rootLabel
      );
      const fileRole: NextjsFileRole | null = classifyNextjsFile(
        relativePath,
        conventionConfig.extensionsFor(NEXTJS_CONVENTIONS, filePath),
        { sourceFilePath: filePath, routedUnderscorePrefixes }
      );
      const preVisit = (node: ts.Node) => {
        const logicalScope = formatLogicalBoundaryScope(
          resolvedBoundary.label,
          findEnclosingNamespaceScope(node)
        );
        const boundaryResult = visitBoundary(node, sf, dummyEvidence, dummyId);
        const boundaryList = Array.isArray(boundaryResult)
          ? boundaryResult
          : boundaryResult
            ? [boundaryResult]
            : [];
        for (const b of boundaryList) {
          if (b.entityType === 'CLASS' || b.entityType === 'NAMESPACE') {
            const bKey = `${logicalScope}::${b.name}`;
            let bSet = filesByScopeAndBoundaryName.get(bKey);
            if (!bSet) {
              bSet = new Set<string>();
              filesByScopeAndBoundaryName.set(bKey, bSet);
            }
            bSet.add(normRelPath);
          }
        }
        const contractResult = visitContract(
          node,
          sf,
          dummyEvidence,
          dummyId,
          fileRole,
          relativePath
        );
        const baseList = Array.isArray(contractResult)
          ? contractResult
          : contractResult
            ? [contractResult]
            : [];
        const userList =
          userConventions.length > 0 && baseList.length === 0
            ? userConventions.flatMap((uSet) => {
                const uRole = classifyFileRole(
                  uSet,
                  relativePath,
                  conventionConfig.extensionsFor(uSet, filePath)
                );
                return applyConventionRules(
                  uSet,
                  uSet.rules.filter((r) => r.emit.type === 'CONTRACT').map((r) => r.id),
                  node,
                  uRole,
                  relativePath,
                  dummyEvidence,
                  dummyId
                );
              })
            : [];
        for (const c of [...baseList, ...userList]) {
          if (c.type === 'RELATIONSHIP' || c.id) continue;
          const key = `${logicalScope}::${c.name}`;
          let set = filesByScopeAndContractName.get(key);
          if (!set) {
            set = new Set<string>();
            filesByScopeAndContractName.set(key, set);
          }
          set.add(normRelPath);
        }
        ts.forEachChild(node, preVisit);
      };
      preVisit(sf);
    }
    for (const [key, fileSet] of filesByScopeAndContractName.entries()) {
      if (fileSet.size > 1) {
        collidingContractKeys.add(key);
      }
    }
    for (const [key, fileSet] of filesByScopeAndBoundaryName.entries()) {
      if (fileSet.size > 1) {
        collidingBoundaryKeys.add(key);
      }
    }
  }
  setActiveCollidingContractKeys(collidingContractKeys.size > 0 ? collidingContractKeys : null);
  setActiveCollidingBoundaryKeys(collidingBoundaryKeys.size > 0 ? collidingBoundaryKeys : null);
  try {
  for (const filePath of files) {
    const sourceFile =
      preParsedSourceFiles.get(filePath) ??
      getCachedSourceFile(filePath) ??
      ts.createSourceFile(
        filePath,
        fs.readFileSync(filePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );

    const relativePath = path.relative(actualRepoRoot, filePath) || filePath;
    const scope = detectScope(relativePath);

    // Resolve the deployment unit this file belongs to (workspace package, decomposed sub-boundary, else root).
    const resolvedBoundary = resolveBoundaryForFile(
      filePath,
      actualRepoRoot,
      workspaceRegistry,
      rootLabel
    );
    const hasSubPackages = Object.keys(workspaceRegistry).length > 0;
    const isUnmatchedRootFile =
      hasSubPackages && !resolvedBoundary.isWorkspaceMatch && !resolvedBoundary.isSubBoundary;

    const unit: DeploymentUnitRef = isUnmatchedRootFile
      ? (deploymentUnits.get(resolvedBoundary.label) ?? {
          id: stableEntityId(
            `deployment-unit:${resolvedBoundary.label}`,
            'BOUNDARY',
            `Deployment Unit: ${resolvedBoundary.label}`
          ),
          label: resolvedBoundary.label,
        })
      : ensureDeploymentUnit(resolvedBoundary.label, resolvedBoundary.evidencePath);
    const nodesCountBeforeFile = nodes.length;

    if (scope === 'USER' && !isPureBarrelOrEmptyFile(sourceFile)) {
      const normRelPath = relativePath.replace(/\\/g, '/');
      analyzedFiles.push(normRelPath);
      const duList = analyzedFilesByDuId.get(unit.id) ?? [];
      duList.push(normRelPath);
      analyzedFilesByDuId.set(unit.id, duList);
    }

    // Classify the file's Next.js App Router role (if any) once, before the AST walk. Extensions the
    // project enabled via `pageExtensions` in its next.config.* count (read statically, never guessed).
    const fileRole: NextjsFileRole | null = classifyNextjsFile(
      relativePath,
      conventionConfig.extensionsFor(NEXTJS_CONVENTIONS, filePath),
      { sourceFilePath: filePath, routedUnderscorePrefixes }
    );

    // Framework directive ('use client' / 'use server') → deployment-topology annotation.
    const runtime = extractDirectiveRuntime(sourceFile);

    // AST anchor → id of the entity extracted from it; used to find a relationship's owner.
    const ownerByNode = new Map<ts.Node, string>();
    const multiOwnersFromContract = new Map<ts.Node, Set<string>>();
    const directInitOwnerNodes = new Set<ts.Node>();
    const expressRouteOwnerNodes = new Set<ts.Node>();
    const directContractAstNodes = new Set<ts.Node>();
    const addMultiOwners = (anchor: ts.Node, ids: readonly string[]): void => {
      for (const owned of ownershipAnchors(anchor)) {
        directContractAstNodes.add(owned);
        if (!ownerByNode.has(owned) && ids.length > 0) {
          ownerByNode.set(owned, ids[0]);
        }
        let set = multiOwnersFromContract.get(owned);
        if (!set) {
          set = new Set<string>();
          multiOwnersFromContract.set(owned, set);
        }
        for (const id of ids) set.add(id);
      }
    };
    const pendingEdgeSources: Array<{
      edge: StructuralEdge;
      node: ts.Node;
      evidence: EvidenceRecord | EvidenceRecord[];
    }> = [];

    /**
     * Constructs a 1-indexed source evidence record for the given AST node.
     * Truncates snippets to 80 characters and normalizes whitespace.
     */
    function getEvidence(node: ts.Node): EvidenceRecord {
      const start = node.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      const fullText = node.getText(sourceFile);
      const snippet = fullText.slice(0, 80).replace(/\s+/g, ' ').trim();

      return {
        filePath: relativePath,
        lineNumber: line + 1,
        snippet,
      };
    }

    /** Resolves the id that owns a relationship originating at `node` (contract/class, else INIT_BLOCK). */
    let fileUsedInitBlock = false;
    function resolveSource(node: ts.Node, evidence: EvidenceRecord | EvidenceRecord[]): string {
      const owner = findScopeOwnerId(node, ownerByNode);
      if (owner) return owner;
      fileUsedInitBlock = true;
      return ensureInitBlock(unit, evidence, scope);
    }

    /** Records `id` as the owner of the code under `anchor` (and under the outer calls of its method chain). */
    function registerOwner(anchor: ts.Node, id: string): void {
      for (const owned of ownershipAnchors(anchor)) {
        directContractAstNodes.add(owned);
        if (!ownerByNode.has(owned)) ownerByNode.set(owned, id);
      }
    }

    const userEdgeResolvers =
      userConventions.some((u) => (u.edgeRules?.length ?? 0) > 0)
        ? createUserEdgeTargetResolvers(
            sourceFile,
            relativePath,
            actualRepoRoot,
            workspaceRegistry,
            userConventions,
            conventionConfig
          )
        : undefined;

    /**
     * Traverses a single AST node through all primitive visitors in order.
     * Replaces placeholder entity IDs with deterministic stableEntityId() before pushing to graph arrays.
     */
    function visit(node: ts.Node) {
      const logicalScope = formatLogicalBoundaryScope(unit.label, findEnclosingNamespaceScope(node));

      const boundaryResult = visitBoundary(node, sourceFile, getEvidence, () => '');
      const boundaryEntities = Array.isArray(boundaryResult) ? boundaryResult : (boundaryResult ? [boundaryResult] : []);
      for (const boundaryEntity of boundaryEntities) {
        boundaryEntity.id =
          boundaryEntity.entityType === 'CLASS' || boundaryEntity.entityType === 'NAMESPACE'
            ? boundaryEntityId(logicalScope, relativePath, boundaryEntity.name)
            : stableEntityId(logicalScope, boundaryEntity.type, boundaryEntity.name);
        boundaryEntity.parentBoundaryId = unit.id;
        boundaryEntity.scope = scope;
        nodes.push(boundaryEntity as StructuralNode);
      }
      if (boundaryEntities.length === 1) registerOwner(node, boundaryEntities[0].id);

      const contractResult = visitContract(node, sourceFile, getEvidence, () => '', fileRole, relativePath);
      const baseContractEntities = Array.isArray(contractResult) ? contractResult : (contractResult ? [contractResult] : []);
      const userContractEntities =
        userConventions.length > 0 && baseContractEntities.length === 0
          ? userConventions.flatMap((uSet) => {
              const uRole = classifyFileRole(
                uSet,
                relativePath,
                conventionConfig.extensionsFor(uSet, filePath)
              );
              return applyConventionRules(
                uSet,
                uSet.rules.filter((r) => r.emit.type === 'CONTRACT').map((r) => r.id),
                node,
                uRole,
                relativePath,
                getEvidence,
                () => ''
              );
            })
          : [];
      const contractEntities = [...baseContractEntities, ...userContractEntities];
      let lastContractId = null;
      for (const contractEntity of contractEntities) {
        contractEntity.scope = scope;
        if (runtime) contractEntity.metadata = { ...contractEntity.metadata, runtime };
        
        if (contractEntity.type === 'RELATIONSHIP') {
          const edge = contractEntity as StructuralEdge;
          if (!edge.sourceId || edge.sourceId === SCOPE_SOURCE_PLACEHOLDER) {
            pendingEdgeSources.push({ edge, node, evidence: edge.evidence });
          }
          if (!edge.targetId && lastContractId) {
            edge.targetId = lastContractId;
          }
          edges.push(edge);
        } else {
          // Entities may pre-assign a cross-file stable id (e.g. Express middleware) — honor it.
          if (!contractEntity.id) {
            contractEntity.id = contractEntityId(
              logicalScope,
              relativePath,
              contractEntity.name,
              contractEntity.patternId
            );
          }
          lastContractId = contractEntity.id;
          // PUBLIC_METHOD contracts (and Object.defineProperty(this, ...) inside a class) are parented to their class; everything else to the deployment unit.
          let enclosingClassOwnerId: string | undefined;
          if (contractEntity.patternId === 'contract.define-property') {
            let clsCur: ts.Node | undefined = node.parent;
            while (
              clsCur &&
              !ts.isClassDeclaration(clsCur) &&
              !ts.isClassExpression(clsCur)
            ) {
              clsCur = clsCur.parent;
            }
            if (clsCur) {
              enclosingClassOwnerId = ownerByNode.get(clsCur);
            }
          }
          contractEntity.parentBoundaryId =
            contractEntity.patternId === 'contract.public-method'
              ? ownerByNode.get(node.parent) ?? unit.id
              : enclosingClassOwnerId ?? unit.id;
          recordContractAst(contractEntity.id, sourceFile, node);
          nodes.push(contractEntity as StructuralNode);
        }
      }
      const contractNodes = contractEntities.filter(e => e.type !== 'RELATIONSHIP');
      if (contractNodes.length === 1) {
        const hasTrailingSiblingInlineCallbackInExpressUse =
          contractNodes[0].entityType === 'MIDDLEWARE' &&
          contractNodes[0].name !== 'Middleware: Inline Middleware' &&
          ts.isCallExpression(node) &&
          node.arguments.length >= 2 &&
          node.arguments.some(
            (arg, idx) =>
              idx > 0 && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
          );
        if (!hasTrailingSiblingInlineCallbackInExpressUse) {
          registerOwner(node, contractNodes[0].id);
        } else if (ts.isCallExpression(node)) {
          directContractAstNodes.add(node);
          const firstArg = node.arguments[0];
          const targetArg =
            (ts.isStringLiteral(firstArg) || ts.isRegularExpressionLiteral(firstArg)) &&
            node.arguments.length >= 2
              ? node.arguments[1]
              : firstArg;
          if (targetArg) {
            registerOwner(targetArg, contractNodes[0].id);
          }
        }
        if (
          (ts.isFunctionDeclaration(node) &&
            (node.name?.text === '__MdxComponent__' ||
              node.name?.text === '__VueSfcComponent__' ||
              node.name?.text === '__SvelteComponent__' ||
              node.name?.text === '__AstroComponent__')) ||
          contractNodes[0].patternId === 'contract.vue-sfc-script-setup' ||
          (contractNodes[0].patternId === 'contract.svelte-sfc-and-sveltekit-hooks' &&
            relativePath.toLowerCase().endsWith('.svelte'))
        ) {
          registerOwner(sourceFile, contractNodes[0].id);
          directInitOwnerNodes.add(sourceFile);
          for (const stmt of sourceFile.statements) {
            if (stmt === node) continue;
            if (
              ts.isImportDeclaration(stmt) ||
              ts.isExportDeclaration(stmt) ||
              ts.isInterfaceDeclaration(stmt) ||
              ts.isTypeAliasDeclaration(stmt)
            ) {
              continue;
            }
            if (ts.isVariableStatement(stmt) && !ownerByNode.has(stmt)) {
              registerOwner(stmt, contractNodes[0].id);
              directInitOwnerNodes.add(stmt);
              for (const decl of stmt.declarationList.declarations) {
                registerOwner(decl, contractNodes[0].id);
                directInitOwnerNodes.add(decl);
              }
            } else if (
              !ownerByNode.has(stmt) &&
              !(
                ts.canHaveModifiers(stmt) &&
                ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
              )
            ) {
              registerOwner(stmt, contractNodes[0].id);
              directInitOwnerNodes.add(stmt);
            }
          }
        }
        if (
          ts.isExportAssignment(node) &&
          !node.isExportEquals &&
          (contractNodes[0].patternId === 'contract.es6-export-default' ||
            contractNodes[0].patternId === 'contract.pinia-define-store' ||
            contractNodes[0].patternId === 'contract.nuxt-plugin-and-middleware-entry-points' ||
            contractNodes[0].patternId === 'contract.vue-sfc-script-setup')
        ) {
          if (ts.isCallExpression(node.expression)) {
            const calleeText = node.expression.expression.getText(sourceFile).trim();
            const isPayloadConfig = calleeText === 'buildConfig' || calleeText.endsWith('.buildConfig');
            const isReactHoc = (REACT_HOC_WRAPPERS as readonly string[]).includes(calleeText);
            if (!isPayloadConfig && !isReactHoc) {
              directInitOwnerNodes.add(node);
            }
            for (const arg of node.expression.arguments) {
              if (isFunctionLikeNode(arg)) {
                registerOwner(arg, contractNodes[0].id);
              }
            }
          } else if (ts.isIdentifier(node.expression)) {
            const exportedIdent = node.expression.text;
            const hasTopLevelListenOnExportedIdent = sourceFile.statements.some(
              (stmt) =>
                ts.isExpressionStatement(stmt) &&
                ts.isCallExpression(stmt.expression) &&
                ts.isPropertyAccessExpression(stmt.expression.expression) &&
                ts.isIdentifier(stmt.expression.expression.expression) &&
                stmt.expression.expression.expression.text === exportedIdent &&
                stmt.expression.expression.name.text === 'listen'
            );
            let matchedFactoryDecl: ts.VariableDeclaration | undefined;
            if (!hasTopLevelListenOnExportedIdent) {
              for (const stmt of sourceFile.statements) {
                if (!ts.isVariableStatement(stmt)) continue;
                for (const decl of stmt.declarationList.declarations) {
                  if (
                    ts.isIdentifier(decl.name) &&
                    decl.name.text === exportedIdent &&
                    decl.initializer &&
                    (ts.isCallExpression(decl.initializer) || ts.isNewExpression(decl.initializer)) &&
                    !ownerByNode.has(decl)
                  ) {
                    matchedFactoryDecl = decl;
                    break;
                  }
                }
                if (matchedFactoryDecl) break;
              }
            }
            if (matchedFactoryDecl) {
              registerOwner(matchedFactoryDecl, contractNodes[0].id);
              directInitOwnerNodes.add(matchedFactoryDecl);
              const stmtContainsIdent = (n: ts.Node): boolean => {
                if (ts.isIdentifier(n) && n.text === exportedIdent) return true;
                return Boolean(ts.forEachChild(n, stmtContainsIdent));
              };
              const stmtHasOwnedDescendant = (n: ts.Node): boolean => {
                if (ownerByNode.has(n)) return true;
                return Boolean(ts.forEachChild(n, stmtHasOwnedDescendant));
              };
              for (const stmt of sourceFile.statements) {
                if (
                  ts.isExpressionStatement(stmt) &&
                  !stmtHasOwnedDescendant(stmt) &&
                  stmtContainsIdent(stmt.expression)
                ) {
                  registerOwner(stmt, contractNodes[0].id);
                  directInitOwnerNodes.add(stmt);
                }
              }
            }
          }
        }
        if (ts.isPropertyAssignment(node)) {
          directInitOwnerNodes.add(node);
        }
        if (contractNodes[0].entityType === 'CLI_COMMAND') {
          const cliNames: string[] = [];
          if (ts.isFunctionDeclaration(node) && node.name) {
            cliNames.push(node.name.text);
          } else if (ts.isVariableStatement(node)) {
            for (const d of node.declarationList.declarations) {
              if (ts.isIdentifier(d.name)) cliNames.push(d.name.text);
            }
          }
          for (const cliName of cliNames) {
            for (const callStmt of findTopLevelCliInvocationStatements(sourceFile, cliName)) {
              registerOwner(callStmt, contractNodes[0].id);
              directInitOwnerNodes.add(callStmt);
            }
          }
        }
        if (
          contractNodes[0].patternId === HTTP_ROUTE_CONTRACT_PATTERN_ID ||
          contractNodes[0].entityType === 'CLI_COMMAND' ||
          contractNodes[0].entityType === 'EVENT_LISTENER'
        ) {
          for (const owned of ownershipAnchors(node)) {
            expressRouteOwnerNodes.add(owned);
            if (
              ts.isIfStatement(node) ||
              contractNodes[0].entityType === 'CLI_COMMAND' ||
              contractNodes[0].entityType === 'EVENT_LISTENER'
            ) {
              directInitOwnerNodes.add(owned);
            }
          }
        }
        if (ts.isVariableStatement(node)) {
          const hasFactoryCallInitializer = node.declarationList.declarations.some((d) => {
            if (!d.initializer) return false;
            if (
              unwrapCachedFunctionInitializer(d.initializer, sourceFile) !== null ||
              unwrapWrappedFunction(d.initializer, REACT_HOC_WRAPPERS, sourceFile) !== null
            ) {
              return false;
            }
            let init: ts.Expression = d.initializer;
            while (
              ts.isParenthesizedExpression(init) ||
              ts.isAsExpression(init) ||
              ts.isSatisfiesExpression(init) ||
              ts.isTypeAssertionExpression(init) ||
              ts.isNonNullExpression(init)
            ) {
              init = init.expression;
            }
            return ts.isCallExpression(init) || ts.isNewExpression(init);
          });
          const isDirectInitContract =
            contractNodes[0].patternId === ROUTE_HANDLER_CONTRACT_PATTERN_ID ||
            contractNodes[0].patternId === 'contract.exported-module' ||
            contractNodes[0].patternId === 'contract.pinia-define-store' ||
            contractNodes[0].patternId === 'contract.factory-call-exported-const' ||
            contractNodes[0].patternId === 'contract.exported-factory-instance-and-enum-call' ||
            contractNodes[0].patternId === 'contract.exported-object-literal-data-store' ||
            (contractNodes[0].patternId === 'contract.exported-function' && hasFactoryCallInitializer);
          if (isDirectInitContract) {
            directInitOwnerNodes.add(node);
          }
          for (const decl of node.declarationList.declarations) {
            registerOwner(decl, contractNodes[0].id);
            if (isDirectInitContract) {
              directInitOwnerNodes.add(decl);
            }
            if (decl.initializer) {
              const innerFn = isFunctionLikeNode(decl.initializer)
                ? decl.initializer
                : unwrapCachedFunctionInitializer(decl.initializer, sourceFile) ??
                  unwrapWrappedFunction(decl.initializer, REACT_HOC_WRAPPERS, sourceFile);
              if (innerFn) {
                registerOwner(innerFn, contractNodes[0].id);
              } else {
                let unwrappedCall: ts.Expression = decl.initializer;
                while (
                  ts.isParenthesizedExpression(unwrappedCall) ||
                  ts.isAsExpression(unwrappedCall) ||
                  ts.isSatisfiesExpression(unwrappedCall) ||
                  ts.isTypeAssertionExpression(unwrappedCall) ||
                  ts.isNonNullExpression(unwrappedCall)
                ) {
                  unwrappedCall = unwrappedCall.expression;
                }
                if (ts.isCallExpression(unwrappedCall)) {
                  for (const arg of unwrappedCall.arguments) {
                    if (isFunctionLikeNode(arg)) {
                      registerOwner(arg, contractNodes[0].id);
                    }
                  }
                }
              }
            }
          }
          if (
            hasFactoryCallInitializer &&
            contractNodes[0].entityType === 'EXPORTED_MODULE' &&
            node.declarationList.declarations.length === 1 &&
            ts.isIdentifier(node.declarationList.declarations[0].name)
          ) {
            const exportedIdent = node.declarationList.declarations[0].name.text;
            const hasTopLevelListenOnExportedIdent = sourceFile.statements.some(
              (stmt) =>
                ts.isExpressionStatement(stmt) &&
                ts.isCallExpression(stmt.expression) &&
                ts.isPropertyAccessExpression(stmt.expression.expression) &&
                ts.isIdentifier(stmt.expression.expression.expression) &&
                stmt.expression.expression.expression.text === exportedIdent &&
                stmt.expression.expression.name.text === 'listen'
            );
            if (!hasTopLevelListenOnExportedIdent) {
              const stmtContainsIdent = (n: ts.Node): boolean => {
                if (ts.isIdentifier(n) && n.text === exportedIdent) return true;
                return Boolean(ts.forEachChild(n, stmtContainsIdent));
              };
              const stmtHasOwnedDescendant = (n: ts.Node): boolean => {
                if (ownerByNode.has(n)) return true;
                return Boolean(ts.forEachChild(n, stmtHasOwnedDescendant));
              };
              for (const stmt of sourceFile.statements) {
                if (
                  ts.isExpressionStatement(stmt) &&
                  !stmtHasOwnedDescendant(stmt) &&
                  stmtContainsIdent(stmt.expression)
                ) {
                  registerOwner(stmt, contractNodes[0].id);
                  directInitOwnerNodes.add(stmt);
                }
              }
            }
          }
        }
      } else if (contractNodes.length > 1) {
        if (ts.isFunctionDeclaration(node)) {
          addMultiOwners(node, contractNodes.map((c) => c.id));
        } else if (ts.isVariableStatement(node)) {
          const allRouteHandlers = contractNodes.every(
            (c) => c.patternId === ROUTE_HANDLER_CONTRACT_PATTERN_ID
          );
          if (allRouteHandlers) {
            directInitOwnerNodes.add(node);
          }
          for (const decl of node.declarationList.declarations) {
            if (ts.isObjectBindingPattern(decl.name)) {
              if (allRouteHandlers) {
                directInitOwnerNodes.add(decl);
                addMultiOwners(decl, contractNodes.map((c) => c.id));
              }
              continue;
            }
            if (!ts.isIdentifier(decl.name)) continue;
            const declName = decl.name.text;
            const matched = contractNodes.find(
              (c) => c.name.endsWith(`: ${declName}`) || c.metadata?.componentName === declName
            );
            if (matched) {
              registerOwner(decl, matched.id);
              if (decl.initializer) {
                const innerFn = isFunctionLikeNode(decl.initializer)
                  ? decl.initializer
                  : unwrapCachedFunctionInitializer(decl.initializer, sourceFile) ??
                    unwrapWrappedFunction(decl.initializer, REACT_HOC_WRAPPERS, sourceFile);
                if (innerFn) {
                  registerOwner(innerFn, matched.id);
                }
              }
            } else if (node.declarationList.declarations.length === 1) {
              const allIds = contractNodes.map((c) => c.id);
              addMultiOwners(decl, allIds);
              if (decl.initializer) {
                const innerFn = isFunctionLikeNode(decl.initializer)
                  ? decl.initializer
                  : unwrapCachedFunctionInitializer(decl.initializer, sourceFile) ??
                    unwrapWrappedFunction(decl.initializer, REACT_HOC_WRAPPERS, sourceFile);
                if (innerFn) {
                  addMultiOwners(innerFn, allIds);
                }
              }
            }
          }
        }
      }

      const openConnectorResult = visitOpenConnector(node, sourceFile, getEvidence, () => '', actualRepoRoot, workspaceRegistry);
      const baseOpenConnectorEntities = Array.isArray(openConnectorResult) ? openConnectorResult : (openConnectorResult ? [openConnectorResult] : []);
      const userOpenConnectorEntities =
        userConventions.length > 0 && baseOpenConnectorEntities.length === 0
          ? userConventions.flatMap((uSet) => {
              const ocRuleIds = uSet.rules
                .filter((r) => r.emit.type === 'OPEN_CONNECTOR')
                .map((r) => r.id);
              if (ocRuleIds.length === 0) return [];
              const uRole = classifyFileRole(
                uSet,
                relativePath,
                conventionConfig.extensionsFor(uSet, filePath)
              );
              return applyConventionRules(
                uSet,
                ocRuleIds,
                node,
                uRole,
                relativePath,
                getEvidence,
                () => ''
              );
            })
          : [];
      const openConnectorEntities = [...baseOpenConnectorEntities, ...userOpenConnectorEntities];
      const matchedUserOpenConnector = userOpenConnectorEntities.some(
        (e) => e.type === 'OPEN_CONNECTOR'
      );

      const relationshipResult = visitRelationship(node, sourceFile, getEvidence, () => '', actualRepoRoot, SCOPE_SOURCE_PLACEHOLDER, workspaceRegistry);
      const baseRelationshipEntities = (Array.isArray(relationshipResult) ? relationshipResult : (relationshipResult ? [relationshipResult] : [])).filter(
        (re) => !(matchedUserOpenConnector && !re.targetId && re.entityType === 'CALL')
      );
      const userEdgeSourceId =
        contractNodes.length === 1 ? contractNodes[0].id : SCOPE_SOURCE_PLACEHOLDER;
      const userRelationshipEntities =
        userEdgeResolvers
          ? userConventions.flatMap((uSet) => {
              const edgeRuleIds = (uSet.edgeRules ?? []).map((er) => er.id);
              if (edgeRuleIds.length === 0) return [];
              return applyEdgeRules(
                uSet,
                edgeRuleIds,
                node,
                userEdgeSourceId,
                getEvidence,
                () => '',
                userEdgeResolvers
              );
            })
          : [];
      const resolvedUserEdgeOnNode = userRelationshipEntities.some((re) => Boolean(re.targetId));
      const relationshipEntities = [
        ...baseRelationshipEntities.filter(
          (re) => !(resolvedUserEdgeOnNode && !re.targetId && re.entityType === 'CALL')
        ),
        ...userRelationshipEntities,
      ];
      for (const relationshipEntity of relationshipEntities) {
        relationshipEntity.scope = scope;
        const edge = relationshipEntity as StructuralEdge;
        // Adapter edges that already name a concrete source keep it; everything else is resolved by AST ownership.
        if (!edge.sourceId || edge.sourceId === SCOPE_SOURCE_PLACEHOLDER) {
          pendingEdgeSources.push({ edge, node, evidence: edge.evidence });
        }
        edges.push(edge);
      }

      let siblingConnectorId: string | undefined;
      for (const openConnectorEntity of openConnectorEntities) {
        // Adapters (Drizzle / Payload) return the READS / MUTATES relationship alongside its connector.
        // A relationship is an edge, never a node — its source is the sibling connector emitted just before it.
        if (openConnectorEntity.type === 'RELATIONSHIP') {
          openConnectorEntity.scope = scope;
          const edge = openConnectorEntity as StructuralEdge;
          if (!edge.sourceId) {
            if (siblingConnectorId) {
              edge.sourceId = siblingConnectorId;
            } else {
              pendingEdgeSources.push({ edge, node, evidence: edge.evidence });
            }
          }
          edges.push(edge);
          continue;
        }

        const isPackage = openConnectorEntity.entityType === 'EXTERNAL_PACKAGE' || openConnectorEntity.entityType === 'NODE_BUILTIN';
        // [PAT-VIS-16]: Scope OPEN_CONNECTOR identity by logicalScope (DEPLOYMENT_UNIT) rather than per-file relativePath
        openConnectorEntity.id = isPackage
          ? packageConnectorId(openConnectorEntity.name.replace('Package: ', ''))
          : stableEntityId(logicalScope, openConnectorEntity.type, openConnectorEntity.name);
        openConnectorEntity.scope = scope;
        const ocNode = openConnectorEntity as StructuralNode;
        logicalScopeByConnector.set(ocNode, logicalScope);
        nodes.push(ocNode);
        siblingConnectorId = openConnectorEntity.id;

        // An import/require of a package is a connector, not a call — the calls into it are
        // emitted by the relationship visitor. Other connectors are invoked at their AST position.
        if (!isPackage) {
          const connMeta = openConnectorEntity.metadata as Record<string, any> | undefined;
          const edge: StructuralEdge = {
            id: '',
            name: `Call: ${openConnectorEntity.name}`,
            type: 'RELATIONSHIP',
            entityType: 'CALL', patternId: 'generic.relationship',
            sourceId: SCOPE_SOURCE_PLACEHOLDER,
            targetId: openConnectorEntity.id,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: openConnectorEntity.evidence,
            scope: scope,
            ...(connMeta?.urlPath
              ? {
                  metadata: {
                    httpMethod: connMeta.httpMethod ?? 'GET',
                    urlPath: connMeta.urlPath,
                    ...(typeof connMeta.payload === 'string' ? { payload: connMeta.payload } : {}),
                  },
                }
              : typeof connMeta?.payload === 'string'
                ? {
                    metadata: {
                      payload: connMeta.payload,
                    },
                  }
                : {}),
          };
          pendingEdgeSources.push({ edge, node, evidence: openConnectorEntity.evidence });
          edges.push(edge);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    const multiOwnersByHelperNode = propagateLocalHelperOwners(sourceFile, ownerByNode);
    for (const [astNode, ownerSet] of multiOwnersFromContract.entries()) {
      let existing = multiOwnersByHelperNode.get(astNode);
      if (!existing) {
        existing = new Set<string>();
        multiOwnersByHelperNode.set(astNode, existing);
      }
      for (const id of ownerSet) existing.add(id);
    }
    for (const [ownedAstNode, ownerId] of ownerByNode.entries()) {
      if (astNodesByContractId.has(ownerId)) {
        recordContractAst(ownerId, sourceFile, ownedAstNode);
      }
    }
    for (const [helperNode, owners] of multiOwnersByHelperNode.entries()) {
      for (const ownerId of owners) {
        if (astNodesByContractId.has(ownerId)) {
          recordContractAst(ownerId, sourceFile, helperNode);
        }
      }
    }
    const getHelperNameForAstNode = (astNode: ts.Node): string | undefined => {
      if (ts.isConstructorDeclaration(astNode)) return 'constructor';
      if (ts.isFunctionDeclaration(astNode) && astNode.name) return astNode.name.text;
      if (
        (ts.isMethodDeclaration(astNode) ||
          ts.isGetAccessorDeclaration(astNode) ||
          ts.isPropertyDeclaration(astNode)) &&
        astNode.name &&
        (ts.isIdentifier(astNode.name) || ts.isPrivateIdentifier(astNode.name))
      ) {
        return astNode.name.text;
      }
      if (
        astNode.parent &&
        ts.isVariableDeclaration(astNode.parent) &&
        ts.isIdentifier(astNode.parent.name)
      ) {
        return astNode.parent.name.text;
      }
      return undefined;
    };
    const hasEnclosingFunctionScope = (astNode: ts.Node): boolean => {
      for (let cur = astNode.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
        if (isFunctionLikeNode(cur)) return true;
      }
      return false;
    };
    const resolveAllSourceOwners = (
      node: ts.Node,
      evidence: EvidenceRecord | EvidenceRecord[],
      edgePatternId?: string
    ): { ownerIds: string[]; viaHelper?: string } => {
      if (
        (edgePatternId === HTTP_ROUTE_HANDLER_EDGE_PATTERN_ID ||
          edgePatternId === 'relationship.callback-reference' ||
          (edgePatternId === HTTP_ROUTE_MIDDLEWARE_EDGE_PATTERN_ID &&
            hasEnclosingFunctionScope(node))) &&
        expressRouteOwnerNodes.has(node)
      ) {
        const routeOwner = ownerByNode.get(node);
        if (routeOwner) return { ownerIds: [routeOwner] };
      }
      if (
        node.parent &&
        ts.isCallExpression(node.parent) &&
        expressRouteOwnerNodes.has(node.parent) &&
        node.parent.arguments.length >= 2 &&
        node.parent.arguments[node.parent.arguments.length - 1] === node
      ) {
        const routeOwner = ownerByNode.get(node.parent);
        if (routeOwner) return { ownerIds: [routeOwner] };
      }
      if (!isFunctionLikeNode(node)) {
        for (let argCur: ts.Node | undefined = node; argCur && !ts.isSourceFile(argCur); argCur = argCur.parent) {
          if (argCur !== node && isFunctionLikeNode(argCur)) break;
          if (
            argCur.parent &&
            ts.isCallExpression(argCur.parent) &&
            expressRouteOwnerNodes.has(argCur.parent) &&
            argCur.parent.arguments.length >= 2 &&
            hasEnclosingFunctionScope(argCur.parent) &&
            argCur.parent.arguments.indexOf(argCur as ts.Expression) >= 1
          ) {
            const routeOwner = ownerByNode.get(argCur.parent);
            if (routeOwner) return { ownerIds: [routeOwner] };
          }
        }
      }
      let crossedFunction = false;
      let intermediateMemberName: string | undefined;
      for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
        if (ts.isDecorator(current) && !crossedFunction) {
          break;
        }
        if (isFunctionLikeNode(current)) crossedFunction = true;
        if (
          !intermediateMemberName &&
          !directContractAstNodes.has(current) &&
          (ts.isConstructorDeclaration(current) ||
            ts.isMethodDeclaration(current) ||
            (ts.isPropertyDeclaration(current) &&
              current.initializer &&
              isFunctionLikeNode(current.initializer)))
        ) {
          intermediateMemberName = getHelperNameForAstNode(current);
        }
        const multiOwners = multiOwnersByHelperNode.get(current);
        if (
          multiOwners &&
          multiOwners.size > 1 &&
          (crossedFunction ||
            directInitOwnerNodes.has(current) ||
            edgePatternId === 'relationship.dispatch-table-reference')
        ) {
          const viaHelper = !directContractAstNodes.has(current)
            ? getHelperNameForAstNode(current) ?? intermediateMemberName
            : undefined;
          return { ownerIds: Array.from(multiOwners), viaHelper };
        }
        const owner = ownerByNode.get(current);
        if (
          owner &&
          (crossedFunction ||
            ts.isClassDeclaration(current) ||
            directInitOwnerNodes.has(current) ||
            edgePatternId === 'relationship.dispatch-table-reference')
        ) {
          const viaHelper = ts.isClassDeclaration(current)
            ? intermediateMemberName
            : !directContractAstNodes.has(current)
              ? getHelperNameForAstNode(current) ?? intermediateMemberName
              : undefined;
          return { ownerIds: [owner], viaHelper };
        }
      }
      // [PAT-EXT-10]: In modules that already declare explicit contracts (`directContractAstNodes.size > 0`),
      // calls inside an unexported, unowned top-level helper function that is never referenced at module
      // top-level scope must NOT fall back to `INIT_BLOCK`.
      if (crossedFunction && directContractAstNodes.size > 0) {
        let topLevelFnDecl: ts.Node | undefined;
        let topLevelFnName: string | undefined;
        for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
          if (ts.isFunctionDeclaration(cur) && cur.parent === sourceFile && cur.name) {
            topLevelFnDecl = cur;
            topLevelFnName = cur.name.text;
          } else if (
            ts.isVariableDeclaration(cur) &&
            ts.isIdentifier(cur.name) &&
            cur.initializer &&
            isFunctionLikeNode(cur.initializer) &&
            cur.parent?.parent &&
            ts.isVariableStatement(cur.parent.parent) &&
            cur.parent.parent.parent === sourceFile
          ) {
            topLevelFnDecl = cur;
            topLevelFnName = cur.name.text;
          }
        }
        if (
          topLevelFnDecl &&
          topLevelFnName &&
          !ownerByNode.has(topLevelFnDecl) &&
          !multiOwnersByHelperNode.has(topLevelFnDecl)
        ) {
          const isReferencedAtModuleScope = (root: ts.Node): boolean => {
            if (root === topLevelFnDecl || (topLevelFnDecl.parent?.parent === root)) return false;
            if (isFunctionLikeNode(root) || ts.isClassDeclaration(root)) return false;
            if (ts.isIdentifier(root) && root.text === topLevelFnName) return true;
            return Boolean(ts.forEachChild(root, isReferencedAtModuleScope));
          };
          const referencedTopLevel = sourceFile.statements.some((stmt) =>
            isReferencedAtModuleScope(stmt)
          );
          if (!referencedTopLevel) {
            return { ownerIds: [] };
          }
        }
      }
      fileUsedInitBlock = true;
      return { ownerIds: [ensureInitBlock(unit, evidence, scope)] };
    };
    const droppedUnownedEdges = new Set<StructuralEdge>();
    for (const pending of pendingEdgeSources) {
      const { ownerIds, viaHelper } = resolveAllSourceOwners(
        pending.node,
        pending.evidence,
        pending.edge.patternId
      );
      if (ownerIds.length === 0) {
        droppedUnownedEdges.add(pending.edge);
        continue;
      }
      pending.edge.sourceId = ownerIds[0];
      if (
        pending.edge.targetId === ownerIds[0] &&
        pending.edge.patternId === 'relationship.invoke-returned-function'
      ) {
        pending.edge.targetId = undefined;
      }
      if (viaHelper) {
        pending.edge.metadata = {
          ...pending.edge.metadata,
          viaHelper,
        };
      }
      if (pending.edge.targetId) {
        for (let i = 1; i < ownerIds.length; i++) {
          edges.push({
            ...pending.edge,
            id: '',
            sourceId: ownerIds[i],
            ...(pending.edge.metadata ? { metadata: { ...pending.edge.metadata } } : {}),
          });
        }
      }
    }
    if (droppedUnownedEdges.size > 0) {
      for (let idx = edges.length - 1; idx >= 0; idx--) {
        if (droppedUnownedEdges.has(edges[idx])) {
          edges.splice(idx, 1);
        }
      }
    }

    if (isUnmatchedRootFile && !deploymentUnits.has(unit.label)) {
      const emittedChildForUnit =
        Boolean(unit.initId) ||
        nodes
          .slice(nodesCountBeforeFile)
          .some((n) => n.parentBoundaryId === unit.id);
      if (emittedChildForUnit) {
        deploymentUnits.set(unit.label, unit);
        nodes.push({
          id: unit.id,
          name: `Deployment Unit: ${unit.label}`,
          type: 'BOUNDARY',
          entityType: 'DEPLOYMENT_UNIT',
          patternId: 'boundary.deployment-unit',
          scope: 'USER',
          evidence: { filePath: resolvedBoundary.evidencePath },
        });
      }
    }

    parsedUnits.push({
      sourceFile,
      filePath,
      relativePath,
      scope,
      ownerByNode,
      multiOwnersByHelperNode,
      hasFileInitBlock: fileUsedInitBlock,
      unitId: unit.id,
      getInitId: () => unit.initId,
    });
  }

  for (const n of nodes) {
    if (n.type === 'CONTRACT') {
      const astEntries = astNodesByContractId.get(n.id);
      if (astEntries && astEntries.length > 0) {
        n.metadata = {
          ...n.metadata,
          bodyHash: computeAstBodyHash(astEntries),
        };
      }
    } else if (n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT') {
      const duFiles = analyzedFilesByDuId.get(n.id);
      if (duFiles && duFiles.length > 0) {
        n.metadata = {
          ...n.metadata,
          analyzedFiles: [...duFiles].sort(),
        };
      }
    }
  }

  // Canonicalize bare Node built-in package connectors (`Package: os`) into `Package: node:os` when both exist in the repo
  const nodePrefixedPackages = new Set<string>();
  for (const n of nodes) {
    if (n.type === 'OPEN_CONNECTOR' && n.name.startsWith('Package: node:')) {
      nodePrefixedPackages.add(n.name.slice('Package: node:'.length));
    }
  }
  if (nodePrefixedPackages.size > 0) {
    const idRemap = new Map<string, string>();
    for (const n of nodes) {
      if (n.type === 'OPEN_CONNECTOR' && n.name.startsWith('Package: ') && !n.name.startsWith('Package: node:')) {
        const bareName = n.name.slice('Package: '.length);
        if (nodePrefixedPackages.has(bareName)) {
          const canonicalName = `node:${bareName}`;
          const canonicalId = packageConnectorId(canonicalName);
          idRemap.set(n.id, canonicalId);
          n.id = canonicalId;
          n.name = `Package: ${canonicalName}`;
          n.entityType = 'NODE_BUILTIN';
        }
      }
    }
    if (idRemap.size > 0) {
      for (const e of edges) {
        if (e.targetId && idRemap.has(e.targetId)) {
          e.targetId = idRemap.get(e.targetId);
        }
      }
    }
  }

  disambiguateCollidingOpenConnectors(nodes, edges, logicalScopeByConnector);

  // [PAT-VIS-16]: Deduplicate OPEN_CONNECTOR, BOUNDARY, and colliding CONTRACT nodes with identical IDs (merging their evidence records)
  const dedupedNodes: StructuralNode[] = [];
  const openConnectorById = new Map<string, StructuralNode>();
  const contractById = new Map<string, StructuralNode>();
  const boundaryById = new Map<string, StructuralNode>();
  const formatEvLoc = (ev: EvidenceRecord | undefined): string | null => {
    if (!ev?.filePath) return null;
    const fp = ev.filePath.replace(/\\/g, '/');
    return ev.lineNumber ? `${fp}:${ev.lineNumber}` : fp;
  };
  for (const n of nodes) {
    if (n.type === 'OPEN_CONNECTOR') {
      const existing = openConnectorById.get(n.id);
      if (existing) {
        const existingEv = Array.isArray(existing.evidence) ? existing.evidence : [existing.evidence];
        const nextEv = Array.isArray(n.evidence) ? n.evidence : [n.evidence];
        existing.evidence = [...existingEv, ...nextEv];
        if (n.entityType === 'HTTP_FETCH') {
          const exMeta = (existing.metadata ?? {}) as Record<string, any>;
          const nxMeta = (n.metadata ?? {}) as Record<string, any>;
          const endpoints: Array<{ httpMethod: string; urlPath?: string; payload?: string }> =
            Array.isArray(exMeta.endpoints)
              ? [...exMeta.endpoints]
              : [
                  {
                    httpMethod: exMeta.httpMethod ?? 'GET',
                    ...(exMeta.urlPath ? { urlPath: exMeta.urlPath } : {}),
                    ...(exMeta.payload ? { payload: exMeta.payload } : {}),
                  },
                ];
          const nxEntry = {
            httpMethod: nxMeta.httpMethod ?? 'GET',
            ...(nxMeta.urlPath ? { urlPath: nxMeta.urlPath } : {}),
            ...(nxMeta.payload ? { payload: nxMeta.payload } : {}),
          };
          if (
            !endpoints.some(
              (ep) => ep.httpMethod === nxEntry.httpMethod && ep.urlPath === nxEntry.urlPath
            )
          ) {
            endpoints.push(nxEntry);
          }
          existing.metadata = {
            ...exMeta,
            endpoints,
          };
        } else {
          const exMeta = (existing.metadata ?? {}) as Record<string, any>;
          const nxMeta = (n.metadata ?? {}) as Record<string, any>;
          if (typeof exMeta.payload === 'string' || typeof nxMeta.payload === 'string') {
            const payloads: string[] = Array.isArray(exMeta.payloads)
              ? [...exMeta.payloads]
              : typeof exMeta.payload === 'string' && exMeta.payload.length > 0
                ? [exMeta.payload]
                : [];
            if (
              typeof nxMeta.payload === 'string' &&
              nxMeta.payload.length > 0 &&
              !payloads.includes(nxMeta.payload)
            ) {
              payloads.push(nxMeta.payload);
            }
            if (payloads.length > 0) {
              existing.metadata = {
                ...exMeta,
                payload: payloads.length === 1 ? payloads[0] : payloads.join(' | '),
                ...(payloads.length > 1 ? { payloads } : {}),
              };
            }
          }
        }
        continue;
      }
      openConnectorById.set(n.id, n);
    } else if (n.type === 'CONTRACT') {
      const existing = contractById.get(n.id);
      if (existing) {
        const existingEv = Array.isArray(existing.evidence) ? existing.evidence : [existing.evidence];
        const nextEv = Array.isArray(n.evidence) ? n.evidence : [n.evidence];
        existing.evidence = [...existingEv, ...nextEv];
        const prevPrimary = existingEv[0];
        const nextPrimary = nextEv[0];
        const prevFile = prevPrimary?.filePath?.replace(/\\/g, '/');
        const nextFile = nextPrimary?.filePath?.replace(/\\/g, '/');
        if (prevFile && nextFile && prevFile !== nextFile) {
          const prevLoc = formatEvLoc(prevPrimary) ?? prevFile;
          const nextLoc = formatEvLoc(nextPrimary) ?? nextFile;
          const prevCollisions = Array.isArray(existing.metadata?.collisionLocations)
            ? (existing.metadata.collisionLocations as string[])
            : [prevLoc];
          if (!prevCollisions.includes(nextLoc)) {
            prevCollisions.push(nextLoc);
          }
          existing.metadata = {
            ...existing.metadata,
            collisionLocations: prevCollisions,
          };
        }
        continue;
      } else {
        contractById.set(n.id, n);
      }
    } else if (n.type === 'BOUNDARY') {
      const existing = boundaryById.get(n.id);
      if (existing) {
        const existingEv = Array.isArray(existing.evidence) ? existing.evidence : [existing.evidence];
        const nextEv = Array.isArray(n.evidence) ? n.evidence : [n.evidence];
        existing.evidence = [...existingEv, ...nextEv];
        continue;
      } else {
        boundaryById.set(n.id, n);
      }
    }
    dedupedNodes.push(n);
  }
  nodes.length = 0;
  nodes.push(...dedupedNodes);

  // [PAT-EXT-23] & [PAT-EXT-26]: Intra-Repo HTTP Protocol Stitching & Partial-Stitch Evidence Pruning
  stitchIntraRepoHttpCalls(nodes, edges, openConnectorById);

  // [PAT-EXT-76]: Synthesize `Svg Component: <Name>` contracts strictly for in-repo `.svg` files
  // actually targeted by a `RENDERS` edge so non-component SVG URLs (`<img src={logo} />`) never emit orphans.
  collectReferencedSvgComponentNodes(edges, nodes, actualRepoRoot, workspaceRegistry, rootLabel);

  // Unknown is a valid state: never leave a relationship pointing at a node that was not extracted.
  // [PAT-EXT-11] Source-Scoped Edge Identity: compute deterministic RELATIONSHIP edge IDs from the
  // resolved sourceId (and targetId when known) so multiple contracts in the same file calling the
  // same function do not collide on edge.id when persisted to SQLite.
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const seenEdgeKeys = new Set<string>();
  for (const edge of edges) {
    if (edge.targetId) {
      const targetNode = nodeById.get(edge.targetId);
      if (!targetNode) {
        edge.metadata = {
          ...edge.metadata,
          unresolvedReason: 'unextracted-target-contract',
          expectedTargetId: edge.targetId,
        };
        delete edge.targetId;
      } else if ((edge.scope ?? 'USER') === 'USER' && (targetNode.scope ?? 'USER') !== 'USER') {
        edge.scope = targetNode.scope;
        edge.metadata = {
          ...edge.metadata,
          crossScopeFiltered: targetNode.scope,
        };
        delete edge.targetId;
      }
    }
    const baseScope = edge.targetId ? `${edge.sourceId}->${edge.targetId}` : edge.sourceId;
    const baseKey = `${baseScope}::${edge.type}::${edge.name}`;
    const edgeMeta = edge.metadata as Record<string, any> | undefined;
    const urlScopeSuffix =
      seenEdgeKeys.has(baseKey) && edgeMeta?.urlPath && typeof edgeMeta.urlPath === 'string'
        ? `::${edgeMeta.httpMethod ?? 'GET'}:${edgeMeta.urlPath}`
        : seenEdgeKeys.has(baseKey) && edgeMeta?.httpMethod && typeof edgeMeta.httpMethod === 'string'
          ? `::${edgeMeta.httpMethod}:${seenEdgeKeys.size}`
          : '';
    seenEdgeKeys.add(baseKey);
    const edgeScope = baseScope + urlScopeSuffix;
    edge.id = stableEntityId(edgeScope, edge.type, edge.name);
  }

  reconcileUnresolvedConnections(parsedUnits, nodes, edges, actualRepoRoot, workspaceRegistry);

  return {
    extractorVersion,
    analyzedAt: new Date().toISOString(),
    commitSha,
    nodes,
    edges,
    analyzedFiles: [...analyzedFiles].sort(),
  };
  } finally {
    setActiveCollidingContractKeys(null);
    setActiveCollidingBoundaryKeys(null);
  }
}
