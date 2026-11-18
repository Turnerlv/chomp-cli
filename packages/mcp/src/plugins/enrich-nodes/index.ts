/**
 * packages/mcp/src/plugins/enrich-nodes/index.ts
 *
 * Self-contained `enrich-nodes` plugin module (`L1_SEMANTIC`).
 * Auto-discovered from `packages/mcp/src/plugins/` with zero external plumbing:
 *   - State & settings folder: `.chomp/plugins/enrich-nodes/` (`settings.json`)
 *   - Declarative Settings UI (`settingsSchema`)
 *   - Inspector & HUD Presentation (`PluginPresentation` v1, including honest `Un-enriched` state)
 *   - Active View Spotlight (`ctx.setActiveView` + per-domain `summary.views`)
 *   - Owned MCP tool (`chomp_enrich_nodes`)
 *   - Owned CLI summary formatter (`formatCliSummary`)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  ENRICH_NODES_PLUGIN_NAME,
  SEMANTIC_OVERLAY_LAYER,
  enrichNodesPlugin,
} from "../../enrichNodesPlugin.js";
import { formatEnrichNodesSummary } from "../../intelligence.js";
import { defineChompPlugin } from "../../pluginRunner.js";

export const enrichNodesPluginModule = defineChompPlugin({
  ...enrichNodesPlugin,
  defaultEnabled: true,
  scanRepoFiles: false,
  settingsSchema: [
    {
      key: "flagStaleDrift",
      label: "Flag bodyHash drift as stale",
      description:
        "Mark semantic enrichments as Stale when a contract's AST bodyHash changes after enrichment.",
      kind: "boolean",
      defaultValue: true,
    },
    {
      key: "hideHudWhenEnriched",
      label: "Hide HUD row when complete",
      description:
        "Hide Enrich nodes in the compact HUD once all nodes are enriched and fresh (remains visible in Package Inspector & Settings).",
      kind: "boolean",
      defaultValue: false,
    },
  ],
  formatCliSummary: (res, ansi) => {
    const s = res.summary ?? {};
    if (typeof s.totalContracts !== "number") return [];
    const pct = s.coveragePct === null || s.coveragePct === undefined ? "N/A" : `${s.coveragePct}%`;
    return [
      `${ansi.dim("Semantic:")}      ${ansi.bold(pct)} enriched (${s.enrichedContracts ?? 0}/${s.totalContracts} contracts)  ·  ${
        (s.staleContracts ?? 0) === 0
          ? ansi.green("0 stale")
          : ansi.yellow(`${s.staleContracts} stale`)
      }`,
    ];
  },
  mcpTools: [
    {
      name: "chomp_enrich_nodes",
      description:
        "NODE ENRICHMENT PLUGIN (`L1_SEMANTIC`, [PAT-DB-03], [PAT-DB-05], [PAT-VIS-36]): Updates node overlays in the `entity_overlays` database table (domains, human labels, summaries, rationale, or extensible multi-layer/plugin overlays across `L1_PORTS`, `L1_SEMANTIC`, `L1_DESIGN_SYSTEM`, `L2_RUNTIME`, `L3_INFRA`, and `PLUGIN:*`), refreshes the `enrich-nodes` Layer 1 presentation overlays in `.chomp/graph.db`, AND/OR creates classification & folding rules in `.chomp/rules.json` (middleware diamond badges, component 4-diamond badges, micro-nodes, or full station promotion).",
      inputSchema: {
        nodes: z
          .array(
            z.object({
              nodeId: z.string(),
              domain: z.string().optional(),
              humanLabel: z.string().optional(),
              summary: z.string().optional(),
              rationale: z.string().optional(),
              action: z
                .enum(["middleware_badge", "component_badge", "micro_node", "station_node"])
                .optional()
                .describe(
                  "Optional classification rule action for this node (`middleware_badge` = ◆ diamond badge, `component_badge` = ❖ 4-diamond badge, `micro_node` = ● micro-node, `station_node` = unroll as full station)"
                ),
              badgeLabel: z
                .string()
                .optional()
                .describe(
                  "Optional badge label when action is `middleware_badge` or `component_badge` (e.g. 'auth', 'protected', 'rate-limited')"
                ),
              badgeMode: z
                .enum(["fold_into_callers", "badge_on_node"])
                .optional()
                .describe(
                  "`fold_into_callers` folds leaf guards/components into callers; `badge_on_node` attaches the badge directly onto the matched station"
                ),
            })
          )
          .optional()
          .describe("Array of nodes to enrich or classify"),
        overlays: z
          .array(
            z.object({
              entityId: z.string().describe("Target node or edge ID"),
              layer: z
                .string()
                .default("L1_SEMANTIC")
                .describe(
                  "Overlay layer: L1_PORTS, L1_SEMANTIC, L1_DESIGN_SYSTEM, L2_RUNTIME, L3_INFRA, or PLUGIN:<name>"
                ),
              source: z
                .string()
                .default("agent")
                .describe(
                  "Overlay producer/plugin identifier (e.g. 'chomp_enrich_nodes', 'datadog', 'design-system', 'openapi')"
                ),
              environment: z
                .string()
                .default("default")
                .describe("Target environment (e.g. 'default', 'production', 'staging', 'local')"),
              payload: z
                .record(z.any())
                .describe(
                  "Structured JSON overlay payload (e.g. { p95Ms, errorRate, rps }, { inputTypes, outputType }, { title, kv, metrics, tags })"
                ),
              bodyHash: z
                .string()
                .nullable()
                .optional()
                .describe("Optional AST bodyHash at time of analysis for staleness tracking"),
              derivation: z
                .enum(["EXTRACTED", "INFERRED", "AI_HYPOTHESIS"])
                .optional()
                .describe("Epistemic provenance: EXTRACTED, INFERRED, or AI_HYPOTHESIS"),
              inputs: z
                .array(
                  z.object({
                    path: z.string(),
                    hash: z.string(),
                  })
                )
                .optional()
                .describe("Optional list of external non-AST input files ({ path, hash }) that this overlay depends on"),
              evidence: z
                .array(
                  z.object({
                    filePath: z.string(),
                    lineNumber: z.number().optional(),
                    snippet: z.string().optional(),
                    evidenceRole: z.string().optional(),
                  })
                )
                .optional()
                .describe("Optional source file and line evidence references"),
              runId: z.string().optional().describe("Optional run/commit identifier for prune-on-recommit"),
              pruneStaleBySource: z
                .boolean()
                .optional()
                .describe("When true, prunes obsolete rows from prior runs for this (layer, source, environment)"),
              merge: z
                .boolean()
                .optional()
                .describe("When true (default), merges payload into existing overlay for the same key"),
            })
          )
          .optional()
          .describe("Extensible multi-layer and plugin overlays to upsert into `entity_overlays`"),
        runId: z
          .string()
          .optional()
          .describe("Optional batch run identifier applied to all overlays in this call for prune-on-recommit"),
        pruneStaleBySource: z
          .boolean()
          .optional()
          .describe(
            "When true (default when runId is provided), prunes obsolete overlay rows from prior runs for each affected (layer, source, environment)"
          ),
        rules: z
          .array(
            z.object({
              id: z.string().optional(),
              name: z.string(),
              description: z.string().optional(),
              enabled: z.boolean().optional(),
              match: z.object({
                nodeId: z.string().optional(),
                namePattern: z.string().optional(),
                entityType: z.string().optional(),
                patternId: z.string().optional(),
                packageLabel: z.string().optional(),
                filePathPattern: z.string().optional(),
                overlayLayer: z.string().optional(),
                overlaySource: z.string().optional(),
                overlayField: z.string().optional(),
                overlayValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
              }),
              action: z.enum(["middleware_badge", "component_badge", "micro_node", "station_node"]),
              badgeLabel: z.string().optional(),
              badgeMode: z.enum(["fold_into_callers", "badge_on_node"]).optional(),
            })
          )
          .optional()
          .describe("Custom classification & folding rules to add or update in `.chomp/rules.json`"),
        defaults: z
          .object({
            foldMiddleware: z.boolean().optional(),
            foldComponents: z.boolean().optional(),
            foldMicroNodes: z.boolean().optional(),
          })
          .optional()
          .describe("Optional toggle overrides for the 3 built-in classification rules"),
        create_view: z
          .boolean()
          .optional()
          .describe(
            "When true, updates .chomp/current_view.json to highlight the enriched nodes in the UI. Leave false (default) during coding tasks; pass true only when answering user questions or walkthrough requests."
          ),
        createView: z.boolean().optional().describe("Alias for create_view (camelCase)"),
      },
      handler: async (args, ctx) => {
        const layerCounts: Record<string, number> = {};
        let rulesAddedOrUpdated = 0;

        if ((args.nodes && args.nodes.length > 0) || (args.overlays && args.overlays.length > 0)) {
          if (!existsSync(ctx.dbPath)) {
            throw new Error(`Chomp database not found at ${ctx.dbPath}.`);
          }
          const rawGraph = await ctx.loadRawGraph();
          const bodyHashByNodeId = new Map<string, string | null>();
          for (const n of rawGraph?.nodes ?? []) {
            bodyHashByNodeId.set(
              n.id,
              typeof n.metadata?.bodyHash === "string" ? n.metadata.bodyHash : null
            );
          }

          const batchOverlays: any[] = [];
          for (const node of args.nodes ?? []) {
            if (node.domain || node.humanLabel || node.summary || node.rationale) {
              const currentBodyHash = bodyHashByNodeId.get(node.nodeId);
              batchOverlays.push({
                repositoryId: ctx.repoId,
                entityId: node.nodeId,
                layer: SEMANTIC_OVERLAY_LAYER,
                source: "chomp_enrich_nodes",
                environment: "default",
                derivation: "AI_HYPOTHESIS",
                ...(currentBodyHash ? { bodyHash: currentBodyHash } : {}),
                payload: {
                  ...(node.domain ? { domain: node.domain } : {}),
                  ...(node.humanLabel ? { humanLabel: node.humanLabel } : {}),
                  ...(node.summary ? { summary: node.summary } : {}),
                  ...(node.rationale ? { rationale: node.rationale } : {}),
                },
                merge: true,
              });
              layerCounts[SEMANTIC_OVERLAY_LAYER] =
                (layerCounts[SEMANTIC_OVERLAY_LAYER] ?? 0) + 1;
            }
          }
          for (const ov of args.overlays ?? []) {
            const layerName = (ov.layer || SEMANTIC_OVERLAY_LAYER).trim();
            batchOverlays.push({
              repositoryId: ctx.repoId,
              entityId: ov.entityId,
              layer: layerName,
              source: ov.source || "agent",
              environment: ov.environment || "default",
              payload: ov.payload || {},
              ...(ov.bodyHash !== undefined ? { bodyHash: ov.bodyHash } : {}),
              ...(ov.derivation ? { derivation: ov.derivation } : {}),
              ...(ov.inputs ? { inputs: ov.inputs } : {}),
              ...(ov.evidence ? { evidence: ov.evidence } : {}),
              ...(ov.runId ?? args.runId ? { runId: ov.runId ?? args.runId } : {}),
              ...(ov.pruneStaleBySource !== undefined
                ? { pruneStaleBySource: ov.pruneStaleBySource }
                : {}),
              merge: ov.merge ?? true,
            });
            layerCounts[layerName] = (layerCounts[layerName] ?? 0) + 1;
          }
          if (batchOverlays.length > 0) {
            await ctx.withStorage(async (storage) => {
              await storage.upsertEntityOverlays(batchOverlays, {
                repositoryId: ctx.repoId,
                ...(args.runId ? { runId: args.runId } : {}),
                ...(args.pruneStaleBySource !== undefined
                  ? { pruneStaleBySource: args.pruneStaleBySource }
                  : {}),
              });
              if (layerCounts[SEMANTIC_OVERLAY_LAYER]) {
                await ctx.runSelf({ storage, persist: true });
              }
            });
            ctx.invalidateCache();
          }
        } else if (
          existsSync(ctx.dbPath) &&
          (!args.rules || args.rules.length === 0) &&
          !args.defaults
        ) {
          await ctx.withStorage((storage) => ctx.runSelf({ storage, persist: true }));
          ctx.invalidateCache();
        }

        const nodeRules = (args.nodes ?? [])
          .filter((n: any) => Boolean(n.action || n.badgeLabel))
          .map((n: any) => ({
            id: `agent-node-${n.nodeId}`,
            name: n.humanLabel
              ? `${n.humanLabel} (${n.action ?? "middleware_badge"})`
              : `Node ${n.nodeId} (${n.badgeLabel || n.action || "middleware_badge"})`,
            description: n.summary || `Agent rule for node ${n.nodeId}`,
            enabled: true,
            match: { nodeId: n.nodeId },
            action: n.action ?? ("middleware_badge" as const),
            ...(n.badgeLabel ? { badgeLabel: n.badgeLabel } : {}),
            badgeMode:
              n.badgeMode ??
              (n.badgeLabel ? ("badge_on_node" as const) : ("fold_into_callers" as const)),
          }));

        const allIncomingRules = [...nodeRules, ...(args.rules ?? [])];

        if (allIncomingRules.length > 0 || args.defaults) {
          const rulesPath = resolve(ctx.repoPath, ".chomp", "rules.json");
          let currentConfig: any = {
            version: 1,
            defaults: {
              foldMiddleware: true,
              foldComponents: true,
              foldMicroNodes: true,
            },
            customRules: [],
          };
          if (existsSync(rulesPath)) {
            try {
              currentConfig = JSON.parse(readFileSync(rulesPath, "utf8"));
            } catch {
              // Keep default structure if file was malformed
            }
          }
          if (!currentConfig.defaults || typeof currentConfig.defaults !== "object") {
            currentConfig.defaults = {
              foldMiddleware: true,
              foldComponents: true,
              foldMicroNodes: true,
            };
          }
          if (args.defaults) {
            if (typeof args.defaults.foldMiddleware === "boolean") {
              currentConfig.defaults.foldMiddleware = args.defaults.foldMiddleware;
            }
            if (typeof args.defaults.foldComponents === "boolean") {
              currentConfig.defaults.foldComponents = args.defaults.foldComponents;
            }
            if (typeof args.defaults.foldMicroNodes === "boolean") {
              currentConfig.defaults.foldMicroNodes = args.defaults.foldMicroNodes;
            }
          }
          if (!Array.isArray(currentConfig.customRules)) {
            currentConfig.customRules = [];
          }

          const nowIso = new Date().toISOString();
          for (const r of allIncomingRules) {
            const ruleId =
              r.id ||
              `agent-rule-${r.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 32)}-${Date.now().toString(36).slice(-4)}`;
            const newEntry = {
              id: ruleId,
              name: r.name,
              ...(r.description ? { description: r.description } : {}),
              enabled: r.enabled ?? true,
              match: r.match,
              action: r.action,
              ...(r.badgeLabel ? { badgeLabel: r.badgeLabel } : {}),
              badgeMode: r.badgeMode ?? "fold_into_callers",
              createdBy: "agent",
              createdAt: nowIso,
            };
            const existingIdx = currentConfig.customRules.findIndex(
              (existing: any) => existing.id === ruleId
            );
            if (existingIdx >= 0) {
              currentConfig.customRules[existingIdx] = newEntry;
            } else {
              currentConfig.customRules.push(newEntry);
            }
            rulesAddedOrUpdated++;
          }

          mkdirSync(dirname(rulesPath), { recursive: true });
          writeFileSync(rulesPath, JSON.stringify(currentConfig, null, 2), "utf8");
        }

        if (args.create_view ?? args.createView) {
          const highlightIds = Array.from(
            new Set([
              ...(args.nodes ?? []).map((n: any) => n.nodeId),
              ...(args.overlays ?? []).map((o: any) => o.entityId),
            ])
          ).slice(0, 40);
          if (highlightIds.length > 0) {
            const projected = await ctx.loadProjectedGraph();
            const annotations: Record<string, string> = {};
            for (const n of args.nodes ?? []) {
              if (n.summary || n.humanLabel || n.domain) {
                annotations[n.nodeId] = [n.domain, n.humanLabel, n.summary]
                  .filter(Boolean)
                  .join(" — ");
              }
            }
            ctx.setActiveView({
              title: "Updated node enrichments",
              description: `Enriched ${highlightIds.length} contract(s)`,
              highlightNodeIds: highlightIds,
              ...(Object.keys(annotations).length > 0 ? { nodeAnnotations: annotations } : {}),
              ...(projected ? { graph: projected } : {}),
            });
          }
        }

        return formatEnrichNodesSummary(layerCounts, rulesAddedOrUpdated);
      },
    },
  ],
});

export default enrichNodesPluginModule;
export { ENRICH_NODES_PLUGIN_NAME };
