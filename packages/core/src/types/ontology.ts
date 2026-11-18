// packages/core/src/types/ontology.ts
// Core ontology types for the Chomp Software Representation Engine (Ontology v4.0 — Ephemeral Code).
// These 3 structural primitives + Open Connector (non-peer exit category) are the ONLY valid structural types — no additions without ontology review.
// See .context/01-thesis/SR_ledger_4.0_ephemeral_code.md

/**
 * The structural primitives of the Chomp ontology.
 * Every extracted entity must map to exactly one of these types.
 *
 * Boundary Collapse (v4.0): files and directories are NOT structural primitives.
 * They are positional metadata and live exclusively in `EvidenceRecord.filePath`.
 *
 * - BOUNDARY:        A scope of LOGICAL encapsulation (deployment unit, class/component, namespace, init block)
 * - CONTRACT:        An explicit interface for inter-unit communication (interface, type alias, exported fn, public method, API route)
 * - RELATIONSHIP:    A known structural dependency between units (import, inheritance, router mount)
 * - OPEN_CONNECTOR:  A known exit point beyond the current evidence boundary (HTTP client, DB client, message broker, external package)
 */
export type EntityType = 'BOUNDARY' | 'CONTRACT' | 'RELATIONSHIP' | 'OPEN_CONNECTOR';

/**
 * v4.0 BOUNDARY entityType vocabulary — logical encapsulation only.
 *
 * - DEPLOYMENT_UNIT: macro-architecture container (workspace package, crate, binary)
 * - CLASS:           instantiable blueprint (OOP class, UI component)
 * - NAMESPACE:       pure logical grouping of contracts (logical module, Rust `mod`, TS `namespace`)
 * - INIT_BLOCK:      implicit boundary for top-level side effects executed on load
 */
export const BOUNDARY_ENTITY_TYPES = ['DEPLOYMENT_UNIT', 'CLASS', 'NAMESPACE', 'INIT_BLOCK'] as const;
export type BoundaryEntityType = typeof BOUNDARY_ENTITY_TYPES[number];

/**
 * v4.0 OPEN_CONNECTOR entityType vocabulary for package-level exits.
 * EXTERNAL_PACKAGE moved here from BOUNDARY: an external package is a known exit
 * point beyond available evidence, never a scope we can see inside.
 */
export const OPEN_CONNECTOR_PACKAGE_ENTITY_TYPES = ['EXTERNAL_PACKAGE', 'NODE_BUILTIN'] as const;
export type OpenConnectorPackageEntityType = typeof OPEN_CONNECTOR_PACKAGE_ENTITY_TYPES[number];

/**
 * v4.0 CONTRACT entityType additions introduced by the Boundary Collapse.
 *
 * - PUBLIC_METHOD:   a method exposed by a CLASS boundary (attached via parentBoundaryId)
 * - EXPORTED_MODULE: the contract surface a source unit exposes, distinct from the file itself
 */
export const COLLAPSE_CONTRACT_ENTITY_TYPES = ['PUBLIC_METHOD', 'EXPORTED_MODULE'] as const;
export type CollapseContractEntityType = typeof COLLAPSE_CONTRACT_ENTITY_TYPES[number];

/**
 * Entity types removed from the ontology by the Boundary Collapse.
 * No node in a v4 graph or fixture may carry these. Retained only so linters can reject them.
 */
export const REMOVED_ENTITY_TYPES = ['FILE', 'DIRECTORY'] as const;

/**
 * Verification depth of a Contract's Port Valve schema (`[PAT-VIS-14]`, `[PAT-EXT-22]`).
 */
export type PortVerificationTier = 'syntactic' | 'typechecked' | 'spec';

/**
 * Syntactic or compiler source from which a Port Valve schema was derived.
 */
export type PortSchemaOrigin =
  | 'ts-signature'
  | 'ts-interface'
  | 'ts-typecheck'
  | 'zod'
  | 'mcp-schema'
  | 'drizzle'
  | 'route-handler'
  | 'openapi'
  | 'graphql';

/**
 * Structured field inside an object-shaped input parameter, return payload, validator, or table schema.
 */
