# Architecture

This document describes KyberBot's system architecture, component relationships, data flow, and file structure.

---

## Three-Mode Architecture

KyberBot operates in three modes depending on how it interacts with Claude:

### Agent SDK Mode (Recommended)

Uses `@anthropic-ai/claude-code` programmatically. This is the default and recommended mode for Claude Code subscription users.

- No API keys to manage
- No per-token costs beyond the Claude Code subscription
- Full access to Claude Code features: tool_use, MCP servers, file access, sub-agents, skills, git
- The heartbeat scheduler and channels use this mode for background operations

```
Heartbeat/Channel ─▶ @anthropic-ai/claude-code query() ─▶ KyberBot agent
```

### SDK Mode

Direct Anthropic API calls via `@anthropic-ai/sdk`. For users who prefer direct API access or need programmatic control.

- Requires `ANTHROPIC_API_KEY` in `.env`
- Standard API token costs apply
- No Claude Code features (MCP, sub-agents, skills) -- just raw completions

```
Brain AI ops ─▶ @anthropic-ai/sdk ─▶ Anthropic API ─▶ response
```

### Subprocess Mode (Fallback)

Spawns `claude -p` as a child process. Used as a fallback if the Agent SDK fails to load.

- Same capabilities as Agent SDK mode (Claude Code features available)
- Higher overhead per invocation (process spawn)
- Automatic fallback -- no configuration needed

```
Heartbeat/Channel ─▶ spawn claude -p "..." ─▶ KyberBot agent
```

All three modes use the same brain, skills, and living documents. The mode is determined at startup based on configuration in `identity.yaml` and available dependencies.

---

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Interfaces                          │
│                                                                  │
│  ┌──────────┐    ┌───────────┐    ┌────────────┐               │
│  │ Terminal  │    │ Telegram  │    │  WhatsApp  │               │
│  │ (claude)  │    │   Bot     │    │  Bridge    │               │
│  └─────┬─────┘    └─────┬─────┘    └─────┬──────┘               │
│        │                │                │                       │
│        └────────────────┼────────────────┘                       │
│                         │                                        │
│                    ┌────▼────┐                                   │
│                    │ KyberBot│                                   │
│                    │  Server │                                   │
│                    └────┬────┘                                   │
├─────────────────────────┼───────────────────────────────────────┤
│                    Core Services                                 │
│                         │                                        │
│  ┌──────────┐    ┌─────▼──────┐                                │
│  │Heartbeat │    │  Claude    │                                │
│  │Scheduler │───▶│  Runtime   │                                │
│  └──────────┘    │ (Agent SDK │                                │
│                  │  / SDK /   │                                │
│                  │ Subprocess)│                                │
│                  └─────┬──────┘                                  │
│                        │                                         │
├────────────────────────┼────────────────────────────────────────┤
│                   Agent Context                                  │
│                        │                                         │
│  ┌─────────┐    ┌─────▼──────┐    ┌────────────┐               │
│  │ SOUL.md │    │  CLAUDE.md │    │ HEARTBEAT  │               │
│  │         │    │ (operating │    │    .md      │               │
│  │         │    │  system)   │    │            │               │
│  └─────────┘    └────────────┘    └────────────┘               │
│  ┌─────────┐    ┌────────────┐                                  │
│  │ USER.md │    │  skills/   │                                  │
│  │         │    │            │                                  │
│  └─────────┘    └────────────┘                                  │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                        Brain                                     │
│                                                                  │
│  ┌────────────┐  ┌────────────────┐  ┌─────────────┐            │
│  │  Semantic  │  │  Structured DB │  │   brain/    │            │
│  │  Search    │  │                │  │ (markdown)  │            │
│  │            │  │ Entity Graph   │  │             │            │
│  │  vectors,  │  │ Timeline       │  │  knowledge  │            │
│  │  metadata  │  │ Sleep State    │  │  documents  │            │
│  └────────────┘  └────────────────┘  └─────────────┘            │
│                                                                  │
│  ┌────────────────────────────────────────────┐                 │
│  │              Sleep Agent                    │                 │
│  │  decay ▶ tag ▶ link ▶ tier ▶ summarize ▶  │                 │
│  │  entity hygiene                             │                 │
│  └────────────────────────────────────────────┘                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Service Startup Order

