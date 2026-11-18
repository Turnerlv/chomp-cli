// packages/core/src/extractor/conventions/core.ts
//
// Core JS/TS & Cross-Framework Conventions — "Conventions as Data" ([PAT-EXT-28]).
//
// Captures non-adapter module and property conventions that previously lived in standalone
// visitors (`directiveVisitor.ts`, `definePropertyVisitor.ts`, `factoryExportVisitor.ts`,
// `commonjsExportVisitor.ts`):
// - `import 'server-only'` bare side-effect import guard
// - `Object.defineProperty(obj, 'prop', ...)` / `defineGetter(obj, 'prop', ...)`
// - `export const { auth, signIn } = NextAuth(...)` / `export const s = createInsertSchema(...)`
// - CommonJS `module.exports = ...`, `exports.x = ...`, `Class.prototype.m = ...`, `app[method] = ...`, `alias.fn = ...`

import type { ConventionSet } from './types.js';

export const CORE_CONVENTIONS: ConventionSet = {
  framework: 'core',
  fileRoles: [],
  baseExtensions: ['ts', 'tsx', 'js', 'jsx'],
  rules: [
    // ── 1. Server-only side-effect import guard (`directiveVisitor.ts`) ─────────────────────────
    {
      id: 'core.server-only-guard',
      roles: null,
      match: { kind: 'sideEffectImport', modules: ['server-only'] },
      emit: {
        type: 'CONTRACT',
        entityType: 'SERVER_GUARD',
        patternId: 'contract.nextjs-server-only-guard',
        name: 'Server Guard: {module}',
      },
      meta: {
        framework: 'core',
        fixture: 'nextjs-app-router',
        specRef: 'PAT-EXT-28',
        description: "Bare side-effect import 'server-only' asserting a server-bundle boundary",
      },
    },

    // ── 2. Object.defineProperty / defineGetter contract (`definePropertyVisitor.ts`) ──────────
    {
      id: 'core.define-property-getter',
      roles: null,
      match: { kind: 'definePropertyCall', callees: ['Object.defineProperty', 'defineGetter'] },
      emit: {
        type: 'CONTRACT',
        entityType: 'PROPERTY_GETTER',
        patternId: 'contract.define-property',
        name: 'Property Getter: {prop}',
      },
      meta: {
        framework: 'core',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: 'Object.defineProperty(obj, name, ...) or defineGetter(obj, name, ...) property getter contract',
      },
    },

    // ── 3. Exported factory contracts (`factoryExportVisitor.ts`) ──────────────────────────────
    {
      id: 'core.nextauth-factory-destructure',
      roles: null,
      match: { kind: 'exportedFactoryCall', callees: ['NextAuth'] },
      emit: {
        type: 'CONTRACT',
        entityType: 'AUTH_INTERFACE',
        patternId: 'contract.nextauth-factory-destructure',
        name: 'AUTH_INTERFACE: {name}',
      },
      meta: {
        framework: 'core',
        fixture: 'factory-destructure',
        specRef: 'PAT-EXT-28',
        description: 'Exported NextAuth(...) factory assignment or destructured auth interface exports',
      },
    },
    {
      id: 'core.drizzle-exported-validator',
      roles: null,
      match: {
        kind: 'exportedFactoryCall',
        callees: ['createInsertSchema', 'createSelectSchema'],
      },
      emit: {
        type: 'CONTRACT',
        entityType: 'VALIDATOR_SCHEMA',
        patternId: 'contract.drizzle-exported-validator',
        name: 'VALIDATOR_SCHEMA: {name}',
      },
      meta: {
        framework: 'core',
        fixture: 'nextjs-drizzle',
        specRef: 'PAT-EXT-28',
        description: 'Exported Drizzle-Zod validator schema (createInsertSchema / createSelectSchema)',
      },
    },
    {
      id: 'core.drizzle-namespaced-table-schema',
      roles: null,
      match: {
        kind: 'exportedFactoryCall',
        callees: ['pgTable'],
        calleeSyntax: 'member',
      },
      emit: {
        type: 'CONTRACT',
        entityType: 'DB_SCHEMA',
        patternId: 'contract.drizzle-table-schema',
        name: 'DB_SCHEMA: {name}',
      },
      meta: {
        framework: 'core',
        fixture: 'nextjs-drizzle',
        specRef: 'PAT-EXT-28',
        description: 'Exported property-access pgTable schema (e.g. schema.pgTable(...))',
      },
    },
    {
      id: 'core.zod-exported-validator',
      roles: null,
      match: {
        kind: 'exportedFactoryCall',
        callees: [
          'object',
          'discriminatedUnion',
          'intersection',
          'union',
          'array',
          'record',
          'tuple',
          'enum',
          'nativeEnum',
          'withBrand',
          'withConstraint',
          'preprocess',
          'lazy',
          'custom',
          'instanceof',
          'pipeline',
        ],
        calleeSyntax: 'member',
      },
      emit: {
        type: 'CONTRACT',
        entityType: 'VALIDATOR_SCHEMA',
        patternId: 'contract.drizzle-exported-validator',
        name: 'VALIDATOR_SCHEMA: {name}',
      },
      meta: {
        framework: 'core',
        fixture: 'nextjs-drizzle',
        specRef: 'PAT-EXT-28',
        description: 'Exported Zod validator schema (z.object / z.discriminatedUnion)',
      },
    },

    // ── 4. CommonJS exports & prototype methods (`commonjsExportVisitor.ts`) ───────────────────
    {
      id: 'core.commonjs-prototype-method',
      roles: null,
      match: { kind: 'commonjsAssignment', form: 'prototypeMethod' },
      emit: {
        type: 'CONTRACT',
        entityType: '{entityType}',
        patternId: 'contract.commonjs-export',
        name: 'Prototype Method: {className}.prototype.{methodName}',
      },
      meta: {
        framework: 'core',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: 'Prototype method assignment (Class.prototype.method = function() {})',
      },
    },
    {
      id: 'core.commonjs-export-alias',
      roles: null,
      match: { kind: 'commonjsAssignment', form: 'exportAlias' },
      emit: {
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.cjs-module-exports-alias',
        name: 'CJS Export Alias: {receiver}.{name}',
      },
      meta: {
        framework: 'core',
        fixture: 'cjs-export-alias',
        specRef: 'PAT-EXT-28',
        description: 'CommonJS aliased export assignment (alias.method = function() {})',
      },
    },
    {
      id: 'core.commonjs-dynamic-method',
      roles: null,
      match: { kind: 'commonjsAssignment', form: 'dynamicElement' },
      emit: {
        type: 'CONTRACT',
        entityType: 'CJS_METHOD',
        patternId: 'contract.commonjs-export',
        name: 'Dynamic Export: {receiver}[method]',
      },
      meta: {
        framework: 'core',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: 'Dynamic element-access CommonJS method assignment (app[method] = function() {})',
      },
    },
    {
      id: 'core.commonjs-export',
      roles: null,
      match: { kind: 'commonjsAssignment', form: 'moduleExports' },
      emit: {
        type: 'CONTRACT',
        entityType: '{entityType}',
        patternId: 'contract.commonjs-export',
        name: 'CJS Export: {exportName}',
      },
      meta: {
        framework: 'core',
        fixture: 'express-app',
        specRef: 'PAT-EXT-28',
        description: 'CommonJS module.exports / exports.<name> assignment contract',
      },
    },
  ],
  derivers: {},
  escapeHatches: [],
};
