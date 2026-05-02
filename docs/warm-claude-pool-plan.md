# Warm Claude Pool — Comprehensive Implementation Plan

Last updated: 2026-05-02
Status: pre-build

## 0. Goal

Eliminate the ~3-4s `claude` CLI startup cost from every channel reply by keeping
one long-lived `claude --print` subprocess per channel session and feeding it
new user messages over stdin via the stream-json protocol.

### Success criteria

| Metric | Today | Target |
|---|---|---|
| Telegram first-message wall clock | ~7-10s | ~5s (cold pay) |
| Telegram subsequent message wall clock | ~7-10s | **~1.5-2s** |
| Web SSE first-token latency on warm session | ~3s | **~0.5s** |
| Memory overhead | 0 | ≤300 MB resident per warm session |
| Subprocess regressions | n/a | 0 in heartbeat / sleep agent / brain |

## 1. Verified assumptions (do NOT design around anything not on this list)

Tested 2026-05-02 against `claude` CLI v2.1.122 on macOS 26.

| # | Assumption | Verified by |
|---|---|---|
| V1 | `claude --print --input-format stream-json --output-format stream-json` accepts multiple `{"type":"user","message":{...}}` events on stdin and emits one full result event per input. | `/tmp/test-warm.mjs` |
| V2 | Conversation history is tracked **in-process** across turns (no need to resend). | `/tmp/verify-assumptions.mjs` — turn 2 correctly recalled fact stated in turn 1 |
| V3 | The process stays alive between turns while stdin is open. Closing stdin (`stdin.end()`) causes a clean exit. | same script — idle 2s, `exitCode=null`, then exit 0 after `stdin.end()` |
| V4 | `--max-turns N` is per user message (resets each user input), not cumulative across the session. | turn 2 and 3 both showed `num_turns=1` despite running in the same process |
| V5 | `--system-prompt` is fixed at spawn — it cannot be changed mid-session. | claude CLI source / Claude Code SDK doc convention |
| V6 | First turn ~5.5s (Node + auth + model init); subsequent turns ~1.4s (Haiku) — saving ~4s/turn. | both test scripts |
| V7 | The `result` event includes `duration_ms` (server-side) and arrives only after the assistant's final text. | observed in all test runs |

Assumptions NOT verified (must be tested during implementation):

- **V-tools**: tool calls within a turn (Read, Bash, etc.) emit a clean `result` after the tool loop completes. Probable from API design but not tested.
- **V-error**: an exception inside a turn (e.g. tool failure) still emits `result` with `is_error: true` rather than killing the process. Probable but not tested.
- **V-rate**: rate-limit warnings (`rate_limit_event`) don't terminate the process. Probable from observed event in test 1.

If any of these turn out false during implementation, we fall back to recycling the process on first error.

## 2. Architecture

### 2.1 Components

```
┌─────────────────────────────────────────────────────────┐
│  AgentRuntime / single-agent process                    │
│                                                         │
│  ┌──────────────────┐         ┌────────────────────┐   │
│  │ Telegram channel │────┐    │  WarmClaudePool    │   │
│  └──────────────────┘    │    │  ┌──────────────┐  │   │
│  ┌──────────────────┐    ├───>│  │WarmSession A │  │   │
│  │ WhatsApp channel │────┤    │  │telegram:1234 │  │   │
│  └──────────────────┘    │    │  └──────────────┘  │   │
│  ┌──────────────────┐    │    │  ┌──────────────┐  │   │
│  │  Web SSE         │────┘    │  │WarmSession B │  │   │
│  └──────────────────┘         │  │  web:abc-... │  │   │
│                               │  └──────────────┘  │   │
│  ┌──────────────────┐         └────────────────────┘   │
│  │ heartbeat / sleep│──> bypasses pool, uses           │
│  │  / brain / CLI   │    one-shot subprocess (today)   │
│  └──────────────────┘                                   │
└─────────────────────────────────────────────────────────┘
```

### 2.2 WarmSession state machine

```
   spawn (cold ~5s)         turn (warm ~1.5s)         idle 30 min   /  age 4h  /  50 turns
[NEW] ────────────────> [READY] ──── stdin write ───> [BUSY] ──result──> [READY] ────────> [RECYCLE]
                          ↑                              │                                     │
                          └──── recycle on prompt-hash ──┘                                     │
                                                                                               ↓
                          ┌──────────────────── kill + spawn fresh ─────────────────────────────┘
                          │
                       [NEW]  ←  next message
```

