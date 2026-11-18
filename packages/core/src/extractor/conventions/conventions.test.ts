import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import {
  ASTRO_CONVENTIONS,
  CONVENTION_SETS,
  CORE_CONVENTIONS,
  DRIZZLE_CONVENTIONS,
  EXPRESS_CONVENTIONS,
  EXPRESS_ROUTE_METHODS,
  MCP_CONVENTIONS,
  NEXTJS_CONVENTIONS,
  PAYLOAD_CONVENTIONS,
  PAYLOAD_HOOK_NAMES,
  REACT_CONVENTIONS,
  REACT_HOC_WRAPPERS,
  SVELTEKIT_CONVENTIONS,
  applyConventionRules,
  createConventionConfigResolver,
  deriveSvelteComponentName,
  deriveSvgComponentContractName,
  deriveVueSfcComponentName,
  describeConventionSchema,
  describeConventions,
  disambiguateCollidingOpenConnectors,
  isRouterFactoryInitializer,
  isSvelteRuneCall,
  isTopLevelCliEntryInvocation,
  isValidVersionRange,
  loadUserConventionSets,
  isNextjsAppSpecialFile,
  isRemixRouteFile,
  nextjsLayoutPath,
  nextjsRoutePath,
  runConventionEdges,
  runConventionNodes,
  satisfiesConventionVersion,
  unwrapWrappedFunction,
  validateConventionSet,
  type ConventionSet,
} from './index.js';
import {
  classifyNextjsFile,
  collectRoutedUnderscorePrefixes,
} from '../adapters/nextjsAdapter.js';
import {
  extractExpressAppListen,
  extractExpressContentNegotiation,
  extractExpressDynamicMethods,
  extractExpressMiddlewareBoundary,
  extractExpressResponseCookie,
  extractExpressRoute,
  extractExpressRouteMiddleware,
  extractExpressRouteParameter,
  extractExpressRouterMount,
} from '../adapters/expressAdapter.js';
import { extractMcpTool } from '../adapters/mcpAdapter.js';
import { extractDrizzleQueryChain, extractDrizzleSchemaContract } from '../adapters/drizzleAdapter.js';
import { extractPayloadCollectionConfig,
  extractPayloadConfigRegistry,
  extractPayloadContracts,
  extractPayloadHooks,
  extractPayloadOpenConnectors,
  extractPayloadTypeRefContracts,
} from '../adapters/payloadAdapter.js';
import { extractCommonjsExport } from '../visitors/commonjsExportVisitor.js';
import { visitBoundary } from '../visitors/boundaryVisitor.js';
import { visitContract } from '../visitors/contractVisitor.js';
import { visitOpenConnector, stitchIntraRepoHttpCalls } from '../visitors/openConnectorVisitor.js';
import { visitRelationship } from '../visitors/relationshipVisitor.js';
import { propagateLocalHelperOwners } from '../visitors/initBlockVisitor.js';
import {
  findModuleBinding,
  findValueModuleBinding,
  packageConnectorId,
  preprocessAstroOrMdxSource,
} from '../visitors/targetResolver.js';
import { measureOrphanShapeResolution } from '../../diagnostics/shapeResolution.js';
import { classifyCallEdgeResolution } from '../../diagnostics/healthMetrics.js';
import { classifyConnectorReceptorBox } from '../../diagnostics/scoutSanity.js';
import { detectFrameworkRulesFromDependencies } from '../../diagnostics/frameworkCoverage.js';
import {
  boundaryEntityId,
  contractEntityId,
  setActiveCollidingBoundaryKeys,
  setActiveCollidingContractKeys,
  stableEntityId,
} from '../../utils/id.js';
import type { EvidenceRecord, StructuralEdge, StructuralEntity, StructuralNode } from '../../types/index.js';

const fixturesDir = path.join(process.cwd(), '..', '..', 'fixtures', 'test-repos');
const fixture = (name: string) => path.join(fixturesDir, name);

/** Every file under a directory, as paths relative to it (forward slashes). */
function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return [path.relative(base, full).replace(/\\/g, '/')];
  });
}

/**
 * The classifier as it was hand-written before conventions became data. It is the oracle for
 * "the table reproduces the old behaviour exactly" — it must never be edited to follow the table.
 */
function legacyClassifyNextjsFile(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (/(?:^|\/)app\/(?:.*\/)?route\.[tj]sx?$/.test(normalized)) return 'ROUTE_HANDLER';
  if (/(?:^|\/)app\/(?:.*\/)?page\.[tj]sx?$/.test(normalized)) return 'PAGE';
  if (/(?:^|\/)app\/(?:.*\/)?layout\.[tj]sx?$/.test(normalized)) return 'LAYOUT';
  if (/(?:^|\/)middleware\.[tj]sx?$/.test(normalized)) return 'MIDDLEWARE';
  return null;
}

// ── Registry integrity ───────────────────────────────────────────────────────────────────────

test('every registered convention set is internally valid', () => {
  assert.ok(CONVENTION_SETS.length > 0);
  for (const set of CONVENTION_SETS) {
    assert.deepEqual(validateConventionSet(set), [], `convention set '${set.framework}'`);
  }
});

test('describeConventionSchema covers all NodeMatcher/EdgeMatcher kinds and valid templates', () => {
  const schema = describeConventionSchema();
  assert.equal(schema.nodeMatchers.length, 17);
  assert.equal(schema.edgeMatchers.length, 4);
  for (const tpl of schema.templates) {
    const raw = tpl.configSnippet as any;
    const set: ConventionSet = {
      framework: raw.framework,
      fileRoles: raw.fileRoles ?? [],
      baseExtensions: ['ts', 'tsx', 'js', 'jsx'],
      rules: (raw.rules ?? []).map((r: any) => ({
        ...r,
        meta: { framework: raw.framework, fixture: 'chomp.config.json', description: r.id },
      })),
      ...(raw.edgeRules
        ? {
            edgeRules: raw.edgeRules.map((er: any) => ({
              ...er,
              meta: { framework: raw.framework, fixture: 'chomp.config.json', description: er.id },
            })),
          }
        : {}),
      derivers: {},
      escapeHatches: [],
    };
    assert.deepEqual(validateConventionSet(set), [], `template '${tpl.title}' must be valid`);
  }
  const userSets = loadUserConventionSets(fixture('user-conventions'));
  assert.equal(userSets.length, 1);
  assert.deepEqual(validateConventionSet(userSets[0]!), []);
});

test('every rule and escape hatch points at a committed fixture with ground truth', () => {
  for (const set of CONVENTION_SETS) {
    const fixtures = [
      ...set.rules.map((r) => r.meta.fixture),
      ...(set.edgeRules ?? []).map((r) => r.meta.fixture),
      ...set.escapeHatches.map((h) => h.fixture),
    ];
    for (const name of fixtures) {
      assert.ok(fs.existsSync(path.join(fixture(name), 'expected.json')), `${set.framework}: fixture '${name}' has no expected.json`);
    }
  }
});

test('validateConventionSet reports duplicate ids, unknown roles and unknown placeholders', () => {
  const rule = NEXTJS_CONVENTIONS.rules[0];
  const bad: ConventionSet = {
    ...NEXTJS_CONVENTIONS,
    rules: [
      rule,
      { ...rule }, // duplicate id
      { ...rule, id: 'x.role', roles: ['NOPE'] },
      { ...rule, id: 'x.placeholder', emit: { ...rule.emit, name: 'Thing: {doesNotExist}' } },
    ],
  };
  const problems = validateConventionSet(bad);
  assert.ok(problems.some((p) => p.includes('duplicate rule id')));
  assert.ok(problems.some((p) => p.includes("unknown file role 'NOPE'")));
  assert.ok(problems.some((p) => p.includes('{doesNotExist}')));
});

test('the catalog has one stable row per rule, ready to publish as "supported conventions"', () => {
  const rows = describeConventions(NEXTJS_CONVENTIONS);
  assert.equal(rows.length, NEXTJS_CONVENTIONS.rules.length + (NEXTJS_CONVENTIONS.edgeRules?.length ?? 0));
  assert.deepEqual(
    rows.map((r) => r.id),
    [
      'nextjs.route-handler',
      'nextjs.page',
      'nextjs.layout',
      'nextjs.lifecycle-export',
      'nextjs.middleware',
      'nextjs.route-segment-config',
      'nextjs.metadata',
      'nextjs.cache-invalidation',
      'nextjs.server-action',
      'nextjs.dynamic-component-render',
    ]
  );
  for (const row of rows) {
    assert.equal(row.framework, 'nextjs');
    assert.ok(row.description.length > 0 && row.produces.patternId.length > 0 && row.fixture.length > 0);
  }
});

test('the React catalog lists node rules and edge rules, edges as RELATIONSHIP', () => {
  const rows = describeConventions(REACT_CONVENTIONS);
  assert.deepEqual(
    rows.map((r) => [r.id, r.produces.type]),
    [
      ['react.hoc-wrapped-component', 'CONTRACT'],
      ['react.imported-component-render', 'RELATIONSHIP'],
      ['react.dynamic-component-render', 'RELATIONSHIP'],
      ['react.same-file-component-render', 'RELATIONSHIP'],
      ['react.namespaced-component-render', 'RELATIONSHIP'],
    ]
  );
});

test('every registered framework convention is expressible in the table: no escape hatches remain', () => {
  assert.deepEqual(
    CONVENTION_SETS.map((s) => s.framework),
    ['nextjs', 'react', 'express', 'mcp', 'drizzle', 'payload', 'astro', 'sveltekit', 'core']
  );
  for (const set of CONVENTION_SETS) {
    assert.deepEqual(set.escapeHatches, [], `${set.framework} has escape hatches`);
  }
});

test('the Express, MCP, Drizzle, and Payload catalogs list every node and edge rule', () => {
  assert.deepEqual(
    describeConventions(EXPRESS_CONVENTIONS).map((r) => [r.id, r.produces.type]),
    [
      ['express.route', 'CONTRACT'],
      ['express.middleware', 'CONTRACT'],
      ['express.route-parameter', 'CONTRACT'],
      ['express.content-negotiation', 'CONTRACT'],
      ['express.app-listen', 'OPEN_CONNECTOR'],
      ['express.response-cookie', 'OPEN_CONNECTOR'],
      ['express.dynamic-methods', 'CONTRACT'],
      ['express.use-middleware', 'RELATIONSHIP'],
      ['express.router-mount', 'RELATIONSHIP'],
      ['express.route-middleware', 'RELATIONSHIP'],
      ['express.route-handler', 'RELATIONSHIP'],
    ]
  );
  assert.deepEqual(
    describeConventions(MCP_CONVENTIONS).map((r) => [r.id, r.produces.type]),
    [['mcp.tool', 'CONTRACT']]
  );
  assert.deepEqual(
    describeConventions(DRIZZLE_CONVENTIONS).map((r) => [r.id, r.produces.type]),
    [
      ['drizzle.schema', 'CONTRACT'],
      ['drizzle.query-chain', 'OPEN_CONNECTOR'],
    ]
  );
  assert.deepEqual(
    describeConventions(PAYLOAD_CONVENTIONS).map((r) => [r.id, r.produces.type]),
    [
      ['payload.collection-config', 'CONTRACT'],
      ['payload.global-config', 'CONTRACT'],
      ['payload.block', 'CONTRACT'],
      ['payload.task', 'CONTRACT'],
      ['payload.fields', 'CONTRACT'],
      ['payload.endpoints', 'CONTRACT'],
      ['payload.access', 'CONTRACT'],
      ['payload.transaction', 'OPEN_CONNECTOR'],
      ['payload.db-adapter-operation', 'OPEN_CONNECTOR'],
      ['payload.job-dispatch', 'OPEN_CONNECTOR'],
      ['payload.local-api-call', 'OPEN_CONNECTOR'],
      ['payload.mongoose-operation', 'OPEN_CONNECTOR'],
      ['payload.hook-registration', 'RELATIONSHIP'],
      ['payload.config-registry-collection', 'RELATIONSHIP'],
      ['payload.config-registry-global', 'RELATIONSHIP'],
      ['payload.plugin-registration', 'RELATIONSHIP'],
    ]
  );
});

// ── Matchers: wrapper unwrapping & directive predicate (in-memory sources, no filesystem) ────

const parse = (code: string) => ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const firstInit = (code: string): ts.Expression => {
  const stmt = parse(code).statements[0] as ts.VariableStatement;
  return stmt.declarationList.declarations[0].initializer!;
};
const WRAPPERS = REACT_HOC_WRAPPERS;

test('unwrapWrappedFunction follows wrapper calls to the function inside, including nesting', () => {
  assert.ok(unwrapWrappedFunction(firstInit('const A = memo(() => null);'), WRAPPERS));
  assert.ok(unwrapWrappedFunction(firstInit('const A = React.memo(function A() { return null; });'), WRAPPERS));
  assert.ok(unwrapWrappedFunction(firstInit('const A = React.forwardRef((p, r) => null);'), WRAPPERS));
  assert.ok(unwrapWrappedFunction(firstInit('const A = memo(forwardRef((p, r) => null));'), WRAPPERS), 'nested');
});

test('unwrapWrappedFunction refuses what it cannot prove is a wrapped function', () => {
  assert.equal(unwrapWrappedFunction(firstInit('const A = () => null;'), WRAPPERS), null, 'unwrapped arrow is not a wrapper');
  assert.equal(unwrapWrappedFunction(firstInit('const A = notAWrapper(() => null);'), WRAPPERS), null, 'unlisted wrapper');
  assert.equal(unwrapWrappedFunction(firstInit('const A = memo(Other);'), WRAPPERS), null, 'wraps a name, not a function');
  assert.equal(unwrapWrappedFunction(firstInit('const A = memo();'), WRAPPERS), null, 'no argument');
  assert.equal(unwrapWrappedFunction(firstInit('const A = someObj.memo(() => null);'), WRAPPERS), null, 'wrong receiver');
});

test("the directive predicate accepts file-level and function-level 'use server' only", () => {
  const cases: Array<[string, number]> = [
    ["'use server';\nexport async function a() {}", 1],
    ["export async function a() { 'use server'; }", 1],
    ['export async function a() {}', 0],
    ["'use client';\nexport async function a() {}", 0],
    ["'use server';\nfunction a() {}", 0], // not exported
    ["'use server';\nexport async function a() {}\nexport async function b() {}", 2],
  ];
  for (const [code, expected] of cases) {
    const sf = parse(code);
    const noop = (n: ts.Node) => ({ filePath: 'x.tsx', snippet: n.getText(sf).slice(0, 20) });
    let ids = 0;
    let count = 0;
    sf.forEachChild((node) => {
      count += applyConventionRules(NEXTJS_CONVENTIONS, ['nextjs.server-action'], node, null, 'x.tsx', noop, () => `id${ids++}`).length;
    });
    assert.equal(count, expected, code);
  }
});

// ── File roles: the table reproduces the old classifier exactly ──────────────────────────────

test('classification is identical to the legacy hard-coded classifier for every path in every fixture', () => {
  let checked = 0;
  for (const name of fs.readdirSync(fixturesDir)) {
    const dir = fixture(name);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const rel of walk(dir)) {
      assert.equal(classifyNextjsFile(rel), legacyClassifyNextjsFile(rel), `${name}/${rel}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `expected a real corpus, checked ${checked}`);
});

test('classification matches the legacy classifier on tricky hand-picked paths', () => {
  const paths = [
    'app/page.tsx',
    'app/dashboard/page.tsx',
    'src/app/(shop)/products/[id]/page.jsx',
    'apps/web/app/api/users/route.ts',
    'app/layout.tsx',
    'middleware.ts',
    'src/middleware.js',
    'apps/web/middleware.tsx',
    'app\\windows\\page.tsx',
    'app/mypage.tsx',
    'app/xroute.ts',
    'app/api/route.d.ts',
    'pages/page.tsx',
    'components/app/page.tsx',
    'app/page.dev.tsx',
    'app/page.stage.ts',
    'lib/route.ts',
    'app/nested/deeper/layout.ts',
  ];
  for (const p of paths) assert.equal(classifyNextjsFile(p), legacyClassifyNextjsFile(p), p);
});

test('project-configured extensions extend the roles; unlisted ones stay ordinary files', () => {
  const dev = ['dev.tsx', 'dev.ts'];
  assert.equal(classifyNextjsFile('app/a/page.dev.tsx'), null, 'not a page without the config');
  assert.equal(classifyNextjsFile('app/a/page.dev.tsx', dev), 'PAGE');
  assert.equal(classifyNextjsFile('app/a/layout.dev.tsx', dev), 'LAYOUT');
  assert.equal(classifyNextjsFile('app/api/route.dev.ts', dev), 'ROUTE_HANDLER');
  assert.equal(classifyNextjsFile('middleware.dev.ts', dev), 'MIDDLEWARE');
  assert.equal(classifyNextjsFile('app/a/page.stage.tsx', dev), null, 'stage.tsx was never enabled');
  assert.equal(classifyNextjsFile('app/a/page.tsx', dev), 'PAGE', 'base extensions keep working');
  // `page.page.tsx` is what `pageExtensions: ['page.tsx']` produces in the App Router.
  assert.equal(classifyNextjsFile('app/a/page.page.tsx', ['page.tsx']), 'PAGE');
});

// ── Config resolution (static, honest about unknowns) ────────────────────────────────────────

test('reads pageExtensions statically from next.config and drops the base extensions', () => {
  const root = fixture('nextjs-page-extensions');
  const resolver = createConventionConfigResolver(root);
  const extra = resolver.extensionsFor(NEXTJS_CONVENTIONS, path.join(root, 'app/dashboard/page.dev.tsx'));
  assert.deepEqual([...extra].sort(), ['dev.ts', 'dev.tsx']);
  assert.deepEqual(resolver.unresolved, []);
});

test('a computed pageExtensions is an honest unknown: nothing guessed, and it is recorded', () => {
  const root = fixture('nextjs-page-extensions-dynamic');
  const resolver = createConventionConfigResolver(root);
  assert.deepEqual(resolver.extensionsFor(NEXTJS_CONVENTIONS, path.join(root, 'app/settings/page.dev.tsx')), []);
  assert.deepEqual(resolver.unresolved, [
    { framework: 'nextjs', file: 'next.config.mjs', key: 'pageExtensions', reason: 'not-a-literal-array' },
  ]);
});

test('a project with no next.config yields no extra extensions and nothing unresolved', () => {
  const root = fixture('nextjs-app-router');
  const resolver = createConventionConfigResolver(root);
  assert.deepEqual(resolver.extensionsFor(NEXTJS_CONVENTIONS, path.join(root, 'app/page.tsx')), []);
  assert.deepEqual(resolver.unresolved, []);
});

test('resolvers are isolated per analysis run (no cache shared across instances)', () => {
  const root = fixture('nextjs-page-extensions-dynamic');
  const a = createConventionConfigResolver(root);
  const b = createConventionConfigResolver(root);
  a.extensionsFor(NEXTJS_CONVENTIONS, path.join(root, 'app/settings/page.dev.tsx'));
  assert.equal(a.unresolved.length, 1);
  assert.equal(b.unresolved.length, 0, 'b has not read anything yet');
});

// ── Derivers ─────────────────────────────────────────────────────────────────────────────────

test('route paths strip groups and the page/layout file, including configured extensions', () => {
  assert.equal(nextjsRoutePath('app/page.tsx'), '/');
  assert.equal(nextjsRoutePath('app/(dashboard)/customers/page.tsx'), '/customers');
  assert.equal(nextjsRoutePath('app/products/[id]/page.tsx'), '/products/[id]');
  assert.equal(nextjsRoutePath('app/dashboard/page.dev.tsx'), '/dashboard');
  assert.equal(nextjsRoutePath('app/dashboard/layout.dev.tsx'), '/dashboard');
  assert.equal(nextjsRoutePath('src/app/(auth)/login/page.tsx'), '/login');
  assert.equal(nextjsRoutePath('app\\win\\page.tsx'), '/win');
});

test('nextjsLayoutPath preserves route-group segments so co-depth layouts maintain distinct scopes', () => {
  assert.equal(nextjsLayoutPath('app/layout.tsx'), '/');
  assert.equal(nextjsLayoutPath('client/src/app/(auth)/layout.js'), '/(auth)');
  assert.equal(nextjsLayoutPath('client/src/app/admin/layout.js'), '/admin');
  assert.equal(nextjsLayoutPath('client/src/app/admin/(dashboard)/layout.js'), '/admin/(dashboard)');
  assert.equal(nextjsLayoutPath('app\\admin\\(editor)\\layout.tsx'), '/admin/(editor)');
});

test('Next.js App Router private folders (_folder) under app/ are excluded from PAGE/LAYOUT/ROUTE_HANDLER classification', () => {
  assert.equal(classifyNextjsFile('client/src/app/about/_services/page.js'), null);
  assert.equal(classifyNextjsFile('app/_components/page.tsx'), null);
  assert.equal(classifyNextjsFile('app/admin/(dashboard)/_internal/layout.tsx'), null);
  assert.equal(classifyNextjsFile('app/api/_private/route.ts'), null);
  assert.equal(classifyNextjsFile('client/src/app/about/page.js'), 'PAGE');
});

// ── Table-backed Express, MCP, Drizzle, and Payload adapters ─────────────────────────────────

const makeEv = (filePath: string, sf: ts.SourceFile) => (node: ts.Node): EvidenceRecord => ({
  filePath,
  snippet: node.getText(sf).slice(0, 60),
});
const makeNextId = () => {
  let n = 0;
  return () => `id-${n++}`;
};
const toList = (res: StructuralEntity | StructuralEntity[] | null): StructuralEntity[] =>
  res === null ? [] : Array.isArray(res) ? res : [res];

function walkNodes(sf: ts.SourceFile, fn: (n: ts.Node) => void): void {
  const visit = (n: ts.Node) => {
    fn(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

test('Express convention rules extract routes, content-negotiation, dynamic methods, and router mounts', () => {
  const code = `
    app.get('/users', authMiddleware, listUsers);
    app.use('/api', userRouter);
    res.format({ 'text/plain': () => {}, 'application/json': () => {} });
    methods.forEach((method) => {});
    app.listen(3000);
  `;
  const sf = parse(code);
  const ev = makeEv('server.ts', sf);
  const nextId = makeNextId();
  const entities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    entities.push(
      ...toList(extractExpressRoute(node, ev, nextId)),
      ...toList(extractExpressContentNegotiation(node, ev, nextId)),
      ...toList(extractExpressDynamicMethods(node, ev, nextId)),
      ...toList(extractExpressAppListen(node, ev, nextId)),
      ...toList(extractExpressRouteMiddleware(node, sf, ev, nextId, 'scope-1')),
      ...toList(
        extractExpressRouterMount(node, sf, ev, nextId, 'scope-1', {
          routerMount: () => 'resolved-router-id',
        })
      )
    );
  });
  const names = entities.map((e) => e.name);
  assert.ok(names.includes('Express Route: GET /users'));
  assert.ok(names.includes('Express Content Negotiation: text/plain, application/json'));
  assert.ok(names.includes('Express Route: GET (Dynamic)'));
  assert.ok(names.includes('Express App Listen'));
  assert.ok(names.includes('Express Mount: /users -> authMiddleware'));
  assert.ok(names.includes('Express Bind: /users -> listUsers'));
  const mount = entities.find((e) => e.name === 'Express Mount: /api -> userRouter');
  assert.ok(mount && mount.type === 'RELATIONSHIP');
  assert.equal(mount.targetId, 'resolved-router-id');
});

test('Express route conventions exclude client-side HTTP calls from route and bind extraction', () => {
  const code = `
    const res1 = await axios.post("http://localhost:5000/api/auth/signup", data);
    const res2 = await api.get('/users', config);
    const res3 = await client.get('/items', options);
    const res4 = await httpClient.post('https://api.example.com/v1', payload);
    const res5 = await http.get('http://example.com/data', cb);
    const res6 = await got.get('http://example.com');
    const res7 = await ky.post('https://api.com/auth', { json: data });
    const res8 = await superagent.post('http://localhost:5000/api', data);
    const res9 = await fetch.get('/api/data');
    const res10 = await window.axios.post("http://localhost:5000/api/auth/signup", data);
    const res11 = await this.client.get('/users', config);

    // Legitimate server routes with custom routers or server variables
    apiRouter.get('/profile', getProfile);
    server.post('/webhook', handleWebhook);
  `;
  const sf = parse(code);
  const ev = makeEv('clientAndServer.ts', sf);
  const nextId = makeNextId();
  const entities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    entities.push(
      ...toList(extractExpressRoute(node, ev, nextId)),
      ...toList(extractExpressRouteMiddleware(node, sf, ev, nextId, 'scope-1'))
    );
  });
  const routeContracts = entities.filter((e) => e.patternId === 'contract.express-route');
  const routeBinds = entities.filter((e) => e.patternId === 'relationship.express-route-handler');

  // Should NOT extract any client HTTP calls as server routes or route binds
  for (const entity of entities) {
    assert.ok(!entity.name.includes('localhost'), `Unexpected entity containing localhost: ${entity.name}`);
    assert.ok(!entity.name.includes('http://'), `Unexpected entity containing http://: ${entity.name}`);
    assert.ok(!entity.name.includes('https://'), `Unexpected entity containing https://: ${entity.name}`);
    assert.ok(!entity.name.includes('signup'), `Unexpected entity containing signup: ${entity.name}`);
    assert.ok(!entity.name.includes('config'), `Unexpected entity containing config: ${entity.name}`);
    assert.ok(!entity.name.includes('/items'), `Unexpected entity containing /items: ${entity.name}`);
    assert.ok(!entity.name.includes('payload'), `Unexpected entity containing payload: ${entity.name}`);
    assert.ok(!entity.name.includes('options'), `Unexpected entity containing options: ${entity.name}`);
  }

  // Legitimate server routes MUST still be extracted
  const routeNames = routeContracts.map((e) => e.name);
  assert.ok(routeNames.includes('Express Route: GET /profile'));
  assert.ok(routeNames.includes('Express Route: POST /webhook'));

  const bindNames = routeBinds.map((e) => e.name);
  assert.ok(bindNames.includes('Express Bind: /profile -> getProfile'));
  assert.ok(bindNames.includes('Express Bind: /webhook -> handleWebhook'));
});

test('MCP convention rule emits tool contract and companion REGISTERS relationship', () => {
  const sf = parse(`server.tool('get_nodes', {}, async () => {});`);
  const ev = makeEv('mcp.ts', sf);
  const nextId = makeNextId();
  const entities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    entities.push(...toList(extractMcpTool(node, ev, nextId)));
  });
  assert.deepEqual(
    entities.map((e) => [e.type, e.name, e.entityType, e.patternId]),
    [
      ['CONTRACT', 'MCP Tool: get_nodes', 'MCP_TOOL', 'contract.mcp-tool'],
      ['RELATIONSHIP', 'Registers Tool: get_nodes', 'REGISTERS', 'relationship.mcp-tool-register'],
    ]
  );
});

