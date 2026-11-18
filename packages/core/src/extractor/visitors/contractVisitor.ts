// packages/core/src/extractor/visitors/contractVisitor.ts
// Visitor for CONTRACT primitives — explicit interfaces for inter-unit communication.

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { extractExpressRoute, extractExpressRouteParameter, extractExpressContentNegotiation, extractExpressDynamicMethods, extractExpressMiddlewareBoundary } from '../adapters/expressAdapter.js';
import { extractEventEmitterContract, extractSocketOnAnyContract } from './eventEmitterVisitor.js';
import { extractCommonjsExport } from './commonjsExportVisitor.js';
import { extractDefinePropertyContract } from './definePropertyVisitor.js';
import { NextjsFileRole, classifyNextjsFile, extractNextjsRouteHandlerContracts, extractNextjsMiddlewareExport, extractNextjsRouteConfig, extractNextjsMetadataExport, extractNextjsServerActions, extractNextjsPageBoundary, extractNextjsLayoutBoundary, extractNextjsLifecycleContracts } from '../adapters/nextjsAdapter.js';
import { extractServerOnlyGuard } from './directiveVisitor.js';
import { extractFactoryExport } from './factoryExportVisitor.js';
import { extractPayloadContracts, extractPayloadTypeRefContracts, extractPayloadCollectionConfig } from '../adapters/payloadAdapter.js';
import { extractMcpTool } from '../adapters/mcpAdapter.js';
import { extractReactHocComponent } from '../adapters/reactAdapter.js';
import { extractDrizzleSchemaContract } from '../adapters/drizzleAdapter.js';
import { extractPublicMethod, extractSignatureTypeValves } from './publicMethodVisitor.js';
import { extractTypeDeclarationPortValves } from './portValveVisitor.js';
import { findValueModuleBinding } from './targetResolver.js';
import {
  REACT_HOC_WRAPPERS,
  FUNCTION_MEMO_WRAPPERS,
  ROUTE_HTTP_METHODS,
  ROUTE_HANDLER_CONTRACT_PATTERN_ID,
  ROUTER_AND_COMMAND_FACTORY_CALLEES,
  REMIX_INGRESS_EXPORTS,
  deriveVueSfcComponentName,
  deriveSvelteComponentName,
  unwrapWrappedFunction,
  unwrapCachedFunctionInitializer,
  findSameFileCachedFunctionDeclaration,
  isStyledComponentInitializer,
  isReactContextInitializer,
  isRouterFactoryInitializer,
  isRouterOrCliCommandFactoryInitializer,
  isAstroApiRouteExport,
  isFrameworkIngressExport,
  isNextjsAppSpecialFile,
  isRemixRouteFile,
  isAstroPageFile,
  isVueOrNuxtPageFile,
  isNuxtPluginOrMiddlewareDefaultCall,
  isPiniaDefineStoreInitializer,
  matchExportedFactoryCallConstantPattern,
  isTopLevelCliEntryInvocation,
  extractTopLevelCommanderActionContract,
  extractNodeHttpRouteBranchContract,
  extractHonoOpenApiRouteContract,
  extractRpcRouterProcedureContract,
  extractMongooseModelContract,
  extractAstroRouteContracts,
  extractSvelteKitContracts,
  isSvelteKitRouteComponentFile,
} from '../conventions/index.js';

export {
  FUNCTION_MEMO_WRAPPERS,
  ROUTER_AND_COMMAND_FACTORY_CALLEES,
  unwrapCachedFunctionInitializer,
  findSameFileCachedFunctionDeclaration,
  isStyledComponentInitializer,
  isReactContextInitializer,
  isPiniaDefineStoreInitializer,
  matchExportedFactoryCallConstantPattern,
  extractHonoOpenApiRouteContract,
};

/**
 * Returns all public exported names for a top-level statement's declared identifier (`localName`),
 * accounting for both direct `export` modifiers and same-file `export { localName, localName as alias }`
 * declarations without a module specifier ([PAT-EXT-13]).
 */
export function getExportedNamesForDeclaration(
  stmt: ts.Statement,
  localName: string,
  sourceFile: ts.SourceFile,
  includeDefaultExportAssignment = false
): string[] {
  const names: string[] = [];
  if (
    ts.canHaveModifiers(stmt) &&
    ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    names.push(localName);
  }

  for (const s of sourceFile.statements) {
    if (
      ts.isExportDeclaration(s) &&
      !s.moduleSpecifier &&
      s.exportClause &&
      ts.isNamedExports(s.exportClause)
    ) {
      for (const el of s.exportClause.elements) {
        const origName = (el.propertyName ?? el.name).text;
        if (origName === localName) {
          names.push(el.name.text);
        }
      }
    } else if (
      includeDefaultExportAssignment &&
      ts.isExportAssignment(s) &&
      !s.isExportEquals &&
      ts.isIdentifier(s.expression) &&
      s.expression.text === localName
    ) {
      names.push(localName);
    }
  }

  return Array.from(new Set(names));
}

function unwrapObjectLiteralExpression(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  let current: ts.Expression = expr;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isIdentifier(current.expression.expression) &&
    current.expression.expression.text === 'Object' &&
    (current.expression.name.text === 'freeze' || current.expression.name.text === 'assign') &&
    current.arguments.length > 0
  ) {
    for (const arg of current.arguments) {
      let cand: ts.Expression = arg;
      while (
        ts.isAsExpression(cand) ||
        ts.isSatisfiesExpression(cand) ||
        ts.isParenthesizedExpression(cand) ||
        ts.isTypeAssertionExpression(cand) ||
        ts.isNonNullExpression(cand)
      ) {
        cand = cand.expression;
      }
      if (ts.isObjectLiteralExpression(cand)) {
        return cand;
      }
    }
  }
  return ts.isObjectLiteralExpression(current) ? current : null;
}

