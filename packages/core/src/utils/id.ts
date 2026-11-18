/**
 * @fileoverview Deterministic entity hashing and logical boundary scope resolution (Layer 0).
 *
 * Implements the Catalyst Hash Invariant ([PAT-EXT-06], [PAT-EXT-19]):
 * `BOUNDARY` and `CONTRACT` SHA-256 coordinates are derived from
 * `(logicalBoundaryScope, entityType, canonicalName)` rather than physical `filePath`,
 * ensuring that moving a contract or class between files within the same logical
 * `DEPLOYMENT_UNIT` or `NAMESPACE` preserves its identity across Layer 1/2/3 attachments.
 *
 * @module @chomp/core/utils/id
 */

import { createHash } from 'crypto';
import path from 'path';
import ts from 'typescript';
import {
  resolveBoundaryForFile,
  type WorkspaceRegistry,
} from '../extractor/workspaceResolver.js';

/**
 * Produces a deterministic, stable 12-char hex ID for a structural entity.
 *
 * Under the Catalyst Hash Invariant ([PAT-EXT-06], [PAT-EXT-19]), `BOUNDARY` and `CONTRACT`
 * identities are derived from `(logicalBoundaryScope, entityType, canonicalName)` rather than
 * physical `filePath`. Moving a contract or class between files inside the same
 * `DEPLOYMENT_UNIT` / `NAMESPACE` preserves its SHA-256 ID so attached metadata
 * (`chomp_enrich_nodes`), saved views, and Layer 1/2/3 links do not break on file reorganization.
 *
 * Formula: `SHA-256("${entityType}:${logicalBoundaryScope}:${canonicalName}").slice(0, 12)`
 *
 * Collision risk is negligible at 12 hex chars (48 bits of hash space) for the expected
 * entity counts of any single repository analysis run.
 *
 * @param logicalBoundaryScope Logical boundary scope (e.g. `@chomp/core`, `@chomp/core::Namespace: Utils`,
 *                             or relationship/connector scope key).
 * @param entityType           Primitive category (`BOUNDARY` | `CONTRACT` | `RELATIONSHIP` | `OPEN_CONNECTOR`).
 * @param canonicalName        Canonical entity name (e.g. `Exported Function: analyzeTarget`).
 * @returns Deterministic 12-character lowercase hexadecimal SHA-256 prefix.
 */