export interface PortFieldSchema {
  /** Field or column identifier (e.g. `repoId`, `maxDepth`, `email`). */
  name: string;
  /** Concise type expression (e.g. `string`, `number`, `OrderItem[]`). */
  type: string;
  /** True when the property is optional (`?`, `.optional()`, `.default()`, or nullable column). */
  optional?: boolean;
  /** Nested object properties (depth-capped to keep inspector & agent payloads compact). */
  fields?: PortFieldSchema[];
}

/**
 * Source declaration pointer for an interface, type alias, or schema definition within the repository.
 */
export interface PortDeclarationRef {
  filePath: string;
  lineNumber?: number;
}

/**
 * Entry port parameter or request body slot accepted by a Contract.
 */
export interface PortParameterValve {
  /** Parameter or request slot name (e.g. `options`, `req.body`, `search_term`). */
  name: string;
  /** Declared or compiler-inferred type expression (`RunAnalyzeOptions`, `string`, `unknown`). */
  type: string;
  /** True when optional (`?`) or initialized with a default value (`= ...`). */
  optional?: boolean;
  /** Expanded object/interface/validator fields when statically resolvable. */
  fields?: PortFieldSchema[];
  /** Repository-relative source location of the referenced type or schema declaration. */
  declaration?: PortDeclarationRef;
}

/**
 * Exit port return value, response payload, or exposed schema shape produced by a Contract.
 */
export interface PortOutputValve {
  /** Declared or compiler-inferred output type (with outer `Promise<...>` unwrapped when `async` is set). */
  type: string;
  /** True when the Contract returns a `Promise` or is declared `async`. */
  async?: boolean;
  /** Expanded return/row/schema fields when statically resolvable. */
  fields?: PortFieldSchema[];
  /** Repository-relative source location of the referenced return type or schema declaration. */
  declaration?: PortDeclarationRef;
}

/**
 * Deterministic port-level type or schema mismatch detected at a Contract boundary (`[PAT-VIS-14]`).
 */
export interface PortDiagnostic {
  /** Classification of the boundary fault. */
  kind: 'TS_CALL_MISMATCH' | 'TS_RETURN_MISMATCH' | 'PORT_SCHEMA_MISMATCH';
  /** TypeScript compiler diagnostic code when emitted by Speed 2 `TypeChecker` (e.g. `2345`, `2322`, `2554`). */
  tsCode?: number;
  /** Concise single-line diagnostic message. */
  message: string;
  /** Repository-relative file path where the mismatch occurs. */
  filePath: string;
  /** 1-based line number of the mismatch site. */
  lineNumber?: number;
  /** Connected caller or callee Contract ID when the mismatch crosses a resolved graph edge. */
  peerEntityId?: string;
}

/**
 * Canonical Layer 1 Port Valve anatomy attached to a `CONTRACT` (or spec-backed `OPEN_CONNECTOR`).
 */
export interface ContractPortValves {
  /** Verification tier (`"syntactic"` = Speed 1 AST; `"typechecked"` = Speed 2 TypeChecker; `"spec"` = OpenAPI/GraphQL). */
  tier: PortVerificationTier;
  /** Primary extraction source of the port schema. */
  origin: PortSchemaOrigin;
  /** Flat non-primitive input type names retained for compact summaries and rule matching. */
  inputTypes?: string[];
  /** Flat output type summary retained for compact summaries and rule matching. */
  outputType?: string;
  /** Ordered entry port parameters or request payload slots. */
  inputs?: PortParameterValve[];
  /** Exit port return or schema shape. */
  output?: PortOutputValve;
  /** True when the callable explicitly accepts zero parameters (`()`), distinguishing `()` from unknown. */
  zeroInputs?: boolean;
  /** Proven boundary port mismatches discovered during Speed 2 verification. */
  diagnostics?: PortDiagnostic[];
}

/**
 * Deployment-topology annotation attached to a node's `metadata.runtime`.
 * Replaces framework-directive CONTRACT nodes (e.g. 'use client' / 'use server').
 */
export type RuntimeContext = 'client' | 'server';

/**
 * Well-known keys of `StructuralNode.metadata` (SR_ledger_5.0 Stackable Overlays).
 * Additional keys remain permitted.
 *
 * - Layer 0/1 (Design-Time Valves & Traits): `runtime`, `inputTypes`, `outputType`, `portValves`
 * - Layer 2 (Sandbox / Container Overlay):   `sandbox`
 * - Layer 3 (Verification / Sequence Trace): `traces`
 * - Layer 4 (Production Telemetry Overlay):  `telemetry`
 */
