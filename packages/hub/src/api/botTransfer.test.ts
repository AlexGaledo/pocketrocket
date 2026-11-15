import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Bot, BotExportResult, BotImportResult, Skill } from '@pocketrocket/shared';
import { botHome } from '../config.js';
import { createHub, type Hub } from '../hub.js';
import { scrubForExport, importBot, IMPORT_DEFAULT_TOOLS } from '../services/botTransfer.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';

let hub: Hub;
let base: string;
const made: string[] = [];
beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: null });
  base = 'http://127.0.0.1:' + (await hub.listen());
});
afterAll(async () => {
  for (const id of made) fs.rmSync(botHome(id), { recursive: true, force: true });
  await hub.shutdown();
});
async function api<T>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as T };
}
const uniq = 'x' + process.pid;

describe('bot export', () => {
  it('leaves secrets, paths and settings out of the file', async () => {
    const bot = (await api<Bot>('POST', '/api/bots', {
      name: 'Exporter', handle: 'exp' + uniq, title: 'T',
      description: 'Use key sk-abcdefghijklmnopqrstuvwx and read C:\\Users\\dana\\secret\\notes.txt. password: hunter2hunter2',
      allowedTools: ['Bash', 'Read'], maxBudgetUsd: 7,
    })).body;
    made.push(bot.id);
    const sk = (await api<Skill>('POST', '/api/skills', { name: 'exp-skill-' + uniq, description: 'd', markdown: 'Token ghp_abcdefghijklmnopqrstuvwxyz0123 at /home/dana/x' })).body;
    await api('PUT', '/api/bots/' + bot.id + '/skills', { skillIds: [sk.id] });
    await api('PUT', '/api/bots/' + bot.id + '/memory', { text: 'remember /Users/dana/notes and Bearer abcdefghijklmnop' });

    const r = await api<BotExportResult>('GET', '/api/bots/' + bot.id + '/export?memory=1');
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body.file);
    for (const leak of ['sk-abcdef', 'hunter2', 'dana', 'ghp_', 'abcdefghijklmnop', bot.id, 'allowedTools', 'maxBudget', 'Bash']) {
      expect(text, leak).not.toContain(leak);
    }
    expect(r.body.redactions).toBeGreaterThan(3);
    expect(Object.keys(r.body.file.bot).sort()).toEqual(['avatar', 'description', 'handle', 'name', 'title']);
    expect(r.body.file.skills).toHaveLength(1);
    expect(r.body.file.memory).toContain('[path]');

    const noMem = (await api<BotExportResult>('GET', '/api/bots/' + bot.id + '/export')).body;
    expect(noMem.file.memory).toBeUndefined();
  });

  it('404s for an unknown bot', async () => {
    expect((await api('GET', '/api/bots/nope/export')).status).toBe(404);
  });

  it('scrubs paths and key assignments', () => {
    expect(scrubForExport('see ~/proj and /home/a/b and api_key=abcdef123456').text).toBe('see [path] and [path] and api_key=[redacted]');
    expect(scrubForExport('plain words stay').removed).toBe(0);
  });
});

