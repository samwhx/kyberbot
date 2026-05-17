/**
 * KyberBot — Embedder adapters
 *
 * One canonical interface for vector embedding generation, with two
 * adapters: OpenAIEmbedder (cloud, default) and OllamaEmbedder (local
 * via http://localhost:11434).
 *
 * Selected via identity.yaml:
 *
 *   brain:
 *     embedder: openai | ollama
 *     embedding_model: text-embedding-3-small | nomic-embed-text | ...
 *     ollama_endpoint: http://localhost:11434
 *
 * Default is openai. Switching the embedder is a config-only change;
 * the existing ChromaDB collection will continue to serve queries
 * against the OLD vectors, but new writes use the new embedder. To get
 * a clean uniform store after a switch, delete the collection and
 * re-index. Collection name is suffixed with the embedder name so
 * different embedders can coexist (e.g. kyberbot_alfred_openai vs
 * kyberbot_alfred_ollama).
 */

import OpenAI from 'openai';
import { createLogger } from '../logger.js';
import { getIdentityForRoot, getIdentity } from '../config.js';

const logger = createLogger('embedder');

export interface Embedder {
  readonly name: string;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

// ─────────────────────────────────────────────────────────────────────────
// OpenAI adapter
// ─────────────────────────────────────────────────────────────────────────

export class OpenAIEmbedder implements Embedder {
  readonly name = 'openai';
  readonly model: string;
  private client: OpenAI | null = null;

  constructor(model = 'text-embedding-3-large') {
    this.model = model;
  }

  private getClient(): OpenAI {
    if (this.client) return this.client;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    this.client = new OpenAI({ apiKey });
    return this.client;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.getClient().embeddings.create({ model: this.model, input: texts });
    return res.data.map((d) => d.embedding);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Ollama adapter
// ─────────────────────────────────────────────────────────────────────────

export class OllamaEmbedder implements Embedder {
  readonly name = 'ollama';
  readonly model: string;
  readonly endpoint: string;

  constructor(model = 'nomic-embed-text', endpoint = 'http://localhost:11434') {
    this.model = model;
    this.endpoint = endpoint.replace(/\/+$/, '');
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    // Ollama's /api/embeddings is single-input; batch by issuing per-text
    // requests. For low-volume sleep/write paths this is fine.
    for (const text of texts) {
      const res = await fetch(`${this.endpoint}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) {
        throw new Error(`Ollama embed failed: HTTP ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as { embedding?: number[]; error?: string };
      if (!json.embedding) {
        throw new Error(`Ollama embed returned no embedding: ${json.error ?? 'unknown'}`);
      }
      out.push(json.embedding);
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────

const embedders = new Map<string, Embedder>();

/**
 * Return (cached) embedder for an agent root. Picks adapter + model
 * from identity.yaml, falling back to OpenAI text-embedding-3-large.
 * Cached per-root so we don't reconstruct on every call.
 */
export function getEmbedder(root?: string): Embedder {
  const cacheKey = root ?? '__default__';
  const existing = embedders.get(cacheKey);
  if (existing) return existing;

  let kind: 'openai' | 'ollama' = 'openai';
  let model: string | undefined;
  let endpoint: string | undefined;
  try {
    const identity = root ? getIdentityForRoot(root) : getIdentity();
    kind = identity.brain?.embedder ?? 'openai';
    model = identity.brain?.embedding_model;
    endpoint = identity.brain?.ollama_endpoint;
  } catch {
    /* fall back to defaults */
  }

  // Env override remains a backstop (legacy behaviour)
  const envModel = process.env.EMBEDDING_MODEL;

  const embedder: Embedder = kind === 'ollama'
    ? new OllamaEmbedder(model ?? envModel ?? 'nomic-embed-text', endpoint)
    : new OpenAIEmbedder(model ?? envModel ?? 'text-embedding-3-large');

  logger.info('Embedder selected', { root: cacheKey, kind: embedder.name, model: embedder.model });
  embedders.set(cacheKey, embedder);
  return embedder;
}

/**
 * For tests / forced re-init.
 */
export function resetEmbedderCache(): void {
  embedders.clear();
}