test('Drizzle convention rules emit schema contracts and fluent query open connectors with companion edges', () => {
  const sf = parse(`
    export const users = pgTable('users', {});
    db.select().from(users);
    db.insert(users).values({});
    db.query.users.findFirst({});
    db.query.users.findMany();
    db.execute(sql\`SELECT * FROM \${users}\`);
    db.transaction(async (tx) => {
      await tx.update(users).set({});
    });
  `);
  const ev = makeEv('db.ts', sf);
  const nextId = makeNextId();
  const entities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    entities.push(
      ...toList(extractDrizzleSchemaContract(node, ev, nextId)),
      ...toList(extractDrizzleQueryChain(node, ev, nextId))
    );
  });
  assert.deepEqual(
    entities.map((e) => [e.type, e.name, e.entityType]),
    [
      ['CONTRACT', 'Drizzle Schema: users', 'DB_SCHEMA'],
      ['OPEN_CONNECTOR', 'Drizzle Query: select()', 'DB_QUERY'],
      ['RELATIONSHIP', 'READS Schema: users', 'READS'],
      ['OPEN_CONNECTOR', 'Drizzle Query: insert()', 'DB_QUERY'],
      ['RELATIONSHIP', 'MUTATES Schema: users', 'MUTATES'],
      ['OPEN_CONNECTOR', 'Drizzle Query: findFirst()', 'DB_QUERY'],
      ['RELATIONSHIP', 'READS Schema: users', 'READS'],
      ['OPEN_CONNECTOR', 'Drizzle Query: findMany()', 'DB_QUERY'],
      ['RELATIONSHIP', 'READS Schema: users', 'READS'],
      ['OPEN_CONNECTOR', 'Drizzle Query: execute()', 'DB_QUERY'],
      ['RELATIONSHIP', 'READS Schema: users', 'READS'],
      ['OPEN_CONNECTOR', 'Drizzle Query: transaction()', 'DB_QUERY'],
      ['OPEN_CONNECTOR', 'Drizzle Query: update()', 'DB_QUERY'],
      ['RELATIONSHIP', 'MUTATES Schema: users', 'MUTATES'],
    ]
  );
});

test('Payload convention rules emit collection configs, local API connectors, and hook/collection edges', () => {
  const sf = parse(`
    export const Posts: CollectionConfig = {
      slug: 'posts',
      hooks: { beforeChange: [validatePost] },
    };
    export default buildConfig({ collections: [Posts] });
    payload.find({ collection: 'posts' });
    payload.create({ collection: 'posts', data: {} });
  `);
  const ev = makeEv('payload.ts', sf);
  const nextId = makeNextId();
  const entities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    entities.push(
      ...toList(extractPayloadCollectionConfig(node, ev, nextId)),
      ...toList(extractPayloadConfigRegistry(node, sf, ev, nextId)),
      ...toList(extractPayloadHooks(node, sf, ev, nextId)),
      ...toList(extractPayloadOpenConnectors(node, ev, nextId))
    );
  });
  const summary = entities.map((e) => `${e.type}:${e.name}`);
  assert.ok(summary.includes('CONTRACT:Payload Collection: Posts'));
  assert.ok(summary.includes('RELATIONSHIP:Payload Hook: beforeChange -> validatePost'));
  assert.ok(summary.includes('RELATIONSHIP:Payload Config Registry: Posts'));
  assert.ok(summary.includes('OPEN_CONNECTOR:Payload Local API: find'));
  assert.ok(summary.includes('RELATIONSHIP:READS Payload Collection: posts'));
  assert.ok(summary.includes('OPEN_CONNECTOR:Payload Local API: create'));
  assert.ok(summary.includes('RELATIONSHIP:MUTATES Payload Collection: posts'));
});

test('CORE_CONVENTIONS rules emit server-only guards, defineProperty getters, factory exports, and CJS exports', () => {
  const sf = parse(`
    import 'server-only';
    Object.defineProperty(obj, 'version', { get: () => '1.0' });
    export const { auth, signIn } = NextAuth({});
    export const insertUser = createInsertSchema(users);
    export const userSchema = z.object({});
    module.exports = function main() {};
    Router.prototype.route = function(path) {};
  `);
  const ev = makeEv('core.ts', sf);
  const nextId = makeNextId();
  const entities: StructuralEntity[] = [];
  const allCoreIds = CORE_CONVENTIONS.rules.map((r) => r.id);
  walkNodes(sf, (node) => {
    entities.push(...applyConventionRules(CORE_CONVENTIONS, allCoreIds, node, null, 'core.ts', ev, nextId));
  });
  assert.deepEqual(
    entities.map((e) => [e.name, e.entityType, e.patternId]),
    [
      ['Server Guard: server-only', 'SERVER_GUARD', 'contract.nextjs-server-only-guard'],
      ['Property Getter: version', 'PROPERTY_GETTER', 'contract.define-property'],
      ['AUTH_INTERFACE: auth', 'AUTH_INTERFACE', 'contract.nextauth-factory-destructure'],
      ['AUTH_INTERFACE: signIn', 'AUTH_INTERFACE', 'contract.nextauth-factory-destructure'],
      ['VALIDATOR_SCHEMA: insertUser', 'VALIDATOR_SCHEMA', 'contract.drizzle-exported-validator'],
      ['VALIDATOR_SCHEMA: userSchema', 'VALIDATOR_SCHEMA', 'contract.drizzle-exported-validator'],
      ['CJS Export: default', 'EXPORTED_FUNCTION', 'contract.commonjs-export'],
      ['Prototype Method: Router.prototype.route', 'PROTOTYPE_METHOD', 'contract.commonjs-export'],
    ]
  );
});

test('CORE_CONVENTIONS core.zod-exported-validator extracts object, discriminatedUnion, intersection, and union', () => {
  const sf = parse(`
    export const userSchema = z.object({ id: z.string() });
    export const eventSchema = z.discriminatedUnion('type', []);
    export const comboSchema = z.intersection(a, b);
    export const choiceSchema = z.union([a, b]);
    const localSchema = z.object({});
    export const nonMember = object({});
  `);
  const ev = makeEv('schemas.ts', sf);
  const nextId = makeNextId();
  const entities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    entities.push(...applyConventionRules(CORE_CONVENTIONS, ['core.zod-exported-validator'], node, null, 'schemas.ts', ev, nextId));
  });
  assert.deepEqual(
    entities.map((e) => [e.name, e.entityType, e.patternId]),
    [
      ['VALIDATOR_SCHEMA: userSchema', 'VALIDATOR_SCHEMA', 'contract.drizzle-exported-validator'],
      ['VALIDATOR_SCHEMA: eventSchema', 'VALIDATOR_SCHEMA', 'contract.drizzle-exported-validator'],
      ['VALIDATOR_SCHEMA: comboSchema', 'VALIDATOR_SCHEMA', 'contract.drizzle-exported-validator'],
      ['VALIDATOR_SCHEMA: choiceSchema', 'VALIDATOR_SCHEMA', 'contract.drizzle-exported-validator'],
    ]
  );
});

test('NEXTJS_CONVENTIONS nextjs.lifecycle-export rule emits INGRESS contracts for generateMetadata and generateStaticParams in PAGE and LAYOUT files', () => {
  const sf = parse(`
    export async function generateMetadata({ params }) { return { title: params.slug }; }
    export const generateStaticParams = async () => [{ slug: 'hello' }];
    export function helperFn() { return 1; }
  `);
  const ev = makeEv('app/posts/[slug]/page.tsx', sf);
  const nextId = makeNextId();
  const pageEntities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    pageEntities.push(
      ...applyConventionRules(
        NEXTJS_CONVENTIONS,
        ['nextjs.lifecycle-export'],
        node,
        'PAGE',
        'app/posts/[slug]/page.tsx',
        ev,
        nextId
      )
    );
  });
  assert.deepEqual(
    pageEntities.map((e) => [e.name, e.entityType, e.patternId, e.metadata?.flowRole, e.metadata?.routePath]),
    [
      [
        'Next.js Lifecycle: generateMetadata (/posts/[slug])',
        'NEXTJS_PAGE',
        'boundary.nextjs-page-component',
        'INGRESS',
        '/posts/[slug]',
      ],
      [
        'Next.js Lifecycle: generateStaticParams (/posts/[slug])',
        'NEXTJS_PAGE',
        'boundary.nextjs-page-component',
        'INGRESS',
        '/posts/[slug]',
      ],
    ]
  );

  // Also matches in LAYOUT files, and ignores non-page/layout roles
  const layoutEntities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    layoutEntities.push(
      ...applyConventionRules(
        NEXTJS_CONVENTIONS,
        ['nextjs.lifecycle-export'],
        node,
        'LAYOUT',
        'app/posts/layout.tsx',
        ev,
        nextId
      )
    );
  });
  assert.equal(layoutEntities.length, 2);
  assert.equal(layoutEntities[0].name, 'Next.js Lifecycle: generateMetadata (/posts)');

  const nonPageEntities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    nonPageEntities.push(
      ...applyConventionRules(
        NEXTJS_CONVENTIONS,
        ['nextjs.lifecycle-export'],
        node,
        null,
        'lib/seo.ts',
        ev,
        nextId
      )
    );
  });
  assert.equal(nonPageEntities.length, 0);
});

test('version-scoped conventions (meta.versions): satisfiesConventionVersion, runConventionNodes/runConventionEdges, and validateConventionSet', () => {
  assert.equal(isValidVersionRange('>=13.4'), true);
  assert.equal(isValidVersionRange('>=14 <16 || ^17.0.0'), true);
  assert.equal(isValidVersionRange('13.4 - 14.2'), true);
  assert.equal(isValidVersionRange('not-a-semver-range'), false);

  assert.equal(satisfiesConventionVersion('14.2.0', '>=14'), true);
  assert.equal(satisfiesConventionVersion('^13.5.0', '>=14'), false);
  assert.equal(satisfiesConventionVersion('~13.4.1', '>=13.4'), true);
  assert.equal(satisfiesConventionVersion('12.3.4', '>=13.4'), false);
  // Incomplete Truth: unknown / workspace specifiers do not suppress rules
  assert.equal(satisfiesConventionVersion(undefined, '>=14'), true);
  assert.equal(satisfiesConventionVersion('workspace:*', '>=14'), true);

  // `nextjs.server-action` requires `meta.versions: ">=14"`
  const actionSf = parse(`'use server'; export async function saveOrder() {}`);
  const ev = makeEv('app/actions.ts', actionSf);
  const nextId = makeNextId();

  const onNext14: StructuralEntity[] = [];
  const onNext13: StructuralEntity[] = [];
  walkNodes(actionSf, (node) => {
    onNext14.push(
      ...runConventionNodes(
        NEXTJS_CONVENTIONS,
        ['nextjs.server-action'],
        node,
        null,
        'app/actions.ts',
        ev,
        nextId,
        { next: '14.2.0' }
      )
    );
    onNext13.push(
      ...runConventionNodes(
        NEXTJS_CONVENTIONS,
        ['nextjs.server-action'],
        node,
        null,
        'app/actions.ts',
        ev,
        nextId,
        { next: '13.4.0' }
      )
    );
  });
  assert.equal(onNext14.length, 1);
  assert.equal(onNext13.length, 0, 'nextjs.server-action (>=14) must not fire when next@13.4.0 is installed');

  // Edge rule version filtering via runConventionEdges
  const versionedEdgeSet: ConventionSet = {
    ...NEXTJS_CONVENTIONS,
    edgeRules: (NEXTJS_CONVENTIONS.edgeRules ?? []).map((r) => ({
      ...r,
      meta: { ...r.meta, versions: '>=13.4' },
    })),
  };
  const jsxSf = ts.createSourceFile('app/page.tsx', '<Modal />', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const jsxEv = makeEv('app/page.tsx', jsxSf);
  const edgesOnNext14: StructuralEntity[] = [];
  const edgesOnNext12: StructuralEntity[] = [];
  walkNodes(jsxSf, (node) => {
    edgesOnNext14.push(
      ...runConventionEdges(
        versionedEdgeSet,
        ['nextjs.dynamic-component-render'],
        node,
        'page-1',
        jsxEv,
        nextId,
        { lazyComponent: () => ({ targetId: 'modal-1', evidences: [] }) },
        { next: '14.0.0' }
      )
    );
    edgesOnNext12.push(
      ...runConventionEdges(
        versionedEdgeSet,
        ['nextjs.dynamic-component-render'],
        node,
        'page-1',
        jsxEv,
        nextId,
        { lazyComponent: () => ({ targetId: 'modal-1', evidences: [] }) },
        { next: '12.3.0' }
      )
    );
  });
  assert.equal(edgesOnNext14.length, 1);
  assert.equal(edgesOnNext12.length, 0);

  // validateConventionSet flags invalid meta.versions range
  const brokenVersionSet: ConventionSet = {
    ...NEXTJS_CONVENTIONS,
    rules: [
      {
        ...NEXTJS_CONVENTIONS.rules[0],
        meta: { ...NEXTJS_CONVENTIONS.rules[0].meta, versions: 'invalid-version-range' },
      },
    ],
  };
  const problems = validateConventionSet(brokenVersionSet);
  assert.ok(problems.some((p) => p.includes('invalid version range')));
});

test('CJS exportAlias only matches receivers proven to alias module.exports/exports or exported bindings', () => {
  const domAndLocalCode = `
    const img = new Image();
    img.onload = () => {};
    img.onerror = () => {};
    const reader = new FileReader();
    reader.onload = function() {};
    window.onload = () => {};
    const localHelper = {};
    localHelper.compute = () => 42;
  `;
  const domSf = ts.createSourceFile('dom.ts', domAndLocalCode, ts.ScriptTarget.Latest, true);
  const domEv = makeEv('dom.ts', domSf);
  const nextId = makeNextId();
  const falsePositives: StructuralEntity[] = [];
  walkNodes(domSf, (node) => {
    falsePositives.push(...toList(extractCommonjsExport(node, domEv, nextId)));
  });
  assert.equal(falsePositives.length, 0);

  const validCjsAliasCode = `
    var proto = module.exports = function() {};
    proto.handle = function() {};
    module.exports = function(User) {
      User.create = async function() {};
    };
  `;
  const validSf = ts.createSourceFile('cjs.js', validCjsAliasCode, ts.ScriptTarget.Latest, true);
  const validEv = makeEv('cjs.js', validSf);
  const validEntities: StructuralEntity[] = [];
  walkNodes(validSf, (node) => {
    validEntities.push(...toList(extractCommonjsExport(node, validEv, nextId)));
  });
  const names = validEntities.map((e) => e.name);
  assert.ok(names.includes('CJS Export Alias: proto.handle'));
  assert.ok(names.includes('CJS Export Alias: User.create'));
});

test('Express middleware and route conventions reject i18next, tRPC procedure, MSW server, Hono 2-arg route, and Config.get false positives', () => {
  const code = `
    const server = setupServer();
    server.use(http.get('/api/user', () => {}));
    i18next.use(LanguageDetector).use(initReactI18next);
    const protectedProcedure = t.procedure.use(enforceUserIsAuthed);
    publicProcedure.use(loggerMiddleware);
    Config.get('settings.aws.s3.bucket', 'string');
    promptRegistry.get('default');
    app.route('/', subRouter);
    app.use(config.apiPrefix, routes());
    app.route('/settings');
    app.get('/health', healthHandler);
  `;
  const sf = ts.createSourceFile('server.ts', code, ts.ScriptTarget.Latest, true);
  const ev = makeEv('server.ts', sf);
  const nextId = makeNextId();
  const entities: StructuralEntity[] = [];
  walkNodes(sf, (node) => {
    entities.push(
      ...toList(extractExpressMiddlewareBoundary(node, sf, ev, nextId)),
      ...toList(extractExpressRoute(node, ev, nextId)),
      ...toList(extractExpressRouterMount(node, sf, ev, nextId, 'scope-1'))
    );
  });
  const names = entities.map((e) => e.name);
  assert.deepEqual(names, [
    'Middleware: routes()',
    'Express Mount: config.apiPrefix -> routes()',
    'Express Route: ROUTE /settings',
    'Express Route: GET /health',
  ]);
});

test('Payload propertyAssignment rules require a Payload config context (import, type annotation, or buildConfig)', () => {
  const nonPayloadCode = `
    export const postsRelations = relations(posts, ({ one }) => ({
      author: one(users, {
        fields: [posts.authorId],
        references: [users.id],
      }),
    }));
    const genericConfig = {
      fields: ['a', 'b'],
      access: { read: true },
      endpoints: [],
    };
  `;
  const nonPayloadSf = ts.createSourceFile('schema.ts', nonPayloadCode, ts.ScriptTarget.Latest, true);
  const ev1 = makeEv('schema.ts', nonPayloadSf);
  const nextId = makeNextId();
  const falsePositives: StructuralEntity[] = [];
  walkNodes(nonPayloadSf, (node) => {
    falsePositives.push(...toList(extractPayloadContracts(node, ev1, nextId)));
  });
  assert.equal(falsePositives.length, 0);

  const payloadCode = `
    import type { CollectionConfig } from 'payload';
    export const Posts: CollectionConfig = {
      slug: 'posts',
      fields: [{ name: 'title', type: 'text' }],
      access: { read: () => true },
    };
  `;
  const payloadSf = ts.createSourceFile('Posts.ts', payloadCode, ts.ScriptTarget.Latest, true);
  const ev2 = makeEv('Posts.ts', payloadSf);
  const validPayload: StructuralEntity[] = [];
  walkNodes(payloadSf, (node) => {
    validPayload.push(...toList(extractPayloadContracts(node, ev2, nextId)));
  });
  const names = validPayload.map((e) => e.name);
  assert.ok(names.includes('Payload Fields Array'));
  assert.ok(names.includes('Payload Access Control'));
});

test('Visitor guards skip ephemeral function-local classes, self-setPrototypeOf, ORM decorators, and custom request helpers', () => {
  const code = `
    import { Entity, Column } from 'typeorm';
    import { STRING } from 'sequelize';

    @Entity()
    export class CustomError extends Error {
      @Column()
      code = STRING(50);

      constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        Object.setPrototypeOf(this, CustomError.prototype);
      }

      handle(request: { get: (h: string) => string }) {
        class EphemeralDummy {
          noop() {}
        }
        return request.get('Authorization');
      }
    }

    function request(endpoint: string) {
      return endpoint;
    }

    export default function () {
      return request('/graphql');
    }
  `;
  const sf = ts.createSourceFile('guards.ts', code, ts.ScriptTarget.Latest, true);
  const ev = makeEv('guards.ts', sf);
  const nextId = makeNextId();
  const boundaries: StructuralEntity[] = [];
  const contracts: StructuralEntity[] = [];
  const connectors: StructuralEntity[] = [];
  const relationships: StructuralEntity[] = [];

  walkNodes(sf, (node) => {
    boundaries.push(...toList(visitBoundary(node, sf, ev, nextId)));
    contracts.push(...toList(visitContract(node, sf, ev, nextId, null, 'guards.ts')));
    connectors.push(...toList(visitOpenConnector(node, sf, ev, nextId, '/repo')));
    relationships.push(...toList(visitRelationship(node, sf, ev, nextId, '/repo', 'source-1')));
  });

  assert.deepEqual(
    boundaries.map((b) => b.name),
    ['Class: CustomError']
  );
  assert.ok(contracts.some((c) => c.name === 'Public Method: CustomError.handle'));
  assert.ok(!contracts.some((c) => c.name.includes('EphemeralDummy')));
  assert.ok(contracts.some((c) => c.name === 'Module Export (Default)'));
  assert.ok(!connectors.some((c) => c.entityType === 'DB_QUERY'));
  assert.ok(!connectors.some((c) => c.entityType === 'HTTP_FETCH'));
  assert.ok(!relationships.some((r) => r.entityType === 'INHERITS'));
});

test('Wave 2 guards: IDB transaction, raw Node http.createServer listen, Next.js alias route handlers, and Date prototype chains', () => {
  const idbAndHttpCode = `
    import http from 'http';
    import { parseISO } from 'date-fns';

    const server = http.createServer((req, res) => {
      res.end('ok');
    });
    server.listen(8080);

    function readIdb(db: IDBDatabase, data: Array<{ date: Date }>, rawDate: string) {
      const tx1 = db.transaction('users', 'readonly');
      const tx2 = db.transaction(['users', 'posts'], 'readwrite');
      const ts1 = parseISO(rawDate).getTime();
      const ts2 = data[data.length - 1].date.getTime();
      return { tx1, tx2, ts1, ts2 };
    }
  `;
  const sf1 = ts.createSourceFile('rawServer.ts', idbAndHttpCode, ts.ScriptTarget.Latest, true);
  const ev1 = makeEv('rawServer.ts', sf1);
  const nextId = makeNextId();
  const drizzleConnectors: StructuralEntity[] = [];
  const expressListens: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];

  walkNodes(sf1, (node) => {
    drizzleConnectors.push(...toList(visitOpenConnector(node, sf1, ev1, nextId, '/repo')));
    expressListens.push(...toList(extractExpressAppListen(node, ev1, nextId)));
    rels.push(...toList(visitRelationship(node, sf1, ev1, nextId, '/repo', 'source-1')));
  });

  assert.equal(drizzleConnectors.filter((c) => c.patternId === 'open-connector.drizzle-query').length, 0);
  assert.equal(expressListens.length, 0);
  assert.ok(!rels.some((r) => r.name.includes('getTime') && r.targetId));

  const nextRouteAliasCode = `
    const handler = async (req: Request) => new Response('ok');
    export { handler as GET, handler as POST };
  `;
  const routeRelPath = 'src/app/api/auth/[...nextauth]/route.ts';
  const sf2 = ts.createSourceFile(routeRelPath, nextRouteAliasCode, ts.ScriptTarget.Latest, true);
  const ev2 = makeEv(routeRelPath, sf2);
  const routeContracts: StructuralEntity[] = [];
  walkNodes(sf2, (node) => {
    routeContracts.push(...toList(visitContract(node, sf2, ev2, nextId, classifyNextjsFile(routeRelPath), routeRelPath)));
  });

  assert.deepEqual(
    routeContracts.map((c) => ({ name: c.name, entityType: c.entityType, patternId: c.patternId })),
    [
      { name: 'Route Handler: GET', entityType: 'HTTP_ENDPOINT', patternId: 'contract.nextjs-route-handler' },
      { name: 'Route Handler: POST', entityType: 'HTTP_ENDPOINT', patternId: 'contract.nextjs-route-handler' },
    ]
  );
});

test('Wave 3 guards: ambient namespaces, Zod vs Drizzle validators, class property arrows, fluent chains, and chained external calls', () => {
  const code = `
    import ora from 'ora';
    import { z } from 'zod';

    declare global {
      namespace Express {
        interface Request {
          userId?: string;
        }
      }
    }

    declare module 'custom-pkg' {
      export function dummy(): void;
    }

    export const extendedSchema = z.object({ id: z.string() }).extend({ name: z.string() }).passthrough();
    export const listSchema = z.array(z.string());

    export class Builder {
      cd(dir: string): Builder { return this; }
      ensureDir(dir: string): Builder { return this; }
      render = async (tpl: string): Promise<Builder> => {
        const spinner = ora('rendering').start();
        return this;
      };
      build(): Builder { return this; }
      save(): void {}

      runFlow() {
        this.cd('root').ensureDir('sub').render('index.tpl');
        const inst = this.build();
        inst.save();
      }
    }
  `;
  const sf = ts.createSourceFile('src/builder.ts', code, ts.ScriptTarget.Latest, true);
  const ev = makeEv('src/builder.ts', sf);
  const nextId = makeNextId();
  const boundaries: StructuralEntity[] = [];
  const contracts: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];

  walkNodes(sf, (node) => {
    boundaries.push(...toList(visitBoundary(node, sf, ev, nextId)));
    contracts.push(...toList(visitContract(node, sf, ev, nextId, null, 'src/builder.ts')));
    rels.push(...toList(visitRelationship(node, sf, ev, nextId, '/repo', 'source-1')));
  });

  // 1. Ambient/global declarations do not emit NAMESPACE boundaries
  assert.deepEqual(
    boundaries.map((b) => ({ name: b.name, entityType: b.entityType })),
    [{ name: 'Class: Builder', entityType: 'CLASS' }]
  );

  // 2. Pure Zod schemas without Drizzle imports emit contract.zod-exported-validator, and class arrow property is PUBLIC_METHOD
  assert.ok(
    contracts.some(
      (c) => c.name === 'VALIDATOR_SCHEMA: extendedSchema' && c.patternId === 'contract.zod-exported-validator'
    )
  );
  assert.ok(
    contracts.some(
      (c) => c.name === 'VALIDATOR_SCHEMA: listSchema' && c.patternId === 'contract.zod-exported-validator'
    )
  );
  assert.ok(
    contracts.some(
      (c) => c.name === 'Public Method: Builder.render' && c.entityType === 'PUBLIC_METHOD'
    )
  );

  // 3. Chained external call ora('rendering').start() does not target Package: ora
  const oraStart = rels.find((r) => r.name === 'Call: ora.start()');
  assert.ok(oraStart && !oraStart.targetId);

  // 4. Fluent chain calls (cd, ensureDir, render) and LocalFromCall inst.save() resolve with HIGH confidence
  const ensureDirEdge = rels.find((r) => r.name === 'Call: this.ensureDir()');
  const renderEdge = rels.find((r) => r.name === 'Call: this.render()');
  const saveEdge = rels.find((r) => r.name === 'Call: inst.save()');
  assert.ok(ensureDirEdge && ensureDirEdge.targetId && ensureDirEdge.confidence === 'HIGH');
  assert.ok(renderEdge && renderEdge.targetId && renderEdge.confidence === 'HIGH');
  assert.ok(
    saveEdge &&
      saveEdge.targetId === stableEntityId('repo', 'CONTRACT', 'Public Method: Builder.save') &&
      saveEdge.confidence === 'HIGH'
  );
});

