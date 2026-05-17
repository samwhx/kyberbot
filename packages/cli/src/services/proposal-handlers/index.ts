/**
 * Proposal action handlers (Phase 5)
 *
 * The pre-Phase-5 flow assumed every proposal was a *file edit*: parse a
 * unified diff out of the body, run `git apply`, commit. That's still
 * the path for personality_tweak / skill_revision / heartbeat_change /
 * identity_update / brain_note / file_edit.
 *
 * Phase 5 adds *action proposals* that don't touch the repo at all:
 *   email_draft       → Gmail API send
 *   calendar_action   → Google Calendar API insert/update
 *   external_send     → arbitrary webhook (future)
 *
 * Action handlers register themselves here. Each takes the (root,
 * proposal) and returns an ApplyResult-shaped object so the existing
 * approve/reject CLI keeps working unchanged.
 *
 * Hard-never rules still apply on top — the handler is responsible for
 * its own destination validation (e.g. an email_draft handler refuses
 * recipients on a blocklist). The proposal pipeline guarantees the
 * action only runs after human approval; it doesn't make the action
 * safe by itself.
 */

import type { Proposal } from '../proposals.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('proposal-handlers');

export interface HandlerResult {
  applied: boolean;
  reason?: string;
  /** Free-form artifact id (e.g. Gmail message id, Calendar event id). */
  artifact_id?: string;
}

export type Handler = (root: string, proposal: Proposal) => Promise<HandlerResult>;

const handlers = new Map<string, Handler>();

export function registerHandler(type: string, fn: Handler): void {
  handlers.set(type, fn);
}

export function getHandler(type: string): Handler | undefined {
  return handlers.get(type);
}

export function listRegisteredTypes(): string[] {
  return [...handlers.keys()].sort();
}

// ── Built-in handlers ───────────────────────────────────────────────────

import { applyEmailDraftProposal } from './email-draft.js';
import { applyCalendarActionProposal } from './calendar-action.js';

registerHandler('email_draft', applyEmailDraftProposal);
registerHandler('calendar_action', applyCalendarActionProposal);

logger.debug('Proposal handlers registered', { types: listRegisteredTypes() });
