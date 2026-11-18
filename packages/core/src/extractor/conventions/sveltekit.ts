// packages/core/src/extractor/conventions/sveltekit.ts
//
// Svelte Single-File Component (`.svelte`) & SvelteKit routing/hook conventions, as DATA
// (`[PAT-EXT-28]`, `[PAT-EXT-76]`).
//
// Covers:
// - `+page.server.*` / `+page.*` `load` functions and `+page.server.*` `actions` maps
// - `+layout.server.*` / `+layout.*` `load` functions
// - `+server.*` HTTP endpoint handlers (`GET`, `POST`, ..., `fallback`)
// - `hooks.server.*` / `hooks.client.*` / `src/hooks.*` framework hooks (`handle`, `handleFetch`, `handleError`, `init`, `reroute`, `transport`)

import type { ConventionSet } from './types.js';

/** HTTP method and fallback exports recognized in SvelteKit `+server.<ext>` endpoints. */
export const SVELTEKIT_ENDPOINT_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'fallback',
] as const;

/** SvelteKit server/client/universal hook export names (`https://svelte.dev/docs/kit/hooks`). */
export const SVELTEKIT_HOOK_EXPORTS = [
  'handle',
  'handleFetch',
  'handleError',
  'init',
  'reroute',
  'transport',
] as const;

/**
 * Derives a SvelteKit URL route path from a repository-relative file path under `routes/` or `src/routes/`.
 *
 * Strips trailing `+page`, `+page.server`, `+layout`, `+layout.server`, `+server`, or `+error`
 * filenames (including `@named` layout resets) and route-group segments (`(authed)`), preserving
 * dynamic (`[slug]`, `[[optional]]`, `[...rest]`) segments.
 *
 * @param relativeFilePath - Repository-relative path of the SvelteKit route file.
 * @returns Normalized URL route path starting with `/`.
 *
 * @example
 * sveltekitRoutePath('src/routes/+page.server.ts')                  // '/'
 * sveltekitRoutePath('src/routes/(app)/editor/[slug]/+page.svelte') // '/editor/[slug]'
 * sveltekitRoutePath('src/routes/api/ping/+server.ts')              // '/api/ping'
 */
