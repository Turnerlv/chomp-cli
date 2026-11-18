/**
 * @file frameworkRelationshipVisitor.ts
 * Isolated framework-specific relationship and delegation visitors (`[PAT-EXT-28]`).
 *
 * Houses cross-declaration framework wiring that extends beyond single-node declarative
 * `EdgeRule` tables:
 * - Hono `.route(prefix, subApp)` and array-loop router mounts (`routes.forEach(r => app.route('/', r))`)
 * - Decorator-driven event pub/sub matching (`this.eventEmitter.emit(key)` -> `@OnEvent(key)`)
 * - Next.js `route.ts` destructured handler delegation (`export const { GET, POST } = handlers`)
 * - Next.js `middleware.ts` re-export alias delegation (`export { auth as middleware } from ...`)
 * - CommonJS default export delegation (`exports = module.exports = createAdapter`)
 * - React JSX component-map prop dispatch (`<DataTable headerComponents={COLUMN_HEADER_COMPONENTS} />`)
 * - NestJS `@UseGuards` / `@UsePipes` / `@UseInterceptors` and Abstract Port -> Concrete Adapter wiring
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import {
  stableEntityId,
  cjsContractEntityId,
  contractEntityId,
  boundaryEntityId,
  resolveLogicalBoundaryScope,
  findEnclosingNamespaceScope,
} from '../../utils/id.js';
import { resolveModulePath } from '../pathResolver.js';
import type { WorkspaceRegistry } from '../workspaceResolver.js';
import { classifyNextjsFile } from '../adapters/nextjsAdapter.js';
import { extractDrizzleSchemaContract } from '../adapters/drizzleAdapter.js';
import {
  ROUTE_HTTP_METHODS,
  isRemixRouteFile,
  isRouterFactoryInitializer,
  isRouterOrCliCommandFactoryInitializer,
} from '../conventions/index.js';
import { extractCommonjsExport } from './commonjsExportVisitor.js';
import {
  findCallableObjectProperty,
  getExportedNamesForDeclaration,
  resolveExtractedContractName,
  visitContract,
} from './contractVisitor.js';
import { extractDecoratorIngressMeta, publicMethodName } from './publicMethodVisitor.js';
import { isFunctionLikeNode } from './initBlockVisitor.js';
import {
  SHAPE_KEY_VERSION,
  classifyImportedBindingKind,
  computeIdentifierRefShapeKey,
} from './shapeKeyVisitor.js';
import {
  findClassDeclInModuleOrReexports,
  findLocalVariableDeclaration,
  findModuleBinding,
  findValueModuleBinding,
  getCachedSourceFile,
  getChainRootIdentifierNode,
  getSourceFileDeclarationIndex,
  isExternalSpecifier,
  resolveClassBoundaryInModule,
  resolveClassMethodTargetWithEvidence,
  resolveGetterAccessorTarget,
  resolveImportedClassBoundaryTargetWithEvidence,
  resolveRouterMountTarget,
} from './targetResolver.js';
import {
  resolveImportedObjectMember,
  resolveSameFileExportedFunction,
  resolveTargetExport,
} from './relationshipVisitor.js';

/**
 * Extracts `MOUNT` relationships from Hono `.route(prefix, subApp)` calls and array-loop
 * sub-router mounts (`routes.forEach((route) => app.route('/', route))` or `for (const route of routes)`).
 *
 * @param node              - Candidate AST node.
 * @param sourceFile        - Enclosing TypeScript SourceFile.
 * @param getEvidence       - Evidence builder callback.
 * @param nextId            - Placeholder ID generator.
 * @param repoRoot          - Repository root path.
 * @param sourceId          - Owning source entity ID.
 * @param workspaceRegistry - Optional monorepo workspace registry.
 */
export function extractHonoOrForEachRouterMount(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | StructuralEntity[] | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }
  const methodName = node.expression.name.text;
  if (methodName !== 'route' && methodName !== 'use' && methodName !== 'register') {
    return null;
  }
  if (methodName === 'register') {
    const pluginArg = node.arguments[0];
    if (!pluginArg) return null;
    let registerPrefix = '/';
    let autoLoadDirSeg: string | null = null;
    const optionsArg = node.arguments[1];
    if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
      for (const prop of optionsArg.properties) {
        if (!ts.isPropertyAssignment(prop) || (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name))) {
          continue;
        }
        if (
          prop.name.text === 'prefix' &&
          (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
        ) {
          registerPrefix = prop.initializer.text.trim() || '/';
        } else if (prop.name.text === 'options' && ts.isObjectLiteralExpression(prop.initializer)) {
          for (const nested of prop.initializer.properties) {
            if (
              ts.isPropertyAssignment(nested) &&
              (ts.isIdentifier(nested.name) || ts.isStringLiteral(nested.name)) &&
              nested.name.text === 'prefix' &&
              (ts.isStringLiteral(nested.initializer) || ts.isNoSubstitutionTemplateLiteral(nested.initializer))
            ) {
              registerPrefix = nested.initializer.text.trim() || '/';
            }
          }
        } else if (prop.name.text === 'dir') {
          if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
            autoLoadDirSeg = prop.initializer.text.trim();
          } else if (ts.isCallExpression(prop.initializer) && prop.initializer.arguments.length > 0) {
            const lastArg = prop.initializer.arguments[prop.initializer.arguments.length - 1];
            if (ts.isStringLiteral(lastArg) || ts.isNoSubstitutionTemplateLiteral(lastArg)) {
              autoLoadDirSeg = lastArg.text.trim();
            }
          }
        }
      }
    }
    if (autoLoadDirSeg) {
      const candidateDir = path.resolve(path.dirname(sourceFile.fileName), autoLoadDirSeg);
      if (fs.existsSync(candidateDir)) {
        try {
          if (fs.statSync(candidateDir).isDirectory()) {
            const autoLoadFiles: string[] = [];
            const walkDir = (dir: string) => {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  walkDir(full);
                } else if (
                  /\.[cm]?[tj]sx?$/.test(entry.name) &&
                  !entry.name.endsWith('.d.ts') &&
                  !/\.(?:test|spec)\.[cm]?[tj]sx?$/.test(entry.name)
                ) {
                  autoLoadFiles.push(full);
                }
              }
            };
            walkDir(candidateDir);
            autoLoadFiles.sort((a, b) => a.localeCompare(b));
            const autoLoadEdges: StructuralEntity[] = [];
            const seenTargets = new Set<string>();
            for (const fullFile of autoLoadFiles) {
              const relTargetFile = (path.relative(repoRoot, fullFile) || fullFile).replace(/\\/g, '/');
              const resolved = resolveTargetExport(
                relTargetFile,
                'default',
                repoRoot,
                workspaceRegistry ?? {},
                'Exported Function'
              );
              if (resolved && !seenTargets.has(resolved.targetId)) {
                seenTargets.add(resolved.targetId);
                const subRel = path.relative(candidateDir, fullFile).replace(/\\/g, '/');
                autoLoadEdges.push({
                  id: nextId(),
                  name: `AutoLoad Mount: ${registerPrefix} -> ${autoLoadDirSeg}/${subRel}`,
                  type: 'RELATIONSHIP',
                  entityType: 'MOUNT',
                  patternId: 'relationship.fastify-autoload-directory-registration',
                  sourceId,
                  targetId: resolved.targetId,
                  status: 'DETERMINISTIC',
                  confidence: 'HIGH',
                  evidence: [
                    { ...getEvidence(node), evidenceRole: 'syntax-call' },
                    resolved.targetEvidence,
                  ],
                });
              }
            }
            if (autoLoadEdges.length > 0) {
              return autoLoadEdges.length === 1 ? autoLoadEdges[0] : autoLoadEdges;
            }
          }
        } catch {
          // Ignore directory read errors
        }
      }
    }
    const syntheticCall = ts.factory.updateCallExpression(
      node,
      node.expression,
      node.typeArguments,
      [pluginArg]
    );
    const targetId =
      resolveRouterMountTarget(
        syntheticCall,
        sourceFile,
        repoRoot,
        workspaceRegistry
      ) ??
      (ts.isIdentifier(pluginArg)
        ? resolveSameFileExportedFunction(
            pluginArg.text,
            pluginArg,
            sourceFile,
            repoRoot,
            workspaceRegistry
          )?.targetId
        : undefined);
    if (targetId) {
      const targetLabel = ts.isIdentifier(pluginArg)
        ? pluginArg.text
        : pluginArg.getText(sourceFile).replace(/\s+/g, ' ').trim();
      return {
        id: nextId(),
        name: `Express Mount: ${registerPrefix} -> ${targetLabel}`,
        type: 'RELATIONSHIP',
        entityType: 'MOUNT',
        patternId: 'relationship.express-router-mount',
        sourceId,
        targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: getEvidence(node),
      };
    }
    return null;
  }
  if (methodName === 'route' && node.arguments.length < 2) {
    return null;
  }
  const first = node.arguments[0];
  const hasPrefix =
    node.arguments.length >= 2 &&
    (ts.isStringLiteral(first) ||
      ts.isNoSubstitutionTemplateLiteral(first) ||
      ts.isRegularExpressionLiteral(first));
  const prefixText =
    hasPrefix && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ? first.text
      : '*';
  const mountedArg = hasPrefix ? node.arguments[1] : first;
  if (!mountedArg) return null;

  // Check if `mountedArg` is a loop variable in `routes.forEach((route) => app.route('/', route))`
  // or `for (const route of routes) { app.use('/api', route); }`
  if (ts.isIdentifier(mountedArg) && !findValueModuleBinding(sourceFile, mountedArg.text)) {
    const paramName = mountedArg.text;
    let arrayIdent: ts.Identifier | null = null;
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (
        (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
        cur.parameters.length > 0 &&
        ts.isIdentifier(cur.parameters[0].name) &&
        cur.parameters[0].name.text === paramName &&
        cur.parent &&
        ts.isCallExpression(cur.parent) &&
        ts.isPropertyAccessExpression(cur.parent.expression) &&
        cur.parent.expression.name.text === 'forEach' &&
        ts.isIdentifier(cur.parent.expression.expression)
      ) {
        arrayIdent = cur.parent.expression.expression;
        break;
      }
      if (
        ts.isForOfStatement(cur) &&
        ts.isVariableDeclarationList(cur.initializer) &&
        cur.initializer.declarations.length > 0 &&
        ts.isIdentifier(cur.initializer.declarations[0].name) &&
        cur.initializer.declarations[0].name.text === paramName &&
        ts.isIdentifier(cur.expression)
      ) {
        arrayIdent = cur.expression;
        break;
      }
    }
    if (arrayIdent) {
      const decl = findLocalVariableDeclaration(arrayIdent);
      let arrInit = decl?.initializer;
      while (
        arrInit &&
        (ts.isAsExpression(arrInit) ||
          ts.isSatisfiesExpression(arrInit) ||
          ts.isParenthesizedExpression(arrInit))
      ) {
        arrInit = arrInit.expression;
      }
      if (arrInit && ts.isArrayLiteralExpression(arrInit)) {
        const mountEdges: StructuralEntity[] = [];
        for (const el of arrInit.elements) {
          if (!ts.isIdentifier(el)) continue;
          const syntheticCall = ts.factory.updateCallExpression(
            node,
            node.expression,
            node.typeArguments,
            hasPrefix ? [first, el] : [el]
          );
          const targetId = resolveRouterMountTarget(
            syntheticCall,
            sourceFile,
            repoRoot,
            workspaceRegistry
          );
          if (targetId) {
            mountEdges.push({
              id: nextId(),
              name: `Mount: ${prefixText} -> ${el.text}`,
              type: 'RELATIONSHIP',
              entityType: 'MOUNT',
              patternId: 'relationship.express-router-mount',
              sourceId,
              targetId,
              status: 'DETERMINISTIC',
              confidence: 'HIGH',
              evidence: getEvidence(node),
            });
          }
        }
        if (mountEdges.length > 0) {
          return mountEdges.length === 1 ? mountEdges[0] : mountEdges;
        }
      }
    }
  }

  if (methodName === 'route' && hasPrefix) {
    const targetId = resolveRouterMountTarget(node, sourceFile, repoRoot, workspaceRegistry);
    if (targetId) {
      const targetLabel = ts.isIdentifier(mountedArg)
        ? mountedArg.text
        : mountedArg.getText(sourceFile).replace(/\s+/g, ' ').trim();
      return {
        id: nextId(),
        name: `Mount: ${prefixText} -> ${targetLabel}`,
        type: 'RELATIONSHIP',
        entityType: 'MOUNT',
        patternId: 'relationship.express-router-mount',
        sourceId,
        targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: getEvidence(node),
      };
    }
  }

  return null;
}

/**
 * Resolves an event bus / event emitter `.emit(eventKey)` or `.dispatch( new EventClass() )` call
 * to a class method decorated with `@OnEvent(eventKey)`, `@EventPattern(eventKey)`, or `@On(eventKey)`
 * in the same or sibling module directory.
 *
 * @param node              - `CallExpression` AST node.
 * @param sourceFile        - Enclosing TypeScript SourceFile.
 * @param repoRoot          - Repository root path.
 * @param workspaceRegistry - Optional monorepo workspace registry.
 */
