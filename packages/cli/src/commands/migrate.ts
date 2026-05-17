import { Command } from 'commander';
import chalk from 'chalk';
import { getRoot } from '../config.js';
import { applyAllPendingMigrations } from '../brain/migrate-all.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migrate');

/**
 * Apply pending SQLite migrations to every brain store. Each store self-
 * migrates on first connection open (the migrations are wired into
 * bootstrap), so this command's job is to force-open each connection and
 * report the resulting version. Idempotent — safe to run on every
 * startup or by hand.
 */
async function handleMigrate(): Promise<void> {
  const root = getRoot();
  console.log(chalk.dim(`Migrating brain stores in ${root}/data/`));
  console.log('');

  let reports;
  try {
    reports = await applyAllPendingMigrations(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Migration failed', { error: msg });
    console.log(chalk.red(`✗ Migration failed: ${msg}`));
    process.exit(1);
  }

  for (const r of reports) {
    console.log(`  ${chalk.green('✓')} ${r.name.padEnd(14)} ${chalk.dim(`at v${r.version}`)}`);
  }
  console.log('');
  console.log(chalk.green('All stores up to date.'));
}

export function createMigrateCommand(): Command {
  return new Command('migrate')
    .description('Apply pending SQLite schema migrations to every brain store')
    .action(handleMigrate);
}
