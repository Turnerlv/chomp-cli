/**
 * packages/mcp/src/designSystem/presentation.ts
 *
 * Builds the Plugin Presentation Contract (`@chomp/core` → `pluginPresentation.ts`) for the
 * design-system plugin: what the HUD card and the package / component inspector sections show.
 * The UI renders this generically; nothing here knows about React and nothing in the UI knows
 * about design-system payload keys ([PAT-VIS-36], [PAT-DS-11]).
 *
 * Every number is traceable: findings carry counts, truncation is stated (`totalCount`),
 * and "no evidence" is `null` / "n/a", never zero.
 */

import {
  PLUGIN_PRESENTATION_PAYLOAD_KEY,
  PLUGIN_PRESENTATION_VERSION,
  capForPresentation,
  type PluginPresentation,
  type PluginSpotlightView,
  type PresentationBlock,
  type PresentationListItem,
  type PresentationMetric,
  type PresentationSection,
  type PresentationTone,
} from "@chomp/core";
import type { EntityOverlayInput } from "@chomp/db";
import type {
  ComponentDesignProfile,
  DesignSystemAnalysisReport,
} from "../designSystemPlugin.js";
import type { FindingRecord } from "./baseline.js";

const LIST_CAP = 40;
const VISIBLE = 6;

function ratioTone(v: number | null): PresentationTone {
  if (v === null) return "muted";
  return v >= 80 ? "good" : v >= 60 ? "warn" : "bad";
}

function pctMetric(
  id: string,
  label: string,
  value: number | null,
  hint: string,
  rawItems: PresentationListItem[],
  emptyText: string
): PresentationMetric {
  const { items, totalCount } = capForPresentation(rawItems, LIST_CAP);
  return {
    id,
    label,
    value,
    unit: "%",
    tone: ratioTone(value),
    hint: value === null ? `No evidence in this package: ${hint}` : hint,
    ...(items.length > 0
      ? { items, maxVisible: VISIBLE, totalCount }
      : { emptyText }),
  };
}

function gradeBadge(
  score: number | null,
  grade: string
): { text: string; tone: PresentationTone; tooltip: string } {
  if (score === null || grade === "N/A") {
    return {
      text: "N/A",
      tone: "muted",
      tooltip: "Not enough evidence to grade: fewer than two pillars could be measured.",
    };
  }
  return {
    text: `${score}/100 (${grade})`,
    tone: ratioTone(score),
    tooltip: "Mean of the measured pillars (token adherence, atom adoption, dryness, encapsulation).",
  };
}

function formatStylingConvention(c: string): string {
  switch (c) {
    case "css-classes":
      return "CSS";
    case "css-modules":
      return "CSS Modules";
    case "css-in-js":
      return "CSS-in-JS";
    case "pixi-canvas":
      return "Canvas 2D";
    case "inline-style":
      return "Inline";
    default:
      return "Tailwind";
  }
}

function formatComposabilityKind(kind: string): string {
  switch (kind) {
    case "outer-margin-on-reusable":
    case "root-margin":
      return "Outer margin";
    case "fixed-dimension-on-reusable":
    case "fixed-width":
      return "Fixed width";
    case "cross-tier-upward-import":
    case "forbidden-import":
      return "Cross-layer import";
    default:
      return kind;
  }
}

interface PackageView {
  key: string;
  dir: string | undefined;
  components: ComponentDesignProfile[];
  inPackageFile: (filePath: string) => boolean;
}

