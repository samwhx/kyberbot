import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseDuration, getRerankConfig } from './config.js';

describe('parseDuration', () => {
  it('should parse seconds', () => {
    expect(parseDuration('5s')).toBe(5_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1s')).toBe(1_000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('should parse hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('24h')).toBe(86_400_000);
  });

  it('should parse days', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('should throw on invalid format', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration');
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('30')).toThrow('Invalid duration');
    expect(() => parseDuration('30x')).toThrow('Invalid duration');
    expect(() => parseDuration('m30')).toThrow('Invalid duration');
  });
});

describe('getRerankConfig', () => {
  // getIdentity() throws when no agent root is detected; in this monorepo
  // test runner there is no agent dir, so the auto-resolution path falls
  // through to env-only. That's exactly the resolution chain we want to
  // exercise here.
  const origProvider = process.env.KYBERBOT_RERANK_PROVIDER;
  const origOpenai = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.KYBERBOT_RERANK_PROVIDER;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (origProvider !== undefined) process.env.KYBERBOT_RERANK_PROVIDER = origProvider;
    else delete process.env.KYBERBOT_RERANK_PROVIDER;
    if (origOpenai !== undefined) process.env.OPENAI_API_KEY = origOpenai;
    else delete process.env.OPENAI_API_KEY;
  });

  it('falls back to claude+haiku when nothing is configured', () => {
    expect(getRerankConfig()).toEqual({ provider: 'claude', model: 'haiku' });
  });

  it('auto-selects openai+gpt-5.4-nano when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(getRerankConfig()).toEqual({ provider: 'openai', model: 'gpt-5.4-nano' });
  });

  it('honors KYBERBOT_RERANK_PROVIDER=claude even when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.KYBERBOT_RERANK_PROVIDER = 'claude';
    expect(getRerankConfig()).toEqual({ provider: 'claude', model: 'haiku' });
  });

  it('honors KYBERBOT_RERANK_PROVIDER=openai when no key is set (will fail at API time)', () => {
    process.env.KYBERBOT_RERANK_PROVIDER = 'openai';
    expect(getRerankConfig()).toEqual({ provider: 'openai', model: 'gpt-5.4-nano' });
  });

  it('ignores unknown KYBERBOT_RERANK_PROVIDER values and falls through to auto', () => {
    process.env.KYBERBOT_RERANK_PROVIDER = 'gpt-9000';
    process.env.OPENAI_API_KEY = 'sk-test';
    // Unknown provider strings should not be accepted as `provider`; auto
    // detection takes over (here: openai because key is present).
    expect(getRerankConfig()).toEqual({ provider: 'openai', model: 'gpt-5.4-nano' });
  });
});
