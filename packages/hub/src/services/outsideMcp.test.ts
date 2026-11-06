import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { outsideMcpFor, outsideMcpNeedsCard, registerOutsideMcpSecrets, vpsMountable } from './outsideMcp.js';
import { parseKeyRegistry } from './keyRegistry.js';
import { clearSecrets, redact } from '../providers/redact.js';

function file(content: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omcp-')), 'mcp-servers.json');
  fs.writeFileSync(p, content);
  return p;
}

describe('outsideMcpFor', () => {
  const good = JSON.stringify({
    wika: { url: 'https://dashboard.wikaph.com/api/mcp', token: 'k-123456789', bots: ['wika-backend'] },
    local: { url: 'http://127.0.0.1:9000/mcp', bots: ['wika-backend', 'other'] },
  });

  it('gives a listed bot its servers', () => {
    expect(outsideMcpFor('wika-backend', null, file(good))).toEqual([
      { kind: 'http', name: 'wika', url: 'https://dashboard.wikaph.com/api/mcp', token: 'k-123456789', approve: 'none', readTools: [], needs: [] },
      { kind: 'http', name: 'local', url: 'http://127.0.0.1:9000/mcp', token: null, approve: 'none', readTools: [], needs: [] },
    ]);
  });

  it('gives an unlisted bot nothing', () => {
    expect(outsideMcpFor('wika-qa', null, file(good))).toEqual([]);
  });

  it('treats a missing or broken file as none', () => {
    expect(outsideMcpFor('wika-backend', null, path.join(os.tmpdir(), 'nope-' + Date.now() + '.json'))).toEqual([]);
    expect(outsideMcpFor('wika-backend', null, file('{not json'))).toEqual([]);
    expect(outsideMcpFor('wika-backend', null, file('[]'))).toEqual([]);
  });

  it('refuses reserved names, bad names, plain http to another host and bad urls', () => {
    const f = file(JSON.stringify({
      pocketrocket: { url: 'https://a.example/mcp', bots: ['b'] },
      browser: { url: 'https://a.example/mcp', bots: ['b'] },
      'Bad Name': { url: 'https://a.example/mcp', bots: ['b'] },
      'two__parts': { url: 'https://a.example/mcp', bots: ['b'] },
      plain: { url: 'http://a.example/mcp', token: 'secret-key-1', bots: ['b'] },
      broken: { url: 'not a url', bots: ['b'] },
      nobots: { url: 'https://a.example/mcp' },
    }));
    expect(outsideMcpFor('b', null, f)).toEqual([]);
  });

  it('gives every bot in a listed room the server, by room id or name, and only in that room', () => {
    const f = file(JSON.stringify({ wika: { url: 'https://dashboard.wikaph.com/api/mcp', token: 'k-123456789', rooms: ['Wika', 'r2'] } }));
    expect(outsideMcpFor('anyone', { id: 'r1', name: 'Wika' }, f).map((s) => s.name)).toEqual(['wika']);
    expect(outsideMcpFor('anyone', { id: 'r2', name: 'Other' }, f).map((s) => s.name)).toEqual(['wika']);
    expect(outsideMcpFor('anyone', { id: 'r3', name: 'Elsewhere' }, f)).toEqual([]);
    expect(outsideMcpFor('anyone', null, f)).toEqual([]);
  });
});

