import {
  computeStructuralHealthMetrics,
  type RepresentationGraph,
  type StructuralEdge,
  type StructuralNode,
} from "@chomp/core";
import { deploymentUnitLabel } from "./entityVocabulary.js";
import type {
  EntityOverlayItem,
  LayoutData,
  PackageHealthStats,
  SystemHealthSummary,
  WorkingNode,
} from "./types.js";

/**
 * Computes system-wide and per-package `chomp health` metrics from a
 * `RepresentationGraph`, `orphanNodes` from `runStoryTracer`, and `LayoutData`.
 */
export function computeGraphHealthMetrics(
  graph: RepresentationGraph,
  repoName: string,
  orphanNodes: WorkingNode[],
  layoutData: LayoutData,
  overlays?: EntityOverlayItem[],
): {
  systemHealth: SystemHealthSummary;
  packageHealthByPkg: Record<string, PackageHealthStats>;
} {
  const nodeById = new Map<string, StructuralNode>();
  for (const n of graph.nodes) {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  }

  // Resolve each raw node's owning package label (`cli`, `core`, `db`, `mcp`, `web`)
  const deploymentUnitsByPkg = new Map<string, StructuralNode>();
  const pathPrefixByPkg = new Map<string, string>();
  for (const n of nodeById.values()) {
    if (n.entityType === "DEPLOYMENT_UNIT") {
      const pkg = deploymentUnitLabel(n.name);
      if (pkg) {
        deploymentUnitsByPkg.set(pkg, n);
        const evList = Array.isArray(n.evidence)
          ? n.evidence
          : n.evidence
            ? [n.evidence]
            : [];
        const p = evList[0]?.filePath;
        if (p && p !== ".") {
          pathPrefixByPkg.set(pkg, p.replace(/\/+$/, ""));
        }
      }
    }
  }

  const pkgCache = new Map<string, string>();
  const resolveNodePkg = (nodeId: string): string => {
    const cached = pkgCache.get(nodeId);
    if (cached !== undefined) return cached;

    let label = "";
    const seen = new Set<string>();
    let cursor: StructuralNode | undefined = nodeById.get(nodeId);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.entityType === "DEPLOYMENT_UNIT") {
        label = deploymentUnitLabel(cursor.name);
        break;
      }
      cursor = cursor.parentBoundaryId ? nodeById.get(cursor.parentBoundaryId) : undefined;
    }

    if (!label) {
      const rawNode = nodeById.get(nodeId);
      const evList = rawNode?.evidence
        ? Array.isArray(rawNode.evidence)
          ? rawNode.evidence
          : [rawNode.evidence]
        : [];
      const filePath = evList[0]?.filePath;
      if (filePath) {
        for (const [pkg, prefix] of pathPrefixByPkg.entries()) {
          if (filePath === prefix || filePath.startsWith(`${prefix}/`)) {
            label = pkg;
            break;
          }
        }
      }
    }

    pkgCache.set(nodeId, label);
    return label;
  };

  // Deduplicate unresolved call counts by raw contract `origId` per package
  const unresolvedByPkgAndOrigId = new Map<string, Map<string, number>>();
  const recordUnresolved = (pkg: string | undefined, origId: string, count: number) => {
    if (!pkg || count <= 0) return;
    let map = unresolvedByPkgAndOrigId.get(pkg);
    if (!map) {
      map = new Map<string, number>();
      unresolvedByPkgAndOrigId.set(pkg, map);
    }
    const baseOrig = origId.split("@")[0];
    if (!map.has(baseOrig) || (map.get(baseOrig) ?? 0) < count) {
      map.set(baseOrig, count);
    }
  };

  for (const ln of layoutData.nodes) {
    if (ln.isPackage) continue;
    const parts = ln.id.split("::");
    const orig = parts.length >= 3 ? parts[1].split("@")[0] : ln.id.split("@")[0];
    recordUnresolved(ln.packageLabel, orig, ln.unresolvedCount ?? ln.unresolvedCalls?.length ?? 0);
  }
  for (const on of orphanNodes) {
    recordUnresolved(on.packageLabel, on.id, on.unresolvedCount ?? on.unresolvedCalls?.length ?? 0);
  }

  let totalUnresolvedCalls = 0;
  for (const map of unresolvedByPkgAndOrigId.values()) {
    for (const c of map.values()) totalUnresolvedCalls += c;
  }

  // System-level metrics (via canonical `computeStructuralHealthMetrics`)
  const sysMetrics = computeStructuralHealthMetrics(graph);

  const systemHealth: SystemHealthSummary = {
    repoName,
    status: sysMetrics.status,
    connectivityRate: sysMetrics.connectivityRate,
    rawConnectivityRate: sysMetrics.rawConnectivityRate,
    knowableConnectivityRate: sysMetrics.knowableConnectivityRate,
    entityTypeCoverage: sysMetrics.entityTypeCoverage,
    parentCoverage: sysMetrics.parentCoverage,
    scopePurity: sysMetrics.scopePurity,
    totalContracts: sysMetrics.entityCounts.contracts,
    totalBoundaries: sysMetrics.entityCounts.boundaries,
    totalRelationships: sysMetrics.entityCounts.relationships,
    totalOpenConnectors: sysMetrics.entityCounts.openConnectors,
    resolvedCallCount: sysMetrics.callResolutionCounts.resolvedCount,
    knowableGapCount: sysMetrics.callResolutionCounts.knowableGapCount,
    dynamicBoundaryCount: sysMetrics.callResolutionCounts.dynamicBoundaryCount,
    platformPrimitiveCount: sysMetrics.callResolutionCounts.platformPrimitiveCount,
    unresolvedCallCount: totalUnresolvedCalls,
    orphanCount: orphanNodes.length,
  };

  // Per-package metrics
  const packageHealthByPkg: Record<string, PackageHealthStats> = {};
  const pkgKeys = Object.keys(layoutData.packageBounds ?? {});

  for (const pkg of pkgKeys) {
    if (pkg.includes(":")) {
      // External Service Receptor boundary
      continue;
    }

    const duNode = deploymentUnitsByPkg.get(pkg);
    let summary: string | undefined;
    let domain: string | undefined;
    if (duNode?.metadata) {
      try {
        const meta =
          typeof duNode.metadata === "string"
            ? JSON.parse(duNode.metadata)
            : duNode.metadata;
        if (typeof meta?.summary === "string") summary = meta.summary;
        if (typeof meta?.domain === "string") domain = meta.domain;
      } catch {
        // Ignore malformed metadata
      }
    }
    if (duNode?.id && Array.isArray(overlays)) {
      for (const ov of overlays) {
        if (ov.entityId === duNode.id && ov.layer === "L1_SEMANTIC" && ov.payload) {
          if (typeof ov.payload.summary === "string") summary = ov.payload.summary;
          if (typeof ov.payload.domain === "string") domain = ov.payload.domain;
        }
      }
    }

    const pkgNodes = graph.nodes.filter((n) => resolveNodePkg(n.id) === pkg);
    const pkgEdges = graph.edges.filter((e) => resolveNodePkg(e.sourceId) === pkg);
    const pkgMetrics = computeStructuralHealthMetrics({ nodes: pkgNodes, edges: pkgEdges });

    const pkgUnresolvedMap = unresolvedByPkgAndOrigId.get(pkg);
    let pkgUnresolvedCount = 0;
    if (pkgUnresolvedMap) {
      for (const c of pkgUnresolvedMap.values()) pkgUnresolvedCount += c;
    }

    const pkgOrphanCount = orphanNodes.filter((o) => o.packageLabel === pkg).length;
    const pkgInvariantCount =
      layoutData.packageBounds?.[pkg]?.invariantCount ??
      (layoutData.invariantNodes ?? []).filter((n) => n.packageLabel === pkg).length;

    const fallbackDisplayName = layoutData.packageBounds?.[pkg]?.displayName ?? pkg;

    packageHealthByPkg[pkg] = {
      boundaryId: duNode?.id,
      rawName: duNode?.name ?? `Deployment Unit: ${fallbackDisplayName}`,
      packagePath: pathPrefixByPkg.get(pkg),
      ...(summary ? { summary } : {}),
      ...(domain ? { domain } : {}),
      status: pkgMetrics.status,
      connectivityRate: pkgMetrics.connectivityRate,
      rawConnectivityRate: pkgMetrics.rawConnectivityRate,
      knowableConnectivityRate: pkgMetrics.knowableConnectivityRate,
      entityTypeCoverage: pkgMetrics.entityTypeCoverage,
      parentCoverage: pkgMetrics.parentCoverage,
      scopePurity: pkgMetrics.scopePurity,
      contractCount: pkgMetrics.entityCounts.contracts,
      resolvedCallCount: pkgMetrics.callResolutionCounts.resolvedCount,
      provableCallCount: pkgMetrics.callResolutionCounts.provableCallCount,
      knowableGapCount: pkgMetrics.callResolutionCounts.knowableGapCount,
      dynamicBoundaryCount: pkgMetrics.callResolutionCounts.dynamicBoundaryCount,
      platformPrimitiveCount: pkgMetrics.callResolutionCounts.platformPrimitiveCount,
      unresolvedCallCount: pkgUnresolvedCount,
      orphanCount: pkgOrphanCount,
      invariantCount: pkgInvariantCount,
    };
  }

  return { systemHealth, packageHealthByPkg };
}
