import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { DATA_ENGINEER_HANDLE, SUPPORT_HANDLE, seedDefaultBots, supportSourceDirs } from './SeedBots.js';

function setup(withSource = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-seed-'));
  const root = path.join(dir, 'app');
  if (withSource) {
    fs.mkdirSync(path.join(root, 'packages', 'hub', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'));
    fs.mkdirSync(path.join(root, 'data'));
  }
  const repos = new Repos(new Db(':memory:'));
  const identities = new Map<string, string>();
  const memory = { ensureHome: () => undefined, writeIdentity: (id: string, text: string) => { identities.set(id, text); } };
  return { repos, root, memory, identities, opts: { root, dataDir: path.join(dir, 'data'), workspace: path.join(dir, 'ws') } };
}

describe('default bots', () => {
  it('creates Support and Data Engineer once, each with a DM', () => {
    const s = setup();
    expect(seedDefaultBots(s.repos, s.memory, s.opts).map((b) => b.handle)).toEqual([SUPPORT_HANDLE, DATA_ENGINEER_HANDLE]);
    expect(s.repos.listRooms().filter((r) => r.kind === 'dm')).toHaveLength(2);
    expect([...s.identities.values()].every((t) => t.split('\n').length > 2)).toBe(true);
    expect(seedDefaultBots(s.repos, s.memory, s.opts)).toEqual([]);
    expect(s.repos.listBots()).toHaveLength(2);
  });

  it('does not bring back a bot the user deleted', () => {
    const s = setup();
    const [support] = seedDefaultBots(s.repos, s.memory, s.opts);
    s.repos.deleteBot(support.id);
    expect(seedDefaultBots(s.repos, s.memory, s.opts)).toEqual([]);
    expect(s.repos.listBots().map((b) => b.handle)).toEqual([DATA_ENGINEER_HANDLE]);
  });

  it('skips an install with no source on disk', () => {
    const s = setup(false);
    expect(seedDefaultBots(s.repos, s.memory, s.opts)).toEqual([]);
  });

  it('gives each seeded bot its own icon', () => {
    const s = setup();
    const made = seedDefaultBots(s.repos, s.memory, s.opts);
    expect(Object.fromEntries(made.map((b) => [b.handle, b.avatar]))).toEqual({ [SUPPORT_HANDLE]: 'shield', [DATA_ENGINEER_HANDLE]: 'database' });
  });

  it('leaves a user bot with the same handle alone', () => {
    const s = setup();
    s.repos.createBot({ name: 'Mine', handle: SUPPORT_HANDLE, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    expect(seedDefaultBots(s.repos, s.memory, s.opts).map((b) => b.handle)).toEqual([DATA_ENGINEER_HANDLE]);
  });

  describe('the Data Engineer nightly routine', () => {
    const routines = (s: ReturnType<typeof setup>) => s.repos.listRoutines();
    const marker = (s: ReturnType<typeof setup>, name: string) => path.join(s.opts.dataDir, '.seeded-bots', name);

    it('is created once, enabled, in the bot DM, read-only and naming the workspace', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toHaveLength(1);
      const [r] = routines(s);
      const bot = s.repos.listBots().find((b) => b.handle === DATA_ENGINEER_HANDLE)!;
      const room = s.repos.getRoom(r.roomId)!;
      expect(r).toMatchObject({ botId: bot.id, enabled: true, cron: '0 3 * * *', onceAt: null });
      expect(room.kind).toBe('dm');
      expect(room.memberIds).toEqual([bot.id]);
      expect(r.prompt).toContain('Nightly workspace check for ' + s.opts.workspace);
      expect(r.prompt).toContain('READ-ONLY');
      expect(r.prompt).toContain('NO_REPLY');
      expect(r.prompt).not.toContain('{{');
    });

    it('reaches a server whose bot was seeded before the routine existed', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      // The state of that server: the bot and its marker are there, the routine and its marker are not.
      s.repos.deleteRoutine(routines(s)[0].id);
      fs.rmSync(marker(s, DATA_ENGINEER_HANDLE + '.routine'));
      const bots = s.repos.listBots().length;
      expect(seedDefaultBots(s.repos, s.memory, s.opts)).toEqual([]);
      expect(routines(s)).toHaveLength(1);
      expect(s.repos.listBots()).toHaveLength(bots);
    });

    it('does not bring back a routine the owner deleted', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      s.repos.deleteRoutine(routines(s)[0].id);
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);
    });

    it('makes nothing for a bot the owner deleted, then or later', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      const bot = s.repos.listBots().find((b) => b.handle === DATA_ENGINEER_HANDLE)!;
      s.repos.deleteRoutine(routines(s)[0].id);
      s.repos.deleteBot(bot.id);
      fs.rmSync(marker(s, DATA_ENGINEER_HANDLE + '.routine'));
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);
      expect(fs.existsSync(marker(s, DATA_ENGINEER_HANDLE + '.routine'))).toBe(true);
    });

    it('does not recreate a DM the owner deleted', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      const r = routines(s)[0];
      s.repos.deleteRoutine(r.id);
      s.repos.deleteRoom(r.roomId);
      fs.rmSync(marker(s, DATA_ENGINEER_HANDLE + '.routine'));
      const rooms = s.repos.listRooms().length;
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);
      expect(s.repos.listRooms()).toHaveLength(rooms);
    });

    it('leaves a user bot on the same handle alone, on first seed and on upgrade', () => {
      const s = setup();
      const own = () => s.repos.createBot({ name: 'Data Engineer', handle: DATA_ENGINEER_HANDLE, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
      const mine = own();
      s.repos.createRoom({ kind: 'dm', name: 'x', memberIds: [mine.id], coordinatorBotId: null });
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);

      const u = setup();
      seedDefaultBots(u.repos, u.memory, u.opts);
      const seeded = u.repos.listBots().find((b) => b.handle === DATA_ENGINEER_HANDLE)!;
      u.repos.updateBot(seeded.id, { name: 'Mine' });
      u.repos.deleteRoutine(routines(u)[0].id);
      fs.rmSync(marker(u, DATA_ENGINEER_HANDLE + '.routine'));
      seedDefaultBots(u.repos, u.memory, u.opts);
      expect(routines(u)).toEqual([]);
    });

    it('skips an install with no source on disk', () => {
      const s = setup(false);
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);
    });
  });

  it('never gives Support the data folder as a read root', () => {
    const s = setup();
    const dirs = supportSourceDirs(s.root);
    expect(dirs).toContain(path.join(s.root, 'docs'));
    expect(dirs).not.toContain(path.join(s.root, 'data'));
  });
});
