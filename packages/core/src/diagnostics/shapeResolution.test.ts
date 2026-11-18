import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { analyzeTarget } from '../extractor/index.js';
import {
  collectLedgerSignalCandidates,
  compareShapeResolution,
  derivePatternIdFromShapeKey,
  formatLedgerPatternLogCommand,
  isKnowableShapeKey,
  measureOpaqueShapeResolution,
  measureOrphanShapeResolution,
  measureShapeResolution,
} from './shapeResolution.js';

const fixturesDir = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'test-repos');
const readExpected = (fixture: string) =>
  JSON.parse(fs.readFileSync(path.join(fixturesDir, fixture, 'expected.json'), 'utf8'));

// Ground truth comes from each fixture's expected.json (a relationship with a `target` is resolved).
test('measures per-shape resolved/unresolved totals against the function-calls ground truth', () => {
  const expected = readExpected('function-calls');
  const rows = measureShapeResolution(analyzeTarget(path.join(fixturesDir, 'function-calls')));

  const want = new Map<string, { total: number; resolved: number }>();
  for (const rel of expected.relationships) {
    const w = want.get(rel.shapeKey) ?? { total: 0, resolved: 0 };
    w.total += 1;
    if (rel.target) w.resolved += 1;
    want.set(rel.shapeKey, w);
  }

  assert.equal(rows.length, want.size);
  for (const row of rows) {
    const w = want.get(row.shapeKey)!;
    assert.equal(row.total, w.total, `${row.shapeKey} total`);
    assert.equal(row.resolved, w.resolved, `${row.shapeKey} resolved`);
    assert.equal(row.unresolved, w.total - w.resolved, `${row.shapeKey} unresolved`);
  }
});

test('a fully unresolved fixture reports 0 resolved for every shape', () => {
  const expected = readExpected('shape-keys');
  const rows = measureShapeResolution(analyzeTarget(path.join(fixturesDir, 'shape-keys')));

  assert.equal(
    rows.reduce((sum, r) => sum + r.total, 0),
    expected.relationships.length
  );
  assert.ok(rows.every((r) => r.resolved === 0));
  // Ordered by unresolved count (desc), then key — stable across runs.
  const unresolved = rows.map((r) => r.unresolved);
  assert.deepEqual(unresolved, [...unresolved].sort((a, b) => b - a));
});

test('edges without a shape key are not measured (unknown is not counted as a class)', () => {
  const graph = analyzeTarget(path.join(fixturesDir, 'function-calls'));
  const stripped = {
    ...graph,
    edges: graph.edges.map((e) => ({ ...e, metadata: undefined })),
  };
  assert.deepEqual(measureShapeResolution(stripped), []);
});

test('compareShapeResolution reports a shape whose unresolved count dropped as improved', () => {
  const before = [
    { shapeKey: 'sk1/CALL/Import/Id', total: 5, resolved: 1, unresolved: 4 },
    { shapeKey: 'sk1/CALL/Param/Id', total: 2, resolved: 0, unresolved: 2 },
  ];
  const after = [
    { shapeKey: 'sk1/CALL/Import/Id', total: 5, resolved: 5, unresolved: 0 },
    { shapeKey: 'sk1/CALL/Param/Id', total: 2, resolved: 0, unresolved: 2 },
  ];
  const delta = compareShapeResolution(before, after);
  const byKey = new Map(delta.map((d) => [d.shapeKey, d]));

  assert.equal(byKey.get('sk1/CALL/Import/Id')!.verdict, 'improved');
  assert.equal(byKey.get('sk1/CALL/Import/Id')!.unresolvedDelta, -4);
  assert.equal(byKey.get('sk1/CALL/Param/Id')!.verdict, 'unchanged');
});

