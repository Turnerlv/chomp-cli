// packages/core/src/extractor/visitors/boundaryVisitor.ts
// Visitor for BOUNDARY primitives — scopes of LOGICAL encapsulation.
//
// Ontology v4.0 (Ephemeral Code): files and directories are positional metadata, never boundaries.
// A BOUNDARY is strictly one of:
//   - DEPLOYMENT_UNIT  (workspace package / analyzed target)   → emitted by the orchestrator
//   - CLASS            (instantiable blueprint)                → this visitor
//   - NAMESPACE        (pure logical grouping of contracts)    → this visitor
//   - INIT_BLOCK       (implicit top-level side-effect scope)  → initBlockVisitor.ts
//
// External packages are OPEN_CONNECTORs (openConnectorVisitor.ts); module/export surfaces,
// middleware, pages and layouts are CONTRACTs (contractVisitor.ts).

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';

/**
 * Inspects a single AST node and returns a BOUNDARY entity if it is a logical encapsulation scope.
 *
 * Currently handled patterns:
 * - ClassDeclaration   (named classes only)                     → CLASS
 * - ModuleDeclaration  (`namespace X {}` / `module X {}` blocks) → NAMESPACE
 *
 * @example
 * export class UserService {}      // → Class: UserService
 * namespace Utils { }              // → Namespace: Utils
 *
 * @param node         The AST node to inspect.
 * @param sourceFile   TypeScript SourceFile object (unused today; kept for visitor signature parity).
 * @param getEvidence  Returns a populated EvidenceRecord for the given node.
 * @param nextId       Closure providing a placeholder ID — replaced by stableEntityId() in the orchestrator.
 * @returns A BOUNDARY StructuralEntity, or null if the node does not match any BOUNDARY pattern.
 */
function isAmbientOrGlobalModuleDeclaration(node: ts.ModuleDeclaration): boolean {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (ts.isModuleDeclaration(cur)) {
      if ((cur.flags & ts.NodeFlags.GlobalAugmentation) !== 0) return true;
      if (ts.isIdentifier(cur.name) && cur.name.text === 'global') return true;
      if (ts.isStringLiteral(cur.name)) return true;
      if (cur.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
    }
  }
  return false;
}

export function visitBoundary(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | StructuralEntity[] | null {
  if (
    ts.isClassDeclaration(node) &&
    node.name &&
    (ts.isSourceFile(node.parent) ||
      ts.isModuleBlock(node.parent) ||
      (ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0))
  ) {
    const isNestedInFactory = !ts.isSourceFile(node.parent) && !ts.isModuleBlock(node.parent);
    return {
      id: nextId(),
      name: `Class: ${node.name.text}`,
      type: 'BOUNDARY',
      entityType: 'CLASS',
      patternId: isNestedInFactory
        ? 'boundary.nested-class-declaration-in-factory'
        : 'boundary.class-declaration',
      evidence: getEvidence(node),
    };
  }
  if (ts.isModuleDeclaration(node) && !isAmbientOrGlobalModuleDeclaration(node)) {
    return {
      id: nextId(),
      name: `Namespace: ${node.name.text}`,
      type: 'BOUNDARY',
      entityType: 'NAMESPACE', patternId: 'boundary.namespace',
      evidence: getEvidence(node),
    };
  }
  return null;
}
