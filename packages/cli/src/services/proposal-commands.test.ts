import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  parseProposalCommand,
  tryRunProposalCommand,
  formatProposalCommandReply,
} from './proposal-commands.js';
import { createProposal } from './proposals.js';

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyberbot-pcmd-test-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t.com']);
  git(root, ['config', 'user.name', 't']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'SOUL.md'), 'old line\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'init']);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseProposalCommand', () => {
  it('parses single-id approve', () => {
    expect(parseProposalCommand('approve abc12345'))
      .toEqual({ action: 'approve', ids: ['abc12345'] });
  });

  it('parses single-id reject', () => {
    expect(parseProposalCommand('reject abc12345'))
      .toEqual({ action: 'reject', ids: ['abc12345'] });
  });

  it('parses comma-separated multi-id approve', () => {
    expect(parseProposalCommand('approve abc12345, def67890'))
      .toEqual({ action: 'approve', ids: ['abc12345', 'def67890'] });
  });

  it('parses space-separated multi-id', () => {
    expect(parseProposalCommand('approve abc12345 def67890'))
      .toEqual({ action: 'approve', ids: ['abc12345', 'def67890'] });
  });

  it('handles type-prefixed ids', () => {
    expect(parseProposalCommand('approve personality_tweak-abc123'))
      .toEqual({ action: 'approve', ids: ['personality_tweak-abc123'] });
  });

  it('is case-insensitive on action', () => {
    expect(parseProposalCommand('APPROVE abc12345'))
      .toEqual({ action: 'approve', ids: ['abc12345'] });
  });

  it('returns null for non-command text', () => {
    expect(parseProposalCommand('hello there')).toBeNull();
    expect(parseProposalCommand('what is the weather')).toBeNull();
    expect(parseProposalCommand('approve')).toBeNull();   // no ids
    expect(parseProposalCommand('please approve the cruise plan')).toBeNull();  // doesn't start with action
  });

  it('returns null for empty / whitespace', () => {
    expect(parseProposalCommand('')).toBeNull();
    expect(parseProposalCommand('   ')).toBeNull();
  });
});

describe('tryRunProposalCommand — guards', () => {
  it('returns null when text matches but no proposals match (prose case)', async () => {
    // No proposals exist at all
    const result = await tryRunProposalCommand(root, 'approve abc12345');
    expect(result).toBeNull();
  });

  it('returns null when proposals exist but none with the cited id', async () => {
    createProposal(root, {
      type: 'other', target_path: 'SOUL.md', title: 'X', why: 'x', diff: 'x',
    });
    const result = await tryRunProposalCommand(root, 'approve nonexistent');
    expect(result).toBeNull();
  });

  it('returns null for non-command text even when proposals exist', async () => {
    createProposal(root, {
      type: 'other', target_path: 'SOUL.md', title: 'X', why: 'x', diff: 'x',
    });
    const result = await tryRunProposalCommand(root, 'hello alfred how are you');
    expect(result).toBeNull();
  });
});

describe('tryRunProposalCommand — execution', () => {
  const VALID_DIFF = `--- a/SOUL.md
+++ b/SOUL.md
@@ -1 +1 @@
-old line
+new terse line`;

  it('applies a single proposal by short id', async () => {
    const p = createProposal(root, {
      type: 'personality_tweak', target_path: 'SOUL.md',
      title: 'X', why: 'x', diff: VALID_DIFF,
    });
    const shortId = p.frontmatter.id.split('-').slice(-1)[0];
    const result = await tryRunProposalCommand(root, `approve ${shortId}`);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve');
    expect(result!.results).toHaveLength(1);
    expect(result!.results[0].status).toBe('applied');
    expect(result!.results[0].commit).toMatch(/^[a-f0-9]+$/);
  });

  it('rejects a single proposal', async () => {
    const p = createProposal(root, {
      type: 'other', target_path: 'SOUL.md', title: 'X', why: 'x', diff: VALID_DIFF,
    });
    const shortId = p.frontmatter.id.split('-').slice(-1)[0];
    const result = await tryRunProposalCommand(root, `reject ${shortId}`);
    expect(result!.action).toBe('reject');
    expect(result!.results[0].status).toBe('rejected');
  });

  it('handles partial-match: some ids exist, some do not', async () => {
    const p = createProposal(root, {
      type: 'other', target_path: 'SOUL.md', title: 'X', why: 'x', diff: VALID_DIFF,
    });
    const shortId = p.frontmatter.id.split('-').slice(-1)[0];
    const result = await tryRunProposalCommand(root, `reject ${shortId}, ghost`);
    expect(result).not.toBeNull();
    expect(result!.results).toHaveLength(2);
    const byId = Object.fromEntries(result!.results.map(r => [r.id, r.status]));
    expect(byId[shortId]).toBe('rejected');
    expect(byId.ghost).toBe('not_found');
  });

  it('reports not_pending for already-applied proposals', async () => {
    const p = createProposal(root, {
      type: 'other', target_path: 'SOUL.md', title: 'X', why: 'x', diff: VALID_DIFF,
    });
    const shortId = p.frontmatter.id.split('-').slice(-1)[0];
    // First approve succeeds
    const first = await tryRunProposalCommand(root, `approve ${shortId}`);
    expect(first!.results[0].status).toBe('applied');
    // Second approve hits not_pending — but text won't match because the
    // proposal is no longer pending. So tryRunProposalCommand returns null.
    const second = await tryRunProposalCommand(root, `approve ${shortId}`);
    expect(second).toBeNull();
  });
});

describe('formatProposalCommandReply', () => {
  it('formats applied with commit hash', () => {
    const out = formatProposalCommandReply({
      action: 'approve',
      results: [{ id: 'abc', status: 'applied', commit: '1234567890abcdef' }],
    });
    expect(out).toContain('abc');
    expect(out).toContain('applied');
    expect(out).toContain('1234567');
  });

  it('formats rejected with marker', () => {
    const out = formatProposalCommandReply({
      action: 'reject',
      results: [{ id: 'abc', status: 'rejected' }],
    });
    expect(out).toContain('rejected');
  });

  it('formats apply_failed with reason', () => {
    const out = formatProposalCommandReply({
      action: 'approve',
      results: [{ id: 'abc', status: 'apply_failed', reason: 'tree dirty' }],
    });
    expect(out).toMatch(/tree dirty/);
  });

  it('formats multiple results on separate lines', () => {
    const out = formatProposalCommandReply({
      action: 'approve',
      results: [
        { id: 'abc', status: 'applied' },
        { id: 'def', status: 'rejected' },
      ],
    });
    expect(out.split('\n')).toHaveLength(2);
  });
});
