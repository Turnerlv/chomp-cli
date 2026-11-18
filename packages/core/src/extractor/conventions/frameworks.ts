/**
 * @file frameworks.ts
 * Framework-specific contract conventions and AST helpers for Hono OpenAPI, Remix, Astro,
 * Commander / Citty CLI, raw Node HTTP route branching, and Styled Components / React Context
 * (`[PAT-EXT-28]`).
 *
 * Keeps `visitors/contractVisitor.ts` focused on language-level TypeScript/JavaScript contract
 * primitives while isolating framework-specific syntax and file-role conventions here.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { EvidenceRecord, StructuralEdge, StructuralEntity, StructuralNode } from '../../types/index.js';
import { contractEntityId, resolveLogicalBoundaryScope, stableEntityId } from '../../utils/id.js';
import { resolveModulePath } from '../pathResolver.js';
import { resolveBoundaryForFile, type WorkspaceRegistry } from '../workspaceResolver.js';
import {
  findModuleBinding,
  findValueModuleBinding,
  getCachedSourceFile,
  getChainRootIdentifier,
} from '../visitors/targetResolver.js';
import { ASTRO_CONVENTIONS } from './astro.js';
import { SVELTEKIT_CONVENTIONS, deriveSvelteComponentName } from './sveltekit.js';
import { applyConventionRules, classifyFileRole } from './engine.js';

/** Standard HTTP method names recognized across route handler conventions. */
export const ROUTE_HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
]);

/** Canonical pattern IDs for framework HTTP route contracts and edges. */
export const ROUTE_HANDLER_CONTRACT_PATTERN_ID = 'contract.nextjs-route-handler';
export const HTTP_ROUTE_CONTRACT_PATTERN_ID = 'contract.express-route';
export const HTTP_ROUTE_HANDLER_EDGE_PATTERN_ID = 'relationship.express-route-handler';
export const HTTP_ROUTE_MIDDLEWARE_EDGE_PATTERN_ID = 'relationship.express-route-middleware';
export const HTTP_ROUTER_MOUNT_EDGE_PATTERN_ID = 'relationship.express-router-mount';

/** Framework module specifiers whose `use*` exports are treated as React/router hooks. */
export const FRAMEWORK_HOOK_MODULES = new Set([
  'react',
  'next/navigation',
  'next/router',
  'react-router',
  'react-router-dom',
]);

/** Dependency-injection container packages whose `.get(Service)` calls resolve service classes. */
export const DI_CONTAINER_PACKAGES = new Set([
  'typedi',
  'inversify',
  'tsyringe',
  'awilix',
  '@nestjs/core',
  '@foal/core',
]);

/** Known ORM, database SDK, and queue/broker root client identifiers. */
export const ORM_AND_BROKER_CLIENT_IDENTIFIERS = [
  'prisma',
  'knex',
  'mongoose',
  'sequelize',
  'typeorm',
  'supabase',
  'bull',
  'bullmq',
] as const;

/**
 * Returns the canonical DB client root identifier when `calleeName` is a known
 * framework DB client factory function (e.g. Supabase `createClient` / `createServerClient`).
 */
export function matchFrameworkDbClientFactoryCall(calleeName: string): string | null {
  if (
    /^(?:createClient|createServerClient|createBrowserClient|createRouteHandlerClient|createMiddlewareClient|getSupabaseClient)$/.test(
      calleeName
    )
  ) {
    return 'supabase';
  }
  return null;
}

const NEXTJS_APP_SPECIAL_FILE_RE =
  /(?:^|\/)(?:src\/)?app\/(?:.*\/)?(?:loading|error|global-error|not-found|default|template|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.[jt]sx?$/i;

const NEXTJS_ROOT_HOOK_FILE_RE =
  /(?:^|\/)(?:src\/)?(?:instrumentation|proxy)\.[jt]sx?$/i;

const NEXTJS_PAGES_ROUTE_FILE_RE =
  /(?:^|\/)(?:src\/)?pages\/(?!_app\.|_document\.|api\/).*\.[jt]sx?$/i;

const TURBO_PLOP_GENERATOR_FILE_RE =
  /(?:^|\/)turbo\/generators\/config\.[cm]?[tj]sx?$/i;

/**
 * True when `filePath` is a Next.js App Router special convention file
 * (`loading.tsx`, `error.tsx`, `global-error.tsx`, `not-found.tsx`, `default.tsx`, `template.tsx`,
 * `sitemap.ts`, `robots.ts`, `manifest.ts`, `icon.tsx`, `opengraph-image.tsx`, `twitter-image.tsx`).
 */
export function isNextjsAppSpecialFile(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return NEXTJS_APP_SPECIAL_FILE_RE.test(normalized);
}

/**
 * True when an exported function or variable in `filePath` is a framework route ingress export
 * (Remix route exports, Next.js App/Pages Router special files, Turborepo Plop generators, or Astro `getStaticPaths`).
 */
export function isFrameworkIngressExport(
  filePath: string | undefined,
  expName: string,
  hasDefaultModifier = false
): boolean {
  if (isRemixRouteFile(filePath) && (REMIX_INGRESS_EXPORTS.has(expName) || hasDefaultModifier)) {
    return true;
  }
  if (
    isNextjsAppSpecialFile(filePath) &&
    (hasDefaultModifier ||
      expName === 'default' ||
      expName === ' sitemap' ||
      expName === 'sitemap' ||
      expName === 'robots' ||
      expName === 'manifest' ||
      expName === 'Image' ||
      expName === 'Icon' ||
      /^[A-Z]/.test(expName))
  ) {
    return true;
  }
  const normalized = filePath ? filePath.replace(/\\/g, '/') : '';
  if (
    normalized &&
    NEXTJS_ROOT_HOOK_FILE_RE.test(normalized) &&
    (hasDefaultModifier ||
      expName === 'default' ||
      expName === 'register' ||
      expName === 'onRequestError' ||
      expName === 'proxy' ||
      expName === 'middleware')
  ) {
    return true;
  }
  if (
    normalized &&
    NEXTJS_PAGES_ROUTE_FILE_RE.test(normalized) &&
    (hasDefaultModifier ||
      expName === 'default' ||
      expName === 'getServerSideProps' ||
      expName === 'getStaticProps' ||
      expName === 'getStaticPaths' ||
      expName === 'getInitialProps')
  ) {
    return true;
  }
  if (
    normalized &&
    TURBO_PLOP_GENERATOR_FILE_RE.test(normalized) &&
    (hasDefaultModifier || expName === 'default' || expName === 'generator')
  ) {
    return true;
  }
  if (Boolean(filePath?.toLowerCase().endsWith('.astro')) && expName === 'getStaticPaths') {
    return true;
  }
  return false;
}

/** Strips the `Payload Plugin: ` label prefix from a `PLUGIN_REGISTRATION` relationship name. */
export function stripPayloadPluginPrefix(entryName: string): string {
  return entryName.replace('Payload Plugin: ', '');
}

/** Parses an `Express Mount: /prefix -> router` relationship name into its mount prefix and target hint. */
export function parseRouterMountEdgeName(
  edgeName: string
): { rawPrefix: string; targetHint: string } | null {
  const match = edgeName.match(/^(?:Express\s+)?Mount:\s*(\/[^\s]*)\s*->\s*(.+)$/i);
  if (!match) return null;
  return { rawPrefix: match[1], targetHint: match[2] };
}

/** Parses an `Express Route: <METHOD> <PATH>` contract node name into its HTTP verb and route path. */
export function parseFrameworkHttpRouteNodeName(
  nodeName: string
): { method: string; rawPath: string } | null {
  const match = nodeName.match(
    /^Express Route:\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)\s+(\/.*)$/i
  );
  if (!match) return null;
  return { method: match[1].toUpperCase(), rawPath: match[2] };
}

/**
 * Unwraps transparent TypeScript expression wrappers (`(...)`, `as T`, `satisfies T`, `<T>expr`, `expr!`).
 *
 * @param expr - The AST expression to unwrap.
 * @returns The underlying unwrapped expression.
 */
