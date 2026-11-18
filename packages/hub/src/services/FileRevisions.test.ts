import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../db/db.js';
import { DECISIONS_FILE, FileRevisionError, FileRevisions, decisionsWriteDenied, hashBytes, relIn, type FileRoot, type RevisionAuthor } from './FileRevisions.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-filerev-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function setup() {
  const dir = path.join(tmp, 'root' + n++);
  fs.mkdirSync(dir, { recursive: true });
  let t = Date.UTC(2026, 10, 18, 8, 0);
  const revs = new FileRevisions(new Db(':memory:'), () => (t += 60_000));
  const root: FileRoot = { kind: 'project', key: 'demo', dir };
  return { dir, revs, root };
}
const bot: RevisionAuthor = { kind: 'bot', id: 'b1', label: '@researcher', machine: 'vps', sessionId: 'turn-1', roomId: 'r1' };
const owner: RevisionAuthor = { kind: 'owner', id: null, label: 'owner', machine: 'pc' };

describe('FileRevisions.record', () => {
  it('records a write once, with its author, and skips an unchanged file', () => {
    const { dir, revs, root } = setup();
    fs.writeFileSync(path.join(dir, 'current.md'), 'v1');
    const r1 = revs.record(root, 'current.md', { ...bot, tool: 'Write' });
    expect(r1).toMatchObject({ rev: 1, hash: hashBytes('v1'), author: { kind: 'bot', label: '@researcher', machine: 'vps', sessionId: 'turn-1' }, tool: 'Write' });
    expect(revs.record(root, 'current.md', bot)).toBeNull();
    fs.writeFileSync(path.join(dir, 'current.md'), 'v2');
    expect(revs.record(root, 'current.md', owner)?.rev).toBe(2);
    expect(revs.history(root, 'current.md').map((r) => r.author.label)).toEqual(['owner', '@researcher']);
    expect(revs.contentAt(root, 'current.md', 1)).toBe('v1');
  });

  it('records a delete as a revision with no hash', () => {
    const { dir, revs, root } = setup();
    fs.writeFileSync(path.join(dir, 'a.md'), 'x');
    revs.record(root, 'a.md', bot);
    fs.rmSync(path.join(dir, 'a.md'));
    expect(revs.record(root, 'a.md', owner)).toMatchObject({ rev: 2, hash: null });
  });

  it('keeps roots apart', () => {
    const { dir, revs, root } = setup();
    fs.writeFileSync(path.join(dir, 'a.md'), 'x');
    revs.record(root, 'a.md', bot);
    expect(revs.latest({ ...root, key: 'other' }, 'a.md')).toBeNull();
  });
});

describe('FileRevisions.writeText', () => {
  it('writes when base matches and refuses a stale base with the current text', () => {
    const { dir, revs, root } = setup();
    const first = revs.writeText(root, 'notes/plan.md', 'one', null, owner);
    expect(first).toMatchObject({ ok: true, hash: hashBytes('one'), rev: 1 });
    expect(fs.readFileSync(path.join(dir, 'notes', 'plan.md'), 'utf8')).toBe('one');

    // Two writers read the same version; the second one to write loses and gets the winner's text.
    const read = revs.readText(root, 'notes/plan.md');
    expect(revs.writeText(root, 'notes/plan.md', 'two (A)', read.hash, { ...bot, label: '@a' })).toMatchObject({ ok: true, rev: 2 });
    const lost = revs.writeText(root, 'notes/plan.md', 'two (B)', read.hash, { ...bot, label: '@b' });
    expect(lost.ok).toBe(false);
    if (!lost.ok) expect(lost.current).toMatchObject({ text: 'two (A)', hash: hashBytes('two (A)'), rev: { rev: 2, author: { label: '@a' } } });
    expect(fs.readFileSync(path.join(dir, 'notes', 'plan.md'), 'utf8')).toBe('two (A)');
  });

  it('refuses null base when the file exists', () => {
    const { revs, root } = setup();
    revs.writeText(root, 'a.md', 'x', null, owner);
    expect(revs.writeText(root, 'a.md', 'y', null, owner).ok).toBe(false);
  });

  it('credits an outside change to "unknown", not to the next writer', () => {
    const { dir, revs, root } = setup();
    revs.writeText(root, 'a.md', 'x', null, owner);
    fs.writeFileSync(path.join(dir, 'a.md'), 'changed by Bash');
    const r = revs.writeText(root, 'a.md', 'y', hashBytes('changed by Bash'), bot);
    expect(r).toMatchObject({ ok: true, rev: 3 });
    expect(revs.history(root, 'a.md').map((x) => x.author.label)).toEqual(['@researcher', 'unknown', 'owner']);
  });

  it('never writes decisions.md', () => {
    const { revs, root } = setup();
    expect(() => revs.writeText(root, 'Decisions.md', 'x', null, owner)).toThrow(FileRevisionError);
  });
});

