/**
 * Outcome Annotator Step
 *
 * Tier 1 of self-learning. Reads recent reply events that have not yet
 * been annotated and classifies the user's reaction (the next message
 * from the same channel) as one of:
 *   thanks      — positive signal ("thanks", "perfect", "got it")
 *   correction  — negative signal ("no", "wrong", "actually")
 *   reask       — same/similar question repeated within 30 min
 *                  (signal: previous reply did not satisfy)
 *   ignored     — substantive reply, no follow-up within 6 hours
 *                  (low-confidence signal — could be "fine, no reply needed")
 *   neutral     — there was a follow-up but no signal matched
 *
 * Heuristics only — no LLM call. Cheap and deterministic. v1 accuracy
 * target: ~70%. Confidence < 0.5 → outcome left null (don't poison the
 * proposal feed with weak signals).
 *
 * See docs/self-learning-plan.md §3.4 for the rule table.
 */

import { createLogger } from '../../../logger.js';
import {
  getTimelineDb,
  getUnnannotatedReplies,
  setTimelineOutcome,
  TimelineEvent,
  ReplyMetrics,
  ReplyOutcome,
} from '../../timeline.js';
import { SleepConfig } from '../config.js';

const logger = createLogger('sleep:outcome-annotator');

// ── Heuristic constants (tuneable; see plan §3.4) ──────────────────────
const REASK_WINDOW_MS = 30 * 60_000;
const IGNORED_WINDOW_MS = 6 * 60 * 60_000;
const SUBSTANTIVE_REPLY_CHARS = 50;
const MIN_CONFIDENCE_TO_PERSIST = 0.5;
const MAX_EVENTS_PER_RUN = 200;

