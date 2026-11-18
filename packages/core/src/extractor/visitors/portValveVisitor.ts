/**
 * @fileoverview Speed 1 syntactic Port Valve AST extractor (`[PAT-VIS-14]`, `[PAT-EXT-22]`, `[PAT-EXT-31]`).
 *
 * Pure TypeScript/JavaScript language-level visitor utilities for extracting entry/exit Port Valves
 * (`portValves`, `inputTypes`, `outputType`) from callable signatures, interface declarations, and
 * object type aliases in $O(1)$ amortized time per `ts.SourceFile` via `WeakMap` declaration caching.
 *
 * Framework-specific port conventions (Zod validators, MCP tool input schemas, Drizzle tables) are
 * isolated in `../conventions/portConventions.ts` per `[PAT-EXT-28]`.
 */

import ts from 'typescript';
import type {
  ContractPortValves,
  PortFieldSchema,
  PortOutputValve,
  PortParameterValve,
} from '../../types/ports.js';

const BUILTIN_WRAPPER_TYPES = new Set([
  'Promise',
  'Array',
  'ReadonlyArray',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Record',
  'Exclude',
  'Extract',
  'NonNullable',
  'ReturnType',
  'Parameters',
  'Awaited',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Error',
  'Date',
  'RegExp',
  'Buffer',
  'Uint8Array',
  'Iterable',
  'AsyncIterable',
]);

const MAX_PORT_FIELDS = 24;
const MAX_FIELD_DEPTH = 2;
const MAX_TYPE_TEXT_LEN = 120;

interface LocalTypeSchemaEntry {
  fields: PortFieldSchema[];
  lineNumber: number;
}

const fileTypeSchemaCache = new WeakMap<ts.SourceFile, Map<string, LocalTypeSchemaEntry>>();

/**
 * Formats a `ts.TypeNode` into a compact, single-line TypeScript type string.
 *
 * @param typeNode   The TypeScript AST type node.
 * @param sourceFile Owning `ts.SourceFile` when available.
 * @returns Compact human-readable type string capped at {@link MAX_TYPE_TEXT_LEN} characters.
 */
function formatConciseTypeNode(
  typeNode: ts.TypeNode,
  sourceFile?: ts.SourceFile
): string {
  const raw = sourceFile ? typeNode.getText(sourceFile) : typeNode.getText();
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_TYPE_TEXT_LEN) return compact;
  return `${compact.slice(0, MAX_TYPE_TEXT_LEN - 1)}…`;
}

/**
 * Extracts structured {@link PortFieldSchema} items from `TypeElement` members (`InterfaceDeclaration`
 * or `TypeLiteralNode`) up to {@link MAX_FIELD_DEPTH}.
 */
function extractTypeElementsFields(
  members: ts.NodeArray<ts.TypeElement>,
  sourceFile: ts.SourceFile | undefined,
  depth: number
): PortFieldSchema[] {
  const fields: PortFieldSchema[] = [];
  for (const member of members) {
    if (fields.length >= MAX_PORT_FIELDS) break;
    if (ts.isPropertySignature(member) && member.name) {
      const name =
        ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
          ? member.name.text
          : sourceFile
            ? member.name.getText(sourceFile)
            : member.name.getText();
      if (!name) continue;
      const propType = member.type
        ? formatConciseTypeNode(member.type, sourceFile)
        : 'unknown';
      let nested: PortFieldSchema[] | undefined;
      if (depth + 1 < MAX_FIELD_DEPTH && member.type && ts.isTypeLiteralNode(member.type)) {
        const sub = extractTypeElementsFields(member.type.members, sourceFile, depth + 1);
        if (sub.length > 0) nested = sub;
      }
      fields.push({
        name,
        type: propType,
        ...(member.questionToken ? { optional: true } : {}),
        ...(nested ? { fields: nested } : {}),
      });
    } else if (ts.isMethodSignature(member) && member.name) {
      const name =
        ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
          ? member.name.text
          : undefined;
      if (!name) continue;
      const ret = member.type ? formatConciseTypeNode(member.type, sourceFile) : 'unknown';
      fields.push({
        name,
        type: `(...) => ${ret}`,
        ...(member.questionToken ? { optional: true } : {}),
      });
    }
  }
  return fields;
}

