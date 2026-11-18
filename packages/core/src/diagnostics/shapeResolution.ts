// packages/core/src/diagnostics/shapeResolution.ts
//
// v5 Loop 2/3 — per-shape RESOLUTION measurement.
//
// For every call shape key (`[PAT-EXT-27]`) this counts how many call edges the extractor
// resolved to a target and how many it left unresolved. That is the measured capability of
// the extractor *for that shape class*: it is what lets the pattern ledger record progress as a
// visible curve and prove a fix by measurement instead of a self-declared "resolved".
//
// Deliberately NOT filtered by the visualizer's actionability policy (builtin receivers, LOW
// confidence fallbacks): resolution of a shape is a property of the extractor, not of what the
// UI chooses to badge. Edges without a shape key are not measured — unknown is not a class.

import type { EvidenceRecord, RepresentationGraph, StructuralEdge, StructuralNode } from '../types/index.js';
import { findDarkFiles } from './frameworkCoverage.js';
import {
  darkFileShapeKey,
  opaqueShapeKey,
  orphanShapeKey,
  type SignalClusterExample,
  type SignalKind,
} from './signalClusters.js';
import {
  BUILTIN_BARE_CALLS,
  BUILTIN_METHODS,
  BUILTIN_RECEIVERS,
} from './unresolvedClassifier.js';

export interface ShapeResolutionRow {
  shapeKey: string;
  /** Call edges (or contracts, for `sk1/ORPHAN/…` / `sk1/OPAQUE/…`) carrying this shape key. */
  total: number;
  /** Of `total`, instances the extractor resolved / connected. */
  resolved: number;
  /** `total - resolved`. */
  unresolved: number;
}

export const STATICALLY_KNOWABLE_CALL_BINDING_KINDS = new Set<string>([
  'Import',
  'ImportObject',
  'ImportNamespace',
  'ImportClass',
  'LocalRequire',
  'LocalFunction',
  'LocalClass',
  'LocalFromCall',
  'LocalFromNew',
  'LocalConst',
  'LocalLet',
  'This',
  'Super',
]);

const ORPHAN_INGRESS_ENTITY_TYPES = new Set<string>([
  'API_ENDPOINT',
  'HTTP_ENDPOINT',
  'HTTP_ROUTE',
  'NEXTJS_PAGE',
  'NEXTJS_LAYOUT',
  'NEXTJS_MIDDLEWARE',
  'SERVER_ACTION',
  'EVENT_LISTENER',
  'MCP_TOOL',
  'CLI_COMMAND',
  'GRAPHQL_RESOLVER',
  'PAYLOAD_ENDPOINT',
  'PAYLOAD_ENDPOINTS',
  'PAYLOAD_JOB',
  'PAYLOAD_TASK',
  'PAYLOAD_HOOK',
]);

const ORPHAN_NON_EXECUTABLE_ENTITY_TYPES = new Set<string>([
  'EXPORTED_TYPE',
  'TYPE_DEFINITION',
  'DB_SCHEMA',
  'VALIDATOR_SCHEMA',
  'COLLECTION_CONFIG',
  'PAYLOAD_COLLECTION',
  'PAYLOAD_GLOBAL',
  'PAYLOAD_BLOCK',
  'PAYLOAD_FIELDS',
  'PAYLOAD_ACCESS',
  'PROPERTY_GETTER',
  'SERVER_GUARD',
  'ROUTE_CONFIG',
  'NEXTJS_ROUTE_CONFIG',
  'METADATA_EXPORT',
  'NEXTJS_METADATA',
  'EXPRESS_ROUTE_PARAM',
]);

/**
 * Returns true when `shapeKey` represents a statically knowable / module-resolvable pattern class
 * rather than an intrinsically runtime-dynamic or parameter-callback shape (`Param`, `ParamDestructured`,
 * `Loop`, `Catch`, `Undeclared`, `None`).
 *
 * Used by `ledger pattern measure` to keep candidate pattern lists focused on actionable extractor gaps
 * without altering the raw `ShapeResolutionRow` counts.
 */
