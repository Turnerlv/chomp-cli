// packages/core/src/extractor/visitors/factoryExportVisitor.ts
// Visitor for contracts created by exporting the result of known factory functions.
//
// Structural patterns handled:
//   - NextAuth factory destructure -> CONTRACT (e.g. `export const { auth, signIn } = NextAuth(...)`)
//   - Drizzle-Zod validator export -> CONTRACT (e.g. `export const insertSchema = createInsertSchema(...)`)

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { applyConventionRules } from '../conventions/engine.js';
import { CORE_CONVENTIONS } from '../conventions/core.js';

const FACTORY_RULE_IDS = [
  'core.nextauth-factory-destructure',
  'core.drizzle-exported-validator',
  'core.drizzle-namespaced-table-schema',
  'core.zod-exported-validator',
] as const;

const DRIZZLE_VALIDATOR_CALLEES = new Set([
  'createInsertSchema',
  'createSelectSchema',
  'createUpdateSchema',
]);

const RUNTYPES_VALIDATOR_CALLEES = new Set([
  'Record',
  'Union',
  'Intersect',
  'Tuple',
  'Array',
  'Dictionary',
]);

function fileHasDrizzleImport(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      (stmt.moduleSpecifier.text.startsWith('drizzle-orm') ||
        stmt.moduleSpecifier.text.startsWith('drizzle-zod'))
    ) {
      return true;
    }
  }
  return false;
}

function fileHasRuntypesImport(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      (stmt.moduleSpecifier.text === 'runtypes' ||
        stmt.moduleSpecifier.text.startsWith('runtypes/'))
    ) {
      return true;
    }
  }
  return false;
}

function isDrizzleZodHelperNode(node: ts.Node): boolean {
  if (!ts.isVariableStatement(node)) return false;
  for (const decl of node.declarationList.declarations) {
    if (
      decl.initializer &&
      ts.isCallExpression(decl.initializer) &&
      ts.isIdentifier(decl.initializer.expression) &&
      DRIZZLE_VALIDATOR_CALLEES.has(decl.initializer.expression.text)
    ) {
      return true;
    }
  }
  return false;
}

function extractRuntypesValidators(
  node: ts.Node,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity[] {
  if (
    !ts.isVariableStatement(node) ||
    !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    return [];
  }
  const sf = node.getSourceFile();
  if (!sf || !fileHasRuntypesImport(sf)) return [];

  const out: StructuralEntity[] = [];
  for (const decl of node.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) {
      continue;
    }
    let callExpr: ts.CallExpression = decl.initializer;
    while (
      ts.isPropertyAccessExpression(callExpr.expression) &&
      (callExpr.expression.name.text === 'withBrand' ||
        callExpr.expression.name.text === 'withConstraint' ||
        callExpr.expression.name.text === 'Or' ||
        callExpr.expression.name.text === 'And') &&
      ts.isCallExpression(callExpr.expression.expression)
    ) {
      callExpr = callExpr.expression.expression;
    }
    if (
      ts.isIdentifier(callExpr.expression) &&
      RUNTYPES_VALIDATOR_CALLEES.has(callExpr.expression.text)
    ) {
      out.push({
        id: nextId(),
        name: `VALIDATOR_SCHEMA: ${decl.name.text}`,
        type: 'CONTRACT',
        entityType: 'VALIDATOR_SCHEMA',
        patternId: 'contract.zod-exported-validator',
        evidence: getEvidence(node),
      });
    }
  }
  return out;
}

/**
 * Extracts CONTRACT entities from variable statements that export the result
 * of known framework factory functions via `CORE_CONVENTIONS` (`[PAT-EXT-28]`).
 */
export function extractFactoryExport(
  node: ts.Node,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | StructuralEntity[] | null {
  const results = applyConventionRules(
    CORE_CONVENTIONS,
    FACTORY_RULE_IDS,
    node,
    null,
    '',
    getEvidence,
    nextId
  );
  const runtypesResults = extractRuntypesValidators(node, getEvidence, nextId);
  if (runtypesResults.length > 0) {
    const existingNames = new Set(results.map((r) => r.name));
    for (const rt of runtypesResults) {
      if (!existingNames.has(rt.name)) {
        results.push(rt);
      }
    }
  }
  if (results.length === 0) return null;
  const sf = node.getSourceFile();
  if (sf && !fileHasDrizzleImport(sf) && !isDrizzleZodHelperNode(node)) {
    for (const r of results) {
      if (r.patternId === 'contract.drizzle-exported-validator') {
        r.patternId = 'contract.zod-exported-validator';
      }
    }
  }
  return results;
}
