/**
 * Speak Command
 *
 * Convert text to speech via OpenAI TTS (tts-1-hd / echo by default) and
 * play locally on the host's audio output (Mac mini speakers, paired
 * Bluetooth speaker, AirPlay device — whatever macOS Sound output is set
 * to). Designed to be invocable by Alfred (the agent) on channel paths
 * via `Bash(kyberbot:*)` policy.
 *
 * Usage:
 *   kyberbot speak "Welcome home, sir."
 *   kyberbot speak --voice onyx "Authoritative tone for serious matters."
 *   kyberbot speak --voice fable --model tts-1 "Cheaper, slightly lower quality."
 *
 * Reads OPENAI_API_KEY from the agent's .env (loaded by the CLI entry).
 * Audio plays via macOS `afplay`. No Telegram delivery — Telegram voice
 * notes don't auto-play, defeating the "Jarvis voice" goal. To hear Alfred
 * outside the home, just read the text reply on your phone.
 *
 * Voice mode (off / speakers) is a separate concern: Alfred reads
 * data/state/voice.json before deciding whether to invoke this command.
 */

import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import chalk from 'chalk';
import { createLogger } from '../logger.js';

const logger = createLogger('speak');

const VALID_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
const VALID_MODELS = ['tts-1', 'tts-1-hd'] as const;
const MAX_INPUT_CHARS = 4000; // OpenAI TTS hard limit is 4096; leave headroom

interface SpeakOptions {
  voice: string;
  model: string;
  /** When true, generate the audio but don't play it (for piping / testing). */
  dryRun?: boolean;
}

export function createSpeakCommand(): Command {
  const cmd = new Command('speak')
    .description('Speak text aloud via OpenAI TTS + local audio output')
    .argument('<text>', 'text to speak (will be truncated at 4000 chars)')
    .option(
      '-v, --voice <name>',
      `voice: ${VALID_VOICES.join(' | ')}`,
      'echo',
    )
    .option(
      '-m, --model <name>',
      `model: ${VALID_MODELS.join(' | ')} (default: tts-1 — half the latency of tts-1-hd; use --model tts-1-hd for highest fidelity)`,
      'tts-1',
    )
    .option('--dry-run', 'generate audio file but do not play it')
    .action(async (text: string, options: SpeakOptions) => {
      // Validate inputs early
      if (!text || !text.trim()) {
        console.error(chalk.red('error: empty text'));
        process.exit(2);
      }
      if (!VALID_VOICES.includes(options.voice as typeof VALID_VOICES[number])) {
        console.error(chalk.red(`error: invalid voice "${options.voice}". Valid: ${VALID_VOICES.join(', ')}`));
        process.exit(2);
      }
      if (!VALID_MODELS.includes(options.model as typeof VALID_MODELS[number])) {
        console.error(chalk.red(`error: invalid model "${options.model}". Valid: ${VALID_MODELS.join(', ')}`));
        process.exit(2);
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error(chalk.red('error: OPENAI_API_KEY is not set. Add it to your agent .env.'));
        process.exit(1);
      }

      // Truncate to OpenAI's TTS input cap. We leave the truncated audio
      // playable rather than failing — Alfred passing a slightly-too-long
      // reply shouldn't break voice mode.
      const input = text.length > MAX_INPUT_CHARS
        ? text.slice(0, MAX_INPUT_CHARS - 1) + '…'
        : text;

      logger.debug('tts request', { voice: options.voice, model: options.model, chars: input.length });

      // Generate audio via OpenAI. mp3 picked over opus for afplay
      // compatibility (Core Audio handles mp3 universally; opus is iffier).
      let audioBuffer: Buffer;
      try {
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: options.model,
            voice: options.voice,
            input,
            response_format: 'mp3',
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '<no body>');
          console.error(chalk.red(`error: OpenAI TTS failed (${response.status}): ${errText.slice(0, 500)}`));
          process.exit(1);
        }

        audioBuffer = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        console.error(chalk.red(`error: OpenAI TTS request failed: ${String(err)}`));
        process.exit(1);
      }

      const tmpFile = join(tmpdir(), `kyberbot-speak-${Date.now()}-${process.pid}.mp3`);
      writeFileSync(tmpFile, audioBuffer);

      if (options.dryRun) {
        // Print path so callers can move/inspect/upload elsewhere
        console.log(tmpFile);
        return;
      }

      // Play synchronously via afplay (macOS). On non-Mac hosts this would
      // need a different player; for now we only support Mac because that's
      // the only deployment target.
      try {
        execFileSync('afplay', [tmpFile], { stdio: 'inherit' });
      } catch (err) {
        console.error(chalk.red(`error: afplay failed: ${String(err)}`));
        // Fall through to cleanup before exit
        try { unlinkSync(tmpFile); } catch { /* best-effort */ }
        process.exit(1);
      }

      // Cleanup temp file. Fire-and-forget — if this fails, /tmp will be
      // cleaned by the OS eventually.
      try { unlinkSync(tmpFile); } catch { /* best-effort */ }
    });

  return cmd;
}
