// packages/core/src/extractor/conventions/payload.ts
//
// Payload CMS configuration, schema, hook, plugin, transaction and data-access conventions, as DATA
// (`[PAT-EXT-28]`). Replaces the hand-written AST matching in `adapters/payloadAdapter.ts`.

import type { ConventionSet } from './types.js';

export const PAYLOAD_HOOK_NAMES = [
  'beforeChange',
  'afterChange',
  'beforeRead',
  'afterRead',
  'beforeDelete',
  'afterDelete',
  'beforeOperation',
  'afterOperation',
  'beforeValidate',
  'afterValidate',
  'beforeLogin',
  'afterLogin',
  'afterLogout',
  'afterMe',
  'afterRefresh',
  'afterForgotPassword',
  'afterError',
] as const;

export const PAYLOAD_TRANSACTION_FNS = [
  'initTransaction',
  'commitTransaction',
  'rollbackTransaction',
  'killTransaction',
] as const;

export const PAYLOAD_DB_ADAPTER_METHODS = [
  'find',
  'findOne',
  'create',
  'updateOne',
  'update',
  'deleteOne',
  'deleteMany',
  'deleteVersions',
  'count',
  'countVersions',
] as const;

export const PAYLOAD_DB_ADAPTER_MUTATE_METHODS = [
  'create',
  'updateOne',
  'update',
  'deleteOne',
  'deleteMany',
  'deleteVersions',
] as const;

export const PAYLOAD_LOCAL_API_METHODS = [
  'find',
  'findByID',
  'create',
  'update',
  'delete',
  'count',
  'findGlobal',
  'updateGlobal',
] as const;

export const PAYLOAD_LOCAL_API_MUTATE_METHODS = ['create', 'update', 'delete', 'updateGlobal'] as const;

export const PAYLOAD_MONGOOSE_METHODS = [
  'create',
  'find',
  'findOne',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'bulkWrite',
] as const;

export const PAYLOAD_SCHEMA_OBJECT_KEYS = ['collection', 'slug', 'global'] as const;