export function resolveEventPubSubTarget(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): { targetId: string; targetEvidence: EvidenceRecord } | null {
  if (!ts.isPropertyAccessExpression(node.expression) || node.arguments.length === 0) return null;
  const methodName = node.expression.name.text;
  if (methodName !== 'emit' && methodName !== 'emitAsync' && methodName !== 'dispatch') return null;

  const receiver = node.expression.expression;
  const receiverProp =
    ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword
      ? receiver.name.text
      : ts.isIdentifier(receiver)
        ? receiver.text
        : null;
  if (!receiverProp || !/event|dispatcher|bus/i.test(receiverProp)) return null;

  const firstArg = node.arguments[0];
  let eventKey: string | null = null;
  if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
    eventKey = firstArg.text;
  } else if (ts.isIdentifier(firstArg)) {
    eventKey = firstArg.text;
  } else if (ts.isPropertyAccessExpression(firstArg) && ts.isIdentifier(firstArg.expression)) {
    eventKey = `${firstArg.expression.text}.${firstArg.name.text}`;
  } else if (ts.isNewExpression(firstArg) && ts.isIdentifier(firstArg.expression)) {
    eventKey = firstArg.expression.text;
  }
  if (!eventKey) return null;

  const candidateFiles: ts.SourceFile[] = [sourceFile];
  try {
    const dir = path.dirname(sourceFile.fileName);
    const parentDir = path.dirname(dir);
    for (const searchDir of [dir, parentDir]) {
      if (!searchDir || !fs.existsSync(searchDir)) continue;
      for (const entry of fs.readdirSync(searchDir, { withFileTypes: true })) {
        if (entry.isFile() && /\.[tj]sx?$/.test(entry.name) && !/\.spec\.|\.test\./.test(entry.name)) {
          const sf = getCachedSourceFile(path.join(searchDir, entry.name));
          if (sf && sf !== sourceFile) candidateFiles.push(sf);
        } else if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
          const subDir = path.join(searchDir, entry.name);
          for (const subEntry of fs.readdirSync(subDir, { withFileTypes: true })) {
            if (
              subEntry.isFile() &&
              /\.[tj]sx?$/.test(subEntry.name) &&
              !/\.spec\.|\.test\./.test(subEntry.name)
            ) {
              const sf = getCachedSourceFile(path.join(subDir, subEntry.name));
              if (sf && sf !== sourceFile) candidateFiles.push(sf);
            }
          }
        }
      }
    }
  } catch {
    // Ignore fs errors on synthetic paths
  }

  for (const sf of candidateFiles) {
    const relPath = path.relative(repoRoot, sf.fileName) || sf.fileName;
    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      for (const member of stmt.members) {
        if (!ts.isMethodDeclaration(member) && !ts.isPropertyDeclaration(member)) continue;
        if (!(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
        const meta = extractDecoratorIngressMeta(member);
        if (meta && (meta.eventKey === eventKey || (!meta.eventKey && meta.decoratorName === 'OnEvent'))) {
          const targetScope = resolveLogicalBoundaryScope(
            relPath,
            repoRoot,
            workspaceRegistry,
            findEnclosingNamespaceScope(stmt)
          );
          const targetId = contractEntityId(
            targetScope,
            relPath,
            publicMethodName(stmt.name.text, member.name.text),
            'contract.public-method'
          );
          const start = member.getStart(sf);
          const { line } = sf.getLineAndCharacterOfPosition(start);
          return {
            targetId,
            targetEvidence: {
              filePath: relPath,
              lineNumber: line + 1,
              snippet: member.getText(sf).slice(0, 80).replace(/\s+/g, ' ').trim(),
              evidenceRole: 'target-signature',
            },
          };
        }
      }
    }
  }
  return null;
}

/**
 * Extracts `CALL` delegation relationships for:
 * - Next.js Route Handler destructured exports (`export const { GET, POST } = handlers` in `route.ts`)
 * - Next.js Middleware alias exports (`export { auth as middleware } from '@/lib/auth'` in `middleware.ts`)
 * - CommonJS default export assignments (`exports = module.exports = createAdapter`)
 *
 * @param node              - Candidate statement or expression AST node.
 * @param sourceFile        - Enclosing TypeScript SourceFile.
 * @param getEvidence       - Evidence builder callback.
 * @param nextId            - Placeholder ID generator.
 * @param repoRoot          - Repository root path.
 * @param workspaceRegistry - Optional monorepo workspace registry.
 */
export function extractModuleExportDelegationEdges(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry,
  defaultSourceId: string = ''
): StructuralEntity | StructuralEntity[] | null {
  // 1. Next.js Route Handler Destructure Delegation (`export const { GET, POST } = handlers` in `route.ts`)
  if (
    ts.isVariableStatement(node) &&
    ts.isSourceFile(node.parent) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
    if (classifyNextjsFile(relPath) === 'ROUTE_HANDLER') {
      const delegatedEdges: StructuralEntity[] = [];
      for (const decl of node.declarationList.declarations) {
        if (
          !ts.isObjectBindingPattern(decl.name) ||
          !decl.initializer ||
          !ts.isIdentifier(decl.initializer)
        ) {
          continue;
        }
        const rhsIdent = decl.initializer;
        const rhsName = rhsIdent.text;
        const methods = decl.name.elements
          .filter((el) => ts.isIdentifier(el.name) && ROUTE_HTTP_METHODS.has(el.name.text))
          .map((el) => (el.name as ts.Identifier).text);
        if (methods.length === 0) continue;

        const binding = findValueModuleBinding(sourceFile, rhsName);
        if (!binding) continue;
        const resolvedPath = resolveModulePath(
          binding.moduleSpecifier,
          sourceFile.fileName,
          repoRoot,
          workspaceRegistry
        );
        if (!resolvedPath) continue;
        const lookupSymbol =
          binding.importedName &&
          binding.importedName !== 'default' &&
          binding.importedName !== '*'
            ? binding.importedName
            : rhsName;
        const res = resolveTargetExport(
          resolvedPath,
          lookupSymbol,
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function'
        );
        if (!res) continue;

        const sourceScope = resolveLogicalBoundaryScope(
          relPath,
          repoRoot,
          workspaceRegistry,
          findEnclosingNamespaceScope(node)
        );
        const callEv = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
        const rhsImportKind = classifyImportedBindingKind(sourceFile, rhsName, {
          repoRoot,
          workspaceRegistry,
        });
        for (const methodName of methods) {
          delegatedEdges.push({
            id: nextId(),
            name: `Call: ${rhsName}.${methodName}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.function-call',
            sourceId: contractEntityId(
              sourceScope,
              relPath,
              `Route Handler: ${methodName}`,
              'contract.nextjs-route-handler'
            ),
            targetId: res.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: [callEv, res.targetEvidence],
            metadata: { shapeKey: `${SHAPE_KEY_VERSION}/CALL/${rhsImportKind}/Prop(Id)` },
          });
        }
      }
      if (delegatedEdges.length > 0) {
        return delegatedEdges.length === 1 ? delegatedEdges[0] : delegatedEdges;
      }
    }
  }

  // 2. Next.js Middleware Alias Delegation (`export { auth as middleware } from '@/lib/auth'` in `middleware.ts`)
  if (
    ts.isExportDeclaration(node) &&
    node.exportClause &&
    ts.isNamedExports(node.exportClause)
  ) {
    const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
    if (classifyNextjsFile(relPath) === 'MIDDLEWARE') {
      const mwEl = node.exportClause.elements.find((el) => el.name.text === 'middleware');
      if (mwEl) {
        const origSymbol = (mwEl.propertyName ?? mwEl.name).text;
        let specifier: string | null = null;
        let lookupSymbol = origSymbol;
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specifier = node.moduleSpecifier.text;
        } else {
          const binding = findValueModuleBinding(sourceFile, origSymbol);
          if (binding) {
            specifier = binding.moduleSpecifier;
            if (
              binding.importedName &&
              binding.importedName !== 'default' &&
              binding.importedName !== '*'
            ) {
              lookupSymbol = binding.importedName;
            }
          }
        }
        if (specifier) {
          const resolvedPath = resolveModulePath(
            specifier,
            sourceFile.fileName,
            repoRoot,
            workspaceRegistry
          );
          if (resolvedPath) {
            const res = resolveTargetExport(
              resolvedPath,
              lookupSymbol,
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function'
            );
            if (res) {
              const sourceScope = resolveLogicalBoundaryScope(
                relPath,
                repoRoot,
                workspaceRegistry,
                findEnclosingNamespaceScope(node)
              );
              return {
                id: nextId(),
                name: `Call: ${origSymbol}()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL',
                patternId: 'relationship.function-call',
                sourceId: stableEntityId(sourceScope, 'CONTRACT', 'Next.js Middleware'),
                targetId: res.targetId,
                status: 'DETERMINISTIC',
                confidence: 'HIGH',
                evidence: [
                  { ...getEvidence(node), evidenceRole: 'syntax-call' },
                  res.targetEvidence,
                ],
                metadata: { shapeKey: `${SHAPE_KEY_VERSION}/CALL/Import/Id` },
              };
            }
          }
        }
      }
    }
  }

  // 3. CommonJS default export assignment delegating to an already-exported same-file ES contract
  // (`export function createAdapter() {}` + `exports = module.exports = createAdapter`)
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    node.parent &&
    ts.isExpressionStatement(node.parent) &&
    ts.isSourceFile(node.parent.parent)
  ) {
    const cjsEntity = extractCommonjsExport(node, getEvidence, () => '');
    if (cjsEntity && cjsEntity.type === 'CONTRACT' && cjsEntity.name === 'CJS Export: default') {
      let rhs: ts.Expression = node.right;
      while (ts.isBinaryExpression(rhs) && rhs.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        rhs = rhs.right;
      }
      if (ts.isIdentifier(rhs)) {
        const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
        const sourceScope = resolveLogicalBoundaryScope(
          relPath,
          repoRoot,
          workspaceRegistry,
          findEnclosingNamespaceScope(node)
        );
        const cjsDefaultId = cjsContractEntityId(sourceScope, relPath, 'CJS Export: default');
        const sameFileTarget = resolveSameFileExportedFunction(
          rhs.text,
          sourceFile,
          sourceFile,
          repoRoot,
          workspaceRegistry
        );
        if (sameFileTarget && sameFileTarget.targetId !== cjsDefaultId) {
          return {
            id: nextId(),
            name: `Call: ${rhs.text}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.function-call',
            sourceId: cjsDefaultId,
            targetId: sameFileTarget.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: [
              { ...getEvidence(node), evidenceRole: 'syntax-call' },
              sameFileTarget.targetEvidence,
            ],
            metadata: { shapeKey: computeIdentifierRefShapeKey(rhs, { repoRoot, workspaceRegistry }) },
          };
        }
      }
    }
  }

  // Case 4: Side-effect relative import (`import '../src/app/runtime/commands/indexes'`)
  // (`[PAT-EXT-51]`).
  if (
    ts.isImportDeclaration(node) &&
    !node.importClause &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    const spec = node.moduleSpecifier.text;
    if (!isExternalSpecifier(spec, sourceFile.fileName, repoRoot, workspaceRegistry)) {
      const resolvedMod = resolveModulePath(spec, sourceFile.fileName, repoRoot, workspaceRegistry);
      if (resolvedMod) {
        let resolvedTarget = resolveTargetExport(
          resolvedMod,
          'default',
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function'
        );
        if (!resolvedTarget) {
          const targetSf = getCachedSourceFile(path.resolve(repoRoot, resolvedMod));
          if (targetSf) {
            const targetRole = classifyNextjsFile(resolvedMod);
            for (const stmt of targetSf.statements) {
              const extracted = visitContract(
                stmt,
                targetSf,
                (n) => {
                  const start = n.getStart(targetSf);
                  const { line } = targetSf.getLineAndCharacterOfPosition(start);
                  return {
                    filePath: resolvedMod,
                    lineNumber: line + 1,
                    snippet: n.getText(targetSf).slice(0, 80).replace(/\s+/g, ' ').trim(),
                    evidenceRole: 'target-signature',
                  };
                },
                () => '',
                targetRole,
                resolvedMod
              );
              const list = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
              const firstContract = list.find(
                (e) => e.type === 'CONTRACT' && e.entityType !== 'EXPORTED_TYPE'
              );
              if (firstContract) {
                const targetScope = resolveLogicalBoundaryScope(
                  resolvedMod,
                  repoRoot,
                  workspaceRegistry,
                  findEnclosingNamespaceScope(stmt)
                );
                const targetEv = Array.isArray(firstContract.evidence)
                  ? firstContract.evidence[0]
                  : firstContract.evidence;
                resolvedTarget = {
                  targetId: contractEntityId(
                    targetScope,
                    resolvedMod,
                    firstContract.name,
                    firstContract.patternId
                  ),
                  targetEvidence: targetEv,
                };
                break;
              }
            }
            if (!resolvedTarget) {
              const targetIdx = getSourceFileDeclarationIndex(targetSf);
              if (targetIdx.topLevelClassNames.size > 0) {
                const targetScope = resolveLogicalBoundaryScope(resolvedMod, repoRoot, workspaceRegistry);
                const callEv = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
                const classEdges: StructuralEntity[] = [];
                for (const clsName of targetIdx.topLevelClassNames) {
                  classEdges.push({
                    id: nextId(),
                    name: `Call: import(${spec})`,
                    type: 'RELATIONSHIP',
                    entityType: 'CALL',
                    patternId: 'relationship.module-export-delegation',
                    sourceId: defaultSourceId,
                    targetId: boundaryEntityId(targetScope, resolvedMod, `Class: ${clsName}`),
                    status: 'DETERMINISTIC',
                    confidence: 'HIGH',
                    evidence: [callEv],
                  });
                }
                return classEdges.length === 1 ? classEdges[0] : classEdges;
              }
            }
          }
        }
        if (resolvedTarget) {
          return {
            id: nextId(),
            name: `Call: import(${spec})`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.module-export-delegation',
            sourceId: defaultSourceId,
            targetId: resolvedTarget.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: [
              { ...getEvidence(node), evidenceRole: 'syntax-call' },
              resolvedTarget.targetEvidence,
            ],
          };
        }
      }
    }
  }

  // Case 5: `export default <importedIdentifier>` delegating the file's default export contract
  // to an imported intra-repo contract or class boundary (e.g. `import Toolkit from './Toolkit'; export default Toolkit;`).
  if (
    ts.isExportAssignment(node) &&
    !node.isExportEquals &&
    ts.isIdentifier(node.expression)
  ) {
    const identName = node.expression.text;
    const binding = findValueModuleBinding(sourceFile, identName);
    if (
      binding &&
      !isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)
    ) {
      const resolvedMod = resolveModulePath(
        binding.moduleSpecifier,
        sourceFile.fileName,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedMod) {
        const lookupSymbol =
          binding.importedName && binding.importedName !== '*'
            ? binding.importedName
            : identName;
        const resolvedTarget =
          resolveTargetExport(
            resolvedMod,
            lookupSymbol,
            repoRoot,
            workspaceRegistry ?? {},
            'Exported Function',
            0,
            undefined,
            true
          ) ??
          resolveClassBoundaryInModule(
            resolvedMod,
            lookupSymbol,
            repoRoot,
            workspaceRegistry ?? {}
          );
        if (resolvedTarget) {
          return {
            id: nextId(),
            name: `Call: ${identName}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: 'relationship.module-export-delegation',
            sourceId: defaultSourceId,
            targetId: resolvedTarget.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: [
              { ...getEvidence(node), evidenceRole: 'syntax-call' },
              resolvedTarget.targetEvidence,
            ],
          };
        }
      }
    }
  }

  // Case 6: Enclosing exported plugin/factory function delegating to an inner `Prototype Method: X.prototype.y`
  // (`export default function jsxPlugin(instance) { Parser.prototype.jsx_readToken = function() {}; }`)
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    ts.isPropertyAccessExpression(node.left.expression) &&
    node.left.expression.name.text === 'prototype'
  ) {
    const protoEntity = extractCommonjsExport(node, getEvidence, () => '');
    if (protoEntity && protoEntity.type === 'CONTRACT' && protoEntity.entityType === 'PROTOTYPE_METHOD') {
      let cur: ts.Node | undefined = node.parent;
      let enclosingTopStmt: ts.Statement | undefined;
      while (cur && !ts.isSourceFile(cur)) {
        if (cur.parent && ts.isSourceFile(cur.parent) && ts.isStatement(cur)) {
          enclosingTopStmt = cur;
          break;
        }
        cur = cur.parent;
      }
      if (enclosingTopStmt && enclosingTopStmt !== node.parent) {
        const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
        const fileRole = classifyNextjsFile(relPath);
        const extracted = visitContract(
          enclosingTopStmt,
          sourceFile,
          getEvidence,
          () => '',
          fileRole,
          relPath
        );
        const list = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
        const enclosingContract = list.find(
          (e) => e.type === 'CONTRACT' && e.name !== protoEntity.name
        );
        if (enclosingContract) {
          const sourceScope = resolveLogicalBoundaryScope(
            relPath,
            repoRoot,
            workspaceRegistry,
            findEnclosingNamespaceScope(enclosingTopStmt)
          );
          const enclosingId =
            enclosingContract.patternId === 'contract.commonjs-export'
              ? cjsContractEntityId(sourceScope, relPath, enclosingContract.name)
              : contractEntityId(
                  sourceScope,
                  relPath,
                  enclosingContract.name,
                  enclosingContract.patternId
                );
          const protoId = contractEntityId(
            sourceScope,
            relPath,
            protoEntity.name,
            protoEntity.patternId
          );
          if (enclosingId !== protoId) {
            return {
              id: nextId(),
              name: `Delegates: ${protoEntity.name}`,
              type: 'RELATIONSHIP',
              entityType: 'CALL',
              patternId: 'relationship.module-export-delegation',
              sourceId: enclosingId,
              targetId: protoId,
              status: 'DETERMINISTIC',
              confidence: 'HIGH',
              evidence: [{ ...getEvidence(node), evidenceRole: 'syntax-call' }],
            };
          }
        }
      }
    }
  }

  // Case 7: React Native / Expo platform-extension sibling delegation (`Step1Welcome.native.tsx` -> `Step1Welcome.web.tsx`)
  if (ts.isSourceFile(node)) {
    const fileAbs = sourceFile.fileName;
    const baseName = path.basename(fileAbs);
    const match = baseName.match(/^(.+?)(?:\.(native|ios|android))?(\.[tj]sx?)$/);
    if (match) {
      const [, stem, platformTag, ext] = match;
      const dir = path.dirname(fileAbs);
      const siblingSuffixes = platformTag
        ? [`.web${ext}`, `.web.tsx`, `.web.ts`]
        : [`.native${ext}`, `.web${ext}`, `.ios${ext}`, `.android${ext}`];
      const siblingEdges: StructuralEntity[] = [];
      const seenSiblings = new Set<string>();
      const relPath = path.relative(repoRoot, fileAbs) || fileAbs;
      const sourceRole = classifyNextjsFile(relPath);
      const sourceScope = resolveLogicalBoundaryScope(relPath, repoRoot, workspaceRegistry);

      for (const suffix of siblingSuffixes) {
        const siblingAbs = path.join(dir, `${stem}${suffix}`);
        if (siblingAbs === fileAbs || seenSiblings.has(siblingAbs) || !fs.existsSync(siblingAbs)) {
          continue;
        }
        seenSiblings.add(siblingAbs);
        const siblingSf = getCachedSourceFile(siblingAbs);
        if (!siblingSf) continue;
        const siblingRel = path.relative(repoRoot, siblingAbs) || siblingAbs;
        const siblingRole = classifyNextjsFile(siblingRel);
        const siblingScope = resolveLogicalBoundaryScope(siblingRel, repoRoot, workspaceRegistry);

        const siblingContractsByName = new Map<
          string,
          { id: string; evidence: EvidenceRecord }
        >();
        for (const sStmt of siblingSf.statements) {
          const sExtracted = visitContract(
            sStmt,
            siblingSf,
            (n) => {
              const start = n.getStart(siblingSf);
              const { line } = siblingSf.getLineAndCharacterOfPosition(start);
              return {
                filePath: siblingRel,
                lineNumber: line + 1,
                snippet: n.getText(siblingSf).slice(0, 80).replace(/\s+/g, ' ').trim(),
                evidenceRole: 'target-signature',
              };
            },
            () => '',
            siblingRole,
            siblingRel
          );
          const sList = Array.isArray(sExtracted) ? sExtracted : sExtracted ? [sExtracted] : [];
          for (const sEnt of sList) {
            if (sEnt.type !== 'CONTRACT' || sEnt.entityType === 'EXPORTED_TYPE') continue;
            const sId = contractEntityId(siblingScope, siblingRel, sEnt.name, sEnt.patternId);
            const sEv = Array.isArray(sEnt.evidence) ? sEnt.evidence[0] : sEnt.evidence;
            siblingContractsByName.set(sEnt.name, { id: sId, evidence: sEv });
          }
        }
        if (siblingContractsByName.size === 0) continue;

        for (const stmt of sourceFile.statements) {
          const extracted = visitContract(stmt, sourceFile, getEvidence, () => '', sourceRole, relPath);
          const list = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
          for (const ent of list) {
            if (ent.type !== 'CONTRACT' || ent.entityType === 'EXPORTED_TYPE') continue;
            const matchedSibling = siblingContractsByName.get(ent.name);
            if (!matchedSibling) continue;
            const srcId = contractEntityId(sourceScope, relPath, ent.name, ent.patternId);
            if (srcId === matchedSibling.id) continue;
            siblingEdges.push({
              id: nextId(),
              name: `Platform Sibling: ${ent.name}`,
              type: 'RELATIONSHIP',
              entityType: 'CALL',
              patternId: 'relationship.platform-extension-module-resolution',
              sourceId: srcId,
              targetId: matchedSibling.id,
              status: 'DETERMINISTIC',
              confidence: 'HIGH',
              evidence: [
                { ...getEvidence(stmt), evidenceRole: 'syntax-call' },
                matchedSibling.evidence,
              ],
            });
          }
        }
      }
      if (siblingEdges.length > 0) {
        return siblingEdges.length === 1 ? siblingEdges[0] : siblingEdges;
      }
    }
  }

  return null;
}

