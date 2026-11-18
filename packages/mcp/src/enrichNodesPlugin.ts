/**
 * packages/mcp/src/enrichNodesPlugin.ts
 *
 * Node Enrichment Plugin (`L1_SEMANTIC` / `source: 'enrich-nodes'`)
 * Enforces [PAT-DB-03], [PAT-DB-05], [PAT-MCP-08], [PAT-VIS-24], [PAT-VIS-25], [PAT-VIS-26], [PAT-VIS-36].
 *
 * Synthesizes Plugin Presentation Contract v1 (`payload.presentation`) for Layer 1 semantic
 * enrichments (`chomp_enrich_nodes` / `AI_HYPOTHESIS` rows in `entity_overlays`) without ever
 * overwriting or pruning the underlying `AI_HYPOTHESIS` rows:
 *   - Scoped strictly to `PackageInspectorDrawer` (`inspectorScopes: ["package"]`) because node-level
 *     semantic labels and summaries write directly to the node's primary title, alias, and description.
 *   - Surfaces a clean HUD status dot (no canvas Spotlight views) with un-enriched node count, concise
 *     value description, and copyable agent prompt instructions.
 *   - Renders a streamlined 3-metric Package Inspector card (`Coverage`, `Enriched`, `Stale`) with
 *     skimmable click-through line items.
 */

import {
  PLUGIN_PRESENTATION_PAYLOAD_KEY,
  PLUGIN_PRESENTATION_VERSION,
  capForPresentation,
  type PluginPresentation,
  type PresentationListItem,
  type PresentationSection,
  type PresentationTone,
  type StructuralNode,
} from "@chomp/core";
import type { EntityOverlayInput, EntityOverlayRecord } from "@chomp/db";
import type {
  ChompPlugin,
  ChompPluginContext,
} from "./pluginRunner.js";

export const ENRICH_NODES_PLUGIN_NAME = "enrich-nodes" as const;
export const SEMANTIC_OVERLAY_LAYER = "L1_SEMANTIC" as const;

const ENRICH_HUD_DESCRIPTION =
  "Replaces raw code identifiers with plain-English station names and concise role summaries on the board and in inspectors, automatically flagging descriptions that drift when code changes.";

interface AggregatedNodeEnrichment {
  entityId: string;
  domain?: string;
  humanLabel?: string;
  summary?: string;
  rationale?: string;
  bodyHash: string | null;
  stale: boolean;
  staleReason?: "bodyHash_drift" | "marked_stale";
  producerSources: string[];
  updatedAt?: string;
}

function stripNodePrefix(name: string): string {
  const idx = name.indexOf(":");
  return idx >= 0 ? name.slice(idx + 1).trim() : name.trim();
}

function formatShortDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function formatStaleDetail(sem: AggregatedNodeEnrichment): string {
  const shortDate = formatShortDate(sem.updatedAt);
  if (sem.staleReason === "bodyHash_drift") {
    return shortDate ? `Code modified since ${shortDate}` : "Code modified since enrichment";
  }
  return shortDate ? `Marked stale · ${shortDate}` : "Marked stale";
}

