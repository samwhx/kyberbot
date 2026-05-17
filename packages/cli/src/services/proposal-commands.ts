/**
 * Proposal-command parser for owner messaging channels.
 *
 * Pre-Claude intercept: when the owner sends a message like
 *   "approve abc12345"
 *   "reject abc12345"
 *   "approve abc12345, def67890"
 * AND at least one of the ids matches a *pending* proposal, run it
 * directly without spawning Claude.
 *
 * Strict guard: if no id matches a pending proposal, treat the text as
 * normal conversation (return null) so prose like "please approve my
 * cruise plan" passes through to Claude unchanged.
 */

import { createLogger } from '../logger.js';
import {
  listProposals,
  findProposal,
  applyProposal,
  rejectProposal,
} from './proposals.js';

const logger = createLogger('proposal-commands');

const COMMAND_RE = /^\s*(approve|reject)\s+([\w\s,-]+?)\s*$/i;

export interface ProposalCommandResult {
  action: 'approve' | 'reject';
  results: Array<{
    id: string;
    status: 'applied' | 'rejected' | 'not_found' | 'not_pending' | 'apply_failed';
    reason?: string;
    commit?: string;
  }>;
}

/**
 * Parse the text. Returns the parsed action+ids, or null if the text
 * doesn't look like a proposal command.
 */
export function parseProposalCommand(text: string): { action: 'approve' | 'reject'; ids: string[] } | null {
  const m = text.match(COMMAND_RE);
  if (!m) return null;
  const action = m[1].toLowerCase() as 'approve' | 'reject';
  const ids = m[2]
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (ids.length === 0) return null;
  return { action, ids };
}

/**
 * Try to run a proposal command. Returns the result if any of the
 * requested ids matches a pending proposal — i.e., the text was
 * unambiguously a command. Returns null otherwise so the caller can fall
 * through to normal Claude routing.
 */
export async function tryRunProposalCommand(
  root: string,
  text: string,
): Promise<ProposalCommandResult | null> {
  const parsed = parseProposalCommand(text);
  if (!parsed) return null;

  // Guard: at least one id must match an existing pending proposal.
  // Otherwise the user is just talking ("please approve my plan").
  const pending = listProposals(root).map(p => ({
    fullId: p.frontmatter.id,
    shortId: p.frontmatter.id.split('-').slice(-1)[0],
  }));
  const matchedAny = parsed.ids.some(id =>
    pending.some(p => p.fullId === id.toLowerCase() || p.shortId === id.toLowerCase()),
  );
  if (!matchedAny) return null;

  const result: ProposalCommandResult = { action: parsed.action, results: [] };
  for (const id of parsed.ids) {
    const proposal = findProposal(root, id);
    if (!proposal) {
      result.results.push({ id, status: 'not_found' });
      continue;
    }
    if (proposal.frontmatter.status !== 'pending') {
      result.results.push({
        id,
        status: 'not_pending',
        reason: `status is ${proposal.frontmatter.status}`,
      });
      continue;
    }
    if (parsed.action === 'approve') {
      const r = await applyProposal(root, proposal);
      if (r.applied) {
        result.results.push({ id, status: 'applied', commit: r.commitHash });
      } else {
        result.results.push({ id, status: 'apply_failed', reason: r.reason });
      }
    } else {
      rejectProposal(root, proposal);
      result.results.push({ id, status: 'rejected' });
    }
  }

  logger.info('proposal command processed', {
    action: parsed.action,
    count: result.results.length,
  });
  return result;
}

/**
 * Format a ProposalCommandResult for sending back to the user via channel.
 * Plain text — works in Telegram, WhatsApp, and terminal alike.
 */
export function formatProposalCommandReply(result: ProposalCommandResult): string {
  if (result.results.length === 0) return 'No matching proposals.';
  const lines: string[] = [];
  for (const r of result.results) {
    let icon: string;
    let extra = '';
    switch (r.status) {
      case 'applied':
        icon = '✓';
        extra = r.commit ? ` (${r.commit.slice(0, 7)})` : '';
        break;
      case 'rejected':
        icon = '✓';
        extra = ' (rejected)';
        break;
      case 'apply_failed':
        icon = '✗';
        extra = r.reason ? ` — ${r.reason}` : '';
        break;
      case 'not_found':
        icon = '?';
        extra = ' — not found';
        break;
      case 'not_pending':
        icon = '?';
        extra = r.reason ? ` — ${r.reason}` : '';
        break;
      default:
        icon = '?';
    }
    lines.push(`${icon} ${r.id}: ${r.status}${extra}`);
  }
  return lines.join('\n');
}
