/**
 * packages/mcp/src/pluginRunner.ts
 *
 * Modular Chomp Plugin Runtime, Folder Discovery, Settings, Active Views & Projection Engine
 * Enforces [PAT-DB-03], [PAT-DB-05], [PAT-MCP-03], [PAT-VIS-28], and [PAT-VIS-36].
 *
 * Architecture ("One Folder, Zero Plumbing Edits"):
 *   - Built-in plugins live in self-contained folders under `packages/mcp/src/plugins/<name>/index.ts`
 *     and are auto-discovered at startup (`discoverPluginsInDir`).
 *   - Repository-local plugin state & user settings live under `.chomp/plugins/<plugin.name>/`
 *     (e.g. `.chomp/plugins/local-shims/shims.json`, `.chomp/plugins/<name>/settings.json`).
 *   - Every plugin automatically receives:
 *       1. Scoped `.chomp/plugins/<name>/` file I/O + SHA-256 `inputs` staleness hashes (`ctx.pluginDir`,
 *          `ctx.readPluginFile`, `ctx.writePluginFile`, `ctx.hashPluginFile`).
 *       2. Declarative `settingsSchema` resolved into `ctx.settings` and rendered automatically in the
 *          Explorer Settings drawer (`GET/PUT /api/plugins/:name/settings`).
 *       3. Active View array controls via both declarative Spotlight lenses (`summary.views[].highlightNodeIds`)
 *          and imperative `ctx.setActiveView({ highlightNodeIds, ... })` writing `.chomp/current_view.json`.
 *       4. Generic `PluginPresentation` v1 sections rendered in the HUD, Package Inspector, and Node Inspector.
 *       5. Optional `projectGraph`, `mcpTools`, and `formatCliSummary` hooks wired automatically across
 *          CLI, Explorer UI, and MCP server with zero edits outside the plugin's own folder.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import {
  CORE_EXTRACTOR_VERSION,
  PLUGIN_PRESENTATION_PAYLOAD_KEY,
  analyzeTarget,
  isValidEnvVarName,
  resolvePluginSettings,
  sanitizePluginPresentation,
  type PluginInspectorScope,
  type PluginSettingField,
  type PluginSettingValue,
  type PluginToolDescriptorSummary,
  type RepresentationGraph,
} from "@chomp/core";
import {
  createSQLiteStorage,
  type ChompStorage,
  type EntityOverlayInput,
  type EntityOverlayRecord,
  type OverlayEvidenceItem,
  type OverlayInputDependency,
  type OverlayLayer,
} from "@chomp/db";
import {
  buildActiveViewUrl,
  resolveViewTargetAltitude,
  type ActiveViewLevel,
} from "./intelligence.js";

export const PLUGINS_STATE_DIR_REL = ".chomp/plugins" as const;

export type ChompPluginEvidenceHelper = (
  filePath: string,
  lineNumber?: number,
  snippet?: string,
  evidenceRole?: string
) => OverlayEvidenceItem;

export interface PluginActiveViewRequest {
  title: string;
  description: string;
  /** Semantic node IDs (`CONTRACT`, `CLASS`, `NAMESPACE`, `INIT_BLOCK`, `OPEN_CONNECTOR`) to highlight. */
  highlightNodeIds: string[];
  /** Optional per-node banner callouts (`nodeId -> short note`). */
  nodeAnnotations?: Record<string, string>;
  /** Optional explicit altitude (`"system"` or `"package"`). Auto-resolved from `highlightNodeIds` when omitted. */
  viewLevel?: ActiveViewLevel;
  /** Optional target package label when `viewLevel === "package"`. */
  packageName?: string;
  /** Optional summary pills displayed in the Agent Spotlight banner. */
  pills?: string[];
  /** Optional key-value metric summary displayed in the Agent Spotlight banner. */
  metrics?: Record<string, string | number>;
  /** Optional graph used to infer `viewLevel` and `packageName` from `highlightNodeIds`. */
  graph?: RepresentationGraph;
}

export interface ChompPluginContext {
  repoId: string;
  repoName: string;
  repoPath: string;
  graph: RepresentationGraph;
  /** Existing persisted overlays in `entity_overlays` for `repoId` (e.g. `AI_HYPOTHESIS` rows for `enrich-nodes`). */
  existingOverlays: EntityOverlayRecord[];
  /** Repo-relative POSIX file paths accepted by `plugin.accepts(file)` (includes `.chomp/plugins/**`). */
  files: string[];
  environment: string;
  runId: string;
  /** Absolute path to `.chomp/plugins/<plugin.name>`. */
  pluginDir: string;
  /** Repo-relative POSIX path `.chomp/plugins/<plugin.name>`. */
  pluginDirRel: string;
  /** Resolved user settings (`.chomp/plugins/<plugin.name>/settings.json` merged over `settingsSchema` defaults). */
  settings: Record<string, PluginSettingValue>;
  /** Reads a file relative to `repoPath` (or absolute path) as UTF-8 text. */
  readFile: (filePath: string) => string | null;
  /** Reads a file inside `.chomp/plugins/<plugin.name>/` as UTF-8 text. */
  readPluginFile: (relPath: string) => string | null;
  /** Writes UTF-8 text to a file inside `.chomp/plugins/<plugin.name>/` (creating directories automatically). */
  writePluginFile: (relPath: string, content: string) => string;
  /**
   * Computes the 16-char SHA-256 input dependency record `{ path, hash }`
   * for non-AST `inputs` staleness tracking (`[PAT-DB-05]`).
   */
  hashFile: (filePath: string) => OverlayInputDependency | null;
  /** Computes `{ path, hash }` for a file inside `.chomp/plugins/<plugin.name>/`. */
  hashPluginFile: (relPath: string) => OverlayInputDependency | null;
  /** Builds a normalized `OverlayEvidenceItem` (`filePath`, `lineNumber`, `snippet`, `evidenceRole`). */
  evidence: ChompPluginEvidenceHelper;
  /** Resolves a secret from `process.env` via a `kind: "env"` setting key (or direct env-var name), never storing secrets in `settings.json`. */
  resolveSecret: (settingKeyOrEnvName: string) => string | undefined;
  /** Writes `.chomp/current_view.json` to highlight `highlightNodeIds` in the Explorer Active View banner. */
  setActiveView: (spec: PluginActiveViewRequest) => string | null;
}

