import assert from 'node:assert';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepresentationGraph } from '@chomp/core';
import {
  applyMigrations,
  createSQLiteStorage,
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
} from './index.js';
import { RepositoryInfo } from '../../interface.js';

test('createSQLiteStorage defaults to :memory: and creates tables', async () => {
  const storage = createSQLiteStorage(':memory:');
  const repos = await storage.listRepositories();
  assert.deepStrictEqual(repos, []);
  await storage.close();
});

test('saveRepresentationGraph and getRepresentationGraph with repository info', async () => {
  const storage = createSQLiteStorage(':memory:');

  const repo: RepositoryInfo = {
    id: 'repo-123',
    name: 'chomp-core',
    path: '/path/to/chomp-core',
  };

  const graph: RepresentationGraph = {
    extractorVersion: '1.0.0',
    analyzedAt: '2026-08-09T10:00:00Z',
    nodes: [
      {
        id: 'b1',
        name: 'AuthService',
        type: 'BOUNDARY',
        entityType: 'CLASS',
        patternId: 'boundary.class-declaration',
        scope: 'USER',
        evidence: {
          filePath: 'src/auth/service.ts',
          lineNumber: 12,
          snippet: 'class AuthService {}',
        },
      },
      {
        id: 'c1',
        name: 'POST /api/login',
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.express-route',
        scope: 'USER',
        evidence: {
          filePath: 'src/auth/router.ts',
          lineNumber: 45,
          snippet: "router.post('/login', handler)",
        },
      },
      {
        id: 'oc1',
        name: 'StripePaymentGateway',
        type: 'OPEN_CONNECTOR',
        entityType: 'HTTP_FETCH',
        patternId: 'open-connector.http-call',
        scope: 'USER',
        evidence: {
          filePath: 'src/payment/stripe.ts',
          lineNumber: 3,
        },
      },
    ],
    edges: [
      {
        id: 'r1',
        name: 'AuthService -> Database',
        type: 'RELATIONSHIP',
        entityType: 'IMPORT',
        patternId: 'relationship.import-declaration',
        scope: 'USER',
        sourceId: 'b1',
        evidence: {
          filePath: 'src/auth/service.ts',
          lineNumber: 8,
          snippet: 'import { db } from "../db";',
        },
      },
    ],
  };

  // Initially returns null for unknown repository
  assert.strictEqual(await storage.getRepresentationGraph(repo.id), null);

  // Save graph and retrieve
  await storage.saveRepresentationGraph(repo, graph);
  const retrieved = await storage.getRepresentationGraph(repo.id);

  assert.deepStrictEqual(retrieved, graph);

  // listRepositories
  const repos = await storage.listRepositories();
  assert.strictEqual(repos.length, 1);
  assert.strictEqual(repos[0].id, 'repo-123');
  assert.strictEqual(repos[0].name, 'chomp-core');

  // Upsert/overwrite repository graph
  const updatedGraph: RepresentationGraph = {
    ...graph,
    analyzedAt: '2026-08-09T11:00:00Z',
    nodes: [],
  };

  await storage.saveRepresentationGraph(repo, updatedGraph);
  const updatedRetrieved = await storage.getRepresentationGraph(repo.id);
  assert.deepStrictEqual(updatedRetrieved, updatedGraph);

  // deleteRepository
  await storage.deleteRepository(repo.id);
  const nullAfterDelete = await storage.getRepresentationGraph(repo.id);
  assert.strictEqual(nullAfterDelete, null);

  await storage.close();
});