export function isKnowableShapeKey(shapeKey: string): boolean {
  if (/^sk[12]\/(ORPHAN|OPAQUE|DARK_FILE)\//.test(shapeKey)) {
    return true;
  }
  const match = /^sk[12]\/(CALL|NEW|RENDERS)\/([A-Za-z]+)\/(.+)$/.exec(shapeKey);
  if (!match) return false;
  const bindingKind = match[2];
  return STATICALLY_KNOWABLE_CALL_BINDING_KINDS.has(bindingKind);
}

/**
 * Measures orphan vs. connected contracts per `sk1/ORPHAN/<entityType>/<patternId>` shape key.
 * A contract is counted as `resolved` when it is an entry-point (`INGRESS`) contract or has at least
 * one incoming resolved edge (`inDegree > 0`), and `unresolved` otherwise.
 */
export function measureOrphanShapeResolution(
  graph: Pick<RepresentationGraph, 'nodes' | 'edges'>
): ShapeResolutionRow[] {
  const incomingTargets = new Set<string>();
  const outgoingSources = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.targetId) {
      incomingTargets.add(edge.targetId);
      outgoingSources.add(edge.sourceId);
    }
  }

  const byKey = new Map<string, ShapeResolutionRow>();
  for (const node of graph.nodes) {
    if (node.type !== 'CONTRACT') continue;
    if ((node.scope ?? 'USER') !== 'USER') continue;
    if (ORPHAN_NON_EXECUTABLE_ENTITY_TYPES.has(node.entityType)) continue;
    if (node.entityType === 'EXPORTED_MODULE' && !outgoingSources.has(node.id)) continue;

    const key = orphanShapeKey(node);
    let row = byKey.get(key);
    if (!row) {
      row = { shapeKey: key, total: 0, resolved: 0, unresolved: 0 };
      byKey.set(key, row);
    }
    row.total += 1;
    if (
      ORPHAN_INGRESS_ENTITY_TYPES.has(node.entityType) ||
      node.metadata?.flowRole === 'INGRESS' ||
      incomingTargets.has(node.id)
    ) {
      row.resolved += 1;
    } else {
      row.unresolved += 1;
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.unresolved - a.unresolved || a.shapeKey.localeCompare(b.shapeKey)
  );
}

/**
 * Measures `OPAQUE_BODY` vs. resolved-body contracts per `sk1/OPAQUE/<entityType>/<patternId>` shape key (`[PAT-VIS-15]`).
 * Examines executable USER-scope contracts that contain body calls (`metadata.astCallCount > 0` or at least one outgoing edge).
 * A contract with calls is counted as `resolved` when `resolvedOutDegree > 0`, and `unresolved` (`OPAQUE_BODY`) when `resolvedOutDegree === 0`.
 */
