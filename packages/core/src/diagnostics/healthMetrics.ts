// packages/core/src/diagnostics/healthMetrics.ts
//
// Canonical 4-metric structural health & call-resolution classification engine (`[PAT-EXT-27]`, `[PAT-VIS-29]`).
//
// Builds directly on `shapeResolution.ts` (`isKnowableShapeKey`, `isLikelyBuiltinCallEdge`) as the single
// source of truth so `chomp health`, `chomp ui`, `chomp_audit_health`, `auditScoutSanity`, and
// `chomp-research ledger pattern measure` never drift.

import type { RepresentationGraph, StructuralEdge, StructuralNode } from '../types/index.js';
import { isKnowableShapeKey, isLikelyBuiltinCallEdge } from './shapeResolution.js';

export const CONNECTIVITY_TARGET_TYPES = new Set<string>([
  'CALL',
  'INHERITS',
  'MIXES',
  'RENDERS',
  'BINDS_ROUTE',
  'INTERCEPTS',
]);

/**
 * Explicit Layer 0 resolution classification for a call-family relationship edge:
 * - `'RESOLVED'`: Target contract, boundary, or open connector deterministically or heuristically linked (`Boolean(edge.targetId)`).
 * - `'KNOWABLE_GAP'`: Unresolved non-builtin call whose receiver binding is statically knowable (`Import`, `LocalFunction`, `LocalClass`, `LocalFromCall`, `This`, etc.) — an actionable extractor gap.
 * - `'DYNAMIC_BOUNDARY'`: Unresolved non-builtin call whose receiver is intrinsically runtime-dynamic (`Param`, `ParamDestructured`, `Loop`, `Catch`, `Undeclared`, `None`) — the honest "Road Ends" static boundary.
 * - `'PLATFORM_PRIMITIVE'`: Unresolved call to a standard JS/DOM/Node platform primitive (`Array.map`, `Math.max`, `JSON.parse`, `Promise.all`) (`[PAT-EXT-05]`).
 */
export type CallResolutionClass =
  | 'RESOLVED'
  | 'KNOWABLE_GAP'
  | 'DYNAMIC_BOUNDARY'
  | 'PLATFORM_PRIMITIVE';

export interface CallResolutionCounts {
  totalCallFamilyEdges: number;
  provableCallCount: number;
  resolvedCount: number;
  knowableGapCount: number;
  dynamicBoundaryCount: number;
  platformPrimitiveCount: number;
  unprovableFallbackCount: number;
}

