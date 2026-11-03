import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, ServerEvent } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { ComputersRepo } from '../db/computers.js';
import { events } from '../events.js';
import {
  AlwaysOnRefused, ComputerManager, MAX_SLOT, SLOT_BASE, duBytes, slotPorts, unitName, type ComputerManagerOptions, type Systemctl,
} from './ComputerManager.js';

/** In-memory systemd: records every call and tracks which units are active. */
class FakeSystemctl implements Systemctl {
  active = new Set<string>();
  calls: string[] = [];
  failStart = false;
  async start(unit: string) {
    this.calls.push('start ' + unit);
    if (this.failStart) throw new Error('Unit not found');
    this.active.add(unit);
  }
  async stop(unit: string) {
    this.calls.push('stop ' + unit);
    this.active.delete(unit);
  }
  async isActive(unit: string) {
    return this.active.has(unit);
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-computers-'));
  tmpDirs.push(d);
  return d;
}

function setup(opts: ComputerManagerOptions = {}) {
  const repo = new ComputersRepo(new Db(':memory:'));
  const sys = new FakeSystemctl();
  let now = 1_000_000;
  const data = tmp();
  const cm = new ComputerManager(repo, {
    enabled: true, maxRunning: 3, idleMs: 30 * 60_000, quotaBytes: 1000,
    dir: path.join(data, 'computers'), dataDir: data,
    systemctl: sys, probe: async () => true, diskUsage: async () => 0, now: () => now, startTimeoutMs: 50, pollMs: 1,
    ...opts,
  });
  return { cm, repo, sys, data, advance: (ms: number) => (now += ms), at: () => now };
}

const bot = (id: string, tools: string[] = ['Browser'], createdAt = 0): Bot => ({
  id, name: id, handle: id.toLowerCase(), title: '', description: '', avatar: '🤖', model: 'm', allowedTools: tools,
  maxBudgetUsd: 1, autoMemory: false, autoMemoryEvery: 10, createdAt,
});

describe('slots', () => {
  it('maps a slot to its own display and loopback ports', () => {
    expect(slotPorts(1)).toEqual({ slot: 1, display: ':201', cdpPort: 9401, vncPort: 5801, novncPort: 6201 });
    expect(() => slotPorts(0)).toThrow();
    expect(() => slotPorts(MAX_SLOT + 1)).toThrow();
  });

  it('never collides with the shared screen, the retired Crew fork, X11 TCP or the spec-sketch ranges', () => {
    const reserved = new Set([98, 99, 9222, 9223, 5900, 5901, 6080, 6081]);
    const seen = new Set<number>();
    for (let n = 1; n <= MAX_SLOT; n++) {
      const p = slotPorts(n);
      const disp = Number(p.display.slice(1));
      for (const v of [disp, p.cdpPort, p.vncPort, p.novncPort]) {
        expect(reserved.has(v), String(v)).toBe(false);
        expect(seen.has(v), 'duplicate ' + v).toBe(false);
        seen.add(v);
      }
      expect(p.vncPort >= 6000 && p.vncPort <= 6063).toBe(false);
      expect(p.novncPort >= 6000 && p.novncPort <= 6063).toBe(false);
      // The upstream sketch (:100+n, 9300+n, 5910+n, 6100+n) stays free for a stock install.
      expect(disp >= 100 && disp < 200).toBe(false);
      expect(p.cdpPort >= 9300 && p.cdpPort < 9400).toBe(false);
    }
    expect(SLOT_BASE.display + MAX_SLOT).toBeLessThan(300);
  });

  it('builds unit names only from safe ids', () => {
    expect(unitName(3, 'Ab_c-1')).toBe('pocketrocket-computer@3-Ab_c-1.service');
    for (const bad of ['a b', 'a;rm', '../x', '', 'a.service']) expect(() => unitName(1, bad), bad).toThrow();
  });
});

describe('ComputerManager', () => {
  it('is the legacy shared screen when per-bot computers are off (local mode)', async () => {
    const { cm, sys, repo } = setup({ enabled: false });
    const ep = cm.endpoint('b1');
    expect(ep.perBot).toBe(false);
    expect(ep.slot).toBeNull();
    const r = await cm.acquire('b1');
    expect(r.ok).toBe(true);
    r.release();
    expect(sys.calls).toEqual([]);
    expect(repo.list()).toEqual([]);
    expect(cm.status('b1')).toMatchObject({ perBot: false, slot: null });
  });

  it('allocates the lowest free slot once per bot and keeps it', () => {
    const { cm, repo } = setup();
    expect(cm.endpoint('a').slot).toBe(1);
    expect(cm.endpoint('b').slot).toBe(2);
    expect(cm.endpoint('a').slot).toBe(1);
    repo.remove('a');
    expect(cm.endpoint('c').slot).toBe(1);
  });

  it('gives each bot its own display, cookie, profile home and CDP port', () => {
    const { cm } = setup();
    const a = cm.endpoint('a');
    const b = cm.endpoint('b');
    expect(a.display).not.toBe(b.display);
    expect(a.cdpUrl).not.toBe(b.cdpUrl);
    expect(a.xauthority).not.toBe(b.xauthority);
    expect(a.cdpUrl).toBe('http://127.0.0.1:9401');
    expect(a.screenUrl).toBe('http://127.0.0.1:6201');
    expect(a.filesDir!.endsWith(path.join('a', 'files'))).toBe(true);
  });

  it('starts lazily on first use, once, and reports starting then live', async () => {
    const { cm, sys } = setup();
    const seen: string[] = [];
    const off = events.onEvent((e: ServerEvent) => { if (e.type === 'computer.state' && e.status.botId === 'a') seen.push(e.status.state); });
    expect(cm.status('a').state).toBe('asleep');
    const [r1, r2] = await Promise.all([cm.ensureRunning('a'), cm.ensureRunning('a')]);
    off();
    expect(r1.ok && r2.ok).toBe(true);
    expect(sys.calls).toEqual(['start ' + unitName(1, 'a')]);
    expect(seen).toEqual(['starting', 'live']);
    expect(cm.status('a').state).toBe('live');
    // Already live: no second start.
    await cm.ensureRunning('a');
    expect(sys.calls.filter((c) => c.startsWith('start'))).toHaveLength(1);
  });

  it('restarts a computer whose unit died behind its back', async () => {
    const { cm, sys } = setup();
    await cm.ensureRunning('a');
    sys.active.clear();
    await cm.ensureRunning('a');
    expect(sys.calls.filter((c) => c.startsWith('start'))).toHaveLength(2);
  });

  it('reports a unit that fails to start, and one that never answers on CDP', async () => {
    const s1 = setup();
    s1.sys.failStart = true;
    const r = await s1.cm.ensureRunning('a');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('could not start');
    expect(s1.cm.status('a')).toMatchObject({ state: 'asleep', reason: expect.stringContaining('could not start') });

    const s2 = setup({ probe: async () => false });
    const r2 = await s2.cm.ensureRunning('a');
    expect(!r2.ok && r2.reason).toContain('did not come up');
    expect(s2.sys.active.size).toBe(0);
    expect(s2.cm.status('a').state).toBe('asleep');
  });

  it('stops an idle computer after the idle time, keeping its slot', async () => {
    const { cm, sys, advance } = setup();
    const r = await cm.acquire('a');
    r.release();
    advance(29 * 60_000);
    expect(await cm.sweep()).toEqual([]);
    advance(2 * 60_000);
    expect(await cm.sweep()).toEqual(['a']);
    expect(sys.active.size).toBe(0);
    expect(cm.status('a')).toMatchObject({ state: 'asleep', slot: 1 });
  });

  it('never idles out a computer that is in a turn, watched, kept awake, or has a routine due', async () => {
    let due = false;
    const { cm, advance } = setup({ routineDueSoon: () => due });
    const busy = await cm.acquire('busy');
    await cm.ensureRunning('watched');
    const close = cm.viewerOpened('watched');
    await cm.ensureRunning('awake');
    cm.setKeepAwake('awake', true);
    advance(60 * 60_000);
    expect(await cm.sweep()).toEqual([]);

    busy.release();
    close();
    due = true;
    advance(60 * 60_000);
    expect(await cm.sweep()).toEqual([]);
    due = false;
    expect((await cm.sweep()).sort()).toEqual(['busy', 'watched']);
    expect(cm.status('awake').state).toBe('live');
  });

  it('caps running computers and evicts the least recently used idle one', async () => {
    const { cm, sys, advance } = setup({ maxRunning: 2 });
    await cm.ensureRunning('a');
    advance(1000);
    await cm.ensureRunning('b');
    advance(1000);
    cm.touch('a'); // a used more recently than b
    await cm.ensureRunning('c');
    expect(cm.status('b').state).toBe('asleep');
    expect(cm.status('a').state).toBe('live');
    expect(cm.status('c').state).toBe('live');
    expect(sys.calls).toContain('stop ' + unitName(2, 'b'));
    expect(sys.active.size).toBe(2);
  });

  it('refuses to start past the cap when every running computer is in use', async () => {
    const { cm, sys } = setup({ maxRunning: 1 });
    const a = await cm.acquire('a');
    const r = await cm.ensureRunning('b');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('MAX_RUNNING_COMPUTERS=1');
    expect(sys.active.size).toBe(1);
    a.release();
    expect((await cm.ensureRunning('b')).ok).toBe(true);
    expect(cm.status('a').state).toBe('asleep');
  });

  it('cannot exceed the cap with concurrent starts', async () => {
    const { cm, sys } = setup({ maxRunning: 2 });
    const held = await Promise.all(['a', 'b', 'c', 'd'].map((id) => cm.acquire(id)));
    expect(held.filter((r) => r.ok)).toHaveLength(2);
    expect(sys.active.size).toBe(2);
  });

  it('applies the soft disk quota: no start at 100%, with the reason', async () => {
    let bytes = 500;
    const { cm, sys } = setup({ diskUsage: async () => bytes });
    await cm.ensureRunning('a');
    await cm.stop('a');
    await cm.refreshDisk();
    expect(cm.status('a').diskBytes).toBe(500);
    bytes = 1000;
    await cm.refreshDisk();
    const r = await cm.ensureRunning('a');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('disk is full');
    expect(sys.active.size).toBe(0);
  });

  it('reconciles state with systemd after a hub restart', async () => {
    const { cm, repo, sys } = setup();
    await cm.ensureRunning('a');
    await cm.ensureRunning('b');
    sys.active.delete(unitName(2, 'b'));
    repo.setState('c', 'live'); // no row: no-op
    await cm.reconcile();
    expect(cm.status('a').state).toBe('live');
    expect(cm.status('b').state).toBe('asleep');
  });

  it('stops and erases the computer of a deleted bot', async () => {
    const { cm, sys, data } = setup();
    await cm.ensureRunning('a');
    await cm.ensureRunning('b');
    const dirB = path.join(data, 'computers', 'b');
    fs.mkdirSync(path.join(dirB, 'files'), { recursive: true });
    expect(await cm.prune(['a'])).toEqual(['b']);
    expect(fs.existsSync(dirB)).toBe(false);
    expect(sys.active.has(unitName(2, 'b'))).toBe(false);
    expect(cm.status('b').slot).toBeNull();
    expect(cm.status('a').state).toBe('live');
  });

  it('moves the legacy profile and desktop home to the first Browser bot, once', async () => {
    const { cm, data } = setup();
    fs.mkdirSync(path.join(data, 'browser-profile', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(data, 'browser-profile', 'Default', 'Cookies'), 'logins');
    fs.mkdirSync(path.join(data, 'desktop-home', '.config'), { recursive: true });
    const bots = [bot('late', ['Browser'], 20), bot('nobrowser', ['Read'], 1), bot('early', ['Browser', 'Desktop'], 10)];

    expect(await cm.migrateLegacy(bots, async () => true)).toBeNull(); // shared screen still running
    expect(fs.existsSync(path.join(data, 'browser-profile'))).toBe(true);

    expect(await cm.migrateLegacy(bots, async () => false)).toBe('early');
    expect(fs.readFileSync(path.join(data, 'computers', 'early', 'browser', 'Default', 'Cookies'), 'utf8')).toBe('logins');
    expect(fs.existsSync(path.join(data, 'computers', 'early', 'home', '.config'))).toBe(true);
    expect(fs.existsSync(path.join(data, 'browser-profile'))).toBe(false);
    expect(cm.status('early').slot).toBe(1);

    fs.mkdirSync(path.join(data, 'browser-profile'));
    expect(await cm.migrateLegacy(bots, async () => false)).toBeNull();
  });

  it('leaves the legacy profile alone when no bot has Browser, or when off', async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.data, 'browser-profile'));
    expect(await s.cm.migrateLegacy([bot('x', ['Read'])], async () => false)).toBeNull();
    expect(fs.existsSync(path.join(s.data, 'browser-profile'))).toBe(true);
    const off = setup({ enabled: false });
    fs.mkdirSync(path.join(off.data, 'browser-profile'));
    expect(await off.cm.migrateLegacy([bot('x')], async () => false)).toBeNull();
  });
});

