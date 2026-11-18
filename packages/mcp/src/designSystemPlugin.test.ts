import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSQLiteStorage } from "@chomp/db";
import { analyzeTarget, type RepresentationGraph } from "@chomp/core";
import "./plugins/index.js";
import {
  classifyAtomicTier,
  classifyTokenTier,
  createDesignSystemPlugin,
  resolveAtomCatalog,
  computeRelativeLuminance,
  computeWcagContrastRatio,
  designSystemPlugin,
  diffDesignSystem,
  auditDesignSystem,
  evaluateThemeContrastPairs,
  matchUiRoleConvention,
  parseCssColorString,
  parseCssStylesheet,
  scanTsxOrTsFile,
  UI_ROLE_CONVENTIONS,
} from "./designSystemPlugin.js";
import { DEFAULT_DESIGN_SYSTEM_CONFIG } from "./designSystem/config.js";
import {
  getChompPlugin,
  listChompPlugins,
  readPluginLastRun,
  registerChompPlugin,
  runAllChompPlugins,
  runChompPlugin,
  unregisterChompPlugin,
} from "./pluginRunner.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** Baseline snapshots written by these tests live in a scratch dir, never inside the repo. */
const BASELINE_DIR = mkdtempSync(join(tmpdir(), "chomp-ds-baseline-"));
after(() => rmSync(BASELINE_DIR, { recursive: true, force: true }));

