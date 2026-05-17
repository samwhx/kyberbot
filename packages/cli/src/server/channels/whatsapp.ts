/**
 * KyberBot — WhatsApp Channel Bridge
 *
 * Uses @whiskeysockets/baileys to connect to WhatsApp Web.
 * Routes incoming messages to the agent via claude.ts.
 *
 * Security: WhatsApp messages can come from anyone who knows the linked
 * number. The channel REFUSES to start without an owner_jid configured,
 * and silently drops every message that does not come from that JID.
 *
 * To set up:
 *   1. Add `channels.whatsapp.owner_jid: "<your-number>@s.whatsapp.net"`
 *      to identity.yaml (the `s.whatsapp.net` suffix is the WhatsApp
 *      personal-number format; group JIDs end with `@g.us`).
 *   2. Set `channels.whatsapp.enabled: true`.
 *   3. Start the agent and scan the QR.
 *   4. Send a message to yourself from the linked account to test.
 *
 * No verification flow exists (unlike Telegram /start CODE). The owner_jid
 * is the trust anchor — set it manually before enabling the channel.
 */

import { createLogger } from '../../logger.js';
import { getClaudeClient } from '../../claude.js';
import { Channel, ChannelMessage } from './types.js';
import { join } from 'path';
import { storeConversation } from '../../brain/store-conversation.js';
import { buildChannelSystemPrompt, buildStaticChannelSystemPrompt, buildPerTurnContextBlock } from './system-prompt.js';
import { pushUserMessage, pushAssistantMessage, buildPromptWithHistory, buildHistoryBlock, escapeForXml } from './conversation-history.js';
import { transcribe } from '../../services/transcribe.js';
import { isWarmPoolEnabled } from '../../runtime/warm-claude-pool.js';
import { tryRunProposalCommand, formatProposalCommandReply } from '../../services/proposal-commands.js';
import { maybeSpeakReply } from '../../services/speak-on-reply.js';

const logger = createLogger('channel');

/**
 * Extract a human-readable representation of the message a WhatsApp reply is
 * quoting. Returns null when there's no quoted message. For non-text quoted
 * content (images, voice notes, etc.) we emit a `[media-type]` marker plus
 * any caption — enough for the agent to understand what's being referenced.
 *
 * Shape comes from Baileys: `extendedTextMessage.contextInfo.quotedMessage`.
 */
function extractQuotedText(contextInfo: any): string | null {
  const q = contextInfo?.quotedMessage;
  if (!q) return null;
  if (typeof q.conversation === 'string' && q.conversation.length > 0) return q.conversation;
  if (q.extendedTextMessage?.text) return q.extendedTextMessage.text;
  if (q.imageMessage) return q.imageMessage.caption ? `[image] ${q.imageMessage.caption}` : '[image]';
  if (q.videoMessage) return q.videoMessage.caption ? `[video] ${q.videoMessage.caption}` : '[video]';
  if (q.audioMessage) return '[voice note]';
  if (q.documentMessage) {
    const name = q.documentMessage.fileName ? `: ${q.documentMessage.fileName}` : '';
    const cap = q.documentMessage.caption ? ` — ${q.documentMessage.caption}` : '';
    return `[document${name}]${cap}`;
  }
  if (q.stickerMessage) return '[sticker]';
  if (q.locationMessage) return '[location]';
  if (q.contactMessage) return '[contact]';
  return null;
}