/**
 * Extracts `RENDERS` relationships for React components passed via a local component-map object
 * prop (`<DataTable headerComponents={COLUMN_HEADER_COMPONENTS} />`).
 *
 * @param node              - JSX element or self-closing element.
 * @param sourceFile        - Enclosing TypeScript SourceFile.
 * @param getEvidence       - Evidence builder callback.
 * @param nextId            - Placeholder ID generator.
 * @param repoRoot          - Repository root path.
 * @param sourceId          - Owning source entity ID.
 * @param workspaceRegistry - Optional monorepo workspace registry.
 */
export function extractJsxComponentMapPropEdges(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity[] {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const mapRenderEdges: StructuralEntity[] = [];
  for (const attr of opening.attributes.properties) {
    if (
      !ts.isJsxAttribute(attr) ||
      !attr.initializer ||
      !ts.isJsxExpression(attr.initializer) ||
      !attr.initializer.expression ||
      !ts.isIdentifier(attr.initializer.expression)
    ) {
      continue;
    }
    const mapIdent = attr.initializer.expression;
    const localMapDecl = findLocalVariableDeclaration(mapIdent);
    if (!localMapDecl?.initializer) continue;
    let mapInit: ts.Expression = localMapDecl.initializer;
    while (
      ts.isParenthesizedExpression(mapInit) ||
      ts.isAsExpression(mapInit) ||
      ts.isSatisfiesExpression(mapInit) ||
      ts.isTypeAssertionExpression(mapInit) ||
      ts.isNonNullExpression(mapInit)
    ) {
      mapInit = mapInit.expression;
    }
    if (!ts.isObjectLiteralExpression(mapInit)) continue;
    const mapObj = mapInit;
    for (const prop of mapObj.properties) {
      const compIdent = ts.isShorthandPropertyAssignment(prop)
        ? prop.name
        : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
          ? prop.initializer
          : null;
      if (!compIdent || !/^[A-Z]/.test(compIdent.text)) continue;
      let resolvedComp = resolveSameFileExportedFunction(
        compIdent.text,
        compIdent,
        sourceFile,
        repoRoot,
        workspaceRegistry
      );
      if (!resolvedComp) {
        const compBinding = findValueModuleBinding(sourceFile, compIdent.text);
        if (compBinding) {
          const compPath = resolveModulePath(
            compBinding.moduleSpecifier,
            sourceFile.fileName,
            repoRoot,
            workspaceRegistry
          );
          if (compPath) {
            const lookupSym =
              compBinding.importedName &&
              compBinding.importedName !== 'default' &&
              compBinding.importedName !== '*'
                ? compBinding.importedName
                : compIdent.text;
            resolvedComp =
              resolveTargetExport(compPath, lookupSym, repoRoot, workspaceRegistry ?? {}, 'Exported Function') ??
              (compBinding.importedName === 'default'
                ? resolveTargetExport(compPath, 'default', repoRoot, workspaceRegistry ?? {}, 'Exported Function')
                : null);
          }
        }
      }
      if (resolvedComp) {
        mapRenderEdges.push({
          id: nextId(),
          name: `Renders: <${compIdent.text} />`,
          type: 'RELATIONSHIP',
          entityType: 'RENDERS',
          patternId: 'relationship.jsx-element',
          sourceId,
          targetId: resolvedComp.targetId,
          status: 'DETERMINISTIC',
          confidence: 'HIGH',
          evidence: [
            { ...getEvidence(attr), evidenceRole: 'syntax-call' },
            resolvedComp.targetEvidence,
          ],
        });
      }
    }
  }
  return mapRenderEdges;
}

/**
 * Extracts `CALL` relationships from:
 * - NestJS `@UseGuards(...)`, `@UsePipes(...)`, and `@UseInterceptors(...)` decorators to their
 *   target class's `canActivate`, `transform`, or `intercept` public method.
 * - Concrete adapter classes extending or implementing an abstract port class to wire each abstract
 *   port `PUBLIC_METHOD` to its concrete adapter implementation (`Port.method -> Adapter.method`).
 *
 * @param node              - Candidate `MethodDeclaration` or `ClassDeclaration` AST node.
 * @param sourceFile        - Enclosing TypeScript SourceFile.
 * @param getEvidence       - Evidence builder callback.
 * @param nextId            - Placeholder ID generator.
 * @param repoRoot          - Repository root path.
 * @param sourceId          - Owning source entity ID.
 * @param workspaceRegistry - Optional monorepo workspace registry.
 */
export function extractNestDecoratorAndPortAdapterEdges(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | StructuralEntity[] | null {
  const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
  const nodeScope = resolveLogicalBoundaryScope(
    relPath,
    repoRoot,
    workspaceRegistry,
    findEnclosingNamespaceScope(node)
  );
  if (ts.isCallExpression(node)) {
    const calleeName = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : null;
    if (
      calleeName === 'createExpressServer' ||
      calleeName === 'createKoaServer' ||
      calleeName === 'useExpressServer' ||
      calleeName === 'useKoaServer'
    ) {
      const optionEdges: StructuralEntity[] = [];
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue;
        for (const prop of arg.properties) {
          if (
            !ts.isPropertyAssignment(prop) ||
            (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) ||
            !['controllers', 'middlewares', 'interceptors'].includes(prop.name.text) ||
            !ts.isArrayLiteralExpression(prop.initializer)
          ) {
            continue;
          }
          for (const elem of prop.initializer.elements) {
            if (!ts.isIdentifier(elem)) continue;
            const localCls = getSourceFileDeclarationIndex(sourceFile).classDeclsByName.get(elem.text);
            const resolvedTarget =
              localCls && localCls.name
                ? {
                    targetId: stableEntityId(nodeScope, 'BOUNDARY', `Class: ${localCls.name.text}`),
                    targetEvidence: { ...getEvidence(localCls), evidenceRole: 'target-signature' as const },
                  }
                : resolveImportedClassBoundaryTargetWithEvidence(
                    elem.text,
                    sourceFile,
                    repoRoot,
                    workspaceRegistry,
                    undefined,
                    true
                  );
            if (resolvedTarget) {
              optionEdges.push({
                id: nextId(),
                name: `References: ${elem.text}`,
                type: 'RELATIONSHIP',
                entityType: 'REFERENCES',
                patternId: 'relationship.class-reference-in-decorator-and-options',
                sourceId,
                targetId: resolvedTarget.targetId,
                status: 'DETERMINISTIC',
                confidence: 'HIGH',
                evidence: [
                  { ...getEvidence(elem), evidenceRole: 'syntax-call' },
                  resolvedTarget.targetEvidence,
                ],
              });
            }
          }
        }
      }
      if (optionEdges.length > 0) {
        return optionEdges.length === 1 ? optionEdges[0] : optionEdges;
      }
    }
    return null;
  }
  if (
    !ts.isMethodDeclaration(node) &&
    !ts.isClassDeclaration(node) &&
    !ts.isPropertyDeclaration(node)
  ) {
    return null;
  }
  const effectiveSourceId =
    ts.isMethodDeclaration(node) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
    node.parent &&
    ts.isClassDeclaration(node.parent) &&
    node.parent.name
      ? contractEntityId(
          nodeScope,
          relPath,
          publicMethodName(node.parent.name.text, node.name.text),
          'contract.public-method'
        )
      : ts.isClassDeclaration(node) && node.name
        ? stableEntityId(nodeScope, 'BOUNDARY', `Class: ${node.name.text}`)
        : ts.isPropertyDeclaration(node) &&
            node.parent &&
            ts.isClassDeclaration(node.parent) &&
            node.parent.name
          ? stableEntityId(nodeScope, 'BOUNDARY', `Class: ${node.parent.name.text}`)
          : sourceId;
  const decoratorEdges: StructuralEntity[] = [];
  if (
    ts.isClassDeclaration(node) &&
    node.name &&
    !ts.isSourceFile(node.parent) &&
    !ts.isModuleBlock(node.parent) &&
    ts.canHaveDecorators(node) &&
    (ts.getDecorators(node)?.length ?? 0) > 0 &&
    sourceId &&
    sourceId !== effectiveSourceId
  ) {
    decoratorEdges.push({
      id: nextId(),
      name: `Registers: ${node.name.text}`,
      type: 'RELATIONSHIP',
      entityType: 'REFERENCES',
      patternId: 'relationship.nestjs-module-provider-registration',
      sourceId,
      targetId: effectiveSourceId,
      status: 'DETERMINISTIC',
      confidence: 'HIGH',
      evidence: [{ ...getEvidence(node), evidenceRole: 'syntax-call' }],
    });
  }
  if (ts.canHaveDecorators(node)) {
    const decorators = ts.getDecorators(node) ?? [];
    for (const dec of decorators) {
      if (!ts.isCallExpression(dec.expression)) continue;
      const callee = dec.expression.expression;
      const decName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (decName === 'Type' && dec.expression.arguments.length > 0) {
        const typeArg = dec.expression.arguments[0];
        if ((ts.isArrowFunction(typeArg) || ts.isFunctionExpression(typeArg)) && ts.isIdentifier(typeArg.body)) {
          const typeClassIdent = typeArg.body;
          const localCls = getSourceFileDeclarationIndex(sourceFile).classDeclsByName.get(typeClassIdent.text);
          const resolvedTarget =
            localCls && localCls.name
              ? {
                  targetId: stableEntityId(nodeScope, 'BOUNDARY', `Class: ${localCls.name.text}`),
                  targetEvidence: { ...getEvidence(localCls), evidenceRole: 'target-signature' as const },
                }
              : resolveImportedClassBoundaryTargetWithEvidence(
                  typeClassIdent.text,
                  sourceFile,
                  repoRoot,
                  workspaceRegistry,
                  undefined,
                  true
                );
          if (resolvedTarget) {
            decoratorEdges.push({
              id: nextId(),
              name: `References: ${typeClassIdent.text}`,
              type: 'RELATIONSHIP',
              entityType: 'REFERENCES',
              patternId: 'relationship.class-reference-in-decorator-and-options',
              sourceId: effectiveSourceId,
              targetId: resolvedTarget.targetId,
              status: 'DETERMINISTIC',
              confidence: 'HIGH',
              evidence: [
                { ...getEvidence(dec), evidenceRole: 'syntax-call' },
                resolvedTarget.targetEvidence,
              ],
            });
          }
        }
        continue;
      }
      if (
        decName === 'Module' &&
        ts.isClassDeclaration(node) &&
        node.name &&
        dec.expression.arguments.length > 0 &&
        ts.isObjectLiteralExpression(dec.expression.arguments[0])
      ) {
        const moduleScope = nodeScope;
        const moduleBoundaryId = stableEntityId(
          moduleScope,
          'BOUNDARY',
          `Class: ${node.name.text}`
        );
        const configObj = dec.expression.arguments[0];
        for (const prop of configObj.properties) {
          if (
            !ts.isPropertyAssignment(prop) ||
            (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) ||
            !['providers', 'controllers', 'exports', 'imports'].includes(prop.name.text) ||
            !ts.isArrayLiteralExpression(prop.initializer)
          ) {
            continue;
          }
          const classIdents: ts.Identifier[] = [];
          for (const elem of prop.initializer.elements) {
            if (ts.isIdentifier(elem)) {
              classIdents.push(elem);
            } else if (ts.isObjectLiteralExpression(elem)) {
              for (const innerProp of elem.properties) {
                if (
                  ts.isPropertyAssignment(innerProp) &&
                  (ts.isIdentifier(innerProp.name) || ts.isStringLiteral(innerProp.name)) &&
                  (innerProp.name.text === 'useClass' || innerProp.name.text === 'useExisting') &&
                  ts.isIdentifier(innerProp.initializer)
                ) {
                  classIdents.push(innerProp.initializer);
                }
              }
            }
          }
          for (const classIdent of classIdents) {
            const localCls = getSourceFileDeclarationIndex(sourceFile).classDeclsByName.get(
              classIdent.text
            );
            let resolvedTarget: { targetId: string; targetEvidence: EvidenceRecord } | null = null;
            if (localCls && localCls.name) {
              const start = localCls.getStart(sourceFile);
              const { line } = sourceFile.getLineAndCharacterOfPosition(start);
              resolvedTarget = {
                targetId: stableEntityId(moduleScope, 'BOUNDARY', `Class: ${localCls.name.text}`),
                targetEvidence: {
                  filePath: relPath,
                  lineNumber: line + 1,
                  snippet: localCls.getText(sourceFile).slice(0, 80).replace(/\s+/g, ' ').trim(),
                  evidenceRole: 'target-signature',
                },
              };
            } else {
              resolvedTarget = resolveImportedClassBoundaryTargetWithEvidence(
                classIdent.text,
                sourceFile,
                repoRoot,
                workspaceRegistry,
                undefined,
                true
              );
            }
            if (resolvedTarget) {
              decoratorEdges.push({
                id: nextId(),
                name: `Registers: ${classIdent.text}`,
                type: 'RELATIONSHIP',
                entityType: 'REFERENCES',
                patternId: 'relationship.nestjs-module-provider-registration',
                sourceId: moduleBoundaryId,
                targetId: resolvedTarget.targetId,
                status: 'DETERMINISTIC',
                confidence: 'HIGH',
                evidence: [
                  { ...getEvidence(classIdent), evidenceRole: 'syntax-call' },
                  resolvedTarget.targetEvidence,
                ],
              });
            }
          }
        }
        continue;
      }
      if (
        decName !== 'UseGuards' &&
        decName !== 'UsePipes' &&
        decName !== 'UseInterceptors' &&
        decName !== 'UseFilters' &&
        decName !== 'UseBefore' &&
        decName !== 'UseAfter'
      ) {
        continue;
      }
      const isRoutingControllersUse = decName === 'UseBefore' || decName === 'UseAfter';
      const targetMethodName =
        decName === 'UseGuards'
          ? 'canActivate'
          : decName === 'UsePipes'
            ? 'transform'
            : decName === 'UseInterceptors'
              ? 'intercept'
              : isRoutingControllersUse
                ? 'use'
                : 'catch';
      for (const arg of dec.expression.arguments) {
        const classIdent = ts.isIdentifier(arg)
          ? arg
          : ts.isNewExpression(arg) && ts.isIdentifier(arg.expression)
            ? arg.expression
            : null;
        if (!classIdent) continue;
        const syntheticCall = ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(classIdent, targetMethodName),
          undefined,
          []
        );
        const resolved =
          resolveClassMethodTargetWithEvidence(
            syntheticCall,
            sourceFile,
            repoRoot,
            workspaceRegistry
          ) ??
          (isRoutingControllersUse
            ? resolveImportedClassBoundaryTargetWithEvidence(
                classIdent.text,
                sourceFile,
                repoRoot,
                workspaceRegistry,
                undefined,
                true
              )
            : null);
        if (resolved) {
          decoratorEdges.push({
            id: nextId(),
            name: `Call: ${classIdent.text}.${targetMethodName}()`,
            type: 'RELATIONSHIP',
            entityType: 'CALL',
            patternId: isRoutingControllersUse
              ? 'relationship.class-reference-in-decorator-and-options'
              : 'relationship.function-call',
            sourceId: effectiveSourceId,
            targetId: resolved.targetId,
            status: 'DETERMINISTIC',
            confidence: 'HIGH',
            evidence: [
              { ...getEvidence(dec), evidenceRole: 'syntax-call' },
              resolved.targetEvidence,
            ],
            metadata: { shapeKey: `${SHAPE_KEY_VERSION}/CALL/Import/Prop(Id)` },
          });
        }
      }
    }
  }

  if (ts.isMethodDeclaration(node)) {
    const PARAM_PIPE_DECORATORS = new Set([
      'Param',
      'Body',
      'Query',
      'Headers',
      'UploadedFile',
      'UploadedFiles',
      'Args',
    ]);
    for (const param of node.parameters) {
      if (!ts.canHaveDecorators(param)) continue;
      const paramDecs = ts.getDecorators(param) ?? [];
      for (const pDec of paramDecs) {
        if (!ts.isCallExpression(pDec.expression)) continue;
        const pCallee = pDec.expression.expression;
        const pDecName = ts.isIdentifier(pCallee)
          ? pCallee.text
          : ts.isPropertyAccessExpression(pCallee)
            ? pCallee.name.text
            : null;
        if (!pDecName || !PARAM_PIPE_DECORATORS.has(pDecName)) continue;
        for (const arg of pDec.expression.arguments) {
          const pipeIdent = ts.isIdentifier(arg)
            ? arg
            : ts.isNewExpression(arg) && ts.isIdentifier(arg.expression)
              ? arg.expression
              : null;
          if (!pipeIdent) continue;
          const syntheticCall = ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(pipeIdent, 'transform'),
            undefined,
            []
          );
          const resolved = resolveClassMethodTargetWithEvidence(
            syntheticCall,
            sourceFile,
            repoRoot,
            workspaceRegistry
          );
          if (resolved) {
            decoratorEdges.push({
              id: nextId(),
              name: `Call: ${pipeIdent.text}.transform()`,
              type: 'RELATIONSHIP',
              entityType: 'CALL',
              patternId: 'relationship.function-call',
              sourceId: effectiveSourceId,
              targetId: resolved.targetId,
              status: 'DETERMINISTIC',
              confidence: 'HIGH',
              evidence: [
                { ...getEvidence(pDec), evidenceRole: 'syntax-call' },
                resolved.targetEvidence,
              ],
              metadata: { shapeKey: `${SHAPE_KEY_VERSION}/CALL/Import/Prop(Id)` },
            });
          }
        }
      }
    }

    if (node.name && ts.isIdentifier(node.name) && node.name.text === 'configure' && node.body) {
      const walkConfigure = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'apply'
        ) {
          for (const arg of n.arguments) {
            const mwIdent = ts.isIdentifier(arg)
              ? arg
              : ts.isNewExpression(arg) && ts.isIdentifier(arg.expression)
                ? arg.expression
                : null;
            if (!mwIdent) continue;
            const syntheticCall = ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(mwIdent, 'use'),
              undefined,
              []
            );
            const resolved = resolveClassMethodTargetWithEvidence(
              syntheticCall,
              sourceFile,
              repoRoot,
              workspaceRegistry
            );
            if (resolved) {
              decoratorEdges.push({
                id: nextId(),
                name: `Call: ${mwIdent.text}.use()`,
                type: 'RELATIONSHIP',
                entityType: 'CALL',
                patternId: 'relationship.function-call',
                sourceId: effectiveSourceId,
                targetId: resolved.targetId,
                status: 'DETERMINISTIC',
                confidence: 'HIGH',
                evidence: [
                  { ...getEvidence(n), evidenceRole: 'syntax-call' },
                  resolved.targetEvidence,
                ],
                metadata: { shapeKey: `${SHAPE_KEY_VERSION}/CALL/Import/Prop(Id)` },
              });
            }
          }
        }
        ts.forEachChild(n, walkConfigure);
      };
      walkConfigure(node.body);
    }
  }

  if (
    ts.isClassDeclaration(node) &&
    node.name &&
    node.heritageClauses
  ) {
    const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
    const concreteScope = resolveLogicalBoundaryScope(
      relPath,
      repoRoot,
      workspaceRegistry,
      findEnclosingNamespaceScope(node)
    );
    const isAbstractSubClass = Boolean(
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)
    );
    const concreteMethods = getSourceFileDeclarationIndex(sourceFile).publicMethodsByClass.get(node.name.text);
    for (const hc of node.heritageClauses) {
      for (const typeNode of hc.types) {
        if (!ts.isIdentifier(typeNode.expression)) continue;
        const portName = typeNode.expression.text;
        let portClass: ts.ClassDeclaration | undefined;
        let portRelPath = relPath;
        let portSf = sourceFile;
        const localPort = getSourceFileDeclarationIndex(sourceFile).classDeclsByName.get(portName);
        if (localPort) {
          portClass = localPort;
        } else {
          const binding = findModuleBinding(sourceFile, portName);
          if (binding) {
            const resolvedPortPath = resolveModulePath(
              binding.moduleSpecifier,
              sourceFile.fileName,
              repoRoot,
              workspaceRegistry
            );
            if (resolvedPortPath) {
              const sf = getCachedSourceFile(path.resolve(repoRoot, resolvedPortPath));
              if (sf) {
                const lookup =
                  binding.importedName && binding.importedName !== '*'
                    ? binding.importedName
                    : portName;
                const foundPort = findClassDeclInModuleOrReexports(
                  sf,
                  lookup,
                  repoRoot,
                  workspaceRegistry
                );
                if (foundPort) {
                  portClass = foundPort.cls;
                  portSf = foundPort.sf;
                  portRelPath = path.relative(repoRoot, portSf.fileName) || portSf.fileName;
                }
              }
            }
          }
        }
        if (portClass && portClass.name) {
          const portScope = resolveLogicalBoundaryScope(
            portRelPath,
            repoRoot,
            workspaceRegistry,
            findEnclosingNamespaceScope(portClass)
          );
          if (hc.token === ts.SyntaxKind.ExtendsKeyword) {
            const subClassId = stableEntityId(concreteScope, 'BOUNDARY', `Class: ${node.name.text}`);
            const superClassId = stableEntityId(portScope, 'BOUNDARY', `Class: ${portClass.name.text}`);
            decoratorEdges.push({
              id: nextId(),
              name: `Extends: ${portClass.name.text}`,
              type: 'RELATIONSHIP',
              entityType: 'EXTENDS',
              patternId: 'relationship.class-inheritance-extends',
              sourceId: subClassId,
              targetId: superClassId,
              status: 'DETERMINISTIC',
              confidence: 'HIGH',
              evidence: [{ ...getEvidence(node), evidenceRole: 'syntax-call' }],
            });
          }
          if (
            !isAbstractSubClass &&
            concreteMethods &&
            concreteMethods.size > 0 &&
            portClass.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)
          ) {
            const portMethods = getSourceFileDeclarationIndex(portSf).publicMethodsByClass.get(portClass.name.text);
            if (portMethods) {
              for (const mName of concreteMethods) {
                if (!portMethods.has(mName)) continue;
                const portMethodId = contractEntityId(
                  portScope,
                  portRelPath,
                  publicMethodName(portClass.name.text, mName),
                  'contract.public-method'
                );
                const concreteMethodId = contractEntityId(
                  concreteScope,
                  relPath,
                  publicMethodName(node.name.text, mName),
                  'contract.public-method'
                );
                decoratorEdges.push({
                  id: nextId(),
                  name: `Call: ${node.name.text}.${mName}()`,
                  type: 'RELATIONSHIP',
                  entityType: 'CALL',
                  patternId: 'relationship.function-call',
                  sourceId: portMethodId,
                  targetId: concreteMethodId,
                  status: 'DETERMINISTIC',
                  confidence: 'HIGH',
                  evidence: [{ ...getEvidence(node), evidenceRole: 'syntax-call' }],
                  metadata: { shapeKey: `${SHAPE_KEY_VERSION}/CALL/LocalClass/Prop(Id)` },
                });
              }
            }
          }
        }
      }
    }
  }

  if (decoratorEdges.length > 0) {
    return decoratorEdges.length === 1 ? decoratorEdges[0] : decoratorEdges;
  }
  return null;
}

