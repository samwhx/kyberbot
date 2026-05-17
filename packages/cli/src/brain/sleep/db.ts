/**
 * KyberBot — Sleep Agent Database
 *
 * Manages the sleep.db SQLite database for tracking runs,
 * maintenance queue, memory edges, and telemetry.
 */

import Database from 'libsql';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../../logger.js';
import { openWithRecovery } from '../db-recovery.js';
import { applyMigrations, type Migration } from '../db-migrate.js';

const logger = createLogger('sleep-db');

const databases = new Map<string, Database.Database>();

/**
 * Reset the sleep DB connection(s). If root is given, closes only that
 * root's connection. If no root, closes all (backward compat for eval/tests).
 */
export function resetSleepDb(root?: string): void {
  if (root) {
    const existing = databases.get(root);
    if (existing) {
      try { existing.close(); } catch { /* ignore */ }
      databases.delete(root);
    }
  } else {
    for (const [, conn] of databases) {
      try { conn.close(); } catch { /* ignore */ }
    }
    databases.clear();
  }
}

export function getSleepDb(root: string): Database.Database {
  const existing = databases.get(root);
  if (existing) return existing;

  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, 'sleep.db');
  const newDb = openWithRecovery(dbPath);

  newDb.pragma('journal_mode = WAL');

  applyMigrations(newDb, 'sleep', SLEEP_DB_MIGRATIONS);

  databases.set(root, newDb);
  logger.info('Sleep database initialized', { path: dbPath });
  return newDb;
}

const SLEEP_DB_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'base schema — sleep_runs, maintenance_queue, memory_edges, sleep_telemetry',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sleep_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'paused')),
          checkpoint_step TEXT,
          checkpoint_data TEXT,
          metrics TEXT,
          error_message TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_sleep_runs_status ON sleep_runs(status);
        CREATE INDEX IF NOT EXISTS idx_sleep_runs_started ON sleep_runs(started_at DESC);

        CREATE TABLE IF NOT EXISTS maintenance_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_type TEXT NOT NULL CHECK(item_type IN ('timeline', 'entity', 'file')),
          item_id TEXT NOT NULL,
          task TEXT NOT NULL CHECK(task IN ('retag', 'relink', 'resummarize', 'decay', 'rewrite')),
          priority INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          processed_at TEXT,
          error_message TEXT,
          UNIQUE(item_type, item_id, task)
        );

        CREATE INDEX IF NOT EXISTS idx_queue_pending ON maintenance_queue(processed_at) WHERE processed_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_queue_priority ON maintenance_queue(priority DESC);

        CREATE TABLE IF NOT EXISTS memory_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_path TEXT NOT NULL,
          to_path TEXT NOT NULL,
          relation TEXT NOT NULL DEFAULT 'related' CHECK(relation IN ('related', 'continuation', 'referenced', 'same_topic', 'same_person')),
          weight REAL DEFAULT 1.0,
          confidence REAL DEFAULT 0.5,
          shared_tags TEXT,
          rationale TEXT,
          method TEXT DEFAULT 'sleep-agent' CHECK(method IN ('sleep-agent', 'manual', 'co-occurred', 'ai-suggested')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_verified TEXT,
          UNIQUE(from_path, to_path)
        );

        CREATE INDEX IF NOT EXISTS idx_edges_from ON memory_edges(from_path);
        CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_path);
        CREATE INDEX IF NOT EXISTS idx_edges_confidence ON memory_edges(confidence DESC);
        CREATE INDEX IF NOT EXISTS idx_edges_relation ON memory_edges(relation);

        CREATE TABLE IF NOT EXISTS sleep_telemetry (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER REFERENCES sleep_runs(id),
          step TEXT NOT NULL,
          event_type TEXT NOT NULL,
          count INTEGER DEFAULT 0,
          duration_ms INTEGER,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_telemetry_run ON sleep_telemetry(run_id);
        CREATE INDEX IF NOT EXISTS idx_telemetry_step ON sleep_telemetry(step);
      `);
    },
  },
  {
    version: 2,
    description: 'relax memory_edges.relation CHECK — accept consolidation + future types',
    up: (db) => {
      // Idempotent probe: if the current CHECK already accepts 'consolidation',
      // do nothing. Otherwise recreate the table without the restrictive CHECK.
      let needsRecreate = false;
      try {
        db.exec("INSERT INTO memory_edges (from_path, to_path, relation) VALUES ('__mig_probe__', '__mig_probe__', 'consolidation')");
        db.exec("DELETE FROM memory_edges WHERE from_path = '__mig_probe__'");
      } catch {
        needsRecreate = true;
      }
      if (!needsRecreate) return;

      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_edges_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_path TEXT NOT NULL,
          to_path TEXT NOT NULL,
          relation TEXT NOT NULL DEFAULT 'related',
          weight REAL DEFAULT 1.0,
          confidence REAL DEFAULT 0.5,
          shared_tags TEXT,
          rationale TEXT,
          method TEXT DEFAULT 'sleep-agent',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_verified TEXT,
          UNIQUE(from_path, to_path)
        );

        INSERT OR IGNORE INTO memory_edges_v2
          (id, from_path, to_path, relation, weight, confidence, shared_tags, rationale, method, created_at, last_verified)
        SELECT id, from_path, to_path, relation, weight, confidence, shared_tags, rationale, method, created_at, last_verified
        FROM memory_edges;

        DROP TABLE memory_edges;
        ALTER TABLE memory_edges_v2 RENAME TO memory_edges;

        CREATE INDEX IF NOT EXISTS idx_edges_from ON memory_edges(from_path);
        CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_path);
        CREATE INDEX IF NOT EXISTS idx_edges_confidence ON memory_edges(confidence DESC);
        CREATE INDEX IF NOT EXISTS idx_edges_relation ON memory_edges(relation);
      `);
    },
  },
  {
    version: 3,
    description: 'relax maintenance_queue.task CHECK — accept arbitrary task types',
    up: (db) => {
      let needsRecreate = false;
      try {
        db.exec("INSERT INTO maintenance_queue (item_type, item_id, task) VALUES ('timeline', '__mig_probe__', 'consolidate')");
        db.exec("DELETE FROM maintenance_queue WHERE item_id = '__mig_probe__'");
      } catch {
        needsRecreate = true;
      }
      if (!needsRecreate) return;

      db.exec(`
        CREATE TABLE IF NOT EXISTS maintenance_queue_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_type TEXT NOT NULL CHECK(item_type IN ('timeline', 'entity', 'file')),
          item_id TEXT NOT NULL,
          task TEXT NOT NULL,
          priority INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          processed_at TEXT,
          error_message TEXT,
          UNIQUE(item_type, item_id, task)
        );

        INSERT OR IGNORE INTO maintenance_queue_v2
          (id, item_type, item_id, task, priority, created_at, processed_at, error_message)
        SELECT id, item_type, item_id, task, priority, created_at, processed_at, error_message
        FROM maintenance_queue;

        DROP TABLE maintenance_queue;
        ALTER TABLE maintenance_queue_v2 RENAME TO maintenance_queue;

        CREATE INDEX IF NOT EXISTS idx_queue_pending ON maintenance_queue(processed_at) WHERE processed_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_queue_priority ON maintenance_queue(priority DESC);
      `);
    },
  },
];

export async function initializeSleepDb(root: string): Promise<void> {
  getSleepDb(root);
}
