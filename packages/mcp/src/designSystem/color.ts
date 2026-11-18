/**
 * packages/mcp/src/designSystem/color.ts
 *
 * Framework-agnostic color parsing & math for the `design-system` plugin.
 * Supports `#hex`, `rgb()/rgba()` (comma & space syntax), `hsl()/hsla()`, `oklch()`,
 * `oklab()` and a small set of named colors. Anything else (e.g. `color-mix()`,
 * `calc()`, `currentColor`) returns `null` so callers can report an explicit
 * "unresolved" state instead of silently dropping the value (Principle of Incomplete Truth).
 */

export interface RgbaColor {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
  a: number; // 0..1
}

export interface OklabColor {
  L: number;
  a: number;
  b: number;
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  maroon: [128, 0, 0],
  navy: [0, 0, 128],
  teal: [0, 128, 128],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function parseNumberToken(tok: string, percentScale: number): number | null {
  const t = tok.trim().toLowerCase();
  if (t === "none") return 0;
  if (t.endsWith("%")) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? (n / 100) * percentScale : null;
  }
  const n = Number.parseFloat(t.replace(/(deg|rad|turn|grad)$/, ""));
  if (!Number.isFinite(n)) return null;
  if (t.endsWith("turn")) return n * 360;
  if (t.endsWith("rad")) return (n * 180) / Math.PI;
  if (t.endsWith("grad")) return n * 0.9;
  return n;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const lig = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ];
}

function srgbChannelToLinear(channel255: number): number {
  const s = channel255 / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgbChannel(l: number): number {
  const v = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return clamp(Math.round(v * 255), 0, 255);
}

export function toOklab(c: RgbaColor): OklabColor {
  const r = srgbChannelToLinear(c.r);
  const g = srgbChannelToLinear(c.g);
  const b = srgbChannelToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgba(L: number, a: number, b: number, alpha: number): RgbaColor {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return {
    r: linearToSrgbChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgbChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgbChannel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: clamp(alpha, 0, 1),
  };
}

/** Euclidean distance in OKLab (≈ perceptual ΔE; ~0.02 is barely noticeable). */
export function oklabDistance(x: OklabColor, y: OklabColor): number {
  return Math.sqrt((x.L - y.L) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2);
}

export function parseCssColorString(raw: string): RgbaColor | null {
  const str = raw.trim().toLowerCase();
  if (!str) return null;

  if (str.startsWith("#")) {
    const hex = str.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }

  if (str === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED_COLORS[str];
  if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };

  const fn = str.match(/^(rgba?|hsla?|oklch|oklab)\(\s*([^)]+?)\s*\)$/);
  if (!fn) return null;
  const kind = fn[1];
  const args = fn[2].replace(/\//g, " / ").split(/[\s,]+/).filter(Boolean);
  const slashIdx = args.indexOf("/");
  const colorArgs = slashIdx === -1 ? args.slice(0, 3) : args.slice(0, slashIdx);
  let alphaTok: string | undefined =
    slashIdx !== -1 ? args[slashIdx + 1] : args.length > 3 ? args[3] : undefined;
  if (colorArgs.length < 3) return null;
  const alpha =
    alphaTok !== undefined ? parseNumberToken(alphaTok, 1) : 1;
  if (alpha === null) return null;
  const a = clamp(alpha, 0, 1);

  if (kind === "rgb" || kind === "rgba") {
    const rgb = colorArgs.map((t) => parseNumberToken(t, 255));
    if (rgb.some((n) => n === null)) return null;
    return {
      r: clamp(rgb[0]!, 0, 255),
      g: clamp(rgb[1]!, 0, 255),
      b: clamp(rgb[2]!, 0, 255),
      a,
    };
  }
  if (kind === "hsl" || kind === "hsla") {
    const h = parseNumberToken(colorArgs[0], 360);
    const s = parseNumberToken(colorArgs[1], 1);
    const l = parseNumberToken(colorArgs[2], 1);
    if (h === null || s === null || l === null) return null;
    // Unitless saturation/lightness in legacy syntax are percentages without `%` in bare triplets
    const sat = colorArgs[1].includes("%") ? s : s > 1 ? s / 100 : s;
    const lig = colorArgs[2].includes("%") ? l : l > 1 ? l / 100 : l;
    const [r, g, b] = hslToRgb(h, sat, lig);
    return { r, g, b, a };
  }
  // oklch / oklab
  const L = parseNumberToken(colorArgs[0], 1);
  if (L === null) return null;
  if (kind === "oklch") {
    const C = parseNumberToken(colorArgs[1], 0.4);
    const h = parseNumberToken(colorArgs[2], 360);
    if (C === null || h === null) return null;
    const rad = (h * Math.PI) / 180;
    return oklabToRgba(L, C * Math.cos(rad), C * Math.sin(rad), a);
  }
  const A = parseNumberToken(colorArgs[1], 0.4);
  const B = parseNumberToken(colorArgs[2], 0.4);
  if (A === null || B === null) return null;
  return oklabToRgba(L, A, B, a);
}

/** True when the *entire* string is a single color literal (hex / rgb / hsl / oklch / oklab). */
export function looksLikeColorLiteral(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) return true;
  if (/^(?:rgba?|hsla?|oklch|oklab)\(\s*[^()]+\)$/.test(s)) {
    return parseCssColorString(s) !== null;
  }
  return false;
}

export function compositeOver(fg: RgbaColor, bg: RgbaColor): RgbaColor {
  if (fg.a >= 0.999) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

export function rgbaToHex(c: RgbaColor): string {
  const to2 = (n: number) =>
    Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, "0");
  return `#${to2(c.r)}${to2(c.g)}${to2(c.b)}`;
}

export function computeRelativeLuminance(c: RgbaColor): number {
  return (
    0.2126 * srgbChannelToLinear(c.r) +
    0.7152 * srgbChannelToLinear(c.g) +
    0.0722 * srgbChannelToLinear(c.b)
  );
}

export function computeWcagContrastRatio(fg: RgbaColor, bg: RgbaColor): number {
  const effBg: RgbaColor = { r: bg.r, g: bg.g, b: bg.b, a: 1 };
  const effFg = compositeOver(fg, effBg);
  const l1 = computeRelativeLuminance(effFg);
  const l2 = computeRelativeLuminance(effBg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

/** Generic, deterministic hue family label used only for *suggested* token names. */
export function describeColor(c: RgbaColor): { family: string; step: number } {
  const lab = toOklab(c);
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  const step = Math.round(lab.L * 10) * 10; // 0..100
  if (chroma < 0.03) return { family: "neutral", step };
  const hue = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
  const families: Array<[number, string]> = [
    [25, "red"],
    [70, "orange"],
    [110, "yellow"],
    [160, "green"],
    [200, "teal"],
    [250, "blue"],
    [310, "purple"],
    [350, "pink"],
    [360, "red"],
  ];
  const family = families.find(([max]) => hue < max)?.[1] ?? "red";
  return { family, step };
}
