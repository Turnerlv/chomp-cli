/**
 * @fileoverview Declarative & framework-convention Speed 1 Port Valve extractors (`[PAT-VIS-14]`, `[PAT-EXT-22]`, `[PAT-EXT-28]`).
 *
 * Isolated inside `conventions/` so core primitive visitors remain pure TypeScript/JavaScript.
 * Attaches structured Speed 1 `portValves` onto convention-emitted `CONTRACT` entities:
 *   - `VALIDATOR_SCHEMA` (`z.object({ ... })` Zod schemas)
 *   - `DB_SCHEMA` (`pgTable` / `sqliteTable` / `mysqlTable` / `createTable` Drizzle table columns)
 *   - `MCP_TOOL` (`server.tool` / `server.registerTool` input parameter schemas & handler signatures)
 *   - `HTTP_ENDPOINT` / `API_ENDPOINT` (Next.js route handlers & Express inline route callbacks)
 */

import ts from 'typescript';
import type {
  ContractPortValves,
  PortFieldSchema,
  PortParameterValve,
} from '../../types/ports.js';
import { extractCallablePortValves } from '../visitors/portValveVisitor.js';
import type { NodeMatch } from './types.js';

const MAX_SCHEMA_FIELDS = 24;
const MAX_SCHEMA_DEPTH = 2;

interface UnwrappedCallChain {
  rootCall: ts.CallExpression;
  modifiers: string[];
}

function unwrapFluentCallChain(expr: ts.Expression): UnwrappedCallChain | null {
  const modifiers: string[] = [];
  let cur: ts.Expression = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) {
    cur = cur.expression;
  }
  if (!ts.isCallExpression(cur)) return null;

  let rootCall: ts.CallExpression = cur;
  while (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    ts.isCallExpression(cur.expression.expression)
  ) {
    modifiers.unshift(cur.expression.name.text);
    rootCall = cur.expression.expression;
    cur = cur.expression.expression;
  }
  return { rootCall, modifiers };
}

function getCalleeLeafName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

const ZOD_PRIMITIVE_TYPE_MAP: Readonly<Record<string, string>> = {
  string: 'string',
  email: 'string',
  url: 'string',
  uuid: 'string',
  number: 'number',
  int: 'number',
  bigint: 'bigint',
  boolean: 'boolean',
  date: 'Date',
  any: 'any',
  unknown: 'unknown',
  void: 'void',
  null: 'null',
  undefined: 'undefined',
};

function parseZodExpr(
  expr: ts.Expression,
  sourceFile: ts.SourceFile | undefined,
  depth: number
): { type: string; optional: boolean; fields?: PortFieldSchema[] } | null {
  const chain = unwrapFluentCallChain(expr);
  if (!chain) return null;

  const { rootCall, modifiers } = chain;
  const leaf = getCalleeLeafName(rootCall);
  if (!leaf) return null;

  const optional = modifiers.some(
    (m) => m === 'optional' || m === 'nullish' || m === 'default' || m === 'catch'
  );
  const nullable = modifiers.includes('nullable') || modifiers.includes('nullish');

  let baseType = ZOD_PRIMITIVE_TYPE_MAP[leaf] ?? null;
  let fields: PortFieldSchema[] | undefined;

  if (leaf === 'object' && rootCall.arguments.length >= 1) {
    const arg0 = rootCall.arguments[0];
    if (ts.isObjectLiteralExpression(arg0) && depth < MAX_SCHEMA_DEPTH) {
      const subFields = extractZodObjectFields(arg0, sourceFile, depth + 1);
      if (subFields.length > 0) fields = subFields;
    }
    baseType = 'object';
  } else if (leaf === 'array' && rootCall.arguments.length >= 1) {
    const elem = parseZodExpr(rootCall.arguments[0], sourceFile, depth + 1);
    baseType = elem ? `${elem.type}[]` : 'unknown[]';
    if (elem?.fields) fields = elem.fields;
  } else if (leaf === 'enum' && rootCall.arguments.length >= 1) {
    const arg0 = rootCall.arguments[0];
    if (ts.isArrayLiteralExpression(arg0)) {
      const literals = arg0.elements
        .filter((e): e is ts.StringLiteral => ts.isStringLiteral(e))
        .slice(0, 6)
        .map((e) => `'${e.text}'`);
      baseType = literals.length > 0 ? literals.join(' | ') : 'enum';
    } else {
      baseType = 'enum';
    }
  } else if (leaf === 'literal' && rootCall.arguments.length >= 1) {
    const arg0 = rootCall.arguments[0];
    const txt = sourceFile ? arg0.getText(sourceFile) : arg0.getText();
    baseType = txt.trim().slice(0, 40) || 'literal';
  } else if (leaf === 'record') {
    baseType = 'Record<string, unknown>';
  } else if (leaf === 'union' || leaf === 'discriminatedUnion') {
    baseType = 'union';
  }

  if (!baseType) return null;
  if (nullable && !baseType.includes('null')) {
    baseType = `${baseType} | null`;
  }
  if (modifiers.includes('array')) {
    baseType = `${baseType}[]`;
  }

  return {
    type: baseType,
    optional,
    ...(fields ? { fields } : {}),
  };
}

