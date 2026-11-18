import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createSQLiteStorage } from "@chomp/db";
import { resolveRepoName } from "./git.js";
import {
  estimateNodeVisualHeight,
  INGRESS_ENTITY_TYPES,
  PACKAGE_CONNECTOR_ENTITY_TYPES,
} from "../visualizer/entityVocabulary.js";
import { loadLocalMasterLayoutEngine } from "../visualizer/localEngineBridge.js";

export interface StationOverlapIssue {
  nodeAId: string;
  nodeALabel: string;
  nodeBId: string;
  nodeBLabel: string;
  packageName: string;
  boxA: { x: number; y: number; width: number; height: number };
  boxB: { x: number; y: number; width: number; height: number };
}

export interface PackageBoundsLeakIssue {
  nodeId: string;
  label: string;
  packageName: string;
  nodeBox: { x: number; y: number; width: number; height: number };
  packageBounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface MacroPackageOverlapIssue {
  packageA: string;
  packageB: string;
  reason: "AABB_OVERLAP" | "MACRO_CELL_COLLISION";
  detail: string;
}

export interface WireObstacleCollisionIssue {
  edgeId: string;
  kind: "INTRA_PACKAGE_CARD" | "CROSS_PACKAGE_BOX";
  blockerId: string;
  blockerLabel: string;
  packageName?: string;
}

export interface LayoutGeometryAuditReport {
  passed: boolean;
  placedStationCount: number;
  packageCount: number;
  placedEdgeCount: number;
  duplicateNodeIds: string[];
  duplicateInvariantKeys: string[];
  nonFiniteItems: string[];
  stationOverlaps: StationOverlapIssue[];
  packageBoundsLeaks: PackageBoundsLeakIssue[];
  macroPackageOverlaps: MacroPackageOverlapIssue[];
  wireCollisions: WireObstacleCollisionIssue[];
}

/**
 * Deterministic 2D spatial & geometric verifier for `LayoutData` payloads.
 * Catches visual rendering defects (overlapping station cards, overflowing multi-line/badge
 * card heights, package-box boundary leaks, stacked Macro System package cells, `NaN`/`Infinity`
 * coordinates, and orthogonal wires cutting through unrelated cards/packages) without needing
 * a human eye on the canvas.
 */
export function auditLayoutGeometry(payload: any): LayoutGeometryAuditReport {
  const report: LayoutGeometryAuditReport = {
    passed: true,
    placedStationCount: 0,
    packageCount: 0,
    placedEdgeCount: Array.isArray(payload?.edges) ? payload.edges.length : 0,
    duplicateNodeIds: [],
    duplicateInvariantKeys: [],
    nonFiniteItems: [],
    stationOverlaps: [],
    packageBoundsLeaks: [],
    macroPackageOverlaps: [],
    wireCollisions: [],
  };

  if (!payload || !Array.isArray(payload.nodes)) {
    report.passed = false;
    report.nonFiniteItems.push("Invalid layout payload: missing nodes array");
    return report;
  }

  const seenNodeIds = new Set<string>();
  const placedStations: Array<{
    node: any;
    pkg: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }> = [];

  for (const n of payload.nodes) {
    if (!n || typeof n.id !== "string") {
      report.nonFiniteItems.push("Node missing string id");
      continue;
    }
    if (seenNodeIds.has(n.id)) {
      report.duplicateNodeIds.push(n.id);
    } else {
      seenNodeIds.add(n.id);
    }

    const hasCoords = n.x !== undefined || n.y !== undefined;
    if (hasCoords) {
      const w = n.width ?? 240;
      const h = n.height ?? 36;
      if (
        !Number.isFinite(n.x) ||
        !Number.isFinite(n.y) ||
        !Number.isFinite(w) ||
        !Number.isFinite(h) ||
        w <= 0 ||
        h <= 0
      ) {
        report.nonFiniteItems.push(
          `Node ${n.id} (${n.label ?? "unnamed"}) has invalid geometry (${n.x}, ${n.y}, ${w}x${h})`,
        );
        continue;
      }

      if (!n.isPackage && n.role !== "ISLAND") {
        const estimatedVisualH = estimateNodeVisualHeight(n);
        const effectiveH = Math.max(h, Number.isFinite(estimatedVisualH) ? estimatedVisualH : h);
        placedStations.push({
          node: n,
          pkg: String(n.packageLabel || getPackagePrefix(n.id) || ""),
          x: n.x,
          y: n.y,
          w,
          h: effectiveH,
        });
      }
    }
  }

  report.placedStationCount = placedStations.length;

  // Check invariantNodes uniqueness & finite dimensions
  if (Array.isArray(payload.invariantNodes)) {
    const seenInvKeys = new Set<string>();
    for (const inv of payload.invariantNodes) {
      if (!inv || typeof inv.id !== "string") continue;
      const key = `${inv.packageLabel ?? ""}::${inv.id}`;
      if (seenInvKeys.has(key)) {
        report.duplicateInvariantKeys.push(key);
      } else {
        seenInvKeys.add(key);
      }
    }
  }

  // Check packageBounds finite values, containment, AABB non-overlap, and Macro Grid (macroCol, macroRow) uniqueness
  const boundsEntries = Object.entries(payload.packageBounds ?? {}) as Array<[string, any]>;
  report.packageCount = boundsEntries.length;
  const validPkgBounds = new Map<
    string,
    { minX: number; minY: number; maxX: number; maxY: number; macroCol?: number; macroRow?: number }
  >();
  const seenMacroCells = new Map<string, string>();

  for (const [pkg, b] of boundsEntries) {
    if (
      !b ||
      !Number.isFinite(b.minX) ||
      !Number.isFinite(b.minY) ||
      !Number.isFinite(b.maxX) ||
      !Number.isFinite(b.maxY) ||
      b.maxX <= b.minX ||
      b.maxY <= b.minY
    ) {
      report.nonFiniteItems.push(
        `packageBounds["${pkg}"] has invalid bounds (${b?.minX}, ${b?.minY})..(${b?.maxX}, ${b?.maxY})`,
      );
      continue;
    }
    validPkgBounds.set(pkg, b);
    if (typeof b.macroCol === "number" && typeof b.macroRow === "number") {
      if (!Number.isFinite(b.macroCol) || !Number.isFinite(b.macroRow)) {
        report.nonFiniteItems.push(
          `packageBounds["${pkg}"] has non-finite macro cell (${b.macroCol}, ${b.macroRow})`,
        );
      } else {
        const cellKey = `${b.macroCol},${b.macroRow}`;
        const prevPkg = seenMacroCells.get(cellKey);
        if (prevPkg && prevPkg !== pkg) {
          report.macroPackageOverlaps.push({
            packageA: prevPkg,
            packageB: pkg,
            reason: "MACRO_CELL_COLLISION",
            detail: `Both packages occupy Macro Grid cell (${b.macroCol}, ${b.macroRow})`,
          });
        } else {
          seenMacroCells.set(cellKey, pkg);
        }
      }
    }
  }

  const validBoundsList = Array.from(validPkgBounds.entries());
  for (let i = 0; i < validBoundsList.length; i++) {
    const [pkgA, a] = validBoundsList[i]!;
    for (let j = i + 1; j < validBoundsList.length; j++) {
      const [pkgB, b] = validBoundsList[j]!;
      if (
        a.minX + 1 < b.maxX &&
        a.maxX - 1 > b.minX &&
        a.minY + 1 < b.maxY &&
        a.maxY - 1 > b.minY
      ) {
        report.macroPackageOverlaps.push({
          packageA: pkgA,
          packageB: pkgB,
          reason: "AABB_OVERLAP",
          detail: `Package boxes "${pkgA}" [${a.minX},${a.minY}..${a.maxX},${a.maxY}] and "${pkgB}" [${b.minX},${b.minY}..${b.maxX},${b.maxY}] overlap`,
        });
      }
    }
  }

  // Station card containment inside packageBounds + 2D AABB station-to-station overlap detection
  for (let i = 0; i < placedStations.length; i++) {
    const a = placedStations[i]!;
    if (a.pkg && validPkgBounds.has(a.pkg)) {
      const pb = validPkgBounds.get(a.pkg)!;
      if (
        a.x < pb.minX - 4 ||
        a.x + a.w > pb.maxX + 4 ||
        a.y < pb.minY - 4 ||
        a.y + a.h > pb.maxY + 4
      ) {
        report.packageBoundsLeaks.push({
          nodeId: a.node.id,
          label: String(a.node.label ?? a.node.id),
          packageName: a.pkg,
          nodeBox: { x: a.x, y: a.y, width: a.w, height: a.h },
          packageBounds: { minX: pb.minX, minY: pb.minY, maxX: pb.maxX, maxY: pb.maxY },
        });
      }
    }

    for (let j = i + 1; j < placedStations.length; j++) {
      const b = placedStations[j]!;
      if (
        a.x + 1 < b.x + b.w &&
        a.x + a.w - 1 > b.x &&
        a.y + 1 < b.y + b.h &&
        a.y + a.h - 1 > b.y
      ) {
        report.stationOverlaps.push({
          nodeAId: a.node.id,
          nodeALabel: String(a.node.label ?? a.node.id),
          nodeBId: b.node.id,
          nodeBLabel: String(b.node.label ?? b.node.id),
          packageName: a.pkg || b.pkg || "root",
          boxA: { x: a.x, y: a.y, width: a.w, height: a.h },
          boxB: { x: b.x, y: b.y, width: b.w, height: b.h },
        });
      }
    }
  }

  // Edge coordinate finiteness + wire-through-card / wire-through-foreign-package diagnostics
  const stationsByPkg = new Map<string, typeof placedStations>();
  for (const s of placedStations) {
    if (!stationsByPkg.has(s.pkg)) stationsByPkg.set(s.pkg, []);
    stationsByPkg.get(s.pkg)!.push(s);
  }

  for (const e of payload.edges ?? []) {
    const sec = e?.sections?.[0];
    if (!sec) continue;
    const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].filter(Boolean);
    let invalidPt = false;
    for (const pt of pts) {
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
        report.nonFiniteItems.push(`Edge ${e.id} has non-finite routing coordinate (${pt.x}, ${pt.y})`);
        invalidPt = true;
        break;
      }
    }
    if (invalidPt || pts.length < 2) continue;

