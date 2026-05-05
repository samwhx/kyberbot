import { describe, it, expect } from 'vitest';
import { __test } from './self-review.js';

const { DETECTORS } = __test;

interface FixtureReply {
  id: number;
  timestamp: string;
  title: string;
  summary?: string;
  entities?: string[];
  metrics?: any;
  outcome?: string | null;
  outcome_confidence?: number | null;
  outcome_evidence?: string;
}

function r(over: FixtureReply): any {
  return {
    id: over.id,
    timestamp: over.timestamp,
    title: over.title,
    summary: over.summary ?? '',
    entities: over.entities ?? [],
    metrics: over.metrics ?? { channel: 'telegram', latency_ms: 5000, reply_length_chars: 200 },
    outcome: over.outcome ?? null,
    outcome_confidence: over.outcome_confidence ?? null,
    outcome_evidence: over.outcome_evidence ?? '',
  };
}

describe('detectRepeatedCorrectionByEntity', () => {
  const det = DETECTORS.repeated_correction_entity;

  it('fires when ≥2 corrections cite the same entity', () => {
    const drafts = det([
      r({ id: 1, timestamp: '2026-05-06T10:00:00Z', title: '[telegram] Q1', entities: ['Disney'], outcome: 'correction', outcome_evidence: 'no, the cruise is friday' }),
      r({ id: 2, timestamp: '2026-05-06T11:00:00Z', title: '[telegram] Q2', entities: ['Disney'], outcome: 'correction', outcome_evidence: 'wrong, port is hong kong' }),
    ]);
    expect(drafts.length).toBe(1);
    expect(drafts[0].type).toBe('brain_note');
    expect(drafts[0].target_path).toContain('correction-disney');
    expect(drafts[0].evidence_event_ids).toEqual([1, 2]);
  });

  it('does NOT fire when only 1 correction', () => {
    const drafts = det([
      r({ id: 1, timestamp: '2026-05-06T10:00:00Z', title: '[telegram] Q1', entities: ['Disney'], outcome: 'correction' }),
    ]);
    expect(drafts).toHaveLength(0);
  });

  it('does NOT fire when corrections cite different entities', () => {
    const drafts = det([
      r({ id: 1, timestamp: '2026-05-06T10:00:00Z', title: 'Q1', entities: ['Disney'], outcome: 'correction' }),
      r({ id: 2, timestamp: '2026-05-06T11:00:00Z', title: 'Q2', entities: ['Singapore'], outcome: 'correction' }),
    ]);
    expect(drafts).toHaveLength(0);
  });
});

describe('detectVerboseReplyComplaint', () => {
  const det = DETECTORS.verbose_reply_complaint;

  it('fires on ≥2 corrections matching length keywords', () => {
    const drafts = det([
      r({ id: 1, timestamp: '2026-05-06T10:00:00Z', title: 'Q', outcome: 'correction', outcome_evidence: 'tldr please' }),
      r({ id: 2, timestamp: '2026-05-06T11:00:00Z', title: 'Q', outcome: 'correction', outcome_evidence: 'shorter response' }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].target_path).toBe('SOUL.md');
    expect(drafts[0].type).toBe('personality_tweak');
  });

  it('does NOT fire on corrections without length keywords', () => {
    const drafts = det([
      r({ id: 1, timestamp: '2026-05-06T10:00:00Z', title: 'Q', outcome: 'correction', outcome_evidence: 'no' }),
      r({ id: 2, timestamp: '2026-05-06T11:00:00Z', title: 'Q', outcome: 'correction', outcome_evidence: 'wrong' }),
    ]);
    expect(drafts).toHaveLength(0);
  });
});

describe('detectSkillFailureCluster', () => {
  const det = DETECTORS.skill_failure_cluster;

  it('fires when skill ran ≥2x with ≥50% correction rate', () => {
    const drafts = det([
      r({ id: 1, timestamp: '2026-05-06T10:00:00Z', title: 'Q1',
          metrics: { channel: 'telegram', tools_used: ['Bash(kyberbot:recall ...)'] },
          outcome: 'correction' }),
      r({ id: 2, timestamp: '2026-05-06T11:00:00Z', title: 'Q2',
          metrics: { channel: 'telegram', tools_used: ['Bash(kyberbot:recall ...)'] },
          outcome: 'correction' }),
      r({ id: 3, timestamp: '2026-05-06T12:00:00Z', title: 'Q3',
          metrics: { channel: 'telegram', tools_used: ['Bash(kyberbot:recall ...)'] },
          outcome: 'thanks' }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].target_path).toBe('skills/recall/SKILL.md');
    expect(drafts[0].type).toBe('skill_revision');
  });

  it('does NOT fire when fail-rate <50%', () => {
    const drafts = det([
      r({ id: 1, timestamp: '2026-05-06T10:00:00Z', title: 'Q1',
          metrics: { channel: 'telegram', tools_used: ['Bash(kyberbot:recall ...)'] },
          outcome: 'thanks' }),
      r({ id: 2, timestamp: '2026-05-06T11:00:00Z', title: 'Q2',
          metrics: { channel: 'telegram', tools_used: ['Bash(kyberbot:recall ...)'] },
          outcome: 'thanks' }),
      r({ id: 3, timestamp: '2026-05-06T12:00:00Z', title: 'Q3',
          metrics: { channel: 'telegram', tools_used: ['Bash(kyberbot:recall ...)'] },
          outcome: 'correction' }),
    ]);
    expect(drafts).toHaveLength(0);
  });

  it('ignores tool calls that are not kyberbot skills', () => {
    const drafts = det([
      r({ id: 1, timestamp: '2026-05-06T10:00:00Z', title: 'Q1',
          metrics: { channel: 'telegram', tools_used: ['Read', 'WebFetch'] },
          outcome: 'correction' }),
    ]);
    expect(drafts).toHaveLength(0);
  });
});

describe('detectSkillAlwaysSucceedsNeverUsed', () => {
  const det = DETECTORS.skill_always_succeeds_unused;

  it('fires when skill ran ≥10x with 0 thanks/corrections', () => {
    const replies = Array.from({ length: 10 }, (_, i) => r({
      id: i + 1,
      timestamp: `2026-05-06T${String(i).padStart(2, '0')}:00:00Z`,
      title: `Q${i}`,
      metrics: { channel: 'heartbeat', tools_used: ['Bash(kyberbot:morning-summary)'] },
      outcome: null,
    }));
    const drafts = det(replies);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].target_path).toContain('morning-summary');
  });

  it('does NOT fire when skill received any thanks or corrections', () => {
    const replies = Array.from({ length: 10 }, (_, i) => r({
      id: i + 1,
      timestamp: `2026-05-06T${String(i).padStart(2, '0')}:00:00Z`,
      title: `Q${i}`,
      metrics: { channel: 'telegram', tools_used: ['Bash(kyberbot:recall ...)'] },
      outcome: i === 0 ? 'thanks' : null,
    }));
    const drafts = det(replies);
    expect(drafts).toHaveLength(0);
  });

  it('does NOT fire when skill ran <10x', () => {
    const replies = Array.from({ length: 5 }, (_, i) => r({
      id: i + 1,
      timestamp: `2026-05-06T${String(i).padStart(2, '0')}:00:00Z`,
      title: `Q${i}`,
      metrics: { channel: 'heartbeat', tools_used: ['Bash(kyberbot:summary)'] },
      outcome: null,
    }));
    const drafts = det(replies);
    expect(drafts).toHaveLength(0);
  });
});

