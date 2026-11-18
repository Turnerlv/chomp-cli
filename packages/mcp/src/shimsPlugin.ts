/**
 * packages/mcp/src/shimsPlugin.ts
 *
 * User-Defined Local Graph Shims Plugin (`L1_SHIMS` / `source: 'local-shims'`)
 * Enforces [PAT-DB-03], [PAT-DB-05], [PAT-VIS-15], [PAT-VIS-36], [PAT-MCP-09], [PAT-MCP-10].
 *
 * Sits cleanly as a Layer 1 plugin on top of Chomp's deterministic Layer 0 AST graph:
 *   - Layer 0 (`nodes` / `edges` in SQLite) remains 100% pure AST-evidenced facts.
 *   - Local shims live in `.chomp/shims.json` (and optional `chomp.config.json#shims`) and are
 *     evaluated by `localShimsPlugin` into `L1_SHIMS` `entity_overlays` carrying:
 *       1. Structured `shimmedEdges` + `syntheticConnectors` consumed by `applyShimOverlaysToGraph`
 *          when `overlayLayers.L1_SHIMS` is enabled (Eye icon in HUD).
 *       2. Full `PluginPresentation` v1 (`summary`, `metrics`, `views`, `prompt`, `sections`)
 *          for the HUD card, Package Inspector, and Node Inspector.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  CONNECTIVITY_TARGET_TYPES,
  PLUGIN_PRESENTATION_PAYLOAD_KEY,
  PLUGIN_PRESENTATION_VERSION,
  SHIM_OVERLAY_LAYER,
  applyShimOverlaysToGraph,
  capForPresentation,
  classifyCallEdgeResolution,
  computeActionableUnresolvedCallsByNode,
  stableEntityId,
  type ActionableUnresolvedCall,
  type EvidenceRecord,
  type PluginHudSummaryItem,
  type PluginPresentation,
  type PluginSpotlightView,
  type PresentationListItem,
  type PresentationSection,
  type PresentationTableRow,
  type PresentationTone,
  type RepresentationGraph,
  type ShimmedEdgeOverlayEntry,
  type StructuralNode,
} from "@chomp/core";
import type {
  ChompStorage,
  EntityOverlayInput,
  OverlayInputDependency,
} from "@chomp/db";
import {
  buildOverlayEvidence,
  computeFileOverlayHash,
  loadPluginSettings,
  resolveRepoName,
  runChompPlugin,
  type ChompPlugin,
  type ChompPluginContext,
} from "./pluginRunner.js";

export const LOCAL_SHIMS_PLUGIN_NAME = "local-shims" as const;
export const LOCAL_SHIMS_FILE_REL = ".chomp/plugins/local-shims/shims.json" as const;
export const LEGACY_LOCAL_SHIMS_FILE_REL = ".chomp/shims.json" as const;

export interface LocalTargetConnectorSpec {
  /** Display name of the open connector (e.g. `HTTP Call: POST /v1/charges` or `Queue: billing-events`). */
  name: string;
  /** Open connector entityType (`HTTP_FETCH`, `DB_QUERY`, `MESSAGE_PUBLISH`, `EXTERNAL_SDK_CALL`, `EXTERNAL_PACKAGE`). */
  entityType?: string;
}

export interface LocalGraphShimInput {
  /** Optional stable ID; auto-derived deterministically when omitted. */
  id?: string;
  /** Exact source entity ID (`nodes.id`). */
  sourceId?: string;
  /** Source node name or stripped label (e.g. `checkout` or `Exported Function: checkout`). */
  sourceName?: string;
  /** Optional repo-relative file path filter disambiguating `sourceName` (e.g. `src/checkout.ts`). */
  sourceFile?: string;
  /** Optional unresolved call name on the source contract (e.g. `container.resolve` or `Call: container.resolve()`). */
  callName?: string;
  /** Optional unresolved call shapeKey filter (e.g. `sk1/CALL/LocalVar/PropertyAccessExpression`). */
  shapeKey?: string;
  /** Exact target entity ID (`nodes.id`). */
  targetId?: string;
  /** Target node name or stripped label (e.g. `chargeCard` or `Public Method: StripeGateway.charge`). */
  targetName?: string;
  /** Optional repo-relative file path filter disambiguating `targetName`. */
  targetFile?: string;
  /** Target open connector descriptor (reuses matching OPEN_CONNECTOR or creates an `L1_SHIMS` synthetic connector). */
  targetConnector?: LocalTargetConnectorSpec;
  /** Relationship entityType (defaults to `CALL`). */
  entityType?: string;
  /** Optional custom relationship display name. */
  edgeName?: string;
  /** Human/agent rationale explaining why this runtime/dynamic link exists. */
  rationale?: string;
  /** Defaults to `true`. Set `false` to temporarily disable a shim without deleting it. */
  enabled?: boolean;
}

export interface LocalGraphShim extends LocalGraphShimInput {
  id: string;
  origin?: "shims.json" | "chomp.config.json";
}

export interface LocalShimsManifest {
  version: 1;
  shims: LocalGraphShimInput[];
}

export interface ResolvedShimRecord {
  shim: LocalGraphShim;
  sourceNode: StructuralNode;
  targetNode: StructuralNode;
  syntheticConnector?: StructuralNode;
  resolvedEdgeIds: string[];
  edgeEntry: ShimmedEdgeOverlayEntry;
  packageId: string | undefined;
}

export interface UnmatchedShimRecord {
  shim: LocalGraphShim;
  reason: string;
  packageId?: string;
}

