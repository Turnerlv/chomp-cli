/**
 * packages/cli/src/visualizer/types.ts
 *
 * Shared types for the modular visualization pipeline.
 * These are internal pipeline types — NOT part of the core ontology.
 */

import type { ContractPortValves } from "@chomp/core";

// ---------------------------------------------------------------------------
// Working intermediate types (pre-layout)
// ---------------------------------------------------------------------------

export type NodeRole = "INGRESS" | "INGRESS_RETURN" | "TRANSIT" | "RETURN" | "EGRESS" | "CORE" | "ISLAND";

export type DiffVisualStatus = "ADDED" | "REMOVED" | "MODIFIED" | "UNCHANGED";

export interface DiffSummaryStats {
  baseCommitSha?: string;
  addedNodes: number;
  modifiedNodes: number;
  removedNodes: number;
  addedEdges: number;
  modifiedEdges: number;
  removedEdges: number;
}

export interface PackageHealthStats {
  boundaryId?: string;
  rawName?: string;
  packagePath?: string;
  summary?: string;
  domain?: string;
  status: "PASS" | "WARN";
  connectivityRate: number;
  rawConnectivityRate: number;
  knowableConnectivityRate?: number;
  entityTypeCoverage: number;
  parentCoverage: number;
  scopePurity: number;
  contractCount: number;
  resolvedCallCount: number;
  provableCallCount: number;
  knowableGapCount?: number;
  dynamicBoundaryCount?: number;
  platformPrimitiveCount?: number;
  unresolvedCallCount: number;
  orphanCount: number;
  invariantCount?: number;
}

export interface SystemHealthSummary {
  repoName: string;
  branchName?: string;
  commitSha?: string;
  commitMessage?: string;
  remoteUrl?: string;
  updatedAt?: number | string;
  status: "PASS" | "WARN";
  connectivityRate: number;
  rawConnectivityRate: number;
  knowableConnectivityRate?: number;
  entityTypeCoverage: number;
  parentCoverage: number;
  scopePurity: number;
  totalContracts: number;
  totalBoundaries: number;
  totalRelationships: number;
  totalOpenConnectors: number;
  resolvedCallCount?: number;
  knowableGapCount?: number;
  dynamicBoundaryCount?: number;
  platformPrimitiveCount?: number;
  unresolvedCallCount: number;
  orphanCount: number;
  invariantCount?: number;
}

export interface NodeEvidenceItem {
  filePath: string;
  lineNumber?: number;
  snippet?: string;
  evidenceRole?: string;
}

export interface EntityOverlayItem {
  repositoryId?: string;
  entityId: string;
  layer: string;
  source: string;
  environment: string;
  payload: Record<string, any>;
  bodyHash?: string | null;
  derivation?: "EXTRACTED" | "INFERRED" | "AI_HYPOTHESIS";
  inputs?: Array<{ path: string; hash: string }>;
  evidence?: NodeEvidenceItem[];
  runId?: string | null;
  updatedAt?: string;
  stale?: boolean;
}