describe('warm start', () => {
  const GB = 1024 ** 3;
  const used = async (cm: ComputerManager, advance: (ms: number) => void, ...ids: string[]) => {
    for (const id of ids) {
      (await cm.acquire(id)).release();
      advance(1000);
    }
  };

  it('wakes the focused bot and the most recent other one, leaving a place free', async () => {
    const { cm, advance } = setup({ memAvailable: () => 4 * GB });
    for (const id of ['a', 'b', 'c', 'd']) cm.endpoint(id);
    await used(cm, advance, 'a', 'b', 'c');
    for (const id of ['a', 'b', 'c']) await cm.stop(id);
    expect(await cm.warm('d')).toEqual(['d', 'c']);
    expect(cm.status('b').state).toBe('asleep');
    expect(cm.status('a').state).toBe('asleep');
  });

  it('never evicts, however often it is called, and a full pool is left alone', async () => {
    const { cm, sys, advance } = setup({ memAvailable: () => 4 * GB });
    await used(cm, advance, 'a', 'b');
    advance(60 * 60_000);
    for (let i = 0; i < 5; i++) expect(await cm.warm('c')).toEqual([]);
    expect(sys.calls.filter((c) => c.startsWith('stop'))).toEqual([]);
    expect(cm.status('c').state).toBe('asleep');
  });

  it('leaves out bots without Browser or Desktop and never-used computers', async () => {
    const { cm } = setup({ memAvailable: () => 4 * GB });
    cm.wire({ usesComputer: (id) => id !== 'chat' });
    cm.endpoint('never');
    expect(await cm.warm('chat')).toEqual([]);
    expect(cm.status('chat').state).toBe('asleep');
    expect(cm.status('never').state).toBe('asleep');
  });

  it('stops on low memory, but a real turn still gets its computer', async () => {
    let mem = 1.5 * GB;
    const { cm } = setup({ memAvailable: () => mem });
    expect(await cm.warm('a')).toEqual([]);
    const r = await cm.wakeFocused('a');
    expect(r.ok).toBe(false);
    expect(cm.status('a')).toMatchObject({ state: 'asleep', reason: expect.stringContaining('low on memory') });
    const turn = await cm.acquire('a');
    expect(turn.ok).toBe(true);
    turn.release();
    expect(cm.status('a')).toMatchObject({ state: 'live' });
    expect(cm.status('a').reason).toBeUndefined();
    mem = 1.7 * GB;
    expect(await cm.warm('b')).toEqual(['b']);
  });

  it('an unreadable meminfo does not block a start', async () => {
    const { cm } = setup({ memAvailable: () => null });
    expect(await cm.warm('a')).toEqual(['a']);
  });

  it('selecting a bot takes the last place, and evicts only a cold computer', async () => {
    const { cm, sys, advance } = setup({ memAvailable: () => 4 * GB });
    await used(cm, advance, 'a', 'b');
    expect((await cm.wakeFocused('c')).ok).toBe(true);
    const clicked = await cm.wakeFocused('d');
    expect(clicked.ok).toBe(false);
    expect(cm.status('d').reason).toContain('Try again');
    expect(sys.calls.filter((c) => c.startsWith('stop'))).toEqual([]);
    advance(3 * 60_000);
    expect((await cm.wakeFocused('d')).ok).toBe(true);
    expect(cm.status('a').state).toBe('asleep');
    expect(cm.status('d').reason).toBeUndefined();
  });

  it('clicking around cannot evict in a loop', async () => {
    const { cm, sys, advance } = setup({ memAvailable: () => 4 * GB });
    await used(cm, advance, 'a', 'b', 'c');
    advance(3 * 60_000);
    const ring = ['d', 'e', 'a', 'b', 'c', 'd', 'e', 'a', 'b', 'c', 'd', 'e'];
    for (const id of ring) {
      await cm.wakeFocused(id);
      advance(1500);
    }
    // Everything that started counts as used, so nothing it started is cold yet: at most the three old ones go.
    expect(sys.calls.filter((c) => c.startsWith('stop')).length).toBeLessThanOrEqual(3);
    expect(sys.active.size).toBe(3);
  });

  it('never evicts a computer a person controls, a bot is using or someone is watching', async () => {
    const held = new Set(['held']);
    const { cm, advance } = setup({ maxRunning: 3, memAvailable: () => 4 * GB });
    cm.wire({ personHolds: (id) => held.has(id) });
    await cm.ensureRunning('held');
    const turn = await cm.acquire('busy');
    await cm.ensureRunning('watched');
    const close = cm.viewerOpened('watched');
    advance(60 * 60_000);
    for (const r of [await cm.wakeFocused('x'), await cm.ensureRunning('y')]) expect(r.ok).toBe(false);
    expect(cm.status('held').state).toBe('live');
    expect(cm.status('busy').state).toBe('live');
    expect(cm.status('watched').state).toBe('live');
    turn.release();
    close();
  });
});

