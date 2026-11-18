// packages/core/src/diagnostics/scoutSanity.ts
//
// Deterministic Stack-vs-Graph-vs-Layout Sanity Diff (`[PAT-CLI-16]`).
//
// Cross-checks observable repository metadata (`package.json` dependencies + directory structure)
// against the extracted `RepresentationGraph` and optional headless layout metrics to automatically
// flag structural & visual anomalies on unseen ("wild") repositories with zero prior repo knowledge:
//   (a) BOUNDARY_COLLAPSE — multi-workspace / multi-package repo collapsed into 1 DEPLOYMENT_UNIT
//   (b) RECEPTOR_DIALECT_MISMATCH — package.json declares pg/mysql/mongodb/redis, but DB receptors
//       fall through to generic `Database: SQLite` or produce 0 matching DB receptors
//   (c) ZERO_EDGE_COLLAPSE / MASKED_LOW_CONNECTIVITY / DEAD_END_INGRESS / HIGH_ORPHAN_RATIO /
//       DARK_FILES / SUSPECTED_CUSTOM_CONVENTION / UNHANDLED_FRAMEWORK
//   (d) UNREGISTERED_SHAPE_CLUSTERS — knowable `sk1/...` keys with `unresolved > 0` not yet in
//       `pattern_ledger.db`

import fs from 'fs';
import path from 'path';
import type {
  EvidenceRecord,
  RepresentationGraph,
  StructuralEdge,
  StructuralNode,
} from '../types/index.js';
import { buildWorkspaceRegistry } from '../extractor/workspaceResolver.js';
import {
  auditFrameworkCoverage,
  type FrameworkCoverageReport,
} from './frameworkCoverage.js';
import {
  collectLedgerSignalCandidates,
  type LedgerSignalCandidate,
} from './shapeResolution.js';
import {
  computeStructuralHealthMetrics,
  type CallResolutionCounts,
} from './healthMetrics.js';

export type ScoutAnomalyKind =
  | 'BOUNDARY_COLLAPSE'
  | 'RECEPTOR_DIALECT_MISMATCH'
  | 'SHADOWED_DB_RECEPTOR'
  | 'ZERO_EDGE_COLLAPSE'
  | 'MASKED_LOW_CONNECTIVITY'
  | 'DEAD_END_INGRESS'
  | 'HIGH_ORPHAN_RATIO'
  | 'DARK_FILES'
  | 'UNEXTRACTED_TARGET_CONTRACT'
  | 'UNEXTRACTED_EXPORTS'
  | 'SUSPECTED_CUSTOM_CONVENTION'
  | 'UNHANDLED_FRAMEWORK'
  | 'TRACER_STARVATION_DROP'
  | 'SUSPICIOUS_BUILTIN_METHOD_TARGET'
  | 'CONTRACT_HASH_COLLISION'
  | 'CROSS_SCOPE_DANGLING_EDGE';

export interface ScoutAnomalyEvidence {
  label?: string;
  filePath?: string;
  lineNumber?: number;
  snippet?: string;
}

export interface ScoutSanityAnomaly {
  kind: ScoutAnomalyKind;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  whatsWrong: string;
  proposedFix: string;
  evidence: ScoutAnomalyEvidence[];
}

export interface ScoutLayoutMetricsInput {
  /** Number of stories traced by `1-storyTracer`. */
  storyCount?: number;
  /** Number of rendered edges in `LayoutData.edges`. */
  renderedEdgeCount?: number;
  /** Maximum topological column index (`0` means single-column layout). */
  maxCol?: number;
  /** External receptor package labels rendered by `3-gridMapper` (e.g. `["Database: SQLite"]`). */
  renderedReceptorBoxes?: readonly string[];
  /** Node IDs classified into `storyGraph.orphanNodes` by `1-storyTracer`. */
  orphanNodeIds?: readonly string[];
}

export interface DetectedDbDriver {
  dialect: 'PostgreSQL' | 'MySQL' | 'SQLite' | 'MongoDB' | 'Redis' | 'MessageBroker';
  expectedReceptorPkg: string;
  dep: string;
}

export interface ScoutSnapshotSummary {
  repoName: string;
  repoPath: string;
  detectedStack: string[];
  detectedDbDrivers: DetectedDbDriver[];
  detectedTierDirs: string[];
  deploymentUnits: string[];
  boundaryCount: number;
  contractCount: number;
  openConnectorCount: number;
  relationshipCount: number;
  resolvedFlowEdgeCount: number;
  ingressCount: number;
  deadEndIngressCount: number;
  orphanContractCount: number;
  orphanRatioPercent: number;
  darkFileCount: number;
  unextractedExportCount: number;
  connectivityRate: number;
  rawConnectivityRate: number;
  knowableConnectivityRate?: number;
  callResolutionCounts?: CallResolutionCounts;
  storyCount?: number;
  renderedEdgeCount?: number;
  maxCol?: number;
  renderedReceptorBoxes: string[];
}

export interface ScoutSanityReport {
  summary: ScoutSnapshotSummary;
  anomalies: ScoutSanityAnomaly[];
  frameworkCoverage: FrameworkCoverageReport;
  unregisteredSignalCandidates: LedgerSignalCandidate[];
}

export interface AuditScoutSanityOptions {
  repoName?: string;
  excludeWorkspaces?: readonly string[];
  registeredShapeKeys?: ReadonlySet<string>;
  layoutMetrics?: ScoutLayoutMetricsInput;
  maxSignalCandidates?: number;
}

const DB_DRIVER_RULES: ReadonlyArray<{
  dialect: DetectedDbDriver['dialect'];
  expectedReceptorPkg: string;
  deps: readonly string[];
}> = [
  {
    dialect: 'PostgreSQL',
    expectedReceptorPkg: 'Database: PostgreSQL',
    deps: [
      'pg',
      'postgres',
      '@neondatabase/serverless',
      '@vercel/postgres',
      '@supabase/supabase-js',
      '@prisma/adapter-pg',
      '@electric-sql/pglite',
    ],
  },
  {
    dialect: 'MySQL',
    expectedReceptorPkg: 'Database: MySQL',
    deps: ['mysql', 'mysql2', '@planetscale/database'],
  },
  {
    dialect: 'SQLite',
    expectedReceptorPkg: 'Database: SQLite',
    deps: ['better-sqlite3', 'sqlite3', '@libsql/client', 'sql.js'],
  },
  {
    dialect: 'MongoDB',
    expectedReceptorPkg: 'Database: MongoDB',
    deps: ['mongodb', 'mongoose'],
  },
  {
    dialect: 'Redis',
    expectedReceptorPkg: 'Cache: Redis',
    deps: ['redis', 'ioredis', '@upstash/redis'],
  },
  {
    dialect: 'MessageBroker',
    expectedReceptorPkg: 'Queue: Message Broker',
    deps: ['bull', 'bullmq', 'kafkajs', 'amqplib', 'nats'],
  },
];

