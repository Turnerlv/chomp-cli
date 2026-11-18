/**
 * packages/cli/src/visualizer/cloudLayoutClient.ts
 *
 * Stateless Skeleton-to-Coordinates Client & Server Pipeline (`api.getchomp.dev`).
 *
 * Architecture:
 *   1. Local CLI (`chomp ui`) holds `.chomp/graph.db` and `.chomp/rules.json` 100% locally.
 *   2. Before calling the remote Cloudflare Worker (`POST /v1/layout`), `anonymizeGraphForCloudLayout`
 *      strips all code snippets, business symbol names, and file paths — replacing them with
 *      deterministic, role- and length-preserving pseudonyms while pre-evaluating custom rules locally.
 *   3. The stateless Cloudflare Worker executes `executeStatelessLayout` (`1-storyTracer` ->
 *      `2-zipMerge` -> `3-gridMapper` -> `visualLinter`) in memory with zero persistence.
 *   4. `rehydrateCloudLayout` restores the user's real labels, relative `filePath:lineNumber`
 *      evidence (without code snippets), and overlays locally before serving `GET /api/layout`.
 */

import { createHash } from "node:crypto";
import {
  inferDatabaseDialectFromGraph,
  mergeContractPortValves,
  type ContractPortValves,
  type GraphDelta,
  type RepresentationGraph,
  type StructuralEdge,
  type StructuralNode,
} from "@chomp/core";
import { resolveActiveBearerToken } from "../utils/credentials.js";
import {
  CANONICAL_PACKAGE_ORDER,
  deploymentUnitLabel,
  LABEL_PREFIX_RE,
} from "./entityVocabulary.js";
import { computeGraphHealthMetrics } from "./healthMetrics.js";
import {
  DEFAULT_CLOUD_API_URL,
  hasLocalMasterLayoutEngine,
  loadLocalMasterLayoutEngine,
} from "./localEngineBridge.js";
import {
  matchesCustomRule,
  type ChompRulesConfig,
  type CustomClassificationRule,
} from "./rulesConfig.js";
import type {
  EntityOverlayItem,
  LayoutData,
  LayoutEdge,
  LayoutNode,
  MacroPackageEdge,
  NodeEvidenceItem,
  PackageBounds,
} from "./types.js";

// ---------------------------------------------------------------------------
// Wire Protocol Types
// ---------------------------------------------------------------------------

export interface StatelessLayoutRequest {
  schemaVersion: "1.0";
  graph: RepresentationGraph;
  diffDelta?: GraphDelta;
  rulesConfig?: ChompRulesConfig;
  overlays?: EntityOverlayItem[];
}

export interface StatelessLayoutResponse {
  schemaVersion: "1.0";
  layout: LayoutData;
}

export interface OriginalNodeHydrationEntry {
  id: string;
  rawName: string;
  cleanLabel: string;
  humanLabel?: string;
  parentLabel?: string;
  realPackageLabel: string;
  evidence?: NodeEvidenceItem[];
  inputTypes?: string[];
  outputType?: string;
  portValves?: ContractPortValves;
  portMismatchCount?: number;
  overlays?: EntityOverlayItem[];
}

export interface SkeletonHydrationMap {
  /** Maps original node ID -> original human-readable labels, evidence, and overlays. */
  nodesById: Map<string, OriginalNodeHydrationEntry>;
  /** Maps pseudonymized package label -> real package label. */
  realPkgByPseudoPkg: Map<string, string>;
  /** Maps real package label -> pseudonymized package label. */
  pseudoPkgByRealPkg: Map<string, string>;
  /** Maps real package label -> original display name (e.g. `@scope/pkg`). */
  realDisplayNameByRealPkg: Map<string, string>;
  /** Maps pseudonymized badge string -> real badge string. */
  realBadgeByPseudoBadge: Map<string, string>;
  /** Maps pseudonymized receptor ID -> real receptor ID. */
  realReceptorIdByPseudoId: Map<string, string>;
  /** Maps `${sourceId}::${lineNumber}::${pseudoCallName}` -> real unresolved call metadata. */
  realUnresolvedByKey: Map<
    string,
    {
      name: string;
      filePath?: string;
      lineNumber?: number;
      importSpecifier?: string;
      resolvedFilePath?: string;
      targetSymbol?: string;
    }
  >;
}

// ---------------------------------------------------------------------------
// Evidence Snippet Sanitizer
// ---------------------------------------------------------------------------

/**
 * Strips raw source code `snippet` strings from a single evidence object or array,
 * keeping only `{ filePath, lineNumber, evidenceRole }`.
 */
export function sanitizeEvidenceItems(
  evidence: any,
): NodeEvidenceItem[] | undefined {
  if (!evidence) return undefined;
  const rawList = Array.isArray(evidence) ? evidence : [evidence];
  const cleaned: NodeEvidenceItem[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object" || !item.filePath) continue;
    cleaned.push({
      filePath: String(item.filePath),
      ...(typeof item.lineNumber === "number"
        ? { lineNumber: item.lineNumber }
        : {}),
      ...(typeof item.evidenceRole === "string"
        ? { evidenceRole: item.evidenceRole }
        : {}),
    });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Returns a shallow copy of `RepresentationGraph` with all `evidence.snippet` fields removed.
 */
export function stripEvidenceSnippetsFromGraph(
  graph: RepresentationGraph,
): RepresentationGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (!n.evidence) return n;
      const ev = Array.isArray(n.evidence)
        ? n.evidence.map(({ snippet: _s, ...rest }: any) => rest)
        : (() => {
            const { snippet: _s, ...rest } = n.evidence as any;
            return rest;
          })();
      return { ...n, evidence: ev };
    }),
    edges: graph.edges.map((e) => {
      if (!e.evidence) return e;
      const ev = Array.isArray(e.evidence)
        ? e.evidence.map(({ snippet: _s, ...rest }: any) => rest)
        : (() => {
            const { snippet: _s, ...rest } = e.evidence as any;
            return rest;
          })();
      return { ...e, evidence: ev };
    }),
  };
}

// ---------------------------------------------------------------------------
// Deterministic Role- & Length-Preserving Pseudonymization Helpers
// ---------------------------------------------------------------------------

const UTILITY_PREFIX_RE =
  /^(get|set|is|has|can|should|format|parse|build|create|make|to|from|normalize|clean|strip|truncate|sanitize|validate|check|assert|ensure|compute|calc|calculate|resolve|extract|derive|map|filter|sort|group|merge|clone|pick|omit|log|warn|error|debug|read|write|load|save|encode|decode|hash|sign|verify|compare|match|find|lookup|select|count|sum|min|max|clamp|round|pad|join|split|trim|escape|unescape|serialize|deserialize|hydrate|dehydrate|wrap|unwrap|bind|noop|identity)(?=[A-Z0-9_]|$)/;

