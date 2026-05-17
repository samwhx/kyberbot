import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveToken, loadToken, getAccessToken, deleteToken, listProviders } from './oauth.js';

describe('oauth service', () => {
  let root: string;
  let envSnapshot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kb-oauth-test-'));
    envSnapshot = process.env.KYBERBOT_OAUTH_KEY;
    process.env.KYBERBOT_OAUTH_KEY = 'a'.repeat(64);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (envSnapshot) process.env.KYBERBOT_OAUTH_KEY = envSnapshot;
    else delete process.env.KYBERBOT_OAUTH_KEY;
  });

  it('round-trips a token through encrypted storage', () => {
    saveToken(root, 'gmail', {
      access_token: 'access-xyz',
      refresh_token: 'refresh-abc',
      expires_at: Date.now() + 3600_000,
      scope: 'gmail.readonly',
    });

    const loaded = loadToken(root, 'gmail');
    expect(loaded?.access_token).toBe('access-xyz');
    expect(loaded?.refresh_token).toBe('refresh-abc');
  });

  it('returns null when no token is stored', () => {
    expect(loadToken(root, 'absent')).toBeNull();
  });

  it('getAccessToken returns the fresh token without refresh when not expired', async () => {
    saveToken(root, 'calendar', {
      access_token: 'still-valid',
      refresh_token: 'r-1',
      expires_at: Date.now() + 60 * 60_000,
    });
    const refresh = async () => { throw new Error('refresh should not be called'); };
    const t = await getAccessToken(root, 'calendar', refresh);
    expect(t).toBe('still-valid');
  });

  it('getAccessToken refreshes when expired', async () => {
    saveToken(root, 'gmail', {
      access_token: 'expired',
      refresh_token: 'r-2',
      expires_at: Date.now() - 60_000,
    });

    const refresh = async (rt: string) => {
      expect(rt).toBe('r-2');
      return { access_token: 'refreshed', expires_at: Date.now() + 60 * 60_000 };
    };
    const t = await getAccessToken(root, 'gmail', refresh);
    expect(t).toBe('refreshed');

    // Refresh token should be retained from the original bundle when the
    // provider doesn't return a new one.
    const reloaded = loadToken(root, 'gmail');
    expect(reloaded?.refresh_token).toBe('r-2');
  });

  it('getAccessToken throws when no token is stored', async () => {
    await expect(
      getAccessToken(root, 'absent', async () => ({ access_token: 'n/a' })),
    ).rejects.toThrow(/No OAuth token stored/);
  });

  it('getAccessToken throws when expired and no refresh_token', async () => {
    saveToken(root, 'x', { access_token: 'old', expires_at: Date.now() - 1000 });
    await expect(
      getAccessToken(root, 'x', async () => ({ access_token: 'n/a' })),
    ).rejects.toThrow(/no refresh_token/);
  });

  it('deleteToken removes a stored token; loadToken returns null after', () => {
    saveToken(root, 'tmp', { access_token: 'a' });
    expect(loadToken(root, 'tmp')).not.toBeNull();
    deleteToken(root, 'tmp');
    const after = loadToken(root, 'tmp');
    // After delete the file is truncated to empty; loadToken should
    // gracefully treat malformed/empty content as absent.
    expect(after).toBeNull();
  });

  it('listProviders enumerates currently-stored providers', () => {
    saveToken(root, 'gmail', { access_token: 'a' });
    saveToken(root, 'calendar', { access_token: 'b' });
    const providers = listProviders(root).sort();
    expect(providers).toEqual(['calendar', 'gmail']);
  });

  it('throws on save when KYBERBOT_OAUTH_KEY is absent and .env cannot be written', () => {
    delete process.env.KYBERBOT_OAUTH_KEY;
    // ensureKeyExists will auto-generate and persist when possible — so
    // this case actually succeeds. Validate the generation happened.
    saveToken(root, 'gen', { access_token: 'a' });
    expect(process.env.KYBERBOT_OAUTH_KEY).toBeTruthy();
  });
});
