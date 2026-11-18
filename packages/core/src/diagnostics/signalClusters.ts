// packages/core/src/diagnostics/signalClusters.ts
//
// v5 Loop 1/3 — clusters the graph's self-diagnostic signal instances (`▲ N unresolved`,
// `OPAQUE BODY`, orphan contracts) into CANDIDATE PATTERN CLASSES by deterministic shape key.
//
// This is a pure function over already-classified instances: it does no AST work and no I/O, and
// it never invents a class. An instance without a shape key (e.g. a graph extracted by an older
// extractor) is reported as `unclassified` — an honest unknown, not a guess (Principle of
// Incomplete Truth). Naming a cluster / approving it as a ledger pattern remains a human/AI
// judgement (AI Proposes → Evidence Corroborates → Humans Validate).
//
// Callers own the *actionability* filter (which unresolved calls are builtins / bridged helpers):
// that is classifier policy and lives with the visualizer / MCP classifiers.

export type SignalKind = 'UNRESOLVED_CALL' | 'OPAQUE_BODY' | 'ORPHAN_CONTRACT' | 'DARK_FILE';

export interface SignalInstance {
  /** Graph node the signal is reported on (the calling / orphaned contract). */
  nodeId: string;
  /** Human-readable instance label, e.g. `client.fetchAll()` or the contract name. */
  name: string;
  /** Deterministic shape key; omitted when the extractor did not record one. */
  shapeKey?: string;
  signal: SignalKind;
  filePath?: string;
  lineNumber?: number;
  snippet?: string;
}

export interface SignalClusterExample {
  nodeId: string;
  name: string;
  filePath?: string;
  lineNumber?: number;
  snippet?: string;
}

export interface SignalCluster {
  signal: SignalKind;
  shapeKey: string;
  instanceCount: number;
  /** Distinct nodes carrying at least one instance of this cluster. */
  nodeCount: number;
  /** Up to `maxExamples` instances, in deterministic order (file, line, name). */
  examples: SignalClusterExample[];
}

export interface SignalClusterReport {
  clusters: SignalCluster[];
  /** Instances that carried no shape key. Unknown is a valid state. */
  unclassified: { instanceCount: number; nodeCount: number };
}

/**
 * Shape key of an orphan contract: its own entity type + the extractor pattern that produced it.
 * Both come from the extractor's closed vocabulary, so the key is safe to display and transmit.
 */
export function orphanShapeKey(node: { entityType: string; patternId: string }): string {
  return `sk1/ORPHAN/${node.entityType}/${node.patternId}`;
}

/**
 * Shape key of an `OPAQUE_BODY` contract (`astCallCount > 0 && resolvedOutDegree === 0`):
 * its own entity type + the extractor pattern that produced it (`[PAT-VIS-15]`).
 */
export function opaqueShapeKey(node: { entityType: string; patternId: string }): string {
  return `sk1/OPAQUE/${node.entityType}/${node.patternId}`;
}

/**
 * Deterministic shape key for Signal 4 (`DARK_FILE`: non-barrel USER-scope source files
 * with 0 extracted Contracts, 0 Class/Namespace boundaries, and 0 originating Relationships).
 */
export function darkFileShapeKey(): string {
  return 'sk1/DARK_FILE/USER_SOURCE';
}

function compareExamples(a: SignalClusterExample, b: SignalClusterExample): number {
  return (
    (a.filePath ?? '').localeCompare(b.filePath ?? '') ||
    (a.lineNumber ?? 0) - (b.lineNumber ?? 0) ||
    a.name.localeCompare(b.name) ||
    a.nodeId.localeCompare(b.nodeId)
  );
}

/**
 * Groups instances by (signal, shapeKey). Clusters are ordered by instance count (desc), then by
 * signal and shape key so output is stable across runs.
 */
export function clusterSignalInstances(
  instances: readonly SignalInstance[],
  options?: { maxExamples?: number }
): SignalClusterReport {
  const maxExamples = Math.max(1, options?.maxExamples ?? 3);

  const groups = new Map<
    string,
    { signal: SignalKind; shapeKey: string; instances: SignalInstance[]; nodes: Set<string> }
  >();
  const unclassifiedNodes = new Set<string>();
  let unclassifiedCount = 0;

  for (const inst of instances) {
    if (!inst.shapeKey) {
      unclassifiedCount++;
      unclassifiedNodes.add(inst.nodeId);
      continue;
    }
    const groupKey = `${inst.signal}|${inst.shapeKey}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { signal: inst.signal, shapeKey: inst.shapeKey, instances: [], nodes: new Set() };
      groups.set(groupKey, group);
    }
    group.instances.push(inst);
    group.nodes.add(inst.nodeId);
  }

  const clusters: SignalCluster[] = [...groups.values()].map((g) => ({
    signal: g.signal,
    shapeKey: g.shapeKey,
    instanceCount: g.instances.length,
    nodeCount: g.nodes.size,
    examples: g.instances
      .map<SignalClusterExample>((i) => ({
        nodeId: i.nodeId,
        name: i.name,
        filePath: i.filePath,
        lineNumber: i.lineNumber,
        ...(i.snippet !== undefined ? { snippet: i.snippet } : {}),
      }))
      .sort(compareExamples)
      .slice(0, maxExamples),
  }));

  clusters.sort(
    (a, b) =>
      b.instanceCount - a.instanceCount ||
      a.signal.localeCompare(b.signal) ||
      a.shapeKey.localeCompare(b.shapeKey)
  );

  return {
    clusters,
    unclassified: { instanceCount: unclassifiedCount, nodeCount: unclassifiedNodes.size },
  };
}
