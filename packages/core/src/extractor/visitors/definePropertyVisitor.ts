// packages/core/src/extractor/visitors/definePropertyVisitor.ts
// Visitor for extracting Object.defineProperty getter contracts.

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { applyConventionRules } from '../conventions/engine.js';
import { CORE_CONVENTIONS } from '../conventions/core.js';

/**
 * Extracts Object.defineProperty / defineGetter calls via `CORE_CONVENTIONS`
 * (`core.define-property-getter`, `[PAT-EXT-28]`).
 */
export function extractDefinePropertyContract(
  node: ts.Node,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | null {
  const entities = applyConventionRules(
    CORE_CONVENTIONS,
    ['core.define-property-getter'],
    node,
    null,
    '',
    getEvidence,
    nextId
  );
  return entities[0] ?? null;
}
