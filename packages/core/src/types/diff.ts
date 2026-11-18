import { StructuralNode, StructuralEdge } from './ontology.js';

export type DiffStatus = 'ADDED' | 'REMOVED' | 'MODIFIED' | 'UNCHANGED' | 'LEXICAL_SHIFT';

export interface DiffNode {
  status: DiffStatus;
  base?: StructuralNode;
  target?: StructuralNode;
}

export interface DiffEdge {
  status: DiffStatus;
  base?: StructuralEdge;
  target?: StructuralEdge;
}

export interface BaseStalenessReason {
  code:
    | 'BASE_COMMIT_BEHIND_HEAD'
    | 'ANALYZED_BEFORE_HEAD'
    | 'EXTRACTOR_VERSION_MISMATCH'
    | 'DIRTY_BASE_SNAPSHOT';
  message: string;
}

export interface GraphDelta {
  baseCommitSha?: string;
  targetCommitSha?: string;
  headCommitSha?: string;
  baseExtractorVersion?: string;
  targetExtractorVersion?: string;
  baseStatus?: 'FRESH' | 'STALE';
  stalenessReasons?: BaseStalenessReason[];
  nodes: Record<string, DiffNode>;
  edges: Record<string, DiffEdge>;
}
