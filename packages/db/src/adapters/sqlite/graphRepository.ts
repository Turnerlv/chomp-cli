// packages/core/src/db/graphRepository.ts
// Persistence layer for RepresentationGraph — save and retrieve structural entities per repository.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  EntityType,
  EvidenceRecord,
  RepresentationGraph,
  StructuralNode,
  StructuralEdge,
} from '@chomp/core';

import {
  EntityOverlayFilter,
  EntityOverlayInput,
  EntityOverlayRecord,
  GraphIntegrityReport,
  OverlayDerivation,
  OverlayEvidenceItem,
  OverlayInputDependency,
  PruneEntityOverlaysFilter,
  RepositoryInfo,
  ScopeOptions,
  UpsertEntityOverlaysOptions,
} from '../../interface.js';

import { createHash } from 'crypto';

const NON_AST_SEMANTIC_KEYS = ['domain', 'humanLabel', 'summary', 'rationale', 'flags'] as const;

function splitAstAndOverlayMetadata(
  rawMeta?: Record<string, any>
): {
  astMeta: Record<string, any>;
  semanticOverlay: Record<string, any>;
  runtimeTelemetry: Record<string, any> | null;
} {
  const astMeta: Record<string, any> = {};
  const semanticOverlay: Record<string, any> = {};
  let runtimeTelemetry: Record<string, any> | null = null;

  if (!rawMeta || typeof rawMeta !== 'object') {
    return { astMeta, semanticOverlay, runtimeTelemetry };
  }

  for (const [k, v] of Object.entries(rawMeta)) {
    if (v === undefined) continue;
    if ((NON_AST_SEMANTIC_KEYS as readonly string[]).includes(k)) {
      semanticOverlay[k] = v;
    } else if (k === 'telemetry' && typeof v === 'object' && v !== null) {
      runtimeTelemetry = v;
    } else {
      astMeta[k] = v;
    }
  }

  return { astMeta, semanticOverlay, runtimeTelemetry };
}

/**
 * Persists a RepresentationGraph to the database under the given repository.
 *
 * Strategy:
 * - Upserts the repository row (safe to call repeatedly on re-runs).
 * - Deletes all existing structural_entities for this repo (cascades to nodes, edges, evidence_records).
 * - Preserves `entity_overlays` rows across re-extractions (`[PAT-DB-03]`, `[PAT-DB-04]`).
 * - Re-inserts all entities from the new graph in a single transaction with strictly pure AST metadata.
 */
