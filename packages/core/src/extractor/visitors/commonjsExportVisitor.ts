// packages/core/src/extractor/visitors/commonjsExportVisitor.ts
// Visitor for extracting CommonJS module exports and aliased exports.

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { applyConventionRules } from '../conventions/engine.js';
import { CORE_CONVENTIONS } from '../conventions/core.js';

const COMMONJS_RULE_IDS = [
  'core.commonjs-prototype-method',
  'core.commonjs-export-alias',
  'core.commonjs-dynamic-method',
  'core.commonjs-export',
] as const;

/**
 * Extracts CommonJS module exports, prototype methods, and aliased exports
 * via `CORE_CONVENTIONS` (`[PAT-EXT-28]`).
 */
export function extractCommonjsExport(
  node: ts.Node,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | null {
  const entities = applyConventionRules(
    CORE_CONVENTIONS,
    COMMONJS_RULE_IDS,
    node,
    null,
    '',
    getEvidence,
    nextId
  );
  return entities[0] ?? null;
}
