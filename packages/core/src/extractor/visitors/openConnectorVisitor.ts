/**
 * @file openConnectorVisitor.ts
 * Framework-agnostic and system-boundary Open Connector AST visitor (`OPEN_CONNECTOR` primitive).
 * Extracts external package imports, Node built-in modules, HTTP client calls (`fetch`, `axios`),
 * database client invocations, subprocess execution, filesystem mutations, raw socket egress,
 * dynamic imports/evals, and intra-repo HTTP protocol stitching (`[PAT-EXT-23]`, `[PAT-EXT-26]`).
 */
import { builtinModules } from 'module';
import ts from 'typescript';
import { EvidenceRecord, StructuralEdge, StructuralEntity, StructuralNode } from '../../types/index.js';
import { extractExpressAppListen, extractExpressResponseCookie } from '../adapters/expressAdapter.js';
import { extractDrizzleQueryChain, isInnerDrizzleQueryChainCall } from '../adapters/drizzleAdapter.js';
import { extractNextjsRevalidate } from '../adapters/nextjsAdapter.js';
import { extractPayloadOpenConnectors } from '../adapters/payloadAdapter.js';
import { extractEventEmitterEmit, extractPluginHookFire } from './eventEmitterVisitor.js';
import {
  findModuleBinding,
  findValueModuleBinding,
  getPropertyOrElementAccess,
  getSourceFileDeclarationIndex,
  isExternalSpecifier,
  isNodeBuiltinSpecifier,
  normalizePackageSpecifier,
  resolvePublicMethodTarget,
  resolvesToLocalModuleCallableContract,
  unwrapRequire,
} from './targetResolver.js';
import {
  HTTP_ROUTER_MOUNT_EDGE_PATTERN_ID,
  ORM_AND_BROKER_CLIENT_IDENTIFIERS,
  ORM_MODEL_QUERY_PATTERN_ID,
  ORM_SCHEMA_LIFECYCLE_METHODS,
  inferCacheOrDbDialectFromBinding,
  isMongooseSchemaOrModelCall,
  isOrmModelOrConnectionTypeName,
  matchFrameworkDbClientFactoryCall,
  parseFrameworkHttpRouteNodeName,
  parseRouterMountEdgeName,
  unwrapTransparentFunctionWrapperCall,
} from '../conventions/index.js';
import { WorkspaceRegistry } from '../workspaceResolver.js';
/**
 * Known HTTP / network client root identifiers.
 * Matched against the root object of a call expression (e.g. `axios` in `axios.get(...)`).
 */
export const HTTP_CLIENT_IDENTIFIERS = new Set([
  'fetch',
  'axios',
  'got',
  'superagent',
  'needle',
  'request',
  'ky',
  'XMLHttpRequest',
  's3',
  'r2',
  's3Client',
  'r2Client',
]);

const S3_CLIENT_CONSTRUCTORS = new Set(['S3', 'S3Client']);

const S3_CLIENT_METHODS = new Set([
  'upload',
  'putObject',
  'getObject',
  'deleteObject',
  'deleteObjects',
  'headObject',
  'copyObject',
  'listObjects',
  'listObjectsV2',
  'listBuckets',
  'createBucket',
  'deleteBucket',
  'getSignedUrl',
  'getSignedUrlPromise',
  'send',
]);

const BARE_NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

/**
 * Known HTTP request execution methods.
 * Calls to an HTTP client with a member access must invoke one of these methods to be considered an HTTP fetch.
 * Non-fetch methods (e.g. `create`, `use`, `all`, `spread`, `CancelToken`, `isAxiosError`) are excluded.
 */
export const HTTP_REQUEST_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
  'request',
]);

/**
 * Known database, ORM, and message-broker root identifiers.
 * Matched against the root object of a call expression (e.g. `prisma` in `prisma.user.findMany(...)`).
 */
export const DB_CLIENT_IDENTIFIERS = new Set<string>([
  // ORMs, database SDKs, and message brokers from convention tables
  ...ORM_AND_BROKER_CLIENT_IDENTIFIERS,
  // Raw DB clients
  'pg',
  'pg-pool',
  'postgres',
  '@neondatabase/serverless',
  '@vercel/postgres',
  '@electric-sql/pglite',
  'mysql',
  'mysql2',
  '@planetscale/database',
  'sqlite3',
  'better-sqlite3',
  '@libsql/client',
  'sql.js',
  'mongodb',
  'db',
  'Database',
  'redis',
  'ioredis',
  '@upstash/redis',
  'dynamodb',
  // Message brokers / queues
  'amqplib',
  'kafka',
  'kafkajs',
  'nats',
]);

/**
 * Non-query lifecycle/listener methods on database pools or clients (`pool.on(...)`, `client.release()`)
 * that should NOT be emitted as `DB_QUERY` Open Connectors.
 */
const DB_NON_QUERY_LIFECYCLE_METHODS = new Set([
  'on',
  'once',
  'off',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'release',
  'end',
  'unref',
  'ref',
  'headers',
  'use',
  // Standard JS Array/Object prototype methods on loaded entity properties (e.g. `comment.author.followedBy.some(...)`)
  'some',
  'every',
  'forEach',
  'map',
  'filter',
  'reduce',
  'reduceRight',
  'includes',
  'indexOf',
  'findIndex',
  'flatMap',
  'slice',
  'splice',
  'concat',
  'join',
  'sort',
  'reverse',
  'push',
  'pop',
  'shift',
  'unshift',
  'toString',
  'valueOf',
  'toJSON',
]);

/**
 * Known subprocess execution module/alias root identifiers (`[PAT-EXT-17]`).
 */
export const SUBPROCESS_CLIENT_IDENTIFIERS = new Set([
  'child_process',
  'childProcess',
  'cp',
]);

/**
 * Known subprocess execution methods on `node:child_process` (`[PAT-EXT-17]`).
 */
export const SUBPROCESS_METHODS = new Set([
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
  'fork',
]);

/**
 * Known filesystem client root identifiers (`[PAT-EXT-17]`).
 */
export const FS_CLIENT_IDENTIFIERS = new Set([
  'fs',
  'fsPromises',
  'fsp',
]);

/**
 * Known filesystem mutation/write methods (`[PAT-EXT-17]`).
 * Read-only methods (`readFileSync`, `existsSync`, `statSync`, `readdirSync`) are excluded.
 */
export const FS_MUTATION_METHODS = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'mkdir',
  'mkdirSync',
  'rmdir',
  'rmdirSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createWriteStream',
  // fs-extra mutation methods
  'copy',
  'copySync',
  'ensureDir',
  'ensureDirSync',
  'emptyDir',
  'emptyDirSync',
  'outputFile',
  'outputFileSync',
  'outputJson',
  'outputJsonSync',
  'outputJSON',
  'outputJSONSync',
  'writeJson',
  'writeJsonSync',
  'writeJSON',
  'writeJSONSync',
  'remove',
  'removeSync',
  'move',
  'moveSync',
]);

/**
 * Known raw socket client module root identifiers (`[PAT-EXT-17]`).
 */
export const SOCKET_CLIENT_IDENTIFIERS = new Set([
  'net',
  'tls',
]);

/**
 * Known raw socket connection methods on `node:net` / `node:tls` (`[PAT-EXT-17]`).
 */
export const SOCKET_CONNECT_METHODS = new Set([
  'connect',
  'createConnection',
]);

/**
 * Known WebSocket constructor identifiers (`[PAT-EXT-17]`).
 */
export const SOCKET_CONSTRUCTOR_IDENTIFIERS = new Set([
  'WebSocket',
]);

type ClientAliasKind = 'HTTP' | 'DB' | 'SUBPROCESS' | 'FS' | 'FS_PROMISES' | 'SOCKET';

interface LocalClientBindings {
  aliases: Map<string, ClientAliasKind>;
  modelAliases: Set<string>;
  dbStatementAliases: Map<string, { rootClient: string; initMethod: string }>;
  subprocessFns: Map<string, string>;
  fsMutationFns: Map<string, { methodName: string; isPromises: boolean }>;
  socketFns: Map<string, { moduleName: string; methodName: string }>;
}

function classifyBuiltinModuleSpecifier(specifier: string): ClientAliasKind | null {
  const clean = specifier.replace(/^node:/, '');
  if (clean === 'child_process') return 'SUBPROCESS';
  if (clean === 'fs/promises') return 'FS_PROMISES';
  if (clean === 'fs' || clean === 'fs-extra') return 'FS';
  if (clean === 'net' || clean === 'tls') return 'SOCKET';
  if (DB_CLIENT_IDENTIFIERS.has(clean)) return 'DB';
  if (HTTP_CLIENT_IDENTIFIERS.has(clean)) return 'HTTP';
  return null;
}