/**
 * Extracts `REFERENCES` relationships when a Drizzle ORM client is initialized with a namespace
 * schema binding (`drizzle(client, { schema })` or `drizzle({ client, schema })` where `import * as schema from './schema'`),
 * linking the Drizzle client initialization scope to each `Drizzle Schema: <name>` contract in the schema module.
 */
export function extractDrizzleNamespaceSchemaEdges(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity[] {
  const callee = node.expression;
  const isDrizzleCall =
    (ts.isIdentifier(callee) && callee.text === 'drizzle') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'drizzle');
  if (!isDrizzleCall || node.arguments.length === 0) return [];

  let schemaIdent: ts.Identifier | null = null;
  for (const arg of node.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'schema') {
        schemaIdent = prop.name;
        break;
      }
      if (
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
        prop.name.text === 'schema' &&
        ts.isIdentifier(prop.initializer)
      ) {
        schemaIdent = prop.initializer;
        break;
      }
    }
    if (schemaIdent) break;
  }
  if (!schemaIdent) return [];

  const binding = findValueModuleBinding(sourceFile, schemaIdent.text);
  if (!binding) return [];
  const resolvedSchemaPath = resolveModulePath(
    binding.moduleSpecifier,
    sourceFile.fileName,
    repoRoot,
    workspaceRegistry
  );
  if (!resolvedSchemaPath) return [];

  const edges: StructuralEntity[] = [];
  const visitedPaths = new Set<string>();
  const seenTargets = new Set<string>();
  const callEvidence = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };

  const collectSchemasFromModule = (modRelPath: string, depth: number) => {
    if (depth > 3 || visitedPaths.has(modRelPath)) return;
    visitedPaths.add(modRelPath);
    const absPath = path.resolve(repoRoot, modRelPath);
    const sf = getCachedSourceFile(absPath);
    if (!sf) return;

    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          const schemaContract = extractDrizzleSchemaContract(
            decl,
            (n) => {
              const start = n.getStart(sf);
              const { line } = sf.getLineAndCharacterOfPosition(start);
              return {
                filePath: modRelPath,
                lineNumber: line + 1,
                snippet: n.getText(sf).slice(0, 80).replace(/\s+/g, ' ').trim(),
                evidenceRole: 'target-signature',
              };
            },
            () => ''
          );
          if (schemaContract) {
            const targetId = stableEntityId(schemaContract.name, 'CONTRACT', schemaContract.name);
            if (!seenTargets.has(targetId)) {
              seenTargets.add(targetId);
              const tableName = schemaContract.name.replace(/^Drizzle Schema:\s*/, '');
              const targetEv = Array.isArray(schemaContract.evidence)
                ? schemaContract.evidence[0]
                : schemaContract.evidence;
              edges.push({
                id: nextId(),
                name: `References Schema: ${tableName}`,
                type: 'RELATIONSHIP',
                entityType: 'REFERENCES',
                patternId: 'relationship.drizzle-client-namespace-schema-binding',
                sourceId,
                targetId,
                status: 'DETERMINISTIC',
                confidence: 'HIGH',
                evidence: targetEv ? [callEvidence, targetEv] : [callEvidence],
              });
            }
          }
        }
      }
      if (
        ts.isExportDeclaration(stmt) &&
        !stmt.isTypeOnly &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        const nextRel = resolveModulePath(
          stmt.moduleSpecifier.text,
          absPath,
          repoRoot,
          workspaceRegistry
        );
        if (nextRel) {
          collectSchemasFromModule(nextRel, depth + 1);
        }
      }
    }
  };

  collectSchemasFromModule(resolvedSchemaPath, 0);
  return edges;
}