export const PAYLOAD_CONVENTIONS: ConventionSet = {
  framework: 'payload',
  fileRoles: [],
  baseExtensions: ['ts', 'tsx', 'js', 'jsx'],

  rules: [
    {
      id: 'payload.collection-config',
      roles: null,
      match: { kind: 'typedObjectVariable', typeNames: ['CollectionConfig'] },
      emit: {
        type: 'CONTRACT',
        entityType: 'PAYLOAD_COLLECTION',
        patternId: 'contract.payload-collection-config',
        name: 'Payload Collection: {name}',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-collection',
        specRef: 'PAT-EXT-28',
        description: '`const X: CollectionConfig = { ... }` declares a Payload collection contract.',
      },
    },
    {
      id: 'payload.global-config',
      roles: null,
      match: { kind: 'typedObjectVariable', typeNames: ['GlobalConfig'] },
      emit: {
        type: 'CONTRACT',
        entityType: 'PAYLOAD_GLOBAL',
        patternId: 'contract.payload-global-config',
        name: 'Payload Global: {name}',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-global',
        specRef: 'PAT-EXT-28',
        description: '`const X: GlobalConfig = { ... }` declares a Payload global contract.',
      },
    },
    {
      id: 'payload.block',
      roles: null,
      match: { kind: 'typedObjectVariable', typeNames: ['Block'] },
      emit: {
        type: 'CONTRACT',
        entityType: 'PAYLOAD_BLOCK',
        patternId: 'contract.payload-block-definition',
        name: 'Payload Block: {name}',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-blocks',
        specRef: 'PAT-EXT-28',
        description: '`const X: Block = { ... }` declares a Payload content block contract.',
      },
    },
    {
      id: 'payload.task',
      roles: null,
      match: { kind: 'typedObjectVariable', typeNames: ['TaskConfig'] },
      emit: {
        type: 'CONTRACT',
        entityType: 'PAYLOAD_TASK',
        patternId: 'contract.payload-job-task-definition',
        name: 'Payload Task: {name}',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-jobs',
        specRef: 'PAT-EXT-28',
        description: '`const X: TaskConfig = { ... }` declares a Payload background job task contract.',
      },
    },
    {
      id: 'payload.fields',
      roles: null,
      match: { kind: 'propertyAssignment', names: ['fields'], valueKind: 'array' },
      emit: {
        type: 'CONTRACT',
        entityType: 'PAYLOAD_FIELDS',
        patternId: 'contract.payload-field-definition',
        name: 'Payload Fields Array',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-collection',
        specRef: 'PAT-EXT-28',
        description: '`fields: [...]` inside a Payload config declares its schema fields contract.',
      },
    },
    {
      id: 'payload.endpoints',
      roles: null,
      match: { kind: 'propertyAssignment', names: ['endpoints'], valueKind: 'array' },
      emit: {
        type: 'CONTRACT',
        entityType: 'PAYLOAD_ENDPOINTS',
        patternId: 'contract.payload-endpoint-definition',
        name: 'Payload Endpoints Array',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-endpoints',
        specRef: 'PAT-EXT-28',
        description: '`endpoints: [...]` inside a Payload config declares custom REST endpoints.',
      },
    },
    {
      id: 'payload.access',
      roles: null,
      match: { kind: 'propertyAssignment', names: ['access'], valueKind: 'object' },
      emit: {
        type: 'CONTRACT',
        entityType: 'PAYLOAD_ACCESS',
        patternId: 'contract.payload-collection-access',
        name: 'Payload Access Control',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-global',
        specRef: 'PAT-EXT-28',
        description: '`access: { ... }` inside a Payload config declares its access control contract.',
      },
    },
    {
      id: 'payload.transaction',
      roles: null,
      match: { kind: 'callToIdentifier', names: PAYLOAD_TRANSACTION_FNS },
      emit: {
        type: 'OPEN_CONNECTOR',
        entityType: 'DB_TRANSACTION',
        patternId: 'open-connector.payload-transaction-lifecycle',
        name: 'Payload Transaction: {name}',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-transactions',
        specRef: 'PAT-EXT-28',
        description: 'Calls to `initTransaction` / `commitTransaction` / `rollbackTransaction` / `killTransaction`.',
      },
    },
    {
      id: 'payload.db-adapter-operation',
      roles: null,
      match: {
        kind: 'callToMember',
        receiverEndsWith: ['payload.db'],
        methods: PAYLOAD_DB_ADAPTER_METHODS,
        schemaObjectArg: {
          keys: PAYLOAD_SCHEMA_OBJECT_KEYS,
          mutateMethods: PAYLOAD_DB_ADAPTER_MUTATE_METHODS,
        },
      },
      emit: {
        type: 'OPEN_CONNECTOR',
        entityType: 'DB_OPERATION',
        patternId: 'open-connector.payload-db-adapter-operation',
        name: 'Payload DB Adapter: {method}',
        companionRelationship: {
          entityType: '{relType}',
          patternId: 'relationship.payload-{relTypeLower}',
          name: '{relType} Payload Schema: {schema}',
          targetContract: {
            idScope: 'Payload Collection: {schema}',
            contractName: 'Payload Collection: {schema}',
          },
        },
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-db-adapter',
        specRef: 'PAT-EXT-28',
        description:
          'Direct `payload.db.<method>({ collection })` adapter operation, paired with a `READS`/`MUTATES` schema relationship.',
      },
    },
    {
      id: 'payload.job-dispatch',
      roles: null,
      match: {
        kind: 'callToMember',
        receiverEndsWith: ['payload.jobs'],
        methods: ['queue'],
      },
      emit: {
        type: 'OPEN_CONNECTOR',
        entityType: 'JOB_DISPATCH',
        patternId: 'open-connector.payload-job-dispatch',
        name: 'Payload Job Queue: {callee}',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-job-dispatch',
        specRef: 'PAT-EXT-28',
        description: '`payload.jobs.queue(...)` / `req.payload.jobs.queue(...)` dispatches a background job.',
      },
    },
    {
      id: 'payload.local-api-call',
      roles: null,
      match: {
        kind: 'callToMember',
        receivers: ['payload'],
        methods: PAYLOAD_LOCAL_API_METHODS,
        schemaObjectArg: {
          keys: PAYLOAD_SCHEMA_OBJECT_KEYS,
          mutateMethods: PAYLOAD_LOCAL_API_MUTATE_METHODS,
        },
      },
      emit: {
        type: 'OPEN_CONNECTOR',
        entityType: 'LOCAL_API_CALL',
        patternId: 'open-connector.payload-local-api-call',
        name: 'Payload Local API: {method}',
        companionRelationship: {
          entityType: '{relType}',
          patternId: 'relationship.payload-{relTypeLower}',
          name: '{relType} Payload {targetKind}: {schema}',
          targetContract: {
            idScope: 'Payload {targetKind}: {schema}',
            contractName: 'Payload {targetKind}: {schema}',
          },
        },
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-open-connectors',
        specRef: 'PAT-EXT-28',
        description:
          '`payload.<find|create|update|delete|findGlobal|updateGlobal>({ collection | global })` local API call, paired with a `READS`/`MUTATES` schema relationship.',
      },
    },
    {
      id: 'payload.mongoose-operation',
      roles: null,
      match: {
        kind: 'callToMember',
        receivers: ['Model'],
        methods: PAYLOAD_MONGOOSE_METHODS,
      },
      emit: {
        type: 'OPEN_CONNECTOR',
        entityType: 'DB_OPERATION',
        patternId: 'open-connector.payload-mongoose-operation',
        name: 'Mongoose DB Operation: {method}',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-open-connectors',
        specRef: 'PAT-EXT-28',
        description: '`Model.<method>(...)` Mongoose model operation inside Payload.',
      },
    },
  ],

  edgeRules: [
    {
      id: 'payload.hook-registration',
      match: { kind: 'propertyArrayElements', names: PAYLOAD_HOOK_NAMES },
      target: [{ kind: 'syntheticContract', idScope: 'function:{target}', contractName: 'Function: {target}' }],
      emit: {
        entityType: 'HOOK_REGISTRATION',
        patternId: 'relationship.payload-hook-registration',
        name: 'Payload Hook: {propName} -> {target}',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-hooks',
        specRef: 'PAT-EXT-28',
        description: 'Hook array registration (`beforeChange: [fn]`, `afterRead: [fn]`, ...).',
      },
    },
    {
      id: 'payload.config-registry-collection',
      match: { kind: 'propertyArrayElements', names: ['collections'], enclosingCall: 'buildConfig' },
      target: [
        {
          kind: 'syntheticContract',
          idScope: 'Payload Collection: {target}',
          contractName: 'Payload Collection: {target}',
        },
      ],
      emit: {
        entityType: 'REGISTRY_MOUNT',
        patternId: 'relationship.payload-config-registry',
        name: 'Payload Config Registry: {target}',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-registry',
        specRef: 'PAT-EXT-28',
        description: '`buildConfig({ collections: [Posts] })` mounts collection contracts into the Payload config.',
      },
    },
    {
      id: 'payload.config-registry-global',
      match: { kind: 'propertyArrayElements', names: ['globals'], enclosingCall: 'buildConfig' },
      target: [
        {
          kind: 'syntheticContract',
          idScope: 'Payload Global: {target}',
          contractName: 'Payload Global: {target}',
        },
      ],
      emit: {
        entityType: 'REGISTRY_MOUNT',
        patternId: 'relationship.payload-config-registry',
        name: 'Payload Config Registry: {target}',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-registry',
        specRef: 'PAT-EXT-28',
        description: '`buildConfig({ globals: [Header] })` mounts global contracts into the Payload config.',
      },
    },
    {
      id: 'payload.plugin-registration',
      match: {
        kind: 'propertyArrayElements',
        names: ['plugins'],
        allowCallElements: true,
        enclosingCall: 'buildConfig',
      },
      target: ['unlinked'],
      emit: {
        entityType: 'PLUGIN_REGISTRATION',
        patternId: 'relationship.payload-plugin-registration',
        name: 'Payload Plugin: {target}',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'payload',
        fixture: 'payload-plugins',
        specRef: 'PAT-EXT-28',
        description: '`buildConfig({ plugins: [seoPlugin(...)] })` registers Payload plugins.',
      },
    },
  ],

  derivers: {},
  escapeHatches: [],
};