function packageView(report: DesignSystemAnalysisReport, shortKey: string): PackageView {
  const pkg = report.system.packages.find((p) => {
    const label = p.name?.replace(/^@[^/]+\//, "") ?? p.dir.split("/").pop() ?? p.dir;
    return p.frontend && label === shortKey;
  });
  const dir = pkg?.dir;
  return {
    key: shortKey,
    dir,
    components: report.components.filter((c) => c.packageName === shortKey),
    inPackageFile: (f) => dir === undefined || dir === "." || f.startsWith(`${dir}/`),
  };
}

// ---------------------------------------------------------------------------
// Package-level presentation
// ---------------------------------------------------------------------------

export function buildPackagePresentation(
  report: DesignSystemAnalysisReport,
  shortKey: string,
  packageScore: { score: number | null; grade: string; notes: string[] },
  pillars: {
    tokenAdherence: number | null;
    atomAdoption: number | null;
    dryness: number | null;
    encapsulation: number | null;
  },
  _baseline: { path: string } | null,
  _records: FindingRecord[]
): PluginPresentation {
  const view = packageView(report, shortKey);
  const comps = view.components;
  const labels = new Set(comps.map((c) => c.label));
  const byLabel = new Map<string, ComponentDesignProfile>();
  for (const c of comps) byLabel.set(c.label, c);

  // ---- per-package finding collections ----
  const arbitrary = comps.flatMap((c) => c.arbitraryTailwind);
  const primitives = comps.flatMap((c) => c.primitiveScaleSkips);
  const inlineLits = comps.flatMap((c) => c.inlineStyleLiterals);
  const canvasLits = comps.flatMap((c) => c.canvasProvenance.literals);
  const tsLits = comps.flatMap((c) => c.literalValues.filter((l) => l.surface !== "tailwind-arbitrary"));
  const cssLits = report.diagnostics.hardcodedCssLiterals.filter((l) => view.inPackageFile(l.filePath));
  const bypassed = report.atomicConsolidation.flatMap((a) =>
    a.instances
      .filter((i) => view.inPackageFile(i.filePath))
      .map((i) => ({
        atomTarget: a.atomName,
        bypassingComponent: i.componentName,
        filePath: i.filePath,
        lineNumber: i.lineNumber,
        snippet: i.snippet,
        recommendation: a.existingSharedComponent
          ? `Use the shared <${a.existingSharedComponent.name}> (${a.existingSharedComponent.filePath}).`
          : `Extract a shared <${a.atomName}> atom.`,
      }))
  );
  const invariants = comps.flatMap((c) => c.invariantViolations);
  const composability = comps.flatMap((c) => c.composabilityIssues);
  const overrides = report.alignmentAudit.callSiteOverrides.filter((o) => labels.has(o.parentComponent));
  const clones = report.dryAudit.structuralJsxClones.filter((g) =>
    g.occurrences.some((o) => labels.has(o.componentName))
  );
  const twins = report.alignmentAudit.parallelTwins.filter((t) =>
    t.components.some((c) => labels.has(c.label))
  );
  const undef = report.diagnostics.undefinedTokens.filter((u) =>
    u.occurrences.some((o) => view.inPackageFile(o.filePath))
  );
  const contrastFailures = report.diagnostics.contrastFailures;
  const hardcodedCount =
    inlineLits.length + canvasLits.length + tsLits.length + cssLits.length;

  const issueCount =
    hardcodedCount +
    arbitrary.length +
    primitives.length +
    bypassed.length +
    invariants.length +
    composability.length +
    undef.length +
    contrastFailures.length +
    clones.length +
    twins.length +
    overrides.length;

  // ---- 1. High-level line items for "Token usage" ----
  const tokenItems: PresentationListItem[] = [];
  for (const u of undef) {
    tokenItems.push({
      label: u.name,
      detail: `Undefined token · ${u.occurrenceCount} ${u.occurrenceCount === 1 ? "use" : "uses"}`,
      tone: "bad",
    });
  }
  for (const cf of contrastFailures) {
    tokenItems.push({
      label: `${cf.foregroundToken} / ${cf.backgroundToken}`,
      detail: "Low contrast",
      tone: "bad",
    });
  }
  const compTokenFindings: Array<{ count: number; item: PresentationListItem }> = [];
  for (const c of comps) {
    const arbCount = c.arbitraryTailwind.length;
    const primCount = c.primitiveScaleSkips.length;
    const litCount =
      c.inlineStyleLiterals.length +
      c.canvasProvenance.literals.length +
      c.literalValues.filter((l) => l.surface !== "tailwind-arbitrary").length +
      c.invariantViolations.length;
    const total = arbCount + primCount + litCount;
    if (total === 0) continue;
    const parts: string[] = [];
    if (arbCount > 0) parts.push(`${arbCount} Tailwind`);
    if (primCount > 0) parts.push(`${primCount} palette`);
    if (litCount > 0) parts.push(`${litCount} hardcoded`);
    compTokenFindings.push({
      count: total,
      item: {
        label: c.label,
        detail: parts.join(" · "),
        tone: "warn",
        entityId: c.entityId,
      },
    });
  }
  compTokenFindings.sort((a, b) => b.count - a.count);
  for (const entry of compTokenFindings) {
    tokenItems.push(entry.item);
  }
  const cssByFile = new Map<string, number>();
  for (const l of cssLits) {
    const base = l.filePath.split("/").pop() ?? l.filePath;
    cssByFile.set(base, (cssByFile.get(base) ?? 0) + 1);
  }
  for (const [file, count] of [...cssByFile.entries()].sort((a, b) => b[1] - a[1])) {
    tokenItems.push({
      label: file,
      detail: `${count} hardcoded CSS`,
      tone: "warn",
    });
  }

  // ---- 2. High-level line items for "Shared component reuse" ----
  const atomItems: PresentationListItem[] = [];
  const atoms = report.atomicConsolidation.filter((a) =>
    a.instances.some((i) => view.inPackageFile(i.filePath))
  );
  for (const a of atoms) {
    const rawInPkg = a.instances.filter((i) => view.inPackageFile(i.filePath));
    if (rawInPkg.length === 0) continue;
    const hostNames = [...new Set(rawInPkg.map((i) => i.componentName))];
    const where =
      hostNames.length <= 2
        ? hostNames.join(", ")
        : `${hostNames.slice(0, 2).join(", ")} +${hostNames.length - 2}`;
    const sharedEntityId = a.existingSharedComponent
      ? byLabel.get(a.existingSharedComponent.name)?.entityId
      : undefined;
    atomItems.push({
      label: a.existingSharedComponent?.name ?? a.atomName,
      detail: `${rawInPkg.length} raw in ${where}`,
      tone: "warn",
      ...(sharedEntityId ? { entityId: sharedEntityId } : {}),
    });
  }

  // ---- 3. High-level line items for "No duplicate UI" ----
  const duplicateItems: PresentationListItem[] = [];
  for (const t of twins) {
    duplicateItems.push({
      label: t.components.map((c) => c.label).join(", "),
      detail: `Similar ${t.concept.toLowerCase()}`,
      tone: "info",
      entityId: t.components[0]?.entityId,
    });
  }
  for (const g of clones) {
    const cleanName = g.suggestedComponentName.replace(/^Repeated/, "") || g.suggestedComponentName;
    const hosts = [...new Set(g.occurrences.map((o) => o.componentName))];
    const where =
      hosts.length <= 2
        ? hosts.join(", ")
        : `${hosts.slice(0, 2).join(", ")} +${hosts.length - 2}`;
    const firstComp = byLabel.get(g.occurrences[0]?.componentName ?? "");
    duplicateItems.push({
      label: cleanName,
      detail: `${g.occurrenceCount}× in ${where}`,
      tone: "info",
      ...(firstComp ? { entityId: firstComp.entityId } : {}),
    });
  }

  // ---- 4. High-level line items for "Clean component props" ----
  const propItems: PresentationListItem[] = [];
  const overrideGroups = new Map<
    string,
    { parent: string; child: string; count: number; entityId?: string }
  >();
  for (const o of overrides) {
    const key = `${o.parentComponent}→${o.childComponent}`;
    const prev = overrideGroups.get(key);
    if (prev) {
      prev.count++;
    } else {
      overrideGroups.set(key, {
        parent: o.parentComponent,
        child: o.childComponent,
        count: 1,
        entityId: byLabel.get(o.parentComponent)?.entityId,
      });
    }
  }
  for (const g of overrideGroups.values()) {
    propItems.push({
      label: `${g.parent} → ${g.child}`,
      detail: g.count > 1 ? `Style override (×${g.count})` : "Style override",
      tone: "warn",
      ...(g.entityId ? { entityId: g.entityId } : {}),
    });
  }
  for (const c of comps) {
    if (c.composabilityIssues.length === 0) continue;
    const kinds = [
      ...new Set(c.composabilityIssues.map((i) => formatComposabilityKind(i.kind))),
    ];
    propItems.push({
      label: c.label,
      detail: kinds.join(" · "),
      tone: "warn",
      entityId: c.entityId,
    });
  }

  const metrics: PresentationMetric[] = [
    pctMetric(
      "tokenAdherence",
      "Token usage",
      pillars.tokenAdherence,
      "Share of styling decisions routed through tokens instead of hardcoded literals.",
      tokenItems,
      pillars.tokenAdherence === null
        ? "No styling decisions detected in this package."
        : "All styling uses design tokens."
    ),
    pctMetric(
      "atomAdoption",
      "Shared component reuse",
      pillars.atomAdoption,
      "Shared-atom call sites vs raw elements that should be that atom.",
      atomItems,
      pillars.atomAdoption === null
        ? "No shared atom candidates detected in this package."
        : "All primitives use shared components."
    ),
    pctMetric(
      "dryness",
      "No duplicate UI",
      pillars.dryness,
      "Share of components outside any repeated-structure or parallel-component group.",
      duplicateItems,
      pillars.dryness === null
        ? "Not enough components to evaluate duplication."
        : "No duplicate UI or similar components."
    ),
    pctMetric(
      "encapsulation",
      "Clean component props",
      pillars.encapsulation,
      "Share of component call sites without style / literal overrides.",
      propItems,
      pillars.encapsulation === null
        ? "No component call sites to evaluate."
        : "All component call sites use clean props."
    ),
  ];

  const inventory = [
    ["Pages", comps.filter((c) => c.atomicTier === "ROUTE" || c.atomicTier === "TEMPLATE").length],
    ["Organisms", comps.filter((c) => c.atomicTier === "ORGANISM").length],
    ["Molecules", comps.filter((c) => c.atomicTier === "MOLECULE").length],
    ["Atoms", comps.filter((c) => c.atomicTier === "ATOM").length],
  ] as const;
  const nonZeroInventory = inventory.filter(([, n]) => n > 0);
  const pkgStylings = [
    ...new Set(
      comps.flatMap((c) => c.stylingConventions.map(formatStylingConvention))
    ),
  ];

  const basicItems: Array<{ label: string; value: string | number; mono?: boolean }> = [
    {
      label: "Components",
      value:
        nonZeroInventory.length > 0
          ? nonZeroInventory.map(([l, n]) => `${n} ${l}`).join(" · ")
          : `${comps.length} components`,
    },
    {
      label: "Tokens",
      value:
        report.summary.totalDefinedTokens === 0
          ? "0 defined tokens"
          : `${report.summary.totalDefinedTokens} (${[
              report.summary.primitiveTokenCount > 0 ? `${report.summary.primitiveTokenCount} primitive` : "",
              report.summary.semanticTokenCount > 0 ? `${report.summary.semanticTokenCount} semantic` : "",
              report.summary.componentTokenCount > 0 ? `${report.summary.componentTokenCount} component` : "",
              report.summary.themeBridgeTokenCount > 0 ? `${report.summary.themeBridgeTokenCount} @theme` : "",
            ]
              .filter(Boolean)
              .join(" · ")})`,
    },
    ...(pkgStylings.length > 0
      ? [{ label: "Styling", value: pkgStylings.join(" · ") }]
      : []),
  ];

  const sections: PresentationSection[] = [
    {
      id: "design-system",
      title: "Design system",
      priority: 1,
      blocks: [
        { kind: "keyValue", items: basicItems },
        { kind: "metrics", items: metrics },
      ],
    },
  ];

  const spotlightViews = buildSpotlightViewsForPackage(
    shortKey,
    comps,
    bypassed,
    overrides,
    clones,
    twins
  );

  return {
    version: PLUGIN_PRESENTATION_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      status: issueCount === 0 ? "ok" : "warn",
      badge: gradeBadge(packageScore.score, packageScore.grade),
      issueCount,
      metrics,
      ...(spotlightViews.length > 0 ? { views: spotlightViews } : {}),
    },
    sections,
  };
}