Failure transitions (any state → DEAD): proc exits unexpectedly, stdin write EPIPE, stdout silent past timeout, parse error on stdout JSONL. From DEAD: spawn fresh on next message.

### 2.3 Per-session keying

`sessionKey = ${channel}:${conversationId}` where:
- Telegram: `telegram:${chatId}` (only one chatId per agent — owner)
- WhatsApp: `whatsapp:${remoteJid}`
- Web SSE: `web:${browserSessionId}`

### 2.4 Pool sizing

- Max concurrent sessions: **5** (LRU evict oldest idle when 6th spawned).
- For Alfred's owner-only setup, expected steady state: 1 (telegram) + 0-2 (web) = 1-3.

### 2.5 Concurrency model — per-session mutex

Two messages on the same chatId arriving 500ms apart must NOT both write to the same stdin. Each `WarmSession` holds a Promise chain (`tail`); incoming turns `await tail` then attach. This serializes turns per-session. Cross-session is parallel (different stdin = no contention).

### 2.6 What lives where in the prompt

Today, `buildChannelSystemPrompt(channel, userMessage)` builds one big system prompt that includes per-message dynamic content (pre-fetched memory, recent activity). With warm pool, system prompt is fixed at spawn — it must be **static**.

```
                Today                         Warm pool
─────────────────────────────────  ──────────────────────────────────
SYSTEM PROMPT (per-message)        SYSTEM PROMPT (set once at spawn)
  - SOUL.md                          - SOUL.md
  - USER.md                          - USER.md
  - CLAUDE.md                        - CLAUDE.md
  - skills, sub-agents               - skills, sub-agents
  - fleet awareness                  - fleet awareness
  - pre-fetched memory  ◄──┐         - untrusted-input fence
  - recent activity     ◄──┤
  - notifications       ◄──┤       USER MESSAGE (per turn)
                           │         <context>
USER MESSAGE                ├──────►   Current time: ...
  raw text + history        │         Pre-fetched memory: ...
                            │         Recent activity: ...
                            └─        Notifications: ...
                                     </context>
                                     <user_message>raw text</user_message>
```

The static system prompt is identical for all turns within a warm session. The
volatile `<context>` block is rebuilt per-turn and prepended to the user's text.

This also helps prompt caching: a stable static system prompt maximizes cache
hits. Today's per-message system prompt rebuilds defeat caching.

## 3. File-by-file changes

Order of implementation: bottom-up. Build the pool, unit-test it, then wire channels.

### 3.1 NEW `packages/cli/src/runtime/warm-claude-pool.ts` (~350 lines)

```ts
export type SessionKey = string; // `${channel}:${conversationId}`

interface WarmSessionOptions {
  systemPrompt: string;
  systemPromptHash: string;     // sha256(systemPrompt) — for stale detection
  model: string;
  cwd: string;
  toolPolicy: ToolPolicy;       // 'narrow' | 'broad' | 'owner' (no 'none' here)
  maxTurns: number;             // default 30
}

class WarmSession {
  proc: ChildProcessWithoutNullStreams;
  spawnedAt: number;
  lastUsedAt: number;
  turnCount: number;
  systemPromptHash: string;
  cwd: string;
  toolPolicy: ToolPolicy;
  private tail: Promise<void> = Promise.resolve();  // mutex chain
  private state: 'NEW' | 'READY' | 'BUSY' | 'DEAD' = 'NEW';

  constructor(opts: WarmSessionOptions);
  await ready(): Promise<void>;             // resolves on first init event
  turn(userPrompt: string, opts: { onChunk?, abortSignal? }): Promise<string>;
  recycle(): void;                          // SIGTERM, then SIGKILL after 2s
  isStale(): boolean;                       // age>4h OR turns>50 OR idle>30min
}

export class WarmClaudePool {
  private sessions = new Map<SessionKey, WarmSession>();
  private readonly maxSessions = 5;

  async turn(
    key: SessionKey,
    userPrompt: string,
    buildSystemPrompt: () => string,        // lazily called only on cold spawn
    opts: { model: string; cwd: string; toolPolicy: ToolPolicy; maxTurns: number; onChunk?, abortSignal? }
  ): Promise<string>;

  evictIdle(): void;                        // called every 5 min by interval
  shutdown(): Promise<void>;                // close all on agent stop
  stats(): { active: number; sessions: Array<{ key, age, turns, idle }> };
}
```

