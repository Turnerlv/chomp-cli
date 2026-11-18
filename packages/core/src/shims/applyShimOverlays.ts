/**
 * packages/core/src/shims/applyShimOverlays.ts
 *
 * Pure Layer 1 (`L1_SHIMS`) overlay projection onto an in-memory `RepresentationGraph`.
 *
 * Architectural contract ([PAT-DB-03], [PAT-DB-05], AGENTS.md §4 & §9):
 *   - Zero database imports; operates strictly on in-memory `RepresentationGraph` + overlay payloads.
 *   - Never mutates the persisted Layer 0 graph in SQLite (`nodes` / `edges`).
 *   - Every shimmed wire is stamped `status: "INFERRED"` + `metadata.source: "USER_SHIM"` so Chomp
 *     distinguishes user/agent-declared local shims from deterministic Layer 0 AST proof while
 *     resolving covered `▲ N unresolved` call indicators, `OPAQUE BODY` contracts, and story lanes
 *     whenever the `L1_SHIMS` overlay layer is enabled.
 */

import type {
  EvidenceRecord,
  RepresentationGraph,
  StructuralEdge,
  StructuralNode,
} from "../types/ontology.js";
import { stableEntityId } from "../utils/id.js";

export const SHIM_OVERLAY_LAYER = "L1_SHIMS" as const;

export interface ShimmedEdgeOverlayEntry {
  /** Stable shim identifier from `.chomp/shims.json` or `chomp.config.json#shims`. */
  shimId: string;
  /** Source node ID (defaults to `overlay.entityId` when omitted). */
  sourceId: string;
  /** Resolved target contract, class, or open-connector node ID. */
  targetId: string;
  /** Human-readable relationship label (e.g. `Call: PaymentGateway.charge()`). */
  name: string;
  /** Relationship entity type (`CALL`, `RENDERS`, `MOUNT`, `INTERCEPTS`, `READS`, `MUTATES`, etc.). */
  entityType: string;
  /** Optional IDs of Layer 0 unresolved edges (`!edge.targetId`) resolved by this shim. */
  resolvedEdgeIds?: string[];
  /** Optional human/agent rationale explaining why this dynamic or bespoke link holds. */
  rationale?: string;
  /** Source-level evidence record(s) anchoring the shimmed relationship. */
  evidence: EvidenceRecord | EvidenceRecord[];
}

export interface ShimOverlayRecordLike {
  entityId: string;
  layer: string;
  payload: Record<string, unknown>;
}

