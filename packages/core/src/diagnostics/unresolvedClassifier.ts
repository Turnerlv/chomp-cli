// packages/core/src/diagnostics/unresolvedClassifier.ts
//
// [PAT-VIS-15] & [PAT-MCP-09] Shared Incomplete Truth & Actionable Unresolved Call Classifier.
//
// Distinguishes actionable unresolved structural calls and opaque contract bodies
// (`astCallCount > 0 && resolvedOutDegree === 0`) from standard JS/TS/DOM/Web/PixiJS
// runtime builtins and already-bridged intra-file private helpers (`[PAT-EXT-10]`).
//
// Single source of truth consumed by:
// - `packages/mcp` (`chomp_audit_health` & `chomp_get_blast_radius`)
// - `packages/cli` (`pipeline-topo/unresolvedClassifier.ts`)
// - `apps/web` (`components/visualizer/unresolvedClassifier.ts`)

import type { RepresentationGraph, StructuralNode } from '../types/index.js';

export const BUILTIN_RECEIVERS = new Set<string>([
  'Math',
  'JSON',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Date',
  'RegExp',
  'Error',
  'Buffer',
  'process',
  'console',
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'performance',
  'Reflect',
  'Symbol',
  'Intl',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'crypto',
  'React',
  'ts',
  '$props',
  '$state',
  '$derived',
  '$effect',
  '$bindable',
  '$inspect',
  '$host',
]);

export const BUILTIN_BARE_CALLS = new Set<string>([
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Set',
  'Map',
  'Date',
  'RegExp',
  'Error',
  'Promise',
  'Symbol',
  'BigInt',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'queueMicrotask',
  'structuredClone',
  'atob',
  'btoa',
  'fetch',
  'alert',
  'confirm',
  '$props',
  '$state',
  '$derived',
  '$effect',
  '$bindable',
  '$inspect',
  '$host',
]);

export const BUILTIN_METHODS = new Set<string>([
  'map',
  'filter',
  'reduce',
  'reduceRight',
  'forEach',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'includes',
  'indexOf',
  'lastIndexOf',
  'slice',
  'splice',
  'concat',
  'join',
  'flat',
  'flatMap',
  'fill',
  'push',
  'pop',
  'shift',
  'unshift',
  'sort',
  'reverse',
  'keys',
  'values',
  'entries',
  'from',
  'isArray',
  'assign',
  'freeze',
  'fromEntries',
  'hasOwn',
  'hasOwnProperty',
  'get',
  'set',
  'has',
  'add',
  'delete',
  'clear',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'replace',
  'replaceAll',
  'match',
  'matchAll',
  'search',
  'startsWith',
  'endsWith',
  'toLowerCase',
  'toUpperCase',
  'padStart',
  'padEnd',
  'repeat',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'substr',
  'localeCompare',
  'normalize',
  'toFixed',
  'toPrecision',
  'toString',
  'valueOf',
  'then',
  'catch',
  'finally',
  'all',
  'allSettled',
  'race',
  'any',
  'resolve',
  'reject',
  'test',
  'exec',
  'toISOString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleString',
  'getTime',
  'getDate',
  'getMonth',
  'getFullYear',
  'getHours',
  'getMinutes',
  'getSeconds',
  'now',
  'min',
  'max',
  'abs',
  'round',
  'floor',
  'ceil',
  'sqrt',
  'pow',
  'log',
  'exp',
  'cos',
  'sin',
  'tan',
  'atan2',
  'random',
  'sign',
  'trunc',
  'hypot',
  'parse',
  'stringify',
  'json',
  'text',
  'status',
  'addEventListener',
  'removeEventListener',
  'preventDefault',
  'stopPropagation',
  'getBoundingClientRect',
  'appendChild',
  'removeChild',
  'removeChildren',
  'addChild',
  'addChildAt',
  'setPointerCapture',
  'releasePointerCapture',
  'hasPointerCapture',
  'getAttribute',
  'setAttribute',
  'removeAttribute',
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'createElement',
  'matchMedia',
  'getItem',
  'setItem',
  'removeItem',
  'writeText',
  'focus',
  'blur',
  'click',
  'scrollIntoView',
  'contains',
  'observe',
  'disconnect',
  'getPropertyValue',
  'getContext',
  'clearRect',
  'drawImage',
  'moveTo',
  'lineTo',
  'arc',
  'arcTo',
  'bezierCurveTo',
  'quadraticCurveTo',
  'closePath',
  'rect',
  'roundRect',
  'circle',
  'ellipse',
  'poly',
  'fill',
  'stroke',
  'destroy',
  'copyFrom',
  'toLocal',
  'toGlobal',
  'getLocalBounds',
  'init',
  'render',
  'start',
  'stop',
  'remove',
  'generateTexture',
  'drag',
  'pinch',
  'wheel',
  'decelerate',
  'moveCenter',
  'setZoom',
  'toWorld',
  'getText',
  'getStart',
  'getEnd',
  'getFullWidth',
  'getLeadingTriviaWidth',
  'getSourceFile',
  'getLineAndCharacterOfPosition',
  'forEachChild',
  'getChildren',
  'isFile',
  'isDirectory',
  'update',
  'digest',
  'next',
  'closest',
  'canvas',
  'ignores',
  'by',
  'pre',
  'root',
  'tracking',
  'raw',
  'snapshot',
]);

