import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  migrateLegacyMetadataToOverlays,
} from './migrations.js';

export {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  migrateLegacyMetadataToOverlays,
};

/**
 * Initializes the Chomp SQLite database and ensures all tables exist.
 *
 * Schema overview:
 * - `repositories`             One row per analyzed repo (upserted on re-run).
 * - `structural_entities`      One row per extracted primitive (BOUNDARY / CONTRACT / RELATIONSHIP / OPEN_CONNECTOR).
 *                              Cascade-deleted when the parent repository is removed.
 * - `evidence_records`         One row per entity linking back to its exact source file + line.
 *                              Cascade-deleted when the parent entity is removed.
 *                              Ontology v4.0: this table is the SOLE source of truth for file paths —
 *                              files and directories are positional metadata, never `nodes` rows.
 * - `nodes.metadata`           JSON column; strictly reserved for deterministic Layer 0/1 AST facts
 *                              emitted by `@chomp/core` (`runtime`, `bodyHash`, `astCallCount`,
 *                              `inputTypes`, `outputType`, `middlewares`).
 * - `entity_overlays`          Extensible multi-layer & plugin overlay store (`[PAT-DB-03]`) keyed by
 *                              `(entity_id, layer, source, environment)` with `body_hash` staleness
 *                              detection (`L1_PORTS`, `L1_SEMANTIC`, `L1_DESIGN_SYSTEM`, `L2_RUNTIME`,
 *                              `L3_INFRA`, `PLUGIN:*`). Survives destructive `structural_entities`
 *                              re-extractions and cascades only when the parent `repositories` row is deleted.
 *
 * All CREATE TABLE statements use IF NOT EXISTS, making this function safe to call on
 * every startup without migration logic.
 *
 * @param dbPath File path for the SQLite database. Defaults to ':memory:' for tests.
 *               Parent directory is created automatically if it does not exist.
 */
export function initDatabase(dbPath: string = ':memory:'): Database.Database {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      extractor_version TEXT,
      commit_sha TEXT,
      branch_name TEXT,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS structural_entities (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'UNKNOWN',
      pattern_id TEXT NOT NULL DEFAULT 'UNKNOWN',
      scope TEXT NOT NULL DEFAULT 'USER',
      parent_boundary_id TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id) REFERENCES structural_entities(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'UNKNOWN',
      pattern_id TEXT NOT NULL DEFAULT 'UNKNOWN',
      scope TEXT NOT NULL DEFAULT 'USER',
      source_id TEXT NOT NULL,
      target_id TEXT,
      status TEXT,
      confidence TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id) REFERENCES structural_entities(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS evidence_records (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER,
      snippet TEXT,
      evidence_role TEXT,
      UNIQUE(entity_id, file_path, line_number, evidence_role),
      FOREIGN KEY (entity_id) REFERENCES structural_entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS layout_views (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS layout_nodes (
      layout_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      lane TEXT,
      role TEXT,
      x INTEGER,
      y INTEGER,
      PRIMARY KEY (layout_id, node_id),
      FOREIGN KEY (layout_id) REFERENCES layout_views(id) ON DELETE CASCADE,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entity_overlays (
      repository_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      layer TEXT NOT NULL DEFAULT 'L1_SEMANTIC',
      source TEXT NOT NULL DEFAULT 'chomp_enrich_nodes',
      environment TEXT NOT NULL DEFAULT 'default',
      payload TEXT NOT NULL,
      body_hash TEXT,
      derivation TEXT NOT NULL DEFAULT 'AI_HYPOTHESIS',
      inputs TEXT,
      evidence TEXT,
      run_id TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_id, layer, source, environment),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entity_overlays_repo_entity
      ON entity_overlays(repository_id, entity_id);

  `);

  applyMigrations(db);

  return db;
}
