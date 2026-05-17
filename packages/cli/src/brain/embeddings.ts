/**
 * KyberBot — Embeddings Indexer
 *
 * Manages vector embeddings using ChromaDB for semantic search.
 * Uses OpenAI text-embedding-3-small for generating embeddings.
 *
 * ChromaDB must be running: docker-compose up -d
 */

import { ChromaClient, Collection, type IEmbeddingFunction } from 'chromadb';
import OpenAI from 'openai';
import { createLogger } from '../logger.js';
import { getIdentity, getIdentityForRoot } from '../config.js';
import { getEmbedder } from './embedders.js';

const logger = createLogger('embeddings');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DocumentMetadata {
  type: 'conversation' | 'idea' | 'file' | 'transcript' | 'note';
  source_path: string;
  title?: string;
  timestamp: string;
  entities?: string[];
  topics?: string[];
  summary?: string;
  // ── ARP unification (Phase A) — agent-resource metadata ─────────────
  // Mirrors the canonical AgentResourceMetadata vocabulary from
  // @kybernesis/arp-spec. Lets typed /api/arp/*.search and .query
  // handlers filter ChromaDB results at the metadata layer (fast,
  // pre-LLM) instead of post-filtering. ChromaDB metadata values are
  // scalars; tags_csv stores tags as a comma-separated string for
  // `where: { tags_csv: { $like: '%marketing%' } }` style queries.
  project_id?: string;
  tags_csv?: string;
  classification?: 'public' | 'internal' | 'confidential' | 'pii';
  connection_id?: string;
  source_did?: string;
}

export interface SearchResult {
  id: string;
  content: string;
  metadata: DocumentMetadata;
  distance: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Derive a per-agent ChromaDB collection name.
 * If root is given, uses getIdentityForRoot (multi-agent safe).
 * Falls back to getIdentity() or 'kyberbot_data'.
 */
function getCollectionNameForRoot(root?: string): string {
  // Embedder suffix lets us coexist multiple embedders (e.g. openai +
  // ollama) without dimension conflicts. Switching the embedder
  // creates a fresh empty collection rather than corrupting the
  // existing index.
  let embedderSuffix = '';
  try {
    const e = getEmbedder(root);
    if (e.name && e.name !== 'openai') {
      embedderSuffix = `_${e.name}`;
    }
  } catch {
    /* fall through */
  }

  try {
    const identity = root ? getIdentityForRoot(root) : getIdentity();
    if (identity.agent_name) {
      const sanitized = identity.agent_name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/^[^a-z0-9]+/, '')
        .replace(/[^a-z0-9]+$/, '');
      if (sanitized.length >= 1) {
        return `kyberbot_${sanitized}${embedderSuffix}`;
      }
    }
  } catch {
    // identity.yaml not available — use default
  }
  return `kyberbot_data${embedderSuffix}`;
}

const CONFIG = {
  CHUNK_SIZE: 300,
  CHUNK_OVERLAP: 75,
  MAX_RESULTS: 20,
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'text-embedding-3-large',
};

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTS (Lazy initialization)
// ═══════════════════════════════════════════════════════════════════════════════

// Shared clients (one connection regardless of how many agents)
let chromaClient: ChromaClient | null = null;
let openaiClient: OpenAI | null = null;
let chromaInitialized = false;
let chromaAvailable = false;

// Per-agent collections
const collections = new Map<string, Collection>();

export function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

async function generateEmbedding(text: string, root?: string): Promise<number[]> {
  const out = await getEmbedder(root).embed([text]);
  return out[0];
}

async function generateEmbeddings(texts: string[], root?: string): Promise<number[][]> {
  return getEmbedder(root).embed(texts);
}