export interface ChompPluginExtractResult {
  overlays: EntityOverlayInput[];
  summary?: Record<string, any>;
}

export interface ChompPluginProjectionOverlayLike {
  entityId: string;
  layer: string;
  source?: string;
  payload: Record<string, any>;
}

export interface ChompPluginProjectionContext {
  graph: RepresentationGraph;
  overlays: readonly ChompPluginProjectionOverlayLike[];
  repoPath?: string;
  settings: Record<string, PluginSettingValue>;
  /** Reads a repo-relative file (supports git-blob overrides during historical diff comparisons). */
  readRepoFile: (relPath: string) => string | null;
  /** Reads a file relative to `.chomp/plugins/<plugin.name>/`. */
  readPluginFile: (relPath: string) => string | null;
  /** Resolves a secret from `process.env` via a `kind: "env"` setting key or direct env-var name. */
  resolveSecret: (settingKeyOrEnvName: string) => string | undefined;
}

export interface ChompPluginToolContext {
  repoPath: string;
  repoName: string;
  repoId: string;
  dbPath: string;
  settings: Record<string, PluginSettingValue>;
  /** Resolves a secret from `process.env` via a `kind: "env"` setting key or direct env-var name. */
  resolveSecret: (settingKeyOrEnvName: string) => string | undefined;
  loadRawGraph: () => Promise<RepresentationGraph | null>;
  loadProjectedGraph: () => Promise<RepresentationGraph | null>;
  withStorage: <T>(fn: (storage: ChompStorage) => Promise<T>) => Promise<T>;
  invalidateCache: () => void;
  runSelf: (opts?: Partial<RunChompPluginOptions>) => Promise<RunChompPluginResult>;
  setActiveView: (spec: PluginActiveViewRequest) => string | null;
}

export type ChompPluginMcpToolResult =
  | { content: Array<{ type: "text"; text: string }>; isError?: boolean }
  | object
  | string;

export interface ChompPluginMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (
    args: Record<string, any>,
    ctx: ChompPluginToolContext
  ) => Promise<ChompPluginMcpToolResult> | ChompPluginMcpToolResult;
}

export interface ChompCliAnsiHelpers {
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
}

export interface ChompPlugin {
  /** Unique plugin identifier used as `source` in `entity_overlays` and `.chomp/plugins/<name>/` (e.g. `'local-shims'`). */
  name: string;
  /** Semantic version of the plugin (e.g. `'1.0.0'`). */
  version: string;
  /** Default overlay layer written by this plugin (`'L1_DESIGN_SYSTEM'`, `'L1_SHIMS'`, or `'PLUGIN:<name>'`). */
  layer: OverlayLayer;
  /** Human-readable name shown in the HUD, Inspector, and Settings drawer (default: `name`). */
  displayName?: string;
  /** Human-readable description of what the plugin extracts or projects. */
  description: string;
  /** Optional display sort order across HUD, Settings, and CLI (lower renders first; defaults to `100`). */
  order?: number;
  /** Default layer visibility when unset in `.chomp/rules.json` (defaults to `true`). */
  defaultEnabled?: boolean;
  /** Superseded overlay `source` names pruned (per layer/environment) whenever this plugin persists a run. */
  legacySources?: string[];
  /**
   * Optional inspector surfaces where this plugin's `PluginPresentation` sections may appear.
   * Defaults to both `["package", "node"]` when omitted. Set `["package"]` when node-level data
   * writes directly to core entity fields (e.g. `enrich-nodes`).
   */
  inspectorScopes?: PluginInspectorScope[];
  /** Declarative user-configurable settings persisted in `.chomp/plugins/<name>/settings.json` and rendered in Settings. */
  settingsSchema?: PluginSettingField[];
  /**
   * When `false`, skips walking the full repository source tree during `runChompPlugin` and only inspects
   * `.chomp/plugins/**` + root `chomp.config.json` (ideal for graph-only, snapshot, or telemetry plugins).
   * Defaults to `true`.
   */
  scanRepoFiles?: boolean;
  /** Predicate returning true if a repo-relative POSIX file path is relevant to this plugin. */
  accepts: (filePath: string) => boolean;
  /** Deterministic extraction function producing `EntityOverlayInput[]` and optional summary metadata. */
  extract: (
    ctx: ChompPluginContext
  ) =>
    | Promise<ChompPluginExtractResult | EntityOverlayInput[]>
    | ChompPluginExtractResult
    | EntityOverlayInput[];
  /**
   * Optional in-memory graph projection hook (e.g. `local-shims` projecting `INFERRED` Layer 1 edges/connectors)
   * invoked automatically before layout, health, and MCP graph intelligence queries when this plugin's layer is enabled.
   */
  projectGraph?: (ctx: ChompPluginProjectionContext) => RepresentationGraph;
  /**
   * Optional predicate returning true when an overlay from this plugin alters the structural story layout
   * (participates in `structureFp` even when custom classification rules do not reference overlays).
   */
  isStructuralOverlay?: (overlay: ChompPluginProjectionOverlayLike) => boolean;
  /** Optional MCP tools owned by this plugin and auto-registered on the `@chomp/mcp` server. */
  mcpTools?: ChompPluginMcpTool[];
  /** Optional terminal summary lines printed by `chomp plugin run <name>`. */
  formatCliSummary?: (res: RunChompPluginResult, ansi: ChompCliAnsiHelpers) => string[];
}

/** Identity helper providing full TypeScript inference when authoring a self-contained plugin folder. */
export function defineChompPlugin<T extends ChompPlugin>(plugin: T): T {
  return plugin;
}

export interface RunChompPluginOptions {
  repoPath: string;
  repoId?: string;
  repoName?: string;
  dbPath?: string;
  storage?: ChompStorage;
  graph?: RepresentationGraph;
  existingOverlays?: EntityOverlayRecord[];
  environment?: string;
  runId?: string;
  excludeWorkspaces?: string[];
  settingsOverride?: Record<string, PluginSettingValue>;
  /** When true (default), writes extracted overlays to `entity_overlays` and prunes stale rows for this source. */
  persist?: boolean;
  /**
   * When true, persists `.chomp/plugins/<name>/last-run.json` with status, duration, warnings, and any error.
   * Defaults to `true` whenever `persist` is enabled (unless an in-memory `storage` is passed on a directory without `.chomp/`).
   */
  persistRunRecord?: boolean;
}

