// packages/core/src/extractor/adapters/expressAdapter.ts
// Framework-specific AST extraction adapter for Express.js route, mount, parameter, and content negotiation patterns.
//
// The conventions themselves are DATA — see `../conventions/express.ts` interpreted by
// `../conventions/engine.ts`. This file keeps the long-standing function signatures the visitors
// call, and delegates every rule to the table (zero escape hatches).

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { EXPRESS_CONVENTIONS } from '../conventions/express.js';
import { applyConventionRules, applyEdgeRules } from '../conventions/engine.js';
import type { EdgeTargetResolvers } from '../conventions/types.js';

type Evidence = (node: ts.Node) => EvidenceRecord;

function applyNode(
  ruleIds: readonly string[],
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] {
  return applyConventionRules(EXPRESS_CONVENTIONS, ruleIds, node, null, '', getEvidence, nextId);
}

/**
 * Extracts an Express route handler definition as a CONTRACT primitive entity.
 *
 * Matches expressions like:
 * - `app.get('/path', handler)`
 * - `router.post('/api/v1/users', controller.create)`
 *
 * @param node        The AST node to inspect.
 * @param getEvidence Callback returning an EvidenceRecord for the node.
 * @param nextId      Closure providing a placeholder entity ID.
 * @returns A CONTRACT StructuralEntity for the route, or null if node does not match.
 */
export function extractExpressRoute(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return applyNode(['express.route'], node, getEvidence, nextId)[0] ?? null;
}

/**
 * Extracts inline middleware and referenced handler arguments from Express route registrations as
 * RELATIONSHIP primitive entities (`express.route-middleware` and `express.route-handler`).
 *
 * Matches expressions like:
 * - `router.get('/path', auth.optional, handler)`
 *
 * @param node        The AST node to inspect.
 * @param _sourceFile TypeScript SourceFile object (unused; the engine reads it from `node`).
 * @param getEvidence Callback returning an EvidenceRecord for the node.
 * @param nextId      Closure providing a placeholder entity ID.
 * @param sourceId    Optional owning source entity ID.
 * @returns An array of RELATIONSHIP StructuralEntities, or null if node does not match.
 */
export function extractExpressRouteMiddleware(
  node: ts.Node,
  _sourceFile: ts.SourceFile,
  getEvidence: Evidence,
  nextId: () => string,
  sourceId: string = ''
): StructuralEntity[] | null {
  const edges = applyEdgeRules(
    EXPRESS_CONVENTIONS,
    ['express.route-middleware', 'express.route-handler'],
    node,
    sourceId,
    getEvidence,
    nextId
  );
  return edges.length > 0 ? edges : null;
}

/**
 * Extracts an Express router mount or middleware registration as a RELATIONSHIP primitive entity
 * (`express.use-middleware` or `express.router-mount`).
 *
 * Matches expressions like:
 * - `app.use('/api', apiRouter)` -> `Express Mount: /api -> apiRouter`
 * - `app.use(express.json())`     -> `Express Mount: Root -> express.json()`
 * - `app.use(require('./routes'))` -> `Express Mount: Root -> ./routes`
 *
 * @param node        The AST node to inspect.
 * @param _sourceFile TypeScript SourceFile object (unused; the engine reads it from `node`).
 * @param getEvidence Callback returning an EvidenceRecord for the node.
 * @param nextId      Closure providing a placeholder entity ID.
 * @param sourceId    Optional owning source entity ID.
 * @param resolvers   Optional target resolvers (e.g. `routerMount` from `relationshipVisitor`).
 * @returns A RELATIONSHIP StructuralEntity for the mount, or null if node does not match.
 */
export function extractExpressRouterMount(
  node: ts.Node,
  _sourceFile: ts.SourceFile,
  getEvidence: Evidence,
  nextId: () => string,
  sourceId: string = '',
  resolvers?: EdgeTargetResolvers
): StructuralEntity | null {
  return (
    applyEdgeRules(
      EXPRESS_CONVENTIONS,
      ['express.use-middleware', 'express.router-mount'],
      node,
      sourceId,
      getEvidence,
      nextId,
      resolvers
    )[0] ?? null
  );
}

