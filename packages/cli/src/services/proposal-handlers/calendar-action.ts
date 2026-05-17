/**
 * calendar_action proposal handler.
 *
 * Body shape expected:
 *
 *   action: create | update | delete
 *   event_id: <existing event id for update/delete>     (optional)
 *   summary: Lunch with Janet
 *   start: 2026-06-04T12:00:00+08:00
 *   end:   2026-06-04T13:00:00+08:00
 *   location: Cafe X
 *   attendees: janet@example.com, bob@example.com
 *   ---
 *   <description body>
 *
 * Creates / updates / deletes a primary-calendar event via Google API.
 * The agent never auto-fires this — it lives in the proposal queue and
 * requires explicit human approval.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Proposal } from '../proposals.js';
import type { HandlerResult } from './index.js';
import { getAccessToken, type OAuthTokenBundle } from '../oauth.js';
import { httpPostJson, httpRequest } from '../../utils/http.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('proposal:calendar_action');

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

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

interface CalActionFields {
  action: 'create' | 'update' | 'delete';
  event_id?: string;
  summary?: string;
  start?: string;
  end?: string;
  location?: string;
  attendees?: string[];
  description?: string;
}

function parseCalendarBody(body: string): CalActionFields | null {
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

  const action = headers.action as CalActionFields['action'];
  if (action !== 'create' && action !== 'update' && action !== 'delete') return null;

  return {
    action,
    event_id: headers.event_id,
    summary: headers.summary,
    start: headers.start,
    end: headers.end,
    location: headers.location,
    attendees: headers.attendees ? headers.attendees.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    description: bodyText || undefined,
  };
}

export async function applyCalendarActionProposal(root: string, proposal: Proposal): Promise<HandlerResult> {
  const fields = parseCalendarBody(proposal.body);
  if (!fields) return { applied: false, reason: 'calendar_action body must start with action: create|update|delete + ---' };

  if (fields.action === 'create' && (!fields.summary || !fields.start || !fields.end)) {
    return { applied: false, reason: 'calendar_action create needs summary, start, end' };
  }
  if (fields.action !== 'create' && !fields.event_id) {
    return { applied: false, reason: `calendar_action ${fields.action} needs event_id` };
  }

  let token: string;
  try {
    token = await getAccessToken(root, 'calendar', (rt) => refreshGoogleToken(root, rt));
  } catch (err) {
    return { applied: false, reason: `OAuth token unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const auth = { Authorization: `Bearer ${token}` };

  try {
    if (fields.action === 'delete') {
      const res = await httpRequest(`${CAL_API}/calendars/primary/events/${fields.event_id}`, {
        method: 'DELETE',
        headers: auth,
        tag: 'proposal.calendar_action.delete',
      });
      if (!res.ok && res.status !== 410) {
        return { applied: false, reason: `Calendar delete failed: HTTP ${res.status}` };
      }
      logger.info('calendar_action delete applied', { proposalId: proposal.frontmatter.id, eventId: fields.event_id });
      return { applied: true, artifact_id: fields.event_id };
    }

    const payload: Record<string, unknown> = {};
    if (fields.summary) payload.summary = fields.summary;
    if (fields.start) payload.start = { dateTime: fields.start };
    if (fields.end) payload.end = { dateTime: fields.end };
    if (fields.location) payload.location = fields.location;
    if (fields.description) payload.description = fields.description;
    if (fields.attendees && fields.attendees.length > 0) payload.attendees = fields.attendees.map((email) => ({ email }));

    if (fields.action === 'create') {
      const created = await httpPostJson<{ id?: string }>(
        `${CAL_API}/calendars/primary/events`,
        payload,
        { headers: auth, tag: 'proposal.calendar_action.create' },
      );
      logger.info('calendar_action create applied', { proposalId: proposal.frontmatter.id, eventId: created.id });
      return { applied: true, artifact_id: created.id };
    }

    // update via PATCH
    const res = await httpRequest(`${CAL_API}/calendars/primary/events/${fields.event_id}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      tag: 'proposal.calendar_action.update',
    });
    if (!res.ok) return { applied: false, reason: `Calendar update failed: HTTP ${res.status}` };
    logger.info('calendar_action update applied', { proposalId: proposal.frontmatter.id, eventId: fields.event_id });
    return { applied: true, artifact_id: fields.event_id };
  } catch (err) {
    return { applied: false, reason: `Calendar API error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