export interface RunAllChompPluginsOptions extends RunChompPluginOptions {
  /** When true, isolates per-plugin exceptions so remaining plugins still execute (`last-run.json` records each failure). */
  continueOnError?: boolean;
  /** Optional callback invoked when an individual plugin throws during `runAllChompPlugins`. */
  onPluginError?: (plugin: ChompPlugin, error: Error) => void;
}

export interface PersistedPluginRunRecord {
  pluginName: string;
  pluginVersion: string;
  layer: string;
  status: "ok" | "error";
  runId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  acceptedFileCount?: number;
  overlayCount?: number;
  presentationWarnings: string[];
  error?: string;
}

export interface RunChompPluginResult {
  pluginName: string;
  pluginVersion: string;
  layer: OverlayLayer;
  runId: string;
  acceptedFileCount: number;
  overlayCount: number;
  overlays: EntityOverlayInput[];
  summary: Record<string, any>;
  durationMs: number;
  /** Problems found while validating `payload.presentation` (dropped sections, unsupported versions, size caps). */
  presentationWarnings: string[];
}

const IGNORED_DIRS = new Set([
  ".git",
  ".chomp",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".astro",
  ".turbo",
  "storybook-static",
  "coverage",
  "vendor",
  "migrations",
  "upgrades",
]);

const pluginRegistry = new Map<string, ChompPlugin>();

/** Max serialized size of one overlay's presentation; lowest-priority sections are dropped beyond it. */
export const MAX_PRESENTATION_BYTES = 120_000;

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizePluginDirSegment(pluginName: string): string {
  return pluginName.trim().toLowerCase().replace(/^plugin:/i, "").replace(/[^a-z0-9._-]/g, "-");
}

export function getPluginStateDirRel(pluginName: string): string {
  return `${PLUGINS_STATE_DIR_REL}/${sanitizePluginDirSegment(pluginName)}`;
}

export function getPluginStateDir(repoPath: string, pluginName: string): string {
  return resolve(repoPath, ".chomp", "plugins", sanitizePluginDirSegment(pluginName));
}

export function getPluginSettingsPath(repoPath: string, pluginName: string): string {
  return resolve(getPluginStateDir(repoPath, pluginName), "settings.json");
}

export const PLUGIN_LAST_RUN_FILENAME = "last-run.json";

export function getPluginLastRunPath(repoPath: string, pluginName: string): string {
  return resolve(getPluginStateDir(repoPath, pluginName), PLUGIN_LAST_RUN_FILENAME);
}

