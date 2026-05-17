/**
 * KyberBot — Channel Conversation History
 *
 * Maintains a rolling buffer of recent messages per conversation so
 * messaging channels (Telegram, WhatsApp) are stateful. The history
 * is prepended to each prompt so Claude has context from prior exchanges.
 *
 * Backed by an in-memory Map for fast access on the hot path, with
 * write-through persistence to messages.db once the channel module calls
 * `enableHistoryPersistence(root)`. On the first read or push for a
 * given conversation after agent restart, the buffer is hydrated from
 * disk so prior exchanges aren't lost.
 *
 * Long-term memory (semantic + entity graph) is still handled by
 * storeConversation() and the brain subsystems — this layer is just for
 * the rolling per-conversation transcript.
 */

import { createLogger } from '../../logger.js';
import { saveMessage, getRecentMessagesForSession } from '../../brain/messages.js';

const logger = createLogger('history');

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

const MAX_ENTRIES = 40;        // 20 exchanges (user + assistant each)
const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours — older messages are stale

// Per-conversation histories, keyed by a stable identifier (chat ID, JID, etc.)
const histories = new Map<string, HistoryEntry[]>();

// Persistence config — set once per process by the channel runtime.
// When set, every push is written through to messages.db, and a
// conversation is lazily hydrated from disk on first read.
let persistenceRoot: string | null = null;
const hydratedConversations = new Set<string>();

/**
 * Enable write-through persistence to messages.db for all subsequent
 * pushes and lazy-hydrate on first read. Called once during channel
 * runtime startup so the rolling history survives agent restarts.
 */
export function enableHistoryPersistence(root: string): void {
  persistenceRoot = root;
  logger.info('Channel history persistence enabled', { root });
}

/**
 * Hydrate a conversation's rolling buffer from messages.db if it hasn't
 * been hydrated yet in this process. Safe to call repeatedly — does
 * nothing after the first hydration. No-op when persistence is disabled.
 */
function ensureHydrated(conversationId: string): void {
  if (!persistenceRoot) return;
  if (hydratedConversations.has(conversationId)) return;
  hydratedConversations.add(conversationId);

  try {
    const since = Date.now() - MAX_AGE_MS;
    const rows = getRecentMessagesForSession(persistenceRoot, conversationId, since);
    if (rows.length === 0) return;

    const history = getOrCreateHistory(conversationId);
    // Splice disk-loaded rows in *front* of anything we may have already
    // pushed in-memory this session (shouldn't normally happen, but safe).
    const restored: HistoryEntry[] = rows
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({
        role: r.role as 'user' | 'assistant',
        content: r.content,
        timestamp: new Date(r.created_at).getTime(),
      }));
    history.unshift(...restored);
    trim(conversationId);
    logger.debug('Hydrated conversation from disk', { conversationId, restored: restored.length });
  } catch (err) {
    // Persistence is best-effort — never let it break the channel reply.
    logger.warn('Hydration failed; continuing with in-memory only', {
      conversationId,
      error: String(err),
    });
  }
}

function inferChannelFromConvoId(conversationId: string): string {
  const idx = conversationId.indexOf(':');
  return idx > 0 ? conversationId.slice(0, idx) : 'channel';
}

function writeThrough(conversationId: string, role: 'user' | 'assistant', content: string): void {
  if (!persistenceRoot) return;
  try {
    saveMessage(persistenceRoot, conversationId, role, content);
  } catch (err) {
    logger.warn('Write-through to messages.db failed; in-memory still updated', {
      conversationId,
      role,
      error: String(err),
    });
  }
}

/**
 * Add a user message to the conversation history.
 */
export function pushUserMessage(conversationId: string, content: string): void {
  ensureHydrated(conversationId);
  const history = getOrCreateHistory(conversationId);
  history.push({ role: 'user', content, timestamp: Date.now() });
  trim(conversationId);
  writeThrough(conversationId, 'user', content);
}

/**
 * Add an assistant response to the conversation history.
 */
export function pushAssistantMessage(conversationId: string, content: string): void {
  ensureHydrated(conversationId);
  const history = getOrCreateHistory(conversationId);
  history.push({ role: 'assistant', content, timestamp: Date.now() });
  trim(conversationId);
  writeThrough(conversationId, 'assistant', content);
}

// Channel marker reserved for use by future helpers that need to know
// where a stored session came from (Telegram vs WhatsApp). Kept here so
// the convention stays alongside its consumers.
void inferChannelFromConvoId;

/**
 * Render just the <conversation_history>...</conversation_history> block for
 * a conversation — empty string if nothing recent. Callers compose this with
 * other prompt sections (per-turn context, quoted messages, user message)
 * when they need finer control than `buildPromptWithHistory` gives.
 *
 * The block has no trailing newline; callers add separators as needed.
 */
export function buildHistoryBlock(conversationId: string): string {
  ensureHydrated(conversationId);
  const history = getOrCreateHistory(conversationId);
  const cutoff = Date.now() - MAX_AGE_MS;
  const recent = history.filter(e => e.timestamp >= cutoff);
  if (recent.length === 0) return '';

  const lines: string[] = ['<conversation_history>'];
  for (const entry of recent) {
    const tag = entry.role === 'user' ? 'user_message' : 'assistant_message';
    // Truncate long assistant responses in history to save context
    const content = entry.role === 'assistant' && entry.content.length > 500
      ? entry.content.slice(0, 497) + '...'
      : entry.content;
    lines.push(`<${tag}>${escapeForXml(content)}</${tag}>`);
  }
  lines.push('</conversation_history>');
  return lines.join('\n');
}

/**
 * Build a prompt that includes conversation history before the current message.
 * Returns the full prompt string to pass to the Agent SDK.
 *
 * User content is fenced inside <user_message> tags and assistant content in
 * <assistant_message> tags. The system prompt instructs the model to treat
 * tag contents as data, not instructions — partial mitigation for prompt
 * injection from messaging channels. (See server/channels/system-prompt.ts.)
 */
export function buildPromptWithHistory(conversationId: string, currentMessage: string): string {
  const historyBlock = buildHistoryBlock(conversationId);
  const lines: string[] = [];
  if (historyBlock) {
    lines.push(historyBlock);
    lines.push('');
  }
  lines.push(`<user_message>${escapeForXml(currentMessage)}</user_message>`);
  return lines.join('\n');
}

/**
 * Escape characters that would let user content close the surrounding tag.
 * Conservative — replace `<`, `>`, and `&` with their entity forms in user
 * input. Claude's tokenizer reads the entities fine.
 */
export function escapeForXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Get the number of entries in a conversation's history.
 */
export function getHistoryLength(conversationId: string): number {
  return histories.get(conversationId)?.length ?? 0;
}

/**
 * Clear history for a conversation (e.g., on /start).
 */
export function clearHistory(conversationId: string): void {
  histories.delete(conversationId);
}

function getOrCreateHistory(conversationId: string): HistoryEntry[] {
  let history = histories.get(conversationId);
  if (!history) {
    history = [];
    histories.set(conversationId, history);
  }
  return history;
}

function trim(conversationId: string): void {
  const history = histories.get(conversationId);
  if (!history) return;

  // Remove entries beyond max
  while (history.length > MAX_ENTRIES) {
    history.shift();
  }

  // Remove stale entries from the front
  const cutoff = Date.now() - MAX_AGE_MS;
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift();
  }
}
