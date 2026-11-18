/**
 * packages/mcp/src/designSystem/valueClusters.ts
 *
 * Bottom-up derivation: collects hardcoded color and length literals from every scanned
 * surface (CSS rules, TS/TSX, inline styles, arbitrary Tailwind) and clusters near-identical
 * values (`#333333`, `#323232`, `#343434`) into candidate tokens, matching each cluster to an
 * existing token when one is perceptually close. Fully deterministic; no naming conventions
 * are assumed.
 */

import {
  describeColor,
  oklabDistance,
  parseCssColorString,
  rgbaToHex,
  toOklab,
  type OklabColor,
  type RgbaColor,
} from "./color.js";
import type { DesignSystemConfig } from "./config.js";

export type LiteralKind = "color" | "length";
export type LiteralSurface =
  | "css-rule"
  | "string-literal"
  | "jsx-prop"
  | "inline-style"
  | "tailwind-arbitrary"
  | "canvas";

export interface LiteralValueOccurrence {
  kind: LiteralKind;
  /** Raw source text, e.g. `#333`, `rgba(0,0,0,.5)`, `12px`. */
  value: string;
  surface: LiteralSurface;
  /** CSS property / JSX prop / Tailwind class that carries the value, when known. */
  context?: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
}

export type LengthCategory = "space" | "type" | "radius" | "shadow";

export interface DerivedTokenProposal {
  kind: LiteralKind;
  /** For lengths: which kind of scale the cluster belongs to (tokens only match within a category). */
  category?: LengthCategory;
  /** Most frequent member; used as the cluster's representative value. */
  representative: string;
  members: Array<{ value: string; count: number }>;
  occurrenceCount: number;
  distinctFileCount: number;
  surfaces: LiteralSurface[];
  /** Existing token that already covers this cluster. */
  existingTokenMatch?: {
    name: string;
    value: string;
    match: "exact" | "near";
    distance: number;
  };
  /** Generic descriptive name (hue family + lightness step); *a human must rename it*. */
  suggestedTokenName?: string;
  recommendation: string;
  evidence: Array<{ filePath: string; lineNumber: number; snippet: string }>;
}

export interface ResolvedTokenValue {
  name: string;
  /** Raw resolved value text (a color or a length). */
  value: string;
}

interface ParsedLength {
  px: number;
}

