/**
 * @file extractor.test.ts
 * Suite of automated unit tests validating AST node parsing, file collection,
 * primitive extraction (BOUNDARY, CONTRACT, RELATIONSHIP, OPEN_CONNECTOR), CommonJS/ESM
 * handling, Express adapter rules, EventEmitter detection, and 3-tier inferred method calls.
 */

import assert from 'node:assert';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { analyzeTarget, collectFiles, stableEntityId, contractEntityId, formatLogicalBoundaryScope, resolveLogicalBoundaryScope, parseUserBoundaryRules } from './extractor/index.js';
import { getCachedSourceFile, getSourceFileDeclarationIndex } from './extractor/visitors/targetResolver.js';
import { visitContract } from './extractor/visitors/contractVisitor.js';
import { visitRelationship } from './extractor/visitors/relationshipVisitor.js';
import { computeCallShapeKey } from './extractor/visitors/shapeKeyVisitor.js';
import { propagateLocalHelperOwners } from './extractor/visitors/initBlockVisitor.js';
import { classifyNextjsFile } from './extractor/adapters/nextjsAdapter.js';
import { reconcileUnresolvedConnections } from './extractor/visitors/unresolvedConnectionVisitor.js';
import { measureOrphanShapeResolution } from './diagnostics/shapeResolution.js';
import { classifyNodeUnresolvedCalls } from './diagnostics/unresolvedClassifier.js';
import { clusterSignalInstances } from './diagnostics/signalClusters.js';
import { compareGraphs } from './differ/index.js';
import { mergeContractPortValves } from './types/ports.js';

test('collectFiles returns files for directory and single file', () => {
  const sampleDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'sample-app');
  const files = collectFiles(sampleDir);

  assert.ok(files.length >= 2);
  assert.ok(files.some((f) => f.endsWith('userService.ts')));
  assert.ok(files.some((f) => f.endsWith('types.ts')));

  const singleFile = path.join(sampleDir, 'userService.ts');
  const singleCollected = collectFiles(singleFile);
  assert.strictEqual(singleCollected.length, 1);
  assert.strictEqual(singleCollected[0], singleFile);
});

test('analyzeTarget extracts boundaries, contracts, relationships, and open connectors', () => {
  const sampleDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'sample-app');
  const graph = analyzeTarget(sampleDir);

  assert.ok(graph.nodes.some((b) => b.name === 'Class: UserService' && b.entityType === 'CLASS'));
  assert.ok(graph.nodes.some((c) => c.name === 'Interface: User' && c.entityType === 'EXPORTED_TYPE'));
  assert.ok(graph.nodes.some((c) => c.name === 'Type: UserCredentials' && c.entityType === 'EXPORTED_TYPE'));
  // v4: no IMPORT edges, no FILE nodes — files are positional metadata in evidence only
  assert.ok(!graph.edges.some((r) => r.entityType === 'IMPORT'));
  assert.ok(!graph.nodes.some((n) => n.entityType === 'FILE' || n.entityType === 'DIRECTORY'));

  // Classes and contracts hang off the deployment unit; public methods hang off their class
  const deploymentUnit = graph.nodes.find((n) => n.entityType === 'DEPLOYMENT_UNIT');
  assert.ok(deploymentUnit);
  const classNode = graph.nodes.find((b) => b.name === 'Class: UserService');
  assert.ok(classNode);
  assert.strictEqual(classNode.parentBoundaryId, deploymentUnit.id);
  const publicMethod = graph.nodes.find((c) => c.name === 'Public Method: UserService.authenticate' && c.entityType === 'PUBLIC_METHOD');
  assert.ok(publicMethod, 'Expected public method contract');
  assert.strictEqual(publicMethod.parentBoundaryId, classNode.id);

  // Open connectors use 'HTTP Call:' prefix for allowlisted HTTP clients
  assert.ok(graph.nodes.some((oc) => oc.type === 'OPEN_CONNECTOR' && oc.name.startsWith('HTTP Call:') && oc.name.includes('fetch') && oc.entityType === 'HTTP_FETCH'));

  const classBoundary = graph.nodes.find(b => b.name === 'Class: UserService');
  assert.ok(classBoundary);
  const evidence = Array.isArray(classBoundary.evidence) ? classBoundary.evidence[0] : classBoundary.evidence;
  assert.ok(evidence.filePath);
  assert.ok(evidence.lineNumber);
});

test('analyzeTarget does NOT emit false-positive OPEN_CONNECTORs for non-allowlisted calls', () => {
  // Committed fixture with patterns that triggered false positives under the old substring-matching logic:
  // `queryString.parse(res.query)` ('query' substring), `db.close()` ('db.' substring), `response.json()`,
  // `axios.create(...)`, `request.data.push(...)`, `request.url.split(...)`.
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'open-connector-false-positives');
  const graph = analyzeTarget(fixtureDir);

  // Package connectors (qs, express) are legitimate exit points; any OTHER connector is a false positive.
  const falsePositives = graph.nodes.filter(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType !== 'EXTERNAL_PACKAGE' && n.entityType !== 'NODE_BUILTIN'
  );

  assert.strictEqual(
    falsePositives.length,
    0,
    `Expected 0 non-package open connectors but got ${falsePositives.length}: ` +
    JSON.stringify(falsePositives.map((oc) => oc.name))
  );
  assert.ok(!graph.nodes.some(n => n.name.includes('axios.create')), 'Must NOT emit HTTP_FETCH for axios.create');
  assert.ok(!graph.nodes.some(n => n.name.includes('request.data')), 'Must NOT emit HTTP_FETCH for request.data.push');
  assert.ok(!graph.nodes.some(n => n.name.includes('request.url')), 'Must NOT emit HTTP_FETCH for request.url.split');
});

test('analyzeTarget extracts Express Route Definition as CONTRACT', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'express-app');
  const graph = analyzeTarget(fixtureDir);

  assert.ok(
    graph.nodes.some((c) => c.name === 'Express Route: GET /' && c.entityType === 'HTTP_ENDPOINT'),
    'Expected to extract Express GET / route as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((c) => c.name === 'Express Route: POST /login' && c.entityType === 'HTTP_ENDPOINT'),
    'Expected to extract Express POST /login route as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((c) => c.name === 'Express Route: GET /items' && c.entityType === 'HTTP_ENDPOINT'),
    'Expected to extract Express GET /items route from router as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((c) => c.name === 'Express Param: user' && c.entityType === 'HTTP_ENDPOINT'),
    'Expected to extract Express Param: user as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((c) => c.name === 'Express Content Negotiation: application/json, default' && c.entityType === 'HTTP_ENDPOINT'),
    'Expected to extract Express Content Negotiation: application/json, default as CONTRACT'
  );
  assert.ok(
    !graph.nodes.some((c) => c.name === 'Express Route: GET Range'),
    'Expected NOT to extract req.get("Range") as an Express Route'
  );
  assert.ok(
    !graph.nodes.some((c) => c.name.startsWith('Express Route:') && c.name.includes('localhost')),
    'Expected NOT to extract client axios.post("http://localhost:5000/api/auth/signup") as an Express Route'
  );
  assert.ok(
    !graph.nodes.some((c) => c.name === 'Express Route: GET /users'),
    'Expected NOT to extract client api.get("/users") as an Express Route'
  );
  assert.ok(
    !graph.edges.some((e) => e.patternId === 'relationship.express-route-handler' && (e.name.includes('signup') || e.name.includes('config'))),
    'Expected NOT to extract client payload data or config as an Express Bind relationship'
  );
  assert.ok(
    graph.nodes.some((c) => c.name === 'Property Getter: ip' && c.entityType === 'PROPERTY_GETTER'),
    'Expected to extract defineGetter ip as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((c) => c.name === 'Prototype Method: View.prototype.lookup' && c.entityType === 'PROTOTYPE_METHOD'),
    'Expected to extract View.prototype.lookup as CONTRACT'
  );
});


test('analyzeTarget extracts Express Router Mount as RELATIONSHIP', () => {
  const fixtureFile = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'express-app', 'app.js');
  const graph = analyzeTarget(fixtureFile);

  assert.ok(
    graph.edges.some((r) => r.name === 'Express Mount: /api -> apiRouter' && r.entityType === 'MOUNTS'),
    'Expected to extract Express /api mount as RELATIONSHIP'
  );
  assert.ok(
    graph.edges.some((r) => r.name === 'Express Mount: /users -> usersRouter' && r.entityType === 'MOUNTS'),
    'Expected to extract Express /users mount as RELATIONSHIP'
  );
    assert.ok(
      graph.edges.some((r) => r.name === 'Express Mount: Root -> express.json()' && r.entityType === 'INTERCEPTS'),
      'Expected to extract Express Root -> express.json() mount as INTERCEPTS'
    );
});

test('analyzeTarget models CommonJS require of an external package as an OPEN_CONNECTOR (no REQUIRE edge)', () => {
  const fixtureFile = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'express-app', 'app.js');
  const graph = analyzeTarget(fixtureFile);

  assert.ok(
    graph.nodes.some((n) => n.name === 'Package: express' && n.type === 'OPEN_CONNECTOR' && n.entityType === 'EXTERNAL_PACKAGE'),
    'Expected require("express") to produce a Package: express OPEN_CONNECTOR'
  );
  assert.ok(
    !graph.edges.some((r) => r.entityType === 'REQUIRE' || r.entityType === 'IMPORT'),
    'v4 emits no IMPORT/REQUIRE relationships'
  );
  assert.ok(
    !graph.nodes.some((n) => n.name.startsWith('Package: ./')),
    'Local requires ("./routes/api") are not external packages'
  );
});

test('analyzeTarget extracts CommonJS Module Export as an EXPORTED_MODULE CONTRACT', () => {
  const fixtureFile = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'express-app', 'app.js');
  const graph = analyzeTarget(fixtureFile);

  assert.ok(
    graph.nodes.some((c) => c.name === 'CJS Export: default' && c.type === 'CONTRACT' && c.entityType === 'EXPORTED_MODULE'),
    'Expected to extract module.exports as an EXPORTED_MODULE contract (not a boundary)'
  );
  assert.ok(
    !graph.nodes.some((b) => b.type === 'BOUNDARY' && b.entityType === 'CJS_EXPORT'),
    'A generic CJS export is not a boundary in v4'
  );
  assert.ok(
    graph.nodes.some((c) => c.name === 'CJS Export: init' && c.entityType === 'EXPORTED_FUNCTION'),
    'Expected to extract app.init as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((c) => c.name === 'Dynamic Export: app[method]' && c.entityType === 'CJS_METHOD'),
    'Expected to extract dynamic method assignment as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((c) => {
      const ev = Array.isArray(c.evidence) ? c.evidence[0] : c.evidence;
      return c.name === 'CJS Export: header' && c.entityType === 'EXPORTED_FUNCTION' && ev.snippet?.includes('req.header');
    }),
    'Expected to extract req.header assignment as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((c) => {
      const ev = Array.isArray(c.evidence) ? c.evidence[0] : c.evidence;
      return c.name === 'CJS Export: status' && c.entityType === 'EXPORTED_FUNCTION' && ev.snippet?.includes('res.status');
    }),
    'Expected to extract res.status assignment as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((c) => c.name === 'Property Getter: protocol' && c.entityType === 'PROPERTY_GETTER'),
    'Expected to extract Object.defineProperty protocol getter as CONTRACT'
  );
});

test('analyzeTarget extracts EventEmitter patterns', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'node-events');
  const graph = analyzeTarget(fixtureDir);

  assert.ok(
    graph.nodes.some((c) => c.name === 'Event Listener: event' && c.entityType === 'EVENT_LISTENER'),
    'Expected to extract EventEmitter.on as CONTRACT'
  );
  assert.ok(
    graph.nodes.some((r) => r.name === 'Event Emit: event' && r.entityType === 'EVENT_EMIT'),
    'Expected to extract EventEmitter.emit as OPEN_CONNECTOR'
  );
});

test('analyzeTarget extracts Object.create as RELATIONSHIP', () => {
  const fixtureFile = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'express-app', 'inheritance.js');
  const graph = analyzeTarget(fixtureFile);

  assert.ok(
    graph.edges.some((r) => r.name === 'Inherits: http.IncomingMessage.prototype' && r.entityType === 'INHERITS'),
    'Expected to extract Object.create as RELATIONSHIP'
  );
  assert.ok(
    graph.edges.some((r) => r.name === 'Mixes: EventEmitter' && r.entityType === 'MIXES'),
    'Expected to extract prototype mixin as RELATIONSHIP'
  );
});

test('analyzeTarget extracts method calls as INFERRED RELATIONSHIP with confidence levels', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'method-calls');
  const graph = analyzeTarget(fixtureDir);

  // HIGH confidence
  const createUserRel = graph.edges.find((r) => r.name === 'Call: userService.createUser()');
  assert.ok(createUserRel, 'Expected to extract userService.createUser()');
  assert.strictEqual(createUserRel.status, 'INFERRED');
  assert.strictEqual(createUserRel.confidence, 'HIGH');
  assert.ok(Array.isArray(createUserRel.evidence) && createUserRel.evidence.length === 3);

  // MEDIUM confidence
  const someMethodRel = graph.edges.find((r) => r.name === 'Call: otherService.someMethod()');
  assert.ok(someMethodRel, 'Expected to extract otherService.someMethod()');
  assert.strictEqual(someMethodRel.status, 'INFERRED');
  assert.strictEqual(someMethodRel.confidence, 'MEDIUM');
  assert.ok(Array.isArray(someMethodRel.evidence) && someMethodRel.evidence.length === 2);

  // LOW confidence
  const unknownMethodRel = graph.edges.find((r) => r.name === 'Call: globalService.unknownMethod()');
  assert.ok(unknownMethodRel, 'Expected to extract globalService.unknownMethod()');
  assert.strictEqual(unknownMethodRel.status, 'INFERRED');
  assert.strictEqual(unknownMethodRel.confidence, 'LOW');
  assert.ok(Array.isArray(unknownMethodRel.evidence) && unknownMethodRel.evidence.length === 1);
});

test('analyzeTarget resolves this.<prop>.method() targets for class properties and constructor parameters (sk1/CALL/This/Prop(Prop(This)))', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'method-calls');
  const graph = analyzeTarget(fixtureDir);

  const userRepoMethod = graph.nodes.find((n) => n.name === 'Public Method: UserRepository.findById');
  assert.ok(userRepoMethod, 'Expected Public Method: UserRepository.findById node');

  const expressPkg = graph.nodes.find((n) => n.name === 'Package: express');
  assert.ok(expressPkg, 'Expected Package: express open connector');

  const userServiceFind = graph.nodes.find((n) => n.name === 'Public Method: UserService.find');
  assert.ok(userServiceFind, 'Expected Public Method: UserService.find node');

  const orderServiceFind = graph.nodes.find((n) => n.name === 'Public Method: OrderService.findOrder');
  assert.ok(orderServiceFind, 'Expected Public Method: OrderService.findOrder node');

  const courseRoutesInit = graph.nodes.find((n) => n.name === 'Public Method: CourseRoutes.initRoutes');
  assert.ok(courseRoutesInit, 'Expected Public Method: CourseRoutes.initRoutes node');

  // Constructor parameter property: this.repo.findById()
  const userFindEdge = graph.edges.find(
    (e) => e.sourceId === userServiceFind.id && e.name === 'Call: this.findById()'
  );
  assert.ok(userFindEdge, 'Expected Call: this.findById() edge from UserService.find');
  assert.strictEqual(userFindEdge.targetId, userRepoMethod.id);
  assert.strictEqual(userFindEdge.metadata?.shapeKey, 'sk1/CALL/This/Prop(Prop(This))');

  // Constructor assignment property: this.repo.findById()
  const orderFindEdge = graph.edges.find(
    (e) => e.sourceId === orderServiceFind.id && e.name === 'Call: this.findById()'
  );
  assert.ok(orderFindEdge, 'Expected Call: this.findById() edge from OrderService.findOrder');
  assert.strictEqual(orderFindEdge.targetId, userRepoMethod.id);
  assert.strictEqual(orderFindEdge.metadata?.shapeKey, 'sk1/CALL/This/Prop(Prop(This))');

  // Field declaration of external package type: this.router.route('/courses')
  const routeEdge = graph.edges.find(
    (e) => e.sourceId === courseRoutesInit.id && e.name === 'Call: this.route()'
  );
  assert.ok(routeEdge, 'Expected Call: this.route() edge from CourseRoutes.initRoutes');
  assert.strictEqual(routeEdge.targetId, expressPkg.id);
  assert.strictEqual(routeEdge.metadata?.shapeKey, 'sk1/CALL/This/Prop(Prop(This))');
});

