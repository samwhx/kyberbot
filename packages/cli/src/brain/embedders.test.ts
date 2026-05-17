import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIEmbedder, OllamaEmbedder, getEmbedder, resetEmbedderCache } from './embedders.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Identity-config stubs swapped per test
const mockIdentity = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../config.js', () => ({
  getIdentity: () => mockIdentity.current,
  getIdentityForRoot: () => mockIdentity.current,
}));

describe('OllamaEmbedder', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('issues one POST per text to /api/embeddings', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body as string) });
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    }) as any;

    const e = new OllamaEmbedder('nomic-embed-text', 'http://localhost:11434');
    const out = await e.embed(['hello', 'world']);

    expect(out).toEqual([[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('http://localhost:11434/api/embeddings');
    expect(calls[0].body).toEqual({ model: 'nomic-embed-text', prompt: 'hello' });
    expect(calls[1].body).toEqual({ model: 'nomic-embed-text', prompt: 'world' });
  });

  it('throws when Ollama returns non-200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as any;
    const e = new OllamaEmbedder();
    await expect(e.embed(['x'])).rejects.toThrow(/HTTP 500/);
  });

  it('throws when response has no embedding field', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'model missing' }), { status: 200 })) as any;
    const e = new OllamaEmbedder();
    await expect(e.embed(['x'])).rejects.toThrow(/no embedding/i);
  });

  it('returns [] for empty input without calling fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    const e = new OllamaEmbedder();
    expect(await e.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips trailing slash from endpoint', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ embedding: [1] }), { status: 200 });
    }) as any;
    const e = new OllamaEmbedder('m', 'http://localhost:11434///');
    await e.embed(['t']);
    expect(calls[0]).toBe('http://localhost:11434/api/embeddings');
  });
});

describe('OpenAIEmbedder', () => {
  beforeEach(() => { delete process.env.OPENAI_API_KEY; });

  it('throws when OPENAI_API_KEY is unset', async () => {
    const e = new OpenAIEmbedder();
    await expect(e.embed(['x'])).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('returns [] for empty input without touching client', async () => {
    const e = new OpenAIEmbedder();
    expect(await e.embed([])).toEqual([]);
  });
});

describe('getEmbedder factory', () => {
  beforeEach(() => {
    resetEmbedderCache();
    mockIdentity.current = {};
  });

  it('returns OpenAIEmbedder by default', () => {
    const e = getEmbedder('/tmp/r1');
    expect(e.name).toBe('openai');
    expect(e.model).toBe('text-embedding-3-large');
  });

  it('returns OllamaEmbedder when identity says so', () => {
    mockIdentity.current = { brain: { embedder: 'ollama', embedding_model: 'mxbai-embed-large' } };
    const e = getEmbedder('/tmp/r2');
    expect(e.name).toBe('ollama');
    expect(e.model).toBe('mxbai-embed-large');
  });

  it('caches per-root', () => {
    const a = getEmbedder('/tmp/r3');
    const b = getEmbedder('/tmp/r3');
    expect(a).toBe(b);
  });

  it('honours custom ollama endpoint', () => {
    mockIdentity.current = { brain: { embedder: 'ollama', ollama_endpoint: 'http://192.168.1.50:11434' } };
    const e = getEmbedder('/tmp/r4') as OllamaEmbedder;
    expect(e.name).toBe('ollama');
    expect(e.endpoint).toBe('http://192.168.1.50:11434');
  });
});