export function readPluginLastRun(
  repoPath: string | undefined,
  pluginName: string
): PersistedPluginRunRecord | null {
  if (!repoPath) return null;
  const filePath = getPluginLastRunPath(repoPath, pluginName);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isObj(parsed)) return null;
    const status = parsed.status === "error" ? "error" : parsed.status === "ok" ? "ok" : null;
    if (!status) return null;
    if (typeof parsed.startedAt !== "string" || typeof parsed.finishedAt !== "string") return null;
    return {
      pluginName: typeof parsed.pluginName === "string" ? parsed.pluginName : pluginName,
      pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "0.0.0",
      layer: typeof parsed.layer === "string" ? parsed.layer : "",
      status,
      ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt,
      durationMs: typeof parsed.durationMs === "number" && Number.isFinite(parsed.durationMs) ? parsed.durationMs : 0,
      ...(typeof parsed.acceptedFileCount === "number" ? { acceptedFileCount: parsed.acceptedFileCount } : {}),
      ...(typeof parsed.overlayCount === "number" ? { overlayCount: parsed.overlayCount } : {}),
      presentationWarnings: Array.isArray(parsed.presentationWarnings)
        ? parsed.presentationWarnings.filter((w): w is string => typeof w === "string")
        : [],
      ...(typeof parsed.error === "string" && parsed.error ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
}

export function writePluginLastRun(
  repoPath: string,
  record: PersistedPluginRunRecord
): string | null {
  try {
    const filePath = getPluginLastRunPath(repoPath, record.pluginName);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return filePath;
  } catch {
    return null;
  }
}

export function loadPluginSettings(
  repoPath: string | undefined,
  pluginOrName: ChompPlugin | string
): Record<string, PluginSettingValue> {
  const plugin = typeof pluginOrName === "string" ? getChompPlugin(pluginOrName) : pluginOrName;
  if (!plugin) return {};
  let raw: unknown = {};
  if (repoPath) {
    const settingsPath = getPluginSettingsPath(repoPath, plugin.name);
    if (existsSync(settingsPath)) {
      try {
        raw = JSON.parse(readFileSync(settingsPath, "utf8"));
      } catch {
        raw = {};
      }
    }
  }
  return resolvePluginSettings(plugin.settingsSchema, raw);
}

export function savePluginSettings(
  repoPath: string,
  pluginOrName: ChompPlugin | string,
  patch: Record<string, unknown>
): Record<string, PluginSettingValue> {
  const plugin = typeof pluginOrName === "string" ? getChompPlugin(pluginOrName) : pluginOrName;
  if (!plugin) {
    throw new Error(`Unknown Chomp plugin '${String(pluginOrName)}'.`);
  }
  const settingsPath = getPluginSettingsPath(repoPath, plugin.name);
  let currentRaw: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (isObj(parsed)) currentRaw = parsed;
    } catch {
      currentRaw = {};
    }
  }
  const merged = { ...currentRaw, ...(isObj(patch) ? patch : {}) };
  const resolved = resolvePluginSettings(plugin.settingsSchema, merged);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(resolved, null, 2)}\n`, "utf8");
  return resolved;
}

export function getPluginMcpToolSummaries(plugin: ChompPlugin): PluginToolDescriptorSummary[] {
  return (plugin.mcpTools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
  }));
}

/**
 * Resolves a secret from `env` (`process.env` by default) via a `kind: "env"` setting key
 * or direct environment-variable identifier — never reading raw secrets from `settings.json`.
 */
export function resolvePluginSecret(
  plugin: Pick<ChompPlugin, "settingsSchema">,
  settings: Record<string, PluginSettingValue>,
  settingKeyOrEnvName: string,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const field = plugin.settingsSchema?.find((f) => f.key === settingKeyOrEnvName);
  const envVarName =
    field && field.kind === "env"
      ? String(settings[field.key] ?? field.defaultValue ?? "").trim()
      : settingKeyOrEnvName.trim();
  if (!envVarName || !isValidEnvVarName(envVarName)) return undefined;
  const raw = env[envVarName];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/**
 * Computes boolean presence status (`true` = set in `env`, `false` = unset) for each `kind: "env"`
 * field in `plugin.settingsSchema`. Safe to expose to the UI because secret values are never included.
 */
export function getPluginEnvStatus(
  plugin: Pick<ChompPlugin, "settingsSchema">,
  settings: Record<string, PluginSettingValue>,
  env: Record<string, string | undefined> = process.env
): Record<string, boolean> | undefined {
  const envFields = (plugin.settingsSchema ?? []).filter((f) => f.kind === "env");
  if (envFields.length === 0) return undefined;
  const status: Record<string, boolean> = {};
  for (const field of envFields) {
    status[field.key] = Boolean(resolvePluginSecret(plugin, settings, field.key, env));
  }
  return status;
}

/**
 * Resolves the current Git branch name for a repository or worktree (handling `.git` pointer files).
 */
export function resolveRepoGitBranch(
  repoPath: string,
  fallbackBranch?: string
): string | undefined {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch && branch !== "HEAD") {
      return branch;
    }
  } catch {
    // Fallback to reading .git/HEAD directly below
  }

  try {
    const dotGitPath = resolve(repoPath, ".git");
    if (existsSync(dotGitPath)) {
      let gitDir = dotGitPath;
      const stat = statSync(dotGitPath);
      if (stat.isFile()) {
        const ptr = readFileSync(dotGitPath, "utf8").trim();
        const m = ptr.match(/^gitdir:\s*(.+)$/i);
        if (m) {
          gitDir = resolve(repoPath, m[1].trim());
        }
      }
      const headPath = resolve(gitDir, "HEAD");
      if (existsSync(headPath)) {
        const headContent = readFileSync(headPath, "utf8").trim();
        if (headContent.startsWith("ref: refs/heads/")) {
          return headContent.replace("ref: refs/heads/", "").trim();
        }
      }
    }
  } catch {
    // Ignore and fall back
  }

  return fallbackBranch;
}

/**
 * Resolves the canonical repository name for `inputPath`, unwrapping Git worktree
 * `.git` pointer files (`gitdir:` + `commondir`) back to the parent repository root.
 */
export function resolveRepoName(inputPath: string): string {
  const abs = resolve(inputPath);
  let dir = abs;
  try {
    if (existsSync(abs) && !statSync(abs).isDirectory()) {
      dir = dirname(abs);
    }
  } catch {
    // Path may not exist yet; fall back to basename(abs)
  }

  const posixDir = dir.replace(/\\/g, "/");
  const fixtureMatch = /\/fixtures\/(?:cloned-repos|test-repos)\/([^/]+)(?:\/|$)/.exec(posixDir);
  if (fixtureMatch) {
    const matchEnd =
      posixDir.indexOf(fixtureMatch[0]) + fixtureMatch[0].replace(/\/$/, "").length;
    const fixtureRoot = dir.slice(0, matchEnd);
    if (!existsSync(resolve(fixtureRoot, ".git"))) {
      return fixtureMatch[1]!;
    }
  }

  if (existsSync(resolve(dir, ".chomp")) && !existsSync(resolve(dir, ".git"))) {
    return basename(dir);
  }

  try {
    let cur = dir;
    let gitEntryPath: string | undefined;
    let gitOwnerDir: string | undefined;
    for (let i = 0; i < 8; i++) {
      const candidate = resolve(cur, ".git");
      if (existsSync(candidate)) {
        gitEntryPath = candidate;
        gitOwnerDir = cur;
        break;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }

    if (gitEntryPath && gitOwnerDir) {
      const stat = statSync(gitEntryPath);
      if (stat.isFile()) {
        const ptr = readFileSync(gitEntryPath, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/i.exec(ptr);
        if (match) {
          const gitDir = resolve(gitOwnerDir, match[1]!.trim());
          const commonDirFile = resolve(gitDir, "commondir");
          if (existsSync(commonDirFile)) {
            const relCommon = readFileSync(commonDirFile, "utf8").trim();
            if (relCommon) {
              const commonDir = resolve(gitDir, relCommon);
              if (basename(commonDir) === ".git") {
                return basename(dirname(commonDir));
              }
              const cleanBare = basename(commonDir).replace(/\.git$/i, "");
              if (cleanBare) return cleanBare;
            }
          }
          const normalizedGitDir = gitDir.replace(/\\/g, "/");
          const wtMatch = /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(normalizedGitDir);
          if (wtMatch && wtMatch[1]) {
            return basename(wtMatch[1]);
          }
          return basename(gitOwnerDir);
        }
      }
      if (stat.isDirectory()) {
        if (
          gitOwnerDir !== dir &&
          existsSync(resolve(dir, "package.json")) &&
          !dir.startsWith(resolve(gitOwnerDir, "packages") + "/") &&
          !dir.startsWith(resolve(gitOwnerDir, "apps") + "/")
        ) {
          return basename(dir);
        }
        if (!posixDir.includes("/.chomp/")) {
          return basename(gitOwnerDir);
        }
      }
    }
  } catch {
    // Fall back to basename(dir)
  }

  return basename(dir);
}

/**
 * Resolves the base URL of the local Chomp Visualizer server (`chomp ui`) for Active View deep-links.
 */
export function resolveActiveUiBaseUrl(repoPath: string): string {
  if (process.env.CHOMP_UI_URL && process.env.CHOMP_UI_URL.trim()) {
    return process.env.CHOMP_UI_URL.trim().replace(/\/+$/, "");
  }
  try {
    const serverMetaPath = resolve(repoPath, ".chomp", "ui_server.json");
    if (existsSync(serverMetaPath)) {
      const parsed = JSON.parse(readFileSync(serverMetaPath, "utf8"));
      if (typeof parsed?.url === "string" && parsed.url.trim()) {
        return parsed.url.trim().replace(/\/+$/, "");
      }
      if (typeof parsed?.port === "number" && Number.isFinite(parsed.port)) {
        return `http://localhost:${parsed.port}`;
      }
    }
  } catch {
    // Fall back to default port
  }
  if (process.env.CHOMP_UI_PORT && process.env.CHOMP_UI_PORT.trim()) {
    return `http://localhost:${process.env.CHOMP_UI_PORT.trim()}`;
  }
  return "http://localhost:5555";
}

