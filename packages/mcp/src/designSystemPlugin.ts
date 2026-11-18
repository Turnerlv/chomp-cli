/**
 * packages/mcp/src/designSystemPlugin.ts
 *
 * Design System & Frontend Agent Plugin (`L1_DESIGN_SYSTEM` / `source: 'design-system'`)
 * Enforces [PAT-DB-03], [PAT-DB-05], [PAT-VIS-13], [PAT-VIS-21], [PAT-MCP-08], [PAT-MCP-09].
 *
 * Repo-agnostic, deterministic static analysis plugin for **frontend packages only** (detected
 * from `package.json` dependencies, or listed in `chomp.config.json` → `designSystem.scope`).
 *
 * Nothing here assumes a particular repo's naming. The system is either *derived from the code*
 * (`extract` mode) or *declared in `chomp.config.json`* (`adhere` mode) — see
 * `designSystem/config.ts`. Capabilities:
 *   1. Parses `.css` stylesheets (`:root`, theme selectors, `@theme`, `@property`, CSS nesting) to
 *      inventory tokens and derives their tiers from the token reference graph; detects undefined
 *      `var(--*)` leaks, duplicate/forked declarations, unused tokens, and WCAG 2.1 contrast across
 *      dark/light themes (hex, rgb, hsl, oklch…) — reporting un-evaluable pairs explicitly.
 *   2. Scans React/TSX/TS components for styling convention mix, arbitrary Tailwind, raw palette
 *      use, hardcoded color/length literals (CSS, TS, JSX props, inline styles) and **clusters them
 *      into candidate tokens**; checks prop-literal invariants and atom composability.
 *   3. Derives the atomic hierarchy, parallel-twin components (with a proposed merged prop API),
 *      structural/compositional JSX clones, and shared-atom adoption.
 *   4. Provides the Closed-Loop Frontend Agent Gate (`auditDesignSystem` and `diffDesignSystem`)
 *      against a pinned baseline snapshot ("Query Before Write, Diff After Write").
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, posix as posixPath, resolve } from "node:path";
import ts from "typescript";
import {
  LESS_AT_RULE_KEYWORDS,
  deriveComponentNameFromPath,
  detectStylesheetSyntax,
  extractEmbeddedStyleBlocks,
  extractPreprocessorVarReferences,
  isPreprocessedUiComponentFile,
  isSupportedStylesheetFile,
  preprocessUiComponentToTsx,
  stripStylesheetCommentsPreservingLines,
  type StylesheetSyntax,
} from "./designSystem/preprocessors.js";
import {
  compositeOver,
  computeRelativeLuminance,
  computeWcagContrastRatio,
  looksLikeColorLiteral,
  parseCssColorString,
  rgbaToHex,
  type RgbaColor,
} from "./designSystem/color.js";
import {
  DEFAULT_ATOM_CATALOG,
  DEFAULT_DESIGN_SYSTEM_CONFIG,
  compileRegexes,
  detectFrontendScope,
  globToRegExp,
  resolveDesignSystemConfig,
  type AtomDefinition,
  type AtomMatcher,
  type DesignSystemConfig,
  type ResolvedDesignSystemConfig,
} from "./designSystem/config.js";
import {
  clusterLiteralValues,
  arbitraryTailwindValue,
  extractColorLiterals,
  extractLengthLiterals,
  isLengthSensitiveProperty,
  type DerivedTokenProposal,
  type LiteralValueOccurrence,
  type ResolvedTokenValue,
} from "./designSystem/valueClusters.js";
import { deriveTokenTiers, isScaleStepTokenName } from "./designSystem/tokens.js";
import {
  countFindings,
  diffFindings,
  findingKey,
  readBaselineSnapshot,
  resolveBaselinePath,
  totalsByCategory,
  writeBaselineSnapshot,
  checkWorkingTreeClean,
  type DesignSystemBaselineSnapshot,
  type FindingRecord,
  type WorkingTreeCheck,
} from "./designSystem/baseline.js";
import { attachDesignSystemPresentations } from "./designSystem/presentation.js";
import { analyzeTarget, type RepresentationGraph, type StructuralNode } from "@chomp/core";
import {
  createSQLiteStorage,
  type EntityOverlayInput,
  type EntityOverlayRecord,
  type OverlayEvidenceItem,
  type OverlayInputDependency,
} from "@chomp/db";
import {
  buildOverlayEvidence,
  registerChompPlugin,
  resolveRepoName,
  runChompPlugin,
  type ChompPlugin,
  type ChompPluginContext,
} from "./pluginRunner.js";

export type TokenTier = "primitive" | "semantic" | "component";
export type ThemeContext = "root" | "dark" | "light" | "theme-bridge";
export type StylingConvention =
  | "css-classes"
  | "css-modules"
  | "css-in-js"
  | "tailwind"
  | "inline-style"
  | "pixi-canvas";

export type AtomicTier =
  | "ROUTE"
  | "TEMPLATE"
  | "ORGANISM"
  | "MOLECULE"
  | "ATOM"
  | "UTILITY";

export type AtomicClassificationSource =
  | "convention-table"
  | "renders-topology"
  | "ast-footprint";

/**
 * Declarative, framework-agnostic UI role convention row modeled after
 * `@chomp/core`'s `ConventionRow` table product architecture.
 * Supports Next.js, Remix, React Router, Astro, Vite/SPA, Vue/Nuxt, SvelteKit,
 * SwiftUI, and standard Atomic Design directory conventions without hardcoding
 * a single framework.
 */
export interface UiRoleConventionRow {
  id: string;
  framework: string;
  role: AtomicTier;
  entityTypes?: string[];
  patternIdPrefixes?: string[];
  filePathPatterns?: RegExp[];
}

export const UI_ROLE_CONVENTIONS: readonly UiRoleConventionRow[] = [
  {
    id: "nextjs.route",
    framework: "Next.js",
    role: "ROUTE",
    entityTypes: ["NEXTJS_PAGE"],
    patternIdPrefixes: ["nextjs.page", "nextjs.app-page", "nextjs.pages-page"],
    filePathPatterns: [
      /(?:^|\/)app\/(?:.*\/)?page\.(?:tsx|jsx|ts|js)$/i,
      /(?:^|\/)pages\/(?!_app|_document|api\/).+\.(?:tsx|jsx|ts|js)$/i,
    ],
  },
  {
    id: "nextjs.template",
    framework: "Next.js",
    role: "TEMPLATE",
    entityTypes: ["NEXTJS_LAYOUT"],
    patternIdPrefixes: ["nextjs.layout", "nextjs.template"],
    filePathPatterns: [
      /(?:^|\/)app\/(?:.*\/)?(?:layout|template)\.(?:tsx|jsx|ts|js)$/i,
      /(?:^|\/)pages\/(?:_app|_document)\.(?:tsx|jsx|ts|js)$/i,
    ],
  },
  {
    id: "remix-react-router.route",
    framework: "Remix / React Router",
    role: "ROUTE",
    entityTypes: ["REMIX_ROUTE", "REACT_ROUTER_ROUTE", "ROUTE_MODULE"],
    patternIdPrefixes: ["remix.route", "react-router.route"],
    filePathPatterns: [
      /(?:^|\/)routes\/[^/]+\.(?:tsx|jsx|ts|js)$/i,
      /(?:^|\/)routes\/.+\/route\.(?:tsx|jsx|ts|js)$/i,
    ],
  },
  {
    id: "astro-svelte-vue.route",
    framework: "Astro / SvelteKit / Nuxt",
    role: "ROUTE",
    entityTypes: ["ASTRO_PAGE", "SVELTEKIT_PAGE", "NUXT_PAGE", "VUE_PAGE"],
    patternIdPrefixes: ["astro.page", "sveltekit.page", "nuxt.page", "vue.page"],
    filePathPatterns: [
      /(?:^|\/)routes\/(?:.*\/)?\+page\.(?:svelte|ts|js)$/i,
      /(?:^|\/)pages\/.+\.(?:astro|vue|svelte)$/i,
    ],
  },
  {
    id: "astro-svelte-vue.template",
    framework: "Astro / SvelteKit / Nuxt",
    role: "TEMPLATE",
    entityTypes: ["ASTRO_LAYOUT", "SVELTEKIT_LAYOUT", "NUXT_LAYOUT"],
    patternIdPrefixes: ["astro.layout", "sveltekit.layout", "nuxt.layout"],
    filePathPatterns: [
      /(?:^|\/)routes\/(?:.*\/)?\+layout\.(?:svelte|ts|js)$/i,
      /(?:^|\/)layouts\/.+\.(?:astro|vue|svelte|tsx|jsx)$/i,
    ],
  },
  {
    id: "generic-spa.route",
    framework: "Generic SPA / Views",
    role: "ROUTE",
    entityTypes: ["ROUTE", "SCREEN", "PAGE", "VIEW_SCREEN"],
    patternIdPrefixes: ["spa.route", "spa.screen", "swiftui.screen"],
    filePathPatterns: [
      /(?:^|\/)(?:screens|views|pages)\/[^/]+(?:Page|Screen|View|Route)\.(?:tsx|jsx|vue|svelte|swift)$/i,
    ],
  },
  {
    id: "generic-ui.template",
    framework: "Generic UI",
    role: "TEMPLATE",
    entityTypes: ["LAYOUT", "TEMPLATE", "APP_SHELL"],
    patternIdPrefixes: ["ui.layout", "ui.template"],
    filePathPatterns: [
      /(?:^|\/)(?:templates|shells|layouts)\/[^/]+\.(?:tsx|jsx|vue|svelte)$/i,
    ],
  },
  {
    id: "atomic-dir.atom",
    framework: "Atomic Design Convention",
    role: "ATOM",
    entityTypes: ["UI_ATOM", "UI_PRIMITIVE"],
    patternIdPrefixes: ["ui.atom", "ui.primitive"],
    filePathPatterns: [
      /(?:^|\/)(?:atoms|primitives|components\/ui|ui\/primitives)\/[^/]+\.(?:tsx|jsx|vue|svelte)$/i,
    ],
  },
  {
    id: "atomic-dir.molecule",
    framework: "Atomic Design Convention",
    role: "MOLECULE",
    entityTypes: ["UI_MOLECULE"],
    patternIdPrefixes: ["ui.molecule"],
    filePathPatterns: [
      /(?:^|\/)molecules\/[^/]+\.(?:tsx|jsx|vue|svelte)$/i,
    ],
  },
  {
    id: "atomic-dir.organism",
    framework: "Atomic Design Convention",
    role: "ORGANISM",
    entityTypes: ["UI_ORGANISM"],
    patternIdPrefixes: ["ui.organism"],
    filePathPatterns: [
      /(?:^|\/)(?:organisms|features|widgets)\/[^/]+\.(?:tsx|jsx|vue|svelte)$/i,
    ],
  },
];

export interface ComponentPropSignature {
  name: string;
  type: string;
  required: boolean;
  /** Values of a string-literal union prop (e.g. `variant: "primary" | "ghost"`), when statically visible. */
  variants?: string[];
}

export interface JsxCallSiteRecord {
  targetComponent: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
  passedProps: string[];
  hasInlineStyleOverride: boolean;
  inlineStyleProps: string[];
  arbitraryTailwindOverrides: string[];
  classNameOverride?: string;
  /** Props that received a raw color literal (`color="#fff"`): an invariant violation when the prop is a design-token slot. */
  literalProps: Array<{ prop: string; value: string; kind: "color" }>;
}

export interface JsxSkeletonOccurrence {
  skeletonHash: string;
  skeletonShape: string;
  canonicalSignature: string;
  rootTag: string;
  elementCount: number;
  /** Custom (component) elements in the repeated subtree; ≥3 means a compositional pattern. */
  customCount: number;
  depth: number;
  filePath: string;
  lineNumber: number;
  snippet: string;
}

export interface CssTokenDeclaration {
  name: string;
  value: string;
  tier: TokenTier;
  themeContext: ThemeContext;
  selector: string;
  filePath: string;
  lineNumber: number;
  referencedVars: string[];
  /** `global`: declared on a root / theme / `@theme` / `@property` rule. `scoped`: declared on a component or utility selector. */
  scope: "global" | "scoped";
}

export interface TokenReferenceOccurrence {
  name: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
  kind: "css-var" | "ts-var" | "canvas-bridge";
  /** `var(--x, fallback)`: the token is an optional customization hook. */
  hasFallback?: boolean;
}

export interface UndefinedTokenDiagnostic {
  name: string;
  occurrenceCount: number;
  occurrences: Array<{
    filePath: string;
    lineNumber: number;
    snippet: string;
  }>;
}

export interface DuplicateTokenDiagnostic {
  name: string;
  tier: TokenTier;
  distinctFileCount: number;
  isForkedValue: boolean;
  declarations: Array<{
    filePath: string;
    lineNumber: number;
    selector: string;
    themeContext: ThemeContext;
    value: string;
  }>;
}

export interface ContrastAuditItem {
  pairId: string;
  foregroundToken: string;
  backgroundToken: string;
  contextLabel: string;
  minRequiredRatio: number;
  dark?: {
    fgHex: string;
    bgHex: string;
    ratio: number;
    passes: boolean;
  };
  light?: {
    fgHex: string;
    bgHex: string;
    ratio: number;
    passes: boolean;
  };
  /** Single-theme repos (no `dark`/`light` overrides): the default theme result. */
  root?: {
    fgHex: string;
    bgHex: string;
    ratio: number;
    passes: boolean;
  };
  passesAll: boolean;
  filePath?: string;
  lineNumber?: number;
}

/** A contrast pair the engine could not evaluate. "Unknown" is a valid, visible state. */
export interface ContrastUnresolvedItem {
  pairId: string;
  foregroundToken: string;
  backgroundToken: string;
  theme: "root" | "dark" | "light";
  reason:
    | "foreground-unresolved"
    | "background-unresolved"
    | "unsupported-color-syntax"
    | "background-translucent-without-base";
  detail?: string;
}

export interface ArbitraryTailwindOccurrence {
  className: string;
  category:
    | "typography"
    | "spacing-sizing"
    | "radius-border"
    | "color"
    | "layout";
  filePath: string;
  lineNumber: number;
  snippet: string;
}

export interface PrimitiveScaleSkipOccurrence {
  tokenOrClass: string;
  kind: "tailwind-primitive" | "css-primitive-var";
  suggestedSemantic: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
}

export interface CanvasLiteralOccurrence {
  slot: string;
  prop: string;
  value: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
}

export interface InlineStyleLiteralOccurrence {
  property: string;
  value: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
}

export interface RawDomPrimitiveOccurrence {
  tagOrRole: string;
  /** `AtomDefinition.name` of the atom this raw element should be (e.g. `Button`). */
  atomicTarget: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
}

export interface ComponentDesignProfile {
  entityId: string;
  name: string;
  label: string;
  entityType: string;
  packageName: string;
  filePath: string;
  lineNumber?: number;
  atomicTier: AtomicTier;
  classificationSource: AtomicClassificationSource;
  conventionId?: string;
  rendersInDegree: number;
  rendersOutDegree: number;
  jsxDomElementCount: number;
  jsxCustomComponentCount: number;
  stateHookCount: number;
  propContract: ComponentPropSignature[];
  jsxCallSites: JsxCallSiteRecord[];
  jsxSkeletons: JsxSkeletonOccurrence[];
  usedInRoutes: string[];
  stylingConventions: StylingConvention[];
  cssClassesUsed: string[];
  dynamicClassPrefixes: string[];
  tokensConsumed: string[];
  undefinedTokens: UndefinedTokenDiagnostic[];
  arbitraryTailwind: ArbitraryTailwindOccurrence[];
  primitiveScaleSkips: PrimitiveScaleSkipOccurrence[];
  inlineStyleLiterals: InlineStyleLiteralOccurrence[];
  canvasProvenance: {
    usesSlotRecorder: boolean;
    cssCount: number;
    tsConstCount: number;
    literalCount: number;
    literals: CanvasLiteralOccurrence[];
  };
  rawDomPrimitives: RawDomPrimitiveOccurrence[];
  atomicCandidates: string[];
  renderedComponents: string[];
  /** Distinct raw DOM tags this component renders (for twin similarity). */
  domTags: string[];
  /** Count of non-arbitrary Tailwind utilities (styling routed through the theme). */
  tailwindUtilityCount: number;
  /** Variant axes discovered from `cva()`/`tv()` calls: axis → values. */
  variantAxes: Record<string, string[]>;
  /** Hardcoded color/length literals found in this component (feeds value clustering). */
  literalValues: LiteralValueOccurrence[];
  /** Raw color literals passed to design-token-like props at call sites in this component. */
  invariantViolations: InvariantViolation[];
  /** Hidden margins / fixed widths / data-layer imports that hurt drop-in composability. */
  composabilityIssues: ComposabilityIssue[];
}

export interface InvariantViolation {
  parentComponent: string;
  childComponent: string;
  prop: string;
  value: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
}

export interface ComposabilityIssue {
  kind: "root-margin" | "fixed-width" | "forbidden-import";
  component: string;
  detail: string;
  filePath: string;
  lineNumber: number;
  snippet?: string;
}

export interface RouteCompositionTreeNode {
  entityId: string;
  label: string;
  atomicTier: AtomicTier;
  filePath: string;
  children: RouteCompositionTreeNode[];
}

export interface RouteCompositionItem {
  routeId: string;
  routeLabel: string;
  filePath: string;
  frameworkConvention: string;
  enclosingTemplates: string[];
  tierBreakdown: {
    templates: string[];
    organisms: string[];
    molecules: string[];
    atoms: string[];
    utilities: string[];
  };
  compositionTree: RouteCompositionTreeNode;
  totalReachableComponents: number;
  sharedComponentsUsed: string[];
  routeExclusiveComponents: string[];
  inlineRawDomCount: number;
  compositionRatio: number;
  routeSmells: Array<{
    code:
      | "MONOLITHIC_ROUTE"
      | "ISOLATED_ROUTE_VOCABULARY"
      | "BYPASSED_ATOMS"
      | "MISSING_ATOM_LAYER";
    severity: "WARN" | "INFO";
    message: string;
  }>;
}

export interface AtomicHierarchySummary {
  tierCounts: Record<AtomicTier, number>;
  conventionsMatched: Array<{
    conventionId: string;
    framework: string;
    role: AtomicTier;
    matchCount: number;
  }>;
  byTier: Record<
    AtomicTier,
    Array<{
      entityId: string;
      label: string;
      filePath: string;
      lineNumber?: number;
      rendersInDegree: number;
      rendersOutDegree: number;
      domElements: number;
      customChildren: number;
      propCount: number;
      classificationSource: AtomicClassificationSource;
    }>
  >;
}

export interface BypassedAtomFinding {
  atomTarget: RawDomPrimitiveOccurrence["atomicTarget"];
  bypassingComponent: string;
  bypassingTier: AtomicTier;
  filePath: string;
  lineNumber: number;
  snippet: string;
  existingSharedComponent?: string;
  recommendation: string;
}

export interface ParallelTwinGroup {
  concept: string;
  components: Array<{
    entityId: string;
    label: string;
    atomicTier: AtomicTier;
    filePath: string;
    lineNumber?: number;
  }>;
  sharedSignals: string[];
  /** Mean pairwise Jaccard similarity of (props ∪ DOM tags ∪ tokens) across the group. */
  similarity: number;
  /** Proposed unified prop API: union of observed props with the share of components that declare each. */
  proposedProps: Array<{
    name: string;
    type: string;
    usedBy: number;
    required: boolean;
  }>;
  /** Variant values observed across the group (from `cva`/`tv` axes), per axis. */
  observedVariants: Record<string, string[]>;
  recommendation: string;
}

export interface CallSiteOverrideFinding {
  parentComponent: string;
  childComponent: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
  overrideKind: "inline-style" | "arbitrary-tailwind" | "both";
  details: string[];
}

export interface PropApiDriftGroup {
  semanticRole: string;
  variants: Array<{
    propName: string;
    components: string[];
  }>;
  canonicalRecommendation: string;
}

export interface AlignmentAuditSection {
  bypassedAtoms: BypassedAtomFinding[];
  parallelTwins: ParallelTwinGroup[];
  callSiteOverrides: CallSiteOverrideFinding[];
  propApiDrift: PropApiDriftGroup[];
  invariantViolations: InvariantViolation[];
  composabilityIssues: ComposabilityIssue[];
}

export interface StructuralJsxCloneGroup {
  skeletonHash: string;
  skeletonShape: string;
  elementCount: number;
  occurrenceCount: number;
  distinctFileCount: number;
  suggestedTier: "ATOM" | "MOLECULE" | "ORGANISM";
  suggestedComponentName: string;
  /** `low`: name is a structural placeholder derived from the skeleton; a human should rename it. */
  nameConfidence: "medium" | "low";
  /** True when the repeated structure is built from custom components (e.g. Card + Thumbnail + TextLink), not only raw DOM. */
  compositional: boolean;
  occurrences: Array<{
    componentName: string;
    filePath: string;
    lineNumber: number;
    snippet: string;
  }>;
}

export interface DryAuditSection {
  structuralJsxClones: StructuralJsxCloneGroup[];
  atomicConsolidation: AtomicConsolidationCandidate[];
  duplicateCssTokens: DuplicateTokenDiagnostic[];
}

/**
 * Measured ratios (0–100) replacing the legacy heuristic penalty score. A pillar is `null` when
 * the repo gives no evidence for it; the overall grade is `N/A` when fewer than two pillars have evidence.
 */
export interface AgentExtendabilityMeasures {
  /** Share of styling decisions routed through tokens vs. hardcoded literals. */
  tokenAdherence: number | null;
  /** Share of atom-shaped elements that use an existing shared atom vs. raw DOM. */
  atomAdoption: number | null;
  /** 100 − share of components participating in clone / parallel-twin groups. */
  dryness: number | null;
  /** 100 − share of component call sites that override style via inline style / arbitrary Tailwind / literal props. */
  encapsulation: number | null;
}

export interface AgentExtendabilitySection {
  overallScore: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | "N/A";
  /** Why the grade is `N/A`, or which pillars lacked evidence. */
  evidenceNotes: string[];
  measures: AgentExtendabilityMeasures;
  pavedRoadBlueprint: {
    canonicalTokensByRole: {
      surfaces: string[];
      text: string[];
      borders: string[];
      accents: string[];
      states: string[];
    };
    reusableBuildingBlocks: Array<{
      entityId: string;
      label: string;
      atomicTier: AtomicTier;
      filePath: string;
      rendersInDegree: number;
      propSignature: string;
    }>;
    missingPrimitivesToExtract: string[];
    extensionRules: string[];
  };
}

export interface AtomicConsolidationCandidate {
  atomName: string;
  description: string;
  /** Raw (un-shared) instances only; adopters are counted separately. */
  instanceCount: number;
  /** `<SharedAtom />` call sites already using the shared component. */
  adopterCount: number;
  /** adopters / (adopters + raw instances), 0–100. `null` when no shared component exists yet. */
  adoptionRate: number | null;
  distinctFiles: string[];
  existingSharedComponent?: {
    name: string;
    filePath: string;
    lineNumber?: number;
  };
  instances: Array<{
    componentName: string;
    filePath: string;
    lineNumber: number;
    snippet: string;
  }>;
  consolidationGuidance: string;
}

/** Which system was audited, and how it was determined. */
export interface DesignSystemSourceInfo {
  mode: "extract" | "adhere";
  modeReason: string;
  configPath: string | null;
  configWarnings: string[];
  /** Frontend packages included in the audit and why (detected or configured). */
  packages: Array<{ dir: string; name?: string; frontend: boolean; reason: string }>;
  /** Atom catalog used for raw-DOM detection (names only). */
  atomCatalog: string[];
  /** Adhere mode: system token source globs. */
  tokenSources: string[];
  /** How token tiers were assigned. */
  tierSources: Record<"config" | "derived" | "scoped" | "theme-bridge", number>;
  /** Theme contexts actually observed in CSS. */
  themesObserved: Array<"root" | "dark" | "light" | "theme-bridge">;
  /** Stylesheets that declare most of the global tokens (where new tokens should live). */
  primaryTokenFiles: string[];
}

/** Things the audit could not see or evaluate. Reported so absence of findings is not mistaken for health. */
export interface CoverageSection {
  /** Files in frontend packages with a style/markup language the plugin does not parse (`.scss`, `.vue`, …). */
  unsupportedFiles: Array<{ extension: string; count: number; sample: string[] }>;
  contrastUnresolved: ContrastUnresolvedItem[];
  /** Tokens defined only outside `tokens.sources` (adhere mode). */
  tokensOutsideSystem: Array<{ name: string; filePath: string; lineNumber: number }>;
  notes: string[];
}

export interface DesignSystemAnalysisReport {
  repoId: string;
  repoName: string;
  system: DesignSystemSourceInfo;
  coverage: CoverageSection;
  /** Bottom-up token proposals derived by clustering hardcoded values. */
  derivedTokens: DerivedTokenProposal[];
  summary: {
    cssFilesScanned: number;
    componentFilesScanned: number;
    componentsProfiled: number;
    routeCount: number;
    templateCount: number;
    organismCount: number;
    moleculeCount: number;
    atomCount: number;
    utilityCount: number;
    structuralJsxCloneCount: number;
    bypassedAtomCount: number;
    parallelTwinGroupCount: number;
    callSiteOverrideCount: number;
    propApiDriftGroupCount: number;
    agentExtendabilityScore: number | null;
    agentExtendabilityGrade: "A" | "B" | "C" | "D" | "F" | "N/A";
    totalDefinedTokens: number;
    primitiveTokenCount: number;
    semanticTokenCount: number;
    componentTokenCount: number;
    themeBridgeTokenCount: number;
    undefinedTokenCount: number;
    duplicateTokenCount: number;
    forkedTokenCount: number;
    unusedTokenCount: number;
    contrastPairsAudited: number;
    contrastCandidateCount: number;
    contrastFailureCount: number;
    contrastPairsUnresolved: number;
    hardcodedLiteralCount: number;
    derivedTokenProposalCount: number;
    invariantViolationCount: number;
    composabilityIssueCount: number;
    frontendPackageCount: number;
    unsupportedFileCount: number;
    arbitraryTailwindCount: number;
    primitiveScaleSkipCount: number;
    inlineStyleLiteralCount: number;
    canvasCssSlotCount: number;
    canvasTsConstSlotCount: number;
    canvasLiteralSlotCount: number;
    rawDomPrimitiveCount: number;
    atomicConsolidationGroupCount: number;
    dynamicClassPrefixCount: number;
    unusedCssSelectorCount: number;
    conventionBreakdown: Record<StylingConvention, number>;
  };
  routeComposition: RouteCompositionItem[];
  atomicHierarchy: AtomicHierarchySummary;
  alignmentAudit: AlignmentAuditSection;
  dryAudit: DryAuditSection;
  agentExtendability: AgentExtendabilitySection;
  tokenCatalog: {
    primitive: string[];
    semantic: string[];
    component: string[];
    themeBridge: string[];
  };
  diagnostics: {
    undefinedTokens: UndefinedTokenDiagnostic[];
    duplicateTokens: DuplicateTokenDiagnostic[];
    unusedTokens: Array<{
      name: string;
      tier: TokenTier;
      filePath: string;
      lineNumber: number;
    }>;
    contrastFailures: ContrastAuditItem[];
    contrastAudits: ContrastAuditItem[];
    unusedCssSelectors: Array<{
      selector: string;
      filePath: string;
      lineNumber: number;
    }>;
    dynamicClassPrefixes: string[];
    /** Every hardcoded color/length literal in stylesheet rules (not token definitions). */
    hardcodedCssLiterals: LiteralValueOccurrence[];
  };
  atomicConsolidation: AtomicConsolidationCandidate[];
  components: ComponentDesignProfile[];
}

// ---------------------------------------------------------------------------
// 1. Helpers: Line Indexing, Comment Stripping, & Token Classification
// ---------------------------------------------------------------------------

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLineNumber(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}

function getLineSnippet(lines: string[], lineNumber: number): string {
  const raw = lines[lineNumber - 1] ?? "";
  return raw.trim().slice(0, 200);
}

/**
 * Replaces CSS block comments (`/* ... * /`) with spaces while preserving `\n`
 * characters so character offsets and 1-based line numbers remain 100% exact.
 */
function stripCssCommentsPreservingLines(cssText: string): string {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " ")
  );
}

export function classifyTokenTier(
  tokenName: string,
  inThemeBridge = false,
  tiers?: DesignSystemConfig["tokens"]["tiers"]
): TokenTier {
  if (inThemeBridge) {
    return "semantic";
  }
  if (tiers) {
    if (compileRegexes(tiers.component).some((re) => re.test(tokenName))) return "component";
    if (compileRegexes(tiers.semantic).some((re) => re.test(tokenName))) return "semantic";
    if (compileRegexes(tiers.primitive).some((re) => re.test(tokenName))) return "primitive";
  }
  // Provisional, convention-free name heuristic. Final tiers are re-derived from the token
  // reference graph in `analyzeRepositoryDesignSystem` (see `designSystem/tokens.ts`).
  const lower = tokenName.toLowerCase();
  if (
    /^(?:--|\$|@)primitive-/.test(lower) ||
    /^(?:--|\$|@)(?:space|spacing|size|radius|font-size|font-family|leading|tracking|shadow|z|opacity)-/.test(
      lower
    ) ||
    isScaleStepTokenName(lower)
  ) {
    return "primitive";
  }
  return "semantic";
}