describe('detectCostOutlier', () => {
  const det = DETECTORS.cost_outlier;

  it('fires when ≥2 replies cost >10x median on the same channel', () => {
    const replies: any[] = [];
    // Median-establishing baseline (5 cheap replies)
    for (let i = 0; i < 5; i++) {
      replies.push(r({ id: i + 1, timestamp: `2026-05-06T${String(i).padStart(2, '0')}:00:00Z`,
        title: 'Q', metrics: { channel: 'telegram', cost_usd: 0.01 } }));
    }
    // 2 outliers
    replies.push(r({ id: 100, timestamp: '2026-05-06T20:00:00Z', title: 'Q',
      metrics: { channel: 'telegram', cost_usd: 0.50 } }));
    replies.push(r({ id: 101, timestamp: '2026-05-06T21:00:00Z', title: 'Q',
      metrics: { channel: 'telegram', cost_usd: 0.30 } }));

    const drafts = det(replies);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].target_path).toBe('identity.yaml');
  });

  it('does NOT fire on single outlier', () => {
    const replies: any[] = [];
    for (let i = 0; i < 5; i++) {
      replies.push(r({ id: i + 1, timestamp: `2026-05-06T${String(i).padStart(2, '0')}:00:00Z`,
        title: 'Q', metrics: { channel: 'telegram', cost_usd: 0.01 } }));
    }
    replies.push(r({ id: 100, timestamp: '2026-05-06T20:00:00Z', title: 'Q',
      metrics: { channel: 'telegram', cost_usd: 0.50 } }));

    const drafts = det(replies);
    expect(drafts).toHaveLength(0);
  });
});

describe('detectHeartbeatIgnored', () => {
  const det = DETECTORS.heartbeat_ignored;

  it('fires when 90%+ of heartbeat outputs are unreferenced', () => {
    const replies: any[] = [];
    for (let i = 0; i < 12; i++) {
      replies.push(r({
        id: i + 1,
        timestamp: `2026-05-06T${String(i).padStart(2, '0')}:00:00Z`,
        title: '[heartbeat] morning summary',
        entities: [`UnusedTopic${i}`],  // unique each time, never referenced
        metrics: { channel: 'heartbeat' },
      }));
    }
    const drafts = det(replies);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].target_path).toBe('HEARTBEAT.md');
  });

  it('does NOT fire when heartbeat outputs are referenced by user messages', () => {
    const replies: any[] = [];
    // 12 heartbeats all about "Disney"
    for (let i = 0; i < 12; i++) {
      replies.push(r({
        id: i + 1,
        timestamp: `2026-05-06T${String(i * 2).padStart(2, '0')}:00:00Z`,
        title: '[heartbeat] daily',
        entities: ['Disney'],
        metrics: { channel: 'heartbeat' },
      }));
    }
    // User reply mentioning Disney AFTER each heartbeat
    for (let i = 0; i < 12; i++) {
      replies.push(r({
        id: 100 + i,
        timestamp: `2026-05-06T${String(i * 2 + 1).padStart(2, '0')}:00:00Z`,
        title: '[telegram] tell me about Disney',
        entities: ['Disney'],
        metrics: { channel: 'telegram' },
      }));
    }
    const drafts = det(replies);
    expect(drafts).toHaveLength(0);
  });
});