const INGRESS_CONTRACT_TYPES = new Set<string>([
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

const NON_EXECUTABLE_CONTRACT_TYPES = new Set<string>([
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

const CONNECTIVITY_TARGET_TYPES = new Set<string>([
  'CALL',
  'INHERITS',
  'MIXES',
  'RENDERS',
  'BINDS_ROUTE',
  'INTERCEPTS',
]);

const ARCHITECTURAL_TIER_DIRS = new Set<string>([
  'api',
  'app',
  'apps',
  'backend',
  'cli',
  'client',
  'Collections',
  'collections',
  'components',
  'controllers',
  'core',
  'db',
  'drizzle',
  'endpoints',
  'features',
  'frontend',
  'graphql',
  'hooks',
  'jobs',
  'lib',
  'mcp',
  'middleware',
  'models',
  'modules',
  'packages',
  'pages',
  'prisma',
  'queues',
  'repositories',
  'routes',
  'routers',
  'schema',
  'server',
  'services',
  'store',
  'trpc',
  'ui',
  'web',
  'workers',
]);

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function getPrimaryEvidence(
  entity: Pick<StructuralNode | StructuralEdge, 'evidence'>
): EvidenceRecord | undefined {
  const ev = entity.evidence;
  if (!ev) return undefined;
  return Array.isArray(ev) ? ev[0] : ev;
}

function collectAllRepoDependencies(repoRoot: string): Set<string> {
  const deps = new Set<string>();
  const pkgPaths = new Set<string>();
  const rootPkg = path.join(repoRoot, 'package.json');
  if (fs.existsSync(rootPkg)) pkgPaths.add(rootPkg);

  try {
    const registry = buildWorkspaceRegistry(repoRoot);
    for (const absPath of Object.values(registry)) {
      const p = path.join(absPath, 'package.json');
      if (fs.existsSync(p)) pkgPaths.add(p);
    }
  } catch {
    // Ignore workspace discovery errors
  }

  for (const pkgPath of pkgPaths) {
    try {
      const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        const obj = raw?.[field];
        if (obj && typeof obj === 'object') {
          for (const k of Object.keys(obj)) deps.add(k);
        }
      }
    } catch {
      // Ignore malformed package.json
    }
  }
  return deps;
}

function detectDbDriversFromDeps(deps: ReadonlySet<string>): DetectedDbDriver[] {
  const found: DetectedDbDriver[] = [];
  for (const rule of DB_DRIVER_RULES) {
    for (const dep of rule.deps) {
      if (deps.has(dep)) {
        found.push({
          dialect: rule.dialect,
          expectedReceptorPkg: rule.expectedReceptorPkg,
          dep,
        });
      }
    }
  }
  return found;
}

function detectArchitecturalTierDirs(repoRoot: string): string[] {
  const found = new Set<string>();
  const scanRoots: Array<{ prefix: string; dir: string }> = [
    { prefix: '', dir: repoRoot },
    { prefix: 'src/', dir: path.join(repoRoot, 'src') },
  ];

  for (const { prefix, dir } of scanRoots) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        if (ARCHITECTURAL_TIER_DIRS.has(entry.name)) {
          found.add(`${prefix}${entry.name}`);
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  }

  // Also check for Next.js `app/api` or `src/app/api` split
  for (const rel of ['app/api', 'src/app/api', 'pages/api', 'src/pages/api']) {
    if (fs.existsSync(path.join(repoRoot, rel))) {
      found.add(rel);
    }
  }

  return [...found].sort();
}

export type DatabaseReceptorDialect =
  | 'Database: PostgreSQL'
  | 'Database: MySQL'
  | 'Database: SQLite'
  | 'Database: MongoDB'
  | 'Database: SQL';

export interface ExternalReceptorSpec {
  pkg: string;
  nodeLabel: string;
  receptorId: string;
}

const POSTGRES_PACKAGE_SPECS = new Set([
  'pg',
  'pg-pool',
  'pg-promise',
  'postgres',
  '@neondatabase/serverless',
  '@vercel/postgres',
  '@supabase/supabase-js',
  '@supabase/ssr',
  '@prisma/adapter-pg',
  '@prisma/adapter-neon',
  '@electric-sql/pglite',
  '@payloadcms/db-postgres',
  '@payloadcms/db-vercel-postgres',
]);

const POSTGRES_PACKAGE_PREFIXES = [
  'drizzle-orm/pg-core',
  'drizzle-orm/node-postgres',
  'drizzle-orm/postgres-js',
  'drizzle-orm/neon-',
  'drizzle-orm/vercel-postgres',
  'drizzle-orm/supabase',
  'drizzle-orm/pglite',
  'drizzle-orm/aws-data-api/pg',
  'drizzle-orm/prisma/pg',
  'drizzle-orm/xata',
];

const MYSQL_PACKAGE_SPECS = new Set([
  'mysql',
  'mysql2',
  'mysql2/promise',
  '@planetscale/database',
  '@prisma/adapter-planetscale',
  '@prisma/adapter-mariadb',
  'mariadb',
]);

const MYSQL_PACKAGE_PREFIXES = [
  'drizzle-orm/mysql-core',
  'drizzle-orm/mysql2',
  'drizzle-orm/planetscale-',
  'drizzle-orm/tidb-',
];

const SQLITE_PACKAGE_SPECS = new Set([
  'better-sqlite3',
  'sqlite3',
  'sqlite',
  '@libsql/client',
  '@prisma/adapter-libsql',
  '@prisma/adapter-better-sqlite3',
  'sql.js',
  '@payloadcms/db-sqlite',
]);

const SQLITE_PACKAGE_PREFIXES = [
  'drizzle-orm/sqlite-core',
  'drizzle-orm/better-sqlite3',
  'drizzle-orm/libsql',
  'drizzle-orm/d1',
  'drizzle-orm/bun-sqlite',
  'drizzle-orm/expo-sqlite',
  'drizzle-orm/op-sqlite',
  'drizzle-orm/sql-js',
];

const MONGODB_PACKAGE_SPECS = new Set([
  'mongodb',
  'mongoose',
  '@payloadcms/db-mongodb',
  '@typegoose/typegoose',
]);

function classifyPackageSpecifierDialect(spec: string): DatabaseReceptorDialect | null {
  const s = spec.trim().toLowerCase();
  if (
    POSTGRES_PACKAGE_SPECS.has(s) ||
    POSTGRES_PACKAGE_PREFIXES.some((p) => s === p || s.startsWith(p))
  ) {
    return 'Database: PostgreSQL';
  }
  if (
    MYSQL_PACKAGE_SPECS.has(s) ||
    MYSQL_PACKAGE_PREFIXES.some((p) => s === p || s.startsWith(p))
  ) {
    return 'Database: MySQL';
  }
  if (
    SQLITE_PACKAGE_SPECS.has(s) ||
    SQLITE_PACKAGE_PREFIXES.some((p) => s === p || s.startsWith(p))
  ) {
    return 'Database: SQLite';
  }
  if (MONGODB_PACKAGE_SPECS.has(s)) {
    return 'Database: MongoDB';
  }
  return null;
}

function classifySchemaOrAdapterNodeDialect(node: StructuralNode): DatabaseReceptorDialect | null {
  const meta =
    node.metadata && typeof node.metadata === 'object'
      ? (node.metadata as Record<string, any>)
      : undefined;
  const metaDialect = typeof meta?.dialect === 'string' ? meta.dialect.toLowerCase() : '';
  if (metaDialect === 'postgresql' || metaDialect === 'postgres') return 'Database: PostgreSQL';
  if (metaDialect === 'mysql') return 'Database: MySQL';
  if (metaDialect === 'sqlite') return 'Database: SQLite';
  if (metaDialect === 'mongodb' || metaDialect === 'mongo') return 'Database: MongoDB';

  if (node.entityType === 'DB_SCHEMA' || node.patternId === 'contract.drizzle-schema') {
    const evs = Array.isArray(node.evidence)
      ? node.evidence
      : node.evidence
        ? [node.evidence]
        : [];
    for (const ev of evs) {
      const snip = ev?.snippet ?? '';
      if (/\b(?:pgTable|pgEnum|pgSchema)\b/.test(snip)) return 'Database: PostgreSQL';
      if (/\b(?:mysqlTable|mysqlEnum|mysqlSchema)\b/.test(snip)) return 'Database: MySQL';
      if (/\b(?:sqliteTable)\b/.test(snip)) return 'Database: SQLite';
    }
  }

  if (node.patternId === 'open-connector.payload-db-adapter') {
    const lower = node.name.toLowerCase();
    if (lower.includes('postgres')) return 'Database: PostgreSQL';
    if (lower.includes('sqlite')) return 'Database: SQLite';
    if (lower.includes('mongoose') || lower.includes('mongo')) return 'Database: MongoDB';
  }

  return null;
}

function resolveDialectSet(dialects: Set<DatabaseReceptorDialect>): DatabaseReceptorDialect {
  if (dialects.size === 1) {
    return [...dialects][0];
  }
  const sqlOnly = [...dialects].filter(
    (d) =>
      d === 'Database: PostgreSQL' ||
      d === 'Database: MySQL' ||
      d === 'Database: SQLite'
  );
  if (sqlOnly.length === 1) {
    return sqlOnly[0];
  }
  return 'Database: SQL';
}

function normalizeUnitShortLabel(name: string): string {
  return name.replace(/^Deployment Unit:\s*/i, '').split('/').pop() || name;
}

/**
 * Deterministically infers the repository and per-package (`DEPLOYMENT_UNIT`) database receptor
 * dialect from extracted `DB_SCHEMA` contracts (`pgTable`/`pgEnum` vs `mysqlTable` vs `sqliteTable`),
 * `EXTERNAL_PACKAGE` Open Connectors (`pg`, `postgres`, `@neondatabase/serverless`, `@supabase/supabase-js`,
 * `mysql2`, `better-sqlite3`, `sqlite3`, `@libsql/client`, `mongodb`, `mongoose`), and adapter connectors
 * (`[PAT-VIS-16]`). Falls back to `'Database: SQL'` when no single dialect is evidenced—never defaulting
 * unknown SQL connectors to `'Database: SQLite'`.
 */
export function inferDatabaseDialectFromGraph(
  graph?: Pick<RepresentationGraph, 'nodes'> | null
): {
  defaultDialect: DatabaseReceptorDialect;
  dialectByPackage: Record<string, DatabaseReceptorDialect>;
} {
  if (!graph || !Array.isArray(graph.nodes)) {
    return { defaultDialect: 'Database: SQL', dialectByPackage: {} };
  }

  const nodeById = new Map<string, StructuralNode>();
  const unitInfoById = new Map<
    string,
    { label: string; unitPath: string; analyzedFiles: Set<string> }
  >();

  for (const n of graph.nodes) {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
    if (n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT') {
      const label = normalizeUnitShortLabel(n.name);
      const ev = getPrimaryEvidence(n);
      const unitPath = ev?.filePath && ev.filePath !== '.' ? ev.filePath.replace(/\/+$/, '') : '';
      const meta =
        n.metadata && typeof n.metadata === 'object'
          ? (n.metadata as Record<string, any>)
          : undefined;
      const files = Array.isArray(meta?.analyzedFiles)
        ? new Set<string>(meta.analyzedFiles.filter((f: unknown): f is string => typeof f === 'string'))
        : new Set<string>();
      unitInfoById.set(n.id, { label, unitPath, analyzedFiles: files });
    }
  }

  const findUnitLabelForNode = (n: StructuralNode): string[] => {
    const labels = new Set<string>();
    let cur: StructuralNode | undefined = n;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.entityType === 'DEPLOYMENT_UNIT') {
        labels.add(normalizeUnitShortLabel(cur.name));
        break;
      }
      cur = cur.parentBoundaryId ? nodeById.get(cur.parentBoundaryId) : undefined;
    }
    if (labels.size > 0) return [...labels];

    const evs = Array.isArray(n.evidence) ? n.evidence : n.evidence ? [n.evidence] : [];
    for (const ev of evs) {
      const fp = ev?.filePath;
      if (!fp) continue;
      for (const unit of unitInfoById.values()) {
        if (
          unit.analyzedFiles.has(fp) ||
          (unit.unitPath && (fp === unit.unitPath || fp.startsWith(`${unit.unitPath}/`)))
        ) {
          labels.add(unit.label);
        }
      }
    }
    return [...labels];
  };

  const repoDialects = new Set<DatabaseReceptorDialect>();
  const dialectsByPkg = new Map<string, Set<DatabaseReceptorDialect>>();

  const recordDialect = (node: StructuralNode, dialect: DatabaseReceptorDialect) => {
    repoDialects.add(dialect);
    for (const pkgLabel of findUnitLabelForNode(node)) {
      let set = dialectsByPkg.get(pkgLabel);
      if (!set) {
        set = new Set<DatabaseReceptorDialect>();
        dialectsByPkg.set(pkgLabel, set);
      }
      set.add(dialect);
    }
  };

  for (const node of graph.nodes) {
    if ((node.scope ?? 'USER') !== 'USER') continue;

    if (node.type === 'OPEN_CONNECTOR' && node.entityType === 'EXTERNAL_PACKAGE') {
      const spec = node.name.replace(/^Package:\s*/i, '').trim();
      const dialect = classifyPackageSpecifierDialect(spec);
      if (dialect) recordDialect(node, dialect);
      continue;
    }

    const schemaOrAdapterDialect = classifySchemaOrAdapterNodeDialect(node);
    if (schemaOrAdapterDialect) {
      recordDialect(node, schemaOrAdapterDialect);
    }
  }

  const defaultDialect = resolveDialectSet(repoDialects);
  const dialectByPackage: Record<string, DatabaseReceptorDialect> = {};
  for (const unit of unitInfoById.values()) {
    const pkgSet = dialectsByPkg.get(unit.label);
    const pkgDialect = pkgSet && pkgSet.size > 0 ? resolveDialectSet(pkgSet) : defaultDialect;
    dialectByPackage[unit.label] = pkgDialect;
  }
  for (const [pkgLabel, pkgSet] of dialectsByPkg.entries()) {
    if (!(pkgLabel in dialectByPackage)) {
      dialectByPackage[pkgLabel] = resolveDialectSet(pkgSet);
    }
  }

  return { defaultDialect, dialectByPackage };
}

function dialectToReceptorSpec(dialect: DatabaseReceptorDialect): ExternalReceptorSpec {
  switch (dialect) {
    case 'Database: PostgreSQL':
      return {
        pkg: 'Database: PostgreSQL',
        nodeLabel: 'PostgreSQL Database',
        receptorId: 'ext-receptor-postgresql',
      };
    case 'Database: MySQL':
      return {
        pkg: 'Database: MySQL',
        nodeLabel: 'MySQL Database',
        receptorId: 'ext-receptor-mysql',
      };
    case 'Database: SQLite':
      return {
        pkg: 'Database: SQLite',
        nodeLabel: 'SQLite Database',
        receptorId: 'ext-receptor-sqlite',
      };
    case 'Database: MongoDB':
      return {
        pkg: 'Database: MongoDB',
        nodeLabel: 'MongoDB',
        receptorId: 'ext-receptor-mongodb',
      };
    case 'Database: SQL':
    default:
      return {
        pkg: 'Database: SQL',
        nodeLabel: 'SQL Database',
        receptorId: 'ext-receptor-sql',
      };
  }
}

/**
 * Deterministically maps an `OPEN_CONNECTOR` exit node to its synthesized external receptor board
 * specification (`[PAT-VIS-16]`). Uses explicit connector tokens/metadata first, then falls back
 * to the graph-evidenced dialect (`fallbackDialect`), and finally defaults to `Database: SQL`
 * (`SQL Database`, `ext-receptor-sql`)—never fabricating `Database: SQLite` for unknown SQL calls.
 */
export function classifyExternalReceptorSpec(
  node: {
    name?: string;
    label?: string;
    rawLabel?: string;
    entityType: string;
    patternId?: string;
    metadata?: Record<string, any> | string;
    evidence?:
      | { filePath: string; lineNumber?: number; snippet?: string; evidenceRole?: string }
      | Array<{ filePath: string; lineNumber?: number; snippet?: string; evidenceRole?: string }>;
  },
  fallbackDialect?: string
): ExternalReceptorSpec | null {
  const displayLabel = node.label ?? node.name ?? '';
  if (displayLabel.includes('(To: ')) return null;

  const lbl = [node.name, node.label, node.rawLabel]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
    .toLowerCase();

  let metaDialect = '';
  if (node.metadata) {
    try {
      const meta =
        typeof node.metadata === 'string' ? JSON.parse(node.metadata) : node.metadata;
      if (typeof meta?.dialect === 'string') {
        metaDialect = meta.dialect.toLowerCase();
      }
    } catch {
      // ignore malformed metadata JSON
    }
  }

  if (
    node.entityType === 'DB_QUERY' ||
    node.entityType === 'DB_OPERATION' ||
    node.entityType === 'DB_TRANSACTION'
  ) {
    const evArr = Array.isArray(node.evidence) ? node.evidence : node.evidence ? [node.evidence] : [];
    const evText = evArr
      .map((e) => `${e?.filePath ?? ''} ${e?.snippet ?? ''}`)
      .join(' ')
      .toLowerCase();
    if (
      metaDialect === 'redis' ||
      lbl.includes('redis') ||
      lbl.includes('ioredis') ||
      lbl.includes('upstash') ||
      /\b(?:redis|ioredis|upstash)\b/.test(evText)
    ) {
      return {
        pkg: 'Cache: Redis',
        nodeLabel: 'Redis Cache',
        receptorId: 'ext-receptor-redis',
      };
    }
    if (
      lbl.includes('bull') ||
      lbl.includes('kafka') ||
      lbl.includes('amqp') ||
      lbl.includes('nats')
    ) {
      return {
        pkg: 'Queue: Message Broker',
        nodeLabel: 'Message Broker',
        receptorId: 'ext-receptor-broker',
      };
    }
    if (
      lbl.includes('mongoose') ||
      lbl.includes('mongo') ||
      metaDialect === 'mongodb' ||
      metaDialect === 'mongo'
    ) {
      return dialectToReceptorSpec('Database: MongoDB');
    }
    if (
      lbl.includes('postgres') ||
      lbl.includes('pg.') ||
      lbl.includes('pgtable') ||
      lbl.includes('pgenum') ||
      lbl.includes('supabase') ||
      lbl.includes('neon') ||
      lbl.includes('pglite') ||
      metaDialect === 'postgresql' ||
      metaDialect === 'postgres'
    ) {
      return dialectToReceptorSpec('Database: PostgreSQL');
    }
    if (
      lbl.includes('mysql') ||
      lbl.includes('planetscale') ||
      metaDialect === 'mysql'
    ) {
      return dialectToReceptorSpec('Database: MySQL');
    }
    if (
      lbl.includes('sqlite') ||
      lbl.includes('libsql') ||
      lbl.includes('pragma') ||
      metaDialect === 'sqlite'
    ) {
      return dialectToReceptorSpec('Database: SQLite');
    }

    const isExplicitSqlOrm =
      lbl.includes('drizzle') ||
      lbl.includes('prisma') ||
      lbl.includes('sequelize') ||
      lbl.includes('typeorm') ||
      lbl.includes('knex') ||
      node.patternId === 'open-connector.drizzle-query-chain';

    if (
      fallbackDialect === 'Database: PostgreSQL' ||
      fallbackDialect === 'Database: MySQL' ||
      fallbackDialect === 'Database: SQLite'
    ) {
      return dialectToReceptorSpec(fallbackDialect);
    }
    if (fallbackDialect === 'Database: MongoDB' && !isExplicitSqlOrm) {
      return dialectToReceptorSpec('Database: MongoDB');
    }

    return dialectToReceptorSpec('Database: SQL');
  }

  if (node.entityType === 'HTTP_FETCH') {
    return {
      pkg: 'External: HTTP API',
      nodeLabel: 'External HTTP API',
      receptorId: 'ext-receptor-http',
    };
  }
  if (node.entityType === 'SOCKET_EGRESS') {
    return {
      pkg: 'External: WebSocket',
      nodeLabel: 'WebSocket Server',
      receptorId: 'ext-receptor-socket',
    };
  }
  return null;
}

/**
 * Returns the synthesized external receptor package label (`"Database: PostgreSQL"`, `"Database: SQL"`,
 * `"Cache: Redis"`, `"External: HTTP API"`, etc.) for an `OPEN_CONNECTOR` node (`[PAT-VIS-16]`).
 */
export function classifyConnectorReceptorBox(
  node: {
    name?: string;
    label?: string;
    rawLabel?: string;
    entityType: string;
    patternId?: string;
    metadata?: Record<string, any> | string;
    evidence?:
      | { filePath: string; lineNumber?: number; snippet?: string; evidenceRole?: string }
      | Array<{ filePath: string; lineNumber?: number; snippet?: string; evidenceRole?: string }>;
  },
  graphOrFallbackDialect?: Pick<RepresentationGraph, 'nodes'> | string
): string | null {
  let fallbackDialect: string | undefined;
  if (typeof graphOrFallbackDialect === 'string') {
    fallbackDialect = graphOrFallbackDialect;
  } else if (graphOrFallbackDialect && Array.isArray(graphOrFallbackDialect.nodes)) {
    const { defaultDialect } = inferDatabaseDialectFromGraph(graphOrFallbackDialect);
    fallbackDialect = defaultDialect;
  }
  return classifyExternalReceptorSpec(node, fallbackDialect)?.pkg ?? null;
}

/**
 * Runs the deterministic Stack-vs-Graph-vs-Layout Sanity Diff (`[PAT-CLI-16]`).
 */
export function auditScoutSanity(
  repoRoot: string,
  graph: Pick<RepresentationGraph, 'nodes' | 'edges' | 'analyzedFiles'>,
  options: AuditScoutSanityOptions = {}
): ScoutSanityReport {
  const absRoot = path.resolve(repoRoot);
  const repoName = options.repoName ?? path.basename(absRoot);
  const excludeWorkspaces = options.excludeWorkspaces ?? [];

  const frameworkCoverage = auditFrameworkCoverage(absRoot, graph, excludeWorkspaces);
  const allDeps = collectAllRepoDependencies(absRoot);
  const detectedDbDrivers = detectDbDriversFromDeps(allDeps);
  const detectedTierDirs = detectArchitecturalTierDirs(absRoot);

  const detectedStackSet = new Set<string>();
  for (const pkg of frameworkCoverage.packages) {
    for (const fw of pkg.frameworks) detectedStackSet.add(fw);
  }
  for (const drv of detectedDbDrivers) {
    detectedStackSet.add(`${drv.dialect} (${drv.dep})`);
  }
  const detectedStack = [...detectedStackSet];

  const userNodes = (graph.nodes ?? []).filter((n) => (n.scope ?? 'USER') === 'USER');
  const userEdges = (graph.edges ?? []).filter((e) => (e.scope ?? 'USER') === 'USER');

  const deploymentUnits = userNodes
    .filter((n) => n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT')
    .map((n) => n.name.replace(/^Deployment Unit:\s*/i, '').trim());

  const boundaries = userNodes.filter((n) => n.type === 'BOUNDARY');
  const contracts = userNodes.filter((n) => n.type === 'CONTRACT');
  const executableContracts = contracts.filter(
    (c) => !NON_EXECUTABLE_CONTRACT_TYPES.has(c.entityType)
  );
  const openConnectors = userNodes.filter((n) => n.type === 'OPEN_CONNECTOR');

  // Connectivity calculations (via canonical `computeStructuralHealthMetrics`)
  const healthMetrics = computeStructuralHealthMetrics({
    nodes: userNodes,
    edges: userEdges,
  });
  const {
    connectivityRate,
    rawConnectivityRate,
    knowableConnectivityRate,
    callResolutionCounts,
  } = healthMetrics;

  // Outgoing & incoming resolved edges per node
  const outResolvedByNode = new Map<string, number>();
  const inResolvedByNode = new Map<string, number>();
  const contractIds = new Set(contracts.map((c) => c.id));
  let resolvedContractToContractEdges = 0;

  for (const e of userEdges) {
    if (!e.targetId) continue;
    outResolvedByNode.set(e.sourceId, (outResolvedByNode.get(e.sourceId) ?? 0) + 1);
    inResolvedByNode.set(e.targetId, (inResolvedByNode.get(e.targetId) ?? 0) + 1);
    if (contractIds.has(e.sourceId) && contractIds.has(e.targetId)) {
      resolvedContractToContractEdges++;
    }
  }

  const ingressNodes = executableContracts.filter(
    (c) => INGRESS_CONTRACT_TYPES.has(c.entityType) || c.metadata?.flowRole === 'INGRESS'
  );
  const deadEndIngressNodes = ingressNodes.filter(
    (c) => (outResolvedByNode.get(c.id) ?? 0) === 0
  );
  const layoutOrphanIdSet = Array.isArray(options.layoutMetrics?.orphanNodeIds)
    ? new Set(options.layoutMetrics!.orphanNodeIds)
    : null;
  const orphanContracts = layoutOrphanIdSet
    ? executableContracts.filter((c) => layoutOrphanIdSet.has(c.id))
    : executableContracts.filter(
        (c) =>
          !INGRESS_CONTRACT_TYPES.has(c.entityType) &&
          c.metadata?.flowRole !== 'INGRESS' &&
          (c.entityType !== 'EXPORTED_MODULE' || (outResolvedByNode.get(c.id) ?? 0) > 0) &&
          (inResolvedByNode.get(c.id) ?? 0) === 0
      );

  const nonIngressExecutableCount = Math.max(
    0,
    executableContracts.length - ingressNodes.length
  );
  const orphanRatioPercent =
    nonIngressExecutableCount > 0
      ? round1((orphanContracts.length / nonIngressExecutableCount) * 100)
      : 0;

  // Receptor boxes (from layoutMetrics if provided, else derived from openConnectors)
  const { defaultDialect } = inferDatabaseDialectFromGraph(graph);
  const inferredReceptors = new Set<string>();
  const sqliteFallbackConnectors: StructuralNode[] = [];
  for (const oc of openConnectors) {
    const box = classifyConnectorReceptorBox(oc, defaultDialect);
    if (box) {
      inferredReceptors.add(box);
      if (box === 'Database: SQLite') {
        sqliteFallbackConnectors.push(oc);
      }
    }
  }
  const renderedReceptorBoxes = options.layoutMetrics?.renderedReceptorBoxes
    ? [...options.layoutMetrics.renderedReceptorBoxes]
    : [...inferredReceptors].sort();

  const anomalies: ScoutSanityAnomaly[] = [];

  // ── (a) Boundary Collapse Check ────────────────────────────────────────────
  const excludedWorkspaceSet = new Set(excludeWorkspaces.map((w) => w.trim()).filter(Boolean));
  let discoveredWorkspaceEntries: Array<{ pkgName: string; relPath: string }> = [];
  try {
    discoveredWorkspaceEntries = Object.entries(buildWorkspaceRegistry(absRoot))
      .map(([pkgName, pkgPath]) => ({
        pkgName,
        relPath: path.relative(absRoot, pkgPath).replace(/\\/g, '/') || '.',
      }))
      .filter(({ pkgName, relPath }) => {
        const shortName = pkgName.replace(/^@[^/]+\//, '');
        return (
          !excludedWorkspaceSet.has(pkgName) &&
          !excludedWorkspaceSet.has(shortName) &&
          !excludedWorkspaceSet.has(relPath)
        );
      });
  } catch {
    discoveredWorkspaceEntries = [];
  }

  if (
    discoveredWorkspaceEntries.length >= 2 &&
    deploymentUnits.length <= 1 &&
    executableContracts.length > 0
  ) {
    anomalies.push({
      kind: 'BOUNDARY_COLLAPSE',
      severity: 'HIGH',
      title: `Multi-Workspace Boundary Collapse (${deploymentUnits.length || 1} DEPLOYMENT_UNIT across ${discoveredWorkspaceEntries.length} workspace packages)`,
      whatsWrong: `Repository "${repoName}" declares ${discoveredWorkspaceEntries.length} distinct workspace/sub-package boundaries (${discoveredWorkspaceEntries.slice(0, 6).map((w) => w.pkgName).join(', ')}), but emitted only ${deploymentUnits.length || 1} DEPLOYMENT_UNIT boundary (${deploymentUnits[0] ?? repoName}).`,
      proposedFix: `Check multi-shape workspace discovery in \`buildWorkspaceRegistry\` (\`packages/core/src/extractor/workspaceResolver.ts\`, \`[PAT-EXT-30]\`) or verify explicit workspace exclusions.`,
      evidence: discoveredWorkspaceEntries.slice(0, 4).map((w) => ({
        label: `Workspace package: ${w.pkgName}`,
        filePath: w.relPath,
      })),
    });
  }

  // ── (b) Receptor Dialect Mismatch Check ────────────────────────────────────
  const hasSqliteDriver = detectedDbDrivers.some((d) => d.dialect === 'SQLite');
  const nonSqliteDbDrivers = detectedDbDrivers.filter(
    (d) => d.dialect === 'PostgreSQL' || d.dialect === 'MySQL' || d.dialect === 'MongoDB'
  );

  if (
    nonSqliteDbDrivers.length > 0 &&
    !hasSqliteDriver &&
    (renderedReceptorBoxes.includes('Database: SQLite') || sqliteFallbackConnectors.length > 0)
  ) {
    const driverLabels = [
      ...new Set(nonSqliteDbDrivers.map((d) => `${d.dialect} (\`${d.dep}\`)`)),
    ].join(', ');
    anomalies.push({
      kind: 'RECEPTOR_DIALECT_MISMATCH',
      severity: 'HIGH',
      title: `Database Receptor Misclassified as SQLite (package.json declares ${nonSqliteDbDrivers[0].dialect})`,
      whatsWrong: `\`package.json\` declares ${driverLabels} and has no SQLite dependency, yet ${sqliteFallbackConnectors.length || 1} database Open Connector(s) fell through to \`Database: SQLite\` because their stripped label (e.g. \`${sqliteFallbackConnectors[0]?.name ?? 'DB Call: db.query'}\`) did not match a known dialect token in \`classifyExternalReceptor\`.`,
      proposedFix: `Derive database receptor dialect deterministically from extracted \`DB_SCHEMA\` contracts (\`pgTable\` vs \`mysqlTable\` vs \`sqliteTable\`) and \`EXTERNAL_PACKAGE\` / \`package.json\` driver evidence in \`packages/cli/src/visualizer/pipeline-topo/3-gridMapper.ts\` (\`classifyExternalReceptor\`), and extend Drizzle relational query conventions (\`db.query.<table>.findMany/findFirst\`) in \`packages/core/src/extractor/conventions/drizzle.ts\` (\`[PAT-VIS-16]\`, \`[PAT-EXT-28]\`).`,
      evidence: sqliteFallbackConnectors.slice(0, 3).map((oc) => {
        const ev = getPrimaryEvidence(oc);
        return {
          label: oc.name,
          filePath: ev?.filePath,
          lineNumber: ev?.lineNumber,
          snippet: ev?.snippet,
        };
      }),
    });
  }

  // ── (b.2) Shadowed DB Receptor Check (DB calls collapsing into Package: <driver> micro-node) ──
  const dbQueryConnectors = openConnectors.filter(
    (oc) =>
      oc.entityType === 'DB_QUERY' ||
      oc.entityType === 'DB_OPERATION' ||
      oc.entityType === 'DB_TRANSACTION'
  );
  if (detectedDbDrivers.length > 0 && dbQueryConnectors.length === 0) {
    const driverDeps = new Set(detectedDbDrivers.map((d) => d.dep));
    const driverPkgNodes = openConnectors.filter(
      (oc) =>
        oc.entityType === 'EXTERNAL_PACKAGE' &&
        driverDeps.has(oc.name.replace(/^Package:\s*/i, '').trim())
    );
    const driverPkgIds = new Set(driverPkgNodes.map((n) => n.id));
    const shadowedDbEdges = userEdges.filter(
      (e) => e.targetId && driverPkgIds.has(e.targetId)
    );
    if (shadowedDbEdges.length > 0) {
      const driverLabels = [
        ...new Set(detectedDbDrivers.map((d) => `${d.dialect} (\`${d.dep}\`)`)),
      ].join(', ');
      anomalies.push({
        kind: 'SHADOWED_DB_RECEPTOR',
        severity: 'HIGH',
        title: `Shadowed Database Receptor (${shadowedDbEdges.length} DB call(s) collapsed into Package micro-node instead of ${detectedDbDrivers[0].expectedReceptorPkg})`,
        whatsWrong: `\`package.json\` declares ${driverLabels} and the graph contains ${shadowedDbEdges.length} call edge(s) targeting \`${driverPkgNodes.map((n) => n.name).join(', ')}\` (\`EXTERNAL_PACKAGE\` micro-node), yet 0 \`DB_QUERY\`/\`DB_OPERATION\` Open Connectors (\`${detectedDbDrivers[0].expectedReceptorPkg}\` receptor box) were emitted.`,
        proposedFix: `Ensure \`collectLocalClientBindings\` in \`packages/core/src/extractor/visitors/openConnectorVisitor.ts\` propagates \`'DB'\` client aliases across destructured driver imports (\`const { Pool } = require('pg')\`), pool/client constructors (\`new Pool()\`), and awaited connection acquisitions (\`await db.pool.connect()\`).`,
        evidence: shadowedDbEdges.slice(0, 3).map((e) => {
          const ev = getPrimaryEvidence(e);
          return {
            label: e.name,
            filePath: ev?.filePath,
            lineNumber: ev?.lineNumber,
            snippet: ev?.snippet,
          };
        }),
      });
    }
  }

  // ── (c.1) Zero-Edge / Single-Column Collapse ───────────────────────────────
  const layoutEdgesZero =
    options.layoutMetrics?.renderedEdgeCount !== undefined &&
    options.layoutMetrics.renderedEdgeCount === 0;
  if (
    executableContracts.length >= 3 &&
    (resolvedContractToContractEdges === 0 || layoutEdgesZero)
  ) {
    anomalies.push({
      kind: 'ZERO_EDGE_COLLAPSE',
      severity: 'HIGH',
      title: `Zero-Relationship / Single-Column Layout Collapse (${executableContracts.length} contracts, 0 internal flow edges)`,
      whatsWrong: `Extracted ${executableContracts.length} executable contracts but 0 resolved contract-to-contract edges${layoutEdgesZero ? ' (0 rendered layout edges)' : ''}. All stations stack into a single dead-end column at \`x = 0\` (\`[PAT-VIS-29]\`).`,
      proposedFix: `Inspect top unresolved call shape clusters (\`sk1/...\`) or CommonJS prototype/mixin export bindings in \`packages/core/src/extractor/visitors/\`, and surface the Zero-Relationship HUD warning banner (\`[PAT-VIS-29]\`).`,
      evidence: executableContracts.slice(0, 3).map((c) => {
        const ev = getPrimaryEvidence(c);
        return {
          label: c.name,
          filePath: ev?.filePath,
          lineNumber: ev?.lineNumber,
          snippet: ev?.snippet,
        };
      }),
    });
  }

  // ── (c.2) Masked Low Connectivity ──────────────────────────────────────────
  if (
    callResolutionCounts.totalCallFamilyEdges >= 10 &&
    connectivityRate - rawConnectivityRate >= 15 &&
    rawConnectivityRate < 65
  ) {
    anomalies.push({
      kind: 'MASKED_LOW_CONNECTIVITY',
      severity: 'MEDIUM',
      title: `Masked Low Connectivity (Gated ${connectivityRate}% vs. Raw ${rawConnectivityRate}%)`,
      whatsWrong: `Gated connectivity reports ${connectivityRate}%, but raw call resolution is only ${rawConnectivityRate}% (${callResolutionCounts.resolvedCount}/${callResolutionCounts.totalCallFamilyEdges} calls resolved) because ${callResolutionCounts.unprovableFallbackCount} \`LOW\`-confidence \`relationship.invoke-returned-function\` fallback edges were excluded from the denominator.`,
      proposedFix: `Expose \`rawConnectivityRate\` alongside \`connectivityRate\` in \`printBiteReport\` and the Visualizer HUD (\`[PAT-VIS-29]\`), and audit factory-return / dynamic receiver call shapes in \`targetResolver.ts\`.`,
      evidence: [],
    });
  }

  // ── (c.3) Dead-End Ingress Stations ────────────────────────────────────────
  if (deadEndIngressNodes.length > 0) {
    anomalies.push({
      kind: 'DEAD_END_INGRESS',
      severity: deadEndIngressNodes.length >= 3 ? 'HIGH' : 'MEDIUM',
      title: `Dead-End Ingress Stations (${deadEndIngressNodes.length}/${ingressNodes.length} INGRESS nodes have 0 outgoing edges)`,
      whatsWrong: `${deadEndIngressNodes.length} entry-point station(s) (${deadEndIngressNodes
        .slice(0, 3)
        .map((n) => n.name)
        .join(', ')}) have 0 resolved outgoing edges (\`[PAT-VIS-07]\`), halting story traces at column 0.`,
      proposedFix: `Run \`audit-dead-end-ingress\` on the cited entry points to check for unbridged helper indirections, HOF route wrappers, or unhandled ORM/service calls inside the route body.`,
      evidence: deadEndIngressNodes.slice(0, 3).map((n) => {
        const ev = getPrimaryEvidence(n);
        return {
          label: n.name,
          filePath: ev?.filePath,
          lineNumber: ev?.lineNumber,
          snippet: ev?.snippet,
        };
      }),
    });
  }

  // ── (c.4) High Orphan Contract Ratio ───────────────────────────────────────
  if (orphanContracts.length >= 5 && orphanRatioPercent >= 50) {
    anomalies.push({
      kind: 'HIGH_ORPHAN_RATIO',
      severity: orphanRatioPercent >= 75 ? 'HIGH' : 'MEDIUM',
      title: `High Orphan Contract Ratio (${orphanContracts.length}/${nonIngressExecutableCount} non-ingress contracts unlinked — ${orphanRatioPercent}%)`,
      whatsWrong: `${orphanRatioPercent}% of non-ingress executable contracts have \`inDegree === 0\` and sit in \`orphanNodes\`. This indicates either a public library/SDK surface with no internal callers or an unlinked caller dispatch pattern (HOF callbacks, dispatch tables, custom route files).`,
      proposedFix: `Triage \`sk1/ORPHAN/...\` candidates with \`unresolvedIncoming\` diagnostics via \`audit-orphan-contracts\` to link HOF/callback callers or promote framework entry points to \`INGRESS\`.`,
      evidence: orphanContracts.slice(0, 3).map((n) => {
        const ev = getPrimaryEvidence(n);
        return {
          label: n.name,
          filePath: ev?.filePath,
          lineNumber: ev?.lineNumber,
          snippet: ev?.snippet,
        };
      }),
    });
  }

  // ── (c.5) Dark Files ───────────────────────────────────────────────────────
  if (frameworkCoverage.darkFiles.length > 0) {
    anomalies.push({
      kind: 'DARK_FILES',
      severity: frameworkCoverage.darkFiles.length >= 5 ? 'MEDIUM' : 'LOW',
      title: `Dark Source Files (${frameworkCoverage.darkFiles.length} file(s) with 0 contracts & 0 relationships)`,
      whatsWrong: `${frameworkCoverage.darkFiles.length} non-barrel USER-scope source file(s) produced 0 extracted Contracts, 0 Class/Namespace boundaries, and 0 originating Relationships (e.g. ${frameworkCoverage.darkFiles.slice(0, 3).join(', ')}).`,
      proposedFix: `Inspect dark files for unhandled export/registration syntax (e.g. default-exported anonymous objects, custom framework route files, or barrel-like side-effect modules) and add a convention rule or visitor.`,
      evidence: frameworkCoverage.darkFiles.slice(0, 3).map((fp) => ({
        label: fp,
        filePath: fp,
        lineNumber: 1,
      })),
    });
  }

  // ── (c.5b) Unextracted Target Contracts (Partially Dark Files / Unextracted Exports) ──
  const unextractedTargets: ScoutAnomalyEvidence[] = [];
  const seenUnextractedKeys = new Set<string>();
  for (const n of userNodes) {
    const outgoing = Array.isArray(n.metadata?.unresolvedOutgoing)
      ? n.metadata.unresolvedOutgoing
      : [];
    for (const ref of outgoing) {
      if (
        ref &&
        ref.reason === 'unextracted-target-contract' &&
        ref.usageKind !== 'unused-import'
      ) {
        const key = `${ref.resolvedFilePath ?? ref.importSpecifier}:${ref.targetSymbol}`;
        if (!seenUnextractedKeys.has(key)) {
          seenUnextractedKeys.add(key);
          unextractedTargets.push({
            label: `${ref.targetSymbol} (imported from ${ref.resolvedFilePath ?? ref.importSpecifier}, used as ${ref.usageKind})`,
            filePath: ref.resolvedFilePath ?? ref.filePath,
            lineNumber: ref.resolvedFilePath ? 1 : ref.lineNumber,
            snippet: ref.snippet,
          });
        }
      }
    }
  }
  for (const e of userEdges) {
    if (e.metadata?.unresolvedReason === 'unextracted-target-contract') {
      const ev = getPrimaryEvidence(e);
      const expectedTarget = String(e.metadata?.expectedTargetId ?? e.name);
      const key = `edge:${expectedTarget}:${ev?.filePath ?? ''}`;
      if (!seenUnextractedKeys.has(key)) {
        seenUnextractedKeys.add(key);
        unextractedTargets.push({
          label: `${e.name} (expected target ${expectedTarget})`,
          filePath: ev?.filePath,
          lineNumber: ev?.lineNumber,
          snippet: ev?.snippet,
        });
      }
    }
  }
  if (unextractedTargets.length > 0) {
    anomalies.push({
      kind: 'UNEXTRACTED_TARGET_CONTRACT',
      severity: unextractedTargets.length >= 3 ? 'HIGH' : 'MEDIUM',
      title: `Partially Dark Files / Unextracted Target Contracts (${unextractedTargets.length} imported symbol(s) missing CONTRACT nodes)`,
      whatsWrong: `${unextractedTargets.length} intra-repo imported symbol(s) or companion targets were actively referenced by callers (${unextractedTargets
        .slice(0, 3)
        .map((u) => u.label)
        .join('; ')}), but the target file never emitted a matching \`CONTRACT\` node. Unlike completely Dark Files, partially dark files may emit 1+ other contracts (e.g. \`EXPORTED_TYPE\`) while hiding unhandled factory/HOF exports.`,
      proposedFix: `Inspect the target file's export declaration (e.g. \`exportedFactoryCall\`, \`exportedWrappedFunction\`, or custom ORM/router builder) and add a rule in \`packages/core/src/extractor/conventions/\` or \`contractVisitor.ts\`.`,
      evidence: unextractedTargets.slice(0, 3),
    });
  }

  // ── (c.5c) Unextracted Top-Level Value Exports (Including Unimported Exports) ──
  const unextractedExports = frameworkCoverage.unextractedExports ?? [];
  if (unextractedExports.length > 0) {
    const syntaxCounts = new Map<string, number>();
    for (const u of unextractedExports) {
      syntaxCounts.set(u.exportSyntax, (syntaxCounts.get(u.exportSyntax) ?? 0) + 1);
    }
    const topSyntaxes = [...syntaxCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([syn, cnt]) => `${syn} (×${cnt})`)
      .join(', ');

    anomalies.push({
      kind: 'UNEXTRACTED_EXPORTS',
      severity: unextractedExports.length >= 5 ? 'MEDIUM' : 'LOW',
      title: `Unextracted Top-Level Value Exports (${unextractedExports.length} non-scalar export(s) without CONTRACT/BOUNDARY nodes)`,
      whatsWrong: `${unextractedExports.length} top-level non-type, non-scalar \`export\` statement(s) across USER-scope files produced no \`CONTRACT\` or \`CLASS\`/\`NAMESPACE\` \`BOUNDARY\` node (dominant shapes: ${topSyntaxes}). This catches unextracted factory/config/wrapper exports even when the file already has another extracted contract or when no other file in the repository imports the export.`,
      proposedFix: `Inspect the unextracted export initializer shapes (${topSyntaxes}) and add a declarative rule (\`exportedFactoryCall\`, \`variableInitializedByCall\`, \`exportedWrappedFunction\`) in \`packages/core/src/extractor/conventions/\` or \`contractVisitor.ts\`.`,
      evidence: unextractedExports.slice(0, 3).map((u) => ({
        label: `export ${u.exportName} [${u.exportSyntax}]`,
        filePath: u.filePath,
        lineNumber: u.lineNumber,
        snippet: u.snippet,
      })),
    });
  }

  // ── (c.6) Framework Convention Warnings ────────────────────────────────────
  for (const w of frameworkCoverage.warnings) {
    if (w.kind === 'SUSPECTED_CUSTOM_CONVENTION') {
      anomalies.push({
        kind: 'SUSPECTED_CUSTOM_CONVENTION',
        severity: 'HIGH',
        title: `Suspected Custom ${w.framework} Convention in ${w.packageName}`,
        whatsWrong: w.message,
        proposedFix: `Inspect ${w.packagePath} for custom ${w.framework} wrappers and add a declarative rule in \`chomp.config.json\` (\`conventions\`) or \`packages/core/src/extractor/conventions/${w.conventionSetId ?? 'index'}.ts\`.`,
        evidence: [{ label: w.packageName, filePath: w.packagePath }],
      });
    } else if (w.kind === 'UNHANDLED_FRAMEWORK') {
      anomalies.push({
        kind: 'UNHANDLED_FRAMEWORK',
        severity: 'MEDIUM',
        title: `Unhandled Framework Dependency: ${w.framework} (${w.packageName})`,
        whatsWrong: w.message,
        proposedFix: `Author a declarative \`ConventionSet\` adapter for ${w.framework} in \`packages/core/src/extractor/conventions/\` (\`[PAT-EXT-28]\`).`,
        evidence: [{ label: w.packageName, filePath: w.packagePath }],
      });
    }
  }

  // ── (e) Conservation & Soundness Invariants ────────────────────────────────
  const userNodeById = new Map(userNodes.map((n) => [n.id, n]));
  // (e.1) TRACER_STARVATION_DROP: Contracts with incoming resolved flow edges (`inDegree > 0`) dropped into `storyGraph.orphanNodes`
  if (options.layoutMetrics?.orphanNodeIds && options.layoutMetrics.orphanNodeIds.length > 0) {
    const starvedOrphans: StructuralNode[] = [];
    for (const orphanId of options.layoutMetrics.orphanNodeIds) {
      if ((inResolvedByNode.get(orphanId) ?? 0) > 0) {
        const node = userNodeById.get(orphanId);
        if (node) starvedOrphans.push(node);
      }
    }
    if (starvedOrphans.length > 0) {
      anomalies.push({
        kind: 'TRACER_STARVATION_DROP',
        severity: 'HIGH',
        title: `Story Tracer Starvation Drop (${starvedOrphans.length} connected contract(s) misclassified as Orphans)`,
        whatsWrong: `${starvedOrphans.length} contract(s) (${starvedOrphans
          .slice(0, 3)
          .map((n) => n.name)
          .join(', ')}) have resolved incoming edges (\`inDegree > 0\`) in \`RepresentationGraph\`, yet landed in \`storyGraph.orphanNodes\`.`,
        proposedFix: `Ensure \`runStoryTracer\` in \`packages/cli/src/visualizer/pipeline-topo/1-storyTracer.ts\` shares \`expandedSubtreesByPkg\` across package entries and computes true graph reachability (\`reachableFromEntry\`) before classifying \`orphanNodes\`.`,
        evidence: starvedOrphans.slice(0, 3).map((n) => {
          const ev = getPrimaryEvidence(n);
          return {
            label: n.name,
            filePath: ev?.filePath,
            lineNumber: ev?.lineNumber,
            snippet: ev?.snippet,
          };
        }),
      });
    }
  }

  // (e.2) SUSPICIOUS_BUILTIN_METHOD_TARGET: Resolved `invoke-returned-function` CALL edges whose callee is a built-in JS prototype method
  const SUSPICIOUS_BUILTIN_METHODS = new Set([
    'map',
    'filter',
    'forEach',
    'push',
    'slice',
    'join',
    'reduce',
    'some',
    'every',
    'toLowerCase',
    'toUpperCase',
    'replace',
    'split',
    'trim',
    'toFixed',
    'includes',
    'has',
    'add',
    'clear',
  ]);
  const suspiciousBuiltinEdges = userEdges.filter((e) => {
    if (
      !e.targetId ||
      e.entityType !== 'CALL' ||
      (e.patternId !== 'relationship.invoke-returned-function' &&
        e.patternId !== 'relationship.inferred-method-call')
    ) {
      return false;
    }
    const m = /\.([A-Za-z0-9_$]+)\(\)$/.exec(e.name);
    if (!m) return false;
    const methodName = m[1];
    const targetNode = userNodeById.get(e.targetId);
    if (
      targetNode?.entityType === 'NODE_BUILTIN' ||
      targetNode?.name === 'Package: path' ||
      targetNode?.name === 'Package: node:path'
    ) {
      return false;
    }
    if (e.patternId === 'relationship.inferred-method-call') {
      return (
        targetNode?.entityType === 'EXPORTED_FUNCTION' &&
        (SUSPICIOUS_BUILTIN_METHODS.has(methodName) ||
          methodName === 'get' ||
          methodName === 'set' ||
          methodName === 'delete')
      );
    }
    if (SUSPICIOUS_BUILTIN_METHODS.has(methodName)) return true;
    if (methodName === 'get' || methodName === 'set' || methodName === 'delete') {
      return targetNode?.entityType === 'EXPORTED_FUNCTION';
    }
    return false;
  });
  if (suspiciousBuiltinEdges.length > 0) {
    anomalies.push({
      kind: 'SUSPICIOUS_BUILTIN_METHOD_TARGET',
      severity: 'HIGH',
      title: `Suspicious Built-In Prototype Method Target (${suspiciousBuiltinEdges.length} resolved return-value call(s))`,
      whatsWrong: `${suspiciousBuiltinEdges.length} \`relationship.invoke-returned-function\` CALL edge(s) resolved a standard JS collection/primitive method (${suspiciousBuiltinEdges
        .slice(0, 3)
        .map((e) => e.name)
        .join(', ')}) back to a producer function or external package.`,
      proposedFix: `Guard \`resolveLocalFromCallTarget\` in \`relationshipVisitor.ts\` and \`resolveExternalPackageTarget\` in \`targetResolver.ts\` against \`BUILTIN_VALUE_PROTOTYPE_METHODS\`.`,
      evidence: suspiciousBuiltinEdges.slice(0, 3).map((e) => {
        const ev = getPrimaryEvidence(e);
        return {
          label: `${e.name} -> ${e.targetId}`,
          filePath: ev?.filePath,
          lineNumber: ev?.lineNumber,
          snippet: ev?.snippet,
        };
      }),
    });
  }

  // (e.3) CONTRACT_HASH_COLLISION: Multiple contracts in different files sharing the same `stableEntityId`
  const collidingContracts = contracts.filter(
    (c) =>
      Array.isArray(c.metadata?.collisionLocations) &&
      (c.metadata.collisionLocations as unknown[]).length > 1
  );
  if (collidingContracts.length > 0) {
    anomalies.push({
      kind: 'CONTRACT_HASH_COLLISION',
      severity: 'MEDIUM',
      title: `Contract Identity Hash Collision (${collidingContracts.length} contract ID(s) shared across multiple files)`,
      whatsWrong: `${collidingContracts.length} \`CONTRACT\` entity ID(s) (${collidingContracts
        .slice(0, 3)
        .map((c) => `${c.name} [${(c.metadata?.collisionLocations as string[]).join(', ')}]`)
        .join('; ')}) collided across multiple files in the same logical boundary scope.`,
      proposedFix: `Rename duplicate exported symbols or disambiguate sub-module contract identities in \`packages/core/src/utils/id.ts\`.`,
      evidence: collidingContracts.slice(0, 3).map((c) => {
        const ev = getPrimaryEvidence(c);
        return {
          label: `${c.name} (${(c.metadata?.collisionLocations as string[]).join(', ')})`,
          filePath: ev?.filePath,
          lineNumber: ev?.lineNumber,
          snippet: ev?.snippet,
        };
      }),
    });
  }

  // (e.4) CROSS_SCOPE_DANGLING_EDGE: USER-scope edge pointing to a `targetId` absent from USER-scope `nodes`
  const userNodeIdSet = new Set(userNodes.map((n) => n.id));
  const danglingEdges = userEdges.filter((e) => Boolean(e.targetId && !userNodeIdSet.has(e.targetId)));
  if (danglingEdges.length > 0) {
    anomalies.push({
      kind: 'CROSS_SCOPE_DANGLING_EDGE',
      severity: 'HIGH',
      title: `Cross-Scope Dangling Edge Target (${danglingEdges.length} USER edge(s) pointing to missing/non-USER targetId)`,
      whatsWrong: `${danglingEdges.length} USER-scope edge(s) (${danglingEdges
        .slice(0, 3)
        .map((e) => `${e.name} -> ${e.targetId}`)
        .join(', ')}) reference a \`targetId\` that does not exist in USER-scope \`nodes\`.`,
      proposedFix: `Strip cross-scope \`targetId\` references when filtering to \`USER\` scope in \`analyzeTarget\` (\`packages/core/src/extractor/index.ts\`) and \`getRepresentationGraph\` (\`packages/db/src/adapters/sqlite/graphRepository.ts\`).`,
      evidence: danglingEdges.slice(0, 3).map((e) => {
        const ev = getPrimaryEvidence(e);
        return {
          label: `${e.name} -> ${e.targetId}`,
          filePath: ev?.filePath,
          lineNumber: ev?.lineNumber,
          snippet: ev?.snippet,
        };
      }),
    });
  }

  // ── (d) Unregistered Knowable Signal Clusters ──────────────────────────────
  const unregisteredSignalCandidates = collectLedgerSignalCandidates(graph, {
    registeredShapeKeys: options.registeredShapeKeys,
    onlyKnowable: true,
    includeOrphans: true,
    onlyActionableOrphans: true,
    includeDarkFiles: true,
    darkFiles: frameworkCoverage.darkFiles,
    maxExamples: 3,
  }).slice(0, options.maxSignalCandidates ?? 15);

  const summary: ScoutSnapshotSummary = {
    repoName,
    repoPath: absRoot,
    detectedStack,
    detectedDbDrivers,
    detectedTierDirs,
    deploymentUnits,
    boundaryCount: boundaries.length,
    contractCount: contracts.length,
    openConnectorCount: openConnectors.length,
    relationshipCount: userEdges.length,
    resolvedFlowEdgeCount: resolvedContractToContractEdges,
    ingressCount: ingressNodes.length,
    deadEndIngressCount: deadEndIngressNodes.length,
    orphanContractCount: orphanContracts.length,
    orphanRatioPercent,
    darkFileCount: frameworkCoverage.darkFiles.length,
    unextractedExportCount: unextractedExports.length,
    connectivityRate,
    rawConnectivityRate,
    knowableConnectivityRate,
    callResolutionCounts,
    ...(options.layoutMetrics?.storyCount !== undefined
      ? { storyCount: options.layoutMetrics.storyCount }
      : {}),
    ...(options.layoutMetrics?.renderedEdgeCount !== undefined
      ? { renderedEdgeCount: options.layoutMetrics.renderedEdgeCount }
      : {}),
    ...(options.layoutMetrics?.maxCol !== undefined
      ? { maxCol: options.layoutMetrics.maxCol }
      : {}),
    renderedReceptorBoxes,
  };

  return {
    summary,
    anomalies,
    frameworkCoverage,
    unregisteredSignalCandidates,
  };
}
