/**
 * KyberBot — Cold storage for timeline events
 *
 * The archive tier in timeline_events was previously just a flag —
 * every query still scanned the full table. For multi-year durability
 * we need real archival: move rows out of the hot file into separate
 * monthly SQLite files (data/cold/YYYY-MM.db) so the primary timeline
 * stays small + fast.
 *
 * Lifecycle:
 *   1. sleep/steps/archive.ts picks rows where tier='archive' AND
 *      last_accessed > 90 days ago AND is_pinned=0, copies them into
 *      the cold DB for the event's month, deletes from primary.
 *   2. hybrid-search.ts opens cold DBs read-only and LIKE-searches them
 *      only when the caller passes `includeCold: true`.
 *   3. `kyberbot brain restore <id>` pulls a single row back to primary
 *      (rebuilds FTS via the existing trigger).
 *
 * Cold DBs are intentionally simpler than primary: no FTS, no triggers,
 * no tier/decay machinery. They are pure archives — read-mostly, written
 * once per archive cycle. On restore, the row gets the full
 * primary-store treatment again.
 */

import Database from 'libsql';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { createLogger } from '../logger.js';
import { openWithRecovery } from './db-recovery.js';
import { applyMigrations, type Migration } from './db-migrate.js';

const logger = createLogger('cold-storage');

// Cached connections per cold-DB file path, so repeated reads don't
// reopen the file every query.
const coldDbs = new Map<string, Database.Database>();

/**
 * Reset all cold DB handles (test helper / shutdown).
 */
export function resetColdStorage(): void {
  for (const [, conn] of coldDbs) {
    try { conn.close(); } catch { /* ignore */ }
  }
  coldDbs.clear();
}

function coldDbPath(root: string, year: number, month: number): string {
  const mm = String(month).padStart(2, '0');
  return join(root, 'data', 'cold', `${year}-${mm}.db`);
}

