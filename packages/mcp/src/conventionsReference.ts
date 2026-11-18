/**
 * packages/mcp/src/conventionsReference.ts
 *
 * Pure MCP Reference & Paved-Road Convention Discovery (`chomp_get_conventions`)
 * Enforces [PAT-EXT-28], [PAT-MCP-08], [PAT-MCP-09].
 *
 * Exposes Chomp's built-in framework convention catalog (`CONVENTION_SETS`),
 * active repository conventions (`chomp.config.json#conventions` + `validateConventionSet`),
 * signal-to-matcher remediation playbooks (`UNRESOLVED_CALL`, `ORPHAN_CONTRACT`, `OPAQUE_BODY`, `DARK_FILE`),
 * and the complete `NodeMatcher` / `EdgeMatcher` / `EmitTemplate` schema (`describeConventionSchema`).
 *
 * Note: Intentionally a pure MCP reference tool for coding agents — NOT a HUD plugin.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONVENTION_SETS,
  describeConventionSchema,
  describeConventions,
  loadUserConventionSets,
  validateConventionSet,
  type ConventionCatalogRow,
  type ConventionSchemaReference,
} from "@chomp/core";

export type ConventionSignalKind =
  | "UNRESOLVED_CALL"
  | "ORPHAN_CONTRACT"
  | "OPAQUE_BODY"
  | "DARK_FILE";

export interface GetConventionsReferenceOptions {
  repoPath: string;
  framework?: string;
  entityType?: string;
  signalKind?: ConventionSignalKind;
  shapeKey?: string;
  searchTerm?: string;
  includeSchema?: boolean;
}

export interface UserConventionSetStatus {
  framework: string;
  ruleCount: number;
  edgeRuleCount: number;
  fileRoleCount: number;
  validationProblems: string[];
  rules: ConventionCatalogRow[];
}

export interface BuiltInFrameworkCatalog {
  framework: string;
  installedInRepo: boolean;
  totalRules: number;
  rules: ConventionCatalogRow[];
}

export interface SignalRemediationPlaybookEntry {
  signalKind: ConventionSignalKind;
  meaning: string;
  pavedRoadAdvice: string;
  recommendedNodeMatchers: string[];
  recommendedEdgeMatchers: string[];
  whenToUseLocalShimsInstead: string;
}

export interface ShapeKeyRemediationAdvice {
  shapeKey: string;
  edgeKind: string | null;
  receiverKind: string | null;
  calleeSyntax: string | null;
  recommendedApproach: "BUILT_IN_ALIGNMENT" | "CHOMP_CONFIG_CONVENTION" | "LOCAL_SHIM";
  guidance: string;
  suggestedMatchers: string[];
}

export interface ConventionsReferenceReport {
  summary: {
    builtInFrameworkCount: number;
    builtInRuleCount: number;
    matchedBuiltInRuleCount: number;
    activeUserConventionSetCount: number;
    activeUserRuleCount: number;
    userValidationErrorCount: number;
    hasChompConfig: boolean;
    detectedFrameworks: string[];
  };
  decisionGuide: {
    preferBuiltInConventions: string;
    whenToAuthorChompConfigConventions: string;
    whenToUseChompLocalShims: string;
    verificationWorkflow: string[];
  };
  activeUserConventions: {
    configPath: string;
    exists: boolean;
    parseError: string | null;
    sets: UserConventionSetStatus[];
  };
  builtInConventions: BuiltInFrameworkCatalog[];
  signalPlaybook: SignalRemediationPlaybookEntry[];
  shapeKeyAdvice?: ShapeKeyRemediationAdvice;
  schemaReference?: ConventionSchemaReference;
}

const FRAMEWORK_DEP_MAP: Readonly<Record<string, readonly string[]>> = {
  nextjs: ["next"],
  react: ["react", "react-dom"],
  express: ["express"],
  mcp: ["@modelcontextprotocol/sdk"],
  drizzle: ["drizzle-orm"],
  payload: ["payload", "@payloadcms/next"],
};

const SIGNAL_PLAYBOOK: readonly SignalRemediationPlaybookEntry[] = [
  {
    signalKind: "UNRESOLVED_CALL",
    meaning:
      "A non-builtin call inside a contract or INIT_BLOCK has no resolved targetId (`▲ N unresolved`), leaving downstream side effects invisible on the map.",
    pavedRoadAdvice:
      "Prefer direct imports or known client receivers for external calls. If your repo uses a consistent custom broker/SDK/HTTP wrapper (e.g. `eventBus.publish('topic')`, `rpcClient.invoke(...)`), add a `callToMember` or `callToIdentifier` -> `OPEN_CONNECTOR` rule in `chomp.config.json#conventions`.",
    recommendedNodeMatchers: [
      "callToMember",
      "callToIdentifier",
      "callToMemberChain",
      "callChainRootedAt",
      "newIdentifier",
    ],
    recommendedEdgeMatchers: ["callRouteTargets", "callRegistrationTargets"],
    whenToUseLocalShimsInstead:
      "Use `chomp_local_shims` (`.chomp/shims.json`) when the target depends on runtime DI tokens (`container.resolve(TOKEN)`), reflection, or dynamic lookup tables that have no static AST target.",
  },
  {
    signalKind: "ORPHAN_CONTRACT",
    meaning:
      "An extracted contract has `inDegree === 0` (no incoming edge from any INGRESS route, component, CLI command, or INIT_BLOCK).",
    pavedRoadAdvice:
      "If handlers are registered through a custom router, RPC builder, or plugin registry (`rpcRouter.query('/x', handler)`), add an `edgeRules` entry (`callRouteTargets` or `callRegistrationTargets`) in `chomp.config.json#conventions` to link the registration site to `importedComponent` / `sameFileExport`.",
    recommendedNodeMatchers: [
      "exportedWrappedFunction",
      "callToMember",
      "exportedConstObject",
    ],
    recommendedEdgeMatchers: [
      "callRouteTargets",
      "callRegistrationTargets",
      "jsxTag",
      "jsxIdentifierAttribute",
    ],
    whenToUseLocalShimsInstead:
      "Use `chomp_local_shims` when handlers are wired via config strings, reflection, or external framework bootstrap files outside TypeScript AST reach.",
  },
  {
    signalKind: "OPAQUE_BODY",
    meaning:
      "A contract makes AST calls (`astCallCount > 0`) but produces `0` resolved outgoing edges (`resolvedOutDegree === 0`), acting as a silent black box in story flows.",
    pavedRoadAdvice:
      "Inspect the helper or wrapper indirection inside the contract body. Either pass typed dependencies / standard client calls directly, declare custom client methods as `OPEN_CONNECTOR` conventions in `chomp.config.json#conventions`, or bridge dynamic dispatch via `chomp_local_shims`.",
    recommendedNodeMatchers: ["callToMember", "callToIdentifier", "callToMemberChain"],
    recommendedEdgeMatchers: ["callRouteTargets", "callRegistrationTargets"],
    whenToUseLocalShimsInstead:
      "Use `chomp_local_shims` (`action: 'suggest'`) to inspect the exact unresolved call sites inside the opaque contract and wire runtime targets cleanly at Layer 1.",
  },
  {
    signalKind: "DARK_FILE",
    meaning:
      "A TypeScript/JavaScript source file yielded `0` extracted Contracts and `0` INIT_BLOCK relationships — typically caused by an unrecognized HOF wrapper or custom file convention.",
    pavedRoadAdvice:
      "Check how the file exports or registers its units. Declare `fileRoles` (if path-based) and `exportedWrappedFunction`, `exportedConstCall`, `defaultExportWrapped`, or `callToMember` -> `CONTRACT` rules in `chomp.config.json#conventions`.",
    recommendedNodeMatchers: [
      "exportedFunction",
      "exportedWrappedFunction",
      "exportedConstCall",
      "exportedConstObject",
      "defaultExportCall",
      "defaultExportWrapped",
    ],
    recommendedEdgeMatchers: ["callRouteTargets", "callRegistrationTargets"],
    whenToUseLocalShimsInstead:
      "Dark files have `0` Layer 0 contracts to attach shims to — always solve `DARK_FILE` with paved-road exports or `chomp.config.json#conventions` `CONTRACT` rules first.",
  },
];

function collectInstalledDepNames(repoPath: string): Set<string> {
  const deps = new Set<string>();
  const readPkgJson = (pkgJsonPath: string) => {
    try {
      if (!existsSync(pkgJsonPath)) return;
      const raw = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const sec = raw[field];
        if (sec && typeof sec === "object") {
          for (const k of Object.keys(sec as Record<string, unknown>)) {
            deps.add(k);
          }
        }
      }
    } catch {
      // Ignore malformed package.json
    }
  };

  readPkgJson(join(repoPath, "package.json"));
  for (const subDir of ["packages", "apps"]) {
    const absSub = join(repoPath, subDir);
    try {
      if (!existsSync(absSub)) continue;
      for (const entry of readdirSync(absSub, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          readPkgJson(join(absSub, entry.name, "package.json"));
        }
      }
    } catch {
      // Ignore unreadable workspace directories
    }
  }
  return deps;
}

function matchesSignalFilter(row: ConventionCatalogRow, signalKind: ConventionSignalKind): boolean {
  switch (signalKind) {
    case "UNRESOLVED_CALL":
    case "OPAQUE_BODY":
      return row.produces.type === "OPEN_CONNECTOR" || row.produces.type === "RELATIONSHIP";
    case "ORPHAN_CONTRACT":
      return row.produces.type === "RELATIONSHIP" || row.produces.type === "CONTRACT";
    case "DARK_FILE":
      return row.produces.type === "CONTRACT";
  }
}

function buildShapeKeyAdvice(shapeKey: string): ShapeKeyRemediationAdvice {
  const trimmed = shapeKey.trim();
  const parts = trimmed.split("/");
  // Expected format: sk1/<EDGE_KIND>/<RECEIVER_CLASS>/<CALLEE_SYNTAX>...
  const hasPrefix = parts[0] === "sk1";
  const edgeKind = hasPrefix ? (parts[1] ?? null) : null;
  const receiverKind = hasPrefix ? (parts[2] ?? null) : null;
  const calleeSyntax = hasPrefix ? (parts.slice(3).join("/") || null) : null;

  const lower = trimmed.toLowerCase();
  if (
    lower.includes("elementaccess") ||
    lower.includes("dynamic") ||
    lower.includes("computed") ||
    lower.includes("param")
  ) {
    return {
      shapeKey: trimmed,
      edgeKind,
      receiverKind,
      calleeSyntax,
      recommendedApproach: "LOCAL_SHIM",
      guidance:
        "This call shape dispatches through a parameter, computed property, or dynamic runtime value (`DYNAMIC_BOUNDARY`). Static AST rules should not guess runtime values — use `chomp_local_shims` (`action: 'suggest'` -> `action: 'upsert'`) to record an explicit `L1_SHIMS` bridge.",
      suggestedMatchers: [],
    };
  }

  if (calleeSyntax?.includes("PropertyAccessExpression")) {
    return {
      shapeKey: trimmed,
      edgeKind,
      receiverKind,
      calleeSyntax,
      recommendedApproach: "CHOMP_CONFIG_CONVENTION",
      guidance:
        "Member-call syntax (`receiver.method(...)`). If this calls a consistent custom client/broker/router across the repo, add `callToMember` (for `OPEN_CONNECTOR` / `CONTRACT`) or `callRouteTargets` / `callRegistrationTargets` (for handler `edgeRules`) in `chomp.config.json#conventions`. If `receiver` is a runtime DI container (`container.resolve`), use `chomp_local_shims` instead.",
      suggestedMatchers: [
        "callToMember",
        "callToMemberChain",
        "callRouteTargets",
        "callRegistrationTargets",
      ],
    };
  }

  if (calleeSyntax?.includes("Identifier")) {
    return {
      shapeKey: trimmed,
      edgeKind,
      receiverKind,
      calleeSyntax,
      recommendedApproach: "CHOMP_CONFIG_CONVENTION",
      guidance:
        "Direct identifier call (`fn(...)`). Verify the target is exported and imported via standard ES module paths (`BUILT_IN_ALIGNMENT`), or declare `callToIdentifier` / `exportedWrappedFunction` in `chomp.config.json#conventions` if `fn` is a custom DSL or external SDK helper.",
      suggestedMatchers: ["callToIdentifier", "exportedWrappedFunction"],
    };
  }

  return {
    shapeKey: trimmed,
    edgeKind,
    receiverKind,
    calleeSyntax,
    recommendedApproach: "BUILT_IN_ALIGNMENT",
    guidance:
      "Inspect sample call sites via `chomp_audit_health` or `chomp_local_shims` (`action: 'suggest'`). Prefer aligning to built-in imports/exports first, `chomp.config.json#conventions` for repeatable AST idioms, or `chomp_local_shims` for one-off runtime/DI indirection.",
    suggestedMatchers: ["callToMember", "callToIdentifier", "exportedWrappedFunction"],
  };
}

export function getConventionsReference(
  options: GetConventionsReferenceOptions,
): ConventionsReferenceReport {
  const repoPath = resolve(options.repoPath);
  const frameworkFilter = options.framework?.trim().toLowerCase();
  const entityTypeFilter = options.entityType?.trim().toLowerCase();
  const signalFilter = options.signalKind;
  const searchFilter = options.searchTerm?.trim().toLowerCase();
  const includeSchema = options.includeSchema ?? true;

  const installedDeps = collectInstalledDepNames(repoPath);
  const detectedFrameworks: string[] = ["core"];
  for (const [fw, pkgNames] of Object.entries(FRAMEWORK_DEP_MAP)) {
    if (pkgNames.some((pkg) => installedDeps.has(pkg))) {
      detectedFrameworks.push(fw);
    }
  }

  // Inspect repo's chomp.config.json#conventions
  const configAbsPath = join(repoPath, "chomp.config.json");
  const configExists = existsSync(configAbsPath);
  let parseError: string | null = null;
  if (configExists) {
    try {
      JSON.parse(readFileSync(configAbsPath, "utf8"));
    } catch (err: unknown) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  const loadedUserSets = parseError ? [] : loadUserConventionSets(repoPath);
  const userSetStatuses: UserConventionSetStatus[] = loadedUserSets.map((set) => ({
    framework: set.framework,
    ruleCount: set.rules.length,
    edgeRuleCount: set.edgeRules?.length ?? 0,
    fileRoleCount: set.fileRoles.length,
    validationProblems: validateConventionSet(set),
    rules: describeConventions(set),
  }));

  const activeUserRuleCount = userSetStatuses.reduce(
    (sum, s) => sum + s.ruleCount + s.edgeRuleCount,
    0,
  );
  const userValidationErrorCount = userSetStatuses.reduce(
    (sum, s) => sum + s.validationProblems.length,
    0,
  );

  const filterRow = (row: ConventionCatalogRow): boolean => {
    if (frameworkFilter && row.framework.toLowerCase() !== frameworkFilter) {
      return false;
    }
    if (
      entityTypeFilter &&
      row.produces.entityType.toLowerCase() !== entityTypeFilter &&
      row.produces.type.toLowerCase() !== entityTypeFilter
    ) {
      return false;
    }
    if (signalFilter && !matchesSignalFilter(row, signalFilter)) {
      return false;
    }
    if (searchFilter) {
      const haystack = [
        row.id,
        row.framework,
        row.description,
        row.produces.type,
        row.produces.entityType,
        row.produces.patternId,
        row.specRef ?? "",
        ...(row.roles ?? []),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchFilter)) {
        return false;
      }
    }
    return true;
  };

  let totalBuiltInRules = 0;
  let matchedBuiltInRules = 0;
  const builtInConventions: BuiltInFrameworkCatalog[] = [];

  for (const set of CONVENTION_SETS) {
    const allRows = describeConventions(set);
    totalBuiltInRules += allRows.length;
    const filtered = allRows.filter(filterRow);
    if (filtered.length === 0 && (frameworkFilter || entityTypeFilter || signalFilter || searchFilter)) {
      continue;
    }
    matchedBuiltInRules += filtered.length;
    builtInConventions.push({
      framework: set.framework,
      installedInRepo: detectedFrameworks.includes(set.framework),
      totalRules: allRows.length,
      rules: filtered,
    });
  }

  const playbook = signalFilter
    ? SIGNAL_PLAYBOOK.filter((entry) => entry.signalKind === signalFilter)
    : [...SIGNAL_PLAYBOOK];

  return {
    summary: {
      builtInFrameworkCount: CONVENTION_SETS.length,
      builtInRuleCount: totalBuiltInRules,
      matchedBuiltInRuleCount: matchedBuiltInRules,
      activeUserConventionSetCount: userSetStatuses.length,
      activeUserRuleCount,
      userValidationErrorCount,
      hasChompConfig: configExists,
      detectedFrameworks,
    },
    decisionGuide: {
      preferBuiltInConventions:
        "When authoring new routes, components, handlers, or data access, align to the built-in Paved-Road conventions below so Chomp extracts 100% deterministic Layer 0 edges with zero configuration.",
      whenToAuthorChompConfigConventions:
        "When a repository uses a repeatable syntactic convention (custom HOF wrapper, RPC router, internal SDK/event-bus client) across multiple files, declare a `ConventionSet` under `chomp.config.json#conventions` using `schemaReference` below, then re-run `chomp analyze` and verify via `chomp_get_diff`.",
      whenToUseChompLocalShims:
        "When a call target is determined purely at runtime (DI container tokens, reflection, dynamic plugin registries) and cannot be derived from AST syntax, keep Layer 0 honest and invoke `chomp_local_shims` (`action: 'suggest'` / `'upsert'`) to bridge it as an explicit `L1_SHIMS` plugin overlay.",
      verificationWorkflow: [
        "1. Inspect conventions & matchers with `chomp_get_conventions`.",
        "2. Edit code or update `chomp.config.json#conventions` (confirm `userValidationErrorCount === 0` by re-calling `chomp_get_conventions`).",
        "3. Run `chomp_get_diff` to verify newly extracted deterministic contracts/edges before committing.",
      ],
    },
    activeUserConventions: {
      configPath: "chomp.config.json",
      exists: configExists,
      parseError,
      sets: userSetStatuses,
    },
    builtInConventions,
    signalPlaybook: playbook,
    ...(options.shapeKey?.trim()
      ? { shapeKeyAdvice: buildShapeKeyAdvice(options.shapeKey) }
      : {}),
    ...(includeSchema ? { schemaReference: describeConventionSchema() } : {}),
  };
}
