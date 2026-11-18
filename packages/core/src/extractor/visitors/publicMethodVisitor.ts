// packages/core/src/extractor/visitors/publicMethodVisitor.ts
// Visitor for PUBLIC_METHOD CONTRACTs — the externally callable surface of a CLASS boundary.
//
// Ontology v4.0: a method is a Contract attached directly to its parent CLASS, regardless of the
// file the class is written in.

import ts from 'typescript';
import { ContractPortValves, EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { extractCallablePortValves } from './portValveVisitor.js';

/**
 * Builds the canonical name of a public method contract.
 *
 * @param className  Name of the owning class.
 * @param methodName Name of the method.
 * @returns e.g. `Public Method: UserService.getUser`.
 */
export function publicMethodName(className: string, methodName: string): string {
  return `Public Method: ${className}.${methodName}`;
}

/**
 * Extracts Layer 1 Port Valve schema references (`inputTypes`, `outputType`, and Speed 1
 * structured `portValves`) from a function or method signature (`[PAT-VIS-14]`, `[PAT-EXT-22]`).
 *
 * @param node Callable AST signature declaration.
 * @returns Port metadata fields or `undefined` when no port information is present.
 */
export function extractSignatureTypeValves(
  node: ts.SignatureDeclarationBase
): {
  inputTypes?: string[];
  outputType?: string;
  portValves?: ContractPortValves;
} | undefined {
  return extractCallablePortValves(node);
}

/**
 * Extracts a PUBLIC_METHOD contract from a class method declaration.
 *
 * Included: named methods (identifier or string-literal names), static and abstract methods.
 * Excluded: constructors, `private` / `protected` members, `#private` members and computed names
 * (their identity cannot be proven statically — an unknown is a valid state).
 *
 * @example
 * export class UserService {
 *   async getUser(id: string) {}      // → Public Method: UserService.getUser
 *   private helper() {}                // → (excluded)
 * }
 *
 * @param node        The AST node to inspect.
 * @param getEvidence Returns a populated EvidenceRecord for the given node.
 * @param nextId      Placeholder ID closure — replaced by stableEntityId() in the orchestrator.
 * @returns A CONTRACT StructuralEntity, or null if the node is not an included class method.
 */
function unwrapPropertyFunctionInitializer(
  node: ts.PropertyDeclaration
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!node.initializer) return null;
  let cur: ts.Expression = node.initializer;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
    return cur;
  }
  return null;
}

const ROUTE_OR_EVENT_INGRESS_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Delete',
  'Patch',
  'Options',
  'Head',
  'All',
  'Sse',
  'MessagePattern',
  'EventPattern',
  'EventName',
  'SubscribeMessage',
  'OnEvent',
  'On',
  'Once',
  'Process',
  'OnQueueActive',
  'OnQueueCompleted',
  'OnQueueFailed',
  'Cron',
  'Interval',
  'Timeout',
]);

const EVENT_HANDLER_DECORATORS = new Set([
  'OnEvent',
  'On',
  'Once',
  'EventPattern',
  'MessagePattern',
  'EventName',
  'SubscribeMessage',
]);

export function extractDecoratorIngressMeta(
  memberNode: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.PropertyDeclaration
): { flowRole: 'INGRESS'; decoratorName: string; eventKey?: string } | undefined {
  if (!ts.canHaveDecorators(memberNode)) return undefined;
  const decorators = ts.getDecorators(memberNode);
  if (!decorators || decorators.length === 0) return undefined;

  for (const dec of decorators) {
    let decName: string | null = null;
    let firstArg: ts.Expression | undefined;
    if (ts.isIdentifier(dec.expression)) {
      decName = dec.expression.text;
    } else if (ts.isCallExpression(dec.expression)) {
      firstArg = dec.expression.arguments[0];
      if (ts.isIdentifier(dec.expression.expression)) {
        decName = dec.expression.expression.text;
      } else if (ts.isPropertyAccessExpression(dec.expression.expression)) {
        decName = dec.expression.expression.name.text;
      }
    }
    if (decName && ROUTE_OR_EVENT_INGRESS_DECORATORS.has(decName)) {
      let eventKey: string | undefined;
      if (EVENT_HANDLER_DECORATORS.has(decName) && firstArg) {
        if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
          eventKey = firstArg.text;
        } else if (ts.isIdentifier(firstArg)) {
          eventKey = firstArg.text;
        } else if (ts.isPropertyAccessExpression(firstArg) && ts.isIdentifier(firstArg.expression)) {
          eventKey = `${firstArg.expression.text}.${firstArg.name.text}`;
        }
      }
      return {
        flowRole: 'INGRESS',
        decoratorName: decName,
        ...(eventKey ? { eventKey } : {}),
      };
    }
  }
  return undefined;
}

