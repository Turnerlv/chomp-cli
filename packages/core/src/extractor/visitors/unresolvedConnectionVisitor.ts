// packages/core/src/extractor/visitors/unresolvedConnectionVisitor.ts
//
// Reconciles intra-repo import bindings against extracted contracts and resolved edges so the
// graph can surface the "other half" of unhandled patterns:
//   1. Unresolved outgoing connections (`CALL` / `RENDERS` edges whose target could not be linked,
//      plus intra-repo imported symbols referenced in a function/component body with no resolved edge).
//   2. Expected incoming callers on Orphan Contracts (`unresolvedIncoming`), distinguishing
//      orphans that SHOULD be connecting (`UNLINKED_IMPORTED_TARGET`) from exports that are
//      imported but never called (`imported-but-never-invoked`) and dead/unused exports
//      (`UNREFERENCED_EXPORT`).

import path from 'path';
import ts from 'typescript';
import { StructuralEdge, StructuralNode } from '../../types/index.js';
import { unwrapWrappedFunction } from '../conventions/engine.js';
import { REACT_HOC_WRAPPERS } from '../conventions/react.js';
import { resolveModulePath } from '../pathResolver.js';
import { WorkspaceRegistry } from '../workspaceResolver.js';
import { findScopeOwnerId } from './initBlockVisitor.js';
import {
  findLocalVariableDeclaration,
  findModuleBinding,
  findValueModuleBinding,
  getPropertyOrElementAccess,
  getSourceFileDeclarationIndex,
  isExternalSpecifier,
  unwrapRequire,
} from './targetResolver.js';

const BUILTIN_COLLECTION_PROTOTYPE_METHODS = new Set([
  'has',
  'get',
  'set',
  'add',
  'delete',
  'clear',
  'map',
  'filter',
  'forEach',
  'some',
  'every',
  'find',
  'findIndex',
  'includes',
  'indexOf',
  'slice',
  'concat',
  'reduce',
  'reduceRight',
  'flat',
  'flatMap',
  'keys',
  'values',
  'entries',
  'join',
  'sort',
  'reverse',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'then',
  'catch',
  'finally',
]);

export const STATIC_ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
]);

/**
 * Returns true if the import specifier or resolved file path targets a static asset
 * (e.g. image, stylesheet, font, audio/video).
 */
export function isStaticAssetPath(pathOrSpecifier: string): boolean {
  if (!pathOrSpecifier) return false;
  const cleanPath = pathOrSpecifier.split('?')[0].split('#')[0];
  const ext = path.extname(cleanPath.replace(/\\/g, '/')).toLowerCase();
  return STATIC_ASSET_EXTENSIONS.has(ext);
}

export type UnresolvedConnectionReason =
  | 'unresolved-import-path'
  | 'missing-target-export'
  | 'unextracted-target-contract'
  | 'unlinked-import-reference'
  | 'imported-but-never-invoked';

export type ImportUsageKind =
  | 'call'
  | 'jsx-element'
  | 'jsx-prop'
  | 'callback-arg'
  | 'destructure-delegation'
  | 'reexport-delegation'
  | 'identifier-ref'
  | 'unused-import';

export interface UnresolvedIncomingReference {
  callerId: string;
  callerName: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
  symbol: string;
  importSpecifier: string;
  usageKind: ImportUsageKind;
  reason: UnresolvedConnectionReason;
}

export interface UnresolvedOutgoingReference {
  targetContractId?: string;
  targetContractName?: string;
  targetSymbol: string;
  importSpecifier: string;
  resolvedFilePath?: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
  usageKind: ImportUsageKind;
  reason: UnresolvedConnectionReason;
}

export interface ParsedSourceUnit {
  sourceFile: ts.SourceFile;
  filePath: string;
  relativePath: string;
  scope: StructuralNode['scope'];
  ownerByNode: Map<ts.Node, string>;
  multiOwnersByHelperNode?: Map<ts.Node, Set<string>>;
  hasFileInitBlock?: boolean;
  unitId: string;
  getInitId: () => string | undefined;
}

function getFileFallbackOwnerId(unit: ParsedSourceUnit): string {
  const sfOwner = unit.ownerByNode.get(unit.sourceFile);
  if (sfOwner) {
    return sfOwner;
  }
  const initId = unit.getInitId();
  if (initId) {
    return initId;
  }
  return unit.unitId;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function primaryFilePath(node: StructuralNode | StructuralEdge): string | null {
  const ev = Array.isArray(node.evidence) ? node.evidence[0] : node.evidence;
  return ev?.filePath ? normalizePath(ev.filePath) : null;
}

/**
 * Extracts the exported symbol name from a Contract / Class node name.
 */
export function extractSymbolFromNodeName(node: StructuralNode): string[] {
  const symbols: string[] = [];
  const pushUnique = (sym: string) => {
    if (sym.length > 0 && !symbols.includes(sym)) symbols.push(sym);
  };

  if (
    (node.entityType === 'EXPORTED_MODULE' &&
      node.patternId !== 'contract.exported-object-literal-data-store') ||
    node.patternId === 'contract.vue-sfc-script-setup' ||
    node.patternId === 'contract.astro-svg-component-import' ||
    (node.patternId === 'contract.svelte-sfc-and-sveltekit-hooks' &&
      node.name.startsWith('Svelte Component: ')) ||
    node.name === 'Module Export (Default)'
  ) {
    pushUnique('default');
  }
  if (node.patternId === 'contract.astro-get-static-paths-lifecycle') {
    pushUnique('getStaticPaths');
  }
  if (node.patternId === 'contract.svelte-sfc-and-sveltekit-hooks') {
    if (
      node.name.startsWith('SvelteKit Load: ') ||
      node.name.startsWith('SvelteKit Layout Load: ')
    ) {
      pushUnique('load');
    } else if (node.name.startsWith('SvelteKit Actions: ')) {
      pushUnique('actions');
    }
  }
  if (node.entityType === 'NEXTJS_PAGE' || node.entityType === 'NEXTJS_LAYOUT') {
    pushUnique('default');
    const compName = node.metadata?.componentName;
    if (typeof compName === 'string' && compName.length > 0) {
      pushUnique(compName);
    }
    return symbols;
  }
  if (node.entityType === 'NEXTJS_MIDDLEWARE') {
    pushUnique('middleware');
    const orig = node.metadata?.originalName;
    if (typeof orig === 'string' && orig.length > 0) {
      pushUnique(orig);
    }
    return symbols;
  }
  const colonIdx = node.name.indexOf(': ');
  if (colonIdx !== -1) {
    const after = node.name.slice(colonIdx + 2).trim();
    if (after.length > 0) {
      pushUnique(after);
      const protoIdx = after.indexOf('.prototype.');
      if (protoIdx !== -1) {
        pushUnique(after.slice(protoIdx + '.prototype.'.length).trim());
      } else if (
        (node.name.startsWith('CJS Export Alias: ') || node.entityType === 'PUBLIC_METHOD') &&
        after.includes('.')
      ) {
        pushUnique(after.slice(after.lastIndexOf('.') + 1).trim());
      }
    }
  }
  return symbols;
}

function parseEdgeCalleeSymbol(edge: StructuralEdge): { rootName: string; memberName?: string } | null {
  if (edge.entityType === 'CALL' && edge.name.startsWith('Call: ')) {
    const raw = edge.name.slice('Call: '.length).replace(/\(\)\(\)$/, '').replace(/\(\)$/, '').trim();
    if (!raw || raw.startsWith('new ')) return null;
    const dotIdx = raw.indexOf('.');
    if (dotIdx !== -1) {
      return { rootName: raw.slice(0, dotIdx), memberName: raw.slice(dotIdx + 1) };
    }
    return { rootName: raw };
  }
  if (edge.entityType === 'RENDERS' && edge.name.startsWith('Renders: <')) {
    const raw = edge.name.slice('Renders: <'.length).replace(/\s*\/>$/, '').trim();
    if (!raw) return null;
    const dotIdx = raw.indexOf('.');
    if (dotIdx !== -1) {
      return { rootName: raw.slice(0, dotIdx), memberName: raw.slice(dotIdx + 1) };
    }
    return { rootName: raw };
  }
  return null;
}

function isInsideTypeOrDeclarationName(ident: ts.Identifier): boolean {
  const parent = ident.parent;
  if (!parent) return true;

  // Declaration name positions
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent)) &&
    parent.name === ident
  ) {
    return true;
  }

  // Property access RHS (`obj.ident` where `ident` is the property name, not the receiver)
  if (ts.isPropertyAccessExpression(parent) && parent.name === ident) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === ident) {
    return true;
  }

  // Object literal property name (`{ ident: val }`)
  if (ts.isPropertyAssignment(parent) && parent.name === ident) {
    return true;
  }

  // Binding element name (`const { ident } = obj` or `const { prop: ident } = obj`), excluding default initializer
  if (ts.isBindingElement(parent) && (parent.name === ident || parent.propertyName === ident)) {
    return true;
  }

  // JSX attribute name (`<Comp ident={...} />`)
  if (ts.isJsxAttribute(parent) && parent.name === ident) {
    return true;
  }

  // JSX closing element (`</Comp>`) — opening element already counts the render
  if (ts.isJsxClosingElement(parent) || (ts.isPropertyAccessExpression(parent) && ts.isJsxClosingElement(parent.parent))) {
    return true;
  }

  // Walk ancestors to skip imports and TypeScript type positions
  for (let cur: ts.Node | undefined = parent; cur; cur = cur.parent) {
    if (
      ts.isImportDeclaration(cur) ||
      ts.isImportEqualsDeclaration(cur) ||
      ts.isExternalModuleReference(cur) ||
      ts.isImportClause(cur) ||
      ts.isImportSpecifier(cur) ||
      ts.isNamespaceImport(cur) ||
      ts.isTypeNode(cur) ||
      ts.isInterfaceDeclaration(cur) ||
      ts.isTypeAliasDeclaration(cur)
    ) {
      return true;
    }
    if (ts.isExportSpecifier(cur)) {
      const exportDecl = cur.parent?.parent;
      if (exportDecl && ts.isExportDeclaration(exportDecl) && exportDecl.isTypeOnly) {
        return true;
      }
    }
  }

  return false;
}

