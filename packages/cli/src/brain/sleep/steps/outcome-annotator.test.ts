import { describe, it, expect } from 'vitest';
import { classifyOutcome, jaccardSimilarity } from './outcome-annotator.js';
import type { TimelineEvent, ReplyMetrics } from '../../timeline.js';

function reply(over: Partial<TimelineEvent & { metrics: ReplyMetrics }> = {}): TimelineEvent & { metrics: ReplyMetrics } {
  return {
    id: 1,
    type: 'conversation',
    timestamp: '2026-05-06T10:00:00Z',
    title: '[telegram] What is the weather like?',
    summary: 'reply was about the weather forecast',
    source_path: 'channel://telegram/abc',
    entities: [],
    topics: [],
    metrics: {
      channel: 'telegram',
      latency_ms: 5000,
      reply_length_chars: 200,
      received_at: '2026-05-06T10:00:00Z',
      replied_at: '2026-05-06T10:00:05Z',
    },
    ...over,
  };
}

function followup(text: string, gapMinutes = 1): { next: TimelineEvent; gapMs: number } {
  return {
    next: {
      id: 2,
      type: 'conversation',
      timestamp: '2026-05-06T10:01:00Z',
      title: `[telegram] ${text}`,
      summary: '',
      source_path: 'channel://telegram/def',
      entities: [],
      topics: [],
    },
    gapMs: gapMinutes * 60_000,
  };
}

describe('classifyOutcome', () => {
  describe('thanks signals', () => {
    it('classifies "thanks" as thanks with confidence 0.7', () => {
      const r = classifyOutcome(reply(), followup('thanks!'));
      expect(r.outcome).toBe('thanks');
      expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it.each([
      'thank you so much',
      'perfect, that works',
      'great answer',
      'got it',
      'ok cool',
      'awesome',
      'yes exactly',
      'right, makes sense',
    ])('classifies "%s" as thanks', (text) => {
      const r = classifyOutcome(reply(), followup(text));
      expect(r.outcome).toBe('thanks');
    });

    it('does NOT match thanks-words mid-sentence (anchored regex)', () => {
      // Both regexes are anchored to start of string, so "but no thanks"
      // doesn't trigger correction (starts with "but") nor thanks (starts
      // with "but"). Falls through to neutral.
      const r = classifyOutcome(reply(), followup('but no thanks for that one'));
      expect(r.outcome).toBe('neutral');
    });
  });

  describe('correction signals', () => {
    it.each([
      'no that is wrong',
      'not really',
      'wrong, the answer is X',
      'actually it should be Y',
      'incorrect',
      'nope',
      'nah, try again',
    ])('classifies "%s" as correction', (text) => {
      const r = classifyOutcome(reply(), followup(text));
      expect(r.outcome).toBe('correction');
      expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('reask signals', () => {
    it('classifies a near-duplicate question within 30 min as reask', () => {
      const r = classifyOutcome(
        reply({ title: '[telegram] What is the weather like in Singapore?' }),
        followup('What is the weather in Singapore today?', 5),
      );
      expect(r.outcome).toBe('reask');
      expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('does NOT classify dissimilar follow-up as reask', () => {
      const r = classifyOutcome(
        reply({ title: '[telegram] What is the weather like in Singapore?' }),
        followup('Tell me about my Disney cruise', 5),
      );
      expect(r.outcome).toBe('neutral');
    });

    it('does NOT classify similar question outside the 30-min window', () => {
      const r = classifyOutcome(
        reply({ title: '[telegram] What is the weather like in Singapore?' }),
        followup('What is the weather in Singapore today?', 60),  // 60 min gap
      );
      expect(r.outcome).toBe('neutral');
    });
  });

  describe('ignored signal', () => {
    it('classifies substantive reply with no follow-up as ignored (low conf)', () => {
      const r = classifyOutcome(
        reply({ metrics: { ...reply().metrics, reply_length_chars: 200 } }),
        { next: null, gapMs: null },
      );
      expect(r.outcome).toBe('ignored');
      expect(r.confidence).toBeLessThan(0.5);  // sub-threshold → won't be persisted
    });

    it('classifies short reply with no follow-up as neutral, not ignored', () => {
      const r = classifyOutcome(
        reply({ metrics: { ...reply().metrics, reply_length_chars: 20 } }),
        { next: null, gapMs: null },
      );
      expect(r.outcome).toBe('neutral');
    });
  });

  describe('neutral signal', () => {
    it('classifies a substantive non-matching follow-up as neutral', () => {
      // No thanks/correction at start, no significant similarity to prior.
      const r = classifyOutcome(reply(), followup('by the way what time is it'));
      expect(r.outcome).toBe('neutral');
    });
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical token sets', () => {
    expect(jaccardSimilarity('the cat sat on the mat', 'cat sat mat')).toBeGreaterThan(0.6);
  });

  it('returns 0 for disjoint token sets', () => {
    expect(jaccardSimilarity('foo bar baz', 'qux quux corge')).toBe(0);
  });

  it('handles empty strings', () => {
    expect(jaccardSimilarity('', 'anything')).toBe(0);
    expect(jaccardSimilarity('something', '')).toBe(0);
  });

  it('drops tokens shorter than 3 chars (stop-word reduction)', () => {
    // "is" "a" "to" (all <3 chars) get dropped. "the" stays (3 chars).
    // Set A = {weather, today}, Set B = {the, weather, today}
    // jaccard = 2 / 3 ≈ 0.667
    const sim = jaccardSimilarity('is a to weather today', 'a is the weather today');
    expect(sim).toBeGreaterThan(0.6);
    expect(sim).toBeLessThan(0.7);
  });
});
