/**
 * Self-Review — Tier 2 of self-learning.
 *
 * Reads the last 24h of annotated reply telemetry and runs a fixed set of
 * pattern detectors. Each detector that fires emits a `ProposalDraft`,
 * which gets persisted via `services/proposals.ts`.
 *
 * Runs once per day via the heartbeat task `self-review`. Designed to be
 * cheap — pure SQL aggregations over timeline_events. The only LLM call
 * is an optional one to phrase the proposal body (Haiku, ~$0.001 per
 * proposal, capped by `--max-drafts`).
 *
 * Pattern taxonomy: see docs/self-learning-plan.md §3.5.
 */

import { createLogger } from '../logger.js';
import { getTimelineDb, ReplyOutcome } from '../brain/timeline.js';
import { createProposal, ProposalDraft } from './proposals.js';

const logger = createLogger('self-review');

// ── Tuneables ──────────────────────────────────────────────────────────
const REVIEW_WINDOW_HOURS = 24;
const MIN_EVIDENCE = 2;             // see Q1: daily cadence + min ≥2 evidence
const SKILL_FAILURE_RATIO = 0.5;    // skill fail-rate threshold

export interface SelfReviewResult {
  scanned: number;
  patterns_fired: Record<string, number>;
  proposals_drafted: number;
  errors?: string[];
}

interface RecentReply {
  id: number;
  timestamp: string;
  title: string;
  summary: string;
  entities: string[];
  metrics: { latency_ms?: number; reply_length_chars?: number; channel?: string; cost_usd?: number; tools_used?: string[] };
  outcome: ReplyOutcome | null;
  outcome_confidence: number | null;
  outcome_evidence: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────

export async function runSelfReview(root: string): Promise<SelfReviewResult> {
  const result: SelfReviewResult = {
    scanned: 0,
    patterns_fired: {},
    proposals_drafted: 0,
    errors: [],
  };

  const replies = await loadRecentReplies(root, REVIEW_WINDOW_HOURS);
  result.scanned = replies.length;
  if (replies.length === 0) return result;

  const drafts: ProposalDraft[] = [];

  // Run each detector. Each returns 0..N drafts.
  for (const [name, detector] of Object.entries(DETECTORS)) {
    try {
      const fired = detector(replies);
      if (fired.length > 0) {
        result.patterns_fired[name] = fired.length;
        drafts.push(...fired);
      }
    } catch (err) {
      const msg = `detector=${name}: ${String(err)}`;
      logger.warn('Detector threw', { detector: name, error: String(err) });
      result.errors!.push(msg);
    }
  }

  // Persist each draft as a proposal file (also auto-commits to git).
  for (const draft of drafts) {
    try {
      createProposal(root, draft);
      result.proposals_drafted += 1;
    } catch (err) {
      result.errors!.push(`createProposal failed: ${String(err)}`);
    }
  }

  if (result.errors!.length === 0) delete result.errors;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Data loader
// ─────────────────────────────────────────────────────────────────────────

async function loadRecentReplies(root: string, windowHours: number): Promise<RecentReply[]> {
  const db = await getTimelineDb(root);
  const cutoff = new Date(Date.now() - windowHours * 60 * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, timestamp, title, summary, entities_json, metrics_json,
              outcome, outcome_confidence, outcome_evidence
         FROM timeline_events
        WHERE metrics_json IS NOT NULL
          AND timestamp >= ?
        ORDER BY timestamp ASC`
    )
    .all(cutoff) as any[];
  return rows.map((r): RecentReply => ({
    id: r.id,
    timestamp: r.timestamp,
    title: r.title,
    summary: r.summary ?? '',
    entities: r.entities_json ? JSON.parse(r.entities_json) : [],
    metrics: r.metrics_json ? JSON.parse(r.metrics_json) : {},
    outcome: r.outcome ?? null,
    outcome_confidence: r.outcome_confidence ?? null,
    outcome_evidence: r.outcome_evidence ?? '',
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Detectors — each returns ProposalDraft[].
// Detectors are pure functions of the recent-replies window for testability.
// ─────────────────────────────────────────────────────────────────────────

type Detector = (replies: RecentReply[]) => ProposalDraft[];

/**
 * Pattern 1: Repeated correction in same topic (entity overlap).
 * If ≥2 corrections cite the same entity → propose related skill/persona edit.
 */
const detectRepeatedCorrectionByEntity: Detector = (replies) => {
  const corrections = replies.filter(r => r.outcome === 'correction');
  if (corrections.length < MIN_EVIDENCE) return [];

  const byEntity = new Map<string, RecentReply[]>();
  for (const c of corrections) {
    for (const e of c.entities) {
      if (!byEntity.has(e)) byEntity.set(e, []);
      byEntity.get(e)!.push(c);
    }
  }

  const drafts: ProposalDraft[] = [];
  for (const [entity, hits] of byEntity) {
    if (hits.length < MIN_EVIDENCE) continue;
    drafts.push({
      type: 'brain_note',
      target_path: `brain/notes/correction-${slug(entity)}.md`,
      title: `Capture corrections about "${entity}"`,
      why: [
        `${hits.length} corrections about "${entity}" in last ${REVIEW_WINDOW_HOURS}h.`,
        'Common pattern across them: ' + summarizeEvidence(hits),
        'Suggest documenting the corrected facts so future replies use them.',
      ].join('\n- '),
      diff: makeNewFileDiff(
        `brain/notes/correction-${slug(entity)}.md`,
        `# Corrections about ${entity}\n\n` +
        `(populated by self-review on ${new Date().toISOString().slice(0, 10)})\n\n` +
        hits.map((h, i) => `${i + 1}. ${h.outcome_evidence}`).join('\n'),
      ),
      priority: Math.min(0.5 + hits.length * 0.1, 0.9),
      evidence_event_ids: hits.map(h => h.id),
      risk: 'low — additive note, not an edit to existing files',
    });
  }
  return drafts;
};

