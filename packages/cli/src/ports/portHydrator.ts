/**
 * @fileoverview Speed 2 Incremental Port Valve Hydrator (`[PAT-VIS-14]`, `[PAT-DB-03]`, `[PAT-DB-05]`).
 *
 * Uses TypeScript's `ts.createIncrementalProgram` (persisting `.tsbuildinfo` inside `.chomp/cache/`)
 * to resolve inferred return types, cross-file interface/type fields, and boundary port diagnostics
 * (`TS_CALL_MISMATCH`, `TS_RETURN_MISMATCH`) into `entity_overlays` (`layer: "L1_PORTS"`,
 * `source: "chomp-ports"`, `derivation: "EXTRACTED"`).
 *
 * Unchanged contracts (`stale === false` on both `bodyHash` and referenced `inputs` file hashes)
 * are skipped in `<2ms` without constructing a TypeScript `Program`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import type {
  ContractPortValves,
  PortDeclarationRef,
  PortDiagnostic,
  PortFieldSchema,
  PortOutputValve,
  PortParameterValve,
  RepresentationGraph,
  StructuralEdge,
  StructuralNode,
} from '@chomp/core';
import type {
  ChompStorage,
  EntityOverlayInput,
  OverlayInputDependency,
} from '@chomp/db';

export const CHOMP_PORTS_LAYER = 'L1_PORTS';
export const CHOMP_PORTS_SOURCE = 'chomp-ports';

const MAX_CHECKER_FIELDS = 24;
const MAX_CHECKER_DEPTH = 2;
const MAX_TYPE_STR_LEN = 120;

const CALL_MISMATCH_TS_CODES = new Set([
  2345, // Argument of type 'X' is not assignable to parameter of type 'Y'
  2554, // Expected N arguments, but got M
  2555, // Expected at least N arguments, but got M
  2769, // No overload matches this call
  2353, // Object literal may only specify known properties
  2739, // Type 'X' is missing the following properties from type 'Y'
  2741, // Property 'X' is missing in type 'Y' but required in type 'Z'
]);

const RETURN_MISMATCH_TS_CODES = new Set([
  2322, // Type 'X' is not assignable to type 'Y'
  2355, // A function whose declared type is neither 'undefined', 'void', nor 'any' must return a value
]);

const BUILTIN_OBJECT_TYPE_NAMES = new Set([
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Function',
  'Array',
  'ReadonlyArray',
  'Promise',
  'Date',
  'RegExp',
  'Error',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Uint8Array',
  'Buffer',
]);

export interface HydratePortValvesOptions {
  repoPath: string;
  repoId: string;
  storage: ChompStorage;
  graph: RepresentationGraph;
  /** Re-verify all contracts even when existing `L1_PORTS` cache rows are non-stale. */
  force?: boolean;
  /** Optional custom `.tsbuildinfo` directory, or `false` to disable writing `.tsbuildinfo` (e.g. in unit tests). */
  cacheDir?: string | false;
}

export interface HydratePortValvesResult {
  hydratedCount: number;
  cachedCount: number;
  prunedCount: number;
  diagnosticCount: number;
  durationMs: number;
}

function normalizeSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

function primaryEvidenceOf(
  node: StructuralNode
): { filePath: string; lineNumber?: number } | null {
  const ev = Array.isArray(node.evidence) ? node.evidence[0] : node.evidence;
  if (!ev || typeof ev.filePath !== 'string' || !ev.filePath.trim()) return null;
  return {
    filePath: normalizeSlash(ev.filePath.trim()),
    ...(typeof ev.lineNumber === 'number' ? { lineNumber: ev.lineNumber } : {}),
  };
}

function isSupportedSourcePath(filePath: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(filePath);
}

