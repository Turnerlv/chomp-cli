/**
 * packages/core/src/types/pluginPresentation.ts
 *
 * Plugin Presentation Contract (v1).
 *
 * Plugins describe *what to show* (sections made of typed blocks); the Explorer renders them generically in
 * the HUD and inspector. Plugins never ship UI code and the UI never hard-codes a plugin's payload keys.
 *
 *   - Stored as `entity_overlays.payload.presentation` on the plugin's real entities (packages, components),
 *     so it follows [PAT-DB-03] and survives `chomp analyze` re-extractions.
 *   - Served *after* the structural graph by the UI server (`/api/plugins/*`), so plugins can update
 *     independently of, and without re-laying-out, the main structure ([PAT-VIS-36]).
 *   - Bounded and sanitized (`sanitizePluginPresentation`) at write time and again at serve time.
 *
 * This file is dependency-free and safe to import (type-only) from the web client.
 */

export const PLUGIN_PRESENTATION_VERSION = 1 as const;

/** Key under `entity_overlays.payload` that holds a `PluginPresentation`. */
export const PLUGIN_PRESENTATION_PAYLOAD_KEY = "presentation" as const;

/**
 * Marker the UI server leaves in a structural (`/api/layout`, `/api/graph`) overlay payload after it defers
 * the presentation to `/api/plugins/*`. Clients skip the generic payload dump for overlays carrying it.
 */
export const PLUGIN_PRESENTATION_AVAILABLE_KEY = "presentationAvailable" as const;

export type PresentationTone = "neutral" | "good" | "warn" | "bad" | "info" | "muted";

/** Overall state of a plugin result for an entity. `unknown`/`n/a` are valid, honest states. */
export type PresentationStatus = "ok" | "warn" | "error" | "unknown" | "n/a";

export interface PresentationEvidenceRef {
  filePath: string;
  lineNumber?: number;
  snippet?: string;
  /** Short role label, e.g. `hardcoded:#333`, `missing-token:--x`. */
  label?: string;
}

export interface PresentationBadge {
  text: string;
  tone?: PresentationTone;
  tooltip?: string;
}

export type PresentationMetricUnit =
  | "%"
  | "count"
  | "ms"
  | "s"
  | "px"
  | "score"
  | "rps"
  | "req/s"
  | "bytes"
  | "kb"
  | "mb"
  | (string & {});

export interface PresentationMetric {
  id: string;
  label: string;
  /** `null` renders as "n/a" (no evidence), never as 0. */
  value: string | number | null;
  unit?: PresentationMetricUnit;
  tone?: PresentationTone;
  /** Explains the value, or why it is `null`. */
  hint?: string;
  /** High-level line items shown when this metric card is selected. */
  items?: PresentationListItem[];
  /** Items beyond this are collapsed behind "Show all (+N)". */
  maxVisible?: number;
  /** Total before server-side truncation. */
  totalCount?: number;
  /** Message shown when `items` is empty and this metric card is selected. */
  emptyText?: string;
}

export interface PresentationListItem {
  label: string;
  detail?: string;
  tone?: PresentationTone;
  evidence?: PresentationEvidenceRef[];
  /** Graph entity this item refers to; the UI makes it navigable. */
  entityId?: string;
}

export interface PresentationTableRow {
  cells: Record<string, string | number | null>;
  tone?: PresentationTone;
  evidence?: PresentationEvidenceRef[];
  entityId?: string;
}

export interface PresentationTableColumn {
  id: string;
  label: string;
  align?: "left" | "right";
  mono?: boolean;
}

export interface PresentationCheck {
  label: string;
  /** `null` = could not be evaluated (unknown, not a pass). */
  ok: boolean | null;
  detail?: string;
  evidence?: PresentationEvidenceRef[];
}

export type PresentationBlock =
  | { kind: "metrics"; items: PresentationMetric[] }
  | {
      kind: "keyValue";
      items: Array<{
        label: string;
        value: string | number;
        mono?: boolean;
        tone?: PresentationTone;
        evidence?: PresentationEvidenceRef[];
      }>;
    }
  | { kind: "text"; text: string; tone?: PresentationTone }
  | {
      kind: "list";
      title?: string;
      items: PresentationListItem[];
      /** Items beyond this are collapsed behind "show all". */
      maxVisible?: number;
      /** Total before server-side truncation (honest "showing 20 of 380"). */
      totalCount?: number;
      emptyText?: string;
    }
  | {
      kind: "table";
      title?: string;
      columns: PresentationTableColumn[];
      rows: PresentationTableRow[];
      maxVisible?: number;
      totalCount?: number;
      emptyText?: string;
    }
  | { kind: "checks"; title?: string; items: PresentationCheck[] }
  | { kind: "evidence"; title?: string; items: PresentationEvidenceRef[]; totalCount?: number };

