import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { analyzeTarget } from '../extractor/index.js';
import {
  classifyCallEdgeResolution,
  computeStructuralHealthMetrics,
} from './healthMetrics.js';

const fixturesDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos');

test('classifyCallEdgeResolution and computeStructuralHealthMetrics separate RESOLVED, KNOWABLE_GAP, DYNAMIC_BOUNDARY, and PLATFORM_PRIMITIVE on resolution-classes fixture', () => {
  const fixturePath = path.join(fixturesDir, 'resolution-classes');
  const graph = analyzeTarget(fixturePath);

  const byName = new Map(
    graph.edges.map((e) => [e.name, classifyCallEdgeResolution(e)])
  );

  assert.equal(byName.get('Call: validateInput()'), 'RESOLVED');
  assert.equal(byName.get('Call: createDynamicClient()'), 'KNOWABLE_GAP');
  assert.equal(byName.get('Call: client.sendPayload()'), 'KNOWABLE_GAP');
  assert.equal(byName.get('Call: callbackHandler.onComplete()'), 'DYNAMIC_BOUNDARY');
  assert.equal(byName.get('Call: payload.trim()'), 'PLATFORM_PRIMITIVE');
  assert.equal(byName.get('Call: JSON.stringify()'), 'PLATFORM_PRIMITIVE');

  const metrics = computeStructuralHealthMetrics(graph);
  assert.equal(metrics.status, 'PASS');
  assert.equal(metrics.connectivityRate, 100);
  assert.equal(metrics.rawConnectivityRate, 16.7);
  assert.equal(metrics.knowableConnectivityRate, 33.3);
  assert.equal(metrics.entityTypeCoverage, 100);
  assert.equal(metrics.parentCoverage, 100);
  assert.equal(metrics.scopePurity, 100);
  assert.deepEqual(metrics.callResolutionCounts, {
    totalCallFamilyEdges: 6,
    provableCallCount: 1,
    resolvedCount: 1,
    knowableGapCount: 2,
    dynamicBoundaryCount: 1,
    platformPrimitiveCount: 2,
    unprovableFallbackCount: 5,
  });
});
