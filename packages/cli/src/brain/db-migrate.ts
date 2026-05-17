/**
 * KyberBot — SQLite migration framework
 *
 * Every brain SQLite store goes through this helper. Each store owns an
 * ordered list of Migration objects (v1, v2, v3, ...). On startup the
 * helper reads `PRAGMA user_version` and applies any pending migrations
 * in a transaction, stamping the new version on success.
 *
 * Migrations are expected to be idempotent — they may run against a
 * database that was created before the framework existed and already has
 * the schema partially in place. Use `addColumnIfMissing` and `CREATE …
 * IF NOT EXISTS` to keep them safe to re-run.
 */

import type Database from 'libsql';
import { createLogger } from '../logger.js';

const logger = createLogger('db-migrate');

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

export function applyMigrations(
  db: Database.Database,
  name: string,
  migrations: Migration[],
): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const current = getDbVersion(db);

  let applied = 0;
  for (const m of sorted) {
    if (m.version <= current) continue;

    logger.info(`[${name}] applying v${m.version}: ${m.description}`);
    db.exec('BEGIN');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      applied++;
    } catch (err) {
      db.exec('ROLLBACK');
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${name} v${m.version} failed: ${msg}`);
    }
  }

  if (applied > 0) {
    logger.info(`[${name}] ${applied} migration(s) applied, now at v${getDbVersion(db)}`);
  }
}

export function getDbVersion(db: Database.Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Add a column to an existing table only if it's not already there. Used
 * inside migrations so the same migration is safe to run against a
 * database that was hand-evolved before this framework existed.
 */
export function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
