/**
 * packages/mcp/src/plugins/design-system/index.ts
 *
 * Self-contained `design-system` plugin module (`L1_DESIGN_SYSTEM`).
 * Auto-discovered from `packages/mcp/src/plugins/` with zero external plumbing:
 *   - State & settings folder: `.chomp/plugins/design-system/` (`baseline.json`, `settings.json`)
 *   - Declarative Settings UI (`settingsSchema`)
 *   - Inspector & HUD Presentation (`PluginPresentation` v1)
 *   - Active View Spotlight (`ctx.setActiveView` + `summary.views`)
 *   - Owned MCP tools (`chomp_audit_design_system`, `chomp_diff_design_system`)
 *   - Owned CLI summary formatter (`formatCliSummary`)
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import {
  auditDesignSystem,
  createDesignSystemPlugin,
  diffDesignSystem,
  type DesignSystemAnalysisReport,
} from "../../designSystemPlugin.js";
import { defineChompPlugin } from "../../pluginRunner.js";

const baseDesignSystemPlugin = createDesignSystemPlugin();

export const designSystemPluginModule = defineChompPlugin({
  ...baseDesignSystemPlugin,
  defaultEnabled: true,
  settingsSchema: [
    {
      key: "autoPinCleanBaseline",
      label: "Auto-pin clean baseline",
      description:
        "Create .chomp/plugins/design-system/baseline.json automatically on first audit when the frontend working tree is clean.",
      kind: "boolean",
      defaultValue: true,
    },
    {
      key: "maxDiagnosticsPerList",
      label: "Default diagnostic limit",
      description:
        "Maximum items returned per diagnostic list in chomp_audit_design_system when limit is omitted.",
      kind: "number",
      defaultValue: 25,
      min: 5,
      max: 100,
      step: 5,
    },
  ],
  formatCliSummary: (res, ansi) => {
    const dsReport = res.summary?.report as DesignSystemAnalysisReport | undefined;
    if (!dsReport) return [];
    const lines: string[] = [];
    const s = dsReport.summary;
    const score = s.agentExtendabilityScore;
    const extColor =
      score === null ? ansi.dim : score >= 80 ? ansi.green : score >= 65 ? ansi.cyan : ansi.yellow;
    const m = dsReport.agentExtendability.measures;
    const pct = (v: number | null) => (v === null ? "n/a" : `${v}%`);
    lines.push(
      `${ansi.dim("System:")}        ${ansi.bold(dsReport.system.mode)} mode  ·  ${dsReport.system.packages.filter((p) => p.frontend).length} frontend package(s) in scope  ·  ${ansi.dim(dsReport.system.modeReason)}`
    );
    lines.push(
      `${ansi.dim("Extendability:")} ${extColor(score === null ? "N/A (insufficient evidence)" : `${score}/100 (${s.agentExtendabilityGrade})`)}  ·  ${ansi.dim("token adherence")} ${pct(m.tokenAdherence)}  ·  ${ansi.dim("atom adoption")} ${pct(m.atomAdoption)}  ·  ${ansi.dim("dryness")} ${pct(m.dryness)}  ·  ${ansi.dim("encapsulation")} ${pct(m.encapsulation)}`
    );
    lines.push(
      `${ansi.dim("Hierarchy:")} ${s.routeCount} Route, ${s.templateCount} Template, ${s.organismCount} Organism, ${s.moleculeCount} Molecule, ${s.atomCount} Atom, ${s.utilityCount} Utility`
    );
    lines.push(
      `${ansi.dim("CSS Tokens:")}    ${ansi.bold(String(s.totalDefinedTokens))} (${s.primitiveTokenCount} primitive, ${s.semanticTokenCount} semantic, ${s.componentTokenCount} component, ${s.themeBridgeTokenCount} @theme)`
    );
    const candidateTotal = s.contrastCandidateCount ?? s.contrastPairsAudited;
    const passingContrast = s.contrastPairsAudited - s.contrastFailureCount;
    const contrastStatus =
      candidateTotal === 0
        ? ansi.yellow("0 of 0 candidate pairs audited (none discovered)")
        : s.contrastFailureCount === 0 && s.contrastPairsUnresolved === 0
          ? ansi.green(
              `${s.contrastPairsAudited} of ${candidateTotal} candidate pairs audited (${passingContrast}/${s.contrastPairsAudited} PASS)`
            )
          : ansi.yellow(
              `${s.contrastPairsAudited} of ${candidateTotal} candidate pairs audited (${passingContrast}/${s.contrastPairsAudited} PASS${s.contrastFailureCount > 0 ? `, ${s.contrastFailureCount} fail` : ""}${s.contrastPairsUnresolved > 0 ? `, ${s.contrastPairsUnresolved} unresolved` : ""})`
            );
    lines.push(
      `${ansi.dim("WCAG Contrast:")} ${contrastStatus}  ·  ${ansi.dim("Undefined var():")} ${
        s.undefinedTokenCount === 0 ? ansi.green("0") : ansi.yellow(String(s.undefinedTokenCount))
      }  ·  ${ansi.dim("Duplicate tokens:")} ${s.duplicateTokenCount}`
    );
    if (s.contrastPairsUnresolved > 0 || s.unsupportedFileCount > 0) {
      lines.push(
        `${ansi.yellow("Not evaluated:")} ${s.contrastPairsUnresolved} contrast pair/theme(s)  ·  ${s.unsupportedFileCount} unsupported file(s) (${dsReport.coverage.unsupportedFiles.map((u) => u.extension).join(", ") || "none"})`
      );
    }
    lines.push(
      `${ansi.dim("Hardcoded:")}     ${s.hardcodedLiteralCount} literal(s) → ${s.derivedTokenProposalCount} derived token proposal(s)  ·  ${s.invariantViolationCount} prop-literal violation(s)  ·  ${s.composabilityIssueCount} composability issue(s)`
    );
    lines.push(
      `${ansi.dim("Alignment/DRY:")} ${s.structuralJsxCloneCount} JSX clone pattern(s)  ·  ${s.bypassedAtomCount} bypassed atom(s)  ·  ${s.parallelTwinGroupCount} parallel twin group(s)  ·  ${s.callSiteOverrideCount} call-site override(s)`
    );
    lines.push(
      `${ansi.dim("UI Contracts:")}  ${s.componentsProfiled} profiled  ·  ${ansi.dim("Arbitrary Tailwind:")} ${s.arbitraryTailwindCount}  ·  ${ansi.dim("Canvas slots:")} ${s.canvasCssSlotCount} css / ${s.canvasTsConstSlotCount} tsConst / ${s.canvasLiteralSlotCount} lit`
    );
    if (dsReport.atomicConsolidation.length > 0) {
      const atoms = dsReport.atomicConsolidation
        .map(
          (a) =>
            `<${a.atomName}> (${a.instanceCount} raw${a.adoptionRate !== null ? `, ${a.adoptionRate}% adopted` : ""})`
        )
        .join(", ");
      lines.push(`${ansi.dim("Atomic Targets:")} ${atoms}`);
    }
    return lines;
  },
  mcpTools: [
    {
      name: "chomp_audit_design_system",
      description:
        "QUERY BEFORE WRITE — DESIGN SYSTEM & FRONTEND AGENT HARNESS ([PAT-MCP-08], [PAT-MCP-09], [PAT-DB-05], [PAT-VIS-21]): Call this tool BEFORE authoring or refactoring frontend CSS, Tailwind, or React/TSX components. Deterministically extracts and returns: (1) the repository's CSS custom property token catalog across primitive, semantic, and component tiers (:root, [data-theme], @theme), (2) the 7-step atomic component consolidation benchmark (<Switch>, <Drawer>, <DiffBadge>, <Banner>, <Button>, <KeyValueList>, <Tooltip>), (3) undefined var(--*) leaks, duplicate/forked token declarations, unused tokens, and computed WCAG 2.1 contrast ratios across Dark and Light themes, and (4) per-component styling convention mix, arbitrary Tailwind bracket values, primitive scale skips, and PixiJS canvas literal provenance (makeSlotRecorder). Refreshes EXTRACTED L1_DESIGN_SYSTEM display overlays in .chomp/graph.db; the diff baseline (.chomp/plugins/design-system/baseline.json) is created if absent and clean, and replaced only with set_baseline.",
      inputSchema: {
        packageName: z
          .string()
          .optional()
          .describe("Optional filter by frontend package name (e.g., 'web', '@chomp/web')"),
        package_name: z.string().optional().describe("Alias for packageName (snake_case)"),
        search_term: z
          .string()
          .optional()
          .describe(
            "Optional case-insensitive filter on component name, file path, or atomic primitive candidate (e.g., 'Drawer', 'Switch', 'RulesSettingsDrawer')"
          ),
        searchTerm: z.string().optional().describe("Alias for search_term (camelCase)"),
        limit: z
          .number()
          .optional()
          .describe("Maximum entries per diagnostic/component list (default: 25)"),
        persist_overlays: z
          .boolean()
          .optional()
          .describe(
            "When true (default), persists EXTRACTED L1_DESIGN_SYSTEM overlays into .chomp/graph.db with runId prune-on-recommit"
          ),
        persistOverlays: z.boolean().optional().describe("Alias for persist_overlays (camelCase)"),
        set_baseline: z
          .boolean()
          .optional()
          .describe(
            "When true, (re)pins the current working tree as the diff baseline snapshot (.chomp/plugins/design-system/baseline.json)."
          ),
        setBaseline: z.boolean().optional().describe("Alias for set_baseline (camelCase)"),
        create_view: z
          .boolean()
          .optional()
          .describe(
            "When true, updates .chomp/current_view.json with L1_DESIGN_SYSTEM Spotlight highlights. Leave false (default) during coding tasks; pass true only when answering user questions or visual walkthrough requests."
          ),
        createView: z.boolean().optional().describe("Alias for create_view (camelCase)"),
      },
      handler: async (args, ctx) => {
        const persistOverlays =
          args.persist_overlays ?? args.persistOverlays ?? existsSync(ctx.dbPath);
        const defaultLimit =
          typeof ctx.settings.maxDiagnosticsPerList === "number"
            ? ctx.settings.maxDiagnosticsPerList
            : 25;
        const report = await auditDesignSystem({
          repoPath: ctx.repoPath,
          repoId: ctx.repoId,
          repoName: ctx.repoName,
          dbPath: ctx.dbPath,
          packageName: args.packageName ?? args.package_name,
          searchTerm: args.search_term ?? args.searchTerm,
          limit: args.limit ?? defaultLimit,
          persistOverlays,
          setBaseline: args.set_baseline ?? args.setBaseline,
        });
        if (persistOverlays) {
          ctx.invalidateCache();
        }

        if ((args.create_view ?? args.createView) && report.recommendedHighlightNodeIds.length > 0) {
          const pkgFilter =
            args.packageName ??
            args.package_name ??
            report.system.packages
              .filter((p) => p.frontend)
              .map(
                (p) =>
                  p.name?.replace(/^@[^/]+\//, "") ??
                  (p.dir === "." ? ctx.repoName : basename(p.dir))
              )[0] ??
            ctx.repoName;

          ctx.setActiveView({
            title: "Frontend token & contrast audit",
            description: `${report.summary.totalDefinedTokens} tokens | ${report.summary.componentsProfiled} components | ${report.summary.undefinedTokenCount} undefined var() | ${report.summary.contrastFailureCount} contrast failures`,
            highlightNodeIds: report.recommendedHighlightNodeIds,
            viewLevel: "package",
            packageName: pkgFilter,
            pills: [
              `${report.summary.totalDefinedTokens} tokens`,
              `${report.summary.contrastPairsAudited - report.summary.contrastFailureCount}/${report.summary.contrastCandidateCount ?? report.summary.contrastPairsAudited} contrast pass (${report.summary.contrastPairsAudited}/${report.summary.contrastCandidateCount ?? report.summary.contrastPairsAudited} audited)`,
              `${report.summary.arbitraryTailwindCount} arbitrary Tw`,
            ],
            metrics: {
              tokens: report.summary.totalDefinedTokens,
              undefinedVars: report.summary.undefinedTokenCount,
              arbitraryTw: report.summary.arbitraryTailwindCount,
              contrastFails: report.summary.contrastFailureCount,
            },
          });
        }

        return report;
      },
    },
    {
      name: "chomp_diff_design_system",
      description:
        "VERIFY AFTER WRITE — CLOSED-LOOP FRONTEND DESIGN DIFF GATE ([PAT-MCP-02], [PAT-MCP-08], [PAT-MCP-09], [PAT-DB-05]): Call this tool AFTER modifying CSS or React/TSX components to compare your dirty working tree against the pinned baseline snapshot (default .chomp/plugins/design-system/baseline.json; created by chomp_audit_design_system, never moved by a re-audit). Flags newly introduced undefined var(--*) tokens, arbitrary Tailwind values, primitive skips, hardcoded color/length literals, prop-literal violations, raw elements bypassing shared atoms, composability issues, and WCAG 2.1 contrast regressions.",
      inputSchema: {
        package_name: z
          .string()
          .optional()
          .describe("Optional frontend package to focus the Active View on."),
        packageName: z.string().optional().describe("Alias for package_name (camelCase)"),
        create_view: z
          .boolean()
          .optional()
          .describe(
            "When true, updates .chomp/current_view.json to highlight components with design system changes. Leave false (default) during coding tasks."
          ),
        createView: z.boolean().optional().describe("Alias for create_view (camelCase)"),
      },
      handler: async (args, ctx) => {
        const diffResult = await diffDesignSystem({
          repoPath: ctx.repoPath,
          repoId: ctx.repoId,
          repoName: ctx.repoName,
          dbPath: ctx.dbPath,
        });

        if ((args.create_view ?? args.createView) && diffResult.componentDeltas.length > 0) {
          const diffPkg =
            args.packageName ??
            args.package_name ??
            diffResult.frontendPackages[0] ??
            ctx.repoName;
          ctx.setActiveView({
            title: `Working tree diff (${diffResult.gateStatus})`,
            description: `New undefined vars: ${diffResult.summary.newUndefinedTokenCount} | New arbitrary Tw: ${diffResult.summary.newArbitraryTailwindCount} | Contrast fails: ${diffResult.summary.newContrastFailureCount}`,
            highlightNodeIds: diffResult.componentDeltas.flatMap((d) =>
              d.entityId ? [d.entityId] : []
            ),
            viewLevel: "package",
            packageName: diffPkg,
          });
        }

        return diffResult;
      },
    },
  ],
});

export default designSystemPluginModule;
