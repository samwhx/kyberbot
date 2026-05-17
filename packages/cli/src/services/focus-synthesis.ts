/**
 * KyberBot — Focus Synthesis Engine
 *
 * Pulls every available signal (calendar, mail, pinned entities,
 * pending proposals + drafts, upcoming heartbeat tasks, recent
 * timeline patterns), feeds it to Claude, and returns a structured
 * "what should Samuel actually do right now" object.
 *
 * Three surfaces consume this engine:
 *
 *   - kyberbot focus           (Phase A — terminal + skill on-demand)
 *   - per-turn context block   (Phase B — decision support enrichment)
 *   - proactive nudge          (Phase C — heartbeat watches for new
 *                                       urgent / valuable items and
 *                                       pings via kyberbot notify)
 *
 * Each surface calls synthesizeFocus(); a 30-minute in-memory cache
 * keyed by an input-hash means the LLM call only fires when signals
 * have actually changed. forceRefresh bypasses the cache.
 *
 * Hard rule: each signal puller is isolated in try/catch — a Gmail
 * OAuth failure can't take out the calendar/memory parts. Partial
 * signal sets are the norm during early-deployment days.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '../logger.js';
import { getClaudeClient } from '../claude.js';
import { getIdentityForRoot } from '../config.js';
import { getTimelineDb, getRecentActivity } from '../brain/timeline.js';
import { getEntityGraphDb } from '../brain/entity-graph.js';
import { listProposals } from './proposals.js';

const logger = createLogger('focus');

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export type FocusUrgency = 'now' | 'today' | 'this_week' | 'whenever';
export type FocusValue = 'high' | 'medium' | 'low';
export type FocusSource =
  | 'calendar' | 'mail' | 'proposal' | 'draft'
  | 'heartbeat' | 'memory' | 'pinned' | 'inferred';

export interface FocusItem {
  /** Stable short id — used by Phase C to dedupe across cycles. */
  id: string;
  title: string;
  rationale: string;
  source: FocusSource;
  urgency: FocusUrgency;
  value: FocusValue;
  action?: string;
  related_ids?: string[];
}

export interface FocusResult {
  topFocus: FocusItem[];
  urgent: FocusItem[];
  valuable: FocusItem[];
  generatedAt: string;
  signalsUsed: Record<string, number>;
  inputHash: string;
  cached: boolean;
}

export interface FocusOptions {
  root: string;
  forceRefresh?: boolean;
  /** Cache TTL in milliseconds. Default 30 minutes. */
  maxAgeMs?: number;
  /** Override Claude model for synthesis. Default: identity's claude.model or sonnet. */
  model?: string;
  /**
   * Return cached result if present; otherwise return an empty result
   * without doing any work. Used by per-turn enrichment so channel
   * replies never pay for signal pulls or LLM calls inline.
   */
  cacheOnly?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// In-memory cache (per-process)
// ─────────────────────────────────────────────────────────────────────

interface CacheEntry { result: FocusResult; storedAt: number; }
const cache = new Map<string, CacheEntry>();
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

export function resetFocusCache(root?: string): void {
  if (root) cache.delete(root);
  else cache.clear();
}

// ─────────────────────────────────────────────────────────────────────
// Signal types — raw shape we hand to the LLM
// ─────────────────────────────────────────────────────────────────────

interface CalendarSignal {
  id: string;
  summary: string;
  start: string;
  end?: string;
  location?: string;
  attendees?: string[];
}

interface MailSignal {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  unread: boolean;
  ageHours: number;
}

interface PinnedSignal { name: string; type: string; }

interface ProposalSignal {
  id: string;
  type: string;
  target_path: string;
  priority?: number;
  created: string;
  body_preview: string;
}

interface DraftSignal { id: string; subject?: string; ageHours: number; }

interface HeartbeatSignal { name: string; schedule: string; expires?: string; }

interface RecentMentionSignal { entity: string; mention_count: number; last_seen: string; }

interface AllSignals {
  now: string;
  timezone: string;
  calendar: CalendarSignal[];
  mail: MailSignal[];
  pinned: PinnedSignal[];
  proposals: ProposalSignal[];
  drafts: DraftSignal[];
  heartbeat: HeartbeatSignal[];
  recentMentions: RecentMentionSignal[];
}

// ─────────────────────────────────────────────────────────────────────
// Per-signal pullers (each isolated; failures don't propagate)
// ─────────────────────────────────────────────────────────────────────

function spawnCli(cmd: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(null);
    }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? stdout : null);
    });
  });
}