const localClientBindingsCache = new WeakMap<ts.SourceFile, LocalClientBindings>();

/**
 * Resolves local variable aliases and named-import bindings initialized from known HTTP, DB,
 * subprocess, filesystem, and raw socket clients in the same SourceFile (`[PAT-EXT-17]`, `[PAT-EXT-31]`).
 */
function collectLocalClientBindings(sourceFile: ts.SourceFile): LocalClientBindings {
  const cached = localClientBindingsCache.get(sourceFile);
  if (cached) return cached;

  const aliases = new Map<string, ClientAliasKind>();
  const modelAliases = new Set<string>();
  const dbStatementAliases = new Map<string, { rootClient: string; initMethod: string }>();
  const subprocessFns = new Map<string, string>();
  const fsMutationFns = new Map<string, { methodName: string; isPromises: boolean }>();
  const socketFns = new Map<string, { moduleName: string; methodName: string }>();

  const registerNamedBinding = (localName: string, importedName: string, modKind: ClientAliasKind, rawSpecifier: string) => {
    if (modKind === 'SUBPROCESS' && SUBPROCESS_METHODS.has(importedName)) {
      subprocessFns.set(localName, importedName);
    } else if ((modKind === 'FS' || modKind === 'FS_PROMISES') && FS_MUTATION_METHODS.has(importedName)) {
      fsMutationFns.set(localName, { methodName: importedName, isPromises: modKind === 'FS_PROMISES' });
    } else if (modKind === 'SOCKET' && SOCKET_CONNECT_METHODS.has(importedName)) {
      const moduleName = rawSpecifier.replace(/^node:/, '') === 'tls' ? 'tls' : 'net';
      socketFns.set(localName, { moduleName, methodName: importedName });
    } else if (modKind === 'DB' || modKind === 'HTTP') {
      aliases.set(localName, modKind);
    }
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.importClause) {
      const spec = stmt.moduleSpecifier.text;
      const modKind = classifyBuiltinModuleSpecifier(spec);
      if (!modKind) continue;

      if (stmt.importClause.name) {
        aliases.set(stmt.importClause.name.text, modKind);
      }
      const bindings = stmt.importClause.namedBindings;
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) {
          aliases.set(bindings.name.text, modKind);
        } else if (ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const localName = el.name.text;
            const importedName = el.propertyName ? el.propertyName.text : el.name.text;
            registerNamedBinding(localName, importedName, modKind, spec);
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(stmt) &&
      stmt.moduleReference &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression &&
      ts.isStringLiteral(stmt.moduleReference.expression)
    ) {
      const spec = stmt.moduleReference.expression.text;
      const modKind = classifyBuiltinModuleSpecifier(spec);
      if (modKind) {
        aliases.set(stmt.name.text, modKind);
      }
    }
  }

  const visit = (n: ts.Node) => {
    if (
      (ts.isPropertyDeclaration(n) || ts.isParameter(n)) &&
      ts.isIdentifier(n.name)
    ) {
      let isTypeOrmRepoOrManager = false;
      let isMongooseOrSequelizeModel = false;
      if (ts.canHaveDecorators(n)) {
        const decorators = ts.getDecorators(n);
        if (decorators) {
          for (const dec of decorators) {
            const decExpr = dec.expression;
            const decName = ts.isCallExpression(decExpr) && ts.isIdentifier(decExpr.expression)
              ? decExpr.expression.text
              : ts.isIdentifier(decExpr)
                ? decExpr.text
                : null;
            if (decName === 'InjectRepository' || decName === 'InjectDataSource' || decName === 'InjectEntityManager') {
              isTypeOrmRepoOrManager = true;
              break;
            }
            if (decName === 'InjectModel' || decName === 'InjectConnection') {
              isTypeOrmRepoOrManager = true;
              isMongooseOrSequelizeModel = true;
              break;
            }
          }
        }
      }
      if (!isTypeOrmRepoOrManager && n.type && ts.isTypeReferenceNode(n.type) && ts.isIdentifier(n.type.typeName)) {
        const typeName = n.type.typeName.text;
        if (
          typeName === 'Repository' ||
          typeName === 'TreeRepository' ||
          typeName === 'MongoRepository' ||
          typeName === 'DataSource' ||
          typeName === 'EntityManager'
        ) {
          isTypeOrmRepoOrManager = true;
        } else if (isOrmModelOrConnectionTypeName(typeName)) {
          isTypeOrmRepoOrManager = true;
          isMongooseOrSequelizeModel = true;
        }
      }
      if (isTypeOrmRepoOrManager) {
        aliases.set(n.name.text, 'DB');
        if (isMongooseOrSequelizeModel) {
          modelAliases.add(n.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      let initExpr: ts.Expression = n.initializer;
      let wasAwaited = false;
      while (ts.isAwaitExpression(initExpr) || ts.isParenthesizedExpression(initExpr)) {
        if (ts.isAwaitExpression(initExpr)) wasAwaited = true;
        initExpr = initExpr.expression;
      }
      const unwrappedFnWrapper = unwrapTransparentFunctionWrapperCall(initExpr);
      if (unwrappedFnWrapper) {
        initExpr = unwrappedFnWrapper;
      }

      // Check require('node:child_process') / require('node:fs') / require('pg') / util.promisify(require('child_process').exec)
      const unwrappedReq = unwrapRequire(initExpr);
      if (unwrappedReq) {
        const spec = unwrappedReq.specifier;
        const modKind = classifyBuiltinModuleSpecifier(spec);
        if (modKind) {
          if (ts.isIdentifier(n.name)) {
            if (unwrappedReq.member) {
              registerNamedBinding(n.name.text, unwrappedReq.member, modKind, spec);
            } else {
              aliases.set(n.name.text, modKind);
            }
          } else if (ts.isObjectBindingPattern(n.name) && !unwrappedReq.member) {
            for (const el of n.name.elements) {
              if (ts.isIdentifier(el.name)) {
                const localName = el.name.text;
                const importedName =
                  el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : localName;
                registerNamedBinding(localName, importedName, modKind, spec);
              }
            }
          }
        }
      } else if (
        ts.isObjectBindingPattern(n.name) &&
        ts.isCallExpression(initExpr) &&
        ts.isIdentifier(initExpr.expression) &&
        /^(?:useServer|useApi|useHttp|useAxios|useHttpClient)$/.test(initExpr.expression.text)
      ) {
        for (const el of n.name.elements) {
          if (ts.isIdentifier(el.name)) {
            const propName =
              el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            if (['endpoint', 'api', 'client', 'http', 'axios'].includes(propName)) {
              aliases.set(el.name.text, 'HTTP');
            }
          }
        }
      } else if (ts.isIdentifier(n.name)) {
        const varName = n.name.text;
        let initRoot: string | null = null;
        let initMethod: string | null = null;
        if (ts.isIdentifier(initExpr)) {
          initRoot = initExpr.text;
          if (subprocessFns.has(initRoot)) {
            subprocessFns.set(varName, subprocessFns.get(initRoot)!);
          }
          if (fsMutationFns.has(initRoot)) {
            fsMutationFns.set(varName, fsMutationFns.get(initRoot)!);
          }
        } else if (ts.isCallExpression(initExpr) && !isMongooseSchemaOrModelCall(initExpr, sourceFile)) {
          if (ts.isIdentifier(initExpr.expression)) {
            const matchedDbClient = matchFrameworkDbClientFactoryCall(initExpr.expression.text);
            if (matchedDbClient) {
              initRoot = matchedDbClient;
              initMethod = initExpr.expression.text;
            }
          }
          const access = getPropertyOrElementAccess(initExpr.expression);
          if (access) {
            const isDirectRootClientFactory =
              !wasAwaited &&
              ts.isIdentifier(access.expression) &&
              (access.memberName === 'create' || access.memberName === 'extend');
            const isConnectionOrStatementFactory =
              access.memberName === 'connect' ||
              access.memberName === 'createConnection' ||
              access.memberName === 'createPool' ||
              access.memberName === 'createClient' ||
              access.memberName === 'prepare' ||
              access.memberName === 'transaction' ||
              access.memberName === 'from' ||
              access.memberName === 'table' ||
              access.memberName === 'collection';
            const isUnawaitedQueryBuilder =
              !wasAwaited &&
              (access.memberName === 'query' ||
                access.memberName === 'select' ||
                access.memberName === 'insert' ||
                access.memberName === 'update' ||
                access.memberName === 'delete');
            if (isDirectRootClientFactory || isConnectionOrStatementFactory || isUnawaitedQueryBuilder) {
              initRoot = getRootIdentifier(access.expression);
              initMethod = access.memberName;
            } else if (
              modelAliases.size > 0 &&
              (access.memberName === 'findOne' ||
                access.memberName === 'findByPk' ||
                access.memberName === 'findById' ||
                access.memberName === 'create')
            ) {
              const recvRoot = getRootIdentifier(access.expression);
              if (
                (recvRoot && modelAliases.has(recvRoot)) ||
                access.expression.kind === ts.SyntaxKind.ThisKeyword
              ) {
                aliases.set(varName, 'DB');
                modelAliases.add(varName);
              }
            }
          }
        } else if (ts.isNewExpression(initExpr) && !isMongooseSchemaOrModelCall(initExpr, sourceFile)) {
          const ctorAccess = getPropertyOrElementAccess(initExpr.expression);
          const ctorName = ctorAccess
            ? ctorAccess.memberName
            : ts.isIdentifier(initExpr.expression)
              ? initExpr.expression.text
              : null;
          if (ctorName && S3_CLIENT_CONSTRUCTORS.has(ctorName)) {
            aliases.set(varName, 'HTTP');
          } else {
            initRoot = getRootIdentifier(initExpr.expression);
            if (initRoot && modelAliases.has(initRoot)) {
              modelAliases.add(varName);
            }
          }
        }
        if (initRoot) {
          const inherited = aliases.get(initRoot);
          if (HTTP_CLIENT_IDENTIFIERS.has(initRoot) || inherited === 'HTTP') aliases.set(varName, 'HTTP');
          else if (DB_CLIENT_IDENTIFIERS.has(initRoot) || inherited === 'DB') {
            aliases.set(varName, 'DB');
            if (initMethod === 'prepare' || initMethod === 'transaction') {
              const prevStmt = dbStatementAliases.get(initRoot);
              dbStatementAliases.set(varName, {
                rootClient: prevStmt ? prevStmt.rootClient : initRoot,
                initMethod,
              });
            }
          }
          else if (SUBPROCESS_CLIENT_IDENTIFIERS.has(initRoot) || inherited === 'SUBPROCESS') aliases.set(varName, 'SUBPROCESS');
          else if (FS_CLIENT_IDENTIFIERS.has(initRoot) || inherited === 'FS' || inherited === 'FS_PROMISES') {
            aliases.set(varName, initRoot === 'fsPromises' || initRoot === 'fsp' || inherited === 'FS_PROMISES' ? 'FS_PROMISES' : 'FS');
          } else if (SOCKET_CLIENT_IDENTIFIERS.has(initRoot) || inherited === 'SOCKET') aliases.set(varName, 'SOCKET');
        }
      }
    } else if (ts.isCallExpression(n) && n.arguments.length > 0) {
      const access = getPropertyOrElementAccess(n.expression);
      if (access && access.memberName === 'transaction') {
        const txRoot = getRootIdentifier(access.expression);
        if (txRoot && (DB_CLIENT_IDENTIFIERS.has(txRoot) || aliases.get(txRoot) === 'DB')) {
          const cb = n.arguments[0];
          if (
            (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
            cb.parameters.length > 0 &&
            ts.isIdentifier(cb.parameters[0].name)
          ) {
            aliases.set(cb.parameters[0].name.text, 'DB');
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sourceFile, visit);
  const result: LocalClientBindings = {
    aliases,
    modelAliases,
    dbStatementAliases,
    subprocessFns,
    fsMutationFns,
    socketFns,
  };
  localClientBindingsCache.set(sourceFile, result);
  return result;
}

function isInsideDecorator(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isDecorator(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

function bindingPatternBindsName(nameNode: ts.BindingName, targetName: string): boolean {
  if (ts.isIdentifier(nameNode)) return nameNode.text === targetName;
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) {
      if (ts.isBindingElement(el) && bindingPatternBindsName(el.name, targetName)) {
        return true;
      }
    }
  }
  return false;
}

function isEnclosingFunctionParameter(node: ts.Node, paramName: string): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      for (const param of cur.parameters) {
        if (bindingPatternBindsName(param.name, paramName)) {
          return true;
        }
      }
    }
    if (ts.isBlock(cur)) {
      for (const stmt of cur.statements) {
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (bindingPatternBindsName(decl.name, paramName)) {
              const req = decl.initializer ? unwrapRequire(decl.initializer) : null;
              if (!req || req.specifier !== paramName) {
                return true;
              }
            }
          }
        }
      }
    }
    cur = cur.parent;
  }
  return false;
}

function isLocalCustomRequestHelper(
  rootId: string,
  sourceFile: ts.SourceFile,
  repoRoot?: string,
  workspaceRegistry?: WorkspaceRegistry
): boolean {
  if (rootId !== 'request') return false;
  if (getSourceFileDeclarationIndex(sourceFile).functionDeclsByName.has('request')) {
    return true;
  }
  const binding = findValueModuleBinding(sourceFile, 'request');
  if (
    binding &&
    repoRoot !== undefined &&
    !isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
  ) {
    return true;
  }
  return false;
}

/**
 * True when `rootId` is a known HTTP/DB client identifier or a local variable alias
 * initialized from one (e.g. `const stmt = db.prepare(...)`) in `sourceFile` (`[PAT-EXT-17]`).
 */
export function isLocalOpenConnectorClient(
  rootId: string,
  sourceFile: ts.SourceFile,
  memberName?: string,
  repoRoot?: string,
  workspaceRegistry?: WorkspaceRegistry
): boolean {
  if (
    memberName &&
    repoRoot &&
    resolvesToLocalModuleCallableContract(rootId, memberName, sourceFile, repoRoot, workspaceRegistry)
  ) {
    return false;
  }
  if (memberName && DB_NON_QUERY_LIFECYCLE_METHODS.has(memberName)) {
    const binding = findValueModuleBinding(sourceFile, rootId);
    if (
      binding &&
      repoRoot !== undefined &&
      !isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
    ) {
      return false;
    }
  }
  if (isLocalCustomRequestHelper(rootId, sourceFile, repoRoot, workspaceRegistry)) {
    return false;
  }
  if (HTTP_CLIENT_IDENTIFIERS.has(rootId) || DB_CLIENT_IDENTIFIERS.has(rootId)) return true;
  const bindings = collectLocalClientBindings(sourceFile);
  const kind = bindings.aliases.get(rootId);
  return kind === 'HTTP' || kind === 'DB';
}

/**
 * Extracts the root object identifier from a call expression, unwrapping `this.<client>` and static bracket accesses.
 *
 * Examples:
 *   fetch(...)                  → 'fetch'
 *   axios.get(...)              → 'axios'
 *   axios['get'](...)           → 'axios'
 *   prisma.user.findMany(...)   → 'prisma'
 *   this.db.prepare(...)        → 'db'
 *   queryString.parse(...)      → 'queryString'  ← correctly NOT in either allowlist
 */
function getRootIdentifier(expression: ts.Expression): string | null {
  let expr = expression;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAwaitExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isAsExpression(expr)
  ) {
    expr = expr.expression;
  }
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const rightRoot = getRootIdentifier(expr.right);
    if (rightRoot === 'fetch') return 'fetch';
    const leftRoot = getRootIdentifier(expr.left);
    if (leftRoot === 'fetch') return 'fetch';
  }
  if (ts.isTaggedTemplateExpression(expr)) {
    const tag = expr.tag;
    if (
      (ts.isIdentifier(tag) && tag.text === 'sql') ||
      (ts.isPropertyAccessExpression(tag) && tag.name.text === 'sql')
    ) {
      return 'db';
    }
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const matchedDbClient = matchFrameworkDbClientFactoryCall(expr.expression.text);
    if (matchedDbClient) {
      return matchedDbClient;
    }
  }
  const access = getPropertyOrElementAccess(expr);
  if (access) {
    if (access.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return access.memberName;
    }
    return getRootIdentifier(access.expression);
  }
  return null;
}

