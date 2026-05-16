/**
 * KyberBot — Channel Conversation History
 *
 * Maintains a rolling buffer of recent messages per conversation so
 * messaging channels (Telegram, WhatsApp) are stateful. The history
 * is prepended to each prompt so Claude has context from prior exchanges.
 *
 * History lives in memory — it persists across messages within a session
 * but resets on restart. Long-term memory is handled by storeConversation()
 * and the brain subsystems.
 */

import { createLogger } from '../../logger.js';

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

/**
 * Add a user message to the conversation history.
 */
export function pushUserMessage(conversationId: string, content: string): void {
  const history = getOrCreateHistory(conversationId);
  history.push({ role: 'user', content, timestamp: Date.now() });
  trim(conversationId);
}

/**
 * Add an assistant response to the conversation history.
 */
export function pushAssistantMessage(conversationId: string, content: string): void {
  const history = getOrCreateHistory(conversationId);
  history.push({ role: 'assistant', content, timestamp: Date.now() });
  trim(conversationId);
}

/**
 * Render just the <conversation_history>...</conversation_history> block for
 * a conversation — empty string if nothing recent. Callers compose this with
 * other prompt sections (per-turn context, quoted messages, user message)
 * when they need finer control than `buildPromptWithHistory` gives.
 *
 * The block has no trailing newline; callers add separators as needed.
 */
export function buildHistoryBlock(conversationId: string): string {
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
