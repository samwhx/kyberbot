import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRoot } from '../config.js';
import { getAccessToken, deleteToken, loadToken, type OAuthTokenBundle } from '../services/oauth.js';
import { httpGetJson } from '../utils/http.js';
import { createLogger } from '../logger.js';

const logger = createLogger('calendar');
void logger;

const PROVIDER = 'calendar';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

interface GoogleCredentials { client_id: string; client_secret: string; redirect_uri?: string; }

function readGoogleCredentials(root: string): GoogleCredentials | null {
  const path = join(root, '.kyberbot', 'google-credentials.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.client_id && parsed.client_secret) return parsed;
    return null;
  } catch { return null; }
}

async function refreshGoogleToken(root: string, refresh_token: string): Promise<OAuthTokenBundle> {
  const creds = readGoogleCredentials(root);
  if (!creds) throw new Error('Missing .kyberbot/google-credentials.json — run `kyberbot gmail auth` first');
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
  if (!res.ok) throw new Error(`Calendar token refresh failed: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json() as Record<string, unknown>;
  return {
    access_token: String(json.access_token),
    refresh_token,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
  };
}

interface CalEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
  description?: string;
}

function parseStart(e: any): string {
  return e?.start?.dateTime ?? (e?.start?.date ? `${e.start.date}T00:00:00Z` : new Date().toISOString());
}
function parseEnd(e: any): string {
  return e?.end?.dateTime ?? (e?.end?.date ? `${e.end.date}T23:59:00Z` : '');
}

async function listEvents(root: string, daysAhead: number): Promise<CalEvent[]> {
  const token = await getAccessToken(root, PROVIDER, (rt) => refreshGoogleToken(root, rt));
  const now = new Date();
  const until = new Date(now.getTime() + daysAhead * 86_400_000);
  const url = `${CAL_API}/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${until.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=50`;
  const res = await httpGetJson<{ items?: any[] }>(url, {
    headers: { Authorization: `Bearer ${token}` }, tag: 'calendar.list',
  });
  return (res.items ?? []).map((e: any) => ({
    id: e.id,
    summary: e.summary ?? '(no title)',
    start: parseStart(e),
    end: parseEnd(e),
    location: e.location,
    attendees: (e.attendees ?? []).map((a: any) => a.email).filter(Boolean),
    description: e.description,
  }));
}

export function createCalendarCommand(): Command {
  const cmd = new Command('calendar').description('Read your Google Calendar (OAuth required; reuses `kyberbot gmail auth` token)');

  cmd
    .command('today')
    .description("Today's events")
    .option('--json', 'Output as JSON', false)
    .action(async (opts: { json: boolean }) => {
      const root = getRoot();
      try {
        const events = (await listEvents(root, 1)).filter((e) => new Date(e.start).toDateString() === new Date().toDateString());
        if (opts.json) {
          console.log(JSON.stringify(events, null, 2));
          return;
        }
        if (events.length === 0) {
          console.log(chalk.dim('No events today.'));
          return;
        }
        console.log(chalk.bold(`\n${events.length} event(s) today:\n`));
        for (const e of events) {
          const t = new Date(e.start);
          const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
          const loc = e.location ? chalk.dim(` @ ${e.location}`) : '';
          console.log(`  ${chalk.cyan(hhmm)}  ${e.summary}${loc}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Calendar today failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  cmd
    .command('week')
    .description('Events in the next 7 days')
    .option('--json', 'Output as JSON', false)
    .action(async (opts: { json: boolean }) => {
      const root = getRoot();
      try {
        const events = await listEvents(root, 7);
        if (opts.json) {
          console.log(JSON.stringify(events, null, 2));
          return;
        }
        if (events.length === 0) {
          console.log(chalk.dim('No events in the next 7 days.'));
          return;
        }
        console.log(chalk.bold(`\n${events.length} event(s) in next 7 days:\n`));
        let lastDate = '';
        for (const e of events) {
          const date = new Date(e.start).toDateString();
          if (date !== lastDate) {
            console.log(chalk.dim(`\n  ${date}`));
            lastDate = date;
          }
          const t = new Date(e.start);
          const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
          const loc = e.location ? chalk.dim(` @ ${e.location}`) : '';
          console.log(`     ${chalk.cyan(hhmm)}  ${e.summary}${loc}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Calendar week failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  cmd
    .command('status')
    .description('Whether Calendar OAuth is configured')
    .action(() => {
      const root = getRoot();
      const token = loadToken(root, PROVIDER);
      console.log(chalk.bold('\nCalendar status\n'));
      console.log(`  oauth token: ${token ? chalk.green('stored') : chalk.yellow('not authorised — run `kyberbot gmail auth`')}`);
      console.log('');
    });

  cmd
    .command('reset')
    .description('Forget the stored Calendar OAuth token')
    .action(() => {
      const root = getRoot();
      deleteToken(root, PROVIDER);
      console.log(chalk.green('Calendar token cleared.'));
    });

  return cmd;
}