function isInsideTypeAnnotationPosition(ident: ts.Identifier): boolean {
  const parent = ident.parent;
  if (!parent) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent)) &&
    parent.name === ident
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === ident) return false;
  if (ts.isQualifiedName(parent) && parent.right === ident) return false;

  for (let cur: ts.Node | undefined = parent; cur; cur = cur.parent) {
    if (
      ts.isImportDeclaration(cur) ||
      ts.isImportEqualsDeclaration(cur) ||
      ts.isExternalModuleReference(cur) ||
      ts.isImportClause(cur) ||
      ts.isImportSpecifier(cur) ||
      ts.isNamespaceImport(cur)
    ) {
      return false;
    }
    if (
      ts.isTypeNode(cur) ||
      ts.isInterfaceDeclaration(cur) ||
      ts.isTypeAliasDeclaration(cur) ||
      (ts.isExpressionWithTypeArguments(cur) &&
        ts.isHeritageClause(cur.parent) &&
        cur.parent.token === ts.SyntaxKind.ImplementsKeyword)
    ) {
      return true;
    }
  }
  return false;
}

function unwrapMemberAccessChain(ident: ts.Identifier): {
  segments: string[];
  outerExpression: ts.Expression;
} {
  const segments: string[] = [];
  let current: ts.Expression = ident;
  while (current.parent && ts.isExpression(current.parent)) {
    const access = getPropertyOrElementAccess(current.parent);
    if (access && access.expression === current) {
      segments.push(access.memberName);
      current = current.parent;
    } else {
      break;
    }
  }
  return { segments, outerExpression: current };
}

function classifyUsageKind(ident: ts.Identifier, outerExpression: ts.Expression = ident): ImportUsageKind {
  const parent = ident.parent;
  if (!parent) return 'identifier-ref';

  if (
    ts.isJsxOpeningElement(parent) ||
    ts.isJsxSelfClosingElement(parent) ||
    (ts.isPropertyAccessExpression(parent) &&
      (ts.isJsxOpeningElement(parent.parent) || ts.isJsxSelfClosingElement(parent.parent)))
  ) {
    return 'jsx-element';
  }

  for (let cur: ts.Node | undefined = parent; cur; cur = cur.parent) {
    if (ts.isJsxAttribute(cur)) return 'jsx-prop';
    if (ts.isJsxElement(cur) || ts.isJsxSelfClosingElement(cur) || ts.isBlock(cur)) break;
  }

  const outerParent = outerExpression.parent;
  if (
    outerParent &&
    ((ts.isCallExpression(outerParent) && outerParent.expression === outerExpression) ||
      (ts.isNewExpression(outerParent) && outerParent.expression === outerExpression) ||
      (ts.isTaggedTemplateExpression(outerParent) && outerParent.tag === outerExpression))
  ) {
    return 'call';
  }
  if (outerParent && ts.isCallExpression(outerParent) && outerParent.arguments.includes(outerExpression)) {
    return 'callback-arg';
  }
  if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name) && parent.initializer === ident) {
    return 'destructure-delegation';
  }
  if (ts.isExportSpecifier(parent)) {
    return 'reexport-delegation';
  }
  return 'identifier-ref';
}

function snippetForNode(node: ts.Node, sourceFile: ts.SourceFile): { lineNumber: number; snippet: string } {
  let stmt: ts.Node = node;
  while (
    stmt.parent &&
    !ts.isStatement(stmt) &&
    !ts.isJsxOpeningElement(stmt) &&
    !ts.isJsxSelfClosingElement(stmt) &&
    !ts.isJsxAttribute(stmt) &&
    !ts.isCallExpression(stmt)
  ) {
    stmt = stmt.parent;
  }
  const start = node.getStart(sourceFile);
  const { line } = sourceFile.getLineAndCharacterOfPosition(start);
  const snippet = stmt.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim();
  return { lineNumber: line + 1, snippet };
}

/**
 * Follows barrel re-exports (`export { X } from '...'`, `export * from '...'`) from `initialRelPath`
 * and same-file re-export delegations (`export { X }` where X is an imported symbol) to find an
 * extracted Contract / Class node for `symbolName`.
 *
 * @param initialRelPath - The relative path of the module where the lookup begins.
 * @param symbolName - The exported name of the contract to resolve.
 * @param contractsByFileAndSymbol - Pre-indexed map of (normalizedPath::symbolName) to extracted contracts.
 * @param sourceFileByRelPath - Map of normalized file paths to their parsed SourceFiles.
 * @param repoRoot - Repository root directory path.
 * @param workspaceRegistry - Workspace package registry for monorepo alias resolution.
 * @param depth - Current recursion depth to prevent infinite loops (max 5).
 * @param visited - Visited (path::symbol) pairs to guard against circular re-exports.
 * @returns The resolved StructuralNode if found, otherwise undefined.
 */
