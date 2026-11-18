import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { RepresentationGraph } from "@chomp/core";
import { getGitInfo, resolveRepoName } from "../utils/git.js";
import {
  getChompMasterRoot,
  listKnownTargetRepos,
  resolveDefaultCliTarget,
  resolveGitRepoRoot,
} from "../utils/masterContext.js";
import {
  detectSystemRules,
  getDefaultOverlayLayers,
  matchesCustomRule,
  normalizeRulesConfig,
} from "./rulesConfig.js";
import { loadLocalMasterLayoutEngine } from "./localEngineBridge.js";
import { computeGraphHealthMetrics } from "./healthMetrics.js";

const {
  runStoryTracer,
  runZipMerge,
  runGridMapper,
  buildPureLibraryFallbackBoard,
  estimateNodeVisualHeight,
} = await loadLocalMasterLayoutEngine();
import {
  LAYOUT_BUILD_STAGES,
  buildLayout,
  createBuildStatusTracker,
  isAllowedLocalhostOrigin,
  isLoopbackHostHeader,
} from "../commands/ui.js";
import { runExport } from "../commands/export.js";
import {
  KIRO_AUTO_APPROVE_TOOLS,
  detectAgentIntegrations,
  installKiroIntegration,
} from "../commands/init.js";
import { runUninstall } from "../commands/uninstall.js";
import { scaffoldDesignSystemConfig } from "../utils/branding.js";
import {
  buildPluginsOverview,
  computePluginFingerprint,
} from "./pluginPresentationApi.js";