export function saveRepresentationGraph(
  db: Database.Database,
  repo: RepositoryInfo,
  graph: RepresentationGraph
): void {
  const saveTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO repositories (id, name, path, analyzed_at, extractor_version, commit_sha, branch_name, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        analyzed_at = excluded.analyzed_at,
        extractor_version = excluded.extractor_version,
        commit_sha = excluded.commit_sha,
        branch_name = excluded.branch_name,
        project_id = excluded.project_id
    `).run(repo.id, repo.name, repo.path, graph.analyzedAt, repo.extractorVersion ?? graph.extractorVersion ?? null, repo.commitSha ?? null, repo.branchName ?? null, repo.projectId ?? null);

    db.prepare('DELETE FROM structural_entities WHERE repository_id = ?').run(repo.id);

    const insertStructuralEntity = db.prepare(`
      INSERT OR IGNORE INTO structural_entities (id, repository_id)
      VALUES (?, ?)
    `);

    const insertNode = db.prepare(`
      INSERT OR IGNORE INTO nodes (id, repository_id, name, type, entity_type, pattern_id, scope, parent_boundary_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEdge = db.prepare(`
      INSERT OR IGNORE INTO edges (id, repository_id, name, type, entity_type, pattern_id, scope, source_id, target_id, status, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEvidence = db.prepare(`
      INSERT OR IGNORE INTO evidence_records (id, entity_id, file_path, line_number, snippet, evidence_role)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const node of graph.nodes) {
      const { astMeta, semanticOverlay, runtimeTelemetry } = splitAstAndOverlayMetadata(node.metadata);
      const metadataStr = Object.keys(astMeta).length > 0 ? JSON.stringify(astMeta) : null;
      insertStructuralEntity.run(node.id, repo.id);
      insertNode.run(node.id, repo.id, node.name, node.type, node.entityType, node.patternId, node.scope ?? 'USER', node.parentBoundaryId ?? null, metadataStr);

      const bodyHash = typeof astMeta.bodyHash === 'string' ? astMeta.bodyHash : null;
      if (Object.keys(semanticOverlay).length > 0) {
        upsertEntityOverlaySync(db, {
          repositoryId: repo.id,
          entityId: node.id,
          layer: 'L1_SEMANTIC',
          source: 'chomp_enrich_nodes',
          environment: 'default',
          payload: semanticOverlay,
          bodyHash,
          merge: true,
        });
      }
      if (runtimeTelemetry && Object.keys(runtimeTelemetry).length > 0) {
        upsertEntityOverlaySync(db, {
          repositoryId: repo.id,
          entityId: node.id,
          layer: 'L2_RUNTIME',
          source: 'runtime_telemetry',
          environment: 'default',
          payload: { telemetry: runtimeTelemetry },
          bodyHash,
          merge: true,
        });
      }
      
      const evidences = Array.isArray(node.evidence) ? node.evidence : [node.evidence];
      for (const ev of evidences) {
        if (ev) {
          const evidenceHashInput = `${node.id}:${ev.filePath}:${ev.lineNumber ?? ''}:${ev.evidenceRole ?? ''}`;
          const evidenceHash = createHash('sha256').update(evidenceHashInput).digest('hex').slice(0, 16);
          const evidenceId = `ev_${evidenceHash}`;
          insertEvidence.run(
            evidenceId,
            node.id,
            ev.filePath,
            ev.lineNumber ?? null,
            ev.snippet ?? null,
            ev.evidenceRole ?? null
          );
        }
      }
    }

    for (const edge of graph.edges) {
      const { astMeta, semanticOverlay, runtimeTelemetry } = splitAstAndOverlayMetadata(edge.metadata);
      const metadataStr = Object.keys(astMeta).length > 0 ? JSON.stringify(astMeta) : null;
      insertStructuralEntity.run(edge.id, repo.id);
      insertEdge.run(edge.id, repo.id, edge.name, edge.type, edge.entityType, edge.patternId, edge.scope ?? 'USER', edge.sourceId, edge.targetId ?? null, edge.status ?? null, edge.confidence ?? null, metadataStr);

      if (Object.keys(semanticOverlay).length > 0) {
        upsertEntityOverlaySync(db, {
          repositoryId: repo.id,
          entityId: edge.id,
          layer: 'L1_SEMANTIC',
          source: 'chomp_enrich_nodes',
          environment: 'default',
          payload: semanticOverlay,
          bodyHash: null,
          merge: true,
        });
      }
      if (runtimeTelemetry && Object.keys(runtimeTelemetry).length > 0) {
        upsertEntityOverlaySync(db, {
          repositoryId: repo.id,
          entityId: edge.id,
          layer: 'L2_RUNTIME',
          source: 'runtime_telemetry',
          environment: 'default',
          payload: { telemetry: runtimeTelemetry },
          bodyHash: null,
          merge: true,
        });
      }
      
      const evidences = Array.isArray(edge.evidence) ? edge.evidence : [edge.evidence];
      for (const ev of evidences) {
        if (ev) {
          const evidenceHashInput = `${edge.id}:${ev.filePath}:${ev.lineNumber ?? ''}:${ev.evidenceRole ?? ''}`;
          const evidenceHash = createHash('sha256').update(evidenceHashInput).digest('hex').slice(0, 16);
          const evidenceId = `ev_${evidenceHash}`;
          insertEvidence.run(
            evidenceId,
            edge.id,
            ev.filePath,
            ev.lineNumber ?? null,
            ev.snippet ?? null,
            ev.evidenceRole ?? null
          );
        }
      }
    }
  });

  saveTx();
}

/**
 * Retrieves a previously saved RepresentationGraph for the given repository.
 *
 * Reconstructs the full graph from the three DB tables (repositories, structural_entities, evidence_records).
 * Entity IDs are de-namespaced on read — the stored `${repoId}:${entity.id}` prefix is stripped
 * so callers receive the original stable content-hash IDs.
 *
 * @returns The RepresentationGraph, or null if the repository has not been analyzed yet.
 */
