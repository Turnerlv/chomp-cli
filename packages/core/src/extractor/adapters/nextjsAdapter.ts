// packages/core/src/extractor/adapters/nextjsAdapter.ts
// Framework-specific adapter for Next.js App Router conventions.
//
// The conventions themselves are DATA — see `../conventions/nextjs.ts` (file roles, AST forms and
// output templates) interpreted by `../conventions/engine.ts`. This file keeps the long-standing
// function signatures the visitors call, and delegates to the table. Every Next.js convention,
// including Server Actions (a directive predicate in the engine), now lives in that table.
//
// Structural patterns handled:
//   - File-path classification (route.ts → ROUTE_HANDLER, page.tsx → PAGE, middleware.ts → MIDDLEWARE),
//     including project-configured `pageExtensions` (`page.dev.tsx`)
//   - Route Handler contracts (exported GET/POST/PUT/DELETE/PATCH in route.ts files)
//   - Page / layout components (default-exported components in page.tsx / layout.tsx files)
//   - Middleware export contracts (export { X as middleware } in middleware.ts)
//   - Route segment config, metadata export, cache invalidation calls
//   - Server Actions

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { NEXTJS_CONVENTIONS } from '../conventions/nextjs.js';
import {
  applyConventionRules,
  classifyFileRole,
  type ClassifyFileRoleOptions,
} from '../conventions/engine.js';

/**
 * The structural role a Next.js file plays based on its path convention.
 * Null means the file has no special Next.js App Router role.
 */
export type NextjsFileRole = 'ROUTE_HANDLER' | 'PAGE' | 'LAYOUT' | 'MIDDLEWARE';

/**
 * Scans repository-relative file paths for underscore-prefixed App Router subtrees (`app/_<seg>/...`)
 * that host an explicit multi-route hierarchy (`>= 2` `page.<ext>` / `layout.<ext>` files with at
 * least one nested route segment, such as `app/_hooks/layout.tsx` + `app/_hooks/[section]/page.tsx`).
 * Single stray files like `app/_components/page.tsx` are NOT included.
 */
export function collectRoutedUnderscorePrefixes(
  relativeFilePaths: readonly string[]
): ReadonlySet<string> {
  const stats = new Map<string, { routeFiles: number; hasNestedPage: boolean }>();
  for (const rawRel of relativeFilePaths) {
    const norm = rawRel.replace(/\\/g, '/');
    const m = /(?:^|\/)app\/(_[^/]+)\/(.*\/)?(page|layout)\.[A-Za-z0-9.]+$/.exec(norm);
    if (!m) continue;
    const topUnderscore = m[1];
    const nestedDir = m[2] ?? '';
    if (
      nestedDir
        .split('/')
        .filter(Boolean)
        .some((seg) => seg.startsWith('_'))
    ) {
      continue;
    }
    const key = `app/${topUnderscore}`;
    const cur = stats.get(key) ?? { routeFiles: 0, hasNestedPage: false };
    cur.routeFiles += 1;
    if (nestedDir.length > 0 && m[3] === 'page') {
      cur.hasNestedPage = true;
    }
    stats.set(key, cur);
  }
  const result = new Set<string>();
  for (const [key, s] of stats.entries()) {
    if (s.routeFiles >= 2 && s.hasNestedPage) {
      result.add(key);
    }
  }
  return result;
}

/**
 * Classifies a file path into its Next.js App Router structural role.
 *
 *   app/** /route.ts(x)  -> ROUTE_HANDLER
 *   app/** /page.ts(x)   -> PAGE
 *   app/** /layout.ts(x) -> LAYOUT
 *   middleware.ts(x) at the project root level -> MIDDLEWARE
 *
 * @param filePath             The relative file path (relative to cwd or repo root).
 * @param configuredExtensions Extra extensions the project enabled via `pageExtensions` in its
 *                             `next.config.*` (e.g. `dev.tsx` makes `page.dev.tsx` a page).
 * @param options              Optional version/subtree context for pre-13.4 or multi-route `_` subtrees.
 * @returns The structural role, or null if the file has no special Next.js role.
 */
export function classifyNextjsFile(
  filePath: string,
  configuredExtensions: readonly string[] = [],
  options?: ClassifyFileRoleOptions
): NextjsFileRole | null {
  return classifyFileRole(
    NEXTJS_CONVENTIONS,
    filePath,
    configuredExtensions,
    options
  ) as NextjsFileRole | null;
}

