# Alfred → Jarvis: Multi-Year Architecture Plan

> Approved 2026-05-17. Executed across feat/phase-* branches, one per phase, merged into develop as each phase verifies.

## Context

Alfred (deployed at `~/agents/alfred`) is the kyberbot-based personal Jarvis agent. This plan defines a 9-week sequence that makes the system multi-year durable, efficient at scale, resistant to vendor/model trends, and progressively closer to a real Jarvis (voice, calendar/mail reach, autonomous-with-approval action).

After a deep audit, the foundation is more capable than first appeared (self-learning, fleet, orchestration, skills, ARP, 11-step sleep agent, hot/warm/archive tiering, RRF hybrid search). The real risks are *structural*, not feature gaps:

1. **No schema versioning anywhere.** Every SQLite store creates its tables with `CREATE TABLE IF NOT EXISTS`, then bolts columns on by runtime PRAGMA introspection (`brain/entity-graph.ts:172-248`, `brain/timeline.ts:222-288`). Deployed agents like Alfred have no migration path. This is the #1 blocker for multi-year durability.
2. **No real cold storage.** Archive tier is a flag, not separate storage (`brain/sleep/steps/tier.ts:54-97`). After 2 years of timeline events all queries still touch the same files.
3. **Embedder is hardcoded to OpenAI** (`brain/embeddings.ts:10`). Locks the system to a cloud vendor for every memory write.
4. **Conversation history dies on restart** (`server/channels/conversation-history.ts:27`) — confirmed gap.
5. **Relations are free-form strings, not categorised.** `entity_relations.relationship` is unstructured. There's no way to ask "give me all *causal* predecessors of X" — there's no causal category, just whatever string the LLM happened to write.
6. **No centralized HTTP client.** Every integration brings its own SDK (`claude.ts:218`, `embeddings.ts:104`, `chromadb.ts:142`). Future vendor swaps mean touching 25+ call sites.
7. **brain/notes/ not auto-indexed** unless wired through `watched_folders`. Synthesized knowledge has no formal home.

The plan addresses these structural risks first, then layers the Jarvis features (voice, wiki, calendar/gmail, autonomous action) on top of a foundation that won't rot.

**Mnemon as a separate system is explicitly out of scope.** We considered using it as a mirror or primary memory store; concluded that running two memory systems creates more operational complexity than its portability earns for this single-user deployment. The best ideas from mnemon — particularly its four structured edge types (temporal, entity, causal, semantic) — get ported into kyberbot's existing schema as a small migration in Phase 1.5.

---

## Design Principles

The rules the plan obeys at every step. Future-you re-reading this in 18 months should still recognise them.

1. **Plain text is the source of truth.** SOUL.md, USER.md, HEARTBEAT.md, `brain/notes/`, `brain/wiki/`, `identity.yaml` — these are canonical. SQLite is the index. ChromaDB is the index. If both burn down tomorrow, the agent's identity and knowledge are recoverable from markdown. This is the portability layer that doesn't need a second database.
2. **Every SQLite store has `PRAGMA user_version` and an idempotent migration ladder.** No more "CREATE TABLE IF NOT EXISTS then ALTER COLUMN if missing."
3. **Vendors hide behind thin adapters.** Embedder, LLM, channel transport, scheduler — each has one boundary file, one interface. Swapping a vendor changes one file.
4. **Tiers earn their cost.** Hot stays in primary stores. Warm in primary but with smaller indices. Cold is *physically separate files*, queried only on explicit request. Archival is real, not a flag.
5. **Features are skills, channels, or proposal types.** Don't grow the core. Anything new gets implemented inside the existing extension surfaces (`packages/cli/src/skills/`, `packages/cli/src/server/channels/`, `packages/cli/src/services/proposals.ts`).
6. **Self-learning and sleep maintenance stay running.** They are the immune system. Never break them in a refactor; always test them after.
7. **Borrow good ideas from other systems, don't import their code.** Mnemon's causal-edge category, NanoClaw's pre-check pattern, anyone's wiki-synthesis idea — port the design into kyberbot's existing surface area rather than running a second system in parallel.

---

## Branching Strategy

- One feature branch per phase: `feat/phase-0-bedrock`, `feat/phase-1-memory-scale`, `feat/phase-2-voice-in`, etc.
- Each phase is independently reviewable and revertable
- Merge into `develop` when phase verification passes
- `main` follows `develop` on tagged release boundaries

---

## Phase 0 — Durability Bedrock *(week 1)*