function buildSpotlightViewsForPackage(
  shortKey: string,
  comps: ComponentDesignProfile[],
  bypassed: Array<{
    atomTarget: string;
    bypassingComponent: string;
    filePath: string;
    lineNumber: number;
    recommendation: string;
  }>,
  overrides: DesignSystemAnalysisReport["alignmentAudit"]["callSiteOverrides"],
  clones: DesignSystemAnalysisReport["dryAudit"]["structuralJsxClones"],
  twins: DesignSystemAnalysisReport["alignmentAudit"]["parallelTwins"]
): PluginSpotlightView[] {
  const byLabel = new Map<string, ComponentDesignProfile>();
  for (const c of comps) byLabel.set(c.label, c);
  const views: PluginSpotlightView[] = [];

  // 1. One-off Tailwind / primitive scale skips
  {
    const nodes: string[] = [];
    const annotations: Record<string, string> = {};
    let totalCount = 0;
    for (const c of comps) {
      const arb = c.arbitraryTailwind;
      const prim = c.primitiveScaleSkips;
      const count = arb.length + prim.length;
      if (count === 0) continue;
      totalCount += count;
      nodes.push(c.entityId);
      const samples = [
        ...arb.slice(0, 3).map((a) => a.className),
        ...prim.slice(0, 2).map((p) => p.tokenOrClass),
      ].slice(0, 3);
      annotations[c.entityId] = `${count} one-off Tailwind class${count === 1 ? "" : "es"} (${samples.join(", ")})`;
    }
    if (nodes.length > 0) {
      views.push({
        id: "arbitrary-tailwind",
        title: "One-off Tailwind values",
        description: `${totalCount} bracketed or unscaled class${totalCount === 1 ? "" : "es"} across ${nodes.length} component${nodes.length === 1 ? "" : "s"}`,
        badge: { text: `${nodes.length}`, tone: "warn" },
        highlightNodeIds: nodes,
        viewLevel: "package",
        packageName: shortKey,
        nodeAnnotations: annotations,
        layer: "L1_DESIGN_SYSTEM",
      });
    }
  }

  // 2. Hardcoded colors & sizes (inline styles, TS literals, canvas literals, prop color literals)
  {
    const nodes: string[] = [];
    const annotations: Record<string, string> = {};
    let totalCount = 0;
    for (const c of comps) {
      const tsLits = c.literalValues.filter((l) => l.surface !== "tailwind-arbitrary");
      const count =
        c.inlineStyleLiterals.length +
        c.canvasProvenance.literals.length +
        tsLits.length +
        c.invariantViolations.length;
      if (count === 0) continue;
      totalCount += count;
      nodes.push(c.entityId);
      const samples = [
        ...c.invariantViolations.slice(0, 2).map((v) => `${v.prop}="${v.value}"`),
        ...c.inlineStyleLiterals.slice(0, 2).map((l) => `${l.property}: ${l.value}`),
        ...tsLits.slice(0, 2).map((l) => l.value),
        ...c.canvasProvenance.literals.slice(0, 2).map((l) => l.value),
      ].slice(0, 3);
      annotations[c.entityId] = `${count} hardcoded literal${count === 1 ? "" : "s"} (${samples.join(", ")})`;
    }
    if (nodes.length > 0) {
      views.push({
        id: "hardcoded-literals",
        title: "Hardcoded colors & sizes",
        description: `${totalCount} inline or literal value${totalCount === 1 ? "" : "s"} across ${nodes.length} component${nodes.length === 1 ? "" : "s"}`,
        badge: { text: `${nodes.length}`, tone: "warn" },
        highlightNodeIds: nodes,
        viewLevel: "package",
        packageName: shortKey,
        nodeAnnotations: annotations,
        layer: "L1_DESIGN_SYSTEM",
      });
    }
  }

  // 3. Raw HTML instead of shared components
  {
    const byComp = new Map<string, string[]>();
    for (const b of bypassed) {
      const comp = byLabel.get(b.bypassingComponent);
      if (!comp) continue;
      const list = byComp.get(comp.entityId) ?? [];
      list.push(b.atomTarget);
      byComp.set(comp.entityId, list);
    }
    if (byComp.size > 0) {
      const nodes = [...byComp.keys()];
      const annotations: Record<string, string> = {};
      let totalCount = 0;
      for (const [entityId, atoms] of byComp) {
        totalCount += atoms.length;
        const uniqueAtoms = [...new Set(atoms)];
        annotations[entityId] = `${atoms.length} raw element${atoms.length === 1 ? "" : "s"} instead of shared ${uniqueAtoms.map((a) => `<${a}>`).join(", ")}`;
      }
      views.push({
        id: "shared-atoms",
        title: "Raw HTML instead of shared components",
        description: `${totalCount} raw element${totalCount === 1 ? "" : "s"} across ${nodes.length} component${nodes.length === 1 ? "" : "s"}`,
        badge: { text: `${nodes.length}`, tone: "warn" },
        highlightNodeIds: nodes,
        viewLevel: "package",
        packageName: shortKey,
        nodeAnnotations: annotations,
        layer: "L1_DESIGN_SYSTEM",
      });
    }
  }

  // 4. Prop & layout overrides
  {
    const nodes: string[] = [];
    const annotations: Record<string, string> = {};
    let totalCount = 0;
    for (const c of comps) {
      const compOverrides = overrides.filter((o) => o.parentComponent === c.label);
      const count = c.composabilityIssues.length + compOverrides.length;
      if (count === 0) continue;
      totalCount += count;
      nodes.push(c.entityId);
      const notes = [
        ...c.composabilityIssues.slice(0, 2).map((i) => i.detail),
        ...compOverrides.slice(0, 2).map((o) => `Overrides <${o.childComponent}>`),
      ].slice(0, 2);
      annotations[c.entityId] = notes.join(" · ");
    }
    if (nodes.length > 0) {
      views.push({
        id: "prop-composability",
        title: "Prop & layout overrides",
        description: `${totalCount} composability or call-site override issue${totalCount === 1 ? "" : "s"} across ${nodes.length} component${nodes.length === 1 ? "" : "s"}`,
        badge: { text: `${nodes.length}`, tone: "warn" },
        highlightNodeIds: nodes,
        viewLevel: "package",
        packageName: shortKey,
        nodeAnnotations: annotations,
        layer: "L1_DESIGN_SYSTEM",
      });
    }
  }

  // 5. Duplicate markup & parallel components
  {
    const annotations: Record<string, string> = {};
    const nodeSet = new Set<string>();
    for (const t of twins) {
      for (const member of t.components) {
        if (!byLabel.has(member.label)) continue;
        nodeSet.add(member.entityId);
        annotations[member.entityId] = `${t.concept}: ${t.recommendation}`;
      }
    }
    for (const g of clones) {
      for (const occ of g.occurrences) {
        const comp = byLabel.get(occ.componentName);
        if (!comp) continue;
        nodeSet.add(comp.entityId);
        const prev = annotations[comp.entityId];
        const msg = `Repeated <${g.suggestedComponentName}> × ${g.occurrenceCount}`;
        annotations[comp.entityId] = prev ? `${prev} · ${msg}` : msg;
      }
    }
    if (nodeSet.size > 0) {
      const nodes = [...nodeSet];
      const groupCount = twins.length + clones.length;
      views.push({
        id: "duplicate-ui",
        title: "Duplicate markup & parallel components",
        description: `${groupCount} consolidation group${groupCount === 1 ? "" : "s"} across ${nodes.length} component${nodes.length === 1 ? "" : "s"}`,
        badge: { text: `${nodes.length}`, tone: "info" },
        highlightNodeIds: nodes,
        viewLevel: "package",
        packageName: shortKey,
        nodeAnnotations: annotations,
        layer: "L1_DESIGN_SYSTEM",
      });
    }
  }

  return views;
}

