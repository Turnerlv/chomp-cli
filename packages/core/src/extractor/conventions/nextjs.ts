// packages/core/src/extractor/conventions/nextjs.ts
//
// Next.js App Router conventions, as DATA. This replaces the hand-written matching that used to
// live in `adapters/nextjsAdapter.ts`; that file now only delegates to this table.
//
// To teach chomp a new Next.js convention: add a rule here, add (or extend) a fixture under
// `fixtures/test-repos/`, point `meta.fixture` at it. No visitor code.

import type { ConventionSet } from './types.js';

/** HTTP method names that make an exported symbol a Route Handler. */
const ROUTE_HANDLER_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

/** Route Segment Config export names (https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config). */
const ROUTE_SEGMENT_CONFIG_NAMES = ['dynamic', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration'] as const;

/** Next.js App Router page/layout lifecycle exports invoked by the framework runtime (`[PAT-EXT-24]`). */
export const NEXTJS_LIFECYCLE_EXPORTS = ['generateMetadata', 'generateStaticParams'] as const;

/**
 * Derives a Next.js route path from a file path.
 *
 * - Strips everything up to and including the first `app/` segment.
 * - Strips the trailing `page.<ext>` / `layout.<ext>` — including multi-segment extensions that the
 *   project enabled through `pageExtensions` (`page.dev.tsx`).
 * - Removes route-group segments (`(dashboard)`). Keeps dynamic segments (`[id]`).
 * - Returns `/` for the root.
 *
 * @example
 * routePath('app/(dashboard)/customers/page.tsx') // '/customers'
 * routePath('app/page.tsx')                       // '/'
 * routePath('app/products/[id]/page.tsx')         // '/products/[id]'
 * routePath('app/dashboard/page.dev.tsx')         // '/dashboard'
 */
export function nextjsRoutePath(relativeFilePath: string): string {
  const normalized = relativeFilePath.replace(/\\/g, '/');
  const afterApp = normalized.replace(/^.*?app\//, '');
  const withoutPage = afterApp.replace(/\/?(?:page|layout)(?:\.[A-Za-z0-9]+)+$/, '');
  const withoutGroups = withoutPage.replace(/\([^)]+\)\//g, '').replace(/\([^)]+\)$/, '');

  if (!withoutGroups || withoutGroups === '/') return '/';
  return '/' + withoutGroups.replace(/\/$/, '');
}

/**
 * Derives a Next.js layout scope path from a file path, preserving route-group segments
 * (`(auth)`, `(dashboard)`) so that multiple layouts at the same URL depth (`app/layout.tsx`,
 * `app/(auth)/layout.tsx`, `app/admin/layout.tsx`, `app/admin/(dashboard)/layout.tsx`) maintain
 * distinct contract identities and reflect their exact route-group hierarchy.
 */
export function nextjsLayoutPath(relativeFilePath: string): string {
  const normalized = relativeFilePath.replace(/\\/g, '/');
  const afterApp = normalized.replace(/^.*?app\//, '');
  const withoutLayout = afterApp
    .replace(/\/?(?:page|layout)(?:\.[A-Za-z0-9]+)+$/, '')
    .replace(/^\/+|\/+$/g, '');

  if (!withoutLayout) return '/';
  return '/' + withoutLayout;
}

export const NEXTJS_CONVENTIONS: ConventionSet = {
  framework: 'nextjs',

  // First match wins. Special files live under `app/`; `middleware` may sit anywhere in the project.
  fileRoles: [
    { role: 'ROUTE_HANDLER', fileName: 'route', under: 'app' },
    { role: 'PAGE', fileName: 'page', under: 'app' },
    { role: 'LAYOUT', fileName: 'layout', under: 'app' },
    { role: 'MIDDLEWARE', fileName: 'middleware', under: null },
  ],
  baseExtensions: ['ts', 'tsx', 'js', 'jsx'],
  // `pageExtensions: ['tsx', 'dev.tsx']` makes `page.dev.tsx` a page. Read statically ([PAT-EXT-24]).
  extensionConfig: {
    files: ['next.config.mjs', 'next.config.js', 'next.config.cjs', 'next.config.ts'],
    key: 'pageExtensions',
  },

  rules: [
    {
      id: 'nextjs.route-handler',
      roles: ['ROUTE_HANDLER'],
      match: [
        { kind: 'exportedFunction', names: ROUTE_HANDLER_METHODS },
        { kind: 'exportedDestructured', names: ROUTE_HANDLER_METHODS },
        { kind: 'exportedConst', names: ROUTE_HANDLER_METHODS },
      ],
      emit: {
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.nextjs-route-handler',
        name: 'Route Handler: {name}',
      },
      meta: {
        framework: 'nextjs',
        versions: '>=13.4',
        fixture: 'nextjs-app-router',
        specRef: 'PAT-EXT-24',
        description:
          'An exported HTTP-method function (or `export const { GET, POST } = handlers`) in `app/**/route.<ext>` is an HTTP endpoint.',
      },
    },
    {
      id: 'nextjs.page',
      roles: ['PAGE'],
      match: { kind: 'defaultExportedFunction', requireName: true },
      emit: {
        type: 'CONTRACT',
        entityType: 'NEXTJS_PAGE',
        patternId: 'boundary.nextjs-page-component',
        name: 'Next.js Page: {routePath}',
        metadata: { routePath: '{routePath}', componentName: '{componentName}' },
      },
      meta: {
        framework: 'nextjs',
        versions: '>=13.4',
        fixture: 'nextjs-app-router',
        specRef: 'PAT-EXT-24',
        description: 'The default-exported function of `app/**/page.<ext>` is the page for its route.',
      },
    },
    {
      id: 'nextjs.layout',
      roles: ['LAYOUT'],
      match: { kind: 'defaultExportedFunction', requireName: true },
      emit: {
        type: 'CONTRACT',
        entityType: 'NEXTJS_LAYOUT',
        patternId: 'boundary.nextjs-layout-component',
        name: 'Next.js Layout: {layoutPath}',
        metadata: { routePath: '{routePath}', layoutPath: '{layoutPath}', componentName: '{componentName}' },
      },
      meta: {
        framework: 'nextjs',
        versions: '>=13.4',
        fixture: 'nextjs-app-router',
        specRef: 'PAT-EXT-24',
        description: 'The default-exported function of `app/**/layout.<ext>` is the layout for its route segment.',
      },
    },
    {
      id: 'nextjs.lifecycle-export',
      roles: ['PAGE', 'LAYOUT'],
      match: [
        { kind: 'exportedFunction', names: NEXTJS_LIFECYCLE_EXPORTS },
        { kind: 'exportedConst', names: NEXTJS_LIFECYCLE_EXPORTS },
      ],
      emit: {
        type: 'CONTRACT',
        entityType: 'NEXTJS_PAGE',
        patternId: 'boundary.nextjs-page-component',
        name: 'Next.js Lifecycle: {name} ({routePath})',
        metadata: { routePath: '{routePath}', componentName: '{name}', flowRole: 'INGRESS' },
      },
      meta: {
        framework: 'nextjs',
        versions: '>=13.4',
        fixture: 'nextjs-app-router',
        specRef: 'PAT-EXT-24',
        description:
          'An exported `generateMetadata` or `generateStaticParams` function/const in `app/**/{page,layout}.<ext>` is a Next.js App Router lifecycle entry point.',
      },
    },
    {
      id: 'nextjs.middleware',
      roles: ['MIDDLEWARE'],
      match: [
        { kind: 'exportAlias', exportedName: 'middleware' },
        { kind: 'defaultExportedFunction', requireName: false },
      ],
      emit: {
        type: 'CONTRACT',
        entityType: 'NEXTJS_MIDDLEWARE',
        patternId: 'contract.nextjs-middleware-export',
        name: 'Next.js Middleware',
        metadata: { exportedAs: 'middleware', originalName: '{originalName}' },
      },
      meta: {
        framework: 'nextjs',
        fixture: 'nextjs-app-router',
        description: '`export { X as middleware }` or a default-exported function in `middleware.<ext>` is the request middleware.',
      },
    },
    {
      id: 'nextjs.route-segment-config',
      roles: ['PAGE', 'LAYOUT', 'ROUTE_HANDLER'],
      match: { kind: 'exportedConst', names: ROUTE_SEGMENT_CONFIG_NAMES },
      emit: {
        type: 'CONTRACT',
        entityType: 'NEXTJS_ROUTE_CONFIG',
        patternId: 'contract.nextjs-route-config',
        name: 'Next.js Config: {name}',
        metadata: { routePath: '{routePath}' },
      },
      meta: {
        framework: 'nextjs',
        fixture: 'nextjs-app-router',
        description: 'An exported route segment config constant (`dynamic`, `revalidate`, `runtime`, ...).',
      },
    },
    {
      id: 'nextjs.metadata',
      roles: ['PAGE', 'LAYOUT'],
      match: { kind: 'exportedConst', names: ['metadata'] },
      emit: {
        type: 'CONTRACT',
        entityType: 'NEXTJS_METADATA',
        patternId: 'contract.nextjs-metadata-export',
        name: 'Next.js Metadata',
        metadata: { routePath: '{routePath}' },
      },
      meta: {
        framework: 'nextjs',
        fixture: 'nextjs-app-router',
        description: '`export const metadata = { ... }` declares the segment metadata.',
      },
    },
    {
      id: 'nextjs.cache-invalidation',
      roles: null,
      match: { kind: 'callToIdentifier', names: ['revalidatePath', 'revalidateTag'] },
      emit: {
        type: 'OPEN_CONNECTOR',
        entityType: 'CACHE_INVALIDATION',
        patternId: 'open-connector.nextjs-revalidate-path',
        name: 'Next.js Cache: {name}()',
      },
      meta: {
        framework: 'nextjs',
        fixture: 'nextjs-drizzle',
        description: 'A call to `revalidatePath()` / `revalidateTag()` reaches beyond the code: the Next.js data cache.',
      },
    },
    {
      id: 'nextjs.server-action',
      roles: null,
      match: { kind: 'exportedFunction', names: '*', directive: 'use server' },
      emit: {
        type: 'CONTRACT',
        entityType: 'SERVER_ACTION',
        patternId: 'contract.server-action',
        name: 'Server Action: {name}',
      },
      meta: {
        framework: 'nextjs',
        versions: '>=14',
        fixture: 'nextjs-app-router',
        description:
          "An exported function under a file-level or function-level 'use server' directive is a Server Action: callable from the client, executed on the server.",
      },
    },
  ],

  edgeRules: [
    {
      id: 'nextjs.dynamic-component-render',
      match: { kind: 'jsxComponentElement', tagSyntax: 'identifier' },
      target: ['nextDynamicComponent'],
      emit: {
        entityType: 'RENDERS',
        patternId: 'relationship.jsx-element.next-dynamic',
        name: 'Renders: <{tagName} />',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'nextjs',
        fixture: 'react-hoc-components',
        specRef: 'PAT-EXT-25',
        description:
          'A JSX element whose tag is bound via Next.js `dynamic(() => import(...))` renders the target component contract.',
      },
    },
  ],

  derivers: { routePath: nextjsRoutePath, layoutPath: nextjsLayoutPath },

  // Every Next.js convention is now expressible in the table.
  escapeHatches: [],
};
