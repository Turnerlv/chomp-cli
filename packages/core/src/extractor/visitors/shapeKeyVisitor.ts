// packages/core/src/extractor/visitors/shapeKeyVisitor.ts
//
// v5 Loop 1/3 — Deterministic, identifier-free SHAPE KEYS for call edges.
//
// A shape key is a FACT ABOUT SYNTAX: what kind of binding the callee's root identifier is
// declared by, and the structural skeleton of the callee expression with every identifier,
// literal and path erased. It lets the graph cluster call sites into candidate pattern classes
// (factory returns, two-step prepared statements, parameter callbacks, ...) without regex sweeps
// or AI narration. It is never an inferred explanation (Principle of Incomplete Truth).
//
//   sk1 / CALL / LocalFromCall / Prop(Id)        client.fetchAll()  where  const client = make()
//   sk1 / CALL / Param         / Prop(Prop(Id))  registry.db.prepare()  where registry is a parameter
//   sk1 / CALL / Undeclared    / Call(Id)        makeHandler()()
//
// Closed vocabulary: a key can only be assembled from `SHAPE_KEY_TOKENS`, `SHAPE_KEY_BINDING_KINDS`
// and `ts.SyntaxKind` names, so it can never contain user identifiers, string literals or file
// paths. That is what makes a key safe to display locally and, later, to transmit (Workstream 2).
//
// Keys are stored on `edge.metadata.shapeKey` (deterministic Layer 0 fact; no ontology change).
// `SHAPE_KEY_VERSION` must be bumped whenever the grammar below changes.

import path from 'path';
import ts from 'typescript';
import { StructuralEntity } from '../../types/index.js';
import { resolveModulePath } from '../pathResolver.js';
import type { WorkspaceRegistry } from '../workspaceResolver.js';
import { getCachedSourceFile, isExternalSpecifier } from './targetResolver.js';
import {
  REACT_HOC_WRAPPERS,
  unwrapWrappedFunction,
  unwrapCachedFunctionInitializer,
} from '../conventions/index.js';

export const SHAPE_KEY_VERSION = 'sk1';

export interface ShapeKeyOptions {
  repoRoot?: string;
  workspaceRegistry?: WorkspaceRegistry;
}

/** Skeleton depth cap — deeper receiver chains collapse to `..` so rare shapes cannot become unique. */
export const SHAPE_KEY_MAX_DEPTH = 4;

/** Structural tokens emitted by the skeleton grammar (everything else is a `ts.SyntaxKind` name). */
export const SHAPE_KEY_TOKENS = [
  'CALL',
  'NEW',
  'RENDERS',
  'Id',
  'This',
  'Super',
  'Prop',
  'OptProp',
  'Elem',
  'Call',
  'New',
  'Await',
  'Str',
  'Num',
  'Dyn',
] as const;

/**
 * How the callee's root identifier is bound. `Undeclared` means no declaration was found in any
 * enclosing lexical scope (global, ambient or hoisted from elsewhere) — a fact about the AST,
 * not a claim about runtime.
 *
 * Import target-kind splitting (`[PAT-EXT-27]`):
 * - `ImportObject`: imported symbol resolves to an exported object literal (e.g. `export const ansi = { dim: () => {} }`)
 * - `ImportNamespace`: namespace import (`import * as ns from '...'`) or exported namespace (`export * as ns`, `export namespace ns`)
 * - `ImportClass`: imported symbol resolves to an exported `class` declaration/expression
 * - `Import`: any other import (exported function, non-object variable, external package, or unresolvable module)
 */
export const SHAPE_KEY_BINDING_KINDS = [
  'Import',
  'ImportObject',
  'ImportNamespace',
  'ImportClass',
  'Param',
  'ParamDestructured',
  'LocalFromCall',
  'LocalFromNew',
  'LocalFromAwait',
  'LocalRequire',
  'LocalFunction',
  'LocalClass',
  'LocalDestructured',
  'LocalOther',
  'Loop',
  'Catch',
  'This',
  'Super',
  'Undeclared',
  'None',
] as const;

export type ShapeKeyBindingKind = (typeof SHAPE_KEY_BINDING_KINDS)[number];

