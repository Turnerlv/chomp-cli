// packages/core/src/extractor/adapters/mcpAdapter.ts
// Model Context Protocol (MCP) server conventions (`[PAT-EXT-12]`, `[PAT-EXT-28]`).
//
// The conventions are DATA — see `../conventions/mcp.ts`. This file keeps the function signature
// the contract visitor calls and delegates to the table.

import ts from 'typescript';
import { EvidenceRecord, StructuralEntity } from '../../types/index.js';
import { MCP_CONVENTIONS } from '../conventions/mcp.js';
import { applyConventionRules } from '../conventions/engine.js';

/**
 * Extracts MCP server tools as Contracts (plus companion `REGISTERS` relationships).
 * Matches: `server.tool("tool_name", ...)`
 */
export function extractMcpTool(
  node: ts.Node,
  getEvidence: (node: ts.Node) => EvidenceRecord,
  nextId: () => string
): StructuralEntity | StructuralEntity[] | null {
  const results = applyConventionRules(MCP_CONVENTIONS, ['mcp.tool'], node, null, '', getEvidence, nextId);
  if (results.length === 0) return null;
  return results.length === 1 ? results[0] : results;
}