describe('FileRevisions.appendDecision', () => {
  it('numbers decisions, appends without touching earlier ones, and checks supersedes', () => {
    const { dir, revs, root } = setup();
    expect(revs.appendDecision(root, { title: 'Use SQLite', text: 'Simple and local.' }, { ...bot, sources: ['https://sqlite.org'] }).id).toBe('D-0001');
    const before = fs.readFileSync(path.join(dir, DECISIONS_FILE), 'utf8');
    expect(revs.appendDecision(root, { title: 'Use Postgres', text: 'We need concurrent writers.', supersedes: ['D-0001'] }, owner).id).toBe('D-0002');
    const after = fs.readFileSync(path.join(dir, DECISIONS_FILE), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('## D-0002 · Use Postgres');
    expect(after).toContain('supersedes D-0001');
    expect(before).toContain('Sources: https://sqlite.org');
    expect(() => revs.appendDecision(root, { title: 'x', text: 'y', supersedes: ['D-0009'] }, owner)).toThrow(/No decision D-0009/);
    expect(revs.history(root, DECISIONS_FILE).map((r) => r.tool)).toEqual(['log_decision', 'log_decision']);
  });
});

describe('decisionsWriteDenied', () => {
  const root: FileRoot = { kind: 'room', key: 'r1', dir: path.join(tmp, 'guard') };
  it('refuses write tools aimed at the root decisions.md', () => {
    expect(decisionsWriteDenied('Write', { file_path: path.join(root.dir, 'decisions.md') }, root.dir, [root])).toMatch(/append-only/);
    expect(decisionsWriteDenied('Edit', { file_path: 'DECISIONS.md' }, root.dir, [root])).toMatch(/append-only/);
    expect(decisionsWriteDenied('Edit', { file_path: path.join(tmp, 'elsewhere', 'decisions.md') }, root.dir, [root])).toBeNull();
    expect(decisionsWriteDenied('Write', { file_path: path.join(root.dir, 'current.md') }, root.dir, [root])).toBeNull();
  });
  it('lets Bash read it but not write, move or delete it', () => {
    const d = (command: string) => decisionsWriteDenied('Bash', { command }, root.dir, [root]);
    expect(d('cat decisions.md')).toBeNull();
    expect(d('grep -n D-0003 decisions.md 2>/dev/null | head')).toBeNull();
    expect(d('echo "## D-9" >> decisions.md')).toMatch(/append-only/);
    expect(d("sed -i 's/a/b/' decisions.md")).toMatch(/append-only/);
    expect(d('rm decisions.md')).toMatch(/append-only/);
    expect(d('Set-Content decisions.md x')).toMatch(/append-only/);
  });
});

describe('relIn', () => {
  it('maps inside paths and rejects outside ones', () => {
    const root: FileRoot = { kind: 'room', key: 'r', dir: path.join(tmp, 'rel') };
    expect(relIn(root, path.join(root.dir, 'a', 'b.md'))).toBe('a/b.md');
    expect(relIn(root, root.dir)).toBeNull();
    expect(relIn(root, path.join(tmp, 'rel-other', 'x'))).toBeNull();
    expect(relIn(root, path.join(root.dir, '..', 'x'))).toBeNull();
  });
});
