---
name: focus
description: "Synthesise everything the agent knows about the user's day (calendar, mail, pinned entities, pending proposals + drafts, upcoming heartbeat tasks, recent timeline patterns) and surface what should actually be done. Three outputs: top focus (1-5 priorities), urgent (deadline within ~2h), valuable now (time-sensitive opportunities). Use when the user asks 'what should I focus on?' / 'what's important?' / 'what's on?', when a morning briefing is fired, or whenever the agent needs decision-support context. Reads from cache; re-runs LLM at most every 30 minutes."
allowed-tools: Bash(kyberbot focus *), Bash(kyberbot focus)
version: 1.0.0
---

# Focus Synthesis

The synthesis engine pulls every signal the agent has — calendar, mail, pinned entities, pending proposals, drafts, heartbeat tasks, recent activity — and asks Claude to surface what genuinely matters right now. Three buckets:

- **Top focus** — 1-5 things to do today, ordered by what matters most
- **Urgent** — items with a deadline within ~2 hours or already slipping
- **Valuable now** — opportunity windows where action now creates disproportionate value

The synthesis caches for 30 minutes by default; consecutive calls return the cached result. `--refresh` forces a fresh run.

## When to Fire

**Fire automatically:**
- User asks any of: "what should I focus on", "what's important", "what's on", "what's the plan", "what matters today", "where should I start"
- Morning briefing task — the Daily Focus Brief heartbeat task should call this
- Proactive nudge task — runs every 30m and surfaces urgent / valuable items

**Don't fire:**
- For routine acknowledgements ("ok", "thanks", "got it")
- When the user is in the middle of a focused task and asks for unrelated help
- If a fresh synthesis already ran this cycle and the user hasn't asked for it explicitly

## Output Format

```bash
kyberbot focus --json
```

Returns:

```json
{
  "topFocus": [
    {
      "id": "reply-janet-budget",
      "title": "Reply to Janet about Q2 budget thread",
      "rationale": "She replied 14h ago and her thread velocity suggests she's still actively waiting.",
      "source": "mail",
      "urgency": "today",
      "value": "high",
      "action": "Open the thread, draft a 2-sentence response acknowledging the new numbers",
      "related_ids": ["gmail-thread-abc123"]
    }
  ],
  "urgent": [...],
  "valuable": [...],
  "generatedAt": "2026-05-18T07:30:00Z",
  "signalsUsed": { "calendar": 4, "mail": 12, ... },
  "inputHash": "...",
  "cached": false
}
```

For terminal display (pretty-printed):

```bash
kyberbot focus
```

## Surfacing in a briefing

When fired from a morning briefing or `notify` context, format the synthesis as a tight WhatsApp/Telegram message:

```
Morning — May 18

→ TOP
• Reply to Janet about Q2 budget thread (14h waiting, high value)
• Run Hermes vs openclaw eval (deadline Thu, doing now buys 2-day buffer)

→ URGENT
• 10am dentist appointment (Holland Village)

→ VALUABLE NOW
• (none today)
```

- Keep total length under 400 characters
- If a bucket is empty, omit the heading entirely
- Suppress the message entirely if all three buckets are empty (silence is correct)

## Caching

- Default 30-minute TTL
- Cache is keyed by agent root
- Pass `--refresh` to force a fresh synthesis (LLM call ~$0.02 with Sonnet)
- The per-turn decision-support enrichment reads cache-only and never triggers a synthesis itself — so if you've never called `kyberbot focus`, the agent has no enrichment context

## Hard Rules

- Treat each list as ordered — first item is highest priority
- Don't pad. If only one thing matters, return one item.
- Empty arrays are valid output. Don't invent priorities to fill space.
- `urgent` requires a real deadline. "Soon" doesn't count.
- `valuable` is about timing windows, not just importance.