function unwrapExpressionWrapper(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * True when an initializer is a styled-component tagged template or call expression
 * (`styled.div\`...\``, `styled(Button)\`...\``, `createGlobalStyle\`...\``, `styled(Button)({ ... })`).
 *
 * @param expr - Variable declaration initializer expression.
 * @returns Whether the expression constructs a styled-components component.
 */
export function isStyledComponentInitializer(expr: ts.Expression): boolean {
  const current = unwrapExpressionWrapper(expr);
  if (ts.isTaggedTemplateExpression(current)) {
    const tagRoot = getChainRootIdentifier(current.tag);
    return tagRoot === 'styled' || tagRoot === 'createGlobalStyle';
  }
  if (ts.isCallExpression(current)) {
    const callee = unwrapExpressionWrapper(current.expression);
    if (ts.isIdentifier(callee) && callee.text === 'createGlobalStyle') return true;
    if (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
      const root = getChainRootIdentifier(callee);
      return root === 'styled' || root === 'createGlobalStyle';
    }
  }
  return false;
}

/**
 * True when an initializer is a React Context creation call (`createContext(...)` or `React.createContext(...)`).
 *
 * @param expr - Variable declaration initializer expression.
 * @returns Whether the expression initializes a React Context object.
 */
export function isReactContextInitializer(expr: ts.Expression): boolean {
  const current = unwrapExpressionWrapper(expr);
  if (!ts.isCallExpression(current)) return false;
  const callee = unwrapExpressionWrapper(current.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text === 'createContext';
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === 'createContext';
  }
  return false;
}

/**
 * Derives a deterministic PascalCase Vue component contract name (`Vue Component: <PascalName>`)
 * from a `.vue` Single-File Component path (`[PAT-EXT-74]`), walking past `index.vue` to the
 * nearest informative parent directory segment so multiple `.vue` files in the same boundary
 * never collide on a generic `'Module Export (Default)'` label.
 */
export function deriveVueSfcComponentName(filePath?: string): string {
  const norm = (filePath ?? '').replace(/\\/g, '/').trim();
  if (!norm) return 'Vue Component: AnonymousComponent';
  const withoutExt = norm.replace(/\.vue$/i, '');
  const rawSegments = withoutExt.split('/').filter(Boolean);
  const STOP_DIRS = new Set(['pages', 'components', 'layouts', 'views', 'app', 'src']);
  const pickedTokens: string[] = [];
  for (let i = rawSegments.length - 1; i >= 0; i--) {
    const seg = rawSegments[i];
    if (seg.toLowerCase() === 'index') continue;
    if (STOP_DIRS.has(seg.toLowerCase()) && pickedTokens.length > 0) break;
    const cleaned = seg.replace(/^\[+|\.+|\]+$/g, '').replace(/[\[\]]/g, '');
    if (!cleaned) continue;
    pickedTokens.unshift(cleaned);
    if (!seg.startsWith('[')) break;
  }
  const combined = pickedTokens.length > 0 ? pickedTokens.join('-') : 'AnonymousComponent';
  const pascal = combined
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `Vue Component: ${pascal || 'AnonymousComponent'}`;
}

/**
 * Known HTTP router/sub-app factory callees whose exported instances represent mountable
 * router modules (`Hono`, `OpenAPIHono`, `Router`, `createRouter`, `createSubApp`).
 */
export const ROUTER_FACTORY_CALLEES = new Set([
  'Router',
  'Hono',
  'OpenAPIHono',
  'createRouter',
  'createSubApp',
  'createHonoServer',
]);

/**
 * Known router and CLI command factory callees whose exported instances represent mountable
 * sub-routers or CLI command definitions (`Hono`, `OpenAPIHono`, `Router`, `defineCommand`).
 */
export const ROUTER_AND_COMMAND_FACTORY_CALLEES = new Set([
  ...ROUTER_FACTORY_CALLEES,
  'defineCommand',
  'Command',
  'createCommand',
]);

/**
 * True when a variable initializer constructs a sub-router or HTTP application instance
 * (`new Hono()`, `new OpenAPIHono().openapi(...)`, `createRouter()`, `express.Router()`)
 * rather than a CLI command definition (`[PAT-EXT-74]`).
 */
export function isRouterFactoryInitializer(expr: ts.Expression): boolean {
  let cur = unwrapExpressionWrapper(expr);
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const methodName = cur.expression.name.text;
    if (
      methodName === 'Router' &&
      ts.isIdentifier(cur.expression.expression) &&
      cur.expression.expression.text === 'express'
    ) {
      return true;
    }
    if (
      [
        'openapi',
        'route',
        'use',
        'get',
        'post',
        'put',
        'delete',
        'patch',
        'all',
        'basePath',
        'onError',
        'notFound',
        'doc',
      ].includes(methodName)
    ) {
      cur = unwrapExpressionWrapper(cur.expression.expression);
      continue;
    }
    break;
  }
  if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression)) {
    return ROUTER_FACTORY_CALLEES.has(cur.expression.text);
  }
  if (ts.isNewExpression(cur) && ts.isIdentifier(cur.expression)) {
    return ROUTER_FACTORY_CALLEES.has(cur.expression.text);
  }
  return false;
}

/**
 * True when a variable initializer constructs a sub-router (`new Hono()`, `new OpenAPIHono().openapi(...)`,
 * `express.Router()`) or declarative CLI command (`defineCommand({ ... })`, `new Command()`).
 *
 * @param expr - Unwrapped variable initializer expression.
 * @returns Whether the initializer is a router or CLI command factory call/instantiation.
 */
export function isRouterOrCliCommandFactoryInitializer(expr: ts.Expression): boolean {
  if (isRouterFactoryInitializer(expr)) return true;
  let cur = unwrapExpressionWrapper(expr);
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const methodName = cur.expression.name.text;
    if (
      methodName === 'Router' &&
      ts.isIdentifier(cur.expression.expression) &&
      cur.expression.expression.text === 'express'
    ) {
      return true;
    }
    if (
      [
        'openapi',
        'route',
        'use',
        'get',
        'post',
        'put',
        'delete',
        'patch',
        'all',
        'basePath',
        'name',
        'description',
        'version',
        'option',
        'requiredOption',
        'argument',
        'arguments',
        'command',
        'addCommand',
        'action',
        'hook',
        'configureHelp',
        'configureOutput',
        'allowUnknownOption',
        'allowExcessArguments',
        'showHelpAfterError',
      ].includes(methodName)
    ) {
      cur = unwrapExpressionWrapper(cur.expression.expression);
      continue;
    }
    break;
  }
  if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression)) {
    return ROUTER_AND_COMMAND_FACTORY_CALLEES.has(cur.expression.text);
  }
  if (ts.isNewExpression(cur) && ts.isIdentifier(cur.expression)) {
    return ROUTER_AND_COMMAND_FACTORY_CALLEES.has(cur.expression.text);
  }
  return false;
}

/**
 * True when a function or variable declaration is an Astro API route handler
 * (`export const GET: APIRoute = ...`).
 *
 * @param node    - Function or variable declaration node.
 * @param expName - Exported symbol name.
 * @returns Whether the declaration is typed as `APIRoute` with an HTTP verb name.
 */
export function isAstroApiRouteExport(
  node: ts.FunctionDeclaration | ts.VariableDeclaration,
  expName: string
): boolean {
  if (!ROUTE_HTTP_METHODS.has(expName.toUpperCase())) return false;
  if (!node.type) return false;
  if (ts.isTypeReferenceNode(node.type)) {
    const typeName = ts.isIdentifier(node.type.typeName)
      ? node.type.typeName.text
      : node.type.typeName.right.text;
    return typeName === 'APIRoute';
  }
  return false;
}

/** Remix route module lifecycle and data-loading exports invoked by the Remix runtime. */
export const REMIX_INGRESS_EXPORTS = new Set([
  'loader',
  'action',
  'clientLoader',
  'clientAction',
  'headers',
  'meta',
  'links',
  'ErrorBoundary',
  'HydrateFallback',
  'handleRequest',
  'handleDataRequest',
  'default',
]);

/**
 * True when `filePath` is inside a Remix `app/routes/` directory or is a Remix root/entry file
 * (`app/root.tsx`, `app/entry.server.tsx`, `app/entry.client.tsx`).
 *
 * @param filePath - Relative or absolute path of the source file.
 */
export function isRemixRouteFile(filePath?: string): boolean {
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, '/');
  return /(?:^|\/)app\/(?:routes\/.*|root|entry\.server|entry\.client)\.[tj]sx?$/i.test(norm);
}

/**
 * True when `filePath` is an Astro or MDX page file under `pages/` or `src/pages/`.
 *
 * @param filePath - Relative or absolute path of the source file.
 */
export function isAstroPageFile(filePath?: string): boolean {
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, '/');
  return /(?:^|\/)(?:src\/)?pages\/.*\.(?:astro|mdx)$/i.test(norm);
}

/**
 * True when `filePath` is a Vue or Nuxt page, layout, or root `app.vue` entry file.
 *
 * @param filePath - Relative or absolute path of the source file.
 */
export function isVueOrNuxtPageFile(filePath?: string): boolean {
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, '/');
  return /(?:^|\/)(?:(?:src|app)\/)?(?:pages|layouts)\/.*\.vue$|(?:^|\/)app\.vue$/i.test(norm);
}

const NUXT_ENTRYPOINT_WRAPPER_CALLEES = new Set([
  'defineNuxtPlugin',
  'defineNuxtRouteMiddleware',
  'defineNitroPlugin',
  'defineEventHandler',
  'eventHandler',
  'createHonoServer',
]);