// ---------------------------------------------------------------------------
// Component-level presentation (Node Inspector — simple Label / Value rows)
// ---------------------------------------------------------------------------

export function buildComponentPresentation(
  profile: ComponentDesignProfile,
  report: DesignSystemAnalysisReport
): PluginPresentation | null {
  const tierLabel =
    profile.atomicTier === "ROUTE"
      ? "Page"
      : profile.atomicTier.charAt(0) + profile.atomicTier.slice(1).toLowerCase();

  const kvItems: Extract<PresentationBlock, { kind: "keyValue" }>["items"] = [
    { label: "Layer", value: tierLabel },
  ];

  const styling = profile.stylingConventions.map(formatStylingConvention);
  if (styling.length > 0) {
    kvItems.push({ label: "Styling", value: styling.join(" · ") });
  }

  if (profile.tokensConsumed.length > 0) {
    kvItems.push({
      label: "Tokens",
      value: profile.tokensConsumed.join(", "),
      mono: true,
    });
  }

  // ---- Findings rendered in the same Label / Value visual system ----
  let issueCount = 0;

  if (profile.arbitraryTailwind.length > 0) {
    issueCount += profile.arbitraryTailwind.length;
    const uniqueClasses = [
      ...new Set(profile.arbitraryTailwind.map((a) => a.className)),
    ];
    kvItems.push({
      label: "One-off Tailwind",
      value: uniqueClasses.join(", "),
      mono: true,
      tone: "warn",
    });
  }

  if (profile.primitiveScaleSkips.length > 0) {
    issueCount += profile.primitiveScaleSkips.length;
    const uniqueSkips = [
      ...new Set(profile.primitiveScaleSkips.map((p) => p.tokenOrClass)),
    ];
    kvItems.push({
      label: "Raw palette",
      value: uniqueSkips.join(", "),
      mono: true,
      tone: "warn",
    });
  }

  const nonTwLiterals = profile.literalValues.filter(
    (x) => x.surface !== "tailwind-arbitrary"
  );
  const literalCount =
    profile.inlineStyleLiterals.length +
    nonTwLiterals.length +
    profile.canvasProvenance.literals.length +
    profile.invariantViolations.length;
  if (literalCount > 0) {
    issueCount += literalCount;
    const uniqueLits = [
      ...new Set([
        ...profile.invariantViolations.map((v) => `${v.prop}="${v.value}"`),
        ...profile.inlineStyleLiterals.map((l) => `${l.property}: ${l.value}`),
        ...nonTwLiterals.map((l) => l.value),
        ...profile.canvasProvenance.literals.map((l) => String(l.value)),
      ]),
    ];
    kvItems.push({
      label: "Hardcoded values",
      value: uniqueLits.join(", "),
      mono: true,
      tone: "warn",
    });
  }

  const rawAtoms: string[] = [];
  for (const a of report.atomicConsolidation) {
    const matches = a.instances.filter((x) => x.componentName === profile.label);
    if (matches.length > 0) {
      issueCount += matches.length;
      const targetName = a.existingSharedComponent?.name ?? a.atomName;
      rawAtoms.push(
        matches.length > 1 ? `${targetName} (×${matches.length})` : targetName
      );
    }
  }
  if (rawAtoms.length > 0) {
    kvItems.push({
      label: "Shared atoms",
      value: `Raw ${rawAtoms.join(", ")}`,
      tone: "warn",
    });
  }

  if (profile.undefinedTokens.length > 0) {
    issueCount += profile.undefinedTokens.length;
    kvItems.push({
      label: "Undefined tokens",
      value: profile.undefinedTokens.map((u) => u.name).join(", "),
      mono: true,
      tone: "bad",
    });
  }

  const compOverrides = report.alignmentAudit.callSiteOverrides.filter(
    (x) => x.parentComponent === profile.label
  );
  if (profile.composabilityIssues.length > 0 || compOverrides.length > 0) {
    issueCount += profile.composabilityIssues.length + compOverrides.length;
    const notes = [
      ...new Set([
        ...compOverrides.map((o) => `Overrides <${o.childComponent}>`),
        ...profile.composabilityIssues.map((c) => formatComposabilityKind(c.kind)),
      ]),
    ];
    kvItems.push({
      label: "Prop overrides",
      value: notes.join(" · "),
      tone: "warn",
    });
  }

  const compTwins = report.alignmentAudit.parallelTwins.filter((x) =>
    x.components.some((c) => c.entityId === profile.entityId)
  );
  if (compTwins.length > 0) {
    issueCount += compTwins.length;
    const twinLabels = compTwins.map((t) => {
      const others = t.components
        .filter((c) => c.entityId !== profile.entityId)
        .map((c) => c.label)
        .join(", ");
      return `${others} (${t.concept})`;
    });
    kvItems.push({
      label: "Similar UI",
      value: twinLabels.join(" · "),
      tone: "info",
    });
  }

  const compClones = report.dryAudit.structuralJsxClones.filter((x) =>
    x.occurrences.some((o) => o.componentName === profile.label)
  );
  if (compClones.length > 0) {
    issueCount += compClones.length;
    const cloneLabels = compClones.map((g) => {
      const cleanName =
        g.suggestedComponentName.replace(/^Repeated/, "") ||
        g.suggestedComponentName;
      return `${cleanName} (×${g.occurrenceCount})`;
    });
    kvItems.push({
      label: "Repeated UI",
      value: cloneLabels.join(" · "),
      tone: "info",
    });
  }

  const hasSignal =
    issueCount > 0 ||
    styling.length > 0 ||
    profile.tokensConsumed.length > 0 ||
    profile.atomicTier !== "UTILITY";
  if (!hasSignal) return null;

  return {
    version: PLUGIN_PRESENTATION_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      status: issueCount === 0 ? "ok" : "warn",
      badge:
        issueCount === 0
          ? { text: "Aligned", tone: "good" }
          : {
              text: `${issueCount} finding${issueCount === 1 ? "" : "s"}`,
              tone: "warn",
            },
      issueCount,
    },
    sections: [
      {
        id: "design-system",
        title: "Design system",
        priority: 1,
        blocks: [{ kind: "keyValue", items: kvItems }],
      },
    ],
  };
}

