/**
 * packages/mcp/src/plugins/local-shims/index.ts
 *
 * Self-contained `local-shims` plugin module (`L1_SHIMS`).
 * Auto-discovered from `packages/mcp/src/plugins/` with zero external plumbing:
 *   - State & settings folder: `.chomp/plugins/local-shims/` (`shims.json`, `settings.json`)
 *   - Declarative Settings UI (`settingsSchema`)
 *   - Structural Layer 1 graph projection (`projectGraph`, `isStructuralOverlay`)
 *   - Inspector & HUD Presentation (`PluginPresentation` v1)
 *   - Active View Spotlight (`ctx.setActiveView` + `summary.views`)
 *   - Owned MCP tool (`chomp_local_shims`)
 *   - Owned CLI summary formatter (`formatCliSummary`)
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import { SHIM_OVERLAY_LAYER, applyShimOverlaysToGraph } from "@chomp/core";
import {
  LEGACY_LOCAL_SHIMS_FILE_REL,
  LOCAL_SHIMS_FILE_REL,
  LOCAL_SHIMS_PLUGIN_NAME,
  evaluateShimsAgainstGraph,
  loadLocalShimsFromTexts,
  localShimsPlugin,
  manageLocalShims,
} from "../../shimsPlugin.js";
import { defineChompPlugin } from "../../pluginRunner.js";

export const localShimsPluginModule = defineChompPlugin({
  ...localShimsPlugin,
  defaultEnabled: true,
  scanRepoFiles: false,
  settingsSchema: [
    {
      key: "includeConfigShims",
      label: "Include chomp.config.json shims",
      description:
        "Also evaluate shared team shims declared under chomp.config.json#shims alongside .chomp/plugins/local-shims/shims.json.",
      kind: "boolean",
      defaultValue: true,
    },
    {
      key: "showUnresolvedHotspotLens",
      label: "Surface unresolved call hotspot lens",
      description:
        "Include the Unresolved Call Hotspots Spotlight view and table in the HUD and Package Inspector.",
      kind: "boolean",
      defaultValue: true,
    },
  ],
  isStructuralOverlay: (ov) =>
    ov.layer === SHIM_OVERLAY_LAYER &&
    ((Array.isArray(ov.payload?.shimmedEdges) && ov.payload.shimmedEdges.length > 0) ||
      (Array.isArray(ov.payload?.syntheticConnectors) &&
        ov.payload.syntheticConnectors.length > 0)),
  projectGraph: (ctx) => {
    const includeConfigShims = ctx.settings.includeConfigShims !== false;
    const shimsText =
      ctx.readPluginFile("shims.json") ?? ctx.readRepoFile(LEGACY_LOCAL_SHIMS_FILE_REL);
    const configText = includeConfigShims ? ctx.readRepoFile("chomp.config.json") : null;
    const { shims } = loadLocalShimsFromTexts(shimsText, configText);

    if (shimsText !== null || shims.length > 0) {
      if (shims.length === 0) return ctx.graph;
      const { resolved } = evaluateShimsAgainstGraph(ctx.graph, shims);
      if (resolved.length === 0) return ctx.graph;
      const provisionalOverlays = resolved.map((r) => ({
        entityId: r.sourceNode.id,
        layer: SHIM_OVERLAY_LAYER,
        payload: {
          shimmedEdges: [r.edgeEntry],
          ...(r.syntheticConnector ? { syntheticConnectors: [r.syntheticConnector] } : {}),
        },
      }));
      return applyShimOverlaysToGraph(ctx.graph, provisionalOverlays, { enabled: true });
    }

    if (ctx.overlays.length > 0) {
      return applyShimOverlaysToGraph(ctx.graph, ctx.overlays, { enabled: true });
    }

    return ctx.graph;
  },
  formatCliSummary: (res, ansi) => {
    const s = res.summary ?? {};
    if (typeof s.activeShims !== "number") return [];
    return [
      `${ansi.dim("Local Shims:")}   ${ansi.bold(String(s.activeShims))} active / ${s.configuredShims ?? 0} configured  ·  ${
        (s.unmatchedShims ?? 0) === 0
          ? ansi.green("0 unmatched")
          : ansi.yellow(`${s.unmatchedShims} unmatched`)
      }`,
      `${ansi.dim("Call Gaps:")}     ${ansi.green(String(s.bridgedCallCount ?? 0))} bridged  ·  ${
        (s.remainingUnresolvedCallCount ?? 0) === 0
          ? ansi.green("0 remaining")
          : ansi.yellow(`${s.remainingUnresolvedCallCount} remaining`)
      }`,
    ];
  },
  mcpTools: [
    {
      name: "chomp_local_shims",
      description:
        `USER-DEFINED LOCAL GRAPH SHIMS PLUGIN (\`L1_SHIMS\`, [PAT-DB-03], [PAT-DB-05], [PAT-VIS-15], [PAT-VIS-36], [PAT-MCP-09], [PAT-MCP-10]): Inspects, suggests, validates, upserts, or removes local runtime/DI graph shims in \`${LOCAL_SHIMS_FILE_REL}\` (plus read-only \`chomp.config.json#shims\`) and refreshes the \`local-shims\` Layer 1 plugin overlays in \`.chomp/graph.db\` WITHOUT mutating deterministic Layer 0 AST nodes or edges. Use \`action: 'suggest'\` to list unresolved call hotspots (\`▲ N unresolved\`) with candidate targets, \`action: 'validate'\` to dry-run shims, \`action: 'upsert'\` to persist shims and project \`INFERRED\` bridges across story lanes, health gates, blast radius, and \`chomp_get_diff\`, or \`action: 'remove'\` to delete shims. For repeatable AST syntax conventions across files, prefer \`chomp_get_conventions\` + \`chomp.config.json#conventions\`.`,
      inputSchema: {
        action: z
          .enum(["status", "suggest", "validate", "upsert", "remove", "run"])
          .optional()
          .describe(
            `Operation to perform: 'status' (default summary of active/unmatched shims & bridged gaps), 'suggest' (generate candidate shims from unresolved calls), 'validate' (dry-run shims against graph), 'upsert' (write shims to ${LOCAL_SHIMS_FILE_REL} & run local-shims plugin), 'remove' (remove shims by id or clearAll), or 'run' (re-evaluate ${LOCAL_SHIMS_FILE_REL} & chomp.config.json#shims into entity_overlays).`
          ),
        shims: z
          .array(
            z.object({
              id: z.string().optional().describe("Optional stable shim ID (auto-derived when omitted)"),
              sourceId: z
                .string()
                .optional()
                .describe("Exact source CONTRACT/CLASS/INIT_BLOCK node ID from chomp_get_nodes"),
              sourceName: z
                .string()
                .optional()
                .describe("Source contract name or stripped label (e.g., 'checkout' or 'Exported Function: checkout')"),
              sourceFile: z
                .string()
                .optional()
                .describe("Optional repo-relative file path disambiguating sourceName (e.g., 'src/checkout.ts')"),
              callName: z
                .string()
                .optional()
                .describe("Unresolved call expression name on source (e.g., 'container.resolve' or 'Call: container.resolve()')"),
              shapeKey: z
                .string()
                .optional()
                .describe("Optional unresolved call shapeKey filter (e.g., 'sk1/CALL/LocalVar/PropertyAccessExpression')"),
              targetId: z.string().optional().describe("Exact target CONTRACT/CLASS/OPEN_CONNECTOR node ID"),
              targetName: z
                .string()
                .optional()
                .describe("Target contract or connector name (e.g., 'chargeCard' or 'Public Method: StripeGateway.charge')"),
              targetFile: z
                .string()
                .optional()
                .describe("Optional repo-relative file path disambiguating targetName"),
              targetConnector: z
                .object({
                  name: z
                    .string()
                    .describe("Display name of target OPEN_CONNECTOR (e.g., 'HTTP Call: POST /v1/charges' or 'Queue: billing-events')"),
                  entityType: z
                    .string()
                    .optional()
                    .describe("OPEN_CONNECTOR entityType (HTTP_FETCH, DB_QUERY, MESSAGE_PUBLISH, EXTERNAL_SDK_CALL, EXTERNAL_PACKAGE)"),
                })
                .optional()
                .describe("Target external exit descriptor (reuses matching OPEN_CONNECTOR or creates an L1_SHIMS synthetic connector)"),
              entityType: z.string().optional().describe("Relationship entityType (defaults to 'CALL')"),
              edgeName: z.string().optional().describe("Optional custom display name for the shimmed relationship"),
              rationale: z
                .string()
                .optional()
                .describe("Human/agent explanation of why this runtime/DI connection exists"),
              enabled: z.boolean().optional().describe("Defaults to true; set false to disable without deleting"),
            })
          )
          .optional()
          .describe("Shim entries to dry-run ('validate') or write ('upsert')"),
        shim_ids: z.array(z.string()).optional().describe("Shim IDs to delete when action is 'remove'"),
        shimIds: z.array(z.string()).optional().describe("Alias for shim_ids (camelCase)"),
        clear_all: z
          .boolean()
          .optional()
          .describe(`When true with action 'remove', clears all entries in ${LOCAL_SHIMS_FILE_REL}`),
        clearAll: z.boolean().optional().describe("Alias for clear_all (camelCase)"),
        packageName: z.string().optional().describe("Optional package filter when action is 'suggest'"),
        package_name: z.string().optional().describe("Alias for packageName (snake_case)"),
        create_view: z
          .boolean()
          .optional()
          .describe(
            "When true, updates .chomp/current_view.json with L1_SHIMS Spotlight highlights. Leave false (default) during coding tasks; pass true only when answering user questions or walkthrough requests."
          ),
        createView: z.boolean().optional().describe("Alias for create_view (camelCase)"),
      },
      handler: async (args, ctx) => {
        if (!existsSync(ctx.dbPath)) {
          throw new Error(`Chomp database not found at ${ctx.dbPath}. Please run 'chomp analyze .' first.`);
        }
        const rawBaseGraph = await ctx.loadRawGraph();
        if (!rawBaseGraph) {
          throw new Error(
            `Graph data for repository '${ctx.repoId}' not found in the database. Please run 'chomp analyze .' first.`
          );
        }

        const action = args.action ?? "status";
        const mutatesOverlays = action === "upsert" || action === "remove" || action === "run";
        const pkgName = args.packageName ?? args.package_name;

        const result = mutatesOverlays
          ? await ctx.withStorage((storage) =>
              manageLocalShims({
                action,
                repoPath: ctx.repoPath,
                repoId: ctx.repoId,
                repoName: ctx.repoName,
                storage,
                graph: rawBaseGraph,
                shims: args.shims,
                shimIds: args.shim_ids ?? args.shimIds,
                clearAll: args.clear_all ?? args.clearAll,
                packageName: pkgName,
              })
            )
          : await manageLocalShims({
              action,
              repoPath: ctx.repoPath,
              repoId: ctx.repoId,
              repoName: ctx.repoName,
              graph: rawBaseGraph,
              shims: args.shims,
              shimIds: args.shim_ids ?? args.shimIds,
              clearAll: args.clear_all ?? args.clearAll,
              packageName: pkgName,
            });

        if (mutatesOverlays) {
          ctx.invalidateCache();
        }

        if (args.create_view ?? args.createView) {
          const projected = (await ctx.loadProjectedGraph()) ?? rawBaseGraph;
          const statusActive = Array.isArray((result as any).activeShims)
            ? ((result as any).activeShims as Array<{ sourceId: string; targetId: string }>)
            : [];
          const suggestedNodes = Array.isArray((result as any).suggestions)
            ? ((result as any).suggestions as Array<{ sourceNode: { id: string } }>)
            : [];
          const highlightIds = Array.from(
            new Set([
              ...statusActive.flatMap((s) => [s.sourceId, s.targetId]),
              ...suggestedNodes.map((s) => s.sourceNode.id),
            ])
          ).slice(0, 40);

          if (highlightIds.length > 0) {
            ctx.setActiveView({
              title: action === "suggest" ? "Unhandled call hotspots" : "Active custom links",
              description: `Action: ${action} | Highlighted ${highlightIds.length} station(s)`,
              highlightNodeIds: highlightIds,
              ...(pkgName ? { viewLevel: "package" as const, packageName: pkgName } : {}),
              graph: projected,
            });
          }
        }

        return result;
      },
    },
  ],
});

export default localShimsPluginModule;