export interface ApplyShimOverlaysOptions {
  /** When `false`, returns the original Layer 0 `graph` untouched (e.g. HUD EyeOff toggle). */
  enabled?: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidEvidence(v: unknown): v is EvidenceRecord | EvidenceRecord[] {
  if (Array.isArray(v)) {
    return v.length > 0 && v.every((item) => isObj(item) && typeof item.filePath === "string");
  }
  return isObj(v) && typeof v.filePath === "string";
}

function parseSyntheticConnector(raw: unknown): StructuralNode | null {
  if (!isObj(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.name !== "string" ||
    !raw.name ||
    raw.type !== "OPEN_CONNECTOR" ||
    typeof raw.entityType !== "string" ||
    !raw.entityType ||
    !isValidEvidence(raw.evidence)
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    type: "OPEN_CONNECTOR",
    entityType: raw.entityType,
    patternId: typeof raw.patternId === "string" && raw.patternId ? raw.patternId : "shim.open-connector",
    scope: "USER",
    evidence: raw.evidence,
    ...(typeof raw.parentBoundaryId === "string" ? { parentBoundaryId: raw.parentBoundaryId } : {}),
    metadata: {
      ...(isObj(raw.metadata) ? raw.metadata : {}),
      source: "USER_SHIM",
    },
  };
}

function parseShimmedEdgeEntry(raw: unknown, fallbackSourceId: string): ShimmedEdgeOverlayEntry | null {
  if (!isObj(raw)) return null;
  const shimId = typeof raw.shimId === "string" && raw.shimId.trim() ? raw.shimId.trim() : "";
  const sourceId =
    typeof raw.sourceId === "string" && raw.sourceId.trim() ? raw.sourceId.trim() : fallbackSourceId;
  const targetId = typeof raw.targetId === "string" && raw.targetId.trim() ? raw.targetId.trim() : "";
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "";
  if (!shimId || !sourceId || !targetId || !name || !isValidEvidence(raw.evidence)) {
    return null;
  }
  const entityType =
    typeof raw.entityType === "string" && raw.entityType.trim() ? raw.entityType.trim() : "CALL";
  const resolvedEdgeIds = Array.isArray(raw.resolvedEdgeIds)
    ? raw.resolvedEdgeIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;
  const rationale =
    typeof raw.rationale === "string" && raw.rationale.trim() ? raw.rationale.trim() : undefined;
  return {
    shimId,
    sourceId,
    targetId,
    name,
    entityType,
    ...(resolvedEdgeIds && resolvedEdgeIds.length > 0 ? { resolvedEdgeIds } : {}),
    ...(rationale ? { rationale } : {}),
    evidence: raw.evidence,
  };
}

/**
 * Projects active `L1_SHIMS` overlays onto a copy of `graph` without mutating `graph`.
 *
 * When `options.enabled === false` or no actionable `L1_SHIMS` entries exist, returns `graph` as-is.
 */
export function applyShimOverlaysToGraph(
  graph: RepresentationGraph,
  overlays: readonly ShimOverlayRecordLike[] | undefined | null,
  options?: ApplyShimOverlaysOptions,
): RepresentationGraph {
  if (options?.enabled === false || !overlays || overlays.length === 0) {
    return graph;
  }

  const shimOverlays = overlays.filter((o) => o.layer === SHIM_OVERLAY_LAYER && isObj(o.payload));
  if (shimOverlays.length === 0) {
    return graph;
  }

  const syntheticConnectors: StructuralNode[] = [];
  const shimmedEdges: ShimmedEdgeOverlayEntry[] = [];

  for (const ov of shimOverlays) {
    const rawConnectors = ov.payload.syntheticConnectors;
    if (Array.isArray(rawConnectors)) {
      for (const rc of rawConnectors) {
        const parsed = parseSyntheticConnector(rc);
        if (parsed) syntheticConnectors.push(parsed);
      }
    }
    const rawEdges = ov.payload.shimmedEdges;
    if (Array.isArray(rawEdges)) {
      for (const re of rawEdges) {
        const parsed = parseShimmedEdgeEntry(re, ov.entityId);
        if (parsed) shimmedEdges.push(parsed);
      }
    }
  }

  if (syntheticConnectors.length === 0 && shimmedEdges.length === 0) {
    return graph;
  }

  const nextNodes: StructuralNode[] = [...graph.nodes];
  const nodeIds = new Set<string>(nextNodes.map((n) => n.id));
  for (const conn of syntheticConnectors) {
    if (!nodeIds.has(conn.id)) {
      nextNodes.push(conn);
      nodeIds.add(conn.id);
    }
  }

  const nextEdges: StructuralEdge[] = graph.edges.map((e) => ({ ...e }));
  const edgeIndexById = new Map<string, number>();
  const existingResolvedPairs = new Set<string>();
  for (let i = 0; i < nextEdges.length; i++) {
    const e = nextEdges[i]!;
    edgeIndexById.set(e.id, i);
    if (e.targetId) {
      existingResolvedPairs.add(`${e.sourceId}->${e.targetId}::${e.entityType}`);
    }
  }

  const claimedUnresolvedEdgeIds = new Set<string>();
  let mutated = syntheticConnectors.length > 0 && nextNodes.length !== graph.nodes.length;

  for (const entry of shimmedEdges) {
    if (!nodeIds.has(entry.sourceId) || !nodeIds.has(entry.targetId)) {
      continue;
    }
    if (entry.sourceId === entry.targetId) {
      continue;
    }

    let wiredViaUnresolved = false;
    if (entry.resolvedEdgeIds && entry.resolvedEdgeIds.length > 0) {
      for (const unresolvedId of entry.resolvedEdgeIds) {
        const idx = edgeIndexById.get(unresolvedId);
        if (idx === undefined) continue;
        const candidate = nextEdges[idx]!;
        if (candidate.sourceId !== entry.sourceId) continue;

        if (!candidate.targetId && !claimedUnresolvedEdgeIds.has(unresolvedId)) {
          claimedUnresolvedEdgeIds.add(unresolvedId);
          nextEdges[idx] = {
            ...candidate,
            targetId: entry.targetId,
            status: "INFERRED",
            confidence: "HIGH",
            metadata: {
              ...(isObj(candidate.metadata) ? candidate.metadata : {}),
              source: "USER_SHIM",
              shimId: entry.shimId,
              shimmedFromUnresolved: true,
              ...(entry.rationale ? { shimRationale: entry.rationale } : {}),
            },
          };
          existingResolvedPairs.add(`${entry.sourceId}->${entry.targetId}::${candidate.entityType}`);
          wiredViaUnresolved = true;
          mutated = true;
        }
      }
    }

    const pairKey = `${entry.sourceId}->${entry.targetId}::${entry.entityType}`;
    if (!wiredViaUnresolved && !existingResolvedPairs.has(pairKey)) {
      const edgeId = stableEntityId(
        `shim:${entry.shimId}:${entry.sourceId}->${entry.targetId}`,
        "RELATIONSHIP",
        entry.name,
      );
      nextEdges.push({
        id: edgeId,
        name: entry.name,
        type: "RELATIONSHIP",
        entityType: entry.entityType,
        patternId: "shim.user-defined",
        scope: "USER",
        sourceId: entry.sourceId,
        targetId: entry.targetId,
        status: "INFERRED",
        confidence: "HIGH",
        evidence: entry.evidence,
        metadata: {
          source: "USER_SHIM",
          shimId: entry.shimId,
          ...(entry.rationale ? { shimRationale: entry.rationale } : {}),
        },
      });
      existingResolvedPairs.add(pairKey);
      mutated = true;
    }
  }

  if (!mutated) {
    return graph;
  }

  return {
    ...graph,
    nodes: nextNodes,
    edges: nextEdges,
  };
}