function findNearestTsconfig(
  absFilePath: string,
  repoRoot: string,
  cache: Map<string, string | null>
): string | null {
  const startDir = dirname(absFilePath);
  if (cache.has(startDir)) return cache.get(startDir)!;

  const visited: string[] = [];
  let cur = startDir;
  const normalizedRoot = resolve(repoRoot);
  let found: string | null = null;

  while (true) {
    if (cache.has(cur)) {
      found = cache.get(cur)!;
      break;
    }
    visited.push(cur);
    const candidate = resolve(cur, 'tsconfig.json');
    if (existsSync(candidate)) {
      found = candidate;
      break;
    }
    if (cur === normalizedRoot) break;
    const parent = dirname(cur);
    if (parent === cur || !parent.startsWith(normalizedRoot)) break;
    cur = parent;
  }

  for (const dir of visited) {
    cache.set(dir, found);
  }
  return found;
}

function hashFileShort(
  absPath: string,
  cache: Map<string, string | null>
): string | null {
  if (cache.has(absPath)) return cache.get(absPath)!;
  try {
    const content = readFileSync(absPath);
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
    cache.set(absPath, digest);
    return digest;
  } catch {
    cache.set(absPath, null);
    return null;
  }
}

function formatTypeConcise(
  checker: ts.TypeChecker,
  type: ts.Type,
  enclosingNode: ts.Node,
  isOptional = false
): string {
  let raw = checker
    .typeToString(
      type,
      enclosingNode,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (isOptional && raw !== 'undefined') {
    const stripped = raw
      .replace(/\s*\|\s*undefined\b/g, '')
      .replace(/\bundefined\s*\|\s*/g, '')
      .trim();
    if (stripped) raw = stripped;
  }
  if (raw.length <= MAX_TYPE_STR_LEN) return raw;
  return `${raw.slice(0, MAX_TYPE_STR_LEN - 1)}…`;
}

function stripOptionalUndefined(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  if (!type.isUnion()) return type;
  const kept = type.types.filter(
    (t) => (t.flags & ts.TypeFlags.Undefined) === 0 && (t.flags & ts.TypeFlags.Void) === 0
  );
  if (kept.length === 0) return type;
  if (kept.length === 1) return kept[0];
  if (
    kept.length === 2 &&
    kept.every((t) => (t.flags & ts.TypeFlags.BooleanLiteral) !== 0)
  ) {
    return checker.getBaseTypeOfLiteralType(kept[0]);
  }
  return type;
}

function unwrapArrayOrNullableForFields(
  checker: ts.TypeChecker,
  type: ts.Type
): ts.Type {
  const stripped = stripOptionalUndefined(checker, type);
  if (stripped.isUnion()) {
    const nonNull = stripped.types.filter((t) => (t.flags & ts.TypeFlags.Null) === 0);
    if (nonNull.length === 1) {
      return unwrapArrayOrNullableForFields(checker, nonNull[0]);
    }
    return stripped;
  }
  if (checker.isArrayType(stripped) || checker.isTupleType(stripped)) {
    const typeArgs = checker.getTypeArguments(stripped as ts.TypeReference);
    if (typeArgs.length === 1) {
      return stripOptionalUndefined(checker, typeArgs[0]);
    }
  }
  return stripped;
}

function isPrimitiveOrBuiltinType(type: ts.Type): boolean {
  if (
    (type.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.ESSymbolLike |
        ts.TypeFlags.Void |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Null |
        ts.TypeFlags.Never |
        ts.TypeFlags.Any |
        ts.TypeFlags.Unknown)) !==
    0
  ) {
    return true;
  }
  const symName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (symName && BUILTIN_OBJECT_TYPE_NAMES.has(symName)) {
    return true;
  }
  if (type.getCallSignatures().length > 0 && type.getProperties().length === 0) {
    return true;
  }
  return false;
}