    const srcPkg = getPackagePrefix(String(e.sourceId ?? ""));
    const tgtPkg = getPackagePrefix(String(e.targetId ?? ""));
    if (srcPkg && tgtPkg && srcPkg === tgtPkg) {
      const siblings = stationsByPkg.get(srcPkg) ?? [];
      let recorded = false;
      for (let k = 0; k < pts.length - 1 && !recorded; k++) {
        const p1 = pts[k]!;
        const p2 = pts[k + 1]!;
        const minX = Math.min(p1.x, p2.x);
        const maxX = Math.max(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y);
        const maxY = Math.max(p1.y, p2.y);
        for (const card of siblings) {
          if (card.node.id === e.sourceId || card.node.id === e.targetId) continue;
          if (
            maxX > card.x + 2 &&
            minX < card.x + card.w - 2 &&
            maxY > card.y + 2 &&
            minY < card.y + card.h - 2
          ) {
            report.wireCollisions.push({
              edgeId: String(e.id),
              kind: "INTRA_PACKAGE_CARD",
              blockerId: card.node.id,
              blockerLabel: String(card.node.label ?? card.node.id),
              packageName: srcPkg,
            });
            recorded = true;
            break;
          }
        }
      }
    } else if (srcPkg && tgtPkg && srcPkg !== tgtPkg) {
      let recorded = false;
      for (let k = 0; k < pts.length - 1 && !recorded; k++) {
        const p1 = pts[k]!;
        const p2 = pts[k + 1]!;
        const minX = Math.min(p1.x, p2.x);
        const maxX = Math.max(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y);
        const maxY = Math.max(p1.y, p2.y);
        for (const [pkg, box] of validBoundsList) {
          if (pkg === srcPkg || pkg === tgtPkg) continue;
          const renderedMinY = box.minY - 32;
          if (
            maxX > box.minX + 2 &&
            minX < box.maxX - 2 &&
            maxY > renderedMinY + 2 &&
            minY < box.maxY - 2
          ) {
            report.wireCollisions.push({
              edgeId: String(e.id),
              kind: "CROSS_PACKAGE_BOX",
              blockerId: pkg,
              blockerLabel: pkg,
            });
            recorded = true;
            break;
          }
        }
      }
    }
  }

  report.passed =
    report.duplicateNodeIds.length === 0 &&
    report.duplicateInvariantKeys.length === 0 &&
    report.nonFiniteItems.length === 0 &&
    report.stationOverlaps.length === 0 &&
    report.packageBoundsLeaks.length === 0 &&
    report.macroPackageOverlaps.length === 0;

  return report;
}

