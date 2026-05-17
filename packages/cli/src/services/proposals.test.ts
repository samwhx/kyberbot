import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  createProposal,
  listProposals,
  findProposal,
  applyProposal,
  rejectProposal,
  revertProposal,
  archiveOldProposals,
  isHardNever,
} from './proposals.js';

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyberbot-proposals-test-'));
  // Init a git repo in the temp dir so apply/revert can run.
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  // Seed a target file so the proposals can apply diffs against it.
  writeFileSync(join(root, 'SOUL.md'), 'old line\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isHardNever', () => {
  it('blocks .env', () => {
    expect(isHardNever('.env')).toBe(true);
    expect(isHardNever('.env.local')).toBe(true);
  });

  it('blocks data/ subtree', () => {
    expect(isHardNever('data/timeline.db')).toBe(true);
    expect(isHardNever('data/whatsapp-auth/creds.json')).toBe(true);
  });

  it('blocks .git/ + node_modules/', () => {
    expect(isHardNever('.git/HEAD')).toBe(true);
    expect(isHardNever('node_modules/foo')).toBe(true);
  });

  it('blocks path traversal', () => {
    expect(isHardNever('../../../etc/passwd')).toBe(true);
    expect(isHardNever('SOUL.md/../.env')).toBe(true);
  });

  it('blocks absolute paths', () => {
    expect(isHardNever('/etc/passwd')).toBe(true);
  });

  it('allows normal agent files', () => {
    expect(isHardNever('SOUL.md')).toBe(false);
    expect(isHardNever('USER.md')).toBe(false);
    expect(isHardNever('skills/recall/SKILL.md')).toBe(false);
    expect(isHardNever('brain/notes/foo.md')).toBe(false);
  });
});

describe('createProposal + listProposals', () => {
  it('creates a pending proposal file with frontmatter + body', () => {
    const p = createProposal(root, {
      type: 'personality_tweak',
      target_path: 'SOUL.md',
      title: 'Tighten tone',
      why: '3 corrections this week.',
      diff: '--- a/SOUL.md\n+++ b/SOUL.md\n@@ -1 +1 @@\n-old line\n+new terse line',
      priority: 0.8,
      evidence_event_ids: [10, 11, 12],
    });
    expect(p.frontmatter.status).toBe('pending');
    expect(p.frontmatter.target_path).toBe('SOUL.md');
    expect(existsSync(p.filePath)).toBe(true);
    const list = listProposals(root);
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.id).toBe(p.frontmatter.id);
  });

  it('list defaults to pending only', () => {
    const a = createProposal(root, {
      type: 'personality_tweak', target_path: 'SOUL.md', title: 'A', why: 'a', diff: 'x',
    });
    const b = createProposal(root, {
      type: 'skill_revision', target_path: 'skills/r.md', title: 'B', why: 'b', diff: 'x',
    });
    rejectProposal(root, b);
    expect(listProposals(root)).toHaveLength(1);
    expect(listProposals(root, { status: 'all' })).toHaveLength(2);
    expect(listProposals(root, { status: 'rejected' })).toHaveLength(1);
    expect(listProposals(root)[0].frontmatter.id).toBe(a.frontmatter.id);
  });

  it('list sorts by priority descending', () => {
    const lo = createProposal(root, {
      type: 'other', target_path: 'A.md', title: 'Lo', why: 'a', diff: 'x', priority: 0.2,
    });
    const hi = createProposal(root, {
      type: 'other', target_path: 'B.md', title: 'Hi', why: 'b', diff: 'x', priority: 0.9,
    });
    const list = listProposals(root);
    expect(list[0].frontmatter.id).toBe(hi.frontmatter.id);
    expect(list[1].frontmatter.id).toBe(lo.frontmatter.id);
  });
});

describe('findProposal', () => {
  it('finds by full id', () => {
    const p = createProposal(root, {
      type: 'personality_tweak', target_path: 'SOUL.md', title: 'X', why: 'x', diff: 'x',
    });
    const found = findProposal(root, p.frontmatter.id);
    expect(found?.frontmatter.id).toBe(p.frontmatter.id);
  });

  it('finds by short id (suffix only)', () => {
    const p = createProposal(root, {
      type: 'personality_tweak', target_path: 'SOUL.md', title: 'X', why: 'x', diff: 'x',
    });
    const shortId = p.frontmatter.id.split('-').slice(-1)[0];
    const found = findProposal(root, shortId);
    expect(found?.frontmatter.id).toBe(p.frontmatter.id);
  });

  it('returns null on missing id', () => {
    expect(findProposal(root, 'nonexistent')).toBeNull();
  });
});

