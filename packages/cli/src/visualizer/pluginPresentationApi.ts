/**
 * packages/cli/src/visualizer/pluginPresentationApi.ts
 *
 * Server-side model for the Plugin Presentation Contract ([PAT-VIS-36]). Pure functions (no Express, no DB)
 * so they are unit-testable:
 *
 *   - `splitOverlays`            – the heavy `payload.presentation` is deferred out of the structural
 *                                  `/api/layout` & `/api/graph` payloads (other payload fields stay, because
 *                                  custom rules and node badges may read them).
 *   - `computeStructureFingerprint` / `computePluginFingerprint`
 *                                – independent fingerprints so the client re-lays-out only when the structure
 *                                  changes and re-fetches plugin data when only plugins changed.
 *   - `buildPluginsOverview`     – HUD cards (`GET /api/plugins`).
 *   - `buildEntityPresentations` – inspector sections for one entity (`GET /api/plugins/presentation`).
 *   - `startPluginRun` & co.     – in-memory run state for UI-triggered plugin runs.
 */

import { createHash } from "node:crypto";
import {
  deferPresentationInPayload,
  payloadHasPresentation,
  readPresentationFromPayload,
  type EntityPluginPresentation,
  type PluginHudSummaryItem,
  type PluginInspectorScope,
  type PluginOverviewEntry,
  type PluginPackageSummary,
  type PluginPresentationSummary,
  type PluginRunStatus,
  type PluginSettingField,
  type PluginSettingValue,
  type PluginToolDescriptorSummary,
  type PluginsOverview,
  type PresentationStatus,
} from "@chomp/core";
import type { EntityOverlayItem } from "./types.js";

export interface PluginMeta {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  order?: number;
  layer?: string;
  defaultEnabled?: boolean;
  inspectorScopes?: PluginInspectorScope[];
  stateDir?: string;
  settingsSchema?: PluginSettingField[];
  settings?: Record<string, PluginSettingValue>;
  envStatus?: Record<string, boolean>;
  mcpTools?: PluginToolDescriptorSummary[];
  lastRun?: {
    status: "ok" | "error";
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    overlayCount?: number;
    presentationWarnings?: string[];
    error?: string;
  };
}

interface GraphNodeLike {
  id: string;
  name: string;
  entityType?: string;
  metadata?: Record<string, unknown> | null;
}

interface GraphEdgeLike {
  id?: string;
  targetId?: string | null;
  status?: string;
}

export function isPluginOverlay(ov: EntityOverlayItem): boolean {
  return payloadHasPresentation(ov.payload);
}

/**
 * `layout`: every overlay in structural form (presentation deferred, `presentationAvailable` marker set).
 * `plugin`: the overlays that carry a presentation, in full, for `/api/plugins/*`.
 */
export function splitOverlays(overlays: EntityOverlayItem[]): {
  layout: EntityOverlayItem[];
  plugin: EntityOverlayItem[];
} {
  const layout: EntityOverlayItem[] = [];
  const plugin: EntityOverlayItem[] = [];
  for (const ov of overlays) {
    if (isPluginOverlay(ov)) {
      plugin.push(ov);
      layout.push({ ...ov, payload: deferPresentationInPayload(ov.payload) });
    } else {
      layout.push(ov);
    }
  }
  return { layout, plugin };
}

interface RuleLike {
  match?: { overlayLayer?: unknown; overlaySource?: unknown; overlayField?: unknown };
}

/** Do the user's custom rules read overlay data? If so, plugin writes can legitimately change the layout. */
export function rulesReferenceOverlays(customRules: RuleLike[] | undefined): boolean {
  return (customRules ?? []).some(
    (r) => Boolean(r.match?.overlayLayer || r.match?.overlaySource || r.match?.overlayField)
  );
}

function isStructuralShimOverlay(ov: EntityOverlayItem): boolean {
  if (ov.layer !== "L1_SHIMS") return false;
  const p = ov.payload as Record<string, unknown> | undefined;
  return Boolean(
    p &&
      ((Array.isArray(p.shimmedEdges) && p.shimmedEdges.length > 0) ||
        (Array.isArray(p.syntheticConnectors) && p.syntheticConnectors.length > 0))
  );
}

