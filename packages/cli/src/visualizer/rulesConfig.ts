import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getRegisteredPluginDefaultLayers } from "@chomp/mcp";

export interface BuiltInRulesConfig {
  /** [PAT-VIS-12] Fold leaf MIDDLEWARE (outDegree === 0) into diamond (`◆`) guard badges on the target station. */
  foldMiddleware: boolean;
  /** [PAT-VIS-13] Fold leaf UI Components (RENDERS with outDegree === 0) into 4-diamond (`❖`) component badges on the parent component. */
  foldComponents: boolean;
  /** [PAT-VIS-18] Group terminal internal utilities & local OS side-effects (outDegree === 0) into circuit-board micro-node clusters. */
  foldMicroNodes: boolean;
}

export type CustomRuleAction =
  | "middleware_badge"
  | "component_badge"
  | "micro_node"
  | "station_node";

export type CustomRuleBadgeMode = "fold_into_callers" | "badge_on_node";

export interface CustomRuleMatch {
  nodeId?: string;
  namePattern?: string;
  entityType?: string;
  patternId?: string;
  packageLabel?: string;
  filePathPattern?: string;
  overlayLayer?: string;
  overlaySource?: string;
  overlayField?: string;
  overlayValue?: string | number | boolean;
}

export interface CustomClassificationRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  match: CustomRuleMatch;
  action: CustomRuleAction;
  badgeLabel?: string;
  badgeMode?: CustomRuleBadgeMode;
  createdBy?: "user" | "agent";
  createdAt?: string;
}

export interface SystemRuleStatus {
  id: string;
  name: string;
  description: string;
  command: string;
  enabled: boolean;
}

export interface ChompRulesConfig {
  version: 1;
  defaults: BuiltInRulesConfig;
  customRules: CustomClassificationRule[];
  /** Per-layer visibility toggles for native Ports (`L1_PORTS`) and registered plugin overlay layers. */
  overlayLayers?: Record<string, boolean>;
  systemRules?: SystemRuleStatus[];
}

export function getDefaultOverlayLayers(): Record<string, boolean> {
  return {
    L1_PORTS: true,
    ...getRegisteredPluginDefaultLayers(),
  };
}

export const DEFAULT_OVERLAY_LAYERS: Record<string, boolean> = getDefaultOverlayLayers();

export const DEFAULT_RULES_CONFIG: ChompRulesConfig = {
  version: 1,
  defaults: {
    foldMiddleware: true,
    foldComponents: true,
    foldMicroNodes: true,
  },
  customRules: [],
  overlayLayers: { ...DEFAULT_OVERLAY_LAYERS },
};