test('analyzeTarget does not fabricate package connectors for dynamic require/import and emits DYNAMIC_IMPORT warning (PAT-EXT-18)', () => {
  const fixtureFile = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'dynamic-require', 'index.js');
  const graph = analyzeTarget(fixtureFile);

  // v4: IMPORT/REQUIRE edges no longer exist, and a non-literal specifier never fabricates an EXTERNAL_PACKAGE connector.
  assert.ok(
    !graph.edges.some((r) => r.entityType === 'REQUIRE' || r.entityType === 'IMPORT'),
    'Expected no IMPORT/REQUIRE relationships'
  );
  assert.ok(
    !graph.nodes.some((n) => n.entityType === 'EXTERNAL_PACKAGE' || n.entityType === 'NODE_BUILTIN'),
    'Expected no fabricated EXTERNAL_PACKAGE / NODE_BUILTIN connectors for dynamic require(mod) / import(expr)'
  );
  // PAT-EXT-18: Non-literal import(expr) emits an explicit DYNAMIC_IMPORT Open Connector warning node.
  assert.ok(
    graph.nodes.some(
      (n) =>
        n.type === 'OPEN_CONNECTOR' &&
        n.entityType === 'DYNAMIC_IMPORT' &&
        n.name === "Dynamic Import: import('./custom-' + engine + '.js')"
    ),
    'Expected DYNAMIC_IMPORT Open Connector for non-literal import(expr)'
  );
});

test('analyzeTarget extracts monorepo workspace packages as DEPLOYMENT_UNITs and resolves sibling calls to the exported contract', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'monorepo-pnpm');
  const graph = analyzeTarget(fixtureDir);

  // v4: every workspace package is a DEPLOYMENT_UNIT; files are never nodes.
  const packageA = graph.nodes.find(n => n.name === 'Deployment Unit: @acme/a' && n.entityType === 'DEPLOYMENT_UNIT');
  const packageB = graph.nodes.find(n => n.name === 'Deployment Unit: @acme/b' && n.entityType === 'DEPLOYMENT_UNIT');

  assert.ok(packageA, 'Expected @acme/a deployment unit');
  assert.ok(packageB, 'Expected @acme/b deployment unit');
  assert.ok(!graph.nodes.some(n => n.entityType === 'FILE' || n.entityType === 'DIRECTORY'), 'v4 graph must not contain FILE/DIRECTORY nodes');

  // Contracts are parented to the deployment unit of the package that declares them
  const doA = graph.nodes.find(n => n.name === 'Exported Function: doA');
  const doB = graph.nodes.find(n => n.name === 'Exported Function: doB');
  assert.ok(doA && doB, 'Expected doA and doB contracts');
  assert.strictEqual(doA.parentBoundaryId, packageA.id, 'doA should be parented to @acme/a');
  assert.strictEqual(doB.parentBoundaryId, packageB.id, 'doB should be parented to @acme/b');

  // The sibling call originates from the calling contract and targets the exported contract (never a file)
  const siblingCall = graph.edges.find(e => e.name === 'Call: doA()');
  assert.ok(siblingCall, 'Expected Call: doA() edge');
  assert.strictEqual(siblingCall.sourceId, doB.id, 'Call should originate from doB');

  // PAT-EXT-19: Contract IDs are derived from the logical boundary scope (@acme/a), not physical filePath
  const expectedTargetId = stableEntityId('@acme/a', 'CONTRACT', 'Exported Function: doA');
  assert.strictEqual(siblingCall.targetId, expectedTargetId, 'Call should target doA (resolved via workspace registry)');
  assert.strictEqual(siblingCall.targetId, doA.id);

  // Verify NO external package connector was generated for @acme/a
  const externalA = graph.nodes.find(n => n.entityType === 'EXTERNAL_PACKAGE' && n.name.includes('@acme/a'));
  assert.ok(!externalA, 'Should not generate an EXTERNAL_PACKAGE connector for workspace imports');
});

test('analyzeTarget extracts Next.js Server Actions and JSX Composition', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'nextjs-components');
  const graph = analyzeTarget(fixtureDir);

  const serverAction = graph.nodes.find(n => n.name === 'Server Action: updateUser' && n.entityType === 'SERVER_ACTION');
  assert.ok(serverAction, 'Expected to extract Server Action: updateUser');
  assert.strictEqual(serverAction.metadata?.runtime, 'server', "'use server' directive becomes metadata.runtime, not a node");
  assert.ok(!graph.nodes.some(n => n.entityType === 'NEXTJS_DIRECTIVE'), 'Directives must not be emitted as nodes');

  const jsxRender = graph.edges.find(e => e.name === 'Renders: <UserProfile />' && e.entityType === 'RENDERS');
  assert.ok(jsxRender, 'Expected to extract Renders: <UserProfile />');

  // The render originates from the page contract and targets the component contract (never a file)
  const page = graph.nodes.find(n => n.entityType === 'NEXTJS_PAGE');
  const userProfile = graph.nodes.find(n => n.name === 'Exported Function: UserProfile');
  assert.ok(page && userProfile);
  assert.strictEqual(jsxRender.sourceId, page.id);
  assert.strictEqual(jsxRender.targetId, userProfile.id);
  assert.strictEqual(userProfile.metadata?.runtime, 'client', "'use client' directive becomes metadata.runtime");
});

test('analyzeTarget attributes calls inside non-exported bridge and leaf helpers to calling contract without false INIT_BLOCK', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'bridge-private-helper');
  const graph = analyzeTarget(fixtureDir);

  const handleRequest = graph.nodes.find(n => n.name === 'Exported Function: handleRequest');
  const runStageOne = graph.nodes.find(n => n.name === 'Exported Function: runStageOne');
  const runStageTwo = graph.nodes.find(n => n.name === 'Exported Function: runStageTwo');
  assert.ok(handleRequest && runStageOne && runStageTwo, 'Expected exported contracts');

  // Private helpers must not be emitted as CONTRACT nodes
  assert.ok(!graph.nodes.some(n => n.name.includes('executePipeline') || n.name.includes('normalizeInput')));

  // Pure/bridge private helpers must not trigger an INIT_BLOCK when no module-level evaluation exists
  assert.ok(!graph.nodes.some(n => n.entityType === 'INIT_BLOCK'), 'Expected zero INIT_BLOCK boundaries');

  // Calls inside bridge helper executePipeline() must originate from handleRequest
  const callStageOne = graph.edges.find(e => e.name === 'Call: runStageOne()');
  const callStageTwo = graph.edges.find(e => e.name === 'Call: runStageTwo()');
  assert.ok(callStageOne && callStageTwo);
  assert.strictEqual(callStageOne.sourceId, handleRequest.id);
  assert.strictEqual(callStageOne.targetId, runStageOne.id);
  assert.strictEqual(callStageTwo.sourceId, handleRequest.id);
  assert.strictEqual(callStageTwo.targetId, runStageTwo.id);
});

test('Catalyst Hash Invariant (PAT-EXT-19): BOUNDARY and CONTRACT IDs are file-independent within a logical boundary scope', () => {
  const sampleDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'sample-app');
  const graph = analyzeTarget(sampleDir);

  const classNode = graph.nodes.find(n => n.name === 'Class: UserService');
  const methodNode = graph.nodes.find(n => n.name === 'Public Method: UserService.authenticate');
  const typeNode = graph.nodes.find(n => n.name === 'Interface: User');
  assert.ok(classNode && methodNode && typeNode);

  // Even though UserService is in userService.ts and User is in types.ts, both hash under 'sample-app'
  assert.strictEqual(classNode.id, stableEntityId('sample-app', 'BOUNDARY', 'Class: UserService'));
  assert.strictEqual(methodNode.id, stableEntityId('sample-app', 'CONTRACT', 'Public Method: UserService.authenticate'));
  assert.strictEqual(typeNode.id, stableEntityId('sample-app', 'CONTRACT', 'Interface: User'));

  // Moving a file within the same DEPLOYMENT_UNIT / NAMESPACE produces the identical logical boundary scope
  const registry = { '@acme/a': '/repo/packages/a' };
  const scopeFromOldFile = resolveLogicalBoundaryScope('packages/a/src/old-file.ts', '/repo', registry, 'Auth');
  const scopeFromNewFile = resolveLogicalBoundaryScope('packages/a/src/subdir/new-file.ts', '/repo', registry, 'Auth');
  assert.strictEqual(scopeFromOldFile, '@acme/a::Auth');
  assert.strictEqual(scopeFromNewFile, '@acme/a::Auth');
  assert.strictEqual(
    stableEntityId(scopeFromOldFile, 'CONTRACT', 'Exported Function: verify'),
    stableEntityId(scopeFromNewFile, 'CONTRACT', 'Exported Function: verify')
  );
  assert.strictEqual(formatLogicalBoundaryScope('@acme/a', null), '@acme/a');

  // Moving a contract to another file in the same deployment unit preserves its ID and yields MODIFIED (not REMOVED + ADDED)
  const movedGraph = {
    ...graph,
    nodes: graph.nodes.map(n =>
      n.id === typeNode.id
        ? { ...n, evidence: { filePath: 'domain/models/user.ts', lineNumber: 1, snippet: 'export interface User' } }
        : n
    ),
  };
  const delta = compareGraphs(graph, movedGraph);
  assert.strictEqual(delta.nodes[typeNode.id]?.status, 'MODIFIED');
  assert.strictEqual(Object.values(delta.nodes).filter(d => d.status === 'REMOVED' || d.status === 'ADDED').length, 0);
});

test('Source-Scoped Edge Identity (PAT-EXT-11): RELATIONSHIP edge IDs incorporate resolved sourceId and targetId to prevent same-file collisions', () => {
  // 1. Resolved cross-contract call incorporates `${sourceId}->${targetId}`
  const monorepoDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'monorepo-pnpm');
  const monorepoGraph = analyzeTarget(monorepoDir);
  const doA = monorepoGraph.nodes.find(n => n.name === 'Exported Function: doA');
  const doB = monorepoGraph.nodes.find(n => n.name === 'Exported Function: doB');
  const siblingCall = monorepoGraph.edges.find(e => e.name === 'Call: doA()');
  assert.ok(doA && doB && siblingCall);
  assert.strictEqual(
    siblingCall.id,
    stableEntityId(`${doB.id}->${doA.id}`, 'RELATIONSHIP', 'Call: doA()')
  );

  // 2. Multiple contracts in the same file (express-app/app.js) calling the same function `next()` get distinct edge IDs
  const expressFile = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'express-app', 'app.js');
  const expressGraph = analyzeTarget(expressFile);
  const paramContract = expressGraph.nodes.find(n => n.name === 'Express Param: user');
  const inlineMiddleware = expressGraph.nodes.find(n => n.name === 'Middleware: Inline Middleware');
  assert.ok(paramContract && inlineMiddleware);

  const paramNextCall = expressGraph.edges.find(e => e.sourceId === paramContract.id && e.name === 'Call: next()');
  const middlewareNextCall = expressGraph.edges.find(e => e.sourceId === inlineMiddleware.id && e.name === 'Call: next()');
  assert.ok(paramNextCall && middlewareNextCall, 'Expected both same-file contracts to emit Call: next() edges');
  assert.notStrictEqual(paramNextCall.id, middlewareNextCall.id, 'Same-file contracts calling next() must not collide on edge.id');
  assert.strictEqual(paramNextCall.id, stableEntityId(paramContract.id, 'RELATIONSHIP', 'Call: next()'));
  assert.strictEqual(middlewareNextCall.id, stableEntityId(inlineMiddleware.id, 'RELATIONSHIP', 'Call: next()'));

  // 3. Multiple methods in the same file (sample-app/userService.ts) calling Open Connectors (HTTP Call: fetch) get distinct edge IDs
  const sampleDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'sample-app');
  const sampleGraph = analyzeTarget(sampleDir);
  const authMethod = sampleGraph.nodes.find(n => n.name === 'Public Method: UserService.authenticate');
  const fetchUserMethod = sampleGraph.nodes.find(n => n.name === 'Public Method: UserService.fetchUserData');
  const fetchConnector = sampleGraph.nodes.find(n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'HTTP_FETCH');
  assert.ok(authMethod && fetchUserMethod && fetchConnector);

  const authFetchEdge = sampleGraph.edges.find(e => e.sourceId === authMethod.id && e.targetId === fetchConnector.id);
  const fetchUserEdge = sampleGraph.edges.find(e => e.sourceId === fetchUserMethod.id && e.targetId === fetchConnector.id);
  assert.ok(authFetchEdge && fetchUserEdge);
  assert.notStrictEqual(authFetchEdge.id, fetchUserEdge.id, 'Same-file methods calling the same Open Connector must have distinct edge IDs');
  assert.strictEqual(
    authFetchEdge.id,
    stableEntityId(`${authMethod.id}->${fetchConnector.id}`, 'RELATIONSHIP', authFetchEdge.name)
  );
  assert.strictEqual(
    fetchUserEdge.id,
    stableEntityId(`${fetchUserMethod.id}->${fetchConnector.id}`, 'RELATIONSHIP', fetchUserEdge.name)
  );
});

test('Composite Contract Ownership Registration (PAT-EXT-12): MCP tool contracts own handler calls when visitContract returns companion RELATIONSHIP edges', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'mcp-tool-ownership');
  const graph = analyzeTarget(fixtureDir);

  const registerTools = graph.nodes.find(n => n.name === 'Exported Function: registerTools');
  const mcpTool = graph.nodes.find(n => n.name === 'MCP Tool: get_nodes');
  const queryNodes = graph.nodes.find(n => n.name === 'Exported Function: queryNodes');
  assert.ok(registerTools && mcpTool && queryNodes);

  // The registration edge originates from registerTools and targets the MCP Tool contract
  const registersEdge = graph.edges.find(e => e.name === 'Registers Tool: get_nodes');
  assert.ok(registersEdge);
  assert.strictEqual(registersEdge.sourceId, registerTools.id);
  assert.strictEqual(registersEdge.targetId, mcpTool.id);

  // The call inside the MCP tool handler callback originates from MCP Tool: get_nodes, NOT registerTools
  const queryCall = graph.edges.find(e => e.name === 'Call: queryNodes()');
  assert.ok(queryCall);
  assert.strictEqual(queryCall.sourceId, mcpTool.id, 'MCP tool handler call must be owned by MCP Tool contract, not enclosing function');
  assert.strictEqual(queryCall.targetId, queryNodes.id);
});