When you run `kyberbot`, services start in this order:

```
1. Configuration Loading
   └─ Read identity.yaml, .env, CLAUDE.md

2. Memory services (Docker)
   └─ Start container, wait for health check

3. Memory databases
   └─ Open/create entity-graph.db, timeline.db, sleep.db

4. Sleep Agent
   └─ Begin background maintenance cycle

5. Heartbeat Scheduler
   └─ Parse HEARTBEAT.md, calculate next run times
   └─ Start timer loop

6. Channels
   └─ Start Telegram bot (if configured)
   └─ Start WhatsApp bridge (if configured)

7. HTTP Server
   └─ Listen for webhooks and channel messages

8. Ready
   └─ Display splash screen and service status
```

If a non-critical service fails to start (e.g., Telegram token is invalid), KyberBot continues with the remaining services and reports the error.

---

## Data Flow

### Conversation Flow

```
User types in terminal
       │
       ▼
Claude Code loads CLAUDE.md
       │
       ▼
CLAUDE.md instructs Claude to read SOUL.md, USER.md
       │
       ▼
Agent processes message with full context
       │
       ├──▶ Searches brain (semantic search + structured queries)
       ├──▶ Queries entity graph
       ├──▶ Checks timeline
       ├──▶ Loads relevant skills
       │
       ▼
Agent generates response
       │
       ├──▶ Stores new memories via semantic search
       ├──▶ Updates entity graph
       ├──▶ Logs to timeline
       ├──▶ Updates USER.md / SOUL.md (if new info)
       │
       ▼
Response displayed to user
```

### Heartbeat Flow

```
Heartbeat scheduler checks HEARTBEAT.md
       │
       ▼
Task is due (based on cadence + heartbeat-state.json)
       │
       ▼
Invoke Claude via Agent SDK (default):
  query({ prompt: "[task instructions]", ... })
       │
       ▼
Agent executes task with full context
       │
       ▼
Results stored in brain / displayed in channel
       │
       ▼
heartbeat-state.json updated (lastRun, nextRun)
```

### Channel Message Flow

```
Message arrives (Telegram webhook / WhatsApp event)
       │
       ▼
Server authenticates sender
       │
       ▼
Message queued for processing
       │
       ▼
Invoke Claude via Agent SDK with message as input
       │
       ▼
Agent processes with full context
       │
       ▼
Response sent back through originating channel
       │
       ▼
Conversation stored in brain + timeline
```

### Sleep Agent Flow

```
Sleep cycle triggered (interval or manual)
       │
       ├──▶ 1. Decay: Reduce priority of stale memories
       ├──▶ 2. Tag: AI-refresh tags on outdated memories
       ├──▶ 3. Link: Discover edges between related memories
       ├──▶ 4. Tier: Move memories between hot/warm/archive
       ├──▶ 5. Summarize: Regenerate summaries for tier changes
       └──▶ 6. Entity Hygiene: Merge duplicates, clean orphans
       │
       ▼
Sleep state updated in data/sleep.db
       │
       ▼
Next cycle scheduled
```

---

## File Structure