**Key behaviors:**
- `turn()` looks up `key`. If missing/stale/dead → spawn fresh (calls `buildSystemPrompt()` to get the static prompt). Hashes the prompt; if existing session's hash differs, recycle. Then `await session.turn(userPrompt)`.
- `WarmSession.turn()` writes one stream-json `user` event to stdin, parses stdout JSONL until a matching `result` event, returns `result.result`. Uses the mutex (`tail`) to serialize.
- Writes SIGPIPE-safe (catch on write).
- 60s hard timeout per turn — if no `result` within 60s, kill+respawn, throw.
- Backpressure: stdout cap at 4MB per turn (current is 2MB; bump because rich tool-call traces can exceed); on overflow → kill+respawn, throw.
- On `proc.on('exit')` or `proc.on('error')`: mark DEAD, fail any pending turn with a recoverable error so caller can retry or fall back.

**Lifecycle integration**: `WarmClaudePool` constructed in `agent-runtime.ts` (or `single-agent` start path), exposed via `getWarmPool()` accessor. `evictIdle()` runs on `setInterval(5*60_000)`. `shutdown()` called from agent stop handler.

### 3.2 MODIFIED `packages/cli/src/claude.ts`

Add a third mode `'warm-pool'` alongside existing `'agent-sdk' | 'sdk' | 'subprocess'`.

New option on `CompleteOptions`:
```ts
warmPoolKey?: string;     // if set AND mode supports it, route to pool
```

Routing in `complete()`:
1. If `opts.warmPoolKey` is set AND warm pool is enabled (env / config) → call `getWarmPool().turn(key, prompt, buildSysPrompt, {...})`.
2. Else fall through to existing `completeSubprocess()`.

Heartbeat / sleep agent / brain pipeline / terminal calls do **not** pass `warmPoolKey` → unchanged behavior (one-shot subprocess each call).

### 3.3 MODIFIED `packages/cli/src/server/channels/system-prompt.ts`

Split current `buildChannelSystemPrompt(channel, userMessage?)` into two functions:

```ts
// Static — set once at warm-pool spawn. Used by both warm and one-shot paths.
// Includes: identity, SOUL.md, USER.md, CLAUDE.md, skills, agents, fleet awareness,
//           untrusted-input fence. NO date/time, NO pre-fetched memory, NO recent activity.
export async function buildStaticChannelSystemPrompt(
  channel: 'telegram' | 'whatsapp' | 'web'
): Promise<string>

// Per-turn — built fresh on every user message. Prepended to user text in warm path.
// Includes: current date/time + tz, pre-fetched memory (hybridSearch), recent activity,
//           pending notifications.
export async function buildPerTurnContextBlock(
  channel: 'telegram' | 'whatsapp' | 'web',
  userMessage: string
): Promise<string>

// Compatibility wrapper — concatenates both. Kept for the one-shot subprocess path.
export async function buildChannelSystemPrompt(
  channel: 'telegram' | 'whatsapp' | 'web',
  userMessage?: string
): Promise<string>
```

The static builder must produce **byte-identical output for byte-identical inputs** (no `Date.now()`, no random IDs) so that hash-based stale detection works.

### 3.4 MODIFIED `packages/cli/src/server/channels/telegram.ts`

In the message handler:

```ts
// before
const prompt = buildPromptWithHistory(convoId, text);
const systemPrompt = await buildChannelSystemPrompt('telegram', text);
const reply = await client.complete(prompt, {
  system: systemPrompt, maxTurns: 30, subprocess: true, cwd: this.root, tools: 'broad',
});

// after
const contextBlock = await buildPerTurnContextBlock('telegram', text);
const userPrompt = `${contextBlock}\n\n<user_message>${escapeForXml(text)}</user_message>`;
const reply = await client.complete(userPrompt, {
  warmPoolKey: `telegram:${chatId}`,
  buildSystemPrompt: () => buildStaticChannelSystemPrompt('telegram'),  // lazy
  maxTurns: 30,
  cwd: this.root,
  tools: 'broad',
  // model picked from getClaudeModel()
});
```

