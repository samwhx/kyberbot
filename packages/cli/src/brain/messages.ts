/**
 * KyberBot — Message Persistence
 *
 * Stores web chat messages in SQLite for session persistence.
 * Each session is a conversation with a unique ID, containing
 * ordered user and assistant messages.
 */

import Database from 'libsql';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../logger.js';
import { openWithRecovery } from './db-recovery.js';
import { applyMigrations, addColumnIfMissing, type Migration } from './db-migrate.js';

const logger = createLogger('messages');

const databases = new Map<string, Database.Database>();

/**
 * Reset the messages DB connection(s). If root is given, closes only that
 * root's connection. If no root, closes all.
 */
export function resetMessagesDb(root?: string): void {
  if (root) {
    const existing = databases.get(root);
    if (existing) {
      try { existing.close(); } catch { /* ignore */ }
      databases.delete(root);
    }
  } else {
    for (const [, conn] of databases) {
      try { conn.close(); } catch { /* ignore */ }
    }
    databases.clear();
  }
}

function ensureDatabase(root: string): Database.Database {
  const existing = databases.get(root);
  if (existing) return existing;

  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  const newDbPath = join(dataDir, 'messages.db');
  const newDb = openWithRecovery(newDbPath);
  newDb.pragma('journal_mode = WAL');

  applyMigrations(newDb, 'messages', MESSAGES_MIGRATIONS);

  databases.set(root, newDb);
  logger.info('Messages database initialized', { path: newDbPath });
  return newDb;
}

/**
 * Force-initialize the messages DB (runs pending migrations) and return
 * the underlying connection. Mostly for the `kyberbot agent migrate`
 * command and tests; regular code paths go through the higher-level
 * helpers (`createSession`, `saveMessage`, etc.) which call ensureDatabase
 * themselves.
 */
export function getMessagesDb(root: string): Database.Database {
  return ensureDatabase(root);
}

const MESSAGES_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'base schema — sessions + messages',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL DEFAULT 'web',
          title TEXT,
          claude_session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          tool_calls_json TEXT,
          memory_updates_json TEXT,
          usage_json TEXT,
          cost_usd REAL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      `);
      // claude_session_id was added to fresh schemas later but is also part
      // of v1 for back-compat with the pre-framework codepath.
      addColumnIfMissing(db, 'sessions', 'claude_session_id', 'TEXT');
    },
  },
  {
    version: 2,
    description: 'ARP unification — session project_id, tags_json, classification, connection_id, source_did',
    up: (db) => {
      addColumnIfMissing(db, 'sessions', 'project_id', 'TEXT');
      addColumnIfMissing(db, 'sessions', 'tags_json', "TEXT DEFAULT '[]'");
      addColumnIfMissing(db, 'sessions', 'classification', 'TEXT');
      addColumnIfMissing(db, 'sessions', 'connection_id', 'TEXT');
      addColumnIfMissing(db, 'sessions', 'source_did', 'TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_connection ON sessions(connection_id);
      `);
    },
  },
];

export interface StoredMessage {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls_json: string | null;
  memory_updates_json: string | null;
  usage_json: string | null;
  cost_usd: number | null;
  created_at: string;
}

export interface SessionSummary {
  id: string;
  channel: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/**
 * Create a new session.
 */
export function createSession(root: string, sessionId: string, channel = 'web'): void {
  const database = ensureDatabase(root);
  const now = new Date().toISOString();
  database.prepare(
    `INSERT OR IGNORE INTO sessions (id, channel, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run(sessionId, channel, now, now);
}

/**
 * Save a message to a session.
 */
export function saveMessage(
  root: string,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  opts?: {
    toolCalls?: unknown[];
    memoryUpdates?: string[];
    usage?: { inputTokens: number; outputTokens: number };
    costUsd?: number;
  },
): number {
  const database = ensureDatabase(root);
  const now = new Date().toISOString();

  // Ensure session exists
  createSession(root, sessionId);

  const result = database.prepare(
    `INSERT INTO messages (session_id, role, content, tool_calls_json, memory_updates_json, usage_json, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    role,
    content,
    opts?.toolCalls ? JSON.stringify(opts.toolCalls) : null,
    opts?.memoryUpdates ? JSON.stringify(opts.memoryUpdates) : null,
    opts?.usage ? JSON.stringify(opts.usage) : null,
    opts?.costUsd ?? null,
    now,
  );

  // Update session title (from first user message) and timestamp
  const titleUpdate = role === 'user'
    ? database.prepare(`UPDATE sessions SET title = COALESCE(title, ?), updated_at = ? WHERE id = ?`)
    : database.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`);

  if (role === 'user') {
    titleUpdate.run(content.slice(0, 100), now, sessionId);
  } else {
    titleUpdate.run(now, sessionId);
  }

  return result.lastInsertRowid as number;
}

/**
 * Get messages for a session.
 */
export function getSessionMessages(root: string, sessionId: string): StoredMessage[] {
  const database = ensureDatabase(root);
  return database.prepare(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`
  ).all(sessionId) as StoredMessage[];
}

/**
 * Return messages for a session that are newer than `sinceMs` epoch ms.
 * Used by conversation-history to rehydrate the in-memory rolling buffer
 * on agent restart so channel conversations survive across reboots.
 *
 * Returns oldest → newest, ready to push into the in-memory map in order.
 */
export function getRecentMessagesForSession(
  root: string,
  sessionId: string,
  sinceMs: number,
): StoredMessage[] {
  const database = ensureDatabase(root);
  const sinceIso = new Date(sinceMs).toISOString();
  return database.prepare(
    `SELECT * FROM messages
     WHERE session_id = ? AND created_at >= ?
     ORDER BY created_at ASC`,
  ).all(sessionId, sinceIso) as StoredMessage[];
}

/**
 * List recent sessions.
 */
export function listSessions(root: string, limit = 20): SessionSummary[] {
  const database = ensureDatabase(root);
  return database.prepare(
    `SELECT s.*, COUNT(m.id) as message_count
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id
     GROUP BY s.id
     ORDER BY s.updated_at DESC
     LIMIT ?`
  ).all(limit) as SessionSummary[];
}

/**
 * Get the Claude Code session ID for a web session (for --resume).
 */
export function getClaudeSessionId(root: string, sessionId: string): string | null {
  const database = ensureDatabase(root);
  const row = database.prepare(
    `SELECT claude_session_id FROM sessions WHERE id = ?`
  ).get(sessionId) as { claude_session_id: string | null } | undefined;
  return row?.claude_session_id ?? null;
}

/**
 * Store the Claude Code session ID for a web session.
 */
export function setClaudeSessionId(root: string, sessionId: string, claudeSessionId: string): void {
  const database = ensureDatabase(root);
  database.prepare(
    `UPDATE sessions SET claude_session_id = ? WHERE id = ?`
  ).run(claudeSessionId, sessionId);
}

/**
 * Get the most recent session ID for a channel, or null if none.
 */
export function getLatestSessionId(root: string, channel = 'web'): string | null {
  const database = ensureDatabase(root);
  const row = database.prepare(
    `SELECT id FROM sessions WHERE channel = ? ORDER BY updated_at DESC LIMIT 1`
  ).get(channel) as { id: string } | undefined;
  return row?.id ?? null;
}