const VAR_REF_RE = /var\(\s*(--[a-zA-Z0-9_-]+)(\s*,)?/g;

/** Token names referenced with a fallback (`var(--x, #fff)`): an intentional customization hook, not a leak. */
function extractVarFallbackNames(value: string): Set<string> {
  const names = new Set<string>();
  for (const m of value.matchAll(VAR_REF_RE)) {
    if (m[1] && m[2]) names.add(m[1]);
  }
  return names;
}

function extractVarReferences(value: string): string[] {
  const refs: string[] = [];
  for (const m of value.matchAll(VAR_REF_RE)) {
    if (m[1] && !refs.includes(m[1])) {
      refs.push(m[1]);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// 2. CSS Stylesheet Parser (Tokens, Selectors, Rule Pairs & Hardcoded Literals)
// ---------------------------------------------------------------------------

interface ParsedCssRule {
  selector: string;
  filePath: string;
  lineNumber: number;
  declarations: Array<{
    prop: string;
    value: string;
    lineNumber: number;
  }>;
  classesInSelector: string[];
  tokensConsumed: string[];
}

interface ParsedCssStylesheet {
  filePath: string;
  tokenDeclarations: CssTokenDeclaration[];
  varReferences: TokenReferenceOccurrence[];
  styleRules: ParsedCssRule[];
  /** Hardcoded color/length literals found in non-token declarations. */
  literals: LiteralValueOccurrence[];
}

export interface ParseCssOptions {
  /** Compiled dark/light theme selector patterns (default: `DEFAULT_DESIGN_SYSTEM_CONFIG.themes`). */
  themes?: { dark: RegExp[]; light: RegExp[] };
  tiers?: DesignSystemConfig["tokens"]["tiers"];
  /** Stylesheet syntax mode (`css`, `scss`, or `less`; auto-detected from `filePath` by default). */
  syntax?: StylesheetSyntax;
  /** True when parsing `<style scoped>` or Svelte/Astro component-scoped `<style>` blocks. */
  defaultScoped?: boolean;
}

const CLASS_IN_SELECTOR_RE = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;
const CSS_CONTAINER_AT_RULES = [
  "@media",
  "@supports",
  "@layer",
  "@container",
  "@scope",
  "@starting-style",
  "@document",
  "@mixin",
  "@include",
  "@if",
  "@else",
  "@each",
  "@for",
  "@while",
  "@at-root",
];
const NON_LITERAL_PROPS = new Set(["content", "font-family", "src", "quotes", "counter-reset"]);

function resolveNestedSelector(header: string, parent: string | undefined): string {
  if (!parent) return header;
  return header
    .split(",")
    .map((part) => {
      const p = part.trim();
      return p.includes("&") ? p.replace(/&/g, parent) : `${parent} ${p}`;
    })
    .join(", ");
}

function isGlobalSelector(header: string, themeRes: RegExp[]): boolean {
  for (const part of header.split(",")) {
    let rest = part;
    for (const re of themeRes) {
      rest = rest.replace(new RegExp(re.source, "gi"), " ");
    }
    rest = rest
      .replace(/:root|\bhtml\b|\bbody\b|\*|&/gi, " ")
      .replace(/:(?:where|is)\(\s*\)/g, " ")
      .replace(/[>+~\s]+/g, "");
    if (rest !== "" && !/^(?:\[[^\]]+\])+$/.test(rest)) return false;
  }
  return true;
}

export function parseCssStylesheet(
  filePath: string,
  rawText: string,
  options: ParseCssOptions = {}
): ParsedCssStylesheet {
  const darkRes =
    options.themes?.dark ?? compileRegexes(DEFAULT_DESIGN_SYSTEM_CONFIG.themes.dark);
  const lightRes =
    options.themes?.light ?? compileRegexes(DEFAULT_DESIGN_SYSTEM_CONFIG.themes.light);
  const themeRes = [...darkRes, ...lightRes];

  const syntax = options.syntax ?? detectStylesheetSyntax(filePath);
  const cleaned = stripStylesheetCommentsPreservingLines(rawText, syntax !== "css");
  const lineStarts = buildLineStarts(rawText);
  const rawLines = rawText.split(/\r?\n/);

  const tokenDeclarations: CssTokenDeclaration[] = [];
  const varReferences: TokenReferenceOccurrence[] = [];
  const styleRules: ParsedCssRule[] = [];
  const literals: LiteralValueOccurrence[] = [];

  const cleanPreprocFlags = (val: string) =>
    val.replace(/\s*!(?:default|global|important)\s*$/i, "").trim();

  const isPreprocTokenProp = (prop: string): boolean => {
    if (syntax === "scss" && /^\$[a-zA-Z_][a-zA-Z0-9_-]*$/.test(prop)) return true;
    if (
      syntax === "less" &&
      /^@[a-zA-Z_][a-zA-Z0-9_-]*$/.test(prop) &&
      !LESS_AT_RULE_KEYWORDS.has(prop.slice(1).toLowerCase())
    ) {
      return true;
    }
    return false;
  };

  // Parse blocks (`selector { ... }`). Handles `@theme`, `@property`, container at-rules, SCSS/Less variables & nesting.
  const parseBlocks = (
    textSlice: string,
    baseOffset: number,
    enclosingAtRule?: string,
    parentSelector?: string
  ) => {
    let i = 0;
    const len = textSlice.length;

    while (i < len) {
      while (i < len && /\s/.test(textSlice[i])) i++;
      if (i >= len) break;

      const openBrace = textSlice.indexOf("{", i);
      const semicolon = textSlice.indexOf(";", i);

      // Handle top-level statements (`@import ...;`, `@layer a, b;`, `$token: #111;`, `@token: #111;`)
      if (semicolon !== -1 && (openBrace === -1 || semicolon < openBrace)) {
        if (syntax !== "css") {
          const stmtSlice = textSlice.slice(i, semicolon).trim();
          const colonIdx = stmtSlice.indexOf(":");
          if (colonIdx > 0) {
            const prop = stmtSlice.slice(0, colonIdx).trim();
            if (isPreprocTokenProp(prop)) {
              const value = cleanPreprocFlags(
                stmtSlice.slice(colonIdx + 1).replace(/\s+/g, " ").trim()
              );
              const stmtLine = offsetToLineNumber(lineStarts, baseOffset + i);
              const refs = [
                ...extractVarReferences(value),
                ...extractPreprocessorVarReferences(value, syntax),
              ];
              const fallbackNames = extractVarFallbackNames(value);
              for (const refName of refs) {
                varReferences.push({
                  name: refName,
                  filePath,
                  lineNumber: stmtLine,
                  snippet: getLineSnippet(rawLines, stmtLine),
                  kind: "css-var",
                  ...(fallbackNames.has(refName) ? { hasFallback: true } : {}),
                });
              }
              const isScopedTop = Boolean(options.defaultScoped && !parentSelector);
              tokenDeclarations.push({
                name: prop,
                value,
                tier: isScopedTop
                  ? "component"
                  : classifyTokenTier(prop, false, options.tiers),
                themeContext: "root",
                selector: parentSelector ?? ":root",
                filePath,
                lineNumber: stmtLine,
                referencedVars: refs,
                scope: isScopedTop ? "scoped" : "global",
              });
            }
          }
        }
        i = semicolon + 1;
        continue;
      }
      if (openBrace === -1) break;

      const rawHeader = textSlice.slice(i, openBrace).trim();
      const headerOffset = baseOffset + i;
      const headerLine = offsetToLineNumber(lineStarts, headerOffset);

      // Find matching closing brace
      let depth = 1;
      let j = openBrace + 1;
      while (j < len && depth > 0) {
        if (textSlice[j] === "{") depth++;
        else if (textSlice[j] === "}") depth--;
        j++;
      }
      const bodyStartOffset = baseOffset + openBrace + 1;
      const bodySlice = textSlice.slice(openBrace + 1, Math.max(openBrace + 1, j - 1));

      if (CSS_CONTAINER_AT_RULES.some((at) => rawHeader.startsWith(at))) {
        parseBlocks(bodySlice, bodyStartOffset, rawHeader, parentSelector);
        i = j;
        continue;
      }

      if (
        rawHeader.startsWith("@keyframes") ||
        rawHeader.startsWith("@font-face") ||
        rawHeader.startsWith("@function")
      ) {
        i = j;
        continue;
      }

      if (rawHeader.startsWith("@property")) {
        const propName = rawHeader.slice("@property".length).trim();
        if (propName.startsWith("--")) {
          const initial = bodySlice.match(/initial-value\s*:\s*([^;]+)/);
          tokenDeclarations.push({
            name: propName,
            value: initial ? initial[1].replace(/\s+/g, " ").trim() : "",
            tier: classifyTokenTier(propName, false, options.tiers),
            themeContext: "root",
            selector: rawHeader,
            filePath,
            lineNumber: headerLine,
            referencedVars: [],
            scope: "global",
          });
        }
        i = j;
        continue;
      }

      const header = resolveNestedSelector(rawHeader, parentSelector);
      const isThemeBridge = header.startsWith("@theme");
      const hasRoot = /:root\b|(?:^|[\s,])html\b|:global\s*\(\s*:root\s*\)/i.test(header);
      const isGlobal =
        isThemeBridge ||
        hasRoot ||
        (!options.defaultScoped && isGlobalSelector(header, themeRes));

      // Theme contexts are resolved per selector part, so `:root, [data-theme="dark"]` declares both the
      // default (root) and dark values, while `:root.dark` or `@media (prefers-color-scheme: dark) { :root }` is dark only.
      const themeContexts: ThemeContext[] = [];
      let hasDark = false;
      let hasLight = false;
      if (isThemeBridge) {
        themeContexts.push("theme-bridge");
      } else {
        for (const part of header.split(",")) {
          const partScope = `${enclosingAtRule ?? ""} ${part}`;
          const partDark = darkRes.some((re) => re.test(partScope));
          const partLight = lightRes.some((re) => re.test(partScope));
          hasDark ||= partDark;
          hasLight ||= partLight;
          if (partDark && !themeContexts.includes("dark")) themeContexts.push("dark");
          if (partLight && !themeContexts.includes("light")) themeContexts.push("light");
          if (
            !partDark &&
            !partLight &&
            /:root\b|(?:^|[\s,])html\b/i.test(part) &&
            !themeContexts.includes("root")
          ) {
            themeContexts.push("root");
          }
        }
      }

      // Scan `prop: value;` declarations inside `bodySlice`, splitting out nested rule blocks.
      const declarations: Array<{
        prop: string;
        value: string;
        lineNumber: number;
      }> = [];
      const ruleTokensConsumed: string[] = [];
      const nestedBlocks: Array<{ start: number; end: number }> = [];

      let declStart = 0;
      let parenDepth = 0;
      for (let k = 0; k <= bodySlice.length; k++) {
        const ch = k < bodySlice.length ? bodySlice[k] : ";";
        if (ch === "(") parenDepth++;
        else if (ch === ")" && parenDepth > 0) parenDepth--;
        else if (ch === "{" && parenDepth === 0) {
          let nestDepth = 1;
          let m = k + 1;
          while (m < bodySlice.length && nestDepth > 0) {
            if (bodySlice[m] === "{") nestDepth++;
            else if (bodySlice[m] === "}") nestDepth--;
            m++;
          }
          nestedBlocks.push({ start: declStart, end: m });
          k = m - 1;
          declStart = m;
          continue;
        } else if (ch === ";" && parenDepth === 0) {
          const rawDecl = bodySlice.slice(declStart, k);
          const colonIdx = rawDecl.indexOf(":");
          if (colonIdx > 0) {
            const prop = rawDecl.slice(0, colonIdx).trim();
            const value = rawDecl
              .slice(colonIdx + 1)
              .replace(/\s+/g, " ")
              .trim();
            const propOffset =
              bodyStartOffset + declStart + rawDecl.search(/\S/);
            const declLine = offsetToLineNumber(lineStarts, propOffset);
            const refs = [
              ...extractVarReferences(value),
              ...extractPreprocessorVarReferences(value, syntax),
            ];
            const fallbackNames = extractVarFallbackNames(value);

            for (const refName of refs) {
              varReferences.push({
                name: refName,
                filePath,
                lineNumber: declLine,
                snippet: getLineSnippet(rawLines, declLine),
                kind: "css-var",
                ...(fallbackNames.has(refName) ? { hasFallback: true } : {}),
              });
              if (!ruleTokensConsumed.includes(refName)) {
                ruleTokensConsumed.push(refName);
              }
            }

            if (prop.startsWith("--") || isPreprocTokenProp(prop)) {
              const cleanedTokenValue = cleanPreprocFlags(value);
              const contextsToEmit: ThemeContext[] =
                themeContexts.length > 0 ? themeContexts : ["root"];
              for (const ctx of contextsToEmit) {
                tokenDeclarations.push({
                  name: prop,
                  value: cleanedTokenValue,
                  tier: isGlobal
                    ? classifyTokenTier(prop, ctx === "theme-bridge", options.tiers)
                    : "component",
                  themeContext: ctx,
                  selector: enclosingAtRule
                    ? `${enclosingAtRule} ${header}`
                    : header,
                  filePath,
                  lineNumber: declLine,
                  referencedVars: refs,
                  scope: isGlobal ? "global" : "scoped",
                });
              }
            } else {
              const propLower = prop.toLowerCase();
              declarations.push({
                prop: propLower,
                value,
                lineNumber: declLine,
              });
              if (!NON_LITERAL_PROPS.has(propLower)) {
                const snippet = getLineSnippet(rawLines, declLine);
                for (const c of extractColorLiterals(value)) {
                  literals.push({
                    kind: "color",
                    value: c,
                    surface: "css-rule",
                    context: propLower,
                    filePath,
                    lineNumber: declLine,
                    snippet,
                  });
                }
                if (isLengthSensitiveProperty(propLower)) {
                  for (const l of extractLengthLiterals(value)) {
                    literals.push({
                      kind: "length",
                      value: l,
                      surface: "css-rule",
                      context: propLower,
                      filePath,
                      lineNumber: declLine,
                      snippet,
                    });
                  }
                }
              }
            }
          }
          declStart = k + 1;
        }
      }

      if (!isThemeBridge && !hasRoot && !hasDark && !hasLight) {
        const classesInSelector: string[] = [];
        for (const m of header.matchAll(CLASS_IN_SELECTOR_RE)) {
          if (m[1] && !classesInSelector.includes(m[1])) {
            classesInSelector.push(m[1]);
          }
        }
        styleRules.push({
          selector: header.replace(/\s+/g, " "),
          filePath,
          lineNumber: headerLine,
          declarations,
          classesInSelector,
          tokensConsumed: ruleTokensConsumed,
        });
      }

      for (const nb of nestedBlocks) {
        parseBlocks(
          bodySlice.slice(nb.start, nb.end),
          bodyStartOffset + nb.start,
          enclosingAtRule,
          header
        );
      }

      i = j;
    }
  };

  parseBlocks(cleaned, 0);

  return {
    filePath,
    tokenDeclarations,
    varReferences,
    styleRules,
    literals,
  };
}

// ---------------------------------------------------------------------------
// 3. WCAG 2.1 Color & Theme Contrast Engine (`dark` vs `light`, or single-theme `root`)
// ---------------------------------------------------------------------------

export {
  computeRelativeLuminance,
  computeWcagContrastRatio,
  parseCssColorString,
  type RgbaColor,
};

const CANVAS_TOKEN_PROBES = [
  "--background",
  "--color-background",
  "--bg",
  "--surface-canvas",
  "--surface",
  "--color-bg",
];

const VAR_EXPR_RE =
  /var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;

/** Resolves `var(--x)` chains textually; returns `null` when a token has no value and no fallback. */
function substituteVars(
  value: string,
  themeMap: Map<string, CssTokenDeclaration>,
  rootMap: Map<string, CssTokenDeclaration>,
  bridgeMap: Map<string, CssTokenDeclaration> = new Map(),
  depth = 0
): string | null {
  if (depth > 8) return null;
  let failed = false;
  const out = value.replace(VAR_EXPR_RE, (_m, name: string, fallback?: string) => {
    const decl = themeMap.get(name) ?? rootMap.get(name) ?? bridgeMap.get(name);
    if (decl) {
      const resolved = substituteVars(decl.value, themeMap, rootMap, bridgeMap, depth + 1);
      if (resolved !== null) return resolved;
    }
    if (fallback !== undefined && fallback.trim() !== "") {
      const fb = substituteVars(fallback.trim(), themeMap, rootMap, bridgeMap, depth + 1);
      if (fb !== null) return fb;
    }
    failed = true;
    return "";
  });
  return failed ? null : out.trim();
}

const BARE_HSL_RE = /^-?\d*\.?\d+(?:deg)?\s+-?\d*\.?\d+%\s+-?\d*\.?\d+%(?:\s*\/\s*[\d.%]+)?$/;

/** shadcn-style bare HSL triplets (`--background: 0 0% 100%`) are colors consumed as `hsl(var(--background))`. */
function normalizeBareHsl(value: string): string {
  return BARE_HSL_RE.test(value.trim()) ? `hsl(${value.trim()})` : value;
}

type TokenColorResolution =
  | { ok: true; color: RgbaColor }
  | { ok: false; reason: "undefined" | "unsupported"; detail?: string };

const TW_ALPHA_RE = /^--alpha\(\s*(.+)\s*\/\s*([\d.]+)(%?)\s*\)$/i;

function resolveThemeTokenColor(
  tokenName: string,
  themeMap: Map<string, CssTokenDeclaration>,
  rootMap: Map<string, CssTokenDeclaration>,
  bridgeMap: Map<string, CssTokenDeclaration> = new Map()
): TokenColorResolution {
  if (!themeMap.has(tokenName) && !rootMap.has(tokenName) && !bridgeMap.has(tokenName)) {
    return { ok: false, reason: "undefined" };
  }
  const decl = (themeMap.get(tokenName) ?? rootMap.get(tokenName) ?? bridgeMap.get(tokenName))!;
  const substituted = substituteVars(decl.value, themeMap, rootMap, bridgeMap);
  if (substituted === null) {
    return { ok: false, reason: "unsupported", detail: `unresolvable var() in "${decl.value}"` };
  }
  const alphaMatch = TW_ALPHA_RE.exec(substituted);
  if (alphaMatch) {
    const innerColor = parseCssColorString(normalizeBareHsl(alphaMatch[1]));
    const rawFactor = Number(alphaMatch[2]);
    if (!innerColor || !Number.isFinite(rawFactor)) {
      return { ok: false, reason: "unsupported", detail: `"${substituted.slice(0, 60)}"` };
    }
    const factor = Math.max(0, Math.min(1, alphaMatch[3] === "%" ? rawFactor / 100 : rawFactor));
    return { ok: true, color: { ...innerColor, a: innerColor.a * factor } };
  }
  const color = parseCssColorString(normalizeBareHsl(substituted));
  if (!color) {
    return { ok: false, reason: "unsupported", detail: `"${substituted.slice(0, 60)}"` };
  }
  return { ok: true, color };
}

export interface TailwindClassPairCandidate {
  fgSlug: string;
  bgSlug: string;
  filePath?: string;
  lineNumber?: number;
}

export interface ContrastEvaluationOptions {
  pairs?: Array<{ fg: string; bg: string; label?: string; minRatio?: number }>;
  minRatio?: number;
  discoverFromRules?: boolean;
  discoverFromNaming?: boolean;
  discoverFromTailwindClasses?: boolean;
  tailwindClassPairs?: TailwindClassPairCandidate[];
  canvasToken?: string;
}

export interface ContrastEvaluation {
  audits: ContrastAuditItem[];
  unresolved: ContrastUnresolvedItem[];
}

type PairDiscovery = "config" | "rule" | "naming" | "tailwind-jsx";

const BARE_VAR_REF_RE = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/;

export function evaluateContrast(
  tokenDeclarations: CssTokenDeclaration[],
  styleRules: ParsedCssRule[],
  options: ContrastEvaluationOptions = {}
): ContrastEvaluation {
  const minRatio = options.minRatio ?? 4.5;
  const rootMap = new Map<string, CssTokenDeclaration>();
  const darkMap = new Map<string, CssTokenDeclaration>();
  const lightMap = new Map<string, CssTokenDeclaration>();
  const bridgeMap = new Map<string, CssTokenDeclaration>();

  for (const decl of tokenDeclarations) {
    if (decl.scope === "scoped") continue;
    if (decl.themeContext === "root") rootMap.set(decl.name, decl);
    else if (decl.themeContext === "dark") darkMap.set(decl.name, decl);
    else if (decl.themeContext === "light") lightMap.set(decl.name, decl);
    else if (decl.themeContext === "theme-bridge") bridgeMap.set(decl.name, decl);
  }

  const definedNames = new Set<string>([
    ...rootMap.keys(),
    ...darkMap.keys(),
    ...lightMap.keys(),
  ]);
  const allKnownTokenNames = new Set<string>([
    ...definedNames,
    ...bridgeMap.keys(),
  ]);
  const knownLowerToCanonical = new Map<string, string>();
  for (const n of allKnownTokenNames) {
    if (!knownLowerToCanonical.has(n.toLowerCase())) {
      knownLowerToCanonical.set(n.toLowerCase(), n);
    }
  }

  /**
   * Collapses pure `@theme` pass-through bridge aliases (`--color-foo: var(--foo)`) onto the
   * underlying semantic `--foo` token so bridged pairs never duplicate `:root` naming pairs,
   * while preserving semantic bridge tokens whose targets differ (`--color-band: var(--yellow-9)`).
   */
  const canonicalizeBridgeToken = (tokenName: string): string => {
    if (definedNames.has(tokenName)) return tokenName;
    const bridgeDecl = bridgeMap.get(tokenName);
    if (!bridgeDecl || !tokenName.toLowerCase().startsWith("--color-")) return tokenName;
    const m = BARE_VAR_REF_RE.exec(bridgeDecl.value.trim());
    if (!m) return tokenName;
    const target = knownLowerToCanonical.get(m[1].toLowerCase()) ?? m[1];
    const stem = tokenName.slice("--color-".length);
    if (
      definedNames.has(target) &&
      target.toLowerCase() === `--${stem.toLowerCase()}`
    ) {
      return target;
    }
    return tokenName;
  };

  const pairs: Array<{
    pairId: string;
    fg: string;
    bg: string;
    label: string;
    minRatio: number;
    discovery: PairDiscovery;
  }> = [];
  const seen = new Set<string>();
  const addPair = (
    fg: string,
    bg: string,
    label: string,
    discovery: PairDiscovery,
    pairMin?: number,
    pairId?: string
  ) => {
    const key = `${fg}::${bg}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({
      pairId: pairId ?? `${discovery}:${fg}-on-${bg}`,
      fg,
      bg,
      label,
      minRatio: pairMin ?? minRatio,
      discovery,
    });
  };

  for (const p of options.pairs ?? []) {
    addPair(p.fg, p.bg, p.label ?? `${p.fg} on ${p.bg}`, "config", p.minRatio, `config:${p.fg}-on-${p.bg}`);
  }

  if (options.discoverFromRules !== false) {
    for (const rule of styleRules) {
      let fgVar: string | undefined;
      let bgVar: string | undefined;
      for (const d of rule.declarations) {
        if (d.prop === "color") {
          const m = d.value.match(/^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/);
          if (m) fgVar = m[1];
        } else if (d.prop === "background" || d.prop === "background-color") {
          const m = d.value.match(/^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/);
          if (m) bgVar = m[1];
        }
      }
      if (fgVar && bgVar) {
        addPair(
          fgVar,
          bgVar,
          `CSS rule '${rule.selector}' (${fgVar} on ${bgVar})`,
          "rule",
          undefined,
          `rule:${rule.selector}:${fgVar}-on-${bgVar}`
        );
      }
    }
  }

  if (options.discoverFromNaming !== false) {
    for (const name of [...allKnownTokenNames].sort()) {
      const lower = name.toLowerCase();
      let fgCandidate: string | undefined;
      let bgCandidates: string[] = [];

      const suffix = lower.match(/^(--.+)-(?:foreground|fg|contrast)$/);
      const onMatch = !suffix ? lower.match(/^(.*-)on-(.+)$/) : null;
      const surfaceMatch = !suffix && !onMatch ? lower.match(/^(--.+)-surface$/) : null;

      if (lower === "--foreground") {
        fgCandidate = name;
        bgCandidates = ["--background"];
      } else if (suffix) {
        fgCandidate = name;
        bgCandidates = [suffix[1]];
      } else if (onMatch) {
        fgCandidate = name;
        bgCandidates = [
          `${onMatch[1]}${onMatch[2]}`,
          ...(onMatch[1] === "--" ? [`--color-${onMatch[2]}`] : []),
        ];
      } else if (surfaceMatch) {
        const fgMatch = knownLowerToCanonical.get(surfaceMatch[1]);
        if (fgMatch) {
          const canonFg = canonicalizeBridgeToken(fgMatch);
          const canonBg = canonicalizeBridgeToken(name);
          if (canonFg !== canonBg) {
            addPair(canonFg, canonBg, `${canonFg} on ${canonBg} (naming convention)`, "naming");
          }
        }
        continue;
      }

      if (!fgCandidate) continue;
      for (const candidateBg of bgCandidates) {
        const resolvedBg = knownLowerToCanonical.get(candidateBg.toLowerCase());
        if (resolvedBg) {
          const canonFg = canonicalizeBridgeToken(fgCandidate);
          const canonBg = canonicalizeBridgeToken(resolvedBg);
          if (canonFg !== canonBg) {
            addPair(canonFg, canonBg, `${canonFg} on ${canonBg} (naming convention)`, "naming");
          }
          break;
        }
      }
    }
  }

  const hasDark = darkMap.size > 0;
  const hasLight = lightMap.size > 0;
  // The default theme (`root`, or an explicit `light` override map) is always evaluated; `dark` only when the repo declares one.
  const themes: Array<{ key: "root" | "dark" | "light"; map: Map<string, CssTokenDeclaration> }> = [
    hasLight ? { key: "light", map: lightMap } : { key: "root", map: rootMap },
    ...(hasDark ? [{ key: "dark" as const, map: darkMap }] : []),
  ];

  const unresolvedTailwindCandidates = new Map<string, ContrastUnresolvedItem>();
  if (options.discoverFromTailwindClasses !== false && options.tailwindClassPairs?.length) {
    const resolveTwToken = (slug: string, role: "fg" | "bg"): string | undefined => {
      const candidates =
        bridgeMap.size > 0
          ? role === "fg"
            ? [`--text-color-${slug}`, `--color-${slug}`]
            : [`--background-color-${slug}`, `--color-${slug}`]
          : [`--color-${slug}`, `--${slug}`];
      for (const c of candidates) {
        const found = knownLowerToCanonical.get(c.toLowerCase());
        if (found) return found;
      }
      return undefined;
    };

    for (const tw of options.tailwindClassPairs) {
      const rawFg = resolveTwToken(tw.fgSlug, "fg");
      const rawBg = resolveTwToken(tw.bgSlug, "bg");
      if (rawFg && rawBg) {
        const canonFg = canonicalizeBridgeToken(rawFg);
        const canonBg = canonicalizeBridgeToken(rawBg);
        if (canonFg !== canonBg) {
          addPair(
            canonFg,
            canonBg,
            `JSX classes 'text-${tw.fgSlug} bg-${tw.bgSlug}' (${canonFg} on ${canonBg})`,
            "tailwind-jsx",
            undefined,
            `tailwind:${canonFg}-on-${canonBg}`
          );
        }
      } else if (rawFg || rawBg) {
        const canonFg = rawFg ? canonicalizeBridgeToken(rawFg) : `--color-${tw.fgSlug}`;
        const canonBg = rawBg ? canonicalizeBridgeToken(rawBg) : `--color-${tw.bgSlug}`;
        const bareKey = `--${tw.fgSlug}::--${tw.bgSlug}`;
        const directKey = `${canonFg}::${canonBg}`;
        if (!seen.has(bareKey) && !seen.has(directKey)) {
          const pairId = `tailwind:text-${tw.fgSlug}-on-bg-${tw.bgSlug}`;
          if (!unresolvedTailwindCandidates.has(pairId)) {
            unresolvedTailwindCandidates.set(pairId, {
              pairId,
              foregroundToken: canonFg,
              backgroundToken: canonBg,
              theme: hasLight ? "light" : "root",
              reason: rawFg ? "background-unresolved" : "foreground-unresolved",
              detail: `Tailwind utility '${rawFg ? `bg-${tw.bgSlug}` : `text-${tw.fgSlug}`}' has no matching token in ${bridgeMap.size > 0 ? "@theme" : "stylesheets"}`,
            });
          }
        }
      }
    }
  }

  const probe = [options.canvasToken, ...CANVAS_TOKEN_PROBES].filter(
    (t): t is string => Boolean(t)
  );
  const canvasFor = (themeMap: Map<string, CssTokenDeclaration>): RgbaColor | null => {
    for (const t of probe) {
      const r = resolveThemeTokenColor(t, themeMap, rootMap, bridgeMap);
      if (r.ok && r.color.a >= 0.999) return r.color;
    }
    return null;
  };

  const audits: ContrastAuditItem[] = [];
  const unresolved: ContrastUnresolvedItem[] = [...unresolvedTailwindCandidates.values()];

  for (const pair of pairs) {
    const fgKnown = allKnownTokenNames.has(pair.fg);
    const bgKnown = allKnownTokenNames.has(pair.bg);
    if (pair.discovery !== "config" && (!fgKnown || !bgKnown)) continue;

    const results: Partial<Record<"root" | "dark" | "light", NonNullable<ContrastAuditItem["dark"]>>> = {};
    let anyEvaluated = false;

    for (const theme of themes) {
      const fgRes = resolveThemeTokenColor(pair.fg, theme.map, rootMap, bridgeMap);
      const bgRes = resolveThemeTokenColor(pair.bg, theme.map, rootMap, bridgeMap);
      const report = (
        reason: ContrastUnresolvedItem["reason"],
        detail?: string
      ) => {
        unresolved.push({
          pairId: pair.pairId,
          foregroundToken: pair.fg,
          backgroundToken: pair.bg,
          theme: theme.key,
          reason,
          ...(detail ? { detail } : {}),
        });
      };
      if (!fgRes.ok) {
        report(
          fgRes.reason === "undefined" ? "foreground-unresolved" : "unsupported-color-syntax",
          fgRes.reason === "unsupported" ? fgRes.detail : undefined
        );
        continue;
      }
      if (!bgRes.ok) {
        report(
          bgRes.reason === "undefined" ? "background-unresolved" : "unsupported-color-syntax",
          bgRes.reason === "unsupported" ? bgRes.detail : undefined
        );
        continue;
      }
      let bg = bgRes.color;
      if (bg.a < 0.999) {
        const canvas = canvasFor(theme.map);
        if (!canvas) {
          report("background-translucent-without-base");
          continue;
        }
        bg = compositeOver(bg, canvas);
      }
      const fg = compositeOver(fgRes.color, bg);
      const ratio = computeWcagContrastRatio(fg, bg);
      results[theme.key] = {
        fgHex: rgbaToHex(fg),
        bgHex: rgbaToHex(bg),
        ratio,
        passes: ratio >= pair.minRatio,
      };
      anyEvaluated = true;
    }

    if (!anyEvaluated) continue;

    const evaluated = Object.values(results);
    const passesAll = evaluated.every((r) => r.passes);
    const primaryDecl =
      (results.light && !results.light.passes
        ? lightMap.get(pair.fg) ?? lightMap.get(pair.bg)
        : undefined) ??
      darkMap.get(pair.fg) ??
      rootMap.get(pair.fg) ??
      bridgeMap.get(pair.fg) ??
      darkMap.get(pair.bg) ??
      rootMap.get(pair.bg) ??
      bridgeMap.get(pair.bg);

    audits.push({
      pairId: pair.pairId,
      foregroundToken: pair.fg,
      backgroundToken: pair.bg,
      contextLabel: pair.label,
      minRequiredRatio: pair.minRatio,
      ...(results.dark ? { dark: results.dark } : {}),
      ...(results.light ? { light: results.light } : {}),
      ...(results.root ? { root: results.root } : {}),
      passesAll,
      ...(primaryDecl
        ? { filePath: primaryDecl.filePath, lineNumber: primaryDecl.lineNumber }
        : {}),
    });
  }

  return { audits, unresolved };
}

/** Back-compat wrapper returning only evaluated audits. */
export function evaluateThemeContrastPairs(
  tokenDeclarations: CssTokenDeclaration[],
  styleRules: ParsedCssRule[],
  options?: ContrastEvaluationOptions
): ContrastAuditItem[] {
  return evaluateContrast(tokenDeclarations, styleRules, options).audits;
}

// ---------------------------------------------------------------------------
// 4. AST Component Styling, Tailwind, & Canvas Provenance Scanner
// ---------------------------------------------------------------------------

const TAILWIND_UTILITY_RE =
  /^(flex|inline-flex|grid|block|inline-block|hidden|items-|justify-|content-|self-|gap-|space-[xy]-|p[xytblr]?-|m[xytblr]?-|w-|h-|min-[wh]-|max-[wh]-|text-|font-|leading-|tracking-|bg-|border|rounded|shadow|opacity-|z-|relative|absolute|fixed|sticky|inset-|top-|right-|bottom-|left-|overflow-|cursor-|select-|pointer-events-|transition|duration-|ease-|hover:|focus:|active:|disabled:|backdrop-)/;

const ARBITRARY_TW_RE = /\b([a-zA-Z0-9_:-]+-\[[^\]]+\])/g;
/**
 * Candidate raw palette utilities (`bg-yellow-9`, `text-slate-700`). Whether one is *drift* depends on
 * the repo's own system (derived primitive palettes / config), so it is decided in the analysis stage.
 */
const PALETTE_TW_RE =
  /\b(?:[a-z0-9-]+:)*(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|divide|accent|caret|shadow)-([a-z][a-z-]*?)-(\d{1,4})(?:\/\d+)?(?![\w-])/g;

/** Tailwind's built-in color palette names (a Tailwind fact, not a repo convention). */
const TAILWIND_DEFAULT_PALETTES = new Set([
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime",
  "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia",
  "pink", "rose",
]);

/** Class-composition helpers whose string arguments are class lists. */
const CLASS_HELPER_CALLEES = new Set([
  "cva", "tv", "clsx", "cn", "twMerge", "classNames", "classnames", "cx", "twJoin",
]);

const CSS_IN_JS_MODULES = [
  "styled-components",
  "@emotion/styled",
  "@emotion/react",
  "@emotion/css",
  "@mui/material",
  "@mui/system",
  "@chakra-ui/react",
  "@mantine/core",
  "theme-ui",
  "@stitches/react",
  "@vanilla-extract/css",
  "@linaria/core",
  "goober",
];

export interface ScanOptions {
  /** Class names defined in the repo's own stylesheets (derived; replaces any hardcoded prefix). */
  knownCssClasses?: ReadonlySet<string>;
  /** Extra class-name prefixes that always count as stylesheet classes. */
  cssClassPrefixes?: readonly string[];
  /** Atom catalog used to detect raw DOM elements that should be shared atoms. */
  atomDefinitions?: readonly AtomDefinition[];
  /** Regex source: props matching it must not receive raw color literals. */
  colorPropPattern?: string;
  /** Factory function names that create a canvas slot recorder (e.g. a theme-aware PixiJS recorder). Empty = no canvas-slot provenance. */
  canvasSlotRecorderFactories?: readonly string[];
  /** Helper names whose call result is a token-sourced canvas value (counted as "css" slots). */
  canvasCssValueHelpers?: readonly string[];
  /** Helper names whose first string-literal `--token` argument reads a CSS token onto canvas (e.g. `readColor`). */
  canvasTokenReaderHelpers?: readonly string[];
}

function classifyArbitraryTailwindCategory(
  cls: string
): ArbitraryTailwindOccurrence["category"] {
  const base = cls.split(":").pop() ?? cls;
  if (/^(text|font|leading|tracking)-/.test(base)) return "typography";
  if (/^(w|h|min-w|min-h|max-w|max-h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|top|right|bottom|left|inset)-/.test(base)) {
    return "spacing-sizing";
  }
  if (/^(rounded|border)-/.test(base)) return "radius-border";
  if (/^stroke-\[([^\]]+)\]$/.test(base)) {
    const inner = base.match(/^stroke-\[([^\]]+)\]$/)?.[1]?.trim() ?? "";
    if (/^-?\d+(\.\d+)?(px|rem|em|%)?$/.test(inner)) {
      return "radius-border";
    }
  }
  if (/^(bg|from|via|to|ring|fill|stroke)-/.test(base)) return "color";
  return "layout";
}

/** Does the element described by (tag, role, className, attrs) match this atom matcher? */
function atomMatcherHits(
  m: AtomMatcher,
  tagName: string,
  roleAttr: string | undefined,
  classAttr: string,
  getAttr: (name: string) => string | undefined
): boolean {
  if (m.tag !== undefined) {
    const tags = Array.isArray(m.tag) ? m.tag : [m.tag];
    if (!tags.includes(tagName)) return false;
  }
  if (m.role !== undefined && m.role !== roleAttr) return false;
  if (m.classPattern !== undefined) {
    try {
      if (!new RegExp(m.classPattern, "i").test(classAttr)) return false;
    } catch {
      return false;
    }
  }
  if (m.attrs) {
    for (const [k, v] of Object.entries(m.attrs)) {
      if (getAttr(k) !== v) return false;
    }
  }
  return (
    m.tag !== undefined ||
    m.role !== undefined ||
    m.classPattern !== undefined ||
    m.attrs !== undefined
  );
}

const SVG_PRIMITIVE_TAGS = new Set([
  "svg",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "g",
  "defs",
  "clipPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "mask",
  "pattern",
  "use",
  "symbol",
  "ellipse",
]);

const STATE_HOOK_NAMES = new Set([
  "useState",
  "useReducer",
  "useContext",
  "useSyncExternalStore",
  "useStore",
  "useSignal",
  "React.useState",
  "React.useReducer",
  "React.useContext",
]);

interface ScannedFileAstResult {
  filePath: string;
  definedFontVars: Array<{ name: string; lineNumber: number; scope?: "global" | "scoped" }>;
  tokenReferences: TokenReferenceOccurrence[];
  cssImports: string[];
  /** Co-occurring Tailwind `bg-*` / `text-*` class pairs observed on the same JSX element or class string. */
  tailwindClassPairs: TailwindClassPairCandidate[];
  /** Every import specifier in the file (used for composability checks). */
  importedModules: string[];
  /** Local identifier -> `(specifier, importedName)` import bindings for deterministic component linking. */
  importedBindings: Map<string, { specifier: string; importedName: string }>;
  /** Barrel re-exports (`export { Card } from "./Card"`, `export * from "./Card"`). */
  reExports: Array<{ exportedName: string; sourceName: string; specifier: string }>;
  /** File-level `cva()`/`tv()` variant axes: axis → values. */
  variantAxes: Record<string, string[]>;
  functionsAndClasses: Map<
    string,
    {
      name: string;
      lineNumber: number;
      endLineNumber: number;
      isExported: boolean;
      jsxDomElementCount: number;
      jsxCustomComponentCount: number;
      stateHookCount: number;
      propContract: ComponentPropSignature[];
      jsxCallSites: JsxCallSiteRecord[];
      jsxSkeletons: JsxSkeletonOccurrence[];
      stylingConventions: Set<StylingConvention>;
      cssClassesUsed: Set<string>;
      dynamicClassPrefixes: Set<string>;
      tokensConsumed: Set<string>;
      arbitraryTailwind: ArbitraryTailwindOccurrence[];
      primitiveScaleSkips: PrimitiveScaleSkipOccurrence[];
      inlineStyleLiterals: InlineStyleLiteralOccurrence[];
      usesSlotRecorder: boolean;
      canvasCssCount: number;
      canvasTsConstCount: number;
      canvasLiteralCount: number;
      canvasLiterals: CanvasLiteralOccurrence[];
      rawDomPrimitives: RawDomPrimitiveOccurrence[];
      renderedComponents: Set<string>;
      /** Raw palette utility candidates; classified as drift or not in the analysis stage. */
      paletteClassCandidates: Array<{
        className: string;
        palette: string;
        step: string;
        filePath: string;
        lineNumber: number;
        snippet: string;
      }>;
      /** `var(--x)` references found in string literals (for primitive-token-in-component checks). */
      tsTokenRefs: TokenReferenceOccurrence[];
      literalValues: LiteralValueOccurrence[];
      domTags: Set<string>;
      invariantViolations: InvariantViolation[];
      /** Non-arbitrary Tailwind utilities (theme-routed styling decisions). */
      tailwindUtilityCount: number;
      rootElement?: {
        tag: string;
        classes: string;
        styleProps: Record<string, string>;
        lineNumber: number;
        snippet: string;
      };
    }
  >;
}

const NON_TRIVIAL_INLINE_STYLE_PROPS = new Set([
  "color",
  "background",
  "backgroundColor",
  "border",
  "borderColor",
  "borderRadius",
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "fontSize",
  "fontFamily",
  "boxShadow",
  "gap",
]);

const NON_COLOR_TEXT_SLUGS = new Set([
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl",
  "left", "center", "right", "justify", "start", "end",
  "wrap", "nowrap", "balance", "pretty",
  "ellipsis", "clip",
  "transparent", "current", "inherit",
]);

const NON_COLOR_BG_SLUGS = new Set([
  "none", "auto", "cover", "contain",
  "center", "top", "bottom", "left", "right",
  "left-top", "left-bottom", "right-top", "right-bottom",
  "repeat", "no-repeat", "repeat-x", "repeat-y", "repeat-round", "repeat-space",
  "fixed", "local", "scroll",
  "transparent", "current", "inherit",
]);

const NON_COLOR_BG_PREFIXES = [
  "clip-", "origin-", "gradient-", "linear-", "radial-", "conic-", "size-", "position-",
];

function isDefaultTailwindPaletteSlug(slug: string): boolean {
  if (slug === "white" || slug === "black") return true;
  const m = /^([a-z-]+)-(\d{1,4})$/.exec(slug);
  return Boolean(m && TAILWIND_DEFAULT_PALETTES.has(m[1]));
}

function extractColorUtilitySlugsFromTokens(tokens: readonly string[]): Map<string, { bg: string[]; fg: string[] }> {
  const byVariant = new Map<string, { bg: string[]; fg: string[] }>();
  for (const tok of tokens) {
    const colonIdx = tok.lastIndexOf(":");
    const variant = colonIdx >= 0 ? tok.slice(0, colonIdx) : "";
    const base = colonIdx >= 0 ? tok.slice(colonIdx + 1) : tok;
    if (base.startsWith("bg-")) {
      const slug = base.slice(3);
      if (
        !slug ||
        slug.includes("[") ||
        slug.includes("/") ||
        NON_COLOR_BG_SLUGS.has(slug) ||
        NON_COLOR_BG_PREFIXES.some((p) => slug.startsWith(p)) ||
        isDefaultTailwindPaletteSlug(slug)
      ) {
        continue;
      }
      let bucket = byVariant.get(variant);
      if (!bucket) {
        bucket = { bg: [], fg: [] };
        byVariant.set(variant, bucket);
      }
      if (!bucket.bg.includes(slug)) bucket.bg.push(slug);
    } else if (base.startsWith("text-")) {
      const slug = base.slice(5);
      if (
        !slug ||
        slug.includes("[") ||
        slug.includes("/") ||
        NON_COLOR_TEXT_SLUGS.has(slug) ||
        isDefaultTailwindPaletteSlug(slug)
      ) {
        continue;
      }
      let bucket = byVariant.get(variant);
      if (!bucket) {
        bucket = { bg: [], fg: [] };
        byVariant.set(variant, bucket);
      }
      if (!bucket.fg.includes(slug)) bucket.fg.push(slug);
    }
  }
  return byVariant;
}

function collectClassTokenBranches(expr: ts.Expression): string[][] {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return [expr.text.split(/\s+/).filter(Boolean)];
  }
  if (ts.isTemplateExpression(expr)) {
    const base: string[] = expr.head.text.split(/\s+/).filter(Boolean);
    let branches: string[][] = [base];
    for (const span of expr.templateSpans) {
      const subBranches = collectClassTokenBranches(span.expression);
      const tailTokens = span.literal.text.split(/\s+/).filter(Boolean);
      const next: string[][] = [];
      for (const prefix of branches) {
        for (const sub of subBranches) {
          next.push([...prefix, ...sub, ...tailTokens]);
          if (next.length >= 4) break;
        }
        if (next.length >= 4) break;
      }
      branches = next;
    }
    return branches;
  }
  if (ts.isParenthesizedExpression(expr)) {
    return collectClassTokenBranches(expr.expression);
  }
  if (ts.isConditionalExpression(expr)) {
    return [
      ...collectClassTokenBranches(expr.whenTrue),
      ...collectClassTokenBranches(expr.whenFalse),
    ].slice(0, 4);
  }
  if (ts.isBinaryExpression(expr)) {
    if (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return [[], ...collectClassTokenBranches(expr.right)].slice(0, 4);
    }
    if (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return [
        ...collectClassTokenBranches(expr.left),
        ...collectClassTokenBranches(expr.right),
      ].slice(0, 4);
    }
  }
  if (ts.isCallExpression(expr)) {
    let combined: string[][] = [[]];
    for (const arg of expr.arguments) {
      const argBranches = collectClassTokenBranches(arg);
      if (argBranches.every((b) => b.length === 0)) continue;
      const next: string[][] = [];
      for (const cur of combined) {
        for (const ab of argBranches) {
          next.push([...cur, ...ab]);
          if (next.length >= 4) break;
        }
        if (next.length >= 4) break;
      }
      combined = next;
    }
    return combined;
  }
  return [[]];
}

export function scanTsxOrTsFile(
  filePath: string,
  sourceText: string,
  scanOptions: ScanOptions = {}
): ScannedFileAstResult {
  const knownCssClasses = scanOptions.knownCssClasses;
  const cssClassPrefixes = scanOptions.cssClassPrefixes ?? [];
  const atomDefinitions = scanOptions.atomDefinitions ?? DEFAULT_ATOM_CATALOG;
  const colorPropRe = (() => {
    try {
      return new RegExp(
        scanOptions.colorPropPattern ?? DEFAULT_DESIGN_SYSTEM_CONFIG.invariants.colorPropPattern
      );
    } catch {
      return new RegExp(DEFAULT_DESIGN_SYSTEM_CONFIG.invariants.colorPropPattern);
    }
  })();
  const slotRecorderFactories = scanOptions.canvasSlotRecorderFactories ?? [];
  const canvasCssValueHelpers = scanOptions.canvasCssValueHelpers ?? [];
  const canvasTokenReaderHelpers = scanOptions.canvasTokenReaderHelpers ?? [];
  const isKnownCssClass = (tok: string): boolean =>
    Boolean(knownCssClasses?.has(tok)) || cssClassPrefixes.some((p) => tok.startsWith(p));

  const scriptKind =
    filePath.endsWith(".tsx") || isPreprocessedUiComponentFile(filePath)
      ? ts.ScriptKind.TSX
      : /\.(jsx|js|mjs|cjs)$/i.test(filePath)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const rawLines = sourceText.split(/\r?\n/);
  const getLine = (pos: number) =>
    sf.getLineAndCharacterOfPosition(pos).line + 1;

  const definedFontVars: Array<{
    name: string;
    lineNumber: number;
    scope?: "global" | "scoped";
  }> = [];
  const tokenReferences: TokenReferenceOccurrence[] = [];
  const cssImports: string[] = [];
  const tailwindClassPairs: TailwindClassPairCandidate[] = [];
  const seenLocalTwPairs = new Set<string>();
  const recordTailwindClassBranches = (branches: string[][], lineNumber: number) => {
    for (const tokens of branches) {
      if (tokens.length < 2) continue;
      const byVariant = extractColorUtilitySlugsFromTokens(tokens);
      for (const { bg, fg } of byVariant.values()) {
        for (const fgSlug of fg) {
          for (const bgSlug of bg) {
            const key = `${fgSlug}::${bgSlug}`;
            if (!seenLocalTwPairs.has(key)) {
              seenLocalTwPairs.add(key);
              tailwindClassPairs.push({ fgSlug, bgSlug, filePath, lineNumber });
            }
          }
        }
      }
    }
  };
  const functionsAndClasses: ScannedFileAstResult["functionsAndClasses"] =
    new Map();

  // Index top-level interfaces & type aliases so component prop contracts can be resolved,
  // and collect import metadata (PixiJS, CSS Modules, CSS-in-JS, every specifier).
  const typeMembersByName = new Map<string, ts.NodeArray<ts.TypeElement>>();
  const typeExtendsByName = new Map<string, string[]>();
  const typeAliasNodeByName = new Map<string, ts.TypeNode>();
  const importedModules: string[] = [];
  const importedBindings = new Map<string, { specifier: string; importedName: string }>();
  const reExports: Array<{ exportedName: string; sourceName: string; specifier: string }> = [];
  const cssModuleBindings = new Set<string>();
  const variantAxes: Record<string, string[]> = {};
  const consumedStringNodes = new Set<ts.Node>();
  let hasPixiImport = false;
  let hasCssInJs = false;
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      importedModules.push(spec);
      const clause = stmt.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) {
          importedBindings.set(clause.name.text, {
            specifier: spec,
            importedName: "default",
          });
        }
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              if (el.isTypeOnly) continue;
              importedBindings.set(el.name.text, {
                specifier: spec,
                importedName: (el.propertyName ?? el.name).text,
              });
            }
          } else if (ts.isNamespaceImport(clause.namedBindings)) {
            importedBindings.set(clause.namedBindings.name.text, {
              specifier: spec,
              importedName: "*",
            });
          }
        }
      }
      if (
        spec === "pixi.js" ||
        spec.startsWith("pixi.js/") ||
        spec === "pixi-viewport"
      ) {
        hasPixiImport = true;
      }
      if (CSS_IN_JS_MODULES.some((m) => spec === m || spec.startsWith(`${m}/`))) {
        hasCssInJs = true;
      }
      if (/\.module\.(?:css|scss|sass|less)$/.test(spec)) {
        if (clause?.name) cssModuleBindings.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          cssModuleBindings.add(clause.namedBindings.name.text);
        }
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      if (!stmt.exportClause) {
        reExports.push({ exportedName: "*", sourceName: "*", specifier: spec });
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.isTypeOnly) continue;
          reExports.push({
            exportedName: el.name.text,
            sourceName: (el.propertyName ?? el.name).text,
            specifier: spec,
          });
        }
      }
    }
    if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
      typeMembersByName.set(stmt.name.text, stmt.members);
      const ext: string[] = [];
      for (const h of stmt.heritageClauses ?? []) {
        if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const t of h.types) ext.push(t.expression.getText(sf));
      }
      typeExtendsByName.set(stmt.name.text, ext);
    } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
      typeAliasNodeByName.set(stmt.name.text, stmt.type);
      if (ts.isTypeLiteralNode(stmt.type)) {
        typeMembersByName.set(stmt.name.text, stmt.type.members);
      }
    }
  }

  /** String values of a literal union type (`"a" | "b"`), or undefined. */
  const literalUnionValues = (t: ts.TypeNode | undefined): string[] | undefined => {
    if (!t) return undefined;
    const node = ts.isParenthesizedTypeNode(t) ? t.type : t;
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
      return [node.literal.text];
    }
    if (ts.isUnionTypeNode(node)) {
      const vals: string[] = [];
      for (const part of node.types) {
        if (ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal)) {
          vals.push(part.literal.text);
        } else if (ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword) {
          continue;
        } else if (part.kind === ts.SyntaxKind.UndefinedKeyword) {
          continue;
        } else {
          return vals.length > 0 ? vals : undefined;
        }
      }
      return vals.length > 0 ? vals : undefined;
    }
    return undefined;
  };

  const collectPropsFromTypeNode = (
    typeNode: ts.TypeNode,
    into: Map<string, ComponentPropSignature>,
    visited: Set<string>
  ): void => {
    const addMembers = (members: ts.NodeArray<ts.TypeElement>) => {
      for (const m of members) {
        if (ts.isPropertySignature(m) && m.name) {
          const propName = m.name.getText(sf);
          const full = m.type ? m.type.getText(sf).replace(/\s+/g, " ").trim() : "unknown";
          const variants = literalUnionValues(m.type);
          into.set(propName, {
            name: propName,
            type: full.slice(0, 160),
            required: !m.questionToken,
            ...(variants ? { variants } : {}),
          });
        }
      }
    };
    const addByName = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const members = typeMembersByName.get(name);
      if (members) addMembers(members);
      for (const parent of typeExtendsByName.get(name) ?? []) addByName(parent);
      const alias = typeAliasNodeByName.get(name);
      if (alias && !ts.isTypeLiteralNode(alias)) collectPropsFromTypeNode(alias, into, visited);
    };
    if (ts.isTypeLiteralNode(typeNode)) {
      addMembers(typeNode.members);
    } else if (ts.isTypeReferenceNode(typeNode)) {
      addByName(typeNode.typeName.getText(sf));
    } else if (ts.isIntersectionTypeNode(typeNode)) {
      for (const part of typeNode.types) collectPropsFromTypeNode(part, into, visited);
    } else if (ts.isParenthesizedTypeNode(typeNode)) {
      collectPropsFromTypeNode(typeNode.type, into, visited);
    }
  };

  const extractPropContractFromFunc = (
    fn: ts.FunctionLikeDeclarationBase,
    fallbackPropsType?: ts.TypeNode
  ): ComponentPropSignature[] => {
    const propsMap = new Map<string, ComponentPropSignature>();
    const firstParam = fn.parameters[0];
    const declared = firstParam?.type ?? fallbackPropsType;
    if (declared) collectPropsFromTypeNode(declared, propsMap, new Set());

    if (firstParam && ts.isObjectBindingPattern(firstParam.name)) {
      for (const el of firstParam.name.elements) {
        if (ts.isIdentifier(el.name)) {
          const propName = (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text);
          const existing = propsMap.get(propName);
          if (existing) {
            if (el.initializer) existing.required = false;
          } else {
            propsMap.set(propName, {
              name: propName,
              type: "unknown",
              required: !el.initializer,
            });
          }
        }
      }
    }

    return [...propsMap.values()];
  };

  const ensureOwnerBucket = (
    name: string,
    lineNumber: number,
    endLineNumber: number,
    isExported: boolean
  ) => {
    let b = functionsAndClasses.get(name);
    if (!b) {
      b = {
        name,
        lineNumber,
        endLineNumber,
        isExported,
        jsxDomElementCount: 0,
        jsxCustomComponentCount: 0,
        stateHookCount: 0,
        propContract: [],
        jsxCallSites: [],
        jsxSkeletons: [],
        stylingConventions: new Set(),
        cssClassesUsed: new Set(),
        dynamicClassPrefixes: new Set(),
        tokensConsumed: new Set(),
        arbitraryTailwind: [],
        primitiveScaleSkips: [],
        inlineStyleLiterals: [],
        usesSlotRecorder: false,
        canvasCssCount: 0,
        canvasTsConstCount: 0,
        canvasLiteralCount: 0,
        canvasLiterals: [],
        rawDomPrimitives: [],
        renderedComponents: new Set(),
        paletteClassCandidates: [],
        tsTokenRefs: [],
        literalValues: [],
        domTags: new Set(),
        invariantViolations: [],
        tailwindUtilityCount: 0,
      };
      functionsAndClasses.set(name, b);
    }
    return b;
  };

  // Module-level fallback bucket for top-level constants (e.g. `PACKAGE_STYLES`, `CANVAS_THEME_SOURCES`)
  const moduleBucket = ensureOwnerBucket("__module__", 1, rawLines.length, true);

  const hasExportModifier = (node: ts.Node): boolean => {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return Boolean(
      mods?.some(
        (m) =>
          m.kind === ts.SyntaxKind.ExportKeyword ||
          m.kind === ts.SyntaxKind.DefaultKeyword
      )
    );
  };

  const inspectClassTokens = (
    rawClassStr: string,
    lineNumber: number,
    snippet: string,
    bucket: NonNullable<ReturnType<typeof ensureOwnerBucket>>
  ) => {
    const tokens = rawClassStr
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    for (const tok of tokens) {
      if (isKnownCssClass(tok)) {
        bucket.stylingConventions.add("css-classes");
        bucket.cssClassesUsed.add(tok);
      } else if (TAILWIND_UTILITY_RE.test(tok) || tok.includes("[")) {
        bucket.stylingConventions.add("tailwind");
        if (!tok.includes("[")) bucket.tailwindUtilityCount++;
      } else if (/^[a-z][a-z0-9_-]+$/i.test(tok)) {
        bucket.cssClassesUsed.add(tok);
      }
    }

    for (const m of rawClassStr.matchAll(ARBITRARY_TW_RE)) {
      const cls = m[1];
      if (!cls) continue;
      bucket.stylingConventions.add("tailwind");
      bucket.arbitraryTailwind.push({
        className: cls,
        category: classifyArbitraryTailwindCategory(cls),
        filePath,
        lineNumber,
        snippet,
      });
    }

    for (const m of rawClassStr.matchAll(PALETTE_TW_RE)) {
      const cls = m[0];
      if (!cls || !m[1] || !m[2]) continue;
      bucket.paletteClassCandidates.push({
        className: cls,
        palette: m[1],
        step: m[2],
        filePath,
        lineNumber,
        snippet,
      });
    }

    // Arbitrary values that are design decisions (`bg-[#fff]`, `p-[13px]`) feed value clustering.
    for (const m of rawClassStr.matchAll(ARBITRARY_TW_RE)) {
      const cls = m[1];
      const raw = cls ? arbitraryTailwindValue(cls) : null;
      if (!cls || !raw) continue;
      const colors = extractColorLiterals(raw);
      const lengths = colors.length === 0 ? extractLengthLiterals(raw) : [];
      for (const c of colors) {
        bucket.literalValues.push({
          kind: "color",
          value: c,
          surface: "tailwind-arbitrary",
          context: cls,
          filePath,
          lineNumber,
          snippet,
        });
      }
      for (const l of lengths) {
        bucket.literalValues.push({
          kind: "length",
          value: l,
          surface: "tailwind-arbitrary",
          context: cls,
          filePath,
          lineNumber,
          snippet,
        });
      }
    }
  };

  const getJsxAttributeString = (
    attrs: ts.JsxAttributes,
    attrName: string
  ): string | undefined => {
    for (const prop of attrs.properties) {
      if (
        ts.isJsxAttribute(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === attrName &&
        prop.initializer
      ) {
        if (ts.isStringLiteral(prop.initializer)) {
          return prop.initializer.text;
        }
        if (
          ts.isJsxExpression(prop.initializer) &&
          prop.initializer.expression
        ) {
          if (ts.isStringLiteralLike(prop.initializer.expression)) {
            return prop.initializer.expression.text;
          }
          if (ts.isTemplateExpression(prop.initializer.expression)) {
            return (
              prop.initializer.expression.head.text +
              prop.initializer.expression.templateSpans
                .map((s) => s.literal.text)
                .join("")
            );
          }
        }
      }
    }
    return undefined;
  };

  interface InternalSkeletonNode {
    canonicalSig: string;
    shapeStr: string;
    rootTag: string;
    elementCount: number;
    rawDomCount: number;
    /** Number of custom (component) elements in the subtree, including the root. */
    customCount: number;
    hasSemanticClassOrRole: boolean;
    depth: number;
  }

  const computeJsxSkeletonNode = (
    jsxNode: ts.JsxElement | ts.JsxSelfClosingElement
  ): InternalSkeletonNode | null => {
    const opening = ts.isJsxElement(jsxNode) ? jsxNode.openingElement : jsxNode;
    const tagName = opening.tagName.getText(sf);
    if (SVG_PRIMITIVE_TAGS.has(tagName)) return null;
    const isCustomTag = /^[A-Z]/.test(tagName) || tagName.includes(".");
    const isRawDomTag = !isCustomTag && /^[a-z]/.test(tagName);

    const roleAttr = getJsxAttributeString(opening.attributes, "role");
    const classAttr = getJsxAttributeString(opening.attributes, "className") ?? "";
    // A "semantic" class is one defined in the repo's own stylesheets (derived, not a naming prefix).
    const firstSemanticClass = classAttr
      .split(/\s+/)
      .map((t) => t.trim())
      .find((t) => t !== "" && isKnownCssClass(t));
    const cleanBlockClass = firstSemanticClass
      ? firstSemanticClass.split("--")[0]
      : undefined;
    const hasOwnSemantic = Boolean(roleAttr || cleanBlockClass);

    const tagDescriptor = roleAttr
      ? `${tagName}[role=${roleAttr}]`
      : cleanBlockClass
        ? `${tagName}.${cleanBlockClass}`
        : tagName;

    if (ts.isJsxSelfClosingElement(jsxNode)) {
      return {
        canonicalSig: tagDescriptor,
        shapeStr: tagDescriptor,
        rootTag: tagDescriptor,
        elementCount: 1,
        rawDomCount: isRawDomTag ? 1 : 0,
        customCount: isCustomTag ? 1 : 0,
        hasSemanticClassOrRole: hasOwnSemantic,
        depth: 1,
      };
    }

    const childSkeletons: InternalSkeletonNode[] = [];
    const collectDirectJsxChildren = (childrenNodes: ts.NodeArray<ts.Node>) => {
      for (const child of childrenNodes) {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
          const sk = computeJsxSkeletonNode(child);
          if (sk) childSkeletons.push(sk);
        } else if (ts.isJsxFragment(child)) {
          collectDirectJsxChildren(child.children);
        } else if (ts.isJsxExpression(child) && child.expression) {
          // Walk inside JSX expressions (`{items.map(...)}` or `{cond && <div/>}`)
          const walkExpr = (exprNode: ts.Node) => {
            if (ts.isJsxElement(exprNode) || ts.isJsxSelfClosingElement(exprNode)) {
              const sk = computeJsxSkeletonNode(exprNode);
              if (sk) childSkeletons.push(sk);
              return;
            }
            if (ts.isJsxFragment(exprNode)) {
              collectDirectJsxChildren(exprNode.children);
              return;
            }
            ts.forEachChild(exprNode, walkExpr);
          };
          walkExpr(child.expression);
        }
      }
    };

    collectDirectJsxChildren(jsxNode.children);

    if (childSkeletons.length === 0) {
      return {
        canonicalSig: tagDescriptor,
        shapeStr: tagDescriptor,
        rootTag: tagDescriptor,
        elementCount: 1,
        rawDomCount: isRawDomTag ? 1 : 0,
        customCount: isCustomTag ? 1 : 0,
        hasSemanticClassOrRole: hasOwnSemantic,
        depth: 1,
      };
    }

    let totalElements = 1;
    let totalCustom = isCustomTag ? 1 : 0;
    let totalRawDom = isRawDomTag ? 1 : 0;
    let anySemantic = hasOwnSemantic;
    let maxChildDepth = 0;
    const dedupedChildSigs: string[] = [];
    const dedupedChildShapes: string[] = [];

    for (const c of childSkeletons) {
      totalElements += c.elementCount;
      totalCustom += c.customCount;
      totalRawDom += c.rawDomCount;
      if (c.hasSemanticClassOrRole) anySemantic = true;
      if (c.depth > maxChildDepth) maxChildDepth = c.depth;
      const prevSig = dedupedChildSigs[dedupedChildSigs.length - 1];
      if (prevSig === c.canonicalSig || prevSig === `${c.canonicalSig}+`) {
        dedupedChildSigs[dedupedChildSigs.length - 1] = `${c.canonicalSig}+`;
        dedupedChildShapes[dedupedChildShapes.length - 1] = `${c.shapeStr}+`;
      } else {
        dedupedChildSigs.push(c.canonicalSig);
        dedupedChildShapes.push(c.shapeStr);
      }
    }

    const canonicalSig = `${tagDescriptor}>(${dedupedChildSigs.join(",")})`;
    const shapeStr = `${tagDescriptor} > [${dedupedChildShapes.slice(0, 4).join(", ")}${dedupedChildShapes.length > 4 ? ", ..." : ""}]`;

    return {
      canonicalSig,
      shapeStr,
      rootTag: tagDescriptor,
      elementCount: totalElements,
      rawDomCount: totalRawDom,
      customCount: totalCustom,
      hasSemanticClassOrRole: anySemantic,
      depth: 1 + maxChildDepth,
    };
  };

  const visit = (
    node: ts.Node,
    currentBucket: NonNullable<ReturnType<typeof ensureOwnerBucket>>
  ) => {
    let activeBucket = currentBucket;

    // 1. Track function / component / class boundaries & extract prop contracts
    if (ts.isFunctionDeclaration(node) && node.name) {
      activeBucket = ensureOwnerBucket(
        node.name.text,
        getLine(node.getStart(sf)),
        getLine(node.getEnd()),
        hasExportModifier(node)
      );
      if (activeBucket.propContract.length === 0) {
        activeBucket.propContract = extractPropContractFromFunc(node);
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      activeBucket = ensureOwnerBucket(
        node.name.text,
        getLine(node.getStart(sf)),
        getLine(node.getEnd()),
        hasExportModifier(node)
      );
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer) ||
        ts.isCallExpression(node.initializer))
    ) {
      const isFuncLike =
        ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer) ||
        (ts.isCallExpression(node.initializer) &&
          /^(memo|forwardRef|React\.memo|React\.forwardRef)$/.test(
            node.initializer.expression.getText(sf)
          ));
      if (isFuncLike) {
        const varStmt = node.parent?.parent;
        const exported = varStmt ? hasExportModifier(varStmt) : false;
        activeBucket = ensureOwnerBucket(
          node.name.text,
          getLine(node.getStart(sf)),
          getLine(node.getEnd()),
          exported
        );
        // `const X: React.FC<Props> = …` and `forwardRef<El, Props>(…)` carry props as generics.
        const annotationProps =
          node.type &&
          ts.isTypeReferenceNode(node.type) &&
          node.type.typeArguments?.length
            ? node.type.typeArguments[0]
            : undefined;
        if (
          activeBucket.propContract.length === 0 &&
          (ts.isArrowFunction(node.initializer) ||
            ts.isFunctionExpression(node.initializer))
        ) {
          activeBucket.propContract = extractPropContractFromFunc(
            node.initializer,
            annotationProps
          );
        } else if (
          activeBucket.propContract.length === 0 &&
          ts.isCallExpression(node.initializer) &&
          node.initializer.arguments.length > 0 &&
          (ts.isArrowFunction(node.initializer.arguments[0]) ||
            ts.isFunctionExpression(node.initializer.arguments[0]))
        ) {
          const genericProps =
            node.initializer.typeArguments && node.initializer.typeArguments.length >= 2
              ? node.initializer.typeArguments[1]
              : node.initializer.typeArguments?.[0];
          activeBucket.propContract = extractPropContractFromFunc(
            node.initializer.arguments[0],
            annotationProps ?? genericProps
          );
        }
      }
    }

    // 2. Track `.css` imports
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      if (spec.endsWith(".css")) {
        cssImports.push(spec);
      }
    }

    // 3. Detect `next/font` `variable: "--font-..."`, Astro `cssVariable: "--font-..."`,
    //    and inline JS/JSX CSS custom property declarations (`style={{ '--foo': '12px' }}`, `sx={{ '--bar': ... }}`)
    if (ts.isPropertyAssignment(node)) {
      if (
        ts.isIdentifier(node.name) &&
        (node.name.text === "variable" || node.name.text === "cssVariable") &&
        ts.isStringLiteralLike(node.initializer) &&
        /^--[a-zA-Z0-9_-]+$/.test(node.initializer.text)
      ) {
        definedFontVars.push({
          name: node.initializer.text,
          lineNumber: getLine(node.getStart(sf)),
          scope: "global",
        });
      } else if (
        ts.isStringLiteralLike(node.name) &&
        /^--[a-zA-Z0-9_-]+$/.test(node.name.text)
      ) {
        definedFontVars.push({
          name: node.name.text,
          lineNumber: getLine(node.getStart(sf)),
          scope: "scoped",
        });
      }
    }

    // 4. Scan string literals & template literals for `var(--*)` and hardcoded color literals
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      const text = node.text;
      const lineNumber = getLine(node.getStart(sf));
      const snippet = getLineSnippet(rawLines, lineNumber);
      for (const m of text.matchAll(VAR_REF_RE)) {
        const tokenName = m[1];
        if (!tokenName) continue;
        const ref: TokenReferenceOccurrence = {
          name: tokenName,
          filePath,
          lineNumber,
          snippet,
          kind: "ts-var",
          ...(m[2] ? { hasFallback: true } : {}),
        };
        tokenReferences.push(ref);
        activeBucket.tokensConsumed.add(tokenName);
        activeBucket.tsTokenRefs.push(ref);
      }

      const parent = node.parent;
      const isModuleSpecifier =
        parent !== undefined &&
        (ts.isImportDeclaration(parent) ||
          ts.isExportDeclaration(parent) ||
          ts.isLiteralTypeNode(parent) ||
          ts.isExternalModuleReference(parent));
      if (!isModuleSpecifier && text.includes("bg-") && text.includes("text-")) {
        recordTailwindClassBranches([text.split(/\s+/).filter(Boolean)], lineNumber);
      }
      const isCanvasLitArg =
        parent !== undefined &&
        ts.isCallExpression(parent) &&
        /(?:^|\.)lit$/.test(parent.expression.getText(sf));
      if (
        !isModuleSpecifier &&
        !isCanvasLitArg &&
        !consumedStringNodes.has(node) &&
        looksLikeColorLiteral(text)
      ) {
        let context: string | undefined;
        let surface: LiteralValueOccurrence["surface"] = "string-literal";
        const attr =
          parent && ts.isJsxAttribute(parent)
            ? parent
            : parent && ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)
              ? parent.parent
              : undefined;
        if (attr && ts.isIdentifier(attr.name)) {
          context = attr.name.text;
          surface = "jsx-prop";
        } else if (parent && ts.isPropertyAssignment(parent)) {
          context = parent.name.getText(sf);
        }
        if (!context || !/^(?:href|id|key|name|htmlFor|to|src|alt)$/.test(context)) {
          activeBucket.literalValues.push({
            kind: "color",
            value: text.trim(),
            surface,
            ...(context ? { context } : {}),
            filePath,
            lineNumber,
            snippet,
          });
        }
      }
    }

    // 4b. CSS-in-JS tagged templates (`styled.div\`…\``, `css\`…\``)
    if (hasCssInJs && ts.isTaggedTemplateExpression(node)) {
      activeBucket.stylingConventions.add("css-in-js");
      const tpl = node.template;
      const tplText = ts.isNoSubstitutionTemplateLiteral(tpl)
        ? tpl.text
        : tpl.head.text + tpl.templateSpans.map((sp) => sp.literal.text).join(" ");
      const tplLine = getLine(node.getStart(sf));
      const tplSnippet = getLineSnippet(rawLines, tplLine);
      for (const c of extractColorLiterals(tplText)) {
        activeBucket.literalValues.push({
          kind: "color",
          value: c,
          surface: "string-literal",
          context: "css-in-js",
          filePath,
          lineNumber: tplLine,
          snippet: tplSnippet,
        });
      }
    }

    // 5. Scan JSX attributes (`className`, `style`, `role`) & elements
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const attrName = node.name.text;
      const lineNumber = getLine(node.getStart(sf));
      const snippet = getLineSnippet(rawLines, lineNumber);

      if (attrName === "className" && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          consumedStringNodes.add(node.initializer);
          inspectClassTokens(
            node.initializer.text,
            lineNumber,
            snippet,
            activeBucket
          );
        } else if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression
        ) {
          const expr = node.initializer.expression;
          if (ts.isStringLiteralLike(expr)) {
            consumedStringNodes.add(expr);
            inspectClassTokens(expr.text, lineNumber, snippet, activeBucket);
          } else if (ts.isTemplateExpression(expr)) {
            inspectClassTokens(
              expr.head.text,
              lineNumber,
              snippet,
              activeBucket
            );
            const headTrimmed = expr.head.text;
            if (/[a-zA-Z0-9_-]-$/.test(headTrimmed)) {
              const lastSpace = headTrimmed.lastIndexOf(" ");
              const prefix = headTrimmed.slice(lastSpace + 1);
              if (prefix) {
                activeBucket.dynamicClassPrefixes.add(`${prefix}*`);
              }
            }
            for (const span of expr.templateSpans) {
              inspectClassTokens(
                span.literal.text,
                getLine(span.getStart(sf)),
                getLineSnippet(rawLines, getLine(span.getStart(sf))),
                activeBucket
              );
              if (/[a-zA-Z0-9_-]-$/.test(span.literal.text)) {
                const lastSpace = span.literal.text.lastIndexOf(" ");
                const prefix = span.literal.text.slice(lastSpace + 1);
                if (prefix) {
                  activeBucket.dynamicClassPrefixes.add(`${prefix}*`);
                }
              }
            }
          }
          // Also scan any string literals nested inside ternary / helper expressions in `className={...}`
          const walkClassExpr = (sub: ts.Node) => {
            if (ts.isStringLiteral(sub) || ts.isNoSubstitutionTemplateLiteral(sub)) {
              if (!consumedStringNodes.has(sub)) {
                consumedStringNodes.add(sub);
                const subLine = getLine(sub.getStart(sf));
                inspectClassTokens(
                  sub.text,
                  subLine,
                  getLineSnippet(rawLines, subLine),
                  activeBucket
                );
              }
            } else if (
              ts.isPropertyAccessExpression(sub) &&
              ts.isIdentifier(sub.expression) &&
              cssModuleBindings.has(sub.expression.text)
            ) {
              activeBucket.stylingConventions.add("css-modules");
              activeBucket.cssClassesUsed.add(sub.name.text);
            } else if (
              ts.isElementAccessExpression(sub) &&
              ts.isIdentifier(sub.expression) &&
              cssModuleBindings.has(sub.expression.text) &&
              ts.isStringLiteralLike(sub.argumentExpression)
            ) {
              activeBucket.stylingConventions.add("css-modules");
              activeBucket.cssClassesUsed.add(sub.argumentExpression.text);
            }
            ts.forEachChild(sub, walkClassExpr);
          };
          if (ts.isTemplateExpression(expr)) {
            // `${styles.card}` / `${cn("…")}` inside a template-literal className
            for (const span of expr.templateSpans) walkClassExpr(span.expression);
          } else if (!ts.isStringLiteralLike(expr)) {
            walkClassExpr(expr);
          }
        }
      } else if (
        attrName === "style" &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression &&
        ts.isObjectLiteralExpression(node.initializer.expression)
      ) {
        activeBucket.stylingConventions.add("inline-style");
        for (const prop of node.initializer.expression.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const propName = prop.name.getText(sf);
          if (!NON_TRIVIAL_INLINE_STYLE_PROPS.has(propName)) continue;
          const init = prop.initializer;
          if (ts.isStringLiteralLike(init)) {
            consumedStringNodes.add(init);
            const val = init.text.trim();
            if (
              !val.includes("var(") &&
              !/^(0|0px|none|auto|inherit|transparent|100%|50%)$/i.test(val)
            ) {
              const propLine = getLine(prop.getStart(sf));
              activeBucket.inlineStyleLiterals.push({
                property: propName,
                value: val,
                filePath,
                lineNumber: propLine,
                snippet: getLineSnippet(rawLines, propLine),
              });
            }
          } else if (ts.isNumericLiteral(init)) {
            const numVal = Number(init.text);
            if (numVal !== 0) {
              const propLine = getLine(prop.getStart(sf));
              activeBucket.inlineStyleLiterals.push({
                property: propName,
                value: `${init.text}px`,
                filePath,
                lineNumber: propLine,
                snippet: getLineSnippet(rawLines, propLine),
              });
            }
          }
        }
      } else if (hasCssInJs && attrName === "sx") {
        activeBucket.stylingConventions.add("css-in-js");
      }
    }

    // 6. Scan JSX Elements for Normalized Skeleton Fingerprints (DRY JSX Clone detection on raw DOM subtrees)
    if (ts.isJsxElement(node)) {
      const sk = computeJsxSkeletonNode(node);
      // Raw-DOM structures (≥2 raw nodes) OR compositional patterns built from ≥3 custom components
      // (e.g. `<Card><Thumbnail/><TextLink/></Card>`), which previously could never be detected.
      if (
        sk &&
        sk.elementCount >= 3 &&
        sk.elementCount <= 35 &&
        sk.depth >= 2 &&
        ((/^[a-z]/.test(sk.rootTag) &&
          sk.rawDomCount >= 2 &&
          (sk.hasSemanticClassOrRole || sk.rawDomCount >= 4)) ||
          sk.customCount >= 3)
      ) {
        const lineNumber = getLine(node.openingElement.getStart(sf));
        const skeletonHash = createHash("sha256")
          .update(sk.canonicalSig)
          .digest("hex")
          .slice(0, 12);
        activeBucket.jsxSkeletons.push({
          skeletonHash,
          skeletonShape: sk.shapeStr,
          canonicalSignature: sk.canonicalSig,
          rootTag: sk.rootTag,
          elementCount: sk.elementCount,
          customCount: sk.customCount,
          depth: sk.depth,
          filePath,
          lineNumber,
          snippet: getLineSnippet(rawLines, lineNumber),
        });
      }
    }

    // 6b. Scan JSX Opening / Self-Closing Elements for Raw DOM Primitives, Call-Sites, & Shared Atomic Components
    if (
      ts.isJsxOpeningElement(node) ||
      ts.isJsxSelfClosingElement(node)
    ) {
      const tagName = node.tagName.getText(sf);
      const lineNumber = getLine(node.getStart(sf));
      const snippet = getLineSnippet(rawLines, lineNumber);

      for (const attr of node.attributes.properties) {
        if (
          ts.isJsxAttribute(attr) &&
          ts.isIdentifier(attr.name) &&
          (attr.name.text === "className" || attr.name.text === "class") &&
          attr.initializer
        ) {
          if (ts.isStringLiteral(attr.initializer)) {
            recordTailwindClassBranches(
              [attr.initializer.text.split(/\s+/).filter(Boolean)],
              lineNumber
            );
          } else if (
            ts.isJsxExpression(attr.initializer) &&
            attr.initializer.expression
          ) {
            recordTailwindClassBranches(
              collectClassTokenBranches(attr.initializer.expression),
              lineNumber
            );
          }
        }
      }

      if (!activeBucket.rootElement && activeBucket.name !== "__module__") {
        const styleProps: Record<string, string> = {};
        for (const attr of node.attributes.properties) {
          if (
            ts.isJsxAttribute(attr) &&
            ts.isIdentifier(attr.name) &&
            attr.name.text === "style" &&
            attr.initializer &&
            ts.isJsxExpression(attr.initializer) &&
            attr.initializer.expression &&
            ts.isObjectLiteralExpression(attr.initializer.expression)
          ) {
            for (const sp of attr.initializer.expression.properties) {
              if (!ts.isPropertyAssignment(sp)) continue;
              const spName = sp.name.getText(sf);
              if (/^(?:margin|marginTop|marginRight|marginBottom|marginLeft|width|minWidth)$/.test(spName)) {
                if (ts.isStringLiteralLike(sp.initializer) || ts.isNumericLiteral(sp.initializer)) {
                  styleProps[spName] = sp.initializer.text;
                }
              }
            }
          }
        }
        activeBucket.rootElement = {
          tag: tagName,
          classes: getJsxAttributeString(node.attributes, "className") ?? "",
          styleProps,
          lineNumber,
          snippet,
        };
      }

      if (/^[A-Z]/.test(tagName) || tagName.includes(".")) {
        activeBucket.jsxCustomComponentCount++;
        activeBucket.renderedComponents.add(tagName);

        // Extract call-site props & style/className override leaks
        const passedProps: string[] = [];
        const inlineStyleProps: string[] = [];
        const arbitraryTailwindOverrides: string[] = [];
        const literalProps: JsxCallSiteRecord["literalProps"] = [];
        let classNameOverride: string | undefined;

        for (const prop of node.attributes.properties) {
          if (ts.isJsxAttribute(prop) && ts.isIdentifier(prop.name)) {
            const pName = prop.name.text;
            passedProps.push(pName);
            if (colorPropRe.test(pName) && prop.initializer) {
              const lit = ts.isStringLiteral(prop.initializer)
                ? prop.initializer
                : ts.isJsxExpression(prop.initializer) &&
                    prop.initializer.expression &&
                    ts.isStringLiteralLike(prop.initializer.expression)
                  ? prop.initializer.expression
                  : undefined;
              if (lit && looksLikeColorLiteral(lit.text)) {
                literalProps.push({ prop: pName, value: lit.text.trim(), kind: "color" });
                activeBucket.invariantViolations.push({
                  parentComponent: activeBucket.name,
                  childComponent: tagName,
                  prop: pName,
                  value: lit.text.trim(),
                  filePath,
                  lineNumber,
                  snippet,
                });
              }
            }
            if (
              pName === "style" &&
              prop.initializer &&
              ts.isJsxExpression(prop.initializer) &&
              prop.initializer.expression &&
              ts.isObjectLiteralExpression(prop.initializer.expression)
            ) {
              for (const sp of prop.initializer.expression.properties) {
                if (ts.isPropertyAssignment(sp)) {
                  const spName = sp.name.getText(sf);
                  if (NON_TRIVIAL_INLINE_STYLE_PROPS.has(spName)) {
                    inlineStyleProps.push(spName);
                  }
                }
              }
            } else if (pName === "className") {
              const clsStr = getJsxAttributeString(node.attributes, "className");
              if (clsStr) {
                classNameOverride = clsStr;
                for (const m of clsStr.matchAll(ARBITRARY_TW_RE)) {
                  if (m[1]) arbitraryTailwindOverrides.push(m[1]);
                }
              }
            }
          }
        }

        activeBucket.jsxCallSites.push({
          targetComponent: tagName,
          filePath,
          lineNumber,
          snippet,
          passedProps,
          hasInlineStyleOverride: inlineStyleProps.length > 0,
          inlineStyleProps,
          arbitraryTailwindOverrides,
          literalProps,
          ...(classNameOverride ? { classNameOverride } : {}),
        });
      } else {
        if (!SVG_PRIMITIVE_TAGS.has(tagName)) {
          activeBucket.jsxDomElementCount++;
        }
        if (!SVG_PRIMITIVE_TAGS.has(tagName)) activeBucket.domTags.add(tagName);
        const roleAttr = getJsxAttributeString(node.attributes, "role");
        const classAttr = getJsxAttributeString(node.attributes, "className") ?? "";
        const getAttr = (n: string) => getJsxAttributeString(node.attributes, n);

        // Raw DOM that should be a shared atom: matched against the (configurable) atom catalog.
        for (const def of atomDefinitions) {
          if (def.matchers.some((m) => atomMatcherHits(m, tagName, roleAttr, classAttr, getAttr))) {
            const firstClass = classAttr.split(/\s+/).find(Boolean);
            activeBucket.rawDomPrimitives.push({
              tagOrRole: `<${tagName}${roleAttr ? ` role="${roleAttr}"` : ""}${firstClass ? ` className="${firstClass}"` : ""}>`,
              atomicTarget: def.name,
              filePath,
              lineNumber,
              snippet,
            });
            break;
          }
        }
      }
    }

    // 7. Scan NewExpressions & CallExpressions for State Hooks & Canvas Provenance (`makeSlotRecorder`, `t(slot, prop, ...)`, `readColor`, `css`, `tsConst`, `lit`)
    if (hasPixiImport && ts.isNewExpression(node)) {
      const ctorText = node.expression.getText(sf);
      if (
        /^(?:PIXI\.)?(Application|Container|Graphics|Sprite|Text|BitmapText|Rectangle)$/.test(
          ctorText
        )
      ) {
        activeBucket.stylingConventions.add("pixi-canvas");
      }
    }
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(sf);
      const lineNumber = getLine(node.getStart(sf));
      const snippet = getLineSnippet(rawLines, lineNumber);

      // Class-composition helpers (`cva`, `cn`, `clsx`, `tv`, `twMerge`…): their string args are class lists,
      // even when declared outside a JSX `className`. `cva`/`tv` also declare variant axes.
      const calleeLast = calleeText.split(".").pop() ?? calleeText;
      if (
        hasCssInJs &&
        /^(?:styled|css|keyframes|createGlobalStyle)$/.test(calleeLast)
      ) {
        activeBucket.stylingConventions.add("css-in-js");
      }
      if (CLASS_HELPER_CALLEES.has(calleeLast)) {
        const walkHelperArg = (sub: ts.Node) => {
          if (ts.isPropertyAssignment(sub) && sub.name.getText(sf) === "defaultVariants") return;
          if (ts.isStringLiteral(sub) || ts.isNoSubstitutionTemplateLiteral(sub)) {
            const subLine = getLine(sub.getStart(sf));
            recordTailwindClassBranches([sub.text.split(/\s+/).filter(Boolean)], subLine);
            if (!consumedStringNodes.has(sub)) {
              consumedStringNodes.add(sub);
              inspectClassTokens(
                sub.text,
                subLine,
                getLineSnippet(rawLines, subLine),
                activeBucket
              );
            }
          } else if (
            ts.isPropertyAccessExpression(sub) &&
            ts.isIdentifier(sub.expression) &&
            cssModuleBindings.has(sub.expression.text)
          ) {
            activeBucket.stylingConventions.add("css-modules");
            activeBucket.cssClassesUsed.add(sub.name.text);
          }
          ts.forEachChild(sub, walkHelperArg);
        };
        for (const arg of node.arguments) walkHelperArg(arg);

        if (calleeLast === "cva" || calleeLast === "tv") {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const prop of arg.properties) {
              if (
                !ts.isPropertyAssignment(prop) ||
                prop.name.getText(sf) !== "variants" ||
                !ts.isObjectLiteralExpression(prop.initializer)
              ) {
                continue;
              }
              for (const axis of prop.initializer.properties) {
                if (!ts.isPropertyAssignment(axis) || !ts.isObjectLiteralExpression(axis.initializer)) continue;
                const axisName = axis.name.getText(sf).replace(/^["']|["']$/g, "");
                const values = axis.initializer.properties
                  .filter(ts.isPropertyAssignment)
                  .map((v) => v.name.getText(sf).replace(/^["']|["']$/g, ""));
                const existing = new Set(variantAxes[axisName] ?? []);
                for (const v of values) existing.add(v);
                variantAxes[axisName] = [...existing].sort();
              }
            }
          }
        }
      }

      if (
        hasPixiImport &&
        (/^draw[A-Z][a-zA-Z0-9]*$/.test(calleeText) ||
          /\.(circle|rect|roundRect|fill|stroke|moveTo|lineTo|addChild|canvas)$/.test(
            calleeText
          ))
      ) {
        activeBucket.stylingConventions.add("pixi-canvas");
      }

      if (STATE_HOOK_NAMES.has(calleeText)) {
        activeBucket.stateHookCount++;
      }

      if (slotRecorderFactories.includes(calleeText)) {
        activeBucket.usesSlotRecorder = true;
        activeBucket.stylingConventions.add("pixi-canvas");
      } else if (
        (canvasTokenReaderHelpers.includes(calleeText) ||
          calleeText.endsWith(".getPropertyValue")) &&
        node.arguments.length >= 1 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text.trim().startsWith("--")
      ) {
        const tokenName = node.arguments[0].text.trim();
        tokenReferences.push({
          name: tokenName,
          filePath,
          lineNumber,
          snippet,
          kind: "canvas-bridge",
        });
        activeBucket.tokensConsumed.add(tokenName);
      } else if (
        slotRecorderFactories.length > 0 &&
        calleeText === "t" &&
        node.arguments.length >= 3
      ) {
        activeBucket.usesSlotRecorder = true;
        activeBucket.stylingConventions.add("pixi-canvas");
        const slotArg = node.arguments[0];
        const propArg = node.arguments[1];
        const valArg = node.arguments[2];
        const slotName = ts.isStringLiteralLike(slotArg)
          ? slotArg.text
          : slotArg.getText(sf);
        const propName = ts.isStringLiteralLike(propArg)
          ? propArg.text
          : propArg.getText(sf);

        if (ts.isCallExpression(valArg)) {
          const valCallee = valArg.expression.getText(sf);
          if (valCallee === "lit" || valCallee.endsWith(".lit")) {
            const rawVal = valArg.arguments[0]?.getText(sf) ?? "?";
            // Ignore trivial opaque alpha === 1 (matching `makeSlotRecorder` in `tokenSource.ts`)
            const isTrivialOpaqueAlpha =
              propName.endsWith("alpha") && rawVal.trim() === "1";
            if (!isTrivialOpaqueAlpha) {
              activeBucket.canvasLiteralCount++;
              activeBucket.canvasLiterals.push({
                slot: slotName,
                prop: propName,
                value: rawVal,
                filePath,
                lineNumber: getLine(valArg.getStart(sf)),
                snippet: getLineSnippet(rawLines, getLine(valArg.getStart(sf))),
              });
            }
          } else if (valCallee === "tsConst" || valCallee.endsWith(".tsConst")) {
            activeBucket.canvasTsConstCount++;
          } else if (
            valCallee === "css" ||
            valCallee.endsWith(".css") ||
            canvasCssValueHelpers.includes(valCallee) ||
            canvasTokenReaderHelpers.includes(valCallee)
          ) {
            activeBucket.canvasCssCount++;
          }
        }
      } else if (
        slotRecorderFactories.length > 0 &&
        /^(?:[a-zA-Z_$][a-zA-Z0-9_$]*\.)?(css|tsConst|lit)$/.test(calleeText) &&
        !(
          ts.isCallExpression(node.parent) &&
          node.parent.expression.getText(sf) === "t"
        )
      ) {
        const method = calleeText.split(".").pop()!;
        const hasDotReceiver = calleeText.includes(".");
        if (hasDotReceiver || activeBucket.usesSlotRecorder) {
          activeBucket.usesSlotRecorder = true;
          activeBucket.stylingConventions.add("pixi-canvas");
          if (method === "css") {
            activeBucket.canvasCssCount++;
          } else if (method === "tsConst") {
            activeBucket.canvasTsConstCount++;
          } else if (method === "lit") {
            const slotOrValArg = node.arguments[0];
            const valArg =
              node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0];
            const rawVal = valArg?.getText(sf) ?? "?";
            const slotName =
              node.arguments.length >= 2 &&
              slotOrValArg &&
              ts.isStringLiteralLike(slotOrValArg)
                ? slotOrValArg.text
                : "canvas";
            const isTrivialOpaqueAlpha =
              slotName.toLowerCase().endsWith("alpha") && rawVal.trim() === "1";
            if (!isTrivialOpaqueAlpha) {
              activeBucket.canvasLiteralCount++;
              activeBucket.canvasLiterals.push({
                slot: slotName,
                prop: "value",
                value: rawVal,
                filePath,
                lineNumber,
                snippet,
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, activeBucket));
  };

  visit(sf, moduleBucket);

  return {
    filePath,
    definedFontVars,
    tokenReferences,
    cssImports,
    tailwindClassPairs,
    importedModules,
    importedBindings,
    reExports,
    variantAxes,
    functionsAndClasses,
  };
}

// ---------------------------------------------------------------------------
// 5. Full Repository Design System Analyzer
// ---------------------------------------------------------------------------

function getPrimaryNodeEvidence(
  node: StructuralNode
): { filePath?: string; lineNumber?: number } {
  if (!node.evidence) return {};
  if (Array.isArray(node.evidence)) {
    const first = node.evidence.find((e) => Boolean(e?.filePath)) ?? node.evidence[0];
    return { filePath: first?.filePath, lineNumber: first?.lineNumber };
  }
  return {
    filePath: node.evidence.filePath,
    lineNumber: node.evidence.lineNumber,
  };
}

function cleanNodeDisplayLabel(name: string): string {
  // Strip any framework/contract prefix (`Exported Function: `, `Route: `, `Class: `, etc.)
  return name.replace(/^[A-Za-z0-9._\s/-]+:\s*/, "").trim();
}

export function matchUiRoleConvention(
  node: Pick<StructuralNode, "entityType"> & {
    patternId?: string;
    metadata?: Record<string, unknown>;
  },
  filePath: string,
  options: {
    /** When false, ROUTE/TEMPLATE rows match only by entity type / pattern id (not by file path). */
    allowPathMatchForStructuralRoles?: boolean;
  } = {}
): UiRoleConventionRow | undefined {
  const entityType = node.entityType || "";
  const allowStructuralPathMatch = options.allowPathMatchForStructuralRoles !== false;
  const patternId =
    typeof node.patternId === "string" && node.patternId
      ? node.patternId
      : typeof (node.metadata as any)?.patternId === "string"
        ? (node.metadata as any).patternId
        : "";
  const normalizedPath = filePath.replace(/\\/g, "/");

  for (const row of UI_ROLE_CONVENTIONS) {
    if (row.entityTypes?.includes(entityType)) {
      return row;
    }
    if (
      patternId &&
      row.patternIdPrefixes?.some((prefix) => patternId.startsWith(prefix))
    ) {
      return row;
    }
    if (
      (allowStructuralPathMatch || (row.role !== "ROUTE" && row.role !== "TEMPLATE")) &&
      row.filePathPatterns?.some((re) => re.test(normalizedPath))
    ) {
      return row;
    }
  }
  return undefined;
}

export function classifyAtomicTier(params: {
  node: StructuralNode;
  filePath: string;
  jsxDomElementCount: number;
  jsxCustomComponentCount: number;
  stateHookCount: number;
  rendersInDegree: number;
  rendersOutDegree: number;
  /**
   * False when the node is a helper inside a route/layout file (not the file's primary export):
   * such nodes must not inherit the file's ROUTE/TEMPLATE role from its path.
   */
  isPrimaryInFile?: boolean;
}): {
  atomicTier: AtomicTier;
  classificationSource: AtomicClassificationSource;
  convention?: UiRoleConventionRow;
} {
  const matchedConv = matchUiRoleConvention(params.node, params.filePath, {
    allowPathMatchForStructuralRoles: params.isPrimaryInFile !== false,
  });
  if (matchedConv) {
    return {
      atomicTier: matchedConv.role,
      classificationSource: "convention-table",
      convention: matchedConv,
    };
  }

  const {
    jsxDomElementCount,
    jsxCustomComponentCount,
    stateHookCount,
    rendersOutDegree,
  } = params;

  // Pure TS/canvas/style helper with no JSX elements
  if (jsxDomElementCount === 0 && jsxCustomComponentCount === 0) {
    return {
      atomicTier: "UTILITY",
      classificationSource: "ast-footprint",
    };
  }

  // Topology-driven Organism: composes >= 3 distinct child components or has large DOM/state footprint
  if (
    rendersOutDegree >= 3 ||
    jsxCustomComponentCount >= 3 ||
    jsxDomElementCount >= 22 ||
    stateHookCount >= 3
  ) {
    return {
      atomicTier: "ORGANISM",
      classificationSource:
        rendersOutDegree >= 3 ? "renders-topology" : "ast-footprint",
    };
  }

  // Leaf UI primitive: renders 0 child components, compact DOM subtree, minimal state
  if (
    rendersOutDegree === 0 &&
    jsxCustomComponentCount === 0 &&
    jsxDomElementCount > 0 &&
    jsxDomElementCount <= 10 &&
    stateHookCount <= 1
  ) {
    return {
      atomicTier: "ATOM",
      classificationSource: "renders-topology",
    };
  }

  // Composite control combining atoms or moderate DOM structure
  return {
    atomicTier: "MOLECULE",
    classificationSource:
      rendersOutDegree > 0 ? "renders-topology" : "ast-footprint",
  };
}

/**
 * Names a repeated structure *from the structure itself* (no keyword guessing): the repo's own
 * class block, the custom components it composes, or the root element. Confidence is `low`
 * when only a structural placeholder is possible; a human should rename it.
 */
function inferSuggestedComponentName(
  rootTag: string,
  canonicalSignature: string,
  elementCount: number
): { name: string; tier: "ATOM" | "MOLECULE" | "ORGANISM"; confidence: "medium" | "low" } {
  const pascal = (raw: string): string =>
    raw
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join("");
  const tier: "MOLECULE" | "ORGANISM" = elementCount >= 10 ? "ORGANISM" : "MOLECULE";

  const customNames: string[] = [];
  for (const m of canonicalSignature.matchAll(/(?:^|[(,>])([A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)?)/g)) {
    const n = m[1].replace(/\./g, "");
    if (!customNames.includes(n)) customNames.push(n);
  }
  if (customNames.length >= 2) {
    return { name: customNames.slice(0, 3).join(""), tier, confidence: "medium" };
  }

  const classMatch = rootTag.match(/\.([a-zA-Z0-9_-]+)/);
  if (classMatch?.[1]) {
    const clean = pascal(classMatch[1].split("__")[0].split("--")[0]);
    if (clean) return { name: clean, tier, confidence: "medium" };
  }
  if (/^[A-Z]/.test(rootTag)) {
    return { name: `${pascal(rootTag.split("[")[0])}Block`, tier, confidence: "medium" };
  }
  const roleMatch = rootTag.match(/\[role=([a-z]+)\]/);
  if (roleMatch) {
    return { name: `${pascal(roleMatch[1])}Block`, tier, confidence: "low" };
  }
  return { name: `Extracted${pascal(rootTag.split("[")[0])}Block`, tier, confidence: "low" };
}

function matchesDynamicPrefix(cls: string, dynamicPrefixes: Set<string>): boolean {
  for (const prefixPattern of dynamicPrefixes) {
    const cleanPrefix = prefixPattern.replace(/\*$/, "");
    if (cleanPrefix && cls.startsWith(cleanPrefix)) {
      return true;
    }
  }
  return false;
}

export interface AnalyzeDesignSystemOptions {
  /** Pre-resolved config. Default: loaded from `<repoPath>/chomp.config.json` (`designSystem` key). */
  resolvedConfig?: ResolvedDesignSystemConfig;
  /** Partial overrides merged over the file config and defaults (tests, programmatic use). */
  configOverrides?: Partial<DesignSystemConfig>;
}

/** Resolves the effective atom catalog from config (`defaults` + declared definitions, `extend`, or `replace`). */
export function resolveAtomCatalog(config: DesignSystemConfig): AtomDefinition[] {
  const declared = config.atoms.definitions;
  if (config.atoms.catalog === "replace") return [...declared];
  const declaredNames = new Set(declared.map((d) => d.name.toLowerCase()));
  return [
    ...declared,
    ...DEFAULT_ATOM_CATALOG.filter((d) => !declaredNames.has(d.name.toLowerCase())),
  ];
}

const UNSUPPORTED_UI_EXTENSIONS = [".sass", ".styl"];

function isBareColorOrScaleValue(value: string): boolean {
  return parseCssColorString(value) !== null;
}

export function analyzeRepositoryDesignSystem(
  ctx: ChompPluginContext,
  analyzeOptions: AnalyzeDesignSystemOptions = {}
): {
  report: DesignSystemAnalysisReport;
  overlays: EntityOverlayInput[];
} {
  const resolved =
    analyzeOptions.resolvedConfig ??
    resolveDesignSystemConfig(ctx.repoPath, analyzeOptions.configOverrides);
  const config = resolved.config;
  const themeRes = {
    dark: compileRegexes(config.themes.dark),
    light: compileRegexes(config.themes.light),
  };

  // 0. Frontend scope: only frontend packages are audited (detected from package.json or configured)
  const excludeFileRes = compileRegexes(config.scope.excludeFiles);
  const scope = detectFrontendScope(ctx.files, ctx.readFile, config);
  const inScopeFiles = ctx.files.filter(
    (f) => scope.includeFile(f) && !excludeFileRes.some((re) => re.test(f))
  );
  const cssFiles = inScopeFiles.filter((f) => isSupportedStylesheetFile(f));
  const uiComponentFiles = inScopeFiles.filter((f) => isPreprocessedUiComponentFile(f));
  const codeFiles = inScopeFiles.filter(
    (f) =>
      (f.endsWith(".tsx") ||
        f.endsWith(".ts") ||
        f.endsWith(".jsx") ||
        f.endsWith(".js")) &&
      !f.endsWith(".d.ts")
  );
  const unsupportedByExt = new Map<string, string[]>();
  for (const f of inScopeFiles) {
    const ext = UNSUPPORTED_UI_EXTENSIONS.find((e) => f.endsWith(e));
    if (!ext) continue;
    let list = unsupportedByExt.get(ext);
    if (!list) {
      list = [];
      unsupportedByExt.set(ext, list);
    }
    list.push(f);
  }

  const atomDefinitions = resolveAtomCatalog(config);

  // 1. Parse all `.css` / `.scss` / `.less` files plus embedded `<style>` blocks in `.vue` / `.svelte` / `.astro` / `.mdx`
  const parsedCssList: ParsedCssStylesheet[] = [];
  const cssInputDeps: OverlayInputDependency[] = [];
  const seenCssDepPaths = new Set<string>();
  const addCssDep = (filePath: string) => {
    if (seenCssDepPaths.has(filePath)) return;
    const dep = ctx.hashFile(filePath);
    if (dep) {
      seenCssDepPaths.add(filePath);
      cssInputDeps.push(dep);
    }
  };

  for (const cssFile of cssFiles) {
    const content = ctx.readFile(cssFile);
    if (content === null) continue;
    parsedCssList.push(
      parseCssStylesheet(cssFile, content, {
        themes: themeRes,
        tiers: config.tokens.tiers,
        syntax: detectStylesheetSyntax(cssFile),
      })
    );
    addCssDep(cssFile);
  }

  const uiRawContents = new Map<string, string>();
  for (const uiFile of uiComponentFiles) {
    const content = ctx.readFile(uiFile);
    if (content === null) continue;
    uiRawContents.set(uiFile, content);
    const styleBlocks = extractEmbeddedStyleBlocks(uiFile, content);
    for (const block of styleBlocks) {
      parsedCssList.push(
        parseCssStylesheet(uiFile, block.paddedCssText, {
          themes: themeRes,
          tiers: config.tokens.tiers,
          syntax: block.syntax,
          defaultScoped: block.defaultScoped,
        })
      );
    }
    if (styleBlocks.length > 0) {
      addCssDep(uiFile);
    }
  }

  // Class names defined in the repo's own stylesheets (derived; replaces hardcoded prefixes)
  const knownCssClasses = new Set<string>();
  for (const sheet of parsedCssList) {
    for (const rule of sheet.styleRules) {
      for (const cls of rule.classesInSelector) knownCssClasses.add(cls);
    }
  }

  // 3. Scan all in-scope TS/TSX and preprocessed `.vue`/`.svelte`/`.astro`/`.mdx` files via AST
  const scanOpts: ScanOptions = {
    knownCssClasses,
    cssClassPrefixes: config.styling.cssClassPrefixes,
    atomDefinitions,
    colorPropPattern: config.invariants.colorPropPattern,
    canvasSlotRecorderFactories: config.styling.canvas.slotRecorderFactories,
    canvasCssValueHelpers: config.styling.canvas.cssValueHelpers,
    canvasTokenReaderHelpers: config.styling.canvas.tokenReaderHelpers,
  };
  const scannedFiles = new Map<string, ScannedFileAstResult>();
  for (const file of codeFiles) {
    const content = ctx.readFile(file);
    if (content === null) continue;
    scannedFiles.set(file, scanTsxOrTsFile(file, content, scanOpts));
  }
  for (const [uiFile, rawContent] of uiRawContents.entries()) {
    const tsxSource = preprocessUiComponentToTsx(uiFile, rawContent);
    scannedFiles.set(uiFile, scanTsxOrTsFile(uiFile, tsxSource, scanOpts));
  }

  // 4. Aggregate all defined tokens (`.css` + JS/TS CSS custom property variables)
  const allTokenDecls: CssTokenDeclaration[] = [];
  for (const sheet of parsedCssList) {
    allTokenDecls.push(...sheet.tokenDeclarations);
  }
  for (const scanned of scannedFiles.values()) {
    for (const fv of scanned.definedFontVars) {
      allTokenDecls.push({
        name: fv.name,
        value: "js-css-variable",
        tier: fv.scope === "scoped" ? "component" : "primitive",
        themeContext: "root",
        selector: "js-variable",
        filePath: scanned.filePath,
        lineNumber: fv.lineNumber,
        referencedVars: [],
        scope: fv.scope ?? "global",
      });
    }
  }

  // 4a. Derive token tiers from the reference graph (explicit config regexes always win)
  const derivedTiers = deriveTokenTiers(allTokenDecls, config.tokens.tiers);
  const tierSources: DesignSystemSourceInfo["tierSources"] = {
    config: 0,
    derived: 0,
    scoped: 0,
    "theme-bridge": 0,
  };
  for (const [, t] of derivedTiers) tierSources[t.source]++;
  for (const d of allTokenDecls) {
    const t = derivedTiers.get(d.name);
    if (t) d.tier = t.tier;
  }

  const definedTokenNames = new Set<string>(allTokenDecls.map((d) => d.name));
  const primitiveTokens = new Set<string>();
  const semanticTokens = new Set<string>();
  const componentTokens = new Set<string>();
  const themeBridgeTokens = new Set<string>();

  for (const decl of allTokenDecls) {
    if (decl.themeContext === "theme-bridge") {
      themeBridgeTokens.add(decl.name);
    } else if (decl.tier === "primitive") {
      primitiveTokens.add(decl.name);
    } else if (decl.tier === "component") {
      componentTokens.add(decl.name);
    } else {
      semanticTokens.add(decl.name);
    }
  }

  // 4b. Adhere mode: which tokens are declared inside / outside the declared system sources
  const tokenSourceRes = config.tokens.sources.map((g) => globToRegExp(g));
  const isSystemSourceFile = (f: string) => tokenSourceRes.some((re) => re.test(f));
  const tokensOutsideSystem: CoverageSection["tokensOutsideSystem"] = [];
  if (resolved.mode === "adhere" && tokenSourceRes.length > 0) {
    const systemNames = new Set(
      allTokenDecls.filter((d) => isSystemSourceFile(d.filePath)).map((d) => d.name)
    );
    const seenOutside = new Set<string>();
    for (const d of allTokenDecls) {
      if (systemNames.has(d.name) || d.scope === "scoped" || d.selector === "js-variable") continue;
      if (seenOutside.has(d.name)) continue;
      seenOutside.add(d.name);
      tokensOutsideSystem.push({ name: d.name, filePath: d.filePath, lineNumber: d.lineNumber });
    }
  }

  // 4c. Raw palettes, derived from the repo's own token layers: palette P is a "raw primitive" palette
  // when a semantic/component token aliases one of its steps (`--accent: var(--yellow-9)`), i.e. the
  // system routes P through a semantic layer. Config can add / remove palettes.
  const aliasedByHigherTier = new Map<string, string[]>();
  for (const d of allTokenDecls) {
    if (d.scope === "scoped" || d.tier === "primitive") continue;
    if (isScaleStepTokenName(d.name)) continue; // pass-through bridge (`--color-yellow-9: var(--yellow-9)`)
    for (const ref of d.referencedVars) {
      let list = aliasedByHigherTier.get(ref);
      if (!list) {
        list = [];
        aliasedByHigherTier.set(ref, list);
      }
      if (!list.includes(d.name)) list.push(d.name);
    }
  }
  const rawPalettes = new Set<string>();
  const primitiveColorTokenNames = new Set<string>();
  for (const d of allTokenDecls) {
    if (d.scope === "scoped" || d.tier !== "primitive") continue;
    if (!aliasedByHigherTier.has(d.name)) continue;
    if (isBareColorOrScaleValue(d.value) || isScaleStepTokenName(d.name)) {
      primitiveColorTokenNames.add(d.name);
      const m = d.name.match(/^--(?:color-)?([a-z][a-z-]*?)-(\d{1,4})$/i);
      if (m && isBareColorOrScaleValue(d.value)) rawPalettes.add(m[1].toLowerCase());
    }
  }
  for (const p of config.styling.tailwind.rawPalettes) rawPalettes.add(p.toLowerCase());
  if (config.styling.tailwind.defaultPalette === "flag") {
    for (const p of TAILWIND_DEFAULT_PALETTES) rawPalettes.add(p);
  }
  for (const p of config.styling.tailwind.allowedPalettes) rawPalettes.delete(p.toLowerCase());

  const semanticSuggestionFor = (primitiveName: string | undefined): string | undefined => {
    if (!primitiveName) return undefined;
    const aliases = aliasedByHigherTier.get(primitiveName);
    return aliases && aliases.length > 0
      ? `${aliases.slice(0, 3).join(" / ")} (aliases ${primitiveName})`
      : undefined;
  };

  // 5. Aggregate all token references across CSS and TS/TSX
  const allTokenRefs: TokenReferenceOccurrence[] = [];
  for (const sheet of parsedCssList) {
    allTokenRefs.push(...sheet.varReferences);
  }
  for (const scanned of scannedFiles.values()) {
    allTokenRefs.push(...scanned.tokenReferences);
  }

  const externalPrefixes = config.tokens.externalPrefixes;

  // 6. Compute Undefined `var(--*)` Leaks
  const undefinedByName = new Map<
    string,
    Array<{ filePath: string; lineNumber: number; snippet: string }>
  >();
  for (const ref of allTokenRefs) {
    // `var(--x, fallback)` hooks and third-party-owned prefixes (`--tw-*`, `--radix-*`) are not leaks.
    if (ref.hasFallback) continue;
    if (externalPrefixes.some((p) => ref.name.startsWith(p))) continue;
    if (!definedTokenNames.has(ref.name)) {
      let list = undefinedByName.get(ref.name);
      if (!list) {
        list = [];
        undefinedByName.set(ref.name, list);
      }
      if (
        !list.some(
          (item) =>
            item.filePath === ref.filePath && item.lineNumber === ref.lineNumber
        )
      ) {
        list.push({
          filePath: ref.filePath,
          lineNumber: ref.lineNumber,
          snippet: ref.snippet,
        });
      }
    }
  }

  const undefinedTokens: UndefinedTokenDiagnostic[] = [
    ...undefinedByName.entries(),
  ]
    .map(([name, occurrences]) => ({
      name,
      occurrenceCount: occurrences.length,
      occurrences,
    }))
    .sort(
      (a, b) =>
        b.occurrenceCount - a.occurrenceCount || a.name.localeCompare(b.name)
    );

  // 7. Compute Duplicate / Forked Token Declarations across stylesheets
  const declsByTokenName = new Map<string, CssTokenDeclaration[]>();
  for (const d of allTokenDecls) {
    // Scoped declarations (`.card { --card-bg }`) legitimately re-declare names per component.
    if (d.selector === "js-variable" || d.scope === "scoped") continue;
    let list = declsByTokenName.get(d.name);
    if (!list) {
      list = [];
      declsByTokenName.set(d.name, list);
    }
    list.push(d);
  }

  const duplicateTokens: DuplicateTokenDiagnostic[] = [];
  for (const [name, decls] of declsByTokenName.entries()) {
    const distinctFiles = new Set(decls.map((d) => d.filePath));
    if (distinctFiles.size < 2) continue;

    const valuesByTheme = new Map<ThemeContext, Set<string>>();
    for (const d of decls) {
      let set = valuesByTheme.get(d.themeContext);
      if (!set) {
        set = new Set();
        valuesByTheme.set(d.themeContext, set);
      }
      set.add(d.value.replace(/\s+/g, " ").trim().toLowerCase());
    }
    const isForkedValue = [...valuesByTheme.values()].some((s) => s.size > 1);

    const uniqueDecls: DuplicateTokenDiagnostic["declarations"] = [];
    const seenDeclKey = new Set<string>();
    for (const d of decls) {
      const k = `${d.filePath}:${d.lineNumber}:${d.themeContext}`;
      if (seenDeclKey.has(k)) continue;
      seenDeclKey.add(k);
      uniqueDecls.push({
        filePath: d.filePath,
        lineNumber: d.lineNumber,
        selector: d.selector,
        themeContext: d.themeContext,
        value: d.value,
      });
    }

    duplicateTokens.push({
      name,
      tier: decls[0].tier,
      distinctFileCount: distinctFiles.size,
      isForkedValue,
      declarations: uniqueDecls,
    });
  }

  duplicateTokens.sort(
    (a, b) =>
      Number(b.isForkedValue) - Number(a.isForkedValue) ||
      b.distinctFileCount - a.distinctFileCount ||
      a.name.localeCompare(b.name)
  );

  // 8. Compute Unused Tokens
  const referencedTokenNames = new Set<string>(allTokenRefs.map((r) => r.name));
  const unusedTokens: DesignSystemAnalysisReport["diagnostics"]["unusedTokens"] =
    [];
  const seenUnused = new Set<string>();

  for (const d of allTokenDecls) {
    if (seenUnused.has(d.name)) continue;
    if (d.themeContext === "theme-bridge") continue;
    if (d.selector === "js-variable") continue;
    if (!referencedTokenNames.has(d.name)) {
      seenUnused.add(d.name);
      unusedTokens.push({
        name: d.name,
        tier: d.tier,
        filePath: d.filePath,
        lineNumber: d.lineNumber,
      });
    }
  }
  unusedTokens.sort((a, b) => a.name.localeCompare(b.name));

  // 9. Compute WCAG 2.1 Theme Contrast Audits (`dark` vs `light`)
  const allStyleRules = parsedCssList.flatMap((s) => s.styleRules);
  const allTailwindClassPairs = [...scannedFiles.values()].flatMap(
    (s) => s.tailwindClassPairs
  );
  const contrastEvaluation = evaluateContrast(allTokenDecls, allStyleRules, {
    pairs: config.contrast.pairs,
    minRatio: config.contrast.minRatio,
    discoverFromRules: config.contrast.discoverFromRules,
    discoverFromNaming: config.contrast.discoverFromNaming,
    tailwindClassPairs: allTailwindClassPairs,
    canvasToken: config.contrast.canvasToken,
  });
  const contrastAudits = contrastEvaluation.audits;
  const contrastUnresolved = contrastEvaluation.unresolved;
  const contrastFailures = contrastAudits.filter((c) => !c.passesAll);
  const contrastCandidateCount = new Set<string>([
    ...contrastAudits.map((a) => a.pairId),
    ...contrastUnresolved.map((u) => u.pairId),
  ]).size;

  // 10. Map CSS classes to the tokens they consume
  const tokensByCssClass = new Map<string, Set<string>>();
  for (const rule of allStyleRules) {
    for (const cls of rule.classesInSelector) {
      let set = tokensByCssClass.get(cls);
      if (!set) {
        set = new Set();
        tokensByCssClass.set(cls, set);
      }
      for (const tok of rule.tokensConsumed) {
        set.add(tok);
      }
    }
  }

  const allUsedCssClasses = new Set<string>();
  const allDynamicClassPrefixes = new Set<string>();
  for (const scanned of scannedFiles.values()) {
    for (const b of scanned.functionsAndClasses.values()) {
      for (const c of b.cssClassesUsed) allUsedCssClasses.add(c);
      for (const p of b.dynamicClassPrefixes) allDynamicClassPrefixes.add(p);
    }
  }

  const unusedCssSelectors: Array<{
    selector: string;
    filePath: string;
    lineNumber: number;
  }> = [];
  for (const rule of allStyleRules) {
    if (rule.classesInSelector.length === 0) continue;
    const anyClassUsed = rule.classesInSelector.some((cls) => {
      if (allUsedCssClasses.has(cls)) return true;
      if (matchesDynamicPrefix(cls, allDynamicClassPrefixes)) return true;
      const baseBem = cls.split("--")[0];
      if (
        baseBem !== cls &&
        allUsedCssClasses.has(baseBem) &&
        matchesDynamicPrefix(cls, allDynamicClassPrefixes)
      ) {
        return true;
      }
      return false;
    });
    if (!anyClassUsed) {
      unusedCssSelectors.push({
        selector: rule.selector,
        filePath: rule.filePath,
        lineNumber: rule.lineNumber,
      });
    }
  }

  // 11. Build Per-Component `ComponentDesignProfile`s anchored to `graph.nodes`
  const nodeById = new Map<string, StructuralNode>();
  const deploymentUnitsById = new Map<string, StructuralNode>();
  for (const n of ctx.graph.nodes) {
    nodeById.set(n.id, n);
    if (n.entityType === "DEPLOYMENT_UNIT") {
      deploymentUnitsById.set(n.id, n);
    }
  }

  const resolvePackageLabel = (node: StructuralNode): string => {
    let curr: StructuralNode | undefined = node;
    const visited = new Set<string>();
    while (curr && !visited.has(curr.id)) {
      visited.add(curr.id);
      if (curr.entityType === "DEPLOYMENT_UNIT") {
        return cleanNodeDisplayLabel(curr.name).replace(/^@[^/]+\//, "");
      }
      curr = curr.parentBoundaryId
        ? nodeById.get(curr.parentBoundaryId)
        : undefined;
    }
    const ev = getPrimaryNodeEvidence(node);
    if (ev.filePath) {
      const owning = scope.packages
        .filter((p) => p.dir !== "." && ev.filePath!.startsWith(`${p.dir}/`))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      if (owning) {
        return owning.name?.replace(/^@[^/]+\//, "") ?? basename(owning.dir);
      }
    }
    return ctx.repoName;
  };

  const realGraphNodeIds = new Set<string>(ctx.graph.nodes.map((n) => n.id));

  // Group graph CONTRACT / CLASS nodes by their source file
  const contractsByFile = new Map<string, StructuralNode[]>();
  for (const n of ctx.graph.nodes) {
    if (
      n.entityType === "DEPLOYMENT_UNIT" ||
      n.entityType === "INIT_BLOCK" ||
      n.entityType === "EXTERNAL_PACKAGE" ||
      n.entityType === "NODE_BUILTIN" ||
      n.entityType === "EXPORTED_TYPE" ||
      n.entityType === "NEXTJS_METADATA"
    ) {
      continue;
    }
    const ev = getPrimaryNodeEvidence(n);
    if (!ev.filePath || !scannedFiles.has(ev.filePath)) continue;
    let list = contractsByFile.get(ev.filePath);
    if (!list) {
      list = [];
      contractsByFile.set(ev.filePath, list);
    }
    list.push(n);
  }

  // Synthesize internal file-level component contracts for preprocessed UI files (e.g. `.svelte`,
  // or `.vue`/`.astro`/`.mdx` when invoked without L0 contracts) so they participate in profiling
  // and `UI_ROLE_CONVENTIONS` without writing unanchored overlays to `entity_overlays`.
  for (const uiFile of uiComponentFiles) {
    if (contractsByFile.has(uiFile) || !scannedFiles.has(uiFile)) continue;
    let owningBoundaryId: string | undefined;
    let bestDirLen = -1;
    for (const du of deploymentUnitsById.values()) {
      const duEv = getPrimaryNodeEvidence(du);
      const duDir = duEv.filePath ? dirname(duEv.filePath) : ".";
      const matches =
        duDir === "." ? true : uiFile === duDir || uiFile.startsWith(`${duDir}/`);
      if (matches && duDir.length > bestDirLen) {
        bestDirLen = duDir.length;
        owningBoundaryId = du.id;
      }
    }
    const syntheticName = deriveComponentNameFromPath(uiFile);
    const syntheticId = `ui-file:${createHash("sha256").update(uiFile).digest("hex").slice(0, 12)}`;
    const syntheticNode: StructuralNode = {
      id: syntheticId,
      name: `Exported Function: ${syntheticName}`,
      type: "CONTRACT",
      entityType: "EXPORTED_FUNCTION",
      patternId: "contract.exported-function",
      ...(owningBoundaryId ? { parentBoundaryId: owningBoundaryId } : {}),
      scope: "USER",
      evidence: { filePath: uiFile, lineNumber: 1 },
    } as StructuralNode;
    contractsByFile.set(uiFile, [syntheticNode]);
  }

  const componentProfiles: ComponentDesignProfile[] = [];
  const contractNodeById = new Map<string, StructuralNode>();
  /** Per-profile structural facts needed for post-classification composability checks. */
  const compositionFactsById = new Map<
    string,
    {
      root?: NonNullable<ScannedFileAstResult["functionsAndClasses"] extends Map<string, infer B> ? B : never>["rootElement"];
      imports: string[];
    }
  >();
  /** Primary contract per file (page/layout/first exported function) for path-convention matching. */
  const primaryContractIdByFile = new Map<string, string>();

  for (const [filePath, fileContracts] of contractsByFile.entries()) {
    const scanned = scannedFiles.get(filePath);
    if (!scanned) continue;

    fileContracts.sort(
      (a, b) =>
        (getPrimaryNodeEvidence(a).lineNumber ?? 0) -
        (getPrimaryNodeEvidence(b).lineNumber ?? 0)
    );

    const buckets = [...scanned.functionsAndClasses.values()].filter(
      (b) => b.name !== "__module__"
    );
    const assignedBucketNames = new Set<string>();

    const matchBucketForNode = (node: StructuralNode) => {
      const cleanName = cleanNodeDisplayLabel(node.name);
      const compMetaName =
        typeof (node.metadata as any)?.componentName === "string"
          ? (node.metadata as any).componentName
          : undefined;
      const evLine = getPrimaryNodeEvidence(node).lineNumber;

      for (const b of buckets) {
        if (b.name === cleanName || (compMetaName && b.name === compMetaName)) {
          assignedBucketNames.add(b.name);
          return b;
        }
      }
      if (evLine !== undefined) {
        for (const b of buckets) {
          if (Math.abs(b.lineNumber - evLine) <= 2) {
            assignedBucketNames.add(b.name);
            return b;
          }
        }
      }
      if (isPreprocessedUiComponentFile(filePath) && fileContracts.length === 1 && buckets.length > 0) {
        const derivedName = deriveComponentNameFromPath(filePath);
        const chosen = buckets.find((b) => b.name === derivedName) ?? buckets[0];
        assignedBucketNames.add(chosen.name);
        return chosen;
      }
      return undefined;
    };

    const matchedBucketsByNodeId = new Map<
      string,
      Array<NonNullable<ReturnType<typeof matchBucketForNode>>>
    >();

    for (const contract of fileContracts) {
      const primary = matchBucketForNode(contract);
      matchedBucketsByNodeId.set(contract.id, primary ? [primary] : []);
    }

    // Attribute any private helper buckets in the same file plus `__module__` constants
    // to the file's primary exported contract (using framework-agnostic convention matching)
    if (fileContracts.length > 0) {
      const isStructural = (c: StructuralNode, allowPath: boolean) => {
        const conv = matchUiRoleConvention(c, filePath, {
          allowPathMatchForStructuralRoles: allowPath,
        });
        return conv?.role === "ROUTE" || conv?.role === "TEMPLATE";
      };
      const fileStem = basename(filePath).replace(/\.[^.]+$/, "").toLowerCase();
      // Prefer a contract the extractor already typed as a page/layout; then the one named like the
      // file; only then fall back to file-path conventions (so helpers in `page.tsx` are not pages).
      const primaryContract =
        fileContracts.find((c) => isStructural(c, false)) ??
        fileContracts.find(
          (c) =>
            isStructural(c, true) &&
            cleanNodeDisplayLabel(c.name).toLowerCase() === fileStem
        ) ??
        fileContracts.find((c) => isStructural(c, true)) ??
        fileContracts.find((c) => c.entityType === "EXPORTED_FUNCTION") ??
        fileContracts[0];
      primaryContractIdByFile.set(filePath, primaryContract.id);
      const primaryList = matchedBucketsByNodeId.get(primaryContract.id) ?? [];

      const modBucket = scanned.functionsAndClasses.get("__module__");
      if (modBucket && fileContracts.length === 1) {
        primaryList.push(modBucket);
      }

      for (const b of buckets) {
        if (!assignedBucketNames.has(b.name)) {
          primaryList.push(b);
          assignedBucketNames.add(b.name);
        }
      }
      matchedBucketsByNodeId.set(primaryContract.id, primaryList);
    }

    for (const contract of fileContracts) {
      const nodeBuckets = matchedBucketsByNodeId.get(contract.id) ?? [];
      if (nodeBuckets.length === 0) continue;

      let jsxDomElementCount = 0;
      let jsxCustomComponentCount = 0;
      let stateHookCount = 0;
      let propContract: ComponentPropSignature[] = [];
      const jsxCallSites: JsxCallSiteRecord[] = [];
      const jsxSkeletons: JsxSkeletonOccurrence[] = [];
      const stylingConventions = new Set<StylingConvention>();
      const cssClassesUsed = new Set<string>();
      const dynamicClassPrefixes = new Set<string>();
      const tokensConsumed = new Set<string>();
      const arbitraryTailwind: ArbitraryTailwindOccurrence[] = [];
      const primitiveScaleSkips: PrimitiveScaleSkipOccurrence[] = [];
      const inlineStyleLiterals: InlineStyleLiteralOccurrence[] = [];
      let usesSlotRecorder = false;
      let canvasCssCount = 0;
      let canvasTsConstCount = 0;
      let canvasLiteralCount = 0;
      const canvasLiterals: CanvasLiteralOccurrence[] = [];
      const rawDomPrimitives: RawDomPrimitiveOccurrence[] = [];
      const renderedComponents = new Set<string>();
      const domTags = new Set<string>();
      const literalValues: LiteralValueOccurrence[] = [];
      const invariantViolations: InvariantViolation[] = [];
      let rootElement = nodeBuckets.find((b) => b.rootElement)?.rootElement;
      let tailwindUtilityCount = 0;

      for (const b of nodeBuckets) {
        tailwindUtilityCount += b.tailwindUtilityCount;
        for (const t of b.domTags) domTags.add(t);
        literalValues.push(...b.literalValues);
        invariantViolations.push(...b.invariantViolations);
        for (const c of b.paletteClassCandidates) {
          if (!rawPalettes.has(c.palette.toLowerCase())) continue;
          const prim = [`--${c.palette}-${c.step}`, `--color-${c.palette}-${c.step}`].find((n) =>
            definedTokenNames.has(n)
          );
          const sem = semanticSuggestionFor(prim);
          primitiveScaleSkips.push({
            tokenOrClass: c.className,
            kind: "tailwind-primitive",
            suggestedSemantic: sem
              ? `Use ${sem}`
              : `Use a semantic token instead of raw palette step '${c.palette}-${c.step}'`,
            filePath: c.filePath,
            lineNumber: c.lineNumber,
            snippet: c.snippet,
          });
        }
        for (const r of b.tsTokenRefs) {
          if (!primitiveColorTokenNames.has(r.name)) continue;
          const sem = semanticSuggestionFor(r.name);
          primitiveScaleSkips.push({
            tokenOrClass: `var(${r.name})`,
            kind: "css-primitive-var",
            suggestedSemantic: sem
              ? `Use ${sem}`
              : "Reference a semantic token instead of a primitive token in component code",
            filePath: r.filePath,
            lineNumber: r.lineNumber,
            snippet: r.snippet,
          });
        }
        jsxDomElementCount += b.jsxDomElementCount;
        jsxCustomComponentCount += b.jsxCustomComponentCount;
        stateHookCount += b.stateHookCount;
        if (propContract.length === 0 && b.propContract.length > 0) {
          propContract = b.propContract;
        }
        jsxCallSites.push(...b.jsxCallSites);
        jsxSkeletons.push(...b.jsxSkeletons);
        for (const c of b.stylingConventions) stylingConventions.add(c);
        for (const cls of b.cssClassesUsed) {
          cssClassesUsed.add(cls);
          const clsTokens = tokensByCssClass.get(cls);
          if (clsTokens) {
            for (const t of clsTokens) tokensConsumed.add(t);
          }
        }
        for (const p of b.dynamicClassPrefixes) dynamicClassPrefixes.add(p);
        for (const t of b.tokensConsumed) tokensConsumed.add(t);
        arbitraryTailwind.push(...b.arbitraryTailwind);
        primitiveScaleSkips.push(...b.primitiveScaleSkips);
        inlineStyleLiterals.push(...b.inlineStyleLiterals);
        if (b.usesSlotRecorder) usesSlotRecorder = true;
        canvasCssCount += b.canvasCssCount;
        canvasTsConstCount += b.canvasTsConstCount;
        canvasLiteralCount += b.canvasLiteralCount;
        canvasLiterals.push(...b.canvasLiterals);
        rawDomPrimitives.push(...b.rawDomPrimitives);
        for (const rc of b.renderedComponents) renderedComponents.add(rc);
      }

      const ev = getPrimaryNodeEvidence(contract);
      const resolvedFilePath = ev.filePath ?? filePath;
      const matchedConvention = matchUiRoleConvention(contract, resolvedFilePath);

      const hasAnyDesignSignal =
        Boolean(matchedConvention) ||
        jsxDomElementCount > 0 ||
        jsxCustomComponentCount > 0 ||
        stylingConventions.size > 0 ||
        tokensConsumed.size > 0 ||
        arbitraryTailwind.length > 0 ||
        primitiveScaleSkips.length > 0 ||
        inlineStyleLiterals.length > 0 ||
        usesSlotRecorder ||
        rawDomPrimitives.length > 0 ||
        renderedComponents.size > 0;

      if (!hasAnyDesignSignal) continue;

      const compUndefinedTokens = undefinedTokens.filter((u) =>
        tokensConsumed.has(u.name)
      );
      const atomicCandidates = Array.from(
        new Set(rawDomPrimitives.map((r) => r.atomicTarget))
      );

      contractNodeById.set(contract.id, contract);
      const rawCleanLabel = cleanNodeDisplayLabel(contract.name);
      const profileLabel =
        isPreprocessedUiComponentFile(resolvedFilePath) &&
        /^(?:__(?:VueSfc|Astro|Mdx)(?:Component|Template)__|default)$/i.test(rawCleanLabel)
          ? deriveComponentNameFromPath(resolvedFilePath)
          : rawCleanLabel;
      const profile: ComponentDesignProfile = {
        entityId: contract.id,
        name: contract.name,
        label: profileLabel,
        entityType: contract.entityType,
        packageName: resolvePackageLabel(contract),
        filePath: resolvedFilePath,
        lineNumber: ev.lineNumber,
        atomicTier: "MOLECULE", // Finalized in Stage 1 after RENDERS graph topology resolution
        classificationSource: "ast-footprint",
        rendersInDegree: 0,
        rendersOutDegree: 0,
        jsxDomElementCount,
        jsxCustomComponentCount,
        stateHookCount,
        propContract,
        jsxCallSites,
        jsxSkeletons,
        usedInRoutes: [],
        stylingConventions: [...stylingConventions],
        cssClassesUsed: [...cssClassesUsed].sort(),
        dynamicClassPrefixes: [...dynamicClassPrefixes].sort(),
        tokensConsumed: [...tokensConsumed].sort(),
        undefinedTokens: compUndefinedTokens,
        arbitraryTailwind,
        primitiveScaleSkips,
        inlineStyleLiterals,
        canvasProvenance: {
          usesSlotRecorder,
          cssCount: canvasCssCount,
          tsConstCount: canvasTsConstCount,
          literalCount: canvasLiteralCount,
          literals: canvasLiterals,
        },
        rawDomPrimitives,
        atomicCandidates,
        renderedComponents: [...renderedComponents].sort(),
        domTags: [...domTags].sort(),
        tailwindUtilityCount,
        variantAxes: scanned.variantAxes,
        literalValues,
        invariantViolations,
        composabilityIssues: [],
      };

      compositionFactsById.set(contract.id, {
        root: rootElement,
        imports: scanned.importedModules,
      });
      componentProfiles.push(profile);
    }
  }

  // -------------------------------------------------------------------------
  // 12. Stage 1 — Atomic Hierarchy Classification (`UI_ROLE_CONVENTIONS` + `RENDERS` Topology + AST Footprint)
  // -------------------------------------------------------------------------
  const profileById = new Map<string, ComponentDesignProfile>();
  const profilesByFile = new Map<string, ComponentDesignProfile[]>();
  const profilesByLabelAll = new Map<string, ComponentDesignProfile[]>();
  const addProfileLabelIndex = (labelKey: string, p: ComponentDesignProfile) => {
    let list = profilesByLabelAll.get(labelKey);
    if (!list) {
      list = [];
      profilesByLabelAll.set(labelKey, list);
    }
    if (!list.some((x) => x.entityId === p.entityId)) {
      list.push(p);
    }
  };

  for (const p of componentProfiles) {
    profileById.set(p.entityId, p);
    let fileList = profilesByFile.get(p.filePath);
    if (!fileList) {
      fileList = [];
      profilesByFile.set(p.filePath, fileList);
    }
    fileList.push(p);
    addProfileLabelIndex(p.label, p);
    const contract = contractNodeById.get(p.entityId);
    const compMetaName =
      typeof (contract?.metadata as any)?.componentName === "string"
        ? (contract?.metadata as any).componentName
        : undefined;
    if (compMetaName) {
      addProfileLabelIndex(compMetaName, p);
    }
  }

  // Workspace package name → directory index for cross-package import resolution
  const workspacePkgDirByName = new Map<string, string>();
  for (const pkg of scope.packages) {
    if (pkg.name) workspacePkgDirByName.set(pkg.name, pkg.dir);
  }
  for (const f of ctx.files) {
    if (f !== "package.json" && !f.endsWith("/package.json")) continue;
    const raw = ctx.readFile(f);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name && !workspacePkgDirByName.has(parsed.name)) {
        workspacePkgDirByName.set(parsed.name, f === "package.json" ? "." : dirname(f));
      }
    } catch {
      // ignore malformed package.json
    }
  }
  const sortedWorkspacePackages = [...workspacePkgDirByName.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );

  const MODULE_PROBE_SUFFIXES = [
    "",
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    ".vue",
    ".svelte",
    ".astro",
    ".mdx",
    "/index.tsx",
    "/index.ts",
    "/index.jsx",
    "/index.js",
    "/index.vue",
    "/index.svelte",
    "/index.astro",
    "/index.mdx",
  ];

  const resolveSpecifierToFiles = (fromFile: string, specifier: string): string[] => {
    const hits = new Set<string>();
    const probeBase = (rawBase: string) => {
      const clean = rawBase.replace(/\/+$/, "");
      if (!clean || clean.startsWith("..")) return;
      for (const suffix of MODULE_PROBE_SUFFIXES) {
        const cand = `${clean}${suffix}`;
        if (scannedFiles.has(cand)) hits.add(cand);
      }
      if (/\.(?:m?js|jsx)$/i.test(clean)) {
        const stem = clean.replace(/\.(?:m?js|jsx)$/i, "");
        for (const suffix of MODULE_PROBE_SUFFIXES) {
          const cand = `${stem}${suffix}`;
          if (scannedFiles.has(cand)) hits.add(cand);
        }
      }
    };

    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      probeBase(posixPath.normalize(posixPath.join(posixPath.dirname(fromFile), specifier)));
      return [...hits];
    }

    if (specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#/")) {
      const sub = specifier.slice(2);
      const owningPkg = scope.packages
        .filter((p) => p.dir !== "." && (fromFile === p.dir || fromFile.startsWith(`${p.dir}/`)))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      if (owningPkg) {
        probeBase(posixPath.normalize(`${owningPkg.dir}/src/${sub}`));
        probeBase(posixPath.normalize(`${owningPkg.dir}/${sub}`));
      }
      probeBase(posixPath.normalize(`src/${sub}`));
      probeBase(posixPath.normalize(sub));
      return [...hits];
    }

    for (const [pkgName, pkgDir] of sortedWorkspacePackages) {
      if (specifier === pkgName) {
        probeBase(pkgDir === "." ? "src/index" : `${pkgDir}/src/index`);
        probeBase(pkgDir === "." ? "index" : `${pkgDir}/index`);
        if (hits.size > 0) return [...hits];
      } else if (specifier.startsWith(`${pkgName}/`)) {
        const sub = specifier.slice(pkgName.length + 1);
        probeBase(pkgDir === "." ? `src/${sub}` : `${pkgDir}/src/${sub}`);
        probeBase(pkgDir === "." ? sub : `${pkgDir}/${sub}`);
        if (hits.size > 0) return [...hits];
      }
    }

    if (!specifier.startsWith("@")) {
      const owningPkg = scope.packages
        .filter((p) => p.dir !== "." && (fromFile === p.dir || fromFile.startsWith(`${p.dir}/`)))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      if (owningPkg) {
        probeBase(posixPath.normalize(`${owningPkg.dir}/src/${specifier}`));
        probeBase(posixPath.normalize(`${owningPkg.dir}/${specifier}`));
      }
      probeBase(posixPath.normalize(`src/${specifier}`));
      probeBase(posixPath.normalize(specifier));
    }

    return [...hits];
  };

  const resolveExportedProfilesFromFile = (
    targetFile: string,
    exportedName: string,
    visited = new Set<string>()
  ): ComponentDesignProfile[] => {
    const visitKey = `${targetFile}::${exportedName}`;
    if (visited.has(visitKey) || visited.size > 10) return [];
    visited.add(visitKey);

    const fileProfiles = profilesByFile.get(targetFile) ?? [];
    if (exportedName === "default") {
      if (fileProfiles.length === 1) return [fileProfiles[0]];
      const primId = primaryContractIdByFile.get(targetFile);
      const prim = primId ? profileById.get(primId) : undefined;
      if (prim && prim.filePath === targetFile) return [prim];
      if (fileProfiles.length > 0) return [fileProfiles[0]];
    } else if (exportedName === "*") {
      if (fileProfiles.length > 0) return [...fileProfiles];
    } else {
      const direct = fileProfiles.filter(
        (p) => p.label === exportedName || cleanNodeDisplayLabel(p.name) === exportedName
      );
      if (direct.length > 0) return direct;
      if (isPreprocessedUiComponentFile(targetFile) && fileProfiles.length === 1) {
        return [fileProfiles[0]];
      }
    }

    const reExports = scannedFiles.get(targetFile)?.reExports ?? [];
    const out: ComponentDesignProfile[] = [];
    const pushUnique = (items: ComponentDesignProfile[]) => {
      for (const item of items) {
        if (!out.some((x) => x.entityId === item.entityId)) out.push(item);
      }
    };
    for (const re of reExports) {
      if (re.exportedName === "*" && exportedName !== "default") {
        for (const sf of resolveSpecifierToFiles(targetFile, re.specifier)) {
          pushUnique(resolveExportedProfilesFromFile(sf, exportedName, visited));
        }
      } else if (re.exportedName === exportedName) {
        for (const sf of resolveSpecifierToFiles(targetFile, re.specifier)) {
          pushUnique(resolveExportedProfilesFromFile(sf, re.sourceName || exportedName, visited));
        }
      }
    }
    return out;
  };

  // Build unified `RENDERS` adjacency list combining `@chomp/core` `RENDERS` edges and import-resolved `renderedComponents`
  const rendersChildrenById = new Map<string, Set<string>>();
  const rendersParentsById = new Map<string, Set<string>>();
  const graphRendersTargetsBySrc = new Map<string, ComponentDesignProfile[]>();
  for (const p of componentProfiles) {
    rendersChildrenById.set(p.entityId, new Set());
    rendersParentsById.set(p.entityId, new Set());
  }

  const addRendersLink = (parentId: string, childId: string) => {
    if (parentId === childId) return;
    if (!profileById.has(parentId) || !profileById.has(childId)) return;
    rendersChildrenById.get(parentId)!.add(childId);
    rendersParentsById.get(childId)!.add(parentId);
  };

  for (const edge of ctx.graph.edges) {
    if (edge.entityType === "RENDERS" || (edge as any).type === "RENDERS") {
      const src = edge.sourceId ?? (edge as any).source;
      const tgt = edge.targetId ?? (edge as any).target;
      if (src && tgt) {
        addRendersLink(src, tgt);
        const tgtProf = profileById.get(tgt);
        if (tgtProf) {
          let list = graphRendersTargetsBySrc.get(src);
          if (!list) {
            list = [];
            graphRendersTargetsBySrc.set(src, list);
          }
          if (!list.some((x) => x.entityId === tgtProf.entityId)) {
            list.push(tgtProf);
          }
        }
      }
    }
  }

  const resolveTargetProfile = (
    callerProfile: ComponentDesignProfile,
    rawTagName: string
  ): ComponentDesignProfile | undefined => {
    const rootIdent = rawTagName.split(".")[0];
    const memberIdent = rawTagName.includes(".")
      ? rawTagName.split(".").slice(1).join(".")
      : undefined;

    // 1. Check explicit imports in caller's file first so same-named components across files never collide
    const binding = scannedFiles.get(callerProfile.filePath)?.importedBindings.get(rootIdent);
    if (binding) {
      const lookupExport = binding.importedName === "*" ? (memberIdent ?? "*") : binding.importedName;
      const targetFiles = resolveSpecifierToFiles(callerProfile.filePath, binding.specifier);
      for (const tf of targetFiles) {
        const found = resolveExportedProfilesFromFile(tf, lookupExport);
        if (found.length > 0) return found[0];
      }
      // Also check if graph RENDERS edges already resolved this imported binding to a target profile
      const graphTargets = graphRendersTargetsBySrc.get(callerProfile.entityId) ?? [];
      if (targetFiles.length > 0) {
        const graphHit = graphTargets.find((tp) => targetFiles.includes(tp.filePath));
        if (graphHit) return graphHit;
      }
      // Explicitly imported from an external package or unprofiled module — never fall back to a same-named local component
      return undefined;
    }

    // 2. Check graph RENDERS edge targets from this caller
    const graphTargets = graphRendersTargetsBySrc.get(callerProfile.entityId) ?? [];
    const directGraphHit = graphTargets.find(
      (tp) => tp.label === rawTagName || tp.label === rootIdent
    );
    if (directGraphHit) return directGraphHit;

    // 3. Same-file sibling component declaration
    const sameFileHit = (profilesByFile.get(callerProfile.filePath) ?? []).find(
      (p) =>
        p.entityId !== callerProfile.entityId &&
        (p.label === rawTagName || p.label === rootIdent)
    );
    if (sameFileHit) return sameFileHit;

    // 4. Unimported / auto-imported component: link only when unambiguous
    const candidates = (
      profilesByLabelAll.get(rawTagName) ??
      profilesByLabelAll.get(rootIdent) ??
      []
    ).filter((p) => p.entityId !== callerProfile.entityId);
    if (candidates.length === 1) return candidates[0];
    const samePkg = candidates.filter((p) => p.packageName === callerProfile.packageName);
    if (samePkg.length === 1) return samePkg[0];
    return undefined;
  };

  for (const p of componentProfiles) {
    for (const rcName of p.renderedComponents) {
      const targetProfile = resolveTargetProfile(p, rcName);
      if (targetProfile) {
        addRendersLink(p.entityId, targetProfile.entityId);
      }
    }
  }

  const tierCounts: Record<AtomicTier, number> = {
    ROUTE: 0,
    TEMPLATE: 0,
    ORGANISM: 0,
    MOLECULE: 0,
    ATOM: 0,
    UTILITY: 0,
  };
  const conventionMatchMap = new Map<
    string,
    { conventionId: string; framework: string; role: AtomicTier; matchCount: number }
  >();
  const byTier: AtomicHierarchySummary["byTier"] = {
    ROUTE: [],
    TEMPLATE: [],
    ORGANISM: [],
    MOLECULE: [],
    ATOM: [],
    UTILITY: [],
  };

  for (const p of componentProfiles) {
    p.rendersInDegree = rendersParentsById.get(p.entityId)?.size ?? 0;
    p.rendersOutDegree = rendersChildrenById.get(p.entityId)?.size ?? 0;
    const contract = contractNodeById.get(p.entityId)!;
    const classified = classifyAtomicTier({
      node: contract,
      filePath: p.filePath,
      jsxDomElementCount: p.jsxDomElementCount,
      jsxCustomComponentCount: p.jsxCustomComponentCount,
      stateHookCount: p.stateHookCount,
      rendersInDegree: p.rendersInDegree,
      rendersOutDegree: p.rendersOutDegree,
      isPrimaryInFile:
        primaryContractIdByFile.get(
          getPrimaryNodeEvidence(contract).filePath ?? p.filePath
        ) === p.entityId,
    });
    p.atomicTier = classified.atomicTier;
    p.classificationSource = classified.classificationSource;
    if (classified.convention) {
      p.conventionId = classified.convention.id;
      const existing = conventionMatchMap.get(classified.convention.id);
      if (existing) {
        existing.matchCount++;
      } else {
        conventionMatchMap.set(classified.convention.id, {
          conventionId: classified.convention.id,
          framework: classified.convention.framework,
          role: classified.convention.role,
          matchCount: 1,
        });
      }
    }

    tierCounts[p.atomicTier]++;
    byTier[p.atomicTier].push({
      entityId: p.entityId,
      label: p.label,
      filePath: p.filePath,
      lineNumber: p.lineNumber,
      rendersInDegree: p.rendersInDegree,
      rendersOutDegree: p.rendersOutDegree,
      domElements: p.jsxDomElementCount,
      customChildren: p.jsxCustomComponentCount,
      propCount: p.propContract.length,
      classificationSource: p.classificationSource,
    });
  }

  const atomicHierarchy: AtomicHierarchySummary = {
    tierCounts,
    conventionsMatched: [...conventionMatchMap.values()],
    byTier,
  };

  // -------------------------------------------------------------------------
  // 13. Stage 2 — Route Composition Trees (`Route → Template → Organism → Molecule → Atom`)
  // -------------------------------------------------------------------------
  const routeProfiles = componentProfiles.filter((p) => p.atomicTier === "ROUTE");
  const templateProfiles = componentProfiles.filter(
    (p) => p.atomicTier === "TEMPLATE"
  );

  // First pass: find all reachable components for each route so we can compute shared vs route-exclusive
  const reachableByRouteId = new Map<string, Set<string>>();
  for (const route of routeProfiles) {
    const visited = new Set<string>();
    const walk = (currId: string, depth: number) => {
      if (depth > 6 || visited.has(currId)) return;
      visited.add(currId);
      const children = rendersChildrenById.get(currId);
      if (children) {
        for (const childId of children) {
          walk(childId, depth + 1);
        }
      }
    };
    walk(route.entityId, 0);
    visited.delete(route.entityId);
    reachableByRouteId.set(route.entityId, visited);

    for (const compId of visited) {
      const compProf = profileById.get(compId);
      if (compProf && !compProf.usedInRoutes.includes(route.label)) {
        compProf.usedInRoutes.push(route.label);
      }
    }
    if (!route.usedInRoutes.includes(route.label)) {
      route.usedInRoutes.push(route.label);
    }
  }

  const routeComposition: RouteCompositionItem[] = [];
  for (const route of routeProfiles) {
    const reachableIds = reachableByRouteId.get(route.entityId) ?? new Set<string>();
    const routeDir = dirname(route.filePath);
    const enclosingTemplateProfiles = templateProfiles.filter((tpl) => {
      const tplDir = dirname(tpl.filePath);
      return routeDir === tplDir || routeDir.startsWith(`${tplDir}/`);
    });
    const enclosingTemplates = enclosingTemplateProfiles.map((tpl) => tpl.label);

    for (const tplProf of enclosingTemplateProfiles) {
      if (!tplProf.usedInRoutes.includes(route.label)) {
        tplProf.usedInRoutes.push(route.label);
      }
    }

    const buildTreeNode = (
      entityId: string,
      ancestors: Set<string>
    ): RouteCompositionTreeNode => {
      const prof = profileById.get(entityId)!;
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(entityId);
      const childIds = [...(rendersChildrenById.get(entityId) ?? [])].filter(
        (cid) => !nextAncestors.has(cid) && profileById.has(cid)
      );
      return {
        entityId: prof.entityId,
        label: prof.label,
        atomicTier: prof.atomicTier,
        filePath: prof.filePath,
        children: childIds.map((cid) => buildTreeNode(cid, nextAncestors)),
      };
    };

    const compositionTree = buildTreeNode(route.entityId, new Set());
    const templates = [...enclosingTemplates];
    const organisms: string[] = [];
    const molecules: string[] = [];
    const atoms: string[] = [];
    const utilities: string[] = [];
    const sharedComponentsUsed: string[] = [];
    const routeExclusiveComponents: string[] = [];

    let subtreeDomElements = route.jsxDomElementCount;
    let subtreeCustomComponents = route.jsxCustomComponentCount;
    let subtreeRawDomPrimitives = route.rawDomPrimitives.length;

    for (const cid of reachableIds) {
      const cp = profileById.get(cid);
      if (!cp) continue;
      if (cp.atomicTier === "TEMPLATE" && !templates.includes(cp.label)) {
        templates.push(cp.label);
      } else if (cp.atomicTier === "ORGANISM") {
        organisms.push(cp.label);
      } else if (cp.atomicTier === "MOLECULE") {
        molecules.push(cp.label);
      } else if (cp.atomicTier === "ATOM") {
        atoms.push(cp.label);
      } else if (cp.atomicTier === "UTILITY") {
        utilities.push(cp.label);
      }

      if (cp.usedInRoutes.length >= 2 || cp.rendersInDegree >= 2) {
        sharedComponentsUsed.push(cp.label);
      } else {
        routeExclusiveComponents.push(cp.label);
      }

      subtreeDomElements += cp.jsxDomElementCount;
      subtreeCustomComponents += cp.jsxCustomComponentCount;
      if (cp.atomicTier !== "ATOM") {
        subtreeRawDomPrimitives += cp.rawDomPrimitives.length;
      }
    }

    // Composition ratio measures how much of the route's UI is delegated to composed components vs raw inline primitives
    const totalBuildingBlocks =
      reachableIds.size +
      subtreeCustomComponents +
      Math.max(route.jsxDomElementCount, route.rawDomPrimitives.length);
    const compositionRatio =
      totalBuildingBlocks > 0
        ? Math.round(
            ((reachableIds.size + subtreeCustomComponents) /
              (totalBuildingBlocks + route.rawDomPrimitives.length)) *
              100
          ) / 100
        : 1;

    const routeSmells: RouteCompositionItem["routeSmells"] = [];
    if (route.jsxDomElementCount >= 25 && reachableIds.size <= 1) {
      routeSmells.push({
        code: "MONOLITHIC_ROUTE",
        severity: "WARN",
        message: `Route '${route.label}' inline-renders ${route.jsxDomElementCount} raw DOM elements with only ${reachableIds.size} composed child component(s); extract feature sections into Organisms/Molecules.`,
      });
    }
    if (
      routeProfiles.length >= 2 &&
      reachableIds.size > 0 &&
      sharedComponentsUsed.length === 0
    ) {
      routeSmells.push({
        code: "ISOLATED_ROUTE_VOCABULARY",
        severity: "INFO",
        message: `Route '${route.label}' shares 0 UI components with other routes (${routeExclusiveComponents.length} route-exclusive component(s)).`,
      });
    }
    if (subtreeRawDomPrimitives >= 5) {
      routeSmells.push({
        code: "BYPASSED_ATOMS",
        severity: "WARN",
        message: `Route '${route.label}' tree contains ${subtreeRawDomPrimitives} raw DOM primitive instance(s) (<button>, role="switch", <aside>, <dl>) that bypass shared Atoms.`,
      });
    }
    if (
      (organisms.length > 0 || molecules.length > 0) &&
      atoms.length === 0 &&
      subtreeDomElements >= 15
    ) {
      routeSmells.push({
        code: "MISSING_ATOM_LAYER",
        severity: "INFO",
        message: `Route '${route.label}' composes Organisms/Molecules (${[...organisms, ...molecules].join(", ")}) directly over raw DOM without any shared Atom primitives.`,
      });
    }

    routeComposition.push({
      routeId: route.entityId,
      routeLabel: route.label,
      filePath: route.filePath,
      frameworkConvention: route.conventionId ?? "route.entry",
      enclosingTemplates,
      tierBreakdown: {
        templates,
        organisms,
        molecules,
        atoms,
        utilities,
      },
      compositionTree,
      totalReachableComponents: reachableIds.size,
      sharedComponentsUsed,
      routeExclusiveComponents,
      inlineRawDomCount: route.jsxDomElementCount,
      compositionRatio,
      routeSmells,
    });
  }

  // -------------------------------------------------------------------------
  // 14. Atom adoption & consolidation (driven by the configurable / derived atom catalog)
  // -------------------------------------------------------------------------
  const sharedNamesFor = (def: AtomDefinition): Set<string> =>
    new Set(
      [def.name, `Shared${def.name}`, ...(def.sharedComponentNames ?? [])].map((n) =>
        n.toLowerCase()
      )
    );
  const sharedNamesByAtom = new Map<string, Set<string>>(
    atomDefinitions.map((d) => [d.name, sharedNamesFor(d)])
  );

  const existingSharedByAtom = new Map<
    string,
    { name: string; filePath: string; lineNumber?: number }
  >();
  const isUiLibraryPath = (p: string) =>
    /(?:^|\/)(?:ui|atoms|primitives|design-system|components)\//i.test(p);
  const sharedCandidates: Array<{ name: string; filePath: string; lineNumber?: number }> = [];
  for (const n of ctx.graph.nodes) {
    if (n.type !== "CONTRACT") continue;
    const ev = getPrimaryNodeEvidence(n);
    if (!ev.filePath || !scannedFiles.has(ev.filePath)) continue;
    sharedCandidates.push({
      name: cleanNodeDisplayLabel(n.name),
      filePath: ev.filePath,
      lineNumber: ev.lineNumber,
    });
  }
  for (const [tsPath, tsAudit] of scannedFiles.entries()) {
    for (const [, bucket] of tsAudit.functionsAndClasses.entries()) {
      if (!bucket.isExported || bucket.name === "__module__") continue;
      sharedCandidates.push({ name: bucket.name, filePath: tsPath, lineNumber: bucket.lineNumber });
    }
  }
  for (const def of atomDefinitions) {
    const names = sharedNamesByAtom.get(def.name)!;
    const hits = sharedCandidates.filter((c) => names.has(c.name.toLowerCase()));
    const best = hits.find((h) => isUiLibraryPath(h.filePath)) ?? hits[0];
    if (best) existingSharedByAtom.set(def.name, best);
  }

  const isOwnAtomImplementation = (compLabel: string, atomName: string): boolean =>
    sharedNamesByAtom.get(atomName)?.has(compLabel.toLowerCase()) ?? false;

  const minUnshared = resolved.mode === "adhere" ? 1 : config.atoms.minUnsharedInstances;
  const atomicConsolidation: AtomicConsolidationCandidate[] = [];
  /** atomName → raw instances not belonging to the atom's own implementation. */
  const rawInstancesByAtom = new Map<
    string,
    Array<{ componentName: string; filePath: string; lineNumber: number; snippet: string }>
  >();
  let totalAdopters = 0;
  let totalReportedRaw = 0;

  for (const def of atomDefinitions) {
    const names = sharedNamesByAtom.get(def.name)!;
    const existingShared = existingSharedByAtom.get(def.name);
    const raw: Array<{
      componentName: string;
      filePath: string;
      lineNumber: number;
      snippet: string;
    }> = [];
    let adopters = 0;
    for (const comp of componentProfiles) {
      for (const rawDom of comp.rawDomPrimitives) {
        if (rawDom.atomicTarget !== def.name) continue;
        if (isOwnAtomImplementation(comp.label, def.name)) continue;
        raw.push({
          componentName: comp.label,
          filePath: rawDom.filePath,
          lineNumber: rawDom.lineNumber,
          snippet: rawDom.snippet,
        });
      }
      for (const cs of comp.jsxCallSites) {
        const resolvedTarget = resolveTargetProfile(comp, cs.targetComponent);
        if (existingShared) {
          if (resolvedTarget && resolvedTarget.filePath === existingShared.filePath) {
            adopters++;
            continue;
          }
          const rootIdent = cs.targetComponent.split(".")[0];
          const binding = scannedFiles.get(comp.filePath)?.importedBindings.get(rootIdent);
          if (binding) {
            const targetFiles = resolveSpecifierToFiles(comp.filePath, binding.specifier);
            if (targetFiles.includes(existingShared.filePath)) {
              adopters++;
            } else {
              // Check barrel re-exports to existingShared.filePath when existingShared wasn't in `ctx.graph`
              const reachesShared = targetFiles.some((tf) => {
                const reList = scannedFiles.get(tf)?.reExports ?? [];
                return reList.some((re) =>
                  resolveSpecifierToFiles(tf, re.specifier).includes(existingShared.filePath)
                );
              });
              if (reachesShared) adopters++;
            }
          } else if (!resolvedTarget && names.has(cs.targetComponent.toLowerCase())) {
            adopters++;
          }
        } else if (names.has(cs.targetComponent.toLowerCase())) {
          adopters++;
        }
      }
    }
    rawInstancesByAtom.set(def.name, raw);
    const reportable = raw.length > 0 && (Boolean(existingShared) || raw.length >= minUnshared);
    if (!reportable) continue;

    totalAdopters += adopters;
    totalReportedRaw += raw.length;
    const distinctFiles = Array.from(new Set(raw.map((i) => i.filePath))).sort();
    const adoptionRate = existingShared
      ? Math.round((adopters / Math.max(1, adopters + raw.length)) * 100)
      : null;
    atomicConsolidation.push({
      atomName: def.name,
      description: def.description ?? `Raw DOM that should be a shared <${def.name}>.`,
      instanceCount: raw.length,
      adopterCount: adopters,
      adoptionRate,
      distinctFiles,
      ...(existingShared ? { existingSharedComponent: existingShared } : {}),
      instances: raw.slice(0, 15),
      consolidationGuidance: existingShared
        ? `Replace ${raw.length} raw ${def.name}-shaped element(s) across ${distinctFiles.length} file(s) with the existing shared <${existingShared.name}> (${existingShared.filePath}); ${adopters} call site(s) already use it.`
        : `Extract a shared <${def.name}> atom from ${raw.length} raw instance(s) across ${distinctFiles.length} file(s).`,
    });
  }
  atomicConsolidation.sort(
    (a, b) => b.instanceCount - a.instanceCount || a.atomName.localeCompare(b.atomName)
  );
  const reportedAtomNames = new Set(atomicConsolidation.map((a) => a.atomName));

  // -------------------------------------------------------------------------
  // 15. Stage 3 — Cross-Route & Component Alignment Audit (`bypassedAtoms`, `parallelTwins`, `callSiteOverrides`, `propApiDrift`, invariants, composability)
  // -------------------------------------------------------------------------
  const bypassedAtoms: BypassedAtomFinding[] = [];
  for (const comp of componentProfiles) {
    // Only flag non-Atom components (`ROUTE`, `TEMPLATE`, `ORGANISM`, `MOLECULE`) that inline raw DOM primitives
    if (comp.atomicTier === "ATOM") continue;
    for (const rawDom of comp.rawDomPrimitives) {
      if (!reportedAtomNames.has(rawDom.atomicTarget)) continue;
      if (isOwnAtomImplementation(comp.label, rawDom.atomicTarget)) continue;
      const existingShared = existingSharedByAtom.get(rawDom.atomicTarget);
      bypassedAtoms.push({
        atomTarget: rawDom.atomicTarget,
        bypassingComponent: comp.label,
        bypassingTier: comp.atomicTier,
        filePath: rawDom.filePath,
        lineNumber: rawDom.lineNumber,
        snippet: rawDom.snippet,
        ...(existingShared ? { existingSharedComponent: existingShared.name } : {}),
        recommendation: existingShared
          ? `Replace raw ${rawDom.tagOrRole} in ${comp.label} with existing shared <${existingShared.name} /> (${existingShared.filePath}).`
          : `Extract raw ${rawDom.tagOrRole} in ${comp.label} into a shared <${rawDom.atomicTarget} /> Atom and compose it.`,
      });
    }
  }

  // Detect `parallelTwins`: components that share a name concept (`SubmitButton` / `NavButton` / `ActionBtn`
  // → "button") AND a similar signature (props ∪ DOM tags ∪ tokens). Concepts are derived from names, not a preset list.
  const BOILERPLATE_PROP_NAMES = new Set([
    "children",
    "className",
    "style",
    "ref",
    "key",
    "id",
  ]);
  const conceptOfLabel = (label: string): { concept: string; display: string } | null => {
    const words = label.replace(/Tw$/, "").match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z][a-z0-9]*/g);
    if (!words || words.length === 0) return null;
    const rawLast = words[words.length - 1];
    const cap = rawLast[0].toUpperCase() + rawLast.slice(1);
    const normalized = config.concepts.abbreviations[cap] ?? cap;
    return { concept: normalized.toLowerCase(), display: normalized };
  };
  const signatureOf = (p: ComponentDesignProfile): Set<string> => {
    const sig = new Set<string>();
    for (const prop of p.propContract) {
      if (!BOILERPLATE_PROP_NAMES.has(prop.name)) sig.add(`prop:${prop.name}`);
    }
    for (const t of p.domTags) sig.add(`tag:${t}`);
    for (const t of p.tokensConsumed) sig.add(`tok:${t}`);
    return sig;
  };
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };

  const parallelTwins: ParallelTwinGroup[] = [];
  const profilesByConcept = new Map<string, { display: string; profiles: ComponentDesignProfile[] }>();
  for (const p of componentProfiles) {
    if (p.atomicTier === "ROUTE" || p.atomicTier === "TEMPLATE" || p.atomicTier === "UTILITY") continue;
    if (p.jsxDomElementCount === 0 && p.rawDomPrimitives.length === 0) continue;
    const c = conceptOfLabel(p.label);
    if (!c) continue;
    let bucket = profilesByConcept.get(c.concept);
    if (!bucket) {
      bucket = { display: c.display, profiles: [] };
      profilesByConcept.set(c.concept, bucket);
    }
    bucket.profiles.push(p);
  }

  for (const [concept, { display, profiles }] of [...profilesByConcept.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    if (profiles.length < config.concepts.minGroupSize) continue;
    const memberIds = new Set(profiles.map((m) => m.entityId));
    // Exclude direct wrapper pairs (a member that already composes another member by import-resolved entityId)
    const nonTrivial = profiles.filter(
      (p) =>
        ![...(rendersChildrenById.get(p.entityId) ?? [])].some(
          (cid) => memberIds.has(cid) && cid !== p.entityId
        )
    );
    if (nonTrivial.length < config.concepts.minGroupSize) continue;

    const sigs = nonTrivial.map(signatureOf);
    let simSum = 0;
    let simPairs = 0;
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        simSum += jaccard(sigs[i], sigs[j]);
        simPairs++;
      }
    }
    const similarity = simPairs > 0 ? Math.round((simSum / simPairs) * 100) / 100 : 0;
    if (similarity < config.concepts.minSimilarity) continue;

    // Proposed unified prop API from observed prop vocabularies
    const propAgg = new Map<
      string,
      { types: Map<string, number>; usedBy: number; requiredEverywhere: boolean; variants: Set<string> }
    >();
    for (const m of nonTrivial) {
      for (const prop of m.propContract) {
        if (BOILERPLATE_PROP_NAMES.has(prop.name)) continue;
        let agg = propAgg.get(prop.name);
        if (!agg) {
          agg = { types: new Map(), usedBy: 0, requiredEverywhere: true, variants: new Set() };
          propAgg.set(prop.name, agg);
        }
        agg.usedBy++;
        agg.types.set(prop.type, (agg.types.get(prop.type) ?? 0) + 1);
        if (!prop.required) agg.requiredEverywhere = false;
        for (const v of prop.variants ?? []) agg.variants.add(v);
      }
    }
    const observedVariants: Record<string, string[]> = {};
    for (const [name, agg] of propAgg) {
      if (agg.variants.size > 0) observedVariants[name] = [...agg.variants].sort();
    }
    for (const m of nonTrivial) {
      for (const [axis, values] of Object.entries(m.variantAxes)) {
        observedVariants[axis] = [...new Set([...(observedVariants[axis] ?? []), ...values])].sort();
      }
    }
    const proposedProps = [...propAgg.entries()]
      .map(([name, agg]) => ({
        name,
        type: [...agg.types.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
        usedBy: agg.usedBy,
        required: agg.requiredEverywhere && agg.usedBy === nonTrivial.length,
      }))
      .sort((a, b) => b.usedBy - a.usedBy || a.name.localeCompare(b.name));

    const sharedSignals = [
      ...[...sigs[0]].filter((x) => sigs.every((s2) => s2.has(x))),
    ].slice(0, 6);
    const existingShared = [...existingSharedByAtom.values()].find(
      (e) => e.name.toLowerCase() === concept
    );
    const topProps = proposedProps
      .slice(0, 6)
      .map((p) => `${p.name}${p.required ? "" : "?"}`)
      .join(", ");
    parallelTwins.push({
      concept: `${display} family`,
      components: nonTrivial.map((p) => ({
        entityId: p.entityId,
        label: p.label,
        atomicTier: p.atomicTier,
        filePath: p.filePath,
        lineNumber: p.lineNumber,
      })),
      sharedSignals: sharedSignals.length > 0 ? sharedSignals : ["shared naming concept"],
      similarity,
      proposedProps,
      observedVariants,
      recommendation: existingShared
        ? `Fold ${nonTrivial.map((p) => p.label).join(", ")} into the existing <${existingShared.name}> (${existingShared.filePath}) as variants${topProps ? ` (observed props: ${topProps})` : ""}.`
        : `Merge ${nonTrivial.map((p) => p.label).join(", ")} into a single <${display}> with variants${topProps ? `; proposed props { ${topProps} }` : ""}.`,
    });
  }

  // Detect `callSiteOverrides` where a parent injects `style={{}}` or arbitrary Tailwind `[Npx]` onto a `<ChildComponent />`
  const callSiteOverrides: CallSiteOverrideFinding[] = [];
  for (const comp of componentProfiles) {
    for (const cs of comp.jsxCallSites) {
      if (
        !cs.hasInlineStyleOverride &&
        cs.arbitraryTailwindOverrides.length === 0
      ) {
        continue;
      }
      const overrideKind: CallSiteOverrideFinding["overrideKind"] =
        cs.hasInlineStyleOverride && cs.arbitraryTailwindOverrides.length > 0
          ? "both"
          : cs.hasInlineStyleOverride
            ? "inline-style"
            : "arbitrary-tailwind";
      const details: string[] = [];
      if (cs.inlineStyleProps.length > 0) {
        details.push(`style={{ ${cs.inlineStyleProps.join(", ")} }}`);
      }
      if (cs.arbitraryTailwindOverrides.length > 0) {
        details.push(
          `className arbitrary: ${cs.arbitraryTailwindOverrides.join(", ")}`
        );
      }
      callSiteOverrides.push({
        parentComponent: comp.label,
        childComponent: cs.targetComponent,
        filePath: cs.filePath,
        lineNumber: cs.lineNumber,
        snippet: cs.snippet,
        overrideKind,
        details,
      });
    }
  }

  // Detect `propApiDrift`: configured synonym families plus spelling drift derived from the repo's own prop vocabulary
  const formatDisambiguatedComponentName = (prof: ComponentDesignProfile): string =>
    (profilesByLabelAll.get(prof.label)?.length ?? 0) > 1
      ? `${prof.label} (${prof.filePath})`
      : prof.label;

  const propUsers = new Map<string, Set<string>>();
  for (const comp of componentProfiles) {
    const compKey = formatDisambiguatedComponentName(comp);
    for (const prop of comp.propContract) {
      let set = propUsers.get(prop.name);
      if (!set) {
        set = new Set();
        propUsers.set(prop.name, set);
      }
      set.add(compKey);
    }
    for (const cs of comp.jsxCallSites) {
      const resolvedTarget = resolveTargetProfile(comp, cs.targetComponent);
      const rootIdent = cs.targetComponent.split(".")[0];
      const binding = scannedFiles.get(comp.filePath)?.importedBindings.get(rootIdent);
      if (binding && !resolvedTarget) {
        // If imported from an external npm package (not resolved to any in-repo file), skip attributing external prop APIs
        const targetFiles = resolveSpecifierToFiles(comp.filePath, binding.specifier);
        if (targetFiles.length === 0) continue;
      }
      const targetKey = resolvedTarget
        ? formatDisambiguatedComponentName(resolvedTarget)
        : cs.targetComponent;
      for (const pName of cs.passedProps) {
        let set = propUsers.get(pName);
        if (!set) {
          set = new Set();
          propUsers.set(pName, set);
        }
        set.add(targetKey);
      }
    }
  }

  const propApiDrift: PropApiDriftGroup[] = [];
  const coveredByFamily = new Set<string>();
  for (const family of config.propFamilies) {
    const variants = family.propNames
      .filter((n) => propUsers.has(n))
      .map((propName) => ({ propName, components: [...propUsers.get(propName)!].sort() }));
    if (variants.length >= 2) {
      for (const v of variants) coveredByFamily.add(v.propName);
      propApiDrift.push({
        semanticRole: family.semanticRole,
        variants,
        canonicalRecommendation:
          family.canonicalRecommendation ??
          `Standardize on one spelling (most used: ${[...variants].sort((a, b) => b.components.length - a.components.length)[0].propName}).`,
      });
    }
  }
  const propStem = (name: string): string => {
    const handle = name.match(/^handle([A-Z].*)$/);
    const n = handle ? `on${handle[1]}` : name;
    // `isOpen` ≡ `open`, but `hasData` is a different concept than `data`: only `is*` is a spelling variant.
    const bool = n.match(/^is([A-Z].*)$/);
    const stem = bool ? bool[1][0].toLowerCase() + bool[1].slice(1) : n;
    return stem;
  };
  const stemGroups = new Map<string, string[]>();
  for (const name of propUsers.keys()) {
    if (coveredByFamily.has(name) || BOILERPLATE_PROP_NAMES.has(name)) continue;
    const stem = propStem(name);
    let list = stemGroups.get(stem);
    if (!list) {
      list = [];
      stemGroups.set(stem, list);
    }
    list.push(name);
  }
  for (const [stem, names] of [...stemGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (names.length < 2) continue;
    const variants = names
      .map((propName) => ({ propName, components: [...propUsers.get(propName)!].sort() }))
      .sort((a, b) => b.components.length - a.components.length || a.propName.localeCompare(b.propName));
    propApiDrift.push({
      semanticRole: `Prop spelling drift: "${stem}"`,
      variants,
      canonicalRecommendation: `Standardize on the most-used spelling (${variants[0].propName}, ${variants[0].components.length} component(s)).`,
    });
  }

  // Prop-literal invariants: raw color literals passed to design-token-like props
  const invariantViolations: InvariantViolation[] = componentProfiles.flatMap(
    (c) => c.invariantViolations
  );

  // Composability: drop-in atoms/molecules must not carry hidden margins, fixed widths, or data-layer imports
  const cssDeclsByClass = new Map<
    string,
    Array<{ prop: string; value: string; filePath: string; lineNumber: number }>
  >();
  for (const rule of allStyleRules) {
    for (const cls of rule.classesInSelector) {
      let list = cssDeclsByClass.get(cls);
      if (!list) {
        list = [];
        cssDeclsByClass.set(cls, list);
      }
      for (const d of rule.declarations) {
        list.push({ prop: d.prop, value: d.value, filePath: rule.filePath, lineNumber: d.lineNumber });
      }
    }
  }
  const forbiddenImports = config.composability.forbiddenImports;
  const isZeroLike = (v: string) => /^(?:0|0px|0rem|0em|auto|inherit|initial|unset)$/i.test(v.trim());
  const composabilityIssues: ComposabilityIssue[] = [];
  for (const comp of componentProfiles) {
    if (comp.atomicTier !== "ATOM" && comp.atomicTier !== "MOLECULE") continue;
    const facts = compositionFactsById.get(comp.entityId);
    if (!facts) continue;
    const issues: ComposabilityIssue[] = [];
    const root = facts.root;
    if (root) {
      const classTokens = root.classes.split(/\s+/).filter(Boolean);
      if (config.composability.flagRootMargin) {
        const marginClass = classTokens.find((t) => {
          const base = t.split(":").pop() ?? t;
          return /^-?m[trblxy]?-(?!0$|px$)/.test(base) && !/^m[trblxy]?-0$/.test(base);
        });
        const marginStyle = Object.entries(root.styleProps).find(
          ([k, v]) => /^margin/.test(k) && !isZeroLike(v)
        );
        const marginCss = classTokens
          .flatMap((t) => cssDeclsByClass.get(t) ?? [])
          .find((d) => /^margin/.test(d.prop) && !isZeroLike(d.value));
        if (marginClass || marginStyle || marginCss) {
          issues.push({
            kind: "root-margin",
            component: comp.label,
            detail: marginClass
              ? `root <${root.tag}> carries margin utility \`${marginClass}\``
              : marginStyle
                ? `root <${root.tag}> sets inline ${marginStyle[0]}: ${marginStyle[1]}`
                : `root <${root.tag}> class has CSS ${marginCss!.prop}: ${marginCss!.value}`,
            filePath: marginCss && !marginClass && !marginStyle ? marginCss.filePath : comp.filePath,
            lineNumber: marginCss && !marginClass && !marginStyle ? marginCss.lineNumber : root.lineNumber,
            snippet: root.snippet,
          });
        }
      }
      if (config.composability.flagFixedWidth) {
        const widthClass = classTokens.find((t) => {
          const base = t.split(":").pop() ?? t;
          if (/^(?:min-|max-)?w-\[\d+(?:\.\d+)?(?:px|rem|em)\]$/.test(base)) return true;
          const numeric = base.match(/^w-(\d+)$/);
          return numeric !== null && Number(numeric[1]) >= 24;
        });
        const widthStyle = Object.entries(root.styleProps).find(
          ([k, v]) => /^(?:width|minWidth)$/.test(k) && /^\d+(?:px)?$/.test(v)
        );
        const widthCss = classTokens
          .flatMap((t) => cssDeclsByClass.get(t) ?? [])
          .find((d) => /^(?:width|min-width)$/.test(d.prop) && /^\d*\.?\d+(?:px|rem)$/.test(d.value.trim()));
        if (widthClass || widthStyle || widthCss) {
          issues.push({
            kind: "fixed-width",
            component: comp.label,
            detail: widthClass
              ? `root <${root.tag}> has fixed width \`${widthClass}\``
              : widthStyle
                ? `root <${root.tag}> sets inline ${widthStyle[0]}: ${widthStyle[1]}`
                : `root <${root.tag}> class has CSS ${widthCss!.prop}: ${widthCss!.value}`,
            filePath: widthCss && !widthClass && !widthStyle ? widthCss.filePath : comp.filePath,
            lineNumber: widthCss && !widthClass && !widthStyle ? widthCss.lineNumber : root.lineNumber,
            snippet: root.snippet,
          });
        }
      }
    }
    if (comp.atomicTier === "ATOM") {
      for (const spec of facts.imports) {
        const hit = forbiddenImports.find((f) => spec === f || spec.startsWith(`${f}/`));
        if (hit) {
          issues.push({
            kind: "forbidden-import",
            component: comp.label,
            detail: `atom imports \`${spec}\` (binds a primitive to a router / data layer)`,
            filePath: comp.filePath,
            lineNumber: comp.lineNumber ?? 1,
          });
        }
      }
    }
    comp.composabilityIssues = issues;
    composabilityIssues.push(...issues);
  }

  const alignmentAudit: AlignmentAuditSection = {
    bypassedAtoms,
    parallelTwins,
    callSiteOverrides,
    propApiDrift,
    invariantViolations,
    composabilityIssues,
  };

  // -------------------------------------------------------------------------
  // 16. Stage 4 — Structural DRY Audit (`structuralJsxClones` via Normalized JSX Skeleton Fingerprints)
  // -------------------------------------------------------------------------
  const skeletonsByHash = new Map<
    string,
    Array<JsxSkeletonOccurrence & { componentName: string }>
  >();

  for (const comp of componentProfiles) {
    if (comp.atomicTier === "ATOM") continue;
    const seenLineInComp = new Set<string>();
    for (const sk of comp.jsxSkeletons) {
      const locKey = `${sk.filePath}:${sk.lineNumber}:${sk.skeletonHash}`;
      if (seenLineInComp.has(locKey)) continue;
      seenLineInComp.add(locKey);

      let list = skeletonsByHash.get(sk.skeletonHash);
      if (!list) {
        list = [];
        skeletonsByHash.set(sk.skeletonHash, list);
      }
      if (
        !list.some(
          (item) =>
            item.filePath === sk.filePath && item.lineNumber === sk.lineNumber
        )
      ) {
        list.push({
          ...sk,
          componentName: comp.label,
        });
      }
    }
  }

  const rawCloneGroups: Array<
    StructuralJsxCloneGroup & { canonicalSignature: string }
  > = [];

  for (const [skeletonHash, occs] of skeletonsByHash.entries()) {
    const distinctFiles = new Set(occs.map((o) => o.filePath));
    const distinctComponents = new Set(occs.map((o) => o.componentName));
    // Report when a non-trivial JSX skeleton is duplicated across >= 2 files/components, or >= 3 times total
    if (
      distinctFiles.size >= 2 ||
      distinctComponents.size >= 2 ||
      occs.length >= 3
    ) {
      const sample = occs[0];
      const suggested = inferSuggestedComponentName(
        sample.rootTag,
        sample.canonicalSignature,
        sample.elementCount
      );
      rawCloneGroups.push({
        skeletonHash,
        skeletonShape: sample.skeletonShape,
        canonicalSignature: sample.canonicalSignature,
        elementCount: sample.elementCount,
        occurrenceCount: occs.length,
        distinctFileCount: distinctFiles.size,
        suggestedTier: suggested.tier,
        suggestedComponentName: suggested.name,
        nameConfidence: suggested.confidence,
        compositional: sample.customCount >= 3,
        occurrences: occs.slice(0, 12).map((o) => ({
          componentName: o.componentName,
          filePath: o.filePath,
          lineNumber: o.lineNumber,
          snippet: o.snippet,
        })),
      });
    }
  }

  // Sort largest/most-duplicated clones first and suppress child sub-skeletons already covered by an enclosing parent clone
  rawCloneGroups.sort(
    (a, b) =>
      b.distinctFileCount - a.distinctFileCount ||
      b.occurrenceCount - a.occurrenceCount ||
      b.elementCount - a.elementCount
  );

  const structuralJsxClones: StructuralJsxCloneGroup[] = [];
  for (const candidate of rawCloneGroups) {
    const isSubtreeOfExisting = structuralJsxClones.some((accepted) => {
      const accWithSig = rawCloneGroups.find(
        (r) => r.skeletonHash === accepted.skeletonHash
      );
      return (
        accWithSig &&
        accWithSig.canonicalSignature !== candidate.canonicalSignature &&
        accWithSig.canonicalSignature.includes(candidate.canonicalSignature) &&
        accepted.occurrenceCount >= candidate.occurrenceCount
      );
    });
    if (!isSubtreeOfExisting) {
      const { canonicalSignature: _unused, ...cleanGroup } = candidate;
      structuralJsxClones.push(cleanGroup);
    }
  }

  const dryAudit: DryAuditSection = {
    structuralJsxClones,
    atomicConsolidation,
    duplicateCssTokens: duplicateTokens,
  };

  // -------------------------------------------------------------------------
  // 17. Stage 5 — Measured pillars, bottom-up token derivation & Paved-Road Blueprint
  // -------------------------------------------------------------------------
  let arbitraryTailwindCount = 0;
  let primitiveScaleSkipCount = 0;
  let inlineStyleLiteralCount = 0;
  let canvasCssSlotCount = 0;
  let canvasTsConstSlotCount = 0;
  let canvasLiteralSlotCount = 0;
  let rawDomPrimitiveCount = 0;
  const conventionBreakdown: Record<StylingConvention, number> = {
    "css-classes": 0,
    "css-modules": 0,
    "css-in-js": 0,
    tailwind: 0,
    "inline-style": 0,
    "pixi-canvas": 0,
  };

  for (const comp of componentProfiles) {
    for (const conv of comp.stylingConventions) {
      conventionBreakdown[conv] = (conventionBreakdown[conv] ?? 0) + 1;
    }
    arbitraryTailwindCount += comp.arbitraryTailwind.length;
    primitiveScaleSkipCount += comp.primitiveScaleSkips.length;
    inlineStyleLiteralCount += comp.inlineStyleLiterals.length;
    canvasCssSlotCount += comp.canvasProvenance.cssCount;
    canvasTsConstSlotCount += comp.canvasProvenance.tsConstCount;
    canvasLiteralSlotCount += comp.canvasProvenance.literalCount;
    rawDomPrimitiveCount += comp.rawDomPrimitives.length;
  }

  // 17a. Bottom-up derivation: every hardcoded color / length literal, clustered into candidate tokens
  const literalPool: LiteralValueOccurrence[] = [];
  for (const sheet of parsedCssList) literalPool.push(...sheet.literals);
  for (const scanned of scannedFiles.values()) {
    for (const bucket of scanned.functionsAndClasses.values()) {
      literalPool.push(...bucket.literalValues);
      for (const lit of bucket.inlineStyleLiterals) {
        const colors = extractColorLiterals(lit.value);
        const lengths = colors.length === 0 ? extractLengthLiterals(lit.value) : [];
        for (const c of colors) {
          literalPool.push({
            kind: "color",
            value: c,
            surface: "inline-style",
            context: lit.property,
            filePath: lit.filePath,
            lineNumber: lit.lineNumber,
            snippet: lit.snippet,
          });
        }
        for (const l of lengths) {
          literalPool.push({
            kind: "length",
            value: l,
            surface: "inline-style",
            context: lit.property,
            filePath: lit.filePath,
            lineNumber: lit.lineNumber,
            snippet: lit.snippet,
          });
        }
      }
    }
  }
  const rootDeclMap = new Map<string, CssTokenDeclaration>();
  const emptyDeclMap = new Map<string, CssTokenDeclaration>();
  for (const d of allTokenDecls) {
    if (d.scope === "global" && d.themeContext === "root" && d.selector !== "js-variable") {
      rootDeclMap.set(d.name, d);
    }
  }
  const resolvedTokenValues: ResolvedTokenValue[] = [];
  for (const d of rootDeclMap.values()) {
    const value = substituteVars(d.value, emptyDeclMap, rootDeclMap);
    if (value !== null && value !== "") {
      resolvedTokenValues.push({ name: d.name, value: normalizeBareHsl(value) });
    }
  }
  const derivedTokens = clusterLiteralValues(literalPool, resolvedTokenValues, config.clustering);

  // 17b. Measured pillars (ratios with evidence), computed globally and per package
  const BOILERPLATE_LIT_SURFACES = new Set(["tailwind-arbitrary"]);
  const computeMeasures = (
    profiles: ComponentDesignProfile[],
    includeStylesheetLiterals: boolean
  ): AgentExtendabilityMeasures => {
    const labels = new Set(profiles.map((p) => p.label));

    let hardcoded = 0;
    let tokenized = 0;
    for (const p of profiles) {
      hardcoded +=
        p.arbitraryTailwind.length +
        p.primitiveScaleSkips.length +
        p.inlineStyleLiterals.length +
        p.canvasProvenance.literalCount +
        p.literalValues.filter((l) => !BOILERPLATE_LIT_SURFACES.has(l.surface)).length;
      tokenized +=
        p.tokensConsumed.length + p.tailwindUtilityCount + p.canvasProvenance.cssCount;
    }
    if (includeStylesheetLiterals) {
      hardcoded += parsedCssList.reduce((n, sheet) => n + sheet.literals.length, 0);
    }
    const tokenAdherence =
      tokenized + hardcoded > 0 ? Math.round((tokenized / (tokenized + hardcoded)) * 100) : null;

    let adopters = 0;
    let raw = 0;
    for (const def of atomDefinitions) {
      if (!reportedAtomNames.has(def.name)) continue;
      const names = sharedNamesByAtom.get(def.name)!;
      for (const p of profiles) {
        for (const r of p.rawDomPrimitives) {
          if (r.atomicTarget === def.name && !isOwnAtomImplementation(p.label, def.name)) raw++;
        }
        for (const cs of p.jsxCallSites) {
          if (names.has(cs.targetComponent.toLowerCase())) adopters++;
        }
      }
    }
    const atomAdoption = adopters + raw > 0 ? Math.round((adopters / (adopters + raw)) * 100) : null;

    const participating = new Set<string>();
    for (const g of structuralJsxClones) {
      for (const o of g.occurrences) if (labels.has(o.componentName)) participating.add(o.componentName);
    }
    for (const t of parallelTwins) {
      for (const c of t.components) if (labels.has(c.label)) participating.add(c.label);
    }
    const dryness =
      profiles.length > 0
        ? Math.max(0, 100 - Math.round((participating.size / profiles.length) * 100))
        : null;

    const totalCallSites = profiles.reduce((n, p) => n + p.jsxCallSites.length, 0);
    const overrides =
      callSiteOverrides.filter((o) => labels.has(o.parentComponent)).length +
      invariantViolations.filter((v) => labels.has(v.parentComponent)).length;
    const encapsulation =
      totalCallSites > 0
        ? Math.max(0, 100 - Math.round((overrides / totalCallSites) * 100))
        : null;

    return { tokenAdherence, atomAdoption, dryness, encapsulation };
  };

  const MEASURE_LABELS: Record<keyof AgentExtendabilityMeasures, string> = {
    tokenAdherence: "Token usage",
    atomAdoption: "Shared component reuse",
    dryness: "No duplicate UI",
    encapsulation: "Clean component props",
  };

  const summarizeMeasures = (
    measures: AgentExtendabilityMeasures
  ): { score: number | null; grade: AgentExtendabilitySection["grade"]; notes: string[] } => {
    const entries = Object.entries(measures) as Array<[keyof AgentExtendabilityMeasures, number | null]>;
    const evidenced = entries.filter(([, v]) => v !== null) as Array<[string, number]>;
    const notes = entries
      .filter(([, v]) => v === null)
      .map(([k]) => `${MEASURE_LABELS[k] ?? k}: not applicable in this package (not scored)`);
    if (evidenced.length < 2) {
      notes.unshift("Fewer than two pillars have evidence; no overall grade is assigned.");
      return { score: null, grade: "N/A", notes };
    }
    const score = Math.round(evidenced.reduce((n, [, v]) => n + v, 0) / evidenced.length);
    const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
    return { score, grade, notes };
  };

  const globalMeasures = computeMeasures(componentProfiles, true);
  const globalSummary = summarizeMeasures(globalMeasures);
  const overallExtendabilityScore = globalSummary.score;
  const extendabilityGrade = globalSummary.grade;

  const allSemanticAndCompTokens = [
    ...semanticTokens,
    ...componentTokens,
  ].sort();
  const canonicalTokensByRole = {
    surfaces: allSemanticAndCompTokens
      .filter((t) => /surface|fill|bg|background|board|canvas|card|popover/i.test(t))
      .slice(0, 12),
    text: allSemanticAndCompTokens
      .filter((t) => /text|fg|foreground|label|heading/i.test(t))
      .slice(0, 12),
    borders: allSemanticAndCompTokens
      .filter((t) => /border|stroke|divider|outline|ring/i.test(t))
      .slice(0, 12),
    accents: allSemanticAndCompTokens
      .filter((t) => /accent|brand|primary|highlight|focus/i.test(t))
      .slice(0, 10),
    states: allSemanticAndCompTokens
      .filter((t) => /state|added|modified|removed|active|status|success|warning|danger|destructive/i.test(t))
      .slice(0, 12),
  };

  const reusableBuildingBlocks = [...componentProfiles]
    .filter(
      (c) =>
        c.atomicTier === "ATOM" ||
        c.atomicTier === "MOLECULE" ||
        c.atomicTier === "ORGANISM"
    )
    .sort(
      (a, b) =>
        b.rendersInDegree - a.rendersInDegree ||
        b.usedInRoutes.length - a.usedInRoutes.length ||
        a.label.localeCompare(b.label)
    )
    .slice(0, 12)
    .map((c) => {
      const propsStr =
        c.propContract.length > 0
          ? `{ ${c.propContract
              .slice(0, 5)
              .map((p) => `${p.name}${p.required ? "" : "?"}`)
              .join(", ")}${c.propContract.length > 5 ? ", ..." : ""} }`
          : "";
      return {
        entityId: c.entityId,
        label: c.label,
        atomicTier: c.atomicTier,
        filePath: c.filePath,
        rendersInDegree: c.rendersInDegree,
        propSignature: `<${c.label}${propsStr ? ` ${propsStr}` : ""} />`,
      };
    });

  const missingPrimitivesToExtract: string[] = [];
  for (const ac of atomicConsolidation.slice(0, 5)) {
    missingPrimitivesToExtract.push(
      ac.existingSharedComponent
        ? `Adopt shared <${ac.atomName}> (${ac.instanceCount} raw instances across ${ac.distinctFiles.length} files, ${ac.adoptionRate ?? 0}% adopted): ${ac.consolidationGuidance}`
        : `Extract shared <${ac.atomName}> Atom (${ac.instanceCount} raw DOM instances across ${ac.distinctFiles.length} files): ${ac.consolidationGuidance}`
    );
  }
  for (const clone of structuralJsxClones.slice(0, 3)) {
    const item = `Extract <${clone.suggestedComponentName}> (${clone.suggestedTier}${clone.nameConfidence === "low" ? ", rename needed" : ""}) from ${clone.occurrenceCount}x duplicated ${clone.compositional ? "component composition" : "JSX skeleton"} '${clone.skeletonShape}' across ${clone.distinctFileCount} file(s).`;
    if (!missingPrimitivesToExtract.includes(item)) {
      missingPrimitivesToExtract.push(item);
    }
  }
  for (const twin of parallelTwins.slice(0, 2)) {
    missingPrimitivesToExtract.push(
      `Align parallel ${twin.concept} components (${twin.components.map((c) => c.label).join(", ")}): ${twin.recommendation}`
    );
  }
  for (const dt of derivedTokens.slice(0, 3)) {
    missingPrimitivesToExtract.push(
      `${dt.recommendation} (${dt.members.length} distinct value(s), e.g. ${dt.members.slice(0, 3).map((m) => m.value).join(", ")}).`
    );
  }

  const sharedAtomNames = [...existingSharedByAtom.values()].map((e) => e.name);
  const primitiveExamples = [...primitiveColorTokenNames].sort().slice(0, 3);
  const propDriftPicks = propApiDrift
    .slice(0, 3)
    .map((g) => g.variants[0]?.propName ?? g.canonicalRecommendation);

  const agentExtendability: AgentExtendabilitySection = {
    overallScore: overallExtendabilityScore,
    grade: extendabilityGrade,
    evidenceNotes: globalSummary.notes,
    measures: globalMeasures,
    pavedRoadBlueprint: {
      canonicalTokensByRole,
      reusableBuildingBlocks,
      missingPrimitivesToExtract,
      extensionRules: [
        `1. LAYER COMPOSITION: Compose Routes from Templates -> Organisms -> Molecules -> Atoms. Do not inline raw DOM that an existing shared atom already covers${sharedAtomNames.length > 0 ? ` (${[...new Set(sharedAtomNames)].slice(0, 6).map((n) => `<${n}>`).join(", ")})` : ""}.`,
        `2. TOKEN DISCIPLINE: Consume semantic/component tokens from \`canonicalTokensByRole\`.${primitiveExamples.length > 0 ? ` Never reference primitive tokens directly in components (e.g. ${primitiveExamples.join(", ")}).` : ""} Do not introduce raw color/length literals; reuse an existing token or the nearest \`derivedTokens\` proposal.`,
        "3. ENCAPSULATION: Never inject inline `style={{ ... }}`, arbitrary Tailwind `[Npx]` overrides, or raw color literals onto a child `<Component />` call site; expose semantic `variant` or `size` props on the child instead.",
        propDriftPicks.length > 0
          ? `4. PROP CONSISTENCY: Reuse the repo's dominant prop spellings (${propDriftPicks.join(", ")}) rather than introducing synonyms.`
          : "4. PROP CONSISTENCY: Reuse existing prop names for the same concept (open/close/checked/disabled) rather than introducing synonyms.",
      ],
    },
  };

  // -------------------------------------------------------------------------
  // 18. Build Concise, Non-Overwhelming `L1_DESIGN_SYSTEM` Overlays for Inspector Drawers
  // -------------------------------------------------------------------------
  const componentOverlays: EntityOverlayInput[] = [];

  for (const profile of componentProfiles) {
    const compCloneGroups = structuralJsxClones.filter((g) =>
      g.occurrences.some((o) => o.componentName === profile.label)
    );

    // Do not attach a Design System overlay to pure non-UI helper functions
    const isNonUiUtility =
      profile.atomicTier === "UTILITY" &&
      profile.jsxDomElementCount === 0 &&
      profile.jsxCustomComponentCount === 0 &&
      profile.stylingConventions.length === 0 &&
      profile.tokensConsumed.length === 0 &&
      !profile.canvasProvenance.usesSlotRecorder &&
      profile.undefinedTokens.length === 0 &&
      profile.arbitraryTailwind.length === 0 &&
      profile.primitiveScaleSkips.length === 0 &&
      profile.inlineStyleLiterals.length === 0 &&
      profile.canvasProvenance.literalCount === 0 &&
      profile.rawDomPrimitives.length === 0 &&
      compCloneGroups.length === 0;
    if (isNonUiUtility) {
      continue;
    }

    const isCanvasRenderer =
      profile.canvasProvenance.usesSlotRecorder ||
      (profile.stylingConventions.includes("pixi-canvas") &&
        profile.jsxDomElementCount === 0);
    const layerLabel = isCanvasRenderer
      ? "Canvas Renderer"
      : profile.atomicTier === "ROUTE"
        ? "Page"
        : profile.atomicTier === "TEMPLATE"
          ? "Template"
          : profile.atomicTier === "ORGANISM"
            ? "Organism"
            : profile.atomicTier === "MOLECULE"
              ? "Molecule"
              : profile.atomicTier === "ATOM"
                ? "Atom"
                : "Utility";

    const stylingLabels: string[] = [];
    for (const conv of profile.stylingConventions) {
      if (conv === "tailwind") stylingLabels.push("Tailwind");
      else if (conv === "css-classes")
        stylingLabels.push(
          profile.tokensConsumed.length > 0 ? "CSS Variables" : "CSS"
        );
      else if (conv === "pixi-canvas") stylingLabels.push("Canvas 2D");
      else if (conv === "inline-style") stylingLabels.push("Inline");
      else if (conv === "css-modules") stylingLabels.push("CSS Modules");
      else if (conv === "css-in-js") stylingLabels.push("CSS-in-JS");
    }
    if (
      profile.tokensConsumed.length > 0 &&
      !stylingLabels.includes("CSS Variables")
    ) {
      stylingLabels.push("CSS Variables");
    }

    // Concise variant/configuration props for Atoms & Molecules
    const BOILERPLATE_PROPS = new Set([
      "children",
      "className",
      "onClick",
      "onClose",
      "onChange",
      "style",
      "id",
      "key",
      "ref",
      "ariaLabel",
      "title",
    ]);
    const variantProps =
      profile.atomicTier === "ATOM" || profile.atomicTier === "MOLECULE"
        ? profile.propContract
            .filter((p) => !BOILERPLATE_PROPS.has(p.name))
            .slice(0, 5)
            .map((p) => p.name)
        : [];

    // 1. Unshared primitives (grouped by tag -> target Atom with line numbers)
    const unsharedPrimitives: string[] = [];
    if (profile.atomicTier !== "ATOM" && profile.rawDomPrimitives.length > 0) {
      const byTarget = new Map<
        string,
        { tagOrRole: string; target: string; lines: number[] }
      >();
      for (const rawDom of profile.rawDomPrimitives) {
        const key = `${rawDom.tagOrRole}->${rawDom.atomicTarget}`;
        let group = byTarget.get(key);
        if (!group) {
          group = {
            tagOrRole: rawDom.tagOrRole,
            target: rawDom.atomicTarget,
            lines: [],
          };
          byTarget.set(key, group);
        }
        if (
          rawDom.lineNumber &&
          !group.lines.includes(rawDom.lineNumber) &&
          group.lines.length < 4
        ) {
          group.lines.push(rawDom.lineNumber);
        }
      }
      for (const group of byTarget.values()) {
        const lineSuffix =
          group.lines.length > 0
            ? ` (${group.lines.map((l) => `L${l}`).join(", ")})`
            : "";
        unsharedPrimitives.push(
          `Raw ${group.tagOrRole}${lineSuffix} → use <${group.target}>`
        );
      }
    }

    // 2. Hardcoded values (arbitrary Tailwind + primitive scale skips + inline style literals + canvas literals)
    const hardcodedValues: string[] = [];
    const seenHardcoded = new Set<string>();
    const pushHardcoded = (item: string) => {
      if (!seenHardcoded.has(item)) {
        seenHardcoded.add(item);
        hardcodedValues.push(item);
      }
    };
    for (const tw of profile.arbitraryTailwind) {
      pushHardcoded(`${tw.className} (L${tw.lineNumber})`);
    }
    for (const skip of profile.primitiveScaleSkips) {
      pushHardcoded(`${skip.tokenOrClass} (L${skip.lineNumber})`);
    }
    for (const lit of profile.inlineStyleLiterals) {
      pushHardcoded(`${lit.property}: ${lit.value} (L${lit.lineNumber})`);
    }
    for (const cLit of profile.canvasProvenance.literals) {
      pushHardcoded(`${cLit.slot}.${cLit.prop}=${cLit.value} (L${cLit.lineNumber})`);
    }
    for (const lit of profile.literalValues) {
      if (lit.surface === "tailwind-arbitrary") continue; // already listed via arbitraryTailwind
      pushHardcoded(`${lit.context ? `${lit.context}: ` : ""}${lit.value} (L${lit.lineNumber})`);
    }
    for (const v of profile.invariantViolations) {
      pushHardcoded(`<${v.childComponent} ${v.prop}="${v.value}"> (L${v.lineNumber})`);
    }
    const composability = profile.composabilityIssues.map(
      (c) => `${c.kind}: ${c.detail}`
    );

    // 3. Duplicate markup (DRY JSX clones)
    const duplicateMarkup = compCloneGroups.map(
      (g) => `<${g.suggestedComponentName}> (${g.occurrenceCount}× repeated)`
    );

    // 4. Missing tokens (undefined var(--*))
    const missingTokens = profile.undefinedTokens.map((u) => {
      const firstLine = u.occurrences[0]?.lineNumber;
      return firstLine ? `${u.name} (L${firstLine})` : u.name;
    });

    const findingCount =
      unsharedPrimitives.length +
      hardcodedValues.length +
      duplicateMarkup.length +
      missingTokens.length +
      composability.length;

    const overlayEvidence: OverlayEvidenceItem[] = [];
    for (const u of profile.undefinedTokens) {
      for (const occ of u.occurrences.slice(0, 2)) {
        overlayEvidence.push(
          ctx.evidence(
            occ.filePath,
            occ.lineNumber,
            occ.snippet,
            `missing-token:${u.name}`
          )
        );
      }
    }
    for (const clone of compCloneGroups.slice(0, 2)) {
      const occ = clone.occurrences.find((o) => o.componentName === profile.label);
      if (occ) {
        overlayEvidence.push(
          ctx.evidence(
            occ.filePath,
            occ.lineNumber,
            occ.snippet,
            `duplicate-markup:${clone.suggestedComponentName}`
          )
        );
      }
    }
    for (const tw of profile.arbitraryTailwind.slice(0, 3)) {
      overlayEvidence.push(
        ctx.evidence(
          tw.filePath,
          tw.lineNumber,
          tw.snippet,
          `hardcoded:${tw.className}`
        )
      );
    }
    for (const skip of profile.primitiveScaleSkips.slice(0, 2)) {
      overlayEvidence.push(
        ctx.evidence(
          skip.filePath,
          skip.lineNumber,
          skip.snippet,
          `hardcoded:${skip.tokenOrClass}`
        )
      );
    }
    for (const litItem of profile.canvasProvenance.literals.slice(0, 3)) {
      overlayEvidence.push(
        ctx.evidence(
          litItem.filePath,
          litItem.lineNumber,
          litItem.snippet,
          `hardcoded:${litItem.slot}.${litItem.prop}=${litItem.value}`
        )
      );
    }
    for (const rawDom of profile.rawDomPrimitives.slice(0, 3)) {
      overlayEvidence.push(
        ctx.evidence(
          rawDom.filePath,
          rawDom.lineNumber,
          rawDom.snippet,
          `unshared-primitive:${rawDom.atomicTarget}`
        )
      );
    }

    if (!realGraphNodeIds.has(profile.entityId)) {
      continue;
    }

    componentOverlays.push({
      repositoryId: ctx.repoId,
      entityId: profile.entityId,
      layer: "L1_DESIGN_SYSTEM",
      source: "design-system",
      environment: ctx.environment,
      derivation: "EXTRACTED",
      inputs: [
        ...cssInputDeps,
        ...(() => {
          const dep = ctx.hashFile(profile.filePath);
          return dep ? [dep] : [];
        })(),
      ],
      evidence: overlayEvidence,
      payload: {
        layer: layerLabel,
        ...(stylingLabels.length > 0 ? { styling: stylingLabels } : {}),
        ...(variantProps.length > 0 ? { variantProps } : {}),
        ...(profile.tokensConsumed.length > 0
          ? { designTokens: profile.tokensConsumed }
          : {}),
        ...(profile.canvasProvenance.usesSlotRecorder
          ? {
              themeSlots: `${profile.canvasProvenance.cssCount} CSS tokens · ${profile.canvasProvenance.tsConstCount} constants`,
            }
          : {}),
        ...(unsharedPrimitives.length > 0 ? { unsharedPrimitives } : {}),
        ...(hardcodedValues.length > 0 ? { hardcodedValues } : {}),
        ...(duplicateMarkup.length > 0 ? { duplicateMarkup } : {}),
        ...(missingTokens.length > 0 ? { missingTokens } : {}),
        ...(composability.length > 0 ? { composability } : {}),
        findingCount,
        // Retain machine baseline fields for `diffDesignSystem` working-tree regression checks
        metrics: {
          tokens: profile.tokensConsumed.length,
          composes: profile.renderedComponents.length,
          routes: profile.usedInRoutes.length,
          arbitraryTw: profile.arbitraryTailwind.length,
          literals:
            profile.inlineStyleLiterals.length +
            profile.canvasProvenance.literalCount,
          rawDom: profile.rawDomPrimitives.length,
        },
        ...(profile.undefinedTokens.length > 0
          ? {
              undefinedTokens: profile.undefinedTokens.map((u) => u.name),
            }
          : {}),
        ...(profile.arbitraryTailwind.length > 0
          ? {
              arbitraryTailwind: Array.from(
                new Set(profile.arbitraryTailwind.map((a) => a.className))
              ),
            }
          : {}),
        ...(profile.primitiveScaleSkips.length > 0
          ? {
              primitiveScaleSkips: Array.from(
                new Set(profile.primitiveScaleSkips.map((s) => s.tokenOrClass))
              ),
            }
          : {}),
      },
    });
  }

  // 19. Attach Concise Package-Level `L1_DESIGN_SYSTEM` Overlay onto Frontend `DEPLOYMENT_UNIT`(s)
  const frontendBoundaryNodes: StructuralNode[] = [];
  for (const du of deploymentUnitsById.values()) {
    const ev = getPrimaryNodeEvidence(du);
    const fp = ev.filePath ?? "";
    const matchesFrontendPackage = scope.includedDirs.some((dir) =>
      dir === "." ? fp === "package.json" : fp === dir || fp.startsWith(`${dir}/`)
    );
    if (matchesFrontendPackage) {
      frontendBoundaryNodes.push(du);
    }
  }

  for (const du of frontendBoundaryNodes) {
    const pkgEvidence: OverlayEvidenceItem[] = [];
    for (const u of undefinedTokens.slice(0, 3)) {
      const occ = u.occurrences[0];
      if (occ) {
        pkgEvidence.push(
          ctx.evidence(
            occ.filePath,
            occ.lineNumber,
            occ.snippet,
            `missing-token:${u.name}`
          )
        );
      }
    }
    for (const clone of structuralJsxClones.slice(0, 3)) {
      const occ = clone.occurrences[0];
      if (occ) {
        pkgEvidence.push(
          ctx.evidence(
            occ.filePath,
            occ.lineNumber,
            `${clone.skeletonShape} (${clone.occurrenceCount}x across ${clone.distinctFileCount} files)`,
            `duplicate-markup:${clone.suggestedComponentName}`
          )
        );
      }
    }
    for (const cf of contrastFailures.slice(0, 3)) {
      if (cf.filePath) {
        pkgEvidence.push(
          ctx.evidence(
            cf.filePath,
            cf.lineNumber,
            `${cf.foregroundToken} on ${cf.backgroundToken} (dark: ${cf.dark?.ratio ?? "-"}:1, light: ${cf.light?.ratio ?? "-"}:1, min: ${cf.minRequiredRatio}:1)`,
            `contrast-fail:${cf.pairId}`
          )
        );
      }
    }

    const cleanPkgName = du.name.replace(/^Deployment Unit:\s*/i, "").trim();
    const pkgShortKey = cleanPkgName.replace(/^@[^/]+\//, "");
    const pkgProfiles = componentProfiles.filter((p) => p.packageName === pkgShortKey);
    const pkgLabels = new Set(pkgProfiles.map((p) => p.label));
    const pkgMeasures = computeMeasures(pkgProfiles, false);
    const pkgSummary = summarizeMeasures(pkgMeasures);
    const pkgBypassed = bypassedAtoms.filter((b) => pkgLabels.has(b.bypassingComponent));
    const pkgClones = structuralJsxClones.filter((g) =>
      g.occurrences.some((o) => pkgLabels.has(o.componentName))
    );
    const pkgTwins = parallelTwins.filter((t) =>
      t.components.some((c) => pkgLabels.has(c.label))
    );
    const pkgInvariants = invariantViolations.filter((v) => pkgLabels.has(v.parentComponent));
    const pkgComposability = composabilityIssues.filter((c) => pkgLabels.has(c.component));
    const pkgTierCounts: Record<AtomicTier, number> = {
      ROUTE: 0,
      TEMPLATE: 0,
      ORGANISM: 0,
      MOLECULE: 0,
      ATOM: 0,
      UTILITY: 0,
    };
    for (const p of pkgProfiles) pkgTierCounts[p.atomicTier]++;
    const totalHardcodedCount = pkgProfiles.reduce(
      (n, p) =>
        n +
        p.arbitraryTailwind.length +
        p.primitiveScaleSkips.length +
        p.inlineStyleLiterals.length +
        p.canvasProvenance.literalCount +
        p.literalValues.filter((l) => l.surface !== "tailwind-arbitrary").length,
      0
    );

    const openFindings: Array<{ label: string; value: string }> = [];
    if (undefinedTokens.length > 0) {
      openFindings.push({
        label: "Missing tokens",
        value: `${undefinedTokens.length} undefined var(--*)`,
      });
    }
    if (contrastFailures.length > 0) {
      openFindings.push({
        label: "WCAG contrast",
        value: `${contrastFailures.length} failing pair(s)`,
      });
    }
    if (duplicateTokens.length > 0) {
      openFindings.push({
        label: "Duplicate tokens",
        value: `${duplicateTokens.length} across stylesheets`,
      });
    }
    if (contrastUnresolved.length > 0) {
      openFindings.push({
        label: "Contrast not evaluated",
        value: `${contrastUnresolved.length} pair/theme(s) unresolved`,
      });
    }
    if (pkgClones.length > 0) {
      openFindings.push({
        label: "Duplicate markup",
        value: `${pkgClones.length} repeated JSX block(s)`,
      });
    }
    if (pkgBypassed.length > 0) {
      const topAtoms = Array.from(
        new Set(pkgBypassed.map((b) => `<${b.atomTarget}>`))
      ).slice(0, 3);
      openFindings.push({
        label: "Unshared primitives",
        value: `${pkgBypassed.length} raw element(s) → ${topAtoms.join(", ")}`,
      });
    }
    if (pkgInvariants.length > 0) {
      openFindings.push({
        label: "Prop literal violations",
        value: `${pkgInvariants.length} raw color literal(s) passed to token props`,
      });
    }
    if (pkgComposability.length > 0) {
      openFindings.push({
        label: "Composability",
        value: `${pkgComposability.length} hidden margin / fixed width / data-layer import(s)`,
      });
    }
    if (pkgTwins.length > 0) {
      const twinDesc = pkgTwins
        .slice(0, 2)
        .map((t) => t.components.map((c) => c.label).join(" / "))
        .join(", ");
      openFindings.push({
        label: "Parallel components",
        value: twinDesc,
      });
    }
    if (totalHardcodedCount > 0) {
      openFindings.push({
        label: "Hardcoded values",
        value: `${totalHardcodedCount} untokenized value(s)`,
      });
    }

    const passedChecks: string[] = [];
    if (
      contrastFailures.length === 0 &&
      contrastAudits.length > 0 &&
      contrastUnresolved.length === 0
    ) {
      passedChecks.push(
        `${contrastAudits.length}/${contrastCandidateCount} WCAG contrast`
      );
    }
    if (undefinedTokens.length === 0) {
      passedChecks.push("0 missing tokens");
    }
    if (duplicateTokens.length === 0) {
      passedChecks.push("0 duplicate tokens");
    }
    if (pkgClones.length === 0) {
      passedChecks.push("0 duplicate markup");
    }

    componentOverlays.unshift({
      repositoryId: ctx.repoId,
      entityId: du.id,
      layer: "L1_DESIGN_SYSTEM",
      source: "design-system",
      environment: ctx.environment,
      derivation: "EXTRACTED",
      inputs: cssInputDeps,
      evidence: pkgEvidence,
      payload: {
        isPackageOverlay: true,
        packageName: cleanPkgName,
        packageShortKey: pkgShortKey,
        ...(pkgSummary.score !== null ? { score: pkgSummary.score } : {}),
        grade: pkgSummary.grade,
        findingCount: openFindings.length,
        // Measured, per-package ratios (a pillar is omitted when this package gives no evidence for it)
        pillars: {
          ...(pkgMeasures.atomAdoption !== null ? { componentReuse: pkgMeasures.atomAdoption } : {}),
          ...(pkgMeasures.tokenAdherence !== null ? { tokenCoverage: pkgMeasures.tokenAdherence } : {}),
          ...(pkgMeasures.encapsulation !== null ? { consistency: pkgMeasures.encapsulation } : {}),
          ...(pkgMeasures.dryness !== null ? { dryMarkup: pkgMeasures.dryness } : {}),
        },
        evidenceNotes: pkgSummary.notes,
        inventory: {
          pages: pkgTierCounts.ROUTE + pkgTierCounts.TEMPLATE,
          organisms: pkgTierCounts.ORGANISM,
          molecules: pkgTierCounts.MOLECULE,
          atoms: pkgTierCounts.ATOM,
          tokens: definedTokenNames.size,
        },
        openFindings,
        passedChecks,
        agentExtendability:
          pkgSummary.score !== null ? `${pkgSummary.score}/100 (${pkgSummary.grade})` : "N/A",
        metrics: {
          extendabilityScore: pkgSummary.score,
          routes: pkgTierCounts.ROUTE,
          components: pkgProfiles.length,
          definedTokens: definedTokenNames.size,
          jsxClones: pkgClones.length,
          contrastFailures: contrastFailures.length,
        },
      },
    });
  }

  const unsupportedFiles = [...unsupportedByExt.entries()]
    .map(([extension, files]) => ({
      extension,
      count: files.length,
      sample: files.slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension));
  const unsupportedFileCount = unsupportedFiles.reduce((n, u) => n + u.count, 0);
  const themesObserved = [
    ...new Set(
      allTokenDecls.filter((d) => d.scope === "global").map((d) => d.themeContext)
    ),
  ].sort() as Array<"root" | "dark" | "light" | "theme-bridge">;

  const coverageNotes: string[] = [];
  if (scope.includedDirs.length === 0) {
    coverageNotes.push(
      "No frontend packages were detected. Set `designSystem.scope.packages` in chomp.config.json to opt packages in explicitly."
    );
  }
  if (unsupportedFileCount > 0) {
    coverageNotes.push(
      `${unsupportedFileCount} file(s) in frontend packages use a style/markup language this plugin does not parse (${unsupportedFiles.map((u) => u.extension).join(", ")}); findings do not cover them.`
    );
  }
  if (contrastUnresolved.length > 0) {
    coverageNotes.push(
      `${contrastUnresolved.length} contrast pair/theme combination(s) could not be evaluated (see coverage.contrastUnresolved); absence of failures does not mean they pass.`
    );
  }
  if (contrastAudits.length === 0 && contrastUnresolved.length === 0) {
    coverageNotes.push(
      "No contrast pairs were found: declare fg/bg token pairs in `designSystem.contrast.pairs` or follow a `--x` / `--x-foreground` naming pair convention."
    );
  }
  if (resolved.mode === "adhere" && !resolved.declaresSystem) {
    coverageNotes.push(resolved.modeReason);
  }
  coverageNotes.push(...resolved.warnings);

  const systemInfo: DesignSystemSourceInfo = {
    mode: resolved.mode,
    modeReason: resolved.modeReason,
    configPath: resolved.configPath,
    configWarnings: resolved.warnings,
    packages: scope.packages,
    atomCatalog: atomDefinitions.map((d) => d.name),
    tokenSources: config.tokens.sources,
    tierSources,
    themesObserved,
    primaryTokenFiles: (() => {
      const counts = new Map<string, number>();
      for (const d of allTokenDecls) {
        if (d.scope !== "global" || d.selector === "js-variable" || d.themeContext === "theme-bridge") continue;
        counts.set(d.filePath, (counts.get(d.filePath) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 2)
        .map(([f]) => f);
    })(),
  };

  const report: DesignSystemAnalysisReport = {
    repoId: ctx.repoId,
    repoName: ctx.repoName,
    system: systemInfo,
    coverage: {
      unsupportedFiles,
      contrastUnresolved,
      tokensOutsideSystem,
      notes: coverageNotes,
    },
    derivedTokens,
    summary: {
      cssFilesScanned: parsedCssList.length,
      componentFilesScanned: scannedFiles.size,
      componentsProfiled: componentProfiles.length,
      routeCount: tierCounts.ROUTE,
      templateCount: tierCounts.TEMPLATE,
      organismCount: tierCounts.ORGANISM,
      moleculeCount: tierCounts.MOLECULE,
      atomCount: tierCounts.ATOM,
      utilityCount: tierCounts.UTILITY,
      structuralJsxCloneCount: structuralJsxClones.length,
      bypassedAtomCount: bypassedAtoms.length,
      parallelTwinGroupCount: parallelTwins.length,
      callSiteOverrideCount: callSiteOverrides.length,
      propApiDriftGroupCount: propApiDrift.length,
      agentExtendabilityScore: overallExtendabilityScore,
      agentExtendabilityGrade: extendabilityGrade,
      totalDefinedTokens: definedTokenNames.size,
      primitiveTokenCount: primitiveTokens.size,
      semanticTokenCount: semanticTokens.size,
      componentTokenCount: componentTokens.size,
      themeBridgeTokenCount: themeBridgeTokens.size,
      undefinedTokenCount: undefinedTokens.length,
      duplicateTokenCount: duplicateTokens.length,
      forkedTokenCount: duplicateTokens.filter((d) => d.isForkedValue).length,
      unusedTokenCount: unusedTokens.length,
      contrastPairsAudited: contrastAudits.length,
      contrastCandidateCount,
      contrastFailureCount: contrastFailures.length,
      contrastPairsUnresolved: contrastUnresolved.length,
      hardcodedLiteralCount: literalPool.length,
      derivedTokenProposalCount: derivedTokens.length,
      invariantViolationCount: invariantViolations.length,
      composabilityIssueCount: composabilityIssues.length,
      frontendPackageCount: scope.includedDirs.length,
      unsupportedFileCount,
      arbitraryTailwindCount,
      primitiveScaleSkipCount,
      inlineStyleLiteralCount,
      canvasCssSlotCount,
      canvasTsConstSlotCount,
      canvasLiteralSlotCount,
      rawDomPrimitiveCount,
      atomicConsolidationGroupCount: atomicConsolidation.length,
      dynamicClassPrefixCount: allDynamicClassPrefixes.size,
      unusedCssSelectorCount: unusedCssSelectors.length,
      conventionBreakdown,
    },
    routeComposition,
    atomicHierarchy,
    alignmentAudit,
    dryAudit,
    agentExtendability,
    tokenCatalog: {
      primitive: [...primitiveTokens].sort(),
      semantic: [...semanticTokens].sort(),
      component: [...componentTokens].sort(),
      themeBridge: [...themeBridgeTokens].sort(),
    },
    diagnostics: {
      undefinedTokens,
      duplicateTokens,
      unusedTokens,
      contrastFailures,
      contrastAudits,
      unusedCssSelectors,
      dynamicClassPrefixes: [...allDynamicClassPrefixes].sort(),
      hardcodedCssLiterals: parsedCssList.flatMap((sheet) => sheet.literals),
    },
    atomicConsolidation,
    components: componentProfiles,
  };

  // Plugin Presentation Contract: what the HUD / inspector show, built from the finished report
  const { records: findingRecords } = collectDesignSystemFindings(report);
  attachDesignSystemPresentations(
    report,
    componentOverlays,
    { path: resolveBaselinePath(ctx.repoPath, config.baseline.path) },
    findingRecords,
    (shortKey) => {
      const m = computeMeasures(
        componentProfiles.filter((p) => p.packageName === shortKey),
        false
      );
      const sum = summarizeMeasures(m);
      return { score: sum.score, grade: sum.grade, notes: sum.notes, pillars: m };
    }
  );

  return {
    report,
    overlays: componentOverlays,
  };
}

// ---------------------------------------------------------------------------
// 6. Registered `ChompPlugin` Definition (`design-system`)
// ---------------------------------------------------------------------------

/**
 * Builds the `design-system` plugin. `configOverrides` is merged over `chomp.config.json` → `designSystem`
 * and the built-in defaults (used by tests and programmatic callers; the registered plugin uses none).
 */
export function createDesignSystemPlugin(
  configOverrides?: Partial<DesignSystemConfig>
): ChompPlugin {
  return {
    name: "design-system",
    version: "2.1.0",
    displayName: "Design system",
    order: 30,
    layer: "L1_DESIGN_SYSTEM",
    legacySources: ["design-audit"],
    description:
      "Repo-agnostic frontend design-system audit: derives (extract mode) or enforces (adhere mode) token tiers, theme contrast (hex/rgb/hsl/oklch), styling conventions, hardcoded-value clusters → candidate tokens, atom adoption, parallel-twin merge proposals, compositional JSX clones, prop-literal invariants and atom composability, scoped to frontend packages.",
    accepts: (filePath: string) =>
      isSupportedStylesheetFile(filePath) ||
      isPreprocessedUiComponentFile(filePath) ||
      UNSUPPORTED_UI_EXTENSIONS.some((e) => filePath.endsWith(e)) ||
      ((filePath.endsWith(".tsx") ||
        filePath.endsWith(".ts") ||
        filePath.endsWith(".jsx") ||
        filePath.endsWith(".js")) &&
        !filePath.endsWith(".d.ts")),
    extract: (ctx: ChompPluginContext) => {
      const { report, overlays } = analyzeRepositoryDesignSystem(ctx, { configOverrides });
      return {
        overlays,
        summary: {
          ...report.summary,
          report,
        },
      };
    },
  };
}

export const designSystemPlugin: ChompPlugin = createDesignSystemPlugin();

// ---------------------------------------------------------------------------
// 7. Closed-Loop Frontend Agent Gate ("Query Before Write, Diff After Write")
// ---------------------------------------------------------------------------

/**
 * Flattens a report into identity-keyed findings (no line numbers) plus the set of failing
 * contrast `pairId::theme` identities. This is the unit the pinned baseline snapshot stores.
 */
export function collectDesignSystemFindings(report: DesignSystemAnalysisReport): {
  records: FindingRecord[];
  failingContrast: string[];
} {
  const records: FindingRecord[] = [];

  for (const u of report.diagnostics.undefinedTokens) {
    for (const occ of u.occurrences) {
      records.push({
        category: "undefinedToken",
        key: findingKey("undefinedToken", occ.filePath, "", u.name),
        filePath: occ.filePath,
        lineNumber: occ.lineNumber,
        label: u.name,
        snippet: occ.snippet,
      });
    }
  }

  for (const comp of report.components) {
    for (const tw of comp.arbitraryTailwind) {
      records.push({
        category: "arbitraryTailwind",
        key: findingKey("arbitraryTailwind", tw.filePath, comp.label, tw.className),
        filePath: tw.filePath,
        lineNumber: tw.lineNumber,
        label: tw.className,
        snippet: tw.snippet,
      });
    }
    for (const skip of comp.primitiveScaleSkips) {
      records.push({
        category: "primitiveSkip",
        key: findingKey("primitiveSkip", skip.filePath, comp.label, skip.tokenOrClass),
        filePath: skip.filePath,
        lineNumber: skip.lineNumber,
        label: skip.tokenOrClass,
        snippet: skip.snippet,
      });
    }
    for (const lit of comp.inlineStyleLiterals) {
      const label = `${lit.property}: ${lit.value}`;
      records.push({
        category: "hardcodedLiteral",
        key: findingKey("hardcodedLiteral", lit.filePath, comp.label, `inline:${label}`),
        filePath: lit.filePath,
        lineNumber: lit.lineNumber,
        label,
        snippet: lit.snippet,
      });
    }
    for (const lit of comp.canvasProvenance.literals) {
      const label = `${lit.slot}.${lit.prop}=${lit.value}`;
      records.push({
        category: "hardcodedLiteral",
        key: findingKey("hardcodedLiteral", lit.filePath, comp.label, `canvas:${label}`),
        filePath: lit.filePath,
        lineNumber: lit.lineNumber,
        label,
        snippet: lit.snippet,
      });
    }
    for (const lit of comp.literalValues) {
      if (lit.surface === "tailwind-arbitrary") continue; // counted as arbitraryTailwind
      const label = `${lit.context ? `${lit.context}: ` : ""}${lit.value}`;
      records.push({
        category: "hardcodedLiteral",
        key: findingKey("hardcodedLiteral", lit.filePath, comp.label, `${lit.surface}:${label}`),
        filePath: lit.filePath,
        lineNumber: lit.lineNumber,
        label,
        snippet: lit.snippet,
      });
    }
    for (const v of comp.invariantViolations) {
      const label = `<${v.childComponent} ${v.prop}="${v.value}">`;
      records.push({
        category: "invariantViolation",
        key: findingKey("invariantViolation", v.filePath, comp.label, label),
        filePath: v.filePath,
        lineNumber: v.lineNumber,
        label,
        snippet: v.snippet,
      });
    }
    for (const c of comp.composabilityIssues) {
      records.push({
        category: "composability",
        key: findingKey("composability", c.filePath, comp.label, `${c.kind}:${c.detail}`),
        filePath: c.filePath,
        lineNumber: c.lineNumber,
        label: `${c.kind}: ${c.detail}`,
        ...(c.snippet ? { snippet: c.snippet } : {}),
      });
    }
  }

  for (const lit of report.diagnostics.hardcodedCssLiterals) {
    const label = `${lit.context ? `${lit.context}: ` : ""}${lit.value}`;
    records.push({
      category: "hardcodedLiteral",
      key: findingKey("hardcodedLiteral", lit.filePath, "", `css:${label}`),
      filePath: lit.filePath,
      lineNumber: lit.lineNumber,
      label,
      snippet: lit.snippet,
    });
  }

  for (const b of report.alignmentAudit.bypassedAtoms) {
    records.push({
      category: "rawPrimitive",
      key: findingKey("rawPrimitive", b.filePath, b.bypassingComponent, b.atomTarget),
      filePath: b.filePath,
      lineNumber: b.lineNumber,
      label: `raw ${b.atomTarget} in ${b.bypassingComponent}`,
      snippet: b.snippet,
    });
  }
  for (const o of report.alignmentAudit.callSiteOverrides) {
    records.push({
      category: "callSiteOverride",
      key: findingKey(
        "callSiteOverride",
        o.filePath,
        o.parentComponent,
        `${o.childComponent}:${o.details.join("|")}`
      ),
      filePath: o.filePath,
      lineNumber: o.lineNumber,
      label: `${o.parentComponent} overrides <${o.childComponent}> (${o.overrideKind})`,
      snippet: o.snippet,
    });
  }

  const failingContrast: string[] = [];
  for (const c of report.diagnostics.contrastFailures) {
    for (const theme of ["root", "light", "dark"] as const) {
      const r = c[theme];
      if (r && !r.passes) failingContrast.push(`${c.pairId}::${theme}`);
    }
  }
  failingContrast.sort();

  return { records, failingContrast };
}

export interface AuditDesignSystemOptions {
  repoPath: string;
  repoId?: string;
  repoName?: string;
  dbPath?: string;
  graph?: RepresentationGraph;
  packageName?: string;
  searchTerm?: string;
  /** Refreshes the `entity_overlays` *display* layer. Never affects the diff baseline. */
  persistOverlays?: boolean;
  limit?: number;
  /** Writes (or replaces) the pinned diff baseline snapshot from this audit. */
  setBaseline?: boolean;
  /** Override the baseline snapshot path (default: `designSystem.baseline.path`). */
  baselinePath?: string;
  /**
   * When true (default), a *missing* baseline is only auto-pinned if the in-scope working tree is clean;
   * otherwise pinning is refused (a baseline cut from uncommitted drift would hide that drift).
   * Explicit `setBaseline` always pins and records `workingTreeDirty`.
   */
  requireCleanTree?: boolean;
  /** Injectable working-tree check (tests). Default: `git status` over the in-scope frontend directories. */
  workingTreeCheck?: (repoPath: string, dirs: string[]) => WorkingTreeCheck;
  configOverrides?: Partial<DesignSystemConfig>;
}

export interface DesignSystemBaselineStatus {
  path: string;
  exists: boolean;
  /** True when this call created the baseline because none existed. */
  bootstrapped: boolean;
  /** True when this call wrote (created or replaced) the baseline. */
  written: boolean;
  /** True when no baseline exists and pinning was refused because the in-scope working tree has uncommitted changes. */
  refused?: boolean;
  /** Uncommitted in-scope paths that caused the refusal (or were present when a dirty tree was pinned explicitly). */
  dirtyFiles?: string[];
  createdAt?: string;
  commitSha?: string;
  note?: string;
}

function buildBaselineSnapshot(
  report: DesignSystemAnalysisReport,
  pluginVersion: string,
  commitSha: string | undefined,
  workingTreeDirty?: boolean
): DesignSystemBaselineSnapshot {
  const { records, failingContrast } = collectDesignSystemFindings(report);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    pluginVersion,
    ...(commitSha ? { commitSha } : {}),
    ...(workingTreeDirty ? { workingTreeDirty: true } : {}),
    mode: report.system.mode,
    counts: countFindings(records),
    failingContrast,
    totals: totalsByCategory(records),
  };
}

export async function auditDesignSystem(
  options: AuditDesignSystemOptions
) {
  const maxItems = Math.max(1, Math.min(options.limit ?? 25, 100));
  const plugin = createDesignSystemPlugin(options.configOverrides);
  const pluginResult = await runChompPlugin(plugin, {
    repoPath: options.repoPath,
    repoId: options.repoId,
    repoName: options.repoName,
    dbPath: options.dbPath,
    graph: options.graph,
    persist: options.persistOverlays ?? true,
  });

  const fullReport = pluginResult.summary.report as DesignSystemAnalysisReport;
  const pkgFilter = options.packageName?.trim().toLowerCase();
  const searchFilter = options.searchTerm?.trim().toLowerCase();

  // Pinned diff baseline: created if absent, replaced only on explicit request
  const repoPath = resolve(options.repoPath);
  const resolvedConfig = resolveDesignSystemConfig(repoPath, options.configOverrides);
  const baselinePath = options.baselinePath
    ? resolve(repoPath, options.baselinePath)
    : resolveBaselinePath(repoPath, resolvedConfig.config.baseline.path);
  const existingBaseline = readBaselineSnapshot(baselinePath);
  const scopeDirs = [
    ...new Set(fullReport.system.packages.filter((p) => p.frontend).map((p) => p.dir)),
  ];
  const explicit = options.setBaseline === true;
  const needsBootstrap = existingBaseline === null && !explicit;
  const requireClean = options.requireCleanTree !== false;
  // Only inspect the tree when we are about to pin something
  const tree: WorkingTreeCheck | null =
    explicit || needsBootstrap
      ? (options.workingTreeCheck ?? checkWorkingTreeClean)(repoPath, [
          ...scopeDirs,
          "chomp.config.json",
        ])
      : null;

  let baselineStatus: DesignSystemBaselineStatus;
  if (needsBootstrap && requireClean && tree?.clean === false) {
    baselineStatus = {
      path: baselinePath,
      exists: false,
      bootstrapped: false,
      written: false,
      refused: true,
      dirtyFiles: tree.dirtyFiles,
      note: `No baseline is pinned and the in-scope working tree has uncommitted changes (${tree.dirtyFiles.slice(0, 5).join(", ")}${tree.dirtyFiles.length > 5 ? ", …" : ""}). Pinning now would hide that drift inside the baseline, so it was refused. Commit or stash the changes and re-audit, or pin deliberately with set_baseline (\`chomp plugin baseline\`). chomp_diff_design_system returns NO_BASELINE until then.`,
    };
  } else if (explicit || needsBootstrap) {
    const dirty = tree?.clean === false;
    const snapshot = buildBaselineSnapshot(
      fullReport,
      pluginResult.pluginVersion,
      tree?.commitSha,
      dirty
    );
    writeBaselineSnapshot(baselinePath, snapshot);
    baselineStatus = {
      path: baselinePath,
      exists: true,
      bootstrapped: needsBootstrap,
      written: true,
      createdAt: snapshot.createdAt,
      ...(tree?.commitSha ? { commitSha: tree.commitSha } : {}),
      ...(dirty ? { dirtyFiles: tree!.dirtyFiles } : {}),
      note: dirty
        ? "Baseline pinned explicitly from a working tree with uncommitted in-scope changes (recorded as workingTreeDirty); drift present in those changes is now part of the baseline."
        : tree?.clean === null
          ? needsBootstrap
            ? "No baseline existed, so this audit pinned the current tree. Working-tree cleanliness could not be verified (not a git repo, or git unavailable)."
            : "Baseline replaced on explicit request. Working-tree cleanliness could not be verified."
          : needsBootstrap
            ? "No baseline existed; pinned from a clean working tree."
            : "Baseline replaced from a clean working tree on explicit request.",
    };
  } else {
    baselineStatus = {
      path: baselinePath,
      exists: true,
      bootstrapped: false,
      written: false,
      createdAt: existingBaseline!.createdAt,
      ...(existingBaseline!.commitSha ? { commitSha: existingBaseline!.commitSha } : {}),
      ...(existingBaseline!.workingTreeDirty
        ? { note: "The pinned baseline was cut from a dirty working tree (workingTreeDirty)." }
        : {}),
    };
  }

  let filteredComponents = fullReport.components;
  if (pkgFilter) {
    filteredComponents = filteredComponents.filter(
      (c) =>
        c.packageName.toLowerCase().includes(pkgFilter) ||
        c.filePath.toLowerCase().includes(pkgFilter)
    );
  }
  if (searchFilter) {
    filteredComponents = filteredComponents.filter(
      (c) =>
        c.label.toLowerCase().includes(searchFilter) ||
        c.name.toLowerCase().includes(searchFilter) ||
        c.filePath.toLowerCase().includes(searchFilter) ||
        c.entityId.toLowerCase().includes(searchFilter) ||
        c.atomicCandidates.some((a) => a.toLowerCase().includes(searchFilter))
    );
  }

  // Recommend top hotspot component node IDs for optional Active View highlighting
  const hotspotScore = (c: ComponentDesignProfile) =>
    c.undefinedTokens.length * 5 +
    c.arbitraryTailwind.length * 2 +
    c.primitiveScaleSkips.length * 2 +
    c.canvasProvenance.literalCount * 2 +
    c.invariantViolations.length * 3 +
    c.composabilityIssues.length * 2 +
    c.rawDomPrimitives.length;
  const recommendedHighlightNodeIds = [...filteredComponents]
    .sort((a, b) => hotspotScore(b) - hotspotScore(a))
    .filter((c) => hotspotScore(c) > 0)
    .slice(0, 12)
    .map((c) => c.entityId);

  return {
    plugin: {
      name: pluginResult.pluginName,
      version: pluginResult.pluginVersion,
      layer: pluginResult.layer,
      runId: pluginResult.runId,
      overlaysPersisted: pluginResult.overlayCount,
      durationMs: pluginResult.durationMs,
    },
    system: fullReport.system,
    coverage: fullReport.coverage,
    baseline: baselineStatus,
    summary: fullReport.summary,
    routeComposition: fullReport.routeComposition,
    atomicHierarchy: fullReport.atomicHierarchy,
    alignmentAudit: {
      bypassedAtoms: fullReport.alignmentAudit.bypassedAtoms.slice(0, maxItems),
      parallelTwins: fullReport.alignmentAudit.parallelTwins.slice(0, maxItems),
      callSiteOverrides: fullReport.alignmentAudit.callSiteOverrides.slice(
        0,
        maxItems
      ),
      propApiDrift: fullReport.alignmentAudit.propApiDrift.slice(0, maxItems),
      invariantViolations: fullReport.alignmentAudit.invariantViolations.slice(0, maxItems),
      composabilityIssues: fullReport.alignmentAudit.composabilityIssues.slice(0, maxItems),
    },
    dryAudit: {
      structuralJsxClones: fullReport.dryAudit.structuralJsxClones.slice(
        0,
        maxItems
      ),
      atomicConsolidation: fullReport.dryAudit.atomicConsolidation,
      duplicateCssTokens: fullReport.dryAudit.duplicateCssTokens.slice(
        0,
        maxItems
      ),
    },
    derivedTokens: fullReport.derivedTokens.slice(0, maxItems),
    agentExtendability: fullReport.agentExtendability,
    tokenCatalog: fullReport.tokenCatalog,
    atomicConsolidation: fullReport.atomicConsolidation,
    diagnostics: {
      undefinedTokens: fullReport.diagnostics.undefinedTokens.slice(0, maxItems),
      duplicateTokens: fullReport.diagnostics.duplicateTokens.slice(0, maxItems),
      unusedTokens: fullReport.diagnostics.unusedTokens.slice(0, maxItems),
      contrastFailures: fullReport.diagnostics.contrastFailures.slice(0, maxItems),
      contrastAudits: fullReport.diagnostics.contrastAudits.slice(0, maxItems),
      dynamicClassPrefixes: fullReport.diagnostics.dynamicClassPrefixes,
      unusedCssSelectors: fullReport.diagnostics.unusedCssSelectors.slice(
        0,
        maxItems
      ),
      hardcodedCssLiteralCount: fullReport.diagnostics.hardcodedCssLiterals.length,
    },
    components: filteredComponents.slice(0, maxItems),
    recommendedHighlightNodeIds,
    agentGuidance: [
      `System audited in ${fullReport.system.mode} mode (${fullReport.system.modeReason}); ${fullReport.system.packages.filter((p) => p.frontend).length} frontend package(s) in scope.`,
      ...fullReport.agentExtendability.pavedRoadBlueprint.extensionRules,
      "QUERY BEFORE WRITE ([PAT-MCP-08], [PAT-VIS-21]): Reuse tokens from `tokenCatalog.semantic` / `agentExtendability.pavedRoadBlueprint.canonicalTokensByRole`, building blocks from `reusableBuildingBlocks`, and `derivedTokens[].existingTokenMatch` instead of introducing raw hex/px literals or inline DOM primitives.",
      "VERIFY AFTER WRITE: After editing CSS or React/TSX components, call `chomp_diff_design_system` (and `chomp_get_diff`) to confirm no newly introduced undefined `var(--*)` tokens, arbitrary values, raw literals, bypassed atoms, composability issues or contrast regressions against the pinned baseline.",
      ...(fullReport.coverage.notes.length > 0
        ? [`COVERAGE: ${fullReport.coverage.notes.join(" ")}`]
        : []),
    ],
  };
}

export interface DiffDesignSystemOptions {
  repoPath: string;
  repoId?: string;
  repoName?: string;
  dbPath?: string;
  graph?: RepresentationGraph;
  /** Override the baseline snapshot path (default: `designSystem.baseline.path`). */
  baselinePath?: string;
  configOverrides?: Partial<DesignSystemConfig>;
}

/** Short labels (scope stripped) of the frontend packages in a report's scope. */
export function frontendPackageLabels(report: DesignSystemAnalysisReport): string[] {
  return report.system.packages
    .filter((p) => p.frontend)
    .map((p) => p.name?.replace(/^@[^/]+\//, "") ?? basename(p.dir === "." ? report.repoName : p.dir));
}

export interface DesignSystemDiffResult {
  /** `NO_BASELINE`: nothing pinned to compare against, which is *unknown*, never a pass. */
  gateStatus: "PASS" | "WARN" | "NO_BASELINE";
  hasBaseline: boolean;
  baseline: { path: string; createdAt?: string; commitSha?: string; pluginVersion?: string };
  /** Frontend packages that were in scope for this diff. */
  frontendPackages: string[];
  summary: {
    newUndefinedTokenCount: number;
    resolvedUndefinedTokenCount: number;
    newArbitraryTailwindCount: number;
    resolvedArbitraryTailwindCount: number;
    newPrimitiveScaleSkipCount: number;
    newHardcodedLiteralCount: number;
    newInvariantViolationCount: number;
    newRawPrimitiveCount: number;
    newComposabilityIssueCount: number;
    newCallSiteOverrideCount: number;
    newContrastFailureCount: number;
    resolvedContrastFailureCount: number;
    regressedComponentCount: number;
    improvedComponentCount: number;
  };
  newIssues: {
    undefinedTokens: FindingRecord[];
    arbitraryTailwind: FindingRecord[];
    primitiveScaleSkips: FindingRecord[];
    hardcodedLiterals: FindingRecord[];
    invariantViolations: FindingRecord[];
    rawPrimitives: FindingRecord[];
    composabilityIssues: FindingRecord[];
    callSiteOverrides: FindingRecord[];
    contrastFailures: ContrastAuditItem[];
  };
  resolvedIssues: {
    undefinedTokens: string[];
    arbitraryTailwind: string[];
    contrastFailures: string[];
  };
  componentDeltas: Array<{
    entityId?: string;
    label: string;
    filePath: string;
    status: "IMPROVED" | "REGRESSED";
    added: number;
    resolved: number;
    addedFindings: string[];
  }>;
  /** Live (not diffed) totals so a `NO_BASELINE` result is still informative. */
  liveTotals: Record<string, number>;
  remediationGuidance: string[];
}

/**
 * Pins the current working tree as the diff baseline. Explicit by design: no other call ever
 * moves the baseline, so a re-audit can never silently move the goalposts of the gate.
 */
export async function snapshotDesignSystemBaseline(options: {
  repoPath: string;
  repoId?: string;
  repoName?: string;
  dbPath?: string;
  graph?: RepresentationGraph;
  baselinePath?: string;
  commitSha?: string;
  configOverrides?: Partial<DesignSystemConfig>;
}): Promise<{
  path: string;
  snapshot: DesignSystemBaselineSnapshot;
  workingTree: WorkingTreeCheck;
}> {
  const repoPath = resolve(options.repoPath);
  const plugin = createDesignSystemPlugin(options.configOverrides);
  const liveGraph = options.graph ?? analyzeTarget(repoPath);
  const res = await runChompPlugin(plugin, {
    repoPath,
    repoId: options.repoId,
    repoName: options.repoName,
    dbPath: options.dbPath,
    graph: liveGraph,
    persist: false,
  });
  const report = res.summary.report as DesignSystemAnalysisReport;
  const resolvedConfig = resolveDesignSystemConfig(repoPath, options.configOverrides);
  const path = options.baselinePath
    ? resolve(repoPath, options.baselinePath)
    : resolveBaselinePath(repoPath, resolvedConfig.config.baseline.path);
  const tree = checkWorkingTreeClean(repoPath, [
    ...new Set(report.system.packages.filter((p) => p.frontend).map((p) => p.dir)),
    "chomp.config.json",
  ]);
  const snapshot = buildBaselineSnapshot(
    report,
    res.pluginVersion,
    options.commitSha ?? tree.commitSha ?? liveGraph.commitSha,
    tree.clean === false
  );
  writeBaselineSnapshot(path, snapshot);
  return { path, snapshot, workingTree: tree };
}

/**
 * Compares the live working-tree scan against the pinned baseline snapshot (`[PAT-MCP-02]`).
 * Findings are keyed by identity (file, component, value) and compared by occurrence count.
 */
export async function diffDesignSystem(
  options: DiffDesignSystemOptions
): Promise<DesignSystemDiffResult> {
  const repoPath = resolve(options.repoPath);
  const repoName = options.repoName ?? resolveRepoName(repoPath);
  const repoId =
    options.repoId ?? repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

  const resolvedConfig = resolveDesignSystemConfig(repoPath, options.configOverrides);
  const baselinePath = options.baselinePath
    ? resolve(repoPath, options.baselinePath)
    : resolveBaselinePath(repoPath, resolvedConfig.config.baseline.path);
  const baseline = readBaselineSnapshot(baselinePath);

  const liveGraph = options.graph ?? analyzeTarget(repoPath);
  const livePluginRes = await runChompPlugin(
    createDesignSystemPlugin(options.configOverrides),
    {
      repoPath,
      repoId,
      repoName,
      graph: liveGraph,
      persist: false,
    }
  );
  const liveReport = livePluginRes.summary.report as DesignSystemAnalysisReport;
  const { records, failingContrast } = collectDesignSystemFindings(liveReport);
  const liveTotals = totalsByCategory(records);

  const emptyIssues: DesignSystemDiffResult["newIssues"] = {
    undefinedTokens: [],
    arbitraryTailwind: [],
    primitiveScaleSkips: [],
    hardcodedLiterals: [],
    invariantViolations: [],
    rawPrimitives: [],
    composabilityIssues: [],
    callSiteOverrides: [],
    contrastFailures: [],
  };

  if (!baseline) {
    return {
      gateStatus: "NO_BASELINE",
      hasBaseline: false,
      baseline: { path: baselinePath },
      frontendPackages: frontendPackageLabels(liveReport),
      summary: {
        newUndefinedTokenCount: 0,
        resolvedUndefinedTokenCount: 0,
        newArbitraryTailwindCount: 0,
        resolvedArbitraryTailwindCount: 0,
        newPrimitiveScaleSkipCount: 0,
        newHardcodedLiteralCount: 0,
        newInvariantViolationCount: 0,
        newRawPrimitiveCount: 0,
        newComposabilityIssueCount: 0,
        newCallSiteOverrideCount: 0,
        newContrastFailureCount: 0,
        resolvedContrastFailureCount: 0,
        regressedComponentCount: 0,
        improvedComponentCount: 0,
      },
      newIssues: emptyIssues,
      resolvedIssues: { undefinedTokens: [], arbitraryTailwind: [], contrastFailures: [] },
      componentDeltas: [],
      liveTotals,
      remediationGuidance: [
        `No design-system baseline is pinned at ${baselinePath}. The gate cannot tell new drift from existing drift, so this is NOT a pass. Run chomp_audit_design_system on a clean working tree (it pins the baseline automatically and refuses when in-scope changes are uncommitted), or pin deliberately with \`chomp plugin baseline\` / set_baseline: true, then re-run the diff.`,
      ],
    };
  }

  const diff = diffFindings(baseline.counts, records);
  const byCategory = (cat: FindingRecord["category"]) =>
    diff.added.filter((r) => r.category === cat);
  const resolvedByCategory = (cat: FindingRecord["category"]) =>
    diff.resolved.filter((r) => r.key.startsWith(`${cat}|`));

  const baseFailing = new Set(baseline.failingContrast);
  const newContrastFailures = liveReport.diagnostics.contrastFailures.filter((c) =>
    (["root", "light", "dark"] as const).some((theme) => {
      const r = c[theme];
      return r && !r.passes && !baseFailing.has(`${c.pairId}::${theme}`);
    })
  );
  const liveFailingSet = new Set(failingContrast);
  const resolvedContrast = baseline.failingContrast.filter((id) => !liveFailingSet.has(id));

  // Per-component deltas (component label is the 3rd segment of the finding key)
  const labelFile = new Map<string, { entityId: string; filePath: string }>();
  for (const c of liveReport.components) {
    labelFile.set(`${c.filePath}|${c.label}`, { entityId: c.entityId, filePath: c.filePath });
  }
  const deltas = new Map<
    string,
    { entityId?: string; label: string; filePath: string; added: number; resolved: number; addedFindings: string[] }
  >();
  const deltaFor = (filePath: string, label: string) => {
    const k = `${filePath}|${label}`;
    let d = deltas.get(k);
    if (!d) {
      d = {
        entityId: labelFile.get(k)?.entityId,
        label,
        filePath,
        added: 0,
        resolved: 0,
        addedFindings: [],
      };
      deltas.set(k, d);
    }
    return d;
  };
  for (const r of diff.added) {
    const component = r.key.split("|")[2];
    if (!component) continue;
    const d = deltaFor(r.filePath, component);
    d.added++;
    if (d.addedFindings.length < 6) d.addedFindings.push(`${r.category}: ${r.label}`);
  }
  for (const r of diff.resolved) {
    const [, file, component] = r.key.split("|");
    if (!component) continue;
    deltaFor(file, component).resolved += r.removed;
  }
  const componentDeltas: DesignSystemDiffResult["componentDeltas"] = [...deltas.values()]
    .filter((d) => d.added > 0 || d.resolved > 0)
    .map((d) => ({
      ...(d.entityId ? { entityId: d.entityId } : {}),
      label: d.label,
      filePath: d.filePath,
      status: d.added > 0 ? ("REGRESSED" as const) : ("IMPROVED" as const),
      added: d.added,
      resolved: d.resolved,
      addedFindings: d.addedFindings,
    }))
    .sort((a, b) => b.added - a.added || a.label.localeCompare(b.label));

  const newIssues: DesignSystemDiffResult["newIssues"] = {
    undefinedTokens: byCategory("undefinedToken"),
    arbitraryTailwind: byCategory("arbitraryTailwind"),
    primitiveScaleSkips: byCategory("primitiveSkip"),
    hardcodedLiterals: byCategory("hardcodedLiteral"),
    invariantViolations: byCategory("invariantViolation"),
    rawPrimitives: byCategory("rawPrimitive"),
    composabilityIssues: byCategory("composability"),
    callSiteOverrides: byCategory("callSiteOverride"),
    contrastFailures: newContrastFailures,
  };

  const regressedComponentCount = componentDeltas.filter((d) => d.status === "REGRESSED").length;
  const improvedComponentCount = componentDeltas.filter((d) => d.status === "IMPROVED").length;
  const gateStatus: "PASS" | "WARN" =
    diff.added.length === 0 && newContrastFailures.length === 0 ? "PASS" : "WARN";

  const tokenHome = liveReport.system.primaryTokenFiles[0];
  const remediationGuidance: string[] = [];
  if (newIssues.undefinedTokens.length > 0) {
    const names = [...new Set(newIssues.undefinedTokens.map((u) => u.label))];
    remediationGuidance.push(
      `Define ${names.map((n) => `\`${n}\``).join(", ")}${tokenHome ? ` in \`${tokenHome}\`` : " in the stylesheet that owns your theme tokens"} (or replace with an existing semantic token from \`tokenCatalog.semantic\`).`
    );
  }
  if (newIssues.arbitraryTailwind.length > 0) {
    remediationGuidance.push(
      `Replace ${newIssues.arbitraryTailwind.length} newly introduced arbitrary Tailwind class(es) (${[...new Set(newIssues.arbitraryTailwind.map((a) => `\`${a.label}\``))].slice(0, 5).join(", ")}) with theme utilities or tokens.`
    );
  }
  if (newIssues.primitiveScaleSkips.length > 0) {
    remediationGuidance.push(
      `Replace raw primitive reference(s) (${[...new Set(newIssues.primitiveScaleSkips.map((s) => `\`${s.label}\``))].join(", ")}) with the semantic token that aliases them (see \`primitiveScaleSkips[].suggestedSemantic\` in the audit).`
    );
  }
  if (newIssues.hardcodedLiterals.length > 0) {
    remediationGuidance.push(
      `Replace ${newIssues.hardcodedLiterals.length} newly introduced hardcoded value(s) with tokens; check \`derivedTokens[].existingTokenMatch\` for the nearest existing token.`
    );
  }
  if (newIssues.invariantViolations.length > 0) {
    remediationGuidance.push(
      `Pass a semantic token / variant instead of raw color literals to ${[...new Set(newIssues.invariantViolations.map((v) => `\`${v.label}\``))].slice(0, 4).join(", ")}.`
    );
  }
  if (newIssues.rawPrimitives.length > 0) {
    remediationGuidance.push(
      `Use the shared atom instead of ${newIssues.rawPrimitives.length} newly introduced raw element(s) (${[...new Set(newIssues.rawPrimitives.map((r) => `\`${r.label}\``))].slice(0, 4).join(", ")}).`
    );
  }
  if (newIssues.composabilityIssues.length > 0) {
    remediationGuidance.push(
      `Remove hidden margins / fixed widths / data-layer imports from drop-in components: ${newIssues.composabilityIssues.slice(0, 3).map((c) => c.label).join("; ")}.`
    );
  }
  if (newContrastFailures.length > 0) {
    remediationGuidance.push(
      `Fix ${newContrastFailures.length} new WCAG 2.1 contrast failure(s) (${newContrastFailures.map((c) => `${c.foregroundToken} on ${c.backgroundToken}`).join(", ")}).`
    );
  }
  if (remediationGuidance.length === 0) {
    remediationGuidance.push(
      "Design System Gate PASSED: no findings beyond the pinned baseline (no new undefined tokens, arbitrary values, hardcoded literals, bypassed atoms, composability issues or contrast regressions)."
    );
  }

  return {
    gateStatus,
    hasBaseline: true,
    baseline: {
      path: baselinePath,
      createdAt: baseline.createdAt,
      ...(baseline.commitSha ? { commitSha: baseline.commitSha } : {}),
      pluginVersion: baseline.pluginVersion,
    },
    frontendPackages: frontendPackageLabels(liveReport),
    summary: {
      newUndefinedTokenCount: newIssues.undefinedTokens.length,
      resolvedUndefinedTokenCount: resolvedByCategory("undefinedToken").length,
      newArbitraryTailwindCount: newIssues.arbitraryTailwind.length,
      resolvedArbitraryTailwindCount: resolvedByCategory("arbitraryTailwind").length,
      newPrimitiveScaleSkipCount: newIssues.primitiveScaleSkips.length,
      newHardcodedLiteralCount: newIssues.hardcodedLiterals.length,
      newInvariantViolationCount: newIssues.invariantViolations.length,
      newRawPrimitiveCount: newIssues.rawPrimitives.length,
      newComposabilityIssueCount: newIssues.composabilityIssues.length,
      newCallSiteOverrideCount: newIssues.callSiteOverrides.length,
      newContrastFailureCount: newContrastFailures.length,
      resolvedContrastFailureCount: resolvedContrast.length,
      regressedComponentCount,
      improvedComponentCount,
    },
    newIssues,
    resolvedIssues: {
      undefinedTokens: resolvedByCategory("undefinedToken").map((r) => r.key.split("|")[3]),
      arbitraryTailwind: resolvedByCategory("arbitraryTailwind").map((r) => r.key.split("|")[3]),
      contrastFailures: resolvedContrast,
    },
    componentDeltas,
    liveTotals,
    remediationGuidance,
  };
}