/** Strips syntax that does not change what is being called (`(x)`, `x!`, `x as T`, `<T>x`, `x satisfies T`). */
function unwrapTransparent(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function syntaxKindName(kind: ts.SyntaxKind): string {
  return ts.SyntaxKind[kind];
}

/** Structural skeleton of an expression with identifiers, literals and paths erased. */
function skeleton(expr: ts.Expression, depth: number): string {
  if (depth > SHAPE_KEY_MAX_DEPTH) return '..';
  const e = unwrapTransparent(expr);

  if (ts.isIdentifier(e)) return 'Id';
  if (e.kind === ts.SyntaxKind.ThisKeyword) return 'This';
  if (e.kind === ts.SyntaxKind.SuperKeyword) return 'Super';
  if (ts.isPropertyAccessExpression(e)) {
    const head = e.questionDotToken ? 'OptProp' : 'Prop';
    return `${head}(${skeleton(e.expression, depth + 1)})`;
  }
  if (ts.isElementAccessExpression(e)) {
    const arg = unwrapTransparent(e.argumentExpression);
    const argKind = ts.isStringLiteralLike(arg) ? 'Str' : ts.isNumericLiteral(arg) ? 'Num' : 'Dyn';
    return `Elem(${skeleton(e.expression, depth + 1)},${argKind})`;
  }
  if (ts.isCallExpression(e)) return `Call(${skeleton(e.expression, depth + 1)})`;
  if (ts.isNewExpression(e)) return `New(${skeleton(e.expression, depth + 1)})`;
  if (ts.isAwaitExpression(e)) return `Await(${skeleton(e.expression, depth + 1)})`;
  return syntaxKindName(e.kind);
}

/** The base expression a callee chain hangs off (`a.b[c].d()` → `a`). */
function rootOfCallee(expr: ts.Expression): ts.Expression {
  let cur = unwrapTransparent(expr);
  for (;;) {
    if (
      ts.isPropertyAccessExpression(cur) ||
      ts.isElementAccessExpression(cur) ||
      ts.isCallExpression(cur) ||
      ts.isNewExpression(cur) ||
      ts.isAwaitExpression(cur)
    ) {
      cur = unwrapTransparent(cur.expression);
      continue;
    }
    return cur;
  }
}

// ── Lexical binding classification ────────────────────────────────────────────

const scopeBindingCache = new WeakMap<ts.Node, Map<string, ShapeKeyBindingKind>>();

function bindingPatternNames(pattern: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(pattern)) {
    out.push(pattern.text);
    return;
  }
  for (const el of pattern.elements) {
    if (ts.isBindingElement(el)) bindingPatternNames(el.name, out);
  }
}

function classifyDeclaration(decl: ts.VariableDeclaration): ShapeKeyBindingKind {
  if (!ts.isIdentifier(decl.name)) return 'LocalDestructured';
  if (!decl.initializer) return 'LocalOther';
  const init = unwrapTransparent(decl.initializer);
  if (ts.isAwaitExpression(init)) return 'LocalFromAwait';
  if (ts.isCallExpression(init)) {
    if (
      unwrapCachedFunctionInitializer(init) !== null ||
      unwrapWrappedFunction(init, REACT_HOC_WRAPPERS) !== null
    ) {
      return 'LocalFunction';
    }
    const callee = unwrapTransparent(init.expression);
    return ts.isIdentifier(callee) && callee.text === 'require' ? 'LocalRequire' : 'LocalFromCall';
  }
  if (ts.isNewExpression(init)) return 'LocalFromNew';
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return 'LocalFunction';
  return 'LocalOther';
}

function recordDeclarations(
  decls: readonly ts.VariableDeclaration[],
  map: Map<string, ShapeKeyBindingKind>,
  override?: ShapeKeyBindingKind
): void {
  for (const d of decls) {
    const names: string[] = [];
    bindingPatternNames(d.name, names);
    const kind = override ?? classifyDeclaration(d);
    for (const n of names) if (!map.has(n)) map.set(n, kind);
  }
}