export function getRepresentationGraph(
  db: Database.Database,
  repoId: string,
  options: ScopeOptions = { scopes: ['USER'] }
): RepresentationGraph | null {
  const repoRow = db
    .prepare('SELECT id, name, path, analyzed_at, extractor_version, commit_sha, branch_name, project_id FROM repositories WHERE id = ?')
    .get(repoId) as
    | { id: string; name: string; path: string; analyzed_at: string; extractor_version: string | null; commit_sha: string | null; branch_name: string | null; project_id: string | null }
    | undefined;

  if (!repoRow) {
    return null;
  }

  const scopesStr = options.scopes?.length ? options.scopes.map(s => `'${s}'`).join(',') : "'USER'";
  const nodeRows = db
    .prepare(
      `SELECT id, name, type, entity_type, pattern_id, scope, parent_boundary_id, metadata FROM nodes WHERE repository_id = ? AND scope IN (${scopesStr})`
    )
    .all(repoId) as Array<{ id: string; name: string; type: EntityType; entity_type: string; pattern_id: string; scope: 'USER' | 'TEST' | 'MOCK' | 'CONFIG'; parent_boundary_id: string | null; metadata: string | null }>;

  const edgeRows = db
    .prepare(
      `SELECT id, name, type, entity_type, pattern_id, scope, source_id, target_id, status, confidence, metadata FROM edges WHERE repository_id = ? AND scope IN (${scopesStr})`
    )
    .all(repoId) as Array<{ id: string; name: string; type: EntityType; entity_type: string; pattern_id: string; scope: 'USER' | 'TEST' | 'MOCK' | 'CONFIG'; source_id: string; target_id: string | null; status: 'DETERMINISTIC' | 'INFERRED' | null; confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null; metadata: string | null }>;

  const evidenceRows = db
    .prepare(
      `
      SELECT er.entity_id, er.file_path, er.line_number, er.snippet, er.evidence_role
      FROM evidence_records er
      JOIN nodes n ON er.entity_id = n.id WHERE n.repository_id = ?
      UNION
      SELECT er.entity_id, er.file_path, er.line_number, er.snippet, er.evidence_role
      FROM evidence_records er
      JOIN edges e ON er.entity_id = e.id WHERE e.repository_id = ?
    `
    )
    .all(repoId, repoId) as Array<{
    entity_id: string;
    file_path: string;
    line_number: number | null;
    snippet: string | null;
    evidence_role: 'syntax-call' | 'import-match' | 'target-signature' | null;
  }>;

  const evidenceMap = new Map<string, EvidenceRecord[]>();
  for (const row of evidenceRows) {
    const record: EvidenceRecord = {
      filePath: row.file_path,
    };
    if (row.line_number !== null && row.line_number !== undefined) {
      record.lineNumber = row.line_number;
    }
    if (row.snippet !== null && row.snippet !== undefined) {
      record.snippet = row.snippet;
    }
    if (row.evidence_role !== null && row.evidence_role !== undefined) {
      record.evidenceRole = row.evidence_role;
    }
    const cleanEntityId = row.entity_id;
      
    if (!evidenceMap.has(cleanEntityId)) {
      evidenceMap.set(cleanEntityId, []);
    }
    evidenceMap.get(cleanEntityId)!.push(record);
  }

  const nodes: StructuralNode[] = [];
  const edges: StructuralEdge[] = [];

  for (const row of nodeRows) {
    const cleanId = row.id;
    const evidenceArray = evidenceMap.get(cleanId) ?? [];
    const evidence = evidenceArray.length === 1 ? evidenceArray[0] : (evidenceArray.length > 1 ? evidenceArray : { filePath: '' });
    const node: StructuralNode = {
      id: cleanId,
      name: row.name,
      type: row.type as 'BOUNDARY' | 'CONTRACT' | 'OPEN_CONNECTOR',
      entityType: row.entity_type,
      patternId: row.pattern_id,
      scope: row.scope,
      evidence,
    };
    
    if (row.parent_boundary_id) node.parentBoundaryId = row.parent_boundary_id;
    if (row.metadata) {
      try {
        node.metadata = JSON.parse(row.metadata);
      } catch (e) {}
    }
    nodes.push(node);
  }

  const nodeIdSet = new Set<string>(nodes.map((n) => n.id));

  for (const row of edgeRows) {
    const cleanId = row.id;
    const evidenceArray = evidenceMap.get(cleanId) ?? [];
    const evidence = evidenceArray.length === 1 ? evidenceArray[0] : (evidenceArray.length > 1 ? evidenceArray : { filePath: '' });
    const edge: StructuralEdge = {
      id: cleanId,
      name: row.name,
      type: row.type as 'RELATIONSHIP',
      entityType: row.entity_type,
      patternId: row.pattern_id,
      scope: row.scope,
      evidence,
      sourceId: row.source_id,
    };
    
    if (row.target_id && nodeIdSet.has(row.target_id)) edge.targetId = row.target_id;
    if (row.status) edge.status = row.status as any;
    if (row.confidence) edge.confidence = row.confidence as any;
    if (row.metadata) {
      try {
        edge.metadata = JSON.parse(row.metadata);
      } catch (e) {}
    }
    edges.push(edge);
  }

  const result: RepresentationGraph = {
    extractorVersion: repoRow.extractor_version ?? '1.0.0',
    analyzedAt: repoRow.analyzed_at,
    nodes,
    edges,
  };

  if (repoRow.commit_sha) {
    result.commitSha = repoRow.commit_sha;
  }
  if (repoRow.branch_name) {
    result.branchName = repoRow.branch_name;
  }

  return result;
}