test('compareShapeResolution flags a regression and treats a vanished shape as unchanged-by-absence', () => {
  const before = [
    { shapeKey: 'sk1/CALL/Import/Id', total: 3, resolved: 3, unresolved: 0 },
    { shapeKey: 'sk1/CALL/Loop/Prop(Id)', total: 1, resolved: 0, unresolved: 1 },
  ];
  const after = [{ shapeKey: 'sk1/CALL/Import/Id', total: 3, resolved: 1, unresolved: 2 }];
  const byKey = new Map(compareShapeResolution(before, after).map((d) => [d.shapeKey, d]));

  assert.equal(byKey.get('sk1/CALL/Import/Id')!.verdict, 'regressed');
  assert.equal(byKey.get('sk1/CALL/Import/Id')!.unresolvedDelta, 2);
  // The shape no longer occurs at all (code removed): not an improvement we can credit.
  assert.equal(byKey.get('sk1/CALL/Loop/Prop(Id)')!.verdict, 'absent');
});

test('isKnowableShapeKey separates static/module-resolvable bindings from param/dynamic shapes', () => {
  assert.equal(isKnowableShapeKey('sk1/CALL/Import/Id'), true);
  assert.equal(isKnowableShapeKey('sk1/CALL/Import/Prop(Id)'), true);
  assert.equal(isKnowableShapeKey('sk1/CALL/ImportObject/Prop(Id)'), true);
  assert.equal(isKnowableShapeKey('sk1/CALL/ImportNamespace/Prop(Id)'), true);
  assert.equal(isKnowableShapeKey('sk1/CALL/ImportClass/Prop(Id)'), true);
  assert.equal(isKnowableShapeKey('sk1/CALL/LocalFromCall/Prop(Id)'), true);
  assert.equal(isKnowableShapeKey('sk1/CALL/LocalFromNew/Prop(Id)'), true);
  assert.equal(isKnowableShapeKey('sk1/ORPHAN/EXPORTED_FUNCTION/contract.exported-function'), true);
  assert.equal(isKnowableShapeKey('sk1/OPAQUE/EXPORTED_FUNCTION/contract.exported-function'), true);

  assert.equal(isKnowableShapeKey('sk1/CALL/Param/Id'), false);
  assert.equal(isKnowableShapeKey('sk1/CALL/ParamDestructured/Prop(Id)'), false);
  assert.equal(isKnowableShapeKey('sk1/CALL/Loop/Prop(Id)'), false);
  assert.equal(isKnowableShapeKey('sk1/CALL/Undeclared/Id'), false);
  assert.equal(isKnowableShapeKey('sk1/CALL/None/Call(Id)'), false);
});

test('measureOrphanShapeResolution and measureShapeResolution({ includeOrphans: true }) measure sk1/ORPHAN/… rows', () => {
  const graph = analyzeTarget(path.join(fixturesDir, 'react-hoc-components'));
  const orphanRows = measureOrphanShapeResolution(graph);
  assert.ok(orphanRows.length > 0);
  assert.ok(orphanRows.every((r) => r.shapeKey.startsWith('sk1/ORPHAN/')));
  assert.ok(orphanRows.every((r) => r.total === r.resolved + r.unresolved));

  const combined = measureShapeResolution(graph, { includeOrphans: true });
  assert.ok(combined.some((r) => r.shapeKey.startsWith('sk1/ORPHAN/')));
});

test('measureOpaqueShapeResolution and measureShapeResolution({ includeOpaque: true }) measure sk1/OPAQUE/… rows', () => {
  const graph = analyzeTarget(path.join(fixturesDir, 'shape-keys'));
  const opaqueRows = measureOpaqueShapeResolution(graph);
  assert.ok(opaqueRows.length > 0);
  assert.ok(opaqueRows.every((r) => r.shapeKey.startsWith('sk1/OPAQUE/')));
  assert.ok(opaqueRows.every((r) => r.total === r.resolved + r.unresolved));
  assert.ok(opaqueRows.some((r) => r.unresolved > 0));

  const combined = measureShapeResolution(graph, { includeOpaque: true });
  assert.ok(combined.some((r) => r.shapeKey.startsWith('sk1/OPAQUE/')));

  const opaqueCandidates = collectLedgerSignalCandidates(graph, { includeOpaque: true });
  const opaqueCand = opaqueCandidates.find((c) => c.shapeKey.startsWith('sk1/OPAQUE/'));
  assert.ok(opaqueCand, 'expected sk1/OPAQUE/... candidate when includeOpaque is true');
  assert.equal(opaqueCand.signal, 'OPAQUE_BODY');
  assert.equal(opaqueCand.ontologyCategory, 'CONTRACT');
});