/**
 * Extracts an external package as an OPEN_CONNECTOR (Ontology v4.0).
 *
 * An external package is a known exit point beyond the available evidence — never a structural
 * boundary we can see inside. Matches ES imports and CommonJS requires whose specifier is not
 * relative, not a workspace package, and not resolvable to a local file.
 *
 * @example
 * import express from 'express';            // → Package: express (EXTERNAL_PACKAGE)
 * const fs = require('node:fs');            // → Package: node:fs (NODE_BUILTIN)
 *
 * @param node              The AST node to inspect.
 * @param sourceFile        Source file containing the node.
 * @param getEvidence       Returns a populated EvidenceRecord for the given node.
 * @param nextId            Closure providing a placeholder entity ID.
 * @param repoRoot          Analysis root for module resolution.
 * @param workspaceRegistry Optional registry of monorepo workspace packages.
 * @returns An OPEN_CONNECTOR StructuralEntity, or null if the node is not an external import/require.
 */
export function extractExternalPackageConnector(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | null {
  let literal: string | null = null;
  let patternId = 'boundary.external-import';

  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    literal = node.moduleSpecifier.text;
  } else if (
    ts.isExportDeclaration(node) &&
    !node.isTypeOnly &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    literal = node.moduleSpecifier.text;
  } else if (
    ts.isImportEqualsDeclaration(node) &&
    node.moduleReference &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    literal = node.moduleReference.expression.text;
    patternId = 'boundary.ts-import-equals-require';
  } else if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length > 0 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    literal = node.arguments[0].text;
    patternId = 'boundary.external-require';
  }

  if (literal === null || !isExternalSpecifier(literal, sourceFile.fileName, repoRoot, workspaceRegistry)) {
    return null;
  }

  const normalizedLiteral = normalizePackageSpecifier(literal);
  const isBuiltin =
    patternId === 'boundary.external-import'
      ? isNodeBuiltinSpecifier(literal)
      : literal.startsWith('node:');

  return {
    id: nextId(),
    name: `Package: ${normalizedLiteral}`,
    type: 'OPEN_CONNECTOR',
    entityType: isBuiltin ? 'NODE_BUILTIN' : 'EXTERNAL_PACKAGE',
    patternId,
    evidence: getEvidence(node),
  };
}

