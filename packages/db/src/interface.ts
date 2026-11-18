import type { RepresentationGraph } from '@chomp/core';

export interface RepositoryInfo {
  id: string;
  name: string;
  path: string;
  analyzedAt?: string;
  extractorVersion?: string;
  commitSha?: string;
  branchName?: string;
  projectId?: string;
}

export interface ScopeOptions {
  scopes?: Array<'USER' | 'TEST' | 'MOCK' | 'CONFIG' | 'EXAMPLE' | 'BENCHMARK'>;
}

/**
 * Canonical overlay layers (`[PAT-DB-03]`, `[PAT-EXT-22]`).
 * Developers and external tools may also register custom layers prefixed with `PLUGIN:`.
 */
export type OverlayLayer =
  | 'L1_PORTS'
  | 'L1_SEMANTIC'
  | 'L1_SHIMS'
  | 'L1_DESIGN_SYSTEM'
  | 'L2_RUNTIME'
  | 'L3_INFRA'
  | `PLUGIN:${string}`
  | (string & {});

/**
 * Epistemic provenance for an overlay record (`[PAT-DB-05]`, Principle of Incomplete Truth):
 * - `EXTRACTED`: Deterministic fact computed directly from source/artifact syntax or static analysis
 * - `INFERRED`: Heuristic or rule-based inference corroborated by structural signals
 * - `AI_HYPOTHESIS`: Probabilistic / LLM-authored semantic enrichment awaiting human or tool validation
 */
export type OverlayDerivation = 'EXTRACTED' | 'INFERRED' | 'AI_HYPOTHESIS';

/**
 * External (non-AST) file dependency for an overlay record (`[PAT-DB-05]`).
 * If the file's hash diverges from `hash`, the overlay is flagged `stale: true`
 * even when the target node's TypeScript AST `bodyHash` has not changed.
 */
export interface OverlayInputDependency {
  path: string;
  hash: string;
}

/**
 * Source evidence reference attached to an overlay record (`[PAT-DB-05]`).
 */
export interface OverlayEvidenceItem {
  filePath: string;
  lineNumber?: number;
  snippet?: string;
  evidenceRole?: string;
}

export interface EntityOverlayInput {
  /** Owning repository ID. If omitted, resolved automatically from the target entity or active repository. */
  repositoryId?: string;
  /** Deterministic SHA-256 entity ID (`nodes.id` or `edges.id`). */
  entityId: string;
  /** Overlay layer (`L1_PORTS`, `L1_SEMANTIC`, `L1_DESIGN_SYSTEM`, `L2_RUNTIME`, `L3_INFRA`, `PLUGIN:*`). */
  layer: OverlayLayer;
  /** Producer or plugin identifier (e.g. `chomp_enrich_nodes`, `datadog`, `design-system`, `openapi`). */
  source: string;
  /** Target environment (e.g. `default`, `production`, `staging`, `local`). Defaults to `'default'`. */
  environment?: string;
  /** Structured JSON payload for this overlay section. */
  payload: Record<string, any>;
  /**
   * Optional AST `bodyHash` of the target contract at the time the overlay was produced.
   * If omitted or `null`, automatically stamped from the entity's current `nodes.metadata.bodyHash` in SQLite.
   */
  bodyHash?: string | null;
  /**
   * Epistemic provenance (`EXTRACTED` | `INFERRED` | `AI_HYPOTHESIS`).
   */
  derivation?: OverlayDerivation;
  /**
   * Optional list of external non-AST input files (`path` + `hash`) that this overlay depends on.
   * If any declared input file's hash diverges on disk (or against `filter.inputHashes`), `stale` becomes `true`.
   */
  inputs?: OverlayInputDependency[];
  /**
   * Optional source evidence pointers (`filePath`, `lineNumber`, `snippet`).
   */
  evidence?: OverlayEvidenceItem[];
  /**
   * Optional execution/commit run identifier (`runId`). Used for prune-on-recommit so
   * re-running a plugin for `(repositoryId, layer, source, environment)` removes obsolete rows from prior runs.
   */
  runId?: string | null;
  /**
   * When true, prunes obsolete overlay rows from prior runs for the same
   * `(repositoryId, layer, source, environment)` whose `runId` differs from `runId`.
   */
  pruneStaleBySource?: boolean;
  /**
   * When true (default), merges `payload` keys into any existing overlay row for the same
   * `(entityId, layer, source, environment)` key. Set false to replace the payload wholesale.
   */
  merge?: boolean;
}

