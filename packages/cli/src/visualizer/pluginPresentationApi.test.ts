import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEntityPresentations,
  buildPluginsOverview,
  computePluginFingerprint,
  computeStructureFingerprint,
  failPluginRun,
  finishPluginRun,
  getPluginRun,
  isPluginRunning,
  overlaysForStructureFingerprint,
  rulesReferenceOverlays,
  snapshotPluginRuns,
  splitOverlays,
  startPluginRun,
  type PluginRunMap,
} from "./pluginPresentationApi.js";
import type { EntityOverlayItem } from "./types.js";

const presentation = (issueCount: number, badge = "79/100 (C)") => ({
  version: 1,
  summary: { status: issueCount === 0 ? "ok" : "warn", badge: { text: badge, tone: "warn" }, issueCount },
  sections: [{ id: "overview", title: "Overview", blocks: [{ kind: "text", text: "hello" }] }],
});

const overlay = (over: Partial<EntityOverlayItem> & { entityId: string }): EntityOverlayItem => ({
  layer: "L1_DESIGN_SYSTEM",
  source: "design-system",
  environment: "default",
  payload: { presentation: presentation(3) },
  runId: "run-1",
  updatedAt: "2026-11-10 05:00:00",
  ...over,
});

const nodes = [
  { id: "du-web", name: "Deployment Unit: @acme/web", entityType: "DEPLOYMENT_UNIT" },
  { id: "du-admin", name: "Deployment Unit: admin-app", entityType: "DEPLOYMENT_UNIT" },
  { id: "fn-button", name: "Exported Function: Button", entityType: "EXPORTED_FUNCTION", metadata: { bodyHash: "aaa" } },
];