/**
 * Entity types removed by Ontology v4.0 (mirrors `REMOVED_ENTITY_TYPES` in
 * `@chomp/core`). None may survive to the layout payload.
 */
const REMOVED_ENTITY_TYPES = new Set(["FILE", "DIRECTORY"]);

/**
 * Extract the canonical v4 entity ID from a layout node ID (`pkg::originalId::rowN` or `originalId::STORY-N`).
 */
function getOriginalId(layoutNodeId: string): string {
  const parts = layoutNodeId.split("::");
  if (parts.length >= 3) return parts[1];
  if (parts.length === 2) return parts[1].startsWith("STORY-") ? parts[0] : parts[1];
  return layoutNodeId;
}

function getPackagePrefix(layoutNodeId: string): string {
  const parts = layoutNodeId.split("::");
  return parts.length >= 3 ? parts[0] : "";
}

/**
 * Validates a LayoutData payload against the Visual Rules Ledger.
 *
 * Rules enforced:
 *   - Ontology v4.0: No removed entityType (`FILE` / `DIRECTORY`) may survive to the layout payload.
 *   - Edge Integrity: Every edge `sourceId` and `targetId` must exist in `payload.nodes`.
 *   - `[PAT-VIS-07]` Dead-End Ingress: Any `INGRESS` contract node with 0 outgoing edges is flagged.
 *   - `[PAT-VIS-08]` No Self-Loop: Flow graphs must be acyclic at the node level; self-loop edges are flagged.
 */
export function validateLayoutPayload(payload: any): string[] {
  const errors: string[] = [];
  if (!payload || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    return ["Rule Violation: Invalid layout payload structure"];
  }

  const validIds = new Set<string>(payload.nodes.map((n: any) => n.id));
  const outDegree = new Map<string, number>();
  for (const n of payload.nodes) {
    outDegree.set(n.id, 0);
  }

  for (const e of payload.edges) {
    if (!validIds.has(e.sourceId)) {
      errors.push(`Rule Violation: Edge ${e.id} has invalid sourceId ${e.sourceId}`);
    }
    if (!validIds.has(e.targetId)) {
      errors.push(`Rule Violation: Edge ${e.id} has invalid targetId ${e.targetId}`);
    }

    // [PAT-VIS-08] No Self-Loop rule
    const srcOrig = getOriginalId(e.sourceId);
    const tgtOrig = getOriginalId(e.targetId);
    const srcPkg = getPackagePrefix(e.sourceId);
    const tgtPkg = getPackagePrefix(e.targetId);
    if (e.sourceId === e.targetId || (srcOrig === tgtOrig && srcPkg === tgtPkg)) {
      errors.push(`Rule Violation [PAT-VIS-08]: Self-loop edge detected on ${e.sourceId} (${e.id})`);
    }

    outDegree.set(e.sourceId, (outDegree.get(e.sourceId) || 0) + 1);
  }

  for (const n of payload.nodes) {
    if (REMOVED_ENTITY_TYPES.has(n.entityType)) {
      errors.push(`Rule Violation: ${n.entityType} node found in layout (${n.label})`);
    }
    const isTopoNode = n.role !== undefined && n.role !== null;
    const declaresParent = n.parentId !== undefined && n.parentId !== null;
    if (!isTopoNode && !n.isPackage && declaresParent && !validIds.has(n.parentId)) {
      errors.push(`Rule Violation: Node ${n.label} has invalid parentId ${n.parentId}`);
    }

    // [PAT-VIS-07] Dead-End Ingress rule
    if (
      !n.isPackage &&
      n.role === "INGRESS" &&
      INGRESS_ENTITY_TYPES.has(n.entityType) &&
      (outDegree.get(n.id) || 0) === 0 &&
      (n.foldedFunctions?.length ?? 0) === 0
    ) {
      errors.push(
        `Rule Violation [PAT-VIS-07]: Dead-End Ingress "${n.label}" (${n.packageLabel || "root"}) has 0 outgoing edges`
      );
    }
  }

  // 2D Spatial & Geometric Invariants (finite coords, unique IDs, card non-overlap, package bounds containment, Macro Grid cell uniqueness)
  const geometry = auditLayoutGeometry(payload);
  for (const dupId of geometry.duplicateNodeIds) {
    errors.push(`Rule Violation: Duplicate layout node ID "${dupId}"`);
  }
  for (const dupInv of geometry.duplicateInvariantKeys) {
    errors.push(`Rule Violation: Duplicate invariant node "${dupInv}"`);
  }
  for (const item of geometry.nonFiniteItems) {
    errors.push(`Rule Violation: ${item}`);
  }
  for (const ov of geometry.stationOverlaps) {
    errors.push(
      `Rule Violation [PAT-VIS-17]: Overlapping station cards in "${ov.packageName}": "${ov.nodeALabel}" (${ov.boxA.x},${ov.boxA.y} ${ov.boxA.width}x${ov.boxA.height}) collides with "${ov.nodeBLabel}" (${ov.boxB.x},${ov.boxB.y} ${ov.boxB.width}x${ov.boxB.height})`,
    );
  }
  for (const leak of geometry.packageBoundsLeaks) {
    errors.push(
      `Rule Violation: Station "${leak.label}" (${leak.nodeBox.x},${leak.nodeBox.y} ${leak.nodeBox.width}x${leak.nodeBox.height}) leaks outside packageBounds["${leak.packageName}"]`,
    );
  }
  for (const macroOv of geometry.macroPackageOverlaps) {
    errors.push(`Rule Violation: ${macroOv.detail}`);
  }

  return errors;
}

