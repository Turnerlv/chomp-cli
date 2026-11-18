// packages/core/src/extractor/conventions/express.ts
//
// Express.js routing, middleware, parameter, content-negotiation and listener conventions, as DATA
// (`[PAT-EXT-28]`). Replaces the hand-written AST matching in `adapters/expressAdapter.ts`; that
// file now delegates to this table.

import type { ConventionSet } from './types.js';

/** Supported Express HTTP routing method names (`app.get`, `router.post`, `app.route`, ...). */
export const EXPRESS_ROUTE_METHODS = [
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'all',
  'route',
] as const;

/** Known client-side HTTP library receiver identifiers that must not be extracted as server routes. */
export const HTTP_CLIENT_IDENTIFIERS = [
  'axios',
  'httpClient',
  'client',
  'api',
  'http',
  'got',
  'ky',
  'superagent',
  'fetch',
] as const;

export const EXPRESS_CONVENTIONS: ConventionSet = {
  framework: 'express',
  fileRoles: [],
  baseExtensions: ['ts', 'tsx', 'js', 'jsx'],

  rules: [
    {
      id: 'express.route',
      roles: null,
      match: {
        kind: 'callToMember',
        methods: EXPRESS_ROUTE_METHODS,
        arg0: 'routePathLiteral',
        excludeReceivers: HTTP_CLIENT_IDENTIFIERS,
      },
      emit: {
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.express-route',
        name: 'Express Route: {METHOD} {arg0}',
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description:
          'An Express route registration (`app.get(path, handler)`, `router.post(path, handler)`, `app.route(path)`) is an HTTP endpoint contract.',
      },
    },
    {
      id: 'express.middleware',
      roles: null,
      match: { kind: 'callUseTarget', targetKind: 'middleware' },
      emit: {
        type: 'CONTRACT',
        entityType: 'MIDDLEWARE',
        patternId: 'boundary.express-middleware',
        name: 'Middleware: {target}',
        idScope: 'middleware:{target}',
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: '`app.use([path], middleware)` registers a request-intercepting middleware contract.',
      },
    },
    {
      id: 'express.route-parameter',
      roles: null,
      match: {
        kind: 'callToMember',
        methods: ['param'],
        minArgs: 2,
        arg0: 'stringOrStringArray',
      },
      emit: {
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.express-route-parameter',
        name: 'Express Param: {arg0}',
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description:
          '`app.param(name, callback)` / `router.param([names], callback)` registers a route parameter trigger contract.',
      },
    },
    {
      id: 'express.content-negotiation',
      roles: null,
      match: {
        kind: 'callToMember',
        receivers: ['res', 'response'],
        methods: ['format'],
        minArgs: 1,
        maxArgs: 1,
        arg0: 'objectLiteralKeys',
      },
      emit: {
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.express-content-negotiation',
        name: 'Express Content Negotiation: {arg0}',
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: '`res.format({ ... })` declares an Accept-header content negotiation branch table.',
      },
    },
    {
      id: 'express.app-listen',
      roles: null,
      match: {
        kind: 'callToMember',
        receivers: ['app', 'server'],
        methods: ['listen'],
      },
      emit: {
        type: 'OPEN_CONNECTOR',
        entityType: 'NETWORK_LISTEN',
        patternId: 'open-connector.express-app-listen',
        name: 'Express App Listen',
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: '`app.listen(...)` / `server.listen(...)` opens a network listener boundary.',
      },
    },
    {
      id: 'express.response-cookie',
      roles: null,
      match: {
        kind: 'callToMember',
        receivers: ['res'],
        methods: ['cookie', 'clearCookie'],
        arg0: 'optionalStringLiteral',
      },
      emit: {
        type: 'OPEN_CONNECTOR',
        entityType: 'HTTP_RESPONSE',
        patternId: 'open-connector.express-response-cookie',
        name: 'Express Response Cookie: {arg0}',
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: '`res.cookie(name, ...)` / `res.clearCookie(name)` mutates client response cookies.',
      },
    },
    {
      id: 'express.dynamic-methods',
      roles: null,
      match: {
        kind: 'callToMember',
        receivers: ['methods'],
        methods: ['forEach'],
        expandValues: EXPRESS_ROUTE_METHODS,
      },
      emit: {
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.express-dynamic-methods',
        name: 'Express Route: {VALUE} (Dynamic)',
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description:
          '`methods.forEach(...)` dynamically attaches HTTP verb methods onto the Express application/router prototype.',
      },
    },
  ],

  edgeRules: [
    {
      id: 'express.use-middleware',
      match: { kind: 'callUseTarget', targetKind: 'middleware' },
      target: [{ kind: 'syntheticContract', idScope: 'middleware:{target}', contractName: 'Middleware: {target}' }],
      emit: {
        entityType: 'INTERCEPTS',
        patternId: 'relationship.express-route-middleware',
        name: 'Express Mount: {pathPrefix} -> {target}',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description:
          '`app.use([pathPrefix], middleware)` mounts a middleware contract to intercept requests under `pathPrefix`.',
      },
    },
    {
      id: 'express.router-mount',
      match: { kind: 'callUseTarget', targetKind: 'router' },
      target: [
        'routerMount',
        { kind: 'syntheticContract', idScope: 'middleware:{target}', contractName: 'Middleware: {target}' },
      ],
      emit: {
        entityType: 'MOUNTS',
        patternId: 'relationship.express-router-mount',
        name: 'Express Mount: {pathPrefix} -> {target}',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: '`app.use([pathPrefix], router)` mounts a sub-router module under `pathPrefix`.',
      },
    },
    {
      id: 'express.route-middleware',
      match: {
        kind: 'callRouteTargets',
        methods: EXPRESS_ROUTE_METHODS,
        position: 'middleware',
        excludeReceivers: HTTP_CLIENT_IDENTIFIERS,
      },
      target: [{ kind: 'syntheticContract', idScope: 'middleware:{target}', contractName: 'Middleware: {target}' }],
      emit: {
        entityType: 'INTERCEPTS',
        patternId: 'relationship.express-route-middleware',
        name: 'Express Mount: {path} -> {target}',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        metadata: {
          httpMethod: '{METHOD}',
          routePath: '{path}',
        },
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: 'Intermediate arguments in `app.<method>(path, mw1, ..., handler)` intercept requests on that route.',
      },
    },
    {
      id: 'express.route-handler',
      match: {
        kind: 'callRouteTargets',
        methods: EXPRESS_ROUTE_METHODS,
        position: 'handler',
        excludeReceivers: HTTP_CLIENT_IDENTIFIERS,
      },
      target: [{ kind: 'syntheticContract', idScope: 'handler:{target}', contractName: 'Handler: {target}' }],
      emit: {
        entityType: 'BINDS_ROUTE',
        patternId: 'relationship.express-route-handler',
        name: 'Express Bind: {path} -> {target}',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        metadata: {
          httpMethod: '{METHOD}',
          routePath: '{path}',
        },
      },
      meta: {
        framework: 'express',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description:
          'A referenced final argument in `app.<method>(path, ..., handler)` binds the route to that handler contract.',
      },
    },
  ],

  derivers: {},
  escapeHatches: [],
};