test('Wave 4 guards: file-scoped Express/Next.js/DefineProperty contract IDs, Runtypes/Joi/createParamDecorator, Express array middleware & handler links, and top-level entrypoint helper ownership', () => {
  // 1. File-scoped contractEntityId prevents cross-file collisions for Express routes, middleware, defineProperty, and Next.js route handlers
  assert.notEqual(
    contractEntityId('repo', 'src/routes/users.ts', 'Express Route: GET /:id', 'contract.express-route'),
    contractEntityId('repo', 'src/routes/posts.ts', 'Express Route: GET /:id', 'contract.express-route')
  );
  assert.notEqual(
    contractEntityId('repo', 'src/a.ts', 'Middleware: express.json()', 'boundary.express-middleware'),
    contractEntityId('repo', 'src/b.ts', 'Middleware: express.json()', 'boundary.express-middleware')
  );
  assert.notEqual(
    contractEntityId('repo', 'app/api/a/route.ts', 'Route Handler: GET', 'contract.nextjs-route-handler'),
    contractEntityId('repo', 'app/api/b/route.ts', 'Route Handler: GET', 'contract.nextjs-route-handler')
  );
  assert.notEqual(
    contractEntityId('repo', 'src/a.js', 'Property Getter: name', 'contract.define-property'),
    contractEntityId('repo', 'src/b.js', 'Property Getter: name', 'contract.define-property')
  );

  // 2. Runtypes Record/withBrand dual export, Joi.object().keys(), createParamDecorator, and same-file validator method calls
  const schemaAndDecoratorCode = `
    import { Record, String, Static } from 'runtypes';
    import Joi from 'joi';
    import { createParamDecorator } from '@nestjs/common';

    export const UUID = String.withBrand('UUID');
    export type UUID = Static<typeof UUID>;

    export const UserRecord = Record({ id: UUID, name: String });
    export const LoginFilter = Joi.object().keys({ email: Joi.string() });
    export const CurrentUser = createParamDecorator((data, req) => req.user);

    export function validateId(val: unknown) {
      return UUID.check(val);
    }
  `;
  const sf = ts.createSourceFile('/repo/src/schemas.ts', schemaAndDecoratorCode, ts.ScriptTarget.Latest, true);
  const ev = makeEv('src/schemas.ts', sf);
  const nextId = makeNextId();
  const contracts: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];

  walkNodes(sf, (node) => {
    contracts.push(...toList(visitContract(node, sf, ev, nextId, null, 'src/schemas.ts')));
    rels.push(...toList(visitRelationship(node, sf, ev, nextId, '/repo', 'source-1')));
  });

  const contractNames = contracts.map((c) => c.name);
  assert.ok(contractNames.includes('VALIDATOR_SCHEMA: UUID'));
  assert.ok(contractNames.includes('VALIDATOR_SCHEMA: UserRecord'));
  assert.ok(contractNames.includes('VALIDATOR_SCHEMA: LoginFilter'));
  assert.ok(contractNames.includes('Exported Function: CurrentUser'));

  const uuidContract = contracts.find((c) => c.name === 'VALIDATOR_SCHEMA: UUID');
  const uuidContractId = uuidContract
    ? contractEntityId('repo', 'src/schemas.ts', uuidContract.name, uuidContract.patternId)
    : '';
  const uuidCheckCall = rels.find((r) => r.name === 'Call: UUID.check()');
  assert.ok(uuidContract && uuidCheckCall && uuidCheckCall.targetId === uuidContractId && uuidCheckCall.confidence === 'HIGH');

  // 3. Express route array middleware, class property handler callbacks, and top-level side-effect require()
  const expressAndRequireCode = `
    require('ts-node/register');
    export function checkJwt() {}
    export function checkRole(role: string) { return () => {}; }
    export class CoursesCtrl {
      getAllCourses() {}
      getLessonDetails() {}
    }
    export class Routes {
      coursesCtrl = new CoursesCtrl();
      constructor(app: any) {
        app.route('/api/courses').get(this.coursesCtrl.getAllCourses);
        app.post('/api/admin', [checkJwt, checkRole('ADMIN')], this.coursesCtrl.getLessonDetails);
      }
    }
  `;
  const expSf = ts.createSourceFile('/repo/src/routes.ts', expressAndRequireCode, ts.ScriptTarget.Latest, true);
  const expEv = makeEv('src/routes.ts', expSf);
  const expContracts: StructuralEntity[] = [];
  const expRels: StructuralEntity[] = [];
  walkNodes(expSf, (node) => {
    expContracts.push(...toList(visitContract(node, expSf, expEv, nextId, null, 'src/routes.ts')));
    expRels.push(...toList(visitRelationship(node, expSf, expEv, nextId, '/repo', 'source-routes')));
  });

  assert.ok(
    expRels.some(
      (r) =>
        r.name === 'Call: require()' &&
        r.targetId === stableEntityId('package:ts-node/register', 'OPEN_CONNECTOR', 'Package: ts-node/register')
    )
  );
  const getAllMethod = expContracts.find((c) => c.name === 'Public Method: CoursesCtrl.getAllCourses');
  const getLessonMethod = expContracts.find((c) => c.name === 'Public Method: CoursesCtrl.getLessonDetails');
  const checkJwtFn = expContracts.find((c) => c.name === 'Exported Function: checkJwt');
  const checkRoleFn = expContracts.find((c) => c.name === 'Exported Function: checkRole');
  const idOf = (c: StructuralEntity | undefined) =>
    c ? contractEntityId('repo', 'src/routes.ts', c.name, c.patternId) : '';

  const getAllCallbackEdge = expRels.find(
    (r) => r.patternId === 'relationship.callback-reference' && r.name.includes('getAllCourses')
  );
  const getLessonHandlerEdge = expRels.find(
    (r) => r.patternId === 'relationship.express-route-handler' && r.name.includes('getLessonDetails')
  );
  assert.ok(getAllMethod && getAllCallbackEdge?.targetId === idOf(getAllMethod));
  assert.ok(getLessonMethod && getLessonHandlerEdge?.targetId === idOf(getLessonMethod));
  assert.ok(checkJwtFn && expRels.some((r) => r.targetId === idOf(checkJwtFn)));
  assert.ok(checkRoleFn && expRels.some((r) => r.targetId === idOf(checkRoleFn)));

  // 4. Top-level entrypoint helper remains owned by Init: rather than bleeding into an inner Event Listener
  const entryCode = `
    import net from 'net';
    function bootHelper() {}
    async function createServer() {
      bootHelper();
    }
    createServer();
    process.stdin.on('data', () => {
      createServer();
    });
  `;
  const entrySf = ts.createSourceFile('src/devServer.ts', entryCode, ts.ScriptTarget.Latest, true);
  const listenerId = stableEntityId('repo', 'CONTRACT', 'Event Listener: data');
  const createServerDecl = entrySf.statements[2] as ts.FunctionDeclaration;
  const listenerStmt = entrySf.statements[4] as ts.ExpressionStatement;
  const ownerByNode = new Map<ts.Node, string>([[listenerStmt.expression, listenerId]]);
  propagateLocalHelperOwners(entrySf, ownerByNode);
  assert.equal(
    ownerByNode.get(createServerDecl),
    undefined,
    'Top-level entrypoint helper must not be hijacked by inner Event Listener'
  );
});

test('Wave 5 guards: colliding contract disambiguation, Drizzle prepared query .execute() deferral, fs-extra mutations, Next.js Route Handler HTTP stitching, and export default barrel exclusion', () => {
  // 1. Multi-file colliding contract keys disambiguate by file path while unique contracts keep Catalyst Hash
  try {
    setActiveCollidingContractKeys(new Set(['repo::Exported Function: verifySignature']));
    const colA = contractEntityId('repo', 'src/auth/jwtVerifier.ts', 'Exported Function: verifySignature');
    const colB = contractEntityId('repo', 'src/auth/dbAuthVerifier.ts', 'Exported Function: verifySignature');
    assert.notEqual(colA, colB, 'Colliding same-boundary contracts in different files must have distinct IDs');

    const uniqA = contractEntityId('repo', 'src/auth/jwtVerifier.ts', 'Exported Function: uniqueHelper');
    const uniqB = contractEntityId('repo', 'src/auth/movedHelper.ts', 'Exported Function: uniqueHelper');
    assert.equal(uniqA, uniqB, 'Unique contracts in a boundary must preserve file-independent Catalyst Hash');
  } finally {
    setActiveCollidingContractKeys(null);
  }

  // 2. Prepared Drizzle query (.prepare() -> .execute()) defers DB_QUERY + READS to .execute() call site
  const drizzlePrepCode = `
    import fs from 'fs-extra';
    const p1 = db.select().from(users).where(eq(users.id, 1)).prepare();
    export function getUserHandler() {
      fs.copySync('/src', '/dest');
      return p1.execute();
    }
    export default { getUserHandler };
  `;
  const prepSf = ts.createSourceFile('/repo/src/routes.ts', drizzlePrepCode, ts.ScriptTarget.Latest, true);
  const prepEv = makeEv('src/routes.ts', prepSf);
  const nextId = makeNextId();
  const connectors: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];
  walkNodes(prepSf, (node) => {
    connectors.push(
      ...toList(visitOpenConnector(node, prepSf, prepEv, nextId, '/repo')),
      ...toList(extractDrizzleQueryChain(node, prepEv, nextId))
    );
    rels.push(...toList(visitRelationship(node, prepSf, prepEv, nextId, '/repo', 'source-1')));
  });

  const drizzleQuery = connectors.find((c) => c.name === 'Drizzle Query: select()');
  const drizzleReads = connectors.find((c) => c.name === 'READS Schema: users');
  const fsCopy = connectors.find((c) => c.name === 'FS Write: fs.copySync');
  assert.ok(drizzleQuery && !Array.isArray(drizzleQuery.evidence) && drizzleQuery.evidence.snippet === 'p1.execute()');
  assert.ok(drizzleReads && !Array.isArray(drizzleReads.evidence) && drizzleReads.evidence.snippet === 'p1.execute()');
  assert.ok(fsCopy, 'Expected FS Write: fs.copySync open connector for fs-extra');
  assert.ok(
    !rels.some((r) => r.patternId === 'relationship.dispatch-table-reference'),
    'export default { getUserHandler } barrel must not emit dispatch-table-reference call edge'
  );

  // 3. Next.js Route Handler intra-repo HTTP protocol stitching
  const routeNode: StructuralNode = {
    id: 'route-get-data',
    name: 'Route Handler: GET',
    type: 'CONTRACT',
    entityType: 'HTTP_ENDPOINT',
    patternId: 'contract.nextjs-route-handler',
    evidence: { filePath: 'apps/web/src/app/api/builder/data/route.ts', lineNumber: 10 },
  };
  const fetchNode: StructuralNode = {
    id: 'http-fetch-1',
    name: 'HTTP Call: fetch',
    type: 'OPEN_CONNECTOR',
    entityType: 'HTTP_FETCH',
    patternId: 'open-connector.http-call',
    evidence: { filePath: 'apps/web/src/app/builder/client.tsx', lineNumber: 20 },
  };
  const nodes: StructuralNode[] = [routeNode, fetchNode];
  const edges: StructuralEdge[] = [
    {
      id: 'edge-1',
      name: 'Call: HTTP Call: fetch',
      type: 'RELATIONSHIP',
      entityType: 'CALL',
      patternId: 'generic.relationship',
      sourceId: 'client-comp',
      targetId: 'http-fetch-1',
      status: 'DETERMINISTIC',
      confidence: 'HIGH',
      evidence: { filePath: 'apps/web/src/app/builder/client.tsx', lineNumber: 20 },
      metadata: { httpMethod: 'GET', urlPath: '/api/builder/data' },
    },
  ];
  stitchIntraRepoHttpCalls(nodes, edges, new Map([['http-fetch-1', fetchNode]]));
  assert.equal(edges[0].targetId, 'route-get-data');
  assert.equal(edges[0].entityType, 'HTTP_FETCH');
  assert.ok(!nodes.some((n) => n.id === 'http-fetch-1'), 'Fully stitched HTTP_FETCH node must be pruned');
});

test('Wave 7 patterns: NestJS/FoalTS decorator INGRESS metadata, Hono OpenAPI routes, Astro APIRoute, citty defineCommand, TypeORM/Supabase/Electron/Hook open connectors, and subrouter/event/DI wiring', () => {
  const wave7Code = `
    import { createRoute } from '@hono/zod-openapi';
    import { defineCommand } from 'citty';
    import type { APIRoute } from 'astro';
    import { ipcRenderer } from 'electron';

    export const listRoute = createRoute({
      method: 'get',
      path: '/tasks',
    });

    export const devCmd = defineCommand({
      meta: { name: 'dev' },
      run() {},
    });

    export const get: APIRoute = async () => new Response('ok');

    export abstract class NotificationPort {
      abstract send(msg: string): Promise<void>;
    }

    export class EmailAdapter extends NotificationPort {
      async send(msg: string) {}
    }

    export class JwtAuthGuard {
      canActivate() {
        return true;
      }
    }

    export class TasksController {
      constructor(
        @InjectRepository(Task) private readonly taskRepo: Repository<Task>,
        @Inject(NotificationPort) private readonly notifier: NotificationPort,
        private readonly eventEmitter: EventEmitter2,
      ) {}

      @Get('/tasks')
      @UseGuards(JwtAuthGuard)
      async listTasks() {
        const supabase = await createClient();
        await supabase.auth.getUser();
        const { endpoint } = useServer();
        await endpoint.post('/audit');
        ipcRenderer.invoke('sync-tasks');
        this.eventEmitter.emit('task.listed');
        await this.notifier.send('listed');
        return this.taskRepo.find();
      }

      @OnEvent('task.listed')
      handleTaskListed() {}
    }

    router.openapi(listRoute, (c) => c.json([]));
    app.doc('/doc', { openapi: '3.0.0' });
    app.use('/api/v1', authMiddleware, tasksRouter);
  `;

  const sf = ts.createSourceFile('/repo/src/tasks.controller.ts', wave7Code, ts.ScriptTarget.Latest, true);
  const ev = makeEv('src/tasks.controller.ts', sf);
  const nextId = makeNextId();
  const contracts: StructuralEntity[] = [];
  const connectors: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];
  const mounts: StructuralEntity[] = [];
  const middlewares: StructuralEntity[] = [];

  walkNodes(sf, (node) => {
    contracts.push(...toList(visitContract(node, sf, ev, nextId, null, 'src/tasks.controller.ts')));
    connectors.push(...toList(visitOpenConnector(node, sf, ev, nextId, '/repo')));
    rels.push(...toList(visitRelationship(node, sf, ev, nextId, '/repo', 'source-tasks')));
    mounts.push(...toList(extractExpressRouterMount(node, sf, ev, nextId, 'source-tasks')));
    middlewares.push(...toList(extractExpressMiddlewareBoundary(node, sf, ev, nextId)));
  });

  // 1. NestJS @Get and @OnEvent public methods carry flowRole: 'INGRESS'
  const listTasksMethod = contracts.find((c) => c.name === 'Public Method: TasksController.listTasks');
  const handleTaskListedMethod = contracts.find((c) => c.name === 'Public Method: TasksController.handleTaskListed');
  assert.equal(listTasksMethod?.metadata?.flowRole, 'INGRESS');
  assert.equal(handleTaskListedMethod?.metadata?.flowRole, 'INGRESS');
  assert.equal(handleTaskListedMethod?.metadata?.eventKey, 'task.listed');

  // 2. Hono OpenAPI router.openapi(listRoute, handler), app.doc('/doc', ...), Astro APIRoute, and citty defineCommand
  assert.ok(contracts.some((c) => c.name === 'Express Route: GET /tasks' && c.entityType === 'HTTP_ENDPOINT'));
  assert.ok(contracts.some((c) => c.name === 'Express Route: GET /doc' && c.entityType === 'HTTP_ENDPOINT'));
  assert.ok(contracts.some((c) => c.name === 'Route Handler: GET' && c.patternId === 'contract.nextjs-route-handler'));
  assert.ok(contracts.some((c) => c.name === 'Exported Function: devCmd'));

  // 3. TypeORM repository, Supabase auth SDK, custom hook HTTP endpoint, and Electron IPC open connectors
  const connectorNames = connectors.map((c) => c.name);
  assert.ok(connectorNames.includes('DB Call: taskRepo.find'));
  assert.ok(connectorNames.includes('DB Call: supabase.auth.getUser'));
  assert.ok(connectorNames.includes('HTTP Call: endpoint.post'));
  assert.ok(connectorNames.includes('Socket Call: ipcRenderer.invoke'));

  // 4. Event emitter pub/sub, @UseGuards edge, abstract Port -> Concrete Adapter edge, and 3-arg subrouter mount
  const handleListedId = contractEntityId(
    'repo',
    'src/tasks.controller.ts',
    'Public Method: TasksController.handleTaskListed',
    'contract.public-method'
  );
  const emailSendId = contractEntityId(
    'repo',
    'src/tasks.controller.ts',
    'Public Method: EmailAdapter.send',
    'contract.public-method'
  );
  assert.ok(rels.some((r) => r.name === 'Call: this.eventEmitter.emit()' && r.targetId === handleListedId));
  assert.ok(rels.some((r) => r.name === 'Call: JwtAuthGuard.canActivate()'));
  assert.ok(rels.some((r) => r.name === 'Call: EmailAdapter.send()' && r.targetId === emailSendId));
  assert.ok(mounts.some((m) => m.name === 'Express Mount: /api/v1 -> tasksRouter'));
  assert.ok(!middlewares.some((m) => m.name.includes('tasksRouter')));
});