export async function initializeEmbeddings(root?: string): Promise<boolean> {
  // If ChromaDB client not yet initialized, set it up
  if (!chromaInitialized) {
    chromaInitialized = true;

    // Embedder selection happens lazily in getEmbedder(); we just need
    // *some* embedder to be constructible. OpenAI requires a key;
    // Ollama needs a running daemon. Fail fast at boot if neither
    // works.
    let embedder;
    try {
      embedder = getEmbedder(root);
    } catch (err) {
      logger.warn('No embedder available — embeddings disabled', { error: String(err) });
      return false;
    }
    // OpenAI requires the key at boot — disable embeddings without it
    // to match pre-Phase-1.1 behaviour.
    if (embedder.name === 'openai' && !process.env.OPENAI_API_KEY) {
      logger.warn('OPENAI_API_KEY not set - embeddings disabled');
      return false;
    }

    logger.info('Initializing ChromaDB...');

    try {
      const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8001';
      chromaClient = new ChromaClient({ path: chromaUrl });
      await chromaClient.heartbeat();
      chromaAvailable = true;
      logger.info(`ChromaDB client connected`, { url: chromaUrl });
    } catch {
      logger.warn('ChromaDB not available - run: docker-compose up -d');
      chromaAvailable = false;
      return false;
    }
  }

  if (!chromaAvailable || !chromaClient) return false;

  // Initialize per-agent collection if root is given and not yet loaded
  if (root && !collections.has(root)) {
    try {
      const adapterEmbedder: IEmbeddingFunction = {
        generate: async (texts: string[]): Promise<number[][]> => {
          return generateEmbeddings(texts, root);
        },
      };

      const collectionName = getCollectionNameForRoot(root);
      const col = await chromaClient.getOrCreateCollection({
        name: collectionName,
        embeddingFunction: adapterEmbedder,
        metadata: {
          description: 'KyberBot semantic search index',
          // ChromaDB HNSW config (Phase 1.6). 'cosine' was already set;
          // M and ef params bumped from defaults so search stays
          // sub-second past the 10k-vector mark. Construction is one-
          // time; query-time effort is bounded by ef:search.
          'hnsw:space': 'cosine',
          'hnsw:M': 32,
          'hnsw:construction_ef': 200,
          'hnsw:search_ef': 100,
        },
      });

      const count = await col.count();
      logger.info(`ChromaDB collection ready`, { collection: collectionName, documents: count });
      collections.set(root, col);
    } catch (error) {
      logger.error('Failed to initialize collection', { error: String(error) });
    }
  } else if (!root && collections.size === 0) {
    // Backward compat: no root given, use legacy getCollectionName
    try {
      const adapterEmbedder: IEmbeddingFunction = {
        generate: async (texts: string[]): Promise<number[][]> => {
          return generateEmbeddings(texts, root);
        },
      };

      const collectionName = getCollectionNameForRoot();
      const col = await chromaClient.getOrCreateCollection({
        name: collectionName,
        embeddingFunction: adapterEmbedder,
        metadata: {
          description: 'KyberBot semantic search index',
          // ChromaDB HNSW config (Phase 1.6). 'cosine' was already set;
          // M and ef params bumped from defaults so search stays
          // sub-second past the 10k-vector mark. Construction is one-
          // time; query-time effort is bounded by ef:search.
          'hnsw:space': 'cosine',
          'hnsw:M': 32,
          'hnsw:construction_ef': 200,
          'hnsw:search_ef': 100,
        },
      });

      const count = await col.count();
      logger.info(`ChromaDB connected`, { collection: collectionName, documents: count });
      collections.set('__default__', col);
    } catch (error) {
      logger.error('Failed to initialize default collection', { error: String(error) });
    }
  }

  return true;
}

export function isChromaAvailable(): boolean {
  return chromaAvailable;
}

/**
 * Get the active per-agent collection name (for the *currently configured*
 * embedder). Surface so callers can ask "what collection am I writing to
 * right now?" without re-importing the internal namer.
 */
export function getActiveCollectionName(root?: string): string {
  return getCollectionNameForRoot(root);
}

/**
 * Reindex every document in a source ChromaDB collection into a
 * destination collection, re-running embedding via whatever embedder
 * the destination was created with. Reads in pages so large stores
 * don't blow the heap; reports progress via the callback.
 *
 * Typical use case: switching embedders (e.g. OpenAI → Ollama) creates
 * a fresh empty collection — this fills it from the previous one so
 * search still hits historical conversations.
 */