describe('applyProposal', () => {
  const VALID_DIFF = `--- a/SOUL.md
+++ b/SOUL.md
@@ -1 +1 @@
-old line
+new terse line`;

  it('applies a valid diff and creates a commit + tag', async () => {
    const p = createProposal(root, {
      type: 'personality_tweak', target_path: 'SOUL.md',
      title: 'Tighten tone', why: 'a', diff: VALID_DIFF,
    });
    const result = await applyProposal(root, p);
    expect(result.applied).toBe(true);
    expect(result.commitHash).toMatch(/^[a-f0-9]+$/);
    expect(readFileSync(join(root, 'SOUL.md'), 'utf-8')).toContain('new terse line');

    // Tag exists
    const tags = git(root, ['tag', '--list']);
    expect(tags.stdout).toContain(`proposal/${p.frontmatter.id}`);

    // Frontmatter updated
    const refreshed = findProposal(root, p.frontmatter.id);
    expect(refreshed?.frontmatter.status).toBe('applied');
    expect(refreshed?.frontmatter.applied_commit).toBe(result.commitHash);
  });

  it('refuses to apply if target_path is on hard-never list', async () => {
    const p = createProposal(root, {
      type: 'other', target_path: '.env', title: 'evil', why: 'x', diff: VALID_DIFF,
    });
    const result = await applyProposal(root, p);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/hard-never/);
    const refreshed = findProposal(root, p.frontmatter.id);
    expect(refreshed?.frontmatter.status).toBe('rejected_blocked');
  });

  it('refuses to apply if working tree is dirty', async () => {
    writeFileSync(join(root, 'SOUL.md'), 'dirty edit\n');
    const p = createProposal(root, {
      type: 'personality_tweak', target_path: 'SOUL.md',
      title: 'X', why: 'x', diff: VALID_DIFF,
    });
    const result = await applyProposal(root, p);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/dirty/);
  });

  it('refuses to apply if proposal has no diff fence', async () => {
    // Manually craft a proposal file without a diff fence
    const p = createProposal(root, {
      type: 'other', target_path: 'SOUL.md', title: 'X', why: 'x', diff: 'no diff here',
    });
    // Strip the diff fence from the body, commit so working tree is clean.
    const raw = readFileSync(p.filePath, 'utf-8').replace(/```diff\n[\s\S]*?\n```/, '(no diff)');
    writeFileSync(p.filePath, raw);
    git(root, ['add', '--', p.filePath]);
    git(root, ['commit', '-q', '-m', 'strip diff fence for test']);
    const fresh = findProposal(root, p.frontmatter.id)!;
    const result = await applyProposal(root, fresh);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/no diff/i);
  });
});

describe('revertProposal', () => {
  const VALID_DIFF = `--- a/SOUL.md
+++ b/SOUL.md
@@ -1 +1 @@
-old line
+new terse line`;

  it('reverts an applied proposal via git revert', async () => {
    const p = createProposal(root, {
      type: 'personality_tweak', target_path: 'SOUL.md',
      title: 'X', why: 'x', diff: VALID_DIFF,
    });
    await applyProposal(root, p);
    const refreshed = findProposal(root, p.frontmatter.id)!;
    const result = revertProposal(root, refreshed);
    expect(result.applied).toBe(true);
    expect(readFileSync(join(root, 'SOUL.md'), 'utf-8')).toContain('old line');
    const final = findProposal(root, p.frontmatter.id);
    expect(final?.frontmatter.status).toBe('reverted');
  });

  it('refuses to revert a non-applied proposal', () => {
    const p = createProposal(root, {
      type: 'other', target_path: 'SOUL.md', title: 'X', why: 'x', diff: VALID_DIFF,
    });
    const result = revertProposal(root, p);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/not applied/);
  });
});

describe('rejectProposal', () => {
  it('marks pending proposal as rejected without touching files', () => {
    const before = readFileSync(join(root, 'SOUL.md'), 'utf-8');
    const p = createProposal(root, {
      type: 'other', target_path: 'SOUL.md', title: 'X', why: 'x', diff: 'x',
    });
    rejectProposal(root, p);
    const refreshed = findProposal(root, p.frontmatter.id);
    expect(refreshed?.frontmatter.status).toBe('rejected');
    expect(readFileSync(join(root, 'SOUL.md'), 'utf-8')).toBe(before);
  });
});

describe('archiveOldProposals', () => {
  it('moves only terminal-status proposals older than threshold', () => {
    const old = createProposal(root, {
      type: 'other', target_path: 'A.md', title: 'old', why: 'x', diff: 'x',
    });
    const young = createProposal(root, {
      type: 'other', target_path: 'B.md', title: 'young', why: 'x', diff: 'x',
    });
    // Backdate the old one's frontmatter and reject it
    rejectProposal(root, old);
    const oldRefreshed = findProposal(root, old.frontmatter.id)!;
    oldRefreshed.frontmatter.created = '2024-01-01T00:00:00Z';
    writeFileSync(oldRefreshed.filePath,
      readFileSync(oldRefreshed.filePath, 'utf-8')
        .replace(/created: .*/, "created: '2024-01-01T00:00:00Z'"));

    const result = archiveOldProposals(root, 90);
    expect(result.archived).toBe(1);

    // young pending is still in active dir
    const active = listProposals(root, { status: 'all' });
    expect(active.some(p => p.frontmatter.id === young.frontmatter.id)).toBe(true);
    expect(active.some(p => p.frontmatter.id === old.frontmatter.id)).toBe(false);
  });

  it('never archives pending proposals regardless of age', () => {
    const p = createProposal(root, {
      type: 'other', target_path: 'A.md', title: 'ancient pending', why: 'x', diff: 'x',
    });
    // Backdate
    writeFileSync(p.filePath,
      readFileSync(p.filePath, 'utf-8')
        .replace(/created: .*/, "created: '2020-01-01T00:00:00Z'"));
    const result = archiveOldProposals(root, 90);
    expect(result.archived).toBe(0);
  });
});
