/**
 * Synthesize-wiki step (Phase 3.2)
 *
 * Produces a human-readable, human-correctable knowledge layer:
 *
 *   brain/wiki/
 *     entities/<slug>.md       — one page per significant entity
 *     projects/<slug>.md       — pages for entities with type='project'
 *     timelines/<period>.md    — weekly/monthly rollups (reserved; not
 *                                generated in this initial pass)
 *     index.md                 — autogen directory of every wiki page
 *
 * Selection: entities with mention_count >= 5 OR is_pinned. Re-runs
 * each cycle for entities whose last_seen has changed since the page
 * was last synthesised.
 *
 * Human edits are preserved between `<!-- alfred:autogen:start -->`
 * and `<!-- alfred:autogen:end -->` markers. Everything outside those
 * markers is left untouched on refresh — so you can hand-annotate the
 * top of any page and the next sleep cycle won't overwrite your
 * notes.
 *
 * No LLM call yet — the v1 narrative is a structured render of the
 * data we already have (mentions, relations, causal/temporal edges).
 * Upgrading to an LLM-written narrative is a future drop-in; the
 * autogen-marker contract stays the same so existing pages keep
 * their human-edited prefaces.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../../logger.js';
import { getEntityGraphDb } from '../../entity-graph.js';
import { getSleepDb } from '../db.js';
import { SleepConfig } from '../config.js';

const logger = createLogger('sleep:synthesize-wiki');

const AUTOGEN_START = '<!-- alfred:autogen:start -->';
const AUTOGEN_END = '<!-- alfred:autogen:end -->';

export interface SynthesizeWikiResult {
  count: number;          // pages written/refreshed
  processed: number;      // entities considered
  skippedFresh: number;   // already up-to-date
  errors: string[];
}

interface EntityRow {
  id: number;
  name: string;
  normalized_name: string;
  type: 'person' | 'company' | 'project' | 'place' | 'topic';
  mention_count: number;
  is_pinned: number | null;
  first_seen: string;
  last_seen: string;
}

interface RelationRow {
  related_id: number;
  related_name: string;
  related_type: string;
  relationship: string;
  edge_type: string | null;
  confidence: number | null;
  strength: number;
  direction: 'out' | 'in';
}

function slugify(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unnamed';
}

function ensureWikiDirs(root: string): void {
  for (const sub of ['entities', 'projects', 'timelines']) {
    const dir = join(root, 'brain', 'wiki', sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function pagePathFor(root: string, entity: EntityRow): string {
  const dir = entity.type === 'project' ? 'projects' : 'entities';
  return join(root, 'brain', 'wiki', dir, `${slugify(entity.name)}.md`);
}

function readExisting(path: string): { preface: string; suffix: string; lastSynth?: string } | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8');
    const startIdx = content.indexOf(AUTOGEN_START);
    const endIdx = content.indexOf(AUTOGEN_END);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
      // File exists but markers are missing — preserve everything as preface
      return { preface: content, suffix: '' };
    }
    const preface = content.slice(0, startIdx).replace(/\s+$/, '');
    const suffix = content.slice(endIdx + AUTOGEN_END.length).replace(/^\s+/, '');
    const m = content.match(/last_synthesized:\s*(\S+)/);
    return { preface, suffix, lastSynth: m?.[1] };
  } catch {
    return null;
  }
}

function buildAutogenBody(
  entity: EntityRow,
  relations: RelationRow[],
  mentionCount: number,
): string {
  const lines: string[] = [];
  lines.push(AUTOGEN_START);
  lines.push('---');
  lines.push(`entity_id: ${entity.id}`);
  lines.push(`entity_name: "${entity.name.replace(/"/g, '\\"')}"`);
  lines.push(`entity_type: ${entity.type}`);
  lines.push(`mention_count: ${mentionCount}`);
  lines.push(`first_seen: ${entity.first_seen}`);
  lines.push(`last_seen: ${entity.last_seen}`);
  lines.push(`last_synthesized: ${new Date().toISOString()}`);
  if (entity.is_pinned) lines.push(`pinned: true`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${entity.name}`);
  lines.push('');
  lines.push(`*Type: ${entity.type}. ${mentionCount} mention${mentionCount === 1 ? '' : 's'} between ${entity.first_seen.slice(0, 10)} and ${entity.last_seen.slice(0, 10)}.*`);
  lines.push('');

  if (relations.length === 0) {
    lines.push('No structured relations recorded yet.');
  } else {
    const buckets: Record<string, RelationRow[]> = { causal: [], temporal: [], entity: [], semantic: [] };
    for (const r of relations) {
      const k = r.edge_type || 'entity';
      (buckets[k] || buckets.entity).push(r);
    }
    const heading: Record<string, string> = {
      causal: 'How this came about',
      temporal: 'Timeline',
      entity: 'Connections',
      semantic: 'Similar to',
    };
    for (const k of ['causal', 'temporal', 'entity', 'semantic'] as const) {
      const items = buckets[k];
      if (items.length === 0) continue;
      lines.push(`## ${heading[k]}`);
      lines.push('');
      for (const r of items.slice(0, 15)) {
        const arrow = r.direction === 'out' ? '→' : '←';
        const wiki = `[[${r.related_name}]]`;
        const conf = r.confidence != null ? ` *(${Math.round(r.confidence * 100)}%)*` : '';
        lines.push(`- ${arrow} ${wiki} — \`${r.relationship}\`${conf}`);
      }
      if (items.length > 15) lines.push(`- *…and ${items.length - 15} more*`);
      lines.push('');
    }
  }

  lines.push(AUTOGEN_END);
  return lines.join('\n');
}

function writePage(path: string, preface: string, autogen: string, suffix: string): void {
  const parts: string[] = [];
  if (preface.trim().length > 0) {
    parts.push(preface.trim());
    parts.push('');
  }
  parts.push(autogen);
  if (suffix.trim().length > 0) {
    parts.push('');
    parts.push(suffix.trim());
  }
  parts.push('');
  writeFileSync(path, parts.join('\n'), 'utf-8');
}

function writeIndex(root: string, entries: Array<{ name: string; relpath: string; type: string }>): void {
  const path = join(root, 'brain', 'wiki', 'index.md');
  const lines: string[] = [
    AUTOGEN_START,
    '---',
    `last_synthesized: ${new Date().toISOString()}`,
    `entries: ${entries.length}`,
    '---',
    '',
    '# Wiki Index',
    '',
    '*Auto-generated by the sleep agent. Edits outside the markers are preserved on refresh.*',
    '',
  ];

  const byType: Record<string, typeof entries> = {};
  for (const e of entries) {
    (byType[e.type] ??= []).push(e);
  }
  for (const type of Object.keys(byType).sort()) {
    lines.push(`## ${type[0].toUpperCase()}${type.slice(1)}`);
    lines.push('');
    for (const e of byType[type].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- [${e.name}](${e.relpath})`);
    }
    lines.push('');
  }

  lines.push(AUTOGEN_END);

  // Preserve any prefix the user wrote.
  const existing = readExisting(path);
  writePage(path, existing?.preface ?? '', lines.join('\n'), existing?.suffix ?? '');
}

export async function runSynthesizeWikiStep(
  root: string,
  config: SleepConfig,
): Promise<SynthesizeWikiResult> {
  void config; // reserved for future cadence knobs

  ensureWikiDirs(root);

  const db = await getEntityGraphDb(root);
  const sleepDb = getSleepDb(root);

  // Select entities qualifying for a page.
  const entities = db.prepare(`
    SELECT id, name, normalized_name, type, mention_count, is_pinned, first_seen, last_seen
    FROM entities
    WHERE COALESCE(is_pinned, 0) = 1 OR mention_count >= 5
    ORDER BY mention_count DESC
    LIMIT 200
  `).all() as EntityRow[];

  const errors: string[] = [];
  let synthesised = 0;
  let skippedFresh = 0;
  const indexEntries: Array<{ name: string; relpath: string; type: string }> = [];

  for (const e of entities) {
    try {
      const path = pagePathFor(root, e);
      const existing = readExisting(path);

      // Skip if the page is already current — last_synth >= last_seen.
      if (existing?.lastSynth && new Date(existing.lastSynth).getTime() >= new Date(e.last_seen).getTime()) {
        skippedFresh++;
        indexEntries.push({
          name: e.name,
          relpath: (e.type === 'project' ? 'projects' : 'entities') + '/' + slugify(e.name) + '.md',
          type: e.type,
        });
        continue;
      }

      const mentionRow = db.prepare(`SELECT COUNT(*) as c FROM entity_mentions WHERE entity_id = ?`).get(e.id) as { c: number };
      const relations = db.prepare(`
        SELECT
          CASE WHEN er.source_id = ?1 THEN er.target_id ELSE er.source_id END AS related_id,
          rel_entity.name AS related_name,
          rel_entity.type AS related_type,
          er.relationship,
          er.edge_type,
          er.confidence,
          er.strength,
          CASE WHEN er.source_id = ?1 THEN 'out' ELSE 'in' END AS direction
        FROM entity_relations er
        JOIN entities rel_entity ON rel_entity.id = CASE WHEN er.source_id = ?1 THEN er.target_id ELSE er.source_id END
        WHERE er.source_id = ?1 OR er.target_id = ?1
        ORDER BY er.confidence DESC, er.strength DESC
        LIMIT 80
      `).all(e.id) as RelationRow[];

      const autogen = buildAutogenBody(e, relations, mentionRow.c);
      writePage(path, existing?.preface ?? '', autogen, existing?.suffix ?? '');
      synthesised++;
      indexEntries.push({
        name: e.name,
        relpath: (e.type === 'project' ? 'projects' : 'entities') + '/' + slugify(e.name) + '.md',
        type: e.type,
      });
    } catch (err) {
      errors.push(`entity ${e.id} (${e.name}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Also list any pre-existing pages that didn't get re-synthed (so the
  // index reflects the whole wiki, not just this cycle's writes).
  for (const sub of ['entities', 'projects'] as const) {
    const dir = join(root, 'brain', 'wiki', sub);
    if (!existsSync(dir)) continue;
    for (const fname of readdirSync(dir)) {
      if (!fname.endsWith('.md')) continue;
      const name = fname.replace(/\.md$/, '');
      if (!indexEntries.some((e) => slugify(e.name) === name && (e.type === 'project') === (sub === 'projects'))) {
        indexEntries.push({ name, relpath: `${sub}/${fname}`, type: sub === 'projects' ? 'project' : 'entity' });
      }
    }
  }

  try {
    writeIndex(root, indexEntries);
  } catch (err) {
    errors.push(`index.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  sleepDb.prepare(`
    INSERT INTO sleep_telemetry (step, event_type, count, metadata)
    VALUES ('synthesize-wiki', 'wiki-page', ?, ?)
  `).run(synthesised, JSON.stringify({ processed: entities.length, skippedFresh, errors: errors.length }));

  logger.info('Wiki synthesis complete', { processed: entities.length, synthesised, skippedFresh, errors: errors.length });
  return { count: synthesised, processed: entities.length, skippedFresh, errors };
}
