/**
 * packages/cli/src/visualizer/entityVocabulary.ts
 *
 * Shared Ontology v4.0 (Ephemeral Code Paradigm) vocabulary for the visualizer
 * pipelines. Files and directories are no longer graph primitives, so no stage
 * needs to dissolve them — the graph arrives naturally "dissolved":
 *
 *   - BOUNDARY entities are strictly DEPLOYMENT_UNIT | CLASS | NAMESPACE | INIT_BLOCK
 *   - CONTRACTS are parented to a DEPLOYMENT_UNIT (or a CLASS for PUBLIC_METHOD)
 *   - Edge sources are contracts, classes, public methods or INIT_BLOCKs
 *   - External packages are OPEN_CONNECTORs (`Package: X`) with no parent
 *
 * These are pipeline-internal constants — NOT part of the core ontology
 * (`packages/core/src/types/ontology.ts` stays the authority).
 */

/** Entity types treated as compound parent (package) containers in the layout. */
export const CONTAINER_ENTITY_TYPES: ReadonlySet<string> = new Set(["DEPLOYMENT_UNIT"]);

/**
 * OPEN_CONNECTOR entity types representing `Package: X` exits (external npm
 * packages and Node builtins). Hidden by default in the visualizer: every
 * lodash/fs call is an exit point, but drawing all of them is pure noise.
 * Other OPEN_CONNECTORs (HTTP clients, databases, brokers) stay visible.
 */
export const PACKAGE_CONNECTOR_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "EXTERNAL_PACKAGE",
  "NODE_BUILTIN",
]);

/** Contract entity types that are always treated as an INGRESS (flow entry). */
export const INGRESS_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "API_ENDPOINT",
  "HTTP_ENDPOINT",
  "MCP_TOOL",
  "CLI_COMMAND",
  "NEXTJS_PAGE",
  "NEXTJS_LAYOUT",
  "NEXTJS_MIDDLEWARE",
  "EVENT_LISTENER",
  "PAYLOAD_ENDPOINT",
  "PAYLOAD_ENDPOINTS",
  "PAYLOAD_JOB",
  "PAYLOAD_TASK",
  "PAYLOAD_HOOK",
]);

/** Boundary entity type for top-level side effects executed on module load. */
export const INIT_BLOCK_ENTITY_TYPE = "INIT_BLOCK";

/** Edge entity types that represent runtime control/data flow between nodes. */
export const FLOW_EDGE_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "CALL",
  "CALLS",
  "HTTP_FETCH",
  "DB_QUERY",
  "DB_OPERATION",
  "LOCAL_API_CALL",
  "EVENT_EMIT",
  "RENDERS",
  "REGISTERS",
  "MOUNT",
  "MOUNTS",
  "BINDS_ROUTE",
  "REFERENCES",
  "HANDLES",
  "READS",
  "MUTATES",
  "HOOK_REGISTRATION",
  "REGISTRY_MOUNT",
  "PLUGIN_REGISTRATION",
]);

/**
 * Compile-time schema and static metadata contract entity types (`[PAT-VIS-14]`).
 * These act as Layer 1 Port Valves or static configuration metadata rather than
 * executable stations on the Layer 0 navigation mesh, and are never classified
 * as unreached execution orphans.
 */
export const NON_EXECUTABLE_CONTRACT_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "EXPORTED_TYPE",
  "TYPE_DEFINITION",
  "DB_SCHEMA",
  "VALIDATOR_SCHEMA",
  "COLLECTION_CONFIG",
  "PAYLOAD_COLLECTION",
  "PAYLOAD_GLOBAL",
  "PAYLOAD_BLOCK",
  "PAYLOAD_FIELDS",
  "PAYLOAD_ACCESS",
  "PROPERTY_GETTER",
  "SERVER_GUARD",
  "ROUTE_CONFIG",
  "NEXTJS_METADATA",
  "NEXTJS_ROUTE_CONFIG",
  "EXPRESS_ROUTE_PARAM",
]);

/**
 * Prefixes stripped from node names to produce clean visual labels.
 * `Init:` is deliberately NOT stripped — `Init: <unit>` is the only readable
 * cue that a node is a module-load INIT_BLOCK rather than a contract.
 */
export const LABEL_PREFIX_RE =
  /^(Exported Function|Class|HTTP Endpoint|API Endpoint|Exported Type|Exported Module|CJS Export|Express Mount|Express Route|Middleware|DB Call|HTTP Call|Socket Call|Call|Public Method|Namespace|Deployment Unit|Package|MCP Tool|Next\.js Page|Next\.js Layout|Next\.js Lifecycle|Next\.js Middleware|Next\.js Config|Next\.js Cache|Route Handler|Server Action|Vue Component|Drizzle Schema|Zod Schema|Validator Schema|DB Schema):\s*/i;

/**
 * Strips the `Deployment Unit: ` prefix from a DEPLOYMENT_UNIT node name,
 * yielding the bare package label used for lane/package badges.
 *
 * @param name - Raw node name, e.g. `Deployment Unit: payments-api`.
 * @returns The label without its prefix, e.g. `payments-api`.
 */
export function deploymentUnitLabel(name: string): string {
  return name.replace(/^Deployment Unit:\s*/i, "").split("/").pop() || name;
}

/** Canonical package ordering shared between skeleton anonymization and layout rendering. */
export const CANONICAL_PACKAGE_ORDER = ["cli", "mcp", "core", "db", "web"];

/**
 * [PAT-VIS-17]: Estimates rendered station height to match `drawStationNode` in `stationNode.ts`.
 * Shared between layout verification (`visualLinter.ts`) and board generation.
 */