describe('bot import', () => {
  const skillName = 'imp-skill-' + uniq;
  const file = (over: Record<string, unknown> = {}) => ({
    format: 'pocketrocket.bot', version: 1,
    bot: { name: 'Imported', handle: 'imp' + uniq, title: 'Role', description: 'Do things.', avatar: 'rocket' },
    skills: [{ name: skillName, description: 'Does it', markdown: '---\nname: other\nallowed-tools: Bash\n---\nBody' }],
    memory: 'a note',
    ...over,
  });

  it('creates a new bot, renames a taken handle, and keeps skills pending', async () => {
    const a = await api<BotImportResult>('POST', '/api/bots/import', file());
    expect(a.status).toBe(200);
    made.push(a.body.bot.id);
    expect(a.body.bot.handle).toBe('imp' + uniq);
    expect(a.body.memoryImported).toBe(false);
    expect(a.body.skills[0].renamed).toBe(false);
    const b = await api<BotImportResult>('POST', '/api/bots/import?memory=1', file());
    made.push(b.body.bot.id);
    expect(b.body.bot.id).not.toBe(a.body.bot.id);
    expect(b.body.handleRenamed).toBe(true);
    expect(b.body.bot.handle).toBe('imp' + uniq + '-2');
    expect(b.body.skills[0]).toMatchObject({ name: skillName + '-2', renamed: true });
    expect(b.body.memoryImported).toBe(true);
    const mem = (await api<{ text: string }>('GET', '/api/bots/' + b.body.bot.id + '/memory')).body;
    expect(mem.text).toContain('a note');
    const ids = (await api<string[]>('GET', '/api/bots/' + b.body.bot.id + '/skills')).body;
    const sk = (await api<Skill & { markdown: string }>('GET', '/api/skills/' + ids[0])).body;
    expect(sk).toMatchObject({ reviewStatus: 'pending', source: 'imported' });
    expect(sk.markdown).not.toContain('allowed-tools');
    expect(sk.markdown).toContain('name: ' + sk.name);
    expect((await api<Bot[]>('GET', '/api/bots')).body.filter((x) => x.handle === 'imp' + uniq)).toHaveLength(1);
  });

  it('gives an imported bot no shell or page fetching', async () => {
    const r = await api<BotImportResult>('POST', '/api/bots/import', file({ bot: { name: 'Plain', handle: 'plain' + uniq, title: '', description: 'd', avatar: 'rocket' }, skills: [] }));
    made.push(r.body.bot.id);
    const tools = (await api<Bot[]>('GET', '/api/bots')).body.find((b) => b.id === r.body.bot.id)!.allowedTools;
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('WebFetch');
    expect(tools).toEqual([...IMPORT_DEFAULT_TOOLS]);
  });

  it('refuses Windows reserved skill names', async () => {
    for (const name of ['con', 'nul', 'aux', 'prn', 'com1', 'com9', 'lpt1', 'lpt9']) {
      const r = await api('POST', '/api/bots/import', file({ skills: [{ name, description: 'd', markdown: 'x' }] }));
      expect(r.status, name).toBe(400);
    }
    expect((await api('POST', '/api/bots/import', file({ skills: [{ name: 'console', description: 'd', markdown: 'x' }] }))).status).toBe(200);
  });

  it('a failure part-way removes the skills made earlier in the same file', () => {
    const repos = new Repos(new Db(':memory:'));
    const removed: string[] = [];
    let n = 0;
    const skills = {
      importPending: (name: string) => { if (++n === 3) throw new Error('disk full'); return { skill: { id: 'sk' + n, name }, renamed: false }; },
      remove: (id: string) => { removed.push(id); },
    };
    const memory = { ensureHome: () => undefined, writeIdentity: () => undefined, removeHome: () => undefined };
    const f = file({ skills: ['aa-one', 'bb-two', 'cc-three'].map((name) => ({ name, description: 'd', markdown: 'x' })) });
    expect(() => importBot({ repos, memory, skills } as never, f, { includeMemory: false })).toThrow('disk full');
    expect(removed).toEqual(['sk1', 'sk2']);
    expect(repos.listBots().filter((b) => b.handle === 'imp' + uniq)).toHaveLength(0);
  });

  it('rejects unknown fields, wrong versions, bad shapes and big files', async () => {
    const bad = async (f: unknown) => (await api<{ error: string }>('POST', '/api/bots/import', f)).status;
    expect(await bad(file({ extra: 1 }))).toBe(400);
    expect(await bad(file({ bot: { name: 'x', handle: 'okh', allowedTools: ['Bash'] } }))).toBe(400);
    expect(await bad(file({ bot: { name: 'x', handle: 'okh', token: 'abc' } }))).toBe(400);
    expect(await bad(file({ version: 2 }))).toBe(400);
    expect(await bad(file({ format: 'other' }))).toBe(400);
    expect(await bad(file({ bot: { name: 'x', handle: 'Bad Handle' } }))).toBe(400);
    expect(await bad(file({ bot: { name: 'x', handle: 'okh', avatar: 'img:' + 'a'.repeat(64) } }))).toBe(400);
    expect(await bad(file({ skills: [{ name: '../evil', description: 'd', markdown: 'x' }] }))).toBe(400);
    expect(await bad(file({ skills: [{ name: 'ok-name', description: 'd', markdown: 'x', approved: true }] }))).toBe(400);
    expect(await bad({})).toBe(400);
    expect(await bad(null)).toBe(400);
    const r = await fetch(base + '/api/bots/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file({ memory: 'x'.repeat(1_100_000) })) });
    expect(r.status).toBe(413);
  });
});
