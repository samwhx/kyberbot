/**
 * KyberBot — Telegram Channel Bridge
 *
 * Uses grammy to connect to Telegram Bot API.
 * Routes incoming messages to the agent via claude.ts.
 *
 * Security: One-time verification code flow ensures only the owner
 * can interact with the bot. On first start (no owner_chat_id),
 * a 6-char code is printed to the console. The owner sends
 * `/start CODE` in Telegram to verify. After that, all messages
 * from non-owner chat_ids are silently ignored.
 */

import { Bot } from 'grammy';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import yaml from 'js-yaml';
import { createLogger } from '../../logger.js';
import { getClaudeClient } from '../../claude.js';
import { getAgentNameForRoot } from '../../config.js';
import { Channel, ChannelMessage } from './types.js';
import { storeConversation } from '../../brain/store-conversation.js';
import { buildChannelSystemPrompt, buildStaticChannelSystemPrompt, buildPerTurnContextBlock } from './system-prompt.js';
import { pushUserMessage, pushAssistantMessage, buildPromptWithHistory, buildHistoryBlock, clearHistory, escapeForXml } from './conversation-history.js';
import { isWarmPoolEnabled, getWarmPool } from '../../runtime/warm-claude-pool.js';
import { tryRunProposalCommand, formatProposalCommandReply } from '../../services/proposal-commands.js';
import { maybeSpeakReply } from '../../services/speak-on-reply.js';

const logger = createLogger('telegram');

export interface TelegramConfig {
  bot_token: string;
  owner_chat_id?: number;
}