/**
 * Builds or retrieves the per-`SourceFile` index of top-level `interface` and object `type`
 * declarations in linear $O(N)$ time (`[PAT-EXT-31]`).
 */
function getFileTypeSchemaIndex(
  sourceFile: ts.SourceFile | undefined
): Map<string, LocalTypeSchemaEntry> {
  if (!sourceFile) return new Map();
  const cached = fileTypeSchemaCache.get(sourceFile);
  if (cached) return cached;

  const index = new Map<string, LocalTypeSchemaEntry>();

  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
      const fields = extractTypeElementsFields(stmt.members, sourceFile, 0);
      if (fields.length > 0) {
        const lineNumber =
          sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1;
        index.set(stmt.name.text, { fields, lineNumber });
      }
    } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
      if (ts.isTypeLiteralNode(stmt.type)) {
        const fields = extractTypeElementsFields(stmt.type.members, sourceFile, 0);
        if (fields.length > 0) {
          const lineNumber =
            sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1;
          index.set(stmt.name.text, { fields, lineNumber });
        }
      } else if (ts.isIntersectionTypeNode(stmt.type)) {
        const combined: PortFieldSchema[] = [];
        const seen = new Set<string>();
        for (const part of stmt.type.types) {
          if (ts.isTypeLiteralNode(part)) {
            for (const f of extractTypeElementsFields(part.members, sourceFile, 0)) {
              if (!seen.has(f.name) && combined.length < MAX_PORT_FIELDS) {
                seen.add(f.name);
                combined.push(f);
              }
            }
          }
        }
        if (combined.length > 0) {
          const lineNumber =
            sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1;
          index.set(stmt.name.text, { fields: combined, lineNumber });
        }
      }
    }
  }

  // Second shallow pass to resolve same-file `interface Sub extends Base` inheritance
  for (const stmt of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || !stmt.name || !stmt.heritageClauses) continue;
    const ownFields = extractTypeElementsFields(stmt.members, sourceFile, 0);
    const merged: PortFieldSchema[] = [...ownFields];
    const seen = new Set(ownFields.map((f) => f.name));
    for (const hc of stmt.heritageClauses) {
      for (const expr of hc.types) {
        if (ts.isIdentifier(expr.expression)) {
          const baseEntry = index.get(expr.expression.text);
          if (baseEntry) {
            for (const bf of baseEntry.fields) {
              if (!seen.has(bf.name) && merged.length < MAX_PORT_FIELDS) {
                seen.add(bf.name);
                merged.push(bf);
              }
            }
          }
        }
      }
    }
    if (merged.length > 0) {
      const lineNumber =
        sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1;
      index.set(stmt.name.text, { fields: merged, lineNumber });
    }
  }

  fileTypeSchemaCache.set(sourceFile, index);
  return index;
}

function resolveFieldsForTypeNode(
  typeNode: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile | undefined
): PortFieldSchema[] | undefined {
  if (!typeNode) return undefined;
  let cur: ts.TypeNode = typeNode;
  while (ts.isParenthesizedTypeNode(cur)) {
    cur = cur.type;
  }

  if (ts.isTypeLiteralNode(cur)) {
    const fields = extractTypeElementsFields(cur.members, sourceFile, 0);
    return fields.length > 0 ? fields : undefined;
  }

  if (ts.isTypeReferenceNode(cur)) {
    const refName = ts.isIdentifier(cur.typeName)
      ? cur.typeName.text
      : cur.typeName.right.text;

    if (
      (refName === 'Partial' || refName === 'Readonly' || refName === 'Required') &&
      cur.typeArguments &&
      cur.typeArguments.length === 1
    ) {
      const inner = resolveFieldsForTypeNode(cur.typeArguments[0], sourceFile);
      if (!inner) return undefined;
      if (refName === 'Partial') {
        return inner.map((f) => ({ ...f, optional: true }));
      }
      if (refName === 'Required') {
        return inner.map(({ optional: _opt, ...rest }) => rest);
      }
      return inner;
    }

    if (
      (refName === 'Array' || refName === 'ReadonlyArray') &&
      cur.typeArguments &&
      cur.typeArguments.length === 1
    ) {
      return resolveFieldsForTypeNode(cur.typeArguments[0], sourceFile);
    }

    const index = getFileTypeSchemaIndex(sourceFile);
    const hit = index.get(refName);
    if (hit && hit.fields.length > 0) {
      return hit.fields;
    }
  }

  if (ts.isArrayTypeNode(cur)) {
    return resolveFieldsForTypeNode(cur.elementType, sourceFile);
  }

  if (ts.isUnionTypeNode(cur)) {
    const nonNull = cur.types.filter(
      (t) =>
        !(
          ts.isLiteralTypeNode(t) &&
          t.literal.kind === ts.SyntaxKind.NullKeyword
        ) &&
        t.kind !== ts.SyntaxKind.UndefinedKeyword &&
        t.kind !== ts.SyntaxKind.VoidKeyword
    );
    if (nonNull.length === 1) {
      return resolveFieldsForTypeNode(nonNull[0], sourceFile);
    }
  }

  return undefined;
}

