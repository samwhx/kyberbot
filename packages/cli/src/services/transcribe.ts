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
import { tmpdir, homedir } from 'node:os';
import { createLogger } from '../logger.js';

const logger = createLogger('transcribe');

// Two whisper distros in the wild:
//   * Homebrew `whisper-cpp` → installs binary at /opt/homebrew/bin/whisper-cli
//     CLI shape: -m <model.bin> -f <input> -otxt -of <output_prefix>
//     Requires explicit model path; brew formula does NOT install models.
//   * pip / pipx `openai-whisper` → installs binary at $PATH/whisper
//     CLI shape: <input> --model base --output_format txt --output_dir <dir>
//     Model name only; auto-downloads under ~/.cache/whisper/.
type WhisperFlavour = 'cpp' | 'python';
interface DetectedWhisper { bin: string; flavour: WhisperFlavour; }

const KNOWN_BINARIES: Array<{ bin: string; flavour: WhisperFlavour }> = [
  // PATH-relative names (tried first — works in normal shells)
  { bin: 'whisper-cli', flavour: 'cpp' },     // homebrew whisper-cpp formula
  { bin: 'whisper-cpp', flavour: 'cpp' },     // hypothetical alt naming
  { bin: 'whisper', flavour: 'python' },      // openai-whisper Python CLI
  // Absolute paths (fallback when PATH doesn't include brew dirs —
  // common when kyberbot is launched from a launchd plist or systemd
  // unit that strips the user's PATH).
  { bin: '/opt/homebrew/bin/whisper-cli', flavour: 'cpp' },
  { bin: '/usr/local/bin/whisper-cli', flavour: 'cpp' },
  { bin: '/opt/homebrew/bin/whisper-cpp', flavour: 'cpp' },
  { bin: '/usr/local/bin/whisper-cpp', flavour: 'cpp' },
  { bin: '/opt/homebrew/bin/whisper', flavour: 'python' },
  { bin: '/usr/local/bin/whisper', flavour: 'python' },
];

async function detectWhisper(override?: string): Promise<DetectedWhisper | null> {
  if (override) {
    const flavour = override.includes('cli') || override.includes('cpp') ? 'cpp' : 'python';
    if (await binaryExists(override)) return { bin: override, flavour };
  }
  for (const cand of KNOWN_BINARIES) {
    if (await binaryExists(cand.bin)) return cand;
  }
  return null;
}

function binaryExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    proc.on('error', () => { if (!settled) { settled = true; resolve(false); } });
    proc.on('close', (code) => { if (!settled) { settled = true; resolve(code === 0); } });
    setTimeout(() => { if (!settled) { settled = true; try { proc.kill(); } catch {} resolve(false); } }, 5000);
  });
}

/**
 * Resolve the whisper.cpp model file path. Precedence:
 *   1. KYBERBOT_WHISPER_MODEL env var (absolute path or filename)
 *   2. options.modelPath
 *   3. ~/.kyberbot/whisper/ggml-<model>.bin (or ggml-<model>.en.bin if English)
 *   4. Common brew locations as a last resort
 */