export interface PresentationSection {
  /** Stable id (accordion state, dedupe across entities). */
  id: string;
  title: string;
  tooltip?: string;
  badge?: PresentationBadge;
  defaultOpen?: boolean;
  /** Lower first. Default 100. */
  priority?: number;
  blocks: PresentationBlock[];
}

export interface PluginSpotlightView {
  /** Stable id within the plugin presentation (e.g. `raw-literals`, `arbitrary-tailwind`). */
  id: string;
  /** Short human title displayed in the HUD trigger slot (e.g. `Hardcoded colors & sizes`). */
  title: string;
  /** Concise explanation of what is affected and why. */
  description?: string;
  /** Optional count or severity badge (e.g. `{ text: "47", tone: "warn" }`). */
  badge?: PresentationBadge;
  /** Graph entity IDs highlighted on the canvas when this view is triggered. */
  highlightNodeIds: string[];
  /** Target zoom scope (`package` or `system`). */
  viewLevel?: "package" | "system";
  /** Target package key when `viewLevel === "package"`. */
  packageName?: string;
  /** Per-node annotations displayed in the Active View walkthrough card when stepping through nodes. */
  nodeAnnotations?: Record<string, string>;
  /** Optional overlay layer key associated with this view (e.g. `L1_DESIGN_SYSTEM`). */
  layer?: string;
}

export type PluginInspectorScope = "package" | "node";

export interface PluginHudSummaryItem {
  /** Short skimmable line-item label (e.g. unhandled call pattern name). */
  label: string;
  /** Optional count or concise value pill displayed at the right of the row. */
  value?: string | number;
  /** Render the label in monospace when true. */
  mono?: boolean;
}

export interface PluginPromptAction {
  /** Short button label, e.g. `Copy enrichment prompt` or `Copy shim prompt`. */
  label: string;
  /** Ready-to-copy instructions or agent prompt text. */
  text: string;
  /** Optional short caption shown beside or under the prompt action. */
  hint?: string;
}

export interface PluginPresentationSummary {
  status?: PresentationStatus;
  badge?: PresentationBadge;
  headline?: string;
  /** Optional repo-wide headline used when aggregating multiple packages in the HUD. */
  repoHeadline?: string;
  /** Short, concise explanation of how the plugin helps and when to use it, rendered in the HUD. */
  description?: string;
  /** Real number of issues (not the number of finding categories). */
  issueCount?: number;
  /** At most 4 are shown in the HUD card. */
  metrics?: PresentationMetric[];
  /** Compact skimmable rows rendered in the expanded HUD card (e.g. unhandled call patterns). */
  items?: PluginHudSummaryItem[];
  /** Pre-computed issue/topic views that can activate the canvas Active View spotlight. */
  views?: PluginSpotlightView[];
  /** Optional copyable instructions / agent prompt surfaced generically in the HUD. */
  prompt?: PluginPromptAction;
  /** Optional repo-wide copyable instructions / agent prompt used when aggregating multiple packages. */
  repoPrompt?: PluginPromptAction;
  /** When true, hides this plugin row in the compact HUD when idle (keeps Inspector & Settings active). */
  hideInHud?: boolean;
}

export interface PluginPresentation {
  version: typeof PLUGIN_PRESENTATION_VERSION;
  summary?: PluginPresentationSummary;
  sections: PresentationSection[];
  generatedAt?: string;
}

// ---------------------------------------------------------------------------
// Server ⇄ client API shapes (`/api/plugins/*`)
// ---------------------------------------------------------------------------

export type PluginRunState = "idle" | "running" | "error";