/**
 * Writes `.chomp/current_view.json` on behalf of a plugin (`[PAT-MCP-03]`, `[PAT-VIS-28]`),
 * resolving topological altitude and deep-link URL automatically.
 */
export function writePluginActiveView(
  options: {
    repoPath: string;
    repoId?: string;
    repoName?: string;
    pluginName: string;
    layer: string;
  },
  spec: PluginActiveViewRequest
): string | null {
  const highlightIds = Array.from(
    new Set((spec.highlightNodeIds ?? []).filter((id): id is string => typeof id === "string" && id.trim().length > 0))
  );
  if (highlightIds.length === 0) return null;

  const repoPath = resolve(options.repoPath);
  const repoName = options.repoName ?? resolveRepoName(repoPath);
  const repoId = options.repoId ?? repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const branchName = resolveRepoGitBranch(repoPath, spec.graph?.branchName);

  let viewLevel: ActiveViewLevel = spec.viewLevel ?? (spec.packageName ? "package" : "system");
  let packageName = spec.packageName;
  if (spec.graph) {
    const altitude = resolveViewTargetAltitude(
      spec.graph,
      highlightIds,
      spec.viewLevel ?? (spec.packageName ? "package" : undefined),
      spec.packageName
    );
    viewLevel = altitude.viewLevel;
    packageName = altitude.packageName;
  }

  const viewUrl = buildActiveViewUrl({
    baseUrl: resolveActiveUiBaseUrl(repoPath),
    viewLevel,
    packageName,
  });

  const viewPath = resolve(repoPath, ".chomp", "current_view.json");
  mkdirSync(dirname(viewPath), { recursive: true });
  writeFileSync(
    viewPath,
    `${JSON.stringify(
      {
        repoId,
        repoName,
        ...(branchName ? { branchName } : {}),
        createdAt: new Date().toISOString(),
        viewLevel,
        ...(packageName ? { packageName } : {}),
        viewUrl,
        title: spec.title,
        description: spec.description,
        highlightNodeIds: highlightIds,
        ...(spec.nodeAnnotations && Object.keys(spec.nodeAnnotations).length > 0
          ? { nodeAnnotations: spec.nodeAnnotations }
          : {}),
        layer: options.layer,
        source: options.pluginName,
        ...(spec.pills && spec.pills.length > 0 ? { pills: spec.pills } : {}),
        ...(spec.metrics && Object.keys(spec.metrics).length > 0 ? { metrics: spec.metrics } : {}),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return viewUrl;
}

/**
 * Enforces the Plugin Presentation Contract on every overlay a plugin produced: the presentation is
 * sanitized (bounded, unknown blocks dropped) and size-capped. A presentation that is not usable is
 * removed so the UI falls back to the generic payload view instead of failing.
 */
export function enforcePresentationContract(
  overlays: EntityOverlayInput[],
  pluginName: string
): { overlays: EntityOverlayInput[]; warnings: string[] } {
  const warnings: string[] = [];
  const out = overlays.map((ov) => {
    const raw = ov.payload?.[PLUGIN_PRESENTATION_PAYLOAD_KEY];
    if (raw === undefined) return ov;
    const { presentation, warnings: w } = sanitizePluginPresentation(raw);
    for (const msg of w) warnings.push(`${pluginName}:${ov.entityId}: ${msg}`);
    const { [PLUGIN_PRESENTATION_PAYLOAD_KEY]: _drop, ...rest } = ov.payload ?? {};
    if (!presentation) return { ...ov, payload: rest };
    let bounded = presentation;
    while (
      JSON.stringify(bounded).length > MAX_PRESENTATION_BYTES &&
      bounded.sections.length > 1
    ) {
      const dropIdx = bounded.sections.reduce(
        (worst, sec, i, arr) => ((sec.priority ?? 100) >= (arr[worst]!.priority ?? 100) ? i : worst),
        0
      );
      warnings.push(
        `${pluginName}:${ov.entityId}: presentation exceeded ${MAX_PRESENTATION_BYTES} bytes; dropped section "${bounded.sections[dropIdx]!.id}"`
      );
      bounded = {
        ...bounded,
        sections: bounded.sections.filter((_, i) => i !== dropIdx),
      };
    }
    return { ...ov, payload: { ...rest, [PLUGIN_PRESENTATION_PAYLOAD_KEY]: bounded } };
  });
  return { overlays: out, warnings };
}

export function registerChompPlugin(plugin: ChompPlugin): void {
  pluginRegistry.set(plugin.name.trim().toLowerCase(), plugin);
}

export function unregisterChompPlugin(name: string): boolean {
  const key = name.trim().toLowerCase().replace(/^plugin:/i, "");
  return pluginRegistry.delete(key);
}

export function getChompPlugin(name: string): ChompPlugin | undefined {
  const key = name.trim().toLowerCase().replace(/^plugin:/i, "");
  return pluginRegistry.get(key);
}

export function listChompPlugins(): ChompPlugin[] {
  return [...pluginRegistry.values()].sort(
    (a, b) =>
      (a.order ?? 100) - (b.order ?? 100) ||
      (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)
  );
}

/**
 * Returns default `overlayLayers` visibility map combining core layers and all registered plugins.
 */
export function getRegisteredPluginDefaultLayers(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const plugin of pluginRegistry.values()) {
    out[plugin.layer] = plugin.defaultEnabled ?? true;
  }
  return out;
}

/**
 * Checks whether a plugin overlay alters structural layout (`structureFp`) via registered `isStructuralOverlay` hooks.
 */
export function isRegisteredStructuralPluginOverlay(
  overlay: ChompPluginProjectionOverlayLike
): boolean {
  for (const plugin of pluginRegistry.values()) {
    if (!plugin.isStructuralOverlay) continue;
    if (plugin.layer === overlay.layer || plugin.name === overlay.source) {
      if (plugin.isStructuralOverlay(overlay)) return true;
    }
  }
  return false;
}

/**
 * Reads `.chomp/rules.json#overlayLayers` from `repoPath` when not explicitly supplied.
 */
export function readRepoOverlayLayerToggles(repoPath: string | undefined): Record<string, boolean> {
  if (!repoPath) return {};
  try {
    const rulesPath = resolve(repoPath, ".chomp", "rules.json");
    if (!existsSync(rulesPath)) return {};
    const parsed = JSON.parse(readFileSync(rulesPath, "utf8"));
    if (isObj(parsed?.overlayLayers)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed.overlayLayers)) {
        if (typeof v === "boolean") out[k] = v;
      }
      return out;
    }
  } catch {
    // Ignore malformed rules.json
  }
  return {};
}