export function normalizeRulesConfig(raw: any): ChompRulesConfig {
  const defaults: BuiltInRulesConfig = {
    foldMiddleware:
      typeof raw?.defaults?.foldMiddleware === "boolean"
        ? raw.defaults.foldMiddleware
        : DEFAULT_RULES_CONFIG.defaults.foldMiddleware,
    foldComponents:
      typeof raw?.defaults?.foldComponents === "boolean"
        ? raw.defaults.foldComponents
        : DEFAULT_RULES_CONFIG.defaults.foldComponents,
    foldMicroNodes:
      typeof raw?.defaults?.foldMicroNodes === "boolean"
        ? raw.defaults.foldMicroNodes
        : DEFAULT_RULES_CONFIG.defaults.foldMicroNodes,
  };

  const overlayLayers: Record<string, boolean> = getDefaultOverlayLayers();
  if (raw?.overlayLayers && typeof raw.overlayLayers === "object") {
    for (const [k, v] of Object.entries(raw.overlayLayers)) {
      if (typeof v === "boolean") {
        overlayLayers[k] = v;
      }
    }
  }

  const customRules: CustomClassificationRule[] = Array.isArray(raw?.customRules)
    ? raw.customRules
        .filter((r: any) => r && typeof r === "object" && typeof r.id === "string")
        .map((r: any): CustomClassificationRule => {
          const action: CustomRuleAction =
            r.action === "component_badge" ||
            r.action === "micro_node" ||
            r.action === "station_node"
              ? r.action
              : "middleware_badge";
          const badgeMode: CustomRuleBadgeMode =
            r.badgeMode === "badge_on_node" ? "badge_on_node" : "fold_into_callers";
          const match: CustomRuleMatch = {};
          if (typeof r.match?.nodeId === "string" && r.match.nodeId.trim()) {
            match.nodeId = r.match.nodeId.trim();
          }
          if (typeof r.match?.namePattern === "string" && r.match.namePattern.trim()) {
            match.namePattern = r.match.namePattern.trim();
          }
          if (typeof r.match?.entityType === "string" && r.match.entityType.trim()) {
            match.entityType = r.match.entityType.trim();
          }
          if (typeof r.match?.patternId === "string" && r.match.patternId.trim()) {
            match.patternId = r.match.patternId.trim();
          }
          if (typeof r.match?.packageLabel === "string" && r.match.packageLabel.trim()) {
            match.packageLabel = r.match.packageLabel.trim();
          }
          if (typeof r.match?.filePathPattern === "string" && r.match.filePathPattern.trim()) {
            match.filePathPattern = r.match.filePathPattern.trim();
          }
          if (typeof r.match?.overlayLayer === "string" && r.match.overlayLayer.trim()) {
            match.overlayLayer = r.match.overlayLayer.trim();
          }
          if (typeof r.match?.overlaySource === "string" && r.match.overlaySource.trim()) {
            match.overlaySource = r.match.overlaySource.trim();
          }
          if (typeof r.match?.overlayField === "string" && r.match.overlayField.trim()) {
            match.overlayField = r.match.overlayField.trim();
          }
          if (
            typeof r.match?.overlayValue === "string" ||
            typeof r.match?.overlayValue === "number" ||
            typeof r.match?.overlayValue === "boolean"
          ) {
            match.overlayValue = r.match.overlayValue;
          }

          return {
            id: r.id.trim(),
            name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : r.id.trim(),
            ...(typeof r.description === "string" && r.description.trim()
              ? { description: r.description.trim() }
              : {}),
            enabled: typeof r.enabled === "boolean" ? r.enabled : true,
            match,
            action,
            ...(typeof r.badgeLabel === "string" && r.badgeLabel.trim()
              ? { badgeLabel: r.badgeLabel.trim() }
              : {}),
            badgeMode,
            createdBy: r.createdBy === "agent" ? "agent" : "user",
            ...(typeof r.createdAt === "string" ? { createdAt: r.createdAt } : {}),
          };
        })
    : [];

  return {
    version: 1,
    defaults,
    customRules,
    overlayLayers,
  };
}

export function resolveRulesFilePath(chompDirOrDbPath: string): string {
  const dir = chompDirOrDbPath.endsWith(".db")
    ? dirname(chompDirOrDbPath)
    : chompDirOrDbPath;
  return resolve(dir, "rules.json");
}

function resolveRepoGitDirs(repoRoot: string): string[] {
  const dirs: string[] = [];
  const dotGit = resolve(repoRoot, ".git");
  if (!existsSync(dotGit)) return dirs;
  try {
    const st = statSync(dotGit);
    let gitDir = dotGit;
    if (st.isFile()) {
      const ptr = readFileSync(dotGit, "utf-8").trim();
      if (ptr.startsWith("gitdir:")) {
        gitDir = resolve(repoRoot, ptr.slice("gitdir:".length).trim());
      }
    }
    dirs.push(gitDir);
    const commonDirFile = resolve(gitDir, "commondir");
    if (existsSync(commonDirFile)) {
      const rel = readFileSync(commonDirFile, "utf-8").trim();
      if (rel) {
        const commonDir = resolve(gitDir, rel);
        if (!dirs.includes(commonDir)) dirs.push(commonDir);
      }
    }
  } catch {
    // Ignore git pointer resolution errors
  }
  return dirs;
}

