/**
 * Self-Learning Proposals Service
 *
 * Tier 2 of self-learning. Manages proposal markdown files in
 * `<root>/brain/proposals/` — load, list, filter, apply, revert, archive.
 *
 * Each proposal is a markdown file with YAML frontmatter + a body that
 * includes a unified diff for the target file. See
 * docs/self-learning-plan.md §3.2 for the schema.
 *
 * Apply path:
 *   1. Validate target_path against the hard-never list (defense in depth).
 *   2. Apply the diff (or full-content replace) to the target file.
 *   3. git add + commit + tag `proposal/<id>` for revertability.
 *   4. Update proposal frontmatter to status=applied with applied_at + commit hash.
 *
 * Revert path:
 *   1. Find the tag `proposal/<id>` in the agent's git repo.
 *   2. git revert that commit (creates a new commit that undoes it).
 *   3. Update proposal frontmatter to status=reverted with reverted_at.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, renameSync } from 'fs';
import { join, resolve, relative, dirname, basename } from 'path';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import yaml from 'js-yaml';
import { createLogger } from '../logger.js';

const logger = createLogger('proposals');

// ── Paths a proposal MUST NOT touch even if scope is set to "max" ──────
// Match by relative-to-root prefix. Any proposal targeting these is
// refused at apply time regardless of how the proposal was drafted.
const HARD_NEVER_PREFIXES = [
  '.env',
  '.env.',
  'data/',
  '.git/',
  'node_modules/',
];

// ── Frontmatter schema ─────────────────────────────────────────────────

export type ProposalStatus = 'pending' | 'approved' | 'applied' | 'rejected' | 'reverted' | 'rejected_blocked';

export type ProposalType =
  | 'personality_tweak'
  | 'skill_revision'
  | 'heartbeat_change'
  | 'identity_update'
  | 'brain_note'
  // ── Phase 5: autonomous action types ──────────────────────────────
  // These don't modify files in the repo; they trigger external actions
  // when approved. Each has a registered handler in services/
  // proposal-handlers/ that knows how to execute it (and how to
  // refuse if a hard rule is violated).
  | 'email_draft'        // Send the draft body via Gmail
  | 'calendar_action'    // Create/update a Google Calendar event
  | 'file_edit'          // Apply a diff to a file outside SOUL/USER/HEARTBEAT
  | 'external_send'      // Generic outbound: webhook, IFTTT, etc.
  | 'other';

export interface ProposalFrontmatter {
  id: string;
  created: string;
  status: ProposalStatus;
  type: ProposalType;
  target_path: string;       // path relative to agent root
  priority?: number;         // 0..1
  evidence_event_ids?: number[];
  applied_at?: string | null;
  applied_commit?: string | null;
  reverted_at?: string | null;
  rejected_at?: string | null;
}

export interface Proposal {
  filePath: string;          // absolute path on disk
  frontmatter: ProposalFrontmatter;
  body: string;              // markdown body, including the diff fence
}

export interface ProposalDraft {
  type: ProposalType;
  target_path: string;
  title: string;
  why: string;
  diff: string;              // unified diff body OR a full-replace marker
  risk?: string;
  evidence_event_ids?: number[];
  priority?: number;
}

// ── Locations ──────────────────────────────────────────────────────────

function proposalsDir(root: string): string {
  return join(root, 'brain', 'proposals');
}

function archiveDir(root: string): string {
  return join(proposalsDir(root), 'archive');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Frontmatter parse / serialize ──────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function parseProposalFile(filePath: string): Proposal | null {
  const raw = readFileSync(filePath, 'utf-8');
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    logger.warn('Proposal file has no frontmatter', { file: filePath });
    return null;
  }
  let frontmatter: ProposalFrontmatter;
  try {
    frontmatter = yaml.load(m[1]) as ProposalFrontmatter;
  } catch (err) {
    logger.warn('Proposal frontmatter parse failed', { file: filePath, error: String(err) });
    return null;
  }
  return { filePath, frontmatter, body: m[2] };
}

function writeProposalFile(p: Proposal): void {
  const fm = yaml.dump(p.frontmatter, { lineWidth: 200 });
  const out = `---\n${fm}---\n${p.body}`;
  writeFileSync(p.filePath, out);
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Save a new proposal draft as a file in `brain/proposals/`. Returns the
 * created Proposal record. Filename pattern:
 *   YYYY-MM-DD-<type>-<short-id>.md
 */