test('saveRepresentationGraph separates AST metadata from entity_overlays and detects body_hash staleness', async () => {
  const storage = createSQLiteStorage(':memory:');
  const repo: RepositoryInfo = {
    id: 'repo-meta',
    name: 'chomp-meta',
    path: '/path/to/chomp-meta',
  };

  const initialGraph: RepresentationGraph = {
    extractorVersion: '1.0.0',
    analyzedAt: '2026-10-26T00:00:00Z',
    nodes: [
      {
        id: 'fn1',
        name: 'Exported Function: runStoryTracer',
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.exported-function',
        scope: 'USER',
        evidence: { filePath: 'src/story.ts', lineNumber: 10 },
        metadata: {
          bodyHash: 'hash_v1',
          inputTypes: ['RepresentationGraph'],
          outputType: 'StoryGraph',
          domain: 'visualizer',
          humanLabel: 'Story Tracer',
        },
      },
    ],
    edges: [
      {
        id: 'edge_fetch_layout',
        name: 'HTTP Fetch: GET /api/layout',
        type: 'RELATIONSHIP',
        entityType: 'HTTP_FETCH',
        patternId: 'generic.relationship',
        sourceId: 'node_tracer',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: { filePath: 'src/page.tsx', lineNumber: 78 },
        metadata: {
          httpMethod: 'GET',
          urlPath: '/api/layout?diff=true',
          summary: 'Fetches layout payload',
        },
      },
    ],
  };

  await storage.saveRepresentationGraph(repo, initialGraph);

  // Also add multi-layer and plugin overlays directly via upsertEntityOverlay
  await storage.upsertEntityOverlay({
    entityId: 'fn1',
    layer: 'L2_RUNTIME',
    source: 'datadog',
    environment: 'production',
    payload: { p95Ms: 42, errorRate: 0.002, rps: 120 },
  });
  await storage.upsertEntityOverlay({
    entityId: 'fn1',
    layer: 'PLUGIN:bundle-size',
    source: 'webpack-analyzer',
    environment: 'production',
    payload: { gzipKb: 14.2, treeshakable: true },
  });

  // Verify initial overlays are not stale (body_hash matches hash_v1)
  const initialOverlays = await storage.getEntityOverlays(repo.id, { entityId: 'fn1' });
  assert.strictEqual(initialOverlays.length, 3);
  for (const ov of initialOverlays) {
    assert.strictEqual(ov.bodyHash, 'hash_v1');
    assert.strictEqual(ov.stale, false);
  }

  // Re-analyze repository with updated AST metadata and a new bodyHash ('hash_v2')
  const reanalyzedGraph: RepresentationGraph = {
    ...initialGraph,
    analyzedAt: '2026-10-26T01:00:00Z',
    nodes: [
      {
        ...initialGraph.nodes[0],
        metadata: {
          bodyHash: 'hash_v2',
          inputTypes: ['RepresentationGraph', 'GraphDelta'],
          outputType: 'StoryGraph',
        },
      },
    ],
    edges: [
      {
        ...initialGraph.edges[0],
        metadata: {
          httpMethod: 'GET',
          urlPath: '/api/layout',
        },
      },
    ],
  };

  await storage.saveRepresentationGraph(repo, reanalyzedGraph);
  const saved = await storage.getRepresentationGraph(repo.id);

  // AST metadata in `nodes` and `edges` remains strictly pure (no enrichment keys polluting compareGraphs)
  assert.deepStrictEqual(saved?.nodes[0].metadata, {
    bodyHash: 'hash_v2',
    inputTypes: ['RepresentationGraph', 'GraphDelta'],
    outputType: 'StoryGraph',
  });
  assert.deepStrictEqual(saved?.edges[0].metadata, {
    httpMethod: 'GET',
    urlPath: '/api/layout',
  });

  // Meanwhile, all `entity_overlays` survived the destructive `structural_entities` re-run
  // and automatically report `stale: true` because `fn1`'s `bodyHash` changed from `hash_v1` to `hash_v2`!
  const afterOverlays = await storage.getEntityOverlays(repo.id, { entityId: 'fn1' });
  assert.strictEqual(afterOverlays.length, 3);
  const semanticOv = afterOverlays.find((o) => o.layer === 'L1_SEMANTIC');
  assert.deepStrictEqual(semanticOv?.payload, {
    domain: 'visualizer',
    humanLabel: 'Story Tracer',
  });
  assert.strictEqual(semanticOv?.stale, true);

  const pluginOv = afterOverlays.find((o) => o.layer === 'PLUGIN:bundle-size');
  assert.deepStrictEqual(pluginOv?.payload, {
    gzipKb: 14.2,
    treeshakable: true,
  });
  assert.strictEqual(pluginOv?.stale, true);

  // Edge overlay also survived
  const edgeOverlays = await storage.getEntityOverlays(repo.id, { entityId: 'edge_fetch_layout' });
  assert.strictEqual(edgeOverlays.length, 1);
  assert.deepStrictEqual(edgeOverlays[0].payload, {
    summary: 'Fetches layout payload',
  });

  // Deleting an overlay removes only the targeted layer/source
  const deleted = await storage.deleteEntityOverlay({
    repositoryId: repo.id,
    entityId: 'fn1',
    layer: 'PLUGIN:bundle-size',
  });
  assert.strictEqual(deleted, 1);
  const remaining = await storage.getEntityOverlays(repo.id, { entityId: 'fn1' });
  assert.strictEqual(remaining.length, 2);

  // Deleting the repository cascades to entity_overlays ([PAT-DB-04])
  await storage.deleteRepository(repo.id);
  const afterRepoDelete = await storage.getEntityOverlays(repo.id);
  assert.strictEqual(afterRepoDelete.length, 0);

  await storage.close();
});