export const CLI_BUILDER_METHODS = new Set<string>([
  'command',
  'description',
  'option',
  'requiredOption',
  'argument',
  'action',
  'name',
  'version',
  'parse',
  'parseAsync',
]);

const DEFAULT_HIDDEN_ENTITY_TYPES = new Set<string>([
  'DEPLOYMENT_UNIT',
  'EXTERNAL_PACKAGE',
  'NODE_BUILTIN',
  'PACKAGE_DEPENDENCY',
  'PACKAGE_EXPORT',
]);

export interface ActionableUnresolvedCall {
  name: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  filePath?: string;
  lineNumber?: number;
  snippet?: string;
  reason: 'opaque-body' | 'unresolved-target';
  /** Deterministic, identifier-free shape key recorded by the extractor (v5 Loop 1/3). */
  shapeKey?: string;
  /** Specific intra-repo connection failure reason when import-backed. */
  unresolvedReason?: string;
  importSpecifier?: string;
  resolvedFilePath?: string;
  targetSymbol?: string;
}

const DECLARATION_ONLY_ENTITY_TYPES = new Set<string>([
  'EXPORTED_FUNCTION',
  'REACT_COMPONENT',
  'SERVER_ACTION',
  'AUTH_INTERFACE',
  'NEXTJS_PAGE',
  'NEXTJS_LAYOUT',
  'NEXTJS_MIDDLEWARE',
  'PUBLIC_METHOD',
  'CLASS',
  'NAMESPACE',
  'DEPLOYMENT_UNIT',
  'INIT_BLOCK',
  'EXPORTED_TYPE',
  'DB_SCHEMA',
  'VALIDATOR_SCHEMA',
]);

function defaultIsHiddenNode(node: { entityType?: string }): boolean {
  return Boolean(node.entityType && DEFAULT_HIDDEN_ENTITY_TYPES.has(node.entityType));
}

function buildResolvedLocationSet(
  rawGraph: { nodes: any[]; edges: any[] },
  nodeById: Map<string, any>,
  isHidden: (node: any) => boolean
): Set<string> {
  const resolvedLocations = new Set<string>();

  for (const n of rawGraph.nodes) {
    if (n.entityType && DECLARATION_ONLY_ENTITY_TYPES.has(n.entityType)) continue;
    const evs = Array.isArray(n.evidence) ? n.evidence : n.evidence ? [n.evidence] : [];
    for (const ev of evs) {
      if (ev?.filePath && ev?.lineNumber) {
        resolvedLocations.add(`${ev.filePath}:${ev.lineNumber}`);
      }
    }
  }

  for (const e of rawGraph.edges) {
    if (!e.targetId) continue;
    const tgt = nodeById.get(e.targetId);
    if (!tgt || isHidden(tgt)) continue;
    const evs = Array.isArray(e.evidence) ? e.evidence : e.evidence ? [e.evidence] : [];
    for (const ev of evs) {
      if (ev?.evidenceRole === 'import-match' || ev?.evidenceRole === 'target-signature') continue;
      if (ev?.filePath && ev?.lineNumber) {
        resolvedLocations.add(`${ev.filePath}:${ev.lineNumber}`);
      }
    }
  }

  return resolvedLocations;
}