/**
 * True when `expr` is a Nuxt 3 plugin, route middleware, or Nitro event handler wrapper call
 * (`export default defineNuxtPlugin(...)`, `export default defineNuxtRouteMiddleware(...)`).
 */
export function isNuxtPluginOrMiddlewareDefaultCall(
  expr: ts.Expression,
  filePath?: string
): boolean {
  const cur = unwrapExpressionWrapper(expr);
  if (!ts.isCallExpression(cur)) return false;
  if (ts.isIdentifier(cur.expression) && NUXT_ENTRYPOINT_WRAPPER_CALLEES.has(cur.expression.text)) {
    return true;
  }
  if (filePath) {
    const norm = filePath.replace(/\\/g, '/');
    if (/(?:^|\/)(?:(?:src|app|server)\/)?(?:plugins|middleware)\/.*\.[cm]?[tj]sx?$/i.test(norm)) {
      return true;
    }
  }
  return false;
}

/**
 * True when `expr` is a Pinia store definition (`defineStore('id', ...)`).
 */
export function isPiniaDefineStoreInitializer(expr: ts.Expression): boolean {
  const cur = unwrapExpressionWrapper(expr);
  return (
    ts.isCallExpression(cur) &&
    ts.isIdentifier(cur.expression) &&
    cur.expression.text === 'defineStore' &&
    cur.arguments.length >= 1
  );
}

const EXPORTED_FACTORY_CONST_CALLEES = new Set([
  'remember',
  'createEnv',
  'createCookieSessionStorage',
  'createSessionStorage',
  'createMemorySessionStorage',
  'createFileSessionStorage',
  'createWorkersKVSessionStorage',
  'createCookie',
  'secureHeaders',
  'rateLimit',
  'createAxiosInstance',
  'Enum',
  'createLogger',
  'pino',
  'multer',
  'createRoute',
  'toZodV4SchemaTyped',
  'createMessageObjectSchema',
  'createErrorSchema',
  'createHonoServer',
]);

const EXPORTED_FACTORY_CONST_METHOD_CALLEES = new Set([
  'Logger.get',
  'axios.create',
  'winston.createLogger',
  'consola.create',
  'multer.diskStorage',
  'multer.memoryStorage',
]);

const SCHEMA_DERIVATION_METHODS = new Set([
  'partial',
  'deepPartial',
  'pick',
  'omit',
  'extend',
  'merge',
  'required',
  'readonly',
  'array',
  'nullable',
  'optional',
]);

/**
 * Returns the factory constant pattern ID when `expr` is a known framework/utility factory call
 * initializer (`remember(...)`, `createEnv(...)`, `createCookieSessionStorage(...)`, `secureHeaders(...)`,
 * `createAxiosInstance(...)`, `Enum(...)`, `Logger.get(...)`), or `null` otherwise.
 */
export function matchExportedFactoryCallConstantPattern(
  expr: ts.Expression
): 'contract.factory-call-exported-const' | 'contract.exported-factory-instance-and-enum-call' | null {
  const cur = unwrapExpressionWrapper(expr);
  if (!ts.isCallExpression(cur)) return null;
  if (ts.isIdentifier(cur.expression)) {
    const name = cur.expression.text;
    if (name === 'createAxiosInstance' || name === 'Enum') {
      return 'contract.exported-factory-instance-and-enum-call';
    }
    if (EXPORTED_FACTORY_CONST_CALLEES.has(name)) {
      return 'contract.factory-call-exported-const';
    }
  } else if (
    ts.isPropertyAccessExpression(cur.expression) &&
    ts.isIdentifier(cur.expression.expression)
  ) {
    const recvName = cur.expression.expression.text;
    const methodName = cur.expression.name.text;
    const full = `${recvName}.${methodName}`;
    if (full === 'axios.create') {
      return 'contract.exported-factory-instance-and-enum-call';
    }
    if (EXPORTED_FACTORY_CONST_METHOD_CALLEES.has(full)) {
      return 'contract.factory-call-exported-const';
    }
    if (/Schema$/i.test(recvName) && SCHEMA_DERIVATION_METHODS.has(methodName)) {
      return 'contract.factory-call-exported-const';
    }
  }
  return null;
}

/**
 * True when `filePath` ends with `.mdx`, `.astro`, or `.vue`.
 */
export function isMdxOrAstroFilePath(filePath?: string): boolean {
  if (!filePath) return false;
  return filePath.endsWith('.mdx') || filePath.endsWith('.astro') || filePath.endsWith('.vue');
}

const CANONICAL_CLI_ENTRY_NAMES = new Set([
  'main',
  'cli',
  'bootstrap',
  'run',
  'seed',
  'start',
]);

function unwrapTopLevelEntryCall(
  stmt: ts.Statement
): { calleeName: string; hasPromiseChain: boolean } | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  let expr: ts.Expression = stmt.expression;
  while (
    ts.isAwaitExpression(expr) ||
    ts.isVoidExpression(expr) ||
    ts.isParenthesizedExpression(expr)
  ) {
    expr = expr.expression;
  }
  let hasPromiseChain = false;
  while (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    (expr.expression.name.text === 'catch' ||
      expr.expression.name.text === 'then' ||
      expr.expression.name.text === 'finally')
  ) {
    hasPromiseChain = true;
    expr = expr.expression.expression;
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return { calleeName: expr.expression.text, hasPromiseChain };
  }
  return null;
}

/**
 * Returns all top-level `ExpressionStatement`s in `sourceFile` that invoke `fnName` as a CLI/worker
 * entrypoint (`fnName()`, `await fnName()`, `void fnName()`, `fnName().catch(...)`).
 */
export function findTopLevelCliInvocationStatements(
  sourceFile: ts.SourceFile,
  fnName: string
): ts.ExpressionStatement[] {
  const matches: ts.ExpressionStatement[] = [];
  for (const stmt of sourceFile.statements) {
    const parsed = unwrapTopLevelEntryCall(stmt);
    if (parsed && parsed.calleeName === fnName && ts.isExpressionStatement(stmt)) {
      matches.push(stmt);
    }
  }
  return matches;
}

/**
 * True when a top-level function is invoked at module evaluation time as a CLI / seed / worker
 * entrypoint (`main().catch(...)`, `seed()`, or in a shebang / `bin/` / `cli/` / `scripts/` / `workers/` file).
 *
 * @param sourceFile - Enclosing TypeScript SourceFile.
 * @param fnName     - Declared function or variable name.
 * @param filePath   - Optional file path for `cli/`, `bin/`, `scripts/`, or `workers/` path check.
 */
export function isTopLevelCliEntryInvocation(
  sourceFile: ts.SourceFile,
  fnName: string,
  filePath?: string
): boolean {
  const normPath = (filePath ?? sourceFile.fileName).replace(/\\/g, '/');
  const hasShebangOrScriptPath =
    sourceFile.text.startsWith('#!') ||
    /(?:^|\/)(?:cli|bin|scripts?|workers?|jobs?|cron)(?:\/|$)/i.test(normPath);
  const isCanonicalName = CANONICAL_CLI_ENTRY_NAMES.has(fnName);
  if (!isCanonicalName && !hasShebangOrScriptPath) {
    return false;
  }
  for (const stmt of sourceFile.statements) {
    const parsed = unwrapTopLevelEntryCall(stmt);
    if (
      parsed &&
      parsed.calleeName === fnName &&
      (parsed.hasPromiseChain || hasShebangOrScriptPath)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts a `CLI_COMMAND` contract from a top-level Commander/CAC `.command('<name>').action(fn)`
 * chain (`Exported Function: command:<name>`).
 *
 * @param node        - Candidate AST node.
 * @param getEvidence - Evidence builder callback.
 * @param nextId      - Placeholder ID generator.
 */
export function extractTopLevelCommanderActionContract(
  node: ts.Node,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }
  if (node.expression.name.text !== 'action' || node.arguments.length === 0) {
    return null;
  }
  // Only match top-level `.command(...).action(...)` chains (not inside functions/methods/classes).
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isClassDeclaration(cur)
    ) {
      return null;
    }
  }
  let curExpr: ts.Expression = node.expression.expression;
  while (ts.isCallExpression(curExpr) && ts.isPropertyAccessExpression(curExpr.expression)) {
    const mName = curExpr.expression.name.text;
    if (mName === 'command' && curExpr.arguments.length > 0) {
      const firstArg = curExpr.arguments[0];
      if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
        const rawCmd = firstArg.text.trim();
        const cmdName = rawCmd.split(/\s+/)[0] || rawCmd;
        if (cmdName) {
          return {
            id: nextId(),
            name: `Exported Function: command:${cmdName}`,
            type: 'CONTRACT',
            entityType: 'CLI_COMMAND',
            patternId: 'contract.exported-function',
            evidence: getEvidence(node),
            metadata: { flowRole: 'INGRESS' },
          };
        }
      }
    }
    curExpr = curExpr.expression.expression;
  }
  return null;
}

