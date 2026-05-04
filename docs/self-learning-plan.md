# Self-Learning Agent — Comprehensive Implementation Plan

Last updated: 2026-05-04
Branch: `feat/self-learning` off `develop`
Status: pre-build

## 0. Goal

Give Alfred a feedback loop that turns daily conversations into proposed
self-improvements. Tier 1 captures and annotates outcomes; Tier 2 turns
those outcomes into a queue of approve/reject/revertable proposals against
Alfred's own files.

### Success criteria

| Metric | Target |
|---|---|
| Per-reply telemetry capture | 100% of channel turns log latency, tokens, tools, model |
| Outcome annotation accuracy (heuristics) | ≥70% on labeled sample |
| Daily proposal generation | runs at 09:00 SGT, completes in <30s |
| Proposal apply latency (CLI / Telegram approve) | <2s including git commit |
| Proposal revert | always works via `kyberbot proposals revert <id>` (git tag fallback) |
| First-day usefulness | At least one actionable proposal generated within day 1 of operation |

## 1. Locked decisions (from Q&A)

| # | Decision | Choice |
|---|---|---|
| Q1 | Self-review cadence | **Daily**, min ≥2 evidence threshold to filter flukes |
| Q2 | Outcome detection | **Heuristics only** (regex + similarity); LLM upgrade is a v2 |
| Q3 | Notification surface | **Telegram only** (count + top 3 highlighted) |
| Q4 | Approval surface | **Telegram (`approve N` / `reject N`) + CLI (`kyberbot proposals ...`)** |
| Q5 | Storage | **Flat markdown files** in `brain/proposals/`, auto-archive after 90d |
| Q6 | Rate limit | **No cap** — user rejection rate is the feedback signal |
| Q7 | Edit scope | **Maximum** — anything in `~/agents/<agent>/` except hard-never list |
| Q8 | First-run mode | **Full power day 1** — default ≥2 threshold, observe what Alfred actually does |

**Hard-never list (regardless of scope):** `.env`, `data/`, `.git/`, `node_modules/`. Enforced at apply-time even if Alfred drafts a proposal targeting one.

## 2. Verified assumptions about existing infrastructure

Before designing, verify what's already there to reuse:

| # | Assumption | Verified by |
|---|---|---|
| V1 | `storeConversation()` already writes every channel reply to timeline.db, entity-graph.db, chromadb | `brain/store-conversation.ts` |
| V2 | Sleep agent already has a step framework (decay, tag, link, tier, summarize, entity-hygiene, reasoning) we can extend | `brain/sleep/steps/` |
| V3 | Heartbeat task framework supports schedule + window + skill reference | `services/heartbeat.ts` + HEARTBEAT.md format |
| V4 | Stream-json `result` event from claude includes `usage.input_tokens`, `usage.output_tokens`, `total_cost_usd`, `duration_ms`, `num_turns` | observed in pool tests |
| V5 | Channel handlers already capture `tool_use` events when stream-json is enabled | `claude.ts` + chat-sse.ts |
| V6 | Alfred dir is now a git repo (`samwhx/alfred`) with auto-commit support via existing `kyberbot backup` command | done 2026-05-03 |
| V7 | Telegram channel can send arbitrary text via `ctx.reply` and intercept text patterns before Claude (verified by existing `/start` handler) | `channels/telegram.ts` |

Things to verify during build (low risk if wrong):

- **V-tools-capture**: stream-json events flow through warm-pool's parser AND one-shot subprocess parser identically. Pool already does; need to confirm one-shot path emits the same.
- **V-similarity**: hybrid-search's semantic similarity scoring (already in `brain/hybrid-search.ts`) can be reused for "user re-asked the same question" detection without spawning a separate process.

## 3. Architecture

### 3.1 Components

