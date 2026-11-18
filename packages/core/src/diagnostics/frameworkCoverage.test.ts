import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import {
  analyzeTarget,
  auditFrameworkCoverage,
  classifyNodeUnresolvedCalls,
  computeActionableUnresolvedCallsByNode,
  detectFrameworkRulesFromDependencies,
  detectFrameworksFromPackageJson,
  findDarkFiles,
  findUnextractedExports,
} from '../index.js';

const repoRoot = path.resolve(process.cwd(), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'test-repos');

test('detectFrameworkRulesFromDependencies classifies supported adapters, unhandled frameworks, and libraries', () => {
  const rules = detectFrameworkRulesFromDependencies([
    'next',
    'react',
    'fastify',
    '@nestjs/core',
    'better-sqlite3',
  ]);
  const supported = rules.filter((r) => r.category === 'framework-adapter').map((r) => r.label);
  const unhandled = rules.filter((r) => r.category === 'unhandled-framework').map((r) => r.label);
  const libs = rules.filter((r) => r.category === 'library').map((r) => r.label);

  assert.deepEqual(supported, ['Next.js', 'React']);
  assert.deepEqual(unhandled, ['Fastify', 'NestJS']);
  assert.deepEqual(libs, ['SQLite']);
});

test('detectFrameworksFromPackageJson reads real package.json manifests in the monorepo', () => {
  const webFrameworks = detectFrameworksFromPackageJson(
    path.join(repoRoot, 'apps', 'web', 'package.json')
  );
  assert.ok(webFrameworks.includes('Next.js'));
  assert.ok(webFrameworks.includes('React'));

  const mcpFrameworks = detectFrameworksFromPackageJson(
    path.join(repoRoot, 'packages', 'mcp', 'package.json')
  );
  assert.ok(mcpFrameworks.includes('MCP SDK'));
});

test('auditFrameworkCoverage reports 0 warnings when declared framework conventions are extracted', () => {
  const mcpDir = path.join(repoRoot, 'packages', 'mcp');
  const graph = analyzeTarget(mcpDir);
  const report = auditFrameworkCoverage(mcpDir, graph);

  assert.equal(report.packages.length, 1);
  assert.deepEqual(report.packages[0].supportedAdapters, ['MCP SDK']);
  assert.equal(report.warnings.length, 0);
});

test('auditFrameworkCoverage emits SUSPECTED_CUSTOM_CONVENTION when a declared framework yields 0 convention entities', () => {
  const mcpDir = path.join(repoRoot, 'packages', 'mcp');
  const graph = analyzeTarget(mcpDir);
  const strippedGraph = {
    nodes: graph.nodes.filter((n) => !n.patternId.startsWith('contract.mcp-')),
    edges: graph.edges.filter((e) => !e.patternId.startsWith('relationship.mcp-')),
  };

  const report = auditFrameworkCoverage(mcpDir, strippedGraph);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0].kind, 'SUSPECTED_CUSTOM_CONVENTION');
  assert.equal(report.warnings[0].framework, 'MCP SDK');
  assert.equal(report.warnings[0].conventionSetId, 'mcp');
});

test('auditFrameworkCoverage emits UNRESOLVED_CONVENTION_CONFIG on nextjs-page-extensions-dynamic fixture', () => {
  const fixturePath = path.join(fixturesDir, 'nextjs-page-extensions-dynamic');
  const graph = analyzeTarget(fixturePath);
  const report = auditFrameworkCoverage(fixturePath, graph);

  const configWarnings = report.warnings.filter(
    (w) => w.kind === 'UNRESOLVED_CONVENTION_CONFIG'
  );
  assert.equal(configWarnings.length, 1);
  assert.equal(configWarnings[0].framework, 'nextjs');
  assert.equal(configWarnings[0].configKey, 'pageExtensions');
  assert.equal(configWarnings[0].configFile, 'next.config.mjs');
});

test('shared unresolvedClassifier filters builtin noise and surfaces actionable unresolved calls', () => {
  const fixturePath = path.join(fixturesDir, 'method-calls');
  const graph = analyzeTarget(fixturePath);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdgeMap = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!e.targetId) continue;
    const list = outEdgeMap.get(e.sourceId) ?? [];
    list.push(e.targetId);
    outEdgeMap.set(e.sourceId, list);
  }

  const byNode = computeActionableUnresolvedCallsByNode(graph, nodeById, outEdgeMap);
  const handleReq = graph.nodes.find((n) => n.name === 'Exported Function: handleRequest')!;
  const items = byNode.get(handleReq.id) ?? [];

  // `otherService.someMethod()` is MEDIUM confidence (`relationship.inferred-method-call`) -> actionable
  // `globalService.unknownMethod()` is LOW confidence (`relationship.invoke-returned-function`) -> filtered out
  // `userService.createUser()` is resolved -> not in unresolved list
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'otherService.someMethod()');
  assert.equal(items[0].reason, 'unresolved-target');

  const singleNodeItems = classifyNodeUnresolvedCalls(handleReq.id, graph, nodeById);
  assert.deepEqual(singleNodeItems, items);
});

test('findDarkFiles identifies USER-scope source files with 0 contracts, 0 class/namespace boundaries, and 0 relationships', () => {
  const fixturePath = path.join(fixturesDir, 'method-calls');
  const graph = analyzeTarget(fixturePath);
  assert.ok(Array.isArray(graph.analyzedFiles));
  assert.ok(graph.analyzedFiles!.length > 0);
  assert.deepEqual(findDarkFiles(graph), []);

  const targetFile = graph.analyzedFiles![0];
  const stripped = {
    ...graph,
    nodes: graph.nodes.filter((n) => {
      const evs = Array.isArray(n.evidence) ? n.evidence : [n.evidence];
      return n.entityType === 'DEPLOYMENT_UNIT' || !evs.some((ev) => ev?.filePath === targetFile);
    }),
    edges: graph.edges.filter((e) => {
      const evs = Array.isArray(e.evidence) ? e.evidence : [e.evidence];
      return !evs.some(
        (ev) =>
          ev?.filePath === targetFile &&
          ev?.evidenceRole !== 'import-match' &&
          ev?.evidenceRole !== 'target-signature'
      );
    }),
  };
  assert.deepEqual(findDarkFiles(stripped), [targetFile]);
});

test('findUnextractedExports surfaces non-scalar value exports when their contract node is missing, even in partially extracted files', () => {
  const fixturePath = path.join(fixturesDir, 'nextjs-drizzle');
  const graph = analyzeTarget(fixturePath);

  // When all exports (`users`, `getUser`, `findUser`, `deleteUser`) are extracted, 0 unextracted exports are reported
  assert.deepEqual(findUnextractedExports(fixturePath, graph), []);

  // Drop only `Drizzle Schema: users` (`export const users = pgTable('users', {})`) while keeping `getUser`/`findUser`/`deleteUser`
  // so `lib/db.ts` is NOT a Dark File (still has 3 extracted contracts), yet `users` is an unextracted factory export
  const partialGraph = {
    ...graph,
    nodes: graph.nodes.filter((n) => n.name !== 'Drizzle Schema: users'),
  };
  const unextracted = findUnextractedExports(fixturePath, partialGraph);
  assert.equal(unextracted.length, 1);
  assert.equal(unextracted[0].filePath, 'lib/db.ts');
  assert.equal(unextracted[0].exportName, 'users');
  assert.equal(unextracted[0].exportSyntax, 'Call(pgTable)');
});
