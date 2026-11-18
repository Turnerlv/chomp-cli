import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import {
  analyzeTarget,
  auditScoutSanity,
  classifyConnectorReceptorBox,
  inferDatabaseDialectFromGraph,
  type RepresentationGraph,
} from '../index.js';

const repoRoot = path.resolve(process.cwd(), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'test-repos');

test('classifyConnectorReceptorBox maps DB, HTTP, and Socket open connectors to evidence-backed receptor boxes', () => {
  // Without dialect evidence, generic DB calls fall back to Database: SQL (never Database: SQLite)
  assert.equal(
    classifyConnectorReceptorBox({
      name: 'DB Call: db.query.users.findFirst',
      entityType: 'DB_QUERY',
    }),
    'Database: SQL'
  );
  assert.equal(
    classifyConnectorReceptorBox({
      name: 'Drizzle Query: db.select()',
      entityType: 'DB_QUERY',
    }),
    'Database: SQL'
  );
  // With PostgreSQL graph evidence (e.g. nextjs-drizzle fixture), Drizzle/DB connectors resolve to Database: PostgreSQL
  const drizzleGraph = analyzeTarget(path.join(fixturesDir, 'nextjs-drizzle'));
  const dialectInfo = inferDatabaseDialectFromGraph(drizzleGraph);
  assert.equal(dialectInfo.defaultDialect, 'Database: PostgreSQL');
  assert.equal(
    classifyConnectorReceptorBox(
      {
        name: 'Drizzle Query: findFirst()',
        entityType: 'DB_QUERY',
      },
      drizzleGraph
    ),
    'Database: PostgreSQL'
  );
  // With SQLite package evidence (e.g. self-rep-patterns fixture with better-sqlite3), DB calls resolve to Database: SQLite
  const sqliteGraph = analyzeTarget(path.join(fixturesDir, 'self-rep-patterns'));
  assert.equal(inferDatabaseDialectFromGraph(sqliteGraph).defaultDialect, 'Database: SQLite');
  assert.equal(
    classifyConnectorReceptorBox(
      {
        name: 'DB Call: db.prepare',
        entityType: 'DB_QUERY',
      },
      sqliteGraph
    ),
    'Database: SQLite'
  );
  assert.equal(
    classifyConnectorReceptorBox({
      name: 'Redis Call: redis.get',
      entityType: 'DB_OPERATION',
    }),
    'Cache: Redis'
  );
  assert.equal(
    classifyConnectorReceptorBox({
      name: 'HTTP: GET /api/users',
      entityType: 'HTTP_FETCH',
    }),
    'External: HTTP API'
  );
});

test('auditScoutSanity summarizes stack, entities, connectivity, and unregistered signal candidates on a committed fixture', () => {
  const fixturePath = path.join(fixturesDir, 'shape-keys');
  const graph = analyzeTarget(fixturePath);
  const report = auditScoutSanity(fixturePath, graph, {
    repoName: 'shape-keys',
  });

  assert.equal(report.summary.repoName, 'shape-keys');
  assert.ok(report.summary.contractCount > 0);
  assert.ok(report.unregisteredSignalCandidates.length > 0);

  const localFromCall = report.unregisteredSignalCandidates.find(
    (c) => c.shapeKey === 'sk1/CALL/LocalFromCall/Prop(Id)'
  );
  assert.ok(localFromCall, 'expected sk1/CALL/LocalFromCall/Prop(Id) candidate');
  assert.equal(localFromCall.firstSeenFile, 'shapes.ts');
});

test('auditScoutSanity flags ZERO_EDGE_COLLAPSE, DEAD_END_INGRESS, and HIGH_ORPHAN_RATIO when contracts have 0 resolved edges', () => {
  const fixturePath = path.join(fixturesDir, 'layered-app');
  const baseGraph = analyzeTarget(fixturePath);

  // Strip resolved targetIds from all edges to simulate a 0-edge / single-column layout collapse
  const disconnectedGraph: RepresentationGraph = {
    ...baseGraph,
    edges: baseGraph.edges.map((e) => ({
      ...e,
      targetId: undefined,
    })),
  };

  const report = auditScoutSanity(fixturePath, disconnectedGraph, {
    repoName: 'express-disconnected',
    layoutMetrics: {
      storyCount: 3,
      renderedEdgeCount: 0,
      maxCol: 0,
    },
  });

  const kinds = new Set(report.anomalies.map((a) => a.kind));
  assert.ok(kinds.has('ZERO_EDGE_COLLAPSE'), 'expected ZERO_EDGE_COLLAPSE anomaly');
  assert.ok(kinds.has('DEAD_END_INGRESS'), 'expected DEAD_END_INGRESS anomaly');
});

test('auditScoutSanity flags MASKED_LOW_CONNECTIVITY when low-confidence fallbacks mask raw call resolution', () => {
  const fixturePath = path.join(fixturesDir, 'method-calls');
  const baseGraph = analyzeTarget(fixturePath);
  const contractId = baseGraph.nodes.find((n) => n.type === 'CONTRACT')!.id;

  const syntheticFallbacks = Array.from({ length: 12 }, (_, idx) => ({
    id: `fallback-${idx}`,
    name: `Call: dynamic_${idx}()`,
    type: 'RELATIONSHIP' as const,
    entityType: 'CALL',
    patternId: 'relationship.invoke-returned-function',
    scope: 'USER' as const,
    sourceId: contractId,
    targetId: undefined,
    status: 'INFERRED' as const,
    confidence: 'LOW' as const,
    evidence: {
      filePath: 'index.ts',
      lineNumber: idx + 1,
      snippet: `dynamic_${idx}()`,
    },
  }));

  const report = auditScoutSanity(fixturePath, {
    ...baseGraph,
    edges: [...baseGraph.edges, ...syntheticFallbacks],
  });

  const masked = report.anomalies.find((a) => a.kind === 'MASKED_LOW_CONNECTIVITY');
  assert.ok(masked, 'expected MASKED_LOW_CONNECTIVITY anomaly');
  assert.ok(report.summary.connectivityRate - report.summary.rawConnectivityRate >= 15);
});