function recordStatements(statements: ts.NodeArray<ts.Statement>, map: Map<string, ShapeKeyBindingKind>): void {
  for (const s of statements) {
    if (ts.isVariableStatement(s)) {
      recordDeclarations(s.declarationList.declarations, map);
    } else if (ts.isFunctionDeclaration(s) && s.name) {
      if (!map.has(s.name.text)) map.set(s.name.text, 'LocalFunction');
    } else if (ts.isClassDeclaration(s) && s.name) {
      if (!map.has(s.name.text)) map.set(s.name.text, 'LocalClass');
    } else if (ts.isImportDeclaration(s) && s.importClause) {
      const clause = s.importClause;
      if (!clause.isTypeOnly) {
        if (clause.name && !map.has(clause.name.text)) map.set(clause.name.text, 'Import');
        const nb = clause.namedBindings;
        if (nb) {
          if (ts.isNamespaceImport(nb)) {
            if (!map.has(nb.name.text)) map.set(nb.name.text, 'ImportNamespace');
          } else {
            for (const el of nb.elements) {
              if (!el.isTypeOnly && !map.has(el.name.text)) map.set(el.name.text, 'Import');
            }
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(s) &&
      !s.isTypeOnly &&
      s.moduleReference &&
      ts.isExternalModuleReference(s.moduleReference)
    ) {
      if (!map.has(s.name.text)) map.set(s.name.text, 'Import');
    }
  }
}

const importTargetKindCache = new WeakMap<ts.SourceFile, Map<string, ShapeKeyBindingKind>>();

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
}

function classifyInitializerExpr(expr: ts.Expression): ShapeKeyBindingKind | null {
  const unwrapped = unwrapTransparent(expr);
  if (ts.isObjectLiteralExpression(unwrapped)) return 'ImportObject';
  if (ts.isClassExpression(unwrapped)) return 'ImportClass';
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    ts.isIdentifier(unwrapped.expression.expression) &&
    unwrapped.expression.expression.text === 'Object' &&
    (unwrapped.expression.name.text === 'freeze' || unwrapped.expression.name.text === 'assign') &&
    unwrapped.arguments.some((arg) => ts.isObjectLiteralExpression(unwrapTransparent(arg)))
  ) {
    return 'ImportObject';
  }
  return null;
}

function classifyDeclarationInFile(
  sf: ts.SourceFile,
  localSym: string,
  requireExported: boolean,
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry | undefined,
  depth: number,
  visited: Set<string>
): ShapeKeyBindingKind | null {
  for (const stmt of sf.statements) {
    if (requireExported && !hasExportModifier(stmt)) continue;
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === localSym) {
      return 'ImportClass';
    }
    if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name) && stmt.name.text === localSym) {
      return 'ImportNamespace';
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === localSym) {
      return 'Import';
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === localSym) {
          if (!decl.initializer) return 'Import';
          const direct = classifyInitializerExpr(decl.initializer);
          if (direct) return direct;
          const unwrapped = unwrapTransparent(decl.initializer);
          if (ts.isIdentifier(unwrapped) && unwrapped.text !== localSym) {
            return (
              classifyDeclarationInFile(
                sf,
                unwrapped.text,
                false,
                repoRoot,
                workspaceRegistry,
                depth + 1,
                visited
              ) ?? 'Import'
            );
          }
          return 'Import';
        }
      }
    }
  }

  if (!requireExported) {
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.importClause && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const spec = stmt.moduleSpecifier.text;
        const clause = stmt.importClause;
        let importedSym: string | null = null;
        if (clause.name?.text === localSym) {
          importedSym = 'default';
        } else if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            if (clause.namedBindings.name.text === localSym) return 'ImportNamespace';
          } else {
            for (const el of clause.namedBindings.elements) {
              if (el.name.text === localSym) {
                importedSym = (el.propertyName ?? el.name).text;
                break;
              }
            }
          }
        }
        if (importedSym) {
          if (isExternalSpecifier(spec, sf.fileName, repoRoot, workspaceRegistry)) return 'Import';
          const targetRel = resolveModulePath(spec, sf.fileName, repoRoot, workspaceRegistry);
          if (!targetRel) return 'Import';
          return resolveExportedSymbolKindInModule(
            targetRel,
            importedSym,
            repoRoot,
            workspaceRegistry,
            depth + 1,
            visited
          );
        }
      } else if (
        ts.isImportEqualsDeclaration(stmt) &&
        stmt.moduleReference &&
        ts.isExternalModuleReference(stmt.moduleReference) &&
        stmt.moduleReference.expression &&
        ts.isStringLiteral(stmt.moduleReference.expression)
      ) {
        if (stmt.name.text === localSym) {
          const spec = stmt.moduleReference.expression.text;
          if (isExternalSpecifier(spec, sf.fileName, repoRoot, workspaceRegistry)) return 'Import';
          const targetRel = resolveModulePath(spec, sf.fileName, repoRoot, workspaceRegistry);
          if (!targetRel) return 'Import';
          return resolveExportedSymbolKindInModule(
            targetRel,
            'default',
            repoRoot,
            workspaceRegistry,
            depth + 1,
            visited
          );
        }
      }
    }
  }

  return null;
}

