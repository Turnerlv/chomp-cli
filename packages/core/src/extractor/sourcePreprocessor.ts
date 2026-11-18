/**
 * @file sourcePreprocessor.ts
 * Source-text preprocessor for non-standard TypeScript/JSX template files (`.astro`, `.mdx`).
 *
 * Converts `.astro` frontmatter + template markup and `.mdx` frontmatter + JSX blocks into
 * line-preserving valid TypeScript/TSX source text so the standard TypeScript compiler AST
 * pipeline and Chomp visitors can extract contracts, imports, and JSX render relationships
 * with exact line-number fidelity.
 */

/**
 * Supported source file extensions ingested by the AST extraction pipeline.
 */
export const SUPPORTED_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.mdx',
]);

/**
 * True when `filePath` is a template file (`.astro`, `.mdx`, `.vue`, or `.svelte`) that is preprocessed into TSX.
 *
 * @param filePath - Path of the source file being inspected.
 * @returns Whether the file requires template-to-TSX preprocessing.
 *
 * @example
 * isTemplatePreprocessedFile('src/routes/+page.svelte') // true
 */
export function isTemplatePreprocessedFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('.astro') ||
    lower.endsWith('.mdx') ||
    lower.endsWith('.vue') ||
    lower.endsWith('.svelte')
  );
}

/**
 * Extracts Capitalized JSX component tags (`<Header />`, `<Form.Input prop={val} />`) from a single
 * template line while preserving identifier-bound attributes (`prop={handler}`) so line numbers
 * in the synthesized TSX match the original `.astro` or `.mdx` source line.
 *
 * @param line - A single line of `.astro` or `.mdx` template markup.
 * @returns Semicolon-separated self-closing JSX element expressions for that line.
 */
function extractTemplateJsxOnLine(line: string): string {
  const tags: string[] = [];
  const tagRegex = /<([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\b([^>]*)/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(line)) !== null) {
    const tagName = match[1];
    const attrsRaw = match[2] ?? '';
    const attrs: string[] = [];
    const attrRegex = /\b([A-Za-z_$][A-Za-z0-9_$]*)=\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrsRaw)) !== null) {
      attrs.push(`${attrMatch[1]}={${attrMatch[2]}}`);
    }
    const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
    tags.push(`<${tagName}${attrStr} />`);
  }
  return tags.join('; ');
}

function kebabToPascalCase(tag: string): string {
  return tag
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function extractVueTemplateJsxOnLine(line: string, importedNames: ReadonlySet<string>): string {
  const tags: string[] = [];
  const tagRegex = /<([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Z][A-Za-z0-9_]*)*)\b((?:[^>"']|"[^"]*"|'[^']*')*)/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(line)) !== null) {
    const rawTag = match[1];
    const attrsRaw = match[2] ?? '';
    if (rawTag === 'component') {
      const isAttrMatch = attrsRaw.match(/(?::is|v-bind:is)\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      if (isAttrMatch) {
        const exprText = isAttrMatch[1] ?? isAttrMatch[2] ?? '';
        const identRe = /\b([A-Z][A-Za-z0-9_]*)\b/g;
        let idMatch: RegExpExecArray | null;
        while ((idMatch = identRe.exec(exprText)) !== null) {
          const cand = idMatch[1];
          if (importedNames.has(cand)) {
            tags.push(`<${cand} />`);
          }
        }
      }
      continue;
    }
    let resolvedTag: string | null = null;
    if (/^[A-Z]/.test(rawTag)) {
      resolvedTag = rawTag;
    } else if (rawTag.includes('-')) {
      const pascal = kebabToPascalCase(rawTag);
      if (importedNames.has(pascal)) {
        resolvedTag = pascal;
      }
    }
    if (!resolvedTag) continue;
    const attrs: string[] = [];
    const attrRegex = /(?:[:@]|v-bind:|v-on:)?([A-Za-z_$][A-Za-z0-9_$]*)=["{]([A-Za-z_$][A-Za-z0-9_$]*)["}]/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrsRaw)) !== null) {
      const valIdent = attrMatch[2];
      if (importedNames.has(valIdent)) {
        attrs.push(`${attrMatch[1].replace(/[^A-Za-z0-9_$]/g, '_')}={${valIdent}}`);
      }
    }
    const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
    tags.push(`<${resolvedTag}${attrStr} />`);
  }
  return tags.join('; ');
}