Conversation history changes:
- Stop calling `buildPromptWithHistory` in the warm path — claude tracks history in-process.
- Keep `pushUserMessage` / `pushAssistantMessage` writing to `conversation-history.ts` on disk — needed for **crash recovery** and for the **one-shot fallback path** (sleep, heartbeat) that doesn't have an in-process session.
- `clearHistory()` (called on `/start`) must additionally call `getWarmPool().recycle('telegram:${chatId}')`.

### 3.5 MODIFIED `packages/cli/src/server/channels/whatsapp.ts`

Same shape as telegram. Key: `whatsapp:${remoteJid}`.

### 3.6 MODIFIED `packages/cli/src/server/chat-sse.ts`

Web SSE has streaming via `onChunk`. Pool must support streaming: parse `assistant` events and forward text chunks live.

```ts
const reply = await client.complete(userPrompt, {
  warmPoolKey: `web:${sessionId}`,
  buildSystemPrompt: () => buildStaticChannelSystemPrompt('web'),
  onChunk: (chunk) => sendEvent(res, 'token', { text: chunk }),
  ...
});
```

### 3.7 MODIFIED `packages/cli/src/runtime/agent-runtime.ts` (and `single-agent.ts` if applicable)

- Construct `WarmClaudePool` on agent start.
- Schedule `evictIdle()` interval.
- Call `shutdown()` on agent stop (SIGTERM handler).
- Expose `getWarmPool()` from a module-level accessor (similar to `getClaudeClient`).

### 3.8 MODIFIED `packages/cli/src/server/channels/conversation-history.ts`

Add a `recycleOnClear` option to `clearHistory()` so the channel handler can wire pool recycling. Or — cleaner — channels call both functions explicitly. Pick the latter (less coupling).

### 3.9 NEW `packages/cli/src/runtime/warm-claude-pool.test.ts`

Unit tests with a mock `claude` binary (a small Node script that pretends to speak the protocol):

- spawns a session on first turn
- reuses session on second turn (no respawn)
- recycles when system prompt hash differs
- evicts idle session past 30min (simulated time)
- per-session mutex serializes concurrent turns
- crash mid-turn → next turn spawns fresh
- max 5 sessions → 6th evicts LRU

### 3.10 MODIFIED `packages/cli/src/types.ts`

Add to `IdentityConfig`:
```ts
claude?: {
  mode?: 'agent-sdk' | 'sdk' | 'subprocess';
  model?: string;
  warm_pool?: boolean;          // NEW — default false in v1, flip to true after soak
};
```

### 3.11 MODIFIED `template/.env.example`

Add:
```
# KYBERBOT_WARM_POOL=1   # Enable warm Claude subprocess pool for channels
                         # (~75% latency reduction on warm turns; experimental)
```

## 4. Failure modes & handling

| Failure | Detection | Action |
|---|---|---|
| Process crashes mid-turn | `proc.on('exit')` while turn pending | Reject pending with `WarmTurnError`; mark session DEAD; channel handler retries once with fresh session |
| Process unresponsive | 60s no result event | SIGTERM → 2s grace → SIGKILL; throw; mark DEAD |
| stdin EPIPE | write throws | Mark DEAD; same retry path |
| Stale system prompt (USER.md edit, new skill) | hash mismatch on next turn | Recycle this session before turn |
| RAM bloat after long conversation | turnCount > 50 | Recycle on next turn |
| Long-lived process drift | spawnedAt > 4h ago | Recycle on next turn |
| Idle session | lastUsedAt > 30min ago | Evict in `evictIdle()` cron |
| stdout flood (>4MB) | byte counter | Destroy stdout; mark DEAD; recover |
| Pool full + new session needed | sessions.size >= 5 | LRU evict; spawn fresh |
| `claude` binary missing/wrong version | spawn ENOENT or init parse fails | Fall back to one-shot subprocess; log warn; do not retry pool for 60s |
| Pre-fetch hybridSearch fails | thrown inside `buildPerTurnContextBlock` | Catch → context block omits memory section; still send turn |
| Concurrent message burst | mutex queue grows | OK up to ~10 queued; beyond that, log warn (likely a bug) |