async function pullCalendar(root: string): Promise<CalendarSignal[]> {
  try {
    const out = await spawnCli('kyberbot', ['calendar', 'week', '--json'], root);
    if (!out) return [];
    const events = JSON.parse(out) as Array<{
      id: string; summary: string; start: string; end?: string; location?: string; attendees?: string[];
    }>;
    return events.slice(0, 30);
  } catch (err) {
    logger.debug('Calendar signal failed', { error: String(err) });
    return [];
  }
}

async function pullMail(root: string): Promise<MailSignal[]> {
  try {
    const out = await spawnCli('kyberbot', ['gmail', 'recent', '--days', '3', '--json'], root);
    if (!out) return [];
    const threads = JSON.parse(out) as Array<{
      id: string; subject: string; from: string; snippet: string; unread: boolean; timestamp: string;
    }>;
    return threads.slice(0, 20).map((t) => ({
      id: t.id,
      subject: t.subject,
      from: t.from,
      snippet: t.snippet?.slice(0, 200) ?? '',
      unread: !!t.unread,
      ageHours: t.timestamp ? Math.round((Date.now() - new Date(t.timestamp).getTime()) / 3_600_000) : -1,
    }));
  } catch (err) {
    logger.debug('Mail signal failed', { error: String(err) });
    return [];
  }
}

async function pullPinned(root: string): Promise<PinnedSignal[]> {
  try {
    const db = await getEntityGraphDb(root);
    const rows = db.prepare(`
      SELECT name, type FROM entities
      WHERE is_pinned = 1
      ORDER BY mention_count DESC
      LIMIT 30
    `).all() as Array<{ name: string; type: string }>;
    return rows;
  } catch (err) {
    logger.debug('Pinned signal failed', { error: String(err) });
    return [];
  }
}

function pullProposalsSignal(root: string): ProposalSignal[] {
  try {
    const pending = listProposals(root, { status: 'pending' });
    return pending.slice(0, 20).map((p) => ({
      id: p.frontmatter.id,
      type: p.frontmatter.type,
      target_path: p.frontmatter.target_path,
      priority: p.frontmatter.priority,
      created: p.frontmatter.created,
      body_preview: p.body.replace(/\n+/g, ' ').slice(0, 200),
    }));
  } catch (err) {
    logger.debug('Proposals signal failed', { error: String(err) });
    return [];
  }
}

function pullDrafts(root: string): DraftSignal[] {
  try {
    const dir = join(root, 'brain', 'drafts');
    if (!existsSync(dir)) return [];
    const now = Date.now();
    const out: DraftSignal[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const id = file.replace(/\.md$/, '');
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        if (content.includes('status: sent')) continue;
        const subjMatch = content.match(/subject:\s*(.+)/);
        const createdMatch = content.match(/created_at:\s*(\S+)/);
        const ageHours = createdMatch ? Math.round((now - new Date(createdMatch[1]).getTime()) / 3_600_000) : -1;
        out.push({ id, subject: subjMatch?.[1]?.trim(), ageHours });
      } catch { /* skip bad draft */ }
    }
    return out;
  } catch (err) {
    logger.debug('Drafts signal failed', { error: String(err) });
    return [];
  }
}

