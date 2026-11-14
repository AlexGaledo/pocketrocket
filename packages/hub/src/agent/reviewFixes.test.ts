import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { MAX_ATTACHMENT_IMAGE_BYTES } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { MIGRATIONS } from '../db/migrations.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { FormBroker } from '../services/FormBroker.js';
import { MediaRejected, MediaStore } from '../services/MediaStore.js';
import { userContent } from '../providers/claude.js';
import { ATTACHMENT_TTL_MS, materializeImages, removeBotAttachments, sweepAttachments } from './attachments.js';
import { createHubTools, type ToolCtx } from './botTools.js';
import { exportBot, scrubForExport } from '../services/botTransfer.js';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-rev-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const png = (n: number, fill = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, fill)]);

describe('review 3: per-picture size limit', () => {
  it('the store refuses an upload over the per-picture cap and checkAttachments refuses a stored oversize file', () => {
    const media = new MediaStore(tmp());
    expect(() => media.put(png(MAX_ATTACHMENT_IMAGE_BYTES + 1), MAX_ATTACHMENT_IMAGE_BYTES)).toThrow(MediaRejected);
    // An oversize file that got in by another route (older hub, copied folder) is still refused when attached.
    const ref = media.put(png(MAX_ATTACHMENT_IMAGE_BYTES + 1), MAX_ATTACHMENT_IMAGE_BYTES + 100);
    expect(media.checkAttachments([ref])).toMatch(/too large/);
    expect(media.checkAttachments([media.put(png(100))])).toBeNull();
  });

  it('materializeImages keeps an oversize picture as a path only, never an image block', () => {
    const media = new MediaStore(tmp());
    const root = tmp();
    const small = media.put(png(100));
    const big = media.put(png(MAX_ATTACHMENT_IMAGE_BYTES + 1), MAX_ATTACHMENT_IMAGE_BYTES + 100);
    const out = materializeImages(media, root, 'bot1', [small, big]);
    expect(out).toHaveLength(2);
    expect(out[0].data).toBeDefined();
    expect(out[1].data).toBeUndefined();
    expect(fs.existsSync(out[1].path)).toBe(true);
    const content = userContent('hi', out) as { type: string }[];
    expect(content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect(userContent('hi', [out[1]])).toBe('hi');
  });
});

describe('review 6: attachment pruning', () => {
  it('removes a deleted bot folder and files past the TTL, keeping fresh files and not following links', () => {
    const root = tmp();
    const keep = path.join(root, 'live'); fs.mkdirSync(keep);
    const gone = path.join(root, 'gone'); fs.mkdirSync(gone);
    fs.writeFileSync(path.join(gone, 'a.png'), 'x');
    fs.writeFileSync(path.join(keep, 'old.png'), 'x');
    fs.writeFileSync(path.join(keep, 'new.png'), 'x');
    const now = Date.now();
    const old = new Date(now - ATTACHMENT_TTL_MS - 60_000);
    fs.utimesSync(path.join(keep, 'old.png'), old, old);
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'safe');
    try { fs.symlinkSync(outside, path.join(root, 'linked'), 'junction'); } catch { /* no link rights */ }
    const n = sweepAttachments(root, new Set(['live']), ATTACHMENT_TTL_MS, now);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(path.join(keep, 'old.png'))).toBe(false);
    expect(fs.existsSync(path.join(keep, 'new.png'))).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('safe');
  });

  it('removeBotAttachments deletes one bot folder only', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'b1')); fs.mkdirSync(path.join(root, 'b2'));
    removeBotAttachments(root, 'b1');
    removeBotAttachments(root, '../b2');
    expect(fs.existsSync(path.join(root, 'b1'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'b2'))).toBe(true);
  });
});

function toolsFor(extra: Partial<ToolCtx> = {}) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const forms = new FormBroker(repos, 5);
  const memory = new MemoryService();
  const ctx: ToolCtx = { bot, room: room as Room, members: [bot as Bot], turnId: 't1', hop: 0, causeId: 'c1', repos, memory, skills: new SkillService(repos), dispatchFromBot: () => [], setState: () => undefined, models: [], forms, ...extra };
  const tools = createHubTools(ctx);
  const call = async (name: string, input: unknown) => {
    const r = await tools.find((t) => t.name === name)!.handler(input as Record<string, unknown>);
    return { text: (r.content[0] as { text: string }).text, isError: !!r.isError };
  };
  return { repos, bot, room, memory, call };
}

describe('review 5: request_form on unattended turns', () => {
  const ask = { title: 'Details', fields: [{ id: 'd', type: 'text', label: 'Domain' }] };
  it('refuses at once, without a card, when the turn is a routine/trigger run', async () => {
    const s = toolsFor({ strictApprovals: true });
    const r = await s.call('request_form', ask);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/plain text/);
    expect(s.repos.listMessages(s.room.id).filter((m) => m.kind === 'form')).toHaveLength(0);
  });
  it('still posts a card on an interactive turn', async () => {
    const s = toolsFor();
    const run = s.call('request_form', ask);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.repos.listMessages(s.room.id).filter((m) => m.kind === 'form')).toHaveLength(1);
    await run;
  });
});