const STANDARD_EXPRESS_RES_METHODS = new Set([
  'status',
  'send',
  'json',
  'jsonp',
  'end',
  'redirect',
  'render',
  'set',
  'header',
  'get',
  'cookie',
  'clearCookie',
  'type',
  'format',
  'attachment',
  'download',
  'links',
  'location',
  'sendFile',
  'sendStatus',
  'vary',
  'append',
  'write',
  'writeHead',
  'setHeader',
  'getHeader',
  'removeHeader',
  'on',
  'once',
  'emit',
  'pipe',
]);

/**
 * Resolves custom Express response methods (`res.ok()`, `res.badRequest()`) when `res` is augmented
 * via `Object.assign(res, responseTypes)` or `res.<method> = fn` in the same file or an imported
 * middleware/response module (`[PAT-EXT-47]`).
 */
export function extractExpressResAugmentedMethodCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== 'res') {
    return null;
  }
  const methodName = node.expression.name.text;
  if (STANDARD_EXPRESS_RES_METHODS.has(methodName)) return null;

  const findResAugmentationInSourceFile = (
    sf: ts.SourceFile,
    sfRelPath: string,
    depth: number
  ): { targetId: string; targetEvidence: EvidenceRecord } | null => {
    if (depth > 2) return null;
    const assignedObjectIdents: string[] = [];

    const walk = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === 'Object' &&
        n.expression.name.text === 'assign' &&
        n.arguments.length >= 2 &&
        ts.isIdentifier(n.arguments[0]) &&
        n.arguments[0].text === 'res'
      ) {
        for (let i = 1; i < n.arguments.length; i++) {
          const arg = n.arguments[i];
          if (ts.isIdentifier(arg)) {
            assignedObjectIdents.push(arg.text);
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);

    for (const objName of assignedObjectIdents) {
      const sameFileMember = resolveImportedObjectMember(
        sfRelPath,
        objName,
        methodName,
        repoRoot,
        workspaceRegistry ?? {}
      );
      if (sameFileMember) return sameFileMember;
      const sameFileFn = resolveTargetExport(
        sfRelPath,
        objName,
        repoRoot,
        workspaceRegistry ?? {},
        'Exported Function'
      );
      if (sameFileFn) return sameFileFn;

      const binding = findValueModuleBinding(sf, objName);
      if (binding && !isExternalSpecifier(binding.moduleSpecifier, sf.fileName, repoRoot, workspaceRegistry)) {
        const resolvedMod = resolveModulePath(
          binding.moduleSpecifier,
          sf.fileName,
          repoRoot,
          workspaceRegistry
        );
        if (resolvedMod) {
          const lookup =
            binding.importedName && binding.importedName !== '*' && binding.importedName !== 'default'
              ? binding.importedName
              : objName;
          const memberTarget =
            resolveImportedObjectMember(
              resolvedMod,
              lookup,
              methodName,
              repoRoot,
              workspaceRegistry ?? {}
            ) ??
            (binding.importedName === 'default'
              ? resolveImportedObjectMember(
                  resolvedMod,
                  'default',
                  methodName,
                  repoRoot,
                  workspaceRegistry ?? {}
                )
              : null) ??
            resolveTargetExport(
              resolvedMod,
              methodName,
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function'
            ) ??
            resolveTargetExport(
              resolvedMod,
              lookup,
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function'
            );
          if (memberTarget) return memberTarget;
        }
      }
    }

    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const spec = stmt.moduleSpecifier.text;
      if (isExternalSpecifier(spec, sf.fileName, repoRoot, workspaceRegistry)) continue;
      const modRel = resolveModulePath(spec, sf.fileName, repoRoot, workspaceRegistry);
      if (!modRel) continue;
      const modSf = getCachedSourceFile(path.resolve(repoRoot, modRel));
      if (!modSf) continue;
      const fromChild = findResAugmentationInSourceFile(modSf, modRel, depth + 1);
      if (fromChild) return fromChild;
    }

    return null;
  };

  const relPath = path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName;
  const resolved = findResAugmentationInSourceFile(sourceFile, relPath, 0);
  if (!resolved) return null;

  return {
    id: nextId(),
    name: `Call: res.${methodName}()`,
    type: 'RELATIONSHIP',
    entityType: 'CALL',
    patternId: 'relationship.express-res-augmented-method-call',
    sourceId,
    targetId: resolved.targetId,
    status: 'DETERMINISTIC',
    confidence: 'HIGH',
    evidence: [
      { ...getEvidence(node), evidenceRole: 'syntax-call' },
      resolved.targetEvidence,
    ],
  };
}

/**
 * Emits a `REFERENCES` relationship when a source file reads a property on a default-imported
 * config/object module (`import env from './env-runtime'; env.DATABASE_URL`) whose default export
 * is extracted as `Module Export (Default)` (`[PAT-EXT-48]`).
 */