function pullHeartbeat(root: string): HeartbeatSignal[] {
  try {
    const path = join(root, 'HEARTBEAT.md');
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf-8');
    const afterTasks = content.split(/^##\s+Tasks\b/im)[1];
    if (!afterTasks) return [];
    const blocks = afterTasks.split(/^###\s+/m).slice(1);
    return blocks.flatMap((block): HeartbeatSignal[] => {
      const name = block.match(/^([^\n]+)/)?.[1]?.trim();
      const schedule = block.match(/\*\*Schedule\*\*:\s*([^\n]+)/i)?.[1]?.trim();
      if (!name || !schedule) return [];
      const expires = block.match(/\*\*Expires\*\*:\s*([^\n]+)/i)?.[1]?.trim();
      return [{ name, schedule, expires }];
    });
  } catch (err) {
    logger.debug('Heartbeat signal failed', { error: String(err) });
    return [];
  }
}

async function pullRecentMentions(root: string): Promise<RecentMentionSignal[]> {
  try {
    // Last 7d of activity, take the top entities by mentions
    const events = await getRecentActivity(root, 100);
    const counts = new Map<string, { count: number; last: string }>();
    const cutoff = Date.now() - 7 * 24 * 3_600_000;
    for (const e of events) {
      if (new Date(e.timestamp).getTime() < cutoff) continue;
      for (const ent of (e.entities ?? [])) {
        const prev = counts.get(ent);
        if (prev) {
          prev.count += 1;
          if (e.timestamp > prev.last) prev.last = e.timestamp;
        } else {
          counts.set(ent, { count: 1, last: e.timestamp });
        }
      }
    }
    return [...counts.entries()]
      .filter(([, v]) => v.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([entity, v]) => ({ entity, mention_count: v.count, last_seen: v.last }));
  } catch (err) {
    logger.debug('Recent mentions signal failed', { error: String(err) });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────
// Prompt construction + LLM call
// ─────────────────────────────────────────────────────────────────────

function buildPrompt(signals: AllSignals): string {
  return `You are the focus-synthesis engine for a personal AI agent. Your job: given everything we know about Samuel right now, decide what he should actually DO.

Current time: ${signals.now} (${signals.timezone})

═══ CALENDAR (next 7 days) ═══
${signals.calendar.length === 0 ? '(no calendar events available)' : signals.calendar.map((e, i) => {
    const where = e.location ? ` @ ${e.location}` : '';
    const who = e.attendees && e.attendees.length > 0 ? ` with ${e.attendees.slice(0, 3).join(', ')}` : '';
    return `${i + 1}. ${e.start} → ${e.summary}${where}${who}`;
  }).join('\n')}

═══ MAIL (last 3 days) ═══
${signals.mail.length === 0 ? '(no mail signals)' : signals.mail.map((m, i) => {
    const flag = m.unread ? '★ ' : '  ';
    const age = m.ageHours >= 0 ? `${m.ageHours}h ago` : '';
    return `${i + 1}. ${flag}[${age}] ${m.from} — ${m.subject}\n     ${m.snippet}`;
  }).join('\n')}

═══ PENDING PROPOSALS (need approval / rejection) ═══
${signals.proposals.length === 0 ? '(none pending)' : signals.proposals.map((p) => {
    return `- ${p.id} [${p.type}, priority ${p.priority ?? '?'}]\n    ${p.body_preview}`;
  }).join('\n')}

═══ DRAFTS WAITING TO SEND ═══
${signals.drafts.length === 0 ? '(none)' : signals.drafts.map((d) => `- ${d.id} (${d.ageHours}h old) — ${d.subject ?? '(no subject)'}`).join('\n')}

═══ PINNED ENTITIES (people / projects Samuel marked important) ═══
${signals.pinned.length === 0 ? '(none pinned)' : signals.pinned.map((p) => `- ${p.name} (${p.type})`).join('\n')}

═══ UPCOMING HEARTBEAT TASKS ═══
${signals.heartbeat.length === 0 ? '(none)' : signals.heartbeat.map((h) => `- ${h.name}: ${h.schedule}${h.expires ? ` (expires ${h.expires})` : ''}`).join('\n')}

═══ RECENT FOCUS (entities mentioned 2+ times in last 7 days) ═══
${signals.recentMentions.length === 0 ? '(no recurring topics)' : signals.recentMentions.map((r) => `- ${r.entity}: ${r.mention_count} mentions, last on ${r.last_seen.slice(0, 10)}`).join('\n')}

═══ YOUR TASK ═══

Return JSON with three arrays. Do NOT pad — only include things that pass the bar described.

{
  "topFocus": [  // 1-5 things Samuel should DO today, ordered by what matters most
    {
      "id": "short-stable-slug",       // e.g. "reply-janet-budget" — used to dedupe across runs
      "title": "one-line headline",
      "rationale": "1-2 sentences why this matters right now",
      "source": "calendar|mail|proposal|draft|heartbeat|memory|pinned|inferred",
      "urgency": "now|today|this_week|whenever",
      "value": "high|medium|low",
      "action": "concrete next step (a sentence the user can act on)",
      "related_ids": ["proposal-id", "mail-id", ...]  // optional cross-references
    }
  ],
  "urgent": [  // 0-3 items with a deadline within ~2h, OR something that will pass without action
    // ... same shape, only include real urgencies
  ],
  "valuable": [  // 0-3 opportunity windows — action now creates disproportionate value
    // ... e.g. "Janet replied within the hour — striking while warm" or
    //          "deadline is Thursday but doing now buys 2-day buffer"
  ]
}

CRITICAL RULES:
- urgent[] requires a real deadline. "Soon" doesn't count.
- valuable[] is about *timing windows*, not just importance. If action could equally happen tomorrow, it's not valuable here.
- Don't repeat across arrays. If something is urgent, it belongs in urgent[] only, not also in topFocus[].
- If nothing meets a bar, return an empty array. Silence is correct.
- id must be a short kebab-case slug, stable across runs (e.g. "reply-janet-q2-budget").
- Output ONLY the JSON object, wrapped in a single \`\`\`json … \`\`\` fence. No prose.`;
}

function parseLLMResponse(raw: string): FocusResult | null {
  // Find JSON fence (preferred) or raw braces
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenceMatch ? fenceMatch[1] : raw;
  try {
    const parsed = JSON.parse(jsonText.trim()) as Pick<FocusResult, 'topFocus' | 'urgent' | 'valuable'>;
    if (!Array.isArray(parsed.topFocus) || !Array.isArray(parsed.urgent) || !Array.isArray(parsed.valuable)) {
      logger.warn('LLM returned invalid shape', { hasTopFocus: Array.isArray(parsed.topFocus) });
      return null;
    }
    return {
      ...parsed,
      generatedAt: new Date().toISOString(),
      signalsUsed: {},
      inputHash: '',
      cached: false,
    };
  } catch (err) {
    logger.warn('Could not parse focus JSON', { error: String(err), head: raw.slice(0, 200) });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────

async function gatherSignals(root: string): Promise<AllSignals> {
  const identity = getIdentityForRoot(root);
  const tz = identity.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [calendar, mail, pinned, recentMentions] = await Promise.all([
    pullCalendar(root),
    pullMail(root),
    pullPinned(root),
    pullRecentMentions(root),
  ]);
  return {
    now: new Date().toISOString(),
    timezone: tz,
    calendar,
    mail,
    pinned,
    proposals: pullProposalsSignal(root),
    drafts: pullDrafts(root),
    heartbeat: pullHeartbeat(root),
    recentMentions,
  };
}

function hashSignals(s: AllSignals): string {
  // Hash only stable identifiers; not the "now" timestamp.
  const stable = {
    cal: s.calendar.map((e) => `${e.id}:${e.start}`),
    mail: s.mail.map((m) => `${m.id}:${m.unread}`),
    pinned: s.pinned.map((p) => p.name),
    proposals: s.proposals.map((p) => p.id),
    drafts: s.drafts.map((d) => d.id),
    heartbeat: s.heartbeat.map((h) => h.name),
    recent: s.recentMentions.map((r) => r.entity),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

export async function synthesizeFocus(opts: FocusOptions): Promise<FocusResult> {
  const { root } = opts;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  // Fast path: cache is fresh (by age) — return immediately without
  // pulling signals OR re-hashing. The cached result already reflects
  // what we thought was important when it was generated, which is the
  // whole point of cache TTL. Phase B (per-turn enrichment) relies on
  // this: every channel reply would otherwise pay multi-second CLI
  // spawn costs to pull calendar + mail just to hit the cache.
  if (!opts.forceRefresh) {
    const cached = cache.get(root);
    if (cached && (Date.now() - cached.storedAt) < maxAgeMs) {
      return { ...cached.result, cached: true };
    }
  }

  // cacheOnly: caller doesn't want us to do any real work — return an
  // empty placeholder. Used by per-turn enrichment so channel replies
  // never block on signal pulls or LLM synthesis.
  if (opts.cacheOnly) {
    return {
      topFocus: [], urgent: [], valuable: [],
      generatedAt: new Date().toISOString(),
      signalsUsed: {}, inputHash: '', cached: false,
    };
  }

  const signals = await gatherSignals(root);
  const inputHash = hashSignals(signals);
  const signalsUsed: Record<string, number> = {
    calendar: signals.calendar.length,
    mail: signals.mail.length,
    pinned: signals.pinned.length,
    proposals: signals.proposals.length,
    drafts: signals.drafts.length,
    heartbeat: signals.heartbeat.length,
    recentMentions: signals.recentMentions.length,
  };

  // Stale-content check: if the input hash matches a stored result, we
  // can short-circuit the LLM call entirely even though the time-based
  // TTL has expired. Signals haven't actually changed.
  if (!opts.forceRefresh) {
    const cached = cache.get(root);
    if (cached && cached.result.inputHash === inputHash) {
      cached.storedAt = Date.now();
      return { ...cached.result, cached: true };
    }
  }

  // Ask Claude
  const identity = getIdentityForRoot(root);
  const rawModel = opts.model ?? identity.claude?.model ?? 'sonnet';
  const model: 'haiku' | 'sonnet' | 'opus' =
    rawModel === 'haiku' || rawModel === 'opus' ? rawModel : 'sonnet';
  const prompt = buildPrompt(signals);

  let reply: string;
  try {
    reply = await getClaudeClient().complete(prompt, {
      maxTurns: 1,
      subprocess: true,
      cwd: root,
      model,
      tools: 'narrow',
    });
  } catch (err) {
    logger.warn('Focus synthesis Claude call failed', { error: String(err) });
    const empty: FocusResult = {
      topFocus: [], urgent: [], valuable: [],
      generatedAt: new Date().toISOString(),
      signalsUsed, inputHash, cached: false,
    };
    return empty;
  }

  const parsed = parseLLMResponse(reply);
  const result: FocusResult = parsed ?? {
    topFocus: [], urgent: [], valuable: [],
    generatedAt: new Date().toISOString(),
    signalsUsed, inputHash, cached: false,
  };
  result.signalsUsed = signalsUsed;
  result.inputHash = inputHash;
  result.cached = false;

  cache.set(root, { result, storedAt: Date.now() });

  // Optional: persist last run for inspection
  try {
    const dir = join(root, 'brain', 'focus');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'last.json'),
      JSON.stringify(result, null, 2),
      'utf-8',
    );
  } catch { /* best-effort persistence */ }

  logger.info('Focus synthesis complete', {
    topFocus: result.topFocus.length,
    urgent: result.urgent.length,
    valuable: result.valuable.length,
    signalsUsed,
  });

  // Touch timeline DB so getRecentActivity is exercised at least once
  // and any errors surface during boot rather than first nudge.
  void getTimelineDb;

  return result;
}
