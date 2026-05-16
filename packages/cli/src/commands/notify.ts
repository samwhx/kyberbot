import { Command } from 'commander';
import chalk from 'chalk';
import { getServerPort } from '../config.js';

interface NotifyOptions {
  channel?: 'whatsapp' | 'telegram';
}

async function handleNotify(text: string, opts: NotifyOptions): Promise<void> {
  if (!text || !text.trim()) {
    console.error(chalk.red('notify: message is required'));
    process.exit(1);
  }

  const port = getServerPort();
  const token = process.env.KYBERBOT_API_TOKEN;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const body: Record<string, unknown> = { message: text };
  if (opts.channel) body.channel = opts.channel;

  let res: Response;
  try {
    res = await fetch(`http://localhost:${port}/api/web/manage/notify`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(chalk.red(`notify: cannot reach kyberbot server on :${port} — ${String(err)}`));
    process.exit(2);
  }

  const payload = await res.json().catch(() => ({} as Record<string, unknown>));

  if (!res.ok) {
    console.error(chalk.red(`notify: ${res.status} ${(payload as any).error ?? 'unknown error'}`));
    if ((payload as any).primaryReason) {
      console.error(chalk.dim(`  primary: ${(payload as any).primaryReason}`));
    }
    if ((payload as any).fallbackReason) {
      console.error(chalk.dim(`  fallback: ${(payload as any).fallbackReason}`));
    }
    process.exit(3);
  }

  const data = payload as { type?: string; target?: string; fallback?: boolean; primaryReason?: string };
  if (data.fallback) {
    console.log(chalk.yellow(`sent via ${data.type} (fallback — primary: ${data.primaryReason})`));
  } else {
    console.log(chalk.green(`sent via ${data.type}`));
  }
}

export function createNotifyCommand(): Command {
  return new Command('notify')
    .description('Send a message via the configured notification channel (whatsapp or telegram)')
    .argument('<text>', 'The message to send')
    .option('-c, --channel <name>', 'Override channel: whatsapp | telegram')
    .action(handleNotify);
}
