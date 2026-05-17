/**
 * Apply every brain store's pending SQLite migrations.
 *
 * Each store also self-migrates on first open (see entity-graph.ts,
 * timeline.ts, sleep/db.ts, messages.ts — each calls `applyMigrations`
 * during its connection bootstrap). This wrapper forces all four to
 * initialize in one shot so the `kyberbot agent migrate` command and the
 * `kyberbot` startup path both go through the same code.
 *
 * Failures are surfaced — the caller decides whether to abort the
 * startup or just log and continue.
 */

import { getEntityGraphDb } from './entity-graph.js';
import { getTimelineDb } from './timeline.js';
import { getSleepDb } from './sleep/db.js';
import { getMessagesDb } from './messages.js';
import { getDbVersion } from './db-migrate.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migrate-all');

export interface StoreVersion {
  name: string;
  version: number;
}

export async function applyAllPendingMigrations(root: string): Promise<StoreVersion[]> {
  const out: StoreVersion[] = [];

  out.push({ name: 'entity-graph', version: getDbVersion(await getEntityGraphDb(root)) });
  out.push({ name: 'timeline', version: getDbVersion(await getTimelineDb(root)) });
  out.push({ name: 'sleep', version: getDbVersion(getSleepDb(root)) });
  out.push({ name: 'messages', version: getDbVersion(getMessagesDb(root)) });

  logger.info('Brain store versions', Object.fromEntries(out.map(s => [s.name, s.version])));
  return out;
}