test('Self-Representation Patterns (PAT-EXT-16, PAT-EXT-20, PAT-EXT-21): resolves lazy JSX imports, same-file exported calls, class instantiation, and factory-returned method calls', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'self-rep-patterns');
  const graph = analyzeTarget(fixtureDir);

  // 1. PAT-EXT-20: next/dynamic lazy component import resolves <ChartView /> without emitting a false INIT_BLOCK
  assert.ok(!graph.nodes.some(n => n.entityType === 'INIT_BLOCK'), 'Top-level dynamic() import alias must not create an INIT_BLOCK');
  const pageNode = graph.nodes.find(n => n.entityType === 'NEXTJS_PAGE');
  const chartViewNode = graph.nodes.find(n => n.name === 'Exported Function: ChartView');
  assert.ok(pageNode && chartViewNode, 'Expected Next.js Page and ChartView component contracts');
  const rendersChart = graph.edges.find(e => e.name === 'Renders: <ChartView />' && e.entityType === 'RENDERS');
  assert.ok(rendersChart, 'Expected Renders: <ChartView /> edge');
  assert.strictEqual(rendersChart.sourceId, pageNode.id);
  assert.strictEqual(rendersChart.targetId, chartViewNode.id);

  // 2. PAT-EXT-21: Same-file exported function call resolves to sibling Exported Function contract
  const runWorkflow = graph.nodes.find(n => n.name === 'Exported Function: runWorkflow');
  const leafHelper = graph.nodes.find(n => n.name === 'Exported Function: leafHelper');
  assert.ok(runWorkflow && leafHelper, 'Expected runWorkflow and leafHelper contracts');
  const sameFileCall = graph.edges.find(e => e.sourceId === runWorkflow.id && e.name === 'Call: leafHelper()');
  assert.ok(sameFileCall, 'Expected Call: leafHelper() edge');
  assert.strictEqual(sameFileCall.targetId, leafHelper.id, 'Same-file call to exported function must resolve targetId');

  // 3. PAT-EXT-16: Factory function `createStorage()` links to `Class: StorageAdapter`, which links to `initSchema()`,
  //    and `storage.close()` on factory-returned variable resolves to `Public Method: StorageAdapter.close`
  const createStorage = graph.nodes.find(n => n.name === 'Exported Function: createStorage');
  const storageClass = graph.nodes.find(n => n.name === 'Class: StorageAdapter' && n.entityType === 'CLASS');
  const initSchema = graph.nodes.find(n => n.name === 'Exported Function: initSchema');
  const closeMethod = graph.nodes.find(n => n.name === 'Public Method: StorageAdapter.close');
  const sqlitePkg = graph.nodes.find(n => n.name === 'Package: better-sqlite3');
  assert.ok(createStorage && storageClass && initSchema && closeMethod && sqlitePkg);

  const newClassEdge = graph.edges.find(e => e.sourceId === createStorage.id && e.name === 'Call: new StorageAdapter()');
  assert.ok(newClassEdge, 'Expected Call: new StorageAdapter() edge from createStorage');
  assert.strictEqual(newClassEdge.targetId, storageClass.id);

  const ctorCallEdge = graph.edges.find(e => e.sourceId === storageClass.id && e.name === 'Call: initSchema()');
  assert.ok(ctorCallEdge, 'Expected constructor call to initSchema() owned by Class: StorageAdapter');
  assert.strictEqual(ctorCallEdge.targetId, initSchema.id);

  const factoryMethodCall = graph.edges.find(e => e.sourceId === runWorkflow.id && e.name === 'Call: storage.close()');
  assert.ok(factoryMethodCall, 'Expected Call: storage.close() from runWorkflow');
  assert.strictEqual(factoryMethodCall.targetId, closeMethod.id, 'Method call on factory-returned variable must resolve to Public Method contract');

  const thisDbClose = graph.edges.find(e => e.sourceId === closeMethod.id && e.name === 'Call: this.close()');
  assert.ok(thisDbClose, 'Expected Call: this.close() from StorageAdapter.close');
  assert.strictEqual(thisDbClose.targetId, sqlitePkg.id, 'this.db.close() must resolve to Package: better-sqlite3 via property type');

  // 4. PAT-EXT-17: `this.db.close()` also emits an active `DB Call: db.close` OPEN_CONNECTOR
  const dbCloseConnector = graph.nodes.find(n => n.name === 'DB Call: db.close' && n.entityType === 'DB_QUERY');
  assert.ok(dbCloseConnector, 'Expected DB Call: db.close OPEN_CONNECTOR from this.db.close()');
  const dbCloseEdge = graph.edges.find(e => e.sourceId === closeMethod.id && e.targetId === dbCloseConnector.id);
  assert.ok(dbCloseEdge, 'Expected DETERMINISTIC CALL edge from StorageAdapter.close to DB Call: db.close');

  // 5. PAT-EXT-22: Port Valve schema extraction attaches outputType metadata onto callable contracts
  assert.strictEqual(createStorage.metadata?.outputType, 'StorageAdapter', 'createStorage must record StorageAdapter as its outputType Port Valve');

  // 6. PAT-EXT-13: Exported ArrowFunction VariableStatement (`arrowWorker`) and trailing ExportDeclaration (`aliasedTask`)
  const arrowWorker = graph.nodes.find(n => n.name === 'Exported Function: arrowWorker' && n.entityType === 'EXPORTED_FUNCTION');
  const aliasedTask = graph.nodes.find(n => n.name === 'Exported Function: aliasedTask' && n.entityType === 'EXPORTED_FUNCTION');
  assert.ok(arrowWorker, 'Expected Exported Function: arrowWorker from export const arrowWorker = () => {}');
  assert.ok(aliasedTask, 'Expected Exported Function: aliasedTask from export { internalTask as aliasedTask }');
  assert.deepStrictEqual(arrowWorker.metadata?.inputTypes, ['StorageAdapter']);
  assert.strictEqual(arrowWorker.metadata?.outputType, 'StorageAdapter');
  assert.ok(
    graph.edges.some(e => e.sourceId === arrowWorker.id && e.targetId === leafHelper.id),
    'Calls inside arrowWorker body must be owned by Exported Function: arrowWorker'
  );
  assert.ok(
    graph.edges.some(e => e.sourceId === aliasedTask.id && e.targetId === leafHelper.id),
    'Calls inside internalTask body must be owned by Exported Function: aliasedTask'
  );

  // 7. PAT-EXT-14: Static bracket call `storage['close']()` resolves to `Public Method: StorageAdapter.close`
  const closeEdges = graph.edges.filter(
    e => e.sourceId === runWorkflow.id && e.name === 'Call: storage.close()' && e.targetId === closeMethod.id
  );
  assert.strictEqual(closeEdges.length, 2, 'Both storage.close() and storage[\'close\']() must resolve to Public Method: StorageAdapter.close');

  // 8. PAT-EXT-15: Higher-order callback (`['a', 'b'].map(arrowWorker)`) and dispatch table (`{ task: aliasedTask }`)
  const callbackEdge = graph.edges.find(
    e => e.sourceId === runWorkflow.id && e.patternId === 'relationship.callback-reference' && e.targetId === arrowWorker.id
  );
  assert.ok(callbackEdge, 'Passing arrowWorker as a callback argument must emit a resolved CALL edge');
  const dispatchEdge = graph.edges.find(
    e => e.sourceId === runWorkflow.id && e.patternId === 'relationship.dispatch-table-reference' && e.targetId === aliasedTask.id
  );
  assert.ok(dispatchEdge, 'Registering aliasedTask in an object dispatch table must emit a resolved CALL edge');

  // 9. PAT-EXT-17: Subprocess, Filesystem Mutation (ignoring read-only fs.existsSync), and Raw Socket Egress
  const fsSyncWrite = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'FS_MUTATION' && n.name === 'FS Write: fs.writeFileSync'
  );
  const fsAsyncWrite = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'FS_MUTATION' && n.name === 'FS Write: fs.promises.writeFile'
  );
  const fsExistsRead = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.name.includes('existsSync')
  );
  const subprocessExec = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'SUBPROCESS_EXEC' && n.name === 'Subprocess: child_process.execSync'
  );
  const socketEgress = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'SOCKET_EGRESS' && n.name === 'Socket Call: new WebSocket'
  );
  assert.ok(fsSyncWrite, 'Expected FS Write: fs.writeFileSync OPEN_CONNECTOR');
  assert.ok(fsAsyncWrite, 'Expected FS Write: fs.promises.writeFile OPEN_CONNECTOR');
  assert.ok(!fsExistsRead, 'Read-only fs.existsSync must NOT emit an FS_MUTATION Open Connector');
  assert.ok(subprocessExec, 'Expected Subprocess: child_process.execSync OPEN_CONNECTOR');
  assert.ok(socketEgress, 'Expected Socket Call: new WebSocket OPEN_CONNECTOR');
  assert.ok(graph.edges.some(e => e.sourceId === runWorkflow.id && e.targetId === fsSyncWrite.id));
  assert.ok(graph.edges.some(e => e.sourceId === runWorkflow.id && e.targetId === fsAsyncWrite.id));
  assert.ok(graph.edges.some(e => e.sourceId === runWorkflow.id && e.targetId === subprocessExec.id));
  assert.ok(graph.edges.some(e => e.sourceId === runWorkflow.id && e.targetId === socketEgress.id));

  // 10. PAT-EXT-18: Dynamic Import and Dynamic Code Execution (`eval`, `new Function`)
  const dynImport = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'DYNAMIC_IMPORT' && n.name === 'Dynamic Import: import(dynamicPluginPath)'
  );
  const dynEval = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'DYNAMIC_EXECUTION' && n.name === 'Dynamic Execution: eval'
  );
  const dynNewFn = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'DYNAMIC_EXECUTION' && n.name === 'Dynamic Execution: new Function'
  );
  assert.ok(dynImport, 'Expected Dynamic Import: import(dynamicPluginPath) OPEN_CONNECTOR');
  assert.ok(dynEval, 'Expected Dynamic Execution: eval OPEN_CONNECTOR');
  assert.ok(dynNewFn, 'Expected Dynamic Execution: new Function OPEN_CONNECTOR');
  assert.ok(graph.edges.some(e => e.sourceId === runWorkflow.id && e.targetId === dynImport.id));
  assert.ok(graph.edges.some(e => e.sourceId === runWorkflow.id && e.targetId === dynEval.id));
  assert.ok(graph.edges.some(e => e.sourceId === runWorkflow.id && e.targetId === dynNewFn.id));

  // 11. PAT-VIS-16: Boundary-scoped OPEN_CONNECTOR deduplication across files (`storage.ts` and `helpers.ts`)
  const dbPrepareNodes = graph.nodes.filter(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'DB_QUERY' && n.name === 'DB Call: db.prepare'
  );
  assert.strictEqual(
    dbPrepareNodes.length,
    1,
    'DB Call: db.prepare across storage.ts and helpers.ts in the same logical boundary must deduplicate into 1 OPEN_CONNECTOR node'
  );
  const dbPrepareEv = Array.isArray(dbPrepareNodes[0].evidence) ? dbPrepareNodes[0].evidence : [dbPrepareNodes[0].evidence];
  assert.strictEqual(dbPrepareEv.length, 3, 'Merged DB Call: db.prepare node must preserve all 3 evidence records across files');

  // 12. PAT-EXT-23: Intra-Repo HTTP Protocol Stitching (`fetch('/api/status')` -> `Express Route: GET /api/status`)
  const statusEndpoint = graph.nodes.find(
    n => n.type === 'CONTRACT' && n.entityType === 'HTTP_ENDPOINT' && n.name === 'Express Route: GET /api/status'
  );
  assert.ok(statusEndpoint, 'Expected Express Route: GET /api/status contract');
  const stitchedFetchEdge = graph.edges.find(
    e => e.sourceId === pageNode.id && e.entityType === 'HTTP_FETCH' && e.targetId === statusEndpoint.id
  );
  assert.ok(stitchedFetchEdge, 'fetch("/api/status") from DashboardPage must stitch directly to Express Route: GET /api/status');
  assert.strictEqual(stitchedFetchEdge.status, 'DETERMINISTIC');
  assert.strictEqual(stitchedFetchEdge.confidence, 'HIGH');
  const leftoverFetchConnector = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'HTTP_FETCH'
  );
  assert.ok(!leftoverFetchConnector, 'Fully stitched intra-repo HTTP_FETCH Open Connector must be pruned');
});

test('Dynamic URL Expression Resolution & Partial-Stitch Evidence Pruning (PAT-EXT-26): resolves local const ternary URLs, parameterized template URLs, and prunes stitched evidence', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'http-dynamic-stitching');
  const graph = analyzeTarget(fixtureDir);

  const loadDashboard = graph.nodes.find(n => n.name === 'Exported Function: loadDashboard');
  const layoutRoute = graph.nodes.find(n => n.name === 'Express Route: GET /api/layout');
  const userRoute = graph.nodes.find(n => n.name === 'Express Route: GET /api/users/:id');
  assert.ok(loadDashboard && layoutRoute && userRoute, 'Expected loadDashboard and Express Route contracts');

  // 1. Local const url = queryString ? `/api/layout?${queryString}` : '/api/layout'; fetch(url) stitches to GET /api/layout
  const layoutEdge = graph.edges.find(
    e => e.sourceId === loadDashboard.id && e.entityType === 'HTTP_FETCH' && e.targetId === layoutRoute.id
  );
  assert.ok(layoutEdge, 'fetch(url) with local const ternary/query template must stitch to Express Route: GET /api/layout');
  assert.strictEqual(layoutEdge.name, 'HTTP Fetch: GET /api/layout');

  // 2. fetch(`/api/users/${userId}`) stitches to Express Route: GET /api/users/:id
  const userEdge = graph.edges.find(
    e => e.sourceId === loadDashboard.id && e.entityType === 'HTTP_FETCH' && e.targetId === userRoute.id
  );
  assert.ok(userEdge, 'fetch(`/api/users/${userId}`) must stitch to Express Route: GET /api/users/:id');
  assert.strictEqual(userEdge.name, 'HTTP Fetch: GET /api/users/:id');

  // 3. Partial-stitch evidence pruning: surviving HTTP Call: fetch Open Connector retains ONLY the external URL evidence
  const externalFetchConnector = graph.nodes.find(
    n => n.type === 'OPEN_CONNECTOR' && n.entityType === 'HTTP_FETCH' && n.name === 'HTTP Call: fetch'
  );
  assert.ok(externalFetchConnector, 'Expected HTTP Call: fetch Open Connector for external https:// call');
  const evList = Array.isArray(externalFetchConnector.evidence)
    ? externalFetchConnector.evidence
    : [externalFetchConnector.evidence];
  assert.strictEqual(
    evList.length,
    1,
    'Surviving HTTP Call: fetch Open Connector must prune stitched internal evidence and retain only the 1 external call site'
  );
  assert.ok(evList[0].snippet?.includes('https://api.external.example/v1/metrics'));
});

test('CommonJS Prototype & Export Resolution (PAT-EXT-29): resolves this.<method>() calls on CommonJS exports and disambiguates per-file CJS Export IDs', () => {
  const cjsAliasDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'cjs-export-alias');
  const aliasGraph = analyzeTarget(cjsAliasDir);
  const callerNode = aliasGraph.nodes.find(n => n.name === 'CJS Export Alias: myAlias.caller');
  const targetNode = aliasGraph.nodes.find(n => n.name === 'CJS Export Alias: myAlias.myFunction');
  assert.ok(callerNode && targetNode);
  const thisCall = aliasGraph.edges.find(e => e.sourceId === callerNode.id && e.name === 'Call: this.myFunction()');
  assert.ok(thisCall, 'Expected Call: this.myFunction() edge from myAlias.caller');
  assert.strictEqual(thisCall.targetId, targetNode.id, 'this.myFunction() must resolve to sibling CommonJS export contract');

  const expressDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'express-app');
  const expressGraph = analyzeTarget(expressDir);
  const cjsDefaults = expressGraph.nodes.filter(n => n.name === 'CJS Export: default');
  assert.strictEqual(cjsDefaults.length, 3);
  const uniqueIds = new Set(cjsDefaults.map(n => n.id));
  assert.strictEqual(uniqueIds.size, 3, 'Per-file CJS Export: default contracts must have distinct entity IDs');

  // Same-file CommonJS function calls (PAT-EXT-21 / sk1/CALL/LocalFunction/Id):
  const localHelperNode = aliasGraph.nodes.find(n => n.name === 'CJS Export Alias: myAlias.localHelper');
  assert.ok(localHelperNode);
  const localCall = aliasGraph.edges.find(e => e.sourceId === callerNode.id && e.name === 'Call: localHelper()');
  assert.ok(localCall);
  assert.strictEqual(localCall.targetId, localHelperNode.id);
  assert.strictEqual(localCall.metadata?.shapeKey, 'sk1/CALL/LocalFunction/Id');

  const computeNode = aliasGraph.nodes.find(n => n.name === 'CJS Export: compute');
  const addNode = aliasGraph.nodes.find(n => n.name === 'CJS Export: add');
  assert.ok(computeNode && addNode);
  const addCall = aliasGraph.edges.find(e => e.sourceId === computeNode.id && e.name === 'Call: add()');
  assert.ok(addCall);
  assert.strictEqual(addCall.targetId, addNode.id);
  assert.strictEqual(addCall.metadata?.shapeKey, 'sk1/CALL/LocalFunction/Id');

  const healthNode = aliasGraph.nodes.find(n => n.name === 'CJS Export: health');
  const pingNode = aliasGraph.nodes.find(n => n.name === 'CJS Export: ping');
  assert.ok(healthNode && pingNode);
  const pingCall = aliasGraph.edges.find(e => e.sourceId === healthNode.id && e.name === 'Call: ping()');
  assert.ok(pingCall);
  assert.strictEqual(pingCall.targetId, pingNode.id);
  assert.strictEqual(pingCall.metadata?.shapeKey, 'sk1/CALL/LocalFunction/Id');

  const runNode = aliasGraph.nodes.find(n => n.name === 'CJS Export: run');
  const defaultNode = aliasGraph.nodes.find(n => n.name === 'CJS Export: default');
  assert.ok(runNode && defaultNode);
  const baseCall = aliasGraph.edges.find(e => e.sourceId === runNode.id && e.name === 'Call: base()');
  assert.ok(baseCall);
  assert.strictEqual(baseCall.targetId, defaultNode.id);
  assert.strictEqual(baseCall.metadata?.shapeKey, 'sk1/CALL/LocalFunction/Id');
});

test('Multi-Shape Workspace Discovery & Parent Monorepo Sub-Package Detection (PAT-EXT-30): supports object workspaces, services/client/server sub-packages, and parent monorepo sub-targets', () => {
  // 1. Multi-shape workspace fixture: Yarn/npm `workspaces: { packages: [...] }`, `services/*`, `client/`, `server/`, and root config file non-collision
  const multiWsDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'multi-shape-workspaces');
  const multiWsGraph = analyzeTarget(multiWsDir);

  const duNames = multiWsGraph.nodes
    .filter(n => n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT')
    .map(n => n.name)
    .sort();
  assert.deepStrictEqual(duNames, [
    'Deployment Unit: @acme/server',
    'Deployment Unit: @acme/worker',
    'Deployment Unit: multi-shape-workspaces',
  ]);

  const submitForm = multiWsGraph.nodes.find(n => n.name === 'Exported Function: submitForm');
  const handleRequest = multiWsGraph.nodes.find(n => n.name === 'Exported Function: handleRequest');
  const enqueueJob = multiWsGraph.nodes.find(n => n.name === 'Exported Function: enqueueJob');
  assert.ok(submitForm && handleRequest && enqueueJob);

  const clientToServer = multiWsGraph.edges.find(
    e => e.sourceId === submitForm.id && e.targetId === handleRequest.id
  );
  const serverToWorker = multiWsGraph.edges.find(
    e => e.sourceId === handleRequest.id && e.targetId === enqueueJob.id
  );
  assert.ok(clientToServer, 'client -> @acme/server cross-workspace call must resolve');
  assert.ok(serverToWorker, '@acme/server -> @acme/worker cross-workspace call must resolve');

  // 2. Sub-package targetPath inside a parent monorepo root (`monorepo-pnpm/packages/b`)
  const subPkgTarget = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'monorepo-pnpm', 'packages', 'b');
  const subPkgGraph = analyzeTarget(subPkgTarget);
  const subPkgDu = subPkgGraph.nodes.find(
    n => n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT'
  );
  assert.ok(subPkgDu);
  assert.strictEqual(
    subPkgDu.name,
    'Deployment Unit: @acme/b',
    'Analyzing a sub-package inside a parent monorepo must resolve its workspace package name @acme/b'
  );
});