function resolveCppModelPath(model: string, override?: string): string | null {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  if (process.env.KYBERBOT_WHISPER_MODEL) candidates.push(process.env.KYBERBOT_WHISPER_MODEL);
  const base = `${homedir()}/.kyberbot/whisper`;
  candidates.push(join(base, `ggml-${model}.en.bin`));
  candidates.push(join(base, `ggml-${model}.bin`));
  // Some users keep whisper.cpp model files alongside the binary.
  candidates.push(`/opt/homebrew/share/whisper-cpp/ggml-${model}.en.bin`);
  candidates.push(`/usr/local/share/whisper-cpp/ggml-${model}.en.bin`);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

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
  /** Override the whisper binary name. Auto-detected when omitted. */
  binary?: string;
  /** Model size: tiny / base / small / medium / large. Default: base. */
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  /** Absolute path to a whisper.cpp .bin model file. Overrides auto-resolution. */
  modelPath?: string;
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

  const detected = await detectWhisper(options.binary);
  if (!detected) {
    logger.warn('No whisper binary found on PATH', {
      tried: KNOWN_BINARIES.map((b) => b.bin),
    });
    return null;
  }

  // Write the audio to a temp file. whisper.cpp doesn't read stdin
  // reliably across formats — file path is the safest interop.
  const tmpDir = tmpdir();
  const ext = mimeToExtension(mime);
  const tmpInput = join(tmpDir, `kb-whisper-${hash.slice(0, 12)}.${ext}`);
  writeFileSync(tmpInput, bytes);

  const model = options.model ?? 'base';
  const timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;
  const outputDir = join(options.root, 'data', 'transcripts');
  const outputPrefix = join(outputDir, `kb-whisper-${hash.slice(0, 12)}`);

  let args: string[];
  let resolvedModelPath: string | null = null;

  if (detected.flavour === 'cpp') {
    resolvedModelPath = resolveCppModelPath(model, options.modelPath);
    if (!resolvedModelPath) {
      logger.warn('whisper.cpp model file not found', {
        searched: [
          `~/.kyberbot/whisper/ggml-${model}.en.bin`,
          `~/.kyberbot/whisper/ggml-${model}.bin`,
          `KYBERBOT_WHISPER_MODEL env var`,
        ],
        hint: 'Run: mkdir -p ~/.kyberbot/whisper && curl -L -o ~/.kyberbot/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
      });
      try { unlinkSync(tmpInput); } catch { /* ignore */ }
      return null;
    }
    args = [
      '-m', resolvedModelPath,
      '-f', tmpInput,
      '-otxt',
      '-of', outputPrefix,
      '-nt',
      '-np',
    ];
    if (options.language) args.push('-l', options.language);
  } else {
    // Python openai-whisper CLI
    args = [
      tmpInput,
      '--model', model,
      '--output_format', 'txt',
      '--output_dir', outputDir,
      '--fp16', 'False',
    ];
    if (options.language) args.push('--language', options.language);
  }

  logger.info('Running whisper', {
    bin: detected.bin,
    flavour: detected.flavour,
    model: resolvedModelPath ?? model,
    input: tmpInput,
    inputBytes: bytes.length,
    inputMime: mime,
    outputPrefix,
  });

  const start = Date.now();
  const result = await runWithTimeout(detected.bin, args, timeoutMs);
  const durationMs = Date.now() - start;

  // Don't delete the input file yet — keep for debugging if we got no
  // output. Cleaned at the very end on success.

  if (!result.ok) {
    logger.warn('whisper transcription failed', {
      bin: detected.bin,
      hash,
      code: result.code,
      signal: result.signal,
      stderr: result.stderr.slice(0, 800),
      stdout: result.stdout.slice(0, 400),
      inputKept: tmpInput,
    });
    return null;
  }

  // Output file location differs by flavour:
  //   cpp:    <outputPrefix>.txt    (we control the prefix)
  //   python: <outputDir>/<basename-of-input>.txt
  const whisperOut = detected.flavour === 'cpp'
    ? `${outputPrefix}.txt`
    : join(outputDir, `${tmpInput.split('/').pop()!.replace(/\.[^.]+$/, '')}.txt`);

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
    logger.warn('whisper produced empty transcript', {
      hash,
      durationMs,
      expectedOutput: whisperOut,
      outputExists: existsSync(whisperOut),
      stdoutHead: result.stdout.slice(0, 400),
      stderrHead: result.stderr.slice(0, 800),
      inputKept: tmpInput,
    });
    return null;
  }

  // Success — clean up the temp input now.
  try { unlinkSync(tmpInput); } catch { /* ignore */ }

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
 * Quick availability check — true iff any supported whisper binary is on
 * PATH. Used by onboarding and diagnostic commands.
 */
export async function isTranscribeAvailable(binary?: string): Promise<boolean> {
  const detected = await detectWhisper(binary);
  return detected !== null;
}

/**
 * Report which whisper binary + model would be used for the agent at
 * `root`. Returns null if nothing is ready. For diagnostics.
 */
export async function describeTranscribeSetup(opts: { binary?: string; model?: string; modelPath?: string } = {}): Promise<
  { bin: string; flavour: WhisperFlavour; modelPath?: string; modelReady: boolean } | null
> {
  const detected = await detectWhisper(opts.binary);
  if (!detected) return null;
  if (detected.flavour === 'cpp') {
    const modelPath = resolveCppModelPath(opts.model ?? 'base', opts.modelPath);
    return { bin: detected.bin, flavour: detected.flavour, modelPath: modelPath ?? undefined, modelReady: !!modelPath };
  }
  return { bin: detected.bin, flavour: detected.flavour, modelReady: true };
}