export interface WorkingNode {
  id: string;
  label: string;
  /** Raw AST code identifier (stripped of ontology prefix) preserved before `humanLabel` override. */
  rawLabel?: string;
  entityType: string;
  /** Core ontology primitive (`BOUNDARY` | `CONTRACT` | `OPEN_CONNECTOR`). */
  ontologyType?: string;
  /** Chomp extractor pattern ID (e.g. `contract.exported-function`). */
  patternId?: string;
  /** Source file & line evidence attached to this entity. */
  evidence?: NodeEvidenceItem[];
  /** ID of the parent package node, if any. */
  parentId?: string;
  isPackage: boolean;
  diffStatus?: string;
  badges: string[];
  domain?: string;
  parentLabel?: string;
  packageLabel?: string;
  /** STORY-014: labels of the leaf contracts absorbed into a BUNDLE node. */
  bundledNames?: string[];
  /** Layer 1 Input Port Valves (`[PAT-VIS-14]`). */
  inputTypes?: string[];
  /** Layer 1 Output Port Valve (`[PAT-VIS-14]`). */
  outputType?: string;
  /** Canonical Two-Speed Layer 1 Port Valve schema (`[PAT-VIS-14]`). */
  portValves?: ContractPortValves;
  /** Number of active Speed 2 boundary port diagnostics (`[PAT-VIS-14]`). */
  portMismatchCount?: number;
  /** Extensible multi-layer & plugin overlays attached from `entity_overlays` (`[PAT-DB-03]`). */
  overlays?: EntityOverlayItem[];
  /** Count of actionable unresolved outgoing calls (`[PAT-VIS-15]`). */
  unresolvedCount?: number;
  /** Details of actionable unresolved outgoing calls (`[PAT-VIS-15]`). */
  unresolvedCalls?: UnresolvedCallItem[];
  /** True when the node has unlinked local-function, `this`, or import call edges (even if LOW-confidence). */
  hasUnlinkedCalls?: boolean;
  /** Optional rule-based override for station vs micro-node classification. */
  classificationOverride?: "station_node" | "micro_node";
  /** Number of distinct incoming callers targeting this node. */
  callerCount?: number;
  /** Non-transit internal helper functions & local side-effects folded into this station. */
  foldedFunctions?: FoldedFunctionItem[];
}

export interface FoldedFunctionItem {
  originalId: string;
  label: string;
  rawLabel?: string;
  entityType: string;
  parentLabel?: string;
  diffStatus?: DiffVisualStatus;
  status?: EdgeStatus;
  filePath?: string;
  lineNumber?: number;
  callerCount?: number;
}

export interface UnresolvedCallItem {
  name: string;
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  filePath?: string;
  lineNumber?: number;
  snippet?: string;
  reason?: "unresolved-target" | "opaque-body";
  /** Deterministic, identifier-free shape key recorded by the extractor (v5 Loop 1/3). */
  shapeKey?: string;
  /** Specific intra-repo connection failure reason when import-backed. */
  unresolvedReason?: string;
  importSpecifier?: string;
  resolvedFilePath?: string;
  targetSymbol?: string;
}

/** Provenance of a structural edge: AST-proven vs. AI/heuristic-hypothesised. */
export type EdgeStatus = "DETERMINISTIC" | "INFERRED";

export interface WorkingEdge {
  id: string;
  sourceId: string;
  targetId: string;
  name?: string;
  /** DETERMINISTIC (AST-proven) vs INFERRED (hypothesis). */
  status?: EdgeStatus;
  diffStatus?: string;
  badges?: string[];
}

// ---------------------------------------------------------------------------
// Final layout output types
// ---------------------------------------------------------------------------

export interface MicroNodeItem {
  originalId: string;
  id: string;
  label: string;
  rawLabel?: string;
  entityType: string;
  parentLabel?: string;
  diffStatus?: DiffVisualStatus;
  status?: EdgeStatus;
  relX: number;
  relY: number;
}

export interface LayoutNode extends WorkingNode {
  role: NodeRole;
  x: number;
  y: number;
  width: number;
  height: number;
  children?: string[];
  microNodes?: MicroNodeItem[];
}

export interface LayoutEdge extends WorkingEdge {
  sections?: any[];
  childIndex?: number;
}

/** One story lane's metadata — used by the renderer to draw row labels. */
export interface StoryRow {
  /** The grid Y coordinate of this lane (matches the node y values in this row) */
  y: number;
  entryLabel: string;
  packageLabel: string;
}