export interface SuggestedShimCandidate {
  suggestedShim: LocalGraphShimInput;
  sourceNode: {
    id: string;
    name: string;
    entityType: string;
    packageName?: string;
    filePath?: string;
    lineNumber?: number;
  };
  unresolvedCall: {
    name: string;
    shapeKey?: string;
    resolutionClass?: string;
    reason: string;
    snippet?: string;
  };
  candidateTargets: Array<{
    id: string;
    name: string;
    entityType: string;
    packageName?: string;
    filePath?: string;
  }>;
  guidance: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function primaryEvidence(ev: EvidenceRecord | EvidenceRecord[] | undefined): EvidenceRecord | undefined {
  if (!ev) return undefined;
  return Array.isArray(ev) ? ev[0] : ev;
}

function stripNodePrefix(name: string): string {
  const idx = name.indexOf(":");
  return idx >= 0 ? name.slice(idx + 1).trim() : name.trim();
}

function normalizeCallToken(raw: string): string {
  return raw
    .replace(/^Call:\s*/i, "")
    .replace(/\(\)\s*$/, "")
    .trim();
}

export function deriveShimId(input: LocalGraphShimInput): string {
  if (typeof input.id === "string" && input.id.trim()) {
    return input.id.trim();
  }
  const key = JSON.stringify({
    src: input.sourceId ?? input.sourceName ?? "",
    srcFile: input.sourceFile ?? "",
    call: input.callName ?? "",
    sk: input.shapeKey ?? "",
    tgt: input.targetId ?? input.targetName ?? input.targetConnector?.name ?? "",
    tgtFile: input.targetFile ?? "",
    et: input.entityType ?? "CALL",
  });
  return `shim-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

function normalizeShimEntry(
  raw: unknown,
  origin: "shims.json" | "chomp.config.json",
): LocalGraphShim | null {
  if (!isObj(raw)) return null;
  const input: LocalGraphShimInput = {
    ...(typeof raw.id === "string" && raw.id.trim() ? { id: raw.id.trim() } : {}),
    ...(typeof raw.sourceId === "string" && raw.sourceId.trim() ? { sourceId: raw.sourceId.trim() } : {}),
    ...(typeof raw.sourceName === "string" && raw.sourceName.trim()
      ? { sourceName: raw.sourceName.trim() }
      : {}),
    ...(typeof raw.sourceFile === "string" && raw.sourceFile.trim()
      ? { sourceFile: raw.sourceFile.trim().replace(/\\/g, "/") }
      : {}),
    ...(typeof raw.callName === "string" && raw.callName.trim() ? { callName: raw.callName.trim() } : {}),
    ...(typeof raw.shapeKey === "string" && raw.shapeKey.trim() ? { shapeKey: raw.shapeKey.trim() } : {}),
    ...(typeof raw.targetId === "string" && raw.targetId.trim() ? { targetId: raw.targetId.trim() } : {}),
    ...(typeof raw.targetName === "string" && raw.targetName.trim()
      ? { targetName: raw.targetName.trim() }
      : {}),
    ...(typeof raw.targetFile === "string" && raw.targetFile.trim()
      ? { targetFile: raw.targetFile.trim().replace(/\\/g, "/") }
      : {}),
    ...(isObj(raw.targetConnector) &&
    typeof raw.targetConnector.name === "string" &&
    raw.targetConnector.name.trim()
      ? {
          targetConnector: {
            name: raw.targetConnector.name.trim(),
            ...(typeof raw.targetConnector.entityType === "string" &&
            raw.targetConnector.entityType.trim()
              ? { entityType: raw.targetConnector.entityType.trim() }
              : {}),
          },
        }
      : {}),
    ...(typeof raw.entityType === "string" && raw.entityType.trim()
      ? { entityType: raw.entityType.trim() }
      : {}),
    ...(typeof raw.edgeName === "string" && raw.edgeName.trim() ? { edgeName: raw.edgeName.trim() } : {}),
    ...(typeof raw.rationale === "string" && raw.rationale.trim()
      ? { rationale: raw.rationale.trim() }
      : {}),
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
  };

  if (!input.sourceId && !input.sourceName) return null;
  if (!input.targetId && !input.targetName && !input.targetConnector) return null;

  return {
    ...input,
    id: deriveShimId(input),
    origin,
  };
}

export function loadLocalShimsFromTexts(
  shimsJsonText: string | null,
  chompConfigText: string | null,
): { shims: LocalGraphShim[]; parseErrors: string[] } {
  const shims: LocalGraphShim[] = [];
  const parseErrors: string[] = [];
  const seenIds = new Set<string>();

  const parseArray = (rawList: unknown[], origin: "shims.json" | "chomp.config.json") => {
    for (const item of rawList) {
      const parsed = normalizeShimEntry(item, origin);
      if (!parsed) {
        parseErrors.push(`${origin}: skipped malformed shim entry (requires sourceId|sourceName and targetId|targetName|targetConnector)`);
        continue;
      }
      if (seenIds.has(parsed.id)) continue;
      seenIds.add(parsed.id);
      shims.push(parsed);
    }
  };

  if (shimsJsonText !== null && shimsJsonText.trim()) {
    try {
      const parsed = JSON.parse(shimsJsonText);
      const list = Array.isArray(parsed) ? parsed : isObj(parsed) && Array.isArray(parsed.shims) ? parsed.shims : null;
      if (list) parseArray(list, "shims.json");
      else parseErrors.push(`${LOCAL_SHIMS_FILE_REL}: expected an object with a "shims" array`);
    } catch (err: any) {
      parseErrors.push(`${LOCAL_SHIMS_FILE_REL}: invalid JSON (${err?.message ?? String(err)})`);
    }
  }

  if (chompConfigText !== null && chompConfigText.trim()) {
    try {
      const parsed = JSON.parse(chompConfigText);
      if (isObj(parsed) && Array.isArray(parsed.shims)) {
        parseArray(parsed.shims, "chomp.config.json");
      }
    } catch {
      // Malformed chomp.config.json is reported elsewhere if needed; ignore silently here.
    }
  }

  return { shims, parseErrors };
}

function buildOwningDuMap(nodes: readonly StructuralNode[]): Map<string, StructuralNode> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map<string, StructuralNode>();
  for (const n of nodes) {
    if (n.entityType === "DEPLOYMENT_UNIT") {
      result.set(n.id, n);
      continue;
    }
    let cur: StructuralNode | undefined = n;
    let guard = 0;
    while (cur?.parentBoundaryId && guard++ < 8) {
      const parent = byId.get(cur.parentBoundaryId);
      if (!parent) break;
      if (parent.entityType === "DEPLOYMENT_UNIT") {
        result.set(n.id, parent);
        break;
      }
      cur = parent;
    }
  }
  return result;
}

function matchNodeInGraph(
  nodes: readonly StructuralNode[],
  id: string | undefined,
  name: string | undefined,
  fileFilter: string | undefined,
  allowOpenConnectors: boolean,
): { node?: StructuralNode; error?: string } {
  const candidates = nodes.filter((n) => {
    if ((n.scope ?? "USER") !== "USER") return false;
    if (n.entityType === "DEPLOYMENT_UNIT") return false;
    if (!allowOpenConnectors && n.type === "OPEN_CONNECTOR") return false;
    return true;
  });

  if (id) {
    const exact = candidates.find((n) => n.id === id);
    return exact ? { node: exact } : { error: `No USER-scope node found with id '${id}'` };
  }

  if (!name) {
    return { error: "Missing node id or name" };
  }

  const normFile = fileFilter?.replace(/\\/g, "/").toLowerCase();
  const byFile = normFile
    ? candidates.filter((n) => {
        const evs = Array.isArray(n.evidence) ? n.evidence : [n.evidence];
        return evs.some((ev) => ev?.filePath?.replace(/\\/g, "/").toLowerCase().includes(normFile));
      })
    : candidates;

  const targetLower = name.toLowerCase();
  const strippedTargetLower = stripNodePrefix(name).toLowerCase();

  const exactMatches = byFile.filter(
    (n) =>
      n.name.toLowerCase() === targetLower ||
      stripNodePrefix(n.name).toLowerCase() === strippedTargetLower,
  );
  if (exactMatches.length === 1) return { node: exactMatches[0]! };
  if (exactMatches.length > 1) {
    const files = exactMatches
      .slice(0, 4)
      .map((n) => primaryEvidence(n.evidence)?.filePath ?? n.id)
      .join(", ");
    return {
      error: `Ambiguous node name '${name}' matched ${exactMatches.length} nodes (${files}); specify exact id or file filter`,
    };
  }

  const partialMatches = byFile.filter((n) =>
    stripNodePrefix(n.name).toLowerCase().includes(strippedTargetLower),
  );
  if (partialMatches.length === 1) return { node: partialMatches[0]! };
  if (partialMatches.length > 1) {
    return {
      error: `Ambiguous partial name '${name}' matched ${partialMatches.length} nodes; pass exact sourceId/targetId from chomp_get_nodes`,
    };
  }

  return { error: `Could not resolve '${name}'${fileFilter ? ` in '${fileFilter}'` : ""} in graph` };
}

export function evaluateShimsAgainstGraph(
  graph: RepresentationGraph,
  shims: readonly LocalGraphShim[],
): {
  resolved: ResolvedShimRecord[];
  unmatched: UnmatchedShimRecord[];
  owningDuByNodeId: Map<string, StructuralNode>;
} {
  const owningDuByNodeId = buildOwningDuMap(graph.nodes);
  const resolved: ResolvedShimRecord[] = [];
  const unmatched: UnmatchedShimRecord[] = [];

  for (const shim of shims) {
    if (shim.enabled === false) continue;

    const srcRes = matchNodeInGraph(
      graph.nodes,
      shim.sourceId,
      shim.sourceName,
      shim.sourceFile,
      false,
    );
    if (!srcRes.node) {
      unmatched.push({
        shim,
        reason: `Source unmatched: ${srcRes.error ?? "unknown source"}`,
      });
      continue;
    }
    const sourceNode = srcRes.node;
    const sourceDu = owningDuByNodeId.get(sourceNode.id);

    let targetNode: StructuralNode | undefined;
    let syntheticConnector: StructuralNode | undefined;

    if (shim.targetConnector) {
      const connName = shim.targetConnector.name.trim();
      const connEntityType = shim.targetConnector.entityType?.trim() || "EXTERNAL_SDK_CALL";
      const existingConn = graph.nodes.find(
        (n) =>
          n.type === "OPEN_CONNECTOR" &&
          (n.name.toLowerCase() === connName.toLowerCase() ||
            stripNodePrefix(n.name).toLowerCase() === stripNodePrefix(connName).toLowerCase()),
      );
      if (existingConn) {
        targetNode = existingConn;
      } else {
        const duScope = sourceDu ? stripNodePrefix(sourceDu.name) : "repo";
        const srcEv = primaryEvidence(sourceNode.evidence) ?? { filePath: shim.sourceFile ?? "unknown" };
        const connId = stableEntityId(`shim-connector:${duScope}`, "OPEN_CONNECTOR", connName);
        syntheticConnector = {
          id: connId,
          name: connName,
          type: "OPEN_CONNECTOR",
          entityType: connEntityType,
          patternId: "shim.open-connector",
          scope: "USER",
          evidence: srcEv,
          metadata: {
            source: "USER_SHIM",
            shimId: shim.id,
          },
        };
        targetNode = syntheticConnector;
      }
    } else {
      const tgtRes = matchNodeInGraph(
        graph.nodes,
        shim.targetId,
        shim.targetName,
        shim.targetFile,
        true,
      );
      if (!tgtRes.node) {
        unmatched.push({
          shim,
          reason: `Target unmatched: ${tgtRes.error ?? "unknown target"}`,
          packageId: sourceDu?.id,
        });
        continue;
      }
      targetNode = tgtRes.node;
    }

    if (sourceNode.id === targetNode.id) {
      unmatched.push({
        shim,
        reason: `Self-loop shim rejected: source and target both resolved to '${sourceNode.name}'`,
        packageId: sourceDu?.id,
      });
      continue;
    }

    // Match unresolved L0 call edges originating from `sourceNode.id`.
    const unresolvedOnSource = graph.edges.filter(
      (e) => e.sourceId === sourceNode.id && !e.targetId && (e.scope ?? "USER") === "USER",
    );
    let matchedEdges = unresolvedOnSource;
    if (shim.callName || shim.shapeKey) {
      const normCall = shim.callName ? normalizeCallToken(shim.callName).toLowerCase() : null;
      matchedEdges = unresolvedOnSource.filter((e) => {
        const edgeCall = normalizeCallToken(e.name).toLowerCase();
        const callOk = normCall
          ? edgeCall === normCall || edgeCall.endsWith(`.${normCall}`) || edgeCall.includes(normCall)
          : true;
        const shapeOk = shim.shapeKey ? e.metadata?.shapeKey === shim.shapeKey : true;
        return callOk && shapeOk;
      });
    } else if (unresolvedOnSource.length > 1) {
      // If multiple unresolved calls exist and no callName/shapeKey filter was supplied, try matching target symbol name;
      // otherwise emit a companion shimmed edge without guessing which unresolved call site it belonged to.
      const tgtSym = stripNodePrefix(targetNode.name).split(".").pop()?.toLowerCase() ?? "";
      const bySym = tgtSym
        ? unresolvedOnSource.filter((e) => normalizeCallToken(e.name).toLowerCase().includes(tgtSym))
        : [];
      matchedEdges = bySym.length === 1 ? bySym : [];
    }

    const chosenEdgeEv = matchedEdges[0]?.evidence ?? sourceNode.evidence;
    const entityType = shim.entityType?.trim() || "CALL";
    const edgeName =
      shim.edgeName?.trim() ||
      (targetNode.type === "OPEN_CONNECTOR"
        ? `Call: ${targetNode.name}`
        : `Call: ${stripNodePrefix(targetNode.name)}()`);

    const edgeEntry: ShimmedEdgeOverlayEntry = {
      shimId: shim.id,
      sourceId: sourceNode.id,
      targetId: targetNode.id,
      name: edgeName,
      entityType,
      ...(matchedEdges.length > 0 ? { resolvedEdgeIds: matchedEdges.map((e) => e.id) } : {}),
      ...(shim.rationale ? { rationale: shim.rationale } : {}),
      evidence: chosenEdgeEv,
    };

    resolved.push({
      shim,
      sourceNode,
      targetNode,
      ...(syntheticConnector ? { syntheticConnector } : {}),
      resolvedEdgeIds: matchedEdges.map((e) => e.id),
      edgeEntry,
      packageId: sourceDu?.id,
    });
  }

  return { resolved, unmatched, owningDuByNodeId };
}

function computeActionableUnresolvedMap(
  graph: RepresentationGraph,
): Map<string, ActionableUnresolvedCall[]> {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdgeMap = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!e.targetId || e.sourceId === e.targetId) continue;
    const list = outEdgeMap.get(e.sourceId) ?? [];
    list.push(e.targetId);
    outEdgeMap.set(e.sourceId, list);
  }
  return computeActionableUnresolvedCallsByNode(graph, nodeById, outEdgeMap);
}

/**
 * Collects all unhandled call sites eligible for custom links (`KNOWABLE_GAP` + `DYNAMIC_BOUNDARY`),
 * matching `chomp_local_shims` (`action: "suggest"`).
 */
function computeShimmableUnresolvedMap(
  graph: RepresentationGraph,
  actionableByNode: Map<string, ActionableUnresolvedCall[]>,
): Map<string, Array<{ name: string; shapeKey?: string }>> {
  const combined = new Map<string, Array<{ name: string; shapeKey?: string }>>();
  const seenKeys = new Set<string>();

  for (const [nodeId, calls] of actionableByNode.entries()) {
    const list: Array<{ name: string; shapeKey?: string }> = [];
    for (const c of calls) {
      const clean = normalizeCallToken(c.name);
      const dedupeKey = `${nodeId}::${clean}::${c.shapeKey ?? ""}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      list.push({ name: c.name, ...(c.shapeKey ? { shapeKey: c.shapeKey } : {}) });
    }
    if (list.length > 0) combined.set(nodeId, list);
  }

  for (const edge of graph.edges) {
    if (edge.targetId || !edge.sourceId) continue;
    if ((edge.scope ?? "USER") !== "USER" || edge.metadata?.crossScopeFiltered) continue;
    if (!edge.entityType || !CONNECTIVITY_TARGET_TYPES.has(edge.entityType)) continue;
    const cls = classifyCallEdgeResolution(edge);
    if (cls === "PLATFORM_PRIMITIVE" || cls === "RESOLVED") continue;
    const clean = normalizeCallToken(edge.name);
    if (!clean) continue;
    const shapeKey = typeof edge.metadata?.shapeKey === "string" ? edge.metadata.shapeKey : undefined;
    const dedupeKey = `${edge.sourceId}::${clean}::${shapeKey ?? ""}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    const list = combined.get(edge.sourceId) ?? [];
    list.push({
      name: edge.entityType === "RENDERS" ? clean : `${clean}()`,
      ...(shapeKey ? { shapeKey } : {}),
    });
    combined.set(edge.sourceId, list);
  }

  return combined;
}

const CUSTOM_LINKS_HUD_DESCRIPTION =
  "Bridges runtime connections static code analysis can't prove—like DI containers, event buses, dynamic callbacks, and external APIs—and unlocks end-to-end flow tracing and full blast radius.";

function humanizeUnhandledPattern(shapeKey?: string): string {
  const sk = shapeKey ?? "";
  if (sk.includes("ElementAccessExpression")) return "Dynamic key lookup";
  if (sk.includes("/Param/")) return "Callback or injected param";
  if (sk.includes("/Import/")) return "Imported registry / DI call";
  if (sk.includes("/This/")) return "Dynamic class member call";
  if (sk.includes("/CallResult/") || sk.includes("/AwaitResult/")) return "Factory or async return call";
  if (sk.includes("/LocalVar/")) return "Runtime variable dispatch";
  return "Dynamic runtime call";
}

function summarizeUnhandledPatternItems(
  hotspotNodes: ReadonlyArray<{ calls: ReadonlyArray<{ shapeKey?: string }> }>,
): PluginHudSummaryItem[] {
  const counts = new Map<string, number>();
  for (const h of hotspotNodes) {
    for (const c of h.calls) {
      const label = humanizeUnhandledPattern(c.shapeKey);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, value: count }));
}

function formatCustomLinksHeadline(
  activeCount: number,
  unhandledCount: number,
  brokenCount: number,
): string {
  if (brokenCount > 0) {
    return `${brokenCount} broken link${brokenCount === 1 ? "" : "s"}${
      unhandledCount > 0 ? ` · ${unhandledCount} unhandled call${unhandledCount === 1 ? "" : "s"}` : ""
    }`;
  }
  if (activeCount > 0 && unhandledCount > 0) {
    return `${activeCount} custom link${activeCount === 1 ? "" : "s"} active · ${unhandledCount} unhandled call${unhandledCount === 1 ? "" : "s"}`;
  }
  if (activeCount > 0) {
    return `${activeCount} custom link${activeCount === 1 ? "" : "s"} active`;
  }
  if (unhandledCount > 0) {
    return `No custom links yet · ${unhandledCount} unhandled call${unhandledCount === 1 ? "" : "s"}`;
  }
  return "No custom links configured";
}

function buildShimPromptAction(
  pkgLabel: string,
  unresolvedCount: number,
  brokenCount: number,
): { label: string; text: string; hint: string } {
  const scopeClause = pkgLabel ? ` for package "${pkgLabel}"` : "";
  if (brokenCount > 0) {
    return {
      label: "Copy repair prompt",
      text: `Use \`chomp_local_shims\` (action: "status")${scopeClause} to inspect the ${brokenCount} unmatched link(s) in \`${LOCAL_SHIMS_FILE_REL}\`, update stale source/target IDs via \`chomp_get_nodes\`, and verify with \`chomp_get_diff\`.`,
      hint: "Ask your agent to fix stale source or target IDs in shims.json.",
    };
  }
  if (unresolvedCount > 0) {
    return {
      label: "Copy agent prompt",
      text: `Use \`chomp_local_shims\` (action: "suggest"${pkgLabel ? `, packageName: "${pkgLabel}"` : ""}) to inspect ${unresolvedCount} unhandled call(s)${scopeClause}, add \`chomp.config.json#conventions\` rules for repeatable syntax or upsert custom links via \`chomp_local_shims\` (action: "upsert"), and verify with \`chomp_get_diff\`.`,
      hint: "Prompt your agent to connect these unhandled calls and unlock complete flows.",
    };
  }
  return {
    label: "Copy agent prompt",
    text: `Use \`chomp_local_shims\` (action: "suggest"${pkgLabel ? `, packageName: "${pkgLabel}"` : ""}) to check for unlinked runtime, event-bus, or DI calls${scopeClause}, or use \`chomp_local_shims\` (action: "upsert") to declare custom links in \`${LOCAL_SHIMS_FILE_REL}\`.`,
    hint: "All static calls are wired. Copy to add manual event-bus, DI, or external API links.",
  };
}