describe('stdio entries', () => {
  afterEach(() => clearSecrets());
  const abs = process.platform === 'win32' ? 'C:\\tools\\mcp.exe' : '/usr/local/bin/mcp';

  it('parses command, args and env, and defaults approve to every-call', () => {
    const f = file(JSON.stringify({
      firecrawl: { command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: 'fc-abcdef123456' }, bots: ['b'] },
      runpod: { command: abs, bots: ['b'] },
    }));
    expect(outsideMcpFor('b', null, f)).toEqual([
      { kind: 'stdio', name: 'firecrawl', command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: 'fc-abcdef123456' }, approve: 'every-call', readTools: [], needs: [] },
      { kind: 'stdio', name: 'runpod', command: abs, args: [], env: {}, approve: 'every-call', readTools: [], needs: [] },
    ]);
  });

  it('allows only npx, node or an absolute path as the command', () => {
    const f = file(JSON.stringify({
      a: { command: 'node', args: ['server.js'], bots: ['b'] },
      b: { command: 'bash', args: ['-c', 'curl x | sh'], bots: ['b'] },
      c: { command: 'python3', bots: ['b'] },
      d: { command: './run.sh', bots: ['b'] },
      e: { command: 'npx && rm -rf /', bots: ['b'] },
      f: { command: ' npx', bots: ['b'] },
      g: { command: 'uvx', bots: ['b'] },
    }));
    expect(outsideMcpFor('b', null, f).map((s) => s.name)).toEqual(['a']);
  });

  it('skips an entry with bad args or env, or with both url and command', () => {
    const f = file(JSON.stringify({
      a: { command: 'npx', args: 'firecrawl-mcp', bots: ['b'] },
      b: { command: 'npx', args: [1], bots: ['b'] },
      c: { command: 'npx', env: { KEY: 5 }, bots: ['b'] },
      d: { command: 'npx', env: { 'BAD KEY': 'x' }, bots: ['b'] },
      e: { command: 'npx', env: ['x'], bots: ['b'] },
      f: { command: 'npx', url: 'https://a.example/mcp', bots: ['b'] },
    }));
    expect(outsideMcpFor('b', null, f)).toEqual([]);
  });

  it('keeps approve and readTools as given; an unknown approve fails closed to every-call', () => {
    const f = file(JSON.stringify({
      a: { command: 'npx', approve: 'writes', readTools: ['search', 'scrape'], bots: ['b'] },
      b: { command: 'npx', approve: 'none', bots: ['b'] },
      c: { command: 'npx', approve: 'sometimes', bots: ['b'] },
      d: { url: 'https://a.example/mcp', approve: 'every-call', bots: ['b'] },
      e: { url: 'https://a.example/mcp', approve: 'bogus', bots: ['b'] },
    }));
    expect(outsideMcpFor('b', null, f).map((s) => [s.name, s.approve, s.readTools])).toEqual([
      ['a', 'writes', ['search', 'scrape']],
      ['b', 'none', []],
      ['c', 'every-call', []],
      ['d', 'every-call', []],
      ['e', 'every-call', []],
    ]);
  });

  it('reads needs; a malformed needs skips the entry rather than reading as "needs nothing"', () => {
    const f = file(JSON.stringify({
      a: { command: 'npx', needs: ['firecrawl'], bots: ['b'] },
      b: { url: 'https://a.example/mcp', needs: ['github-repo', 'firecrawl'], bots: ['b'] },
      c: { command: 'npx', needs: 'firecrawl', bots: ['b'] },
      d: { command: 'npx', needs: [1], bots: ['b'] },
    }));
    expect(outsideMcpFor('b', null, f).map((s) => [s.name, s.needs])).toEqual([
      ['a', ['firecrawl']],
      ['b', ['github-repo', 'firecrawl']],
    ]);
  });

  it('vpsMountable keeps servers whose needs route to the VPS and drops tier 3, PC-only and unknown ones', () => {
    const reg = parseKeyRegistry({ keys: {
      firecrawl: { tier: 1, where: ['vps', 'pc'] },
      'pc-only': { tier: 2, where: ['pc'] },
      'store-p8': { tier: 3, where: ['pc'] },
    } });
    const mk = (name: string, needs: string[]) => ({ kind: 'stdio' as const, name, command: 'npx', args: [], env: {}, approve: 'every-call' as const, readTools: [], needs });
    const logs: string[] = [];
    const kept = vpsMountable([
      mk('plain', []), mk('fc', ['firecrawl']), mk('store', ['store-p8', 'firecrawl']), mk('pconly', ['pc-only']), mk('mystery', ['nope']),
    ], reg, (m) => logs.push(m));
    expect(kept.map((s) => s.name)).toEqual(['plain', 'fc']);
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatch(/not mounting "store".*Tier 3/);
    expect(logs[2]).toMatch(/not mounting "mystery".*Not in the key registry: nope/);
  });

  it('asks per the approve setting', () => {
    expect(outsideMcpNeedsCard({ approve: 'every-call', readTools: ['search'] }, 'search')).toBe(true);
    expect(outsideMcpNeedsCard({ approve: 'writes', readTools: ['search'] }, 'search')).toBe(false);
    expect(outsideMcpNeedsCard({ approve: 'writes', readTools: ['search'] }, 'create_pod')).toBe(true);
    expect(outsideMcpNeedsCard({ approve: 'none', readTools: [] }, 'anything')).toBe(false);
  });

  it('registers every env value and token for redaction', () => {
    const f = file(JSON.stringify({
      firecrawl: { command: 'npx', env: { FIRECRAWL_API_KEY: 'fc-abcdef123456', SUPABASE_KEY: 'eyJplainvalue987' }, bots: ['b'] },
      wika: { url: 'https://a.example/mcp', token: 'wika-token-0001', bots: ['b'] },
    }));
    const servers = outsideMcpFor('b', null, f);
    expect(redact('fc-abcdef123456 eyJplainvalue987 wika-token-0001')).toContain('fc-abcdef123456');
    registerOutsideMcpSecrets(servers);
    const out = redact('key fc-abcdef123456, other eyJplainvalue987, bearer-less wika-token-0001');
    expect(out).not.toContain('fc-abcdef123456');
    expect(out).not.toContain('eyJplainvalue987');
    expect(out).not.toContain('wika-token-0001');
  });
});