function collectHttpConditionFacts(
  expr: ts.Expression,
  facts: { method?: string; routePath?: string }
): void {
  const unwrapped = unwrapExpressionWrapper(expr);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    collectHttpConditionFacts(unwrapped.left, facts);
    collectHttpConditionFacts(unwrapped.right, facts);
    return;
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    (unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
  ) {
    const checkPair = (lhs: ts.Expression, rhs: ts.Expression) => {
      if (!ts.isStringLiteral(rhs) && !ts.isNoSubstitutionTemplateLiteral(rhs)) return;
      const val = rhs.text.trim();
      if (
        ts.isPropertyAccessExpression(lhs) &&
        lhs.name.text === 'method' &&
        ROUTE_HTTP_METHODS.has(val.toUpperCase())
      ) {
        facts.method = val.toUpperCase();
      } else if (
        val.startsWith('/') &&
        ((ts.isIdentifier(lhs) && (lhs.text === 'pathname' || lhs.text === 'path' || lhs.text === 'url')) ||
          (ts.isPropertyAccessExpression(lhs) &&
            (lhs.name.text === 'pathname' || lhs.name.text === 'url' || lhs.name.text === 'path')))
      ) {
        facts.routePath = val;
      }
    };
    checkPair(unwrapped.left, unwrapped.right);
    checkPair(unwrapped.right, unwrapped.left);
    return;
  }
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    unwrapped.expression.name.text === 'startsWith' &&
    unwrapped.arguments.length === 1 &&
    (ts.isStringLiteral(unwrapped.arguments[0]) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped.arguments[0]))
  ) {
    const val = unwrapped.arguments[0].text.trim();
    const recv = unwrapped.expression.expression;
    if (
      val.startsWith('/') &&
      ((ts.isIdentifier(recv) && (recv.text === 'pathname' || recv.text === 'path' || recv.text === 'url')) ||
        (ts.isPropertyAccessExpression(recv) &&
          (recv.name.text === 'pathname' || recv.name.text === 'url' || recv.name.text === 'path')))
    ) {
      facts.routePath = val;
    }
  }
}

/**
 * Extracts an `HTTP_ENDPOINT` contract from a raw `node:http` conditional route branch
 * (`if (req.method === 'POST' && url.pathname === '/v1/traces')`).
 *
 * @param node        - Candidate `IfStatement` AST node.
 * @param getEvidence - Evidence builder callback.
 * @param nextId      - Placeholder ID generator.
 */
export function extractNodeHttpRouteBranchContract(
  node: ts.Node,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | null {
  if (!ts.isIfStatement(node)) return null;
  const facts: { method?: string; routePath?: string } = {};
  collectHttpConditionFacts(node.expression, facts);
  if (!facts.routePath) return null;
  if (!facts.method) {
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (
        ts.isFunctionDeclaration(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isArrowFunction(cur) ||
        ts.isMethodDeclaration(cur)
      ) {
        break;
      }
      if (ts.isIfStatement(cur)) {
        const parentFacts: { method?: string; routePath?: string } = {};
        collectHttpConditionFacts(cur.expression, parentFacts);
        if (parentFacts.method) {
          facts.method = parentFacts.method;
          break;
        }
      }
    }
  }
  if (!facts.method || !facts.routePath) return null;
  return {
    id: nextId(),
    name: `Express Route: ${facts.method} ${facts.routePath}`,
    type: 'CONTRACT',
    entityType: 'HTTP_ENDPOINT',
    patternId: 'contract.express-route',
    evidence: getEvidence(node),
  };
}

function parseCreateRouteCallObject(expr: ts.Expression): { method: string; path: string } | null {
  const unwrapped = unwrapExpressionWrapper(expr);
  if (!ts.isCallExpression(unwrapped) || unwrapped.arguments.length === 0) return null;
  const callee = unwrapped.expression;
  const isCreateRoute =
    (ts.isIdentifier(callee) && callee.text === 'createRoute') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRoute');
  if (!isCreateRoute) return null;
  const arg0 = unwrapExpressionWrapper(unwrapped.arguments[0]);
  if (!ts.isObjectLiteralExpression(arg0)) return null;
  let method: string | null = null;
  let routePath: string | null = null;
  for (const prop of arg0.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const propName =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (
      propName === 'method' &&
      (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
    ) {
      method = prop.initializer.text.toUpperCase();
    } else if (
      propName === 'path' &&
      (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
    ) {
      routePath = prop.initializer.text;
    }
  }
  if (method && routePath) {
    return { method, path: routePath };
  }
  return null;
}

function findCreateRouteInSourceFile(
  sf: ts.SourceFile,
  varName: string
): { method: string; path: string } | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === varName && decl.initializer) {
        const parsed = parseCreateRouteCallObject(decl.initializer);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

/**
 * Built-in DOM, ResizeObserver/IntersectionObserver, Iterator (`.next()`), and `Function.prototype`
 * reflection methods (`.apply()`, `.call()`, `.bind()`, `.constructor()`) that do not represent
 * structural contract invocations when unresolved (`[PAT-EXT-55]`).
 * Kept in `conventions/frameworks.ts` so `'next'` never appears in core visitor files (`[PAT-EXT-28]`).
 */
export const BUILTIN_DOM_ITERATOR_REFLECTION_METHODS = new Set<string>([
  'focus',
  'blur',
  'click',
  'scrollIntoView',
  'observe',
  'unobserve',
  'disconnect',
  'next',
  'apply',
  'call',
  'bind',
  'constructor',
]);

/**
 * Non-query schema definition and lifecycle hook methods on ORM schemas (`Schema.pre(...)`,
 * `Schema.post(...)`, `Schema.index(...)`, `Schema.virtual(...)`, `Schema.plugin(...)`)
 * that must not be emitted as `DB_QUERY` open connectors (`[PAT-EXT-56]`).
 */
export const ORM_SCHEMA_LIFECYCLE_METHODS = new Set<string>([
  'pre',
  'post',
  'index',
  'virtual',
  'method',
  'static',
  'plugin',
  'set',
  'add',
  'path',
  'loadClass',
  'discriminator',
]);

/**
 * Unwraps transparent function-provenance wrappers (`util.promisify(fn)`, `promisify(fn)`,
 * `_.bind(fn, ctx)`, `lodash.bind(fn, ctx)`, `underscore.bind(fn, ctx)`) to their underlying
 * first argument (`fn`) (`[PAT-EXT-55]`).
 */
export function unwrapTransparentFunctionWrapperCall(expr: ts.Expression): ts.Expression | null {
  const cur = unwrapExpressionWrapper(expr);
  if (!ts.isCallExpression(cur) || cur.arguments.length === 0) {
    return null;
  }
  const callee = unwrapExpressionWrapper(cur.expression);
  if (ts.isIdentifier(callee) && callee.text === 'promisify') {
    return unwrapExpressionWrapper(cur.arguments[0]);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const methodName = callee.name.text;
    if (methodName === 'promisify') {
      return unwrapExpressionWrapper(cur.arguments[0]);
    }
    if (
      methodName === 'bind' &&
      ts.isIdentifier(callee.expression) &&
      (callee.expression.text === '_' ||
        callee.expression.text === 'lodash' ||
        callee.expression.text === 'underscore')
    ) {
      return unwrapExpressionWrapper(cur.arguments[0]);
    }
  }
  return null;
}

/**
 * True when `expr` is a `_.bind(fn, ctx)` / `lodash.bind(fn, ctx)` call whose first argument is
 * an inline function expression, arrow function, or `this.<prop>` access rather than an external
 * package or module contract (`[PAT-EXT-55]`).
 */
export function isBindWrappedLocalExpression(expr: ts.Expression): boolean {
  const cur = unwrapExpressionWrapper(expr);
  if (!ts.isCallExpression(cur) || cur.arguments.length === 0) return false;
  const callee = unwrapExpressionWrapper(cur.expression);
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'bind' &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === '_' ||
      callee.expression.text === 'lodash' ||
      callee.expression.text === 'underscore')
  ) {
    const arg0 = unwrapExpressionWrapper(cur.arguments[0]);
    if (
      ts.isFunctionExpression(arg0) ||
      ts.isArrowFunction(arg0) ||
      (ts.isPropertyAccessExpression(arg0) && arg0.expression.kind === ts.SyntaxKind.ThisKeyword)
    ) {
      return true;
    }
  }
  return false;
}

function sourceFileImportsMongoose(sourceFile: ts.SourceFile): boolean {
  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === 'mongoose'
    ) {
      return true;
    }
  }
  return false;
}

