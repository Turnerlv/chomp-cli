// packages/core/src/extractor/conventions/mcp.ts
//
// Model Context Protocol (MCP) server conventions, as DATA (`[PAT-EXT-12]`, `[PAT-EXT-28]`).
// Replaces the hand-written AST matching in `adapters/mcpAdapter.ts`.

import type { ConventionSet } from './types.js';

export const MCP_CONVENTIONS: ConventionSet = {
  framework: 'mcp',
  fileRoles: [],
  baseExtensions: ['ts', 'tsx', 'js', 'jsx'],

  rules: [
    {
      id: 'mcp.tool',
      roles: null,
      match: {
        kind: 'callToMember',
        methods: ['tool', 'registerTool', 'resource', 'registerResource', 'prompt', 'registerPrompt'],
        minArgs: 2,
        arg0: 'stringLiteral',
      },
      emit: {
        type: 'CONTRACT',
        entityType: 'MCP_TOOL',
        patternId: 'contract.mcp-tool',
        name: 'MCP Tool: {arg0}',
        companionRelationship: {
          entityType: 'REGISTERS',
          patternId: 'relationship.mcp-tool-register',
          name: 'Registers Tool: {arg0}',
        },
      },
      meta: {
        framework: 'mcp',
        fixture: 'mcp-tool-ownership',
        specRef: 'PAT-EXT-12',
        description:
          '`server.tool(name, ..., handler)` declares an MCP tool endpoint contract and emits a `REGISTERS` edge from the enclosing scope.',
      },
    },
  ],

  derivers: {},
  escapeHatches: [],
};
