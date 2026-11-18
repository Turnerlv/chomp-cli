// packages/core/src/extractor/conventions/types.ts
//
// Declarative framework conventions — "Conventions as Data".
//
// A framework convention is, in every adapter we have written, the same three-part fact:
//
//   1. a FILE ROLE      — a path convention        (`app/**/page.tsx` plays the PAGE role)
//   2. a NODE MATCHER   — an AST form              (an exported function whose name is in a set)
//   3. an OUTPUT TEMPLATE — what it becomes         (name, entityType, patternId, metadata)
//
// This module describes those three parts as plain data. `engine.ts` interprets them; each
// framework supplies only a `ConventionSet`. Adding a convention is a data row plus a committed
// fixture — no TypeScript visitor. What a table genuinely cannot express stays hand-written as a
// documented escape hatch (see `ConventionSet.escapeHatches`), so nothing is hidden.
//
// Nothing in here imports from the ledger, the DB or the visualizer (AGENTS.md §9).

import type ts from 'typescript';
import type { EvidenceRecord } from '../../types/index.js';

// ── 1. File roles ────────────────────────────────────────────────────────────────────────────

/**
 * A path convention that gives a file a structural role.
 *
 * Matches `<under>/**\/<fileName>.<ext>` (or `<fileName>.<ext>` anywhere when `under` is null),
 * where `<ext>` is one of the set's base extensions plus any extension configured by the
 * framework itself (see `ExtensionConfigSource`).
 */
export interface FileRoleRule {
  /** Role name handed to node matchers via `ConventionRule.roles` (e.g. `PAGE`). */
  role: string;
  /** Base file name without extension (e.g. `page`). */
  fileName: string;
  /** Required directory segment the file must live under (e.g. `app`), or null for anywhere. */
  under: string | null;
}

/**
 * Where a framework lets the project extend which file extensions count (Next.js
 * `pageExtensions`). Read statically from the framework's config file: only a literal array of
 * string literals is accepted. A computed value is an honest unknown — it is never guessed.
 */
export interface ExtensionConfigSource {
  /** Candidate config file names, nearest-ancestor-directory first (e.g. `next.config.mjs`). */
  files: readonly string[];
  /** Property whose value is the extension array (e.g. `pageExtensions`). */
  key: string;
}

// ── 2. Node matchers ─────────────────────────────────────────────────────────────────────────

/**
 * First-argument shape constraints and binding extractors for `callToMember`.
 * Each binds `arg0` when matched.
 */
export type CallArg0Matcher =
  /** `arguments[0]` must be a StringLiteral; binds `arg0` to its text. */
  | 'stringLiteral'
  /** If `arguments[0]` is a StringLiteral, binds `arg0` to its text, else `'Unknown'`. */
  | 'optionalStringLiteral'
  /**
   * `arguments[0]` must be a StringLiteral or RegularExpressionLiteral, and when it is the sole
   * argument of the call it must start with `'/'` (distinguishes routes from 1-arg getters like
   * `req.get('Range')` or `app.get('env')`). Binds `arg0` to the literal text.
   */
  | 'routePathLiteral'
  /**
   * `arguments[0]` may be a StringLiteral, an ArrayLiteralExpression of StringLiterals (joined by
   * `', '`), or anything else (`'Unknown'`). Binds `arg0`.
   */
  | 'stringOrStringArray'
  /**
   * `arguments[0]` must be an ObjectLiteralExpression; binds `arg0` to its property names
   * (Identifier or StringLiteral on PropertyAssignment) joined by `', '`.
   */
  | 'objectLiteralKeys';

/**
 * AST forms a convention can recognise. Each binds names usable in the output template.
 * Every form also binds `originalName`: the local identifier being exported / called.
 */
