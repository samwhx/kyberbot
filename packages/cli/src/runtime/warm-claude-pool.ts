/**
 * KyberBot — Warm Claude Subprocess Pool
 *
 * Keeps long-lived `claude --print --input-format stream-json` subprocesses
 * alive between channel turns so we don't pay the ~3-5s CLI startup +
 * model-init cost on every reply. After the first (cold) message in a
 * conversation, subsequent messages are served by the same warm process
 * for ~1.5s instead of ~5-7s.
 *
 * Sessions are keyed by `${channel}:${conversationId}` so each Telegram
 * chatId / WhatsApp JID / web browser session has its own warm process.
 *
 * Architecture and protocol verification documented in
 * docs/warm-claude-pool-plan.md.
 *
 * SAFETY:
 * - Per-session mutex serializes turns on a single stdin (no interleaving).
 * - System prompt is hashed at spawn; if it later changes (USER.md edit,
 *   skill install) the session is recycled on next turn.
 * - Hard recycle every 50 turns / 4 hours to bound context window growth.
 * - Idle eviction at 30 min frees RAM.
 * - Any error → mark session DEAD, throw a recoverable error so caller
 *   can retry once with a fresh spawn.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { createLogger } from '../logger.js';
import { ToolPolicy } from '../claude.js';

const logger = createLogger('warm-pool');

// ───────────────────────────────────────────────────────────────────────────
// CONSTANTS — all in ms unless noted
// ───────────────────────────────────────────────────────────────────────────

/** Per-turn timeout. Beyond this we kill+respawn, throw. */
const TURN_TIMEOUT_MS = 60_000;
/** Idle eviction threshold. */
const IDLE_TIMEOUT_MS = 30 * 60_000;
/** Hard recycle by age. */
const MAX_AGE_MS = 4 * 60 * 60_000;
/** Hard recycle by turn count. */
const MAX_TURNS_PER_SESSION = 50;
/** Stdout cap per turn. */
const MAX_TURN_STDOUT_BYTES = 4 * 1024 * 1024;
/** LRU eviction trigger. */
const MAX_POOL_SESSIONS = 5;
/** Period for the eviction sweep. */
const EVICTION_INTERVAL_MS = 5 * 60_000;
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;

// Tool allow-lists are duplicated from claude.ts on purpose: claude.ts owns
// the current one-shot policy; the pool needs to set the same flags at spawn.
const TOOL_POLICY_ALLOWLIST: Record<Exclude<ToolPolicy, 'owner'>, string> = {
  none: '',
  narrow: 'Read,Glob,Grep,WebFetch,WebSearch,Skill',
  broad: 'Read,Glob,Grep,WebFetch,WebSearch,Skill,Write,Edit,NotebookEdit,Bash(kyberbot:*)',
};

// ───────────────────────────────────────────────────────────────────────────
// TYPES
// ───────────────────────────────────────────────────────────────────────────

export type SessionKey = string;

export interface WarmTurnOptions {
  /** Stable session key, e.g. `telegram:12345`. */
  key: SessionKey;
  /** Lazy builder — only invoked when a cold spawn is needed. Must be byte-stable. */
  buildSystemPrompt: () => Promise<string>;
  /** Working directory for the spawned claude process. */
  cwd: string;
  /** Tool policy — same semantics as claude.ts. */
  toolPolicy: ToolPolicy;
  /** Model name (haiku/sonnet/opus). Resolved by caller. */
  model: string;
  /** maxTurns per user message. */
  maxTurns: number;
  /** Optional streaming callback (text content blocks). */
  onChunk?: (chunk: string) => void;
}

export interface PoolStats {
  active: number;
  sessions: Array<{
    key: string;
    ageMs: number;
    idleMs: number;
    turnCount: number;
    state: string;
  }>;
}

/**
 * Recoverable error — caller may retry with a fresh session.
 */
