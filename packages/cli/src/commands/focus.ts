import { Command } from 'commander';
import chalk from 'chalk';
import { getRoot } from '../config.js';
import { synthesizeFocus, type FocusItem, type FocusResult } from '../services/focus-synthesis.js';
import { createLogger } from '../logger.js';

const logger = createLogger('focus-cli');

function urgencyTag(u: FocusItem['urgency']): string {
  switch (u) {
    case 'now': return chalk.red('NOW');
    case 'today': return chalk.yellow('TODAY');
    case 'this_week': return chalk.cyan('WEEK');
    default: return chalk.dim('WHEN');
  }
}

function valueTag(v: FocusItem['value']): string {
  switch (v) {
    case 'high': return chalk.magenta('★★★');
    case 'medium': return chalk.dim('★★');
    default: return chalk.dim('★');
  }
}

function printSection(title: string, items: FocusItem[], emptyText: string): void {
  console.log(chalk.bold(`\n${title}`));
  if (items.length === 0) {
    console.log(chalk.dim(`  ${emptyText}`));
    return;
  }
  for (const it of items) {
    console.log(`  ${urgencyTag(it.urgency)} ${valueTag(it.value)} ${chalk.bold(it.title)}`);
    console.log(chalk.dim(`     ${it.rationale}`));
    if (it.action) console.log(chalk.cyan(`     → ${it.action}`));
    console.log(chalk.dim(`     [${it.source}] id=${it.id}`));
  }
}

function printResult(result: FocusResult): void {
  console.log(chalk.dim(`\nGenerated ${result.generatedAt}${result.cached ? ' (cache hit)' : ''}`));
  const signals = Object.entries(result.signalsUsed).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(chalk.dim(`Signals: ${signals}`));

  printSection('Top focus', result.topFocus, '(no priorities surfaced)');
  printSection('Urgent', result.urgent, '(nothing within the urgency window)');
  printSection('Valuable now', result.valuable, '(no time-sensitive opportunities)');
  console.log('');
}

async function handleFocus(opts: { json: boolean; refresh: boolean; ttlMins?: string }): Promise<void> {
  const root = getRoot();
  const maxAgeMs = opts.ttlMins != null ? Number(opts.ttlMins) * 60 * 1000 : undefined;

  try {
    const result = await synthesizeFocus({
      root,
      forceRefresh: opts.refresh,
      maxAgeMs,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    printResult(result);
  } catch (err) {
    logger.error('Focus command failed', { error: String(err) });
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

export function createFocusCommand(): Command {
  const cmd = new Command('focus')
    .description('Synthesise everything Alfred knows about today and surface what you should actually do (top priorities + urgent + valuable-now)')
    .option('--json', 'Output as JSON (for scripts / skills)', false)
    .option('--refresh', 'Bypass the 30-min cache and re-run the synthesis', false)
    .option('--ttl-mins <n>', 'Cache TTL in minutes (default 30)')
    .action(handleFocus);

  cmd
    .command('nudge')
    .description('Run one focus-nudge cycle (Phase C): re-synthesises with cache-busting, dedupes against the previous run, pings via kyberbot notify if a NEW urgent/valuable item surfaces')
    .option('--dry-run', "Don't send the notification; print what would have gone", false)
    .option('--interval-mins <n>', 'Minimum minutes between nudges (default 30)')
    .option('--max-items <n>', 'Max items per nudge body (default 3)')
    .option('--json', 'Output result as JSON', false)
    .action(async (opts: { dryRun: boolean; intervalMins?: string; maxItems?: string; json: boolean }) => {
      const root = getRoot();
      const { runFocusNudge } = await import('../services/focus-nudge.js');
      const result = await runFocusNudge({
        root,
        minIntervalMs: opts.intervalMins ? Number(opts.intervalMins) * 60_000 : undefined,
        maxItemsPerNudge: opts.maxItems ? Number(opts.maxItems) : undefined,
        dryRun: opts.dryRun,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.fired) {
        console.log(chalk.green(`Nudge fired — ${result.surfaced.length} item(s) surfaced.`));
        console.log(chalk.dim('\n' + (result.body ?? '')));
      } else {
        console.log(chalk.dim(`No nudge: ${result.reason ?? 'unknown'}`));
        if (result.surfaced.length > 0) {
          console.log(chalk.dim(`Would have surfaced ${result.surfaced.length} item(s).`));
        }
      }
    });

  return cmd;
}