test('Single-Package Default & Explicit chomp.config.json Boundary Overrides (PAT-EXT-30): keeps single-package apps as 1 DEPLOYMENT_UNIT by default and decomposes only when configured', () => {
  // 1. Default single-package behavior (`fullstack-monolith-decomposition`, no `chomp.config.json`)
  const fullstackDir = path.join(
    process.cwd(),
    '..',
    '..',
    'fixtures',
    'test-repos',
    'fullstack-monolith-decomposition'
  );
  const fullstackGraph = analyzeTarget(fullstackDir);

  const duNames = fullstackGraph.nodes
    .filter(n => n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT')
    .map(n => n.name)
    .sort();
  assert.deepStrictEqual(duNames, ['Deployment Unit: fullstack-monolith-decomposition']);

  const initNodes = fullstackGraph.nodes.filter(
    n => n.type === 'BOUNDARY' && n.entityType === 'INIT_BLOCK'
  );
  assert.deepStrictEqual(
    initNodes.map(n => n.name),
    ['Init: fullstack-monolith-decomposition']
  );
  const initEvFiles = (
    Array.isArray(initNodes[0].evidence) ? initNodes[0].evidence : [initNodes[0].evidence]
  ).map(e => e.filePath);
  assert.ok(initEvFiles.includes('db/client.ts') && initEvFiles.includes('lib/orders.ts'));

  // Every call edge within the single deployment unit must resolve deterministically
  assert.ok(
    fullstackGraph.edges.every(e => Boolean(e.targetId)),
    'All calls in single-package full-stack graph must resolve targetId'
  );

  // 2. Configurable `boundaries` globs in `chomp.config.json` (`monolith-domains`)
  const monolithDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'monolith-domains');
  const monolithGraph = analyzeTarget(monolithDir);

  const monolithDuNames = monolithGraph.nodes
    .filter(n => n.type === 'BOUNDARY' && n.entityType === 'DEPLOYMENT_UNIT')
    .map(n => n.name)
    .sort();
  assert.deepStrictEqual(monolithDuNames, [
    'Deployment Unit: monolith-domains/public',
    'Deployment Unit: monolith-domains/topics',
    'Deployment Unit: monolith-domains/users',
  ]);

  const publicInit = monolithGraph.nodes.find(
    n => n.type === 'BOUNDARY' && n.entityType === 'INIT_BLOCK'
  );
  assert.ok(publicInit);
  assert.strictEqual(publicInit.name, 'Init: monolith-domains/public');
  assert.ok(monolithGraph.edges.every(e => Boolean(e.targetId)));

  // 3. Array & object `include` syntax in chomp.config.json boundaries
  const includeRules = parseUserBoundaryRules(
    {
      boundaries: [
        { name: 'api', include: ['src/api/**'] },
        { name: 'ui', include: 'src/components/**' },
      ],
    },
    'my-app'
  );
  assert.strictEqual(includeRules.length, 2);
  assert.strictEqual(includeRules[0].label, 'my-app/api');
  assert.ok(includeRules[0].matches('src/api/orders.ts'));
  assert.strictEqual(includeRules[1].label, 'my-app/ui');
  assert.ok(includeRules[1].matches('src/components/Button.tsx'));
});

test('Large-Monolith Extraction Performance, Vendor/Upgrade Exclusion & CommonJS Mixin Delegation (PAT-EXT-31)', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'cjs-mixin-delegation');
  const files = collectFiles(fixtureDir);
  const relFiles = files.map(f => path.relative(fixtureDir, f).replace(/\\/g, '/'));

  // 1. Default exclusion of upgrades/, vendor/, and *.min.js files
  assert.ok(!relFiles.some(f => f.includes('upgrades/')), 'collectFiles must exclude upgrades/ directory by default');
  assert.ok(!relFiles.some(f => f.includes('vendor/')), 'collectFiles must exclude vendor/ directory by default');
  assert.ok(!relFiles.some(f => f.endsWith('.min.js')), 'collectFiles must exclude *.min.js files by default');
  assert.deepStrictEqual(relFiles, [
    'src/api/index.js',
    'src/api/users.js',
    'src/controllers.js',
    'src/user/create.js',
    'src/user/index.js',
    'src/user/profile.js',
  ]);

  // 2. Per-SourceFile WeakMap declaration indexing returns the exact cached index instance
  const userIndexSf = getCachedSourceFile(path.join(fixtureDir, 'src/user/index.js'));
  assert.ok(userIndexSf, 'getCachedSourceFile must parse and cache src/user/index.js');
  const idx1 = getSourceFileDeclarationIndex(userIndexSf);
  const idx2 = getSourceFileDeclarationIndex(userIndexSf);
  assert.strictEqual(idx1, idx2, 'getSourceFileDeclarationIndex must memoize per ts.SourceFile');
  assert.ok(idx1.cjsExportAliases.has('User'), 'Index must record const User = module.exports alias');
  assert.deepStrictEqual(idx1.cjsMixinDelegations, ['./create', './profile']);

  // 3. CommonJS mixin delegation (`require('./create')(User)`), submodule property chains (`api.users.create`),
  //    and intra-mixin sibling delegation (`User.isDataValid` / `User.exists`)
  const graph = analyzeTarget(fixtureDir);
  const createUser = graph.nodes.find(n => n.name === 'CJS Export: createUser');
  const usersApiCreate = graph.nodes.find(n => n.name === 'CJS Export Alias: usersAPI.create');
  const userCreate = graph.nodes.find(n => n.name === 'CJS Export Alias: User.create');
  const userIsDataValid = graph.nodes.find(n => n.name === 'CJS Export Alias: User.isDataValid');
  const userExists = graph.nodes.find(n => n.name === 'CJS Export Alias: User.exists');
  assert.ok(createUser && usersApiCreate && userCreate && userIsDataValid && userExists);

  // controllers.createUser -> api.users.create -> usersAPI.create
  const apiCall = graph.edges.find(e => e.sourceId === createUser.id && e.targetId === usersApiCreate.id);
  assert.ok(apiCall, 'api.users.create() must resolve through src/api/index.js submodule property to usersAPI.create');

  // usersAPI.create -> user.create -> User.create (defined in src/user/create.js via require('./create')(User))
  const mixinCall = graph.edges.find(e => e.sourceId === usersApiCreate.id && e.targetId === userCreate.id);
  assert.ok(mixinCall, 'user.create() must resolve through require("./create")(User) mixin delegation to User.create');

  // User.create -> User.isDataValid (defined in sibling mixin src/user/profile.js) & User.exists (defined in src/user/index.js)
  const siblingMixinCall = graph.edges.find(e => e.sourceId === userCreate.id && e.targetId === userIsDataValid.id);
  const parentAliasCall = graph.edges.find(e => e.sourceId === userCreate.id && e.targetId === userExists.id);
  assert.ok(siblingMixinCall, 'User.isDataValid() inside mixin must resolve to sibling mixin contract');
  assert.ok(parentAliasCall, 'User.exists() inside mixin must resolve to parent index contract');
});