function resolveExportedSymbolKindInModule(
  moduleRelPath: string,
  symbolName: string,
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry | undefined,
  depth = 0,
  visited = new Set<string>()
): ShapeKeyBindingKind {
  if (depth > 5) return 'Import';
  const visitKey = `${moduleRelPath}::${symbolName}`;
  if (visited.has(visitKey)) return 'Import';
  visited.add(visitKey);

  const absPath = path.resolve(repoRoot, moduleRelPath);
  const sf = getCachedSourceFile(absPath);
  if (!sf) return 'Import';

  if (symbolName === 'default') {
    for (const stmt of sf.statements) {
      if (hasExportModifier(stmt) && hasDefaultModifier(stmt)) {
        if (ts.isClassDeclaration(stmt)) return 'ImportClass';
        if (ts.isFunctionDeclaration(stmt)) return 'Import';
      }
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        const direct = classifyInitializerExpr(stmt.expression);
        if (direct) return direct;
        const unwrapped = unwrapTransparent(stmt.expression);
        if (ts.isIdentifier(unwrapped)) {
          return (
            classifyDeclarationInFile(
              sf,
              unwrapped.text,
              false,
              repoRoot,
              workspaceRegistry,
              depth + 1,
              visited
            ) ?? 'Import'
          );
        }
        return 'Import';
      }
    }
  } else {
    const directExport = classifyDeclarationInFile(
      sf,
      symbolName,
      true,
      repoRoot,
      workspaceRegistry,
      depth,
      visited
    );
    if (directExport) return directExport;
  }

  const starSpecifiers: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    const spec =
      stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : null;

    if (!spec) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === symbolName) {
            const origName = (el.propertyName ?? el.name).text;
            return (
              classifyDeclarationInFile(
                sf,
                origName,
                false,
                repoRoot,
                workspaceRegistry,
                depth + 1,
                visited
              ) ?? 'Import'
            );
          }
        }
      }
      continue;
    }

    if (!stmt.exportClause) {
      if (symbolName !== 'default') starSpecifiers.push(spec);
      continue;
    }

    if (ts.isNamespaceExport(stmt.exportClause)) {
      if (stmt.exportClause.name.text === symbolName) return 'ImportNamespace';
      continue;
    }

    if (ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.name.text === symbolName) {
          if (isExternalSpecifier(spec, absPath, repoRoot, workspaceRegistry)) return 'Import';
          const targetRel = resolveModulePath(spec, absPath, repoRoot, workspaceRegistry);
          if (!targetRel) return 'Import';
          const origName = (el.propertyName ?? el.name).text;
          return resolveExportedSymbolKindInModule(
            targetRel,
            origName,
            repoRoot,
            workspaceRegistry,
            depth + 1,
            visited
          );
        }
      }
    }
  }

  for (const spec of starSpecifiers) {
    if (isExternalSpecifier(spec, absPath, repoRoot, workspaceRegistry)) continue;
    const targetRel = resolveModulePath(spec, absPath, repoRoot, workspaceRegistry);
    if (!targetRel) continue;
    const kind = resolveExportedSymbolKindInModule(
      targetRel,
      symbolName,
      repoRoot,
      workspaceRegistry,
      depth + 1,
      visited
    );
    if (kind !== 'Import') return kind;
  }

  return 'Import';
}