export function parseCssLengthToPx(raw: string): ParsedLength | null {
  const m = raw.trim().toLowerCase().match(/^(-?\d*\.?\d+)(px|rem|em)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return { px: m[2] === "px" ? n : n * 16 };
}

const COLOR_LITERAL_SCAN_RE =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|(?:rgba?|hsla?|oklch|oklab)\(\s*[^()]+\)/g;
const LENGTH_LITERAL_SCAN_RE = /(?<![\w.#-])-?\d*\.?\d+(?:px|rem|em)\b/g;

/** Removes `var(...)` expressions (including fallbacks) so only literal values remain. */
export function stripVarExpressions(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value.startsWith("var(", i)) {
      let depth = 0;
      let j = i + 3;
      for (; j < value.length; j++) {
        if (value[j] === "(") depth++;
        else if (value[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      out += " ";
      i = j + 1;
    } else {
      out += value[i];
      i++;
    }
  }
  return out;
}

export function extractColorLiterals(value: string): string[] {
  return [...stripVarExpressions(value).matchAll(COLOR_LITERAL_SCAN_RE)]
    .map((m) => m[0])
    .filter((c) => parseCssColorString(c) !== null);
}

export function extractLengthLiterals(value: string): string[] {
  return [...stripVarExpressions(value).matchAll(LENGTH_LITERAL_SCAN_RE)]
    .map((m) => m[0])
    .filter((l) => {
      const px = parseCssLengthToPx(l)?.px;
      return px !== undefined && px !== 0;
    });
}

/** CSS properties whose length literals are design decisions (spacing, size, radius, type). */
const LENGTH_SENSITIVE_PROP_RE =
  /^(?:margin|padding|gap|row-gap|column-gap|top|right|bottom|left|inset|width|height|min-width|min-height|max-width|max-height|border-radius|font-size|letter-spacing|line-height|box-shadow|text-indent)(?:-[a-z-]+)?$/;

export function isLengthSensitiveProperty(prop: string): boolean {
  return LENGTH_SENSITIVE_PROP_RE.test(prop.toLowerCase());
}

/** Extracts the bracket payload of a Tailwind arbitrary class, e.g. `text-[10px]` → `10px`. */
export function arbitraryTailwindValue(className: string): string | null {
  const m = className.match(/-\[([^\]]+)\]$/);
  return m ? m[1].replace(/_/g, " ") : null;
}

/** Category of a length literal, from the CSS property / Tailwind class carrying it. */
export function lengthCategoryOfContext(context: string | undefined): LengthCategory {
  const c = (context ?? "").toLowerCase();
  if (/font-?size|^text-|letter|tracking|leading|line-?height/.test(c)) return "type";
  if (/radius|^rounded/.test(c)) return "radius";
  if (/shadow/.test(c)) return "shadow";
  return "space";
}

/** Category of an existing token from its name; `null` when the name does not say. */
export function lengthCategoryOfTokenName(name: string): LengthCategory | null {
  const n = name.toLowerCase();
  if (/font|text|type|leading|tracking|line-?height/.test(n)) return "type";
  if (/radius|round/.test(n)) return "radius";
  if (/shadow/.test(n)) return "shadow";
  if (/space|spacing|gap|size|width|height|pad|margin|inset|gutter/.test(n)) return "space";
  return null;
}

interface ColorEntry {
  raw: string;
  rgba: RgbaColor;
  lab: OklabColor;
  count: number;
  occs: LiteralValueOccurrence[];
}

function colorDistance(a: ColorEntry, b: { lab: OklabColor; rgba: RgbaColor }): number {
  return oklabDistance(a.lab, b.lab) + Math.abs(a.rgba.a - b.rgba.a) * 0.5;
}

function pushEvidence(
  target: DerivedTokenProposal["evidence"],
  occ: LiteralValueOccurrence
): void {
  if (target.length >= 5) return;
  if (target.some((e) => e.filePath === occ.filePath && e.lineNumber === occ.lineNumber)) return;
  target.push({ filePath: occ.filePath, lineNumber: occ.lineNumber, snippet: occ.snippet });
}

export function clusterLiteralValues(
  occurrences: LiteralValueOccurrence[],
  tokenValues: ResolvedTokenValue[],
  clustering: DesignSystemConfig["clustering"]
): DerivedTokenProposal[] {
  const proposals: DerivedTokenProposal[] = [];

  // ----- Colors -----
  const colorByRaw = new Map<string, ColorEntry>();
  for (const occ of occurrences) {
    if (occ.kind !== "color") continue;
    const key = occ.value.trim().toLowerCase();
    let entry = colorByRaw.get(key);
    if (!entry) {
      const rgba = parseCssColorString(key);
      if (!rgba) continue;
      entry = { raw: occ.value.trim(), rgba, lab: toOklab(rgba), count: 0, occs: [] };
      colorByRaw.set(key, entry);
    }
    entry.count++;
    entry.occs.push(occ);
  }

  const tokenColors = tokenValues
    .map((t) => {
      const rgba = parseCssColorString(t.value);
      return rgba ? { name: t.name, value: t.value, rgba, lab: toOklab(rgba) } : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const sortedColors = [...colorByRaw.values()].sort(
    (a, b) => b.count - a.count || a.raw.localeCompare(b.raw)
  );
  const colorClusters: Array<{ rep: ColorEntry; members: ColorEntry[] }> = [];
  for (const entry of sortedColors) {
    const home = colorClusters.find(
      (c) => colorDistance(entry, c.rep) <= clustering.colorThreshold
    );
    if (home) home.members.push(entry);
    else colorClusters.push({ rep: entry, members: [entry] });
  }

  for (const cluster of colorClusters) {
    const occurrenceCount = cluster.members.reduce((n, m) => n + m.count, 0);
    let best: { name: string; value: string; d: number } | undefined;
    for (const t of tokenColors) {
      const d = colorDistance(cluster.rep, t);
      if (!best || d < best.d) best = { name: t.name, value: t.value, d };
    }
    const hasTokenMatch = best !== undefined && best.d <= clustering.tokenMatchThreshold;
    if (!hasTokenMatch && occurrenceCount < clustering.minOccurrences) continue;

    const evidence: DerivedTokenProposal["evidence"] = [];
    const files = new Set<string>();
    const surfaces = new Set<LiteralSurface>();
    for (const m of cluster.members) {
      for (const o of m.occs) {
        files.add(o.filePath);
        surfaces.add(o.surface);
        pushEvidence(evidence, o);
      }
    }
    const desc = describeColor(cluster.rep.rgba);
    const distinctValues = cluster.members.length;
    proposals.push({
      kind: "color",
      representative: cluster.rep.raw,
      members: cluster.members.map((m) => ({ value: m.raw, count: m.count })),
      occurrenceCount,
      distinctFileCount: files.size,
      surfaces: [...surfaces].sort(),
      ...(hasTokenMatch && best
        ? {
            existingTokenMatch: {
              name: best.name,
              value: best.value,
              match: best.d <= 0.008 ? ("exact" as const) : ("near" as const),
              distance: Math.round(best.d * 1000) / 1000,
            },
          }
        : {}),
      suggestedTokenName: `--color-${desc.family}-${desc.step}`,
      recommendation:
        hasTokenMatch && best
          ? `Replace ${occurrenceCount} hardcoded color occurrence(s) (${distinctValues} distinct value(s)) with existing token ${best.name}.`
          : `Introduce one semantic token (suggested descriptor ${`--color-${desc.family}-${desc.step}`}; rename by role) covering ${distinctValues} near-identical value(s) across ${files.size} file(s) (${occurrenceCount} occurrences).`,
      evidence,
    });
  }

  // ----- Lengths (clustered per category so a padding value never matches a font-size token) -----
  for (const category of ["space", "type", "radius", "shadow"] as const) {
  const lengthByPx = new Map<number, { count: number; raws: Map<string, number>; occs: LiteralValueOccurrence[] }>();
  for (const occ of occurrences) {
    if (occ.kind !== "length" || lengthCategoryOfContext(occ.context) !== category) continue;
    const px = parseCssLengthToPx(occ.value)?.px;
    if (px === undefined || px === 0) continue;
    const key = Math.round(px * 100) / 100;
    let e = lengthByPx.get(key);
    if (!e) {
      e = { count: 0, raws: new Map(), occs: [] };
      lengthByPx.set(key, e);
    }
    e.count++;
    e.raws.set(occ.value.trim(), (e.raws.get(occ.value.trim()) ?? 0) + 1);
    e.occs.push(occ);
  }

  const tokenLengths = tokenValues
    .filter((t) => lengthCategoryOfTokenName(t.name) === category)
    .map((t) => {
      const px = parseCssLengthToPx(t.value)?.px;
      return px !== undefined ? { name: t.name, value: t.value, px } : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const sortedLengths = [...lengthByPx.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0] - b[0]
  );
  const lengthClusters: Array<{ rep: number; members: Array<[number, (typeof sortedLengths)[number][1]]> }> = [];
  for (const [px, data] of sortedLengths) {
    const home = lengthClusters.find(
      (c) => Math.abs(px - c.rep) <= Math.max(clustering.lengthTolerancePx, Math.abs(c.rep) * 0.04)
    );
    if (home) home.members.push([px, data]);
    else lengthClusters.push({ rep: px, members: [[px, data]] });
  }

  for (const cluster of lengthClusters) {
    const occurrenceCount = cluster.members.reduce((n, [, d]) => n + d.count, 0);
    let best: { name: string; value: string; d: number } | undefined;
    for (const t of tokenLengths) {
      const d = Math.abs(t.px - cluster.rep);
      if (!best || d < best.d) best = { name: t.name, value: t.value, d };
    }
    const hasTokenMatch =
      best !== undefined &&
      best.d <= Math.max(clustering.lengthTolerancePx, Math.abs(cluster.rep) * 0.04);
    if (!hasTokenMatch && occurrenceCount < clustering.minOccurrences) continue;

    const members: DerivedTokenProposal["members"] = [];
    const evidence: DerivedTokenProposal["evidence"] = [];
    const files = new Set<string>();
    const surfaces = new Set<LiteralSurface>();
    for (const [, d] of cluster.members) {
      for (const [raw, count] of d.raws.entries()) members.push({ value: raw, count });
      for (const o of d.occs) {
        files.add(o.filePath);
        surfaces.add(o.surface);
        pushEvidence(evidence, o);
      }
    }
    members.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    proposals.push({
      kind: "length",
      category,
      representative: members[0]?.value ?? `${cluster.rep}px`,
      members,
      occurrenceCount,
      distinctFileCount: files.size,
      surfaces: [...surfaces].sort(),
      ...(hasTokenMatch && best
        ? {
            existingTokenMatch: {
              name: best.name,
              value: best.value,
              match: best.d <= 0.5 ? ("exact" as const) : ("near" as const),
              distance: Math.round(best.d * 100) / 100,
            },
          }
        : {}),
      recommendation:
        hasTokenMatch && best
          ? `Replace ${occurrenceCount} hardcoded length occurrence(s) with existing token ${best.name}.`
          : `Snap ${members.length} near-identical length value(s) (${occurrenceCount} occurrences, ~${Math.round(cluster.rep * 100) / 100}px) onto one spacing/size token.`,
      evidence,
    });
  }
  }

  proposals.sort(
    (a, b) =>
      Number(Boolean(b.existingTokenMatch)) - Number(Boolean(a.existingTokenMatch)) ||
      b.occurrenceCount - a.occurrenceCount ||
      a.representative.localeCompare(b.representative)
  );
  return proposals.slice(0, clustering.maxClusters);
}

export { rgbaToHex };