export function listRepositories(db: Database.Database): Promise<RepositoryInfo[]> {
  const rows = db.prepare('SELECT id, name, path, analyzed_at, extractor_version, commit_sha, branch_name, project_id FROM repositories').all();
  // Map the snake_case DB columns back to the camelCase RepositoryInfo interface
  const repos = rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    path: row.path,
    analyzedAt: row.analyzed_at,
    extractorVersion: row.extractor_version,
    commitSha: row.commit_sha,
    branchName: row.branch_name,
    projectId: row.project_id
  }));
  return Promise.resolve(repos);
}

function resolveEntityRepoAndBodyHash(
  db: Database.Database,
  entityId: string,
  explicitRepoId?: string
): { repositoryId?: string; repoPath: string | null; bodyHash: string | null } {
  const nodeRow = db
    .prepare(
      `SELECT n.repository_id, n.metadata, r.path AS repo_path
       FROM nodes n
       LEFT JOIN repositories r ON r.id = n.repository_id
       WHERE n.id = ?`
    )
    .get(entityId) as
    | { repository_id: string; metadata: string | null; repo_path: string | null }
    | undefined;
  if (nodeRow) {
    let bodyHash: string | null = null;
    if (nodeRow.metadata) {
      try {
        const parsed = JSON.parse(nodeRow.metadata);
        if (typeof parsed?.bodyHash === 'string') {
          bodyHash = parsed.bodyHash;
        }
      } catch {}
    }
    return {
      repositoryId: nodeRow.repository_id,
      repoPath: nodeRow.repo_path ?? null,
      bodyHash,
    };
  }

  const edgeRow = db
    .prepare(
      `SELECT e.repository_id, r.path AS repo_path
       FROM edges e
       LEFT JOIN repositories r ON r.id = e.repository_id
       WHERE e.id = ?`
    )
    .get(entityId) as { repository_id: string; repo_path: string | null } | undefined;
  if (edgeRow) {
    return {
      repositoryId: edgeRow.repository_id,
      repoPath: edgeRow.repo_path ?? null,
      bodyHash: null,
    };
  }

  if (explicitRepoId) {
    const explicitRepo = db
      .prepare('SELECT id, path FROM repositories WHERE id = ?')
      .get(explicitRepoId) as { id: string; path: string } | undefined;
    if (explicitRepo) {
      return {
        repositoryId: explicitRepo.id,
        repoPath: explicitRepo.path ?? null,
        bodyHash: null,
      };
    }
  }

  const repoRow = db
    .prepare('SELECT id, path FROM repositories LIMIT 1')
    .get() as { id: string; path: string } | undefined;
  return {
    repositoryId: repoRow?.id,
    repoPath: repoRow?.path ?? null,
    bodyHash: null,
  };
}

function normalizeDerivation(
  derivation: unknown,
  layer: string,
  source: string,
  fallback?: OverlayDerivation
): OverlayDerivation {
  if (
    derivation === 'EXTRACTED' ||
    derivation === 'INFERRED' ||
    derivation === 'AI_HYPOTHESIS'
  ) {
    return derivation;
  }
  if (fallback) return fallback;
  if (layer === 'L1_PORTS' || source === 'extractor') {
    return 'EXTRACTED';
  }
  return 'AI_HYPOTHESIS';
}

export function pruneEntityOverlaysSync(
  db: Database.Database,
  filter: PruneEntityOverlaysFilter
): number {
  const layer = (filter.layer || 'L1_SEMANTIC').trim();
  const source = (filter.source || 'chomp_enrich_nodes').trim();
  const environment = (filter.environment || 'default').trim();
  const activeRunId = filter.activeRunId.trim();
  if (!filter.repositoryId || !activeRunId) return 0;

  const info = db
    .prepare(
      `DELETE FROM entity_overlays
       WHERE repository_id = ?
         AND layer = ?
         AND source = ?
         AND environment = ?
         AND (run_id IS NULL OR run_id != ?)`
    )
    .run(filter.repositoryId, layer, source, environment, activeRunId);
  return info.changes;
}

