# Changelog

## [1.9.0-secure] - 2026-05-01 — personal-fork hardening

A focused security + perf pass on top of upstream 1.9.0, intended for
single-user Tailscale-only personal-Jarvis deployment. Two security
audits closed ~43 findings; performance work brought cold search from
~2-6s to under 1.5s on a typical query.

### Security hardening

- All HTTP servers bind `127.0.0.1` by default; override via
  `KYBERBOT_BIND_HOST`. ChromaDB Docker container also binds 127.0.0.1
  in both auto-start paths and the docker-compose template.
- `KYBERBOT_API_TOKEN` is now mandatory (≥32 chars). The auth middleware
  no longer falls through to no-auth when unset; the server refuses to
  start. Fleet-auth no longer falls through either.
- New `ToolPolicy` (`none`/`narrow`/`broad`/`owner`) replaces the
  previous always-`--dangerously-skip-permissions` pattern in
  `claude.ts`. Channel handlers and heartbeat run with `'broad'` —
  Read/Write/Edit/Skill plus `Bash(kyberbot:*)`, but no arbitrary Bash
  or Agent tool. Owner-driven CLI sessions keep full access.
- WhatsApp channel refuses to start without `owner_jid` configured;
  silently drops messages from any other JID. `kyberbot channel add
  whatsapp` now prompts for the JID with format validation.
- Telegram verification: 128-bit code (was 24-bit), constant-time
  compare via `timingSafeEqual`, per-chatId rate limit (5 attempts /
  10 min lockout).
- Channel/web prompts wrap user content in `<user_message>` /
  `<assistant_message>` XML tags with HTML-entity escaping. The system
  prompt instructs the model to treat tag contents as data, not
  instructions.
- `POST /api/web/manage/brain-notes/read` now contains path lookups
  via `realpathSync` + `startsWith` allowed-roots check (was:
  any-file-read).
- Web UI: token via paste only — `?token=...` URL capture removed
  (referer/log/history leak); markdown link allowlist
  (https/mailto/relative); `javascript:` / `data:` rendered as text.
- `onboard` chmods `.env` to 0600 after writing keys.
- `template/.gitignore` excludes `identity.yaml` (bot tokens) and
  `data/whatsapp-auth/` (full session creds) so `kyberbot backup`
  can't push them to GitHub.
- `@anthropic-ai/claude-code` bumped to `^2.1.84` (closes
  GHSA-q5hj-mxqh-vv77 trust-dialog bypass). `auditConfig.ignoreCves`
  suppression of GHSA-37ch-88jc-xwx2 (path-to-regexp ReDoS) removed.

### Search performance

- Hybrid-search rerank routed through OpenAI `gpt-5.4-nano` by
  default (~300ms via direct API), with Claude Haiku subprocess as
  automatic fallback. `temperature: 0`, `response_format: json_object`
  for reliable parsing, hard `AbortSignal.timeout(5000)`. Configurable
  via `identity.yaml: rerank.{provider,model}` or
  `KYBERBOT_RERANK_PROVIDER` env.
- Three N+1 SQLite query patterns rewritten as batched `IN`-clause
  lookups: `enrichResults` and `addRelatedMemories` in `hybrid-search.ts`,
  and `getRelatedMemories` in `recall.ts`. Per-search round-trips drop
  from ~41 to 3; per-`recall` from ~81 to 3.

### Surgical cleanup

- Removed Kybernesis Cloud sync (the `kyberbot kybernesis ...` CLI,
  the auto-query directive in `template/.claude/CLAUDE.md`, the
  config field in `IdentityConfig`, and the `KYBERNESIS_API_KEY`
  prompt in `onboard`). Memory stays local in this fork.
- Removed ngrok tunnel (`commands/tunnel.ts`, `services/tunnel.ts`,
  the wiring in `runtime/fleet-manager.ts` / `commands/run.ts` /
  `commands/fleet.ts` / `splash.ts`, the `tunnel` field in
  `IdentityConfig`). Cross-device reach is via Tailscale; no public
  ingress is wanted.
- Removed `/api/execute` (`server/execute-api.ts`) — the desktop-app
  endpoint is unused by the web UI, which uses `/api/web/chat` (SSE).
- Removed `commands/eval.ts` and `brain/eval/` (~3,300 LOC of
  upstream-developer LoCoMo benchmark code).
