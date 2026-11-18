// packages/core/src/extractor/visitors/relationshipVisitor.ts
// Visitor for RELATIONSHIP primitives — known structural dependencies between units.

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { extractExpressRouterMount, extractExpressRouteMiddleware } from '../adapters/expressAdapter.js';
import { extractDrizzleQueryChain, isInnerDrizzleQueryChainCall } from '../adapters/drizzleAdapter.js';
import { extractPayloadConfigRegistry, extractPayloadHooks } from '../adapters/payloadAdapter.js';

import { resolveModulePath } from '../pathResolver.js';
import {
  stableEntityId,
  cjsContractEntityId,
  contractEntityId,
  boundaryEntityId,
  resolveLogicalBoundaryScope,
  findEnclosingNamespaceScope,
} from '../../utils/id.js';
import {
  HTTP_CLIENT_IDENTIFIERS,
  DB_CLIENT_IDENTIFIERS,
  isLocalOpenConnectorClient,
  isWindowPostMessageCall,
  resolveHttpUrlPathFromExpression,
} from './openConnectorVisitor.js';
import { WorkspaceRegistry } from '../workspaceResolver.js';
import {
  BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS,
  BUILTIN_VALUE_PROTOTYPE_METHODS,
  DI_CONTAINER_PACKAGES,
  classNameFromTypeOrNew,
  findLocalVariableDeclaration,
  findLocalVariableOrBindingDeclaration,
  findModuleBinding,
  findValueModuleBinding,
  findReturnedNewClassName,
  getCachedSourceFile,
  getChainRootIdentifierNode,
  getPropertyOrElementAccess,
  getSourceFileDeclarationIndex,
  isExternalSpecifier,
  isReactHookCall,
  packageConnectorId,
  resolveCjsContractInSourceFile,
  resolveClassBoundaryInModule,
  resolveClassMethodInModule,
  resolveClassMethodTargetWithEvidence,
  resolveImportedClassBoundaryTargetWithEvidence,
  resolveExternalPackageTarget,
  resolvePublicMethodTarget,
  resolveRouterMountTarget,
  unwrapDynamicImport,
  unwrapLazyImport,
  unwrapRequire,
} from './targetResolver.js';
import {
  SHAPE_KEY_VERSION,
  classifyImportedBindingKind,
  computeIdentifierRefShapeKey,
  withCallShapeKey,
} from './shapeKeyVisitor.js';
import { unwrapWrappedFunction } from '../conventions/engine.js';
import { REACT_HOC_WRAPPERS } from '../conventions/react.js';
import {
  BUILTIN_DOM_ITERATOR_REFLECTION_METHODS,
  HTTP_ROUTE_HANDLER_EDGE_PATTERN_ID,
  HTTP_ROUTE_MIDDLEWARE_EDGE_PATTERN_ID,
  applyConventionRulesDetailed,
  classifyFileRole,
  deriveVueSfcComponentName,
  deriveSvelteComponentName,
  isBindWrappedLocalExpression,
  isMdxOrAstroFilePath,
  isSvelteRuneCall,
  resolveSvgComponentImportTarget,
  stripPayloadPluginPrefix,
  unwrapTransparentFunctionWrapperCall,
  type ConventionConfigResolver,
  type ConventionSet,
  type EdgeTargetResolvers,
} from '../conventions/index.js';
import { extractReactJsxRender } from '../adapters/reactAdapter.js';
import { classifyNextjsFile } from '../adapters/nextjsAdapter.js';
import { extractFactoryExport } from './factoryExportVisitor.js';
import { extractCommonjsExport } from './commonjsExportVisitor.js';
import { publicMethodName } from './publicMethodVisitor.js';
import {
  extractHonoOrForEachRouterMount,
  resolveEventPubSubTarget,
  extractModuleExportDelegationEdges,
  extractJsxComponentMapPropEdges,
  extractNestDecoratorAndPortAdapterEdges,
  extractDrizzleNamespaceSchemaEdges,
  extractExpressResAugmentedMethodCall,
  extractDefaultImportedObjectPropertyRead,
  extractRemixFormActionRouteLink,
  extractRouterInstanceToHttpEndpointEdge,
  extractAngularSchematicTaskRelationship,
  extractFrameworkBareCallRelationship,
  extractReactRouterLoadContextCall,
  extractGetterPropertyAccessInvocation,
} from './frameworkRelationshipVisitor.js';
import {
  findCallableObjectProperty,
  findNestedCallableObjectProperty,
  getExportedNamesForDeclaration,
  isComponentMemberAlias,
  isPiniaDefineStoreInitializer,
  isReactContextInitializer,
  isSharedModuleScopedVarFunctionHelper,
  isStyledComponentInitializer,
  matchExportedFactoryCallConstantPattern,
  resolveExtractedContractName,
  unwrapCachedFunctionInitializer,
  visitContract,
} from './contractVisitor.js';

const ROUTE_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

const BUILTIN_COLLECTION_PROTOTYPE_METHODS = BUILTIN_VALUE_PROTOTYPE_METHODS;

function isFunctionValueDeclaration(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  if (ts.isFunctionDeclaration(node)) return true;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (
      isFunctionLikeInitializer(
        node.initializer,
        ts.isIdentifier(node.name) ? node.name.text : undefined,
        sourceFile
      )
    ) {
      return true;
    }
    if (
      node.parent &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.parent &&
      ts.isVariableStatement(node.parent.parent)
    ) {
      const factoryContracts = extractFactoryExport(
        node.parent.parent,
        () => ({ filePath: '', lineNumber: 1, snippet: '' }),
        () => ''
      );
      const list = Array.isArray(factoryContracts)
        ? factoryContracts
        : factoryContracts
          ? [factoryContracts]
          : [];
      if (list.some((c) => c.entityType === 'AUTH_INTERFACE')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when an initializer is a component/function value: an arrow or function expression, one
 * wrapped in a higher-order component wrapper (`memo(fn)`, `React.forwardRef(fn)` — `[PAT-EXT-25]`),
 * or an exported compound component member alias (`const Tabs = TabsPrimitive.Root`).
 * The wrapper list is the React convention table's, so resolution and extraction cannot drift.
 */
function isFunctionLikeInitializer(
  init: ts.Expression,
  declName?: string,
  sourceFile?: ts.SourceFile
): boolean {
  let unwrapped = init;
  while (
    ts.isParenthesizedExpression(unwrapped) ||
    ts.isAsExpression(unwrapped) ||
    ts.isSatisfiesExpression(unwrapped) ||
    ts.isTypeAssertionExpression(unwrapped) ||
    ts.isNonNullExpression(unwrapped) ||
    (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken)
  ) {
    unwrapped = ts.isBinaryExpression(unwrapped) ? unwrapped.right : unwrapped.expression;
  }
  return (
    ts.isArrowFunction(unwrapped) ||
    ts.isFunctionExpression(unwrapped) ||
    unwrapWrappedFunction(unwrapped, REACT_HOC_WRAPPERS, sourceFile) !== null ||
    unwrapCachedFunctionInitializer(unwrapped, sourceFile) !== null ||
    isStyledComponentInitializer(unwrapped) ||
    isReactContextInitializer(unwrapped) ||
    isPiniaDefineStoreInitializer(unwrapped) ||
    matchExportedFactoryCallConstantPattern(unwrapped) !== null ||
    Boolean(declName && sourceFile && isComponentMemberAlias(declName, unwrapped, sourceFile))
  );
}

type TargetSymbolCandidate =
  | { kind: 'decl'; node: ts.Node }
  | { kind: 'localExport'; node: ts.ExportDeclaration; localName: string }
  | { kind: 'namespaceExport'; node: ts.ExportDeclaration; specifier: string };

interface RelationshipFileIndex {
  importDeclByLocalName: Map<string, ts.ImportDeclaration | ts.ImportEqualsDeclaration>;
  localFunctionDecls: Set<string>;
  symbolCandidates: Map<string, TargetSymbolCandidate[]>;
  reExportDecls: ts.ExportDeclaration[];
  resolvedExportMemo: Map<string, { targetId: string; targetEvidence: EvidenceRecord; resolvedSymbol?: string } | null>;
}

export function getImportDeclarationSpecifier(
  decl: ts.ImportDeclaration | ts.ImportEqualsDeclaration | null | undefined
): string | null {
  if (!decl) return null;
  if (ts.isImportDeclaration(decl)) {
    return ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : null;
  }
  if (
    ts.isImportEqualsDeclaration(decl) &&
    decl.moduleReference &&
    ts.isExternalModuleReference(decl.moduleReference) &&
    decl.moduleReference.expression &&
    ts.isStringLiteral(decl.moduleReference.expression)
  ) {
    return decl.moduleReference.expression.text;
  }
  return null;
}

const relationshipFileIndexCache = new WeakMap<ts.SourceFile, RelationshipFileIndex>();

function addSymbolCandidate(
  map: Map<string, TargetSymbolCandidate[]>,
  symbol: string,
  candidate: TargetSymbolCandidate
): void {
  let list = map.get(symbol);
  if (!list) {
    list = [];
    map.set(symbol, list);
  }
  list.push(candidate);
}

/**
 * Builds and caches a per-`SourceFile` symbol & import index (`[PAT-EXT-31]`),
 * replacing repeated full-file `ts.forEachChild` AST walks on every call expression
 * with $O(1)$ Map lookups.
 */
function getRelationshipFileIndex(sourceFile: ts.SourceFile): RelationshipFileIndex {
  const cached = relationshipFileIndexCache.get(sourceFile);
  if (cached) return cached;

  const importDeclByLocalName = new Map<string, ts.ImportDeclaration | ts.ImportEqualsDeclaration>();
  const localFunctionDecls = new Set<string>();
  const symbolCandidates = new Map<string, TargetSymbolCandidate[]>();
  const reExportDecls: ts.ExportDeclaration[] = [];

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const clause = stmt.importClause;
      if (clause.isTypeOnly) continue;
      if (clause.name && !importDeclByLocalName.has(clause.name.text)) {
        importDeclByLocalName.set(clause.name.text, stmt);
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          if (!importDeclByLocalName.has(clause.namedBindings.name.text)) {
            importDeclByLocalName.set(clause.namedBindings.name.text, stmt);
          }
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (el.isTypeOnly) continue;
            if (!importDeclByLocalName.has(el.name.text)) {
              importDeclByLocalName.set(el.name.text, stmt);
            }
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      stmt.moduleReference &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression &&
      ts.isStringLiteral(stmt.moduleReference.expression)
    ) {
      if (!importDeclByLocalName.has(stmt.name.text)) {
        importDeclByLocalName.set(stmt.name.text, stmt);
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      localFunctionDecls.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          isFunctionLikeInitializer(decl.initializer, decl.name.text, sourceFile)
        ) {
          localFunctionDecls.add(decl.name.text);
        } else if (ts.isObjectBindingPattern(decl.name) && isFunctionValueDeclaration(decl, sourceFile)) {
          for (const el of decl.name.elements) {
            if (ts.isIdentifier(el.name)) {
              localFunctionDecls.add(el.name.text);
            }
          }
        }
      }
    }
  }

  const visitTarget = (targetNode: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(targetNode) ||
        ts.isVariableDeclaration(targetNode) ||
        ts.isClassDeclaration(targetNode)) &&
      targetNode.name &&
      ts.isIdentifier(targetNode.name)
    ) {
      addSymbolCandidate(symbolCandidates, targetNode.name.text, { kind: 'decl', node: targetNode });
    } else if (ts.isVariableDeclaration(targetNode) && ts.isObjectBindingPattern(targetNode.name)) {
      for (const el of targetNode.name.elements) {
        if (ts.isIdentifier(el.name)) {
          addSymbolCandidate(symbolCandidates, el.name.text, { kind: 'decl', node: targetNode });
        }
      }
    } else if (ts.isExportDeclaration(targetNode)) {
      if (!targetNode.moduleSpecifier && targetNode.exportClause && ts.isNamedExports(targetNode.exportClause)) {
        for (const el of targetNode.exportClause.elements) {
          const localName = (el.propertyName ?? el.name).text;
          addSymbolCandidate(symbolCandidates, el.name.text, {
            kind: 'localExport',
            node: targetNode,
            localName,
          });
        }
      } else if (targetNode.moduleSpecifier && ts.isStringLiteral(targetNode.moduleSpecifier)) {
        if (targetNode.exportClause && ts.isNamespaceExport(targetNode.exportClause)) {
          addSymbolCandidate(symbolCandidates, targetNode.exportClause.name.text, {
            kind: 'namespaceExport',
            node: targetNode,
            specifier: targetNode.moduleSpecifier.text,
          });
        }
        reExportDecls.push(targetNode);
      }
    }
    if (
      ts.isFunctionDeclaration(targetNode) ||
      ts.isFunctionExpression(targetNode) ||
      ts.isArrowFunction(targetNode) ||
      ts.isMethodDeclaration(targetNode) ||
      ts.isConstructorDeclaration(targetNode) ||
      ts.isGetAccessorDeclaration(targetNode) ||
      ts.isSetAccessorDeclaration(targetNode)
    ) {
      return;
    }
    ts.forEachChild(targetNode, visitTarget);
  };

  visitTarget(sourceFile);

  const index: RelationshipFileIndex = {
    importDeclByLocalName,
    localFunctionDecls,
    symbolCandidates,
    reExportDecls,
    resolvedExportMemo: new Map(),
  };
  relationshipFileIndexCache.set(sourceFile, index);
  return index;
}

/**
 * Follows a chain of intermediate CommonJS sub-module property assignments (`api.users`, `controllers.write.users`,
 * `privileges.admin`, `user.email`) to the leaf module path (`[PAT-EXT-29]`, `[PAT-EXT-31]`).
 */
function followCjsSubmoduleSegments(
  startRelPath: string,
  segments: readonly string[],
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): string | null {
  let currentRelPath = startRelPath;
  for (const seg of segments) {
    const absPath = path.resolve(repoRoot, currentRelPath);
    const sf = getCachedSourceFile(absPath);
    if (!sf) return null;
    const subSpec = getSourceFileDeclarationIndex(sf).cjsSubmoduleRequires.get(seg);
    if (!subSpec) return null;
    const nextRel = resolveModulePath(subSpec, absPath, repoRoot, workspaceRegistry);
    if (!nextRel) return null;
    currentRelPath = nextRel;
  }
  return currentRelPath;
}

/**
 * Follows (re-)exports and CommonJS mixin delegations (`require('./sub')(User)`) from a resolved module
 * to find the symbol a call addresses, and returns the deterministic id of the CONTRACT that symbol becomes.
 *
 * Barrels commonly hold several re-exports; the symbol lives behind only one of them:
 *
 * @example
 * // packages/core/src/index.ts
 * export * from './types/index.js';       // does NOT declare analyzeTarget → dead end
 * export * from './extractor/index.js';   // declares analyzeTarget            → resolved here
 * export * from './differ/index.js';
 *
 * Every matching re-export is therefore explored (in source order, backtracking on dead ends) and
 * the first one that proves the symbol wins. A visited set guards against circular barrels.
 */
