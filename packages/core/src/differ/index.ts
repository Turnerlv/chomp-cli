import { RepresentationGraph, StructuralNode, StructuralEdge, EvidenceRecord } from "../types/ontology.js";
import { GraphDelta, DiffStatus, DiffNode, DiffEdge } from "../types/diff.js";

/**
 * Normalizes an array of EvidenceRecords or a single EvidenceRecord to a canonical array.
 *
 * Besides coercing to an array, the result is de-duplicated by the evidence identity key
 * `filePath:lineNumber:evidenceRole` (first occurrence wins) and sorted deterministically.
 * This mirrors the persisted graph, where the SQLite `UNIQUE` constraint already collapses
 * duplicate evidence rows, so that an in-memory graph carrying repeated records is not
 * reported as MODIFIED against its persisted counterpart. This simplifies deep equality
 * comparisons.
 */
function normalizeEvidence(evidence: EvidenceRecord | EvidenceRecord[]): EvidenceRecord[] {
  const list = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  const unique = new Map<string, EvidenceRecord>();
  for (const record of list) {
    const key = `${record.filePath}:${record.lineNumber}:${record.evidenceRole}`;
    if (!unique.has(key)) {
      unique.set(key, record);
    }
  }
  return Array.from(unique.values()).sort(
    (x, y) =>
      x.filePath.localeCompare(y.filePath) ||
      String(x.evidenceRole).localeCompare(String(y.evidenceRole)) ||
      (x.lineNumber ?? 0) - (y.lineNumber ?? 0)
  );
}

/**
 * Deep compares two arrays of EvidenceRecords.
 *
 * Both inputs are expected to be canonical (see {@link normalizeEvidence}): de-duplicated
 * and deterministically ordered.
 */
function getEvidenceStatus(a: EvidenceRecord[], b: EvidenceRecord[]): 'UNCHANGED' | 'MODIFIED' | 'LEXICAL_SHIFT' {
  if (a.length !== b.length) return 'MODIFIED';

  let hasLexicalShift = false;
  for (let i = 0; i < a.length; i++) {
    const ea = a[i];
    const eb = b[i];
    
    // If the actual file or structural snippet changed, it's structurally modified
    if (ea.filePath !== eb.filePath || ea.snippet !== eb.snippet || ea.evidenceRole !== eb.evidenceRole) {
      return 'MODIFIED';
    }
    
    // If only the line number drifted, it's a lexical shift
    if (ea.lineNumber !== eb.lineNumber) {
      hasLexicalShift = true;
    }
  }
  return hasLexicalShift ? 'LEXICAL_SHIFT' : 'UNCHANGED';
}

const ENRICHED_METADATA_KEYS = new Set([
  'domain',
  'humanLabel',
  'summary',
  'rationale',
  'flags',
  'telemetry',
]);

function normalizeStructuralMetadata(meta?: Record<string, any>): Record<string, any> {
  if (!meta || typeof meta !== 'object') return {};
  const sorted: Record<string, any> = {};
  for (const key of Object.keys(meta).sort()) {
    if (ENRICHED_METADATA_KEYS.has(key)) continue;
    if (meta[key] !== undefined) {
      sorted[key] = meta[key];
    }
  }
  return sorted;
}

const EXTRACTOR_UPGRADE_METADATA_KEYS = [
  'shapeKey',
  'portValves',
  'isImportedInRepo',
  'unresolvedIncoming',
  'unresolvedOutgoing',
  'unresolvedReason',
  'expectedTargetId',
  'importSpecifier',
  'resolvedFilePath',
  'targetSymbol',
] as const;

/**
 * Deep compares AST-structural metadata (ignoring semantic enrichment overlays
 * such as `domain`, `humanLabel`, `summary`, `rationale`, and `telemetry` that
 * live only in the persisted database).
 */
function isMetadataEqual(a?: Record<string, any>, b?: Record<string, any>): boolean {
  const na = normalizeStructuralMetadata(a);
  const nb = normalizeStructuralMetadata(b);
  // v5 Loop 1/3: a `shapeKey` or diagnostic metadata key present on only one side means the base
  // graph was extracted by an older extractor (or a newer one is being compared against it) — an
  // extractor upgrade, not a structural change in the user's code. Two PRESENT keys that differ
  // still count as MODIFIED.
  for (const key of EXTRACTOR_UPGRADE_METADATA_KEYS) {
    if ((na[key] === undefined) !== (nb[key] === undefined)) {
      delete na[key];
      delete nb[key];
    }
  }
  return JSON.stringify(na) === JSON.stringify(nb);
}