function resolveTypeDeclarationRef(
  type: ts.Type,
  repoRoot: string,
  ownRelFilePath: string,
  depPathsOut: Set<string>
): PortDeclarationRef | undefined {
  const sym = type.aliasSymbol ?? type.getSymbol();
  const decl = sym?.getDeclarations()?.[0];
  if (!decl) return undefined;
  const sf = decl.getSourceFile();
  if (!sf || (sf.isDeclarationFile && normalizeSlash(sf.fileName).includes('/node_modules/'))) {
    return undefined;
  }
  const absDeclFile = resolve(sf.fileName);
  const absRepoRoot = resolve(repoRoot);
  if (!absDeclFile.startsWith(absRepoRoot) || normalizeSlash(absDeclFile).includes('/node_modules/')) {
    return undefined;
  }
  const relPath = normalizeSlash(relative(absRepoRoot, absDeclFile));
  if (!relPath || relPath.startsWith('..')) return undefined;
  if (relPath !== ownRelFilePath) {
    depPathsOut.add(relPath);
  }
  const lineNumber = sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1;
  return { filePath: relPath, lineNumber };
}

function extractCheckerFields(
  checker: ts.TypeChecker,
  rawType: ts.Type,
  enclosingNode: ts.Node,
  repoRoot: string,
  ownRelFilePath: string,
  depPathsOut: Set<string>,
  depth: number,
  seenTypes: Set<ts.Type>
): PortFieldSchema[] | undefined {
  const target = unwrapArrayOrNullableForFields(checker, rawType);
  if (isPrimitiveOrBuiltinType(target)) return undefined;
  if (seenTypes.has(target)) return undefined;
  if (target.getCallSignatures().length > 0) return undefined;

  const props = checker.getPropertiesOfType(target);
  if (props.length === 0 || props.length > 80) return undefined;

  // Skip DOM/global ambient prototypes that carry dozens of built-in methods
  const firstDeclSf = props[0]?.valueDeclaration?.getSourceFile() ?? props[0]?.declarations?.[0]?.getSourceFile();
  if (firstDeclSf && normalizeSlash(firstDeclSf.fileName).includes('/typescript/lib/lib.')) {
    return undefined;
  }

  seenTypes.add(target);
  resolveTypeDeclarationRef(target, repoRoot, ownRelFilePath, depPathsOut);

  const fields: PortFieldSchema[] = [];
  for (const prop of props) {
    if (fields.length >= MAX_CHECKER_FIELDS) break;
    const propName = prop.getName();
    if (!propName || propName.startsWith('__@')) continue;

    // Exclude private/protected class fields from public port schemas
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (decl && ts.canHaveModifiers(decl)) {
      const mods = ts.getModifiers(decl);
      if (
        mods?.some(
          (m) =>
            m.kind === ts.SyntaxKind.PrivateKeyword ||
            m.kind === ts.SyntaxKind.ProtectedKeyword
        )
      ) {
        continue;
      }
    }

    const propType = checker.getTypeOfSymbolAtLocation(prop, enclosingNode);
    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    const cleanPropType = isOptional
      ? stripOptionalUndefined(checker, propType)
      : propType;
    const typeStr = formatTypeConcise(checker, cleanPropType, enclosingNode, isOptional);

    let nested: PortFieldSchema[] | undefined;
    if (depth + 1 < MAX_CHECKER_DEPTH) {
      nested = extractCheckerFields(
        checker,
        cleanPropType,
        enclosingNode,
        repoRoot,
        ownRelFilePath,
        depPathsOut,
        depth + 1,
        new Set(seenTypes)
      );
    }

    fields.push({
      name: propName,
      type: typeStr,
      ...(isOptional ? { optional: true } : {}),
      ...(nested ? { fields: nested } : {}),
    });
  }

  return fields.length > 0 ? fields : undefined;
}

interface ResolvedCallableTarget {
  ownerAstNode: ts.Node;
  signatureNode: ts.SignatureDeclaration | null;
}

function unwrapExprToFunction(
  expr: ts.Expression | undefined
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!expr) return null;
  let cur: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) return cur;
  if (ts.isCallExpression(cur) && cur.arguments.length > 0) {
    for (let i = cur.arguments.length - 1; i >= 0; i--) {
      const inner = unwrapExprToFunction(cur.arguments[i]);
      if (inner) return inner;
    }
  }
  return null;
}

