import Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 2;

const LEGACY_SEMANTIC_KEYS = ['domain', 'humanLabel', 'summary', 'rationale', 'flags'] as const;

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

export function getSchemaVersion(db: Database.Database): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0;
}

/**
 * Lazy migration (`[PAT-DB-01]`, `[PAT-DB-03]`): migrates any legacy non-AST enrichment keys
 * (`domain`, `humanLabel`, `summary`, `rationale`, `flags`, `telemetry`) out of `nodes.metadata`
 * and `edges.metadata` into `entity_overlays` so AST metadata columns stay strictly pure.
 */
export function migrateLegacyMetadataToOverlays(db: Database.Database): void {
  const upsertOverlayStmt = db.prepare(`
    INSERT INTO entity_overlays (repository_id, entity_id, layer, source, environment, payload, body_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(entity_id, layer, source, environment) DO UPDATE SET
      payload = excluded.payload,
      body_hash = COALESCE(excluded.body_hash, entity_overlays.body_hash),
      updated_at = CURRENT_TIMESTAMP
  `);

  const migrateTable = (table: 'nodes' | 'edges') => {
    const rows = db
      .prepare(`SELECT id, repository_id, metadata FROM ${table} WHERE metadata IS NOT NULL`)
      .all() as Array<{ id: string; repository_id: string; metadata: string }>;
    const updateMetaStmt = db.prepare(`UPDATE ${table} SET metadata = ? WHERE id = ?`);

    for (const row of rows) {
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(row.metadata);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;

      const semanticPayload: Record<string, any> = {};
      let mutated = false;
      for (const k of LEGACY_SEMANTIC_KEYS) {
        if (parsed[k] !== undefined) {
          semanticPayload[k] = parsed[k];
          delete parsed[k];
          mutated = true;
        }
      }

      let telemetryPayload: Record<string, any> | null = null;
      if (parsed.telemetry !== undefined && typeof parsed.telemetry === 'object' && parsed.telemetry !== null) {
        telemetryPayload = parsed.telemetry;
        delete parsed.telemetry;
        mutated = true;
      }

      if (!mutated) continue;

      const bodyHash = typeof parsed.bodyHash === 'string' ? parsed.bodyHash : null;
      if (Object.keys(semanticPayload).length > 0) {
        const existingRow = db
          .prepare(
            `SELECT payload FROM entity_overlays WHERE entity_id = ? AND layer = 'L1_SEMANTIC' AND source = 'chomp_enrich_nodes' AND environment = 'default'`
          )
          .get(row.id) as { payload: string } | undefined;
        let mergedSemantic = semanticPayload;
        if (existingRow?.payload) {
          try {
            mergedSemantic = { ...JSON.parse(existingRow.payload), ...semanticPayload };
          } catch {}
        }
        upsertOverlayStmt.run(
          row.repository_id,
          row.id,
          'L1_SEMANTIC',
          'chomp_enrich_nodes',
          'default',
          JSON.stringify(mergedSemantic),
          bodyHash
        );
      }

      if (telemetryPayload && Object.keys(telemetryPayload).length > 0) {
        upsertOverlayStmt.run(
          row.repository_id,
          row.id,
          'L2_RUNTIME',
          'runtime_telemetry',
          'default',
          JSON.stringify({ telemetry: telemetryPayload }),
          bodyHash
        );
      }

      const cleanedMetaStr = Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : null;
      updateMetaStmt.run(cleanedMetaStr, row.id);
    }
  };

  const tx = db.transaction(() => {
    migrateTable('nodes');
    migrateTable('edges');
  });
  tx();
}

/**
 * Applies numbered, transactional SQLite schema migrations gated by `PRAGMA user_version`.
 * Throws if the database on disk was created by a newer schema version (`user_version > CURRENT_SCHEMA_VERSION`).
 */
export function applyMigrations(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Chomp SQLite schema version mismatch: database is at user_version=${currentVersion}, ` +
        `but this version of @chomp/db only supports up to user_version=${CURRENT_SCHEMA_VERSION}. ` +
        `Please upgrade Chomp or re-run 'chomp analyze' to rebuild the graph database.`
    );
  }

  if (currentVersion < 1) {
    const migrateV1 = db.transaction(() => {
      ensureColumn(db, 'nodes', 'entity_type', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
      ensureColumn(db, 'nodes', 'pattern_id', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
      ensureColumn(db, 'nodes', 'scope', "TEXT NOT NULL DEFAULT 'USER'");
      ensureColumn(db, 'nodes', 'parent_boundary_id', 'TEXT');
      ensureColumn(db, 'nodes', 'metadata', 'TEXT');

      ensureColumn(db, 'edges', 'source_id', 'TEXT');
      ensureColumn(db, 'edges', 'entity_type', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
      ensureColumn(db, 'edges', 'pattern_id', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
      ensureColumn(db, 'edges', 'scope', "TEXT NOT NULL DEFAULT 'USER'");
      ensureColumn(db, 'edges', 'target_id', 'TEXT');
      ensureColumn(db, 'edges', 'status', 'TEXT');
      ensureColumn(db, 'edges', 'confidence', 'TEXT');
      ensureColumn(db, 'edges', 'metadata', 'TEXT');

      ensureColumn(db, 'evidence_records', 'evidence_role', 'TEXT');
      ensureColumn(db, 'repositories', 'extractor_version', 'TEXT');
      ensureColumn(db, 'repositories', 'commit_sha', 'TEXT');
      ensureColumn(db, 'repositories', 'branch_name', 'TEXT');
      ensureColumn(db, 'repositories', 'project_id', 'TEXT');

      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_dedup ON evidence_records(entity_id, file_path, line_number, evidence_role);'
      );
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_entity_overlays_repo_entity ON entity_overlays(repository_id, entity_id);'
      );

      migrateLegacyMetadataToOverlays(db);
      db.pragma('user_version = 1');
    });
    migrateV1();
  }

  if (currentVersion < 2) {
    const migrateV2 = db.transaction(() => {
      ensureColumn(db, 'entity_overlays', 'derivation', "TEXT NOT NULL DEFAULT 'AI_HYPOTHESIS'");
      ensureColumn(db, 'entity_overlays', 'inputs', 'TEXT');
      ensureColumn(db, 'entity_overlays', 'evidence', 'TEXT');
      ensureColumn(db, 'entity_overlays', 'run_id', 'TEXT');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_entity_overlays_source_run ON entity_overlays(repository_id, layer, source, environment, run_id);'
      );
      db.pragma('user_version = 2');
    });
    migrateV2();
  }
}