export function sveltekitRoutePath(relativeFilePath: string): string {
  const normalized = relativeFilePath.replace(/\\/g, '/');
  const afterRoutes = normalized.replace(/^(?:.*?\/)?routes\//, '');
  const withoutLeaf = afterRoutes.replace(
    /(?:^|\/)\+(?:page(?:\.server)?|layout(?:\.server)?|server|error)(?:@[A-Za-z0-9_-]*)?(?:\.[A-Za-z0-9]+)+$/,
    ''
  );
  const withoutGroups = withoutLeaf.replace(/\([^)]+\)\//g, '').replace(/\([^)]+\)$/, '');
  const trimmed = withoutGroups.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '/';
  return '/' + trimmed;
}

/**
 * Derives a SvelteKit layout scope path from a repository-relative file path, preserving
 * route-group segments (`(authed)`) so multiple `+layout.server.ts` files at the same URL depth
 * remain distinct contracts.
 *
 * @param relativeFilePath - Repository-relative path of the SvelteKit layout file.
 * @returns Layout scope path starting with `/`.
 *
 * @example
 * sveltekitLayoutPath('src/routes/+layout.server.ts')          // '/'
 * sveltekitLayoutPath('src/routes/(authed)/+layout.server.ts') // '/(authed)'
 */
export function sveltekitLayoutPath(relativeFilePath: string): string {
  const normalized = relativeFilePath.replace(/\\/g, '/');
  const afterRoutes = normalized.replace(/^(?:.*?\/)?routes\//, '');
  const withoutLeaf = afterRoutes
    .replace(
      /(?:^|\/)\+(?:layout(?:\.server)?|page(?:\.server)?)(?:@[A-Za-z0-9_-]*)?(?:\.[A-Za-z0-9]+)+$/,
      ''
    )
    .replace(/^\/+|\/+$/g, '');
  if (!withoutLeaf) return '/';
  return '/' + withoutLeaf;
}

/**
 * Derives a deterministic PascalCase Svelte component contract name (`Svelte Component: <PascalName>`)
 * from a `.svelte` Single-File Component path (`[PAT-EXT-76]`).
 *
 * For SvelteKit route files (`+page.svelte`, `+layout.svelte`, `+error.svelte`), walks up to the
 * enclosing non-stop route directory segment when present (e.g. `src/routes/+page.svelte` ->
 * `Svelte Component: Page`, `src/routes/login/+page.svelte` -> `Svelte Component: LoginPage`).
 *
 * @param filePath - Relative or absolute path of the `.svelte` file.
 * @returns Canonical contract name (`Svelte Component: <PascalName>`).
 *
 * @example
 * deriveSvelteComponentName('src/lib/ArticleCard.svelte')     // 'Svelte Component: ArticleCard'
 * deriveSvelteComponentName('src/routes/+page.svelte')        // 'Svelte Component: Page'
 * deriveSvelteComponentName('src/routes/login/+page.svelte')  // 'Svelte Component: LoginPage'
 */
export function deriveSvelteComponentName(filePath?: string): string {
  const norm = (filePath ?? '').replace(/\\/g, '/').trim();
  if (!norm) return 'Svelte Component: AnonymousComponent';
  const withoutExt = norm.replace(/\.svelte$/i, '');
  const rawSegments = withoutExt.split('/').filter(Boolean);
  const STOP_DIRS = new Set(['routes', 'pages', 'components', 'layouts', 'views', 'app', 'src', 'lib']);
  const pickedTokens: string[] = [];

  for (let i = rawSegments.length - 1; i >= 0; i--) {
    const seg = rawSegments[i];
    if (seg.toLowerCase() === 'index') continue;
    if (STOP_DIRS.has(seg.toLowerCase()) && pickedTokens.length > 0) break;
    if (seg.startsWith('(') && seg.endsWith(')')) continue;

    const withoutNamedReset = seg.startsWith('+') ? seg.replace(/@[A-Za-z0-9_-]*$/, '') : seg;
    const cleaned = withoutNamedReset
      .replace(/^[+@]+/, '')
      .replace(/^\[+|\.+|\]+$/g, '')
      .replace(/[\[\]@]/g, '');
    if (!cleaned) continue;
    pickedTokens.unshift(cleaned);
    const isRouteLeafOrDynamic =
      seg.startsWith('+') || seg.startsWith('[') || seg.startsWith('@[');
    if (!isRouteLeafOrDynamic) break;
  }

  const combined = pickedTokens.length > 0 ? pickedTokens.join('-') : 'AnonymousComponent';
  const pascal = combined
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `Svelte Component: ${pascal || 'AnonymousComponent'}`;
}

export const SVELTEKIT_CONVENTIONS: ConventionSet = {
  framework: 'sveltekit',

  fileRoles: [
    { role: 'PAGE_SERVER', fileName: '+page.server', under: 'routes' },
    { role: 'LAYOUT_SERVER', fileName: '+layout.server', under: 'routes' },
    { role: 'SERVER_ENDPOINT', fileName: '+server', under: 'routes' },
    { role: 'PAGE', fileName: '+page', under: 'routes' },
    { role: 'LAYOUT', fileName: '+layout', under: 'routes' },
    { role: 'ERROR', fileName: '+error', under: 'routes' },
    { role: 'HOOKS', fileName: 'hooks.server', under: null },
    { role: 'HOOKS', fileName: 'hooks.client', under: null },
    { role: 'HOOKS', fileName: 'hooks', under: null },
  ],
  baseExtensions: ['ts', 'js', 'mts', 'mjs', 'svelte'],

  rules: [
    {
      id: 'sveltekit.load',
      roles: ['PAGE_SERVER', 'PAGE'],
      match: [
        { kind: 'exportedFunction', names: ['load'] },
        { kind: 'exportedConst', names: ['load'] },
      ],
      emit: {
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.svelte-sfc-and-sveltekit-hooks',
        name: 'SvelteKit Load: {routePath}',
        metadata: {
          routePath: '{routePath}',
          flowRole: 'INGRESS',
        },
      },
      meta: {
        framework: 'sveltekit',
        versions: '>=1.0',
        fixture: 'sveltekit-conventions',
        specRef: 'PAT-EXT-76',
        description:
          'An exported `load` function or constant in `routes/**/+page.server.<ext>` or `routes/**/+page.<ext>` is a SvelteKit route data loader.',
      },
    },
    {
      id: 'sveltekit.layout-load',
      roles: ['LAYOUT_SERVER', 'LAYOUT'],
      match: [
        { kind: 'exportedFunction', names: ['load'] },
        { kind: 'exportedConst', names: ['load'] },
      ],
      emit: {
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.svelte-sfc-and-sveltekit-hooks',
        name: 'SvelteKit Layout Load: {layoutPath}',
        metadata: {
          routePath: '{layoutPath}',
          flowRole: 'INGRESS',
        },
      },
      meta: {
        framework: 'sveltekit',
        versions: '>=1.0',
        fixture: 'sveltekit-conventions',
        specRef: 'PAT-EXT-76',
        description:
          'An exported `load` function or constant in `routes/**/+layout.server.<ext>` or `routes/**/+layout.<ext>` is a SvelteKit layout data loader.',
      },
    },
    {
      id: 'sveltekit.actions',
      roles: ['PAGE_SERVER'],
      match: { kind: 'exportedConst', names: ['actions'] },
      emit: {
        type: 'CONTRACT',
        entityType: 'SERVER_ACTION',
        patternId: 'contract.svelte-sfc-and-sveltekit-hooks',
        name: 'SvelteKit Actions: {routePath}',
        metadata: {
          routePath: '{routePath}',
          flowRole: 'INGRESS',
        },
      },
      meta: {
        framework: 'sveltekit',
        versions: '>=1.0',
        fixture: 'sveltekit-conventions',
        specRef: 'PAT-EXT-76',
        description:
          'An exported `actions` object in `routes/**/+page.server.<ext>` defines SvelteKit form actions for that route.',
      },
    },
    {
      id: 'sveltekit.server-endpoint',
      roles: ['SERVER_ENDPOINT'],
      match: [
        { kind: 'exportedFunction', names: SVELTEKIT_ENDPOINT_METHODS },
        { kind: 'exportedConst', names: SVELTEKIT_ENDPOINT_METHODS },
      ],
      emit: {
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.svelte-sfc-and-sveltekit-hooks',
        name: 'Route Handler: {name}',
        metadata: {
          routePath: '{routePath}',
          flowRole: 'INGRESS',
        },
      },
      meta: {
        framework: 'sveltekit',
        versions: '>=1.0',
        fixture: 'sveltekit-conventions',
        specRef: 'PAT-EXT-76',
        description:
          'An exported HTTP-method (`GET`, `POST`, ..., `fallback`) handler in `routes/**/+server.<ext>` is a SvelteKit server endpoint.',
      },
    },
    {
      id: 'sveltekit.hooks',
      roles: ['HOOKS'],
      match: [
        { kind: 'exportedFunction', names: SVELTEKIT_HOOK_EXPORTS },
        { kind: 'exportedConst', names: SVELTEKIT_HOOK_EXPORTS },
      ],
      emit: {
        type: 'CONTRACT',
        entityType: 'MIDDLEWARE',
        patternId: 'contract.svelte-sfc-and-sveltekit-hooks',
        name: 'SvelteKit Hook: {name}',
        metadata: {
          flowRole: 'INGRESS',
        },
      },
      meta: {
        framework: 'sveltekit',
        versions: '>=1.0',
        fixture: 'sveltekit-conventions',
        specRef: 'PAT-EXT-76',
        description:
          'An exported SvelteKit hook (`handle`, `handleFetch`, `handleError`, `init`, `reroute`, `transport`) in `hooks.server.<ext>`, `hooks.client.<ext>`, or `src/hooks.<ext>` is a framework middleware ingress contract.',
      },
    },
  ],

  derivers: {
    routePath: sveltekitRoutePath,
    layoutPath: sveltekitLayoutPath,
  },

  escapeHatches: [],
};
