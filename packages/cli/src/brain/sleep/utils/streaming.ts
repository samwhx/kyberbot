/**
 * Sleep-step streaming helpers.
 *
 * Each maintenance step works by iterating rows from one of the brain
 * SQLite stores and updating them. At 100k+ events, loading the full
 * candidate set into a JS array hurts heap. These helpers page through
 * deterministically by primary-key id, holding at most `pageSize` rows
 * in memory at any moment.
 *
 * Two patterns:
 *
 *   pageById  — single-pass forward scan. Use when each row is
 *               touched independently and you don't care about
 *               resuming across cycles. Stops when handler returns
 *               STOP or the rows run out.
 *
 *   pageByIdWithCheckpoint — resumable scan across multiple cycles.
 *               Caller supplies a checkpoint key. The helper persists
 *               the last id processed in sleep_telemetry so a future
 *               cycle continues from there. On wraparound (rows
 *               exhausted), resets to 0.
 */

import type Database from 'libsql';

export type PageHandlerResult = void | 'STOP';

export interface PageOptions<Row> {
  pageSize?: number;
  /** Optional cap on total rows processed in this invocation. */
  maxRows?: number;
  /**
   * Optional sleep-yield function called between pages. Useful when
   * the surrounding heartbeat needs a chance to interrupt long scans.
   */
  yieldBetweenPages?: () => Promise<void> | void;
  /** Row mapper if SQLite returns a different shape than caller wants. */
  map?: (raw: any) => Row;
}

/**
 * Forward-scan a table by id. The provided SQL must include `WHERE id > ?`
 * (or equivalent), end with `ORDER BY id ASC LIMIT ?`, and have the
 * cursor + pageSize as its last two bound params.
 *
 *   pageById(db, 'SELECT id,title FROM x WHERE tier=? AND id > ? ORDER BY id ASC LIMIT ?',
 *     ['warm'], async (row) => { ... })
 *
 * Returns the number of rows processed.
 */
export async function pageById<Row extends { id: number }>(
  db: Database.Database,
  sql: string,
  fixedParams: unknown[],
  handler: (row: Row) => PageHandlerResult | Promise<PageHandlerResult>,
  opts: PageOptions<Row> = {},
): Promise<number> {
  const pageSize = opts.pageSize ?? 500;
  const maxRows = opts.maxRows ?? Infinity;
  let lastId = 0;
  let total = 0;

  const stmt = db.prepare(sql);

  while (total < maxRows) {
    const remaining = Math.min(pageSize, maxRows - total);
    const rawRows = stmt.all(...fixedParams, lastId, remaining) as any[];
    if (rawRows.length === 0) break;

    for (const raw of rawRows) {
      const row = (opts.map ? opts.map(raw) : raw) as Row;
      const out = await handler(row);
      total++;
      if (out === 'STOP') return total;
    }

    lastId = (rawRows[rawRows.length - 1] as { id: number }).id;
    if (rawRows.length < remaining) break;

    if (opts.yieldBetweenPages) await opts.yieldBetweenPages();
  }

  return total;
}

/**
 * Resumable variant — persists the cursor in sleep_telemetry under
 * event_type=`cursor:<key>` so the next cycle picks up where this
 * one left off. On wraparound (no more rows past lastId), the cursor
 * resets to 0 automatically so subsequent cycles re-scan from the top.
 *
 * Suitable for "decay" or "tag refresh" style passes where we want
 * eventual coverage across the whole table without ever scanning it
 * fully in one cycle.
 *
 * dataDb runs the SELECT (e.g. timeline.db, entity-graph.db).
 * cursorDb stores the checkpoint via sleep_telemetry — pass the same db
 * if your data lives in sleep.db itself.
 */
export async function pageByIdWithCheckpoint<Row extends { id: number }>(
  dataDb: Database.Database,
  cursorDb: Database.Database,
  cursorKey: string,
  sql: string,
  fixedParams: unknown[],
  handler: (row: Row) => PageHandlerResult | Promise<PageHandlerResult>,
  opts: PageOptions<Row> = {},
): Promise<{ processed: number; wrapped: boolean }> {
  // Read the current cursor (if any). We piggy-back on sleep_telemetry,
  // which already lives in sleep.db — no new table needed.
  const cursorRow = cursorDb.prepare(`
    SELECT metadata FROM sleep_telemetry
    WHERE event_type = ? ORDER BY created_at DESC LIMIT 1
  `).get(`cursor:${cursorKey}`) as { metadata: string | null } | undefined;

  let cursor = 0;
  try {
    cursor = cursorRow?.metadata ? Number(JSON.parse(cursorRow.metadata).lastId) : 0;
    if (!Number.isFinite(cursor)) cursor = 0;
  } catch {
    cursor = 0;
  }

  const pageSize = opts.pageSize ?? 500;
  const maxRows = opts.maxRows ?? Infinity;
  let total = 0;
  let lastId = cursor;
  let wrapped = false;

  const stmt = dataDb.prepare(sql);

  while (total < maxRows) {
    const remaining = Math.min(pageSize, maxRows - total);
    const rawRows = stmt.all(...fixedParams, lastId, remaining) as any[];

    if (rawRows.length === 0) {
      // Wrap to start of table for the next cycle.
      if (lastId !== 0) {
        wrapped = true;
        lastId = 0;
      }
      break;
    }

    for (const raw of rawRows) {
      const row = (opts.map ? opts.map(raw) : raw) as Row;
      const out = await handler(row);
      total++;
      if (out === 'STOP') {
        lastId = row.id;
        // Save cursor and bail
        cursorDb.prepare(`
          INSERT INTO sleep_telemetry (step, event_type, count, metadata)
          VALUES ('cursor', ?, ?, ?)
        `).run(`cursor:${cursorKey}`, total, JSON.stringify({ lastId }));
        return { processed: total, wrapped: false };
      }
    }

    lastId = (rawRows[rawRows.length - 1] as { id: number }).id;
    if (rawRows.length < remaining) break;

    if (opts.yieldBetweenPages) await opts.yieldBetweenPages();
  }

  cursorDb.prepare(`
    INSERT INTO sleep_telemetry (step, event_type, count, metadata)
    VALUES ('cursor', ?, ?, ?)
  `).run(`cursor:${cursorKey}`, total, JSON.stringify({ lastId }));

  return { processed: total, wrapped };
}