test('analyzeTarget resolves two-step factory calls and stamps sk1/CALL/LocalFromCall/Id (Finding 2)', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'invoke-returned-function');
  const graph = analyzeTarget(fixtureDir);

  const createHandler = graph.nodes.find(n => n.name === 'Exported Function: createHandler');
  const createLocalHandler = graph.nodes.find(n => n.name === 'Exported Function: createLocalHandler');
  const analyzerPkg = graph.nodes.find(n => n.name === 'Package: @next/bundle-analyzer');
  assert.ok(createHandler, 'Expected Exported Function: createHandler');
  assert.ok(createLocalHandler, 'Expected Exported Function: createLocalHandler');
  assert.ok(analyzerPkg, 'Expected Package: @next/bundle-analyzer');

  // 1. Cross-file imported factory: const handler = createHandler(); handler(req, res);
  const handlerCall = graph.edges.find(e => e.name === 'Call: handler()');
  assert.ok(handlerCall, 'Expected Call: handler() edge');
  assert.strictEqual(handlerCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(handlerCall.targetId, createHandler.id);
  assert.strictEqual(handlerCall.confidence, 'HIGH');
  assert.strictEqual(handlerCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Id');
  const handlerEvs = Array.isArray(handlerCall.evidence) ? handlerCall.evidence : [handlerCall.evidence];
  assert.strictEqual(handlerEvs.length, 3);
  assert.deepStrictEqual(handlerEvs.map(e => e.evidenceRole), ['syntax-call', 'import-match', 'target-signature']);

  // 2. Same-file exported factory: const localHandler = createLocalHandler(); localHandler(req, res);
  const localHandlerCall = graph.edges.find(e => e.name === 'Call: localHandler()');
  assert.ok(localHandlerCall, 'Expected Call: localHandler() edge');
  assert.strictEqual(localHandlerCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(localHandlerCall.targetId, createLocalHandler.id);
  assert.strictEqual(localHandlerCall.confidence, 'HIGH');
  assert.strictEqual(localHandlerCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Id');
  const localEvs = Array.isArray(localHandlerCall.evidence) ? localHandlerCall.evidence : [localHandlerCall.evidence];
  assert.strictEqual(localEvs.length, 3);
  assert.deepStrictEqual(localEvs.map(e => e.evidenceRole), ['syntax-call', 'import-match', 'target-signature']);

  // 3. Curried external package require: const withBundleAnalyzer = require('@next/bundle-analyzer')({ ... }); withBundleAnalyzer(nextConfig);
  const analyzerCall = graph.edges.find(e => e.name === 'Call: withBundleAnalyzer()');
  assert.ok(analyzerCall, 'Expected Call: withBundleAnalyzer() edge');
  assert.strictEqual(analyzerCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(analyzerCall.targetId, analyzerPkg.id);
  assert.strictEqual(analyzerCall.confidence, 'MEDIUM');
  assert.strictEqual(analyzerCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Id');
  const analyzerEvs = Array.isArray(analyzerCall.evidence) ? analyzerCall.evidence : [analyzerCall.evidence];
  assert.strictEqual(analyzerEvs.length, 2);
  assert.deepStrictEqual(analyzerEvs.map(e => e.evidenceRole), ['syntax-call', 'import-match']);

  // 4. Unexported same-file factory: const mw = getMiddleware(); mw(req, res); (honest unknown target)
  const mwCall = graph.edges.find(e => e.name === 'Call: mw()');
  assert.ok(mwCall, 'Expected Call: mw() edge');
  assert.strictEqual(mwCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(mwCall.targetId, undefined);
  assert.strictEqual(mwCall.confidence, 'LOW');
  assert.strictEqual(mwCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Id');
  const mwEvs = Array.isArray(mwCall.evidence) ? mwCall.evidence : [mwCall.evidence];
  assert.strictEqual(mwEvs.length, 2);
  assert.deepStrictEqual(mwEvs.map(e => e.evidenceRole), ['syntax-call', 'import-match']);

  // 5. Member call on LocalFromCall (`sk1/CALL/LocalFromCall/Prop(Id)`): handler.GET(req)
  const handlerGetCall = graph.edges.find(e => e.name === 'Call: handler.GET()');
  assert.ok(handlerGetCall, 'Expected Call: handler.GET() edge');
  assert.strictEqual(handlerGetCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(handlerGetCall.targetId, createHandler.id);
  assert.strictEqual(handlerGetCall.confidence, 'HIGH');
  assert.strictEqual(handlerGetCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Prop(Id)');
  const handlerGetEvs = Array.isArray(handlerGetCall.evidence) ? handlerGetCall.evidence : [handlerGetCall.evidence];
  assert.strictEqual(handlerGetEvs.length, 3);
  assert.deepStrictEqual(handlerGetEvs.map(e => e.evidenceRole), ['syntax-call', 'import-match', 'target-signature']);

  // 6. Chained property member call on LocalFromCall (`sk1/CALL/LocalFromCall/Prop(Prop(Id))`): handler.api.createOrg(req)
  const handlerCreateOrgCall = graph.edges.find(e => e.name === 'Call: handler.createOrg()');
  assert.ok(handlerCreateOrgCall, 'Expected Call: handler.createOrg() edge');
  assert.strictEqual(handlerCreateOrgCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(handlerCreateOrgCall.targetId, createHandler.id);
  assert.strictEqual(handlerCreateOrgCall.confidence, 'HIGH');
  assert.strictEqual(handlerCreateOrgCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Prop(Prop(Id))');
  const createOrgEvs = Array.isArray(handlerCreateOrgCall.evidence) ? handlerCreateOrgCall.evidence : [handlerCreateOrgCall.evidence];
  assert.strictEqual(createOrgEvs.length, 3);
  assert.deepStrictEqual(createOrgEvs.map(e => e.evidenceRole), ['syntax-call', 'import-match', 'target-signature']);

  // 7. Optional property member call on LocalFromCall (`sk1/CALL/LocalFromCall/OptProp(Id)`): localHandler?.execute(req)
  const localExecuteCall = graph.edges.find(e => e.name === 'Call: localHandler.execute()');
  assert.ok(localExecuteCall, 'Expected Call: localHandler.execute() edge');
  assert.strictEqual(localExecuteCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(localExecuteCall.targetId, createLocalHandler.id);
  assert.strictEqual(localExecuteCall.confidence, 'HIGH');
  assert.strictEqual(localExecuteCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/OptProp(Id)');
  const localExecEvs = Array.isArray(localExecuteCall.evidence) ? localExecuteCall.evidence : [localExecuteCall.evidence];
  assert.strictEqual(localExecEvs.length, 3);
  assert.deepStrictEqual(localExecEvs.map(e => e.evidenceRole), ['syntax-call', 'import-match', 'target-signature']);

  // 8. Member call on external package factory LocalFromCall (`sk1/CALL/LocalFromCall/Prop(Id)`): withBundleAnalyzer.apply(nextConfig)
  const analyzerApplyCall = graph.edges.find(e => e.name === 'Call: withBundleAnalyzer.apply()');
  assert.ok(analyzerApplyCall, 'Expected Call: withBundleAnalyzer.apply() edge');
  assert.strictEqual(analyzerApplyCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(analyzerApplyCall.targetId, analyzerPkg.id);
  assert.strictEqual(analyzerApplyCall.confidence, 'MEDIUM');
  assert.strictEqual(analyzerApplyCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Prop(Id)');
  const analyzerApplyEvs = Array.isArray(analyzerApplyCall.evidence) ? analyzerApplyCall.evidence : [analyzerApplyCall.evidence];
  assert.strictEqual(analyzerApplyEvs.length, 2);
  assert.deepStrictEqual(analyzerApplyEvs.map(e => e.evidenceRole), ['syntax-call', 'import-match']);
});

test('analyzeTarget does not misattribute chained array prototype methods (.filter, .map, .join) to the array producer function', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'function-calls');
  const graph = analyzeTarget(fixtureDir);

  const getProviders = graph.nodes.find(n => n.name === 'Exported Function: getProviders');
  assert.ok(getProviders, 'Expected Exported Function: getProviders');

  const directCall = graph.edges.find(e => e.name === 'Call: getProviders()');
  assert.ok(directCall, 'Expected Call: getProviders() edge');
  assert.strictEqual(directCall.targetId, getProviders.id);
  assert.strictEqual(directCall.confidence, 'HIGH');

  // 1. Chained array method call on LocalFromCall (`sk1/CALL/LocalFromCall/Prop(Call(Prop(Id)))`): providersToUse.map(...).join('')
  const joinCall = graph.edges.find(e => e.name === 'Call: providersToUse.join()');
  assert.ok(joinCall, 'Expected Call: providersToUse.join() edge');
  assert.strictEqual(joinCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(joinCall.targetId, undefined);
  assert.strictEqual(joinCall.confidence, 'LOW');
  assert.strictEqual(joinCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Prop(Call(Prop(Id)))');

  // 2. Chained map call on LocalFromCall (`sk1/CALL/LocalFromCall/Prop(Id)`): providersToUse.map(...)
  const mapCall = graph.edges.find(e => e.name === 'Call: providersToUse.map()');
  assert.ok(mapCall, 'Expected Call: providersToUse.map() edge');
  assert.strictEqual(mapCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(mapCall.targetId, undefined);
  assert.strictEqual(mapCall.confidence, 'LOW');
  assert.strictEqual(mapCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Prop(Id)');

  // 3. Chained filter call on LocalFromCall (`sk1/CALL/LocalFromCall/Prop(Id)`): providers.filter(...)
  const filterCall = graph.edges.find(e => e.name === 'Call: providers.filter()');
  assert.ok(filterCall, 'Expected Call: providers.filter() edge');
  assert.strictEqual(filterCall.patternId, 'relationship.invoke-returned-function');
  assert.strictEqual(filterCall.targetId, undefined);
  assert.strictEqual(filterCall.confidence, 'LOW');
  assert.strictEqual(filterCall.metadata?.shapeKey, 'sk1/CALL/LocalFromCall/Prop(Id)');
});

test('Styled-Components & React Context Contract Extraction & JSX Render Resolution: extracts styled.div, styled(BaseBtn), createGlobalStyle, and createContext as REACT_COMPONENT contracts and resolves <Wrapper> and <ThemeContext.Provider> renders', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'react-styled-context');
  const graph = analyzeTarget(fixtureDir);

  const wrapperNode = graph.nodes.find(
    n => n.type === 'CONTRACT' && n.name === 'React Component: Wrapper' && n.entityType === 'REACT_COMPONENT'
  );
  const myBtnNode = graph.nodes.find(
    n => n.type === 'CONTRACT' && n.name === 'React Component: MyBtn' && n.entityType === 'REACT_COMPONENT'
  );
  const globalStyleNode = graph.nodes.find(
    n => n.type === 'CONTRACT' && n.name === 'React Component: GlobalStyle' && n.entityType === 'REACT_COMPONENT'
  );
  const themeContextNode = graph.nodes.find(
    n => n.type === 'CONTRACT' && n.name === 'React Component: ThemeContext' && n.entityType === 'REACT_COMPONENT'
  );
  const appNode = graph.nodes.find(n => n.type === 'CONTRACT' && n.name === 'Exported Function: App');

  assert.ok(wrapperNode, 'Expected React Component: Wrapper contract');
  assert.strictEqual(wrapperNode.patternId, 'contract.react-functional-component');
  assert.ok(myBtnNode, 'Expected React Component: MyBtn contract');
  assert.strictEqual(myBtnNode.patternId, 'contract.react-functional-component');
  assert.ok(globalStyleNode, 'Expected React Component: GlobalStyle contract');
  assert.strictEqual(globalStyleNode.patternId, 'contract.react-functional-component');
  assert.ok(themeContextNode, 'Expected React Component: ThemeContext contract');
  assert.strictEqual(themeContextNode.patternId, 'contract.react-functional-component');
  assert.ok(appNode, 'Expected Exported Function: App contract');

  const wrapperRender = graph.edges.find(
    e => e.sourceId === appNode.id && e.entityType === 'RENDERS' && e.name === 'Renders: <Wrapper />'
  );
  assert.ok(wrapperRender, 'Expected Renders: <Wrapper /> edge');
  assert.strictEqual(wrapperRender.targetId, wrapperNode.id);
  assert.strictEqual(wrapperRender.metadata?.shapeKey, 'sk1/RENDERS/Import/Id');

  const myBtnRender = graph.edges.find(
    e => e.sourceId === appNode.id && e.entityType === 'RENDERS' && e.name === 'Renders: <MyBtn />'
  );
  assert.ok(myBtnRender, 'Expected Renders: <MyBtn /> edge');
  assert.strictEqual(myBtnRender.targetId, myBtnNode.id);
  assert.strictEqual(myBtnRender.metadata?.shapeKey, 'sk1/RENDERS/Import/Id');

  const providerRender = graph.edges.find(
    e => e.sourceId === appNode.id && e.entityType === 'RENDERS' && e.name === 'Renders: <ThemeContext.Provider />'
  );
  assert.ok(providerRender, 'Expected Renders: <ThemeContext.Provider /> edge');
  assert.strictEqual(providerRender.targetId, themeContextNode.id);
  assert.strictEqual(providerRender.metadata?.shapeKey, 'sk1/RENDERS/Import/Prop(Id)');
});

test('Next.js App Router Lifecycle Exports (jules-2026-11-03-08): generateMetadata and generateStaticParams in page/layout files extract as INGRESS NEXTJS_PAGE contracts, not orphan EXPORTED_FUNCTIONs', () => {
  const relPath = 'app/blog/[slug]/page.tsx';
  const fileRole = classifyNextjsFile(relPath);
  assert.strictEqual(fileRole, 'PAGE');

  const code = `
    export async function generateMetadata({ params }: { params: { slug: string } }) {
      return { title: params.slug };
    }
    export const generateStaticParams = async () => {
      return [{ slug: 'intro' }];
    };
    export default function BlogPostPage() {
      return <main>Post</main>;
    }
  `;
  const sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const getEv = (n: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { filePath: relPath, lineNumber: line + 1, snippet: n.getText(sf).slice(0, 60) };
  };

  const contracts: any[] = [];
  const walk = (n: ts.Node) => {
    const res = visitContract(n, sf, getEv, () => '', fileRole, relPath);
    const list = Array.isArray(res) ? res : res ? [res] : [];
    for (const c of list) {
      c.id = stableEntityId('unit:app', 'CONTRACT', c.name);
      contracts.push(c);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);

  assert.strictEqual(contracts.length, 3);
  const metaContract = contracts.find(c => c.name === 'Next.js Lifecycle: generateMetadata (/blog/[slug])');
  const staticParamsContract = contracts.find(c => c.name === 'Next.js Lifecycle: generateStaticParams (/blog/[slug])');
  const pageContract = contracts.find(c => c.name === 'Next.js Page: /blog/[slug]');

  assert.ok(metaContract, 'Expected generateMetadata lifecycle contract');
  assert.strictEqual(metaContract.entityType, 'NEXTJS_PAGE');
  assert.strictEqual(metaContract.patternId, 'boundary.nextjs-page-component');
  assert.strictEqual(metaContract.metadata?.flowRole, 'INGRESS');

  assert.ok(staticParamsContract, 'Expected generateStaticParams lifecycle contract');
  assert.strictEqual(staticParamsContract.entityType, 'NEXTJS_PAGE');
  assert.strictEqual(staticParamsContract.patternId, 'boundary.nextjs-page-component');
  assert.strictEqual(staticParamsContract.metadata?.flowRole, 'INGRESS');

  assert.ok(pageContract, 'Expected Next.js Page contract');
  assert.ok(
    !contracts.some(c => c.entityType === 'EXPORTED_FUNCTION'),
    'Lifecycle exports in page.tsx must not fall through to generic EXPORTED_FUNCTION'
  );

  const orphanRows = measureOrphanShapeResolution({ nodes: contracts, edges: [] });
  assert.strictEqual(
    orphanRows.reduce((acc, r) => acc + r.unresolved, 0),
    0,
    'Next.js lifecycle exports must be counted as resolved INGRESS contracts with 0 orphans'
  );
});

test('Same-File Static Class Method Calls (sk1/CALL/LocalClass/Prop(Id)): User.generateId() resolves targetId to Public Method: User.generateId with target-signature evidence', () => {
  const repoRoot = '/repo';
  const absFile = '/repo/src/models/User.ts';
  const relPath = 'src/models/User.ts';
  const code = `
    export class User {
      static generateId(): string {
        return 'usr_123';
      }
      static async create(): Promise<string> {
        const id = User.generateId();
        return id;
      }
    }
  `;
  const sf = ts.createSourceFile(absFile, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const getEv = (n: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { filePath: relPath, lineNumber: line + 1, snippet: n.getText(sf).slice(0, 60) };
  };
  const scope = resolveLogicalBoundaryScope(relPath, repoRoot);

  const contracts: any[] = [];
  const edges: any[] = [];
  const walk = (n: ts.Node) => {
    const cRes = visitContract(n, sf, getEv, () => '', null, relPath);
    const cList = Array.isArray(cRes) ? cRes : cRes ? [cRes] : [];
    for (const c of cList) {
      c.id = stableEntityId(scope, 'CONTRACT', c.name);
      contracts.push(c);
    }
    const rRes = visitRelationship(n, sf, getEv, () => 'edge-1', repoRoot, 'src-owner');
    const rList = Array.isArray(rRes) ? rRes : rRes ? [rRes] : [];
    edges.push(...rList);
    ts.forEachChild(n, walk);
  };
  walk(sf);

  const genIdMethod = contracts.find(c => c.name === 'Public Method: User.generateId');
  assert.ok(genIdMethod, 'Expected Public Method: User.generateId contract');

  const staticCall = edges.find(e => e.name === 'Call: User.generateId()');
  assert.ok(staticCall, 'Expected Call: User.generateId() relationship');
  assert.strictEqual(staticCall.targetId, genIdMethod.id, 'User.generateId() must resolve targetId to Public Method: User.generateId');
  assert.strictEqual(staticCall.confidence, 'HIGH');
  assert.strictEqual(staticCall.metadata?.shapeKey, 'sk1/CALL/LocalClass/Prop(Id)');
  const evs = Array.isArray(staticCall.evidence) ? staticCall.evidence : [staticCall.evidence];
  assert.deepStrictEqual(
    evs.map((e: any) => e.evidenceRole),
    ['syntax-call', 'target-signature'],
    'Resolved same-file static class method call must carry syntax-call and target-signature evidence'
  );
});

test('Deferred Same-File Export Function Calls (jules-2026-11-03-01, sk1/CALL/LocalFunction/Id): resolves calls to functions exported via export { fn } and export default fn', () => {
  const repoRoot = '/repo';

  // Case 1: `function helper() {}` and `const arrowHelper = () => {}` exported later via `export { helper, arrowHelper }`
  const absNamedFile = '/repo/src/utils/named.ts';
  const relNamedPath = 'src/utils/named.ts';
  const namedCode = `
    function helper() {
      return 1;
    }
    const arrowHelper = () => {
      return 2;
    };
    export function runAll() {
      return helper() + arrowHelper();
    }
    export { helper, arrowHelper };
  `;
  const namedSf = ts.createSourceFile(absNamedFile, namedCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const getNamedEv = (n: ts.Node) => {
    const { line } = namedSf.getLineAndCharacterOfPosition(n.getStart(namedSf));
    return { filePath: relNamedPath, lineNumber: line + 1, snippet: n.getText(namedSf).slice(0, 60) };
  };
  const namedScope = resolveLogicalBoundaryScope(relNamedPath, repoRoot);

  const namedContracts: any[] = [];
  const namedEdges: any[] = [];
  const walkNamed = (n: ts.Node) => {
    const cRes = visitContract(n, namedSf, getNamedEv, () => '', null, relNamedPath);
    const cList = Array.isArray(cRes) ? cRes : cRes ? [cRes] : [];
    for (const c of cList) {
      c.id = stableEntityId(namedScope, 'CONTRACT', c.name);
      namedContracts.push(c);
    }
    const rRes = visitRelationship(n, namedSf, getNamedEv, () => 'edge', repoRoot, 'src-owner');
    const rList = Array.isArray(rRes) ? rRes : rRes ? [rRes] : [];
    namedEdges.push(...rList);
    ts.forEachChild(n, walkNamed);
  };
  walkNamed(namedSf);

  const helperContract = namedContracts.find(c => c.name === 'Exported Function: helper');
  const arrowHelperContract = namedContracts.find(c => c.name === 'Exported Function: arrowHelper');
  assert.ok(helperContract && arrowHelperContract, 'Expected deferred export { helper, arrowHelper } contracts');

  const helperCall = namedEdges.find(e => e.name === 'Call: helper()');
  const arrowHelperCall = namedEdges.find(e => e.name === 'Call: arrowHelper()');
  assert.ok(helperCall && arrowHelperCall);
  assert.strictEqual(helperCall.targetId, helperContract.id);
  assert.strictEqual(helperCall.metadata?.shapeKey, 'sk1/CALL/LocalFunction/Id');
  assert.strictEqual(arrowHelperCall.targetId, arrowHelperContract.id);
  assert.strictEqual(arrowHelperCall.metadata?.shapeKey, 'sk1/CALL/LocalFunction/Id');

  // Case 2: `function defaultHelper() {}` exported later via `export default defaultHelper`
  const absDefaultFile = '/repo/src/utils/defaultExport.ts';
  const relDefaultPath = 'src/utils/defaultExport.ts';
  const defaultCode = `
    function defaultHelper() {
      return 42;
    }
    export function invokeDefault() {
      return defaultHelper();
    }
    export default defaultHelper;
  `;
  const defaultSf = ts.createSourceFile(absDefaultFile, defaultCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const getDefaultEv = (n: ts.Node) => {
    const { line } = defaultSf.getLineAndCharacterOfPosition(n.getStart(defaultSf));
    return { filePath: relDefaultPath, lineNumber: line + 1, snippet: n.getText(defaultSf).slice(0, 60) };
  };
  const defaultScope = resolveLogicalBoundaryScope(relDefaultPath, repoRoot);

  const defaultContracts: any[] = [];
  const defaultEdges: any[] = [];
  const ownerByNode = new Map<ts.Node, string>();
  const walkDefault = (n: ts.Node) => {
    const cRes = visitContract(n, defaultSf, getDefaultEv, () => '', null, relDefaultPath);
    const cList = Array.isArray(cRes) ? cRes : cRes ? [cRes] : [];
    for (const c of cList) {
      c.id = contractEntityId(defaultScope, relDefaultPath, c.name, c.patternId);
      defaultContracts.push(c);
    }
    if (cList.length === 1) ownerByNode.set(n, cList[0].id);
    const rRes = visitRelationship(n, defaultSf, getDefaultEv, () => 'edge', repoRoot, 'src-owner');
    const rList = Array.isArray(rRes) ? rRes : rRes ? [rRes] : [];
    defaultEdges.push(...rList);
    ts.forEachChild(n, walkDefault);
  };
  walkDefault(defaultSf);
  propagateLocalHelperOwners(defaultSf, ownerByNode);

  const defaultExportContract = defaultContracts.find(c => c.name === 'Module Export (Default)');
  assert.ok(defaultExportContract, 'Expected Module Export (Default) contract');

  const defaultCall = defaultEdges.find(e => e.name === 'Call: defaultHelper()');
  assert.ok(defaultCall, 'Expected Call: defaultHelper() edge');
  assert.strictEqual(defaultCall.targetId, defaultExportContract.id, 'defaultHelper() must resolve to Module Export (Default) contract');
  assert.strictEqual(defaultCall.confidence, 'HIGH');
  assert.strictEqual(defaultCall.metadata?.shapeKey, 'sk1/CALL/LocalFunction/Id');
  const defaultEvs = Array.isArray(defaultCall.evidence) ? defaultCall.evidence : [defaultCall.evidence];
  assert.deepStrictEqual(defaultEvs.map((e: any) => e.evidenceRole), ['syntax-call', 'target-signature']);

  // Verify defaultHelper AST node ownership is assigned to Module Export (Default), not hijacked by invokeDefault
  const defaultHelperStmt = defaultSf.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'defaultHelper')!;
  assert.strictEqual(ownerByNode.get(defaultHelperStmt), defaultExportContract.id);
});

test('Import Target-Kind Splitting (PAT-EXT-27): splits Import/Prop(Id) into ImportObject, ImportNamespace, ImportClass, and Import', () => {
  // 1. ImportObject: imported symbol resolves to an exported object literal (`fixtures/test-repos/payload-collection/index.ts`)
  const payloadDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'payload-collection');
  const objCallerSf = ts.createSourceFile(
    path.join(payloadDir, 'caller.ts'),
    `import { Posts } from './index';\nexport function run() { Posts.validate(); }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const objKeys: string[] = [];
  const walkObj = (n: ts.Node) => {
    const k = computeCallShapeKey(n, { repoRoot: payloadDir });
    if (k) objKeys.push(k);
    ts.forEachChild(n, walkObj);
  };
  walkObj(objCallerSf);
  assert.deepStrictEqual(objKeys, ['sk1/CALL/ImportObject/Prop(Id)']);

  // 2. ImportClass & ImportNamespace: imported symbol resolves to an exported class or namespace import (`fixtures/test-repos/sample-app/userService.ts`)
  const sampleDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'sample-app');
  const classAndNsSf = ts.createSourceFile(
    path.join(sampleDir, 'caller.ts'),
    `import { UserService } from './userService';\nimport * as userNs from './userService';\nexport function run() { UserService.authenticate(); userNs.authenticate(); }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const classAndNsKeys: string[] = [];
  const walkClassNs = (n: ts.Node) => {
    const k = computeCallShapeKey(n, { repoRoot: sampleDir });
    if (k) classAndNsKeys.push(k);
    ts.forEachChild(n, walkClassNs);
  };
  walkClassNs(classAndNsSf);
  assert.deepStrictEqual(classAndNsKeys, [
    'sk1/CALL/ImportClass/Prop(Id)',
    'sk1/CALL/ImportNamespace/Prop(Id)',
  ]);

  // 3. Import: imported symbol resolves to an exported function (`fixtures/test-repos/function-calls/math.ts`)
  const fnDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'function-calls');
  const fnGraph = analyzeTarget(fnDir);
  const sumCall = fnGraph.edges.find(e => e.name === 'Call: calculateSum()');
  assert.ok(sumCall);
  assert.strictEqual(sumCall.metadata?.shapeKey, 'sk1/CALL/Import/Id');
});

test('CommonJS require() Parity in Unresolved Connection Reconciliation & Actionable Diagnostics: emits MEDIUM relationship.member-call on unresolved intra-repo require() and reconciles require() bindings', () => {
  // 1. Resolved intra-repo require() calls in `cjs-mixin-delegation` mark target contracts as `isImportedInRepo: true` with 0 unresolved refs
  const cjsMixinDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'cjs-mixin-delegation');
  const baseGraph = analyzeTarget(cjsMixinDir);
  const usersApiCreate = baseGraph.nodes.find(n => n.name === 'CJS Export Alias: usersAPI.create');
  const userCreate = baseGraph.nodes.find(n => n.name === 'CJS Export Alias: User.create');
  assert.ok(usersApiCreate && userCreate);
  assert.strictEqual(usersApiCreate.metadata?.isImportedInRepo, true, 'usersAPI.create required via ./api -> ./users must be marked isImportedInRepo');
  assert.strictEqual(userCreate.metadata?.isImportedInRepo, true, 'User.create required via ../user -> ./create mixin must be marked isImportedInRepo');
  assert.strictEqual(usersApiCreate.metadata?.unresolvedOutgoing, undefined);
  assert.strictEqual(userCreate.metadata?.unresolvedIncoming, undefined);

  // 2. Unresolved member call on an intra-repo require('./...') binding (`user.missingHelper()`)
  //    emits `relationship.member-call` (`confidence: 'MEDIUM'`, `metadata.unresolvedReason = 'unextracted-target-contract'`)
  //    rather than falling through to `LOW`-confidence `relationship.invoke-returned-function`,
  //    and `reconcileUnresolvedConnections` records `unresolvedOutgoing` and `unresolvedIncoming`.
  const callerRelPath = 'src/api/caller.js';
  const callerAbsPath = path.join(cjsMixinDir, callerRelPath);
  const callerCode = `
    'use strict';
    const user = require('../user');
    const { isDataValid } = require('../user');
    exports.runCaller = async function (data) {
      await user.missingHelper(data);
      registerHook(user.exists);
    };
  `;
  const callerSf = ts.createSourceFile(callerAbsPath, callerCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const getEv = (n: ts.Node) => {
    const { line } = callerSf.getLineAndCharacterOfPosition(n.getStart(callerSf));
    return { filePath: callerRelPath, lineNumber: line + 1, snippet: n.getText(callerSf).slice(0, 80).replace(/\s+/g, ' ').trim() };
  };

  const callerId = 'caller-contract-id';
  const callerNode: any = {
    id: callerId,
    name: 'CJS Export: runCaller',
    type: 'CONTRACT',
    entityType: 'EXPORTED_FUNCTION',
    patternId: 'contract.commonjs-export',
    scope: 'USER',
    evidence: [{ filePath: callerRelPath, lineNumber: 5, snippet: 'exports.runCaller = async function (data)' }],
  };

  const callerEdges: any[] = [];
  const ownerByNode = new Map<ts.Node, string>();
  const walkCaller = (n: ts.Node) => {
    if (ts.isFunctionExpression(n)) {
      ownerByNode.set(n, callerId);
    }
    const rRes = visitRelationship(n, callerSf, getEv, () => 'edge-cjs-1', cjsMixinDir, callerId);
    const rList = Array.isArray(rRes) ? rRes : rRes ? [rRes] : [];
    callerEdges.push(...rList);
    ts.forEachChild(n, walkCaller);
  };
  walkCaller(callerSf);

  const missingHelperEdge = callerEdges.find(e => e.name === 'Call: user.missingHelper()');
  assert.ok(missingHelperEdge, 'Expected Call: user.missingHelper() edge');
  assert.strictEqual(missingHelperEdge.patternId, 'relationship.member-call', 'Intra-repo unresolved require() member call must emit relationship.member-call');
  assert.strictEqual(missingHelperEdge.confidence, 'MEDIUM', 'Intra-repo unresolved require() member call must have MEDIUM confidence');
  assert.strictEqual(missingHelperEdge.targetId, undefined);
  assert.strictEqual(missingHelperEdge.metadata?.unresolvedReason, 'unextracted-target-contract');
  assert.strictEqual(missingHelperEdge.metadata?.shapeKey, 'sk1/CALL/LocalRequire/Prop(Id)');

  // Verify `classifyNodeUnresolvedCalls` & `clusterSignalInstances` surface the unresolved CJS call
  const nodes = [...baseGraph.nodes.map(n => ({ ...n, metadata: { ...n.metadata } })), callerNode];
  const edges = [...baseGraph.edges, ...callerEdges];
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const actionableCalls = classifyNodeUnresolvedCalls(callerId, { nodes, edges }, nodeById);
  const missingHelperDiag = actionableCalls.find(c => c.name === 'user.missingHelper()');
  assert.ok(missingHelperDiag, 'classifyNodeUnresolvedCalls must surface MEDIUM relationship.member-call on intra-repo require');
  assert.strictEqual(missingHelperDiag.confidence, 'MEDIUM');
  assert.strictEqual(missingHelperDiag.shapeKey, 'sk1/CALL/LocalRequire/Prop(Id)');
  assert.strictEqual(missingHelperDiag.unresolvedReason, 'unextracted-target-contract');

  const clusterReport = clusterSignalInstances(
    actionableCalls.map(c => ({
      nodeId: callerId,
      name: c.name,
      shapeKey: c.shapeKey,
      signal: 'UNRESOLVED_CALL' as const,
      filePath: c.filePath,
      lineNumber: c.lineNumber,
    }))
  );
  assert.ok(
    clusterReport.clusters.some(c => c.shapeKey === 'sk1/CALL/LocalRequire/Prop(Id)' && c.instanceCount === 1),
    'clusterSignalInstances must cluster the unresolved CommonJS require member call under sk1/CALL/LocalRequire/Prop(Id)'
  );

  // Verify `reconcileUnresolvedConnections` populates `unresolvedOutgoing` and `unresolvedIncoming` for require()
  const userIndexSf = getCachedSourceFile(path.join(cjsMixinDir, 'src/user/index.js'))!;
  const userCreateSf = getCachedSourceFile(path.join(cjsMixinDir, 'src/user/create.js'))!;
  const userProfileSf = getCachedSourceFile(path.join(cjsMixinDir, 'src/user/profile.js'))!;
  const duId = nodes.find(n => n.entityType === 'DEPLOYMENT_UNIT')!.id;

  reconcileUnresolvedConnections(
    [
      {
        sourceFile: userIndexSf,
        filePath: path.join(cjsMixinDir, 'src/user/index.js'),
        relativePath: 'src/user/index.js',
        scope: 'USER',
        ownerByNode: new Map(),
        unitId: duId,
        getInitId: () => undefined,
      },
      {
        sourceFile: userCreateSf,
        filePath: path.join(cjsMixinDir, 'src/user/create.js'),
        relativePath: 'src/user/create.js',
        scope: 'USER',
        ownerByNode: new Map(),
        unitId: duId,
        getInitId: () => undefined,
      },
      {
        sourceFile: userProfileSf,
        filePath: path.join(cjsMixinDir, 'src/user/profile.js'),
        relativePath: 'src/user/profile.js',
        scope: 'USER',
        ownerByNode: new Map(),
        unitId: duId,
        getInitId: () => undefined,
      },
      {
        sourceFile: callerSf,
        filePath: callerAbsPath,
        relativePath: callerRelPath,
        scope: 'USER',
        ownerByNode,
        unitId: duId,
        getInitId: () => undefined,
      },
    ],
    nodes,
    edges,
    cjsMixinDir,
    {}
  );

  const outgoing = callerNode.metadata?.unresolvedOutgoing as any[] | undefined;
  assert.ok(Array.isArray(outgoing) && outgoing.length >= 2, 'Expected unresolvedOutgoing on callerNode');
  const unextractedOut = outgoing.find(o => o.targetSymbol === 'missingHelper');
  assert.ok(unextractedOut, 'Expected unresolvedOutgoing for user.missingHelper()');
  assert.strictEqual(unextractedOut.reason, 'unextracted-target-contract');
  assert.strictEqual(unextractedOut.importSpecifier, '../user');
  assert.strictEqual(unextractedOut.resolvedFilePath, 'src/user/index.js');
  assert.strictEqual(unextractedOut.usageKind, 'call');

  const unlinkedOut = outgoing.find(o => o.targetSymbol === 'exists');
  assert.ok(unlinkedOut, 'Expected unresolvedOutgoing for unlinked callback arg user.exists');
  assert.strictEqual(unlinkedOut.reason, 'unlinked-import-reference');

  const userExistsNode = nodes.find(n => n.name === 'CJS Export Alias: User.exists')!;
  const existsIncoming = userExistsNode.metadata?.unresolvedIncoming as any[] | undefined;
  assert.ok(
    Array.isArray(existsIncoming) && existsIncoming.some(i => i.callerId === callerId && i.reason === 'unlinked-import-reference'),
    'User.exists must record unresolvedIncoming from callerNode'
  );

  const userIsDataValidNode = nodes.find(n => n.name === 'CJS Export Alias: User.isDataValid')!;
  const validIncoming = userIsDataValidNode.metadata?.unresolvedIncoming as any[] | undefined;
  assert.ok(
    Array.isArray(validIncoming) && validIncoming.some(i => i.filePath === callerRelPath && i.reason === 'imported-but-never-invoked'),
    'Unused destructured require { isDataValid } must record imported-but-never-invoked on User.isDataValid'
  );
});

test('reconcileUnresolvedConnections excludes scalar, RegExp, Set, and pure-data constant imports from unresolvedOutgoing', () => {
  const sampleDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'sample-app');
  const constantsRel = 'userService.ts';
  const constantsAbs = path.join(sampleDir, constantsRel);
  const constantsCode = `
    export const ROW_HEIGHT = 54;
    export const NODE_WIDTH = 160;
    export const LABEL_PREFIX_RE = /^(?:Exported Function|Public Method):\\s*/i;
    export const INGRESS_ENTITY_TYPES = new Set(['HTTP_ENDPOINT', 'API_ENDPOINT']);
    export const EXPRESS_CONVENTIONS = [
      { id: 'express.route', label: 'Express Route', target: 'HTTP_ENDPOINT' },
    ];
  `;
  const constantsSf = ts.createSourceFile(constantsAbs, constantsCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const callerRel = 'layout.ts';
  const callerAbs = path.join(sampleDir, callerRel);
  const callerCode = `
    import {
      ROW_HEIGHT,
      NODE_WIDTH,
      LABEL_PREFIX_RE,
      INGRESS_ENTITY_TYPES,
      EXPRESS_CONVENTIONS,
      unextractedHelper,
    } from './userService';

    export function computeBox(kind: string, label: string): number {
      const clean = label.replace(LABEL_PREFIX_RE, '');
      if (INGRESS_ENTITY_TYPES.has(kind) && EXPRESS_CONVENTIONS.length > 0 && clean) {
        return ROW_HEIGHT + NODE_WIDTH + unextractedHelper;
      }
      return 0;
    }
  `;
  const callerSf = ts.createSourceFile(callerAbs, callerCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const callerId = 'contract-compute-box';
  const callerNode: any = {
    id: callerId,
    name: 'Exported Function: computeBox',
    type: 'CONTRACT',
    entityType: 'EXPORTED_FUNCTION',
    patternId: 'contract.exported-function',
    scope: 'USER',
    evidence: [{ filePath: callerRel, lineNumber: 11, snippet: 'export function computeBox' }],
  };
  const ownerByNode = new Map<ts.Node, string>();
  for (const stmt of callerSf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      ownerByNode.set(stmt, callerId);
    }
  }

  reconcileUnresolvedConnections(
    [
      {
        sourceFile: constantsSf,
        filePath: constantsAbs,
        relativePath: constantsRel,
        scope: 'USER',
        ownerByNode: new Map(),
        unitId: 'du-root',
        getInitId: () => undefined,
      },
      {
        sourceFile: callerSf,
        filePath: callerAbs,
        relativePath: callerRel,
        scope: 'USER',
        ownerByNode,
        unitId: 'du-root',
        getInitId: () => undefined,
      },
    ],
    [callerNode],
    [],
    sampleDir,
    {}
  );

  const outgoing = (callerNode.metadata?.unresolvedOutgoing ?? []) as any[];
  assert.strictEqual(
    outgoing.length,
    1,
    'Scalar, RegExp, Set, and pure-data array constants must be excluded from unresolvedOutgoing'
  );
  assert.strictEqual(outgoing[0].targetSymbol, 'unextractedHelper');
  assert.strictEqual(outgoing[0].reason, 'unextracted-target-contract');
});

test('reconcileUnresolvedConnections excludes static asset imports (.svg, .png, .css) from unresolvedOutgoing unextracted-target-contract', () => {
  const sampleDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'sample-app');
  const callerRel = 'HeroComponent.tsx';
  const callerAbs = path.join(sampleDir, callerRel);
  const callerCode = `
    import logo from './logo.svg';
    import heroImg from './hero.png';
    import styles from './styles.css';
    import missingImage from './missing.webp';
    import { missingHelper } from './userService';

    export function HeroComponent(): any {
      return {
        logo,
        hero: heroImg,
        className: styles,
        missing: missingImage,
        fn: missingHelper(),
      };
    }
  `;
  const callerSf = ts.createSourceFile(callerAbs, callerCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const callerId = 'contract-hero-component';
  const callerNode: any = {
    id: callerId,
    name: 'Exported Function: HeroComponent',
    type: 'CONTRACT',
    entityType: 'EXPORTED_FUNCTION',
    patternId: 'contract.exported-function',
    scope: 'USER',
    evidence: [{ filePath: callerRel, lineNumber: 8, snippet: 'export function HeroComponent' }],
  };
  const ownerByNode = new Map<ts.Node, string>();
  for (const stmt of callerSf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      ownerByNode.set(stmt, callerId);
    }
  }

  reconcileUnresolvedConnections(
    [
      {
        sourceFile: callerSf,
        filePath: callerAbs,
        relativePath: callerRel,
        scope: 'USER',
        ownerByNode,
        unitId: 'du-root',
        getInitId: () => undefined,
      },
    ],
    [callerNode],
    [],
    sampleDir,
    {}
  );

  const outgoing = (callerNode.metadata?.unresolvedOutgoing ?? []) as any[];
  // Static asset imports (.svg, .png, .css, .webp) must NEVER be recorded as unextracted-target-contract
  const unextractedTargets = outgoing.filter((o) => o.reason === 'unextracted-target-contract');
  assert.strictEqual(
    unextractedTargets.length,
    1,
    'Only the missing code contract (missingHelper) should be recorded as unextracted-target-contract'
  );
  assert.strictEqual(unextractedTargets[0].targetSymbol, 'missingHelper');
  assert.strictEqual(unextractedTargets[0].importSpecifier, './userService');

  // Ensure no static asset import is recorded under unresolvedOutgoing
  const staticAssetOutgoing = outgoing.filter(
    (o) =>
      o.importSpecifier === './logo.svg' ||
      o.importSpecifier === './hero.png' ||
      o.importSpecifier === './styles.css' ||
      o.importSpecifier === './missing.webp'
  );
  assert.strictEqual(
    staticAssetOutgoing.length,
    0,
    'Static asset imports must not produce any unresolvedOutgoing entries'
  );
});

test('Deferred Default Export of Local Function / React Component & HOC Variable: extracts forwardRef/arrow default exports and resolves default import alias mismatches', () => {
  const hocFixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'react-hoc-components');
  const graph = analyzeTarget(hocFixtureDir, '0.1.0');

  const contracts = graph.nodes.filter((n) => n.type === 'CONTRACT');
  const buttonContract = contracts.find((c) => c.name === 'Exported Function: Button');
  const tileContract = contracts.find((c) => c.name === 'Exported Function: Tile');
  const homeContactContract = contracts.find((c) => c.name === 'Exported Function: HomeContact');
  const appContract = contracts.find((c) => c.name === 'Exported Function: App');
  const formatContract = contracts.find((c) => c.name === 'Exported Function: format');

  assert.ok(buttonContract, 'Expected Exported Function: Button contract from const Button = React.forwardRef(...); export default Button;');
  assert.strictEqual(buttonContract.patternId, 'contract.react-hoc-wrapped-component');
  assert.ok(tileContract, 'Expected Exported Function: Tile contract from const Tile = () => <div />; export default Tile;');
  assert.strictEqual(tileContract.patternId, 'contract.exported-function');
  assert.ok(homeContactContract, 'Expected Exported Function: HomeContact contract from const HomeContact = () => <section />; export default HomeContact;');
  assert.ok(appContract && formatContract);

  // Must not emit redundant Module Export (Default) contracts for deferred-default component/HOC variables
  assert.strictEqual(
    contracts.some((c) => c.name === 'Module Export (Default)'),
    false,
    'Expected no redundant Module Export (Default) contract'
  );

  // Calls inside Button and Tile must be owned by their respective component contracts
  assert.ok(
    graph.edges.some(
      (e) =>
        e.name === 'Call: format()' &&
        e.sourceId === buttonContract.id &&
        e.targetId === formatContract.id
    ),
    'Expected Call: format() inside forwardRef Button to be owned by Exported Function: Button'
  );
  assert.ok(
    graph.edges.some(
      (e) =>
        e.name === 'Call: format()' &&
        e.sourceId === tileContract.id &&
        e.targetId === formatContract.id
    ),
    'Expected Call: format() inside Tile to be owned by Exported Function: Tile'
  );

  // Default import renders (<Button />, <Tile />, and alias-mismatched <Contact /> -> HomeContact) must resolve
  const buttonRenderFromContact = graph.edges.find(
    (e) => e.name === 'Renders: <Button />' && e.sourceId === homeContactContract.id
  );
  assert.ok(buttonRenderFromContact);
  assert.strictEqual(buttonRenderFromContact.targetId, buttonContract.id);

  const buttonRenderFromApp = graph.edges.find(
    (e) => e.name === 'Renders: <Button />' && e.sourceId === appContract.id
  );
  assert.ok(buttonRenderFromApp);
  assert.strictEqual(buttonRenderFromApp.targetId, buttonContract.id);

  const tileRenderFromApp = graph.edges.find(
    (e) => e.name === 'Renders: <Tile />' && e.sourceId === appContract.id
  );
  assert.ok(tileRenderFromApp);
  assert.strictEqual(tileRenderFromApp.targetId, tileContract.id);

  const contactRenderFromApp = graph.edges.find(
    (e) => e.name === 'Renders: <Contact />' && e.sourceId === appContract.id
  );
  assert.ok(contactRenderFromApp, 'Expected Renders: <Contact /> edge from App');
  assert.strictEqual(
    contactRenderFromApp.targetId,
    homeContactContract.id,
    'Default import alias Contact must resolve to default-exported HomeContact contract'
  );
});

test('React.cache and cache(...) wrapped function exports extract EXPORTED_FUNCTION contracts, own inner calls, and resolve cross-file callers', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'react-cache-function');
  const graph = analyzeTarget(fixtureDir);

  const getServerSession = graph.nodes.find((n) => n.name === 'Exported Function: getServerSession');
  const getCachedProfile = graph.nodes.find((n) => n.name === 'Exported Function: getCachedProfile');
  const getDeferredSession = graph.nodes.find((n) => n.name === 'Exported Function: getDeferredSession');
  const getDefaultSession = graph.nodes.find((n) => n.name === 'Exported Function: getDefaultSession');
  const readCookies = graph.nodes.find((n) => n.name === 'Exported Function: readCookies');
  const verifyToken = graph.nodes.find((n) => n.name === 'Exported Function: verifyToken');
  const privateRoute = graph.nodes.find((n) => n.name === 'Exported Function: PrivateRoute');

  assert.ok(getServerSession, 'Expected Exported Function: getServerSession for export const getServerSession = cache(...)');
  assert.strictEqual(getServerSession.entityType, 'EXPORTED_FUNCTION');
  assert.strictEqual(getServerSession.patternId, 'contract.exported-function');
  assert.deepStrictEqual(getServerSession.metadata?.inputTypes, ['AuthToken']);
  assert.strictEqual(getServerSession.metadata?.outputType, 'SessionPayload');

  assert.ok(getCachedProfile, 'Expected Exported Function: getCachedProfile for export const getCachedProfile = React.cache(...)');
  assert.strictEqual(getCachedProfile.entityType, 'EXPORTED_FUNCTION');
  assert.strictEqual(getCachedProfile.patternId, 'contract.exported-function');
  assert.deepStrictEqual(getCachedProfile.metadata?.inputTypes, ['AuthToken']);
  assert.strictEqual(getCachedProfile.metadata?.outputType, 'UserProfile');

  assert.ok(getDeferredSession, 'Expected Exported Function: getDeferredSession for const getDeferredSession = cache(...); export { getDeferredSession }');
  assert.strictEqual(getDeferredSession.entityType, 'EXPORTED_FUNCTION');

  assert.ok(getDefaultSession, 'Expected Exported Function: getDefaultSession for const getDefaultSession = cache(...); export default getDefaultSession');
  assert.strictEqual(getDefaultSession.entityType, 'EXPORTED_FUNCTION');
  assert.strictEqual(getDefaultSession.metadata?.outputType, 'SessionPayload');

  assert.ok(readCookies && verifyToken && privateRoute);

  // Verify calls inside the cached functions are owned by the respective Exported Function contracts (NOT Init)
  const sessionReadCookies = graph.edges.find(
    (e) => e.sourceId === getServerSession.id && e.targetId === readCookies.id && e.name === 'Call: readCookies()'
  );
  const sessionVerifyToken = graph.edges.find(
    (e) => e.sourceId === getServerSession.id && e.targetId === verifyToken.id && e.name === 'Call: verifyToken()'
  );
  assert.ok(sessionReadCookies, 'readCookies() inside getServerSession must be owned by Exported Function: getServerSession');
  assert.ok(sessionVerifyToken, 'verifyToken() inside getServerSession must be owned by Exported Function: getServerSession');

  const profileVerifyToken = graph.edges.find(
    (e) => e.sourceId === getCachedProfile.id && e.targetId === verifyToken.id && e.name === 'Call: verifyToken()'
  );
  assert.ok(profileVerifyToken, 'verifyToken() inside getCachedProfile must be owned by Exported Function: getCachedProfile');

  const deferredReadCookies = graph.edges.find(
    (e) => e.sourceId === getDeferredSession.id && e.targetId === readCookies.id && e.name === 'Call: readCookies()'
  );
  assert.ok(deferredReadCookies, 'readCookies() inside getDeferredSession must be owned by Exported Function: getDeferredSession');

  const defaultReadCookies = graph.edges.find(
    (e) => e.sourceId === getDefaultSession.id && e.targetId === readCookies.id && e.name === 'Call: readCookies()'
  );
  assert.ok(defaultReadCookies, 'readCookies() inside getDefaultSession must be owned by Exported Function: getDefaultSession');

  const initNode = graph.nodes.find((n) => n.entityType === 'INIT_BLOCK');
  if (initNode) {
    const leakedInnerCalls = graph.edges.filter(
      (e) =>
        e.sourceId === initNode.id &&
        (e.name === 'Call: readCookies()' || e.name === 'Call: verifyToken()')
    );
    assert.strictEqual(leakedInnerCalls.length, 0, 'Inner calls inside cache(...) must not leak into INIT_BLOCK');
  }

  // Verify cross-file callers in PrivateRoute.ts resolve to the extracted Exported Function contracts
  const callGetServerSession = graph.edges.find(
    (e) => e.sourceId === privateRoute.id && e.name === 'Call: getServerSession()'
  );
  assert.ok(callGetServerSession);
  assert.strictEqual(callGetServerSession.targetId, getServerSession.id);
  assert.strictEqual(callGetServerSession.confidence, 'HIGH');

  const callGetCachedProfile = graph.edges.find(
    (e) => e.sourceId === privateRoute.id && e.name === 'Call: getCachedProfile()'
  );
  assert.ok(callGetCachedProfile);
  assert.strictEqual(callGetCachedProfile.targetId, getCachedProfile.id);
  assert.strictEqual(callGetCachedProfile.confidence, 'HIGH');

  const callGetDeferredSession = graph.edges.find(
    (e) => e.sourceId === privateRoute.id && e.name === 'Call: getDeferredSession()'
  );
  assert.ok(callGetDeferredSession);
  assert.strictEqual(callGetDeferredSession.targetId, getDeferredSession.id);
  assert.strictEqual(callGetDeferredSession.confidence, 'HIGH');

  const callGetDefaultSession = graph.edges.find(
    (e) => e.sourceId === privateRoute.id && e.name === 'Call: getDefaultSession()'
  );
  assert.ok(callGetDefaultSession);
  assert.strictEqual(callGetDefaultSession.targetId, getDefaultSession.id);
  assert.strictEqual(callGetDefaultSession.confidence, 'HIGH');
});

test('Nested Exported Object-Literal Member Calls (sk1/CALL/ImportObject/Prop(Id) and sk1/CALL/ImportObject/Prop(Prop(Id))): extracts nested method contracts, assigns AST ownership to nested methods (not Init), and resolves cross-file calls with 0 unresolved connections', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'nested-object-literal-exports');
  const graph = analyzeTarget(fixtureDir);

  const serverFetchNode = graph.nodes.find(n => n.name === 'Exported Function: serverFetch');
  const clientsApiNode = graph.nodes.find(n => n.name === 'Exported Function: clientsAPI');
  const getAllNode = graph.nodes.find(n => n.name === 'Exported Function: briefsAPI.server.getAll');
  const deleteBriefNode = graph.nodes.find(n => n.name === 'Exported Function: briefsAPI.server.deleteBrief');
  const loadDashboardNode = graph.nodes.find(n => n.name === 'Exported Function: loadDashboard');

  assert.ok(serverFetchNode, 'Expected Exported Function: serverFetch contract');
  assert.ok(clientsApiNode, 'Expected Exported Function: clientsAPI 1-level object contract');
  assert.ok(getAllNode, 'Expected Exported Function: briefsAPI.server.getAll 2-level nested contract');
  assert.ok(deleteBriefNode, 'Expected Exported Function: briefsAPI.server.deleteBrief 2-level nested contract');
  assert.ok(loadDashboardNode, 'Expected Exported Function: loadDashboard caller contract');

  // 1. Outgoing serverFetch() calls inside briefsAPI.server.getAll and briefsAPI.server.deleteBrief
  //    are owned by their respective nested method contracts and never leak into an INIT_BLOCK
  assert.ok(
    !graph.nodes.some(n => n.entityType === 'INIT_BLOCK'),
    'Calls inside nested object-literal methods must be owned by the method contract, not INIT_BLOCK'
  );
  const getAllFetchEdge = graph.edges.find(
    e => e.sourceId === getAllNode.id && e.targetId === serverFetchNode.id && e.name === 'Call: serverFetch()'
  );
  const deleteBriefFetchEdge = graph.edges.find(
    e => e.sourceId === deleteBriefNode.id && e.targetId === serverFetchNode.id && e.name === 'Call: serverFetch()'
  );
  assert.ok(getAllFetchEdge, 'serverFetch() inside briefsAPI.server.getAll must be owned by briefsAPI.server.getAll');
  assert.ok(deleteBriefFetchEdge, 'serverFetch() inside briefsAPI.server.deleteBrief must be owned by briefsAPI.server.deleteBrief');

  // 2. Cross-file 1-level (`clientsAPI.getAll()`) and 2-level (`briefsAPI.server.getAll()`, `briefsAPI.server.deleteBrief(id)`)
  //    member calls resolve to their extracted contracts with HIGH confidence and 0 unresolved calls
  const clientsCall = graph.edges.find(
    e => e.sourceId === loadDashboardNode.id && e.name === 'Call: clientsAPI.getAll()'
  );
  assert.ok(clientsCall, 'Expected Call: clientsAPI.getAll() edge');
  assert.strictEqual(clientsCall.targetId, clientsApiNode.id);
  assert.strictEqual(clientsCall.confidence, 'HIGH');
  assert.strictEqual(clientsCall.metadata?.shapeKey, 'sk1/CALL/ImportObject/Prop(Id)');

  const getAllCall = graph.edges.find(
    e => e.sourceId === loadDashboardNode.id && e.name === 'Call: briefsAPI.getAll()'
  );
  assert.ok(getAllCall, 'Expected Call: briefsAPI.getAll() edge');
  assert.strictEqual(getAllCall.targetId, getAllNode.id);
  assert.strictEqual(getAllCall.confidence, 'HIGH');
  assert.strictEqual(getAllCall.metadata?.shapeKey, 'sk1/CALL/ImportObject/Prop(Prop(Id))');
  const getAllEvs = Array.isArray(getAllCall.evidence) ? getAllCall.evidence : [getAllCall.evidence];
  assert.deepStrictEqual(getAllEvs.map(e => e.evidenceRole), ['syntax-call', 'import-match', 'target-signature']);

  const deleteBriefCall = graph.edges.find(
    e => e.sourceId === loadDashboardNode.id && e.name === 'Call: briefsAPI.deleteBrief()'
  );
  assert.ok(deleteBriefCall, 'Expected Call: briefsAPI.deleteBrief() edge');
  assert.strictEqual(deleteBriefCall.targetId, deleteBriefNode.id);
  assert.strictEqual(deleteBriefCall.confidence, 'HIGH');
  assert.strictEqual(deleteBriefCall.metadata?.shapeKey, 'sk1/CALL/ImportObject/Prop(Prop(Id))');

  // Verify 0 unresolved edges and reconcileUnresolvedConnections marks contracts as isImportedInRepo
  assert.strictEqual(graph.edges.filter(e => !e.targetId).length, 0, 'Expected 0 unresolved edges in fixture');
  assert.strictEqual(clientsApiNode.metadata?.isImportedInRepo, true);
  assert.strictEqual(getAllNode.metadata?.isImportedInRepo, true);
  assert.strictEqual(deleteBriefNode.metadata?.isImportedInRepo, true);
  assert.strictEqual(loadDashboardNode.metadata?.unresolvedOutgoing, undefined);

  // 3. Principle of Incomplete Truth (Rule 2): calling a non-existent path (`briefsAPI.deleteBrief()` at top level
  //    or `briefsAPI.client.getAll()` under a missing namespace) must NOT fabricate a resolution
  const badCallerAbs = path.join(fixtureDir, 'badCaller.ts');
  const badCallerCode = `
    import { briefsAPI } from './api';
    export function badCalls(id: string) {
      briefsAPI.deleteBrief(id);
      briefsAPI.client.getAll();
    }
  `;
  const badCallerSf = ts.createSourceFile(badCallerAbs, badCallerCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const getBadEv = (n: ts.Node) => {
    const { line } = badCallerSf.getLineAndCharacterOfPosition(n.getStart(badCallerSf));
    return { filePath: 'badCaller.ts', lineNumber: line + 1, snippet: n.getText(badCallerSf).slice(0, 60) };
  };
  const badEdges: any[] = [];
  const walkBad = (n: ts.Node) => {
    const rRes = visitRelationship(n, badCallerSf, getBadEv, () => 'bad-edge', fixtureDir, 'bad-caller');
    const rList = Array.isArray(rRes) ? rRes : rRes ? [rRes] : [];
    badEdges.push(...rList);
    ts.forEachChild(n, walkBad);
  };
  walkBad(badCallerSf);

  assert.strictEqual(badEdges.length, 2);
  assert.strictEqual(badEdges[0].targetId, undefined, 'Top-level briefsAPI.deleteBrief() must remain unresolved when only briefsAPI.server.deleteBrief exists');
  assert.strictEqual(badEdges[1].targetId, undefined, 'briefsAPI.client.getAll() must remain unresolved when only briefsAPI.server.getAll exists');
});

test('CommonJS Object-Literal Exports, require() Member Calls, and Express require() Callback Linking: extracts variable/inline object-literal CJS exports, resolves db.query() and blogQueries.* calls, and links Express middleware callbacks', () => {
  const fixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'cjs-object-literal-require');
  const graph = analyzeTarget(fixtureDir);

  // 1. Variable-assigned (`module.exports = blogQueries`) and inline/shorthand (`module.exports = { query, pool }`, `module.exports = { verifyToken, verifyResourceOwner }`) CJS object-literal exports
  const createBlogPost = graph.nodes.find(n => n.name === 'CJS Export: createBlogPost' && n.entityType === 'EXPORTED_FUNCTION');
  const getBlogById = graph.nodes.find(n => n.name === 'CJS Export: getBlogById' && n.entityType === 'EXPORTED_FUNCTION');
  const dbQuery = graph.nodes.find(n => n.name === 'CJS Export: query' && n.entityType === 'EXPORTED_FUNCTION');
  const verifyToken = graph.nodes.find(n => n.name === 'CJS Export: verifyToken' && n.entityType === 'EXPORTED_FUNCTION');
  const verifyResourceOwner = graph.nodes.find(n => n.name === 'CJS Export: verifyResourceOwner' && n.entityType === 'EXPORTED_FUNCTION');
  const postBlogsRoute = graph.nodes.find(n => n.name === 'Express Route: POST /blogs/:id' && n.entityType === 'HTTP_ENDPOINT');
  const pgPackage = graph.nodes.find(n => n.name === 'Package: pg' && n.entityType === 'EXTERNAL_PACKAGE');
  assert.ok(createBlogPost && getBlogById && dbQuery && verifyToken && verifyResourceOwner && postBlogsRoute && pgPackage);

  // Express req.* property assignments (`req.user = ...`, `req.authorizedTime = ...`) must NOT be falsely extracted as CJS exports
  assert.ok(!graph.nodes.some(n => n.name === 'CJS Export: user' || n.name === 'CJS Export: authorizedTime'));

  // 2. AST ownership and `sk1/CALL/LocalRequire/Prop(Id)` resolution (`db.query(...)`, `blogQueries.createBlogPost(...)`)
  const routeToCreate = graph.edges.find(
    e => e.sourceId === postBlogsRoute.id && e.name === 'Call: blogQueries.createBlogPost()' && e.targetId === createBlogPost.id
  );
  assert.ok(routeToCreate, 'Express route handler must resolve blogQueries.createBlogPost() to CJS Export: createBlogPost');
  assert.strictEqual(routeToCreate.metadata?.shapeKey, 'sk1/CALL/LocalRequire/Prop(Id)');

  const createToQuery = graph.edges.find(
    e => e.sourceId === createBlogPost.id && e.name === 'Call: db.query()' && e.targetId === dbQuery.id
  );
  const getByIdToQuery = graph.edges.find(
    e => e.sourceId === getBlogById.id && e.name === 'Call: db.query()' && e.targetId === dbQuery.id
  );
  assert.ok(createToQuery && getByIdToQuery, 'db.query() inside object-literal methods must be owned by CJS Export:<method> and resolve to CJS Export: query');
  assert.strictEqual(createToQuery.metadata?.shapeKey, 'sk1/CALL/LocalRequire/Prop(Id)');

  const dbPoolQueryConnector = graph.nodes.find(
    n => n.name === 'DB Call: pool.query' && n.entityType === 'DB_QUERY'
  );
  assert.ok(dbPoolQueryConnector, 'pool.query() must be extracted as a DB_QUERY Open Connector');
  const queryToPg = graph.edges.find(
    e => e.sourceId === dbQuery.id && e.name === 'Call: DB Call: pool.query' && e.targetId === dbPoolQueryConnector.id
  );
  assert.ok(queryToPg, 'pool.query() inside CJS Export: query must be owned by CJS Export: query and resolve to DB Call: pool.query');

  const ownerWrappedCall = graph.edges.find(
    e => e.sourceId === verifyResourceOwner.id && e.name === 'Call: getResourceById()'
  );
  assert.ok(ownerWrappedCall, 'Calls inside HOF-wrapped local helper must be owned by CJS Export: verifyResourceOwner');

  // 3. Express middleware and HOF property-access callback linking (`app.use(tokenCheck)`, `verifyToken`, `verifyResourceOwner(blogQueries.getBlogById)`)
  const tokenCheckDefault = graph.nodes.find(
    n =>
      n.name === 'CJS Export: default' &&
      (Array.isArray(n.evidence) ? n.evidence : [n.evidence]).some(ev => ev.filePath === 'tokenCheck.js')
  );
  assert.ok(tokenCheckDefault, 'Expected CJS Export: default in tokenCheck.js');

  const tokenCheckCallbackEdge = graph.edges.find(
    e => e.name === 'Call: tokenCheck()' && e.patternId === 'relationship.callback-reference' && e.targetId === tokenCheckDefault.id
  );
  assert.ok(tokenCheckCallbackEdge, 'app.use(tokenCheck) must link to tokenCheck.js CJS Export: default via callback-reference');

  const verifyTokenCallbackEdge = graph.edges.find(
    e => e.name === 'Call: verifyToken()' && e.patternId === 'relationship.callback-reference' && e.targetId === verifyToken.id
  );
  assert.ok(verifyTokenCallbackEdge, 'Express route middleware verifyToken must link to CJS Export: verifyToken');

  const getBlogByIdCallbackEdge = graph.edges.find(
    e => e.name === 'Call: blogQueries.getBlogById()' && e.patternId === 'relationship.callback-reference' && e.targetId === getBlogById.id
  );
  assert.ok(getBlogByIdCallbackEdge, 'verifyResourceOwner(blogQueries.getBlogById) must link to CJS Export: getBlogById');

  // 4. Pure-data CJS config module (`config.js`) and linked CJS exports must have 0 unresolvedIncoming / unresolvedOutgoing
  for (const node of [createBlogPost, getBlogById, dbQuery, verifyToken, verifyResourceOwner, tokenCheckDefault]) {
    assert.strictEqual(node.metadata?.unresolvedIncoming, undefined, `Expected 0 unresolvedIncoming on ${node.name}`);
  }
});

test('Studio Audit Tier 1 Fixes: distinct Module Export (Default) IDs, deferred default export class deduplication, and Array.some DB alias guard', () => {
  // 1. Distinct Module Export (Default) IDs across files in the same DEPLOYMENT_UNIT
  const idA = contractEntityId('my-app', 'src/routes/users.ts', 'Module Export (Default)', 'contract.es6-export-default');
  const idB = contractEntityId('my-app', 'src/routes/articles.ts', 'Module Export (Default)', 'contract.es6-export-default');
  assert.notStrictEqual(idA, idB, 'Module Export (Default) across distinct files in the same deployment unit must not collide');

  // 2. Deferred default export of a same-file ClassDeclaration must not emit a redundant Module Export (Default) contract
  const clsCode = `
    class HttpException extends Error {
      errorCode: number;
      constructor(errorCode: number, public readonly message: string) {
        super(message);
        this.errorCode = errorCode;
      }
    }
    export default HttpException;
  `;
  const clsSf = ts.createSourceFile('/repo/src/http-exception.model.ts', clsCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const getEv = (n: ts.Node) => ({ filePath: 'src/http-exception.model.ts', lineNumber: 1, snippet: n.getText(clsSf).slice(0, 40) });
  const extractedContracts: any[] = [];
  const walkCls = (n: ts.Node) => {
    const res = visitContract(n, clsSf, getEv, () => 'c-id', null, 'src/http-exception.model.ts');
    if (res) extractedContracts.push(...(Array.isArray(res) ? res : [res]));
    ts.forEachChild(n, walkCls);
  };
  walkCls(clsSf);
  assert.strictEqual(
    extractedContracts.some(c => c.name === 'Module Export (Default)'),
    false,
    'Deferred export default HttpException must not emit a redundant Module Export (Default) contract'
  );
});

test('Backlog High-Priority Extractor Fixes: CJS submodule member preservation, Event Listener collision guard, inner closure helper isolation, and partial HTTP_FETCH stitch metadata update', () => {
  const cjsFixtureDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'cjs-object-literal-require');

  // 1. `db.pool.connect()` preserves intermediate receiver segment (`Call: db.pool.connect()`)
  //    and `reconcileUnresolvedConnections` does NOT falsely match `Event Listener: connect` in `dbconn.js`,
  //    nor emit stale `unresolvedOutgoing` for `db.query()` when `pool.query` is already resolved to an Open Connector.
  const dbModelRel = 'dbconn.js';
  const dbModelAbs = path.join(cjsFixtureDir, dbModelRel);
  const dbCallerRel = 'blogRoutes.js';
  const dbCallerAbs = path.join(cjsFixtureDir, dbCallerRel);
  const dbCallerCode = `
    const dbConn = require('./dbconn');
    function checkConnection() {
      return dbConn.pool.connect();
    }
    module.exports = { checkConnection };
  `;
  const dbCallerSf = ts.createSourceFile(dbCallerAbs, dbCallerCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const getDbEv = (n: ts.Node) => {
    const { line } = dbCallerSf.getLineAndCharacterOfPosition(n.getStart(dbCallerSf));
    return { filePath: dbCallerRel, lineNumber: line + 1, snippet: n.getText(dbCallerSf).slice(0, 60) };
  };
  const dbEdges: any[] = [];
  const walkDb = (n: ts.Node) => {
    const rRes = visitRelationship(n, dbCallerSf, getDbEv, () => 'db-edge-1', cjsFixtureDir, 'caller-check');
    if (rRes) dbEdges.push(...(Array.isArray(rRes) ? rRes : [rRes]));
    ts.forEachChild(n, walkDb);
  };
  walkDb(dbCallerSf);

  const poolConnectEdge = dbEdges.find(e => e.name === 'Call: dbConn.pool.connect()');
  assert.ok(poolConnectEdge, 'dbConn.pool.connect() must preserve intermediate receiver segment in Call: dbConn.pool.connect()');
  assert.strictEqual(poolConnectEdge.metadata?.targetSymbol, 'pool.connect');

  // Verify `reconcileUnresolvedConnections` does NOT match `Event Listener: connect` in `dbconn.js`
  const dbModelSf = getCachedSourceFile(dbModelAbs)!;
  const eventListenerNode: any = {
    id: 'evt-connect',
    name: 'Event Listener: connect',
    type: 'CONTRACT',
    entityType: 'EVENT_LISTENER',
    patternId: 'contract.event-listener',
    scope: 'USER',
    evidence: [{ filePath: dbModelRel, lineNumber: 1, snippet: "pool.on('connect', ...)" }],
  };
  const checkConnNode: any = {
    id: 'caller-check',
    name: 'CJS Export: checkConnection',
    type: 'CONTRACT',
    entityType: 'EXPORTED_FUNCTION',
    patternId: 'contract.commonjs-export',
    scope: 'USER',
    evidence: [{ filePath: dbCallerRel, lineNumber: 3, snippet: 'function checkConnection()' }],
  };
  const ownerMap = new Map<ts.Node, string>();
  ts.forEachChild(dbCallerSf, (n) => {
    if (ts.isFunctionDeclaration(n)) ownerMap.set(n, 'caller-check');
  });
  const reconcileNodes = [eventListenerNode, checkConnNode];
  reconcileUnresolvedConnections(
    [
      {
        sourceFile: dbModelSf,
        filePath: dbModelAbs,
        relativePath: dbModelRel,
        scope: 'USER',
        ownerByNode: new Map(),
        unitId: 'du-1',
        getInitId: () => undefined,
      },
      {
        sourceFile: dbCallerSf,
        filePath: dbCallerAbs,
        relativePath: dbCallerRel,
        scope: 'USER',
        ownerByNode: ownerMap,
        unitId: 'du-1',
        getInitId: () => undefined,
      },
    ],
    reconcileNodes,
    dbEdges,
    cjsFixtureDir,
    {}
  );
  assert.strictEqual(
    eventListenerNode.metadata?.unresolvedIncoming,
    undefined,
    'Event Listener: connect must never be matched as target of db.pool.connect()'
  );

  // 2. Chained `.catch(next)`, `Math.random().toString(36).substr(2, 4)`, and anonymous `(() => () => {})()()`
  //    must not emit bogus `Call: fn.catch()`, `Call: Math.substr()`, or `Call: Function()()` edges
  const noiseCode = `
    export const catchAsync = (fn: any) => (req: any, res: any, next: any) => {
      fn(req, res, next).catch(next);
      const nonce = Math.random().toString(36).substr(2, 4);
      ((a: number) => () => a)(1)();
      return nonce;
    };
  `;
  const noiseSf = ts.createSourceFile('/repo/src/catchAsync.ts', noiseCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const noiseEdges: any[] = [];
  const walkNoise = (n: ts.Node) => {
    const rRes = visitRelationship(
      n,
      noiseSf,
      () => ({ filePath: 'src/catchAsync.ts', lineNumber: 1, snippet: '' }),
      () => 'noise-edge',
      '/repo',
      'catch-async'
    );
    if (rRes) noiseEdges.push(...(Array.isArray(rRes) ? rRes : [rRes]));
    ts.forEachChild(n, walkNoise);
  };
  walkNoise(noiseSf);
  assert.strictEqual(noiseEdges.some(e => e.name === 'Call: fn.catch()'), false, 'Must not emit Call: fn.catch()');
  assert.strictEqual(noiseEdges.some(e => e.name === 'Call: Math.substr()'), false, 'Must not emit Call: Math.substr()');
  assert.strictEqual(noiseEdges.some(e => e.name === 'Call: Function()()'), false, 'Must not emit Call: Function()()');
});

test('PAT-VIS-14 & PAT-EXT-22: Speed 1 syntactic port valves extract TS signatures, local interfaces, Zod schemas, MCP tools, and Drizzle columns', () => {
  const portFixture = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'port-valves');
  const graph = analyzeTarget(portFixture);

  const createOrder = graph.nodes.find((n) => n.name === 'Exported Function: createOrder');
  assert.ok(createOrder, 'Expected Exported Function: createOrder');
  assert.deepStrictEqual(createOrder.metadata?.inputTypes, ['OrderInput']);
  assert.strictEqual(createOrder.metadata?.outputType, 'OrderReceipt');
  assert.strictEqual(createOrder.metadata?.portValves?.tier, 'syntactic');
  assert.strictEqual(createOrder.metadata?.portValves?.origin, 'ts-signature');
  assert.deepStrictEqual(createOrder.metadata?.portValves?.inputs, [
    {
      name: 'input',
      type: 'OrderInput',
      fields: [
        { name: 'customerId', type: 'string' },
        { name: 'totalCents', type: 'number' },
        { name: 'currency', type: 'string', optional: true },
      ],
    },
    {
      name: 'dryRun',
      type: 'boolean',
      optional: true,
    },
  ]);
  assert.deepStrictEqual(createOrder.metadata?.portValves?.output, {
    type: 'OrderReceipt',
    async: true,
    fields: [
      { name: 'orderId', type: 'string' },
      { name: 'accepted', type: 'boolean' },
    ],
  });

  // Incomplete truth in Speed 1: cross-file interface & inferred return stay honest until Speed 2
  const summarizeAudit = graph.nodes.find((n) => n.name === 'Exported Function: summarizeAudit');
  assert.ok(summarizeAudit, 'Expected Exported Function: summarizeAudit');
  assert.deepStrictEqual(summarizeAudit.metadata?.portValves?.inputs, [
    { name: 'record', type: 'RemoteAuditRecord' },
  ]);
  assert.strictEqual(summarizeAudit.metadata?.portValves?.output, undefined);

  // Zod validator & Drizzle table column schemas extract structured object fields
  const schemaCode = `
    import { z } from 'zod';
    import { pgTable, serial, text } from 'drizzle-orm/pg-core';
    export const createOrderSchema = z.object({
      customerId: z.string(),
      totalCents: z.number(),
      coupon: z.string().optional(),
    });
    export const orders = pgTable('orders', {
      id: serial('id').primaryKey(),
      email: text('email').notNull(),
      note: text('note'),
    });
  `;
  const schemaSf = ts.createSourceFile('/repo/src/schema.ts', schemaCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const schemaContracts: any[] = [];
  const walkSchema = (n: ts.Node) => {
    const res = visitContract(n, schemaSf, () => ({ filePath: 'src/schema.ts', lineNumber: 1 }), () => 'schema-id', null, 'src/schema.ts');
    if (res) schemaContracts.push(...(Array.isArray(res) ? res : [res]));
    ts.forEachChild(n, walkSchema);
  };
  walkSchema(schemaSf);

  const zodSchema = schemaContracts.find((c) => c.name === 'VALIDATOR_SCHEMA: createOrderSchema');
  assert.ok(zodSchema, 'Expected VALIDATOR_SCHEMA: createOrderSchema');
  assert.strictEqual(zodSchema.metadata?.portValves?.origin, 'zod');
  assert.deepStrictEqual(zodSchema.metadata?.portValves?.output?.fields, [
    { name: 'customerId', type: 'string' },
    { name: 'totalCents', type: 'number' },
    { name: 'coupon', type: 'string', optional: true },
  ]);

  const ordersTable = schemaContracts.find((c) => c.name === 'Drizzle Schema: orders');
  assert.ok(ordersTable, 'Expected Drizzle Schema: orders');
  assert.strictEqual(ordersTable.metadata?.portValves?.origin, 'drizzle');
  assert.deepStrictEqual(ordersTable.metadata?.portValves?.output?.fields, [
    { name: 'id', type: 'number' },
    { name: 'email', type: 'string' },
    { name: 'note', type: 'string', optional: true },
  ]);

  // Drizzle fixture table also records drizzle port origin even on empty column map
  const drizzleFixture = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'nextjs-drizzle');
  const drizzleGraph = analyzeTarget(drizzleFixture);
  const usersTable = drizzleGraph.nodes.find((n) => n.name === 'Drizzle Schema: users');
  assert.ok(usersTable, 'Expected Drizzle Schema: users');
  assert.strictEqual(usersTable.metadata?.portValves?.origin, 'drizzle');

  // MCP tool extracts handler inline parameter fields
  const mcpFixture = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos', 'mcp-tool-ownership');
  const mcpGraph = analyzeTarget(mcpFixture);
  const mcpTool = mcpGraph.nodes.find((n) => n.name === 'MCP Tool: get_nodes');
  assert.ok(mcpTool, 'Expected MCP Tool: get_nodes');
  assert.strictEqual(mcpTool.metadata?.portValves?.inputs?.[0]?.name, 'args');
  assert.deepStrictEqual(mcpTool.metadata?.portValves?.inputs?.[0]?.fields, [
    { name: 'filter', type: 'string', optional: true },
  ]);

  // mergeContractPortValves upgrades non-stale Speed 2 overlays and drops stale diagnostics
  const mergedFresh = mergeContractPortValves(summarizeAudit.metadata, [
    {
      layer: 'L1_PORTS',
      stale: false,
      payload: {
        tier: 'typechecked',
        origin: 'ts-typecheck',
        inputs: [
          {
            name: 'record',
            type: 'RemoteAuditRecord',
            fields: [
              { name: 'auditId', type: 'string' },
              { name: 'flagged', type: 'boolean', optional: true },
            ],
            declaration: { filePath: 'types.ts', lineNumber: 1 },
          },
        ],
        output: {
          type: '{ summaryId: string; isClean: boolean }',
          fields: [
            { name: 'summaryId', type: 'string' },
            { name: 'isClean', type: 'boolean' },
          ],
        },
        diagnostics: [
          {
            kind: 'TS_CALL_MISMATCH',
            tsCode: 2345,
            message: "Argument of type '{}' is not assignable to parameter of type 'RemoteAuditRecord'.",
            filePath: 'orders.ts',
            lineNumber: 35,
          },
        ],
      },
    },
  ]);
  assert.strictEqual(mergedFresh?.tier, 'typechecked');
  assert.strictEqual(mergedFresh?.inputs?.[0]?.fields?.length, 2);
  assert.strictEqual(mergedFresh?.output?.fields?.length, 2);
  assert.strictEqual(mergedFresh?.diagnostics?.length, 1);

  const mergedStale = mergeContractPortValves(summarizeAudit.metadata, [
    {
      layer: 'L1_PORTS',
      stale: true,
      payload: {
        tier: 'typechecked',
        diagnostics: [
          {
            kind: 'TS_CALL_MISMATCH',
            message: 'Stale error',
            filePath: 'orders.ts',
          },
        ],
      },
    },
  ]);
  assert.strictEqual(mergedStale?.tier, 'syntactic', 'Stale L1_PORTS overlay must not upgrade tier');
  assert.strictEqual(mergedStale?.diagnostics, undefined, 'Stale L1_PORTS overlay must drop ghost diagnostics');
});