type Evidence = (node: ts.Node) => EvidenceRecord;

/** Applies the named convention rules of this adapter's set to one node. */
function apply(
  ruleIds: readonly string[],
  node: ts.Node,
  fileRole: NextjsFileRole | null,
  filePath: string,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] {
  return applyConventionRules(NEXTJS_CONVENTIONS, ruleIds, node, fileRole, filePath, getEvidence, nextId);
}

/**
 * Extracts Next.js Route Handler contracts from a node in a `route.ts` file.
 * Both `export async function GET() {}` and `export const { GET, POST } = handlers` produce one
 * CONTRACT per exported HTTP method.
 */
export function extractNextjsRouteHandlerContracts(
  node: ts.Node,
  fileRole: NextjsFileRole | null,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] | null {
  const results = apply(['nextjs.route-handler'], node, fileRole, '', getEvidence, nextId);
  return results.length > 0 ? results : null;
}

/**
 * Extracts a Next.js Page component as a CONTRACT (v4: not a boundary) from a `page.tsx` file.
 * The route path is derived from the file path (see `nextjsRoutePath`).
 */
export function extractNextjsPageBoundary(
  node: ts.Node,
  fileRole: NextjsFileRole | null,
  filePath: string,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return apply(['nextjs.page'], node, fileRole, filePath, getEvidence, nextId)[0] ?? null;
}

/**
 * Extracts a Next.js middleware export as a CONTRACT from a `middleware.ts` file:
 * `export { auth as middleware }` or `export default function middleware(...)`.
 */
export function extractNextjsMiddlewareExport(
  node: ts.Node,
  fileRole: NextjsFileRole | null,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return apply(['nextjs.middleware'], node, fileRole, '', getEvidence, nextId)[0] ?? null;
}

/** Extracts Next.js cache invalidation calls (`revalidatePath()` / `revalidateTag()`). */
export function extractNextjsRevalidate(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return apply(['nextjs.cache-invalidation'], node, null, '', getEvidence, nextId)[0] ?? null;
}

/** Extracts a Next.js Layout component as a CONTRACT (v4: not a boundary) from a `layout.tsx` file. */
export function extractNextjsLayoutBoundary(
  node: ts.Node,
  fileRole: NextjsFileRole | null,
  filePath: string,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return apply(['nextjs.layout'], node, fileRole, filePath, getEvidence, nextId)[0] ?? null;
}

/**
 * Extracts Next.js App Router lifecycle contracts (`generateMetadata`, `generateStaticParams`)
 * from `page.<ext>` and `layout.<ext>` files (`[PAT-EXT-24]`).
 */
export function extractNextjsLifecycleContracts(
  node: ts.Node,
  fileRole: NextjsFileRole | null,
  filePath: string,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity[] | null {
  const results = apply(['nextjs.lifecycle-export'], node, fileRole, filePath, getEvidence, nextId);
  return results.length > 0 ? results : null;
}

/** Extracts Next.js Route Segment Configs as CONTRACTs. Matches: `export const dynamic = 'force-dynamic'`. */
export function extractNextjsRouteConfig(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string,
  fileRole: NextjsFileRole | null = 'PAGE',
  filePath: string = ''
): StructuralEntity[] | null {
  const results = apply(['nextjs.route-segment-config'], node, fileRole, filePath, getEvidence, nextId);
  return results.length > 0 ? results : null;
}

/** Extracts the Next.js metadata export as a CONTRACT: `export const metadata = { ... }`. */
export function extractNextjsMetadataExport(
  node: ts.Node,
  getEvidence: Evidence,
  nextId: () => string,
  fileRole: NextjsFileRole | null = 'PAGE',
  filePath: string = ''
): StructuralEntity | null {
  return apply(['nextjs.metadata'], node, fileRole, filePath, getEvidence, nextId)[0] ?? null;
}

/**
 * Extracts Next.js Server Actions as a CONTRACT: an exported function under a file-level or
 * function-level `'use server'` directive (the `nextjs.server-action` rule — the directive
 * predicate lives in the engine). `sourceFile` is unused; the engine reads it from the node.
 */
export function extractNextjsServerActions(
  node: ts.Node,
  _sourceFile: ts.SourceFile,
  getEvidence: Evidence,
  nextId: () => string
): StructuralEntity | null {
  return apply(['nextjs.server-action'], node, null, '', getEvidence, nextId)[0] ?? null;
}