export function isPluginLayerEnabled(
  plugin: ChompPlugin,
  overlayLayers?: Record<string, boolean>
): boolean {
  const defaultEnabled = plugin.defaultEnabled ?? true;
  if (!overlayLayers) return defaultEnabled;
  if (plugin.layer in overlayLayers) {
    return overlayLayers[plugin.layer] !== false;
  }
  return defaultEnabled;
}

/**
 * Runs every enabled registered plugin's `projectGraph` hook in deterministic registration order.
 * Eliminates plugin-specific projection branches from `ui.ts`, `health.ts`, and `mcp/src/index.ts`.
 */
export function applyActivePluginProjections(
  graph: RepresentationGraph,
  options?: {
    repoPath?: string;
    overlays?: readonly ChompPluginProjectionOverlayLike[];
    overlayLayers?: Record<string, boolean>;
    readRepoFileOverride?: (relPath: string) => string | null;
  }
): RepresentationGraph {
  const repoPath = options?.repoPath ? resolve(options.repoPath) : undefined;
  const overlayLayers = options?.overlayLayers ?? readRepoOverlayLayerToggles(repoPath);
  const overlays = options?.overlays ?? [];

  const readRepoFile = (relPath: string): string | null => {
    const norm = toPosixPath(relPath).replace(/^\/+/, "");
    if (options?.readRepoFileOverride) {
      return options.readRepoFileOverride(norm);
    }
    if (!repoPath) return null;
    const abs = resolve(repoPath, norm);
    if (!existsSync(abs)) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };

  let current = graph;
  for (const plugin of pluginRegistry.values()) {
    if (!plugin.projectGraph) continue;
    if (!isPluginLayerEnabled(plugin, overlayLayers)) continue;
    const settings = loadPluginSettings(repoPath, plugin);
    const pluginDirRel = getPluginStateDirRel(plugin.name);
    const readPluginFile = (relPath: string): string | null => {
      const clean = toPosixPath(relPath).replace(/^\/+/, "");
      return readRepoFile(`${pluginDirRel}/${clean}`);
    };
    const scopedOverlays = overlays.filter(
      (o) => o.layer === plugin.layer || (o.source && o.source === plugin.name)
    );
    current = plugin.projectGraph({
      graph: current,
      overlays: scopedOverlays,
      repoPath,
      settings,
      readRepoFile,
      readPluginFile,
      resolveSecret: (key) => resolvePluginSecret(plugin, settings, key),
    });
  }
  return current;
}

/**
 * Auto-discovers and registers self-contained plugin folders inside `pluginsRootDir`.
 * Each subdirectory `<pluginsRootDir>/<folder>/` is checked for `index.js`, `index.mjs`, or `index.ts`.
 */
export async function discoverPluginsInDir(pluginsRootDir: string): Promise<ChompPlugin[]> {
  if (!existsSync(pluginsRootDir)) return [];
  let entries;
  try {
    entries = readdirSync(pluginsRootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered: ChompPlugin[] = [];
  const subdirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of subdirs) {
    const folderPath = resolve(pluginsRootDir, dir.name);
    const candidates = ["index.js", "index.mjs", "index.ts", "plugin.mjs", "plugin.js"];
    const entryName = candidates.find((c) => existsSync(resolve(folderPath, c)));
    if (!entryName) continue;

    const entryPath = resolve(folderPath, entryName);
    const mod = await import(pathToFileURL(entryPath).href);
    const candidate: unknown = mod?.default ?? mod?.plugin;
    if (
      isObj(candidate) &&
      typeof candidate.name === "string" &&
      typeof candidate.layer === "string" &&
      typeof candidate.accepts === "function" &&
      typeof candidate.extract === "function"
    ) {
      const typed = candidate as unknown as ChompPlugin;
      registerChompPlugin(typed);
      discovered.push(typed);
    }
  }

  return discovered;
}

function matchesExcludedWorkspace(
  relPosixPath: string,
  excludeWorkspaces?: string[]
): boolean {
  if (!excludeWorkspaces || excludeWorkspaces.length === 0) return false;
  for (const rawPattern of excludeWorkspaces) {
    const clean = toPosixPath(rawPattern.trim()).replace(/\/+\*?$/, "");
    if (!clean) continue;
    if (relPosixPath === clean || relPosixPath.startsWith(`${clean}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Walks `repoPath` deterministically (plus `.chomp/plugins/**`) and returns sorted repo-relative POSIX file paths.
 */
export function collectPluginRepoFiles(
  repoPath: string,
  excludeWorkspaces?: string[]
): string[] {
  const absRoot = resolve(repoPath);
  if (!existsSync(absRoot)) return [];

  const stat = statSync(absRoot);
  if (!stat.isDirectory()) {
    return [basename(absRoot)];
  }

  const isInsideFixtures =
    toPosixPath(absRoot).includes("/fixtures/test-repos/") ||
    toPosixPath(absRoot).includes("/fixtures/cloned-repos/");

  const results: string[] = [];

  const walk = (dir: string, allowDotChompPlugins = false) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!allowDotChompPlugins) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".storybook") continue;
      } else if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = resolve(dir, entry.name);
      const relPath = toPosixPath(relative(absRoot, fullPath));
      if (!relPath) continue;

      if (!allowDotChompPlugins) {
        if (
          !isInsideFixtures &&
          (relPath === "fixtures" || relPath.startsWith("fixtures/"))
        ) {
          continue;
        }
        if (matchesExcludedWorkspace(relPath, excludeWorkspaces)) {
          continue;
        }
      }

      if (entry.isDirectory()) {
        walk(fullPath, allowDotChompPlugins);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".min.js") || entry.name.endsWith(".min.css")) {
          continue;
        }
        if (allowDotChompPlugins && entry.name === PLUGIN_LAST_RUN_FILENAME) {
          continue;
        }
        results.push(relPath);
      }
    }
  };

  walk(absRoot, false);

  // Automatically include all per-plugin state & manifest files under `.chomp/plugins/**`
  const pluginsStateDir = resolve(absRoot, ".chomp", "plugins");
  if (existsSync(pluginsStateDir)) {
    walk(pluginsStateDir, true);
  }
  // Backward-compatible legacy `.chomp/shims.json` support if present
  if (existsSync(resolve(absRoot, ".chomp", "shims.json"))) {
    results.push(".chomp/shims.json");
  }

  results.sort((a, b) => a.localeCompare(b));
  return results;
}