```
                                    ┌──────────────────────────────────────┐
                                    │ Channel handlers (telegram/wa/web)   │
                                    │ ─ already store conversation         │
                                    │ + extend: persist metrics_json with   │  ← Tier 1 capture
                                    │   latency_ms, tools_used, tokens,    │
                                    │   cost, model, reply_length          │
                                    └────────────┬─────────────────────────┘
                                                 │ writes via
                                                 ▼
                                    ┌──────────────────────────────────────┐
                                    │ store-conversation.ts (existing)     │
                                    │ + new: telemetry sink                │
                                    └────────────┬─────────────────────────┘
                                                 │ data lives in
                                                 ▼
                                    ┌──────────────────────────────────────┐
                                    │ timeline.db.timeline_events          │
                                    │ + new column: metrics_json TEXT      │
                                    └────────────┬─────────────────────────┘
                                                 │ read by
                                                 ▼
        ┌────────────────────────────────────────────────────────────────┐
        │ Sleep agent step: outcome-annotator (NEW)                      │   ← Tier 1 outcomes
        │ ─ reads recent conversations + their next-message reactions    │
        │ ─ heuristics: regex (thanks/correction) + similarity (re-ask)  │
        │ ─ writes outcome + confidence + evidence_text onto each reply  │
        │ ─ runs hourly (existing sleep cadence)                         │
        └────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
        ┌────────────────────────────────────────────────────────────────┐
        │ Heartbeat task: self-review (NEW, daily)                       │   ← Tier 2 proposals
        │ ─ aggregates last 24h of metrics + outcomes                    │
        │ ─ runs `pattern-finder` skill: identifies actionable patterns  │
        │ ─ for each pattern with ≥2 evidence: drafts a proposal         │
        │ ─ writes brain/proposals/YYYY-MM-DD-<slug>-<id>.md             │
        │ ─ if any pending: posts Telegram ping                          │
        └────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
        ┌────────────────────────────────────────────────────────────────┐
        │ Approval surface (CLI + Telegram intercept)                    │   ← Apply
        │ ─ kyberbot proposals list/show/approve/reject/revert           │
        │ ─ Telegram pre-Claude intercept: "approve N" / "reject N"      │
        │ ─ apply via Write/Edit + auto git-commit + tag proposal/<id>   │
        │ ─ revert via git revert + tag                                  │
        │ ─ guardrail: refuses to apply if target_path matches           │
        │   hard-never list                                              │
        └────────────────────────────────────────────────────────────────┘
```

### 3.2 Data model

**Reply telemetry** (extends existing `timeline_events` table):

```sql
ALTER TABLE timeline_events ADD COLUMN metrics_json TEXT;
ALTER TABLE timeline_events ADD COLUMN outcome TEXT;          -- thanks/correction/reask/ignored/neutral/null
ALTER TABLE timeline_events ADD COLUMN outcome_confidence REAL;
ALTER TABLE timeline_events ADD COLUMN outcome_evidence TEXT; -- snippet of next message that triggered classification
ALTER TABLE timeline_events ADD COLUMN outcome_annotated_at TEXT;
```

`metrics_json` shape (per channel reply event):
```json
{
  "channel": "telegram",
  "latency_ms": 7234,
  "model": "sonnet",
  "input_tokens": 8421,
  "output_tokens": 312,
  "cost_usd": 0.045,
  "tools_used": ["Read", "Bash(kyberbot:recall)"],
  "reply_length_chars": 412,
  "received_at": "2026-05-04T10:23:11.234Z",
  "replied_at": "2026-05-04T10:23:18.468Z"
}
```

Heartbeat tasks and skill invocations get parallel metrics (different shapes, same column).

**Proposal markdown file** (`brain/proposals/2026-05-04-tone-tweak-a3f.md`):

```markdown
---
id: a3f-tone-tweak
created: 2026-05-04T09:00:00Z
status: pending           # pending | approved | applied | rejected | reverted
type: personality_tweak   # personality_tweak | skill_revision | heartbeat_change | identity_update | brain_note | other
target_path: SOUL.md
priority: 0.78            # 0..1, higher = more confident this is worth doing
evidence_event_ids:
  - 9381
  - 9402
  - 9415
applied_at: null
applied_commit: null
reverted_at: null
---

# Proposal: Tighten reply tone in SOUL.md

## Why
- 3 corrections in last 24h ("shorter please", "too verbose", "tldr")
- Median reply length up to 412 chars, was 220 last week
- All 3 corrections cite the same paragraph

## Proposed change

```diff
--- a/SOUL.md
+++ b/SOUL.md
@@ paragraph: communication style
- I am direct and warm. No filler. No emojis unless asked.
- Proactive — I will flag things before you ask. Concise — respect your time.
+ I am terse and direct. Reply in one or two sentences unless detail is asked for.
+ No filler, no emojis. Proactive — I flag things before you ask.
```

## Risk
- low — affects all replies but reversible via git tag `proposal/a3f-tone-tweak`
- might cause initial confusion if existing conversation contexts expect the older voice
```

