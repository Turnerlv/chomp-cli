// packages/core/src/extractor/conventions/config.ts
//
// Reads the framework-owned config that extends a convention (Next.js `pageExtensions`) —
// STATICALLY, never by executing the project's config.
//
// Principle of Incomplete Truth: only a literal array of string literals is accepted. A computed
// value (spread, variable, function call, import) is an honest unknown — it is recorded in
// `unresolved` and never guessed, so a later coverage warning can say "config present but not
// statically readable".
//
// A resolver is created per `analyzeTarget` run, so its cache can never outlive the files it read
// (a long-lived MCP server re-analyses the same directory after edits).

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { ConventionSet, ExtensionConfigSource } from './types.js';

export interface UnresolvedConfig {
  framework: string;
  /** Path of the config file, relative to the analysed root. */
  file: string;
  key: string;
  reason: 'not-a-literal-array';
}

export interface ConventionConfigResolver {
  /** Extra extensions enabled for the framework in the project owning `absoluteFilePath`. */
  extensionsFor(set: ConventionSet, absoluteFilePath: string): readonly string[];
  /** Configs that exist but could not be read statically (an honest unknown). */
  readonly unresolved: readonly UnresolvedConfig[];
}

type ParsedConfig = { extensions: string[] } | { unresolved: true };

function propertyKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** Finds `key: [...]` anywhere in the config AST. Returns null when the key is absent. */
function readStringArrayProperty(sourceFile: ts.SourceFile, key: string): ParsedConfig | null {
  let found: ParsedConfig | null = null;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node) && propertyKeyName(node.name) === key) {
      const init = node.initializer;
      if (ts.isArrayLiteralExpression(init) && init.elements.every((e) => ts.isStringLiteralLike(e))) {
        found = { extensions: init.elements.map((e) => (e as ts.StringLiteralLike).text) };
      } else {
        found = { unresolved: true };
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function createConventionConfigResolver(repoRoot: string): ConventionConfigResolver {
  const root = path.resolve(repoRoot);
  const unresolved: UnresolvedConfig[] = [];
  // dir → parsed config of the nearest config file at or above it (null = none up to the root)
  const nearest = new Map<string, { file: string; parsed: ParsedConfig | null } | null>();

  const findNearest = (
    dir: string,
    source: ExtensionConfigSource,
    framework: string
  ): { file: string; parsed: ParsedConfig | null } | null => {
    const cacheKey = `${framework}\0${dir}`;
    if (nearest.has(cacheKey)) return nearest.get(cacheKey)!;

    let result: { file: string; parsed: ParsedConfig | null } | null = null;
    for (const name of source.files) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const text = fs.readFileSync(candidate, 'utf8');
        const sf = ts.createSourceFile(candidate, text, ts.ScriptTarget.Latest, true);
        const parsed = readStringArrayProperty(sf, source.key);
        result = { file: candidate, parsed };
        if (parsed && 'unresolved' in parsed) {
          unresolved.push({
            framework,
            file: path.relative(root, candidate) || candidate,
            key: source.key,
            reason: 'not-a-literal-array',
          });
        }
        break;
      }
    }

    if (!result && dir !== root && dir !== path.dirname(dir)) {
      result = findNearest(path.dirname(dir), source, framework);
    }
    nearest.set(cacheKey, result);
    return result;
  };

  return {
    extensionsFor(set, absoluteFilePath) {
      if (!set.extensionConfig) return [];
      const found = findNearest(path.dirname(path.resolve(absoluteFilePath)), set.extensionConfig, set.framework);
      if (!found?.parsed || 'unresolved' in found.parsed) return [];
      return found.parsed.extensions.filter((e) => !set.baseExtensions.includes(e));
    },
    get unresolved() {
      return unresolved;
    },
  };
}

/**
 * Loads optional user-defined `ConventionSet` entries from `chomp.config.json` (`conventions` key)
 * at `repoRoot`. Returns `[]` when `chomp.config.json` is absent or declares no `conventions`.
 */
export function loadUserConventionSets(repoRoot: string): ConventionSet[] {
  const configPath = path.join(path.resolve(repoRoot), 'chomp.config.json');
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw || !Array.isArray(raw.conventions)) return [];
    const sets: ConventionSet[] = [];
    for (const item of raw.conventions) {
      if (!item || typeof item !== 'object') continue;
      if (!Array.isArray(item.rules) && !Array.isArray(item.edgeRules)) continue;
      const framework = typeof item.framework === 'string' && item.framework.trim() ? item.framework.trim() : 'user';
      const rawRules = Array.isArray(item.rules) ? item.rules : [];
      const rawEdgeRules = Array.isArray(item.edgeRules) ? item.edgeRules : undefined;
      sets.push({
        framework,
        fileRoles: Array.isArray(item.fileRoles) ? item.fileRoles : [],
        baseExtensions: Array.isArray(item.baseExtensions) ? item.baseExtensions : ['ts', 'tsx', 'js', 'jsx'],
        ...(item.extensionConfig ? { extensionConfig: item.extensionConfig } : {}),
        rules: rawRules.map((r: any) => ({
          ...r,
          roles: r.roles ?? null,
          meta: {
            framework,
            fixture: r.meta?.fixture ?? 'chomp.config.json',
            description: r.meta?.description ?? r.id,
            ...(r.meta?.versions ? { versions: r.meta.versions } : {}),
            ...(r.meta?.specRef ? { specRef: r.meta.specRef } : {}),
          },
        })),
        ...(rawEdgeRules
          ? {
              edgeRules: rawEdgeRules.map((er: any) => ({
                ...er,
                meta: {
                  framework,
                  fixture: er.meta?.fixture ?? 'chomp.config.json',
                  description: er.meta?.description ?? er.id,
                  ...(er.meta?.versions ? { versions: er.meta.versions } : {}),
                  ...(er.meta?.specRef ? { specRef: er.meta.specRef } : {}),
                },
              })),
            }
          : {}),
        derivers: {},
        escapeHatches: [],
      });
    }
    return sets;
  } catch {
    return [];
  }
}