/**
 * Lightweight file collector used when `plugin.scanRepoFiles === false`:
 * inspects ONLY `.chomp/plugins/**`, legacy `.chomp/shims.json`, and root `chomp.config.json`
 * without walking the repository source tree.
 */
export function collectPluginStateFiles(repoPath: string): string[] {
  const absRoot = resolve(repoPath);
  if (!existsSync(absRoot)) return [];
  const stat = statSync(absRoot);
  if (!stat.isDirectory()) return [basename(absRoot)];

  const results: string[] = [];
  const walkPluginsDir = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = resolve(dir, entry.name);
      const relPath = toPosixPath(relative(absRoot, fullPath));
      if (!relPath) continue;
      if (entry.isDirectory()) {
        walkPluginsDir(fullPath);
      } else if (entry.isFile()) {
        if (entry.name === PLUGIN_LAST_RUN_FILENAME) continue;
        results.push(relPath);
      }
    }
  };

  const pluginsStateDir = resolve(absRoot, ".chomp", "plugins");
  if (existsSync(pluginsStateDir)) {
    walkPluginsDir(pluginsStateDir);
  }
  if (existsSync(resolve(absRoot, ".chomp", "shims.json"))) {
    results.push(".chomp/shims.json");
  }
  if (existsSync(resolve(absRoot, "chomp.config.json"))) {
    results.push("chomp.config.json");
  }
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

/**
 * Computes a deterministic 16-character SHA-256 fingerprint for an input file (`[PAT-DB-05]`).
 * Matches the exact 16-hex slice used by `graphRepository.ts` (`upsertEntityOverlaySync` / `getEntityOverlaysSync`).
 */
export function computeFileOverlayHash(
  repoPath: string,
  relOrAbsPath: string
): OverlayInputDependency | null {
  const absRoot = resolve(repoPath);
  const absFile = resolve(absRoot, relOrAbsPath);
  if (!existsSync(absFile)) return null;
  try {
    const buf = readFileSync(absFile);
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
    const relPath = toPosixPath(relative(absRoot, absFile));
    return {
      path: relPath && !relPath.startsWith("..") ? relPath : toPosixPath(relOrAbsPath),
      hash,
    };
  } catch {
    return null;
  }
}

export function buildOverlayEvidence(
  filePath: string,
  lineNumber?: number,
  snippet?: string,
  evidenceRole?: string
): OverlayEvidenceItem {
  return {
    filePath: toPosixPath(filePath.trim()),
    ...(typeof lineNumber === "number" && Number.isFinite(lineNumber)
      ? { lineNumber }
      : {}),
    ...(typeof snippet === "string" && snippet.trim()
      ? { snippet: snippet.trim().slice(0, 240) }
      : {}),
    ...(typeof evidenceRole === "string" && evidenceRole.trim()
      ? { evidenceRole: evidenceRole.trim() }
      : {}),
  };
}

/**
 * Executes a single `ChompPlugin` against a repository and optionally persists
 * its deterministic `EXTRACTED` overlays into `entity_overlays` with `runId` prune-on-recommit (`[PAT-DB-05]`).
 */
