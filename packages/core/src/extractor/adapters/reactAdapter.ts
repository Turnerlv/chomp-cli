// packages/core/src/extractor/adapters/reactAdapter.ts
// Framework-agnostic React component conventions (`[PAT-EXT-25]`).
//
// The conventions are DATA — see `../conventions/react.ts`. This file exposes them with the
// function shapes the visitors call, and enriches HOC-wrapped components with the Port Valves of
// the function they wrap (parity with plain component contracts).

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { NEXTJS_CONVENTIONS } from '../conventions/nextjs.js';
import { REACT_CONVENTIONS } from '../conventions/react.js';
import { applyConventionRulesDetailed, applyEdgeRules } from '../conventions/engine.js';
import type { EdgeTargetResolvers } from '../conventions/types.js';
import { extractSignatureTypeValves } from '../visitors/publicMethodVisitor.js';

type Evidence = (node: ts.Node) => EvidenceRecord;

/**
 * Extracts `export const X = memo(fn)` / `React.forwardRef(fn)` (including deferred `export { X }`
 * and `export default memo(Modal)`) as a component CONTRACT. The statement is the contract's AST
 * anchor, so calls inside the wrapped function are owned by it.
 */
export function extractReactHocComponent(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] | null {
  const applied = applyConventionRulesDetailed(
    REACT_CONVENTIONS,
    ['react.hoc-wrapped-component'],
    node,
    null,
    '',
    getEvidence,
    nextId
  );
  if (applied.length === 0) return null;

  return applied.map(({ entity, match }) => {
    const inner = match.innerFunction as ts.SignatureDeclarationBase | undefined;
    const valves = inner ? extractSignatureTypeValves(inner) : undefined;
    return valves ? { ...entity, metadata: { ...entity.metadata, ...valves } } : entity;
  });
}

/**
 * Extracts a RENDERS relationship for `<Component />` when the component is an exported function
 * or wrapped component declared in the same source file. Returns null when no target is proven.
 */
export function extractReactSameFileRender(
  node: ts.Node,
  sourceId: string,
  getEvidence: Evidence,
  nextId: () => string,
  resolvers: EdgeTargetResolvers
): StructuralEntity | null {
  return (
    applyEdgeRules(REACT_CONVENTIONS, ['react.same-file-component-render'], node, sourceId, getEvidence, nextId, resolvers)[0] ??
    null
  );
}

/**
 * Extracts a RENDERS relationship for any JSX component element (`<Card />`, `<Form.Input />`,
 * `React.lazy` `<Lazy />`, `next/dynamic` `<Dynamic />`, or same-file `<Sidebar />`) via the
 * React and Next.js convention tables.
 */
export function extractReactJsxRender(
  node: ts.Node,
  sourceId: string,
  getEvidence: Evidence,
  nextId: () => string,
  resolvers: EdgeTargetResolvers
): StructuralEntity | null {
  const nextDynamic = applyEdgeRules(
    NEXTJS_CONVENTIONS,
    ['nextjs.dynamic-component-render'],
    node,
    sourceId,
    getEvidence,
    nextId,
    resolvers
  );
  if (nextDynamic.length > 0) return nextDynamic[0];

  const reactEdges = applyEdgeRules(
    REACT_CONVENTIONS,
    [
      'react.imported-component-render',
      'react.dynamic-component-render',
      'react.same-file-component-render',
      'react.namespaced-component-render',
    ],
    node,
    sourceId,
    getEvidence,
    nextId,
    resolvers
  );
  return reactEdges[0] ?? null;
}
