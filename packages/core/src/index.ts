/**
 * @module @chomp/core
 *
 * Public API surface for the Chomp Software Representation Engine core package.
 *
 * Provides structural ontology types (`StructuralEntity`, `EvidenceRecord`, `RepresentationGraph`),
 * Provides structural ontology types (`EvidenceRecord`, `RepresentationGraph`),
 * coverage ledger types, and AST extraction tools (`analyzeTarget`, `collectFiles`).
 *
 * Note: Internal TypeScript compiler API (`typescript`) imports are encapsulated inside the extractor package
 * and intentionally NOT re-exported here.
 */

export * from './version.js';
export * from './types/index.js';
export * from './utils/id.js';
export * from './extractor/index.js';
export * from './differ/index.js';
export * from './diagnostics/signalClusters.js';
export * from './diagnostics/shapeResolution.js';
export * from './diagnostics/healthMetrics.js';
export * from './diagnostics/frameworkCoverage.js';
export * from './diagnostics/unresolvedClassifier.js';
export * from './diagnostics/scoutSanity.js';
export * from './shims/applyShimOverlays.js';
export {
  CONVENTION_SETS,
  describeConventionSchema,
  describeConventions,
  loadUserConventionSets,
  validateConventionSet,
  type ConventionCatalogRow,
  type ConventionEdgeMatcherDoc,
  type ConventionNodeMatcherDoc,
  type ConventionRule,
  type ConventionRuleMeta,
  type ConventionSchemaReference,
  type ConventionSet,
  type EdgeMatcher,
  type EdgeRule,
  type EmitTemplate,
  type FileRoleRule,
  type NodeMatcher,
  type TargetStrategy,
} from './extractor/conventions/index.js';