function collectTypeReferenceNames(typeNode: ts.TypeNode | undefined, out: Set<string>): void {
  if (!typeNode) return;
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = ts.isIdentifier(typeNode.typeName)
      ? typeNode.typeName.text
      : typeNode.typeName.right.text;
    if (!BUILTIN_WRAPPER_TYPES.has(name)) {
      out.add(name);
    }
    if (typeNode.typeArguments) {
      for (const arg of typeNode.typeArguments) {
        collectTypeReferenceNames(arg, out);
      }
    }
    return;
  }
  if (ts.isArrayTypeNode(typeNode)) {
    collectTypeReferenceNames(typeNode.elementType, out);
    return;
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    for (const member of typeNode.types) {
      collectTypeReferenceNames(member, out);
    }
    return;
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    collectTypeReferenceNames(typeNode.type, out);
  }
}

function inferSimpleInitializerType(expr: ts.Expression): string {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return 'string';
  }
  if (ts.isNumericLiteral(expr)) {
    return 'number';
  }
  if (
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return 'boolean';
  }
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) {
    return 'unknown[]';
  }
  return 'unknown';
}

function formatParameterBindingName(
  name: ts.BindingName,
  index: number,
  sourceFile: ts.SourceFile | undefined
): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isObjectBindingPattern(name)) {
    const keys: string[] = [];
    for (const el of name.elements) {
      if (keys.length >= 4) {
        keys.push('…');
        break;
      }
      const prop = el.propertyName ?? el.name;
      if (ts.isIdentifier(prop)) keys.push(prop.text);
    }
    return keys.length > 0 ? `{ ${keys.join(', ')} }` : `arg${index}`;
  }
  const text = sourceFile ? name.getText(sourceFile) : name.getText();
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 0 && compact.length <= 32 ? compact : `arg${index}`;
}