const WINDOW_POSTMESSAGE_GLOBALS = new Set(['window', 'self', 'parent', 'top', 'globalThis']);

/**
 * True when `node` is a browser cross-window / iframe IPC `postMessage` call
 * (`window.postMessage(...)`, `parent.postMessage(...)`, `iframe.contentWindow.postMessage(...)`).
 */
export function isWindowPostMessageCall(node: ts.CallExpression): boolean {
  const access = getPropertyOrElementAccess(node.expression);
  if (!access || access.memberName !== 'postMessage' || node.arguments.length === 0) {
    return false;
  }
  if (ts.isIdentifier(access.expression) && WINDOW_POSTMESSAGE_GLOBALS.has(access.expression.text)) {
    return true;
  }
  const innerAccess = getPropertyOrElementAccess(access.expression);
  if (innerAccess && innerAccess.memberName === 'contentWindow') {
    return true;
  }
  return false;
}

/**
 * Inspects a single AST node and returns an OPEN_CONNECTOR entity if it calls a known HTTP client,
 * database driver, ORM, message broker, subprocess, filesystem mutation, raw socket, or dynamic
 * code execution/loading boundary — or imports an external package.
 *
 * @param node              The AST node to inspect.
 * @param sourceFile        TypeScript SourceFile object used to extract expression text snippet.
 * @param getEvidence       Returns a populated EvidenceRecord for the given node.
 * @param nextId            Closure providing a placeholder entity ID.
 * @param repoRoot          Analysis root used to classify package specifiers.
 * @param workspaceRegistry Optional registry of monorepo workspace packages.
 * @returns An OPEN_CONNECTOR StructuralEntity or null if the node does not match any allowlisted client.
 */
