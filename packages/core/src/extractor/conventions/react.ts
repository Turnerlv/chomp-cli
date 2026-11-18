// packages/core/src/extractor/conventions/react.ts
//
// React component conventions, as DATA (`[PAT-EXT-25]`):
//   1. a higher-order-component-wrapped export is a component contract
//        export const Card = memo(function Card() {...})
//        export const Input = React.forwardRef((props, ref) => ...)
//   2. a JSX element naming a component exported from the SAME file is a RENDERS relationship
//
// Framework-agnostic: nothing here is specific to Next.js, so it applies to any React codebase.

import type { ConventionSet } from './types.js';

/**
 * Higher-order wrappers whose first argument is the component function they wrap. Single source of
 * truth: the node rule below AND same-file target resolution (`relationshipVisitor.ts`) read it, so
 * "what counts as a wrapped component" can never drift between the two.
 */
export const REACT_HOC_WRAPPERS = ['memo', 'React.memo', 'forwardRef', 'React.forwardRef'] as const;

/**
 * Memoizing / caching function wrappers (`React.cache`, `cache`, `unstable_cache`, `memoize`, etc.)
 * whose first argument is the function they wrap and export as an `EXPORTED_FUNCTION` contract.
 */
export const FUNCTION_MEMO_WRAPPERS = [
  'cache',
  'React.cache',
  'unstable_cache',
  'memoize',
  'lodash.memoize',
  '_.memoize',
  'once',
  'lodash.once',
  '_.once',
  'debounce',
  'lodash.debounce',
  '_.debounce',
  'throttle',
  'lodash.throttle',
  '_.throttle',
  'bind',
  'lodash.bind',
  '_.bind',
  'useCallback',
  'React.useCallback',
  'createParamDecorator',
  'asyncHandler',
  'expressAsyncHandler',
  'catchAsync',
  'Object.assign',
  'defineWebSocketHelper',
  'createMiddleware',
  'createFactory',
  'fp',
  'fastifyPlugin',
  'createAuthorizedRoute',
] as const;

export const REACT_CONVENTIONS: ConventionSet = {
  framework: 'react',
  fileRoles: [],
  baseExtensions: ['ts', 'tsx', 'js', 'jsx'],

  rules: [
    {
      id: 'react.hoc-wrapped-component',
      roles: null,
      match: { kind: 'exportedWrappedFunction', wrappers: REACT_HOC_WRAPPERS },
      emit: {
        type: 'CONTRACT',
        entityType: 'EXPORTED_FUNCTION',
        patternId: 'contract.react-hoc-wrapped-component',
        name: 'Exported Function: {name}',
      },
      meta: {
        framework: 'react',
        fixture: 'react-hoc-components',
        specRef: 'PAT-EXT-25',
        description:
          '`export const X = memo(fn)` / `React.forwardRef(fn)` (also nested) exports a component. The exported constant is the contract, and calls inside the wrapped function belong to it.',
      },
    },
  ],

  edgeRules: [
    {
      id: 'react.imported-component-render',
      match: { kind: 'jsxComponentElement', tagSyntax: 'identifier' },
      target: ['importedComponent'],
      emit: {
        entityType: 'RENDERS',
        patternId: 'relationship.jsx-element',
        name: 'Renders: <{tagName} />',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'react',
        fixture: 'react-hoc-components',
        specRef: 'PAT-EXT-25',
        description:
          'A JSX element whose Capitalized tag is statically imported from a local module renders that module’s exported component contract.',
      },
    },
    {
      id: 'react.dynamic-component-render',
      match: { kind: 'jsxComponentElement', tagSyntax: 'identifier' },
      target: ['lazyComponent'],
      emit: {
        entityType: 'RENDERS',
        patternId: 'relationship.jsx-dynamic-component',
        name: 'Renders: <{tagName} />',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'react',
        fixture: 'react-hoc-components',
        specRef: 'PAT-EXT-25',
        description:
          'A JSX element whose tag is bound via `React.lazy(() => import(...))` / `lazy(() => import(...))` renders the target component contract.',
      },
    },
    {
      id: 'react.same-file-component-render',
      match: { kind: 'jsxComponentElement', tagSyntax: 'identifier' },
      target: ['sameFileExport'],
      emit: {
        entityType: 'RENDERS',
        patternId: 'relationship.jsx-same-file-component',
        name: 'Renders: <{tagName} />',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'react',
        fixture: 'react-hoc-components',
        specRef: 'PAT-EXT-25',
        description:
          'A JSX element whose tag names a function or wrapped component exported from the same source file renders it, with no import to prove it. A tag with no proven same-file export yields no edge.',
      },
    },
    {
      id: 'react.namespaced-component-render',
      match: { kind: 'jsxComponentElement', tagSyntax: 'member' },
      target: ['namespacedComponent'],
      emit: {
        entityType: 'RENDERS',
        patternId: 'relationship.jsx-namespaced-element',
        name: 'Renders: <{tagName} />',
        status: 'DETERMINISTIC',
        confidence: 'HIGH',
      },
      meta: {
        framework: 'react',
        fixture: 'react-hoc-components',
        specRef: 'PAT-EXT-25',
        description:
          'A JSX property-access element (`<Form.Input />`) renders the proven target component contract via namespace import, compound object, or same-file export.',
      },
    },
  ],

  derivers: {},
  escapeHatches: [],
};
