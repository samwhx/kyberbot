/**
 * `kyberbot proposals` — manage self-learning proposals.
 *
 * Subcommands:
 *   list                        list pending proposals (--all for any status)
 *   show <id>                   print a single proposal's full content
 *   approve <id> [<id> ...]     apply one or more proposals
 *   reject <id> [<id> ...]      mark as rejected (no file changes)
 *   revert <id>                 undo an applied proposal via git revert
 *   archive                     move terminal-status proposals >90d to archive/
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getRoot } from '../config.js';
import {
  listProposals,
  findProposal,
  applyProposal,
  rejectProposal,
  revertProposal,
  archiveOldProposals,
} from '../services/proposals.js';
import { runSelfReview } from '../services/self-review.js';
import type { Proposal, ProposalStatus } from '../services/proposals.js';

function formatProposal(p: Proposal, opts: { full?: boolean } = {}): string {
  const fm = p.frontmatter;
  const status = fm.status === 'pending' ? chalk.yellow(fm.status)
    : fm.status === 'applied' ? chalk.green(fm.status)
    : fm.status === 'rejected' || fm.status === 'rejected_blocked' ? chalk.red(fm.status)
    : fm.status === 'reverted' ? chalk.gray(fm.status)
    : fm.status;
  const priority = (fm.priority ?? 0.5).toFixed(2);
  const lines: string[] = [];
  lines.push(`${chalk.bold(fm.id)}  ${status}  p=${priority}  ${chalk.dim(fm.type)}`);
  lines.push(`  target: ${fm.target_path}`);
  lines.push(`  created: ${fm.created.replace('T', ' ').slice(0, 19)}`);
  if (fm.applied_at) lines.push(`  applied: ${fm.applied_at.replace('T', ' ').slice(0, 19)} (${fm.applied_commit?.slice(0, 7)})`);
  if (fm.reverted_at) lines.push(`  reverted: ${fm.reverted_at.replace('T', ' ').slice(0, 19)}`);
  if (opts.full) {
    lines.push('');
    lines.push(p.body);
  }
  return lines.join('\n');
}

function handleList(opts: { all?: boolean; status?: string }): void {
  const root = getRoot();
  const status = opts.all ? 'all' : (opts.status as ProposalStatus | undefined) ?? 'pending';
  const proposals = listProposals(root, { status: status as ProposalStatus | 'all' });
  if (proposals.length === 0) {
    console.log(chalk.dim(`No ${status === 'all' ? '' : status + ' '}proposals.`));
    return;
  }
  console.log(chalk.bold(`${proposals.length} proposal(s)\n`));
  for (const p of proposals) {
    console.log(formatProposal(p));
    console.log('');
  }
  if (status === 'pending') {
    console.log(chalk.dim('Approve: kyberbot proposals approve <id>   |   Reject: kyberbot proposals reject <id>'));
  }
}

function handleShow(id: string): void {
  const p = findProposal(getRoot(), id);
  if (!p) {
    console.error(chalk.red(`No proposal found matching '${id}'`));
    process.exit(1);
  }
  console.log(formatProposal(p, { full: true }));
}

function handleApprove(ids: string[]): void {
  const root = getRoot();
  for (const id of ids) {
    const p = findProposal(root, id);
    if (!p) {
      console.error(chalk.red(`✗ ${id}: not found`));
      continue;
    }
    if (p.frontmatter.status !== 'pending') {
      console.error(chalk.red(`✗ ${id}: status is ${p.frontmatter.status}, not pending`));
      continue;
    }
    const result = applyProposal(root, p);
    if (result.applied) {
      console.log(chalk.green(`✓ ${id}: applied`) + chalk.dim(` (${result.commitHash?.slice(0, 7)})`));
    } else {
      console.error(chalk.red(`✗ ${id}: ${result.reason}`));
    }
  }
}

function handleReject(ids: string[]): void {
  const root = getRoot();
  for (const id of ids) {
    const p = findProposal(root, id);
    if (!p) {
      console.error(chalk.red(`✗ ${id}: not found`));
      continue;
    }
    if (p.frontmatter.status !== 'pending') {
      console.error(chalk.red(`✗ ${id}: status is ${p.frontmatter.status}, can only reject pending`));
      continue;
    }
    rejectProposal(root, p);
    console.log(chalk.gray(`✓ ${id}: rejected`));
  }
}

function handleRevert(id: string): void {
  const root = getRoot();
  const p = findProposal(root, id);
  if (!p) {
    console.error(chalk.red(`No proposal found matching '${id}'`));
    process.exit(1);
  }
  const result = revertProposal(root, p);
  if (result.applied) {
    console.log(chalk.green(`✓ ${id}: reverted`));
  } else {
    console.error(chalk.red(`✗ ${id}: ${result.reason}`));
    process.exit(1);
  }
}

function handleArchive(opts: { days?: string }): void {
  const days = opts.days ? parseInt(opts.days, 10) : 90;
  const result = archiveOldProposals(getRoot(), days);
  console.log(chalk.green(`Archived ${result.archived} proposal(s) older than ${days} days.`));
}

export function createProposalsCommand(): Command {
  const cmd = new Command('proposals')
    .description('Manage self-learning proposals — approve / reject / revert');

  cmd.command('list')
    .description('List pending proposals (default), or all/applied/rejected/reverted')
    .option('-a, --all', 'list proposals in any status')
    .option('-s, --status <status>', 'filter by status')
    .action(handleList);

  cmd.command('show <id>')
    .description('Print full proposal contents (frontmatter + diff + risk)')
    .action(handleShow);

  cmd.command('approve <ids...>')
    .description('Apply one or more proposals (auto-commit + tag for revertability)')
    .action(handleApprove);

  cmd.command('reject <ids...>')
    .description('Mark one or more proposals as rejected (no file changes)')
    .action(handleReject);

  cmd.command('revert <id>')
    .description('Undo a previously applied proposal via `git revert`')
    .action(handleRevert);

  cmd.command('archive')
    .description('Move terminal-status proposals older than N days into brain/proposals/archive/')
    .option('-d, --days <n>', 'age threshold in days', '90')
    .action(handleArchive);

  cmd.command('review')
    .description('Run self-review now: scan last 24h, fire pattern detectors, draft proposals')
    .action(async () => {
      const result = await runSelfReview(getRoot());
      console.log(chalk.bold(`Self-review complete`));
      console.log(`  scanned: ${result.scanned} replies`);
      console.log(`  patterns fired: ${Object.keys(result.patterns_fired).length === 0 ? '(none)' : ''}`);
      for (const [name, count] of Object.entries(result.patterns_fired)) {
        console.log(`    ${name}: ${count}`);
      }
      console.log(`  proposals drafted: ${result.proposals_drafted}`);
      if (result.errors && result.errors.length > 0) {
        console.error(chalk.red(`  errors:`));
        for (const e of result.errors) console.error(`    - ${e}`);
      }
      if (result.proposals_drafted > 0) {
        console.log('');
        console.log(chalk.dim('Review with: kyberbot proposals list'));
      }
    });

  return cmd;
}