**Goal:** Make the system migratable, observable, and restart-tolerant. No new features. This phase pays for the next year.

### 0.1 Schema versioning for all SQLite stores

Files to modify:
- `packages/cli/src/brain/entity-graph.ts` (after line 119)
- `packages/cli/src/brain/timeline.ts` (after line 134)
- `packages/cli/src/brain/sleep/db.ts` (line 49 area)
- `packages/cli/src/brain/messages.ts`

Pattern (new helper file: `packages/cli/src/brain/db-migrate.ts`):

```ts
export interface Migration { version: number; up: (db: Db) => void; description: string; }
export function applyMigrations(db: Db, name: string, migrations: Migration[]): void {
  const current = db.exec("PRAGMA user_version")[0]?.values[0][0] as number ?? 0;
  for (const m of migrations) {
    if (m.version > current) {
      db.exec("BEGIN");
      try { m.up(db); db.exec(`PRAGMA user_version = ${m.version}`); db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw new Error(`Migration ${name} v${m.version} failed: ${e}`); }
    }
  }
}
```

Each store keeps its migration list inline. Existing "introspect and ADD COLUMN" logic in `entity-graph.ts:172-248` and `timeline.ts:222-288` becomes migrations v1, v2, v3 with explicit version numbers. New columns go in as v_N migrations going forward — including the structured edge types in Phase 1.5.

### 0.2 `kyberbot agent migrate` command

New: `packages/cli/src/commands/migrate.ts`. Calls each store's `applyMigrations`. Reports what ran. Idempotent. Run automatically by `commands/run.ts` at startup (before any DB use).

### 0.3 Conversation history hydration from disk

The in-memory `histories` Map in `server/channels/conversation-history.ts:27` becomes a write-through cache backed by `messages.db`. On boot, hydrate from the last `MAX_AGE_MS` of messages.db rows.

Files:
- `packages/cli/src/server/channels/conversation-history.ts` — hydrate on import, write through on push.
- `packages/cli/src/brain/messages.ts` — add `getRecentMessagesByConversation(convoId, sinceMs)`.

Result: Alfred restart no longer cold-starts conversations.

### 0.4 Centralized HTTP client

New: `packages/cli/src/utils/http.ts`. Thin wrapper around fetch with: retries (3, exponential backoff), timeout, structured logging (`createLogger('http')`), optional `X-Request-Id`. All future outbound calls (Gmail, Calendar, Ollama, webhook integrations) go through this. Existing Anthropic/OpenAI/ChromaDB SDKs stay as-is — they're already encapsulated.

### 0.5 Management API test coverage

`packages/cli/src/server/management-api.ts` (999 LOC, untested) gets a `management-api.test.ts` covering at least the endpoints we just added (`/notify`, `/channels/send`) and the high-traffic ones (`/heartbeat`, `/channels`, `/proposals`).

**Phase 0 verification:** Run `kyberbot agent migrate` on Alfred — reports "0 migrations applied" the second time. Restart Alfred mid-conversation — the next message Claude sees still includes the prior exchanges. `pnpm test` passes for management-api.

---

## Phase 1 — Memory at Scale *(weeks 2–4)*

**Goal:** Make memory growth a non-issue for the next five years, and make the relation graph reason-able.

### 1.1 Pluggable embedder

`packages/cli/src/brain/embeddings.ts` currently hardcodes `text-embedding-3-small` (line 10). Refactor to an `Embedder` interface:

```ts
interface Embedder { name: string; dim: number; embed(texts: string[]): Promise<number[][]>; }
```

Adapters:
- `OpenAIEmbedder` (current behaviour, default initially)
- `OllamaEmbedder` (POST to `http://localhost:11434/api/embeddings`, model from `identity.yaml`)

Selected via `identity.yaml.brain.embedder: openai | ollama` with `openai` default initially. Switching it migrates the ChromaDB collection on next boot (recompute embeddings on demand, not eagerly).

### 1.2 Real cold storage

New module: `packages/cli/src/brain/cold-storage.ts`. New sleep step: `sleep/steps/archive.ts` (runs weekly, after entity-hygiene).

Mechanism:
- Cold rows = tier `archive` AND `last_accessed > 90 days ago` AND not pinned
- Archive step copies rows to `data/cold/YYYY-MM.db` (one file per month), then deletes from primary
- `hybrid-search.ts` gains an `includeCold: boolean` option (default false)
- Restoration: `kyberbot brain restore <id>` pulls a row back to primary

Effect: primary `timeline.db` stops growing past ~last 18 months of warm+hot. FTS index stays fast.

