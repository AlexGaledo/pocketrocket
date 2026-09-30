import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PeerClient, PeerError, PeerHost, parsePeerEnv, type PeerConfig } from './PeerService.js';
import { PEER_PREFIX, handlePeer } from '../api/peer.js';
import { createPeerTools } from '../agent/peerTools.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-peer-'));
const ws = path.join(tmp, 'workspace');
const extra = path.join(tmp, 'extra');
const secret = path.join(tmp, 'secret');
for (const d of [ws, extra, secret]) fs.mkdirSync(d);
fs.writeFileSync(path.join(ws, 'a.txt'), 'hello peer');
fs.mkdirSync(path.join(ws, 'sub'));
fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([1, 0, 2]));
fs.writeFileSync(path.join(extra, 'e.txt'), 'extra');
fs.writeFileSync(path.join(secret, 's.txt'), 'nope');
fs.symlinkSync(secret, path.join(ws, 'escape'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cfg = (over: Partial<PeerConfig> = {}): PeerConfig =>
  ({ name: 'vps', url: null, token: null, acceptToken: 'peer-secret', readRoots: [], allowRun: false, ...over });
const status = (f: () => unknown) => {
  try { f(); } catch (e) { return (e as PeerError).status; }
  return 0;
};

describe('parsePeerEnv', () => {
  it('is fully off by default', () => {
    const c = parsePeerEnv({});
    expect(c).toMatchObject({ url: null, token: null, acceptToken: null, readRoots: [], allowRun: false });
    expect(new PeerHost(c, ws).enabled).toBe(false);
    expect(new PeerClient(c).enabled).toBe(false);
  });
  it('reads the link settings', () => {
    const c = parsePeerEnv({
      POCKETROCKET_PEER_URL: 'http://127.0.0.1:7789/', POCKETROCKET_PEER_TOKEN: 't', POCKETROCKET_PEER_NAME: 'My VPS',
      POCKETROCKET_PEER_ACCEPT_TOKEN: 'a', POCKETROCKET_PEER_READ_ROOTS: ['/x', '/y'].join(path.delimiter), POCKETROCKET_PEER_RUN: 'yes',
    });
    expect(c).toEqual({ name: 'My VPS', url: 'http://127.0.0.1:7789', token: 't', acceptToken: 'a', readRoots: ['/x', '/y'], allowRun: true });
  });
});

describe('PeerHost', () => {
  const host = new PeerHost(cfg(), ws);
  it('lists and reads inside the workspace, relative or absolute', () => {
    const names = host.listDir('.').entries.map((e) => e.name + ':' + e.type);
    expect(names).toContain('a.txt:file');
    expect(names).toContain('sub:dir');
    expect(host.readFile('a.txt').text).toBe('hello peer');
    expect(host.readFile(path.join(ws, 'a.txt'), 6, 4)).toMatchObject({ text: 'peer', offset: 6, truncated: false });
    expect(host.readFile('a.txt', 0, 5)).toMatchObject({ text: 'hello', truncated: true });
  });
  it('refuses everything outside the shared folders, including .. and symlink escapes', () => {
    expect(status(() => host.readFile(path.join(secret, 's.txt')))).toBe(403);
    expect(status(() => host.readFile('../secret/s.txt'))).toBe(403);
    expect(status(() => host.readFile('escape/s.txt'))).toBe(403);
    expect(status(() => host.listDir(extra))).toBe(403);
  });
  it('opens extra folders only when they are configured', () => {
    expect(new PeerHost(cfg({ readRoots: [extra] }), ws).readFile(path.join(extra, 'e.txt')).text).toBe('extra');
  });
  it('reads text only and reports missing files', () => {
    expect(status(() => host.readFile('bin.dat'))).toBe(415);
    expect(status(() => host.readFile('missing.txt'))).toBe(404);
    expect(status(() => host.readFile('sub'))).toBe(400);
  });
  it('runs commands only when switched on, inside a shared folder', async () => {
    expect(status(() => host.run('echo hi'))).toBe(403);
    const runner = new PeerHost(cfg({ allowRun: true }), ws);
    const r = await runner.run('echo hi && exit 3');
    expect(r.stdout.trim()).toBe('hi');
    expect(r.exitCode).toBe(3);
    expect(status(() => runner.run('echo hi', secret))).toBe(403);
  });
});

describe('peer API + client + tools', () => {
  let server: http.Server;
  let base = '';
  let host = new PeerHost(cfg({ allowRun: true }), ws);
  const authResults: boolean[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        expect(url.pathname.startsWith(PEER_PREFIX)).toBe(true);
        void handlePeer(req, res, url, raw ? JSON.parse(raw) : undefined, host).then((ok) => authResults.push(ok));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('rejects a wrong token and reports it for rate limiting', async () => {
    const bad = new PeerClient(cfg({ url: base, token: 'wrong' }));
    await expect(bad.call('info')).rejects.toMatchObject({ status: 401 });
    expect(authResults.at(-1)).toBe(false);
  });
  it('answers 404 when this hub accepts no peer', async () => {
    const saved = host;
    host = new PeerHost(cfg({ acceptToken: null }), ws);
    await expect(new PeerClient(cfg({ url: base, token: 'peer-secret' })).call('info')).rejects.toMatchObject({ status: 404 });
    host = saved;
  });
  it('serves a linked client end to end through the bot tools', async () => {
    const client = new PeerClient(cfg({ url: base, token: 'peer-secret' }));
    const tools = createPeerTools(client, { canRun: true });
    const call = async (name: string, input: Record<string, unknown>) => {
      const out = await tools.find((t) => t.name === name)!.handler(input);
      return { text: (out.content[0] as { text: string }).text, isError: !!out.isError };
    };
    expect((await call('peer_info', {})).text).toContain('"run": true');
    expect((await call('peer_list_dir', {})).text).toContain('a.txt');
    expect((await call('peer_read_file', { path: 'a.txt' })).text).toBe('hello peer');
    expect((await call('peer_read_file', { path: 'a.txt', limit: 5 })).text).toContain('continue with offset=5');
    expect(await call('peer_read_file', { path: '../secret/s.txt' })).toMatchObject({ isError: true });
    expect((await call('peer_run', { command: 'echo over-there' })).text).toContain('over-there');
  });
  it('offers nothing without a link and no peer_run to a bot without Bash', () => {
    expect(createPeerTools(new PeerClient(cfg()), { canRun: true })).toEqual([]);
    const names = createPeerTools(new PeerClient(cfg({ url: base, token: 'x' })), { canRun: false }).map((t) => t.name);
    expect(names).toEqual(['peer_info', 'peer_list_dir', 'peer_read_file']);
  });
  it('explains an unreachable peer', async () => {
    const gone = new PeerClient(cfg({ url: 'http://127.0.0.1:1', token: 'x' }));
    await expect(gone.call('info')).rejects.toMatchObject({ status: 502 });
  });
});
