// packages/core/src/extractor/conventions/index.ts
//
// Registry of every framework convention set. Adding a framework = adding its set here.

import ts from 'typescript';
import type { ConventionSet } from './types.js';
import { unwrapWrappedFunction } from './engine.js';
import { NEXTJS_CONVENTIONS } from './nextjs.js';
import { REACT_CONVENTIONS, FUNCTION_MEMO_WRAPPERS } from './react.js';
import { EXPRESS_CONVENTIONS } from './express.js';
import { MCP_CONVENTIONS } from './mcp.js';
import { DRIZZLE_CONVENTIONS } from './drizzle.js';
import { PAYLOAD_CONVENTIONS } from './payload.js';
import { ASTRO_CONVENTIONS } from './astro.js';
import { SVELTEKIT_CONVENTIONS } from './sveltekit.js';
import { CORE_CONVENTIONS } from './core.js';

export * from './types.js';
export {
  applyConventionRules,
  applyConventionRulesDetailed,
  applyEdgeRules,
  classifyFileRole,
  describeConventionSchema,
  describeConventions,
  isValidVersionRange,
  resolveInstalledFrameworkVersions,
  runConventionEdges,
  runConventionNodes,
  satisfiesConventionVersion,
  unwrapWrappedFunction,
  validateConventionSet,
} from './engine.js';
export type {
  ConventionCatalogRow,
  ConventionEdgeMatcherDoc,
  ConventionNodeMatcherDoc,
  ConventionSchemaReference,
  AppliedConvention,
} from './engine.js';
export { createConventionConfigResolver, loadUserConventionSets } from './config.js';
export type { ConventionConfigResolver, UnresolvedConfig } from './config.js';
export { NEXTJS_CONVENTIONS, nextjsRoutePath, nextjsLayoutPath } from './nextjs.js';
export { REACT_CONVENTIONS, REACT_HOC_WRAPPERS, FUNCTION_MEMO_WRAPPERS } from './react.js';

