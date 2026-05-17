import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { httpRequest, httpGetJson, httpPostJson, HttpTimeoutError } from './http.js';

describe('http client', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('attaches X-Request-Id header when none provided', async () => {
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      const reqId = new Headers(init?.headers ?? {}).get('X-Request-Id');
      expect(reqId).toBeTruthy();
      expect(reqId!.length).toBeGreaterThan(10);
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fetchMock as any;

    const res = await httpRequest('http://example.test/health');
    expect(res.status).toBe(200);
  });

  it('honours an explicit requestId', async () => {
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      const reqId = new Headers(init?.headers ?? {}).get('X-Request-Id');
      expect(reqId).toBe('req-fixed-123');
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fetchMock as any;

    await httpRequest('http://example.test/x', { requestId: 'req-fixed-123' });
  });

  it('throws HttpTimeoutError when AbortSignal fires', async () => {
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'TimeoutError';
          reject(err);
        });
      });
    }) as any;

    await expect(httpRequest('http://example.test/slow', { timeoutMs: 30, retry: { retries: 1 } })).rejects.toBeInstanceOf(HttpTimeoutError);
  });

  it('httpGetJson parses 2xx body and throws on non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    const out = await httpGetJson<{ a: number }>('http://example.test/data');
    expect(out).toEqual({ a: 1 });

    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as any;
    await expect(httpGetJson('http://example.test/missing', { retry: { retries: 1 } })).rejects.toThrow(/404/);
  });

  it('httpPostJson sets Content-Type and serializes body', async () => {
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(init?.body).toBe(JSON.stringify({ msg: 'hi' }));
      return new Response(JSON.stringify({ echoed: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    globalThis.fetch = fetchMock as any;

    const out = await httpPostJson<{ echoed: boolean }>('http://example.test/send', { msg: 'hi' });
    expect(out.echoed).toBe(true);
  });
});
