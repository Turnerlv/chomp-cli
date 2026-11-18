/**
 * packages/mcp/src/intelligence.ts
 *
 * Architectural Intelligence, Pre-Edit Blast Radius & Pattern Alignment Engine
 * Enforces [PAT-MCP-08] and [PAT-MCP-09].
 *
 * Operates purely on the deterministic RepresentationGraph from @chomp/core
 * with zero external runtime dependencies so every helper resolves cleanly
 * on the Layer 0 structural graph.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clusterSignalInstances,
  computeActionableUnresolvedCallsByNode,
  computeStructuralHealthMetrics,
  findDarkFiles,
  mergeContractPortValves,
  orphanShapeKey,
  type ContractPortValves,
  type PortDiagnostic,
  type PortOverlayLike,
  type RepresentationGraph,
  type SignalInstance,
  type StructuralEdge,
  type StructuralNode,
} from "@chomp/core";

const CONTAINER_ENTITY_TYPES = new Set(["DEPLOYMENT_UNIT"]);
const PACKAGE_CONNECTOR_ENTITY_TYPES = new Set([
  "EXTERNAL_PACKAGE",
  "NODE_BUILTIN",
]);
const INGRESS_ENTITY_TYPES = new Set([
  "API_ENDPOINT",
  "HTTP_ENDPOINT",
  "NEXTJS_PAGE",
  "NEXTJS_LAYOUT",
  "NEXTJS_MIDDLEWARE",
  "EVENT_LISTENER",
]);
const INIT_BLOCK_ENTITY_TYPE = "INIT_BLOCK";
const FLOW_EDGE_ENTITY_TYPES = new Set([
  "CALL",
  "HTTP_FETCH",
  "REQUESTS",
  "DB_QUERY",
  "DB_OPERATION",
  "LOCAL_API_CALL",
  "EVENT_EMIT",
  "RENDERS",
  "REGISTERS",
  "BINDS_ROUTE",
  "INTERCEPTS",
  "INHERITS",
  "MIXES",
]);
const CONNECTOR_LEAK_ENTITY_TYPES = new Set([
  "DB_QUERY",
  "DB_OPERATION",
  "DB_TRANSACTION",
  "HTTP_FETCH",
  "HTTP_REQUEST",
]);
const HTTP_INVOCATION_EDGE_TYPES = new Set([
  "HTTP_FETCH",
  "REQUESTS",
  "CALL",
  "LOCAL_API_CALL",
]);
const NON_HTTP_ROUTE_PATTERN_IDS = new Set([
  "contract.mcp-tool",
  "contract.express-route-parameter",
  "contract.express-content-negotiation",
  "contract.express-dynamic-methods",
]);
const CONNECTIVITY_TARGET_TYPES = new Set([
  "CALL",
  "INHERITS",
  "MIXES",
  "RENDERS",
  "BINDS_ROUTE",
  "INTERCEPTS",
]);
const NON_EXECUTABLE_CONTRACT_ENTITY_TYPES = new Set([
  "EXPORTED_TYPE",
  "TYPE_DEFINITION",
  "DB_SCHEMA",
  "VALIDATOR_SCHEMA",
  "COLLECTION_CONFIG",
  "SERVER_GUARD",
  "ROUTE_CONFIG",
  "NEXTJS_METADATA",
  "NEXTJS_ROUTE_CONFIG",
  "EXPRESS_ROUTE_PARAM",
]);

const LABEL_PREFIX_RE =
  /^(Exported Function|Class|HTTP Endpoint|API Endpoint|Exported Type|Exported Module|CJS Export|Express Mount|Express Route|Middleware|DB Call|HTTP Call|Socket Call|Call|Public Method|Namespace|Deployment Unit|Package|MCP Tool|Next\.js Page|Next\.js Layout|Next\.js Lifecycle|Next\.js Middleware|Next\.js Config|Next\.js Cache|Route Handler|Server Action):\s*/i;

export interface NodeSummaryRef {
  id: string;
  name: string;
  label: string;
  type: string;
  entityType: string;
  packageName: string;
  filePath?: string;
  lineNumber?: number;
}

export interface UnresolvedCallDiagnostic {
  name: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  filePath?: string;
  lineNumber?: number;
  snippet?: string;
  reason: "opaque-body" | "unresolved-target";
  /** Deterministic, identifier-free shape key recorded by the extractor (v5 Loop 1/3). */
  shapeKey?: string;
}

export interface IsolatedDeploymentUnitsDiagnostic {
  kind: "ISOLATED_DEPLOYMENT_UNITS";
  ruleId: "ISOLATED_DEPLOYMENT_UNITS";
  severity: "ADVISORY";
  isolatedPackages: Array<{
    packageName: string;
    boundaryId: string;
    packagePath?: string;
    contractCount: number;
  }>;
  crossPackageLinkCount: number;
  description: string;
  agentReadinessOpportunity: string;
  agentReadinessGuidance: string;
}

export interface UnstitchedServerRouteRef {
  node: NodeSummaryRef;
  method: string;
  httpMethod: string;
  declaredPath: string;
  effectivePath: string;
  mountPrefix?: string;
}

export interface ProxyRewriteRule {
  source: string;
  destination: string;
  filePath?: string;
}

export interface UnstitchedProtocolSeamDiagnostic {
  kind: "UNSTITCHED_PROTOCOL_SEAM";
  ruleId: "UNSTITCHED_PROTOCOL_SEAM";
  severity: "ADVISORY";
  clientPackage: string;
  serverPackage: string;
  clientConnector: NodeSummaryRef;
  clientConnectors: NodeSummaryRef[];
  clientWrapper?: NodeSummaryRef;
  clientWrappers: NodeSummaryRef[];
  clientCallers: NodeSummaryRef[];
  clientUrlPattern: string;
  clientUrlPatterns: string[];
  detectedClientBaseUrls: string[];
  detectedProxyRewrites: ProxyRewriteRule[];
  detectedServerMountPrefixes: string[];
  detectedMechanisms: string[];
  serverRoutes: UnstitchedServerRouteRef[];
  uncalledServerRoutes: UnstitchedServerRouteRef[];
  candidateServerRoutes: UnstitchedServerRouteRef[];
  candidateBridge: string;
  description: string;
  agentReadinessOpportunity: string;
  agentReadinessGuidance: string;
}

export interface InitBlockLeakedFileDetail {
  filePath: string;
  deadEndContracts: NodeSummaryRef[];
  leakedCalls: Array<{
    connectorId: string;
    name: string;
    entityType: string;
    lineNumber?: number;
    snippet?: string;
  }>;
}

export interface InitBlockConnectorLeakDiagnostic {
  kind: "INIT_BLOCK_CONNECTOR_LEAK";
  ruleId: "INIT_BLOCK_CONNECTOR_LEAK";
  severity: "ADVISORY";
  packageName: string;
  initBlockNode: NodeSummaryRef;
  initConnectorEdgeCount: number;
  totalPackageConnectorEdgeCount: number;
  initConnectorSharePercent: number;
  deadEndContractCount: number;
  deadEndContracts: NodeSummaryRef[];
  leakedConnectors: NodeSummaryRef[];
  affectedFiles: string[];
  fileBreakdown: InitBlockLeakedFileDetail[];
  description: string;
  agentReadinessOpportunity: string;
  agentReadinessGuidance: string;
}

export interface ShadowedDbReceptorDiagnostic {
  kind: "SHADOWED_DB_RECEPTOR";
  ruleId: "SHADOWED_DB_RECEPTOR";
  severity: "ADVISORY";
  packageName: string;
  driverPackageNode: NodeSummaryRef;
  expectedReceptorLabel: string;
  shadowedCallEdgeCount: number;
  shadowedCallers: NodeSummaryRef[];
  description: string;
  agentReadinessOpportunity: string;
  agentReadinessGuidance: string;
}

export type SeamDiagnostic =
  | IsolatedDeploymentUnitsDiagnostic
  | UnstitchedProtocolSeamDiagnostic
  | InitBlockConnectorLeakDiagnostic
  | ShadowedDbReceptorDiagnostic;

interface GraphIndex {
  nodeById: Map<string, StructuralNode>;
  deploymentUnitsByPkg: Map<string, StructuralNode>;
  pathPrefixByPkg: Map<string, string>;
  resolveNodePkg: (nodeId: string) => string;
  outEdgesBySource: Map<string, StructuralEdge[]>;
  inEdgesByTarget: Map<string, StructuralEdge[]>;
  flowOutTargetsBySource: Map<string, string[]>;
  flowInSourcesByTarget: Map<string, string[]>;
  unresolvedCallsByNodeId: Map<string, UnresolvedCallDiagnostic[]>;
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function deploymentUnitLabel(name: string): string {
  const withoutPrefix = name.replace(/^Deployment Unit:\s*/i, "");
  return withoutPrefix.split("/").pop() || withoutPrefix;
}

function cleanNodeLabel(name: string): string {
  const stripped = name.replace(LABEL_PREFIX_RE, "");
  if (
    /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s/i.test(stripped) ||
    stripped.startsWith("/") ||
    /^(generateMetadata|generateStaticParams)\s*\(/.test(stripped)
  ) {
    return stripped;
  }
  if (/^Init:\s+/i.test(stripped)) {
    const unitPart = stripped.replace(/^Init:\s+/i, "");
    return `Init: ${unitPart.split("/").pop() || unitPart}`;
  }
  return stripped.split("/").pop() || stripped;
}

function isHiddenNode(node: StructuralNode): boolean {
  return (
    CONTAINER_ENTITY_TYPES.has(node.entityType) ||
    PACKAGE_CONNECTOR_ENTITY_TYPES.has(node.entityType)
  );
}

function isUnprovableFallback(edge: StructuralEdge): boolean {
  return (
    edge.patternId === "relationship.invoke-returned-function" && !edge.targetId
  );
}

function parseNodeMeta(node: StructuralNode): Record<string, any> {
  if (!node.metadata) return {};
  if (typeof node.metadata === "string") {
    try {
      return JSON.parse(node.metadata) ?? {};
    } catch {
      return {};
    }
  }
  return typeof node.metadata === "object" ? (node.metadata as Record<string, any>) : {};
}

function getPrimaryEvidence(
  entity: StructuralNode | StructuralEdge
): { filePath?: string; lineNumber?: number; snippet?: string } {
  const ev = entity.evidence;
  if (!ev) return {};
  if (Array.isArray(ev)) {
    const syntaxEv =
      ev.find((r) => r?.evidenceRole === "syntax-call" && r?.filePath) ??
      ev.find((r) => Boolean(r?.filePath)) ??
      ev[0];
    return {
      filePath: syntaxEv?.filePath,
      lineNumber: syntaxEv?.lineNumber,
      snippet: syntaxEv?.snippet,
    };
  }
  return {
    filePath: ev.filePath,
    lineNumber: ev.lineNumber,
    snippet: ev.snippet,
  };
}

function normalizePackageQuery(rawPkg: string): string {
  return rawPkg
    .trim()
    .toLowerCase()
    .replace(/^deployment unit:\s*/i, "")
    .replace(/^@[^/]+\//, "")
    .replace(/^(packages|apps)\//, "")
    .replace(/\/+$/, "");
}

function packageMatchesFilter(
  nodePkg: string,
  nodePath: string | undefined,
  rawFilter: string
): boolean {
  const normFilter = normalizePackageQuery(rawFilter);
  const rawLower = rawFilter.trim().toLowerCase();
  if (!normFilter && !rawLower) return true;
  if (nodePkg && nodePkg.toLowerCase() === normFilter) return true;
  if (nodePkg && nodePkg.toLowerCase().includes(normFilter)) return true;
  if (nodePath && nodePath.toLowerCase().includes(rawLower)) return true;
  return false;
}

function toNodeSummaryRef(
  node: StructuralNode,
  resolveNodePkg: (id: string) => string
): NodeSummaryRef {
  const ev = getPrimaryEvidence(node);
  return {
    id: node.id,
    name: node.name,
    label: cleanNodeLabel(node.name),
    type: node.type,
    entityType: node.entityType,
    packageName: resolveNodePkg(node.id) || "root",
    ...(ev.filePath ? { filePath: ev.filePath } : {}),
    ...(ev.lineNumber !== undefined ? { lineNumber: ev.lineNumber } : {}),
  };
}

function computeUnresolvedCallsMap(
  graph: RepresentationGraph,
  nodeById: Map<string, StructuralNode>,
  flowOutTargetsBySource: Map<string, string[]>
): Map<string, UnresolvedCallDiagnostic[]> {
  return computeActionableUnresolvedCallsByNode(
    graph,
    nodeById,
    flowOutTargetsBySource,
    isHiddenNode
  );
}

function buildGraphIndex(graph: RepresentationGraph): GraphIndex {
  const nodeById = new Map<string, StructuralNode>();
  for (const n of graph.nodes) {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  }

  const deploymentUnitsByPkg = new Map<string, StructuralNode>();
  const pathPrefixByPkg = new Map<string, string>();
  for (const n of nodeById.values()) {
    if (n.entityType === "DEPLOYMENT_UNIT") {
      const pkg = deploymentUnitLabel(n.name);
      if (pkg) {
        deploymentUnitsByPkg.set(pkg, n);
        const ev = getPrimaryEvidence(n);
        if (ev.filePath && ev.filePath !== ".") {
          pathPrefixByPkg.set(pkg, ev.filePath.replace(/\/+$/, ""));
        }
      }
    }
  }

  const pkgCache = new Map<string, string>();
  const resolveNodePkg = (nodeId: string): string => {
    const cached = pkgCache.get(nodeId);
    if (cached !== undefined) return cached;

    let label = "";
    const seen = new Set<string>();
    let cursor: StructuralNode | undefined = nodeById.get(nodeId);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.entityType === "DEPLOYMENT_UNIT") {
        label = deploymentUnitLabel(cursor.name);
        break;
      }
      cursor = cursor.parentBoundaryId
        ? nodeById.get(cursor.parentBoundaryId)
        : undefined;
    }

    if (!label) {
      const rawNode = nodeById.get(nodeId);
      const ev = rawNode ? getPrimaryEvidence(rawNode) : {};
      if (ev.filePath) {
        for (const [pkg, prefix] of pathPrefixByPkg.entries()) {
          if (ev.filePath === prefix || ev.filePath.startsWith(`${prefix}/`)) {
            label = pkg;
            break;
          }
        }
      }
      if (!label && rawNode?.entityType === INIT_BLOCK_ENTITY_TYPE) {
        const initUnit = deploymentUnitLabel(rawNode.name.replace(/^Init:\s*/i, ""));
        if (initUnit) {
          label = initUnit;
        }
      }
    }

    pkgCache.set(nodeId, label);
    return label;
  };

  const outEdgesBySource = new Map<string, StructuralEdge[]>();
  const inEdgesByTarget = new Map<string, StructuralEdge[]>();
  const flowOutTargetsBySource = new Map<string, string[]>();
  const flowInSourcesByTarget = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (!outEdgesBySource.has(edge.sourceId)) {
      outEdgesBySource.set(edge.sourceId, []);
    }
    outEdgesBySource.get(edge.sourceId)!.push(edge);

    if (!edge.targetId) continue;
    if (!inEdgesByTarget.has(edge.targetId)) {
      inEdgesByTarget.set(edge.targetId, []);
    }
    inEdgesByTarget.get(edge.targetId)!.push(edge);

    if (!FLOW_EDGE_ENTITY_TYPES.has(edge.entityType)) continue;
    const src = nodeById.get(edge.sourceId);
    const tgt = nodeById.get(edge.targetId);
    if (!src || !tgt) continue;
    if (isHiddenNode(src) || isHiddenNode(tgt)) continue;
    if (src.id === tgt.id) continue;

    let outList = flowOutTargetsBySource.get(src.id);
    if (!outList) {
      outList = [];
      flowOutTargetsBySource.set(src.id, outList);
    }
    if (!outList.includes(tgt.id)) {
      outList.push(tgt.id);
    }

    let inList = flowInSourcesByTarget.get(tgt.id);
    if (!inList) {
      inList = [];
      flowInSourcesByTarget.set(tgt.id, inList);
    }
    if (!inList.includes(src.id)) {
      inList.push(src.id);
    }
  }

  const unresolvedCallsByNodeId = computeUnresolvedCallsMap(
    graph,
    nodeById,
    flowOutTargetsBySource
  );

  return {
    nodeById,
    deploymentUnitsByPkg,
    pathPrefixByPkg,
    resolveNodePkg,
    outEdgesBySource,
    inEdgesByTarget,
    flowOutTargetsBySource,
    flowInSourcesByTarget,
    unresolvedCallsByNodeId,
  };
}

function getAllEvidenceRecords(
  entity: StructuralNode | StructuralEdge | undefined
): Array<{ filePath?: string; lineNumber?: number; snippet?: string }> {
  if (!entity || !entity.evidence) return [];
  const ev = entity.evidence;
  if (Array.isArray(ev)) {
    return ev.map((r) => ({
      filePath: r?.filePath,
      lineNumber: r?.lineNumber,
      snippet: r?.snippet,
    }));
  }
  return [
    {
      filePath: ev.filePath,
      lineNumber: ev.lineNumber,
      snippet: ev.snippet,
    },
  ];
}

function normalizeUrlToPathname(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/\$\{[^}]+\}/g, ":param");
  if (/^https?:\/\//i.test(s)) {
    try {
      const parsed = new URL(s.replace(/:param/g, "__param__"));
      s = parsed.pathname.replace(/__param__/g, ":param");
    } catch {
      const slashIdx = s.indexOf("/", s.indexOf("//") + 2);
      s = slashIdx >= 0 ? s.slice(slashIdx) : "/";
    }
  } else if (s.startsWith(":param/")) {
    s = s.slice(":param".length);
  }
  if (!s.startsWith("/")) return null;
  s = s.split("?")[0].split("#")[0];
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s;
}

function extractStaticRoutePrefix(rawPath: string): string | null {
  const pathname = normalizeUrlToPathname(rawPath);
  if (!pathname) return null;
  let cleaned = pathname
    .replace(/\/:param\b.*$/, "")
    .replace(/:param\b.*$/, "")
    .replace(/\/:[A-Za-z0-9_]+\*?.*$/, "")
    .replace(/\/\[[^\]]+\].*$/, "")
    .replace(/\/\*.*$/, "");
  if (cleaned.length > 1 && cleaned.endsWith("/")) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned || "/";
}