function unwrapExpr(expr: ts.Expression): ts.Expression {
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
 * Unwraps a memoizing/caching function wrapper call (`cache(fn)`, `React.cache(fn)`, `unstable_cache(fn)`,
 * `memoize(fn)`, `once(fn)`, `debounce(fn)`, `throttle(fn)`) to its inner function declaration or expression.
 */
export function unwrapCachedFunctionInitializer(
  expr: ts.Expression,
  sourceFile?: ts.SourceFile
): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null {
  const unwrapped = unwrapExpr(expr);
  const direct = unwrapWrappedFunction(unwrapped, FUNCTION_MEMO_WRAPPERS, sourceFile);
  if (direct) return direct;
  if (ts.isCallExpression(unwrapped) && unwrapped.arguments.length > 0) {
    const callee = unwrapExpr(unwrapped.expression);
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        ? `${callee.expression.text}.${callee.name.text}`
        : null;
    if (calleeName && (FUNCTION_MEMO_WRAPPERS as readonly string[]).includes(calleeName)) {
      const arg0 = unwrapExpr(unwrapped.arguments[0]);
      if (ts.isArrowFunction(arg0) || ts.isFunctionExpression(arg0)) {
        return arg0;
      }
    }
  }
  return null;
}

/**
 * Resolves a local identifier in `sourceFile` to a top-level VariableDeclaration initialized
 * with a cached/memoized function wrapper (`const fn = cache(...)`).
 */
export function findSameFileCachedFunctionDeclaration(
  name: string,
  sourceFile: ts.SourceFile
): {
  stmt: ts.VariableStatement;
  decl: ts.VariableDeclaration;
  innerFn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
} | null {
  for (const s of sourceFile.statements) {
    if (ts.isVariableStatement(s)) {
      for (const decl of s.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          const innerFn = unwrapCachedFunctionInitializer(decl.initializer, sourceFile);
          if (innerFn) {
            return { stmt: s, decl, innerFn };
          }
        }
      }
    }
  }
  return null;
}
export { EXPRESS_CONVENTIONS, EXPRESS_ROUTE_METHODS, HTTP_CLIENT_IDENTIFIERS } from './express.js';
export { KNOWN_HTTP_CLIENT_IDENTIFIERS, isHttpClientReceiver } from './engine.js';
export { MCP_CONVENTIONS } from './mcp.js';
export {
  DRIZZLE_CONVENTIONS,
  DRIZZLE_SCHEMA_BUILDERS,
  DRIZZLE_CLIENT_ROOTS,
  DRIZZLE_ENTRY_METHODS,
  DRIZZLE_SCHEMA_ARG_METHODS,
  DRIZZLE_MUTATE_METHODS,
  DRIZZLE_RELATIONAL_QUERY_METHODS,
} from './drizzle.js';
export {
  PAYLOAD_CONVENTIONS,
  PAYLOAD_HOOK_NAMES,
  PAYLOAD_TRANSACTION_FNS,
  PAYLOAD_DB_ADAPTER_METHODS,
  PAYLOAD_DB_ADAPTER_MUTATE_METHODS,
  PAYLOAD_LOCAL_API_METHODS,
  PAYLOAD_LOCAL_API_MUTATE_METHODS,
  PAYLOAD_MONGOOSE_METHODS,
  PAYLOAD_SCHEMA_OBJECT_KEYS,
} from './payload.js';
export { CORE_CONVENTIONS } from './core.js';
export {
  ASTRO_CONVENTIONS,
  ASTRO_ENDPOINT_METHODS,
  ASTRO_LIFECYCLE_EXPORTS,
  astroRoutePath,
} from './astro.js';
export {
  SVELTEKIT_CONVENTIONS,
  SVELTEKIT_ENDPOINT_METHODS,
  SVELTEKIT_HOOK_EXPORTS,
  sveltekitRoutePath,
  sveltekitLayoutPath,
  deriveSvelteComponentName,
} from './sveltekit.js';
export {
  ROUTE_HTTP_METHODS,
  ROUTE_HANDLER_CONTRACT_PATTERN_ID,
  HTTP_ROUTE_CONTRACT_PATTERN_ID,
  HTTP_ROUTE_HANDLER_EDGE_PATTERN_ID,
  HTTP_ROUTE_MIDDLEWARE_EDGE_PATTERN_ID,
  HTTP_ROUTER_MOUNT_EDGE_PATTERN_ID,
  FRAMEWORK_HOOK_MODULES,
  DI_CONTAINER_PACKAGES,
  ORM_AND_BROKER_CLIENT_IDENTIFIERS,
  ROUTER_FACTORY_CALLEES,
  ROUTER_AND_COMMAND_FACTORY_CALLEES,
  REMIX_INGRESS_EXPORTS,
  deriveVueSfcComponentName,
  matchFrameworkDbClientFactoryCall,
  isFrameworkIngressExport,
  stripPayloadPluginPrefix,
  parseRouterMountEdgeName,
  parseFrameworkHttpRouteNodeName,
  isStyledComponentInitializer,
  isReactContextInitializer,
  isRouterFactoryInitializer,
  isRouterOrCliCommandFactoryInitializer,
  isAstroApiRouteExport,
  isNextjsAppSpecialFile,
  isRemixRouteFile,
  isAstroPageFile,
  isVueOrNuxtPageFile,
  isNuxtPluginOrMiddlewareDefaultCall,
  isPiniaDefineStoreInitializer,
  matchExportedFactoryCallConstantPattern,
  isMdxOrAstroFilePath,
  isTopLevelCliEntryInvocation,
  findTopLevelCliInvocationStatements,
  extractTopLevelCommanderActionContract,
  extractNodeHttpRouteBranchContract,
  extractHonoOpenApiRouteContract,
  extractRpcRouterProcedureContract,
  disambiguateCollidingOpenConnectors,
  BUILTIN_DOM_ITERATOR_REFLECTION_METHODS,
  ORM_SCHEMA_LIFECYCLE_METHODS,
  unwrapTransparentFunctionWrapperCall,
  isBindWrappedLocalExpression,
  isMongooseSchemaOrModelCall,
  extractMongooseModelContract,
  inferCacheOrDbDialectFromBinding,
  ORM_MODEL_QUERY_PATTERN_ID,
  isOrmModelOrConnectionTypeName,
  extractAstroRouteContracts,
  extractSvelteKitContracts,
  isSvelteKitRouteComponentFile,
  isSvelteRuneCall,
  deriveSvgComponentContractName,
  resolveSvgComponentImportTarget,
  collectReferencedSvgComponentNodes,
} from './frameworks.js';

/** Every registered convention set. */
export const CONVENTION_SETS: readonly ConventionSet[] = [
  NEXTJS_CONVENTIONS,
  REACT_CONVENTIONS,
  EXPRESS_CONVENTIONS,
  MCP_CONVENTIONS,
  DRIZZLE_CONVENTIONS,
  PAYLOAD_CONVENTIONS,
  ASTRO_CONVENTIONS,
  SVELTEKIT_CONVENTIONS,
  CORE_CONVENTIONS,
];