/**
 * Attaches `payload.presentation` to the overlays produced by `analyzeRepositoryDesignSystem`.
 * Package overlays get the rich package view; component overlays get their own findings.
 */
export function attachDesignSystemPresentations(
  report: DesignSystemAnalysisReport,
  overlays: EntityOverlayInput[],
  baseline: { path: string } | null,
  records: FindingRecord[],
  measuresFor: (shortKey: string) => {
    score: number | null;
    grade: string;
    notes: string[];
    pillars: {
      tokenAdherence: number | null;
      atomAdoption: number | null;
      dryness: number | null;
      encapsulation: number | null;
    };
  }
): void {
  const byEntity = new Map(report.components.map((c) => [c.entityId, c]));
  for (const ov of overlays) {
    const payload = (ov.payload ?? {}) as Record<string, unknown>;
    let presentation: PluginPresentation | null = null;
    if (payload.isPackageOverlay === true && typeof payload.packageShortKey === "string") {
      const m = measuresFor(payload.packageShortKey);
      presentation = buildPackagePresentation(
        report,
        payload.packageShortKey,
        { score: m.score, grade: m.grade, notes: m.notes },
        m.pillars,
        baseline,
        records
      );
    } else {
      const profile = byEntity.get(ov.entityId);
      if (profile) presentation = buildComponentPresentation(profile, report);
    }
    if (presentation) {
      ov.payload = { ...payload, [PLUGIN_PRESENTATION_PAYLOAD_KEY]: presentation };
    }
  }
}
