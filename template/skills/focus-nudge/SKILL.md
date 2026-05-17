---
name: focus-nudge
description: "Heartbeat-callable wrapper around `kyberbot focus nudge`. Re-runs focus synthesis with cache-busting, dedupes against ids surfaced in the past week, and pings the user via kyberbot notify when a NEW urgent or valuable item appears. Fire whenever the heartbeat schedules the urgent/between-briefing check."
allowed-tools: Bash(kyberbot focus nudge), Bash(kyberbot focus nudge *), Read
version: 1.0.0
---

# Focus Nudge

The deterministic "tap-on-the-shoulder" mechanism. Fires every 30 min during active hours; pings the user only when the focus engine identifies a genuinely new urgent or valuable-now item that hasn't been nudged about in the last week.

## When to Fire

- Heartbeat task "Urgent Between-Briefing Check" (or equivalent)
- Manually when the user asks "is anything urgent I should know?"

## Implementation

This skill is intentionally thin. The heavy lifting lives in the `kyberbot focus nudge` command. Just call it and report:

```bash
kyberbot focus nudge --json
```

The command returns:

```json
{
  "fired": true|false,
  "reason": "...",
  "surfaced": [ FocusItem... ],
  "body": "..."   // the actual notification body (when fired)
}
```

Behaviour:
- `fired: true` → the user has already received a WhatsApp/Telegram notification. Don't re-send. Just write a brain note recording the action.
- `fired: false` with `reason: "within min-interval (...)"` → still in the cooldown window since the last nudge. Silence.
- `fired: false` with `reason: "no new urgent/valuable items"` → focus synthesis ran, found nothing actionable that we haven't already surfaced. Silence.
- `fired: false` with `reason: "synthesis failed: ..."` → the LLM call errored. Log to brain notes; do NOT retry inline.

## Hard Rules

- Never call `kyberbot notify` directly from this skill. The nudge command handles delivery + dedup; bypassing it would double-ping.
- Never run the synthesis a second time within this skill. The command is the single point of synthesis.
- Don't write a brain-notes entry when `fired: false` and `reason` is cooldown or no-news — that would spam `brain/notes/` with empty rows every 30 min.

## Tuning

If pings feel too frequent / too sparse, adjust the heartbeat task's Action field to pass:

- `--interval-mins N` (default 30) — minimum gap between nudges
- `--max-items N` (default 3) — max items per notification body