export interface StructuralHealthMetrics {
  status: 'PASS' | 'WARN';
  /** Legacy gated connectivity rate (excludes `relationship.invoke-returned-function` with `!targetId`), preserved for backward compatibility. */
  connectivityRate: number;
  /** Raw CALL-family resolution rate across all user-scope call-family edges. */
  rawConnectivityRate: number;
  /** Knowable connectivity rate: `resolvedCount / (resolvedCount + knowableGapCount) * 100`. */
  knowableConnectivityRate: number;
  entityTypeCoverage: number;
  parentCoverage: number;
  scopePurity: number;
  callResolutionCounts: CallResolutionCounts;
  entityCounts: {
    totalEntities: number;
    boundaries: number;
    contracts: number;
    relationships: number;
    openConnectors: number;
  };
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

export function isUnprovableFallbackCallEdge(edge: StructuralEdge): boolean {
  return edge.patternId === 'relationship.invoke-returned-function' && !edge.targetId;
}

/**
 * Classifies a call-family edge into its explicit Layer 0 resolution class using
 * `isKnowableShapeKey` and `isLikelyBuiltinCallEdge` from `shapeResolution.ts`.
 */
export function classifyCallEdgeResolution(edge: StructuralEdge): CallResolutionClass {
  if (edge.targetId) {
    return 'RESOLVED';
  }
  if (isLikelyBuiltinCallEdge(edge.name)) {
    return 'PLATFORM_PRIMITIVE';
  }
  const shapeKey = edge.metadata?.shapeKey;
  if (
    isUnprovableFallbackCallEdge(edge) &&
    typeof shapeKey === 'string' &&
    shapeKey.startsWith('sk1/CALL/Import/Chain(') &&
    !edge.metadata?.unresolvedReason
  ) {
    return 'DYNAMIC_BOUNDARY';
  }
  if (typeof shapeKey === 'string' && !isKnowableShapeKey(shapeKey)) {
    return 'DYNAMIC_BOUNDARY';
  }
  return 'KNOWABLE_GAP';
}

/**
 * Computes the canonical 4-metric structural health summary and 4-class call resolution breakdown
 * for a full `RepresentationGraph` or a package-level `(nodes, edges)` slice.
 */
export function computeStructuralHealthMetrics(
  graph: Pick<RepresentationGraph, 'nodes' | 'edges'>
): StructuralHealthMetrics {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const allEntities: Array<StructuralNode | StructuralEdge> = [...nodes, ...edges];

  const callFamilyEdges = edges.filter(
    (r) =>
      Boolean(r.entityType && CONNECTIVITY_TARGET_TYPES.has(r.entityType)) &&
      (r.scope ?? 'USER') === 'USER' &&
      !r.metadata?.crossScopeFiltered
  );

  let resolvedCount = 0;
  let knowableGapCount = 0;
  let dynamicBoundaryCount = 0;
  let platformPrimitiveCount = 0;
  let unprovableFallbackCount = 0;

  for (const edge of callFamilyEdges) {
    if (isUnprovableFallbackCallEdge(edge)) {
      unprovableFallbackCount++;
    }
    const cls = classifyCallEdgeResolution(edge);
    switch (cls) {
      case 'RESOLVED':
        resolvedCount++;
        break;
      case 'KNOWABLE_GAP':
        knowableGapCount++;
        break;
      case 'DYNAMIC_BOUNDARY':
        dynamicBoundaryCount++;
        break;
      case 'PLATFORM_PRIMITIVE':
        platformPrimitiveCount++;
        break;
    }
  }

  const provableCallCount = callFamilyEdges.length - unprovableFallbackCount;
  const connectivityRate =
    provableCallCount > 0 ? round1((resolvedCount / provableCallCount) * 100) : 100;
  const rawConnectivityRate =
    callFamilyEdges.length > 0 ? round1((resolvedCount / callFamilyEdges.length) * 100) : 100;
  const knowableDenomin = resolvedCount + knowableGapCount;
  const knowableConnectivityRate =
    knowableDenomin > 0 ? round1((resolvedCount / knowableDenomin) * 100) : 100;

  const entitiesWithKnownType = allEntities.filter(
    (e) => Boolean(e.entityType && e.entityType !== 'UNKNOWN')
  ).length;
  const entityTypeCoverage =
    allEntities.length > 0 ? round1((entitiesWithKnownType / allEntities.length) * 100) : 100;

  const contracts = nodes.filter((n) => n.type === 'CONTRACT');
  const contractsWithParent = contracts.filter((c) => Boolean(c.parentBoundaryId)).length;
  const parentCoverage =
    contracts.length > 0 ? round1((contractsWithParent / contracts.length) * 100) : 100;

  const productionEntities = allEntities.filter(
    (e) => e.scope === 'USER' || !e.scope
  ).length;
  const scopePurity =
    allEntities.length > 0 ? round1((productionEntities / allEntities.length) * 100) : 100;

  const pass =
    connectivityRate >= 80 &&
    entityTypeCoverage === 100 &&
    parentCoverage === 100 &&
    scopePurity >= 95;

  return {
    status: pass ? 'PASS' : 'WARN',
    connectivityRate,
    rawConnectivityRate,
    knowableConnectivityRate,
    entityTypeCoverage,
    parentCoverage,
    scopePurity,
    callResolutionCounts: {
      totalCallFamilyEdges: callFamilyEdges.length,
      provableCallCount,
      resolvedCount,
      knowableGapCount,
      dynamicBoundaryCount,
      platformPrimitiveCount,
      unprovableFallbackCount,
    },
    entityCounts: {
      totalEntities: allEntities.length,
      boundaries: nodes.filter((n) => n.type === 'BOUNDARY').length,
      contracts: contracts.length,
      relationships: edges.length,
      openConnectors: nodes.filter((n) => n.type === 'OPEN_CONNECTOR').length,
    },
  };
}
