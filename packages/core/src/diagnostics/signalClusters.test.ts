import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { analyzeTarget } from '../extractor/index.js';
import { clusterSignalInstances, orphanShapeKey, type SignalInstance } from './signalClusters.js';

// Ground truth comes from the committed fixture's expected.json — never from the extractor output.
const fixturePath = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'shape-keys');
const expected = JSON.parse(fs.readFileSync(path.join(fixturePath, 'expected.json'), 'utf8'));

function expectedCountsByShapeKey(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rel of expected.relationships) {
    counts.set(rel.shapeKey, (counts.get(rel.shapeKey) ?? 0) + 1);
  }
  return counts;
}

/** Every unresolved CALL edge of the fixture graph as a signal instance (no actionability filter). */
function unresolvedInstances(): SignalInstance[] {
  const graph = analyzeTarget(fixturePath);
  return graph.edges
    .filter(e => e.entityType === 'CALL' && !e.targetId)
    .map(e => {
      const ev = Array.isArray(e.evidence) ? e.evidence[0] : e.evidence;
      return {
        nodeId: e.sourceId,
        name: e.name.replace(/^Call:\s*/, ''),
        shapeKey: e.metadata?.shapeKey,
        signal: 'UNRESOLVED_CALL' as const,
        filePath: ev?.filePath,
        lineNumber: ev?.lineNumber,
      };
    });
}

test('clusters unresolved calls by shape key, matching the fixture ground truth', () => {
  const report = clusterSignalInstances(unresolvedInstances());
  const want = expectedCountsByShapeKey();

  assert.equal(report.unclassified.instanceCount, 0);
  assert.equal(report.clusters.length, want.size);
  for (const cluster of report.clusters) {
    assert.equal(
      cluster.instanceCount,
      want.get(cluster.shapeKey),
      `cluster ${cluster.shapeKey} instance count`
    );
    assert.equal(cluster.signal, 'UNRESOLVED_CALL');
  }
});

test('orders clusters by instance count then key, and caps examples deterministically', () => {
  const report = clusterSignalInstances(unresolvedInstances(), { maxExamples: 2 });
  const counts = report.clusters.map(c => c.instanceCount);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));

  // `sk1/CALL/Undeclared/Id` is the largest class in the fixture (makeClient, loadRows, makeHandler).
  assert.equal(report.clusters[0].shapeKey, 'sk1/CALL/Undeclared/Id');
  assert.equal(report.clusters[0].instanceCount, 3);
  assert.equal(report.clusters[0].examples.length, 2);

  // Same input => identical output (stable across runs).
  assert.deepEqual(clusterSignalInstances(unresolvedInstances(), { maxExamples: 2 }), report);
});

test('instances without a shape key are reported as unclassified, never guessed into a class', () => {
  const instances = unresolvedInstances();
  const stripped = instances.map((inst, i) => (i < 2 ? { ...inst, shapeKey: undefined } : inst));
  const report = clusterSignalInstances(stripped);

  assert.equal(report.unclassified.instanceCount, 2);
  const classified = report.clusters.reduce((sum, c) => sum + c.instanceCount, 0);
  assert.equal(classified, instances.length - 2);
});

test('the same shape key under different signals forms separate clusters', () => {
  const [first] = unresolvedInstances();
  const report = clusterSignalInstances([
    { ...first, signal: 'UNRESOLVED_CALL' },
    { ...first, signal: 'OPAQUE_BODY' },
  ]);
  assert.equal(report.clusters.length, 2);
  assert.deepEqual(report.clusters.map(c => c.signal).sort(), ['OPAQUE_BODY', 'UNRESOLVED_CALL']);
});

test('orphan shape keys are built only from the extractor closed vocabulary', () => {
  const graph = analyzeTarget(fixturePath);
  const contract = graph.nodes.find(n => n.type === 'CONTRACT')!;
  assert.equal(
    orphanShapeKey(contract),
    `sk1/ORPHAN/${contract.entityType}/${contract.patternId}`
  );
  assert.equal(orphanShapeKey(contract), 'sk1/ORPHAN/EXPORTED_FUNCTION/contract.exported-function');
});
