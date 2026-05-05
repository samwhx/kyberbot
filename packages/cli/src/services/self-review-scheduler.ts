/**
 * Self-Review Scheduler — Tier 2 of self-learning.
 *
 * Fires `runSelfReview()` every 24h while Alfred is up. On each fire:
 *   1. Aggregate annotated telemetry from the last 24h.
 *   2. Run pattern detectors → ProposalDraft[] → brain/proposals/<id>.md.
 *   3. If any new proposals were drafted, push a notification through
 *      whichever channel can reach the owner (Telegram preferred).
 *
 * Gated by `KYBERBOT_SELF_LEARNING=1` env var OR
 * `identity.yaml: self_learning.enabled: true`. Default off.
 *
 * Runs in-process inside the kyberbot daemon; survives restarts (no
 * persistent timer state — interval restarts from boot, which is fine
 * for a daily cadence). On boot, fires its first review after a short
 * delay (60s) so we don't pile work onto a cold start.
 */

import { createLogger } from '../logger.js';
import { runSelfReview } from './self-review.js';
import type { ServiceHandle, IdentityConfig } from '../types.js';
import type { Channel } from '../server/channels/types.js';

const logger = createLogger('self-review-scheduler');

/** Interval between self-reviews. 24h = once per day. */
const REVIEW_INTERVAL_MS = 24 * 60 * 60_000;
/** Delay before the first review fires after boot — avoid piling on cold start. */
const FIRST_REVIEW_DELAY_MS = 60_000;

export function isSelfLearningEnabled(identity: IdentityConfig): boolean {
  const env = process.env.KYBERBOT_SELF_LEARNING;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  return !!identity.self_learning?.enabled;
}

export interface SelfReviewSchedulerOptions {
  /** Optional list of channels — used to notify owner when proposals exist. */
  channels?: Channel[];
  /** Owner's chat id / JID (channel-specific) — passed to channel.send(). */
  ownerTarget?: { telegram?: string | number; whatsapp?: string };
  /** For tests: override the interval. */
  intervalMs?: number;
  /** For tests: skip the boot delay and fire immediately. */
  fireImmediately?: boolean;
}

export function startSelfReviewScheduler(
  root: string,
  options: SelfReviewSchedulerOptions = {},
): ServiceHandle {
  const intervalMs = options.intervalMs ?? REVIEW_INTERVAL_MS;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const fireOnce = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runSelfReview(root);
      logger.info('self-review fired', {
        scanned: result.scanned,
        drafted: result.proposals_drafted,
        patterns: Object.keys(result.patterns_fired).length,
      });
      if (result.proposals_drafted > 0) {
        await notifyOwner(options, result.proposals_drafted);
      }
    } catch (err) {
      logger.error('self-review failed', { error: String(err) });
    }
  };

  const schedule = (): void => {
    timer = setInterval(() => { void fireOnce(); }, intervalMs);
  };

  if (options.fireImmediately) {
    void fireOnce();
    schedule();
  } else {
    setTimeout(() => {
      void fireOnce();
      schedule();
    }, FIRST_REVIEW_DELAY_MS).unref();
  }

  logger.info('self-review scheduler started', {
    intervalHours: intervalMs / 3600_000,
    fireImmediately: !!options.fireImmediately,
  });

  return {
    stop: async () => {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      logger.info('self-review scheduler stopped');
    },
    status: () => stopped ? 'stopped' : 'running',
  };
}

/**
 * Send a one-line ping through the highest-priority channel that can
 * reach the owner. Telegram preferred (most reliable), then WhatsApp.
 * Best-effort — failures are logged but don't propagate.
 */
async function notifyOwner(
  options: SelfReviewSchedulerOptions,
  count: number,
): Promise<void> {
  const channels = options.channels ?? [];
  const target = options.ownerTarget ?? {};

  const message = count === 1
    ? `1 self-review proposal pending — \`kyberbot proposals\` to review.`
    : `${count} self-review proposals pending — \`kyberbot proposals\` to review.`;

  const tg = channels.find(c => c.name === 'telegram' && c.isConnected());
  if (tg && target.telegram !== undefined) {
    try {
      await tg.send(String(target.telegram), message);
      logger.info('Notified owner via Telegram', { count });
      return;
    } catch (err) {
      logger.warn('Telegram notification failed', { error: String(err) });
    }
  }

  const wa = channels.find(c => c.name === 'whatsapp' && c.isConnected());
  if (wa && target.whatsapp) {
    try {
      await wa.send(target.whatsapp, message);
      logger.info('Notified owner via WhatsApp', { count });
      return;
    } catch (err) {
      logger.warn('WhatsApp notification failed', { error: String(err) });
    }
  }

  logger.info('Proposals drafted but no owner channel available', { count });
}