export function stableEntityId(
  logicalBoundaryScope: string,
  entityType: string,
  canonicalName: string
): string {
  return createHash('sha256')
    .update(`${entityType}:${logicalBoundaryScope}:${canonicalName}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Produces a deterministic 12-char hex ID for a CommonJS export contract (`contract.commonjs-export`),
 * scoping by `(logicalBoundaryScope, normalizedRelativePath, canonicalName)` so CommonJS modules
 * in the same deployment unit that export identically named prototype methods (`set`, `get`, `render`,
 * `default`) do not collide.
 */
export function cjsContractEntityId(
  logicalBoundaryScope: string,
  relativeFilePath: string,
  canonicalName: string
): string {
  const normRel = relativeFilePath.replace(/\\/g, '/');
  return stableEntityId(`${logicalBoundaryScope}::${normRel}`, 'CONTRACT', canonicalName);
}

let activeCollidingContractKeys: ReadonlySet<string> | null = null;
let activeCollidingBoundaryKeys: ReadonlySet<string> | null = null;

/**
 * Sets or clears the per-analysis-run set of `(logicalBoundaryScope::canonicalName)` keys that
 * appear in `>= 2` distinct files within the same logical boundary scope.
 *
 * Contracts whose `(logicalBoundaryScope, canonicalName)` is unique within the boundary keep
 * their file-independent Catalyst Hash (`[PAT-EXT-19]`), while multi-file same-name contracts
 * in the same boundary are disambiguated by `relativeFilePath` so they never collide.
 */
export function setActiveCollidingContractKeys(keys: ReadonlySet<string> | null): void {
  activeCollidingContractKeys = keys;
}

/**
 * Sets or clears the per-analysis-run set of `(logicalBoundaryScope::canonicalName)` keys for
 * `CLASS` / `NAMESPACE` boundaries that appear in `>= 2` distinct files within the same logical
 * boundary scope.
 */
export function setActiveCollidingBoundaryKeys(keys: ReadonlySet<string> | null): void {
  activeCollidingBoundaryKeys = keys;
}

/**
 * Produces a deterministic 12-char hex ID for a `CLASS` or `NAMESPACE` `BOUNDARY` entity.
 * Unique `(logicalBoundaryScope, canonicalName)` boundaries keep their file-independent hash,
 * while same-named classes/namespaces across multiple files in the same deployment unit are
 * disambiguated by `relativeFilePath` so they never collide.
 */
export function boundaryEntityId(
  logicalBoundaryScope: string,
  relativeFilePath: string,
  canonicalName: string
): string {
  if (activeCollidingBoundaryKeys?.has(`${logicalBoundaryScope}::${canonicalName}`)) {
    const normRel = relativeFilePath.replace(/\\/g, '/');
    return stableEntityId(`${logicalBoundaryScope}::${normRel}`, 'BOUNDARY', canonicalName);
  }
  return stableEntityId(logicalBoundaryScope, 'BOUNDARY', canonicalName);
}

/**
 * Produces a deterministic 12-char hex ID for a `CONTRACT` entity.
 * File-anonymous or CommonJS module contracts (`contract.commonjs-export`, `contract.es6-export-default`,
 * `Module Export (Default)`) and multi-file colliding contracts within the same boundary are scoped by
 * `(logicalBoundaryScope, normalizedRelativePath, canonicalName)` so distinct contracts across multiple
 * files in the same deployment unit never collide.
 */
export function contractEntityId(
  logicalBoundaryScope: string,
  relativeFilePath: string,
  canonicalName: string,
  patternId?: string
): string {
  if (
    patternId === 'contract.commonjs-export' ||
    patternId === 'contract.es6-export-default' ||
    patternId === 'contract.express-route' ||
    patternId === 'boundary.express-middleware' ||
    patternId === 'contract.define-property' ||
    patternId === 'contract.nextjs-route-handler' ||
    patternId === 'contract.nextjs-metadata-export' ||
    patternId === 'contract.nextjs-route-config' ||
    canonicalName === 'Module Export (Default)' ||
    patternId === 'contract.vue-sfc-script-setup' ||
    patternId === 'contract.astro-api-route-handler' ||
    patternId === 'contract.astro-get-static-paths-lifecycle' ||
    patternId === 'contract.astro-svg-component-import' ||
    patternId === 'contract.svelte-sfc-and-sveltekit-hooks' ||
    canonicalName.startsWith('Vue Component: ') ||
    canonicalName.startsWith('Svelte Component: ') ||
    canonicalName.startsWith('Svg Component: ') ||
    canonicalName.startsWith('Astro Lifecycle: ') ||
    canonicalName.startsWith('SvelteKit Load: ') ||
    canonicalName.startsWith('SvelteKit Layout Load: ') ||
    canonicalName.startsWith('SvelteKit Actions: ') ||
    canonicalName.startsWith('SvelteKit Hook: ') ||
    canonicalName.startsWith('Express Route: ') ||
    canonicalName.startsWith('Middleware: ') ||
    canonicalName.startsWith('Property Getter: ') ||
    canonicalName.startsWith('Route Handler: ') ||
    canonicalName === 'Next.js Metadata' ||
    canonicalName.startsWith('Next.js Metadata: ') ||
    canonicalName.startsWith('Next.js Config: ') ||
    activeCollidingContractKeys?.has(`${logicalBoundaryScope}::${canonicalName}`)
  ) {
    return cjsContractEntityId(logicalBoundaryScope, relativeFilePath, canonicalName);
  }
  return stableEntityId(logicalBoundaryScope, 'CONTRACT', canonicalName);
}

/**
 * Computes a fast, deterministic 8-character SHA-256 hex digest over one or more AST nodes'
 * whitespace-normalized source text (a contract's declaration + any bridged module-private helpers).
 *
 * Used by `compareGraphs` to detect internal implementation changes inside a contract without
 * storing full source bodies or rendering hashes in the UI.
 */
export function computeAstBodyHash(
  entries: Array<{ sourceFile: ts.SourceFile; node: ts.Node }>
): string {
  const hash = createHash('sha256');
  for (const { sourceFile, node } of entries) {
    hash.update(node.getText(sourceFile).replace(/\s+/g, ' ').trim());
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 8);
}

/**
 * Combines a deployment unit label with an optional enclosing `NAMESPACE` chain.
 *
 * @param deploymentUnitLabel Owning deployment unit label (e.g. `@chomp/core` or `sample-app`).
 * @param enclosingNamespace  Optional `::`-delimited enclosing namespace chain (e.g. `Namespace: Utils`).
 * @returns Canonical logical boundary scope string.
 */
export function formatLogicalBoundaryScope(
  deploymentUnitLabel: string,
  enclosingNamespace?: string | null
): string {
  return enclosingNamespace
    ? `${deploymentUnitLabel}::${enclosingNamespace}`
    : deploymentUnitLabel;
}

/**
 * Walks the AST parent chain of `node` to collect any enclosing `ts.ModuleDeclaration`
 * (`namespace X {}` / `module X {}`) boundaries from outermost to innermost.
 *
 * @param node The AST node whose enclosing namespace chain should be inspected.
 * @returns `::`-delimited namespace chain (e.g. `Namespace: Outer::Namespace: Inner`), or `undefined`.
 */
export function findEnclosingNamespaceScope(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  const namespaces: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && current.name) {
      if (
        (current.flags & ts.NodeFlags.GlobalAugmentation) !== 0 ||
        (ts.isIdentifier(current.name) && current.name.text === 'global') ||
        ts.isStringLiteral(current.name) ||
        current.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
      ) {
        continue;
      }
      namespaces.unshift(`Namespace: ${current.name.text}`);
    }
  }
  return namespaces.length > 0 ? namespaces.join('::') : undefined;
}

/**
 * Resolves the logical boundary scope (`DEPLOYMENT_UNIT` label + optional `NAMESPACE` scope)
 * that owns a source file path, independent of the physical file path within that unit.
 *
 * @param filePath           Absolute or repo-relative path to the source file.
 * @param repoRoot           Absolute path to the repository / analysis root directory.
 * @param workspaceRegistry  Optional monorepo workspace package registry (`pkgName -> absPkgPath`).
 * @param enclosingNamespace Optional enclosing `NAMESPACE` chain from {@link findEnclosingNamespaceScope}.
 * @returns Canonical logical boundary scope string for hashing `BOUNDARY` and `CONTRACT` nodes.
 */
export function resolveLogicalBoundaryScope(
  filePath: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  enclosingNamespace?: string | null
): string {
  const fallbackLabel = repoRoot ? path.basename(repoRoot) : 'default';
  const resolved = resolveBoundaryForFile(
    filePath,
    repoRoot || process.cwd(),
    workspaceRegistry,
    fallbackLabel
  );

  return formatLogicalBoundaryScope(resolved.label, enclosingNamespace);
}
