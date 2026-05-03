#!/usr/bin/env node
/**
 * Fake `claude` binary for warm-pool integration tests. Speaks just enough
 * of the stream-json protocol that the pool can drive it.
 *
 * Behavior selectors via environment variables:
 *   FAKE_CLAUDE_DELAY_MS=N       — delay before each `result` (default 0)
 *   FAKE_CLAUDE_DIE_AT_TURN=N    — exit(1) immediately before turn N's result
 *   FAKE_CLAUDE_HANG_AT_TURN=N   — never emit result for turn N
 *   FAKE_CLAUDE_REPLY_PREFIX=str — prefix on the assistant text (default "echo: ")
 *   FAKE_CLAUDE_INIT_DELAY_MS=N  — delay before emitting init (default 0)
 */

import readline from 'readline';

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const systemPrompt = getArg('--system-prompt') || '';
const model = getArg('--model') || 'fake';
const delayMs = parseInt(process.env.FAKE_CLAUDE_DELAY_MS || '0', 10);
const dieAtTurn = parseInt(process.env.FAKE_CLAUDE_DIE_AT_TURN || '0', 10);
const hangAtTurn = parseInt(process.env.FAKE_CLAUDE_HANG_AT_TURN || '0', 10);
const initDelay = parseInt(process.env.FAKE_CLAUDE_INIT_DELAY_MS || '0', 10);
const prefix = process.env.FAKE_CLAUDE_REPLY_PREFIX || 'echo: ';

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const sessionId = 'fake-session-' + Math.random().toString(36).slice(2, 10);

setTimeout(() => {
  write({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    cwd: process.cwd(),
    system_prompt_len: systemPrompt.length,
  });
}, initDelay);

let turnNum = 0;
let pendingTurns = 0;
let stdinClosed = false;

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== 'user') return;

  turnNum += 1;
  const userText = msg.message?.content?.[0]?.text || '';

  if (dieAtTurn === turnNum) {
    process.exit(1);
  }
  if (hangAtTurn === turnNum) {
    return;
  }

  pendingTurns += 1;
  setTimeout(() => {
    const replyText = `${prefix}${userText}`;
    write({
      type: 'assistant',
      message: { model, role: 'assistant', content: [{ type: 'text', text: replyText }] },
      session_id: sessionId,
    });
    write({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: replyText,
      duration_ms: delayMs,
      num_turns: 1,
      session_id: sessionId,
    });
    pendingTurns -= 1;
    if (stdinClosed && pendingTurns === 0) process.exit(0);
  }, delayMs);
});

rl.on('close', () => {
  stdinClosed = true;
  if (pendingTurns === 0) process.exit(0);
});
