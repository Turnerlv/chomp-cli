// packages/core/src/extractor/visitors/initBlockVisitor.ts
// Scope resolution for RELATIONSHIP sources under Ontology v4.0 (Ephemeral Code).
//
// A DEPLOYMENT_UNIT never "acts": runtime execution does. Code that runs when a module is
// evaluated (top-level statements, `const x = Factory()`, `export default buildConfig(...)`)
// therefore originates from an implicit INIT_BLOCK boundary — one per deployment unit, created
// lazily the first time it is needed as a relationship source.
//
// Code that runs inside a function/method/handler body originates from the nearest enclosing
// extracted Contract (or CLASS) instead.

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import {
  REACT_HOC_WRAPPERS,
  unwrapWrappedFunction,
  unwrapCachedFunctionInitializer,
} from '../conventions/index.js';

/**
 * Placeholder `sourceId` handed to relationship visitors. The orchestrator replaces it with the
 * real scope owner (contract / class / init block) once the AST ancestry has been inspected.
 */
export const SCOPE_SOURCE_PLACEHOLDER = '__chomp_scope__';

/**
 * True for AST nodes whose body is executed lazily (when called) rather than at module evaluation.
 *
 * @param node The AST node to classify.
 * @returns Whether the node is a function-like declaration/expression.
 */
export function isFunctionLikeNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Finds the id of the nearest enclosing extracted Contract/Class that owns the given AST node's
 * execution, or `undefined` when the node executes at module evaluation (→ INIT_BLOCK).
 *
 * An ancestor owns the node when it was registered as the AST anchor of an extracted entity AND
 * either (a) a function-like boundary lies between the node and the ancestor (or is the ancestor
 * itself) — i.e. execution is deferred into that contract — or (b) the ancestor is a class body.
 *
 * @example
 * app.get('/x', (req, res) => { res.json(1); });   // res.json() → Express Route (deferred handler)
 * export const users = pgTable('users', {});        // pgTable()  → undefined (runs at load → INIT_BLOCK)
 *
 * @param node         The AST node (typically a CallExpression) that originates a relationship.
 * @param ownerByNode  Map from AST anchor node → id of the entity extracted from it.
 * @returns The owning entity id, or undefined if the node belongs to the module's INIT_BLOCK.
 */
export function findScopeOwnerId(
  node: ts.Node,
  ownerByNode: Map<ts.Node, string>
): string | undefined {
  let crossedFunction = false;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isDecorator(current) && !crossedFunction) {
      return undefined;
    }
    if (isFunctionLikeNode(current)) crossedFunction = true;
    const owner = ownerByNode.get(current);
    if (owner && (crossedFunction || ts.isClassDeclaration(current))) {
      return owner;
    }
  }
  return undefined;
}

/**
 * True when `id` is a runtime value reference to a lexical binding rather than a property access
 * member (`obj.id`), declaration name (`function id()`), or type reference.
 */
function isIdentifierValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isTypeNode(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isParameter(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  return true;
}

/**
 * Propagates scope ownership from extracted Contracts/Classes to intra-file non-exported
 * helper functions that they invoke or reference (directly or transitively).
 *
 * When a local helper is referenced by multiple contracts in the same file (e.g., both
 * `generateMetadata` and `BriefPage` calling `getBlog(slug)` in `app/briefs/[slug]/page.js`),
 * returns a map from each helper AST node to all contract owner IDs that invoke it so the
 * orchestrator can fan out the helper's outgoing edges to every caller.
 *
 * @param sourceFile   The AST source file being analyzed.
 * @param ownerByNode  Map from AST anchor node → owning entity id (mutated in place).
 * @returns Map from shared helper AST node → set of calling contract owner IDs.
 */
export function propagateLocalHelperOwners(
  sourceFile: ts.SourceFile,
  ownerByNode: Map<ts.Node, string>
): Map<ts.Node, Set<string>> {
  const localHelpersByName = new Map<string, ts.Node>();
  const privateMethodsByClass = new Map<ts.ClassDeclaration, Map<string, ts.Node>>();
  const multiOwnersByHelperNode = new Map<ts.Node, Set<string>>();

  const collectHelpers = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && !ownerByNode.has(node)) {
      localHelpersByName.set(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      !ownerByNode.has(node)
    ) {
      let unwrappedInit: ts.Expression = node.initializer;
      while (
        ts.isParenthesizedExpression(unwrappedInit) ||
        ts.isAsExpression(unwrappedInit) ||
        ts.isSatisfiesExpression(unwrappedInit) ||
        ts.isTypeAssertionExpression(unwrappedInit) ||
        ts.isNonNullExpression(unwrappedInit)
      ) {
        unwrappedInit = unwrappedInit.expression;
      }
      const callableObjInit =
        ts.isObjectLiteralExpression(unwrappedInit) &&
        unwrappedInit.properties.some(
          (p) =>
            ts.isMethodDeclaration(p) ||
            ts.isGetAccessorDeclaration(p) ||
            ts.isSetAccessorDeclaration(p) ||
            (ts.isPropertyAssignment(p) && isFunctionLikeNode(p.initializer))
        )
          ? unwrappedInit
          : undefined;
      const helperFn = isFunctionLikeNode(node.initializer)
        ? node.initializer
        : unwrapWrappedFunction(node.initializer, REACT_HOC_WRAPPERS) ??
          unwrapCachedFunctionInitializer(node.initializer) ??
          callableObjInit ??
          (ts.isCallExpression(node.initializer)
            ? node.initializer.arguments.find(isFunctionLikeNode)
            : undefined);
      const statement = node.parent?.parent;
      if (helperFn && !ownerByNode.has(helperFn) && (!statement || !ownerByNode.has(statement))) {
        localHelpersByName.set(node.name.text, helperFn);
      }
    } else if (
      (ts.isMethodDeclaration(node) ||
        (ts.isPropertyDeclaration(node) && node.initializer && isFunctionLikeNode(node.initializer))) &&
      node.name &&
      (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) &&
      !ownerByNode.has(node) &&
      node.parent &&
      ts.isClassDeclaration(node.parent)
    ) {
      let methodMap = privateMethodsByClass.get(node.parent);
      if (!methodMap) {
        methodMap = new Map<string, ts.Node>();
        privateMethodsByClass.set(node.parent, methodMap);
      }
      methodMap.set(node.name.text, node);
    }
    if (isFunctionLikeNode(node)) return;
    ts.forEachChild(node, collectHelpers);
  };

  collectHelpers(sourceFile);
  if (localHelpersByName.size === 0 && privateMethodsByClass.size === 0) return multiOwnersByHelperNode;

  const preSeededHelperNodes = new Set<ts.Node>();

  // Pre-seed ownership for local functions/arrows directly exported via `export default fn`
  // or `export default memo(fn)` so sibling intra-file callers cannot hijack their ownership.
  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const exportOwner = ownerByNode.get(stmt);
      if (!exportOwner) continue;
      if (ts.isIdentifier(stmt.expression)) {
        const helperNode = localHelpersByName.get(stmt.expression.text);
        if (helperNode && !ownerByNode.has(helperNode)) {
          ownerByNode.set(helperNode, exportOwner);
          preSeededHelperNodes.add(helperNode);
        }
      } else {
        const unwrapped =
          unwrapWrappedFunction(stmt.expression, REACT_HOC_WRAPPERS, sourceFile) ??
          unwrapCachedFunctionInitializer(stmt.expression, sourceFile);
        const fnName =
          unwrapped &&
          (ts.isFunctionDeclaration(unwrapped) || ts.isFunctionExpression(unwrapped)) &&
          unwrapped.name
            ? unwrapped.name.text
            : null;
        if (fnName) {
          const helperNode = localHelpersByName.get(fnName);
          if (helperNode && !ownerByNode.has(helperNode)) {
            ownerByNode.set(helperNode, exportOwner);
            preSeededHelperNodes.add(helperNode);
          }
        }
      }
    }
  }

  // Pre-seed ownership for local functions exported via CommonJS (`module.exports = fn`,
  // `module.exports = { fn }`, or `module.exports = { prop: fn }`).
  for (const [astNode, exportOwner] of [...ownerByNode.entries()]) {
    if (ts.isShorthandPropertyAssignment(astNode)) {
      const helperNode = localHelpersByName.get(astNode.name.text);
      if (helperNode && !ownerByNode.has(helperNode)) {
        ownerByNode.set(helperNode, exportOwner);
        preSeededHelperNodes.add(helperNode);
      }
    } else if (ts.isPropertyAssignment(astNode) && ts.isIdentifier(astNode.initializer)) {
      const helperNode = localHelpersByName.get(astNode.initializer.text);
      if (helperNode && !ownerByNode.has(helperNode)) {
        ownerByNode.set(helperNode, exportOwner);
        preSeededHelperNodes.add(helperNode);
      }
    } else if (ts.isBinaryExpression(astNode) && astNode.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      let rhs: ts.Node = astNode.right;
      while (ts.isBinaryExpression(rhs) && rhs.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        rhs = rhs.right;
      }
      if (ts.isIdentifier(rhs)) {
        const helperNode = localHelpersByName.get(rhs.text);
        if (helperNode && !ownerByNode.has(helperNode)) {
          ownerByNode.set(helperNode, exportOwner);
          preSeededHelperNodes.add(helperNode);
        }
      }
    }
  }

  const isInsideNode = (candidate: ts.Node, container: ts.Node): boolean => {
    for (let cur: ts.Node | undefined = candidate; cur; cur = cur.parent) {
      if (cur === container) return true;
    }
    return false;
  };

  const findEnclosingClass = (node: ts.Node): ts.ClassDeclaration | undefined => {
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (ts.isClassDeclaration(cur)) return cur;
    }
    return undefined;
  };

  /**
   * Pre-seed top-level module entrypoint helpers (e.g. `async function createServer() { ... } createServer();`
   * in `devFeServer.ts`) that are directly invoked at module initialization scope outside any function,
   * class, or contract owner, so inner callbacks (e.g. `process.stdin.on('data', () => createServer())`)
   * do not hijack their ownership away from `INIT_BLOCK`.
   */
  const markTopLevelEntryHelpers = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helperNode = localHelpersByName.get(node.expression.text);
      if (helperNode && !preSeededHelperNodes.has(helperNode) && !ownerByNode.has(helperNode)) {
        let insideFunctionOrClass = false;
        for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
          if (isFunctionLikeNode(cur) || ts.isClassDeclaration(cur)) {
            insideFunctionOrClass = true;
            break;
          }
        }
        if (!insideFunctionOrClass && !findScopeOwnerId(node, ownerByNode) && !ownerByNode.has(node)) {
          preSeededHelperNodes.add(helperNode);
        }
      }
    }
    ts.forEachChild(node, markTopLevelEntryHelpers);
  };
  markTopLevelEntryHelpers(sourceFile);

  /**
   * When an identifier (`Modal`) is the wrapped target of an HOC export (`export default memo(Modal)`
   * or `export const X = memo(Modal)`), returns the owner id registered for that export statement.
   */
  const findHocExportOwnerId = (idNode: ts.Identifier): string | undefined => {
    for (let cur: ts.Node | undefined = idNode.parent; cur; cur = cur.parent) {
      if (isFunctionLikeNode(cur)) return undefined;
      if (ts.isCallExpression(cur)) {
        if (!cur.arguments.some((arg) => isInsideNode(idNode, arg))) {
          return undefined;
        }
        continue;
      }
      if (
        ts.isObjectLiteralExpression(cur) ||
        ts.isPropertyAssignment(cur) ||
        ts.isShorthandPropertyAssignment(cur) ||
        ts.isSpreadAssignment(cur) ||
        ts.isArrayLiteralExpression(cur) ||
        ts.isSpreadElement(cur) ||
        ts.isParenthesizedExpression(cur) ||
        ts.isAsExpression(cur) ||
        ts.isSatisfiesExpression(cur) ||
        ts.isTypeAssertionExpression(cur) ||
        ts.isNonNullExpression(cur)
      ) {
        continue;
      }
      if (ts.isExportAssignment(cur)) return ownerByNode.get(cur);
      if (ts.isVariableDeclaration(cur)) {
        const direct = ownerByNode.get(cur);
        if (direct) return direct;
        if (cur.parent?.parent && ts.isVariableStatement(cur.parent.parent)) {
          return ownerByNode.get(cur.parent.parent);
        }
      }
      return undefined;
    }
    return undefined;
  };

  /**
   * When a local function identifier (`createApplication`, `View`, `createETagGenerator`) is on the
   * right-hand side of a top-level CommonJS export assignment (`exports = module.exports = createApplication`,
   * `module.exports = View`, or `exports.etag = createETagGenerator(...)`), returns the owner id
   * registered for that CommonJS export contract.
   */
  const findCjsExportOwnerId = (idNode: ts.Identifier): string | undefined => {
    for (let cur: ts.Node | undefined = idNode.parent; cur; cur = cur.parent) {
      if (isFunctionLikeNode(cur)) return undefined;
      if (ts.isShorthandPropertyAssignment(cur) || ts.isPropertyAssignment(cur)) {
        const owner = ownerByNode.get(cur);
        if (owner) return owner;
      }
      if (ts.isBinaryExpression(cur) && isInsideNode(idNode, cur.right)) {
        const owner = ownerByNode.get(cur);
        if (owner) return owner;
      }
    }
    return undefined;
  };

  /**
   * When a local function identifier is referenced as an object-literal property value (`{ getAll: localFn }`
   * or shorthand `{ localFn }`) on an exported 1-level or 2-level object literal contract, returns the
   * owner id registered for that property or enclosing statement.
   */
  const findObjectLiteralExportOwnerId = (idNode: ts.Identifier): string | undefined => {
    const parent = idNode.parent;
    if (
      !parent ||
      !((ts.isPropertyAssignment(parent) && parent.initializer === idNode) ||
        ts.isShorthandPropertyAssignment(parent))
    ) {
      return undefined;
    }
    for (let cur: ts.Node | undefined = parent; cur; cur = cur.parent) {
      if (isFunctionLikeNode(cur)) return undefined;
      const owner = ownerByNode.get(cur);
      if (owner) return owner;
    }
    return undefined;
  };

  let changed = true;
  while (changed) {
    changed = false;
    const propagate = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isIdentifierValueReference(node)) {
        const helperNode = localHelpersByName.get(node.text);
        if (helperNode && !preSeededHelperNodes.has(helperNode) && !isInsideNode(node, helperNode)) {
          const callerOwner =
            findScopeOwnerId(node, ownerByNode) ??
            (node.parent &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression !== node &&
            ts.isPropertyAccessExpression(node.parent.expression) &&
            (node.parent.expression.name.text === 'on' ||
              node.parent.expression.name.text === 'once' ||
              node.parent.expression.name.text === 'addListener')
              ? ownerByNode.get(node.parent)
              : undefined) ??
            findHocExportOwnerId(node) ??
            findCjsExportOwnerId(node) ??
            findObjectLiteralExportOwnerId(node);
          if (callerOwner) {
            if (!ownerByNode.has(helperNode)) {
              ownerByNode.set(helperNode, callerOwner);
              changed = true;
            }
            let owners = multiOwnersByHelperNode.get(helperNode);
            if (!owners) {
              owners = new Set<string>();
              multiOwnersByHelperNode.set(helperNode, owners);
            }
            if (!owners.has(callerOwner)) {
              owners.add(callerOwner);
              changed = true;
            }
            // If `node` is inside another local helper, transitively propagate all owners of that caller helper
            for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
              const parentHelperOwners = multiOwnersByHelperNode.get(cur);
              if (parentHelperOwners) {
                for (const po of parentHelperOwners) {
                  if (!owners.has(po)) {
                    owners.add(po);
                    changed = true;
                  }
                }
              }
            }
          }
        }
      } else if (
        ts.isPropertyAccessExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ThisKeyword ||
          isLocalThisAliasIdentifier(node.expression))
      ) {
        const cls = findEnclosingClass(node);
        const helperMethod = cls ? privateMethodsByClass.get(cls)?.get(node.name.text) : undefined;
        if (cls && helperMethod && !isInsideNode(node, helperMethod)) {
          const callerOwner = findScopeOwnerId(node, ownerByNode);
          const classOwner = ownerByNode.get(cls);
          if (callerOwner && callerOwner !== classOwner) {
            if (!ownerByNode.has(helperMethod)) {
              ownerByNode.set(helperMethod, callerOwner);
              changed = true;
            }
            let owners = multiOwnersByHelperNode.get(helperMethod);
            if (!owners) {
              owners = new Set<string>();
              multiOwnersByHelperNode.set(helperMethod, owners);
            }
            if (!owners.has(callerOwner)) {
              owners.add(callerOwner);
              changed = true;
            }
            for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
              const parentHelperOwners = multiOwnersByHelperNode.get(cur);
              if (parentHelperOwners) {
                for (const po of parentHelperOwners) {
                  if (!owners.has(po)) {
                    owners.add(po);
                    changed = true;
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, propagate);
    };
    propagate(sourceFile);
  }

  for (const [cls, methodMap] of privateMethodsByClass.entries()) {
    const classOwner = ownerByNode.get(cls);
    if (!classOwner) continue;
    for (const helperMethod of methodMap.values()) {
      const owners = multiOwnersByHelperNode.get(helperMethod);
      if (owners && owners.size > 2) {
        ownerByNode.set(helperMethod, classOwner);
        multiOwnersByHelperNode.set(helperMethod, new Set([classOwner]));
      }
    }
  }

  return multiOwnersByHelperNode;
}

/**
 * Returns every AST node whose execution is owned by an entity extracted at `anchor`.
 *
 * Usually that is just the anchor. For a fluent call chain the entity is extracted at the
 * innermost call, yet handlers passed to the chained calls are attached to that same entity:
 *
 * @example
 * app.route('/settings')                 // anchor → Express Route: ROUTE /settings
 *   .get((req, res) => res.send('a'))    // chained call → same owner
 *   .post((req, res) => res.send('b'));  // chained call → same owner
 *
 * @param anchor The AST node an entity was extracted from.
 * @returns The anchor followed by the outer calls of its method chain (innermost → outermost).
 */
export function ownershipAnchors(anchor: ts.Node): ts.Node[] {
  if (ts.isIfStatement(anchor)) {
    return [anchor.thenStatement];
  }
  const anchors: ts.Node[] = [anchor];
  if (ts.isPropertyAssignment(anchor)) {
    let init: ts.Node = anchor.initializer;
    while (
      ts.isParenthesizedExpression(init) ||
      ts.isAsExpression(init) ||
      ts.isSatisfiesExpression(init) ||
      ts.isTypeAssertionExpression(init) ||
      ts.isNonNullExpression(init)
    ) {
      init = init.expression;
    }
    if (isFunctionLikeNode(init)) {
      anchors.push(init);
    } else if (ts.isCallExpression(init)) {
      for (const arg of init.arguments) {
        if (isFunctionLikeNode(arg)) anchors.push(arg);
      }
    }
    return anchors;
  }
  if (ts.isBinaryExpression(anchor)) {
    let rhs: ts.Node = anchor.right;
    while (ts.isBinaryExpression(rhs)) {
      anchors.push(rhs);
      rhs = rhs.right;
    }
    return anchors;
  }
  if (!ts.isCallExpression(anchor)) return anchors;

  // When a route call wraps its inline handler in a HOF call (`router.get('/:id', wrap(async (req, res) => ...))`),
  // include the inner handler function in `anchors` so calls inside the handler body are owned by the route contract.
  if (anchor.arguments.length >= 2) {
    const lastArg = anchor.arguments[anchor.arguments.length - 1];
    if (ts.isCallExpression(lastArg)) {
      for (const innerArg of lastArg.arguments) {
        if (isFunctionLikeNode(innerArg)) {
          anchors.push(innerArg);
        }
      }
    }
  }

  let current: ts.Node = anchor;
  for (;;) {
    const access = current.parent;
    if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== current) break;
    const outerCall = access.parent;
    if (!outerCall || !ts.isCallExpression(outerCall) || outerCall.expression !== access) break;
    anchors.push(outerCall);
    current = outerCall;
  }
  return anchors;
}

function isLocalThisAliasIdentifier(expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const identName = expr.text;
  for (let cur: ts.Node | undefined = expr.parent; cur && !ts.isClassDeclaration(cur); cur = cur.parent) {
    if (ts.isBlock(cur)) {
      for (const stmt of cur.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.name.text === identName &&
            decl.initializer &&
            decl.initializer.kind === ts.SyntaxKind.ThisKeyword
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
 * Builds the implicit INIT_BLOCK boundary for a deployment unit.
 *
 * Evidence points at the first statement that proved the block exists, so the node stays
 * traceable even though it has no syntax of its own.
 *
 * @param deploymentUnitLabel Short label of the owning deployment unit (e.g. package or fixture name).
 * @param evidence            Evidence of the first relationship originating from the init block.
 * @returns A BOUNDARY StructuralEntity (id and parent are assigned by the orchestrator).
 */
export function createInitBlock(
  deploymentUnitLabel: string,
  evidence: EvidenceRecord
): StructuralEntity {
  return {
    id: '',
    name: `Init: ${deploymentUnitLabel}`,
    type: 'BOUNDARY',
    entityType: 'INIT_BLOCK',
    patternId: 'boundary.init-block',
    evidence,
  };
}