describe("matchesCustomRule and runStoryTracer plugin overlay acceptance", () => {
  it("matchesCustomRule evaluates filePathPattern, overlayLayer, overlaySource, overlayField, and overlayValue", () => {
    const rawConfig = normalizeRulesConfig({
      version: 1,
      defaults: {
        foldMiddleware: true,
        foldComponents: true,
        foldMicroNodes: true,
      },
      customRules: [
        {
          id: "rule-design-token-drift",
          name: "Undefined CSS Token Drift",
          enabled: true,
          match: {
            filePathPattern: "components/visualizer",
            overlayLayer: "L1_DESIGN_SYSTEM",
            overlaySource: "ui-audit-plugin",
            overlayField: "undefinedVarCount",
            overlayValue: ">0",
          },
          action: "middleware_badge",
          badgeLabel: "token-drift",
          badgeMode: "badge_on_node",
        },
      ],
    });

    const rule = rawConfig.customRules[0];
    assert.equal(rule.match.overlayLayer, "L1_DESIGN_SYSTEM");
    assert.equal(rule.match.overlayField, "undefinedVarCount");

    const matchingNode = {
      id: "node-drawer",
      name: "Exported Function: NodeInspectorDrawer",
      label: "NodeInspectorDrawer",
      entityType: "EXPORTED_FUNCTION",
      evidence: [{ filePath: "apps/web/src/components/visualizer/NodeInspectorDrawer.tsx" }],
      overlays: [
        {
          layer: "L1_DESIGN_SYSTEM",
          source: "ui-audit-plugin",
          payload: {
            tier: "Component",
            undefinedVarCount: 2,
          },
        },
      ],
    };

    assert.equal(matchesCustomRule(matchingNode, "web", rule), true);

    const cleanNode = {
      ...matchingNode,
      overlays: [
        {
          layer: "L1_DESIGN_SYSTEM",
          source: "ui-audit-plugin",
          payload: {
            tier: "Component",
            undefinedVarCount: 0,
          },
        },
      ],
    };
    assert.equal(matchesCustomRule(cleanNode, "web", rule), false);
  });

  it("runStoryTracer attaches plugin overlay badges and evaluates overlay-matched rules when layer is enabled", () => {
    const graph: RepresentationGraph = {
      extractorVersion: "1.0.0",
      analyzedAt: "2026-11-01T00:00:00Z",
      nodes: [
        {
          id: "du-web",
          name: "Deployment Unit: @chomp/web",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "apps/web" },
        },
        {
          id: "page-home",
          name: "Next.js Page: /",
          type: "CONTRACT",
          entityType: "NEXTJS_PAGE",
          patternId: "contract.nextjs-page",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "apps/web/src/app/page.tsx", lineNumber: 11 },
        },
        {
          id: "comp-hud",
          name: "Exported Function: ChompHudControlsTw",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: {
            filePath: "apps/web/src/styleguide/tailwind/TailwindComponents.tsx",
            lineNumber: 1265,
          },
        },
      ],
      edges: [
        {
          id: "e-render-hud",
          name: "Renders: <ChompHudControlsTw />",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-render",
          sourceId: "page-home",
          targetId: "comp-hud",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "apps/web/src/app/page.tsx", lineNumber: 40 },
        },
      ],
    };

    const overlays = [
      {
        entityId: "comp-hud",
        layer: "L1_SEMANTIC",
        source: "chomp-agent",
        environment: "default",
        payload: {
          badges: ["Component: SemanticVerified"],
        },
      },
      {
        entityId: "comp-hud",
        layer: "L1_DESIGN_SYSTEM",
        source: "ui-audit-plugin",
        environment: "default",
        payload: {
          tier: "HUD Surface",
          badges: ["Component: DesignSystemVerified"],
          undefinedVarCount: 3,
        },
      },
    ];

    const rulesConfig = normalizeRulesConfig({
      version: 1,
      defaults: {
        foldMiddleware: true,
        foldComponents: false,
        foldMicroNodes: true,
      },
      overlayLayers: {
        L1_SEMANTIC: true,
        L1_DESIGN_SYSTEM: true,
      },
      customRules: [
        {
          id: "rule-ds-warn",
          name: "Design System Var Warning",
          enabled: true,
          match: {
            overlayLayer: "L1_DESIGN_SYSTEM",
            overlayField: "undefinedVarCount",
            overlayValue: ">=1",
          },
          action: "middleware_badge",
          badgeLabel: "undefined-vars",
          badgeMode: "badge_on_node",
        },
      ],
    });

    const storyGraph = runStoryTracer(graph, undefined, rulesConfig, overlays);
    const hudStoryNode = storyGraph.stories[0]?.nodes.find(
      (sn) => sn.originalId === "comp-hud"
    );
    assert.ok(hudStoryNode);
    assert.ok(
      hudStoryNode.node.badges.includes("Component: SemanticVerified"),
      "L1_SEMANTIC overlay payload.badges should attach when layer is enabled"
    );
    assert.ok(
      !hudStoryNode.node.badges.includes("Component: DesignSystemVerified"),
      "Raw L1_DESIGN_SYSTEM payload.badges should stay in overlay drawer unless matched by custom rule"
    );
    assert.ok(
      hudStoryNode.node.badges.includes("Middleware: undefined-vars"),
      "Custom rule matching plugin overlayField should attach badge onto station"
    );

    // Disabling L1_SEMANTIC and L1_DESIGN_SYSTEM in overlayLayers suppresses both the semantic overlay badges and rule match
    const disabledConfig = normalizeRulesConfig({
      ...rulesConfig,
      overlayLayers: {
        L1_SEMANTIC: false,
        L1_DESIGN_SYSTEM: false,
      },
    });
    const disabledStoryGraph = runStoryTracer(
      graph,
      undefined,
      disabledConfig,
      overlays
    );
    const hudDisabledNode = disabledStoryGraph.stories[0]?.nodes.find(
      (sn) => sn.originalId === "comp-hud"
    );
    assert.ok(hudDisabledNode);
    assert.equal(hudDisabledNode.node.badges.length, 0);
  });

  it("getGitInfo resolves active branchName and commitSha for the Visualizer HUD ([PAT-CLI-07], [PAT-VIS-24])", () => {
    const info = getGitInfo(process.cwd());
    assert.ok(info.branchName, "Expected branchName to be resolved");
    assert.ok(
      info.commitSha && /^[0-9a-f]{7,40}$/i.test(info.commitSha),
      "Expected commitSha to be a valid git hex SHA"
    );
  });

  it("preserves rawLabel on foldedMasterNodes when L1_SEMANTIC humanLabel overwrites label ([PAT-VIS-06], [PAT-VIS-13])", () => {
    const graph: any = {
      nodes: [
        {
          id: "du-web",
          name: "Deployment Unit: @chomp/web",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          scope: "USER",
        },
        {
          id: "page-styleguide",
          name: "Next.js Page: /styleguide",
          type: "CONTRACT",
          entityType: "NEXTJS_PAGE",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "apps/web/src/app/styleguide/page.tsx", lineNumber: 1 },
        },
        {
          id: "comp-drawer-gallery",
          name: "Exported Function: DrawerGallerySection",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "apps/web/src/styleguide/Stickers.tsx", lineNumber: 100 },
        },
        {
          id: "comp-section",
          name: "Exported Function: Section",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "apps/web/src/styleguide/Stickers.tsx", lineNumber: 320 },
        },
      ],
      edges: [
        {
          id: "e1",
          name: "Renders: <DrawerGallerySection />",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          sourceId: "page-styleguide",
          targetId: "comp-drawer-gallery",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
        {
          id: "e2",
          name: "Renders: <Section />",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          sourceId: "comp-drawer-gallery",
          targetId: "comp-section",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
      ],
    };

    const overlays = [
      {
        entityId: "comp-section",
        layer: "L1_SEMANTIC",
        source: "chomp-agent",
        environment: "default",
        payload: {
          humanLabel: "Section Header",
        },
      },
    ];

    const storyGraph = runStoryTracer(
      graph,
      undefined,
      normalizeRulesConfig({}),
      overlays
    );
    const galleryNode = storyGraph.stories[0]?.nodes.find(
      (sn) => sn.originalId === "comp-drawer-gallery"
    );
    assert.ok(galleryNode);
    assert.ok(galleryNode.node.badges.includes("Component: Section"));

    const sectionMaster = storyGraph.foldedMasterNodes?.find(
      (n) => n.id === "comp-section"
    );
    assert.ok(sectionMaster, "Expected Section in foldedMasterNodes");
    assert.equal(sectionMaster.label, "Section Header");
    assert.equal(sectionMaster.rawLabel, "Section");
  });

  it("getChompMasterRoot, listKnownTargetRepos, and resolveDefaultCliTarget resolve tethered and short-named repos", () => {
    const masterRoot = getChompMasterRoot();
    assert.ok(
      existsSync(resolve(masterRoot, "package.json")) &&
        JSON.parse(readFileSync(resolve(masterRoot, "package.json"), "utf8")).name === "chomp-monorepo",
      `Expected masterRoot to point to chomp-monorepo root, got ${masterRoot}`
    );
    const known = listKnownTargetRepos();
    assert.ok(known.length >= 1, "Expected at least the Chomp master repository in listKnownTargetRepos()");
    assert.ok(known.some((r) => r.path === masterRoot), "Expected masterRoot in listKnownTargetRepos()");

    const expressRes = resolveDefaultCliTarget("express-app", masterRoot, true);
    assert.equal(expressRes.explicit, true);
    assert.ok(expressRes.targetPath.endsWith("fixtures/test-repos/express-app"));

    const nextjsRoot = resolveGitRepoRoot(
      `${masterRoot}/fixtures/cloned-repos/nextjs-postgres-template`,
    );
    assert.ok(
      nextjsRoot.endsWith("fixtures/cloned-repos/nextjs-postgres-template"),
      `Expected non-git fixture repo root to stay at nextjs-postgres-template, got ${nextjsRoot}`,
    );

    const chompRes = resolveDefaultCliTarget("chomp", masterRoot, true);
    assert.equal(chompRes.explicit, true);
    assert.equal(chompRes.targetPath, masterRoot);
  });

  it("folds pure leaf UI primitives (e.g. Button, Tabs) and Next.js sub-route layout guards into foldedMasterNodes while preserving full route labels ([PAT-VIS-05], [PAT-VIS-06], [PAT-VIS-13])", () => {
    const graph: RepresentationGraph = {
      extractorVersion: "1.1.0",
      analyzedAt: "2026-11-04T00:00:00Z",
      nodes: [
        {
          id: "du-client",
          name: "Deployment Unit: client",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "client" },
        },
        {
          id: "layout-admin",
          name: "Next.js Layout: /admin",
          type: "CONTRACT",
          entityType: "NEXTJS_LAYOUT",
          patternId: "boundary.nextjs-layout-component",
          parentBoundaryId: "du-client",
          scope: "USER",
          metadata: { routePath: "/admin", layoutPath: "/admin", componentName: "AdminLayout" },
          evidence: { filePath: "client/src/app/admin/layout.js", lineNumber: 3 },
        },
        {
          id: "layout-dashboard",
          name: "Next.js Layout: /admin/(dashboard)",
          type: "CONTRACT",
          entityType: "NEXTJS_LAYOUT",
          patternId: "boundary.nextjs-layout-component",
          parentBoundaryId: "du-client",
          scope: "USER",
          metadata: { routePath: "/admin", layoutPath: "/admin/(dashboard)", componentName: "DashboardLayout" },
          evidence: { filePath: "client/src/app/admin/(dashboard)/layout.js", lineNumber: 8 },
        },
        {
          id: "page-edit",
          name: "Next.js Page: /admin/briefs/[id]/edit",
          type: "CONTRACT",
          entityType: "NEXTJS_PAGE",
          patternId: "boundary.nextjs-page-component",
          parentBoundaryId: "du-client",
          scope: "USER",
          metadata: { routePath: "/admin/briefs/[id]/edit", componentName: "EditBriefPage" },
          evidence: { filePath: "client/src/app/admin/(editor)/briefs/[id]/edit/page.js", lineNumber: 8 },
        },
        {
          id: "page-briefs",
          name: "Next.js Page: /admin/briefs",
          type: "CONTRACT",
          entityType: "NEXTJS_PAGE",
          patternId: "boundary.nextjs-page-component",
          parentBoundaryId: "du-client",
          scope: "USER",
          metadata: { routePath: "/admin/briefs", componentName: "BriefsPage" },
          evidence: { filePath: "client/src/app/admin/(dashboard)/briefs/page.js", lineNumber: 5 },
        },
        {
          id: "comp-protected",
          name: "Exported Function: ProtectedRoute",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-client",
          scope: "USER",
          evidence: { filePath: "client/src/app/ProtectedRoute.js", lineNumber: 7 },
        },
        {
          id: "comp-button",
          name: "Exported Function: Button",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.react-hoc-wrapped-component",
          parentBoundaryId: "du-client",
          scope: "USER",
          evidence: { filePath: "client/src/components/Button.js", lineNumber: 12 },
        },
        {
          id: "comp-tabs",
          name: "Exported Function: Tabs",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-client",
          scope: "USER",
          evidence: { filePath: "client/src/components/navigation/Tabs.js", lineNumber: 6 },
        },
        {
          id: "comp-brief-form",
          name: "Exported Function: BriefForm",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-client",
          scope: "USER",
          evidence: { filePath: "client/src/app/admin/(editor)/_components/BriefForm.js", lineNumber: 10 },
        },
        {
          id: "fn-update-brief",
          name: "Exported Function: updateBrief",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-client",
          scope: "USER",
          evidence: { filePath: "client/src/api/briefs.js", lineNumber: 8 },
        },
      ],
      edges: [
        {
          id: "e-layout-guard",
          name: "Renders: <ProtectedRoute />",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-element",
          sourceId: "layout-admin",
          targetId: "comp-protected",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "client/src/app/admin/layout.js", lineNumber: 5 },
        },
        {
          id: "e-dash-btn",
          name: "Renders: <Button />",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-element",
          sourceId: "layout-dashboard",
          targetId: "comp-button",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "client/src/app/admin/(dashboard)/layout.js", lineNumber: 18 },
        },
        {
          id: "e-dash-tabs",
          name: "Renders: <Tabs />",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-element",
          sourceId: "layout-dashboard",
          targetId: "comp-tabs",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "client/src/app/admin/(dashboard)/layout.js", lineNumber: 22 },
        },
        {
          id: "e-edit-form",
          name: "Renders: <BriefForm />",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-element",
          sourceId: "page-edit",
          targetId: "comp-brief-form",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "client/src/app/admin/(editor)/briefs/[id]/edit/page.js", lineNumber: 27 },
        },
        {
          id: "e-form-btn",
          name: "Renders: <Button />",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-element",
          sourceId: "comp-brief-form",
          targetId: "comp-button",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "client/src/app/admin/(editor)/_components/BriefForm.js", lineNumber: 45 },
        },
        {
          id: "e-briefs-api",
          name: "Call: updateBrief()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.function-call",
          sourceId: "page-briefs",
          targetId: "fn-update-brief",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "client/src/app/admin/(dashboard)/briefs/page.js", lineNumber: 10 },
        },
      ],
    };

    const storyGraph = runStoryTracer(graph, undefined, normalizeRulesConfig({}));

    // 1. Left-to-right Next.js App Router hierarchy unrolling ([PAT-VIS-33]) with full route labels
    const editStory = storyGraph.stories.find((s) =>
      s.nodes.some((sn) => sn.originalId === "page-edit")
    );
    assert.ok(editStory, "Expected story reaching page-edit");
    assert.equal(editStory.nodes[0].originalId, "layout-admin");
    assert.equal(editStory.nodes[0].column, 0);
    assert.equal(editStory.nodes[0].node.label, "/admin");

    const editPageNode = editStory.nodes.find((sn) => sn.originalId === "page-edit")!;
    assert.ok(editPageNode, "Expected page-edit node in editStory");
    assert.equal(editPageNode.node.label, "/admin/briefs/[id]/edit");
    assert.ok(editPageNode.column > 0, "Expected nested route page-edit to unroll at column > 0");
    assert.ok(editPageNode.node.badges.includes("Component: ProtectedRoute"));

    const briefsStory = storyGraph.stories.find((s) =>
      s.nodes.some((sn) => sn.originalId === "fn-update-brief")
    );
    assert.ok(briefsStory, "Expected story reaching fn-update-brief via page-briefs");
    const briefsPageNode = briefsStory.nodes.find((sn) => sn.originalId === "page-briefs")!;
    assert.ok(briefsPageNode, "Expected page-briefs node in briefsStory");
    assert.equal(briefsPageNode.node.label, "/admin/briefs");
    assert.ok(briefsPageNode.column > 0, "Expected nested route page-briefs to unroll at column > 0");
    assert.ok(briefsPageNode.node.badges.includes("Component: ProtectedRoute"));
    assert.ok(briefsPageNode.node.badges.includes("Component: Tabs"));
    assert.ok(briefsPageNode.node.badges.includes("Component: Button"));

    // 2. Button, Tabs, and ProtectedRoute fold into foldedMasterNodes (Invariants)
    const masterIds = new Set((storyGraph.foldedMasterNodes ?? []).map((m) => m.id));
    assert.ok(masterIds.has("comp-button"), "Expected Button in foldedMasterNodes (Invariants)");
    assert.ok(masterIds.has("comp-tabs"), "Expected Tabs in foldedMasterNodes (Invariants)");
    assert.ok(masterIds.has("comp-protected"), "Expected ProtectedRoute in foldedMasterNodes (Invariants)");

    // 3. Composite section component (BriefForm, which has child badge Component: Button) remains on the story lane
    const briefFormNode = editStory.nodes.find((sn) => sn.originalId === "comp-brief-form");
    assert.ok(briefFormNode, "Expected composite BriefForm component to remain on the story lane");
    assert.ok(briefFormNode.node.badges.includes("Component: Button"));
  });

  it("isLoopbackHostHeader and isAllowedLocalhostOrigin enforce loopback Host & localhost CORS while blocking external origins", () => {
    // Valid loopback Host headers
    assert.equal(isLoopbackHostHeader("localhost"), true);
    assert.equal(isLoopbackHostHeader("localhost:5555"), true);
    assert.equal(isLoopbackHostHeader("127.0.0.1:5555"), true);
    assert.equal(isLoopbackHostHeader("[::1]:5555"), true);

    // Blocked non-loopback Host headers (DNS rebinding protection)
    assert.equal(isLoopbackHostHeader(undefined), false);
    assert.equal(isLoopbackHostHeader(""), false);
    assert.equal(isLoopbackHostHeader("evil.example.com"), false);
    assert.equal(isLoopbackHostHeader("localhost.evil.com:5555"), false);

    // Valid localhost & official hosted Chomp Visualizer Origin headers
    assert.equal(isAllowedLocalhostOrigin(undefined), true);
    assert.equal(isAllowedLocalhostOrigin("http://localhost:3000"), true);
    assert.equal(isAllowedLocalhostOrigin("http://localhost:3001"), true);
    assert.equal(isAllowedLocalhostOrigin("http://127.0.0.1:5555"), true);
    assert.equal(isAllowedLocalhostOrigin("http://[::1]:3000"), true);
    assert.equal(isAllowedLocalhostOrigin("https://getchomp.dev"), true);
    assert.equal(isAllowedLocalhostOrigin("https://app.getchomp.dev"), true);
    assert.equal(isAllowedLocalhostOrigin("https://preview.chomp-visualizer.pages.dev"), true);

    // Blocked non-localhost / non-official Origin headers
    assert.equal(isAllowedLocalhostOrigin("https://evil.example.com"), false);
    assert.equal(isAllowedLocalhostOrigin("http://app.getchomp.dev"), false);
    assert.equal(isAllowedLocalhostOrigin("https://getchomp.dev.evil.com"), false);
    assert.equal(isAllowedLocalhostOrigin("http://localhost.evil.com:3000"), false);
    assert.equal(isAllowedLocalhostOrigin("null"), false);
  });

  it("runGridMapper folds parallel pass-through shims and 2-hop terminal helper subtrees into station foldedFunctions ([PAT-VIS-18] v2)", () => {
    const graph: any = {
      nodes: [
        {
          id: "du-core",
          name: "Deployment Unit: @chomp/core",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          scope: "USER",
        },
        {
          id: "du-cli",
          name: "Deployment Unit: @chomp/cli",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          scope: "USER",
        },
        {
          id: "cli-entry",
          name: "CLI Command: analyze",
          type: "CONTRACT",
          entityType: "CLI_COMMAND",
          parentBoundaryId: "du-cli",
          scope: "USER",
        },
        {
          id: "core-entry",
          name: "Exported Function: analyzeTarget",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          parentBoundaryId: "du-core",
          scope: "USER",
        },
        {
          id: "visit-contract",
          name: "Exported Function: visitContract",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          parentBoundaryId: "du-core",
          scope: "USER",
        },
        {
          id: "shim-a",
          name: "Exported Function: extractExpressRoute",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          parentBoundaryId: "du-core",
          scope: "USER",
        },
        {
          id: "shim-b",
          name: "Exported Function: extractNextjsRoute",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          parentBoundaryId: "du-core",
          scope: "USER",
        },
        {
          id: "apply-rules",
          name: "Exported Function: applyConventionRules",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          parentBoundaryId: "du-core",
          scope: "USER",
        },
        {
          id: "wrapper-id",
          name: "Exported Function: contractEntityId",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          parentBoundaryId: "du-core",
          scope: "USER",
        },
        {
          id: "leaf-id",
          name: "Exported Function: stableEntityId",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          parentBoundaryId: "du-core",
          scope: "USER",
        },
      ],
      edges: [
        {
          id: "e-cross",
          name: "Call: analyzeTarget()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          sourceId: "cli-entry",
          targetId: "core-entry",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
        {
          id: "e-1",
          name: "Call: visitContract()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          sourceId: "core-entry",
          targetId: "visit-contract",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
        {
          id: "e-2a",
          name: "Call: extractExpressRoute()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          sourceId: "visit-contract",
          targetId: "shim-a",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
        {
          id: "e-2b",
          name: "Call: extractNextjsRoute()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          sourceId: "visit-contract",
          targetId: "shim-b",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
        {
          id: "e-3a",
          name: "Call: applyConventionRules()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          sourceId: "shim-a",
          targetId: "apply-rules",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
        {
          id: "e-3b",
          name: "Call: applyConventionRules()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          sourceId: "shim-b",
          targetId: "apply-rules",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
        {
          id: "e-4",
          name: "Call: contractEntityId()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          sourceId: "apply-rules",
          targetId: "wrapper-id",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
        {
          id: "e-5",
          name: "Call: stableEntityId()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          sourceId: "wrapper-id",
          targetId: "leaf-id",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
        },
      ],
    };

    const config = normalizeRulesConfig({});
    const traced = runStoryTracer(graph, undefined, config);
    const merged = runZipMerge(traced);
    const layout = runGridMapper(merged, config);

    const coreStations = layout.nodes.filter(
      (n) => !n.isPackage && n.packageLabel === "core"
    );
    // Zero separate microNodes clusters are spawned when foldMicroNodes is enabled
    assert.ok(
      coreStations.every((n) => !n.microNodes || n.microNodes.length === 0),
      "Expected zero separate microNodes cells on the transit map"
    );

    const visitContractStation = coreStations.find((n) =>
      n.id.includes("visit-contract")
    );
    assert.ok(visitContractStation, "Expected visitContract station on the board");
    assert.equal(visitContractStation.role, "TRANSIT", "Expected visitContract to be classified as a TRANSIT station");
    const visitFoldedIds = new Set(
      (visitContractStation.foldedFunctions ?? []).map((f) => f.originalId)
    );
    assert.ok(visitFoldedIds.has("shim-a"), "Expected shim-a folded into visitContract");
    assert.ok(visitFoldedIds.has("shim-b"), "Expected shim-b folded into visitContract");

    const applyRulesStation = coreStations.find((n) =>
      n.id.includes("apply-rules")
    );
    assert.ok(applyRulesStation, "Expected applyConventionRules station on the board");
    assert.equal(applyRulesStation.role, "RETURN", "Expected applyConventionRules to be classified as a RETURN station");
    const applyFoldedIds = new Set(
      (applyRulesStation.foldedFunctions ?? []).map((f) => f.originalId)
    );
    assert.ok(applyFoldedIds.has("wrapper-id"), "Expected 2-hop wrapper-id folded into applyConventionRules");
    assert.ok(applyFoldedIds.has("leaf-id"), "Expected leaf-id folded into applyConventionRules");

    const coreInvariants = (layout.invariantNodes ?? []).filter(
      (n) => n.packageLabel === "core"
    );
    const invById = new Map(coreInvariants.map((n) => [n.id, n]));
    assert.ok(invById.has("wrapper-id"), "Expected wrapper-id utility in invariantNodes");
    assert.ok(invById.has("leaf-id"), "Expected leaf-id utility in invariantNodes");
    assert.equal(invById.get("wrapper-id")?.callerCount, 1);
    assert.equal(invById.get("leaf-id")?.callerCount, 1);
    assert.equal(
      invById.get("wrapper-id")?.foldedFunctions?.[0]?.originalId,
      "leaf-id",
      "Expected composite utility invariant wrapper-id to retain its nested foldedFunctions"
    );
  });

  it("buildPureLibraryFallbackBoard expands row heights for nodes with nested badges and orders invariants by category then callerCount ([PAT-VIS-06], [PAT-VIS-17])", async () => {
    const fallbackBoard = buildPureLibraryFallbackBoard(
      "ui",
      [
        {
          id: "class-store",
          label: "Store",
          ontologyType: "BOUNDARY",
          entityType: "CLASS",
          isPackage: false,
          packageLabel: "ui",
          badges: [
            "Middleware: firstMethod",
            "Middleware: secondMethod",
            "Middleware: thirdMethod",
          ],
          callerCount: 4,
          evidence: [],
        },
        {
          id: "fn-plain",
          label: "formatLabel",
          ontologyType: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          isPackage: false,
          packageLabel: "ui",
          badges: [],
          callerCount: 2,
          evidence: [],
        },
        {
          id: "fn-row2",
          label: "parseToken",
          ontologyType: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          isPackage: false,
          packageLabel: "ui",
          badges: [],
          callerCount: 1,
          evidence: [],
        },
      ],
      new Set()
    );

    const storeNode = fallbackBoard.nodeByOriginalId.get("class-store")?.layoutNode;
    const row2Node = fallbackBoard.nodeByOriginalId.get("fn-row2")?.layoutNode;
    assert.ok(storeNode && row2Node);
    assert.ok(
      storeNode.height > 36,
      `Expected multi-badge CLASS card height (${storeNode.height}) to expand above 36px`
    );
    assert.equal(storeNode.height, estimateNodeVisualHeight(storeNode));
    assert.ok(
      row2Node.y >= storeNode.height + 20,
      `Expected row 1 y (${row2Node.y}) to shift below expanded row 0 height (${storeNode.height})`
    );
  });

  it("folds leaf UI components that depend on EXTERNAL_PACKAGE connectors across both components and NEXTJS_PAGE routes and records full callerCount in invariantNodes ([PAT-VIS-13])", () => {
    const graph: RepresentationGraph = {
      extractorVersion: "1.1.0",
      analyzedAt: "2026-11-10T00:00:00Z",
      nodes: [
        {
          id: "du-web",
          name: "Deployment Unit: bite-size-web",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "client" },
        },
        {
          id: "page-home",
          name: "Next.js Page: /",
          type: "CONTRACT",
          entityType: "NEXTJS_PAGE",
          patternId: "boundary.nextjs-page-component",
          parentBoundaryId: "du-web",
          scope: "USER",
          metadata: { routePath: "/" },
          evidence: { filePath: "client/src/app/page.js", lineNumber: 1 },
        },
        {
          id: "page-styleguide",
          name: "Next.js Page: /styleguide",
          type: "CONTRACT",
          entityType: "NEXTJS_PAGE",
          patternId: "boundary.nextjs-page-component",
          parentBoundaryId: "du-web",
          scope: "USER",
          metadata: { routePath: "/styleguide" },
          evidence: { filePath: "client/src/app/styleguide/page.js", lineNumber: 1 },
        },
        {
          id: "comp-hero",
          name: "Exported Function: Hero",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "client/src/app/_components/Hero.js", lineNumber: 1 },
        },
        {
          id: "comp-drawer",
          name: "Exported Function: Drawer",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "client/src/app/_components/Drawer.js", lineNumber: 1 },
        },
        {
          id: "comp-button",
          name: "Exported Function: Button",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.react-hoc-wrapped-component",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "client/src/app/_components/Button.js", lineNumber: 1 },
        },
        {
          id: "pkg-clsx",
          name: "pkg:clsx",
          type: "OPEN_CONNECTOR",
          entityType: "EXTERNAL_PACKAGE",
          patternId: "open-connector.external-package",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "client/src/app/_components/Button.js", lineNumber: 2 },
        },
      ],
      edges: [
        {
          id: "e-home-hero",
          name: "RENDERS: Hero",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-render",
          sourceId: "page-home",
          targetId: "comp-hero",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "client/src/app/page.js", lineNumber: 5 },
        },
        {
          id: "e-home-drawer",
          name: "RENDERS: Drawer",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-render",
          sourceId: "page-home",
          targetId: "comp-drawer",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "client/src/app/page.js", lineNumber: 6 },
        },
        {
          id: "e-hero-button",
          name: "RENDERS: Button",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-render",
          sourceId: "comp-hero",
          targetId: "comp-button",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "client/src/app/_components/Hero.js", lineNumber: 8 },
        },
        {
          id: "e-drawer-button",
          name: "RENDERS: Button",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-render",
          sourceId: "comp-drawer",
          targetId: "comp-button",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "client/src/app/_components/Drawer.js", lineNumber: 8 },
        },
        {
          id: "e-styleguide-button",
          name: "RENDERS: Button",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-render",
          sourceId: "page-styleguide",
          targetId: "comp-button",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "client/src/app/styleguide/page.js", lineNumber: 10 },
        },
        {
          id: "e-button-clsx",
          name: "CALLS: clsx",
          type: "RELATIONSHIP",
          entityType: "CALLS",
          patternId: "relationship.function-call",
          sourceId: "comp-button",
          targetId: "pkg-clsx",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "client/src/app/_components/Button.js", lineNumber: 12 },
        },
      ],
    };

    const traced = runStoryTracer(graph);
    const zipped = runZipMerge(traced);
    const layout = runGridMapper(zipped);

    // Button should not leak as a standalone station node on `/styleguide`
    const buttonStations = layout.nodes.filter((n) => n.label === "Button");
    assert.equal(buttonStations.length, 0);

    // Button must appear in invariantNodes with callerCount === 3 (Hero, Drawer, /styleguide) and entityType upgraded to REACT_COMPONENT
    const buttonInv = layout.invariantNodes?.find((n) => n.label === "Button");
    assert.ok(buttonInv, "Expected Button to be present in layout.invariantNodes");
    assert.equal(buttonInv.callerCount, 3);
    assert.equal(buttonInv.entityType, "REACT_COMPONENT");
  });

  it("Wave 4 ([PAT-EXT-74]): traverses MOUNTS/BINDS_ROUTE/REFERENCES, keeps OPEN_CONNECTOR side-effects as EGRESS, protects stateful REACT_COMPONENTs, preserves Next.js sibling pages & layouts, folds passive DTO/Error classes, and suppresses synthetic Express middleware duplicates", () => {
    const graph: RepresentationGraph = {
      extractorVersion: "1.1.0",
      analyzedAt: "2026-11-12T00:00:00Z",
      nodes: [
        {
          id: "du-app",
          name: "Deployment Unit: app",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "apps/app" },
        },
        {
          id: "du-infra",
          name: "Deployment Unit: infra",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "packages/infra" },
        },
        {
          id: "init-app",
          name: "Init: app",
          type: "BOUNDARY",
          entityType: "INIT_BLOCK",
          patternId: "boundary.init-block",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/server.ts", lineNumber: 1 },
        },
        {
          id: "mw-synth-tokencheck",
          name: "Middleware: tokenCheck",
          type: "CONTRACT",
          entityType: "MIDDLEWARE",
          patternId: "boundary.express-middleware",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/server.ts", lineNumber: 5 },
        },
        {
          id: "fn-tokencheck",
          name: "Exported Function: tokenCheck",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/middleware/tokenCheck.ts", lineNumber: 1 },
        },
        {
          id: "router-v1",
          name: "Exported Module: v1Router",
          type: "CONTRACT",
          entityType: "EXPORTED_MODULE",
          patternId: "contract.exported-module",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/routes/v1.ts", lineNumber: 1 },
        },
        {
          id: "route-build",
          name: "Express Route: POST /v1/build",
          type: "CONTRACT",
          entityType: "HTTP_ENDPOINT",
          patternId: "contract.express-route",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/routes/v1.ts", lineNumber: 10 },
        },
        {
          id: "singleton-env",
          name: "Exported Module: env",
          type: "CONTRACT",
          entityType: "EXPORTED_MODULE",
          patternId: "contract.exported-module",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/env.ts", lineNumber: 1 },
        },
        {
          id: "oc-exec",
          name: "Subprocess: child_process.exec",
          type: "OPEN_CONNECTOR",
          entityType: "SUBPROCESS_EXEC",
          patternId: "open-connector.subprocess-exec",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/routes/v1.ts", lineNumber: 12 },
        },
        {
          id: "cls-dto",
          name: "Class: BuildResultEntity",
          type: "BOUNDARY",
          entityType: "CLASS",
          patternId: "boundary.class",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/entities/BuildResultEntity.ts", lineNumber: 1 },
        },
        {
          id: "cls-err",
          name: "Class: BuildFailedError",
          type: "BOUNDARY",
          entityType: "CLASS",
          patternId: "boundary.class",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/errors/BuildFailedError.ts", lineNumber: 1 },
        },
        {
          id: "layout-main",
          name: "Next.js Layout: /blog",
          type: "CONTRACT",
          entityType: "NEXTJS_LAYOUT",
          patternId: "boundary.nextjs-layout-component",
          parentBoundaryId: "du-app",
          scope: "USER",
          metadata: { layoutPath: "/blog" },
          evidence: { filePath: "apps/app/app/blog/layout.tsx", lineNumber: 1 },
        },
        {
          id: "layout-empty",
          name: "Next.js Layout: /marketing",
          type: "CONTRACT",
          entityType: "NEXTJS_LAYOUT",
          patternId: "boundary.nextjs-layout-component",
          parentBoundaryId: "du-app",
          scope: "USER",
          metadata: { layoutPath: "/marketing" },
          evidence: { filePath: "apps/app/app/marketing/layout.tsx", lineNumber: 1 },
        },
        {
          id: "page-blog",
          name: "Next.js Page: /blog",
          type: "CONTRACT",
          entityType: "NEXTJS_PAGE",
          patternId: "boundary.nextjs-page-component",
          parentBoundaryId: "du-app",
          scope: "USER",
          metadata: { routePath: "/blog" },
          evidence: { filePath: "apps/app/app/blog/page.tsx", lineNumber: 1 },
        },
        {
          id: "page-blog-slug",
          name: "Next.js Page: /blog/[slug]",
          type: "CONTRACT",
          entityType: "NEXTJS_PAGE",
          patternId: "boundary.nextjs-page-component",
          parentBoundaryId: "du-app",
          scope: "USER",
          metadata: { routePath: "/blog/[slug]" },
          evidence: { filePath: "apps/app/app/blog/[slug]/page.tsx", lineNumber: 1 },
        },
        {
          id: "comp-iframe-preview",
          name: "Exported Function: IFramePreview",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/components/IFramePreview.tsx", lineNumber: 1 },
        },
        {
          id: "oc-fetch-preview",
          name: "HTTP Call: fetch",
          type: "OPEN_CONNECTOR",
          entityType: "HTTP_FETCH",
          patternId: "open-connector.http-fetch",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/components/IFramePreview.tsx", lineNumber: 6 },
        },
        {
          id: "dead-export-caller",
          name: "Exported Function: unusedHelper",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-app",
          scope: "USER",
          evidence: { filePath: "apps/app/helpers/unusedHelper.ts", lineNumber: 1 },
        },
        {
          id: "infra-client",
          name: "Exported Function: createInfraClient",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-infra",
          scope: "USER",
          evidence: { filePath: "packages/infra/client.ts", lineNumber: 1 },
        },
        {
          id: "oc-infra-db",
          name: "DB Call: pool.query",
          type: "OPEN_CONNECTOR",
          entityType: "DB_QUERY",
          patternId: "open-connector.db-query",
          parentBoundaryId: "du-infra",
          scope: "USER",
          evidence: { filePath: "packages/infra/client.ts", lineNumber: 5 },
        },
      ],
      edges: [
        // Synthetic Express middleware + real imported handler on same Init block
        {
          id: "e-init-mw-synth",
          name: "Express Mount: / -> tokenCheck",
          type: "RELATIONSHIP",
          entityType: "INTERCEPTS",
          patternId: "relationship.express-use-middleware",
          sourceId: "init-app",
          targetId: "mw-synth-tokencheck",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/server.ts", lineNumber: 5 },
        },
        {
          id: "e-init-mw-real",
          name: "Call: tokenCheck()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.function-call",
          sourceId: "init-app",
          targetId: "fn-tokencheck",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/server.ts", lineNumber: 5 },
        },
        // MOUNTS -> BINDS_ROUTE -> REFERENCES + SUBPROCESS_EXEC + passive DTO/Error classes
        {
          id: "e-init-mount-v1",
          name: "Express Mount: /v1 -> v1Router",
          type: "RELATIONSHIP",
          entityType: "MOUNTS",
          patternId: "relationship.express-router-mount",
          sourceId: "init-app",
          targetId: "router-v1",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/server.ts", lineNumber: 6 },
        },
        {
          id: "e-router-binds-build",
          name: "Binds Route: POST /v1/build",
          type: "RELATIONSHIP",
          entityType: "BINDS_ROUTE",
          patternId: "relationship.router-binds-route",
          sourceId: "router-v1",
          targetId: "route-build",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/routes/v1.ts", lineNumber: 10 },
        },
        {
          id: "e-build-ref-env",
          name: "References: env.PORT",
          type: "RELATIONSHIP",
          entityType: "REFERENCES",
          patternId: "relationship.references",
          sourceId: "route-build",
          targetId: "singleton-env",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/routes/v1.ts", lineNumber: 11 },
        },
        {
          id: "e-build-exec",
          name: "Subprocess: child_process.exec",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.subprocess-exec",
          sourceId: "route-build",
          targetId: "oc-exec",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/routes/v1.ts", lineNumber: 12 },
        },
        {
          id: "e-build-dto",
          name: "Call: new BuildResultEntity()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.function-call",
          sourceId: "route-build",
          targetId: "cls-dto",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/routes/v1.ts", lineNumber: 13 },
        },
        {
          id: "e-build-err",
          name: "Call: new BuildFailedError()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.function-call",
          sourceId: "route-build",
          targetId: "cls-err",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/routes/v1.ts", lineNumber: 14 },
        },
        // Single-caller stateful view component rendered via JSX
        {
          id: "e-slug-preview",
          name: "Renders: <IFramePreview />",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-element",
          sourceId: "page-blog-slug",
          targetId: "comp-iframe-preview",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/app/blog/[slug]/page.tsx", lineNumber: 8 },
        },
        {
          id: "e-preview-fetch",
          name: "HTTP Call: fetch",
          type: "RELATIONSHIP",
          entityType: "HTTP_FETCH",
          patternId: "relationship.http-fetch",
          sourceId: "comp-iframe-preview",
          targetId: "oc-fetch-preview",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/components/IFramePreview.tsx", lineNumber: 6 },
        },
        // Unimported dead helper in `app` calling `createInfraClient` in `infra` (ranked 0 in `infra`)
        {
          id: "e-dead-infra",
          name: "Call: createInfraClient()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.function-call",
          sourceId: "dead-export-caller",
          targetId: "infra-client",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/app/helpers/unusedHelper.ts", lineNumber: 4 },
        },
        {
          id: "e-infra-db",
          name: "DB Call: pool.query",
          type: "RELATIONSHIP",
          entityType: "DB_QUERY",
          patternId: "relationship.db-query",
          sourceId: "infra-client",
          targetId: "oc-infra-db",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "packages/infra/client.ts", lineNumber: 5 },
        },
      ],
    };

    const traced = runStoryTracer(graph);
    const zipped = runZipMerge(traced);
    const layout = runGridMapper(zipped);

    // 1. Router mounted via MOUNTS and singleton referenced via REFERENCES must not starve into orphanNodes
    const orphanIds = new Set(traced.orphanNodes.map((o) => o.id));
    assert.ok(!orphanIds.has("router-v1"), "v1Router mounted via MOUNTS must not be orphaned");
    assert.ok(!orphanIds.has("singleton-env"), "env singleton referenced via REFERENCES must not be orphaned");

    // 2. Synthetic Express middleware duplicate (`mw-synth-tokencheck`) is suppressed while real `fn-tokencheck` is retained once in invariantNodes
    const invIds = new Set((layout.invariantNodes ?? []).map((n) => n.id));
    assert.ok(!invIds.has("mw-synth-tokencheck"), "Synthetic middleware duplicate must not appear in invariantNodes");
    assert.ok(invIds.has("fn-tokencheck"), "Real imported middleware contract must appear in invariantNodes");

    // 3. SUBPROCESS_EXEC Open Connector remains a visible EGRESS station on the board (never folded into foldedFunctions)
    const appStations = layout.nodes.filter((n) => !n.isPackage && n.packageLabel === "app");
    const execStation = appStations.find((n) => n.id.includes("oc-exec"));
    assert.ok(execStation, "Expected Subprocess OPEN_CONNECTOR to remain a placed station");
    assert.equal(execStation.role, "EGRESS");

    // 4. Passive DTO/Entity and Error classes are folded into invariantNodes rather than placed as RETURN stations
    assert.ok(!appStations.some((n) => n.id.includes("cls-dto")), "BuildResultEntity must not be placed as a RETURN station");
    assert.ok(!appStations.some((n) => n.id.includes("cls-err")), "BuildFailedError must not be placed as a RETURN station");
    assert.ok(invIds.has("cls-dto"), "BuildResultEntity must appear in invariantNodes");
    assert.ok(invIds.has("cls-err"), "BuildFailedError must appear in invariantNodes");

    // 5. Stateful JSX-rendered view component (`IFramePreview`) is upgraded to REACT_COMPONENT and stays a placed station
    const previewStation = appStations.find((n) => n.id.includes("comp-iframe-preview"));
    assert.ok(previewStation, "Single-caller stateful IFramePreview component must not fold into FOLDED_UTILITY");
    assert.equal(previewStation.entityType, "REACT_COMPONENT");

    // 6. Next.js `/blog` page does NOT parent `/blog/[slug]` page (both are sibling children of `/blog` layout), and empty `/marketing` layout stays in invariantNodes
    const blogPageToSlugEdge = layout.edges.find(
      (e) => e.sourceId.includes("page-blog::") && e.targetId.includes("page-blog-slug")
    );
    assert.equal(blogPageToSlugEdge, undefined, "/blog page must not parent /blog/[slug] page");
    assert.ok(invIds.has("layout-empty"), "Folded empty Next.js layout must be retained in invariantNodes");

    // 7. Unimported dead helper (`unusedHelper`) stays in orphanNodes without emitting a dangling `createInfraClient (To: infra)` EGRESS station in `app`
    assert.ok(orphanIds.has("dead-export-caller"), "Unimported dead helper must remain in orphanNodes");
    assert.ok(
      !appStations.some((n) => n.id.includes("infra-client")),
      "Orphan caller in app must not leave a dangling cross-package EGRESS station in app"
    );
  });

  it("partitions multi-file INIT_BLOCKs per source file, preserves caller evidence on OPEN_CONNECTORs, and routes cross-package EGRESS into a Column-0 INGRESS_RETURN receptor ([PAT-EXT-75])", () => {
    const graph: RepresentationGraph = {
      extractorVersion: "0.2.0",
      analyzedAt: "2026-11-13T00:00:00.000Z",
      nodes: [
        {
          id: "du-routes",
          name: "Deployment Unit: routes",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "src/routes" },
        },
        {
          id: "du-lib",
          name: "Deployment Unit: lib",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "src/lib" },
        },
        {
          id: "init-routes",
          name: "Init: routes",
          type: "BOUNDARY",
          entityType: "INIT_BLOCK",
          patternId: "boundary.init-block",
          parentBoundaryId: "du-routes",
          scope: "USER",
          evidence: [
            { filePath: "src/routes/auth.ts", lineNumber: 5 },
            { filePath: "src/routes/user.ts", lineNumber: 8 },
          ],
        },
        {
          id: "fn-auth-setup",
          name: "Exported Function: setupAuth",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-routes",
          scope: "USER",
          evidence: { filePath: "src/routes/auth.ts", lineNumber: 12 },
        },
        {
          id: "route-users",
          name: "Express Route: GET /users",
          type: "CONTRACT",
          entityType: "HTTP_ENDPOINT",
          patternId: "contract.express-route",
          parentBoundaryId: "du-routes",
          scope: "USER",
          evidence: { filePath: "src/routes/user.ts", lineNumber: 15 },
        },
        {
          id: "oc-db",
          name: "DB Call: db.query",
          type: "OPEN_CONNECTOR",
          entityType: "DB_QUERY",
          patternId: "open-connector.db-call",
          scope: "USER",
          evidence: [
            { filePath: "src/routes/other.native.tsx", lineNumber: 99 },
            { filePath: "src/routes/user.ts", lineNumber: 20 },
          ],
        },
        {
          id: "lib-create-app",
          name: "Exported Function: createApp",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-lib",
          scope: "USER",
          evidence: { filePath: "src/lib/create-app.ts", lineNumber: 10 },
        },
        {
          id: "lib-create-router",
          name: "Exported Function: createRouter",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-lib",
          scope: "USER",
          evidence: { filePath: "src/lib/create-app.ts", lineNumber: 4 },
        },
      ],
      edges: [
        {
          id: "e-init-auth",
          name: "Call: setupAuth()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.function-call",
          sourceId: "init-routes",
          targetId: "fn-auth-setup",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "src/routes/auth.ts", lineNumber: 5 },
        },
        {
          id: "e-init-user-router",
          name: "Call: createRouter()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.function-call",
          sourceId: "init-routes",
          targetId: "lib-create-router",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "src/routes/user.ts", lineNumber: 8 },
        },
        {
          id: "e-route-db",
          name: "Call: DB Call: db.query",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "generic.relationship",
          sourceId: "route-users",
          targetId: "oc-db",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "src/routes/user.ts", lineNumber: 20 },
        },
        {
          id: "e-lib-app-router",
          name: "Call: createRouter()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.function-call",
          sourceId: "lib-create-app",
          targetId: "lib-create-router",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "src/lib/create-app.ts", lineNumber: 11 },
        },
      ],
    };

    const traced = runStoryTracer(graph);
    const zipped = runZipMerge(traced);
    const layout = runGridMapper(zipped);

    // 1. Multi-file INIT_BLOCK is partitioned per source file (`routes/auth.ts` vs `routes/user.ts`)
    const routeInitStations = layout.nodes.filter(
      (n) => !n.isPackage && n.packageLabel === "routes" && n.entityType === "INIT_BLOCK"
    );
    assert.equal(routeInitStations.length, 2);
    assert.ok(routeInitStations.some((n) => n.label.includes("auth.ts")));
    assert.ok(routeInitStations.some((n) => n.label.includes("user.ts")));

    // 2. OPEN_CONNECTOR EGRESS station prioritizes the calling route's exact evidence (`src/routes/user.ts`)
    const dbStation = layout.nodes.find(
      (n) => !n.isPackage && n.packageLabel === "routes" && n.id.includes("oc-db")
    );
    assert.ok(dbStation);
    const dbPrimaryEv = Array.isArray(dbStation.evidence)
      ? dbStation.evidence[0]
      : dbStation.evidence;
    assert.equal(dbPrimaryEv?.filePath, "src/routes/user.ts");

    // 3. Cross-package EGRESS `createRouter (To: lib)` wires into a Column-0 INGRESS_RETURN receptor rather than createApp's Column-1 RETURN station
    const crossEdge = layout.edges.find(
      (e) =>
        e.sourceId.startsWith("routes::lib-create-router::") &&
        e.targetId.startsWith("lib::lib-create-router")
    );
    assert.ok(crossEdge, "Expected cross-package edge from routes to lib createRouter");
    const targetLibStation = layout.nodes.find((n) => n.id === crossEdge.targetId);
    assert.ok(targetLibStation);
    assert.ok(
      targetLibStation.role === "INGRESS" || targetLibStation.role === "INGRESS_RETURN",
      `Expected cross-package target role to be INGRESS or INGRESS_RETURN, got ${targetLibStation.role}`
    );
  });

  it("resolveRepoName resolves Git worktrees back to the parent repository name while preserving fixtures ([PAT-VIS-24], [PAT-CLI-13])", () => {
    const masterRoot = getChompMasterRoot();
    assert.equal(
      resolveRepoName(masterRoot),
      "chomp",
      "Expected Chomp masterRoot (including inside a Git worktree) to resolve to 'chomp'",
    );
    assert.equal(
      resolveRepoName(resolve(masterRoot, "packages/cli")),
      "chomp",
      "Expected subdirectory inside repo/worktree to resolve to 'chomp'",
    );
    assert.equal(
      resolveRepoName(resolve(masterRoot, "fixtures/test-repos/express-app")),
      "express-app",
      "Expected non-git test fixture directory to preserve its fixture name",
    );

    const sandbox = mkdtempSync(join(tmpdir(), "chomp-wt-test-"));
    try {
      const mainRepoDir = join(sandbox, "acme-platform");
      const mainGitDir = join(mainRepoDir, ".git");
      const wtGitDir = join(mainGitDir, "worktrees", "feature_auth_flow");
      const wtCheckoutDir = join(sandbox, "worktrees", "feature_auth_flow");
      mkdirSync(wtGitDir, { recursive: true });
      mkdirSync(wtCheckoutDir, { recursive: true });
      writeFileSync(join(wtGitDir, "commondir"), "../..\n", "utf8");
      writeFileSync(join(wtCheckoutDir, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

      assert.equal(resolveRepoName(wtCheckoutDir), "acme-platform");
      assert.equal(resolveRepoName(mainRepoDir), "acme-platform");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("getDefaultOverlayLayers and detectSystemRules expose only native Chomp + registered plugin layers and accurate repo setup status", () => {
    const defaults = getDefaultOverlayLayers();
    assert.equal(defaults.L1_PORTS, true);
    assert.equal("L2_RUNTIME" in defaults, false, "Hardcoded L2_RUNTIME must not appear in defaults");
    assert.equal("L3_INFRA" in defaults, false, "Hardcoded L3_INFRA must not appear in defaults");

    const masterRoot = getChompMasterRoot();
    const systemRules = detectSystemRules(resolve(masterRoot, ".chomp", "graph.db"));
    const configRule = systemRules.find((r) => r.id === "project-config");
    assert.ok(configRule);
    assert.equal(configRule.enabled, true, "Expected chomp.config.json to be detected on Chomp repo");
  });

  it("buildLayout and createBuildStatusTracker emit ordered live pipeline build stages ([PAT-VIS-32])", async () => {
    const tracker = createBuildStatusTracker("chomp");
    assert.equal(tracker.getSnapshot().state, "idle");
    assert.equal(tracker.getSnapshot().building, false);

    const observedStages: string[] = [];
    tracker.subscribe((snap) => {
      if (snap.building && snap.stageId) {
        observedStages.push(snap.stageId);
      }
    });

    const sampleGraph: RepresentationGraph = {
      extractorVersion: "1.1.0",
      analyzedAt: "2026-11-12T00:00:00Z",
      nodes: [
        {
          id: "du-api",
          name: "Deployment Unit: api",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "packages/api" },
        },
        {
          id: "ep-users",
          name: "HTTP Endpoint: GET /users",
          type: "CONTRACT",
          entityType: "HTTP_ENDPOINT",
          patternId: "contract.express-route",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "packages/api/routes.ts", lineNumber: 10 },
        },
        {
          id: "svc-users",
          name: "Exported Function: listUsers",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "packages/api/service.ts", lineNumber: 4 },
        },
      ],
      edges: [
        {
          id: "e-ep-svc",
          name: "Call: listUsers()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.function-call",
          sourceId: "ep-users",
          targetId: "svc-users",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "packages/api/routes.ts", lineNumber: 12 },
        },
      ],
    };

    tracker.begin({ repoName: "chomp", branchName: "main", diffMode: false });
    const { layout } = await buildLayout(
      sampleGraph,
      undefined,
      false,
      "chomp",
      undefined,
      normalizeRulesConfig({}),
      [],
      false,
      undefined,
      (stage) => tracker.advance(stage),
    );
    tracker.complete(12);

    assert.ok(layout.nodes.length >= 1);
    assert.ok(layout.packageBounds?.api);
    assert.deepEqual(
      observedStages.slice(1),
      LAYOUT_BUILD_STAGES.map((s) => s.id),
      "Expected buildLayout to advance through all 5 pipeline stages in order",
    );
    assert.equal(tracker.getSnapshot().state, "ready");
    assert.equal(tracker.getSnapshot().building, false);
  });

  it("runExport generates zero-backend static bundle with /api/* endpoints and chomp-snapshot.js ([PAT-CLI-13], [PAT-VIS-28])", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "chomp-export-test-"));
    try {
      const fixtureDir = resolve(
        getChompMasterRoot(),
        "fixtures/test-repos/express-app",
      );
      const dbPath = join(tmp, "db", "graph.db");
      const mockUiDir = join(tmp, "mock-ui");
      const outDir = join(tmp, "out");
      mkdirSync(mockUiDir, { recursive: true });
      writeFileSync(
        join(mockUiDir, "index.html"),
        "<!doctype html><html><head><title>Chomp</title></head><body><div id=\"root\"></div></body></html>",
        "utf-8",
      );

      const res = await runExport(fixtureDir, {
        db: dbPath,
        uiDir: mockUiDir,
        out: outDir,
        quiet: true,
      });

      assert.equal(res.repoName, "express-app");
      assert.equal(res.copiedStaticApp, true);
      assert.ok(res.normalNodeCount >= 1);

      // Verify static /api/* endpoints
      assert.ok(existsSync(join(outDir, "api", "layout.json")));
      assert.ok(existsSync(join(outDir, "api", "layout-diff.json")));
      assert.ok(existsSync(join(outDir, "api", "layout", "fingerprint")));
      assert.ok(existsSync(join(outDir, "api", "graph")));
      assert.ok(existsSync(join(outDir, "api", "view")));
      assert.ok(existsSync(join(outDir, "api", "rules")));
      assert.ok(existsSync(join(outDir, "api", "overlays")));
      assert.ok(existsSync(join(outDir, "chomp-snapshot.json")));
      assert.ok(existsSync(join(outDir, "chomp-snapshot.js")));

      // Verify index.html received <script src="./chomp-snapshot.js"></script>
      const exportedHtml = readFileSync(join(outDir, "index.html"), "utf-8");
      assert.ok(
        exportedHtml.includes('<script src="./chomp-snapshot.js"></script>'),
      );

      // Verify chomp-snapshot.js evaluates cleanly to window.__CHOMP_STATIC_SNAPSHOT__
      const snapshotJs = readFileSync(join(outDir, "chomp-snapshot.js"), "utf-8");
      assert.ok(snapshotJs.startsWith("window.__CHOMP_STATIC_SNAPSHOT__ = "));
      const snapshotJson = JSON.parse(
        readFileSync(join(outDir, "chomp-snapshot.json"), "utf-8"),
      );
      assert.equal(snapshotJson.layout.repoName, "express-app");
      assert.ok(Array.isArray(snapshotJson.graph.nodes));
      assert.ok(snapshotJson.rules);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("installKiroIntegration and runUninstall manage .kiro MCP, steering, hook, power, stealth exclude, and clean eject ([PAT-CLI-05], [PAT-CLI-11], [PAT-MCP-08])", () => {
    const tmp = mkdtempSync(join(tmpdir(), "chomp-kiro-test-"));
    try {
      // Simulate a git repository with an existing .kiro directory and pre-existing MCP server
      mkdirSync(join(tmp, ".git", "info"), { recursive: true });
      mkdirSync(join(tmp, ".kiro", "settings"), { recursive: true });
      mkdirSync(join(tmp, ".chomp"), { recursive: true });
      writeFileSync(
        join(tmp, ".kiro", "settings", "mcp.json"),
        JSON.stringify(
          {
            mcpServers: {
              "existing-server": { command: "node", args: ["server.js"] },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const detected = detectAgentIntegrations(tmp, {});
      const kiroSpec = detected.find((a) => a.id === "kiro");
      assert.ok(kiroSpec, "Expected Kiro integration spec");
      assert.equal(kiroSpec.detected, true);

      const installRes = installKiroIntegration(tmp, { stealth: true });
      assert.equal(installRes.mcpUpdated, true);
      assert.equal(installRes.steeringUpdated, true);
      assert.equal(installRes.hookUpdated, true);
      assert.equal(installRes.powerUpdated, true);

      // 1. Verify .kiro/settings/mcp.json merges chomp-server alongside existing-server
      const mcpJson = JSON.parse(
        readFileSync(join(tmp, ".kiro", "settings", "mcp.json"), "utf-8"),
      );
      assert.ok(mcpJson.mcpServers["existing-server"]);
      assert.equal(mcpJson.mcpServers["chomp-server"].disabled, false);
      assert.deepEqual(
        mcpJson.mcpServers["chomp-server"].autoApprove,
        [...KIRO_AUTO_APPROVE_TOOLS],
      );

      // 2. Verify .kiro/steering/chomp-architecture.md frontmatter + managed harness block
      const steering = readFileSync(
        join(tmp, ".kiro", "steering", "chomp-architecture.md"),
        "utf-8",
      );
      assert.ok(steering.startsWith("---\ninclusion: always\n---"));
      assert.ok(steering.includes("# --- BEGIN CHOMP HARNESS ---"));
      assert.ok(steering.includes("# --- END CHOMP HARNESS ---"));

      // 3. Verify .kiro/hooks/chomp-sync.kiro.hook
      const hook = JSON.parse(
        readFileSync(
          join(tmp, ".kiro", "hooks", "chomp-sync.kiro.hook"),
          "utf-8",
        ),
      );
      assert.equal(hook.when.type, "fileEdited");
      assert.deepEqual(hook.when.patterns, ["**/*.{ts,tsx,js,jsx}"]);
      assert.equal(hook.then.command, "chomp analyze . --quiet");

      // 4. Verify .kiro/powers/chomp/POWER.md + mcp.json
      assert.ok(existsSync(join(tmp, ".kiro", "powers", "chomp", "POWER.md")));
      assert.ok(existsSync(join(tmp, ".kiro", "powers", "chomp", "mcp.json")));

      // 5. Verify stealth .git/info/exclude contains Kiro artifacts (excluding pre-existing mcp.json)
      const gitExclude = readFileSync(
        join(tmp, ".git", "info", "exclude"),
        "utf-8",
      );
      assert.ok(gitExclude.includes(".kiro/steering/chomp-architecture.md"));
      assert.ok(gitExclude.includes(".kiro/hooks/chomp-sync.kiro.hook"));
      assert.ok(gitExclude.includes(".kiro/powers/chomp/"));

      // 6. Run uninstall: removes chomp-server while preserving existing-server, deletes steering/hook/power, cleans exclude
      runUninstall(tmp, { quiet: true });
      assert.equal(existsSync(join(tmp, ".chomp")), false);
      assert.equal(
        existsSync(join(tmp, ".kiro", "steering", "chomp-architecture.md")),
        false,
      );
      assert.equal(
        existsSync(join(tmp, ".kiro", "hooks", "chomp-sync.kiro.hook")),
        false,
      );
      assert.equal(existsSync(join(tmp, ".kiro", "powers", "chomp")), false);
      assert.equal(existsSync(join(tmp, ".kiro", "powers")), false);

      const postMcpJson = JSON.parse(
        readFileSync(join(tmp, ".kiro", "settings", "mcp.json"), "utf-8"),
      );
      assert.equal(postMcpJson.mcpServers["chomp-server"], undefined);
      assert.ok(postMcpJson.mcpServers["existing-server"]);

      // Also verify that when chomp-server is the ONLY server in .kiro/settings/mcp.json, uninstall removes .kiro completely
      const tmp2 = mkdtempSync(join(tmpdir(), "chomp-kiro-solo-"));
      try {
        installKiroIntegration(tmp2);
        assert.ok(existsSync(join(tmp2, ".kiro", "settings", "mcp.json")));
        runUninstall(tmp2, { quiet: true });
        assert.equal(existsSync(join(tmp2, ".kiro")), false);
      } finally {
        rmSync(tmp2, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves real package displayName scopes, labels passive DB/validator schemas as Schema:, conserves cross-package RENDERS macroEdges, and traces class lifecycle hooks", () => {
    const graph: RepresentationGraph = {
      extractorVersion: "1.1.0",
      analyzedAt: "2026-11-13T00:00:00Z",
      nodes: [
        {
          id: "du-web",
          name: "Deployment Unit: @acme/web",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "apps/web" },
        },
        {
          id: "du-ui",
          name: "Deployment Unit: @acme/ui",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "packages/ui" },
        },
        {
          id: "du-api",
          name: "Deployment Unit: @acme/api",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "apps/api" },
        },
        {
          id: "page-home",
          name: "Next.js Page: /",
          type: "CONTRACT",
          entityType: "NEXTJS_PAGE",
          patternId: "boundary.nextjs-page",
          parentBoundaryId: "du-web",
          scope: "USER",
          metadata: { routePath: "/" },
          evidence: { filePath: "apps/web/app/page.tsx", lineNumber: 1 },
        },
        {
          id: "ui-button",
          name: "React Component: Button",
          type: "CONTRACT",
          entityType: "REACT_COMPONENT",
          patternId: "contract.react-component",
          parentBoundaryId: "du-ui",
          scope: "USER",
          evidence: { filePath: "packages/ui/src/button.tsx", lineNumber: 5 },
        },
        {
          id: "route-users",
          name: "Express Route: GET /users",
          type: "CONTRACT",
          entityType: "HTTP_ENDPOINT",
          patternId: "contract.express-route",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "apps/api/src/users.ts", lineNumber: 10 },
        },
        {
          id: "schema-users",
          name: "DB Schema: usersTable",
          type: "CONTRACT",
          entityType: "DB_SCHEMA",
          patternId: "contract.drizzle-table",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "apps/api/src/schema.ts", lineNumber: 4 },
        },
        {
          id: "init-api",
          name: "Init: main.ts",
          type: "BOUNDARY",
          entityType: "INIT_BLOCK",
          patternId: "boundary.init-block",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "apps/api/src/main.ts", lineNumber: 1 },
        },
        {
          id: "cls-prisma",
          name: "Class: PrismaService",
          type: "BOUNDARY",
          entityType: "CLASS",
          patternId: "boundary.class",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "apps/api/src/prisma.service.ts", lineNumber: 3 },
        },
        {
          id: "m-on-module-init",
          name: "Public Method: PrismaService.onModuleInit",
          type: "CONTRACT",
          entityType: "PUBLIC_METHOD",
          patternId: "contract.public-method",
          parentBoundaryId: "cls-prisma",
          scope: "USER",
          evidence: { filePath: "apps/api/src/prisma.service.ts", lineNumber: 8 },
        },
        {
          id: "m-uncalled-work",
          name: "Public Method: PrismaService.seedDevFixtures",
          type: "CONTRACT",
          entityType: "PUBLIC_METHOD",
          patternId: "contract.public-method",
          parentBoundaryId: "cls-prisma",
          scope: "USER",
          evidence: { filePath: "apps/api/src/prisma.service.ts", lineNumber: 16 },
        },
        {
          id: "db-conn",
          name: "DB Query: prisma.$connect",
          type: "OPEN_CONNECTOR",
          entityType: "DB_QUERY",
          patternId: "open-connector.prisma-query",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "apps/api/src/prisma.service.ts", lineNumber: 9 },
        },
      ],
      edges: [
        {
          id: "e-web-renders-ui",
          name: "RENDERS",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.jsx-render",
          sourceId: "page-home",
          targetId: "ui-button",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "apps/web/app/page.tsx", lineNumber: 6 },
        },
        {
          id: "e-route-schema",
          name: "CALL",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.call",
          sourceId: "route-users",
          targetId: "schema-users",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "apps/api/src/users.ts", lineNumber: 12 },
        },
        {
          id: "e-init-prisma",
          name: "CALL",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.call",
          sourceId: "init-api",
          targetId: "cls-prisma",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "apps/api/src/main.ts", lineNumber: 4 },
        },
        {
          id: "e-lifecycle-db",
          name: "DB_QUERY",
          type: "RELATIONSHIP",
          entityType: "DB_QUERY",
          patternId: "relationship.db-query",
          sourceId: "m-on-module-init",
          targetId: "db-conn",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "apps/api/src/prisma.service.ts", lineNumber: 9 },
        },
        {
          id: "e-uncalled-db",
          name: "DB_QUERY",
          type: "RELATIONSHIP",
          entityType: "DB_QUERY",
          patternId: "relationship.db-query",
          sourceId: "m-uncalled-work",
          targetId: "db-conn",
          confidence: "HIGH",
          status: "DETERMINISTIC",
          evidence: { filePath: "apps/api/src/prisma.service.ts", lineNumber: 17 },
        },
      ],
    };

    const rules = normalizeRulesConfig({});
    const storyGraph = runStoryTracer(graph, undefined, rules);
    const merged = runZipMerge(storyGraph);
    const layout = runGridMapper(merged, rules);
    const { packageHealthByPkg } = computeGraphHealthMetrics(
      graph,
      "acme-platform",
      storyGraph.orphanNodes,
      layout,
    );

    // 1. Real package display names (`@acme/*`, never `@chomp/*`)
    assert.equal(layout.packageBounds?.web?.displayName, "@acme/web");
    assert.equal(layout.packageBounds?.ui?.displayName, "@acme/ui");
    assert.equal(layout.packageBounds?.api?.displayName, "@acme/api");
    assert.equal(packageHealthByPkg.web?.rawName, "Deployment Unit: @acme/web");
    assert.ok(
      !Object.values(packageHealthByPkg).some((h) => h.rawName?.includes("@chomp/")),
      "External repo health metrics must never fabricate @chomp/ scope",
    );

    // 2. Passive DB_SCHEMA folded as `Schema: usersTable` (never `Middleware: usersTable`)
    const usersRouteStation = layout.nodes.find((n) => n.id.includes("route-users"));
    assert.ok(usersRouteStation, "Expected GET /users station");
    assert.ok(
      usersRouteStation.badges.includes("Schema: usersTable"),
      `Expected Schema: usersTable badge, got ${JSON.stringify(usersRouteStation.badges)}`,
    );
    assert.equal(
      usersRouteStation.badges.some((b) => b.includes("Middleware: usersTable")),
      false,
    );

    // 3. Cross-package RENDERS (`web -> ui`) conserved as a MacroPackageEdge
    const webToUi = (layout.macroEdges ?? []).find(
      (me) => me.sourcePkg === "web" && me.targetPkg === "ui",
    );
    assert.ok(
      webToUi,
      `Expected macroEdge web -> ui to be conserved, got ${JSON.stringify(layout.macroEdges)}`,
    );

    // 4. Class lifecycle method `onModuleInit` wired into story flow, and non-lifecycle executable method conserved (never dropped)
    const placedOrigIds = new Set(
      layout.nodes.map((n) => String(n.id).split("::")[1] ?? n.id),
    );
    assert.ok(
      placedOrigIds.has("m-on-module-init"),
      "Expected PrismaService.onModuleInit lifecycle method to trace in story",
    );
    const conservedIds = new Set([
      ...placedOrigIds,
      ...(storyGraph.orphanNodes ?? []).map((o) => o.id),
      ...(layout.invariantNodes ?? []).map((i) => i.id),
    ]);
    assert.ok(
      conservedIds.has("m-uncalled-work"),
      "Expected uncalled executable method PrismaService.seedDevFixtures to be conserved instead of silently dropped",
    );
  });

  it("scaffoldDesignSystemConfig scaffolds chomp.config.json#designSystem in normal mode, .chomp/plugins/design-system/config.json in stealth mode, and skips backend-only repos", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "chomp-scaffold-ds-"));
    try {
      // 1. Backend-only repo: no designSystem config scaffolded
      const backendRepo = join(tmpRoot, "backend-only");
      mkdirSync(backendRepo, { recursive: true });
      writeFileSync(
        join(backendRepo, "package.json"),
        JSON.stringify({ name: "@acme/api", dependencies: { express: "^5.0.0" } }),
        "utf8",
      );
      const backendRes = scaffoldDesignSystemConfig(backendRepo);
      assert.equal(backendRes.written, false);
      assert.equal(existsSync(join(backendRepo, "chomp.config.json")), false);

      // 2. Frontend monorepo in normal mode (`chomp init`): writes `chomp.config.json#designSystem`
      const normalRepo = join(tmpRoot, "frontend-normal");
      mkdirSync(join(normalRepo, "apps/web"), { recursive: true });
      mkdirSync(join(normalRepo, "packages/api"), { recursive: true });
      writeFileSync(
        join(normalRepo, "package.json"),
        JSON.stringify({ name: "acme", private: true, workspaces: ["apps/*", "packages/*"] }),
        "utf8",
      );
      writeFileSync(
        join(normalRepo, "apps/web/package.json"),
        JSON.stringify({ name: "@acme/web", dependencies: { next: "^15.0.0", react: "^19.0.0" } }),
        "utf8",
      );
      writeFileSync(
        join(normalRepo, "packages/api/package.json"),
        JSON.stringify({ name: "@acme/api", dependencies: { fastify: "^5.0.0" } }),
        "utf8",
      );

      const dryRes = scaffoldDesignSystemConfig(normalRepo, { dryRun: true });
      assert.equal(dryRes.written, false);
      assert.equal(dryRes.wouldWrite, true);
      assert.deepEqual(dryRes.frontendPackages, ["@acme/web"]);
      assert.equal(existsSync(join(normalRepo, "chomp.config.json")), false);

      const normalRes = scaffoldDesignSystemConfig(normalRepo, { stealth: false });
      assert.equal(normalRes.written, true);
      assert.equal(normalRes.configRelPath, "chomp.config.json");
      const writtenRoot = JSON.parse(readFileSync(join(normalRepo, "chomp.config.json"), "utf8"));
      assert.deepEqual(writtenRoot.designSystem.scope.packages, ["@acme/web"]);
      assert.equal(writtenRoot.designSystem.mode, "auto");

      // Idempotency: second call never overwrites existing config
      const secondRes = scaffoldDesignSystemConfig(normalRepo, { stealth: false });
      assert.equal(secondRes.written, false);
      assert.equal(secondRes.alreadyConfigured, true);

      // 3. Frontend repo in stealth mode (`chomp connect`): writes `.chomp/plugins/design-system/config.json`, zero tracked files
      const stealthRepo = join(tmpRoot, "frontend-stealth");
      mkdirSync(stealthRepo, { recursive: true });
      writeFileSync(
        join(stealthRepo, "package.json"),
        JSON.stringify({ name: "@acme/svelte-app", devDependencies: { "@sveltejs/kit": "^2.0.0", svelte: "^5.0.0" } }),
        "utf8",
      );
      const stealthRes = scaffoldDesignSystemConfig(stealthRepo, { stealth: true });
      assert.equal(stealthRes.written, true);
      assert.equal(stealthRes.configRelPath, ".chomp/plugins/design-system/config.json");
      assert.equal(
        existsSync(join(stealthRepo, "chomp.config.json")),
        false,
        "Stealth mode must keep root tracked files 100% clean",
      );
      const stealthJson = JSON.parse(
        readFileSync(join(stealthRepo, ".chomp/plugins/design-system/config.json"), "utf8"),
      );
      assert.deepEqual(stealthJson.scope.packages, ["@acme/svelte-app"]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("buildPluginsOverview & computePluginFingerprint surface persisted lastRun errors, durations, and presentationWarnings", () => {
    const metaBase = {
      name: "design-system",
      displayName: "Design system",
      layer: "L1_DESIGN_SYSTEM",
      order: 30,
    };
    const fpBefore = computePluginFingerprint([], {}, [metaBase]);
    const metaWithRun = {
      ...metaBase,
      lastRun: {
        status: "error" as const,
        startedAt: "2026-11-13T10:00:00.000Z",
        finishedAt: "2026-11-13T10:00:00.042Z",
        durationMs: 42,
        presentationWarnings: ["design-system:x: dropped unknown block"],
        error: "Disk quota exceeded",
      },
    };
    const fpAfter = computePluginFingerprint(
      [],
      {
        "design-system": {
          state: "error",
          startedAt: metaWithRun.lastRun.startedAt,
          finishedAt: metaWithRun.lastRun.finishedAt,
          error: metaWithRun.lastRun.error,
        },
      },
      [metaWithRun],
    );
    assert.notEqual(fpBefore, fpAfter, "pluginFp must update when persisted lastRun changes");

    const overview = buildPluginsOverview({
      pluginOverlays: [],
      nodes: [],
      registry: [metaWithRun],
      runs: {
        "design-system": {
          state: "error",
          startedAt: metaWithRun.lastRun.startedAt,
          finishedAt: metaWithRun.lastRun.finishedAt,
          error: metaWithRun.lastRun.error,
        },
      },
      structureFp: "abc123",
    });
    assert.equal(overview.plugins.length, 1);
    assert.equal(overview.plugins[0]?.run.state, "error");
    assert.equal(overview.plugins[0]?.run.error, "Disk quota exceeded");
    assert.deepEqual(
      (overview.plugins[0] as any)?.lastRun?.presentationWarnings,
      ["design-system:x: dropped unknown block"],
    );
  });

  it("folds passive NestJS @Controller CLASS boundaries registered by @Module INIT_BLOCK instead of rendering duplicate RETURN cards", () => {
    const graph: RepresentationGraph = {
      extractorVersion: "1.1.0",
      analyzedAt: "2026-11-15T00:00:00.000Z",
      nodes: [
        {
          id: "du-api",
          name: "Deployment Unit: @ackplus/api",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "apps/api/package.json", lineNumber: 1 },
        },
        {
          id: "init-users-module",
          name: "Init: users.module.ts",
          type: "BOUNDARY",
          entityType: "INIT_BLOCK",
          patternId: "nestjs.module",
          scope: "USER",
          parentBoundaryId: "du-api",
          evidence: { filePath: "apps/api/src/users/users.module.ts", lineNumber: 8 },
        },
        {
          id: "cls-users-controller",
          name: "Class: UsersController",
          type: "BOUNDARY",
          entityType: "CLASS",
          patternId: "nestjs.controller",
          scope: "USER",
          parentBoundaryId: "du-api",
          evidence: { filePath: "apps/api/src/users/users.controller.ts", lineNumber: 6 },
        },
        {
          id: "ep-list-users",
          name: "Route: GET /users",
          type: "CONTRACT",
          entityType: "HTTP_ENDPOINT",
          patternId: "nestjs.endpoint",
          scope: "USER",
          parentBoundaryId: "cls-users-controller",
          evidence: { filePath: "apps/api/src/users/users.controller.ts", lineNumber: 12 },
        },
        {
          id: "svc-find-users",
          name: "Method: UsersService.findAll",
          type: "CONTRACT",
          entityType: "PUBLIC_METHOD",
          patternId: "ts.method",
          scope: "USER",
          parentBoundaryId: "du-api",
          evidence: { filePath: "apps/api/src/users/users.service.ts", lineNumber: 10 },
        },
      ],
      edges: [
        {
          id: "reg-ctrl",
          name: "Registers: UsersController",
          type: "RELATIONSHIP",
          entityType: "REGISTERS",
          patternId: "nestjs.module.controllers",
          scope: "USER",
          sourceId: "init-users-module",
          targetId: "cls-users-controller",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/api/src/users/users.module.ts", lineNumber: 10 },
        },
        {
          id: "call-svc",
          name: "Call: findAll",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "ts.call",
          scope: "USER",
          sourceId: "ep-list-users",
          targetId: "svc-find-users",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "apps/api/src/users/users.controller.ts", lineNumber: 14 },
        },
      ],
    };

    const rules = normalizeRulesConfig({});
    const storyGraph = runStoryTracer(graph, undefined, rules);
    const merged = runZipMerge(storyGraph);
    const layout = runGridMapper(merged, rules);

    const renderedControllerCard = layout.nodes.find((n) =>
      n.id.includes("cls-users-controller"),
    );
    assert.equal(
      renderedControllerCard,
      undefined,
      "UsersController CLASS boundary must fold into module badge instead of rendering a duplicate RETURN station card",
    );
    const endpointCard = layout.nodes.find((n) =>
      n.id.includes("ep-list-users"),
    );
    assert.ok(endpointCard, "Expected GET /users endpoint station on canvas");
  });

  it("emits real DEPLOYMENT_UNIT displayName on packageBounds for non-Chomp boards named core ([PAT-VIS-21])", () => {
    const graph: RepresentationGraph = {
      extractorVersion: "0.2.42",
      analyzedAt: "2026-11-16T00:00:00Z",
      nodes: [
        {
          id: "du-core",
          name: "Deployment Unit: core",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "src" },
        },
        {
          id: "ep-ping",
          name: "HTTP Endpoint: GET /ping",
          type: "CONTRACT",
          entityType: "HTTP_ENDPOINT",
          patternId: "contract.express-route",
          parentBoundaryId: "du-core",
          scope: "USER",
          evidence: { filePath: "src/routes.ts", lineNumber: 4 },
        },
        {
          id: "fn-check-ping",
          name: "Exported Function: checkPing",
          type: "CONTRACT",
          entityType: "FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-core",
          scope: "USER",
          evidence: { filePath: "src/service.ts", lineNumber: 8 },
        },
      ],
      edges: [
        {
          id: "call-check-ping",
          name: "Call: checkPing",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.call",
          scope: "USER",
          sourceId: "ep-ping",
          targetId: "fn-check-ping",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          evidence: { filePath: "src/routes.ts", lineNumber: 6 },
        },
      ],
    };

    const rules = normalizeRulesConfig({});
    const storyGraph = runStoryTracer(graph, undefined, rules);
    const merged = runZipMerge(storyGraph);
    const layout = runGridMapper(merged, rules);
    const { packageHealthByPkg } = computeGraphHealthMetrics(
      graph,
      "acme-app",
      storyGraph.orphanNodes,
      layout,
    );

    assert.equal(layout.packageBounds?.core?.displayName, "core");
    assert.equal(packageHealthByPkg.core?.rawName, "Deployment Unit: core");
    assert.ok(
      !Object.values(layout.packageBounds ?? {}).some((b) =>
        b.displayName?.includes("@chomp/"),
      ),
      "layout.packageBounds must never fabricate @chomp/ scope",
    );
    assert.ok(
      !Object.values(packageHealthByPkg).some((h) => h.rawName?.includes("@chomp/")),
      "packageHealthByPkg must never fabricate @chomp/ scope",
    );
  });
});