export function detectSystemRules(chompDirOrDbPath: string): SystemRuleStatus[] {
  const chompDir = chompDirOrDbPath.endsWith(".db")
    ? dirname(chompDirOrDbPath)
    : chompDirOrDbPath;
  const repoRoot = dirname(chompDir);

  const hookNames = ["post-commit", "post-merge", "post-checkout", "pre-commit"];
  const candidateHookDirs = [
    resolve(repoRoot, ".husky"),
    ...resolveRepoGitDirs(repoRoot).map((d) => resolve(d, "hooks")),
  ];

  let gitSyncLinked = false;
  try {
    for (const hookDir of candidateHookDirs) {
      for (const hookName of hookNames) {
        const candidatePath = resolve(hookDir, hookName);
        if (existsSync(candidatePath)) {
          const content = readFileSync(candidatePath, "utf-8");
          if (content.includes("chomp analyze")) {
            gitSyncLinked = true;
            break;
          }
        }
      }
      if (gitSyncLinked) break;
    }
  } catch {
    gitSyncLinked = false;
  }

  const dbExists = existsSync(resolve(chompDir, "graph.db"));

  const configPath = resolve(repoRoot, "chomp.config.json");
  let configExists = false;
  let configSummary = "Optional workspace exclusions, custom conventions, and plugin configuration.";
  try {
    if (existsSync(configPath)) {
      configExists = true;
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        const activeKeys = ["excludeWorkspaces", "conventions", "shims", "designSystem"].filter(
          (k) => parsed[k] !== undefined,
        );
        if (activeKeys.length > 0) {
          configSummary = `Configured sections: ${activeKeys.join(", ")}.`;
        }
      }
    }
  } catch {
    // Keep default summary on malformed JSON
  }

  return [
    {
      id: "graph-db-baseline",
      name: "Local graph baseline",
      description:
        "Stores the deterministic AST graph in .chomp/graph.db for instant layout and working-tree diffs.",
      command: "chomp analyze .",
      enabled: dbExists,
    },
    {
      id: "git-sync-hooks",
      name: "Git sync hooks",
      description:
        "Runs chomp analyze automatically after commits, merges, and branch switches.",
      command: "chomp analyze . --quiet",
      enabled: gitSyncLinked,
    },
    {
      id: "project-config",
      name: "Project configuration",
      description: configSummary,
      command: "chomp.config.json",
      enabled: configExists,
    },
  ];
}

export function loadRulesConfig(chompDirOrDbPath: string): ChompRulesConfig {
  const filePath = resolveRulesFilePath(chompDirOrDbPath);
  const systemRules = detectSystemRules(chompDirOrDbPath);
  if (!existsSync(filePath)) {
    return {
      version: 1,
      defaults: { ...DEFAULT_RULES_CONFIG.defaults },
      customRules: [],
      overlayLayers: getDefaultOverlayLayers(),
      systemRules,
    };
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    return {
      ...normalizeRulesConfig(raw),
      systemRules,
    };
  } catch {
    return {
      version: 1,
      defaults: { ...DEFAULT_RULES_CONFIG.defaults },
      customRules: [],
      overlayLayers: getDefaultOverlayLayers(),
      systemRules,
    };
  }
}

export function saveRulesConfig(
  chompDirOrDbPath: string,
  config: ChompRulesConfig,
): ChompRulesConfig {
  const filePath = resolveRulesFilePath(chompDirOrDbPath);
  const normalized = normalizeRulesConfig(config);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf-8");
  return {
    ...normalized,
    systemRules: detectSystemRules(chompDirOrDbPath),
  };
}