function matchMongooseModelRegistrationCall(
  expr: ts.Expression,
  sourceFile: ts.SourceFile
): { modelName: string } | null {
  const cur = unwrapExpressionWrapper(expr);
  if (!ts.isCallExpression(cur) || cur.arguments.length === 0) return null;
  const callee = unwrapExpressionWrapper(cur.expression);
  const isMongooseReceiver =
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'model' &&
    ((ts.isIdentifier(callee.expression) &&
      (callee.expression.text === 'mongoose' || sourceFileImportsMongoose(sourceFile))) ||
      (ts.isPropertyAccessExpression(callee.expression) &&
        ts.isIdentifier(callee.expression.expression) &&
        callee.expression.expression.text === 'mongoose'));
  const isBareModelCall =
    ts.isIdentifier(callee) &&
    callee.text === 'model' &&
    (cur.arguments.length >= 2 || sourceFileImportsMongoose(sourceFile));
  if (!isMongooseReceiver && !isBareModelCall) {
    return null;
  }
  const arg0 = unwrapExpressionWrapper(cur.arguments[0]);
  if (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0)) {
    return { modelName: arg0.text };
  }
  return null;
}

/**
 * True when `node` is a Mongoose schema constructor (`new Schema(...)`, `new mongoose.Schema(...)`)
 * or model registration call (`model('User', schema)`, `mongoose.model('User', schema)`) that
 * defines a schema/model rather than executing a runtime `DB_QUERY` (`[PAT-EXT-56]`).
 */
export function isMongooseSchemaOrModelCall(
  node: ts.CallExpression | ts.NewExpression,
  sourceFile: ts.SourceFile
): boolean {
  if (ts.isNewExpression(node)) {
    const callee = unwrapExpressionWrapper(node.expression);
    if (ts.isIdentifier(callee) && callee.text === 'Schema') {
      return true;
    }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Schema') {
      return true;
    }
    return false;
  }
  if (matchMongooseModelRegistrationCall(node, sourceFile)) {
    return true;
  }
  const callee = unwrapExpressionWrapper(node.expression);
  if (ts.isPropertyAccessExpression(callee) && ORM_SCHEMA_LIFECYCLE_METHODS.has(callee.name.text)) {
    return true;
  }
  return false;
}

/**
 * Extracts a `DB_SCHEMA` contract from an exported Mongoose `model('User', schema)` /
 * `mongoose.model('User', schema)` variable declaration (`[PAT-EXT-56]`).
 */
export function extractMongooseModelContract(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | StructuralEntity[] | null {
  if (!ts.isVariableStatement(node)) return null;
  const hasExportMod = Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
  const results: StructuralEntity[] = [];
  for (const decl of node.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
    const varName = decl.name.text;
    let init: ts.Expression = unwrapExpressionWrapper(decl.initializer);
    if (
      ts.isBinaryExpression(init) &&
      (init.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      init = unwrapExpressionWrapper(init.right);
    }
    const matched = matchMongooseModelRegistrationCall(init, sourceFile);
    if (!matched) continue;
    const isExported =
      hasExportMod ||
      sourceFile.statements.some(
        (s) =>
          (ts.isExportAssignment(s) &&
            !s.isExportEquals &&
            ts.isIdentifier(s.expression) &&
            s.expression.text === varName) ||
          (ts.isExportDeclaration(s) &&
            !s.moduleSpecifier &&
            s.exportClause &&
            ts.isNamedExports(s.exportClause) &&
            s.exportClause.elements.some((el) => (el.propertyName ?? el.name).text === varName))
      );
    if (!isExported) continue;
    results.push({
      id: nextId(),
      name: `DB Schema: ${varName}`,
      type: 'CONTRACT',
      entityType: 'DB_SCHEMA',
      patternId: 'contract.mongoose-model',
      evidence: getEvidence(node),
      metadata: { modelName: matched.modelName },
    });
  }
  if (results.length === 0) return null;
  return results.length === 1 ? results[0] : results;
}

/**
 * Extracts an `HTTP_ENDPOINT` contract from `@hono/zod-openapi` `.openapi(createRoute({ method, path }), handler)`
 * and `.doc('/doc', config)` registrations.
 *
 * @param node        - Candidate `CallExpression` AST node.
 * @param sourceFile  - Enclosing TypeScript SourceFile.
 * @param getEvidence - Evidence builder callback.
 * @param nextId      - Placeholder ID generator.
 */
export function extractHonoOpenApiRouteContract(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }
  const methodName = node.expression.name.text;
  if (methodName === 'on' && node.arguments.length >= 3) {
    const verbArg = node.arguments[0];
    const pathArg = node.arguments[1];
    let httpVerb: string | undefined;
    if (ts.isStringLiteral(verbArg) || ts.isNoSubstitutionTemplateLiteral(verbArg)) {
      const upper = verbArg.text.trim().toUpperCase();
      if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)$/.test(upper)) {
        httpVerb = upper;
      }
    } else if (ts.isArrayLiteralExpression(verbArg) && verbArg.elements.length > 0) {
      const firstEl = verbArg.elements[0];
      if (ts.isStringLiteral(firstEl) || ts.isNoSubstitutionTemplateLiteral(firstEl)) {
        const upper = firstEl.text.trim().toUpperCase();
        if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)$/.test(upper)) {
          httpVerb = upper;
        }
      }
    }
    let routePath: string | undefined;
    if (
      (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg)) &&
      pathArg.text.startsWith('/')
    ) {
      routePath = pathArg.text;
    } else if (ts.isArrayLiteralExpression(pathArg) && pathArg.elements.length > 0) {
      const paths: string[] = [];
      for (const el of pathArg.elements) {
        if ((ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) && el.text.startsWith('/')) {
          paths.push(el.text);
        }
      }
      if (paths.length > 0) {
        routePath = paths[0];
      }
    }
    if (httpVerb && routePath) {
      return {
        id: nextId(),
        name: `Express Route: ${httpVerb} ${routePath}`,
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.express-route',
        evidence: getEvidence(node),
      };
    }
    return null;
  }
  if (methodName === 'doc' && node.arguments.length >= 2) {
    const pathArg = node.arguments[0];
    if (
      (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg)) &&
      pathArg.text.startsWith('/')
    ) {
      return {
        id: nextId(),
        name: `Express Route: GET ${pathArg.text}`,
        type: 'CONTRACT',
        entityType: 'HTTP_ENDPOINT',
        patternId: 'contract.express-route',
        evidence: getEvidence(node),
      };
    }
    return null;
  }
  if (methodName !== 'openapi' || node.arguments.length < 2) {
    return null;
  }
  const routeArg = node.arguments[0];
  let parsed = parseCreateRouteCallObject(routeArg);
  if (!parsed && ts.isIdentifier(routeArg)) {
    const routeVarName = routeArg.text;
    parsed = findCreateRouteInSourceFile(sourceFile, routeVarName);
    if (!parsed) {
      const binding = findValueModuleBinding(sourceFile, routeVarName);
      if (binding && binding.moduleSpecifier.startsWith('.')) {
        const dir = path.dirname(sourceFile.fileName);
        const relResolved = resolveModulePath(binding.moduleSpecifier, sourceFile.fileName, dir);
        if (relResolved) {
          const targetSf = getCachedSourceFile(path.resolve(dir, relResolved));
          if (targetSf) {
            const lookup =
              binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
                ? binding.importedName
                : routeVarName;
            parsed = findCreateRouteInSourceFile(targetSf, lookup);
          }
        }
      }
    }
  } else if (
    !parsed &&
    ts.isPropertyAccessExpression(routeArg) &&
    ts.isIdentifier(routeArg.expression)
  ) {
    const nsBinding = findValueModuleBinding(sourceFile, routeArg.expression.text);
    if (nsBinding && nsBinding.moduleSpecifier.startsWith('.')) {
      const dir = path.dirname(sourceFile.fileName);
      const relResolved = resolveModulePath(nsBinding.moduleSpecifier, sourceFile.fileName, dir);
      if (relResolved) {
        const targetSf = getCachedSourceFile(path.resolve(dir, relResolved));
        if (targetSf) {
          parsed = findCreateRouteInSourceFile(targetSf, routeArg.name.text);
        }
      }
    }
  }
  const methodLabel = parsed ? parsed.method : 'OPENAPI';
  const pathLabel = parsed ? parsed.path : routeArg.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return {
    id: nextId(),
    name: `Express Route: ${methodLabel} ${pathLabel}`,
    type: 'CONTRACT',
    entityType: 'HTTP_ENDPOINT',
    patternId: 'contract.express-route',
    evidence: getEvidence(node),
  };
}