describe('review 9: write_note tags', () => {
  it('writes tags as front matter in replace mode', async () => {
    const s = toolsFor();
    const r = await s.call('write_note', { title: 'rev9 tagged ' + process.pid, text: 'body', tags: ['a', 'b'] });
    expect(r.isError).toBe(false);
    const file = r.text.replace(/^Saved /, '').replace(/ \(cut.*$/, '').replace(/\.$/, '');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^---\ntags: a, b\n---\nbody/);
    fs.rmSync(file, { force: true });
  });
  it('errors instead of saving without the tags in append mode or with its own front matter', async () => {
    const s = toolsFor();
    const t = 'rev9 other ' + process.pid;
    const before = s.memory.listNotes(s.bot.id).length;
    const a = await s.call('write_note', { title: t, text: 'x', mode: 'append', tags: ['a'] });
    expect(a.isError).toBe(true);
    expect(a.text).toMatch(/tags/);
    expect(a.text).not.toMatch(/^Saved/);
    const b = await s.call('write_note', { title: t, text: '---\ntitle: z\n---\nx', tags: ['a'] });
    expect(b.isError).toBe(true);
    expect(b.text).toMatch(/front matter/);
    expect(s.memory.listNotes(s.bot.id).length).toBe(before);
    const c = await s.call('write_note', { title: t, text: 'x', mode: 'append' }); // no tags: unchanged
    expect(c.isError).toBe(false);
    fs.rmSync(c.text.replace(/^Saved /, '').replace(/\.$/, ''), { force: true });
  });
});

describe('review 7: messages_fts migration 240', () => {
  it('drops index rows of other kinds on an existing database and only indexes searchable kinds after', () => {
    const dir = tmp();
    const file = path.join(dir, 'hub.db');
    const old = new Db(file, MIGRATIONS.filter((m) => m.version < 240));
    const repos = new Repos(old);
    const r = repos.createRoom({ kind: 'group', name: 'R', memberIds: [], coordinatorBotId: null });
    const say = (rp: Repos, kind: string, text: string) => rp.insertMessage({ roomId: r.id, authorType: 'user', authorId: null, kind: kind as 'text', text, payload: null, causeId: null, hop: 0, turnId: null });
    say(repos, 'text', 'alpha one'); say(repos, 'system', 'alpha sys'); say(repos, 'tool', 'alpha tool'); say(repos, 'handoff', 'alpha hand');
    const count = (d: Db) => d.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages_fts')!.n;
    expect(count(old)).toBe(4);
    old.raw.close();

    const db = new Db(file);
    expect(db.schemaVersions()).toContain(240);
    expect(count(db)).toBe(2);
    const r2 = new Repos(db);
    say(r2, 'system', 'beta'); expect(count(db)).toBe(2);
    const t = say(r2, 'text', 'beta text'); expect(count(db)).toBe(3);
    r2.updateMessage(t.id, { text: 'gamma text' });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'gamma'")!.n).toBe(1);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'beta'")!.n).toBe(0);
    // a kind change out of the searchable set removes the row; back in adds it
    db.run("UPDATE messages SET kind='system' WHERE id=?", t.id);
    expect(count(db)).toBe(2);
    db.run("UPDATE messages SET kind='text' WHERE id=?", t.id);
    expect(count(db)).toBe(3);
    db.raw.close();
  });
});

describe('review 8: export scrub and skipped list', () => {
  it('scrubs other absolute paths but keeps URLs and relative paths', () => {
    const s = scrubForExport('d:\\work\\app\\x.txt and E:/data/y and \\\\nas\\share\\f and /srv/app/data and /opt/x/y, see https://example.com/docs/page and src/lib/a.ts and ./a/b');
    expect(s.text).not.toMatch(/work|nas|srv|opt\/x|E:\/data/);
    expect(s.text).toContain('https://example.com/docs/page');
    expect(s.text).toContain('src/lib/a.ts');
    expect(s.text).toContain('./a/b');
    expect(s.removed).toBe(5);
  });

  it('exportBot reports skills dropped for size or count', () => {
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'Exp', handle: 'exp', title: '', description: 'x', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const skillIds = Array.from({ length: 22 }, (_, i) => 's' + i);
    const d = {
      repos: { botSkillIds: () => skillIds, getSkill: (id: string) => ({ id, name: 'skill-' + id.slice(1), parentId: null, description: 'd' }) },
      memory: { read: () => '' },
      skills: { readMarkdown: (s: { id: string }) => (s.id === 's0' ? 'x'.repeat(65 * 1024) : 'ok ' + s.id) },
    } as never;
    const out = exportBot(d, bot, { includeMemory: false });
    expect(out.file.skills).toHaveLength(20);
    expect(out.skipped).toEqual(expect.arrayContaining([{ name: 'skill-0', reason: 'too_big' }, { name: 'skill-21', reason: 'too_many' }]));
    expect(out.skipped).toHaveLength(2);
  });
});
