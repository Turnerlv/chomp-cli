// packages/core/src/extractor/visitors/targetResolver.ts
// Relationship TARGET resolution under Ontology v4.0 (Ephemeral Code).
//
// Targets are never files. A relationship points at the Contract / Class member / Open Connector
// that the AST *proves* is addressed — and is left unresolved otherwise (an unknown is a valid
// structural state). The helpers here only compute deterministic entity ids; the orchestrator
// drops any id that does not correspond to an extracted node.

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { EvidenceRecord } from '../../types/index.js';
import {
  stableEntityId,
  cjsContractEntityId,
  contractEntityId,
  boundaryEntityId,
  resolveLogicalBoundaryScope,
  findEnclosingNamespaceScope,
} from '../../utils/id.js';
import { resolveModulePath } from '../pathResolver.js';
import { WorkspaceRegistry } from '../workspaceResolver.js';
import { publicMethodName } from './publicMethodVisitor.js';
import { extractCommonjsExport } from './commonjsExportVisitor.js';
import {
  DI_CONTAINER_PACKAGES,
  FRAMEWORK_HOOK_MODULES,
  deriveVueSfcComponentName,
  deriveSvelteComponentName,
  isRouterFactoryInitializer,
  unwrapCachedFunctionInitializer,
  unwrapTransparentFunctionWrapperCall,
  isBindWrappedLocalExpression,
} from '../conventions/index.js';
import {
  isTemplatePreprocessedFile,
  preprocessAstroOrMdxSource,
} from '../sourcePreprocessor.js';

export { DI_CONTAINER_PACKAGES, preprocessAstroOrMdxSource };

const NODE_BUILTIN_MODULES = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'test',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

/**
 * True when `specifier` is a Node.js built-in module specifier (either `node:*` or a bare Node
 * built-in module name such as `'fs'`, `'fs/promises'`, `'path'`, `'os'`, `'child_process'`).
 */
export function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return NODE_BUILTIN_MODULES.has(specifier);
}

/**
 * Normalizes a Node.js built-in module specifier to its root built-in name (e.g. `node:fs/promises` -> `node:fs`,
 * `fs/promises` -> `fs`), while preserving non-builtin package specifiers (`next/cache`, `drizzle-orm/pg-core`).
 */
export function normalizePackageSpecifier(literal: string): string {
  if (!isNodeBuiltinSpecifier(literal)) {
    return literal;
  }
  if (literal.startsWith('node:')) {
    const rest = literal.slice('node:'.length);
    const slash = rest.indexOf('/');
    return slash === -1 ? literal : `node:${rest.slice(0, slash)}`;
  }
  const slash = literal.indexOf('/');
  return slash === -1 ? literal : literal.slice(0, slash);
}

/**
 * Deterministic id of the OPEN_CONNECTOR node representing an external package.
 * One id per package literal, shared by every file importing it.
 *
 * @param literal Import specifier, e.g. `express` or `@payloadcms/plugin-seo`.
 */
export function packageConnectorId(literal: string): string {
  const normalized = normalizePackageSpecifier(literal);
  return stableEntityId(`package:${normalized}`, 'OPEN_CONNECTOR', `Package: ${normalized}`);
}

/** A local identifier bound to a module via ES `import` or CommonJS `require`. */
export interface ModuleBinding {
  moduleSpecifier: string;
  kind: 'import' | 'require';
  /** Exported symbol bound to the local name (`default` / `*` for default / namespace bindings). */
  importedName?: string;
  /** When bound via `dynamic(() => import(...))` or `React.lazy(() => import(...))`, records the wrapper kind. */
  lazyWrapper?: 'dynamic' | 'lazy';
  /** True when declared via `import type` or an inline `import { type X }` specifier (erased at runtime). */
  isTypeOnly?: boolean;
}

const bindingCache = new WeakMap<ts.SourceFile, Map<string, ModuleBinding>>();

/** Unwraps `require('x')` / `require('x').member` / `new (require('x'))()` into its specifier (and member), if present. */
export function unwrapRequire(expr: ts.Expression | undefined): { specifier: string; member?: string } | null {
  if (!expr) return null;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }
  const unwrappedWrapper = unwrapTransparentFunctionWrapperCall(expr);
  if (unwrappedWrapper) {
    return unwrapRequire(unwrappedWrapper);
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'require' &&
    expr.arguments.length > 0 &&
    ts.isStringLiteral(expr.arguments[0])
  ) {
    return { specifier: expr.arguments[0].text };
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = unwrapRequire(expr.expression);
    if (inner && !inner.member) return { specifier: inner.specifier, member: expr.name.text };
  }
  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
    const inner = unwrapRequire(expr.expression);
    if (inner) return inner;
  }
  return null;
}

/**
 * Unwraps `dynamic(() => import('x'))`, `lazy(() => import('x'))`, or `React.lazy(() => import('x'))`
 * (including `.then(m => m.Named)` and `.then(m => ({ default: m.Named }))`) into its module
 * specifier, exported member, and wrapper kind ([PAT-EXT-20], [PAT-EXT-25]).
 *
 * @param expr The initializer or call expression to inspect.
 * @returns The target module specifier, optional named export, and wrapper kind, or null.
 */
export function unwrapLazyImport(
  expr: ts.Expression | undefined
): { specifier: string; member?: string; wrapper: 'dynamic' | 'lazy' } | null {
  if (!expr || !ts.isCallExpression(expr) || expr.arguments.length === 0) return null;

  const callee = expr.expression;
  let wrapper: 'dynamic' | 'lazy' | null = null;
  if (ts.isIdentifier(callee) && callee.text === 'dynamic') {
    wrapper = 'dynamic';
  } else if (
    (ts.isIdentifier(callee) && callee.text === 'lazy') ||
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'React' &&
      callee.name.text === 'lazy')
  ) {
    wrapper = 'lazy';
  }
  if (!wrapper) return null;

  const loader = expr.arguments[0];
  if (!ts.isArrowFunction(loader) && !ts.isFunctionExpression(loader)) return null;

  let bodyExpr: ts.Expression | undefined;
  if (ts.isBlock(loader.body)) {
    for (const stmt of loader.body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        bodyExpr = stmt.expression;
        break;
      }
    }
  } else {
    bodyExpr = loader.body;
  }
  if (!bodyExpr) return null;

  // Direct `() => import('specifier')`
  if (
    ts.isCallExpression(bodyExpr) &&
    bodyExpr.expression.kind === ts.SyntaxKind.ImportKeyword &&
    bodyExpr.arguments.length > 0 &&
    ts.isStringLiteral(bodyExpr.arguments[0])
  ) {
    return { specifier: bodyExpr.arguments[0].text, member: 'default', wrapper };
  }

  // Chained `() => import('specifier').then(m => m.Named)` or `.then(m => ({ default: m.Named }))`
  if (
    ts.isCallExpression(bodyExpr) &&
    ts.isPropertyAccessExpression(bodyExpr.expression) &&
    bodyExpr.expression.name.text === 'then' &&
    ts.isCallExpression(bodyExpr.expression.expression) &&
    bodyExpr.expression.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
    bodyExpr.expression.expression.arguments.length > 0 &&
    ts.isStringLiteral(bodyExpr.expression.expression.arguments[0])
  ) {
    const specifier = bodyExpr.expression.expression.arguments[0].text;
    let member = 'default';
    const thenArg = bodyExpr.arguments[0];
    if (thenArg && (ts.isArrowFunction(thenArg) || ts.isFunctionExpression(thenArg)) && !ts.isBlock(thenArg.body)) {
      let inner: ts.Expression = thenArg.body;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (ts.isPropertyAccessExpression(inner)) {
        member = inner.name.text;
      } else if (ts.isObjectLiteralExpression(inner)) {
        for (const prop of inner.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === 'default' &&
            ts.isPropertyAccessExpression(prop.initializer)
          ) {
            member = prop.initializer.name.text;
            break;
          }
        }
      }
    }
    return { specifier, member, wrapper };
  }

  return null;
}

/** Unwraps `await import('x')` / `import('x')` / `(await import('x')).member` into its specifier (and member). */
export function unwrapDynamicImport(
  expr: ts.Expression | undefined
): { specifier: string; member?: string } | null {
  if (!expr) return null;
  let cur: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAwaitExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  if (
    ts.isCallExpression(cur) &&
    cur.expression.kind === ts.SyntaxKind.ImportKeyword &&
    cur.arguments.length > 0 &&
    ts.isStringLiteral(cur.arguments[0])
  ) {
    return { specifier: cur.arguments[0].text };
  }
  if (ts.isPropertyAccessExpression(cur)) {
    const inner = unwrapDynamicImport(cur.expression);
    if (inner && !inner.member) {
      return { specifier: inner.specifier, member: cur.name.text };
    }
  }
  if (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    cur.expression.name.text === 'then' &&
    cur.arguments.length > 0
  ) {
    const inner = unwrapDynamicImport(cur.expression.expression);
    if (inner) {
      const thenCb = cur.arguments[0];
      if (
        (ts.isArrowFunction(thenCb) || ts.isFunctionExpression(thenCb)) &&
        !ts.isBlock(thenCb.body) &&
        ts.isPropertyAccessExpression(thenCb.body)
      ) {
        return { specifier: inner.specifier, member: thenCb.body.name.text };
      }
      return inner;
    }
  }
  return null;
}