function extractSvelteTemplateJsxOnLine(line: string, importedNames: ReadonlySet<string>): string {
  const expressions: string[] = [];
  const emittedCalls = new Set<string>();

  // 1. `<svelte:component this={Comp} />`
  const dynCompRe = /<svelte:component\b[^>]*\bthis=\{([A-Z][A-Za-z0-9_]*)\}/g;
  let dynMatch: RegExpExecArray | null;
  while ((dynMatch = dynCompRe.exec(line)) !== null) {
    expressions.push(`<${dynMatch[1]} />`);
  }

  // 2. Capitalized Svelte component tags (`<ArticleCard {article} />`, `<Form.Input prop={val} />`)
  const tagRegex = /<([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\b((?:[^>"']|"[^"]*"|'[^']*')*)/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(line)) !== null) {
    const tagName = match[1];
    const attrsRaw = match[2] ?? '';
    const attrs: string[] = [];
    const attrRegex = /\b([A-Za-z_$][A-Za-z0-9_$]*)=\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrsRaw)) !== null) {
      if (importedNames.has(attrMatch[2])) {
        attrs.push(`${attrMatch[1]}={${attrMatch[2]}}`);
      }
    }
    const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
    expressions.push(`<${tagName}${attrStr} />`);
  }

  // 3. Svelte element directives (`use:enhance`, `transition:scale|local`, `in:fade`, `out:fly`, `animate:flip`)
  const dirRegex =
    /\b(?:use|transition|in|out|animate):([A-Za-z_$][A-Za-z0-9_$]*)(?:\|[A-Za-z0-9_|]+)?(?:=\{([A-Za-z_$][A-Za-z0-9_$]*)\})?/g;
  let dirMatch: RegExpExecArray | null;
  while ((dirMatch = dirRegex.exec(line)) !== null) {
    const fnName = dirMatch[1];
    const argIdent = dirMatch[2];
    if (importedNames.has(fnName) && !emittedCalls.has(fnName)) {
      emittedCalls.add(fnName);
      if (argIdent && importedNames.has(argIdent)) {
        expressions.push(`{${fnName}(${argIdent})}`);
      } else {
        expressions.push(`{${fnName}()}`);
      }
    }
  }

  // 4. Direct calls to imported helpers inside template expressions (`{formatDate(item.date)}`)
  const callRegex = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let callMatch: RegExpExecArray | null;
  while ((callMatch = callRegex.exec(line)) !== null) {
    const fnName = callMatch[1];
    if (importedNames.has(fnName) && !/^[A-Z]/.test(fnName) && !emittedCalls.has(fnName)) {
      emittedCalls.add(fnName);
      expressions.push(`{${fnName}()}`);
    }
  }

  return expressions.join('');
}

/**
 * Preprocesses `.astro`, `.mdx`, `.vue`, and `.svelte` source files into line-preserving TypeScript/TSX source text.
 *
 * - `.astro`: Preserves frontmatter (`--- ... ---`) statements at their original line numbers and
 *   wraps template JSX tags into `export default function __AstroComponent__() { return (<>...</>); }`.
 * - `.mdx`: Strips YAML frontmatter and fenced code blocks while preserving top-level `import`/`export`
 *   statements and wrapping rendered JSX tags into `export default function __MdxComponent__()`.
 * - `.vue`: Preserves `<script>` and `<script setup>` blocks at their original line numbers and wraps
 *   `<template>` component tags into `export default function __VueSfcComponent__() { return (<>...</>); }`.
 * - `.svelte`: Preserves `<script>` and `<script module>` blocks at their original line numbers, blanks
 *   `<style>` blocks, and wraps template component tags and directives into `export default function __SvelteComponent__()`.
 *
 * @param filePath - Path of the source file being parsed.
 * @param rawText  - Raw file contents on disk.
 * @returns Line-preserving valid TSX source string (or `rawText` unchanged for standard TS/JS files).
 *
 * @example
 * preprocessAstroOrMdxSource('src/routes/+page.svelte', '<script>import Nav from "./Nav.svelte";</script>\n<Nav />')
 */
export function preprocessAstroOrMdxSource(filePath: string, rawText: string): string {
  const lower = filePath.toLowerCase();
  if (
    !lower.endsWith('.astro') &&
    !lower.endsWith('.mdx') &&
    !lower.endsWith('.vue') &&
    !lower.endsWith('.svelte')
  ) {
    return rawText;
  }
  const lines = rawText.split(/\r?\n/);
  if (lower.endsWith('.svelte')) {
    const out: string[] = new Array(lines.length).fill('');
    const isCodeOrStyleLine = new Array<boolean>(lines.length).fill(false);
    let inScript = false;
    let inStyle = false;
    let inMultilineImport = false;
    const importedNames = new Set<string>();

    const collectImportIdents = (text: string) => {
      const withoutStrings = text.replace(/"[^"]*"|'[^']*'/g, ' ');
      for (const m of withoutStrings.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
        const tok = m[1];
        if (tok !== 'import' && tok !== 'from' && tok !== 'as' && tok !== 'type') {
          importedNames.add(tok);
        }
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (inStyle) {
        isCodeOrStyleLine[i] = true;
        if (/<\/style>/i.test(line)) {
          inStyle = false;
        }
        continue;
      }
      if (!inScript) {
        const styleOpen = line.match(/<style\b(?:[^>"']|"[^"]*"|'[^']*')*>/i);
        if (styleOpen) {
          isCodeOrStyleLine[i] = true;
          const afterStyle = line.slice((styleOpen.index ?? 0) + styleOpen[0].length);
          if (!/<\/style>/i.test(afterStyle)) {
            inStyle = true;
          }
          continue;
        }
        const openMatch = line.match(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>/i);
        if (openMatch) {
          isCodeOrStyleLine[i] = true;
          const afterOpen = line.slice((openMatch.index ?? 0) + openMatch[0].length);
          const closeMatch = afterOpen.match(/<\/script>/i);
          if (closeMatch) {
            const inner = afterOpen.slice(0, closeMatch.index ?? 0);
            out[i] = inner;
            if (/^\s*import\b/.test(inner)) collectImportIdents(inner);
          } else {
            inScript = true;
            out[i] = afterOpen.trim() ? afterOpen : '// <script>';
            if (/^\s*import\b/.test(afterOpen)) {
              collectImportIdents(afterOpen);
              if (!/\bfrom\s+['"]/.test(afterOpen) && !/;\s*$/.test(afterOpen)) {
                inMultilineImport = true;
              }
            }
          }
        }
      } else {
        isCodeOrStyleLine[i] = true;
        const closeMatch = line.match(/<\/script>/i);
        if (closeMatch) {
          const beforeClose = line.slice(0, closeMatch.index ?? 0);
          out[i] = beforeClose.trim() ? beforeClose : '// </script>';
          if (inMultilineImport || /^\s*import\b/.test(beforeClose)) {
            collectImportIdents(beforeClose);
          }
          inMultilineImport = false;
          inScript = false;
        } else {
          out[i] = line;
          if (inMultilineImport) {
            collectImportIdents(line);
            if (/\bfrom\s+['"]/.test(line) || /;\s*$/.test(line)) {
              inMultilineImport = false;
            }
          } else if (/^\s*import\b/.test(line)) {
            collectImportIdents(line);
            if (!/\bfrom\s+['"]/.test(line) && !/;\s*$/.test(line) && !/^\s*import\s+['"]/.test(line)) {
              inMultilineImport = true;
            }
          }
        }
      }
    }

    // Find template lines after the last `<script>` block so top-level script statements remain top-level.
    let lastScriptLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (out[i] !== '') lastScriptLine = i;
    }
    const templateIndices: number[] = [];
    for (let i = lastScriptLine + 1; i < lines.length; i++) {
      if (!isCodeOrStyleLine[i]) templateIndices.push(i);
    }

    const fnHeader = 'export default function __SvelteComponent__() { return (<>';
    if (templateIndices.length > 0) {
      const firstIdx = templateIndices[0];
      const lastIdx = templateIndices[templateIndices.length - 1];
      if (firstIdx === lastIdx) {
        const jsx = extractSvelteTemplateJsxOnLine(lines[firstIdx], importedNames);
        out[firstIdx] = `${fnHeader}${jsx}</>); }`;
      } else {
        out[firstIdx] = `${fnHeader}${extractSvelteTemplateJsxOnLine(lines[firstIdx], importedNames)}`;
        for (let k = 1; k < templateIndices.length - 1; k++) {
          const idxLine = templateIndices[k];
          out[idxLine] = extractSvelteTemplateJsxOnLine(lines[idxLine], importedNames);
        }
        out[lastIdx] = `${extractSvelteTemplateJsxOnLine(lines[lastIdx], importedNames)}</>); }`;
      }
    } else {
      const last = Math.max(0, lines.length - 1);
      out[last] = `${out[last]}${out[last] && !out[last].startsWith('//') ? '; ' : '\n'}export default function __SvelteComponent__() { return (<></>); }`;
    }
    return out.join('\n');
  }
  if (lower.endsWith('.vue')) {
    const out: string[] = new Array(lines.length).fill('');
    let inScript = false;
    let hasExportDefault = false;
    const importedNames = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inScript) {
        const openMatch = line.match(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>/i);
        if (openMatch) {
          const afterOpen = line.slice((openMatch.index ?? 0) + openMatch[0].length);
          const closeMatch = afterOpen.match(/<\/script>/i);
          if (closeMatch) {
            const inner = afterOpen.slice(0, closeMatch.index ?? 0);
            out[i] = inner;
            if (/\bexport\s+default\b/.test(inner)) hasExportDefault = true;
          } else {
            inScript = true;
            out[i] = afterOpen.trim() ? afterOpen : '// <script>';
            if (/\bexport\s+default\b/.test(afterOpen)) hasExportDefault = true;
          }
        }
      } else {
        const closeMatch = line.match(/<\/script>/i);
        if (closeMatch) {
          const beforeClose = line.slice(0, closeMatch.index ?? 0);
          out[i] = beforeClose.trim() ? beforeClose : '// </script>';
          if (/\bexport\s+default\b/.test(beforeClose)) hasExportDefault = true;
          inScript = false;
        } else {
          out[i] = line;
          if (/\bexport\s+default\b/.test(line)) hasExportDefault = true;
          const importIdentMatches = line.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g);
          if (/^\s*import\b/.test(line)) {
            for (const m of importIdentMatches) {
              if (m[1] !== 'import' && m[1] !== 'from' && m[1] !== 'as' && m[1] !== 'type') {
                importedNames.add(m[1]);
              }
            }
          }
        }
      }
    }

    // Locate top-level <template>...</template> range outside <script>
    let templateStart = -1;
    let templateEnd = -1;
    let templateDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      if (out[i] !== '') continue;
      const line = lines[i];
      const opens = (line.match(/<template\b[^>]*>/gi) ?? []).length;
      const closes = (line.match(/<\/template>/gi) ?? []).length;
      if (opens > 0 && templateDepth === 0 && templateStart === -1) {
        templateStart = i;
      }
      templateDepth += opens - closes;
      if (templateStart !== -1 && templateDepth <= 0 && closes > 0) {
        templateEnd = i;
        break;
      }
    }

    const fnHeader = hasExportDefault
      ? 'function __VueSfcTemplate__() { return (<>'
      : 'export default function __VueSfcComponent__() { return (<>';
    if (templateStart !== -1 && templateEnd !== -1 && templateEnd >= templateStart) {
      if (templateStart === templateEnd) {
        const jsx = extractVueTemplateJsxOnLine(lines[templateStart], importedNames);
        out[templateStart] = `${fnHeader}${jsx}</>); }`;
      } else {
        const firstJsx = extractVueTemplateJsxOnLine(lines[templateStart], importedNames);
        out[templateStart] = `${fnHeader}${firstJsx}`;
        for (let i = templateStart + 1; i < templateEnd; i++) {
          if (out[i] === '') {
            out[i] = extractVueTemplateJsxOnLine(lines[i], importedNames);
          }
        }
        const lastJsx = extractVueTemplateJsxOnLine(lines[templateEnd], importedNames);
        out[templateEnd] = `${lastJsx}</>); }`;
      }
    } else if (!hasExportDefault) {
      const last = Math.max(0, lines.length - 1);
      out[last] = `${out[last]}${out[last] && !out[last].startsWith('//') ? '; ' : '\n'}export default function __VueSfcComponent__() { return (<></>); }`;
    }
    return out.join('\n');
  }
  if (lower.endsWith('.astro')) {
    let firstIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '') {
        firstIdx = i;
        break;
      }
    }
    let closeIdx = -1;
    if (firstIdx !== -1 && lines[firstIdx].trim() === '---') {
      for (let i = firstIdx + 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
          closeIdx = i;
          break;
        }
      }
    }
    const out: string[] = new Array(lines.length).fill('');
    if (closeIdx !== -1) {
      out[firstIdx] = '// ---';
      for (let i = firstIdx + 1; i < closeIdx; i++) {
        out[i] = lines[i];
      }
      out[closeIdx] = 'export default function __AstroComponent__() { return (<>';
      for (let i = closeIdx + 1; i < lines.length; i++) {
        out[i] = extractTemplateJsxOnLine(lines[i]);
      }
      out[lines.length - 1] = `${out[lines.length - 1]}</>); }`;
    } else {
      const firstJsx = lines.length > 0 ? extractTemplateJsxOnLine(lines[0]) : '';
      out[0] = `export default function __AstroComponent__() { return (<>${firstJsx}`;
      for (let i = 1; i < lines.length; i++) {
        out[i] = extractTemplateJsxOnLine(lines[i]);
      }
      const last = Math.max(0, lines.length - 1);
      out[last] = `${out[last]}</>); }`;
    }
    return out.join('\n');
  }

  // .mdx preprocessing
  const out: string[] = new Array(lines.length).fill('');
  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === '') idx++;
  if (idx < lines.length && lines[idx].trim() === '---') {
    idx++;
    while (idx < lines.length && lines[idx].trim() !== '---') idx++;
    if (idx < lines.length && lines[idx].trim() === '---') idx++;
  }
  let inCodeFence = false;
  let hasImportOrExport = false;
  let lastImportExportLine = -1;
  let firstJsxLine = Number.POSITIVE_INFINITY;
  const jsxByLine = new Map<number, string>();
  for (let i = idx; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (
      /^(?:import|export)\s+.+/.test(trimmed) &&
      !trimmed.startsWith('export default') &&
      i < firstJsxLine
    ) {
      out[i] = lines[i];
      hasImportOrExport = true;
      lastImportExportLine = i;
      continue;
    }
    const jsx = extractTemplateJsxOnLine(lines[i]);
    if (jsx) {
      jsxByLine.set(i, jsx);
      if (i < firstJsxLine) firstJsxLine = i;
    }
  }
  const normPath = filePath.replace(/\\/g, '/');
  const isRouteMdx = /(?:^|\/)(?:src\/)?(?:pages|app|routes)\//i.test(normPath);
  if (!hasImportOrExport && !isRouteMdx) {
    return out.join('\n');
  }
  let opened = false;
  const startComponentLine = Math.max(idx, lastImportExportLine + 1);
  for (let i = startComponentLine; i < lines.length; i++) {
    if (out[i] !== '') continue;
    const jsx = jsxByLine.get(i) ?? '';
    if (!opened) {
      out[i] = `export default function __MdxComponent__() { return (<>${jsx}`;
      opened = true;
    } else {
      out[i] = jsx;
    }
  }
  const last = Math.max(0, lines.length - 1);
  if (!opened) {
    out[last] = `${out[last]}${out[last] ? '; ' : ''}export default function __MdxComponent__() { return (<></>); }`;
  } else {
    out[last] = `${out[last]}</>); }`;
  }
  return out.join('\n');
}
