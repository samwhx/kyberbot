import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, writeFileSync, existsSync } from 'fs';

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { getEntityGraphDb } = await import('../../entity-graph.js');
const { runSynthesizeWikiStep } = await import('./synthesize-wiki.js');
const { DEFAULT_CONFIG } = await import('../config.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-wiki-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedEntity(name: string, opts: Partial<{ type: string; mention_count: number; is_pinned: number; first_seen: string; last_seen: string }> = {}): Promise<number> {
  const db = await getEntityGraphDb(root);
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO entities (name, normalized_name, type, first_seen, last_seen, mention_count, is_pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, name.toLowerCase(), opts.type ?? 'person', opts.first_seen ?? now, opts.last_seen ?? now, opts.mention_count ?? 5, opts.is_pinned ?? 0);
  return result.lastInsertRowid as number;
}

async function seedRelation(a: number, b: number, relationship: string, edge_type: string): Promise<void> {
  const db = await getEntityGraphDb(root);
  db.prepare(`
    INSERT INTO entity_relations (source_id, target_id, relationship, strength, confidence, edge_type)
    VALUES (?, ?, ?, 1, 0.8, ?)
  `).run(a, b, relationship, edge_type);
}

beforeEach(async () => {
  const db = await getEntityGraphDb(root);
  db.exec('DELETE FROM entity_relations; DELETE FROM entity_mentions; DELETE FROM entities;');
  await rm(join(root, 'brain', 'wiki'), { recursive: true, force: true });
});

describe('synthesize-wiki', () => {
  it('creates a page for an entity with mention_count >= 5', async () => {
    await seedEntity('Janet', { mention_count: 7 });
    const result = await runSynthesizeWikiStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);

    const page = join(root, 'brain', 'wiki', 'entities', 'janet.md');
    expect(existsSync(page)).toBe(true);
    const content = readFileSync(page, 'utf-8');
    expect(content).toContain('# Janet');
    expect(content).toContain('alfred:autogen:start');
    expect(content).toContain('alfred:autogen:end');
  });

  it('creates a project-folder page for type=project', async () => {
    await seedEntity('Atlas Kitchen', { type: 'project', mention_count: 10 });
    await runSynthesizeWikiStep(root, DEFAULT_CONFIG);
    expect(existsSync(join(root, 'brain', 'wiki', 'projects', 'atlas-kitchen.md'))).toBe(true);
  });

  it('respects is_pinned even when mention_count is low', async () => {
    await seedEntity('Tiny', { mention_count: 1, is_pinned: 1 });
    const result = await runSynthesizeWikiStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);
    expect(existsSync(join(root, 'brain', 'wiki', 'entities', 'tiny.md'))).toBe(true);
  });

  it('skips entities below threshold and not pinned', async () => {
    await seedEntity('Quiet', { mention_count: 2, is_pinned: 0 });
    const result = await runSynthesizeWikiStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(existsSync(join(root, 'brain', 'wiki', 'entities', 'quiet.md'))).toBe(false);
  });

  it('preserves human edits outside autogen markers on refresh', async () => {
    const id = await seedEntity('Bob', { mention_count: 6 });

    // First pass — creates the page.
    await runSynthesizeWikiStep(root, DEFAULT_CONFIG);
    const path = join(root, 'brain', 'wiki', 'entities', 'bob.md');
    let content = readFileSync(path, 'utf-8');

    // Prepend a human note above the autogen block.
    const humanPreface = '> Human note: Bob owes me a coffee.\n\n';
    writeFileSync(path, humanPreface + content, 'utf-8');

    // Bump last_seen so the next pass actually re-synthesises.
    const db = await getEntityGraphDb(root);
    db.prepare('UPDATE entities SET last_seen = ? WHERE id = ?').run(new Date(Date.now() + 1000).toISOString(), id);

    // Second pass should keep the human preface and refresh the autogen body.
    await runSynthesizeWikiStep(root, DEFAULT_CONFIG);
    content = readFileSync(path, 'utf-8');
    expect(content.startsWith('> Human note: Bob owes me a coffee.')).toBe(true);
    expect(content).toContain('alfred:autogen:start');
  });

  it('renders relations grouped by edge_type', async () => {
    const a = await seedEntity('Cause', { mention_count: 6 });
    const b = await seedEntity('Effect', { mention_count: 6 });
    await seedRelation(a, b, 'caused', 'causal');

    await runSynthesizeWikiStep(root, DEFAULT_CONFIG);
    const causeContent = readFileSync(join(root, 'brain', 'wiki', 'entities', 'cause.md'), 'utf-8');
    expect(causeContent).toContain('## How this came about');
    expect(causeContent).toContain('[[Effect]]');
    expect(causeContent).toContain('`caused`');
  });

  it('writes an index.md listing every page', async () => {
    await seedEntity('A', { mention_count: 5 });
    await seedEntity('B', { mention_count: 5, type: 'project' });
    await runSynthesizeWikiStep(root, DEFAULT_CONFIG);

    const indexPath = join(root, 'brain', 'wiki', 'index.md');
    expect(existsSync(indexPath)).toBe(true);
    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('[A](entities/a.md)');
    expect(content).toContain('[B](projects/b.md)');
  });

  it('skips re-synthesis when last_seen has not changed', async () => {
    await seedEntity('Stable', { mention_count: 6, last_seen: new Date('2020-01-01T00:00:00Z').toISOString() });
    await runSynthesizeWikiStep(root, DEFAULT_CONFIG);
    const second = await runSynthesizeWikiStep(root, DEFAULT_CONFIG);
    expect(second.count).toBe(0);
    expect(second.skippedFresh).toBeGreaterThanOrEqual(1);
  });
});