export type NodeMatcher =
  /**
   * `export [async] function NAME(...)`                      binds `name`
   * `names: '*'` accepts any name. `directive` additionally requires that string directive
   * (`'use server'`) as the first statement of the file or of the function body.
   */
  | { kind: 'exportedFunction'; names: readonly string[] | '*'; directive?: string }
  /** `export const { NAME, ... } = x`                          binds `name` (one match per name) */
  | { kind: 'exportedDestructured'; names: readonly string[] }
  /** `export default [async] function [NAME](...)`            binds `componentName` */
  | { kind: 'defaultExportedFunction'; requireName: boolean }
  /** `export { X as NAME }`                                    binds `exportedName` */
  | { kind: 'exportAlias'; exportedName: string }
  /** `export const NAME = ...` (one match per declaration)    binds `name` */
  | { kind: 'exportedConst'; names: readonly string[] }
  /**
   * `export const NAME = WRAP(fn)` where WRAP is one of `wrappers` (`memo`, `React.memo`, ...) and
   * `fn` is a function/arrow expression, possibly under nested wrappers (`memo(forwardRef(fn))`).
   * Binds `name`; the inner function is exposed as `NodeMatch.innerFunction`.
   */
  | { kind: 'exportedWrappedFunction'; wrappers: readonly string[] }
  /** `NAME(...)` — a call to a bare identifier                binds `name` */
  | { kind: 'callToIdentifier'; names: readonly string[] }
  /**
   * `RECEIVER.METHOD(arg0, ...)` — a method call on a property access expression.
   * Binds `method`, `METHOD` (uppercase), `callee`, `originalName`; plus `arg0` when `arg0` is set,
   * `value` / `VALUE` (uppercase) when `expandValues` fans out one match per value, and `schema` /
   * `relType` / `relTypeLower` / `targetKind` when `schemaObjectArg` matches a string-literal key in
   * `arguments[0]`.
   */
  | {
      kind: 'callToMember';
      receivers?: readonly string[];
      receiverEndsWith?: readonly string[];
      excludeReceivers?: readonly string[];
      methods: readonly string[] | '*';
      minArgs?: number;
      maxArgs?: number;
      arg0?: CallArg0Matcher;
      expandValues?: readonly string[];
      schemaObjectArg?: { keys: readonly string[]; mutateMethods: readonly string[] };
    }
  /**
   * `RECEIVER.use([pathPrefix], target)` — a middleware or sub-router registration call.
   * Binds `pathPrefix`, `target`, `originalName`.
   */
  | { kind: 'callUseTarget'; targetKind: 'middleware' | 'router'; excludeReceivers?: readonly string[] }
  /**
   * `const NAME = CALLEE(...)` — a variable declaration initialized by a call to one of `callees`.
   * Binds `name`, `callee`, `originalName`.
   */
  | { kind: 'variableInitializedByCall'; callees: readonly string[] }
  /**
   * Topmost call in a fluent chain `ROOT.ENTRY(...).step(...)` (e.g. `db.select().from(users)`)
   * or a relational query call `ROOT.query.<schema>.<method>(...)` (e.g. `db.query.users.findFirst(...)`).
   * Binds `root`, `entryMethod`, `originalName`; and when a call to `schemaArgMethods` receives an
   * identifier argument (or a relational query names `<schema>`), also binds `schema`, `relType`
   * (`READS` | `MUTATES`), `relTypeLower`.
   */
  | {
      kind: 'fluentCallChain';
      roots: readonly string[];
      entryMethods: readonly string[];
      schemaArgMethods: readonly string[];
      mutateMethods: readonly string[];
      relationalQueryMethods?: readonly string[];
    }
  /**
   * `const NAME: TYPE = { ... }` — a variable declaration with an explicit `TypeReferenceNode` in
   * `typeNames` and an object-literal initializer. Binds `name`, `typeName`, `originalName`.
   */
  | { kind: 'typedObjectVariable'; typeNames: readonly string[] }
  /**
   * `NAME: [...]` or `NAME: {...}` — an object property assignment whose value is an array or object
   * literal. Binds `name`, `originalName`.
   */
  | { kind: 'propertyAssignment'; names: readonly string[]; valueKind: 'array' | 'object' }
  /**
   * `import 'MODULE'` — a bare side-effect import (no `importClause`). Binds `module`, `originalName`.
   */
  | { kind: 'sideEffectImport'; modules: readonly string[] }
  /**
   * `Object.defineProperty(obj, 'PROP', ...)` or `defineGetter(obj, 'PROP', ...)`.
   * Binds `prop`, `originalName`.
   */
  | { kind: 'definePropertyCall'; callees: readonly string[] }
  /**
   * `export const NAME = CALLEE(...)` or `export const { A, B } = CALLEE(...)`.
   * `calleeSyntax` restricts whether `CALLEE` must be a bare `'identifier'`, a dotted `'member'`, or `'any'` (default).
   * Binds `name`, `callee`, `originalName`.
   */
  | {
      kind: 'exportedFactoryCall';
      callees: readonly string[];
      calleeSyntax?: 'identifier' | 'member' | 'any';
    }
  /**
   * CommonJS / prototype assignment forms (`module.exports = ...`, `exports.x = ...`,
   * `Class.prototype.m = ...`, `app[method] = ...`, `alias.fn = () => ...`).
   * Binds `exportName`, `entityType`, `className`, `methodName`, `receiver`, `name`, `originalName`.
   */
  | {
      kind: 'commonjsAssignment';
      form: 'moduleExports' | 'prototypeMethod' | 'dynamicElement' | 'exportAlias';
    };