describe("Design System & Frontend Agent Plugin (L1_DESIGN_SYSTEM)", () => {
  it("parses CSS stylesheets with exact line numbers, token tiers, var() references, and rule color pairs", () => {
    const cssSource = [
      "/* Multi-line",
      "   header comment */",
      ':root, [data-theme="dark"] {',
      "  --gray-1: #111113;",
      "  --gray-12: #eeeef0;",
      "  --yellow-9: #ffe629;",
      "  --surface-canvas: var(--gray-1);",
      "  --text-primary: var(--gray-12);",
      "  --text-low-contrast: #222225;",
      "  --station-node-fill: #18191b;",
      "}",
      '[data-theme="light"] {',
      "  --surface-canvas: #ffffff;",
      "  --text-primary: #1c2024;",
      "  --text-low-contrast: #e8e8ec;",
      "}",
      "@theme inline {",
      "  --color-canvas: var(--surface-canvas);",
      "}",
      ".chomp-badge {",
      "  color: var(--text-low-contrast);",
      "  background-color: var(--surface-canvas);",
      "  border-color: var(--undefined-border-token);",
      "}",
    ].join("\n");

    const parsed = parseCssStylesheet("apps/web/src/styles/test.css", cssSource);

    assert.equal(classifyTokenTier("--gray-1"), "primitive");
    assert.equal(classifyTokenTier("--surface-canvas"), "semantic");
    // No repo-specific prefixes are built in: component tier comes from config (or reference-graph derivation).
    assert.equal(classifyTokenTier("--station-node-fill"), "semantic");
    assert.equal(
      classifyTokenTier("--station-node-fill", false, {
        primitive: [],
        semantic: [],
        component: ["^--station-"],
      }),
      "component",
    );
    assert.equal(classifyTokenTier("--color-canvas", true), "semantic");

    const gray1 = parsed.tokenDeclarations.find((t) => t.name === "--gray-1");
    assert.ok(gray1, "Expected --gray-1 token to be extracted");
    assert.equal(gray1.lineNumber, 4);
    assert.equal(gray1.tier, "primitive");

    const lightCanvas = parsed.tokenDeclarations.find(
      (t) => t.name === "--surface-canvas" && t.themeContext === "light",
    );
    assert.ok(lightCanvas, "Expected light theme --surface-canvas token");
    assert.equal(lightCanvas.lineNumber, 13);

    const undefRef = parsed.varReferences.find(
      (r) => r.name === "--undefined-border-token",
    );
    assert.ok(undefRef, "Expected var(--undefined-border-token) reference");
    assert.equal(undefRef.lineNumber, 23);

    assert.equal(parsed.styleRules.length, 1);
    assert.equal(parsed.styleRules[0]?.selector, ".chomp-badge");

    // `:root, [data-theme="dark"]` declares both the default (root) and dark values
    const grayContexts = parsed.tokenDeclarations
      .filter((t) => t.name === "--gray-1")
      .map((t) => t.themeContext)
      .sort();
    assert.deepEqual(grayContexts, ["dark", "root"]);

    const contrastAudits = evaluateThemeContrastPairs(
      parsed.tokenDeclarations,
      parsed.styleRules,
      {
        pairs: [{ fg: "--text-primary", bg: "--surface-canvas", label: "primary on canvas" }],
      },
    );
    assert.ok(contrastAudits.length >= 2);
    const passingPrimary = contrastAudits.find(
      (p) =>
        p.foregroundToken === "--text-primary" &&
        p.backgroundToken === "--surface-canvas",
    );
    assert.ok(passingPrimary);
    assert.equal(passingPrimary.passesAll, true);

    const failingBadge = contrastAudits.find(
      (p) =>
        p.foregroundToken === "--text-low-contrast" &&
        p.backgroundToken === "--surface-canvas",
    );
    assert.ok(
      failingBadge,
      "Expected low-contrast rule pair to be flagged as a WCAG 2.1 AA failure",
    );
    assert.equal(failingBadge.passesAll, false);
  });

  it("computes WCAG 2.1 relative luminance and contrast ratio accurately", () => {
    const black = parseCssColorString("#000000");
    const white = parseCssColorString("#ffffff");
    assert.ok(black && white);
    assert.equal(computeRelativeLuminance(black), 0);
    assert.equal(computeRelativeLuminance(white), 1);
    const ratio = computeWcagContrastRatio(white, black);
    assert.equal(ratio, 21);
  });

  it("scans TSX/TS AST for styling conventions, arbitrary Tailwind, dynamic class prefixes, canvas provenance, and atomic candidates", () => {
    const tsxSource = [
      'import React from "react";',
      'import { Rubik } from "next/font/google";',
      'const rubik = Rubik({ subsets: ["latin"], variable: "--font-rubik" });',
      "export function SampleInspector({ status, r }: { status: string; r: any }) {",
      '  const bgColor = r.css("cardBg", "--station-node-fill", 0x18191b);',
      '  const border = r.tsConst("borderWidth", "CARD_BORDER", 1.5);',
      '  const rawAlpha = r.lit("overlayAlpha", 0.42, "hardcoded alpha");',
      "  return (",
      '    <aside className="sg-mock-drawer chomp-inspector-drawer">',
      '      <div className={`sg-mock-drawer__diff sg-mock-drawer__diff--${status} text-[11px] rounded-[3px] bg-yellow-9`} style={{ margin: "12px", color: "#ff5500" }}>',
      '        <button type="button" role="switch" aria-checked={true} className="chomp-hud-switch">Toggle</button>',
      '        <button type="button" className="sg-mock-drawer__btn">Action</button>',
      '        <dl className="sg-mock-drawer__kv"><dt>Key</dt><dd>Val</dd></dl>',
      '        <span className="sg-mock-drawer__diff sg-mock-drawer__diff--added">+ADDED</span>',
      "      </div>",
      "    </aside>",
      "  );",
      "}",
    ].join("\n");

    const scan = scanTsxOrTsFile(
      "apps/web/src/components/SampleInspector.tsx",
      tsxSource,
      {
        // Canvas slot-recorder API is a repo convention declared via config, never assumed
        canvasSlotRecorderFactories: ["makeSlotRecorder"],
        // Class names defined in the repo's stylesheets are *derived*, not matched by a naming prefix
        knownCssClasses: new Set([
          "sg-mock-drawer",
          "chomp-inspector-drawer",
          "sg-mock-drawer__diff",
          "sg-mock-drawer__btn",
          "sg-mock-drawer__kv",
          "chomp-hud-switch",
        ]),
        atomDefinitions: resolveAtomCatalog({
          ...DEFAULT_DESIGN_SYSTEM_CONFIG,
          atoms: {
            ...DEFAULT_DESIGN_SYSTEM_CONFIG.atoms,
            catalog: "extend",
            definitions: [
              { name: "Drawer", matchers: [{ tag: "aside", classPattern: "drawer" }] },
              {
                name: "DiffBadge",
                matchers: [{ tag: ["span", "code"], classPattern: "sg-mock-drawer__diff\\b" }],
              },
            ],
          },
        }),
      },
    );

    // 1. Font variable extraction
    assert.equal(scan.definedFontVars.length, 1);
    assert.equal(scan.definedFontVars[0]?.name, "--font-rubik");

    const bucket = scan.functionsAndClasses.get("SampleInspector");
    assert.ok(bucket, "Expected SampleInspector function bucket");

    // 2. Styling conventions
    assert.ok(bucket.stylingConventions.has("css-classes"));
    assert.ok(bucket.stylingConventions.has("tailwind"));
    assert.ok(bucket.stylingConventions.has("inline-style"));
    assert.ok(bucket.stylingConventions.has("pixi-canvas"));

    // 3. Dynamic template-literal CSS class prefix
    assert.ok(
      bucket.dynamicClassPrefixes.has("sg-mock-drawer__diff--*"),
      "Expected dynamic template-literal prefix sg-mock-drawer__diff--*",
    );

    // 4. Arbitrary Tailwind bracket classes & primitive scale skips
    const arbProps = bucket.arbitraryTailwind.map((a) => a.className);
    assert.ok(arbProps.includes("text-[11px]"));
    assert.ok(arbProps.includes("rounded-[3px]"));
    // Raw palette utilities are recorded as candidates; whether they are drift is decided against the repo's own system
    assert.ok(
      bucket.paletteClassCandidates.some((c) => c.className.endsWith("bg-yellow-9")),
    );

    // 5. Inline style hardcoded hex/px literals
    assert.equal(bucket.inlineStyleLiterals.length, 2);

    // 6. makeSlotRecorder canvas provenance
    assert.equal(bucket.usesSlotRecorder, true);
    assert.equal(bucket.canvasCssCount, 1);
    assert.equal(bucket.canvasTsConstCount, 1);
    assert.equal(bucket.canvasLiteralCount, 1);

    // 7. Raw DOM primitive & atomic component consolidation detection
    const targetAtomics = new Set(
      bucket.rawDomPrimitives.map((p) => p.atomicTarget),
    );
    assert.ok(targetAtomics.has("Drawer"));
    assert.ok(targetAtomics.has("DiffBadge"));
    assert.ok(targetAtomics.has("Switch"));
    assert.ok(targetAtomics.has("Button"));
    assert.ok(targetAtomics.has("DescriptionList"));
  });

  it("registers design-system plugin, writes EXTRACTED L1_DESIGN_SYSTEM overlays with file-hash inputs, and runs audit & diff on @chomp/web", async () => {
    const registered = getChompPlugin("design-system");
    assert.ok(registered, "Expected design-system plugin to be registered");
    assert.equal(registered.layer, "L1_DESIGN_SYSTEM");
    assert.ok(
      listChompPlugins().some((p) => p.name === "design-system"),
      "Expected listChompPlugins() to include design-system",
    );

    const storage = createSQLiteStorage(":memory:");

    try {
      const sampleGraph: RepresentationGraph = {
        extractorVersion: "0.2.39",
        analyzedAt: new Date().toISOString(),
        nodes: [
          {
            id: "6cec2c1208dc",
            name: "Deployment Unit: @chomp/web",
            type: "BOUNDARY",
            entityType: "DEPLOYMENT_UNIT",
            patternId: "boundary.deployment-unit",
            scope: "USER",
            evidence: { filePath: "apps/web/package.json", lineNumber: 1 },
          },
          {
            id: "node-inspector-drawer",
            name: "Exported Function: NodeInspectorDrawer",
            type: "CONTRACT",
            entityType: "EXPORTED_FUNCTION",
            patternId: "contract.exported-function",
            parentBoundaryId: "6cec2c1208dc",
            scope: "USER",
            evidence: {
              filePath:
                "apps/web/src/components/visualizer/NodeInspectorDrawer.tsx",
              lineNumber: 711,
            },
          },
          {
            id: "rules-settings-drawer",
            name: "Exported Function: RulesSettingsDrawer",
            type: "CONTRACT",
            entityType: "EXPORTED_FUNCTION",
            patternId: "contract.exported-function",
            parentBoundaryId: "6cec2c1208dc",
            scope: "USER",
            evidence: {
              filePath:
                "apps/web/src/components/visualizer/RulesSettingsDrawer.tsx",
              lineNumber: 138,
            },
          },
          {
            id: "draw-station-node",
            name: "Exported Function: drawStationNode",
            type: "CONTRACT",
            entityType: "EXPORTED_FUNCTION",
            patternId: "contract.exported-function",
            parentBoundaryId: "6cec2c1208dc",
            scope: "USER",
            evidence: {
              filePath:
                "apps/web/src/components/visualizer/draw/stationNode.ts",
              lineNumber: 280,
            },
          },
          {
            id: "environment-banner",
            name: "Exported Function: EnvironmentBanner",
            type: "CONTRACT",
            entityType: "EXPORTED_FUNCTION",
            patternId: "contract.exported-function",
            parentBoundaryId: "6cec2c1208dc",
            scope: "USER",
            evidence: {
              filePath:
                "apps/web/src/components/visualizer/EnvironmentBanner.tsx",
              lineNumber: 15,
            },
          },
        ],
        edges: [],
      };

      await storage.saveRepresentationGraph(
        { id: "local-repo", name: "chomp", path: REPO_ROOT },
        sampleGraph,
      );

      const runResult = await runChompPlugin(designSystemPlugin, {
        repoPath: REPO_ROOT,
        repoId: "local-repo",
        repoName: "chomp",
        storage,
        graph: sampleGraph,
      });

      assert.ok(
        runResult.overlayCount >= 4,
        `Expected at least 4 L1_DESIGN_SYSTEM overlays (1 boundary + 3 contracts), got ${runResult.overlayCount}`,
      );

      // Verify persisted overlays have derivation="EXTRACTED", non-empty inputs hashes, and stale=false
      const storedOverlays = await storage.getEntityOverlays("local-repo", {
        layer: "L1_DESIGN_SYSTEM",
        source: "design-system",
      });
      assert.equal(storedOverlays.length, runResult.overlayCount);
      for (const ov of storedOverlays) {
        assert.equal(ov.derivation, "EXTRACTED");
        assert.equal(ov.stale, false);
        assert.ok(
          ov.inputs && ov.inputs.length > 0,
          `Expected non-empty inputs file hash list on overlay for ${ov.entityId}`,
        );
      }

      // Query auditDesignSystem (this repo's chomp.config.json scopes the audit to @chomp/web)
      const baselinePath = join(BASELINE_DIR, "chomp-web-baseline.json");
      const audit = await auditDesignSystem({
        repoPath: REPO_ROOT,
        repoId: "local-repo",
        repoName: "chomp",
        graph: sampleGraph,
        packageName: "web",
        persistOverlays: false,
        baselinePath,
        workingTreeCheck: () => ({ clean: true, dirtyFiles: [] }),
      });
      assert.equal(audit.system.mode, "extract");
      assert.deepEqual(
        audit.system.packages.filter((p) => p.frontend).map((p) => p.dir),
        ["apps/web"],
        "Only the frontend package is audited",
      );
      assert.ok(
        ["Drawer", "DiffBadge", "Banner", "Button"].every((a) => audit.system.atomCatalog.includes(a)),
        "Atom catalog = generic defaults + atoms declared in chomp.config.json",
      );
      assert.ok(
        audit.summary.totalDefinedTokens > 50,
        `Expected >50 CSS tokens in @chomp/web, got ${audit.summary.totalDefinedTokens}`,
      );
      assert.equal(
        audit.summary.duplicateTokenCount,
        0,
        "Expected 0 cross-stylesheet duplicate tokens in @chomp/web after deduplicating tailwind-sandbox.css",
      );
      assert.ok(
        audit.summary.canvasCssSlotCount > 0,
        "Expected makeSlotRecorder canvas slots to be inventoried",
      );
      assert.ok(
        audit.summary.contrastPairsAudited >= 16,
        "Contrast pairs declared in chomp.config.json are evaluated",
      );

      // First audit pins the baseline (bootstrap); a re-audit never moves it
      assert.equal(audit.baseline.bootstrapped, true);
      assert.equal(audit.baseline.written, true);
      const pinnedBefore = readFileSync(baselinePath, "utf8");
      const reAudit = await auditDesignSystem({
        repoPath: REPO_ROOT,
        repoId: "local-repo",
        repoName: "chomp",
        graph: sampleGraph,
        persistOverlays: false,
        baselinePath,
      });
      assert.equal(reAudit.baseline.written, false);
      assert.equal(readFileSync(baselinePath, "utf8"), pinnedBefore, "Re-auditing must not move the baseline");

      // Clean working-tree diff against the pinned baseline should PASS
      const cleanDiff = await diffDesignSystem({
        repoPath: REPO_ROOT,
        repoId: "local-repo",
        repoName: "chomp",
        graph: sampleGraph,
        baselinePath,
      });
      assert.equal(cleanDiff.gateStatus, "PASS");
      assert.equal(cleanDiff.hasBaseline, true);
      assert.equal(cleanDiff.summary.newArbitraryTailwindCount, 0);

      // Gate detects regression: pretend the baseline had fewer findings than the live scan
      const pinned = JSON.parse(pinnedBefore) as { counts: Record<string, number> };
      const baselineKeys = Object.keys(pinned.counts);
      assert.ok(baselineKeys.length > 0, "Expected baseline finding keys in @chomp/web snapshot");
      const strict = { ...pinned, counts: { ...pinned.counts } };
      const droppedKey =
        baselineKeys.find((k) => k.startsWith("arbitraryTailwind|")) ??
        baselineKeys.find((k) => k.startsWith("hardcodedLiteral|")) ??
        baselineKeys[0]!;
      delete strict.counts[droppedKey];
      const strictPath = join(BASELINE_DIR, "strict-baseline.json");
      writeFileSync(strictPath, JSON.stringify(strict), "utf8");
      const regressedDiff = await diffDesignSystem({
        repoPath: REPO_ROOT,
        repoId: "local-repo",
        repoName: "chomp",
        graph: sampleGraph,
        baselinePath: strictPath,
      });
      assert.equal(regressedDiff.gateStatus, "WARN");
      assert.ok(
        Object.values(regressedDiff.newIssues).some((arr) => arr.length > 0),
        "Expected diffDesignSystem to flag findings beyond the pinned baseline",
      );

      // No baseline is *unknown*, never a pass
      const noBaseline = await diffDesignSystem({
        repoPath: REPO_ROOT,
        repoId: "local-repo",
        repoName: "chomp",
        graph: sampleGraph,
        baselinePath: join(BASELINE_DIR, "does-not-exist.json"),
      });
      assert.equal(noBaseline.gateStatus, "NO_BASELINE");
      assert.equal(noBaseline.hasBaseline, false);

      // Verify runId prune-on-recommit removes obsolete entity overlays
      await storage.upsertEntityOverlays(
        [
          {
            repositoryId: "local-repo",
            entityId: "6cec2c1208dc",
            layer: "L1_DESIGN_SYSTEM",
            source: "design-system",
            derivation: "EXTRACTED",
            payload: { summary: "pruned test" },
          },
        ],
        {
          repositoryId: "local-repo",
          runId: "design-system:prune-test",
          pruneStaleBySource: true,
        },
      );
      const afterPrune = await storage.getEntityOverlays("local-repo", {
        layer: "L1_DESIGN_SYSTEM",
        source: "design-system",
      });
      assert.equal(
        afterPrune.length,
        1,
        "Expected pruneStaleBySource with new runId to prune overlays from prior run",
      );
    } finally {
      await storage.close();
    }
  });

  it("classifies routes, templates, organisms, molecules, and atoms across multiple web frameworks via UI_ROLE_CONVENTIONS and topology", () => {
    assert.ok(UI_ROLE_CONVENTIONS.length >= 6);

    // Framework-agnostic route conventions (Next.js, Remix, SvelteKit, Astro, Nuxt)
    assert.equal(
      matchUiRoleConvention(
        {
          entityType: "NEXT_PAGE_ROUTE",
          patternId: "contract.nextjs.app-page-route",
        },
        "apps/web/src/app/page.tsx",
      )?.role,
      "ROUTE",
    );
    assert.equal(
      matchUiRoleConvention(
        {
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.remix.route",
        },
        "app/routes/_index.tsx",
      )?.role,
      "ROUTE",
    );
    assert.equal(
      matchUiRoleConvention(
        {
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.sveltekit.page",
        },
        "src/routes/dashboard/+page.svelte",
      )?.role,
      "ROUTE",
    );
    assert.equal(
      matchUiRoleConvention(
        {
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.astro.page",
        },
        "src/pages/pricing.astro",
      )?.role,
      "ROUTE",
    );

    // Framework-agnostic layout/template conventions
    assert.equal(
      matchUiRoleConvention(
        {
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.nextjs.app-layout",
        },
        "apps/web/src/app/layout.tsx",
      )?.role,
      "TEMPLATE",
    );
    assert.equal(
      matchUiRoleConvention(
        {
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.sveltekit.layout",
        },
        "src/routes/+layout.svelte",
      )?.role,
      "TEMPLATE",
    );

    // Topology-based classification when no explicit folder convention applies
    assert.equal(
      classifyAtomicTier({
        node: {
          id: "badge",
          name: "Exported Function: Badge",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          scope: "USER",
          evidence: { filePath: "src/ui/Badge.tsx", lineNumber: 1 },
        },
        filePath: "src/ui/Badge.tsx",
        jsxDomElementCount: 2,
        jsxCustomComponentCount: 0,
        stateHookCount: 0,
        rendersInDegree: 5,
        rendersOutDegree: 0,
      }).atomicTier,
      "ATOM",
    );

    assert.equal(
      classifyAtomicTier({
        node: {
          id: "filter-bar",
          name: "Exported Function: FilterBar",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          scope: "USER",
          evidence: { filePath: "src/components/FilterBar.tsx", lineNumber: 1 },
        },
        filePath: "src/components/FilterBar.tsx",
        jsxDomElementCount: 6,
        jsxCustomComponentCount: 2,
        stateHookCount: 1,
        rendersInDegree: 2,
        rendersOutDegree: 2,
      }).atomicTier,
      "MOLECULE",
    );

    assert.equal(
      classifyAtomicTier({
        node: {
          id: "workspace-drawer",
          name: "Exported Function: WorkspaceInspectorDrawer",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          scope: "USER",
          evidence: {
            filePath: "src/components/WorkspaceInspectorDrawer.tsx",
            lineNumber: 1,
          },
        },
        filePath: "src/components/WorkspaceInspectorDrawer.tsx",
        jsxDomElementCount: 24,
        jsxCustomComponentCount: 5,
        stateHookCount: 4,
        rendersInDegree: 1,
        rendersOutDegree: 5,
      }).atomicTier,
      "ORGANISM",
    );
  });

  it("extracts Normalized JSX Skeleton Fingerprints, prop contracts, and call-site overrides from TSX AST", () => {
    const tsxSource = [
      'import React from "react";',
      "interface DrawerHeaderProps {",
      "  title: string;",
      "  subtitle?: string;",
      "  onClose: () => void;",
      "}",
      "export function DrawerA({ title, onClose }: DrawerHeaderProps) {",
      "  return (",
      '    <section className="drawer-card">',
      '      <dl className="sg-mock-drawer__kv">',
      "        <div><dt>Package</dt><dd>@chomp/web</dd></div>",
      "        <div><dt>Role</dt><dd>INGRESS</dd></div>",
      "        <div><dt>Scope</dt><dd>USER</dd></div>",
      "      </dl>",
      '      <SharedButton className="mt-[13px] w-[210px]" style={{ padding: "10px" }} onClick={onClose} />',
      "    </section>",
      "  );",
      "}",
      "export function DrawerB(props: DrawerHeaderProps) {",
      "  return (",
      '    <aside className="other-wrapper">',
      '      <dl className="sg-mock-drawer__kv">',
      "        <div><dt>Status</dt><dd>ACTIVE</dd></div>",
      "        <div><dt>Health</dt><dd>100%</dd></div>",
      "      </dl>",
      "    </aside>",
      "  );",
      "}",
    ].join("\n");

    const scan = scanTsxOrTsFile("apps/web/src/components/DrawerPair.tsx", tsxSource, {
      knownCssClasses: new Set(["sg-mock-drawer__kv", "drawer-card", "other-wrapper"]),
    });
    const drawerA = scan.functionsAndClasses.get("DrawerA");
    const drawerB = scan.functionsAndClasses.get("DrawerB");
    assert.ok(drawerA && drawerB, "Expected DrawerA and DrawerB buckets");

    // Prop contract extraction from TypeScript interface
    assert.equal(drawerA.propContract.length, 3);
    assert.ok(
      drawerA.propContract.some((p) => p.name === "title" && p.required === true),
    );
    assert.ok(
      drawerA.propContract.some((p) => p.name === "subtitle" && p.required === false),
    );

    // Call-site encapsulation override detection on <SharedButton />
    assert.equal(drawerA.jsxCallSites.length, 1);
    assert.equal(drawerA.jsxCallSites[0]?.targetComponent, "SharedButton");
    assert.equal(drawerA.jsxCallSites[0]?.hasInlineStyleOverride, true);
    assert.deepEqual(drawerA.jsxCallSites[0]?.arbitraryTailwindOverrides, [
      "mt-[13px]",
      "w-[210px]",
    ]);

    // Normalized JSX Skeleton Fingerprints match across 3-row and 2-row <dl className="sg-mock-drawer__kv">
    const dlSkeletonA = drawerA.jsxSkeletons.find((s) =>
      s.canonicalSignature.startsWith("dl.sg-mock-drawer__kv"),
    );
    const dlSkeletonB = drawerB.jsxSkeletons.find((s) =>
      s.canonicalSignature.startsWith("dl.sg-mock-drawer__kv"),
    );
    assert.ok(dlSkeletonA && dlSkeletonB, "Expected <dl> skeletons in both components");
    assert.equal(
      dlSkeletonA.skeletonHash,
      dlSkeletonB.skeletonHash,
      "Expected Normalized JSX Skeleton Hash to match despite different row counts (3 vs 2) and text content",
    );
  });

  it("computes routeComposition, atomicHierarchy, alignmentAudit, dryAudit.structuralJsxClones, and agentExtendability on @chomp/web", async () => {
    const routeGraph: RepresentationGraph = {
      extractorVersion: "0.2.39",
      analyzedAt: new Date().toISOString(),
      nodes: [
        {
          id: "6cec2c1208dc",
          name: "Deployment Unit: @chomp/web",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "apps/web/package.json", lineNumber: 1 },
        },
        {
          id: "route-home",
          name: "Next.js App Page Route: /",
          type: "CONTRACT",
          entityType: "NEXT_PAGE_ROUTE",
          patternId: "contract.nextjs.app-page-route",
          parentBoundaryId: "6cec2c1208dc",
          scope: "USER",
          evidence: { filePath: "apps/web/src/app/page.tsx", lineNumber: 1 },
        },
        {
          id: "route-styleguide",
          name: "Next.js App Page Route: /styleguide",
          type: "CONTRACT",
          entityType: "NEXT_PAGE_ROUTE",
          patternId: "contract.nextjs.app-page-route",
          parentBoundaryId: "6cec2c1208dc",
          scope: "USER",
          evidence: {
            filePath: "apps/web/src/app/styleguide/page.tsx",
            lineNumber: 1,
          },
        },
        {
          id: "graph-visualizer",
          name: "Exported Function: GraphVisualizer",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "6cec2c1208dc",
          scope: "USER",
          evidence: {
            filePath: "apps/web/src/components/GraphVisualizer.tsx",
            lineNumber: 119,
          },
        },
        {
          id: "node-inspector-drawer",
          name: "Exported Function: NodeInspectorDrawer",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "6cec2c1208dc",
          scope: "USER",
          evidence: {
            filePath:
              "apps/web/src/components/visualizer/NodeInspectorDrawer.tsx",
            lineNumber: 711,
          },
        },
        {
          id: "pkg-inspector-drawer",
          name: "Exported Function: PackageInspectorDrawer",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "6cec2c1208dc",
          scope: "USER",
          evidence: {
            filePath:
              "apps/web/src/components/visualizer/NodeInspectorDrawer.tsx",
            lineNumber: 550,
          },
        },
        {
          id: "hud-controls",
          name: "Exported Function: VisualizerHudControls",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "6cec2c1208dc",
          scope: "USER",
          evidence: {
            filePath:
              "apps/web/src/components/visualizer/VisualizerHudControls.tsx",
            lineNumber: 41,
          },
        },
        {
          id: "hud-controls-tw",
          name: "Exported Function: ChompHudControlsTw",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "6cec2c1208dc",
          scope: "USER",
          evidence: {
            filePath:
              "apps/web/src/styleguide/tailwind/TailwindComponents.tsx",
            lineNumber: 690,
          },
        },
        {
          id: "styleguide-sheet",
          name: "Exported Function: StyleguideSheet",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "6cec2c1208dc",
          scope: "USER",
          evidence: {
            filePath: "apps/web/src/styleguide/StyleguideSheet.tsx",
            lineNumber: 1,
          },
        },
      ],
      edges: [
        {
          id: "e1",
          name: "Renders GraphVisualizer",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.renders",
          sourceId: "route-home",
          targetId: "graph-visualizer",
          status: "DETERMINISTIC",
          evidence: { filePath: "apps/web/src/app/page.tsx", lineNumber: 460 },
        },
        {
          id: "e2",
          name: "Renders NodeInspectorDrawer",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.renders",
          sourceId: "graph-visualizer",
          targetId: "node-inspector-drawer",
          status: "DETERMINISTIC",
          evidence: {
            filePath: "apps/web/src/components/GraphVisualizer.tsx",
            lineNumber: 3100,
          },
        },
        {
          id: "e3",
          name: "Renders PackageInspectorDrawer",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.renders",
          sourceId: "graph-visualizer",
          targetId: "pkg-inspector-drawer",
          status: "DETERMINISTIC",
          evidence: {
            filePath: "apps/web/src/components/GraphVisualizer.tsx",
            lineNumber: 3120,
          },
        },
        {
          id: "e4",
          name: "Renders VisualizerHudControls",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.renders",
          sourceId: "graph-visualizer",
          targetId: "hud-controls",
          status: "DETERMINISTIC",
          evidence: {
            filePath: "apps/web/src/components/GraphVisualizer.tsx",
            lineNumber: 3045,
          },
        },
        {
          id: "e5",
          name: "Renders ChompHudControlsTw",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.renders",
          sourceId: "hud-controls",
          targetId: "hud-controls-tw",
          status: "DETERMINISTIC",
          evidence: {
            filePath:
              "apps/web/src/components/visualizer/VisualizerHudControls.tsx",
            lineNumber: 120,
          },
        },
        {
          id: "e6",
          name: "Renders StyleguideSheet",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.renders",
          sourceId: "route-styleguide",
          targetId: "styleguide-sheet",
          status: "DETERMINISTIC",
          evidence: {
            filePath: "apps/web/src/app/styleguide/page.tsx",
            lineNumber: 13,
          },
        },
        {
          id: "e7",
          name: "Renders ChompHudControlsTw",
          type: "RELATIONSHIP",
          entityType: "RENDERS",
          patternId: "relationship.renders",
          sourceId: "styleguide-sheet",
          targetId: "hud-controls-tw",
          status: "DETERMINISTIC",
          evidence: {
            filePath: "apps/web/src/styleguide/StyleguideSheet.tsx",
            lineNumber: 100,
          },
        },
      ],
    };

    const audit = await auditDesignSystem({
      repoPath: REPO_ROOT,
      repoId: "local-repo",
      repoName: "chomp",
      graph: routeGraph,
      packageName: "web",
      persistOverlays: false,
      baselinePath: join(BASELINE_DIR, "route-graph-baseline.json"),
    });

    // Q1: Route Composition
    assert.equal(audit.routeComposition.length, 2);
    const homeRoute = audit.routeComposition.find(
      (r) => r.routeId === "route-home",
    );
    assert.ok(homeRoute, "Expected routeComposition entry for /");
    assert.ok(
      homeRoute.sharedComponentsUsed.includes("ChompHudControlsTw"),
      "Expected ChompHudControlsTw to be recognized as shared across / and /styleguide",
    );
    assert.ok(homeRoute.compositionTree.children.length > 0);

    // Q2: Atomic Hierarchy
    assert.equal(audit.atomicHierarchy.tierCounts.ROUTE, 2);
    const allTierItems = Object.values(audit.atomicHierarchy.byTier).flat();
    assert.ok(
      allTierItems.some((c) => c.label === "ChompHudControlsTw"),
      "Expected ChompHudControlsTw in atomicHierarchy.byTier",
    );

    // Q3: Cross-Route & Component Alignment
    assert.ok(
      audit.alignmentAudit.parallelTwins.some((t) =>
        t.components.some((c) => c.label === "NodeInspectorDrawer"),
      ),
      "Expected parallelTwins to detect sibling Drawer components when shared <Drawer> Atom is not in the subset graph",
    );

    // Q4: Structural DRY JSX Clones: every reported group is a real repeated structure with evidence
    for (const g of audit.dryAudit.structuralJsxClones) {
      assert.ok(g.occurrenceCount >= 2 && g.occurrences.length > 0);
      assert.ok(["medium", "low"].includes(g.nameConfidence));
    }

    // Q5: Measured pillars (ratios with evidence) instead of a heuristic penalty score
    const m = audit.agentExtendability.measures;
    for (const v of Object.values(m)) {
      assert.ok(v === null || (v >= 0 && v <= 100), `pillar out of range: ${String(v)}`);
    }
    assert.ok(
      audit.agentExtendability.grade === "N/A" ||
        (audit.agentExtendability.overallScore !== null &&
          audit.agentExtendability.overallScore >= 0 &&
          audit.agentExtendability.overallScore <= 100),
    );
    assert.ok(
      audit.agentExtendability.pavedRoadBlueprint.canonicalTokensByRole.surfaces
        .length > 0,
    );
    assert.ok(
      Array.isArray(
        audit.agentExtendability.pavedRoadBlueprint.missingPrimitivesToExtract,
      ),
    );
    assert.ok(
      audit.agentExtendability.pavedRoadBlueprint.extensionRules.length >= 3,
    );
  });

  it("hardens import-resolved component linking, polyglot UI/stylesheet parsing (.scss/.less/.vue/.svelte/.astro/.mdx), and configurable canvas token readers", async () => {
    const polyglotRoot = resolve(REPO_ROOT, "fixtures/design-system/polyglot-hardening");
    const polyglotGraph = analyzeTarget(polyglotRoot);

    // 1. Default run (no canvas.tokenReaderHelpers configured)
    const defaultRes = await runChompPlugin(createDesignSystemPlugin(), {
      repoPath: polyglotRoot,
      repoName: "polyglot-hardening",
      graph: polyglotGraph,
      persist: false,
    });
    const report = defaultRes.summary.report;

    // 0b.2: Zero unsupported files across .scss, .less, .vue, .svelte, .astro, .mdx
    assert.equal(
      report.summary.unsupportedFileCount,
      0,
      `Expected 0 unsupported files, got ${JSON.stringify(report.coverage.unsupportedFiles)}`,
    );

    // SCSS & Less variables + nested rules + exact 1-based line numbers
    const allDefinedTokens = [
      ...report.tokenCatalog.primitive,
      ...report.tokenCatalog.semantic,
      ...report.tokenCatalog.component,
    ];
    assert.ok(allDefinedTokens.includes("$brand-purple-500"), "Expected $brand-purple-500 from .scss");
    assert.ok(allDefinedTokens.includes("$surface-accent"), "Expected $surface-accent semantic alias from .scss");
    assert.ok(allDefinedTokens.includes("@brand-amber-500"), "Expected @brand-amber-500 from .less");
    assert.ok(allDefinedTokens.includes("@badge-accent"), "Expected @badge-accent semantic alias from .less");
    assert.ok(
      !allDefinedTokens.includes("$local-pad") ||
        report.tokenCatalog.component.includes("$local-pad"),
      "Scoped <style scoped lang='scss'> $local-pad must be scoped/component-tier, never primitive",
    );

    const undefByName = new Map<string, { filePath: string; lineNumber: number }>(
      report.diagnostics.undefinedTokens.map((u: any) => [u.name, u.occurrences[0]]),
    );
    assert.equal(undefByName.get("--missing-scss-var")?.lineNumber, 13);
    assert.equal(undefByName.get("--missing-less-var")?.lineNumber, 7);
    assert.equal(undefByName.get("--missing-vue-var")?.lineNumber, 18);
    assert.equal(undefByName.get("--missing-svelte-var")?.lineNumber, 12);
    assert.equal(undefByName.get("--missing-astro-var")?.lineNumber, 13);
    assert.ok(
      !undefByName.has("--font-astro-code"),
      "Astro fonts[].cssVariable in astro.config.ts must register as a defined CSS variable",
    );
    assert.ok(
      !undefByName.has("--local-cta-bg"),
      "Inline JSX/sx '--local-cta-bg' custom property must register as a scoped variable",
    );
    assert.ok(
      !undefByName.has("--mui-palette-primary-main"),
      "Third-party runtime CSS variable prefix '--mui-' must not report as undefined",
    );

    // Vue SFC template arbitrary Tailwind + raw <button> exact 1-based line numbers
    const vueProfile = report.components.find((c: any) =>
      c.filePath.endsWith("components/VueAlert.vue"),
    );
    assert.ok(vueProfile, "Expected VueAlert.vue profile");
    assert.equal(vueProfile.arbitraryTailwind[0]?.className, "w-[215px]");
    assert.equal(vueProfile.arbitraryTailwind[0]?.lineNumber, 8);
    assert.equal(vueProfile.rawDomPrimitives[0]?.lineNumber, 10);

    // SvelteKit +layout.svelte (TEMPLATE) and +page.svelte (ROUTE), Astro landing.astro (ROUTE), MDX guide.mdx
    const svelteLayout = report.components.find((c: any) =>
      c.filePath.endsWith("routes/+layout.svelte"),
    );
    const sveltePage = report.components.find((c: any) =>
      c.filePath.endsWith("routes/pricing/+page.svelte"),
    );
    const astroPage = report.components.find((c: any) =>
      c.filePath.endsWith("pages/landing.astro"),
    );
    const mdxDoc = report.components.find((c: any) =>
      c.filePath.endsWith("content/guide.mdx"),
    );
    assert.equal(svelteLayout?.atomicTier, "TEMPLATE");
    assert.equal(sveltePage?.atomicTier, "ROUTE");
    assert.equal(sveltePage?.rawDomPrimitives[0]?.lineNumber, 7);
    assert.equal(astroPage?.atomicTier, "ROUTE");
    assert.equal(
      astroPage?.arbitraryTailwind[0]?.className,
      "w-[180px]",
      "Astro class:list={[...]} must extract static classes instead of colliding with Svelte class:* directive",
    );
    assert.ok(mdxDoc, "Expected guide.mdx component profile");

    const marketingProfile = report.components.find((c: any) =>
      c.filePath.endsWith("app/marketing/page.tsx"),
    );
    assert.ok(
      marketingProfile?.stylingConventions.includes("css-in-js"),
      "Expected @mui/material + sx={{...}} to detect css-in-js styling convention",
    );

    // 0b.1: Import-resolved component linking for colliding `Card` names + barrel re-exports + external npm non-collision
    const marketingRoute = report.routeComposition.find((r: any) =>
      r.filePath.endsWith("app/marketing/page.tsx"),
    );
    const billingRoute = report.routeComposition.find((r: any) =>
      r.filePath.endsWith("app/billing/page.tsx"),
    );
    assert.ok(marketingRoute && billingRoute, "Expected marketing and billing route compositions");

    const marketingCardChildren = marketingRoute.compositionTree.children.map(
      (ch: any) => ch.filePath,
    );
    const billingCardChildren = billingRoute.compositionTree.children.map(
      (ch: any) => ch.filePath,
    );
    assert.ok(
      marketingCardChildren.includes("apps/web/src/marketing/Card.tsx"),
      "Marketing route must link to marketing/Card.tsx",
    );
    assert.ok(
      !marketingCardChildren.includes("apps/web/src/billing/Card.tsx"),
      "Marketing route must NOT collide with billing/Card.tsx",
    );
    assert.ok(
      billingCardChildren.includes("apps/web/src/billing/Card.tsx"),
      "Billing route importing barrel '../../billing' must resolve re-export to billing/Card.tsx",
    );
    assert.ok(
      !billingCardChildren.includes("apps/web/src/marketing/Card.tsx"),
      "Billing route must NOT collide with marketing/Card.tsx",
    );

    // External `import { Button } from '@mui/material'` on MarketingPage must NOT count as adopting local `ui/Button.tsx`
    const buttonConsolidation = report.atomicConsolidation.find(
      (a: any) => a.atomName === "Button",
    );
    assert.ok(buttonConsolidation, "Expected Button consolidation entry");
    assert.equal(
      buttonConsolidation.adopterCount,
      1,
      "Only BillingPage's local <Button> import should count as adopter (external @mui/material Button excluded)",
    );

    // Prop API drift disambiguates same-named `Card` components (`isDisabled` vs `disabled`) by file path
    const disabledDrift = report.alignmentAudit.propApiDrift.find((g: any) =>
      g.variants.some((v: any) => v.propName === "isDisabled") &&
      g.variants.some((v: any) => v.propName === "disabled"),
    );
    assert.ok(disabledDrift, "Expected propApiDrift between isDisabled and disabled across distinct Card files");
    const isDisabledUsers =
      disabledDrift.variants.find((v: any) => v.propName === "isDisabled")?.components ?? [];
    const disabledUsers =
      disabledDrift.variants.find((v: any) => v.propName === "disabled")?.components ?? [];
    assert.ok(
      isDisabledUsers.some((u: string) => u.includes("marketing/Card.tsx")),
      `Expected disambiguated marketing/Card.tsx in isDisabled users, got ${JSON.stringify(isDisabledUsers)}`,
    );
    assert.ok(
      disabledUsers.some((u: string) => u.includes("billing/Card.tsx")),
      `Expected disambiguated billing/Card.tsx in disabled users, got ${JSON.stringify(disabledUsers)}`,
    );

    // Entity overlays must only reference real L0 graph node IDs (synthetic .svelte IDs excluded from entity_overlays)
    const realGraphIds = new Set(polyglotGraph.nodes.map((n) => n.id));
    for (const ov of defaultRes.overlays) {
      assert.ok(
        realGraphIds.has(ov.entityId),
        `Overlay entityId '${ov.entityId}' must exist in L0 graph.nodes`,
      );
    }

    // 0b.5: Configurable canvas.tokenReaderHelpers (no hardcoded readColor when unconfigured; custom helper works when configured)
    const unconfiguredReadersRes = await runChompPlugin(
      createDesignSystemPlugin({
        styling: {
          ...DEFAULT_DESIGN_SYSTEM_CONFIG.styling,
          canvas: {
            slotRecorderFactories: ["createSlotRecorder"],
            cssValueHelpers: [],
            tokenReaderHelpers: [],
          },
        },
      }),
      {
        repoPath: polyglotRoot,
        repoName: "polyglot-hardening",
        graph: polyglotGraph,
        persist: false,
      },
    );
    const defaultChart = unconfiguredReadersRes.summary.report.components.find((c: any) =>
      c.filePath.endsWith("canvas/chartTheme.ts"),
    );
    assert.ok(defaultChart, "Expected buildChartPalette profile when slotRecorderFactories configured");
    assert.equal(
      defaultChart.canvasProvenance.cssCount,
      0,
      "Unconfigured readColor/customReadToken must NOT be hardcoded as CSS token readers",
    );
    assert.ok(
      !defaultChart.tokensConsumed.includes("--surface"),
      "Unconfigured readColor('--surface') must NOT be recorded in tokensConsumed",
    );

    const configuredRes = await runChompPlugin(
      createDesignSystemPlugin({
        styling: {
          ...DEFAULT_DESIGN_SYSTEM_CONFIG.styling,
          canvas: {
            slotRecorderFactories: ["createSlotRecorder"],
            cssValueHelpers: [],
            tokenReaderHelpers: ["customReadToken"],
          },
        },
      }),
      {
        repoPath: polyglotRoot,
        repoName: "polyglot-hardening",
        graph: polyglotGraph,
        persist: false,
      },
    );
    const configuredChart = configuredRes.summary.report.components.find((c: any) =>
      c.filePath.endsWith("canvas/chartTheme.ts"),
    );
    assert.ok(configuredChart, "Expected buildChartPalette profile with configured slotRecorderFactories");
    assert.equal(configuredChart.canvasProvenance.usesSlotRecorder, true);
    assert.equal(
      configuredChart.canvasProvenance.cssCount,
      1,
      "Expected customReadToken('--foreground') to count as 1 CSS token slot when configured in tokenReaderHelpers",
    );
    assert.ok(
      configuredChart.tokensConsumed.includes("--foreground"),
      "Expected configured customReadToken('--foreground') in tokensConsumed",
    );
    assert.ok(
      !configuredChart.tokensConsumed.includes("--surface"),
      "Expected unconfigured readColor('--surface') to stay excluded from tokensConsumed",
    );
    assert.equal(configuredChart.canvasProvenance.literalCount, 1);
  });

  it("persists .chomp/plugins/<name>/last-run.json on ok & error runs and isolates failing plugins under continueOnError", async () => {
    const scratchRepo = mkdtempSync(join(BASELINE_DIR, "plugin-runs-"));
    writeFileSync(
      join(scratchRepo, "package.json"),
      JSON.stringify({ name: "scratch-plugin-runs", version: "1.0.0" }),
      "utf8",
    );
    writeFileSync(join(scratchRepo, "index.ts"), "export function hello() { return 1; }\n", "utf8");
    const g = analyzeTarget(scratchRepo);
    const dbPath = join(scratchRepo, ".chomp", "graph.db");

    const warnPluginName = "test-warn-plugin";
    const boomPluginName = "test-boom-plugin";
    registerChompPlugin({
      name: warnPluginName,
      version: "1.0.0",
      description: "Test plugin emitting invalid presentation",
      layer: "PLUGIN:TEST_WARN",
      order: 990,
      accepts: (f) => f.endsWith(".ts"),
      extract: () => [
        {
          repositoryId: "scratch",
          entityId: g.nodes[0]!.id,
          layer: "PLUGIN:TEST_WARN",
          source: warnPluginName,
          payload: { presentation: { version: 999 } },
        },
      ],
    });
    registerChompPlugin({
      name: boomPluginName,
      version: "1.0.0",
      description: "Test plugin throwing an error",
      layer: "PLUGIN:TEST_BOOM",
      order: 991,
      accepts: () => false,
      extract: () => {
        throw new Error("Simulated plugin crash");
      },
    });

    try {
      const storage = createSQLiteStorage(dbPath);
      await storage.saveRepresentationGraph(
        { id: "scratch", name: "scratch-plugin-runs", path: scratchRepo },
        g,
      );

      const failures: Array<{ name: string; message: string }> = [];
      const results = await runAllChompPlugins({
        repoPath: scratchRepo,
        repoId: "scratch",
        repoName: "scratch-plugin-runs",
        storage,
        graph: g,
        persist: true,
        continueOnError: true,
        onPluginError: (p, err) => failures.push({ name: p.name, message: err.message }),
      });
      await storage.close();

      assert.ok(
        results.some((r) => r.pluginName === warnPluginName),
        "Healthy/warning plugin must succeed despite sibling plugin throwing",
      );
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.name, boomPluginName);
      assert.match(failures[0]?.message ?? "", /Simulated plugin crash/);

      const warnLastRun = readPluginLastRun(scratchRepo, warnPluginName);
      assert.ok(warnLastRun, "Expected persisted last-run.json for warning plugin");
      assert.equal(warnLastRun.status, "ok");
      assert.ok(warnLastRun.presentationWarnings.length > 0);
      assert.ok(warnLastRun.durationMs >= 0);

      const boomLastRun = readPluginLastRun(scratchRepo, boomPluginName);
      assert.ok(boomLastRun, "Expected persisted last-run.json for crashing plugin");
      assert.equal(boomLastRun.status, "error");
      assert.match(boomLastRun.error ?? "", /Simulated plugin crash/);
    } finally {
      unregisterChompPlugin(warnPluginName);
      unregisterChompPlugin(boomPluginName);
    }
  });
});
