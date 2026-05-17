/**
 * KyberBot — Heartbeat Service
 *
 * Internal interval timer that reads HEARTBEAT.md and executes
 * the most overdue task. Inspired by OpenClaw's Gateway heartbeat.
 *
 * - Default interval: 30 minutes (configurable via identity.yaml)
 * - Lane-based queuing: skips if user is actively chatting
 * - HEARTBEAT_OK suppression: silent when nothing actionable
 * - Logs to logs/heartbeat.log
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../logger.js';
import { getIdentityForRoot, getHeartbeatModelForRoot } from '../config.js';
import { getClaudeClient } from '../claude.js';
import { ServiceHandle } from '../types.js';
import { storeConversation } from '../brain/store-conversation.js';
import { getSkill } from '../skills/loader.js';

const logger = createLogger('heartbeat');

let intervalId: NodeJS.Timeout | null = null;
let running = false;
let busy = false;

// Orchestration runs on its own interval, separate from the standard heartbeat.
// This tracks when the last orchestration tick ran per agent.
const lastOrchTick = new Map<string, number>();

function parseIntervalMs(intervalStr: string): number {
  const match = intervalStr.match(/^(\d+)(m|h)$/);
  return match
    ? (match[2] === 'h' ? Number(match[1]) * 60 * 60 * 1000 : Number(match[1]) * 60 * 1000)
    : 60 * 60 * 1000;
}

/**
 * Pull the `### Task Name` + `**Schedule**: ...` (+ optional `**Window**: ...`)
 * triples out of HEARTBEAT.md. Only tasks in the `## Tasks` section are
 * returned. Schedule and window are kept as raw strings; `isTaskDue` does
 * the interpretation.
 */
interface ParsedTask { name: string; schedule: string; window?: string; precheck?: string }
function parseHeartbeatTasks(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const afterTasks = content.split(/^##\s+Tasks\b/im)[1];
  if (!afterTasks) return tasks;
  const blocks = afterTasks.split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(/^([^\n]+)/);
    const scheduleMatch = block.match(/\*\*Schedule\*\*:\s*([^\n]+)/i);
    const windowMatch = block.match(/\*\*Window\*\*:\s*([^\n]+)/i);
    // **Pre-check**: <bash> — when present, run before building the
    // Claude prompt. If the command exits 0 with `wakeAgent: false` in
    // its stdout, skip the LLM for this tick (Phase 5.4). Lets cheap
    // status-questions ("any new PRs?") not burn tokens on no-ops.
    const precheckMatch = block.match(/\*\*Pre-check\*\*:\s*([^\n]+)/i);
    if (nameMatch && scheduleMatch) {
      tasks.push({
        name: nameMatch[1].trim(),
        schedule: scheduleMatch[1].trim(),
        ...(windowMatch ? { window: windowMatch[1].trim() } : {}),
        ...(precheckMatch ? { precheck: precheckMatch[1].trim() } : {}),
      });
    }
  }
  return tasks;
}

/** Minutes-of-day (0..1439) for `d` rendered in `tz`. */
function minutesOfDayInTz(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [hStr, mStr] = fmt.format(d).split(':');
  const h = Number(hStr) % 24; // some locales emit "24" for midnight
  return h * 60 + Number(mStr);
}

/** "YYYY-MM-DD" calendar date for `d` in `tz` — for cross-day equality. */
function localDateString(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d);
}