/**
 * Determines if an entity (Node or Edge) has been modified between the base and current graph.
 */
function getModificationStatus(baseObj: any, currentObj: any): 'UNCHANGED' | 'MODIFIED' | 'LEXICAL_SHIFT' {
  if (baseObj.parentBoundaryId !== currentObj.parentBoundaryId) return 'MODIFIED';
  if (baseObj.sourceId !== currentObj.sourceId) return 'MODIFIED';
  if (baseObj.targetId !== currentObj.targetId) return 'MODIFIED';
  
  if (!isMetadataEqual(baseObj.metadata, currentObj.metadata)) return 'MODIFIED';
  
  const evidenceStatus = getEvidenceStatus(normalizeEvidence(baseObj.evidence), normalizeEvidence(currentObj.evidence));
  return evidenceStatus;
}

function deduplicateNodes(nodes: StructuralNode[]): StructuralNode[] {
  const map = new Map<string, StructuralNode>();
  for (const n of nodes) {
    if (map.has(n.id)) {
      const existing = map.get(n.id)!;
      existing.evidence = [...normalizeEvidence(existing.evidence), ...normalizeEvidence(n.evidence)];
    } else {
      map.set(n.id, { ...n, evidence: [...normalizeEvidence(n.evidence)] });
    }
  }
  return Array.from(map.values());
}

function deduplicateEdges(edges: StructuralEdge[]): StructuralEdge[] {
  const map = new Map<string, StructuralEdge>();
  for (const e of edges) {
    if (map.has(e.id)) {
      const existing = map.get(e.id)!;
      existing.evidence = [...normalizeEvidence(existing.evidence), ...normalizeEvidence(e.evidence)];
    } else {
      map.set(e.id, { ...e, evidence: [...normalizeEvidence(e.evidence)] });
    }
  }
  return Array.from(map.values());
}

/**
 * Compares two Chomp graphs and computes the structural drift.
 * 
 * @param base - The previously committed representation graph
 * @param current - The fresh representation graph from the working directory
 * @returns A GraphDelta mapping nodes and edges to their diff status and preserving base/target integrity.
 */
export function compareGraphs(base: RepresentationGraph, current: RepresentationGraph): GraphDelta {
  const diff: GraphDelta = {
    baseCommitSha: base.commitSha,
    targetCommitSha: current.commitSha,
    nodes: {},
    edges: {}
  };

  const baseNodes = deduplicateNodes(base.nodes);
  const currentNodes = deduplicateNodes(current.nodes);

  const baseNodeMap = new Map(baseNodes.map(n => [n.id, n]));
  const currentNodeMap = new Map(currentNodes.map(n => [n.id, n]));

  // 1. Process current nodes (find ADDED, MODIFIED, UNCHANGED)
  for (const currentNode of currentNodes) {
    const baseNode = baseNodeMap.get(currentNode.id);
    if (!baseNode) {
      diff.nodes[currentNode.id] = { status: 'ADDED', target: currentNode };
    } else {
      const status = getModificationStatus(baseNode, currentNode);
      diff.nodes[currentNode.id] = { status, base: baseNode, target: currentNode };
    }
  }

  // 2. Process base nodes (find REMOVED)
  for (const baseNode of baseNodes) {
    if (!currentNodeMap.has(baseNode.id)) {
      diff.nodes[baseNode.id] = { status: 'REMOVED', base: baseNode };
    }
  }

  const baseEdges = deduplicateEdges(base.edges);
  const currentEdges = deduplicateEdges(current.edges);

  const baseEdgeMap = new Map(baseEdges.map(e => [e.id, e]));
  const currentEdgeMap = new Map(currentEdges.map(e => [e.id, e]));

  // 3. Process current edges
  for (const currentEdge of currentEdges) {
    const baseEdge = baseEdgeMap.get(currentEdge.id);
    if (!baseEdge) {
      diff.edges[currentEdge.id] = { status: 'ADDED', target: currentEdge };
    } else {
      const status = getModificationStatus(baseEdge, currentEdge);
      diff.edges[currentEdge.id] = { status, base: baseEdge, target: currentEdge };
    }
  }

  // 4. Process base edges (find REMOVED)
  for (const baseEdge of baseEdges) {
    if (!currentEdgeMap.has(baseEdge.id)) {
      diff.edges[baseEdge.id] = { status: 'REMOVED', base: baseEdge };
    }
  }

  return diff;
}