function findTargetContractNode(
  initialRelPath: string,
  symbolName: string,
  contractsByFileAndSymbol: Map<string, StructuralNode[]>,
  sourceFileByRelPath: Map<string, ts.SourceFile>,
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry,
  depth = 0,
  visited: Set<string> = new Set()
): StructuralNode | undefined {
  const normPath = normalizePath(initialRelPath);
  if (depth > 5 || visited.has(`${normPath}::${symbolName}`)) return undefined;
  visited.add(`${normPath}::${symbolName}`);

  const direct = contractsByFileAndSymbol.get(`${normPath}::${symbolName}`);
  if (direct && direct.length > 0) {
    return direct.find((n) => n.entityType !== 'EXPORTED_TYPE') ?? direct[0];
  }

  const sf = sourceFileByRelPath.get(normPath);
  if (!sf) return undefined;

  if (symbolName === 'default') {
    for (const stmt of sf.statements) {
      if (
        (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
        stmt.name &&
        ts.canHaveModifiers(stmt) &&
        ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      ) {
        const byDeclName = contractsByFileAndSymbol.get(`${normPath}::${stmt.name.text}`);
        if (byDeclName && byDeclName.length > 0) {
          return byDeclName.find((n) => n.entityType !== 'EXPORTED_TYPE') ?? byDeclName[0];
        }
      }
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        if (ts.isIdentifier(stmt.expression)) {
          const identName = stmt.expression.text;
          const byIdent = contractsByFileAndSymbol.get(`${normPath}::${identName}`);
          if (byIdent && byIdent.length > 0) {
            return byIdent.find((n) => n.entityType !== 'EXPORTED_TYPE') ?? byIdent[0];
          }
          const binding = findValueModuleBinding(sf, identName);
          if (binding) {
            const resolved = resolveModulePath(binding.moduleSpecifier, sf.fileName, repoRoot, workspaceRegistry);
            if (resolved) {
              const lookupSymbol =
                binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
                  ? binding.importedName
                  : binding.importedName === 'default'
                    ? 'default'
                    : identName;
              const found = findTargetContractNode(
                resolved,
                lookupSymbol,
                contractsByFileAndSymbol,
                sourceFileByRelPath,
                repoRoot,
                workspaceRegistry,
                depth + 1,
                visited
              );
              if (found) return found;
            }
          }
        } else {
          const inner = unwrapWrappedFunction(stmt.expression, REACT_HOC_WRAPPERS, sf);
          const fnName =
            inner && (ts.isFunctionDeclaration(inner) || ts.isFunctionExpression(inner)) && inner.name
              ? inner.name.text
              : null;
          if (fnName) {
            const byHocName = contractsByFileAndSymbol.get(`${normPath}::${fnName}`);
            if (byHocName && byHocName.length > 0) {
              return byHocName.find((n) => n.entityType !== 'EXPORTED_TYPE') ?? byHocName[0];
            }
          }
        }
      }
    }
  }

  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const resolved = resolveModulePath(stmt.moduleSpecifier.text, sf.fileName, repoRoot, workspaceRegistry);
        if (!resolved) continue;
        if (!stmt.exportClause) {
          const found = findTargetContractNode(
            resolved,
            symbolName,
            contractsByFileAndSymbol,
            sourceFileByRelPath,
            repoRoot,
            workspaceRegistry,
            depth + 1,
            visited
          );
          if (found) return found;
        } else if (ts.isNamespaceExport(stmt.exportClause)) {
          const nsName = stmt.exportClause.name.text;
          if (symbolName === nsName || symbolName.startsWith(`${nsName}.`)) {
            const subSymbol =
              symbolName === nsName ? 'default' : symbolName.slice(nsName.length + 1);
            const found = findTargetContractNode(
              resolved,
              subSymbol,
              contractsByFileAndSymbol,
              sourceFileByRelPath,
              repoRoot,
              workspaceRegistry,
              depth + 1,
              visited
            );
            if (found) return found;
          }
        } else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (el.name.text === symbolName || symbolName.startsWith(`${el.name.text}.`)) {
              const suffix = symbolName.slice(el.name.text.length);
              const orig = `${(el.propertyName ?? el.name).text}${suffix}`;
              const found = findTargetContractNode(
                resolved,
                orig,
                contractsByFileAndSymbol,
                sourceFileByRelPath,
                repoRoot,
                workspaceRegistry,
                depth + 1,
                visited
              );
              if (found) return found;
            }
          }
        }
      } else if (!stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        // [PAT-EXT-32] Same-file named re-export delegation (`export { X }` or `export { X as Y }` where X is an imported symbol)
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === symbolName || symbolName.startsWith(`${el.name.text}.`)) {
            const suffix = symbolName.slice(el.name.text.length);
            const orig = (el.propertyName ?? el.name).text;
            const binding = findValueModuleBinding(sf, orig);
            if (binding) {
              const resolved = resolveModulePath(binding.moduleSpecifier, sf.fileName, repoRoot, workspaceRegistry);
              if (resolved) {
                const lookupSymbol =
                  binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
                    ? binding.importedName
                    : binding.importedName === 'default'
                      ? 'default'
                      : orig;
                const found = findTargetContractNode(
                  resolved,
                  `${lookupSymbol}${suffix}`,
                  contractsByFileAndSymbol,
                  sourceFileByRelPath,
                  repoRoot,
                  workspaceRegistry,
                  depth + 1,
                  visited
                );
                if (found) return found;
              }
            } else {
              // Local non-imported symbol exported under an alias
              const directOrig = contractsByFileAndSymbol.get(`${normPath}::${orig}${suffix}`);
              if (directOrig && directOrig.length > 0) {
                return directOrig.find((n) => n.entityType !== 'EXPORTED_TYPE') ?? directOrig[0];
              }
            }
          }
        }
      }
    }
  }

  if (symbolName !== 'default') {
    const sfDeclIndex = getSourceFileDeclarationIndex(sf);
    const instClass = sfDeclIndex.classByIdentifier.get(symbolName);
    if (instClass) {
      const byClass = contractsByFileAndSymbol.get(`${normPath}::${instClass}`);
      if (byClass && byClass.length > 0) {
        return byClass.find((n) => n.entityType !== 'EXPORTED_TYPE') ?? byClass[0];
      }
      const classBinding = findModuleBinding(sf, instClass);
      if (classBinding) {
        const resolvedClass = resolveModulePath(
          classBinding.moduleSpecifier,
          sf.fileName,
          repoRoot,
          workspaceRegistry
        );
        if (resolvedClass) {
          const classLookup =
            classBinding.importedName && classBinding.importedName !== '*'
              ? classBinding.importedName
              : instClass;
          const found = findTargetContractNode(
            resolvedClass,
            classLookup,
            contractsByFileAndSymbol,
            sourceFileByRelPath,
            repoRoot,
            workspaceRegistry,
            depth + 1,
            visited
          );
          if (found) return found;
        }
      }
    }

    // Object literal barrel export (`export default { isAuth, attachCurrentUser }`) where properties reference imported bindings
    const checkObjectDelegation = (rawExpr: ts.Expression): StructuralNode | undefined => {
      let expr = unwrapTypeAndParens(rawExpr);
      if (ts.isIdentifier(expr)) {
        const localDecl = findLocalVariableDeclaration(expr);
        if (localDecl?.initializer) expr = unwrapTypeAndParens(localDecl.initializer);
      }
      if (!ts.isObjectLiteralExpression(expr)) return undefined;
      for (const prop of expr.properties) {
        let propName: string | null = null;
        let refIdent: string | null = null;
        if (ts.isShorthandPropertyAssignment(prop)) {
          propName = prop.name.text;
          refIdent = prop.name.text;
        } else if (ts.isPropertyAssignment(prop)) {
          if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
            propName = prop.name.text;
          }
          const init = unwrapTypeAndParens(prop.initializer);
          if (ts.isIdentifier(init)) refIdent = init.text;
        }
        if (propName === symbolName && refIdent) {
          const binding = findValueModuleBinding(sf, refIdent);
          if (binding) {
            const resolvedOrigin = resolveModulePath(
              binding.moduleSpecifier,
              sf.fileName,
              repoRoot,
              workspaceRegistry
            );
            if (resolvedOrigin) {
              const originSym =
                binding.importedName && binding.importedName !== '*'
                  ? binding.importedName
                  : refIdent;
              const found = findTargetContractNode(
                resolvedOrigin,
                originSym,
                contractsByFileAndSymbol,
                sourceFileByRelPath,
                repoRoot,
                workspaceRegistry,
                depth + 1,
                visited
              );
              if (found) return found;
            }
          }
        }
      }
      return undefined;
    };

    for (const stmt of sf.statements) {
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        const found = checkObjectDelegation(stmt.expression);
        if (found) return found;
      } else if (ts.isVariableStatement(stmt) && hasExportSyntaxModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer) {
            const found = checkObjectDelegation(decl.initializer);
            if (found) return found;
          }
        }
      }
    }

    for (const mixinSpec of sfDeclIndex.cjsMixinDelegations) {
      const resolvedMixin = resolveModulePath(mixinSpec, sf.fileName, repoRoot, workspaceRegistry);
      if (resolvedMixin) {
        const found = findTargetContractNode(
          resolvedMixin,
          symbolName,
          contractsByFileAndSymbol,
          sourceFileByRelPath,
          repoRoot,
          workspaceRegistry,
          depth + 1,
          visited
        );
        if (found) return found;
      }
    }
  }

  return undefined;
}

function followCjsSubmodulePath(
  startRelPath: string,
  segments: readonly string[],
  sourceFileByRelPath: Map<string, ts.SourceFile>,
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry
): string | null {
  let currentRelPath = normalizePath(startRelPath);
  for (const seg of segments) {
    const sf = sourceFileByRelPath.get(currentRelPath);
    if (!sf) return null;
    const subSpec = getSourceFileDeclarationIndex(sf).cjsSubmoduleRequires.get(seg);
    if (!subSpec) return null;
    const nextRel = resolveModulePath(subSpec, sf.fileName, repoRoot, workspaceRegistry);
    if (!nextRel) return null;
    currentRelPath = normalizePath(nextRel);
  }
  return currentRelPath;
}

function unwrapTypeAndParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Determines whether a variable initializer is a pure non-callable constant or data literal
 * (scalars, regexes, Symbol/Set/Map constructors, or array/object literals containing no
 * functions, arrow functions, methods, or class expressions).
 */
function isNonCallableConstantInitializer(rawExpr: ts.Expression, depth = 0): boolean {
  if (depth > 12) return false;
  const expr = unwrapTypeAndParens(rawExpr);

  if (
    ts.isStringLiteralLike(expr) ||
    ts.isNumericLiteral(expr) ||
    ts.isBigIntLiteral(expr) ||
    ts.isRegularExpressionLiteral(expr) ||
    ts.isTemplateExpression(expr) ||
    ts.isJsxElement(expr) ||
    ts.isJsxSelfClosingElement(expr) ||
    ts.isJsxFragment(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    expr.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return true;
  }

  if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) {
    return isNonCallableConstantInitializer(expr.operand, depth + 1);
  }

  if (ts.isBinaryExpression(expr)) {
    return (
      isNonCallableConstantInitializer(expr.left, depth + 1) &&
      isNonCallableConstantInitializer(expr.right, depth + 1)
    );
  }

  if (ts.isConditionalExpression(expr)) {
    return (
      isNonCallableConstantInitializer(expr.whenTrue, depth + 1) &&
      isNonCallableConstantInitializer(expr.whenFalse, depth + 1)
    );
  }

  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    return true;
  }

  if (ts.isIdentifier(expr)) {
    if (depth > 0) return true;
    const sf = expr.getSourceFile();
    return sf ? isLocalSymbolNonCallableConstantInFile(sf, expr.text) : false;
  }

  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (
      ctorName === 'Set' ||
      ctorName === 'Map' ||
      ctorName === 'WeakSet' ||
      ctorName === 'WeakMap' ||
      ctorName === 'RegExp' ||
      ctorName === 'Date' ||
      ctorName === 'URL'
    ) {
      return (expr.arguments ?? []).every((arg) =>
        isNonCallableConstantInitializer(arg, depth + 1)
      );
    }
    return false;
  }

  if (ts.isCallExpression(expr)) {
    if (ts.isIdentifier(expr.expression)) {
      const fnName = expr.expression.text;
      if (
        fnName === 'Symbol' ||
        fnName === 'RegExp' ||
        fnName === 'BigInt' ||
        fnName === 'Number' ||
        fnName === 'String' ||
        fnName === 'Boolean'
      ) {
        return expr.arguments.every((arg) =>
          isNonCallableConstantInitializer(arg, depth + 1)
        );
      }
    } else if (
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === 'Object' &&
      expr.expression.name.text === 'freeze' &&
      expr.arguments.length >= 1
    ) {
      return isNonCallableConstantInitializer(expr.arguments[0], depth + 1);
    }
    return false;
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.every((el) => {
      if (ts.isOmittedExpression(el)) return true;
      const inner = ts.isSpreadElement(el) ? el.expression : el;
      return isNonCallableConstantInitializer(inner, depth + 1);
    });
  }

  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.every((prop) => {
      if (ts.isPropertyAssignment(prop)) {
        const init = unwrapTypeAndParens(prop.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          if (ts.isBlock(init.body)) return init.body.statements.length === 0;
          return isNonCallableConstantInitializer(init.body, depth + 1);
        }
        return isNonCallableConstantInitializer(prop.initializer, depth + 1);
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        const sf = prop.getSourceFile();
        return depth > 0 || (sf ? isLocalSymbolNonCallableConstantInFile(sf, prop.name.text) : false);
      }
      if (ts.isSpreadAssignment(prop)) {
        return isNonCallableConstantInitializer(prop.expression, depth + 1);
      }
      return false;
    });
  }

  return false;
}

function hasExportSyntaxModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function isLocalSymbolNonCallableConstantInFile(sf: ts.SourceFile, localName: string): boolean {
  for (const stmt of sf.statements) {
    if (ts.isEnumDeclaration(stmt) && stmt.name.text === localName) {
      return true;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === localName &&
          decl.initializer &&
          isNonCallableConstantInitializer(decl.initializer)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function isCjsNonCallableConstantModule(sf: ts.SourceFile, symbolName?: string): boolean {
  for (const stmt of sf.statements) {
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = stmt.expression.left;
      const isModExports =
        (ts.isPropertyAccessExpression(left) &&
          ts.isIdentifier(left.expression) &&
          left.expression.text === 'module' &&
          left.name.text === 'exports') ||
        (ts.isIdentifier(left) && left.text === 'exports');
      if (!isModExports) continue;

      let rhs: ts.Expression = unwrapTypeAndParens(stmt.expression.right);
      if (ts.isIdentifier(rhs)) {
        const varName = rhs.text;
        for (const s of sf.statements) {
          if (!ts.isVariableStatement(s)) continue;
          for (const d of s.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === varName && d.initializer) {
              rhs = unwrapTypeAndParens(d.initializer);
              break;
            }
          }
        }
      }
      if (!isNonCallableConstantInitializer(rhs)) continue;
      if (!symbolName || symbolName === 'default') return true;
      if (
        ts.isObjectLiteralExpression(rhs) &&
        rhs.properties.some(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
            p.name.text === symbolName
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks whether `symbolName` exported from `initialRelPath` (following barrel re-exports up to depth 5)
 * resolves to a non-callable constant, enum, or pure-data literal rather than a missing contract.
 */
function isKnownNonCallableConstantExport(
  initialRelPath: string,
  symbolName: string,
  sourceFileByRelPath: Map<string, ts.SourceFile>,
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry,
  depth = 0,
  visited: Set<string> = new Set()
): boolean {
  const normPath = normalizePath(initialRelPath);
  if (normPath.endsWith('.json')) return true;
  if (depth > 5 || visited.has(`${normPath}::${symbolName}`)) return false;
  visited.add(`${normPath}::${symbolName}`);

  const sf = sourceFileByRelPath.get(normPath);
  if (!sf) return false;

  if (isCjsNonCallableConstantModule(sf, symbolName)) {
    return true;
  }

  for (const stmt of sf.statements) {
    if (ts.isEnumDeclaration(stmt) && hasExportSyntaxModifier(stmt) && stmt.name.text === symbolName) {
      return true;
    }
    if (
      ts.isExportAssignment(stmt) &&
      !stmt.isExportEquals &&
      symbolName === 'default' &&
      (isNonCallableConstantInitializer(stmt.expression) ||
        (ts.isIdentifier(stmt.expression) &&
          isLocalSymbolNonCallableConstantInFile(sf, stmt.expression.text)))
    ) {
      return true;
    }
    if (ts.isVariableStatement(stmt) && hasExportSyntaxModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === symbolName &&
          decl.initializer &&
          (isNonCallableConstantInitializer(decl.initializer) ||
            (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(symbolName) &&
              ts.isObjectLiteralExpression(unwrapTypeAndParens(decl.initializer))))
        ) {
          return true;
        }
      }
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const spec = stmt.moduleSpecifier.text;
        const resolved = resolveModulePath(spec, sf.fileName, repoRoot, workspaceRegistry);
        if (!resolved) {
          if (isExternalSpecifier(spec, sf.fileName, repoRoot, workspaceRegistry)) {
            if (!stmt.exportClause) return true;
            if (ts.isNamespaceExport(stmt.exportClause) && stmt.exportClause.name.text === symbolName) {
              return true;
            }
            if (ts.isNamedExports(stmt.exportClause)) {
              for (const el of stmt.exportClause.elements) {
                if (el.name.text === symbolName) return true;
              }
            }
          }
          continue;
        }
        if (!stmt.exportClause) {
          if (
            isKnownNonCallableConstantExport(
              resolved,
              symbolName,
              sourceFileByRelPath,
              repoRoot,
              workspaceRegistry,
              depth + 1,
              visited
            )
          ) {
            return true;
          }
        } else if (ts.isNamespaceExport(stmt.exportClause)) {
          if (stmt.exportClause.name.text === symbolName) {
            return true;
          }
        } else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (el.name.text === symbolName) {
              const orig = (el.propertyName ?? el.name).text;
              if (
                isKnownNonCallableConstantExport(
                  resolved,
                  orig,
                  sourceFileByRelPath,
                  repoRoot,
                  workspaceRegistry,
                  depth + 1,
                  visited
                )
              ) {
                return true;
              }
            }
          }
        }
      } else if (!stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === symbolName) {
            const orig = (el.propertyName ?? el.name).text;
            if (isLocalSymbolNonCallableConstantInFile(sf, orig)) {
              return true;
            }
            const binding = findValueModuleBinding(sf, orig);
            if (binding) {
              const resolved = resolveModulePath(binding.moduleSpecifier, sf.fileName, repoRoot, workspaceRegistry);
              if (resolved) {
                const lookupSymbol =
                  binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
                    ? binding.importedName
                    : binding.importedName === 'default'
                      ? 'default'
                      : orig;
                if (
                  isKnownNonCallableConstantExport(
                    resolved,
                    lookupSymbol,
                    sourceFileByRelPath,
                    repoRoot,
                    workspaceRegistry,
                    depth + 1,
                    visited
                  )
                ) {
                  return true;
                }
              }
            }
          }
        }
      }
    }
  }

  return false;
}

/**
 * Reconciles intra-repo import bindings, unresolved edges, and orphan contracts.
 */