### 1.3 Sleep-agent streaming

Convert decay/link/summarize/observe steps from `LIMIT batchSize*2` to cursor pattern: `SELECT … WHERE id > :last_id LIMIT 500`, loop until exhausted, checkpoint `last_id` to `sleep_telemetry`. Never holds more than 500 rows in memory.

### 1.4 Fact purging

Add a purge pass in `sleep/steps/decay.ts:141-152`: facts below `min_confidence_threshold` (default 0.15) AND `last_verified > 180 days ago` AND not referenced by any pinned entity → delete. Audit row in `sleep_telemetry`.

### 1.5 Structured edge types — ported from mnemon's design

The relation graph today (`entity_relations.relationship`, free-form string like `works_at`, `co-occurred`, `founded`) is expressive but ungroupable. Mnemon's four-edge-type taxonomy (temporal / entity / causal / semantic) solves that — adopt the idea without taking on a second database.

Schema change as a new migration in `entity-graph.ts`:

```sql
-- migration v_N
ALTER TABLE entity_relations ADD COLUMN edge_type TEXT
  CHECK (edge_type IN ('temporal','entity','causal','semantic'));
CREATE INDEX idx_relations_edge_type ON entity_relations(edge_type, source_id);
```

Backfill: existing rows default to `entity`. Sleep agent's `link.ts` extension classifies new relations:

- `works_at`, `founded`, `consulted_for`, `member_of` → `entity`
- `caused`, `triggered`, `led_to`, `prevented`, `delayed` → `causal`
- `before`, `after`, `during`, `superseded_by` → `temporal`
- `similar_to`, `analogous_to`, `cluster_member` → `semantic`

Both fields stay populated. Queries can use either:

```sql
-- Specific relationship
SELECT * FROM entity_relations WHERE relationship='consulting' AND source_id=?;
-- Causal chains
SELECT * FROM entity_relations WHERE edge_type='causal' AND target_id=?;
```

**Why this matters for Jarvis:** Alfred can now reason about decision chains. "We cancelled the cruise because the weather window closed because the typhoon shifted" becomes a single graph walk along causal edges.

`hybrid-search.ts` gains an optional `edgeType` filter.

### 1.6 ChromaDB scale strategy

Soft path: configure HNSW on the Chroma collection. Hard path (later): swap to local pgvector via Postgres. For 1-year horizon, the soft path is enough.

**Phase 1 verification:** Seed timeline with 50k synthetic events. Confirm query latency stays sub-300ms (warm path). Run archive sleep step, primary file shrinks, cold-aware search still returns archived rows when `--include-cold`. Switch embedder to Ollama; next conversation embeds locally. After a sleep cycle following the 1.5 migration, every row in `entity_relations` has a populated `edge_type`.

---

## Phase 2 — Multimodal Foundation *(week 5)*

**Goal:** Voice in. The single biggest "feels like Jarvis" upgrade.

### 2.1 Extend ChannelMessage with attachments

`packages/cli/src/server/channels/types.ts:7-14`:

```ts
interface Attachment { kind: 'audio' | 'image' | 'document'; mime: string; bytes: Buffer; filename?: string; transcript?: string; }
interface ChannelMessage { /* existing */; attachments?: Attachment[]; }
```

### 2.2 Whisper.cpp wrapper

New: `packages/cli/src/services/transcribe.ts`. Spawns `whisper` binary. Cached on `data/transcripts/<sha>.txt`.

### 2.3 WhatsApp + Telegram channel wiring

`whatsapp.ts:184`: detect `audioMessage`, download via Baileys, transcribe, attach. Same for Telegram (`reply_to_message.voice` and direct voice messages).

Inject transcript before `<user_message>`: `<attachment kind="audio" filename="..."><transcript>...</transcript></attachment>`.

### 2.4 Onboarding

`packages/cli/src/commands/onboard.ts` adds: "Voice input requires whisper.cpp. Install via `brew install whisper-cpp`?"

**Phase 2 verification:** Send a voice note to Alfred via WhatsApp. Logs show whisper transcription. Reply is contextual to the voice content.

---

## Phase 3 — Wiki Synthesis Layer *(week 6)*

**Goal:** Brain produces human-readable, human-correctable knowledge pages.

### 3.1 New tree

```
brain/wiki/
  entities/<slug>.md
  projects/<slug>.md
  timelines/<period>.md
  index.md
```

### 3.2 New sleep step: `synthesize-wiki.ts`