function findContractDeclarationInSourceFile(
  sf: ts.SourceFile,
  targetLine: number | undefined
): ResolvedCallableTarget | null {
  if (!targetLine || targetLine < 1) return null;
  let best: { node: ts.Node; sig: ts.SignatureDeclaration | null; dist: number } | null = null;

  const consider = (cand: ts.Node, sig: ts.SignatureDeclaration | null) => {
    const startLine = sf.getLineAndCharacterOfPosition(cand.getStart(sf)).line + 1;
    const dist = Math.abs(startLine - targetLine);
    if (dist > 2) return;
    if (!best || dist < best.dist || (dist === best.dist && sig && !best.sig)) {
      best = { node: cand, sig, dist };
    }
  };

  const walk = (n: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n)
    ) {
      consider(n, n);
    } else if (ts.isPropertyDeclaration(n) && n.initializer) {
      const fn = unwrapExprToFunction(n.initializer);
      if (fn) consider(n, fn);
    } else if (ts.isVariableDeclaration(n)) {
      const fn = unwrapExprToFunction(n.initializer);
      consider(n, fn);
    } else if (ts.isVariableStatement(n) && n.declarationList.declarations.length === 1) {
      const decl = n.declarationList.declarations[0];
      const fn = unwrapExprToFunction(decl.initializer);
      consider(n, fn);
    } else if (ts.isCallExpression(n)) {
      const fn = unwrapExprToFunction(n);
      if (fn) consider(n, fn);
    }
    ts.forEachChild(n, walk);
  };

  walk(sf);
  return best ? { ownerAstNode: (best as any).node, signatureNode: (best as any).sig } : null;
}

function hasAsyncModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function isInsideReturnOrConciseBody(
  pos: number,
  ownerAstNode: ts.Node,
  sigNode: ts.SignatureDeclaration | null
): boolean {
  if (
    sigNode &&
    ts.isArrowFunction(sigNode) &&
    !ts.isBlock(sigNode.body) &&
    pos >= sigNode.body.getStart() &&
    pos <= sigNode.body.getEnd()
  ) {
    return true;
  }
  let insideReturn = false;
  const walk = (n: ts.Node): void => {
    if (insideReturn) return;
    if (pos < n.getFullStart() || pos > n.getEnd()) return;
    if (ts.isReturnStatement(n)) {
      insideReturn = true;
      return;
    }
    if (
      n !== ownerAstNode &&
      n !== sigNode &&
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n))
    ) {
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(ownerAstNode);
  return insideReturn;
}

function isInsideCallOrJsxExpression(pos: number, ownerAstNode: ts.Node): boolean {
  let matched = false;
  const walk = (n: ts.Node): void => {
    if (matched) return;
    if (pos < n.getFullStart() || pos > n.getEnd()) return;
    if (
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isJsxOpeningElement(n) ||
      ts.isJsxSelfClosingElement(n)
    ) {
      matched = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(ownerAstNode);
  return matched;
}

function buildIncrementalProgramGroup(
  tsconfigPath: string | null,
  repoPath: string,
  dirtyAbsFiles: string[],
  cacheDirOption?: string | false
): ts.EmitAndSemanticDiagnosticsBuilderProgram {
  let tsBuildInfoFile: string | undefined;
  if (cacheDirOption !== false) {
    const cacheDir = cacheDirOption ?? resolve(repoPath, '.chomp', 'cache');
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    const groupKey = tsconfigPath ?? `synthetic:${resolve(repoPath)}`;
    const slug = createHash('sha1').update(groupKey).digest('hex').slice(0, 12);
    tsBuildInfoFile = resolve(cacheDir, `ports-${slug}.tsbuildinfo`);
  }

  let baseOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
  };
  let rootNames = [...dirtyAbsFiles];

  if (tsconfigPath && existsSync(tsconfigPath)) {
    const readRes = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!readRes.error && readRes.config) {
      const parsed = ts.parseJsonConfigFileContent(
        readRes.config,
        ts.sys,
        dirname(tsconfigPath)
      );
      baseOptions = { ...baseOptions, ...parsed.options };
      const fileSet = new Set(parsed.fileNames.map((f) => resolve(f)));
      for (const df of dirtyAbsFiles) {
        fileSet.add(resolve(df));
      }
      rootNames = Array.from(fileSet);
    }
  }

  const options: ts.CompilerOptions = {
    ...baseOptions,
    noEmit: true,
    emitDeclarationOnly: false,
    declaration: false,
    sourceMap: false,
    incremental: Boolean(tsBuildInfoFile),
    composite: false,
    ...(tsBuildInfoFile ? { tsBuildInfoFile } : {}),
    skipLibCheck: true,
    skipDefaultLibCheck: false,
  };

  return ts.createIncrementalProgram({
    rootNames,
    options,
  });
}