/**
 * Pattern 2: Verbose-reply complaint.
 * Triggered when corrections contain "shorter/tldr/verbose" AND median
 * reply length is trending up. Proposes a SOUL.md tone tweak.
 */
const detectVerboseReplyComplaint: Detector = (replies) => {
  const lengthComplaints = replies.filter(r =>
    r.outcome === 'correction' &&
    /\b(shorter|tldr|tl;dr|verbose|too long|less)\b/i.test(r.outcome_evidence)
  );
  if (lengthComplaints.length < MIN_EVIDENCE) return [];

  const lengths = replies
    .map(r => r.metrics.reply_length_chars)
    .filter((n): n is number => typeof n === 'number');
  const median = lengths.length > 0 ? medianOf(lengths) : 0;

  return [{
    type: 'personality_tweak',
    target_path: 'SOUL.md',
    title: 'Tighten reply tone (multiple "shorter" corrections)',
    why: [
      `${lengthComplaints.length} corrections in last ${REVIEW_WINDOW_HOURS}h asked for shorter / less verbose replies.`,
      `Median reply length this window: ${median} chars.`,
      `Sample evidence: ${lengthComplaints[0].outcome_evidence.slice(0, 100)}`,
    ].join('\n- '),
    // Heuristic: append a tone instruction. The actual SOUL.md edit is best
    // done by hand — this proposal points at the file and gives the user
    // a starting diff to refine.
    diff: '(this is a placeholder — review SOUL.md manually and add a "Reply length" guideline)\n',
    priority: 0.7,
    evidence_event_ids: lengthComplaints.map(c => c.id),
    risk: 'medium — affects every reply, but reversible via git tag',
  }];
};

/**
 * Pattern 3: Skill failure cluster.
 * If a skill (visible via tools_used) is invoked ≥2x in the window AND
 * a fail-rate proxy (corrections after invocation) ≥50%, propose revising
 * the skill.
 *
 * Fail-rate proxy: a "skill failure" is a reply where tools_used includes
 * a Bash(kyberbot:<skill>) call AND outcome=correction.
 */