function isLocalFunctionNameInSourceFile(sourceFile: ts.SourceFile, name: string): boolean {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return true;
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) ||
            ts.isFunctionExpression(d.initializer) ||
            unwrapCachedFunctionInitializer(d.initializer, sourceFile) !== null ||
            unwrapWrappedFunction(d.initializer, REACT_HOC_WRAPPERS, sourceFile) !== null ||
            isStyledComponentInitializer(d.initializer) ||
            isReactContextInitializer(d.initializer) ||
            isComponentMemberAlias(d.name.text, d.initializer, sourceFile))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function getCallableObjectPropertyName(
  prop: ts.ObjectLiteralElementLike,
  sourceFile: ts.SourceFile
): string | null {
  if (
    (ts.isMethodDeclaration(prop) ||
      ts.isGetAccessorDeclaration(prop) ||
      ts.isSetAccessorDeclaration(prop)) &&
    prop.name &&
    (ts.isIdentifier(prop.name) ||
      (ts.isStringLiteral(prop.name) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prop.name.text)))
  ) {
    return prop.name.text;
  }
  if (
    ts.isPropertyAssignment(prop) &&
    (ts.isIdentifier(prop.name) ||
      (ts.isStringLiteral(prop.name) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prop.name.text)))
  ) {
    let init: ts.Expression = prop.initializer;
    while (
      ts.isParenthesizedExpression(init) ||
      ts.isAsExpression(init) ||
      ts.isSatisfiesExpression(init) ||
      ts.isTypeAssertionExpression(init) ||
      ts.isNonNullExpression(init)
    ) {
      init = init.expression;
    }
    const isCallable =
      ts.isArrowFunction(init) ||
      ts.isFunctionExpression(init) ||
      unwrapCachedFunctionInitializer(init, sourceFile) !== null ||
      unwrapWrappedFunction(init, REACT_HOC_WRAPPERS, sourceFile) !== null ||
      isStyledComponentInitializer(init) ||
      isReactContextInitializer(init) ||
      (ts.isIdentifier(init) &&
        (isLocalFunctionNameInSourceFile(sourceFile, init.text) ||
          findValueModuleBinding(sourceFile, init.text) !== undefined)) ||
      (ts.isPropertyAccessExpression(init) &&
        ts.isIdentifier(init.expression) &&
        (isLocalFunctionNameInSourceFile(sourceFile, init.expression.text) ||
          findValueModuleBinding(sourceFile, init.expression.text) !== undefined)) ||
      (ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        (init.arguments.some((arg) => {
          const unwrappedArg = unwrapExpressionWrapper(arg);
          return ts.isArrowFunction(unwrappedArg) || ts.isFunctionExpression(unwrappedArg);
        }) ||
          isLocalFunctionNameInSourceFile(sourceFile, init.expression.text) ||
          findValueModuleBinding(sourceFile, init.expression.text) !== undefined));
    return isCallable ? prop.name.text : null;
  }
  if (ts.isShorthandPropertyAssignment(prop)) {
    return isLocalFunctionNameInSourceFile(sourceFile, prop.name.text) ||
      findValueModuleBinding(sourceFile, prop.name.text) !== undefined
      ? prop.name.text
      : null;
  }
  return null;
}

function isPureCallableObjectLiteral(expr: ts.Expression, sourceFile: ts.SourceFile): boolean {
  const obj = unwrapObjectLiteralExpression(expr);
  if (!obj || obj.properties.length === 0) return false;
  return obj.properties.every((prop) => getCallableObjectPropertyName(prop, sourceFile) !== null);
}

/**
 * Returns true when `expr` is an `ObjectLiteralExpression` whose properties aggregate same-file
 * module-scoped array or object-literal data collections (`export const data = { sections, categories, products, demos }`,
 * `[PAT-EXT-51]`).
 */
function isExportedObjectLiteralDataStore(
  expr: ts.Expression,
  sourceFile: ts.SourceFile
): boolean {
  const obj = unwrapObjectLiteralExpression(expr);
  if (!obj || obj.properties.length === 0) return false;
  return obj.properties.every((prop) => {
    const refIdent = ts.isShorthandPropertyAssignment(prop)
      ? prop.name
      : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
        ? prop.initializer
        : null;
    if (!refIdent) return false;
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isStringLiteral(prop.name) &&
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prop.name.text) &&
      findValueModuleBinding(sourceFile, refIdent.text) !== undefined
    ) {
      return true;
    }
    if (
      isLocalFunctionNameInSourceFile(sourceFile, refIdent.text) ||
      findValueModuleBinding(sourceFile, refIdent.text) !== undefined
    ) {
      return false;
    }
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === refIdent.text && d.initializer) {
          const unwrapped = unwrapExpressionWrapper(d.initializer);
          if (ts.isArrayLiteralExpression(unwrapped)) return true;
          if (
            ts.isObjectLiteralExpression(unwrapped) &&
            !isCallableOrNamespaceObjectLiteral(unwrapped, sourceFile)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  });
}

/**
 * Returns true when `stmt` is a top-level `var <name> = function(...) { ... }` declaration
 * invoked across >= 2 distinct other top-level statements in `sourceFile`
 * (`var setRetryAfter = function (res, nextValidRequestDate) { ... }`, `[PAT-EXT-52]`).
 */
export function isSharedModuleScopedVarFunctionHelper(
  stmt: ts.VariableStatement,
  declName: string,
  sourceFile: ts.SourceFile
): boolean {
  if (!ts.isSourceFile(stmt.parent)) return false;
  if ((stmt.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
    return false;
  }
  let callingTopLevelStmtCount = 0;
  for (const otherStmt of sourceFile.statements) {
    if (otherStmt === stmt) continue;
    let calledHere = false;
    const walk = (n: ts.Node): void => {
      if (calledHere) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === declName) {
        calledHere = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(otherStmt);
    if (calledHere) {
      callingTopLevelStmtCount++;
      if (callingTopLevelStmtCount >= 2) return true;
    }
  }
  return false;
}

function isConstAssertionType(typeNode: ts.TypeNode | undefined): boolean {
  return Boolean(
    typeNode &&
      ts.isTypeReferenceNode(typeNode) &&
      ts.isIdentifier(typeNode.typeName) &&
      typeNode.typeName.text === 'const'
  );
}

function hasExplicitTypeAssertionOrAnnotation(
  expr: ts.Expression,
  obj: ts.ObjectLiteralExpression
): boolean {
  if (
    (ts.isAsExpression(expr) && !isConstAssertionType(expr.type)) ||
    ts.isSatisfiesExpression(expr) ||
    (ts.isTypeAssertionExpression(expr) && !isConstAssertionType(expr.type))
  ) {
    return true;
  }
  let cur: ts.Node | undefined = obj.parent;
  while (cur && ts.isParenthesizedExpression(cur)) {
    cur = cur.parent;
  }
  if (
    cur &&
    ((ts.isAsExpression(cur) && !isConstAssertionType(cur.type)) ||
      ts.isSatisfiesExpression(cur) ||
      (ts.isTypeAssertionExpression(cur) && !isConstAssertionType(cur.type)))
  ) {
    return true;
  }
  return false;
}

function isCallableOrNamespaceObjectLiteral(expr: ts.Expression, sourceFile: ts.SourceFile): boolean {
  const obj = unwrapObjectLiteralExpression(expr);
  if (!obj || obj.properties.length === 0) return false;
  if (obj.properties.some((prop) => ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop))) {
    return true;
  }
  const allCallableOrNamespace = obj.properties.every((prop) => {
    if (getCallableObjectPropertyName(prop, sourceFile) !== null) return true;
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      return isCallableOrNamespaceObjectLiteral(prop.initializer, sourceFile);
    }
    return false;
  });
  if (allCallableOrNamespace) return true;

  if (hasExplicitTypeAssertionOrAnnotation(expr, obj)) {
    return obj.properties.some((prop) => {
      if (getCallableObjectPropertyName(prop, sourceFile) !== null) return true;
      if (
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ) {
        return isCallableOrNamespaceObjectLiteral(prop.initializer, sourceFile);
      }
      return false;
    });
  }

  return false;
}