export async function reindexCollection(
  sourceName: string,
  destName: string,
  opts: {
    batchSize?: number;
    onProgress?: (state: { copied: number; total: number; batch: number }) => void;
    dryRun?: boolean;
  } = {},
): Promise<{ copied: number; total: number; skipped: number }> {
  if (!chromaClient) {
    // Force init by touching the singleton. Pass a synthetic root that
    // produces the same default behaviour as a normal startup.
    await initializeEmbeddings();
  }
  if (!chromaClient) throw new Error('ChromaDB client not available');

  const batchSize = opts.batchSize ?? 50;

  // For SOURCE we don't need to embed anything (we're just reading). A
  // no-op embedding function avoids the JS client's default
  // openai-text-embedding-ada-002 placeholder, which would try to
  // resolve an OpenAI key we may have removed.
  const noopEmbedder: IEmbeddingFunction = {
    generate: async () => { throw new Error('source collection should never embed'); },
  };

  const source = await chromaClient.getCollection({ name: sourceName, embeddingFunction: noopEmbedder });
  const total = await source.count();
  if (total === 0) {
    return { copied: 0, total: 0, skipped: 0 };
  }

  // DEST uses the agent's configured embedder so add() will auto-embed
  // via Ollama / OpenAI / whatever is current.
  const destEmbedder: IEmbeddingFunction = {
    generate: async (texts: string[]) => generateEmbeddings(texts),
  };
  const dest = await chromaClient.getOrCreateCollection({
    name: destName,
    embeddingFunction: destEmbedder,
    metadata: {
      description: 'KyberBot semantic search index',
      'hnsw:space': 'cosine',
      'hnsw:M': 32,
      'hnsw:construction_ef': 200,
      'hnsw:search_ef': 100,
    },
  });

  let copied = 0;
  let skipped = 0;
  let batch = 0;
  const existingIds = new Set<string>();

  // Capture the destination's existing ids so we don't duplicate on
  // resume. Cheap because dest is typically empty at start of reindex.
  if (!opts.dryRun) {
    try {
      const existing = await dest.get({ limit: 100_000 });
      if (existing.ids) for (const id of existing.ids) existingIds.add(id);
    } catch {
      // get() may fail on empty collections in some chroma versions — ignore.
    }
  }

  let offset = 0;
  while (offset < total) {
    const page = await source.get({ limit: batchSize, offset });
    if (!page.ids || page.ids.length === 0) break;

    const ids: string[] = [];
    const documents: string[] = [];
    const metadatas: Record<string, string | number | boolean>[] = [];

    for (let i = 0; i < page.ids.length; i++) {
      const id = page.ids[i];
      if (existingIds.has(id)) { skipped++; continue; }
      const doc = (page.documents?.[i] ?? '') as string;
      if (!doc) { skipped++; continue; }
      ids.push(id);
      documents.push(doc);
      metadatas.push((page.metadatas?.[i] ?? {}) as Record<string, string | number | boolean>);
    }

    if (ids.length > 0 && !opts.dryRun) {
      await dest.add({ ids, documents, metadatas });
    }
    copied += ids.length;

    batch++;
    opts.onProgress?.({ copied, total, batch });
    offset += page.ids.length;
  }

  return { copied, total, skipped };
}

/**
 * Reset the embeddings singleton state so the next call to initializeEmbeddings()
 * will re-establish connections. Used by the benchmark harness to reset between
 * conversations after deleting the ChromaDB collection.
 */
