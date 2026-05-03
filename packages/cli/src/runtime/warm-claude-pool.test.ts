/**
 * Integration tests for WarmClaudePool. Uses a fake `claude` binary in
 * __fixtures__/fake-claude.mjs that speaks the stream-json protocol.
 * Pointed at via KYBERBOT_CLAUDE_BIN env override.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { WarmClaudePool, isWarmPoolEnabled, WarmTurnError } from './warm-claude-pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_CLAUDE = resolve(__dirname, '__fixtures__/fake-claude.mjs');

const TMP_CWD = resolve(__dirname, '..', '..');

beforeAll(() => {
  process.env.KYBERBOT_CLAUDE_BIN = FAKE_CLAUDE;
});

describe('isWarmPoolEnabled', () => {
  const origEnv = process.env.KYBERBOT_WARM_POOL;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.KYBERBOT_WARM_POOL;
    else process.env.KYBERBOT_WARM_POOL = origEnv;
  });

  it('respects KYBERBOT_WARM_POOL=1', () => {
    process.env.KYBERBOT_WARM_POOL = '1';
    expect(isWarmPoolEnabled()).toBe(true);
  });

  it('respects KYBERBOT_WARM_POOL=true', () => {
    process.env.KYBERBOT_WARM_POOL = 'true';
    expect(isWarmPoolEnabled()).toBe(true);
  });

  it('respects KYBERBOT_WARM_POOL=0 (overrides identity)', () => {
    process.env.KYBERBOT_WARM_POOL = '0';
    expect(isWarmPoolEnabled(true)).toBe(false);
  });

  it('falls back to identity setting when env unset', () => {
    delete process.env.KYBERBOT_WARM_POOL;
    expect(isWarmPoolEnabled(true)).toBe(true);
    expect(isWarmPoolEnabled(false)).toBe(false);
    expect(isWarmPoolEnabled()).toBe(false);
  });
});

describe('WarmClaudePool', () => {
  let pool: WarmClaudePool;

  beforeEach(() => {
    pool = new WarmClaudePool();
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  const baseOpts = {
    cwd: TMP_CWD,
    toolPolicy: 'narrow' as const,
    model: 'fake',
    maxTurns: 5,
  };

  it('spawns a session and returns the result on first turn', async () => {
    const reply = await pool.turn('hello', {
      key: 'telegram:1',
      buildSystemPrompt: async () => 'static-prompt-A',
      ...baseOpts,
    });
    expect(reply).toBe('echo: hello');
    expect(pool.stats().active).toBe(1);
  });

  it('reuses the same session across multiple turns (no respawn)', async () => {
    const buildPrompt = async () => 'static-prompt-B';
    const r1 = await pool.turn('first', {
      key: 'telegram:2',
      buildSystemPrompt: buildPrompt,
      ...baseOpts,
    });
    const r2 = await pool.turn('second', {
      key: 'telegram:2',
      buildSystemPrompt: buildPrompt,
      ...baseOpts,
    });
    const r3 = await pool.turn('third', {
      key: 'telegram:2',
      buildSystemPrompt: buildPrompt,
      ...baseOpts,
    });
    expect(r1).toBe('echo: first');
    expect(r2).toBe('echo: second');
    expect(r3).toBe('echo: third');
    expect(pool.stats().active).toBe(1);
    const stats = pool.stats();
    expect(stats.sessions[0].turnCount).toBe(3);
  });

  it('recycles when the system prompt hash changes', async () => {
    let promptVersion = 'v1';
    const buildPrompt = async () => `static-${promptVersion}`;

    await pool.turn('one', {
      key: 'telegram:3',
      buildSystemPrompt: buildPrompt,
      ...baseOpts,
    });
    expect(pool.stats().sessions[0].turnCount).toBe(1);

    promptVersion = 'v2';
    await pool.turn('two', {
      key: 'telegram:3',
      buildSystemPrompt: buildPrompt,
      ...baseOpts,
    });
    const after = pool.stats().sessions[0];

    // After recycle, the session was respawned: turnCount on the NEW session
    // is 1 (just the second message). Without recycling it would be 2.
    expect(after.turnCount).toBe(1);
  });

  it('serializes concurrent turns via per-session mutex', async () => {
    process.env.FAKE_CLAUDE_DELAY_MS = '50';
    try {
      const buildPrompt = async () => 'static-prompt-C';
      const r1 = pool.turn('first', {
        key: 'telegram:4',
        buildSystemPrompt: buildPrompt,
        ...baseOpts,
      });
      const r2 = pool.turn('second', {
        key: 'telegram:4',
        buildSystemPrompt: buildPrompt,
        ...baseOpts,
      });
      const r3 = pool.turn('third', {
        key: 'telegram:4',
        buildSystemPrompt: buildPrompt,
        ...baseOpts,
      });
      const results = await Promise.all([r1, r2, r3]);
      expect(results).toEqual(['echo: first', 'echo: second', 'echo: third']);
      // All on the same session
      expect(pool.stats().active).toBe(1);
    } finally {
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
  });

  it('different keys get separate sessions', async () => {
    const buildPrompt = async () => 'static-prompt-D';
    await Promise.all([
      pool.turn('a', { key: 'telegram:5', buildSystemPrompt: buildPrompt, ...baseOpts }),
      pool.turn('b', { key: 'telegram:6', buildSystemPrompt: buildPrompt, ...baseOpts }),
      pool.turn('c', { key: 'whatsapp:7', buildSystemPrompt: buildPrompt, ...baseOpts }),
    ]);
    expect(pool.stats().active).toBe(3);
  });

  it('LRU evicts when pool exceeds 5 sessions', async () => {
    const buildPrompt = async () => 'static-prompt-E';
    for (let i = 0; i < 6; i++) {
      await pool.turn(`msg-${i}`, {
        key: `telegram:${100 + i}`,
        buildSystemPrompt: buildPrompt,
        ...baseOpts,
      });
    }
    // Pool capped at 5 — the LRU (telegram:100) was evicted.
    expect(pool.stats().active).toBe(5);
    const keys = pool.stats().sessions.map(s => s.key);
    expect(keys).not.toContain('telegram:100');
    expect(keys).toContain('telegram:105');
  });

  it('recovers when session crashes mid-turn', async () => {
    process.env.FAKE_CLAUDE_DIE_AT_TURN = '1';
    try {
      const buildPrompt = async () => 'static-prompt-F';
      await expect(pool.turn('crashy', {
        key: 'telegram:8',
        buildSystemPrompt: buildPrompt,
        ...baseOpts,
      })).rejects.toThrow(WarmTurnError);

      // The session was dropped after the crash — pool is empty.
      expect(pool.stats().active).toBe(0);
    } finally {
      delete process.env.FAKE_CLAUDE_DIE_AT_TURN;
    }

    // Next turn cold-spawns a fresh session and succeeds.
    const reply = await pool.turn('healthy', {
      key: 'telegram:8',
      buildSystemPrompt: async () => 'static-prompt-F',
      ...baseOpts,
    });
    expect(reply).toBe('echo: healthy');
    expect(pool.stats().active).toBe(1);
  });

  it('manual recycle kills and removes the session', async () => {
    const buildPrompt = async () => 'static-prompt-G';
    await pool.turn('one', {
      key: 'telegram:9',
      buildSystemPrompt: buildPrompt,
      ...baseOpts,
    });
    expect(pool.stats().active).toBe(1);

    pool.recycle('telegram:9');
    expect(pool.stats().active).toBe(0);

    // Next turn cold-spawns again
    const reply = await pool.turn('two', {
      key: 'telegram:9',
      buildSystemPrompt: buildPrompt,
      ...baseOpts,
    });
    expect(reply).toBe('echo: two');
  });

  it('shutdown kills all sessions', async () => {
    const buildPrompt = async () => 'static-prompt-H';
    await Promise.all([
      pool.turn('a', { key: 'telegram:10', buildSystemPrompt: buildPrompt, ...baseOpts }),
      pool.turn('b', { key: 'telegram:11', buildSystemPrompt: buildPrompt, ...baseOpts }),
    ]);
    expect(pool.stats().active).toBe(2);
    await pool.shutdown();
    expect(pool.stats().active).toBe(0);
  });
});