export function estimateNodeVisualHeight(n: {
  height: number;
  label?: string;
  entityType: string;
  role?: string;
  diffStatus?: string;
  unresolvedCount?: number;
  foldedFunctions?: unknown[];
  callerCount?: number;
  badges?: string[];
  parentLabel?: string;
  microNodes?: unknown[];
}): number {
  const CARD_WIDTH = 240;
  const BASE_HEIGHT = 32;
  if (n.microNodes && n.microNodes.length > 0) {
    return n.height;
  }
  const isInitBlock = n.entityType === "INIT_BLOCK";
  const initStripW = isInitBlock ? 20 : 0;
  const baseLabel = (n.label || n.entityType)
    .replace(/\s*\(To:\s*.*?\)/, "")
    .trim();
  const hasDiffBadge =
    n.diffStatus === "ADDED" ||
    n.diffStatus === "MODIFIED" ||
    n.diffStatus === "REMOVED";
  const hasUnresolvedIndicator = (n.unresolvedCount ?? 0) > 0;
  const hasFoldedDots = (n.foldedFunctions?.length ?? 0) > 0;
  const callerCount = n.callerCount ?? 0;
  const hasCallerCountIndicator = callerCount > 0;
  const isInvComponent =
    /^(?:REACT_COMPONENT|UI_COMPONENT|ASTRO_COMPONENT)$/.test(n.entityType);
  const isInvMiddleware = n.entityType === "MIDDLEWARE";
  const isReturnRole = n.role === "RETURN" || n.role === "INGRESS_RETURN";
  const diffRightReserve =
    (isReturnRole ? 6 : 0) +
    (hasDiffBadge ? 46 : 0) +
    (hasCallerCountIndicator
      ? isInvComponent || isInvMiddleware
        ? 42
        : 30
      : 0) +
    (hasUnresolvedIndicator ? 14 : 0);
  const maxLabelW = CARD_WIDTH - initStripW - 20 - diffRightReserve;
  const maxCharsPerLine = hasDiffBadge
    ? 21
    : hasCallerCountIndicator || hasUnresolvedIndicator
      ? 23
      : 27;
  const charBudget = Math.min(
    maxCharsPerLine,
    Math.max(8, Math.floor(maxLabelW / 6.2)),
  );
  const labelLineCount = baseLabel.length > charBudget ? 2 : 1;

  const uniqueBadges = Array.from(
    new Set(
      (n.badges ?? [])
        .map((b) => b.trim())
        .filter(
          (b) =>
            Boolean(b) &&
            !/^Unresolved:/i.test(b) &&
            !/^(?:(?:Dependency|Middleware|Component):\s*)?pkg:/i.test(b) &&
            !/^Dependency:/i.test(b) &&
            !/^(?:Middleware:\s*)?(?:FS Read|FS Write|Subprocess|Env):/i.test(b) &&
            !/^Component:\s*use[A-Z]/.test(b),
        ),
    ),
  );
  let badgeLineCount = 0;
  if (uniqueBadges.length > 0) {
    const availW = CARD_WIDTH - initStripW - 20;
    let cursorX = 0;
    badgeLineCount = 1;
    for (const b of uniqueBadges) {
      const diffMatch = b.match(/\s+(\+ADDED|~MOD|-REM)$/);
      const badgeDiffSuffix = diffMatch ? ` ${diffMatch[1]}` : "";
      const withoutDiff = diffMatch ? b.slice(0, -diffMatch[0].length) : b;
      const stripped = withoutDiff.replace(
        /^(Component|Middleware|Schema|Dependency|Unresolved):\s*/i,
        "",
      );
      const displayLen =
        Math.min(stripped.length, 24) + badgeDiffSuffix.length;
      const pillW = Math.ceil(displayLen * 5.6) + 26;
      if (cursorX + pillW > availW && cursorX > 0) {
        badgeLineCount++;
        cursorX = 0;
        if (badgeLineCount >= 2) {
          badgeLineCount = 2;
          break;
        }
      }
      cursorX += pillW + 4;
    }
  }

  const hasKindTag =
    n.entityType === "DEPLOYMENT_UNIT" ||
    n.entityType === "NAMESPACE" ||
    n.entityType === "CLASS" ||
    n.entityType === "EXTERNAL_SYSTEM";
  const hasHeader = Boolean(n.parentLabel || hasKindTag);
  const isMultiRowCard =
    hasHeader || labelLineCount > 1 || badgeLineCount > 0 || hasFoldedDots;
  if (!isMultiRowCard) return BASE_HEIGHT;

  const PARENT_STRIP_H = 20;
  const labelTopOffset = n.parentLabel
    ? PARENT_STRIP_H + 8
    : hasKindTag
      ? 16
      : 9;
  const labelBlockH = labelLineCount * 13;
  const badgesTopOffset =
    badgeLineCount > 0 ? labelTopOffset + labelBlockH + 7 : 0;
  const badgesBlockH =
    badgeLineCount > 0 ? badgeLineCount * 16 + (badgeLineCount - 1) * 4 : 0;
  const dotsTopOffset = hasFoldedDots
    ? badgeLineCount > 0
      ? badgesTopOffset + badgesBlockH + 6
      : labelTopOffset + labelBlockH + 6
    : 0;
  const dotsBlockH = hasFoldedDots ? 5 : 0;
  if (hasFoldedDots) {
    return Math.max(BASE_HEIGHT, dotsTopOffset + dotsBlockH + 8);
  }
  if (badgeLineCount === 0) {
    return Math.max(BASE_HEIGHT, labelTopOffset + labelBlockH + 10);
  }
  return Math.max(BASE_HEIGHT, badgesTopOffset + badgesBlockH + 10);
}