/**
 * Refines an `'Import'` binding in `sourceFile` into `'ImportObject'`, `'ImportNamespace'`,
 * `'ImportClass'`, or `'Import'` by inspecting the imported declaration when it resolves to
 * a repo-local module (`[PAT-EXT-27]`).
 */
export function classifyImportedBindingKind(
  sourceFile: ts.SourceFile,
  localName: string,
  options?: ShapeKeyOptions
): ShapeKeyBindingKind {
  let cache = importTargetKindCache.get(sourceFile);
  if (!cache) {
    cache = new Map();
    importTargetKindCache.set(sourceFile, cache);
  }
  const cached = cache.get(localName);
  if (cached) return cached;

  let resolvedKind: ShapeKeyBindingKind = 'Import';
  const repoRoot =
    options?.repoRoot ??
    (path.isAbsolute(sourceFile.fileName) ? path.dirname(sourceFile.fileName) : undefined);

  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportEqualsDeclaration(stmt) &&
      stmt.moduleReference &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression &&
      ts.isStringLiteral(stmt.moduleReference.expression)
    ) {
      if (stmt.name.text === localName) {
        const spec = stmt.moduleReference.expression.text;
        if (repoRoot && !isExternalSpecifier(spec, sourceFile.fileName, repoRoot, options?.workspaceRegistry)) {
          const targetRel = resolveModulePath(spec, sourceFile.fileName, repoRoot, options?.workspaceRegistry);
          if (targetRel) {
            resolvedKind = resolveExportedSymbolKindInModule(
              targetRel,
              'default',
              repoRoot,
              options?.workspaceRegistry
            );
          }
        }
        break;
      }
      continue;
    }
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause || !ts.isStringLiteral(stmt.moduleSpecifier)) {
      continue;
    }
    const clause = stmt.importClause;
    const spec = stmt.moduleSpecifier.text;
    let importedSymbol: string | null = null;

    if (clause.name?.text === localName) {
      importedSymbol = 'default';
    } else if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        if (clause.namedBindings.name.text === localName) {
          resolvedKind = 'ImportNamespace';
          break;
        }
      } else {
        for (const el of clause.namedBindings.elements) {
          if (el.name.text === localName) {
            importedSymbol = (el.propertyName ?? el.name).text;
            break;
          }
        }
      }
    }

    if (importedSymbol) {
      if (repoRoot && !isExternalSpecifier(spec, sourceFile.fileName, repoRoot, options?.workspaceRegistry)) {
        const targetRel = resolveModulePath(spec, sourceFile.fileName, repoRoot, options?.workspaceRegistry);
        if (targetRel) {
          resolvedKind = resolveExportedSymbolKindInModule(
            targetRel,
            importedSymbol,
            repoRoot,
            options?.workspaceRegistry
          );
        }
      }
      break;
    }
  }

  cache.set(localName, resolvedKind);
  return resolvedKind;
}

/** Names a single lexical scope node declares (memoised per node), or null if it is not a scope. */
function getScopeBindings(scope: ts.Node): Map<string, ShapeKeyBindingKind> | null {
  const cached = scopeBindingCache.get(scope);
  if (cached) return cached;

  let map: Map<string, ShapeKeyBindingKind> | null = null;

  if (ts.isFunctionLike(scope)) {
    map = new Map();
    for (const p of scope.parameters) {
      const names: string[] = [];
      bindingPatternNames(p.name, names);
      const kind: ShapeKeyBindingKind = ts.isIdentifier(p.name) ? 'Param' : 'ParamDestructured';
      for (const n of names) if (!map.has(n)) map.set(n, kind);
    }
  } else if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
    map = new Map();
    recordStatements(scope.statements, map);
  } else if (ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    map = new Map();
    recordStatements(scope.statements, map);
  } else if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const init = scope.initializer;
    if (init && ts.isVariableDeclarationList(init)) {
      map = new Map();
      recordDeclarations(init.declarations, map, 'Loop');
    }
  } else if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    map = new Map();
    recordDeclarations([scope.variableDeclaration], map, 'Catch');
  }

  if (map) scopeBindingCache.set(scope, map);
  return map;
}