/** Builds (once per file) the map of local identifier → module binding. */
function buildBindings(sourceFile: ts.SourceFile): Map<string, ModuleBinding> {
  const bindings = new Map<string, ModuleBinding>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      const clauseTypeOnly = Boolean(clause.isTypeOnly);
      const setImportBinding = (localName: string, binding: ModuleBinding) => {
        const existing = bindings.get(localName);
        if (existing && !existing.isTypeOnly && binding.isTypeOnly) {
          return;
        }
        bindings.set(localName, binding);
      };
      if (clause.name) {
        setImportBinding(clause.name.text, {
          moduleSpecifier: specifier,
          kind: 'import',
          importedName: 'default',
          ...(clauseTypeOnly ? { isTypeOnly: true } : {}),
        });
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          setImportBinding(clause.namedBindings.name.text, {
            moduleSpecifier: specifier,
            kind: 'import',
            importedName: '*',
            ...(clauseTypeOnly ? { isTypeOnly: true } : {}),
          });
        } else {
          for (const el of clause.namedBindings.elements) {
            const isTypeOnly = clauseTypeOnly || Boolean(el.isTypeOnly);
            setImportBinding(el.name.text, {
              moduleSpecifier: specifier,
              kind: 'import',
              importedName: (el.propertyName ?? el.name).text,
              ...(isTypeOnly ? { isTypeOnly: true } : {}),
            });
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      node.moduleReference &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const isTypeOnly = Boolean(node.isTypeOnly);
      const existing = bindings.get(node.name.text);
      if (!(existing && !existing.isTypeOnly && isTypeOnly)) {
        bindings.set(node.name.text, {
          moduleSpecifier: node.moduleReference.expression.text,
          kind: 'require',
          importedName: '*',
          ...(isTypeOnly ? { isTypeOnly: true } : {}),
        });
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const req = unwrapRequire(node.right);
      const dynImp = !req ? unwrapDynamicImport(node.right) : null;
      const modUnwrapped = req
        ? { ...req, kind: 'require' as const }
        : dynImp
          ? { ...dynImp, kind: 'import' as const }
          : null;
      if (modUnwrapped) {
        if (ts.isIdentifier(node.left)) {
          bindings.set(node.left.text, {
            moduleSpecifier: modUnwrapped.specifier,
            kind: modUnwrapped.kind,
            importedName: modUnwrapped.member ?? '*',
          });
        } else if (ts.isObjectLiteralExpression(node.left)) {
          for (const prop of node.left.properties) {
            if (ts.isShorthandPropertyAssignment(prop)) {
              bindings.set(prop.name.text, {
                moduleSpecifier: modUnwrapped.specifier,
                kind: modUnwrapped.kind,
                importedName: prop.name.text,
              });
            } else if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              ts.isIdentifier(prop.initializer)
            ) {
              bindings.set(prop.initializer.text, {
                moduleSpecifier: modUnwrapped.specifier,
                kind: modUnwrapped.kind,
                importedName: prop.name.text,
              });
            }
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const req = unwrapRequire(node.initializer);
      const dynImp = !req ? unwrapDynamicImport(node.initializer) : null;
      const modUnwrapped = req
        ? { ...req, kind: 'require' as const }
        : dynImp
          ? { ...dynImp, kind: 'import' as const }
          : null;
      if (modUnwrapped) {
        if (ts.isIdentifier(node.name)) {
          bindings.set(node.name.text, {
            moduleSpecifier: modUnwrapped.specifier,
            kind: modUnwrapped.kind,
            importedName: modUnwrapped.member ?? '*',
          });
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isIdentifier(el.name)) {
              const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
              bindings.set(el.name.text, {
                moduleSpecifier: modUnwrapped.specifier,
                kind: modUnwrapped.kind,
                importedName: imported,
              });
            }
          }
        }
      } else {
        const lazy = unwrapLazyImport(node.initializer);
        if (lazy && ts.isIdentifier(node.name)) {
          bindings.set(node.name.text, {
            moduleSpecifier: lazy.specifier,
            kind: 'import',
            importedName: lazy.member ?? 'default',
            lazyWrapper: lazy.wrapper,
          });
        } else if (
          ts.isIdentifier(node.name) &&
          ts.isPropertyAccessExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression)
        ) {
          const parentBinding = bindings.get(node.initializer.expression.text);
          if (
            parentBinding &&
            (!parentBinding.importedName ||
              parentBinding.importedName === '*' ||
              parentBinding.importedName === 'default')
          ) {
            bindings.set(node.name.text, {
              moduleSpecifier: parentBinding.moduleSpecifier,
              kind: parentBinding.kind,
              importedName: node.initializer.name.text,
            });
          }
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'then' &&
      node.arguments.length >= 1
    ) {
      const dynImp = unwrapDynamicImport(node.expression.expression);
      const cb = node.arguments[0];
      if (dynImp && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters.length > 0) {
        const paramName = cb.parameters[0].name;
        if (ts.isIdentifier(paramName) && !bindings.has(paramName.text)) {
          bindings.set(paramName.text, {
            moduleSpecifier: dynImp.specifier,
            kind: 'import',
            importedName: '*',
          });
        } else if (ts.isObjectBindingPattern(paramName)) {
          for (const el of paramName.elements) {
            if (ts.isIdentifier(el.name) && !bindings.has(el.name.text)) {
              const imported =
                el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
              bindings.set(el.name.text, {
                moduleSpecifier: dynImp.specifier,
                kind: 'import',
                importedName: imported,
              });
            }
          }
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'mixin' &&
      node.arguments.length >= 2 &&
      ts.isIdentifier(node.arguments[0]) &&
      ts.isIdentifier(node.arguments[1])
    ) {
      const srcBinding = bindings.get(node.arguments[1].text);
      if (srcBinding && srcBinding.moduleSpecifier.startsWith('.') && !bindings.has(node.arguments[0].text)) {
        bindings.set(node.arguments[0].text, srcBinding);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

/**
 * Finds the module a local identifier was imported/required from.
 *
 * @example
 * import { Database } from './db.js';        // findModuleBinding(sf, 'Database') → { './db.js', import }
 * const http = require('http');              // findModuleBinding(sf, 'http')     → { 'http', require }
 *
 * @param sourceFile Source file to search.
 * @param localName  Local identifier.
 * @returns The binding, or undefined if the identifier is not bound to a module.
 */
export function findModuleBinding(sourceFile: ts.SourceFile, localName: string): ModuleBinding | undefined {
  let map = bindingCache.get(sourceFile);
  if (!map) {
    map = buildBindings(sourceFile);
    bindingCache.set(sourceFile, map);
  }
  return map.get(localName);
}

/**
 * Finds a runtime value module binding for `localName`, ignoring TypeScript type-only imports
 * (`import type { X }` and `import { type X }`) which are erased at runtime and must never shadow
 * a same-named local value declaration (`function X` / `const X`).
 *
 * @example
 * import type { SortFilterItem } from './types';
 * function SortFilterItem() {}
 * // findValueModuleBinding(sf, 'SortFilterItem') → undefined
 *
 * @param sourceFile Source file to search.
 * @param localName  Local value identifier.
 * @returns The runtime value module binding, or undefined when unbound or type-only.
 */
export function findValueModuleBinding(
  sourceFile: ts.SourceFile,
  localName: string
): ModuleBinding | undefined {
  const binding = findModuleBinding(sourceFile, localName);
  return binding?.isTypeOnly ? undefined : binding;
}

const STATIC_ASSET_SPECIFIER_RE =
  /\.(?:svg|png|jpe?g|gif|webp|avif|ico|bmp|css|scss|sass|less|styl|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|ogg|pdf|wasm)(?:[?#].*)?$/i;

export function isStaticAssetOrRootRelativeSpecifier(specifier: string): boolean {
  if (specifier.startsWith('/')) return true;
  return STATIC_ASSET_SPECIFIER_RE.test(specifier);
}

/**
 * True when a module specifier points outside the analyzed evidence (not relative, not a workspace
 * package, and not resolvable to a local file) — i.e. it is an Open Connector.
 */
export function isExternalSpecifier(
  specifier: string,
  fromFile: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): boolean {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('@/') ||
    specifier.startsWith('~/') ||
    specifier === '$lib' ||
    specifier.startsWith('$lib/') ||
    isStaticAssetOrRootRelativeSpecifier(specifier)
  ) {
    return false;
  }
  if (workspaceRegistry) {
    for (const pkgName of Object.keys(workspaceRegistry)) {
      if (specifier === pkgName || specifier.startsWith(`${pkgName}/`)) return false;
    }
  }
  return !resolveModulePath(specifier, fromFile, repoRoot, workspaceRegistry);
}

/**
 * Unwraps either a standard property access (`obj.method`) or a static string-literal / template-literal
 * element access (`obj['method']` / ``obj[`method`]``) into `{ expression, memberName }` ([PAT-EXT-14]).
 */
export function getPropertyOrElementAccess(
  expr: ts.Expression
): { expression: ts.Expression; memberName: string } | null {
  if (ts.isPropertyAccessExpression(expr)) {
    return { expression: expr.expression, memberName: expr.name.text };
  }
  if (
    ts.isElementAccessExpression(expr) &&
    expr.argumentExpression &&
    (ts.isStringLiteral(expr.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expr.argumentExpression))
  ) {
    return { expression: expr.expression, memberName: expr.argumentExpression.text };
  }
  return null;
}

/** Returns the root identifier AST node of `a.b.c()` / `a['b']()` / `a().b` style chains (e.g. `a`). */
export function getChainRootIdentifierNode(expr: ts.Expression): ts.Identifier | null {
  let current: ts.Expression = expr;
  while (current) {
    if (ts.isIdentifier(current)) return current;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    } else {
      return null;
    }
  }
  return null;
}

/** Returns the root identifier of `a.b.c()` / `a['b']()` / `a().b` style chains (e.g. `a`). */
export function getChainRootIdentifier(expr: ts.Expression): string | null {
  return getChainRootIdentifierNode(expr)?.text ?? null;
}

const TRANSPARENT_TYPE_WRAPPERS = new Set([
  'Promise',
  'Readonly',
  'ReturnType',
  'Awaited',
  'NonNullable',
  'InstanceType',
  'Partial',
  'Required',
  'Array',
  'ReadonlyArray',
  'Set',
  'ReadonlySet',
]);

const KEY_VALUE_COLLECTION_WRAPPERS = new Set(['Record', 'Map', 'ReadonlyMap']);

/** Extracts the root identifier of a `TypeReferenceNode` (`Foo` in `Foo`, `Foo.Bar`, `ReturnType<typeof fn>`, or `Foo | null`). */
function typeRefRootIdentifier(typeNode: ts.TypeNode | undefined): string | null {
  if (!typeNode) return null;
  if (ts.isArrayTypeNode(typeNode)) {
    return typeRefRootIdentifier(typeNode.elementType);
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    if (
      ts.isIdentifier(typeNode.typeName) &&
      TRANSPARENT_TYPE_WRAPPERS.has(typeNode.typeName.text) &&
      typeNode.typeArguments &&
      typeNode.typeArguments.length >= 1
    ) {
      return typeRefRootIdentifier(typeNode.typeArguments[0]);
    }
    if (
      ts.isIdentifier(typeNode.typeName) &&
      KEY_VALUE_COLLECTION_WRAPPERS.has(typeNode.typeName.text) &&
      typeNode.typeArguments &&
      typeNode.typeArguments.length >= 2
    ) {
      return typeRefRootIdentifier(typeNode.typeArguments[1]);
    }
    let current: ts.EntityName = typeNode.typeName;
    while (ts.isQualifiedName(current)) {
      current = current.left;
    }
    return ts.isIdentifier(current) ? current.text : null;
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    for (const member of typeNode.types) {
      const extracted = typeRefRootIdentifier(member);
      if (extracted) return extracted;
    }
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return typeRefRootIdentifier(typeNode.type);
  }
  if (ts.isTypeQueryNode(typeNode)) {
    let current: ts.EntityName = typeNode.exprName;
    while (ts.isQualifiedName(current)) {
      current = current.left;
    }
    return ts.isIdentifier(current) ? current.text : null;
  }
  return null;
}

/** Returns the `this.<prop>` root of a property/call chain if it starts on `this`. */
function getChainThisProperty(expr: ts.Expression): string | null {
  let current: ts.Expression = expr;
  while (current) {
    const access = getPropertyOrElementAccess(current);
    if (access && access.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return access.memberName;
    }
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else {
      return null;
    }
  }
  return null;
}

export interface SourceFileDeclarationIndex {
  classByIdentifier: Map<string, string>;
  typeofParamByIdentifier: Map<string, string>;
  factoryCallByIdentifier: Map<string, ts.CallExpression>;
  newClassByPropName: Map<string, string>;
  inheritedPrototypeRoot: string | null;
  functionDeclsByName: Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>;
  classDeclsByName: Map<string, ts.ClassDeclaration>;
  topLevelClassNames: Set<string>;
  publicMethodsByClass: Map<string, Set<string>>;
  implementingClassesByHeritage: Map<string, string[]>;
  typeAliasesByName: Map<string, ts.TypeNode>;
  interfacePropsByName: Map<string, Map<string, { typeName: string; qualifier: string | null }>>;
  cjsExportAliases: Set<string>;
  cjsMixinParamNames: Set<string>;
  cjsSubmoduleRequires: Map<string, string>;
  cjsMixinDelegations: string[];
}

const declarationIndexCache = new WeakMap<ts.SourceFile, SourceFileDeclarationIndex>();

function isModuleExportsOrExportsExpr(expr: ts.Expression): boolean {
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
    return isModuleExportsOrExportsExpr(expr.left) || isModuleExportsOrExportsExpr(expr.right);
  }
  return false;
}

function unwrapTransparentExpr(expr: ts.Expression): ts.Expression {
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

function containsTypeQueryNode(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode) return false;
  if (ts.isTypeQueryNode(typeNode)) return true;
  if (ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments) {
    return typeNode.typeArguments.some((arg) => containsTypeQueryNode(arg));
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((member) => containsTypeQueryNode(member));
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return containsTypeQueryNode(typeNode.type);
  }
  return false;
}

/**
 * Builds and caches a single per-`SourceFile` declaration & CommonJS delegation index (`[PAT-EXT-31]`),
 * eliminating $O(N^2)$ full-file `ts.forEachChild` AST re-walks on every call expression.
 */
export function getSourceFileDeclarationIndex(sourceFile: ts.SourceFile): SourceFileDeclarationIndex {
  const cached = declarationIndexCache.get(sourceFile);
  if (cached) return cached;

  const classByIdentifier = new Map<string, string>();
  const typeofParamByIdentifier = new Map<string, string>();
  const factoryCallByIdentifier = new Map<string, ts.CallExpression>();
  const newClassByPropName = new Map<string, string>();
  let inheritedPrototypeRoot: string | null = null;
  const functionDeclsByName = new Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>();
  const classDeclsByName = new Map<string, ts.ClassDeclaration>();
  const topLevelClassNames = new Set<string>();
  const publicMethodsByClass = new Map<string, Set<string>>();
  const implementingClassesByHeritage = new Map<string, string[]>();
  const typeAliasesByName = new Map<string, ts.TypeNode>();
  const interfacePropsByName = new Map<string, Map<string, { typeName: string; qualifier: string | null; isTypeof?: boolean }>>();
  const cjsExportAliases = new Set<string>(['exports']);
  const cjsMixinParamNames = new Set<string>();
  const cjsSubmoduleRequires = new Map<string, string>();
  const cjsMixinDelegations: string[] = [];

  const collectTypeMembers = (
    members: ts.NodeArray<ts.TypeElement>,
    targetMap: Map<string, { typeName: string; qualifier: string | null; isTypeof?: boolean }>
  ) => {
    for (const member of members) {
      if (
        ts.isPropertySignature(member) &&
        member.name &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.type
      ) {
        const extracted = extractDeclaredTypeInfo(member.type);
        if (extracted) {
          targetMap.set(member.name.text, {
            ...extracted,
            isTypeof: containsTypeQueryNode(member.type),
          });
        }
      }
    }
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && !functionDeclsByName.has(stmt.name.text)) {
      functionDeclsByName.set(stmt.name.text, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      typeAliasesByName.set(stmt.name.text, stmt.type);
      if (ts.isTypeLiteralNode(stmt.type)) {
        const propMap = new Map<string, { typeName: string; qualifier: string | null }>();
        collectTypeMembers(stmt.type.members, propMap);
        if (propMap.size > 0) {
          interfacePropsByName.set(stmt.name.text, propMap);
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      const propMap = new Map<string, { typeName: string; qualifier: string | null }>();
      collectTypeMembers(stmt.members, propMap);
      interfacePropsByName.set(stmt.name.text, propMap);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          !functionDeclsByName.has(decl.name.text)
        ) {
          const fnDecl =
            ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)
              ? decl.initializer
              : unwrapCachedFunctionInitializer(decl.initializer, sourceFile);
          if (fnDecl) {
            functionDeclsByName.set(decl.name.text, fnDecl);
          }
        }
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      topLevelClassNames.add(stmt.name.text);
      if (!classDeclsByName.has(stmt.name.text)) {
        classDeclsByName.set(stmt.name.text, stmt);
      }
    }
  }

  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name) {
      const isTopLevelOrDecoratedClass =
        ts.isSourceFile(n.parent) ||
        ts.isModuleBlock(n.parent) ||
        (ts.canHaveDecorators(n) && (ts.getDecorators(n)?.length ?? 0) > 0);
      if (isTopLevelOrDecoratedClass && !classDeclsByName.has(n.name.text)) {
        classDeclsByName.set(n.name.text, n);
        topLevelClassNames.add(n.name.text);
      }
      if (isTopLevelOrDecoratedClass) {
        const isAbstractCls = Boolean(
          n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)
        );
        if (!isAbstractCls && n.heritageClauses) {
          for (const hc of n.heritageClauses) {
            for (const exprType of hc.types) {
              const hName = ts.isIdentifier(exprType.expression)
                ? exprType.expression.text
                : ts.isPropertyAccessExpression(exprType.expression)
                  ? exprType.expression.name.text
                  : null;
              if (hName) {
                let list = implementingClassesByHeritage.get(hName);
                if (!list) {
                  list = [];
                  implementingClassesByHeritage.set(hName, list);
                }
                if (!list.includes(n.name.text)) {
                  list.push(n.name.text);
                }
              }
            }
          }
        }
        let methods = publicMethodsByClass.get(n.name.text);
        if (!methods) {
          methods = new Set<string>();
          publicMethodsByClass.set(n.name.text, methods);
        }
        for (const member of n.members) {
          const isMethod = ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member);
          const unwrappedPropInit =
            !isMethod && ts.isPropertyDeclaration(member) && member.initializer
              ? unwrapTransparentExpr(member.initializer)
              : null;
          const isPropFn =
            unwrappedPropInit !== null &&
            (ts.isArrowFunction(unwrappedPropInit) || ts.isFunctionExpression(unwrappedPropInit));
          const isPropObj =
            unwrappedPropInit !== null && ts.isObjectLiteralExpression(unwrappedPropInit);
          if ((!isMethod && !isPropFn && !isPropObj) || !member.name) continue;
          const isPrivateOrProtected = (ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)?.some(
            (m: ts.Modifier) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
          );
          if (isPrivateOrProtected) continue;
          if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
            if (isPropObj && ts.isObjectLiteralExpression(unwrappedPropInit)) {
              const collectObjMethods = (obj: ts.ObjectLiteralExpression, prefix: string, depth: number) => {
                if (depth > 3) return;
                for (const prop of obj.properties) {
                  if (
                    ts.isMethodDeclaration(prop) &&
                    (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
                  ) {
                    methods.add(`${prefix}.${prop.name.text}`);
                  } else if (
                    ts.isPropertyAssignment(prop) &&
                    (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
                  ) {
                    const subInit = unwrapTransparentExpr(prop.initializer);
                    if (ts.isArrowFunction(subInit) || ts.isFunctionExpression(subInit)) {
                      methods.add(`${prefix}.${prop.name.text}`);
                    } else if (ts.isObjectLiteralExpression(subInit)) {
                      collectObjMethods(subInit, `${prefix}.${prop.name.text}`, depth + 1);
                    }
                  }
                }
              };
              collectObjMethods(unwrappedPropInit, member.name.text, 1);
            } else if (member.name.text !== 'constructor') {
              methods.add(member.name.text);
            }
          }
        }
      }
    }
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n)) &&
      ts.isIdentifier(n.name)
    ) {
      const identName = n.name.text;
      if (!classByIdentifier.has(identName)) {
        let matchedClass = classNameFromTypeOrNew(n.type) ?? classNameFromTypeOrNew(n.initializer);
        let isTypeof = containsTypeQueryNode(n.type);
        if (matchedClass && typeAliasesByName.has(matchedClass) && !interfacePropsByName.has(matchedClass)) {
          const aliasType = typeAliasesByName.get(matchedClass)!;
          if (containsTypeQueryNode(aliasType)) {
            isTypeof = true;
          }
          matchedClass = classNameFromTypeOrNew(aliasType) ?? typeRefRootIdentifier(aliasType) ?? matchedClass;
        }
        if (matchedClass && !classDeclsByName.has(matchedClass) && !interfacePropsByName.has(matchedClass)) {
          for (let anc: ts.Node | undefined = n.parent; anc; anc = anc.parent) {
            if (
              (ts.isClassDeclaration(anc) ||
                ts.isMethodDeclaration(anc) ||
                ts.isFunctionDeclaration(anc) ||
                ts.isArrowFunction(anc) ||
                ts.isFunctionExpression(anc)) &&
              anc.typeParameters
            ) {
              const tp = anc.typeParameters.find((p) => p.name.text === matchedClass);
              if (tp?.constraint) {
                matchedClass =
                  classNameFromTypeOrNew(tp.constraint) ??
                  typeRefRootIdentifier(tp.constraint) ??
                  matchedClass;
                break;
              }
            }
          }
        }
        if (matchedClass) {
          classByIdentifier.set(identName, matchedClass);
          if (isTypeof) {
            typeofParamByIdentifier.set(identName, matchedClass);
          }
        }
        if (
          ts.isVariableDeclaration(n) &&
          n.initializer &&
          ts.isCallExpression(n.initializer) &&
          n.initializer.typeArguments &&
          n.initializer.typeArguments.length >= 1 &&
          ts.isIdentifier(n.initializer.expression) &&
          (n.initializer.expression.text === 'useRef' ||
            n.initializer.expression.text === 'ref' ||
            n.initializer.expression.text === 'shallowRef')
        ) {
          const refClass = classNameFromTypeOrNew(n.initializer.typeArguments[0]);
          if (refClass) {
            newClassByPropName.set(`${identName}.current`, refClass);
            newClassByPropName.set(`${identName}.value`, refClass);
          }
        }
      }
    } else if (ts.isParameter(n) && ts.isObjectBindingPattern(n.name) && n.type) {
      let propMap: Map<string, { typeName: string; qualifier: string | null; isTypeof?: boolean }> | undefined;
      if (ts.isTypeLiteralNode(n.type)) {
        propMap = new Map();
        collectTypeMembers(n.type.members, propMap);
      } else {
        const paramTypeName = typeRefRootIdentifier(n.type);
        if (paramTypeName) {
          propMap = interfacePropsByName.get(paramTypeName);
        }
      }
      if (propMap) {
        for (const el of n.name.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            const propKey =
              el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName))
                ? el.propertyName.text
                : el.name.text;
            const propInfo = propMap.get(propKey);
            if (propInfo && !classByIdentifier.has(el.name.text)) {
              let resolvedPropType = propInfo.typeName;
              let isTypeof = Boolean(propInfo.isTypeof);
              if (typeAliasesByName.has(resolvedPropType) && !interfacePropsByName.has(resolvedPropType)) {
                const aliasType = typeAliasesByName.get(resolvedPropType)!;
                if (containsTypeQueryNode(aliasType)) {
                  isTypeof = true;
                }
                resolvedPropType =
                  classNameFromTypeOrNew(aliasType) ?? typeRefRootIdentifier(aliasType) ?? resolvedPropType;
              }
              classByIdentifier.set(el.name.text, resolvedPropType);
              if (isTypeof) {
                typeofParamByIdentifier.set(el.name.text, resolvedPropType);
              }
            }
          }
        }
      }
    }

    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const identName = n.name.text;
      const unwrappedInit = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer;
      if (
        ts.isCallExpression(unwrappedInit) &&
        (ts.isIdentifier(unwrappedInit.expression) ||
          (ts.isPropertyAccessExpression(unwrappedInit.expression) &&
            ts.isIdentifier(unwrappedInit.expression.expression))) &&
        unwrapCachedFunctionInitializer(unwrappedInit, sourceFile) === null &&
        !factoryCallByIdentifier.has(identName)
      ) {
        factoryCallByIdentifier.set(identName, unwrappedInit);
      }
      if (
        ts.isNewExpression(n.initializer) &&
        ts.isIdentifier(n.initializer.expression) &&
        !newClassByPropName.has(identName)
      ) {
        newClassByPropName.set(identName, n.initializer.expression.text);
      }
      if (isModuleExportsOrExportsExpr(n.initializer)) {
        cjsExportAliases.add(identName);
      }
    }

    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const rhsNewClass =
        ts.isNewExpression(n.right) && ts.isIdentifier(n.right.expression)
          ? n.right.expression.text
          : ts.isBinaryExpression(n.right) &&
              (n.right.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                n.right.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
            ? classNameFromTypeOrNew(n.right)
            : ts.isIdentifier(n.right)
              ? classByIdentifier.get(n.right.text) ?? newClassByPropName.get(n.right.text) ?? null
              : null;
      if (rhsNewClass) {
        if (ts.isIdentifier(n.left) && !newClassByPropName.has(n.left.text)) {
          newClassByPropName.set(n.left.text, rhsNewClass);
        } else if (
          ts.isPropertyAccessExpression(n.left) &&
          n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          !newClassByPropName.has(n.left.name.text)
        ) {
          newClassByPropName.set(n.left.name.text, rhsNewClass);
        } else if (
          ts.isPropertyAccessExpression(n.left) &&
          ts.isIdentifier(n.left.expression)
        ) {
          const compoundKey = `${n.left.expression.text}.${n.left.name.text}`;
          if (!newClassByPropName.has(compoundKey)) {
            newClassByPropName.set(compoundKey, rhsNewClass);
          }
        }
      }

      if (isModuleExportsOrExportsExpr(n.left)) {
        let rhsAlias: ts.Expression = n.right;
        while (ts.isBinaryExpression(rhsAlias) && rhsAlias.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (ts.isIdentifier(rhsAlias.left)) {
            cjsExportAliases.add(rhsAlias.left.text);
          }
          rhsAlias = rhsAlias.right;
        }
        if (ts.isIdentifier(rhsAlias) && functionDeclsByName.has(rhsAlias.text)) {
          cjsExportAliases.add(rhsAlias.text);
        }
        if (ts.isFunctionExpression(n.right) || ts.isArrowFunction(n.right)) {
          if (n.right.parameters.length > 0 && ts.isIdentifier(n.right.parameters[0].name)) {
            cjsMixinParamNames.add(n.right.parameters[0].name.text);
          }
        } else if (ts.isObjectLiteralExpression(n.right)) {
          for (const prop of n.right.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
            ) {
              const req = unwrapRequire(prop.initializer);
              if (req && !req.member && !cjsSubmoduleRequires.has(prop.name.text)) {
                cjsSubmoduleRequires.set(prop.name.text, req.specifier);
              }
            }
          }
        }
      } else {
        const leftAccess = getPropertyOrElementAccess(n.left);
        if (
          leftAccess &&
          (isModuleExportsOrExportsExpr(leftAccess.expression) ||
            (ts.isIdentifier(leftAccess.expression) &&
              (cjsExportAliases.has(leftAccess.expression.text) ||
                cjsMixinParamNames.has(leftAccess.expression.text))))
        ) {
          const req = unwrapRequire(n.right);
          if (req && !req.member && !cjsSubmoduleRequires.has(leftAccess.memberName)) {
            cjsSubmoduleRequires.set(leftAccess.memberName, req.specifier);
          }
        }
      }
    }

    if (ts.isCallExpression(n)) {
      if (
        !inheritedPrototypeRoot &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === 'Object' &&
        (n.expression.name.text === 'create' || n.expression.name.text === 'setPrototypeOf')
      ) {
        const protoArg = n.expression.name.text === 'create' ? n.arguments[0] : n.arguments[1];
        if (protoArg && ts.isPropertyAccessExpression(protoArg) && protoArg.name.text === 'prototype') {
          inheritedPrototypeRoot = getChainRootIdentifier(protoArg.expression);
        }
      }

      if (n.arguments.length >= 1) {
        const req = unwrapRequire(n.expression);
        if (req && !req.member) {
          const arg0 = n.arguments[0];
          if (
            isModuleExportsOrExportsExpr(arg0) ||
            (ts.isIdentifier(arg0) &&
              (cjsExportAliases.has(arg0.text) || cjsMixinParamNames.has(arg0.text)))
          ) {
            if (!cjsMixinDelegations.includes(req.specifier)) {
              cjsMixinDelegations.push(req.specifier);
            }
          }
        }
      }
    }

    ts.forEachChild(n, visit);
  };

  visit(sourceFile);

  const index: SourceFileDeclarationIndex = {
    classByIdentifier,
    typeofParamByIdentifier,
    factoryCallByIdentifier,
    newClassByPropName,
    inheritedPrototypeRoot,
    functionDeclsByName,
    classDeclsByName,
    topLevelClassNames,
    publicMethodsByClass,
    implementingClassesByHeritage,
    typeAliasesByName,
    interfacePropsByName,
    cjsExportAliases,
    cjsMixinParamNames,
    cjsSubmoduleRequires,
    cjsMixinDelegations,
  };
  declarationIndexCache.set(sourceFile, index);
  return index;
}

function findNewClassForPropertyInFile(propName: string, sourceFile: ts.SourceFile): string | null {
  return getSourceFileDeclarationIndex(sourceFile).newClassByPropName.get(propName) ?? null;
}

function findLocalThisPropertyAlias(identName: string, fromNode: ts.Node): string | null {
  for (let cur: ts.Node | undefined = fromNode.parent; cur; cur = cur.parent) {
    if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
      for (const stmt of cur.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || decl.name.text !== identName || !decl.initializer) continue;
          if (decl.initializer.kind === ts.SyntaxKind.ThisKeyword) return 'this';
          if (
            ts.isPropertyAccessExpression(decl.initializer) &&
            decl.initializer.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            return decl.initializer.name.text;
          }
          if (
            ts.isPropertyAccessExpression(decl.initializer) &&
            ts.isPropertyAccessExpression(decl.initializer.expression) &&
            decl.initializer.expression.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            return decl.initializer.name.text;
          }
        }
      }
    }
  }
  return null;
}

function findInheritedPrototypeRootInFile(sourceFile: ts.SourceFile, methodName?: string): string | null {
  if (methodName && BUILTIN_VALUE_PROTOTYPE_METHODS.has(methodName)) {
    return null;
  }
  return getSourceFileDeclarationIndex(sourceFile).inheritedPrototypeRoot;
}

/**
 * Resolves a local identifier to its `VariableDeclaration` AST node in enclosing lexical scope.
 *
 * Scans lexical scopes outward from `identNode` (nearest block up to SourceFile). In block
 * scopes, declarations appearing after `identNode.pos` are skipped to respect lexical temporal
 * ordering.
 *
 * @param identNode - Identifier to look up in local scope.
 * @returns The `ts.VariableDeclaration` if deterministically declared with an initializer, else undefined.
 */