function ensureColdDir(root: string): void {
  const dir = join(root, 'data', 'cold');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const COLD_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'cold timeline_events shadow + lookup indexes',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cold_timeline_events (
          id INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          end_timestamp TEXT,
          title TEXT NOT NULL,
          summary TEXT,
          source_path TEXT NOT NULL,
          entities_json TEXT DEFAULT '[]',
          topics_json TEXT DEFAULT '[]',
          tags_json TEXT DEFAULT '[]',
          priority REAL DEFAULT 0.5,
          decay_score REAL DEFAULT 0.0,
          last_accessed TEXT,
          access_count INTEGER DEFAULT 0,
          project_id TEXT,
          classification TEXT,
          connection_id TEXT,
          source_did TEXT,
          metrics_json TEXT,
          outcome TEXT,
          outcome_confidence REAL,
          outcome_evidence TEXT,
          outcome_annotated_at TEXT,
          archived_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cold_timestamp ON cold_timeline_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_cold_source ON cold_timeline_events(source_path);
        CREATE INDEX IF NOT EXISTS idx_cold_project ON cold_timeline_events(project_id);
      `);
    },
  },
];

/**
 * Open (or create) the cold DB file for a given month. Returns a
 * cached handle so subsequent calls in the same process reuse it.
 */
export function getColdDb(root: string, year: number, month: number): Database.Database {
  const path = coldDbPath(root, year, month);
  const cached = coldDbs.get(path);
  if (cached) return cached;

  ensureColdDir(root);
  const db = openWithRecovery(path);
  db.pragma('journal_mode = WAL');
  applyMigrations(db, `cold:${year}-${String(month).padStart(2, '0')}`, COLD_MIGRATIONS);
  coldDbs.set(path, db);
  return db;
}

/**
 * List existing cold DBs (sorted oldest → newest) so callers can scan
 * them without guessing month ranges.
 */
export function listColdFiles(root: string): Array<{ year: number; month: number; path: string }> {
  const dir = join(root, 'data', 'cold');
  if (!existsSync(dir)) return [];
  const out: Array<{ year: number; month: number; path: string }> = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(/^(\d{4})-(\d{2})\.db$/);
    if (!m) continue;
    out.push({ year: Number(m[1]), month: Number(m[2]), path: join(dir, name) });
  }
  out.sort((a, b) => (a.year - b.year) || (a.month - b.month));
  return out;
}

/**
 * Shape of a cold-stored timeline event. Mirrors timeline_events but
 * not 1:1 — fields the sleep agent stamps post-archive (tier transitions,
 * last_enriched) are not preserved; restoration re-runs them naturally.
 */
export interface ColdEvent {
  id: number;
  type: string;
  timestamp: string;
  end_timestamp: string | null;
  title: string;
  summary: string | null;
  source_path: string;
  entities_json: string;
  topics_json: string;
  tags_json: string;
  priority: number | null;
  decay_score: number | null;
  last_accessed: string | null;
  access_count: number | null;
  project_id: string | null;
  classification: string | null;
  connection_id: string | null;
  source_did: string | null;
  metrics_json: string | null;
  outcome: string | null;
  outcome_confidence: number | null;
  outcome_evidence: string | null;
  outcome_annotated_at: string | null;
  archived_at: string;
}

/**
 * Insert a row into the appropriate cold DB. Returns true on insert,
 * false if the row already exists (idempotent).
 */
export function insertColdEvent(root: string, row: Omit<ColdEvent, 'archived_at'>): boolean {
  const ts = new Date(row.timestamp);
  if (isNaN(ts.getTime())) {
    logger.warn('Skipping cold insert — invalid timestamp', { id: row.id, timestamp: row.timestamp });
    return false;
  }
  const db = getColdDb(root, ts.getUTCFullYear(), ts.getUTCMonth() + 1);
  const result = db.prepare(`
    INSERT OR IGNORE INTO cold_timeline_events (
      id, type, timestamp, end_timestamp, title, summary, source_path,
      entities_json, topics_json, tags_json,
      priority, decay_score, last_accessed, access_count,
      project_id, classification, connection_id, source_did,
      metrics_json, outcome, outcome_confidence, outcome_evidence, outcome_annotated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.type, row.timestamp, row.end_timestamp, row.title, row.summary, row.source_path,
    row.entities_json, row.topics_json, row.tags_json,
    row.priority, row.decay_score, row.last_accessed, row.access_count,
    row.project_id, row.classification, row.connection_id, row.source_did,
    row.metrics_json, row.outcome, row.outcome_confidence, row.outcome_evidence, row.outcome_annotated_at,
  );
  return result.changes > 0;
}

/**
 * LIKE-based search across every cold DB. Returns matches across
 * months sorted by timestamp DESC. Caller passes a fuzzy query
 * (already lowercased / cleaned); cold storage is a fallback for
 * primary FTS, not a primary search engine.
 */
export function searchColdEvents(
  root: string,
  query: string,
  opts: { limit?: number; after?: string; before?: string } = {},
): ColdEvent[] {
  const limit = opts.limit ?? 50;
  const files = listColdFiles(root);
  if (files.length === 0) return [];

  const out: ColdEvent[] = [];
  const like = `%${query.toLowerCase().replace(/[%_]/g, '')}%`;
  for (const f of files) {
    // Cheap pre-filter by month range when caller supplied date bounds
    if (opts.after) {
      const a = new Date(opts.after);
      const fStart = new Date(Date.UTC(f.year, f.month - 1, 1));
      const fEnd = new Date(Date.UTC(f.year, f.month, 1));
      if (fEnd <= a) continue;
      void fStart;
    }
    if (opts.before) {
      const b = new Date(opts.before);
      const fStart = new Date(Date.UTC(f.year, f.month - 1, 1));
      if (fStart >= b) continue;
    }
    const db = getColdDb(root, f.year, f.month);
    const params: unknown[] = [like, like];
    let sql = `SELECT * FROM cold_timeline_events
               WHERE lower(title) LIKE ? OR lower(coalesce(summary,'')) LIKE ?`;
    if (opts.after) { sql += ` AND timestamp >= ?`; params.push(opts.after); }
    if (opts.before) { sql += ` AND timestamp < ?`; params.push(opts.before); }
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as ColdEvent[];
    out.push(...rows);
    if (out.length >= limit) break;
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return out.slice(0, limit);
}

/**
 * Find a cold event by id across all cold DBs (used by `kyberbot brain
 * restore`).
 */
export function findColdEvent(root: string, eventId: number): { event: ColdEvent; year: number; month: number } | null {
  for (const f of listColdFiles(root)) {
    const db = getColdDb(root, f.year, f.month);
    const row = db.prepare('SELECT * FROM cold_timeline_events WHERE id = ?').get(eventId) as ColdEvent | undefined;
    if (row) return { event: row, year: f.year, month: f.month };
  }
  return null;
}

/**
 * Delete a cold row by id (used during restore — after copying back
 * to primary, the cold copy is removed so we don't double-count on
 * future searches).
 */
export function deleteColdEvent(root: string, year: number, month: number, eventId: number): void {
  const db = getColdDb(root, year, month);
  db.prepare('DELETE FROM cold_timeline_events WHERE id = ?').run(eventId);
}

/**
 * Summary used by `kyberbot brain status` and tests.
 */
export function getColdStats(root: string): { months: number; events: number } {
  const files = listColdFiles(root);
  let events = 0;
  for (const f of files) {
    const db = getColdDb(root, f.year, f.month);
    const row = db.prepare('SELECT COUNT(*) AS c FROM cold_timeline_events').get() as { c: number };
    events += row.c;
  }
  return { months: files.length, events };
}
