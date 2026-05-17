/**
 * email_draft proposal handler.
 *
 * Body shape expected:
 *
 *   thread_id: <gmail thread id>          (optional but strongly preferred)
 *   to: someone@example.com               (required if no thread_id)
 *   subject: Re: budget thread
 *   ---
 *   <draft body>
 *
 * On apply: send via Gmail API, using the stored gmail OAuth token.
 * Hard-never destinations are caller-defined (see EMAIL_BLOCKLIST below);
 * keep it tight — this is an autonomous outbound action.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Proposal } from '../proposals.js';
import type { HandlerResult } from './index.js';
import { getAccessToken, type OAuthTokenBundle } from '../oauth.js';
import { httpPostJson } from '../../utils/http.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('proposal:email_draft');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const EMAIL_BLOCKLIST: RegExp[] = [
  // No autosend to whole-domain wildcards
  /@.*\b(no-reply|noreply|donotreply)@/i,
  // No autosend to mailing lists or list managers
  /\b(list|listserv|mailman|sympa)@/i,
];

function readGoogleCredentials(root: string): { client_id: string; client_secret: string } | null {
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
  if (!creds) throw new Error('Missing google-credentials.json');
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
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status}`);
  const json = await res.json() as Record<string, unknown>;
  return {
    access_token: String(json.access_token),
    refresh_token,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
  };
}

interface EmailDraftFields {
  thread_id?: string;
  to?: string;
  subject?: string;
  body: string;
}

function parseEmailDraftBody(body: string): EmailDraftFields | null {
  // Split on first --- line: header lines : value, body below.
  const idx = body.indexOf('\n---\n');
  if (idx === -1) return null;
  const headerLines = body.slice(0, idx).split('\n');
  const bodyText = body.slice(idx + 5).trim();

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key) headers[key] = value;
  }

  if (!bodyText) return null;
  return {
    thread_id: headers.thread_id,
    to: headers.to,
    subject: headers.subject,
    body: bodyText,
  };
}

export async function applyEmailDraftProposal(root: string, proposal: Proposal): Promise<HandlerResult> {
  const fields = parseEmailDraftBody(proposal.body);
  if (!fields) {
    return { applied: false, reason: 'email_draft body is missing header block / --- / body' };
  }
  if (!fields.thread_id && !fields.to) {
    return { applied: false, reason: 'email_draft needs at least thread_id or to' };
  }

  if (fields.to) {
    for (const re of EMAIL_BLOCKLIST) {
      if (re.test(fields.to)) {
        return { applied: false, reason: `recipient ${fields.to} matches a hard-never blocklist pattern` };
      }
    }
  }

  let token: string;
  try {
    token = await getAccessToken(root, 'gmail', (rt) => refreshGoogleToken(root, rt));
  } catch (err) {
    return { applied: false, reason: `OAuth token unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const subject = fields.subject ?? 'Re:';
  const headerLines = [
    fields.to ? `To: ${fields.to}` : null,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean).join('\r\n');
  const raw = Buffer.from(`${headerLines}\r\n\r\n${fields.body}`).toString('base64url');

  try {
    const sent = await httpPostJson<{ id?: string; threadId?: string }>(
      `${GMAIL_API}/users/me/messages/send`,
      { raw, ...(fields.thread_id ? { threadId: fields.thread_id } : {}) },
      { headers: { Authorization: `Bearer ${token}` }, tag: 'proposal.email_draft.send' },
    );
    logger.info('email_draft proposal sent', { proposalId: proposal.frontmatter.id, messageId: sent.id });
    return { applied: true, artifact_id: sent.id };
  } catch (err) {
    return { applied: false, reason: `Gmail send failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
