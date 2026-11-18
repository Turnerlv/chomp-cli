// packages/core/src/extractor/adapters/drizzleAdapter.ts
// Framework-specific adapter for Drizzle ORM (`[PAT-EXT-28]`).
//
// The conventions are DATA — see `../conventions/drizzle.ts`. This file keeps the function
// signatures the visitors call and delegates to the table.

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { DRIZZLE_CONVENTIONS } from '../conventions/drizzle.js';
import { applyConventionRules } from '../conventions/engine.js';

type Evidence = (node: ts.Node) => EvidenceRecord;

function apply(
  ruleIds: readonly string[],
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] {
  return applyConventionRules(DRIZZLE_CONVENTIONS, ruleIds, node, null, '', getEvidence, nextId);
}

/**
 * Extracts a Drizzle schema definition as a CONTRACT (`pgTable`, `mysqlTable`, `sqliteTable`, `pgEnum`).
 */
export function extractDrizzleSchemaContract(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return apply(['drizzle.schema'], node, getEvidence, nextId)[0] ?? null;
}

function unwrapPrepareInitializer(expr: ts.Expression | undefined): ts.CallExpression | null {
  if (!expr) return null;
  let cur: ts.Expression = expr;
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
  if (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    cur.expression.name.text === 'prepare'
  ) {
    return cur;
  }
  return null;
}

function hasExecuteCallForPreparedVar(varName: string, scopeNode: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'execute' &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === varName
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(scopeNode);
  return found;
}

function findPreparedDrizzleDeclaration(
  varName: string,
  fromNode: ts.Node
): ts.CallExpression | null {
  for (let cur: ts.Node | undefined = fromNode.parent; cur; cur = cur.parent) {
    let stmts: ts.NodeArray<ts.Statement> | undefined;
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur)) {
      stmts = cur.statements;
    }
    if (!stmts) continue;
    for (const stmt of stmts) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === varName) {
          const prep = unwrapPrepareInitializer(decl.initializer);
          if (prep) return prep;
        }
      }
    }
  }
  return null;
}

function isDeferredPreparedCall(node: ts.CallExpression): boolean {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== 'prepare'
  ) {
    return false;
  }
  let holder: ts.Node | undefined = node.parent;
  while (
    holder &&
    (ts.isParenthesizedExpression(holder) ||
      ts.isAsExpression(holder) ||
      ts.isSatisfiesExpression(holder) ||
      ts.isTypeAssertionExpression(holder) ||
      ts.isNonNullExpression(holder) ||
      ts.isAwaitExpression(holder))
  ) {
    holder = holder.parent;
  }
  if (!holder || !ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name)) {
    return false;
  }
  const varName = holder.name.text;
  const scopeNode = holder.getSourceFile();
  return scopeNode ? hasExecuteCallForPreparedVar(varName, scopeNode) : false;
}

/**
 * Extracts a Drizzle query chain as an OPEN_CONNECTOR (paired with a `READS`/`MUTATES` schema
 * relationship when the chain names a schema table).
 *
 * When a query is hoisted into a `.prepare()` variable (`const p1 = db.select()...prepare()`)
 * and later invoked via `p1.execute(...)` inside route handlers or child functions, defers
 * emitting the `DB_QUERY` + `READS`/`MUTATES` entities to each `p1.execute(...)` call site so
 * edges attach to the executing route handler rather than bleeding onto the outer factory scope.
 */
export function extractDrizzleQueryChain(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | StructuralEntity[] | null {
  if (ts.isCallExpression(node)) {
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'execute' &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const prepCall = findPreparedDrizzleDeclaration(node.expression.expression.text, node);
      if (prepCall) {
        const prepResults = apply(['drizzle.query-chain'], prepCall, getEvidence, nextId);
        if (prepResults.length > 0) {
          const execEv = getEvidence(node);
          for (const ent of prepResults) {
            ent.evidence = execEv;
          }
          return prepResults.length === 1 ? prepResults[0] : prepResults;
        }
      }
    }
    if (isDeferredPreparedCall(node)) {
      return null;
    }
  }
  const results = apply(['drizzle.query-chain'], node, getEvidence, nextId);
  if (results.length === 0) return null;
  return results.length === 1 ? results[0] : results;
}

/**
 * Returns true when `node` is an intermediate/base call inside a fluent method chain whose
 * topmost call matches `drizzle.query-chain` (e.g. the inner `db.insert(t)` inside
 * `db.insert(t).values(...)`), or a `.prepare()` call deferred to `.execute()`, preventing
 * duplicate generic `DB Call:` connectors.
 */
export function isInnerDrizzleQueryChainCall(
  node: ts.CallExpression,
  getEvidence: Evidence,
  nextId: () => string
): boolean {
  if (isDeferredPreparedCall(node) && apply(['drizzle.query-chain'], node, getEvidence, nextId).length > 0) {
    return true;
  }
  let current: ts.CallExpression = node;
  while (
    current.parent &&
    ts.isPropertyAccessExpression(current.parent) &&
    current.parent.expression === current &&
    current.parent.parent &&
    ts.isCallExpression(current.parent.parent) &&
    current.parent.parent.expression === current.parent
  ) {
    current = current.parent.parent;
  }
  if (current === node) return false;
  return apply(['drizzle.query-chain'], current, getEvidence, nextId).length > 0;
}
