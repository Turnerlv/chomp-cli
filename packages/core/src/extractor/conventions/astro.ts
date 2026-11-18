// packages/core/src/extractor/conventions/astro.ts
//
// Astro file-based routing & endpoint conventions, as DATA (`[PAT-EXT-28]`, `[PAT-EXT-76]`).
//
// Covers:
// - `getStaticPaths` route lifecycle exports in `pages/**` / `src/pages/**`
// - File-based HTTP endpoint handlers (`GET`, `POST`, ..., `ALL`) in `pages/**` / `src/pages/**`

import type { ConventionSet } from './types.js';

/** Standard HTTP method exports recognized in Astro file-based endpoints (`https://docs.astro.build/en/guides/endpoints/`). */
export const ASTRO_ENDPOINT_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'ALL',
] as const;

/** Astro static route generation lifecycle export names. */
export const ASTRO_LIFECYCLE_EXPORTS = ['getStaticPaths'] as const;

/**
 * Derives an Astro route path from a repository-relative file path under `pages/` or `src/pages/`.
 *
 * Strips the source extension (`.astro`, `.mdx`, `.ts`, `.js`, `.mts`, `.mjs`) while preserving
 * non-HTML endpoint suffixes (e.g. `rss.xml.ts` -> `/rss.xml`, `index.png.ts` -> `/index.png`)
 * and normalizing `index.astro` -> `/`.
 *
 * @param relativeFilePath - Repository-relative path of the Astro page or endpoint file.
 * @returns Normalized URL route path starting with `/`.
 *
 * @example
 * astroRoutePath('src/pages/posts/[...page].astro') // '/posts/[...page]'
 * astroRoutePath('src/pages/index.astro')           // '/'
 * astroRoutePath('src/pages/rss.xml.ts')            // '/rss.xml'
 */
export function astroRoutePath(relativeFilePath: string): string {
  const normalized = relativeFilePath.replace(/\\/g, '/');
  const afterPages = normalized.replace(/^(?:.*?\/)?pages\//, '');
  const withoutSourceExt = afterPages.replace(/\.(?:astro|mdx|mts|mjs|ts|js)$/i, '');
  const withoutIndex = withoutSourceExt.replace(/(?:^|\/)index$/, '');
  if (!withoutIndex || withoutIndex === '/') return '/';
  return '/' + withoutIndex.replace(/^\/+|\/+$/g, '');
}

export const ASTRO_CONVENTIONS: ConventionSet = {
  framework: 'astro',

  fileRoles: [{ role: 'ASTRO_ROUTE', fileName: '*', under: 'pages' }],
  baseExtensions: ['astro', 'mdx', 'ts', 'js', 'mts', 'mjs'],

  rules: [
    {
      id: 'astro.lifecycle-export',
      roles: ['ASTRO_ROUTE'],
      match: [
        { kind: 'exportedFunction', names: ASTRO_LIFECYCLE_EXPORTS },
        { kind: 'exportedConst', names: ASTRO_LIFECYCLE_EXPORTS },
      ],
      emit: {
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.astro-get-static-paths-lifecycle',
        name: 'Astro Lifecycle: {name} ({routePath})',
        metadata: {
          routePath: '{routePath}',
          componentName: '{name}',
          flowRole: 'INGRESS',
        },
      },
      meta: {
        framework: 'astro',
        versions: '>=2.0',
        fixture: 'astro-conventions',
        specRef: 'PAT-EXT-76',
        description:
          'An exported `getStaticPaths` function or constant in `pages/**` / `src/pages/**` is an Astro static route lifecycle contract.',
      },
    },
    {
      id: 'astro.endpoint-handler',
      roles: ['ASTRO_ROUTE'],
      match: [
        { kind: 'exportedFunction', names: ASTRO_ENDPOINT_METHODS },
        { kind: 'exportedConst', names: ASTRO_ENDPOINT_METHODS },
      ],
      emit: {
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.astro-api-route-handler',
        name: 'Route Handler: {name}',
        metadata: {
          routePath: '{routePath}',
          flowRole: 'INGRESS',
        },
      },
      meta: {
        framework: 'astro',
        versions: '>=3.0',
        fixture: 'astro-conventions',
        specRef: 'PAT-EXT-76',
        description:
          'An exported uppercase HTTP-method handler (`GET`, `POST`, ..., `ALL`) in an Astro endpoint under `pages/**` / `src/pages/**` is an HTTP endpoint.',
      },
    },
  ],

  derivers: {
    routePath: astroRoutePath,
  },

  escapeHatches: [],
};