/**
 * Infers an explicit cache/database dialect (`'redis'`) for a DB/cache client call when the source
 * file imports a Redis driver (`redis`, `ioredis`, `@upstash/redis`) and does not import a MongoDB
 * or SQL driver alongside it (`[PAT-EXT-64]`).
 */
export function inferCacheOrDbDialectFromBinding(
  rootId: string,
  sourceFile: ts.SourceFile
): string | undefined {
  if (/^(?:redis|ioredis|upstash|kv|cache)/i.test(rootId)) {
    return 'redis';
  }
  let hasRedisImport = false;
  let hasOtherDbImport = false;
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text.toLowerCase();
      if (
        spec === 'redis' ||
        spec.startsWith('redis/') ||
        spec === 'ioredis' ||
        spec.startsWith('ioredis/') ||
        spec.startsWith('@upstash/redis')
      ) {
        hasRedisImport = true;
      } else if (
        spec === 'mongodb' ||
        spec === 'mongoose' ||
        spec === 'pg' ||
        spec === 'mysql' ||
        spec === 'mysql2' ||
        spec === 'better-sqlite3' ||
        spec === 'sqlite3' ||
        spec.startsWith('drizzle-orm') ||
        spec.startsWith('@prisma/client')
      ) {
        hasOtherDbImport = true;
      }
    }
  }
  if (hasRedisImport && !hasOtherDbImport) {
    return 'redis';
  }
  return undefined;
}

export const ORM_MODEL_QUERY_PATTERN_ID = 'open-connector.mongoose-and-sequelize-model-queries';

export function isOrmModelOrConnectionTypeName(typeName: string): boolean {
  return typeName === 'Model' || typeName === 'Sequelize';
}

const RPC_ROUTER_FACTORY_NAMES = new Set([
  'router',
  'createTRPCRouter',
  'createRouter',
  'publicRouter',
]);

const RPC_PROCEDURE_TERMINAL_METHODS = new Set(['query', 'mutation', 'subscription']);

function isRpcRouterFactoryCall(callExpr: ts.CallExpression): boolean {
  const callee = unwrapExpressionWrapper(callExpr.expression);
  if (ts.isIdentifier(callee)) {
    return RPC_ROUTER_FACTORY_NAMES.has(callee.text);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return RPC_ROUTER_FACTORY_NAMES.has(callee.name.text);
  }
  return false;
}

/**
 * Extracts tRPC procedure contracts (`router({ getCars: publicProcedure.query(fn), ... })`) as
 * `API_ENDPOINT` (`INGRESS`) contracts (`[PAT-EXT-75]`).
 */
export function extractRpcRouterProcedureContract(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | null {
  if (!ts.isPropertyAssignment(node)) return null;
  if (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name)) return null;
  const procName = node.name.text.trim();
  if (!procName) return null;

  const init = unwrapExpressionWrapper(node.initializer);
  if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression)) {
    return null;
  }
  const rpcMethod = init.expression.name.text;
  if (!RPC_PROCEDURE_TERMINAL_METHODS.has(rpcMethod) || init.arguments.length === 0) {
    return null;
  }
  const hasFnHandler = init.arguments.some((arg) => {
    const unwrapped = unwrapExpressionWrapper(arg);
    return ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped);
  });
  if (!hasFnHandler) return null;

  if (!node.parent || !ts.isObjectLiteralExpression(node.parent)) return null;
  const segments: string[] = [procName];
  let curHolder: ts.Node | undefined = node.parent.parent;
  let matchedRouterCall = false;

  while (curHolder) {
    if (ts.isParenthesizedExpression(curHolder) || ts.isAsExpression(curHolder) || ts.isSatisfiesExpression(curHolder)) {
      curHolder = curHolder.parent;
      continue;
    }
    if (ts.isCallExpression(curHolder) && isRpcRouterFactoryCall(curHolder)) {
      matchedRouterCall = true;
      curHolder = curHolder.parent;
      continue;
    }
    if (ts.isPropertyAssignment(curHolder) && (ts.isIdentifier(curHolder.name) || ts.isStringLiteral(curHolder.name))) {
      segments.unshift(curHolder.name.text);
      curHolder = curHolder.parent?.parent;
      continue;
    }
    if (ts.isVariableDeclaration(curHolder) && ts.isIdentifier(curHolder.name)) {
      segments.unshift(curHolder.name.text);
      break;
    }
    if (ts.isExportAssignment(curHolder)) {
      segments.unshift('router');
      break;
    }
    break;
  }

  if (!matchedRouterCall) return null;

  const fullPath = segments.join('.');
  return {
    id: nextId(),
    name: `RPC Procedure: ${fullPath}`,
    type: 'CONTRACT',
    entityType: 'API_ENDPOINT',
    patternId: 'contract.trpc-procedure',
    evidence: getEvidence(node),
    metadata: {
      flowRole: 'INGRESS',
      rpcKind: rpcMethod,
    },
  };
}

function extractExternalHttpHost(urlPath: unknown): string | null {
  if (typeof urlPath !== 'string') return null;
  const trimmed = urlPath.trim();
  const m = /^https?:\/\/([a-z0-9.-]+)(?::\d+)?(?:\/|\?|$)/i.exec(trimmed);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    !host.includes('.')
  ) {
    return null;
  }
  return host;
}

function primaryEvidenceKey(ev: EvidenceRecord | EvidenceRecord[] | undefined): string {
  const first = Array.isArray(ev) ? ev[0] : ev;
  if (!first?.filePath) return '';
  return `${first.filePath.replace(/\\/g, '/')}:${first.lineNumber ?? 0}`;
}