describe("Plugin presentation API model ([PAT-VIS-36])", () => {
  it("defers only the heavy presentation from structural payloads (other fields stay for rules/badges)", () => {
    const semantic = overlay({ entityId: "fn-button", layer: "L1_SEMANTIC", source: "agent", payload: { summary: "x" } });
    const plugin = overlay({ entityId: "du-web", payload: { findingCount: 5, presentation: presentation(3) } });
    const { layout, plugin: pluginOnly } = splitOverlays([semantic, plugin]);
    assert.equal(layout.length, 2);
    assert.deepEqual(layout[0], semantic);
    assert.deepEqual(layout[1]!.payload, { findingCount: 5, presentationAvailable: true });
    assert.deepEqual(pluginOnly, [plugin]);
    assert.ok("presentation" in plugin.payload, "original overlay is untouched");
  });

  it("plugin overlays only affect the structure fingerprint when custom rules read overlays", () => {
    const plugin = overlay({ entityId: "du-web", payload: { findingCount: 5, presentation: presentation(3) } });
    const split = splitOverlays([plugin]);
    assert.equal(overlaysForStructureFingerprint(split, false).length, 0);
    assert.equal(overlaysForStructureFingerprint(split, true).length, 1);
    assert.equal(rulesReferenceOverlays([{ match: { filePathPattern: "x" } } as any]), false);
    assert.equal(rulesReferenceOverlays([{ match: { overlayLayer: "L1_DESIGN_SYSTEM" } }]), true);
    assert.equal(rulesReferenceOverlays([{ match: { overlayField: "grade" } }]), true);
    assert.equal(rulesReferenceOverlays(undefined), false);
  });

  it("structure fingerprint ignores plugin writes but changes with the structure", () => {
    const base = computeStructureFingerprint(nodes, [], []);
    assert.equal(computeStructureFingerprint(nodes, [], []), base, "deterministic");
    const changed = nodes.map((n) => (n.id === "fn-button" ? { ...n, metadata: { bodyHash: "bbb" } } : n));
    assert.notEqual(computeStructureFingerprint(changed, [], []), base);
    const withEdge = computeStructureFingerprint(nodes, [{ id: "e1", targetId: "fn-button", status: "DETERMINISTIC" }], []);
    assert.notEqual(withEdge, base);
  });

  it("plugin fingerprint changes on new data and on run-state changes, independently of structure", () => {
    const a = computePluginFingerprint([overlay({ entityId: "du-web" })], {});
    assert.equal(computePluginFingerprint([overlay({ entityId: "du-web" })], {}), a);
    assert.notEqual(computePluginFingerprint([overlay({ entityId: "du-web", runId: "run-2" })], {}), a);
    assert.notEqual(computePluginFingerprint([overlay({ entityId: "du-web" })], { "design-system": { state: "running", startedAt: "t" } }), a);
  });

  it("builds HUD cards from package overlays using the graph's own package names (no repo-name assumptions)", () => {
    const overview = buildPluginsOverview({
      pluginOverlays: [
        overlay({ entityId: "du-web", payload: { presentation: presentation(5) } }),
        overlay({ entityId: "du-admin", payload: { presentation: presentation(2, "N/A") } }),
        overlay({ entityId: "fn-button" }),
      ],
      nodes,
      registry: [{ name: "design-system", displayName: "Design system", description: "d", version: "2.1.0", layer: "L1_DESIGN_SYSTEM" }],
      runs: {},
      structureFp: "sfp",
    });
    assert.equal(overview.fingerprint.structureFp, "sfp");
    assert.equal(overview.plugins.length, 1);
    const p = overview.plugins[0]!;
    assert.equal(p.displayName, "Design system");
    assert.equal(p.overlayCount, 3);
    assert.deepEqual(p.packages.map((x) => [x.label, x.key]), [["@acme/web", "web"], ["admin-app", "admin-app"]]);
    assert.equal(p.issueCount, 7, "package issue counts are summed (component overlays are not double counted)");
    assert.equal(p.summary?.badge?.text, "2 packages");
    assert.equal(p.summary?.status, "warn");
    assert.equal(p.run.state, "idle");
  });

  it("single-package plugins surface that package's own summary; registered-but-never-run plugins still get a card", () => {
    const overview = buildPluginsOverview({
      pluginOverlays: [overlay({ entityId: "du-web", payload: { presentation: presentation(0, "A") } })],
      nodes,
      registry: [
        { name: "design-system", layer: "L1_DESIGN_SYSTEM" },
        { name: "a11y", displayName: "Accessibility", layer: "PLUGIN:a11y" },
      ],
      runs: { a11y: { state: "running", startedAt: "t" } },
      structureFp: "x",
    });
    const ds = overview.plugins.find((p) => p.source === "design-system")!;
    assert.equal(ds.summary?.badge?.text, "A");
    assert.equal(ds.displayName, "Design system", "falls back to a humanized name when the plugin declares none");
    const a11y = overview.plugins.find((p) => p.source === "a11y")!;
    assert.equal(a11y.overlayCount, 0);
    assert.equal(a11y.run.state, "running");
  });

  it("serves a sanitized presentation for one entity, ignores invalid ones, and enforces inspectorScopes", () => {
    const out = buildEntityPresentations({
      pluginOverlays: [
        overlay({ entityId: "fn-button" }),
        overlay({
          entityId: "fn-button",
          source: "enrich-nodes",
          layer: "L1_SEMANTIC",
          payload: { presentation: presentation(0, "Enriched") },
        }),
        overlay({ entityId: "fn-button", source: "broken", layer: "PLUGIN:broken", payload: { presentation: { version: 7 } } }),
        overlay({ entityId: "du-web" }),
      ],
      entityId: "fn-button",
      nodes,
      registry: [
        { name: "design-system", displayName: "Design system" },
        { name: "enrich-nodes", displayName: "Enrich nodes", inspectorScopes: ["package"] },
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.displayName, "Design system");
    assert.equal(out[0]!.presentation.sections[0]!.id, "overview");
    assert.equal(out[0]!.runId, "run-1");

    const pkgOut = buildEntityPresentations({
      pluginOverlays: [
        overlay({
          entityId: "du-web",
          source: "enrich-nodes",
          layer: "L1_SEMANTIC",
          payload: { presentation: presentation(0, "100% enriched") },
        }),
      ],
      entityId: "du-web",
      nodes,
      registry: [{ name: "enrich-nodes", displayName: "Enrich nodes", inspectorScopes: ["package"] }],
    });
    assert.equal(pkgOut.length, 1, "Package-scoped plugin still renders in PackageInspectorDrawer");
  });

  it("tracks UI-triggered run state", () => {
    let t = 0;
    const now = () => `t${++t}`;
    const runs: PluginRunMap = new Map();
    assert.equal(getPluginRun(runs, "p").state, "idle");
    startPluginRun(runs, "p", now);
    assert.equal(isPluginRunning(runs, "p"), true);
    finishPluginRun(runs, "p", now);
    assert.deepEqual(getPluginRun(runs, "p"), { state: "idle", startedAt: "t1", finishedAt: "t2" });
    startPluginRun(runs, "q", now);
    failPluginRun(runs, "q", "boom", now);
    assert.equal(getPluginRun(runs, "q").state, "error");
    assert.equal(getPluginRun(runs, "q").error, "boom");
    assert.deepEqual(Object.keys(snapshotPluginRuns(runs)).sort(), ["p", "q"]);
  });

  it("includes L1_SHIMS overlays carrying shimmedEdges/syntheticConnectors in structureFp while excluding presentation-only plugins", () => {
    const shimWithEdge = overlay({
      entityId: "fn-button",
      layer: "L1_SHIMS",
      source: "local-shims",
      payload: {
        shimmedEdges: [{ shimId: "s1", sourceId: "fn-button", targetId: "du-web" }],
        presentation: presentation(0, "1 shim"),
      },
    });
    const emptyShimPkg = overlay({
      entityId: "du-web",
      layer: "L1_SHIMS",
      source: "local-shims",
      payload: {
        activeShims: 0,
        presentation: presentation(0, "0 shims"),
      },
    });
    const enrichOnly = overlay({
      entityId: "du-web",
      layer: "L1_SEMANTIC",
      source: "enrich-nodes",
      payload: { presentation: presentation(0, "Un-enriched") },
    });

    const split = splitOverlays([shimWithEdge, emptyShimPkg, enrichOnly]);
    const structural = overlaysForStructureFingerprint(split, false);
    assert.equal(structural.length, 1);
    assert.equal(structural[0]!.entityId, "fn-button");
    assert.equal(structural[0]!.layer, "L1_SHIMS");
  });

  it("aggregates multi-package repoHeadline, description, items, and repoPrompt cleanly across packages", () => {
    const makeShimPres = (pkgGap: number) => ({
      version: 1,
      summary: {
        status: "warn",
        badge: { text: `${pkgGap} unhandled`, tone: "warn" },
        issueCount: pkgGap,
        headline: `${pkgGap} unhandled call(s)`,
        repoHeadline: "5 unhandled calls",
        description: "Connects dynamic calls to unlock full flows.",
        items: [
          { label: "Imported registry / DI call", value: pkgGap },
        ],
        prompt: {
          label: "Copy pkg prompt",
          text: "pkg prompt",
        },
        repoPrompt: {
          label: "Copy agent prompt",
          text: "repo prompt",
          hint: "Ask your agent to wire unhandled calls.",
        },
      },
      sections: [{ id: "overview", title: "Overview", blocks: [{ kind: "text", text: "Shims" }] }],
    });

    const overview = buildPluginsOverview({
      pluginOverlays: [
        overlay({
          entityId: "du-web",
          layer: "L1_SHIMS",
          source: "local-shims",
          payload: { presentation: makeShimPres(2) },
        }),
        overlay({
          entityId: "du-admin",
          layer: "L1_SHIMS",
          source: "local-shims",
          payload: { presentation: makeShimPres(3) },
        }),
      ],
      nodes,
      registry: [{ name: "local-shims", displayName: "Custom links", layer: "L1_SHIMS" }],
      runs: {},
      structureFp: "sfp",
    });

    const p = overview.plugins[0]!;
    assert.equal(p.displayName, "Custom links");
    assert.equal(p.summary?.status, "warn");
    assert.equal(p.summary?.headline, "5 unhandled calls");
    assert.equal(p.summary?.description, "Connects dynamic calls to unlock full flows.");
    assert.deepEqual(p.summary?.items, [{ label: "Imported registry / DI call", value: 5 }]);
    assert.equal(p.summary?.prompt?.label, "Copy agent prompt");
    assert.equal(p.summary?.prompt?.text, "repo prompt");
  });

  it("sorts plugins by declarative order (Enrich nodes before Design system) and populates empty-state summary when overlayCount is 0", () => {
    const overview = buildPluginsOverview({
      pluginOverlays: [
        overlay({
          entityId: "du-web",
          layer: "L1_DESIGN_SYSTEM",
          source: "design-system",
          payload: { presentation: presentation(2) },
        }),
      ],
      nodes,
      registry: [
        {
          name: "design-system",
          displayName: "Design system",
          order: 30,
          layer: "L1_DESIGN_SYSTEM",
          description: "Design system audit.",
        },
        {
          name: "enrich-nodes",
          displayName: "Enrich nodes",
          order: 20,
          layer: "L1_SEMANTIC",
          description: "Replaces raw code identifiers with plain-English station names.",
        },
        {
          name: "local-shims",
          displayName: "Custom links",
          order: 10,
          layer: "L1_SHIMS",
          description: "Bridges runtime connections static code analysis can't prove.",
        },
      ],
      runs: {},
      structureFp: "sfp",
    });

    assert.deepEqual(
      overview.plugins.map((entry) => entry.displayName),
      ["Custom links", "Enrich nodes", "Design system"],
    );
    const enrichEntry = overview.plugins.find((entry) => entry.source === "enrich-nodes")!;
    assert.equal(enrichEntry.overlayCount, 0);
    assert.equal(enrichEntry.summary?.status, "unknown");
    assert.equal(enrichEntry.summary?.headline, "Not analyzed yet");
    assert.match(enrichEntry.summary?.description ?? "", /plain-English station names/);
  });

  it("forwards modular plugin settingsSchema, settings, stateDir, and mcpTools onto overview entries and bumps pluginFp on settings change", () => {
    const schema = [
      { key: "includeConfigShims", label: "Include config shims", kind: "boolean" as const, defaultValue: true },
    ];
    const overviewA = buildPluginsOverview({
      pluginOverlays: [],
      nodes,
      registry: [
        {
          name: "local-shims",
          displayName: "Local shims",
          layer: "L1_SHIMS",
          stateDir: ".chomp/plugins/local-shims",
          settingsSchema: schema,
          settings: { includeConfigShims: true },
          mcpTools: [{ name: "chomp_local_shims", description: "Manage local shims" }],
        },
      ],
      runs: {},
      structureFp: "sfp",
    });
    const entry = overviewA.plugins[0]!;
    assert.equal(entry.stateDir, ".chomp/plugins/local-shims");
    assert.deepEqual(entry.settingsSchema, schema);
    assert.deepEqual(entry.settings, { includeConfigShims: true });
    assert.equal(entry.mcpTools?.[0]?.name, "chomp_local_shims");

    const overviewB = buildPluginsOverview({
      pluginOverlays: [],
      nodes,
      registry: [
        {
          name: "local-shims",
          displayName: "Local shims",
          layer: "L1_SHIMS",
          stateDir: ".chomp/plugins/local-shims",
          settingsSchema: schema,
          settings: { includeConfigShims: false },
        },
      ],
      runs: {},
      structureFp: "sfp",
    });
    assert.notEqual(
      overviewA.fingerprint.pluginFp,
      overviewB.fingerprint.pluginFp,
      "Updating plugin settings should bump pluginFp so UI revalidates"
    );
  });

  it("isolates multi-environment runtime overlays (production vs staging) while preserving default L1 plugins", () => {
    const multiEnvOverlays = [
      overlay({
        entityId: "du-web",
        layer: "L1_DESIGN_SYSTEM",
        source: "design-system",
        environment: "default",
        payload: { presentation: presentation(2, "2 tokens") },
      }),
      overlay({
        entityId: "du-web",
        layer: "L2_RUNTIME",
        source: "kong-telemetry",
        environment: "production",
        payload: { presentation: presentation(5, "5 prod alerts") },
      }),
      overlay({
        entityId: "du-web",
        layer: "L2_RUNTIME",
        source: "kong-telemetry",
        environment: "staging",
        payload: { presentation: presentation(1, "1 staging alert") },
      }),
      overlay({
        entityId: "fn-button",
        layer: "L2_RUNTIME",
        source: "kong-telemetry",
        environment: "production",
        payload: { presentation: presentation(5, "prod endpoint") },
      }),
      overlay({
        entityId: "fn-button",
        layer: "L2_RUNTIME",
        source: "kong-telemetry",
        environment: "staging",
        payload: { presentation: presentation(1, "staging endpoint") },
      }),
    ];

    const reg = [
      { name: "design-system", displayName: "Design system", layer: "L1_DESIGN_SYSTEM" },
      { name: "kong-telemetry", displayName: "Kong telemetry", layer: "L2_RUNTIME" },
    ];

    // Default view picks production for Kong (never colliding staging + production!)
    const defaultOverview = buildPluginsOverview({
      pluginOverlays: multiEnvOverlays,
      nodes,
      registry: reg,
      runs: {},
      structureFp: "sfp",
    });
    assert.deepEqual(defaultOverview.availableEnvironments, ["default", "production", "staging"]);
    const kongProd = defaultOverview.plugins.find((p) => p.source === "kong-telemetry")!;
    assert.equal(kongProd.environment, "production");
    assert.equal(kongProd.packages.length, 1, "Must not collide staging + production package rows");
    assert.equal(kongProd.issueCount, 5);

    // Switching to staging updates Kong to staging while preserving L1 design-system ("default" fallback)
    const stagingOverview = buildPluginsOverview({
      pluginOverlays: multiEnvOverlays,
      nodes,
      registry: reg,
      runs: {},
      structureFp: "sfp",
      environment: "staging",
    });
    const kongStaging = stagingOverview.plugins.find((p) => p.source === "kong-telemetry")!;
    const dsFallback = stagingOverview.plugins.find((p) => p.source === "design-system")!;
    assert.equal(kongStaging.environment, "staging");
    assert.equal(kongStaging.issueCount, 1);
    assert.equal(dsFallback.environment, "default");
    assert.equal(dsFallback.issueCount, 2);

    // Entity presentations also isolate per environment without duplicate sections
    const prodEntity = buildEntityPresentations({
      pluginOverlays: multiEnvOverlays,
      entityId: "fn-button",
      registry: reg,
      environment: "production",
    });
    assert.equal(prodEntity.length, 1);
    assert.equal(prodEntity[0]!.environment, "production");
    assert.equal(prodEntity[0]!.presentation.summary?.badge?.text, "prod endpoint");

    const stagingEntity = buildEntityPresentations({
      pluginOverlays: multiEnvOverlays,
      entityId: "fn-button",
      registry: reg,
      environment: "staging",
    });
    assert.equal(stagingEntity.length, 1);
    assert.equal(stagingEntity[0]!.environment, "staging");
    assert.equal(stagingEntity[0]!.presentation.summary?.badge?.text, "staging endpoint");
  });
});