function buildNodeShimPresentation(
  node: StructuralNode,
  outbound: ResolvedShimRecord[],
  inbound: ResolvedShimRecord[],
  remainingCalls: ActionableUnresolvedCall[],
): PluginPresentation {
  const sections: PresentationSection[] = [];

  if (outbound.length > 0) {
    const rows: PresentationTableRow[] = outbound.map((rec) => {
      const ev = primaryEvidence(rec.edgeEntry.evidence);
      return {
        cells: {
          target: stripNodePrefix(rec.targetNode.name),
          type: rec.edgeEntry.entityType,
          resolvedCall: rec.shim.callName ?? (rec.resolvedEdgeIds.length > 0 ? `${rec.resolvedEdgeIds.length} call(s)` : "Direct shim"),
          rationale: rec.shim.rationale ?? "User-defined local shim",
        },
        tone: "good",
        entityId: rec.targetNode.id,
        ...(ev?.filePath
          ? {
              evidence: [
                {
                  filePath: ev.filePath,
                  ...(ev.lineNumber ? { lineNumber: ev.lineNumber } : {}),
                  ...(ev.snippet ? { snippet: ev.snippet } : {}),
                },
              ],
            }
          : {}),
      };
    });
    sections.push({
      id: "outbound-shims",
      title: "Outbound shimmed links",
      badge: { text: String(outbound.length), tone: "good" },
      priority: 10,
      blocks: [
        {
          kind: "table",
          columns: [
            { id: "target", label: "Target" },
            { id: "type", label: "Edge", mono: true },
            { id: "resolvedCall", label: "Call site", mono: true },
            { id: "rationale", label: "Rationale" },
          ],
          rows,
        },
      ],
    });
  }

  if (inbound.length > 0) {
    const items: PresentationListItem[] = inbound.map((rec) => ({
      label: stripNodePrefix(rec.sourceNode.name),
      detail: rec.shim.rationale
        ? `${rec.edgeEntry.entityType} · ${rec.shim.rationale}`
        : `${rec.edgeEntry.entityType} (${rec.shim.id})`,
      tone: "info",
      entityId: rec.sourceNode.id,
    }));
    sections.push({
      id: "inbound-shims",
      title: "Inbound shimmed callers",
      badge: { text: String(inbound.length), tone: "info" },
      priority: 20,
      blocks: [{ kind: "list", items }],
    });
  }

  if (remainingCalls.length > 0) {
    sections.push({
      id: "remaining-unresolved",
      title: "Remaining unresolved calls",
      badge: { text: String(remainingCalls.length), tone: "warn" },
      priority: 30,
      blocks: [
        {
          kind: "list",
          items: remainingCalls.map((c) => ({
            label: c.name,
            detail: [c.reason, c.shapeKey].filter(Boolean).join(" · "),
            tone: "warn",
            ...(c.filePath
              ? {
                  evidence: [
                    {
                      filePath: c.filePath,
                      ...(c.lineNumber ? { lineNumber: c.lineNumber } : {}),
                      ...(c.snippet ? { snippet: c.snippet } : {}),
                    },
                  ],
                }
              : {}),
          })),
        },
      ],
    });
  }

  const totalActive = outbound.length + inbound.length;
  return {
    version: PLUGIN_PRESENTATION_VERSION,
    summary: {
      status: remainingCalls.length > 0 ? "warn" : "ok",
      badge: {
        text: `${totalActive} shim${totalActive === 1 ? "" : "s"}`,
        tone: remainingCalls.length > 0 ? "warn" : "good",
      },
      headline:
        outbound.length > 0
          ? `${outbound.length} outbound shimmed link(s)${remainingCalls.length > 0 ? ` · ${remainingCalls.length} unresolved call(s) remaining` : ""}`
          : `${inbound.length} inbound shimmed caller(s) for ${stripNodePrefix(node.name)}`,
      issueCount: remainingCalls.length,
    },
    sections,
  };
}

