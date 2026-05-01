# Getting Started

This guide walks you through installing KyberBot, running the onboard wizard, and having your first conversation with your personal AI agent.

---

## Prerequisites

Before installing KyberBot, make sure you have:

### Required

- **Node.js 18+** -- [Download](https://nodejs.org/)
- **Docker** -- Required for memory services. [Install Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Claude Code subscription** -- KyberBot runs on top of Claude Code. You need an active subscription. [Get Claude Code](https://docs.anthropic.com/en/docs/claude-code)

### Optional

- **Telegram account** -- If you want to message your agent via Telegram
- **WhatsApp** -- If you want to message your agent via WhatsApp

### Verify Prerequisites

```bash
node --version    # Should be 18.0.0 or higher
docker --version  # Should show Docker version
claude --version  # Should show Claude Code version
```

---

## Installation

### 1. Install KyberBot

This installs the `kyberbot` command on your machine. You only do this once.

```bash
git clone https://github.com/KybernesisAI/kyberbot.git
cd kyberbot
npm install
npm run build
cd packages/cli && npm link && cd ../..
```

Think of this like installing an app. The `kyberbot/` folder is the app itself -- you don't work inside it.

After this, the `kyberbot` command works from anywhere on your system.

### 2. Create Your Agent

Create a new folder anywhere on your machine and run `kyberbot onboard` inside it:

```bash
mkdir ~/my-agent
cd ~/my-agent
kyberbot onboard
```

**This folder is your agent.** Everything it knows, everything it learns, its entire personality and memory -- all lives here.

The onboard wizard asks you a few questions and sets up everything:

- `identity.yaml` -- Agent name, timezone, settings
- `SOUL.md` -- Agent personality (how it communicates)
- `USER.md` -- What the agent knows about you
- `HEARTBEAT.md` -- Recurring tasks it should run on a schedule
- `.claude/CLAUDE.md` -- Claude Code instructions (auto-generated)
- `.env` -- API keys and secrets
- `brain/` -- Long-term knowledge files
- `skills/` -- Agent capabilities
- `data/` -- Memory databases (created on first use)

The onboard wizard walks you through 7 steps:

#### Step 1: Agent Identity

Choose a name and description for your agent, and decide how to set up its personality (SOUL.md). You can use a guided template, write from scratch later, or skip and let the agent develop its personality over time.

```
What should your AI agent be called?
> Atlas

One-line description of your agent:
> My personal AI agent

How would you like to define its personality? (SOUL.md)
> Guided template (recommended)
```

#### Step 2: About You

Tell your agent about yourself. Name, timezone, location, and anything else you want it to know. This populates `USER.md`.

```
Your name:
> Alex

Timezone (detected: America/New_York):
> America/New_York

Location (optional):
> New York

Tell your agent something about yourself (optional):
> I'm a software engineer working on fintech products.
```

#### Step 3: Claude Code

Choose how KyberBot connects to Claude for background operations (heartbeats, channels). Agent SDK is recommended for subscription users -- it works with your existing Claude Code subscription at no extra cost. Alternatively, provide an Anthropic API key for direct SDK access.

```
How would you like to connect to Claude?
> Agent SDK (recommended) -- works with your Claude Code subscription
```

#### Step 4: Initializing Brain

The wizard creates directories (`data/`, `logs/`, `brain/`, `skills/`), copies template files into `.claude/`, writes `identity.yaml`, `SOUL.md`, `USER.md`, `HEARTBEAT.md`, and sets up the Docker Compose file for memory services.

```
  + data/
  + logs/
  + brain/
  + skills/
  + .claude/ (CLAUDE.md, settings, commands, skills)
  + identity.yaml
  + SOUL.md
  + USER.md
  + HEARTBEAT.md
  + docker-compose.yml
```

#### Step 5: Cloud Sync / Kybernesis (Optional)

Optionally connect to Kybernesis for cloud-backed workspace memory. This only requires an API key -- no other configuration. Your Kybernesis Local and Cloud are independent stores that complement each other.

```
Enable cloud memory sync via Kybernesis? (optional)
> No
```

If you choose yes, you will be prompted for your Kybernesis API key. You can also add it later by putting `KYBERNESIS_API_KEY=...` in `.env`.

#### Step 6: Messaging Channels (Optional)

Connect Telegram and/or WhatsApp so you can message your agent from your phone. You can skip this and set it up later.

```
Connect messaging channels? (Telegram / WhatsApp)
> No
```

#### Step 7: Summary

The wizard shows what was created and how to start using your agent.

```
 + identity.yaml    -- Agent configuration
 + SOUL.md          -- Agent personality
 + USER.md          -- What the agent knows about you
 + HEARTBEAT.md     -- Recurring task schedule
 + .claude/CLAUDE.md -- Claude Code instructions

 Atlas is alive.

 To start all services:
   kyberbot

 To start talking:
   cd ~/my-agent && claude
```

---

## First-Run Experience

When you first open Claude Code in your agent folder (`cd ~/my-agent && claude`), the agent will warmly introduce itself and ask to learn about you. This is normal -- it is reading its SOUL.md and USER.md for the first time and wants to fill in the gaps. Share as much or as little as you like. Everything you tell it gets stored in its brain for future sessions.

---

## Updating KyberBot

When a new version of KyberBot is released, you need to update the CLI source code **and** refresh template files inside your agent instance. The `update` command handles both:

```bash
cd ~/my-agent
kyberbot update
```

This runs the full update flow:

1. **Fetches** the latest changes from the KyberBot source repo
2. **Shows** new commits (changelog)
3. **Pulls** and **rebuilds** the CLI
4. **Backs up** `.claude/CLAUDE.md` to `.claude/CLAUDE.md.bak`
5. **Refreshes** template/infrastructure files (`.claude/CLAUDE.md`, settings, commands, skill generator, docker-compose)
6. **Rebuilds** the CLAUDE.md skill registry (preserves installed skills)
7. **Stamps** the `kyberbot_version` in `identity.yaml`

### What's Refreshed vs What's Preserved

**Never touched** (your data is safe):
- `SOUL.md`, `USER.md`, `HEARTBEAT.md`
- `brain/`, `skills/`, `data/`, `logs/`
- `.env`, `identity.yaml` (only `kyberbot_version` field is updated)
- `heartbeat-state.json`

**Refreshed** (infrastructure files):
- `.claude/CLAUDE.md` (backed up first)
- `.claude/settings.local.json`
- `.claude/commands/kyberbot.md`
- `.claude/skills/skill-generator.md`
- `.claude/skills/templates/skill-template.md`
- `docker-compose.yml`

### Update Options

```bash
kyberbot update              # Full update: CLI source + agent templates
kyberbot update --check      # Preview what would change, don't modify anything
kyberbot update --templates  # Only refresh template files (skip CLI source update)
```

Use `--check` to see what's available before committing to an update. Use `--templates` if you've already pulled and rebuilt the CLI manually and just need to refresh your agent's files.

---

## Starting Services

```bash
kyberbot
```

This starts the KyberBot runtime:

1. **Memory** -- Starts Docker services for search
2. **Server** -- Express REST API for brain endpoints
3. **Heartbeat Scheduler** -- Watches `HEARTBEAT.md` for recurring tasks
4. **Sleep Agent** -- Begins background memory maintenance
5. **Channels** -- Starts any configured messaging bridges (Telegram, WhatsApp)

You will see a splash screen showing your agent's name and the status of each service.

---

## Your First Conversation

With services running, open a **new terminal**, go to your agent's folder, and start Claude Code:

```bash
cd ~/my-agent
claude
```

Claude Code loads `CLAUDE.md`, which instructs it to behave as your KyberBot agent. Try these:

```
> Hey Atlas, what do you know about me?

> Remember that my product launch deadline is June 15th.

> What's on my schedule today?

> Create a skill for tracking my running mileage.
```

The agent will:

- Read `USER.md` to recall what it knows about you
- Store new information to memory
- Execute heartbeat tasks on schedule
- Generate new skills when it encounters unfamiliar tasks

---

## Service Commands

```bash
# Start all services
kyberbot

# Start without specific services
kyberbot --no-sleep        # Disable sleep agent
kyberbot --no-channels     # Disable messaging channels
kyberbot --no-heartbeat    # Disable heartbeat scheduler

# Other commands
kyberbot status                     # Show service status
kyberbot onboard                    # Re-run onboard wizard
kyberbot brain search "query"       # Search memories
kyberbot recall                     # List tracked entities
kyberbot recall "John"              # Query entity graph
kyberbot timeline                   # Show recent timeline
kyberbot timeline --today           # Today's events
kyberbot skill list                 # List installed skills
kyberbot skill create my-skill      # Create a new skill
kyberbot skill info my-skill        # Show skill details
kyberbot update                     # Update CLI and refresh templates
kyberbot update --check             # Preview available updates
kyberbot update --templates         # Refresh templates only
```

---

## Next Steps

- [Self-Evolution](self-evolution.md) -- Understand how your agent evolves over time
- [Living Documents](living-documents.md) -- SOUL.md, USER.md, HEARTBEAT.md reference
- [Brain](brain.md) -- How the memory system works
- [Skills](skills.md) -- Create and manage agent skills
- [Channels](channels.md) -- Set up Telegram and WhatsApp