function evaluateUnresolvedCallEdge(
  edge: any,
  srcOutDegree: number,
  resolvedLocations: Set<string>
): ActionableUnresolvedCall | null {
  if (
    edge.targetId ||
    edge.metadata?.crossScopeFiltered ||
    (edge.scope && edge.scope !== 'USER') ||
    (edge.entityType !== 'CALL' && edge.entityType !== 'RENDERS')
  ) {
    return null;
  }

  if (edge.entityType === 'RENDERS') {
    const rawRender = (edge.name || '').replace(/^Renders:\s*/, '').trim();
    if (!rawRender) return null;
    const evs = Array.isArray(edge.evidence) ? edge.evidence : edge.evidence ? [edge.evidence] : [];
    const syntaxEvs = evs.filter(
      (ev: any) => ev?.evidenceRole !== 'import-match' && ev?.evidenceRole !== 'target-signature'
    );
    const chosenEv = syntaxEvs[0] ?? evs[0];
    return {
      name: rawRender,
      confidence: (edge.confidence as 'HIGH' | 'MEDIUM' | 'LOW') ?? 'MEDIUM',
      filePath: chosenEv?.filePath,
      lineNumber: chosenEv?.lineNumber,
      snippet: chosenEv?.snippet,
      reason: srcOutDegree === 0 ? 'opaque-body' : 'unresolved-target',
      ...(typeof edge.metadata?.shapeKey === 'string' ? { shapeKey: edge.metadata.shapeKey } : {}),
      ...(typeof edge.metadata?.unresolvedReason === 'string'
        ? { unresolvedReason: edge.metadata.unresolvedReason }
        : {}),
      ...(typeof edge.metadata?.importSpecifier === 'string'
        ? { importSpecifier: edge.metadata.importSpecifier }
        : {}),
      ...(typeof edge.metadata?.resolvedFilePath === 'string'
        ? { resolvedFilePath: edge.metadata.resolvedFilePath }
        : {}),
      ...(typeof edge.metadata?.targetSymbol === 'string'
        ? { targetSymbol: edge.metadata.targetSymbol }
        : {}),
    };
  }

  const rawCall = (edge.name || '')
    .replace(/^Call:\s*/, '')
    .replace(/\(\)$/, '')
    .trim();
  if (!rawCall) return null;

  const dotIdx = rawCall.lastIndexOf('.');
  const receiver = dotIdx >= 0 ? rawCall.slice(0, dotIdx) : '';
  const method = dotIdx >= 0 ? rawCall.slice(dotIdx + 1) : rawCall;
  const rootReceiver = receiver.split('.')[0];

  if (BUILTIN_RECEIVERS.has(rootReceiver)) return null;
  if (!receiver && BUILTIN_BARE_CALLS.has(method)) return null;
  if (typeof edge.metadata?.unresolvedReason !== 'string' && BUILTIN_METHODS.has(method)) return null;
  if (!receiver && /^set[A-Z]/.test(method)) return null;
  if (receiver.endsWith('Ref')) return null;

  const evs = Array.isArray(edge.evidence) ? edge.evidence : edge.evidence ? [edge.evidence] : [];
  const syntaxEvs = evs.filter(
    (ev: any) => ev?.evidenceRole !== 'import-match' && ev?.evidenceRole !== 'target-signature'
  );
  const checkEvs = syntaxEvs.length > 0 ? syntaxEvs : evs;

  const unresolvedEv = checkEvs.find(
    (ev: any) =>
      !ev?.filePath ||
      !ev?.lineNumber ||
      !resolvedLocations.has(`${ev.filePath}:${ev.lineNumber}`)
  );
  if (checkEvs.length > 0 && !unresolvedEv) {
    return null;
  }

  if (rootReceiver === 'program' && CLI_BUILDER_METHODS.has(method) && srcOutDegree > 0) {
    return null;
  }

  if (
    edge.confidence === 'LOW' ||
    edge.patternId === 'relationship.invoke-returned-function' ||
    edge.patternId === 'relationship.invoke-required-function'
  ) {
    return null;
  }

  const chosenEv = unresolvedEv ?? checkEvs[checkEvs.length - 1] ?? evs[evs.length - 1];
  const callName = `${rawCall}()`;
  return {
    name: callName,
    confidence: (edge.confidence as 'HIGH' | 'MEDIUM' | 'LOW') ?? 'LOW',
    filePath: chosenEv?.filePath,
    lineNumber: chosenEv?.lineNumber,
    snippet: chosenEv?.snippet,
    reason: srcOutDegree === 0 ? 'opaque-body' : 'unresolved-target',
    ...(typeof edge.metadata?.shapeKey === 'string' ? { shapeKey: edge.metadata.shapeKey } : {}),
    ...(typeof edge.metadata?.unresolvedReason === 'string'
      ? { unresolvedReason: edge.metadata.unresolvedReason }
      : {}),
    ...(typeof edge.metadata?.importSpecifier === 'string'
      ? { importSpecifier: edge.metadata.importSpecifier }
      : {}),
    ...(typeof edge.metadata?.resolvedFilePath === 'string'
      ? { resolvedFilePath: edge.metadata.resolvedFilePath }
      : {}),
    ...(typeof edge.metadata?.targetSymbol === 'string'
      ? { targetSymbol: edge.metadata.targetSymbol }
      : {}),
  };
}

