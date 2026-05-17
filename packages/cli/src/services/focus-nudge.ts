/**
 * KyberBot — Focus Nudge
 *
 * Phase C of the focus synthesis system: a heartbeat-callable service
 * that re-runs focus synthesis with a fresh signal pull, compares the
 * urgent[] and valuable[] arrays against what was surfaced in the
 * previous cycle, and pings the user via `kyberbot notify` when a
 * NEW item appears (i.e., something we haven't already nudged about).
 *
 * Dedup is keyed by FocusItem.id (the LLM is instructed to produce
 * stable kebab-case slugs). Surfaced ids are persisted in
 * sleep_telemetry under event_type='focus-nudge-surfaced' so dedup
 * survives agent restarts.
 *
 * Hard thresholds prevent over-pinging:
 *   - 30 min minimum between nudges (configurable)
 *   - Only urgent[] and valuable[] qualify — topFocus alone does not
 *     trigger a nudge (it's the morning briefing's job)
 *   - The nudge body is at most 3 items; the rest are stored silently
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import { synthesizeFocus, type FocusItem, type FocusResult } from './focus-synthesis.js';
import { getSleepDb } from '../brain/sleep/db.js';

const logger = createLogger('focus-nudge');

const NUDGE_TELEMETRY_TYPE = 'focus-nudge-surfaced';
const NUDGE_RUN_TYPE = 'focus-nudge-run';
const DEFAULT_MIN_INTERVAL_MS = 30 * 60 * 1000;
const SURFACED_MEMORY_DAYS = 7;

export interface NudgeOptions {
  root: string;
  /** Minimum time between nudges. Default: 30 min. */
  minIntervalMs?: number;
  /** Max items to put in a single nudge message. Default: 3. */
  maxItemsPerNudge?: number;
  /** If true, don't actually send; return what would have been sent. */
  dryRun?: boolean;
}

export interface NudgeResult {
  fired: boolean;
  reason?: string;
  /** Items that would be in the message (or were, if fired). */
  surfaced: FocusItem[];
  /** Snippet of the notification body. */
  body?: string;
}

function lookupLastRun(root: string): { lastRunAt: number; surfacedIds: Set<string> } {
  const db = getSleepDb(root);
  // Most recent run timestamp
  const runRow = db.prepare(`
    SELECT created_at FROM sleep_telemetry
    WHERE event_type = ? ORDER BY created_at DESC LIMIT 1
  `).get(NUDGE_RUN_TYPE) as { created_at: string } | undefined;
  const lastRunAt = runRow ? new Date(runRow.created_at).getTime() : 0;

  // Recently surfaced ids (last N days)
  const cutoff = new Date(Date.now() - SURFACED_MEMORY_DAYS * 86_400_000).toISOString();
  const surfacedRows = db.prepare(`
    SELECT metadata FROM sleep_telemetry
    WHERE event_type = ? AND created_at >= ?
    ORDER BY created_at DESC
  `).all(NUDGE_TELEMETRY_TYPE, cutoff) as Array<{ metadata: string | null }>;
  const surfacedIds = new Set<string>();
  for (const row of surfacedRows) {
    if (!row.metadata) continue;
    try {
      const parsed = JSON.parse(row.metadata) as { ids?: string[] };
      for (const id of parsed.ids ?? []) surfacedIds.add(id);
    } catch { /* skip malformed */ }
  }
  return { lastRunAt, surfacedIds };
}

function recordSurfaced(root: string, ids: string[]): void {
  const db = getSleepDb(root);
  // Record the run regardless of whether we surfaced anything — the
  // run timestamp gates the next cycle's min-interval check.
  db.prepare(`
    INSERT INTO sleep_telemetry (step, event_type, count, metadata)
    VALUES ('focus-nudge', ?, ?, ?)
  `).run(NUDGE_RUN_TYPE, ids.length, JSON.stringify({ ids }));

  if (ids.length > 0) {
    db.prepare(`
      INSERT INTO sleep_telemetry (step, event_type, count, metadata)
      VALUES ('focus-nudge', ?, ?, ?)
    `).run(NUDGE_TELEMETRY_TYPE, ids.length, JSON.stringify({ ids }));
  }
}

function formatNudgeBody(items: FocusItem[]): string {
  const lines = ['Heads up — new since last check:', ''];
  for (const it of items) {
    const flag = it.urgency === 'now' ? '⚠️' : it.value === 'high' ? '✨' : '•';
    lines.push(`${flag} ${it.title}`);
    if (it.action) lines.push(`   → ${it.action}`);
  }
  return lines.join('\n').slice(0, 600);
}

function sendNotification(root: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn('kyberbot', ['notify', body], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => {
      logger.warn('kyberbot notify spawn error', { error: String(err) });
      resolve(false);
    });
    proc.on('close', (code) => {
      if (code !== 0) logger.warn('kyberbot notify exited non-zero', { code, stderr: stderr.slice(0, 200) });
      resolve(code === 0);
    });
    setTimeout(() => { try { proc.kill(); } catch {} }, 15_000);
  });
}

/**
 * Run one nudge cycle. Returns details of what happened — useful for
 * tests and for the heartbeat task to log meaningful telemetry.
 */
export async function runFocusNudge(opts: NudgeOptions): Promise<NudgeResult> {
  const root = opts.root;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxItems = opts.maxItemsPerNudge ?? 3;

  const { lastRunAt, surfacedIds } = lookupLastRun(root);
  const elapsed = Date.now() - lastRunAt;
  if (lastRunAt > 0 && elapsed < minIntervalMs) {
    return { fired: false, reason: `within min-interval (${Math.round(elapsed / 1000)}s since last)`, surfaced: [] };
  }

  let focus: FocusResult;
  try {
    // Force a refresh — proactive nudges should reflect the current world
    focus = await synthesizeFocus({ root, forceRefresh: true });
  } catch (err) {
    return { fired: false, reason: `synthesis failed: ${err instanceof Error ? err.message : String(err)}`, surfaced: [] };
  }

  // Candidate items: urgent[] + valuable[], in that priority order
  const candidates = [...focus.urgent, ...focus.valuable];
  const newCandidates = candidates.filter((it) => !surfacedIds.has(it.id));

  if (newCandidates.length === 0) {
    recordSurfaced(root, []);
    return { fired: false, reason: 'no new urgent/valuable items', surfaced: [] };
  }

  const surfaced = newCandidates.slice(0, maxItems);
  const body = formatNudgeBody(surfaced);

  if (opts.dryRun) {
    return { fired: false, reason: 'dry-run', surfaced, body };
  }

  const sent = await sendNotification(root, body);
  if (!sent) {
    return { fired: false, reason: 'notify failed', surfaced, body };
  }

  recordSurfaced(root, surfaced.map((it) => it.id));
  logger.info('Focus nudge fired', { count: surfaced.length, ids: surfaced.map((it) => it.id) });
  return { fired: true, surfaced, body };
}

void join;  // reserved for future config-file resolution
void createHash;  // reserved for future content-based dedup beyond id
