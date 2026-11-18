import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Command } from "commander";
import Database from "better-sqlite3";
import {
  analyzeTarget,
  auditFrameworkCoverage,
  collectLedgerSignalCandidates,
  formatLedgerPatternLogCommand,
  measureShapeResolution,
  type LedgerSignalCandidate,
  type RepresentationGraph,
} from "@chomp/core";
import { createSQLiteStorage } from "@chomp/db";
import { ansi, loadExcludeWorkspaces } from "../utils/branding.js";
import { getGitInfo, resolveRepoName } from "../utils/git.js";
import {
  getChompMasterRoot,
  resolveDefaultCliTarget,
  resolveGitRepoRoot,
} from "../utils/masterContext.js";

function getExtractorVersion(masterRoot: string): string {
  const pkgPath = resolve(masterRoot, "packages/core/package.json");
  if (!existsSync(pkgPath)) return "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function openPatternLedgerDb(ledgerPath: string): Database.Database {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const db = new Database(ledgerPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_ledger (
      pattern_id          TEXT PRIMARY KEY,
      ontology_category   TEXT NOT NULL CHECK(ontology_category IN ('BOUNDARY','CONTRACT','RELATIONSHIP','OPEN_CONNECTOR')),
      description         TEXT NOT NULL,
      detection_signature TEXT,
      status              TEXT NOT NULL DEFAULT 'unhandled' CHECK(status IN ('unhandled','partial','handled')),
      first_seen_repo     TEXT,
      first_seen_session_id TEXT,
      first_seen_file     TEXT,
      first_seen_line     INTEGER,
      occurrence_count    INTEGER NOT NULL DEFAULT 0,
      resolving_session_id TEXT,
      resolving_commit    TEXT,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shape_snapshots (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id       TEXT NOT NULL,
      repo              TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      commit_sha        TEXT,
      shape_key         TEXT NOT NULL,
      total             INTEGER NOT NULL,
      resolved          INTEGER NOT NULL,
      unresolved        INTEGER NOT NULL,
      measured_at       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shape_snapshots_repo ON shape_snapshots(repo, id);
    CREATE INDEX IF NOT EXISTS idx_shape_snapshots_shape ON shape_snapshots(shape_key, repo, id);
  `);

  const cols = new Set(
    (
      db.prepare("PRAGMA table_info(pattern_ledger)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );
  for (const [col, ddl] of [
    ["signal", "TEXT"],
    ["shape_key", "TEXT"],
    ["spec_ref", "TEXT"],
    ["resolution_evidence", "TEXT"],
    ["first_seen_snippet", "TEXT"],
  ] as const) {
    if (!cols.has(col)) {
      db.exec(`ALTER TABLE pattern_ledger ADD COLUMN ${col} ${ddl}`);
    }
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pattern_ledger_shape_key ON pattern_ledger(shape_key);",
  );

  return db;
}

async function loadOrExtractGraph(
  targetPath: string,
  repoId: string,
  extractorVersion: string,
  commitSha: string | undefined,
  forceFresh: boolean,
): Promise<{ graph: RepresentationGraph; source: "graph.db" | "ast" }> {
  const dbPath = resolve(targetPath, ".chomp", "graph.db");
  if (!forceFresh && existsSync(dbPath)) {
    const storage = createSQLiteStorage(dbPath);
    try {
      const saved = await storage.getRepresentationGraph(repoId);
      if (saved && saved.nodes.length > 0) {
        return { graph: saved, source: "graph.db" };
      }
    } catch {
      // Fall back to fresh AST extraction
    } finally {
      await storage.close();
    }
  }

  const excludeWorkspaces = loadExcludeWorkspaces(targetPath);
  const graph = analyzeTarget(
    targetPath,
    extractorVersion,
    commitSha,
    excludeWorkspaces,
  );
  return { graph, source: "ast" };
}

function syncCandidatesIntoLedger(
  db: Database.Database,
  repoName: string,
  sessionLabel: string,
  candidates: readonly LedgerSignalCandidate[],
): {
  ingested: Array<{
    patternId: string;
    shapeKey: string;
    signal: string;
    unresolved: number;
    location: string;
    snippet: string;
  }>;
  updated: Array<{
    patternId: string;
    shapeKey: string;
    unresolved: number;
  }>;
} {
  const existingRows = db
    .prepare("SELECT * FROM pattern_ledger WHERE shape_key IS NOT NULL")
    .all() as Array<Record<string, any>>;
  const byShapeKey = new Map<string, Record<string, any>>();
  for (const r of existingRows) {
    if (typeof r.shape_key === "string") {
      byShapeKey.set(r.shape_key, r);
    }
  }

  const now = new Date().toISOString();
  const ingested: Array<{
    patternId: string;
    shapeKey: string;
    signal: string;
    unresolved: number;
    location: string;
    snippet: string;
  }> = [];
  const updated: Array<{
    patternId: string;
    shapeKey: string;
    unresolved: number;
  }> = [];

  const insertStmt = db.prepare(`
    INSERT INTO pattern_ledger (
      pattern_id, ontology_category, description, status,
      detection_signature, signal, shape_key, spec_ref,
      first_seen_repo, first_seen_session_id, first_seen_file, first_seen_line, first_seen_snippet,
      occurrence_count
    ) VALUES (
      @pattern_id, @ontology_category, @description, 'unhandled',
      NULL, @signal, @shape_key, NULL,
      @first_seen_repo, @first_seen_session_id, @first_seen_file, @first_seen_line, @first_seen_snippet,
      @occurrence_count
    )
  `);

  const updateStmt = db.prepare(`
    UPDATE pattern_ledger
    SET occurrence_count = @occurrence_count,
        updated_at = CURRENT_TIMESTAMP,
        first_seen_file = COALESCE(first_seen_file, @first_seen_file),
        first_seen_line = COALESCE(first_seen_line, @first_seen_line),
        first_seen_snippet = COALESCE(first_seen_snippet, @first_seen_snippet)
    WHERE pattern_id = @pattern_id
  `);

  const runTx = db.transaction(() => {
    for (const c of candidates) {
      const existing = byShapeKey.get(c.shapeKey);
      if (existing) {
        updateStmt.run({
          pattern_id: existing.pattern_id,
          occurrence_count: c.total,
          first_seen_file: c.firstSeenFile ?? null,
          first_seen_line: c.firstSeenLine ?? null,
          first_seen_snippet: c.snippet ?? null,
        });
        updated.push({
          patternId: String(existing.pattern_id),
          shapeKey: c.shapeKey,
          unresolved: c.unresolved,
        });
        continue;
      }

      let patternId = c.suggestedPatternId;
      let suffix = 2;
      while (
        db
          .prepare("SELECT 1 FROM pattern_ledger WHERE pattern_id = ?")
          .get(patternId)
      ) {
        patternId = `${c.suggestedPatternId}-${suffix++}`;
      }

      insertStmt.run({
        pattern_id: patternId,
        ontology_category: c.ontologyCategory,
        description: c.description,
        signal: c.signal,
        shape_key: c.shapeKey,
        first_seen_repo: repoName,
        first_seen_session_id: sessionLabel,
        first_seen_file: c.firstSeenFile ?? null,
        first_seen_line: c.firstSeenLine ?? null,
        first_seen_snippet: c.snippet ?? null,
        occurrence_count: c.total,
      });

      byShapeKey.set(c.shapeKey, {
        pattern_id: patternId,
        shape_key: c.shapeKey,
      });

      ingested.push({
        patternId,
        shapeKey: c.shapeKey,
        signal: c.signal,
        unresolved: c.unresolved,
        location: c.firstSeenFile
          ? `${c.firstSeenFile}:${c.firstSeenLine ?? 1}`
          : "—",
        snippet: c.snippet ?? "—",
      });
    }
  });

  runTx();
  return { ingested, updated };
}

export function registerLedgerCommand(program: Command): void {
  const ledgerCmd = program
    .command("ledger")
    .description(
      "Bridge repository extraction diagnostics into the Chomp pattern ledger (pattern_ledger.db)",
    );

  ledgerCmd
    .command("sync [path]")
    .alias("ingest")
    .description(
      "Measure shape resolution and ingest unregistered knowable signal clusters into fixtures/research/pattern_ledger.db",
    )
    .option("--repo <path>", "Repository path, name, or ID (alias for [path])")
    .option(
      "--dry-run",
      "Preview unregistered knowable signal clusters and copy-ready log commands without writing to pattern_ledger.db",
    )
    .option(
      "--fresh",
      "Force fresh AST extraction instead of reading cached <repo>/.chomp/graph.db",
    )
    .option(
      "--include-dark-files",
      "Also ingest DARK_FILE signal clusters (0 extracted contracts & 0 INIT_BLOCK edges)",
    )
    .option(
      "--session <label>",
      "Session label recorded on newly ingested pattern rows",
    )
    .action(
      async (
        inputPath: string | undefined,
        options: {
          repo?: string;
          dryRun?: boolean;
          fresh?: boolean;
          includeDarkFiles?: boolean;
          session?: string;
        },
      ) => {
        const baseDir = process.env.INIT_CWD ?? process.cwd();
        const { targetPath: rawTarget } = resolveDefaultCliTarget(
          options.repo ?? inputPath,
          baseDir,
          true,
        );
        const targetPath = resolveGitRepoRoot(rawTarget);

        if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
          console.error(
            `Error: Target path ${targetPath} is not a valid directory.`,
          );
          process.exit(1);
        }

        const masterRoot = getChompMasterRoot();
        const repoName = resolveRepoName(targetPath);
        const repoId = repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const extractorVersion = getExtractorVersion(masterRoot);
        const { commitSha } = getGitInfo(targetPath);

        const { graph, source } = await loadOrExtractGraph(
          targetPath,
          repoId,
          extractorVersion,
          commitSha,
          Boolean(options.fresh),
        );

        const excludeWorkspaces = loadExcludeWorkspaces(targetPath);
        const darkFiles = options.includeDarkFiles
          ? auditFrameworkCoverage(targetPath, graph, excludeWorkspaces)
              .darkFiles
          : [];

        const ledgerPath = resolve(
          masterRoot,
          "fixtures/research/pattern_ledger.db",
        );
        const db = openPatternLedgerDb(ledgerPath);

        try {
          const shapeRows = measureShapeResolution(graph, {
            includeOrphans: true,
          });
          const measuredAt = new Date().toISOString();

          if (!options.dryRun) {
            const last = db
              .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM shape_snapshots")
              .get() as { n: number };
            const snapshotId = `${repoName}@${measuredAt}#${last.n + 1}`;
            const insertSnap = db.prepare(`
              INSERT INTO shape_snapshots (
                snapshot_id, repo, extractor_version, commit_sha, shape_key, total, resolved, unresolved, measured_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const tx = db.transaction(() => {
              for (const r of shapeRows) {
                insertSnap.run(
                  snapshotId,
                  repoName,
                  extractorVersion,
                  commitSha ?? null,
                  r.shapeKey,
                  r.total,
                  r.resolved,
                  r.unresolved,
                  measuredAt,
                );
              }
              if (shapeRows.length === 0) {
                insertSnap.run(
                  snapshotId,
                  repoName,
                  extractorVersion,
                  commitSha ?? null,
                  "",
                  0,
                  0,
                  0,
                  measuredAt,
                );
              }
            });
            tx();
          }

          const existingShapeKeys = new Set(
            (
              db
                .prepare(
                  "SELECT shape_key FROM pattern_ledger WHERE shape_key IS NOT NULL",
                )
                .all() as Array<{ shape_key: string }>
            ).map((r) => r.shape_key),
          );

          const allKnowableCandidates = collectLedgerSignalCandidates(graph, {
            onlyKnowable: true,
            darkFiles,
          });
          const unregisteredCandidates = allKnowableCandidates.filter(
            (c) => !existingShapeKeys.has(c.shapeKey),
          );

          console.log(
            `\n  ${ansi.yellowBold("◆")} ${ansi.bold(`Pattern Ledger Bridge · ${repoName}`)} ${ansi.dim(`(source: ${source}, extractor v${extractorVersion})`)}`,
          );

          if (options.dryRun) {
            if (unregisteredCandidates.length === 0) {
              console.log(
                `  ${ansi.green("✓")} All knowable signal shapes in ${repoName} are already registered in pattern_ledger.db.\n`,
              );
              return;
            }
            console.log(
              `  ${ansi.amber("▲")} ${unregisteredCandidates.length} unregistered knowable signal cluster(s):\n`,
            );
            console.table(
              unregisteredCandidates.map((c) => ({
                Signal: c.signal,
                "Shape Key": c.shapeKey,
                "Suggested ID": c.suggestedPatternId,
                Unresolved: c.unresolved,
                "First Seen": c.firstSeenFile
                  ? `${c.firstSeenFile}:${c.firstSeenLine ?? 1}`
                  : "—",
                Snippet: (c.snippet ?? c.exampleName ?? "—").slice(0, 64),
              })),
            );
            console.log("\n  Copy-ready ledger pattern log commands:");
            for (const c of unregisteredCandidates) {
              console.log(
                `    ${formatLedgerPatternLogCommand(c, repoName, options.session)}`,
              );
            }
            console.log("");
            return;
          }

          const dateTag = measuredAt.slice(0, 10);
          const sessionLabel =
            options.session ?? `sync-${dateTag}-${repoName}`;
          const { ingested, updated } = syncCandidatesIntoLedger(
            db,
            repoName,
            sessionLabel,
            allKnowableCandidates,
          );

          console.log(
            `  ${ansi.green("✓")} Recorded ${shapeRows.length} shape measurements at ${measuredAt}`,
          );
          console.log(
            `  ${ansi.green("✓")} Ledger sync complete: ${ansi.bold(String(ingested.length))} newly ingested, ${ansi.bold(String(updated.length))} existing updated in ${ansi.cyan("fixtures/research/pattern_ledger.db")}\n`,
          );

          if (ingested.length > 0) {
            console.table(
              ingested.map((item) => ({
                "Pattern ID": item.patternId,
                Signal: item.signal,
                "Shape Key": item.shapeKey,
                Unresolved: item.unresolved,
                "First Seen": item.location,
                Snippet: item.snippet.slice(0, 64),
              })),
            );
          }
        } finally {
          db.close();
        }
      },
    );
}