test('Wave 8 patterns: Payload orphan filtering, Object.assign/HOC compound components, Astro/MDX, Commander/CLI entry, Remix, node:http route branch, and dispatch maps', () => {
  // 1. Payload declarative schemas and PROPERTY_GETTER are excluded from orphan measurement
  const orphanRows = measureOrphanShapeResolution({
    nodes: [
      {
        id: 'c1',
        name: 'Payload Block: Banner',
        type: 'CONTRACT',
        entityType: 'PAYLOAD_BLOCK',
        patternId: 'contract.payload-block-definition',
        scope: 'USER',
        evidence: { filePath: 'src/blocks/Banner.ts', lineNumber: 1 },
      },
      {
        id: 'c2',
        name: 'Payload Collection: Posts',
        type: 'CONTRACT',
        entityType: 'PAYLOAD_COLLECTION',
        patternId: 'contract.payload-collection-config',
        scope: 'USER',
        evidence: { filePath: 'src/collections/Posts.ts', lineNumber: 1 },
      },
      {
        id: 'c3',
        name: 'Getter: mask',
        type: 'CONTRACT',
        entityType: 'PROPERTY_GETTER',
        patternId: 'contract.define-property',
        scope: 'USER',
        evidence: { filePath: 'src/mask.ts', lineNumber: 1 },
      },
      {
        id: 'c4',
        name: 'Exported Function: command:create',
        type: 'CONTRACT',
        entityType: 'CLI_COMMAND',
        patternId: 'contract.exported-function',
        scope: 'USER',
        evidence: { filePath: 'src/cli.ts', lineNumber: 1 },
      },
    ],
    edges: [],
  });
  assert.equal(orphanRows.filter((r) => r.unresolved > 0).length, 0);
  assert.equal(orphanRows.find((r) => r.shapeKey.includes('CLI_COMMAND'))?.resolved, 1);

  // 2. Astro & MDX preprocessing preserves line numbers and wraps template PascalCase components
  const astroRaw = [
    '---',
    "import BaseLayout from '../layouts/BaseLayout.astro';",
    "import HeroCard from '../components/HeroCard.tsx';",
    '---',
    '<BaseLayout title="Home">',
    '  <HeroCard variant={primaryVariant} />',
    '</BaseLayout>',
  ].join('\n');
  const preprocessedAstro = preprocessAstroOrMdxSource('/repo/src/pages/index.astro', astroRaw);
  const astroLines = preprocessedAstro.split('\n');
  assert.equal(astroLines.length, 7);
  assert.ok(astroLines[1].includes('import BaseLayout'));
  assert.ok(astroLines[4].includes('<BaseLayout />'));
  assert.ok(astroLines[5].includes('<HeroCard variant={primaryVariant} />'));
  const astroSf = ts.createSourceFile(
    '/repo/src/pages/index.astro',
    preprocessedAstro,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const astroContracts: StructuralEntity[] = [];
  walkNodes(astroSf, (n) => {
    astroContracts.push(
      ...toList(visitContract(n, astroSf, makeEv('src/pages/index.astro', astroSf), makeNextId(), null, 'src/pages/index.astro'))
    );
  });
  assert.ok(
    astroContracts.some(
      (c) => c.name === 'Module Export (Default)' && c.metadata?.flowRole === 'INGRESS'
    )
  );

  // 3. Wave 8 TSX/CLI/Remix/node:http/Dispatch/CJS patterns
  const wave8Code = `
    import React, { forwardRef } from 'react';
    import { useLoaderData, useActionData } from '@remix-run/react';

    const Root = forwardRef<HTMLDivElement, {}>((props, ref) => <div ref={ref} />);
    export const DataTableSelectionBar = { Root };
    export const Section = Object.assign((props: any) => <section>{props.children}</section>, { Root });

    export function TextCell() { return <span />; }
    export function NumberCell() { return <strong />; }
    const COLUMN_HEADER_COMPONENTS = { text: TextCell, number: NumberCell };

    export async function loader() { return { items: [] }; }
    export async function action() { return { ok: true }; }
    export default function NotesRoute() {
      const data = useLoaderData<typeof loader>();
      const act = useActionData<typeof action>();
      return <div headerComponents={COLUMN_HEADER_COMPONENTS} />;
    }

    export function nextAuthInstaller() {}
    export function prismaInstaller() {}
    const pkgMap = {
      nextAuth: { installer: nextAuthInstaller },
      prisma: { installer: prismaInstaller },
    };
    export function installPackages(packages: typeof pkgMap) {
      for (const [, pkgOpts] of Object.entries(packages)) {
        pkgOpts.installer();
      }
    }

    export class EmailSequenceJob {
      public handler(job: any) {}
    }
    agenda.define('send-email', new EmailSequenceJob().handler);

    if (req.method === 'GET' && pathname === '/admin/api/stats') {
      res.end('ok');
    }

    program
      .command('create <project>')
      .description('Create project')
      .action(nextAuthInstaller);

    const main = async () => {
      nextAuthInstaller();
    };
    main().catch(console.error);

    export function createAdapter() {}
    exports = module.exports = createAdapter;
  `;

  const sf = ts.createSourceFile(
    '/repo/app/routes/notes.tsx',
    wave8Code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const ev = makeEv('app/routes/notes.tsx', sf);
  const nextId = makeNextId();
  const contracts: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];

  walkNodes(sf, (node) => {
    contracts.push(...toList(visitContract(node, sf, ev, nextId, null, 'app/routes/notes.tsx')));
    rels.push(...toList(visitRelationship(node, sf, ev, nextId, '/repo', 'source-notes')));
  });

  // Object.assign & HOC compound component object exports
  assert.ok(contracts.some((c) => c.name === 'Exported Function: DataTableSelectionBar'));
  assert.ok(contracts.some((c) => c.name === 'Exported Function: Section'));

  // Commander .command().action() & CLI unexported main().catch()
  assert.ok(
    contracts.some(
      (c) => c.name === 'Exported Function: command:create' && c.metadata?.flowRole === 'INGRESS'
    )
  );
  assert.ok(
    contracts.some((c) => c.name === 'Exported Function: main' && c.metadata?.flowRole === 'INGRESS')
  );

  // Raw node:http route branch
  assert.ok(
    contracts.some(
      (c) => c.name === 'Express Route: GET /admin/api/stats' && c.entityType === 'HTTP_ENDPOINT'
    )
  );

  // Remix route module conventions (loader/action/default INGRESS + useLoaderData/useActionData edges)
  const loaderContract = contracts.find((c) => c.name === 'Exported Function: loader');
  const actionContract = contracts.find((c) => c.name === 'Exported Function: action');
  assert.equal(loaderContract?.metadata?.flowRole, 'INGRESS');
  assert.equal(actionContract?.metadata?.flowRole, 'INGRESS');
  const loaderId = contractEntityId(
    'repo',
    'app/routes/notes.tsx',
    'Exported Function: loader',
    'contract.exported-function'
  );
  const actionId = contractEntityId(
    'repo',
    'app/routes/notes.tsx',
    'Exported Function: action',
    'contract.exported-function'
  );
  assert.ok(rels.some((r) => r.name === 'Call: useLoaderData()' && r.targetId === loaderId));
  assert.ok(rels.some((r) => r.name === 'Call: useActionData()' && r.targetId === actionId));

  // Component map prop dispatch (<div headerComponents={COLUMN_HEADER_COMPONENTS} />)
  assert.ok(rels.some((r) => r.name === 'Renders: <TextCell />' && r.entityType === 'RENDERS'));
  assert.ok(rels.some((r) => r.name === 'Renders: <NumberCell />' && r.entityType === 'RENDERS'));

  // Typed dispatch map loop invocation (pkgOpts.installer())
  const nextAuthId = contractEntityId(
    'repo',
    'app/routes/notes.tsx',
    'Exported Function: nextAuthInstaller',
    'contract.exported-function'
  );
  assert.ok(rels.some((r) => r.name === 'Call: pkgOpts.installer()' && r.targetId === nextAuthId));

  // Agenda job define handler & CommonJS export assignment target
  const emailHandlerId = contractEntityId(
    'repo',
    'app/routes/notes.tsx',
    'Public Method: EmailSequenceJob.handler',
    'contract.public-method'
  );
  const createAdapterId = contractEntityId(
    'repo',
    'app/routes/notes.tsx',
    'Exported Function: createAdapter',
    'contract.exported-function'
  );
  assert.ok(rels.some((r) => r.targetId === emailHandlerId && r.patternId === 'relationship.callback-reference'));
  assert.ok(rels.some((r) => r.name === 'Call: createAdapter()' && r.targetId === createAdapterId));
});

test('Backlog High-Priority Extractor Fixes: Next.js Metadata/Config scoping, inline Server Actions, Axios interceptor guards, and Express .route() chained middleware/handlers', () => {
  // 1. Next.js Metadata & Route Config are file-scoped in contractEntityId and restricted to route roles with routePath metadata
  const rootMetaId = contractEntityId('web', 'app/layout.tsx', 'Next.js Metadata', 'contract.nextjs-metadata-export');
  const blogMetaId = contractEntityId('web', 'app/blog/page.tsx', 'Next.js Metadata', 'contract.nextjs-metadata-export');
  assert.notEqual(rootMetaId, blogMetaId, 'Next.js Metadata across distinct routes must have distinct IDs');

  const rootCfgId = contractEntityId('web', 'app/layout.tsx', 'Next.js Config: dynamic', 'contract.nextjs-route-config');
  const apiCfgId = contractEntityId('web', 'app/api/chat/route.ts', 'Next.js Config: dynamic', 'contract.nextjs-route-config');
  assert.notEqual(rootCfgId, apiCfgId, 'Next.js Config across distinct routes must have distinct IDs');

  const pageSf = parse(`
    export const metadata = { title: 'Blog' };
    export const dynamic = 'force-dynamic';
    export default function BlogPage() {
      async function createDraft(formData: FormData) {
        'use server';
      }
      return null;
    }
  `);
  const pageEv = makeEv('app/blog/page.tsx', pageSf);
  const nextId = makeNextId();
  const pageContracts: StructuralEntity[] = [];
  walkNodes(pageSf, (node) => {
    pageContracts.push(...toList(visitContract(node, pageSf, pageEv, nextId, 'PAGE', 'app/blog/page.tsx')));
  });
  const metaNode = pageContracts.find((c) => c.name === 'Next.js Metadata');
  const cfgNode = pageContracts.find((c) => c.name === 'Next.js Config: dynamic');
  const inlineActionNode = pageContracts.find((c) => c.name === 'Server Action: createDraft');
  assert.ok(metaNode, 'PAGE role must extract Next.js Metadata');
  assert.equal(metaNode.metadata?.routePath, '/blog');
  assert.ok(cfgNode, 'PAGE role must extract Next.js Config: dynamic');
  assert.equal(cfgNode.metadata?.routePath, '/blog');
  assert.ok(inlineActionNode, 'Inline function with "use server" directive inside Server Component must extract as SERVER_ACTION');

  // Non-route utility file exporting `metadata` or `runtime` must NOT emit Next.js route contracts
  const utilSf = parse(`
    export const metadata = { version: 1 };
    export const runtime = 'nodejs';
  `);
  const utilEv = makeEv('src/lib/constants.ts', utilSf);
  const utilContracts: StructuralEntity[] = [];
  walkNodes(utilSf, (node) => {
    utilContracts.push(...toList(visitContract(node, utilSf, utilEv, nextId, null, 'src/lib/constants.ts')));
  });
  assert.equal(utilContracts.length, 0, 'Non-route utility file must not emit Next.js Metadata or Next.js Config');

  // 2. Axios / HTTP client instances and interceptors must not emit Express Route or Middleware contracts
  const axiosSf = parse(`
    const apiClient = axios.create({ baseURL: '/api' });
    apiClient.interceptors.request.use((config) => config);
    axiosInstance.interceptors.response.use((res) => res);
    apiClient.get('/users');
    apiClient.delete('/users/1');
  `);
  const axiosEv = makeEv('src/api/client.ts', axiosSf);
  const axiosContracts: StructuralEntity[] = [];
  walkNodes(axiosSf, (node) => {
    axiosContracts.push(...toList(visitContract(node, axiosSf, axiosEv, nextId, null, 'src/api/client.ts')));
  });
  assert.equal(
    axiosContracts.filter((c) => c.patternId === 'contract.express-route' || c.patternId === 'boundary.express-middleware').length,
    0,
    'axios.create, interceptors.*.use, and apiClient.get/delete must never emit Express Route or Middleware contracts'
  );

  // 3. Express .route('/:userId').get(...).patch(...).delete(...) extracts per-method middleware & handler edges with httpMethod metadata
  const routeChainSf = parse(`
    router
      .route('/:userId')
      .get(auth('getUsers'), validate(userValidation.getUser), userController.getUser)
      .patch(auth('manageUsers'), validate(userValidation.updateUser), userController.updateUser)
      .delete(auth('manageUsers'), validate(userValidation.deleteUser), userController.deleteUser);
  `);
  const routeChainEv = makeEv('src/routes/v1/user.route.js', routeChainSf);
  const chainEdges: StructuralEntity[] = [];
  walkNodes(routeChainSf, (node) => {
    chainEdges.push(...toList(extractExpressRouteMiddleware(node, routeChainSf, routeChainEv, nextId, 'init-users')));
  });
  const intercepts = chainEdges.filter((e) => e.entityType === 'INTERCEPTS');
  const binds = chainEdges.filter((e) => e.entityType === 'BINDS_ROUTE');
  assert.equal(intercepts.length, 6, 'Expected 2 middleware INTERCEPTS edges per HTTP method (GET, PATCH, DELETE)');
  assert.deepEqual(
    intercepts.map((e) => [e.name, e.metadata?.httpMethod]),
    [
      ['Express Mount: /:userId -> auth()', 'DELETE'],
      ['Express Mount: /:userId -> validate()', 'DELETE'],
      ['Express Mount: /:userId -> auth()', 'PATCH'],
      ['Express Mount: /:userId -> validate()', 'PATCH'],
      ['Express Mount: /:userId -> auth()', 'GET'],
      ['Express Mount: /:userId -> validate()', 'GET'],
    ]
  );
  assert.deepEqual(
    binds.map((e) => [e.name, e.metadata?.httpMethod]),
    [
      ['Express Bind: /:userId -> userController.deleteUser', 'DELETE'],
      ['Express Bind: /:userId -> userController.updateUser', 'PATCH'],
      ['Express Bind: /:userId -> userController.getUser', 'GET'],
    ]
  );
});

test('[PAT-EXT-34..37] Chained Call Receivers, External Class Nested Property & Typed Parameter Chains, Multi-Depth Object & Class Property Members, and Drizzle createTable Schemas', () => {
  const code = `
    import { Sprite } from 'pixi.js';
    import { Command } from 'commander';
    import { pgTableCreator, serial, text } from 'drizzle-orm/pg-core';

    export const createTable = pgTableCreator((name) => \`app_\${name}\`);
    export const posts = createTable('post', { id: serial('id'), title: text('title') });
    const customTable = pgTableCreator((name) => \`custom_\${name}\`);
    export const comments = customTable('comment', { id: serial('id') });
    export const notATable = createTable();

    export const api = {
      v1: {
        users: {
          list: () => [],
        },
      },
    };

    export class HttpError extends Error {
      static Factory = {
        NotFound: (msg: string) => new HttpError(msg),
      };
    }

    export function getIndex() {
      return { byName: new Map<string, string>() };
    }

    export function renderBanner() {
      return 'banner';
    }

    export function registerCli(program: Command) {
      const sprite = new Sprite();
      sprite.position.set(10, 20);

      const subCmd = program.command('sub').description('Subcommand');
      subCmd.option('-v, --verbose', 'Verbose');

      getIndex().byName.get('key');
      renderBanner().format();
      renderBanner().split('\\n');
      HttpError.Factory.NotFound('missing');
    }
  `;

  const sf = ts.createSourceFile(
    '/repo/src/pat34_37.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const ev = makeEv('src/pat34_37.ts', sf);
  const nextId = makeNextId();
  const contracts: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];

  walkNodes(sf, (node) => {
    contracts.push(...toList(visitContract(node, sf, ev, nextId, null, 'src/pat34_37.ts')));
    rels.push(...toList(visitRelationship(node, sf, ev, nextId, '/repo', 'source-pat34-37')));
  });

  // [PAT-EXT-37] Drizzle createTable & pgTableCreator custom builder schemas
  assert.ok(
    contracts.some((c) => c.name === 'Drizzle Schema: posts' && c.entityType === 'DB_SCHEMA'),
    'createTable("post", {...}) must emit DB_SCHEMA contract'
  );
  assert.ok(
    contracts.some((c) => c.name === 'Drizzle Schema: comments' && c.entityType === 'DB_SCHEMA'),
    'Same-file pgTableCreator variable customTable("comment", {...}) must emit DB_SCHEMA contract'
  );
  assert.ok(
    !contracts.some((c) => c.name === 'Drizzle Schema: notATable'),
    'Zero-arg createTable() must not false-positive as a Drizzle DB_SCHEMA'
  );

  // [PAT-EXT-36] Multi-depth (2+-level) exported object-literal contract & static class object-literal property method
  assert.ok(
    contracts.some((c) => c.name === 'Exported Function: api.v1.users.list' && c.entityType === 'EXPORTED_FUNCTION'),
    '2+-level nested callable object literal must emit Exported Function: api.v1.users.list'
  );
  const notFoundMethodId = contractEntityId(
    'repo',
    'src/pat34_37.ts',
    'Public Method: HttpError.Factory.NotFound',
    'contract.public-method'
  );
  assert.ok(
    contracts.some((c) => c.name === 'Public Method: HttpError.Factory.NotFound' && c.entityType === 'PUBLIC_METHOD'),
    'Class property initialized with callable object literal must emit Public Method: HttpError.Factory.NotFound'
  );
  assert.ok(
    rels.some((r) => r.targetId === notFoundMethodId),
    'HttpError.Factory.NotFound() must resolve to Public Method: HttpError.Factory.NotFound'
  );

  // [PAT-EXT-35] External class instance nested property call & typed parameter builder chain
  const pixiPkgId = stableEntityId('package:pixi.js', 'OPEN_CONNECTOR', 'Package: pixi.js');
  const commanderPkgId = stableEntityId('package:commander', 'OPEN_CONNECTOR', 'Package: commander');
  assert.ok(
    rels.some((r) => r.name === 'Call: sprite.set()' && r.targetId === pixiPkgId),
    'Nested property method call on new Sprite() instance (sprite.position.set) must resolve to Package: pixi.js'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: subCmd.option()' && r.targetId === commanderPkgId),
    'LocalFromCall variable initialized from value-imported typed parameter (program: Command) must resolve to Package: commander'
  );

  // [PAT-EXT-34] Chained calls on same-file exported functions
  const getIndexId = contractEntityId(
    'repo',
    'src/pat34_37.ts',
    'Exported Function: getIndex',
    'contract.exported-function'
  );
  const renderBannerId = contractEntityId(
    'repo',
    'src/pat34_37.ts',
    'Exported Function: renderBanner',
    'contract.exported-function'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: getIndex.get()' && r.targetId === getIndexId),
    'getIndex().byName.get() must resolve to Exported Function: getIndex'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: renderBanner.format()' && r.targetId === renderBannerId),
    'renderBanner().format() must resolve to Exported Function: renderBanner'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: renderBanner()' && r.targetId === renderBannerId),
    'inner renderBanner() call in renderBanner().split() must resolve to Exported Function: renderBanner'
  );
  assert.ok(
    !rels.some((r) => r.name === 'Call: renderBanner.split()' && r.targetId === renderBannerId),
    'renderBanner().split() must not falsely attribute built-in String.prototype.split back to Exported Function: renderBanner'
  );
});

test('[PAT-EXT-38]..[PAT-EXT-41]: fluent & optional-chained this.<prop> calls, curried/bound calls, LocalFromNew builder chains, and compound component / CJS alias guard', () => {
  const code = `
    import { Socket } from 'net';
    import { Gitlab } from '@gitbeaker/rest';
    import { FormGroup, NgControl } from '@angular/forms';

    export class EventBuilder {
      withEventType(id: number) {
        return this;
      }
      static api = {
        v1: {
          list: () => [],
        },
      };
    }

    export class StickerQueueService {
      private queue: Promise<unknown> = Promise.resolve();
      private socket: Socket | null = null;
      private gitlab!: Gitlab;
      private ngControl: NgControl | null = null;
      private calculatorForm!: FormGroup;

      render() {
        const job = this.queue.then(() => this.renderNow());
        this.socket?.setNoDelay(true);
        this.gitlab.repos.get(1);
        this.ngControl?.control?.hasValidator(() => null);
        this.calculatorForm.get('x')?.valueChanges.pipe();
        return job;
      }

      private renderNow() {
        return true;
      }
    }

    export function takeLimit(limit: number) {
      return (items: unknown[]) => items.slice(0, limit);
    }

    export function handleBooking(ctx: unknown) {
      return ctx;
    }

    export function getInputs() {
      return [];
    }

    export const Select = (props: { children?: unknown }) => <div>{props.children}</div>;
    Select.Option = (props: { value: string }) => <option value={props.value} />;

    export function runAll(reader: { onloadstart?: () => void }) {
      const localReader = { onloadstart: () => {} };
      localReader.onloadstart = () => {};
      reader.onloadstart = () => {};

      const builder = new EventBuilder();
      builder.withEventType(1).withMetadataAndResponses();

      takeLimit(10)([1, 2, 3]);
      handleBooking.bind(null)({ id: 1 });
      (getInputs as any).read();
      EventBuilder.api.v1.list();

      return <Select><Select.Option value="a" /></Select>;
    }
  `;

  const sf = ts.createSourceFile(
    '/repo/src/pat38_41.tsx',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const ev = makeEv('src/pat38_41.tsx', sf);
  const nextId = makeNextId();
  const contracts: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];

  walkNodes(sf, (node) => {
    contracts.push(...toList(visitContract(node, sf, ev, nextId, null, 'src/pat38_41.tsx')));
    rels.push(...toList(visitRelationship(node, sf, ev, nextId, '/repo', 'source-pat38-41')));
  });

  // [PAT-EXT-39] this.<prop> Promise queue, union-typed optional chains, nested SDK resources, LocalFromNew builder chains
  const stickerClassId = stableEntityId('repo', 'BOUNDARY', 'Class: StickerQueueService');
  const netPkgId = stableEntityId('package:net', 'OPEN_CONNECTOR', 'Package: net');
  const gitbeakerPkgId = stableEntityId('package:@gitbeaker/rest', 'OPEN_CONNECTOR', 'Package: @gitbeaker/rest');
  const ngFormsPkgId = stableEntityId('package:@angular/forms', 'OPEN_CONNECTOR', 'Package: @angular/forms');
  const withEventTypeId = contractEntityId(
    'repo',
    'src/pat38_41.tsx',
    'Public Method: EventBuilder.withEventType',
    'contract.public-method'
  );

  assert.ok(
    rels.some((r) => r.name === 'Call: this.then()' && r.targetId === stickerClassId),
    'this.queue.then(() => this.renderNow()) on Promise field must resolve to Class: StickerQueueService'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: this.setNoDelay()' && r.targetId === netPkgId),
    'this.socket?.setNoDelay() on Socket | null must resolve to Package: net'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: this.get()' && r.targetId === gitbeakerPkgId),
    'this.gitlab.repos.get() must resolve to Package: @gitbeaker/rest'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: this.hasValidator()' && r.targetId === ngFormsPkgId),
    'this.ngControl?.control?.hasValidator() must resolve to Package: @angular/forms'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: this.pipe()' && r.targetId === ngFormsPkgId),
    'this.calculatorForm.get("x")?.valueChanges.pipe() must resolve to Package: @angular/forms'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: builder.withMetadataAndResponses()' && r.targetId === withEventTypeId),
    'builder.withEventType(1).withMetadataAndResponses() must resolve to Public Method: EventBuilder.withEventType'
  );

  // [PAT-EXT-40] Curried / .bind(this) function invocations, LocalFunction property call, 2+-level class object method
  const takeLimitId = contractEntityId(
    'repo',
    'src/pat38_41.tsx',
    'Exported Function: takeLimit',
    'contract.exported-function'
  );
  const handleBookingId = contractEntityId(
    'repo',
    'src/pat38_41.tsx',
    'Exported Function: handleBooking',
    'contract.exported-function'
  );
  const getInputsId = contractEntityId(
    'repo',
    'src/pat38_41.tsx',
    'Exported Function: getInputs',
    'contract.exported-function'
  );
  const apiV1ListId = contractEntityId(
    'repo',
    'src/pat38_41.tsx',
    'Public Method: EventBuilder.api.v1.list',
    'contract.public-method'
  );

  assert.ok(
    rels.some((r) => r.name === 'Call: takeLimit()()' && r.targetId === takeLimitId),
    'takeLimit(10)(items) must resolve to Exported Function: takeLimit'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: bind()()' && r.targetId === handleBookingId),
    'handleBooking.bind(null)(...) must resolve to Exported Function: handleBooking'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: getInputs.read()' && r.targetId === getInputsId),
    'getInputs.read() must resolve to Exported Function: getInputs'
  );
  assert.ok(
    contracts.some((c) => c.name === 'Public Method: EventBuilder.api.v1.list'),
    '2-level static class object literal must emit Public Method: EventBuilder.api.v1.list'
  );
  assert.ok(
    rels.some((r) => r.targetId === apiV1ListId),
    'EventBuilder.api.v1.list() must resolve to Public Method: EventBuilder.api.v1.list'
  );

  // [PAT-EXT-41] Compound component Select.Option & false-positive guard for function-scoped/DOM assignments
  const selectOptionId = contractEntityId(
    'repo',
    'src/pat38_41.tsx',
    'CJS Export Alias: Select.Option',
    'contract.cjs-module-exports-alias'
  );
  assert.ok(
    contracts.some((c) => c.name === 'CJS Export Alias: Select.Option'),
    'Top-level Select.Option = ... must emit CJS Export Alias: Select.Option'
  );
  assert.ok(
    !contracts.some((c) => c.name.includes('onloadstart')),
    'Function-scoped or DOM event handler assignments (reader.onloadstart = ...) must not emit CJS Export Alias contracts'
  );
  assert.ok(
    rels.some((r) => r.name === 'Renders: <Select.Option />' && r.targetId === selectOptionId),
    'Same-file <Select.Option /> must resolve to CJS Export Alias: Select.Option'
  );

  // [PAT-EXT-38] Chained builder calls on imported object literals, namespace imports, and imported classes
  const nestedObjRepo = fixture('nested-object-literal-exports');
  const pat38CallerPath = path.join(nestedObjRepo, 'pat38Caller.ts');
  const pat38Code = `
    import { clientsAPI, briefsAPI } from './api.js';
    import * as apiNs from './api.js';

    export function runImportedBuilderChains() {
      clientsAPI.getAll().withAuth();
      clientsAPI.getAll().withAuth().execute();
      briefsAPI.server.getAll().execute();
      apiNs.briefsAPI.server.getAll();
    }
  `;
  const pat38Sf = ts.createSourceFile(pat38CallerPath, pat38Code, ts.ScriptTarget.Latest, true);
  const pat38Ev = makeEv('pat38Caller.ts', pat38Sf);
  const pat38Rels: StructuralEntity[] = [];
  walkNodes(pat38Sf, (node) => {
    pat38Rels.push(...toList(visitRelationship(node, pat38Sf, pat38Ev, nextId, nestedObjRepo, 'source-pat38')));
  });

  const clientsGetAllId = contractEntityId(
    'nested-object-literal-exports',
    'api.ts',
    'Exported Function: clientsAPI',
    'contract.exported-function'
  );
  const briefsGetAllId = contractEntityId(
    'nested-object-literal-exports',
    'api.ts',
    'Exported Function: briefsAPI.server.getAll',
    'contract.exported-function'
  );
  assert.ok(
    pat38Rels.some((r) => r.name === 'Call: clientsAPI.withAuth()' && r.targetId === clientsGetAllId),
    'clientsAPI.getAll().withAuth() (ImportObject Prop(Call(Prop(Id)))) must resolve to Exported Function: clientsAPI'
  );
  assert.ok(
    pat38Rels.some(
      (r) => r.name === 'Call: clientsAPI.execute()' && r.targetId === clientsGetAllId
    ),
    'clientsAPI.getAll().withAuth().execute() (ImportObject Prop(Call(Prop(Call(..))))) must resolve to Exported Function: clientsAPI'
  );
  assert.ok(
    pat38Rels.some((r) => r.name === 'Call: briefsAPI.execute()' && r.targetId === briefsGetAllId),
    'briefsAPI.server.getAll().execute() (Import Prop(Call(Prop(Prop(..))))) must resolve to Exported Function: briefsAPI.server.getAll'
  );
  assert.ok(
    pat38Rels.some((r) => r.name === 'Call: apiNs.getAll()' && r.targetId === briefsGetAllId),
    'apiNs.briefsAPI.server.getAll() (ImportNamespace Prop(Prop(Prop(Id)))) must resolve to Exported Function: briefsAPI.server.getAll'
  );
});

test('[PAT-EXT-42]: built-in prototype chain guard, mixed service facade objects, new Class().method() chains, private subclass helper guard, and external named re-exports', () => {
  const nestedObjRepo = fixture('nested-object-literal-exports');
  const nextId = makeNextId();

  const facadePath = path.join(nestedObjRepo, 'facade.ts');
  const facadeCode = `
    import { BaseExceptionFilter } from '@nestjs/core';
    import { clientsAPI } from './api.js';
    export { exec } from '@actions/exec';

    function createHandler(fn: (ctx: unknown) => unknown) {
      return fn;
    }

    const issueToken = (userId: string) => userId;

    export const verificationService = {
      issueToken,
    };

    export const userService = {
      getAll: clientsAPI.getAll,
      handle: createHandler((ctx) => ctx),
      async update(id: string) {
        return id;
      },
    };

    export class WorkerRunner {
      executeJob(name: string) {
        return name;
      }
    }

    export class PrismaExceptionFilter extends BaseExceptionFilter {
      catch(exception: unknown) {
        this.catchClientKnownRequestError(exception);
        new WorkerRunner().executeJob('sync');
        clientsAPI.getAll().filter((x: unknown) => Boolean(x));
      }

      private catchClientKnownRequestError(err: unknown) {
        return err;
      }
    }
  `;

  const facadeSf = ts.createSourceFile(facadePath, facadeCode, ts.ScriptTarget.Latest, true);
  const facadeEv = makeEv('facade.ts', facadeSf);
  const contracts: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];
  const connectors: StructuralEntity[] = [];

  walkNodes(facadeSf, (node) => {
    contracts.push(...toList(visitContract(node, facadeSf, facadeEv, nextId, null, 'facade.ts')));
    rels.push(
      ...toList(visitRelationship(node, facadeSf, facadeEv, nextId, nestedObjRepo, 'source-pat42'))
    );
    connectors.push(...toList(visitOpenConnector(node, facadeSf, facadeEv, nextId, nestedObjRepo)));
  });

  // 1. Mixed service facade object (`userService`) & shorthand local helper object (`verificationService`)
  assert.ok(
    contracts.some((c) => c.name === 'Exported Function: userService'),
    'Exported object literal mixing property-access delegation, HOF-wrapped handler, and method must emit Exported Function: userService'
  );
  assert.ok(
    contracts.some((c) => c.name === 'Exported Function: verificationService'),
    'Exported object literal with local shorthand function must emit Exported Function: verificationService'
  );

  const clientsGetAllId = contractEntityId(
    'nested-object-literal-exports',
    'api.ts',
    'Exported Function: clientsAPI',
    'contract.exported-function'
  );
  assert.ok(
    rels.some(
      (r) =>
        r.name === 'Call: clientsAPI.getAll()' &&
        r.patternId === 'relationship.dispatch-table-reference' &&
        r.targetId === clientsGetAllId
    ),
    'Delegated property getAll: clientsAPI.getAll must emit dispatch-table-reference CALL edge to Exported Function: clientsAPI'
  );

  // 2. Chained built-in array method `.filter()` on imported call must not resolve back to producer
  assert.ok(
    rels.some((r) => r.name === 'Call: clientsAPI.getAll()' && r.targetId === clientsGetAllId),
    'Inner clientsAPI.getAll() call must still resolve to Exported Function: clientsAPI'
  );
  assert.ok(
    !rels.some((r) => r.name === 'Call: clientsAPI.filter()' && r.targetId === clientsGetAllId),
    'Chained built-in .filter() on clientsAPI.getAll().filter(...) must not resolve back to Exported Function: clientsAPI'
  );

  // 3. Chained method call on `new ClassName().method()`
  const executeJobId = contractEntityId(
    'nested-object-literal-exports',
    'facade.ts',
    'Public Method: WorkerRunner.executeJob',
    'contract.public-method'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: WorkerRunner.executeJob()' && r.targetId === executeJobId),
    'new WorkerRunner().executeJob() must resolve to Public Method: WorkerRunner.executeJob'
  );

  // 4. Private subclass helper call must not resolve to external superclass package (`@nestjs/core`)
  const nestCorePkgId = stableEntityId('package:@nestjs/core', 'OPEN_CONNECTOR', 'Package: @nestjs/core');
  assert.ok(
    !rels.some(
      (r) =>
        r.name === 'Call: this.catchClientKnownRequestError()' && r.targetId === nestCorePkgId
    ),
    'Private subclass helper this.catchClientKnownRequestError() must not resolve to superclass Package: @nestjs/core'
  );

  // 5. Named re-export from external package (`export { exec } from '@actions/exec'`)
  assert.ok(
    connectors.some((c) => c.name === 'Package: @actions/exec' && c.entityType === 'EXTERNAL_PACKAGE'),
    'Named re-export from external package must emit Package: @actions/exec OPEN_CONNECTOR'
  );
});

test('[PAT-EXT-43]: external chained member calls, multi-hop namespace barrel calls, exported class instance calls, and intra-repo factory export tracing', () => {
  const nestedObjRepo = fixture('nested-object-literal-exports');
  const nextId = makeNextId();

  const pat43Path = path.join(nestedObjRepo, 'pat43Caller.ts');
  const pat43Code = `
    import * as http from 'http';
    import { summary } from '@actions/core';
    import * as apiNs from './api.js';

    export function runPat43() {
      http.createServer().listen(8080);
      summary.addRaw('ok').write();
      apiNs.briefsAPI.server.deleteBrief('id-1');
    }
  `;

  const pat43Sf = ts.createSourceFile(pat43Path, pat43Code, ts.ScriptTarget.Latest, true);
  const pat43Ev = makeEv('pat43Caller.ts', pat43Sf);
  const rels: StructuralEntity[] = [];

  walkNodes(pat43Sf, (node) => {
    rels.push(...toList(visitRelationship(node, pat43Sf, pat43Ev, nextId, nestedObjRepo, 'source-pat43')));
  });

  const httpPkgId = stableEntityId('package:http', 'OPEN_CONNECTOR', 'Package: http');
  const corePkgId = stableEntityId('package:@actions/core', 'OPEN_CONNECTOR', 'Package: @actions/core');
  const deleteBriefId = contractEntityId(
    'nested-object-literal-exports',
    'api.ts',
    'Exported Function: briefsAPI.server.deleteBrief',
    'contract.exported-function'
  );

  assert.ok(
    rels.some((r) => r.name === 'Call: http.listen()' && r.targetId === httpPkgId),
    'http.createServer().listen(8080) must resolve to Package: http'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: summary.write()' && r.targetId === corePkgId),
    'summary.addRaw().write() must resolve to Package: @actions/core'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: apiNs.deleteBrief()' && r.targetId === deleteBriefId),
    'apiNs.briefsAPI.server.deleteBrief() must resolve to Exported Function: briefsAPI.server.deleteBrief'
  );
});

