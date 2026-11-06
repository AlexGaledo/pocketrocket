import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { keyRegistryNote, loadKeyRegistry, parseKeyRegistry, routeByNeeds } from './keyRegistry.js';

const reg = parseKeyRegistry({
  keys: {
    public: { tier: 0, where: ['vps', 'pc'] },
    firecrawl: { tier: 1, where: ['vps', 'pc'], service: 'Firecrawl' },
    'supabase-ro': { tier: 1, where: ['vps'] },
    'github-repo': { tier: 2, where: ['vps', 'pc'] },
    'runpod': { tier: 2, where: ['pc'] },
    'store-p8': { tier: 3, where: ['pc'] },
    'stripe-live': { tier: 3, where: ['pc'], notes: 'payments' },
    'nowhere': { tier: 2, where: [] },
    'vault-only': { tier: 3, where: [] },
  },
});

describe('parseKeyRegistry', () => {
  it('keeps valid entries, names only', () => {
    expect(reg.get('firecrawl')).toEqual({ tier: 1, where: ['vps', 'pc'], service: 'Firecrawl' });
    expect(reg.get('stripe-live')).toEqual({ tier: 3, where: ['pc'], notes: 'payments' });
    expect(reg.size).toBe(9);
  });

  it('rejects a tier 3 key that lists the VPS, and logs it once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doc = { keys: { 'gh-admin': { tier: 3, where: ['vps', 'pc'] }, ok: { tier: 3, where: ['pc'] } } };
    const r = parseKeyRegistry(doc);
    parseKeyRegistry(doc);
    expect(r.has('gh-admin')).toBe(false);
    expect(r.has('ok')).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('gh-admin'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('skips malformed entries without failing the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = parseKeyRegistry({
      keys: {
        'Bad Name': { tier: 1, where: ['vps'] },
        tier9: { tier: 9, where: ['vps'] },
        tierstr: { tier: '1', where: ['vps'] },
        wherebad: { tier: 1, where: ['cloud'] },
        wherestr: { tier: 1, where: 'vps' },
        notobj: 5,
        good: { tier: 1, where: ['vps', 'vps'] },
      },
    });
    expect([...r.keys()]).toEqual(['good']);
    expect(r.get('good')!.where).toEqual(['vps']);
    warn.mockRestore();
  });

  it('treats a missing, broken or wrong-shaped file as empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyreg-'));
    expect(loadKeyRegistry(path.join(dir, 'absent.json')).size).toBe(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
    expect(loadKeyRegistry(path.join(dir, 'broken.json')).size).toBe(0);
    warn.mockRestore();
    expect(parseKeyRegistry([]).size).toBe(0);
    expect(parseKeyRegistry({ keys: [] }).size).toBe(0);
    expect(parseKeyRegistry(null).size).toBe(0);
  });

  it('re-reads the file on every load (hot reload)', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keyreg-')), 'key-registry.json');
    fs.writeFileSync(f, JSON.stringify({ keys: { a: { tier: 1, where: ['vps'] } } }));
    expect(routeByNeeds(loadKeyRegistry(f), ['a'], false).place).toBe('vps');
    fs.writeFileSync(f, JSON.stringify({ keys: { a: { tier: 1, where: ['pc'] } } }));
    expect(routeByNeeds(loadKeyRegistry(f), ['a'], true).place).toBe('pc');
  });
});

