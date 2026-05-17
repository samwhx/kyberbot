import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRoot } from '../config.js';
import {
  saveToken,
  getAccessToken,
  deleteToken,
  loadToken,
  type OAuthTokenBundle,
} from '../services/oauth.js';
import { httpGetJson, httpPostJson } from '../utils/http.js';
import { createLogger } from '../logger.js';

const logger = createLogger('gmail');

// Provider constants. Gmail + Calendar share the Google OAuth root.
const PROVIDER = 'gmail';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

interface GoogleCredentials {
  client_id: string;
  client_secret: string;
  /** Default: http://localhost:8765 — the auth subcommand spins up a tiny
   *  loopback listener here to capture the redirect code. */
  redirect_uri?: string;
}

function readGoogleCredentials(root: string): GoogleCredentials | null {
  const path = join(root, '.kyberbot', 'google-credentials.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.client_id && parsed.client_secret) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function refreshGoogleToken(root: string, refresh_token: string): Promise<OAuthTokenBundle> {
  const creds = readGoogleCredentials(root);
  if (!creds) throw new Error('Missing .kyberbot/google-credentials.json — run `kyberbot gmail auth --help`');

  const params = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token,
    grant_type: 'refresh_token',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json() as Record<string, unknown>;
  return {
    access_token: String(json.access_token),
    refresh_token,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    token_type: typeof json.token_type === 'string' ? json.token_type : undefined,
  };
}

async function getGmailToken(root: string): Promise<string> {
  return getAccessToken(root, PROVIDER, (rt) => refreshGoogleToken(root, rt));
}

interface ThreadSummary {
  id: string;
  subject: string;
  snippet: string;
  from: string;
  unread: boolean;
  timestamp: string;
}

async function listRecentThreads(root: string, days: number): Promise<ThreadSummary[]> {
  const token = await getGmailToken(root);
  const sinceSeconds = Math.floor(Date.now() / 1000) - days * 86_400;
  const list = await httpGetJson<{ threads?: Array<{ id: string }> }>(
    `${GMAIL_API}/users/me/threads?q=${encodeURIComponent(`after:${sinceSeconds}`)}&maxResults=50`,
    { headers: { Authorization: `Bearer ${token}` }, tag: 'gmail.list' },
  );
  if (!list.threads || list.threads.length === 0) return [];

  const summaries: ThreadSummary[] = [];
  for (const t of list.threads) {
    try {
      const thread = await httpGetJson<{
        messages?: Array<{
          id: string;
          internalDate?: string;
          labelIds?: string[];
          snippet?: string;
          payload?: { headers?: Array<{ name: string; value: string }> };
        }>;
      }>(`${GMAIL_API}/users/me/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, {
        headers: { Authorization: `Bearer ${token}` }, tag: 'gmail.thread',
      });
      const first = thread.messages?.[0];
      if (!first) continue;
      const headers = first.payload?.headers ?? [];
      const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(no subject)';
      const from = headers.find((h) => h.name === 'From')?.value ?? 'unknown';
      const unread = thread.messages!.some((m) => m.labelIds?.includes('UNREAD'));
      const ts = first.internalDate ? new Date(Number(first.internalDate)).toISOString() : '';
      summaries.push({ id: t.id, subject, snippet: first.snippet ?? '', from, unread, timestamp: ts });
    } catch (err) {
      logger.warn('Failed to fetch thread metadata', { id: t.id, error: String(err) });
    }
  }
  return summaries;
}

function draftsDir(root: string): string {
  const dir = join(root, 'brain', 'drafts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDraft(root: string, id: string, threadId: string, body: string, subject: string): string {
  const path = join(draftsDir(root), `${id}.md`);
  const content = [
    '---',
    `id: ${id}`,
    `thread_id: ${threadId}`,
    `subject: ${JSON.stringify(subject)}`,
    `created_at: ${new Date().toISOString()}`,
    `status: pending`,
    '---',
    '',
    body,
    '',
  ].join('\n');
  writeFileSync(path, content, 'utf-8');
  return path;
}

export function createGmailCommand(): Command {
  const cmd = new Command('gmail').description('Read, draft, and send Gmail (OAuth required)');

  cmd
    .command('auth')
    .description('Walk through Google OAuth setup for Gmail + Calendar')
    .action(() => {
      const root = getRoot();
      console.log(chalk.bold('\nGmail / Calendar OAuth setup\n'));
      console.log('1. Create a Google Cloud project: https://console.cloud.google.com/');
      console.log('2. Enable APIs: Gmail API and Google Calendar API.');
      console.log('3. Create OAuth credentials → Desktop application.');
      console.log('4. Download credentials JSON. Save the client_id and client_secret to:');
      console.log(chalk.dim(`     ${join(root, '.kyberbot', 'google-credentials.json')}`));
      console.log('   Format: { "client_id": "...", "client_secret": "..." }');
      console.log('5. Visit the OAuth consent URL printed below in your browser.');
      console.log('6. Copy the code Google returns and paste it as the FIRST positional arg here:');
      console.log(chalk.dim(`     kyberbot gmail auth-finish <code>`));
      console.log('');
      const creds = readGoogleCredentials(root);
      if (!creds) {
        console.log(chalk.yellow('No google-credentials.json found yet — step 4 first.'));
        return;
      }
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', creds.client_id);
      url.searchParams.set('redirect_uri', creds.redirect_uri ?? 'urn:ietf:wg:oauth:2.0:oob');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('scope', [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
      ].join(' '));
      console.log(chalk.green('Consent URL:'));
      console.log('  ' + url.toString());
    });

  cmd
    .command('auth-finish <code>')
    .description('Exchange a Google OAuth code for tokens (run after `gmail auth`)')
    .action(async (code: string) => {
      const root = getRoot();
      const creds = readGoogleCredentials(root);
      if (!creds) {
        console.error(chalk.red('Missing .kyberbot/google-credentials.json — run `kyberbot gmail auth` first'));
        process.exit(1);
      }
      const params = new URLSearchParams({
        code,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        redirect_uri: creds.redirect_uri ?? 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'authorization_code',
      });
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      if (!res.ok) {
        console.error(chalk.red(`Token exchange failed: HTTP ${res.status} ${await res.text()}`));
        process.exit(1);
      }
      const json = await res.json() as Record<string, unknown>;
      saveToken(root, PROVIDER, {
        access_token: String(json.access_token),
        refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
        expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
        scope: typeof json.scope === 'string' ? json.scope : undefined,
        token_type: typeof json.token_type === 'string' ? json.token_type : undefined,
      });
      // Calendar reuses the same Google token bundle but stored under
      // its own provider key so the two skills are decoupled.
      saveToken(root, 'calendar', {
        access_token: String(json.access_token),
        refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
        expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
      });
      console.log(chalk.green('Stored gmail + calendar OAuth tokens.'));
    });

  cmd
    .command('recent')
    .description('Summarize recent Gmail threads')
    .option('--days <n>', 'How many days back to scan', '7')
    .option('--json', 'Output as JSON', false)
    .action(async (opts: { days: string; json: boolean }) => {
      const root = getRoot();
      const days = Number(opts.days);
      if (!Number.isFinite(days) || days < 1) {
        console.error(chalk.red('--days must be a positive number'));
        process.exit(1);
      }
      try {
        const threads = await listRecentThreads(root, days);
        if (opts.json) {
          console.log(JSON.stringify(threads, null, 2));
          return;
        }
        if (threads.length === 0) {
          console.log(chalk.dim(`No threads in the last ${days} days.`));
          return;
        }
        console.log(chalk.bold(`\n${threads.filter((t) => t.unread).length} unread / ${threads.length} total threads in last ${days} days:\n`));
        for (const t of threads) {
          const flag = t.unread ? chalk.yellow('●') : ' ';
          const from = t.from.replace(/<.*>/, '').trim().slice(0, 30);
          console.log(`  ${flag} ${chalk.dim(t.timestamp.slice(0, 10))}  ${chalk.cyan(from.padEnd(30))}  ${t.subject.slice(0, 60)}`);
          if (t.snippet) console.log(chalk.dim(`     ${t.snippet.slice(0, 100)}`));
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Gmail recent failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  cmd
    .command('draft <thread-id> <body...>')
    .description('Save a draft reply for review (writes to brain/drafts/)')
    .action((threadId: string, body: string[]) => {
      const root = getRoot();
      const id = `gmail-${Date.now().toString(36)}`;
      const fullBody = body.join(' ');
      const path = writeDraft(root, id, threadId, fullBody, '(reply)');
      console.log(chalk.green(`Draft ${id} saved.`));
      console.log(chalk.dim(`  ${path}`));
      console.log(chalk.dim(`  Send with: kyberbot gmail send ${id}`));
    });

  cmd
    .command('send <draft-id>')
    .description('Send a saved draft via Gmail')
    .action(async (draftId: string) => {
      const root = getRoot();
      const path = join(draftsDir(root), `${draftId}.md`);
      if (!existsSync(path)) {
        console.error(chalk.red(`Draft not found: ${draftId}`));
        process.exit(1);
      }
      const content = readFileSync(path, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!fmMatch) {
        console.error(chalk.red(`Draft ${draftId} has no frontmatter`));
        process.exit(1);
      }
      const frontmatter = Object.fromEntries(
        fmMatch[1].split('\n').map((l) => {
          const i = l.indexOf(':');
          return i === -1 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')];
        }),
      ) as Record<string, string>;
      const body = fmMatch[2].trim();

      if (frontmatter.status === 'sent') {
        console.error(chalk.yellow(`Draft ${draftId} already marked sent — refusing to re-send.`));
        process.exit(1);
      }
      if (!frontmatter.thread_id) {
        console.error(chalk.red(`Draft missing thread_id — manual send only`));
        process.exit(1);
      }

      try {
        const token = await getGmailToken(root);
        const raw = Buffer.from(
          `Subject: ${frontmatter.subject || 'Re:'}\r\n` +
          `Content-Type: text/plain; charset="UTF-8"\r\n` +
          `\r\n` + body,
        ).toString('base64url');
        await httpPostJson(`${GMAIL_API}/users/me/messages/send`, { raw, threadId: frontmatter.thread_id }, {
          headers: { Authorization: `Bearer ${token}` }, tag: 'gmail.send',
        });
        // Mark draft as sent
        writeFileSync(path, content.replace(/^status: pending$/m, `status: sent\nsent_at: ${new Date().toISOString()}`));
        console.log(chalk.green(`Draft ${draftId} sent.`));
      } catch (err) {
        console.error(chalk.red(`Gmail send failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  cmd
    .command('status')
    .description('Show whether Gmail OAuth is configured')
    .action(() => {
      const root = getRoot();
      const creds = readGoogleCredentials(root);
      const token = loadToken(root, PROVIDER);
      console.log(chalk.bold('\nGmail status\n'));
      console.log(`  credentials.json: ${creds ? chalk.green('present') : chalk.yellow('missing')}`);
      console.log(`  oauth token:      ${token ? chalk.green('stored') : chalk.yellow('not authorised')}`);
      if (token?.expires_at) {
        const exp = new Date(token.expires_at);
        console.log(chalk.dim(`     expires ${exp.toISOString()}`));
      }
      console.log('');
    });

  cmd
    .command('reset')
    .description('Forget the stored Gmail OAuth token')
    .action(() => {
      const root = getRoot();
      const removed = deleteToken(root, PROVIDER);
      console.log(removed ? chalk.green('Cleared gmail token.') : chalk.yellow('No gmail token was stored.'));
    });

  return cmd;
}
