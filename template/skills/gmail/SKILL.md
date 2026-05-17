---
name: gmail
description: "Read recent Gmail threads, draft replies for human approval, and send approved drafts. Use when the user asks about email, wants to triage their inbox, or asks the agent to reply to someone. Requires OAuth setup — run `kyberbot gmail auth` once before this skill works."
allowed-tools: Bash(kyberbot gmail *), Read, Write, Edit
version: 1.0.0
---

# Gmail

This skill lets the agent read the user's Gmail and draft replies for human approval. Sending requires an explicit second step — either the user runs `kyberbot gmail send <draft-id>` or approves a proposal via `approve <draft-id>` on a messaging channel.

## When to Fire

- **Reading**: user asks "what's in my inbox", "any email from X", "did Janet reply yet", or the morning briefing wants to surface unread threads.
- **Drafting**: user says "draft a reply to X saying Y", "send X a quick reply", "what should I say back to X".
- **Sending**: user explicitly says "send it", "yes do it", "approved" with a draft id in context. Never auto-send.

## Configuration (one-time)

The user must:

1. Run `kyberbot gmail auth` — prints setup instructions and the OAuth consent URL.
2. Create a Google Cloud project, enable Gmail + Calendar APIs, generate Desktop OAuth credentials.
3. Save `client_id` and `client_secret` to `.kyberbot/google-credentials.json`:

   ```json
   { "client_id": "...", "client_secret": "..." }
   ```

4. Visit the consent URL, copy the code, run `kyberbot gmail auth-finish <code>`.

If `kyberbot gmail status` shows "credentials.json: missing" or "oauth token: not authorised", stop and ask the user to complete setup.

## Workflow

### Reading recent threads

```bash
kyberbot gmail recent --days 7 --json
```

Returns an array of thread summaries: `{ id, subject, snippet, from, unread, timestamp }`. Use `unread: true` to filter to fresh items in briefings.

### Drafting a reply

```bash
kyberbot gmail draft <thread-id> "Hi Janet, ..."
```

Creates a markdown file at `brain/drafts/gmail-<short-id>.md` with frontmatter (`thread_id`, `subject`, `status: pending`) and the body. Tell the user the draft id and where it lives.

### Sending a draft

Only after the user has explicitly approved:

```bash
kyberbot gmail send <draft-id>
```

This calls Gmail's `messages.send` API, flips the draft's `status` to `sent`, and stamps `sent_at`. Idempotent — re-sending a draft that's already sent is refused.

## Hard rules

- Never auto-send. Sending requires a separate, explicit user command.
- Never include passwords, MFA codes, or secrets in draft body — the model should refuse and ask the user to send those manually.
- If the OAuth token is missing or expired and can't refresh, the CLI command will return a clear error. Surface that error to the user; don't pretend the action succeeded.