function hasAsyncKeyword(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function unwrapPromiseType(
  typeNode: ts.TypeNode
): { inner: ts.TypeNode; unwrappedPromise: boolean } {
  if (
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === 'Promise' &&
    typeNode.typeArguments &&
    typeNode.typeArguments.length === 1
  ) {
    return { inner: typeNode.typeArguments[0], unwrappedPromise: true };
  }
  return { inner: typeNode, unwrappedPromise: false };
}

/**
 * Extracts Speed 1 syntactic Port Valve metadata (`inputTypes`, `outputType`, and structured `portValves`)
 * from a TypeScript/JavaScript function, method, or getter signature (`[PAT-VIS-14]`, `[PAT-EXT-22]`).
 *
 * @example
 * ```ts
 * export async function createOrder(input: OrderInput, dryRun = false): Promise<OrderReceipt>
 * // -> {
 * //   inputTypes: ['OrderInput'],
 * //   outputType: 'OrderReceipt',
 * //   portValves: {
 * //     tier: 'syntactic',
 * //     origin: 'ts-signature',
 * //     inputs: [{ name: 'input', type: 'OrderInput', fields: [...] }, { name: 'dryRun', type: 'boolean', optional: true }],
 * //     output: { type: 'OrderReceipt', async: true, fields: [...] }
 * //   }
 * // }
 * ```
 *
 * @param node Callable AST signature declaration (`FunctionDeclaration`, `MethodDeclaration`, `ArrowFunction`, etc.).
 * @returns Port valve metadata object to spread onto `StructuralEntity.metadata`, or `undefined` when empty.
 */
export function extractCallablePortValves(
  node: ts.SignatureDeclarationBase
): {
  inputTypes?: string[];
  outputType?: string;
  portValves?: ContractPortValves;
} | undefined {
  const sourceFile = node.getSourceFile();

  const inputSet = new Set<string>();
  for (const param of node.parameters) {
    collectTypeReferenceNames(param.type, inputSet);
  }
  const outputSet = new Set<string>();
  collectTypeReferenceNames(node.type, outputSet);

  const inputTypes = inputSet.size > 0 ? Array.from(inputSet) : undefined;
  const outputType = outputSet.size > 0 ? Array.from(outputSet).join(' | ') : undefined;

  const inputs: PortParameterValve[] = [];
  for (let i = 0; i < node.parameters.length; i++) {
    const param = node.parameters[i];
    // Skip TypeScript `this: SomeContext` pseudo-parameters
    if (ts.isIdentifier(param.name) && param.name.text === 'this') continue;

    const rawName = formatParameterBindingName(param.name, i, sourceFile);
    const paramName = param.dotDotDotToken ? `...${rawName}` : rawName;
    const paramType = param.type
      ? formatConciseTypeNode(param.type, sourceFile)
      : param.initializer
        ? inferSimpleInitializerType(param.initializer)
        : 'unknown';
    const optional = Boolean(
      param.questionToken || param.initializer || param.dotDotDotToken
    );
    const fields = resolveFieldsForTypeNode(param.type, sourceFile);

    inputs.push({
      name: paramName,
      type: paramType,
      ...(optional ? { optional: true } : {}),
      ...(fields ? { fields } : {}),
    });
  }

  let output: PortOutputValve | undefined;
  const isAsyncFn = hasAsyncKeyword(node);
  if (node.type) {
    const { inner, unwrappedPromise } = unwrapPromiseType(node.type);
    const outTypeText = formatConciseTypeNode(inner, sourceFile);
    const outFields = resolveFieldsForTypeNode(inner, sourceFile);
    output = {
      type: outTypeText,
      ...(isAsyncFn || unwrappedPromise ? { async: true } : {}),
      ...(outFields ? { fields: outFields } : {}),
    };
  }

  const zeroInputs = inputs.length === 0;
  const hasTypedOrNamedInputs = inputs.some((p) => p.type !== 'unknown' || Boolean(p.fields));

  // Only emit structured portValves when there is concrete syntactic port information
  // (typed/named parameters, explicit return type, or explicit `()` zero-parameter contract
  // with a return annotation) — avoiding noise on untyped legacy JS helpers.
  const shouldEmitPortValves =
    inputs.length > 0 || Boolean(output) || Boolean(inputTypes) || Boolean(outputType);

  if (!inputTypes && !outputType && !shouldEmitPortValves) {
    return undefined;
  }

  const portValves: ContractPortValves | undefined =
    shouldEmitPortValves && (hasTypedOrNamedInputs || inputs.length > 0 || Boolean(output))
      ? {
          tier: 'syntactic',
          origin: 'ts-signature',
          ...(inputTypes ? { inputTypes } : {}),
          ...(outputType ? { outputType } : {}),
          ...(inputs.length > 0 ? { inputs } : {}),
          ...(output ? { output } : {}),
          ...(zeroInputs ? { zeroInputs: true } : {}),
        }
      : undefined;

  if (!inputTypes && !outputType && !portValves) {
    return undefined;
  }

  return {
    ...(inputTypes ? { inputTypes } : {}),
    ...(outputType ? { outputType } : {}),
    ...(portValves ? { portValves } : {}),
  };
}

/**
 * Extracts structured {@link ContractPortValves} (`origin: "ts-interface"`) from an exported
 * `interface` or object `type` declaration so inspecting a schema contract directly displays its fields.
 *
 * @param node `InterfaceDeclaration` or `TypeAliasDeclaration`.
 * @returns `{ portValves }` metadata or `undefined` when no object fields are declared.
 */
export function extractTypeDeclarationPortValves(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration
): { portValves: ContractPortValves } | undefined {
  const sourceFile = node.getSourceFile();
  const index = getFileTypeSchemaIndex(sourceFile);
  const hit = node.name ? index.get(node.name.text) : undefined;
  if (!hit || hit.fields.length === 0) return undefined;

  return {
    portValves: {
      tier: 'syntactic',
      origin: 'ts-interface',
      outputType: node.name.text,
      output: {
        type: node.name.text,
        fields: hit.fields,
      },
    },
  };
}