const THANKS_RE = /^\s*(thanks?|thank\s+you|perfect|great|nice|ok(?:ay)?|good|got\s+it|cool|awesome|yes\s*(?:exactly)?|exactly|right|correct)\b/i;
const CORRECTION_RE = /^\s*(no|not\b|wrong|actually|that'?s?\s+wrong|incorrect|nope|nah|negative|false)\b/i;

export interface OutcomeAnnotatorResult {
  scanned: number;
  annotated: number;
  by_outcome: Partial<Record<ReplyOutcome, number>>;
  skipped_low_confidence: number;
  errors?: string[];
}

interface FollowupCandidate {
  /** Next event from the same channel after the reply being classified. */
  next: TimelineEvent | null;
  /** Time gap in ms between the reply and the next follow-up. */
  gapMs: number | null;
}

export async function runOutcomeAnnotatorStep(
  root: string,
  _config: SleepConfig,
): Promise<OutcomeAnnotatorResult> {
  const result: OutcomeAnnotatorResult = {
    scanned: 0,
    annotated: 0,
    by_outcome: {},
    skipped_low_confidence: 0,
    errors: [],
  };

  const candidates = await getUnnannotatedReplies(root, MAX_EVENTS_PER_RUN);
  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  const db = await getTimelineDb(root);

  for (const reply of candidates) {
    try {
      const channel = reply.metrics.channel;
      if (!channel) continue;

      const followup = findNextChannelEvent(db, reply, channel);
      const { outcome, confidence, evidence } = classifyOutcome(reply, followup);

      // Always mark as annotated so we don't reprocess on every cycle.
      // Outcome may be null if confidence is too low.
      const persistedOutcome = confidence >= MIN_CONFIDENCE_TO_PERSIST ? outcome : null;
      await setTimelineOutcome(root, reply.id, persistedOutcome, confidence, evidence);

      if (persistedOutcome) {
        result.annotated += 1;
        result.by_outcome[persistedOutcome] = (result.by_outcome[persistedOutcome] ?? 0) + 1;
      } else {
        result.skipped_low_confidence += 1;
      }
    } catch (err) {
      const msg = `event=${reply.id}: ${String(err)}`;
      logger.warn('Failed to annotate event', { id: reply.id, error: String(err) });
      result.errors!.push(msg);
    }
  }

  if (result.errors!.length === 0) delete result.errors;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers (exported for unit testing)
// ─────────────────────────────────────────────────────────────────────────

export function classifyOutcome(
  reply: TimelineEvent & { metrics: ReplyMetrics },
  followup: FollowupCandidate,
): { outcome: ReplyOutcome; confidence: number; evidence: string } {
  // No follow-up at all within the ignored window → likely-ignored if the
  // reply was substantive enough to warrant one. Low confidence (could just
  // mean "thanks, no reply needed").
  if (!followup.next) {
    const replyLen = reply.metrics.reply_length_chars ?? reply.summary.length;
    if (replyLen >= SUBSTANTIVE_REPLY_CHARS) {
      return {
        outcome: 'ignored',
        confidence: 0.4,
        evidence: '(no follow-up within 6h, reply was substantive)',
      };
    }
    return {
      outcome: 'neutral',
      confidence: 0.35,
      evidence: '(no follow-up; reply was short — likely conversational close)',
    };
  }

  const followupText = extractTextFromEvent(followup.next).slice(0, 500);

  // Regex-based: thanks vs correction. Strong signals.
  if (CORRECTION_RE.test(followupText)) {
    return {
      outcome: 'correction',
      confidence: 0.75,
      evidence: snippet(followupText, 200),
    };
  }
  if (THANKS_RE.test(followupText)) {
    return {
      outcome: 'thanks',
      confidence: 0.7,
      evidence: snippet(followupText, 200),
    };
  }

  // Re-ask: follow-up is similar to the user's prior message in this same
  // conversation. Cheap proxy — entity overlap + word-set Jaccard ≥ 0.6,
  // within the re-ask time window. Avoids needing semantic embeddings here.
  if (followup.gapMs !== null && followup.gapMs <= REASK_WINDOW_MS) {
    const replyUserText = extractUserPromptFromTitle(reply.title);
    const similarity = jaccardSimilarity(replyUserText, followupText);
    if (similarity >= 0.6 && replyUserText.length > 0) {
      return {
        outcome: 'reask',
        confidence: 0.65,
        evidence: `similar to prior (jaccard=${similarity.toFixed(2)}): ${snippet(followupText, 150)}`,
      };
    }
  }

  return {
    outcome: 'neutral',
    confidence: 0.4,
    evidence: snippet(followupText, 150),
  };
}

/**
 * Find the next conversation event from the same channel that arrived
 * after the reply being classified.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findNextChannelEvent(
  db: any,
  reply: TimelineEvent,
  channel: string,
): FollowupCandidate {
  const channelTagPrefix = `[${channel}]`;
  const row = db
    .prepare(
      `SELECT * FROM timeline_events
        WHERE timestamp > ?
          AND title LIKE ?
        ORDER BY timestamp ASC
        LIMIT 1`
    )
    .get(reply.timestamp, `${channelTagPrefix}%`) as any;

  if (!row) {
    // Was a substantive reply ignored? Only flag as ignored if enough
    // time has passed since the reply for "no follow-up" to be conclusive.
    const replyAge = Date.now() - new Date(reply.timestamp).getTime();
    if (replyAge < IGNORED_WINDOW_MS) {
      // Too soon — leave annotation pending until next sleep cycle.
      return { next: null, gapMs: null };
    }
    return { next: null, gapMs: null };
  }

  const next: TimelineEvent = {
    id: row.id,
    type: row.type,
    timestamp: row.timestamp,
    title: row.title,
    summary: row.summary ?? '',
    source_path: row.source_path,
    entities: row.entities_json ? JSON.parse(row.entities_json) : [],
    topics: row.topics_json ? JSON.parse(row.topics_json) : [],
  };
  const gapMs = new Date(next.timestamp).getTime() - new Date(reply.timestamp).getTime();
  return { next, gapMs };
}

/**
 * Pull the user's text from a conversation event. Channel events are stored
 * with title `[channel] <prompt>` and summary containing both the prompt and
 * a snippet of the response. We try to recover just the user side.
 */
function extractTextFromEvent(event: TimelineEvent): string {
  // Title format: "[telegram] What's the weather like?" — strip the channel tag.
  const titleText = event.title.replace(/^\[\w+\]\s*/, '');
  if (titleText.length > 0) return titleText;
  return (event.summary ?? '').slice(0, 200);
}

function extractUserPromptFromTitle(title: string): string {
  return title.replace(/^\[\w+\]\s*/, '').trim();
}

/**
 * Word-set Jaccard similarity. Cheap proxy for "is this question similar to
 * the previous one?". Drops short words to reduce noise from "the/and/is".
 */
export function jaccardSimilarity(a: string, b: string): number {
  const aSet = new Set(tokenize(a));
  const bSet = new Set(tokenize(b));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersect = 0;
  for (const t of aSet) if (bSet.has(t)) intersect += 1;
  const union = aSet.size + bSet.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

function snippet(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}