/**
 * Extracts an Express middleware mount as a CONTRACT primitive entity (v4: not a boundary).
 *
 * @param node        The AST node to inspect.
 * @param _sourceFile TypeScript SourceFile object (unused; the engine reads it from `node`).
 * @param getEvidence Callback returning an EvidenceRecord for the node.
 * @param nextId      Closure providing a placeholder entity ID.
 * @returns A CONTRACT StructuralEntity for the middleware, or null if node does not match.
 */
export function extractExpressMiddlewareBoundary(
  node: ts.Node,
  _sourceFile: ts.SourceFile,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return applyNode(['express.middleware'], node, getEvidence, nextId)[0] ?? null;
}

/**
 * Extracts an Express route parameter trigger definition (`app.param(...)` or `router.param(...)`)
 * as a CONTRACT primitive entity.
 *
 * Matches expressions like:
 * - `app.param('user', (req, res, next, id) => { ... })`
 * - `router.param(['id', 'page'], callback)`
 *
 * @param node        The AST node to inspect.
 * @param getEvidence Callback returning an EvidenceRecord for the node.
 * @param nextId      Closure providing a placeholder entity ID.
 * @returns A CONTRACT StructuralEntity for the route parameter, or null if node does not match.
 */
export function extractExpressRouteParameter(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return applyNode(['express.route-parameter'], node, getEvidence, nextId)[0] ?? null;
}

/**
 * Extracts an Express content negotiation block (`res.format({ 'application/json': ... })`)
 * as a CONTRACT primitive entity.
 *
 * Matches expressions like:
 * - `res.format({ 'application/json': fn1, default: fn2 })`
 *
 * @param node        The AST node to inspect.
 * @param getEvidence Callback returning an EvidenceRecord for the node.
 * @param nextId      Closure providing a placeholder entity ID.
 * @returns A CONTRACT StructuralEntity for content negotiation, or null if node does not match.
 */
export function extractExpressContentNegotiation(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return applyNode(['express.content-negotiation'], node, getEvidence, nextId)[0] ?? null;
}

/**
 * Extracts an Express app listener (`app.listen(...)`)
 * as an OPEN_CONNECTOR primitive entity representing a network boundary.
 *
 * Matches expressions like:
 * - `app.listen(3000)`
 *
 * @param node        The AST node to inspect.
 * @param getEvidence Callback returning an EvidenceRecord for the node.
 * @param nextId      Closure providing a placeholder entity ID.
 * @returns An OPEN_CONNECTOR StructuralEntity for the listener, or null if node does not match.
 */
export function extractExpressAppListen(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return applyNode(['express.app-listen'], node, getEvidence, nextId)[0] ?? null;
}

/**
 * Extracts an Express response cookie operation (`res.cookie(...)` or `res.clearCookie(...)`)
 * as an OPEN_CONNECTOR primitive entity representing client-side state interaction.
 *
 * Matches expressions like:
 * - `res.cookie('remember', 1)`
 * - `res.clearCookie('remember')`
 *
 * @param node        The AST node to inspect.
 * @param getEvidence Callback returning an EvidenceRecord for the node.
 * @param nextId      Closure providing a placeholder entity ID.
 * @returns An OPEN_CONNECTOR StructuralEntity for the cookie operation, or null if node does not match.
 */
export function extractExpressResponseCookie(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return applyNode(['express.response-cookie'], node, getEvidence, nextId)[0] ?? null;
}

/**
 * Extracts Express dynamic methods from the iteration loop (methods.forEach).
 *
 * @param node        The AST node to inspect.
 * @param getEvidence Callback returning an EvidenceRecord for the node.
 * @param nextId      Closure providing a placeholder entity ID.
 * @returns An array of CONTRACT StructuralEntity for the endpoints, or null if node does not match.
 */
export function extractExpressDynamicMethods(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] | null {
  const results = applyNode(['express.dynamic-methods'], node, getEvidence, nextId);
  return results.length > 0 ? results : null;
}