## 5. Verification plan

### 5.1 Unit (vitest)
- `warm-claude-pool.test.ts`: all 8 scenarios in §3.9 above.
- Update `system-prompt.test.ts` to cover the split builders (static byte-stable, per-turn includes time + memory).
- Update `telegram.test.ts` / `whatsapp.test.ts` for the new call shape with mocked pool.

### 5.2 Integration (manual smoke)
1. `KYBERBOT_WARM_POOL=1 kyberbot` — start Alfred locally with pool enabled.
2. Telegram: send "hello" → measure wall clock. Expect ~5s cold.
3. Telegram: send "what's my favorite project?" → expect ~1.5-2s.
4. Telegram: send 3 more messages back to back → all warm.
5. Edit USER.md → next message should recycle (visible in logs as "WarmSession recycle: prompt hash changed"), pay cold cost.
6. Idle 31 min → next message pays cold cost.
7. Web UI: same drill via chat-sse.
8. Heartbeat / sleep agent: confirm one-shot subprocess path is unchanged (no pool involvement).
9. Crash test: `pkill -f "claude --print"` mid-conversation. Next message should recover with cold spawn, no error to user.

### 5.3 Performance budget verification
- Add `logger.info('warm-turn', { key, cold: boolean, durationMs })` so we can grep timing from production logs.
- After 1 day of use, confirm: median warm turn < 2.5s; cold turn rate < 10% of total turns.

## 6. Rollout

### 6.1 Feature flag
- `KYBERBOT_WARM_POOL=1` env var **OR** `identity.yaml: claude.warm_pool: true`.
- v1: default OFF. Users must explicitly opt in.
- After 1 week of soak with no incidents, flip default to ON in v1.next; keep flag for opt-out.

### 6.2 Branching
- Branch off `secure`: `feat/warm-claude-pool`.
- Day 1: pool class + tests.
- Day 2: channel integration + manual smoke + commit.
- Open PR for self-merge to `secure`. Push to user fork.

### 6.3 Rollback
If issues post-deploy: unset `KYBERBOT_WARM_POOL` and restart. All channels fall back to one-shot subprocess (current behavior). No data migration needed — `conversation-history.ts` on-disk record is unchanged.

## 7. Out of scope (do NOT do in this PR)

- **History replay across recycle.** When a warm session is recycled, claude's in-process history is lost. We accept the discontinuity for v1 — the per-turn context block still gets pre-fetched memory and recent activity, so the model has broad continuity. If users complain, follow-up PR adds replay.
- **Pool sharing across agents in fleet mode.** Each agent owns its own pool. Cross-agent pooling is out.
- **Anthropic SDK mode.** Subscription-auth ToS forbids it. We're not switching authentication.
- **Streaming partial tokens.** `--include-partial-messages` exists but has its own pitfalls. Stick with `assistant` event chunks (one per content block) — already gives a good "first byte" for SSE.
- **`--bare` mode optimization.** Could shave ~500ms off cold start by skipping memory paths, hooks, plugin sync. Test separately after warm pool lands; don't bundle.

## 8. Open questions to resolve at build time

1. Does V-tools hold? Test by enabling Read tool in a warm session and asking the model to read a file. If `result` doesn't arrive cleanly, we may need to detect tool_use→tool_result loops in the parser.
2. Does the cold-turn improvement compound when we run pool + Sonnet vs pool + Haiku? Decide after measurement; the user has rejected unilateral Haiku swap so default model stays as identity.yaml says.
3. Should `--include-hook-events` be enabled to capture more parse signals? Probably not for v1 — adds output volume.
4. Is there value in a `kyberbot pool stats` / `kyberbot pool reset` CLI? Probably yes — add as a small follow-up after main PR.

## 9. Estimated effort

| Phase | Time |
|---|---|
| Pool class + protocol parser | 4-5 hr |
| Unit tests (mock claude) | 2-3 hr |
| System prompt split | 1 hr |
| Channel wiring (Telegram, WhatsApp, web) | 2 hr |
| Manual smoke + perf measurement | 2 hr |
| Bug fixes / edge cases (likely) | 2-4 hr |
| **Total** | **~13-17 hr** (≈2 days) |