// ── 3. Output template ───────────────────────────────────────────────────────────────────────

/**
 * Optional companion relationship emitted alongside a primary CONTRACT or OPEN_CONNECTOR.
 *
 * - When `targetContract` is omitted (e.g. MCP tool registration), `targetId` is left empty so the
 *   orchestrator links it to the primary contract (`[PAT-EXT-12]`).
 * - When `targetContract` is present (e.g. Drizzle/Payload schema `READS`/`MUTATES`), the companion
 *   edge is emitted with `sourceId = primaryEntity.id` only when every placeholder it references is
 *   bound on the match (e.g. `{schema}` bound when the call names a schema).
 */
export interface CompanionRelationshipTemplate {
  entityType: string;
  patternId: string;
  name: string;
  targetContract?: { idScope: string; contractName: string };
}

/**
 * What a matched node becomes. `name`, `idScope` and `metadata` values may contain `{placeholder}`
 * tokens: matcher bindings (see `NodeMatcher`) and the set's named `derivers` (e.g. `{routePath}`).
 * An unknown placeholder is a registry-integrity error (caught by the conventions test).
 */
export interface EmitTemplate {
  type: 'CONTRACT' | 'OPEN_CONNECTOR';
  entityType: string;
  patternId: string;
  name: string;
  /**
   * Optional scope template (may use `{placeholders}`) for entities whose deterministic ID is
   * shared across files by name (e.g. `middleware:{target}`) rather than scoped to the deployment unit.
   */
  idScope?: string;
  metadata?: Readonly<Record<string, string>>;
  companionRelationship?: CompanionRelationshipTemplate;
}

// ── Rules & sets ─────────────────────────────────────────────────────────────────────────────

/** Provenance of a rule — what makes it publishable as "a supported convention" later (W2.1). */
export interface ConventionRuleMeta {
  framework: string;
  /** Framework version range the convention applies to (documentation, not yet enforced). */
  versions?: string;
  /** Directory name under `fixtures/test-repos/` that proves this convention. */
  fixture: string;
  /** `PAT-EXT-XX` id of the prescriptive spec in `.project/patterns/extractor.md`. */
  specRef?: string;
  description: string;
}

export interface ConventionRule {
  /** Stable id (`nextjs.page`) — the key a pattern-ledger row and a public catalog entry use. */
  id: string;
  /** File roles the rule fires in; null = every file. */
  roles: readonly string[] | null;
  /** One AST form, or several forms of the same convention (any-of; every form's matches count). */
  match: NodeMatcher | readonly NodeMatcher[];
  emit: EmitTemplate;
  meta: ConventionRuleMeta;
}

/** Everything a framework contributes. */
export interface ConventionSet {
  framework: string;
  fileRoles: readonly FileRoleRule[];
  /** Extensions always accepted for file roles (without the dot), e.g. `ts`, `tsx`, `js`, `jsx`. */
  baseExtensions: readonly string[];
  extensionConfig?: ExtensionConfigSource;
  /** Rules that turn an AST node into a CONTRACT or OPEN_CONNECTOR. */
  rules: readonly ConventionRule[];
  /** Rules that turn an AST node into a RELATIONSHIP between two proven entities. */
  edgeRules?: readonly EdgeRule[];
  /** Named pure functions of the relative file path, referenced as `{name}` in templates. */
  derivers: Readonly<Record<string, (relativeFilePath: string) => string>>;
  /**
   * Conventions this framework implements by hand because a table cannot express them. Listed so
   * the limits of the table are explicit, reviewable and shrinkable — never silent.
   */
  escapeHatches: ReadonlyArray<{ id: string; reason: string; fixture: string }>;
}

// ── Edge rules ───────────────────────────────────────────────────────────────────────────────