/** Classifies how `ident` is bound by walking its enclosing lexical scopes. */
function classifyIdentifierBinding(ident: ts.Identifier, options?: ShapeKeyOptions): ShapeKeyBindingKind {
  for (let cur: ts.Node | undefined = ident.parent; cur; cur = cur.parent) {
    const bindings = getScopeBindings(cur);
    const kind = bindings?.get(ident.text);
    if (kind) {
      if (kind === 'Import' && ts.isSourceFile(cur)) {
        return classifyImportedBindingKind(cur, ident.text, options);
      }
      return kind;
    }
  }
  return 'Undeclared';
}

function rootBindingKind(callee: ts.Expression, options?: ShapeKeyOptions): ShapeKeyBindingKind {
  const root = rootOfCallee(callee);
  if (ts.isIdentifier(root)) return classifyIdentifierBinding(root, options);
  if (root.kind === ts.SyntaxKind.ThisKeyword) return 'This';
  if (root.kind === ts.SyntaxKind.SuperKeyword) return 'Super';
  return 'None';
}

/**
 * Computes a CALL shape key for an identifier reference (e.g. JSX attribute `action={fn}` or
 * route/middleware delegation `export { auth as middleware }`).
 */
export function computeIdentifierRefShapeKey(ident: ts.Identifier, options?: ShapeKeyOptions): string {
  return `${SHAPE_KEY_VERSION}/CALL/${classifyIdentifierBinding(ident, options)}/Id`;
}

/**
 * Computes the shape key of a JSX component element (`<Comp />` or `<Ns.Comp />`).
 * Intrinsic lowercase HTML elements (`<div>`) return null.
 */
export function computeJsxShapeKey(node: ts.Node, options?: ShapeKeyOptions): string | null {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return null;
  const tagName = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  if (ts.isIdentifier(tagName)) {
    if (/^[a-z]/.test(tagName.text)) return null;
    return `${SHAPE_KEY_VERSION}/RENDERS/${classifyIdentifierBinding(tagName, options)}/Id`;
  }
  if (ts.isPropertyAccessExpression(tagName)) {
    return `${SHAPE_KEY_VERSION}/RENDERS/${rootBindingKind(tagName, options)}/${skeleton(tagName, 1)}`;
  }
  if (tagName.kind === ts.SyntaxKind.ThisKeyword) {
    return `${SHAPE_KEY_VERSION}/RENDERS/This/This`;
  }
  return null;
}

/**
 * Computes the shape key of a call (`f()`, `a.b()`, `a[b]()`, `f()()`), `new X()`, or JSX element.
 * Returns null for any other node.
 */
export function computeCallShapeKey(node: ts.Node, options?: ShapeKeyOptions): string | null {
  if (ts.isCallExpression(node)) {
    return `${SHAPE_KEY_VERSION}/CALL/${rootBindingKind(node.expression, options)}/${skeleton(node.expression, 1)}`;
  }
  if (ts.isNewExpression(node)) {
    return `${SHAPE_KEY_VERSION}/NEW/${rootBindingKind(node.expression, options)}/${skeleton(node.expression, 1)}`;
  }
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    return computeJsxShapeKey(node, options);
  }
  return null;
}

/**
 * Attaches `metadata.shapeKey` to every `CALL` or `RENDERS` edge a call/new/JSX expression produced.
 * Edges that are not about the callee's own shape (callback / dispatch-table references) are
 * never passed through here unless they already set `metadata.shapeKey`. Mutates and returns the same entity (or array) for chaining.
 */
export function withCallShapeKey<T extends StructuralEntity | StructuralEntity[] | null>(
  result: T,
  node: ts.Node,
  options?: ShapeKeyOptions
): T {
  if (!result) return result;
  const key = computeCallShapeKey(node, options);
  if (!key) return result;
  const list = Array.isArray(result) ? result : [result];
  for (const entity of list) {
    if ((entity.entityType === 'CALL' || entity.entityType === 'RENDERS') && !entity.metadata?.shapeKey) {
      entity.metadata = { ...entity.metadata, shapeKey: key };
    }
  }
  return result;
}