export async function runChompPlugin(
  pluginOrName: ChompPlugin | string,
  options: RunChompPluginOptions
): Promise<RunChompPluginResult> {
  const t0 = Date.now();
  const plugin =
    typeof pluginOrName === "string"
      ? getChompPlugin(pluginOrName)
      : pluginOrName;

  if (!plugin) {
    throw new Error(
      `Unknown Chomp plugin '${String(pluginOrName)}'. Registered plugins: ${
        listChompPlugins()
          .map((p) => p.name)
          .join(", ") || "none"
      }`
    );
  }

  const startedAt = new Date(t0).toISOString();
  const stat = statSync(options.repoPath);
  const isDir = stat.isDirectory();
  const repoPath = isDir ? resolve(options.repoPath) : dirname(resolve(options.repoPath));
  const repoName = options.repoName ?? resolveRepoName(repoPath);
  const repoId =
    options.repoId ?? repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const environment = (options.environment || "default").trim();
  const persist = options.persist ?? true;
  const dbPath = options.dbPath ?? resolve(repoPath, ".chomp", "graph.db");
  const shouldPersistRunRecord =
    options.persistRunRecord ??
    (persist && (!options.storage || existsSync(dirname(dbPath))));

  let ownStorage: ChompStorage | null = null;
  const storage =
    options.storage ??
    (persist || ((!options.graph || !options.existingOverlays) && existsSync(dbPath))
      ? (ownStorage = createSQLiteStorage(dbPath))
      : undefined);

  try {
    let resolvedRepoId = repoId;
    let graph = options.graph;
    if (!graph && storage) {
      graph = (await storage.getRepresentationGraph(resolvedRepoId)) ?? undefined;
      if (!graph) {
        const repos = await storage.listRepositories();
        if (repos[0]) {
          resolvedRepoId = repos[0].id;
          graph = (await storage.getRepresentationGraph(resolvedRepoId)) ?? undefined;
        }
      }
    }
    if (!graph) {
      graph = analyzeTarget(
        repoPath,
        CORE_EXTRACTOR_VERSION,
        undefined,
        options.excludeWorkspaces
      );
    }

    const existingOverlays =
      options.existingOverlays ??
      (storage ? await storage.getEntityOverlays(resolvedRepoId) : []);

    const runId =
      options.runId?.trim() ||
      `${plugin.name}@${plugin.version}:${graph.commitSha || "nogit"}:${Date.now().toString(36)}`;

    const allFiles =
      plugin.scanRepoFiles === false
        ? collectPluginStateFiles(repoPath)
        : collectPluginRepoFiles(repoPath, options.excludeWorkspaces);
    const acceptedFiles = allFiles.filter((f) => plugin.accepts(f));

    const fileCache = new Map<string, string | null>();
    const hashCache = new Map<string, OverlayInputDependency | null>();

    const readFile = (relOrAbs: string): string | null => {
      const key = toPosixPath(relOrAbs);
      if (fileCache.has(key)) return fileCache.get(key) ?? null;
      const abs = resolve(repoPath, relOrAbs);
      if (!existsSync(abs)) {
        fileCache.set(key, null);
        return null;
      }
      try {
        const content = readFileSync(abs, "utf8");
        fileCache.set(key, content);
        return content;
      } catch {
        fileCache.set(key, null);
        return null;
      }
    };

    const hashFile = (relOrAbs: string): OverlayInputDependency | null => {
      const key = toPosixPath(relOrAbs);
      if (hashCache.has(key)) return hashCache.get(key) ?? null;
      const dep = computeFileOverlayHash(repoPath, relOrAbs);
      hashCache.set(key, dep);
      return dep;
    };

    const pluginDir = getPluginStateDir(repoPath, plugin.name);
    const pluginDirRel = getPluginStateDirRel(plugin.name);
    const settings = options.settingsOverride
      ? resolvePluginSettings(plugin.settingsSchema, {
          ...loadPluginSettings(repoPath, plugin),
          ...options.settingsOverride,
        })
      : loadPluginSettings(repoPath, plugin);

    const readPluginFile = (relPath: string): string | null => {
      const clean = toPosixPath(relPath).replace(/^\/+/, "");
      return readFile(`${pluginDirRel}/${clean}`);
    };

    const writePluginFile = (relPath: string, content: string): string => {
      const clean = toPosixPath(relPath).replace(/^\/+/, "");
      const absTarget = resolve(pluginDir, clean);
      mkdirSync(dirname(absTarget), { recursive: true });
      writeFileSync(absTarget, content, "utf8");
      const relKey = `${pluginDirRel}/${clean}`;
      fileCache.set(relKey, content);
      hashCache.delete(relKey);
      return absTarget;
    };

    const hashPluginFile = (relPath: string): OverlayInputDependency | null => {
      const clean = toPosixPath(relPath).replace(/^\/+/, "");
      return hashFile(`${pluginDirRel}/${clean}`);
    };

    const setActiveView = (spec: PluginActiveViewRequest): string | null =>
      writePluginActiveView(
        {
          repoPath,
          repoId: resolvedRepoId,
          repoName,
          pluginName: plugin.name,
          layer: plugin.layer,
        },
        { graph, ...spec }
      );

    const ctx: ChompPluginContext = {
      repoId: resolvedRepoId,
      repoName,
      repoPath,
      graph,
      existingOverlays,
      files: acceptedFiles,
      environment,
      runId,
      pluginDir,
      pluginDirRel,
      settings,
      readFile,
      readPluginFile,
      writePluginFile,
      hashFile,
      hashPluginFile,
      evidence: buildOverlayEvidence,
      resolveSecret: (key) => resolvePluginSecret(plugin, settings, key),
      setActiveView,
    };

    const rawResult = await plugin.extract(ctx);
    const rawOverlays = Array.isArray(rawResult)
      ? rawResult
      : (rawResult.overlays ?? []);
    const summary = Array.isArray(rawResult) ? {} : (rawResult.summary ?? {});

    const enforced = enforcePresentationContract(rawOverlays, plugin.name);
    const normalizedOverlays: EntityOverlayInput[] = enforced.overlays.map((ov) => ({
      ...ov,
      repositoryId: ov.repositoryId ?? resolvedRepoId,
      layer: ov.layer || plugin.layer,
      source: ov.source || plugin.name,
      environment: ov.environment || environment,
      derivation: ov.derivation ?? "EXTRACTED",
      runId,
      pruneStaleBySource: true,
      merge: ov.merge ?? false,
    }));

    if (persist && storage) {
      if (normalizedOverlays.length > 0) {
        await storage.upsertEntityOverlays(normalizedOverlays, {
          repositoryId: resolvedRepoId,
          layer: plugin.layer,
          source: plugin.name,
          environment,
          runId,
          pruneStaleBySource: true,
        });
      } else {
        await storage.pruneEntityOverlays({
          repositoryId: resolvedRepoId,
          layer: plugin.layer,
          source: plugin.name,
          environment,
          activeRunId: runId,
        });
      }
      for (const legacySource of plugin.legacySources ?? []) {
        await storage.pruneEntityOverlays({
          repositoryId: resolvedRepoId,
          layer: plugin.layer,
          source: legacySource,
          environment,
          activeRunId: runId,
        });
      }
    }

    const durationMs = Date.now() - t0;
    if (shouldPersistRunRecord) {
      writePluginLastRun(repoPath, {
        pluginName: plugin.name,
        pluginVersion: plugin.version,
        layer: plugin.layer,
        status: "ok",
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs,
        acceptedFileCount: acceptedFiles.length,
        overlayCount: normalizedOverlays.length,
        presentationWarnings: enforced.warnings,
      });
    }

    return {
      pluginName: plugin.name,
      pluginVersion: plugin.version,
      layer: plugin.layer,
      runId,
      acceptedFileCount: acceptedFiles.length,
      overlayCount: normalizedOverlays.length,
      overlays: normalizedOverlays,
      summary,
      durationMs,
      presentationWarnings: enforced.warnings,
    };
  } catch (err: any) {
    if (shouldPersistRunRecord) {
      writePluginLastRun(repoPath, {
        pluginName: plugin.name,
        pluginVersion: plugin.version,
        layer: plugin.layer,
        status: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        presentationWarnings: [],
        error: String(err?.message ?? err).slice(0, 1000),
      });
    }
    throw err;
  } finally {
    if (ownStorage) {
      await ownStorage.close();
    }
  }
}

/**
 * Runs all registered Chomp plugins (plus any repo-local `.chomp/plugins/<custom>/plugin.mjs` drop-ins)
 * sequentially against `options.repoPath`.
 */
export async function runAllChompPlugins(
  options: RunAllChompPluginsOptions
): Promise<RunChompPluginResult[]> {
  const repoLocalPluginsDir = resolve(options.repoPath, ".chomp", "plugins");
  if (existsSync(repoLocalPluginsDir)) {
    await discoverPluginsInDir(repoLocalPluginsDir);
  }
  const plugins = listChompPlugins();
  const results: RunChompPluginResult[] = [];
  for (const plugin of plugins) {
    try {
      const res = await runChompPlugin(plugin, options);
      results.push(res);
    } catch (err: any) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      options.onPluginError?.(plugin, errorObj);
      if (!options.continueOnError) {
        throw errorObj;
      }
    }
  }
  return results;
}