function unwrapEnclosingObjectWrapper(objExpr: ts.ObjectLiteralExpression): ts.Node | undefined {
  let cur: ts.Node | undefined = objExpr.parent;
  while (
    cur &&
    (ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      (ts.isCallExpression(cur) &&
        ts.isPropertyAccessExpression(cur.expression) &&
        ts.isIdentifier(cur.expression.expression) &&
        currentIsObjectFreezeOrAssign(cur.expression)))
  ) {
    cur = cur.parent;
  }
  return cur;
}

function currentIsObjectFreezeOrAssign(expr: ts.PropertyAccessExpression): boolean {
  return (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'Object' &&
    (expr.name.text === 'freeze' || expr.name.text === 'assign')
  );
}

/**
 * Finds a callable property (`method() {}`, `prop: () => {}`, `prop: function() {}`, or shorthand `prop`
 * referencing a local function) on an object literal expression (unwrapping `as` / `satisfies` / `Object.freeze`).
 */
export function findCallableObjectProperty(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  propertyName?: string
): ts.ObjectLiteralElementLike | null {
  const current = unwrapObjectLiteralExpression(expr);
  if (!current) return null;

  if (propertyName) {
    for (const prop of current.properties) {
      if (getCallableObjectPropertyName(prop, sourceFile) === propertyName) return prop;
    }
    return null;
  }

  if (!isCallableOrNamespaceObjectLiteral(expr, sourceFile)) return null;
  for (const prop of current.properties) {
    if (getCallableObjectPropertyName(prop, sourceFile) !== null) return prop;
  }
  return null;
}

/**
 * Finds a 1+-level nested callable property (`obj.<ns1>...<nsK>.<propertyName>`) inside an
 * exported object literal (e.g. `export const briefsAPI = { server: { getAll: () => ... } }`).
 */
export function findNestedCallableObjectProperty(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  namespacePath: string | readonly string[],
  propertyName: string
): ts.ObjectLiteralElementLike | null {
  const segments = typeof namespacePath === 'string' ? [namespacePath] : namespacePath;
  if (segments.length === 0) return findCallableObjectProperty(expr, sourceFile, propertyName);
  let current = unwrapObjectLiteralExpression(expr);
  if (!current || !isCallableOrNamespaceObjectLiteral(current, sourceFile)) return null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prop = current.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === seg
    );
    if (!prop) return null;
    if (i === segments.length - 1) {
      if (!isCallableOrNamespaceObjectLiteral(prop.initializer, sourceFile)) return null;
      return findCallableObjectProperty(prop.initializer, sourceFile, propertyName);
    }
    const nextObj = unwrapObjectLiteralExpression(prop.initializer);
    if (!nextObj || !isCallableOrNamespaceObjectLiteral(nextObj, sourceFile)) return null;
    current = nextObj;
  }
  return null;
}

export function isComponentMemberAlias(
  declName: string,
  initializer: ts.Expression,
  sourceFile: ts.SourceFile
): boolean {
  if (!/^[A-Z]/.test(declName)) return false;
  if (!ts.isPropertyAccessExpression(initializer)) return false;
  if (!ts.isIdentifier(initializer.expression)) return false;
  if (!/^[A-Z]/.test(initializer.name.text)) return false;
  return Boolean(findValueModuleBinding(sourceFile, initializer.expression.text));
}

function unwrapExpressionWrapper(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function resolveExtractedContractName(
  targetNode: ts.Node,
  symbolName: string,
  targetSourceFile: ts.SourceFile,
  relativeFilePath: string,
  defaultPrefix: string
): string {
  let stmt: ts.Node = targetNode;
  if (
    ts.isVariableDeclaration(targetNode) &&
    targetNode.parent &&
    ts.isVariableDeclarationList(targetNode.parent) &&
    targetNode.parent.parent &&
    ts.isVariableStatement(targetNode.parent.parent)
  ) {
    stmt = targetNode.parent.parent;
  } else if (
    ts.isExportAssignment(targetNode) &&
    !targetNode.isExportEquals &&
    ts.isIdentifier(targetNode.expression)
  ) {
    const localName = targetNode.expression.text;
    const cachedDecl = findSameFileCachedFunctionDeclaration(localName, targetSourceFile);
    if (cachedDecl) {
      stmt = cachedDecl.stmt;
    } else {
      for (const s of targetSourceFile.statements) {
        if (ts.isFunctionDeclaration(s) && s.name?.text === localName) {
          stmt = s;
          break;
        }
        if (ts.isEnumDeclaration(s) && s.name?.text === localName) {
          stmt = s;
          break;
        }
        if (ts.isVariableStatement(s)) {
          const hasDecl = s.declarationList.declarations.some(
            (d) => ts.isIdentifier(d.name) && d.name.text === localName
          );
          if (hasDecl) {
            stmt = s;
            break;
          }
        }
      }
    }
  } else if (
    ts.isExportDeclaration(targetNode) &&
    !targetNode.moduleSpecifier &&
    targetNode.exportClause &&
    ts.isNamedExports(targetNode.exportClause)
  ) {
    const matchedEl = targetNode.exportClause.elements.find((el) => el.name.text === symbolName);
    const localName = matchedEl ? (matchedEl.propertyName ?? matchedEl.name).text : symbolName;
    for (const s of targetSourceFile.statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === localName) {
        stmt = s;
        break;
      }
      if (ts.isEnumDeclaration(s) && s.name?.text === localName) {
        stmt = s;
        break;
      }
      if (ts.isVariableStatement(s)) {
        const hasDecl = s.declarationList.declarations.some(
          (d) =>
            (ts.isIdentifier(d.name) && d.name.text === localName) ||
            (ts.isObjectBindingPattern(d.name) &&
              d.name.elements.some((el) => ts.isIdentifier(el.name) && el.name.text === localName))
        );
        if (hasDecl) {
          stmt = s;
          break;
        }
      }
    }
  }

  const fileRole = classifyNextjsFile(relativeFilePath);
  const res = visitContract(
    stmt,
    targetSourceFile,
    () => ({ filePath: relativeFilePath, lineNumber: 1, snippet: '' }),
    () => '',
    fileRole,
    relativeFilePath
  );
  let entities = Array.isArray(res) ? res : res ? [res] : [];
  if (entities.length === 0 && stmt !== targetNode) {
    const fallbackRes = visitContract(
      targetNode,
      targetSourceFile,
      () => ({ filePath: relativeFilePath, lineNumber: 1, snippet: '' }),
      () => '',
      fileRole,
      relativeFilePath
    );
    entities = Array.isArray(fallbackRes) ? fallbackRes : fallbackRes ? [fallbackRes] : [];
  }
  if (entities.length === 0) {
    const declIdent =
      ts.isVariableDeclaration(targetNode) && ts.isIdentifier(targetNode.name)
        ? targetNode.name.text
        : ts.isFunctionDeclaration(targetNode) && targetNode.name
          ? targetNode.name.text
          : symbolName;
    for (const s of targetSourceFile.statements) {
      if (
        ts.isExportAssignment(s) &&
        !s.isExportEquals &&
        ts.isIdentifier(s.expression) &&
        (s.expression.text === declIdent || s.expression.text === symbolName)
      ) {
        const defaultRes = visitContract(
          s,
          targetSourceFile,
          () => ({ filePath: relativeFilePath, lineNumber: 1, snippet: '' }),
          () => '',
          fileRole,
          relativeFilePath
        );
        entities = Array.isArray(defaultRes) ? defaultRes : defaultRes ? [defaultRes] : [];
        break;
      }
    }
  }
  const matched = entities.find(
    (e) =>
      e.type === 'CONTRACT' &&
      (e.name.endsWith(`: ${symbolName}`) || e.metadata?.componentName === symbolName)
  );
  if (matched) return matched.name;
  if (entities.length === 1 && entities[0].type === 'CONTRACT') {
    const singleName = entities[0].name;
    const colonIdx = singleName.indexOf(': ');
    const afterColon = colonIdx !== -1 ? singleName.slice(colonIdx + 2) : singleName;
    if (!symbolName.includes('.') && afterColon.includes('.')) {
      return `${defaultPrefix}: ${symbolName}`;
    }
    return singleName;
  }
  return `${defaultPrefix}: ${symbolName}`;
}

