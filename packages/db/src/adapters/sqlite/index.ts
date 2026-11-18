import Database from 'better-sqlite3';
import {
  ChompStorage,
  EntityOverlayFilter,
  EntityOverlayInput,
  EntityOverlayRecord,
  GraphIntegrityReport,
  PruneEntityOverlaysFilter,
  RepositoryInfo,
  ScopeOptions,
  UpsertEntityOverlaysOptions,
} from '../../interface.js';
import { initDatabase } from './schema.js';
import {
  saveRepresentationGraph,
  getRepresentationGraph,
  listRepositories,
  upsertEntityOverlaySync,
  upsertEntityOverlaysSync,
  pruneEntityOverlaysSync,
  getEntityOverlaysSync,
  deleteEntityOverlaySync,
  updateNodeMetadataSync,
  checkGraphIntegritySync,
} from './graphRepository.js';
import type { RepresentationGraph } from '@chomp/core';

export class SQLiteStorage implements ChompStorage {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = initDatabase(dbPath);
  }

  async saveRepresentationGraph(repo: RepositoryInfo, graph: RepresentationGraph): Promise<void> {
    saveRepresentationGraph(this.db, repo, graph);
  }

  async getRepresentationGraph(repoId: string, options?: ScopeOptions): Promise<RepresentationGraph | null> {
    return getRepresentationGraph(this.db, repoId, options);
  }

  async listRepositories(): Promise<RepositoryInfo[]> {
    return listRepositories(this.db);
  }

  async deleteRepository(repoId: string): Promise<void> {
    this.db.prepare('DELETE FROM repositories WHERE id = ?').run(repoId);
  }

  async updateNodeMetadata(nodeId: string, metadata: any): Promise<void> {
    updateNodeMetadataSync(this.db, nodeId, metadata);
  }

  async upsertEntityOverlay(overlay: EntityOverlayInput): Promise<void> {
    upsertEntityOverlaySync(this.db, overlay);
  }

  async upsertEntityOverlays(
    overlaysOrRepoId: EntityOverlayInput[] | string,
    optionsOrOverlays?: UpsertEntityOverlaysOptions | EntityOverlayInput[],
    maybeOptions?: UpsertEntityOverlaysOptions
  ): Promise<void> {
    if (typeof overlaysOrRepoId === 'string') {
      const overlays = Array.isArray(optionsOrOverlays) ? optionsOrOverlays : [];
      upsertEntityOverlaysSync(this.db, overlays, {
        ...maybeOptions,
        repositoryId: overlaysOrRepoId,
      });
      return;
    }
    upsertEntityOverlaysSync(
      this.db,
      overlaysOrRepoId,
      optionsOrOverlays as UpsertEntityOverlaysOptions | undefined
    );
  }

  async pruneEntityOverlays(filter: PruneEntityOverlaysFilter): Promise<number> {
    return pruneEntityOverlaysSync(this.db, filter);
  }

  async getEntityOverlays(
    repoId: string,
    filter?: EntityOverlayFilter
  ): Promise<EntityOverlayRecord[]> {
    return getEntityOverlaysSync(this.db, repoId, filter);
  }

  async deleteEntityOverlay(
    filterOrRepoId:
      | {
          repositoryId?: string;
          entityId?: string;
          layer?: string;
          source?: string;
          environment?: string;
        }
      | string,
    entityId?: string,
    layer?: string,
    source?: string,
    environment?: string
  ): Promise<number> {
    if (typeof filterOrRepoId === 'string') {
      return deleteEntityOverlaySync(this.db, {
        repositoryId: filterOrRepoId,
        entityId,
        layer,
        source,
        environment,
      });
    }
    return deleteEntityOverlaySync(this.db, filterOrRepoId);
  }

  async checkGraphIntegrity(repoId: string): Promise<GraphIntegrityReport> {
    return checkGraphIntegritySync(this.db, repoId);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function createSQLiteStorage(dbPath: string): ChompStorage {
  return new SQLiteStorage(dbPath);
}

export * from './schema.js';
export * from './migrations.js';
export * from './graphRepository.js';