/** Parse "HH:MM-HH:MM" into [startMin, endMin]; null if malformed. */
function parseWindow(window: string): [number, number] | null {
  const m = window.match(/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
  if (!m) return null;
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
}

/**
 * Pull the time-of-day out of `daily 9pm`, `daily 12pm`, `daily 21:00`.
 * Returns minutes-of-day, or null when no explicit time is given (plain `daily`).
 */
function parseDailyTimeOfDay(schedule: string): number | null {
  const meridiem = schedule.match(/daily\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (meridiem) {
    let h = Number(meridiem[1]);
    const m = meridiem[2] ? Number(meridiem[2]) : 0;
    const pm = meridiem[3].toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    return h * 60 + m;
  }
  const military = schedule.match(/daily\s+(\d{1,2}):(\d{2})\b/i);
  if (military) return Number(military[1]) * 60 + Number(military[2]);
  return null;
}

/**
 * Decide whether a parsed task is due given its last-check timestamp and
 * the agent's timezone. A task is due when *all* applicable constraints
 * hold:
 *   - cadence elapsed (every Nm/h/d, daily, weekly, monthly)
 *   - for `daily HHam/pm`: today's scheduled time has passed AND the task
 *     hasn't already run today after that time
 *   - if `**Window**: HH:MM-HH:MM` declared, current local time inside it
 *
 * Unknown schedule syntax is treated as "may be due" — conservative so we
 * don't silently suppress real work.
 */
/**
 * Run each due task's optional Pre-check shell command (Phase 5.4).
 * Returns `true` if at least one task wants the agent woken — either it
 * has no pre-check, OR its pre-check returns a "wakeAgent" signal that
 * isn't false. Designed to be conservative: parse errors, non-zero
 * exits, and timeouts all default to "wake" so we don't accidentally
 * silence a task.
 *
 * Each pre-check is given 10s, must not write to stderr to be trusted,
 * and is expected to print one of:
 *   wakeAgent: true | false
 *   wakeAgent=true | false
 *   {"wakeAgent": true | false}
 */
async function dueTasksWantWake(dueTasks: ParsedTask[]): Promise<boolean> {
  if (dueTasks.length === 0) return false;
  let anyWake = false;
  for (const t of dueTasks) {
    if (!t.precheck) {
      anyWake = true;
      continue;
    }
    const want = await runPrecheck(t.name, t.precheck);
    if (want) anyWake = true;
  }
  return anyWake;
}

async function runPrecheck(taskName: string, cmd: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  return new Promise<boolean>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const proc = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      logger.warn('Pre-check timed out — defaulting to wake', { task: taskName });
      resolve(true);
    }, 10_000);
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.warn('Pre-check spawn failed — defaulting to wake', { task: taskName });
      resolve(true);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        logger.debug('Pre-check non-zero exit — defaulting to wake', { task: taskName, code, stderr: stderr.slice(0, 200) });
        resolve(true);
        return;
      }
      const out = stdout.trim();
      // Match `wakeAgent: false`, `wakeAgent=false`, or JSON {"wakeAgent":false}.
      const falseMatch = /wake[A-Za-z]*\s*[:=]\s*false|\"wake[A-Za-z]*\"\s*:\s*false/i.test(out);
      const trueMatch = /wake[A-Za-z]*\s*[:=]\s*true|\"wake[A-Za-z]*\"\s*:\s*true/i.test(out);
      if (falseMatch && !trueMatch) {
        logger.debug('Pre-check declined wake', { task: taskName });
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

function isTaskDue(task: ParsedTask, lastCheckIso: string | undefined, now: Date, tz: string): boolean {
  // Window gate — applies regardless of schedule type.
  if (task.window) {
    const w = parseWindow(task.window);
    if (w) {
      const nowMin = minutesOfDayInTz(now, tz);
      if (nowMin < w[0] || nowMin > w[1]) return false;
    }
  }

  const schedule = task.schedule.toLowerCase();
  const lastCheck = lastCheckIso ? new Date(lastCheckIso) : null;
  const lastValid = lastCheck && !isNaN(lastCheck.getTime()) ? lastCheck : null;
  const elapsedMs = lastValid ? now.getTime() - lastValid.getTime() : Infinity;

  const everyMatch = schedule.match(/every\s+(\d+)\s*(m|h|d)\b/);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    const unit = everyMatch[2];
    const required = n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
    return elapsedMs >= required;
  }

  if (schedule.startsWith('daily')) {
    // Once-per-local-day cap — protects against the task re-firing on
    // every subsequent in-window tick. The picker prompt also enforces
    // this, but isTaskDue is the cheaper gate.
    if (lastValid && localDateString(lastValid, tz) === localDateString(now, tz)) {
      return false;
    }
    // Hasn't run today. When is it eligible to fire?
    //   - If a window is declared, we already passed the window check above;
    //     anywhere inside the window is fair game (the scheduled time is the
    //     target, the window is the slack).
    //   - If no window, the scheduled time-of-day is the lower bound.
    if (task.window) return true;
    const scheduledMin = parseDailyTimeOfDay(schedule);
    if (scheduledMin !== null) {
      return minutesOfDayInTz(now, tz) >= scheduledMin;
    }
    return elapsedMs >= 24 * 3_600_000;
  }

  if (schedule.startsWith('weekly')) return elapsedMs >= 7 * 24 * 3_600_000;
  if (schedule.startsWith('monthly')) return elapsedMs >= 28 * 24 * 3_600_000;

  // Unrecognized — conservative: treat as due
  return true;
}