test('createSQLiteStorage supports in-memory database instances independently', async () => {
  const storageA = createSQLiteStorage(':memory:');
  const storageB = createSQLiteStorage(':memory:');

  await storageA.saveRepresentationGraph(
    { id: 'repo-a', name: 'a', path: '/a' },
    { extractorVersion: '1.0.0', analyzedAt: '2026-11-01T00:00:00Z', nodes: [], edges: [] }
  );

  const reposA = await storageA.listRepositories();
  const reposB = await storageB.listRepositories();
  assert.strictEqual(reposA.length, 1);
  assert.strictEqual(reposB.length, 0);

  await storageA.close();
  await storageB.close();
});

test('entity_overlays supports null-safe bodyHash fallback, external inputs staleness, derivation/evidence provenance, and runId prune-on-recommit ([PAT-DB-05])', async () => {
  const fixtureRepoDir = path.resolve(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'sample-app');

  const storage = createSQLiteStorage(':memory:');
  const repo: RepositoryInfo = {
    id: 'repo-plugins',
    name: 'chomp-plugins',
    path: fixtureRepoDir,
  };

  const graph: RepresentationGraph = {
    extractorVersion: '1.0.0',
    analyzedAt: '2026-11-01T00:00:00Z',
    nodes: [
      {
        id: 'card-node',
        name: 'Exported Function: StationCard',
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.exported-function',
        scope: 'USER',
        evidence: { filePath: 'src/StationCard.tsx', lineNumber: 14 },
        metadata: {
          bodyHash: 'ast_hash_1',
        },
      },
      {
        id: 'badge-node',
        name: 'Exported Function: StatusBadge',
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.exported-function',
        scope: 'USER',
        evidence: { filePath: 'src/StatusBadge.tsx', lineNumber: 5 },
        metadata: {
          bodyHash: 'ast_hash_badge_1',
        },
      },
    ],
    edges: [],
  };

  await storage.saveRepresentationGraph(repo, graph);

  // 1. Null-safe bodyHash fallback (`bodyHash: null`) + auto-hashed external input (`hash: ''`) + provenance
  await storage.upsertEntityOverlay({
    entityId: 'card-node',
    layer: 'L1_DESIGN_SYSTEM',
    source: 'ui-audit-plugin',
    environment: 'default',
    bodyHash: null,
    derivation: 'EXTRACTED',
    inputs: [{ path: 'userService.ts', hash: '' }],
    evidence: [
      {
        filePath: 'src/StationCard.tsx',
        lineNumber: 28,
        snippet: 'color: var(--brand)',
        evidenceRole: 'token-ref',
      },
    ],
    runId: 'run_001',
    payload: {
      tier: 'Component',
      tokenCoverage: 0.92,
      undefinedVars: [],
    },
  });

  // Also write a second row in run_001 on `badge-node` for the same source
  await storage.upsertEntityOverlay({
    entityId: 'badge-node',
    layer: 'L1_DESIGN_SYSTEM',
    source: 'ui-audit-plugin',
    environment: 'default',
    derivation: 'INFERRED',
    runId: 'run_001',
    payload: {
      tier: 'Primitive',
      tokenCoverage: 1.0,
    },
  });

  const initial = await storage.getEntityOverlays(repo.id, {
    entityId: 'card-node',
    layers: ['L1_DESIGN_SYSTEM'],
  });
  assert.strictEqual(initial.length, 1);
  assert.strictEqual(initial[0].bodyHash, 'ast_hash_1');
  assert.strictEqual(initial[0].derivation, 'EXTRACTED');
  assert.strictEqual(initial[0].runId, 'run_001');
  assert.strictEqual(initial[0].stale, false);
  assert.strictEqual(initial[0].inputs?.length, 1);
  assert.strictEqual(initial[0].inputs?.[0].path, 'userService.ts');
  assert.ok((initial[0].inputs?.[0].hash.length ?? 0) >= 8);
  assert.deepStrictEqual(initial[0].evidence, [
    {
      filePath: 'src/StationCard.tsx',
      lineNumber: 28,
      snippet: 'color: var(--brand)',
      evidenceRole: 'token-ref',
    },
  ]);

  // 2. External `inputs` staleness via deterministic `inputHashes` override when input hash changes
  const savedInputHash = initial[0].inputs![0].hash;
  const afterInputChange = await storage.getEntityOverlays(repo.id, {
    entityId: 'card-node',
    layers: ['L1_DESIGN_SYSTEM'],
    inputHashes: { 'userService.ts': 'mutated_hash_deadbeef' },
  });
  assert.strictEqual(afterInputChange[0].bodyHash, 'ast_hash_1');
  assert.strictEqual(
    afterInputChange[0].stale,
    true,
    'Overlay must be flagged stale when declared external input hash changes'
  );

  const withMatchingOverride = await storage.getEntityOverlays(repo.id, {
    entityId: 'card-node',
    inputHashes: { 'userService.ts': savedInputHash },
  });
  assert.strictEqual(withMatchingOverride[0].stale, false);

  // 3. Prune-on-recommit (`runId`): re-run `ui-audit-plugin` with `run_002` emitting ONLY `card-node`.
  //    `badge-node` from `run_001` should be pruned automatically while preserving other layers/sources!
  await storage.upsertEntityOverlay({
    entityId: 'badge-node',
    layer: 'L1_SEMANTIC',
    source: 'chomp_enrich_nodes',
    payload: { humanLabel: 'Status Badge' },
  });

  await storage.upsertEntityOverlays(
    [
      {
        entityId: 'card-node',
        layer: 'L1_DESIGN_SYSTEM',
        source: 'ui-audit-plugin',
        derivation: 'EXTRACTED',
        payload: { tier: 'Component', tokenCoverage: 1.0 },
      },
    ],
    {
      repositoryId: repo.id,
      runId: 'run_002',
      pruneStaleBySource: true,
    }
  );

  const designOverlaysAfterRun2 = await storage.getEntityOverlays(repo.id, {
    layer: 'L1_DESIGN_SYSTEM',
  });
  assert.strictEqual(
    designOverlaysAfterRun2.length,
    1,
    'Obsolete badge-node overlay from run_001 must be pruned on run_002 recommit'
  );
  assert.strictEqual(designOverlaysAfterRun2[0].entityId, 'card-node');
  assert.strictEqual(designOverlaysAfterRun2[0].runId, 'run_002');

  // Unrelated L1_SEMANTIC overlay on badge-node is untouched
  const semanticOnBadge = await storage.getEntityOverlays(repo.id, {
    entityId: 'badge-node',
    layer: 'L1_SEMANTIC',
  });
  assert.strictEqual(semanticOnBadge.length, 1);
  assert.strictEqual(semanticOnBadge[0].derivation, 'AI_HYPOTHESIS');

  await storage.close();
});

