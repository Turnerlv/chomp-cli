import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { analyzeTarget } from './extractor/index.js';
import { SHAPE_KEY_BINDING_KINDS, SHAPE_KEY_TOKENS } from './extractor/visitors/shapeKeyVisitor.js';

/**
 * Ontology v4.0 manifest comparison.
 *
 * In addition to name/entityType/patternId, manifests assert STRUCTURE by node name:
 *   - boundaries/contracts: `parent`  (logical containment; omitted = no parent)
 *   - contracts:            `runtime` (metadata.runtime; omitted = none)
 *   - relationships:        `source` (required) and `target` (omitted = unresolved / unknown)
 *
 * Optional keys are omitted from the actual mapping when absent, so a manifest that
 * forgets (or invents) structure fails deepEqual. Unknown is a valid state — it is
 * expressed by omission, never by a fabricated target.
 *
 * Shape keys (v5 Loop 1/3): a fixture opts in to asserting `metadata.shapeKey` by declaring
 * `shapeKey` on at least one relationship. Once opted in, EVERY relationship is compared on it
 * (omitted = the edge must carry none). Fixtures that never declare one are unaffected.
 */
const fixturesDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos');
const fixtures = fs.readdirSync(fixturesDir).filter(f => fs.statSync(path.join(fixturesDir, f)).isDirectory());

/** Edge patterns emitted from a CallExpression / NewExpression callee — each must carry a shape key. */
const CALL_SHAPED_PATTERN_IDS = new Set([
  'relationship.function-call',
  'relationship.invoke-returned-function',
  'relationship.invoke-required-function',
  'relationship.inferred-method-call',
  'relationship.class-instantiation',
]);

/**
 * Closed vocabulary a shape key may be built from: its own structural tokens, the binding kinds,
 * and `ts.SyntaxKind` names. No identifier, literal or path can ever appear in a key — this is
 * what makes a key safe to display and (later) transmit.
 */
const SHAPE_KEY_VOCABULARY = new Set<string>([
  ...SHAPE_KEY_TOKENS,
  ...SHAPE_KEY_BINDING_KINDS,
  ...Object.keys(ts.SyntaxKind).filter(k => Number.isNaN(Number(k))),
]);

function assertWellFormedShapeKey(fixture: string, edgeName: string, key: string) {
  const match = /^sk1\/(CALL|NEW|RENDERS)\/([A-Za-z]+)\/(.+)$/.exec(key);
  assert.ok(match, `Fixture ${fixture}: edge "${edgeName}" has malformed shape key "${key}"`);
  for (const token of key.split('/').slice(1).join('/').split(/[^A-Za-z]+/).filter(Boolean)) {
    assert.ok(
      SHAPE_KEY_VOCABULARY.has(token),
      `Fixture ${fixture}: edge "${edgeName}" shape key "${key}" contains token "${token}" outside the closed vocabulary`
    );
  }
}

for (const fixture of fixtures) {
  test(`call edges carry well-formed, identifier-free shape keys for fixture: ${fixture}`, () => {
    const graph = analyzeTarget(path.join(fixturesDir, fixture));
    for (const edge of graph.edges) {
      if (edge.entityType !== 'CALL' || !CALL_SHAPED_PATTERN_IDS.has(edge.patternId)) continue;
      const key = edge.metadata?.shapeKey;
      assert.ok(
        typeof key === 'string',
        `Fixture ${fixture}: call edge "${edge.name}" (${edge.patternId}) has no shape key`
      );
      assertWellFormedShapeKey(fixture, edge.name, key);
    }
  });
}

for (const fixture of fixtures) {
  test(`analyzeTarget exactly matches expected.json for fixture: ${fixture}`, () => {
    const fixturePath = path.join(fixturesDir, fixture);
    const expectedPath = path.join(fixturePath, 'expected.json');
    assert.ok(fs.existsSync(expectedPath), `Missing expected.json for fixture: ${fixture}`);

    const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    const actual = analyzeTarget(fixturePath);
    const assertsShapeKeys = expected.relationships.some((r: any) => 'shapeKey' in r);

    const nameById = new Map<string, string>(actual.nodes.map(n => [n.id, n.name]));
    const nameOf = (id?: string) => (id ? nameById.get(id) : undefined);

    const mapNode = (n: any) => {
      const parent = nameOf(n.parentBoundaryId);
      const runtime = n.metadata?.runtime;
      return {
        name: n.name,
        entityType: n.entityType,
        patternId: n.patternId,
        ...(parent !== undefined ? { parent } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
      };
    };

    const actualMapped = {
      boundaries: actual.nodes.filter(n => n.type === 'BOUNDARY').map(mapNode),
      contracts: actual.nodes.filter(n => n.type === 'CONTRACT').map(mapNode),
      relationships: actual.edges.map(r => {
        const target = nameOf(r.targetId);
        const shapeKey = r.metadata?.shapeKey;
        return {
          name: r.name,
          entityType: r.entityType,
          patternId: r.patternId,
          source: nameOf(r.sourceId),
          ...(target !== undefined ? { target } : {}),
          ...(assertsShapeKeys && shapeKey !== undefined ? { shapeKey } : {}),
        };
      }),
      openConnectors: actual.nodes.filter(n => n.type === 'OPEN_CONNECTOR').map(mapNode),
    };

    // Ontology v4.0 invariant: files and directories are positional metadata, never nodes.
    for (const n of actual.nodes) {
      assert.ok(
        n.entityType !== 'FILE' && n.entityType !== 'DIRECTORY',
        `Fixture ${fixture}: v4 graph must not contain ${n.entityType} node "${n.name}"`
      );
    }

    // Sort to ensure order independence in assertions
    const sortFn = (a: any, b: any) =>
      a.name.localeCompare(b.name) ||
      (a.source ?? a.parent ?? '').localeCompare(b.source ?? b.parent ?? '') ||
      (a.target ?? '').localeCompare(b.target ?? '');

    expected.boundaries.sort(sortFn);
    actualMapped.boundaries.sort(sortFn);
    assert.deepEqual(actualMapped.boundaries, expected.boundaries, `Fixture ${fixture} boundaries mismatch`);

    expected.contracts.sort(sortFn);
    actualMapped.contracts.sort(sortFn);
    assert.deepEqual(actualMapped.contracts, expected.contracts, `Fixture ${fixture} contracts mismatch`);

    expected.relationships.sort(sortFn);
    actualMapped.relationships.sort(sortFn);
    assert.deepEqual(actualMapped.relationships, expected.relationships, `Fixture ${fixture} relationships mismatch`);

    const dedupOpenConnectors = (list: any[]) => {
      const seen = new Set<string>();
      return list.filter((oc) => {
        const key = `${oc.name}|${oc.entityType}|${oc.patternId}|${oc.parent ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const expectedOpenConnectors = dedupOpenConnectors(expected.openConnectors);
    expectedOpenConnectors.sort(sortFn);
    actualMapped.openConnectors.sort(sortFn);
    assert.deepEqual(actualMapped.openConnectors, expectedOpenConnectors, `Fixture ${fixture} openConnectors mismatch`);
  });
}
