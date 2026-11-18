// packages/core/src/extractor/visitors/directiveVisitor.ts
// Visitor for file-level directive prologues and server-boundary guards.
//
// Ontology v4.0: framework directives are NOT contracts. They are deployment-topology annotations
// recorded as `metadata.runtime` on the contracts of the source unit they apply to.
//
// Structural patterns handled:
//   - 'use server' directive  → runtime: 'server'  (metadata, not a node)
//   - 'use client' directive  → runtime: 'client'  (metadata, not a node)
//   - import 'server-only'    → CONTRACT (SERVER_GUARD) — prevents client-bundle inclusion

import ts from 'typescript';
import { EvidenceRecord, RuntimeContext, StructuralEntity } from '../../types/index.js';
import { applyConventionRules } from '../conventions/engine.js';
import { CORE_CONVENTIONS } from '../conventions/core.js';

/** Directive string values that have structural significance in Next.js, mapped to their runtime. */
const NEXTJS_DIRECTIVE_RUNTIMES: Record<string, RuntimeContext> = {
  'use server': 'server',
  'use client': 'client',
};

/**
 * Reads the file-level Next.js directive prologue and returns its runtime context.
 *
 * Matches top-level `ExpressionStatement` nodes whose sole expression is a `StringLiteral` with
 * value `'use server'` or `'use client'` appearing in the directive prologue (before any
 * non-directive statement).
 *
 * @example
 * 'use client';                 // → 'client'
 * 'use server';                 // → 'server'
 *
 * @param sourceFile The TypeScript SourceFile to inspect.
 * @returns The runtime context declared by the directive, or undefined when the file has none.
 */
export function extractDirectiveRuntime(sourceFile: ts.SourceFile): RuntimeContext | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    const runtime = NEXTJS_DIRECTIVE_RUNTIMES[statement.expression.text];
    if (runtime) return runtime;
  }
  return undefined;
}

/**
 * Extracts an `import 'server-only'` side-effect import as a SERVER_GUARD CONTRACT
 * via `CORE_CONVENTIONS` (`core.server-only-guard`, `[PAT-EXT-28]`).
 */
export function extractServerOnlyGuard(
  node: ts.Node,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | null {
  const entities = applyConventionRules(
    CORE_CONVENTIONS,
    ['core.server-only-guard'],
    node,
    null,
    '',
    getEvidence,
    nextId
  );
  return entities[0] ?? null;
}
