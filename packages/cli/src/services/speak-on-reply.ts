/**
 * Speak-on-reply hook
 *
 * Runs in the channel handler AFTER a text reply has been sent. Reads
 * `<root>/data/state/voice.json` and, if voice mode is "speakers", spawns
 * `kyberbot speak` detached. The caller is not blocked: the Telegram /
 * WhatsApp / web reply has already been delivered; audio plays in the
 * background while the user reads.
 *
 * Why this lives here instead of inside Alfred's reply turn:
 *
 * Previously SOUL.md instructed Alfred to call `kyberbot speak` himself
 * as a tool inside his reply. That serialized the entire turn — Alfred's
 * reply turn didn't complete until the speak subprocess returned, which
 * (with afplay synchronous) didn't return until audio finished playing.
 * The Telegram text reply was held up the entire time. For a 4-second
 * spoken response, that was 4 seconds of "waiting for sound waves" added
 * to the user-perceived turn latency.
 *
 * Moving the trigger here means: text reply lands in ~2-3s, audio starts
 * ~1.5s after that, both in parallel with the user reading. Total
 * perceived latency drops from ~7-10s to ~2-3s for text-visible.
 *
 * Trade-off: Alfred no longer chooses per-reply whether to speak. The
 * handler decides based on simple heuristics (length, code-density,
 * voice-mode state). If we ever want fine-grained per-reply control, we
 * add a structured marker Alfred can include in his reply text (e.g.
 * `<no-speak>` at the start) and parse it here.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('speak-on-reply');

/** Replies shorter than this are skipped — speak overhead exceeds value. */
const MIN_REPLY_CHARS = 50;
/** If more than this fraction of the reply is code blocks, skip — TTS mangles syntax. */
const MAX_CODE_RATIO = 0.3;

interface VoiceState {
  mode?: 'off' | 'speakers' | string;
}

/**
 * Fire-and-forget. Never throws. Returns synchronously after spawning
 * (or deciding not to). Audio playback is the spawned child's problem.
 */
export function maybeSpeakReply(replyText: string, root: string): void {
  if (!replyText || !replyText.trim()) return;

  // 1. Voice mode check — must be enabled
  const stateFile = join(root, 'data', 'state', 'voice.json');
  if (!existsSync(stateFile)) return;

  let state: VoiceState;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf-8')) as VoiceState;
  } catch (err) {
    logger.debug('voice.json unreadable, skipping speak', { error: String(err) });
    return;
  }
  if (state.mode !== 'speakers') return;

  // 2. Length filter — short replies aren't worth the speak overhead
  if (replyText.trim().length < MIN_REPLY_CHARS) {
    logger.debug('skipping speak: reply too short', { len: replyText.length });
    return;
  }

  // 3. Code-density filter — TTS reading code is unhelpful
  const codeBlockChars = (replyText.match(/```[\s\S]*?```/g) || []).join('').length;
  if (codeBlockChars > replyText.length * MAX_CODE_RATIO) {
    logger.debug('skipping speak: code-heavy', {
      ratio: codeBlockChars / replyText.length,
    });
    return;
  }

  // 4. Strip markdown so TTS doesn't read out asterisks, hash signs etc.
  const cleaned = stripMarkdownForSpeech(replyText);
  if (!cleaned) return;

  // 5. Spawn detached `kyberbot speak`. We don't await; we don't even
  //    capture stdout. The child plays audio in the background and exits
  //    on its own.
  try {
    const child = spawn('kyberbot', ['speak', cleaned], {
      stdio: 'ignore',
      detached: true,
      env: process.env,
      cwd: root,
    });
    child.unref();
    logger.debug('spawned speak (detached)', { chars: cleaned.length });
  } catch (err) {
    logger.warn('failed to spawn kyberbot speak', { error: String(err) });
  }
}

/**
 * Markdown stripping tuned for spoken delivery, not for rendering. Drops
 * code blocks, inline code, link URLs (keeps the visible text), images,
 * heading marks, blockquote chevrons, and bold/italic markers.
 */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')                  // fenced code
    .replace(/`([^`]+)`/g, '$1')                     // inline code (keep contents)
    .replace(/\*{2}([^*]+)\*{2}/g, '$1')             // **bold**
    .replace(/\*([^*]+)\*/g, '$1')                   // *italic*
    .replace(/_{2}([^_]+)_{2}/g, '$1')               // __bold__
    .replace(/_([^_]+)_/g, '$1')                     // _italic_
    .replace(/^#{1,6}\s+/gm, '')                     // headings
    .replace(/^>\s+/gm, '')                          // blockquotes
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')        // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')         // [link text](url) → link text
    .replace(/\n{3,}/g, '\n\n')                      // collapse blank lines
    .trim();
}