const DOMAIN_ENGINE_PREFIX_RE =
  /^(run|execute|perform|process|handle|dispatch|invoke|orchestrate|coordinate|analyze|audit|evaluate|sync|publish|emit|broadcast|schedule|enqueue|consume|migrate|bootstrap|initialize|start|stop|connect|disconnect|register|mount|render|compile|transpile|bundle|deploy)(?=[A-Z0-9_]|$)/;

const DOMAIN_STATION_SUFFIX_RE =
  /(Service|Controller|Router|Handler|Middleware|Guard|Interceptor|Filter|Pipe|Provider|Repository|Store|Client|Adapter|Gateway|Broker|Worker|Queue|Consumer|Producer|Processor|Engine|Manager|Coordinator|Orchestrator|Dispatcher|Resolver|Mutation|Query|Subscription|Context|Hook|Component|View|Page|Layout|Screen|Modal|Drawer|Dialog|Form|Table|Board|Canvas|Panel|Plugin|Server|App|Application|Module|Boundary|Error|Exception|_DEPRECATED|Old)$/;

const UTILITY_EXACT_NAMES = new Set([
  "cn",
  "clsx",
  "twMerge",
  "cva",
  "noop",
  "identity",
  "invariant",
  "assert",
  "loader",
  "action",
  "clientLoader",
  "clientAction",
]);

const RESERVED_PATH_SEGMENTS = new Set([
  "src",
  "app",
  "pages",
  "routes",
  "api",
  "components",
  "_components",
  "adapters",
  "visitors",
  "conventions",
  "helpers",
  "utils",
  "internal",
  "fake",
  "fakes",
  "mock",
  "mocks",
  "packages",
  "apps",
]);

const RESERVED_FILE_BASENAMES = new Set([
  "page",
  "layout",
  "route",
  "loading",
  "error",
  "not-found",
  "template",
  "default",
  "middleware",
  "index",
]);

function shortHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function cleanNodeName(rawName: string): { prefix: string; body: string } {
  const match = rawName.match(LABEL_PREFIX_RE);
  const stripped = rawName.replace(LABEL_PREFIX_RE, "");
  let cleanBody = stripped;
  if (
    stripped.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL|ROUTE)\s/i) ||
    stripped.startsWith("/") ||
    /^(generateMetadata|generateStaticParams)\s*\(/.test(stripped)
  ) {
    cleanBody = stripped;
  } else if (/^Init:\s+/i.test(stripped)) {
    const unitPart = stripped.replace(/^Init:\s+/i, "");
    cleanBody = `Init: ${unitPart.split("/").pop() || unitPart}`;
  } else {
    cleanBody = stripped.split("/").pop() || stripped;
  }
  return {
    prefix: match ? match[0] : "",
    body: cleanBody.trim(),
  };
}

function extractDeploymentUnitShortName(rawName: string): string {
  return deploymentUnitLabel(rawName);
}

/**
 * Encodes a non-negative integer `rank` into fixed-width base-26 lowercase letters (`aaaa`..`zzzz`).
 */
function encodeRankAlpha(rank: number, width = 4): string {
  const chars = new Array<string>(width).fill("a");
  let n = Math.max(0, rank);
  for (let i = width - 1; i >= 0; i--) {
    chars[i] = String.fromCharCode(97 + (n % 26));
    n = Math.floor(n / 26);
  }
  return chars.join("");
}

/**
 * Produces a deterministic, role- and length-preserving pseudonym for a single identifier token.
 * Preserves:
 *   - Exact character length (`result.length === token.length`)
 *   - Classifier prefixes (`get`, `run`, `use`, etc.)
 *   - Classifier suffixes (`Service`, `Controller`, `Error`, etc.)
 *   - Initial character case (`[A-Z]` vs `[a-z]`)
 *   - Lexicographical sort tie-breaking via `rankTag` (`aaaa`..`zzzz`)
 */
function pseudonymizeSingleToken(token: string, rank: number): string {
  if (!token) return token;
  if (UTILITY_EXACT_NAMES.has(token)) return token;

  // Preserve HTTP route method prefixes like `GET /...` or Next.js route paths `/...`
  if (/^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+/i.test(token)) {
    const m = token.match(/^([A-Z]+\s+)(.*)$/i)!;
    return `${m[1]}${pseudonymizeRoutePath(m[2], rank)}`;
  }
  if (token.startsWith("/")) {
    return pseudonymizeRoutePath(token, rank);
  }

  let preservedPrefix = "";
  const utilMatch = token.match(UTILITY_PREFIX_RE);
  const engineMatch = !utilMatch ? token.match(DOMAIN_ENGINE_PREFIX_RE) : null;
  const hookMatch =
    !utilMatch && !engineMatch && /^use[A-Z]/.test(token) ? ["use"] : null;

  if (utilMatch) {
    preservedPrefix = utilMatch[1];
  } else if (engineMatch) {
    preservedPrefix = engineMatch[1];
  } else if (hookMatch) {
    preservedPrefix = "use";
  }

  let preservedSuffix = "";
  const suffixMatch = token.slice(preservedPrefix.length).match(DOMAIN_STATION_SUFFIX_RE);
  if (suffixMatch && suffixMatch[1].length < token.length - preservedPrefix.length) {
    preservedSuffix = suffixMatch[1];
  }

  if (
    !preservedPrefix &&
    token.length - preservedSuffix.length >= 6 &&
    /^[a-zA-Z]{2}/.test(token)
  ) {
    preservedPrefix = token.slice(0, 2);
  }

  const middleBudget =
    token.length - preservedPrefix.length - preservedSuffix.length;
  if (middleBudget <= 0) {
    const h = shortHash(`tok:${token}:${rank}`);
    const isUpper = /^[A-Z]/.test(token);
    const first = isUpper ? "N" : "n";
    return (first + encodeRankAlpha(rank, 4) + h).slice(0, Math.max(1, token.length));
  }

  const origMiddle = token.slice(
    preservedPrefix.length,
    token.length - preservedSuffix.length,
  );
  const startsUpper = /^[A-Z]/.test(origMiddle);
  const startsDigitOrUnderscore = /^[0-9_]/.test(origMiddle);

  const rankChars = encodeRankAlpha(rank, 4);
  const hashFill = shortHash(`mid:${token}:${rank}`).replace(/[^a-z0-9]/g, "x");
  let rawFill = `${rankChars}${hashFill}`;
  while (rawFill.length < middleBudget) {
    rawFill += hashFill;
  }

  if (startsUpper) {
    rawFill = rawFill[0].toUpperCase() + rawFill.slice(1);
  } else if (startsDigitOrUnderscore && preservedPrefix.length > 0) {
    rawFill = "_" + rawFill.slice(1);
  }

  const middle = rawFill.slice(0, middleBudget);
  return `${preservedPrefix}${middle}${preservedSuffix}`;
}