export function createProposal(root: string, draft: ProposalDraft): Proposal {
  ensureDir(proposalsDir(root));
  const id = randomUUID().slice(0, 8);
  const created = new Date().toISOString();
  const datePart = created.slice(0, 10);
  const slug = (draft.title || draft.target_path).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const fileName = `${datePart}-${draft.type.replace(/_/g, '-')}-${slug}-${id}.md`;
  const filePath = join(proposalsDir(root), fileName);

  const frontmatter: ProposalFrontmatter = {
    id: `${draft.type}-${id}`,
    created,
    status: 'pending',
    type: draft.type,
    target_path: draft.target_path,
    priority: draft.priority ?? 0.5,
    evidence_event_ids: draft.evidence_event_ids ?? [],
    applied_at: null,
    applied_commit: null,
    reverted_at: null,
  };

  const body = [
    `# Proposal: ${draft.title}`,
    '',
    '## Why',
    draft.why.trim(),
    '',
    '## Proposed change',
    '',
    '```diff',
    draft.diff.trim(),
    '```',
    '',
    '## Risk',
    (draft.risk || 'low').trim(),
    '',
  ].join('\n');

  const proposal: Proposal = { filePath, frontmatter, body };
  writeProposalFile(proposal);
  bestEffortCommit(root, filePath, `chore: draft proposal ${frontmatter.id}`);
  logger.info('Proposal created', { id: frontmatter.id, target: draft.target_path });
  return proposal;
}

/**
 * Stage + commit a single file. Best-effort: if git isn't available or the
 * dir isn't a repo, silently skip. Used to keep the working tree clean
 * after every proposal status change so the next applyProposal's dirty-tree
 * guard doesn't trip on our own bookkeeping.
 */
function bestEffortCommit(root: string, filePath: string, message: string): void {
  try {
    const inRepo = git(root, ['rev-parse', '--is-inside-work-tree']).status === 0;
    if (!inRepo) return;
    git(root, ['add', '--', filePath]);
    git(root, ['commit', '-m', message]);
  } catch (err) {
    logger.debug('best-effort commit skipped', { error: String(err) });
  }
}

/**
 * List proposals matching status filter (default: pending only). Sorted by
 * priority descending then created descending.
 */
export function listProposals(
  root: string,
  options: { status?: ProposalStatus | 'all' } = {},
): Proposal[] {
  const dir = proposalsDir(root);
  if (!existsSync(dir)) return [];
  const status = options.status ?? 'pending';
  const result: Proposal[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const filePath = join(dir, name);
    const stat = statSync(filePath);
    if (stat.isDirectory()) continue;
    const p = parseProposalFile(filePath);
    if (!p) continue;
    if (status !== 'all' && p.frontmatter.status !== status) continue;
    result.push(p);
  }
  result.sort((a, b) => {
    const pa = a.frontmatter.priority ?? 0.5;
    const pb = b.frontmatter.priority ?? 0.5;
    if (pa !== pb) return pb - pa;
    return b.frontmatter.created.localeCompare(a.frontmatter.created);
  });
  return result;
}

/**
 * Find a proposal by short id (the suffix after the type — e.g. `abc12345`)
 * or by full id (`personality_tweak-abc12345`). Searches all statuses.
 */
export function findProposal(root: string, queryId: string): Proposal | null {
  const all = listProposals(root, { status: 'all' });
  const q = queryId.toLowerCase();
  for (const p of all) {
    if (p.frontmatter.id.toLowerCase() === q) return p;
    const shortId = p.frontmatter.id.split('-').slice(-1)[0].toLowerCase();
    if (shortId === q) return p;
  }
  return null;
}

// ── Apply / reject / revert ────────────────────────────────────────────

export interface ApplyResult {
  proposal: Proposal;
  applied: boolean;
  reason?: string;
  commitHash?: string;
}

/**
 * Reject a proposal — marks status, no file changes to the agent.
 */