export function measureOpaqueShapeResolution(
  graph: Pick<RepresentationGraph, 'nodes' | 'edges'>
): ShapeResolutionRow[] {
  const resolvedOutSources = new Set<string>();
  const anyOutSources = new Set<string>();
  for (const edge of graph.edges) {
    anyOutSources.add(edge.sourceId);
    if (edge.targetId) {
      resolvedOutSources.add(edge.sourceId);
    }
  }

  const byKey = new Map<string, ShapeResolutionRow>();
  for (const node of graph.nodes) {
    if (node.type !== 'CONTRACT') continue;
    if ((node.scope ?? 'USER') !== 'USER') continue;
    if (ORPHAN_NON_EXECUTABLE_ENTITY_TYPES.has(node.entityType)) continue;

    const astCallCount =
      typeof node.metadata?.astCallCount === 'number' ? node.metadata.astCallCount : 0;
    const hasOutEdge = anyOutSources.has(node.id);
    if (astCallCount <= 0 && !hasOutEdge) continue;

    const key = opaqueShapeKey(node);
    let row = byKey.get(key);
    if (!row) {
      row = { shapeKey: key, total: 0, resolved: 0, unresolved: 0 };
      byKey.set(key, row);
    }
    row.total += 1;
    if (resolvedOutSources.has(node.id)) {
      row.resolved += 1;
    } else {
      row.unresolved += 1;
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.unresolved - a.unresolved || a.shapeKey.localeCompare(b.shapeKey)
  );
}

export type ShapeResolutionVerdict =
  | 'improved' //   more resolved AND fewer unresolved than before
  | 'regressed' //  fewer resolved than before
  | 'unchanged' //  identical counts
  | 'shifted' //    resolution unchanged but volume changed (calls added/removed)
  | 'absent' //     present before, no longer occurs at all
  | 'new'; //       did not occur before

export interface ShapeResolutionDelta {
  shapeKey: string;
  before: ShapeResolutionRow | null;
  after: ShapeResolutionRow | null;
  resolvedDelta: number;
  unresolvedDelta: number;
  verdict: ShapeResolutionVerdict;
}

/**
 * Returns true when `edge` is a user-scope `CALL` or `RENDERS` relationship carrying a shape key
 * that participates in per-shape resolution measurement.
 */
export function isMeasuredCallEdge(edge: StructuralEdge): boolean {
  return (
    (edge.entityType === 'CALL' || edge.entityType === 'RENDERS') &&
    !edge.metadata?.crossScopeFiltered &&
    (!edge.scope || edge.scope === 'USER') &&
    typeof edge.metadata?.shapeKey === 'string'
  );
}

/**
 * Measures resolved/unresolved call edges (and optionally `ORPHAN_CONTRACT` / `OPAQUE_BODY` nodes when
 * `options.includeOrphans` / `options.includeOpaque` are true and `graph.nodes` is supplied) per shape key.
 * Ordered by unresolved (desc), then key.
 */
export function measureShapeResolution(
  graph: Pick<RepresentationGraph, 'edges'> & Partial<Pick<RepresentationGraph, 'nodes'>>,
  options?: { includeOrphans?: boolean; includeOpaque?: boolean }
): ShapeResolutionRow[] {
  const byKey = new Map<string, ShapeResolutionRow>();
  for (const edge of graph.edges) {
    if (!isMeasuredCallEdge(edge)) continue;
    const key = edge.metadata!.shapeKey as string;

    let row = byKey.get(key);
    if (!row) {
      row = { shapeKey: key, total: 0, resolved: 0, unresolved: 0 };
      byKey.set(key, row);
    }
    row.total += 1;
    if (edge.targetId) row.resolved += 1;
    else row.unresolved += 1;
  }

  const rows = [...byKey.values()];
  if (options?.includeOrphans && Array.isArray(graph.nodes)) {
    rows.push(...measureOrphanShapeResolution({ nodes: graph.nodes, edges: graph.edges }));
  }
  if (options?.includeOpaque && Array.isArray(graph.nodes)) {
    rows.push(...measureOpaqueShapeResolution({ nodes: graph.nodes, edges: graph.edges }));
  }

  return rows.sort(
    (a, b) => b.unresolved - a.unresolved || a.shapeKey.localeCompare(b.shapeKey)
  );
}

/**
 * Compares two measurements of the SAME repository (typically before / after an extractor fix).
 * `improved` requires resolved to rise AND unresolved to fall, so deleting unresolvable calls
 * (`absent`) or adding resolvable ones (`shifted`) can never be mistaken for a fix.
 */
export function compareShapeResolution(
  before: readonly ShapeResolutionRow[],
  after: readonly ShapeResolutionRow[]
): ShapeResolutionDelta[] {
  const beforeBy = new Map(before.map((r) => [r.shapeKey, r]));
  const afterBy = new Map(after.map((r) => [r.shapeKey, r]));
  const keys = [...new Set([...beforeBy.keys(), ...afterBy.keys()])].sort();

  return keys.map((shapeKey) => {
    const b = beforeBy.get(shapeKey) ?? null;
    const a = afterBy.get(shapeKey) ?? null;
    const resolvedDelta = (a?.resolved ?? 0) - (b?.resolved ?? 0);
    const unresolvedDelta = (a?.unresolved ?? 0) - (b?.unresolved ?? 0);

    let verdict: ShapeResolutionVerdict;
    if (!a) verdict = 'absent';
    else if (!b) verdict = 'new';
    else if (resolvedDelta < 0) verdict = 'regressed';
    else if (resolvedDelta > 0 && unresolvedDelta < 0) verdict = 'improved';
    else if (resolvedDelta === 0 && unresolvedDelta === 0) verdict = 'unchanged';
    else verdict = 'shifted';

    return { shapeKey, before: b, after: a, resolvedDelta, unresolvedDelta, verdict };
  });
}

function camelOrPascalToKebab(token: string): string {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Derives a deterministic, human-readable pattern ID slug from a `shapeKey`.
 *
 * Examples:
 * - `sk1/CALL/LocalFromCall/Prop(Id)` -> `call.shape.local-from-call.prop-id`
 * - `sk1/ORPHAN/EXPORTED_FUNCTION/contract.exported-function` -> `orphan.exported-function.contract.exported-function`
 * - `sk1/DARK_FILE/USER_SOURCE` -> `boundary.dark-file.user-source`
 */
export function derivePatternIdFromShapeKey(shapeKey: string): string {
  const orphanMatch = /^sk[12]\/ORPHAN\/(.+)$/.exec(shapeKey);
  if (orphanMatch) {
    const rest = orphanMatch[1];
    const slashIdx = rest.indexOf('/');
    if (slashIdx !== -1) {
      const entityType = camelOrPascalToKebab(rest.slice(0, slashIdx));
      const patId = rest
        .slice(slashIdx + 1)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-');
      return `orphan.${entityType}.${patId}`;
    }
    return `orphan.${camelOrPascalToKebab(rest)}`;
  }

  const opaqueMatch = /^sk[12]\/OPAQUE\/(.+)$/.exec(shapeKey);
  if (opaqueMatch) {
    const rest = opaqueMatch[1];
    const slashIdx = rest.indexOf('/');
    if (slashIdx !== -1) {
      const entityType = camelOrPascalToKebab(rest.slice(0, slashIdx));
      const patId = rest
        .slice(slashIdx + 1)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-');
      return `opaque.${entityType}.${patId}`;
    }
    return `opaque.${camelOrPascalToKebab(rest)}`;
  }

  const darkMatch = /^sk[12]\/DARK_FILE\/(.+)$/.exec(shapeKey);
  if (darkMatch) {
    const rest = camelOrPascalToKebab(darkMatch[1]);
    return `boundary.dark-file.${rest || 'user-source'}`;
  }

  const m = /^sk[12]\/(CALL|NEW|RENDERS)\/([A-Za-z0-9_]+)\/(.+)$/.exec(shapeKey);
  if (m) {
    const kind = m[1].toLowerCase();
    const binding = camelOrPascalToKebab(m[2]);
    const expr = camelOrPascalToKebab(m[3]);
    return `${kind}.shape.${binding}.${expr}`;
  }

  return `shape.${camelOrPascalToKebab(shapeKey)}`;
}

export interface LedgerSignalCandidate {
  /** Deterministic pattern slug suitable for `pattern_ledger.pattern_id`. */
  suggestedPatternId: string;
  /** Target ontology category (`RELATIONSHIP` for CALL/NEW/RENDERS, `CONTRACT` for ORPHAN_CONTRACT/DARK_FILE). */
  ontologyCategory: 'BOUNDARY' | 'CONTRACT' | 'RELATIONSHIP' | 'OPEN_CONNECTOR';
  /** Self-diagnostic graph signal (`UNRESOLVED_CALL`, `OPAQUE_BODY`, `ORPHAN_CONTRACT`, `DARK_FILE`). */
  signal: SignalKind;
  /** Deterministic shape key (`sk1/...`). */
  shapeKey: string;
  /** Whether the shape key is statically knowable (`isKnowableShapeKey`). */
  knowable: boolean;
  /** Total occurrences of this shape key in USER scope. */
  total: number;
  /** Resolved occurrences of this shape key in USER scope. */
  resolved: number;
  /** Unresolved occurrences of this shape key in USER scope. */
  unresolved: number;
  /** Representative first-seen file path in the repository. */
  firstSeenFile: string | null;
  /** Representative first-seen 1-based line number. */
  firstSeenLine: number | null;
  /** Representative source snippet from the AST evidence record. */
  snippet: string | null;
  /** Representative entity name (e.g. `Call: client.fetchAll()` or `Exported Function: helper`). */
  exampleName: string | null;
  /** Human-readable description of the candidate pattern class and representative example. */
  description: string;
  /** Up to `maxExamples` representative examples with file, line, and snippet. */
  examples: SignalClusterExample[];
}

export interface CollectLedgerSignalCandidatesOptions {
  /** Shape keys already registered in `pattern_ledger.db` (omitted from the returned candidates). */
  registeredShapeKeys?: ReadonlySet<string>;
  /** When true (default), only returns statically knowable shape keys (`isKnowableShapeKey`). */
  onlyKnowable?: boolean;
  /** Include `ORPHAN_CONTRACT` (`sk1/ORPHAN/...`) shape candidates (default: true). */
  includeOrphans?: boolean;
  /** Include `OPAQUE_BODY` (`sk1/OPAQUE/...`) contract shape candidates (default: false). */
  includeOpaque?: boolean;
  /**
   * When true, only includes an `ORPHAN_CONTRACT` candidate if at least one orphan contract of that
   * shape has `metadata.unresolvedIncoming` (i.e. imported in the repo with 0 resolved callers) OR
   * no non-builtin call candidates exist. Prevents routine unreferenced SDK exports from triggering
   * noisy Bite Report hints while preserving full orphan measurement in `ledger pattern measure`.
   */
  onlyActionableOrphans?: boolean;
  /** Include `DARK_FILE` (`sk1/DARK_FILE/USER_SOURCE`) candidate when dark files exist (default: false). */
  includeDarkFiles?: boolean;
  /** Optional explicit list of dark files (overrides `findDarkFiles(graph)` when provided and non-empty). */
  darkFiles?: readonly string[];
  /** Max examples per candidate (default: 3). */
  maxExamples?: number;
}

function getPrimarySyntaxEvidence(
  entity: Pick<StructuralNode | StructuralEdge, 'evidence'>
): EvidenceRecord | undefined {
  const ev = entity.evidence;
  if (!ev) return undefined;
  if (!Array.isArray(ev)) return ev;
  const syntaxEv = ev.find(
    (r) => r && r.evidenceRole !== 'import-match' && r.evidenceRole !== 'target-signature'
  );
  return syntaxEv ?? ev[0];
}

export function isLikelyBuiltinCallEdge(edgeName: string): boolean {
  if (!edgeName.startsWith('Call: ')) return false;
  const rawCall = edgeName
    .slice('Call: '.length)
    .replace(/\(\)$/, '')
    .trim();
  if (!rawCall) return false;
  const dotIdx = rawCall.lastIndexOf('.');
  const receiver = dotIdx >= 0 ? rawCall.slice(0, dotIdx) : '';
  const method = dotIdx >= 0 ? rawCall.slice(dotIdx + 1) : rawCall;
  const rootReceiver = receiver.split('.')[0];
  if (BUILTIN_RECEIVERS.has(rootReceiver)) return true;
  if (!receiver && BUILTIN_BARE_CALLS.has(method)) return true;
  if (BUILTIN_METHODS.has(method)) return true;
  return false;
}

/**
 * Extracts unhandled signal clusters (`UNRESOLVED_CALL`, `OPAQUE_BODY`, `ORPHAN_CONTRACT`, `DARK_FILE`)
 * with concrete `firstSeenFile`, `firstSeenLine`, and `snippet` evidence directly from a `RepresentationGraph`
 * (`[PAT-CLI-15]`, `[PAT-EXT-27]`, `[PAT-VIS-15]`).
 */
export function collectLedgerSignalCandidates(
  graph: Pick<RepresentationGraph, 'nodes' | 'edges' | 'analyzedFiles'>,
  options?: CollectLedgerSignalCandidatesOptions
): LedgerSignalCandidate[] {
  const registered = options?.registeredShapeKeys ?? new Set<string>();
  const onlyKnowable = options?.onlyKnowable ?? true;
  const includeOrphans = options?.includeOrphans ?? true;
  const includeOpaque = options?.includeOpaque ?? false;
  const onlyActionableOrphans = options?.onlyActionableOrphans ?? false;
  const explicitDarkFiles = options?.darkFiles;
  const includeDarkFiles =
    options?.includeDarkFiles ?? (Array.isArray(explicitDarkFiles) && explicitDarkFiles.length > 0);
  const maxExamples = Math.max(1, options?.maxExamples ?? 3);

  const userNodes = (graph.nodes ?? []).filter((n) => (n.scope ?? 'USER') === 'USER');
  const userEdges = (graph.edges ?? []).filter((e) => (e.scope ?? 'USER') === 'USER');

  const rows = measureShapeResolution(
    { nodes: userNodes, edges: userEdges },
    { includeOrphans, includeOpaque }
  );

  // Identify contracts with 0 resolved outgoing edges and >= 1 unresolved call (OPAQUE_BODY)
  const resolvedOutSources = new Set<string>();
  const anyOutSources = new Set<string>();
  const incomingTargets = new Set<string>();
  for (const edge of userEdges) {
    anyOutSources.add(edge.sourceId);
    if (edge.targetId) {
      resolvedOutSources.add(edge.sourceId);
      incomingTargets.add(edge.targetId);
    }
  }

  const contractNodeIds = new Set<string>();
  for (const node of userNodes) {
    if (node.type === 'CONTRACT' && !ORPHAN_NON_EXECUTABLE_ENTITY_TYPES.has(node.entityType)) {
      contractNodeIds.add(node.id);
    }
  }

  interface RankedExample extends SignalClusterExample {
    priority: number;
    isOpaqueSource: boolean;
  }

  const examplesByShapeKey = new Map<string, RankedExample[]>();

  for (const edge of userEdges) {
    if (edge.targetId) continue;
    if (edge.entityType !== 'CALL' && edge.entityType !== 'RENDERS') continue;
    const shapeKey = edge.metadata?.shapeKey;
    if (typeof shapeKey !== 'string') continue;

    const ev = getPrimarySyntaxEvidence(edge);
    const isBuiltin = isLikelyBuiltinCallEdge(edge.name);
    const hasImportDiag = typeof edge.metadata?.unresolvedReason === 'string';
    const isOpaqueSource =
      contractNodeIds.has(edge.sourceId) && !resolvedOutSources.has(edge.sourceId);

    // Prioritize import-backed or non-builtin calls when picking representative evidence
    const priority = !isBuiltin && hasImportDiag ? 0 : !isBuiltin ? 1 : 2;
    const list = examplesByShapeKey.get(shapeKey) ?? [];
    list.push({
      nodeId: edge.sourceId,
      name: edge.name,
      filePath: ev?.filePath,
      lineNumber: ev?.lineNumber,
      ...(ev?.snippet ? { snippet: ev.snippet } : {}),
      priority,
      isOpaqueSource,
    });
    examplesByShapeKey.set(shapeKey, list);
  }

  const actionableOrphanShapes = new Set<string>();
  if (includeOrphans) {
    for (const node of userNodes) {
      if (node.type !== 'CONTRACT') continue;
      if (ORPHAN_NON_EXECUTABLE_ENTITY_TYPES.has(node.entityType)) continue;
      if (ORPHAN_INGRESS_ENTITY_TYPES.has(node.entityType) || node.metadata?.flowRole === 'INGRESS') continue;
      if (node.entityType === 'EXPORTED_MODULE' && !resolvedOutSources.has(node.id)) continue;
      if (incomingTargets.has(node.id)) continue;

      const shapeKey = orphanShapeKey(node);
      const ev = getPrimarySyntaxEvidence(node);
      const inc = Array.isArray(node.metadata?.unresolvedIncoming)
        ? node.metadata.unresolvedIncoming
        : [];
      const hasUnlinkedImport = inc.some((r: any) => r?.reason !== 'imported-but-never-invoked');
      if (hasUnlinkedImport) {
        actionableOrphanShapes.add(shapeKey);
      }

      const priority = hasUnlinkedImport ? 0 : inc.length > 0 ? 1 : 2;
      const list = examplesByShapeKey.get(shapeKey) ?? [];
      list.push({
        nodeId: node.id,
        name: node.name,
        filePath: ev?.filePath,
        lineNumber: ev?.lineNumber,
        ...(ev?.snippet ? { snippet: ev.snippet } : {}),
        priority,
        isOpaqueSource: false,
      });
      examplesByShapeKey.set(shapeKey, list);
    }
  }

  if (includeOpaque) {
    for (const node of userNodes) {
      if (node.type !== 'CONTRACT') continue;
      if (ORPHAN_NON_EXECUTABLE_ENTITY_TYPES.has(node.entityType)) continue;
      if (resolvedOutSources.has(node.id)) continue;

      const astCallCount =
        typeof node.metadata?.astCallCount === 'number' ? node.metadata.astCallCount : 0;
      const hasOutEdge = anyOutSources.has(node.id);
      if (astCallCount <= 0 && !hasOutEdge) continue;

      const shapeKey = opaqueShapeKey(node);
      const ev = getPrimarySyntaxEvidence(node);
      const isIngress =
        ORPHAN_INGRESS_ENTITY_TYPES.has(node.entityType) || node.metadata?.flowRole === 'INGRESS';
      const priority = isIngress ? 0 : incomingTargets.has(node.id) ? 1 : 2;
      const list = examplesByShapeKey.get(shapeKey) ?? [];
      list.push({
        nodeId: node.id,
        name: node.name,
        filePath: ev?.filePath,
        lineNumber: ev?.lineNumber,
        ...(ev?.snippet ? { snippet: ev.snippet } : {}),
        priority,
        isOpaqueSource: true,
      });
      examplesByShapeKey.set(shapeKey, list);
    }
  }

  const candidates: LedgerSignalCandidate[] = [];

  for (const row of rows) {
    if (row.unresolved <= 0) continue;
    if (registered.has(row.shapeKey)) continue;
    const knowable = isKnowableShapeKey(row.shapeKey);
    if (onlyKnowable && !knowable) continue;

    const isOrphan = /^sk[12]\/ORPHAN\//.test(row.shapeKey);
    const isOpaqueContract = /^sk[12]\/OPAQUE\//.test(row.shapeKey);
    if (isOrphan && onlyActionableOrphans && !actionableOrphanShapes.has(row.shapeKey)) {
      continue;
    }

    const rawExamples = examplesByShapeKey.get(row.shapeKey) ?? [];
    rawExamples.sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.filePath ?? '').localeCompare(b.filePath ?? '') ||
        (a.lineNumber ?? 0) - (b.lineNumber ?? 0) ||
        a.name.localeCompare(b.name)
    );

    const topExample = rawExamples[0];
    const cleanExamples: SignalClusterExample[] = rawExamples.slice(0, maxExamples).map((ex) => ({
      nodeId: ex.nodeId,
      name: ex.name,
      ...(ex.filePath !== undefined ? { filePath: ex.filePath } : {}),
      ...(ex.lineNumber !== undefined ? { lineNumber: ex.lineNumber } : {}),
      ...(ex.snippet !== undefined ? { snippet: ex.snippet } : {}),
    }));

    let signal: SignalKind;
    let ontologyCategory: LedgerSignalCandidate['ontologyCategory'];
    if (isOrphan) {
      signal = 'ORPHAN_CONTRACT';
      ontologyCategory = 'CONTRACT';
    } else if (isOpaqueContract) {
      signal = 'OPAQUE_BODY';
      ontologyCategory = 'CONTRACT';
    } else {
      const nonBuiltinExamples = rawExamples.filter((e) => e.priority <= 1);
      if (onlyKnowable && nonBuiltinExamples.length === 0) {
        continue;
      }
      const pool = nonBuiltinExamples.length > 0 ? nonBuiltinExamples : rawExamples;
      const opaqueCount = pool.filter((e) => e.isOpaqueSource).length;
      signal =
        resolvedOutSources.size > 0 &&
        pool.length > 0 &&
        opaqueCount >= Math.ceil(pool.length / 2) &&
        topExample?.isOpaqueSource
          ? 'OPAQUE_BODY'
          : 'UNRESOLVED_CALL';
      ontologyCategory = 'RELATIONSHIP';
    }

    const suggestedPatternId = derivePatternIdFromShapeKey(row.shapeKey);
    const snippetPreview = topExample?.snippet ? ` (\`${topExample.snippet}\`)` : '';
    const exampleLabel = topExample?.name ? ` — e.g. ${topExample.name}${snippetPreview}` : '';
    const description =
      signal === 'ORPHAN_CONTRACT'
        ? `Orphan contract shape ${row.shapeKey} (${row.unresolved}/${row.total} unlinked)${exampleLabel}`
        : isOpaqueContract
          ? `Opaque-body contract shape ${row.shapeKey} (${row.unresolved}/${row.total} opaque)${exampleLabel}`
          : signal === 'OPAQUE_BODY'
            ? `Opaque-body call shape ${row.shapeKey} (${row.unresolved}/${row.total} unresolved)${exampleLabel}`
            : `Unresolved call shape ${row.shapeKey} (${row.unresolved}/${row.total} unresolved)${exampleLabel}`;

    candidates.push({
      suggestedPatternId,
      ontologyCategory,
      signal,
      shapeKey: row.shapeKey,
      knowable,
      total: row.total,
      resolved: row.resolved,
      unresolved: row.unresolved,
      firstSeenFile: topExample?.filePath ?? null,
      firstSeenLine: topExample?.lineNumber ?? null,
      snippet: topExample?.snippet ?? null,
      exampleName: topExample?.name ?? null,
      description,
      examples: cleanExamples,
    });
  }

  if (includeDarkFiles) {
    const dKey = darkFileShapeKey();
    if (!registered.has(dKey)) {
      const darkFiles =
        explicitDarkFiles && explicitDarkFiles.length > 0
          ? [...explicitDarkFiles]
          : findDarkFiles(graph);
      if (darkFiles.length > 0) {
        const firstDark = darkFiles[0];
        candidates.push({
          suggestedPatternId: derivePatternIdFromShapeKey(dKey),
          ontologyCategory: 'CONTRACT',
          signal: 'DARK_FILE',
          shapeKey: dKey,
          knowable: true,
          total: darkFiles.length,
          resolved: 0,
          unresolved: darkFiles.length,
          firstSeenFile: firstDark,
          firstSeenLine: 1,
          snippet: null,
          exampleName: firstDark,
          description: `Dark source files with 0 extracted contracts and 0 relationships (${darkFiles.length} file(s), e.g. ${firstDark})`,
          examples: darkFiles.slice(0, maxExamples).map((fp) => ({
            nodeId: 'dark-file',
            name: fp,
            filePath: fp,
            lineNumber: 1,
          })),
        });
      }
    }
  }

  return candidates;
}

/**
 * Formats a copy-ready `chomp-research ledger pattern log` command for a candidate shape cluster.
 */
export function formatLedgerPatternLogCommand(
  candidate: LedgerSignalCandidate,
  repoName: string,
  sessionLabel?: string
): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const args = [
    'chomp-research ledger pattern log',
    `--id "${esc(candidate.suggestedPatternId)}"`,
    `--ontology ${candidate.ontologyCategory}`,
    `--signal ${candidate.signal}`,
    `--shape-key "${esc(candidate.shapeKey)}"`,
    `--repo "${esc(repoName)}"`,
  ];
  if (sessionLabel) {
    args.push(`--session "${esc(sessionLabel)}"`);
  }
  if (candidate.firstSeenFile) {
    args.push(`--file "${esc(candidate.firstSeenFile)}"`);
  }
  if (typeof candidate.firstSeenLine === 'number') {
    args.push(`--line ${candidate.firstSeenLine}`);
  }
  args.push(`--desc "${esc(candidate.description)}"`);
  return args.join(' ');
}