function unwrapPropertyObjectInitializer(
  node: ts.PropertyDeclaration
): ts.ObjectLiteralExpression | null {
  if (!node.initializer) return null;
  let cur: ts.Expression = node.initializer;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return ts.isObjectLiteralExpression(cur) ? cur : null;
}

export function extractPublicMethod(
  node: ts.Node,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | StructuralEntity[] | null {
  const isMethod = ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node);
  const propFn = !isMethod && ts.isPropertyDeclaration(node) ? unwrapPropertyFunctionInitializer(node) : null;
  const propObj =
    !isMethod && !propFn && ts.isPropertyDeclaration(node)
      ? unwrapPropertyObjectInitializer(node)
      : null;
  if (!isMethod && !propFn && !propObj) return null;

  const memberNode = node as ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.PropertyDeclaration;
  const owner = memberNode.parent;
  if (!owner || !ts.isClassDeclaration(owner) || !owner.name) return null;
  const isDecoratedOwner =
    ts.canHaveDecorators(owner) && (ts.getDecorators(owner)?.length ?? 0) > 0;
  if (!ts.isSourceFile(owner.parent) && !ts.isModuleBlock(owner.parent) && !isDecoratedOwner) {
    return null;
  }

  if (!(ts.isIdentifier(memberNode.name) || ts.isStringLiteral(memberNode.name))) return null;

  const isHidden = memberNode.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
  );
  if (isHidden) return null;

  if (propObj) {
    const className = owner.name.text;
    const results: StructuralEntity[] = [];
    const collectNestedMethods = (obj: ts.ObjectLiteralExpression, prefix: string, depth: number) => {
      if (depth > 3) return;
      for (const prop of obj.properties) {
        let subName: string | null = null;
        let sigNode: ts.SignatureDeclarationBase | null = null;
        if (
          ts.isMethodDeclaration(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ) {
          subName = prop.name.text;
          sigNode = prop;
        } else if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ) {
          let init: ts.Expression = prop.initializer;
          while (
            ts.isParenthesizedExpression(init) ||
            ts.isAsExpression(init) ||
            ts.isTypeAssertionExpression(init) ||
            ts.isSatisfiesExpression(init) ||
            ts.isNonNullExpression(init)
          ) {
            init = init.expression;
          }
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            subName = prop.name.text;
            sigNode = init;
          } else if (ts.isObjectLiteralExpression(init)) {
            collectNestedMethods(init, `${prefix}.${prop.name.text}`, depth + 1);
            continue;
          }
        }
        if (subName && sigNode) {
          const valves = extractSignatureTypeValves(sigNode);
          results.push({
            id: nextId(),
            name: publicMethodName(className, `${prefix}.${subName}`),
            type: 'CONTRACT',
            entityType: 'PUBLIC_METHOD',
            patternId: 'contract.public-method',
            evidence: getEvidence(prop),
            ...(valves ? { metadata: valves } : {}),
          });
        }
      }
    };
    collectNestedMethods(propObj, memberNode.name.text, 1);
    if (results.length === 0) return null;
    return results.length === 1 ? results[0] : results;
  }

  const signatureNode = isMethod
    ? (node as ts.MethodDeclaration | ts.GetAccessorDeclaration)
    : propFn!;
  const valves = extractSignatureTypeValves(signatureNode);
  const decoratorMeta = extractDecoratorIngressMeta(memberNode);
  const combinedMeta =
    valves || decoratorMeta
      ? { ...(valves ?? {}), ...(decoratorMeta ?? {}) }
      : undefined;

  return {
    id: nextId(),
    name: publicMethodName(owner.name.text, memberNode.name.text),
    type: 'CONTRACT',
    entityType: 'PUBLIC_METHOD',
    patternId: 'contract.public-method',
    evidence: getEvidence(node),
    ...(combinedMeta ? { metadata: combinedMeta } : {}),
  };
}
