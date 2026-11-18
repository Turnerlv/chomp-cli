import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTarget, mergeContractPortValves } from '@chomp/core';
import { createSQLiteStorage } from '@chomp/db';
import {
  CHOMP_PORTS_LAYER,
  CHOMP_PORTS_SOURCE,
  hydrateRepositoryPortValves,
} from './portHydrator.js';

const PORT_VALVES_FIXTURE = resolve(
  fileURLToPath(
    new URL('../../../../fixtures/test-repos/port-valves', import.meta.url)
  )
);

test('hydrateRepositoryPortValves resolves cross-file fields, inferred returns, diagnostics, and caches unchanged contracts', async () => {
  const storage = createSQLiteStorage(':memory:');
  try {
    const repoId = 'port_valves';
    const rawGraph = analyzeTarget(PORT_VALVES_FIXTURE, '1.1.0');
    await storage.saveRepresentationGraph(
      { id: repoId, name: 'port-valves', path: PORT_VALVES_FIXTURE },
      rawGraph
    );
    const savedGraph = (await storage.getRepresentationGraph(repoId)) ?? rawGraph;

    const summarizeNode = savedGraph.nodes.find(
      (n) => n.name === 'Exported Function: summarizeAudit'
    );
    const createOrderNode = savedGraph.nodes.find(
      (n) => n.name === 'Exported Function: createOrder'
    );
    const brokenNode = savedGraph.nodes.find(
      (n) => n.name === 'Exported Function: submitBrokenOrder'
    );
    assert.ok(summarizeNode, 'Expected summarizeAudit contract');
    assert.ok(createOrderNode, 'Expected createOrder contract');
    assert.ok(brokenNode, 'Expected submitBrokenOrder contract');

    // Speed 1 syntactic baseline: cross-file RemoteAuditRecord has no fields yet and no return annotation
    assert.equal(summarizeNode.metadata?.portValves?.tier, 'syntactic');
    assert.equal(summarizeNode.metadata?.portValves?.inputs?.[0]?.fields, undefined);
    assert.equal(summarizeNode.metadata?.portValves?.output, undefined);

    // First Speed 2 run hydrates all callable contracts
    const firstRun = await hydrateRepositoryPortValves({
      repoPath: PORT_VALVES_FIXTURE,
      repoId,
      storage,
      graph: savedGraph,
      cacheDir: false,
    });
    assert.ok(firstRun.hydratedCount >= 4, `Expected >=4 hydrated contracts, got ${firstRun.hydratedCount}`);
    assert.equal(firstRun.cachedCount, 0);
    assert.ok(firstRun.diagnosticCount >= 1, 'Expected at least 1 port mismatch diagnostic');

    const overlays = await storage.getEntityOverlays(repoId, {
      layer: CHOMP_PORTS_LAYER,
      source: CHOMP_PORTS_SOURCE,
    });

    // Verify summarizeAudit cross-file RemoteAuditRecord fields + inferred return schema + input hash tracking
    const summarizeOv = overlays.find((o) => o.entityId === summarizeNode.id);
    assert.ok(summarizeOv, 'Expected L1_PORTS overlay for summarizeAudit');
    assert.equal(summarizeOv.stale, false);
    assert.ok(
      summarizeOv.inputs?.some((inp) => inp.path === 'types.ts' && inp.hash.length > 0),
      'Expected cross-file hash dependency on types.ts'
    );

    const mergedSummarize = mergeContractPortValves(
      summarizeNode.metadata,
      [summarizeOv]
    );
    assert.ok(mergedSummarize);
    assert.equal(mergedSummarize.tier, 'typechecked');
    assert.equal(mergedSummarize.origin, 'ts-typecheck');
    assert.deepEqual(mergedSummarize.inputs?.[0]?.declaration, {
      filePath: 'types.ts',
      lineNumber: 1,
    });
    assert.deepEqual(
      mergedSummarize.inputs?.[0]?.fields?.map((f) => ({
        name: f.name,
        type: f.type,
        optional: Boolean(f.optional),
      })),
      [
        { name: 'auditId', type: 'string', optional: false },
        { name: 'flagged', type: 'boolean', optional: true },
      ]
    );
    assert.ok(mergedSummarize.output, 'Expected inferred output valve on summarizeAudit');
    assert.deepEqual(
      mergedSummarize.output.fields?.map((f) => ({ name: f.name, type: f.type })),
      [
        { name: 'summaryId', type: 'string' },
        { name: 'isClean', type: 'boolean' },
      ]
    );

    // Verify boundary call mismatch diagnostic on submitBrokenOrder -> createOrder
    const brokenOv = overlays.find((o) => o.entityId === brokenNode.id);
    assert.ok(brokenOv, 'Expected L1_PORTS overlay for submitBrokenOrder');
    const mergedBroken = mergeContractPortValves(brokenNode.metadata, [brokenOv]);
    assert.ok(mergedBroken?.diagnostics && mergedBroken.diagnostics.length >= 1);
    const callMismatch = mergedBroken.diagnostics[0];
    assert.equal(callMismatch.kind, 'TS_CALL_MISMATCH');
    assert.match(callMismatch.message, /totalCents/);
    assert.equal(callMismatch.filePath, 'orders.ts');
    assert.equal(callMismatch.peerEntityId, createOrderNode.id);

    // Stale overlay guard: if overlay is marked stale, mergeContractPortValves drops ghost diagnostics
    const staleMerged = mergeContractPortValves(brokenNode.metadata, [
      { ...brokenOv, stale: true },
    ]);
    assert.equal(staleMerged?.tier, 'syntactic');
    assert.equal(staleMerged?.diagnostics, undefined);

    // Second Speed 2 run short-circuits via stale === false cache without re-hydrating
    const secondRun = await hydrateRepositoryPortValves({
      repoPath: PORT_VALVES_FIXTURE,
      repoId,
      storage,
      graph: savedGraph,
      cacheDir: false,
    });
    assert.equal(secondRun.hydratedCount, 0);
    assert.equal(secondRun.cachedCount, firstRun.hydratedCount);
    assert.equal(secondRun.diagnosticCount, firstRun.diagnosticCount);

    // Pruning: if a contract is removed from graph, its L1_PORTS overlay is pruned
    const prunedGraph = {
      ...savedGraph,
      nodes: savedGraph.nodes.filter((n) => n.id !== brokenNode.id),
    };
    const thirdRun = await hydrateRepositoryPortValves({
      repoPath: PORT_VALVES_FIXTURE,
      repoId,
      storage,
      graph: prunedGraph,
      cacheDir: false,
    });
    assert.equal(thirdRun.prunedCount, 1);
  } finally {
    await storage.close();
  }
});