export function markBusy(isBusy: boolean): void {
  busy = isBusy;
}

export async function startHeartbeat(root: string): Promise<ServiceHandle> {
  const identity = getIdentityForRoot(root);
  const intervalStr = identity.heartbeat_interval || '1h';
  const intervalMs = parseIntervalMs(intervalStr);
  logger.info(`Heartbeat interval: ${intervalMs / 1000 / 60} minutes`);

  running = true;

  // Initial delay before first tick
  const initialDelay = 5 * 60 * 1000; // 5 minutes
  setTimeout(() => {
    tick(root);
    intervalId = setInterval(() => tick(root), intervalMs);
  }, initialDelay);

  return {
    stop: async () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      running = false;
    },
    status: () => (running ? 'running' : 'stopped'),
  };
}

async function tick(root: string): Promise<void> {
  // Skip if user is actively chatting
  if (busy) {
    logger.debug('Skipping heartbeat — user session is active');
    return;
  }

  // Check active hours
  if (!isWithinActiveHours(root)) {
    logger.debug('Outside active hours — skipping');
    return;
  }

  // ── Orchestration heartbeat ─────────────────────────────────────
  // CEO and workers run on the orchestration interval (from settings),
  // which may differ from the standard heartbeat interval (from identity.yaml).
  try {
    const { getCeoAgent, getOrgNode, getOrchestrationSettings, listIssues } = await import('../orchestration/index.js');
    const { runCeoHeartbeat } = await import('../orchestration/ceo-heartbeat.js');
    const { runWorkerHeartbeat } = await import('../orchestration/worker-heartbeat.js');
    const settings = getOrchestrationSettings();

    if (settings.orchestration_enabled) {
      const identity = getIdentityForRoot(root);
      const agentName = identity.agent_name;

      // Check if enough time has passed since last orchestration tick for this agent
      const orchIntervalMs = parseIntervalMs(settings.heartbeat_interval || '1h');
      const lastTick = lastOrchTick.get(agentName) || 0;
      const elapsed = Date.now() - lastTick;

      if (elapsed >= orchIntervalMs) {
        lastOrchTick.set(agentName, Date.now());

        const ceo = getCeoAgent();
        if (ceo && ceo.agent_name === agentName) {
          logger.info(`Running CEO orchestration heartbeat (interval: ${settings.heartbeat_interval})`);
          await runCeoHeartbeat(root, agentName);
        } else {
          const orgNode = getOrgNode(agentName);
          if (orgNode) {
            const todoIssues = listIssues({ assigned_to: agentName, status: ['todo', 'in_progress'] });
            if (todoIssues.length > 0) {
              logger.info(`Worker ${agentName} has ${todoIssues.length} assigned issue(s), running heartbeat`);
              await runWorkerHeartbeat(root, agentName, orgNode.role, orgNode.title || agentName);
            }
          }
        }
      } else {
        logger.debug(`Orchestration tick skipped for ${agentName} — ${Math.round((orchIntervalMs - elapsed) / 1000)}s remaining`);
      }
    }
  } catch {
    // Orchestration not initialized — that's fine, skip
  }

  // ── Standard heartbeat ──────────────────────────────────────────

  // Skip if HEARTBEAT.md doesn't exist or is empty
  const heartbeatPath = join(root, 'HEARTBEAT.md');
  if (!existsSync(heartbeatPath)) {
    logger.debug('No HEARTBEAT.md found — skipping');
    return;
  }

  const content = readFileSync(heartbeatPath, 'utf-8').trim();
  if (!content || !content.includes('## Tasks')) {
    logger.debug('HEARTBEAT.md has no tasks — skipping');
    return;
  }

  // Short-circuit: if no task's Schedule is due yet, skip the Claude
  // invocation entirely. Heartbeat ticks into an empty queue used to
  // still spawn a full (Sonnet) subprocess just to reply HEARTBEAT_OK —
  // token waste for an idle fleet. Conservative: if we can't parse a
  // task's schedule, we assume it may be due so Claude still runs.
  try {
    const stateFileEarly = join(root, 'heartbeat-state.json');
    const stateEarly = existsSync(stateFileEarly)
      ? JSON.parse(readFileSync(stateFileEarly, 'utf-8'))
      : { lastChecks: {} };
    const tasks = parseHeartbeatTasks(content);
    const tz = getIdentityForRoot(root).timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dueTasks = tasks.filter((t) => isTaskDue(t, stateEarly.lastChecks?.[t.name], new Date(), tz));
    if (tasks.length > 0 && dueTasks.length === 0) {
      logger.debug(`Heartbeat skipped — no task due yet (${tasks.length} scheduled)`);
      return;
    }

    // Phase 5.4: pre-check. For every due task that declares a
    // **Pre-check**: <bash>, run it. If ALL due tasks' pre-checks
    // return `wakeAgent: false` in stdout (or `wakeAgent=false` plain),
    // skip the Claude invocation entirely — saves the subprocess for
    // "no new mail / no new PRs / nothing happened" status questions.
    // Tasks without a pre-check are always considered "wake".
    const wakeNeeded = await dueTasksWantWake(dueTasks);
    if (!wakeNeeded) {
      logger.debug('Heartbeat skipped via pre-check — no due task wants wake');
      return;
    }
  } catch (err) {
    // Parse/IO error — fall through to the Claude path; conservative
    logger.debug('Heartbeat due-check errored, proceeding to Claude', { error: String(err) });
  }

  try {
    const stateFile = join(root, 'heartbeat-state.json');
    const state = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, 'utf-8'))
      : { lastChecks: {} };

    // Extract referenced skills from tasks and inline their content
    const skillSections: string[] = [];
    const skillRefs = content.match(/\*\*Skill\*\*:\s*(\S+)/g);
    if (skillRefs) {
      for (const ref of skillRefs) {
        const skillName = ref.replace(/\*\*Skill\*\*:\s*/, '').trim();
        const skill = getSkill(skillName, root);
        if (skill) {
          try {
            const skillContent = readFileSync(join(skill.path, 'SKILL.md'), 'utf-8');
            skillSections.push(`--- Skill: ${skillName} (skills/${skillName}/SKILL.md) ---`);
            skillSections.push(skillContent);
            skillSections.push('');
          } catch {
            logger.warn(`Failed to read skill: ${skillName}`);
          }
        }
      }
    }

    const promptParts = [
      'You are executing a heartbeat task. Follow these instructions exactly:',
      '',
      '1. Read the HEARTBEAT.md tasks below and the heartbeat-state.json timestamps.',
      '2. Pick exactly one task to run this tick, in this priority order:',
      '   a. Tasks with a **Window** field whose current local time falls inside that window AND that have not yet run today after their scheduled time — these are time-anchored and their slot is perishable. Pick the one that is closest to falling out of its window.',
      '   b. Otherwise, the most-overdue interval task (every Nm/h/d) whose cadence has elapsed.',
      '   c. Never let a high-cadence interval task (e.g. every 30m) starve a daily/window-bound task that is currently inside its window — the windowed task wins.',
      '3. If a task has a **Skill** reference, the full skill instructions are included below — follow them step by step.',
      '4. If a task has no **Skill** reference, execute the **Action** directly.',
      '5. After completing the task, update heartbeat-state.json with the current time.',
      '6. If nothing needs attention, reply with exactly: HEARTBEAT_OK',
      '',
      '--- HEARTBEAT.md ---',
      content,
      '',
      '--- heartbeat-state.json ---',
      JSON.stringify(state, null, 2),
      '',
      ...(skillSections.length > 0 ? skillSections : []),
      `Current time: ${new Date().toISOString()}`,
      `Timezone: ${getIdentityForRoot(root).timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    ];

    // Fleet awareness — let heartbeat know about other agents
    try {
      const { getActiveBus } = await import('../runtime/agent-bus.js');
      const { buildFleetAwarenessSection } = await import('../runtime/agent-runtime.js');
      const bus = getActiveBus();
      if (bus) {
        const agentName = getIdentityForRoot(root).agent_name || 'KyberBot';
        const fleetSection = buildFleetAwarenessSection(bus, agentName);
        if (fleetSection) promptParts.push('', fleetSection);

        // Pending notifications from other agents
        const notifications = bus.getPendingNotifications(agentName);
        if (notifications.length > 0) {
          promptParts.push('', '## Pending Notifications from Other Agents', '');
          for (const n of notifications) {
            promptParts.push(`- **[${n.from}]** (${(n as any).topic || 'general'}): ${n.payload.slice(0, 200)}`);
          }
          promptParts.push('', 'Review these and take action if relevant.');
        }
      }
    } catch { /* not in fleet mode */ }

    // Worker orchestration context — inject assigned issues and tools
    try {
      const { getOrgNode } = await import('../orchestration/index.js');
      const { getWorkerOrchestrationContext } = await import('../orchestration/worker-heartbeat.js');
      const agentName = getIdentityForRoot(root).agent_name || 'KyberBot';
      const orgNode = getOrgNode(agentName);
      if (orgNode && !orgNode.is_ceo) {
        const orchContext = getWorkerOrchestrationContext(agentName);
        if (orchContext) promptParts.push(orchContext);
      }
    } catch { /* orchestration not initialized */ }

    const prompt = promptParts.join('\n');

    const client = getClaudeClient();
    const result = await client.complete(prompt, {
      maxTurns: 15,
      subprocess: true,
      cwd: root,
      model: getHeartbeatModelForRoot(root),
      // HEARTBEAT.md is influenced by self-edits driven by channel messages,
      // so this path is "trusted but injectable." 'broad' allows memory edits
      // and kyberbot CLI commands but blocks arbitrary Bash/Agent. If a task
      // legitimately needs other shell commands, define a skill that wraps it.
      tools: 'broad',
      system: [
        'You are a heartbeat task executor for a KyberBot agent.',
        'Tool access is restricted: Read/Write/Edit/Glob/Grep/WebFetch/WebSearch/Skill, plus `kyberbot ...` Bash commands. Arbitrary shell commands are blocked.',
        'When a task references a **Skill**, follow the skill instructions exactly as written.',
        'Execute only the single most overdue task, then stop.',
        'If nothing needs attention, reply HEARTBEAT_OK.',
      ].join(' '),
    });

    // Process orchestration tool calls from worker agents
    try {
      const { getOrgNode } = await import('../orchestration/index.js');
      const { processWorkerToolCalls } = await import('../orchestration/worker-heartbeat.js');
      const agentName = getIdentityForRoot(root).agent_name || 'KyberBot';
      const orgNode = getOrgNode(agentName);
      if (orgNode && !orgNode.is_ceo) {
        processWorkerToolCalls(result, agentName);
      }
    } catch { /* orchestration not initialized */ }

    // Suppress HEARTBEAT_OK
    if (result.trim() === 'HEARTBEAT_OK') {
      logger.debug('Heartbeat: nothing actionable');
    } else {
      logger.info('Heartbeat result:', { result: result.substring(0, 200), heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) });

      // Log to heartbeat log
      const heartbeatLog = join(root, 'logs', 'heartbeat.log');
      const logDir = dirname(heartbeatLog);
      mkdirSync(logDir, { recursive: true });
      appendFileSync(
        heartbeatLog,
        `\n--- ${new Date().toISOString()} ---\n${result}\n`,
        'utf-8'
      );

      // Fire-and-forget: store heartbeat result in memory
      storeConversation(root, {
        prompt: 'Heartbeat task execution',
        response: result,
        channel: 'heartbeat',
      }).catch((err) => logger.warn('Memory storage failed', { error: String(err) }));
    }
  } catch (error) {
    logger.error('Heartbeat tick failed', { error: String(error) });
  }
}

function isWithinActiveHours(root: string): boolean {
  try {
    const identity = getIdentityForRoot(root);
    const activeHours = identity.heartbeat_active_hours;

    if (!activeHours) return true; // No restriction

    const tz = activeHours.timezone || identity.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const timeStr = formatter.format(now);
    const [h, m] = timeStr.split(':').map(Number);
    const currentMinutes = h * 60 + m;

    const [startH, startM] = activeHours.start.split(':').map(Number);
    const startMinutes = startH * 60 + startM;

    const [endH, endM] = activeHours.end.split(':').map(Number);
    const endMinutes = endH * 60 + endM;

    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  } catch {
    return true; // Default to allowing
  }
}
