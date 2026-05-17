/**
 * KyberBot — OAuth token store
 *
 * Generic OAuth 2.0 token persistence + refresh-loop infrastructure.
 * Used by every 3rd-party API skill (Gmail, Google Calendar, future
 * Slack/Notion/Linear/etc.). Tokens are encrypted at rest with a
 * per-agent key derived from .env so a backup tarball doesn't leak
 * live credentials.
 *
 * Designed to NOT require a specific OAuth client library. Callers
 * implement provider-specific endpoints (auth URL, token exchange,
 * refresh) and hand us the resulting token bundle to store. We hand
 * back a fresh access_token, transparently refreshing if needed.
 *
 * Disk layout:
 *   data/oauth/<provider>.json    — encrypted token bundle
 *   .env (KYBERBOT_OAUTH_KEY)     — 32-byte hex encryption key
 *                                   (auto-generated on first use)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createLogger } from '../logger.js';

const logger = createLogger('oauth');

export interface OAuthTokenBundle {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  /** Unix epoch milliseconds when access_token expires. */
  expires_at?: number;
  /** Provider-specific scope string (space-separated). */
  scope?: string;
  /** Provider-specific extras (id_token, account email, etc.). */
  extras?: Record<string, unknown>;
}

export type RefreshFn = (refreshToken: string) => Promise<OAuthTokenBundle>;

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const fromEnv = process.env.KYBERBOT_OAUTH_KEY;
  if (fromEnv && fromEnv.length >= 32) {
    // Hex-encoded 32-byte key (64 hex chars). Tolerate longer strings
    // — we'll truncate to 32 bytes via scrypt below.
    return scryptSync(fromEnv, 'kyberbot-oauth', 32);
  }
  throw new Error(
    'KYBERBOT_OAUTH_KEY not set. Generate one with `openssl rand -hex 32` ' +
    'and add it to .env before using OAuth-backed skills.',
  );
}

function ensureKeyExists(envPath: string): void {
  if (process.env.KYBERBOT_OAUTH_KEY) return;
  // Auto-generate one and write to .env so the user doesn't need to.
  const key = randomBytes(32).toString('hex');
  process.env.KYBERBOT_OAUTH_KEY = key;
  try {
    const line = `KYBERBOT_OAUTH_KEY=${key}\n`;
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      if (!/^KYBERBOT_OAUTH_KEY=/m.test(content)) {
        appendFileSync(envPath, (content.endsWith('\n') ? '' : '\n') + line);
        logger.info('Generated KYBERBOT_OAUTH_KEY and appended to .env');
      }
    } else {
      writeFileSync(envPath, line);
      logger.info('Generated KYBERBOT_OAUTH_KEY and wrote .env');
    }
  } catch (err) {
    logger.warn('Could not persist KYBERBOT_OAUTH_KEY to .env (in-process only)', { error: String(err) });
  }
}

function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // base64(iv) . base64(tag) . base64(ciphertext)
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(packed: string): string {
  const key = getKey();
  const [ivB64, tagB64, encB64] = packed.split('.');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('Malformed OAuth ciphertext');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
  return dec.toString('utf-8');
}

function providerPath(root: string, provider: string): string {
  return join(root, 'data', 'oauth', `${provider}.json`);
}

function ensureOAuthDir(root: string): void {
  const dir = join(root, 'data', 'oauth');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Persist a token bundle for a provider. Overwrites the existing one.
 */
export function saveToken(root: string, provider: string, bundle: OAuthTokenBundle): void {
  ensureKeyExists(join(root, '.env'));
  ensureOAuthDir(root);
  const ciphertext = encrypt(JSON.stringify(bundle));
  writeFileSync(providerPath(root, provider), ciphertext, 'utf-8');
  logger.info('OAuth token saved', { provider });
}

/**
 * Load the stored bundle for a provider. Returns null if absent.
 */
export function loadToken(root: string, provider: string): OAuthTokenBundle | null {
  const path = providerPath(root, provider);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(decrypt(raw)) as OAuthTokenBundle;
  } catch (err) {
    logger.warn('Failed to read OAuth token; treating as absent', { provider, error: String(err) });
    return null;
  }
}

/**
 * Get a valid access_token, refreshing transparently if necessary.
 * The provider-specific refresh function is supplied by the caller
 * (Gmail/Calendar both use Google's token endpoint; Slack/Notion
 * would use their own).
 *
 * Throws if no token is stored or refresh fails.
 */
export async function getAccessToken(
  root: string,
  provider: string,
  refresh: RefreshFn,
  skewMs = 60_000,
): Promise<string> {
  const bundle = loadToken(root, provider);
  if (!bundle) {
    throw new Error(`No OAuth token stored for ${provider}. Run \`kyberbot ${provider} auth\` first.`);
  }

  const now = Date.now();
  const stillFresh = bundle.expires_at != null && bundle.expires_at - skewMs > now;
  if (stillFresh) return bundle.access_token;

  if (!bundle.refresh_token) {
    throw new Error(`Stored ${provider} token has expired and no refresh_token is available.`);
  }

  logger.info('Refreshing OAuth token', { provider });
  const fresh = await refresh(bundle.refresh_token);
  const merged: OAuthTokenBundle = {
    ...bundle,
    ...fresh,
    refresh_token: fresh.refresh_token ?? bundle.refresh_token,
  };
  saveToken(root, provider, merged);
  return merged.access_token;
}

/**
 * Drop the stored bundle for a provider (e.g. for `auth --reset`).
 */
export function deleteToken(root: string, provider: string): boolean {
  const path = providerPath(root, provider);
  if (!existsSync(path)) return false;
  try {
    writeFileSync(path, '', 'utf-8'); // truncate so the file is gone-ish
    logger.info('OAuth token cleared', { provider });
    return true;
  } catch (err) {
    logger.warn('Failed to clear OAuth token', { provider, error: String(err) });
    return false;
  }
}

/**
 * List providers we have stored tokens for (for `kyberbot oauth list`).
 */
export function listProviders(root: string): string[] {
  const dir = join(root, 'data', 'oauth');
  if (!existsSync(dir)) return [];
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