const detectSkillFailureCluster: Detector = (replies) => {
  const drafts: ProposalDraft[] = [];
  const skillStats = new Map<string, { total: number; corrections: number; ids: number[] }>();
  for (const r of replies) {
    const tools = r.metrics.tools_used ?? [];
    for (const tool of tools) {
      const m = tool.match(/^Bash\(kyberbot:([\w-]+)/);
      if (!m) continue;
      const skill = m[1];
      if (!skillStats.has(skill)) skillStats.set(skill, { total: 0, corrections: 0, ids: [] });
      const s = skillStats.get(skill)!;
      s.total += 1;
      s.ids.push(r.id);
      if (r.outcome === 'correction') s.corrections += 1;
    }
  }
  for (const [skill, s] of skillStats) {
    if (s.total < MIN_EVIDENCE) continue;
    const failRate = s.corrections / s.total;
    if (failRate < SKILL_FAILURE_RATIO) continue;
    drafts.push({
      type: 'skill_revision',
      target_path: `skills/${skill}/SKILL.md`,
      title: `Revise skill "${skill}" — ${Math.round(failRate * 100)}% correction rate`,
      why: [
        `${skill} ran ${s.total}x in ${REVIEW_WINDOW_HOURS}h with ${s.corrections} corrections (${Math.round(failRate * 100)}% fail-rate).`,
        'Consider tightening the SKILL.md instructions or adding a verification step.',
      ].join('\n- '),
      diff: '(placeholder — review skills/' + skill + '/SKILL.md and tighten the When-to-Fire / verification rules)\n',
      priority: 0.6 + failRate * 0.3,
      evidence_event_ids: s.ids,
      risk: 'low — skill edits are reversible via git tag',
    });
  }
  return drafts;
};

/**
 * Pattern 4: Skill always succeeds but never used by output.
 * Skill ran ≥10x with 0 corrections AND no follow-up referenced its output
 * (proxy: no entity from the skill's invocation appears in next message).
 *
 * For v1 we approximate: skill ran ≥10x with 0 corrections AND 0 thanks.
 * Suggests the user is just running it without engaging with results.
 */
const detectSkillAlwaysSucceedsNeverUsed: Detector = (replies) => {
  const drafts: ProposalDraft[] = [];
  const skillStats = new Map<string, { total: number; thanks: number; corrections: number; ids: number[] }>();
  for (const r of replies) {
    const tools = r.metrics.tools_used ?? [];
    for (const tool of tools) {
      const m = tool.match(/^Bash\(kyberbot:([\w-]+)/);
      if (!m) continue;
      const skill = m[1];
      if (!skillStats.has(skill)) skillStats.set(skill, { total: 0, thanks: 0, corrections: 0, ids: [] });
      const s = skillStats.get(skill)!;
      s.total += 1;
      s.ids.push(r.id);
      if (r.outcome === 'thanks') s.thanks += 1;
      if (r.outcome === 'correction') s.corrections += 1;
    }
  }
  for (const [skill, s] of skillStats) {
    if (s.total < 10) continue;
    if (s.thanks > 0 || s.corrections > 0) continue;
    drafts.push({
      type: 'skill_revision',
      target_path: `skills/${skill}/SKILL.md`,
      title: `Reduce cadence or retire skill "${skill}" — invoked ${s.total}x with 0 engagement`,
      why: [
        `${skill} ran ${s.total}x in ${REVIEW_WINDOW_HOURS}h with no thanks/corrections.`,
        'Suggests the user neither actions nor pushes back on its output. May be noise.',
      ].join('\n- '),
      diff: '(placeholder — consider lowering the trigger conditions or retiring the skill entirely)\n',
      priority: 0.5,
      evidence_event_ids: s.ids,
      risk: 'low — proposal targets SKILL.md only',
    });
  }
  return drafts;
};

/**
 * Pattern 5: Heartbeat output ignored.
 * Heartbeat task ran AND no thanks-outcome AND its output not referenced
 * in next 24h. Proxy: timeline event with channel=heartbeat, no
 * downstream follow-up that mentions overlapping entities.
 */
const detectHeartbeatIgnored: Detector = (replies) => {
  const heartbeats = replies.filter(r => r.metrics.channel === 'heartbeat');
  if (heartbeats.length < MIN_EVIDENCE * 5) return [];  // higher bar — heartbeats run a lot

  // Did any subsequent user message in the window cite a heartbeat's entities?
  const userReplies = replies.filter(r => r.metrics.channel !== 'heartbeat');
  const referenced = new Set<number>();
  for (const hb of heartbeats) {
    for (const ur of userReplies) {
      if (ur.timestamp <= hb.timestamp) continue;
      if (hb.entities.some(e => ur.entities.includes(e))) {
        referenced.add(hb.id);
        break;
      }
    }
  }
  const ignored = heartbeats.filter(h => !referenced.has(h.id));
  if (ignored.length < heartbeats.length * 0.9) return [];

  return [{
    type: 'heartbeat_change',
    target_path: 'HEARTBEAT.md',
    title: `Lower heartbeat cadence — ${ignored.length}/${heartbeats.length} runs went unactioned`,
    why: [
      `Heartbeat ran ${heartbeats.length}x in ${REVIEW_WINDOW_HOURS}h.`,
      `${ignored.length} of those (${Math.round(ignored.length / heartbeats.length * 100)}%) had output that wasn't referenced in any user message.`,
      'Suggest lowering cadence or scoping tasks more tightly.',
    ].join('\n- '),
    diff: '(placeholder — review HEARTBEAT.md schedule and prune low-yield tasks)\n',
    priority: 0.6,
    evidence_event_ids: ignored.slice(0, 20).map(h => h.id),
    risk: 'low — pure deletion / cadence change',
  }];
};

/**
 * Pattern 6: Cost outlier.
 * A single reply costs >10x the median. Suggest model downgrade or
 * tighter prompt for that channel.
 */
const detectCostOutlier: Detector = (replies) => {
  const costs = replies
    .map(r => r.metrics.cost_usd)
    .filter((c): c is number => typeof c === 'number' && c > 0);
  if (costs.length < 5) return [];

  const median = medianOf(costs);
  const outliers = replies.filter(r => {
    const c = r.metrics.cost_usd;
    return typeof c === 'number' && c > median * 10;
  });
  if (outliers.length === 0) return [];

  // One proposal per channel that has outliers.
  const byChannel = new Map<string, RecentReply[]>();
  for (const o of outliers) {
    const ch = o.metrics.channel ?? 'unknown';
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(o);
  }
  const drafts: ProposalDraft[] = [];
  for (const [channel, hits] of byChannel) {
    if (hits.length < MIN_EVIDENCE) continue;
    drafts.push({
      type: 'identity_update',
      target_path: 'identity.yaml',
      title: `Investigate cost spike on ${channel} channel`,
      why: [
        `${hits.length} replies on ${channel} cost >10x the median ($${median.toFixed(4)}) in last ${REVIEW_WINDOW_HOURS}h.`,
        `Top cost: $${Math.max(...hits.map(h => h.metrics.cost_usd ?? 0)).toFixed(4)}`,
        'Consider lowering claude.model for this channel, or trimming system prompt.',
      ].join('\n- '),
      diff: '(placeholder — manual investigation needed; see metrics in timeline.db)\n',
      priority: 0.5,
      evidence_event_ids: hits.map(h => h.id),
      risk: 'medium — model change affects reply quality',
    });
  }
  return drafts;
};

// Pattern 7 (latency outlier) is intentionally NOT auto-proposed — flagged
// for human review only via the daily report. The detector is implemented
// for completeness but doesn't emit drafts.

const DETECTORS: Record<string, Detector> = {
  repeated_correction_entity: detectRepeatedCorrectionByEntity,
  verbose_reply_complaint: detectVerboseReplyComplaint,
  skill_failure_cluster: detectSkillFailureCluster,
  skill_always_succeeds_unused: detectSkillAlwaysSucceedsNeverUsed,
  heartbeat_ignored: detectHeartbeatIgnored,
  cost_outlier: detectCostOutlier,
};

// Test exports
export const __test = { DETECTORS, loadRecentReplies };

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function medianOf(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarizeEvidence(hits: RecentReply[]): string {
  if (hits.length === 0) return '';
  return hits
    .slice(0, 3)
    .map(h => h.outcome_evidence.slice(0, 80))
    .join('; ');
}

function makeNewFileDiff(targetPath: string, content: string): string {
  // Unified diff for a brand-new file. `git apply` accepts /dev/null source.
  const lines = content.split('\n');
  return [
    `--- /dev/null`,
    `+++ b/${targetPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(l => '+' + l),
  ].join('\n');
}