export function reconcileUnresolvedConnections(
  parsedUnits: readonly ParsedSourceUnit[],
  nodes: StructuralNode[],
  edges: StructuralEdge[],
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry
): void {
  const nodeById = new Map<string, StructuralNode>(nodes.map((n) => [n.id, n]));
  const sourceFileByRelPath = new Map<string, ts.SourceFile>();
  const unitByRelPath = new Map<string, ParsedSourceUnit>();

  for (const u of parsedUnits) {
    const norm = normalizePath(u.relativePath);
    sourceFileByRelPath.set(norm, u.sourceFile);
    unitByRelPath.set(norm, u);
  }

  // Index extracted CONTRACT / CLASS nodes by (filePath::symbolName)
  const contractsByFileAndSymbol = new Map<string, StructuralNode[]>();
  const contractsByFile = new Map<string, StructuralNode[]>();
  const contractsBySymbol = new Map<string, StructuralNode[]>();
  for (const n of nodes) {
    if (n.type !== 'CONTRACT' && !(n.type === 'BOUNDARY' && n.entityType === 'CLASS')) continue;
    if (n.entityType === 'EVENT_LISTENER') continue;
    const fp = primaryFilePath(n);
    if (!fp) continue;
    const fileList = contractsByFile.get(fp) ?? [];
    fileList.push(n);
    contractsByFile.set(fp, fileList);
    for (const sym of extractSymbolFromNodeName(n)) {
      const key = `${fp}::${sym}`;
      const list = contractsByFileAndSymbol.get(key) ?? [];
      list.push(n);
      contractsByFileAndSymbol.set(key, list);
      if (n.type === 'CONTRACT' && (!n.scope || n.scope === 'USER')) {
        const symList = contractsBySymbol.get(sym) ?? [];
        symList.push(n);
        contractsBySymbol.set(sym, symList);
      }
    }
  }
  for (const [key, list] of contractsByFileAndSymbol.entries()) {
    const sepIdx = key.lastIndexOf('::');
    const sym = sepIdx >= 0 ? key.slice(sepIdx + 2) : '';
    if (!sym || sym.includes('.')) continue;
    if (
      list.some((n) => n.entityType !== 'PUBLIC_METHOD') &&
      list.some((n) => n.entityType === 'PUBLIC_METHOD')
    ) {
      contractsByFileAndSymbol.set(
        key,
        list.filter((n) => n.entityType !== 'PUBLIC_METHOD')
      );
    }
  }
  for (const [fp, fileList] of contractsByFile.entries()) {
    const defaultKey = `${fp}::default`;
    if (!contractsByFileAndSymbol.has(defaultKey)) {
      const sf = sourceFileByRelPath.get(fp);
      if (fileList.length === 1) {
        const hasDefaultExport = sf?.statements.some(
          (s) =>
            (ts.isExportAssignment(s) && !s.isExportEquals) ||
            (ts.canHaveModifiers(s) &&
              ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        );
        if (hasDefaultExport) {
          contractsByFileAndSymbol.set(defaultKey, [fileList[0]]);
        }
      } else if (sf) {
        for (const s of sf.statements) {
          if (
            ts.isClassDeclaration(s) &&
            s.name &&
            s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
          ) {
            const clsNodes = contractsByFileAndSymbol.get(`${fp}::${s.name.text}`);
            if (clsNodes && clsNodes.length > 0) {
              contractsByFileAndSymbol.set(defaultKey, clsNodes);
            }
            break;
          }
          if (ts.isExportAssignment(s) && !s.isExportEquals && ts.isIdentifier(s.expression)) {
            const clsNodes = contractsByFileAndSymbol.get(`${fp}::${s.expression.text}`);
            if (clsNodes && clsNodes.length > 0) {
              contractsByFileAndSymbol.set(defaultKey, clsNodes);
            }
            break;
          }
        }
      }
    }
  }

  // Build resolved connectivity lookup:
  // Direct `sourceId -> targetId` AND 2-hop via OPEN_CONNECTOR (`sourceId -> connectorId -> targetId`),
  // plus file-level `sourceFilePath -> targetId` for module/connector-mediated edges.
  const resolvedTargetsBySourceId = new Map<string, Set<string>>();
  const resolvedTargetsBySourceFile = new Map<string, Set<string>>();
  const resolvedTargetFilesBySourceId = new Map<string, Set<string>>();
  const resolvedTargetFilesBySourceFile = new Map<string, Set<string>>();
  const connectorTargets = new Map<string, Set<string>>();
  const resolvedOpenConnectorLinesByFile = new Map<string, Set<number>>();
  const resolvedOpenConnectorExpressionsByOwner = new Map<string, Set<string>>();
  const resolvedCallLinesByFile = new Map<string, Set<number>>();
  const unresolvedCallLinesByFile = new Map<string, Set<number>>();
  const resolvedRenderLinesByFile = new Map<string, Set<number>>();

  for (const e of edges) {
    if (e.entityType === 'RENDERS' && e.targetId) {
      const evList = Array.isArray(e.evidence) ? e.evidence : e.evidence ? [e.evidence] : [];
      for (const ev of evList) {
        if (!ev.filePath || typeof ev.lineNumber !== 'number') continue;
        const evFp = normalizePath(ev.filePath);
        let lineSet = resolvedRenderLinesByFile.get(evFp);
        if (!lineSet) {
          lineSet = new Set<number>();
          resolvedRenderLinesByFile.set(evFp, lineSet);
        }
        lineSet.add(ev.lineNumber);
      }
      continue;
    }
    if (e.entityType !== 'CALL') continue;
    const evList = Array.isArray(e.evidence) ? e.evidence : e.evidence ? [e.evidence] : [];
    for (const ev of evList) {
      if (ev.evidenceRole !== 'syntax-call' || !ev.filePath || typeof ev.lineNumber !== 'number') {
        continue;
      }
      const evFp = normalizePath(ev.filePath);
      const targetMap = e.targetId ? resolvedCallLinesByFile : unresolvedCallLinesByFile;
      let lineSet = targetMap.get(evFp);
      if (!lineSet) {
        lineSet = new Set<number>();
        targetMap.set(evFp, lineSet);
      }
      lineSet.add(ev.lineNumber);
    }
  }

  for (const e of edges) {
    if (!e.targetId) continue;
    const srcNode = nodeById.get(e.sourceId);
    if (srcNode?.type === 'OPEN_CONNECTOR') {
      const set = connectorTargets.get(e.sourceId) ?? new Set<string>();
      set.add(e.targetId);
      connectorTargets.set(e.sourceId, set);
    }
  }

  for (const e of edges) {
    if (!e.targetId) continue;
    let set = resolvedTargetsBySourceId.get(e.sourceId);
    if (!set) {
      set = new Set<string>();
      resolvedTargetsBySourceId.set(e.sourceId, set);
    }
    set.add(e.targetId);

    const tgtNode = nodeById.get(e.targetId);
    if (tgtNode?.entityType === 'PUBLIC_METHOD' && tgtNode.parentBoundaryId) {
      set.add(tgtNode.parentBoundaryId);
    }
    if (tgtNode) {
      const tgtFp = primaryFilePath(tgtNode);
      if (tgtFp) {
        let tfSet = resolvedTargetFilesBySourceId.get(e.sourceId);
        if (!tfSet) {
          tfSet = new Set<string>();
          resolvedTargetFilesBySourceId.set(e.sourceId, tfSet);
        }
        tfSet.add(tgtFp);
        const srcFp = primaryFilePath(e);
        if (srcFp) {
          let sfSet = resolvedTargetFilesBySourceFile.get(srcFp);
          if (!sfSet) {
            sfSet = new Set<string>();
            resolvedTargetFilesBySourceFile.set(srcFp, sfSet);
          }
          sfSet.add(tgtFp);
        }
      }
      const colonIdx = tgtNode.name.indexOf(': ');
      if (tgtFp && colonIdx !== -1) {
        const afterColon = tgtNode.name.slice(colonIdx + 2).trim();
        const dotIdx = afterColon.indexOf('.');
        if (dotIdx !== -1) {
          const baseSym = afterColon.slice(0, dotIdx);
          const baseContracts = contractsByFileAndSymbol.get(`${tgtFp}::${baseSym}`);
          if (baseContracts) {
            for (const bc of baseContracts) set.add(bc.id);
          }
        }
      }
    }
    if (
      tgtNode?.type === 'OPEN_CONNECTOR' &&
      tgtNode.entityType !== 'EXTERNAL_PACKAGE' &&
      tgtNode.entityType !== 'NODE_BUILTIN'
    ) {
      const colonIdx = tgtNode.name.indexOf(': ');
      if (colonIdx !== -1) {
        const expr = tgtNode.name.slice(colonIdx + 2).trim();
        if (expr) {
          let exprSet = resolvedOpenConnectorExpressionsByOwner.get(e.sourceId);
          if (!exprSet) {
            exprSet = new Set<string>();
            resolvedOpenConnectorExpressionsByOwner.set(e.sourceId, exprSet);
          }
          exprSet.add(expr);
        }
      }
      const evList = Array.isArray(e.evidence) ? e.evidence : e.evidence ? [e.evidence] : [];
      for (const ev of evList) {
        if (ev.evidenceRole === 'target-signature' || !ev.filePath || typeof ev.lineNumber !== 'number') {
          continue;
        }
        const evFp = normalizePath(ev.filePath);
        let lineSet = resolvedOpenConnectorLinesByFile.get(evFp);
        if (!lineSet) {
          lineSet = new Set<number>();
          resolvedOpenConnectorLinesByFile.set(evFp, lineSet);
        }
        lineSet.add(ev.lineNumber);
      }
    }

    const viaConnector = connectorTargets.get(e.targetId);
    if (viaConnector) {
      for (const tid of viaConnector) set.add(tid);
    }

    const fp = primaryFilePath(e);
    if (fp) {
      let fileSet = resolvedTargetsBySourceFile.get(fp);
      if (!fileSet) {
        fileSet = new Set<string>();
        resolvedTargetsBySourceFile.set(fp, fileSet);
      }
      fileSet.add(e.targetId);
      if (tgtNode?.entityType === 'PUBLIC_METHOD' && tgtNode.parentBoundaryId) {
        fileSet.add(tgtNode.parentBoundaryId);
      }
      if (viaConnector) {
        for (const tid of viaConnector) fileSet.add(tid);
      }
    }
  }

  const incomingByTargetId = new Map<string, UnresolvedIncomingReference[]>();
  const outgoingByCallerId = new Map<string, UnresolvedOutgoingReference[]>();

  const recordIncoming = (targetId: string, ref: UnresolvedIncomingReference) => {
    const list = incomingByTargetId.get(targetId) ?? [];
    const dup = list.some(
      (r) => r.callerId === ref.callerId && r.filePath === ref.filePath && r.lineNumber === ref.lineNumber && r.symbol === ref.symbol
    );
    if (!dup) {
      list.push(ref);
      incomingByTargetId.set(targetId, list);
    }
  };

  const recordOutgoing = (callerId: string, ref: UnresolvedOutgoingReference) => {
    const list = outgoingByCallerId.get(callerId) ?? [];
    const dup = list.some(
      (r) =>
        r.importSpecifier === ref.importSpecifier &&
        r.targetSymbol === ref.targetSymbol &&
        r.filePath === ref.filePath &&
        r.lineNumber === ref.lineNumber
    );
    if (!dup) {
      list.push(ref);
      outgoingByCallerId.set(callerId, list);
    }
  };

  const isDeclaredInSourceFile = (sf: ts.SourceFile, symbolName: string): boolean => {
    let found = false;
    const checkBindingName = (name: ts.BindingName): void => {
      if (found) return;
      if (ts.isIdentifier(name)) {
        if (name.text === symbolName) found = true;
        return;
      }
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) checkBindingName(el.name);
      }
    };
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isEnumDeclaration(node) ||
          ts.isModuleDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === symbolName
      ) {
        found = true;
        return;
      }
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        checkBindingName(node.name);
        if (found) return;
      }
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        checkBindingName(node.variableDeclaration.name);
        if (found) return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  };

  // 1. Enrich unresolved CALL / RENDERS edges with intra-repo import resolution diagnostics
  for (const edge of edges) {
    if (edge.targetId) continue;
    if (edge.entityType !== 'CALL' && edge.entityType !== 'RENDERS') continue;

    const fp = primaryFilePath(edge);
    if (!fp) continue;
    const sf = sourceFileByRelPath.get(fp);
    if (!sf) continue;

    const parsedCallee = parseEdgeCalleeSymbol(edge);
    if (!parsedCallee) continue;
    if (parsedCallee.memberName && BUILTIN_COLLECTION_PROTOTYPE_METHODS.has(parsedCallee.memberName)) {
      continue;
    }

    const binding = findValueModuleBinding(sf, parsedCallee.rootName);
    if (edge.patternId === 'relationship.invoke-returned-function' && !edge.metadata?.unresolvedReason) {
      if (
        edge.entityType === 'CALL' &&
        !parsedCallee.memberName &&
        !binding &&
        !isDeclaredInSourceFile(sf, parsedCallee.rootName)
      ) {
        const symMatches = contractsBySymbol.get(parsedCallee.rootName);
        if (symMatches && symMatches.length > 0) {
          const targetContract = symMatches[0];
          const targetFp = primaryFilePath(targetContract);
          edge.patternId = 'relationship.function-call';
          edge.confidence = 'MEDIUM';
          edge.metadata = {
            ...edge.metadata,
            unresolvedReason: 'missing-target-export',
            targetSymbol: parsedCallee.rootName,
            ...(targetFp ? { resolvedFilePath: targetFp } : {}),
          };
          const evList = Array.isArray(edge.evidence) ? edge.evidence : edge.evidence ? [edge.evidence] : [];
          const primaryEv = evList[0];
          const lineNumber = primaryEv?.lineNumber ?? 1;
          const snippet = primaryEv?.snippet ?? `${parsedCallee.rootName}()`;
          if (edge.sourceId) {
            recordOutgoing(edge.sourceId, {
              targetContractId: targetContract.id,
              targetContractName: targetContract.name,
              targetSymbol: parsedCallee.rootName,
              importSpecifier: targetFp ?? parsedCallee.rootName,
              ...(targetFp ? { resolvedFilePath: targetFp } : {}),
              filePath: fp,
              lineNumber,
              snippet,
              usageKind: 'call',
              reason: 'unlinked-import-reference',
            });
            const callerNode = nodeById.get(edge.sourceId);
            recordIncoming(targetContract.id, {
              callerId: edge.sourceId,
              callerName: callerNode?.name ?? edge.sourceId,
              filePath: fp,
              lineNumber,
              snippet,
              symbol: parsedCallee.rootName,
              importSpecifier: targetFp ?? parsedCallee.rootName,
              usageKind: 'call',
              reason: 'unlinked-import-reference',
            });
          }
        }
      }
      continue;
    }

    if (!binding) continue;
    if (isExternalSpecifier(binding.moduleSpecifier, sf.fileName, repoRoot, workspaceRegistry)) {
      continue;
    }

    const resolvedPath = resolveModulePath(
      binding.moduleSpecifier,
      sf.fileName,
      repoRoot,
      workspaceRegistry
    );
    if (resolvedPath) {
      const targetUnit = unitByRelPath.get(normalizePath(resolvedPath));
      if (targetUnit && targetUnit.scope !== 'USER') {
        continue;
      }
    }
    const targetSymbol =
      parsedCallee.memberName ??
      (binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
        ? binding.importedName
        : parsedCallee.rootName);

    const existingReason = edge.metadata?.unresolvedReason as UnresolvedConnectionReason | undefined;
    const existingResolvedFilePath =
      typeof edge.metadata?.resolvedFilePath === 'string' ? edge.metadata.resolvedFilePath : undefined;
    const unresolvedReason: UnresolvedConnectionReason = !resolvedPath
      ? 'unresolved-import-path'
      : existingReason === 'unextracted-target-contract'
        ? 'unextracted-target-contract'
        : 'missing-target-export';

    edge.metadata = {
      ...edge.metadata,
      unresolvedReason,
      importSpecifier: binding.moduleSpecifier,
      ...(existingResolvedFilePath
        ? { resolvedFilePath: normalizePath(existingResolvedFilePath) }
        : resolvedPath
          ? { resolvedFilePath: normalizePath(resolvedPath) }
          : {}),
      targetSymbol,
    };
  }

  // 2. Reconcile intra-repo imports & AST identifier usages per USER file

  for (const unit of parsedUnits) {
    if (unit.scope !== 'USER') continue;
    const { sourceFile, relativePath, ownerByNode } = unit;
    const normRelPath = normalizePath(relativePath);

    interface LocalImportTarget {
      localName: string;
      lookupSymbol: string;
      importSpecifier: string;
      resolvedPath: string | null;
      targetNode?: StructuralNode;
      importNode: ts.Node;
      isNamespaceOrModule?: boolean;
    }

    const trackedImports = new Map<string, LocalImportTarget>();
    const aliasedModuleIdentifiers = new Set<ts.Identifier>();

    const registerImportedLocal = (
      localName: string,
      importedSymbol: string,
      importSpecifier: string,
      resolvedPath: string | null,
      declNode: ts.Node,
      isNamespaceOrModule = false
    ) => {
      if (
        importSpecifier.endsWith('.json') ||
        (resolvedPath && resolvedPath.endsWith('.json'))
      ) {
        return;
      }
      const targetNode = resolvedPath
        ? findTargetContractNode(
            resolvedPath,
            importedSymbol,
            contractsByFileAndSymbol,
            sourceFileByRelPath,
            repoRoot,
            workspaceRegistry
          )
        : undefined;

      if (targetNode) {
        targetNode.metadata = { ...targetNode.metadata, isImportedInRepo: true };
      }

      trackedImports.set(localName, {
        localName,
        lookupSymbol: importedSymbol,
        importSpecifier,
        resolvedPath: resolvedPath ? normalizePath(resolvedPath) : null,
        targetNode,
        importNode: declNode,
        isNamespaceOrModule,
      });
    };

    for (const stmt of sourceFile.statements) {
      if (
        ts.isImportEqualsDeclaration(stmt) &&
        stmt.moduleReference &&
        ts.isExternalModuleReference(stmt.moduleReference) &&
        stmt.moduleReference.expression &&
        ts.isStringLiteral(stmt.moduleReference.expression)
      ) {
        const importSpecifier = stmt.moduleReference.expression.text;
        if (isExternalSpecifier(importSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
          continue;
        }

        const resolvedPath = resolveModulePath(
          importSpecifier,
          sourceFile.fileName,
          repoRoot,
          workspaceRegistry
        );
        registerImportedLocal(stmt.name.text, '*', importSpecifier, resolvedPath, stmt, true);
        continue;
      }

      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.importClause) {
        if (stmt.importClause.isTypeOnly) continue;

        const importSpecifier = stmt.moduleSpecifier.text;
        if (isExternalSpecifier(importSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
          continue;
        }

        const resolvedPath = resolveModulePath(
          importSpecifier,
          sourceFile.fileName,
          repoRoot,
          workspaceRegistry
        );

        const clause = stmt.importClause;
        if (clause.name) {
          registerImportedLocal(clause.name.text, 'default', importSpecifier, resolvedPath, clause.name, false);
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            registerImportedLocal(
              clause.namedBindings.name.text,
              '*',
              importSpecifier,
              resolvedPath,
              clause.namedBindings,
              true
            );
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              if (el.isTypeOnly) continue;
              const importedSymbol = (el.propertyName ?? el.name).text;
              registerImportedLocal(el.name.text, importedSymbol, importSpecifier, resolvedPath, el, false);
            }
          }
        }
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!decl.initializer) continue;
          const req = unwrapRequire(decl.initializer);
          if (req) {
            if (isExternalSpecifier(req.specifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
              continue;
            }
            const resolvedPath = resolveModulePath(
              req.specifier,
              sourceFile.fileName,
              repoRoot,
              workspaceRegistry
            );
            if (ts.isIdentifier(decl.name)) {
              const lookupSymbol = req.member ?? 'default';
              registerImportedLocal(
                decl.name.text,
                lookupSymbol,
                req.specifier,
                resolvedPath,
                decl.name,
                !req.member
              );
            } else if (ts.isObjectBindingPattern(decl.name)) {
              for (const el of decl.name.elements) {
                if (ts.isIdentifier(el.name)) {
                  const importedSymbol =
                    el.propertyName && ts.isIdentifier(el.propertyName)
                      ? el.propertyName.text
                      : el.name.text;
                  registerImportedLocal(
                    el.name.text,
                    importedSymbol,
                    req.specifier,
                    resolvedPath,
                    el,
                    false
                  );
                }
              }
            }
          } else if (
            ts.isIdentifier(decl.name) &&
            ts.isPropertyAccessExpression(decl.initializer) &&
            ts.isIdentifier(decl.initializer.expression)
          ) {
            const parentImport = trackedImports.get(decl.initializer.expression.text);
            if (
              parentImport &&
              (parentImport.isNamespaceOrModule ||
                parentImport.lookupSymbol === 'default' ||
                parentImport.lookupSymbol === '*')
            ) {
              const propName = decl.initializer.name.text;
              const normParentPath = parentImport.resolvedPath
                ? normalizePath(parentImport.resolvedPath)
                : null;
              const isFactoryOrDefaultObjectContract =
                parentImport.targetNode?.patternId === 'contract.factory-call-exported-const' ||
                parentImport.targetNode?.patternId === 'contract.es6-export-default';
              const hasMemberContract =
                !isFactoryOrDefaultObjectContract ||
                !normParentPath ||
                contractsByFileAndSymbol.has(`${normParentPath}::${propName}`) ||
                contractsByFileAndSymbol.has(`${normParentPath}::default.${propName}`);
              if (hasMemberContract) {
                aliasedModuleIdentifiers.add(decl.initializer.expression);
                registerImportedLocal(
                  decl.name.text,
                  propName,
                  parentImport.importSpecifier,
                  parentImport.resolvedPath,
                  decl.name,
                  false
                );
              }
            }
          } else if (
            ts.isObjectBindingPattern(decl.name) &&
            ts.isIdentifier(decl.initializer)
          ) {
            const parentImport = trackedImports.get(decl.initializer.text);
            if (
              parentImport &&
              (parentImport.isNamespaceOrModule ||
                parentImport.lookupSymbol === 'default' ||
                parentImport.lookupSymbol === '*')
            ) {
              aliasedModuleIdentifiers.add(decl.initializer);
              for (const el of decl.name.elements) {
                if (ts.isIdentifier(el.name)) {
                  const importedSymbol =
                    el.propertyName && ts.isIdentifier(el.propertyName)
                      ? el.propertyName.text
                      : el.name.text;
                  registerImportedLocal(
                    el.name.text,
                    importedSymbol,
                    parentImport.importSpecifier,
                    parentImport.resolvedPath,
                    el,
                    false
                  );
                }
              }
            }
          }
        }
      }
    }

    if (trackedImports.size === 0) continue;

    // Collect value-level identifier references for all tracked intra-repo imports in this file
    const usagesByLocalName = new Map<string, ts.Identifier[]>();
    const typeUsagesByLocalName = new Set<string>();
    const visitUsages = (node: ts.Node) => {
      if (
        ts.isIdentifier(node) &&
        trackedImports.has(node.text) &&
        !aliasedModuleIdentifiers.has(node)
      ) {
        if (!isInsideTypeOrDeclarationName(node)) {
          const list = usagesByLocalName.get(node.text) ?? [];
          list.push(node);
          usagesByLocalName.set(node.text, list);
        } else if (isInsideTypeAnnotationPosition(node)) {
          typeUsagesByLocalName.add(node.text);
        }
      }
      ts.forEachChild(node, visitUsages);
    };
    visitUsages(sourceFile);

    for (const [localName, info] of trackedImports.entries()) {
      // Skip Pure Type exports (Interfaces / Type Aliases)
      if (info.targetNode?.entityType === 'EXPORTED_TYPE') continue;
      // Skip known non-callable constant/enum/data exports when imported directly by name
      if (
        !info.targetNode &&
        !info.isNamespaceOrModule &&
        info.lookupSymbol !== '*' &&
        info.resolvedPath &&
        isKnownNonCallableConstantExport(
          info.resolvedPath,
          info.lookupSymbol,
          sourceFileByRelPath,
          repoRoot,
          workspaceRegistry
        )
      ) {
        continue;
      }

      const usages = usagesByLocalName.get(localName) ?? [];
      if (usages.length === 0) {
        if (typeUsagesByLocalName.has(localName)) {
          if (info.targetNode) {
            info.targetNode.metadata = {
              ...info.targetNode.metadata,
              isImportedInRepo: true,
            };
          }
          continue;
        }
        // Imported in this file, but has 0 value-level AST references (e.g. commented-out call or unused import)
        if (info.targetNode) {
          const fileTargets = resolvedTargetsBySourceFile.get(normRelPath);
          if (!fileTargets?.has(info.targetNode.id)) {
            const { lineNumber, snippet } = snippetForNode(info.importNode, sourceFile);
            const fallbackCallerId = getFileFallbackOwnerId(unit);
            const fallbackCaller = nodeById.get(fallbackCallerId);
            recordIncoming(info.targetNode.id, {
              callerId: fallbackCallerId,
              callerName: fallbackCaller?.name ?? normRelPath,
              filePath: normRelPath,
              lineNumber,
              snippet,
              symbol: info.lookupSymbol,
              importSpecifier: info.importSpecifier,
              usageKind: 'unused-import',
              reason: 'imported-but-never-invoked',
            });
          }
        }
        continue;
      }

      for (const ident of usages) {
        let directOwnerId: string | undefined;
        for (let cur: ts.Node | undefined = ident.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
          if (ts.isDecorator(cur)) break;
          const owned = ownerByNode.get(cur);
          if (owned) {
            directOwnerId = owned;
            break;
          }
        }
        const ownerId =
          findScopeOwnerId(ident, ownerByNode) ?? directOwnerId ?? getFileFallbackOwnerId(unit);
        const ownerNode = nodeById.get(ownerId);
        const { lineNumber, snippet } = snippetForNode(ident, sourceFile);
        const { segments, outerExpression } = unwrapMemberAccessChain(ident);
        const usageKind = classifyUsageKind(ident, outerExpression);

        let effectiveSymbol = info.lookupSymbol;
        let effectiveResolvedPath = info.resolvedPath;
        let effectiveTargetNode = info.targetNode;

        let resolvedNestedObjectContract = false;
        if (segments.length >= 1 && effectiveResolvedPath) {
          const candidateSymbols =
            info.lookupSymbol === '*'
              ? [segments.join('.')]
              : info.lookupSymbol === 'default'
                ? [`${localName}.${segments.join('.')}`, `default.${segments.join('.')}`]
                : [`${info.lookupSymbol}.${segments.join('.')}`];
          for (const candSym of candidateSymbols) {
            const nestedTarget = findTargetContractNode(
              effectiveResolvedPath,
              candSym,
              contractsByFileAndSymbol,
              sourceFileByRelPath,
              repoRoot,
              workspaceRegistry
            );
            if (nestedTarget) {
              effectiveSymbol = candSym;
              effectiveTargetNode = nestedTarget;
              effectiveTargetNode.metadata = {
                ...effectiveTargetNode.metadata,
                isImportedInRepo: true,
              };
              if (info.targetNode) {
                info.targetNode.metadata = {
                  ...info.targetNode.metadata,
                  isImportedInRepo: true,
                };
              }
              resolvedNestedObjectContract = true;
              break;
            }
          }
        }

        if (usageKind === 'call') {
          const fullAccessExpr = segments.length > 0 ? `${localName}.${segments.join('.')}` : localName;
          const isResolvedOpenConnectorCall =
            Boolean(resolvedOpenConnectorLinesByFile.get(normRelPath)?.has(lineNumber)) ||
            Boolean(resolvedOpenConnectorExpressionsByOwner.get(ownerId)?.has(fullAccessExpr));
          if (isResolvedOpenConnectorCall) {
            if (info.targetNode) {
              info.targetNode.metadata = { ...info.targetNode.metadata, isImportedInRepo: true };
              let oSet = resolvedTargetsBySourceId.get(ownerId);
              if (!oSet) {
                oSet = new Set<string>();
                resolvedTargetsBySourceId.set(ownerId, oSet);
              }
              oSet.add(info.targetNode.id);
              let fSet = resolvedTargetsBySourceFile.get(normRelPath);
              if (!fSet) {
                fSet = new Set<string>();
                resolvedTargetsBySourceFile.set(normRelPath, fSet);
              }
              fSet.add(info.targetNode.id);
            }
            continue;
          }
        }

        if (
          !resolvedNestedObjectContract &&
          segments.length > 0 &&
          (info.isNamespaceOrModule ||
            info.lookupSymbol === 'default' ||
            info.lookupSymbol === '*' ||
            !info.targetNode)
        ) {
          const leafMember = segments[segments.length - 1];
          const subSegments = segments.slice(0, -1);
          if (segments[0] === 'prototype') {
            if (segments.length === 1 && info.targetNode) {
              info.targetNode.metadata = { ...info.targetNode.metadata, isImportedInRepo: true };
              continue;
            }
            const protoMethodName = segments.length >= 2 ? segments[1] : null;
            const protoTarget =
              protoMethodName && effectiveResolvedPath
                ? findTargetContractNode(
                    effectiveResolvedPath,
                    protoMethodName,
                    contractsByFileAndSymbol,
                    sourceFileByRelPath,
                    repoRoot,
                    workspaceRegistry
                  )
                : undefined;
            if (protoTarget) {
              protoTarget.metadata = { ...protoTarget.metadata, isImportedInRepo: true };
              continue;
            }
            if (info.targetNode) {
              info.targetNode.metadata = { ...info.targetNode.metadata, isImportedInRepo: true };
              continue;
            }
          }
          let subPath: string | null | undefined;
          if (info.resolvedPath && subSegments.length > 0) {
            subPath = followCjsSubmodulePath(
              info.resolvedPath,
              subSegments,
              sourceFileByRelPath,
              repoRoot,
              workspaceRegistry
            );
            if (subPath) {
              effectiveResolvedPath = subPath;
            }
          }
          const leafTarget =
            effectiveResolvedPath && (subSegments.length === 0 || Boolean(subPath))
              ? findTargetContractNode(
                  effectiveResolvedPath,
                  leafMember,
                  contractsByFileAndSymbol,
                  sourceFileByRelPath,
                  repoRoot,
                  workspaceRegistry
                )
              : undefined;
          if (leafTarget) {
            effectiveSymbol = leafMember;
            effectiveTargetNode = leafTarget;
            if (effectiveTargetNode.entityType === 'EXPORTED_TYPE') continue;
            effectiveTargetNode.metadata = { ...effectiveTargetNode.metadata, isImportedInRepo: true };
            if (info.targetNode) {
              info.targetNode.metadata = { ...info.targetNode.metadata, isImportedInRepo: true };
              if (resolvedTargetsBySourceId.get(ownerId)?.has(leafTarget.id)) {
                resolvedTargetsBySourceId.get(ownerId)?.add(info.targetNode.id);
              }
              if (resolvedTargetsBySourceFile.get(normRelPath)?.has(leafTarget.id)) {
                resolvedTargetsBySourceFile.get(normRelPath)?.add(info.targetNode.id);
              }
            }
          } else if (BUILTIN_COLLECTION_PROTOTYPE_METHODS.has(leafMember)) {
            continue;
          } else if (info.lookupSymbol === 'default' && info.targetNode && !info.isNamespaceOrModule) {
            info.targetNode.metadata = { ...info.targetNode.metadata, isImportedInRepo: true };
            if (usageKind !== 'call') {
              continue;
            }
          } else {
            effectiveSymbol = subSegments.length > 0 && !subPath ? `${subSegments.join('.')}.${leafMember}` : leafMember;
            effectiveTargetNode = undefined;
          }
        }

        if (!effectiveResolvedPath) {
          if (info.importSpecifier && isStaticAssetPath(info.importSpecifier)) {
            continue;
          }
          recordOutgoing(ownerId, {
            targetSymbol: effectiveSymbol,
            importSpecifier: info.importSpecifier,
            filePath: normRelPath,
            lineNumber,
            snippet,
            usageKind,
            reason: 'unresolved-import-path',
          });
          continue;
        }

        if (usageKind === 'reexport-delegation') {
          continue;
        }

        // Skip imports targeting non-USER files (e.g. MOCK or TEST fixtures/mocks)
        const targetUnit = unitByRelPath.get(normalizePath(effectiveResolvedPath));
        if (targetUnit && targetUnit.scope !== 'USER') {
          continue;
        }

        if (!effectiveTargetNode) {
          if (
            (usageKind === 'call' &&
              resolvedCallLinesByFile.get(normRelPath)?.has(lineNumber) &&
              !unresolvedCallLinesByFile.get(normRelPath)?.has(lineNumber)) ||
            (usageKind === 'jsx-element' &&
              resolvedRenderLinesByFile.get(normRelPath)?.has(lineNumber))
          ) {
            if (info.targetNode) {
              info.targetNode.metadata = { ...info.targetNode.metadata, isImportedInRepo: true };
              let oSet = resolvedTargetsBySourceId.get(ownerId);
              if (!oSet) {
                oSet = new Set<string>();
                resolvedTargetsBySourceId.set(ownerId, oSet);
              }
              oSet.add(info.targetNode.id);
              let fSet = resolvedTargetsBySourceFile.get(normRelPath);
              if (!fSet) {
                fSet = new Set<string>();
                resolvedTargetsBySourceFile.set(normRelPath, fSet);
              }
              fSet.add(info.targetNode.id);
            }
            continue;
          }
          const normTarget = normalizePath(effectiveResolvedPath);
          if (effectiveSymbol === '*') {
            for (const [k, list] of contractsByFileAndSymbol.entries()) {
              if (k.startsWith(`${normTarget}::`)) {
                for (const cn of list) {
                  cn.metadata = { ...cn.metadata, isImportedInRepo: true };
                }
              }
            }
            continue;
          }
          if (
            info.lookupSymbol === 'default' &&
            (Boolean(resolvedTargetFilesBySourceId.get(ownerId)?.has(normTarget)) ||
              Boolean(resolvedTargetFilesBySourceFile.get(normRelPath)?.has(normTarget)))
          ) {
            const targetFileContracts = contractsByFile.get(normTarget);
            if (targetFileContracts) {
              for (const cn of targetFileContracts) {
                cn.metadata = { ...cn.metadata, isImportedInRepo: true };
              }
            }
            continue;
          }
          if (
            (effectiveResolvedPath && isStaticAssetPath(effectiveResolvedPath)) ||
            (info.importSpecifier && isStaticAssetPath(info.importSpecifier))
          ) {
            continue;
          }

          if (
            usageKind !== 'call' &&
            usageKind !== 'jsx-element' &&
            isKnownNonCallableConstantExport(
              effectiveResolvedPath,
              effectiveSymbol,
              sourceFileByRelPath,
              repoRoot,
              workspaceRegistry
            )
          ) {
            continue;
          }
          recordOutgoing(ownerId, {
            targetSymbol: effectiveSymbol,
            importSpecifier: info.importSpecifier,
            resolvedFilePath: effectiveResolvedPath,
            filePath: normRelPath,
            lineNumber,
            snippet,
            usageKind,
            reason: 'unextracted-target-contract',
          });
          continue;
        }

        const ownerTargets = resolvedTargetsBySourceId.get(ownerId);
        const fileTargets = resolvedTargetsBySourceFile.get(normRelPath);
        const isConnected =
          Boolean(ownerTargets?.has(effectiveTargetNode.id)) ||
          Boolean(fileTargets?.has(effectiveTargetNode.id));

        if (!isConnected) {
          if (
            (usageKind === 'call' || segments.length > 0) &&
            Boolean(resolvedCallLinesByFile.get(normRelPath)?.has(lineNumber)) &&
            !unresolvedCallLinesByFile.get(normRelPath)?.has(lineNumber)
          ) {
            effectiveTargetNode.metadata = {
              ...effectiveTargetNode.metadata,
              isImportedInRepo: true,
            };
            continue;
          }
          if (
            (ts.isParameter(outerExpression.parent) &&
              outerExpression.parent.initializer &&
              unwrapTypeAndParens(outerExpression.parent.initializer) === outerExpression) ||
            (ts.isBindingElement(outerExpression.parent) &&
              outerExpression.parent.initializer &&
              unwrapTypeAndParens(outerExpression.parent.initializer) === outerExpression) ||
            (ts.isBinaryExpression(outerExpression.parent) &&
              (outerExpression.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
                outerExpression.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
              unwrapTypeAndParens(outerExpression.parent.right) === outerExpression) ||
            (ts.isBinaryExpression(outerExpression.parent) &&
              outerExpression.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(outerExpression.parent.left) &&
              unwrapTypeAndParens(outerExpression.parent.right) === outerExpression) ||
            (ts.isPropertyDeclaration(outerExpression.parent) &&
              outerExpression.parent.initializer &&
              unwrapTypeAndParens(outerExpression.parent.initializer) === outerExpression)
          ) {
            effectiveTargetNode.metadata = {
              ...effectiveTargetNode.metadata,
              isImportedInRepo: true,
            };
            continue;
          }
          if (
            effectiveTargetNode.entityType === 'CLASS' &&
            outerExpression.parent &&
            ((ts.isBinaryExpression(outerExpression.parent) &&
              outerExpression.parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
              outerExpression.parent.right === outerExpression) ||
              (ts.isExpressionWithTypeArguments(outerExpression.parent) &&
                ts.isHeritageClause(outerExpression.parent.parent)) ||
              (ts.isNewExpression(outerExpression.parent) &&
                outerExpression.parent.expression === outerExpression))
          ) {
            effectiveTargetNode.metadata = {
              ...effectiveTargetNode.metadata,
              isImportedInRepo: true,
            };
            continue;
          }
          if (
            usageKind !== 'call' &&
            usageKind !== 'jsx-element' &&
            (effectiveTargetNode.patternId === 'contract.factory-call-exported-const' ||
              effectiveTargetNode.patternId === 'contract.exported-factory-instance-and-enum-call' ||
              effectiveTargetNode.patternId === 'contract.exported-object-literal-data-store' ||
              effectiveTargetNode.patternId === 'contract.es6-export-default')
          ) {
            effectiveTargetNode.metadata = {
              ...effectiveTargetNode.metadata,
              isImportedInRepo: true,
            };
            continue;
          }
          if (
            effectiveTargetNode.entityType === 'EXPORTED_MODULE' &&
            usageKind !== 'call' &&
            effectiveResolvedPath
          ) {
            const targetSf = sourceFileByRelPath.get(normalizePath(effectiveResolvedPath));
            if (targetSf && isCjsNonCallableConstantModule(targetSf, effectiveSymbol)) {
              effectiveTargetNode.metadata = {
                ...effectiveTargetNode.metadata,
                isImportedInRepo: true,
              };
              continue;
            }
          }
          recordIncoming(effectiveTargetNode.id, {
            callerId: ownerId,
            callerName: ownerNode?.name ?? ownerId,
            filePath: normRelPath,
            lineNumber,
            snippet,
            symbol: effectiveSymbol,
            importSpecifier: info.importSpecifier,
            usageKind,
            reason: 'unlinked-import-reference',
          });
          recordOutgoing(ownerId, {
            targetContractId: effectiveTargetNode.id,
            targetContractName: effectiveTargetNode.name,
            targetSymbol: effectiveSymbol,
            importSpecifier: info.importSpecifier,
            resolvedFilePath: effectiveResolvedPath,
            filePath: normRelPath,
            lineNumber,
            snippet,
            usageKind,
            reason: 'unlinked-import-reference',
          });
        }
      }
    }
  }

  for (const [targetId, incoming] of incomingByTargetId.entries()) {
    const node = nodeById.get(targetId);
    if (node && incoming.length > 0) {
      node.metadata = {
        ...node.metadata,
        unresolvedIncoming: incoming,
      };
    }
  }

  for (const [callerId, outgoing] of outgoingByCallerId.entries()) {
    const node = nodeById.get(callerId);
    if (node && outgoing.length > 0) {
      node.metadata = {
        ...node.metadata,
        unresolvedOutgoing: outgoing,
      };
    }
  }
}