/**
 * Computes actionable unresolved outgoing calls per node ID across the entire graph (`[PAT-VIS-15]`).
 */
export function computeActionableUnresolvedCallsByNode(
  rawGraph: Pick<RepresentationGraph, 'nodes' | 'edges'>,
  nodeById: Map<string, StructuralNode>,
  outEdgeMap: Map<string, string[]>,
  isHiddenNode: (node: StructuralNode) => boolean = defaultIsHiddenNode
): Map<string, ActionableUnresolvedCall[]> {
  const resolvedLocations = buildResolvedLocationSet(rawGraph, nodeById, isHiddenNode);
  const byNode = new Map<string, ActionableUnresolvedCall[]>();

  for (const e of rawGraph.edges) {
    if (e.targetId || (e.entityType !== 'CALL' && e.entityType !== 'RENDERS')) continue;
    const src = nodeById.get(e.sourceId);
    if (!src || isHiddenNode(src)) continue;

    const srcOutDegree = outEdgeMap.get(src.id)?.length ?? 0;
    const item = evaluateUnresolvedCallEdge(e, srcOutDegree, resolvedLocations);
    if (!item) continue;

    const list = byNode.get(src.id) ?? [];
    if (!list.some((existing) => existing.name === item.name)) {
      list.push(item);
      byNode.set(src.id, list);
    }
  }

  return byNode;
}

/**
 * Computes actionable unresolved outgoing calls for a single node ID (`[PAT-VIS-15]`).
 */
export function classifyNodeUnresolvedCalls(
  rawNodeId: string,
  rawGraph: { nodes: any[]; edges: any[] },
  rawNodeById: Map<string, any>
): ActionableUnresolvedCall[] {
  const resolvedLocations = buildResolvedLocationSet(rawGraph, rawNodeById, defaultIsHiddenNode);

  let srcOutDegree = 0;
  for (const e of rawGraph.edges) {
    if (!e.targetId) continue;
    const tgt = rawNodeById.get(e.targetId);
    if (!tgt || defaultIsHiddenNode(tgt)) continue;
    if (e.sourceId === rawNodeId && e.targetId !== rawNodeId) {
      srcOutDegree++;
    }
  }

  const list: ActionableUnresolvedCall[] = [];
  for (const e of rawGraph.edges) {
    if (e.sourceId !== rawNodeId) continue;
    const item = evaluateUnresolvedCallEdge(e, srcOutDegree, resolvedLocations);
    if (!item) continue;
    if (!list.some((existing) => existing.name === item.name)) {
      list.push(item);
    }
  }

  return list;
}