export async function runVisualCartographer(repoPath: string): Promise<string> {
  const repoName = resolveRepoName(repoPath);
  const repoId = repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const dbPath = resolve(repoPath, ".chomp", "graph.db");

  if (!existsSync(dbPath)) return `Error: No Chomp database found at ${dbPath}`;

  const storage = createSQLiteStorage(dbPath);
  let graph = await storage.getRepresentationGraph(repoId);
  if (!graph) {
    const repos = await storage.listRepositories();
    if (repos[0]) {
      graph = await storage.getRepresentationGraph(repos[0].id);
    }
  }
  await storage.close();

  if (!graph) return `Error: No graph data found for repoId '${repoId}'`;

  // Run topological pipeline (loaded dynamically from local master layout engine)
  const {
    runStoryTracer,
    runZipMerge,
    runGridMapper,
    isSemanticUtilityLabel,
    writeMatrixCsv,
    writeLayoutCsv,
  } = await loadLocalMasterLayoutEngine();
  const stories = runStoryTracer(graph);
  const merged = runZipMerge(stories);
  writeMatrixCsv(merged);
  const layout = runGridMapper(merged);
  writeLayoutCsv(layout);

  let output = `# Autonomous Visual Cartographer Audit\n\n`;
  output += `_Scanning layout for spatial and relational anomalies..._\n\n`;

  // --- Phase A: Anomaly Hunting ---
  const dbFlowEdges = graph.edges.filter((e: any) => 
    e.entityType === 'CALL' || e.entityType === 'HTTP_FETCH' || e.entityType === 'REGISTERS'
  );
  const rawSelfLoops = dbFlowEdges.filter((e: any) => e.targetId && e.sourceId === e.targetId);
  
  // 1. Spatial Leaks
  const packages = new Map<string, { minY: number, maxY: number }>();
  for (const n of layout.nodes) {
    if (n.isPackage && n.packageLabel) {
      packages.set(n.packageLabel, { minY: n.y, maxY: n.y + n.height });
    }
  }

  const spatialLeaks = [];
  for (const n of layout.nodes) {
    if (n.isPackage || n.role === "ISLAND") continue;
    if (n.packageLabel && packages.has(n.packageLabel)) {
      const bounds = packages.get(n.packageLabel)!;
      // Allow slight margin for anchors or edges
      if (n.y < bounds.minY - 100 || n.y > bounds.maxY + 100) {
        spatialLeaks.push(n);
      }
    }
  }

  // 2. [PAT-VIS-07] Dead-End Ingress, [PAT-VIS-08] Self-Loops & Dangling Wires
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const n of layout.nodes) {
    inDegree.set(n.id, 0);
    outDegree.set(n.id, 0);
  }

  const selfLoops = [];
  for (const e of layout.edges) {
    outDegree.set(e.sourceId, (outDegree.get(e.sourceId) || 0) + 1);
    inDegree.set(e.targetId, (inDegree.get(e.targetId) || 0) + 1);

    const srcOrig = getOriginalId(e.sourceId);
    const tgtOrig = getOriginalId(e.targetId);
    const srcPkg = getPackagePrefix(e.sourceId);
    const tgtPkg = getPackagePrefix(e.targetId);
    if (e.sourceId === e.targetId || (srcOrig === tgtOrig && srcPkg === tgtPkg)) {
      selfLoops.push(e);
    }
  }

  const deadEndIngresses = [];
  const danglingWires = [];
  for (const n of layout.nodes) {
    if (n.isPackage) continue;
    const ins = inDegree.get(n.id) || 0;
    const outs = outDegree.get(n.id) || 0;

    // [PAT-VIS-07] Dead-End Ingress: any application INGRESS node with 0 outgoing edges
    if (
      n.role === "INGRESS" &&
      INGRESS_ENTITY_TYPES.has(n.entityType) &&
      outs === 0 &&
      (n.foldedFunctions?.length ?? 0) === 0
    ) {
      deadEndIngresses.push(n);
      continue;
    }

    // Must have incoming UNLESS it's an INGRESS, INGRESS_RETURN, or INIT_BLOCK
    if (
      ins === 0 &&
      n.role !== "INGRESS" &&
      n.role !== "INGRESS_RETURN" &&
      n.entityType !== "INIT_BLOCK" &&
      !INGRESS_ENTITY_TYPES.has(n.entityType)
    ) {
      danglingWires.push({ node: n, reason: "No incoming edges (Not an INGRESS)" });
    }
  }

  // 3. Broken Bridges
  const brokenBridges = [];
  const ingressIds = new Set<string>();
  const egressNodes = [];
  for (const n of layout.nodes) {
    if (
      n.role === "INGRESS" ||
      n.role === "INGRESS_RETURN" ||
      n.role === "TRANSIT" ||
      n.role === "RETURN"
    ) {
      ingressIds.add(`${n.packageLabel}::${getOriginalId(n.id)}`);
    }
    if (n.role === "EGRESS") egressNodes.push(n);
  }

  for (const egress of egressNodes) {
    // If it's a cross-package egress, it usually has `(To: pkg)` in its label.
    const match = egress.label.match(/\(To:\s*(.*?)\)/);
    if (match) {
      const targetPkg = match[1];
      const originalId = getOriginalId(egress.id);
      const expectedIngressId = targetPkg + "::" + originalId;
      const hasIngress = ingressIds.has(expectedIngressId);
      if (!hasIngress) {
        brokenBridges.push({ egress, targetPkg, originalId });
      }
    }
  }

  // 4. Backwards Time Travel
  const timeTravels = [];
  const pos = new Map<string, {x: number, y: number}>();
  for (const n of layout.nodes) pos.set(n.id, {x: n.x, y: n.y});
  for (const e of layout.edges) {
    const s = pos.get(e.sourceId);
    const t = pos.get(e.targetId);
    if (s && t && t.x <= s.x) {
      // Anchors might loop back, but in a strict topo they shouldn't.
      timeTravels.push(e);
    }
  }

  
  
  
  const packageOf = (id: string) => {
    let curr = id;
    let iterations = 0;
    while(curr && iterations < 10) {
      iterations++;
      const n = graph.nodes.find((n: any) => n.id === curr);
      if (!n) break;
      if (n.entityType === 'DEPLOYMENT_UNIT') {
        const parts = n.name.split('/');
        return parts[parts.length - 1];
      }
      curr = n.parentBoundaryId as string;
    }
    return '';
  };
  
  // 5. L1 Macro-Topological Flow
  const macroViolations: Array<{ srcPkg: string; tgtPkg: string; srcMaxX: number; tgtMinX: number }> = [];
  const pkgBoxes = new Map<string, {minX: number, maxX: number}>();
  for (const n of layout.nodes) {
    if (n.isPackage && n.packageLabel) {
      pkgBoxes.set(n.packageLabel, { minX: n.x, maxX: n.x + n.width });
    }
  }

  // Find cross-package calls
  for (const e of dbFlowEdges) {
    if (!e.targetId) continue;
    const srcPkg = packageOf(e.sourceId);
    const tgtPkg = packageOf(e.targetId);
    if (srcPkg && tgtPkg && srcPkg !== tgtPkg) {
      const srcBox = pkgBoxes.get(srcPkg);
      const tgtBox = pkgBoxes.get(tgtPkg);
      if (srcBox && tgtBox) {
        if (tgtBox.minX <= srcBox.maxX) {
          // Check if we already logged this pair
          const alreadyLogged = macroViolations.some(v => v.srcPkg === srcPkg && v.tgtPkg === tgtPkg);
          if (!alreadyLogged) {
            macroViolations.push({ srcPkg, tgtPkg, srcMaxX: srcBox.maxX, tgtMinX: tgtBox.minX });
          }
        }
      }
    }
  }

  // --- Phase B: Dynamic E2E Tracing ---
  let narratives = "";
  let hasAnomalies = false;

  // Build lookup maps for tracing
  const incoming = new Map<string, any>();
  const outgoing = new Map<string, any>();
  for (const e of layout.edges) {
    if (!incoming.has(e.targetId)) incoming.set(e.targetId, []);
    incoming.get(e.targetId).push(e.sourceId);

    if (!outgoing.has(e.sourceId)) outgoing.set(e.sourceId, []);
    outgoing.get(e.sourceId).push(e.targetId);
  }

  const findRoot = (nodeId: string): string => {
    let curr = nodeId;
    const visited = new Set<string>();
    while (curr) {
      if (visited.has(curr)) return "(Cycle detected at " + curr + ")";
      visited.add(curr);
      
      const node = layout.nodes.find((n: any) => n.id === curr);
      if (!node) return "(Unknown node " + curr + ")";
      
      if (node.role === 'INGRESS' || node.role === 'INGRESS_RETURN') {
        // If it's a cross package ingress, jump back to egress
        const originalId = getOriginalId(node.id);
        const egress = layout.nodes.find((n: any) => n.role === 'EGRESS' && getOriginalId(n.id) === originalId && n.label.includes(node.packageLabel));
        if (egress) {
          curr = egress.id;
          continue;
        } else {
          return node.label + " (" + node.packageLabel + ")";
        }
      }
      
      const ins = incoming.get(curr);
      if (!ins || ins.length === 0) return node.label + " (" + node.packageLabel + ")";
      curr = ins[0]; // just take first path for tracing
    }
    return "Unknown Root";
  };

  const findTerminal = (nodeId: string): string => {
    let curr = nodeId;
    const visited = new Set<string>();
    while (curr) {
      if (visited.has(curr)) return "(Cycle detected at " + curr + ")";
      visited.add(curr);
      
      const node = layout.nodes.find((n: any) => n.id === curr);
      if (!node) return "(Unknown node " + curr + ")";
      
      if (node.role === 'EGRESS') {
        const originalId = getOriginalId(node.id);
        const match = node.label.match(/\(To:\s*(.*?)\)/);
        if (match) {
           const targetPkg = match[1];
           const ingress = layout.nodes.find((n: any) => (n.role === 'INGRESS' || n.role === 'INGRESS_RETURN') && getOriginalId(n.id) === originalId && n.packageLabel === targetPkg);
           if (ingress) {
             curr = ingress.id;
             continue;
           } else {
             return "Broken Bridge at " + node.label;
           }
        }
      }
      
      const outs = outgoing.get(curr);
      if (!outs || outs.length === 0) return node.label + " (" + node.packageLabel + ")";
      curr = outs[0]; // just take first path for tracing
    }
    return "Unknown Terminal";
  };

  if (spatialLeaks.length > 0) {
    hasAnomalies = true;
    narratives += "### 🛸 Spatial Leaks (" + spatialLeaks.length + ")\n";
    for (const n of spatialLeaks.slice(0, 5)) {
      const root = findRoot(n.id);
      narratives += "- **Anomaly:** " + n.label + " (`" + n.packageLabel + "`) is floating at Y=" + n.y + ", outside its package bounds.\n";
      narratives += "  - *Trace:* Flow originates from `" + root + "`. The grid mapper failed to place it in `" + n.packageLabel + "`'s bounds.\n";
    }
  }

  if (deadEndIngresses.length > 0) {
    hasAnomalies = true;
    narratives += "### 🛑 Dead-End Ingress (`[PAT-VIS-07]`) (" + deadEndIngresses.length + ")\n";
    for (const n of deadEndIngresses.slice(0, 5)) {
      narratives += "- **Anomaly:** `" + n.label + "` (`" + n.packageLabel + "`) is an INGRESS entry with 0 outgoing edges.\n";
    }
  }

  if (selfLoops.length > 0) {
    hasAnomalies = true;
    narratives += "### 🔄 Self-Loops (`[PAT-VIS-08]`) (" + selfLoops.length + ")\n";
    for (const e of selfLoops.slice(0, 5)) {
      narratives += "- **Anomaly:** Self-loop edge `" + e.id + "` detected on `" + e.sourceId + "`.\n";
    }
  }

  if (danglingWires.length > 0) {
    hasAnomalies = true;
    narratives += "### 🔌 Dangling Wires (" + danglingWires.length + ")\n";
    for (const d of danglingWires.slice(0, 5)) {
      const root = findRoot(d.node.id);
      const terminal = findTerminal(d.node.id);
      narratives += "- **Anomaly:** " + d.node.label + " (" + d.node.packageLabel + ") -> " + d.reason + ";";
      narratives += "  - *Trace:* Root = `" + root + "`, Terminal = `" + terminal + "`.\n";
    }
  }

  if (brokenBridges.length > 0) {
    hasAnomalies = true;
    narratives += "### 🌉 Broken Bridges (" + brokenBridges.length + ")\n";
    for (const b of brokenBridges.slice(0, 5)) {
      const root = findRoot(b.egress.id);
      narratives += "- **Anomaly:** " + b.egress.label + " in `" + b.egress.packageLabel + "` claims to call `" + b.targetPkg + "`, but no matching INGRESS pin exists.\n";
      narratives += "  - *Trace:* Originated from `" + root + "`. The execution flow halts abruptly because the layout dropped the cross-package continuation.\n";
    }
  }

  if (timeTravels.length > 0) {
    hasAnomalies = true;
    narratives += "### ⏱️ Backwards Time Travel (" + timeTravels.length + ")\n";
    for (const e of timeTravels.slice(0, 5)) {
      narratives += "- **Anomaly:** Edge **" + e.name + "** flows backwards from X=" + pos.get(e.sourceId)?.x + " to X=" + pos.get(e.targetId)?.x + ".\n";
    }
  }

  if (macroViolations.length > 0) {
    hasAnomalies = true;
    narratives += "### 📦 L1 Macro-Topological Violations (" + macroViolations.length + ")\n";
    for (const v of macroViolations) {
      narratives += "- **Anomaly:** `" + v.srcPkg + "` calls `" + v.tgtPkg + "`, but the target package is not placed to the right. (`" + v.tgtPkg + "` minX=" + v.tgtMinX + " <= `" + v.srcPkg + "` maxX=" + v.srcMaxX + ")\n";
      narratives += "  - *Trace:* Package layout is currently a vertical tower, violating strict left-to-right L1 macro-flow.\n";
    }
  }

  // 6. [PAT-VIS-35] Semantic Station Classification, Return Truthfulness & Utility Audit
  const hasCrossPkgIncoming = new Set<string>();
  const hasEgressOutgoing = new Set<string>();
  const placedNodeById = new Map<string, any>();
  for (const n of layout.nodes) {
    placedNodeById.set(n.id, n);
  }
  for (const e of layout.edges) {
    const srcPkg = getPackagePrefix(e.sourceId);
    const tgtPkg = getPackagePrefix(e.targetId);
    if (srcPkg && tgtPkg && srcPkg !== tgtPkg) {
      hasCrossPkgIncoming.add(e.targetId);
    }
    const tgtNode = placedNodeById.get(e.targetId);
    if (tgtNode?.role === "EGRESS") {
      hasEgressOutgoing.add(e.sourceId);
    }
  }

  const leakedUtilities: Array<{ node: any; reason: string }> = [];
  const suspectReturnStations: Array<{ node: any; unresolvedNames: string[] }> = [];
  const overFoldedUnresolvedUtilities: Array<{ node: any; unresolvedCount: number }> = [];
  const zeroHelperReturnStations: Array<{ node: any; inDegree: number }> = [];
  const highReuseDomainUtilities: Array<{ node: any; callerCount: number; nestedCount: number }> = [];
  const roleStatsByPkg = new Map<
    string,
    {
      ingress: number;
      ingressReturn: number;
      transit: number;
      returnStation: number;
      egress: number;
      foldedUtilities: Set<string>;
    }
  >();

  for (const n of layout.nodes) {
    if (n.isPackage || n.role === "ISLAND") continue;
    const pkg = n.packageLabel || "root";
    let stats = roleStatsByPkg.get(pkg);
    if (!stats) {
      stats = {
        ingress: 0,
        ingressReturn: 0,
        transit: 0,
        returnStation: 0,
        egress: 0,
        foldedUtilities: new Set(),
      };
      roleStatsByPkg.set(pkg, stats);
    }
    if (n.role === "INGRESS") stats.ingress++;
    else if (n.role === "INGRESS_RETURN") stats.ingressReturn++;
    else if (n.role === "EGRESS") stats.egress++;
    else if (n.role === "RETURN") stats.returnStation++;
    else stats.transit++;

    for (const f of n.foldedFunctions ?? []) {
      stats.foldedUtilities.add(f.originalId);
    }

    if (
      (n.role === "RETURN" || n.role === "INGRESS_RETURN") &&
      ((n.unresolvedCount ?? 0) > 0 || n.hasUnlinkedCalls)
    ) {
      const unresolvedNames = (n.unresolvedCalls ?? []).map((u: any) => u.name);
      if (unresolvedNames.length === 0 && n.hasUnlinkedCalls) {
        unresolvedNames.push("unlinked internal/prototype call");
      }
      suspectReturnStations.push({ node: n, unresolvedNames });
    }

    const isUiComponentSection =
      n.entityType === "REACT_COMPONENT" ||
      n.entityType === "UI_COMPONENT" ||
      n.entityType === "ASTRO_COMPONENT" ||
      /^[A-Z][a-zA-Z0-9]*$/.test(n.label.trim());

    if (
      n.role === "RETURN" &&
      (n.foldedFunctions?.length ?? 0) === 0 &&
      !hasCrossPkgIncoming.has(n.id) &&
      (n.unresolvedCount ?? 0) === 0 &&
      !isUiComponentSection
    ) {
      zeroHelperReturnStations.push({ node: n, inDegree: inDegree.get(n.id) || 0 });
    }

    if (
      (n.role === "RETURN" || n.role === "TRANSIT" || n.role === "CORE") &&
      !hasCrossPkgIncoming.has(n.id) &&
      (n.unresolvedCount ?? 0) === 0 &&
      isSemanticUtilityLabel(n.label, 1, n.foldedFunctions?.length ?? 0)
    ) {
      const outs = outDegree.get(n.id) || 0;
      const ins = inDegree.get(n.id) || 0;
      if (outs === 0) {
        leakedUtilities.push({
          node: n,
          reason: `Terminal station (${n.role}) matches utility signature`,
        });
      } else if (ins === 1 && outs === 1 && !hasEgressOutgoing.has(n.id)) {
        leakedUtilities.push({
          node: n,
          reason: `1-in/1-out transit shim (${n.role}) matches utility signature`,
        });
      }
    }
  }

  for (const inv of layout.invariantNodes ?? []) {
    if (inv.classificationOverride !== "micro_node") {
      continue;
    }
    if ((inv.unresolvedCount ?? 0) > 0) {
      overFoldedUnresolvedUtilities.push({
        node: inv,
        unresolvedCount: inv.unresolvedCount ?? 0,
      });
    }
    const nestedCount = inv.foldedFunctions?.length ?? 0;
    const callerCount = inv.callerCount ?? 1;
    if (
      !isSemanticUtilityLabel(inv.label, 1, nestedCount) &&
      (callerCount >= 3 || nestedCount >= 2)
    ) {
      highReuseDomainUtilities.push({ node: inv, callerCount, nestedCount });
    }
  }

  if (leakedUtilities.length > 0) {
    hasAnomalies = true;
    narratives += `### 🧰 Leaked Composite Utilities (\`[PAT-VIS-35]\`) (${leakedUtilities.length})\n`;
    for (const item of leakedUtilities.slice(0, 8)) {
      narratives += `- **Anomaly:** \`${item.node.label}\` (\`${item.node.packageLabel}\`) -> ${item.reason}.\n`;
    }
  }

  if (suspectReturnStations.length > 0) {
    hasAnomalies = true;
    narratives += `### ⚠️ Suspect Return Stations (Unresolved Outgoing Calls) (\`[PAT-VIS-35]\`) (${suspectReturnStations.length})\n`;
    for (const item of suspectReturnStations.slice(0, 8)) {
      narratives += `- **Anomaly:** \`${item.node.label}\` (\`${item.node.packageLabel}\`, role=\`${item.node.role}\`) has ${item.node.unresolvedCount} unresolved outgoing call(s) (\`${item.unresolvedNames.slice(0, 3).join(", ")}\`) — may be a disguised broken \`TRANSIT\` conduit.\n`;
    }
  }

  if (overFoldedUnresolvedUtilities.length > 0) {
    hasAnomalies = true;
    narratives += `### 🕵️ Over-Folded Utilities Hiding Unresolved Calls (\`[PAT-VIS-35]\`) (${overFoldedUnresolvedUtilities.length})\n`;
    for (const item of overFoldedUnresolvedUtilities.slice(0, 8)) {
      narratives += `- **Anomaly:** Folded utility \`${item.node.label}\` (\`${item.node.packageLabel}\`) hides ${item.unresolvedCount} unresolved outgoing call(s).\n`;
    }
  }

  // 7. Cross-Package Edge Obstacle Collisions
  const edgeBoxCollisions: Array<{ edgeId: string; srcPkg: string; tgtPkg: string; blockingPkg: string }> = [];
  const allBoundsEntries = Object.entries(layout.packageBounds ?? {}) as Array<[string, any]>;
  for (const e of layout.edges) {
    const srcPkg = getPackagePrefix(e.sourceId);
    const tgtPkg = getPackagePrefix(e.targetId);
    if (!srcPkg || !tgtPkg || srcPkg === tgtPkg) continue;
    const sec = e.sections?.[0];
    if (!sec) continue;
    const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      for (const [pkg, box] of allBoundsEntries) {
        if (pkg === srcPkg || pkg === tgtPkg) continue;
        const renderedMinY = box.minY - 32;
        if (maxX > box.minX - 16 && minX < box.maxX + 16 && maxY > renderedMinY - 16 && minY < box.maxY + 16) {
          edgeBoxCollisions.push({ edgeId: e.id, srcPkg, tgtPkg, blockingPkg: pkg });
          break;
        }
      }
    }
  }

  if (edgeBoxCollisions.length > 0) {
    hasAnomalies = true;
    narratives += `### 🚧 Cross-Package Edge Obstacle Collisions (${edgeBoxCollisions.length})\n`;
    for (const col of edgeBoxCollisions.slice(0, 8)) {
      narratives += `- **Anomaly:** Cross-package edge \`${col.srcPkg} -> ${col.tgtPkg}\` (\`${col.edgeId}\`) intersects foreign package box \`${col.blockingPkg}\`.\n`;
    }
  }

  const geometryReport = auditLayoutGeometry(layout);
  if (!geometryReport.passed) {
    hasAnomalies = true;
    narratives += `### 📐 2D Spatial & Geometric Violations\n`;
    for (const ov of geometryReport.stationOverlaps.slice(0, 8)) {
      narratives += `- **Station Overlap (\`${ov.packageName}\`):** \`${ov.nodeALabel}\` collides with \`${ov.nodeBLabel}\`.\n`;
    }
    for (const leak of geometryReport.packageBoundsLeaks.slice(0, 8)) {
      narratives += `- **Package Bounds Leak (\`${leak.packageName}\`):** \`${leak.label}\` extends outside its owning package box.\n`;
    }
    for (const macroOv of geometryReport.macroPackageOverlaps.slice(0, 8)) {
      narratives += `- **Macro Package Collision:** ${macroOv.detail}.\n`;
    }
    for (const nf of geometryReport.nonFiniteItems.slice(0, 8)) {
      narratives += `- **Non-Finite Geometry:** ${nf}.\n`;
    }
  }

  if (hasAnomalies) {
    output += narratives;
  } else {
    output += "## ✅ Zero Anomalies Detected\n\n";
    output += "The topological visual model is mathematically sound. Spatial boxes are respected, E2E paths are continuous, and causality (time) strictly flows left-to-right.\n\n";
  }

  output += `## 📐 2D Spatial & Geometric Integrity\n`;
  output += `- **Geometry Gate:** ${geometryReport.passed ? "PASS" : "FAIL"}\n`;
  output += `- **Station Card AABB Overlaps:** ${geometryReport.stationOverlaps.length}\n`;
  output += `- **Package Bounds Containment Leaks:** ${geometryReport.packageBoundsLeaks.length}\n`;
  output += `- **Macro Package Box / Grid Collisions:** ${geometryReport.macroPackageOverlaps.length}\n`;
  output += `- **Non-Finite Coordinates (\`NaN\`/\`Infinity\`):** ${geometryReport.nonFiniteItems.length}\n`;
  output += `- **Duplicate Node / Invariant IDs:** ${geometryReport.duplicateNodeIds.length + geometryReport.duplicateInvariantKeys.length}\n`;
  output += `- **Wire-Obstacle Crossings (Intra-Card / Cross-Pkg):** ${geometryReport.wireCollisions.length}\n\n`;

  output += `## 🧭 Semantic Station Classification (\`[PAT-VIS-35]\`)\n`;
  for (const [pkg, st] of roleStatsByPkg.entries()) {
    output += `- **\`${pkg}\`:** ${st.ingress} INGRESS · ${st.ingressReturn} INGRESS_RETURN · ${st.transit} TRANSIT · ${st.returnStation} RETURN · ${st.egress} EGRESS · ${st.foldedUtilities.size} Folded Utilities\n`;
  }
  output += `\n`;
  output += `### 🔍 RETURN vs. UTILITY Truthfulness Criteria (\`[PAT-VIS-35]\`)\n`;
  output += `- **Suspect Return Stations (Unresolved Outgoing Calls):** ${suspectReturnStations.length}\n`;
  output += `- **Over-Folded Utilities Hiding Unresolved Calls:** ${overFoldedUnresolvedUtilities.length}\n`;
  output += `- **Leaked Utilities on Canvas:** ${leakedUtilities.length}\n`;
  if (zeroHelperReturnStations.length > 0) {
    output += `- **Zero-Helper \`RETURN\` Stations (${zeroHelperReturnStations.length} — verify domain compute role vs. utility):** ${zeroHelperReturnStations
      .slice(0, 8)
      .map((z) => `\`${z.node.label}\` (\`${z.node.packageLabel}\`, callers=${z.inDegree})`)
      .join(", ")}\n`;
  }
  if (highReuseDomainUtilities.length > 0) {
    output += `- **High-Reuse / Composite Folded Utilities (${highReuseDomainUtilities.length} — verify utility role vs. \`RETURN\` station):** ${highReuseDomainUtilities
      .slice(0, 8)
      .map(
        (h) =>
          `\`${h.node.label}\` (\`${h.node.packageLabel}\`, callers=${h.callerCount}, nested=${h.nestedCount})`
      )
      .join(", ")}\n`;
  }
  output += `\n`;

  // --- Phase C: Edge Accountability ---
  let bundleAbsorbed = 0;
  let foldedFnAbsorbed = 0;
  for (const n of layout.nodes) {
    if (n.bundledNames && n.bundledNames.length > 0) {
      bundleAbsorbed += n.bundledNames.length;
    }
    if (n.foldedFunctions && n.foldedFunctions.length > 0) {
      foldedFnAbsorbed += n.foldedFunctions.length;
    }
  }
  let badgeAbsorbed = layout.badgeNodes.length;

  output += `## 📊 Edge Accountability\n`;
  output += `- **Database Total Edges:** ${graph.edges.length}\n`;
  output += `- **Database Flow Edges:** ${dbFlowEdges.length}\n`;
  output += `- **Rendered Visible Edges:** ${layout.edges.length}\n`;
  output += `- **Raw Self-Loops Pruned (\`[PAT-VIS-08]\`):** ${rawSelfLoops.length}\n`;
  output += `- **Edges absorbed by Folded Utilities (\`[PAT-VIS-35]\`):** ~${foldedFnAbsorbed}\n`;
  output += `- **Edges absorbed by Terminal Bundles:** ~${bundleAbsorbed}\n`;
  output += `- **Edges absorbed by Badging:** ~${badgeAbsorbed}\n`;
  
  const unaccounted = dbFlowEdges.length - (layout.edges.length + rawSelfLoops.length + foldedFnAbsorbed + bundleAbsorbed + badgeAbsorbed);
  output += `\n*The remaining ${unaccounted} flow edges are likely pruned back-edges (cycles), merged duplicate paths, or cross-package continuations represented purely by pin alignment.*`;

  return output;
}