export function visitOpenConnector(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string = '',
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | StructuralEntity[] | null {
  const externalPackage = extractExternalPackageConnector(node, sourceFile, getEvidence, nextId, repoRoot, workspaceRegistry);
  if (externalPackage) return externalPackage;

  // [PAT-EXT-17] & [PAT-EXT-18]: Handle constructor instantiation (`new WebSocket(...)`, `new Function(...)`)
  if (ts.isNewExpression(node)) {
    const args = (node.arguments ?? []).map(arg => arg.getText(sourceFile)).join(', ');
    const ctorAccess = getPropertyOrElementAccess(node.expression);
    const ctorName = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ctorAccess?.memberName ?? null;
    const ctorRoot = getRootIdentifier(node.expression);

    if (ctorName && SOCKET_CONSTRUCTOR_IDENTIFIERS.has(ctorName)) {
      return {
        id: nextId(),
        name: `Socket Call: new ${ctorName}`,
        type: 'OPEN_CONNECTOR',
        entityType: 'SOCKET_EGRESS',
        patternId: 'open-connector.socket-egress',
        evidence: getEvidence(node),
        metadata: { payload: args },
      };
    }

    if (
      ctorName === 'Function' &&
      (ts.isIdentifier(node.expression) || (ctorRoot && ['globalThis', 'window', 'global'].includes(ctorRoot)))
    ) {
      return {
        id: nextId(),
        name: 'Dynamic Execution: new Function',
        type: 'OPEN_CONNECTOR',
        entityType: 'DYNAMIC_EXECUTION',
        patternId: 'open-connector.dynamic-execution',
        evidence: getEvidence(node),
        metadata: { payload: args },
      };
    }

    return null;
  }

  if (!ts.isCallExpression(node)) {
    return null;
  }
  if (isInsideDecorator(node)) {
    return null;
  }

  // [PAT-EXT-18]: Non-literal dynamic `import(expr)` warning connector
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
    const arg0 = node.arguments[0];
    if (!ts.isStringLiteral(arg0) && !ts.isNoSubstitutionTemplateLiteral(arg0)) {
      const argText = arg0.getText(sourceFile).replace(/\s+/g, ' ').trim();
      return {
        id: nextId(),
        name: `Dynamic Import: import(${argText})`,
        type: 'OPEN_CONNECTOR',
        entityType: 'DYNAMIC_IMPORT',
        patternId: 'boundary.external-import',
        evidence: getEvidence(node),
        metadata: { payload: argText },
      };
    }
    return null;
  }

  // [PAT-EXT-18]: Dynamic code evaluation via `eval(...)`
  const callAccess = getPropertyOrElementAccess(node.expression);
  const callRoot = getRootIdentifier(node.expression);
  if (
    (ts.isIdentifier(node.expression) && node.expression.text === 'eval') ||
    (callAccess?.memberName === 'eval' && callRoot && ['globalThis', 'window', 'global'].includes(callRoot))
  ) {
    const args = node.arguments.map(arg => arg.getText(sourceFile)).join(', ');
    return {
      id: nextId(),
      name: 'Dynamic Execution: eval',
      type: 'OPEN_CONNECTOR',
      entityType: 'DYNAMIC_EXECUTION',
      patternId: 'open-connector.dynamic-execution',
      evidence: getEvidence(node),
      metadata: { payload: args },
    };
  }

  // [PAT-EXT-49]: Browser cross-origin / iframe postMessage IPC egress
  if (callAccess && isWindowPostMessageCall(node)) {
    const receiverText = callAccess.expression.getText(sourceFile).replace(/\s+/g, '').replace(/\?\./g, '.').trim();
    const args = node.arguments.map(arg => arg.getText(sourceFile)).join(', ');
    return {
      id: nextId(),
      name: `IPC: ${receiverText}.postMessage`,
      type: 'OPEN_CONNECTOR',
      entityType: 'IPC_MESSAGE',
      patternId: 'open-connector.window-postmessage-ipc',
      evidence: getEvidence(node),
      metadata: { payload: args },
    };
  }

  const drizzleQuery = extractDrizzleQueryChain(node, getEvidence, nextId);
  if (drizzleQuery) return drizzleQuery;
  if (isInnerDrizzleQueryChainCall(node, getEvidence, nextId)) return null;

  const nextjsRevalidate = extractNextjsRevalidate(node, getEvidence, nextId);
  if (nextjsRevalidate) return nextjsRevalidate;

  const expressAppListen = extractExpressAppListen(node, getEvidence, nextId);
  if (expressAppListen) {
    return expressAppListen;
  }

  const expressCookie = extractExpressResponseCookie(node, getEvidence, nextId);
  if (expressCookie) {
    return expressCookie;
  }

  const eventEmitterEmit = extractEventEmitterEmit(node, getEvidence, nextId);
  if (eventEmitterEmit) {
    return eventEmitterEmit;
  }

  const pluginHookFire = extractPluginHookFire(node, getEvidence, nextId);
  if (pluginHookFire) {
    return pluginHookFire;
  }

  const payloadConnectors = extractPayloadOpenConnectors(node, getEvidence, nextId);
  if (payloadConnectors) return payloadConnectors;

  const rootId = callRoot;
  if (!rootId) {
    return null;
  }

  const exprText = node.expression
    .getText(sourceFile)
    .replace(/\[['"`]([a-zA-Z_$][\w$]*)['"`]\]/g, '.$1')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    exprText.startsWith('this.') &&
    resolvePublicMethodTarget(node, sourceFile, repoRoot, workspaceRegistry, { localOnly: true })
  ) {
    return null;
  }
  if (
    callAccess &&
    ts.isIdentifier(callAccess.expression) &&
    resolvesToLocalModuleCallableContract(
      callAccess.expression.text,
      callAccess.memberName,
      sourceFile,
      repoRoot,
      workspaceRegistry
    )
  ) {
    return null;
  }

  const bindings = collectLocalClientBindings(sourceFile);
  const aliasKind = bindings.aliases.get(rootId);
  const rawArgs = node.arguments.map(arg => arg.getText(sourceFile)).join(', ');
  const compactArgs = rawArgs.replace(/\s+/g, ' ').trim();
  const args = compactArgs.length > 160 ? `${compactArgs.slice(0, 157)}...` : compactArgs;

  // [PAT-EXT-17]: Direct named import / destructured calls (`execSync(...)`, `writeFileSync(...)`, `connect(...)`)
  if (ts.isIdentifier(node.expression)) {
    const subMethod = bindings.subprocessFns.get(rootId);
    if (subMethod) {
      return {
        id: nextId(),
        name: `Subprocess: child_process.${subMethod}`,
        type: 'OPEN_CONNECTOR',
        entityType: 'SUBPROCESS_EXEC',
        patternId: 'open-connector.subprocess',
        evidence: getEvidence(node),
        metadata: { payload: args },
      };
    }

    const fsMut = bindings.fsMutationFns.get(rootId);
    if (fsMut) {
      const prefix = fsMut.isPromises ? 'fs.promises' : 'fs';
      return {
        id: nextId(),
        name: `FS Write: ${prefix}.${fsMut.methodName}`,
        type: 'OPEN_CONNECTOR',
        entityType: 'FS_MUTATION',
        patternId: 'open-connector.fs-mutation',
        evidence: getEvidence(node),
        metadata: { payload: args },
      };
    }

    const sockFn = bindings.socketFns.get(rootId);
    if (sockFn) {
      return {
        id: nextId(),
        name: `Socket Call: ${sockFn.moduleName}.${sockFn.methodName}`,
        type: 'OPEN_CONNECTOR',
        entityType: 'SOCKET_EGRESS',
        patternId: 'open-connector.socket-egress',
        evidence: getEvidence(node),
        metadata: { payload: args },
      };
    }
  }

  // [PAT-EXT-17]: Member calls on subprocess, filesystem mutation, and raw socket clients
  if ((SUBPROCESS_CLIENT_IDENTIFIERS.has(rootId) || aliasKind === 'SUBPROCESS') && callAccess && SUBPROCESS_METHODS.has(callAccess.memberName)) {
    return {
      id: nextId(),
      name: `Subprocess: child_process.${callAccess.memberName}`,
      type: 'OPEN_CONNECTOR',
      entityType: 'SUBPROCESS_EXEC',
      patternId: 'open-connector.subprocess',
      evidence: getEvidence(node),
      metadata: { payload: args },
    };
  }

  if (
    (FS_CLIENT_IDENTIFIERS.has(rootId) || aliasKind === 'FS' || aliasKind === 'FS_PROMISES') &&
    callAccess &&
    FS_MUTATION_METHODS.has(callAccess.memberName)
  ) {
    const isPromises =
      aliasKind === 'FS_PROMISES' ||
      rootId === 'fsPromises' ||
      rootId === 'fsp' ||
      exprText.includes('.promises.');
    const prefix = isPromises ? 'fs.promises' : 'fs';
    return {
      id: nextId(),
      name: `FS Write: ${prefix}.${callAccess.memberName}`,
      type: 'OPEN_CONNECTOR',
      entityType: 'FS_MUTATION',
      patternId: 'open-connector.fs-mutation',
      evidence: getEvidence(node),
      metadata: { payload: args },
    };
  }

  if ((SOCKET_CLIENT_IDENTIFIERS.has(rootId) || aliasKind === 'SOCKET') && callAccess && SOCKET_CONNECT_METHODS.has(callAccess.memberName)) {
    const modPrefix = rootId === 'tls' ? 'tls' : 'net';
    return {
      id: nextId(),
      name: `Socket Call: ${modPrefix}.${callAccess.memberName}`,
      type: 'OPEN_CONNECTOR',
      entityType: 'SOCKET_EGRESS',
      patternId: 'open-connector.socket-egress',
      evidence: getEvidence(node),
      metadata: { payload: args },
    };
  }

  if (
    callAccess &&
    ['on', 'once', 'handle', 'handleOnce', 'send', 'sendSync', 'invoke', 'postMessage'].includes(
      callAccess.memberName
    ) &&
    (rootId === 'ipcMain' ||
      rootId === 'ipcRenderer' ||
      (ts.isPropertyAccessExpression(callAccess.expression) &&
        callAccess.expression.name.text === 'webContents'))
  ) {
    const cleanExpr = exprText.replace(/^this\./, '');
    return {
      id: nextId(),
      name: `Socket Call: ${cleanExpr}`,
      type: 'OPEN_CONNECTOR',
      entityType: 'SOCKET_EGRESS',
      patternId: 'open-connector.socket-egress',
      evidence: getEvidence(node),
      metadata: { payload: args },
    };
  }

  if (HTTP_CLIENT_IDENTIFIERS.has(rootId) || aliasKind === 'HTTP') {
    if (isLocalCustomRequestHelper(rootId, sourceFile, repoRoot, workspaceRegistry)) {
      return null;
    }
    if (rootId === 'request' && isEnclosingFunctionParameter(node, 'request')) {
      return null;
    }
    if (callAccess) {
      const memberNameLower = callAccess.memberName.toLowerCase();
      if (!HTTP_REQUEST_METHODS.has(memberNameLower) && !S3_CLIENT_METHODS.has(callAccess.memberName)) {
        return null;
      }

      // Guard against non-client member access (e.g. `request.headers.get(...)`,
      // `axios.defaults.headers.get(...)`, `request.query.get(...)`).
      // For any HTTP client call with member access, the receiver must be the client itself
      // (or `this.<client>` / `<client>.default`), never an arbitrary property access.
      const receiverAccess = getPropertyOrElementAccess(callAccess.expression);
      if (
        receiverAccess &&
        receiverAccess.memberName !== rootId &&
        receiverAccess.memberName !== 'default'
      ) {
        return null;
      }
    }

    const callText =
      !callAccess && rootId === 'fetch'
        ? 'fetch'
        : exprText.replace(/^this\./, '').replace(/\?\./g, '.');
    let urlPath: string | undefined;
    let httpMethod = 'GET';

    const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
    if (callAccess && HTTP_METHODS.has(callAccess.memberName.toUpperCase())) {
      httpMethod = callAccess.memberName.toUpperCase();
    }

    if (node.arguments.length > 0) {
      urlPath = resolveHttpUrlPathFromExpression(node.arguments[0]);
    }

    if (node.arguments.length > 1 && ts.isObjectLiteralExpression(node.arguments[1])) {
      for (const prop of node.arguments[1].properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ((ts.isIdentifier(prop.name) && prop.name.text === 'method') ||
            (ts.isStringLiteral(prop.name) && prop.name.text === 'method')) &&
          (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
        ) {
          httpMethod = prop.initializer.text.trim().toUpperCase();
        }
      }
    }

    return {
      id: nextId(),
      name: `HTTP Call: ${callText}`,
      type: 'OPEN_CONNECTOR',
      entityType: 'HTTP_FETCH', patternId: 'open-connector.http-call',
      evidence: getEvidence(node),
      metadata: {
        payload: args,
        httpMethod,
        ...(urlPath ? { urlPath } : {}),
      }
    };
  }

  if (DB_CLIENT_IDENTIFIERS.has(rootId) || aliasKind === 'DB') {
    if (isMongooseSchemaOrModelCall(node, sourceFile)) {
      return null;
    }
    if (
      callAccess &&
      (DB_NON_QUERY_LIFECYCLE_METHODS.has(callAccess.memberName) ||
        ORM_SCHEMA_LIFECYCLE_METHODS.has(callAccess.memberName))
    ) {
      return null;
    }
    if (!callAccess && /^[A-Z]/.test(rootId) && rootId !== 'Database' && !bindings.dbStatementAliases.has(rootId)) {
      return null;
    }
    let callText = exprText.replace(/^this\./, '').replace(/\?\./g, '.');
    if (
      callAccess &&
      callAccess.memberName === 'execute' &&
      ts.isTaggedTemplateExpression(callAccess.expression)
    ) {
      callText = 'sql.execute';
    }
    const stmtAlias = bindings.dbStatementAliases.get(rootId);
    if (stmtAlias) {
      callText = callAccess
        ? `${stmtAlias.rootClient}.${callAccess.memberName}`
        : `${stmtAlias.rootClient}.${stmtAlias.initMethod}`;
    }
    const dialect = inferCacheOrDbDialectFromBinding(stmtAlias?.rootClient ?? rootId, sourceFile);
    const isModelQuery = bindings.modelAliases.has(rootId);
    return {
      id: nextId(),
      name: `DB Call: ${callText}`,
      type: 'OPEN_CONNECTOR',
      entityType: 'DB_QUERY',
      patternId: isModelQuery
        ? ORM_MODEL_QUERY_PATTERN_ID
        : 'open-connector.db-call',
      evidence: getEvidence(node),
      metadata: { payload: args, ...(dialect ? { dialect } : {}) }
    };
  }

  return null;
}

/**
 * Walks up enclosing lexical statement blocks (`Block`, `SourceFile`, `ModuleBlock`, `CaseClause`, `DefaultClause`)
 * to locate the initializer expression of a local `const` or `let` variable referenced at an HTTP call site.
 *
 * @example
 * ```ts
 * const url = queryString ? `/api/layout?${queryString}` : '/api/layout';
 * await fetch(url);
 * ```
 *
 * @param identNode - The identifier AST node passed to `fetch(url)` or interpolated in a template.
 * @returns The `ts.Expression` initializer if deterministically bound in lexical scope, otherwise `undefined`.
 */
function findLocalVariableInitializer(identNode: ts.Identifier): ts.Expression | undefined {
  const targetName = identNode.text;
  let current: ts.Node | undefined = identNode.parent;

  while (current) {
    let statements: ts.NodeArray<ts.Statement> | undefined;
    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isModuleBlock(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current)
    ) {
      statements = current.statements;
    }

    if (statements) {
      for (let i = statements.length - 1; i >= 0; i--) {
        const stmt = statements[i];
        // For block scopes, only inspect declarations preceding the identifier usage
        if (!ts.isSourceFile(current) && stmt.pos > identNode.pos) continue;
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === targetName && decl.initializer) {
            return decl.initializer;
          }
        }
      }
    }
    current = current.parent;
  }

  return undefined;
}

