/**
 * packages/mcp/src/shimsAndConventions.test.ts
 *
 * End-to-end unit tests for:
 *   1. Plugin vs. MCP Reference Tool boundary (`local-shims` & `enrich-nodes` registered as ChompPlugins;
 *      `chomp_get_conventions` strictly a pure MCP reference tool, never a HUD plugin).
 *   2. `localShimsPlugin` + `manageLocalShims` (`L1_SHIMS`, `chomp_local_shims`) — status, suggest,
 *      validate, upsert, remove, Layer 0 non-mutation, `.chomp/rules.json` toggle, and `chomp_get_diff`
 *      (`computeGraphDeltaWithShims`) projection.
 *   3. `enrichNodesPlugin` (`L1_SEMANTIC`, `chomp_enrich_nodes`) — un-enriched `status: "unknown"` with
 *      copyable onboarding prompt, non-destructive `AI_HYPOTHESIS` preservation, domain Spotlight lenses,
 *      and `bodyHash` drift staleness alerts.
 *   4. `getConventionsReference` (`chomp_get_conventions`) — built-in catalog filtering, `signalKind`
 *      & `shapeKey` remediation guidance, and `chomp.config.json#conventions` validation against the
 *      committed `fixtures/test-repos/user-conventions` fixture.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SHIM_OVERLAY_LAYER,
  analyzeTarget,
  readPresentationFromPayload,
} from "@chomp/core";
import { createSQLiteStorage } from "@chomp/db";
import {
  ENRICH_NODES_PLUGIN_NAME,
  LOCAL_SHIMS_FILE_REL,
  LOCAL_SHIMS_PLUGIN_NAME,
  SEMANTIC_OVERLAY_LAYER,
  applyActivePluginProjections,
  auditGraphHealth,
  computeBlastRadius,
  computeGraphDeltaWithShims,
  discoverPluginsInDir,
  enrichNodesPlugin,
  getChompPlugin,
  getConventionsReference,
  getPluginEnvStatus,
  getPluginMcpToolSummaries,
  getPluginStateDirRel,
  invalidateMcpGraphCache,
  listChompPlugins,
  loadActiveGraphWithShims,
  loadPluginSettings,
  manageLocalShims,
  runChompPlugin,
  savePluginSettings,
  unregisterChompPlugin,
} from "./index.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const USER_CONVENTIONS_FIXTURE = resolve(REPO_ROOT, "fixtures/test-repos/user-conventions");

const SCRATCH = mkdtempSync(join(tmpdir(), "chomp-mcp-plugins-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

function touchedShimNode(graph: ReturnType<typeof analyzeTarget>, entityId: string): boolean {
  const n = graph.nodes.find((x) => x.id === entityId);
  return Boolean(n && n.entityType !== "DEPLOYMENT_UNIT");
}

describe("Plugin vs. MCP Reference Tool Boundary ([PAT-VIS-36], [PAT-MCP-10])", () => {
  it("registers local-shims and enrich-nodes as first-class ChompPlugins while keeping conventions as a pure MCP tool", () => {
    const pluginNames = listChompPlugins().map((p) => p.name);
    assert.ok(pluginNames.includes("design-system"), "design-system plugin registered");
    assert.ok(pluginNames.includes(LOCAL_SHIMS_PLUGIN_NAME), "local-shims plugin registered");
    assert.ok(pluginNames.includes(ENRICH_NODES_PLUGIN_NAME), "enrich-nodes plugin registered");
    assert.ok(
      !pluginNames.some((n) => n.includes("convention")),
      "chomp_get_conventions must remain a pure MCP reference tool, never a HUD plugin"
    );
  });
});

describe("localShimsPlugin & manageLocalShims (`L1_SHIMS` / `chomp_local_shims`)", () => {
  it("suggests, validates, upserts, projects onto health/blast-radius/diff without mutating Layer 0, and removes cleanly", async () => {
    const repoDir = join(SCRATCH, "shim-repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "shim-repo", version: "1.0.0" }, null, 2),
      "utf8"
    );
    // checkout invokes an imported runtime registry alias `di.pay(amount)` (KNOWABLE_GAP hotspot)
    // and dynamicDispatch invokes a parameter receiver `bus.chargeCard(0)` (DYNAMIC_BOUNDARY).
    writeFileSync(
      join(repoDir, "src", "di.ts"),
      `export const di: Record<string, any> = {};\n`,
      "utf8"
    );
    writeFileSync(
      join(repoDir, "src", "gateway.ts"),
      `export async function chargeCard(amount: number): Promise<string> {\n  return \`charged:\${amount}\`;\n}\n`,
      "utf8"
    );
    writeFileSync(
      join(repoDir, "src", "checkout.ts"),
      `import { di } from "./di.js";\nexport async function checkout(amount: number) {\n  return di.pay(amount);\n}\nexport function dynamicDispatch(bus: any) {\n  return bus.chargeCard(0);\n}\n`,
      "utf8"
    );

    const rawGraph = analyzeTarget(repoDir);
    const dbDir = join(repoDir, ".chomp");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "graph.db");
    const repoId = "shim_repo";

    const storage = createSQLiteStorage(dbPath);
    try {
      await storage.saveRepresentationGraph(
        { id: repoId, name: "shim-repo", path: repoDir },
        rawGraph
      );

      // 1. Suggest shims from both KNOWABLE_GAP (`checkout -> di.pay`) and DYNAMIC_BOUNDARY (`dynamicDispatch -> bus.chargeCard`)
      const suggestRes = await manageLocalShims({
        action: "suggest",
        repoPath: repoDir,
        repoId,
        graph: rawGraph,
      });
      assert.equal(suggestRes.action, "suggest");
      const suggestions = suggestRes.suggestions as Array<any>;
      assert.ok(suggestions.length >= 2, "Expected suggestions for both checkout and dynamicDispatch");
      const dynamicSuggestion = suggestions.find((s) => /dynamicDispatch/.test(s.sourceNode.name));
      const checkoutSuggestion = suggestions.find((s) => /checkout/.test(s.sourceNode.name));
      assert.ok(dynamicSuggestion, "Expected DYNAMIC_BOUNDARY suggestion for dynamicDispatch");
      assert.ok(
        dynamicSuggestion.candidateTargets.some((t: any) => /chargeCard/.test(t.name)),
        "Candidate target on bus.chargeCard should surface matching `chargeCard` contract"
      );
      assert.ok(checkoutSuggestion, "Expected KNOWABLE_GAP suggestion for checkout -> di.pay");

      // 2. Dry-run validate (both matched and unmatched)
      const validateRes = await manageLocalShims({
        action: "validate",
        repoPath: repoDir,
        repoId,
        graph: rawGraph,
        shims: [
          dynamicSuggestion.suggestedShim,
          { sourceName: "nonExistentFn", targetName: "chargeCard" },
        ],
      });
      assert.equal(validateRes.valid, false);
      assert.equal(validateRes.resolvedCount, 1);
      assert.equal(validateRes.unmatchedCount, 1);

      // 3. Upsert valid shim + synthetic connector shim
      const upsertRes = await manageLocalShims({
        action: "upsert",
        repoPath: repoDir,
        repoId,
        storage,
        graph: rawGraph,
        shims: [
          {
            id: "shim-checkout-charge",
            sourceName: "checkout",
            callName: "di.pay",
            targetName: "chargeCard",
            rationale: "Runtime DI registry maps di.pay -> PaymentGateway.chargeCard",
          },
          {
            id: "shim-charge-stripe",
            sourceName: "chargeCard",
            targetConnector: {
              name: "HTTP Call: POST https://api.stripe.com/v1/charges",
              entityType: "HTTP_FETCH",
            },
            rationale: "Runtime Stripe HTTP egress",
          },
        ],
      });
      assert.equal(upsertRes.action, "upsert");
      assert.equal(upsertRes.upsertedCount, 2);
      assert.equal(upsertRes.manifestPath, LOCAL_SHIMS_FILE_REL);
      assert.equal(
        existsSync(join(repoDir, ".chomp", "plugins", "local-shims", "shims.json")),
        true,
        "Shims manifest must be stored inside .chomp/plugins/local-shims/shims.json"
      );
      invalidateMcpGraphCache(dbPath);

      // 4. Layer 0 purity check: SQLite `nodes` and `edges` remain 100% untouched!
      const persistedL0 = await storage.getRepresentationGraph(repoId);
      assert.ok(persistedL0);
      assert.equal(
        persistedL0.edges.some((e) => e.metadata?.source === "USER_SHIM"),
        false,
        "Layer 0 edges in SQLite must never be mutated by local-shims"
      );
      assert.equal(
        persistedL0.nodes.some((n) => n.metadata?.source === "USER_SHIM"),
        false,
        "Layer 0 nodes in SQLite must never be mutated by local-shims"
      );

      // 5. Verify L1_SHIMS overlays carry file-hash inputs, "Custom links" UX metadata, order before Design system, and unhandled pattern items
      assert.equal(getChompPlugin(LOCAL_SHIMS_PLUGIN_NAME)?.displayName, "Custom links");
      const orderedNames = listChompPlugins().map((p) => p.displayName ?? p.name);
      const enrichIdx = orderedNames.indexOf("Enrich nodes");
      const designIdx = orderedNames.indexOf("Design system");
      assert.ok(
        enrichIdx >= 0 && designIdx >= 0 && enrichIdx < designIdx,
        `Expected Enrich nodes before Design system, got: ${orderedNames.join(", ")}`
      );
      const shimOverlays = await storage.getEntityOverlays(repoId, {
        layers: [SHIM_OVERLAY_LAYER],
      });
      assert.ok(shimOverlays.length >= 3, "Expected DU + 2 source node L1_SHIMS overlays");
      for (const ov of shimOverlays) {
        assert.equal(ov.source, LOCAL_SHIMS_PLUGIN_NAME);
        assert.equal(ov.stale, false, "Freshly written .chomp/shims.json input hash must not be stale");
        const pres = readPresentationFromPayload(ov.payload);
        assert.ok(pres, `Overlay on ${ov.entityId} must carry valid PluginPresentation v1`);
      }
      const shimDuPres = readPresentationFromPayload(
        shimOverlays.find((o) => !touchedShimNode(rawGraph, o.entityId))?.payload
      )!;
      assert.ok(shimDuPres.summary?.description?.includes("unlocks"), "Custom links HUD summary includes concise unlock description");
      assert.ok(
        Array.isArray(shimDuPres.summary?.items) && shimDuPres.summary!.items!.length >= 1,
        "Custom links HUD summary lists unhandled call patterns"
      );

      // 6. Verify projected graph resolves unresolved hotspot, traces blast radius, and surfaces in chomp_get_diff
      const projected = await loadActiveGraphWithShims(repoDir, dbPath, repoId);
      assert.ok(projected);
      const rawHealth = auditGraphHealth(rawGraph, { repoPath: repoDir });
      const projectedHealth = auditGraphHealth(projected, { repoPath: repoDir });
      assert.ok(
        projectedHealth.healthGate.unresolvedHotspotCount <
          rawHealth.healthGate.unresolvedHotspotCount,
        "Shimmed call should clear unresolved hotspot in chomp_audit_health"
      );

      const blast = computeBlastRadius(projected, { searchTerm: "chargeCard" });
      assert.equal(blast.found, true);
      assert.ok(
        blast.upstreamCallers.some((c) => /checkout/.test(c.node.label)),
        "Blast radius on chargeCard must include shimmed caller checkout"
      );
      assert.ok(
        blast.externalSideEffects.some((s) => /stripe\.com/.test(s.connector.label)),
        "Blast radius on chargeCard must include synthetic Stripe OPEN_CONNECTOR"
      );

      const delta = await computeGraphDeltaWithShims(repoDir, dbPath, repoId);
      const changedEdges = Object.values(delta.edges).filter(
        (e) => e.status === "ADDED" || e.status === "MODIFIED"
      );
      assert.ok(
        changedEdges.length >= 2,
        "chomp_get_diff should report newly bridged & synthetic shim edges against baseline"
      );

      // 7. Toggling L1_SHIMS off in .chomp/rules.json bypasses shim projection cleanly
      writeFileSync(
        join(dbDir, "rules.json"),
        JSON.stringify({ version: 1, overlayLayers: { L1_SHIMS: false } }, null, 2),
        "utf8"
      );
      const unshimmed = await loadActiveGraphWithShims(repoDir, dbPath, repoId);
      assert.ok(unshimmed);
      assert.equal(
        unshimmed.edges.some((e) => e.metadata?.source === "USER_SHIM"),
        false,
        "Disabling overlayLayers.L1_SHIMS must hide shimmed edges"
      );
      rmSync(join(dbDir, "rules.json"), { force: true });

      // 8. Remove all shims and verify status resets cleanly
      const removeRes = await manageLocalShims({
        action: "remove",
        repoPath: repoDir,
        repoId,
        storage,
        graph: rawGraph,
        clearAll: true,
      });
      assert.equal(removeRes.removedCount, 2);
      assert.equal(removeRes.remainingManifestShims, 0);
    } finally {
      await storage.close();
    }
  });
});

describe("enrichNodesPlugin (`L1_SEMANTIC` / `chomp_enrich_nodes`)", () => {
  it("surfaces honest Un-enriched onboarding prompt when empty, preserves AI_HYPOTHESIS rows on run, and flags bodyHash drift", async () => {
    const repoDir = join(SCRATCH, "enrich-repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "enrich-repo", version: "1.0.0" }, null, 2),
      "utf8"
    );
    writeFileSync(
      join(repoDir, "src", "billing.ts"),
      `export function createInvoice(total: number) {\n  return { total };\n}\n`,
      "utf8"
    );

    const graph = analyzeTarget(repoDir);
    const du = graph.nodes.find((n) => n.entityType === "DEPLOYMENT_UNIT")!;
    const invoiceNode = graph.nodes.find((n) => n.name.includes("createInvoice"))!;
    assert.ok(du && invoiceNode);

    const dbPath = join(repoDir, ".chomp", "graph.db");
    mkdirSync(join(repoDir, ".chomp"), { recursive: true });
    const repoId = "enrich_repo";
    const storage = createSQLiteStorage(dbPath);

    try {
      await storage.saveRepresentationGraph(
        { id: repoId, name: "enrich-repo", path: repoDir },
        graph
      );

      // 1. Un-enriched state -> color indicator status: "warn", count of un-enriched nodes, concise description, copyable prompt, NO views
      assert.deepEqual(enrichNodesPlugin.inspectorScopes, ["package"]);
      const initialRun = await runChompPlugin(enrichNodesPlugin, {
        repoPath: repoDir,
        repoId,
        storage,
        graph,
        persist: true,
      });
      assert.equal(initialRun.summary.enrichedContracts, 0);
      const initialOverlays = await storage.getEntityOverlays(repoId, {
        layers: [SEMANTIC_OVERLAY_LAYER],
      });
      assert.equal(
        initialOverlays.some((o) => o.entityId === invoiceNode.id && o.source === ENRICH_NODES_PLUGIN_NAME),
        false,
        "enrich-nodes must NOT emit node-level inspector presentation overlays"
      );
      const duOverlay0 = initialOverlays.find((o) => o.entityId === du.id)!;
      const duPres0 = readPresentationFromPayload(duOverlay0.payload)!;
      assert.equal(duPres0.summary?.status, "warn");
      assert.equal(duPres0.summary?.views, undefined, "enrich-nodes must not emit canvas Spotlight views");
      assert.equal(duPres0.summary?.headline, "No nodes enriched yet · 1 ready");
      assert.match(duPres0.summary?.description ?? "", /plain-English station names/);
      assert.ok(
        duPres0.summary?.prompt?.text.includes("chomp_enrich_nodes"),
        "Un-enriched HUD summary must include copyable chomp_enrich_nodes prompt"
      );

      // 2. Write AI_HYPOTHESIS enrichment via storage (simulating chomp_enrich_nodes) and re-run plugin
      await storage.upsertEntityOverlays([
        {
          repositoryId: repoId,
          entityId: invoiceNode.id,
          layer: SEMANTIC_OVERLAY_LAYER,
          source: "chomp_enrich_nodes",
          derivation: "AI_HYPOTHESIS",
          bodyHash: String(invoiceNode.metadata?.bodyHash ?? "hash-v1"),
          payload: {
            domain: "Billing",
            humanLabel: "Create Customer Invoice",
            summary: "Builds an invoice record for the given total.",
            rationale: "Keeps billing calculation pure before persistence.",
          },
        },
      ]);

      const enrichedRun = await runChompPlugin(enrichNodesPlugin, {
        repoPath: repoDir,
        repoId,
        storage,
        graph,
        persist: true,
      });
      assert.equal(enrichedRun.summary.enrichedContracts, 1);
      assert.equal(enrichedRun.summary.coveragePct, 100);

      const afterOverlays = await storage.getEntityOverlays(repoId, {
        layers: [SEMANTIC_OVERLAY_LAYER],
      });
      const rawHypothesis = afterOverlays.find((o) => o.source === "chomp_enrich_nodes");
      assert.ok(
        rawHypothesis,
        "Running enrich-nodes plugin must NEVER prune or overwrite source='chomp_enrich_nodes' AI_HYPOTHESIS rows"
      );
      assert.equal(
        afterOverlays.some((o) => o.entityId === invoiceNode.id && o.source === ENRICH_NODES_PLUGIN_NAME),
        false,
        "enrich-nodes must NEVER emit dedicated NodeInspector presentation sections even after enrichment"
      );
      const duOverlay1 = afterOverlays.find(
        (o) => o.entityId === du.id && o.source === ENRICH_NODES_PLUGIN_NAME
      )!;
      const duPres1 = readPresentationFromPayload(duOverlay1.payload)!;
      assert.equal(duPres1.summary?.status, "ok");
      assert.equal(duPres1.summary?.views, undefined, "enrich-nodes keeps color indicator only (no views)");
      assert.equal(duPres1.sections.length, 1, "Package inspector keeps single streamlined section");
      const metricsBlock = duPres1.sections[0]!.blocks[0]!;
      assert.equal(metricsBlock.kind, "metrics");
      if (metricsBlock.kind === "metrics") {
        assert.deepEqual(
          metricsBlock.items.map((m) => m.label),
          ["Coverage", "Enriched", "Stale"],
          "Package inspector shows only Coverage, Enriched, and Stale metrics (no Domains)"
        );
      }

      // 3. Simulate code body edit (bodyHash drift) -> status: "warn" + stale node reason in Stale metric
      const driftedGraph = {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === invoiceNode.id
            ? { ...n, metadata: { ...(n.metadata ?? {}), bodyHash: "drifted-hash-v2" } }
            : n
        ),
      };
      const staleRun = await runChompPlugin(enrichNodesPlugin, {
        repoPath: repoDir,
        repoId,
        storage,
        graph: driftedGraph,
        persist: false,
      });
      assert.equal(staleRun.summary.staleContracts, 1);
      const staleDuPres = readPresentationFromPayload(
        staleRun.overlays.find((o) => o.entityId === du.id)!.payload
      )!;
      assert.equal(staleDuPres.summary?.status, "warn");
      assert.equal(staleDuPres.summary?.issueCount, 1);
      assert.ok(staleDuPres.summary?.prompt?.label.toLowerCase().includes("stale"));
      const staleMetrics = staleDuPres.sections[0]!.blocks[0]!;
      if (staleMetrics.kind === "metrics") {
        const staleCard = staleMetrics.items.find((m) => m.id === "stale-count")!;
        assert.equal(staleCard.items?.[0]?.label, "Create Customer Invoice");
        assert.match(staleCard.items?.[0]?.detail ?? "", /Code modified since/);
      }
    } finally {
      await storage.close();
    }
  });
});

describe("getConventionsReference (`chomp_get_conventions`)", () => {
  it("loads and validates user chomp.config.json conventions, filters built-in rules, and advises on signals & shapeKeys without requiring graph.db", () => {
    const full = getConventionsReference({
      repoPath: USER_CONVENTIONS_FIXTURE,
      signalKind: "UNRESOLVED_CALL",
      shapeKey: "sk1/CALL/LocalVar/PropertyAccessExpression",
    });

    assert.equal(full.activeUserConventions.exists, true);
    assert.equal(full.activeUserConventions.parseError, null);
    assert.equal(full.summary.activeUserConventionSetCount, 1);
    assert.equal(full.summary.activeUserRuleCount, 4);
    assert.equal(full.summary.userValidationErrorCount, 0);
    assert.ok(full.schemaReference, "Includes NodeMatcher/EdgeMatcher schema by default");
    assert.ok(full.schemaReference!.nodeMatchers.length >= 15);
    assert.equal(full.schemaReference!.edgeMatchers.length, 4);
    assert.equal(full.signalPlaybook.length, 1);
    assert.equal(full.signalPlaybook[0]!.signalKind, "UNRESOLVED_CALL");
    assert.equal(full.shapeKeyAdvice?.recommendedApproach, "CHOMP_CONFIG_CONVENTION");

    // Dynamic element-access shapeKey recommends LOCAL_SHIM instead of AST convention guessing
    const dynamicAdvice = getConventionsReference({
      repoPath: USER_CONVENTIONS_FIXTURE,
      framework: "express",
      entityType: "HTTP_ENDPOINT",
      shapeKey: "sk1/CALL/Param/ElementAccessExpression",
      includeSchema: false,
    });
    assert.equal(dynamicAdvice.schemaReference, undefined);
    assert.equal(dynamicAdvice.builtInConventions.length, 1);
    assert.equal(dynamicAdvice.builtInConventions[0]!.framework, "express");
    assert.ok(
      dynamicAdvice.builtInConventions[0]!.rules.every(
        (r) => r.produces.entityType === "HTTP_ENDPOINT"
      )
    );
    assert.equal(dynamicAdvice.shapeKeyAdvice?.recommendedApproach, "LOCAL_SHIM");
  });
});

describe("Zero-Plumbing Modular Plugin Folder Architecture (`discoverPluginsInDir`)", () => {
  it("auto-discovers a drop-in plugin folder with settingsSchema, .chomp/plugins/<name>/ storage, Active View arrays, presentation UI, projectGraph, and mcpTools", async () => {
    const customPluginsRoot = join(SCRATCH, "custom-plugins-dir");
    const sampleFolder = join(customPluginsRoot, "sample-sla");
    mkdirSync(sampleFolder, { recursive: true });

    // Author a 100% self-contained single-folder plugin module (zero edits to any Chomp file)
    writeFileSync(
      join(sampleFolder, "index.mjs"),
      `export default {
  name: "sample-sla",
  displayName: "Sample SLA",
  version: "1.0.0",
  layer: "PLUGIN:sample-sla",
  description: "Tracks contract SLA budgets in .chomp/plugins/sample-sla/budgets.json.",
  defaultEnabled: true,
  settingsSchema: [
    { key: "p95BudgetMs", label: "P95 budget (ms)", kind: "number", defaultValue: 200, min: 10, max: 5000 },
    { key: "autoHighlightBreaches", label: "Highlight breaches", kind: "boolean", defaultValue: true }
  ],
  accepts: (f) => f === ".chomp/plugins/sample-sla/budgets.json",
  extract: (ctx) => {
    const budget = Number(ctx.settings.p95BudgetMs ?? 200);
    if (!ctx.readPluginFile("budgets.json")) {
      ctx.writePluginFile("budgets.json", JSON.stringify({ defaultP95Ms: 320 }, null, 2));
    }
    const targetNodes = ctx.graph.nodes.filter((n) => n.type === "CONTRACT");
    const highlightIds = targetNodes.map((n) => n.id);
    if (ctx.settings.autoHighlightBreaches && highlightIds.length > 0) {
      ctx.setActiveView({
        title: "SLA Breach Spotlight",
        description: \`Contracts exceeding \${budget}ms budget\`,
        highlightNodeIds: highlightIds,
      });
    }
    const du = ctx.graph.nodes.find((n) => n.entityType === "DEPLOYMENT_UNIT");
    const overlays = [];
    if (du) {
      overlays.push({
        entityId: du.id,
        layer: "PLUGIN:sample-sla",
        source: "sample-sla",
        payload: {
          presentation: {
            version: 1,
            summary: {
              status: "warn",
              badge: { text: \`>\${budget}ms\`, tone: "warn" },
              headline: \`\${highlightIds.length} contract(s) over \${budget}ms budget\`,
              issueCount: highlightIds.length,
              views: [
                {
                  id: "sla-breaches",
                  title: "SLA breaches",
                  highlightNodeIds: highlightIds,
                }
              ]
            },
            sections: [
              {
                id: "sla-section",
                title: "SLA summary",
                blocks: [{ kind: "text", text: \`Budget threshold: \${budget}ms\` }]
              }
            ]
          }
        }
      });
    }
    return { overlays, summary: { budget, flagged: highlightIds.length } };
  },
  projectGraph: (ctx) => ({
    ...ctx.graph,
    nodes: ctx.graph.nodes.map((n) =>
      n.type === "CONTRACT"
        ? { ...n, metadata: { ...(n.metadata ?? {}), slaBudgetMs: ctx.settings.p95BudgetMs } }
        : n
    ),
  }),
  mcpTools: [
    {
      name: "chomp_sample_sla",
      description: "Inspect sample SLA plugin status.",
      inputSchema: {},
      handler: async (_args, ctx) => ({ ok: true, settings: ctx.settings })
    }
  ]
};\n`,
      "utf8"
    );

    try {
      const discovered = await discoverPluginsInDir(customPluginsRoot);
      assert.equal(discovered.length, 1);
      const plugin = getChompPlugin("sample-sla");
      assert.ok(plugin, "Drop-in plugin folder auto-registered");
      assert.equal(getPluginStateDirRel("sample-sla"), ".chomp/plugins/sample-sla");
      assert.deepEqual(
        getPluginMcpToolSummaries(plugin).map((t) => t.name),
        ["chomp_sample_sla"]
      );

      const repoDir = join(SCRATCH, "sla-target-repo");
      mkdirSync(join(repoDir, "src"), { recursive: true });
      writeFileSync(
        join(repoDir, "package.json"),
        JSON.stringify({ name: "sla-target", version: "1.0.0" }),
        "utf8"
      );
      writeFileSync(
        join(repoDir, "src", "api.ts"),
        `export function handleCheckout() { return 200; }\n`,
        "utf8"
      );
      const graph = analyzeTarget(repoDir);

      // Verify default settings & persisted settings update in .chomp/plugins/sample-sla/settings.json
      const defaults = loadPluginSettings(repoDir, plugin);
      assert.equal(defaults.p95BudgetMs, 200);
      const updated = savePluginSettings(repoDir, plugin, { p95BudgetMs: 125 });
      assert.equal(updated.p95BudgetMs, 125);
      assert.equal(
        existsSync(join(repoDir, ".chomp", "plugins", "sample-sla", "settings.json")),
        true
      );

      // Run plugin: writes .chomp/plugins/sample-sla/budgets.json, sets Active View array, emits Presentation v1
      const runRes = await runChompPlugin(plugin, {
        repoPath: repoDir,
        graph,
        persist: false,
      });
      assert.equal(runRes.summary.budget, 125);
      assert.equal(runRes.overlayCount, 1);
      assert.equal(
        existsSync(join(repoDir, ".chomp", "plugins", "sample-sla", "budgets.json")),
        true
      );

      const activeView = JSON.parse(
        readFileSync(join(repoDir, ".chomp", "current_view.json"), "utf8")
      );
      assert.equal(activeView.title, "SLA Breach Spotlight");
      assert.equal(activeView.source, "sample-sla");
      assert.equal(activeView.layer, "PLUGIN:sample-sla");
      assert.ok(Array.isArray(activeView.highlightNodeIds) && activeView.highlightNodeIds.length >= 1);

      // Verify generic projection hook applies with resolved plugin settings
      const projected = applyActivePluginProjections(graph, { repoPath: repoDir });
      const apiContract = projected.nodes.find((n) => n.name.includes("handleCheckout"))!;
      assert.equal(apiContract.metadata?.slaBudgetMs, 125);
    } finally {
      unregisterChompPlugin("sample-sla");
    }
  });

  it("supports Kong-class telemetry scalability: scanRepoFiles=false, kind='env' secret indirection, and rps/bytes units", async () => {
    const kongRoot = join(SCRATCH, "kong-plugin-root");
    const kongDir = join(kongRoot, "kong-telemetry");
    mkdirSync(kongDir, { recursive: true });
    writeFileSync(
      join(kongDir, "index.mjs"),
      `export default {
  name: "kong-telemetry",
  version: "1.0.0",
  layer: "L2_RUNTIME",
  displayName: "Kong Telemetry",
  description: "Gateway RPS, p95 latency, and 5xx rates.",
  scanRepoFiles: false,
  settingsSchema: [
    { key: "tokenEnv", label: "Konnect token env var", kind: "env", defaultValue: "KONG_KONNECT_TOKEN" },
    { key: "window", label: "Window", kind: "select", defaultValue: "1h", options: [{ value: "1h", label: "1h" }, { value: "24h", label: "24h" }] }
  ],
  accepts: () => true,
  extract: (ctx) => {
    const secret = ctx.resolveSecret("tokenEnv");
    const du = ctx.graph.nodes.find((n) => n.entityType === "DEPLOYMENT_UNIT");
    const overlays = du
      ? [{
          entityId: du.id,
          layer: "L2_RUNTIME",
          source: "kong-telemetry",
          payload: {
            presentation: {
              version: 1,
              summary: {
                status: "ok",
                metrics: [
                  { id: "rps", label: "Throughput", value: 420, unit: "rps" },
                  { id: "bw", label: "Payload", value: 128, unit: "kb" }
                ]
              },
              sections: []
            }
          }
        }]
      : [];
    return { overlays, summary: { scannedFiles: ctx.files, hasSecret: Boolean(secret) } };
  }
};\n`,
      "utf8"
    );

    const prevToken = process.env.KONG_KONNECT_TOKEN;
    try {
      await discoverPluginsInDir(kongRoot);
      const kongPlugin = getChompPlugin("kong-telemetry")!;
      assert.ok(kongPlugin);
      assert.equal(kongPlugin.scanRepoFiles, false);

      const repoDir = join(SCRATCH, "kong-target-repo");
      mkdirSync(join(repoDir, "src"), { recursive: true });
      mkdirSync(join(repoDir, ".chomp", "plugins", "kong-telemetry"), { recursive: true });
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "orders-api" }), "utf8");
      writeFileSync(join(repoDir, "src", "routes.ts"), `export function getOrder() { return 1; }\n`, "utf8");
      writeFileSync(
        join(repoDir, ".chomp", "plugins", "kong-telemetry", "snapshot.json"),
        JSON.stringify({ rps: 420 }),
        "utf8"
      );
      const graph = analyzeTarget(repoDir);

      // Attempting to save a raw API token (`kpat_...` or JWT `eyJ...`) into a `kind: "env"` field must be rejected!
      const guarded = savePluginSettings(repoDir, kongPlugin, {
        tokenEnv: "kpat_live_super_secret_token_value",
      });
      assert.equal(
        guarded.tokenEnv,
        "KONG_KONNECT_TOKEN",
        "Raw token values must never be persisted into settings.json"
      );

      // Unset vs set envStatus never leaks the secret value
      delete process.env.KONG_KONNECT_TOKEN;
      assert.deepEqual(getPluginEnvStatus(kongPlugin, guarded), { tokenEnv: false });
      process.env.KONG_KONNECT_TOKEN = "super-secret-konnect-value";
      assert.deepEqual(getPluginEnvStatus(kongPlugin, guarded), { tokenEnv: true });

      const runRes = await runChompPlugin(kongPlugin, {
        repoPath: repoDir,
        graph,
        persist: false,
      });
      assert.equal(runRes.summary.hasSecret, true);
      assert.ok(
        !runRes.summary.scannedFiles.includes("src/routes.ts"),
        "scanRepoFiles: false skips walking repository source files"
      );
      assert.ok(
        runRes.summary.scannedFiles.includes(".chomp/plugins/kong-telemetry/snapshot.json"),
        "scanRepoFiles: false still discovers .chomp/plugins/<name>/ state files"
      );
      const pres = readPresentationFromPayload(runRes.overlays[0]!.payload)!;
      assert.equal(pres.summary?.metrics?.[0]?.unit, "rps");
      assert.equal(pres.summary?.metrics?.[1]?.unit, "kb");
    } finally {
      if (prevToken === undefined) delete process.env.KONG_KONNECT_TOKEN;
      else process.env.KONG_KONNECT_TOKEN = prevToken;
      unregisterChompPlugin("kong-telemetry");
    }
  });
});
