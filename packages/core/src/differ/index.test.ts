import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareGraphs } from './index.js';
import { RepresentationGraph } from '../types/ontology.js';

describe('compareGraphs', () => {
  const baseGraph: RepresentationGraph = {
    extractorVersion: '1.0.0',
    analyzedAt: '2026-09-06',
    nodes: [
      { id: '1', name: 'App', type: 'BOUNDARY', entityType: 'CLASS', patternId: 'cls', evidence: [] },
      { id: '2', name: 'removedNode', type: 'CONTRACT', entityType: 'FN', patternId: 'fn', evidence: [] },
      { id: '3', name: 'modifiedNode', type: 'CONTRACT', entityType: 'FN', patternId: 'fn', evidence: [{ filePath: 'file.ts', lineNumber: 1 }] },
    ],
    edges: [
      { id: 'e1', name: 'call', type: 'RELATIONSHIP', entityType: 'CALL', patternId: 'call', sourceId: '1', targetId: '2', evidence: [] },
    ]
  };

  const currentGraph: RepresentationGraph = {
    extractorVersion: '1.0.0',
    analyzedAt: '2026-09-06',
    nodes: [
      { id: '1', name: 'App', type: 'BOUNDARY', entityType: 'CLASS', patternId: 'cls', evidence: [] }, // Unchanged
      { id: '3', name: 'modifiedNode', type: 'CONTRACT', entityType: 'FN', patternId: 'fn', evidence: [{ filePath: 'file.ts', lineNumber: 5 }] }, // Modified (line changed)
      { id: '4', name: 'addedNode', type: 'CONTRACT', entityType: 'FN', patternId: 'fn', evidence: [] }, // Added
    ],
    edges: [
      { id: 'e2', name: 'call', type: 'RELATIONSHIP', entityType: 'CALL', patternId: 'call', sourceId: '1', targetId: '3', evidence: [] }, // Added edge
    ]
  };

  it('should identify UNCHANGED, REMOVED, MODIFIED, and ADDED nodes', () => {
    const diff = compareGraphs(baseGraph, currentGraph);

    assert.equal(diff.nodes['1']?.status, 'UNCHANGED');
    assert.equal(diff.nodes['2']?.status, 'REMOVED');
    assert.equal(diff.nodes['3']?.status, 'LEXICAL_SHIFT'); // line number drifting triggers LEXICAL_SHIFT
    assert.equal(diff.nodes['4']?.status, 'ADDED');
    
    // Check that base and target are correctly assigned
    assert.equal(diff.nodes['2'].base?.name, 'removedNode');
    assert.equal(diff.nodes['4'].target?.name, 'addedNode');
  });

  it('should identify UNCHANGED, REMOVED, MODIFIED, and ADDED edges', () => {
    const diff = compareGraphs(baseGraph, currentGraph);
    
    assert.equal(diff.edges['e1']?.status, 'REMOVED');
    assert.equal(diff.edges['e2']?.status, 'ADDED');
  });
  describe('evidence normalization', () => {
    const ev = (filePath: string, lineNumber: number, evidenceRole: string, snippet = 'x()') =>
      ({ filePath, lineNumber, evidenceRole, snippet }) as any;

    const graphWithEdgeEvidence = (evidence: any[]): RepresentationGraph => ({
      extractorVersion: '1.0.0',
      analyzedAt: '2026-09-06',
      nodes: [],
      edges: [
        { id: 'e1', name: 'call', type: 'RELATIONSHIP', entityType: 'CALL', patternId: 'call', sourceId: '1', targetId: '2', evidence },
      ],
    });

    it('treats duplicated evidence records as UNCHANGED against a deduplicated graph', () => {
      const deduped = graphWithEdgeEvidence([ev('a.ts', 3, 'call-site'), ev('b.ts', 9, 'target-signature')]);
      const duplicated = graphWithEdgeEvidence([
        ev('a.ts', 3, 'call-site'),
        ev('a.ts', 3, 'call-site'),
        ev('b.ts', 9, 'target-signature'),
        ev('b.ts', 9, 'target-signature'),
      ]);

      assert.equal(compareGraphs(deduped, duplicated).edges['e1']?.status, 'UNCHANGED');
      assert.equal(compareGraphs(duplicated, deduped).edges['e1']?.status, 'UNCHANGED');
    });

    it('is insensitive to evidence ordering', () => {
      const a = graphWithEdgeEvidence([ev('a.ts', 3, 'call-site'), ev('b.ts', 9, 'target-signature')]);
      const b = graphWithEdgeEvidence([ev('b.ts', 9, 'target-signature'), ev('a.ts', 3, 'call-site')]);

      assert.equal(compareGraphs(a, b).edges['e1']?.status, 'UNCHANGED');
    });

    it('still reports MODIFIED when a distinct evidence record is added', () => {
      const a = graphWithEdgeEvidence([ev('a.ts', 3, 'call-site')]);
      const b = graphWithEdgeEvidence([ev('a.ts', 3, 'call-site'), ev('b.ts', 9, 'target-signature')]);

      assert.equal(compareGraphs(a, b).edges['e1']?.status, 'MODIFIED');
    });

    it('merges duplicate-id edges without double counting identical evidence', () => {
      const base = graphWithEdgeEvidence([ev('a.ts', 3, 'call-site')]);
      const current = graphWithEdgeEvidence([ev('a.ts', 3, 'call-site')]);
      current.edges.push({ ...current.edges[0], evidence: [ev('a.ts', 3, 'call-site')] });

      assert.equal(compareGraphs(base, current).edges['e1']?.status, 'UNCHANGED');
    });

    it('ignores semantic enrichment metadata keys and key ordering when comparing nodes', () => {
      const base: RepresentationGraph = {
        extractorVersion: '1.0.0',
        analyzedAt: '2026-09-06',
        nodes: [
          {
            id: 'n1',
            name: 'Exported Function: runStoryTracer',
            type: 'CONTRACT',
            entityType: 'EXPORTED_FUNCTION',
            patternId: 'contract.exported-function',
            evidence: [{ filePath: 'a.ts', lineNumber: 10, snippet: 'export function runStoryTracer()' }],
            metadata: {
              runtime: 'client',
              inputTypes: ['RepresentationGraph', 'GraphDelta'],
              domain: 'visualizer',
              humanLabel: 'Story Tracer',
              summary: 'Traces stories',
            },
          },
        ],
        edges: [],
      };
      const current: RepresentationGraph = {
        extractorVersion: '1.0.0',
        analyzedAt: '2026-09-06',
        nodes: [
          {
            id: 'n1',
            name: 'Exported Function: runStoryTracer',
            type: 'CONTRACT',
            entityType: 'EXPORTED_FUNCTION',
            patternId: 'contract.exported-function',
            evidence: [{ filePath: 'a.ts', lineNumber: 10, snippet: 'export function runStoryTracer()' }],
            metadata: {
              inputTypes: ['RepresentationGraph', 'GraphDelta'],
              runtime: 'client',
            },
          },
        ],
        edges: [],
      };

      assert.equal(compareGraphs(base, current).nodes['n1']?.status, 'UNCHANGED');
    });
  });

  describe('shape key metadata (v5 Loop 1/3)', () => {
    const edgeWith = (metadata?: Record<string, any>): RepresentationGraph => ({
      extractorVersion: '1.0.0',
      analyzedAt: '2026-11-01',
      nodes: [],
      edges: [
        {
          id: 'e1',
          name: 'Call: client.fetchAll()',
          type: 'RELATIONSHIP',
          entityType: 'CALL',
          patternId: 'relationship.invoke-returned-function',
          sourceId: 's1',
          evidence: [{ filePath: 'a.ts', lineNumber: 5, snippet: 'client.fetchAll()' }],
          ...(metadata ? { metadata } : {}),
        },
      ],
    });

    it('does not report MODIFIED when a shape key appears only because the extractor was upgraded', () => {
      const base = edgeWith();
      const current = edgeWith({ shapeKey: 'sk1/CALL/LocalFromCall/Prop(Id)' });
      assert.equal(compareGraphs(base, current).edges['e1']?.status, 'UNCHANGED');
      assert.equal(compareGraphs(current, base).edges['e1']?.status, 'UNCHANGED');
    });

    it('reports MODIFIED when a present shape key changes (the receiver binding really changed)', () => {
      const base = edgeWith({ shapeKey: 'sk1/CALL/LocalFromCall/Prop(Id)' });
      const current = edgeWith({ shapeKey: 'sk1/CALL/Param/Prop(Id)' });
      assert.equal(compareGraphs(base, current).edges['e1']?.status, 'MODIFIED');
    });

    it('still reports MODIFIED for a real metadata change that coincides with a new shape key', () => {
      const base = edgeWith({ confidenceNote: 'a' });
      const current = edgeWith({ confidenceNote: 'b', shapeKey: 'sk1/CALL/Param/Id' });
      assert.equal(compareGraphs(base, current).edges['e1']?.status, 'MODIFIED');
    });
  });
});
