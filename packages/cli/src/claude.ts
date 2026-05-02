/**
 * KyberBot — Claude Abstraction Layer
 *
 * Three modes:
 *   1. Agent SDK — Uses @anthropic-ai/claude-code (subscription users, recommended)
 *   2. SDK — Direct Anthropic API calls (requires ANTHROPIC_API_KEY)
 *   3. Subprocess — Spawns `claude -p` (fallback if Agent SDK fails to load)
 *
 * All brain AI operations go through this layer.
 */

import { spawn } from 'child_process';
import { getClaudeMode, getClaudeModel, getRoot } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('claude');

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Tool-access policy for a Claude subprocess invocation.
 *
 * Every subprocess used to run with --dangerously-skip-permissions, which
 * meant a single prompt-injection from a Telegram message could trigger
 * arbitrary Bash. The policy decides what tools the spawned process may
 * use; --dangerously-skip-permissions is now reserved for 'owner'.
 *
 * - 'none': no tools at all — pure text generation. Use for brain
 *   extractors, summarizers, classifiers — anything that should not touch
 *   the filesystem or network.
 * - 'narrow': read-only — Read, Glob, Grep, WebFetch, WebSearch, Skill.
 *   Default. Safe for peer-agent / brain-search callers that may legitimately
 *   look things up but should never write or exec.
 * - 'broad': narrow + Write, Edit, NotebookEdit, Bash(kyberbot:*). For
 *   trusted-but-potentially-injected paths (channel handlers, heartbeat)
 *   that need to update memory or run kyberbot CLI subcommands. Arbitrary
 *   Bash and Agent tools are still blocked.
 * - 'owner': full tool access via --dangerously-skip-permissions. Reserve
 *   for owner-initiated CLI sessions and `kyberbot agent spawn` where the
 *   human operator is driving directly.
 */
export type ToolPolicy = 'none' | 'narrow' | 'broad' | 'owner';

export interface CompleteOptions {
  model?: 'haiku' | 'sonnet' | 'opus';
  system?: string;
  maxTokens?: number;
  maxTurns?: number;
  /** Callback for stdout chunks as they arrive (streaming). */
  onChunk?: (chunk: string) => void;
  /**
   * Force subprocess mode for this call. Each invocation runs in an
   * isolated child process whose memory is reclaimed on exit.
   * Use for background/brain operations to avoid heap accumulation
   * in the long-lived server process.
   */
  subprocess?: boolean;
  /**
   * If set AND the warm pool is initialized, route this call through the
   * pool instead of spawning a one-shot subprocess. Saves ~3-5s on warm
   * turns. Only meaningful for channel handlers — heartbeat / sleep /
   * brain ops should not set this (they each run in a different cwd or
   * with a different system prompt, and pooling buys nothing).
   *
   * When using the pool, pass `buildSystemPrompt` instead of `system`.
   */
  warmPoolKey?: string;
  /**
   * Lazy system-prompt builder used by the warm pool. Only invoked on a
   * cold spawn (or recycle). Must be byte-stable for hash-based drift
   * detection.
   */
  buildSystemPrompt?: () => Promise<string>;
  /**
   * Working directory for the spawned `claude` process. Claude Code
   * attributes session files to the project corresponding to this
   * directory. In fleet mode the parent process has one CWD shared
   * across many agents, so without this option every agent's Haiku
   * calls land in the same project dir. Callers that know which
   * agent's work is being done (sleep steps, heartbeat, channel
   * handlers, bus handler, store-conversation) should pass the
   * agent's root here. Only used by subprocess mode.
   */
  cwd?: string;
  /**
   * Tool access policy. Defaults to 'narrow' (read-only) — safer than the
   * previous always-skip-permissions behavior. Pass 'broad' for channel
   * handlers and heartbeat, 'none' for pure-text brain ops, 'owner' only
   * for genuinely owner-driven invocations.
   */
  tools?: ToolPolicy;
}

const TOOL_POLICY_ALLOWLIST: Record<Exclude<ToolPolicy, 'owner'>, string> = {
  none: '',
  narrow: 'Read,Glob,Grep,WebFetch,WebSearch,Skill',
  broad: 'Read,Glob,Grep,WebFetch,WebSearch,Skill,Write,Edit,NotebookEdit,Bash(kyberbot:*)',
};

// Model ID mapping
const MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

export class ClaudeClient {
  private mode: 'agent-sdk' | 'sdk' | 'subprocess';
  private sdk: any | null = null;