test('[PAT-EXT-44]: ReturnType<typeof fn> parameter resolution, interface sub-property method dispatch, and multi-depth LocalFromCall chains', () => {
  const methodCallsRepo = fixture('method-calls');
  const nextId = makeNextId();

  const pat44Path = path.join(methodCallsRepo, 'pat44Caller.ts');
  const pat44Code = `
    import { getOctokit } from '@actions/github';
    import { UserRepository } from './userRepository.js';
    import { userService } from './userService.js';

    type Octokit = ReturnType<typeof getOctokit>;

    interface PendingResource {
      repo: UserRepository;
    }

    export async function runPat44(
      octokit: Octokit,
      directClient: Awaited<ReturnType<typeof getOctokit>>,
      item: PendingResource,
      { repo }: PendingResource
    ) {
      await octokit.rest.issues.createComment({ body: 'hi' });
      await directClient.rest.pulls.get({ pull_number: 1 });
      item.repo.findById();
      repo.findById();
      const caller = userService.createUser();
      caller.ornament.list.mutate();
    }
  `;

  const pat44Sf = ts.createSourceFile(pat44Path, pat44Code, ts.ScriptTarget.Latest, true);
  const pat44Ev = makeEv('pat44Caller.ts', pat44Sf);
  const rels: StructuralEntity[] = [];

  walkNodes(pat44Sf, (node) => {
    rels.push(...toList(visitRelationship(node, pat44Sf, pat44Ev, nextId, methodCallsRepo, 'source-pat44')));
  });

  const githubPkgId = stableEntityId('package:@actions/github', 'OPEN_CONNECTOR', 'Package: @actions/github');
  const findByIdTarget = contractEntityId(
    'method-calls',
    'userRepository.ts',
    'Public Method: UserRepository.findById',
    'contract.public-method'
  );
  const userServiceTarget = contractEntityId(
    'method-calls',
    'userService.ts',
    'Exported Function: userService',
    'contract.exported-function'
  );

  assert.ok(
    rels.some((r) => r.name === 'Call: octokit.createComment()' && r.targetId === githubPkgId),
    'octokit.rest.issues.createComment() with type Octokit = ReturnType<typeof getOctokit> must resolve to Package: @actions/github'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: directClient.get()' && r.targetId === githubPkgId),
    'directClient.rest.pulls.get() with Awaited<ReturnType<typeof getOctokit>> must resolve to Package: @actions/github'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: item.findById()' && r.targetId === findByIdTarget),
    'item.repo.findById() via interface sub-property must resolve to Public Method: UserRepository.findById'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: repo.findById()' && r.targetId === findByIdTarget),
    'destructured ({ repo }: PendingResource) repo.findById() must resolve to Public Method: UserRepository.findById'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: caller.mutate()' && r.targetId === userServiceTarget),
    'Multi-depth LocalFromCall caller.ornament.list.mutate() must resolve to Exported Function: userService'
  );
});

test('[PAT-EXT-45]: class get accessor extraction/resolution, typed object literal namespace export, chained Zod primitive validator, and exported Commander instance', () => {
  const nestedObjRepo = fixture('nested-object-literal-exports');
  const nextId = makeNextId();

  const pat45Path = path.join(nestedObjRepo, 'pat45Contracts.ts');
  const pat45Code = `
    import { z } from 'zod';
    import { Command } from 'commander';

    interface Bindings {
      version: number;
      parse: (input: string) => string;
    }

    export class Profile {
      get fullName(): string {
        return this.formatName();
      }
      formatName(): string {
        return 'Ada';
      }
    }

    export const bindings = {
      version: 1,
      parse: (input: string) => input.trim(),
    } as Bindings;

    export const slugSchema = z.string().min(1).max(64);
    export const program = new Command();
  `;

  const pat45Sf = ts.createSourceFile(pat45Path, pat45Code, ts.ScriptTarget.Latest, true);
  const pat45Ev = makeEv('pat45Contracts.ts', pat45Sf);
  const contracts: StructuralEntity[] = [];

  walkNodes(pat45Sf, (node) => {
    contracts.push(...toList(visitContract(node, pat45Sf, pat45Ev, nextId, null, 'pat45Contracts.ts')));
  });

  assert.ok(
    contracts.some((c) => c.name === 'Public Method: Profile.fullName' && c.patternId === 'contract.public-method'),
    'Class get accessor must be extracted as Public Method: Profile.fullName'
  );
  assert.ok(
    contracts.some((c) => c.name === 'Exported Function: bindings' && c.patternId === 'contract.exported-function'),
    'Typed object literal export (`as Bindings`) with callable member must emit Exported Function: bindings'
  );
  assert.ok(
    contracts.some(
      (c) =>
        c.name === 'VALIDATOR_SCHEMA: slugSchema' &&
        c.patternId === 'contract.zod-exported-validator'
    ),
    'Chained Zod primitive validator (`z.string().min(1).max(64)`) must emit VALIDATOR_SCHEMA: slugSchema'
  );
  assert.ok(
    contracts.some((c) => c.name === 'Exported Function: program' && c.patternId === 'contract.exported-function'),
    'Exported Commander instance (`export const program = new Command()`) must emit Exported Function: program'
  );
});

test('[PAT-EXT-46]: Next.js App Router special files, MCP registerTool/registerResource, Express route middleware array literals, and Drizzle namespace schema bindings', () => {
  const drizzleRepo = fixture('nextjs-drizzle');
  const nextId = makeNextId();

  // 1. Next.js App Router special files (`loading.tsx`, `error.tsx`, `not-found.tsx`)
  assert.equal(isNextjsAppSpecialFile('src/app/dashboard/loading.tsx'), true);
  assert.equal(isNextjsAppSpecialFile('src/app/error.tsx'), true);
  assert.equal(isNextjsAppSpecialFile('src/app/not-found.tsx'), true);

  const loadingCode = `export default function Loading() { return <div>Loading...</div>; }`;
  const loadingSf = ts.createSourceFile(
    path.join(drizzleRepo, 'app/dashboard/loading.tsx'),
    loadingCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const loadingEv = makeEv('app/dashboard/loading.tsx', loadingSf);
  const loadingContracts: StructuralEntity[] = [];
  walkNodes(loadingSf, (node) => {
    loadingContracts.push(
      ...toList(visitContract(node, loadingSf, loadingEv, nextId, null, 'app/dashboard/loading.tsx'))
    );
  });
  assert.ok(
    loadingContracts.some(
      (c) => c.name === 'Exported Function: Loading' && c.metadata?.flowRole === 'INGRESS'
    ),
    'Next.js app/dashboard/loading.tsx component must be marked flowRole: INGRESS'
  );

  // 2. MCP registerTool / registerResource, Express middleware array literals, and Drizzle namespace schema binding
  const pat46Path = path.join(drizzleRepo, 'lib/pat46Server.ts');
  const pat46Code = `
    import { drizzle } from 'drizzle-orm/postgres-js';
    import * as schema from './db.js';
    import { getUser, deleteUser } from './db.js';

    export function registerEverything(server: any, router: any, client: any) {
      server.registerTool('fetch-weather', { description: 'Weather' }, async () => ({}));
      server.registerResource('docs', 'docs://main', async () => ({}));
      router.get('/users', [getUser, deleteUser], getUser);
      return drizzle(client, { schema });
    }
  `;

  const pat46Sf = ts.createSourceFile(pat46Path, pat46Code, ts.ScriptTarget.Latest, true);
  const pat46Ev = makeEv('lib/pat46Server.ts', pat46Sf);
  const contracts: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];

  walkNodes(pat46Sf, (node) => {
    contracts.push(...toList(visitContract(node, pat46Sf, pat46Ev, nextId, null, 'lib/pat46Server.ts')));
    rels.push(...toList(visitRelationship(node, pat46Sf, pat46Ev, nextId, drizzleRepo, 'source-pat46')));
  });

  assert.ok(
    contracts.some((c) => c.name === 'MCP Tool: fetch-weather' && c.patternId === 'contract.mcp-tool'),
    'server.registerTool must extract MCP Tool: fetch-weather'
  );
  assert.ok(
    contracts.some((c) => c.name === 'MCP Tool: docs' && c.patternId === 'contract.mcp-tool'),
    'server.registerResource must extract MCP Tool: docs'
  );
  assert.ok(
    rels.some(
      (r) =>
        r.name === 'Express Mount: /users -> deleteUser' &&
        r.patternId === 'relationship.express-route-middleware' &&
        Boolean(r.targetId)
    ),
    'Express route middleware array literal [getUser, deleteUser] must emit resolved express-route-middleware edge'
  );
  assert.ok(
    rels.some(
      (r) =>
        r.name === 'References Schema: users' &&
        r.patternId === 'relationship.drizzle-client-namespace-schema-binding'
    ),
    'drizzle(client, { schema }) with namespace import must emit References Schema: users'
  );
});

test('[PAT-EXT-47]: this.<prop> object literal sub-property resolution, || new Class() fallback, req.<prop>.<method>() middleware attachment, and Object.assign(res, responseTypes)', () => {
  const nestedObjRepo = fixture('nested-object-literal-exports');
  const nextId = makeNextId();

  const pat47Path = path.join(nestedObjRepo, 'pat47Test.ts');
  const pat47Code = `
    import msgpack from 'msgpack-lite';
    import { clientsAPI } from './api.js';

    export class MemoryStore {
      increment(key: string): number {
        return 1;
      }
    }

    export class Adapter {
      private broadcastOptions: any;
      private store: any;

      constructor(opts: any = {}, store?: MemoryStore) {
        this.broadcastOptions = {
          parser: opts.parser || msgpack,
        };
        this.store = store || new MemoryStore();
      }

      broadcast(packet: any, req: any, res: any) {
        this.broadcastOptions.parser.encode(packet);
        this.store.increment('hits');
        req.cache = new MemoryStore();
        req.cache.increment('req-hits');
        Object.assign(res, clientsAPI);
        res.getAll();
      }
    }
  `;

  const pat47Sf = ts.createSourceFile(pat47Path, pat47Code, ts.ScriptTarget.Latest, true);
  const pat47Ev = makeEv('pat47Test.ts', pat47Sf);
  const rels: StructuralEntity[] = [];

  walkNodes(pat47Sf, (node) => {
    rels.push(...toList(visitRelationship(node, pat47Sf, pat47Ev, nextId, nestedObjRepo, 'source-pat47')));
  });

  const parserEncode = rels.find((r) => r.name === 'Call: this.encode()');
  assert.ok(
    parserEncode &&
      parserEncode.targetId ===
        stableEntityId('package:msgpack-lite', 'OPEN_CONNECTOR', 'Package: msgpack-lite'),
    'this.broadcastOptions.parser.encode() must resolve to Package: msgpack-lite'
  );

  const storeIncrement = rels.filter(
    (r) =>
      (r.name === 'Call: this.increment()' || r.name === 'Call: req.increment()') &&
      Boolean(r.targetId)
  );
  assert.equal(
    storeIncrement.length,
    2,
    'Both this.store.increment() (via || new MemoryStore()) and req.cache.increment() (via req.cache = new MemoryStore()) must resolve'
  );

  const resGetAll = rels.find(
    (r) =>
      r.name === 'Call: res.getAll()' &&
      r.patternId === 'relationship.express-res-augmented-method-call' &&
      Boolean(r.targetId)
  );
  assert.ok(
    resGetAll,
    'res.getAll() after Object.assign(res, clientsAPI) must resolve via relationship.express-res-augmented-method-call'
  );
});

test('[PAT-EXT-48]: dynamic await import() / import().then() call resolution, CJS export alias submodule require, and default-imported config object property read', () => {
  const fnCallsRepo = fixture('function-calls');
  const defaultExportRepo = fixture('es6-export-default');
  const nextId = makeNextId();

  const dynPath = path.join(fnCallsRepo, 'pat48Dynamic.ts');
  const dynCode = `
    export async function runDynamic() {
      const { calculateSum } = await import('./utils.js');
      calculateSum(1, 2);
      (await import('./utils.js')).calculateSum(3, 4);
    }
  `;
  const dynSf = ts.createSourceFile(dynPath, dynCode, ts.ScriptTarget.Latest, true);
  const dynEv = makeEv('pat48Dynamic.ts', dynSf);
  const dynRels: StructuralEntity[] = [];
  walkNodes(dynSf, (node) => {
    dynRels.push(...toList(visitRelationship(node, dynSf, dynEv, nextId, fnCallsRepo, 'source-pat48-dyn')));
  });

  assert.ok(
    dynRels.some((r) => r.name === 'Call: calculateSum()' && Boolean(r.targetId)),
    'Destructured await import() binding calculateSum() must emit resolved Call: calculateSum()'
  );
  assert.ok(
    dynRels.some((r) => r.name === 'Call: import().calculateSum()' && Boolean(r.targetId)),
    'Inline (await import()).calculateSum() must emit resolved Call: import().calculateSum()'
  );

  const pat48Path = path.join(defaultExportRepo, 'pat48Default.ts');
  const pat48Code = `
    import defaultConfig from './src/index.js';

    export function readConfig() {
      return defaultConfig.apiUrl;
    }
  `;

  const pat48Sf = ts.createSourceFile(pat48Path, pat48Code, ts.ScriptTarget.Latest, true);
  const pat48Ev = makeEv('pat48Default.ts', pat48Sf);
  const rels: StructuralEntity[] = [];

  walkNodes(pat48Sf, (node) => {
    rels.push(...toList(visitRelationship(node, pat48Sf, pat48Ev, nextId, defaultExportRepo, 'source-pat48')));
  });

  assert.ok(
    rels.some(
      (r) =>
        r.name === 'References: defaultConfig.apiUrl' &&
        r.patternId === 'relationship.default-imported-object-property-read' &&
        Boolean(r.targetId)
    ),
    'Property read on default-imported config module must emit relationship.default-imported-object-property-read'
  );
});

