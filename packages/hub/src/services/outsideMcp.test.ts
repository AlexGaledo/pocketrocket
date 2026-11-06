import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { outsideMcpFor } from './outsideMcp.js';

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
      { name: 'wika', url: 'https://dashboard.wikaph.com/api/mcp', token: 'k-123456789' },
      { name: 'local', url: 'http://127.0.0.1:9000/mcp', token: null },
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