export function rejectProposal(root: string, proposal: Proposal): ApplyResult {
  proposal.frontmatter.status = 'rejected';
  proposal.frontmatter.rejected_at = new Date().toISOString();
  writeProposalFile(proposal);
  bestEffortCommit(root, proposal.filePath, `chore: reject proposal ${proposal.frontmatter.id}`);
  logger.info('Proposal rejected', { id: proposal.frontmatter.id });
  return { proposal, applied: false, reason: 'rejected' };
}

/**
 * Apply a proposal: mutate the target file using the diff, git-commit + tag,
 * update proposal status. Returns ApplyResult with commit hash on success.
 *
 * Hard-never path check is enforced here regardless of how the proposal was
 * drafted — defense in depth against bad detector output.
 */
export async function applyProposal(root: string, proposal: Proposal): Promise<ApplyResult> {
  const target = proposal.frontmatter.target_path;

  // ── Phase 5: action-proposal handler dispatch ──────────────────────
  // For email_draft / calendar_action / external_send, hand off to the
  // registered handler instead of running git apply. These don't touch
  // the repo; they execute external API calls. The handler is
  // responsible for its own destination validation (e.g. recipient
  // blocklist) on top of the global hard-never path check below.
  try {
    const { getHandler } = await import('./proposal-handlers/index.js');
    const handler = getHandler(proposal.frontmatter.type);
    if (handler) {
      const result = await handler(root, proposal);
      if (result.applied) {
        proposal.frontmatter.status = 'applied';
        proposal.frontmatter.applied_at = new Date().toISOString();
        if (result.artifact_id) {
          (proposal.frontmatter as ProposalFrontmatter & { artifact_id?: string }).artifact_id = result.artifact_id;
        }
        writeProposalFile(proposal);
        logger.info('Proposal applied via handler', { id: proposal.frontmatter.id, type: proposal.frontmatter.type, artifact: result.artifact_id });
        return { proposal, applied: true };
      } else {
        return { proposal, applied: false, reason: result.reason ?? 'handler refused' };
      }
    }
  } catch (err) {
    logger.warn('Handler dispatch failed; falling through to git-apply path', { error: String(err) });
  }

  if (isHardNever(target)) {
    proposal.frontmatter.status = 'rejected_blocked';
    writeProposalFile(proposal);
    logger.warn('Proposal blocked by hard-never list', { id: proposal.frontmatter.id, target });
    return { proposal, applied: false, reason: `target_path '${target}' is on the hard-never list` };
  }

  // Working tree must be clean before apply — otherwise we can't reliably
  // attribute the commit to this proposal.
  const status = git(root, ['status', '--porcelain']);
  if (status.stdout.trim().length > 0) {
    return { proposal, applied: false, reason: 'agent repo working tree is dirty; commit/stash first' };
  }

  const diff = extractDiffFromBody(proposal.body);
  if (!diff) {
    return { proposal, applied: false, reason: 'no diff fence found in proposal body' };
  }

  // Apply via `git apply`. Diffs in proposals are unified. git apply
  // requires a trailing newline on stdin; the regex capture trims it.
  const apply = git(root, ['apply', '-'], diff.endsWith('\n') ? diff : diff + '\n');
  if (apply.status !== 0) {
    return {
      proposal, applied: false,
      reason: `git apply failed: ${apply.stderr.trim().slice(0, 300)}`,
    };
  }

  // Stage the target + the proposal file (status update follows below).
  const targetAbs = resolve(root, target);
  git(root, ['add', '--', targetAbs]);

  // Commit
  const msg = `apply proposal ${proposal.frontmatter.id}: ${target}\n\n` +
              `Auto-applied via kyberbot proposals approve.\n` +
              `Revert with: kyberbot proposals revert ${proposal.frontmatter.id}`;
  const commit = git(root, ['commit', '-m', msg]);
  if (commit.status !== 0) {
    return { proposal, applied: false, reason: `git commit failed: ${commit.stderr.trim().slice(0, 300)}` };
  }

  const sha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const tagName = `proposal/${proposal.frontmatter.id}`;
  git(root, ['tag', '-f', tagName, sha]);

  // Mark as applied + persist; commit the proposal status update separately
  // so the original-application commit only contains the actual change.
  proposal.frontmatter.status = 'applied';
  proposal.frontmatter.applied_at = new Date().toISOString();
  proposal.frontmatter.applied_commit = sha;
  writeProposalFile(proposal);
  git(root, ['add', '--', proposal.filePath]);
  git(root, ['commit', '-m', `chore: mark proposal ${proposal.frontmatter.id} applied`]);

  logger.info('Proposal applied', { id: proposal.frontmatter.id, target, sha });
  return { proposal, applied: true, commitHash: sha };
}