export function visitContract(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  fileRole?: NextjsFileRole | null,
  filePath?: string
): StructuralEntity | StructuralEntity[] | null {
  // Next.js App Router pages, layouts, and lifecycle exports (`generateMetadata`, `generateStaticParams`).
  // Checked first before generic FunctionDeclaration / VariableStatement branches.
  const nextjsPage = extractNextjsPageBoundary(node, fileRole ?? null, filePath ?? '', getEvidence, nextId);
  if (nextjsPage) return nextjsPage;
  const nextjsLayout = extractNextjsLayoutBoundary(node, fileRole ?? null, filePath ?? '', getEvidence, nextId);
  if (nextjsLayout) return nextjsLayout;
  const nextjsLifecycle = extractNextjsLifecycleContracts(node, fileRole ?? null, filePath ?? '', getEvidence, nextId);
  if (nextjsLifecycle) {
    if (ts.isFunctionDeclaration(node)) {
      const valves = extractSignatureTypeValves(node);
      if (valves) {
        for (const c of nextjsLifecycle) {
          c.metadata = { ...c.metadata, ...valves };
        }
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const fnInit =
            ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)
              ? decl.initializer
              : unwrapCachedFunctionInitializer(decl.initializer, sourceFile);
          if (fnInit) {
            const valves = extractSignatureTypeValves(fnInit);
            if (valves) {
              for (const c of nextjsLifecycle) {
                if (c.metadata?.componentName === decl.name.text) {
                  c.metadata = { ...c.metadata, ...valves };
                }
              }
            }
          }
        }
      }
    }
    return nextjsLifecycle.length === 1 ? nextjsLifecycle[0] : nextjsLifecycle;
  }

  // Astro route lifecycle (`getStaticPaths`) & file-based endpoints, plus SvelteKit route/hook conventions (`[PAT-EXT-76]`).
  const frameworkRouteContracts = [
    ...extractAstroRouteContracts(node, sourceFile, filePath, getEvidence, nextId),
    ...extractSvelteKitContracts(node, sourceFile, filePath, getEvidence, nextId),
  ];
  if (frameworkRouteContracts.length > 0) {
    if (ts.isFunctionDeclaration(node)) {
      const valves = extractSignatureTypeValves(node);
      if (valves) {
        for (const c of frameworkRouteContracts) {
          c.metadata = { ...c.metadata, ...valves };
        }
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const unwrappedDeclInit = unwrapExpressionWrapper(decl.initializer);
          const fnInit =
            ts.isArrowFunction(unwrappedDeclInit) || ts.isFunctionExpression(unwrappedDeclInit)
              ? unwrappedDeclInit
              : unwrapCachedFunctionInitializer(decl.initializer, sourceFile);
          if (fnInit) {
            const valves = extractSignatureTypeValves(fnInit);
            if (valves && frameworkRouteContracts.length === 1) {
              frameworkRouteContracts[0].metadata = {
                ...frameworkRouteContracts[0].metadata,
                ...valves,
              };
            }
          }
        }
      }
    }
    return frameworkRouteContracts.length === 1 ? frameworkRouteContracts[0] : frameworkRouteContracts;
  }

  if (
    ts.isInterfaceDeclaration(node) &&
    node.name &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    const valves = extractTypeDeclarationPortValves(node);
    return {
      id: nextId(),
      name: `Interface: ${node.name.text}`,
      type: 'CONTRACT',
      entityType: 'EXPORTED_TYPE', patternId: 'contract.interface-declaration',
      evidence: getEvidence(node),
      ...(valves ? { metadata: valves } : {}),
    };
  }
  if (
    ts.isTypeAliasDeclaration(node) &&
    node.name &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    const valves = extractTypeDeclarationPortValves(node);
    return {
      id: nextId(),
      name: `Type: ${node.name.text}`,
      type: 'CONTRACT',
      entityType: 'EXPORTED_TYPE', patternId: 'contract.type-alias-declaration',
      evidence: getEvidence(node),
      ...(valves ? { metadata: valves } : {}),
    };
  }
  if (ts.isEnumDeclaration(node) && node.name) {
    const exportedNames = getExportedNamesForDeclaration(
      node,
      node.name.text,
      sourceFile
    );
    if (exportedNames.length > 0) {
      const contracts: StructuralEntity[] = exportedNames.map((expName) => ({
        id: nextId(),
        name: `Enum: ${expName}`,
        type: 'CONTRACT',
        entityType: 'EXPORTED_TYPE',
        patternId: 'contract.enum-declaration',
        evidence: getEvidence(node),
      }));
      return contracts.length === 1 ? contracts[0] : contracts;
    }
  }
  if (
    ts.isFunctionDeclaration(node) &&
    !node.name &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  ) {
    if (fileRole === 'PAGE' || fileRole === 'LAYOUT') {
      return null;
    }
    const valves = extractSignatureTypeValves(node);
    const isIngressDefault =
      isRemixRouteFile(filePath) || isAstroPageFile(filePath) || isNextjsAppSpecialFile(filePath);
    const meta = {
      ...(valves ?? {}),
      ...(isIngressDefault ? { flowRole: 'INGRESS' } : {}),
    };
    return {
      id: nextId(),
      name: 'Module Export (Default)',
      type: 'CONTRACT',
      entityType: 'EXPORTED_MODULE',
      patternId: 'contract.es6-export-default',
      evidence: getEvidence(node),
      ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
    };
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    if (
      node.name.text === '__AstroComponent__' ||
      node.name.text === '__MdxComponent__' ||
      node.name.text === '__VueSfcComponent__' ||
      node.name.text === '__SvelteComponent__'
    ) {
      const isVue = node.name.text === '__VueSfcComponent__';
      const isSvelte = node.name.text === '__SvelteComponent__';
      const normMdxPath = filePath ? filePath.replace(/\\/g, '/') : '';
      const isMdxIngress =
        node.name.text === '__MdxComponent__' &&
        (!normMdxPath ||
          !/(?:^|\/)(?:src\/)?app\//i.test(normMdxPath) ||
          /(?:^|\/)page\.mdx$/i.test(normMdxPath));
      const isIngress =
        isMdxIngress ||
        isAstroPageFile(filePath) ||
        isVueOrNuxtPageFile(filePath) ||
        (isSvelte && isSvelteKitRouteComponentFile(filePath));
      return {
        id: nextId(),
        name: isVue
          ? deriveVueSfcComponentName(filePath)
          : isSvelte
            ? deriveSvelteComponentName(filePath)
            : 'Module Export (Default)',
        type: 'CONTRACT',
        entityType: isVue || isSvelte ? 'REACT_COMPONENT' : 'EXPORTED_MODULE',
        patternId: isVue
          ? 'contract.vue-sfc-script-setup'
          : isSvelte
            ? 'contract.svelte-sfc-and-sveltekit-hooks'
            : 'contract.es6-export-default',
        evidence: getEvidence(node),
        ...(isIngress ? { metadata: { flowRole: 'INGRESS' } } : {}),
      };
    }
    // Skip functions whose names are HTTP method names in a ROUTE_HANDLER file —
    // those are handled more specifically by extractNextjsRouteHandlerContracts.
    const isRouteMethod = fileRole === 'ROUTE_HANDLER' && ROUTE_HTTP_METHODS.has(node.name.text);
    // Skip default-exported functions in PAGE and LAYOUT files — captured above.
    if (
      (fileRole === 'PAGE' || fileRole === 'LAYOUT') &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return null;
    }
    if (!isRouteMethod) {
      const serverAction = extractNextjsServerActions(node, sourceFile, getEvidence, nextId);
      if (serverAction) {
        const valves = extractSignatureTypeValves(node);
        if (valves && !Array.isArray(serverAction)) {
          serverAction.metadata = { ...serverAction.metadata, ...valves };
        }
        return serverAction;
      }
      const includeDefault = /^[A-Z]/.test(node.name.text) || isRemixRouteFile(filePath);
      const exportedNames = getExportedNamesForDeclaration(
        node,
        node.name.text,
        sourceFile,
        includeDefault
      );
      if (exportedNames.length > 0) {
        const valves = extractSignatureTypeValves(node);

        const contracts: StructuralEntity[] = exportedNames.map((expName) => {
          const isRouteHandlerAlias = fileRole === 'ROUTE_HANDLER' && ROUTE_HTTP_METHODS.has(expName);
          const hasDefaultModifier =
            Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) ||
            sourceFile.statements.some(
              (s) =>
                ts.isExportAssignment(s) &&
                !s.isExportEquals &&
                ts.isIdentifier(s.expression) &&
                s.expression.text === node.name!.text
            );
          const isIngress = isFrameworkIngressExport(filePath, expName, hasDefaultModifier);
          const meta = {
            ...(valves ?? {}),
            ...(isIngress ? { flowRole: 'INGRESS' } : {}),
          };
          return {
            id: nextId(),
            name: isRouteHandlerAlias ? `Route Handler: ${expName}` : `Exported Function: ${expName}`,
            type: 'CONTRACT',
            entityType: isRouteHandlerAlias ? 'HTTP_ENDPOINT' : 'EXPORTED_FUNCTION',
            patternId: isRouteHandlerAlias ? ROUTE_HANDLER_CONTRACT_PATTERN_ID : 'contract.exported-function',
            evidence: getEvidence(node),
            ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
          };
        });
        return contracts.length === 1 ? contracts[0] : contracts;
      }
      if (
        ts.isSourceFile(node.parent) &&
        isTopLevelCliEntryInvocation(sourceFile, node.name.text, filePath)
      ) {
        const valves = extractSignatureTypeValves(node);
        return {
          id: nextId(),
          name: `Exported Function: ${node.name.text}`,
          type: 'CONTRACT',
          entityType: 'CLI_COMMAND',
          patternId: 'contract.exported-function',
          evidence: getEvidence(node),
          metadata: { ...(valves ?? {}), flowRole: 'INGRESS' },
        };
      }
    }
  }

  // Ontology v4.0: public methods are Contracts attached to their parent CLASS.
  const publicMethod = extractPublicMethod(node, getEvidence, nextId);
  if (publicMethod) return publicMethod;

  // Ontology v4.0: `export default <expr>` is the contract surface of a source unit (EXPORTED_MODULE),
  // distinct from the file itself — unless it wraps a named component in an HOC (`export default memo(Modal)`),
  // a cached/memoized function (`export default cache(fn)` or `const fn = cache(...); export default fn`),
  // or references a same-file function/component variable declaration that is already extracted as a CONTRACT.
  if (ts.isExportAssignment(node)) {
    const hocDefault = extractReactHocComponent(node, getEvidence, nextId);
    if (hocDefault) return hocDefault.length === 1 ? hocDefault[0] : hocDefault;
    if (!node.isExportEquals) {
      if (ts.isIdentifier(node.expression)) {
        const identName = node.expression.text;
        if (findSameFileCachedFunctionDeclaration(identName, sourceFile)) {
          return null;
        }
        for (const s of sourceFile.statements) {
          if (s === node) continue;
          if (ts.isClassDeclaration(s) && s.name?.text === identName) {
            return null;
          }
          const isMatchingVarStmt =
            ts.isVariableStatement(s) &&
            s.declarationList.declarations.some(
              (d) => ts.isIdentifier(d.name) && d.name.text === identName
            );
          const isMatchingFnDecl =
            ts.isFunctionDeclaration(s) && s.name?.text === identName;
          if (isMatchingVarStmt || isMatchingFnDecl) {
            const existing = visitContract(s, sourceFile, getEvidence, nextId, fileRole, filePath);
            const existingList = Array.isArray(existing) ? existing : existing ? [existing] : [];
            if (existingList.some((e) => e.type === 'CONTRACT')) {
              return null;
            }
          }
        }
      }
      const cachedDefault = unwrapCachedFunctionInitializer(node.expression, sourceFile);
      if (cachedDefault) {
        const unwrappedCall = unwrapExpressionWrapper(node.expression);
        const fnName =
          (ts.isFunctionDeclaration(cachedDefault) || ts.isFunctionExpression(cachedDefault)) &&
          cachedDefault.name
            ? cachedDefault.name.text
            : ts.isCallExpression(unwrappedCall) &&
                unwrappedCall.arguments.length > 0 &&
                ts.isIdentifier(unwrappedCall.arguments[0])
              ? unwrappedCall.arguments[0].text
              : null;
        if (fnName) {
          const valves = extractSignatureTypeValves(cachedDefault);
          return {
            id: nextId(),
            name: `Exported Function: ${fnName}`,
            type: 'CONTRACT',
            entityType: 'EXPORTED_FUNCTION',
            patternId: 'contract.exported-function',
            evidence: getEvidence(node),
            ...(valves ? { metadata: valves } : {}),
          };
        }
      }
    }
    const isNuxtEntry =
      !node.isExportEquals && isNuxtPluginOrMiddlewareDefaultCall(node.expression, filePath);
    const isPiniaDefault =
      !node.isExportEquals && isPiniaDefineStoreInitializer(node.expression);
    const isVueFile = Boolean(filePath && filePath.toLowerCase().endsWith('.vue'));
    const isSvelteFile = Boolean(filePath && filePath.toLowerCase().endsWith('.svelte'));
    const isIngressDefault =
      isNuxtEntry ||
      isRemixRouteFile(filePath) ||
      isAstroPageFile(filePath) ||
      isVueOrNuxtPageFile(filePath) ||
      (isSvelteFile && isSvelteKitRouteComponentFile(filePath)) ||
      isNextjsAppSpecialFile(filePath);
    return {
      id: nextId(),
      name: isVueFile
        ? deriveVueSfcComponentName(filePath)
        : isSvelteFile
          ? deriveSvelteComponentName(filePath)
          : `Module Export (Default)`,
      type: 'CONTRACT',
      entityType: isVueFile || isSvelteFile ? 'REACT_COMPONENT' : 'EXPORTED_MODULE',
      patternId: isNuxtEntry
        ? 'contract.nuxt-plugin-and-middleware-entry-points'
        : isPiniaDefault
          ? 'contract.pinia-define-store'
          : isVueFile
            ? 'contract.vue-sfc-script-setup'
            : isSvelteFile
              ? 'contract.svelte-sfc-and-sveltekit-hooks'
              : 'contract.es6-export-default',
      evidence: getEvidence(node),
      ...(isIngressDefault ? { metadata: { flowRole: 'INGRESS' } } : {}),
    };
  }

  const nodeHttpRouteBranch = extractNodeHttpRouteBranchContract(node, getEvidence, nextId);
  if (nodeHttpRouteBranch) return nodeHttpRouteBranch;

  const commanderAction = extractTopLevelCommanderActionContract(node, getEvidence, nextId);
  if (commanderAction) return commanderAction;

  // Express middleware mounts (`app.use(fn)`) — a Contract, not a boundary, in v4.
  const expressMiddleware = extractExpressMiddlewareBoundary(node, sourceFile, getEvidence, nextId);
  if (expressMiddleware) return expressMiddleware;

  // Next.js: directive prologues ('use server' / 'use client') are NOT nodes — the orchestrator
  // records them as `metadata.runtime` on the contracts of the source unit (see directiveVisitor.ts).

  // Next.js: server-only import guard
  const serverGuard = extractServerOnlyGuard(node, getEvidence, nextId);
  if (serverGuard) return serverGuard;

  // Next.js: Route Handler contracts (GET/POST/... exports in route.ts)
  const routeHandlers = extractNextjsRouteHandlerContracts(node, fileRole ?? null, getEvidence, nextId);
  if (routeHandlers) return routeHandlers;

  // Next.js: middleware export contract
  const middleware = extractNextjsMiddlewareExport(node, fileRole ?? null, getEvidence, nextId);
  if (middleware) return middleware;

  // Next.js: Route segment config
  const routeConfig = extractNextjsRouteConfig(node, getEvidence, nextId, fileRole ?? null, filePath ?? '');
  if (routeConfig) return routeConfig;

  // Next.js: Metadata export
  const metadataExport = extractNextjsMetadataExport(node, getEvidence, nextId, fileRole ?? null, filePath ?? '');
  if (metadataExport) return metadataExport;

  if (ts.isVariableStatement(node)) {
    const inlineServerAction = extractNextjsServerActions(node, sourceFile, getEvidence, nextId);
    if (inlineServerAction) return inlineServerAction;
  }

  const expressRoute = extractExpressRoute(node, getEvidence, nextId);
  if (expressRoute) return expressRoute;

  const honoOpenApiRoute = extractHonoOpenApiRouteContract(node, sourceFile, getEvidence, nextId);
  if (honoOpenApiRoute) return honoOpenApiRoute;

  const expressParam = extractExpressRouteParameter(node, getEvidence, nextId);
  if (expressParam) return expressParam;

  const expressContentNegotiation = extractExpressContentNegotiation(node, getEvidence, nextId);
  if (expressContentNegotiation) return expressContentNegotiation;

  const expressDynamicMethods = extractExpressDynamicMethods(node, getEvidence, nextId);
  if (expressDynamicMethods) return expressDynamicMethods;

  const eventEmitterContract = extractEventEmitterContract(node, getEvidence, nextId);
  if (eventEmitterContract) return eventEmitterContract;

  const socketOnAnyContract = extractSocketOnAnyContract(node, getEvidence, nextId);
  if (socketOnAnyContract) return socketOnAnyContract;

  const cjsExport = extractCommonjsExport(node, getEvidence, nextId);
  if (cjsExport && cjsExport.type === 'CONTRACT') return cjsExport;

  const definePropertyContract = extractDefinePropertyContract(node, getEvidence, nextId);
  if (definePropertyContract) return definePropertyContract;

  const factoryExport = extractFactoryExport(node, getEvidence, nextId);
  if (factoryExport) return factoryExport;

  const payloadContracts = extractPayloadContracts(node, getEvidence, nextId);
  if (payloadContracts) return payloadContracts;

  const payloadTypeRef = extractPayloadTypeRefContracts(node, getEvidence, nextId);
  if (payloadTypeRef) return payloadTypeRef;

  const mcpTool = extractMcpTool(node, getEvidence, nextId);
  if (mcpTool) return mcpTool;

  const drizzleSchema = extractDrizzleSchemaContract(node, getEvidence, nextId);
  if (drizzleSchema) return drizzleSchema;

  const mongooseModel = extractMongooseModelContract(node, sourceFile, getEvidence, nextId);
  if (mongooseModel) return mongooseModel;

  const payloadCollection = extractPayloadCollectionConfig(node, getEvidence, nextId);
  if (payloadCollection) return payloadCollection;

  const rpcProcedure = extractRpcRouterProcedureContract(node, sourceFile, getEvidence, nextId);
  if (rpcProcedure) return rpcProcedure;

  // [PAT-EXT-13] Canonical Contract Declaration Parity:
  // Top-level VariableStatement declarations initialized to ArrowFunction, FunctionExpression,
  // or an ObjectLiteralExpression with callable methods (`export const ansi = { dim: (s) => ... }`)
  // that are exported directly (`export const fn = () => {}`) or via `export { fn, fn as alias }`.
  if (ts.isVariableStatement(node) && ts.isSourceFile(node.parent)) {
    const fnContracts: StructuralEntity[] = [];
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (extractPayloadTypeRefContracts(decl, getEvidence, nextId)) continue;
      let unwrappedInit: ts.Expression = decl.initializer;
      while (
        ts.isParenthesizedExpression(unwrappedInit) ||
        ts.isAsExpression(unwrappedInit) ||
        ts.isSatisfiesExpression(unwrappedInit) ||
        ts.isTypeAssertionExpression(unwrappedInit) ||
        ts.isNonNullExpression(unwrappedInit)
      ) {
        unwrappedInit = unwrappedInit.expression;
      }
      const isDirectFn =
        ts.isArrowFunction(unwrappedInit) || ts.isFunctionExpression(unwrappedInit);
      const cachedInnerFn = !isDirectFn
        ? unwrapCachedFunctionInitializer(decl.initializer, sourceFile)
        : null;
      const isCachedFn = cachedInnerFn !== null;
      const isScreamingSnakeConst = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(decl.name.text);
      const isCallableObj =
        !isDirectFn &&
        !isCachedFn &&
        !isScreamingSnakeConst &&
        findCallableObjectProperty(decl.initializer, sourceFile) !== null;
      const isMemberAlias =
        !isDirectFn &&
        !isCachedFn &&
        !isCallableObj &&
        isComponentMemberAlias(decl.name.text, unwrappedInit, sourceFile);
      const isStyledOrContext =
        !isDirectFn &&
        !isCachedFn &&
        !isCallableObj &&
        !isMemberAlias &&
        (isStyledComponentInitializer(decl.initializer) ||
          isReactContextInitializer(decl.initializer));
      const isFunctionAlias =
        !isDirectFn &&
        !isCachedFn &&
        !isCallableObj &&
        !isMemberAlias &&
        !isStyledOrContext &&
        ((ts.isIdentifier(unwrappedInit) &&
          (isLocalFunctionNameInSourceFile(sourceFile, unwrappedInit.text) ||
            findValueModuleBinding(sourceFile, unwrappedInit.text) !== undefined)) ||
          (ts.isPropertyAccessExpression(unwrappedInit) &&
            ts.isIdentifier(unwrappedInit.expression) &&
            /^[a-z]/.test(decl.name.text) &&
            /^[a-z]/.test(unwrappedInit.name.text) &&
            (isLocalFunctionNameInSourceFile(sourceFile, unwrappedInit.expression.text) ||
              findValueModuleBinding(sourceFile, unwrappedInit.expression.text) !== undefined)));
      const isRouterOrCommandFactory =
        !isDirectFn &&
        !isCachedFn &&
        !isCallableObj &&
        !isMemberAlias &&
        !isStyledOrContext &&
        !isFunctionAlias &&
        isRouterOrCliCommandFactoryInitializer(unwrappedInit);
      const isRouterFactory =
        isRouterOrCommandFactory && isRouterFactoryInitializer(unwrappedInit);
      const isPiniaStore =
        !isDirectFn &&
        !isCachedFn &&
        !isCallableObj &&
        !isMemberAlias &&
        !isStyledOrContext &&
        !isFunctionAlias &&
        !isRouterOrCommandFactory &&
        isPiniaDefineStoreInitializer(unwrappedInit);
      const factoryConstPattern =
        !isDirectFn &&
        !isCachedFn &&
        !isCallableObj &&
        !isMemberAlias &&
        !isStyledOrContext &&
        !isFunctionAlias &&
        !isRouterOrCommandFactory &&
        !isPiniaStore
          ? matchExportedFactoryCallConstantPattern(unwrappedInit)
          : null;
      const isDataStoreObj =
        !isDirectFn &&
        !isCachedFn &&
        !isCallableObj &&
        !isMemberAlias &&
        !isStyledOrContext &&
        !isFunctionAlias &&
        !isRouterOrCommandFactory &&
        !isPiniaStore &&
        !factoryConstPattern &&
        isExportedObjectLiteralDataStore(unwrappedInit, sourceFile);
      if (isDataStoreObj) {
        const exportedNames = getExportedNamesForDeclaration(
          node,
          decl.name.text,
          sourceFile,
          false
        );
        for (const expName of exportedNames) {
          fnContracts.push({
            id: nextId(),
            name: `Exported Module: ${expName}`,
            type: 'CONTRACT',
            entityType: 'EXPORTED_MODULE',
            patternId: 'contract.exported-object-literal-data-store',
            evidence: getEvidence(node),
          });
        }
        continue;
      }
      if (
        isDirectFn ||
        isCachedFn ||
        isCallableObj ||
        isMemberAlias ||
        isStyledOrContext ||
        isFunctionAlias ||
        isRouterOrCommandFactory ||
        isPiniaStore ||
        factoryConstPattern !== null
      ) {
        const isRouteMethod = fileRole === 'ROUTE_HANDLER' && ROUTE_HTTP_METHODS.has(decl.name.text);
        if (isRouteMethod) continue;

        const includeDefault =
          isDirectFn ||
          isCachedFn ||
          isMemberAlias ||
          isStyledOrContext ||
          isFunctionAlias ||
          isRouterOrCommandFactory ||
          isPiniaStore ||
          factoryConstPattern !== null;
        const exportedNames = getExportedNamesForDeclaration(
          node,
          decl.name.text,
          sourceFile,
          includeDefault
        );
        if (
          exportedNames.length === 0 &&
          (isDirectFn || isCachedFn) &&
          isTopLevelCliEntryInvocation(sourceFile, decl.name.text, filePath)
        ) {
          const valves = isDirectFn
            ? extractSignatureTypeValves(unwrappedInit as ts.ArrowFunction | ts.FunctionExpression)
            : cachedInnerFn
              ? extractSignatureTypeValves(cachedInnerFn)
              : undefined;
          fnContracts.push({
            id: nextId(),
            name: `Exported Function: ${decl.name.text}`,
            type: 'CONTRACT',
            entityType: 'CLI_COMMAND',
            patternId: 'contract.exported-function',
            evidence: getEvidence(node),
            metadata: { ...(valves ?? {}), flowRole: 'INGRESS' },
          });
          continue;
        }
        if (
          exportedNames.length === 0 &&
          isDirectFn &&
          isSharedModuleScopedVarFunctionHelper(node, decl.name.text, sourceFile)
        ) {
          const valves = extractSignatureTypeValves(
            unwrappedInit as ts.ArrowFunction | ts.FunctionExpression
          );
          fnContracts.push({
            id: nextId(),
            name: `Exported Function: ${decl.name.text}`,
            type: 'CONTRACT',
            entityType: 'EXPORTED_FUNCTION',
            patternId: 'contract.module-scoped-var-function-helper',
            evidence: getEvidence(node),
            ...(valves ? { metadata: valves } : {}),
          });
          continue;
        }
        if (exportedNames.length === 0) continue;

        const valves = isDirectFn
          ? extractSignatureTypeValves(unwrappedInit as ts.ArrowFunction | ts.FunctionExpression)
          : cachedInnerFn
            ? extractSignatureTypeValves(cachedInnerFn)
            : undefined;
        for (const expName of exportedNames) {
          const isAstroRoute = isAstroApiRouteExport(decl, expName);
          const isRouteHandlerAlias =
            (fileRole === 'ROUTE_HANDLER' && ROUTE_HTTP_METHODS.has(expName)) || isAstroRoute;
          const routeMethodName = isAstroRoute ? expName.toUpperCase() : expName;
          const hasDefaultExport = sourceFile.statements.some(
            (s) =>
              ts.isExportAssignment(s) &&
              !s.isExportEquals &&
              ts.isIdentifier(s.expression) &&
              ts.isIdentifier(decl.name) &&
              s.expression.text === decl.name.text
          );
          const isIngress = isFrameworkIngressExport(filePath, expName, hasDefaultExport);
          const meta = {
            ...(valves ?? {}),
            ...(isIngress ? { flowRole: 'INGRESS' } : {}),
          };
          fnContracts.push({
            id: nextId(),
            name: isRouteHandlerAlias
              ? `Route Handler: ${routeMethodName}`
              : isStyledOrContext
                ? `React Component: ${expName}`
                : isRouterFactory
                  ? `Exported Module: ${expName}`
                  : `Exported Function: ${expName}`,
            type: 'CONTRACT',
            entityType: isRouteHandlerAlias
              ? 'HTTP_ENDPOINT'
              : isStyledOrContext
                ? 'REACT_COMPONENT'
                : isRouterFactory
                  ? 'EXPORTED_MODULE'
                  : 'EXPORTED_FUNCTION',
            patternId: isRouteHandlerAlias
              ? ROUTE_HANDLER_CONTRACT_PATTERN_ID
              : isStyledOrContext
                ? 'contract.react-functional-component'
                : isRouterFactory
                  ? 'contract.exported-module'
                  : isPiniaStore
                    ? 'contract.pinia-define-store'
                    : factoryConstPattern
                      ? factoryConstPattern
                      : 'contract.exported-function',
            evidence: getEvidence(node),
            ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
          });
        }
      }
    }
    if (fnContracts.length === 1) return fnContracts[0];
    if (fnContracts.length > 1) return fnContracts;
  }

  // Nested 1+-level namespace object-literal methods on exported object literals
  // (`export const briefsAPI = { server: { getAll: () => ..., deleteBrief(id) { ... } } }`):
  // emit an EXPORTED_FUNCTION contract anchored directly at each nested callable property AST node
  // so calls inside the method body are owned by `Exported Function: <obj>.<ns>.<method>` (not Init).
  if (
    ts.isPropertyAssignment(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isShorthandPropertyAssignment(node)
  ) {
    const methodName = getCallableObjectPropertyName(node, sourceFile);
    if (
      methodName &&
      node.parent &&
      ts.isObjectLiteralExpression(node.parent) &&
      isCallableOrNamespaceObjectLiteral(node.parent, sourceFile)
    ) {
      const namespaceSegments: string[] = [];
      let curObj: ts.ObjectLiteralExpression = node.parent;
      let outerHolder: ts.Node | undefined = unwrapEnclosingObjectWrapper(curObj);
      while (
        outerHolder &&
        ts.isPropertyAssignment(outerHolder) &&
        (ts.isIdentifier(outerHolder.name) || ts.isStringLiteral(outerHolder.name)) &&
        outerHolder.parent &&
        ts.isObjectLiteralExpression(outerHolder.parent) &&
        isCallableOrNamespaceObjectLiteral(outerHolder.parent, sourceFile)
      ) {
        namespaceSegments.unshift(outerHolder.name.text);
        curObj = outerHolder.parent;
        outerHolder = unwrapEnclosingObjectWrapper(curObj);
      }
      if (namespaceSegments.length > 0) {
        const namespacePath = namespaceSegments.join('.');
        const exportedNames: string[] = [];
        if (
          outerHolder &&
          ts.isVariableDeclaration(outerHolder) &&
          ts.isIdentifier(outerHolder.name) &&
          outerHolder.parent &&
          ts.isVariableDeclarationList(outerHolder.parent) &&
          outerHolder.parent.parent &&
          ts.isVariableStatement(outerHolder.parent.parent) &&
          ts.isSourceFile(outerHolder.parent.parent.parent)
        ) {
          const stmt = outerHolder.parent.parent;
          const declName = outerHolder.name.text;
          const isRouteMethod = fileRole === 'ROUTE_HANDLER' && ROUTE_HTTP_METHODS.has(declName);
          const isScreamingSnake = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(declName);
          if (
            !isRouteMethod &&
            !isScreamingSnake &&
            !extractPayloadTypeRefContracts(outerHolder, getEvidence, nextId) &&
            !extractPayloadCollectionConfig(stmt, getEvidence, nextId) &&
            !extractDrizzleSchemaContract(stmt, getEvidence, nextId)
          ) {
            exportedNames.push(...getExportedNamesForDeclaration(stmt, declName, sourceFile));
            const hasDefaultExport = sourceFile.statements.some(
              (s) =>
                ts.isExportAssignment(s) &&
                !s.isExportEquals &&
                ts.isIdentifier(s.expression) &&
                s.expression.text === declName
            );
            if (hasDefaultExport && !exportedNames.includes(declName)) {
              exportedNames.push(declName);
            }
          }
        } else if (
          outerHolder &&
          ts.isExportAssignment(outerHolder) &&
          !outerHolder.isExportEquals &&
          ts.isSourceFile(outerHolder.parent)
        ) {
          exportedNames.push('default');
        }

        if (exportedNames.length > 0) {
          let fnNode: ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | null = null;
          if (ts.isMethodDeclaration(node)) {
            fnNode = node;
          } else if (ts.isPropertyAssignment(node)) {
            const init = unwrapExpressionWrapper(node.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              fnNode = init;
            }
          }
          const valves = fnNode ? extractSignatureTypeValves(fnNode) : undefined;
          const nestedContracts: StructuralEntity[] = exportedNames.map((expName) => ({
            id: nextId(),
            name: `Exported Function: ${expName}.${namespacePath}.${methodName}`,
            type: 'CONTRACT',
            entityType: 'EXPORTED_FUNCTION',
            patternId: 'contract.exported-function',
            evidence: getEvidence(node),
            ...(valves ? { metadata: valves } : {}),
          }));
          return nestedContracts.length === 1 ? nestedContracts[0] : nestedContracts;
        }
      }
    }
  }

  // [PAT-EXT-25] Higher-order-component-wrapped exports (`export const Card = memo(fn)`): the
  // convention lives in the React convention table (`conventions/react.ts`).
  const hocComponents = extractReactHocComponent(node, getEvidence, nextId);
  if (hocComponents) return hocComponents.length === 1 ? hocComponents[0] : hocComponents;

  return null;
}