/**
 * Runs Speed 2 incremental TypeScript Port Valve verification on `graph` and persists
 * `L1_PORTS` (`source: "chomp-ports"`) cache rows to `storage`.
 *
 * @param options Repository path, ID, storage adapter, and extracted Layer 0 `RepresentationGraph`.
 * @returns Counts of hydrated, cached, and pruned `L1_PORTS` overlays plus boundary diagnostic totals.
 */
export async function hydrateRepositoryPortValves(
  options: HydratePortValvesOptions
): Promise<HydratePortValvesResult> {
  const t0 = Date.now();
  const { repoPath, repoId, storage, graph, force = false, cacheDir } = options;

  const existingOverlays = await storage.getEntityOverlays(repoId, {
    layer: CHOMP_PORTS_LAYER,
    source: CHOMP_PORTS_SOURCE,
  });
  const existingByEntityId = new Map(existingOverlays.map((o) => [o.entityId, o]));

  const currentNodeIds = new Set(graph.nodes.map((n) => n.id));
  let prunedCount = 0;
  for (const oldOv of existingOverlays) {
    if (!currentNodeIds.has(oldOv.entityId)) {
      await storage.deleteEntityOverlay({
        repositoryId: repoId,
        entityId: oldOv.entityId,
        layer: CHOMP_PORTS_LAYER,
        source: CHOMP_PORTS_SOURCE,
      });
      existingByEntityId.delete(oldOv.entityId);
      prunedCount++;
    }
  }

  const candidateContracts = graph.nodes.filter((n) => {
    if (n.type !== 'CONTRACT' || n.entityType === 'EXPORTED_TYPE') return false;
    const ev = primaryEvidenceOf(n);
    return Boolean(ev && isSupportedSourcePath(ev.filePath));
  });

  const dirtyContracts = candidateContracts.filter((n) => {
    if (force) return true;
    const existing = existingByEntityId.get(n.id);
    if (!existing) return true;
    return existing.stale === true;
  });

  if (dirtyContracts.length === 0) {
    let existingDiagCount = 0;
    for (const ov of existingByEntityId.values()) {
      const diags = ov.payload?.diagnostics;
      if (Array.isArray(diags)) existingDiagCount += diags.length;
    }
    return {
      hydratedCount: 0,
      cachedCount: existingByEntityId.size,
      prunedCount,
      diagnosticCount: existingDiagCount,
      durationMs: Date.now() - t0,
    };
  }

  const outEdgesBySource = new Map<string, StructuralEdge[]>();
  for (const edge of graph.edges) {
    if (!edge.sourceId) continue;
    let list = outEdgesBySource.get(edge.sourceId);
    if (!list) {
      list = [];
      outEdgesBySource.set(edge.sourceId, list);
    }
    list.push(edge);
  }

  const tsconfigCache = new Map<string, string | null>();
  const fileHashCache = new Map<string, string | null>();

  const contractsByGroup = new Map<string | null, StructuralNode[]>();
  for (const node of dirtyContracts) {
    const ev = primaryEvidenceOf(node)!;
    const absFile = resolve(repoPath, ev.filePath);
    if (!existsSync(absFile)) continue;
    const tsconfig = findNearestTsconfig(absFile, repoPath, tsconfigCache);
    let bucket = contractsByGroup.get(tsconfig);
    if (!bucket) {
      bucket = [];
      contractsByGroup.set(tsconfig, bucket);
    }
    bucket.push(node);
  }

  const overlaysToUpsert: EntityOverlayInput[] = [];
  let newDiagCount = 0;

  for (const [tsconfigPath, groupNodes] of contractsByGroup) {
    const nodesByAbsFile = new Map<string, StructuralNode[]>();
    for (const n of groupNodes) {
      const ev = primaryEvidenceOf(n)!;
      const absFile = resolve(repoPath, ev.filePath);
      let list = nodesByAbsFile.get(absFile);
      if (!list) {
        list = [];
        nodesByAbsFile.set(absFile, list);
      }
      list.push(n);
    }

    const builder = buildIncrementalProgramGroup(
      tsconfigPath,
      repoPath,
      Array.from(nodesByAbsFile.keys()),
      cacheDir
    );
    const program = builder.getProgram();
    const checker = program.getTypeChecker();

    for (const [absFile, fileContracts] of nodesByAbsFile) {
      const sf = program.getSourceFile(absFile);
      if (!sf) continue;

      const relFilePath = normalizeSlash(relative(resolve(repoPath), absFile));
      const resolvedTargets: Array<{
        contract: StructuralNode;
        ownerAstNode: ts.Node;
        signatureNode: ts.SignatureDeclaration | null;
        spanStart: number;
        spanEnd: number;
      }> = [];

      for (const contract of fileContracts) {
        const ev = primaryEvidenceOf(contract);
        const found = findContractDeclarationInSourceFile(sf, ev?.lineNumber);
        if (!found) continue;
        resolvedTargets.push({
          contract,
          ownerAstNode: found.ownerAstNode,
          signatureNode: found.signatureNode,
          spanStart: found.ownerAstNode.getStart(sf),
          spanEnd: found.ownerAstNode.getEnd(),
        });
      }

      // Collect semantic diagnostics for this dirty file and bind port mismatches to their owning contract
      const diagsByContractId = new Map<string, PortDiagnostic[]>();
      const fileDiagnostics = builder.getSemanticDiagnostics(sf);

      for (const d of fileDiagnostics) {
        if (d.start === undefined) continue;
        const isCallCode = CALL_MISMATCH_TS_CODES.has(d.code);
        const isReturnCode = RETURN_MISMATCH_TS_CODES.has(d.code);
        if (!isCallCode && !isReturnCode) continue;

        // Pick the tightest enclosing contract AST span containing `d.start`
        let bestOwner: (typeof resolvedTargets)[number] | null = null;
        for (const rt of resolvedTargets) {
          if (d.start >= rt.spanStart && d.start <= rt.spanEnd) {
            if (
              !bestOwner ||
              rt.spanEnd - rt.spanStart < bestOwner.spanEnd - bestOwner.spanStart
            ) {
              bestOwner = rt;
            }
          }
        }
        if (!bestOwner) continue;

        let kind: PortDiagnostic['kind'] | null = null;
        if (
          isReturnCode &&
          isInsideReturnOrConciseBody(
            d.start,
            bestOwner.ownerAstNode,
            bestOwner.signatureNode
          )
        ) {
          kind = 'TS_RETURN_MISMATCH';
        } else if (
          (isCallCode || d.code === 2322) &&
          isInsideCallOrJsxExpression(d.start, bestOwner.ownerAstNode)
        ) {
          kind = 'TS_CALL_MISMATCH';
        } else if (d.code === 2355) {
          kind = 'TS_RETURN_MISMATCH';
        }
        if (!kind) continue;

        const diagLine = sf.getLineAndCharacterOfPosition(d.start).line + 1;
        const msg = ts
          .flattenDiagnosticMessageText(d.messageText, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        let peerEntityId: string | undefined;
        if (kind === 'TS_CALL_MISMATCH') {
          const outEdges = outEdgesBySource.get(bestOwner.contract.id) ?? [];
          const matchingEdge = outEdges.find((e) => {
            if (!e.targetId) return false;
            const eEvs = Array.isArray(e.evidence) ? e.evidence : [e.evidence];
            return eEvs.some(
              (ev) =>
                ev &&
                typeof ev.lineNumber === 'number' &&
                Math.abs(ev.lineNumber - diagLine) <= 2
            );
          });
          if (matchingEdge?.targetId) {
            peerEntityId = matchingEdge.targetId;
          }
        }

        let bucket = diagsByContractId.get(bestOwner.contract.id);
        if (!bucket) {
          bucket = [];
          diagsByContractId.set(bestOwner.contract.id, bucket);
        }
        if (bucket.length < 8) {
          bucket.push({
            kind,
            tsCode: d.code,
            message: msg.length > 220 ? `${msg.slice(0, 219)}…` : msg,
            filePath: relFilePath,
            lineNumber: diagLine,
            ...(peerEntityId ? { peerEntityId } : {}),
          });
        }
      }

      for (const rt of resolvedTargets) {
        const { contract, signatureNode } = rt;
        const depRelPaths = new Set<string>();
        let inputs: PortParameterValve[] | undefined;
        let output: PortOutputValve | undefined;
        let zeroInputs = false;

        if (signatureNode) {
          const sig = checker.getSignatureFromDeclaration(signatureNode);
          if (sig) {
            const sigParams = sig.getParameters();
            const parsedParams: PortParameterValve[] = [];

            for (let i = 0; i < sigParams.length; i++) {
              const sym = sigParams[i];
              if (sym.getName() === 'this') continue;
              const paramDecl = signatureNode.parameters[i];
              const isOptional = Boolean(
                (sym.flags & ts.SymbolFlags.Optional) !== 0 ||
                  paramDecl?.questionToken ||
                  paramDecl?.initializer ||
                  paramDecl?.dotDotDotToken
              );
              const rawParamType = checker.getTypeOfSymbolAtLocation(sym, signatureNode);
              const cleanParamType = isOptional
                ? stripOptionalUndefined(checker, rawParamType)
                : rawParamType;
              const typeStr = formatTypeConcise(
                checker,
                cleanParamType,
                signatureNode,
                isOptional
              );
              const fields = extractCheckerFields(
                checker,
                cleanParamType,
                signatureNode,
                repoPath,
                relFilePath,
                depRelPaths,
                0,
                new Set()
              );
              const declaration = resolveTypeDeclarationRef(
                unwrapArrayOrNullableForFields(checker, cleanParamType),
                repoPath,
                relFilePath,
                depRelPaths
              );

              parsedParams.push({
                name: paramDecl?.dotDotDotToken ? `...${sym.getName()}` : sym.getName(),
                type: typeStr,
                ...(isOptional ? { optional: true } : {}),
                ...(fields ? { fields } : {}),
                ...(declaration ? { declaration } : {}),
              });
            }

            if (parsedParams.length > 0) {
              inputs = parsedParams;
            } else {
              zeroInputs = true;
            }

            const rawReturnType = checker.getReturnTypeOfSignature(sig);
            const awaitedReturnType =
              checker.getAwaitedType(rawReturnType) ?? rawReturnType;
            const unwrappedPromise = awaitedReturnType !== rawReturnType;
            const isAsync = unwrappedPromise || hasAsyncModifier(signatureNode);
            const outTypeStr = formatTypeConcise(
              checker,
              awaitedReturnType,
              signatureNode
            );
            const outFields = extractCheckerFields(
              checker,
              awaitedReturnType,
              signatureNode,
              repoPath,
              relFilePath,
              depRelPaths,
              0,
              new Set()
            );
            const outDecl = resolveTypeDeclarationRef(
              unwrapArrayOrNullableForFields(checker, awaitedReturnType),
              repoPath,
              relFilePath,
              depRelPaths
            );

            output = {
              type: outTypeStr,
              ...(isAsync ? { async: true } : {}),
              ...(outFields ? { fields: outFields } : {}),
              ...(outDecl ? { declaration: outDecl } : {}),
            };
          }
        }

        const contractDiags = diagsByContractId.get(contract.id);
        if (contractDiags) {
          newDiagCount += contractDiags.length;
        }

        const basePv = contract.metadata?.portValves;
        if (!inputs && basePv?.inputs) {
          inputs = basePv.inputs;
        }
        if (!output && basePv?.output) {
          output = basePv.output;
        }

        const payload: ContractPortValves = {
          tier: 'typechecked',
          origin:
            basePv?.origin &&
            (basePv.origin === 'zod' ||
              basePv.origin === 'drizzle' ||
              basePv.origin === 'mcp-schema')
              ? basePv.origin
              : 'ts-typecheck',
          ...(contract.metadata?.inputTypes
            ? { inputTypes: contract.metadata.inputTypes }
            : {}),
          ...(output?.type
            ? { outputType: output.type }
            : contract.metadata?.outputType
              ? { outputType: contract.metadata.outputType }
              : {}),
          ...(inputs && inputs.length > 0 ? { inputs } : {}),
          ...(output ? { output } : {}),
          ...(zeroInputs && (!inputs || inputs.length === 0)
            ? { zeroInputs: true }
            : {}),
          ...(contractDiags && contractDiags.length > 0
            ? { diagnostics: contractDiags }
            : {}),
        };

        const inputDeps: OverlayInputDependency[] = [];
        for (const depRel of depRelPaths) {
          const absDep = resolve(repoPath, depRel);
          const hash = hashFileShort(absDep, fileHashCache);
          if (hash) {
            inputDeps.push({ path: depRel, hash });
          }
        }

        overlaysToUpsert.push({
          repositoryId: repoId,
          entityId: contract.id,
          layer: CHOMP_PORTS_LAYER,
          source: CHOMP_PORTS_SOURCE,
          payload: payload as unknown as Record<string, any>,
          bodyHash:
            typeof contract.metadata?.bodyHash === 'string'
              ? contract.metadata.bodyHash
              : undefined,
          derivation: 'EXTRACTED',
          ...(inputDeps.length > 0 ? { inputs: inputDeps } : {}),
        });
      }
    }

    // Persist incremental `.tsbuildinfo` strictly inside `.chomp/cache/` (never emitting JS/DTS)
    if (cacheDir !== false) {
      try {
        builder.emit(undefined, (fileName, text) => {
          if (fileName.endsWith('.tsbuildinfo')) {
            ts.sys.writeFile(fileName, text);
          }
        });
      } catch {
        // Non-fatal if cache directory is read-only
      }
    }
  }

  if (overlaysToUpsert.length > 0) {
    await storage.upsertEntityOverlays(overlaysToUpsert);
  }

  let totalDiagnostics = newDiagCount;
  let cachedCount = 0;
  const refreshedIds = new Set(overlaysToUpsert.map((o) => o.entityId));
  for (const [eid, ov] of existingByEntityId) {
    if (refreshedIds.has(eid)) continue;
    cachedCount++;
    const diags = ov.payload?.diagnostics;
    if (Array.isArray(diags)) totalDiagnostics += diags.length;
  }

  return {
    hydratedCount: overlaysToUpsert.length,
    cachedCount,
    prunedCount,
    diagnosticCount: totalDiagnostics,
    durationMs: Date.now() - t0,
  };
}