  constructor() {
    const configMode = getClaudeMode();

    if (configMode === 'agent-sdk') {
      // All callers use subprocess: true, so don't load the Agent SDK
      // into the long-lived server process — it leaks hundreds of MB.
      // The SDK is only needed for in-process query() calls, which we
      // no longer make. Subprocess mode spawns `claude -p` instead.
      this.mode = 'subprocess';
      logger.debug('Using subprocess mode (agent-sdk disabled for memory safety)');
    } else if (configMode === 'sdk') {
      this.mode = 'sdk';
      this.initSDK();
    } else {
      this.mode = 'subprocess';
    }
  }

  private async initSDK(): Promise<void> {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      this.sdk = new Anthropic();
      logger.debug('Initialized in SDK mode');
    } catch {
      logger.warn('Failed to initialize SDK, falling back to subprocess mode');
      this.mode = 'subprocess';
    }
  }

  /**
   * Single completion — fire and forget prompt
   */
  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    // Always resolve model — never let subprocess/agent-sdk fall back to CLI defaults
    if (!opts.model) {
      opts.model = (getClaudeModel() || 'opus') as 'haiku' | 'sonnet' | 'opus';
    }

    // Warm pool: when caller has supplied a pool key AND the pool is up,
    // route through it instead of spawning a one-shot subprocess. On any
    // pool error we fall through to the existing subprocess path.
    if (opts.warmPoolKey && opts.buildSystemPrompt) {
      const { getWarmPool } = await import('./runtime/warm-claude-pool.js');
      const pool = getWarmPool();
      if (pool) {
        try {
          return await pool.turn(prompt, {
            key: opts.warmPoolKey,
            buildSystemPrompt: opts.buildSystemPrompt,
            cwd: opts.cwd ?? getRoot(),
            toolPolicy: opts.tools ?? 'narrow',
            model: opts.model,
            maxTurns: opts.maxTurns ?? 30,
            onChunk: opts.onChunk,
          });
        } catch (err) {
          logger.warn('warm pool turn failed; falling back to one-shot subprocess', {
            key: opts.warmPoolKey,
            error: String(err),
          });
          // Fall through to one-shot subprocess. Build system prompt eagerly
          // since the pool builder was lazy.
          if (!opts.system) {
            try { opts.system = await opts.buildSystemPrompt(); } catch { /* ignore */ }
          }
        }
      } else if (!opts.system) {
        // Pool disabled and no system provided — build it eagerly so the
        // subprocess fallback has a system prompt.
        try { opts.system = await opts.buildSystemPrompt(); } catch { /* ignore */ }
      }
    }

    // All server-process calls should use subprocess for memory isolation.
    // SDK mode is only for direct API calls (ANTHROPIC_API_KEY users).
    if (this.mode === 'sdk' && this.sdk && !opts.subprocess) {
      return this.completeSDK(prompt, opts.model, opts);
    }
    return this.completeSubprocess(prompt, opts);
  }

  /**
   * Multi-turn chat
   */
  async chat(messages: Message[], system: string): Promise<string> {
    const model = (getClaudeModel() || 'opus') as 'haiku' | 'sonnet' | 'opus';

    if (this.mode === 'sdk' && this.sdk) {
      return this.chatSDK(messages, system, model);
    }
    // Subprocess mode: flatten into a single prompt with history
    const historyPrompt = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    const fullPrompt = `${system}\n\n${historyPrompt}`;
    return this.completeSubprocess(fullPrompt, { model });
  }

  private async completeSDK(
    prompt: string,
    model: string,
    opts: CompleteOptions
  ): Promise<string> {
    const modelId = MODEL_IDS[model] || MODEL_IDS.opus;
    const response = await this.sdk.messages.create({
      model: modelId,
      max_tokens: opts.maxTokens || 4096,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  private async chatSDK(
    messages: Message[],
    system: string,
    model: string
  ): Promise<string> {
    const modelId = MODEL_IDS[model] || MODEL_IDS.opus;
    const response = await this.sdk.messages.create({
      model: modelId,
      max_tokens: 4096,
      system,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  private completeSubprocess(prompt: string, opts: CompleteOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use stream-json format when onChunk is provided for live output
      const useStreamJson = !!opts.onChunk;
      const args = ['--print', '-'];

      // Tool policy. Default 'narrow' (read-only) — was 'owner' (skip-perms),
      // which made every channel/heartbeat/brain invocation a one-shot RCE
      // surface via prompt injection. See ToolPolicy doc.
      const policy: ToolPolicy = opts.tools ?? 'narrow';
      if (policy === 'owner') {
        args.push('--dangerously-skip-permissions');
      } else {
        const allowed = TOOL_POLICY_ALLOWLIST[policy];
        if (allowed) {
          args.push('--allowedTools', allowed);
        }
        // For 'none' we pass nothing — Claude Code in --print mode without
        // skip-permissions denies any tool that needs permission, so the
        // model produces pure text.
      }

      if (useStreamJson) {
        args.push('--output-format', 'stream-json', '--verbose');
      }
      if (opts.system) {
        args.push('--system-prompt', opts.system);
      }
      if (opts.model) {
        args.push('--model', opts.model);
      }
      if (opts.maxTurns) {
        args.push('--max-turns', String(opts.maxTurns));
      }

      // Pipe prompt via stdin instead of CLI args to avoid ARG_MAX limits
      // (large conversation histories + system prompts easily exceed 256KB)
      const proc = spawn('claude', args, {
        env: {
          ...process.env,
          // Must unset CLAUDECODE to avoid Claude Code detecting nested invocation
          CLAUDECODE: '',
          CLAUDE_CODE_ENTRYPOINT: '',
        },
        // cwd determines which ~/.claude/projects/<slug> dir Claude Code
        // writes this session's .jsonl to. Without this, every agent's
        // brain/sleep/heartbeat calls in fleet mode attribute to the same
        // dir (the fleet process's cwd). Callers pass the agent's root.
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (proc.stdin) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let stdoutBytes = 0;
      const MAX_STDOUT = 2 * 1024 * 1024; // 2MB cap — subprocess responses should be small

      let stdoutDestroyed = false;
      proc.stdout.on('data', (data: Buffer) => {
        stdoutBytes += data.length;
        if (stdoutBytes <= MAX_STDOUT) {
          chunks.push(data);
          // Stream callback for live log capture
          if (opts.onChunk) {
            try { opts.onChunk(data.toString()); } catch { /* ignore */ }
          }
        } else if (!stdoutDestroyed) {
          // Destroy the read stream to stop reading entirely.
          // Without this, rapid data arrival floods GC with temporary Buffers.
          stdoutDestroyed = true;
          proc.stdout.destroy();
          logger.warn(`Subprocess stdout exceeded ${MAX_STDOUT / 1024 / 1024}MB — stream destroyed`);
        }
      });
      proc.stderr.on('data', (data: Buffer) => { errChunks.push(data); });

      proc.on('close', (code) => {
        const chunksBytes = chunks.reduce((sum, c) => sum + c.length, 0);
        const errBytes = errChunks.reduce((sum, c) => sum + c.length, 0);
        logger.info('subprocess:close', { code, stdoutBytes: chunksBytes, stderrBytes: errBytes, totalStdoutRead: stdoutBytes, destroyed: stdoutDestroyed, heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) });
        const stdout = Buffer.concat(chunks).toString().trim();
        const stderr = Buffer.concat(errChunks).toString();
        // Clear references immediately to let GC reclaim buffers
        chunks.length = 0;
        errChunks.length = 0;
        stdoutBytes = 0;

        if (code === 0) {
          if (useStreamJson) {
            // Parse stream-json: extract the final result text from JSONL
            // The last line with type "result" has the final text
            let resultText = '';
            for (const line of stdout.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const event = JSON.parse(trimmed);
                if (event.type === 'result' && event.result) {
                  resultText = event.result;
                } else if (event.type === 'assistant' && event.message?.content) {
                  // Accumulate assistant text blocks
                  for (const block of event.message.content) {
                    if (block.type === 'text') resultText = block.text;
                  }
                }
              } catch { /* not valid JSON — skip */ }
            }
            resolve(resultText || stdout);
          } else {
            resolve(stdout);
          }
        } else {
          logger.error(`claude subprocess exited with code ${code}`, { stderr: stderr.slice(0, 500) });
          reject(new Error(`claude subprocess failed: ${stderr.slice(0, 500) || `exit code ${code}`}`));
        }
      });

      proc.on('error', (err) => {
        chunks.length = 0;
        errChunks.length = 0;
        reject(new Error(`Failed to spawn claude: ${err.message}. Is Claude Code installed?`));
      });
    });
  }
}

// Singleton
let _client: ClaudeClient | null = null;

export function getClaudeClient(): ClaudeClient {
  if (!_client) {
    _client = new ClaudeClient();
  }
  return _client;
}