function canonicalizeRoutePattern(rawPath: string): string | null {
  const pathname = normalizeUrlToPathname(rawPath);
  if (!pathname) return null;
  const expanded = pathname.replace(/([^/]):param\b/g, "$1/:param");
  const segments = expanded
    .split("/")
    .filter((seg, idx) => idx === 0 || seg.length > 0)
    .map((seg) => {
      if (seg === ":param" || seg === "*") return ":param";
      if (seg.startsWith(":") && seg.length > 1) return ":param";
      if (seg.startsWith("[") && seg.endsWith("]") && seg.length > 2) return ":param";
      return seg;
    });
  const joined = segments.join("/") || "/";
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function joinMountAndRoute(mountPrefix: string, declaredPath: string): string {
  const normMount = extractStaticRoutePrefix(mountPrefix) ?? "/";
  const normRoute = normalizeUrlToPathname(declaredPath) ?? "/";
  if (normMount === "/") return normRoute;
  if (normRoute === "/") return normMount;
  if (normRoute === normMount || normRoute.startsWith(`${normMount}/`)) {
    return normRoute;
  }
  return `${normMount}${normRoute.startsWith("/") ? normRoute : `/${normRoute}`}`;
}

function extractRewriteRulesFromText(
  text: string,
  filePath?: string
): ProxyRewriteRule[] {
  const rules: ProxyRewriteRule[] = [];
  const seen = new Set<string>();
  const addRule = (source: string, destination: string) => {
    const s = source.trim();
    const d = destination.trim();
    if (!s || !d) return;
    const key = `${s}->${d}`;
    if (!seen.has(key)) {
      seen.add(key);
      rules.push({ source: s, destination: d, ...(filePath ? { filePath } : {}) });
    }
  };

  const rewritePairRe =
    /source\s*:\s*['"`]([^'"`]+)['"`]\s*,\s*destination\s*:\s*['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = rewritePairRe.exec(text)) !== null) {
    addRule(m[1], m[2]);
  }

  const proxyTargetRe =
    /['"`](\/[^'"`]+)['"`]\s*:\s*(?:\{[^}]*target\s*:\s*['"`]([^'"`]+)['"`]|['"`](https?:\/\/[^'"`]+)['"`])/g;
  while ((m = proxyTargetRe.exec(text)) !== null) {
    addRule(m[1], m[2] ?? m[3]);
  }

  if (rules.length === 0 && /\b(?:rewrites|proxies|proxy)\b/i.test(text)) {
    const pathMatch = text.match(/['"`](\/[A-Za-z0-9_/:*-]+)['"`]/);
    const destMatch = text.match(/['"`](https?:\/\/[^'"`]+)['"`]/);
    if (pathMatch) {
      addRule(pathMatch[1], destMatch ? destMatch[1] : "backend");
    }
  }

  return rules;
}

function parseServerEndpointMethodAndPath(
  node: StructuralNode
): { method: string; declaredPath: string } | null {
  const meta = parseNodeMeta(node);
  const ev = getPrimaryEvidence(node);

  const expressMatch = node.name.match(
    /^(?:Express Route|HTTP Endpoint|API Endpoint|Route):\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)?\s*(\/.*)$/i
  );
  if (expressMatch) {
    const method = (expressMatch[1] ?? meta.method ?? "ANY").toUpperCase();
    const norm = normalizeUrlToPathname(expressMatch[2]);
    if (norm) return { method, declaredPath: norm };
  }

  if (typeof meta.routePath === "string" && meta.routePath.trim()) {
    const norm = normalizeUrlToPathname(meta.routePath);
    if (norm) {
      const method =
        typeof meta.method === "string"
          ? meta.method.toUpperCase()
          : node.name.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)\b/i)?.[1]?.toUpperCase() ??
            "ANY";
      return { method, declaredPath: norm };
    }
  }

  const nextRouteHandlerMatch = node.name.match(
    /^Route Handler:\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)\b/i
  );
  if (nextRouteHandlerMatch && ev.filePath) {
    const method = nextRouteHandlerMatch[1].toUpperCase();
    const normFp = ev.filePath.replace(/\\/g, "/");
    const afterApp = normFp.replace(/^.*?app\//, "");
    const withoutRoute = afterApp
      .replace(/\/?route(?:\.[A-Za-z0-9]+)+$/, "")
      .replace(/\([^)]+\)\//g, "")
      .replace(/\([^)]+\)$/, "");
    const routePath =
      !withoutRoute || withoutRoute === "/"
        ? "/"
        : `/${withoutRoute.replace(/^\/+|\/+$/g, "")}`;
    return { method, declaredPath: routePath };
  }

  const stripped = cleanNodeLabel(node.name);
  const bareMatch = stripped.match(
    /^(?:(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)\s+)?(\/.*)$/i
  );
  if (bareMatch) {
    const method = (bareMatch[1] ?? "ANY").toUpperCase();
    const norm = normalizeUrlToPathname(bareMatch[2]);
    if (norm) return { method, declaredPath: norm };
  }

  return null;
}

/**
 * Correlates unstitched client HTTP egress (`OPEN_CONNECTOR` `HTTP_FETCH` nodes with `0` outgoing
 * `REQUESTS` edges, parameterized wrapper URLs like `/api:param`, `axios.create({ baseURL })`, and
 * `next.config.*` `rewrites`/`proxies`) against uncalled server `HTTP_ENDPOINT` ingress contracts
 * (`inDegree === 0` and `app.use('/api/...', router)` mount prefixes) across packages to report
 * candidate protocol bridges (`UNSTITCHED_PROTOCOL_SEAM`, `[PAT-MCP-08]`, `[PAT-MCP-09]`).
 */
function detectUnstitchedProtocolSeams(
  graph: RepresentationGraph,
  index: GraphIndex,
  options?: { packageName?: string; repoPath?: string }
): UnstitchedProtocolSeamDiagnostic[] {
  const pkgFilter = options?.packageName?.trim();

  interface ClientHttpBucket {
    pkg: string;
    connectors: StructuralNode[];
    wrappers: Map<string, StructuralNode>;
    urlPatterns: Set<string>;
    baseUrls: Set<string>;
    proxyRewrites: ProxyRewriteRule[];
  }

  const clientBuckets = new Map<string, ClientHttpBucket>();
  const ensureClientBucket = (pkg: string): ClientHttpBucket => {
    let b = clientBuckets.get(pkg);
    if (!b) {
      b = {
        pkg,
        connectors: [],
        wrappers: new Map(),
        urlPatterns: new Set(),
        baseUrls: new Set(),
        proxyRewrites: [],
      };
      clientBuckets.set(pkg, b);
    }
    return b;
  };

  // 1. Find unstitched HTTP_FETCH / HTTP_REQUEST OPEN_CONNECTOR nodes (0 outgoing REQUESTS/flow edges)
  for (const node of graph.nodes) {
    if ((node.scope ?? "USER") !== "USER") continue;
    if (node.type !== "OPEN_CONNECTOR") continue;
    if (
      node.entityType !== "HTTP_FETCH" &&
      node.entityType !== "HTTP_REQUEST" &&
      node.patternId !== "open-connector.http-call"
    ) {
      continue;
    }

    const outEdges = index.outEdgesBySource.get(node.id) ?? [];
    const hasOutgoingRequests = outEdges.some(
      (e) =>
        e.entityType === "REQUESTS" ||
        (Boolean(e.targetId) && FLOW_EDGE_ENTITY_TYPES.has(e.entityType))
    );
    if (hasOutgoingRequests) continue;

    const inEdges = index.inEdgesByTarget.get(node.id) ?? [];
    let pkg = index.resolveNodePkg(node.id);
    if (!pkg) {
      for (const e of inEdges) {
        const callerPkg = index.resolveNodePkg(e.sourceId);
        if (callerPkg) {
          pkg = callerPkg;
          break;
        }
      }
    }
    if (!pkg) continue;

    const bucket = ensureClientBucket(pkg);
    bucket.connectors.push(node);

    const meta = parseNodeMeta(node);
    if (typeof meta.urlPath === "string" && meta.urlPath.trim()) {
      bucket.urlPatterns.add(meta.urlPath.trim());
    }
    if (typeof meta.baseURL === "string" && meta.baseURL.trim()) {
      bucket.baseUrls.add(meta.baseURL.trim());
    }
    if (Array.isArray(meta.payload)) {
      for (const rawArg of meta.payload) {
        if (typeof rawArg !== "string") continue;
        const baseMatch = rawArg.match(
          /baseURL\s*:\s*(?:['"]([^'"]+)['"]|`([^`]+)`)/i
        );
        if (baseMatch) {
          bucket.baseUrls.add((baseMatch[1] ?? baseMatch[2]).trim());
        }
        const pathLitMatch = rawArg.match(/['"`](\/[^'"`]+)['"`]/);
        if (pathLitMatch && !baseMatch) {
          const norm = normalizeUrlToPathname(pathLitMatch[1]);
          if (norm) bucket.urlPatterns.add(norm);
        }
      }
    }

    for (const ev of getAllEvidenceRecords(node)) {
      const snip = ev.snippet ?? "";
      const baseMatch = snip.match(
        /baseURL\s*:\s*(?:['"]([^'"]+)['"]|`([^`]+)`)/i
      );
      if (baseMatch) {
        bucket.baseUrls.add((baseMatch[1] ?? baseMatch[2]).trim());
      }
      const tmplMatch = snip.match(/`(\/[^`]+)`|['"](\/[^'"]+)['"]/);
      if (tmplMatch && !baseMatch) {
        const rawUrl = tmplMatch[1] ?? tmplMatch[2];
        const norm = normalizeUrlToPathname(rawUrl);
        if (norm) bucket.urlPatterns.add(norm);
      }
    }

    for (const e of inEdges) {
      const edgeMeta =
        e.metadata && typeof e.metadata === "object"
          ? (e.metadata as Record<string, any>)
          : undefined;
      if (typeof edgeMeta?.urlPath === "string" && edgeMeta.urlPath.trim()) {
        bucket.urlPatterns.add(edgeMeta.urlPath.trim());
      }
      if (typeof edgeMeta?.baseURL === "string" && edgeMeta.baseURL.trim()) {
        bucket.baseUrls.add(edgeMeta.baseURL.trim());
      }
      for (const ev of getAllEvidenceRecords(e)) {
        const snip = ev.snippet ?? "";
        const baseMatch = snip.match(
          /baseURL\s*:\s*(?:['"]([^'"]+)['"]|`([^`]+)`)/i
        );
        if (baseMatch) {
          bucket.baseUrls.add((baseMatch[1] ?? baseMatch[2]).trim());
        }
        const tmplMatch = snip.match(/`(\/[^`]+)`|['"](\/[^'"]+)['"]/);
        if (tmplMatch && !baseMatch) {
          const norm = normalizeUrlToPathname(tmplMatch[1] ?? tmplMatch[2]);
          if (norm) bucket.urlPatterns.add(norm);
        }
      }

      const caller = index.nodeById.get(e.sourceId);
      if (caller && caller.type === "CONTRACT" && !isHiddenNode(caller)) {
        bucket.wrappers.set(caller.id, caller);
      } else if (caller && caller.entityType === INIT_BLOCK_ENTITY_TYPE) {
        const evFp = getPrimaryEvidence(e).filePath ?? getPrimaryEvidence(node).filePath;
        let foundFileContract = false;
        if (evFp) {
          for (const cand of graph.nodes) {
            if (
              cand.type === "CONTRACT" &&
              !NON_EXECUTABLE_CONTRACT_ENTITY_TYPES.has(cand.entityType) &&
              getPrimaryEvidence(cand).filePath === evFp
            ) {
              bucket.wrappers.set(cand.id, cand);
              foundFileContract = true;
            }
          }
        }
        if (!foundFileContract) {
          bucket.wrappers.set(caller.id, caller);
        }
      }
    }

    if (bucket.wrappers.size === 0) {
      const connFp = getPrimaryEvidence(node).filePath;
      if (connFp) {
        for (const cand of graph.nodes) {
          if (
            cand.type === "CONTRACT" &&
            !NON_EXECUTABLE_CONTRACT_ENTITY_TYPES.has(cand.entityType) &&
            getPrimaryEvidence(cand).filePath === connFp
          ) {
            bucket.wrappers.set(cand.id, cand);
          }
        }
      }
    }
  }

  if (clientBuckets.size === 0) return [];

  // 2. Enrich client buckets with package-level axios.create({ baseURL }) and next.config.* rewrites/proxies
  for (const [clientPkg, bucket] of clientBuckets.entries()) {
    const addRewrite = (rule: ProxyRewriteRule) => {
      if (
        !bucket.proxyRewrites.some(
          (r) => r.source === rule.source && r.destination === rule.destination
        )
      ) {
        bucket.proxyRewrites.push(rule);
      }
    };

    for (const n of graph.nodes) {
      const nPkg = index.resolveNodePkg(n.id);
      const ev = getPrimaryEvidence(n);
      const isConfigNode =
        ev.filePath &&
        /(?:^|\/)(?:next|vite)\.config\.[A-Za-z0-9]+$/i.test(ev.filePath);
      if (nPkg !== clientPkg && !(isConfigNode && (!nPkg || nPkg === "root"))) {
        continue;
      }

      const meta = parseNodeMeta(n);
      if (typeof meta.baseURL === "string" && meta.baseURL.trim()) {
        bucket.baseUrls.add(meta.baseURL.trim());
      }
      for (const rwArr of [meta.rewrites, meta.proxies, meta.proxyRewrites]) {
        if (Array.isArray(rwArr)) {
          for (const r of rwArr) {
            if (r && typeof r.source === "string" && typeof r.destination === "string") {
              addRewrite({
                source: r.source,
                destination: r.destination,
                filePath: r.filePath ?? r.configFilePath ?? ev.filePath,
              });
            }
          }
        }
      }
      if (meta.proxy && typeof meta.proxy === "object" && !Array.isArray(meta.proxy)) {
        for (const [src, target] of Object.entries(meta.proxy)) {
          const dest =
            typeof target === "string"
              ? target
              : typeof (target as any)?.target === "string"
                ? (target as any).target
                : "";
          if (dest) addRewrite({ source: src, destination: dest, filePath: ev.filePath });
        }
      }

      for (const rec of getAllEvidenceRecords(n)) {
        const snip = rec.snippet ?? "";
        const baseMatch = snip.match(
          /baseURL\s*:\s*(?:['"]([^'"]+)['"]|`([^`]+)`)/i
        );
        if (baseMatch) {
          bucket.baseUrls.add((baseMatch[1] ?? baseMatch[2]).trim());
        }
        if (
          (rec.filePath &&
            /(?:^|\/)(?:next|vite)\.config\.[A-Za-z0-9]+$/i.test(rec.filePath)) ||
          /\b(?:rewrites|proxies|proxy)\b/i.test(n.name) ||
          /\b(?:rewrites|destination)\b/i.test(snip)
        ) {
          for (const rule of extractRewriteRulesFromText(snip, rec.filePath)) {
            addRewrite(rule);
          }
        }
      }
    }

    // Check next.config.* on disk when repoPath is provided
    if (options?.repoPath) {
      const pkgPrefix = index.pathPrefixByPkg.get(clientPkg);
      const candidateDirs = [
        ...(pkgPrefix ? [resolve(options.repoPath, pkgPrefix)] : []),
        resolve(options.repoPath),
      ];
      const configNames = [
        "next.config.ts",
        "next.config.mjs",
        "next.config.js",
        "next.config.cjs",
        "vite.config.ts",
        "vite.config.js",
      ];
      for (const dir of candidateDirs) {
        for (const cfgName of configNames) {
          const absCfg = resolve(dir, cfgName);
          if (existsSync(absCfg)) {
            try {
              const content = readFileSync(absCfg, "utf8");
              const relCfg = pkgPrefix ? `${pkgPrefix}/${cfgName}` : cfgName;
              for (const rule of extractRewriteRulesFromText(content, relCfg)) {
                addRewrite(rule);
              }
            } catch {
              // ignore unreadable config
            }
          }
        }
      }
    }
  }

  // 3. Collect Server Mount Prefixes (`app.use('/api/...', router)`) & Uncalled HTTP_ENDPOINTs per package
  interface ServerMountEntry {
    prefix: string;
    targetHint: string;
    targetNodeId?: string;
    filePath?: string;
  }

  const mountsByServerPkg = new Map<string, ServerMountEntry[]>();
  const recordServerMount = (pkg: string, entry: ServerMountEntry) => {
    if (!pkg || !entry.prefix.startsWith("/")) return;
    let list = mountsByServerPkg.get(pkg);
    if (!list) {
      list = [];
      mountsByServerPkg.set(pkg, list);
    }
    if (
      !list.some(
        (m) => m.prefix === entry.prefix && m.targetHint === entry.targetHint
      )
    ) {
      list.push(entry);
    }
  };

  for (const edge of graph.edges) {
    if ((edge.scope ?? "USER") !== "USER") continue;
    const pkg =
      index.resolveNodePkg(edge.sourceId) ||
      (edge.targetId ? index.resolveNodePkg(edge.targetId) : "");
    if (!pkg) continue;

    const mountMatch = edge.name.match(
      /^Express Mount:\s*(\/[^\s]*)\s*->\s*(.+)$/i
    );
    if (mountMatch) {
      const prefix = normalizeUrlToPathname(mountMatch[1]);
      const targetHint = mountMatch[2].trim();
      if (prefix) {
        recordServerMount(pkg, {
          prefix,
          targetHint,
          targetNodeId: edge.targetId,
          filePath: getPrimaryEvidence(edge).filePath,
        });
      }
    }

    for (const ev of getAllEvidenceRecords(edge)) {
      const snip = ev.snippet ?? "";
      const useRe =
        /\b(?:app|router|server)\.use\(\s*['"`](\/[^'"`]+)['"`](?:\s*,\s*([^)]+))?\)/g;
      let m: RegExpExecArray | null;
      while ((m = useRe.exec(snip)) !== null) {
        const prefix = normalizeUrlToPathname(m[1]);
        if (prefix) {
          recordServerMount(pkg, {
            prefix,
            targetHint: (m[2] ?? "router").trim(),
            targetNodeId: edge.targetId,
            filePath: ev.filePath,
          });
        }
      }
    }
  }

  for (const node of graph.nodes) {
    if ((node.scope ?? "USER") !== "USER") continue;
    const pkg = index.resolveNodePkg(node.id);
    if (!pkg) continue;
    const meta = parseNodeMeta(node);
    if (typeof meta.mountPrefix === "string" && meta.mountPrefix.startsWith("/")) {
      const prefix = normalizeUrlToPathname(meta.mountPrefix);
      if (prefix) {
        recordServerMount(pkg, {
          prefix,
          targetHint: cleanNodeLabel(node.name),
          targetNodeId: node.id,
          filePath: getPrimaryEvidence(node).filePath,
        });
      }
    }
    for (const ev of getAllEvidenceRecords(node)) {
      const snip = ev.snippet ?? "";
      const useRe =
        /\b(?:app|router|server)\.use\(\s*['"`](\/[^'"`]+)['"`](?:\s*,\s*([^)]+))?\)/g;
      let m: RegExpExecArray | null;
      while ((m = useRe.exec(snip)) !== null) {
        const prefix = normalizeUrlToPathname(m[1]);
        if (prefix) {
          recordServerMount(pkg, {
            prefix,
            targetHint: (m[2] ?? "router").trim(),
            targetNodeId: node.id,
            filePath: ev.filePath,
          });
        }
      }
    }
  }

  const uncalledRoutesByServerPkg = new Map<string, UnstitchedServerRouteRef[]>();
  for (const node of graph.nodes) {
    if ((node.scope ?? "USER") !== "USER") continue;
    if (node.type !== "CONTRACT") continue;
    if (
      node.entityType !== "HTTP_ENDPOINT" &&
      node.entityType !== "API_ENDPOINT"
    ) {
      continue;
    }
    if (NON_HTTP_ROUTE_PATTERN_IDS.has(node.patternId)) continue;

    // Must be uncalled (inDegree === 0 from HTTP / call invocation edges)
    const inEdges = index.inEdgesByTarget.get(node.id) ?? [];
    const isCalled = inEdges.some(
      (e) =>
        HTTP_INVOCATION_EDGE_TYPES.has(e.entityType) &&
        e.sourceId !== node.id
    );
    if (isCalled) continue;

    const serverPkg = index.resolveNodePkg(node.id);
    if (!serverPkg) continue;

    const parsed = parseServerEndpointMethodAndPath(node);
    if (!parsed) continue;

    const pkgMounts = mountsByServerPkg.get(serverPkg) ?? [];
    const nodeEv = getPrimaryEvidence(node);
    const nodeFileStem = nodeEv.filePath
      ? (nodeEv.filePath.split("/").pop() ?? "").replace(/\.[A-Za-z0-9]+$/, "").toLowerCase()
      : "";

    let matchedMountPrefix: string | undefined;
    const meta = parseNodeMeta(node);
    if (typeof meta.mountPrefix === "string" && meta.mountPrefix.startsWith("/")) {
      matchedMountPrefix = normalizeUrlToPathname(meta.mountPrefix) ?? undefined;
    }
    if (!matchedMountPrefix && pkgMounts.length > 0) {
      const specificMount = pkgMounts.find((m) => {
        if (m.targetNodeId === node.id) return true;
        if (m.targetNodeId) {
          const tNode = index.nodeById.get(m.targetNodeId);
          const tFp = tNode ? getPrimaryEvidence(tNode).filePath : undefined;
          if (tFp && nodeEv.filePath && tFp === nodeEv.filePath) return true;
        }
        if (nodeFileStem && nodeFileStem !== "index" && nodeFileStem !== "routes") {
          const hintLower = m.targetHint.toLowerCase();
          return hintLower.includes(nodeFileStem);
        }
        return false;
      });
      if (specificMount) {
        matchedMountPrefix = specificMount.prefix;
      } else if (
        !parsed.declaredPath.startsWith(pkgMounts[0].prefix) ||
        parsed.declaredPath === "/"
      ) {
        matchedMountPrefix = pkgMounts[0].prefix;
      }
    }

    const effectivePath = matchedMountPrefix
      ? joinMountAndRoute(matchedMountPrefix, parsed.declaredPath)
      : parsed.declaredPath;

    let list = uncalledRoutesByServerPkg.get(serverPkg);
    if (!list) {
      list = [];
      uncalledRoutesByServerPkg.set(serverPkg, list);
    }
    list.push({
      node: toNodeSummaryRef(node, index.resolveNodePkg),
      method: parsed.method,
      httpMethod: parsed.method,
      declaredPath: parsed.declaredPath,
      effectivePath,
      ...(matchedMountPrefix ? { mountPrefix: matchedMountPrefix } : {}),
    });
  }

  // 4. Correlate Client Buckets with Server Uncalled Routes across packages
  const seams: UnstitchedProtocolSeamDiagnostic[] = [];

  for (const [clientPkg, bucket] of clientBuckets.entries()) {
    for (const [serverPkg, serverRoutes] of uncalledRoutesByServerPkg.entries()) {
      if (clientPkg === serverPkg) continue;
      if (
        pkgFilter &&
        !packageMatchesFilter(
          clientPkg,
          index.pathPrefixByPkg.get(clientPkg),
          pkgFilter
        ) &&
        !packageMatchesFilter(
          serverPkg,
          index.pathPrefixByPkg.get(serverPkg),
          pkgFilter
        )
      ) {
        continue;
      }

      const basePrefixes = [...bucket.baseUrls]
        .map((b) => extractStaticRoutePrefix(b))
        .filter((p): p is string => Boolean(p));

      const rewritePrefixes: string[] = [];
      for (const rw of bucket.proxyRewrites) {
        const srcPrefix = extractStaticRoutePrefix(rw.source);
        if (srcPrefix) rewritePrefixes.push(srcPrefix);
        const dstPrefix = extractStaticRoutePrefix(rw.destination);
        if (dstPrefix) rewritePrefixes.push(dstPrefix);
      }

      const candidatePrefixes = new Set<string>([
        ...basePrefixes,
        ...rewritePrefixes,
      ]);
      const candidateCanonicalPaths = new Set<string>();

      for (const pat of bucket.urlPatterns) {
        const pref = extractStaticRoutePrefix(pat);
        if (pref && pref !== "/") candidatePrefixes.add(pref);
        const canon = canonicalizeRoutePattern(pat);
        if (canon) {
          candidateCanonicalPaths.add(canon);
          for (const bp of basePrefixes) {
            const joined = canonicalizeRoutePattern(joinMountAndRoute(bp, pat));
            if (joined) candidateCanonicalPaths.add(joined);
          }
        }
      }

      const matchedRoutes = serverRoutes.filter((route) => {
        const canonEffective = canonicalizeRoutePattern(route.effectivePath);
        const canonDeclared = canonicalizeRoutePattern(route.declaredPath);

        if (canonEffective && candidateCanonicalPaths.has(canonEffective)) {
          return true;
        }
        if (canonDeclared && candidateCanonicalPaths.has(canonDeclared)) {
          return true;
        }

        for (const prefix of candidatePrefixes) {
          if (prefix === "/") continue;
          if (
            route.effectivePath === prefix ||
            route.effectivePath.startsWith(`${prefix}/`) ||
            route.declaredPath === prefix ||
            route.declaredPath.startsWith(`${prefix}/`) ||
            route.mountPrefix === prefix ||
            (route.mountPrefix && route.mountPrefix.startsWith(`${prefix}/`))
          ) {
            return true;
          }
        }

        return false;
      });

      const hasGenericDynamicClient =
        bucket.urlPatterns.size === 0 ||
        [...bucket.urlPatterns].some((p) => p === ":param" || p === "/:param") ||
        bucket.baseUrls.size > 0 ||
        bucket.proxyRewrites.length > 0;

      const finalRoutes =
        matchedRoutes.length > 0
          ? matchedRoutes
          : hasGenericDynamicClient
            ? serverRoutes
            : [];

      if (finalRoutes.length === 0) continue;

      // Sort connectors so request connectors (`fetch`, `api.get`) precede factory `axios.create`
      const sortedConnectors = [...bucket.connectors].sort((a, b) => {
        const aIsCreate = /create$/i.test(a.name) ? 1 : 0;
        const bIsCreate = /create$/i.test(b.name) ? 1 : 0;
        return aIsCreate - bIsCreate;
      });
      const connectorRefs = sortedConnectors.map((c) =>
        toNodeSummaryRef(c, index.resolveNodePkg)
      );
      const primaryConnector = connectorRefs[0];
      const wrapperRefs = [...bucket.wrappers.values()].map((w) =>
        toNodeSummaryRef(w, index.resolveNodePkg)
      );
      const primaryWrapper = wrapperRefs[0];

      const serverMountPrefixes = [
        ...new Set(
          [
            ...(mountsByServerPkg.get(serverPkg)?.map((m) => m.prefix) ?? []),
            ...finalRoutes
              .map((r) => r.mountPrefix)
              .filter((m): m is string => Boolean(m)),
          ]
        ),
      ];

      const clientUrlPatterns = [...bucket.urlPatterns];
      const detectedClientBaseUrls = [...bucket.baseUrls];
      const detectedProxyRewrites = bucket.proxyRewrites;

      const clientCallerLabel = primaryWrapper
        ? `${clientPkg}:${primaryWrapper.label}`
        : `${clientPkg}:${primaryConnector.label}`;
      const clientSignals: string[] = [];
      if (clientUrlPatterns.length > 0) {
        clientSignals.push(clientUrlPatterns.slice(0, 3).join(", "));
      }
      if (detectedClientBaseUrls.length > 0) {
        clientSignals.push(`baseURL: ${detectedClientBaseUrls.join(", ")}`);
      }
      if (detectedProxyRewrites.length > 0) {
        clientSignals.push(
          `rewrite: ${detectedProxyRewrites.map((r) => `${r.source} -> ${r.destination}`).join(", ")}`
        );
      }
      const clientSignalStr =
        clientSignals.length > 0 ? ` [${clientSignals.join(" | ")}]` : "";

      const routeLabels = finalRoutes
        .slice(0, 5)
        .map((r) =>
          r.mountPrefix && r.effectivePath !== r.declaredPath
            ? `${r.method} ${r.effectivePath} (declared ${r.declaredPath} under mount ${r.mountPrefix})`
            : `${r.method} ${r.effectivePath}`
        )
        .join(", ");

      const candidateBridge = `${clientCallerLabel}${clientSignalStr} <-> ${serverPkg}:${routeLabels}`;
      const description =
        `Unstitched HTTP protocol seam between '${clientPkg}' and '${serverPkg}': ` +
        `client HTTP egress '${primaryConnector.name}'${primaryWrapper ? ` (wrapped by '${primaryWrapper.label}')` : ""}${clientSignalStr} has 0 outgoing REQUESTS/stitched edges, ` +
        `while '${serverPkg}' exposes ${finalRoutes.length} uncalled HTTP_ENDPOINT ingress contract(s) (${routeLabels}) with inDegree === 0.`;
      const guidance =
        `Protocol Seam Opportunity ([PAT-MCP-09]): Candidate bridge ${candidateBridge}. ` +
        `To stitch '${clientPkg}' to '${serverPkg}' on the Chomp map, pass static or canonical parameterized route paths (e.g. '/api/...') directly to the HTTP client or declare a convention rule in chomp.config.json, then verify with chomp_get_diff.`;

      const detectedMechanisms: string[] = [];
      if (
        clientUrlPatterns.some(
          (p) => p.includes(":param") || p.includes(":") || p.includes("${")
        )
      ) {
        detectedMechanisms.push("parameterized-fetch-wrapper");
      } else if (clientUrlPatterns.length > 0) {
        detectedMechanisms.push("http-fetch-egress");
      }
      if (detectedClientBaseUrls.length > 0) {
        detectedMechanisms.push("axios-base-url");
      }
      if (serverMountPrefixes.length > 0) {
        detectedMechanisms.push("express-router-mount");
      }
      if (detectedProxyRewrites.length > 0) {
        detectedMechanisms.push("nextjs-rewrite-proxy");
      }

      seams.push({
        kind: "UNSTITCHED_PROTOCOL_SEAM",
        ruleId: "UNSTITCHED_PROTOCOL_SEAM",
        severity: "ADVISORY",
        clientPackage: clientPkg,
        serverPackage: serverPkg,
        clientConnector: primaryConnector,
        clientConnectors: connectorRefs,
        ...(primaryWrapper ? { clientWrapper: primaryWrapper } : {}),
        clientWrappers: wrapperRefs,
        clientCallers: wrapperRefs,
        clientUrlPattern:
          clientUrlPatterns[0] ??
          detectedClientBaseUrls[0] ??
          detectedProxyRewrites[0]?.source ??
          "/",
        clientUrlPatterns,
        detectedClientBaseUrls,
        detectedProxyRewrites,
        detectedServerMountPrefixes: serverMountPrefixes,
        detectedMechanisms,
        serverRoutes: finalRoutes,
        uncalledServerRoutes: finalRoutes,
        candidateServerRoutes: finalRoutes,
        candidateBridge,
        description,
        agentReadinessOpportunity: guidance,
        agentReadinessGuidance: guidance,
      });
    }
  }

  return seams;
}

/**
 * Flags when a package's `Init: <pkg>` boundary owns the majority of `OPEN_CONNECTOR` edges
 * (`DB_QUERY`, `HTTP_FETCH`) while its `HTTP_ENDPOINT` / `EXPORTED_MODULE` contracts are dead-end
 * ingress (`resolvedOutDegree === 0`), pinpointing the exact files where contract scope ownership
 * failed to propagate (`INIT_BLOCK_CONNECTOR_LEAK`, `[PAT-MCP-08]`, `[PAT-MCP-09]`, `[PAT-VIS-15]`).
 */
function detectInitBlockConnectorLeaks(
  graph: RepresentationGraph,
  index: GraphIndex,
  options?: { packageName?: string }
): InitBlockConnectorLeakDiagnostic[] {
  const pkgFilter = options?.packageName?.trim();
  const leaks: InitBlockConnectorLeakDiagnostic[] = [];

  for (const [pkg, duNode] of index.deploymentUnitsByPkg.entries()) {
    if (
      pkgFilter &&
      !packageMatchesFilter(pkg, index.pathPrefixByPkg.get(pkg), pkgFilter)
    ) {
      continue;
    }

    const initNode = graph.nodes.find(
      (n) =>
        (n.scope ?? "USER") === "USER" &&
        n.entityType === INIT_BLOCK_ENTITY_TYPE &&
        (n.parentBoundaryId === duNode.id || index.resolveNodePkg(n.id) === pkg)
    );
    if (!initNode) continue;

    const pkgConnectorEdges = graph.edges.filter((e) => {
      if ((e.scope ?? "USER") !== "USER") return false;
      if (index.resolveNodePkg(e.sourceId) !== pkg) return false;
      if (CONNECTOR_LEAK_ENTITY_TYPES.has(e.entityType)) return true;
      if (!e.targetId) return false;
      const tgt = index.nodeById.get(e.targetId);
      return Boolean(
        tgt &&
          tgt.type === "OPEN_CONNECTOR" &&
          CONNECTOR_LEAK_ENTITY_TYPES.has(tgt.entityType)
      );
    });

    if (pkgConnectorEdges.length === 0) continue;

    const initConnectorEdges = pkgConnectorEdges.filter(
      (e) => e.sourceId === initNode.id
    );
    // Must own the majority (> 50%) of OPEN_CONNECTOR (DB_QUERY / HTTP_FETCH) edges in the package
    if (initConnectorEdges.length <= pkgConnectorEdges.length / 2) continue;

    // Identify HTTP_ENDPOINT / API_ENDPOINT / EXPORTED_MODULE contracts in the package
    const candidateContracts = graph.nodes.filter((n) => {
      if ((n.scope ?? "USER") !== "USER") return false;
      if (n.type !== "CONTRACT") return false;
      if (index.resolveNodePkg(n.id) !== pkg) return false;
      if (NON_HTTP_ROUTE_PATTERN_IDS.has(n.patternId)) return false;
      return (
        n.entityType === "HTTP_ENDPOINT" ||
        n.entityType === "API_ENDPOINT" ||
        n.entityType === "EXPORTED_MODULE"
      );
    });

    if (candidateContracts.length === 0) continue;

    const deadEndContracts = candidateContracts.filter(
      (c) => (index.flowOutTargetsBySource.get(c.id)?.length ?? 0) === 0
    );
    if (deadEndContracts.length === 0) continue;

    // Track non-init contract call evidence keys so deduplicated OPEN_CONNECTOR nodes don't mix
    // resolved contract call sites into the leaked file breakdown
    const contractOwnedEvKeys = new Set<string>();
    for (const e of pkgConnectorEdges) {
      if (e.sourceId === initNode.id) continue;
      for (const ev of getAllEvidenceRecords(e)) {
        if (ev.filePath) {
          contractOwnedEvKeys.add(`${ev.filePath}:${ev.lineNumber ?? ""}`);
        }
      }
    }

    const leakedConnectorsMap = new Map<string, NodeSummaryRef>();
    const leakedCallsByFile = new Map<
      string,
      Array<{
        connectorId: string;
        name: string;
        entityType: string;
        lineNumber?: number;
        snippet?: string;
      }>
    >();

    const recordLeakedCall = (
      filePath: string,
      call: {
        connectorId: string;
        name: string;
        entityType: string;
        lineNumber?: number;
        snippet?: string;
      }
    ) => {
      let list = leakedCallsByFile.get(filePath);
      if (!list) {
        list = [];
        leakedCallsByFile.set(filePath, list);
      }
      if (
        !list.some(
          (c) =>
            c.connectorId === call.connectorId &&
            c.lineNumber === call.lineNumber &&
            c.name === call.name
        )
      ) {
        list.push(call);
      }
    };

    for (const edge of initConnectorEdges) {
      const tgt = edge.targetId ? index.nodeById.get(edge.targetId) : undefined;
      if (tgt && !leakedConnectorsMap.has(tgt.id)) {
        leakedConnectorsMap.set(tgt.id, toNodeSummaryRef(tgt, index.resolveNodePkg));
      }
      const connId = tgt?.id ?? edge.id;
      const connName = tgt ? cleanNodeLabel(tgt.name) : cleanNodeLabel(edge.name);
      const connEntityType = tgt?.entityType ?? edge.entityType;

      const edgeEvs = getAllEvidenceRecords(edge).filter((ev) => Boolean(ev.filePath));
      const tgtEvs = tgt
        ? getAllEvidenceRecords(tgt).filter(
            (ev) =>
              Boolean(ev.filePath) &&
              !contractOwnedEvKeys.has(`${ev.filePath}:${ev.lineNumber ?? ""}`)
          )
        : [];

      const combinedEvs = [...edgeEvs, ...tgtEvs];
      if (combinedEvs.length > 0) {
        for (const ev of combinedEvs) {
          if (!ev.filePath) continue;
          recordLeakedCall(ev.filePath, {
            connectorId: connId,
            name: connName,
            entityType: connEntityType,
            lineNumber: ev.lineNumber,
            snippet: ev.snippet,
          });
        }
      } else {
        const fallbackFp = getPrimaryEvidence(initNode).filePath;
        if (fallbackFp) {
          recordLeakedCall(fallbackFp, {
            connectorId: connId,
            name: connName,
            entityType: connEntityType,
          });
        }
      }
    }

    const deadEndRefs = deadEndContracts.map((c) =>
      toNodeSummaryRef(c, index.resolveNodePkg)
    );
    const deadEndByFile = new Map<string, NodeSummaryRef[]>();
    for (const ref of deadEndRefs) {
      if (!ref.filePath) continue;
      let list = deadEndByFile.get(ref.filePath);
      if (!list) {
        list = [];
        deadEndByFile.set(ref.filePath, list);
      }
      list.push(ref);
    }

    const candidateFiles = new Set<string>([
      ...leakedCallsByFile.keys(),
      ...(leakedCallsByFile.size === 0 ? deadEndByFile.keys() : []),
    ]);
    // Also include files with dead-end contracts if they share the package and had leaked calls
    for (const fp of deadEndByFile.keys()) {
      if (leakedCallsByFile.has(fp)) {
        candidateFiles.add(fp);
      }
    }

    const fileBreakdown: InitBlockLeakedFileDetail[] = [...candidateFiles]
      .map((filePath) => ({
        filePath,
        deadEndContracts: deadEndByFile.get(filePath) ?? [],
        leakedCalls: leakedCallsByFile.get(filePath) ?? [],
      }))
      .sort((a, b) => {
        const aBoth = a.deadEndContracts.length > 0 && a.leakedCalls.length > 0 ? 1 : 0;
        const bBoth = b.deadEndContracts.length > 0 && b.leakedCalls.length > 0 ? 1 : 0;
        if (aBoth !== bBoth) return bBoth - aBoth;
        if (b.leakedCalls.length !== a.leakedCalls.length) {
          return b.leakedCalls.length - a.leakedCalls.length;
        }
        return a.filePath.localeCompare(b.filePath);
      });

    const affectedFiles = fileBreakdown.map((f) => f.filePath);
    const sharePercent = round1(
      (initConnectorEdges.length / pkgConnectorEdges.length) * 100
    );
    const initSummary = toNodeSummaryRef(initNode, index.resolveNodePkg);
    const leakedConnectors = [...leakedConnectorsMap.values()];

    const description =
      `'${initSummary.label}' in package '${pkg}' owns ${initConnectorEdges.length}/${pkgConnectorEdges.length} (${sharePercent}%) of OPEN_CONNECTOR edges (${leakedConnectors.map((c) => c.label).join(", ") || "DB_QUERY/HTTP_FETCH"}) ` +
      `while ${deadEndRefs.length} HTTP_ENDPOINT/EXPORTED_MODULE contract(s) (${deadEndRefs.slice(0, 4).map((c) => c.label).join(", ")}) are dead-end ingress (resolvedOutDegree === 0). ` +
      `Scope ownership failed to propagate in: ${affectedFiles.join(", ") || pkg}.`;
    const guidance =
      `INIT_BLOCK Gravity Leak ([PAT-MCP-08], [PAT-VIS-15]): In [${affectedFiles.join(", ") || pkg}], ` +
      `deferred calls to [${leakedConnectors.map((c) => c.label).join(", ")}] fell back to '${initSummary.label}' instead of binding to [${deadEndRefs.slice(0, 4).map((c) => c.label).join(", ")}]. ` +
      `Ensure route/module handlers are registered in ownerByNode or bridged via propagateLocalHelperOwners / chomp.config.json conventions, then verify with chomp_get_diff.`;

    leaks.push({
      kind: "INIT_BLOCK_CONNECTOR_LEAK",
      ruleId: "INIT_BLOCK_CONNECTOR_LEAK",
      severity: "ADVISORY",
      packageName: pkg,
      initBlockNode: initSummary,
      initConnectorEdgeCount: initConnectorEdges.length,
      totalPackageConnectorEdgeCount: pkgConnectorEdges.length,
      initConnectorSharePercent: sharePercent,
      deadEndContractCount: deadEndRefs.length,
      deadEndContracts: deadEndRefs,
      leakedConnectors,
      affectedFiles,
      fileBreakdown,
      description,
      agentReadinessOpportunity: guidance,
      agentReadinessGuidance: guidance,
    });
  }

  return leaks;
}

const KNOWN_DB_DRIVER_RECEPTORS: ReadonlyMap<string, string> = new Map([
  ["pg", "Database: PostgreSQL"],
  ["pg-pool", "Database: PostgreSQL"],
  ["postgres", "Database: PostgreSQL"],
  ["@neondatabase/serverless", "Database: PostgreSQL"],
  ["@vercel/postgres", "Database: PostgreSQL"],
  ["@electric-sql/pglite", "Database: PostgreSQL"],
  ["mysql", "Database: MySQL"],
  ["mysql2", "Database: MySQL"],
  ["@planetscale/database", "Database: MySQL"],
  ["better-sqlite3", "Database: SQLite"],
  ["sqlite3", "Database: SQLite"],
  ["@libsql/client", "Database: SQLite"],
  ["sql.js", "Database: SQLite"],
  ["mongodb", "Database: MongoDB"],
  ["mongoose", "Database: MongoDB"],
  ["redis", "Cache: Redis"],
  ["ioredis", "Cache: Redis"],
  ["@upstash/redis", "Cache: Redis"],
]);

/**
 * Flags when a package invokes a known database driver (`Package: pg`, `Package: mysql2`, etc.)
 * via generic `EXTERNAL_PACKAGE` `CALL` edges (`● pg` micro-node) while emitting 0 `DB_QUERY` /
 * `DB_OPERATION` Open Connectors for the Database Receptor Box (`SHADOWED_DB_RECEPTOR`).
 */
function detectShadowedDbReceptors(
  graph: RepresentationGraph,
  index: GraphIndex,
  options?: { packageName?: string }
): ShadowedDbReceptorDiagnostic[] {
  const pkgFilter = options?.packageName?.trim();
  const diagnostics: ShadowedDbReceptorDiagnostic[] = [];

  for (const [pkg] of index.deploymentUnitsByPkg.entries()) {
    if (
      pkgFilter &&
      !packageMatchesFilter(pkg, index.pathPrefixByPkg.get(pkg), pkgFilter)
    ) {
      continue;
    }

    const pkgDbConnectors = graph.nodes.filter(
      (n) =>
        (n.scope ?? "USER") === "USER" &&
        n.type === "OPEN_CONNECTOR" &&
        (n.entityType === "DB_QUERY" ||
          n.entityType === "DB_OPERATION" ||
          n.entityType === "DB_TRANSACTION") &&
        index.resolveNodePkg(n.id) === pkg
    );
    if (pkgDbConnectors.length > 0) continue;

    for (const node of graph.nodes) {
      if (
        node.type !== "OPEN_CONNECTOR" ||
        node.entityType !== "EXTERNAL_PACKAGE"
      ) {
        continue;
      }
      const depName = node.name.replace(/^Package:\s*/i, "").trim();
      const expectedReceptorLabel = KNOWN_DB_DRIVER_RECEPTORS.get(depName);
      if (!expectedReceptorLabel) continue;

      const inEdges = (index.inEdgesByTarget.get(node.id) ?? []).filter(
        (e) =>
          (e.scope ?? "USER") === "USER" &&
          index.resolveNodePkg(e.sourceId) === pkg
      );
      if (inEdges.length === 0) continue;

      const callersMap = new Map<string, NodeSummaryRef>();
      for (const e of inEdges) {
        const caller = index.nodeById.get(e.sourceId);
        if (caller && !callersMap.has(caller.id)) {
          callersMap.set(caller.id, toNodeSummaryRef(caller, index.resolveNodePkg));
        }
      }
      const shadowedCallers = [...callersMap.values()];
      const driverRef = toNodeSummaryRef(node, index.resolveNodePkg);

      const description =
        `Package '${pkg}' has ${inEdges.length} call edge(s) targeting '${node.name}' (EXTERNAL_PACKAGE micro-node) from [${shadowedCallers.map((c) => c.label).join(", ")}], ` +
        `but emitted 0 DB_QUERY/DB_OPERATION Open Connectors (${expectedReceptorLabel} receptor box is missing).`;
      const guidance =
        `Shadowed DB Receptor ([PAT-MCP-08], [PAT-VIS-16]): Database calls in '${pkg}' collapsed into the '${node.name}' package micro-node instead of connecting to '${expectedReceptorLabel}'. ` +
        `Ensure DB client aliases (destructured 'Pool'/'Client' imports, 'new Pool()', and awaited 'pool.connect()') propagate 'DB' bindings in openConnectorVisitor.ts, then verify with chomp_get_diff.`;

      diagnostics.push({
        kind: "SHADOWED_DB_RECEPTOR",
        ruleId: "SHADOWED_DB_RECEPTOR",
        severity: "ADVISORY",
        packageName: pkg,
        driverPackageNode: driverRef,
        expectedReceptorLabel,
        shadowedCallEdgeCount: inEdges.length,
        shadowedCallers,
        description,
        agentReadinessOpportunity: guidance,
        agentReadinessGuidance: guidance,
      });
    }
  }

  return diagnostics;
}

/**
 * Filters nodes in `chomp_get_nodes` with support for `search_term` and `packageName`
 * fast-path resolution ([PAT-MCP-08]).
 */
export function filterNodesForMcp(
  graph: RepresentationGraph,
  filters: {
    type?: string;
    entityType?: string;
    parentBoundaryId?: string;
    name?: string;
    filePath?: string;
    searchTerm?: string;
    packageName?: string;
    overlaysByEntityId?: Map<string, Array<{ layer: string; payload?: Record<string, any> }>>;
  }
): StructuralNode[] {
  const index = buildGraphIndex(graph);
  const nameFilter = filters.name?.toLowerCase();
  const filePathFilter = filters.filePath?.toLowerCase();
  const searchTermFilter = filters.searchTerm?.toLowerCase();
  const packageFilter = filters.packageName?.trim();

  let filteredNodes = graph.nodes;

  if (filters.type) {
    filteredNodes = filteredNodes.filter((n) => n.type === filters.type);
  }
  if (filters.entityType) {
    filteredNodes = filteredNodes.filter(
      (n) => n.entityType === filters.entityType
    );
  }
  if (filters.parentBoundaryId) {
    filteredNodes = filteredNodes.filter(
      (n) => n.parentBoundaryId === filters.parentBoundaryId
    );
  }
  if (packageFilter) {
    filteredNodes = filteredNodes.filter((n) => {
      const pkg = index.resolveNodePkg(n.id);
      const ev = getPrimaryEvidence(n);
      return packageMatchesFilter(pkg, ev.filePath, packageFilter);
    });
  }
  if (nameFilter) {
    filteredNodes = filteredNodes.filter(
      (n) =>
        typeof n.name === "string" && n.name.toLowerCase().includes(nameFilter)
    );
  }
  if (filePathFilter) {
    filteredNodes = filteredNodes.filter((n) => {
      const ev = n.evidence;
      if (!ev) return false;
      if (Array.isArray(ev)) {
        return ev.some(
          (r) =>
            typeof r?.filePath === "string" &&
            r.filePath.toLowerCase().includes(filePathFilter)
        );
      }
      return (
        typeof ev.filePath === "string" &&
        ev.filePath.toLowerCase().includes(filePathFilter)
      );
    });
  }
  if (searchTermFilter) {
    filteredNodes = filteredNodes.filter((n) => {
      if (n.id.toLowerCase().includes(searchTermFilter)) return true;
      if (n.name.toLowerCase().includes(searchTermFilter)) return true;
      if (n.entityType.toLowerCase().includes(searchTermFilter)) return true;
      const meta = parseNodeMeta(n);
      if (
        typeof meta.humanLabel === "string" &&
        meta.humanLabel.toLowerCase().includes(searchTermFilter)
      ) {
        return true;
      }
      if (
        typeof meta.domain === "string" &&
        meta.domain.toLowerCase().includes(searchTermFilter)
      ) {
        return true;
      }
      if (
        typeof meta.summary === "string" &&
        meta.summary.toLowerCase().includes(searchTermFilter)
      ) {
        return true;
      }
      const nodeOverlays = filters.overlaysByEntityId?.get(n.id);
      if (nodeOverlays) {
        for (const ov of nodeOverlays) {
          const p = ov.payload;
          if (!p || typeof p !== "object") continue;
          if (
            typeof p.humanLabel === "string" &&
            p.humanLabel.toLowerCase().includes(searchTermFilter)
          ) {
            return true;
          }
          if (
            typeof p.domain === "string" &&
            p.domain.toLowerCase().includes(searchTermFilter)
          ) {
            return true;
          }
          if (
            typeof p.summary === "string" &&
            p.summary.toLowerCase().includes(searchTermFilter)
          ) {
            return true;
          }
        }
      }
      const ev = n.evidence;
      if (Array.isArray(ev)) {
        return ev.some(
          (r) =>
            typeof r?.filePath === "string" &&
            r.filePath.toLowerCase().includes(searchTermFilter)
        );
      }
      return (
        typeof ev?.filePath === "string" &&
        ev.filePath.toLowerCase().includes(searchTermFilter)
      );
    });
  }

  return filteredNodes;
}

/**
 * Selective MCP overlay hydration (`[PAT-DB-05]`).
 * Prevents multi-plugin stores from bloating structural queries in `chomp_get_nodes`:
 * - By default (`includeOverlays` omitted and `layers` omitted), returns pure structural nodes without `overlays`.
 * - When `includeOverlays: true` or `layers` is specified, attaches matching `overlays` onto each node.
 */
export function hydrateNodeOverlays<
  TNode extends { id: string },
  TOverlay extends { entityId: string; layer: string }
>(
  nodes: TNode[],
  overlays: TOverlay[],
  options?: {
    includeOverlays?: boolean;
    layers?: string[];
  }
): Array<TNode & { overlays?: TOverlay[] }> {
  const requestedLayers = (options?.layers ?? [])
    .map((l) => l.trim())
    .filter(Boolean);
  const layerSet = requestedLayers.length > 0 ? new Set(requestedLayers) : null;
  const shouldInclude = options?.includeOverlays ?? (layerSet !== null);

  if (!shouldInclude) {
    return nodes.map((n) => ({ ...n }));
  }

  const overlaysByEntityId = new Map<string, TOverlay[]>();
  for (const ov of overlays) {
    if (layerSet && !layerSet.has(ov.layer)) continue;
    let list = overlaysByEntityId.get(ov.entityId);
    if (!list) {
      list = [];
      overlaysByEntityId.set(ov.entityId, list);
    }
    list.push(ov);
  }

  return nodes.map((n) => {
    const nodeOverlays = overlaysByEntityId.get(n.id);
    return nodeOverlays && nodeOverlays.length > 0
      ? { ...n, overlays: nodeOverlays }
      : { ...n };
  });
}

/**
 * Formats per-layer write counts for `chomp_enrich_nodes` (`[PAT-DB-05]`).
 */
export function formatEnrichNodesSummary(
  layerCounts: Record<string, number>,
  rulesAddedOrUpdated: number
): string {
  const entries = Object.entries(layerCounts).filter(([, count]) => count > 0);
  const totalUpdated = entries.reduce((acc, [, count]) => acc + count, 0);
  const layerBreakdown =
    entries.length > 0
      ? ` (${entries.map(([layer, count]) => `${layer}: ${count}`).join(", ")})`
      : "";
  return `Successfully enriched ${totalUpdated} node(s)${layerBreakdown} and saved ${rulesAddedOrUpdated} classification rule(s) to .chomp/rules.json.`;
}

export type ActiveViewLevel = "system" | "package";

export interface ResolvedViewTargetAltitude {
  viewLevel: ActiveViewLevel;
  packageName?: string;
  affectedPackages: string[];
}

/**
 * Resolves target node IDs for `chomp_create_view` combining explicit `highlightNodeIds`
 * with optional `search_term` / `packageName` fast-path filters ([PAT-MCP-08]).
 */
export function resolveViewNodeIds(
  graph: RepresentationGraph | null,
  explicitIds: string[],
  searchTerm?: string,
  packageName?: string
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const id of explicitIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  if (graph && (searchTerm || packageName)) {
    const matches = filterNodesForMcp(graph, {
      searchTerm,
      packageName,
    });
    const visualMatches = matches.filter((n) => !isHiddenNode(n));
    const chosen = visualMatches.length > 0 ? visualMatches : matches;
    for (const node of chosen.slice(0, 40)) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        result.push(node.id);
      }
    }
  }

  return result;
}

/**
 * Determines the topological height (`"system"` Bird's-Eye Macro View vs `"package"`
 * Circuit-Board View) and primary package for `chomp_create_view` ([PAT-MCP-03], [PAT-VIS-28]).
 *
 * - If `explicitViewLevel` is provided (`"system"` or `"package"`), honors it directly.
 * - Otherwise defaults to `"system"` when highlighted nodes span multiple packages (or 0 packages),
 *   and `"package"` when all highlighted nodes reside within a single package.
 */
export function resolveViewTargetAltitude(
  graph: RepresentationGraph | null,
  highlightNodeIds: string[],
  explicitViewLevel?: ActiveViewLevel,
  explicitPackageName?: string
): ResolvedViewTargetAltitude {
  const affectedPackages: string[] = [];
  const seenPkgs = new Set<string>();

  if (graph && highlightNodeIds.length > 0) {
    const index = buildGraphIndex(graph);
    for (const rawId of highlightNodeIds) {
      const baseId = String(rawId).split("::")[0].split("@")[0];
      if (!baseId) continue;
      const pkg = index.resolveNodePkg(baseId);
      if (pkg && !seenPkgs.has(pkg)) {
        seenPkgs.add(pkg);
        affectedPackages.push(pkg);
      }
    }
  }

  let resolvedPkg: string | undefined;
  if (explicitPackageName && explicitPackageName.trim()) {
    const normExplicit = normalizePackageQuery(explicitPackageName);
    const matchedFromGraph = affectedPackages.find(
      (p) => normalizePackageQuery(p) === normExplicit
    );
    resolvedPkg = matchedFromGraph ?? (normExplicit || explicitPackageName.trim());
    if (resolvedPkg && !seenPkgs.has(resolvedPkg)) {
      seenPkgs.add(resolvedPkg);
      affectedPackages.unshift(resolvedPkg);
    }
  } else if (affectedPackages.length === 1) {
    resolvedPkg = affectedPackages[0];
  }

  const viewLevel: ActiveViewLevel =
    explicitViewLevel === "system" || explicitViewLevel === "package"
      ? explicitViewLevel
      : affectedPackages.length === 1
        ? "package"
        : "system";

  const targetPkg =
    viewLevel === "package"
      ? (resolvedPkg ?? affectedPackages[0])
      : resolvedPkg;

  return {
    viewLevel,
    ...(targetPkg ? { packageName: targetPkg } : {}),
    affectedPackages,
  };
}

/**
 * Builds a one-click local deep-link URL for opening the Visualizer directly in
 * Agent Spotlight mode at the selected topological height (`[PAT-MCP-03]`, `[PAT-VIS-28]`).
 */
export function buildActiveViewUrl(options: {
  baseUrl?: string;
  viewLevel: ActiveViewLevel;
  packageName?: string;
}): string {
  const rawBase = (options.baseUrl || "http://localhost:5555")
    .trim()
    .replace(/\/+$/, "");
  const params: string[] = [
    "view=active",
    `level=${encodeURIComponent(options.viewLevel)}`,
  ];
  if (
    options.viewLevel === "package" &&
    options.packageName &&
    options.packageName.trim()
  ) {
    const cleanPkg = encodeURIComponent(options.packageName.trim())
      .replace(/%40/g, "@")
      .replace(/%2F/gi, "/");
    params.push(`pkg=${cleanPkg}`);
  }
  return `${rawBase}/?${params.join("&")}`;
}

/**
 * `chomp_audit_health` implementation ([PAT-MCP-08], [PAT-MCP-09]).
 *
 * Synthesizes system & per-package health metrics, unreachable orphan contracts,
 * dead-end ingress nodes, opaque contract bodies (`astCallCount > 0 && resolvedOutDegree === 0`),
 * inter-package seam & "missing glue" diagnostics (`ISOLATED_DEPLOYMENT_UNITS`,
 * `UNSTITCHED_PROTOCOL_SEAM`, `INIT_BLOCK_CONNECTOR_LEAK`),
 * and unresolved call hotspots framed as Agent-Readiness / Map Visibility opportunities.
 */
export function auditGraphHealth(
  graph: RepresentationGraph,
  options?: {
    packageName?: string;
    limit?: number;
    repoPath?: string;
  }
) {
  const index = buildGraphIndex(graph);
  const maxItems = Math.max(1, Math.min(options?.limit ?? 25, 100));
  const pkgFilter = options?.packageName?.trim();

  const matchesPkg = (nodeId: string): boolean => {
    if (!pkgFilter) return true;
    const pkg = index.resolveNodePkg(nodeId);
    const node = index.nodeById.get(nodeId);
    const ev = node ? getPrimaryEvidence(node) : {};
    return packageMatchesFilter(pkg, ev.filePath, pkgFilter);
  };

  // 1. Reachability from INGRESS & INIT_BLOCK roots (and cross-package entries)
  const entryIds: string[] = [];
  const entrySet = new Set<string>();
  const foldedIds = new Set<string>();

  for (const n of index.nodeById.values()) {
    if (isHiddenNode(n)) continue;
    const outTargets = index.flowOutTargetsBySource.get(n.id) ?? [];
    if (INGRESS_ENTITY_TYPES.has(n.entityType)) {
      if (n.entityType === "NEXTJS_LAYOUT" && outTargets.length === 0) {
        foldedIds.add(n.id);
        continue;
      }
      entrySet.add(n.id);
      entryIds.push(n.id);
    } else if (
      n.entityType === INIT_BLOCK_ENTITY_TYPE &&
      outTargets.length > 0
    ) {
      entrySet.add(n.id);
      entryIds.push(n.id);
    }
  }

  for (const [srcId, tgts] of index.flowOutTargetsBySource.entries()) {
    const srcPkg = index.resolveNodePkg(srcId);
    for (const tgtId of tgts) {
      const tgtPkg = index.resolveNodePkg(tgtId) || srcPkg;
      const tgtNode = index.nodeById.get(tgtId);
      if (srcPkg !== tgtPkg && tgtNode && !isHiddenNode(tgtNode)) {
        if (!entrySet.has(tgtId)) {
          entrySet.add(tgtId);
          entryIds.push(tgtId);
        }
      }
    }
  }

  // Leaf middlewares & presentational components folded by [PAT-VIS-12] / [PAT-VIS-13]
  for (const edge of graph.edges) {
    if (!edge.targetId) continue;
    const tgt = index.nodeById.get(edge.targetId);
    if (!tgt || isHiddenNode(tgt)) continue;
    const tgtOut = index.flowOutTargetsBySource.get(tgt.id)?.length ?? 0;
    if (
      edge.entityType === "INTERCEPTS" &&
      tgt.entityType === "MIDDLEWARE" &&
      tgtOut === 0
    ) {
      foldedIds.add(tgt.id);
    }
    if (edge.entityType === "RENDERS" && tgtOut === 0) {
      foldedIds.add(tgt.id);
    }
  }

  const reachableFromEntry = new Set<string>();
  const queue = [...entryIds];
  for (const id of entryIds) reachableFromEntry.add(id);
  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const tgtId of index.flowOutTargetsBySource.get(curr) ?? []) {
      if (!reachableFromEntry.has(tgtId)) {
        reachableFromEntry.add(tgtId);
        queue.push(tgtId);
      }
    }
  }

  // 2. Dominant canonical repository wiring patterns ([PAT-MCP-09])
  const contractPatternCounts = new Map<string, number>();
  const resolvedEdgePatternCounts = new Map<string, number>();
  for (const n of index.nodeById.values()) {
    if (n.type === "CONTRACT" && n.patternId) {
      contractPatternCounts.set(
        n.patternId,
        (contractPatternCounts.get(n.patternId) ?? 0) + 1
      );
    }
  }
  for (const e of graph.edges) {
    if (e.targetId && e.patternId) {
      resolvedEdgePatternCounts.set(
        e.patternId,
        (resolvedEdgePatternCounts.get(e.patternId) ?? 0) + 1
      );
    }
  }

  const topContractPatterns = [...contractPatternCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([patternId, count]) => ({ patternId, count }));
  const topEdgePatterns = [...resolvedEdgePatternCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([patternId, count]) => ({ patternId, count }));

  // 3. Orphan contracts, Dead-End Ingress, Opaque Contracts, Unresolved Hotspots
  const orphanContractsAll: Array<{
    node: NodeSummaryRef;
    resolvedInDegree: number;
    resolvedOutDegree: number;
    classification:
      | "UNLINKED_IMPORTED_TARGET"
      | "IMPORTED_BUT_NEVER_INVOKED"
      | "DISCONNECTED_SUBTREE_ROOT"
      | "UNREFERENCED_EXPORT";
    unresolvedIncoming?: any[];
    agentReadinessOpportunity: string;
  }> = [];

  const deadEndIngressAll: Array<{
    node: NodeSummaryRef;
    agentReadinessOpportunity: string;
  }> = [];

  const opaqueContractsAll: Array<{
    node: NodeSummaryRef;
    astCallCount: number;
    unresolvedCallCount: number;
    unresolvedCalls: UnresolvedCallDiagnostic[];
    agentReadinessOpportunity: string;
  }> = [];

  const unresolvedHotspotsAll: Array<{
    node: NodeSummaryRef;
    resolvedOutDegree: number;
    unresolvedCount: number;
    unresolvedCalls: UnresolvedCallDiagnostic[];
    agentReadinessOpportunity: string;
  }> = [];

  // v5 Loop 1/3: every signal instance, clustered by deterministic shape key after the scan.
  const signalInstances: SignalInstance[] = [];

  for (const node of index.nodeById.values()) {
    if (isHiddenNode(node)) continue;
    if (!matchesPkg(node.id)) continue;

    const summaryRef = toNodeSummaryRef(node, index.resolveNodePkg);
    const inDeg = index.flowInSourcesByTarget.get(node.id)?.length ?? 0;
    const outDeg = index.flowOutTargetsBySource.get(node.id)?.length ?? 0;
    const unresolved = index.unresolvedCallsByNodeId.get(node.id) ?? [];
    const meta = parseNodeMeta(node);
    const astCallCount =
      typeof meta.astCallCount === "number" ? meta.astCallCount : 0;

    // Dead-End Ingress ([PAT-VIS-07])
    if (
      INGRESS_ENTITY_TYPES.has(node.entityType) &&
      node.entityType !== "NEXTJS_LAYOUT" &&
      outDeg === 0
    ) {
      deadEndIngressAll.push({
        node: summaryRef,
        agentReadinessOpportunity:
          `Entry point '${summaryRef.label}' has 0 resolved outgoing edges on the map. ` +
          `If it delegates to an inline handler or dynamic dispatcher, extract or import a named service/helper contract so agents and the visualizer can trace the full request story.`,
      });
    }

    // Opaque Contracts ([PAT-VIS-15]: astCallCount > 0 && resolvedOutDegree === 0)
    if (
      node.type === "CONTRACT" &&
      !NON_EXECUTABLE_CONTRACT_ENTITY_TYPES.has(node.entityType) &&
      outDeg === 0 &&
      (astCallCount > 0 || unresolved.length > 0) &&
      unresolved.length > 0
    ) {
      opaqueContractsAll.push({
        node: summaryRef,
        astCallCount: Math.max(astCallCount, unresolved.length),
        unresolvedCallCount: unresolved.length,
        unresolvedCalls: unresolved,
        agentReadinessOpportunity:
          `Contract '${summaryRef.label}' executes ${Math.max(astCallCount, unresolved.length)} call(s) in its body but resolves 0 outgoing structural edges (OPAQUE BODY). ` +
          `Aligning its dynamic receiver or callback invocation to direct module imports or factory-typed instances will illuminate its downstream path on the Chomp map. Verify via chomp_get_diff.`,
      });
    }

    // Unresolved Call Hotspots ([PAT-VIS-15], [PAT-MCP-09])
    if (unresolved.length > 0) {
      for (const u of unresolved) {
        signalInstances.push({
          nodeId: node.id,
          name: u.name,
          shapeKey: u.shapeKey,
          signal: u.reason === "opaque-body" ? "OPAQUE_BODY" : "UNRESOLVED_CALL",
          filePath: u.filePath,
          lineNumber: u.lineNumber,
        });
      }
      const sampleNames = unresolved
        .slice(0, 3)
        .map((u) => u.name)
        .join(", ");
      unresolvedHotspotsAll.push({
        node: summaryRef,
        resolvedOutDegree: outDeg,
        unresolvedCount: unresolved.length,
        unresolvedCalls: unresolved,
        agentReadinessOpportunity:
          `Map Visibility Opportunity ([PAT-MCP-09]): '${summaryRef.label}' emits ${unresolved.length} unresolved call(s) (${sampleNames}). ` +
          `This repository's dominant canonical wiring uses direct ES module imports ('relationship.function-call') and factory-returned class methods ('[PAT-EXT-16]'). ` +
          `Replacing bespoke dynamic property lookups or untyped receiver wrappers with canonical named imports/methods will resolve these dangling wires—verify resolution with chomp_get_diff.`,
      });
    }

    // Orphan Contracts ([PAT-VIS-06], [PAT-VIS-14])
    if (
      !reachableFromEntry.has(node.id) &&
      !foldedIds.has(node.id) &&
      !NON_EXECUTABLE_CONTRACT_ENTITY_TYPES.has(node.entityType) &&
      !(node.entityType === "EXPORTED_MODULE" && outDeg === 0)
    ) {
      const unresolvedIncoming = Array.isArray(meta.unresolvedIncoming)
        ? meta.unresolvedIncoming
        : [];
      const activeExpectedCallers = unresolvedIncoming.filter(
        (r: any) => r?.reason !== "imported-but-never-invoked"
      );
      const unusedImportCallers = unresolvedIncoming.filter(
        (r: any) => r?.reason === "imported-but-never-invoked"
      );
      const classification:
        | "UNLINKED_IMPORTED_TARGET"
        | "IMPORTED_BUT_NEVER_INVOKED"
        | "DISCONNECTED_SUBTREE_ROOT"
        | "UNREFERENCED_EXPORT" =
        activeExpectedCallers.length > 0
          ? "UNLINKED_IMPORTED_TARGET"
          : unusedImportCallers.length > 0
            ? "IMPORTED_BUT_NEVER_INVOKED"
            : outDeg > 0
              ? "DISCONNECTED_SUBTREE_ROOT"
              : "UNREFERENCED_EXPORT";
      const orphanEvidence = getPrimaryEvidence(node);
      signalInstances.push({
        nodeId: node.id,
        name: summaryRef.label,
        shapeKey: orphanShapeKey(node),
        signal: "ORPHAN_CONTRACT",
        filePath: orphanEvidence.filePath,
        lineNumber: orphanEvidence.lineNumber,
      });
      orphanContractsAll.push({
        node: summaryRef,
        resolvedInDegree: inDeg,
        resolvedOutDegree: outDeg,
        classification,
        ...(unresolvedIncoming.length > 0 ? { unresolvedIncoming } : {}),
        agentReadinessOpportunity:
          classification === "UNLINKED_IMPORTED_TARGET"
            ? `'${summaryRef.label}' SHOULD BE CONNECTING: it is imported and referenced by ${activeExpectedCallers.length} caller(s) (${activeExpectedCallers.map((c: any) => `${c.callerName} at ${c.filePath}:${c.lineNumber} [${c.usageKind}]`).join(", ")}) with 0 resolved incoming edges (${activeExpectedCallers[0].reason}).`
            : classification === "IMPORTED_BUT_NEVER_INVOKED"
              ? `'${summaryRef.label}' is imported at ${unusedImportCallers.map((c: any) => `${c.filePath}:${c.lineNumber}`).join(", ")}, but has 0 runtime AST invocations in those file(s) (e.g. commented-out call or unused import).`
              : classification === "DISCONNECTED_SUBTREE_ROOT"
                ? `'${summaryRef.label}' calls ${outDeg} downstream contract(s) but has no incoming caller from any INGRESS or INIT_BLOCK entry point. Check if it is invoked via an unmapped dynamic dispatch table/callback or if it is a standalone utility entry.`
                : `'${summaryRef.label}' has 0 incoming callers and is never imported in the repository graph. Verify whether it is an external public SDK export, a newly staged helper awaiting wiring, or an unused export that can be cleaned up.`,
      });
    }
  }

  const orphanPriority: Record<string, number> = {
    UNLINKED_IMPORTED_TARGET: 0,
    IMPORTED_BUT_NEVER_INVOKED: 1,
    DISCONNECTED_SUBTREE_ROOT: 2,
    UNREFERENCED_EXPORT: 3,
  };
  orphanContractsAll.sort(
    (a, b) =>
      (orphanPriority[a.classification] ?? 9) -
      (orphanPriority[b.classification] ?? 9)
  );

  unresolvedHotspotsAll.sort((a, b) => b.unresolvedCount - a.unresolvedCount);

  // 4. Compute System & Per-Package Health Gate Metrics
  const computeMetricsForSlice = (
    nodes: StructuralNode[],
    edges: StructuralEdge[]
  ) => {
    const m = computeStructuralHealthMetrics({ nodes, edges });
    return {
      status: m.status,
      connectivityRate: m.connectivityRate,
      rawConnectivityRate: m.rawConnectivityRate,
      knowableConnectivityRate: m.knowableConnectivityRate,
      unprovableFallbackCount: m.callResolutionCounts.unprovableFallbackCount,
      knowableGapCount: m.callResolutionCounts.knowableGapCount,
      dynamicBoundaryCount: m.callResolutionCounts.dynamicBoundaryCount,
      platformPrimitiveCount: m.callResolutionCounts.platformPrimitiveCount,
      entityTypeCoverage: m.entityTypeCoverage,
      parentCoverage: m.parentCoverage,
      scopePurity: m.scopePurity,
      totalBoundaries: m.entityCounts.boundaries,
      totalContracts: m.entityCounts.contracts,
      totalRelationships: m.entityCounts.relationships,
      totalOpenConnectors: m.entityCounts.openConnectors,
    };
  };

  const systemMetrics = computeMetricsForSlice(graph.nodes, graph.edges);

  // 5. Inter-Package Seam & "Missing Glue" Diagnostics ([PAT-MCP-08], [PAT-MCP-09], [PAT-VIS-15])
  const unstitchedProtocolSeamsAll = detectUnstitchedProtocolSeams(
    graph,
    index,
    {
      packageName: pkgFilter,
      repoPath: options?.repoPath,
    }
  );
  const initBlockConnectorLeaksAll = detectInitBlockConnectorLeaks(
    graph,
    index,
    {
      packageName: pkgFilter,
    }
  );

  // Check if a multi-package workspace (>= 2 DEPLOYMENT_UNITs with contracts) has 0 cross-package links
  let crossPkgFlowEdgeCount = 0;
  for (const edge of graph.edges) {
    if (!edge.targetId) continue;
    if (!FLOW_EDGE_ENTITY_TYPES.has(edge.entityType)) continue;
    const src = index.nodeById.get(edge.sourceId);
    const tgt = index.nodeById.get(edge.targetId);
    if (!src || !tgt || isHiddenNode(src) || isHiddenNode(tgt)) continue;
    const srcPkg = index.resolveNodePkg(src.id);
    const tgtPkg = index.resolveNodePkg(tgt.id);
    if (srcPkg && tgtPkg && srcPkg !== tgtPkg) {
      crossPkgFlowEdgeCount++;
    }
  }

  const activeDuSummaries: Array<{
    packageName: string;
    boundaryId: string;
    packagePath?: string;
    contractCount: number;
  }> = [];
  for (const [pkg, duNode] of index.deploymentUnitsByPkg.entries()) {
    if (
      pkgFilter &&
      !packageMatchesFilter(pkg, index.pathPrefixByPkg.get(pkg), pkgFilter)
    ) {
      continue;
    }
    const contractCount = graph.nodes.filter(
      (n) =>
        n.type === "CONTRACT" &&
        !isHiddenNode(n) &&
        index.resolveNodePkg(n.id) === pkg
    ).length;
    if (contractCount > 0) {
      activeDuSummaries.push({
        packageName: pkg,
        boundaryId: duNode.id,
        packagePath: index.pathPrefixByPkg.get(pkg),
        contractCount,
      });
    }
  }

  const isolatedDiagList: IsolatedDeploymentUnitsDiagnostic[] = [];
  if (activeDuSummaries.length >= 2 && crossPkgFlowEdgeCount === 0) {
    const pkgList = activeDuSummaries.map((p) => p.packageName).join(", ");
    const isoDesc =
      `Multi-package workspace has ${activeDuSummaries.length} DEPLOYMENT_UNIT packages with contracts (${pkgList}) ` +
      `but 0 cross-package structural links (crossPackageLinkCount === 0; all packages are ISOLATED_PACKAGE).`;
    const isoGuidance =
      `Isolated Deployment Units ([PAT-MCP-08], [PAT-MCP-09]): Packages [${pkgList}] have 0 resolved cross-package edges on the map. ` +
      `If they communicate over HTTP/RPC/IPC or workspace barrel re-exports, inspect 'unstitchedProtocolSeams' or configure cross-package client/route conventions in chomp.config.json so the end-to-end inter-package bridge is visible, then verify with chomp_get_diff.`;
    isolatedDiagList.push({
      kind: "ISOLATED_DEPLOYMENT_UNITS",
      ruleId: "ISOLATED_DEPLOYMENT_UNITS",
      severity: "ADVISORY",
      isolatedPackages: activeDuSummaries,
      crossPackageLinkCount: 0,
      description: isoDesc,
      agentReadinessOpportunity: isoGuidance,
      agentReadinessGuidance: isoGuidance,
    });
  }

  const shadowedDbReceptorsAll = detectShadowedDbReceptors(graph, index, {
    packageName: pkgFilter,
  });

  const seamDiagnosticsAll: SeamDiagnostic[] = [
    ...isolatedDiagList,
    ...unstitchedProtocolSeamsAll,
    ...initBlockConnectorLeaksAll,
    ...shadowedDbReceptorsAll,
  ];

  const packageSummaries: Array<Record<string, any>> = [];
  for (const [pkg, duNode] of index.deploymentUnitsByPkg.entries()) {
    if (
      pkgFilter &&
      !packageMatchesFilter(pkg, index.pathPrefixByPkg.get(pkg), pkgFilter)
    ) {
      continue;
    }
    const pkgNodes = graph.nodes.filter(
      (n) => index.resolveNodePkg(n.id) === pkg
    );
    const pkgEdges = graph.edges.filter(
      (e) => index.resolveNodePkg(e.sourceId) === pkg
    );
    const m = computeMetricsForSlice(pkgNodes, pkgEdges);
    const pkgOrphans = orphanContractsAll.filter(
      (o) => o.node.packageName === pkg
    ).length;
    const pkgHotspots = unresolvedHotspotsAll.filter(
      (h) => h.node.packageName === pkg
    );
    const pkgUnresolvedCalls = pkgHotspots.reduce(
      (acc, h) => acc + h.unresolvedCount,
      0
    );
    const pkgProtocolSeams = unstitchedProtocolSeamsAll.filter(
      (s) => s.clientPackage === pkg || s.serverPackage === pkg
    ).length;
    const pkgInitLeaks = initBlockConnectorLeaksAll.filter(
      (l) => l.packageName === pkg
    ).length;
    packageSummaries.push({
      packageName: pkg,
      boundaryId: duNode.id,
      rawName: duNode.name,
      packagePath: index.pathPrefixByPkg.get(pkg),
      ...m,
      orphanContractCount: pkgOrphans,
      unresolvedHotspotCount: pkgHotspots.length,
      unresolvedCallCount: pkgUnresolvedCalls,
      unstitchedProtocolSeamCount: pkgProtocolSeams,
      initBlockConnectorLeakCount: pkgInitLeaks,
    });
  }

  const totalUnresolvedCalls = unresolvedHotspotsAll.reduce(
    (sum, h) => sum + h.unresolvedCount,
    0
  );

  const recommendedHighlightNodeIds: string[] = [];
  for (const h of unresolvedHotspotsAll) {
    if (recommendedHighlightNodeIds.length < 15) {
      recommendedHighlightNodeIds.push(h.node.id);
    }
  }
  for (const seam of unstitchedProtocolSeamsAll) {
    if (
      recommendedHighlightNodeIds.length < 15 &&
      !recommendedHighlightNodeIds.includes(seam.clientConnector.id)
    ) {
      recommendedHighlightNodeIds.push(seam.clientConnector.id);
    }
    for (const r of seam.candidateServerRoutes) {
      if (
        recommendedHighlightNodeIds.length < 15 &&
        !recommendedHighlightNodeIds.includes(r.node.id)
      ) {
        recommendedHighlightNodeIds.push(r.node.id);
      }
    }
  }
  for (const leak of initBlockConnectorLeaksAll) {
    if (
      recommendedHighlightNodeIds.length < 15 &&
      !recommendedHighlightNodeIds.includes(leak.initBlockNode.id)
    ) {
      recommendedHighlightNodeIds.push(leak.initBlockNode.id);
    }
    for (const c of leak.deadEndContracts) {
      if (
        recommendedHighlightNodeIds.length < 15 &&
        !recommendedHighlightNodeIds.includes(c.id)
      ) {
        recommendedHighlightNodeIds.push(c.id);
      }
    }
  }
  for (const d of deadEndIngressAll) {
    if (
      recommendedHighlightNodeIds.length < 15 &&
      !recommendedHighlightNodeIds.includes(d.node.id)
    ) {
      recommendedHighlightNodeIds.push(d.node.id);
    }
  }
  for (const o of orphanContractsAll) {
    if (
      recommendedHighlightNodeIds.length < 15 &&
      !recommendedHighlightNodeIds.includes(o.node.id)
    ) {
      recommendedHighlightNodeIds.push(o.node.id);
    }
  }

  const signalClusterReport = clusterSignalInstances(signalInstances);
  const allDarkFiles = findDarkFiles(graph);
  const darkFiles = pkgFilter
    ? allDarkFiles.filter((fp) => {
        for (const [pkg, prefix] of index.pathPrefixByPkg.entries()) {
          if (packageMatchesFilter(pkg, prefix, pkgFilter)) {
            if (!prefix || prefix === "." || fp.startsWith(`${prefix}/`) || fp === prefix) {
              return true;
            }
          }
        }
        return false;
      })
    : allDarkFiles;

  const fallbackByShape = new Map<string, number>();
  let fallbackTotal = 0;
  for (const e of graph.edges) {
    if (!isUnprovableFallback(e)) continue;
    if (pkgFilter && !matchesPkg(e.sourceId)) continue;
    fallbackTotal++;
    const sk =
      typeof e.metadata?.shapeKey === "string"
        ? e.metadata.shapeKey
        : "unclassified";
    fallbackByShape.set(sk, (fallbackByShape.get(sk) ?? 0) + 1);
  }
  const lowConfidenceFallbacks = {
    totalCount: fallbackTotal,
    byShapeKey: [...fallbackByShape.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxItems)
      .map(([shapeKey, count]) => ({ shapeKey, count })),
  };

  return {
    healthGate: {
      ...systemMetrics,
      orphanContractCount: orphanContractsAll.length,
      unlinkedImportedOrphanCount: orphanContractsAll.filter(
        (o) => o.classification === "UNLINKED_IMPORTED_TARGET"
      ).length,
      importedNeverInvokedOrphanCount: orphanContractsAll.filter(
        (o) => o.classification === "IMPORTED_BUT_NEVER_INVOKED"
      ).length,
      unreferencedExportOrphanCount: orphanContractsAll.filter(
        (o) => o.classification === "UNREFERENCED_EXPORT"
      ).length,
      deadEndIngressCount: deadEndIngressAll.length,
      opaqueContractCount: opaqueContractsAll.length,
      unresolvedHotspotCount: unresolvedHotspotsAll.length,
      totalUnresolvedCalls,
      darkFileCount: darkFiles.length,
      unstitchedProtocolSeamCount: unstitchedProtocolSeamsAll.length,
      initBlockConnectorLeakCount: initBlockConnectorLeaksAll.length,
      seamDiagnosticCount: seamDiagnosticsAll.length,
    },
    packages: packageSummaries,
    /**
     * Candidate pattern classes derived from deterministic shape keys (v5 Loop 1/3). A cluster is
     * a hypothesis about a shared extractor gap, not a verdict: it becomes a ledger row only after
     * a human/AI names and approves it. `unclassified` instances carry no shape key (unknown).
     */
    signalClusters: {
      totalClusters: signalClusterReport.clusters.length,
      clusters: signalClusterReport.clusters.slice(0, maxItems),
      unclassified: signalClusterReport.unclassified,
    },
    lowConfidenceFallbacks,
    darkFiles: darkFiles.slice(0, maxItems),
    canonicalPatterns: {
      topContractPatterns,
      topEdgePatterns,
      note:
        "All diagnostics below are framed as Agent-Readiness / Map Visibility opportunities ([PAT-MCP-09]) to help align bespoke dynamic indirections to the repository's canonical static patterns.",
    },
    unstitchedProtocolSeams: unstitchedProtocolSeamsAll.slice(0, maxItems),
    initBlockConnectorLeaks: initBlockConnectorLeaksAll.slice(0, maxItems),
    seamDiagnostics: seamDiagnosticsAll.slice(0, maxItems),
    unresolvedHotspots: unresolvedHotspotsAll.slice(0, maxItems),
    opaqueContracts: opaqueContractsAll.slice(0, maxItems),
    deadEndIngress: deadEndIngressAll.slice(0, maxItems),
    orphanContracts: orphanContractsAll.slice(0, maxItems),
    recommendedHighlightNodeIds,
  };
}

/**
 * `chomp_find_redundancies` implementation ([PAT-MCP-08], [PAT-MCP-09]).
 *
 * Detects pass-through middlemen, parallel/duplicate story sequences,
 * duplicate contract names across files/packages, and outlier wiring patterns.
 */
export function findGraphRedundancies(
  graph: RepresentationGraph,
  options?: {
    packageName?: string;
    limit?: number;
  }
) {
  const index = buildGraphIndex(graph);
  const maxItems = Math.max(1, Math.min(options?.limit ?? 25, 100));
  const pkgFilter = options?.packageName?.trim();

  const matchesPkg = (nodeId: string): boolean => {
    if (!pkgFilter) return true;
    const pkg = index.resolveNodePkg(nodeId);
    const node = index.nodeById.get(nodeId);
    const ev = node ? getPrimaryEvidence(node) : {};
    return packageMatchesFilter(pkg, ev.filePath, pkgFilter);
  };

  // 1. Pass-Through Middlemen (1-to-1 relay contracts with no side-effects)
  const passThroughMiddlemen: Array<{
    middleman: NodeSummaryRef;
    callers: NodeSummaryRef[];
    singleTarget: NodeSummaryRef;
    crossesPackageBoundary: boolean;
    agentReadinessGuidance: string;
  }> = [];

  for (const node of index.nodeById.values()) {
    if (node.type !== "CONTRACT") continue;
    if (isHiddenNode(node)) continue;
    if (INGRESS_ENTITY_TYPES.has(node.entityType)) continue;
    if (NON_EXECUTABLE_CONTRACT_ENTITY_TYPES.has(node.entityType)) continue;
    if (node.entityType === "EXPORTED_MODULE") continue;
    if (!matchesPkg(node.id)) continue;

    const callers = index.flowInSourcesByTarget.get(node.id) ?? [];
    const targets = index.flowOutTargetsBySource.get(node.id) ?? [];
    const unresolved = index.unresolvedCallsByNodeId.get(node.id) ?? [];

    if (callers.length >= 1 && targets.length === 1 && unresolved.length === 0) {
      const targetNode = index.nodeById.get(targets[0]);
      if (!targetNode || targetNode.type !== "CONTRACT") continue;

      // Ensure no RENDERS composition or OPEN_CONNECTOR side effects
      const rawOutEdges = index.outEdgesBySource.get(node.id) ?? [];
      const hasOpenConnectorCall = rawOutEdges.some((e) => {
        if (!e.targetId) return false;
        const t = index.nodeById.get(e.targetId);
        return (
          t &&
          t.type === "OPEN_CONNECTOR" &&
          !PACKAGE_CONNECTOR_ENTITY_TYPES.has(t.entityType)
        );
      });
      const isRenderRelay = rawOutEdges.some(
        (e) => e.targetId === targetNode.id && e.entityType === "RENDERS"
      );
      if (hasOpenConnectorCall || isRenderRelay) continue;

      const nodeRef = toNodeSummaryRef(node, index.resolveNodePkg);
      const targetRef = toNodeSummaryRef(targetNode, index.resolveNodePkg);
      const callerRefs = callers
        .map((cId) => index.nodeById.get(cId))
        .filter((c): c is StructuralNode => Boolean(c))
        .map((c) => toNodeSummaryRef(c, index.resolveNodePkg));

      const crossesPkg = nodeRef.packageName !== targetRef.packageName;
      passThroughMiddlemen.push({
        middleman: nodeRef,
        callers: callerRefs,
        singleTarget: targetRef,
        crossesPackageBoundary: crossesPkg,
        agentReadinessGuidance: crossesPkg
          ? `'${nodeRef.label}' in '${nodeRef.packageName}' is a 1-to-1 cross-package adapter delegating directly to '${targetRef.label}' in '${targetRef.packageName}'. Keep if it serves as an intentional package boundary facade; otherwise callers can import '${targetRef.label}' directly.`
          : `'${nodeRef.label}' is an intra-package pass-through middleman in '${nodeRef.packageName}' that only forwards to '${targetRef.label}' with no branching or side effects. Consider wiring its ${callerRefs.length} caller(s) directly to '${targetRef.label}' to simplify the execution story.`,
      });
    }
  }

  // 2. Parallel / Duplicate Story Sequences (Contracts invoking the exact same >= 2 downstream target set)
  const callersByCalleeSignature = new Map<string, StructuralNode[]>();
  for (const node of index.nodeById.values()) {
    if (isHiddenNode(node)) continue;
    if (node.entityType === INIT_BLOCK_ENTITY_TYPE) continue;
    const targets = index.flowOutTargetsBySource.get(node.id) ?? [];
    if (targets.length < 2) continue;
    const sortedTargets = [...targets].sort();
    const sig = sortedTargets.join("::");
    let list = callersByCalleeSignature.get(sig);
    if (!list) {
      list = [];
      callersByCalleeSignature.set(sig, list);
    }
    list.push(node);
  }

  const duplicateStorySequences: Array<{
    sharedCalleeCount: number;
    samePackage: boolean;
    parallelCallers: NodeSummaryRef[];
    sharedTargets: NodeSummaryRef[];
    patternAlignmentGuidance: string;
  }> = [];

  for (const [sig, callerNodes] of callersByCalleeSignature.entries()) {
    if (callerNodes.length < 2) continue;
    if (pkgFilter && !callerNodes.some((c) => matchesPkg(c.id))) continue;

    const targetIds = sig.split("::");
    const targetRefs = targetIds
      .map((id) => index.nodeById.get(id))
      .filter((t): t is StructuralNode => Boolean(t))
      .map((t) => toNodeSummaryRef(t, index.resolveNodePkg));
    const callerRefs = callerNodes.map((c) =>
      toNodeSummaryRef(c, index.resolveNodePkg)
    );
    const pkgSet = new Set(callerRefs.map((c) => c.packageName));
    const samePackage = pkgSet.size === 1;
    const targetLabels = targetRefs.map((t) => t.label).join(" -> ");

    duplicateStorySequences.push({
      sharedCalleeCount: targetRefs.length,
      samePackage,
      parallelCallers: callerRefs,
      sharedTargets: targetRefs,
      patternAlignmentGuidance:
        callerRefs.every((c) => INGRESS_ENTITY_TYPES.has(c.entityType))
          ? `Canonical Peer Ingress Pattern: ${callerRefs.length} entry points (${callerRefs.map((c) => c.label).join(", ")}) execute the identical downstream sequence [${targetLabels}]. If shared pre/post-processing grows, consider extracting a shared helper contract.`
          : `${callerRefs.length} contracts (${callerRefs.map((c) => c.label).join(", ")}) invoke the exact same ${targetRefs.length} downstream targets [${targetLabels}]. Check if these parallel orchestrators can be consolidated into a single canonical workflow function.`,
    });
  }

  duplicateStorySequences.sort(
    (a, b) =>
      b.parallelCallers.length * b.sharedCalleeCount -
      a.parallelCallers.length * a.sharedCalleeCount
  );

  // 3. Duplicate Contract Names across multiple files/packages
  const contractsByCleanLabel = new Map<string, StructuralNode[]>();
  const IGNORED_GENERIC_LABELS = new Set([
    "Module Export (Default)",
    "anonymous",
    "default",
    "POST",
    "GET",
    "PUT",
    "DELETE",
    "PATCH",
  ]);

  for (const node of index.nodeById.values()) {
    if (node.type !== "CONTRACT") continue;
    if (isHiddenNode(node)) continue;
    if (NON_EXECUTABLE_CONTRACT_ENTITY_TYPES.has(node.entityType)) continue;
    if (
      node.entityType === "PUBLIC_METHOD" ||
      node.entityType === "NEXTJS_PAGE" ||
      node.entityType === "NEXTJS_LAYOUT" ||
      node.entityType === "HTTP_ENDPOINT" ||
      node.entityType === "API_ENDPOINT"
    ) {
      continue;
    }

    const label = cleanNodeLabel(node.name);
    if (!label || label.length < 3 || IGNORED_GENERIC_LABELS.has(label)) {
      continue;
    }

    let list = contractsByCleanLabel.get(label);
    if (!list) {
      list = [];
      contractsByCleanLabel.set(label, list);
    }
    list.push(node);
  }

  const duplicateSymbols: Array<{
    symbolName: string;
    instanceCount: number;
    crossPackage: boolean;
    instances: NodeSummaryRef[];
    consolidationGuidance: string;
  }> = [];

  for (const [symbolName, nodes] of contractsByCleanLabel.entries()) {
    if (nodes.length < 2) continue;
    if (pkgFilter && !nodes.some((n) => matchesPkg(n.id))) continue;

    const refs = nodes.map((n) => toNodeSummaryRef(n, index.resolveNodePkg));
    const distinctFiles = new Set(refs.map((r) => r.filePath ?? r.id));
    if (distinctFiles.size < 2) continue;

    const distinctPkgs = new Set(refs.map((r) => r.packageName));
    duplicateSymbols.push({
      symbolName,
      instanceCount: refs.length,
      crossPackage: distinctPkgs.size > 1,
      instances: refs,
      consolidationGuidance:
        distinctPkgs.size > 1
          ? `Symbol '${symbolName}' is defined in ${refs.length} places across packages (${[...distinctPkgs].join(", ")}). Consider centralizing shared domain logic into '@chomp/core' or a shared utility module.`
          : `Symbol '${symbolName}' is duplicated across ${refs.length} files within '${[...distinctPkgs][0]}'. Consider consolidating into a single shared module export.`,
    });
  }

  duplicateSymbols.sort((a, b) => b.instanceCount - a.instanceCount);

  // 4. Package Pattern Alignment & Outlier Analysis ([PAT-MCP-09])
  // Group peer INGRESS / API_ENDPOINT contracts per package and compare their target patterns
  const patternAlignmentOpportunities: Array<{
    packageName: string;
    peerGroupType: string;
    dominantPatternDescription: string;
    outlierNode: NodeSummaryRef;
    observedBehavior: string;
    agentReadinessGuidance: string;
  }> = [];

  const ingressByPkgAndType = new Map<string, StructuralNode[]>();
  for (const node of index.nodeById.values()) {
    if (!INGRESS_ENTITY_TYPES.has(node.entityType)) continue;
    const pkg = index.resolveNodePkg(node.id);
    if (!pkg) continue;
    if (pkgFilter && !matchesPkg(node.id)) continue;
    const key = `${pkg}::${node.entityType}`;
    let list = ingressByPkgAndType.get(key);
    if (!list) {
      list = [];
      ingressByPkgAndType.set(key, list);
    }
    list.push(node);
  }

  for (const [key, peers] of ingressByPkgAndType.entries()) {
    if (peers.length < 3) continue;
    const [pkg, entityType] = key.split("::");

    // Determine which downstream target IDs are called by the majority (>= 50%) of peers
    const targetFrequency = new Map<string, number>();
    for (const p of peers) {
      const tgts = index.flowOutTargetsBySource.get(p.id) ?? [];
      for (const tId of tgts) {
        targetFrequency.set(tId, (targetFrequency.get(tId) ?? 0) + 1);
      }
    }

    const canonicalTargetIds = [...targetFrequency.entries()]
      .filter(([, count]) => count >= Math.ceil(peers.length * 0.5))
      .map(([tId]) => tId);

    if (canonicalTargetIds.length === 0) continue;

    const canonicalTargetLabels = canonicalTargetIds
      .map((id) => index.nodeById.get(id))
      .filter((n): n is StructuralNode => Boolean(n))
      .map((n) => cleanNodeLabel(n.name));

    for (const p of peers) {
      const tgts = index.flowOutTargetsBySource.get(p.id) ?? [];
      const usesCanonical = canonicalTargetIds.some((cId) =>
        tgts.includes(cId)
      );
      if (!usesCanonical) {
        const tgtLabels = tgts
          .map((id) => index.nodeById.get(id))
          .filter((n): n is StructuralNode => Boolean(n))
          .map((n) => cleanNodeLabel(n.name));
        const pRef = toNodeSummaryRef(p, index.resolveNodePkg);
        patternAlignmentOpportunities.push({
          packageName: pkg,
          peerGroupType: entityType,
          dominantPatternDescription: `Majority of ${entityType} contracts in '${pkg}' wire through [${canonicalTargetLabels.join(", ")}]`,
          outlierNode: pRef,
          observedBehavior:
            tgtLabels.length > 0
              ? `Wires to [${tgtLabels.join(", ")}] instead of the package's dominant [${canonicalTargetLabels.join(", ")}] pipeline`
              : `Has 0 resolved downstream calls`,
          agentReadinessGuidance:
            `Pattern Alignment Opportunity ([PAT-MCP-09]): '${pRef.label}' deviates from its ${peers.length - 1} sibling ${entityType} contracts in '${pkg}'. ` +
            `If it uses subprocess execution or sidecar files where siblings use direct library/storage contracts, aligning it to the canonical [${canonicalTargetLabels.join(", ")}] pattern improves end-to-end map traceability.`,
        });
      }
    }
  }

  return {
    summary: {
      passThroughMiddlemenCount: passThroughMiddlemen.length,
      duplicateStorySequenceGroups: duplicateStorySequences.length,
      duplicateSymbolCount: duplicateSymbols.length,
      patternAlignmentOpportunityCount: patternAlignmentOpportunities.length,
    },
    passThroughMiddlemen: passThroughMiddlemen.slice(0, maxItems),
    duplicateStorySequences: duplicateStorySequences.slice(0, maxItems),
    duplicateSymbols: duplicateSymbols.slice(0, maxItems),
    patternAlignmentOpportunities: patternAlignmentOpportunities.slice(
      0,
      maxItems
    ),
  };
}

/**
 * `chomp_check_boundaries` implementation ([PAT-MCP-08], [PAT-MCP-09]).
 *
 * Evaluates package dependency directionality, topological tiers,
 * package-level and contract-level circular dependencies, boundary isolation rules,
 * and inter-package seam diagnostics (`ISOLATED_DEPLOYMENT_UNITS`,
 * `UNSTITCHED_PROTOCOL_SEAM`, `INIT_BLOCK_CONNECTOR_LEAK`).
 */
export function checkGraphBoundaries(
  graph: RepresentationGraph,
  options?: {
    packageName?: string;
    repoPath?: string;
  }
) {
  const index = buildGraphIndex(graph);
  const pkgFilter = options?.packageName?.trim();

  // 1. Build cross-package dependency matrix
  interface CrossPkgEdgeDetail {
    sourceNode: NodeSummaryRef;
    targetNode: NodeSummaryRef;
    edgeName: string;
    edgeType: string;
    filePath?: string;
    lineNumber?: number;
  }

  const pairDetails = new Map<string, CrossPkgEdgeDetail[]>();
  const outPkgsByPkg = new Map<string, Set<string>>();
  const inPkgsByPkg = new Map<string, Set<string>>();

  for (const pkg of index.deploymentUnitsByPkg.keys()) {
    outPkgsByPkg.set(pkg, new Set<string>());
    inPkgsByPkg.set(pkg, new Set<string>());
  }

  for (const edge of graph.edges) {
    if (!edge.targetId) continue;
    if (!FLOW_EDGE_ENTITY_TYPES.has(edge.entityType)) continue;
    const src = index.nodeById.get(edge.sourceId);
    const tgt = index.nodeById.get(edge.targetId);
    if (!src || !tgt) continue;
    if (isHiddenNode(src) || isHiddenNode(tgt)) continue;

    const srcPkg = index.resolveNodePkg(src.id);
    const tgtPkg = index.resolveNodePkg(tgt.id);
    if (!srcPkg || !tgtPkg || srcPkg === tgtPkg) continue;

    if (!outPkgsByPkg.has(srcPkg)) outPkgsByPkg.set(srcPkg, new Set());
    if (!inPkgsByPkg.has(tgtPkg)) inPkgsByPkg.set(tgtPkg, new Set());
    outPkgsByPkg.get(srcPkg)!.add(tgtPkg);
    inPkgsByPkg.get(tgtPkg)!.add(srcPkg);

    const key = `${srcPkg}::${tgtPkg}`;
    let list = pairDetails.get(key);
    if (!list) {
      list = [];
      pairDetails.set(key, list);
    }
    const ev = getPrimaryEvidence(edge);
    list.push({
      sourceNode: toNodeSummaryRef(src, index.resolveNodePkg),
      targetNode: toNodeSummaryRef(tgt, index.resolveNodePkg),
      edgeName: edge.name ?? edge.entityType,
      edgeType: edge.entityType,
      filePath: ev.filePath,
      lineNumber: ev.lineNumber,
    });
  }

  // 2. Assign topological architectural tiers to packages
  const packageLayers: Array<{
    packageName: string;
    boundaryId: string;
    packagePath?: string;
    architecturalTier:
      | "ENTRY_APPLICATION"
      | "SERVICE_ORCHESTRATOR"
      | "INFRASTRUCTURE_ADAPTER"
      | "FOUNDATION_CORE"
      | "ISOLATED_PACKAGE";
    tierRank: number;
    dependsOnPackages: string[];
    dependedOnByPackages: string[];
  }> = [];

  const tierRankByPkg = new Map<string, number>();

  for (const [pkg, duNode] of index.deploymentUnitsByPkg.entries()) {
    const outs = [...(outPkgsByPkg.get(pkg) ?? [])].sort();
    const ins = [...(inPkgsByPkg.get(pkg) ?? [])].sort();
    const isAdapterPkg =
      pkg === "db" ||
      pkg.endsWith("-db") ||
      pkg.endsWith("_db") ||
      pkg.includes("adapter");

    let architecturalTier:
      | "ENTRY_APPLICATION"
      | "SERVICE_ORCHESTRATOR"
      | "INFRASTRUCTURE_ADAPTER"
      | "FOUNDATION_CORE"
      | "ISOLATED_PACKAGE";
    let tierRank: number;

    if (outs.length === 0 && ins.length === 0) {
      architecturalTier = "ISOLATED_PACKAGE";
      tierRank = 0;
    } else if (outs.length === 0 && isAdapterPkg && ins.length > 0) {
      architecturalTier = "INFRASTRUCTURE_ADAPTER";
      tierRank = 2;
    } else if (outs.length === 0) {
      architecturalTier = "FOUNDATION_CORE";
      tierRank = 3;
    } else if (ins.length === 0) {
      architecturalTier = "ENTRY_APPLICATION";
      tierRank = 0;
    } else if (
      outs.every((targetPkg) => (outPkgsByPkg.get(targetPkg)?.size ?? 0) === 0) &&
      isAdapterPkg
    ) {
      architecturalTier = "INFRASTRUCTURE_ADAPTER";
      tierRank = 2;
    } else {
      architecturalTier = "SERVICE_ORCHESTRATOR";
      tierRank = 1;
    }

    tierRankByPkg.set(pkg, tierRank);
    if (
      !pkgFilter ||
      packageMatchesFilter(pkg, index.pathPrefixByPkg.get(pkg), pkgFilter)
    ) {
      packageLayers.push({
        packageName: pkg,
        boundaryId: duNode.id,
        packagePath: index.pathPrefixByPkg.get(pkg),
        architecturalTier,
        tierRank,
        dependsOnPackages: outs,
        dependedOnByPackages: ins,
      });
    }
  }

  packageLayers.sort((a, b) => a.tierRank - b.tierRank);

  // 3. Detect Package-Level Circular Dependencies
  const packageCycles: string[][] = [];
  const seenPkgCycleSigs = new Set<string>();
  for (const startPkg of index.deploymentUnitsByPkg.keys()) {
    const dfsPkg = (curr: string, path: string[], visited: Set<string>) => {
      for (const next of outPkgsByPkg.get(curr) ?? []) {
        if (next === startPkg && path.length >= 2) {
          const minIdx = path.reduce(
            (best, item, idx) => (item < path[best] ? idx : best),
            0
          );
          const canonical = [
            ...path.slice(minIdx),
            ...path.slice(0, minIdx),
          ].join(" -> ");
          if (!seenPkgCycleSigs.has(canonical)) {
            seenPkgCycleSigs.add(canonical);
            packageCycles.push([...path, startPkg]);
          }
        } else if (!visited.has(next)) {
          visited.add(next);
          dfsPkg(next, [...path, next], visited);
          visited.delete(next);
        }
      }
    };
    dfsPkg(startPkg, [startPkg], new Set([startPkg]));
  }

  // 4. Detect Contract-Level Circular Dependencies & Self-Loops ([PAT-VIS-08])
  const selfLoops: Array<{
    node: NodeSummaryRef;
    edgeName: string;
    filePath?: string;
    lineNumber?: number;
  }> = [];

  for (const edge of graph.edges) {
    if (
      edge.targetId &&
      edge.sourceId === edge.targetId &&
      FLOW_EDGE_ENTITY_TYPES.has(edge.entityType)
    ) {
      const node = index.nodeById.get(edge.sourceId);
      if (node && !isHiddenNode(node)) {
        const ev = getPrimaryEvidence(edge);
        selfLoops.push({
          node: toNodeSummaryRef(node, index.resolveNodePkg),
          edgeName: edge.name ?? edge.entityType,
          filePath: ev.filePath,
          lineNumber: ev.lineNumber,
        });
      }
    }
  }

  const contractCycles: Array<{
    cycleLength: number;
    nodes: NodeSummaryRef[];
  }> = [];
  const seenContractCycleSigs = new Set<string>();
  const globalVisited = new Set<string>();

  for (const nodeId of index.flowOutTargetsBySource.keys()) {
    if (globalVisited.has(nodeId) || contractCycles.length >= 20) continue;
    const stackSet = new Set<string>();
    const pathIds: string[] = [];

    const dfsContract = (currId: string) => {
      if (contractCycles.length >= 20) return;
      globalVisited.add(currId);
      stackSet.add(currId);
      pathIds.push(currId);

      for (const nextId of index.flowOutTargetsBySource.get(currId) ?? []) {
        if (nextId === currId) continue;
        if (stackSet.has(nextId)) {
          const cycleStart = pathIds.indexOf(nextId);
          if (cycleStart >= 0) {
            const cycleSlice = pathIds.slice(cycleStart);
            const minIdx = cycleSlice.reduce(
              (best, item, idx) => (item < cycleSlice[best] ? idx : best),
              0
            );
            const canonical = [
              ...cycleSlice.slice(minIdx),
              ...cycleSlice.slice(0, minIdx),
            ].join("::");
            if (!seenContractCycleSigs.has(canonical)) {
              seenContractCycleSigs.add(canonical);
              const cycleRefs = [...cycleSlice, nextId]
                .map((id) => index.nodeById.get(id))
                .filter((n): n is StructuralNode => Boolean(n))
                .map((n) => toNodeSummaryRef(n, index.resolveNodePkg));
              contractCycles.push({
                cycleLength: cycleSlice.length,
                nodes: cycleRefs,
              });
            }
          }
        } else if (!globalVisited.has(nextId)) {
          dfsContract(nextId);
        }
      }

      pathIds.pop();
      stackSet.delete(currId);
    };

    dfsContract(nodeId);
  }

  // 5. Check Boundary Isolation & Layer Directionality Rules
  const boundaryViolations: Array<{
    ruleId: string;
    severity: "VIOLATION" | "ADVISORY";
    sourcePackage: string;
    targetPackage: string;
    description: string;
    evidence: CrossPkgEdgeDetail[];
    agentReadinessGuidance: string;
  }> = [];

  for (const [pairKey, details] of pairDetails.entries()) {
    const [srcPkg, tgtPkg] = pairKey.split("::");
    if (
      pkgFilter &&
      !packageMatchesFilter(srcPkg, undefined, pkgFilter) &&
      !packageMatchesFilter(tgtPkg, undefined, pkgFilter)
    ) {
      continue;
    }

    const srcRank = tierRankByPkg.get(srcPkg) ?? 0;
    const tgtRank = tierRankByPkg.get(tgtPkg) ?? 0;

    // Rule 1: Core DB Isolation (AGENTS.md §9.1: @chomp/core must have ZERO database imports)
    if (srcPkg === "core" && tgtPkg === "db") {
      boundaryViolations.push({
        ruleId: "BOUNDARY-CORE-DB-ISOLATION",
        severity: "VIOLATION",
        sourcePackage: srcPkg,
        targetPackage: tgtPkg,
        description: `'@chomp/core' has ${details.length} direct structural dependency edge(s) into '@chomp/db'. Core must remain 100% persistence-agnostic.`,
        evidence: details.slice(0, 5),
        agentReadinessGuidance:
          "Move database persistence calls out of '@chomp/core' into '@chomp/db' or the calling orchestrator ('@chomp/cli' / '@chomp/mcp').",
      });
    } else if (srcRank > tgtRank) {
      // Lower/foundational layer calling upward into a higher application/service layer
      boundaryViolations.push({
        ruleId: "BOUNDARY-UPWARD-LAYER-CALL",
        severity: "VIOLATION",
        sourcePackage: srcPkg,
        targetPackage: tgtPkg,
        description: `Lower-tier package '${srcPkg}' (tierRank ${srcRank}) depends upward on higher-tier package '${tgtPkg}' (tierRank ${tgtRank}).`,
        evidence: details.slice(0, 5),
        agentReadinessGuidance:
          `Invert the dependency between '${srcPkg}' and '${tgtPkg}' by moving shared contracts to a lower foundational package or passing callbacks/interfaces.`,
      });
    }

    // Check if cross-package call reaches past barrel index.ts into deep internal implementation files
    const deepInternalCalls = details.filter((d) => {
      const fp = d.targetNode.filePath;
      if (!fp) return false;
      // If a package has a src/index.ts barrel, check if target is in a nested subfolder (e.g. src/extractor/visitors/...)
      const relInSrc = fp.split("/src/")[1] ?? "";
      return relInSrc.includes("/") && !relInSrc.startsWith("adapters/");
    });

    if (deepInternalCalls.length > 0 && srcPkg !== tgtPkg) {
      const distinctTargets = new Map<string, CrossPkgEdgeDetail>();
      for (const d of deepInternalCalls) {
        if (!distinctTargets.has(d.targetNode.id)) {
          distinctTargets.set(d.targetNode.id, d);
        }
      }
      boundaryViolations.push({
        ruleId: "BOUNDARY-DEEP-SUBMODULE-TARGET",
        severity: "ADVISORY",
        sourcePackage: srcPkg,
        targetPackage: tgtPkg,
        description: `'${srcPkg}' resolves to ${distinctTargets.size} contract(s) declared inside nested internal modules of '${tgtPkg}' (${[...distinctTargets.values()].map((d) => d.targetNode.label).slice(0, 4).join(", ")}).`,
        evidence: [...distinctTargets.values()].slice(0, 5),
        agentReadinessGuidance:
          `Verify that these target contracts remain re-exported via '${tgtPkg}/src/index.ts' so cross-package consumers rely only on '${tgtPkg}'s public barrel contract surface.`,
      });
    }
  }

  const packageDependencies = [...pairDetails.entries()]
    .filter(([pairKey]) => {
      if (!pkgFilter) return true;
      const [s, t] = pairKey.split("::");
      return (
        packageMatchesFilter(s, undefined, pkgFilter) ||
        packageMatchesFilter(t, undefined, pkgFilter)
      );
    })
    .map(([pairKey, details]) => {
      const [sourcePackage, targetPackage] = pairKey.split("::");
      const distinctTargets = new Set(details.map((d) => d.targetNode.id));
      return {
        sourcePackage,
        targetPackage,
        edgeCount: details.length,
        distinctTargetContracts: distinctTargets.size,
        sampleEdges: details.slice(0, 5),
      };
    });

  // 6. Inter-Package Seam & "Missing Glue" Diagnostics ([PAT-MCP-08], [PAT-MCP-09], [PAT-VIS-15])
  const contractsCountByPkg = new Map<string, number>();
  for (const n of index.nodeById.values()) {
    if (n.type !== "CONTRACT" || isHiddenNode(n)) continue;
    const pkg = index.resolveNodePkg(n.id);
    if (!pkg) continue;
    contractsCountByPkg.set(pkg, (contractsCountByPkg.get(pkg) ?? 0) + 1);
  }

  const activePackageLayers = packageLayers.filter(
    (p) => (contractsCountByPkg.get(p.packageName) ?? 0) > 0
  );

  const seamDiagnostics: SeamDiagnostic[] = [];

  // 6a. Isolated Package Anomaly (`ISOLATED_DEPLOYMENT_UNITS`):
  // Never report status: "CLEAN" when a multi-package workspace (>= 2 DEPLOYMENT_UNITs with contracts)
  // has crossPackageLinkCount === 0 and all packages are classified as ISOLATED_PACKAGE.
  if (
    activePackageLayers.length >= 2 &&
    packageDependencies.length === 0 &&
    activePackageLayers.every((p) => p.architecturalTier === "ISOLATED_PACKAGE")
  ) {
    const pkgList = activePackageLayers.map((p) => p.packageName).join(", ");
    const isoDesc =
      `Multi-package workspace has ${activePackageLayers.length} DEPLOYMENT_UNIT packages with contracts (${pkgList}) ` +
      `but 0 cross-package structural links (crossPackageLinkCount === 0; all packages are ISOLATED_PACKAGE).`;
    const isoGuidance =
      `Isolated Deployment Units ([PAT-MCP-08], [PAT-MCP-09]): Packages [${pkgList}] have 0 resolved cross-package edges on the map. ` +
      `If they communicate over HTTP/RPC/IPC or workspace barrel re-exports, inspect 'unstitchedProtocolSeams' or configure cross-package client/route conventions in chomp.config.json so the end-to-end inter-package bridge is visible, then verify with chomp_get_diff.`;
    const isoDiag: IsolatedDeploymentUnitsDiagnostic = {
      kind: "ISOLATED_DEPLOYMENT_UNITS",
      ruleId: "ISOLATED_DEPLOYMENT_UNITS",
      severity: "ADVISORY",
      isolatedPackages: activePackageLayers.map((p) => ({
        packageName: p.packageName,
        boundaryId: p.boundaryId,
        packagePath: p.packagePath,
        contractCount: contractsCountByPkg.get(p.packageName) ?? 0,
      })),
      crossPackageLinkCount: 0,
      description: isoDesc,
      agentReadinessOpportunity: isoGuidance,
      agentReadinessGuidance: isoGuidance,
    };
    seamDiagnostics.push(isoDiag);
    boundaryViolations.push({
      ruleId: "ISOLATED_DEPLOYMENT_UNITS",
      severity: "ADVISORY",
      sourcePackage: activePackageLayers[0].packageName,
      targetPackage: activePackageLayers
        .slice(1)
        .map((p) => p.packageName)
        .join(", "),
      description: isoDesc,
      evidence: [],
      agentReadinessGuidance: isoGuidance,
    });
  }

  // 6b. Unstitched Protocol / HTTP Seam Pairing (`UNSTITCHED_PROTOCOL_SEAM`)
  const unstitchedProtocolSeams = detectUnstitchedProtocolSeams(graph, index, {
    packageName: pkgFilter,
    repoPath: options?.repoPath,
  });
  for (const seam of unstitchedProtocolSeams) {
    seamDiagnostics.push(seam);
    const sampleSource = seam.clientCallers[0] ?? seam.clientConnector;
    const sampleEvidence: CrossPkgEdgeDetail[] = seam.candidateServerRoutes
      .slice(0, 5)
      .map((route) => ({
        sourceNode: sampleSource,
        targetNode: route.node,
        edgeName: `Unstitched HTTP Seam: ${seam.clientUrlPattern} -> ${route.httpMethod} ${route.effectivePath}`,
        edgeType: "UNSTITCHED_HTTP_SEAM",
        filePath: seam.clientConnector.filePath ?? sampleSource.filePath,
        lineNumber: seam.clientConnector.lineNumber ?? sampleSource.lineNumber,
      }));
    boundaryViolations.push({
      ruleId: "UNSTITCHED_PROTOCOL_SEAM",
      severity: "ADVISORY",
      sourcePackage: seam.clientPackage,
      targetPackage: seam.serverPackage,
      description: seam.description,
      evidence: sampleEvidence,
      agentReadinessGuidance: seam.agentReadinessGuidance,
    });
  }

  // 6c. INIT_BLOCK Gravity Leak Detection (`INIT_BLOCK_CONNECTOR_LEAK`)
  const initBlockConnectorLeaks = detectInitBlockConnectorLeaks(graph, index, {
    packageName: pkgFilter,
  });
  for (const leak of initBlockConnectorLeaks) {
    seamDiagnostics.push(leak);
    const sampleEvidence: CrossPkgEdgeDetail[] = leak.leakedConnectors
      .slice(0, 5)
      .map((conn) => ({
        sourceNode: leak.initBlockNode,
        targetNode: conn,
        edgeName: `Leaked Connector Edge: ${leak.initBlockNode.label} -> ${conn.label}`,
        edgeType: conn.entityType,
        filePath: leak.affectedFiles[0] ?? conn.filePath,
        lineNumber: conn.lineNumber,
      }));
    boundaryViolations.push({
      ruleId: "INIT_BLOCK_CONNECTOR_LEAK",
      severity: "ADVISORY",
      sourcePackage: leak.packageName,
      targetPackage: leak.packageName,
      description: leak.description,
      evidence: sampleEvidence,
      agentReadinessGuidance: leak.agentReadinessGuidance,
    });
  }

  // 6d. Shadowed Database Receptor Detection (`SHADOWED_DB_RECEPTOR`)
  const shadowedDbReceptors = detectShadowedDbReceptors(graph, index, {
    packageName: pkgFilter,
  });
  for (const shadowed of shadowedDbReceptors) {
    seamDiagnostics.push(shadowed);
    const sampleEvidence: CrossPkgEdgeDetail[] = shadowed.shadowedCallers
      .slice(0, 5)
      .map((caller) => ({
        sourceNode: caller,
        targetNode: shadowed.driverPackageNode,
        edgeName: `Shadowed DB Call: ${caller.label} -> ${shadowed.driverPackageNode.label}`,
        edgeType: "CALL",
        filePath: caller.filePath,
        lineNumber: caller.lineNumber,
      }));
    boundaryViolations.push({
      ruleId: "SHADOWED_DB_RECEPTOR",
      severity: "ADVISORY",
      sourcePackage: shadowed.packageName,
      targetPackage: shadowed.expectedReceptorLabel,
      description: shadowed.description,
      evidence: sampleEvidence,
      agentReadinessGuidance: shadowed.agentReadinessGuidance,
    });
  }

  const hasHardViolations =
    packageCycles.length > 0 ||
    boundaryViolations.some((v) => v.severity === "VIOLATION");

  return {
    status: hasHardViolations
      ? ("VIOLATION" as const)
      : boundaryViolations.length > 0 || contractCycles.length > 0
        ? ("ADVISORY" as const)
        : ("CLEAN" as const),
    summary: {
      packageCount: packageLayers.length,
      crossPackageLinkCount: packageDependencies.length,
      isolatedPackageCount: packageLayers.filter(
        (p) => p.architecturalTier === "ISOLATED_PACKAGE"
      ).length,
      packageCycleCount: packageCycles.length,
      contractCycleCount: contractCycles.length,
      selfLoopCount: selfLoops.length,
      boundaryViolationCount: boundaryViolations.filter(
        (v) => v.severity === "VIOLATION"
      ).length,
      boundaryAdvisoryCount: boundaryViolations.filter(
        (v) => v.severity === "ADVISORY"
      ).length,
      unstitchedProtocolSeamCount: unstitchedProtocolSeams.length,
      initBlockConnectorLeakCount: initBlockConnectorLeaks.length,
      seamDiagnosticCount: seamDiagnostics.length,
    },
    packageLayers,
    packageDependencies,
    circularDependencies: {
      packageCycles,
      contractCycles,
      selfLoops,
    },
    boundaryViolations,
    unstitchedProtocolSeams,
    initBlockConnectorLeaks,
    seamDiagnostics,
  };
}

/**
 * `chomp_get_blast_radius` implementation ([PAT-MCP-08], [PAT-MCP-09]).
 *
 * Computes the upstream caller tree, downstream dependency tree, external side-effects,
 * affected INGRESS entry points, affected packages, Port Valve schemas, and
 * `highlightNodeIds` for pre-edit impact analysis.
 */
export function computeBlastRadius(
  graph: RepresentationGraph,
  options: {
    nodeId?: string;
    nodeIds?: string[];
    searchTerm?: string;
    packageName?: string;
    maxDepth?: number;
    overlays?: ReadonlyArray<PortOverlayLike & { entityId: string }>;
  },
  overlaysArg?: ReadonlyArray<PortOverlayLike & { entityId: string }>
) {
  const index = buildGraphIndex(graph);
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 4, 10));
  const allPortOverlays = overlaysArg ?? options.overlays;
  const overlaysByEntityId = new Map<string, PortOverlayLike[]>();
  if (allPortOverlays && allPortOverlays.length > 0) {
    for (const ov of allPortOverlays) {
      if (!ov || !ov.entityId) continue;
      let list = overlaysByEntityId.get(ov.entityId);
      if (!list) {
        list = [];
        overlaysByEntityId.set(ov.entityId, list);
      }
      list.push(ov);
    }
  }

  // 1. Resolve starting target node(s)
  const seedNodes: StructuralNode[] = [];
  const seedIdSet = new Set<string>();

  const addSeedNode = (node: StructuralNode | undefined) => {
    if (!node || seedIdSet.has(node.id)) return;
    seedIdSet.add(node.id);
    seedNodes.push(node);

    // If a CLASS or NAMESPACE boundary is targeted, include its child PUBLIC_METHOD / CONTRACT nodes
    // so callers of the class's methods are captured in the blast radius
    if (
      node.type === "BOUNDARY" &&
      (node.entityType === "CLASS" || node.entityType === "NAMESPACE")
    ) {
      for (const candidate of index.nodeById.values()) {
        if (candidate.parentBoundaryId === node.id && !seedIdSet.has(candidate.id)) {
          seedIdSet.add(candidate.id);
          seedNodes.push(candidate);
        }
      }
    }
  };

  if (options.nodeId) {
    addSeedNode(index.nodeById.get(options.nodeId));
  }
  if (options.nodeIds && options.nodeIds.length > 0) {
    for (const id of options.nodeIds) {
      addSeedNode(index.nodeById.get(id));
    }
  }
  if (seedNodes.length === 0 && (options.searchTerm || options.packageName)) {
    const matched = filterNodesForMcp(graph, {
      searchTerm: options.searchTerm,
      packageName: options.packageName,
    }).filter((n) => !isHiddenNode(n));
    for (const m of matched.slice(0, 10)) {
      addSeedNode(m);
    }
  }

  if (seedNodes.length === 0) {
    return {
      found: false,
      message:
        "No matching target nodes found. Pass a valid `node_id` or `search_term` (from `chomp_get_nodes`).",
      targetNodes: [],
      portValves: [],
      upstreamCallers: [],
      downstreamDependencies: [],
      externalSideEffects: [],
      affectedEntryPoints: [],
      affectedPackages: [],
      highlightNodeIds: [],
      preEditGuidance: [],
    };
  }

  const targetRefs = seedNodes.map((n) =>
    toNodeSummaryRef(n, index.resolveNodePkg)
  );
  const targetPkgs = new Set(targetRefs.map((t) => t.packageName));

  // Extract Port Valves ([PAT-VIS-14]) on target nodes (Speed 1 AST + Speed 2 L1_PORTS cache)
  const portValves: Array<
    ContractPortValves & {
      nodeId: string;
      label: string;
    }
  > = [];
  for (const n of seedNodes) {
    const meta = parseNodeMeta(n);
    const merged = mergeContractPortValves(
      meta as any,
      overlaysByEntityId.get(n.id)
    );
    if (!merged) continue;
    const hasMeaningfulValve =
      (merged.inputTypes && merged.inputTypes.length > 0) ||
      Boolean(merged.outputType) ||
      (merged.inputs && merged.inputs.length > 0) ||
      Boolean(merged.output) ||
      Boolean(merged.zeroInputs) ||
      (merged.diagnostics && merged.diagnostics.length > 0);
    if (!hasMeaningfulValve) continue;
    portValves.push({
      nodeId: n.id,
      label: cleanNodeLabel(n.name),
      ...merged,
    });
  }

  // 2. Upstream BFS (Who calls/depends on the target?)
  interface ImpactHop {
    depth: number;
    node: NodeSummaryRef;
    viaEdgeName: string;
    viaEdgeType: string;
    fromOrToNodeId: string;
    crossesPackageBoundary: boolean;
    isIngressEntry: boolean;
  }

  const upstreamCallers: ImpactHop[] = [];
  const upstreamVisited = new Set<string>(seedIdSet);
  const upstreamQueue: Array<{ id: string; depth: number }> = seedNodes.map(
    (n) => ({ id: n.id, depth: 0 })
  );

  while (upstreamQueue.length > 0) {
    const { id: currId, depth } = upstreamQueue.shift()!;
    if (depth >= maxDepth) continue;
    const currPkg = index.resolveNodePkg(currId);

    const inEdges = index.inEdgesByTarget.get(currId) ?? [];
    for (const edge of inEdges) {
      if (!FLOW_EDGE_ENTITY_TYPES.has(edge.entityType)) continue;
      const caller = index.nodeById.get(edge.sourceId);
      if (!caller || isHiddenNode(caller)) continue;
      if (upstreamVisited.has(caller.id)) continue;

      upstreamVisited.add(caller.id);
      const callerRef = toNodeSummaryRef(caller, index.resolveNodePkg);
      const isIngress =
        INGRESS_ENTITY_TYPES.has(caller.entityType) ||
        caller.entityType === INIT_BLOCK_ENTITY_TYPE;

      upstreamCallers.push({
        depth: depth + 1,
        node: callerRef,
        viaEdgeName: edge.name ?? edge.entityType,
        viaEdgeType: edge.entityType,
        fromOrToNodeId: currId,
        crossesPackageBoundary: Boolean(
          currPkg && callerRef.packageName && currPkg !== callerRef.packageName
        ),
        isIngressEntry: isIngress,
      });

      upstreamQueue.push({ id: caller.id, depth: depth + 1 });
    }
  }

  // 3. Downstream BFS (What does the target call or mutate?)
  const downstreamDependencies: ImpactHop[] = [];
  const externalSideEffects: Array<{
    depth: number;
    connector: NodeSummaryRef;
    calledFromNodeId: string;
    edgeName: string;
  }> = [];
  const downstreamVisited = new Set<string>(seedIdSet);
  const downstreamQueue: Array<{ id: string; depth: number }> = seedNodes.map(
    (n) => ({ id: n.id, depth: 0 })
  );

  while (downstreamQueue.length > 0) {
    const { id: currId, depth } = downstreamQueue.shift()!;
    if (depth >= maxDepth) continue;
    const currPkg = index.resolveNodePkg(currId);

    const outEdges = index.outEdgesBySource.get(currId) ?? [];
    for (const edge of outEdges) {
      if (!edge.targetId) continue;
      if (!FLOW_EDGE_ENTITY_TYPES.has(edge.entityType)) continue;
      const callee = index.nodeById.get(edge.targetId);
      if (!callee || isHiddenNode(callee)) continue;

      if (callee.type === "OPEN_CONNECTOR") {
        if (!downstreamVisited.has(callee.id)) {
          downstreamVisited.add(callee.id);
          externalSideEffects.push({
            depth: depth + 1,
            connector: toNodeSummaryRef(callee, index.resolveNodePkg),
            calledFromNodeId: currId,
            edgeName: edge.name ?? edge.entityType,
          });
        }
        continue;
      }

      if (downstreamVisited.has(callee.id)) continue;
      downstreamVisited.add(callee.id);

      const calleeRef = toNodeSummaryRef(callee, index.resolveNodePkg);
      downstreamDependencies.push({
        depth: depth + 1,
        node: calleeRef,
        viaEdgeName: edge.name ?? edge.entityType,
        viaEdgeType: edge.entityType,
        fromOrToNodeId: currId,
        crossesPackageBoundary: Boolean(
          currPkg && calleeRef.packageName && currPkg !== calleeRef.packageName
        ),
        isIngressEntry: INGRESS_ENTITY_TYPES.has(callee.entityType),
      });

      downstreamQueue.push({ id: callee.id, depth: depth + 1 });
    }
  }

  // 4. Affected Entry Points & Affected Packages
  const affectedEntryPoints: NodeSummaryRef[] = [];
  const seenEntries = new Set<string>();
  for (const t of targetRefs) {
    if (
      (INGRESS_ENTITY_TYPES.has(t.entityType) ||
        t.entityType === INIT_BLOCK_ENTITY_TYPE) &&
      !seenEntries.has(t.id)
    ) {
      seenEntries.add(t.id);
      affectedEntryPoints.push(t);
    }
  }
  for (const u of upstreamCallers) {
    if (u.isIngressEntry && !seenEntries.has(u.node.id)) {
      seenEntries.add(u.node.id);
      affectedEntryPoints.push(u.node);
    }
  }

  const affectedPackagesSet = new Set<string>(targetPkgs);
  for (const u of upstreamCallers) {
    if (u.node.packageName) affectedPackagesSet.add(u.node.packageName);
  }
  const affectedPackages = [...affectedPackagesSet].sort();

  const directCallers = upstreamCallers.filter((u) => u.depth === 1);
  const crossPkgCallers = upstreamCallers.filter(
    (u) => u.crossesPackageBoundary
  );

  let riskLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";
  if (
    upstreamCallers.length > 8 ||
    affectedPackages.length >= 3 ||
    crossPkgCallers.length >= 3
  ) {
    riskLevel = "HIGH";
  } else if (
    upstreamCallers.length >= 3 ||
    affectedPackages.length >= 2 ||
    affectedEntryPoints.length >= 2
  ) {
    riskLevel = "MEDIUM";
  }

  const highlightNodeIds: string[] = [];
  const addHighlight = (id: string) => {
    if (id && !highlightNodeIds.includes(id) && highlightNodeIds.length < 50) {
      highlightNodeIds.push(id);
    }
  };
  for (const t of targetRefs) addHighlight(t.id);
  for (const u of upstreamCallers) addHighlight(u.node.id);
  for (const d of downstreamDependencies) addHighlight(d.node.id);
  for (const s of externalSideEffects) addHighlight(s.connector.id);

  // Collect active Port Valve mismatch diagnostics on targets AND incoming direct callers
  const portDiagnosticsSummary: Array<{
    ownerNodeId: string;
    ownerLabel: string;
    diagnostic: PortDiagnostic;
  }> = [];
  for (const pv of portValves) {
    for (const d of pv.diagnostics ?? []) {
      portDiagnosticsSummary.push({
        ownerNodeId: pv.nodeId,
        ownerLabel: pv.label,
        diagnostic: d,
      });
    }
  }
  for (const caller of directCallers) {
    const callerOvs = overlaysByEntityId.get(caller.node.id);
    if (!callerOvs) continue;
    const callerNode = index.nodeById.get(caller.node.id);
    const callerPv = mergeContractPortValves(
      callerNode ? (parseNodeMeta(callerNode) as any) : undefined,
      callerOvs
    );
    for (const d of callerPv?.diagnostics ?? []) {
      if (d.peerEntityId && seedIdSet.has(d.peerEntityId)) {
        portDiagnosticsSummary.push({
          ownerNodeId: caller.node.id,
          ownerLabel: caller.node.label,
          diagnostic: d,
        });
      }
    }
  }

  const preEditGuidance: string[] = [
    `1. Active View Highlight: Pass 'highlightNodeIds' (${highlightNodeIds.length} nodes) to 'chomp_create_view' (or pass create_view: true) so the user's visualizer illuminates this blast radius immediately.`,
    directCallers.length > 0
      ? `2. Signature Compatibility: ${directCallers.length} direct caller(s) (${directCallers.map((c) => `${c.node.packageName}:${c.node.label}`).slice(0, 5).join(", ")}) invoke the target directly. Preserve parameter/return types (${portValves.map((v) => `${v.label}: (${v.inputs?.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ") ?? (v.inputTypes ?? []).join(", ")}) => ${v.output?.type ?? v.outputType ?? "void"}`).join("; ") || "check caller call-sites"}) or update all callers in lockstep.`
      : `2. Leaf / Entry Target: Target has 0 direct callers in the graph; signature changes will not break upstream contracts.`,
    `3. Post-Edit Verification: After editing, run 'chomp_get_diff' to confirm that only the intended nodes in [${affectedPackages.join(", ")}] are MODIFIED/ADDED and no unintended edges were dropped.`,
  ];
  if (portDiagnosticsSummary.length > 0) {
    preEditGuidance.push(
      `4. Port Valve Mismatches (${portDiagnosticsSummary.length}): ${portDiagnosticsSummary
        .slice(0, 4)
        .map(
          (m) =>
            `${m.ownerLabel} (${m.diagnostic.filePath ?? ""}${m.diagnostic.lineNumber ? `:${m.diagnostic.lineNumber}` : ""}) [${m.diagnostic.kind}${m.diagnostic.tsCode ? ` TS${m.diagnostic.tsCode}` : ""}]: ${m.diagnostic.message}`
        )
        .join(" | ")}`
    );
  }

  return {
    found: true,
    summary: {
      riskLevel,
      targetCount: targetRefs.length,
      directUpstreamCallerCount: directCallers.length,
      totalUpstreamCallerCount: upstreamCallers.length,
      crossPackageCallerCount: crossPkgCallers.length,
      downstreamDependencyCount: downstreamDependencies.length,
      externalSideEffectCount: externalSideEffects.length,
      affectedEntryPointCount: affectedEntryPoints.length,
      portMismatchCount: portDiagnosticsSummary.length,
      affectedPackages,
    },
    targetNodes: targetRefs,
    portValves,
    affectedEntryPoints,
    upstreamCallers,
    downstreamDependencies,
    externalSideEffects,
    highlightNodeIds,
    preEditGuidance,
  };
}