function extractZodObjectFields(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile | undefined,
  depth: number
): PortFieldSchema[] {
  const fields: PortFieldSchema[] = [];
  for (const prop of obj.properties) {
    if (fields.length >= MAX_SCHEMA_FIELDS) break;
    if (!ts.isPropertyAssignment(prop)) continue;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
        ? prop.name.text
        : undefined;
    if (!name) continue;
    const parsed = parseZodExpr(prop.initializer, sourceFile, depth);
    fields.push({
      name,
      type: parsed?.type ?? 'unknown',
      ...(parsed?.optional ? { optional: true } : {}),
      ...(parsed?.fields ? { fields: parsed.fields } : {}),
    });
  }
  return fields;
}

function findVariableInitializerCall(node: ts.Node, bindingName?: string): ts.Expression | null {
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (!bindingName || (ts.isIdentifier(decl.name) && decl.name.text === bindingName)) {
        return decl.initializer;
      }
    }
  }
  if (ts.isVariableDeclaration(node) && node.initializer) {
    return node.initializer;
  }
  if (ts.isCallExpression(node)) {
    return node;
  }
  return null;
}

function extractZodValidatorPortValves(
  node: ts.Node,
  schemaName?: string
): { portValves: ContractPortValves; outputType?: string } | undefined {
  const init = findVariableInitializerCall(node, schemaName);
  if (!init) return undefined;
  const sourceFile = node.getSourceFile();
  const parsed = parseZodExpr(init, sourceFile, 0);
  if (!parsed) return undefined;

  const displayType = schemaName || parsed.type;
  return {
    ...(schemaName ? { outputType: schemaName } : {}),
    portValves: {
      tier: 'syntactic',
      origin: 'zod',
      ...(schemaName ? { outputType: schemaName } : {}),
      output: {
        type: displayType,
        ...(parsed.fields ? { fields: parsed.fields } : {}),
      },
    },
  };
}

const DRIZZLE_COLUMN_TYPE_MAP: Readonly<Record<string, string>> = {
  serial: 'number',
  smallserial: 'number',
  bigserial: 'bigint',
  integer: 'number',
  int: 'number',
  smallint: 'number',
  tinyint: 'number',
  bigint: 'bigint',
  real: 'number',
  doublePrecision: 'number',
  float: 'number',
  numeric: 'string',
  decimal: 'string',
  text: 'string',
  varchar: 'string',
  char: 'string',
  uuid: 'string',
  boolean: 'boolean',
  timestamp: 'Date',
  date: 'string',
  time: 'string',
  json: 'unknown',
  jsonb: 'unknown',
  blob: 'Buffer',
};