export function resetEmbeddings(root?: string): void {
  if (root) {
    collections.delete(root);
  } else {
    chromaClient = null;
    openaiClient = null;
    collections.clear();
    chromaInitialized = false;
    chromaAvailable = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEXT CHUNKING
// ═══════════════════════════════════════════════════════════════════════════════

interface TextChunk {
  text: string;
  index: number;
}

function chunkText(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = '';
  let chunkIndex = 0;

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > CONFIG.CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push({ text: currentChunk.trim(), index: chunkIndex++ });

      // Keep overlap
      const words = currentChunk.split(' ');
      const overlapWords = words.slice(-Math.floor(CONFIG.CHUNK_OVERLAP / 5));
      currentChunk = overlapWords.join(' ') + ' ' + sentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push({ text: currentChunk.trim(), index: chunkIndex });
  }

  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDEXING
// ═══════════════════════════════════════════════════════════════════════════════

export async function indexDocument(
  root: string,
  id: string,
  content: string,
  metadata: DocumentMetadata
): Promise<number> {
  if (!chromaInitialized) {
    await initializeEmbeddings(root);
  }

  const collection = collections.get(root) || collections.get('__default__');
  if (!chromaAvailable || !collection) {
    logger.debug(`Skipping indexing (ChromaDB not available): ${id}`);
    return 0;
  }

  if (!content || content.trim().length < 10) {
    logger.debug(`Skipping empty document: ${id}`);
    return 0;
  }

  const chunks = chunkText(content);
  logger.info(`Indexing document: ${id} (${chunks.length} chunks)`);

  try {
    // Generate embeddings for all chunks
    const embeddings = await generateEmbeddings(chunks.map((c) => c.text), root);

    const ids: string[] = [];
    const documents: string[] = [];
    const metadatas: Record<string, string | number>[] = [];

    for (let i = 0; i < chunks.length; i++) {
      ids.push(`${id}_chunk_${chunks[i].index}`);
      documents.push(chunks[i].text);
      // ── ARP unification (Phase A) — pass through agent-resource ──────
      // metadata fields when the producer set them. Empty string is the
      // ChromaDB-friendly null (avoids `undefined` filter issues) but
      // typed handlers SHOULD use `where: {project_id: 'alpha'}` not
      // `where: {project_id: ''}` for the unscoped lookup.
      const arpMeta: Record<string, string | number> = {};
      if (metadata.project_id) arpMeta['project_id'] = metadata.project_id;
      if (metadata.tags_csv) arpMeta['tags_csv'] = metadata.tags_csv;
      if (metadata.classification) arpMeta['classification'] = metadata.classification;
      if (metadata.connection_id) arpMeta['connection_id'] = metadata.connection_id;
      if (metadata.source_did) arpMeta['source_did'] = metadata.source_did;

      metadatas.push({
        type: metadata.type,
        source_path: metadata.source_path,
        title: metadata.title || '',
        timestamp: metadata.timestamp,
        chunk_index: chunks[i].index,
        parent_id: id,
        entities: metadata.entities?.join(',') || '',
        topics: metadata.topics?.join(',') || '',
        summary: metadata.summary || '',
        ...arpMeta,
      });
    }

    await collection.upsert({
      ids,
      documents,
      embeddings,
      metadatas,
    });

    logger.info(`Indexed: ${id} (${chunks.length} chunks)`);
    return chunks.length;
  } catch (error) {
    logger.error(`Failed to index ${id}`, { error: String(error) });
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

export async function semanticSearch(
  root: string,
  query: string,
  options: {
    limit?: number;
    type?: DocumentMetadata['type'];
    // ── ARP unification (Phase A/B) — metadata filters ────────────
    // Applied at the ChromaDB `where:` layer so out-of-scope chunks
    // are excluded BEFORE the result set leaves the vector store.
    // Defense in depth: cloud PDP gates whether the query happens;
    // these filters guarantee the result set stays scoped.
    project_id?: string;
    classification?: DocumentMetadata['classification'];
    connection_id?: string;
  } = {}
): Promise<SearchResult[]> {
  if (!chromaInitialized) {
    await initializeEmbeddings(root);
  }

  const collection = collections.get(root) || collections.get('__default__');
  if (!chromaAvailable || !collection) {
    logger.warn('Semantic search not available - ChromaDB not connected');
    return [];
  }

  const limit = options.limit || CONFIG.MAX_RESULTS;
  logger.info(`Searching: "${query}" (limit: ${limit})`);

  try {
    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(query, root);

    // Build where filter — combine type + ARP metadata filters into a
    // single $and clause when more than one is set. ChromaDB requires
    // the $and operator for multi-condition filters.
    const conditions: Array<Record<string, unknown>> = [];
    if (options.type) conditions.push({ type: options.type });
    if (options.project_id) conditions.push({ project_id: options.project_id });
    if (options.classification) conditions.push({ classification: options.classification });
    if (options.connection_id) conditions.push({ connection_id: options.connection_id });
    const whereFilter =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? (conditions[0] as Record<string, string>)
          : { $and: conditions } as unknown as Record<string, string>;

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: whereFilter,
    });

    const searchResults: SearchResult[] = [];

    if (results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const id = results.ids[0][i];
        const document = results.documents?.[0]?.[i];
        const metadata = results.metadatas?.[0]?.[i] as Record<string, unknown> | undefined;
        const distance = results.distances?.[0]?.[i];

        if (document && metadata) {
          const parentId = (metadata.parent_id as string) || id;
          searchResults.push({
            id: parentId,
            content: document,
            metadata: {
              type: metadata.type as DocumentMetadata['type'],
              source_path: metadata.source_path as string,
              title: metadata.title as string,
              timestamp: metadata.timestamp as string,
              entities: metadata.entities ? (metadata.entities as string).split(',').filter(Boolean) : undefined,
              topics: metadata.topics ? (metadata.topics as string).split(',').filter(Boolean) : undefined,
            },
            distance: distance || 0,
          });
        }
      }
    }

    logger.info(`Found ${searchResults.length} results for "${query}"`);
    return searchResults;
  } catch (error) {
    logger.error('Search failed', { error: String(error) });
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getIndexStats(root?: string): Promise<{
  totalChunks: number;
  available: boolean;
}> {
  if (!chromaInitialized) {
    await initializeEmbeddings(root);
  }

  const collection = root ? collections.get(root) : (collections.get('__default__') || collections.values().next().value);
  if (!chromaAvailable || !collection) {
    return { totalChunks: 0, available: false };
  }

  const count = await collection.count();
  return { totalChunks: count, available: true };
}