function pseudonymizeRoutePath(routePath: string, rank: number): string {
  const parts = routePath.split("/");
  return parts
    .map((seg, idx) => {
      if (!seg) return "";
      if (/^\([^)]+\)$/.test(seg) || /^@/.test(seg) || /^\[.*\]$/.test(seg) || seg.startsWith(":")) {
        return seg;
      }
      if (seg === "api" || seg === "v1" || seg === "health") return seg;
      const fill = `${encodeRankAlpha(rank + idx, 3)}${shortHash(`route:${seg}`)}`;
      return fill.slice(0, Math.max(1, seg.length));
    })
    .join("/");
}

function pseudonymizeFilePath(filePath: string): string {
  const norm = String(filePath).replace(/\\/g, "/");
  const segments = norm.split("/");
  return segments
    .map((seg, idx) => {
      if (!seg) return "";
      if (idx < segments.length - 1) {
        if (RESERVED_PATH_SEGMENTS.has(seg.toLowerCase())) return seg;
        if (/^\([^)]+\)$/.test(seg) || /^@/.test(seg) || /^\[.*\]$/.test(seg)) {
          return seg;
        }
        return `d_${shortHash(`dir:${seg}`).slice(0, 6)}`;
      }
      const dotIdx = seg.indexOf(".");
      const base = dotIdx >= 0 ? seg.slice(0, dotIdx) : seg;
      const ext = dotIdx >= 0 ? seg.slice(dotIdx) : "";
      if (RESERVED_FILE_BASENAMES.has(base.toLowerCase())) {
        return `${base}${ext}`;
      }
      return `f_${shortHash(`file:${base}`).slice(0, 6)}${ext}`;
    })
    .join("/");
}

// ---------------------------------------------------------------------------
// Step 1: Anonymize Local Graph into Stateless Skeleton Request
// ---------------------------------------------------------------------------

