/**
 * packages/mcp/src/designSystem/preprocessors.ts
 *
 * Line-preserving preprocessors for non-TSX/CSS frontend formats:
 *   - Stylesheets: `.scss`, `.less` (single-line `//` comments outside `url(...)`/strings, `$var` / `@var` tokens)
 *   - Single-File & Content Components: `.vue`, `.svelte`, `.astro`, `.mdx`
 *     - Extracts embedded `<style>` blocks with exact 1-based line padding for `parseCssStylesheet`
 *     - Transforms `<script>` + `<template>` / Astro frontmatter+markup / MDX JSX into valid,
 *       line-preserving TSX so `scanTsxOrTsFile` inventories DOM primitives, Tailwind utilities,
 *       inline style literals, prop contracts, JSX skeletons, and component call sites accurately.
 */

import { basename, dirname } from "node:path";

export type StylesheetSyntax = "css" | "scss" | "less";

export interface ExtractedStyleBlock {
  /** Virtual file path (keeps host path for evidence traceability). */
  filePath: string;
  /** Stylesheet source padded with leading `\n`s so 1-based line numbers match the host file. */
  paddedCssText: string;
  syntax: StylesheetSyntax;
  /** True when `<style scoped>` (Vue) or default component-scoped `<style>` (Svelte/Astro without global). */
  defaultScoped: boolean;
}

export const LESS_AT_RULE_KEYWORDS: ReadonlySet<string> = new Set([
  "import",
  "media",
  "supports",
  "keyframes",
  "-webkit-keyframes",
  "-moz-keyframes",
  "font-face",
  "layer",
  "container",
  "scope",
  "starting-style",
  "document",
  "property",
  "theme",
  "charset",
  "namespace",
  "page",
  "plugin",
  "use",
  "forward",
  "mixin",
  "include",
  "extend",
  "function",
  "return",
  "if",
  "else",
  "each",
  "for",
  "while",
  "warn",
  "error",
  "debug",
  "at-root",
  "content",
]);

const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function detectStylesheetSyntax(filePath: string): StylesheetSyntax {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".scss") || lower.endsWith(".sass")) return "scss";
  if (lower.endsWith(".less")) return "less";
  return "css";
}

export function isSupportedStylesheetFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less");
}

export function isPreprocessedUiComponentFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".vue") ||
    lower.endsWith(".svelte") ||
    lower.endsWith(".astro") ||
    lower.endsWith(".mdx")
  );
}

/**
 * Strips `/* ... * /` block comments and (when `allowLineComments` is true for `.scss`/`.less`)
 * `// ...` single-line comments outside string literals and `(...)` (e.g. `url(https://...)`),
 * replacing stripped characters with spaces while preserving every `\n`.
 */
export function stripStylesheetCommentsPreservingLines(
  rawText: string,
  allowLineComments = false
): string {
  const chars = Array.from(rawText);
  const len = chars.length;
  let quote: "'" | '"' | null = null;
  let parenDepth = 0;
  let i = 0;

  while (i < len) {
    const ch = chars[i]!;
    const next = i + 1 < len ? chars[i + 1]! : "";

    if (quote) {
      if (ch === "\\" && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }

    if (ch === "(") {
      parenDepth++;
      i++;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth--;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < len) {
        if (chars[i] === "*" && i + 1 < len && chars[i + 1] === "/") {
          chars[i] = " ";
          chars[i + 1] = " ";
          i += 2;
          break;
        }
        if (chars[i] !== "\n" && chars[i] !== "\r") {
          chars[i] = " ";
        }
        i++;
      }
      continue;
    }

    if (allowLineComments && parenDepth === 0 && ch === "/" && next === "/") {
      const prev = i > 0 ? chars[i - 1]! : "";
      if (prev !== ":") {
        while (i < len && chars[i] !== "\n") {
          if (chars[i] !== "\r") chars[i] = " ";
          i++;
        }
        continue;
      }
    }

    i++;
  }

  return chars.join("");
}

/**
 * Extracts `$var` (SCSS) or `@var` (Less) token references from a CSS declaration value.
 */
export function extractPreprocessorVarReferences(
  value: string,
  syntax: StylesheetSyntax
): string[] {
  if (syntax === "css") return [];
  const scrubbed = value.replace(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, " ");
  const refs: string[] = [];
  if (syntax === "scss") {
    for (const m of scrubbed.matchAll(/(\$[a-zA-Z_][a-zA-Z0-9_-]*)/g)) {
      const name = m[1]!;
      if (!refs.includes(name)) refs.push(name);
    }
  } else if (syntax === "less") {
    for (const m of scrubbed.matchAll(/(@[a-zA-Z_][a-zA-Z0-9_-]*)/g)) {
      const name = m[1]!;
      const bare = name.slice(1).toLowerCase();
      if (LESS_AT_RULE_KEYWORDS.has(bare)) continue;
      if (!refs.includes(name)) refs.push(name);
    }
  }
  return refs;
}