/** AST forms an edge rule can recognise. */
export type EdgeMatcher =
  /**
   * `<Tag />` / `<Tag>...</Tag>` JSX component element.
   * - `tagSyntax: 'identifier'` (default): matches a Capitalized identifier tag (`<Card />`),
   *   ignoring lowercase DOM elements; binds `tagName`.
   * - `tagSyntax: 'member'`: matches a property-access JSX tag (`<Form.Input />`), binding
   *   `tagName` (`'Form.Input'`), `rootName` (`'Form'`), and `memberName` (`'Input'`).
   */
  | { kind: 'jsxComponentElement'; tagSyntax?: 'identifier' | 'member' }
  /** `RECEIVER.use([pathPrefix], target)` registration call                                     binds `pathPrefix`, `target` */
  | { kind: 'callUseTarget'; targetKind: 'middleware' | 'router' }
  /**
   * `RECEIVER.<method>(path, mw1, ..., handler)` route registration arguments.
   * `position: 'middleware'` matches intermediate arguments (`1 .. length - 2`);
   * `position: 'handler'` matches the final argument (`length - 1`) when it is not an inline
   * function/arrow expression. Binds `path`, `target`.
   */
  | {
      kind: 'callRouteTargets';
      methods: readonly string[];
      position: 'middleware' | 'handler';
      excludeReceivers?: readonly string[];
    }
  /**
   * `PROP: [item1, item2, ...]` — identifier elements (or `factory(...)` call elements when
   * `allowCallElements` is true) inside an array-literal property assignment. When `enclosingCall`
   * is set (e.g. `'buildConfig'`), matches on the call expression whose first argument is the
   * object literal. Binds `propName`, `target`.
   */
  | {
      kind: 'propertyArrayElements';
      names: readonly string[];
      allowCallElements?: boolean;
      enclosingCall?: string;
    };

/**
 * Ways to prove or derive an edge's target, tried in order; the first that resolves wins.
 *
 * - `importedComponent`: a statically ES-imported local component module (`import { Card } from './Card'`).
 * - `lazyComponent`: a component bound via `React.lazy(() => import(...))` / `lazy(() => import(...))`.
 * - `nextDynamicComponent`: a component bound via Next.js `dynamic(() => import(...))`.
 * - `namespacedComponent`: a compound/namespaced JSX tag `<Form.Input />` resolved via namespace
 *   import (`import * as Form`), imported module member, or same-file compound object.
 * - `sameFileExport`: an exported function-like declaration of that name in the same source file.
 * - `routerMount`: the mounted router module's exported contract (injected by `relationshipVisitor`);
 *   emits the mount edge even when the target contract is not proven (`targetId: undefined`).
 * - `syntheticContract`: a deterministic contract ID computed from `idScope` and `contractName`
 *   templates (e.g. `middleware:{target}` → `Middleware: {target}`). If the contract node does not
 *   exist in the final graph, the orchestrator strips `targetId` (Principle of Incomplete Truth).
 * - `unlinked`: emits the relationship edge with `targetId: undefined` (used when the visitor links
 *   an external package connector by import binding if present, e.g. `PLUGIN_REGISTRATION`).
 */
export type TargetStrategy =
  | 'importedComponent'
  | 'lazyComponent'
  | 'nextDynamicComponent'
  | 'namespacedComponent'
  | 'sameFileExport'
  | 'routerMount'
  | 'unlinked'
  | { kind: 'syntheticContract'; idScope: string; contractName: string };

export interface EdgeEmitTemplate {
  entityType: string;
  patternId: string;
  /** May use matcher bindings, e.g. `Renders: <{tagName} />`. */
  name: string;
  status: 'DETERMINISTIC' | 'INFERRED';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  metadata?: Record<string, unknown>;
}

export interface EdgeRule {
  id: string;
  match: EdgeMatcher;
  target: readonly TargetStrategy[];
  emit: EdgeEmitTemplate;
  meta: ConventionRuleMeta;
}

/**
 * Target lookups the engine cannot do itself (they need module/identity knowledge owned by the
 * relationship visitor). Injected by the caller; each returns null when the target is not proven.
 */
export interface EdgeTargetResolvers {
  importedComponent?(
    name: string,
    refNode: ts.Node
  ): { targetId: string | undefined; evidences: EvidenceRecord[] } | null;
  lazyComponent?(
    name: string,
    refNode: ts.Node,
    wrapper: 'lazy' | 'dynamic'
  ): { targetId: string | undefined; evidences: EvidenceRecord[] } | null;
  namespacedComponent?(
    rootName: string,
    memberName: string,
    refNode: ts.Node
  ): { targetId: string | undefined; evidences: EvidenceRecord[] } | null;
  sameFileExport?(
    name: string,
    refNode: ts.Node
  ): { targetId: string; evidences: EvidenceRecord[] } | null;
  routerMount?(callNode: ts.CallExpression): string | undefined;
}

// ── Engine I/O ───────────────────────────────────────────────────────────────────────────────

/** One AST match, before templating. */
export interface NodeMatch {
  bindings: Record<string, string>;
  /** Node whose evidence (file, line, snippet) proves the match. */
  evidenceNode: ts.Node;
  /** The function a wrapper matcher unwrapped to (e.g. the arrow inside `memo(() => ...)`). */
  innerFunction?: ts.Node;
}