export const localShimsPlugin: ChompPlugin = {
  name: LOCAL_SHIMS_PLUGIN_NAME,
  displayName: "Custom links",
  version: "1.0.0",
  order: 10,
  layer: SHIM_OVERLAY_LAYER,
  description: CUSTOM_LINKS_HUD_DESCRIPTION,
  accepts: (filePath: string) =>
    filePath === LOCAL_SHIMS_FILE_REL ||
    filePath === LEGACY_LOCAL_SHIMS_FILE_REL ||
    filePath === "chomp.config.json",
  extract: (ctx: ChompPluginContext) => {
    const includeConfigShims = ctx.settings.includeConfigShims !== false;
    const showHotspotLens = ctx.settings.showUnresolvedHotspotLens !== false;
    const shimsText = ctx.readPluginFile("shims.json") ?? ctx.readFile(LEGACY_LOCAL_SHIMS_FILE_REL);
    const configText = includeConfigShims ? ctx.readFile("chomp.config.json") : null;
    const { shims, parseErrors } = loadLocalShimsFromTexts(shimsText, configText);

    const inputDeps: OverlayInputDependency[] = [];
    const shimsDep = ctx.hashPluginFile("shims.json") ?? ctx.hashFile(LEGACY_LOCAL_SHIMS_FILE_REL);
    if (shimsDep) inputDeps.push(shimsDep);
    if (includeConfigShims) {
      const configDep = ctx.hashFile("chomp.config.json");
      if (configDep) inputDeps.push(configDep);
    }

    const { resolved, unmatched, owningDuByNodeId } = evaluateShimsAgainstGraph(ctx.graph, shims);
    const rawUnresolvedByNode = computeActionableUnresolvedMap(ctx.graph);

    // Group resolved shims by sourceNode and targetNode
    const outboundByNodeId = new Map<string, ResolvedShimRecord[]>();
    const inboundByNodeId = new Map<string, ResolvedShimRecord[]>();
    for (const rec of resolved) {
      const outList = outboundByNodeId.get(rec.sourceNode.id) ?? [];
      outList.push(rec);
      outboundByNodeId.set(rec.sourceNode.id, outList);

      if (!rec.syntheticConnector) {
        const inList = inboundByNodeId.get(rec.targetNode.id) ?? [];
        inList.push(rec);
        inboundByNodeId.set(rec.targetNode.id, inList);
      }
    }

    // Project shims onto a working copy so we can measure exact post-shim unresolved counts!
    const provisionalOverlays = [...outboundByNodeId.entries()].map(([entityId, recs]) => ({
      entityId,
      layer: SHIM_OVERLAY_LAYER,
      payload: {
        shimmedEdges: recs.map((r) => r.edgeEntry),
        syntheticConnectors: recs
          .map((r) => r.syntheticConnector)
          .filter((c): c is StructuralNode => Boolean(c)),
      },
    }));
    const projectedGraph = applyShimOverlaysToGraph(ctx.graph, provisionalOverlays, { enabled: true });
    const postUnresolvedByNode = computeActionableUnresolvedMap(projectedGraph);
    const postShimmableByNode = computeShimmableUnresolvedMap(projectedGraph, postUnresolvedByNode);

    const overlays: EntityOverlayInput[] = [];
    const touchedNodeIds = new Set<string>([
      ...outboundByNodeId.keys(),
      ...inboundByNodeId.keys(),
    ]);
    const nodeById = new Map(ctx.graph.nodes.map((n) => [n.id, n]));

    for (const nodeId of touchedNodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const outbound = outboundByNodeId.get(nodeId) ?? [];
      const inbound = inboundByNodeId.get(nodeId) ?? [];
      const remainingCalls = postUnresolvedByNode.get(nodeId) ?? [];
      const syntheticConnectors = outbound
        .map((r) => r.syntheticConnector)
        .filter((c): c is StructuralNode => Boolean(c));
      const presentation = buildNodeShimPresentation(node, outbound, inbound, remainingCalls);
      const evItems = outbound
        .map((r) => primaryEvidence(r.edgeEntry.evidence))
        .filter((ev): ev is EvidenceRecord => Boolean(ev?.filePath))
        .slice(0, 5)
        .map((ev) => ctx.evidence(ev.filePath, ev.lineNumber, ev.snippet, "user-shim"));

      overlays.push({
        entityId: nodeId,
        layer: SHIM_OVERLAY_LAYER,
        source: LOCAL_SHIMS_PLUGIN_NAME,
        derivation: "INFERRED",
        ...(inputDeps.length > 0 ? { inputs: inputDeps } : {}),
        ...(evItems.length > 0 ? { evidence: evItems } : {}),
        payload: {
          ...(outbound.length > 0 ? { shimmedEdges: outbound.map((r) => r.edgeEntry) } : {}),
          ...(syntheticConnectors.length > 0 ? { syntheticConnectors } : {}),
          shimIds: [...outbound.map((r) => r.shim.id), ...inbound.map((r) => r.shim.id)],
          [PLUGIN_PRESENTATION_PAYLOAD_KEY]: presentation,
        },
      });
    }

    // Build per-DEPLOYMENT_UNIT package overlays so HUD & PackageInspector render cleanly
    const deploymentUnits = ctx.graph.nodes.filter(
      (n) => n.entityType === "DEPLOYMENT_UNIT" && (n.scope ?? "USER") === "USER",
    );

    const totalShimmableRepoGaps = [...postShimmableByNode.values()].reduce(
      (acc, l) => acc + l.length,
      0,
    );
    const totalRepoBroken = unmatched.length + parseErrors.length;
    const repoHeadline = formatCustomLinksHeadline(
      resolved.length,
      totalShimmableRepoGaps,
      totalRepoBroken,
    );
    const repoPrompt = buildShimPromptAction("", totalShimmableRepoGaps, totalRepoBroken);

    for (const du of deploymentUnits) {
      const pkgLabel = stripNodePrefix(du.name);
      const pkgKey = pkgLabel.replace(/^@[^/]+\//, "");
      const pkgResolved = resolved.filter((r) => r.packageId === du.id);
      const pkgUnmatched = unmatched.filter((u) => !u.packageId || u.packageId === du.id);

      let rawGapCount = 0;
      let remainingGapCount = 0;
      let shimmableCount = 0;
      const hotspotNodes: Array<{ node: StructuralNode; calls: ActionableUnresolvedCall[] }> = [];
      const shimmableNodes: Array<{ calls: Array<{ name: string; shapeKey?: string }> }> = [];

      for (const n of ctx.graph.nodes) {
        if ((n.scope ?? "USER") !== "USER") continue;
        const ownerDu = owningDuByNodeId.get(n.id);
        if (ownerDu?.id !== du.id) continue;
        const rawCalls = rawUnresolvedByNode.get(n.id) ?? [];
        const remCalls = postUnresolvedByNode.get(n.id) ?? [];
        const shimmableCalls = postShimmableByNode.get(n.id) ?? [];
        rawGapCount += rawCalls.length;
        remainingGapCount += remCalls.length;
        shimmableCount += shimmableCalls.length;
        if (remCalls.length > 0) {
          hotspotNodes.push({ node: n, calls: remCalls });
        }
        if (shimmableCalls.length > 0) {
          shimmableNodes.push({ calls: shimmableCalls });
        }
      }
      hotspotNodes.sort((a, b) => b.calls.length - a.calls.length || a.node.name.localeCompare(b.node.name));

      const resolvedGapCount = Math.max(0, rawGapCount - remainingGapCount);
      const brokenCount = pkgUnmatched.length + parseErrors.length;
      const issueCount = brokenCount + remainingGapCount;
      const unhandledPatternItems = summarizeUnhandledPatternItems(shimmableNodes);

      let status: "ok" | "warn" | "unknown" = "ok";
      let badgeText = "0 needed";
      let badgeTone: PresentationTone = "good";

      if (brokenCount > 0) {
        status = "warn";
        badgeText = `${brokenCount} broken`;
        badgeTone = "warn";
      } else if (pkgResolved.length > 0 && shimmableCount === 0) {
        status = "ok";
        badgeText = `${pkgResolved.length} active`;
        badgeTone = "good";
      } else if (pkgResolved.length > 0 && shimmableCount > 0) {
        status = "warn";
        badgeText = `${pkgResolved.length} active · ${shimmableCount} unhandled`;
        badgeTone = "warn";
      } else if (shimmableCount > 0) {
        status = "warn";
        badgeText = `${shimmableCount} unhandled`;
        badgeTone = "warn";
      }

      const headline = formatCustomLinksHeadline(
        pkgResolved.length,
        shimmableCount,
        brokenCount,
      );

      const views: PluginSpotlightView[] = [];
      if (pkgResolved.length > 0) {
        const highlightIds: string[] = [];
        const annotations: Record<string, string> = {};
        for (const rec of pkgResolved) {
          if (!highlightIds.includes(rec.sourceNode.id)) highlightIds.push(rec.sourceNode.id);
          if (!rec.syntheticConnector && !highlightIds.includes(rec.targetNode.id)) {
            highlightIds.push(rec.targetNode.id);
          }
          annotations[rec.sourceNode.id] =
            `Linked -> ${stripNodePrefix(rec.targetNode.name)}${rec.shim.rationale ? `: ${rec.shim.rationale}` : ""}`;
        }
        views.push({
          id: "active-shimmed-links",
          title: "Active custom links",
          description: `Stations connected via ${LOCAL_SHIMS_FILE_REL} in ${pkgLabel}`,
          badge: { text: String(pkgResolved.length), tone: "good" },
          highlightNodeIds: highlightIds,
          viewLevel: "package",
          packageName: pkgKey,
          nodeAnnotations: annotations,
          layer: SHIM_OVERLAY_LAYER,
        });
      }

      if (hotspotNodes.length > 0 && showHotspotLens) {
        const annotations: Record<string, string> = {};
        for (const h of hotspotNodes.slice(0, 40)) {
          annotations[h.node.id] = `${h.calls.length} unhandled call(s): ${h.calls
            .slice(0, 3)
            .map((c) => c.name)
            .join(", ")}`;
        }
        views.push({
          id: "unresolved-call-hotspots",
          title: "Unhandled call hotspots",
          description: `Stations in ${pkgLabel} with dynamic or unlinked runtime calls`,
          badge: { text: String(remainingGapCount), tone: "warn" },
          highlightNodeIds: hotspotNodes.slice(0, 40).map((h) => h.node.id),
          viewLevel: "package",
          packageName: pkgKey,
          nodeAnnotations: annotations,
          layer: SHIM_OVERLAY_LAYER,
        });
      }

      const sections: PresentationSection[] = [
        {
          id: "shims-overview",
          title: "Custom links summary",
          priority: 10,
          blocks: [
            {
              kind: "metrics",
              items: [
                {
                  id: "active-shims",
                  label: "Active links",
                  value: pkgResolved.length,
                  unit: "count",
                  tone: pkgResolved.length > 0 ? "good" : "neutral",
                  hint: "Validated custom links projecting L1_SHIMS edges onto this package.",
                  emptyText: "No custom links configured for this package.",
                },
                {
                  id: "bridged-gaps",
                  label: "Bridged gaps",
                  value: resolvedGapCount,
                  unit: "count",
                  tone: resolvedGapCount > 0 ? "good" : "neutral",
                  hint: "Unhandled call sites connected by active custom links.",
                  emptyText: "0 unhandled call sites bridged.",
                },
                {
                  id: "open-gaps",
                  label: "Unhandled calls",
                  value: remainingGapCount,
                  unit: "count",
                  tone: remainingGapCount > 0 ? "warn" : "good",
                  hint: "Unhandled runtime or dynamic calls remaining in this package.",
                  emptyText: "No unhandled calls remain.",
                },
                {
                  id: "broken-shims",
                  label: "Broken links",
                  value: brokenCount,
                  unit: "count",
                  tone: brokenCount > 0 ? "bad" : "good",
                  hint: "Custom links whose source or target no longer matches a graph entity.",
                  emptyText: "All configured links match valid entities.",
                },
              ],
            },
            {
              kind: "text",
              text:
                pkgResolved.length === 0 && brokenCount === 0
                  ? remainingGapCount > 0
                    ? `No custom links configured yet—${remainingGapCount} dynamic or runtime call${remainingGapCount === 1 ? "" : "s"} in this package can be wired via chomp_local_shims to complete story flows and blast radius.`
                    : "No custom links configured for this package. Use Custom links when DI containers, event buses, dynamic callbacks, or external APIs hide runtime connections from static AST parsing."
                  : headline,
              tone: brokenCount > 0 ? "warn" : pkgResolved.length === 0 ? "muted" : "neutral",
            },
          ],
        },
      ];

      if (pkgResolved.length > 0) {
        const { items: cappedRows, totalCount } = capForPresentation(pkgResolved, 50);
        sections.push({
          id: "active-shims-table",
          title: "Active custom links",
          badge: { text: String(pkgResolved.length), tone: "good" },
          priority: 20,
          blocks: [
            {
              kind: "table",
              columns: [
                { id: "source", label: "Source" },
                { id: "target", label: "Target" },
                { id: "type", label: "Edge", mono: true },
                { id: "origin", label: "Origin", mono: true },
              ],
              rows: cappedRows.map((rec) => ({
                cells: {
                  source: stripNodePrefix(rec.sourceNode.name),
                  target: stripNodePrefix(rec.targetNode.name),
                  type: rec.edgeEntry.entityType,
                  origin: rec.shim.origin ?? "shims.json",
                },
                tone: "good",
                entityId: rec.sourceNode.id,
              })),
              maxVisible: 10,
              totalCount,
            },
          ],
        });
      }

      if (brokenCount > 0) {
        const items: PresentationListItem[] = [
          ...parseErrors.map((msg) => ({ label: "Manifest parse issue", detail: msg, tone: "bad" as const })),
          ...pkgUnmatched.map((u) => ({
            label: u.shim.id,
            detail: u.reason,
            tone: "warn" as const,
          })),
        ];
        sections.push({
          id: "broken-shims-list",
          title: "Unmatched / broken shims",
          badge: { text: String(brokenCount), tone: "warn" },
          priority: 25,
          blocks: [{ kind: "list", items }],
        });
      }

      if (hotspotNodes.length > 0 && showHotspotLens) {
        const { items: cappedHotspots, totalCount } = capForPresentation(hotspotNodes, 30);
        sections.push({
          id: "unresolved-hotspots-table",
          title: "Unresolved call hotspots",
          badge: { text: String(remainingGapCount), tone: "warn" },
          priority: 30,
          blocks: [
            {
              kind: "table",
              columns: [
                { id: "contract", label: "Contract" },
                { id: "gaps", label: "Gaps", align: "right" },
                { id: "examples", label: "Unresolved calls", mono: true },
              ],
              rows: cappedHotspots.map((h) => {
                const ev = primaryEvidence(h.node.evidence);
                return {
                  cells: {
                    contract: stripNodePrefix(h.node.name),
                    gaps: h.calls.length,
                    examples: h.calls
                      .slice(0, 2)
                      .map((c) => c.name)
                      .join(", "),
                  },
                  tone: "warn",
                  entityId: h.node.id,
                  ...(ev?.filePath
                    ? {
                        evidence: [
                          {
                            filePath: ev.filePath,
                            ...(ev.lineNumber ? { lineNumber: ev.lineNumber } : {}),
                          },
                        ],
                      }
                    : {}),
                };
              }),
              maxVisible: 8,
              totalCount,
            },
          ],
        });
      }

      const pkgPresentation: PluginPresentation = {
        version: PLUGIN_PRESENTATION_VERSION,
        summary: {
          status,
          badge: { text: badgeText, tone: badgeTone },
          headline,
          repoHeadline,
          description: CUSTOM_LINKS_HUD_DESCRIPTION,
          issueCount,
          metrics: [
            {
              id: "active-shims",
              label: "Active links",
              value: pkgResolved.length,
              unit: "count",
              tone: pkgResolved.length > 0 ? "good" : "neutral",
            },
            {
              id: "bridged-gaps",
              label: "Bridged",
              value: resolvedGapCount,
              unit: "count",
              tone: resolvedGapCount > 0 ? "good" : "neutral",
            },
            {
              id: "open-gaps",
              label: "Unhandled",
              value: remainingGapCount,
              unit: "count",
              tone: remainingGapCount > 0 ? "warn" : "good",
            },
          ],
          ...(unhandledPatternItems.length > 0 ? { items: unhandledPatternItems } : {}),
          ...(views.length > 0 ? { views } : {}),
          prompt: buildShimPromptAction(pkgLabel, remainingGapCount, brokenCount),
          repoPrompt,
        },
        sections,
      };

      overlays.push({
        entityId: du.id,
        layer: SHIM_OVERLAY_LAYER,
        source: LOCAL_SHIMS_PLUGIN_NAME,
        derivation: "INFERRED",
        ...(inputDeps.length > 0 ? { inputs: inputDeps } : {}),
        payload: {
          packageLabel: pkgLabel,
          packageKey: pkgKey,
          activeShimCount: pkgResolved.length,
          bridgedGapCount: resolvedGapCount,
          remainingUnresolvedCount: remainingGapCount,
          brokenShimCount: brokenCount,
          [PLUGIN_PRESENTATION_PAYLOAD_KEY]: pkgPresentation,
        },
      });
    }

    const totalRawGaps = [...rawUnresolvedByNode.values()].reduce((acc, l) => acc + l.length, 0);
    const totalRemainingGaps = [...postUnresolvedByNode.values()].reduce((acc, l) => acc + l.length, 0);

    return {
      overlays,
      summary: {
        configuredShims: shims.length,
        activeShims: resolved.length,
        unmatchedShims: unmatched.length,
        parseErrors,
        rawUnresolvedCallCount: totalRawGaps,
        bridgedCallCount: Math.max(0, totalRawGaps - totalRemainingGaps),
        remainingUnresolvedCallCount: totalRemainingGaps,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// MCP Management Helper (`chomp_local_shims`)
// ---------------------------------------------------------------------------

export type LocalShimsAction = "status" | "suggest" | "validate" | "upsert" | "remove" | "run";

export interface ManageLocalShimsOptions {
  action?: LocalShimsAction;
  repoPath: string;
  repoId?: string;
  repoName?: string;
  storage?: ChompStorage;
  graph: RepresentationGraph;
  shims?: LocalGraphShimInput[];
  shimIds?: string[];
  clearAll?: boolean;
  packageName?: string;
}

function readShimsManifestFile(repoPath: string): { path: string; manifest: LocalShimsManifest } {
  const primaryPath = resolve(repoPath, LOCAL_SHIMS_FILE_REL);
  const legacyPath = resolve(repoPath, LEGACY_LOCAL_SHIMS_FILE_REL);
  const manifestPath = existsSync(primaryPath)
    ? primaryPath
    : existsSync(legacyPath)
      ? legacyPath
      : primaryPath;
  if (!existsSync(manifestPath)) {
    return { path: primaryPath, manifest: { version: 1, shims: [] } };
  }
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    const list = Array.isArray(raw)
      ? raw
      : isObj(raw) && Array.isArray(raw.shims)
        ? raw.shims
        : [];
    return { path: primaryPath, manifest: { version: 1, shims: list } };
  } catch {
    return { path: primaryPath, manifest: { version: 1, shims: [] } };
  }
}

function writeShimsManifestFile(repoPath: string, shims: LocalGraphShimInput[]): string {
  const manifestPath = resolve(repoPath, LOCAL_SHIMS_FILE_REL);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const normalized = shims.map((s) => ({ ...s, id: deriveShimId(s) }));
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ version: 1, shims: normalized }, null, 2)}\n`,
    "utf8",
  );
  return manifestPath;
}

export async function manageLocalShims(options: ManageLocalShimsOptions): Promise<Record<string, unknown>> {
  const action: LocalShimsAction = options.action ?? "status";
  const repoPath = resolve(options.repoPath);
  const repoName = options.repoName ?? resolveRepoName(repoPath);
  const repoId = options.repoId ?? repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const settings = loadPluginSettings(repoPath, LOCAL_SHIMS_PLUGIN_NAME);
  const includeConfigShims = settings.includeConfigShims !== false;
  const configPath = resolve(repoPath, "chomp.config.json");
  const readConfigText = () =>
    includeConfigShims && existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const readManifestText = () => {
    const primary = resolve(repoPath, LOCAL_SHIMS_FILE_REL);
    if (existsSync(primary)) return readFileSync(primary, "utf8");
    const legacy = resolve(repoPath, LEGACY_LOCAL_SHIMS_FILE_REL);
    return existsSync(legacy) ? readFileSync(legacy, "utf8") : null;
  };

  if (action === "suggest") {
    const owningDuByNodeId = buildOwningDuMap(options.graph.nodes);
    const unresolvedByNode = computeActionableUnresolvedMap(options.graph);
    const pkgFilter = options.packageName?.trim().toLowerCase().replace(/^@[^/]+\//, "");

    // Augment actionable KNOWABLE_GAP calls with DYNAMIC_BOUNDARY / runtime-indirect calls
    // (e.g. DI container parameter dispatch `container.chargeCard()`, dynamic registries,
    // `ElementAccessExpression` dispatch) while still excluding standard JS/DOM/Node builtins.
    type SuggestCallItem = {
      name: string;
      shapeKey?: string;
      resolutionClass: string;
      reason: string;
      snippet?: string;
    };
    const combinedByNode = new Map<string, SuggestCallItem[]>();
    const seenKeys = new Set<string>();

    for (const [nodeId, calls] of unresolvedByNode.entries()) {
      const list: SuggestCallItem[] = [];
      for (const c of calls) {
        const clean = normalizeCallToken(c.name);
        const dedupeKey = `${nodeId}::${clean}::${c.shapeKey ?? ""}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        list.push({
          name: c.name,
          ...(c.shapeKey ? { shapeKey: c.shapeKey } : {}),
          resolutionClass: "KNOWABLE_GAP",
          reason: c.reason,
          ...(c.snippet ? { snippet: c.snippet } : {}),
        });
      }
      if (list.length > 0) combinedByNode.set(nodeId, list);
    }

    for (const edge of options.graph.edges) {
      if (edge.targetId || !edge.sourceId) continue;
      if ((edge.scope ?? "USER") !== "USER" || edge.metadata?.crossScopeFiltered) continue;
      if (!edge.entityType || !CONNECTIVITY_TARGET_TYPES.has(edge.entityType)) continue;
      const cls = classifyCallEdgeResolution(edge);
      if (cls === "PLATFORM_PRIMITIVE" || cls === "RESOLVED") continue;
      const clean = normalizeCallToken(edge.name);
      if (!clean) continue;
      const shapeKey = typeof edge.metadata?.shapeKey === "string" ? edge.metadata.shapeKey : undefined;
      const dedupeKey = `${edge.sourceId}::${clean}::${shapeKey ?? ""}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      const ev = primaryEvidence(edge.evidence);
      const list = combinedByNode.get(edge.sourceId) ?? [];
      list.push({
        name: edge.entityType === "RENDERS" ? clean : `${clean}()`,
        ...(shapeKey ? { shapeKey } : {}),
        resolutionClass: cls,
        reason: cls === "DYNAMIC_BOUNDARY" ? "dynamic-boundary" : "unresolved-target",
        ...(ev?.snippet ? { snippet: ev.snippet } : {}),
      });
      combinedByNode.set(edge.sourceId, list);
    }

    const callableTargets = options.graph.nodes.filter(
      (n) =>
        (n.scope ?? "USER") === "USER" &&
        (n.type === "CONTRACT" || n.type === "OPEN_CONNECTOR" || n.entityType === "CLASS") &&
        n.entityType !== "DEPLOYMENT_UNIT",
    );

    const rawSuggestions: SuggestedShimCandidate[] = [];
    for (const [nodeId, calls] of combinedByNode.entries()) {
      const srcNode = options.graph.nodes.find((n) => n.id === nodeId);
      if (!srcNode) continue;
      const du = owningDuByNodeId.get(nodeId);
      const pkgLabel = du ? stripNodePrefix(du.name) : undefined;
      if (pkgFilter) {
        const shortPkg = pkgLabel?.toLowerCase().replace(/^@[^/]+\//, "") ?? "";
        if (shortPkg !== pkgFilter && pkgLabel?.toLowerCase() !== options.packageName?.trim().toLowerCase()) {
          continue;
        }
      }

      const srcEv = primaryEvidence(srcNode.evidence);
      for (const call of calls) {
        const cleanCall = normalizeCallToken(call.name);
        const leafToken = cleanCall.split(".").pop()?.toLowerCase() ?? cleanCall.toLowerCase();
        const candidateTargets =
          leafToken.length >= 3
            ? callableTargets
                .filter((t) => {
                  if (t.id === srcNode.id) return false;
                  const stripped = stripNodePrefix(t.name).toLowerCase();
                  const methodTail = stripped.split(".").pop() ?? stripped;
                  return methodTail === leafToken || stripped === leafToken;
                })
                .slice(0, 5)
            : [];

        const topTarget = candidateTargets[0];
        rawSuggestions.push({
          suggestedShim: {
            sourceId: srcNode.id,
            sourceName: srcNode.name,
            ...(srcEv?.filePath ? { sourceFile: srcEv.filePath } : {}),
            callName: cleanCall,
            ...(call.shapeKey ? { shapeKey: call.shapeKey } : {}),
            ...(topTarget
              ? { targetId: topTarget.id, targetName: topTarget.name }
              : {
                  targetConnector: {
                    name: `External Call: ${cleanCall}`,
                    entityType: "EXTERNAL_SDK_CALL",
                  },
                }),
            entityType: "CALL",
            rationale: topTarget
              ? `Resolves dynamic/indirect call '${call.name}' to '${topTarget.name}'`
              : `Fill in targetId/targetName (via chomp_get_nodes) or targetConnector for '${call.name}'`,
          },
          sourceNode: {
            id: srcNode.id,
            name: srcNode.name,
            entityType: srcNode.entityType,
            ...(pkgLabel ? { packageName: pkgLabel } : {}),
            ...(srcEv?.filePath ? { filePath: srcEv.filePath } : {}),
            ...(srcEv?.lineNumber ? { lineNumber: srcEv.lineNumber } : {}),
          },
          unresolvedCall: {
            name: call.name,
            ...(call.shapeKey ? { shapeKey: call.shapeKey } : {}),
            resolutionClass: call.resolutionClass,
            reason: call.reason,
            ...(call.snippet ? { snippet: call.snippet } : {}),
          },
          candidateTargets: candidateTargets.map((t) => {
            const tDu = owningDuByNodeId.get(t.id);
            const tEv = primaryEvidence(t.evidence);
            return {
              id: t.id,
              name: t.name,
              entityType: t.entityType,
              ...(tDu ? { packageName: stripNodePrefix(tDu.name) } : {}),
              ...(tEv?.filePath ? { filePath: tEv.filePath } : {}),
            };
          }),
          guidance:
            "If this call pattern repeats across multiple files (e.g. a custom router, wrapper, or ORM helper), call `chomp_get_conventions` and declare a `chomp.config.json#conventions` rule instead of per-call shims. Use `chomp_local_shims` (`action: 'upsert'`) for true runtime DI, dynamic dispatch, or one-off external exits.",
        });
      }
    }

    // Prioritize high-signal intra-repo candidate matches first, then KNOWABLE_GAP, then DYNAMIC_BOUNDARY.
    rawSuggestions.sort((a, b) => {
      const aHasTarget = a.candidateTargets.length > 0 ? 1 : 0;
      const bHasTarget = b.candidateTargets.length > 0 ? 1 : 0;
      if (bHasTarget !== aHasTarget) return bHasTarget - aHasTarget;
      const aKnowable = a.unresolvedCall.resolutionClass === "KNOWABLE_GAP" ? 1 : 0;
      const bKnowable = b.unresolvedCall.resolutionClass === "KNOWABLE_GAP" ? 1 : 0;
      return bKnowable - aKnowable;
    });

    const suggestions = rawSuggestions.slice(0, 40);
    return {
      action: "suggest",
      manifestPath: LOCAL_SHIMS_FILE_REL,
      totalSuggestions: suggestions.length,
      suggestions,
    };
  }

  if (action === "validate") {
    const incoming = (options.shims ?? [])
      .map((s) => normalizeShimEntry(s, "shims.json"))
      .filter((s): s is LocalGraphShim => s !== null);
    const { resolved, unmatched } = evaluateShimsAgainstGraph(options.graph, incoming);
    return {
      action: "validate",
      valid: unmatched.length === 0 && incoming.length === (options.shims?.length ?? 0),
      submittedCount: options.shims?.length ?? 0,
      resolvedCount: resolved.length,
      unmatchedCount: unmatched.length,
      resolved: resolved.map((r) => ({
        id: r.shim.id,
        sourceId: r.sourceNode.id,
        sourceName: r.sourceNode.name,
        targetId: r.targetNode.id,
        targetName: r.targetNode.name,
        resolvedEdgeCount: r.resolvedEdgeIds.length,
        syntheticConnector: Boolean(r.syntheticConnector),
      })),
      unmatched: unmatched.map((u) => ({ id: u.shim.id, reason: u.reason })),
    };
  }

  if (action === "upsert") {
    const incoming = options.shims ?? [];
    if (incoming.length === 0) {
      throw new Error("`shims` array must contain at least one shim entry when action is 'upsert'.");
    }
    const { manifest } = readShimsManifestFile(repoPath);
    const byId = new Map<string, LocalGraphShimInput>();
    for (const existing of manifest.shims) {
      byId.set(deriveShimId(existing), { ...existing, id: deriveShimId(existing) });
    }
    for (const next of incoming) {
      const normalized = normalizeShimEntry(next, "shims.json");
      if (!normalized) {
        throw new Error(
          "Invalid shim entry: every shim must specify (`sourceId` or `sourceName`) and (`targetId`, `targetName`, or `targetConnector`).",
        );
      }
      const { origin: _drop, ...clean } = normalized;
      byId.set(normalized.id, clean);
    }
    const updatedList = [...byId.values()];
    const writtenPath = writeShimsManifestFile(repoPath, updatedList);
    const pluginRun = await runChompPlugin(localShimsPlugin, {
      repoPath,
      repoId,
      repoName,
      storage: options.storage,
      graph: options.graph,
      persist: Boolean(options.storage),
    });

    return {
      action: "upsert",
      manifestPath: LOCAL_SHIMS_FILE_REL,
      absoluteManifestPath: writtenPath,
      manifestFileHash: computeFileOverlayHash(repoPath, LOCAL_SHIMS_FILE_REL)?.hash ?? null,
      upsertedCount: incoming.length,
      totalManifestShims: updatedList.length,
      pluginRun: pluginRun.summary,
    };
  }

  if (action === "remove") {
    const idsToRemove = new Set((options.shimIds ?? []).map((id) => id.trim()).filter(Boolean));
    if (!options.clearAll && idsToRemove.size === 0) {
      throw new Error("Pass `shimIds` (or `clearAll: true`) when action is 'remove'.");
    }
    const { manifest } = readShimsManifestFile(repoPath);
    const beforeCount = manifest.shims.length;
    const remaining = options.clearAll
      ? []
      : manifest.shims.filter((s) => !idsToRemove.has(deriveShimId(s)));
    writeShimsManifestFile(repoPath, remaining);

    const pluginRun = await runChompPlugin(localShimsPlugin, {
      repoPath,
      repoId,
      repoName,
      storage: options.storage,
      graph: options.graph,
      persist: Boolean(options.storage),
    });

    return {
      action: "remove",
      manifestPath: LOCAL_SHIMS_FILE_REL,
      removedCount: beforeCount - remaining.length,
      remainingManifestShims: remaining.length,
      pluginRun: pluginRun.summary,
    };
  }

  if (action === "run") {
    const pluginRun = await runChompPlugin(localShimsPlugin, {
      repoPath,
      repoId,
      repoName,
      storage: options.storage,
      graph: options.graph,
      persist: Boolean(options.storage),
    });
    return {
      action: "run",
      manifestPath: LOCAL_SHIMS_FILE_REL,
      overlayCount: pluginRun.overlayCount,
      summary: pluginRun.summary,
    };
  }

  // Default: action === "status"
  const { shims, parseErrors } = loadLocalShimsFromTexts(readManifestText(), readConfigText());
  const { resolved, unmatched } = evaluateShimsAgainstGraph(options.graph, shims);
  const rawUnresolved = computeActionableUnresolvedMap(options.graph);
  const provisionalOverlays = resolved.map((r) => ({
    entityId: r.sourceNode.id,
    layer: SHIM_OVERLAY_LAYER,
    payload: {
      shimmedEdges: [r.edgeEntry],
      ...(r.syntheticConnector ? { syntheticConnectors: [r.syntheticConnector] } : {}),
    },
  }));
  const projectedGraph = applyShimOverlaysToGraph(options.graph, provisionalOverlays, { enabled: true });
  const postUnresolved = computeActionableUnresolvedMap(projectedGraph);

  const rawGapCount = [...rawUnresolved.values()].reduce((acc, l) => acc + l.length, 0);
  const remainingGapCount = [...postUnresolved.values()].reduce((acc, l) => acc + l.length, 0);

  return {
    action: "status",
    layer: SHIM_OVERLAY_LAYER,
    pluginName: LOCAL_SHIMS_PLUGIN_NAME,
    manifestPath: LOCAL_SHIMS_FILE_REL,
    manifestExists:
      existsSync(resolve(repoPath, LOCAL_SHIMS_FILE_REL)) ||
      existsSync(resolve(repoPath, LEGACY_LOCAL_SHIMS_FILE_REL)),
    configuredShimCount: shims.length,
    activeShimCount: resolved.length,
    unmatchedShimCount: unmatched.length,
    parseErrors,
    rawUnresolvedCallCount: rawGapCount,
    bridgedCallCount: Math.max(0, rawGapCount - remainingGapCount),
    remainingUnresolvedCallCount: remainingGapCount,
    activeShims: resolved.map((r) => ({
      id: r.shim.id,
      origin: r.shim.origin,
      sourceId: r.sourceNode.id,
      sourceName: r.sourceNode.name,
      targetId: r.targetNode.id,
      targetName: r.targetNode.name,
      entityType: r.edgeEntry.entityType,
      resolvedEdgeCount: r.resolvedEdgeIds.length,
      rationale: r.shim.rationale ?? null,
    })),
    unmatchedShims: unmatched.map((u) => ({
      id: u.shim.id,
      origin: u.shim.origin,
      reason: u.reason,
    })),
  };
}