export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';
  private sock: any = null;
  private connected = false;
  private messageHandler: ((message: ChannelMessage) => Promise<void>) | null = null;

  constructor(
    private root: string,
    private ownerJid: string | null = null,
    private linkedPhone: string | null = null,
  ) {}

  async start(): Promise<void> {
    if (!this.ownerJid) {
      throw new Error(
        'WhatsApp channel refuses to start without owner_jid configured. ' +
        'Add `channels.whatsapp.owner_jid: "<your-number>@s.whatsapp.net"` to identity.yaml. ' +
        'Without it, anyone who messages the linked number reaches the agent.'
      );
    }
    try {
      const baileys = await import('@whiskeysockets/baileys');
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } = baileys;

      const authDir = join(this.root, 'data', 'whatsapp-auth');
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      // The actual root cause of "Connection Failure" at noise-handshake:
      // Baileys hard-codes an outdated WhatsApp Web version (~2.3000.10232…)
      // which WhatsApp's servers reject. Verified by probing locally —
      // dynamic fetch returns ~2.3000.10351… which passes the handshake.
      // Cache for 12h to avoid refetching on every reconnect.
      let version: [number, number, number] | undefined;
      try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
        logger.info(`Using WhatsApp Web version ${version.join('.')} (fetched, isLatest=${fetched.isLatest})`);
      } catch (err) {
        logger.warn('fetchLatestBaileysVersion failed; using Baileys default (likely to fail handshake)', { error: String(err) });
      }

      // - `browser` is the device fingerprint shown in WhatsApp's linked-devices list.
      // - `defaultQueryTimeoutMs: undefined` is required during pairing-code flow.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.sock = (makeWASocket as any)({
        auth: state,
        version,
        browser: ['Mac OS', 'Chrome', '14.4.1'],
        defaultQueryTimeoutMs: undefined,
      });

      this.sock.ev.on('creds.update', saveCreds);

      // Track whether we've already requested a pairing code this session
      // so reconnects don't spam new codes.
      let pairingCodeRequested = false;

      this.sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        // qr arriving = unauthenticated. Use pairing code if we have a phone.
        // Don't gate on authState.creds.registered — its shape varies and
        // Baileys only emits qr events when not yet registered anyway.
        if (qr && this.linkedPhone && !pairingCodeRequested) {
          pairingCodeRequested = true;
          try {
            const code: string = await this.sock.requestPairingCode(this.linkedPhone);
            const formatted = code.match(/.{1,4}/g)?.join('-') ?? code;
            // eslint-disable-next-line no-console
            console.log('\n  ─────────────────────────────────────────────────');
            // eslint-disable-next-line no-console
            console.log(`  WhatsApp Pairing Code:  ${formatted}`);
            // eslint-disable-next-line no-console
            console.log('  ─────────────────────────────────────────────────');
            // eslint-disable-next-line no-console
            console.log(`  On the phone with WhatsApp number ${this.linkedPhone}:`);
            // eslint-disable-next-line no-console
            console.log('    1. WhatsApp → Settings → Linked Devices');
            // eslint-disable-next-line no-console
            console.log('    2. Tap "Link a Device" → "Link with phone number instead"');
            // eslint-disable-next-line no-console
            console.log(`    3. Enter ${this.linkedPhone}, then enter the code above`);
            // eslint-disable-next-line no-console
            console.log('  ─────────────────────────────────────────────────\n');
            logger.info('WhatsApp pairing code generated — code valid ~60s');
          } catch (err) {
            logger.error('Failed to request pairing code; falling back to QR', { error: String(err) });
            await this.renderQrFallback(qr);
            pairingCodeRequested = false;  // allow retry on next qr
          }
        } else if (qr) {
          // No linked_phone configured → QR fallback (likely broken on
          // current WhatsApp, but emit so user sees it).
          await this.renderQrFallback(qr);
        }

        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          logger.warn('WhatsApp connection closed', { shouldReconnect });
          this.connected = false;
          if (shouldReconnect) {
            setTimeout(() => this.start(), 5000);
          }
        } else if (connection === 'open') {
          this.connected = true;
          logger.info('WhatsApp channel connected');
        }
      });

      this.sock.ev.on('messages.upsert', async (m: any) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // Owner-JID check. WhatsApp routes some messages via LID (Linked ID)
        // instead of phone-number JID, especially after May 2025. msg.key
        // can carry: remoteJid, participant, participantPn, senderPn — we
        // accept the message if ANY of those normalizes to the owner's JID.
        // We also accept @lid form if the sender's pushName / participantPn
        // resolves to the owner's phone number.
        const candidates: string[] = [
          msg.key.remoteJid,
          msg.key.participant,
          msg.key.participantPn,
          (msg.key as any).senderPn,
          (msg as any).participantPn,
        ].filter((j): j is string => typeof j === 'string' && j.length > 0);

        const ownerJidNorm = this.ownerJid ? jidNormalizedUser(this.ownerJid) : null;
        const ownerPhone = ownerJidNorm?.split('@')[0] ?? null;
        const normalized = candidates.map(jidNormalizedUser);
        const matched = normalized.find(j => j === ownerJidNorm) ||
          // also accept any candidate whose user-portion matches owner phone
          (ownerPhone ? normalized.find(j => j.split('@')[0] === ownerPhone) : null);

        if (!matched) {
          logger.info('WhatsApp: dropping message from non-owner', {
            candidates,
            expectedOwner: ownerJidNorm,
            keyDump: msg.key,
            pushName: msg.pushName,
          });
          return;
        }
        logger.info('WhatsApp: accepted message from owner', {
          matched,
          pushName: msg.pushName,
        });

        // Phase 2.3 — voice note ingestion. If WhatsApp delivered an
        // audioMessage / pttMessage, download it via Baileys, run
        // whisper.cpp on the bytes, use the transcript as the message
        // text. Best-effort: when whisper isn't installed or returns
        // nothing, we fall through with a `[voice note]` placeholder.
        let text = msg.message.conversation ||
          msg.message.extendedTextMessage?.text || '';
        let voiceTranscriptUsed = false;
        const audio = (msg.message as any).audioMessage || (msg.message as any).pttMessage;
        if (audio && !text) {
          try {
            const { downloadMediaMessage } = baileys as any;
            const buffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
            const result = await transcribe(buffer, audio.mimetype ?? 'audio/ogg', { root: this.root });
            if (result) {
              text = result.text;
              voiceTranscriptUsed = true;
              logger.info('WhatsApp voice note transcribed', { chars: result.text.length, cached: result.cached });
            } else {
              text = '[voice note — transcription unavailable]';
              logger.warn('WhatsApp voice note arrived but whisper produced no transcript');
            }
          } catch (err) {
            logger.warn('Voice ingestion failed; falling back to placeholder', { error: String(err) });
            text = '[voice note — could not download]';
          }
        }

        if (!text) return;

        // WhatsApp reply ("quote") metadata — when present, the user is
        // explicitly tying this turn to an earlier message. Inject it into
        // the prompt so the agent doesn't have to guess.
        const quotedText = extractQuotedText(msg.message.extendedTextMessage?.contextInfo);
        const quotedBlock = quotedText
          ? `<quoted_message>${escapeForXml(quotedText)}</quoted_message>\n`
          : '';

        // ── Self-learning approval intercept (owner-only — JID check above)
        try {
          const proposalResult = await tryRunProposalCommand(this.root, text);
          if (proposalResult) {
            await this.send(msg.key.remoteJid!, formatProposalCommandReply(proposalResult));
            return;
          }
        } catch (err) {
          logger.warn('Proposal command intercept failed; falling through to Claude', { error: String(err) });
        }

        const message: ChannelMessage = {
          id: msg.key.id || '',
          channelType: 'whatsapp',
          from: msg.key.remoteJid || 'unknown',
          text,
          timestamp: new Date((msg.messageTimestamp as number) * 1000),
          metadata: {
            remoteJid: msg.key.remoteJid,
            pushName: msg.pushName,
            ...(voiceTranscriptUsed ? { fromVoice: true } : {}),
          },
        };

        if (this.messageHandler) {
          await this.messageHandler(message);
        } else {
          const convoId = `whatsapp:${msg.key.remoteJid}`;
          try {
            const client = getClaudeClient();

            const useWarmPool = isWarmPoolEnabled();
            let prompt: string;
            let systemPrompt: string | undefined;
            let warmPoolKey: string | undefined;
            let buildSystemPrompt: (() => Promise<string>) | undefined;

            if (useWarmPool) {
              const ctxBlock = await buildPerTurnContextBlock('whatsapp', text);
              const ctx = ctxBlock.trim() ? `<context>\n${ctxBlock}\n</context>\n\n` : '';
              // Warm sessions recycle every 4h / 50 turns / on error / on
              // restart (see warm-claude-pool MAX_AGE_MS), so we cannot
              // rely on the subprocess to remember earlier turns. Always
              // re-inject the rolling history.
              const historyBlock = buildHistoryBlock(convoId);
              const history = historyBlock ? `${historyBlock}\n\n` : '';
              prompt = `${ctx}${history}${quotedBlock}<user_message>${escapeForXml(text)}</user_message>`;
              warmPoolKey = convoId;
              buildSystemPrompt = () => buildStaticChannelSystemPrompt('whatsapp');
            } else {
              // Non-warm path already prepends history via buildPromptWithHistory;
              // splice the quoted block in just before the current user message.
              const base = buildPromptWithHistory(convoId, text);
              prompt = quotedBlock
                ? base.replace(/<user_message>/, `${quotedBlock}<user_message>`)
                : base;
              systemPrompt = await buildChannelSystemPrompt('whatsapp', text);
            }

            const receivedAt = new Date().toISOString();
            const claudeStart = Date.now();
            const reply = await client.complete(prompt, {
              system: systemPrompt,
              warmPoolKey,
              buildSystemPrompt,
              maxTurns: 30,
              subprocess: !useWarmPool,
              cwd: this.root,
              // WhatsApp messages are untrusted (and currently have weak
              // sender verification — see channels/whatsapp.ts head comment).
              // 'broad' blocks arbitrary Bash/Agent so injection can't RCE.
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
            await this.send(msg.key.remoteJid!, reply);

            // Voice mode hook: see speak-on-reply.ts for rationale.
            maybeSpeakReply(reply, this.root);

            // Fire-and-forget: store conversation + telemetry. See telegram.ts
            // for the same shape — token/cost/tools fields are unavailable
            // until claude.ts surfaces the result event (Tier 1 follow-up).
            storeConversation(this.root, {
              prompt: text,
              response: reply,
              channel: 'whatsapp',
              metadata: { remoteJid: msg.key.remoteJid, pushName: msg.pushName },
              metrics: {
                channel: 'whatsapp',
                latency_ms: latencyMs,
                reply_length_chars: reply.length,
                received_at: receivedAt,
                replied_at: repliedAt,
              },
            }).catch((err) => logger.warn('Memory storage failed', { error: String(err) }));
          } catch (error) {
            logger.error('Failed to process WhatsApp message', { error: String(error) });
          }
        }
      });
    } catch (error) {
      logger.error('Failed to start WhatsApp channel', { error: String(error) });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.connected = false;
    logger.info('WhatsApp channel disconnected');
  }

  /**
   * Render a QR via qrcode-terminal as a fallback when pairing code is not
   * available or fails. Note: QR flow is currently broken on WhatsApp's
   * server-side validation (Feb 2026 onward), so this is mostly diagnostic.
   */
  private async renderQrFallback(qr: string): Promise<void> {
    try {
      const qrcode = await import('qrcode-terminal');
      // eslint-disable-next-line no-console
      console.log('\n  Scan the QR below from the linked WhatsApp account:\n');
      qrcode.default.generate(qr, { small: true });
      logger.info('WhatsApp QR rendered (fallback path)');
    } catch (err) {
      logger.error('Failed to render QR fallback', { error: String(err) });
      // eslint-disable-next-line no-console
      console.log(`\n  WhatsApp QR payload (paste into any QR generator):\n  ${qr}\n`);
    }
  }

  async send(jid: string, message: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    await this.sock.sendMessage(jid, { text: message });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }
}