- Stripped stale references to all of the above from `docs/`,
  `README.md`, `template/.claude/CLAUDE.md`, and the `kyberbot.md`
  commands template (the LLM is no longer told about commands that
  don't exist).
- Renamed onboard wizard from "9 steps" to "7 steps" (removed
  Kybernesis-cloud and remote-access steps).
- Removed the misleading `skipEmbeddings` parameter from
  `storeConversation` — the option was never honored by the
  implementation, so passing it from Telegram/WhatsApp call sites
  was a no-op masquerading as an opt-out.

### Tests

- 432/432 vitest cases passing (was 390 + 36 failing on the prior
  hardening contracts that pre-dated the test alignment).
- Added net +6 tests for previously-uncovered hardening behaviors:
  too-short-token rejection, WhatsApp owner-jid refusal, WhatsApp
  non-owner JID drop, web vs messaging channel tool-access prompts,
  untrusted-input handling directive, XML-tag injection escape.

## [1.0.0] - 2026-03-31

### Cognitive Memory System

KyberBot 1.0 introduces a cognitive quality layer to the memory system — source tracking, real-time fact extraction, confidence decay, entity profiles, contradiction surfacing, user corrections, and a reasoning engine that derives insights the agent wasn't explicitly told.

#### Source Confidence Weighting
- Every entity mention and fact is tagged with a `source_type` and `confidence` score
- Terminal commands: `user-direct` (0.95), chat messages: `chat` (0.85), heartbeat: `heartbeat` (0.80), AI-extracted: `ai-extraction` (0.60)
- Higher-confidence sources naturally supersede lower ones during contradiction resolution

#### Real-Time Fact Extraction
- Facts are now extracted immediately when a conversation is stored via a lightweight Haiku call
- No longer need to wait for the hourly sleep cycle — `kyberbot recall` works right after mentioning someone
- Sleep agent observe step skips already-extracted conversations to avoid duplicates

#### Ingestion Validation
- New `NOISE_WORDS` set blocks conversational noise (ok, hello, speaker, thing, stuff, someone, etc.)
- Added `speaker\d+` pattern to catch transcription artifacts at ingestion time (previously only caught during entity hygiene)

#### Alias Dedup at Write Time
- `findOrCreateEntity()` now checks stored aliases when the normalized name lookup fails
- "Nicholas Rith" automatically maps to "Nick Frith" if the latter has it as an alias
- Previously aliases were only resolved during sleep agent entity hygiene

#### User Correction Flow
- Facts can be retracted (`is_retracted` field) and tagged with `retracted_by`
- Natural correction via the remember skill: "Actually, John works at Beta Inc, not Acme" stores the correct fact at high confidence and the contradiction system auto-supersedes the old one
- Updated remember skill with Correction Detection section

#### Confidence Decay
- Weekly fact confidence decay: unreinforced AI/chat facts older than 90 days lose 5% confidence per cycle
- Floor of 0.15 — nothing decays to zero
- `last_reinforced_at` tracking — when the same fact is seen again, it's reinforced instead of duplicated

#### Compiled Narrative Profiles
- Entities with 3+ facts get a natural-language 2-sentence profile generated by the sleep agent
- Profiles appear at the top of `kyberbot recall` output, replacing the raw data dump
- Regenerated when fact count changes

#### Quiet Contradiction Tracking
- New `contradictions` table in entity-graph.db
- When conflicting facts have close confidence (gap <= 0.3), both are kept and the conflict is surfaced in recall
- Large confidence gaps still auto-resolve (higher wins)
- Users can clarify contradictions naturally, which resolves them

#### Reasoning Engine (Deduction + Induction)
- New `reasoning.ts` sleep step processes 3-5 entities per cycle
- **Deduction** (0.80+ confidence): logically certain conclusions from 2+ facts
- **Induction** (0.60-0.75 confidence): probable patterns from 3+ data points
- Insights stored in `entity_insights` table and displayed in recall output
- Quality detection flags contradictions, misattributions, and stale facts

#### Enhanced Recall Output
- Profile paragraph at top (when available)
- Known Facts section with confidence percentages
- Relationships with rationale
- Insights section with `[inferred]` and `[pattern]` tags
- Open contradictions surfaced as natural-language notes

#### Sleep Agent Expansion
- Now runs a 10-step cycle (was 6): decay, tag, consolidate, link, tier, summarize, observe, profile, reasoning, entity hygiene
- Entity hygiene step now generates narrative profiles for well-known entities

#### New Database Tables
- `entity_profiles` — per-entity narrative profiles
- `contradictions` — open/resolved fact conflicts
- `entity_insights` — reasoning engine output
- New columns: `source_type`, `confidence` on entity_mentions; `source_type`, `is_retracted`, `retracted_by`, `last_reinforced_at` on facts; `last_reasoned_at` on entities

### Documentation
- Comprehensive rewrite of `docs/brain.md` covering all 6 memory components
- Updated kybernesis.ai/kyberbot lander: Persistent Brain description, architecture components, Sleep Agent pipeline
- Updated kybernesis.ai/kyberbot/docs: Brain section with Fact Store, Reasoning Engine, Contradiction Tracking collapsibles

## [0.3.0] - 2026-03-13

### Initial Release
- Open-source personal AI agent powered by Claude Code
- Persistent brain: semantic search, entity graph, timeline, sleep agent
- Self-evolving identity: SOUL.md, USER.md, HEARTBEAT.md
- Heartbeat scheduler with natural language task definitions
- Telegram and WhatsApp messaging channels
- Skill auto-generation
- Sub-agent creation and delegation
- Kybernesis Cloud optional sync
- 7-step onboarding wizard