### 3.3 Proposal lifecycle

```
   draft       review            apply            (optionally) revert
                                                  ───────────────────────►
[pending] ──► (user runs            ──► [applied]            ──► [reverted]
                kyberbot proposals       (git commit + tag)        (git revert
                approve N                                            + tag)
                or "approve N"
                via Telegram)

                ──► [rejected] (user runs reject N)

                ──► (90 days in any non-pending status: archived)
```

### 3.4 Heuristic outcome detection rules

| Outcome | Trigger (next user message within 30 min) | Confidence floor |
|---|---|---|
| `thanks` | regex: `^(thanks|thank you|perfect|great|nice|ok|good|got it)\b` | 0.7 |
| `correction` | regex: `^(no|not|wrong|actually|that's wrong|incorrect)\b` | 0.7 |
| `reask` | semantic similarity to prior question ≥ 0.85 (via existing hybrid-search embedding) | 0.6 |
| `ignored` | no follow-up within 6 hours, prior reply was substantive (≥50 chars) | 0.4 |
| `neutral` | follow-up exists but no signal matches | 0.3 |

If multiple triggers match, take the highest-confidence. Confidence < 0.5 → `outcome: null` (don't poison the proposal feed). Annotation runs hourly via the sleep agent so even back-to-back messages get correctly classified once enough time has passed for the next message to arrive.

### 3.5 Pattern finder (the hard part of Tier 2)

The self-review heartbeat task, given a window of annotated replies, looks for patterns that warrant proposals. Each pattern type has a detector:

| Pattern | Detector |
|---|---|
| **Repeated correction in same topic** | Cluster corrections by entity overlap (timeline_events.entities_json) → if ≥2 corrections cite same entity, propose related skill/persona edit |
| **Verbose-reply complaint** | corrections containing "shorter", "tldr", "verbose" + median reply length trending up → propose SOUL.md tone tweak |
| **Skill failure** | Skill invocation with non-zero exit code or empty output, ≥2x in 24h → propose skill revision |
| **Skill always succeeds, never used by output** | Skill ran ≥10x, but no entities/topics from its output appear in subsequent user messages → propose retiring/lowering cadence |
| **Heartbeat output ignored** | Heartbeat task ran, no `outcome=thanks` follow-up, output not referenced in next 24h → propose retire/lower cadence |
| **Cost outlier** | Single reply cost > 10x median this week → propose model downgrade for that channel/topic |
| **Latency outlier** | Sustained latency > p95 for >24h → flag for human review (not auto-proposed; this is usually infra) |

Each detector returns: `{ pattern_id, evidence_event_ids[], confidence, proposal_draft }`.
Drafter is a small LLM call (Haiku) to phrase the proposal markdown. Total daily cost: <$0.05.

### 3.6 Telegram approval intercept

In `channels/telegram.ts`, BEFORE the Claude path:

```ts
if (chatId === this.ownerChatId) {
  const m = text.trim().match(/^(approve|reject)\s+([a-z0-9-]+(?:\s*,?\s*[a-z0-9-]+)*)\s*$/i);
  if (m && hasPendingProposalsMatching(m[2])) {
    const action = m[1].toLowerCase() as 'approve' | 'reject';
    const ids = m[2].split(/[\s,]+/).filter(Boolean);
    const result = await applyProposals(action, ids);
    await ctx.reply(formatApplyResult(result));
    return;  // skip Claude
  }
}
```

The strict prefix + "must match a pending proposal" guard means accidental "approve the cruise idea" prose won't trigger anything (those words are not pending IDs).

## 4. File-by-file changes

| File | Action | Why |
|---|---|---|
| `packages/cli/src/types.ts` | Add `SelfLearningConfig` to `IdentityConfig` | Per-agent feature toggles |
| `packages/cli/src/brain/store-conversation.ts` | Capture per-reply metrics into `metrics_json` | Tier 1 telemetry |
| `packages/cli/src/brain/timeline.ts` | Add 4 columns + getters/setters for outcome | Tier 1 outcome storage |
| `packages/cli/src/brain/sleep/steps/outcome-annotator.ts` | NEW | Tier 1 outcome classification |
| `packages/cli/src/brain/sleep/index.ts` | Register new step in cycle | Wire annotator into sleep |
| `packages/cli/src/services/self-review.ts` | NEW — pattern detectors + proposal drafter | Tier 2 core |
| `packages/cli/src/services/proposals.ts` | NEW — load/save/apply/revert proposal files | Tier 2 file ops |
| `packages/cli/src/commands/proposals.ts` | NEW — CLI subcommands | Tier 2 surface |
| `packages/cli/src/server/channels/telegram.ts` | Add owner-only approve/reject intercept | Tier 2 surface |
| `packages/cli/src/server/channels/whatsapp.ts` | Same intercept (parallel implementation) | Tier 2 surface |
| `template/skills/self-review/SKILL.md` | NEW — installable skill that runs the heartbeat task | Tier 2 ergonomics |
| `template/HEARTBEAT.md` | New default task: daily self-review at 09:00 | Tier 2 wiring |
| `packages/cli/src/index.ts` | Register `proposals` command | CLI surface |
| `packages/cli/src/server/channels/__tests__/...` | Update channel tests for the new intercept | Test |
| `packages/cli/src/services/__tests__/self-review.test.ts` | NEW — pattern detector unit tests | Test |
| `packages/cli/src/services/__tests__/proposals.test.ts` | NEW — apply/revert/lifecycle tests | Test |

Estimated lines:
- New code: ~1500 lines (proposals service + self-review + CLI + outcome annotator + tests)
- Modified: ~300 lines (channel intercepts, store-conversation telemetry, timeline migration)

## 5. Failure modes & handling

| Failure | Detection | Action |
|---|---|---|
| Outcome heuristic misclassifies | Manual spot-check, or rejected-proposal rate > 80% | Confidence threshold knob in identity.yaml; can set higher to filter |
| Proposal targets a hard-never path | Apply-time path check | Refuse, log error, mark proposal `rejected_blocked` |
| YAML proposal applies but breaks parse | Post-apply schema validation | Auto-revert via git tag, mark proposal `reverted_auto`, alert via Telegram |
| Skill proposal applies but breaks the skill | Skill rebuild fails on next run | Auto-revert via git tag, alert |
| Pattern finder hangs / OOMs on large window | 60s timeout in heartbeat task | Heartbeat task kills the process; logs warning; tries smaller window next day |
| Telegram intercept misfires on conversational text | Strict regex + pending-id match | Won't trigger unless the text matches `(approve|reject) <pending-id>` exactly |
| Proposal ID collision (two drafts same hour) | UUIDs in IDs | Vanishingly rare; collision detector is `if file exists, regenerate id` |
| User approves N proposals in one Telegram message | Comma-separated ID list parser | Parses, applies sequentially, returns summary |
| User wants to undo applied proposal | `kyberbot proposals revert <id>` | git revert the tagged commit, mark proposal `reverted` |
| Heartbeat self-review fires while previous one still running | task lock file | Skip + log; next cycle picks up |
| Dirty git working tree at apply time | `git status` check before apply | Refuse apply, instruct user to commit/stash first |

## 6. Verification plan

### 6.1 Unit tests

- **Outcome annotator**: 20+ test cases covering each heuristic class, ambiguous cases, multi-class messages, empty messages, foreign-language input.
- **Pattern detectors**: each detector has a fixture-based test ("given these 5 timeline events, does the detector emit a proposal?").
- **Proposals service**: lifecycle test (draft → apply → revert), guardrail test (hard-never list refusal), git tag test, archive test (>90d move).
- **Telegram approval intercept**: strict-match test, partial-match rejection, normal-conversation passthrough, multiple-id parsing.

### 6.2 Integration

- **End-to-end smoke**: seed timeline.db with 30 fixture conversations + outcomes, run heartbeat self-review, verify N proposal files generated, apply 1, revert 1, archive 1 expired.
- **Live observation**: Alfred runs for 24 hours with feature flag on. Verify the morning-after Telegram ping content. Inspect each proposal's evidence and reasoning.

### 6.3 Performance budget

- Outcome annotator: <500ms per 10 conversations.
- Pattern finder + drafter: <30s end-to-end for a 24h window with 100 events.
- Apply: <2s including git commit and tag.
- Revert: <2s including git revert and tag.

## 7. Rollout

### 7.1 Feature flag

`identity.yaml: self_learning.enabled: true|false` (default false). Also `KYBERBOT_SELF_LEARNING=1` env override for quick toggle.

When disabled:
- No new sleep step runs
- No heartbeat self-review task fires
- CLI commands still exist but say "self-learning is disabled"
- Telegram intercept does nothing (returns false → falls through to Claude)

### 7.2 Phased enable

1. **Day 0**: ship the code with flag default off. Push branch + PR.
2. **Day 0 evening**: I enable it for Alfred only (`identity.yaml`). 24-hour observation period.
3. **Day 1 morning**: review the first generated proposals. Tune heuristic thresholds based on what we see.
4. **Week 1**: keep tuning. Track precision (% approved of proposals) and recall (any patterns I notice that Alfred missed).
5. **Week 2+**: stable. Document the v1 → v2 upgrade path (LLM-based outcome detection).

### 7.3 Rollback

- Disable flag → behavior reverts to current (no telemetry capture, no proposals).
- Existing data (`metrics_json`, outcome columns) stays in DB but is unused.
- All applied proposals are reversible via `kyberbot proposals revert <id>` regardless of flag state.

## 8. Out of scope (do NOT do in this PR)

- LLM-based outcome detection (v2; current heuristics give us baseline data first)
- Web UI for proposals (CLI + Telegram is enough)
- Multi-agent learning (Alfred only; if you spawn other agents they'd each have their own loop)
- Auto-merge approved proposals to a remote repo (you push manually if you want to sync alfred-state to GitHub)
- A/B testing prompt templates (interesting but adds complexity; defer to Tier 3)

## 9. Open questions to resolve at build time

1. **Where do tool-use events come from?** Stream-json captures them when used. The one-shot subprocess path may need a small parser update if it doesn't already extract them. Verify in day 1.
2. **Confidence calibration**: The heuristic confidences in §3.4 are guesses. Tune after 1 week of observation against rejected vs approved proposals.
3. **Migration**: existing timeline.db has no metrics_json. Do we backfill? My default: no — start tracking forward. Old conversations are baselines for "what was Alfred like before self-learning".
4. **What if Telegram intercept matches an approve while there are no pending proposals?** Treat as normal conversation (passes through to Claude). Edge case but worth a test.

## 10. Estimated effort

| Day | Work |
|---|---|
| 1 | Telemetry capture in store-conversation.ts; timeline schema migration; verify per-reply data lands |
| 2 | Outcome annotator (sleep step) + heuristics + tests; backfill not done, just forward |
| 3 | Proposals service (file load/save) + CLI commands + tests; git tag/apply/revert |
| 4 | Self-review heartbeat task + pattern detectors + drafter + tests |
| 5 | Telegram approval intercept; WhatsApp parallel; channel tests |
| 6 | E2E smoke; tune defaults; ship behind flag, enable for Alfred |

Realistic with buffer: ~6 working days. Spillover days for tuning the first week of live observation.

## 11. Critical files (for navigation)

- `packages/cli/src/brain/store-conversation.ts` — telemetry capture site
- `packages/cli/src/brain/sleep/steps/outcome-annotator.ts` — outcome classification
- `packages/cli/src/services/self-review.ts` — pattern detectors + drafter (this is the brain of Tier 2)
- `packages/cli/src/services/proposals.ts` — file format + apply/revert with hard-never guardrail
- `packages/cli/src/commands/proposals.ts` — CLI subcommands
- `packages/cli/src/server/channels/telegram.ts` — approval intercept (similar in whatsapp.ts)
- `template/skills/self-review/SKILL.md` — defines the skill that the heartbeat task fires