/**
 * Extracts `<style>` blocks from `.vue`, `.svelte`, and `.astro` files, padding leading lines
 * with `\n` so 1-based line numbers reported by `parseCssStylesheet` match the original file.
 */
export function extractEmbeddedStyleBlocks(
  filePath: string,
  rawText: string
): ExtractedStyleBlock[] {
  const lower = filePath.toLowerCase();
  if (
    !lower.endsWith(".vue") &&
    !lower.endsWith(".svelte") &&
    !lower.endsWith(".astro")
  ) {
    return [];
  }

  // Blank out `<script>...</script>` and `<!-- ... -->` first so `<style>` strings inside JS/comments are ignored
  let masked = rawText.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  masked = masked.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) =>
    m.replace(/[^\n]/g, " ")
  );
  if (lower.endsWith(".astro")) {
    masked = masked.replace(/^\s*---[\s\S]*?---/, (m) => m.replace(/[^\n]/g, " "));
  }

  const blocks: ExtractedStyleBlock[] = [];
  const styleRe = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = styleRe.exec(masked)) !== null) {
    const attrs = match[1] ?? "";
    const openTagLen = match[0].indexOf(">") + 1;
    const bodyStart = match.index + openTagLen;
    const bodyEnd = bodyStart + (match[2]?.length ?? 0);
    const rawBody = rawText.slice(bodyStart, bodyEnd);

    let lineBreaksBefore = 0;
    let lastNewlineIdx = -1;
    for (let k = 0; k < bodyStart; k++) {
      if (rawText.charCodeAt(k) === 10) {
        lineBreaksBefore++;
        lastNewlineIdx = k;
      }
    }
    const colOffset = Math.max(0, bodyStart - (lastNewlineIdx + 1));
    const paddedCssText = `${"\n".repeat(lineBreaksBefore)}${" ".repeat(colOffset)}${rawBody}`;

    const langMatch = attrs.match(/\blang\s*=\s*["']?([a-zA-Z0-9_-]+)["']?/i);
    const lang = (langMatch?.[1] ?? "css").toLowerCase();
    const syntax: StylesheetSyntax =
      lang === "scss" || lang === "sass" ? "scss" : lang === "less" ? "less" : "css";

    let defaultScoped = false;
    if (lower.endsWith(".vue")) {
      defaultScoped = /\bscoped\b/i.test(attrs);
    } else if (lower.endsWith(".svelte")) {
      defaultScoped = !/\bglobal\b/i.test(attrs);
    } else if (lower.endsWith(".astro")) {
      defaultScoped = !/\bis:global\b/i.test(attrs);
    }

    blocks.push({
      filePath,
      paddedCssText,
      syntax,
      defaultScoped,
    });
  }

  return blocks;
}

function toPascalIdentifier(raw: string): string {
  const cleaned = raw
    .replace(/^\+/, "")
    .replace(/^\[+|\]+$/g, "")
    .replace(/\.[^.]+$/, "");
  const parts = cleaned.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "UiComponent";
  const joined = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return /^[A-Za-z_$]/.test(joined) ? joined : `Comp${joined}`;
}

export function deriveComponentNameFromPath(filePath: string): string {
  const posix = filePath.replace(/\\/g, "/");
  const base = basename(posix).replace(/\.[^.]+$/, "");
  const parent = basename(dirname(posix));
  if (
    (base === "+page" || base === "+layout" || base === "index" || base === "page" || base === "layout") &&
    parent &&
    parent !== "." &&
    parent !== "src" &&
    parent !== "pages" &&
    parent !== "routes"
  ) {
    return toPascalIdentifier(`${parent}-${base.replace(/^\+/, "")}`);
  }
  return toPascalIdentifier(base);
}

function kebabToPascal(tag: string): string {
  return tag
    .split("-")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function cssPropertyToCamelCase(prop: string): string {
  const trimmed = prop.trim();
  if (trimmed.startsWith("--")) return JSON.stringify(trimmed);
  const camel = trimmed.replace(/-([a-zA-Z])/g, (_, ch: string) => ch.toUpperCase());
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(camel) ? camel : JSON.stringify(trimmed);
}

function convertInlineStyleAttrToJsx(cssStyleText: string): string {
  const entries: string[] = [];
  for (const part of cssStyleText.split(";")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const rawProp = part.slice(0, idx).trim();
    const rawVal = part.slice(idx + 1).trim();
    if (!rawProp || !rawVal) continue;
    entries.push(`${cssPropertyToCamelCase(rawProp)}: ${JSON.stringify(rawVal)}`);
  }
  return entries.length > 0 ? `style={{ ${entries.join(", ")} }}` : "";
}

function extractStaticStringsFromExpr(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(/(?:"([^"\\]*)"|'([^'\\]*)')/g)) {
    const val = (m[1] ?? m[2] ?? "").trim();
    if (val) out.push(val);
  }
  return out;
}

interface ParsedAttrLine {
  lineOffset: number;
  jsxAttr: string;
}

/**
 * Converts raw HTML / Vue / Svelte / Astro tag attributes (potentially spanning multiple lines)
 * into valid JSX attributes mapped to their relative line offsets inside the opening tag.
 */
function convertTagAttributesByLine(attrsRaw: string): {
  byLine: Map<number, string[]>;
  lineCount: number;
} {
  const rawLines = attrsRaw.split("\n");
  const lineStarts = [0];
  for (let i = 0; i < attrsRaw.length; i++) {
    if (attrsRaw.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(0, hi);
  };

  const parsed: ParsedAttrLine[] = [];
  const staticClasses: Array<{ line: number; value: string }> = [];
  let hasDynamicClass = false;
  let firstClassLine = 0;
  const seenPropNames = new Set<string>();

  const len = attrsRaw.length;
  let i = 0;
  while (i < len) {
    while (i < len && /\s/.test(attrsRaw[i]!)) i++;
    if (i >= len) break;

    // Skip JSX/Svelte spread `{...props}`
    if (attrsRaw[i] === "{") {
      let depth = 1;
      i++;
      while (i < len && depth > 0) {
        if (attrsRaw[i] === "{") depth++;
        else if (attrsRaw[i] === "}") depth--;
        i++;
      }
      continue;
    }

    const attrStart = i;
    while (i < len && !/[\s=/>"'{}]/.test(attrsRaw[i]!)) i++;
    const rawName = attrsRaw.slice(attrStart, i);
    if (!rawName) {
      i++;
      continue;
    }

    const attrLine = lineOf(attrStart);
    while (i < len && /[ \t\r]/.test(attrsRaw[i]!)) i++;

    let valKind: "none" | "string" | "expr" = "none";
    let rawVal = "";
    if (i < len && attrsRaw[i] === "=") {
      i++;
      while (i < len && /\s/.test(attrsRaw[i]!)) i++;
      if (i < len && (attrsRaw[i] === '"' || attrsRaw[i] === "'")) {
        const q = attrsRaw[i]!;
        const vStart = i + 1;
        i++;
        while (i < len && attrsRaw[i] !== q) {
          if (attrsRaw[i] === "\\" && i + 1 < len) i += 2;
          else i++;
        }
        rawVal = attrsRaw.slice(vStart, i);
        if (i < len && attrsRaw[i] === q) i++;
        valKind = "string";
      } else if (i < len && attrsRaw[i] === "{") {
        const vStart = i + 1;
        let depth = 1;
        i++;
        while (i < len && depth > 0) {
          if (attrsRaw[i] === "{") depth++;
          else if (attrsRaw[i] === "}") depth--;
          i++;
        }
        rawVal = attrsRaw.slice(vStart, Math.max(vStart, i - 1));
        valKind = "expr";
      } else {
        const vStart = i;
        while (i < len && !/[\s/>]/.test(attrsRaw[i]!)) i++;
        rawVal = attrsRaw.slice(vStart, i);
        valKind = "string";
      }
    }

    // Skip Vue/Svelte directives & event handlers (`v-*`, `@click`, `on:click`, `bind:*`, `use:*`, `#slot`)
    if (
      rawName.startsWith("@") ||
      rawName.startsWith("#") ||
      rawName.startsWith("v-if") ||
      rawName.startsWith("v-else") ||
      rawName.startsWith("v-for") ||
      rawName.startsWith("v-show") ||
      rawName.startsWith("v-model") ||
      rawName.startsWith("v-html") ||
      rawName.startsWith("v-text") ||
      rawName.startsWith("v-slot") ||
      rawName.startsWith("v-on:") ||
      rawName.startsWith("on:") ||
      rawName.startsWith("bind:") ||
      rawName.startsWith("use:") ||
      rawName.startsWith("transition:") ||
      rawName.startsWith("in:") ||
      rawName.startsWith("out:") ||
      rawName.startsWith("animate:")
    ) {
      continue;
    }

    // Svelte `class:active={cond}` directive (excluding Astro's `class:list={...}`)
    if (rawName.startsWith("class:") && rawName !== "class:list") {
      const cls = rawName.slice("class:".length).trim();
      if (cls) {
        if (staticClasses.length === 0 && !hasDynamicClass) firstClassLine = attrLine;
        staticClasses.push({ line: attrLine, value: cls });
        hasDynamicClass = true;
      }
      continue;
    }

    const isBound = rawName.startsWith(":") || rawName.startsWith("v-bind:");
    const cleanName = rawName
      .replace(/^(?::|v-bind:)/, "")
      .replace(/\.[a-zA-Z0-9_-]+$/, "");

    if (cleanName === "class" || cleanName === "className" || cleanName === "class:list") {
      if (staticClasses.length === 0 && !hasDynamicClass) firstClassLine = attrLine;
      if (!isBound && valKind === "string") {
        if (rawVal.trim()) {
          staticClasses.push({ line: attrLine, value: rawVal.replace(/\s+/g, " ").trim() });
        }
      } else {
        hasDynamicClass = true;
        for (const s of extractStaticStringsFromExpr(rawVal)) {
          staticClasses.push({ line: attrLine, value: s });
        }
      }
      continue;
    }

    if (cleanName === "style") {
      if (!isBound && valKind === "string") {
        const styleJsx = convertInlineStyleAttrToJsx(rawVal);
        if (styleJsx && !seenPropNames.has("style")) {
          seenPropNames.add("style");
          parsed.push({ lineOffset: attrLine, jsxAttr: styleJsx });
        }
      } else if (valKind === "expr" && /^\s*\{[\s\S]*\}\s*$/.test(`{${rawVal}}`)) {
        // Keep object-literal inline styles (`style={{ margin: "12px" }}`) when single-line valid
        const trimmedExpr = rawVal.trim();
        if (trimmedExpr.startsWith("{") && trimmedExpr.endsWith("}") && !trimmedExpr.includes("\n")) {
          if (!seenPropNames.has("style")) {
            seenPropNames.add("style");
            parsed.push({ lineOffset: attrLine, jsxAttr: `style={${trimmedExpr}}` });
          }
        }
      }
      continue;
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(cleanName)) continue;
    if (seenPropNames.has(cleanName)) continue;
    seenPropNames.add(cleanName);

    if (!isBound && valKind === "string") {
      parsed.push({
        lineOffset: attrLine,
        jsxAttr: `${cleanName}=${JSON.stringify(rawVal.replace(/\r?\n/g, " "))}`,
      });
    } else if (!isBound && valKind === "none") {
      parsed.push({ lineOffset: attrLine, jsxAttr: cleanName });
    } else {
      parsed.push({ lineOffset: attrLine, jsxAttr: `${cleanName}={undefined as any}` });
    }
  }

  if (staticClasses.length > 0 || hasDynamicClass) {
    const joinedClasses = staticClasses.map((c) => c.value).join(" ").trim();
    const targetLine = staticClasses[0]?.line ?? firstClassLine;
    const classJsx = hasDynamicClass
      ? `className={\`${joinedClasses.replace(/[`$\\]/g, "")}\${""}\`}`
      : `className=${JSON.stringify(joinedClasses)}`;
    parsed.unshift({ lineOffset: targetLine, jsxAttr: classJsx });
  }

  const byLine = new Map<number, string[]>();
  for (const item of parsed) {
    let arr = byLine.get(item.lineOffset);
    if (!arr) {
      arr = [];
      byLine.set(item.lineOffset, arr);
    }
    arr.push(item.jsxAttr);
  }

  return { byLine, lineCount: rawLines.length };
}

/**
 * Converts a slice of HTML/Vue/Svelte/Astro template lines (`lines[startLine..endLine]`)
 * into balanced, line-preserving JSX inside `outLines[startLine..endLine]`.
 */
function emitTemplateRegionAsJsx(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  outLines: string[],
  importedNames: ReadonlySet<string>,
  options: { stripOuterTemplateTag?: boolean; mdxMode?: boolean } = {}
): void {
  if (startLine < 0 || endLine < startLine || startLine >= lines.length) return;

  const regionLines = lines.slice(startLine, endLine + 1).map((l, idx) => {
    if (options.stripOuterTemplateTag) {
      if (idx === 0) l = l.replace(/<template\b[^>]*>/i, (m) => " ".repeat(m.length));
      if (idx === endLine - startLine) {
        l = l.replace(/<\/template>/i, (m) => " ".repeat(m.length));
      }
    }
    return l;
  });

  // Mask fenced code blocks in MDX so markdown examples are never treated as JSX
  if (options.mdxMode) {
    let inFence = false;
    for (let i = 0; i < regionLines.length; i++) {
      if (/^\s*```/.test(regionLines[i]!)) {
        regionLines[i] = "";
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        regionLines[i] = "";
      } else if (/^\s*(?:import|export)\b/.test(regionLines[i]!)) {
        // Handled at module top-level
        regionLines[i] = "";
      }
    }
  }

  const regionText = regionLines.join("\n");
  const lineStarts = [0];
  for (let i = 0; i < regionText.length; i++) {
    if (regionText.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(0, hi);
  };

  const perLineSegments: string[][] = Array.from(
    { length: regionLines.length },
    () => []
  );
  const pushSeg = (relLine: number, text: string) => {
    const bounded = Math.max(0, Math.min(regionLines.length - 1, relLine));
    perLineSegments[bounded]!.push(text);
  };

  const openStack: Array<{ jsxTag: string; relLine: number }> = [];
  const len = regionText.length;
  let i = 0;

  while (i < len) {
    const lt = regionText.indexOf("<", i);
    if (lt === -1) break;

    // HTML comment `<!-- ... -->`
    if (regionText.startsWith("<!--", lt)) {
      const closeComment = regionText.indexOf("-->", lt + 4);
      i = closeComment === -1 ? len : closeComment + 3;
      continue;
    }

    const afterLt = regionText[lt + 1] ?? "";
    // Closing tag `</tag>`
    if (afterLt === "/") {
      const gt = regionText.indexOf(">", lt + 2);
      if (gt === -1) break;
      const rawClose = regionText.slice(lt + 2, gt).trim();
      i = gt + 1;
      if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(rawClose)) continue;
      let resolvedClose = rawClose;
      if (rawClose === "slot" || rawClose === "template" || rawClose.startsWith("svelte:")) {
        resolvedClose = "div";
      } else if (!/^[A-Z]/.test(rawClose) && rawClose.includes("-")) {
        const pascal = kebabToPascal(rawClose);
        resolvedClose = importedNames.has(pascal) ? pascal : "div";
      }
      if (HTML_VOID_TAGS.has(resolvedClose.toLowerCase())) continue;

      // Pop matching tag from stack (closing any unclosed inner HTML tags cleanly)
      let matchIdx = -1;
      for (let s = openStack.length - 1; s >= 0; s--) {
        if (openStack[s]!.jsxTag === resolvedClose) {
          matchIdx = s;
          break;
        }
      }
      const closeLine = lineOf(gt);
      if (matchIdx !== -1) {
        while (openStack.length > matchIdx) {
          const popped = openStack.pop()!;
          pushSeg(closeLine, `</${popped.jsxTag}>`);
        }
      }
      continue;
    }

    // Must start a valid tag name `<Tag` or `<div`
    if (!/[A-Za-z]/.test(afterLt)) {
      i = lt + 1;
      continue;
    }

    // Scan tag name
    let p = lt + 1;
    while (p < len && /[A-Za-z0-9_.:-]/.test(regionText[p]!)) p++;
    const rawTagName = regionText.slice(lt + 1, p);
    const nextCh = regionText[p] ?? "";
    if (nextCh && !/[\s/>]/.test(nextCh)) {
      i = lt + 1;
      continue;
    }

    // Scan until matching `>` outside quotes and `{...}` braces
    let quote: "'" | '"' | null = null;
    let braceDepth = 0;
    let q = p;
    while (q < len) {
      const c = regionText[q]!;
      if (quote) {
        if (c === "\\" && q + 1 < len) {
          q += 2;
          continue;
        }
        if (c === quote) quote = null;
        q++;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        q++;
        continue;
      }
      if (c === "{") {
        braceDepth++;
        q++;
        continue;
      }
      if (c === "}" && braceDepth > 0) {
        braceDepth--;
        q++;
        continue;
      }
      if (c === ">" && braceDepth === 0) {
        break;
      }
      q++;
    }
    if (q >= len) break;

    let attrsSlice = regionText.slice(p, q);
    let selfClosing = false;
    if (/\s*\/\s*$/.test(attrsSlice)) {
      selfClosing = true;
      attrsSlice = attrsSlice.replace(/\/\s*$/, "");
    }
    const openStartLine = lineOf(lt);
    const openEndLine = lineOf(q);
    i = q + 1;

    // Resolve JSX tag identifier
    let jsxTag = rawTagName;
    if (rawTagName === "slot" || rawTagName === "template" || rawTagName.startsWith("svelte:")) {
      jsxTag = "div";
    } else if (rawTagName === "component") {
      const isMatch = attrsSlice.match(/(?::is|v-bind:is)\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      const exprIdent = isMatch ? (isMatch[1] ?? isMatch[2] ?? "").trim() : "";
      jsxTag = /^[A-Z][A-Za-z0-9_]*$/.test(exprIdent) ? exprIdent : "div";
    } else if (!/^[A-Z]/.test(rawTagName)) {
      if (rawTagName.includes("-")) {
        const pascal = kebabToPascal(rawTagName);
        jsxTag = importedNames.has(pascal) ? pascal : "div";
      } else if (rawTagName.includes(":")) {
        jsxTag = "div";
      } else {
        jsxTag = rawTagName.toLowerCase();
      }
    }

    if (HTML_VOID_TAGS.has(jsxTag.toLowerCase())) {
      selfClosing = true;
    }

    const { byLine, lineCount } = convertTagAttributesByLine(attrsSlice);
    const closeToken = selfClosing ? " />" : ">";

    if (lineCount <= 1 || openStartLine === openEndLine) {
      const inlineAttrs = byLine.get(0) ?? [];
      const attrStr = inlineAttrs.length > 0 ? ` ${inlineAttrs.join(" ")}` : "";
      pushSeg(openStartLine, `<${jsxTag}${attrStr}${closeToken}`);
    } else {
      const firstAttrs = byLine.get(0) ?? [];
      pushSeg(
        openStartLine,
        `<${jsxTag}${firstAttrs.length > 0 ? ` ${firstAttrs.join(" ")}` : ""}`
      );
      for (let off = 1; off < lineCount - 1; off++) {
        const midAttrs = byLine.get(off) ?? [];
        if (midAttrs.length > 0) {
          pushSeg(openStartLine + off, midAttrs.join(" "));
        }
      }
      const lastOff = lineCount - 1;
      const lastAttrs = byLine.get(lastOff) ?? [];
      pushSeg(
        openEndLine,
        `${lastAttrs.length > 0 ? `${lastAttrs.join(" ")}` : ""}${closeToken}`
      );
    }

    if (!selfClosing) {
      openStack.push({ jsxTag, relLine: openEndLine });
    }
  }

  // Close any unclosed tags at the end of the template region so TSX is 100% balanced
  const finalRelLine = Math.max(0, regionLines.length - 1);
  while (openStack.length > 0) {
    const unclosed = openStack.pop()!;
    pushSeg(finalRelLine, `</${unclosed.jsxTag}>`);
  }

  for (let r = 0; r < regionLines.length; r++) {
    const segs = perLineSegments[r]!;
    if (segs.length > 0) {
      outLines[startLine + r] = segs.join(" ");
    }
  }
}

function collectImportedIdentifiers(scriptLines: readonly string[]): Set<string> {
  const names = new Set<string>();
  const joined = scriptLines.join("\n");
  for (const m of joined.matchAll(/import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/g)) {
    const clause = m[1] ?? "";
    for (const id of clause.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
      const tok = id[1]!;
      if (tok !== "type" && tok !== "as") names.add(tok);
    }
  }
  return names;
}

/**
 * Preprocesses `.vue`, `.svelte`, `.astro`, and `.mdx` source text into valid,
 * line-preserving TSX source text for `scanTsxOrTsFile`.
 */
export function preprocessUiComponentToTsx(filePath: string, rawText: string): string {
  const lower = filePath.toLowerCase();
  if (!isPreprocessedUiComponentFile(filePath)) return rawText;

  const lines = rawText.split(/\r?\n/);
  const totalLines = Math.max(1, lines.length);
  const out: string[] = new Array(totalLines).fill("");
  const compName = deriveComponentNameFromPath(filePath);

  // -------------------------------------------------------------------------
  // 1. Vue Single-File Component (`.vue`)
  // -------------------------------------------------------------------------
  if (lower.endsWith(".vue")) {
    let inScript = false;
    let hasExportDefault = false;
    const scriptLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!inScript) {
        const openMatch = line.match(/<script\b([^>]*)>/i);
        if (openMatch) {
          const afterOpen = line.slice((openMatch.index ?? 0) + openMatch[0].length);
          const closeMatch = afterOpen.match(/<\/script>/i);
          if (closeMatch) {
            const inner = afterOpen.slice(0, closeMatch.index ?? 0);
            out[i] = inner;
            scriptLines.push(inner);
            if (/\bexport\s+default\b/.test(inner)) hasExportDefault = true;
          } else {
            inScript = true;
            out[i] = afterOpen.trim() ? afterOpen : "";
            scriptLines.push(afterOpen);
            if (/\bexport\s+default\b/.test(afterOpen)) hasExportDefault = true;
          }
        }
      } else {
        const closeMatch = line.match(/<\/script>/i);
        if (closeMatch) {
          const beforeClose = line.slice(0, closeMatch.index ?? 0);
          out[i] = beforeClose.trim() ? beforeClose : "";
          scriptLines.push(beforeClose);
          if (/\bexport\s+default\b/.test(beforeClose)) hasExportDefault = true;
          inScript = false;
        } else {
          out[i] = line;
          scriptLines.push(line);
          if (/\bexport\s+default\b/.test(line)) hasExportDefault = true;
        }
      }
    }

    // Extract single-line or multi-line `defineProps<PropsType>()` type parameter if present
    const fullScript = scriptLines.join("\n");
    const definePropsMatch = fullScript.match(/\bdefineProps\s*<([\s\S]*?)>\s*\(/);
    const propsTypeRef =
      definePropsMatch && !definePropsMatch[1]!.includes("\n")
        ? definePropsMatch[1]!.trim()
        : undefined;
    const importedNames = collectImportedIdentifiers(scriptLines);

    let tplStart = -1;
    let tplEnd = -1;
    let tplDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      if (out[i] !== "") continue;
      const line = lines[i]!;
      const opens = (line.match(/<template\b[^>]*>/gi) ?? []).length;
      const closes = (line.match(/<\/template>/gi) ?? []).length;
      if (opens > 0 && tplDepth === 0 && tplStart === -1) tplStart = i;
      tplDepth += opens - closes;
      if (tplStart !== -1 && tplDepth <= 0 && closes > 0) {
        tplEnd = i;
        break;
      }
    }

    const paramSig = propsTypeRef ? `_props: ${propsTypeRef}` : "";
    const fnOpen = `${hasExportDefault ? "" : "export "}function ${compName}(${paramSig}) { return (<>`;
    if (tplStart !== -1 && tplEnd !== -1 && tplEnd >= tplStart) {
      emitTemplateRegionAsJsx(lines, tplStart, tplEnd, out, importedNames, {
        stripOuterTemplateTag: true,
      });
      out[tplStart] = `${fnOpen}${out[tplStart] ? ` ${out[tplStart]}` : ""}`;
      out[tplEnd] = `${out[tplEnd] ? `${out[tplEnd]} ` : ""}</>); }`;
    } else {
      const last = totalLines - 1;
      out[last] = `${out[last] ? `${out[last]}; ` : ""}${fnOpen}</>); }`;
    }
    return out.join("\n");
  }

  // -------------------------------------------------------------------------
  // 2. Svelte Component (`.svelte`)
  // -------------------------------------------------------------------------
  if (lower.endsWith(".svelte")) {
    let inScript = false;
    let inStyle = false;
    const isMarkupLine = new Array<boolean>(totalLines).fill(true);
    const scriptLines: string[] = [];
    const svelteExportProps: Array<{ name: string; type: string; optional: boolean }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (inStyle) {
        isMarkupLine[i] = false;
        if (/<\/style>/i.test(line)) inStyle = false;
        continue;
      }
      if (!inScript && /<style\b[^>]*>/i.test(line)) {
        isMarkupLine[i] = false;
        if (!/<\/style>/i.test(line)) inStyle = true;
        continue;
      }
      if (!inScript) {
        const openMatch = line.match(/<script\b([^>]*)>/i);
        if (openMatch) {
          isMarkupLine[i] = false;
          const afterOpen = line.slice((openMatch.index ?? 0) + openMatch[0].length);
          const closeMatch = afterOpen.match(/<\/script>/i);
          if (closeMatch) {
            const inner = afterOpen.slice(0, closeMatch.index ?? 0);
            out[i] = inner;
            scriptLines.push(inner);
          } else {
            inScript = true;
            out[i] = afterOpen.trim() ? afterOpen : "";
            scriptLines.push(afterOpen);
          }
          continue;
        }
      } else {
        isMarkupLine[i] = false;
        const closeMatch = line.match(/<\/script>/i);
        if (closeMatch) {
          const beforeClose = line.slice(0, closeMatch.index ?? 0);
          out[i] = beforeClose.trim() ? beforeClose : "";
          scriptLines.push(beforeClose);
          inScript = false;
        } else {
          // Capture Svelte 4 `export let propName: PropType = default;`
          const expLet = line.match(
            /^\s*export\s+let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*([^=;]+?))?\s*(?:=\s*([^;]+))?;?\s*$/
          );
          if (expLet) {
            svelteExportProps.push({
              name: expLet[1]!,
              type: (expLet[2] ?? "unknown").trim(),
              optional: expLet[3] !== undefined,
            });
            out[i] = line.replace(/^\s*export\s+let\b/, "let");
          } else if (/^\s*\$:\s*/.test(line)) {
            // Strip Svelte reactive label `$:` so TS parses cleanly
            out[i] = line.replace(/^\s*\$:\s*/, "");
          } else {
            out[i] = line;
          }
          scriptLines.push(line);
        }
      }
    }

    const fullScript = scriptLines.join("\n");
    const runesPropsMatch = fullScript.match(/:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\$props\s*\(/);
    let propsSig = "";
    if (runesPropsMatch) {
      propsSig = `_props: ${runesPropsMatch[1]!}`;
    } else if (svelteExportProps.length > 0) {
      const inlineMembers = svelteExportProps
        .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
        .join("; ");
      propsSig = `_props: { ${inlineMembers} }`;
    }

    const importedNames = collectImportedIdentifiers(scriptLines);
    // Collect markup lines into a masked array keeping non-markup lines blank
    const maskedLines = lines.map((l, idx) => (isMarkupLine[idx] ? l : ""));
    let firstMarkup = isMarkupLine.indexOf(true);
    let lastMarkup = isMarkupLine.lastIndexOf(true);
    if (firstMarkup === -1) {
      firstMarkup = totalLines - 1;
      lastMarkup = totalLines - 1;
    }

    const jsxOut = new Array<string>(totalLines).fill("");
    emitTemplateRegionAsJsx(maskedLines, firstMarkup, lastMarkup, jsxOut, importedNames);
    for (let i = firstMarkup; i <= lastMarkup; i++) {
      if (isMarkupLine[i] && jsxOut[i]) {
        out[i] = jsxOut[i]!;
      }
    }
    const fnOpen = `export function ${compName}(${propsSig}) { return (<>`;
    out[firstMarkup] = `${out[firstMarkup] && !isMarkupLine[firstMarkup] ? `${out[firstMarkup]}; ` : ""}${fnOpen}${
      isMarkupLine[firstMarkup] && out[firstMarkup] ? ` ${out[firstMarkup]}` : ""
    }`;
    out[lastMarkup] = `${out[lastMarkup] ? `${out[lastMarkup]} ` : ""}</>); }`;
    return out.join("\n");
  }

  // -------------------------------------------------------------------------
  // 3. Astro Component / Page (`.astro`)
  // -------------------------------------------------------------------------
  if (lower.endsWith(".astro")) {
    let firstIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() !== "") {
        firstIdx = i;
        break;
      }
    }
    let closeIdx = -1;
    if (firstIdx !== -1 && lines[firstIdx]!.trim() === "---") {
      for (let i = firstIdx + 1; i < lines.length; i++) {
        if (lines[i]!.trim() === "---") {
          closeIdx = i;
          break;
        }
      }
    }

    const scriptLines: string[] = [];
    let hasPropsInterface = false;
    let markupStart = 0;
    if (closeIdx !== -1) {
      for (let i = firstIdx + 1; i < closeIdx; i++) {
        out[i] = lines[i]!;
        scriptLines.push(lines[i]!);
        if (/\b(?:interface|type)\s+Props\b/.test(lines[i]!)) {
          hasPropsInterface = true;
        }
      }
      markupStart = closeIdx;
    }

    // Blank out `<style>` and `<script>` blocks inside the Astro template body
    const maskedMarkup = [...lines];
    let inTagBlock: "style" | "script" | null = null;
    for (let i = markupStart; i < maskedMarkup.length; i++) {
      if (i === closeIdx) {
        maskedMarkup[i] = "";
        continue;
      }
      const l = maskedMarkup[i]!;
      if (inTagBlock) {
        maskedMarkup[i] = "";
        if (new RegExp(`</${inTagBlock}>`, "i").test(l)) inTagBlock = null;
        continue;
      }
      if (/<style\b[^>]*>/i.test(l)) {
        maskedMarkup[i] = "";
        if (!/<\/style>/i.test(l)) inTagBlock = "style";
        continue;
      }
      if (/<script\b[^>]*>/i.test(l)) {
        maskedMarkup[i] = "";
        if (!/<\/script>/i.test(l)) inTagBlock = "script";
      }
    }

    const importedNames = collectImportedIdentifiers(scriptLines);
    const endLine = totalLines - 1;
    emitTemplateRegionAsJsx(maskedMarkup, markupStart, endLine, out, importedNames);
    const propsSig = hasPropsInterface ? "_props: Props" : "";
    const fnOpen = `export function ${compName}(${propsSig}) { return (<>`;
    out[markupStart] = `${fnOpen}${out[markupStart] ? ` ${out[markupStart]}` : ""}`;
    out[endLine] = `${out[endLine] ? `${out[endLine]} ` : ""}</>); }`;
    return out.join("\n");
  }

  // -------------------------------------------------------------------------
  // 4. MDX Document (`.mdx`)
  // -------------------------------------------------------------------------
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        bodyStart = i + 1;
        break;
      }
    }
  }

  const scriptLines: string[] = [];
  const moduleStmtLines = new Set<number>();
  let inFence = false;
  for (let i = bodyStart; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^(?:import|export)\s/.test(trimmed)) {
      out[i] = lines[i]!;
      scriptLines.push(lines[i]!);
      moduleStmtLines.add(i);
    }
  }

  const importedNames = collectImportedIdentifiers(scriptLines);
  const jsxOut = new Array<string>(totalLines).fill("");
  emitTemplateRegionAsJsx(lines, bodyStart, totalLines - 1, jsxOut, importedNames, {
    mdxMode: true,
  });

  // Partition [bodyStart..totalLines-1] into contiguous non-module spans so top-level `import`/`export`
  // statements never end up nested inside JSX fragments.
  const spans: Array<{ start: number; end: number }> = [];
  let spanStart = -1;
  for (let i = bodyStart; i < totalLines; i++) {
    if (moduleStmtLines.has(i)) {
      if (spanStart !== -1) {
        spans.push({ start: spanStart, end: i - 1 });
        spanStart = -1;
      }
    } else if (spanStart === -1) {
      spanStart = i;
    }
  }
  if (spanStart !== -1) {
    spans.push({ start: spanStart, end: totalLines - 1 });
  }

  for (let i = bodyStart; i < totalLines; i++) {
    if (!moduleStmtLines.has(i) && jsxOut[i]) {
      out[i] = jsxOut[i]!;
    }
  }

  if (spans.length === 0) {
    const last = totalLines - 1;
    out[last] = `${out[last] ? `${out[last]}; ` : ""}export function ${compName}() { return (<></>); }`;
  } else {
    spans.forEach((sp, idx) => {
      const fnOpen =
        idx === 0
          ? `export function ${compName}() { return (<>`
          : `function __${compName}Part${idx}__() { return (<>`;
      out[sp.start] = `${fnOpen}${out[sp.start] ? ` ${out[sp.start]}` : ""}`;
      out[sp.end] = `${out[sp.end] ? `${out[sp.end]} ` : ""}</>); }`;
    });
  }
  return out.join("\n");
}