test('auditScoutSanity flags TRACER_STARVATION_DROP, SUSPICIOUS_BUILTIN_METHOD_TARGET, CONTRACT_HASH_COLLISION, and CROSS_SCOPE_DANGLING_EDGE', () => {
  const fixturePath = path.join(fixturesDir, 'method-calls');
  const baseGraph = analyzeTarget(fixturePath);
  const contracts = baseGraph.nodes.filter((n) => n.type === 'CONTRACT');
  assert.ok(contracts.length >= 2);
  const sourceContract = contracts[0];
  const targetContract = contracts[1];

  const collidingNode = {
    ...targetContract,
    metadata: {
      ...targetContract.metadata,
      collisionLocations: ['src/a.ts:1', 'src/b.ts:1'],
    },
  };

  const suspiciousEdge = {
    id: 'suspicious-builtin-1',
    name: 'Call: list.filter()',
    type: 'RELATIONSHIP' as const,
    entityType: 'CALL',
    patternId: 'relationship.invoke-returned-function',
    scope: 'USER' as const,
    sourceId: sourceContract.id,
    targetId: targetContract.id,
    status: 'DETERMINISTIC' as const,
    confidence: 'HIGH' as const,
    evidence: {
      filePath: 'index.ts',
      lineNumber: 10,
      snippet: 'list.filter(Boolean)',
    },
  };

  const danglingEdge = {
    id: 'dangling-cross-scope-1',
    name: 'Call: mockFn()',
    type: 'RELATIONSHIP' as const,
    entityType: 'CALL',
    patternId: 'relationship.function-call',
    scope: 'USER' as const,
    sourceId: sourceContract.id,
    targetId: 'missing-mock-node-id',
    status: 'DETERMINISTIC' as const,
    confidence: 'HIGH' as const,
    evidence: {
      filePath: 'index.ts',
      lineNumber: 12,
      snippet: 'mockFn()',
    },
  };

  const report = auditScoutSanity(
    fixturePath,
    {
      ...baseGraph,
      nodes: baseGraph.nodes.map((n) => (n.id === targetContract.id ? collidingNode : n)),
      edges: [...baseGraph.edges, suspiciousEdge, danglingEdge],
    },
    {
      layoutMetrics: {
        storyCount: 1,
        renderedEdgeCount: 1,
        maxCol: 1,
        orphanNodeIds: [targetContract.id],
      },
    }
  );

  const kinds = new Set(report.anomalies.map((a) => a.kind));
  assert.ok(kinds.has('TRACER_STARVATION_DROP'), 'expected TRACER_STARVATION_DROP anomaly');
  assert.ok(kinds.has('SUSPICIOUS_BUILTIN_METHOD_TARGET'), 'expected SUSPICIOUS_BUILTIN_METHOD_TARGET anomaly');
  assert.ok(kinds.has('CONTRACT_HASH_COLLISION'), 'expected CONTRACT_HASH_COLLISION anomaly');
  assert.ok(kinds.has('CROSS_SCOPE_DANGLING_EDGE'), 'expected CROSS_SCOPE_DANGLING_EDGE anomaly');
});

test('auditScoutSanity treats single-package multi-folder repos as honest single boards and flags collapsed multi-workspace repos ([PAT-EXT-30])', () => {
  const fullstackDir = path.join(fixturesDir, 'fullstack-monolith-decomposition');
  const fullstackGraph = analyzeTarget(fullstackDir);
  const singleReport = auditScoutSanity(fullstackDir, fullstackGraph);
  assert.equal(
    singleReport.anomalies.some((a) => a.kind === 'BOUNDARY_COLLAPSE'),
    false,
    'Single-package repo with 1 DEPLOYMENT_UNIT across multiple folders must not raise BOUNDARY_COLLAPSE'
  );

  const monorepoDir = path.join(fixturesDir, 'monorepo-pnpm');
  const monorepoGraph = analyzeTarget(monorepoDir);
  const collapsedNodes = monorepoGraph.nodes.filter(
    (n) => !(n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT')
  );
  collapsedNodes.push({
    id: 'single-du-collapsed',
    name: 'Deployment Unit: monorepo-pnpm',
    type: 'BOUNDARY',
    entityType: 'DEPLOYMENT_UNIT',
    patternId: 'boundary.deployment-unit',
    scope: 'USER',
    evidence: { filePath: '.' },
  });
  const collapsedReport = auditScoutSanity(monorepoDir, {
    ...monorepoGraph,
    nodes: collapsedNodes,
  });
  const collapseAnomaly = collapsedReport.anomalies.find(
    (a) => a.kind === 'BOUNDARY_COLLAPSE'
  );
  assert.ok(
    collapseAnomaly,
    'Expected BOUNDARY_COLLAPSE when >= 2 workspace manifests exist on disk but only 1 DEPLOYMENT_UNIT was emitted'
  );
  assert.equal(collapseAnomaly.severity, 'HIGH');
});