export class WarmTurnError extends Error {
  constructor(message: string, readonly recoverable: boolean = true) {
    super(message);
    this.name = 'WarmTurnError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// WarmSession — one long-lived claude process
// ───────────────────────────────────────────────────────────────────────────

interface WarmSessionConfig {
  key: SessionKey;
  systemPrompt: string;
  systemPromptHash: string;
  model: string;
  cwd: string;
  toolPolicy: ToolPolicy;
  maxTurns: number;
}

class WarmSession {
  readonly key: SessionKey;
  readonly systemPromptHash: string;
  readonly cwd: string;
  readonly toolPolicy: ToolPolicy;
  readonly spawnedAt: number;

  private proc: ChildProcessWithoutNullStreams;
  private state: 'NEW' | 'READY' | 'BUSY' | 'DEAD' = 'NEW';
  private lastUsedAt: number;
  private turnCount = 0;
  private mutexTail: Promise<void> = Promise.resolve();
  private initPromise: Promise<void>;

  constructor(cfg: WarmSessionConfig) {
    this.key = cfg.key;
    this.systemPromptHash = cfg.systemPromptHash;
    this.cwd = cfg.cwd;
    this.toolPolicy = cfg.toolPolicy;
    this.spawnedAt = Date.now();
    this.lastUsedAt = this.spawnedAt;

    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--system-prompt', cfg.systemPrompt,
      '--model', cfg.model,
      '--max-turns', String(cfg.maxTurns),
    ];

    if (cfg.toolPolicy === 'owner') {
      args.push('--dangerously-skip-permissions');
    } else {
      const allowed = TOOL_POLICY_ALLOWLIST[cfg.toolPolicy];
      if (allowed) {
        args.push('--allowedTools', allowed);
      }
    }

    // KYBERBOT_CLAUDE_BIN lets tests substitute a fake claude binary.
    // Production should leave this unset so PATH resolution finds the real `claude`.
    const claudeBin = process.env.KYBERBOT_CLAUDE_BIN || 'claude';
    this.proc = spawn(claudeBin, args, {
      env: {
        ...process.env,
        CLAUDECODE: '',
        CLAUDE_CODE_ENTRYPOINT: '',
      },
      cwd: cfg.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Surface unexpected exits so any in-flight turn fails fast.
    this.proc.on('exit', (code, signal) => {
      const wasDead = this.state === 'DEAD';
      this.state = 'DEAD';
      if (!wasDead) {
        logger.warn('warm session exited', { key: this.key, code, signal });
      }
    });

    this.proc.on('error', (err) => {
      this.state = 'DEAD';
      logger.warn('warm session proc error', { key: this.key, error: String(err) });
    });

    // Drain stderr so the kernel buffer never fills.
    this.proc.stderr.on('data', (data: Buffer) => {
      const s = data.toString().trim();
      if (s) logger.debug('warm session stderr', { key: this.key, line: s.slice(0, 300) });
    });

    // Claude Code ≥ 2.x only emits the `system/init` event AFTER it
    // receives the first user message on stdin. Older versions emitted
    // it on spawn. Waiting-for-init before sending a turn deadlocks on
    // current claude builds, so we treat the session as READY the
    // moment the process is spawned. Early-exit detection still kicks
    // in via the constructor's `exit` listener (sets state=DEAD).
    // The init event still arrives mid-turn; runOneTurn ignores
    // anything that isn't `assistant` or `result`, so this is safe.
    this.state = 'READY';
    this.initPromise = Promise.resolve();
  }

  /** Resolves once the process is initialized and ready for turns. */
  ready(): Promise<void> {
    return this.initPromise;
  }

  /** Send one user message, await its result event, return the assistant text. */
  async turn(userText: string, onChunk?: (text: string) => void): Promise<string> {
    // Mutex: chain on the existing tail so concurrent turns serialize.
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    const prev = this.mutexTail;
    this.mutexTail = prev.then(() => wait);
    await prev;

    try {
      if (this.state === 'DEAD') {
        throw new WarmTurnError('session is dead', true);
      }
      await this.initPromise;
      this.state = 'BUSY';
      this.turnCount += 1;
      this.lastUsedAt = Date.now();

      const result = await this.runOneTurn(userText, onChunk);
      this.lastUsedAt = Date.now();
      this.state = 'READY';
      return result;
    } catch (err) {
      // Any error in a turn → session is no longer trustworthy.
      // (Kill if still running; subsequent turns will spawn fresh.)
      this.markDeadAndKill();
      throw err;
    } finally {
      release();
    }
  }

  /**
   * Write the user event to stdin, parse stdout JSONL until we see a
   * matching `result` event for the same session. Times out at TURN_TIMEOUT_MS.
   */
  private runOneTurn(userText: string, onChunk?: (text: string) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let buf = '';
      let bytes = 0;
      let assistantText = '';
      let settled = false;

      const finish = (resolveValue?: string, rejectValue?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.proc.stdout.removeListener('data', onData);
        this.proc.removeListener('exit', onExit);
        if (rejectValue) reject(rejectValue);
        else resolve(resolveValue ?? '');
      };

      const timeout = setTimeout(() => {
        finish(undefined, new WarmTurnError(`turn timeout after ${TURN_TIMEOUT_MS}ms`, true));
      }, TURN_TIMEOUT_MS);

      const onData = (data: Buffer) => {
        bytes += data.length;
        if (bytes > MAX_TURN_STDOUT_BYTES) {
          finish(undefined, new WarmTurnError('turn stdout exceeded cap', true));
          return;
        }
        buf += data.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }

          // Stream assistant text blocks live for SSE / "first byte" UX
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                assistantText = block.text;     // last text block wins (consistent with claude.ts)
                if (onChunk) {
                  try { onChunk(block.text); } catch { /* ignore */ }
                }
              }
            }
          }

          if (ev.type === 'result') {
            const text = (ev.result && typeof ev.result === 'string') ? ev.result : assistantText;
            if (ev.is_error) {
              finish(undefined, new WarmTurnError(
                `claude reported error: ${String(text).slice(0, 200)}`,
                true
              ));
            } else {
              finish(text);
            }
            return;
          }
        }
      };

      const onExit = (code: number | null) => {
        finish(undefined, new WarmTurnError(`session exited mid-turn (code=${code})`, true));
      };

      this.proc.stdout.on('data', onData);
      this.proc.once('exit', onExit);

      // Encode the user message as a stream-json `user` event.
      const event = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: userText }],
        },
      }) + '\n';

      try {
        if (!this.proc.stdin.writable) {
          finish(undefined, new WarmTurnError('stdin not writable', true));
          return;
        }
        this.proc.stdin.write(event, (err) => {
          if (err) finish(undefined, new WarmTurnError(`stdin write failed: ${err.message}`, true));
        });
      } catch (err) {
        finish(undefined, new WarmTurnError(`stdin write threw: ${String(err)}`, true));
      }
    });
  }

  isStale(now = Date.now()): { stale: boolean; reason?: string } {
    if (this.state === 'DEAD') return { stale: true, reason: 'dead' };
    if (now - this.spawnedAt > MAX_AGE_MS) return { stale: true, reason: 'age' };
    if (this.turnCount >= MAX_TURNS_PER_SESSION) return { stale: true, reason: 'turn-count' };
    if (now - this.lastUsedAt > IDLE_TIMEOUT_MS) return { stale: true, reason: 'idle' };
    return { stale: false };
  }

  isIdle(now = Date.now()): boolean {
    return this.state !== 'BUSY' && (now - this.lastUsedAt > IDLE_TIMEOUT_MS);
  }

  isBusy(): boolean {
    return this.state === 'BUSY';
  }

  getLastUsedAt(): number { return this.lastUsedAt; }
  getTurnCount(): number { return this.turnCount; }
  getState(): string { return this.state; }

  markDeadAndKill(): void {
    if (this.state === 'DEAD' && this.proc.killed) return;
    this.state = 'DEAD';
    this.kill();
  }

  /** Polite SIGTERM, escalate to SIGKILL after grace period. */
  kill(): void {
    try {
      if (this.proc.exitCode === null && !this.proc.killed) {
        this.proc.stdin.end();   // signal clean shutdown first
        this.proc.kill('SIGTERM');
        setTimeout(() => {
          if (this.proc.exitCode === null && !this.proc.killed) {
            try { this.proc.kill('SIGKILL'); } catch { /* already dead */ }
          }
        }, KILL_GRACE_MS).unref();
      }
    } catch (err) {
      logger.debug('kill threw (likely already dead)', { key: this.key, error: String(err) });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// WarmClaudePool — singleton-style holder of warm sessions
// ───────────────────────────────────────────────────────────────────────────

export class WarmClaudePool {
  private sessions = new Map<SessionKey, WarmSession>();
  private evictTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.evictTimer = setInterval(() => this.evictIdle(), EVICTION_INTERVAL_MS);
    // Don't keep the event loop alive on this timer alone.
    if (this.evictTimer.unref) this.evictTimer.unref();
  }

  /**
   * Run one turn through the pool. Spawns a session if missing or stale.
   *
   * On a recoverable WarmTurnError, the session is recycled and the caller
   * is responsible for retrying or falling back to one-shot subprocess.
   */
  async turn(userText: string, opts: WarmTurnOptions): Promise<string> {
    let session = this.sessions.get(opts.key);

    // Stale → kill + drop. Hash-mismatch handled below after we hash.
    if (session) {
      const stale = session.isStale();
      if (stale.stale) {
        logger.info('recycling stale session', { key: opts.key, reason: stale.reason });
        session.markDeadAndKill();
        this.sessions.delete(opts.key);
        session = undefined;
      }
    }

    if (!session) {
      // Cold spawn path: build the system prompt and start a fresh process.
      this.evictToFitLRU();
      const systemPrompt = await opts.buildSystemPrompt();
      const systemPromptHash = sha256(systemPrompt);
      session = new WarmSession({
        key: opts.key,
        systemPrompt,
        systemPromptHash,
        model: opts.model,
        cwd: opts.cwd,
        toolPolicy: opts.toolPolicy,
        maxTurns: opts.maxTurns,
      });
      this.sessions.set(opts.key, session);
      logger.info('spawned warm session', { key: opts.key, model: opts.model, hash: systemPromptHash.slice(0, 8) });
    } else {
      // Existing session — verify cwd / tool policy haven't changed underneath us.
      // (Different agent root or tool policy ⇒ recycle. Treat as cold.)
      if (session.cwd !== opts.cwd || session.toolPolicy !== opts.toolPolicy) {
        logger.info('recycling: cwd/toolPolicy changed', { key: opts.key });
        session.markDeadAndKill();
        this.sessions.delete(opts.key);
        return this.turn(userText, opts);  // recurse: rebuild
      }
      // Optional system-prompt drift detection — cheap to do.
      // We rebuild and hash; if it differs, recycle. This catches USER.md
      // edits, skill installs, etc.
      const systemPrompt = await opts.buildSystemPrompt();
      const newHash = sha256(systemPrompt);
      if (newHash !== session.systemPromptHash) {
        logger.info('recycling: system-prompt hash drifted', { key: opts.key });
        session.markDeadAndKill();
        this.sessions.delete(opts.key);
        return this.turn(userText, opts);
      }
    }

    try {
      const reply = await session.turn(userText, opts.onChunk);
      return reply;
    } catch (err) {
      // Drop the dead session; caller may retry which would cold-spawn.
      this.sessions.delete(opts.key);
      throw err;
    }
  }

  /**
   * If the pool is full, evict the LRU idle session (or the LRU non-busy if
   * none idle). Refuse to evict a BUSY session — rare in single-user usage.
   */
  private evictToFitLRU(): void {
    if (this.sessions.size < MAX_POOL_SESSIONS) return;
    let lruKey: SessionKey | null = null;
    let lruAt = Infinity;
    for (const [key, sess] of this.sessions) {
      if (sess.isBusy()) continue;
      if (sess.getLastUsedAt() < lruAt) {
        lruAt = sess.getLastUsedAt();
        lruKey = key;
      }
    }
    if (lruKey) {
      logger.info('LRU evict', { key: lruKey });
      const sess = this.sessions.get(lruKey)!;
      sess.markDeadAndKill();
      this.sessions.delete(lruKey);
    } else {
      // All busy — let the new spawn proceed; we'll be over the cap briefly.
      logger.warn('pool full but all sessions busy — exceeding cap briefly', { size: this.sessions.size });
    }
  }

  /** Sweep idle sessions. Called periodically. */
  evictIdle(): void {
    const now = Date.now();
    for (const [key, sess] of [...this.sessions]) {
      if (sess.isIdle(now)) {
        logger.info('idle evict', { key, idleMs: now - sess.getLastUsedAt() });
        sess.markDeadAndKill();
        this.sessions.delete(key);
      }
    }
  }

  /** Force-recycle a specific key (e.g. on /start clearHistory). */
  recycle(key: SessionKey): void {
    const sess = this.sessions.get(key);
    if (sess) {
      logger.info('manual recycle', { key });
      sess.markDeadAndKill();
      this.sessions.delete(key);
    }
  }

  stats(): PoolStats {
    const now = Date.now();
    const sessions: PoolStats['sessions'] = [];
    for (const [key, sess] of this.sessions) {
      sessions.push({
        key,
        ageMs: now - (sess as any).spawnedAt,
        idleMs: now - sess.getLastUsedAt(),
        turnCount: sess.getTurnCount(),
        state: sess.getState(),
      });
    }
    return { active: this.sessions.size, sessions };
  }

  /** Shut down the pool; kill all sessions. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
    for (const [key, sess] of this.sessions) {
      logger.debug('shutdown kill', { key });
      sess.markDeadAndKill();
    }
    this.sessions.clear();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ───────────────────────────────────────────────────────────────────────────
// Singleton accessor — opt-in via env or config.
// ───────────────────────────────────────────────────────────────────────────

let _pool: WarmClaudePool | null = null;

/** Returns the pool if enabled; null otherwise. */
export function getWarmPool(): WarmClaudePool | null {
  return _pool;
}

/** Construct the pool. Call once at agent startup if warm pool is enabled. */
export function initWarmPool(): WarmClaudePool {
  if (_pool) return _pool;
  _pool = new WarmClaudePool();
  logger.info('warm Claude pool initialized');
  return _pool;
}

/** Tear down. Used on agent stop or by tests. */
export async function shutdownWarmPool(): Promise<void> {
  if (_pool) {
    await _pool.shutdown();
    _pool = null;
  }
}

/**
 * Decide whether the warm Claude subprocess pool should be active for
 * this run. Resolution order:
 *
 *   1. KYBERBOT_WARM_POOL env var (1/true → on, 0/false → off) wins
 *   2. identity.yaml `claude.warm_pool: false` opts the agent out
 *   3. otherwise: **default ON** — channel replies stay snappy at the
 *      cost of one idle Claude subprocess per active conversation
 *      (recycled every 4h / 50 turns; see WarmSession.isStale)
 *
 * Set `claude.warm_pool: false` in identity.yaml or `KYBERBOT_WARM_POOL=0`
 * in .env to disable on a memory-constrained host.
 */
export function isWarmPoolEnabled(identityWarmPool?: boolean): boolean {
  const env = process.env.KYBERBOT_WARM_POOL;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  if (identityWarmPool === false) return false;
  return true;
}