/**
 * Overlays that participate in the structure fingerprint: all non-plugin overlays, `L1_SHIMS`
 * overlays that project edges/connectors onto the story graph, plus other plugin overlays
 * (in structural form) only when rules reference overlays. Otherwise presentation-only plugin runs
 * never force a re-layout.
 */
export function overlaysForStructureFingerprint(
  split: { layout: EntityOverlayItem[]; plugin: EntityOverlayItem[] },
  rulesUseOverlays: boolean,
  isStructuralOverlay: (ov: EntityOverlayItem) => boolean = isStructuralShimOverlay
): EntityOverlayItem[] {
  if (rulesUseOverlays) return split.layout;
  const pluginKeys = new Set(split.plugin.map((o) => `${o.entityId}\u0000${o.layer}\u0000${o.source}\u0000${o.environment}`));
  return split.layout.filter(
    (o) =>
      isStructuralOverlay(o) ||
      !pluginKeys.has(`${o.entityId}\u0000${o.layer}\u0000${o.source}\u0000${o.environment}`)
  );
}

function sha(parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * Content-based: unchanged when a re-analysis produces the same structure, and unaffected by
 * plugin overlay writes.
 */
export function computeStructureFingerprint(
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
  structuralOverlays: EntityOverlayItem[]
): string {
  const h = createHash("sha1");
  for (const n of nodes) h.update(`${n.id}:${String(n.metadata?.bodyHash ?? "")};`);
  h.update("|");
  for (const e of edges) h.update(`${e.id ?? ""}>${e.targetId ?? ""}:${e.status ?? ""};`);
  h.update("|");
  for (const o of structuralOverlays) {
    h.update(`${o.entityId}:${o.layer}:${o.source}:${o.environment}:${o.runId ?? ""}:${o.updatedAt ?? ""}:${JSON.stringify(o.payload ?? {}).length};`);
  }
  return h.digest("hex").slice(0, 16);
}

export function computePluginFingerprint(
  pluginOverlays: EntityOverlayItem[],
  runs: Record<string, PluginRunStatus>,
  registry?: PluginMeta[]
): string {
  return sha([
    pluginOverlays
      .map((o) => [o.entityId, o.layer, o.source, o.environment, o.runId ?? "", o.updatedAt ?? "", o.stale ?? false])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2]))),
    Object.entries(runs)
      .map(([k, v]) => [k, v.state, v.startedAt ?? "", v.finishedAt ?? "", v.error ?? ""])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ...(registry
      ? [
          registry
            .map((m) => [
              m.name,
              m.order ?? null,
              m.settings ?? {},
              m.envStatus ?? {},
              m.lastRun?.finishedAt ?? "",
              m.lastRun?.status ?? "",
              m.lastRun?.error ?? "",
              m.lastRun?.presentationWarnings ?? [],
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ]
      : []),
  ]);
}

function humanize(layer: string): string {
  const cleaned = layer.replace(/^PLUGIN:/i, "").replace(/^L\d+_/, "").replace(/[_-]+/g, " ").trim().toLowerCase();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : layer;
}

const STATUS_RANK: Record<PresentationStatus, number> = { error: 4, warn: 3, unknown: 2, "n/a": 1, ok: 0 };

function worstStatus(summaries: PluginPresentationSummary[]): PresentationStatus | undefined {
  let worst: PresentationStatus | undefined;
  for (const s of summaries) {
    if (!s.status) continue;
    if (worst === undefined || STATUS_RANK[s.status] > STATUS_RANK[worst]) worst = s.status;
  }
  return worst;
}