export interface EntityOverlayRecord {
  repositoryId: string;
  entityId: string;
  layer: OverlayLayer;
  source: string;
  environment: string;
  payload: Record<string, any>;
  bodyHash: string | null;
  derivation: OverlayDerivation;
  inputs?: OverlayInputDependency[];
  evidence?: OverlayEvidenceItem[];
  runId?: string | null;
  updatedAt: string;
  /**
   * True when the target node currently has a deterministic `bodyHash` in `nodes.metadata`
   * that differs from `bodyHash` recorded when this overlay was written (`[PAT-DB-03]`),
   * OR when any declared external file dependency in `inputs` has a divergent hash (`[PAT-DB-05]`).
   */
  stale: boolean;
}

export interface EntityOverlayFilter {
  entityId?: string;
  entityIds?: string[];
  layer?: OverlayLayer;
  layers?: OverlayLayer[];
  source?: string;
  environment?: string;
  runId?: string;
  /**
   * Optional map of external file path -> current hash for deterministic
   * staleness evaluation of `inputs`. When omitted, `getEntityOverlays` checks
   * live files on disk relative to the repository root if available.
   */
  inputHashes?: Record<string, string>;
}

export interface UpsertEntityOverlaysOptions {
  repositoryId?: string;
  layer?: OverlayLayer;
  source?: string;
  environment?: string;
  runId?: string;
  /**
   * When true (default whenever `runId` is provided on a batch upsert unless explicitly set false),
   * deletes obsolete rows from prior runs for each affected `(repositoryId, layer, source, environment)`.
   */
  pruneStaleBySource?: boolean;
}

export interface PruneEntityOverlaysFilter {
  repositoryId: string;
  layer: OverlayLayer;
  source: string;
  environment?: string;
  activeRunId: string;
}

export interface GraphIntegrityReport {
  repositoryId: string;
  valid: boolean;
  danglingEdgeSources: Array<{ edgeId: string; edgeName: string; sourceId: string }>;
  danglingEdgeTargets: Array<{ edgeId: string; edgeName: string; targetId: string }>;
  danglingParentBoundaries: Array<{ nodeId: string; nodeName: string; parentBoundaryId: string }>;
  orphanOverlays: Array<{ entityId: string; layer: string; source: string; environment: string }>;
}

export interface ChompStorage {
  saveRepresentationGraph(repo: RepositoryInfo, graph: RepresentationGraph): Promise<void>;
  getRepresentationGraph(repoId: string, options?: ScopeOptions): Promise<RepresentationGraph | null>;
  listRepositories(): Promise<RepositoryInfo[]>;
  deleteRepository(repoId: string): Promise<void>;
  updateNodeMetadata(nodeId: string, metadata: any): Promise<void>;
  upsertEntityOverlay(overlay: EntityOverlayInput): Promise<void>;
  upsertEntityOverlays(
    overlays: EntityOverlayInput[],
    options?: UpsertEntityOverlaysOptions
  ): Promise<void>;
  pruneEntityOverlays(filter: PruneEntityOverlaysFilter): Promise<number>;
  getEntityOverlays(repoId: string, filter?: EntityOverlayFilter): Promise<EntityOverlayRecord[]>;
  deleteEntityOverlay(filter: {
    repositoryId?: string;
    entityId?: string;
    layer?: string;
    source?: string;
    environment?: string;
  }): Promise<number>;
  checkGraphIntegrity(repoId: string): Promise<GraphIntegrityReport>;
  close(): Promise<void>;
}
