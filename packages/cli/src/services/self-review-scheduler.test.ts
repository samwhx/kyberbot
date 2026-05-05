import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSelfLearningEnabled } from './self-review-scheduler.js';
import type { IdentityConfig } from '../types.js';

describe('isSelfLearningEnabled', () => {
  const origEnv = process.env.KYBERBOT_SELF_LEARNING;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.KYBERBOT_SELF_LEARNING;
    else process.env.KYBERBOT_SELF_LEARNING = origEnv;
  });

  function id(over: Partial<IdentityConfig> = {}): IdentityConfig {
    return {
      agent_name: 'Test',
      agent_description: 'test',
      timezone: 'UTC',
      heartbeat_interval: '1h',
      ...over,
    } as IdentityConfig;
  }

  it('respects KYBERBOT_SELF_LEARNING=1 (overrides identity false)', () => {
    process.env.KYBERBOT_SELF_LEARNING = '1';
    expect(isSelfLearningEnabled(id({ self_learning: { enabled: false } }))).toBe(true);
  });

  it('respects KYBERBOT_SELF_LEARNING=true', () => {
    process.env.KYBERBOT_SELF_LEARNING = 'true';
    expect(isSelfLearningEnabled(id())).toBe(true);
  });

  it('respects KYBERBOT_SELF_LEARNING=0 (overrides identity true)', () => {
    process.env.KYBERBOT_SELF_LEARNING = '0';
    expect(isSelfLearningEnabled(id({ self_learning: { enabled: true } }))).toBe(false);
  });

  it('falls back to identity.self_learning.enabled when env unset', () => {
    delete process.env.KYBERBOT_SELF_LEARNING;
    expect(isSelfLearningEnabled(id({ self_learning: { enabled: true } }))).toBe(true);
    expect(isSelfLearningEnabled(id({ self_learning: { enabled: false } }))).toBe(false);
    expect(isSelfLearningEnabled(id())).toBe(false);
  });
});