test('applyMigrations upgrades v1 schema to CURRENT_SCHEMA_VERSION and rejects newer user_version', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
    CREATE TABLE structural_entities (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE edges (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE evidence_records (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, file_path TEXT NOT NULL, line_number INTEGER, snippet TEXT);
    CREATE TABLE entity_overlays (
      repository_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      layer TEXT NOT NULL DEFAULT 'L1_SEMANTIC',
      source TEXT NOT NULL DEFAULT 'chomp_enrich_nodes',
      environment TEXT NOT NULL DEFAULT 'default',
      payload TEXT NOT NULL,
      body_hash TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_id, layer, source, environment)
    );
  `);
  assert.strictEqual(getSchemaVersion(db), 0);

  applyMigrations(db);
  assert.strictEqual(getSchemaVersion(db), CURRENT_SCHEMA_VERSION);

  const overlayCols = new Set(
    (db.prepare('PRAGMA table_info(entity_overlays)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  );
  assert.ok(overlayCols.has('derivation'));
  assert.ok(overlayCols.has('inputs'));
  assert.ok(overlayCols.has('evidence'));
  assert.ok(overlayCols.has('run_id'));

  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
  assert.throws(
    () => applyMigrations(db),
    /schema version mismatch/i
  );

  db.close();
});

test('checkGraphIntegrity reports valid graph and detects dangling sources, targets, parent boundaries, and orphan overlays', async () => {
  const storage = createSQLiteStorage(':memory:');
  const repo: RepositoryInfo = {
    id: 'repo-integrity',
    name: 'chomp-integrity',
    path: '/repo-integrity',
  };

  const cleanGraph: RepresentationGraph = {
    extractorVersion: '1.0.0',
    analyzedAt: '2026-11-01T00:00:00Z',
    nodes: [
      {
        id: 'du-1',
        name: 'Deployment Unit: app',
        type: 'BOUNDARY',
        entityType: 'DEPLOYMENT_UNIT',
        patternId: 'boundary.deployment-unit',
        scope: 'USER',
        evidence: { filePath: 'package.json' },
      },
      {
        id: 'fn-1',
        name: 'Exported Function: handle',
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.exported-function',
        scope: 'USER',
        parentBoundaryId: 'du-1',
        evidence: { filePath: 'src/index.ts', lineNumber: 1 },
      },
    ],
    edges: [],
  };

  await storage.saveRepresentationGraph(repo, cleanGraph);
  const cleanReport = await storage.checkGraphIntegrity(repo.id);
  assert.strictEqual(cleanReport.valid, true);
  assert.strictEqual(cleanReport.danglingEdgeSources.length, 0);
  assert.strictEqual(cleanReport.danglingEdgeTargets.length, 0);
  assert.strictEqual(cleanReport.danglingParentBoundaries.length, 0);
  assert.strictEqual(cleanReport.orphanOverlays.length, 0);

  const brokenGraph: RepresentationGraph = {
    extractorVersion: '1.0.0',
    analyzedAt: '2026-11-01T00:00:00Z',
    nodes: [
      {
        id: 'fn-dangling-parent',
        name: 'Exported Function: orphanParentFn',
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.exported-function',
        scope: 'USER',
        parentBoundaryId: 'missing-boundary-id',
        evidence: { filePath: 'src/index.ts', lineNumber: 10 },
      },
    ],
    edges: [
      {
        id: 'edge-dangling',
        name: 'Call: missingTarget()',
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.function-call',
        scope: 'USER',
        sourceId: 'missing-source-id',
        targetId: 'missing-target-id',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: { filePath: 'src/index.ts', lineNumber: 12 },
      },
    ],
  };

  await storage.saveRepresentationGraph(repo, brokenGraph);
  await storage.upsertEntityOverlay({
    repositoryId: repo.id,
    entityId: 'deleted-node-id',
    layer: 'L1_SEMANTIC',
    source: 'chomp_enrich_nodes',
    payload: { summary: 'Orphaned overlay' },
  });

  const brokenReport = await storage.checkGraphIntegrity(repo.id);
  assert.strictEqual(brokenReport.valid, false);
  assert.strictEqual(brokenReport.danglingEdgeSources.length, 1);
  assert.strictEqual(brokenReport.danglingEdgeSources[0].sourceId, 'missing-source-id');
  assert.strictEqual(brokenReport.danglingEdgeTargets.length, 1);
  assert.strictEqual(brokenReport.danglingEdgeTargets[0].targetId, 'missing-target-id');
  assert.strictEqual(brokenReport.danglingParentBoundaries.length, 1);
  assert.strictEqual(brokenReport.danglingParentBoundaries[0].parentBoundaryId, 'missing-boundary-id');
  assert.strictEqual(brokenReport.orphanOverlays.length, 1);
  assert.strictEqual(brokenReport.orphanOverlays[0].entityId, 'deleted-node-id');

  await storage.close();
});
