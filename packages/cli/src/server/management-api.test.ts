import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import type { Channel } from './channels/types.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Skills / agents loaders are touched by some endpoints but we don't test
// those here. Stub them so the router doesn't require real disk state.
vi.mock('../skills/loader.js', () => ({
  loadInstalledSkills: () => [],
  getSkill: () => null,
}));
vi.mock('../skills/scaffolder.js', () => ({ scaffoldSkill: vi.fn() }));
vi.mock('../skills/registry.js', () => ({ removeSkill: vi.fn(), rebuildClaudeMd: vi.fn() }));
vi.mock('../agents/loader.js', () => ({ loadInstalledAgents: () => [], getAgent: () => null }));
vi.mock('../agents/scaffolder.js', () => ({ scaffoldAgent: vi.fn() }));
vi.mock('../agents/registry.js', () => ({ removeAgent: vi.fn() }));
vi.mock('../agents/spawner.js', () => ({ buildSystemPrompt: vi.fn() }));
vi.mock('../config.js', () => ({ getClaudeModel: () => 'sonnet' }));

const { createManagementRouter } = await import('./management-api.js');

// ── Test fixture helpers ────────────────────────────────────────────────

interface MockChannelOpts {
  name: 'whatsapp' | 'telegram';
  connected?: boolean;
  send?: (to: string, message: string) => Promise<void>;
}

function makeMockChannel(opts: MockChannelOpts): Channel & { sendCalls: Array<{ to: string; message: string }> } {
  const sendCalls: Array<{ to: string; message: string }> = [];
  const channel: Channel & { sendCalls: typeof sendCalls } = {
    name: opts.name,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isConnected: () => opts.connected ?? true,
    onMessage: vi.fn(),
    send: async (to, message) => {
      sendCalls.push({ to, message });
      if (opts.send) await opts.send(to, message);
    },
    sendCalls,
  };
  return channel;
}

function createTestApp(channels: Channel[], identityYaml: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'kb-mgmt-api-test-'));
  writeFileSync(join(root, 'identity.yaml'), yaml.dump(identityYaml));

  const app = express();
  app.use(express.json());
  app.use('/', createManagementRouter(channels, root));
  return { app, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('management-api: GET /channels', () => {
  it('returns name/connected/verified for each channel', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: true });
    const tg = makeMockChannel({ name: 'telegram', connected: false });
    const { app, cleanup } = createTestApp([wa, tg], {});

    const res = await request(app).get('/channels');
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([
      { name: 'whatsapp', connected: true, verified: null },
      { name: 'telegram', connected: false, verified: null },
    ]);

    cleanup();
  });
});

describe('management-api: POST /channels/send', () => {
  it('400s when message is missing', async () => {
    const wa = makeMockChannel({ name: 'whatsapp' });
    const { app, cleanup } = createTestApp([wa], {});

    const res = await request(app).post('/channels/send').send({ type: 'whatsapp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/);
    cleanup();
  });

  it('404s when channel type is unknown', async () => {
    const { app, cleanup } = createTestApp([], {});
    const res = await request(app).post('/channels/send').send({ type: 'discord', message: 'hi' });
    expect(res.status).toBe(404);
    cleanup();
  });

  it('503s when channel is disconnected', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: false });
    const { app, cleanup } = createTestApp([wa], {});

    const res = await request(app).post('/channels/send').send({ type: 'whatsapp', message: 'hi', jid: '6500@s.whatsapp.net' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not connected/);
    cleanup();
  });

  it('uses owner_jid from identity.yaml when jid omitted for whatsapp', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: true });
    const { app, cleanup } = createTestApp([wa], {
      channels: { whatsapp: { owner_jid: '6500@s.whatsapp.net' } },
    });

    const res = await request(app).post('/channels/send').send({ type: 'whatsapp', message: 'hi' });
    expect(res.status).toBe(200);
    expect((wa as any).sendCalls).toEqual([{ to: '6500@s.whatsapp.net', message: 'hi' }]);
    cleanup();
  });

  it('400s when jid is missing and owner_jid is not in identity.yaml', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: true });
    const { app, cleanup } = createTestApp([wa], {});

    const res = await request(app).post('/channels/send').send({ type: 'whatsapp', message: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jid is required/);
    cleanup();
  });
});

describe('management-api: POST /notify', () => {
  it('routes to whatsapp by default when notification_channel unset', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: true });
    const tg = makeMockChannel({ name: 'telegram', connected: true });
    const { app, cleanup } = createTestApp([wa, tg], {
      channels: { whatsapp: { owner_jid: 'wa-target' }, telegram: { owner_chat_id: 12345 } },
    });

    const res = await request(app).post('/notify').send({ message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('whatsapp');
    expect((wa as any).sendCalls).toEqual([{ to: 'wa-target', message: 'hello' }]);
    expect((tg as any).sendCalls).toEqual([]);
    cleanup();
  });

  it('honours notification_channel: telegram', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: true });
    const tg = makeMockChannel({ name: 'telegram', connected: true });
    const { app, cleanup } = createTestApp([wa, tg], {
      notification_channel: 'telegram',
      channels: { whatsapp: { owner_jid: 'wa-target' }, telegram: { owner_chat_id: 99 } },
    });

    const res = await request(app).post('/notify').send({ message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('telegram');
    expect((tg as any).sendCalls).toEqual([{ to: '99', message: 'hello' }]);
    cleanup();
  });

  it('falls back to telegram when whatsapp is disconnected', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: false });
    const tg = makeMockChannel({ name: 'telegram', connected: true });
    const { app, cleanup } = createTestApp([wa, tg], {
      channels: { whatsapp: { owner_jid: 'wa-target' }, telegram: { owner_chat_id: 99 } },
    });

    const res = await request(app).post('/notify').send({ message: 'fallback' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('telegram');
    expect(res.body.fallback).toBe(true);
    expect(res.body.primaryReason).toMatch(/not connected/);
    cleanup();
  });

  it('503s when no channel is usable', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: false });
    const tg = makeMockChannel({ name: 'telegram', connected: false });
    const { app, cleanup } = createTestApp([wa, tg], {
      channels: { whatsapp: { owner_jid: 'wa-target' }, telegram: { owner_chat_id: 99 } },
    });

    const res = await request(app).post('/notify').send({ message: 'doomed' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/no usable notification channel/i);
    cleanup();
  });

  it('400s when message is missing', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: true });
    const { app, cleanup } = createTestApp([wa], { channels: { whatsapp: { owner_jid: 't' } } });

    const res = await request(app).post('/notify').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/);
    cleanup();
  });

  it('respects explicit channel override in request body', async () => {
    const wa = makeMockChannel({ name: 'whatsapp', connected: true });
    const tg = makeMockChannel({ name: 'telegram', connected: true });
    const { app, cleanup } = createTestApp([wa, tg], {
      // even though default is whatsapp, request asks for telegram
      channels: { whatsapp: { owner_jid: 'wa' }, telegram: { owner_chat_id: 7 } },
    });

    const res = await request(app).post('/notify').send({ message: 'hi', channel: 'telegram' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('telegram');
    cleanup();
  });
});