/**
 * Revert a previously applied proposal. Uses `git revert <commit>` so the
 * undo is itself a commit (not a history rewrite). Requires the proposal's
 * `applied_commit` hash.
 */
export function revertProposal(root: string, proposal: Proposal): ApplyResult {
  if (proposal.frontmatter.status !== 'applied') {
    return { proposal, applied: false, reason: `proposal status is ${proposal.frontmatter.status}, not applied` };
  }
  const sha = proposal.frontmatter.applied_commit;
  if (!sha) {
    return { proposal, applied: false, reason: 'proposal has no applied_commit recorded' };
  }
  const status = git(root, ['status', '--porcelain']);
  if (status.stdout.trim().length > 0) {
    return { proposal, applied: false, reason: 'agent repo working tree is dirty; commit/stash first' };
  }

  const revert = git(root, ['revert', '--no-edit', sha]);
  if (revert.status !== 0) {
    return { proposal, applied: false, reason: `git revert failed: ${revert.stderr.trim().slice(0, 300)}` };
  }

  proposal.frontmatter.status = 'reverted';
  proposal.frontmatter.reverted_at = new Date().toISOString();
  writeProposalFile(proposal);
  git(root, ['add', '--', proposal.filePath]);
  git(root, ['commit', '-m', `chore: mark proposal ${proposal.frontmatter.id} reverted`]);

  logger.info('Proposal reverted', { id: proposal.frontmatter.id, sha });
  return { proposal, applied: true };
}

// ── Archive ────────────────────────────────────────────────────────────

/**
 * Move proposals in any terminal status (applied/rejected/reverted/blocked)
 * older than `maxAgeDays` into `brain/proposals/archive/YYYY-MM/`. Pending
 * proposals are never archived.
 */
export function archiveOldProposals(root: string, maxAgeDays = 90): { archived: number } {
  const now = Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60_000;
  const all = listProposals(root, { status: 'all' });
  let archived = 0;
  for (const p of all) {
    if (p.frontmatter.status === 'pending') continue;
    const created = new Date(p.frontmatter.created).getTime();
    if (created > cutoff) continue;
    const ym = p.frontmatter.created.slice(0, 7);  // YYYY-MM
    const targetDir = join(archiveDir(root), ym);
    ensureDir(targetDir);
    const newPath = join(targetDir, basename(p.filePath));
    try {
      renameSync(p.filePath, newPath);
      archived += 1;
    } catch (err) {
      logger.warn('Failed to archive proposal', { id: p.frontmatter.id, error: String(err) });
    }
  }
  if (archived > 0) logger.info('Archived old proposals', { archived, maxAgeDays });
  return { archived };
}

// ── helpers ────────────────────────────────────────────────────────────

export function isHardNever(targetPath: string): boolean {
  // Reject absolute paths and traversal first — these signals are independent
  // of any prefix matching and must catch even pre-strip.
  if (targetPath.startsWith('/')) return true;
  if (targetPath.includes('..')) return true;
  // Strip leading ./ only (not /) for prefix matching.
  const norm = targetPath.replace(/^\.\/+/, '');
  for (const prefix of HARD_NEVER_PREFIXES) {
    if (norm === prefix.replace(/\/$/, '') || norm.startsWith(prefix)) return true;
  }
  return false;
}

function extractDiffFromBody(body: string): string | null {
  const m = body.match(/```diff\n([\s\S]*?)\n```/);
  return m ? m[1] : null;
}

function git(cwd: string, args: string[], stdin?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, {
    cwd,
    input: stdin,
    encoding: 'utf-8',
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

// ── Re-exports for the CLI command (kept private to this file otherwise)
export { proposalsDir, archiveDir };
