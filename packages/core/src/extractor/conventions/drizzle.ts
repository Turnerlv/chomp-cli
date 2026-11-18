// packages/core/src/extractor/conventions/drizzle.ts
//
// Drizzle ORM schema and query-chain conventions, as DATA (`[PAT-EXT-28]`).
// Replaces the hand-written AST matching in `adapters/drizzleAdapter.ts`.

import type { ConventionSet } from './types.js';

export const DRIZZLE_SCHEMA_BUILDERS = [
  'pgTable',
  'mysqlTable',
  'sqliteTable',
  'pgEnum',
  'createTable',
] as const;
export const DRIZZLE_TABLE_CREATORS = [
  'pgTableCreator',
  'mysqlTableCreator',
  'sqliteTableCreator',
] as const;
export const DRIZZLE_CLIENT_ROOTS = ['db', 'tx', 'trx', 'drizzle'] as const;
export const DRIZZLE_ENTRY_METHODS = [
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'transaction',
] as const;
export const DRIZZLE_SCHEMA_ARG_METHODS = [
  'from',
  'insert',
  'update',
  'delete',
  'into',
  'execute',
] as const;
export const DRIZZLE_MUTATE_METHODS = ['insert', 'update', 'delete'] as const;
export const DRIZZLE_RELATIONAL_QUERY_METHODS = ['findFirst', 'findMany'] as const;

export const DRIZZLE_CONVENTIONS: ConventionSet = {
  framework: 'drizzle',
  fileRoles: [],
  baseExtensions: ['ts', 'tsx', 'js', 'jsx'],

  rules: [
    {
      id: 'drizzle.schema',
      roles: null,
      match: {
        kind: 'variableInitializedByCall',
        callees: DRIZZLE_SCHEMA_BUILDERS,
      },
      emit: {
        type: 'CONTRACT',
        entityType: 'DB_SCHEMA',
        patternId: 'contract.drizzle-schema',
        name: 'Drizzle Schema: {name}',
        idScope: 'Drizzle Schema: {name}',
      },
      meta: {
        framework: 'drizzle',
        fixture: 'nextjs-drizzle',
        specRef: 'PAT-EXT-28',
        description:
          'A variable initialized with `pgTable` / `mysqlTable` / `sqliteTable` / `pgEnum` declares a Drizzle database schema contract.',
      },
    },
    {
      id: 'drizzle.query-chain',
      roles: null,
      match: {
        kind: 'fluentCallChain',
        roots: DRIZZLE_CLIENT_ROOTS,
        entryMethods: DRIZZLE_ENTRY_METHODS,
        schemaArgMethods: DRIZZLE_SCHEMA_ARG_METHODS,
        mutateMethods: DRIZZLE_MUTATE_METHODS,
        relationalQueryMethods: DRIZZLE_RELATIONAL_QUERY_METHODS,
      },
      emit: {
        type: 'OPEN_CONNECTOR',
        entityType: 'DB_QUERY',
        patternId: 'open-connector.drizzle-query-chain',
        name: 'Drizzle Query: {entryMethod}()',
        companionRelationship: {
          entityType: '{relType}',
          patternId: 'relationship.drizzle-{relTypeLower}',
          name: '{relType} Schema: {schema}',
          targetContract: {
            idScope: 'Drizzle Schema: {schema}',
            contractName: 'Drizzle Schema: {schema}',
          },
        },
      },
      meta: {
        framework: 'drizzle',
        fixture: 'nextjs-drizzle',
        specRef: 'PAT-EXT-28',
        description:
          'The topmost call of a `db.select/insert/update/delete/execute/transaction` fluent chain or `db.query.<table>.findFirst/findMany` relational query is a database query connector, paired with a `READS`/`MUTATES` relationship when a schema table is referenced.',
      },
    },
  ],

  derivers: {},
  escapeHatches: [],
};
