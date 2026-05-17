---
name: calendar
description: "Read the user's Google Calendar. Use for briefings ('what's on today/this week'), to check availability ('am I free tomorrow at 3'), or to surface upcoming meetings when relevant. Requires OAuth setup via `kyberbot gmail auth` — the same Google token covers Gmail and Calendar."
allowed-tools: Bash(kyberbot calendar *)
version: 1.0.0
---

# Calendar

Reads the user's primary Google Calendar. Read-only in v1 — creating / modifying events is a Phase 5 proposal-based flow, not a direct skill action.

## When to Fire

- **Briefings**: morning/afternoon/evening briefings should call `kyberbot calendar today --json` so the agent surfaces real events instead of saying "no bookings today."
- **Schedule queries**: "what's on tomorrow", "am I free at 3", "when's my next meeting", "anything Friday".
- **Conflict checks**: before suggesting a meeting time, check the user's calendar.

## Configuration

Shared with the Gmail skill — see `skills/gmail/SKILL.md` for the one-time OAuth dance. If `kyberbot calendar status` shows "not authorised", ask the user to run `kyberbot gmail auth` (and reuse the token it stores).

## Workflow

### Today

```bash
kyberbot calendar today --json
```

Returns events occurring on the local calendar date, in chronological order. Each event has `{ id, summary, start, end, location, attendees, description }`.

### Week ahead

```bash
kyberbot calendar week --json
```

Same shape, next 7 days. Use this for the morning briefing's "this week" preview.

### In briefings

In `skills/proactive-briefing/SKILL.md`, prefix the existing memory-query step with:

```bash
kyberbot calendar today --json
kyberbot gmail recent --days 7 --json
```

Then synthesise alongside memory results. Concrete is better than abstract — "10am dentist (calendar), unread mail from Janet about the budget thread" beats "no events today."

## Hard rules

- Read-only. Don't invent calendar mutation commands; if the user wants to create or move an event, surface that as a Phase 5 calendar_action proposal instead.
- Times are surfaced in the user's local timezone (per identity.yaml). Don't translate to UTC in user-facing strings.
- If the OAuth token is missing/expired and can't refresh, the CLI returns a clear error. Surface it; don't pretend.