function shortDisambiguatingFileLabel(rawFilePath: string): string {
  const norm = rawFilePath.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

/**
 * Disambiguates colliding `OPEN_CONNECTOR` instances within the same logical boundary scope BEFORE
 * ID deduplication (`[PAT-EXT-75]`):
 * 1. Multi-host external `HTTP_FETCH` (`HTTP Call: fetch (<host>)` when `>= 2` distinct external
 *    non-localhost hosts collide in a deployment unit).
 * 2. Multi-schema Drizzle query chains (`Drizzle Query: select(<Schema>)` when `>= 2` distinct
 *    `DB_SCHEMA` targets collide on the same Drizzle query verb in a deployment unit).
 * 3. Multi-file `open-connector.db-call` client invocations (`DB Call: supabase.auth.signInWithPassword [<file>]`
 *    when `>= 2` distinct source files invoke the same DB method in a deployment unit).
 */
export function disambiguateCollidingOpenConnectors(
  nodes: StructuralNode[],
  edges: StructuralEdge[],
  logicalScopeByConnector: WeakMap<StructuralNode, string>
): void {
  const nodeById = new Map<string, StructuralNode>();
  for (const n of nodes) {
    if (n.type !== 'OPEN_CONNECTOR' && !nodeById.has(n.id)) {
      nodeById.set(n.id, n);
    }
  }

  const ocGroups = new Map<string, StructuralNode[]>();
  for (const n of nodes) {
    if (n.type !== 'OPEN_CONNECTOR') continue;
    let list = ocGroups.get(n.id);
    if (!list) {
      list = [];
      ocGroups.set(n.id, list);
    }
    list.push(n);
  }

  for (const [oldId, group] of ocGroups.entries()) {
    if (group.length < 2) continue;
    const sample = group[0];

    // 1. Multi-host external HTTP_FETCH
    if (sample.entityType === 'HTTP_FETCH') {
      const hostByNode = new Map<StructuralNode, string>();
      const distinctHosts = new Set<string>();
      for (const oc of group) {
        const host = extractExternalHttpHost((oc.metadata as Record<string, unknown> | undefined)?.urlPath);
        if (host) {
          hostByNode.set(oc, host);
          distinctHosts.add(host);
        }
      }
      if (distinctHosts.size >= 2) {
        for (const oc of group) {
          const host = hostByNode.get(oc);
          if (!host) continue;
          const logicalScope = logicalScopeByConnector.get(oc) ?? '';
          const evKey = primaryEvidenceKey(oc.evidence);
          const newName = `${oc.name} (${host})`;
          const newId = stableEntityId(logicalScope, 'OPEN_CONNECTOR', newName);
          for (const e of edges) {
            if (e.targetId === oldId && primaryEvidenceKey(e.evidence) === evKey) {
              e.targetId = newId;
              if (e.name === `Call: ${oc.name}`) {
                e.name = `Call: ${newName}`;
              }
            }
          }
          oc.name = newName;
          oc.id = newId;
        }
      }
      continue;
    }

    // 2. Multi-schema Drizzle query chains
    if (sample.patternId === 'open-connector.drizzle-query-chain') {
      const schemaByNode = new Map<StructuralNode, { schemaName: string; schemaEdge: StructuralEdge }>();
      const distinctSchemas = new Set<string>();
      for (const oc of group) {
        const evKey = primaryEvidenceKey(oc.evidence);
        const schemaEdge = edges.find(
          (e) =>
            e.sourceId === oldId &&
            (e.entityType === 'READS' || e.entityType === 'MUTATES') &&
            Boolean(e.targetId) &&
            primaryEvidenceKey(e.evidence) === evKey
        );
        if (!schemaEdge?.targetId) continue;
        const targetSchema = nodeById.get(schemaEdge.targetId);
        if (!targetSchema) continue;
        const schemaName = targetSchema.name.replace(/^Drizzle Schema:\s*/i, '').trim();
        if (schemaName) {
          schemaByNode.set(oc, { schemaName, schemaEdge });
          distinctSchemas.add(schemaName);
        }
      }
      if (distinctSchemas.size >= 2) {
        for (const oc of group) {
          const entry = schemaByNode.get(oc);
          if (!entry) continue;
          const logicalScope = logicalScopeByConnector.get(oc) ?? '';
          const evKey = primaryEvidenceKey(oc.evidence);
          const newName = oc.name.endsWith('()')
            ? `${oc.name.slice(0, -2)}(${entry.schemaName})`
            : `${oc.name} (${entry.schemaName})`;
          const newId = stableEntityId(logicalScope, 'OPEN_CONNECTOR', newName);
          entry.schemaEdge.sourceId = newId;
          for (const e of edges) {
            if (e.targetId === oldId && primaryEvidenceKey(e.evidence) === evKey) {
              e.targetId = newId;
              if (e.name === `Call: ${oc.name}`) {
                e.name = `Call: ${newName}`;
              }
            }
          }
          oc.name = newName;
          oc.id = newId;
        }
      }
      continue;
    }

    // 3. Cross-platform twin DB client calls (`open-connector.db-call`, e.g. `screen.tsx` vs `screen.native.tsx`)
    if (sample.entityType === 'DB_QUERY' && sample.patternId === 'open-connector.db-call') {
      const platformByNode = new Map<StructuralNode, string>();
      let hasPlatformVariant = false;
      const distinctFiles = new Set<string>();
      for (const oc of group) {
        const firstEv = Array.isArray(oc.evidence) ? oc.evidence[0] : oc.evidence;
        const fp = firstEv?.filePath ? firstEv.filePath.replace(/\\/g, '/') : '';
        if (!fp) continue;
        distinctFiles.add(fp);
        const platMatch = /\.(native|ios|android|web)\.[cm]?[jt]sx?$/i.exec(fp);
        if (platMatch) {
          hasPlatformVariant = true;
          platformByNode.set(oc, platMatch[1].toLowerCase());
        }
      }
      if (hasPlatformVariant && distinctFiles.size >= 2) {
        for (const oc of group) {
          const plat = platformByNode.get(oc);
          if (!plat) continue;
          const logicalScope = logicalScopeByConnector.get(oc) ?? '';
          const evKey = primaryEvidenceKey(oc.evidence);
          const newName = `${oc.name} (${plat})`;
          const newId = stableEntityId(logicalScope, 'OPEN_CONNECTOR', newName);
          for (const e of edges) {
            if (e.targetId === oldId && primaryEvidenceKey(e.evidence) === evKey) {
              e.targetId = newId;
              if (e.name === `Call: ${oc.name}`) {
                e.name = `Call: ${newName}`;
              }
            }
          }
          oc.name = newName;
          oc.id = newId;
        }
      }
    }
  }
}

// ── Astro & SvelteKit Conventions (`[PAT-EXT-76]`) ───────────────────────────────────────────

const ASTRO_IN_FILE_EVIDENCE_RE =
  /\b(?:astro:|@astrojs\/|from\s+['"]astro['"]|APIRoute|GetStaticPaths)\b/;

/**
 * Extracts Astro route lifecycle (`getStaticPaths`) and file-based HTTP endpoint (`GET`, `POST`, ..., `ALL`)
 * contracts from files under `pages/**` or `src/pages/**` via `ASTRO_CONVENTIONS` (`[PAT-EXT-76]`).
 *
 * Non-`.astro` files under `pages/` require Astro project or in-file Astro import/type evidence so
 * Next.js Pages Router `pages/**` modules are never misclassified.
 *
 * @param node        - Candidate AST statement node.
 * @param sourceFile  - Enclosing TypeScript SourceFile.
 * @param filePath    - Repository-relative file path.
 * @param getEvidence - Evidence builder callback.
 * @param nextId      - Placeholder ID generator.
 * @returns Extracted Astro route contracts, or an empty array when inapplicable.
 *
 * @example
 * const contracts = extractAstroRouteContracts(stmt, sf, 'src/pages/rss.xml.ts', getEvidence, nextId);
 */
const astroRoleCache = new WeakMap<ts.SourceFile, Map<string, string | null>>();
const sveltekitRoleCache = new WeakMap<ts.SourceFile, Map<string, string | null>>();

function getCachedAstroRole(sourceFile: ts.SourceFile, filePath: string): string | null {
  let byPath = astroRoleCache.get(sourceFile);
  if (!byPath) {
    byPath = new Map();
    astroRoleCache.set(sourceFile, byPath);
  }
  if (byPath.has(filePath)) return byPath.get(filePath) ?? null;

  const hasDiskFile = Boolean(sourceFile.fileName && fs.existsSync(sourceFile.fileName));
  let role = classifyFileRole(
    ASTRO_CONVENTIONS,
    filePath,
    [],
    hasDiskFile ? { sourceFilePath: sourceFile.fileName } : undefined
  );
  if (!role && ASTRO_IN_FILE_EVIDENCE_RE.test(sourceFile.text)) {
    role = classifyFileRole(ASTRO_CONVENTIONS, filePath);
  }
  byPath.set(filePath, role);
  return role;
}

function getCachedSveltekitRole(sourceFile: ts.SourceFile, filePath: string): string | null {
  let byPath = sveltekitRoleCache.get(sourceFile);
  if (!byPath) {
    byPath = new Map();
    sveltekitRoleCache.set(sourceFile, byPath);
  }
  if (byPath.has(filePath)) return byPath.get(filePath) ?? null;

  const hasDiskFile = Boolean(sourceFile.fileName && fs.existsSync(sourceFile.fileName));
  const role = classifyFileRole(
    SVELTEKIT_CONVENTIONS,
    filePath,
    [],
    hasDiskFile ? { sourceFilePath: sourceFile.fileName } : undefined
  );
  byPath.set(filePath, role);
  return role;
}

export function extractAstroRouteContracts(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string | undefined,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity[] {
  if (
    !filePath ||
    (!ts.isFunctionDeclaration(node) && !ts.isVariableStatement(node)) ||
    !node.parent ||
    !ts.isSourceFile(node.parent)
  ) {
    return [];
  }
  const role = getCachedAstroRole(sourceFile, filePath);
  if (!role) return [];
  return applyConventionRules(
    ASTRO_CONVENTIONS,
    ['astro.lifecycle-export', 'astro.endpoint-handler'],
    node,
    role,
    filePath,
    getEvidence,
    nextId
  );
}

/**
 * Extracts SvelteKit route loaders (`load`), form actions (`actions`), server endpoints (`+server.*`),
 * and framework hooks (`hooks.server.*`, `hooks.client.*`, `src/hooks.*`) via `SVELTEKIT_CONVENTIONS` (`[PAT-EXT-76]`).
 *
 * @param node        - Candidate AST statement node.
 * @param sourceFile  - Enclosing TypeScript SourceFile.
 * @param filePath    - Repository-relative file path.
 * @param getEvidence - Evidence builder callback.
 * @param nextId      - Placeholder ID generator.
 * @returns Extracted SvelteKit contracts, or an empty array when inapplicable.
 *
 * @example
 * const contracts = extractSvelteKitContracts(stmt, sf, 'src/routes/+page.server.ts', getEvidence, nextId);
 */
export function extractSvelteKitContracts(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string | undefined,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity[] {
  if (
    !filePath ||
    (!ts.isFunctionDeclaration(node) && !ts.isVariableStatement(node)) ||
    !node.parent ||
    !ts.isSourceFile(node.parent)
  ) {
    return [];
  }
  const role = getCachedSveltekitRole(sourceFile, filePath);
  if (!role) return [];
  return applyConventionRules(
    SVELTEKIT_CONVENTIONS,
    [
      'sveltekit.load',
      'sveltekit.layout-load',
      'sveltekit.actions',
      'sveltekit.server-endpoint',
      'sveltekit.hooks',
    ],
    node,
    role,
    filePath,
    getEvidence,
    nextId
  );
}

/**
 * True when `filePath` is a SvelteKit route component (`+page.svelte`, `+layout.svelte`, or `+error.svelte`)
 * under `routes/` or `src/routes/`, marking its component contract with `flowRole: 'INGRESS'`.
 *
 * @param filePath - Relative or absolute path of the `.svelte` file.
 * @returns Whether the file is a SvelteKit route component entry point.
 *
 * @example
 * isSvelteKitRouteComponentFile('src/routes/+page.svelte') // true
 * isSvelteKitRouteComponentFile('src/lib/Card.svelte')     // false
 */
export function isSvelteKitRouteComponentFile(filePath?: string): boolean {
  if (!filePath || !filePath.toLowerCase().endsWith('.svelte')) return false;
  const role = classifyFileRole(SVELTEKIT_CONVENTIONS, filePath);
  return role === 'PAGE' || role === 'LAYOUT' || role === 'ERROR';
}

const SVELTE_RUNES = new Set([
  '$props',
  '$state',
  '$derived',
  '$effect',
  '$bindable',
  '$inspect',
  '$host',
]);

const SVELTE_RUNE_MEMBERS = new Set(['by', 'pre', 'root', 'tracking', 'raw', 'snapshot']);

/**
 * True when `call` is a Svelte 5 compiler-intrinsic rune invocation (`$props()`, `$state()`,
 * `$derived()`, `$derived.by()`, `$effect()`, `$effect.pre()`, etc.) inside a `.svelte` or
 * `.svelte.ts`/`.svelte.js` runes module (`[PAT-EXT-76]`).
 *
 * Runes are compile-time reactive primitives, not runtime function call edges.
 *
 * @param call - CallExpression AST node to inspect.
 * @returns Whether the call invokes a Svelte 5 rune intrinsic.
 *
 * @example
 * // In Counter.svelte: `let count = $state(0);`
 * isSvelteRuneCall(callNode) // true
 */
export function isSvelteRuneCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  const matchesRuneSyntax = ts.isIdentifier(callee)
    ? SVELTE_RUNES.has(callee.text)
    : ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      SVELTE_RUNES.has(callee.expression.text) &&
      SVELTE_RUNE_MEMBERS.has(callee.name.text);
  if (!matchesRuneSyntax) return false;

  const sfName = call.getSourceFile()?.fileName?.toLowerCase() ?? '';
  return sfName.endsWith('.svelte') || /\.svelte\.[cm]?[jt]s$/.test(sfName);
}

/**
 * Derives a deterministic PascalCase contract name (`Svg Component: <PascalName>`) for an in-repo
 * `.svg` asset imported and rendered as a JSX/Astro/Svelte component (`[PAT-EXT-76]`).
 *
 * @param svgFilePath - Relative or absolute path to the `.svg` file.
 * @returns Canonical `Svg Component: <PascalName>` contract name.
 *
 * @example
 * deriveSvgComponentContractName('src/assets/icons/IconCalendar.svg') // 'Svg Component: IconCalendar'
 */
export function deriveSvgComponentContractName(svgFilePath: string): string {
  const base = path.posix.basename(svgFilePath.replace(/\\/g, '/')).replace(/\.svg$/i, '');
  const pascal = base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `Svg Component: ${pascal || 'SvgAsset'}`;
}

/**
 * Computes the deterministic target `contractEntityId` and target evidence record for an in-repo
 * `.svg` file rendered as a component (`<IconCalendar />`) (`[PAT-EXT-76]`).
 *
 * @param resolvedSvgPath   - Repository-relative path to the `.svg` asset.
 * @param repoRoot          - Repository root directory.
 * @param workspaceRegistry - Optional monorepo workspace registry.
 * @returns Target contract ID and evidence record, or `null` if the `.svg` file does not exist.
 *
 * @example
 * resolveSvgComponentImportTarget('src/assets/icons/IconCalendar.svg', repoRoot)
 */
export function resolveSvgComponentImportTarget(
  resolvedSvgPath: string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): { targetId: string; evidences: EvidenceRecord[] } | null {
  const normRel = resolvedSvgPath.replace(/\\/g, '/');
  if (!normRel.toLowerCase().endsWith('.svg')) return null;
  const absPath = path.resolve(repoRoot, normRel);
  if (!fs.existsSync(absPath)) return null;

  let firstLineSnippet = '<svg>';
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const firstNonEmpty = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstNonEmpty) {
      firstLineSnippet = firstNonEmpty.slice(0, 80).replace(/\s+/g, ' ').trim();
    }
  } catch {
    // Fallback snippet when unreadable
  }

  const targetScope = resolveLogicalBoundaryScope(absPath, repoRoot, workspaceRegistry);
  const contractName = deriveSvgComponentContractName(normRel);
  const targetId = contractEntityId(
    targetScope,
    normRel,
    contractName,
    'contract.astro-svg-component-import'
  );
  return {
    targetId,
    evidences: [
      {
        filePath: normRel,
        lineNumber: 1,
        snippet: firstLineSnippet,
        evidenceRole: 'target-signature',
      },
    ],
  };
}

/**
 * Synthesizes `Svg Component: <PascalName>` (`REACT_COMPONENT`, `contract.astro-svg-component-import`)
 * contract nodes strictly for in-repo `.svg` files that are actually targeted by a `RENDERS` edge (`[PAT-EXT-76]`).
 *
 * Non-component `.svg` asset URL imports (`<img src={logo} />`) have no `RENDERS` edge targeting them
 * and therefore never materialize orphan `Svg Component` contracts.
 *
 * @param edges             - Extracted relationship edges prior to dangling-target pruning.
 * @param nodes             - Extracted structural nodes array (mutated in place with synthesized SVG contracts).
 * @param repoRoot          - Repository root directory.
 * @param workspaceRegistry - Optional monorepo workspace registry.
 * @param fallbackRootLabel - Fallback root deployment-unit label.
 *
 * @example
 * collectReferencedSvgComponentNodes(edges, nodes, actualRepoRoot, workspaceRegistry, rootLabel);
 */
export function collectReferencedSvgComponentNodes(
  edges: readonly StructuralEdge[],
  nodes: StructuralNode[],
  repoRoot: string,
  workspaceRegistry: WorkspaceRegistry | undefined,
  fallbackRootLabel: string
): void {
  const existingNodeIds = new Set(nodes.map((n) => n.id));
  const hasSubPackages = Object.keys(workspaceRegistry ?? {}).length > 0;

  for (const edge of edges) {
    if (edge.entityType !== 'RENDERS' || !edge.targetId || existingNodeIds.has(edge.targetId)) {
      continue;
    }
    const evList = Array.isArray(edge.evidence) ? edge.evidence : [edge.evidence];
    const svgEv = evList.find(
      (ev) =>
        ev?.evidenceRole === 'target-signature' &&
        typeof ev.filePath === 'string' &&
        ev.filePath.toLowerCase().endsWith('.svg')
    );
    if (!svgEv) continue;

    const normRel = svgEv.filePath.replace(/\\/g, '/');
    const absSvgPath = path.resolve(repoRoot, normRel);
    const resolvedBoundary = resolveBoundaryForFile(
      absSvgPath,
      repoRoot,
      workspaceRegistry,
      fallbackRootLabel
    );
    const targetScope = resolveLogicalBoundaryScope(absSvgPath, repoRoot, workspaceRegistry);
    const contractName = deriveSvgComponentContractName(normRel);
    const expectedId = contractEntityId(
      targetScope,
      normRel,
      contractName,
      'contract.astro-svg-component-import'
    );
    if (edge.targetId !== expectedId) continue;

    const duId = stableEntityId(
      `deployment-unit:${resolvedBoundary.label}`,
      'BOUNDARY',
      `Deployment Unit: ${resolvedBoundary.label}`
    );
    const isUnmatchedRootFile =
      hasSubPackages && !resolvedBoundary.isWorkspaceMatch && !resolvedBoundary.isSubBoundary;
    if (!existingNodeIds.has(duId) && !isUnmatchedRootFile) {
      nodes.push({
        id: duId,
        name: `Deployment Unit: ${resolvedBoundary.label}`,
        type: 'BOUNDARY',
        entityType: 'DEPLOYMENT_UNIT',
        patternId: 'boundary.deployment-unit',
        scope: 'USER',
        evidence: { filePath: resolvedBoundary.evidencePath },
      });
      existingNodeIds.add(duId);
    }

    nodes.push({
      id: expectedId,
      name: contractName,
      type: 'CONTRACT',
      entityType: 'REACT_COMPONENT',
      patternId: 'contract.astro-svg-component-import',
      ...(isUnmatchedRootFile ? {} : { parentBoundaryId: duId }),
      scope: edge.scope ?? 'USER',
      evidence: {
        filePath: normRel,
        lineNumber: svgEv.lineNumber ?? 1,
        snippet: svgEv.snippet,
      },
    });
    existingNodeIds.add(expectedId);
  }
}

export { deriveSvelteComponentName };