export function upsertEntityOverlaySync(
  db: Database.Database,
  overlay: EntityOverlayInput
): void {
  const resolved = resolveEntityRepoAndBodyHash(
    db,
    overlay.entityId,
    overlay.repositoryId
  );
  const repositoryId = overlay.repositoryId ?? resolved.repositoryId;
  if (!repositoryId) return;

  const layer = (overlay.layer || 'L1_SEMANTIC').trim();
  const source = (overlay.source || 'chomp_enrich_nodes').trim();
  const environment = (overlay.environment || 'default').trim();
  // Null-safe body_hash fallback ([PAT-DB-05]): both undefined and explicit null
  // resolve from the entity's current nodes.metadata.bodyHash.
  const bodyHash = overlay.bodyHash ?? resolved.bodyHash;

  const existing = db
    .prepare(
      `SELECT payload, derivation, inputs, evidence, run_id
       FROM entity_overlays
       WHERE entity_id = ? AND layer = ? AND source = ? AND environment = ?`
    )
    .get(overlay.entityId, layer, source, environment) as
    | {
        payload: string;
        derivation: string | null;
        inputs: string | null;
        evidence: string | null;
        run_id: string | null;
      }
    | undefined;

  let finalPayload: Record<string, any> = { ...(overlay.payload || {}) };
  if (overlay.merge !== false && existing?.payload) {
    try {
      const parsedExisting = JSON.parse(existing.payload);
      if (parsedExisting && typeof parsedExisting === 'object') {
        finalPayload = { ...parsedExisting, ...finalPayload };
      }
    } catch {}
  }

  const existingDerivation =
    existing?.derivation === 'EXTRACTED' ||
    existing?.derivation === 'INFERRED' ||
    existing?.derivation === 'AI_HYPOTHESIS'
      ? existing.derivation
      : undefined;
  const derivation = normalizeDerivation(
    overlay.derivation,
    layer,
    source,
    existingDerivation
  );

  let inputsJson: string | null = existing?.inputs ?? null;
  if (overlay.inputs !== undefined) {
    if (Array.isArray(overlay.inputs) && overlay.inputs.length > 0) {
      const normalizedInputs: OverlayInputDependency[] = [];
      for (const item of overlay.inputs) {
        if (!item || typeof item.path !== 'string' || !item.path.trim()) continue;
        let hash = typeof item.hash === 'string' ? item.hash.trim() : '';
        if (!hash && resolved.repoPath) {
          const candidatePath = path.isAbsolute(item.path)
            ? item.path
            : path.resolve(resolved.repoPath, item.path);
          if (fs.existsSync(candidatePath)) {
            try {
              hash = createHash('sha256')
                .update(fs.readFileSync(candidatePath))
                .digest('hex')
                .slice(0, 16);
            } catch {}
          }
        }
        normalizedInputs.push({ path: item.path.trim(), hash });
      }
      inputsJson = normalizedInputs.length > 0 ? JSON.stringify(normalizedInputs) : null;
    } else {
      inputsJson = null;
    }
  }

  let evidenceJson: string | null = existing?.evidence ?? null;
  if (overlay.evidence !== undefined) {
    if (Array.isArray(overlay.evidence) && overlay.evidence.length > 0) {
      const normalizedEvidence: OverlayEvidenceItem[] = [];
      for (const ev of overlay.evidence) {
        if (!ev || typeof ev.filePath !== 'string' || !ev.filePath.trim()) continue;
        normalizedEvidence.push({
          filePath: ev.filePath.trim(),
          ...(typeof ev.lineNumber === 'number' ? { lineNumber: ev.lineNumber } : {}),
          ...(typeof ev.snippet === 'string' ? { snippet: ev.snippet } : {}),
          ...(typeof ev.evidenceRole === 'string'
            ? { evidenceRole: ev.evidenceRole }
            : {}),
        });
      }
      evidenceJson =
        normalizedEvidence.length > 0 ? JSON.stringify(normalizedEvidence) : null;
    } else {
      evidenceJson = null;
    }
  }

  const runId =
    overlay.runId !== undefined
      ? typeof overlay.runId === 'string' && overlay.runId.trim()
        ? overlay.runId.trim()
        : null
      : existing?.run_id ?? null;

  db.prepare(`
    INSERT INTO entity_overlays (
      repository_id, entity_id, layer, source, environment,
      payload, body_hash, derivation, inputs, evidence, run_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(entity_id, layer, source, environment) DO UPDATE SET
      repository_id = excluded.repository_id,
      payload = excluded.payload,
      body_hash = COALESCE(excluded.body_hash, entity_overlays.body_hash),
      derivation = excluded.derivation,
      inputs = excluded.inputs,
      evidence = excluded.evidence,
      run_id = excluded.run_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    repositoryId,
    overlay.entityId,
    layer,
    source,
    environment,
    JSON.stringify(finalPayload),
    bodyHash ?? null,
    derivation,
    inputsJson,
    evidenceJson,
    runId
  );

  if (runId && overlay.pruneStaleBySource) {
    pruneEntityOverlaysSync(db, {
      repositoryId,
      layer,
      source,
      environment,
      activeRunId: runId,
    });
  }
}

export function upsertEntityOverlaysSync(
  db: Database.Database,
  overlays: EntityOverlayInput[],
  options?: UpsertEntityOverlaysOptions
): void {
  const scopesToPrune = new Map<string, PruneEntityOverlaysFilter>();

  const tx = db.transaction(() => {
    for (const rawItem of overlays) {
      const item: EntityOverlayInput = {
        ...rawItem,
        repositoryId: rawItem.repositoryId ?? options?.repositoryId,
        layer: (rawItem.layer ?? options?.layer ?? 'L1_SEMANTIC').trim(),
        source: (rawItem.source ?? options?.source ?? 'chomp_enrich_nodes').trim(),
        environment: (rawItem.environment ?? options?.environment ?? 'default').trim(),
        runId: rawItem.runId ?? options?.runId,
      };
      upsertEntityOverlaySync(db, { ...item, pruneStaleBySource: false });

      const activeRunId =
        typeof item.runId === 'string' && item.runId.trim()
          ? item.runId.trim()
          : null;
      const shouldPrune =
        activeRunId &&
        options?.pruneStaleBySource !== false &&
        rawItem.pruneStaleBySource !== false;
      if (shouldPrune && activeRunId) {
        const resolved = resolveEntityRepoAndBodyHash(
          db,
          item.entityId,
          item.repositoryId
        );
        const repoId = item.repositoryId ?? resolved.repositoryId;
        if (repoId) {
          const scopeKey = `${repoId}::${item.layer}::${item.source}::${item.environment}`;
          scopesToPrune.set(scopeKey, {
            repositoryId: repoId,
            layer: item.layer,
            source: item.source,
            environment: item.environment,
            activeRunId,
          });
        }
      }
    }

    if (
      overlays.length === 0 &&
      options?.repositoryId &&
      options?.layer &&
      options?.source &&
      options?.runId &&
      options?.pruneStaleBySource !== false
    ) {
      const env = (options.environment || 'default').trim();
      const scopeKey = `${options.repositoryId}::${options.layer}::${options.source}::${env}`;
      scopesToPrune.set(scopeKey, {
        repositoryId: options.repositoryId,
        layer: options.layer,
        source: options.source,
        environment: env,
        activeRunId: options.runId.trim(),
      });
    }

    for (const scope of scopesToPrune.values()) {
      pruneEntityOverlaysSync(db, scope);
    }
  });
  tx();
}

export function getEntityOverlaysSync(
  db: Database.Database,
  repoId: string,
  filter?: EntityOverlayFilter
): EntityOverlayRecord[] {
  const conditions: string[] = ['eo.repository_id = ?'];
  const params: any[] = [repoId];

  if (filter?.entityId) {
    conditions.push('eo.entity_id = ?');
    params.push(filter.entityId);
  }
  if (filter?.entityIds && filter.entityIds.length > 0) {
    const placeholders = filter.entityIds.map(() => '?').join(',');
    conditions.push(`eo.entity_id IN (${placeholders})`);
    params.push(...filter.entityIds);
  }
  if (filter?.layer) {
    conditions.push('eo.layer = ?');
    params.push(filter.layer);
  }
  if (filter?.layers && filter.layers.length > 0) {
    const placeholders = filter.layers.map(() => '?').join(',');
    conditions.push(`eo.layer IN (${placeholders})`);
    params.push(...filter.layers);
  }
  if (filter?.source) {
    conditions.push('eo.source = ?');
    params.push(filter.source);
  }
  if (filter?.environment) {
    conditions.push('eo.environment = ?');
    params.push(filter.environment);
  }
  if (filter?.runId) {
    conditions.push('eo.run_id = ?');
    params.push(filter.runId);
  }

  const sql = `
    SELECT
      eo.repository_id,
      eo.entity_id,
      eo.layer,
      eo.source,
      eo.environment,
      eo.payload,
      eo.body_hash,
      eo.derivation,
      eo.inputs,
      eo.evidence,
      eo.run_id,
      eo.updated_at,
      n.metadata AS node_metadata,
      r.path AS repo_path
    FROM entity_overlays eo
    LEFT JOIN nodes n ON n.id = eo.entity_id AND n.repository_id = eo.repository_id
    LEFT JOIN repositories r ON r.id = eo.repository_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY eo.entity_id ASC, eo.layer ASC, eo.source ASC, eo.environment ASC
  `;

  const rows = db.prepare(sql).all(...params) as Array<{
    repository_id: string;
    entity_id: string;
    layer: string;
    source: string;
    environment: string;
    payload: string;
    body_hash: string | null;
    derivation: string | null;
    inputs: string | null;
    evidence: string | null;
    run_id: string | null;
    updated_at: string;
    node_metadata: string | null;
    repo_path: string | null;
  }>;

  const fileHashCache = new Map<string, string | null>();

  return rows.map((row) => {
    let payload: Record<string, any> = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {}

    let inputs: OverlayInputDependency[] | undefined;
    if (row.inputs) {
      try {
        const parsedInputs = JSON.parse(row.inputs);
        if (Array.isArray(parsedInputs) && parsedInputs.length > 0) {
          inputs = parsedInputs;
        }
      } catch {}
    }

    let evidence: OverlayEvidenceItem[] | undefined;
    if (row.evidence) {
      try {
        const parsedEvidence = JSON.parse(row.evidence);
        if (Array.isArray(parsedEvidence) && parsedEvidence.length > 0) {
          evidence = parsedEvidence;
        }
      } catch {}
    }

    let currentBodyHash: string | null = null;
    if (row.node_metadata) {
      try {
        const parsedMeta = JSON.parse(row.node_metadata);
        if (typeof parsedMeta?.bodyHash === 'string') {
          currentBodyHash = parsedMeta.bodyHash;
        }
      } catch {}
    }

    const bodyStale = Boolean(
      row.body_hash &&
        currentBodyHash &&
        row.body_hash !== currentBodyHash
    );

    let inputsStale = false;
    if (inputs && inputs.length > 0) {
      for (const inp of inputs) {
        if (!inp || typeof inp.path !== 'string') continue;
        if (filter?.inputHashes) {
          const currentInputHash = filter.inputHashes[inp.path];
          if (
            !currentInputHash ||
            (currentInputHash !== inp.hash &&
              !(inp.hash.length >= 6 && currentInputHash.startsWith(inp.hash)) &&
              !(currentInputHash.length >= 6 && inp.hash.startsWith(currentInputHash)))
          ) {
            inputsStale = true;
            break;
          }
          continue;
        }

        const repoPath = row.repo_path;
        const candidatePath = path.isAbsolute(inp.path)
          ? inp.path
          : repoPath
            ? path.resolve(repoPath, inp.path)
            : null;
        if (!candidatePath) continue;

        let liveHash = fileHashCache.get(candidatePath);
        if (liveHash === undefined) {
          if (fs.existsSync(candidatePath)) {
            try {
              liveHash = createHash('sha256')
                .update(fs.readFileSync(candidatePath))
                .digest('hex');
            } catch {
              liveHash = null;
            }
          } else {
            const repoExists = path.isAbsolute(inp.path)
              ? true
              : repoPath
                ? fs.existsSync(repoPath)
                : false;
            liveHash = repoExists ? '__MISSING__' : null;
          }
          fileHashCache.set(candidatePath, liveHash);
        }

        if (liveHash === '__MISSING__') {
          inputsStale = true;
          break;
        }
        if (liveHash) {
          const matches =
            liveHash === inp.hash ||
            (inp.hash.length >= 6 && liveHash.startsWith(inp.hash)) ||
            (liveHash.length >= 6 && inp.hash.startsWith(liveHash));
          if (!matches) {
            inputsStale = true;
            break;
          }
        }
      }
    }

    const stale = bodyStale || inputsStale;
    const derivation = normalizeDerivation(row.derivation, row.layer, row.source);

    return {
      repositoryId: row.repository_id,
      entityId: row.entity_id,
      layer: row.layer,
      source: row.source,
      environment: row.environment,
      payload,
      bodyHash: row.body_hash ?? null,
      derivation,
      ...(inputs ? { inputs } : {}),
      ...(evidence ? { evidence } : {}),
      runId: row.run_id ?? null,
      updatedAt: row.updated_at,
      stale,
    };
  });
}

export function deleteEntityOverlaySync(
  db: Database.Database,
  filter: {
    repositoryId?: string;
    entityId?: string;
    layer?: string;
    source?: string;
    environment?: string;
  }
): number {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.entityId) {
    conditions.push('entity_id = ?');
    params.push(filter.entityId);
  }
  if (filter.repositoryId) {
    conditions.push('repository_id = ?');
    params.push(filter.repositoryId);
  }
  if (filter.layer) {
    conditions.push('layer = ?');
    params.push(filter.layer);
  }
  if (filter.source) {
    conditions.push('source = ?');
    params.push(filter.source);
  }
  if (filter.environment) {
    conditions.push('environment = ?');
    params.push(filter.environment);
  }
  if (conditions.length === 0) return 0;

  const info = db
    .prepare(`DELETE FROM entity_overlays WHERE ${conditions.join(' AND ')}`)
    .run(...params);
  return info.changes;
}

export function updateNodeMetadataSync(
  db: Database.Database,
  nodeId: string,
  metadata: any
): void {
  if (!metadata || typeof metadata !== 'object') return;
  const row = db
    .prepare('SELECT repository_id, metadata FROM nodes WHERE id = ?')
    .get(nodeId) as { repository_id: string; metadata: string | null } | undefined;
  if (!row) return;

  const { astMeta, semanticOverlay, runtimeTelemetry } = splitAstAndOverlayMetadata(metadata);
  const currentAst = row.metadata ? JSON.parse(row.metadata) : {};
  const bodyHash = typeof currentAst?.bodyHash === 'string' ? currentAst.bodyHash : null;

  if (Object.keys(semanticOverlay).length > 0) {
    upsertEntityOverlaySync(db, {
      repositoryId: row.repository_id,
      entityId: nodeId,
      layer: 'L1_SEMANTIC',
      source: 'chomp_enrich_nodes',
      environment: 'default',
      payload: semanticOverlay,
      bodyHash,
      merge: true,
    });
  }

  if (runtimeTelemetry && Object.keys(runtimeTelemetry).length > 0) {
    upsertEntityOverlaySync(db, {
      repositoryId: row.repository_id,
      entityId: nodeId,
      layer: 'L2_RUNTIME',
      source: 'runtime_telemetry',
      environment: 'default',
      payload: { telemetry: runtimeTelemetry },
      bodyHash,
      merge: true,
    });
  }

  if (Object.keys(astMeta).length > 0) {
    Object.assign(currentAst, astMeta);
    db.prepare('UPDATE nodes SET metadata = ? WHERE id = ?').run(
      JSON.stringify(currentAst),
      nodeId
    );
  }
}

export function checkGraphIntegritySync(
  db: Database.Database,
  repoId: string
): GraphIntegrityReport {
  const danglingEdgeSources = db
    .prepare(
      `SELECT e.id AS edgeId, e.name AS edgeName, e.source_id AS sourceId
       FROM edges e
       LEFT JOIN nodes n ON n.id = e.source_id AND n.repository_id = e.repository_id
       WHERE e.repository_id = ? AND n.id IS NULL`
    )
    .all(repoId) as Array<{ edgeId: string; edgeName: string; sourceId: string }>;

  const danglingEdgeTargets = db
    .prepare(
      `SELECT e.id AS edgeId, e.name AS edgeName, e.target_id AS targetId
       FROM edges e
       LEFT JOIN nodes n ON n.id = e.target_id AND n.repository_id = e.repository_id
       WHERE e.repository_id = ? AND e.target_id IS NOT NULL AND n.id IS NULL`
    )
    .all(repoId) as Array<{ edgeId: string; edgeName: string; targetId: string }>;

  const danglingParentBoundaries = db
    .prepare(
      `SELECT c.id AS nodeId, c.name AS nodeName, c.parent_boundary_id AS parentBoundaryId
       FROM nodes c
       LEFT JOIN nodes p ON p.id = c.parent_boundary_id AND p.repository_id = c.repository_id
       WHERE c.repository_id = ? AND c.parent_boundary_id IS NOT NULL AND p.id IS NULL`
    )
    .all(repoId) as Array<{ nodeId: string; nodeName: string; parentBoundaryId: string }>;

  const orphanOverlays = db
    .prepare(
      `SELECT o.entity_id AS entityId, o.layer AS layer, o.source AS source, o.environment AS environment
       FROM entity_overlays o
       LEFT JOIN nodes n ON n.id = o.entity_id AND n.repository_id = o.repository_id
       LEFT JOIN edges e ON e.id = o.entity_id AND e.repository_id = o.repository_id
       WHERE o.repository_id = ? AND n.id IS NULL AND e.id IS NULL`
    )
    .all(repoId) as Array<{ entityId: string; layer: string; source: string; environment: string }>;

  const valid =
    danglingEdgeSources.length === 0 &&
    danglingEdgeTargets.length === 0 &&
    danglingParentBoundaries.length === 0 &&
    orphanOverlays.length === 0;

  return {
    repositoryId: repoId,
    valid,
    danglingEdgeSources,
    danglingEdgeTargets,
    danglingParentBoundaries,
    orphanOverlays,
  };
}