function formatEnrichHeadline(
  enrichedCount: number,
  unenrichedCount: number,
  staleCount: number,
  totalCount: number,
): string {
  if (totalCount === 0) return "No nodes in scope";
  if (enrichedCount === 0) {
    return `No nodes enriched yet · ${unenrichedCount} ready`;
  }
  if (unenrichedCount > 0) {
    const base = `${unenrichedCount} node${unenrichedCount === 1 ? "" : "s"} not enriched`;
    return staleCount > 0 ? `${base} · ${staleCount} stale` : base;
  }
  if (staleCount > 0) {
    return `${staleCount} stale node${staleCount === 1 ? "" : "s"} need refresh`;
  }
  return `All ${totalCount} node${totalCount === 1 ? "" : "s"} enriched`;
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

function aggregateSemanticOverlays(
  existingOverlays: readonly EntityOverlayRecord[],
  nodeById: Map<string, StructuralNode>,
  flagStaleDrift: boolean = true,
): Map<string, AggregatedNodeEnrichment> {
  const byEntity = new Map<string, AggregatedNodeEnrichment>();

  for (const ov of existingOverlays) {
    if (ov.layer !== SEMANTIC_OVERLAY_LAYER) continue;
    if (ov.source === ENRICH_NODES_PLUGIN_NAME) continue;
    const p = ov.payload ?? {};
    const domain = typeof p.domain === "string" && p.domain.trim() ? p.domain.trim() : undefined;
    const humanLabel =
      typeof p.humanLabel === "string" && p.humanLabel.trim() ? p.humanLabel.trim() : undefined;
    const summary = typeof p.summary === "string" && p.summary.trim() ? p.summary.trim() : undefined;
    const rationale =
      typeof p.rationale === "string" && p.rationale.trim() ? p.rationale.trim() : undefined;

    if (!domain && !humanLabel && !summary && !rationale) continue;

    const node = nodeById.get(ov.entityId);
    const currentBodyHash =
      typeof node?.metadata?.bodyHash === "string" ? node.metadata.bodyHash : null;
    const drifted = Boolean(ov.bodyHash && currentBodyHash && ov.bodyHash !== currentBodyHash);
    const computedStale = flagStaleDrift && (Boolean(ov.stale) || drifted);
    const staleReason: AggregatedNodeEnrichment["staleReason"] = computedStale
      ? drifted
        ? "bodyHash_drift"
        : "marked_stale"
      : undefined;

    const prev = byEntity.get(ov.entityId);
    if (!prev) {
      byEntity.set(ov.entityId, {
        entityId: ov.entityId,
        ...(domain ? { domain } : {}),
        ...(humanLabel ? { humanLabel } : {}),
        ...(summary ? { summary } : {}),
        ...(rationale ? { rationale } : {}),
        bodyHash: ov.bodyHash ?? null,
        stale: computedStale,
        ...(staleReason ? { staleReason } : {}),
        producerSources: [ov.source],
        updatedAt: ov.updatedAt,
      });
    } else {
      if (domain) prev.domain = domain;
      if (humanLabel) prev.humanLabel = humanLabel;
      if (summary) prev.summary = summary;
      if (rationale) prev.rationale = rationale;
      if (ov.bodyHash) prev.bodyHash = ov.bodyHash;
      if (computedStale) {
        prev.stale = true;
        if (drifted || !prev.staleReason) {
          prev.staleReason = drifted ? "bodyHash_drift" : "marked_stale";
        }
      }
      if (!prev.producerSources.includes(ov.source)) prev.producerSources.push(ov.source);
      if (ov.updatedAt && (!prev.updatedAt || ov.updatedAt > prev.updatedAt)) {
        prev.updatedAt = ov.updatedAt;
      }
    }
  }

  return byEntity;
}

function buildEnrichmentPrompt(params: {
  scopeLabel: string;
  pkgKey?: string;
  enrichedCount: number;
  staleCount: number;
  unenrichedCount: number;
}): { label: string; text: string; hint: string } {
  const { scopeLabel, pkgKey, enrichedCount, staleCount, unenrichedCount } = params;
  const pkgArg = pkgKey ? `packageName: "${pkgKey}"` : "";
  if (enrichedCount === 0 && unenrichedCount > 0) {
    return {
      label: "Copy agent prompt",
      text: `Enrich the ${unenrichedCount} un-enriched node${unenrichedCount === 1 ? "" : "s"} in ${scopeLabel}: call \`chomp_get_nodes\`${pkgArg ? ` (${pkgArg})` : ""} and save plain-English \`humanLabel\` and \`summary\` descriptions via \`chomp_enrich_nodes\`.`,
      hint: "Prompt your agent to generate plain-English station names and role summaries.",
    };
  }
  if (staleCount > 0 && unenrichedCount === 0) {
    return {
      label: "Copy stale refresh prompt",
      text: `Refresh ${staleCount} stale node enrichment${staleCount === 1 ? "" : "s"} in ${scopeLabel}: call \`chomp_get_nodes\` (${pkgArg ? `${pkgArg}, ` : ""}layer: "L1_SEMANTIC") to find \`stale: true\` contracts, inspect their updated code, and update \`humanLabel\` and \`summary\` via \`chomp_enrich_nodes\`.`,
      hint: "Ask your agent to refresh stale node names and summaries via chomp_enrich_nodes.",
    };
  }
  if (unenrichedCount > 0) {
    return {
      label: "Copy agent prompt",
      text: `Enrich ${unenrichedCount} un-enriched node${unenrichedCount === 1 ? "" : "s"}${staleCount > 0 ? ` and refresh ${staleCount} stale node${staleCount === 1 ? "" : "s"}` : ""} in ${scopeLabel}: call \`chomp_get_nodes\`${pkgArg ? ` (${pkgArg})` : ""} and save plain-English \`humanLabel\` and \`summary\` descriptions via \`chomp_enrich_nodes\`.`,
      hint: "Ask your agent to name and summarize the remaining un-enriched nodes.",
    };
  }
  return {
    label: "Copy refresh prompt",
    text: `Review node enrichments in ${scopeLabel} via \`chomp_get_nodes\`${pkgArg ? ` (${pkgArg})` : ""} and update any labels or summaries with \`chomp_enrich_nodes\`.`,
    hint: "All stations are named. Prompt your agent anytime to refine descriptions.",
  };
}

export const enrichNodesPlugin: ChompPlugin = {
  name: ENRICH_NODES_PLUGIN_NAME,
  displayName: "Enrich nodes",
  version: "1.0.0",
  order: 20,
  layer: SEMANTIC_OVERLAY_LAYER,
  inspectorScopes: ["package"],
  description: ENRICH_HUD_DESCRIPTION,
  accepts: () => false,
  extract: (ctx: ChompPluginContext) => {
    const flagStaleDrift = ctx.settings.flagStaleDrift !== false;
    const hideHudWhenEnriched = ctx.settings.hideHudWhenEnriched === true;
    const nodeById = new Map(ctx.graph.nodes.map((n) => [n.id, n]));
    const owningDuByNodeId = buildOwningDuMap(ctx.graph.nodes);
    const enrichedByNodeId = aggregateSemanticOverlays(
      ctx.existingOverlays,
      nodeById,
      flagStaleDrift,
    );

    const deploymentUnits = ctx.graph.nodes.filter(
      (n) => n.entityType === "DEPLOYMENT_UNIT" && (n.scope ?? "USER") === "USER",
    );

    interface DuBucket {
      du: StructuralNode;
      pkgLabel: string;
      pkgKey: string;
      totalCount: number;
      enrichedNodes: Array<{ node: StructuralNode; sem: AggregatedNodeEnrichment }>;
      unenrichedNodes: StructuralNode[];
      staleNodes: Array<{ node: StructuralNode; sem: AggregatedNodeEnrichment }>;
    }

    const buckets: DuBucket[] = [];
    let repoTargetCount = 0;
    let repoEnrichedCount = 0;
    let repoUnenrichedCount = 0;
    let repoStaleCount = 0;

    for (const du of deploymentUnits) {
      const pkgLabel = stripNodePrefix(du.name);
      const pkgKey = pkgLabel.replace(/^@[^/]+\//, "");

      const targetNodes = ctx.graph.nodes.filter(
        (n) =>
          (n.scope ?? "USER") === "USER" &&
          (n.type === "CONTRACT" || n.entityType === "CLASS") &&
          n.entityType !== "DEPLOYMENT_UNIT" &&
          owningDuByNodeId.get(n.id)?.id === du.id,
      );

      const enrichedNodes: Array<{ node: StructuralNode; sem: AggregatedNodeEnrichment }> = [];
      const unenrichedNodes: StructuralNode[] = [];

      for (const n of targetNodes) {
        const sem = enrichedByNodeId.get(n.id);
        if (sem) {
          enrichedNodes.push({ node: n, sem });
        } else {
          unenrichedNodes.push(n);
        }
      }

      const staleNodes = enrichedNodes.filter((e) => e.sem.stale);
      repoTargetCount += targetNodes.length;
      repoEnrichedCount += enrichedNodes.length;
      repoUnenrichedCount += unenrichedNodes.length;
      repoStaleCount += staleNodes.length;

      buckets.push({
        du,
        pkgLabel,
        pkgKey,
        totalCount: targetNodes.length,
        enrichedNodes,
        unenrichedNodes,
        staleNodes,
      });
    }

    const repoHeadline = formatEnrichHeadline(
      repoEnrichedCount,
      repoUnenrichedCount,
      repoStaleCount,
      repoTargetCount,
    );
    const repoPrompt =
      repoTargetCount > 0
        ? buildEnrichmentPrompt({
            scopeLabel: `repository "${ctx.repoName}"`,
            enrichedCount: repoEnrichedCount,
            staleCount: repoStaleCount,
            unenrichedCount: repoUnenrichedCount,
          })
        : undefined;

    const overlays: EntityOverlayInput[] = [];

    for (const bucket of buckets) {
      const {
        du,
        pkgLabel,
        pkgKey,
        totalCount,
        enrichedNodes,
        unenrichedNodes,
        staleNodes,
      } = bucket;
      const enrichedCount = enrichedNodes.length;
      const unenrichedCount = unenrichedNodes.length;
      const staleCount = staleNodes.length;
      const coveragePct = totalCount > 0 ? Math.round((enrichedCount / totalCount) * 100) : null;

      let status: "ok" | "warn" | "n/a" = "ok";
      let badgeText = "0 nodes";
      let badgeTone: PresentationTone = "muted";

      if (totalCount === 0) {
        status = "n/a";
        badgeText = "N/A";
        badgeTone = "muted";
      } else if (unenrichedCount > 0 || staleCount > 0) {
        status = "warn";
        badgeText =
          staleCount > 0
            ? `${unenrichedCount} missing · ${staleCount} stale`
            : `${unenrichedCount} not enriched`;
        badgeTone = "warn";
      } else {
        status = "ok";
        badgeText = `${coveragePct}% enriched`;
        badgeTone = "good";
      }

      const headline = formatEnrichHeadline(
        enrichedCount,
        unenrichedCount,
        staleCount,
        totalCount,
      );

      const { items: unenrichedItems, totalCount: totalUnenrichedItems } =
        capForPresentation<PresentationListItem>(
          unenrichedNodes.map((n) => ({
            label: stripNodePrefix(n.name),
            detail: "Not enriched",
            tone: "neutral",
            entityId: n.id,
          })),
          30,
        );

      const { items: minimalEnrichedItems, totalCount: totalEnrichedItems } =
        capForPresentation<PresentationListItem>(
          enrichedNodes.map(({ node, sem }) => ({
            label: sem.humanLabel ?? stripNodePrefix(node.name),
            entityId: node.id,
          })),
          20,
        );

      const { items: staleItems, totalCount: totalStaleItems } =
        capForPresentation<PresentationListItem>(
          staleNodes.map(({ node, sem }) => ({
            label: sem.humanLabel ?? stripNodePrefix(node.name),
            detail: formatStaleDetail(sem),
            tone: "warn",
            entityId: node.id,
          })),
          30,
        );

      const sections: PresentationSection[] = [
        {
          id: "enrichment-overview",
          title: "Semantic coverage",
          priority: 10,
          blocks: [
            {
              kind: "metrics",
              items: [
                {
                  id: "semantic-coverage",
                  label: "Coverage",
                  value: coveragePct,
                  unit: "%",
                  tone:
                    coveragePct === null
                      ? "muted"
                      : coveragePct === 100
                        ? "good"
                        : coveragePct > 0
                          ? "info"
                          : "warn",
                  hint: "Share of nodes in this package with semantic names and summaries.",
                  items: unenrichedItems,
                  maxVisible: 6,
                  totalCount: totalUnenrichedItems,
                  emptyText:
                    totalCount === 0
                      ? "No nodes in this package."
                      : "All nodes in this package are enriched.",
                },
                {
                  id: "enriched-count",
                  label: "Enriched",
                  value: enrichedCount,
                  unit: "count",
                  tone: enrichedCount > 0 ? "good" : "neutral",
                  hint: "Nodes with plain-English labels or summaries.",
                  items: minimalEnrichedItems,
                  maxVisible: 5,
                  totalCount: totalEnrichedItems,
                  emptyText:
                    "No stations enriched yet—prompt your agent with chomp_enrich_nodes to add plain-English names and summaries.",
                },
                {
                  id: "stale-count",
                  label: "Stale",
                  value: staleCount,
                  unit: "count",
                  tone: staleCount > 0 ? "warn" : "good",
                  hint: "Nodes modified since their enrichment was written.",
                  items: staleItems,
                  maxVisible: 6,
                  totalCount: totalStaleItems,
                  emptyText: "No stale nodes.",
                },
              ],
            },
            ...(enrichedCount === 0 && totalCount > 0
              ? [
                  {
                    kind: "text" as const,
                    text: "No stations in this package are enriched yet. Prompt your agent with chomp_enrich_nodes to translate raw code symbols into plain-English station names and concise role summaries—Chomp tracks code changes automatically so stale descriptions are flagged.",
                    tone: "muted" as const,
                  },
                ]
              : []),
          ],
        },
      ];

      const promptAction =
        totalCount > 0
          ? buildEnrichmentPrompt({
              scopeLabel: `package "${pkgLabel}"`,
              pkgKey,
              enrichedCount,
              staleCount,
              unenrichedCount,
            })
          : undefined;

      const pkgPresentation: PluginPresentation = {
        version: PLUGIN_PRESENTATION_VERSION,
        summary: {
          status,
          badge: { text: badgeText, tone: badgeTone },
          headline,
          repoHeadline,
          description: ENRICH_HUD_DESCRIPTION,
          issueCount: staleCount,
          ...(promptAction ? { prompt: promptAction } : {}),
          ...(repoPrompt ? { repoPrompt } : {}),
          ...(hideHudWhenEnriched &&
          totalCount > 0 &&
          unenrichedCount === 0 &&
          staleCount === 0
            ? { hideInHud: true }
            : {}),
        },
        sections,
      };

      overlays.push({
        entityId: du.id,
        layer: SEMANTIC_OVERLAY_LAYER,
        source: ENRICH_NODES_PLUGIN_NAME,
        derivation: "EXTRACTED",
        payload: {
          packageLabel: pkgLabel,
          packageKey: pkgKey,
          totalContracts: totalCount,
          enrichedContracts: enrichedCount,
          unenrichedContracts: unenrichedCount,
          staleContracts: staleCount,
          [PLUGIN_PRESENTATION_PAYLOAD_KEY]: pkgPresentation,
        },
      });
    }

    return {
      overlays,
      summary: {
        totalContracts: repoTargetCount,
        enrichedContracts: repoEnrichedCount,
        unenrichedContracts: repoUnenrichedCount,
        staleContracts: repoStaleCount,
        coveragePct: repoTargetCount > 0 ? Math.round((repoEnrichedCount / repoTargetCount) * 100) : null,
      },
    };
  },
};