describe('routeByNeeds', () => {
  it('no needs: the VPS', () => {
    expect(routeByNeeds(reg, [], false)).toEqual({ place: 'vps', reason: 'No keys needed.', missing: [] });
    expect(routeByNeeds(reg, ['  '], true).place).toBe('vps');
  });

  it('every need on the VPS: the VPS, even with a paired PC that also has them', () => {
    expect(routeByNeeds(reg, ['firecrawl', 'github-repo', 'public'], true)).toMatchObject({ place: 'vps', missing: [] });
    expect(routeByNeeds(reg, ['supabase-ro'], false).place).toBe('vps');
  });

  it('a tier 3 need goes to the PC, even when the rest are on the VPS', () => {
    expect(routeByNeeds(reg, ['store-p8'], true)).toMatchObject({ place: 'pc', missing: [] });
    expect(routeByNeeds(reg, ['firecrawl', 'stripe-live'], true)).toMatchObject({ place: 'pc', missing: [] });
  });

  it('a tier 3 need is blocked, never the VPS, when no runner is paired', () => {
    const r = routeByNeeds(reg, ['store-p8', 'firecrawl'], false);
    expect(r.place).toBe('blocked');
    expect(r.reason).toMatch(/no PC runner is paired/);
    expect(r.missing).toEqual([]);
  });

  it('a tier 3 need with a key the PC lacks is blocked, listing it', () => {
    expect(routeByNeeds(reg, ['store-p8', 'supabase-ro'], true)).toMatchObject({ place: 'blocked', missing: ['supabase-ro'] });
    expect(routeByNeeds(reg, ['vault-only'], true)).toMatchObject({ place: 'blocked', missing: ['vault-only'] });
  });

  it('not all on the VPS, all on the PC, runner paired: the PC', () => {
    expect(routeByNeeds(reg, ['runpod', 'firecrawl'], true)).toMatchObject({ place: 'pc', missing: [] });
  });

  it('not all on the VPS, all on the PC, runner not paired: blocked', () => {
    const r = routeByNeeds(reg, ['runpod'], false);
    expect(r).toMatchObject({ place: 'blocked', missing: [] });
    expect(r.reason).toMatch(/no PC runner is paired/);
  });

  it('split across places: blocked, listing what the PC lacks', () => {
    expect(routeByNeeds(reg, ['runpod', 'supabase-ro'], true)).toMatchObject({ place: 'blocked', missing: ['supabase-ro'] });
    expect(routeByNeeds(reg, ['nowhere'], true)).toMatchObject({ place: 'blocked', missing: ['nowhere'] });
  });

  it('an unknown name is blocked, never guessed, whatever else is asked for', () => {
    expect(routeByNeeds(reg, ['made-up'], true)).toMatchObject({ place: 'blocked', missing: ['made-up'] });
    // Unknown wins over tier 3 and over an all-VPS set.
    expect(routeByNeeds(reg, ['store-p8', 'made-up'], true)).toMatchObject({ place: 'blocked', missing: ['made-up'] });
    expect(routeByNeeds(reg, ['firecrawl', 'Firecrawl'], true)).toMatchObject({ place: 'blocked', missing: ['Firecrawl'] });
    expect(routeByNeeds(new Map(), ['firecrawl'], true)).toMatchObject({ place: 'blocked', missing: ['firecrawl'] });
  });

  it('dedupes and trims needs', () => {
    expect(routeByNeeds(reg, ['made-up', ' made-up ', 'made-up'], true).missing).toEqual(['made-up']);
  });

  it('is deterministic: same inputs, same answer, any order', () => {
    const a = routeByNeeds(reg, ['runpod', 'firecrawl', 'github-repo'], true);
    const b = routeByNeeds(reg, ['github-repo', 'runpod', 'firecrawl'], true);
    expect(a.place).toBe(b.place);
  });
});

describe('keyRegistryNote', () => {
  it('lists names and tiers per place and points at where_to_run; nothing when empty', () => {
    const note = keyRegistryNote(reg, 'mcp__pocketrocket__')!;
    expect(note).toContain('On the VPS: public (tier 0), firecrawl (tier 1), supabase-ro (tier 1), github-repo (tier 2).');
    expect(note).toContain('store-p8 (tier 3)');
    expect(note).toContain('mcp__pocketrocket__where_to_run');
    expect(keyRegistryNote(new Map())).toBeNull();
  });
});
