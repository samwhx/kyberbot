/**
 * Archive step — move tier=archive rows out of primary timeline.db
 * into data/cold/YYYY-MM.db.
 *
 * Selection criteria:
 *   - tier = 'archive'
 *   - last_accessed > archiveMinDays days ago (or null and older than that)
 *   - is_pinned = 0
 *
 * Only runs once per archiveIntervalHours so the work doesn't repeat
 * inside hourly sleep cycles. The state is tracked in sleep_telemetry
 * with event_type='archive-run' so cross-restart cadence holds.
 */

import { createLogger } from '../../../logger.js';
import { getTimelineDb } from '../../timeline.js';
import { getSleepDb } from '../db.js';
import { insertColdEvent, type ColdEvent } from '../../cold-storage.js';
import { SleepConfig } from '../config.js';

const logger = createLogger('sleep:archive');

export interface ArchiveResult {
  count: number;
  processed: number;
  skippedRecent: boolean;
  errors: string[];
}

interface ArchiveRow extends Omit<ColdEvent, 'archived_at'> {}

export async function runArchiveStep(root: string, config: SleepConfig): Promise<ArchiveResult> {
  const errors: string[] = [];

  if (!config.enableArchive) {
    return { count: 0, processed: 0, skippedRecent: false, errors: [] };
  }

  // Gate by interval — bail out if we ran within the last N hours.
  const sleepDb = getSleepDb(root);
  const lastRow = sleepDb.prepare(`
    SELECT created_at FROM sleep_telemetry
    WHERE event_type = 'archive-run'
    ORDER BY created_at DESC LIMIT 1
  `).get() as { created_at: string } | undefined;

  if (lastRow) {
    const lastMs = new Date(lastRow.created_at).getTime();
    const minIntervalMs = config.archiveIntervalHours * 3600_000;
    if (Date.now() - lastMs < minIntervalMs) {
      logger.debug('Archive step skipped — last run within interval', { last: lastRow.created_at });
      return { count: 0, processed: 0, skippedRecent: true, errors: [] };
    }
  }

  const timeline = await getTimelineDb(root);
  const cutoffMs = Date.now() - config.archiveMinDays * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const candidates = timeline.prepare(`
    SELECT id, type, timestamp, end_timestamp, title, summary, source_path,
           entities_json, topics_json, tags_json,
           priority, decay_score, last_accessed, access_count,
           project_id, classification, connection_id, source_did,
           metrics_json, outcome, outcome_confidence, outcome_evidence, outcome_annotated_at
    FROM timeline_events
    WHERE tier = 'archive'
      AND is_pinned = 0
      AND (last_accessed IS NULL OR last_accessed < ?)
      AND timestamp < ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(cutoffIso, cutoffIso, config.archiveBatchSize) as ArchiveRow[];

  if (candidates.length === 0) {
    sleepDb.prepare(`
      INSERT INTO sleep_telemetry (step, event_type, count, metadata)
      VALUES ('archive', 'archive-run', 0, ?)
    `).run(JSON.stringify({ scanned: 0, archived: 0 }));
    return { count: 0, processed: 0, skippedRecent: false, errors: [] };
  }

  const deletePrepared = timeline.prepare('DELETE FROM timeline_events WHERE id = ?');
  let archived = 0;
  const txn = timeline.transaction((rows: ArchiveRow[]) => {
    for (const r of rows) {
      try {
        const inserted = insertColdEvent(root, r);
        if (inserted) {
          deletePrepared.run(r.id);
          archived++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`event ${r.id}: ${msg}`);
      }
    }
  });
  txn(candidates);

  sleepDb.prepare(`
    INSERT INTO sleep_telemetry (step, event_type, count, metadata)
    VALUES ('archive', 'archive-run', ?, ?)
  `).run(archived, JSON.stringify({ scanned: candidates.length, archived, errors }));

  logger.info('Archive step complete', { scanned: candidates.length, archived, errors: errors.length });
  return { count: archived, processed: candidates.length, skippedRecent: false, errors };
}