export interface PluginRunStatus {
  state: PluginRunState;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface PluginPackageSummary {
  entityId: string;
  /** Display label of the package (from the overlay payload, never derived from a repo name). */
  label: string;
  /** Key that matches `layout.packageBounds` when known. */
  key: string;
  summary: PluginPresentationSummary;
}

export type PluginSettingValue = boolean | number | string;

export interface PluginSettingOption {
  value: string;
  label: string;
}

export type PluginSettingField =
  | {
      key: string;
      label: string;
      description?: string;
      kind: "boolean";
      defaultValue: boolean;
    }
  | {
      key: string;
      label: string;
      description?: string;
      kind: "number";
      defaultValue: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      key: string;
      label: string;
      description?: string;
      kind: "string";
      defaultValue: string;
      placeholder?: string;
    }
  | {
      key: string;
      label: string;
      description?: string;
      kind: "select";
      defaultValue: string;
      options: PluginSettingOption[];
    }
  | {
      key: string;
      label: string;
      description?: string;
      /**
       * Stores ONLY an environment variable identifier (e.g. `"KONG_KONNECT_TOKEN"`) in `settings.json` —
       * never the secret token value itself. Resolved server-side from `process.env` via `ctx.resolveSecret(key)`.
       */
      kind: "env";
      defaultValue: string;
      placeholder?: string;
    };

export interface PluginToolDescriptorSummary {
  name: string;
  description: string;
}

export interface PluginOverviewEntry {
  /** Overlay `source` (plugin name), e.g. `design-system`. */
  source: string;
  layer: string;
  displayName: string;
  description?: string;
  version?: string;
  /** Optional HUD & Settings display sort order (lower renders first; defaults to 100). */
  order?: number;
  /** Default visibility when not explicitly overridden in `.chomp/rules.json` (defaults to `true`). */
  defaultEnabled?: boolean;
  /** Repo-relative plugin state folder (e.g. `.chomp/plugins/local-shims`). */
  stateDir?: string;
  /** Declarative settings schema automatically rendered in the Explorer Settings drawer. */
  settingsSchema?: PluginSettingField[];
  /** Current resolved settings (`.chomp/plugins/<source>/settings.json` merged over defaults). */
  settings?: Record<string, PluginSettingValue>;
  /** Presence status (`true` = set in `process.env`, `false` = unset) for `kind: "env"` fields (never echoes secret values). */
  envStatus?: Record<string, boolean>;
  /** MCP tools exposed by this plugin (automatically surfaced in Settings -> Tools). */
  mcpTools?: PluginToolDescriptorSummary[];
  /** Effective overlay environment represented by this entry (e.g. `"default"`, `"production"`). */
  environment?: string;
  runId?: string | null;
  updatedAt?: string;
  overlayCount: number;
  /** Sum of package-level `issueCount`s. */
  issueCount: number;
  summary?: PluginPresentationSummary;
  packages: PluginPackageSummary[];
  run: PluginRunStatus;
}

/** Fingerprints so the client can revalidate structure and plugins independently. */
export interface PluginFingerprint {
  /** Changes only when the structural graph (or non-plugin overlays) change. */
  structureFp: string;
  /** Changes whenever any plugin's presentation or run state changes. */
  pluginFp: string;
}

export interface PluginsOverview {
  plugins: PluginOverviewEntry[];
  fingerprint: PluginFingerprint;
  /** Requested or active overlay environment (defaults to `"default"`). */
  environment?: string;
  /** Distinct overlay environments present across persisted plugin overlays. */
  availableEnvironments?: string[];
}

export interface EntityPluginPresentation {
  source: string;
  layer: string;
  displayName: string;
  entityId: string;
  environment?: string;
  runId?: string | null;
  updatedAt?: string;
  stale?: boolean;
  presentation: PluginPresentation;
}

// ---------------------------------------------------------------------------
// Limits & sanitizer
// ---------------------------------------------------------------------------

export const PLUGIN_PRESENTATION_LIMITS = {
  sections: 24,
  blocksPerSection: 12,
  itemsPerBlock: 100,
  evidencePerItem: 5,
  columns: 8,
  hudMetrics: 4,
  hudItems: 8,
  spotlightViews: 12,
  spotlightNodesPerView: 100,
  title: 120,
  label: 200,
  detail: 600,
  snippet: 400,
  text: 2000,
} as const;

const TONES = new Set<string>(["neutral", "good", "warn", "bad", "info", "muted"]);
const STATUSES = new Set<string>(["ok", "warn", "error", "unknown", "n/a"]);
const METRIC_UNIT_RE = /^[a-zA-Z0-9%/._-]+$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function tone(v: unknown): PresentationTone | undefined {
  return typeof v === "string" && TONES.has(v) ? (v as PresentationTone) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function evidenceRefs(v: unknown): PresentationEvidenceRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PresentationEvidenceRef[] = [];
  for (const raw of v) {
    if (!isObj(raw)) continue;
    const filePath = str(raw.filePath, 400);
    if (!filePath) continue;
    const lineNumber = num(raw.lineNumber);
    const snippet = str(raw.snippet, PLUGIN_PRESENTATION_LIMITS.snippet);
    const label = str(raw.label, PLUGIN_PRESENTATION_LIMITS.label);
    out.push({
      filePath,
      ...(lineNumber !== undefined ? { lineNumber } : {}),
      ...(snippet ? { snippet } : {}),
      ...(label ? { label } : {}),
    });
    if (out.length >= PLUGIN_PRESENTATION_LIMITS.evidencePerItem) break;
  }
  return out.length > 0 ? out : undefined;
}

function badge(v: unknown): PresentationBadge | undefined {
  if (!isObj(v)) return undefined;
  const text = str(v.text, 60);
  if (!text) return undefined;
  const t = tone(v.tone);
  const tooltip = str(v.tooltip, PLUGIN_PRESENTATION_LIMITS.detail);
  return { text, ...(t ? { tone: t } : {}), ...(tooltip ? { tooltip } : {}) };
}

function sanitizeListItems(rawItems: unknown, cap: number): PresentationListItem[] | undefined {
  if (!Array.isArray(rawItems)) return undefined;
  const items: PresentationListItem[] = [];
  for (const it of rawItems.slice(0, cap)) {
    if (!isObj(it)) continue;
    const label = str(it.label, PLUGIN_PRESENTATION_LIMITS.label);
    if (!label) continue;
    const detail = str(it.detail, PLUGIN_PRESENTATION_LIMITS.detail);
    const t = tone(it.tone);
    const ev = evidenceRefs(it.evidence);
    const entityId = str(it.entityId, 120);
    items.push({
      label,
      ...(detail ? { detail } : {}),
      ...(t ? { tone: t } : {}),
      ...(ev ? { evidence: ev } : {}),
      ...(entityId ? { entityId } : {}),
    });
  }
  return items.length > 0 ? items : undefined;
}

function metric(v: unknown): PresentationMetric | null {
  if (!isObj(v)) return null;
  const id = str(v.id, 80);
  const label = str(v.label, PLUGIN_PRESENTATION_LIMITS.label);
  if (!id || !label) return null;
  let value: string | number | null = null;
  if (typeof v.value === "number" && Number.isFinite(v.value)) value = v.value;
  else if (typeof v.value === "string") value = str(v.value, PLUGIN_PRESENTATION_LIMITS.label) ?? null;
  const rawUnit = typeof v.unit === "string" ? v.unit.trim() : "";
  const unit =
    rawUnit && rawUnit.length <= 16 && METRIC_UNIT_RE.test(rawUnit)
      ? (rawUnit as PresentationMetric["unit"])
      : undefined;
  const t = tone(v.tone);
  const hint = str(v.hint, PLUGIN_PRESENTATION_LIMITS.detail);
  const items = sanitizeListItems(v.items, PLUGIN_PRESENTATION_LIMITS.itemsPerBlock);
  const maxVisible = num(v.maxVisible);
  const totalCount = num(v.totalCount);
  const emptyText = str(v.emptyText, PLUGIN_PRESENTATION_LIMITS.detail);
  return {
    id,
    label,
    value,
    ...(unit ? { unit } : {}),
    ...(t ? { tone: t } : {}),
    ...(hint ? { hint } : {}),
    ...(items ? { items } : {}),
    ...(maxVisible !== undefined ? { maxVisible } : {}),
    ...(totalCount !== undefined ? { totalCount } : {}),
    ...(emptyText ? { emptyText } : {}),
  };
}

function metrics(v: unknown, cap: number): PresentationMetric[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(metric).filter((m): m is PresentationMetric => m !== null).slice(0, cap);
  return out.length > 0 ? out : undefined;
}

function spotlightViews(v: unknown): PluginSpotlightView[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PluginSpotlightView[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!isObj(raw)) continue;
    const id = str(raw.id, 80);
    const title = str(raw.title, PLUGIN_PRESENTATION_LIMITS.title);
    if (!id || !title || seen.has(id)) continue;
    if (!Array.isArray(raw.highlightNodeIds)) continue;
    const highlightNodeIds: string[] = [];
    const seenNodes = new Set<string>();
    for (const rawId of raw.highlightNodeIds) {
      const nid = str(rawId, 240);
      if (nid && !seenNodes.has(nid)) {
        seenNodes.add(nid);
        highlightNodeIds.push(nid);
        if (highlightNodeIds.length >= PLUGIN_PRESENTATION_LIMITS.spotlightNodesPerView) break;
      }
    }
    if (highlightNodeIds.length === 0) continue;
    seen.add(id);
    const description = str(raw.description, PLUGIN_PRESENTATION_LIMITS.detail);
    const b = badge(raw.badge);
    const viewLevel =
      raw.viewLevel === "package" || raw.viewLevel === "system" ? raw.viewLevel : undefined;
    const packageName = str(raw.packageName, 160);
    const layer = str(raw.layer, 80);
    let nodeAnnotations: Record<string, string> | undefined;
    if (isObj(raw.nodeAnnotations)) {
      const next: Record<string, string> = {};
      let count = 0;
      for (const [k, val] of Object.entries(raw.nodeAnnotations)) {
        const key = str(k, 240);
        const note = str(val, PLUGIN_PRESENTATION_LIMITS.detail);
        if (key && note) {
          next[key] = note;
          count++;
          if (count >= PLUGIN_PRESENTATION_LIMITS.spotlightNodesPerView) break;
        }
      }
      if (count > 0) nodeAnnotations = next;
    }
    out.push({
      id,
      title,
      ...(description ? { description } : {}),
      ...(b ? { badge: b } : {}),
      highlightNodeIds,
      ...(viewLevel ? { viewLevel } : {}),
      ...(packageName ? { packageName } : {}),
      ...(nodeAnnotations ? { nodeAnnotations } : {}),
      ...(layer ? { layer } : {}),
    });
    if (out.length >= PLUGIN_PRESENTATION_LIMITS.spotlightViews) break;
  }
  return out.length > 0 ? out : undefined;
}