export function anonymizeGraphForCloudLayout(
  rawGraph: RepresentationGraph,
  diffDelta?: GraphDelta,
  rulesConfig?: ChompRulesConfig,
  overlays?: EntityOverlayItem[],
): {
  request: StatelessLayoutRequest;
  hydrationMap: SkeletonHydrationMap;
} {
  const nodesById = new Map<string, OriginalNodeHydrationEntry>();
  const realPkgByPseudoPkg = new Map<string, string>();
  const pseudoPkgByRealPkg = new Map<string, string>();
  const realDisplayNameByRealPkg = new Map<string, string>();
  const realBadgeByPseudoBadge = new Map<string, string>();
  const realReceptorIdByPseudoId = new Map<string, string>();
  const realUnresolvedByKey = new Map<
    string,
    {
      name: string;
      filePath?: string;
      lineNumber?: number;
      importSpecifier?: string;
      resolvedFilePath?: string;
      targetSymbol?: string;
    }
  >();

  const nodeById = new Map<string, StructuralNode>();
  for (const n of rawGraph.nodes) {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  }

  // Group overlays by entityId for local rule evaluation & humanLabel extraction
  const overlaysByEntityId = new Map<string, EntityOverlayItem[]>();
  if (Array.isArray(overlays)) {
    for (const ov of overlays) {
      if (!ov || !ov.entityId) continue;
      if (
        rulesConfig?.overlayLayers &&
        rulesConfig.overlayLayers[ov.layer] === false
      ) {
        continue;
      }
      let list = overlaysByEntityId.get(ov.entityId);
      if (!list) {
        list = [];
        overlaysByEntityId.set(ov.entityId, list);
      }
      list.push(ov);
    }
  }

  // 1. Resolve package labels and build deterministic order-preserving package pseudonyms
  const discoveredRealPkgs = new Set<string>();
  for (const n of rawGraph.nodes) {
    if (n.entityType === "DEPLOYMENT_UNIT") {
      const shortPkg = extractDeploymentUnitShortName(n.name);
      discoveredRealPkgs.add(shortPkg);
      const rawDisplayName = n.name.replace(/^Deployment Unit:\s*/i, "").trim();
      if (rawDisplayName && !realDisplayNameByRealPkg.has(shortPkg)) {
        realDisplayNameByRealPkg.set(shortPkg, rawDisplayName);
      }
    }
  }
  const nonCanonicalPkgs = Array.from(discoveredRealPkgs)
    .filter((p) => !CANONICAL_PACKAGE_ORDER.includes(p))
    .sort();

  for (const canonPkg of CANONICAL_PACKAGE_ORDER) {
    if (discoveredRealPkgs.has(canonPkg)) {
      pseudoPkgByRealPkg.set(canonPkg, canonPkg);
      realPkgByPseudoPkg.set(canonPkg, canonPkg);
    }
  }
  nonCanonicalPkgs.forEach((realPkg, idx) => {
    const rankStr = String(idx).padStart(2, "0");
    const rawPseudo = `pkg_${rankStr}_${shortHash(`pkg:${realPkg}`).slice(0, 6)}`;
    const pseudoPkg =
      realPkg.length >= 4
        ? rawPseudo.slice(0, realPkg.length).padEnd(realPkg.length, "x")
        : rawPseudo.slice(0, 6);
    pseudoPkgByRealPkg.set(realPkg, pseudoPkg);
    realPkgByPseudoPkg.set(pseudoPkg, realPkg);
  });

  const packageOf = (nodeId: string): string => {
    const seen = new Set<string>();
    let cursor: StructuralNode | undefined = nodeById.get(nodeId);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.entityType === "DEPLOYMENT_UNIT") {
        return extractDeploymentUnitShortName(cursor.name);
      }
      cursor = cursor.parentBoundaryId
        ? nodeById.get(cursor.parentBoundaryId)
        : undefined;
    }
    return "";
  };

  // 2. Collect all distinct identifier tokens across the graph and sort them
  //    so `localeCompare` tie-breakers in `localBoardLayout.ts` and `3-gridMapper.ts`
  //    stay 100% order-isomorphic.
  const allTokensSet = new Set<string>();
  for (const n of rawGraph.nodes) {
    const { body } = cleanNodeName(n.name);
    if (body.includes(".")) {
      const [cls, mem] = body.split(".", 2);
      if (cls) allTokensSet.add(cls);
      if (mem) allTokensSet.add(mem);
    } else if (body) {
      allTokensSet.add(body);
    }
    const ovs = overlaysByEntityId.get(n.id);
    if (ovs) {
      for (const ov of ovs) {
        if (typeof ov.payload?.humanLabel === "string" && ov.payload.humanLabel.trim()) {
          allTokensSet.add(ov.payload.humanLabel.trim());
        }
      }
    }
  }
  const sortedTokens = Array.from(allTokensSet).sort((a, b) =>
    a.localeCompare(b),
  );
  const rankByToken = new Map<string, number>();
  sortedTokens.forEach((tok, idx) => rankByToken.set(tok, idx));

  const pseudoByToken = new Map<string, string>();
  const getPseudoToken = (tok: string): string => {
    const cached = pseudoByToken.get(tok);
    if (cached !== undefined) return cached;
    const rank = rankByToken.get(tok) ?? 0;
    const pseudo = pseudonymizeSingleToken(tok, rank);
    pseudoByToken.set(tok, pseudo);
    return pseudo;
  };

  // 3. Infer database dialect locally so open connectors don't need raw file paths/snippets
  const dialectInfo = inferDatabaseDialectFromGraph(rawGraph);

  // 4. Anonymize nodes and build `hydrationMap`
  const anonymizedNodes: StructuralNode[] = rawGraph.nodes.map((n) => {
    const { prefix, body } = cleanNodeName(n.name);
    const realPkg = packageOf(n.id);
    const pseudoPkg = pseudoPkgByRealPkg.get(realPkg) ?? realPkg;

    // Resolve parent label (e.g. parent CLASS name) for hydration
    let realParentLabel: string | undefined;
    if (n.parentBoundaryId) {
      const pNode = nodeById.get(n.parentBoundaryId);
      if (pNode && pNode.entityType !== "DEPLOYMENT_UNIT") {
        realParentLabel = cleanNodeName(pNode.name).body;
      }
    }

    // Check if an active L1_SEMANTIC overlay overrides `humanLabel`
    const nodeOvs = overlaysByEntityId.get(n.id);
    let humanLabelOverride: string | undefined;
    if (nodeOvs) {
      for (const ov of nodeOvs) {
        if (
          ov.layer === "L1_SEMANTIC" &&
          !ov.stale &&
          typeof ov.payload?.humanLabel === "string" &&
          ov.payload.humanLabel.trim()
        ) {
          humanLabelOverride = ov.payload.humanLabel.trim();
        }
      }
    }

    let pseudoName = n.name;
    if (n.entityType === "DEPLOYMENT_UNIT") {
      pseudoName = `${prefix || "Deployment Unit: "}${pseudoPkg}`;
    } else if (n.entityType === "INIT_BLOCK") {
      pseudoName = `${prefix || "Init Block: "}${pseudoPkg || "root"}`;
    } else if (
      n.entityType === "EXTERNAL_HTTP_CALL" ||
      n.entityType === "HTTP_CLIENT_CALL" ||
      n.patternId?.includes("http")
    ) {
      const urlMatch = n.name.match(/https?:\/\/([^/\s"'`)]+)/i);
      if (urlMatch?.[1]) {
        const realHost = urlMatch[1].replace(/^www\./i, "");
        const pseudoHost = `api-${shortHash(`host:${realHost}`).slice(0, 8)}.example`;
        const realSlug = realHost.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        const pseudoSlug = pseudoHost.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        realPkgByPseudoPkg.set(`HTTP: ${pseudoHost}`, `HTTP: ${realHost}`);
        pseudoPkgByRealPkg.set(`HTTP: ${realHost}`, `HTTP: ${pseudoHost}`);
        realReceptorIdByPseudoId.set(
          `__ext_receptor_http_${pseudoSlug}__`,
          `__ext_receptor_http_${realSlug}__`,
        );
        pseudoName = `${prefix || "HTTP Call: "}https://${pseudoHost}`;
      } else {
        pseudoName = `${prefix || "HTTP Call: "}${getPseudoToken(body)}`;
      }
    } else if (body.includes(".")) {
      const [cls, mem] = body.split(".", 2);
      const pseudoCls = getPseudoToken(cls);
      const pseudoMem = getPseudoToken(mem);
      pseudoName = `${prefix}${pseudoCls}.${pseudoMem}`;
    } else {
      const pseudoBody = getPseudoToken(body);
      pseudoName = `${prefix}${pseudoBody}`;
    }

    const pseudoCleanBody = cleanNodeName(pseudoName).body;
    const realDisplayLabel = humanLabelOverride ?? body;
    const pseudoDisplayLabel = humanLabelOverride
      ? getPseudoToken(humanLabelOverride)
      : pseudoCleanBody;

    // Record badge mappings in case this node is folded as a Component/Middleware/Dependency/Schema badge
    for (const badgeKind of ["Component", "Middleware", "Dependency", "Schema"]) {
      realBadgeByPseudoBadge.set(
        `${badgeKind}: ${pseudoCleanBody}`,
        `${badgeKind}: ${body}`,
      );
      realBadgeByPseudoBadge.set(
        `${badgeKind}: ${pseudoDisplayLabel}`,
        `${badgeKind}: ${realDisplayLabel}`,
      );
      if (body.includes(".")) {
        const shortMem = body.split(".").pop()!;
        const pseudoShortMem = pseudoCleanBody.split(".").pop()!;
        realBadgeByPseudoBadge.set(
          `${badgeKind}: ${pseudoShortMem}`,
          `${badgeKind}: ${shortMem}`,
        );
      }
    }

    const mergedPortValves = mergeContractPortValves(n.metadata, nodeOvs);
    const portMismatchCount = mergedPortValves?.diagnostics?.length ?? 0;
    const sanitizedEvidence = sanitizeEvidenceItems(n.evidence);
    nodesById.set(n.id, {
      id: n.id,
      rawName: n.name,
      cleanLabel: body,
      ...(humanLabelOverride ? { humanLabel: humanLabelOverride } : {}),
      ...(realParentLabel ? { parentLabel: realParentLabel } : {}),
      realPackageLabel: realPkg,
      ...(sanitizedEvidence ? { evidence: sanitizedEvidence } : {}),
      ...(Array.isArray(n.metadata?.inputTypes)
        ? { inputTypes: n.metadata.inputTypes }
        : {}),
      ...(typeof n.metadata?.outputType === "string"
        ? { outputType: n.metadata.outputType }
        : {}),
      ...(mergedPortValves ? { portValves: mergedPortValves } : {}),
      ...(portMismatchCount > 0 ? { portMismatchCount } : {}),
      ...(nodeOvs ? { overlays: nodeOvs } : {}),
    });

    // Anonymize evidence filePaths (preserving framework folder tokens & extensions) and strip snippets
    const anonEvidence = n.evidence
      ? Array.isArray(n.evidence)
        ? n.evidence.map((ev: any) => ({
            filePath: ev?.filePath ? pseudonymizeFilePath(ev.filePath) : "f_anon.ts",
            ...(typeof ev?.lineNumber === "number"
              ? { lineNumber: ev.lineNumber }
              : {}),
            ...(typeof ev?.evidenceRole === "string"
              ? { evidenceRole: ev.evidenceRole }
              : {}),
          }))
        : {
            filePath: (n.evidence as any)?.filePath
              ? pseudonymizeFilePath((n.evidence as any).filePath)
              : "f_anon.ts",
            ...(typeof (n.evidence as any)?.lineNumber === "number"
              ? { lineNumber: (n.evidence as any).lineNumber }
              : {}),
            ...(typeof (n.evidence as any)?.evidenceRole === "string"
              ? { evidenceRole: (n.evidence as any).evidenceRole }
              : {}),
          }
      : undefined;

    // Anonymize metadata while preserving layout-critical flags & type string lengths
    const anonMetadata: Record<string, any> = {};
    if (n.metadata) {
      if (n.metadata.flowRole) anonMetadata.flowRole = n.metadata.flowRole;
      if (typeof n.metadata.isImportedInRepo === "boolean") {
        anonMetadata.isImportedInRepo = n.metadata.isImportedInRepo;
      }
      if (typeof n.metadata.astCallCount === "number") {
        anonMetadata.astCallCount = n.metadata.astCallCount;
      }
      if (typeof n.metadata.bodyHash === "string") {
        anonMetadata.bodyHash = n.metadata.bodyHash;
      }
      if (Array.isArray(n.metadata.inputTypes)) {
        anonMetadata.inputTypes = n.metadata.inputTypes.map((t: string) =>
          "T".repeat(Math.max(1, String(t).length)),
        );
      }
      if (typeof n.metadata.outputType === "string") {
        anonMetadata.outputType = "R".repeat(
          Math.max(1, n.metadata.outputType.length),
        );
      }
      if (typeof n.metadata.dialect === "string") {
        anonMetadata.dialect = n.metadata.dialect;
      }
    }
    if (
      !anonMetadata.dialect &&
      (n.entityType === "DB_QUERY" ||
        n.entityType === "DB_OPERATION" ||
        n.entityType === "DB_TRANSACTION")
    ) {
      const inferred =
        (realPkg && dialectInfo.dialectByPackage?.[realPkg]) ||
        dialectInfo.defaultDialect;
      if (inferred) {
        anonMetadata.dialect = inferred;
      }
    }

    return {
      ...n,
      name: pseudoName,
      ...(anonEvidence ? { evidence: anonEvidence } : {}),
      ...(Object.keys(anonMetadata).length > 0 ? { metadata: anonMetadata } : {}),
    };
  });

  // 5. Anonymize edges (including unresolved call edge names & evidence)
  const anonymizedEdges: StructuralEdge[] = rawGraph.edges.map((e) => {
    const ev = Array.isArray(e.evidence) ? e.evidence[0] : e.evidence;
    const lineNumber = typeof ev?.lineNumber === "number" ? ev.lineNumber : undefined;
    let anonEdgeName = e.name;

    if (!e.targetId && e.name) {
      const rawCall = e.name.replace(/^Call:\s*/i, "").trim();
      const pseudoCall = `call_${shortHash(`unres:${e.sourceId}:${rawCall}`).slice(0, 8)}`;
      anonEdgeName = `Call: ${pseudoCall}`;
      const key = `${e.sourceId}::${lineNumber ?? 0}::${pseudoCall}`;
      realUnresolvedByKey.set(key, {
        name: rawCall,
        ...(ev?.filePath ? { filePath: String(ev.filePath) } : {}),
        ...(lineNumber !== undefined ? { lineNumber } : {}),
        ...(typeof e.metadata?.importSpecifier === "string"
          ? { importSpecifier: e.metadata.importSpecifier }
          : {}),
        ...(typeof e.metadata?.resolvedFilePath === "string"
          ? { resolvedFilePath: e.metadata.resolvedFilePath }
          : {}),
        ...(typeof e.metadata?.targetSymbol === "string"
          ? { targetSymbol: e.metadata.targetSymbol }
          : {}),
      });
    }

    const anonEdgeEvidence =
      !e.targetId && lineNumber !== undefined
        ? [{ filePath: "f.ts", lineNumber }]
        : undefined;

    const anonEdgeMeta: Record<string, any> = {};
    if (e.metadata) {
      if (e.metadata.shapeKey) anonEdgeMeta.shapeKey = e.metadata.shapeKey;
      if (e.metadata.viaHelper) anonEdgeMeta.viaHelper = e.metadata.viaHelper;
      if (e.metadata.unresolvedReason) {
        anonEdgeMeta.unresolvedReason = e.metadata.unresolvedReason;
      }
      if (e.metadata.resolutionClass) {
        anonEdgeMeta.resolutionClass = e.metadata.resolutionClass;
      }
    }

    const { evidence: _rawEdgeEv, metadata: _rawEdgeMeta, ...edgeRest } = e;
    return {
      ...edgeRest,
      name: anonEdgeName,
      evidence: anonEdgeEvidence ?? [],
      ...(Object.keys(anonEdgeMeta).length > 0 ? { metadata: anonEdgeMeta } : {}),
    };
  });

  // 6. Pre-evaluate custom rules locally so raw regex patterns, filePath patterns,
  //    and overlay criteria never leave the user's machine.
  let anonymizedRulesConfig: ChompRulesConfig | undefined;
  if (rulesConfig) {
    const resolvedCustomRules: CustomClassificationRule[] = [];
    const enabledCustom = (rulesConfig.customRules ?? []).filter((r) => r.enabled);
    for (const n of rawGraph.nodes) {
      const realPkg = packageOf(n.id);
      const { body } = cleanNodeName(n.name);
      for (const rule of enabledCustom) {
        if (
          matchesCustomRule(
            {
              id: n.id,
              name: n.name,
              label: body,
              entityType: n.entityType,
              patternId: n.patternId,
              evidence: n.evidence,
              overlays: overlaysByEntityId.get(n.id),
            },
            realPkg,
            rule,
          )
        ) {
          let anonBadgeLabel: string | undefined;
          if (rule.badgeLabel) {
            anonBadgeLabel = `b_${shortHash(`rulebadge:${rule.id}:${rule.badgeLabel}`).slice(0, Math.max(4, rule.badgeLabel.length - 2))}`;
            for (const kind of ["Component", "Middleware", "Schema"]) {
              realBadgeByPseudoBadge.set(
                `${kind}: ${anonBadgeLabel}`,
                `${kind}: ${rule.badgeLabel}`,
              );
            }
          }
          resolvedCustomRules.push({
            id: `${rule.id}__${n.id}`,
            name: `rule_${shortHash(rule.id).slice(0, 6)}`,
            enabled: true,
            match: { nodeId: n.id },
            action: rule.action,
            ...(anonBadgeLabel ? { badgeLabel: anonBadgeLabel } : {}),
            badgeMode: rule.badgeMode,
          });
        }
      }
    }
    anonymizedRulesConfig = {
      version: 1,
      defaults: { ...rulesConfig.defaults },
      customRules: resolvedCustomRules,
      overlayLayers: rulesConfig.overlayLayers
        ? { ...rulesConfig.overlayLayers }
        : undefined,
    };
  }

  // 7. Create minimal anonymized overlays preserving only `humanLabel` length
  const anonymizedOverlays: EntityOverlayItem[] | undefined = overlays
    ? overlays
        .filter((ov) => ov && ov.layer === "L1_SEMANTIC" && !ov.stale)
        .map((ov) => ({
          entityId: ov.entityId,
          layer: ov.layer,
          source: "anon",
          environment: ov.environment || "local",
          stale: Boolean(ov.stale),
          payload:
            typeof ov.payload?.humanLabel === "string" &&
            ov.payload.humanLabel.trim()
              ? {
                  humanLabel: getPseudoToken(ov.payload.humanLabel.trim()),
                }
              : {},
        }))
    : undefined;

  // 8. Compact & anonymize `diffDelta` by stripping full `base` / `target` node & edge objects
  //    and omitting `UNCHANGED` entries (reduces diff payload size by >98% while preventing leaks).
  let anonymizedDiffDelta: GraphDelta | undefined;
  if (diffDelta) {
    const compactNodes: GraphDelta["nodes"] = {};
    for (const [id, entry] of Object.entries(diffDelta.nodes ?? {})) {
      if (entry && entry.status && entry.status !== "UNCHANGED") {
        compactNodes[id] = { status: entry.status };
      }
    }
    const compactEdges: GraphDelta["edges"] = {};
    for (const [id, entry] of Object.entries(diffDelta.edges ?? {})) {
      if (entry && entry.status && entry.status !== "UNCHANGED") {
        const srcId = (entry.target ?? entry.base)?.sourceId;
        compactEdges[id] = {
          status: entry.status,
          ...(srcId ? { target: { sourceId: srcId } as any } : {}),
        };
      }
    }
    anonymizedDiffDelta = {
      baseCommitSha: diffDelta.baseCommitSha
        ? shortHash(`commit:${diffDelta.baseCommitSha}`).slice(0, 12)
        : undefined,
      ...((diffDelta as any).summary ? { summary: (diffDelta as any).summary } : {}),
      nodes: compactNodes,
      edges: compactEdges,
    } as GraphDelta;
  }

  return {
    request: {
      schemaVersion: "1.0",
      graph: {
        ...rawGraph,
        repoId: `repo_${shortHash((rawGraph as any).repoId || "local").slice(0, 8)}`,
        nodes: anonymizedNodes,
        edges: anonymizedEdges,
      } as RepresentationGraph,
      ...(anonymizedDiffDelta ? { diffDelta: anonymizedDiffDelta } : {}),
      ...(anonymizedRulesConfig ? { rulesConfig: anonymizedRulesConfig } : {}),
      ...(anonymizedOverlays && anonymizedOverlays.length > 0
        ? { overlays: anonymizedOverlays }
        : {}),
    },
    hydrationMap: {
      nodesById,
      realPkgByPseudoPkg,
      pseudoPkgByRealPkg,
      realDisplayNameByRealPkg,
      realBadgeByPseudoBadge,
      realReceptorIdByPseudoId,
      realUnresolvedByKey,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 2: Local Re-Hydration (Restores Real Labels, Snippet-Free Evidence & Overlays)
// ---------------------------------------------------------------------------

function extractBaseOriginalIdFromLayoutNodeId(layoutNodeId: string): {
  pkgPrefix?: string;
  originalId: string;
  rowSuffix?: string;
} {
  // Format: `${pkg}::${originalId}::row${row}` or `${originalId}::STORY-${idx}` or `${originalId}`
  const parts = layoutNodeId.split("::");
  if (parts.length >= 3 && /^row\d+$/.test(parts[parts.length - 1])) {
    return {
      pkgPrefix: parts[0],
      originalId: parts.slice(1, -1).join("::"),
      rowSuffix: parts[parts.length - 1],
    };
  }
  if (parts.length === 2 && /^STORY-\d+$/.test(parts[1])) {
    return { originalId: parts[0] };
  }
  return { originalId: layoutNodeId };
}

function rehydrateBadgeString(
  pseudoBadge: string,
  hydrationMap: SkeletonHydrationMap,
): string {
  const diffMatch = pseudoBadge.match(/\s+(\+ADDED|~MOD|-REM)$/);
  const diffSuffix = diffMatch ? diffMatch[0] : "";
  const coreBadge = diffMatch
    ? pseudoBadge.slice(0, -diffSuffix.length)
    : pseudoBadge;

  const exact = hydrationMap.realBadgeByPseudoBadge.get(coreBadge);
  if (exact) return `${exact}${diffSuffix}`;
  return pseudoBadge;
}

export function rehydrateCloudLayout(
  response: StatelessLayoutResponse,
  hydrationMap: SkeletonHydrationMap,
  rawGraph: RepresentationGraph,
  repoName: string,
  overlays?: EntityOverlayItem[],
): LayoutData {
  const layout = response.layout;

  const mapPkg = (pseudoPkg: string | undefined): string | undefined => {
    if (!pseudoPkg) return pseudoPkg;
    return hydrationMap.realPkgByPseudoPkg.get(pseudoPkg) ?? pseudoPkg;
  };

  const mapLayoutNodeId = (id: string): string => {
    const parsed = extractBaseOriginalIdFromLayoutNodeId(id);
    const realOrigId =
      hydrationMap.realReceptorIdByPseudoId.get(parsed.originalId) ??
      parsed.originalId;
    if (parsed.pkgPrefix !== undefined && parsed.rowSuffix !== undefined) {
      const realPkg = mapPkg(parsed.pkgPrefix) ?? parsed.pkgPrefix;
      return `${realPkg}::${realOrigId}::${parsed.rowSuffix}`;
    }
    return realOrigId;
  };

  const rehydrateSingleNode = (node: LayoutNode): LayoutNode => {
    const parsed = extractBaseOriginalIdFromLayoutNodeId(node.id);
    const baseNodeId = parsed.originalId.split("@")[0];
    const entry = hydrationMap.nodesById.get(baseNodeId);
    const realPkg = mapPkg(node.packageLabel);

    // Preserve `(To: <pkg>)` cross-package suffix on EGRESS pins
    const toPkgMatch = node.label.match(/\s*\(To:\s*(.*?)\)$/);
    const realToSuffix = toPkgMatch
      ? ` (To: ${mapPkg(toPkgMatch[1]) ?? toPkgMatch[1]})`
      : "";

    let realLabel = node.label;
    let realRawLabel = node.rawLabel;
    if (node.entityType === "EXTERNAL_SYSTEM") {
      realLabel = realPkg ?? node.label;
    } else if (entry) {
      const baseDisplay = entry.humanLabel ?? entry.cleanLabel;
      realLabel = `${baseDisplay}${realToSuffix}`;
      if (entry.humanLabel) {
        realRawLabel = entry.cleanLabel;
      }
    }

    const rehydratedMicroNodes = node.microNodes?.map((m) => {
      const mEntry = hydrationMap.nodesById.get(m.originalId.split("@")[0]);
      const mParsed = extractBaseOriginalIdFromLayoutNodeId(m.id);
      const mRealPkg =
        (mParsed.pkgPrefix ? mapPkg(mParsed.pkgPrefix) : realPkg) ?? "";
      return {
        ...m,
        id:
          mParsed.rowSuffix && mRealPkg
            ? `${mRealPkg}::${m.originalId}::${mParsed.rowSuffix}`
            : m.id,
        label: mEntry ? (mEntry.humanLabel ?? mEntry.cleanLabel) : m.label,
        ...(mEntry?.humanLabel ? { rawLabel: mEntry.cleanLabel } : {}),
        ...(mEntry?.parentLabel ? { parentLabel: mEntry.parentLabel } : {}),
      };
    });

    if (rehydratedMicroNodes && rehydratedMicroNodes.length > 1) {
      realLabel = `${rehydratedMicroNodes[0].label} (+${rehydratedMicroNodes.length - 1})`;
    }

    const rehydratedFolded = node.foldedFunctions?.map((fn) => {
      const fEntry = hydrationMap.nodesById.get(fn.originalId.split("@")[0]);
      const fEv = fEntry?.evidence?.[0];
      return {
        ...fn,
        label: fEntry ? (fEntry.humanLabel ?? fEntry.cleanLabel) : fn.label,
        ...(fEntry?.humanLabel ? { rawLabel: fEntry.cleanLabel } : {}),
        ...(fEntry?.parentLabel ? { parentLabel: fEntry.parentLabel } : {}),
        ...(fEv?.filePath ? { filePath: fEv.filePath } : {}),
        ...(typeof fEv?.lineNumber === "number"
          ? { lineNumber: fEv.lineNumber }
          : {}),
      };
    });

    const rehydratedUnresolved = node.unresolvedCalls?.map((u) => {
      const pseudoCall = u.name.replace(/^Call:\s*/i, "").trim();
      const key = `${baseNodeId}::${u.lineNumber ?? 0}::${pseudoCall}`;
      const realU = hydrationMap.realUnresolvedByKey.get(key);
      if (!realU) {
        const { snippet: _s, ...rest } = u;
        return rest;
      }
      return {
        ...u,
        name: realU.name,
        ...(realU.filePath ? { filePath: realU.filePath } : {}),
        ...(realU.lineNumber !== undefined
          ? { lineNumber: realU.lineNumber }
          : {}),
        ...(realU.importSpecifier
          ? { importSpecifier: realU.importSpecifier }
          : {}),
        ...(realU.resolvedFilePath
          ? { resolvedFilePath: realU.resolvedFilePath }
          : {}),
        ...(realU.targetSymbol ? { targetSymbol: realU.targetSymbol } : {}),
        snippet: undefined,
      };
    });

    return {
      ...node,
      id: mapLayoutNodeId(node.id),
      label: realLabel,
      ...(realRawLabel ? { rawLabel: realRawLabel } : {}),
      ...(realPkg ? { packageLabel: realPkg } : {}),
      ...(entry?.parentLabel ? { parentLabel: entry.parentLabel } : {}),
      ...(entry?.evidence ? { evidence: entry.evidence } : {}),
      ...(entry?.inputTypes ? { inputTypes: entry.inputTypes } : {}),
      ...(entry?.outputType ? { outputType: entry.outputType } : {}),
      ...(entry?.portValves ? { portValves: entry.portValves } : {}),
      ...(entry?.portMismatchCount
        ? { portMismatchCount: entry.portMismatchCount }
        : {}),
      ...(entry?.overlays ? { overlays: entry.overlays } : {}),
      badges: (node.badges ?? []).map((b) =>
        rehydrateBadgeString(b, hydrationMap),
      ),
      ...(rehydratedMicroNodes ? { microNodes: rehydratedMicroNodes } : {}),
      ...(rehydratedFolded ? { foldedFunctions: rehydratedFolded } : {}),
      ...(rehydratedUnresolved ? { unresolvedCalls: rehydratedUnresolved } : {}),
    };
  };

  const rehydratedNodes = layout.nodes.map(rehydrateSingleNode);
  const rehydratedIslands = (layout.islandNodes ?? []).map(rehydrateSingleNode);
  const rehydratedInvariants = (layout.invariantNodes ?? []).map(
    rehydrateSingleNode,
  );

  const rehydratedEdges: LayoutEdge[] = layout.edges.map((e) => {
    const sourceId = mapLayoutNodeId(e.sourceId);
    const targetId = mapLayoutNodeId(e.targetId);
    return {
      ...e,
      id: `${sourceId}→${targetId}`,
      sourceId,
      targetId,
    };
  });

  const rehydratedPackageBounds: Record<string, PackageBounds> = {};
  if (layout.packageBounds) {
    for (const [pseudoPkg, bounds] of Object.entries(layout.packageBounds)) {
      const realPkg = mapPkg(pseudoPkg) ?? pseudoPkg;
      const restoredDisplayName =
        hydrationMap.realDisplayNameByRealPkg.get(realPkg) ??
        mapPkg(bounds.displayName) ??
        realPkg;
      rehydratedPackageBounds[realPkg] = {
        ...bounds,
        displayName: restoredDisplayName,
      };
    }
  }

  const rehydratedMacroEdges: MacroPackageEdge[] | undefined =
    layout.macroEdges?.map((me) => {
      const sourcePkg = mapPkg(me.sourcePkg) ?? me.sourcePkg;
      const targetPkg = mapPkg(me.targetPkg) ?? me.targetPkg;
      return {
        ...me,
        id: `macro:${sourcePkg}->${targetPkg}`,
        sourcePkg,
        targetPkg,
      };
    });

  const rehydratedStoryRows = (layout.storyRows ?? []).map((row) => {
    const realPkg = mapPkg(row.packageLabel) ?? row.packageLabel;
    return {
      ...row,
      entryLabel: realPkg,
      packageLabel: realPkg,
    };
  });

  const sanitizedRawGraph = stripEvidenceSnippetsFromGraph(rawGraph);
  const { systemHealth, packageHealthByPkg } = computeGraphHealthMetrics(
    sanitizedRawGraph,
    repoName,
    rehydratedIslands,
    {
      ...layout,
      nodes: rehydratedNodes,
      edges: rehydratedEdges,
      islandNodes: rehydratedIslands,
      invariantNodes: rehydratedInvariants,
      packageBounds: rehydratedPackageBounds,
    },
    overlays,
  );

  for (const [pkg, bounds] of Object.entries(rehydratedPackageBounds)) {
    const serverHealth = bounds.health;
    if (packageHealthByPkg[pkg]) {
      bounds.health = {
        ...packageHealthByPkg[pkg],
        ...(layout.entitlement?.previewMode && serverHealth
          ? {
              orphanCount: serverHealth.orphanCount,
              invariantCount: serverHealth.invariantCount,
            }
          : {}),
      };
    }
  }

  if (layout.entitlement?.previewMode && layout.healthSummary) {
    systemHealth.orphanCount = layout.healthSummary.orphanCount;
    systemHealth.invariantCount = layout.healthSummary.invariantCount;
  }

  const rehydratedEntitlement = layout.entitlement
    ? {
        ...layout.entitlement,
        ...(layout.entitlement.unlockedPackage
          ? {
              unlockedPackage:
                mapPkg(layout.entitlement.unlockedPackage) ??
                layout.entitlement.unlockedPackage,
            }
          : {}),
      }
    : undefined;

  return {
    ...layout,
    repoName,
    nodes: rehydratedNodes,
    edges: rehydratedEdges,
    islandNodes: rehydratedIslands,
    invariantNodes: rehydratedInvariants,
    packageBounds: rehydratedPackageBounds,
    macroEdges: rehydratedMacroEdges,
    storyRows: rehydratedStoryRows,
    healthSummary: systemHealth,
    ...(rehydratedEntitlement ? { entitlement: rehydratedEntitlement } : {}),
    ...(overlays ? { overlays } : {}),
  };
}

// ---------------------------------------------------------------------------
// Step 3: Remote Cloudflare Worker Client (`POST /v1/layout`) + Master Bridge
// ---------------------------------------------------------------------------

export interface RequestCloudLayoutOptions {
  /** Base URL of the stateless Cloudflare Layout Worker (e.g. `https://api.getchomp.dev`). */
  cloudApiUrl?: string;
  /** Optional API key / bearer token for authenticated rate-limit tiers. */
  apiKey?: string;
  /** Force calling the remote Cloud Layout Worker even inside the master monorepo (`--remote`). */
  remote?: boolean;
  /** Request timeout in milliseconds (default: 15000ms). */
  timeoutMs?: number;
}

export async function requestStatelessCloudLayout(
  rawGraph: RepresentationGraph,
  repoName: string,
  diffDelta?: GraphDelta,
  rulesConfig?: ChompRulesConfig,
  overlays?: EntityOverlayItem[],
  options: RequestCloudLayoutOptions = {},
): Promise<LayoutData> {
  const { request, hydrationMap } = anonymizeGraphForCloudLayout(
    rawGraph,
    diffDelta,
    rulesConfig,
    overlays,
  );

  const explicitUrl = (
    options.cloudApiUrl ??
    process.env.CHOMP_LAYOUT_API_URL ??
    ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (!options.remote && !explicitUrl && hasLocalMasterLayoutEngine()) {
    // Master Monorepo Mode: in-process execution of the stateless skeleton pipeline with zero network calls
    const { executeStatelessLayout } = await loadLocalMasterLayoutEngine();
    const response = executeStatelessLayout(request);
    response.layout.entitlement = response.layout.entitlement ?? {
      tier: "master",
      status: "active",
      previewMode: false,
      gatingMode: "early_access",
    };
    return rehydrateCloudLayout(
      response,
      hydrationMap,
      rawGraph,
      repoName,
      overlays,
    );
  }

  const baseUrl = explicitUrl || DEFAULT_CLOUD_API_URL;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  );

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Chomp-Schema-Version": "1.0",
    };
    const token = resolveActiveBearerToken(options.apiKey);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const bodyJson = JSON.stringify(request);
    let res: Response | undefined;
    let lastFetchErr: unknown;

    // Retry up to 2 times on transient socket resets (`ECONNRESET` / `UND_ERR_SOCKET`)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(`${baseUrl}/v1/layout`, {
          method: "POST",
          headers,
          body: bodyJson,
          signal: controller.signal,
        });
        break;
      } catch (err: any) {
        lastFetchErr = err;
        const code = err?.cause?.code ?? err?.code ?? "";
        const isTransientSocketReset =
          code === "ECONNRESET" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET" ||
          /ECONNRESET|socket|fetch failed/i.test(String(err?.message ?? ""));
        if (!isTransientSocketReset || attempt === 2 || controller.signal.aborted) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
      }
    }
    if (!res) {
      throw lastFetchErr ?? new Error("Cloud layout request failed");
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Cloud layout worker returned HTTP ${res.status}: ${errText || res.statusText}`,
      );
    }

    const response = (await res.json()) as StatelessLayoutResponse;
    return rehydrateCloudLayout(
      response,
      hydrationMap,
      rawGraph,
      repoName,
      overlays,
    );
  } finally {
    clearTimeout(timeout);
  }
}