```
my-agent/                          # Your KyberBot project
├── CLAUDE.md                      # Claude Code operating instructions
├── SOUL.md                        # Agent personality (living document)
├── USER.md                        # User knowledge (living document)
├── HEARTBEAT.md                   # Recurring tasks (living document)
├── identity.yaml                  # Agent identity config
├── .env                           # Secrets and configuration
├── heartbeat-state.json           # Heartbeat scheduler state
│
├── brain/                         # Markdown knowledge files
│   ├── projects/                  # Project-specific knowledge
│   ├── people/                    # People profiles
│   └── ...                        # User-defined structure
│
├── skills/                        # Skill files
│   └── my-skill/                  # Each skill is a directory
│       └── SKILL.md               # Skill definition
│
├── data/                          # Runtime data (gitignored)
│   ├── chromadb/                  # Semantic search persistent storage
│   ├── entity-graph.db            # Entity graph database
│   ├── timeline.db                # Timeline database
│   ├── sleep.db                   # Sleep agent state database
│   └── whatsapp-session/          # WhatsApp auth (if configured)
│
├── .claude/                       # Claude Code configuration
│   ├── CLAUDE.md                  # Auto-generated operating instructions
│   ├── settings.local.json        # Permissions and settings
│   └── agents/                    # Sub-agent definitions
│
├── logs/                          # Application logs
│   ├── heartbeat.log
│   ├── sleep.log
│   └── channels.log
│
├── .gitignore                     # Excludes data/, .env, logs/
└── package.json                   # Node.js dependencies
```

### What Is Git-Tracked

| Tracked | Not Tracked |
|---------|-------------|
| SOUL.md | data/ (runtime databases) |
| USER.md | .env (secrets) |
| HEARTBEAT.md | logs/ (application logs) |
| identity.yaml | heartbeat-state.json (scheduler state) |
| brain/ | node_modules/ |
| skills/ | |
| .claude/ | |

This means your agent's identity, knowledge, and skills are version-controlled, while runtime data, scheduler state, and secrets are not.

---

## Updating

KyberBot provides a built-in update mechanism via `kyberbot update`. The command handles both halves of an update:

1. **CLI source update** -- Resolves the source repo via `__dirname` (works because `npm link` creates a symlink), runs `git pull origin main`, then `npm install && npm run build` from the monorepo root.

2. **Template refresh** -- Copies the latest infrastructure files from the template directory into the current agent instance. Backs up `.claude/CLAUDE.md` first, replaces placeholders, rebuilds the skill registry, and stamps the `kyberbot_version` in `identity.yaml`.

**Protected files** (never modified by update): `SOUL.md`, `USER.md`, `HEARTBEAT.md`, `brain/`, `skills/`, `data/`, `.env`, `heartbeat-state.json`.

**Refreshed files**: `.claude/CLAUDE.md`, `.claude/settings.local.json`, `.claude/commands/kyberbot.md`, `.claude/skills/skill-generator.md`, `.claude/skills/templates/skill-template.md`, `docker-compose.yml`.

---

## Key Design Decisions

### Why Claude Code as Runtime

KyberBot deliberately builds on Claude Code rather than building a custom agent framework. This gives us:

- **Sub-agents**: Claude Code can spawn specialized agents for parallel tasks
- **MCP servers**: Connect to any MCP-compatible service
- **File system access**: Read/write any file with permission controls
- **Git integration**: Native git operations
- **Skill system**: Claude Code's built-in skill loading
- **Permission system**: Granular control over what the agent can do
- **Tool use**: Bash, read, write, search -- all built in

### Why Agent SDK as Default

The Agent SDK (`@anthropic-ai/claude-code`) is the recommended mode because it:

- Works with an existing Claude Code subscription at no extra cost
- Provides full tool_use, MCP, and file access in programmatic contexts
- Avoids the overhead of spawning a subprocess for each invocation
- Falls back to subprocess mode automatically if the SDK is not available

### Why Markdown for Everything

Living documents, skills, and knowledge files are all markdown. This makes them:

- Human-readable and editable
- Version-controllable with git
- Easy to diff and review
- Loadable as Claude Code context
- Searchable with standard tools

### Why Two Storage Layers

- **Semantic search** excels at finding memories by meaning ("find memories about pricing")
- **Structured queries** excel at traversing relationships and time ("who is John connected to?", "what happened on Tuesday?")
- Together they cover the full spectrum of memory access patterns

### Why Local-First

All data lives on your machine. This fork ships local-only — no cloud sync. This ensures:

- Privacy by default
- No dependency on external services
- Full ownership of your agent's data
- Works offline