function extractDrizzleTablePortValves(
  node: ts.Node,
  tableName?: string
): { portValves: ContractPortValves; outputType?: string } | undefined {
  const init = findVariableInitializerCall(node);
  if (!init) return undefined;
  const chain = unwrapFluentCallChain(init);
  if (!chain) return undefined;
  const call = chain.rootCall;
  if (call.arguments.length < 2) return undefined;

  const colsArg = call.arguments[1];
  if (!ts.isObjectLiteralExpression(colsArg)) return undefined;

  const fields: PortFieldSchema[] = [];
  for (const prop of colsArg.properties) {
    if (fields.length >= MAX_SCHEMA_FIELDS) break;
    if (!ts.isPropertyAssignment(prop)) continue;
    const colPropName =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
        ? prop.name.text
        : undefined;
    if (!colPropName) continue;

    const colChain = unwrapFluentCallChain(prop.initializer);
    if (!colChain) {
      fields.push({ name: colPropName, type: 'unknown' });
      continue;
    }
    const builderName = getCalleeLeafName(colChain.rootCall) ?? 'column';
    const mappedType = DRIZZLE_COLUMN_TYPE_MAP[builderName] ?? builderName;
    const isRequired = colChain.modifiers.some(
      (m) => m === 'notNull' || m === 'primaryKey'
    );
    fields.push({
      name: colPropName,
      type: mappedType,
      ...(!isRequired ? { optional: true } : {}),
    });
  }

  const rowType = tableName ? `${tableName}Row` : 'TableRow';
  return {
    outputType: rowType,
    portValves: {
      tier: 'syntactic',
      origin: 'drizzle',
      outputType: rowType,
      output: {
        type: rowType,
        ...(fields.length > 0 ? { fields } : {}),
      },
    },
  };
}

function findCallExpressionFromNode(node: ts.Node): ts.CallExpression | null {
  if (ts.isCallExpression(node)) return node;
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    return node.expression;
  }
  return null;
}

function findTrailingFunctionArg(
  call: ts.CallExpression
): ts.ArrowFunction | ts.FunctionExpression | null {
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    let arg: ts.Expression = call.arguments[i];
    while (ts.isParenthesizedExpression(arg) || ts.isAsExpression(arg)) {
      arg = arg.expression;
    }
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      return arg;
    }
  }
  return null;
}