export function getRulesFingerprint(chompDirOrDbPath: string): string {
  const filePath = resolveRulesFilePath(chompDirOrDbPath);
  if (!existsSync(filePath)) return "rules:default";
  try {
    const st = statSync(filePath);
    return `rules:${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return "rules:default";
  }
}

function normalizePkgToken(pkg?: string): string {
  if (!pkg) return "";
  return pkg.trim().replace(/^@[^/]+\//, "").toLowerCase();
}

function resolveDotField(obj: Record<string, any> | undefined, fieldPath: string): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (fieldPath in obj) return obj[fieldPath];
  const parts = fieldPath.split(".").filter(Boolean);
  let cur: any = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function matchesOverlayFieldValue(
  actual: any,
  expected: string | number | boolean | undefined
): boolean {
  if (expected === undefined || expected === "") {
    if (Array.isArray(actual)) return actual.length > 0;
    return Boolean(actual);
  }
  if (typeof expected === "boolean") {
    return Boolean(actual) === expected;
  }
  if (typeof expected === "number") {
    return typeof actual === "number" && actual === expected;
  }
  const expStr = String(expected).trim();
  if (typeof actual === "number") {
    const cmpMatch = expStr.match(/^(>=|<=|>|<|==|=)\s*(-?\d+(?:\.\d+)?)$/);
    if (cmpMatch) {
      const op = cmpMatch[1];
      const threshold = Number(cmpMatch[2]);
      if (op === ">") return actual > threshold;
      if (op === ">=") return actual >= threshold;
      if (op === "<") return actual < threshold;
      if (op === "<=") return actual <= threshold;
      return actual === threshold;
    }
    return String(actual) === expStr;
  }
  if (typeof actual === "boolean") {
    return String(actual).toLowerCase() === expStr.toLowerCase();
  }
  if (Array.isArray(actual)) {
    const lowerExp = expStr.toLowerCase();
    return actual.some((item) =>
      String(item ?? "")
        .toLowerCase()
        .includes(lowerExp)
    );
  }
  if (actual != null) {
    return String(actual).toLowerCase().includes(expStr.toLowerCase());
  }
  return false;
}

function matchesPatternOrSubstring(haystacks: string[], pattern: string): boolean {
  if (haystacks.length === 0) return false;
  const pat = pattern.trim();
  if (!pat) return true;
  if (pat.startsWith("/") && pat.lastIndexOf("/") > 0) {
    const lastSlash = pat.lastIndexOf("/");
    const body = pat.slice(1, lastSlash);
    const flags = pat.slice(lastSlash + 1) || "i";
    try {
      const re = new RegExp(body, flags);
      return haystacks.some((h) => re.test(h));
    } catch {
      const lower = pat.toLowerCase();
      return haystacks.some((h) => h.toLowerCase().includes(lower));
    }
  }
  const lower = pat.toLowerCase();
  return haystacks.some((h) => h.toLowerCase().includes(lower));
}

export function matchesCustomRule(
  node: {
    id: string;
    name?: string;
    label?: string;
    entityType: string;
    patternId?: string;
    evidence?: any;
    overlays?: Array<{
      layer: string;
      source?: string;
      payload?: Record<string, any>;
    }>;
  },
  pkgLabel: string,
  rule: CustomClassificationRule,
): boolean {
  if (!rule.enabled) return false;
  const {
    nodeId,
    namePattern,
    entityType,
    patternId,
    packageLabel,
    filePathPattern,
    overlayLayer,
    overlaySource,
    overlayField,
    overlayValue,
  } = rule.match;
  const hasAnyCriterion = Boolean(
    nodeId ||
      namePattern ||
      entityType ||
      patternId ||
      packageLabel ||
      filePathPattern ||
      overlayLayer ||
      overlaySource ||
      overlayField
  );
  if (!hasAnyCriterion) return false;

  const baseId = node.id.split("::")[0].split("@")[0];
  if (nodeId) {
    const targetId = nodeId.split("::")[0].split("@")[0].toLowerCase();
    if (
      baseId.toLowerCase() !== targetId &&
      !node.id.toLowerCase().includes(targetId)
    ) {
      return false;
    }
  }

  if (entityType) {
    if (node.entityType.toLowerCase() !== entityType.toLowerCase()) {
      return false;
    }
  }

  if (patternId) {
    const nodePat = (node.patternId ?? "").toLowerCase();
    if (!nodePat.includes(patternId.toLowerCase())) {
      return false;
    }
  }

  if (packageLabel) {
    const expectedPkg = normalizePkgToken(packageLabel);
    const actualPkg = normalizePkgToken(pkgLabel);
    if (expectedPkg && actualPkg !== expectedPkg) {
      return false;
    }
  }

  if (filePathPattern) {
    const rawEv = node.evidence
      ? Array.isArray(node.evidence)
        ? node.evidence
        : [node.evidence]
      : [];
    const filePaths = rawEv
      .map((e: any) => (typeof e?.filePath === "string" ? e.filePath : ""))
      .filter(Boolean);
    if (!matchesPatternOrSubstring(filePaths, filePathPattern)) {
      return false;
    }
  }

  if (namePattern) {
    const haystacks = [node.name ?? "", node.label ?? ""].filter(Boolean);
    if (!matchesPatternOrSubstring(haystacks, namePattern)) {
      return false;
    }
  }

  if (overlayLayer || overlaySource || overlayField) {
    const overlays = node.overlays ?? [];
    if (overlays.length === 0) return false;
    const matchedOverlay = overlays.some((ov) => {
      if (
        overlayLayer &&
        ov.layer.toLowerCase() !== overlayLayer.trim().toLowerCase()
      ) {
        return false;
      }
      if (
        overlaySource &&
        !(ov.source ?? "")
          .toLowerCase()
          .includes(overlaySource.trim().toLowerCase())
      ) {
        return false;
      }
      if (overlayField) {
        const val = resolveDotField(ov.payload, overlayField.trim());
        if (!matchesOverlayFieldValue(val, overlayValue)) {
          return false;
        }
      }
      return true;
    });
    if (!matchedOverlay) return false;
  }

  return true;
}
