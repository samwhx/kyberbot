import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getColdDb,
  insertColdEvent,
  searchColdEvents,
  findColdEvent,
  deleteColdEvent,
  listColdFiles,
  getColdStats,
  resetColdStorage,
  type ColdEvent,
} from './cold-storage.js';

describe('cold-storage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kb-cold-test-'));
  });

  afterEach(() => {
    resetColdStorage();
    rmSync(root, { recursive: true, force: true });
  });

  function makeEvent(overrides: Partial<Omit<ColdEvent, 'archived_at'>> = {}): Omit<ColdEvent, 'archived_at'> {
    return {
      id: 1,
      type: 'conversation',
      timestamp: '2024-03-15T10:00:00Z',
      end_timestamp: null,
      title: 'Coffee with Janet',
      summary: 'Discussed Q2 budget',
      source_path: 'conv-1.md',
      entities_json: '["Janet","Q2"]',
      topics_json: '["budget"]',
      tags_json: '[]',
      priority: 0.3,
      decay_score: 0.7,
      last_accessed: null,
      access_count: 0,
      project_id: null,
      classification: null,
      connection_id: null,
      source_did: null,
      metrics_json: null,
      outcome: null,
      outcome_confidence: null,
      outcome_evidence: null,
      outcome_annotated_at: null,
      ...overrides,
    };
  }

  it('creates a cold DB per-month and indexes by year/month from timestamp', () => {
    insertColdEvent(root, makeEvent({ id: 1, timestamp: '2024-03-15T10:00:00Z' }));
    insertColdEvent(root, makeEvent({ id: 2, timestamp: '2024-04-02T08:00:00Z' }));
    insertColdEvent(root, makeEvent({ id: 3, timestamp: '2024-03-20T11:00:00Z' }));

    const files = listColdFiles(root);
    expect(files).toHaveLength(2);
    expect(files.map((f) => `${f.year}-${String(f.month).padStart(2, '0')}`)).toEqual(['2024-03', '2024-04']);

    const marchDb = getColdDb(root, 2024, 3);
    const marchCount = marchDb.prepare('SELECT COUNT(*) as c FROM cold_timeline_events').get() as { c: number };
    expect(marchCount.c).toBe(2);

    const aprilDb = getColdDb(root, 2024, 4);
    const aprilCount = aprilDb.prepare('SELECT COUNT(*) as c FROM cold_timeline_events').get() as { c: number };
    expect(aprilCount.c).toBe(1);
  });

  it('inserts are idempotent — INSERT OR IGNORE on primary key', () => {
    const e = makeEvent({ id: 42 });
    expect(insertColdEvent(root, e)).toBe(true);
    expect(insertColdEvent(root, e)).toBe(false);

    const stats = getColdStats(root);
    expect(stats.events).toBe(1);
  });

  it('searchColdEvents matches title/summary with LIKE across months', () => {
    insertColdEvent(root, makeEvent({ id: 1, title: 'Coffee with Janet', timestamp: '2024-03-01T00:00:00Z' }));
    insertColdEvent(root, makeEvent({ id: 2, title: 'Lunch with Bob', summary: 'Talked about Janet too', timestamp: '2024-04-01T00:00:00Z' }));
    insertColdEvent(root, makeEvent({ id: 3, title: 'Solo work', summary: 'Nothing relevant', timestamp: '2024-05-01T00:00:00Z' }));

    const results = searchColdEvents(root, 'janet');
    expect(results.map((r) => r.id).sort()).toEqual([1, 2]);

    const titleOnly = searchColdEvents(root, 'coffee');
    expect(titleOnly).toHaveLength(1);
    expect(titleOnly[0].id).toBe(1);
  });

  it('searchColdEvents respects after/before bounds', () => {
    insertColdEvent(root, makeEvent({ id: 1, title: 'Old talk', timestamp: '2024-01-15T00:00:00Z' }));
    insertColdEvent(root, makeEvent({ id: 2, title: 'New talk', timestamp: '2024-06-15T00:00:00Z' }));

    const recent = searchColdEvents(root, 'talk', { after: '2024-05-01T00:00:00Z' });
    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe(2);

    const old = searchColdEvents(root, 'talk', { before: '2024-02-01T00:00:00Z' });
    expect(old).toHaveLength(1);
    expect(old[0].id).toBe(1);
  });

  it('findColdEvent locates an event across cold DBs by id', () => {
    insertColdEvent(root, makeEvent({ id: 100, timestamp: '2024-03-01T00:00:00Z' }));
    insertColdEvent(root, makeEvent({ id: 200, timestamp: '2024-04-01T00:00:00Z' }));

    const result = findColdEvent(root, 200);
    expect(result).toBeTruthy();
    expect(result!.event.id).toBe(200);
    expect(result!.year).toBe(2024);
    expect(result!.month).toBe(4);

    expect(findColdEvent(root, 999)).toBeNull();
  });

  it('deleteColdEvent removes a row and getColdStats reflects it', () => {
    insertColdEvent(root, makeEvent({ id: 50, timestamp: '2024-03-01T00:00:00Z' }));
    expect(getColdStats(root).events).toBe(1);

    deleteColdEvent(root, 2024, 3, 50);
    expect(getColdStats(root).events).toBe(0);
  });

  it('skips invalid timestamps gracefully', () => {
    expect(insertColdEvent(root, makeEvent({ id: 1, timestamp: 'not-a-date' }))).toBe(false);
    expect(getColdStats(root).events).toBe(0);
  });
});