export function extractDefaultImportedObjectPropertyRead(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | null {
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    if (!parent) return null;
    const isArg =
      ts.isCallExpression(parent) &&
      parent.expression !== node &&
      parent.arguments.includes(node as ts.Expression);
    const isObjPropVal =
      (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === node);
    if (!isArg && !isObjPropVal) return null;

    const identName = node.text;
    const binding = findValueModuleBinding(sourceFile, identName);
    if (
      !binding ||
      binding.kind !== 'import' ||
      !binding.importedName ||
      binding.importedName === '*' ||
      binding.importedName === 'default'
    ) {
      return null;
    }
    if (isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
      return null;
    }
    const resolvedMod = resolveModulePath(
      binding.moduleSpecifier,
      sourceFile.fileName,
      repoRoot,
      workspaceRegistry
    );
    if (!resolvedMod) return null;

    const resolvedExport = resolveTargetExport(
      resolvedMod,
      binding.importedName,
      repoRoot,
      workspaceRegistry ?? {},
      'Exported Function'
    );
    if (!resolvedExport) return null;

    const defRelPath = resolvedExport.targetEvidence.filePath;
    const defSf = getCachedSourceFile(path.resolve(repoRoot, defRelPath));
    if (!defSf) return null;
    const defFileRole = classifyNextjsFile(defRelPath);
    const lookupSym = resolvedExport.resolvedSymbol ?? binding.importedName;

    for (const stmt of defSf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      const extracted = visitContract(
        stmt,
        defSf,
        (n) => {
          const start = n.getStart(defSf);
          const { line } = defSf.getLineAndCharacterOfPosition(start);
          return {
            filePath: defRelPath,
            lineNumber: line + 1,
            snippet: n.getText(defSf).slice(0, 80).replace(/\s+/g, ' ').trim(),
            evidenceRole: 'target-signature',
          };
        },
        () => '',
        defFileRole,
        defRelPath
      );
      const extractedList = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
      const facContract = extractedList.find(
        (e) =>
          e.type === 'CONTRACT' &&
          (e.patternId === 'contract.factory-call-exported-const' ||
            e.patternId === 'contract.exported-factory-instance-and-enum-call') &&
          e.name === `Exported Function: ${lookupSym}`
      );
      if (!facContract) continue;
      const targetScope = resolveLogicalBoundaryScope(
        defRelPath,
        repoRoot,
        workspaceRegistry,
        findEnclosingNamespaceScope(stmt)
      );
      const targetId = contractEntityId(
        targetScope,
        defRelPath,
        facContract.name,
        facContract.patternId
      );
      if (targetId === sourceId) return null;
      const targetEv = Array.isArray(facContract.evidence)
        ? facContract.evidence[0]
        : facContract.evidence;
      return {
        id: nextId(),
        name: `References: ${identName}`,
        type: 'RELATIONSHIP',
        entityType: 'REFERENCES',
        patternId: 'relationship.default-imported-object-property-read',
        sourceId,
        targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: [
          { ...getEvidence(node), evidenceRole: 'syntax-call' },
          ...(targetEv ? [targetEv] : []),
        ],
      };
    }
    return null;
  }

  if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) {
    return null;
  }
  const parent = node.parent;
  if (parent) {
    if (ts.isCallExpression(parent) && parent.expression === node) return null;
    if (ts.isNewExpression(parent) && parent.expression === node) return null;
    if (
      ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)
    ) {
      return null;
    }
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node &&
      parent.parent &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      return null;
    }
  }

  const identName = node.expression.text;
  const binding = findValueModuleBinding(sourceFile, identName);
  if (!binding || binding.kind !== 'import' || !binding.importedName || binding.importedName === '*') {
    return null;
  }
  if (isExternalSpecifier(binding.moduleSpecifier, sourceFile.fileName, repoRoot, workspaceRegistry)) {
    return null;
  }
  const resolvedMod = resolveModulePath(
    binding.moduleSpecifier,
    sourceFile.fileName,
    repoRoot,
    workspaceRegistry
  );
  if (!resolvedMod) return null;

  const targetAbsPath = path.resolve(repoRoot, resolvedMod);
  const targetSf = getCachedSourceFile(targetAbsPath);
  if (!targetSf) return null;

  const targetFileRole = classifyNextjsFile(resolvedMod);

  // Named import of an exported object-literal data store (`import { data } from './_data'; data.demos`, `[PAT-EXT-51]`)
  if (binding.importedName !== 'default') {
    const lookupSym = binding.importedName;
    for (const stmt of targetSf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      const extracted = visitContract(
        stmt,
        targetSf,
        (n) => {
          const start = n.getStart(targetSf);
          const { line } = targetSf.getLineAndCharacterOfPosition(start);
          return {
            filePath: resolvedMod,
            lineNumber: line + 1,
            snippet: n.getText(targetSf).slice(0, 80).replace(/\s+/g, ' ').trim(),
            evidenceRole: 'target-signature',
          };
        },
        () => '',
        targetFileRole,
        resolvedMod
      );
      const extractedList = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
      const dataStoreContract = extractedList.find(
        (e) =>
          e.type === 'CONTRACT' &&
          (e.patternId === 'contract.exported-object-literal-data-store' ||
            e.patternId === 'contract.factory-call-exported-const' ||
            e.patternId === 'contract.exported-factory-instance-and-enum-call') &&
          (e.name === `Exported Module: ${lookupSym}` || e.name === `Exported Function: ${lookupSym}`)
      );
      if (!dataStoreContract) continue;

      const targetScope = resolveLogicalBoundaryScope(
        resolvedMod,
        repoRoot,
        workspaceRegistry,
        findEnclosingNamespaceScope(stmt)
      );
      const targetId = contractEntityId(
        targetScope,
        resolvedMod,
        dataStoreContract.name,
        dataStoreContract.patternId
      );
      const targetEv = Array.isArray(dataStoreContract.evidence)
        ? dataStoreContract.evidence[0]
        : dataStoreContract.evidence;
      return {
        id: nextId(),
        name: `References: ${identName}.${node.name.text}`,
        type: 'RELATIONSHIP',
        entityType: 'REFERENCES',
        patternId: 'relationship.default-imported-object-property-read',
        sourceId,
        targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: [
          { ...getEvidence(node), evidenceRole: 'syntax-call' },
          ...(targetEv ? [targetEv] : []),
        ],
      };
    }
    return null;
  }

  let defaultExportStmt: ts.ExportAssignment | null = null;
  for (const stmt of targetSf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      defaultExportStmt = stmt;
      break;
    }
  }
  if (!defaultExportStmt) return null;

  const extracted = visitContract(
    defaultExportStmt,
    targetSf,
    (n) => {
      const start = n.getStart(targetSf);
      const { line } = targetSf.getLineAndCharacterOfPosition(start);
      return {
        filePath: resolvedMod,
        lineNumber: line + 1,
        snippet: n.getText(targetSf).slice(0, 80).replace(/\s+/g, ' ').trim(),
        evidenceRole: 'target-signature',
      };
    },
    () => '',
    targetFileRole,
    resolvedMod
  );
  const extractedList = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
  const defaultModContract = extractedList.find(
    (e) =>
      e.type === 'CONTRACT' &&
      e.patternId === 'contract.es6-export-default' &&
      e.name === 'Module Export (Default)'
  );
  if (!defaultModContract) return null;

  if (findCallableObjectProperty(defaultExportStmt.expression, targetSf, node.name.text)) {
    return null;
  }

  const targetScope = resolveLogicalBoundaryScope(
    resolvedMod,
    repoRoot,
    workspaceRegistry,
    findEnclosingNamespaceScope(defaultExportStmt)
  );
  const targetId = contractEntityId(
    targetScope,
    resolvedMod,
    defaultModContract.name,
    defaultModContract.patternId
  );
  const targetEv = Array.isArray(defaultModContract.evidence)
    ? defaultModContract.evidence[0]
    : defaultModContract.evidence;

  return {
    id: nextId(),
    name: `References: ${identName}.${node.name.text}`,
    type: 'RELATIONSHIP',
    entityType: 'REFERENCES',
    patternId: 'relationship.default-imported-object-property-read',
    sourceId,
    targetId,
    status: 'DETERMINISTIC',
    confidence: 'HIGH',
    evidence: [
      { ...getEvidence(node), evidenceRole: 'syntax-call' },
      ...(targetEv ? [targetEv] : []),
    ],
  };
}

/**
 * Resolves Remix `<Form action="/api/...">` and `<fetcher.Form action="/api/...">` JSX submissions
 * to the matching Remix route module's `action` (or `loader` for GET) contract (`[PAT-EXT-49]`).
 */
export function extractRemixFormActionRouteLink(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | null {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const tagNameNode = opening.tagName;
  const isFormTag =
    (ts.isIdentifier(tagNameNode) &&
      (tagNameNode.text === 'Form' ||
        (tagNameNode.text === 'form' && isRemixRouteFile(sourceFile.fileName)))) ||
    (ts.isPropertyAccessExpression(tagNameNode) && tagNameNode.name.text === 'Form');
  if (!isFormTag) return null;

  let rawAction: string | null = null;
  let methodAttr = 'POST';
  for (const prop of opening.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || !ts.isIdentifier(prop.name) || !prop.initializer) continue;
    const attrName = prop.name.text;
    let strVal: string | null = null;
    if (ts.isStringLiteral(prop.initializer)) {
      strVal = prop.initializer.text;
    } else if (
      ts.isJsxExpression(prop.initializer) &&
      prop.initializer.expression &&
      (ts.isStringLiteral(prop.initializer.expression) ||
        ts.isNoSubstitutionTemplateLiteral(prop.initializer.expression))
    ) {
      strVal = prop.initializer.expression.text;
    }
    if (attrName === 'action' && strVal) {
      rawAction = strVal.trim();
    } else if (attrName === 'method' && strVal) {
      methodAttr = strVal.trim().toUpperCase();
    }
  }
  if (!rawAction || !rawAction.startsWith('/')) return null;

  const cleanRoute = rawAction.split('?')[0].replace(/^\/+|\/+$/g, '');
  const segments = cleanRoute ? cleanRoute.split('/').filter(Boolean) : [];

  const normSfPath = sourceFile.fileName.replace(/\\/g, '/');
  const appMatch = normSfPath.match(/^(.*\/app)\//);
  const candidateAppDirs = appMatch
    ? [appMatch[1], path.join(repoRoot, 'app')]
    : [path.join(repoRoot, 'app')];

  const routeBaseNames =
    segments.length === 0
      ? ['_index', 'index']
      : [
          segments.join('.'),
          `${segments.join('.')}._index`,
          segments.join('/'),
          `${segments.join('/')}/index`,
        ];
  const exts = ['.tsx', '.ts', '.jsx', '.js'];

  let matchedAbsPath: string | null = null;
  for (const appDir of candidateAppDirs) {
    for (const base of routeBaseNames) {
      for (const ext of exts) {
        const candidate = path.join(appDir, 'routes', `${base}${ext}`);
        if (fs.existsSync(candidate)) {
          matchedAbsPath = candidate;
          break;
        }
      }
      if (matchedAbsPath) break;
    }
    if (matchedAbsPath) break;
  }
  if (!matchedAbsPath) return null;

  const targetRelPath = (path.relative(repoRoot, matchedAbsPath) || matchedAbsPath).replace(/\\/g, '/');
  const preferredExports =
    methodAttr === 'GET'
      ? ['loader', 'clientLoader', 'action', 'clientAction']
      : ['action', 'clientAction', 'loader', 'clientLoader'];

  for (const expName of preferredExports) {
    const resolved = resolveTargetExport(
      targetRelPath,
      expName,
      repoRoot,
      workspaceRegistry ?? {},
      'Exported Function'
    );
    if (resolved) {
      return {
        id: nextId(),
        name: `Form Action: ${rawAction} -> ${expName}`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.remix-form-action-route-link',
        sourceId,
        targetId: resolved.targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: [
          { ...getEvidence(node), evidenceRole: 'syntax-call' },
          resolved.targetEvidence,
        ],
      };
    }
  }

  return null;
}

/**
 * Links an ES-exported router instance (`export const userRouter = Router()`) to the same-file
 * `HTTP_ENDPOINT` contracts registered on that router (`userRouter.get('/users', handler)`) (`[PAT-EXT-50]`).
 */
export function extractRouterInstanceToHttpEndpointEdge(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | null {
  if (!ts.isCallExpression(node)) return null;
  const rootIdent = getChainRootIdentifierNode(node.expression);
  if (!rootIdent) return null;

  const relPath = (path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName).replace(/\\/g, '/');
  const fileRole = classifyNextjsFile(relPath);
  const extracted = visitContract(
    node,
    sourceFile,
    getEvidence,
    () => '',
    fileRole,
    relPath
  );
  const contracts = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
  const routeContract = contracts.find(
    (c) => c.type === 'CONTRACT' && c.entityType === 'HTTP_ENDPOINT'
  );
  if (!routeContract) return null;

  let routerExportName: string | null = null;
  let routerDeclNode: ts.Node | null = null;
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== rootIdent.text || !decl.initializer) {
        continue;
      }
      if (!isRouterOrCliCommandFactoryInitializer(decl.initializer)) continue;
      const exportedNames = getExportedNamesForDeclaration(
        stmt,
        decl.name.text,
        sourceFile,
        true
      );
      if (exportedNames.length > 0) {
        routerExportName = exportedNames[0];
        routerDeclNode = decl;
        break;
      }
    }
    if (routerExportName) break;
  }

  // Case B: Chained route registration directly inside the router variable's initializer
  // (`const router = createRouter().openapi(routes.list, handlers.list)`).
  if (!routerExportName || !routerDeclNode) {
    for (let cur: ts.Node | undefined = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
      if (isFunctionLikeNode(cur)) break;
      if (
        ts.isVariableDeclaration(cur) &&
        ts.isIdentifier(cur.name) &&
        cur.initializer &&
        isRouterOrCliCommandFactoryInitializer(cur.initializer) &&
        cur.parent?.parent &&
        ts.isVariableStatement(cur.parent.parent)
      ) {
        const exportedNames = getExportedNamesForDeclaration(
          cur.parent.parent,
          cur.name.text,
          sourceFile,
          true
        );
        if (exportedNames.length > 0) {
          routerExportName = exportedNames[0];
          routerDeclNode = cur;
          break;
        }
      }
    }
  }

  // Case C: Route registration on a parameter or local router inside an exported OpenAPI route-configurator
  // function (`export default function configureOpenAPI(app) { app.doc('/doc', ...); }`).
  if (!routerExportName || !routerDeclNode) {
    for (let cur: ts.Node | undefined = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
      if (ts.isFunctionDeclaration(cur) && cur.name) {
        const fnText = cur.getText(sourceFile);
        if (fnText.includes('.doc(') || fnText.includes('.openapi(')) {
          const exportedNames = getExportedNamesForDeclaration(
            cur,
            cur.name.text,
            sourceFile,
            true
          );
          if (exportedNames.length > 0) {
            routerExportName = exportedNames[0];
            routerDeclNode = cur;
          }
        }
        break;
      }
      if (
        (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
        cur.parent &&
        ts.isVariableDeclaration(cur.parent) &&
        ts.isIdentifier(cur.parent.name) &&
        cur.parent.parent?.parent &&
        ts.isVariableStatement(cur.parent.parent.parent)
      ) {
        const fnText = cur.getText(sourceFile);
        if (fnText.includes('.doc(') || fnText.includes('.openapi(')) {
          const exportedNames = getExportedNamesForDeclaration(
            cur.parent.parent.parent,
            cur.parent.name.text,
            sourceFile,
            true
          );
          if (exportedNames.length > 0) {
            routerExportName = exportedNames[0];
            routerDeclNode = cur.parent;
          }
        }
        break;
      }
      if (isFunctionLikeNode(cur)) break;
    }
  }

  if (!routerExportName || !routerDeclNode) return null;

  const logicalScope = resolveLogicalBoundaryScope(
    relPath,
    repoRoot,
    workspaceRegistry,
    findEnclosingNamespaceScope(node)
  );
  const resolvedRouterContractName = resolveExtractedContractName(
    routerDeclNode,
    routerExportName,
    sourceFile,
    relPath,
    'Exported Function'
  );
  const routerPatternId = resolvedRouterContractName.startsWith('Exported Module: ')
    ? 'contract.exported-module'
    : resolvedRouterContractName === 'Module Export (Default)'
      ? 'contract.es6-export-default'
      : 'contract.exported-function';
  const routerContractId = contractEntityId(
    logicalScope,
    relPath,
    resolvedRouterContractName,
    routerPatternId
  );
  const endpointContractId = contractEntityId(
    logicalScope,
    relPath,
    routeContract.name,
    routeContract.patternId
  );

  return {
    id: nextId(),
    name: `Binds Route: ${routerExportName} -> ${routeContract.name}`,
    type: 'RELATIONSHIP',
    entityType: 'BINDS_ROUTE',
    patternId: 'relationship.router-instance-to-http-endpoint',
    sourceId: routerContractId,
    targetId: endpointContractId,
    status: 'DETERMINISTIC',
    confidence: 'HIGH',
    evidence: [
      { ...getEvidence(node), evidenceRole: 'syntax-call' },
      { ...getEvidence(routerDeclNode), evidenceRole: 'target-signature' },
    ],
  };
}

