import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { analyzeTarget } from './extractor/index.js';
import { loadUserConventionSets } from './extractor/conventions/config.js';

test('Extracted entities must have patternIds that exist in the ledger as handled', (t) => {
  const dbPath = path.join(process.cwd(), '..', '..', 'fixtures', 'research', 'pattern_ledger.db');

  if (!fs.existsSync(dbPath)) {
    if (process.env.CHOMP_REQUIRE_LEDGER === '1') {
      assert.fail(
        `Pattern ledger database not found at ${dbPath}. Initialize the fixtures/research submodule before running tests with CHOMP_REQUIRE_LEDGER=1.`
      );
    }
    t.skip('fixtures/research submodule not initialized; skipping ledger parity check');
    return;
  }

  // Use system sqlite3 to extract handled patterns
  const cmd = `sqlite3 "${dbPath}" "SELECT pattern_id FROM pattern_ledger WHERE status = 'handled';"`;
  const output = execSync(cmd, { encoding: 'utf8' });
  const handledPatterns = new Set(output.split('\n').map(s => s.trim()).filter(Boolean));

  assert.ok(handledPatterns.size > 0, 'Should have loaded handled patterns from DB');

  const fixturesDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos');
  const fixtures = fs.readdirSync(fixturesDir).filter(f => fs.statSync(path.join(fixturesDir, f)).isDirectory());

  for (const fixture of fixtures) {
    const fixturePath = path.join(fixturesDir, fixture);
    const expectedPath = path.join(fixturePath, 'expected.json');
    assert.ok(fs.existsSync(expectedPath), `Missing expected.json for fixture: ${fixture}`);

    const userPatternIds = new Set<string>();
    for (const set of loadUserConventionSets(fixturePath)) {
      for (const r of set.rules) {
        if (r.emit?.patternId) userPatternIds.add(r.emit.patternId);
      }
      for (const er of set.edgeRules ?? []) {
        if (er.emit?.patternId) userPatternIds.add(er.emit.patternId);
      }
    }

    const actual = analyzeTarget(fixturePath);
    const allEntities = [...actual.nodes, ...actual.edges];

    for (const entity of allEntities) {
      assert.ok(entity.patternId, `Entity ${entity.name} in fixture ${fixture} is missing a patternId`);
      assert.ok(
        handledPatterns.has(entity.patternId) || userPatternIds.has(entity.patternId),
        `Entity ${entity.name} in fixture ${fixture} has patternId '${entity.patternId}' which is not 'handled' in the ledger`
      );
    }
  }
});