// Per-chatId rate limit on verification attempts.
// 24-bit codes were brute-forceable; even with 128-bit codes a flood-bot can
// be a DoS vector, so cap attempts cheaply.
const MAX_VERIFY_ATTEMPTS = 5;
const VERIFY_LOCKOUT_MS = 10 * 60 * 1000; // 10 min

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private connected = false;
  private messageHandler: ((message: ChannelMessage) => Promise<void>) | null = null;
  private verificationCode: string | null = null;
  private ownerChatId: number | null;
  private verifyAttempts = new Map<number, { count: number; firstAt: number }>();

  constructor(private config: TelegramConfig, private root: string) {
    this.ownerChatId = config.owner_chat_id ?? null;
  }

  async start(): Promise<void> {
    this.bot = new Bot(this.config.bot_token);

    // If no owner set, enter verification mode
    if (!this.ownerChatId) {
      // 32 hex chars = 128 bits of entropy. The previous 6-hex (24-bit) code
      // was brute-forceable in hours via the public Telegram bot API.
      this.verificationCode = randomBytes(16).toString('hex');
      logger.info('─────────────────────────────────────────────');
      logger.info(`Telegram verification required`);
      logger.info(`Send /start ${this.verificationCode} to your bot`);
      logger.info('─────────────────────────────────────────────');
      console.log('');
      console.log(`  Telegram verification code: ${this.verificationCode}`);
      console.log(`  Send /start ${this.verificationCode} to your bot in Telegram`);
      console.log('');
    }

    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      const userId = ctx.from?.id;
      const text = ctx.message.text;

      // Telegram reply ("quote") metadata — when the user taps Reply on an
      // earlier message, the quoted content lives in reply_to_message.
      // We extract its text or caption so the agent sees what's being
      // referenced; non-text replies become a `[media-type]` marker.
      const replyTo = (ctx.message as any).reply_to_message;
      const quotedRaw = replyTo
        ? (replyTo.text
          || replyTo.caption
          || (replyTo.photo ? '[photo]' : null)
          || (replyTo.voice ? '[voice note]' : null)
          || (replyTo.audio ? '[audio]' : null)
          || (replyTo.video ? '[video]' : null)
          || (replyTo.document ? `[document${replyTo.document.file_name ? `: ${replyTo.document.file_name}` : ''}]` : null)
          || (replyTo.sticker ? '[sticker]' : null)
          || (replyTo.location ? '[location]' : null)
          || (replyTo.contact ? '[contact]' : null))
        : null;
      const quotedBlock = quotedRaw
        ? `<quoted_message>${escapeForXml(quotedRaw)}</quoted_message>\n`
        : '';

      // ── Verification mode ──────────────────────────────────────────────
      if (this.verificationCode) {
        // Only handle /start CODE during verification
        if (text.startsWith('/start ')) {
          // Rate-limit verification attempts per chatId. Without this a
          // flood-bot can grind attempts even against a 128-bit code.
          const now = Date.now();
          const entry = this.verifyAttempts.get(chatId);
          if (entry && now - entry.firstAt < VERIFY_LOCKOUT_MS && entry.count >= MAX_VERIFY_ATTEMPTS) {
            logger.warn(`Verification locked out for chat_id=${chatId} until ${new Date(entry.firstAt + VERIFY_LOCKOUT_MS).toISOString()}`);
            return;
          }

          const code = text.slice(7).trim();
          // Constant-time comparison — defense-in-depth even though 128 bits
          // makes timing-side-channel impractical here.
          const codeBuf = Buffer.from(code);
          const expectBuf = Buffer.from(this.verificationCode);
          const match = codeBuf.length === expectBuf.length && timingSafeEqual(codeBuf, expectBuf);

          if (match) {
            this.ownerChatId = chatId;
            this.verificationCode = null;
            this.verifyAttempts.clear();
            this.saveOwnerChatId(chatId);
            logger.info(`Owner verified: chat_id=${chatId}`);

            const agentName = getAgentNameForRoot(this.root);
            const greeting = this.loadGreeting(agentName);
            await ctx.reply(`Connected! You are now the verified owner.\n\n${greeting}`);
            return;
          }

          // Wrong code — track attempt, silently ignore
          if (!entry || now - entry.firstAt >= VERIFY_LOCKOUT_MS) {
            this.verifyAttempts.set(chatId, { count: 1, firstAt: now });
          } else {
            entry.count += 1;
          }
          logger.warn(`Invalid verification attempt from chat_id=${chatId} (${this.verifyAttempts.get(chatId)?.count}/${MAX_VERIFY_ATTEMPTS})`);
          return;
        }
        // Not a /start command during verification — ignore
        return;
      }

      // ── Owner guard ────────────────────────────────────────────────────
      if (chatId !== this.ownerChatId) {
        // Silently ignore messages from non-owner
        logger.debug(`Ignored message from non-owner chat_id=${chatId}`);
        return;
      }

      // ── Handle /start after verification ───────────────────────────────
      if (text === '/start') {
        const convoKey = `telegram:${chatId}`;
        clearHistory(convoKey);
        // Recycle any warm session so the next turn starts fresh.
        const pool = getWarmPool();
        if (pool) pool.recycle(convoKey);
        const agentName = getAgentNameForRoot(this.root);
        const greeting = this.loadGreeting(agentName);
        await ctx.reply(greeting);
        return;
      }

      // ── Self-learning approval intercept (owner-only by construction —
      //    we already verified chatId === ownerChatId above) ─────────────
      // Returns null unless the text matches "approve <id>" / "reject <id>"
      // AND at least one id matches a pending proposal. Prose like "please
      // approve my plan" passes through to Claude unchanged.
      try {
        const proposalResult = await tryRunProposalCommand(this.root, text);
        if (proposalResult) {
          await ctx.reply(formatProposalCommandReply(proposalResult));
          return;
        }
      } catch (err) {
        logger.warn('Proposal command intercept failed; falling through to Claude', { error: String(err) });
      }

      // ── Route message ──────────────────────────────────────────────────
      const message: ChannelMessage = {
        id: String(ctx.message.message_id),
        channelType: 'telegram',
        from: ctx.from?.username || ctx.from?.first_name || 'unknown',
        text,
        timestamp: new Date(ctx.message.date * 1000),
        metadata: {
          chatId,
          userId,
        },
      };

      if (this.messageHandler) {
        await this.messageHandler(message);
      } else {
        // Default: route to agent with conversation history
        const convoId = `telegram:${chatId}`;
        try {
          const client = getClaudeClient();

          // Choose path: warm pool (faster, claude tracks history in-process)
          // vs one-shot subprocess (legacy, our conversation-history.ts).
          const useWarmPool = isWarmPoolEnabled();
          let prompt: string;
          let systemPrompt: string | undefined;
          let warmPoolKey: string | undefined;
          let buildSystemPrompt: (() => Promise<string>) | undefined;

          if (useWarmPool) {
            const ctxBlock = await buildPerTurnContextBlock('telegram', text);
            const ctx = ctxBlock.trim() ? `<context>\n${ctxBlock}\n</context>\n\n` : '';
            // Warm sessions recycle (4h / 50 turns / on error / on restart),
            // so we cannot assume the subprocess remembers earlier turns.
            // Always re-inject the rolling history.
            const historyBlock = buildHistoryBlock(convoId);
            const history = historyBlock ? `${historyBlock}\n\n` : '';
            prompt = `${ctx}${history}${quotedBlock}<user_message>${escapeForXml(text)}</user_message>`;
            warmPoolKey = convoId;
            buildSystemPrompt = () => buildStaticChannelSystemPrompt('telegram');
          } else {
            const base = buildPromptWithHistory(convoId, text);
            prompt = quotedBlock
              ? base.replace(/<user_message>/, `${quotedBlock}<user_message>`)
              : base;
            systemPrompt = await buildChannelSystemPrompt('telegram', text);
          }

          // Self-learning telemetry — capture timing around the Claude call.
          const receivedAt = new Date().toISOString();
          const claudeStart = Date.now();
          const reply = await client.complete(prompt, {
            system: systemPrompt,
            warmPoolKey,
            buildSystemPrompt,
            maxTurns: 30,
            subprocess: !useWarmPool,
            cwd: this.root,
            // Telegram messages reach Claude as untrusted text. 'broad' allows
            // memory edits and `kyberbot` CLI commands but blocks arbitrary
            // Bash and Agent — so a prompt-injected message can't shell-exec.
            tools: 'broad',
          });
          const latencyMs = Date.now() - claudeStart;
          const repliedAt = new Date().toISOString();

          // Track both sides in history
          pushUserMessage(convoId, text);

          if (!reply || reply.trim().length === 0) {
            logger.warn('Claude returned empty response, skipping reply');
            return;
          }

          pushAssistantMessage(convoId, reply);

          // Telegram has a 4096 char limit per message
          if (reply.length > 4096) {
            const chunks = this.chunkMessage(reply, 4096);
            for (const chunk of chunks) {
              await ctx.reply(chunk);
            }
          } else {
            await ctx.reply(reply);
          }

          // Voice mode hook: if user has voice mode enabled, spawn a
          // detached `kyberbot speak` to play this reply through Mac
          // speakers. Runs in parallel with the user reading the text;
          // does not block the reply path. See speak-on-reply.ts.
          maybeSpeakReply(reply, this.root);

          // Fire-and-forget: store conversation in memory + telemetry.
          // metrics.{model, input_tokens, output_tokens, cost_usd, tools_used}
          // are unavailable here — they live inside the claude subprocess
          // result event which complete() doesn't currently surface. Day 1
          // captures latency + reply length; tokens/cost arrive later when
          // we plumb the result event. See docs/self-learning-plan.md §9.
          storeConversation(this.root, {
            prompt: text,
            response: reply,
            channel: 'telegram',
            metadata: { chatId, userId },
            metrics: {
              channel: 'telegram',
              latency_ms: latencyMs,
              reply_length_chars: reply.length,
              received_at: receivedAt,
              replied_at: repliedAt,
            },
          }).catch((err) => logger.warn('Memory storage failed', { error: String(err) }));
        } catch (error) {
          logger.error('Failed to process Telegram message', { error: String(error) });
          await ctx.reply('Sorry, I encountered an error processing your message.');
        }
      }
    });

    this.bot.start();
    this.connected = true;
    logger.info(`Telegram channel connected${this.ownerChatId ? ` (owner: ${this.ownerChatId})` : ' (awaiting verification)'}`);
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    this.connected = false;
    logger.info('Telegram channel disconnected');
  }

  async send(chatId: string, message: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not started');
    await this.bot.api.sendMessage(chatId, message);
  }

  isConnected(): boolean {
    return this.connected;
  }

  isVerified(): boolean {
    return this.ownerChatId !== null;
  }

  onMessage(handler: (message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private saveOwnerChatId(chatId: number): void {
    try {
      const identityPath = join(this.root, 'identity.yaml');
      const raw = readFileSync(identityPath, 'utf-8');
      const identity = yaml.load(raw) as Record<string, any>;

      if (identity.channels?.telegram) {
        identity.channels.telegram.owner_chat_id = chatId;
      }

      writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));
      logger.info(`Saved owner_chat_id=${chatId} to identity.yaml`);
    } catch (error) {
      logger.error('Failed to save owner_chat_id to identity.yaml', { error: String(error) });
    }
  }

  private loadGreeting(agentName: string): string {
    try {
      const userPath = join(this.root, 'USER.md');
      const userMd = existsSync(userPath) ? readFileSync(userPath, 'utf-8') : '';
      const isFirstRun = userMd.includes('<!-- I will fill this in') || userMd.length < 300;

      if (isFirstRun) {
        return `Hey! I'm ${agentName}, and I just came online for the first time.\n\n` +
          `I'd love to get to know you — tell me about yourself, what you're working on, ` +
          `what matters to you. Everything you share helps me be a better partner.\n\n` +
          `You can also tell me how you'd like me to communicate and I'll adapt.`;
      }
    } catch {
      // Non-fatal
    }
    return `Hey! I'm ${agentName}. Send me a message and I'll help however I can.`;
  }

  private chunkMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to break at a newline
      let breakAt = remaining.lastIndexOf('\n', maxLen);
      if (breakAt < maxLen / 2) {
        // No good newline break, try space
        breakAt = remaining.lastIndexOf(' ', maxLen);
      }
      if (breakAt < maxLen / 2) {
        breakAt = maxLen;
      }
      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    return chunks;
  }
}