function extractMcpToolPortValves(
  node: ts.Node
): {
  inputTypes?: string[];
  outputType?: string;
  portValves?: ContractPortValves;
} | undefined {
  const call = findCallExpressionFromNode(node);
  if (!call) return undefined;
  const sourceFile = node.getSourceFile();

  let schemaInputs: PortParameterValve[] | undefined;

  // Check arguments between tool name (arg 0) and handler callback for a Zod shape or `{ inputSchema: { ... } }`
  for (let i = 1; i < call.arguments.length; i++) {
    const arg = call.arguments[i];
    if (!ts.isObjectLiteralExpression(arg)) continue;

    // `registerTool('name', { inputSchema: { ... } }, handler)`
    const inputSchemaProp = arg.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === 'inputSchema'
    );
    if (inputSchemaProp) {
      if (ts.isObjectLiteralExpression(inputSchemaProp.initializer)) {
        const zodFields = extractZodObjectFields(
          inputSchemaProp.initializer,
          sourceFile,
          0
        );
        if (zodFields.length > 0) {
          schemaInputs = zodFields.map((f) => ({
            name: f.name,
            type: f.type,
            ...(f.optional ? { optional: true } : {}),
            ...(f.fields ? { fields: f.fields } : {}),
          }));
          break;
        }
      } else {
        const parsedZod = parseZodExpr(inputSchemaProp.initializer, sourceFile, 0);
        if (parsedZod?.fields && parsedZod.fields.length > 0) {
          schemaInputs = parsedZod.fields.map((f) => ({
            name: f.name,
            type: f.type,
            ...(f.optional ? { optional: true } : {}),
            ...(f.fields ? { fields: f.fields } : {}),
          }));
          break;
        }
      }
      continue;
    }

    // `server.tool('name', { search_term: z.string().optional() }, handler)`
    const zodFields = extractZodObjectFields(arg, sourceFile, 0);
    if (zodFields.length > 0) {
      schemaInputs = zodFields.map((f) => ({
        name: f.name,
        type: f.type,
        ...(f.optional ? { optional: true } : {}),
        ...(f.fields ? { fields: f.fields } : {}),
      }));
      break;
    }
  }

  const handlerFn = findTrailingFunctionArg(call);
  const handlerValves = handlerFn ? extractCallablePortValves(handlerFn) : undefined;

  const finalInputs = schemaInputs ?? handlerValves?.portValves?.inputs;
  const finalOutput = handlerValves?.portValves?.output;

  if (!finalInputs && !finalOutput && !handlerValves) return undefined;

  return {
    ...(handlerValves?.inputTypes ? { inputTypes: handlerValves.inputTypes } : {}),
    ...(handlerValves?.outputType ? { outputType: handlerValves.outputType } : {}),
    portValves: {
      tier: 'syntactic',
      origin: schemaInputs ? 'mcp-schema' : 'ts-signature',
      ...(handlerValves?.inputTypes ? { inputTypes: handlerValves.inputTypes } : {}),
      ...(handlerValves?.outputType ? { outputType: handlerValves.outputType } : {}),
      ...(finalInputs && finalInputs.length > 0 ? { inputs: finalInputs } : {}),
      ...(finalOutput ? { output: finalOutput } : {}),
      ...(!finalInputs && handlerValves?.portValves?.zeroInputs
        ? { zeroInputs: true }
        : {}),
    },
  };
}

function extractEndpointPortValves(
  node: ts.Node
): {
  inputTypes?: string[];
  outputType?: string;
  portValves?: ContractPortValves;
} | undefined {
  if (ts.isFunctionDeclaration(node)) {
    return extractCallablePortValves(node);
  }
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (
        decl.initializer &&
        (ts.isArrowFunction(decl.initializer) ||
          ts.isFunctionExpression(decl.initializer))
      ) {
        return extractCallablePortValves(decl.initializer);
      }
    }
  }
  const call = findCallExpressionFromNode(node);
  if (call) {
    const handlerFn = findTrailingFunctionArg(call);
    if (handlerFn) {
      return extractCallablePortValves(handlerFn);
    }
  }
  return undefined;
}

/**
 * Extracts Speed 1 syntactic Port Valve metadata for a convention-matched `CONTRACT` entity.
 *
 * @param node              Matched AST node.
 * @param match             Declarative convention match bindings (`name`, `method`, etc.).
 * @param emittedEntityType Rendered `entityType` of the emitted `CONTRACT`.
 * @returns Port metadata fields (`portValves`, `inputTypes`, `outputType`) or `undefined`.
 */
export function extractConventionPortValves(
  node: ts.Node,
  match: NodeMatch,
  emittedEntityType: string
): {
  inputTypes?: string[];
  outputType?: string;
  portValves?: ContractPortValves;
} | undefined {
  switch (emittedEntityType) {
    case 'VALIDATOR_SCHEMA':
      return extractZodValidatorPortValves(node, match.bindings.name);
    case 'DB_SCHEMA':
      return extractDrizzleTablePortValves(node, match.bindings.name);
    case 'MCP_TOOL':
      return extractMcpToolPortValves(node);
    case 'HTTP_ENDPOINT':
    case 'API_ENDPOINT':
    case 'SERVER_ACTION':
      return extractEndpointPortValves(node);
    default:
      if (ts.isFunctionDeclaration(node)) {
        return extractCallablePortValves(node);
      }
      return undefined;
  }
}