export function resolveTargetExport(
  initialResolvedPath: string,
  rootText: string,
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry,
  entityLabelPrefix: string,
  depth = 0,
  visited: Set<string> = new Set<string>(),
  requireFunctionDeclaration = false,
  memberProperty?: string
): { targetId: string; targetEvidence: EvidenceRecord; resolvedSymbol?: string } | null {
  if (depth > 5) return null; // Prevent infinite loops in circular re-exports
  const visitKey = memberProperty
    ? `${initialResolvedPath}::${rootText}::${memberProperty}`
    : `${initialResolvedPath}::${rootText}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  const absoluteTargetPath = path.resolve(repoRoot, initialResolvedPath);
  const targetSourceFile = getCachedSourceFile(absoluteTargetPath);
  if (!targetSourceFile) return null;

  const targetIndex = getRelationshipFileIndex(targetSourceFile);
  const memoKey =
    depth === 0
      ? `${repoRoot}::${initialResolvedPath}::${rootText}::${entityLabelPrefix}::${requireFunctionDeclaration ? 1 : 0}::${memberProperty ?? ''}`
      : null;
  if (memoKey && targetIndex.resolvedExportMemo.has(memoKey)) {
    return targetIndex.resolvedExportMemo.get(memoKey) ?? null;
  }

  const cacheAndReturn = (
    res: { targetId: string; targetEvidence: EvidenceRecord; resolvedSymbol?: string } | null
  ): { targetId: string; targetEvidence: EvidenceRecord; resolvedSymbol?: string } | null => {
    if (memoKey) {
      targetIndex.resolvedExportMemo.set(memoKey, res);
    }
    return res;
  };

  try {
    const cjsLookupName =
      memberProperty && targetIndex.symbolCandidates.has(rootText)
        ? memberProperty
        : rootText;
    const cjsResolved = resolveCjsContractInSourceFile(
      targetSourceFile,
      cjsLookupName,
      initialResolvedPath,
      repoRoot,
      workspaceRegistry,
      requireFunctionDeclaration
    );
    if (cjsResolved) return cacheAndReturn(cjsResolved);

    const candidatesForSymbol = targetIndex.symbolCandidates.get(rootText);
    if (candidatesForSymbol) {
      for (const cand of candidatesForSymbol) {
        if (cand.kind === 'namespaceExport') {
          const originResolved = resolveModulePath(
            cand.specifier,
            absoluteTargetPath,
            repoRoot,
            workspaceRegistry
          );
          if (originResolved) {
            const dotIdx = memberProperty ? memberProperty.indexOf('.') : -1;
            const lookupSymbol = memberProperty
              ? dotIdx >= 0
                ? memberProperty.slice(0, dotIdx)
                : memberProperty
              : 'default';
            const nextMemberProp =
              dotIdx >= 0 && memberProperty ? memberProperty.slice(dotIdx + 1) : undefined;
            const resolved = resolveTargetExport(
              originResolved,
              lookupSymbol,
              repoRoot,
              workspaceRegistry,
              entityLabelPrefix,
              depth + 1,
              visited,
              requireFunctionDeclaration,
              nextMemberProp
            );
            if (resolved) return cacheAndReturn(resolved);
          } else if (isExternalSpecifier(cand.specifier, absoluteTargetPath, repoRoot, workspaceRegistry)) {
            const start = cand.node.getStart(targetSourceFile);
            const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
            return cacheAndReturn({
              targetId: packageConnectorId(cand.specifier),
              targetEvidence: {
                filePath: initialResolvedPath,
                lineNumber: line + 1,
                snippet: cand.node.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                evidenceRole: 'target-signature',
              },
            });
          }
          continue;
        } else if (cand.kind === 'decl') {
          if (
            ts.isModuleDeclaration(cand.node) &&
            memberProperty &&
            cand.node.body &&
            ts.isModuleBlock(cand.node.body)
          ) {
            for (const stmt of cand.node.body.statements) {
              if (
                ts.isFunctionDeclaration(stmt) &&
                stmt.name?.text === memberProperty &&
                stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
              ) {
                const targetScope = resolveLogicalBoundaryScope(
                  initialResolvedPath,
                  repoRoot,
                  workspaceRegistry,
                  findEnclosingNamespaceScope(stmt)
                );
                const contractName = resolveExtractedContractName(
                  stmt,
                  memberProperty,
                  targetSourceFile,
                  initialResolvedPath,
                  entityLabelPrefix
                );
                const targetId = contractEntityId(targetScope, initialResolvedPath, contractName);
                const start = stmt.getStart(targetSourceFile);
                const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
                return cacheAndReturn({
                  targetId,
                  resolvedSymbol: memberProperty,
                  targetEvidence: {
                    filePath: initialResolvedPath,
                    lineNumber: line + 1,
                    snippet: stmt.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                    evidenceRole: 'target-signature',
                  },
                });
              }
            }
          }

          if (memberProperty) {
            continue;
          }

          if (requireFunctionDeclaration && !isFunctionValueDeclaration(cand.node, targetSourceFile)) {
            continue;
          }
          const targetScope = resolveLogicalBoundaryScope(
            initialResolvedPath,
            repoRoot,
            workspaceRegistry,
            findEnclosingNamespaceScope(cand.node)
          );
          const contractName = resolveExtractedContractName(
            cand.node,
            rootText,
            targetSourceFile,
            initialResolvedPath,
            entityLabelPrefix
          );
          if (
            requireFunctionDeclaration &&
            (contractName.startsWith('VALIDATOR_SCHEMA: ') || contractName.startsWith('DB_SCHEMA: '))
          ) {
            continue;
          }
          const targetId = contractEntityId(targetScope, initialResolvedPath, contractName);
          const start = cand.node.getStart(targetSourceFile);
          const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
          return cacheAndReturn({
            targetId,
            resolvedSymbol: rootText,
            targetEvidence: {
              filePath: initialResolvedPath,
              lineNumber: line + 1,
              snippet: cand.node.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
              evidenceRole: 'target-signature',
            },
          });
        } else {
          // [PAT-EXT-13] & [PAT-EXT-32] Same-file local `export { internalFn as publicFn }` without moduleSpecifier.
          // When cand.localName is an imported symbol (re-export delegation `import { x } from './m'; export { x as y }`),
          // follow the import to its origin module and recursively resolve the target export.
          const importBinding = findModuleBinding(targetSourceFile, cand.localName);
          const importDecl = targetIndex.importDeclByLocalName.get(cand.localName);
          if (importBinding || importDecl) {
            let specifier: string | null = importBinding?.moduleSpecifier ?? null;
            let lookupSymbol = cand.localName;
            let nextMemberProp = memberProperty;
            const splitNamespaceMember = (prop: string | undefined) => {
              if (!prop) return { sym: cand.localName, rest: undefined };
              const dotIdx = prop.indexOf('.');
              return dotIdx >= 0
                ? { sym: prop.slice(0, dotIdx), rest: prop.slice(dotIdx + 1) }
                : { sym: prop, rest: undefined };
            };
            if (importBinding) {
              if (
                importBinding.importedName &&
                importBinding.importedName !== '*' &&
                importBinding.importedName !== 'default'
              ) {
                lookupSymbol = importBinding.importedName;
              } else if (importBinding.importedName === 'default') {
                lookupSymbol = 'default';
              } else if (importBinding.importedName === '*' && memberProperty) {
                const split = splitNamespaceMember(memberProperty);
                lookupSymbol = split.sym;
                nextMemberProp = split.rest;
              } else {
                lookupSymbol = cand.localName;
              }
            } else if (importDecl) {
              specifier = getImportDeclarationSpecifier(importDecl);
              if (ts.isImportDeclaration(importDecl)) {
                if (importDecl.importClause?.name?.text === cand.localName) {
                  lookupSymbol = 'default';
                } else if (
                  importDecl.importClause?.namedBindings &&
                  ts.isNamedImports(importDecl.importClause.namedBindings)
                ) {
                  const el = importDecl.importClause.namedBindings.elements.find((e) => e.name.text === cand.localName);
                  if (el) {
                    lookupSymbol = (el.propertyName ?? el.name).text;
                  }
                } else if (
                  importDecl.importClause?.namedBindings &&
                  ts.isNamespaceImport(importDecl.importClause.namedBindings)
                ) {
                  if (importDecl.importClause.namedBindings.name.text === cand.localName) {
                    const split = splitNamespaceMember(memberProperty);
                    lookupSymbol = split.sym;
                    nextMemberProp = split.rest;
                  }
                }
              } else if (ts.isImportEqualsDeclaration(importDecl)) {
                const split = splitNamespaceMember(memberProperty);
                lookupSymbol = memberProperty ? split.sym : 'default';
                nextMemberProp = split.rest;
              }
            }

            if (specifier) {
              const originResolved = resolveModulePath(
                specifier,
                absoluteTargetPath,
                repoRoot,
                workspaceRegistry
              );
              if (originResolved) {
                const resolved = resolveTargetExport(
                  originResolved,
                  lookupSymbol,
                  repoRoot,
                  workspaceRegistry,
                  entityLabelPrefix,
                  depth + 1,
                  visited,
                  requireFunctionDeclaration,
                  nextMemberProp
                );
                if (resolved) return cacheAndReturn(resolved);
              } else if (isExternalSpecifier(specifier, absoluteTargetPath, repoRoot, workspaceRegistry)) {
                const start = cand.node.getStart(targetSourceFile);
                const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
                return cacheAndReturn({
                  targetId: packageConnectorId(specifier),
                  targetEvidence: {
                    filePath: initialResolvedPath,
                    lineNumber: line + 1,
                    snippet: cand.node.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                    evidenceRole: 'target-signature',
                  },
                });
              }
            }
            continue;
          }

          if (requireFunctionDeclaration && !targetIndex.localFunctionDecls.has(cand.localName)) {
            continue;
          }
          if (memberProperty) {
            const viaClassMethod = resolveClassMethodInModule(
              initialResolvedPath,
              cand.localName,
              memberProperty,
              repoRoot,
              workspaceRegistry
            );
            if (viaClassMethod) {
              return cacheAndReturn({
                ...viaClassMethod,
                resolvedSymbol: cand.localName,
              });
            }
            if (requireFunctionDeclaration) {
              continue;
            }
          }
          if (ts.isClassDeclaration(cand.node)) {
            continue;
          }
          const targetScope = resolveLogicalBoundaryScope(
            initialResolvedPath,
            repoRoot,
            workspaceRegistry,
            findEnclosingNamespaceScope(cand.node)
          );
          const contractName = resolveExtractedContractName(
            cand.node,
            rootText,
            targetSourceFile,
            initialResolvedPath,
            entityLabelPrefix
          );
          if (
            requireFunctionDeclaration &&
            (contractName.startsWith('VALIDATOR_SCHEMA: ') || contractName.startsWith('DB_SCHEMA: '))
          ) {
            continue;
          }
          const targetId = contractEntityId(targetScope, initialResolvedPath, contractName);
          const start = cand.node.getStart(targetSourceFile);
          const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
          return cacheAndReturn({
            targetId,
            resolvedSymbol: cand.localName,
            targetEvidence: {
              filePath: initialResolvedPath,
              lineNumber: line + 1,
              snippet: cand.node.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
              evidenceRole: 'target-signature',
            },
          });
        }
      }
    }

    // Fallback for default-exported named functions, HOC-wrapped functions (`export default memo(Modal)`),
    // cached functions (`export default cache(fn)` / `const fn = cache(...); export default fn`),
    // or deferred default exports (`const HomeContact = () => ...; export default HomeContact;`)
    // when the caller's local variable name (e.g. `DynamicModal`, `Contact`) differs from the target's internal name.
    if (rootText === 'default' || !requireFunctionDeclaration) {
      for (const stmt of targetSourceFile.statements) {
        if (
          ts.isFunctionDeclaration(stmt) &&
          stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
          stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
        ) {
          const targetScope = resolveLogicalBoundaryScope(
            initialResolvedPath,
            repoRoot,
            workspaceRegistry,
            findEnclosingNamespaceScope(stmt)
          );
          const contractName = stmt.name
            ? resolveExtractedContractName(
                stmt,
                stmt.name.text,
                targetSourceFile,
                initialResolvedPath,
                entityLabelPrefix
              )
            : 'Module Export (Default)';
          const targetId = contractEntityId(targetScope, initialResolvedPath, contractName);
          const start = stmt.getStart(targetSourceFile);
          const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
          return cacheAndReturn({
            targetId,
            targetEvidence: {
              filePath: initialResolvedPath,
              lineNumber: line + 1,
              snippet: stmt.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
              evidenceRole: 'target-signature',
            },
          });
        }
        if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
          if (memberProperty) {
            const viaDefaultClassMethod = resolveClassMethodInModule(
              initialResolvedPath,
              'default',
              memberProperty,
              repoRoot,
              workspaceRegistry
            );
            if (viaDefaultClassMethod) {
              return cacheAndReturn(viaDefaultClassMethod);
            }
            if (requireFunctionDeclaration) {
              continue;
            }
          }
          let isDefaultClassDecl = false;
          if (ts.isIdentifier(stmt.expression)) {
            const defaultIdent = stmt.expression.text;
            const defaultCands = targetIndex.symbolCandidates.get(defaultIdent);
            if (defaultCands) {
              for (const cand of defaultCands) {
                if (cand.kind !== 'decl') continue;
                if (ts.isClassDeclaration(cand.node)) {
                  isDefaultClassDecl = true;
                  continue;
                }
                if (requireFunctionDeclaration && !isFunctionValueDeclaration(cand.node, targetSourceFile)) continue;
                const targetScope = resolveLogicalBoundaryScope(
                  initialResolvedPath,
                  repoRoot,
                  workspaceRegistry,
                  findEnclosingNamespaceScope(cand.node)
                );
                const contractName = resolveExtractedContractName(
                  stmt,
                  defaultIdent,
                  targetSourceFile,
                  initialResolvedPath,
                  entityLabelPrefix
                );
                const targetId = contractEntityId(targetScope, initialResolvedPath, contractName);
                const start = cand.node.getStart(targetSourceFile);
                const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
                return cacheAndReturn({
                  targetId,
                  targetEvidence: {
                    filePath: initialResolvedPath,
                    lineNumber: line + 1,
                    snippet: cand.node.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                    evidenceRole: 'target-signature',
                  },
                });
              }
            }
          }
          const inner =
            unwrapWrappedFunction(stmt.expression, REACT_HOC_WRAPPERS, targetSourceFile) ??
            unwrapCachedFunctionInitializer(stmt.expression, targetSourceFile);
          const fnName =
            inner && (ts.isFunctionDeclaration(inner) || ts.isFunctionExpression(inner)) && inner.name
              ? inner.name.text
              : inner &&
                  ts.isCallExpression(stmt.expression) &&
                  stmt.expression.arguments.length > 0 &&
                  ts.isIdentifier(stmt.expression.arguments[0])
                ? stmt.expression.arguments[0].text
                : null;
          if (fnName) {
            const targetScope = resolveLogicalBoundaryScope(
              initialResolvedPath,
              repoRoot,
              workspaceRegistry,
              findEnclosingNamespaceScope(stmt)
            );
            const targetId = contractEntityId(targetScope, initialResolvedPath, `${entityLabelPrefix}: ${fnName}`);
            const start = stmt.getStart(targetSourceFile);
            const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
            return cacheAndReturn({
              targetId,
              targetEvidence: {
                filePath: initialResolvedPath,
                lineNumber: line + 1,
                snippet: stmt.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                evidenceRole: 'target-signature',
              },
            });
          }
          if (
            !isDefaultClassDecl &&
            (isFunctionLikeInitializer(stmt.expression, undefined, targetSourceFile) ||
              (!requireFunctionDeclaration && ts.isCallExpression(stmt.expression)) ||
              findCallableObjectProperty(stmt.expression, targetSourceFile) !== null ||
              (!requireFunctionDeclaration && Boolean(memberProperty)))
          ) {
            const targetScope = resolveLogicalBoundaryScope(
              initialResolvedPath,
              repoRoot,
              workspaceRegistry,
              findEnclosingNamespaceScope(stmt)
            );
            const lowerInitialPath = initialResolvedPath.toLowerCase();
            const isTargetVueFile = lowerInitialPath.endsWith('.vue');
            const isTargetSvelteFile = lowerInitialPath.endsWith('.svelte');
            const targetId = contractEntityId(
              targetScope,
              initialResolvedPath,
              isTargetVueFile
                ? deriveVueSfcComponentName(initialResolvedPath)
                : isTargetSvelteFile
                  ? deriveSvelteComponentName(initialResolvedPath)
                  : 'Module Export (Default)',
              isTargetVueFile
                ? 'contract.vue-sfc-script-setup'
                : isTargetSvelteFile
                  ? 'contract.svelte-sfc-and-sveltekit-hooks'
                  : 'contract.es6-export-default'
            );
            const start = stmt.getStart(targetSourceFile);
            const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
            return cacheAndReturn({
              targetId,
              targetEvidence: {
                filePath: initialResolvedPath,
                lineNumber: line + 1,
                snippet: stmt.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                evidenceRole: 'target-signature',
              },
            });
          }
        }
      }
    }

    const candidatePaths: Array<{ path: string; symbol: string; memberProp?: string }> = [];
    const externalWildcardReExports: Array<{ specifier: string; decl: ts.ExportDeclaration }> = [];
    for (const exportDecl of targetIndex.reExportDecls) {
      if (!exportDecl.moduleSpecifier || !ts.isStringLiteral(exportDecl.moduleSpecifier)) continue;
      if (exportDecl.isTypeOnly) continue;
      const moduleSpecifier = exportDecl.moduleSpecifier.text;
      const resolved = resolveModulePath(moduleSpecifier, absoluteTargetPath, repoRoot, workspaceRegistry);
      if (resolved) {
        if (!exportDecl.exportClause) {
          candidatePaths.push({ path: resolved, symbol: rootText, memberProp: memberProperty });
        } else if (ts.isNamespaceExport(exportDecl.exportClause)) {
          if (exportDecl.exportClause.name.text === rootText) {
            const dotIdx = memberProperty ? memberProperty.indexOf('.') : -1;
            const nextSym = memberProperty
              ? dotIdx >= 0
                ? memberProperty.slice(0, dotIdx)
                : memberProperty
              : rootText;
            const nextMemberProp =
              dotIdx >= 0 && memberProperty ? memberProperty.slice(dotIdx + 1) : undefined;
            candidatePaths.push({
              path: resolved,
              symbol: nextSym,
              memberProp: nextMemberProp,
            });
          }
        } else if (ts.isNamedExports(exportDecl.exportClause)) {
          for (const el of exportDecl.exportClause.elements) {
            if (el.isTypeOnly) continue;
            if (el.name.text === rootText || (el.propertyName && el.propertyName.text === rootText)) {
              candidatePaths.push({
                path: resolved,
                symbol: (el.propertyName ?? el.name).text,
                memberProp: memberProperty,
              });
            }
          }
        }
      } else if (isExternalSpecifier(moduleSpecifier, absoluteTargetPath, repoRoot, workspaceRegistry)) {
        if (!exportDecl.exportClause) {
          externalWildcardReExports.push({ specifier: moduleSpecifier, decl: exportDecl });
        } else if (ts.isNamespaceExport(exportDecl.exportClause)) {
          if (exportDecl.exportClause.name.text === rootText) {
            const start = exportDecl.getStart(targetSourceFile);
            const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
            return cacheAndReturn({
              targetId: packageConnectorId(moduleSpecifier),
              targetEvidence: {
                filePath: initialResolvedPath,
                lineNumber: line + 1,
                snippet: exportDecl.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                evidenceRole: 'target-signature',
              },
            });
          }
        } else if (ts.isNamedExports(exportDecl.exportClause)) {
          for (const el of exportDecl.exportClause.elements) {
            if (el.isTypeOnly) continue;
            if (el.name.text === rootText) {
              const start = el.getStart(targetSourceFile);
              const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
              return cacheAndReturn({
                targetId: packageConnectorId(moduleSpecifier),
                targetEvidence: {
                  filePath: initialResolvedPath,
                  lineNumber: line + 1,
                  snippet: exportDecl.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                  evidenceRole: 'target-signature',
                },
              });
            }
          }
        }
      }
    }

    // [PAT-EXT-29] & [PAT-EXT-31]: Follow CommonJS module-mutation mixin delegations (`require('./create')(User)`)
    if (rootText !== 'default') {
      const sfDeclIndex = getSourceFileDeclarationIndex(targetSourceFile);
      for (const mixinSpec of sfDeclIndex.cjsMixinDelegations) {
        const resolvedMixin = resolveModulePath(mixinSpec, absoluteTargetPath, repoRoot, workspaceRegistry);
        if (resolvedMixin) {
          candidatePaths.push({ path: resolvedMixin, symbol: rootText, memberProp: memberProperty });
        }
      }
    }

    // Declared nowhere in this module: backtrack through each re-export / mixin delegation until one proves the symbol.
    for (const candidate of candidatePaths) {
      const resolved = resolveTargetExport(
        candidate.path,
        candidate.symbol,
        repoRoot,
        workspaceRegistry,
        entityLabelPrefix,
        depth + 1,
        visited,
        requireFunctionDeclaration,
        candidate.memberProp
      );
      if (resolved) return cacheAndReturn(resolved);
    }

    if (externalWildcardReExports.length > 0 && rootText !== 'default') {
      const extWildcard = externalWildcardReExports[0];
      const start = extWildcard.decl.getStart(targetSourceFile);
      const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
      return cacheAndReturn({
        targetId: packageConnectorId(extWildcard.specifier),
        targetEvidence: {
          filePath: initialResolvedPath,
          lineNumber: line + 1,
          snippet: extWildcard.decl.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
          evidenceRole: 'target-signature',
        },
      });
    }

    return cacheAndReturn(null);
  } catch (e) {
    return null;
  }
}

function isSymbolDirectlyExportedInSourceFile(
  sourceFile: ts.SourceFile,
  symbolName: string
): boolean {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === symbolName) {
      if (getExportedNamesForDeclaration(stmt, symbolName, sourceFile).includes(symbolName)) {
        return true;
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbolName) {
          if (getExportedNamesForDeclaration(stmt, symbolName, sourceFile).includes(symbolName)) {
            return true;
          }
        }
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        if (!el.isTypeOnly && el.name.text === symbolName) return true;
      }
    }
  }
  return false;
}

/**
 * Resolves `objectSymbol.memberName()` when `objectSymbol` is an exported object-literal variable
 * (`export const ansi = { dim: (s) => ... }`) in `initialResolvedPath` or re-exported through a barrel.
 */
export function resolveImportedObjectMember(
  initialResolvedPath: string,
  objectSymbol: string,
  memberName: string,
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry,
  receiverSegments: readonly string[] = [],
  depth = 0,
  visited: Set<string> = new Set<string>(),
  requireFunctionDeclaration = false
): { targetId: string; targetEvidence: EvidenceRecord } | null {
  if (depth > 5) return null;
  if (receiverSegments.length > 6 || receiverSegments.includes('*')) return null;
  if (visited.has(initialResolvedPath)) return null;
  visited.add(initialResolvedPath);

  const absoluteTargetPath = path.resolve(repoRoot, initialResolvedPath);
  const targetSourceFile = getCachedSourceFile(absoluteTargetPath);
  if (!targetSourceFile) return null;

  const resolveImportedObjectPropertyDelegation = (
    rawObjExpr: ts.Expression
  ): { targetId: string; targetEvidence: EvidenceRecord } | null => {
    let objExpr = unwrapTransparentExpr(rawObjExpr);
    if (ts.isIdentifier(objExpr)) {
      const localDecl = findLocalVariableDeclaration(objExpr);
      if (localDecl?.initializer) {
        objExpr = unwrapTransparentExpr(localDecl.initializer);
      }
    }
    if (
      ts.isCallExpression(objExpr) &&
      ts.isPropertyAccessExpression(objExpr.expression) &&
      ts.isIdentifier(objExpr.expression.expression) &&
      objExpr.expression.expression.text === 'Object' &&
      (objExpr.expression.name.text === 'freeze' || objExpr.expression.name.text === 'assign')
    ) {
      for (const arg of objExpr.arguments) {
        const cand = unwrapTransparentExpr(arg);
        if (ts.isObjectLiteralExpression(cand)) {
          objExpr = cand;
          break;
        }
      }
    }
    if (!ts.isObjectLiteralExpression(objExpr)) return null;
    let targetObj: ts.ObjectLiteralExpression = objExpr;
    for (const seg of receiverSegments) {
      const outerProp = targetObj.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) &&
          ((ts.isIdentifier(p.name) && p.name.text === seg) ||
            (ts.isStringLiteral(p.name) && p.name.text === seg))
      );
      if (!outerProp) return null;
      const innerInit = unwrapTransparentExpr(outerProp.initializer);
      if (!ts.isObjectLiteralExpression(innerInit)) return null;
      targetObj = innerInit;
    }
    for (const prop of targetObj.properties) {
      let propName: string | null = null;
      let refIdent: string | null = null;
      if (ts.isShorthandPropertyAssignment(prop)) {
        propName = prop.name.text;
        refIdent = prop.name.text;
      } else if (ts.isPropertyAssignment(prop)) {
        if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
          propName = prop.name.text;
        }
        const init = unwrapTransparentExpr(prop.initializer);
        if (ts.isIdentifier(init)) {
          refIdent = init.text;
        }
      }
      if (propName === memberName && refIdent) {
        const binding = findValueModuleBinding(targetSourceFile, refIdent);
        if (binding) {
          const resolvedOrigin = resolveModulePath(
            binding.moduleSpecifier,
            absoluteTargetPath,
            repoRoot,
            workspaceRegistry
          );
          if (resolvedOrigin) {
            const originSymbol =
              binding.importedName && binding.importedName !== '*'
                ? binding.importedName
                : refIdent;
            const delegated = resolveTargetExport(
              resolvedOrigin,
              originSymbol,
              repoRoot,
              workspaceRegistry,
              'Exported Function',
              depth + 1,
              undefined,
              true
            );
            if (delegated) return delegated;
          }
        } else if (isSymbolDirectlyExportedInSourceFile(targetSourceFile, refIdent)) {
          const sameFileExported = resolveTargetExport(
            initialResolvedPath,
            refIdent,
            repoRoot,
            workspaceRegistry,
            'Exported Function',
            depth + 1,
            undefined,
            true
          );
          if (sameFileExported) return sameFileExported;
        }
      }
    }
    return null;
  };

  try {
    for (const stmt of targetSourceFile.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const directExportedNames = getExportedNamesForDeclaration(
            stmt,
            decl.name.text,
            targetSourceFile
          );
          const exportedNames = [...directExportedNames];
          const hasDefaultExport = targetSourceFile.statements.some(
            (s) =>
              ts.isExportAssignment(s) &&
              !s.isExportEquals &&
              ts.isIdentifier(s.expression) &&
              s.expression.text === decl.name.getText(targetSourceFile)
          );
          if (hasDefaultExport && !exportedNames.includes(decl.name.text)) {
            exportedNames.push(decl.name.text);
          }

          const matchedExportName = exportedNames.includes(objectSymbol)
            ? objectSymbol
            : hasDefaultExport && objectSymbol === 'default'
              ? decl.name.text
              : null;
          if (!matchedExportName) continue;

          const matchedProp =
            receiverSegments.length === 0
              ? findCallableObjectProperty(decl.initializer, targetSourceFile, memberName)
              : findNestedCallableObjectProperty(
                  decl.initializer,
                  targetSourceFile,
                  receiverSegments,
                  memberName
                );
          if (matchedProp) {
            const delegatedSameOrImported = resolveImportedObjectPropertyDelegation(decl.initializer);
            if (delegatedSameOrImported) return delegatedSameOrImported;

            const targetScope = resolveLogicalBoundaryScope(
              initialResolvedPath,
              repoRoot,
              workspaceRegistry,
              findEnclosingNamespaceScope(stmt)
            );
            const isDefaultOnlyObject =
              directExportedNames.length === 0 && hasDefaultExport && receiverSegments.length === 0;
            const contractLabel = isDefaultOnlyObject
              ? 'Module Export (Default)'
              : receiverSegments.length === 0
                ? `Exported Function: ${matchedExportName}`
                : `Exported Function: ${matchedExportName}.${receiverSegments.join('.')}.${memberName}`;
            const contractPattern = isDefaultOnlyObject
              ? 'contract.es6-export-default'
              : 'contract.exported-function';
            const targetId = contractEntityId(
              targetScope,
              initialResolvedPath,
              contractLabel,
              contractPattern
            );
            const start = matchedProp.getStart(targetSourceFile);
            const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
            return {
              targetId,
              targetEvidence: {
                filePath: initialResolvedPath,
                lineNumber: line + 1,
                snippet: matchedProp
                  .getText(targetSourceFile)
                  .slice(0, 80)
                  .replace(/\s+/g, ' ')
                  .trim(),
                evidenceRole: 'target-signature',
              },
            };
          }
          const delegatedProp = resolveImportedObjectPropertyDelegation(decl.initializer);
          if (delegatedProp) return delegatedProp;
        }
      } else if (
        ts.isExportAssignment(stmt) &&
        !stmt.isExportEquals &&
        objectSymbol === 'default'
      ) {
        const matchedProp =
          receiverSegments.length === 0
            ? findCallableObjectProperty(stmt.expression, targetSourceFile, memberName)
            : findNestedCallableObjectProperty(
                stmt.expression,
                targetSourceFile,
                receiverSegments,
                memberName
              );
        if (matchedProp) {
          const targetScope = resolveLogicalBoundaryScope(
            initialResolvedPath,
            repoRoot,
            workspaceRegistry,
            findEnclosingNamespaceScope(stmt)
          );
          const contractLabel =
            receiverSegments.length === 0
              ? `Module Export (Default)`
              : `Exported Function: default.${receiverSegments.join('.')}.${memberName}`;
          const targetId = contractEntityId(targetScope, initialResolvedPath, contractLabel);
          const start = matchedProp.getStart(targetSourceFile);
          const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
          return {
            targetId,
            targetEvidence: {
              filePath: initialResolvedPath,
              lineNumber: line + 1,
              snippet: matchedProp
                .getText(targetSourceFile)
                .slice(0, 80)
                .replace(/\s+/g, ' ')
                .trim(),
              evidenceRole: 'target-signature',
            },
          };
        }
        const delegatedDefaultProp = resolveImportedObjectPropertyDelegation(stmt.expression);
        if (delegatedDefaultProp) return delegatedDefaultProp;
      }
    }

    const candidatePaths: Array<{ path: string; symbol: string; subSegments?: readonly string[] }> = [];
    for (const stmt of targetSourceFile.statements) {
      if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        const resolved = resolveModulePath(
          stmt.moduleSpecifier.text,
          absoluteTargetPath,
          repoRoot,
          workspaceRegistry
        );
        if (resolved) {
          if (!stmt.exportClause) {
            candidatePaths.push({ path: resolved, symbol: objectSymbol });
          } else if (ts.isNamespaceExport(stmt.exportClause)) {
            if (stmt.exportClause.name.text === objectSymbol) {
              if (receiverSegments.length >= 1) {
                const subMember = resolveImportedObjectMember(
                  resolved,
                  receiverSegments[0],
                  memberName,
                  repoRoot,
                  workspaceRegistry,
                  receiverSegments.slice(1),
                  depth + 1,
                  visited,
                  requireFunctionDeclaration
                );
                if (subMember) return subMember;
              }
              const nsResolved = resolveTargetExport(
                resolved,
                memberName,
                repoRoot,
                workspaceRegistry,
                'Exported Function',
                depth + 1,
                visited,
                requireFunctionDeclaration
              );
              if (nsResolved) return nsResolved;
            }
          } else if (ts.isNamedExports(stmt.exportClause)) {
            for (const el of stmt.exportClause.elements) {
              if (el.name.text === objectSymbol) {
                candidatePaths.push({
                  path: resolved,
                  symbol: (el.propertyName ?? el.name).text,
                });
              }
            }
          }
        }
      } else if (
        ts.isExportDeclaration(stmt) &&
        !stmt.moduleSpecifier &&
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === objectSymbol) {
            const localName = (el.propertyName ?? el.name).text;
            const binding = findValueModuleBinding(targetSourceFile, localName);
            if (binding) {
              const resolved = resolveModulePath(
                binding.moduleSpecifier,
                absoluteTargetPath,
                repoRoot,
                workspaceRegistry
              );
              if (resolved) {
                if (binding.importedName === '*') {
                  if (receiverSegments.length >= 1) {
                    candidatePaths.push({
                      path: resolved,
                      symbol: receiverSegments[0],
                      subSegments: receiverSegments.slice(1),
                    });
                  } else {
                    const nsResolved = resolveTargetExport(
                      resolved,
                      memberName,
                      repoRoot,
                      workspaceRegistry,
                      'Exported Function',
                      depth + 1,
                      visited,
                      requireFunctionDeclaration
                    );
                    if (nsResolved) return nsResolved;
                  }
                } else {
                  candidatePaths.push({
                    path: resolved,
                    symbol: binding.importedName ?? localName,
                  });
                }
              }
            }
          }
        }
      }
    }

    for (const candidate of candidatePaths) {
      const resolved = resolveImportedObjectMember(
        candidate.path,
        candidate.symbol,
        memberName,
        repoRoot,
        workspaceRegistry,
        candidate.subSegments ?? receiverSegments,
        depth + 1,
        visited,
        requireFunctionDeclaration
      );
      if (resolved) return resolved;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves dynamic bracket dispatch on an exported 2-level object literal
 * (`generateMutations[orm].create(schema, driver)` where `generateMutations = { prisma: { create }, drizzle: { create } }`),
 * returning all matching branch targets so every dispatch branch receives a `CALL` edge.
 */
function resolveImportedObjectDynamicBranchMembers(
  initialResolvedPath: string,
  objectSymbol: string,
  memberName: string,
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry,
  receiverSegments: readonly string[] = ['*'],
  depth = 0,
  visited: Set<string> = new Set<string>()
): Array<{ targetId: string; targetEvidence: EvidenceRecord }> {
  if (depth > 5) return [];
  if (visited.has(initialResolvedPath)) return [];
  visited.add(initialResolvedPath);

  const absoluteTargetPath = path.resolve(repoRoot, initialResolvedPath);
  const targetSourceFile = getCachedSourceFile(absoluteTargetPath);
  if (!targetSourceFile) return [];

  const collectBranchNames = (rawObjExpr: ts.Expression): string[] => {
    let objExpr = unwrapTransparentExpr(rawObjExpr);
    if (ts.isIdentifier(objExpr)) {
      const localDecl = findLocalVariableDeclaration(objExpr);
      if (localDecl?.initializer) {
        objExpr = unwrapTransparentExpr(localDecl.initializer);
      }
    }
    if (!ts.isObjectLiteralExpression(objExpr)) return [];
    const branches: string[] = [];
    for (const prop of objExpr.properties) {
      if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        branches.push(prop.name.text);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        branches.push(prop.name.text);
      }
    }
    return branches;
  };

  const buildBranchSegmentPaths = (rawObjExpr: ts.Expression): string[][] => {
    const branchNames = collectBranchNames(rawObjExpr);
    if (branchNames.length === 0) return [];
    return branchNames.map((bn) =>
      receiverSegments.map((seg, idx) => (seg === '*' && idx === 0 ? bn : seg))
    );
  };

  const results: Array<{ targetId: string; targetEvidence: EvidenceRecord }> = [];
  const seenTargetIds = new Set<string>();

  for (const stmt of targetSourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const exportedNames = [...getExportedNamesForDeclaration(stmt, decl.name.text, targetSourceFile)];
        const hasDefaultExport = targetSourceFile.statements.some(
          (s) =>
            ts.isExportAssignment(s) &&
            !s.isExportEquals &&
            ts.isIdentifier(s.expression) &&
            s.expression.text === decl.name.getText(targetSourceFile)
        );
        if (hasDefaultExport && !exportedNames.includes(decl.name.text)) {
          exportedNames.push(decl.name.text);
        }
        const matchedExportName = exportedNames.includes(objectSymbol)
          ? objectSymbol
          : hasDefaultExport && objectSymbol === 'default'
            ? decl.name.text
            : null;
        if (!matchedExportName) continue;

        for (const segPath of buildBranchSegmentPaths(decl.initializer)) {
          const branchMatch = resolveImportedObjectMember(
            initialResolvedPath,
            objectSymbol,
            memberName,
            repoRoot,
            workspaceRegistry,
            segPath
          );
          if (branchMatch && !seenTargetIds.has(branchMatch.targetId)) {
            seenTargetIds.add(branchMatch.targetId);
            results.push(branchMatch);
          }
        }
      }
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && objectSymbol === 'default') {
      for (const segPath of buildBranchSegmentPaths(stmt.expression)) {
        const branchMatch = resolveImportedObjectMember(
          initialResolvedPath,
          'default',
          memberName,
          repoRoot,
          workspaceRegistry,
          segPath
        );
        if (branchMatch && !seenTargetIds.has(branchMatch.targetId)) {
          seenTargetIds.add(branchMatch.targetId);
          results.push(branchMatch);
        }
      }
    }
  }

  if (results.length > 0) return results;

  for (const stmt of targetSourceFile.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const resolved = resolveModulePath(
        stmt.moduleSpecifier.text,
        absoluteTargetPath,
        repoRoot,
        workspaceRegistry
      );
      if (!resolved) continue;
      if (!stmt.exportClause) {
        const sub = resolveImportedObjectDynamicBranchMembers(
          resolved,
          objectSymbol,
          memberName,
          repoRoot,
          workspaceRegistry,
          receiverSegments,
          depth + 1,
          visited
        );
        if (sub.length > 0) return sub;
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === objectSymbol) {
            const sub = resolveImportedObjectDynamicBranchMembers(
              resolved,
              (el.propertyName ?? el.name).text,
              memberName,
              repoRoot,
              workspaceRegistry,
              receiverSegments,
              depth + 1,
              visited
            );
            if (sub.length > 0) return sub;
          }
        }
      }
    }
  }

  return results;
}

function isModuleExportsRootLeft(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'exports') return true;
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports'
  ) {
    return true;
  }
  return false;
}

interface SameFileCjsExportMatch {
  declName: string;
  exportedMember: string;
  statement: ts.Statement;
}

/**
 * Inspects CommonJS export assignments in a SourceFile to locate where a local or exported
 * identifier is assigned to `module.exports`, `exports`, or an export alias.
 */
function findSameFileCjsExport(
  targetName: string,
  sourceFile: ts.SourceFile
): SameFileCjsExportMatch | null {
  const cjsAliases = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) {
          const init = unwrapTransparentExpr(d.initializer);
          if (isModuleExportsRootLeft(init)) {
            cjsAliases.add(d.name.text);
          }
        }
      }
    }
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt) && stmt.isExportEquals) {
      const unwrapped = unwrapTransparentExpr(stmt.expression);
      if (ts.isIdentifier(unwrapped) && unwrapped.text === targetName) {
        return {
          declName: targetName,
          exportedMember: 'default',
          statement: stmt,
        };
      }
    }

    if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      let cur: ts.Expression = stmt.expression;
      const lefts: ts.Expression[] = [];
      while (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        lefts.push(cur.left);
        cur = cur.right;
      }
      let rhs = unwrapTransparentExpr(cur);
      if (
        ts.isCallExpression(rhs) &&
        ts.isPropertyAccessExpression(rhs.expression) &&
        ts.isIdentifier(rhs.expression.expression) &&
        rhs.expression.expression.text === 'Object' &&
        rhs.expression.name.text === 'freeze' &&
        rhs.arguments.length > 0
      ) {
        rhs = unwrapTransparentExpr(rhs.arguments[0]);
      }

      for (const left of lefts) {
        if (isModuleExportsRootLeft(left)) {
          let objLit: ts.ObjectLiteralExpression | null = null;
          if (ts.isObjectLiteralExpression(rhs)) {
            objLit = rhs;
          } else if (ts.isIdentifier(rhs)) {
            if (rhs.text === targetName) {
              return {
                declName: targetName,
                exportedMember: 'default',
                statement: stmt,
              };
            }
            for (const s of sourceFile.statements) {
              if (ts.isVariableStatement(s)) {
                for (const d of s.declarationList.declarations) {
                  if (ts.isIdentifier(d.name) && d.name.text === rhs.text && d.initializer) {
                    const dInit = unwrapTransparentExpr(d.initializer);
                    if (ts.isObjectLiteralExpression(dInit)) {
                      objLit = dInit;
                      break;
                    }
                  }
                }
              }
              if (objLit) break;
            }
          }

          if (objLit) {
            for (const prop of objLit.properties) {
              if (ts.isShorthandPropertyAssignment(prop)) {
                if (prop.name.text === targetName) {
                  return {
                    declName: targetName,
                    exportedMember: targetName,
                    statement: stmt,
                  };
                }
              } else if (ts.isPropertyAssignment(prop)) {
                const propName =
                  ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
                    ? prop.name.text
                    : null;
                const propInit = unwrapTransparentExpr(prop.initializer);
                if (ts.isIdentifier(propInit) && propName) {
                  if (propInit.text === targetName || propName === targetName) {
                    return {
                      declName: propInit.text,
                      exportedMember: propName,
                      statement: stmt,
                    };
                  }
                }
              }
            }
          }
        }

        let memberName: string | null = null;
        if (ts.isPropertyAccessExpression(left)) {
          if (
            (ts.isIdentifier(left.expression) && left.expression.text === 'exports') ||
            (ts.isPropertyAccessExpression(left.expression) &&
              ts.isIdentifier(left.expression.expression) &&
              left.expression.expression.text === 'module' &&
              left.expression.name.text === 'exports')
          ) {
            memberName = left.name.text;
          } else if (
            ts.isIdentifier(left.expression) &&
            cjsAliases.has(left.expression.text)
          ) {
            memberName = left.name.text;
          }
        } else if (ts.isElementAccessExpression(left)) {
          if (
            (ts.isIdentifier(left.expression) && left.expression.text === 'exports') ||
            (ts.isPropertyAccessExpression(left.expression) &&
              ts.isIdentifier(left.expression.expression) &&
              left.expression.expression.text === 'module' &&
              left.expression.name.text === 'exports') ||
            (ts.isIdentifier(left.expression) && cjsAliases.has(left.expression.text))
          ) {
            if (ts.isStringLiteral(left.argumentExpression)) {
              memberName = left.argumentExpression.text;
            }
          }
        }

        if (memberName && ts.isIdentifier(rhs)) {
          if (rhs.text === targetName || memberName === targetName) {
            return {
              declName: rhs.text,
              exportedMember: memberName,
              statement: stmt,
            };
          }
        }
      }
    }
  }

  return null;
}

function parameterNameBindsIdentifier(name: ts.BindingName, targetName: string): boolean {
  if (ts.isIdentifier(name)) return name.text === targetName;
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el) && parameterNameBindsIdentifier(el.name, targetName)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolves a local identifier to an exported function Contract declared in the same SourceFile
 * (excluding recursive self-references inside the function's own body) ([PAT-EXT-21], [PAT-EXT-13]).
 */
export function resolveSameFileExportedFunction(
  localName: string,
  refNode: ts.Node,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  allowExportedObjectLiteral = false
): { targetId: string; targetEvidence: EvidenceRecord } | null {
  let declName = localName;
  let exportedAlias: string | null = null;
  let defaultExportStmt: ts.ExportAssignment | null = null;

  for (const s of sourceFile.statements) {
    if (
      ts.isExportDeclaration(s) &&
      !s.moduleSpecifier &&
      s.exportClause &&
      ts.isNamedExports(s.exportClause)
    ) {
      for (const el of s.exportClause.elements) {
        const orig = (el.propertyName ?? el.name).text;
        if (orig === localName || el.name.text === localName) {
          declName = orig;
          exportedAlias = el.name.text;
          break;
        }
      }
    }
    if (exportedAlias) break;
  }

  if (!exportedAlias) {
    for (const s of sourceFile.statements) {
      if (ts.isExportAssignment(s) && !s.isExportEquals && ts.isIdentifier(s.expression) && s.expression.text === localName) {
        defaultExportStmt = s;
        break;
      }
    }
  }

  let cjsExportedMember: string | null = null;
  let cjsExportStmt: ts.Statement | null = null;

  if (!exportedAlias && !defaultExportStmt) {
    const cjsExport = findSameFileCjsExport(localName, sourceFile);
    if (cjsExport) {
      declName = cjsExport.declName;
      cjsExportedMember = cjsExport.exportedMember;
      cjsExportStmt = cjsExport.statement;
    }
  }

  let matchingStmt: ts.Statement | null = null;
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === declName) {
      matchingStmt = stmt;
      if (stmt.body) break;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === declName &&
          decl.initializer &&
          (isFunctionValueDeclaration(decl, sourceFile) ||
            (allowExportedObjectLiteral &&
              ts.isObjectLiteralExpression(unwrapTransparentExpr(decl.initializer))))
        ) {
          matchingStmt = stmt;
          break;
        }
      }
      if (matchingStmt) break;
    }
  }
  if (!matchingStmt) return null;

  // Exclude self-calls / references inside the function's own declaration or its export assignment,
  // or when shadowed by an enclosing function parameter of the same name.
  for (let cur: ts.Node | undefined = refNode.parent; cur; cur = cur.parent) {
    if (
      cur === matchingStmt ||
      (defaultExportStmt && cur === defaultExportStmt) ||
      (cjsExportStmt && cur === cjsExportStmt)
    ) {
      return null;
    }
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur)
    ) {
      for (const param of cur.parameters) {
        if (parameterNameBindsIdentifier(param.name, localName)) {
          return null;
        }
      }
    }
  }

  let exportedName: string | null = exportedAlias;
  let sharedVarHelperPatternId: string | undefined;
  if (
    !exportedName &&
    ts.canHaveModifiers(matchingStmt) &&
    ts.getModifiers(matchingStmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    exportedName = declName;
  } else if (
    !exportedName &&
    !defaultExportStmt &&
    !cjsExportedMember &&
    ts.isVariableStatement(matchingStmt) &&
    isSharedModuleScopedVarFunctionHelper(matchingStmt, declName, sourceFile)
  ) {
    exportedName = declName;
    sharedVarHelperPatternId = 'contract.module-scoped-var-function-helper';
  }

  const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;

  if (exportedName || defaultExportStmt) {
    const targetScope = resolveLogicalBoundaryScope(
      relPath,
      repoRoot,
      workspaceRegistry,
      findEnclosingNamespaceScope(matchingStmt)
    );
    const contractName = exportedName
      ? resolveExtractedContractName(
          matchingStmt,
          exportedName,
          sourceFile,
          relPath,
          'Exported Function'
        )
      : resolveExtractedContractName(
          defaultExportStmt!,
          ts.isIdentifier(defaultExportStmt!.expression) ? 'default' : declName,
          sourceFile,
          relPath,
          'Exported Function'
        );
    const targetId = contractEntityId(
      targetScope,
      relPath,
      contractName,
      sharedVarHelperPatternId
    );
    const start = matchingStmt.getStart(sourceFile);
    const { line: targetLine } = sourceFile.getLineAndCharacterOfPosition(start);
    return {
      targetId,
      targetEvidence: {
        filePath: relPath,
        lineNumber: targetLine + 1,
        snippet: matchingStmt.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
        evidenceRole: 'target-signature',
      },
    };
  }

  if (!cjsExportedMember) {
    const cjsExport = findSameFileCjsExport(declName, sourceFile);
    if (cjsExport) {
      cjsExportedMember = cjsExport.exportedMember;
    }
  }

  if (cjsExportedMember) {
    const cjsTarget = resolveCjsContractInSourceFile(
      sourceFile,
      cjsExportedMember,
      relPath,
      repoRoot,
      workspaceRegistry
    );
    if (cjsTarget) {
      return {
        targetId: cjsTarget.targetId,
        targetEvidence: cjsTarget.targetEvidence,
      };
    }
  }

  return null;
}

interface ResolvedLocalFromCall {
  targetId: string | undefined;
  targetEvidence?: EvidenceRecord;
  declLine: number;
  declSnippet: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'INFERRED';
}

function unwrapTransparentExpr(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Verifies that a symbol resolved via `resolveTargetExport` corresponds to an extracted CONTRACT
 * (or BOUNDARY) in `res.targetEvidence.filePath`, or traces unextracted factory variable exports
 * (`export const { useTRPC } = createTRPCContext()`, `export const authClient = createAuthClient()`,
 * `const fn = () => {}; export default fn`) to their underlying `Module Export (Default)` or
 * external-package `OPEN_CONNECTOR`.
 */
function verifyOrTraceResolvedExport(
  res: { targetId: string; targetEvidence: EvidenceRecord; resolvedSymbol?: string } | null,
  symbolName: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  memberPropertyName?: string,
  depth = 0
): { targetId: string; targetEvidence?: EvidenceRecord; confidence: 'HIGH' | 'MEDIUM' } | null {
  if (!res || depth > 4) return null;
  const relFile = res.targetEvidence.filePath;
  const targetSf = getCachedSourceFile(path.resolve(repoRoot, relFile));
  if (!targetSf) return { ...res, confidence: 'HIGH' };

  const targetSymbol = res.resolvedSymbol ?? symbolName;
  const candidates = getRelationshipFileIndex(targetSf).symbolCandidates.get(targetSymbol);
  if (!candidates || candidates.length === 0) {
    return { ...res, confidence: 'HIGH' };
  }

  let sawVariableDecl = false;
  for (const cand of candidates) {
    if (cand.kind !== 'decl') continue;
    if (ts.isClassDeclaration(cand.node) && cand.node.name) {
      const targetScope = resolveLogicalBoundaryScope(
        relFile,
        repoRoot,
        workspaceRegistry,
        findEnclosingNamespaceScope(cand.node)
      );
      return {
        targetId: boundaryEntityId(targetScope, relFile, `Class: ${cand.node.name.text}`),
        targetEvidence: res.targetEvidence,
        confidence: 'HIGH',
      };
    }
    if (ts.isVariableDeclaration(cand.node)) {
      sawVariableDecl = true;
      const stmt =
        cand.node.parent &&
        ts.isVariableDeclarationList(cand.node.parent) &&
        cand.node.parent.parent &&
        ts.isVariableStatement(cand.node.parent.parent)
          ? cand.node.parent.parent
          : cand.node;
      const fileRole = classifyNextjsFile(relFile);
      const extracted = visitContract(
        stmt,
        targetSf,
        () => ({ filePath: relFile, lineNumber: 1, snippet: '' }),
        () => '',
        fileRole,
        relFile
      );
      const entities = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
      const contractEntity = entities.find(
        (e) =>
          e.type === 'CONTRACT' &&
          (e.name.endsWith(`: ${targetSymbol}`) ||
            e.name.endsWith(`: ${symbolName}`) ||
            e.name === 'Module Export (Default)')
      );
      if (contractEntity) {
        const targetScope = resolveLogicalBoundaryScope(
          relFile,
          repoRoot,
          workspaceRegistry,
          findEnclosingNamespaceScope(cand.node)
        );
        return {
          targetId: contractEntityId(
            targetScope,
            relFile,
            contractEntity.name,
            contractEntity.patternId
          ),
          targetEvidence: res.targetEvidence,
          confidence: 'HIGH',
        };
      }

      // Check if the variable is an exported class singleton (`export const sdkActionManager = new SdkActionManager()`)
      const singletonClass =
        classNameFromTypeOrNew(cand.node.initializer) ?? classNameFromTypeOrNew(cand.node.type);
      if (singletonClass) {
        if (memberPropertyName) {
          const viaMethod = resolveClassMethodInModule(
            relFile,
            targetSymbol,
            memberPropertyName,
            repoRoot,
            workspaceRegistry
          );
          if (viaMethod) {
            return {
              targetId: viaMethod.targetId,
              targetEvidence: viaMethod.targetEvidence,
              confidence: 'HIGH',
            };
          }
        }
        const viaBoundary = resolveClassBoundaryInModule(
          relFile,
          targetSymbol,
          repoRoot,
          workspaceRegistry,
          0,
          new Set(),
          true
        );
        if (viaBoundary) {
          return {
            targetId: viaBoundary.targetId,
            targetEvidence: viaBoundary.targetEvidence,
            confidence: 'HIGH',
          };
        }
      }

      // Check if default-exported via `export default <ident>`
      if (ts.isIdentifier(cand.node.name)) {
        const localIdent = cand.node.name.text;
        const hasDefaultExport = targetSf.statements.some(
          (s) =>
            ts.isExportAssignment(s) &&
            !s.isExportEquals &&
            ts.isIdentifier(s.expression) &&
            s.expression.text === localIdent
        );
        if (hasDefaultExport) {
          const targetScope = resolveLogicalBoundaryScope(
            relFile,
            repoRoot,
            workspaceRegistry,
            findEnclosingNamespaceScope(cand.node)
          );
          return {
            targetId: contractEntityId(targetScope, relFile, 'Module Export (Default)', 'contract.es6-export-default'),
            targetEvidence: res.targetEvidence,
            confidence: 'HIGH',
          };
        }
      }

      // Trace initializer to an external package or intra-repo factory function
      if (cand.node.initializer) {
        const extTarget = resolveExternalPackageTarget(
          cand.node.initializer,
          targetSf,
          repoRoot,
          workspaceRegistry
        );
        if (extTarget) {
          return {
            targetId: extTarget,
            targetEvidence: res.targetEvidence,
            confidence: 'MEDIUM',
          };
        }

        let initExpr = unwrapTransparentExpr(cand.node.initializer);
        if (ts.isAwaitExpression(initExpr)) {
          initExpr = unwrapTransparentExpr(initExpr.expression);
        }
        if (ts.isCallExpression(initExpr)) {
          if (memberPropertyName) {
            const viaFactoryMethod = resolveClassMethodInModule(
              relFile,
              targetSymbol,
              memberPropertyName,
              repoRoot,
              workspaceRegistry
            );
            if (viaFactoryMethod) {
              return {
                targetId: viaFactoryMethod.targetId,
                targetEvidence: viaFactoryMethod.targetEvidence,
                confidence: 'HIGH',
              };
            }
          }
          let calleeExpr = unwrapTransparentExpr(initExpr.expression);
          while (ts.isCallExpression(calleeExpr)) {
            calleeExpr = unwrapTransparentExpr(calleeExpr.expression);
          }
          const calleeIdent = getChainRootIdentifierNode(calleeExpr);
          if (calleeIdent) {
            const sameFileFn = resolveSameFileExportedFunction(
              calleeIdent.text,
              calleeIdent,
              targetSf,
              repoRoot,
              workspaceRegistry
            );
            if (sameFileFn) {
              return {
                targetId: sameFileFn.targetId,
                targetEvidence: sameFileFn.targetEvidence,
                confidence: 'HIGH',
              };
            }
            const calleeBinding = findValueModuleBinding(targetSf, calleeIdent.text);
            if (calleeBinding) {
              const calleePath = resolveModulePath(
                calleeBinding.moduleSpecifier,
                targetSf.fileName,
                repoRoot,
                workspaceRegistry
              );
              if (calleePath) {
                const calleeLookup =
                  calleeBinding.importedName &&
                  calleeBinding.importedName !== '*' &&
                  calleeBinding.importedName !== 'default'
                    ? calleeBinding.importedName
                    : calleeIdent.text;
                const rawCalleeExport =
                  resolveTargetExport(
                    calleePath,
                    calleeLookup,
                    repoRoot,
                    workspaceRegistry ?? {},
                    'Exported Function'
                  ) ??
                  (calleeBinding.importedName === 'default'
                    ? resolveTargetExport(
                        calleePath,
                        'default',
                        repoRoot,
                        workspaceRegistry ?? {},
                        'Exported Function'
                      )
                    : null);
                const tracedCallee = verifyOrTraceResolvedExport(
                  rawCalleeExport,
                  calleeLookup,
                  repoRoot,
                  workspaceRegistry,
                  undefined,
                  depth + 1
                );
                if (tracedCallee) {
                  return tracedCallee;
                }
              }
            }
          }
        }
      }
    }
  }

  if (sawVariableDecl) return null;
  return { ...res, confidence: 'HIGH' };
}

/**
 * Resolves a two-step factory invocation (`const handler = getMiddleware(); handler(req, res);`,
 * `const handler = toNextJsHandler(auth); handler.GET(req);`, or
 * `const auth = betterAuth(...); auth.api.createOrganization(...)`)
 * to its underlying Contract or Open Connector target (`sk1/CALL/LocalFromCall/*`, [PAT-EXT-16]).
 *
 * Deterministically traces the local variable's CallExpression initializer:
 * 1. If the callee is `require('pkg')` or imported from an external package, resolves to `Package: <pkg>`.
 * 2. If the callee is an imported or same-file function Contract, resolves to that Contract.
 * 3. Populates evidence showing both the call site and the factory variable declaration.
 *
 * @param identNode - Identifier being called or accessed (e.g. `handler` or `auth`).
 * @param callNode - Enclosing CallExpression (e.g. `handler(req, res)` or `handler.GET(req)`).
 * @param sourceFile - SourceFile AST.
 * @param repoRoot - Repository root directory path.
 * @param workspaceRegistry - Workspace package map for monorepo path resolution.
 * @param depth - Recursion depth for multi-hop local factory chains.
 * @returns Resolved target ID, evidence, status, and confidence, or null if not a factory-return call.
 */
function resolveLocalFromCallTarget(
  identNode: ts.Identifier,
  callNode: ts.CallExpression,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  depth = 0
): ResolvedLocalFromCall | null {
  if (depth > 5) return null;

  // Built-in collection / primitive prototype methods (`.filter()`, `.map()`, `.join()`,
  // `.toLowerCase()`, `.split()`, `.push()`, `.forEach()`, etc.) operate on a returned value
  // in memory and are NOT structural invocations of a returned service/factory instance.
  const callMemberAccess = getPropertyOrElementAccess(callNode.expression);
  if (callMemberAccess) {
    if (
      BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(callMemberAccess.memberName) ||
      (BUILTIN_DOM_ITERATOR_REFLECTION_METHODS.has(callMemberAccess.memberName) &&
        callMemberAccess.memberName !== 'apply' &&
        callMemberAccess.memberName !== 'call' &&
        callMemberAccess.memberName !== 'bind') ||
      callMemberAccess.memberName === 'partial' ||
      callMemberAccess.memberName === 'deepPartial' ||
      callMemberAccess.memberName === 'pick' ||
      callMemberAccess.memberName === 'omit' ||
      callMemberAccess.memberName === 'extend' ||
      callMemberAccess.memberName === 'merge' ||
      callMemberAccess.memberName === 'passthrough' ||
      callMemberAccess.memberName === 'strict' ||
      callMemberAccess.memberName === 'strip' ||
      callMemberAccess.memberName === 'catchall' ||
      callMemberAccess.memberName === 'optional' ||
      callMemberAccess.memberName === 'nullable' ||
      callMemberAccess.memberName === 'nullish' ||
      callMemberAccess.memberName === 'transform' ||
      callMemberAccess.memberName === 'default' ||
      callMemberAccess.memberName === 'describe' ||
      callMemberAccess.memberName === 'readonly' ||
      callMemberAccess.memberName === 'brand' ||
      callMemberAccess.memberName === 'refine' ||
      callMemberAccess.memberName === 'superRefine' ||
      callMemberAccess.memberName === 'route' ||
      callMemberAccess.memberName === 'notFound' ||
      callMemberAccess.memberName === 'onError' ||
      callMemberAccess.memberName === 'openapi' ||
      callMemberAccess.memberName === 'doc'
    ) {
      return null;
    }
    let recvCur: ts.Expression = callMemberAccess.expression;
    while (ts.isPropertyAccessExpression(recvCur) || ts.isElementAccessExpression(recvCur)) {
      if (
        ts.isElementAccessExpression(recvCur) &&
        (!recvCur.argumentExpression ||
          (!ts.isStringLiteral(recvCur.argumentExpression) &&
            !ts.isNoSubstitutionTemplateLiteral(recvCur.argumentExpression)))
      ) {
        return null;
      }
      recvCur = recvCur.expression;
    }
  }
  const isAmbiguousCollectionMethod = Boolean(
    callMemberAccess &&
      (BUILTIN_VALUE_PROTOTYPE_METHODS.has(callMemberAccess.memberName) ||
        callMemberAccess.memberName === 'listen' ||
        callMemberAccess.memberName === 'unsubscribe')
  );
  if (isAmbiguousCollectionMethod) {
    if (
      ts.isPropertyAccessExpression(callMemberAccess!.expression) ||
      ts.isElementAccessExpression(callMemberAccess!.expression) ||
      ts.isCallExpression(unwrapTransparentExpr(callMemberAccess!.expression)) ||
      callMemberAccess!.memberName === 'has' ||
      callMemberAccess!.memberName === 'add' ||
      callMemberAccess!.memberName === 'clear' ||
      callMemberAccess!.memberName === 'listen' ||
      callMemberAccess!.memberName === 'unsubscribe'
    ) {
      return null;
    }
  }

  const decl = findLocalVariableOrBindingDeclaration(identNode);
  if (!decl || !decl.initializer) {
    const sfIndex = getSourceFileDeclarationIndex(sourceFile);
    const localFnDecl = sfIndex.functionDeclsByName.get(identNode.text);
    const isDirectLocalCall =
      depth === 0 &&
      callMemberAccess === null &&
      !ts.isCallExpression(unwrapTransparentExpr(callNode.expression));
    if (localFnDecl && !isDirectLocalCall && !isAmbiguousCollectionMethod) {
      for (let cur: ts.Node | undefined = callNode.parent; cur; cur = cur.parent) {
        if (cur === localFnDecl) return null;
      }
      const fnStart = localFnDecl.getStart(sourceFile);
      const { line: fnLine } = sourceFile.getLineAndCharacterOfPosition(fnStart);
      const fnSnippet = localFnDecl.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim();
      const returnedClass = findReturnedNewClassName(localFnDecl);
      if (returnedClass) {
        if (sfIndex.topLevelClassNames.has(returnedClass)) {
          const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
          const scope = resolveLogicalBoundaryScope(relPath, repoRoot, workspaceRegistry);
          return {
            targetId: boundaryEntityId(scope, relPath, `Class: ${returnedClass}`),
            declLine: fnLine + 1,
            declSnippet: fnSnippet,
            confidence: 'HIGH',
            status: 'INFERRED',
          };
        }
        const clsBinding = findModuleBinding(sourceFile, returnedClass);
        if (clsBinding) {
          if (isExternalSpecifier(clsBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
            return {
              targetId: packageConnectorId(clsBinding.moduleSpecifier),
              declLine: fnLine + 1,
              declSnippet: fnSnippet,
              confidence: 'MEDIUM',
              status: 'INFERRED',
            };
          }
          const clsPath = resolveModulePath(
            clsBinding.moduleSpecifier,
            sourceFile.fileName,
            repoRoot,
            workspaceRegistry
          );
          if (clsPath) {
            const clsScope = resolveLogicalBoundaryScope(clsPath, repoRoot, workspaceRegistry);
            return {
              targetId: boundaryEntityId(clsScope, clsPath, `Class: ${returnedClass}`),
              declLine: fnLine + 1,
              declSnippet: fnSnippet,
              confidence: 'HIGH',
              status: 'INFERRED',
            };
          }
        }
      }
      if (localFnDecl.body) {
        const returnExprs: ts.Expression[] = [];
        if (!ts.isBlock(localFnDecl.body)) {
          returnExprs.push(localFnDecl.body);
        } else {
          const scanRet = (n: ts.Node) => {
            if (
              n !== localFnDecl.body &&
              (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))
            ) {
              return;
            }
            if (ts.isReturnStatement(n) && n.expression) {
              returnExprs.push(n.expression);
            }
            ts.forEachChild(n, scanRet);
          };
          scanRet(localFnDecl.body);
        }
        for (const rawRet of returnExprs) {
          let retExpr = unwrapTransparentExpr(rawRet);
          if (ts.isAwaitExpression(retExpr)) retExpr = unwrapTransparentExpr(retExpr.expression);
          if (callMemberAccess && ts.isObjectLiteralExpression(retExpr)) {
            const chainProps: string[] = [callMemberAccess.memberName];
            let recvWalk: ts.Expression = unwrapTransparentExpr(callMemberAccess.expression);
            while (ts.isPropertyAccessExpression(recvWalk) || ts.isElementAccessExpression(recvWalk)) {
              const acc = getPropertyOrElementAccess(recvWalk);
              if (!acc) break;
              chainProps.unshift(acc.memberName);
              recvWalk = unwrapTransparentExpr(acc.expression);
            }
            let curObj: ts.ObjectLiteralExpression | null = retExpr;
            let leafInit: ts.Expression | null = null;
            for (let i = 0; i < chainProps.length && curObj; i++) {
              const seg = chainProps[i];
              const prop: ts.ObjectLiteralElementLike | undefined = curObj.properties.find(
                (p): p is ts.ObjectLiteralElementLike =>
                  (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                  (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
                  p.name.text === seg
              );
              if (!prop) {
                curObj = null;
                break;
              }
              const propExpr: ts.Expression = ts.isShorthandPropertyAssignment(prop)
                ? prop.name
                : unwrapTransparentExpr((prop as ts.PropertyAssignment).initializer);
              if (i === chainProps.length - 1) {
                leafInit = propExpr;
              } else if (ts.isObjectLiteralExpression(propExpr)) {
                curObj = propExpr;
              } else {
                curObj = null;
              }
            }
            if (leafInit && ts.isIdentifier(leafInit)) {
              const sameFileFn = resolveSameFileExportedFunction(
                leafInit.text,
                leafInit,
                sourceFile,
                repoRoot,
                workspaceRegistry
              );
              if (sameFileFn) {
                return {
                  targetId: sameFileFn.targetId,
                  targetEvidence: sameFileFn.targetEvidence,
                  declLine: fnLine + 1,
                  declSnippet: fnSnippet,
                  confidence: 'HIGH',
                  status: 'INFERRED',
                };
              }
              const leafBinding = findValueModuleBinding(sourceFile, leafInit.text);
              if (leafBinding) {
                const leafPath = resolveModulePath(
                  leafBinding.moduleSpecifier,
                  sourceFile.fileName,
                  repoRoot,
                  workspaceRegistry
                );
                if (leafPath) {
                  const leafLookup =
                    leafBinding.importedName &&
                    leafBinding.importedName !== '*' &&
                    leafBinding.importedName !== 'default'
                      ? leafBinding.importedName
                      : leafInit.text;
                  const verifiedLeaf = verifyOrTraceResolvedExport(
                    resolveTargetExport(leafPath, leafLookup, repoRoot, workspaceRegistry ?? {}, 'Exported Function'),
                    leafLookup,
                    repoRoot,
                    workspaceRegistry
                  );
                  if (verifiedLeaf) {
                    return {
                      targetId: verifiedLeaf.targetId,
                      targetEvidence: verifiedLeaf.targetEvidence,
                      declLine: fnLine + 1,
                      declSnippet: fnSnippet,
                      confidence: verifiedLeaf.confidence,
                      status: 'INFERRED',
                    };
                  }
                }
              }
            }
          }
          if (callMemberAccess && (ts.isCallExpression(retExpr) || ts.isIdentifier(retExpr))) {
            const retCallee = ts.isCallExpression(retExpr)
              ? getChainRootIdentifierNode(retExpr.expression)
              : retExpr;
            if (retCallee) {
              const sameFileRet = resolveSameFileExportedFunction(
                retCallee.text,
                retCallee,
                sourceFile,
                repoRoot,
                workspaceRegistry
              );
              if (sameFileRet) {
                return {
                  targetId: sameFileRet.targetId,
                  targetEvidence: sameFileRet.targetEvidence,
                  declLine: fnLine + 1,
                  declSnippet: fnSnippet,
                  confidence: 'HIGH',
                  status: 'INFERRED',
                };
              }
              const retBinding = findValueModuleBinding(sourceFile, retCallee.text);
              if (retBinding) {
                if (
                  isExternalSpecifier(retBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
                ) {
                  return {
                    targetId: packageConnectorId(retBinding.moduleSpecifier),
                    declLine: fnLine + 1,
                    declSnippet: fnSnippet,
                    confidence: 'MEDIUM',
                    status: 'INFERRED',
                  };
                }
                const retPath = resolveModulePath(
                  retBinding.moduleSpecifier,
                  sourceFile.fileName,
                  repoRoot,
                  workspaceRegistry
                );
                if (retPath) {
                  const retLookup =
                    retBinding.importedName &&
                    retBinding.importedName !== '*' &&
                    retBinding.importedName !== 'default'
                      ? retBinding.importedName
                      : retCallee.text;
                  const verifiedRet = verifyOrTraceResolvedExport(
                    resolveTargetExport(retPath, retLookup, repoRoot, workspaceRegistry ?? {}, 'Exported Function'),
                    retLookup,
                    repoRoot,
                    workspaceRegistry
                  );
                  if (verifiedRet) {
                    return {
                      targetId: verifiedRet.targetId,
                      targetEvidence: verifiedRet.targetEvidence,
                      declLine: fnLine + 1,
                      declSnippet: fnSnippet,
                      confidence: verifiedRet.confidence,
                      status: 'INFERRED',
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
    return null;
  }

  const declStart = decl.getStart(sourceFile);
  const { line: declLine } = sourceFile.getLineAndCharacterOfPosition(declStart);
  const declSnippet = decl.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim();

  let init: ts.Expression = unwrapTransparentExpr(decl.initializer);
  const wasAwaitedInit = ts.isAwaitExpression(init);
  if (wasAwaitedInit) init = unwrapTransparentExpr((init as ts.AwaitExpression).expression);

  if (wasAwaitedInit && ts.isIdentifier(init)) {
    const awaitedIdent = init;
    const awaitedBinding = findValueModuleBinding(sourceFile, awaitedIdent.text);
    if (awaitedBinding) {
      if (isExternalSpecifier(awaitedBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
        return {
          targetId: packageConnectorId(awaitedBinding.moduleSpecifier),
          declLine: declLine + 1,
          declSnippet,
          confidence: 'MEDIUM',
          status: 'INFERRED',
        };
      }
      const resolvedPath = resolveModulePath(
        awaitedBinding.moduleSpecifier,
        sourceFile.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedPath) {
        const lookupSymbol =
          awaitedBinding.importedName && awaitedBinding.importedName !== '*'
            ? awaitedBinding.importedName
            : 'default';
        const res = resolveTargetExport(
          resolvedPath,
          lookupSymbol,
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function'
        );
        if (res) {
          return {
            targetId: res.targetId,
            targetEvidence: res.targetEvidence,
            declLine: declLine + 1,
            declSnippet,
            confidence: 'HIGH',
            status: 'INFERRED',
          };
        }
      }
    }
    const sameFileAwaited = resolveSameFileExportedFunction(
      awaitedIdent.text,
      awaitedIdent,
      sourceFile,
      repoRoot,
      workspaceRegistry
    );
    if (sameFileAwaited) {
      return {
        targetId: sameFileAwaited.targetId,
        targetEvidence: sameFileAwaited.targetEvidence,
        declLine: declLine + 1,
        declSnippet,
        confidence: 'HIGH',
        status: 'INFERRED',
      };
    }
  }

  if (isBindWrappedLocalExpression(init)) {
    return null;
  }
  const unwrappedFnWrapper = unwrapTransparentFunctionWrapperCall(init);
  if (unwrappedFnWrapper) {
    init = unwrapTransparentExpr(unwrappedFnWrapper);
  }
  const unwrappedReqFromWrapper = unwrapRequire(init);
  if (unwrappedReqFromWrapper) {
    if (
      isExternalSpecifier(
        unwrappedReqFromWrapper.specifier,
        sourceFile.fileName,
        repoRoot,
        workspaceRegistry
      )
    ) {
      return {
        targetId: packageConnectorId(unwrappedReqFromWrapper.specifier),
        declLine: declLine + 1,
        declSnippet,
        confidence: 'MEDIUM',
        status: 'INFERRED',
      };
    }
  }

  if (
    ts.isNewExpression(init) &&
    ts.isIdentifier(init.expression) &&
    init.expression.text === 'Function' &&
    !callMemberAccess
  ) {
    if (
      callNode.arguments.length >= 1 &&
      (ts.isStringLiteral(callNode.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(callNode.arguments[0]))
    ) {
      const dynSpec = callNode.arguments[0].text.trim();
      const declStart = decl.getStart(sourceFile);
      const { line: declLine } = sourceFile.getLineAndCharacterOfPosition(declStart);
      const declSnippet = decl.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim();
      if (dynSpec && isExternalSpecifier(dynSpec, sourceFile.fileName, repoRoot, workspaceRegistry)) {
        return {
          targetId: packageConnectorId(dynSpec),
          declLine: declLine + 1,
          declSnippet,
          confidence: 'HIGH',
          status: 'INFERRED',
        };
      }
      if (dynSpec) {
        const resolvedDyn = resolveModulePath(dynSpec, sourceFile.fileName, repoRoot, workspaceRegistry);
        if (resolvedDyn) {
          const verifiedDyn = verifyOrTraceResolvedExport(
            resolveTargetExport(resolvedDyn, 'default', repoRoot, workspaceRegistry ?? {}, 'Exported Function'),
            'default',
            repoRoot,
            workspaceRegistry
          );
          if (verifiedDyn) {
            return {
              targetId: verifiedDyn.targetId,
              targetEvidence: verifiedDyn.targetEvidence,
              declLine: declLine + 1,
              declSnippet,
              confidence: verifiedDyn.confidence,
              status: 'INFERRED',
            };
          }
        }
      }
    }
    const relFile = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
    const logicalScope = resolveLogicalBoundaryScope(relFile, repoRoot, workspaceRegistry);
    return {
      targetId: stableEntityId(logicalScope, 'OPEN_CONNECTOR', 'Dynamic Execution: new Function'),
      declLine: declLine + 1,
      declSnippet,
      confidence: 'HIGH',
      status: 'INFERRED',
    };
  }

  if (!ts.isCallExpression(init)) return null;

  // HOC-wrapped components, cached/memoized functions (`cache(fn)`, `React.cache(fn)`, `memo(fn)`),
  // and React hooks (`useCallback(fn)`, `useMemo(fn)`, `useState(...)`) are local declarations,
  // not factory invocations.
  if (
    isReactHookCall(init) ||
    unwrapWrappedFunction(init, REACT_HOC_WRAPPERS, sourceFile) !== null ||
    unwrapCachedFunctionInitializer(init, sourceFile) !== null
  ) {
    return null;
  }

  // Direct require('pkg') is classified as LocalRequire, not a factory invocation
  if (ts.isIdentifier(init.expression) && init.expression.text === 'require') {
    return null;
  }

  if (
    callMemberAccess &&
    ts.isIdentifier(decl.name) &&
    decl.parent &&
    ts.isVariableDeclarationList(decl.parent) &&
    decl.parent.parent &&
    ts.isVariableStatement(decl.parent.parent)
  ) {
    const relFile = path.relative(repoRoot, sourceFile.fileName).replace(/\\/g, '/') || sourceFile.fileName;
    const extracted = visitContract(
      decl.parent.parent,
      sourceFile,
      () => ({ filePath: relFile, lineNumber: declLine + 1, snippet: declSnippet }),
      () => '',
      classifyNextjsFile(relFile),
      relFile
    );
    const declNameText = decl.name.text;
    const entities = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
    const validatorContract = entities.find(
      (e) => e.type === 'CONTRACT' && e.name === `VALIDATOR_SCHEMA: ${declNameText}`
    );
    if (validatorContract) {
      const targetScope = resolveLogicalBoundaryScope(
        relFile,
        repoRoot,
        workspaceRegistry,
        findEnclosingNamespaceScope(decl)
      );
      return {
        targetId: contractEntityId(
          targetScope,
          relFile,
          validatorContract.name,
          validatorContract.patternId
        ),
        declLine: declLine + 1,
        declSnippet,
        confidence: 'HIGH',
        status: 'INFERRED',
      };
    }
  }

  // 1. Direct or curried require(...)() or require(...).member()
  const req = unwrapRequire(init);
  if (req) {
    if (isExternalSpecifier(req.specifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
      return {
        targetId: packageConnectorId(req.specifier),
        declLine: declLine + 1,
        declSnippet,
        confidence: 'MEDIUM',
        status: 'INFERRED',
      };
    }
    const resolvedPath = resolveModulePath(req.specifier, sourceFile.fileName, repoRoot, workspaceRegistry);
    if (resolvedPath && !isAmbiguousCollectionMethod) {
      const lookupSymbol = req.member ?? 'default';
      const verified = verifyOrTraceResolvedExport(
        resolveTargetExport(resolvedPath, lookupSymbol, repoRoot, workspaceRegistry ?? {}, 'Exported Function'),
        lookupSymbol,
        repoRoot,
        workspaceRegistry
      );
      if (verified) {
        return {
          targetId: verified.targetId,
          targetEvidence: verified.targetEvidence,
          declLine: declLine + 1,
          declSnippet,
          confidence: verified.confidence,
          status: 'INFERRED',
        };
      }
    }
  }

  // 2. Unwrap any chained calls to find the root callee (e.g. factory()())
  let callee: ts.Expression = unwrapTransparentExpr(init.expression);
  while (ts.isCallExpression(callee)) {
    callee = unwrapTransparentExpr(callee.expression);
  }

  // Case 2a: Identifier callee: const x = factory();
  if (ts.isIdentifier(callee)) {
    let factoryName = callee.text;

    // Check if imported from external package or local module (or parameter default `fn = importedFactory`)
    let binding = findValueModuleBinding(sourceFile, factoryName);
    if (!binding) {
      for (let cur: ts.Node | undefined = callee.parent; cur; cur = cur.parent) {
        if (
          ts.isFunctionDeclaration(cur) ||
          ts.isFunctionExpression(cur) ||
          ts.isArrowFunction(cur) ||
          ts.isMethodDeclaration(cur)
        ) {
          for (const param of cur.parameters) {
            if (
              ts.isIdentifier(param.name) &&
              param.name.text === factoryName &&
              param.initializer &&
              ts.isIdentifier(param.initializer)
            ) {
              factoryName = param.initializer.text;
              binding = findValueModuleBinding(sourceFile, factoryName);
              break;
            }
          }
          if (binding) break;
        }
      }
    }
    if (binding) {
      if (isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
        return {
          targetId: packageConnectorId(binding.moduleSpecifier),
          declLine: declLine + 1,
          declSnippet,
          confidence: 'MEDIUM',
          status: 'INFERRED',
        };
      }
      const resolvedPath = resolveModulePath(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry);
      if (resolvedPath && !isAmbiguousCollectionMethod) {
        const lookupSymbol =
          binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
            ? binding.importedName
            : factoryName;
        const rawResolved =
          resolveTargetExport(resolvedPath, lookupSymbol, repoRoot, workspaceRegistry ?? {}, 'Exported Function') ??
          (binding.importedName === 'default'
            ? resolveTargetExport(resolvedPath, 'default', repoRoot, workspaceRegistry ?? {}, 'Exported Function')
            : null);
        const verified = verifyOrTraceResolvedExport(
          rawResolved,
          lookupSymbol,
          repoRoot,
          workspaceRegistry
        );
        if (verified) {
          return {
            targetId: verified.targetId,
            targetEvidence: verified.targetEvidence,
            declLine: declLine + 1,
            declSnippet,
            confidence: verified.confidence,
            status: 'INFERRED',
          };
        }
      }
    }

    // Check same-file exported function
    if (!isAmbiguousCollectionMethod) {
      const sameFileTarget = resolveSameFileExportedFunction(
        factoryName,
        callee,
        sourceFile,
        repoRoot,
        workspaceRegistry
      );
      if (sameFileTarget) {
        return {
          targetId: sameFileTarget.targetId,
          targetEvidence: sameFileTarget.targetEvidence,
          declLine: declLine + 1,
          declSnippet,
          confidence: 'HIGH',
          status: 'INFERRED',
        };
      }
    }

    // Check same-file unexported helper function (e.g. `function createProject() { return new Project(); }`)
    const sfIndex = getSourceFileDeclarationIndex(sourceFile);
    const localFnDecl = sfIndex.functionDeclsByName.get(factoryName);
    if (localFnDecl) {
      const returnedClass = findReturnedNewClassName(localFnDecl);
      if (returnedClass) {
        if (sfIndex.topLevelClassNames.has(returnedClass)) {
          const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
          const scope = resolveLogicalBoundaryScope(relPath, repoRoot, workspaceRegistry);
          return {
            targetId: boundaryEntityId(scope, relPath, `Class: ${returnedClass}`),
            declLine: declLine + 1,
            declSnippet,
            confidence: 'HIGH',
            status: 'INFERRED',
          };
        }
        const clsBinding = findModuleBinding(sourceFile, returnedClass);
        if (clsBinding) {
          if (isExternalSpecifier(clsBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
            return {
              targetId: packageConnectorId(clsBinding.moduleSpecifier),
              declLine: declLine + 1,
              declSnippet,
              confidence: 'MEDIUM',
              status: 'INFERRED',
            };
          }
          const clsPath = resolveModulePath(
            clsBinding.moduleSpecifier,
            sourceFile.fileName,
            repoRoot,
            workspaceRegistry
          );
          if (clsPath) {
            const clsScope = resolveLogicalBoundaryScope(clsPath, repoRoot, workspaceRegistry);
            return {
              targetId: boundaryEntityId(clsScope, clsPath, `Class: ${returnedClass}`),
              declLine: declLine + 1,
              declSnippet,
              confidence: 'HIGH',
              status: 'INFERRED',
            };
          }
        }
      }

      if (localFnDecl.body) {
        if (!ts.isBlock(localFnDecl.body)) {
          const ext = resolveExternalPackageTarget(localFnDecl.body, sourceFile, repoRoot, workspaceRegistry);
          if (ext) {
            return {
              targetId: ext,
              declLine: declLine + 1,
              declSnippet,
              confidence: 'MEDIUM',
              status: 'INFERRED',
            };
          }
        } else {
          let bodyExt: string | undefined;
          const scanReturn = (n: ts.Node) => {
            if (bodyExt) return;
            if (
              n !== localFnDecl.body &&
              (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))
            ) {
              return;
            }
            if (ts.isReturnStatement(n) && n.expression) {
              bodyExt = resolveExternalPackageTarget(n.expression, sourceFile, repoRoot, workspaceRegistry);
              if (bodyExt) return;
            }
            ts.forEachChild(n, scanReturn);
          };
          scanReturn(localFnDecl.body);
          if (bodyExt) {
            return {
              targetId: bodyExt,
              declLine: declLine + 1,
              declSnippet,
              confidence: 'MEDIUM',
              status: 'INFERRED',
            };
          }
        }
      }
    }

    // Check if `callee` itself is a LocalFromCall variable (`const f1 = getFactory(); const f2 = f1(); f2.run()`)
    const chainedCallee = resolveLocalFromCallTarget(
      callee,
      init,
      sourceFile,
      repoRoot,
      workspaceRegistry,
      depth + 1
    );
    if (chainedCallee && chainedCallee.targetId) {
      return {
        ...chainedCallee,
        declLine: declLine + 1,
        declSnippet,
      };
    }
  }

  // Case 2b: Property or Element access callee: const x = obj.factory();
  const access = getPropertyOrElementAccess(callee);
  if (access) {
    const publicMethodOnInit = resolvePublicMethodTarget(init, sourceFile, repoRoot, workspaceRegistry);
    if (publicMethodOnInit) {
      if (callMemberAccess) {
        const siblingMethod = resolvePublicMethodTarget(
          init,
          sourceFile,
          repoRoot,
          workspaceRegistry,
          { overrideMethodName: callMemberAccess.memberName }
        );
        if (!siblingMethod) return null;
        return {
          targetId: siblingMethod,
          declLine: declLine + 1,
          declSnippet,
          confidence: 'HIGH',
          status: 'INFERRED',
        };
      }
      return {
        targetId: publicMethodOnInit,
        declLine: declLine + 1,
        declSnippet,
        confidence: 'HIGH',
        status: 'INFERRED',
      };
    }

    const rootIdentNode = getChainRootIdentifierNode(access.expression);
    const rootIdent = rootIdentNode?.text ?? null;
    if (rootIdent) {
      const binding = findModuleBinding(sourceFile, rootIdent);
      if (binding) {
        if (isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
          if (
            DI_CONTAINER_PACKAGES.has(binding.moduleSpecifier) ||
            (access.memberName === 'bind' &&
              (binding.moduleSpecifier === 'underscore' || binding.moduleSpecifier === 'lodash'))
          ) {
            const extFromType = resolveExternalPackageTarget(identNode, sourceFile, repoRoot, workspaceRegistry);
            if (extFromType) {
              return {
                targetId: extFromType,
                declLine: declLine + 1,
                declSnippet,
                confidence: 'MEDIUM',
                status: 'INFERRED',
              };
            }
            return null;
          }
          return {
            targetId: packageConnectorId(binding.moduleSpecifier),
            declLine: declLine + 1,
            declSnippet,
            confidence: 'MEDIUM',
            status: 'INFERRED',
          };
        }
        const resolvedPath = resolveModulePath(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry);
        if (resolvedPath) {
          const lookupSymbol =
            binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
              ? binding.importedName
              : rootIdent;
          const targetMemberName = callMemberAccess ? callMemberAccess.memberName : access.memberName;
          const objMember =
            binding.importedName !== '*'
              ? resolveImportedObjectMember(
                  resolvedPath,
                  lookupSymbol,
                  targetMemberName,
                  repoRoot,
                  workspaceRegistry ?? {}
                )
              : null;
          if (objMember) {
            return {
              targetId: objMember.targetId,
              targetEvidence: objMember.targetEvidence,
              declLine: declLine + 1,
              declSnippet,
              confidence: 'HIGH',
              status: 'INFERRED',
            };
          }

          if (!callMemberAccess || callMemberAccess.memberName === access.memberName) {
            const verifiedMember = verifyOrTraceResolvedExport(
              resolveTargetExport(resolvedPath, access.memberName, repoRoot, workspaceRegistry ?? {}, 'Exported Function'),
              access.memberName,
              repoRoot,
              workspaceRegistry
            );
            if (verifiedMember) {
              return {
                targetId: verifiedMember.targetId,
                targetEvidence: verifiedMember.targetEvidence,
                declLine: declLine + 1,
                declSnippet,
                confidence: verifiedMember.confidence,
                status: 'INFERRED',
              };
            }
          }

          if (binding.importedName !== '*') {
            const isClassReceiver =
              Boolean(callMemberAccess && callMemberAccess.memberName !== access.memberName) &&
              resolveClassBoundaryInModule(
                resolvedPath,
                lookupSymbol,
                repoRoot,
                workspaceRegistry,
                0,
                new Set(),
                true
              ) !== null;
            const verifiedObj = verifyOrTraceResolvedExport(
              resolveTargetExport(
                resolvedPath,
                lookupSymbol,
                repoRoot,
                workspaceRegistry ?? {},
                'Exported Function',
                0,
                undefined,
                false,
                targetMemberName
              ) ??
                (!isClassReceiver
                  ? resolveTargetExport(
                      resolvedPath,
                      lookupSymbol,
                      repoRoot,
                      workspaceRegistry ?? {},
                      'Exported Function'
                    )
                  : null),
              lookupSymbol,
              repoRoot,
              workspaceRegistry,
              targetMemberName
            );
            if (verifiedObj) {
              return {
                targetId: verifiedObj.targetId,
                targetEvidence: verifiedObj.targetEvidence,
                declLine: declLine + 1,
                declSnippet,
                confidence: verifiedObj.confidence,
                status: 'INFERRED',
              };
            }
          }
        }
      } else if (rootIdentNode) {
        // Multi-hop local variable chain: `const project = createProject(); const source = project.addSourceFileAtPath(...); source.saveSync()`
        const chainedReceiver = resolveLocalFromCallTarget(
          rootIdentNode,
          init,
          sourceFile,
          repoRoot,
          workspaceRegistry,
          depth + 1
        );
        if (chainedReceiver && chainedReceiver.targetId) {
          return {
            ...chainedReceiver,
            declLine: declLine + 1,
            declSnippet,
          };
        }

        const sameFileObj = resolveSameFileExportedFunction(
          rootIdent,
          rootIdentNode,
          sourceFile,
          repoRoot,
          workspaceRegistry
        );
        if (sameFileObj) {
          return {
            targetId: sameFileObj.targetId,
            targetEvidence: sameFileObj.targetEvidence,
            declLine: declLine + 1,
            declSnippet,
            confidence: 'HIGH',
            status: 'INFERRED',
          };
        }

        const declaredType = getSourceFileDeclarationIndex(sourceFile).classByIdentifier.get(rootIdent);
        if (declaredType) {
          const typeBinding = findModuleBinding(sourceFile, declaredType);
          const typeImpDecl = getRelationshipFileIndex(sourceFile).importDeclByLocalName.get(declaredType);
          const isTypeOnlyImport =
            Boolean(typeBinding?.isTypeOnly) ||
            (typeImpDecl !== undefined &&
              ts.isImportDeclaration(typeImpDecl) &&
              Boolean(typeImpDecl.importClause?.isTypeOnly));
          if (
            typeBinding &&
            !isTypeOnlyImport &&
            isExternalSpecifier(typeBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry) &&
            !DI_CONTAINER_PACKAGES.has(typeBinding.moduleSpecifier)
          ) {
            return {
              targetId: packageConnectorId(typeBinding.moduleSpecifier),
              declLine: declLine + 1,
              declSnippet,
              confidence: 'MEDIUM',
              status: 'INFERRED',
            };
          }
        }
      }
    }
  }

  // Fallback: check resolveExternalPackageTarget on init
  const externalTarget = resolveExternalPackageTarget(init, sourceFile, repoRoot, workspaceRegistry);
  if (externalTarget) {
    return {
      targetId: externalTarget,
      declLine: declLine + 1,
      declSnippet,
      confidence: 'MEDIUM',
      status: 'INFERRED',
    };
  }

  // Honest unknown: LocalFromCall confirmed by AST, but callee is unexported or unresolvable
  return {
    targetId: undefined,
    declLine: declLine + 1,
    declSnippet,
    confidence: 'LOW',
    status: 'INFERRED',
  };
}

function unwrapFallbackIdentifier(ident: ts.Identifier, fromNode: ts.Node): ts.Identifier {
  const paramDefault = findEnclosingParameterDefaultIdentifier(fromNode, ident.text);
  if (paramDefault) return paramDefault;
  const decl = findLocalVariableDeclaration(ident);
  if (decl?.initializer) {
    const unwrapped = unwrapTransparentExpr(decl.initializer);
    if (ts.isIdentifier(unwrapped)) return unwrapped;
    if (
      ts.isBinaryExpression(unwrapped) &&
      (unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      const right = unwrapTransparentExpr(unwrapped.right);
      if (ts.isIdentifier(right)) return right;
      const left = unwrapTransparentExpr(unwrapped.left);
      if (ts.isIdentifier(left)) return left;
    }
  }
  return ident;
}

/**
 * Resolves a function identifier passed as a higher-order callback argument or registered in an
 * object dispatch table to its target `EXPORTED_FUNCTION` Contract ([PAT-EXT-15]).
 */
function resolveFunctionContractReference(
  rawIdent: ts.Identifier,
  refNode: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): { targetId: string; evidences: EvidenceRecord[] } | null {
  const ident = unwrapFallbackIdentifier(rawIdent, refNode);
  if (ident === rawIdent) {
    for (let cur: ts.Node | undefined = refNode.parent; cur && cur !== sourceFile; cur = cur.parent) {
      if (
        ts.isFunctionDeclaration(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isArrowFunction(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isConstructorDeclaration(cur)
      ) {
        for (const param of cur.parameters) {
          if (parameterNameBindsIdentifier(param.name, rawIdent.text) && !param.initializer) {
            return null;
          }
        }
      }
      if (ts.isBlock(cur)) {
        for (const stmt of cur.statements) {
          if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
              if (parameterNameBindsIdentifier(decl.name, rawIdent.text)) {
                return null;
              }
            }
          }
        }
      }
    }
  }
  const fnName = ident.text;
  if (fnName === 'require' || HTTP_CLIENT_IDENTIFIERS.has(fnName) || DB_CLIENT_IDENTIFIERS.has(fnName)) {
    return null;
  }

  const callEvidence = { ...getEvidence(refNode), evidenceRole: 'syntax-call' as const };

  const candidateImport = getRelationshipFileIndex(sourceFile).importDeclByLocalName.get(fnName) ?? null;
  const isImportDecl = candidateImport && ts.isImportDeclaration(candidateImport);
  const isImportEquals = candidateImport && ts.isImportEqualsDeclaration(candidateImport);
  const matchingImport =
    isImportDecl &&
    candidateImport.importClause &&
    ((candidateImport.importClause.name && candidateImport.importClause.name.text === fnName) ||
      (candidateImport.importClause.namedBindings &&
        ts.isNamedImports(candidateImport.importClause.namedBindings)))
      ? candidateImport
      : isImportEquals
        ? candidateImport
        : null;

  const importLiteral = getImportDeclarationSpecifier(matchingImport);
  if (matchingImport && importLiteral) {
    const resolvedPath = resolveModulePath(importLiteral, sourceFile.fileName, repoRoot, workspaceRegistry);
    if (!resolvedPath) return null;

    const binding = findValueModuleBinding(sourceFile, fnName);
    const lookupSymbol =
      binding?.importedName && binding.importedName !== 'default' && binding.importedName !== '*'
        ? binding.importedName
        : fnName;

    const res =
      resolveTargetExport(
        resolvedPath,
        lookupSymbol,
        repoRoot,
        workspaceRegistry ?? {},
        'Exported Function',
        0,
        new Set(),
        true
      ) ??
      (binding?.importedName === 'default'
        ? resolveTargetExport(
            resolvedPath,
            'default',
            repoRoot,
            workspaceRegistry ?? {},
            'Exported Function',
            0,
            new Set(),
            true
          )
        : null);
    if (!res) return null;

    const importStart = matchingImport.getStart(sourceFile);
    const { line: importLine } = sourceFile.getLineAndCharacterOfPosition(importStart);
    return {
      targetId: res.targetId,
      evidences: [
        callEvidence,
        {
          filePath: callEvidence.filePath,
          lineNumber: importLine + 1,
          snippet: matchingImport.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
          evidenceRole: 'import-match',
        },
        res.targetEvidence,
      ],
    };
  }

  const reqBinding = findValueModuleBinding(sourceFile, fnName);
  if (reqBinding && reqBinding.kind === 'require') {
    if (isExternalSpecifier(reqBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
      return null;
    }
    const resolvedReqPath = resolveModulePath(
      reqBinding.moduleSpecifier,
      sourceFile.fileName,
      repoRoot,
      workspaceRegistry
    );
    if (!resolvedReqPath) return null;

    const lookupSymbol =
      reqBinding.importedName && reqBinding.importedName !== '*'
        ? reqBinding.importedName
        : 'default';

    const res = resolveTargetExport(
      resolvedReqPath,
      lookupSymbol,
      repoRoot,
      workspaceRegistry ?? {},
      'Exported Function',
      0,
      new Set(),
      true
    );
    if (!res) return null;

    const evidences: EvidenceRecord[] = [callEvidence];
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        const matchesDecl =
          (ts.isIdentifier(decl.name) && decl.name.text === fnName) ||
          (ts.isObjectBindingPattern(decl.name) &&
            decl.name.elements.some(
              (el) => ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === fnName
            ));
        if (matchesDecl) {
          const reqStart = decl.getStart(sourceFile);
          const { line: reqLine } = sourceFile.getLineAndCharacterOfPosition(reqStart);
          evidences.push({
            filePath: callEvidence.filePath,
            lineNumber: reqLine + 1,
            snippet: decl.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
            evidenceRole: 'import-match',
          });
          break;
        }
      }
    }
    evidences.push(res.targetEvidence);
    return {
      targetId: res.targetId,
      evidences,
    };
  }

  const sameFile = resolveSameFileExportedFunction(fnName, refNode, sourceFile, repoRoot, workspaceRegistry);
  if (sameFile) {
    return {
      targetId: sameFile.targetId,
      evidences: [callEvidence, sameFile.targetEvidence],
    };
  }

  return null;
}

function resolveDefaultExportedModuleContractReference(
  ident: ts.Identifier,
  refNode: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): { targetId: string; evidences: EvidenceRecord[] } | null {
  const binding = findValueModuleBinding(sourceFile, ident.text);
  if (
    !binding ||
    binding.importedName !== 'default' ||
    isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
  ) {
    return null;
  }
  const resolvedPath = resolveModulePath(
    binding.moduleSpecifier,
    sourceFile.fileName,
    repoRoot,
    workspaceRegistry
  );
  if (!resolvedPath || resolvedPath.endsWith('.json')) return null;

  const targetSf = getCachedSourceFile(path.resolve(repoRoot, resolvedPath));
  if (!targetSf) return null;

  for (const stmt of targetSf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (
        ts.isIdentifier(stmt.expression) &&
        getSourceFileDeclarationIndex(targetSf).topLevelClassNames.has(stmt.expression.text)
      ) {
        return null;
      }
      const extracted = visitContract(
        stmt,
        targetSf,
        () => ({ filePath: resolvedPath, lineNumber: 1, snippet: '' }),
        () => '',
        classifyNextjsFile(resolvedPath),
        resolvedPath
      );
      const entities = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
      const modEntity = entities.find(
        (e) => e.type === 'CONTRACT' && e.entityType === 'EXPORTED_MODULE'
      );
      if (modEntity) {
        const targetScope = resolveLogicalBoundaryScope(
          resolvedPath,
          repoRoot,
          workspaceRegistry,
          findEnclosingNamespaceScope(stmt)
        );
        const targetId = contractEntityId(
          targetScope,
          resolvedPath,
          modEntity.name,
          modEntity.patternId
        );
        const start = stmt.getStart(targetSf);
        const { line } = targetSf.getLineAndCharacterOfPosition(start);
        return {
          targetId,
          evidences: [
            { ...getEvidence(refNode), evidenceRole: 'syntax-call' as const },
            {
              filePath: resolvedPath,
              lineNumber: line + 1,
              snippet: stmt.getText(targetSf).slice(0, 80).replace(/\s+/g, ' ').trim(),
              evidenceRole: 'target-signature',
            },
          ],
        };
      }
    }
  }
  return null;
}

function findEnclosingParameterDefaultIdentifier(fromNode: ts.Node, paramName: string): ts.Identifier | null {
  if (ts.isCallExpression(fromNode) && ts.isIdentifier(fromNode.expression)) {
    const localDecl = findLocalVariableDeclaration(fromNode.expression);
    if (localDecl?.initializer) {
      const init = unwrapTransparentExpr(localDecl.initializer);
      if (
        ts.isBinaryExpression(init) &&
        (init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          init.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        const rightUnwrapped = unwrapTransparentExpr(init.right);
        if (ts.isIdentifier(rightUnwrapped)) {
          return rightUnwrapped;
        }
      }
    }
  }
  for (let cur: ts.Node | undefined = fromNode.parent; cur; cur = cur.parent) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isConstructorDeclaration(cur)
    ) {
      for (const param of cur.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === paramName && param.initializer) {
          const unwrapped = unwrapTransparentExpr(param.initializer);
          if (ts.isIdentifier(unwrapped)) {
            return unwrapped;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Inspects a single AST node and returns RELATIONSHIP entities if it matches a known dependency pattern.
 *
 * Ontology v4.0 (Ephemeral Code): relationships never point at files. `import` / `require`
 * statements emit NO relationship (the external package becomes an OPEN_CONNECTOR node, see
 * `openConnectorVisitor.ts`); a relationship targets the Contract, Class member or Open Connector
 * the AST proves is addressed, and is left unresolved otherwise.
 *
 * Currently handled patterns:
 * - Express Router Mounts      (delegated to `extractExpressRouterMount`; MOUNTS target the mounted module's export)
 * - Prototypal Inheritance     (`Object.create(...)`, `Object.setPrototypeOf(...)`) → external package connector
 * - Prototype Mixins           (`Object.assign(app, EventEmitter.prototype)`) → external package connector
 * - Payload config registry / plugin / hook registrations (delegated to the payload adapter).
 *   `buildConfig(...)` additionally yields its own `Call:` edge.
 * - Inferred Method / Function Calls with 3-tier confidence classification:
 *   - HIGH:   Root identifier matches a local import AND the target exported symbol is verified.
 *   - MEDIUM: Root identifier matches a local import, but the target export cannot be verified (or is external).
 *   - LOW:    Root identifier does not match any local module import.
 *   Targets: verified export Contract, PUBLIC_METHOD (deterministic receiver class), or `Package: X`.
 * - JSX component composition (`<Component />` → `Renders`).
 *
 * Evidence chaining:
 * - Populates multiple EvidenceRecords (`syntax-call`, `import-match`, `target-signature`) for verified inferred relationships.
 *
 * @param node        The AST node to inspect.
 * @param sourceFile  Required to extract the module specifier text.
 * @param getEvidence Returns a populated EvidenceRecord for the given node.
 * @param nextId      Placeholder closure — replaced by stableEntityId() in the orchestrator.
 * @param repoRoot    The repository root for path resolution (defaults to empty string).
 * @param sourceId    Placeholder source — the orchestrator resolves the real owner (Contract / Class / INIT_BLOCK).
 * @param workspaceRegistry Optional registry of monorepo workspace packages.
 * @returns A StructuralEntity (or array) or null if the node does not match any RELATIONSHIP pattern.
 */
export function visitRelationship(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string = '',
  sourceId: string = '',
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | StructuralEntity[] | null {
  const payloadRegistry = extractPayloadConfigRegistry(node, sourceFile, getEvidence, nextId);
  if (!payloadRegistry) {
    return visitCallLikeRelationship(node, sourceFile, getEvidence, nextId, repoRoot, sourceId, workspaceRegistry);
  }

  // `buildConfig({...})` is a call into the `payload` package AND registers collections/plugins:
  // keep the registry entries and also fall through to the generic call edge.
  for (const entry of payloadRegistry) {
    if (entry.entityType === 'PLUGIN_REGISTRATION') {
      // `plugins: [seoPlugin(...)]` — the plugin factory's origin is the import binding of its name.
      const binding = findValueModuleBinding(sourceFile, stripPayloadPluginPrefix(entry.name));
      if (binding && isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
        entry.targetId = packageConnectorId(binding.moduleSpecifier);
      }
    }
  }
  const callEdge = visitCallLikeRelationship(node, sourceFile, getEvidence, nextId, repoRoot, sourceId, workspaceRegistry);
  const extra = Array.isArray(callEdge) ? callEdge : (callEdge ? [callEdge] : []);
  return [...payloadRegistry, ...extra];
}

function isUseContextCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression) && node.expression.text === 'useContext') {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'React' &&
    node.expression.name.text === 'useContext'
  ) {
    return true;
  }
  return false;
}

function extractCallbackArgumentEdges(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity[] {
  const edges: StructuralEntity[] = [];
  const isContextRead = isUseContextCall(node);
  const flatArgs: ts.Expression[] = [];
  for (const rawArg of node.arguments) {
    if (ts.isArrayLiteralExpression(rawArg)) {
      for (const el of rawArg.elements) {
        if (!ts.isSpreadElement(el) && !ts.isOmittedExpression(el)) {
          flatArgs.push(el);
        }
      }
    } else {
      flatArgs.push(rawArg);
    }
  }
  for (const arg of flatArgs) {
    if (ts.isIdentifier(arg)) {
      const ref = resolveFunctionContractReference(
        arg,
        node,
        sourceFile,
        getEvidence,
        repoRoot,
        workspaceRegistry
      );
      if (ref) {
        if (isContextRead) {
          edges.push({
            id: nextId(),
            name: `References: ${arg.text}`,
            type: 'RELATIONSHIP',
            entityType: 'REFERENCES',
            patternId: 'relationship.ExportedConstantReference',
            sourceId,
            targetId: ref.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: ref.evidences,
          });
        } else {
          edges.push({
            id: nextId(),
            name: `Call: ${arg.text}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.callback-reference',
            sourceId,
            targetId: ref.targetId,
            status: 'INFERRED',
            confidence: 'HIGH',
            evidence: ref.evidences,
          });
        }
      } else {
        const modRef = resolveDefaultExportedModuleContractReference(
          arg,
          node,
          sourceFile,
          getEvidence,
          repoRoot,
          workspaceRegistry
        );
        if (modRef) {
          edges.push({
            id: nextId(),
            name: `References: ${arg.text}`,
            type: 'RELATIONSHIP',
            entityType: 'REFERENCES',
            patternId: 'relationship.ExportedConstantReference',
            sourceId,
            targetId: modRef.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: modRef.evidences,
          });
        }
      }
    } else if (ts.isPropertyAccessExpression(arg)) {
      const propName = arg.name.text;
      if (ts.isIdentifier(arg.expression)) {
        const objIdent = arg.expression;
        const binding = findValueModuleBinding(sourceFile, objIdent.text);
        if (
          binding &&
          !isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
        ) {
          const resolvedPath = resolveModulePath(
            binding.moduleSpecifier,
            sourceFile.fileName,
            repoRoot,
            workspaceRegistry
          );
          if (resolvedPath && !resolvedPath.endsWith('.json')) {
            const absTargetPath = path.resolve(repoRoot, resolvedPath);
            const targetSf = getCachedSourceFile(absTargetPath);
            const cjsMatch = targetSf
              ? resolveCjsContractInSourceFile(
                  targetSf,
                  propName,
                  resolvedPath,
                  repoRoot,
                  workspaceRegistry,
                  true
                )
              : null;
            const lookupSymbol =
              binding.importedName &&
              binding.importedName !== '*' &&
              binding.importedName !== 'default'
                ? binding.importedName
                : objIdent.text;
            const resolved = cjsMatch
              ? cjsMatch.patternId === 'contract.commonjs-export'
                ? cjsMatch
                : null
              : resolveImportedObjectMember(
                  resolvedPath,
                  lookupSymbol,
                  propName,
                  repoRoot,
                  workspaceRegistry ?? {},
                  [],
                  0,
                  new Set<string>(),
                  true
                ) ??
                (binding.importedName === 'default'
                  ? resolveImportedObjectMember(
                      resolvedPath,
                      'default',
                      propName,
                      repoRoot,
                      workspaceRegistry ?? {},
                      [],
                      0,
                      new Set<string>(),
                      true
                    )
                  : null) ??
                (binding.importedName === '*'
                  ? resolveTargetExport(
                      resolvedPath,
                      propName,
                      repoRoot,
                      workspaceRegistry ?? {},
                      'Exported Function',
                      0,
                      undefined,
                      true
                    )
                  : null);
            if (resolved) {
              const callEvidence = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
              const evidences: EvidenceRecord[] = [callEvidence];
              const reqDecl = findLocalVariableDeclaration(objIdent);
              if (reqDecl) {
                const reqStart = reqDecl.getStart(sourceFile);
                const { line: reqLine } = sourceFile.getLineAndCharacterOfPosition(reqStart);
                evidences.push({
                  filePath: callEvidence.filePath,
                  lineNumber: reqLine + 1,
                  snippet: reqDecl.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                  evidenceRole: 'import-match',
                });
              }
              evidences.push(resolved.targetEvidence);
              edges.push({
                id: nextId(),
                name: `Call: ${objIdent.text}.${propName}()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL',
                patternId: 'relationship.callback-reference',
                sourceId,
                targetId: resolved.targetId,
                status: 'INFERRED',
                confidence: 'HIGH',
                evidence: evidences,
              });
              continue;
            }
          }
        }
      }
      const syntheticCall = { ...node, expression: arg, parent: node.parent } as ts.CallExpression;
      const publicMethodTarget = resolvePublicMethodTarget(
        syntheticCall,
        sourceFile,
        repoRoot,
        workspaceRegistry,
        { localOnly: true }
      );
      if (publicMethodTarget) {
        const callEvidence = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
        edges.push({
          id: nextId(),
          name: `Call: ${arg.getText(sourceFile)}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.callback-reference',
          sourceId,
          targetId: publicMethodTarget,
          status: 'INFERRED',
          confidence: 'HIGH',
          evidence: [callEvidence],
        });
      }
    }
  }
  return edges;
}

/**
 * Call-, mount-, hook- and JSX-shaped relationship detection (everything except the payload config
 * registry, which `visitRelationship` composes with the generic call edge).
 */
function visitCallLikeRelationship(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | StructuralEntity[] | null {
  const payloadHooks = extractPayloadHooks(node, sourceFile, getEvidence, nextId);
  if (payloadHooks) return payloadHooks;

  const honoOrForEachMount = extractHonoOrForEachRouterMount(
    node,
    sourceFile,
    getEvidence,
    nextId,
    repoRoot,
    sourceId,
    workspaceRegistry
  );
  if (honoOrForEachMount) return honoOrForEachMount;

  const expressMount = extractExpressRouterMount(node, sourceFile, getEvidence, nextId, sourceId, {
    routerMount: (callNode) => resolveRouterMountTarget(callNode, sourceFile, repoRoot, workspaceRegistry),
  });
  if (expressMount) {
    if (ts.isCallExpression(node)) {
      const callbackEdges = extractCallbackArgumentEdges(
        node,
        sourceFile,
        getEvidence,
        nextId,
        repoRoot,
        sourceId,
        workspaceRegistry
      ).filter((e) => e.targetId !== expressMount.targetId);
      if (callbackEdges.length > 0) {
        return [expressMount, ...callbackEdges];
      }
    }
    return expressMount;
  }

  const expressRouteMiddlewares = extractExpressRouteMiddleware(node, sourceFile, getEvidence, nextId, sourceId);
  if (expressRouteMiddlewares && expressRouteMiddlewares.length > 0) {
    // `app.get('/p', mw, handler)` is also an ordinary call of `app.get` — the AST contains it,
    // so the graph does too (same as a route registered without middleware).
    const callEdge = withCallShapeKey(
      visitInferredCallRelationship(node, sourceFile, getEvidence, nextId, repoRoot, sourceId, workspaceRegistry),
      node,
      { repoRoot, workspaceRegistry }
    );
    const extra = Array.isArray(callEdge) ? callEdge : (callEdge ? [callEdge] : []);
    const callbackEdges = ts.isCallExpression(node)
      ? extractCallbackArgumentEdges(node, sourceFile, getEvidence, nextId, repoRoot, sourceId, workspaceRegistry)
      : [];

    if (ts.isCallExpression(node)) {
      const relFileIndex = getRelationshipFileIndex(sourceFile);
      for (const mwEdge of expressRouteMiddlewares) {
        const arrowIdx = mwEdge.name.indexOf(' -> ');
        const targetLabel = arrowIdx >= 0 ? mwEdge.name.slice(arrowIdx + 4) : '';
        const matchedCb = callbackEdges.find(
          (cb) =>
            cb.targetId &&
            (cb.name === `Call: ${targetLabel}()` ||
              (targetLabel && cb.name.endsWith(`.${targetLabel}()`)))
        );
        if (matchedCb?.targetId) {
          mwEdge.targetId = matchedCb.targetId;
          continue;
        }
        if (mwEdge.patternId === HTTP_ROUTE_HANDLER_EDGE_PATTERN_ID) {
          const lastArg = node.arguments[node.arguments.length - 1];
          let resolvedHandlerTarget: string | undefined;
          if (lastArg && ts.isCallExpression(lastArg)) {
            if (ts.isIdentifier(lastArg.expression)) {
              const ref = resolveFunctionContractReference(
                lastArg.expression,
                node,
                sourceFile,
                getEvidence,
                repoRoot,
                workspaceRegistry
              );
              resolvedHandlerTarget =
                ref?.targetId ??
                resolveExternalPackageTarget(lastArg.expression, sourceFile, repoRoot, workspaceRegistry);
            } else {
              resolvedHandlerTarget = resolveExternalPackageTarget(
                lastArg.expression,
                sourceFile,
                repoRoot,
                workspaceRegistry
              );
            }
          } else if (lastArg) {
            resolvedHandlerTarget = resolveExternalPackageTarget(
              lastArg,
              sourceFile,
              repoRoot,
              workspaceRegistry
            );
          }
          if (resolvedHandlerTarget) {
            mwEdge.targetId = resolvedHandlerTarget;
          } else {
            delete mwEdge.targetId;
          }
        } else if (mwEdge.patternId === HTTP_ROUTE_MIDDLEWARE_EDGE_PATTERN_ID && targetLabel) {
          const bareTargetLabel = targetLabel.replace(/\(\)$/, '');
          let resolvedMwTarget: string | undefined;
          const flatMwArgs: ts.Expression[] = [];
          for (let argIdx = 0; argIdx < node.arguments.length - 1; argIdx++) {
            const rawArg = node.arguments[argIdx];
            if (ts.isArrayLiteralExpression(rawArg)) {
              for (const el of rawArg.elements) {
                if (!ts.isSpreadElement(el) && !ts.isOmittedExpression(el)) {
                  flatMwArgs.push(el);
                }
              }
            } else {
              flatMwArgs.push(rawArg);
            }
          }
          for (const arg of flatMwArgs) {
            if (
              ts.isCallExpression(arg) &&
              ts.isIdentifier(arg.expression) &&
              arg.expression.text === bareTargetLabel
            ) {
              const ref = resolveFunctionContractReference(
                arg.expression,
                node,
                sourceFile,
                getEvidence,
                repoRoot,
                workspaceRegistry
              );
              resolvedMwTarget =
                ref?.targetId ??
                resolveExternalPackageTarget(arg.expression, sourceFile, repoRoot, workspaceRegistry);
              break;
            }
          }
          if (resolvedMwTarget) {
            mwEdge.targetId = resolvedMwTarget;
          } else if (
            relFileIndex.symbolCandidates.has(targetLabel) ||
            relFileIndex.symbolCandidates.has(bareTargetLabel)
          ) {
            delete mwEdge.targetId;
          }
        }
      }
    }
    const routerEndpointEdge = ts.isCallExpression(node)
      ? extractRouterInstanceToHttpEndpointEdge(
          node,
          sourceFile,
          getEvidence,
          nextId,
          repoRoot,
          workspaceRegistry
        )
      : null;
    return [
      ...expressRouteMiddlewares,
      ...extra,
      ...callbackEdges,
      ...(routerEndpointEdge ? [routerEndpointEdge] : []),
    ];
  }

  const primary = withCallShapeKey(
    visitInferredCallRelationship(node, sourceFile, getEvidence, nextId, repoRoot, sourceId, workspaceRegistry),
    node,
    { repoRoot, workspaceRegistry }
  );
  if (ts.isCallExpression(node)) {
    const callbackEdges = extractCallbackArgumentEdges(node, sourceFile, getEvidence, nextId, repoRoot, sourceId, workspaceRegistry);
    const drizzleSchemaEdges = extractDrizzleNamespaceSchemaEdges(
      node,
      sourceFile,
      getEvidence,
      nextId,
      repoRoot,
      sourceId,
      workspaceRegistry
    );
    const routerEndpointEdge = extractRouterInstanceToHttpEndpointEdge(
      node,
      sourceFile,
      getEvidence,
      nextId,
      repoRoot,
      workspaceRegistry
    );
    if (callbackEdges.length > 0 || drizzleSchemaEdges.length > 0 || routerEndpointEdge) {
      const base = Array.isArray(primary) ? primary : (primary ? [primary] : []);
      return [
        ...base,
        ...callbackEdges,
        ...drizzleSchemaEdges,
        ...(routerEndpointEdge ? [routerEndpointEdge] : []),
      ];
    }
  }
  return primary;
}

/**
 * Extracts optional HTTP wrapper argument metadata (`urlPath`, `httpMethod`) from a call expression
 * (e.g. `serverFetch('/blogs', { method: 'POST' })`) so intra-repo HTTP protocol stitching can
 * compose a wrapper contract's base URL prefix (`/api`) with each caller's endpoint argument.
 */
function extractHttpCallArgsMetadata(node: ts.CallExpression): { urlPath?: string; httpMethod?: string } | undefined {
  if (node.arguments.length === 0) return undefined;
  const rawUrl = resolveHttpUrlPathFromExpression(node.arguments[0]);
  if (!rawUrl || (!rawUrl.startsWith('/') && !rawUrl.startsWith('http'))) return undefined;
  let httpMethod: string | undefined;
  if (node.arguments.length > 1 && ts.isObjectLiteralExpression(node.arguments[1])) {
    for (const prop of node.arguments[1].properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ((ts.isIdentifier(prop.name) && prop.name.text === 'method') ||
          (ts.isStringLiteral(prop.name) && prop.name.text === 'method')) &&
        (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
      ) {
        httpMethod = prop.initializer.text.trim().toUpperCase();
      }
    }
  }
  return { urlPath: rawUrl, ...(httpMethod ? { httpMethod } : {}) };
}

/**
 * Inheritance, mixin, method-call, function-call, returned-function-call and JSX shaped
 * relationships — the generic call surface shared by every framework adapter.
 */
function visitInferredCallRelationship(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | StructuralEntity[] | null {
  if (ts.isCallExpression(node) && isSvelteRuneCall(node)) {
    return null;
  }

  // Object.create (Prototypal Inheritance)
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'create' &&
    node.arguments.length > 0
  ) {
    const argText = node.arguments[0].getText(sourceFile);
    if (argText === 'null' || argText === 'undefined') {
      return null; // Explicitly creating a prototype-less object is not a structural dependency
    }

    let objectCreateTargetId = resolveExternalPackageTarget(node.arguments[0], sourceFile, repoRoot, workspaceRegistry);
    const protoArg = node.arguments[0];
    const protoIdent = ts.isIdentifier(protoArg)
      ? protoArg
      : ts.isPropertyAccessExpression(protoArg) &&
          protoArg.name.text === 'prototype' &&
          ts.isIdentifier(protoArg.expression)
        ? protoArg.expression
        : null;
    if (!objectCreateTargetId && protoIdent) {
      const argBinding = findValueModuleBinding(sourceFile, protoIdent.text);
      if (argBinding) {
        const importedClassTarget = resolveImportedClassBoundaryTargetWithEvidence(
          protoIdent.text,
          sourceFile,
          repoRoot,
          workspaceRegistry,
          undefined,
          true
        );
        if (importedClassTarget) {
          objectCreateTargetId = importedClassTarget.targetId;
        } else {
          const resolvedProtoPath = resolveModulePath(
            argBinding.moduleSpecifier,
            sourceFile.fileName,
            repoRoot,
            workspaceRegistry
          );
          if (resolvedProtoPath) {
            const lookupSymbol =
              argBinding.importedName && argBinding.importedName !== '*'
                ? argBinding.importedName
                : 'default';
            const exportResolved = resolveTargetExport(
              resolvedProtoPath,
              lookupSymbol,
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function'
            );
            if (exportResolved) {
              objectCreateTargetId = exportResolved.targetId;
            } else {
              const protoScope = resolveLogicalBoundaryScope(resolvedProtoPath, repoRoot, workspaceRegistry);
              objectCreateTargetId = cjsContractEntityId(protoScope, resolvedProtoPath, 'CJS Export: default');
            }
          }
        }
      } else {
        const sameFileFn = resolveSameFileExportedFunction(
          protoIdent.text,
          protoIdent,
          sourceFile,
          repoRoot,
          workspaceRegistry
        );
        if (sameFileFn) {
          objectCreateTargetId = sameFileFn.targetId;
        }
      }
    }

    return {
      id: nextId(),
      name: `Inherits: ${argText}`,
      type: 'RELATIONSHIP',
      entityType: 'INHERITS', patternId: 'relationship.object-create',
      sourceId,
      targetId: objectCreateTargetId,
      status: 'DETERMINISTIC',
      confidence: 'HIGH',
      evidence: [
        { ...getEvidence(node), evidenceRole: 'syntax-call' }
      ],
    };
  }

  // Object.setPrototypeOf (Prototypal Inheritance)
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'setPrototypeOf' &&
    node.arguments.length > 1
  ) {
    const firstArg = node.arguments[0];
    const secondArg = node.arguments[1];
    const argText = secondArg.getText(sourceFile);
    if (firstArg.kind === ts.SyntaxKind.ThisKeyword) {
      if (argText === 'new.target.prototype') {
        return null;
      }
      let enclosingClass: ts.Node | undefined = node.parent;
      while (enclosingClass && !ts.isClassDeclaration(enclosingClass)) {
        enclosingClass = enclosingClass.parent;
      }
      if (
        enclosingClass &&
        ts.isClassDeclaration(enclosingClass) &&
        enclosingClass.name &&
        argText === `${enclosingClass.name.text}.prototype`
      ) {
        return null;
      }
    }
    return {
      id: nextId(),
      name: `Inherits: ${argText}`,
      type: 'RELATIONSHIP',
      entityType: 'INHERITS', patternId: 'relationship.object-setprototypeof',
      sourceId,
      targetId: resolveExternalPackageTarget(secondArg, sourceFile, repoRoot, workspaceRegistry),
      status: 'DETERMINISTIC',
      confidence: 'HIGH',
      evidence: [
        { ...getEvidence(node), evidenceRole: 'syntax-call' }
      ],
    };
  }

  /**
   * Prototype Mixin
   * Handles patterns where properties from a prototype are mixed into an object.
   *
   * @example
   * // Object.assign mixin
   * Object.assign(app, EventEmitter.prototype)
   *
   * @example
   * // merge-descriptors third-party mixin (3 arguments)
   * mixin(app, EventEmitter.prototype, false);
   */
  if (
    ts.isCallExpression(node) &&
    node.arguments.length >= 2 &&
    ts.isPropertyAccessExpression(node.arguments[1]) &&
    node.arguments[1].name.text === 'prototype' &&
    ((ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Object' &&
      (node.expression.name.text === 'assign' || node.expression.name.text === 'setPrototypeOf')) ||
      (ts.isIdentifier(node.expression) &&
        /^(?:mixin|merge|extend|assign|copyProperties|inherits)$/i.test(node.expression.text)) ||
      (ts.isPropertyAccessExpression(node.expression) &&
        !(
          ts.isIdentifier(node.expression.expression) &&
          (node.expression.expression.text === 'Reflect' || node.expression.expression.text === 'Object')
        ) &&
        /^(?:mixin|merge|extend|assign|copyProperties|inherits)$/i.test(node.expression.name.text)))
  ) {
    return {
      id: nextId(),
      name: `Mixes: ${node.arguments[1].expression.getText(sourceFile)}`,
      type: 'RELATIONSHIP',
      entityType: 'MIXES', patternId: 'relationship.prototype-mixin',
      sourceId,
      targetId: resolveExternalPackageTarget((node.arguments[1] as ts.PropertyAccessExpression).expression, sourceFile, repoRoot, workspaceRegistry),
      status: 'DETERMINISTIC',
      confidence: 'MEDIUM',
      evidence: [
        { ...getEvidence(node), evidenceRole: 'syntax-call' }
      ],
    };
  }

  // Inferred Method Calls (e.g. userController.createUser() or userController['createUser']()) ([PAT-EXT-14])
  const memberAccess = ts.isCallExpression(node) ? getPropertyOrElementAccess(node.expression) : null;
  if (ts.isCallExpression(node) && memberAccess) {
    if (unwrapLazyImport(node)) return null;

    const eventPubSub = resolveEventPubSubTarget(node, sourceFile, repoRoot, workspaceRegistry);
    if (eventPubSub) {
      return {
        id: nextId(),
        name: `Call: ${node.expression.getText(sourceFile).replace(/\s+/g, '')}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.function-call',
        sourceId,
        targetId: eventPubSub.targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: [
          { ...getEvidence(node), evidenceRole: 'syntax-call' },
          eventPubSub.targetEvidence,
        ],
      };
    }

    const expressResAugmented = extractExpressResAugmentedMethodCall(
      node,
      sourceFile,
      getEvidence,
      nextId,
      repoRoot,
      sourceId,
      workspaceRegistry
    );
    if (expressResAugmented) {
      return expressResAugmented;
    }

    const loadContextCall = extractReactRouterLoadContextCall(
      node,
      sourceFile,
      getEvidence,
      nextId,
      repoRoot,
      sourceId,
      workspaceRegistry
    );
    if (loadContextCall) {
      return loadContextCall;
    }

    let rootText: string | null = null;
    let rootIdentNode: ts.Identifier | null = null;
    let hasCallInReceiverChain = false;
    let hasNewInReceiverChain = false;
    const receiverSegments: string[] = [];
    let currentExpr: ts.Expression = memberAccess.expression;
    while (currentExpr) {
      if (ts.isIdentifier(currentExpr)) {
        rootText = currentExpr.text;
        rootIdentNode = currentExpr;
        break;
      } else if (currentExpr.kind === ts.SyntaxKind.ThisKeyword) {
        rootText = 'this';
        break;
      } else if (ts.isPropertyAccessExpression(currentExpr)) {
        receiverSegments.unshift(currentExpr.name.text);
        currentExpr = currentExpr.expression;
      } else if (ts.isElementAccessExpression(currentExpr)) {
        if (ts.isStringLiteral(currentExpr.argumentExpression)) {
          receiverSegments.unshift(currentExpr.argumentExpression.text);
        } else {
          receiverSegments.unshift('*');
        }
        currentExpr = currentExpr.expression;
      } else if (ts.isCallExpression(currentExpr)) {
        hasCallInReceiverChain = true;
        currentExpr = currentExpr.expression;
      } else if (ts.isNewExpression(currentExpr)) {
        hasCallInReceiverChain = true;
        hasNewInReceiverChain = true;
        currentExpr = currentExpr.expression;
      } else if (
        ts.isParenthesizedExpression(currentExpr) ||
        ts.isNonNullExpression(currentExpr) ||
        ts.isAsExpression(currentExpr) ||
        ts.isTypeAssertionExpression(currentExpr) ||
        ts.isSatisfiesExpression(currentExpr)
      ) {
        currentExpr = currentExpr.expression;
      } else {
        break;
      }
    }

    if (!rootText) {
      const inlineDynImp = unwrapDynamicImport(memberAccess.expression);
      const dynMethod = memberAccess.memberName;
      if (
        inlineDynImp &&
        dynMethod !== 'then' &&
        dynMethod !== 'catch' &&
        dynMethod !== 'finally'
      ) {
        const callEv = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
        if (isExternalSpecifier(inlineDynImp.specifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
          return {
            id: nextId(),
            name: `Call: import().${dynMethod}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.function-call',
            sourceId,
            targetId: packageConnectorId(inlineDynImp.specifier),
            status: 'INFERRED',
            confidence: 'HIGH',
            evidence: [callEv],
          };
        }
        const resolvedDynPath = resolveModulePath(
          inlineDynImp.specifier,
          sourceFile.fileName,
          repoRoot,
          workspaceRegistry
        );
        if (resolvedDynPath) {
          const res =
            (inlineDynImp.member
              ? resolveImportedObjectMember(
                  resolvedDynPath,
                  inlineDynImp.member,
                  dynMethod,
                  repoRoot,
                  workspaceRegistry ?? {},
                  receiverSegments
                )
              : null) ??
            resolveTargetExport(
              resolvedDynPath,
              dynMethod,
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function'
            ) ??
            (inlineDynImp.member === 'default'
              ? resolveTargetExport(
                  resolvedDynPath,
                  'default',
                  repoRoot,
                  workspaceRegistry ?? {},
                  'Exported Function'
                )
              : null);
          return {
            id: nextId(),
            name: `Call: import().${dynMethod}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.function-call',
            sourceId,
            targetId: res?.targetId,
            status: 'INFERRED',
            confidence: res ? 'HIGH' : 'MEDIUM',
            evidence: res ? [callEv, res.targetEvidence] : [callEv],
          };
        }
        return {
          id: nextId(),
          name: `Call: import().${dynMethod}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.function-call',
          sourceId,
          status: 'INFERRED',
          confidence: 'LOW',
          evidence: [callEv],
        };
      }
    }

    if (rootText) {
      const methodName = memberAccess.memberName;

      // Skip known open connectors (HTTP and DB clients, local aliases, Drizzle query chains, and browser postMessage IPC)
      if (
        isLocalOpenConnectorClient(rootText, sourceFile, methodName, repoRoot, workspaceRegistry) ||
        isWindowPostMessageCall(node) ||
        extractDrizzleQueryChain(node, getEvidence, nextId) !== null ||
        isInnerDrizzleQueryChainCall(node, getEvidence, nextId)
      ) {
        return null;
      }

      if (
        (hasCallInReceiverChain &&
          (methodName === 'catch' ||
            methodName === 'then' ||
            methodName === 'finally' ||
            (rootText === 'Math' &&
              (methodName === 'substr' ||
                methodName === 'substring' ||
                methodName === 'toString' ||
                methodName === 'slice')))) ||
        (rootText !== 'this' &&
          (ts.isOptionalChain(node) ||
            receiverSegments.includes('*') ||
            (!hasCallInReceiverChain && receiverSegments.length > 0)) &&
          (BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName) ||
            (BUILTIN_DOM_ITERATOR_REFLECTION_METHODS.has(methodName) &&
              !resolvePublicMethodTarget(node, sourceFile, repoRoot, workspaceRegistry))))
      ) {
        return null;
      }

      if (rootIdentNode) {
        const localFromCall = resolveLocalFromCallTarget(
          rootIdentNode,
          node,
          sourceFile,
          repoRoot,
          workspaceRegistry
        );
        if (localFromCall?.targetId === 'pkg:pg' && (methodName === 'release' || methodName === 'on' || methodName === 'end')) {
          return null;
        }
      }

      // Check if rootIdentifier matches a local import
      const matchingImport = getRelationshipFileIndex(sourceFile).importDeclByLocalName.get(rootText) ?? null;

      const callEvidence = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
      const evidences: EvidenceRecord[] = [callEvidence];

      const importLiteral = getImportDeclarationSpecifier(matchingImport);

      if (matchingImport && importLiteral) {
        const importStart = matchingImport.getStart(sourceFile);
        const { line: importLine } = sourceFile.getLineAndCharacterOfPosition(importStart);
        
        evidences.push({
          filePath: callEvidence.filePath,
          lineNumber: importLine + 1,
          snippet: matchingImport.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
          evidenceRole: 'import-match'
        });

        const resolvedPath = resolveModulePath(importLiteral, sourceFile.fileName, repoRoot, workspaceRegistry);
        if (resolvedPath) {
          // v4: files are not targets. The target stays unresolved unless the exported contract is proven below.
          const binding = findValueModuleBinding(sourceFile, rootText);
          const lookupSymbol =
            binding?.importedName &&
            binding.importedName !== '*' &&
            binding.importedName !== 'default'
              ? binding.importedName
              : rootText;

          if (hasCallInReceiverChain) {
            const publicMethodTarget = resolvePublicMethodTarget(node, sourceFile, repoRoot, workspaceRegistry);
            if (publicMethodTarget) {
              return {
                id: nextId(),
                name: `Call: ${rootText}.${methodName}()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL', patternId: 'relationship.invoke-returned-function',
                sourceId,
                targetId: publicMethodTarget,
                status: 'INFERRED',
                confidence: 'HIGH',
                evidence: evidences,
              };
            }

            let innerCall: ts.CallExpression | null = null;
            let scanExpr: ts.Expression = unwrapTransparentExpr(memberAccess.expression);
            while (scanExpr) {
              if (ts.isCallExpression(scanExpr)) {
                innerCall = scanExpr;
                scanExpr = unwrapTransparentExpr(scanExpr.expression);
              } else if (ts.isPropertyAccessExpression(scanExpr) || ts.isElementAccessExpression(scanExpr)) {
                scanExpr = unwrapTransparentExpr(scanExpr.expression);
              } else {
                break;
              }
            }
            if (innerCall && !BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName)) {
              const innerAccess = getPropertyOrElementAccess(innerCall.expression);
              const innerMethodName = innerAccess?.memberName ?? null;
              const innerReceiverSegments: string[] = [];
              if (innerAccess) {
                let segCur: ts.Expression = unwrapTransparentExpr(innerAccess.expression);
                while (ts.isPropertyAccessExpression(segCur)) {
                  innerReceiverSegments.unshift(segCur.name.text);
                  segCur = unwrapTransparentExpr(segCur.expression);
                }
              }
              const chainedMemberTarget =
                (innerMethodName
                  ? binding?.importedName !== '*'
                    ? resolveImportedObjectMember(
                        resolvedPath,
                        lookupSymbol,
                        innerMethodName,
                        repoRoot,
                        workspaceRegistry ?? {},
                        innerReceiverSegments
                      ) ??
                      (binding?.importedName === 'default' && lookupSymbol !== 'default'
                        ? resolveImportedObjectMember(
                            resolvedPath,
                            'default',
                            innerMethodName,
                            repoRoot,
                            workspaceRegistry ?? {},
                            innerReceiverSegments
                          )
                        : null)
                    : innerReceiverSegments.length >= 1
                      ? resolveImportedObjectMember(
                          resolvedPath,
                          innerReceiverSegments[0],
                          innerMethodName,
                          repoRoot,
                          workspaceRegistry ?? {},
                          innerReceiverSegments.slice(1)
                        ) ??
                        resolveTargetExport(
                          resolvedPath,
                          innerReceiverSegments[0],
                          repoRoot,
                          workspaceRegistry ?? {},
                          'Exported Function',
                          0,
                          undefined,
                          false,
                          [...innerReceiverSegments.slice(1), innerMethodName].join('.')
                        )
                      : resolveTargetExport(
                          resolvedPath,
                          innerMethodName,
                          repoRoot,
                          workspaceRegistry ?? {},
                          'Exported Function'
                        )
                  : null) ??
                resolveClassMethodTargetWithEvidence(
                  innerCall,
                  sourceFile,
                  repoRoot,
                  workspaceRegistry
                ) ??
                resolveImportedClassBoundaryTargetWithEvidence(
                  rootText,
                  sourceFile,
                  repoRoot,
                  workspaceRegistry,
                  undefined,
                  true
                );
              if (chainedMemberTarget) {
                evidences.push(chainedMemberTarget.targetEvidence);
                return {
                  id: nextId(),
                  name: `Call: ${rootText}.${methodName}()`,
                  type: 'RELATIONSHIP',
                  entityType: 'CALL',
                  patternId: 'relationship.invoke-returned-function',
                  sourceId,
                  targetId: chainedMemberTarget.targetId,
                  status: 'INFERRED',
                  confidence: 'HIGH',
                  evidence: evidences,
                };
              }
            }

            if (!BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName)) {
              const innerAccessForRoot = innerCall ? getPropertyOrElementAccess(innerCall.expression) : null;
              const innerMethodForRoot = innerAccessForRoot?.memberName ?? undefined;
              const verifiedRootCallExport =
                binding?.importedName !== '*'
                  ? verifyOrTraceResolvedExport(
                      (innerMethodForRoot
                        ? resolveTargetExport(
                            resolvedPath,
                            lookupSymbol,
                            repoRoot,
                            workspaceRegistry ?? {},
                            'Exported Function',
                            0,
                            undefined,
                            false,
                            innerMethodForRoot
                          )
                        : null) ??
                        resolveTargetExport(
                          resolvedPath,
                          lookupSymbol,
                          repoRoot,
                          workspaceRegistry ?? {},
                          'Exported Function'
                        ) ??
                        (binding?.importedName === 'default'
                          ? resolveTargetExport(
                              resolvedPath,
                              'default',
                              repoRoot,
                              workspaceRegistry ?? {},
                              'Exported Function'
                            )
                          : null),
                      lookupSymbol,
                      repoRoot,
                      workspaceRegistry,
                      innerMethodForRoot
                    )
                  : innerMethodForRoot
                    ? verifyOrTraceResolvedExport(
                        resolveTargetExport(
                          resolvedPath,
                          innerMethodForRoot,
                          repoRoot,
                          workspaceRegistry ?? {},
                          'Exported Function'
                        ),
                        innerMethodForRoot,
                        repoRoot,
                        workspaceRegistry
                      )
                    : null;
              if (verifiedRootCallExport) {
                if (!innerMethodForRoot) {
                  // The inner call (`rootText()`) is a direct call on the root imported factory
                  // and already emits its own `Call: rootText()` edge to `verifiedRootCallExport.targetId`.
                  // Suppressing the outer fluent/chained method call prevents duplicate parallel edges
                  // from the same caller to the factory contract (`bug.chained-factory-call-duplicate-edges`).
                  return null;
                }
                if (verifiedRootCallExport.targetEvidence) {
                  evidences.push(verifiedRootCallExport.targetEvidence);
                }
                return {
                  id: nextId(),
                  name: `Call: ${rootText}.${methodName}()`,
                  type: 'RELATIONSHIP',
                  entityType: 'CALL',
                  patternId: 'relationship.invoke-returned-function',
                  sourceId,
                  targetId: verifiedRootCallExport.targetId,
                  status: 'INFERRED',
                  confidence: verifiedRootCallExport.confidence,
                  evidence: evidences,
                };
              }
            }
            const fallbackExtPkgTarget = !BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName)
              ? resolveExternalPackageTarget(node.expression, sourceFile, repoRoot, workspaceRegistry)
              : undefined;
            return {
              id: nextId(),
              name: `Call: ${rootText}.${methodName}()`,
              type: 'RELATIONSHIP',
              entityType: 'CALL', patternId: 'relationship.invoke-returned-function',
              sourceId,
              targetId: fallbackExtPkgTarget,
              status: 'INFERRED',
              confidence: fallbackExtPkgTarget ? 'MEDIUM' : 'LOW',
              evidence: fallbackExtPkgTarget ? evidences : [callEvidence],
            };
          }

          if (
            binding?.importedName !== '*' &&
            receiverSegments.includes('*')
          ) {
            const dynamicBranches =
              resolveImportedObjectDynamicBranchMembers(
                resolvedPath,
                lookupSymbol,
                methodName,
                repoRoot,
                workspaceRegistry ?? {},
                receiverSegments
              );
            const fallbackBranches =
              dynamicBranches.length === 0 && binding?.importedName === 'default' && lookupSymbol !== 'default'
                ? resolveImportedObjectDynamicBranchMembers(
                    resolvedPath,
                    'default',
                    methodName,
                    repoRoot,
                    workspaceRegistry ?? {},
                    receiverSegments
                  )
                : dynamicBranches;
            if (fallbackBranches.length > 0) {
              return fallbackBranches.map((branch) => ({
                id: nextId(),
                name: `Call: ${rootText}.${methodName}()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL',
                patternId: 'relationship.function-call',
                sourceId,
                targetId: branch.targetId,
                status: 'INFERRED',
                confidence: 'HIGH',
                evidence: [...evidences, branch.targetEvidence],
              }));
            }
            const verifiedDynamicRoot = verifyOrTraceResolvedExport(
              resolveTargetExport(
                resolvedPath,
                lookupSymbol,
                repoRoot,
                workspaceRegistry ?? {},
                'Exported Function'
              ) ??
                (binding?.importedName === 'default' && lookupSymbol !== 'default'
                  ? resolveTargetExport(
                      resolvedPath,
                      'default',
                      repoRoot,
                      workspaceRegistry ?? {},
                      'Exported Function'
                    )
                  : null),
              lookupSymbol,
              repoRoot,
              workspaceRegistry,
              methodName
            );
            if (verifiedDynamicRoot) {
              if (verifiedDynamicRoot.targetEvidence) {
                evidences.push(verifiedDynamicRoot.targetEvidence);
              }
              return {
                id: nextId(),
                name: `Call: ${rootText}.${methodName}()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL',
                patternId: 'relationship.function-call',
                sourceId,
                targetId: verifiedDynamicRoot.targetId,
                status: 'INFERRED',
                confidence: verifiedDynamicRoot.confidence,
                evidence: evidences,
              };
            }
          }

          const resolvedMember =
            (binding?.importedName !== '*'
              ? resolveImportedObjectMember(
                  resolvedPath,
                  lookupSymbol,
                  methodName,
                  repoRoot,
                  workspaceRegistry ?? {},
                  receiverSegments
                ) ??
                (binding?.importedName === 'default' && lookupSymbol !== 'default'
                  ? resolveImportedObjectMember(
                      resolvedPath,
                      'default',
                      methodName,
                      repoRoot,
                      workspaceRegistry ?? {},
                      receiverSegments
                    )
                  : null) ??
                (receiverSegments.length === 0
                  ? resolveTargetExport(
                      resolvedPath,
                      lookupSymbol,
                      repoRoot,
                      workspaceRegistry ?? {},
                      'Exported Function',
                      0,
                      undefined,
                      false,
                      methodName
                    )
                  : null)
              : receiverSegments.length >= 1
                ? resolveImportedObjectMember(
                    resolvedPath,
                    receiverSegments[0],
                    methodName,
                    repoRoot,
                    workspaceRegistry ?? {},
                    receiverSegments.slice(1)
                  ) ??
                  resolveTargetExport(
                    resolvedPath,
                    receiverSegments[0],
                    repoRoot,
                    workspaceRegistry ?? {},
                    'Exported Function',
                    0,
                    undefined,
                    false,
                    [...receiverSegments.slice(1), methodName].join('.')
                  )
                : null) ??
            (receiverSegments.length === 0 &&
            (!binding?.importedName || binding.importedName === '*' || binding.importedName === 'default')
              ? resolveTargetExport(
                  resolvedPath,
                  methodName,
                  repoRoot,
                  workspaceRegistry ?? {},
                  'Exported Function'
                )
              : null) ??
            resolveClassMethodTargetWithEvidence(
              node,
              sourceFile,
              repoRoot,
              workspaceRegistry
            ) ??
            resolveImportedClassBoundaryTargetWithEvidence(
              rootText,
              sourceFile,
              repoRoot,
              workspaceRegistry,
              undefined,
              true
            );

          if (resolvedMember) {
            evidences.push(resolvedMember.targetEvidence);
            return {
              id: nextId(),
              name: `Call: ${rootText}.${methodName}()`,
              type: 'RELATIONSHIP',
              entityType: 'CALL', patternId: 'relationship.function-call',
              sourceId,
              targetId: resolvedMember.targetId,
              status: 'INFERRED',
              confidence: 'HIGH',
              evidence: evidences,
            };
          } else if (BUILTIN_COLLECTION_PROTOTYPE_METHODS.has(methodName)) {
            return {
              id: nextId(),
              name: `Call: ${rootText}.${methodName}()`,
              type: 'RELATIONSHIP',
              entityType: 'CALL', patternId: 'relationship.invoke-returned-function',
              sourceId,
              status: 'INFERRED',
              confidence: 'LOW',
              evidence: [callEvidence],
            };
          } else {
            const nsTargetSymbol =
              binding?.importedName === '*' && receiverSegments.length >= 1
                ? receiverSegments[0]
                : null;
            const nsMemberProp =
              binding?.importedName === '*' && receiverSegments.length >= 1
                ? [...receiverSegments.slice(1), methodName].join('.')
                : undefined;
            const nonNsMemberProp =
              receiverSegments.length > 0 && !receiverSegments.includes('*')
                ? [...receiverSegments, methodName].join('.')
                : methodName;
            const verifiedRootExport =
              binding?.importedName !== '*'
                ? verifyOrTraceResolvedExport(
                    resolveTargetExport(
                      resolvedPath,
                      lookupSymbol,
                      repoRoot,
                      workspaceRegistry ?? {},
                      'Exported Function',
                      0,
                      undefined,
                      false,
                      nonNsMemberProp
                    ) ??
                      resolveTargetExport(
                        resolvedPath,
                        lookupSymbol,
                        repoRoot,
                        workspaceRegistry ?? {},
                        'Exported Function'
                      ) ??
                      (binding?.importedName === 'default'
                        ? resolveTargetExport(
                            resolvedPath,
                            'default',
                            repoRoot,
                            workspaceRegistry ?? {},
                            'Exported Function'
                          )
                        : null),
                    lookupSymbol,
                    repoRoot,
                    workspaceRegistry,
                    nonNsMemberProp
                  )
                : nsTargetSymbol
                  ? verifyOrTraceResolvedExport(
                      resolveTargetExport(
                        resolvedPath,
                        nsTargetSymbol,
                        repoRoot,
                        workspaceRegistry ?? {},
                        'Exported Function',
                        0,
                        undefined,
                        false,
                        nsMemberProp
                      ) ??
                        resolveTargetExport(
                          resolvedPath,
                          nsTargetSymbol,
                          repoRoot,
                          workspaceRegistry ?? {},
                          'Exported Function'
                        ),
                      nsTargetSymbol,
                      repoRoot,
                      workspaceRegistry,
                      nsMemberProp
                    )
                  : verifyOrTraceResolvedExport(
                      resolveTargetExport(
                        resolvedPath,
                        methodName,
                        repoRoot,
                        workspaceRegistry ?? {},
                        'Exported Function'
                      ),
                      methodName,
                      repoRoot,
                      workspaceRegistry
                    );
            if (verifiedRootExport) {
              if (verifiedRootExport.targetEvidence) {
                evidences.push(verifiedRootExport.targetEvidence);
              }
              return {
                id: nextId(),
                name: `Call: ${rootText}.${methodName}()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL',
                patternId: 'relationship.function-call',
                sourceId,
                targetId: verifiedRootExport.targetId,
                status: 'INFERRED',
                confidence: verifiedRootExport.confidence,
                evidence: evidences,
              };
            }
            const importMemberPath =
              !hasCallInReceiverChain && receiverSegments.length > 0 && !receiverSegments.includes('*')
                ? `${receiverSegments.join('.')}.${methodName}`
                : methodName;
            return {
              id: nextId(),
              name: `Call: ${rootText}.${importMemberPath}()`,
              type: 'RELATIONSHIP',
              entityType: 'CALL', patternId: 'relationship.function-call',
              sourceId,
              status: 'INFERRED',
              confidence: 'MEDIUM',
              evidence: evidences,
            };
          }
        } else {
          // We have a matching import, but cannot resolve the path (e.g. built-in or external module).
          // When there is a call in the receiver chain and the outer method is a built-in JS
          // primitive/array method (`execSync(...).trim()`, `createHash(...).digest().slice()`,
          // `fg.sync(...).sort()`), or the root import was invoked directly as a function (`ora('x').start()`),
          // the inner call already targeted the external package; chained member calls on a
          // module/namespace property (`http.createServer().listen()`, `summary.addRaw().write()`)
          // target the external package's Open Connector.
          if (
            hasCallInReceiverChain &&
            ((receiverSegments.length === 0 && !hasNewInReceiverChain) ||
              BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName) ||
              methodName === 'has' ||
              methodName === 'add' ||
              methodName === 'clear') &&
            methodName !== 'primaryKey'
          ) {
            return {
              id: nextId(),
              name: `Call: ${rootText}.${methodName}()`,
              type: 'RELATIONSHIP',
              entityType: 'CALL', patternId: 'relationship.invoke-returned-function',
              sourceId,
              status: 'INFERRED',
              confidence: 'LOW',
              evidence: [callEvidence],
            };
          }
          // An external package is an exit point of the system → Open Connector target.
          return {
            id: nextId(),
            name: `Call: ${rootText}.${methodName}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL', patternId: 'relationship.inferred-method-call',
            sourceId,
            targetId: isExternalSpecifier(importLiteral, sourceFile.fileName, repoRoot, workspaceRegistry)
              ? packageConnectorId(importLiteral)
              : undefined,
            status: 'INFERRED',
            confidence: 'MEDIUM',
            evidence: evidences,
          };
        }
      }

      // Check CommonJS `require('./...')` module bindings and CJS export aliases / mixin parameters
      if (!hasCallInReceiverChain) {
        const sfDeclIndex = getSourceFileDeclarationIndex(sourceFile);
        const isLocalCjsAlias = sfDeclIndex.cjsExportAliases.has(rootText);
        const isLocalCjsMixinParam = sfDeclIndex.cjsMixinParamNames.has(rootText);
        if (isLocalCjsAlias || isLocalCjsMixinParam) {
          const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
          let targetRelPath: string | null = relPath;
          if (receiverSegments.length > 0) {
            targetRelPath = followCjsSubmoduleSegments(relPath, receiverSegments, repoRoot, workspaceRegistry);
            if (!targetRelPath && isLocalCjsMixinParam) {
              const siblingBarrel = resolveModulePath('./index', sourceFile.fileName, repoRoot, workspaceRegistry);
              if (siblingBarrel) {
                targetRelPath = followCjsSubmoduleSegments(
                  siblingBarrel,
                  receiverSegments,
                  repoRoot,
                  workspaceRegistry
                );
              }
            }
          }
          let sameOrMixinCjs = targetRelPath
            ? resolveTargetExport(targetRelPath, methodName, repoRoot, workspaceRegistry ?? {}, 'Exported Function')
            : null;
          if (!sameOrMixinCjs && isLocalCjsMixinParam && receiverSegments.length === 0) {
            const siblingBarrel = resolveModulePath('./index', sourceFile.fileName, repoRoot, workspaceRegistry);
            if (siblingBarrel && siblingBarrel !== relPath) {
              sameOrMixinCjs = resolveTargetExport(
                siblingBarrel,
                methodName,
                repoRoot,
                workspaceRegistry ?? {},
                'Exported Function'
              );
            }
          }
          if (sameOrMixinCjs && sameOrMixinCjs.targetId !== sourceId) {
            evidences.push(sameOrMixinCjs.targetEvidence);
            return {
              id: nextId(),
              name: `Call: ${rootText}.${methodName}()`,
              type: 'RELATIONSHIP',
              entityType: 'CALL', patternId: 'relationship.function-call',
              sourceId,
              targetId: sameOrMixinCjs.targetId,
              status: 'INFERRED',
              confidence: 'HIGH',
              evidence: evidences,
            };
          }
        }

        const reqBinding = findValueModuleBinding(sourceFile, rootText);
        if (reqBinding && (reqBinding.kind === 'require' || (!matchingImport && !reqBinding.lazyWrapper))) {
          const resolvedReqPath = resolveModulePath(
            reqBinding.moduleSpecifier,
            sourceFile.fileName,
            repoRoot,
            workspaceRegistry
          );
          if (resolvedReqPath) {
            const targetReqPath =
              receiverSegments.length > 0
                ? followCjsSubmoduleSegments(resolvedReqPath, receiverSegments, repoRoot, workspaceRegistry)
                : resolvedReqPath;
            const lookupSymbol =
              reqBinding.importedName &&
              reqBinding.importedName !== '*' &&
              reqBinding.importedName !== 'default'
                ? reqBinding.importedName
                : rootText;
            const resolvedMember =
              (reqBinding.importedName !== '*'
                ? resolveImportedObjectMember(
                    resolvedReqPath,
                    lookupSymbol,
                    methodName,
                    repoRoot,
                    workspaceRegistry ?? {},
                    receiverSegments
                  )
                : null) ??
              (targetReqPath
                ? (reqBinding.importedName !== '*'
                    ? resolveImportedObjectMember(
                        targetReqPath,
                        lookupSymbol,
                        methodName,
                        repoRoot,
                        workspaceRegistry ?? {}
                      )
                    : null) ??
                  resolveTargetExport(
                    targetReqPath,
                    methodName,
                    repoRoot,
                    workspaceRegistry ?? {},
                    'Exported Function'
                  ) ??
                  resolveClassMethodTargetWithEvidence(
                    node,
                    sourceFile,
                    repoRoot,
                    workspaceRegistry
                  )
                : null);
            if (resolvedMember) {
              evidences.push(resolvedMember.targetEvidence);
              return {
                id: nextId(),
                name: `Call: ${rootText}.${methodName}()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL', patternId: 'relationship.function-call',
                sourceId,
                targetId: resolvedMember.targetId,
                status: 'INFERRED',
                confidence: 'HIGH',
                evidence: evidences,
              };
            }
            if (!BUILTIN_COLLECTION_PROTOTYPE_METHODS.has(methodName)) {
              if (rootIdentNode) {
                const reqDecl = findLocalVariableDeclaration(rootIdentNode);
                if (reqDecl) {
                  const reqStart = reqDecl.getStart(sourceFile);
                  const { line: reqLine } = sourceFile.getLineAndCharacterOfPosition(reqStart);
                  evidences.push({
                    filePath: callEvidence.filePath,
                    lineNumber: reqLine + 1,
                    snippet: reqDecl.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                    evidenceRole: 'import-match',
                  });
                }
              }
              const cjsMemberPath =
                !targetReqPath && receiverSegments.length > 0 && !receiverSegments.includes('*')
                  ? `${receiverSegments.join('.')}.${methodName}`
                  : methodName;
              return {
                id: nextId(),
                name: `Call: ${rootText}.${cjsMemberPath}()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL',
                patternId: 'relationship.member-call',
                sourceId,
                status: 'INFERRED',
                confidence: 'MEDIUM',
                evidence: evidences,
                metadata: {
                  unresolvedReason: 'unextracted-target-contract',
                  importSpecifier: reqBinding.moduleSpecifier,
                  resolvedFilePath: (targetReqPath ?? resolvedReqPath).replace(/\\/g, '/'),
                  targetSymbol: cjsMemberPath,
                },
              };
            }
          }
        }
      }

      const publicMethodTarget = resolvePublicMethodTarget(node, sourceFile, repoRoot, workspaceRegistry);
      if (!publicMethodTarget && rootIdentNode) {
        const localFromCall = resolveLocalFromCallTarget(
          rootIdentNode,
          node,
          sourceFile,
          repoRoot,
          workspaceRegistry
        );
        if (localFromCall) {
          evidences.push({
            filePath: callEvidence.filePath,
            lineNumber: localFromCall.declLine,
            snippet: localFromCall.declSnippet,
            evidenceRole: 'import-match',
          });
          if (localFromCall.targetEvidence) {
            evidences.push(localFromCall.targetEvidence);
          }
          return {
            id: nextId(),
            name: `Call: ${rootText}.${methodName}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.invoke-returned-function',
            sourceId,
            targetId:
              localFromCall.targetId ??
              resolveExternalPackageTarget(node.expression, sourceFile, repoRoot, workspaceRegistry),
            status: localFromCall.status,
            confidence: localFromCall.confidence,
            evidence: evidences,
          };
        }
      }

      // No matching ES import: the target is only proven when the receiver class is deterministic
      // (→ Public Method) or the root identifier was `require`d from an external package.
      const localClassMethod = !hasCallInReceiverChain
        ? resolveClassMethodTargetWithEvidence(node, sourceFile, repoRoot, workspaceRegistry)
        : null;
      if (localClassMethod) {
        evidences.push(localClassMethod.targetEvidence);
      }
      const externalTarget = resolveExternalPackageTarget(node.expression, sourceFile, repoRoot, workspaceRegistry);
      const isLocalFnRoot = getRelationshipFileIndex(sourceFile).localFunctionDecls.has(rootText);
      const sameFileCjsAlias =
        !localClassMethod &&
        !publicMethodTarget &&
        !externalTarget &&
        !hasCallInReceiverChain &&
        isLocalFnRoot &&
        receiverSegments.length === 0
          ? resolveCjsContractInSourceFile(
              sourceFile,
              methodName,
              path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName,
              repoRoot,
              workspaceRegistry
            )
          : null;
      const isDisallowedChainPrototypeMethod =
        BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName) ||
        (BUILTIN_VALUE_PROTOTYPE_METHODS.has(methodName) &&
          (receiverSegments.length === 0 ||
            (methodName !== 'get' && methodName !== 'set' && methodName !== 'delete')));
      const sameFileChainFn =
        !localClassMethod && !publicMethodTarget && !externalTarget
          ? sameFileCjsAlias ??
            (((hasCallInReceiverChain && !isDisallowedChainPrototypeMethod) ||
              (!hasCallInReceiverChain && isLocalFnRoot)) &&
            rootIdentNode
              ? resolveSameFileExportedFunction(rootText, rootIdentNode, sourceFile, repoRoot, workspaceRegistry)
              : null)
          : null;
      if (sameFileChainFn) {
        evidences.push(sameFileChainFn.targetEvidence);
      }
      const targetId = localClassMethod?.targetId ?? publicMethodTarget ?? externalTarget ?? sameFileChainFn?.targetId;

      if (
        !targetId &&
        (BUILTIN_DOM_ITERATOR_REFLECTION_METHODS.has(methodName) ||
          (BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName) &&
            ts.isElementAccessExpression(unwrapTransparentExpr(memberAccess.expression))))
      ) {
        return null;
      }

      if (!targetId && BUILTIN_VALUE_PROTOTYPE_METHODS.has(methodName) && rootText === 'this') {
        const calleeName =
          receiverSegments.length > 0
            ? `${rootText}.${receiverSegments.join('.')}.${methodName}`
            : `${rootText}.${methodName}`;
        return {
          id: nextId(),
          name: `Call: ${calleeName}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.function-call',
          sourceId,
          status: 'INFERRED',
          confidence: 'LOW',
          evidence: evidences,
        };
      }

      if (!targetId && rootIdentNode && !BUILTIN_COLLECTION_PROTOTYPE_METHODS.has(methodName)) {
        let isLoopOrMapElem = false;
        for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
          if (ts.isForOfStatement(cur) || ts.isForInStatement(cur)) {
            isLoopOrMapElem = true;
            break;
          }
        }
        if (isLoopOrMapElem) {
          const candidateSfs: Array<{ sf: ts.SourceFile; sfRelPath: string }> = [
            { sf: sourceFile, sfRelPath: path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName },
          ];
          for (const stmt of sourceFile.statements) {
            if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
              const spec = stmt.moduleSpecifier.text;
              if (!isExternalSpecifier(spec, sourceFile.fileName, repoRoot, workspaceRegistry)) {
                const resMod = resolveModulePath(spec, sourceFile.fileName, repoRoot, workspaceRegistry);
                if (resMod) {
                  const impSf = getCachedSourceFile(path.resolve(repoRoot, resMod));
                  if (impSf) {
                    candidateSfs.push({ sf: impSf, sfRelPath: resMod });
                  }
                }
              }
            }
          }
          const dispatchEdges: StructuralEntity[] = [];
          const seenTargets = new Set<string>();
          for (const { sf, sfRelPath } of candidateSfs) {
            const walkDispatch = (n: ts.Node): void => {
              if (
                ts.isPropertyAssignment(n) &&
                (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
                n.name.text === methodName &&
                ts.isIdentifier(n.initializer) &&
                n.parent &&
                ts.isObjectLiteralExpression(n.parent) &&
                n.parent.parent &&
                ts.isPropertyAssignment(n.parent.parent)
              ) {
                const ref = resolveFunctionContractReference(
                  n.initializer,
                  n,
                  sf,
                  () => ({ filePath: sfRelPath, lineNumber: 1, snippet: '' }),
                  repoRoot,
                  workspaceRegistry
                );
                if (ref && !seenTargets.has(ref.targetId)) {
                  seenTargets.add(ref.targetId);
                  dispatchEdges.push({
                    id: nextId(),
                    name: `Call: ${rootText}.${methodName}()`,
                    type: 'RELATIONSHIP',
                    entityType: 'CALL',
                    patternId: 'relationship.function-call',
                    sourceId,
                    targetId: ref.targetId,
                    status: 'INFERRED',
                    confidence: 'HIGH',
                    evidence: [...evidences, ...ref.evidences],
                  });
                }
              }
              ts.forEachChild(n, walkDispatch);
            };
            walkDispatch(sf);
          }
          if (dispatchEdges.length > 0) {
            return dispatchEdges.length === 1 ? dispatchEdges[0] : dispatchEdges;
          }
        }
      }

      return {
        id: nextId(),
        name: `Call: ${rootText}.${methodName}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL', patternId: 'relationship.invoke-returned-function',
        sourceId,
        targetId,
        status: 'INFERRED',
        confidence: localClassMethod || publicMethodTarget || sameFileChainFn ? 'HIGH' : 'LOW',
        evidence: evidences,
      };
    }
  }

  // Dynamic bracket dispatch (`dispatchTable[key](args)`) on an imported or same-file exported dispatch table
  if (
    ts.isCallExpression(node) &&
    ts.isElementAccessExpression(node.expression) &&
    !memberAccess &&
    ts.isIdentifier(node.expression.expression)
  ) {
    const tableIdent = node.expression.expression;
    const tableName = tableIdent.text;
    const callEvidence = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
    const binding = findValueModuleBinding(sourceFile, tableName);
    if (binding) {
      const resolvedPath = resolveModulePath(
        binding.moduleSpecifier,
        sourceFile.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedPath) {
        const lookupSymbol =
          binding.importedName && binding.importedName !== '*'
            ? binding.importedName
            : tableName;
        const res = resolveTargetExport(
          resolvedPath,
          lookupSymbol,
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function'
        );
        if (res) {
          return {
            id: nextId(),
            name: `Call: ${tableName}[]()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.function-call',
            sourceId,
            targetId: res.targetId,
            status: 'INFERRED',
            confidence: 'HIGH',
            evidence: [callEvidence, res.targetEvidence],
          };
        }
      }
    } else {
      const sameFileTable = resolveSameFileExportedFunction(
        tableName,
        node,
        sourceFile,
        repoRoot,
        workspaceRegistry,
        true
      );
      if (sameFileTable) {
        return {
          id: nextId(),
          name: `Call: ${tableName}[]()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.function-call',
          sourceId,
          targetId: sameFileTable.targetId,
          status: 'INFERRED',
          confidence: 'HIGH',
          evidence: [callEvidence, sameFileTable.targetEvidence],
        };
      }
    }
  }

  // Inferred Function Calls (e.g. createUser())
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    if (unwrapLazyImport(node)) return null;

    const rootText = node.expression.text;
    const requestValBinding = rootText === 'request' ? findValueModuleBinding(sourceFile, 'request') : undefined;
    const isLocalCustomRequestFn =
      rootText === 'request' &&
      (getSourceFileDeclarationIndex(sourceFile).functionDeclsByName.has('request') ||
        Boolean(
          requestValBinding &&
            !isExternalSpecifier(
              requestValBinding.moduleSpecifier,
              sourceFile.fileName,
              repoRoot,
              workspaceRegistry
            )
        ));

    // Standalone CommonJS side-effect require (`require('ts-node/register'); require('./src/main');`)
    if (
      rootText === 'require' &&
      node.parent &&
      ts.isExpressionStatement(node.parent) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const specifier = node.arguments[0].text;
      const callEv = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
      if (isExternalSpecifier(specifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
        return {
          id: nextId(),
          name: `Call: require()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.function-call',
          sourceId,
          targetId: packageConnectorId(specifier),
          status: 'DETERMINISTIC',
          confidence: 'HIGH',
          evidence: [callEv],
        };
      }
      const resolvedReqPath = resolveModulePath(specifier, sourceFile.fileName, repoRoot, workspaceRegistry);
      if (resolvedReqPath) {
        const res = resolveTargetExport(
          resolvedReqPath,
          'default',
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function'
        );
        if (res) {
          return {
            id: nextId(),
            name: `Call: require()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.function-call',
            sourceId,
            targetId: res.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: [callEv, res.targetEvidence],
          };
        }
        const targetDuScope = resolveLogicalBoundaryScope(resolvedReqPath, repoRoot, workspaceRegistry);
        const reqSf = getCachedSourceFile(path.resolve(repoRoot, resolvedReqPath));
        if (reqSf) {
          const reqIdx = getSourceFileDeclarationIndex(reqSf);
          if (reqIdx.topLevelClassNames.size > 0) {
            const classEdges: StructuralEntity[] = [];
            for (const clsName of reqIdx.topLevelClassNames) {
              classEdges.push({
                id: nextId(),
                name: `Call: require()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL',
                patternId: 'relationship.function-call',
                sourceId,
                targetId: boundaryEntityId(targetDuScope, resolvedReqPath, `Class: ${clsName}`),
                status: 'DETERMINISTIC',
                confidence: 'HIGH',
                evidence: [callEv],
              });
            }
            return classEdges.length === 1 ? classEdges[0] : classEdges;
          }
        }
        const callerRelFile = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
        const callerDuScope = resolveLogicalBoundaryScope(callerRelFile, repoRoot, workspaceRegistry);
        if (targetDuScope === callerDuScope) {
          return null;
        }
        const initTargetId = stableEntityId(`init:${targetDuScope}`, 'BOUNDARY', `Init: ${targetDuScope}`);
        return {
          id: nextId(),
          name: `Call: require()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.function-call',
          sourceId,
          targetId: initTargetId,
          status: 'DETERMINISTIC',
          confidence: 'HIGH',
          evidence: [callEv],
        };
      }
    }

    // Skip known open connectors or require
    if (
      rootText === 'require' ||
      (!isLocalCustomRequestFn && HTTP_CLIENT_IDENTIFIERS.has(rootText)) ||
      DB_CLIENT_IDENTIFIERS.has(rootText)
    ) {
      return null;
    }

      // Check if it matches a local import (or a parameter default value referencing an import)
      const directImport = getRelationshipFileIndex(sourceFile).importDeclByLocalName.get(rootText) ?? null;
      const defaultParamIdent = !directImport ? findEnclosingParameterDefaultIdentifier(node, rootText) : null;
      const effectiveLookupName = defaultParamIdent ? defaultParamIdent.text : rootText;
      const matchingImport =
        directImport ??
        (defaultParamIdent
          ? (getRelationshipFileIndex(sourceFile).importDeclByLocalName.get(defaultParamIdent.text) ?? null)
          : null);

      const callEvidence = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
      const evidences: EvidenceRecord[] = [callEvidence];

      const importLiteral = getImportDeclarationSpecifier(matchingImport);

      if (
        (rootText === 'useLoaderData' || rootText === 'useActionData') &&
        /(?:^|\/)app\/(?:routes\/.*|root)\.[tj]sx?$/i.test((callEvidence.filePath ?? '').replace(/\\/g, '/'))
      ) {
        const remixTargetName = rootText === 'useLoaderData' ? 'loader' : 'action';
        const remixTarget = resolveSameFileExportedFunction(
          remixTargetName,
          node.expression,
          sourceFile,
          repoRoot,
          workspaceRegistry
        );
        if (remixTarget) {
          return {
            id: nextId(),
            name: `Call: ${rootText}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.function-call',
            sourceId,
            targetId: remixTarget.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: [callEvidence, remixTarget.targetEvidence],
          };
        }
      }

      if (
        /(?:^|\/)routes\.[tj]sx?$/i.test((callEvidence.filePath ?? '').replace(/\\/g, '/')) &&
        (rootText === 'index' || rootText === 'route' || rootText === 'layout')
      ) {
        const routesConfigEdges = extractFrameworkBareCallRelationship(
          node,
          sourceFile,
          getEvidence,
          nextId,
          repoRoot,
          sourceId,
          workspaceRegistry
        );
        if (routesConfigEdges) return routesConfigEdges;
      }

      if (matchingImport && importLiteral) {
        const importStart = matchingImport.getStart(sourceFile);
        const { line: importLine } = sourceFile.getLineAndCharacterOfPosition(importStart);
        
        evidences.push({
          filePath: callEvidence.filePath,
          lineNumber: importLine + 1,
          snippet: matchingImport.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
          evidenceRole: 'import-match'
        });

        const resolvedPath = resolveModulePath(importLiteral, sourceFile.fileName, repoRoot, workspaceRegistry);
        if (resolvedPath) {
          // v4: files are never targets — the target is only set when the exported contract is proven.
          const binding = findValueModuleBinding(sourceFile, effectiveLookupName);
          const lookupSymbol =
            binding?.importedName && binding.importedName !== 'default' && binding.importedName !== '*'
              ? binding.importedName
              : effectiveLookupName;
        const res =
          resolveTargetExport(resolvedPath, lookupSymbol, repoRoot, workspaceRegistry ?? {}, 'Exported Function') ??
          (binding?.importedName === 'default'
            ? resolveTargetExport(resolvedPath, 'default', repoRoot, workspaceRegistry ?? {}, 'Exported Function')
            : null);
        if (res) {
          evidences.push(res.targetEvidence);
          const httpArgsMeta = extractHttpCallArgsMetadata(node);
          return {
            id: nextId(),
            name: `Call: ${rootText}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL', patternId: 'relationship.function-call',
            sourceId,
            targetId: res.targetId,
            status: 'INFERRED',
            confidence: 'HIGH',
            evidence: evidences,
            ...(httpArgsMeta ? { metadata: httpArgsMeta } : {}),
          };
        } else {
          return {
            id: nextId(),
            name: `Call: ${rootText}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL', patternId: 'relationship.function-call',
            sourceId,
            status: 'INFERRED',
            confidence: 'MEDIUM',
            evidence: evidences,
          };
        }
      } else {
        return {
          id: nextId(),
          name: `Call: ${rootText}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL', patternId: 'relationship.inferred-method-call',
          sourceId,
          targetId: isExternalSpecifier(importLiteral, sourceFile.fileName, repoRoot, workspaceRegistry)
            ? packageConnectorId(importLiteral)
            : undefined,
          status: 'INFERRED',
          confidence: 'MEDIUM',
          evidence: evidences,
        };
      }
    }

    // Check CommonJS `require('./...')` or dynamic `await import('./...')` function / member bindings
    const reqBinding = findValueModuleBinding(sourceFile, rootText);
    if (reqBinding && (reqBinding.kind === 'require' || (!matchingImport && !reqBinding.lazyWrapper))) {
      const resolvedReqPath = resolveModulePath(
        reqBinding.moduleSpecifier,
        sourceFile.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedReqPath) {
        const lookupSymbol =
          reqBinding.importedName && reqBinding.importedName !== '*'
            ? reqBinding.importedName
            : 'default';
        const res = resolveTargetExport(
          resolvedReqPath,
          lookupSymbol,
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function'
        );
        if (res) {
          evidences.push(res.targetEvidence);
          const httpArgsMeta = extractHttpCallArgsMetadata(node);
          return {
            id: nextId(),
            name: `Call: ${rootText}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL', patternId: 'relationship.function-call',
            sourceId,
            targetId: res.targetId,
            status: 'INFERRED',
            confidence: 'HIGH',
            evidence: evidences,
            ...(httpArgsMeta ? { metadata: httpArgsMeta } : {}),
          };
        }
        const reqDecl = findLocalVariableDeclaration(node.expression);
        if (reqDecl) {
          const reqStart = reqDecl.getStart(sourceFile);
          const { line: reqLine } = sourceFile.getLineAndCharacterOfPosition(reqStart);
          evidences.push({
            filePath: callEvidence.filePath,
            lineNumber: reqLine + 1,
            snippet: reqDecl.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
            evidenceRole: 'import-match',
          });
        }
        return {
          id: nextId(),
          name: `Call: ${rootText}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.function-call',
          sourceId,
          status: 'INFERRED',
          confidence: 'MEDIUM',
          evidence: evidences,
          metadata: {
            unresolvedReason: 'unextracted-target-contract',
            importSpecifier: reqBinding.moduleSpecifier,
            resolvedFilePath: resolvedReqPath.replace(/\\/g, '/'),
            targetSymbol: lookupSymbol === 'default' ? rootText : lookupSymbol,
          },
        };
      }
    }

    // [PAT-EXT-21] & [PAT-EXT-13] Same-File Exported Function Call Resolution:
    // When a bare function call has no import declaration, check if the symbol is an exported
    // function (FunctionDeclaration, ArrowFunction/FunctionExpression VariableStatement, or
    // local ExportDeclaration) in the same SourceFile (excluding recursive self-calls).
    const sameFileTarget = resolveSameFileExportedFunction(rootText, node, sourceFile, repoRoot, workspaceRegistry);
    if (sameFileTarget) {
      evidences.push(sameFileTarget.targetEvidence);
      const httpArgsMeta = extractHttpCallArgsMetadata(node);
      return {
        id: nextId(),
        name: `Call: ${rootText}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL', patternId: 'relationship.function-call',
        sourceId,
        targetId: sameFileTarget.targetId,
        status: 'INFERRED',
        confidence: 'HIGH',
        evidence: evidences,
        ...(httpArgsMeta ? { metadata: httpArgsMeta } : {}),
      };
    }

    // Factory Return Invocation Resolution (`const x = factory(); x()`, sk1/CALL/LocalFromCall/Id):
    const localFromCall = resolveLocalFromCallTarget(
      node.expression,
      node,
      sourceFile,
      repoRoot,
      workspaceRegistry
    );
    if (localFromCall) {
      evidences.push({
        filePath: callEvidence.filePath,
        lineNumber: localFromCall.declLine,
        snippet: localFromCall.declSnippet,
        evidenceRole: 'import-match',
      });
      if (localFromCall.targetEvidence) {
        evidences.push(localFromCall.targetEvidence);
      }
      return {
        id: nextId(),
        name: `Call: ${rootText}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.invoke-returned-function',
        sourceId,
        targetId: localFromCall.targetId,
        status: localFromCall.status,
        confidence: localFromCall.confidence,
        evidence: evidences,
      };
    }

    const frameworkBareCall = extractFrameworkBareCallRelationship(
      node,
      sourceFile,
      getEvidence,
      nextId,
      repoRoot,
      sourceId,
      workspaceRegistry
    );
    if (frameworkBareCall) return frameworkBareCall;

    return {
      id: nextId(),
      name: `Call: ${rootText}()`,
      type: 'RELATIONSHIP',
      entityType: 'CALL', patternId: 'relationship.invoke-returned-function',
      sourceId,
      targetId: resolveExternalPackageTarget(node.expression, sourceFile, repoRoot, workspaceRegistry),
      status: 'INFERRED',
      confidence: 'LOW',
      evidence: evidences,
    };
  }

  // Tagged Template Literal Call (`html\`<div>...</div>\``)
  if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag)) {
    const tagText = node.tag.text;
    if (
      tagText !== 'styled' &&
      tagText !== 'css' &&
      tagText !== 'keyframes' &&
      tagText !== 'createGlobalStyle' &&
      tagText !== 'sql' &&
      !HTTP_CLIENT_IDENTIFIERS.has(tagText) &&
      !DB_CLIENT_IDENTIFIERS.has(tagText)
    ) {
      const ref = resolveFunctionContractReference(
        node.tag,
        node,
        sourceFile,
        getEvidence,
        repoRoot,
        workspaceRegistry
      );
      if (ref) {
        return {
          id: nextId(),
          name: `Call: ${tagText}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.function-call',
          sourceId,
          targetId: ref.targetId,
          status: 'INFERRED',
          confidence: 'HIGH',
          evidence: ref.evidences,
        };
      }
    }
  }

  // [PAT-EXT-16] Class Instantiation (`new ClassName()`) targeting a local/imported Class boundary or external package
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    const className = node.expression.text;
    for (const stmt of sourceFile.statements) {
      if (
        ts.isClassDeclaration(stmt) &&
        stmt.name?.text === className &&
        stmt.members.some(m => ts.isConstructorDeclaration(m))
      ) {
        const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
        const targetScope = resolveLogicalBoundaryScope(
          relPath,
          repoRoot,
          workspaceRegistry,
          findEnclosingNamespaceScope(stmt)
        );
        const targetId = boundaryEntityId(targetScope, relPath, `Class: ${className}`);
        const start = stmt.getStart(sourceFile);
        const { line: targetLine } = sourceFile.getLineAndCharacterOfPosition(start);
        return {
          id: nextId(),
          name: `Call: new ${className}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.class-instantiation',
          sourceId,
          targetId,
          status: 'DETERMINISTIC',
          confidence: 'HIGH',
          evidence: [
            { ...getEvidence(node), evidenceRole: 'syntax-call' },
            {
              filePath: relPath,
              lineNumber: targetLine + 1,
              snippet: stmt.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
              evidenceRole: 'target-signature',
            },
          ],
        };
      }
    }

    const schematicTaskEdge = extractAngularSchematicTaskRelationship(
      node,
      sourceFile,
      getEvidence,
      nextId,
      repoRoot,
      sourceId,
      workspaceRegistry
    );
    if (schematicTaskEdge) return schematicTaskEdge;

    const binding = findValueModuleBinding(sourceFile, className);
    if (binding && isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
      return {
        id: nextId(),
        name: `Call: new ${className}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.function-call',
        sourceId,
        targetId: packageConnectorId(binding.moduleSpecifier),
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: [{ ...getEvidence(node), evidenceRole: 'syntax-call' }],
      };
    }

    const isInstanceUsedInFile = (() => {
      const parent = node.parent;
      let assignedIdent: string | null = null;
      let assignedThisProp: string | null = null;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        assignedIdent = parent.name.text;
      } else if (parent && ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
        assignedThisProp = parent.name.text;
      } else if (
        parent &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === node
      ) {
        if (ts.isIdentifier(parent.left)) {
          assignedIdent = parent.left.text;
        } else if (
          ts.isPropertyAccessExpression(parent.left) &&
          parent.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          let insideMethod = false;
          for (let cur: ts.Node | undefined = parent.parent; cur && cur !== sourceFile; cur = cur.parent) {
            if (ts.isMethodDeclaration(cur)) {
              insideMethod = true;
              break;
            }
            if (ts.isConstructorDeclaration(cur) || ts.isClassDeclaration(cur)) break;
          }
          if (!insideMethod) {
            assignedThisProp = parent.left.name.text;
          }
        }
      }
      if (!assignedIdent && !assignedThisProp) return false;
      let foundUsage = false;
      let scanRoot: ts.Node = sourceFile;
      if (assignedIdent) {
        for (let cur: ts.Node | undefined = node.parent; cur && cur !== sourceFile; cur = cur.parent) {
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur) ||
            ts.isConstructorDeclaration(cur)
          ) {
            scanRoot = cur;
            break;
          }
        }
      }
      const walk = (n: ts.Node) => {
        if (foundUsage) return;
        if (
          ts.isPropertyAccessExpression(n) &&
          n.parent &&
          ts.isCallExpression(n.parent) &&
          n.parent.expression === n
        ) {
          if (
            assignedIdent &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === assignedIdent &&
            Boolean(resolvePublicMethodTarget(n.parent, sourceFile, repoRoot, workspaceRegistry))
          ) {
            foundUsage = true;
            return;
          }
          if (
            assignedThisProp &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
            n.expression.name.text === assignedThisProp &&
            Boolean(resolvePublicMethodTarget(n.parent, sourceFile, repoRoot, workspaceRegistry))
          ) {
            foundUsage = true;
            return;
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(scanRoot);
      return foundUsage;
    })();

    const importedClassTarget = resolveImportedClassBoundaryTargetWithEvidence(
      className,
      sourceFile,
      repoRoot,
      workspaceRegistry,
      undefined,
      !isInstanceUsedInFile
    );
    if (importedClassTarget) {
      return {
        id: nextId(),
        name: `Call: new ${className}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.function-call',
        sourceId,
        targetId: importedClassTarget.targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: [
          { ...getEvidence(node), evidenceRole: 'syntax-call' },
          importedClassTarget.targetEvidence,
        ],
      };
    }
  }

  // `new (require('koa'))()` or `new (require('./myClass'))()`
  if (ts.isNewExpression(node) && !ts.isIdentifier(node.expression)) {
    const req = unwrapRequire(node.expression);
    if (req) {
      const callEv = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
      if (isExternalSpecifier(req.specifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
        return {
          id: nextId(),
          name: `Call: new require(${req.specifier})()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.function-call',
          sourceId,
          targetId: packageConnectorId(req.specifier),
          status: 'DETERMINISTIC',
          confidence: 'HIGH',
          evidence: [callEv],
        };
      }
      const resolvedReqPath = resolveModulePath(req.specifier, sourceFile.fileName, repoRoot, workspaceRegistry);
      if (resolvedReqPath) {
        const lookupSymbol = req.member ?? 'default';
        const viaBoundary = resolveClassBoundaryInModule(
          resolvedReqPath,
          lookupSymbol,
          repoRoot,
          workspaceRegistry,
          0,
          new Set(),
          true
        );
        if (viaBoundary) {
          return {
            id: nextId(),
            name: `Call: new require(${req.specifier})()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.function-call',
            sourceId,
            targetId: viaBoundary.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: [callEv, viaBoundary.targetEvidence],
          };
        }
      }
    }
  }

  if (
    ts.isNewExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression)
  ) {
    const nsName = node.expression.expression.text;
    const className = node.expression.name.text;
    const binding = findValueModuleBinding(sourceFile, nsName);
    if (binding && isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
      return {
        id: nextId(),
        name: `Call: new ${nsName}.${className}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.function-call',
        sourceId,
        targetId: packageConnectorId(binding.moduleSpecifier),
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: [{ ...getEvidence(node), evidenceRole: 'syntax-call' }],
      };
    }
    const importedNsClassTarget = resolveImportedClassBoundaryTargetWithEvidence(
      nsName,
      sourceFile,
      repoRoot,
      workspaceRegistry,
      className
    );
    if (importedNsClassTarget) {
      return {
        id: nextId(),
        name: `Call: new ${nsName}.${className}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.function-call',
        sourceId,
        targetId: importedNsClassTarget.targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: [
          { ...getEvidence(node), evidenceRole: 'syntax-call' },
          importedNsClassTarget.targetEvidence,
        ],
      };
    }
  }

  // Inferred Invocation of a Returned Function (e.g. passport.authenticate(...)() or require('...')())
  if (ts.isCallExpression(node) && ts.isCallExpression(node.expression)) {
    const innerCall = node.expression;
    let innerName = 'Function';
    if (ts.isIdentifier(innerCall.expression)) {
      innerName = innerCall.expression.text;
    } else if (ts.isPropertyAccessExpression(innerCall.expression)) {
      innerName = innerCall.expression.name.text;
    }

    const callEvidence = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
    const evidences: EvidenceRecord[] = [callEvidence];

    const directReq = unwrapRequire(innerCall);
    if (directReq && !directReq.member) {
      const resolvedReqPath = resolveModulePath(
        directReq.specifier,
        sourceFile.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedReqPath) {
        const res = resolveTargetExport(
          resolvedReqPath,
          'default',
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function'
        );
        if (res) {
          evidences.push(res.targetEvidence);
          return {
            id: nextId(),
            name: `Call: ${innerName}()()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.invoke-required-function',
            sourceId,
            targetId: res.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: evidences,
          };
        }
      }
    }

    const rootIdentNode = getChainRootIdentifierNode(innerCall.expression);
    if (rootIdentNode) {
      const sameFileFn = resolveSameFileExportedFunction(
        rootIdentNode.text,
        rootIdentNode,
        sourceFile,
        repoRoot,
        workspaceRegistry
      );
      if (sameFileFn) {
        evidences.push(sameFileFn.targetEvidence);
        return {
          id: nextId(),
          name: `Call: ${innerName}()()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.invoke-returned-function',
          sourceId,
          targetId: sameFileFn.targetId,
          status: 'INFERRED',
          confidence: 'HIGH',
          evidence: evidences,
        };
      }

      const binding = findValueModuleBinding(sourceFile, rootIdentNode.text);
      if (
        binding &&
        !isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
      ) {
        const resolvedModPath = resolveModulePath(
          binding.moduleSpecifier,
          sourceFile.fileName,
          repoRoot,
          workspaceRegistry
        );
        if (resolvedModPath) {
          const lookupSymbol =
            binding.importedName &&
            binding.importedName !== '*' &&
            binding.importedName !== 'default'
              ? binding.importedName
              : rootIdentNode.text;
          const propAccess = getPropertyOrElementAccess(innerCall.expression);
          const importedTarget =
            (propAccess
              ? resolveImportedObjectMember(
                  resolvedModPath,
                  lookupSymbol,
                  propAccess.memberName,
                  repoRoot,
                  workspaceRegistry ?? {}
                )
              : null) ??
            resolveTargetExport(
              resolvedModPath,
              lookupSymbol,
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function'
            ) ??
            (binding.importedName === 'default'
              ? resolveTargetExport(
                  resolvedModPath,
                  'default',
                  repoRoot,
                  workspaceRegistry ?? {},
                  'Exported Function'
                )
              : null);
          if (importedTarget) {
            evidences.push(importedTarget.targetEvidence);
            return {
              id: nextId(),
              name: `Call: ${innerName}()()`,
              type: 'RELATIONSHIP',
              entityType: 'CALL',
              patternId: 'relationship.invoke-returned-function',
              sourceId,
              targetId: importedTarget.targetId,
              status: 'INFERRED',
              confidence: 'HIGH',
              evidence: evidences,
            };
          }
        }
      }
    }

    const extTarget = resolveExternalPackageTarget(innerCall, sourceFile, repoRoot, workspaceRegistry);
    if ((innerName === 'Function' || innerName === 'constructor') && !extTarget) {
      return null;
    }
    const publicMethodTarget = !extTarget
      ? resolvePublicMethodTarget(innerCall, sourceFile, repoRoot, workspaceRegistry)
      : undefined;
    if (
      !extTarget &&
      !publicMethodTarget &&
      innerName === 'get' &&
      rootIdentNode &&
      (getSourceFileDeclarationIndex(sourceFile).newClassByPropName.get(rootIdentNode.text) === 'Map' ||
        getSourceFileDeclarationIndex(sourceFile).newClassByPropName.get(rootIdentNode.text) === 'WeakMap')
    ) {
      return null;
    }

    return {
      id: nextId(),
      name: `Call: ${innerName}()()`,
      type: 'RELATIONSHIP',
      entityType: 'CALL',
      patternId: publicMethodTarget
        ? 'relationship.invoke-returned-function'
        : 'relationship.invoke-required-function',
      sourceId,
      targetId: extTarget ?? publicMethodTarget,
      status: 'INFERRED',
      confidence: publicMethodTarget ? 'HIGH' : 'LOW',
      evidence: evidences,
    };
  }

  // [PAT-EXT-15] Object / Map Dispatch Table Function References (`const handlers = { cmd: fn, shorthandFn, getById: repo.getById }`)
  if (
    ((ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.initializer) ||
        (ts.isPropertyAccessExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)))) ||
      ts.isShorthandPropertyAssignment(node)) &&
    node.parent &&
    ts.isObjectLiteralExpression(node.parent)
  ) {
    let isStaticConventionTable =
      Boolean(node.parent.parent && ts.isExportAssignment(node.parent.parent));
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (
        ts.isVariableDeclaration(cur) &&
        cur.type &&
        ts.isTypeReferenceNode(cur.type) &&
        cur.type.typeName.getText(sourceFile).endsWith('ConventionSet')
      ) {
        isStaticConventionTable = true;
        break;
      }
    }
    if (!isStaticConventionTable) {
      if (ts.isPropertyAssignment(node) && ts.isPropertyAccessExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
        const objIdent = node.initializer.expression;
        const memberName = node.initializer.name.text;
        const hasTopLevelImport = getRelationshipFileIndex(sourceFile).importDeclByLocalName.has(objIdent.text);
        const binding = hasTopLevelImport ? findValueModuleBinding(sourceFile, objIdent.text) : undefined;
        if (binding && !isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
          const resolvedPath = resolveModulePath(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry);
          if (resolvedPath) {
            const lookupSymbol =
              binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
                ? binding.importedName
                : objIdent.text;
            const delegatedMember =
              (binding.importedName !== '*'
                ? resolveImportedObjectMember(
                    resolvedPath,
                    lookupSymbol,
                    memberName,
                    repoRoot,
                    workspaceRegistry ?? {},
                    [],
                    0,
                    new Set<string>(),
                    true
                  ) ??
                  (binding.importedName === 'default' && lookupSymbol !== 'default'
                    ? resolveImportedObjectMember(
                        resolvedPath,
                        'default',
                        memberName,
                        repoRoot,
                        workspaceRegistry ?? {},
                        [],
                        0,
                        new Set<string>(),
                        true
                      )
                    : null)
                : null) ??
              resolveTargetExport(
                resolvedPath,
                memberName,
                repoRoot,
                workspaceRegistry ?? {},
                'Exported Function'
              ) ??
              resolveImportedClassBoundaryTargetWithEvidence(
                objIdent.text,
                sourceFile,
                repoRoot,
                workspaceRegistry,
                undefined,
                true
              );
            if (delegatedMember) {
              return {
                id: nextId(),
                name: `Call: ${objIdent.text}.${memberName}()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL',
                patternId: 'relationship.dispatch-table-reference',
                sourceId,
                targetId: delegatedMember.targetId,
                status: 'INFERRED',
                confidence: 'HIGH',
                evidence: [{ ...getEvidence(node), evidenceRole: 'syntax-call' }, delegatedMember.targetEvidence],
              };
            }
          }
        }
      } else {
        const ident = ts.isPropertyAssignment(node) ? (node.initializer as ts.Identifier) : node.name;
        const ref = resolveFunctionContractReference(
          ident,
          node,
          sourceFile,
          getEvidence,
          repoRoot,
          workspaceRegistry
        );
        if (ref) {
          return {
            id: nextId(),
            name: `Call: ${ident.text}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.dispatch-table-reference',
            sourceId,
            targetId: ref.targetId,
            status: 'INFERRED',
            confidence: 'HIGH',
            evidence: ref.evidences,
          };
        }
      }
    }
  }

  // Class property initialized with an imported/exported function reference (`class Router { getUrl = getUrl }`)
  if (
    ts.isPropertyDeclaration(node) &&
    node.initializer &&
    ts.isIdentifier(node.initializer)
  ) {
    const ref = resolveFunctionContractReference(
      node.initializer,
      node,
      sourceFile,
      getEvidence,
      repoRoot,
      workspaceRegistry
    );
    if (ref) {
      return {
        id: nextId(),
        name: `Call: ${node.initializer.text}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.dispatch-table-reference',
        sourceId,
        targetId: ref.targetId,
        status: 'INFERRED',
        confidence: 'HIGH',
        evidence: ref.evidences,
      };
    }
  }

  // JSX Attribute Function / Server Action Reference (`<form action={deleteItem}>`, `<Button formAction={fn}>`)
  if (
    ts.isJsxAttribute(node) &&
    node.initializer &&
    ts.isJsxExpression(node.initializer) &&
    node.initializer.expression &&
    ts.isIdentifier(node.initializer.expression)
  ) {
    const ident = node.initializer.expression;
    const ref = resolveFunctionContractReference(
      ident,
      node,
      sourceFile,
      getEvidence,
      repoRoot,
      workspaceRegistry
    );
    if (ref) {
      const attrName = ts.isIdentifier(node.name) ? node.name.text : '';
      const isActionOrHandlerAttr =
        attrName === 'action' ||
        attrName === 'formAction' ||
        /^on[A-Z]/.test(attrName);
      const isMdxOrComponentRef =
        !isActionOrHandlerAttr &&
        (ref.evidences.some((ev) => isMdxOrAstroFilePath(ev.filePath)) ||
          /^[A-Z]/.test(ident.text));
      if (isMdxOrComponentRef) {
        return {
          id: nextId(),
          name: `Renders: <${ident.text} />`,
          type: 'RELATIONSHIP',
          entityType: 'RENDERS',
          patternId: 'relationship.jsx-element',
          sourceId,
          targetId: ref.targetId,
          status: 'INFERRED',
          confidence: 'HIGH',
          evidence: ref.evidences,
        };
      }
      return {
        id: nextId(),
        name: `Call: ${ident.text}()`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.function-call',
        sourceId,
        targetId: ref.targetId,
        status: 'INFERRED',
        confidence: 'HIGH',
        evidence: ref.evidences,
        metadata: { shapeKey: computeIdentifierRefShapeKey(ident, { repoRoot, workspaceRegistry }) },
      };
    }
    const modRef = resolveDefaultExportedModuleContractReference(
      ident,
      node,
      sourceFile,
      getEvidence,
      repoRoot,
      workspaceRegistry
    );
    if (modRef) {
      return {
        id: nextId(),
        name: `References: ${ident.text}`,
        type: 'RELATIONSHIP',
        entityType: 'REFERENCES',
        patternId: 'relationship.ExportedConstantReference',
        sourceId,
        targetId: modRef.targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: modRef.evidences,
      };
    }
  }

  // Default Parameter / Binary Fallback Context or Component Reference (`context = TRPCContext`, `const Context = opts?.context ?? TRPCContext`)
  if (
    (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
    node.initializer
  ) {
    const unwrappedInit = unwrapTransparentExpr(node.initializer);
    let fallbackIdent: ts.Identifier | null = null;
    if (ts.isParameter(node) && ts.isIdentifier(unwrappedInit)) {
      fallbackIdent = unwrappedInit;
    } else if (
      ts.isBinaryExpression(unwrappedInit) &&
      (unwrappedInit.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        unwrappedInit.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      const right = unwrapTransparentExpr(unwrappedInit.right);
      if (ts.isIdentifier(right)) {
        fallbackIdent = right;
      }
    }
    if (fallbackIdent && /^[A-Z]/.test(fallbackIdent.text)) {
      const ref = resolveFunctionContractReference(
        fallbackIdent,
        node,
        sourceFile,
        getEvidence,
        repoRoot,
        workspaceRegistry
      );
      if (ref) {
        return {
          id: nextId(),
          name: `Call: ${fallbackIdent.text}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.callback-reference',
          sourceId,
          targetId: ref.targetId,
          status: 'INFERRED',
          confidence: 'HIGH',
          evidence: ref.evidences,
        };
      }
    }
  }

  const delegationEdges = extractModuleExportDelegationEdges(
    node,
    sourceFile,
    getEvidence,
    nextId,
    repoRoot,
    workspaceRegistry,
    sourceId
  );
  if (delegationEdges) return delegationEdges;

  // React JSX Composition (`[PAT-EXT-25]`, `[PAT-EXT-28]` — delegated to the React & Next.js convention tables)
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const filePath = getEvidence(node).filePath;
    const findImportDecl = (localName: string): ts.ImportDeclaration | ts.ImportEqualsDeclaration | null =>
      getRelationshipFileIndex(sourceFile).importDeclByLocalName.get(localName) ?? null;

    const unwrapLocalStyledWrappedComponent = (localName: string): string | null => {
      for (const stmt of sourceFile.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || decl.name.text !== localName || !decl.initializer) continue;
          let expr: ts.Expression = unwrapTransparentExpr(decl.initializer);
          if (ts.isTaggedTemplateExpression(expr)) {
            expr = unwrapTransparentExpr(expr.tag);
          } else if (ts.isCallExpression(expr) && ts.isCallExpression(expr.expression)) {
            expr = unwrapTransparentExpr(expr.expression);
          }
          if (
            ts.isCallExpression(expr) &&
            expr.arguments.length >= 1 &&
            ts.isIdentifier(expr.arguments[0]) &&
            ((ts.isIdentifier(expr.expression) && expr.expression.text === 'styled') ||
              (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'styled'))
          ) {
            return expr.arguments[0].text;
          }
        }
      }
      return null;
    };

    const primaryRender = extractReactJsxRender(node, sourceId, getEvidence, nextId, {
      importedComponent: (rawTagName) => {
        const styledInner = !findImportDecl(rawTagName) ? unwrapLocalStyledWrappedComponent(rawTagName) : null;
        const tagName = styledInner ?? rawTagName;
        const matchingImport = findImportDecl(tagName);
        const importLiteral = getImportDeclarationSpecifier(matchingImport);
        if (!matchingImport || !importLiteral) return null;
        const cleanLiteral = importLiteral.replace(/[?#].*$/, '');
        const resolvedPath =
          resolveModulePath(importLiteral, sourceFile.fileName, repoRoot, workspaceRegistry) ??
          (cleanLiteral !== importLiteral
            ? resolveModulePath(cleanLiteral, sourceFile.fileName, repoRoot, workspaceRegistry)
            : null);

        const importStart = matchingImport.getStart(sourceFile);
        const { line: importLine } = sourceFile.getLineAndCharacterOfPosition(importStart);
        const evidences: EvidenceRecord[] = [
          {
            filePath,
            lineNumber: importLine + 1,
            snippet: matchingImport.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
            evidenceRole: 'import-match',
          },
        ];

        if (!resolvedPath) {
          if (isExternalSpecifier(importLiteral, sourceFile.fileName, repoRoot, workspaceRegistry)) {
            return { targetId: packageConnectorId(importLiteral), evidences };
          }
          return { targetId: undefined, evidences };
        }

        if (resolvedPath.toLowerCase().endsWith('.svg')) {
          const svgRes = resolveSvgComponentImportTarget(resolvedPath, repoRoot, workspaceRegistry);
          if (svgRes) {
            return { targetId: svgRes.targetId, evidences: [...evidences, ...svgRes.evidences] };
          }
        }

        const binding = findValueModuleBinding(sourceFile, tagName);
        const lookupSymbol =
          binding?.importedName && binding.importedName !== 'default' && binding.importedName !== '*'
            ? binding.importedName
            : tagName;
        const res =
          resolveTargetExport(resolvedPath, lookupSymbol, repoRoot, workspaceRegistry ?? {}, 'Exported Function') ??
          (binding?.importedName === 'default'
            ? resolveTargetExport(resolvedPath, 'default', repoRoot, workspaceRegistry ?? {}, 'Exported Function')
            : null) ??
          resolveClassMethodTargetWithEvidence(
            ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier(tagName),
                'render'
              ),
              undefined,
              []
            ),
            sourceFile,
            repoRoot,
            workspaceRegistry
          );
        let targetId: string | undefined;
        if (res) {
          targetId = res.targetId;
          evidences.push(res.targetEvidence);
        }
        return { targetId, evidences };
      },

      lazyComponent: (tagName, _refNode, wrapper) => {
        const lazyBinding = findValueModuleBinding(sourceFile, tagName);
        if (!lazyBinding || lazyBinding.lazyWrapper !== wrapper) return null;
        const resolvedPath = resolveModulePath(lazyBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry);
        if (!resolvedPath) return null;

        const evidences: EvidenceRecord[] = [];
        for (const stmt of sourceFile.statements) {
          if (!ts.isVariableStatement(stmt)) continue;
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === tagName) {
              const declStart = decl.getStart(sourceFile);
              const { line: declLine } = sourceFile.getLineAndCharacterOfPosition(declStart);
              evidences.push({
                filePath,
                lineNumber: declLine + 1,
                snippet: decl.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                evidenceRole: 'import-match',
              });
              break;
            }
          }
        }

        const lookupSymbol =
          lazyBinding.importedName && lazyBinding.importedName !== 'default' && lazyBinding.importedName !== '*'
            ? lazyBinding.importedName
            : tagName;
        const res =
          resolveTargetExport(resolvedPath, lookupSymbol, repoRoot, workspaceRegistry ?? {}, 'Exported Function') ??
          (lazyBinding.importedName === 'default'
            ? resolveTargetExport(resolvedPath, 'default', repoRoot, workspaceRegistry ?? {}, 'Exported Function')
            : null);
        let targetId: string | undefined;
        if (res) {
          targetId = res.targetId;
          evidences.push(res.targetEvidence);
        }
        return { targetId, evidences };
      },

      sameFileExport: (name, refNode) => {
        const direct = resolveSameFileExportedFunction(name, refNode, sourceFile, repoRoot, workspaceRegistry);
        if (direct) return { targetId: direct.targetId, evidences: [direct.targetEvidence] };
        const styledInner = unwrapLocalStyledWrappedComponent(name);
        if (styledInner) {
          const innerResolved = resolveSameFileExportedFunction(
            styledInner,
            refNode,
            sourceFile,
            repoRoot,
            workspaceRegistry
          );
          if (innerResolved) {
            return { targetId: innerResolved.targetId, evidences: [innerResolved.targetEvidence] };
          }
        }
        return null;
      },

      namespacedComponent: (rawRootName, memberName, refNode) => {
        let rootName = rawRootName;
        if (!findImportDecl(rootName)) {
          let unwrappedIdent: ts.Identifier | null = null;
          const walkForIdent = (n: ts.Node): void => {
            if (unwrappedIdent) return;
            if (ts.isIdentifier(n) && n.text === rawRootName) {
              unwrappedIdent = unwrapFallbackIdentifier(n, refNode);
              return;
            }
            ts.forEachChild(n, walkForIdent);
          };
          walkForIdent(refNode);
          if (unwrappedIdent && (unwrappedIdent as ts.Identifier).text !== rawRootName) {
            rootName = (unwrappedIdent as ts.Identifier).text;
          }
        }
        const matchingImport = findImportDecl(rootName);
        const importLiteral = getImportDeclarationSpecifier(matchingImport);
        if (matchingImport && importLiteral) {
          const resolvedPath = resolveModulePath(importLiteral, sourceFile.fileName, repoRoot, workspaceRegistry);
          if (!resolvedPath) return null;

          const importStart = matchingImport.getStart(sourceFile);
          const { line: importLine } = sourceFile.getLineAndCharacterOfPosition(importStart);
          const evidences: EvidenceRecord[] = [
            {
              filePath,
              lineNumber: importLine + 1,
              snippet: matchingImport.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
              evidenceRole: 'import-match',
            },
          ];

          const binding = findValueModuleBinding(sourceFile, rootName);
          const lookupRoot =
            binding?.importedName && binding.importedName !== 'default' && binding.importedName !== '*'
              ? binding.importedName
              : rootName;
          const res =
            binding?.importedName === '*'
              ? (resolveTargetExport(resolvedPath, memberName, repoRoot, workspaceRegistry ?? {}, 'Exported Function') ??
                 resolveImportedObjectMember(resolvedPath, lookupRoot, memberName, repoRoot, workspaceRegistry ?? {}) ??
                 resolveTargetExport(resolvedPath, lookupRoot, repoRoot, workspaceRegistry ?? {}, 'Exported Function', 0, undefined, false, memberName) ??
                 resolveTargetExport(resolvedPath, lookupRoot, repoRoot, workspaceRegistry ?? {}, 'Exported Function'))
              : (resolveImportedObjectMember(resolvedPath, lookupRoot, memberName, repoRoot, workspaceRegistry ?? {}) ??
                 (binding?.importedName === 'default'
                   ? resolveImportedObjectMember(resolvedPath, 'default', memberName, repoRoot, workspaceRegistry ?? {})
                   : null) ??
                 resolveTargetExport(resolvedPath, lookupRoot, repoRoot, workspaceRegistry ?? {}, 'Exported Function', 0, undefined, false, memberName) ??
                 resolveTargetExport(resolvedPath, lookupRoot, repoRoot, workspaceRegistry ?? {}, 'Exported Function') ??
                 resolveTargetExport(resolvedPath, memberName, repoRoot, workspaceRegistry ?? {}, 'Exported Function'));
          let targetId: string | undefined;
          if (res) {
            targetId = res.targetId;
            evidences.push(res.targetEvidence);
          }
          return { targetId, evidences };
        }

        const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
        const sameFile =
          resolveCjsContractInSourceFile(sourceFile, memberName, relPath, repoRoot, workspaceRegistry) ??
          resolveSameFileExportedFunction(memberName, refNode, sourceFile, repoRoot, workspaceRegistry) ??
          resolveSameFileExportedFunction(rootName, refNode, sourceFile, repoRoot, workspaceRegistry);
        return sameFile ? { targetId: sameFile.targetId, evidences: [sameFile.targetEvidence] } : null;
      },
    });

    const mapRenderEdges = extractJsxComponentMapPropEdges(
      node,
      sourceFile,
      getEvidence,
      nextId,
      repoRoot,
      sourceId,
      workspaceRegistry
    );
    const remixFormEdge = extractRemixFormActionRouteLink(
      node,
      sourceFile,
      getEvidence,
      nextId,
      repoRoot,
      sourceId,
      workspaceRegistry
    );
    if (mapRenderEdges.length > 0 || remixFormEdge) {
      const baseList = Array.isArray(primaryRender)
        ? primaryRender
        : primaryRender
          ? [primaryRender]
          : [];
      return [
        ...baseList,
        ...mapRenderEdges,
        ...(remixFormEdge ? [remixFormEdge] : []),
      ];
    }
    return primaryRender;
  }

  const defaultObjRead = extractDefaultImportedObjectPropertyRead(
    node,
    sourceFile,
    getEvidence,
    nextId,
    repoRoot,
    sourceId,
    workspaceRegistry
  );
  if (defaultObjRead) return defaultObjRead;

  const getterAccess = extractGetterPropertyAccessInvocation(
    node,
    sourceFile,
    getEvidence,
    nextId,
    repoRoot,
    sourceId,
    workspaceRegistry
  );
  if (getterAccess) return getterAccess;

  const nestEdges = extractNestDecoratorAndPortAdapterEdges(
    node,
    sourceFile,
    getEvidence,
    nextId,
    repoRoot,
    sourceId,
    workspaceRegistry
  );
  if (nestEdges) return nestEdges;

  return null;
}

function resolveUserConventionContractInFile(
  targetSourceFile: ts.SourceFile,
  symbolName: string,
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry | undefined,
  userConventions: readonly ConventionSet[],
  conventionConfig?: ConventionConfigResolver
): { targetId: string; targetEvidence: EvidenceRecord } | null {
  if (userConventions.length === 0) return null;
  const targetRelPath = path.relative(repoRoot, targetSourceFile.fileName) || targetSourceFile.fileName;
  const getTargetEv = (n: ts.Node): EvidenceRecord => {
    const start = n.getStart(targetSourceFile);
    const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
    return {
      filePath: targetRelPath,
      lineNumber: line + 1,
      snippet: n.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
      evidenceRole: 'target-signature',
    };
  };

  const targetFileRole = classifyNextjsFile(targetRelPath);
  for (const stmt of targetSourceFile.statements) {
    const builtinContracts = visitContract(
      stmt,
      targetSourceFile,
      getTargetEv,
      () => '',
      targetFileRole,
      targetRelPath
    );
    const hasBuiltin = Array.isArray(builtinContracts)
      ? builtinContracts.length > 0
      : Boolean(builtinContracts);
    if (hasBuiltin) continue;

    for (const uSet of userConventions) {
      const contractRuleIds = uSet.rules.filter((r) => r.emit.type === 'CONTRACT').map((r) => r.id);
      if (contractRuleIds.length === 0) continue;
      const uRole = classifyFileRole(
        uSet,
        targetRelPath,
        conventionConfig ? conventionConfig.extensionsFor(uSet, targetSourceFile.fileName) : []
      );
      const applied = applyConventionRulesDetailed(
        uSet,
        contractRuleIds,
        stmt,
        uRole,
        targetRelPath,
        getTargetEv,
        () => ''
      );
      for (const { entity, match } of applied) {
        if (entity.type === 'RELATIONSHIP') continue;
        const boundName =
          match.bindings.name ??
          match.bindings.exportedName ??
          match.bindings.componentName ??
          match.bindings.originalName;
        if (
          boundName === symbolName ||
          match.bindings.originalName === symbolName ||
          (symbolName === 'default' && match.bindings.componentName !== undefined)
        ) {
          const baseBoundaryScope = resolveLogicalBoundaryScope(
            targetSourceFile.fileName,
            repoRoot,
            workspaceRegistry
          );
          const logicalScope = findEnclosingNamespaceScope(stmt)
            ? `${baseBoundaryScope}::${findEnclosingNamespaceScope(stmt)}`
            : baseBoundaryScope;
          const targetId =
            entity.id ||
            contractEntityId(logicalScope, targetRelPath, entity.name, entity.patternId);
          const ev = Array.isArray(entity.evidence) ? entity.evidence[0] : entity.evidence;
          return {
            targetId,
            targetEvidence: ev ?? getTargetEv(stmt),
          };
        }
      }
    }
  }
  return null;
}

/**
 * Builds language-level `EdgeTargetResolvers` for user-defined `ConventionSet.edgeRules`
 * (`chomp.config.json#conventions`), resolving imported contracts, same-file exports,
 * router mounts, and custom `userConventions` contracts without inline framework rules.
 */
export function createUserEdgeTargetResolvers(
  sourceFile: ts.SourceFile,
  relativePath: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  userConventions: readonly ConventionSet[] = [],
  conventionConfig?: ConventionConfigResolver
): EdgeTargetResolvers {
  return {
    importedComponent: (symbolName) => {
      const binding = findValueModuleBinding(sourceFile, symbolName);
      if (!binding) return null;
      const resolvedPath = resolveModulePath(
        binding.moduleSpecifier,
        sourceFile.fileName,
        repoRoot,
        workspaceRegistry
      );
      const evidences: EvidenceRecord[] = [];
      for (const stmt of sourceFile.statements) {
        if (
          ts.isImportDeclaration(stmt) &&
          ts.isStringLiteral(stmt.moduleSpecifier) &&
          stmt.moduleSpecifier.text === binding.moduleSpecifier
        ) {
          const start = stmt.getStart(sourceFile);
          const { line } = sourceFile.getLineAndCharacterOfPosition(start);
          evidences.push({
            filePath: relativePath,
            lineNumber: line + 1,
            snippet: stmt.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
            evidenceRole: 'import-match',
          });
          break;
        }
      }

      if (!resolvedPath) {
        if (isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
          return { targetId: packageConnectorId(binding.moduleSpecifier), evidences };
        }
        return null;
      }

      const lookupSymbol =
        binding.importedName && binding.importedName !== '*' ? binding.importedName : symbolName;
      const absTarget = path.resolve(repoRoot, resolvedPath);
      const targetSf =
        getCachedSourceFile(absTarget) ??
        (fs.existsSync(absTarget)
          ? ts.createSourceFile(
              absTarget,
              fs.readFileSync(absTarget, 'utf8'),
              ts.ScriptTarget.Latest,
              true
            )
          : undefined);
      if (targetSf && userConventions.length > 0) {
        const customRes = resolveUserConventionContractInFile(
          targetSf,
          lookupSymbol,
          repoRoot,
          workspaceRegistry,
          userConventions,
          conventionConfig
        );
        if (customRes) {
          evidences.push(customRes.targetEvidence);
          return { targetId: customRes.targetId, evidences };
        }
      }

      const stdRes =
        resolveTargetExport(
          resolvedPath,
          lookupSymbol,
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function'
        ) ??
        (binding.importedName === 'default'
          ? resolveTargetExport(
              resolvedPath,
              'default',
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function'
            )
          : null);
      if (stdRes) {
        evidences.push(stdRes.targetEvidence);
        return { targetId: stdRes.targetId, evidences };
      }
      return null;
    },

    sameFileExport: (symbolName, refNode) => {
      if (userConventions.length > 0) {
        const customSame = resolveUserConventionContractInFile(
          sourceFile,
          symbolName,
          repoRoot,
          workspaceRegistry,
          userConventions,
          conventionConfig
        );
        if (customSame) {
          return { targetId: customSame.targetId, evidences: [customSame.targetEvidence] };
        }
      }
      const direct = resolveSameFileExportedFunction(
        symbolName,
        refNode,
        sourceFile,
        repoRoot,
        workspaceRegistry
      );
      if (direct) return { targetId: direct.targetId, evidences: [direct.targetEvidence] };
      return null;
    },

    lazyComponent: (symbolName, _refNode, wrapper) => {
      const binding = findValueModuleBinding(sourceFile, symbolName);
      if (!binding || binding.lazyWrapper !== wrapper) return null;
      const resolvedPath = resolveModulePath(
        binding.moduleSpecifier,
        sourceFile.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (!resolvedPath) return null;
      const lookupSymbol =
        binding.importedName && binding.importedName !== '*' ? binding.importedName : symbolName;
      const res = resolveTargetExport(
        resolvedPath,
        lookupSymbol,
        repoRoot,
        workspaceRegistry ?? {},
        'Exported Function'
      );
      return res ? { targetId: res.targetId, evidences: [res.targetEvidence] } : null;
    },

    routerMount: (callNode) =>
      resolveRouterMountTarget(callNode, sourceFile, repoRoot, workspaceRegistry),
  };
}