/**
 * Resolves Angular Schematics `new RunSchematicTask('schematic-name', options)` or
 * `new RunSchematicTask('collection-name', 'schematic-name', options)` instantiations
 * by looking up the schematic's `factory` entry in `collection.json` (`[PAT-EXT-53]`).
 */
export function extractAngularSchematicTaskRelationship(
  node: ts.NewExpression,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | null {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'RunSchematicTask') {
    return null;
  }
  const args = node.arguments ?? [];
  if (args.length === 0) return null;

  let schematicName: string | null = null;
  if (args.length >= 2 && (ts.isStringLiteral(args[0]) || ts.isNoSubstitutionTemplateLiteral(args[0]))) {
    if (
      args.length >= 3 &&
      (ts.isStringLiteral(args[1]) || ts.isNoSubstitutionTemplateLiteral(args[1]))
    ) {
      schematicName = args[1].text.trim();
    } else {
      schematicName = args[0].text.trim();
    }
  } else if (ts.isStringLiteral(args[0]) || ts.isNoSubstitutionTemplateLiteral(args[0])) {
    schematicName = args[0].text.trim();
  }
  if (!schematicName) return null;

  const candidateCollectionPaths: string[] = [];
  let curDir = path.dirname(path.resolve(sourceFile.fileName));
  const absRepoRoot = path.resolve(repoRoot);
  for (let depth = 0; depth < 6; depth++) {
    const cand = path.join(curDir, 'collection.json');
    if (!candidateCollectionPaths.includes(cand)) {
      candidateCollectionPaths.push(cand);
    }
    if (curDir === absRepoRoot || path.dirname(curDir) === curDir) break;
    curDir = path.dirname(curDir);
  }
  const rootSchematicsCollection = path.join(absRepoRoot, 'schematics', 'collection.json');
  if (!candidateCollectionPaths.includes(rootSchematicsCollection)) {
    candidateCollectionPaths.push(rootSchematicsCollection);
  }

  for (const collectionPath of candidateCollectionPaths) {
    if (!fs.existsSync(collectionPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
      const entry = parsed?.schematics?.[schematicName];
      const factorySpec: string | undefined =
        typeof entry?.factory === 'string' ? entry.factory.trim() : undefined;
      if (!factorySpec) continue;

      const [rawFactoryModule, rawFactorySymbol] = factorySpec.split('#');
      if (!rawFactoryModule) continue;
      const factorySymbol = rawFactorySymbol?.trim() || 'default';
      const resolvedFactoryMod = resolveModulePath(
        rawFactoryModule.trim(),
        collectionPath,
        repoRoot,
        workspaceRegistry
      );
      if (!resolvedFactoryMod) continue;

      const resolvedTarget =
        resolveTargetExport(
          resolvedFactoryMod,
          factorySymbol,
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function'
        ) ??
        (factorySymbol !== 'default'
          ? resolveTargetExport(
              resolvedFactoryMod,
              'default',
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function'
            )
          : null);
      if (!resolvedTarget) continue;

      return {
        id: nextId(),
        name: `Call: new RunSchematicTask(${schematicName})`,
        type: 'RELATIONSHIP',
        entityType: 'CALL',
        patternId: 'relationship.angular-schematics-run-schematic-task',
        sourceId,
        targetId: resolvedTarget.targetId,
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
        evidence: [
          { ...getEvidence(node), evidenceRole: 'syntax-call' },
          resolvedTarget.targetEvidence,
        ],
      };
    } catch {
      // Ignore malformed collection.json
    }
  }

  return null;
}

/**
 * Resolves framework-specific bare function calls (`[PAT-EXT-67]`):
 * 1. React Router v7 `routes.ts` route helper calls (`index('./routes/home.tsx')`, `route('users', './routes/users.tsx')`, `layout('./routes/layout.tsx', [...])`)
 *    linking the route configuration to each exported route contract (`default`, `loader`, `action`, `clientLoader`, `clientAction`) in the target route module.
 * 2. Nuxt / Vue auto-imported composable, store, and utility calls (`useAuthStore()`, `useCustomComposable()`)
 *    resolving to sibling or ancestor `stores/`, `composables/`, and `utils/` directories.
 */
export function extractFrameworkBareCallRelationship(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | StructuralEntity[] | null {
  if (!ts.isIdentifier(node.expression)) return null;
  const calleeName = node.expression.text;
  const relPath = (path.relative(repoRoot, sourceFile.fileName) || sourceFile.fileName).replace(/\\/g, '/');

  // 1. React Router v7 `routes.ts` route config links (`index('./routes/...')`, `route('/path', './routes/...')`, `layout('./routes/...', [...])`)
  if (
    /(?:^|\/)routes\.[tj]sx?$/i.test(relPath) &&
    (calleeName === 'index' || calleeName === 'route' || calleeName === 'layout') &&
    node.arguments.length >= 1
  ) {
    const fileArg =
      calleeName === 'route' && node.arguments.length >= 2
        ? node.arguments[1]
        : node.arguments[0];
    if (fileArg && (ts.isStringLiteral(fileArg) || ts.isNoSubstitutionTemplateLiteral(fileArg))) {
      const rawSpec = fileArg.text.trim();
      const specCandidates = rawSpec.startsWith('.') ? [rawSpec] : [`./${rawSpec}`, rawSpec];
      let targetRelPath: string | null = null;
      for (const spec of specCandidates) {
        targetRelPath = resolveModulePath(spec, sourceFile.fileName, repoRoot, workspaceRegistry);
        if (targetRelPath) break;
      }
      if (targetRelPath) {
        const routeExports = ['default', 'loader', 'action', 'clientLoader', 'clientAction'];
        const edges: StructuralEntity[] = [];
        const seenTargets = new Set<string>();
        const callEv = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
        for (const expName of routeExports) {
          const resolved = resolveTargetExport(
            targetRelPath,
            expName,
            repoRoot,
            workspaceRegistry ?? {},
            'Exported Function'
          );
          if (resolved && !seenTargets.has(resolved.targetId)) {
            seenTargets.add(resolved.targetId);
            edges.push({
              id: nextId(),
              name: `Route Config: ${calleeName}(${rawSpec}) -> ${expName}`,
              type: 'RELATIONSHIP',
              entityType: 'CALL',
              patternId: 'relationship.react-router-routes-config-links',
              sourceId,
              targetId: resolved.targetId,
              status: 'DETERMINISTIC',
              confidence: 'HIGH',
              evidence: [callEv, resolved.targetEvidence],
            });
          }
        }
        if (edges.length > 0) {
          return edges.length === 1 ? edges[0] : edges;
        }
      }
    }
  }

  // 2. Nuxt / Vue auto-imported composable, store, and utility calls (`useAuthStore()`, `useCustomComposable()`)
  const isLocallyBoundCallee = (() => {
    if (findValueModuleBinding(sourceFile, calleeName)) return true;
    const bindsName = (pat: ts.BindingName): boolean => {
      if (ts.isIdentifier(pat)) return pat.text === calleeName;
      for (const el of pat.elements) {
        if (ts.isBindingElement(el) && bindsName(el.name)) return true;
      }
      return false;
    };
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (
        ts.isFunctionDeclaration(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isArrowFunction(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isConstructorDeclaration(cur)
      ) {
        if (cur.name && ts.isIdentifier(cur.name) && cur.name.text === calleeName) return true;
        if (cur.parameters.some((p) => bindsName(p.name))) return true;
      }
      if (ts.isCatchClause(cur) && cur.variableDeclaration && bindsName(cur.variableDeclaration.name)) {
        return true;
      }
      if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur)) {
        for (const stmt of cur.statements) {
          if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === calleeName) {
            return true;
          }
          if (ts.isVariableStatement(stmt)) {
            if (stmt.declarationList.declarations.some((d) => bindsName(d.name))) return true;
          }
        }
      }
    }
    return false;
  })();

  if (
    !isLocallyBoundCallee &&
    (/^use[A-Z]\w*$/.test(calleeName) ||
      sourceFile.fileName.endsWith('.vue') ||
      /(?:^|\/)(?:pages|components|composables|stores|plugins|middleware|layouts)\//i.test(relPath))
  ) {
    const absRepoRoot = path.resolve(repoRoot);
    const searchRoots: string[] = [];
    let curDir = path.dirname(path.resolve(sourceFile.fileName));
    for (let depth = 0; depth < 6; depth++) {
      if (!searchRoots.includes(curDir)) searchRoots.push(curDir);
      const appSub = path.join(curDir, 'app');
      if (fs.existsSync(appSub) && !searchRoots.includes(appSub)) searchRoots.push(appSub);
      const srcSub = path.join(curDir, 'src');
      if (fs.existsSync(srcSub) && !searchRoots.includes(srcSub)) searchRoots.push(srcSub);
      if (curDir === absRepoRoot || path.dirname(curDir) === curDir) break;
      curDir = path.dirname(curDir);
    }

    const strippedStore = calleeName.replace(/^use/, '').replace(/Store$/, '');
    const camelStem = strippedStore
      ? strippedStore.charAt(0).toLowerCase() + strippedStore.slice(1)
      : '';
    const kebabStem = camelStem
      ? camelStem.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
      : '';
    const baseStems = Array.from(
      new Set(
        [
          calleeName,
          calleeName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(),
          camelStem,
          kebabStem,
          'index',
        ].filter(Boolean)
      )
    );
    const autoImportFolders = ['stores', 'composables', 'utils'];
    const exts = ['.ts', '.js', '.mjs', '.tsx', '.jsx'];
    const callEv = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };
    const nuxtConfigPresets: Array<{ fromSpec: string; importedSym: string; configFile: string }> = [];

    for (const rootDir of searchRoots) {
      for (const cfgName of ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']) {
        const cfgAbs = path.join(rootDir, cfgName);
        if (!fs.existsSync(cfgAbs)) continue;
        const cfgSf = getCachedSourceFile(cfgAbs);
        if (!cfgSf) continue;
        const walkCfg = (n: ts.Node): void => {
          if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
            if (n.name.text === 'dirs' && ts.isArrayLiteralExpression(n.initializer)) {
              for (const el of n.initializer.elements) {
                if (ts.isStringLiteral(el) && el.text && !autoImportFolders.includes(el.text)) {
                  autoImportFolders.push(el.text);
                }
              }
            } else if (n.name.text === 'presets' && ts.isArrayLiteralExpression(n.initializer)) {
              for (const preset of n.initializer.elements) {
                if (!ts.isObjectLiteralExpression(preset)) continue;
                let fromSpec: string | null = null;
                let importsArr: ts.ArrayLiteralExpression | null = null;
                for (const p of preset.properties) {
                  if (!ts.isPropertyAssignment(p) || (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name))) {
                    continue;
                  }
                  if (p.name.text === 'from' && ts.isStringLiteral(p.initializer)) {
                    fromSpec = p.initializer.text;
                  } else if (p.name.text === 'imports' && ts.isArrayLiteralExpression(p.initializer)) {
                    importsArr = p.initializer;
                  }
                }
                if (fromSpec && importsArr) {
                  for (const impEl of importsArr.elements) {
                    if (ts.isStringLiteral(impEl) && impEl.text === calleeName) {
                      nuxtConfigPresets.push({ fromSpec, importedSym: impEl.text, configFile: cfgAbs });
                    } else if (
                      ts.isArrayLiteralExpression(impEl) &&
                      impEl.elements.length >= 2 &&
                      ts.isStringLiteral(impEl.elements[0]) &&
                      ts.isStringLiteral(impEl.elements[1]) &&
                      impEl.elements[1].text === calleeName
                    ) {
                      nuxtConfigPresets.push({
                        fromSpec,
                        importedSym: impEl.elements[0].text,
                        configFile: cfgAbs,
                      });
                    } else if (ts.isObjectLiteralExpression(impEl)) {
                      let origSym: string | null = null;
                      let aliasSym: string | null = null;
                      for (const ip of impEl.properties) {
                        if (
                          ts.isPropertyAssignment(ip) &&
                          (ts.isIdentifier(ip.name) || ts.isStringLiteral(ip.name)) &&
                          ts.isStringLiteral(ip.initializer)
                        ) {
                          if (ip.name.text === 'name') origSym = ip.initializer.text;
                          if (ip.name.text === 'as') aliasSym = ip.initializer.text;
                        }
                      }
                      if (origSym && (aliasSym ?? origSym) === calleeName) {
                        nuxtConfigPresets.push({ fromSpec, importedSym: origSym, configFile: cfgAbs });
                      }
                    }
                  }
                }
              }
            }
          }
          ts.forEachChild(n, walkCfg);
        };
        walkCfg(cfgSf);
      }
    }

    for (const rootDir of searchRoots) {
      for (const folder of autoImportFolders) {
        const folderAbs = path.join(rootDir, folder);
        if (!fs.existsSync(folderAbs)) continue;
        const candidateFiles: string[] = [];
        for (const stem of baseStems) {
          for (const ext of exts) {
            const f = path.join(folderAbs, `${stem}${ext}`);
            if (fs.existsSync(f) && !candidateFiles.includes(f)) {
              candidateFiles.push(f);
            }
          }
        }
        try {
          for (const entry of fs.readdirSync(folderAbs, { withFileTypes: true })) {
            if (entry.isFile() && /\.[cm]?[tj]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
              const f = path.join(folderAbs, entry.name);
              if (!candidateFiles.includes(f)) candidateFiles.push(f);
            }
          }
        } catch {
          // Ignore readdir errors
        }
        for (const candAbs of candidateFiles) {
          if (path.resolve(candAbs) === path.resolve(sourceFile.fileName)) continue;
          const candRel = (path.relative(repoRoot, candAbs) || candAbs).replace(/\\/g, '/');
          const stemOfFile = path.basename(candAbs, path.extname(candAbs));
          const resolved =
            resolveTargetExport(
              candRel,
              calleeName,
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function',
              0,
              new Set(),
              true
            ) ??
            resolveTargetExport(
              candRel,
              calleeName,
              repoRoot,
              workspaceRegistry ?? {},
              'Exported Function',
              0,
              new Set(),
              false
            ) ??
            (stemOfFile !== 'index' &&
            (stemOfFile === calleeName ||
              stemOfFile === calleeName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() ||
              stemOfFile === camelStem ||
              stemOfFile === kebabStem)
              ? resolveTargetExport(
                  candRel,
                  'default',
                  repoRoot,
                  workspaceRegistry ?? {},
                  'Exported Function',
                  0,
                  new Set(),
                  false
                )
              : null);
          if (resolved) {
            return {
              id: nextId(),
              name: `Call: ${calleeName}()`,
              type: 'RELATIONSHIP',
              entityType: 'CALL',
              patternId: 'relationship.nuxt-auto-imports-resolution',
              sourceId,
              targetId: resolved.targetId,
              status: 'DETERMINISTIC',
              confidence: 'HIGH',
              evidence: [callEv, resolved.targetEvidence],
            };
          }
        }
      }
    }

    for (const preset of nuxtConfigPresets) {
      const resolvedPresetMod = resolveModulePath(
        preset.fromSpec,
        preset.configFile,
        repoRoot,
        workspaceRegistry
      );
      if (!resolvedPresetMod) continue;
      const resolved =
        resolveTargetExport(
          resolvedPresetMod,
          preset.importedSym,
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function',
          0,
          new Set(),
          true
        ) ??
        resolveTargetExport(
          resolvedPresetMod,
          preset.importedSym,
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function',
          0,
          new Set(),
          false
        );
      if (resolved) {
        return {
          id: nextId(),
          name: `Call: ${calleeName}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.nuxt-auto-imports-resolution',
          sourceId,
          targetId: resolved.targetId,
          status: 'DETERMINISTIC',
          confidence: 'HIGH',
          evidence: [callEv, resolved.targetEvidence],
        };
      }
    }
  }

  return null;
}

/**
 * Resolves React Router / Remix `AppLoadContext` dependency injection calls
 * (`context.repositories.user.getAllUsers(...)`, `args.context.repositories.post.create(...)`)
 * to the target repository or service public method or exported function (`[PAT-EXT-67]`).
 */
export function extractReactRouterLoadContextCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const methodName = node.expression.name.text;
  const segments: string[] = [];
  let cur: ts.Expression = node.expression.expression;
  while (ts.isPropertyAccessExpression(cur)) {
    segments.unshift(cur.name.text);
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur)) return null;
  segments.unshift(cur.text);

  const ctxIdx = segments.indexOf('context');
  if (ctxIdx === -1 || ctxIdx + 2 >= segments.length) return null;
  const groupName = segments[ctxIdx + 1];
  const serviceKey = segments[ctxIdx + 2];
  if (groupName !== 'repositories' && groupName !== 'services') return null;

  const pascalKey = serviceKey.charAt(0).toUpperCase() + serviceKey.slice(1);
  const singularGroup = groupName === 'repositories' ? 'Repository' : 'Service';
  const candidateClassNames = [`${pascalKey}${singularGroup}`, pascalKey];
  const candidateFactoryNames = [
    `create${pascalKey}${singularGroup}`,
    `make${pascalKey}${singularGroup}`,
    `get${pascalKey}${singularGroup}`,
  ];
  const kebabKey = serviceKey.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

  const absRepoRoot = path.resolve(repoRoot);
  const searchDirs: string[] = [];
  const addSearchRoot = (baseDir: string) => {
    for (const sub of [
      baseDir,
      path.join(baseDir, groupName),
      path.join(baseDir, 'server'),
      path.join(baseDir, 'server', groupName),
      path.join(baseDir, 'app'),
      path.join(baseDir, 'app', groupName),
      path.join(baseDir, 'src'),
      path.join(baseDir, 'src', groupName),
    ]) {
      if (fs.existsSync(sub) && !searchDirs.includes(sub)) {
        searchDirs.push(sub);
      }
    }
  };
  let curDir = path.dirname(path.resolve(sourceFile.fileName));
  for (let depth = 0; depth < 5; depth++) {
    addSearchRoot(curDir);
    if (curDir === absRepoRoot || path.dirname(curDir) === curDir) break;
    curDir = path.dirname(curDir);
  }
  for (const pkgPath of Object.values(workspaceRegistry ?? {})) {
    addSearchRoot(path.resolve(repoRoot, pkgPath));
  }

  const candidateFiles: string[] = [];
  for (const dir of searchDirs) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && /\.[cm]?[tj]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          const full = path.join(dir, entry.name);
          if (!candidateFiles.includes(full)) candidateFiles.push(full);
        } else if (
          entry.isDirectory() &&
          (entry.name.toLowerCase().includes(serviceKey.toLowerCase()) ||
            entry.name.toLowerCase().includes(kebabKey) ||
            entry.name === groupName ||
            entry.name === 'repositories' ||
            entry.name === 'services' ||
            path.basename(dir) === groupName ||
            path.basename(dir) === 'repositories' ||
            path.basename(dir) === 'services')
        ) {
          const subDir = path.join(dir, entry.name);
          for (const subEntry of fs.readdirSync(subDir, { withFileTypes: true })) {
            if (subEntry.isFile() && /\.[cm]?[tj]sx?$/.test(subEntry.name) && !subEntry.name.endsWith('.d.ts')) {
              const full = path.join(subDir, subEntry.name);
              if (!candidateFiles.includes(full)) candidateFiles.push(full);
            }
          }
        }
      }
    } catch {
      // Ignore fs errors
    }
  }

  const callEv = { ...getEvidence(node), evidenceRole: 'syntax-call' as const };

  for (const fileAbs of candidateFiles) {
    const sf = getCachedSourceFile(fileAbs);
    if (!sf) continue;
    const relMod = (path.relative(repoRoot, fileAbs) || fileAbs).replace(/\\/g, '/');
    const sfIdx = getSourceFileDeclarationIndex(sf);

    const matchingClassDecls = Array.from(sfIdx.classDeclsByName.keys()).filter(
      (k) => candidateClassNames.includes(k) || k.endsWith(`${pascalKey}${singularGroup}`)
    );
    for (const clsName of matchingClassDecls) {
      const resolvedMethod = resolveClassMethodTargetWithEvidence(
        ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(clsName), methodName),
          undefined,
          []
        ),
        sf,
        repoRoot,
        workspaceRegistry
      );
      if (resolvedMethod) {
        return {
          id: nextId(),
          name: `Call: context.${groupName}.${serviceKey}.${methodName}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.react-router-load-context-di',
          sourceId,
          targetId: resolvedMethod.targetId,
          status: 'DETERMINISTIC',
          confidence: 'HIGH',
          evidence: [callEv, resolvedMethod.targetEvidence],
        };
      }
    }

    for (const facName of candidateFactoryNames) {
      const resolvedFac =
        resolveImportedObjectMember(relMod, facName, methodName, repoRoot, workspaceRegistry ?? {}) ??
        resolveTargetExport(
          relMod,
          facName,
          repoRoot,
          workspaceRegistry ?? {},
          'Exported Function',
          0,
          new Set(),
          true
        );
      if (resolvedFac) {
        return {
          id: nextId(),
          name: `Call: context.${groupName}.${serviceKey}.${methodName}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.react-router-load-context-di',
          sourceId,
          targetId: resolvedFac.targetId,
          status: 'DETERMINISTIC',
          confidence: 'HIGH',
          evidence: [callEv, resolvedFac.targetEvidence],
        };
      }
    }

    const baseNameLower = path.basename(fileAbs, path.extname(fileAbs)).toLowerCase();
    if (
      baseNameLower === serviceKey.toLowerCase() ||
      baseNameLower === kebabKey ||
      baseNameLower.startsWith(`${kebabKey}.`) ||
      baseNameLower.startsWith(`${serviceKey.toLowerCase()}-`)
    ) {
      const directExport = resolveTargetExport(
        relMod,
        methodName,
        repoRoot,
        workspaceRegistry ?? {},
        'Exported Function'
      );
      if (directExport) {
        return {
          id: nextId(),
          name: `Call: context.${groupName}.${serviceKey}.${methodName}()`,
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.react-router-load-context-di',
          sourceId,
          targetId: directExport.targetId,
          status: 'DETERMINISTIC',
          confidence: 'HIGH',
          evidence: [callEv, directExport.targetEvidence],
        };
      }
    }
  }

  return null;
}

/**
 * Emits a `CALL` relationship (`relationship.getter-property-access-invocation`) when a property read
 * (`driver.isUsingTsNode`, `this.config`) accesses a public `get <prop>()` `GetAccessorDeclaration`
 * extracted as a `PUBLIC_METHOD` contract (`[PAT-EXT-67]`).
 */
export function extractGetterPropertyAccessInvocation(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string,
  repoRoot: string,
  sourceId: string,
  workspaceRegistry?: WorkspaceRegistry
): StructuralEntity | null {
  if (!ts.isPropertyAccessExpression(node)) return null;
  const parent = node.parent;
  if (parent) {
    if (ts.isCallExpression(parent) && parent.expression === node) return null;
    if (ts.isNewExpression(parent) && parent.expression === node) return null;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === node
    ) {
      return null;
    }
    if (
      ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)
    ) {
      return null;
    }
  }

  const targetId = resolveGetterAccessorTarget(node, sourceFile, repoRoot, workspaceRegistry);
  if (!targetId || targetId === sourceId) return null;

  return {
    id: nextId(),
    name: `Getter: ${node.name.text}`,
    type: 'RELATIONSHIP',
    entityType: 'CALL',
    patternId: 'relationship.getter-property-access-invocation',
    sourceId,
    targetId,
    status: 'DETERMINISTIC',
    confidence: 'HIGH',
    evidence: [{ ...getEvidence(node), evidenceRole: 'syntax-call' }],
  };
}