describe('Always on', () => {
  const bots = (...ids: string[]) => ids.map((id) => bot(id));
  /** A second manager over the same database, as after a restart, on a machine whose units all died. */
  const reboot = (s: ReturnType<typeof setup>, opts: ComputerManagerOptions = {}) => {
    s.sys.active.clear();
    return new ComputerManager(s.repo, {
      enabled: true, maxRunning: 3, dir: path.join(s.data, 'computers'), dataDir: s.data, systemctl: s.sys, probe: async () => true,
      diskUsage: async () => 0, now: s.at, startTimeoutMs: 50, pollMs: 1, memAvailable: () => 4 * 1024 ** 3, ...opts,
    });
  };

  it('starts when switched on', async () => {
    const { cm } = setup();
    expect(cm.setKeepAwake('a', true).keepAwake).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(cm.status('a')).toMatchObject({ state: 'live', alwaysOn: { used: 1, limit: 2 } });
  });

  it('refuses past cap - 1, and turning one off makes room', () => {
    const { cm } = setup();
    cm.setKeepAwake('a', true);
    cm.setKeepAwake('b', true);
    expect(() => cm.setKeepAwake('c', true)).toThrow(AlwaysOnRefused);
    expect(() => cm.setKeepAwake('c', true)).toThrow(/Only 2 can be Always on/);
    expect(cm.status('c').keepAwake).toBe(false);
    cm.setKeepAwake('a', true); // already on: not a new one
    cm.setKeepAwake('a', false);
    expect(cm.setKeepAwake('c', true).keepAwake).toBe(true);
  });

  it('refuses outright with one computer at a time, and for a bot with no computer', () => {
    expect(() => setup({ maxRunning: 1 }).cm.setKeepAwake('a', true)).toThrow(/one computer at a time/);
    const s = setup();
    s.cm.wire({ usesComputer: () => false });
    expect(() => s.cm.setKeepAwake('a', true)).toThrow(/no Browser or Desktop/);
  });

  it('comes back after a server reboot; a computer that was not Always on does not', async () => {
    const s = setup();
    await s.cm.ensureRunning('a');
    await s.cm.ensureRunning('b');
    s.cm.setKeepAwake('a', true);
    const after = reboot(s);
    await after.startBackground(bots('a', 'b'));
    after.stopBackground();
    expect(after.status('a').state).toBe('live');
    expect(after.status('b').state).toBe('asleep');
  });

  it('leaves extras from a lowered cap asleep, with a reason, and does not protect them', async () => {
    const s = setup();
    s.cm.setKeepAwake('a', true);
    s.cm.setKeepAwake('b', true);
    await new Promise((r) => setTimeout(r, 20));
    const after = reboot(s, { maxRunning: 2 });
    await after.startBackground(bots('a', 'b'));
    after.stopBackground();
    const states = [after.status('a'), after.status('b')];
    expect(states.filter((c) => c.state === 'live')).toHaveLength(1);
    expect(states.find((c) => c.state === 'asleep')!.reason).toContain('only 1 fit');
  });

  it('holds back on low memory, and waits after a failed start instead of spinning', async () => {
    const s = setup();
    s.cm.setKeepAwake('a', true);
    await new Promise((r) => setTimeout(r, 20));
    let mem = 1024 ** 3;
    const low = reboot(s, { memAvailable: () => mem });
    await low.reconcile();
    expect(await low.restoreAlwaysOn()).toEqual([]);
    expect(low.status('a').reason).toContain('low on memory');
    mem = 4 * 1024 ** 3;
    s.sys.failStart = true;
    expect(await low.restoreAlwaysOn()).toEqual([]);
    const tried = s.sys.calls.length;
    expect(await low.restoreAlwaysOn()).toEqual([]);
    expect(s.sys.calls.length).toBe(tried);
    s.advance(3 * 60_000);
    s.sys.failStart = false;
    expect(await low.restoreAlwaysOn()).toEqual(['a']);
  });
});

describe('duBytes', () => {
  it('counts files and skips symlinks (so ~/Shared is not charged to the bot)', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'files', 'Downloads'), { recursive: true });
    fs.writeFileSync(path.join(d, 'files', 'Downloads', 'a.bin'), Buffer.alloc(300));
    fs.writeFileSync(path.join(d, 'b.bin'), Buffer.alloc(200));
    const shared = tmp();
    fs.writeFileSync(path.join(shared, 'big.bin'), Buffer.alloc(5000));
    try {
      fs.symlinkSync(shared, path.join(d, 'files', 'Shared'), 'junction');
    } catch {
      /* no symlink privilege on this machine: the count below still holds */
    }
    expect(await duBytes(d)).toBe(500);
    expect(await duBytes(path.join(d, 'missing'))).toBe(0);
  });
});