export interface NodeMetadata {
  /** Deployment-topology annotation derived from framework directives ('use client' / 'use server'). */
  runtime?: RuntimeContext;
  /** Layer 1 Input Port Valves — non-primitive parameter type schemas accepted by a callable CONTRACT. */
  inputTypes?: string[];
  /** Layer 1 Output Port Valve — non-primitive return type schema produced by a callable CONTRACT. */
  outputType?: string;
  /** Structured Layer 1 Port Valves (`[PAT-VIS-14]`, `[PAT-EXT-22]`) — Speed 1 syntactic port anatomy. */
  portValves?: ContractPortValves;
  /** Layer 2 Sandbox / Container runtime configuration overlay. */
  sandbox?: {
    containerPort?: number;
    image?: string;
    envVars?: string[];
  };
  /** Layer 3 E2E / Postman sequence trace overlay. */
  traces?: Array<{
    traceId: string;
    sequenceStep: number;
    status?: number;
  }>;
  /** Layer 4 Live production telemetry overlay. */
  telemetry?: {
    p95Ms?: number;
    errorRate?: number;
    rps?: number;
  };
  [key: string]: any;
}


/**
 * Source-level proof that a structural entity exists.
 * Every StructuralEntity must carry an EvidenceRecord — Chomp never asserts structure without evidence.
 *
 * Per the Principle of Incomplete Truth: lineNumber and snippet are optional.
 * Their absence is an honest "unknown", not a fabricated certainty.
 */
export interface EvidenceRecord {
  /** Relative path to the source file containing the entity. Sole source of truth for file location (v4.0). */
  filePath: string;
  /** 1-indexed line number where the entity was found. Optional — unknown is a valid state. */
  lineNumber?: number;
  /** Up to 80-character snippet of the source text at the extraction point. */
  snippet?: string;
  /** Categorical role for multiple evidence records (e.g. inferred method calls) */
  evidenceRole?: 'syntax-call' | 'import-match' | 'target-signature';
}

export interface StructuralNode {
  id: string;
  name: string;
  type: 'BOUNDARY' | 'CONTRACT' | 'OPEN_CONNECTOR';
  entityType: string;
  patternId: string;
  scope?: 'USER' | 'TEST' | 'MOCK' | 'CONFIG' | 'EXAMPLE' | 'BENCHMARK';
  evidence: EvidenceRecord | EvidenceRecord[];
  parentBoundaryId?: string; // Logical containment (e.g., Class -> Contract). Never a file.
  metadata?: NodeMetadata;
}

export interface StructuralEdge {
  id: string;
  name: string;
  type: 'RELATIONSHIP';
  entityType: string;
  patternId: string;
  scope?: 'USER' | 'TEST' | 'MOCK' | 'CONFIG' | 'EXAMPLE' | 'BENCHMARK';
  evidence: EvidenceRecord | EvidenceRecord[];
  sourceId: string; // Where the call originates
  targetId?: string; // What is being called/imported
  status?: 'DETERMINISTIC' | 'INFERRED';
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  metadata?: Record<string, any>;
}

export interface RepresentationGraph {
  extractorVersion: string;
  analyzedAt: string;
  commitSha?: string;
  branchName?: string;
  nodes: StructuralNode[];
  edges: StructuralEdge[];
  /**
   * Sorted relative file paths of non-barrel USER-scope source files traversed during extraction.
   * Used by self-diagnostic Dark File detection without introducing FILE nodes into `nodes`
   * (Ontology v4.0: files are positional metadata, never graph nodes).
   */
  analyzedFiles?: string[];
}

export interface StructuralEntity {
  id: string;
  name: string;
  type: EntityType;
  entityType: string;
  patternId: string;
  scope?: 'USER' | 'TEST' | 'MOCK' | 'CONFIG' | 'EXAMPLE' | 'BENCHMARK';
  evidence: EvidenceRecord | EvidenceRecord[];
  parentBoundaryId?: string;
  sourceId?: string;
  targetId?: string;
  status?: 'DETERMINISTIC' | 'INFERRED';
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  metadata?: Record<string, any>;
}