function packageLabelOf(node: GraphNodeLike): { label: string; key: string } {
  const label = node.name.replace(/^Deployment Unit:\s*/i, "").trim();
  return { label, key: label.replace(/^@[^/]+\//, "") };
}

function normalizeOverlayEnv(env: string | undefined): string {
  const clean = (env ?? "").trim();
  return clean || "default";
}

export function collectAvailableOverlayEnvironments(pluginOverlays: EntityOverlayItem[]): string[] {
  const envs = new Set<string>();
  for (const ov of pluginOverlays) {
    envs.add(normalizeOverlayEnv(ov.environment));
  }
  const rank = (e: string) => (e === "default" ? 0 : e === "production" ? 1 : 2);
  return [...envs].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function selectEffectiveEnvironment(overlays: EntityOverlayItem[], requestedEnv: string): string {
  const envs = new Set<string>(overlays.map((o) => normalizeOverlayEnv(o.environment)));
  if (envs.has(requestedEnv)) return requestedEnv;
  if (envs.has("default")) return "default";
  if (requestedEnv === "default" && envs.has("production")) return "production";
  return [...envs].sort((a, b) => a.localeCompare(b))[0] ?? requestedEnv;
}

export function buildPluginsOverview(params: {
  pluginOverlays: EntityOverlayItem[];
  nodes: GraphNodeLike[];
  registry: PluginMeta[];
  runs: Record<string, PluginRunStatus>;
  structureFp: string;
  environment?: string;
}): PluginsOverview {
  const { pluginOverlays, nodes, registry, runs, structureFp } = params;
  const requestedEnv = normalizeOverlayEnv(params.environment);
  const availableEnvironments = collectAvailableOverlayEnvironments(pluginOverlays);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const metaBySource = new Map(registry.map((m) => [m.name, m]));

  const groups = new Map<string, EntityOverlayItem[]>();
  for (const ov of pluginOverlays) {
    const key = `${ov.source}\u0000${ov.layer}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(ov);
  }

  const entries: PluginOverviewEntry[] = [];
  for (const [key, rawGroup] of groups) {
    const [source, layer] = key.split("\u0000") as [string, string];
    const effectiveEnv = selectEffectiveEnvironment(rawGroup, requestedEnv);
    const overlays = rawGroup.filter((o) => normalizeOverlayEnv(o.environment) === effectiveEnv);
    const meta = metaBySource.get(source);
    const packages: PluginPackageSummary[] = [];
    for (const ov of overlays) {
      const node = nodeById.get(ov.entityId);
      if (!node || node.entityType !== "DEPLOYMENT_UNIT") continue;
      const p = readPresentationFromPayload(ov.payload);
      if (!p?.summary) continue;
      const { label, key: pkgKey } = packageLabelOf(node);
      packages.push({ entityId: ov.entityId, label, key: pkgKey, summary: p.summary });
    }
    packages.sort((a, b) => a.label.localeCompare(b.label));

    const summaries = packages.map((p) => p.summary);
    const issueCount = summaries.reduce((n, s) => n + (s.issueCount ?? 0), 0);
    const firstPrompt = summaries.find((s) => s.prompt)?.prompt;
    const repoPrompt = summaries.find((s) => s.repoPrompt)?.repoPrompt ?? firstPrompt;
    const summaryDescription = summaries.find((s) => s.description)?.description;
    const explicitRepoHeadline = summaries.find((s) => s.repoHeadline)?.repoHeadline;
    let summary: PluginPresentationSummary | undefined;
    if (packages.length === 1) {
      summary = packages[0]!.summary;
    } else if (packages.length > 1) {
      const status = worstStatus(summaries);
      const mergedViews = packages.flatMap((pkg) =>
        (pkg.summary.views ?? []).map((v) => ({
          ...v,
          id: `${pkg.key}:${v.id}`,
          title: `${pkg.label} · ${v.title}`,
        }))
      );
      const aggregatedItemsMap = new Map<
        string,
        { label: string; numTotal: number; hasNum: boolean; strVal?: string; mono?: boolean }
      >();
      for (const s of summaries) {
        for (const item of s.items ?? []) {
          const existing = aggregatedItemsMap.get(item.label);
          if (!existing) {
            aggregatedItemsMap.set(item.label, {
              label: item.label,
              numTotal: typeof item.value === "number" ? item.value : 0,
              hasNum: typeof item.value === "number",
              strVal: typeof item.value === "string" ? item.value : undefined,
              mono: item.mono,
            });
          } else {
            if (typeof item.value === "number") {
              existing.numTotal += item.value;
              existing.hasNum = true;
            } else if (typeof item.value === "string" && !existing.strVal) {
              existing.strVal = item.value;
            }
            if (item.mono) existing.mono = true;
          }
        }
      }
      const mergedItems: PluginHudSummaryItem[] = [...aggregatedItemsMap.values()]
        .sort((a, b) => (b.hasNum ? b.numTotal : -1) - (a.hasNum ? a.numTotal : -1) || a.label.localeCompare(b.label))
        .slice(0, 6)
        .map((it) => ({
          label: it.label,
          ...(it.hasNum ? { value: it.numTotal } : it.strVal !== undefined ? { value: it.strVal } : {}),
          ...(it.mono ? { mono: true } : {}),
        }));
      const allUnknown =
        summaries.length > 0 && summaries.every((s) => s.status === "unknown");
      const badge: PluginPresentationSummary["badge"] =
        allUnknown && summaries[0]?.badge
          ? summaries[0]!.badge
          : {
              text: `${packages.length} packages`,
              tone: status === "ok" ? "good" : status === "warn" ? "warn" : "neutral",
            };
      const headline =
        explicitRepoHeadline ??
        (issueCount > 0
          ? `${issueCount} open finding(s) across ${packages.length} package(s)`
          : allUnknown
            ? (summaries[0]?.headline ?? `Un-enriched across ${packages.length} package(s)`)
            : mergedViews.length > 0
              ? `${mergedViews.length} lens(es) across ${packages.length} package(s)`
              : `Active across ${packages.length} package(s)`);
      summary = {
        ...(status ? { status } : {}),
        badge,
        issueCount,
        headline,
        ...(summaryDescription ? { description: summaryDescription } : {}),
        ...(mergedItems.length > 0 ? { items: mergedItems } : {}),
        ...(mergedViews.length > 0 ? { views: mergedViews } : {}),
        ...(repoPrompt ? { prompt: repoPrompt } : {}),
        ...(summaries.length > 0 && summaries.every((s) => s.hideInHud === true)
          ? { hideInHud: true }
          : {}),
      };
    }
    const updatedAt = overlays
      .map((o) => o.updatedAt)
      .filter((u): u is string => Boolean(u))
      .sort()
      .pop();
    const runId = overlays.find((o) => o.runId)?.runId ?? null;
    entries.push({
      source,
      layer,
      displayName: meta?.displayName ?? (meta ? humanize(meta.name) : humanize(layer)),
      ...(meta?.description ? { description: meta.description } : {}),
      ...(meta?.version ? { version: meta.version } : {}),
      ...(meta?.order !== undefined ? { order: meta.order } : {}),
      ...(meta?.defaultEnabled !== undefined ? { defaultEnabled: meta.defaultEnabled } : {}),
      ...(meta?.stateDir ? { stateDir: meta.stateDir } : {}),
      ...(meta?.settingsSchema ? { settingsSchema: meta.settingsSchema } : {}),
      ...(meta?.settings ? { settings: meta.settings } : {}),
      ...(meta?.envStatus ? { envStatus: meta.envStatus } : {}),
      ...(meta?.mcpTools ? { mcpTools: meta.mcpTools } : {}),
      environment: effectiveEnv,
      runId,
      ...(updatedAt ? { updatedAt } : {}),
      overlayCount: overlays.length,
      issueCount,
      ...(summary ? { summary } : {}),
      packages,
      run: runs[source] ?? { state: "idle" },
      ...(meta?.lastRun ? ({ lastRun: meta.lastRun } as Record<string, unknown>) : {}),
    });
  }

  // Registered plugins that have not produced presentation data yet still get a card (so they can be run).
  for (const meta of registry) {
    if (entries.some((e) => e.source === meta.name)) continue;
    entries.push({
      source: meta.name,
      layer: meta.layer ?? meta.name,
      displayName: meta.displayName ?? humanize(meta.name),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.version ? { version: meta.version } : {}),
      ...(meta.order !== undefined ? { order: meta.order } : {}),
      ...(meta.defaultEnabled !== undefined ? { defaultEnabled: meta.defaultEnabled } : {}),
      ...(meta.stateDir ? { stateDir: meta.stateDir } : {}),
      ...(meta.settingsSchema ? { settingsSchema: meta.settingsSchema } : {}),
      ...(meta.settings ? { settings: meta.settings } : {}),
      ...(meta.envStatus ? { envStatus: meta.envStatus } : {}),
      ...(meta.mcpTools ? { mcpTools: meta.mcpTools } : {}),
      environment: requestedEnv,
      runId: null,
      overlayCount: 0,
      issueCount: 0,
      ...(meta.description
        ? {
            summary: {
              status: "unknown",
              headline: "Not analyzed yet",
              description: meta.description,
            },
          }
        : {}),
      packages: [],
      run: runs[meta.name] ?? { state: "idle" },
      ...(meta.lastRun ? ({ lastRun: meta.lastRun } as Record<string, unknown>) : {}),
    });
  }

  entries.sort(
    (a, b) =>
      (a.order ?? 100) - (b.order ?? 100) ||
      a.displayName.localeCompare(b.displayName)
  );
  return {
    plugins: entries,
    fingerprint: { structureFp, pluginFp: computePluginFingerprint(pluginOverlays, runs, registry) },
    environment: requestedEnv,
    ...(availableEnvironments.length > 0 ? { availableEnvironments } : {}),
  };
}

export function buildEntityPresentations(params: {
  pluginOverlays: EntityOverlayItem[];
  entityId: string;
  registry: PluginMeta[];
  nodes?: GraphNodeLike[];
  environment?: string;
}): EntityPluginPresentation[] {
  const { pluginOverlays, entityId, registry, nodes } = params;
  const requestedEnv = normalizeOverlayEnv(params.environment);
  const metaBySource = new Map(registry.map((m) => [m.name, m]));
  const entityNode = nodes?.find((n) => n.id === entityId);
  const entityScope: PluginInspectorScope | undefined = nodes
    ? entityNode?.entityType === "DEPLOYMENT_UNIT"
      ? "package"
      : "node"
    : undefined;
  const entityGroups = new Map<string, EntityOverlayItem[]>();
  for (const ov of pluginOverlays) {
    if (ov.entityId !== entityId) continue;
    const meta = metaBySource.get(ov.source);
    if (entityScope && meta?.inspectorScopes && !meta.inspectorScopes.includes(entityScope)) {
      continue;
    }
    const key = `${ov.source}\u0000${ov.layer}`;
    let list = entityGroups.get(key);
    if (!list) {
      list = [];
      entityGroups.set(key, list);
    }
    list.push(ov);
  }

  const out: EntityPluginPresentation[] = [];
  for (const [, rawGroup] of entityGroups) {
    const effectiveEnv = selectEffectiveEnvironment(rawGroup, requestedEnv);
    const matching = rawGroup.filter((o) => normalizeOverlayEnv(o.environment) === effectiveEnv);
    for (const ov of matching) {
      const presentation = readPresentationFromPayload(ov.payload);
      if (!presentation) continue;
      const meta = metaBySource.get(ov.source);
      out.push({
        source: ov.source,
        layer: ov.layer,
        displayName: meta?.displayName ?? (meta ? humanize(meta.name) : humanize(ov.layer)),
        entityId,
        environment: effectiveEnv,
        runId: ov.runId ?? null,
        ...(ov.updatedAt ? { updatedAt: ov.updatedAt } : {}),
        ...(ov.stale ? { stale: true } : {}),
        presentation,
      });
    }
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.layer.localeCompare(b.layer));
  return out;
}

/** In-memory run state for UI-triggered plugin runs (analyze-triggered runs are visible via the fingerprint). */
export type PluginRunMap = Map<string, PluginRunStatus>;

const nowIso = () => new Date().toISOString();

export function getPluginRun(runs: PluginRunMap, name: string): PluginRunStatus {
  return runs.get(name) ?? { state: "idle" };
}

export function snapshotPluginRuns(runs: PluginRunMap): Record<string, PluginRunStatus> {
  return Object.fromEntries(runs);
}

export function isPluginRunning(runs: PluginRunMap, name: string): boolean {
  return getPluginRun(runs, name).state === "running";
}

export function startPluginRun(runs: PluginRunMap, name: string, now: () => string = nowIso): PluginRunStatus {
  const status: PluginRunStatus = { state: "running", startedAt: now() };
  runs.set(name, status);
  return status;
}

export function finishPluginRun(runs: PluginRunMap, name: string, now: () => string = nowIso): PluginRunStatus {
  const prev = getPluginRun(runs, name);
  const status: PluginRunStatus = {
    state: "idle",
    ...(prev.startedAt ? { startedAt: prev.startedAt } : {}),
    finishedAt: now(),
  };
  runs.set(name, status);
  return status;
}

export function failPluginRun(
  runs: PluginRunMap,
  name: string,
  error: string,
  now: () => string = nowIso
): PluginRunStatus {
  const prev = getPluginRun(runs, name);
  const status: PluginRunStatus = {
    state: "error",
    ...(prev.startedAt ? { startedAt: prev.startedAt } : {}),
    finishedAt: now(),
    error: error.slice(0, 500),
  };
  runs.set(name, status);
  return status;
}