test('[PAT-EXT-49]: Remix root/entry.server/entry.client INGRESS classification, window/iframe postMessage IPC open connector, and LocalFromCall bracket-access receiver', () => {
  const fnCallsRepo = fixture('function-calls');
  const nextId = makeNextId();

  assert.equal(isRemixRouteFile('app/root.tsx'), true);
  assert.equal(isRemixRouteFile('app/entry.server.tsx'), true);
  assert.equal(isRemixRouteFile('app/entry.client.tsx'), true);

  const rootCode = `
    export async function loader() { return {}; }
    export function handleRequest() { return new Response('ok'); }
    export default function Root() { return <html />; }
  `;
  const rootSf = ts.createSourceFile(
    path.join(fnCallsRepo, 'app/entry.server.tsx'),
    rootCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const rootEv = makeEv('app/entry.server.tsx', rootSf);
  const rootContracts: StructuralEntity[] = [];
  walkNodes(rootSf, (node) => {
    rootContracts.push(...toList(visitContract(node, rootSf, rootEv, nextId, null, 'app/entry.server.tsx')));
  });
  assert.ok(
    rootContracts.some((c) => c.name === 'Exported Function: handleRequest' && c.metadata?.flowRole === 'INGRESS'),
    'Remix app/entry.server.tsx handleRequest export must carry flowRole: INGRESS'
  );

  const remixRootAppCode = `
    import { useLoaderData } from '@remix-run/react';
    export async function loader() { return { user: 'alice' }; }
    export default function App() {
      const data = useLoaderData<typeof loader>();
      return null;
    }
  `;
  const remixRootAppSf = ts.createSourceFile(
    path.join(fnCallsRepo, 'app/root.tsx'),
    remixRootAppCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const remixRootAppEv = makeEv('app/root.tsx', remixRootAppSf);
  const remixRootRels: StructuralEntity[] = [];
  walkNodes(remixRootAppSf, (node) => {
    remixRootRels.push(
      ...toList(visitRelationship(node, remixRootAppSf, remixRootAppEv, nextId, fnCallsRepo, 'source-app'))
    );
  });
  assert.ok(
    remixRootRels.some((r) => r.name === 'Call: useLoaderData()' && Boolean(r.targetId)),
    'useLoaderData() in app/root.tsx must resolve to same-file loader contract'
  );

  const ipcCode = `
    export function sendIpc(iframe: any) {
      window.postMessage({ type: 'PING' }, '*');
      iframe.contentWindow.postMessage({ type: 'PONG' }, '*');
    }
  `;
  const ipcSf = ts.createSourceFile(path.join(fnCallsRepo, 'ipc.ts'), ipcCode, ts.ScriptTarget.Latest, true);
  const ipcEv = makeEv('ipc.ts', ipcSf);
  const connectors: StructuralEntity[] = [];
  const ipcRels: StructuralEntity[] = [];
  walkNodes(ipcSf, (node) => {
    connectors.push(...toList(visitOpenConnector(node, ipcSf, ipcEv, nextId, fnCallsRepo)));
    ipcRels.push(...toList(visitRelationship(node, ipcSf, ipcEv, nextId, fnCallsRepo, 'source-ipc')));
  });
  assert.equal(
    connectors.filter((c) => c.patternId === 'open-connector.window-postmessage-ipc').length,
    2,
    'window.postMessage and iframe.contentWindow.postMessage must emit open-connector.window-postmessage-ipc'
  );
  assert.equal(
    ipcRels.length,
    0,
    'window.postMessage and iframe.contentWindow.postMessage must not emit duplicate unresolved CALL edges'
  );
});

test('[PAT-EXT-50]: NestJS @Module provider/controller registration, ES-exported router instance to HTTP_ENDPOINT binding, and two-step this.db.prepare(sql)(params) call', () => {
  const expressRepo = fixture('express-app');
  const nextId = makeNextId();

  const pat50Path = path.join(expressRepo, 'pat50ModuleAndRouter.ts');
  const pat50Code = `
    import express from 'express';

    function Module(_meta: any): ClassDecorator {
      return () => {};
    }

    export class AuthService {
      validateUser() {
        return true;
      }
    }

    export class AuthController {
      login() {
        return 'token';
      }
    }

    @Module({
      providers: [AuthService],
      controllers: [AuthController],
      exports: [AuthService],
    })
    export class AuthModule {}

    export const userRouter = express.Router();
    userRouter.get('/members', (_req: any, res: any) => res.send('ok'));

    export class SqlService {
      private db: AuthService;
      constructor(db: AuthService) {
        this.db = db;
      }
      runQuery() {
        return (this.db.validateUser as any)()('arg');
      }
    }
  `;

  const pat50Sf = ts.createSourceFile(pat50Path, pat50Code, ts.ScriptTarget.Latest, true);
  const pat50Ev = makeEv('pat50ModuleAndRouter.ts', pat50Sf);
  const rels: StructuralEntity[] = [];

  walkNodes(pat50Sf, (node) => {
    rels.push(...toList(visitRelationship(node, pat50Sf, pat50Ev, nextId, expressRepo, 'source-pat50')));
  });

  assert.ok(
    rels.some(
      (r) =>
        r.name === 'Registers: AuthService' &&
        r.patternId === 'relationship.nestjs-module-provider-registration' &&
        Boolean(r.targetId)
    ),
    '@Module({ providers: [AuthService] }) must emit relationship.nestjs-module-provider-registration'
  );
  assert.ok(
    rels.some(
      (r) =>
        r.name === 'Registers: AuthController' &&
        r.patternId === 'relationship.nestjs-module-provider-registration' &&
        Boolean(r.targetId)
    ),
    '@Module({ controllers: [AuthController] }) must emit relationship.nestjs-module-provider-registration'
  );
  assert.ok(
    rels.some(
      (r) =>
        r.name === 'Binds Route: userRouter -> Express Route: GET /members' &&
        r.patternId === 'relationship.router-instance-to-http-endpoint' &&
        Boolean(r.targetId)
    ),
    'ES-exported router instance userRouter.get("/members", ...) must emit relationship.router-instance-to-http-endpoint'
  );
});

test('[PAT-EXT-51]: exported object-literal data store contract and side-effect entry script module delegation', () => {
  const defaultExportRepo = fixture('es6-export-default');
  const nextId = makeNextId();

  const dataStorePath = path.join(defaultExportRepo, 'src/data.ts');
  const dataStoreCode = `
    const sections = [{ id: 'ui', name: 'UI' }];
    const categories = [{ id: 'forms', sectionId: 'ui' }];
    export const data = {
      sections,
      categories,
    };
  `;
  const dataStoreSf = ts.createSourceFile(dataStorePath, dataStoreCode, ts.ScriptTarget.Latest, true);
  const dataStoreEv = makeEv('src/data.ts', dataStoreSf);
  const contracts: StructuralEntity[] = [];
  walkNodes(dataStoreSf, (node) => {
    contracts.push(...toList(visitContract(node, dataStoreSf, dataStoreEv, nextId, null, 'src/data.ts')));
  });

  assert.ok(
    contracts.some(
      (c) =>
        c.name === 'Exported Module: data' &&
        c.entityType === 'EXPORTED_MODULE' &&
        c.patternId === 'contract.exported-object-literal-data-store'
    ),
    'export const data = { sections, categories } must emit contract.exported-object-literal-data-store'
  );

  const entryPath = path.join(defaultExportRepo, 'entry.ts');
  const entryCode = `import './src/index.js';\n`;
  const entrySf = ts.createSourceFile(entryPath, entryCode, ts.ScriptTarget.Latest, true);
  const entryEv = makeEv('entry.ts', entrySf);
  const entryRels: StructuralEntity[] = [];
  walkNodes(entrySf, (node) => {
    entryRels.push(...toList(visitRelationship(node, entrySf, entryEv, nextId, defaultExportRepo, 'init-entry')));
  });

  assert.ok(
    entryRels.some(
      (r) =>
        r.name === 'Call: import(./src/index.js)' &&
        r.patternId === 'relationship.module-export-delegation' &&
        Boolean(r.targetId)
    ),
    'Pure side-effect entry script import "./src/index.js" must emit relationship.module-export-delegation'
  );
});

test('[PAT-EXT-52]: shared module-scoped var function helper and LocalFunction factory call/chain resolution', () => {
  const fnCallsRepo = fixture('function-calls');
  const nextId = makeNextId();

  const pat52Path = path.join(fnCallsRepo, 'pat52Helpers.ts');
  const pat52Code = `
    import axios from 'axios';

    var setRetryAfter = function (res: any, nextValidRequestDate: number) {
      res.set('Retry-After', nextValidRequestDate);
    };

    export function failCallback(_req: any, res: any, nextValidRequestDate: number) {
      setRetryAfter(res, nextValidRequestDate);
    }

    export function prevent(_req: any, res: any, nextValidRequestDate: number) {
      setRetryAfter(res, nextValidRequestDate);
    }

    export class WorkerService {
      execute() {
        return 'done';
      }
    }

    function createWorker() {
      return new WorkerService();
    }

    function getHttpClient() {
      return axios.create();
    }

    export function runAll() {
      const worker = createWorker();
      worker.execute();
      getHttpClient().get('/status');
      getHttpClient().defaults.request('/health');
    }
  `;

  const pat52Sf = ts.createSourceFile(pat52Path, pat52Code, ts.ScriptTarget.Latest, true);
  const pat52Ev = makeEv('pat52Helpers.ts', pat52Sf);
  const contracts: StructuralEntity[] = [];
  const rels: StructuralEntity[] = [];

  walkNodes(pat52Sf, (node) => {
    contracts.push(...toList(visitContract(node, pat52Sf, pat52Ev, nextId, null, 'pat52Helpers.ts')));
    rels.push(...toList(visitRelationship(node, pat52Sf, pat52Ev, nextId, fnCallsRepo, 'source-pat52')));
  });

  assert.ok(
    contracts.some(
      (c) =>
        c.name === 'Exported Function: setRetryAfter' &&
        c.patternId === 'contract.module-scoped-var-function-helper'
    ),
    'Top-level var setRetryAfter = function(...) called across >= 2 top-level statements must emit contract.module-scoped-var-function-helper'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: setRetryAfter()' && Boolean(r.targetId)),
    'Calls to setRetryAfter() must resolve to Exported Function: setRetryAfter'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: worker.execute()' && Boolean(r.targetId)),
    'worker.execute() from local factory function createWorker() must resolve to Public Method: WorkerService.execute'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: getHttpClient.get()' && Boolean(r.targetId)),
    'getHttpClient().get() must resolve to Package: axios'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: getHttpClient.request()' && Boolean(r.targetId)),
    'getHttpClient().defaults.request() must resolve to Package: axios'
  );
});

test('[PAT-EXT-53]: Angular Schematics new RunSchematicTask(name, options) resolution via collection.json', () => {
  const fnCallsRepo = fixture('function-calls');
  const nextId = makeNextId();

  const schematicPath = path.join(fnCallsRepo, 'schematicRunner.ts');
  const schematicCode = `
    import { RunSchematicTask } from '@angular-devkit/schematics/tasks';

    export function runMigration(context: any, options: any) {
      context.addTask(new RunSchematicTask('calc-sum', options));
    }
  `;

  const schematicSf = ts.createSourceFile(schematicPath, schematicCode, ts.ScriptTarget.Latest, true);
  const schematicEv = makeEv('schematicRunner.ts', schematicSf);
  const rels: StructuralEntity[] = [];

  walkNodes(schematicSf, (node) => {
    rels.push(...toList(visitRelationship(node, schematicSf, schematicEv, nextId, fnCallsRepo, 'source-schematic')));
  });

  assert.ok(
    rels.some(
      (r) =>
        r.name === 'Call: new RunSchematicTask(calc-sum)' &&
        r.patternId === 'relationship.angular-schematics-run-schematic-task' &&
        r.status === 'DETERMINISTIC' &&
        Boolean(r.targetId)
    ),
    'new RunSchematicTask("calc-sum", options) must resolve via collection.json to Exported Function: calculateSum'
  );
});

test('[PAT-EXT-54]: this string-literal element access, this method call chain, dynamic bracket dispatch on imported objects, and new Function dynamic import wrapper', () => {
  const nestedObjRepo = fixture('nested-object-literal-exports');
  const nextId = makeNextId();

  const pat54Path = path.join(nestedObjRepo, 'pat54Chains.ts');
  const pat54Code = `
    import { MatSnackBarRef } from '@angular/material/snack-bar';
    import { briefsAPI } from './api.js';

    export class ObservableQuery {
      resetNotifications() {
        return true;
      }
    }

    export class QueryManager {
      private observableQuery?: ObservableQuery;
      private _snackBarRef?: MatSnackBarRef<any>;

      getObservableFromLink() {
        return { pipe: (fn: any) => fn };
      }

      run(tier: string) {
        this.observableQuery?.['resetNotifications']();
        this.getObservableFromLink().pipe('op');
        this._snackBarRef?.afterDismissed().subscribe();
        briefsAPI[tier].getAll();
        const importDynamic = new Function('modulePath', 'return import(modulePath)');
        importDynamic('ora');
      }
    }
  `;

  const pat54Sf = ts.createSourceFile(pat54Path, pat54Code, ts.ScriptTarget.Latest, true);
  const pat54Ev = makeEv('pat54Chains.ts', pat54Sf);
  const rels: StructuralEntity[] = [];

  walkNodes(pat54Sf, (node) => {
    rels.push(...toList(visitRelationship(node, pat54Sf, pat54Ev, nextId, nestedObjRepo, 'source-pat54')));
  });

  assert.ok(
    rels.some((r) => r.name === 'Call: this.resetNotifications()' && Boolean(r.targetId)),
    'this.observableQuery?.["resetNotifications"]() must resolve to Public Method: ObservableQuery.resetNotifications'
  );
  assert.ok(
    rels.some((r) => r.name === 'Call: this.pipe()' && Boolean(r.targetId)),
    'this.getObservableFromLink().pipe() must resolve to Public Method: QueryManager.getObservableFromLink'
  );
  assert.ok(
    rels.some(
      (r) =>
        r.name === 'Call: this.subscribe()' &&
        r.targetId ===
          stableEntityId(
            'package:@angular/material/snack-bar',
            'OPEN_CONNECTOR',
            'Package: @angular/material/snack-bar'
          )
    ),
    'this._snackBarRef?.afterDismissed().subscribe() must resolve to Package: @angular/material/snack-bar'
  );
  assert.ok(
    rels.some(
      (r) =>
        r.name === 'Call: briefsAPI.getAll()' &&
        r.patternId === 'relationship.function-call' &&
        Boolean(r.targetId)
    ),
    'briefsAPI[tier].getAll() must fan out to Exported Function: briefsAPI.server.getAll'
  );
  assert.ok(
    rels.some(
      (r) =>
        r.name === 'Call: importDynamic()' &&
        r.targetId === stableEntityId('package:ora', 'OPEN_CONNECTOR', 'Package: ora')
    ),
    'importDynamic("ora") via new Function("modulePath", "return import(modulePath)") must resolve to Package: ora'
  );
});

test('Soundness guards: scalar config properties, _.bind wrappers, default EXPORTED_MODULE references, and MDX JSX props', () => {
  const es6Repo = fixture('es6-export-default');
  const nextId = makeNextId();
  const callerPath = path.join(es6Repo, 'src/soundnessCaller.tsx');
  const callerCode = [
    'import _ from "underscore";',
    'import jwt from "jsonwebtoken";',
    'import { createStore } from "redux";',
    'import router from "./index.js";',
    'export function runSoundness(ThemeProvider: any) {',
    '  jwt.sign({ id: 1 }, router.jwtSecret);',
    '  const getFailCallback = _.bind(function () { return 42; }, this);',
    '  const failCallback = getFailCallback();',
    '  failCallback();',
    '  createStore(router);',
    '  return <ThemeProvider theme={router} />;',
    '}',
  ].join('\n');

  const callerSf = ts.createSourceFile(
    callerPath,
    callerCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const callerEv = makeEv('src/soundnessCaller.tsx', callerSf);
  const rels: StructuralEntity[] = [];

  walkNodes(callerSf, (node) => {
    rels.push(...toList(visitRelationship(node, callerSf, callerEv, nextId, es6Repo, 'source-soundness')));
  });

  assert.ok(
    !rels.some((r) => r.name === 'Call: router.jwtSecret()'),
    'Passing scalar router.jwtSecret as a call argument must NOT emit false-positive Call: router.jwtSecret()'
  );
  const underscorePkgId = stableEntityId('package:underscore', 'OPEN_CONNECTOR', 'Package: underscore');
  assert.ok(
    !rels.some(
      (r) =>
        (r.name === 'Call: getFailCallback()' || r.name === 'Call: failCallback()') &&
        r.targetId === underscorePkgId
    ),
    'Calls to functions wrapped with _.bind(fn, this) must NOT be attributed to Package: underscore'
  );
  assert.ok(
    rels.some(
      (r) =>
        r.name === 'References: router' &&
        r.patternId === 'relationship.ExportedConstantReference' &&
        Boolean(r.targetId)
    ),
    'Passing default-imported EXPORTED_MODULE router to createStore(router) and JSX prop theme={router} must emit References: router'
  );
});

test('[PAT-EXT-55]..[PAT-EXT-58] and Scout Round 2 soundness guards', () => {
  const es6Repo = fixture('es6-exports');
  const nextId = makeNextId();

  // 1. [PAT-EXT-55]: Fastify fp() HOF plugin, exported property alias (export const verify = Jwt.verify),
  // fastify.register(plugin, { prefix: '/api' }), and fastify.decorate('userService', service)
  const fastifyPath = path.join(es6Repo, 'src/fastifyPlugin.ts');
  const fastifyCode = [
    "import fp from 'fastify-plugin';",
    "import { createMiddleware } from 'hono/factory';",
    "import { Jwt } from 'hono/utils/jwt';",
    'class UserService {',
    '  findById(id: string) { return id; }',
    '}',
    'export const verify = Jwt.verify;',
    'export const authMiddleware = createMiddleware(async (c, next) => { await next(); });',
    'export default fp(async function userPlugin(fastify: any) {',
    '  const userService = new UserService();',
    "  fastify.decorate('userService', userService);",
    '  fastify.register(authMiddleware, { prefix: "/api/v1" });',
    '  fastify.get("/users", { schema: { tags: ["users"] } }, async function handler(req: any) {',
    '    return fastify.userService.findById(req.id);',
    '  });',
    '});',
  ].join('\n');
  const fastifySf = ts.createSourceFile(fastifyPath, fastifyCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fastifyEv = makeEv('src/fastifyPlugin.ts', fastifySf);
  const fastifyContracts: StructuralEntity[] = [];
  const fastifyRels: StructuralEntity[] = [];
  walkNodes(fastifySf, (node) => {
    fastifyContracts.push(...toList(visitContract(node, fastifySf, fastifyEv, nextId)));
    fastifyRels.push(...toList(visitRelationship(node, fastifySf, fastifyEv, nextId, es6Repo, 'source-fastify')));
  });
  assert.ok(
    fastifyContracts.some((c) => c.name === 'Exported Function: verify'),
    'export const verify = Jwt.verify must extract Exported Function: verify'
  );
  assert.ok(
    fastifyContracts.some((c) => c.name === 'Exported Function: authMiddleware'),
    'createMiddleware(...) HOF wrapper must extract Exported Function: authMiddleware'
  );
  assert.ok(
    fastifyContracts.some((c) => c.name === 'Exported Function: userPlugin'),
    'export default fp(async function userPlugin...) must extract Exported Function: userPlugin'
  );
  assert.ok(
    fastifyRels.some((r) => r.name === 'Express Mount: /api/v1 -> authMiddleware' && r.entityType === 'MOUNT'),
    'fastify.register(plugin, { prefix }) must emit Express Mount edge'
  );
  assert.ok(
    fastifyRels.some((r) => r.name === 'Call: fastify.findById()' && Boolean(r.targetId)),
    'fastify.decorate("userService", userService) must resolve fastify.userService.findById()'
  );
  assert.ok(
    !fastifyRels.some((r) => r.name.includes('{ schema:')),
    'Fastify route options object { schema: ... } must NOT be emitted as a middleware BINDS_ROUTE edge'
  );

  // 2. [PAT-EXT-56] & OpenConnector soundness: Bare Node built-in ES imports, S3 client, (opt.fetch || fetch)(),
  // Kysely sql`...`.execute(db), and NATS headers() non-DB suppression
  const ocPath = path.join(es6Repo, 'src/openConnectorsTest.ts');
  const ocCode = [
    "import * as os from 'os';",
    "import path from 'path';",
    "import { S3Client } from '@aws-sdk/client-s3';",
    "import { sql } from 'kysely';",
    'const s3Client = new S3Client({});',
    'export async function runConnectors(db: any, natsMsg: any, opt: any) {',
    '  await s3Client.send({});',
    '  await (opt?.fetch || fetch)("https://api.example.com/v1/items");',
    '  await sql`SELECT 1`.execute(db);',
    '  natsMsg.headers();',
    '  return path.join(os.tmpdir(), "x");',
    '}',
  ].join('\n');
  const ocSf = ts.createSourceFile(ocPath, ocCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ocEv = makeEv('src/openConnectorsTest.ts', ocSf);
  const ocs: StructuralEntity[] = [];
  walkNodes(ocSf, (node) => {
    ocs.push(...toList(visitOpenConnector(node, ocSf, ocEv, nextId, 'source-oc')));
  });
  assert.ok(
    ocs.some((o) => o.name === 'Package: os' && o.entityType === 'NODE_BUILTIN'),
    'Bare import * as os from "os" must be classified as NODE_BUILTIN'
  );
  assert.ok(
    ocs.some((o) => o.name === 'Package: path' && o.entityType === 'NODE_BUILTIN'),
    'Bare import path from "path" must be classified as NODE_BUILTIN'
  );
  assert.ok(
    ocs.some((o) => o.name === 'HTTP Call: s3Client.send' && o.entityType === 'HTTP_FETCH'),
    's3Client.send(...) must emit HTTP_FETCH Open Connector'
  );
  assert.ok(
    ocs.some((o) => o.name === 'HTTP Call: fetch' && o.entityType === 'HTTP_FETCH'),
    '(opt?.fetch || fetch)(url) must emit HTTP Call: fetch Open Connector'
  );
  assert.ok(
    ocs.some((o) => o.name === 'DB Call: sql.execute' && o.entityType === 'DB_QUERY'),
    'sql`SELECT 1`.execute(db) must emit DB Call: sql.execute Open Connector'
  );
  assert.ok(
    !ocs.some((o) => o.name.includes('headers')),
    'natsMsg.headers() must NOT emit a false-positive DB_OPERATION Open Connector'
  );

  // 3. [PAT-EXT-57] & [PAT-EXT-58]: new Command().name(), (new Err() as HttpException).getResponse(),
  // loadStorage()?.getStore(), this.months[0]?.push(), this.workers[k].start(), this.zone()(),
  // tagged template html`...`, styled(Comp), useContext(Ctx), and useRef(new Map()).current.get()
  const shapesPath = path.join(es6Repo, 'src/shapesAndTemplates.tsx');
  const shapesCode = [
    "import React, { createContext, useContext, useRef } from 'react';",
    "import styled from '@emotion/styled';",
    "import { Command } from 'commander';",
    "import { AsyncLocalStorage } from 'node:async_hooks';",
    'class HttpException { getResponse() { return "ok"; } }',
    'class WorkerItem { start() {} }',
    'interface SubApi { ping(): void; }',
    'interface Opts { api?: SubApi; }',
    'const storage = new AsyncLocalStorage();',
    'function loadStorage() { return storage; }',
    'export function html(strings: TemplateStringsArray, ...values: any[]) { return strings[0]; }',
    'export const ThemeCtx = createContext("dark");',
    'export function BaseBadge() { return <span />; }',
    'const StyledBadge = styled(BaseBadge)`color: red;`;',
    'export class Runner {',
    '  private months: string[][] = [];',
    '  private workers: Record<string, WorkerItem> = {};',
    '  private opts: Opts = {};',
    '  createZone() { return (fn: () => void) => fn(); }',
    '  run(HttpErrorByCode: any, code: string) {',
    '    new Command().name("cli");',
    '    (new HttpErrorByCode[code]() as HttpException).getResponse();',
    '    loadStorage()?.getStore();',
    '    this.months[0]?.push("jan");',
    '    this.workers[code].start();',
    '    this.opts.api?.ping();',
    '    this.createZone()(() => {});',
    '    return html`<div>hello</div>`;',
    '  }',
    '}',
    'export function BadgeView() {',
    '  const theme = useContext(ThemeCtx);',
    '  const mapRef = useRef(new Map<string, string>());',
    '  mapRef.current.get(theme);',
    '  return <StyledBadge />;',
    '}',
  ].join('\n');
  const shapesSf = ts.createSourceFile(shapesPath, shapesCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const shapesEv = makeEv('src/shapesAndTemplates.tsx', shapesSf);
  const shapesRels: StructuralEntity[] = [];
  walkNodes(shapesSf, (node) => {
    shapesRels.push(...toList(visitRelationship(node, shapesSf, shapesEv, nextId, es6Repo, 'source-shapes')));
  });
  assert.ok(
    shapesRels.some((r) => r.name === 'Call: Command.name()' && Boolean(r.targetId)),
    'new Command().name() must resolve to Package: commander'
  );
  assert.ok(
    shapesRels.some((r) => r.name === 'Call: HttpErrorByCode.getResponse()' && Boolean(r.targetId)),
    '(new HttpErrorByCode[code]() as HttpException).getResponse() must resolve to HttpException.getResponse'
  );
  assert.ok(
    shapesRels.some((r) => r.name === 'Call: loadStorage.getStore()' && Boolean(r.targetId)),
    'loadStorage()?.getStore() must resolve via returned singleton instance to Package: node:async_hooks'
  );
  assert.ok(
    shapesRels.some((r) => r.name === 'Call: this.start()' && Boolean(r.targetId)),
    'this.workers[code].start() must unwrap Record<K, WorkerItem> value type and resolve WorkerItem.start'
  );
  assert.ok(
    shapesRels.some((r) => r.name === 'Call: this.ping()' && Boolean(r.targetId)),
    'this.opts.api?.ping() must resolve via interface property chain to enclosing class boundary'
  );
  assert.ok(
    shapesRels.some((r) => r.name === 'Call: createZone()()' && Boolean(r.targetId)),
    'this.createZone()() must resolve to Runner.createZone'
  );
  assert.ok(
    shapesRels.some((r) => r.name === 'Call: html()' && Boolean(r.targetId)),
    'Tagged template html`...` must resolve to Call: html()'
  );
  assert.ok(
    shapesRels.some((r) => r.name === 'Renders: <StyledBadge />' && Boolean(r.targetId)),
    '<StyledBadge /> wrapping same-file styled(BaseBadge) must resolve targetId to BaseBadge'
  );
  assert.ok(
    shapesRels.some((r) => r.name === 'References: ThemeCtx' && r.entityType === 'REFERENCES'),
    'useContext(ThemeCtx) must emit References: ThemeCtx instead of Call: ThemeCtx()'
  );
  const reactPkgId = stableEntityId('package:react', 'OPEN_CONNECTOR', 'Package: react');
  assert.ok(
    !shapesRels.some((r) => r.name === 'Call: mapRef.current.get()' && r.targetId === reactPkgId),
    'mapRef.current.get() on useRef(new Map()) must NOT be attributed to Package: react'
  );
});

test('Wave 13 patterns ([PAT-EXT-55]..[PAT-EXT-58]): DOM/iterator/reflection suppression, promisify/bind wrappers, Mongoose models & HTTP stitching, and typeof/this/JSX/context resolution', () => {
  const fnCallsRepo = fixture('function-calls');
  const expressRepo = fixture('express-app');
  const nextId = makeNextId();

  // [PAT-EXT-55]: DOM/iterator/reflection prototype method suppression & new Function(...) dynamic execution target
  const pat55Path = path.join(fnCallsRepo, 'pat55DomAndNewFn.ts');
  const pat55Code = `
    export function testDomAndIterator(
      itemRefs: any,
      focusedIndex: number,
      nodes: any[],
      iterators: any[],
      allObservers: any[],
      currentAssistantListItem: any,
      maybe: any
    ) {
      itemRefs.current[focusedIndex].click();
      nodes[0]?.focus();
      iterators[0]!.next();
      allObservers[0]?.unobserve(nodes[0]);
      currentAssistantListItem.linkElement.nativeElement?.scrollIntoView({ behavior: 'smooth' });
      maybe.constructor('return this')();
      const dynamicImport = new Function('specifier', 'return import(specifier)');
      return dynamicImport(maybe);
    }

    export class CollectionWrapper {
      private items: any[] = [];
      invoke(method: string, args: any[]) {
        return this.items[method].apply(this.items, args);
      }
    }
  `;
  const pat55Sf = ts.createSourceFile(pat55Path, pat55Code, ts.ScriptTarget.Latest, true);
  const pat55Ev = makeEv('pat55DomAndNewFn.ts', pat55Sf);
  const pat55Rels: StructuralEntity[] = [];
  walkNodes(pat55Sf, (node) => {
    pat55Rels.push(...toList(visitRelationship(node, pat55Sf, pat55Ev, nextId, fnCallsRepo, 'source-pat55')));
  });
  assert.ok(
    !pat55Rels.some(
      (r) =>
        r.name.includes('.click()') ||
        r.name.includes('.focus()') ||
        r.name.includes('.next()') ||
        r.name.includes('.unobserve()') ||
        r.name.includes('.scrollIntoView()') ||
        r.name.includes('constructor()') ||
        r.name.includes('.apply()')
    ),
    'DOM element, iterator .next(), reflection .apply(), and maybe.constructor()() calls must be suppressed'
  );
  const expectedDynExecId = stableEntityId(
    'function-calls',
    'OPEN_CONNECTOR',
    'Dynamic Execution: new Function'
  );
  assert.ok(
    pat55Rels.some((r) => r.name === 'Call: dynamicImport()' && r.targetId === expectedDynExecId),
    'local variable initialized via new Function(...) must resolve to Dynamic Execution: new Function'
  );

  // [PAT-EXT-56]: util.promisify(require('child_process').exec), _.bind(fn, this), and chained factory deduplication
  const pat56Path = path.join(fnCallsRepo, 'pat56Wrappers.ts');
  const pat56Code = `
    const util = require('util');
    const _ = require('underscore');
    import { calculateSum } from './math';

    const exec = util.promisify(require('child_process').exec);

    export async function runPromisifiedAndBound() {
      await exec('ls -la');
      const boundFn = _.bind(function () { return 42; }, this);
      boundFn();
      const res = calculateSum(1, 2).toFixed(2);
      return res;
    }
  `;
  const pat56Sf = ts.createSourceFile(pat56Path, pat56Code, ts.ScriptTarget.Latest, true);
  const pat56Ev = makeEv('pat56Wrappers.ts', pat56Sf);
  const pat56Rels: StructuralEntity[] = [];
  const pat56Connectors: StructuralEntity[] = [];
  walkNodes(pat56Sf, (node) => {
    pat56Rels.push(...toList(visitRelationship(node, pat56Sf, pat56Ev, nextId, fnCallsRepo, 'source-pat56')));
    pat56Connectors.push(...toList(visitOpenConnector(node, pat56Sf, pat56Ev, nextId, fnCallsRepo)));
  });
  const childProcessPkgId = packageConnectorId('child_process');
  const underscorePkgId = packageConnectorId('underscore');
  assert.ok(
    pat56Rels.some((r) => r.name === 'Call: exec()' && r.targetId === childProcessPkgId),
    'util.promisify(require("child_process").exec) call must resolve to Package: child_process (not util)'
  );
  assert.ok(
    pat56Connectors.some((c) => c.name === 'Subprocess: child_process.exec'),
    'util.promisify(require("child_process").exec) invocation must emit Subprocess: child_process.exec open connector'
  );
  assert.ok(
    !pat56Rels.some((r) => r.name === 'Call: boundFn()' && r.targetId === underscorePkgId),
    '_.bind(localFn, this) invocation must not misattribute return provenance to Package: underscore'
  );

  // [PAT-EXT-57]: Mongoose model contracts, schema hook suppression, stoppable/node:http listen guard, and strict HTTP verb stitching
  const pat57Path = path.join(expressRepo, 'pat57MongooseAndHttp.ts');
  const pat57Code = `
    import http from 'node:http';
    import stoppable from 'stoppable';
    import { Schema, model } from 'mongoose';

    const authSchema = new Schema({ email: String });
    authSchema.pre('save', function () {});
    authSchema.post('save', function () {});
    export const Auth = model('Auth', authSchema);

    const server = stoppable(http.createServer());
    server.listen(3000);
  `;
  const pat57Sf = ts.createSourceFile(pat57Path, pat57Code, ts.ScriptTarget.Latest, true);
  const pat57Ev = makeEv('pat57MongooseAndHttp.ts', pat57Sf);
  const pat57Contracts: StructuralEntity[] = [];
  const pat57Connectors: StructuralEntity[] = [];
  walkNodes(pat57Sf, (node) => {
    pat57Contracts.push(...toList(visitContract(node, pat57Sf, pat57Ev, nextId, null, 'pat57MongooseAndHttp.ts')));
    pat57Connectors.push(...toList(visitOpenConnector(node, pat57Sf, pat57Ev, nextId, expressRepo)));
    const listen = extractExpressAppListen(node, pat57Ev, nextId);
    if (listen) pat57Connectors.push(listen);
  });
  assert.ok(
    pat57Contracts.some(
      (c) =>
        c.name === 'DB Schema: Auth' &&
        c.entityType === 'DB_SCHEMA' &&
        c.patternId === 'contract.mongoose-model'
    ),
    'export const Auth = model("Auth", authSchema) must extract DB Schema: Auth DB_SCHEMA contract'
  );
  assert.ok(
    !pat57Connectors.some(
      (c) => c.entityType === 'DB_QUERY' || c.patternId === 'open-connector.express-app-listen'
    ),
    'Mongoose schema.pre/post, model(), and stoppable(http.createServer()).listen() must not emit DB_QUERY or Express App Listen connectors'
  );

  const stitchNodes: any[] = [
    {
      id: 'route-post',
      name: 'Express Route: POST /socketio',
      type: 'CONTRACT',
      entityType: 'HTTP_ENDPOINT',
      patternId: 'contract.express-route',
      evidence: { filePath: 'server.ts', lineNumber: 10 },
    },
    {
      id: 'fetch-conn',
      name: 'HTTP Call: fetch',
      type: 'OPEN_CONNECTOR',
      entityType: 'HTTP_FETCH',
      patternId: 'open-connector.http-call',
      evidence: { filePath: 'client.ts', lineNumber: 5 },
      metadata: { httpMethod: 'GET', urlPath: 'http://localhost:2929/socketio' },
    },
  ];
  const stitchEdges: any[] = [
    {
      id: 'e1',
      name: 'Call: HTTP Call: fetch',
      type: 'RELATIONSHIP',
      entityType: 'CALL',
      patternId: 'generic.relationship',
      sourceId: 'caller-1',
      targetId: 'fetch-conn',
      status: 'DETERMINISTIC',
      confidence: 'HIGH',
      evidence: { filePath: 'client.ts', lineNumber: 5 },
      metadata: { httpMethod: 'GET', urlPath: 'http://localhost:2929/socketio' },
    },
  ];
  stitchIntraRepoHttpCalls(
    stitchNodes,
    stitchEdges,
    new Map([['fetch-conn', stitchNodes[1]]])
  );
  assert.ok(
    !stitchEdges.some((e) => e.targetId === 'route-post'),
    'GET fetch("/socketio") must not stitch to an incompatible POST /socketio endpoint'
  );

  // [PAT-EXT-58]: Chained this.<method>().pipe(), destructured ReturnType<typeof fn> parameter, external JSX RENDERS, and this alias owner propagation
  const pat58Path = path.join(fnCallsRepo, 'pat58Resolution.tsx');
  const pat58Code = `
    import React, { createContext, useContext } from 'react';
    import { getOctokit } from '@actions/github';
    import { ExternalModal } from '@acme/ui';

    type Octokit = ReturnType<typeof getOctokit>;

    export const TRPCContext = createContext(null as any);
    export function useTRPC(opts?: { context?: any }) {
      const Context = opts?.context ?? TRPCContext;
      return useContext(Context);
    }

    export function renderExternalModal() {
      return <ExternalModal />;
    }

    export async function deployWithOctokit({ octokit }: { octokit: Octokit }) {
      return octokit.rest.repos.createDeployment({ owner: 'a', repo: 'b', ref: 'main' });
    }

    export class QueryManager {
      public getObservableFromLink() {
        return { pipe: (fn: any) => fn };
      }
      public mutate() {
        return this.getObservableFromLink().pipe((x: any) => x);
      }
      private sendRequest(data: any) {
        return data;
      }
      public execute(data: any) {
        const obj = this;
        return {
          then(resolve: any) {
            return resolve(obj.sendRequest(data));
          },
        };
      }
    }
  `;
  const pat58Sf = ts.createSourceFile(
    pat58Path,
    pat58Code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const pat58Ev = makeEv('pat58Resolution.tsx', pat58Sf);
  const pat58Rels: StructuralEntity[] = [];
  const ownerByNode = new Map<ts.Node, string>();
  walkNodes(pat58Sf, (node) => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'execute') {
      ownerByNode.set(node, 'owner-execute');
    }
    pat58Rels.push(...toList(visitRelationship(node, pat58Sf, pat58Ev, nextId, fnCallsRepo, 'source-pat58')));
  });
  const getObsId = contractEntityId(
    'function-calls',
    'pat58Resolution.tsx',
    'Public Method: QueryManager.getObservableFromLink',
    'contract.public-method'
  );
  assert.ok(
    pat58Rels.some((r) => r.name === 'Call: this.pipe()' && r.targetId === getObsId),
    'this.getObservableFromLink().pipe(...) must resolve to Public Method: QueryManager.getObservableFromLink'
  );
  const actionsGithubId = packageConnectorId('@actions/github');
  assert.ok(
    pat58Rels.some((r) => r.name === 'Call: octokit.createDeployment()' && r.targetId === actionsGithubId),
    'destructured parameter typed via ReturnType<typeof getOctokit> must resolve member calls to Package: @actions/github'
  );
  const acmeUiId = packageConnectorId('@acme/ui');
  assert.ok(
    pat58Rels.some((r) => r.name === 'Renders: <ExternalModal />' && r.targetId === acmeUiId),
    'external JSX component must emit RENDERS edge to Package: @acme/ui'
  );
  const trpcContextId = contractEntityId(
    'function-calls',
    'pat58Resolution.tsx',
    'React Component: TRPCContext',
    'contract.react-functional-component'
  );
  assert.ok(
    pat58Rels.some((r) => r.name === 'Call: TRPCContext()' && r.targetId === trpcContextId),
    'useContext(Context) where const Context = opts?.context ?? TRPCContext must link to React Component: TRPCContext'
  );
  const multiOwners = propagateLocalHelperOwners(pat58Sf, ownerByNode);
  let sendRequestOwnedByExecute = false;
  for (const [astNode, owners] of multiOwners.entries()) {
    if (ts.isMethodDeclaration(astNode) && ts.isIdentifier(astNode.name) && astNode.name.text === 'sendRequest') {
      sendRequestOwnedByExecute = owners.has('owner-execute');
    }
  }
  assert.ok(
    sendRequestOwnedByExecute,
    'const obj = this; obj.sendRequest(...) must propagate public method owner to private helper sendRequest'
  );
});

test('PAT-EXT-63..66: getter sub-property disambiguation, polymorphic factory return type, inline middleware scoping, NestJS method-scoped decorators/filters/pipes/middleware, MDX top-level exports, Redis cache dialect, and external fluent chain classification', () => {
  const fnCallsRepo = fixture('function-calls');
  const pat63Path = path.join(fnCallsRepo, 'src', 'pat63Resolution.ts');
  const pat63Code = `
    import Redis from 'ioredis';
    import express from 'express';

    export class HonoRequest {
      public header(name: string) {
        return name;
      }
    }

    export class Context {
      public get req() {
        return new HonoRequest();
      }
      public get res() {
        return { headers: new Headers() };
      }
      public header(name: string, value: string) {
        return value;
      }
      public get(key: string) {
        return key;
      }
    }

    export class ProvisionResourceHandler {
      public provision() {
        return true;
      }
    }
    class AlphaHandler extends ProvisionResourceHandler {
      public override provision() {
        return true;
      }
    }
    class BetaHandler extends ProvisionResourceHandler {
      public override provision() {
        return false;
      }
    }
    function createProvisionHandler(kind: string): ProvisionResourceHandler {
      if (kind === 'a') return new AlphaHandler();
      return new BetaHandler();
    }

    export function handleHonoAndFactory(c: Context, kind: string) {
      const tok = c.req.header('authorization');
      const ct = c.res.headers.get('content-type');
      const handler = createProvisionHandler(kind);
      handler.provision();
      return { tok, ct };
    }

    const app = express();
    app.use(async (req, res, next) => {
      next();
    });
    app.use(async (req, res, next) => {
      next();
    });

    function fatalError(err: Error) {
      return err.message;
    }
    process.once('uncaughtException', fatalError);

    export class JwtAuthGuard {
      public canActivate() {
        return true;
      }
    }
    export class HttpExceptionFilter {
      public catch() {
        return null;
      }
    }
    export class ParseIntPipe {
      public transform(val: string) {
        return Number(val);
      }
    }
    export class LoggerMiddleware {
      public use() {
        return null;
      }
    }
    function UseGuards(..._guards: any[]): any { return () => {}; }
    function UseFilters(..._filters: any[]): any { return () => {}; }
    function Param(_key: string, ..._pipes: any[]): any { return () => {}; }

    export class CatsController {
      @UseGuards(JwtAuthGuard)
      @UseFilters(HttpExceptionFilter)
      public findOne(@Param('id', ParseIntPipe) id: number) {
        return id;
      }
    }

    export class AppModule {
      public configure(consumer: any) {
        consumer.apply(LoggerMiddleware).forRoutes('*');
      }
    }

    const redisClient = new Redis();
    export function readSession(key: string) {
      return redisClient.get(key);
    }
  `;
  const pat63Sf = ts.createSourceFile(
    pat63Path,
    pat63Code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const pat63Ev = makeEv('pat63Resolution.ts', pat63Sf);
  const nextId = makeNextId();
  const pat63Contracts: StructuralEntity[] = [];
  const pat63Rels: StructuralEntity[] = [];
  const pat63Connectors: StructuralEntity[] = [];
  const ownerByNode = new Map<ts.Node, string>();

  walkNodes(pat63Sf, (node) => {
    const contracts = toList(visitContract(node, pat63Sf, pat63Ev, nextId, null, 'pat63Resolution.ts'));
    for (const c of contracts) {
      pat63Contracts.push(c);
      if (c.name === 'Event Listener: uncaughtException') {
        ownerByNode.set(node, 'owner-uncaught-exception');
      }
    }
    pat63Connectors.push(...toList(visitOpenConnector(node, pat63Sf, pat63Ev, nextId, fnCallsRepo)));
    pat63Rels.push(...toList(visitRelationship(node, pat63Sf, pat63Ev, nextId, fnCallsRepo, 'source-pat63')));
  });

  // 1. c.req.header() resolves to Public Method: HonoRequest.header (not Context.header)
  const honoReqHeaderId = contractEntityId(
    'function-calls',
    'pat63Resolution.ts',
    'Public Method: HonoRequest.header',
    'contract.public-method'
  );
  assert.ok(
    pat63Rels.some((r) => r.name === 'Call: c.header()' && r.targetId === honoReqHeaderId),
    'c.req.header() must resolve to Public Method: HonoRequest.header via getter return class'
  );

  // c.res.headers.get() must NOT resolve to Context.get
  const contextGetId = contractEntityId(
    'function-calls',
    'pat63Resolution.ts',
    'Public Method: Context.get',
    'contract.public-method'
  );
  assert.ok(
    !pat63Rels.some((r) => r.name === 'Call: c.get()' && r.targetId === contextGetId),
    'c.res.headers.get() must not falsely resolve to Public Method: Context.get'
  );

  // 2. Polymorphic factory with explicit return type resolves to base class method
  const baseProvisionId = contractEntityId(
    'function-calls',
    'pat63Resolution.ts',
    'Public Method: ProvisionResourceHandler.provision',
    'contract.public-method'
  );
  assert.ok(
    pat63Rels.some((r) => r.name === 'Call: handler.provision()' && r.targetId === baseProvisionId),
    'polymorphic factory with return type annotation must resolve to ProvisionResourceHandler.provision'
  );

  // 3. Multiple inline middlewares in the same file get distinct contract IDs
  const inlineMws = pat63Contracts.filter((c) => c.name === 'Middleware: Inline Middleware');
  assert.equal(inlineMws.length, 2);
  assert.notEqual(
    inlineMws[0].id,
    inlineMws[1].id,
    'Multiple inline middlewares in the same file must have distinct line-scoped IDs'
  );

  // 4. Event listener callback propagates ownership to local helper function
  const multiOwners = propagateLocalHelperOwners(pat63Sf, ownerByNode);
  let fatalOwnedByListener = false;
  for (const [astNode, owners] of multiOwners.entries()) {
    if (ts.isFunctionDeclaration(astNode) && astNode.name?.text === 'fatalError') {
      fatalOwnedByListener = owners.has('owner-uncaught-exception');
    }
  }
  assert.ok(
    fatalOwnedByListener,
    'process.once("uncaughtException", fatalError) must propagate event listener owner to fatalError'
  );

  // 5. NestJS method-scoped decorators, @UseFilters, @Param pipe, and MiddlewareConsumer.apply
  const catsFindOneId = contractEntityId(
    'function-calls',
    'pat63Resolution.ts',
    'Public Method: CatsController.findOne',
    'contract.public-method'
  );
  const guardCanActivateId = contractEntityId(
    'function-calls',
    'pat63Resolution.ts',
    'Public Method: JwtAuthGuard.canActivate',
    'contract.public-method'
  );
  const filterCatchId = contractEntityId(
    'function-calls',
    'pat63Resolution.ts',
    'Public Method: HttpExceptionFilter.catch',
    'contract.public-method'
  );
  const pipeTransformId = contractEntityId(
    'function-calls',
    'pat63Resolution.ts',
    'Public Method: ParseIntPipe.transform',
    'contract.public-method'
  );
  const mwUseId = contractEntityId(
    'function-calls',
    'pat63Resolution.ts',
    'Public Method: LoggerMiddleware.use',
    'contract.public-method'
  );
  assert.ok(
    pat63Rels.some(
      (r) =>
        r.name === 'Call: JwtAuthGuard.canActivate()' &&
        r.sourceId === catsFindOneId &&
        r.targetId === guardCanActivateId
    ),
    'Method-level @UseGuards must set sourceId to Public Method: CatsController.findOne'
  );
  assert.ok(
    pat63Rels.some(
      (r) =>
        r.name === 'Call: HttpExceptionFilter.catch()' &&
        r.sourceId === catsFindOneId &&
        r.targetId === filterCatchId
    ),
    '@UseFilters must emit Call: HttpExceptionFilter.catch() edge to HttpExceptionFilter.catch'
  );
  assert.ok(
    pat63Rels.some(
      (r) =>
        r.name === 'Call: ParseIntPipe.transform()' &&
        r.sourceId === catsFindOneId &&
        r.targetId === pipeTransformId
    ),
    'Parameter-level @Param("id", ParseIntPipe) must emit Call: ParseIntPipe.transform() edge'
  );
  assert.ok(
    pat63Rels.some(
      (r) => r.name === 'Call: LoggerMiddleware.use()' && r.targetId === mwUseId
    ),
    'consumer.apply(LoggerMiddleware) in configure() must emit Call: LoggerMiddleware.use() edge'
  );

  // 6. Redis client.get() sets metadata.dialect = 'redis' and maps to Cache: Redis receptor box
  const redisConn = pat63Connectors.find((c) => c.name === 'DB Call: redisClient.get');
  assert.ok(redisConn, 'redisClient.get must emit DB Call: redisClient.get');
  assert.equal(redisConn.metadata?.dialect, 'redis');
  const box = classifyConnectorReceptorBox(redisConn as StructuralNode);
  assert.equal(box, 'Cache: Redis');

  // 7. MDX top-level export const declarations after markdown text are hoisted above __MdxComponent__
  const mdxRaw = [
    "import { db } from '#/lib/db';",
    '',
    '# Demo Heading',
    '',
    "export const demo = db.demo.find({ where: { slug: 'parallel-routes' } });",
    '',
    '<DemoCard item={demo} />',
  ].join('\n');
  const mdxProcessed = preprocessAstroOrMdxSource('/repo/app/parallel-routes/readme.mdx', mdxRaw);
  const exportConstIdx = mdxProcessed.indexOf('export const demo =');
  const mdxCompIdx = mdxProcessed.indexOf('export default function __MdxComponent__()');
  assert.ok(
    exportConstIdx >= 0 && mdxCompIdx > exportConstIdx,
    'Top-level export const in .mdx must precede __MdxComponent__ JSX wrapper'
  );

  // 8. Chained calls on external package function returns classify as DYNAMIC_BOUNDARY in healthMetrics
  const externalChainEdge: StructuralEdge = {
    id: 'edge-ora-succeed',
    name: 'Call: ora.succeed()',
    type: 'RELATIONSHIP',
    entityType: 'CALL',
    patternId: 'relationship.invoke-returned-function',
    sourceId: 'src-1',
    status: 'INFERRED',
    confidence: 'LOW',
    metadata: { shapeKey: 'sk1/CALL/Import/Chain(Call).Prop(Id)' },
    evidence: [],
  };
  assert.equal(
    classifyCallEdgeResolution(externalChainEdge),
    'DYNAMIC_BOUNDARY',
    'Unprovable external package fluent chain without unresolvedReason must classify as DYNAMIC_BOUNDARY'
  );
});

test('PAT-EXT-67..70: Vue SFC preprocessing, Pinia/Nuxt/factory contracts, getter property access, Mongoose/Sequelize @InjectModel, class extends, and Axios/middleware/Reflect.getMetadata guards', () => {
  const repoRoot = fixture('function-calls');
  const nextId = makeNextId();

  // 1. Vue SFC (<script setup> + <template>) preprocessing into TSX
  const vueRaw = [
    '<script setup lang="ts">',
    "import { ElButton } from 'element-plus';",
    'const count = 0;',
    '</script>',
    '<template>',
    '  <ElButton>{{ count }}</ElButton>',
    '</template>',
  ].join('\n');
  const vueProcessed = preprocessAstroOrMdxSource('/repo/apps/admin/app/pages/index.vue', vueRaw);
  assert.ok(
    vueProcessed.includes('export default function __VueSfcComponent__()'),
    '.vue SFC must preprocess into a default-exported __VueSfcComponent__ wrapper'
  );
  assert.ok(
    vueProcessed.includes('<ElButton'),
    '.vue SFC template PascalCase tags must be preserved inside __VueSfcComponent__'
  );

  // 2. Pure markdown .mdx under docs/ without imports/exports emits empty string
  const pureDocsMdx = '# Architecture Guide\n\nSome prose with <Note>inline tag</Note>.';
  assert.equal(
    preprocessAstroOrMdxSource('/repo/docs/guides/flow.mdx', pureDocsMdx).trim(),
    '',
    'Non-route .mdx documentation without import/export statements must not synthesize __MdxComponent__'
  );

  // 3. Pinia defineStore, Nuxt defineNuxtPlugin, exported factory consts, @InjectModel, getter access, and soundness guards
  const pat67Source = [
    "import axios from '/assets/logo.svg';",
    "import { calculateSum } from './math';",
    'export const useManagerStore = defineStore("manager", () => ({}));',
    'export const db = remember("db", () => createDb());',
    'export const adminRequest = createAxiosInstance({ baseURL: "/api" });',
    'export const UploadTo = Enum({ LOCAL: 1 });',
    'export const DEFAULT_PROGRESS_CONTROLLER = { start: () => {}, done: () => {} };',
    'export const rules = { "prefer-throw-redirect": calculateSum };',
    'export default defineNuxtPlugin(() => {});',
    'class BaseController {}',
    'class MiddlewareMeta {',
    '  get instance() { return this._inst; }',
    '}',
    '@Controller()',
    'class ArticleController extends BaseController {',
    '  constructor(@InjectModel("Cat") private readonly catModel: Model<any>) { super(); }',
    '  @UseBefore(CompressionMiddleware)',
    '  async run(meta: MiddlewareMeta, request: any, response: any, next: any) {',
    '    const inst = meta.instance;',
    '    meta.instance.use(request, response, next);',
    '    adminRequest.get("/users", { params: { page: 1 } });',
    '    Reflect.getMetadata("design:type", BaseController.prototype, "run");',
    '    return this.catModel.find();',
    '  }',
    '}',
  ].join('\n');

  const pat67Sf = ts.createSourceFile(
    path.join(repoRoot, 'pat67Resolution.ts'),
    pat67Source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const pat67Ev = makeEv('pat67Resolution.ts', pat67Sf);

  const pat67Boundaries: StructuralEntity[] = [];
  const pat67Contracts: StructuralEntity[] = [];
  const pat67Connectors: StructuralEntity[] = [];
  const pat67Rels: StructuralEntity[] = [];

  walkNodes(pat67Sf, (n) => {
    pat67Boundaries.push(...toList(visitBoundary(n, pat67Sf, pat67Ev, nextId)));
    pat67Contracts.push(...toList(visitContract(n, pat67Sf, pat67Ev, nextId, null, 'pat67Resolution.ts')));
    pat67Connectors.push(...toList(visitOpenConnector(n, pat67Sf, pat67Ev, nextId, repoRoot)));
    pat67Rels.push(...toList(visitRelationship(n, pat67Sf, pat67Ev, nextId, repoRoot, 'src-pat67')));
  });

  // Pinia defineStore -> contract.pinia-define-store
  assert.ok(
    pat67Contracts.some(
      (c) => c.name === 'Exported Function: useManagerStore' && c.patternId === 'contract.pinia-define-store'
    ),
    'defineStore initializer must extract contract.pinia-define-store'
  );

  // Exported factory constants -> contract.factory-call-exported-const & contract.exported-factory-instance-and-enum-call
  assert.ok(
    pat67Contracts.some(
      (c) => c.name === 'Exported Function: db' && c.patternId === 'contract.factory-call-exported-const'
    ),
    'remember() initializer must extract contract.factory-call-exported-const'
  );
  assert.ok(
    pat67Contracts.some(
      (c) =>
        c.name === 'Exported Function: adminRequest' &&
        c.patternId === 'contract.exported-factory-instance-and-enum-call'
    ),
    'createAxiosInstance() initializer must extract contract.exported-factory-instance-and-enum-call'
  );
  assert.ok(
    pat67Contracts.some(
      (c) =>
        c.name === 'Exported Function: UploadTo' &&
        c.patternId === 'contract.exported-factory-instance-and-enum-call'
    ),
    'Enum() initializer must extract contract.exported-factory-instance-and-enum-call'
  );

  // SCREAMING_SNAKE_CASE object literal with no-op methods must not extract as EXPORTED_FUNCTION
  assert.ok(
    !pat67Contracts.some((c) => c.name === 'Exported Function: DEFAULT_PROGRESS_CONTROLLER'),
    'DEFAULT_PROGRESS_CONTROLLER constant object literal must not be misclassified as EXPORTED_FUNCTION'
  );

  // Hyphenated rule object literal extracts as data store, not EXPORTED_FUNCTION
  assert.ok(
    pat67Contracts.some(
      (c) => c.name === 'Exported Module: rules' && c.patternId === 'contract.exported-object-literal-data-store'
    ),
    'Hyphenated ESLint rule map must extract as contract.exported-object-literal-data-store'
  );

  // Nuxt plugin default export -> contract.nuxt-plugin-and-middleware-entry-points with INGRESS role
  assert.ok(
    pat67Contracts.some(
      (c) =>
        c.patternId === 'contract.nuxt-plugin-and-middleware-entry-points' &&
        c.metadata?.flowRole === 'INGRESS'
    ),
    'export default defineNuxtPlugin(...) must extract with contract.nuxt-plugin-and-middleware-entry-points and INGRESS role'
  );

  // Root-relative asset import ('/assets/logo.svg') must not emit EXTERNAL_PACKAGE open connector
  assert.ok(
    !pat67Connectors.some((c) => c.name.includes('/assets/logo.svg')),
    'Root-relative static asset import must not be extracted as EXTERNAL_PACKAGE'
  );

  // @InjectModel('Cat') this.catModel.find() -> open-connector.mongoose-and-sequelize-model-queries
  assert.ok(
    pat67Connectors.some(
      (c) =>
        c.name === 'DB Call: catModel.find' &&
        c.patternId === 'open-connector.mongoose-and-sequelize-model-queries'
    ),
    '@InjectModel model query must emit open-connector.mongoose-and-sequelize-model-queries'
  );

  // Class inheritance extends -> relationship.class-inheritance-extends
  assert.ok(
    pat67Rels.some(
      (r) =>
        r.name === 'Extends: BaseController' &&
        r.patternId === 'relationship.class-inheritance-extends'
    ),
    'class ArticleController extends BaseController must emit relationship.class-inheritance-extends'
  );

  // Getter property read (meta.instance) -> relationship.getter-property-access-invocation
  assert.ok(
    pat67Rels.some(
      (r) =>
        r.name === 'Getter: instance' &&
        r.patternId === 'relationship.getter-property-access-invocation'
    ),
    'Accessing meta.instance where MiddlewareMeta defines get instance() must emit relationship.getter-property-access-invocation'
  );

  // Soundness guards:
  // - meta.instance.use(request, response, next) must NOT emit Middleware contract
  assert.ok(
    !pat67Contracts.some((c) => c.entityType === 'MIDDLEWARE'),
    'meta.instance.use(request, response, next) must not emit a false-positive MIDDLEWARE contract'
  );
  // - adminRequest.get('/users', { params }) must NOT emit Express Route contract
  assert.ok(
    !pat67Contracts.some((c) => c.patternId === 'contract.express-route'),
    'adminRequest.get("/users", { params }) must not emit a false-positive contract.express-route'
  );
  // - Reflect.getMetadata('design:type', BaseController.prototype, 'run') must NOT emit relationship.prototype-mixin
  assert.ok(
    !pat67Rels.some((r) => r.patternId === 'relationship.prototype-mixin'),
    'Reflect.getMetadata(..., BaseController.prototype, ...) must not emit a false-positive relationship.prototype-mixin'
  );
});

test('Scout Leverage Bug & Pattern Fixes: colliding class boundary disambiguation, private this.method external hijack guard, inherited getter & generic upper-bound resolution, new (require())(), destructured hook call, and bracket dispatch table', () => {
  const fnCallsRepo = fixture('function-calls');
  const nextId = makeNextId();

  // 1. Colliding CLASS boundary disambiguation via boundaryEntityId
  const uniqueClassId = boundaryEntityId('pkg', 'src/a/User.ts', 'Class: User');
  assert.equal(
    uniqueClassId,
    stableEntityId('pkg', 'BOUNDARY', 'Class: User'),
    'Non-colliding CLASS boundary must preserve file-independent Catalyst Hash'
  );
  setActiveCollidingBoundaryKeys(new Set(['pkg::Class: Post']));
  try {
    const postIdA = boundaryEntityId('pkg', 'src/entity/Post.ts', 'Class: Post');
    const postIdB = boundaryEntityId('pkg', 'src/schema/Post.ts', 'Class: Post');
    assert.notEqual(
      postIdA,
      postIdB,
      'Colliding CLASS boundaries in different files of the same deployment unit must have distinct file-disambiguated IDs'
    );
  } finally {
    setActiveCollidingBoundaryKeys(null);
  }

  // 2. AST extraction & resolution for inherited getter chain, generic constraint, private this.method guard,
  //    new (require('koa'))(), destructured store hook call, dynamic bracket dispatch, and self-loop guards
  const leveragePath = path.join(fnCallsRepo, 'leverageFixes.ts');
  const leverageCode = `
    import { findDriver } from 'external-driver-pkg';

    export class QueryDriver {
      createQueryRunner() {
        return 'runner';
      }
      connect() {
        return true;
      }
    }

    export class BaseRepository {
      get driver(): QueryDriver {
        return new QueryDriver();
      }
    }

    export class UserRepository<T extends QueryDriver> extends BaseRepository {
      private customDriver!: T;
      private joinAttribute: any;

      private findDriver() {
        return 'internal';
      }

      private computeZone() {
        return { run: () => {} };
      }

      executeAll(ctx: any) {
        this.findDriver();
        this.driver.createQueryRunner();
        this.customDriver.connect();
        this.joinAttribute.relation.joinColumns.find((c: any) => c.id);
        this.computeZone().run();
        inspectProto(ctx, QueryDriver.prototype);
        const app = new (require('koa'))();
        return app;
      }
    }

    export function useConversationStore() {
      return {
        setAssistantLoading: (_v: boolean) => {},
      };
    }

    export const actionHandlers = {
      alpha: () => 'a',
      beta: () => 'b',
    };

    export function runAction(kind: 'alpha' | 'beta') {
      const { setAssistantLoading } = useConversationStore();
      setAssistantLoading(true);
      actionHandlers[kind]();
    }
  `;

  const leverageSf = ts.createSourceFile(leveragePath, leverageCode, ts.ScriptTarget.Latest, true);
  const leverageEv = makeEv('leverageFixes.ts', leverageSf);
  const rels: StructuralEntity[] = [];

  walkNodes(leverageSf, (node) => {
    rels.push(...toList(visitRelationship(node, leverageSf, leverageEv, nextId, fnCallsRepo, 'source-leverage')));
  });

  const externalDriverPkgId = packageConnectorId('external-driver-pkg');
  const koaPkgId = packageConnectorId('koa');

  // Guard: private this.findDriver() must NOT resolve to external-driver-pkg
  assert.ok(
    !rels.some((r) => r.name === 'Call: this.findDriver()' && r.targetId === externalDriverPkgId),
    'this.findDriver() on a class with a private findDriver() method must not be hijacked by same-named external import'
  );

  // Inherited getter property chain call: this.driver.createQueryRunner() -> Public Method: QueryDriver.createQueryRunner
  assert.ok(
    rels.some((r) => r.name === 'Call: this.createQueryRunner()' && Boolean(r.targetId)),
    'this.driver.createQueryRunner() via inherited BaseRepository getter must resolve to Public Method: QueryDriver.createQueryRunner'
  );

  // Generic type parameter upper bound: this.customDriver.connect() where T extends QueryDriver -> Public Method: QueryDriver.connect
  assert.ok(
    rels.some((r) => r.name === 'Call: this.connect()' && Boolean(r.targetId)),
    'this.customDriver.connect() on property typed with generic T extends QueryDriver must resolve to Public Method: QueryDriver.connect'
  );

  // Guard: chained .find() on untyped this.joinAttribute.relation.joinColumns and this.computeZone().run() must NOT self-loop to Class: UserRepository
  const userRepoClassId = boundaryEntityId('function-calls', 'leverageFixes.ts', 'Class: UserRepository');
  assert.ok(
    !rels.some((r) => r.targetId === userRepoClassId),
    'this.joinAttribute.relation.joinColumns.find() and this.computeZone().run() must not fabricate self-loop edges to Class: UserRepository'
  );

  // Guard: inspectProto(ctx, QueryDriver.prototype) must NOT emit relationship.prototype-mixin
  assert.ok(
    !rels.some((r) => r.patternId === 'relationship.prototype-mixin'),
    'Non-mixin function call passing SomeClass.prototype as second arg must not emit relationship.prototype-mixin'
  );

  // new (require('koa'))() -> Package: koa
  assert.ok(
    rels.some((r) => r.name === 'Call: new require(koa)()' && r.targetId === koaPkgId),
    'new (require("koa"))() must emit a deterministic CALL relationship targeting Package: koa'
  );

  // Destructured hook call: const { setAssistantLoading } = useConversationStore(); setAssistantLoading(true)
  assert.ok(
    rels.some((r) => r.name === 'Call: setAssistantLoading()' && Boolean(r.targetId)),
    'Destructured method call from useConversationStore() must trace back to Exported Function: useConversationStore'
  );

  // Dynamic bracket dispatch: actionHandlers[kind]() -> Exported Module: actionHandlers
  assert.ok(
    rels.some((r) => r.name === 'Call: actionHandlers[]()' && Boolean(r.targetId)),
    'Dynamic bracket dispatch actionHandlers[kind]() must resolve to the dispatch table contract'
  );
});

test('Wave 2 Fixes (PAT-EXT-72): decorator scope ownership, Next.js/Hono/Vue conventions, and soundness guards', () => {
  const fnCallsRepo = fixture('function-calls');
  let idSeq = 0;
  const nextId = () => `id-w2-${++idSeq}`;
  const makeEv = (filePath: string, sf: ts.SourceFile) => (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return {
      filePath,
      lineNumber: line + 1,
      snippet: node.getText(sf).slice(0, 80).replace(/\s+/g, ' ').trim(),
    };
  };

  // 1. Express format() guard: custom format.bold() must not emit Express Response: format
  const fmtCode = `
    const format = { bold: (s: string) => s, format: (s: string) => s };
    export function renderBanner() {
      return format.format('hi');
    }
  `;
  const fmtSf = ts.createSourceFile(path.join(fnCallsRepo, 'fmt.ts'), fmtCode, ts.ScriptTarget.Latest, true);
  const fmtContracts: StructuralEntity[] = [];
  walkNodes(fmtSf, (node) => {
    fmtContracts.push(...toList(visitContract(node, fmtSf, makeEv('fmt.ts', fmtSf), nextId, null, 'fmt.ts')));
  });
  assert.ok(
    !fmtContracts.some((c) => c.patternId === 'contract.express-content-negotiation'),
    'format.format() on a non-res receiver must not emit contract.express-content-negotiation'
  );

  // 2. Hono .on() route and createRoute factory constant extraction + as const config exclusion
  const honoCode = `
    import { createRoute } from '@hono/zod-openapi';
    import { P } from 'ts-pattern';
    export const listTasksRoute = createRoute({ method: 'get', path: '/tasks' });
    export const CONFIG_OBJ = { key: 'val' } as const;
    export const MATCHER = { check: P.when((x: number) => x > 0) };
    export function setupHono(server: any) {
      server.on(['GET', 'POST'], '/api/auth/*', (c: any) => c.text('ok'));
    }
  `;
  const honoSf = ts.createSourceFile(path.join(fnCallsRepo, 'honoRoutes.ts'), honoCode, ts.ScriptTarget.Latest, true);
  const honoContracts: StructuralEntity[] = [];
  walkNodes(honoSf, (node) => {
    honoContracts.push(...toList(visitContract(node, honoSf, makeEv('honoRoutes.ts', honoSf), nextId, null, 'honoRoutes.ts')));
  });
  assert.ok(
    honoContracts.some((c) => c.name === 'Exported Function: listTasksRoute' && c.patternId === 'contract.factory-call-exported-const'),
    'createRoute(...) export must extract as Exported Function: listTasksRoute (contract.factory-call-exported-const)'
  );
  assert.ok(
    honoContracts.some((c) => c.entityType === 'HTTP_ENDPOINT' && c.name.includes('/api/auth/*')),
    'server.on(["GET", "POST"], "/api/auth/*", handler) must extract HTTP_ENDPOINT contracts'
  );
  assert.ok(
    !honoContracts.some((c) => c.name.includes('CONFIG_OBJ') || c.name.includes('MATCHER')),
    'as const object literals and ts-pattern P.when() objects must not be misclassified as EXPORTED_FUNCTION'
  );

  // 3. Next.js special files & Turborepo generator ingress classification
  const sitemapCode = `export default function sitemap() { return []; }`;
  const sitemapSf = ts.createSourceFile(path.join(fnCallsRepo, 'app/sitemap.ts'), sitemapCode, ts.ScriptTarget.Latest, true);
  const sitemapContracts: StructuralEntity[] = [];
  walkNodes(sitemapSf, (node) => {
    sitemapContracts.push(...toList(visitContract(node, sitemapSf, makeEv('app/sitemap.ts', sitemapSf), nextId, null, 'app/sitemap.ts')));
  });
  assert.ok(
    sitemapContracts.some((c) => c.metadata?.flowRole === 'INGRESS'),
    'app/sitemap.ts default export must be marked flowRole: INGRESS'
  );
});

test('Wave 3 Fixes (PAT-EXT-73): interface implementation dispatch, useRef<Class> resolution, dynamic defineProperty guard, and plugin prototype delegation', () => {
  const fnCallsRepo = fixture('function-calls');
  let idSeq = 0;
  const nextId = () => `id-w3-${++idSeq}`;
  const makeEv = (filePath: string, sf: ts.SourceFile) => (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return {
      filePath,
      lineNumber: line + 1,
      snippet: node.getText(sf).slice(0, 80).replace(/\s+/g, ' ').trim(),
    };
  };

  // 1. Interface method dispatch + getter backing field + useRef<Class>
  const ifaceCode = `
    import { useRef } from 'react';
    export interface IResourceManager {
      readResource(uri: string): Promise<string>;
    }
    export class ResourceManagerImpl implements IResourceManager {
      async readResource(uri: string) {
        return uri;
      }
      async disconnect() {}
    }
    export class ServerHost {
      private _manager: IResourceManager;
      constructor(manager: IResourceManager) {
        this._manager = manager;
      }
      get manager(): IResourceManager {
        return this._manager;
      }
      async handleRead(uri: string) {
        return this.manager.readResource(uri);
      }
    }
    export function useClientHook() {
      const clientRef = useRef<ResourceManagerImpl | null>(null);
      return () => clientRef.current?.disconnect();
    }
  `;
  const ifacePath = path.join(fnCallsRepo, 'ifaceDispatch.ts');
  const ifaceSf = ts.createSourceFile(ifacePath, ifaceCode, ts.ScriptTarget.Latest, true);
  const ifaceRels: StructuralEntity[] = [];
  walkNodes(ifaceSf, (node) => {
    ifaceRels.push(...toList(visitRelationship(node, ifaceSf, makeEv('ifaceDispatch.ts', ifaceSf), nextId, fnCallsRepo, 'source-w3')));
  });
  assert.ok(
    ifaceRels.some((r) => r.name === 'Call: this.readResource()' && Boolean(r.targetId)),
    'this.manager.readResource(uri) via getter returning IResourceManager must resolve to ResourceManagerImpl.readResource'
  );
  assert.ok(
    ifaceRels.some((r) => r.name === 'Call: clientRef.disconnect()' && Boolean(r.targetId)),
    'clientRef.current?.disconnect() typed via useRef<ResourceManagerImpl | null> must resolve to ResourceManagerImpl.disconnect'
  );

  // 2. Dynamic Object.defineProperty(this, prop, ...) loop guard + plugin prototype method delegation
  const pluginCode = `
    export class ProxyAdapter {
      setup(target: any) {
        for (const prop of ['a', 'b']) {
          Object.defineProperty(this, prop, { get: () => target[prop] });
        }
      }
    }
    export default function jsxPlugin() {
      function Parser() {}
      Parser.prototype.jsx_readToken = function () {
        return 1;
      };
    }
  `;
  const pluginPath = path.join(fnCallsRepo, 'pluginProto.ts');
  const pluginSf = ts.createSourceFile(pluginPath, pluginCode, ts.ScriptTarget.Latest, true);
  const pluginContracts: StructuralEntity[] = [];
  const pluginRels: StructuralEntity[] = [];
  walkNodes(pluginSf, (node) => {
    pluginContracts.push(...toList(visitContract(node, pluginSf, makeEv('pluginProto.ts', pluginSf), nextId, null, 'pluginProto.ts')));
    pluginRels.push(...toList(visitRelationship(node, pluginSf, makeEv('pluginProto.ts', pluginSf), nextId, fnCallsRepo, 'source-plugin')));
  });
  assert.ok(
    !pluginContracts.some((c) => c.name === 'Property Getter: prop'),
    'Dynamic Object.defineProperty(this, prop, ...) in a loop must not emit Property Getter: prop'
  );
  assert.ok(
    pluginRels.some(
      (r) =>
        r.patternId === 'relationship.module-export-delegation' &&
        r.name === 'Delegates: Prototype Method: Parser.prototype.jsx_readToken' &&
        Boolean(r.targetId)
    ),
    'Enclosing exported plugin function must delegate to inner Prototype Method: Parser.prototype.jsx_readToken'
  );
});

test('[PAT-EXT-74] Wave 4: Vue SFC PascalCase component naming, EXPORTED_MODULE router/Hono instances vs CLI commands, router MOUNTS/BINDS_ROUTE parity, and Hono frameworkCoverage adapter', () => {
  const nextId = makeNextId();

  // 1. Vue SFC PascalCase naming & file-scoped ID disambiguation (no Module Export (Default) collision)
  assert.equal(deriveVueSfcComponentName('components/Header/index.vue'), 'Vue Component: Header');
  assert.equal(deriveVueSfcComponentName('pages/users/[id].vue'), 'Vue Component: UsersId');
  const vueHeaderCode = `export default { __vueSfcSetup: true };`;
  const vueFooterCode = `export default { name: 'Footer' };`;
  const headerSf = ts.createSourceFile('/repo/components/Header/index.vue', vueHeaderCode, ts.ScriptTarget.Latest, true);
  const footerSf = ts.createSourceFile('/repo/components/Footer/index.vue', vueFooterCode, ts.ScriptTarget.Latest, true);
  const headerContracts: StructuralEntity[] = [];
  const footerContracts: StructuralEntity[] = [];
  walkNodes(headerSf, (n) => {
    headerContracts.push(...toList(visitContract(n, headerSf, makeEv('components/Header/index.vue', headerSf), nextId, null, 'components/Header/index.vue')));
  });
  walkNodes(footerSf, (n) => {
    footerContracts.push(...toList(visitContract(n, footerSf, makeEv('components/Footer/index.vue', footerSf), nextId, null, 'components/Footer/index.vue')));
  });
  const headerComp = headerContracts.find((c) => c.name === 'Vue Component: Header');
  const footerComp = footerContracts.find((c) => c.name === 'Vue Component: Footer');
  assert.ok(headerComp && headerComp.entityType === 'REACT_COMPONENT');
  assert.ok(footerComp && footerComp.entityType === 'REACT_COMPONENT');
  const headerId = contractEntityId('repo', 'components/Header/index.vue', headerComp.name, headerComp.patternId);
  const footerId = contractEntityId('repo', 'components/Footer/index.vue', footerComp.name, footerComp.patternId);
  assert.notEqual(headerId, footerId, 'Distinct .vue SFC components must never collide on contract ID');

  // 2. Router/Hono factory instances extract as EXPORTED_MODULE while CLI defineCommand stays EXPORTED_FUNCTION
  const routerCode = `
    import { Hono } from 'hono';
    import { Router } from 'express';
    import { defineCommand } from 'citty';

    export const apiRouter = Router();
    export const subApp = new Hono();
    export const devCmd = defineCommand({ meta: { name: 'dev' } });

    const parentApp = new Hono();
    parentApp.route('/v1', subApp);
    parentApp.use('/users', apiRouter);
  `;
  const routerSf = ts.createSourceFile('/repo/src/routes.ts', routerCode, ts.ScriptTarget.Latest, true);
  const routerContracts: StructuralEntity[] = [];
  const routerMounts: StructuralEntity[] = [];
  walkNodes(routerSf, (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      if (n.name.text === 'apiRouter' || n.name.text === 'subApp') {
        assert.equal(isRouterFactoryInitializer(n.initializer), true);
      }
      if (n.name.text === 'devCmd') {
        assert.equal(isRouterFactoryInitializer(n.initializer), false);
      }
    }
    routerContracts.push(...toList(visitContract(n, routerSf, makeEv('src/routes.ts', routerSf), nextId, null, 'src/routes.ts')));
    routerMounts.push(...toList(visitRelationship(n, routerSf, makeEv('src/routes.ts', routerSf), nextId, '/repo', 'source-routes')));
  });

  const apiRouterNode = routerContracts.find((c) => c.name === 'Exported Module: apiRouter');
  const subAppNode = routerContracts.find((c) => c.name === 'Exported Module: subApp');
  const devCmdNode = routerContracts.find((c) => c.name === 'Exported Function: devCmd');
  assert.ok(apiRouterNode && apiRouterNode.entityType === 'EXPORTED_MODULE' && apiRouterNode.patternId === 'contract.exported-module');
  assert.ok(subAppNode && subAppNode.entityType === 'EXPORTED_MODULE' && subAppNode.patternId === 'contract.exported-module');
  assert.ok(devCmdNode && devCmdNode.entityType === 'EXPORTED_FUNCTION');

  const expectedApiRouterId = contractEntityId('repo', 'src/routes.ts', 'Exported Module: apiRouter', 'contract.exported-module');
  const expectedSubAppId = contractEntityId('repo', 'src/routes.ts', 'Exported Module: subApp', 'contract.exported-module');
  assert.ok(
    routerMounts.some((m) => m.targetId === expectedApiRouterId),
    'parentApp.use("/users", apiRouter) must resolve targetId to Exported Module: apiRouter'
  );
  assert.ok(
    routerMounts.some((m) => m.targetId === expectedSubAppId),
    'parentApp.route("/v1", subApp) must resolve targetId to Exported Module: subApp'
  );

  // 3. Hono is recognized as a handled HTTP framework adapter (never triggering false UNHANDLED_FRAMEWORK)
  const honoDetected = detectFrameworkRulesFromDependencies(['hono']);
  assert.equal(honoDetected.length, 1);
  assert.equal(honoDetected[0].label, 'Hono');
  assert.equal(honoDetected[0].category, 'framework-adapter');
  assert.equal(honoDetected[0].conventionSetId, 'express');
});

test('[PAT-EXT-75] Next.js underscore multi-route subtrees, tRPC procedures, CLI/worker entrypoints, and OPEN_CONNECTOR disambiguation', () => {
  let seq = 0;
  const nextId = () => `id-${++seq}`;
  const makeEv =
    (filePath: string, sf: ts.SourceFile) =>
    (n: ts.Node) => ({
      filePath,
      lineNumber: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      snippet: n.getText(sf).slice(0, 60),
    });
  const walkNodes = (n: ts.Node, fn: (node: ts.Node) => void): void => {
    fn(n);
    ts.forEachChild(n, (c) => walkNodes(c, fn));
  };
  const toList = <T>(v: T | T[] | null | undefined): T[] =>
    Array.isArray(v) ? v : v ? [v] : [];

  // 1. Multi-route underscore subtrees (`app/_hooks/layout.tsx` + `app/_hooks/[section]/page.tsx`) classify as LAYOUT/PAGE while single `_components/page.tsx` stays null
  const routedPrefixes = collectRoutedUnderscorePrefixes([
    'app/_hooks/layout.tsx',
    'app/_hooks/[section]/page.tsx',
    'app/_patterns/breadcrumbs/[id]/page.tsx',
    'app/_patterns/layout.tsx',
    'app/_components/page.tsx',
  ]);
  assert.equal(routedPrefixes.has('app/_hooks'), true);
  assert.equal(routedPrefixes.has('app/_patterns'), true);
  assert.equal(routedPrefixes.has('app/_components'), false);
  assert.equal(
    classifyNextjsFile('app/_hooks/layout.tsx', [], { routedUnderscorePrefixes: routedPrefixes }),
    'LAYOUT'
  );
  assert.equal(
    classifyNextjsFile('app/_hooks/[section]/page.tsx', [], {
      routedUnderscorePrefixes: routedPrefixes,
    }),
    'PAGE'
  );
  assert.equal(
    classifyNextjsFile('app/_components/page.tsx', [], {
      routedUnderscorePrefixes: routedPrefixes,
    }),
    null
  );

  // 2. tRPC router procedures extract as API_ENDPOINT (`flowRole: 'INGRESS'`) contracts
  const trpcCode = `
    export const carsRouter = router({
      getCars: publicProcedure.query(async ({ ctx }) => {
        return ctx.db.select().from(CarTable);
      }),
      createCar: protectedProcedure.input(CarSchema).mutation(async ({ ctx, input }) => {
        return ctx.db.insert(CarTable).values(input);
      }),
    });
  `;
  const trpcSf = ts.createSourceFile('/repo/packages/api/src/routes/cars.ts', trpcCode, ts.ScriptTarget.Latest, true);
  const trpcContracts: StructuralEntity[] = [];
  walkNodes(trpcSf, (n) => {
    trpcContracts.push(
      ...toList(visitContract(n, trpcSf, makeEv('packages/api/src/routes/cars.ts', trpcSf), nextId, null, 'packages/api/src/routes/cars.ts'))
    );
  });
  const getCarsProc = trpcContracts.find((c) => c.name === 'RPC Procedure: carsRouter.getCars');
  const createCarProc = trpcContracts.find((c) => c.name === 'RPC Procedure: carsRouter.createCar');
  assert.ok(getCarsProc && getCarsProc.entityType === 'API_ENDPOINT' && getCarsProc.metadata?.flowRole === 'INGRESS');
  assert.ok(createCarProc && createCarProc.entityType === 'API_ENDPOINT' && createCarProc.metadata?.flowRole === 'INGRESS');

  // 3. Standalone scripts/ and workers/ top-level invocations extract as CLI_COMMAND
  const seedSf = ts.createSourceFile(
    '/repo/scripts/_seed.ts',
    `async function seed() { await runSeed(); }\nseed();`,
    ts.ScriptTarget.Latest,
    true
  );
  assert.equal(isTopLevelCliEntryInvocation(seedSf, 'seed', 'scripts/_seed.ts'), true);
  const workerSf = ts.createSourceFile(
    '/repo/src/workers/ranking.ts',
    `async function startWorker() { await rank(); }\nstartWorker();`,
    ts.ScriptTarget.Latest,
    true
  );
  assert.equal(isTopLevelCliEntryInvocation(workerSf, 'startWorker', 'src/workers/ranking.ts'), true);

  // 4. disambiguateCollidingOpenConnectors splits multi-host HTTP_FETCH, multi-schema Drizzle queries, and cross-platform .native.tsx DB calls
  const scopeMap = new WeakMap<any, string>();
  const carSchema = {
    id: 'schema-car',
    name: 'Drizzle Schema: CarTable',
    type: 'CONTRACT' as const,
    entityType: 'DB_SCHEMA',
    patternId: 'contract.drizzle-schema',
    evidence: { filePath: 'schema/car.ts', lineNumber: 1 },
  };
  const userSchema = {
    id: 'schema-user',
    name: 'Drizzle Schema: UserTable',
    type: 'CONTRACT' as const,
    entityType: 'DB_SCHEMA',
    patternId: 'contract.drizzle-schema',
    evidence: { filePath: 'schema/user.ts', lineNumber: 1 },
  };
  const fetchOpenAi = {
    id: 'oc-fetch-shared',
    name: 'HTTP Call: fetch',
    type: 'OPEN_CONNECTOR' as const,
    entityType: 'HTTP_FETCH',
    patternId: 'open-connector.http-call',
    evidence: { filePath: 'app/api/a/route.ts', lineNumber: 10 },
    metadata: { httpMethod: 'GET', urlPath: 'https://api.openai.com/v1/containers' },
  };
  const fetchJoke = {
    id: 'oc-fetch-shared',
    name: 'HTTP Call: fetch',
    type: 'OPEN_CONNECTOR' as const,
    entityType: 'HTTP_FETCH',
    patternId: 'open-connector.http-call',
    evidence: { filePath: 'app/api/b/route.ts', lineNumber: 12 },
    metadata: { httpMethod: 'GET', urlPath: 'https://v2.jokeapi.dev/joke/Any' },
  };
  const drizzleCar = {
    id: 'oc-drizzle-shared',
    name: 'Drizzle Query: select()',
    type: 'OPEN_CONNECTOR' as const,
    entityType: 'DB_QUERY',
    patternId: 'open-connector.drizzle-query-chain',
    evidence: { filePath: 'routes/cars.ts', lineNumber: 7 },
  };
  const drizzleUser = {
    id: 'oc-drizzle-shared',
    name: 'Drizzle Query: select()',
    type: 'OPEN_CONNECTOR' as const,
    entityType: 'DB_QUERY',
    patternId: 'open-connector.drizzle-query-chain',
    evidence: { filePath: 'routes/user.ts', lineNumber: 9 },
  };
  const supaWeb = {
    id: 'oc-supa-shared',
    name: 'DB Call: supabase.auth.signInWithPassword',
    type: 'OPEN_CONNECTOR' as const,
    entityType: 'DB_QUERY',
    patternId: 'open-connector.db-call',
    evidence: { filePath: 'features/sign-in/screen.tsx', lineNumber: 36 },
  };
  const supaNative = {
    id: 'oc-supa-shared',
    name: 'DB Call: supabase.auth.signInWithPassword',
    type: 'OPEN_CONNECTOR' as const,
    entityType: 'DB_QUERY',
    patternId: 'open-connector.db-call',
    evidence: { filePath: 'features/sign-in/screen.native.tsx', lineNumber: 40 },
  };
  for (const oc of [fetchOpenAi, fetchJoke, drizzleCar, drizzleUser, supaWeb, supaNative]) {
    scopeMap.set(oc, 'demo-pkg');
  }
  const testNodes: any[] = [
    carSchema,
    userSchema,
    fetchOpenAi,
    fetchJoke,
    drizzleCar,
    drizzleUser,
    supaWeb,
    supaNative,
  ];
  const testEdges: any[] = [
    {
      id: 'e1',
      name: 'Call: HTTP Call: fetch',
      type: 'RELATIONSHIP',
      entityType: 'CALL',
      patternId: 'generic.relationship',
      sourceId: 'route-a',
      targetId: 'oc-fetch-shared',
      evidence: { filePath: 'app/api/a/route.ts', lineNumber: 10 },
    },
    {
      id: 'e2',
      name: 'Call: HTTP Call: fetch',
      type: 'RELATIONSHIP',
      entityType: 'CALL',
      patternId: 'generic.relationship',
      sourceId: 'route-b',
      targetId: 'oc-fetch-shared',
      evidence: { filePath: 'app/api/b/route.ts', lineNumber: 12 },
    },
    {
      id: 'e3',
      name: 'Reads: CarTable',
      type: 'RELATIONSHIP',
      entityType: 'READS',
      patternId: 'relationship.drizzle-reads',
      sourceId: 'oc-drizzle-shared',
      targetId: 'schema-car',
      evidence: { filePath: 'routes/cars.ts', lineNumber: 7 },
    },
    {
      id: 'e4',
      name: 'Reads: UserTable',
      type: 'RELATIONSHIP',
      entityType: 'READS',
      patternId: 'relationship.drizzle-reads',
      sourceId: 'oc-drizzle-shared',
      targetId: 'schema-user',
      evidence: { filePath: 'routes/user.ts', lineNumber: 9 },
    },
    {
      id: 'e5',
      name: 'Call: DB Call: supabase.auth.signInWithPassword',
      type: 'RELATIONSHIP',
      entityType: 'CALL',
      patternId: 'generic.relationship',
      sourceId: 'screen-web',
      targetId: 'oc-supa-shared',
      evidence: { filePath: 'features/sign-in/screen.tsx', lineNumber: 36 },
    },
    {
      id: 'e6',
      name: 'Call: DB Call: supabase.auth.signInWithPassword',
      type: 'RELATIONSHIP',
      entityType: 'CALL',
      patternId: 'generic.relationship',
      sourceId: 'screen-native',
      targetId: 'oc-supa-shared',
      evidence: { filePath: 'features/sign-in/screen.native.tsx', lineNumber: 40 },
    },
  ];
  disambiguateCollidingOpenConnectors(testNodes, testEdges, scopeMap);
  assert.equal(fetchOpenAi.name, 'HTTP Call: fetch (api.openai.com)');
  assert.equal(fetchJoke.name, 'HTTP Call: fetch (v2.jokeapi.dev)');
  assert.notEqual(fetchOpenAi.id, fetchJoke.id);
  assert.equal(drizzleCar.name, 'Drizzle Query: select(CarTable)');
  assert.equal(drizzleUser.name, 'Drizzle Query: select(UserTable)');
  assert.notEqual(drizzleCar.id, drizzleUser.id);
  assert.equal(supaWeb.name, 'DB Call: supabase.auth.signInWithPassword');
  assert.equal(supaNative.name, 'DB Call: supabase.auth.signInWithPassword (native)');
  assert.notEqual(supaWeb.id, supaNative.id);
});

test('[PAT-EXT-76]: Type-only import value disambiguation, Astro lifecycle/endpoint/SVG conventions, and Svelte SFC / SvelteKit conventions', () => {
  // 1. Declarative catalog coverage for Astro & SvelteKit
  assert.deepEqual(
    describeConventions(ASTRO_CONVENTIONS).map((r) => [r.id, r.produces.type]),
    [
      ['astro.lifecycle-export', 'CONTRACT'],
      ['astro.endpoint-handler', 'CONTRACT'],
    ]
  );
  assert.deepEqual(
    describeConventions(SVELTEKIT_CONVENTIONS).map((r) => [r.id, r.produces.type]),
    [
      ['sveltekit.load', 'CONTRACT'],
      ['sveltekit.layout-load', 'CONTRACT'],
      ['sveltekit.actions', 'CONTRACT'],
      ['sveltekit.server-endpoint', 'CONTRACT'],
      ['sveltekit.hooks', 'CONTRACT'],
    ]
  );

  // 2. Type-only import disambiguation (`import type { X }` and `import { type Y }`)
  const shadowSf = ts.createSourceFile(
    '/repo/src/item.tsx',
    [
      "import type { SortFilterItem } from './constants';",
      "import { type HelperConfig, formatTitle } from './constants';",
      'function SortFilterItem({ item }: { item: SortFilterItem }) {',
      '  return <div>{formatTitle(item)}</div>;',
      '}',
      'function HelperConfig() { return "local"; }',
      'export function FilterItem({ item }: { item: SortFilterItem }) {',
      '  HelperConfig();',
      '  return <SortFilterItem item={item} />;',
      '}',
    ].join('\n'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  assert.equal(findModuleBinding(shadowSf, 'SortFilterItem')?.isTypeOnly, true);
  assert.equal(findValueModuleBinding(shadowSf, 'SortFilterItem'), undefined);
  assert.equal(findModuleBinding(shadowSf, 'HelperConfig')?.isTypeOnly, true);
  assert.equal(findValueModuleBinding(shadowSf, 'HelperConfig'), undefined);
  assert.equal(findValueModuleBinding(shadowSf, 'formatTitle')?.isTypeOnly, undefined);

  const shadowEv = makeEv('src/item.tsx', shadowSf);
  const nextId = makeNextId();
  const shadowRels: StructuralEntity[] = [];
  walkNodes(shadowSf, (node) => {
    shadowRels.push(...toList(visitRelationship(node, shadowSf, shadowEv, nextId, '/repo', 'filter-item')));
  });
  // <SortFilterItem /> must NOT emit an unresolved cross-module `Import` render edge, and
  // `HelperConfig()` must bind to `LocalFunction` rather than the shadowed `type HelperConfig` import.
  assert.ok(!shadowRels.some((r) => r.name === 'Renders: <SortFilterItem />'));
  assert.equal(
    shadowRels.find((r) => r.name === 'Call: HelperConfig()')?.metadata?.shapeKey,
    'sk1/CALL/LocalFunction/Id'
  );

  // 3. Astro SVG naming & Svelte component naming derivers
  assert.equal(deriveSvgComponentContractName('src/assets/icons/IconCalendar.svg'), 'Svg Component: IconCalendar');
  assert.equal(deriveSvgComponentContractName('src/assets/arrow-right.svg'), 'Svg Component: ArrowRight');
  assert.equal(deriveSvelteComponentName('src/routes/+page.svelte'), 'Svelte Component: Page');
  assert.equal(deriveSvelteComponentName('src/routes/editor/+page.svelte'), 'Svelte Component: EditorPage');
  assert.equal(deriveSvelteComponentName('src/routes/editor/[slug]/+page.svelte'), 'Svelte Component: EditorSlugPage');
  assert.equal(deriveSvelteComponentName('src/routes/+layout.svelte'), 'Svelte Component: Layout');
  assert.equal(deriveSvelteComponentName('src/routes/+error.svelte'), 'Svelte Component: Error');
  assert.equal(deriveSvelteComponentName('src/lib/ArticleCard.svelte'), 'Svelte Component: ArticleCard');

  // 4. Svelte SFC preprocessing preserves exact line numbers and suppresses Svelte 5 runes
  const svelteRaw = [
    '<script lang="ts">',
    "  import ArticleCard from '$lib/ArticleCard.svelte';",
    '  let { data } = $props();',
    '  let count = $state(0);',
    '</script>',
    '<main>',
    '  <ArticleCard article={data} />',
    '</main>',
  ].join('\n');
  const preprocessedSvelte = preprocessAstroOrMdxSource('/repo/src/routes/+page.svelte', svelteRaw);
  const svelteLines = preprocessedSvelte.split('\n');
  assert.equal(svelteLines.length, 8);
  assert.ok(svelteLines[5].includes('__SvelteComponent__'));
  assert.ok(svelteLines[6].includes('<ArticleCard'));

  const svelteSf = ts.createSourceFile(
    '/repo/src/routes/+page.svelte',
    preprocessedSvelte,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let runeCallCount = 0;
  const svelteContracts: StructuralEntity[] = [];
  const svelteRels: StructuralEntity[] = [];
  const svelteEv = makeEv('src/routes/+page.svelte', svelteSf);
  walkNodes(svelteSf, (node) => {
    if (ts.isCallExpression(node) && isSvelteRuneCall(node)) {
      runeCallCount += 1;
    }
    svelteContracts.push(
      ...toList(visitContract(node, svelteSf, svelteEv, nextId, null, 'src/routes/+page.svelte'))
    );
    svelteRels.push(
      ...toList(visitRelationship(node, svelteSf, svelteEv, nextId, '/repo', 'svelte-page'))
    );
  });
  assert.equal(runeCallCount, 2, '$props() and $state() must be recognized as Svelte 5 rune intrinsics');
  assert.ok(
    svelteContracts.some(
      (c) =>
        c.name === 'Svelte Component: Page' &&
        c.patternId === 'contract.svelte-sfc-and-sveltekit-hooks' &&
        c.metadata?.flowRole === 'INGRESS'
    )
  );
  assert.ok(!svelteRels.some((r) => r.name.includes('$props') || r.name.includes('$state')));
});
