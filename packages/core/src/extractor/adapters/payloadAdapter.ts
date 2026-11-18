// packages/core/src/extractor/adapters/payloadAdapter.ts
// Framework-specific adapter for Payload CMS (`[PAT-EXT-28]`).
//
// The conventions are DATA — see `../conventions/payload.ts`. This file keeps the function
// signatures the visitors call and delegates every rule to the table (zero escape hatches).

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { PAYLOAD_CONVENTIONS } from '../conventions/payload.js';
import { applyConventionRules, applyEdgeRules } from '../conventions/engine.js';

type Evidence = (node: ts.Node) => EvidenceRecord;

function applyNode(
  ruleIds: readonly string[],
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] {
  return applyConventionRules(PAYLOAD_CONVENTIONS, ruleIds, node, null, '', getEvidence, nextId);
}

export function extractPayloadCollectionConfig(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return applyNode(['payload.collection-config', 'payload.global-config'], node, getEvidence, nextId)[0] ?? null;
}

export function extractPayloadConfigRegistry(
  node: ts.Node,
  _sourceFile: ts.SourceFile,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] | null {
  const results = applyEdgeRules(
    PAYLOAD_CONVENTIONS,
    ['payload.config-registry-collection', 'payload.config-registry-global', 'payload.plugin-registration'],
    node,
    '',
    getEvidence,
    nextId
  );
  return results.length > 0 ? results : null;
}

export function extractPayloadContracts(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return applyNode(['payload.fields', 'payload.endpoints', 'payload.access'], node, getEvidence, nextId)[0] ?? null;
}

export function extractPayloadHooks(
  node: ts.Node,
  _sourceFile: ts.SourceFile,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] | null {
  const results = applyEdgeRules(
    PAYLOAD_CONVENTIONS,
    ['payload.hook-registration'],
    node,
    '',
    getEvidence,
    nextId
  );
  return results.length > 0 ? results : null;
}

export function extractPayloadOpenConnectors(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | StructuralEntity[] | null {
  const results = applyNode(
    [
      'payload.transaction',
      'payload.db-adapter-operation',
      'payload.job-dispatch',
      'payload.local-api-call',
      'payload.mongoose-operation',
    ],
    node,
    getEvidence,
    nextId
  );
  if (results.length === 0) return null;
  return results.length === 1 ? results[0] : results;
}

export function extractPayloadTypeRefContracts(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return applyNode(['payload.block', 'payload.task'], node, getEvidence, nextId)[0] ?? null;
}