Runs after `summarize`. For each entity with `mention_count >= 5` or pinned, generate/refresh `brain/wiki/entities/<slug>.md` with:

- Frontmatter: entity id, type, last_synthesized, source_event_ids
- Body: LLM-synthesised narrative from mentions, facts, related entities, causal chains
- Markers `<!-- alfred:autogen:start -->` and `<!-- alfred:autogen:end -->` so human edits outside them are preserved

### 3.3 Wiki ingestion back into brain

Point existing `watched-folders` (5-min scan) at `brain/wiki/`. Human edits get re-ingested into the timeline.

### 3.4 Obsidian compatibility

Wiki files use `[[wikilink]]` syntax. Frontmatter is YAML. Existing `backup` command already covers `brain/`.

**Phase 3 verification:** After sleep cycle, `brain/wiki/entities/samuel.md` exists, reads coherently. Edit a section outside the autogen markers; run sleep again; edit persists. Open the folder in Obsidian.

---

## Phase 4 — Cross-App Reach *(weeks 7–8)*

**Goal:** Alfred knows what's actually in your day.

### 4.1 OAuth framework

New: `packages/cli/src/services/oauth.ts`. Stores tokens encrypted at `data/oauth/<provider>.json`. Refresh-token loop.

### 4.2 Gmail skill

`template/skills/gmail/SKILL.md` + `kyberbot gmail` CLI subcommand:
- Read recent threads (last 7 days, with summary)
- Draft a reply (writes to `brain/drafts/`)
- Send a draft (requires approval)

### 4.3 Calendar skill

`template/skills/calendar/SKILL.md`. Read events for today + next 7 days.

### 4.4 Surface in briefings

Existing `skills/proactive-briefing/SKILL.md` Step 1 gets two new bash calls before the existing memory queries: `kyberbot gmail recent --json` and `kyberbot calendar today --json`.

**Phase 4 verification:** Morning briefing on a real Tuesday says "10am dentist, unread mail from Janet about the budget thread." Drafting a reply produces a markdown draft.

---

## Phase 5 — Autonomous Action with Approval *(week 9)*

**Goal:** Alfred graduates from "tells you" to "drafts for you, asks once."

### 5.1 Extend proposal types

`packages/cli/src/services/proposals.ts:47-53` is already a string enum. Add: `email_draft`, `calendar_action`, `file_edit`, `external_send`. Each has its own apply handler (registry pattern).

### 5.2 Apply handlers

New: `packages/cli/src/services/proposal-handlers/`:
- `email-draft.ts` — applies = sends via gmail OAuth
- `calendar-action.ts` — applies = creates/updates event
- `file-edit.ts` — applies = writes file with diff confirmation

Each handler validates against a hard-never list.

### 5.3 Web UI approval

`packages/cli/src/server/web-api.ts` gains `GET /proposals` and `POST /proposals/:id/approve|reject`. WhatsApp approval still works.

### 5.4 Pre-check for heartbeat

`packages/cli/src/services/heartbeat.ts:279`: optional `**Pre-check**: <bash>` field in HEARTBEAT.md task. If pre-check returns `wakeAgent: false`, skip the Claude prompt.

**Phase 5 verification:** Alfred drafts an email reply (`email_draft` proposal). WhatsApp ping arrives. `approve <id>` sends. Pre-check on event-proximity task short-circuits when no playbook exists.

---

## Phase 6 — Continuous Maintenance *(ongoing)*

### 6.1 Self-learning (already shipped)

Telemetry → outcome annotation → proposals → review. After Phase 1.5, outcomes can be linked causally to triggers.

### 6.2 Sleep agent (already shipped, plus Phase 1/3 additions)

11 steps growing to 13: archive (1.2), synthesize-wiki (3.2). Link step enhanced for `edge_type`. Runs hourly.

### 6.3 Backup (already shipped)

`kyberbot backup run` every 4h. Monthly cold-storage backup (`kyberbot backup cold`).

### 6.4 Basic metrics

`packages/cli/src/metrics.ts` — in-process histogram for channel latency, Claude latency, sleep step duration, memory size. Exposed at `GET /api/web/manage/metrics`.

---

## Out of Scope

- **Mnemon as a second database.** Idea ported in 1.5; full system not adopted. Revisit only with a concrete cross-runtime use case.
- **Upstream Delamain factory.** Their CI system; unrelated to a personal agent.
- **Containers per group (NanoClaw-style).** Single-owner deployment.
- **Local foundation models for the agent itself.** Cloud Sonnet/Opus is still ahead. Local embeddings (1.1) is enough local-first for now.
- **Distributed/multi-host deployment.** Single Mac mini is the spec.
- **Real-time voice (call-style).** Voice notes are async; sync voice is a separate project.