export function findLocalVariableDeclaration(identNode: ts.Identifier): ts.VariableDeclaration | undefined {
  const targetName = identNode.text;
  for (let cur: ts.Node | undefined = identNode.parent; cur; cur = cur.parent) {
    let statements: ts.NodeArray<ts.Statement> | undefined;
    if (
      ts.isBlock(cur) ||
      ts.isSourceFile(cur) ||
      ts.isModuleBlock(cur) ||
      ts.isCaseClause(cur) ||
      ts.isDefaultClause(cur)
    ) {
      statements = cur.statements;
    }
    if (statements) {
      for (let i = statements.length - 1; i >= 0; i--) {
        const stmt = statements[i];
        if (!ts.isSourceFile(cur) && stmt.pos > identNode.pos) continue;
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === targetName && decl.initializer) {
            return decl;
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolves a local identifier to its enclosing `VariableDeclaration` when bound either directly
 * (`const x = ...`) or via destructuring (`const { x } = useStore()`, `const [x] = useSignal()`).
 */
export function findLocalVariableOrBindingDeclaration(
  identNode: ts.Identifier
): ts.VariableDeclaration | undefined {
  const direct = findLocalVariableDeclaration(identNode);
  if (direct) return direct;
  const targetName = identNode.text;
  const patternBindsName = (pat: ts.BindingName): boolean => {
    if (ts.isIdentifier(pat)) return pat.text === targetName;
    for (const el of pat.elements) {
      if (ts.isBindingElement(el) && patternBindsName(el.name)) return true;
    }
    return false;
  };
  for (let cur: ts.Node | undefined = identNode.parent; cur; cur = cur.parent) {
    let statements: ts.NodeArray<ts.Statement> | undefined;
    if (
      ts.isBlock(cur) ||
      ts.isSourceFile(cur) ||
      ts.isModuleBlock(cur) ||
      ts.isCaseClause(cur) ||
      ts.isDefaultClause(cur)
    ) {
      statements = cur.statements;
    }
    if (statements) {
      for (let i = statements.length - 1; i >= 0; i--) {
        const stmt = statements[i];
        if (!ts.isSourceFile(cur) && stmt.pos > identNode.pos) continue;
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (
            (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) &&
            decl.initializer &&
            patternBindsName(decl.name)
          ) {
            return decl;
          }
        }
      }
    }
  }
  return undefined;
}

const REACT_HOOK_WRAPPERS = new Set([
  'useCallback',
  'useMemo',
  'useState',
  'useRef',
  'useReducer',
  'useContext',
  'useTransition',
  'useDeferredValue',
  'useEffect',
  'useLayoutEffect',
  'useImperativeHandle',
  'useId',
  'useSyncExternalStore',
  'usePathname',
  'useSearchParams',
  'useRouter',
  'useParams',
]);

export function isReactHookCall(expr: ts.Expression): boolean {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    (ts.isPropertyAccessExpression(current) && current.name.text === 'current')
  ) {
    current = current.expression;
  }
  if (!ts.isCallExpression(current)) return false;
  const callee = current.expression;
  if (ts.isIdentifier(callee)) {
    if (REACT_HOOK_WRAPPERS.has(callee.text)) return true;
    if (/^use[A-Z]\w*$/.test(callee.text)) {
      const sf = current.getSourceFile?.();
      if (sf) {
        const binding = findValueModuleBinding(sf, callee.text);
        if (binding && FRAMEWORK_HOOK_MODULES.has(binding.moduleSpecifier)) {
          return true;
        }
      }
    }
    return false;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'React'
  ) {
    return REACT_HOOK_WRAPPERS.has(callee.name.text) || /^use[A-Z]\w*$/.test(callee.name.text);
  }
  return false;
}

export const BUILTIN_VALUE_PROTOTYPE_METHODS = new Set([
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
  'findLast',
  'findLastIndex',
  'includes',
  'indexOf',
  'lastIndexOf',
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
  'toSorted',
  'toReversed',
  'toSpliced',
  'fill',
  'copyWithin',
  'at',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'then',
  'catch',
  'finally',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'replace',
  'replaceAll',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'substr',
  'match',
  'matchAll',
  'search',
  'localeCompare',
  'normalize',
  'toFixed',
  'toPrecision',
  'toExponential',
  'toString',
  'valueOf',
  'toISOString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleString',
  'getTime',
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'getUTCFullYear',
  'getUTCMonth',
  'getUTCDate',
  'getUTCDay',
  'getUTCHours',
  'getUTCMinutes',
  'getUTCSeconds',
  'getUTCMilliseconds',
  'getTimezoneOffset',
  'toDateString',
  'toTimeString',
  'toUTCString',
  'toJSON',
  'hasOwnProperty',
]);

export const BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS = new Set([
  'map',
  'filter',
  'forEach',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'includes',
  'indexOf',
  'lastIndexOf',
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
  'toSorted',
  'toReversed',
  'toSpliced',
  'fill',
  'copyWithin',
  'at',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'then',
  'catch',
  'finally',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'replace',
  'replaceAll',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'substr',
  'match',
  'matchAll',
  'search',
  'localeCompare',
  'normalize',
  'toFixed',
  'toPrecision',
  'toExponential',
  'toString',
  'valueOf',
  'toISOString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleString',
  'getTime',
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'getUTCFullYear',
  'getUTCMonth',
  'getUTCDate',
  'getUTCDay',
  'getUTCHours',
  'getUTCMinutes',
  'getUTCSeconds',
  'getUTCMilliseconds',
  'getTimezoneOffset',
  'toDateString',
  'toTimeString',
  'toUTCString',
  'toJSON',
  'hasOwnProperty',
]);

function hasCallExpressionInReceiverChain(expr: ts.Expression): boolean {
  let cur: ts.Expression = expr;
  while (cur) {
    if (ts.isCallExpression(cur)) return true;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else if (
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression(cur)
    ) {
      cur = cur.expression;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Resolves an expression's root identifier (or `this.<prop>` typed property) to the
 * external-package OPEN_CONNECTOR it was imported/required from.
 *
 * @example
 * Object.create(http.IncomingMessage.prototype)   // http = require('http') → Package: http
 * this.db.close()                                 // private db: Database.Database → Package: better-sqlite3
 *
 * @returns The package connector id, or undefined when the root is not bound to an external module.
 */
export function resolveExternalPackageTarget(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  visitedFns: Set<string> = new Set<string>()
): string | undefined {
  if (visitedFns.size > 8) return undefined;
  const directReq = unwrapRequire(expr);
  if (directReq && isExternalSpecifier(directReq.specifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
    return packageConnectorId(directReq.specifier);
  }

  const exprAccess = getPropertyOrElementAccess(expr);
  const rootIdentForNew = getChainRootIdentifierNode(expr);
  const rootNewDecl = rootIdentForNew ? findLocalVariableDeclaration(rootIdentForNew) : undefined;
  const isLocalFromNewRoot = Boolean(
    rootNewDecl?.initializer && ts.isNewExpression(unwrapTransparentExpr(rootNewDecl.initializer))
  );
  const isThisPropertyRoot = getChainThisProperty(expr) !== null;
  const isTypeofParamRoot = rootIdentForNew
    ? getSourceFileDeclarationIndex(sourceFile).typeofParamByIdentifier.has(rootIdentForNew.text)
    : false;
  if (exprAccess && BUILTIN_VALUE_PROTOTYPE_METHODS.has(exprAccess.memberName)) {
    if (
      !isLocalFromNewRoot &&
      exprAccess.memberName !== 'get' &&
      exprAccess.memberName !== 'set' &&
      exprAccess.memberName !== 'delete'
    ) {
      return undefined;
    }
    const parentSubProp = ts.isPropertyAccessExpression(exprAccess.expression)
      ? exprAccess.expression.name.text
      : null;
    if (
      !isLocalFromNewRoot &&
      ((!isThisPropertyRoot && !isTypeofParamRoot) ||
        parentSubProp === 'headers' ||
        parentSubProp === 'searchParams' ||
        parentSubProp === 'cookies') &&
      (ts.isPropertyAccessExpression(exprAccess.expression) ||
        ts.isElementAccessExpression(exprAccess.expression))
    ) {
      return undefined;
    }
    if (isLocalFromNewRoot && BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(exprAccess.memberName)) {
      return undefined;
    }
  }

  if (
    exprAccess &&
    BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(exprAccess.memberName) &&
    hasCallExpressionInReceiverChain(exprAccess.expression)
  ) {
    // Calling a primitive/array prototype method on a chained call return value
    // (e.g. `createHash('sha256').update(x).digest('hex').slice(0, 12)`) operates on the
    // returned value in memory, not on the external package.
    return undefined;
  }

  let root = getChainRootIdentifier(expr);
  if (root) {
    const aliasProp = findLocalThisPropertyAlias(root, expr);
    if (aliasProp && aliasProp !== 'this') {
      const ctorIdent = findNewClassForPropertyInFile(aliasProp, sourceFile);
      if (ctorIdent) root = ctorIdent;
    }
  }
  if (!root) {
    const thisProp = getChainThisProperty(expr);
    if (thisProp) {
      const subPropsOnThis: string[] = [];
      if (exprAccess) {
        let recvCur: ts.Expression = unwrapTransparentExpr(exprAccess.expression);
        while (ts.isPropertyAccessExpression(recvCur) || ts.isElementAccessExpression(recvCur)) {
          const inner = unwrapTransparentExpr(recvCur.expression);
          if (inner.kind === ts.SyntaxKind.ThisKeyword) break;
          if (ts.isPropertyAccessExpression(recvCur)) {
            subPropsOnThis.unshift(recvCur.name.text);
          }
          recvCur = inner;
        }
      }
      let cls: ts.Node | undefined = expr;
      while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
      const isDirectThisMethodCall =
        visitedFns.size === 0 &&
        Boolean(exprAccess && unwrapTransparentExpr(exprAccess.expression).kind === ts.SyntaxKind.ThisKeyword);
      if (cls && ts.isClassDeclaration(cls)) {
        for (const member of cls.members) {
          if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === thisProp) {
            if (subPropsOnThis.length > 0 && member.initializer) {
              const objSub = extractSubPropertyTargetFromObjectExpr(member.initializer, subPropsOnThis);
              if (objSub) {
                root = objSub.targetName;
                break;
              }
            }
            root = typeRefRootIdentifier(member.type) ?? classNameFromTypeOrNew(member.initializer);
            if (root) break;
          }
          if (
            isDirectThisMethodCall &&
            ts.isMethodDeclaration(member) &&
            (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) &&
            member.name.text === thisProp
          ) {
            return undefined;
          }
          if (
            ((!isDirectThisMethodCall && ts.isMethodDeclaration(member)) ||
              ts.isGetAccessorDeclaration(member)) &&
            ts.isIdentifier(member.name) &&
            member.name.text === thisProp
          ) {
            root =
              typeRefRootIdentifier(member.type) ??
              (ts.isMethodDeclaration(member) ? findReturnedNewClassName(member) : null);
            if (!root && member.body) {
              const methodVisitKey = `${sourceFile.fileName}::this.${thisProp}`;
              if (!visitedFns.has(methodVisitKey)) {
                visitedFns.add(methodVisitKey);
                let bodyExt: string | undefined;
                const scanMethodRet = (n: ts.Node) => {
                  if (bodyExt) return;
                  if (n !== member.body && isNestedFunction(n)) return;
                  if (ts.isReturnStatement(n) && n.expression) {
                    bodyExt = resolveExternalPackageTarget(
                      unwrapTransparentExpr(n.expression),
                      sourceFile,
                      repoRoot,
                      workspaceRegistry,
                      visitedFns
                    );
                  }
                  ts.forEachChild(n, scanMethodRet);
                };
                scanMethodRet(member.body);
                if (bodyExt) return bodyExt;
              }
            }
            if (root) break;
          }
          if (ts.isConstructorDeclaration(member)) {
            for (const param of member.parameters) {
              if (ts.isIdentifier(param.name) && param.name.text === thisProp) {
                root = typeRefRootIdentifier(param.type);
                break;
              }
            }
            if (!root && member.body) {
              let assignedExpr: ts.Expression | null = null;
              const scanCtor = (n: ts.Node) => {
                if (assignedExpr) return;
                if (
                  ts.isBinaryExpression(n) &&
                  n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                  ts.isPropertyAccessExpression(n.left) &&
                  n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
                  n.left.name.text === thisProp
                ) {
                  assignedExpr = n.right;
                  return;
                }
                ts.forEachChild(n, scanCtor);
              };
              scanCtor(member.body);
              if (assignedExpr) {
                if (subPropsOnThis.length > 0) {
                  const objSub = extractSubPropertyTargetFromObjectExpr(assignedExpr, subPropsOnThis);
                  if (objSub) {
                    root = objSub.targetName;
                  }
                }
                if (!root) {
                  root = classNameFromTypeOrNew(assignedExpr);
                }
              }
            }
            if (root) break;
          }
        }
      }
      if (!root) {
        root = findNewClassForPropertyInFile(thisProp, sourceFile);
      }
      if (!root && ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
        root = findInheritedPrototypeRootInFile(sourceFile, expr.name.text);
      }
    }
  }
  if (!root) return undefined;
  const binding = findValueModuleBinding(sourceFile, root);
  if (!binding) {
    // Do not attribute built-in JS primitive/array prototype methods (`.toLowerCase()`, `.split()`,
    // `.map()`, `.toFixed()`, etc.) called on a local variable back to the external package that
    // produced the variable's value (e.g. `const s = readFileSync(...); s.split()` or `const n = basename(...); n.toLowerCase()`).
    if (
      exprAccess &&
      (BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(exprAccess.memberName) ||
        (!isLocalFromNewRoot &&
          !isTypeofParamRoot &&
          BUILTIN_VALUE_PROTOTYPE_METHODS.has(exprAccess.memberName) &&
          (ts.isPropertyAccessExpression(exprAccess.expression) ||
            ts.isElementAccessExpression(exprAccess.expression) ||
            exprAccess.memberName === 'has' ||
            exprAccess.memberName === 'add' ||
            exprAccess.memberName === 'clear')))
    ) {
      return undefined;
    }
    const declaredTypeTarget = getSourceFileDeclarationIndex(sourceFile).typeofParamByIdentifier.get(root);
    if (declaredTypeTarget) {
      const typeBinding = findModuleBinding(sourceFile, declaredTypeTarget);
      if (
        typeBinding &&
        isExternalSpecifier(typeBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry) &&
        !DI_CONTAINER_PACKAGES.has(typeBinding.moduleSpecifier)
      ) {
        return packageConnectorId(typeBinding.moduleSpecifier);
      }
    }
    let curIdent = getChainRootIdentifierNode(expr);
    const seen = new Set<string>();
    for (let depth = 0; depth < 5 && curIdent; depth++) {
      if (seen.has(curIdent.text)) break;
      seen.add(curIdent.text);
      const fnVisitKey = `${sourceFile.fileName}::${curIdent.text}`;
      const isDirectBareIdent =
        depth === 0 && exprAccess === null && !ts.isCallExpression(unwrapTransparentExpr(expr));
      const fnDecl =
        !isDirectBareIdent && !visitedFns.has(fnVisitKey)
          ? getSourceFileDeclarationIndex(sourceFile).functionDeclsByName.get(curIdent.text)
          : undefined;
      if (fnDecl) {
        visitedFns.add(fnVisitKey);
        if (fnDecl.type) {
          const fnTypeRoot = typeRefRootIdentifier(fnDecl.type);
          if (fnTypeRoot) {
            const typeBinding = findModuleBinding(sourceFile, fnTypeRoot);
            if (
              typeBinding &&
              isExternalSpecifier(typeBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry) &&
              !DI_CONTAINER_PACKAGES.has(typeBinding.moduleSpecifier)
            ) {
              return packageConnectorId(typeBinding.moduleSpecifier);
            }
          }
        }
        const returnedCls = findReturnedNewClassName(fnDecl);
        if (returnedCls) {
          const clsBinding = findModuleBinding(sourceFile, returnedCls);
          if (
            clsBinding &&
            isExternalSpecifier(clsBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry) &&
            !DI_CONTAINER_PACKAGES.has(clsBinding.moduleSpecifier)
          ) {
            return packageConnectorId(clsBinding.moduleSpecifier);
          }
        }
        if (fnDecl.body) {
          if (!ts.isBlock(fnDecl.body)) {
            const ext = resolveExternalPackageTarget(
              fnDecl.body,
              sourceFile,
              repoRoot,
              workspaceRegistry,
              visitedFns
            );
            if (ext) return ext;
          } else {
            let bodyExt: string | undefined;
            const scanFnRet = (n: ts.Node) => {
              if (bodyExt) return;
              if (n !== fnDecl.body && isNestedFunction(n)) return;
              if (ts.isReturnStatement(n) && n.expression) {
                const retUnwrapped = unwrapTransparentExpr(n.expression);
                if (
                  ts.isCallExpression(retUnwrapped) ||
                  ts.isNewExpression(retUnwrapped) ||
                  ts.isIdentifier(retUnwrapped) ||
                  ts.isAwaitExpression(retUnwrapped)
                ) {
                  bodyExt = resolveExternalPackageTarget(
                    retUnwrapped,
                    sourceFile,
                    repoRoot,
                    workspaceRegistry,
                    visitedFns
                  );
                }
              }
              ts.forEachChild(n, scanFnRet);
            };
            scanFnRet(fnDecl.body);
            if (bodyExt) return bodyExt;
          }
        }
      }
      const sfDeclIdx = getSourceFileDeclarationIndex(sourceFile);
      const mappedClass = sfDeclIdx.newClassByPropName.get(curIdent.text);
      if (mappedClass) {
        const clsBinding = findModuleBinding(sourceFile, mappedClass);
        if (
          clsBinding &&
          isExternalSpecifier(clsBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry) &&
          !DI_CONTAINER_PACKAGES.has(clsBinding.moduleSpecifier)
        ) {
          return packageConnectorId(clsBinding.moduleSpecifier);
        }
      }
      const decl = findLocalVariableDeclaration(curIdent);
      if (!decl?.initializer) break;
      if (
        (mappedClass === 'Map' || mappedClass === 'WeakMap') &&
        exprAccess &&
        ts.isPropertyAccessExpression(exprAccess.expression)
      ) {
        const subPropOnMapEntry = exprAccess.expression.name.text;
        const rawMapInit = unwrapTransparentExpr(decl.initializer);
        if (ts.isNewExpression(rawMapInit) && rawMapInit.typeArguments && rawMapInit.typeArguments.length >= 2) {
          const valType = rawMapInit.typeArguments[1];
          if (ts.isTypeLiteralNode(valType)) {
            for (const m of valType.members) {
              if (
                ts.isPropertySignature(m) &&
                m.name &&
                ts.isIdentifier(m.name) &&
                m.name.text === subPropOnMapEntry &&
                m.type
              ) {
                const extracted = extractDeclaredTypeInfo(m.type);
                const lookupSym = extracted?.qualifier ?? extracted?.typeName;
                if (lookupSym) {
                  const mapTypeBinding = findModuleBinding(sourceFile, lookupSym);
                  if (
                    mapTypeBinding &&
                    isExternalSpecifier(mapTypeBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
                  ) {
                    return packageConnectorId(mapTypeBinding.moduleSpecifier);
                  }
                }
              }
            }
          }
        }
        let mapEntryExt: string | undefined;
        const scanMapSet = (n: ts.Node) => {
          if (mapEntryExt) return;
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression) &&
            n.expression.expression.text === curIdent!.text &&
            n.expression.name.text === 'set' &&
            n.arguments.length >= 2 &&
            ts.isObjectLiteralExpression(n.arguments[1])
          ) {
            for (const prop of n.arguments[1].properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === subPropOnMapEntry) {
                mapEntryExt = resolveExternalPackageTarget(
                  prop.initializer,
                  sourceFile,
                  repoRoot,
                  workspaceRegistry,
                  visitedFns
                );
              } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === subPropOnMapEntry) {
                mapEntryExt = resolveExternalPackageTarget(
                  prop.name,
                  sourceFile,
                  repoRoot,
                  workspaceRegistry,
                  visitedFns
                );
              }
            }
          }
          ts.forEachChild(n, scanMapSet);
        };
        scanMapSet(sourceFile);
        if (mapEntryExt) return mapEntryExt;
      }
      let init: ts.Expression = decl.initializer;
      while (
        ts.isParenthesizedExpression(init) ||
        ts.isNonNullExpression(init) ||
        ts.isAsExpression(init) ||
        ts.isTypeAssertionExpression(init) ||
        ts.isSatisfiesExpression(init)
      ) {
        init = init.expression;
      }
      if (ts.isAwaitExpression(init)) init = init.expression;
      while (
        ts.isParenthesizedExpression(init) ||
        ts.isNonNullExpression(init) ||
        ts.isAsExpression(init) ||
        ts.isTypeAssertionExpression(init) ||
        ts.isSatisfiesExpression(init)
      ) {
        init = init.expression;
      }
      if (
        isReactHookCall(init) ||
        unwrapCachedFunctionInitializer(init, sourceFile) !== null ||
        isBindWrappedLocalExpression(init)
      ) {
        return undefined;
      }
      const unwrappedWrapperInit = unwrapTransparentFunctionWrapperCall(init);
      if (unwrappedWrapperInit) {
        init = unwrappedWrapperInit;
      }
      if (decl.type) {
        const typeRoot = typeRefRootIdentifier(decl.type);
        if (typeRoot) {
          const typeBinding = findModuleBinding(sourceFile, typeRoot);
          if (
            typeBinding &&
            isExternalSpecifier(typeBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
          ) {
            return packageConnectorId(typeBinding.moduleSpecifier);
          }
        }
      }
      const req = unwrapRequire(init);
      if (req && isExternalSpecifier(req.specifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
        return packageConnectorId(req.specifier);
      }
      if (
        ts.isCallExpression(init) &&
        init.expression.kind === ts.SyntaxKind.ImportKeyword &&
        init.arguments.length > 0 &&
        ts.isStringLiteral(init.arguments[0]) &&
        isExternalSpecifier(init.arguments[0].text, sourceFile.fileName, repoRoot, workspaceRegistry)
      ) {
        if (exprAccess && (exprAccess.memberName === 'then' || exprAccess.memberName === 'catch' || exprAccess.memberName === 'finally')) {
          return undefined;
        }
        return packageConnectorId(init.arguments[0].text);
      }
      let callee: ts.Expression = ts.isCallExpression(init) || ts.isNewExpression(init) ? init.expression : init;
      while (ts.isCallExpression(callee) || ts.isNewExpression(callee)) callee = callee.expression;
      while (
        ts.isParenthesizedExpression(callee) ||
        ts.isNonNullExpression(callee) ||
        ts.isAsExpression(callee) ||
        ts.isTypeAssertionExpression(callee) ||
        ts.isSatisfiesExpression(callee)
      ) {
        callee = callee.expression;
      }
      const calleeRootNode = getChainRootIdentifierNode(callee);
      if (calleeRootNode) {
        const calleeBinding = findValueModuleBinding(sourceFile, calleeRootNode.text);
        if (
          calleeBinding &&
          isExternalSpecifier(calleeBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
        ) {
          if (
            DI_CONTAINER_PACKAGES.has(calleeBinding.moduleSpecifier) ||
            (ts.isPropertyAccessExpression(callee) &&
              callee.name.text === 'bind' &&
              (calleeBinding.moduleSpecifier === 'underscore' || calleeBinding.moduleSpecifier === 'lodash'))
          ) {
            return undefined;
          }
          return packageConnectorId(calleeBinding.moduleSpecifier);
        }
        curIdent = calleeRootNode;
      } else {
        break;
      }
    }
    return undefined;
  }
  if (!isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
    const resolvedLocal = resolveModulePath(
      binding.moduleSpecifier,
      sourceFile.fileName,
      repoRoot,
      workspaceRegistry
    );
    if (resolvedLocal) {
      let propToLookup: string | null =
        binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
          ? binding.importedName
          : null;
      if (!propToLookup) {
        let cur: ts.Expression = expr;
        while (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
          if (
            ts.isPropertyAccessExpression(cur) &&
            ts.isIdentifier(cur.expression) &&
            cur.expression.text === root
          ) {
            propToLookup = cur.name.text;
            break;
          }
          cur = cur.expression;
        }
      }
      if (propToLookup) {
        const targetSf = getCachedSourceFile(path.resolve(repoRoot, resolvedLocal));
        if (targetSf && targetSf !== sourceFile) {
          for (const stmt of targetSf.statements) {
            if (ts.isVariableStatement(stmt)) {
              for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === propToLookup && decl.initializer) {
                  return resolveExternalPackageTarget(
                    decl.initializer,
                    targetSf,
                    repoRoot,
                    workspaceRegistry,
                    visitedFns
                  );
                }
              }
            } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
              if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
                const spec = stmt.moduleSpecifier.text;
                if (isExternalSpecifier(spec, targetSf.fileName, repoRoot, workspaceRegistry)) {
                  if (!stmt.exportClause) {
                    return packageConnectorId(spec);
                  }
                  if (ts.isNamespaceExport(stmt.exportClause) && stmt.exportClause.name.text === propToLookup) {
                    return packageConnectorId(spec);
                  }
                  if (ts.isNamedExports(stmt.exportClause)) {
                    for (const el of stmt.exportClause.elements) {
                      if (!el.isTypeOnly && el.name.text === propToLookup) {
                        return packageConnectorId(spec);
                      }
                    }
                  }
                }
              } else if (!stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
                for (const el of stmt.exportClause.elements) {
                  if (!el.isTypeOnly && el.name.text === propToLookup) {
                    const localName = (el.propertyName ?? el.name).text;
                    const reBinding = findModuleBinding(targetSf, localName);
                    if (
                      reBinding &&
                      isExternalSpecifier(reBinding.moduleSpecifier, targetSf.fileName, repoRoot, workspaceRegistry)
                    ) {
                      return packageConnectorId(reBinding.moduleSpecifier);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    return undefined;
  }
  return packageConnectorId(binding.moduleSpecifier);
}

/** Repo-relative path of a source file (the key used in stable entity ids). */
function relativeFilePath(sourceFile: ts.SourceFile, repoRoot: string): string {
  return path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
}

/**
 * Extracts a target identifier or class name from an `ObjectLiteralExpression` along `subProps`
 * (e.g. `this.broadcastOptions = { parser: opts.parser || msgpack }` when accessing `this.broadcastOptions.parser.encode()`).
 */
function extractSubPropertyTargetFromObjectExpr(
  rawExpr: ts.Expression | undefined,
  subProps: readonly string[]
): { targetName: string; walkedCount: number } | null {
  if (!rawExpr || subProps.length === 0) return null;
  const unwrappedRoot = unwrapTransparentExpr(rawExpr);
  if (!ts.isObjectLiteralExpression(unwrappedRoot)) return null;
  let curExpr: ts.ObjectLiteralExpression = unwrappedRoot;

  for (let i = 0; i < subProps.length; i++) {
    const seg = subProps[i];
    const isLast = i === subProps.length - 1;
    let matchedProp: ts.ObjectLiteralElementLike | undefined;
    for (const prop of curExpr.properties) {
      if (
        (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
        prop.name.text === seg
      ) {
        matchedProp = prop;
        break;
      }
    }
    if (!matchedProp) return null;
    if (ts.isShorthandPropertyAssignment(matchedProp)) {
      return isLast ? { targetName: matchedProp.name.text, walkedCount: i + 1 } : null;
    }
    if (ts.isPropertyAssignment(matchedProp)) {
      const init = unwrapTransparentExpr(matchedProp.initializer);
      if (!isLast && ts.isObjectLiteralExpression(init)) {
        curExpr = init;
        continue;
      }
      const fromNew = classNameFromTypeOrNew(init);
      if (fromNew) return { targetName: fromNew, walkedCount: i + 1 };
      if (ts.isIdentifier(init)) return { targetName: init.text, walkedCount: i + 1 };
      if (
        ts.isBinaryExpression(init) &&
        (init.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          init.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      ) {
        const rightUnwrapped = unwrapTransparentExpr(init.right);
        const leftUnwrapped = unwrapTransparentExpr(init.left);
        if (ts.isIdentifier(rightUnwrapped)) {
          return { targetName: rightUnwrapped.text, walkedCount: i + 1 };
        }
        if (ts.isIdentifier(leftUnwrapped)) {
          return { targetName: leftUnwrapped.text, walkedCount: i + 1 };
        }
      }
      return null;
    }
  }
  return null;
}

/** Reads the class name out of a `TypeReference`, `new C()`, or DI container `Container.get(C)` style node. */
export function classNameFromTypeOrNew(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return classNameFromTypeOrNew(node.expression);
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
    return classNameFromTypeOrNew(node.expression) ?? classNameFromTypeOrNew(node.type);
  }
  if (ts.isArrayTypeNode(node)) {
    return classNameFromTypeOrNew(node.elementType);
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return classNameFromTypeOrNew(node.right) ?? classNameFromTypeOrNew(node.left);
  }
  if (ts.isConditionalExpression(node)) {
    return classNameFromTypeOrNew(node.whenTrue) ?? classNameFromTypeOrNew(node.whenFalse);
  }
  if (ts.isTypeReferenceNode(node)) {
    if (ts.isIdentifier(node.typeName)) {
      if (
        TRANSPARENT_TYPE_WRAPPERS.has(node.typeName.text) &&
        node.typeArguments &&
        node.typeArguments.length >= 1
      ) {
        return classNameFromTypeOrNew(node.typeArguments[0]);
      }
      if (
        KEY_VALUE_COLLECTION_WRAPPERS.has(node.typeName.text) &&
        node.typeArguments &&
        node.typeArguments.length >= 2
      ) {
        return classNameFromTypeOrNew(node.typeArguments[1]);
      }
      return node.typeName.text;
    }
    return typeRefRootIdentifier(node);
  }
  if (ts.isTypeQueryNode(node)) {
    return typeRefRootIdentifier(node);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const member of node.types) {
      const candidate = classNameFromTypeOrNew(member);
      if (candidate) return candidate;
    }
    return null;
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return classNameFromTypeOrNew(node.type);
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const methodName = node.expression.name.text;
    if (
      methodName === 'get' ||
      methodName === 'resolve' ||
      methodName === 'getAsync' ||
      methodName === 'resolveAsync'
    ) {
      if (
        node.arguments.length === 1 &&
        ts.isIdentifier(node.arguments[0]) &&
        /^[A-Z][a-zA-Z0-9]*$/.test(node.arguments[0].text) &&
        /[a-z]/.test(node.arguments[0].text)
      ) {
        return node.arguments[0].text;
      }
      if (node.typeArguments && node.typeArguments.length === 1) {
        const typeArgClass = classNameFromTypeOrNew(node.typeArguments[0]);
        if (typeArgClass && /^[A-Z]/.test(typeArgClass) && /[a-z]/.test(typeArgClass)) {
          return typeArgClass;
        }
      }
    }
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'inject') {
    if (
      node.arguments.length >= 1 &&
      ts.isIdentifier(node.arguments[0]) &&
      /^[A-Z][a-zA-Z0-9]*$/.test(node.arguments[0].text) &&
      /[a-z]/.test(node.arguments[0].text)
    ) {
      return node.arguments[0].text;
    }
  }
  if (ts.isCallExpression(node) && node.typeArguments && node.typeArguments.length === 1) {
    const typeArgClass = classNameFromTypeOrNew(node.typeArguments[0]);
    if (
      typeArgClass &&
      /^[A-Z]/.test(typeArgClass) &&
      /[a-z]/.test(typeArgClass) &&
      typeArgClass !== 'Promise' &&
      typeArgClass !== 'Array' &&
      typeArgClass !== 'Object' &&
      typeArgClass !== 'Record' &&
      typeArgClass !== 'Map' &&
      typeArgClass !== 'Set'
    ) {
      return typeArgClass;
    }
  }
  return null;
}

/**
 * Inspects a function body (or return type annotation) for a deterministic `ClassName` return ([PAT-EXT-16]).
 */
export function findReturnedNewClassName(
  fnNode:
    | ts.FunctionDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
): string | null {
  if (!fnNode.body) return classNameFromTypeOrNew(fnNode.type);
  if (!ts.isBlock(fnNode.body)) {
    return classNameFromTypeOrNew(fnNode.body) ?? classNameFromTypeOrNew(fnNode.type);
  }
  const distinctClasses = new Set<string>();
  let firstFound: string | null = null;
  let returnedIdent: string | null = null;
  const scan = (n: ts.Node) => {
    if (isNestedFunction(n) && n !== fnNode.body) return;
    if (ts.isReturnStatement(n) && n.expression) {
      const cls = classNameFromTypeOrNew(n.expression);
      if (cls) {
        if (!firstFound) firstFound = cls;
        distinctClasses.add(cls);
        return;
      }
      const unwrappedRet = unwrapTransparentExpr(n.expression);
      if (!returnedIdent && ts.isIdentifier(unwrappedRet)) {
        returnedIdent = unwrappedRet.text;
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(fnNode.body);
  const declaredReturnType = classNameFromTypeOrNew(fnNode.type);
  if (distinctClasses.size > 1 && declaredReturnType) {
    return declaredReturnType;
  }
  let found: string | null = firstFound;
  if (!found && returnedIdent) {
    const sf = fnNode.getSourceFile?.();
    if (sf) {
      const sfIdx = getSourceFileDeclarationIndex(sf);
      found = sfIdx.classByIdentifier.get(returnedIdent) ?? sfIdx.newClassByPropName.get(returnedIdent) ?? null;
    }
  }
  return found ?? declaredReturnType;
}

function isNestedFunction(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

/**
 * Follows a module path (and barrel re-exports) to find a factory function `fnName` that
 * deterministically returns `new ClassName(...)`, returning both the class name and its repo-relative file.
 */
function resolveFactoryInModule(
  moduleRelPath: string,
  fnName: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  depth = 0,
  visited: Set<string> = new Set(),
  staticMethodName?: string
): { className: string; classFile: string } | null {
  if (depth > 5 || visited.has(moduleRelPath)) return null;
  visited.add(moduleRelPath);

  const absPath = path.resolve(repoRoot, moduleRelPath);
  const sf = getCachedSourceFile(absPath);
  if (!sf) return null;

  try {
    const sfIndex = getSourceFileDeclarationIndex(sf);
    if (staticMethodName) {
      const clsDecl = sfIndex.classDeclsByName.get(fnName);
      if (clsDecl) {
        const staticMethod = clsDecl.members.find(
          (m): m is ts.MethodDeclaration =>
            ts.isMethodDeclaration(m) &&
            Boolean(m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) && m.name.text === staticMethodName)
        );
        const explicitReturnedClass = staticMethod
          ? (findReturnedNewClassName(staticMethod) ?? classNameFromTypeOrNew(staticMethod.type))
          : null;
        const className =
          explicitReturnedClass ??
          (fnName.endsWith('Factory') || fnName === 'Test' ? null : fnName);
        if (!className) return null;
        if (sfIndex.topLevelClassNames.has(className)) {
          return { className, classFile: moduleRelPath };
        }
        const clsBinding = findModuleBinding(sf, className);
        if (clsBinding) {
          const clsFile = resolveModulePath(clsBinding.moduleSpecifier, absPath, repoRoot, workspaceRegistry);
          if (clsFile) return { className, classFile: clsFile };
        }
      }
    }
    const fnDecl = sfIndex.functionDeclsByName.get(fnName);
    if (fnDecl) {
      const className = findReturnedNewClassName(fnDecl);
      if (className) {
        if (sfIndex.topLevelClassNames.has(className)) {
          return { className, classFile: moduleRelPath };
        }
        const clsBinding = findModuleBinding(sf, className);
        if (clsBinding) {
          const clsFile = resolveModulePath(clsBinding.moduleSpecifier, absPath, repoRoot, workspaceRegistry);
          if (clsFile) return { className, classFile: clsFile };
        }
      }
    }

    const reExportCandidates: Array<{ path: string; symbol: string }> = [];
    for (const stmt of sf.statements) {
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const spec = stmt.moduleSpecifier.text;
        if (!stmt.exportClause) {
          const resolved = resolveModulePath(spec, absPath, repoRoot, workspaceRegistry);
          if (resolved) reExportCandidates.push({ path: resolved, symbol: fnName });
        } else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (el.name.text === fnName) {
              const resolved = resolveModulePath(spec, absPath, repoRoot, workspaceRegistry);
              if (resolved) {
                reExportCandidates.push({
                  path: resolved,
                  symbol: (el.propertyName ?? el.name).text,
                });
              }
            }
          }
        }
      }
    }

    for (const candidate of reExportCandidates) {
      const res = resolveFactoryInModule(
        candidate.path,
        candidate.symbol,
        repoRoot,
        workspaceRegistry,
        depth + 1,
        visited,
        staticMethodName
      );
      if (res) return res;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolves the concrete class and declaring file returned by a direct factory call expression
 * (`createSQLiteStorage(dbPath)` or `getStickerRenderer()` or `CdpClient.connect(url)`) ([PAT-EXT-16], [PAT-EXT-67]).
 */
function resolveFactoryCallClass(
  factoryCall: ts.CallExpression,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): { className: string; classFile: string } | null {
  if (
    ts.isPropertyAccessExpression(factoryCall.expression) &&
    ts.isIdentifier(factoryCall.expression.expression)
  ) {
    const receiverName = factoryCall.expression.expression.text;
    const staticMethodName = factoryCall.expression.name.text;
    const sfIndex = getSourceFileDeclarationIndex(sourceFile);
    const sameFileCls = sfIndex.classDeclsByName.get(receiverName);
    if (sameFileCls) {
      const staticMethod = sameFileCls.members.find(
        (m): m is ts.MethodDeclaration =>
          ts.isMethodDeclaration(m) &&
          Boolean(m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) && m.name.text === staticMethodName)
      );
      const explicitReturnedClass = staticMethod
        ? (findReturnedNewClassName(staticMethod) ?? classNameFromTypeOrNew(staticMethod.type))
        : null;
      const className =
        explicitReturnedClass ??
        (receiverName.endsWith('Factory') || receiverName === 'Test' ? null : receiverName);
      if (!className) return null;
      if (sfIndex.topLevelClassNames.has(className)) {
        return { className, classFile: relativeFilePath(sourceFile, repoRoot) };
      }
      const clsBinding = findModuleBinding(sourceFile, className);
      if (clsBinding) {
        const clsFile = resolveModulePath(clsBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry);
        if (clsFile) return { className, classFile: clsFile };
      }
    }
    const binding = findValueModuleBinding(sourceFile, receiverName);
    if (!binding) return null;
    const resolvedModule = resolveModulePath(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry);
    if (!resolvedModule) return null;
    const targetSymbol =
      binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
        ? binding.importedName
        : receiverName;
    return resolveFactoryInModule(
      resolvedModule,
      targetSymbol,
      repoRoot,
      workspaceRegistry,
      0,
      new Set(),
      staticMethodName
    );
  }
  if (!ts.isIdentifier(factoryCall.expression)) return null;
  const fnName = factoryCall.expression.text;

  // Check same-file factory declaration first
  const sfIndex = getSourceFileDeclarationIndex(sourceFile);
  const sameFileFn = sfIndex.functionDeclsByName.get(fnName);
  if (sameFileFn) {
    const className = findReturnedNewClassName(sameFileFn);
    if (className) {
      if (sfIndex.topLevelClassNames.has(className)) {
        return { className, classFile: relativeFilePath(sourceFile, repoRoot) };
      }
      if (sfIndex.interfacePropsByName.has(className)) {
        return { className, classFile: '' };
      }
      const clsBinding = findModuleBinding(sourceFile, className);
      if (clsBinding) {
        const clsFile = resolveModulePath(clsBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry);
        if (clsFile) return { className, classFile: clsFile };
      }
    }
  }

  // Check imported factory declaration (following barrel re-exports)
  const binding = findValueModuleBinding(sourceFile, fnName);
  if (!binding) return null;
  const resolvedModule = resolveModulePath(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry);
  if (!resolvedModule) return null;
  const targetSymbol =
    binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
      ? binding.importedName
      : fnName;
  return resolveFactoryInModule(resolvedModule, targetSymbol, repoRoot, workspaceRegistry);
}

/**
 * Resolves the concrete class and declaring file of a variable initialized via a factory call
 * (`const storage = createSQLiteStorage(dbPath)`) when the factory deterministically returns `new C()` ([PAT-EXT-16]).
 */
function factoryClassOfIdentifier(
  name: string,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): { className: string; classFile: string } | null {
  const factoryCall = getSourceFileDeclarationIndex(sourceFile).factoryCallByIdentifier.get(name);
  if (!factoryCall) return null;

  return resolveFactoryCallClass(factoryCall, sourceFile, repoRoot, workspaceRegistry);
}

/** Finds the class a bare identifier is *deterministically* an instance of (declared type or `new C()`). */
function classOfIdentifier(name: string, sourceFile: ts.SourceFile): string | null {
  return getSourceFileDeclarationIndex(sourceFile).classByIdentifier.get(name) ?? null;
}

/** Finds the class of `this.<prop>` from a typed property, parameter property, or `this.prop = new C()`. */
function classOfThisProperty(prop: string, fromNode: ts.Node): string | null {
  let cls: ts.Node | undefined = fromNode;
  while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
  if (!cls || !ts.isClassDeclaration(cls)) return null;

  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === prop) {
      const named = classNameFromTypeOrNew(member.type) ?? classNameFromTypeOrNew(member.initializer);
      if (named) return named;
    }
    if (ts.isConstructorDeclaration(member)) {
      for (const param of member.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === prop) {
          const named = classNameFromTypeOrNew(param.type);
          if (named) return named;
        }
      }
      let result: string | null = null;
      const scan = (n: ts.Node) => {
        if (result) return;
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left) &&
          n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          n.left.name.text === prop
        ) {
          result = classNameFromTypeOrNew(n.right);
          if (!result && ts.isIdentifier(n.right)) {
            const p = member.parameters.find(
              (param) => ts.isIdentifier(param.name) && param.name.text === (n.right as ts.Identifier).text
            );
            if (p) result = classNameFromTypeOrNew(p.type);
          }
        }
        ts.forEachChild(n, scan);
      };
      if (member.body) scan(member.body);
      if (result) return result;
    }
  }
  return null;
}

interface ExtractedCjsContract {
  name: string;
  entityType: string;
  patternId: string;
  node: ts.Node;
}

const cjsContractCache = new WeakMap<ts.SourceFile, ExtractedCjsContract[]>();
const targetSfCache = new Map<string, { mtimeMs: number; size: number; sf: ts.SourceFile }>();
const dummyEvidence = (): EvidenceRecord => ({ filePath: '', lineNumber: 1, snippet: '' });
const dummyNextId = () => '';

/**
 * Resets per-run parsed `ts.SourceFile` cache in `targetResolver.ts`.
 * Called at the start of `analyzeTarget()` so rapid edits within the same filesystem mtime tick
 * never read stale ASTs.
 */
export function clearTargetResolverCache(): void {
  targetSfCache.clear();
}

const HTTP_DYNAMIC_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'head',
  'options',
  'patch',
  'trace',
  'connect',
]);

export function getCachedSourceFile(absPath: string): ts.SourceFile | null {
  try {
    const stat = fs.statSync(absPath);
    const cached = targetSfCache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.sf;
    const rawText = fs.readFileSync(absPath, 'utf8');
    const isPreprocessed = isTemplatePreprocessedFile(absPath);
    const text = isPreprocessed ? preprocessAstroOrMdxSource(absPath, rawText) : rawText;
    const sf = ts.createSourceFile(
      absPath,
      text,
      ts.ScriptTarget.Latest,
      true,
      isPreprocessed ? ts.ScriptKind.TSX : undefined
    );
    targetSfCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, sf });
    return sf;
  } catch {
    return null;
  }
}

function getCjsContractsInSourceFile(sourceFile: ts.SourceFile): ExtractedCjsContract[] {
  let list = cjsContractCache.get(sourceFile);
  if (!list) {
    list = [];
    const walk = (n: ts.Node) => {
      const entity = extractCommonjsExport(n, dummyEvidence, dummyNextId);
      if (entity && entity.type === 'CONTRACT') {
        list!.push({
          name: entity.name,
          entityType: entity.entityType,
          patternId: entity.patternId,
          node: n,
        });
      }
      ts.forEachChild(n, walk);
    };
    walk(sourceFile);
    cjsContractCache.set(sourceFile, list);
  }
  return list;
}

function isCallableCjsContract(
  contract: ExtractedCjsContract,
  targetSourceFile: ts.SourceFile
): boolean {
  if (
    contract.entityType === 'EXPORTED_FUNCTION' ||
    contract.entityType === 'PROTOTYPE_METHOD' ||
    contract.entityType === 'CJS_METHOD'
  ) {
    return true;
  }
  if (contract.name === 'CJS Export: default' && ts.isBinaryExpression(contract.node)) {
    let rhs: ts.Expression = contract.node.right;
    while (ts.isBinaryExpression(rhs) && rhs.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      rhs = rhs.right;
    }
    if (ts.isFunctionExpression(rhs) || ts.isArrowFunction(rhs)) {
      return true;
    }
    if (ts.isIdentifier(rhs)) {
      const identName = rhs.text;
      if (getSourceFileDeclarationIndex(targetSourceFile).functionDeclsByName.has(identName)) {
        return true;
      }
      for (const stmt of targetSourceFile.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.name.text === identName &&
            decl.initializer &&
            ts.isCallExpression(decl.initializer) &&
            decl.initializer.arguments.some(
              (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)
            )
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Resolves a member name (`send`, `lookup`, `compileETag`, `default`) against CommonJS export
 * and prototype contracts declared in `targetSourceFile`.
 */
export function resolveCjsContractInSourceFile(
  targetSourceFile: ts.SourceFile,
  memberName: string,
  relFilePath: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  requireFunctionDeclaration = false
): { targetId: string; targetEvidence: EvidenceRecord; patternId: string; entityType: string } | null {
  const contracts = getCjsContractsInSourceFile(targetSourceFile);
  if (contracts.length === 0) return null;

  const matched =
    contracts.find((c) => c.name === `CJS Export: ${memberName}`) ??
    contracts.find((c) => c.name.startsWith('Prototype Method: ') && c.name.endsWith(`.prototype.${memberName}`)) ??
    contracts.find((c) => c.name.startsWith('CJS Export Alias: ') && c.name.endsWith(`.${memberName}`)) ??
    (HTTP_DYNAMIC_METHODS.has(memberName)
      ? contracts.find((c) => c.name.startsWith('Dynamic Export: ') && c.name.endsWith('[method]'))
      : undefined) ??
    (memberName === 'default' ? contracts.find((c) => c.name === 'CJS Export: default') : undefined);

  if (!matched) return null;
  if (requireFunctionDeclaration && !isCallableCjsContract(matched, targetSourceFile)) {
    return null;
  }

  const targetScope = resolveLogicalBoundaryScope(
    relFilePath,
    repoRoot,
    workspaceRegistry,
    findEnclosingNamespaceScope(matched.node)
  );
  const targetId = contractEntityId(
    targetScope,
    relFilePath,
    matched.name,
    matched.patternId
  );
  const start = matched.node.getStart(targetSourceFile);
  const { line } = targetSourceFile.getLineAndCharacterOfPosition(start);
  return {
    targetId,
    patternId: matched.patternId,
    entityType: matched.entityType,
    targetEvidence: {
      filePath: relFilePath,
      lineNumber: line + 1,
      snippet: matched.node.getText(targetSourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
      evidenceRole: 'target-signature',
    },
  };
}

const EXPRESS_SIBLING_MODULES: Record<string, string> = {
  app: './application',
  req: './request',
  res: './response',
};

let requireGetAccessorOnly = false;

function findPublicMethodOnClass(
  cls: ts.ClassDeclaration,
  methodName: string
): ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.PropertyDeclaration | ts.ObjectLiteralElementLike | null {
  const segments = methodName.split('.');
  const outerMemberName = segments[0];
  const subSegments = segments.slice(1);

  for (const member of cls.members) {
    if (requireGetAccessorOnly && !ts.isGetAccessorDeclaration(member)) continue;
    const isMethod = ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member);
    const unwrappedPropInit =
      !isMethod && ts.isPropertyDeclaration(member) && member.initializer
        ? unwrapTransparentExpr(member.initializer)
        : null;
    const isPropFn =
      unwrappedPropInit !== null &&
      (ts.isArrowFunction(unwrappedPropInit) || ts.isFunctionExpression(unwrappedPropInit));
    const isPropObj =
      unwrappedPropInit !== null && ts.isObjectLiteralExpression(unwrappedPropInit);
    if ((!isMethod && !isPropFn && !isPropObj) || !member.name) continue;
    if (!(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
    if (member.name.text !== outerMemberName) continue;
    const isHidden = (ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)?.some(
      (m: ts.Modifier) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
    );
    if (isHidden) continue;
    if (subSegments.length > 0) {
      if (!isPropObj || !ts.isObjectLiteralExpression(unwrappedPropInit)) continue;
      let curObj: ts.ObjectLiteralExpression | null = unwrappedPropInit;
      for (let i = 0; i < subSegments.length && curObj; i++) {
        const seg = subSegments[i];
        const isLeaf = i === subSegments.length - 1;
        let nextObj: ts.ObjectLiteralExpression | null = null;
        for (const prop of curObj.properties) {
          if (
            ts.isMethodDeclaration(prop) &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
            prop.name.text === seg
          ) {
            if (isLeaf) return prop;
            break;
          }
          if (
            ts.isPropertyAssignment(prop) &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
            prop.name.text === seg
          ) {
            const subInit = unwrapTransparentExpr(prop.initializer);
            if (isLeaf && (ts.isArrowFunction(subInit) || ts.isFunctionExpression(subInit))) {
              return prop;
            }
            if (!isLeaf && ts.isObjectLiteralExpression(subInit)) {
              nextObj = subInit;
              break;
            }
          }
        }
        curObj = nextObj;
      }
      continue;
    }
    if (isPropObj) continue;
    return member as ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.PropertyDeclaration;
  }
  return null;
}

export function resolveClassMethodInModule(
  moduleRelPath: string,
  symbolName: string,
  methodName: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  depth = 0,
  visited = new Set<string>()
): { targetId: string; targetEvidence: EvidenceRecord } | null {
  if (depth > 4) return null;
  const visitKey = `${moduleRelPath}::${symbolName}::${methodName}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  const absPath = path.resolve(repoRoot, moduleRelPath);
  const sf = getCachedSourceFile(absPath);
  if (!sf) return null;

  const sfIndex = getSourceFileDeclarationIndex(sf);
  let matchedClass: ts.ClassDeclaration | undefined;
  let importedSingletonClassName: string | null = null;
  if (symbolName === 'default') {
    for (const stmt of sf.statements) {
      if (
        ts.isClassDeclaration(stmt) &&
        stmt.name &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      ) {
        matchedClass = stmt;
        break;
      }
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        if (ts.isIdentifier(stmt.expression)) {
          matchedClass = sfIndex.classDeclsByName.get(stmt.expression.text);
          if (matchedClass) break;
          const instClass = sfIndex.classByIdentifier.get(stmt.expression.text);
          if (instClass) {
            matchedClass = sfIndex.classDeclsByName.get(instClass);
            if (matchedClass) break;
            importedSingletonClassName = instClass;
            break;
          }
        } else {
          const instClass = classNameFromTypeOrNew(stmt.expression);
          if (instClass) {
            matchedClass = sfIndex.classDeclsByName.get(instClass);
            if (matchedClass) break;
            importedSingletonClassName = instClass;
            break;
          }
        }
      }
    }
  } else {
    let lookupName = symbolName;
    for (const stmt of sf.statements) {
      if (
        ts.isExportDeclaration(stmt) &&
        !stmt.moduleSpecifier &&
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === symbolName && el.propertyName) {
            lookupName = el.propertyName.text;
            break;
          }
        }
      }
    }
    matchedClass = sfIndex.classDeclsByName.get(lookupName);
    if (!matchedClass) {
      const instClass = sfIndex.classByIdentifier.get(lookupName);
      if (instClass) {
        matchedClass = sfIndex.classDeclsByName.get(instClass);
        if (!matchedClass) {
          importedSingletonClassName = instClass;
        }
      }
    }
    if (!matchedClass && !importedSingletonClassName) {
      const fCall = sfIndex.factoryCallByIdentifier.get(lookupName);
      if (fCall) {
        const factoryResolved = resolveFactoryCallClass(fCall, sf, repoRoot, workspaceRegistry);
        if (factoryResolved) {
          if (factoryResolved.classFile === moduleRelPath) {
            matchedClass = sfIndex.classDeclsByName.get(factoryResolved.className);
          } else {
            const delegated = resolveClassMethodInModule(
              factoryResolved.classFile,
              factoryResolved.className,
              methodName,
              repoRoot,
              workspaceRegistry,
              depth + 1,
              visited
            );
            if (delegated) return delegated;
          }
        }
      }
    }
  }

  // Fallback for CommonJS `module.exports = ClassName` or default class export when imported via CJS require alias
  if (!matchedClass && !importedSingletonClassName) {
    for (const stmt of sf.statements) {
      if (
        ts.isClassDeclaration(stmt) &&
        stmt.name &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      ) {
        matchedClass = stmt;
        break;
      }
      if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
        matchedClass = sfIndex.classDeclsByName.get(stmt.expression.text);
        if (matchedClass) break;
      }
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExportsOrExportsExpr(stmt.expression.left) &&
        ts.isIdentifier(stmt.expression.right)
      ) {
        matchedClass = sfIndex.classDeclsByName.get(stmt.expression.right.text);
        if (matchedClass) break;
      }
    }
  }

  if (!matchedClass && importedSingletonClassName) {
    const classBinding = findModuleBinding(sf, importedSingletonClassName);
    if (classBinding) {
      const resolvedClassPath = resolveModulePath(
        classBinding.moduleSpecifier,
        sf.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedClassPath) {
        const classLookup =
          classBinding.importedName && classBinding.importedName !== '*'
            ? classBinding.importedName
            : importedSingletonClassName;
        const delegated = resolveClassMethodInModule(
          resolvedClassPath,
          classLookup,
          methodName,
          repoRoot,
          workspaceRegistry,
          depth + 1,
          visited
        );
        if (delegated) return delegated;
      }
    }
  }

  if (matchedClass && matchedClass.name) {
    const methodDecl = findPublicMethodOnClass(matchedClass, methodName);
    if (methodDecl) {
      const classScope = resolveLogicalBoundaryScope(
        moduleRelPath,
        repoRoot,
        workspaceRegistry,
        findEnclosingNamespaceScope(matchedClass)
      );
      const targetId = contractEntityId(
        classScope,
        moduleRelPath,
        publicMethodName(matchedClass.name.text, methodName),
        'contract.public-method'
      );
      const start = methodDecl.getStart(sf);
      const { line } = sf.getLineAndCharacterOfPosition(start);
      return {
        targetId,
        targetEvidence: {
          filePath: moduleRelPath,
          lineNumber: line + 1,
          snippet: methodDecl.getText(sf).slice(0, 80).replace(/\s+/g, ' ').trim(),
          evidenceRole: 'target-signature',
        },
      };
    }

    const inherited = findClassMethodWithInheritance(
      matchedClass,
      methodName,
      sf,
      repoRoot,
      workspaceRegistry
    );
    if (inherited) {
      const start = matchedClass.getStart(sf);
      const { line } = sf.getLineAndCharacterOfPosition(start);
      return {
        targetId: inherited.targetId,
        targetEvidence: {
          filePath: moduleRelPath,
          lineNumber: line + 1,
          snippet: matchedClass.getText(sf).slice(0, 80).replace(/\s+/g, ' ').trim(),
          evidenceRole: 'target-signature',
        },
      };
    }
  }

  // Follow barrel re-exports (`export * from './...'`, `export { User } from './...'`, or `import { User } from './...'; export { User }`)
  for (const stmt of sf.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      if (!stmt.exportClause) {
        const resolved = resolveModulePath(spec, absPath, repoRoot, workspaceRegistry);
        if (resolved) {
          const res = resolveClassMethodInModule(
            resolved,
            symbolName,
            methodName,
            repoRoot,
            workspaceRegistry,
            depth + 1,
            visited
          );
          if (res) return res;
        }
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === symbolName) {
            const resolved = resolveModulePath(spec, absPath, repoRoot, workspaceRegistry);
            if (resolved) {
              const res = resolveClassMethodInModule(
                resolved,
                (el.propertyName ?? el.name).text,
                methodName,
                repoRoot,
                workspaceRegistry,
                depth + 1,
                visited
              );
              if (res) return res;
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
        if (el.name.text === symbolName) {
          const orig = (el.propertyName ?? el.name).text;
          const binding = findModuleBinding(sf, orig);
          if (binding) {
            const resolved = resolveModulePath(binding.moduleSpecifier, sf.fileName, repoRoot, workspaceRegistry);
            if (resolved) {
              const lookup =
                binding.importedName && binding.importedName !== '*'
                  ? binding.importedName
                  : orig;
              const res = resolveClassMethodInModule(
                resolved,
                lookup,
                methodName,
                repoRoot,
                workspaceRegistry,
                depth + 1,
                visited
              );
              if (res) return res;
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolves `Class.method()` when `Class` is a same-file or imported `ClassDeclaration` that
 * declares a public (or static public) method named `method`, returning both the extracted
 * `PUBLIC_METHOD` contract id and its `target-signature` evidence record.
 */
export function resolveClassMethodTargetWithEvidence(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): { targetId: string; targetEvidence: EvidenceRecord } | null {
  const access = getPropertyOrElementAccess(call.expression);
  if (!access) return null;
  const subSegments: string[] = [];
  let curExpr: ts.Expression = unwrapTransparentExpr(access.expression);
  while (ts.isPropertyAccessExpression(curExpr)) {
    subSegments.unshift(curExpr.name.text);
    curExpr = unwrapTransparentExpr(curExpr.expression);
  }
  if (!ts.isIdentifier(curExpr) || subSegments.length > 3) return null;
  const receiverName = curExpr.text;
  const methodName = subSegments.length > 0 ? `${subSegments.join('.')}.${access.memberName}` : access.memberName;

  // 1. Same-file ClassDeclaration (`sk1/CALL/LocalClass/Prop(Id)`)
  const sfIndex = getSourceFileDeclarationIndex(sourceFile);
  const localClass = sfIndex.classDeclsByName.get(receiverName);
  if (localClass && localClass.name) {
    const relFile = relativeFilePath(sourceFile, repoRoot);
    const classScope = resolveLogicalBoundaryScope(
      relFile,
      repoRoot,
      workspaceRegistry,
      findEnclosingNamespaceScope(localClass)
    );
    const methodDecl = findPublicMethodOnClass(localClass, methodName);
    if (methodDecl) {
      const targetId = contractEntityId(
        classScope,
        relFile,
        publicMethodName(localClass.name.text, methodName),
        'contract.public-method'
      );
      const start = methodDecl.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      return {
        targetId,
        targetEvidence: {
          filePath: relFile,
          lineNumber: line + 1,
          snippet: methodDecl.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
          evidenceRole: 'target-signature',
        },
      };
    }

    const inherited = findClassMethodWithInheritance(
      localClass,
      methodName,
      sourceFile,
      repoRoot,
      workspaceRegistry
    );
    if (inherited) {
      const start = localClass.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      return {
        targetId: inherited.targetId,
        targetEvidence: {
          filePath: relFile,
          lineNumber: line + 1,
          snippet: localClass.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
          evidenceRole: 'target-signature',
        },
      };
    }

    if (subSegments.length > 0 && !requireGetAccessorOnly) {
      const start = localClass.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      return {
        targetId: boundaryEntityId(classScope, relFile, `Class: ${localClass.name.text}`),
        targetEvidence: {
          filePath: relFile,
          lineNumber: line + 1,
          snippet: localClass.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
          evidenceRole: 'target-signature',
        },
      };
    }
  }

  // 2. Imported ClassDeclaration
  const binding = findValueModuleBinding(sourceFile, receiverName);
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
          : receiverName;
      return resolveClassMethodInModule(
        resolvedPath,
        lookupSymbol,
        methodName,
        repoRoot,
        workspaceRegistry
      );
    }
  }

  return null;
}

export function resolveClassBoundaryInModule(
  moduleRelPath: string,
  symbolName: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  depth = 0,
  visited = new Set<string>(),
  allowClassWithPublicMethods = false
): { targetId: string; targetEvidence: EvidenceRecord } | null {
  if (depth > 4) return null;
  const visitKey = `${moduleRelPath}::${symbolName}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  const absPath = path.resolve(repoRoot, moduleRelPath);
  const sf = getCachedSourceFile(absPath);
  if (!sf) return null;

  const sfIndex = getSourceFileDeclarationIndex(sf);
  let matchedClass: ts.ClassDeclaration | undefined;
  let importedSingletonClassName: string | null = null;
  if (symbolName === 'default') {
    for (const stmt of sf.statements) {
      if (
        ts.isClassDeclaration(stmt) &&
        stmt.name &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      ) {
        matchedClass = stmt;
        break;
      }
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        if (ts.isIdentifier(stmt.expression)) {
          matchedClass = sfIndex.classDeclsByName.get(stmt.expression.text);
          if (matchedClass) break;
          const instClass = sfIndex.classByIdentifier.get(stmt.expression.text);
          if (instClass) {
            matchedClass = sfIndex.classDeclsByName.get(instClass);
            if (matchedClass) break;
            importedSingletonClassName = instClass;
            break;
          }
        } else {
          const instClass = classNameFromTypeOrNew(stmt.expression);
          if (instClass) {
            matchedClass = sfIndex.classDeclsByName.get(instClass);
            if (matchedClass) break;
            importedSingletonClassName = instClass;
            break;
          }
        }
      }
    }
  } else {
    let lookupName = symbolName;
    for (const stmt of sf.statements) {
      if (
        ts.isExportDeclaration(stmt) &&
        !stmt.moduleSpecifier &&
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === symbolName && el.propertyName) {
            lookupName = el.propertyName.text;
            break;
          }
        }
      }
    }
    matchedClass = sfIndex.classDeclsByName.get(lookupName);
    if (!matchedClass) {
      const instClass = sfIndex.classByIdentifier.get(lookupName);
      if (instClass) {
        matchedClass = sfIndex.classDeclsByName.get(instClass);
        if (!matchedClass) {
          importedSingletonClassName = instClass;
        }
      }
    }
  }

  if (!matchedClass && importedSingletonClassName) {
    const classBinding = findModuleBinding(sf, importedSingletonClassName);
    if (classBinding) {
      const resolvedClassPath = resolveModulePath(
        classBinding.moduleSpecifier,
        sf.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedClassPath) {
        const classLookup =
          classBinding.importedName && classBinding.importedName !== '*'
            ? classBinding.importedName
            : importedSingletonClassName;
        const delegated = resolveClassBoundaryInModule(
          resolvedClassPath,
          classLookup,
          repoRoot,
          workspaceRegistry,
          depth + 1,
          visited,
          allowClassWithPublicMethods
        );
        if (delegated) return delegated;
      }
    }
  }

  if (matchedClass && matchedClass.name) {
    const hasConstructor =
      matchedClass.members.some((m) => ts.isConstructorDeclaration(m)) ||
      Boolean(matchedClass.heritageClauses?.length);
    const hasPublicMethods = (sfIndex.publicMethodsByClass.get(matchedClass.name.text)?.size ?? 0) > 0;
    if (!allowClassWithPublicMethods && (!hasConstructor || hasPublicMethods)) {
      return null;
    }
    const classScope = resolveLogicalBoundaryScope(
      moduleRelPath,
      repoRoot,
      workspaceRegistry,
      findEnclosingNamespaceScope(matchedClass)
    );
    const targetId = boundaryEntityId(classScope, moduleRelPath, `Class: ${matchedClass.name.text}`);
    const start = matchedClass.getStart(sf);
    const { line } = sf.getLineAndCharacterOfPosition(start);
    return {
      targetId,
      targetEvidence: {
        filePath: moduleRelPath,
        lineNumber: line + 1,
        snippet: matchedClass.getText(sf).slice(0, 80).replace(/\s+/g, ' ').trim(),
        evidenceRole: 'target-signature',
      },
    };
  }

  for (const stmt of sf.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      if (!stmt.exportClause) {
        const resolved = resolveModulePath(spec, absPath, repoRoot, workspaceRegistry);
        if (resolved) {
          const res = resolveClassBoundaryInModule(
            resolved,
            symbolName,
            repoRoot,
            workspaceRegistry,
            depth + 1,
            visited,
            allowClassWithPublicMethods
          );
          if (res) return res;
        }
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === symbolName) {
            const resolved = resolveModulePath(spec, absPath, repoRoot, workspaceRegistry);
            if (resolved) {
              const res = resolveClassBoundaryInModule(
                resolved,
                (el.propertyName ?? el.name).text,
                repoRoot,
                workspaceRegistry,
                depth + 1,
                visited,
                allowClassWithPublicMethods
              );
              if (res) return res;
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
        if (el.name.text === symbolName) {
          const orig = (el.propertyName ?? el.name).text;
          const binding = findModuleBinding(sf, orig);
          if (binding) {
            const resolved = resolveModulePath(binding.moduleSpecifier, sf.fileName, repoRoot, workspaceRegistry);
            if (resolved) {
              const lookup =
                binding.importedName && binding.importedName !== '*'
                  ? binding.importedName
                  : orig;
              const res = resolveClassBoundaryInModule(
                resolved,
                lookup,
                repoRoot,
                workspaceRegistry,
                depth + 1,
                visited,
                allowClassWithPublicMethods
              );
              if (res) return res;
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolves `new ClassName(...)` or `new Namespace.ClassName(...)` when imported from an intra-repo module
 * (`[PAT-EXT-16]`), returning the target `CLASS` boundary ID and its `target-signature` evidence.
 */
export function resolveImportedClassBoundaryTargetWithEvidence(
  className: string,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  explicitMemberName?: string,
  allowClassWithPublicMethods = false
): { targetId: string; targetEvidence: EvidenceRecord } | null {
  const binding = findModuleBinding(sourceFile, className);
  if (!binding) return null;
  if (isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
    return null;
  }
  const resolvedPath = resolveModulePath(
    binding.moduleSpecifier,
    sourceFile.fileName,
    repoRoot,
    workspaceRegistry
  );
  if (!resolvedPath) return null;
  const lookupSymbol = explicitMemberName
    ? explicitMemberName
    : binding.importedName && binding.importedName !== '*'
      ? binding.importedName
      : className;
  return resolveClassBoundaryInModule(
    resolvedPath,
    lookupSymbol,
    repoRoot,
    workspaceRegistry,
    0,
    new Set<string>(),
    allowClassWithPublicMethods
  );
}

/**
 * Extracts declared type name and optional namespace qualifier from a TypeNode.
 * Handles `TypeReference` (`Router`, `express.Router`), unions (`Foo | null`), parenthesized types, and `typeof X`.
 */
function extractDeclaredTypeInfo(
  typeNode: ts.TypeNode | undefined
): { typeName: string; qualifier: string | null } | null {
  if (!typeNode) return null;

  if (ts.isArrayTypeNode(typeNode)) {
    return extractDeclaredTypeInfo(typeNode.elementType);
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    if (ts.isIdentifier(typeNode.typeName)) {
      if (
        TRANSPARENT_TYPE_WRAPPERS.has(typeNode.typeName.text) &&
        typeNode.typeArguments &&
        typeNode.typeArguments.length >= 1
      ) {
        const inner = extractDeclaredTypeInfo(typeNode.typeArguments[0]);
        if (inner) return inner;
      }
      if (
        KEY_VALUE_COLLECTION_WRAPPERS.has(typeNode.typeName.text) &&
        typeNode.typeArguments &&
        typeNode.typeArguments.length >= 2
      ) {
        const inner = extractDeclaredTypeInfo(typeNode.typeArguments[1]);
        if (inner) return inner;
      }
      return { typeName: typeNode.typeName.text, qualifier: null };
    }
    if (ts.isQualifiedName(typeNode.typeName)) {
      let root: ts.EntityName = typeNode.typeName.left;
      while (ts.isQualifiedName(root)) {
        root = root.left;
      }
      const qualifier = ts.isIdentifier(root) ? root.text : null;
      return { typeName: typeNode.typeName.right.text, qualifier };
    }
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    for (const member of typeNode.types) {
      const extracted = extractDeclaredTypeInfo(member);
      if (extracted) return extracted;
    }
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return extractDeclaredTypeInfo(typeNode.type);
  }
  if (ts.isTypeQueryNode(typeNode)) {
    if (ts.isIdentifier(typeNode.exprName)) {
      return { typeName: typeNode.exprName.text, qualifier: null };
    }
    if (ts.isQualifiedName(typeNode.exprName)) {
      let root: ts.EntityName = typeNode.exprName.left;
      while (ts.isQualifiedName(root)) {
        root = root.left;
      }
      const qualifier = ts.isIdentifier(root) ? root.text : null;
      return { typeName: typeNode.exprName.right.text, qualifier };
    }
  }
  return null;
}

function hasHiddenMemberOnClass(cls: ts.ClassDeclaration, methodName: string): boolean {
  const outerMemberName = methodName.split('.')[0];
  for (const member of cls.members) {
    if (
      !ts.isMethodDeclaration(member) &&
      !ts.isPropertyDeclaration(member) &&
      !ts.isGetAccessorDeclaration(member) &&
      !ts.isSetAccessorDeclaration(member)
    ) {
      continue;
    }
    if (!member.name) continue;
    if (ts.isPrivateIdentifier(member.name)) {
      if (member.name.text === outerMemberName || member.name.text === `#${outerMemberName}`) {
        return true;
      }
      continue;
    }
    if (!(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
    if (member.name.text !== outerMemberName) continue;
    const isHidden = (ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)?.some(
      (m: ts.Modifier) =>
        m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
    );
    if (isHidden) return true;
  }
  return false;
}

/**
 * Searches `sf` and its barrel re-exports (`export { X } from './...'`, `export * from './...'`)
 * for a `ClassDeclaration` named `className`, returning the declaration and its containing `SourceFile`.
 */
export function findClassDeclInModuleOrReexports(
  sf: ts.SourceFile,
  className: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  depth = 0,
  visited = new Set<string>()
): { cls: ts.ClassDeclaration; sf: ts.SourceFile } | null {
  if (depth > 4) return null;
  const visitKey = `${sf.fileName}::${className}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  const sfIdx = getSourceFileDeclarationIndex(sf);
  const direct = sfIdx.classDeclsByName.get(className);
  if (direct) return { cls: direct, sf };

  for (const stmt of sf.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        if (el.name.text === className) {
          const orig = (el.propertyName ?? el.name).text;
          const localCls = sfIdx.classDeclsByName.get(orig);
          if (localCls) return { cls: localCls, sf };
          const bind = findModuleBinding(sf, orig);
          if (bind) {
            const resolved = resolveModulePath(bind.moduleSpecifier, sf.fileName, repoRoot, workspaceRegistry);
            if (resolved) {
              const targetSf = getCachedSourceFile(path.resolve(repoRoot, resolved));
              if (targetSf) {
                const lookup =
                  bind.importedName && bind.importedName !== '*' ? bind.importedName : orig;
                const found = findClassDeclInModuleOrReexports(
                  targetSf,
                  lookup,
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
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === className) {
            const resolved = resolveModulePath(spec, sf.fileName, repoRoot, workspaceRegistry);
            if (resolved) {
              const targetSf = getCachedSourceFile(path.resolve(repoRoot, resolved));
              if (targetSf) {
                const found = findClassDeclInModuleOrReexports(
                  targetSf,
                  (el.propertyName ?? el.name).text,
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
      } else if (!stmt.exportClause) {
        const resolved = resolveModulePath(spec, sf.fileName, repoRoot, workspaceRegistry);
        if (resolved) {
          const targetSf = getCachedSourceFile(path.resolve(repoRoot, resolved));
          if (targetSf) {
            const found = findClassDeclInModuleOrReexports(
              targetSf,
              className,
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
  }
  return null;
}

/**
 * Resolves `ifaceOrBase.<methodName>()` to a unique concrete implementation class's `PUBLIC_METHOD`
 * contract when `typeName` is an interface or abstract class implemented/extended by concrete class(es).
 */
function resolveInterfaceMethodImplementationTarget(
  typeName: string,
  methodName: string,
  declaringSf: ts.SourceFile,
  callerSf: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  localOnly = false
): string | undefined {
  if (
    BUILTIN_VALUE_PROTOTYPE_METHODS.has(methodName) ||
    BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName)
  ) {
    return undefined;
  }

  const candidateFiles: ts.SourceFile[] = [];
  const seenFiles = new Set<string>();
  const pushSf = (sf: ts.SourceFile | null | undefined) => {
    if (!sf || seenFiles.has(sf.fileName)) return;
    seenFiles.add(sf.fileName);
    candidateFiles.push(sf);
  };

  pushSf(declaringSf);
  pushSf(callerSf);

  // Follow imports and barrel re-exports in declaringSf and callerSf
  for (const seedSf of [declaringSf, callerSf]) {
    for (const stmt of seedSf.statements) {
      let spec: string | null = null;
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        spec = stmt.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        spec = stmt.moduleSpecifier.text;
      }
      if (spec && !isExternalSpecifier(spec, seedSf.fileName, repoRoot, workspaceRegistry)) {
        const resolved = resolveModulePath(spec, seedSf.fileName, repoRoot, workspaceRegistry);
        if (resolved) {
          const importedSf = getCachedSourceFile(path.resolve(repoRoot, resolved));
          pushSf(importedSf);
          if (importedSf) {
            for (const subStmt of importedSf.statements) {
              if (
                ts.isExportDeclaration(subStmt) &&
                subStmt.moduleSpecifier &&
                ts.isStringLiteral(subStmt.moduleSpecifier)
              ) {
                const subResolved = resolveModulePath(
                  subStmt.moduleSpecifier.text,
                  importedSf.fileName,
                  repoRoot,
                  workspaceRegistry
                );
                if (subResolved) {
                  pushSf(getCachedSourceFile(path.resolve(repoRoot, subResolved)));
                }
              }
            }
          }
        }
      }
    }
  }

  // Also scan sibling and immediate child source files in declaringSf/callerSf directories (bounded to 30 files)
  try {
    const searchDirs = new Set<string>([
      path.dirname(declaringSf.fileName),
      path.dirname(callerSf.fileName),
      path.dirname(path.dirname(declaringSf.fileName)),
    ]);
    for (const dir of searchDirs) {
      if (candidateFiles.length >= 35 || !dir || !fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (candidateFiles.length >= 35) break;
        if (
          entry.isFile() &&
          /\.[tj]sx?$/.test(entry.name) &&
          !entry.name.endsWith('.d.ts') &&
          !entry.name.includes('.test.') &&
          !entry.name.includes('.spec.')
        ) {
          pushSf(getCachedSourceFile(path.join(dir, entry.name)));
        } else if (
          entry.isDirectory() &&
          entry.name !== 'node_modules' &&
          entry.name !== 'dist' &&
          entry.name !== '__tests__'
        ) {
          const subDir = path.join(dir, entry.name);
          for (const subEntry of fs.readdirSync(subDir, { withFileTypes: true })) {
            if (candidateFiles.length >= 35) break;
            if (
              subEntry.isFile() &&
              /\.[tj]sx?$/.test(subEntry.name) &&
              !subEntry.name.endsWith('.d.ts') &&
              !subEntry.name.includes('.test.') &&
              !subEntry.name.includes('.spec.')
            ) {
              pushSf(getCachedSourceFile(path.join(subDir, subEntry.name)));
            }
          }
        }
      }
    }
  } catch {
    // Ignore fs errors on synthetic paths
  }

  for (const candSf of candidateFiles) {
    const candIdx = getSourceFileDeclarationIndex(candSf);
    const implNames = candIdx.implementingClassesByHeritage.get(typeName);
    if (!implNames || implNames.length === 0) continue;
    for (const implName of implNames) {
      const implCls = candIdx.classDeclsByName.get(implName);
      if (!implCls) continue;
      const res = findClassMethodWithInheritance(
        implCls,
        methodName,
        candSf,
        repoRoot,
        workspaceRegistry,
        new Set(),
        localOnly
      );
      if (res) return res.targetId;
    }
  }
  return undefined;
}

function findReturnedThisPropertyName(getter: ts.GetAccessorDeclaration): string | null {
  if (!getter.body) return null;
  for (const stmt of getter.body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      const expr = unwrapTransparentExpr(stmt.expression);
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        return expr.name.text;
      }
      if (
        ts.isBinaryExpression(expr) &&
        (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        ts.isPropertyAccessExpression(expr.left) &&
        expr.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        return expr.left.name.text;
      }
    }
  }
  return null;
}

/**
 * Searches a class declaration and its heritage clauses (`extends BaseClass`) for a public method.
 * Resolves to the CONTRACT entity ID or an OPEN_CONNECTOR (if extending an external package class).
 */
function findClassMethodWithInheritance(
  cls: ts.ClassDeclaration,
  methodName: string,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  visited = new Set<string>(),
  localOnly = false
): { targetId: string } | null {
  const sfPath = relativeFilePath(sourceFile, repoRoot);
  const visitKey = `${sfPath}::${cls.name?.text ?? ''}::${methodName}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  // 1. Direct method on this class
  const methodDecl = findPublicMethodOnClass(cls, methodName);
  if (methodDecl && cls.name) {
    const classScope = resolveLogicalBoundaryScope(
      sfPath,
      repoRoot,
      workspaceRegistry,
      findEnclosingNamespaceScope(cls)
    );
    return {
      targetId: contractEntityId(
        classScope,
        sfPath,
        publicMethodName(cls.name.text, methodName),
        'contract.public-method'
      ),
    };
  }

  // If the member is declared as private/protected on this subclass, do not fall through to the superclass.
  if (hasHiddenMemberOnClass(cls, methodName)) {
    return null;
  }

  // 2. Extends heritage clause
  if (cls.heritageClauses) {
    for (const hc of cls.heritageClauses) {
      if (hc.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const t of hc.types) {
          let baseName: string | null = null;
          let baseQualifier: string | null = null;
          if (ts.isIdentifier(t.expression)) {
            baseName = t.expression.text;
          } else if (ts.isPropertyAccessExpression(t.expression)) {
            if (ts.isIdentifier(t.expression.expression)) {
              baseQualifier = t.expression.expression.text;
            }
            if (ts.isIdentifier(t.expression.name)) {
              baseName = t.expression.name.text;
            }
          }

          if (!localOnly && baseQualifier) {
            const qualBinding = findModuleBinding(sourceFile, baseQualifier);
            if (
              qualBinding &&
              isExternalSpecifier(qualBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
            ) {
              return { targetId: packageConnectorId(qualBinding.moduleSpecifier) };
            }
          }

          if (baseName) {
            const baseBinding = findModuleBinding(sourceFile, baseName);
            if (
              !localOnly &&
              baseBinding &&
              isExternalSpecifier(baseBinding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
            ) {
              return { targetId: packageConnectorId(baseBinding.moduleSpecifier) };
            }

            const sfIndex = getSourceFileDeclarationIndex(sourceFile);
            const localBase = sfIndex.classDeclsByName.get(baseName);
            if (localBase) {
              const res = findClassMethodWithInheritance(
                localBase,
                methodName,
                sourceFile,
                repoRoot,
                workspaceRegistry,
                visited,
                localOnly
              );
              if (res) return res;
            } else if (baseBinding) {
              const baseRel = resolveModulePath(
                baseBinding.moduleSpecifier,
                sourceFile.fileName,
                repoRoot,
                workspaceRegistry
              );
              if (baseRel) {
                const baseSf = getCachedSourceFile(path.resolve(repoRoot, baseRel));
                if (baseSf) {
                  const lookup =
                    baseBinding.importedName && baseBinding.importedName !== '*'
                      ? baseBinding.importedName
                      : baseName;
                  const foundBase = findClassDeclInModuleOrReexports(
                    baseSf,
                    lookup,
                    repoRoot,
                    workspaceRegistry
                  );
                  if (foundBase) {
                    const res = findClassMethodWithInheritance(
                      foundBase.cls,
                      methodName,
                      foundBase.sf,
                      repoRoot,
                      workspaceRegistry,
                      visited,
                      localOnly
                    );
                    if (res) return res;
                  }
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

function extractInjectDecoratorToken(node: ts.Node): string | null {
  if (!ts.canHaveDecorators(node)) return null;
  const decorators = ts.getDecorators(node);
  if (!decorators) return null;
  for (const dec of decorators) {
    if (!ts.isCallExpression(dec.expression) || dec.expression.arguments.length === 0) continue;
    const callee = dec.expression.expression;
    const decName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;
    if (decName === 'Inject') {
      const arg0 = dec.expression.arguments[0];
      if (ts.isIdentifier(arg0)) return arg0.text;
      if (ts.isStringLiteral(arg0)) return arg0.text;
    }
  }
  return null;
}

function findNestProviderUseClassInSourceFile(
  sf: ts.SourceFile,
  tokenNames: Set<string>
): string | null {
  let matchedUseClass: string | null = null;
  const walk = (n: ts.Node) => {
    if (matchedUseClass) return;
    if (ts.isObjectLiteralExpression(n)) {
      let provideVal: string | null = null;
      let useClassVal: string | null = null;
      for (const prop of n.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const propName =
          ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
        if (propName === 'provide') {
          if (ts.isIdentifier(prop.initializer)) provideVal = prop.initializer.text;
          else if (ts.isStringLiteral(prop.initializer)) provideVal = prop.initializer.text;
        } else if (propName === 'useClass' || propName === 'useExisting') {
          if (ts.isIdentifier(prop.initializer)) useClassVal = prop.initializer.text;
        }
      }
      if (provideVal && useClassVal && tokenNames.has(provideVal)) {
        matchedUseClass = useClassVal;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return matchedUseClass;
}

function resolveNestProviderMethodTarget(
  tokenNames: Set<string>,
  methodName: string,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): string | undefined {
  const candidateFiles: ts.SourceFile[] = [sourceFile];
  try {
    const dir = path.dirname(sourceFile.fileName);
    const parentDir = path.dirname(dir);
    for (const searchDir of [dir, parentDir]) {
      if (!searchDir || !fs.existsSync(searchDir)) continue;
      for (const entry of fs.readdirSync(searchDir, { withFileTypes: true })) {
        if (entry.isFile() && /\.module\.[tj]sx?$/.test(entry.name)) {
          const sf = getCachedSourceFile(path.join(searchDir, entry.name));
          if (sf && sf !== sourceFile) candidateFiles.push(sf);
        } else if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
          const subDir = path.join(searchDir, entry.name);
          for (const subEntry of fs.readdirSync(subDir, { withFileTypes: true })) {
            if (subEntry.isFile() && /\.module\.[tj]sx?$/.test(subEntry.name)) {
              const sf = getCachedSourceFile(path.join(subDir, subEntry.name));
              if (sf && sf !== sourceFile) candidateFiles.push(sf);
            }
          }
        }
      }
    }
  } catch {
    // Ignore fs errors on synthetic paths
  }

  for (const modSf of candidateFiles) {
    const useClassName = findNestProviderUseClassInSourceFile(modSf, tokenNames);
    if (!useClassName) continue;
    const modIndex = getSourceFileDeclarationIndex(modSf);
    const localImpl = modIndex.classDeclsByName.get(useClassName);
    if (localImpl && localImpl.name) {
      const res = findClassMethodWithInheritance(
        localImpl,
        methodName,
        modSf,
        repoRoot,
        workspaceRegistry
      );
      if (res) return res.targetId;
    }
    const implBinding = findModuleBinding(modSf, useClassName);
    if (implBinding) {
      const resolvedImplPath = resolveModulePath(
        implBinding.moduleSpecifier,
        modSf.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedImplPath) {
        const lookup =
          implBinding.importedName && implBinding.importedName !== '*'
            ? implBinding.importedName
            : useClassName;
        const resolved = resolveClassMethodInModule(
          resolvedImplPath,
          lookup,
          methodName,
          repoRoot,
          workspaceRegistry
        );
        if (resolved) return resolved.targetId;
      }
    }
  }
  return undefined;
}

function extractFirstThisMethodFromCallbackArg(arg: ts.Expression | undefined): string | null {
  if (!arg) return null;
  const unwrapped = unwrapTransparentExpr(arg);
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    unwrapped.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return unwrapped.name.text;
  }
  if (!ts.isArrowFunction(unwrapped) && !ts.isFunctionExpression(unwrapped)) return null;
  let found: string | null = null;
  const scan = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      found = n.expression.name.text;
      return;
    }
    ts.forEachChild(n, scan);
  };
  scan(unwrapped.body);
  return found;
}

function resolveSubPropertyOnClass(
  cls: ts.ClassDeclaration,
  clsSf: ts.SourceFile,
  subPropName: string,
  methodName: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  localOnly?: boolean
): string | undefined {
  if (BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName)) return undefined;
  let subTypeName: string | null = null;
  let subQualifier: string | null = null;
  for (const member of cls.members) {
    if (
      (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === subPropName
    ) {
      const extracted = extractDeclaredTypeInfo(member.type);
      if (extracted) {
        subTypeName = extracted.typeName;
        subQualifier = extracted.qualifier;
        break;
      }
      if (ts.isPropertyDeclaration(member)) {
        const fromInit = classNameFromTypeOrNew(member.initializer);
        if (fromInit) {
          subTypeName = fromInit;
          break;
        }
      } else if (ts.isGetAccessorDeclaration(member)) {
        const fromGetter = findReturnedNewClassName(member);
        if (fromGetter) {
          subTypeName = fromGetter;
          break;
        }
        const backingProp = findReturnedThisPropertyName(member);
        if (backingProp && backingProp !== subPropName) {
          for (const m2 of cls.members) {
            if (
              ts.isPropertyDeclaration(m2) &&
              (ts.isIdentifier(m2.name) || ts.isStringLiteral(m2.name)) &&
              m2.name.text === backingProp
            ) {
              const ext2 = extractDeclaredTypeInfo(m2.type);
              if (ext2) {
                subTypeName = ext2.typeName;
                subQualifier = ext2.qualifier;
                break;
              }
              const init2 = classNameFromTypeOrNew(m2.initializer);
              if (init2) {
                subTypeName = init2;
                break;
              }
            }
          }
          if (subTypeName) break;
        }
      }
    }
    if (ts.isConstructorDeclaration(member)) {
      for (const param of member.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === subPropName) {
          const extracted = extractDeclaredTypeInfo(param.type);
          if (extracted) {
            subTypeName = extracted.typeName;
            subQualifier = extracted.qualifier;
            break;
          }
        }
      }
      if (subTypeName) break;
    }
  }
  if (!subTypeName) return undefined;

  if (!localOnly && subQualifier) {
    const qualBinding = findModuleBinding(clsSf, subQualifier);
    if (
      qualBinding &&
      isExternalSpecifier(qualBinding.moduleSpecifier, clsSf.fileName, repoRoot, workspaceRegistry)
    ) {
      return packageConnectorId(qualBinding.moduleSpecifier);
    }
  }
  const subBinding = findModuleBinding(clsSf, subTypeName);
  if (
    !localOnly &&
    subBinding &&
    isExternalSpecifier(subBinding.moduleSpecifier, clsSf.fileName, repoRoot, workspaceRegistry)
  ) {
    return packageConnectorId(subBinding.moduleSpecifier);
  }
  const clsSfIndex = getSourceFileDeclarationIndex(clsSf);
  const sameFileSubClass = clsSfIndex.classDeclsByName.get(subTypeName);
  if (sameFileSubClass && sameFileSubClass.name) {
    const res = findClassMethodWithInheritance(
      sameFileSubClass,
      methodName,
      clsSf,
      repoRoot,
      workspaceRegistry
    );
    if (res) return res.targetId;
    if (!localOnly) {
      const relFile = relativeFilePath(clsSf, repoRoot);
      const scope = resolveLogicalBoundaryScope(
        relFile,
        repoRoot,
        workspaceRegistry,
        findEnclosingNamespaceScope(sameFileSubClass)
      );
      return boundaryEntityId(scope, relFile, `Class: ${sameFileSubClass.name.text}`);
    }
    return undefined;
  }
  if (subBinding) {
    const resolvedSubPath = resolveModulePath(
      subBinding.moduleSpecifier,
      clsSf.fileName,
      repoRoot,
      workspaceRegistry
    );
    if (resolvedSubPath) {
      const lookup =
        subBinding.importedName && subBinding.importedName !== '*'
          ? subBinding.importedName
          : subTypeName;
      const viaMethod = resolveClassMethodInModule(
        resolvedSubPath,
        lookup,
        methodName,
        repoRoot,
        workspaceRegistry
      );
      if (viaMethod) return viaMethod.targetId;
      if (!localOnly) {
        const viaBoundary = resolveClassBoundaryInModule(
          resolvedSubPath,
          lookup,
          repoRoot,
          workspaceRegistry,
          0,
          new Set(),
          true
        );
        if (viaBoundary) return viaBoundary.targetId;
      }
      const targetSubSf = getCachedSourceFile(path.resolve(repoRoot, resolvedSubPath));
      if (targetSubSf) {
        const viaIface = resolveInterfaceMethodImplementationTarget(
          lookup,
          methodName,
          targetSubSf,
          clsSf,
          repoRoot,
          workspaceRegistry,
          Boolean(localOnly)
        );
        if (viaIface) return viaIface;
      }
    }
  }
  const viaLocalIface = resolveInterfaceMethodImplementationTarget(
    subTypeName,
    methodName,
    clsSf,
    clsSf,
    repoRoot,
    workspaceRegistry,
    Boolean(localOnly)
  );
  if (viaLocalIface) return viaLocalIface;
  return undefined;
}

/**
 * Resolves `this.<prop>.method()` by inspecting the enclosing `ClassDeclaration`'s member
 * property declarations or constructor parameters for the declared type of `this.<prop>`.
 */
function resolveThisPropertyMethodTarget(
  thisPropName: string,
  methodName: string,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  options?: { localOnly?: boolean; subProps?: readonly string[]; innerCallMethodName?: string }
): string | undefined {
  let enclosingClass: ts.ClassDeclaration | undefined;
  let cur: ts.Node | undefined = call;
  while (cur) {
    if (ts.isClassDeclaration(cur)) {
      enclosingClass = cur;
      break;
    }
    cur = cur.parent;
  }

  let targetTypeName: string | null = null;
  let targetQualifier: string | null = null;
  let injectTokenName: string | null = null;
  let walkedObjectSubProps = 0;
  let declaringSf: ts.SourceFile = sourceFile;
  const rawSubProps = options?.subProps ?? [];

  if (enclosingClass) {
    let curClass: ts.ClassDeclaration | undefined = enclosingClass;
    let curClassSf: ts.SourceFile = sourceFile;
    const visitedClassKeys = new Set<string>();
    for (let depth = 0; depth < 4 && curClass && !targetTypeName && !injectTokenName; depth++) {
      const clsKey = `${curClassSf.fileName}::${curClass.name?.text ?? curClass.pos}`;
      if (visitedClassKeys.has(clsKey)) break;
      visitedClassKeys.add(clsKey);

      for (const member of curClass.members) {
        if (
          (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
          member.name.text === thisPropName
        ) {
          if (ts.isPropertyDeclaration(member) && rawSubProps.length > 0 && member.initializer) {
            const objSub = extractSubPropertyTargetFromObjectExpr(member.initializer, rawSubProps);
            if (objSub) {
              targetTypeName = objSub.targetName;
              walkedObjectSubProps = objSub.walkedCount;
              declaringSf = curClassSf;
              break;
            }
          }
          if (ts.isPropertyDeclaration(member)) {
            injectTokenName = extractInjectDecoratorToken(member);
          }
          const extracted = extractDeclaredTypeInfo(member.type);
          if (extracted) {
            targetTypeName = extracted.typeName;
            targetQualifier = extracted.qualifier;
            declaringSf = curClassSf;
            break;
          }
          const fromInit = ts.isPropertyDeclaration(member)
            ? classNameFromTypeOrNew(member.initializer)
            : findReturnedNewClassName(member);
          if (fromInit) {
            targetTypeName = fromInit;
            declaringSf = curClassSf;
            break;
          }
          if (ts.isGetAccessorDeclaration(member)) {
            const backingProp = findReturnedThisPropertyName(member);
            if (backingProp && backingProp !== thisPropName) {
              thisPropName = backingProp;
              for (const m2 of curClass.members) {
                if (
                  ts.isPropertyDeclaration(m2) &&
                  (ts.isIdentifier(m2.name) || ts.isStringLiteral(m2.name)) &&
                  m2.name.text === backingProp
                ) {
                  const ext2 = extractDeclaredTypeInfo(m2.type);
                  if (ext2) {
                    targetTypeName = ext2.typeName;
                    targetQualifier = ext2.qualifier;
                    declaringSf = curClassSf;
                    break;
                  }
                  const init2 = classNameFromTypeOrNew(m2.initializer);
                  if (init2) {
                    targetTypeName = init2;
                    declaringSf = curClassSf;
                    break;
                  }
                }
              }
              if (targetTypeName) break;
            }
          }
        }
        if (ts.isConstructorDeclaration(member)) {
          for (const param of member.parameters) {
            if (
              ts.isIdentifier(param.name) &&
              param.name.text === thisPropName
            ) {
              injectTokenName = extractInjectDecoratorToken(param);
              const extracted = extractDeclaredTypeInfo(param.type);
              if (extracted) {
                targetTypeName = extracted.typeName;
                targetQualifier = extracted.qualifier;
                declaringSf = curClassSf;
                break;
              }
            }
          }
          if (targetTypeName || injectTokenName) break;

          if (member.body) {
            let assignedExpr: ts.Expression | null = null;
            const scan = (n: ts.Node) => {
              if (assignedExpr) return;
              if (
                ts.isBinaryExpression(n) &&
                n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(n.left) &&
                n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
                n.left.name.text === thisPropName
              ) {
                assignedExpr = n.right;
                return;
              }
              ts.forEachChild(n, scan);
            };
            scan(member.body);

            if (assignedExpr) {
              if (rawSubProps.length > 0) {
                const objSub = extractSubPropertyTargetFromObjectExpr(assignedExpr, rawSubProps);
                if (objSub) {
                  targetTypeName = objSub.targetName;
                  walkedObjectSubProps = objSub.walkedCount;
                  declaringSf = curClassSf;
                  break;
                }
              }
              const fromNew = classNameFromTypeOrNew(assignedExpr);
              if (fromNew) {
                targetTypeName = fromNew;
                declaringSf = curClassSf;
                break;
              }
              if (ts.isIdentifier(assignedExpr)) {
                const assignedIdent = (assignedExpr as ts.Identifier).text;
                const param = member.parameters.find(
                  (p) => ts.isIdentifier(p.name) && p.name.text === assignedIdent
                );
                if (param) {
                  injectTokenName = extractInjectDecoratorToken(param);
                  const extracted = extractDeclaredTypeInfo(param.type);
                  if (extracted) {
                    targetTypeName = extracted.typeName;
                    targetQualifier = extracted.qualifier;
                    declaringSf = curClassSf;
                    break;
                  }
                }
              }
            }
          }
        }
      }

      if (targetTypeName && curClass.typeParameters) {
        const tp = curClass.typeParameters.find((p) => p.name.text === targetTypeName);
        if (tp?.constraint) {
          const constraintInfo = extractDeclaredTypeInfo(tp.constraint);
          if (constraintInfo) {
            targetTypeName = constraintInfo.typeName;
            targetQualifier = constraintInfo.qualifier;
          }
        }
      }

      if (targetTypeName || injectTokenName) break;

      // Walk `extends BaseClass` heritage clause if `thisPropName` was not declared on `curClass`
      let nextClass: ts.ClassDeclaration | undefined;
      let nextSf: ts.SourceFile = curClassSf;
      for (const clause of curClass.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const exprType of clause.types) {
          if (!ts.isIdentifier(exprType.expression)) continue;
          const baseName = exprType.expression.text;
          const curIdx = getSourceFileDeclarationIndex(curClassSf);
          const sameFileBase = curIdx.classDeclsByName.get(baseName);
          if (sameFileBase) {
            nextClass = sameFileBase;
            nextSf = curClassSf;
            break;
          }
          const baseBind = findModuleBinding(curClassSf, baseName);
          if (baseBind) {
            const resolvedBasePath = resolveModulePath(
              baseBind.moduleSpecifier,
              curClassSf.fileName,
              repoRoot,
              workspaceRegistry
            );
            if (resolvedBasePath) {
              const baseSf = getCachedSourceFile(path.resolve(repoRoot, resolvedBasePath));
              if (baseSf) {
                const baseLookup =
                  baseBind.importedName && baseBind.importedName !== '*'
                    ? baseBind.importedName
                    : baseName;
                const foundBase = findClassDeclInModuleOrReexports(
                  baseSf,
                  baseLookup,
                  repoRoot,
                  workspaceRegistry
                );
                if (foundBase) {
                  nextClass = foundBase.cls;
                  nextSf = foundBase.sf;
                  break;
                }
              }
            }
          }
        }
        if (nextClass) break;
      }
      curClass = nextClass;
      curClassSf = nextSf;
    }
  }

  if (!targetTypeName) {
    targetTypeName = classOfThisProperty(thisPropName, call);
  }
  if (!targetTypeName) {
    targetTypeName = findNewClassForPropertyInFile(thisPropName, sourceFile);
  }
  if (!targetTypeName && !injectTokenName) return undefined;

  if (
    targetTypeName === 'Promise' &&
    (methodName === 'then' || methodName === 'catch' || methodName === 'finally') &&
    enclosingClass?.name
  ) {
    const relFile = relativeFilePath(sourceFile, repoRoot);
    const classScope = resolveLogicalBoundaryScope(
      relFile,
      repoRoot,
      workspaceRegistry,
      findEnclosingNamespaceScope(enclosingClass)
    );
    const cbThisMethod = extractFirstThisMethodFromCallbackArg(call.arguments[0]);
    if (cbThisMethod && findPublicMethodOnClass(enclosingClass, cbThisMethod) !== null) {
      return contractEntityId(
        classScope,
        relFile,
        publicMethodName(enclosingClass.name.text, cbThisMethod),
        'contract.public-method'
      );
    }
    return boundaryEntityId(classScope, relFile, `Class: ${enclosingClass.name.text}`);
  }

  if (targetTypeName) {
    // External package target via qualifier (e.g. `express.Router`)
    if (
      !options?.localOnly &&
      targetQualifier &&
      !BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName)
    ) {
      const qualBinding =
        findModuleBinding(declaringSf, targetQualifier) ?? findModuleBinding(sourceFile, targetQualifier);
      if (
        qualBinding &&
        isExternalSpecifier(qualBinding.moduleSpecifier, declaringSf.fileName, repoRoot, workspaceRegistry)
      ) {
        return packageConnectorId(qualBinding.moduleSpecifier);
      }
    }

    // External package target via type binding (e.g. `Router` from 'express')
    const binding =
      findModuleBinding(declaringSf, targetTypeName) ?? findModuleBinding(sourceFile, targetTypeName);
    if (
      !options?.localOnly &&
      binding &&
      !BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName) &&
      isExternalSpecifier(binding.moduleSpecifier, declaringSf.fileName, repoRoot, workspaceRegistry)
    ) {
      return packageConnectorId(binding.moduleSpecifier);
    }

    const subProps = walkedObjectSubProps > 0 ? rawSubProps.slice(walkedObjectSubProps) : [...rawSubProps];
    const sfIndex = getSourceFileDeclarationIndex(declaringSf);
    let walkedInterfaceChain = false;
    let lastWalkedSf: ts.SourceFile = declaringSf;

    if (subProps.length > 0) {
      let curTypeName = targetTypeName;
      let curSf: ts.SourceFile | null = declaringSf;
      let walkedIface = 0;
      for (const subProp of subProps) {
        if (!curSf) break;
        let curIdx = getSourceFileDeclarationIndex(curSf);
        let propMap = curIdx.interfacePropsByName.get(curTypeName);
        if (!propMap) {
          const curBinding = findModuleBinding(curSf, curTypeName);
          if (curBinding) {
            const resolvedIfacePath = resolveModulePath(
              curBinding.moduleSpecifier,
              curSf.fileName,
              repoRoot,
              workspaceRegistry
            );
            if (resolvedIfacePath) {
              const targetIfaceSf = getCachedSourceFile(path.resolve(repoRoot, resolvedIfacePath));
              if (targetIfaceSf) {
                const lookup =
                  curBinding.importedName && curBinding.importedName !== '*'
                    ? curBinding.importedName
                    : curTypeName;
                curSf = targetIfaceSf;
                curIdx = getSourceFileDeclarationIndex(curSf);
                propMap = curIdx.interfacePropsByName.get(lookup);
              }
            }
          }
        }
        if (!propMap) break;
        const nextPropInfo = propMap.get(subProp);
        if (!nextPropInfo) break;
        curTypeName = nextPropInfo.typeName;
        if (curIdx.typeAliasesByName.has(curTypeName) && !curIdx.interfacePropsByName.has(curTypeName)) {
          const aliasType = curIdx.typeAliasesByName.get(curTypeName)!;
          curTypeName = classNameFromTypeOrNew(aliasType) ?? typeRefRootIdentifier(aliasType) ?? curTypeName;
        }
        lastWalkedSf = curSf;
        walkedIface++;
      }
      if (walkedIface > 0) {
        targetTypeName = curTypeName;
        subProps.splice(0, walkedIface);
        walkedInterfaceChain = true;
      }
    }

    const innerCallMethodName = options?.innerCallMethodName;
    const candidateMethods = [
      ...(subProps.length > 0 ? [`${subProps.join('.')}.${methodName}`] : []),
      methodName,
      ...(innerCallMethodName && !BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName)
        ? [innerCallMethodName]
        : []),
    ];

    // Same-file class declaration (in `declaringSf` or `sourceFile`)
    const localClass =
      sfIndex.classDeclsByName.get(targetTypeName) ??
      (declaringSf !== sourceFile
        ? getSourceFileDeclarationIndex(sourceFile).classDeclsByName.get(targetTypeName)
        : undefined);
    const localClassSf = sfIndex.classDeclsByName.has(targetTypeName) ? declaringSf : sourceFile;
    if (localClass && localClass.name) {
      for (const candMethod of candidateMethods) {
        const classResolved = findClassMethodWithInheritance(
          localClass,
          candMethod,
          localClassSf,
          repoRoot,
          workspaceRegistry
        );
        if (classResolved) return classResolved.targetId;
      }
      if (subProps.length > 0) {
        const subResolved = resolveSubPropertyOnClass(
          localClass,
          localClassSf,
          subProps[0],
          methodName,
          repoRoot,
          workspaceRegistry,
          options?.localOnly
        );
        if (subResolved) return subResolved;
      }
      if (
        !options?.localOnly &&
        (subProps.length > 0 || innerCallMethodName) &&
        !BUILTIN_VALUE_PROTOTYPE_METHODS.has(methodName)
      ) {
        const relFile = relativeFilePath(localClassSf, repoRoot);
        const classScope = resolveLogicalBoundaryScope(
          relFile,
          repoRoot,
          workspaceRegistry,
          findEnclosingNamespaceScope(localClass)
        );
        return boundaryEntityId(classScope, relFile, `Class: ${localClass.name.text}`);
      }
    }

    // Imported class declaration
    const refreshedBinding =
      findModuleBinding(declaringSf, targetTypeName) ??
      findModuleBinding(sourceFile, targetTypeName) ??
      binding;
    const bindingSf = findModuleBinding(declaringSf, targetTypeName) ? declaringSf : sourceFile;
    if (refreshedBinding) {
      const resolvedPath = resolveModulePath(
        refreshedBinding.moduleSpecifier,
        bindingSf.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedPath) {
        const lookupSymbol =
          refreshedBinding.importedName && refreshedBinding.importedName !== '*'
            ? refreshedBinding.importedName
            : targetTypeName;
        for (const candMethod of candidateMethods) {
          const resolved = resolveClassMethodInModule(
            resolvedPath,
            lookupSymbol,
            candMethod,
            repoRoot,
            workspaceRegistry
          );
          if (resolved) return resolved.targetId;
        }

        // Follow inheritance, barrel re-exports, or sub-properties in the target module if direct method not found
        const targetAbs = path.resolve(repoRoot, resolvedPath);
        const targetSf = getCachedSourceFile(targetAbs);
        if (targetSf) {
          const foundTargetClass = findClassDeclInModuleOrReexports(
            targetSf,
            lookupSymbol,
            repoRoot,
            workspaceRegistry
          );
          if (foundTargetClass && foundTargetClass.cls.name) {
            const targetClass = foundTargetClass.cls;
            const targetClassName = foundTargetClass.cls.name.text;
            const resolvedClassSf = foundTargetClass.sf;
            const resolvedClassRel = relativeFilePath(resolvedClassSf, repoRoot);
            for (const candMethod of candidateMethods) {
              const classResolved = findClassMethodWithInheritance(
                targetClass,
                candMethod,
                resolvedClassSf,
                repoRoot,
                workspaceRegistry
              );
              if (classResolved) return classResolved.targetId;
            }
            if (subProps.length > 0) {
              const subResolved = resolveSubPropertyOnClass(
                targetClass,
                resolvedClassSf,
                subProps[0],
                methodName,
                repoRoot,
                workspaceRegistry,
                options?.localOnly
              );
              if (subResolved) return subResolved;
            }
            if (
              !options?.localOnly &&
              (subProps.length > 0 || innerCallMethodName) &&
              !BUILTIN_VALUE_PROTOTYPE_METHODS.has(methodName)
            ) {
              const classScope = resolveLogicalBoundaryScope(
                resolvedClassRel,
                repoRoot,
                workspaceRegistry,
                findEnclosingNamespaceScope(targetClass)
              );
              return boundaryEntityId(classScope, resolvedClassRel, `Class: ${targetClassName}`);
            }
          }
          // Check if `lookupSymbol` is an interface or abstract base class with concrete implementations
          for (const candMethod of candidateMethods) {
            const viaIface = resolveInterfaceMethodImplementationTarget(
              lookupSymbol,
              candMethod,
              targetSf,
              sourceFile,
              repoRoot,
              workspaceRegistry,
              Boolean(options?.localOnly)
            );
            if (viaIface) return viaIface;
          }
        }
      }
    }

    // Same-file or workspace interface implementation fallback (`this.manager.readResource()`)
    for (const candMethod of candidateMethods) {
      const viaIface = resolveInterfaceMethodImplementationTarget(
        targetTypeName,
        candMethod,
        lastWalkedSf,
        sourceFile,
        repoRoot,
        workspaceRegistry,
        Boolean(options?.localOnly)
      );
      if (viaIface) return viaIface;
    }

    if (
      walkedInterfaceChain &&
      !options?.localOnly &&
      !options?.innerCallMethodName &&
      !BUILTIN_VALUE_PROTOTYPE_METHODS.has(methodName) &&
      !BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName) &&
      enclosingClass?.name
    ) {
      let inPublicMethod = false;
      let p: ts.Node | undefined = call.parent;
      while (p && p !== enclosingClass) {
        if (
          (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p)) &&
          p.parent === enclosingClass &&
          findPublicMethodOnClass(
            enclosingClass,
            p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : ''
          ) !== null
        ) {
          inPublicMethod = true;
          break;
        }
        p = p.parent;
      }
      if (inPublicMethod) {
        const walkedIdx = getSourceFileDeclarationIndex(lastWalkedSf);
        if (walkedIdx.interfacePropsByName.has(targetTypeName) || sfIndex.interfacePropsByName.has(targetTypeName)) {
          const relFile = relativeFilePath(sourceFile, repoRoot);
          const classScope = resolveLogicalBoundaryScope(
            relFile,
            repoRoot,
            workspaceRegistry,
            findEnclosingNamespaceScope(enclosingClass)
          );
          return boundaryEntityId(classScope, relFile, `Class: ${enclosingClass.name.text}`);
        }
      }
    }
  }

  // Fallback: NestJS custom provider binding (`{ provide: TokenOrInterface, useClass: ConcreteAdapter }`)
  const providerTokens = new Set<string>();
  if (targetTypeName) providerTokens.add(targetTypeName);
  if (injectTokenName) providerTokens.add(injectTokenName);
  if (providerTokens.size > 0) {
    const providerResolved = resolveNestProviderMethodTarget(
      providerTokens,
      methodName,
      sourceFile,
      repoRoot,
      workspaceRegistry
    );
    if (providerResolved) return providerResolved;
  }

  return undefined;
}

function findDecoratedPropertyClassInSourceFile(
  sf: ts.SourceFile,
  propName: string
): string | null {
  let matchedClass: string | null = null;
  const sfIdx = getSourceFileDeclarationIndex(sf);
  const walk = (n: ts.Node) => {
    if (matchedClass) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === 'decorate' || n.expression.name.text === 'decorateRequest') &&
      n.arguments.length >= 2 &&
      ts.isStringLiteral(n.arguments[0]) &&
      n.arguments[0].text === propName
    ) {
      const valArg = unwrapTransparentExpr(n.arguments[1]);
      const fromNew = classNameFromTypeOrNew(valArg);
      if (fromNew) {
        matchedClass = fromNew;
        return;
      }
      if (ts.isIdentifier(valArg)) {
        matchedClass =
          sfIdx.classByIdentifier.get(valArg.text) ??
          sfIdx.newClassByPropName.get(valArg.text) ??
          valArg.text;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return matchedClass;
}

function resolveDecoratedInstancePropertyMethodTarget(
  propName: string,
  methodName: string,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): string | undefined {
  const candidateFiles: ts.SourceFile[] = [sourceFile];
  try {
    const dir = path.dirname(sourceFile.fileName);
    const parentDir = path.dirname(dir);
    for (const searchDir of [dir, parentDir]) {
      if (!searchDir || !fs.existsSync(searchDir)) continue;
      for (const entry of fs.readdirSync(searchDir, { withFileTypes: true })) {
        if (entry.isFile() && /\.[tj]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          const sf = getCachedSourceFile(path.join(searchDir, entry.name));
          if (sf && sf !== sourceFile && !candidateFiles.includes(sf)) candidateFiles.push(sf);
        } else if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'test') {
          const subDir = path.join(searchDir, entry.name);
          for (const subEntry of fs.readdirSync(subDir, { withFileTypes: true })) {
            if (subEntry.isFile() && /^index\.[tj]sx?$/.test(subEntry.name)) {
              const sf = getCachedSourceFile(path.join(subDir, subEntry.name));
              if (sf && sf !== sourceFile && !candidateFiles.includes(sf)) candidateFiles.push(sf);
            }
          }
        }
      }
    }
  } catch {
    // Ignore fs errors on synthetic paths
  }

  for (const modSf of candidateFiles) {
    const decoratedClass = findDecoratedPropertyClassInSourceFile(modSf, propName);
    if (!decoratedClass) continue;
    const modIndex = getSourceFileDeclarationIndex(modSf);
    const localImpl = modIndex.classDeclsByName.get(decoratedClass);
    if (localImpl && localImpl.name) {
      const res = findClassMethodWithInheritance(
        localImpl,
        methodName,
        modSf,
        repoRoot,
        workspaceRegistry
      );
      if (res) return res.targetId;
    }
    const implBinding = findModuleBinding(modSf, decoratedClass);
    if (implBinding) {
      const resolvedImplPath = resolveModulePath(
        implBinding.moduleSpecifier,
        modSf.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedImplPath) {
        const lookup =
          implBinding.importedName && implBinding.importedName !== '*'
            ? implBinding.importedName
            : decoratedClass;
        const resolved = resolveClassMethodInModule(
          resolvedImplPath,
          lookup,
          methodName,
          repoRoot,
          workspaceRegistry
        );
        if (resolved) return resolved.targetId;
      }
    }
  }
  return undefined;
}

/**
 * Resolves `receiver.method()` to the PUBLIC_METHOD or CommonJS prototype/export contract it invokes
 * when the receiver's class or prototype is deterministically proven by the AST.
 */
export function resolvePublicMethodTarget(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  options?: { localOnly?: boolean; overrideMethodName?: string }
): string | undefined {
  const access = getPropertyOrElementAccess(call.expression);
  if (!access) return undefined;
  const methodName = options?.overrideMethodName ?? access.memberName;
  let receiver = unwrapTransparentExpr(access.expression);
  let innerCallExpr: ts.CallExpression | null = null;
  let innerCallMethodName: string | undefined;
  const subPropsAfterRoot: string[] = [];

  for (;;) {
    receiver = unwrapTransparentExpr(receiver);
    if (ts.isCallExpression(receiver)) {
      if (
        subPropsAfterRoot.length === 0 &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        ts.isIdentifier(receiver.expression.expression) &&
        /^[A-Z]/.test(receiver.expression.expression.text) &&
        resolveFactoryCallClass(receiver, sourceFile, repoRoot, workspaceRegistry) !== null
      ) {
        break;
      }
      const innerAccess = getPropertyOrElementAccess(receiver.expression);
      if (!innerAccess) break;
      innerCallExpr = receiver;
      innerCallMethodName = innerAccess.memberName;
      receiver = unwrapTransparentExpr(innerAccess.expression);
      continue;
    }
    if (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) {
      const innerExpr = unwrapTransparentExpr(receiver.expression);
      const isDirectThisProp =
        innerExpr.kind === ts.SyntaxKind.ThisKeyword ||
        (ts.isIdentifier(innerExpr) && findLocalThisPropertyAlias(innerExpr.text, call) === 'this');
      if (isDirectThisProp) {
        break;
      }
      const propOrElem = getPropertyOrElementAccess(receiver);
      if (propOrElem) {
        subPropsAfterRoot.unshift(propOrElem.memberName);
        receiver = innerExpr;
        continue;
      }
      if (ts.isElementAccessExpression(receiver)) {
        subPropsAfterRoot.unshift('*');
        receiver = innerExpr;
        continue;
      }
    }
    break;
  }

  // 1. Direct `this.method()` or `this.#helper().prop.method()` or local `var self = this; self.method()`
  const isThisReceiver =
    receiver.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isIdentifier(receiver) && findLocalThisPropertyAlias(receiver.text, call) === 'this');
  if (isThisReceiver && (subPropsAfterRoot.length === 0 || Boolean(innerCallMethodName))) {
    let cls: ts.Node | undefined = call;
    while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
    const candidateThisMethods = [
      ...(subPropsAfterRoot.length === 0 ? [methodName] : []),
      ...(innerCallMethodName && !BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName)
        ? [innerCallMethodName]
        : []),
    ];
    if (cls && ts.isClassDeclaration(cls) && cls.name) {
      for (const candMethod of candidateThisMethods) {
        if (
          candMethod === innerCallMethodName &&
          candMethod !== methodName &&
          resolveExternalPackageTarget(call.expression, sourceFile, repoRoot, workspaceRegistry)
        ) {
          continue;
        }
        if (findPublicMethodOnClass(cls, candMethod) !== null) {
          const relFile = relativeFilePath(sourceFile, repoRoot);
          const classScope = resolveLogicalBoundaryScope(relFile, repoRoot, workspaceRegistry);
          return contractEntityId(
            classScope,
            relFile,
            publicMethodName(cls.name.text, candMethod),
            'contract.public-method'
          );
        }
        const inherited = findClassMethodWithInheritance(
          cls,
          candMethod,
          sourceFile,
          repoRoot,
          workspaceRegistry
        );
        if (inherited) return inherited.targetId;
      }
    }
    if (!requireGetAccessorOnly) {
      for (const candMethod of candidateThisMethods) {
        const sameFileCjs = resolveCjsContractInSourceFile(
          sourceFile,
          candMethod,
          relativeFilePath(sourceFile, repoRoot),
          repoRoot,
          workspaceRegistry
        );
        if (sameFileCjs) return sameFileCjs.targetId;
      }
    }
  }

  // 2. `this.<prop>.method()` or `var x = this.<prop>; x.method()` onto a sibling prototype (`app`, `req`, `res`, `parent`)
  let thisPropName: string | null = null;
  const receiverAccess = getPropertyOrElementAccess(receiver);
  if (
    receiverAccess &&
    (receiverAccess.expression.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isIdentifier(receiverAccess.expression) &&
        findLocalThisPropertyAlias(receiverAccess.expression.text, call) === 'this'))
  ) {
    thisPropName = receiverAccess.memberName;
  } else if (ts.isIdentifier(receiver)) {
    const alias = findLocalThisPropertyAlias(receiver.text, call);
    if (alias && alias !== 'this') thisPropName = alias;
  }
  if (!requireGetAccessorOnly && thisPropName === 'parent' && subPropsAfterRoot.length === 0) {
    const sameFileCjs = resolveCjsContractInSourceFile(
      sourceFile,
      methodName,
      relativeFilePath(sourceFile, repoRoot),
      repoRoot,
      workspaceRegistry
    );
    if (sameFileCjs) return sameFileCjs.targetId;
  } else if (
    !requireGetAccessorOnly &&
    thisPropName &&
    subPropsAfterRoot.length === 0 &&
    Object.hasOwn(EXPRESS_SIBLING_MODULES, thisPropName)
  ) {
    const siblingRel = resolveModulePath(
      EXPRESS_SIBLING_MODULES[thisPropName],
      sourceFile.fileName,
      repoRoot,
      workspaceRegistry
    );
    if (siblingRel) {
      const siblingSf = getCachedSourceFile(path.resolve(repoRoot, siblingRel));
      if (siblingSf) {
        const siblingCjs = resolveCjsContractInSourceFile(
          siblingSf,
          methodName,
          siblingRel,
          repoRoot,
          workspaceRegistry
        );
        if (siblingCjs) return siblingCjs.targetId;
      }
    }
  } else if (thisPropName) {
    const thisPropTarget = resolveThisPropertyMethodTarget(
      thisPropName,
      methodName,
      call,
      sourceFile,
      repoRoot,
      workspaceRegistry,
      {
        ...options,
        subProps: subPropsAfterRoot,
        innerCallMethodName,
      }
    );
    if (thisPropTarget) return thisPropTarget;
  }

  let className: string | null = null;
  let classFile: string | undefined;

  if (ts.isNewExpression(receiver)) {
    className = classNameFromTypeOrNew(receiver);
  } else if (ts.isCallExpression(receiver)) {
    className = classNameFromTypeOrNew(receiver);
    if (!className) {
      const factoryResolved = resolveFactoryCallClass(receiver, sourceFile, repoRoot, workspaceRegistry);
      if (factoryResolved) {
        className = factoryResolved.className;
        classFile = factoryResolved.classFile;
      }
    }
  } else if (ts.isIdentifier(receiver)) {
    if (subPropsAfterRoot.length > 0) {
      const compoundPropClass = findNewClassForPropertyInFile(
        `${receiver.text}.${subPropsAfterRoot[0]}`,
        sourceFile
      );
      if (compoundPropClass) {
        className = compoundPropClass;
        subPropsAfterRoot.shift();
      }
    }
    if (!className) {
      className = classOfIdentifier(receiver.text, sourceFile);
    }
    if (!className) {
      const factoryResolved = factoryClassOfIdentifier(receiver.text, sourceFile, repoRoot, workspaceRegistry);
      if (factoryResolved) {
        className = factoryResolved.className;
        classFile = factoryResolved.classFile;
      }
    }
    if (!className) {
      const classMethodResolved = resolveClassMethodTargetWithEvidence(
        call,
        sourceFile,
        repoRoot,
        workspaceRegistry
      );
      if (classMethodResolved) return classMethodResolved.targetId;
      if (innerCallExpr) {
        const innerClassMethodResolved = resolveClassMethodTargetWithEvidence(
          innerCallExpr,
          sourceFile,
          repoRoot,
          workspaceRegistry
        );
        if (innerClassMethodResolved) return innerClassMethodResolved.targetId;
      }
    }
  } else if (receiverAccess && receiverAccess.expression.kind === ts.SyntaxKind.ThisKeyword) {
    className = classOfThisProperty(receiverAccess.memberName, call);
  }
  if (!className && subPropsAfterRoot.length === 0 && !innerCallExpr) {
    className = classNameFromTypeOrNew(access.expression);
  }
  if (!className && ts.isIdentifier(receiver) && subPropsAfterRoot.length > 0 && !options?.localOnly) {
    const decoratedTarget = resolveDecoratedInstancePropertyMethodTarget(
      subPropsAfterRoot[0],
      methodName,
      sourceFile,
      repoRoot,
      workspaceRegistry
    );
    if (decoratedTarget) return decoratedTarget;
  }
  if (!className) return undefined;

  if (subPropsAfterRoot.length > 0 && !classFile) {
    // Walk interface / object-type-alias sub-property chain (`item: PendingResource` -> `item.handler.provision()`)
    let curTypeName = className;
    let curSf: ts.SourceFile | null = sourceFile;
    let walkedCount = 0;
    for (const subProp of subPropsAfterRoot) {
      if (!curSf) break;
      let curIdx = getSourceFileDeclarationIndex(curSf);
      let propMap = curIdx.interfacePropsByName.get(curTypeName);
      if (!propMap) {
        const binding = findModuleBinding(curSf, curTypeName);
        if (binding) {
          const resolvedIfacePath = resolveModulePath(
            binding.moduleSpecifier,
            curSf.fileName,
            repoRoot,
            workspaceRegistry
          );
          if (resolvedIfacePath) {
            const targetSf = getCachedSourceFile(path.resolve(repoRoot, resolvedIfacePath));
            if (targetSf) {
              const lookup =
                binding.importedName && binding.importedName !== '*'
                  ? binding.importedName
                  : curTypeName;
              curSf = targetSf;
              curIdx = getSourceFileDeclarationIndex(curSf);
              propMap = curIdx.interfacePropsByName.get(lookup);
            }
          }
        }
      }
      if (!propMap) break;
      const nextPropInfo = propMap.get(subProp);
      if (!nextPropInfo) break;
      curTypeName = nextPropInfo.typeName;
      if (curIdx.typeAliasesByName.has(curTypeName) && !curIdx.interfacePropsByName.has(curTypeName)) {
        const aliasType = curIdx.typeAliasesByName.get(curTypeName)!;
        curTypeName = classNameFromTypeOrNew(aliasType) ?? typeRefRootIdentifier(aliasType) ?? curTypeName;
      }
      walkedCount++;
    }
    if (walkedCount > 0 && curSf) {
      className = curTypeName;
      subPropsAfterRoot.splice(0, walkedCount);
      const curIdx = getSourceFileDeclarationIndex(curSf);
      if (curIdx.topLevelClassNames.has(className)) {
        classFile = relativeFilePath(curSf, repoRoot);
      } else {
        const binding = findModuleBinding(curSf, className);
        if (binding) {
          const resolved = resolveModulePath(binding.moduleSpecifier, curSf.fileName, repoRoot, workspaceRegistry);
          if (resolved) {
            const lookupSymbol =
              binding.importedName && binding.importedName !== '*'
                ? binding.importedName
                : className;
            const candMethod =
              subPropsAfterRoot.length > 0 ? `${subPropsAfterRoot.join('.')}.${methodName}` : methodName;
            const viaModule = resolveClassMethodInModule(
              resolved,
              lookupSymbol,
              candMethod,
              repoRoot,
              workspaceRegistry
            );
            if (viaModule) return viaModule.targetId;
            classFile = resolved;
          }
        }
      }
    }
  }

  const candidateMethods = [
    ...(subPropsAfterRoot.length > 0 ? [`${subPropsAfterRoot.join('.')}.${methodName}`] : [methodName]),
    ...(innerCallMethodName && !BUILTIN_PRIMITIVE_OR_ARRAY_ONLY_METHODS.has(methodName)
      ? [innerCallMethodName]
      : []),
  ];

  if (!classFile) {
    // Class declared in this very file?
    const declaredHere = getSourceFileDeclarationIndex(sourceFile).topLevelClassNames.has(className);
    if (declaredHere) {
      classFile = relativeFilePath(sourceFile, repoRoot);
    } else {
      const binding = findModuleBinding(sourceFile, className);
      if (binding) {
        const resolved = resolveModulePath(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry) ?? undefined;
        if (resolved) {
          const lookupSymbol =
            binding.importedName && binding.importedName !== '*'
              ? binding.importedName
              : className;
          for (const candMethod of candidateMethods) {
            const viaModule = resolveClassMethodInModule(
              resolved,
              lookupSymbol,
              candMethod,
              repoRoot,
              workspaceRegistry
            );
            if (viaModule) return viaModule.targetId;
          }
          classFile = resolved;
        }
      }
    }
  }
  if (!classFile) {
    for (const candMethod of candidateMethods) {
      const viaIface = resolveInterfaceMethodImplementationTarget(
        className,
        candMethod,
        sourceFile,
        sourceFile,
        repoRoot,
        workspaceRegistry,
        Boolean(options?.localOnly)
      );
      if (viaIface) return viaIface;
    }
    return undefined;
  }

  const currentRelFile = relativeFilePath(sourceFile, repoRoot);
  const classSf =
    classFile === currentRelFile ? sourceFile : getCachedSourceFile(path.resolve(repoRoot, classFile));
  const classScope = resolveLogicalBoundaryScope(classFile, repoRoot, workspaceRegistry);
  if (classSf) {
    const sfIdx = getSourceFileDeclarationIndex(classSf);
    const classMethods = sfIdx.publicMethodsByClass.get(className);
    const foundCls = findClassDeclInModuleOrReexports(classSf, className, repoRoot, workspaceRegistry);
    const clsDecl = foundCls?.cls ?? sfIdx.classDeclsByName.get(className);
    const clsDeclSf = foundCls?.sf ?? classSf;
    for (const candMethod of candidateMethods) {
      if (classMethods && classMethods.has(candMethod)) {
        if (clsDecl) {
          const matchedMember = findPublicMethodOnClass(clsDecl, candMethod);
          if (requireGetAccessorOnly && !matchedMember) continue;
          if (
            options?.localOnly &&
            !requireGetAccessorOnly &&
            matchedMember &&
            ts.isGetAccessorDeclaration(matchedMember)
          ) {
            continue;
          }
        } else if (requireGetAccessorOnly) {
          continue;
        }
        return contractEntityId(
          classScope,
          classFile,
          publicMethodName(className, candMethod),
          'contract.public-method'
        );
      }
    }
    if (clsDecl && clsDecl.name) {
      for (const candMethod of candidateMethods) {
        const inherited = findClassMethodWithInheritance(
          clsDecl,
          candMethod,
          clsDeclSf,
          repoRoot,
          workspaceRegistry,
          new Set(),
          Boolean(options?.localOnly) ||
            (!innerCallMethodName && subPropsAfterRoot.length === 0 && !requireGetAccessorOnly)
        );
        if (inherited) return inherited.targetId;
      }
      if (subPropsAfterRoot.length === 1) {
        const subResolved = resolveSubPropertyOnClass(
          clsDecl,
          clsDeclSf,
          subPropsAfterRoot[0],
          methodName,
          repoRoot,
          workspaceRegistry,
          options?.localOnly
        );
        if (subResolved) return subResolved;
      }
    }
    if (clsDecl && clsDecl.name) {
      const hasMatchingNonPublicMember =
        subPropsAfterRoot.length === 0 &&
        clsDecl.members.some(
          (m) =>
            (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isGetAccessorDeclaration(m)) &&
            Boolean(m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) && m.name.text === methodName)
        );
      if (
        subPropsAfterRoot.length === 0 &&
        (Boolean(innerCallMethodName) || hasMatchingNonPublicMember) &&
        !options?.localOnly &&
        !BUILTIN_VALUE_PROTOTYPE_METHODS.has(methodName)
      ) {
        return boundaryEntityId(classScope, classFile, `Class: ${clsDecl.name.text}`);
      }
    }
    for (const candMethod of candidateMethods) {
      const viaIface = resolveInterfaceMethodImplementationTarget(
        className,
        candMethod,
        classSf,
        sourceFile,
        repoRoot,
        workspaceRegistry,
        Boolean(options?.localOnly)
      );
      if (viaIface) return viaIface;
    }
    return undefined;
  }

  if (requireGetAccessorOnly) return undefined;

  return contractEntityId(
    classScope,
    classFile,
    publicMethodName(className, methodName),
    'contract.public-method'
  );
}

/**
 * Resolves a property read (`receiver.prop`) to a `PUBLIC_METHOD` contract when the receiver's class
 * deterministically declares a `get prop()` `GetAccessorDeclaration`.
 */
export function resolveGetterAccessorTarget(
  access: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): string | undefined {
  const propName = access.name.text;
  if (
    BUILTIN_VALUE_PROTOTYPE_METHODS.has(propName) ||
    propName === 'length' ||
    propName === 'prototype' ||
    propName === 'name' ||
    propName === 'constructor'
  ) {
    return undefined;
  }
  const syntheticCall = ts.factory.createCallExpression(access, undefined, []);
  (syntheticCall as { parent?: ts.Node }).parent = access.parent;
  const prev = requireGetAccessorOnly;
  requireGetAccessorOnly = true;
  try {
    return (
      resolvePublicMethodTarget(syntheticCall, sourceFile, repoRoot, workspaceRegistry, {
        localOnly: true,
      }) ??
      resolveClassMethodTargetWithEvidence(
        syntheticCall,
        sourceFile,
        repoRoot,
        workspaceRegistry
      )?.targetId
    );
  } finally {
    requireGetAccessorOnly = prev;
  }
}

/**
 * Resolves the target of an Express router mount (`app.use('/api', apiRouter)`) to the Contract the
 * mounted module exports, when the AST proves where the router came from.
 *
 * @example
 * const apiRouter = require('./routes/api');   // routes/api.js: module.exports = router;
 * app.use('/api', apiRouter);                  // → CJS Export: default (in routes/api.js)
 *
 * import apiRouter from './routes/api';        // routes/api.ts: export default router;
 * app.use('/api', apiRouter);                  // → Module Export (Default)
 *
 * @param call              The `app.use(...)` call expression.
 * @param sourceFile        Source file containing the mount.
 * @param repoRoot          Analysis root used to compute repo-relative ids.
 * @param workspaceRegistry Optional workspace registry for cross-package mounts.
 * @returns The deterministic exported-contract id, or undefined when the mounted module is not proven.
 */
export function resolveRouterMountTarget(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): string | undefined {
  const first = call.arguments[0];
  let hasPrefix = false;
  if (first && call.arguments.length >= 2) {
    if (
      ts.isStringLiteral(first) ||
      ts.isRegularExpressionLiteral(first) ||
      ts.isNoSubstitutionTemplateLiteral(first) ||
      ts.isTemplateExpression(first)
    ) {
      hasPrefix = true;
    } else if (ts.isIdentifier(first) || ts.isPropertyAccessExpression(first)) {
      const firstText = first.getText(sourceFile);
      if (/path|prefix|url|base|pattern/i.test(firstText) || /^(?:route|endpoint)$/i.test(firstText)) {
        hasPrefix = true;
      }
    }
  }
  let mounted: ts.Expression | undefined = hasPrefix ? call.arguments[1] : first;
  if (hasPrefix && call.arguments.length >= 3) {
    const lastArg = call.arguments[call.arguments.length - 1];
    if (
      ts.isIdentifier(lastArg) &&
      (/(?:router|routes|controller|api)$/i.test(lastArg.text) ||
        lastArg.text.toLowerCase().includes('router'))
    ) {
      mounted = lastArg;
    }
  }
  if (!mounted) return undefined;

  let specifier: string | undefined;
  let kind: 'import' | 'require' | undefined;
  let importedName: string | undefined;

  if (ts.isIdentifier(mounted)) {
    const binding = findValueModuleBinding(sourceFile, mounted.text);
    if (binding) {
      ({ moduleSpecifier: specifier, kind, importedName } = binding);
    } else {
      const isExportedSameFileRouter = sourceFile.statements.some((s) => {
        if (!ts.isVariableStatement(s)) return false;
        const hasExport = Boolean(
          s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        );
        if (!hasExport) return false;
        return s.declarationList.declarations.some(
          (d) =>
            ts.isIdentifier(d.name) &&
            d.name.text === mounted.text &&
            Boolean(d.initializer && isRouterFactoryInitializer(d.initializer))
        );
      });
      if (isExportedSameFileRouter) {
        const relFile = path.relative(repoRoot, sourceFile.fileName).replace(/\\/g, '/');
        const localScope = resolveLogicalBoundaryScope(relFile, repoRoot, workspaceRegistry);
        return contractEntityId(
          localScope,
          relFile,
          `Exported Module: ${mounted.text}`,
          'contract.exported-module'
        );
      }
    }
  } else if (ts.isCallExpression(mounted) && ts.isIdentifier(mounted.expression)) {
    const binding = findValueModuleBinding(sourceFile, mounted.expression.text);
    if (binding) ({ moduleSpecifier: specifier, kind, importedName } = binding);
  } else {
    const req = unwrapRequire(mounted);
    if (req && !req.member) {
      specifier = req.specifier;
      kind = 'require';
      importedName = '*';
    } else if (req && req.member) {
      specifier = req.specifier;
      kind = 'require';
      importedName = req.member;
    }
  }
  if (!specifier || !kind) return undefined;

  const resolvedPath = resolveModulePath(specifier, sourceFile.fileName, repoRoot, workspaceRegistry);
  if (!resolvedPath) return undefined;

  const targetScope = resolveLogicalBoundaryScope(resolvedPath, repoRoot, workspaceRegistry);
  if (kind === 'require') {
    if (importedName && importedName !== '*' && importedName !== 'default') {
      const targetSf = getCachedSourceFile(path.resolve(repoRoot, resolvedPath));
      if (targetSf) {
        const cjsMatch = resolveCjsContractInSourceFile(
          targetSf,
          importedName,
          resolvedPath,
          repoRoot,
          workspaceRegistry
        );
        if (cjsMatch) return cjsMatch.targetId;
      }
      return cjsContractEntityId(targetScope, resolvedPath, `CJS Export: ${importedName}`);
    }
    return cjsContractEntityId(targetScope, resolvedPath, 'CJS Export: default');
  }
  if (kind === 'import') {
    const isRouterModuleVarInSourceFile = (
      sf: ts.SourceFile | null | undefined,
      ident: string
    ): boolean => {
      if (!sf) return false;
      return sf.statements.some(
        (s) =>
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.some(
            (d) =>
              ts.isIdentifier(d.name) &&
              d.name.text === ident &&
              Boolean(d.initializer && isRouterFactoryInitializer(d.initializer))
          )
      );
    };
    const contractIdForRouterIdent = (
      scope: string,
      relFile: string,
      sf: ts.SourceFile | null | undefined,
      ident: string
    ): string => {
      const isRouterModule = isRouterModuleVarInSourceFile(sf, ident);
      return contractEntityId(
        scope,
        relFile,
        isRouterModule ? `Exported Module: ${ident}` : `Exported Function: ${ident}`,
        isRouterModule ? 'contract.exported-module' : 'contract.exported-function'
      );
    };
    const targetSf = getCachedSourceFile(path.resolve(repoRoot, resolvedPath));
    if (importedName && importedName !== 'default' && importedName !== '*') {
      if (targetSf) {
        for (const stmt of targetSf.statements) {
          if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
            const subSpec = stmt.moduleSpecifier.text;
            if (!stmt.exportClause) {
              const subPath = resolveModulePath(subSpec, targetSf.fileName, repoRoot, workspaceRegistry);
              if (subPath) {
                const subScope = resolveLogicalBoundaryScope(subPath, repoRoot, workspaceRegistry);
                const subSf = getCachedSourceFile(path.resolve(repoRoot, subPath));
                return contractIdForRouterIdent(subScope, subPath, subSf, importedName);
              }
            } else if (ts.isNamedExports(stmt.exportClause)) {
              for (const el of stmt.exportClause.elements) {
                if (el.name.text === importedName) {
                  const orig = (el.propertyName ?? el.name).text;
                  const subPath = resolveModulePath(subSpec, targetSf.fileName, repoRoot, workspaceRegistry);
                  if (subPath) {
                    const subScope = resolveLogicalBoundaryScope(subPath, repoRoot, workspaceRegistry);
                    const subSf = getCachedSourceFile(path.resolve(repoRoot, subPath));
                    if (orig === 'default') {
                      if (subSf) {
                        for (const subStmt of subSf.statements) {
                          if (
                            ts.isExportAssignment(subStmt) &&
                            !subStmt.isExportEquals &&
                            ts.isIdentifier(subStmt.expression) &&
                            isRouterModuleVarInSourceFile(subSf, subStmt.expression.text)
                          ) {
                            return contractIdForRouterIdent(
                              subScope,
                              subPath,
                              subSf,
                              subStmt.expression.text
                            );
                          }
                        }
                      }
                      return contractEntityId(
                        subScope,
                        subPath,
                        'Module Export (Default)',
                        'contract.es6-export-default'
                      );
                    }
                    return contractIdForRouterIdent(subScope, subPath, subSf, orig);
                  }
                }
              }
            }
          }
        }
      }
      return contractIdForRouterIdent(targetScope, resolvedPath, targetSf, importedName);
    }
    if (importedName === 'default' && targetSf) {
      for (const stmt of targetSf.statements) {
        if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
          const defaultIdent = stmt.expression.text;
          const hasMatchingLocalCallable = targetSf.statements.some(
            (s) =>
              (ts.isVariableStatement(s) &&
                s.declarationList.declarations.some(
                  (d) =>
                    ts.isIdentifier(d.name) &&
                    d.name.text === defaultIdent &&
                    d.initializer !== undefined &&
                    (ts.isArrowFunction(d.initializer) ||
                      ts.isFunctionExpression(d.initializer) ||
                      ts.isCallExpression(d.initializer) ||
                      ts.isNewExpression(d.initializer))
                )) ||
              (ts.isFunctionDeclaration(s) && s.name?.text === defaultIdent)
          );
          if (hasMatchingLocalCallable) {
            return contractIdForRouterIdent(targetScope, resolvedPath, targetSf, defaultIdent);
          }
        }
      }
    }
    const lowerResolved = resolvedPath.toLowerCase();
    const isVueDefault = lowerResolved.endsWith('.vue');
    const isSvelteDefault = lowerResolved.endsWith('.svelte');
    return contractEntityId(
      targetScope,
      resolvedPath,
      isVueDefault
        ? deriveVueSfcComponentName(resolvedPath)
        : isSvelteDefault
          ? deriveSvelteComponentName(resolvedPath)
          : 'Module Export (Default)',
      isVueDefault
        ? 'contract.vue-sfc-script-setup'
        : isSvelteDefault
          ? 'contract.svelte-sfc-and-sveltekit-hooks'
          : 'contract.es6-export-default'
    );
  }
  return undefined;
}

/**
 * Returns true when `<rootId>.<memberName>(...)` targets a callable contract exported by a local
 * intra-repo module bound to `rootId` (e.g. `const db = require('./dbconn'); db.query(...)` where
 * `dbconn.js` defines `CJS Export: query`). Prevents open-connector allowlists (`DB_CLIENT_IDENTIFIERS`)
 * from shadowing intra-repo module contracts that happen to use a generic identifier like `db`.
 */
export function resolvesToLocalModuleCallableContract(
  rootId: string,
  memberName: string,
  sourceFile: ts.SourceFile,
  repoRoot?: string,
  workspaceRegistry?: WorkspaceRegistry
): boolean {
  if (!repoRoot) return false;
  const binding = findValueModuleBinding(sourceFile, rootId);
  if (!binding || isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
    return false;
  }
  const resolvedPath = resolveModulePath(
    binding.moduleSpecifier,
    sourceFile.fileName,
    repoRoot,
    workspaceRegistry
  );
  if (!resolvedPath) return false;
  const absTargetPath = path.resolve(repoRoot, resolvedPath);
  const targetSf = getCachedSourceFile(absTargetPath);
  if (!targetSf) return false;
  const cjsMatch = resolveCjsContractInSourceFile(
    targetSf,
    memberName,
    resolvedPath,
    repoRoot,
    workspaceRegistry,
    true
  );
  if (cjsMatch && cjsMatch.patternId === 'contract.commonjs-export') {
    return true;
  }
  return false;
}