/**
 * Resolves the first argument of an HTTP client invocation (`fetch(...)`, `axios.get(...)`) into a
 * normalized route/URL string (`[PAT-EXT-26]`).
 *
 * Supports:
 * - Static string and no-substitution template literals (`'/api/layout'`)
 * - Template expressions with path parameters (`\`/api/users/\${userId}\`` -> `'/api/users/:param'`)
 *   or query interpolations (`\`/api/layout?\${queryString}\`` -> `'/api/layout?'`)
 * - Ternary conditional expressions (`cond ? \`/api/layout?\${qs}\` : '/api/layout'`)
 * - Binary `+` string concatenations (`'/api/users/' + userId` -> `'/api/users/:param'`)
 * - Local lexical `const` / `let` variable bindings (`const url = ...; fetch(url)`)
 *
 * @param expr          - The AST expression node representing the URL argument.
 * @param visitedIdents - Cycle guard set tracking already-followed variable identifier names.
 * @returns A resolved URL/route string if statically determinable, or `undefined`.
 */
export function resolveHttpUrlPathFromExpression(
  expr: ts.Expression,
  visitedIdents: Set<string> = new Set()
): string | undefined {
  let target: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isTypeAssertionExpression(target) ||
    (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(target))
  ) {
    target = target.expression;
  }

  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) {
    return target.text.trim();
  }

  if (ts.isTemplateExpression(target)) {
    let out = target.head.text;
    for (const span of target.templateSpans) {
      const inQueryOrHash = out.includes('?') || out.includes('#');
      if (!inQueryOrHash) {
        const resolvedSpan = resolveHttpUrlPathFromExpression(span.expression, new Set(visitedIdents));
        if (resolvedSpan && (resolvedSpan.startsWith('/') || resolvedSpan.startsWith('http'))) {
          out += resolvedSpan;
        } else {
          out += ':param';
        }
      }
      out += span.literal.text;
    }
    if (out.startsWith('/')) {
      const [pathname, rest] = out.split(/([?#].*)/, 2);
      return `${pathname.replace(/\/{2,}/g, '/')}${rest ?? ''}`.trim();
    }
    return out.trim();
  }

  if (ts.isConditionalExpression(target)) {
    const whenTrue = resolveHttpUrlPathFromExpression(target.whenTrue, new Set(visitedIdents));
    const whenFalse = resolveHttpUrlPathFromExpression(target.whenFalse, new Set(visitedIdents));
    if (whenTrue && (whenTrue.startsWith('/') || whenTrue.startsWith('http'))) return whenTrue;
    if (whenFalse && (whenFalse.startsWith('/') || whenFalse.startsWith('http'))) return whenFalse;
    return whenTrue ?? whenFalse;
  }

  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveHttpUrlPathFromExpression(target.left, new Set(visitedIdents));
    const right = resolveHttpUrlPathFromExpression(target.right, new Set(visitedIdents));
    if (left) {
      if (left.includes('?') || left.includes('#')) {
        return left;
      }
      if (right) {
        return `${left}${right}`;
      }
      return `${left.endsWith('/') ? left : `${left}/`}:param`;
    }
  }

  if (
    ts.isBinaryExpression(target) &&
    (target.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const left = resolveHttpUrlPathFromExpression(target.left, new Set(visitedIdents));
    const right = resolveHttpUrlPathFromExpression(target.right, new Set(visitedIdents));
    if (left && (left.startsWith('/') || left.startsWith('http'))) return left;
    if (right && (right.startsWith('/') || right.startsWith('http'))) return right;
    return left ?? right;
  }

  if (ts.isIdentifier(target)) {
    if (visitedIdents.has(target.text)) return undefined;
    visitedIdents.add(target.text);
    const initializer = findLocalVariableInitializer(target);
    if (initializer) {
      return resolveHttpUrlPathFromExpression(initializer, visitedIdents);
    }
  }

  return undefined;
}

/**
 * Normalizes a raw HTTP route or URL string into a clean pathname starting with `/`.
 * Strips `http://localhost` / `http://127.0.0.1` origins, query strings (`?...`), hashes (`#...`),
 * and trailing slashes.
 *
 * @param rawPath - Raw URL or route path string.
 * @returns Normalized pathname (e.g. `'/api/layout'`) or `null` if external/non-path.
 */
function normalizeRoutePath(rawPath: string): string | null {
  let p = rawPath.trim();
  if (p.startsWith('http://localhost') || p.startsWith('http://127.0.0.1')) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  if (!p.startsWith('/')) return null;
  p = p.split('?')[0].split('#')[0];
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Canonicalizes dynamic route segments (`/:id`, `/:userId`, `/[id]`) to `/:param` so client
 * template interpolations (`fetch(\`/api/users/\${userId}\`)`) match parameterized server routes
 * (`Express Route: GET /api/users/:id` or Next.js `/api/users/[id]`).
 *
 * @param normPath - Normalized route path starting with `/`.
 * @returns Route path with dynamic parameter segments replaced by `:param`.
 */
function canonicalizeRouteParams(normPath: string): string {
  return normPath
    .split('/')
    .map(seg => {
      if (seg.startsWith(':') && seg.length > 1) return ':param';
      if (seg.startsWith('[') && seg.endsWith(']') && seg.length > 2) return ':param';
      return seg;
    })
    .join('/');
}

/**
 * Computes a stable composite key for an `EvidenceRecord` to track which call sites on a
 * deduplicated `HTTP_FETCH` Open Connector were stitched to internal endpoints (`[PAT-EXT-26]`).
 *
 * @param ev - The evidence record to key.
 * @returns Composite string key `filePath:lineNumber:snippet`.
 */
function evidenceKey(ev: EvidenceRecord): string {
  return `${ev.filePath}:${ev.lineNumber ?? ''}:${ev.snippet ?? ''}`;
}

/**
 * Stitches intra-repository `HTTP_FETCH` Open Connector edges directly to matching internal
 * `HTTP_ENDPOINT` / `API_ENDPOINT` contracts (`[PAT-EXT-23]`, `[PAT-EXT-26]`).
 *
 * - Matches both exact normalized paths (`/api/layout`) and parameterized route patterns
 *   (`/api/users/:id` ↔ `/api/users/:param`).
 * - Completely prunes `HTTP_FETCH` Open Connector nodes when 100% of their call sites stitch
 *   to internal endpoints.
 * - When an `HTTP_FETCH` Open Connector is partially stitched (some call sites match internal routes
 *   while others target external URLs), prunes the stitched call-site `evidence` records from the
 *   surviving Open Connector node so `External: HTTP API` only reflects genuinely external calls.
 *
 * @param nodes             - Mutable array of extracted `StructuralNode` entities.
 * @param edges             - Mutable array of extracted `StructuralEdge` entities.
 * @param openConnectorById - Lookup map of deduplicated `OPEN_CONNECTOR` nodes by ID.
 */
export function stitchIntraRepoHttpCalls(
  nodes: StructuralNode[],
  edges: StructuralEdge[],
  openConnectorById: Map<string, StructuralNode>
): void {
  interface EndpointMatchEntry {
    node: StructuralNode;
    canonicalRoutePath: string;
  }

  const getPrimaryFilePath = (entity: Pick<StructuralNode | StructuralEdge, 'evidence'>): string | undefined => {
    const ev = entity.evidence;
    if (!ev) return undefined;
    return Array.isArray(ev) ? ev[0]?.filePath : ev.filePath;
  };

  const joinMountAndRoute = (mountPrefix: string, subPath: string): string => {
    const cleanMount = mountPrefix.endsWith('/') && mountPrefix.length > 1
      ? mountPrefix.slice(0, -1)
      : mountPrefix;
    if (!subPath || subPath === '/') return cleanMount || '/';
    const cleanSub = subPath.startsWith('/') ? subPath : `/${subPath}`;
    return `${cleanMount === '/' ? '' : cleanMount}${cleanSub}`;
  };

  // Discover Express router mount prefixes (`app.use('/api/blogs', blogsRouter)`) by mounted router file path
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const mountPrefixesByFile = new Map<string, Set<string>>();
  const mountPrefixesByStem = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.patternId !== HTTP_ROUTER_MOUNT_EDGE_PATTERN_ID) continue;
    const mountMatch = parseRouterMountEdgeName(edge.name);
    if (!mountMatch) continue;
    const prefix = normalizeRoutePath(mountMatch.rawPrefix);
    if (!prefix || prefix === '/') continue;
    const targetHint = mountMatch.targetHint.trim().toLowerCase();
    if (targetHint) {
      const cleanStem = targetHint.replace(/(?:router|routes|route)$/i, '');
      for (const hintKey of [targetHint, ...(cleanStem.length >= 2 ? [cleanStem] : [])]) {
        let stemSet = mountPrefixesByStem.get(hintKey);
        if (!stemSet) {
          stemSet = new Set<string>();
          mountPrefixesByStem.set(hintKey, stemSet);
        }
        stemSet.add(prefix);
      }
    }
    if (edge.targetId) {
      const targetNode = nodeById.get(edge.targetId);
      const targetFp = targetNode ? getPrimaryFilePath(targetNode) : undefined;
      if (targetFp) {
        let fpSet = mountPrefixesByFile.get(targetFp);
        if (!fpSet) {
          fpSet = new Set<string>();
          mountPrefixesByFile.set(targetFp, fpSet);
        }
        fpSet.add(prefix);
      }
    }
  }

  // Propagate multi-hop nested router mounts (e.g. `/api` -> `routes/api/index.ts` -> `/auth` -> `/api/auth`)
  for (let pass = 0; pass < 3; pass++) {
    for (const edge of edges) {
      if (edge.patternId !== HTTP_ROUTER_MOUNT_EDGE_PATTERN_ID || !edge.targetId) continue;
      const mountMatch = parseRouterMountEdgeName(edge.name);
      if (!mountMatch) continue;
      const childPrefix = normalizeRoutePath(mountMatch.rawPrefix);
      if (!childPrefix || childPrefix === '/') continue;
      const sourceFp = getPrimaryFilePath(edge);
      const targetNode = nodeById.get(edge.targetId);
      const targetFp = targetNode ? getPrimaryFilePath(targetNode) : undefined;
      if (!sourceFp || !targetFp) continue;
      const parentPrefixes = mountPrefixesByFile.get(sourceFp);
      if (!parentPrefixes) continue;
      let targetSet = mountPrefixesByFile.get(targetFp);
      if (!targetSet) {
        targetSet = new Set<string>();
        mountPrefixesByFile.set(targetFp, targetSet);
      }
      for (const p of Array.from(parentPrefixes)) {
        targetSet.add(joinMountAndRoute(p, childPrefix));
      }
    }
  }

  const endpointByMethodAndPath = new Map<string, EndpointMatchEntry>();
  const registerEndpoint = (method: string, normPath: string, node: StructuralNode, canonicalOverride?: string) => {
    const entry: EndpointMatchEntry = { node, canonicalRoutePath: canonicalOverride ?? normPath };
    const exactKey = `${method} ${normPath}`;
    if (!endpointByMethodAndPath.has(exactKey)) {
      endpointByMethodAndPath.set(exactKey, entry);
    }
    if ((method === 'ANY' || method === 'ALL') && !endpointByMethodAndPath.has(`ANY ${normPath}`)) {
      endpointByMethodAndPath.set(`ANY ${normPath}`, entry);
    }
    const paramPath = canonicalizeRouteParams(normPath);
    if (paramPath !== normPath) {
      const paramKey = `${method} ${paramPath}`;
      if (!endpointByMethodAndPath.has(paramKey)) {
        endpointByMethodAndPath.set(paramKey, entry);
      }
      if ((method === 'ANY' || method === 'ALL') && !endpointByMethodAndPath.has(`ANY ${paramPath}`)) {
        endpointByMethodAndPath.set(`ANY ${paramPath}`, entry);
      }
    }
  };

  for (const n of nodes) {
    if (n.entityType !== 'HTTP_ENDPOINT' && n.entityType !== 'API_ENDPOINT') continue;
    const fp = getPrimaryFilePath(n);
    const fileStem = fp
      ? (fp.split('/').pop() ?? '').replace(/\.[A-Za-z0-9]+$/, '').toLowerCase()
      : '';
    const mountPrefixes = new Set<string>([
      ...(fp ? mountPrefixesByFile.get(fp) ?? [] : []),
      ...(fileStem && fileStem !== 'index' && fileStem !== 'routes' && fileStem !== 'app'
        ? mountPrefixesByStem.get(fileStem) ?? []
        : []),
    ]);

    const expressMatch = parseFrameworkHttpRouteNodeName(n.name);
    if (expressMatch) {
      const method = expressMatch.method;
      const normPath = normalizeRoutePath(expressMatch.rawPath);
      if (normPath) {
        if (mountPrefixes.size > 0) {
          for (const prefix of mountPrefixes) {
            const fullPath = normalizeRoutePath(joinMountAndRoute(prefix, normPath));
            if (fullPath) {
              if (!n.metadata?.mountPrefix) {
                n.metadata = {
                  ...(n.metadata ?? {}),
                  mountPrefix: prefix,
                  routePath: fullPath,
                };
              }
              registerEndpoint(method, fullPath, n, fullPath);
              registerEndpoint(method, normPath, n, fullPath);
            } else {
              registerEndpoint(method, normPath, n);
            }
          }
        } else {
          registerEndpoint(method, normPath, n);
        }
      }
      continue;
    }
    const nextjsHandlerMatch = n.name.match(
      /^Route Handler:\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i
    );
    if (nextjsHandlerMatch && fp) {
      const method = nextjsHandlerMatch[1].toUpperCase();
      const normFp = fp.replace(/\\/g, '/');
      const afterApp = normFp.replace(/^.*?app\//, '');
      const withoutRoute = afterApp
        .replace(/\/?route(?:\.[A-Za-z0-9]+)+$/, '')
        .replace(/\([^)]+\)\//g, '')
        .replace(/\([^)]+\)$/, '');
      const derivedRoute =
        !withoutRoute || withoutRoute === '/' ? '/' : '/' + withoutRoute.replace(/\/$/, '');
      const normPath = normalizeRoutePath(derivedRoute);
      if (normPath) {
        registerEndpoint(method, normPath, n);
      }
      continue;
    }
    const meta = n.metadata as Record<string, any> | undefined;
    if (meta?.routePath && typeof meta.routePath === 'string') {
      const normPath = normalizeRoutePath(meta.routePath);
      if (normPath) {
        const method = typeof meta.method === 'string' ? meta.method.toUpperCase() : 'ANY';
        registerEndpoint(method, normPath, n);
      }
    }
  }

  if (endpointByMethodAndPath.size === 0) return;

  const lookupEndpoint = (httpMethod: string, normPath: string | null): EndpointMatchEntry | undefined => {
    if (!normPath) return undefined;
    const paramPath = canonicalizeRouteParams(normPath);
    return (
      endpointByMethodAndPath.get(`${httpMethod} ${normPath}`) ??
      endpointByMethodAndPath.get(`ALL ${normPath}`) ??
      endpointByMethodAndPath.get(`ANY ${normPath}`) ??
      (paramPath
        ? endpointByMethodAndPath.get(`${httpMethod} ${paramPath}`) ??
          endpointByMethodAndPath.get(`ALL ${paramPath}`) ??
          endpointByMethodAndPath.get(`ANY ${paramPath}`)
        : undefined)
    );
  };

  const stitchedConnectorIds = new Set<string>();
  const unstitchedConnectorIds = new Set<string>();
  const stitchedEvidenceKeysByConnectorId = new Map<string, Set<string>>();
  const wrapperPrefixedEdges: Array<{
    wrapperContractId: string;
    connectorNode: StructuralNode;
    wrapperEdge: StructuralEdge;
    basePrefix: string;
    defaultMethod: string;
  }> = [];

  for (const edge of edges) {
    if (!edge.targetId) continue;
    const targetNode = openConnectorById.get(edge.targetId);
    if (!targetNode || targetNode.entityType !== 'HTTP_FETCH') continue;

    const edgeMeta = edge.metadata as Record<string, any> | undefined;
    const rawUrlPath = edgeMeta?.urlPath;
    const httpMethod = (edgeMeta?.httpMethod ?? 'GET').toUpperCase();
    const normPath = typeof rawUrlPath === 'string' ? normalizeRoutePath(rawUrlPath) : null;
    const matchedEndpoint = lookupEndpoint(httpMethod, normPath);

    if (matchedEndpoint && normPath) {
      stitchedConnectorIds.add(targetNode.id);
      let evSet = stitchedEvidenceKeysByConnectorId.get(targetNode.id);
      if (!evSet) {
        evSet = new Set<string>();
        stitchedEvidenceKeysByConnectorId.set(targetNode.id, evSet);
      }
      const edgeEvs = Array.isArray(edge.evidence) ? edge.evidence : [edge.evidence];
      for (const ev of edgeEvs) {
        if (ev) evSet.add(evidenceKey(ev));
      }

      const routeDisplayPath = matchedEndpoint.canonicalRoutePath;
      edge.targetId = matchedEndpoint.node.id;
      edge.entityType = 'HTTP_FETCH';
      edge.name = `HTTP Fetch: ${httpMethod} ${routeDisplayPath}`;
      if (edgeMeta) {
        edgeMeta.urlPath = routeDisplayPath;
      }
    } else {
      if (
        edge.sourceId &&
        ((normPath && normPath.endsWith(':param')) ||
          (!normPath && typeof rawUrlPath === 'string' && rawUrlPath.endsWith(':param')))
      ) {
        const rawPrefix = normPath ? normPath.slice(0, -':param'.length) : '/';
        const basePrefix = rawPrefix.endsWith('/') && rawPrefix.length > 1
          ? rawPrefix.slice(0, -1)
          : rawPrefix || '/';
        wrapperPrefixedEdges.push({
          wrapperContractId: edge.sourceId,
          connectorNode: targetNode,
          wrapperEdge: edge,
          basePrefix,
          defaultMethod: httpMethod,
        });
      } else {
        unstitchedConnectorIds.add(targetNode.id);
      }
    }
  }

  // Stitch parameterized HTTP wrapper contracts (e.g. `serverFetch(endpoint, options)` calling `fetch(\`\${SERVER_URL}\${endpoint}\`)`)
  // across callers that pass relative route strings (`serverFetch('/blogs', { method: 'POST' })`)
  for (const wp of wrapperPrefixedEdges) {
    let anyCallerStitched = false;
    const callerEdges = edges.filter(
      e => e.targetId === wp.wrapperContractId && e.entityType === 'CALL'
    );
    const stitchedTargetsByWrapper = new Map<string, { endpoint: EndpointMatchEntry; method: string; evs: EvidenceRecord[] }>();

    for (const callerEdge of callerEdges) {
      const callerMeta = callerEdge.metadata as Record<string, any> | undefined;
      const callerRawUrl = typeof callerMeta?.urlPath === 'string' ? callerMeta.urlPath : undefined;
      if (!callerRawUrl) continue;
      const callerSubPath = normalizeRoutePath(callerRawUrl);
      if (!callerSubPath) continue;
      const callerMethod = (typeof callerMeta?.httpMethod === 'string' ? callerMeta.httpMethod : wp.defaultMethod).toUpperCase();
      const combinedPath = normalizeRoutePath(joinMountAndRoute(wp.basePrefix, callerSubPath));
      const matched = lookupEndpoint(callerMethod, combinedPath) ?? lookupEndpoint(callerMethod, callerSubPath);
      if (!matched) continue;

      anyCallerStitched = true;
      const routeDisplayPath = matched.canonicalRoutePath;
      const callerEvs = Array.isArray(callerEdge.evidence) ? callerEdge.evidence : [callerEdge.evidence];

      // Emit a direct HTTP_FETCH edge from the caller (`briefsAPI.server.getAll`) to the matched server endpoint
      edges.push({
        id: '',
        name: `HTTP Fetch: ${callerMethod} ${routeDisplayPath}`,
        type: 'RELATIONSHIP',
        entityType: 'HTTP_FETCH',
        patternId: 'open-connector.http-call',
        sourceId: callerEdge.sourceId,
        targetId: matched.node.id,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: callerEvs,
        scope: callerEdge.scope,
        metadata: {
          httpMethod: callerMethod,
          urlPath: routeDisplayPath,
        },
      });

      const key = `${callerMethod}::${matched.node.id}`;
      const existing = stitchedTargetsByWrapper.get(key);
      if (existing) {
        existing.evs.push(...callerEvs);
      } else {
        stitchedTargetsByWrapper.set(key, { endpoint: matched, method: callerMethod, evs: [...callerEvs] });
      }
    }

    if (anyCallerStitched) {
      stitchedConnectorIds.add(wp.connectorNode.id);
      let evSet = stitchedEvidenceKeysByConnectorId.get(wp.connectorNode.id);
      if (!evSet) {
        evSet = new Set<string>();
        stitchedEvidenceKeysByConnectorId.set(wp.connectorNode.id, evSet);
      }
      const wpEvs = Array.isArray(wp.wrapperEdge.evidence) ? wp.wrapperEdge.evidence : [wp.wrapperEdge.evidence];
      for (const ev of wpEvs) {
        if (ev) evSet.add(evidenceKey(ev));
      }

      // Remove the generic unstitched `wp.wrapperEdge` from `serverFetch -> HTTP Call: fetch`
      const wpEdgeIdx = edges.indexOf(wp.wrapperEdge);
      if (wpEdgeIdx >= 0) {
        edges.splice(wpEdgeIdx, 1);
      }
    } else {
      unstitchedConnectorIds.add(wp.connectorNode.id);
    }
  }

  // Prune HTTP_FETCH Open Connector nodes whose call sites were all stitched to internal repo endpoints,
  // or filter stitched call-site evidence out of partially-stitched HTTP_FETCH Open Connectors ([PAT-EXT-26]).
  for (const connId of stitchedConnectorIds) {
    if (!unstitchedConnectorIds.has(connId)) {
      const idx = nodes.findIndex(n => n.id === connId);
      if (idx >= 0) nodes.splice(idx, 1);
    } else {
      const connNode = openConnectorById.get(connId);
      const stitchedEvKeys = stitchedEvidenceKeysByConnectorId.get(connId);
      if (connNode && stitchedEvKeys && stitchedEvKeys.size > 0 && Array.isArray(connNode.evidence)) {
        const remaining = connNode.evidence.filter(ev => !stitchedEvKeys.has(evidenceKey(ev)));
        if (remaining.length > 0) {
          connNode.evidence = remaining;
        }
      }
      if (connNode && connNode.entityType === 'HTTP_FETCH') {
        const remainingEdges = edges.filter(e => e.targetId === connId);
        if (remainingEdges.length > 0) {
          const endpoints: Array<{ httpMethod: string; urlPath: string; payload?: string }> = [];
          const seenEp = new Set<string>();
          for (const re of remainingEdges) {
            const em = re.metadata as Record<string, any> | undefined;
            const m = typeof em?.httpMethod === 'string' ? em.httpMethod : 'GET';
            const u = typeof em?.urlPath === 'string' ? em.urlPath : undefined;
            const p = typeof em?.payload === 'string' ? em.payload : undefined;
            if (u) {
              const epKey = `${m}::${u}::${p ?? ''}`;
              if (!seenEp.has(epKey)) {
                seenEp.add(epKey);
                endpoints.push({ httpMethod: m, urlPath: u, ...(p ? { payload: p } : {}) });
              }
            }
          }
          if (endpoints.length > 0) {
            const primary = endpoints[0];
            const nextMeta: Record<string, any> = {
              ...(connNode.metadata ?? {}),
              httpMethod: primary.httpMethod,
              urlPath: primary.urlPath,
            };
            if (primary.payload) {
              nextMeta.payload = primary.payload;
            } else {
              delete nextMeta.payload;
            }
            if (endpoints.length > 1) {
              nextMeta.endpoints = endpoints;
            } else {
              delete nextMeta.endpoints;
            }
            connNode.metadata = nextMeta;
          }
        }
      }
    }
  }
}