---

## Critical Files Index

| File | Why it matters |
|---|---|
| `packages/cli/src/brain/entity-graph.ts:121-248` | Schema + migration target (Phase 0.1, 1.5) |
| `packages/cli/src/brain/timeline.ts:135-288` | Schema + migration target (Phase 0.1) |
| `packages/cli/src/brain/sleep/db.ts:49-106` | Schema + migration target (Phase 0.1) |
| `packages/cli/src/brain/sleep/index.ts:96-190` | Sleep step orchestration (Phase 1.2, 1.3, 1.5, 3.2) |
| `packages/cli/src/brain/sleep/steps/link.ts` | Edge classification (Phase 1.5) |
| `packages/cli/src/brain/embeddings.ts:10-115` | Embedder swap target (Phase 1.1) |
| `packages/cli/src/brain/hybrid-search.ts` | Cold-aware search + edge_type filter (Phase 1.2, 1.5) |
| `packages/cli/src/server/channels/types.ts:7-39` | Attachment surface (Phase 2.1) |
| `packages/cli/src/server/channels/whatsapp.ts:184-228` | Voice ingestion (Phase 2.3) |
| `packages/cli/src/server/channels/telegram.ts:77-100` | Voice ingestion (Phase 2.3) |
| `packages/cli/src/server/channels/conversation-history.ts:27` | History persistence (Phase 0.3) |
| `packages/cli/src/services/proposals.ts:47-53, 245+` | Proposal types + handlers (Phase 5.1) |
| `packages/cli/src/services/heartbeat.ts:279` | Pre-check insertion (Phase 5.4) |
| `packages/cli/src/services/watched-folders.ts:20` | Wiki ingestion reuse (Phase 3.3) |
| `packages/cli/src/server/web-api.ts:19` | Approval endpoint (Phase 5.3) |
| `packages/cli/src/commands/run.ts:214-236` | Channel registration (Phase 2.3) |

---

## Sequencing & Effort

| Week | Phase | Branch | Outcome |
|---|---|---|---|
| 1 | Phase 0 — bedrock | `feat/phase-0-bedrock` | Migrations, history hydration, HTTP client, mgmt-api tests |
| 2 | Phase 1.1–1.2 | `feat/phase-1-memory-scale` | Pluggable embedder, cold storage |
| 3 | Phase 1.3–1.4 | (same branch) | Sleep streaming, fact purge |
| 4 | Phase 1.5–1.6 | (same branch) | Structured edge types + ChromaDB HNSW |
| 5 | Phase 2 — voice | `feat/phase-2-voice-in` | Whisper.cpp on WhatsApp/Telegram |
| 6 | Phase 3 — wiki | `feat/phase-3-wiki-layer` | brain/wiki/ synthesised + Obsidian-compatible |
| 7–8 | Phase 4 — reach | `feat/phase-4-cross-app` | Gmail + Calendar + OAuth |
| 9 | Phase 5 — agency | `feat/phase-5-agency` | Action proposals + web approval + pre-check |
| 10+ | Phase 6 — ongoing | continuous | Metrics + maintenance |

---

## End-to-End Verification

A single Saturday morning to confirm the whole thing works:

1. Mumble a voice note to Alfred on WhatsApp ("what's on today?")
2. Reply mentions: today's calendar events (Phase 4), unread mail summary (Phase 4), what you discussed yesterday (Phase 0.3 — restart-survived history), upcoming heartbeat tasks
3. Reply is sent via WhatsApp (notify shim — already shipped)
4. Sleep agent runs in background: archives March 2025 events to `data/cold/2025-03.db`, refreshes `brain/wiki/entities/samuel.md`, populates causal edges
5. Ask Alfred "why did we cancel the cruise?" — answer traces causal edges from `cancelled_cruise` back to `weather_window` back to `typhoon_shift`
6. Open the wiki in Obsidian on phone, edit a fact in `janet.md` outside the autogen block, watched folder ingests, next briefing reflects the change
7. Ask Alfred to draft a reply to Janet — proposal arrives, approve via WhatsApp, sent via Gmail
8. `kyberbot agent migrate` reports 0 pending; `kyberbot brain status` shows tier counts, edge-type distribution, last-sleep-run

If all eight work, the foundation is real, multi-year-durable, and Alfred is closer to Jarvis than to a Telegram bot — built on one memory system, not two.