export interface PackageBounds {
  /** Authoritative package / deployment-unit display name (e.g. `@repo/ui`, `@chomp/core`, `nestjs-boilerplate`). */
  displayName?: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  /** Discrete Macro-Grid column index (0 = leftmost entry tier, increasing left-to-right). */
  macroCol?: number;
  /** Discrete Macro-Grid row index within `macroCol` (0 = topmost package in this column). */
  macroRow?: number;
  /** Global Micro-Grid starting row index (y = gridRowStart * ROW_HEIGHT). */
  gridRowStart?: number;
  /** Number of Micro-Grid rows spanned by this package board. */
  gridRowSpan?: number;
  /** Number of Micro-Grid columns spanned by this package board. */
  gridColSpan?: number;
  /** Total rendered station nodes in this package. */
  nodeCount?: number;
  /** Number of INGRESS pins in this package. */
  ingressCount?: number;
  /** Number of EGRESS pins in this package. */
  egressCount?: number;
  /** Number of execution stories in this package. */
  storyCount?: number;
  /** Number of folded master invariant nodes (`CLASS` blueprints, folded badges, micro-nodes) in this package (`[PAT-VIS-06]`). */
  invariantCount?: number;
  /** Number of unreachable orphan contracts (`inDegree === 0`) in this package (`[PAT-VIS-06]`). */
  orphanCount?: number;
  /** True when a pure-library package (`0` stories) auto-fell back to rendering its `foldedMasterNodes` grid (`[PAT-VIS-06]`). */
  isPureLibraryFallback?: boolean;
  /** Aggregated diff status for the package board in Diff Mode (`[PAT-VIS-24]`). */
  diffStatus?: DiffVisualStatus;
  addedCount?: number;
  modifiedCount?: number;
  removedCount?: number;
  /** Per-package `chomp health` metrics & boundary metadata (`[PAT-VIS-08]`, `[PAT-VIS-15]`). */
  health?: PackageHealthStats;
  /** True when micro stations for this package were withheld on the server in Preview Mode (`W2.0b`). */
  previewLocked?: boolean;
}

export type ChompGatingMode = "early_access" | "enforced";

export type ChompEntitlementTier =
  | "master"
  | "early_access"
  | "preview"
  | "trial"
  | "trial_expired"
  | "pro"
  | "team"
  | "vip";

export interface LayoutEntitlement {
  tier: ChompEntitlementTier;
  status?: "active" | "expired" | "preview";
  trialDaysRemaining?: number;
  previewMode: boolean;
  gatingMode?: ChompGatingMode;
  githubHandle?: string;
  unlockedPackage?: string;
  unlockedStationCount?: number;
  lockedPackageCount?: number;
  lockedStationCount?: number;
}

export interface MacroPackageEdge {
  id: string;
  sourcePkg: string;
  targetPkg: string;
  weight: number;
  pinCount: number;
  status?: "DETERMINISTIC" | "INFERRED";
  diffStatus?: DiffVisualStatus;
}

/** The canonical layout payload returned by GET /api/layout. */
export interface LayoutData {
  repoName?: string;
  branchName?: string;
  commitSha?: string;
  commitMessage?: string;
  remoteUrl?: string;
  updatedAt?: number | string;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  islandNodes: LayoutNode[];
  /** Package-scoped master invariant nodes (`CLASS` blueprints + folded badge/micro-node contracts, `[PAT-VIS-06]`). */
  invariantNodes?: LayoutNode[];
  badgeNodes: { id: string; label: string }[];
  /** One entry per story lane, in render order, for drawing row labels. */
  storyRows: StoryRow[];
  packageBounds?: Record<string, PackageBounds>;
  /** Aggregated package-to-package edges for the Bird's-Eye Macro Grid view. */
  macroEdges?: MacroPackageEdge[];
  /** Underlying stories for wiring and story trace CSV generation. */
  cliStories?: any[];
  /** Summary of structural deltas when `diff=true` (`[PAT-VIS-24]`). */
  diffSummary?: DiffSummaryStats;
  /** System-level `chomp health` summary (`[PAT-VIS-25]`). */
  healthSummary?: SystemHealthSummary;
  /** Repository-level entity overlays from `entity_overlays` (`[PAT-DB-03]`). */
  overlays?: EntityOverlayItem[];
  /** Entitlement & Preview Mode state returned by `api.getchomp.dev` or local master engine (`W2.0b`–`W2.0f`). */
  entitlement?: LayoutEntitlement;
}