test('derivePatternIdFromShapeKey deterministically maps shape keys to kebab-case pattern IDs', () => {
  assert.equal(
    derivePatternIdFromShapeKey('sk1/CALL/LocalFromCall/Prop(Id)'),
    'call.shape.local-from-call.prop-id'
  );
  assert.equal(
    derivePatternIdFromShapeKey('sk1/ORPHAN/EXPORTED_FUNCTION/contract.exported-function'),
    'orphan.exported-function.contract.exported-function'
  );
  assert.equal(
    derivePatternIdFromShapeKey('sk1/OPAQUE/EXPORTED_FUNCTION/contract.exported-function'),
    'opaque.exported-function.contract.exported-function'
  );
  assert.equal(
    derivePatternIdFromShapeKey('sk1/DARK_FILE/USER_SOURCE'),
    'boundary.dark-file.user-source'
  );
});

test('collectLedgerSignalCandidates extracts unregistered knowable shapes with concrete file, line, and snippet evidence', () => {
  const graph = analyzeTarget(path.join(fixturesDir, 'shape-keys'));
  const candidates = collectLedgerSignalCandidates(graph, {
    onlyKnowable: true,
    darkFiles: ['src/unparsed.ts'],
  });

  assert.ok(candidates.length > 0);
  const callCandidate = candidates.find(
    (c) => c.shapeKey === 'sk1/CALL/LocalFromCall/Prop(Id)'
  );
  assert.ok(callCandidate, 'expected sk1/CALL/LocalFromCall/Prop(Id) candidate');
  assert.equal(callCandidate.signal, 'UNRESOLVED_CALL');
  assert.equal(callCandidate.ontologyCategory, 'RELATIONSHIP');
  assert.equal(callCandidate.firstSeenFile, 'shapes.ts');
  assert.equal(typeof callCandidate.firstSeenLine, 'number');
  assert.ok((callCandidate.firstSeenLine ?? 0) > 0);
  assert.ok(callCandidate.snippet && callCandidate.snippet.includes('client.fetchAll'));

  const darkCandidate = candidates.find(
    (c) => c.shapeKey === 'sk1/DARK_FILE/USER_SOURCE'
  );
  assert.ok(darkCandidate, 'expected sk1/DARK_FILE/USER_SOURCE candidate');
  assert.equal(darkCandidate.signal, 'DARK_FILE');
  assert.equal(darkCandidate.firstSeenFile, 'src/unparsed.ts');

  // Filtering out registered shape keys omits them from returned candidates
  const filtered = collectLedgerSignalCandidates(graph, {
    onlyKnowable: true,
    registeredShapeKeys: new Set(['sk1/CALL/LocalFromCall/Prop(Id)']),
  });
  assert.ok(
    !filtered.some((c) => c.shapeKey === 'sk1/CALL/LocalFromCall/Prop(Id)')
  );

  const cmd = formatLedgerPatternLogCommand(callCandidate, 'shape-keys', 'audit-test');
  assert.match(cmd, /--id "call\.shape\.local-from-call\.prop-id"/);
  assert.match(cmd, /--signal UNRESOLVED_CALL/);
  assert.match(cmd, /--shape-key "sk1\/CALL\/LocalFromCall\/Prop\(Id\)"/);
  assert.match(cmd, /--repo "shape-keys"/);
  assert.match(cmd, /--file "shapes\.ts"/);
});
