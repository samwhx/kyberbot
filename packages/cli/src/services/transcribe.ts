/**
 * KyberBot — Voice transcription via whisper.cpp
 *
 * Spawns the `whisper` binary (whisper.cpp, install via
 * `brew install whisper-cpp`) to transcribe audio attachments coming
 * from messaging channels. Transcripts are written to
 * `data/transcripts/<sha>.txt` so re-transcribing the same audio is a
 * disk-read instead of a CPU burn.
 *
 * Designed to fail soft: if whisper isn't installed or the spawn
 * fails, transcribe() returns null and the channel handler decides
 * how to proceed (typically: still forward the message text, mark the
 * audio as `[voice note]` placeholder).
 *
 * Why whisper.cpp not OpenAI Whisper API: privacy posture for the
 * hardening fork. Audio stays on-device. Cost stays $0.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../logger.js';

const logger = createLogger('transcribe');

/**
 * Result of a transcription attempt. `null` when whisper is unavailable
 * or the call failed in a way the caller should fall back from.
 */
export interface TranscribeResult {
  text: string;
  durationMs: number;
  cached: boolean;
  hash: string;
}

export interface TranscribeOptions {
  /** Per-agent root so we cache transcripts under data/transcripts/. */
  root: string;
  /** Override the whisper binary name. Default: `whisper`. */
  binary?: string;
  /** Model size: tiny / base / small / medium / large. Default: base. */
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  /** Language hint (ISO-639-1, e.g. 'en'). Default: auto-detect. */
  language?: string;
  /** Hard timeout in seconds (whisper hangs sometimes). Default: 60. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_S = 60;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function transcriptCachePath(root: string, hash: string): string {
  return join(root, 'data', 'transcripts', `${hash}.txt`);
}

function ensureCacheDir(root: string): void {
  const dir = join(root, 'data', 'transcripts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function mimeToExtension(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp3') || m.includes('mpeg')) return 'mp3';
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  return 'bin';
}

/**
 * Transcribe an audio buffer. Returns null when whisper is unavailable
 * or the call fails; the caller is expected to degrade to a `[voice]`
 * placeholder and continue.
 */
export async function transcribe(
  bytes: Buffer,
  mime: string,
  options: TranscribeOptions,
): Promise<TranscribeResult | null> {
  const hash = sha256(bytes);
  const cachePath = transcriptCachePath(options.root, hash);

  if (existsSync(cachePath)) {
    try {
      const text = readFileSync(cachePath, 'utf-8').trim();
      if (text.length > 0) {
        logger.debug('Transcript cache hit', { hash });
        return { text, durationMs: 0, cached: true, hash };
      }
    } catch { /* fall through to fresh transcription */ }
  }

  ensureCacheDir(options.root);

  // Write the audio to a temp file. whisper.cpp doesn't read stdin
  // reliably across formats — file path is the safest interop.
  const tmpDir = tmpdir();
  const ext = mimeToExtension(mime);
  const tmpInput = join(tmpDir, `kb-whisper-${hash.slice(0, 12)}.${ext}`);
  writeFileSync(tmpInput, bytes);

  const binary = options.binary ?? 'whisper';
  const model = options.model ?? 'base';
  const timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;

  const args: string[] = [
    tmpInput,
    '--model', model,
    '--output_format', 'txt',
    '--output_dir', join(options.root, 'data', 'transcripts'),
    '--fp16', 'False',
  ];
  if (options.language) args.push('--language', options.language);

  const start = Date.now();
  const result = await runWithTimeout(binary, args, timeoutMs);
  const durationMs = Date.now() - start;

  try { unlinkSync(tmpInput); } catch { /* best-effort cleanup */ }

  if (!result.ok) {
    logger.warn('whisper transcription failed', {
      hash,
      code: result.code,
      signal: result.signal,
      stderr: result.stderr.slice(0, 300),
    });
    return null;
  }

  // whisper writes <basename>.txt to --output_dir. We rename to <hash>.txt
  // so cache hits work next time.
  const whisperOut = join(
    options.root,
    'data',
    'transcripts',
    `${tmpInput.split('/').pop()!.replace(/\.[^.]+$/, '')}.txt`,
  );
  let text = '';
  try {
    if (existsSync(whisperOut)) {
      text = readFileSync(whisperOut, 'utf-8').trim();
      writeFileSync(cachePath, text);
      try { unlinkSync(whisperOut); } catch { /* ignore */ }
    } else {
      // Some whisper builds print to stdout instead of writing a file.
      text = result.stdout.trim();
      if (text.length > 0) writeFileSync(cachePath, text);
    }
  } catch (err) {
    logger.warn('Failed to read whisper output', { hash, error: String(err) });
    return null;
  }

  if (text.length === 0) {
    logger.debug('whisper produced empty transcript', { hash, durationMs });
    return null;
  }

  logger.info('Transcribed audio', { hash, durationMs, chars: text.length });
  return { text, durationMs, cached: false, hash };
}

interface ProcResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, code: null, signal: 'SIGKILL', stdout, stderr: stderr + '\n[timeout]' });
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, stdout, stderr: stderr + `\n${err.message}` });
    });

    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, signal, stdout, stderr });
    });
  });
}

/**
 * Quick availability check — true iff `whisper` exists on PATH.
 * Used by onboarding to nudge `brew install whisper-cpp` upfront.
 */
export async function isTranscribeAvailable(binary = 'whisper'): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(binary, ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    proc.on('error', () => { if (!settled) { settled = true; resolve(false); } });
    proc.on('close', (code) => { if (!settled) { settled = true; resolve(code === 0); } });
    setTimeout(() => { if (!settled) { settled = true; try { proc.kill(); } catch {} resolve(false); } }, 3000);
  });
}
