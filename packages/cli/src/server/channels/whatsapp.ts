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
import { pushUserMessage, pushAssistantMessage, buildPromptWithHistory, escapeForXml } from './conversation-history.js';
import { isWarmPoolEnabled } from '../../runtime/warm-claude-pool.js';
import { maybeSpeakReply } from '../../services/speak-on-reply.js';

const logger = createLogger('channel');

export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';
  private sock: any = null;
  private connected = false;
  private messageHandler: ((message: ChannelMessage) => Promise<void>) | null = null;

  constructor(private root: string, private ownerJid: string | null = null) {}

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
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = baileys;

      const authDir = join(this.root, 'data', 'whatsapp-auth');
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      // WhatsApp servers (as of Feb 2026) reject UserAgent.Platform.WEB for new
      // device pairing — Baileys' default `Browsers.ubuntu()` triggers a
      // "Connection Failure" loop at noise-handshake registration. Switching to
      // Browsers.macOS() sets Platform.MACOS which WhatsApp accepts.
      // See: https://github.com/WhiskeySockets/Baileys/pull/2365 (closed but
      // diagnoses the issue), and Baileys docs noting "When logging in using
      // pairing code, you should only set a valid/logical browser config".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.sock = (makeWASocket as any)({
        auth: state,
        browser: Browsers.macOS('Desktop'),
        // printQRInTerminal removed — deprecated in 6.7.21+ and no longer
        // actually prints. We render QR ourselves below from connection.update.
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        // Render QR codes ourselves — Baileys no longer prints them.
        if (qr) {
          try {
            const qrcode = await import('qrcode-terminal');
            // eslint-disable-next-line no-console
            console.log('\n  Scan the QR below from the WhatsApp account you are linking:\n');
            qrcode.default.generate(qr, { small: true });
            logger.info('WhatsApp QR code printed — scan from the linked phone within ~60s');
          } catch (err) {
            logger.error('Failed to render QR code', { error: String(err) });
            // eslint-disable-next-line no-console
            console.log(`\n  WhatsApp QR payload (paste into any QR generator):\n  ${qr}\n`);
          }
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

        // Hard owner-JID check — drop everything else silently.
        const senderJid = msg.key.remoteJid;
        if (senderJid !== this.ownerJid) {
          logger.debug(`Ignored WhatsApp message from non-owner JID ${senderJid}`);
          return;
        }

        const text = msg.message.conversation ||
          msg.message.extendedTextMessage?.text || '';

        if (!text) return;

        const message: ChannelMessage = {
          id: msg.key.id || '',
          channelType: 'whatsapp',
          from: msg.key.remoteJid || 'unknown',
          text,
          timestamp: new Date((msg.messageTimestamp as number) * 1000),
          metadata: {
            remoteJid: msg.key.remoteJid,
            pushName: msg.pushName,
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
              prompt = `${ctx}<user_message>${escapeForXml(text)}</user_message>`;
              warmPoolKey = convoId;
              buildSystemPrompt = () => buildStaticChannelSystemPrompt('whatsapp');
            } else {
              prompt = buildPromptWithHistory(convoId, text);
              systemPrompt = await buildChannelSystemPrompt('whatsapp', text);
            }

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

            // Fire-and-forget: store conversation in memory.
            // (Previous `skipEmbeddings: true` was a no-op — the option was
            // never read by storeConversation. Removed to stop lying.)
            storeConversation(this.root, {
              prompt: text,
              response: reply,
              channel: 'whatsapp',
              metadata: { remoteJid: msg.key.remoteJid, pushName: msg.pushName },
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