function cell(v: unknown): string | number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 299)}…` : v;
  return null;
}

function block(raw: unknown, warnings: string[]): PresentationBlock | null {
  if (!isObj(raw) || typeof raw.kind !== "string") return null;
  const cap = PLUGIN_PRESENTATION_LIMITS.itemsPerBlock;
  const title = str(raw.title, PLUGIN_PRESENTATION_LIMITS.title);
  const totalCount = num(raw.totalCount);
  const maxVisible = num(raw.maxVisible);
  const emptyText = str(raw.emptyText, PLUGIN_PRESENTATION_LIMITS.detail);

  switch (raw.kind) {
    case "metrics": {
      const items = metrics(raw.items, cap);
      return items ? { kind: "metrics", items } : null;
    }
    case "keyValue": {
      if (!Array.isArray(raw.items)) return null;
      const items: Extract<PresentationBlock, { kind: "keyValue" }>["items"] = [];
      for (const it of raw.items.slice(0, cap)) {
        if (!isObj(it)) continue;
        const label = str(it.label, PLUGIN_PRESENTATION_LIMITS.label);
        const value =
          typeof it.value === "number" && Number.isFinite(it.value)
            ? it.value
            : str(it.value, PLUGIN_PRESENTATION_LIMITS.detail);
        if (!label || value === undefined) continue;
        const t = tone(it.tone);
        const ev = evidenceRefs(it.evidence);
        items.push({
          label,
          value,
          ...(it.mono === true ? { mono: true } : {}),
          ...(t ? { tone: t } : {}),
          ...(ev ? { evidence: ev } : {}),
        });
      }
      return items.length > 0 ? { kind: "keyValue", items } : null;
    }
    case "text": {
      const text = str(raw.text, PLUGIN_PRESENTATION_LIMITS.text);
      const t = tone(raw.tone);
      return text ? { kind: "text", text, ...(t ? { tone: t } : {}) } : null;
    }
    case "list": {
      if (!Array.isArray(raw.items)) return null;
      const items: PresentationListItem[] = [];
      for (const it of raw.items.slice(0, cap)) {
        if (!isObj(it)) continue;
        const label = str(it.label, PLUGIN_PRESENTATION_LIMITS.label);
        if (!label) continue;
        const detail = str(it.detail, PLUGIN_PRESENTATION_LIMITS.detail);
        const t = tone(it.tone);
        const ev = evidenceRefs(it.evidence);
        const entityId = str(it.entityId, 120);
        items.push({
          label,
          ...(detail ? { detail } : {}),
          ...(t ? { tone: t } : {}),
          ...(ev ? { evidence: ev } : {}),
          ...(entityId ? { entityId } : {}),
        });
      }
      if (items.length === 0 && !emptyText) return null;
      return {
        kind: "list",
        ...(title ? { title } : {}),
        items,
        ...(maxVisible !== undefined ? { maxVisible } : {}),
        ...(totalCount !== undefined ? { totalCount } : {}),
        ...(emptyText ? { emptyText } : {}),
      };
    }
    case "table": {
      if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null;
      const columns: PresentationTableColumn[] = [];
      for (const c of raw.columns.slice(0, PLUGIN_PRESENTATION_LIMITS.columns)) {
        if (!isObj(c)) continue;
        const id = str(c.id, 60);
        const label = str(c.label, 80);
        if (!id || !label) continue;
        columns.push({
          id,
          label,
          ...(c.align === "right" ? { align: "right" as const } : {}),
          ...(c.mono === true ? { mono: true } : {}),
        });
      }
      if (columns.length === 0) return null;
      const rows: PresentationTableRow[] = [];
      for (const r of raw.rows.slice(0, cap)) {
        if (!isObj(r) || !isObj(r.cells)) continue;
        const cells: Record<string, string | number | null> = {};
        for (const col of columns) cells[col.id] = cell((r.cells as Record<string, unknown>)[col.id]);
        const t = tone(r.tone);
        const ev = evidenceRefs(r.evidence);
        const entityId = str(r.entityId, 120);
        rows.push({
          cells,
          ...(t ? { tone: t } : {}),
          ...(ev ? { evidence: ev } : {}),
          ...(entityId ? { entityId } : {}),
        });
      }
      if (rows.length === 0 && !emptyText) return null;
      return {
        kind: "table",
        ...(title ? { title } : {}),
        columns,
        rows,
        ...(maxVisible !== undefined ? { maxVisible } : {}),
        ...(totalCount !== undefined ? { totalCount } : {}),
        ...(emptyText ? { emptyText } : {}),
      };
    }
    case "checks": {
      if (!Array.isArray(raw.items)) return null;
      const items: PresentationCheck[] = [];
      for (const it of raw.items.slice(0, cap)) {
        if (!isObj(it)) continue;
        const label = str(it.label, PLUGIN_PRESENTATION_LIMITS.label);
        if (!label) continue;
        const detail = str(it.detail, PLUGIN_PRESENTATION_LIMITS.detail);
        const ev = evidenceRefs(it.evidence);
        items.push({
          label,
          ok: it.ok === true ? true : it.ok === false ? false : null,
          ...(detail ? { detail } : {}),
          ...(ev ? { evidence: ev } : {}),
        });
      }
      return items.length > 0 ? { kind: "checks", ...(title ? { title } : {}), items } : null;
    }
    case "evidence": {
      if (!Array.isArray(raw.items)) return null;
      const items: PresentationEvidenceRef[] = [];
      for (const it of raw.items.slice(0, cap)) {
        const one = evidenceRefs([it]);
        if (one) items.push(one[0]!);
      }
      if (items.length === 0) return null;
      return {
        kind: "evidence",
        ...(title ? { title } : {}),
        items,
        ...(totalCount !== undefined ? { totalCount } : {}),
      };
    }
    default:
      warnings.push(`unknown block kind "${String(raw.kind)}" dropped`);
      return null;
  }
}

export interface SanitizedPluginPresentation {
  presentation: PluginPresentation | null;
  warnings: string[];
}

/**
 * Validates and bounds untrusted presentation data. Returns `null` presentation (never throws) when
 * the input is not a usable v1 presentation. Unknown block kinds are dropped with a warning so a newer
 * plugin never breaks an older UI.
 */
function sanitizePromptAction(raw: unknown): PluginPromptAction | undefined {
  if (!isObj(raw)) return undefined;
  const label = str(raw.label, 80);
  const text = str(raw.text, PLUGIN_PRESENTATION_LIMITS.text);
  const hint = str(raw.hint, PLUGIN_PRESENTATION_LIMITS.detail);
  if (!label || !text) return undefined;
  return { label, text, ...(hint ? { hint } : {}) };
}

function sanitizeHudItems(rawItems: unknown): PluginHudSummaryItem[] | undefined {
  if (!Array.isArray(rawItems)) return undefined;
  const out: PluginHudSummaryItem[] = [];
  for (const it of rawItems.slice(0, PLUGIN_PRESENTATION_LIMITS.hudItems)) {
    if (!isObj(it)) continue;
    const label = str(it.label, PLUGIN_PRESENTATION_LIMITS.label);
    if (!label) continue;
    const value =
      typeof it.value === "number" && Number.isFinite(it.value)
        ? it.value
        : str(it.value, 60);
    out.push({
      label,
      ...(value !== undefined ? { value } : {}),
      ...(it.mono === true ? { mono: true } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

export function sanitizePluginPresentation(input: unknown): SanitizedPluginPresentation {
  const warnings: string[] = [];
  if (!isObj(input)) return { presentation: null, warnings: ["presentation is not an object"] };
  if (input.version !== PLUGIN_PRESENTATION_VERSION) {
    return {
      presentation: null,
      warnings: [`unsupported presentation version ${String(input.version)}`],
    };
  }

  let summary: PluginPresentationSummary | undefined;
  if (isObj(input.summary)) {
    const s = input.summary;
    const status =
      typeof s.status === "string" && STATUSES.has(s.status) ? (s.status as PresentationStatus) : undefined;
    const b = badge(s.badge);
    const headline = str(s.headline, PLUGIN_PRESENTATION_LIMITS.detail);
    const repoHeadline = str(s.repoHeadline, PLUGIN_PRESENTATION_LIMITS.detail);
    const description = str(s.description, PLUGIN_PRESENTATION_LIMITS.detail);
    const issueCount = num(s.issueCount);
    const ms = metrics(s.metrics, PLUGIN_PRESENTATION_LIMITS.hudMetrics);
    const hudItems = sanitizeHudItems(s.items);
    const vs = spotlightViews(s.views);
    const prompt = sanitizePromptAction(s.prompt);
    const repoPrompt = sanitizePromptAction(s.repoPrompt);
    summary = {
      ...(status ? { status } : {}),
      ...(b ? { badge: b } : {}),
      ...(headline ? { headline } : {}),
      ...(repoHeadline ? { repoHeadline } : {}),
      ...(description ? { description } : {}),
      ...(issueCount !== undefined ? { issueCount: Math.max(0, Math.round(issueCount)) } : {}),
      ...(ms ? { metrics: ms } : {}),
      ...(hudItems ? { items: hudItems } : {}),
      ...(vs ? { views: vs } : {}),
      ...(prompt ? { prompt } : {}),
      ...(repoPrompt ? { repoPrompt } : {}),
      ...(s.hideInHud === true ? { hideInHud: true } : {}),
    };
    if (Object.keys(summary).length === 0) summary = undefined;
  }

  const sections: PresentationSection[] = [];
  const seenIds = new Set<string>();
  const rawSections = Array.isArray(input.sections) ? input.sections : [];
  for (const raw of rawSections.slice(0, PLUGIN_PRESENTATION_LIMITS.sections)) {
    if (!isObj(raw)) continue;
    let id = str(raw.id, 80);
    const title = str(raw.title, PLUGIN_PRESENTATION_LIMITS.title);
    if (!id || !title) {
      warnings.push("section without id/title dropped");
      continue;
    }
    if (seenIds.has(id)) {
      let n = 2;
      while (seenIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
      warnings.push(`duplicate section id renamed to ${id}`);
    }
    seenIds.add(id);
    const blocks: PresentationBlock[] = [];
    const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : [];
    for (const rb of rawBlocks.slice(0, PLUGIN_PRESENTATION_LIMITS.blocksPerSection)) {
      const b = block(rb, warnings);
      if (b) blocks.push(b);
    }
    const tooltip = str(raw.tooltip, PLUGIN_PRESENTATION_LIMITS.detail);
    const sb = badge(raw.badge);
    const priority = num(raw.priority);
    sections.push({
      id,
      title,
      ...(tooltip ? { tooltip } : {}),
      ...(sb ? { badge: sb } : {}),
      ...(raw.defaultOpen === false ? { defaultOpen: false } : {}),
      ...(priority !== undefined ? { priority } : {}),
      blocks,
    });
  }
  sections.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  if (!summary && sections.length === 0) {
    return { presentation: null, warnings: [...warnings, "presentation has no summary and no sections"] };
  }
  const generatedAt = str(input.generatedAt, 40);
  return {
    presentation: {
      version: PLUGIN_PRESENTATION_VERSION,
      ...(summary ? { summary } : {}),
      sections,
      ...(generatedAt ? { generatedAt } : {}),
    },
    warnings,
  };
}

/** Reads and sanitizes `payload.presentation` from an overlay payload. */
export function readPresentationFromPayload(payload: unknown): PluginPresentation | null {
  if (!isObj(payload)) return null;
  const raw = payload[PLUGIN_PRESENTATION_PAYLOAD_KEY];
  if (raw === undefined) return null;
  return sanitizePluginPresentation(raw).presentation;
}

/** True when an overlay payload carries a presentation (cheap check; does not validate). */
export function payloadHasPresentation(payload: unknown): boolean {
  return isObj(payload) && isObj(payload[PLUGIN_PRESENTATION_PAYLOAD_KEY]);
}

/**
 * Structural payload form: the heavy `presentation` is removed and `presentationAvailable: true` is set,
 * so layout/rules that read other payload fields keep working while the presentation loads separately.
 */
export function deferPresentationInPayload<T extends Record<string, unknown>>(payload: T): T {
  if (!payloadHasPresentation(payload)) return payload;
  const { [PLUGIN_PRESENTATION_PAYLOAD_KEY]: _omit, ...rest } = payload;
  return { ...rest, [PLUGIN_PRESENTATION_AVAILABLE_KEY]: true } as unknown as T;
}

/** Caps a list and reports the pre-truncation total (honest "showing N of M"). */
export function capForPresentation<T>(items: readonly T[], max: number): { items: T[]; totalCount: number } {
  return { items: items.slice(0, max), totalCount: items.length };
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_VALUE_PREFIX_RE = /^(?:(?:sk|pk|rk|kpat|ghp|gho|github_pat|glpat|xox[baprs])[_-]|eyJ[A-Za-z0-9_-]{8,})/i;

/**
 * Validates that a string is a clean environment-variable identifier (or empty string)
 * and never a pasted raw API key / JWT token.
 */
export function isValidEnvVarName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  if (!ENV_VAR_NAME_RE.test(trimmed)) return false;
  if (SECRET_VALUE_PREFIX_RE.test(trimmed)) return false;
  return true;
}

/**
 * Resolves raw user settings against a plugin's `settingsSchema`, coercing valid values,
 * clamping numbers to `[min, max]`, validating `select` options, guarding `env` fields against
 * raw secret values, and filling defaults.
 */
export function resolvePluginSettings(
  schema: readonly PluginSettingField[] | undefined,
  raw: unknown,
): Record<string, PluginSettingValue> {
  const out: Record<string, PluginSettingValue> = {};
  if (!schema || schema.length === 0) return out;
  const src = isObj(raw) ? raw : {};
  for (const field of schema) {
    const candidate = src[field.key];
    if (field.kind === "boolean") {
      out[field.key] = typeof candidate === "boolean" ? candidate : field.defaultValue;
    } else if (field.kind === "number") {
      let val =
        typeof candidate === "number" && Number.isFinite(candidate)
          ? candidate
          : typeof candidate === "string" && candidate.trim() !== "" && Number.isFinite(Number(candidate))
            ? Number(candidate)
            : field.defaultValue;
      if (field.min !== undefined && val < field.min) val = field.min;
      if (field.max !== undefined && val > field.max) val = field.max;
      out[field.key] = val;
    } else if (field.kind === "select") {
      const validValues = new Set(field.options.map((o) => o.value));
      out[field.key] =
        typeof candidate === "string" && validValues.has(candidate) ? candidate : field.defaultValue;
    } else if (field.kind === "env") {
      out[field.key] = isValidEnvVarName(candidate)
        ? candidate.trim()
        : isValidEnvVarName(field.defaultValue)
          ? field.defaultValue.trim()
          : "";
    } else {
      out[field.key] = typeof candidate === "string" ? candidate : field.defaultValue;
    }
  }
  return out;
}
