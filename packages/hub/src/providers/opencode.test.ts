import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenCodeProvider, OPENCODE_INFO, TOOL_NAMING_NOTE } from './opencode.js';
import { authFilePath, parseAuthFile, parseAuthList, parseModels, parseVersion, pickDefault, splitModelId, stripAnsi } from './opencode/cli.js';
import { buildConfigContent, OpenCodeServer } from './opencode/server.js';
import { McpBridge, routeToken, type BridgeRoute } from './opencode/bridge.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-fixtures', 'opencode');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('opencode CLI parsers (captured output from opencode 1.17.6)', () => {
  it('parses --version', () => {
    expect(parseVersion(fixture('version.txt'))).toBe('1.17.6');
  });

  it('parses `auth list` into provider names and an auth mode', () => {
    const a = parseAuthList(fixture('auth-list.txt'));
    expect(a.providers).toEqual(['OpenCode Zen']);
    expect(a.auth).toBe('apiKey');
  });

  it('treats an oauth credential as a subscription login and no credentials as none', () => {
    const box = [
      '[90m┌[39m  Credentials [90m~\\.local\\share\\opencode\\auth.json',
      '[90m│[39m',
      '[34m●[39m  Anthropic [90moauth',
      '[34m●[39m  OpenCode Zen [90mapi',
      '[90m└[39m  2 credentials',
    ].join('\r\n');
    expect(parseAuthList(box)).toEqual({ providers: ['Anthropic', 'OpenCode Zen'], auth: 'subscription' });
    expect(parseAuthList('┌  Credentials\n└  0 credentials')).toEqual({ providers: [], auth: 'none' });
  });

  it('reads credentials straight out of auth.json (the fast path check() prefers)', () => {
    expect(parseAuthFile('{"opencode":{"type":"api","key":"sk-secret"}}')).toEqual({ providers: ['opencode'], auth: 'apiKey' });
    expect(parseAuthFile('{"anthropic":{"type":"oauth","refresh":"x"},"opencode":{"type":"api"}}')).toEqual({
      providers: ['anthropic', 'opencode'],
      auth: 'subscription',
    });
    expect(parseAuthFile('{}')).toEqual({ providers: [], auth: 'none' });
    expect(parseAuthFile('not json')).toEqual({ providers: [], auth: 'none' });
  });

  it('locates auth.json under the XDG data dir', () => {
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join('C:', 'share');
    expect(authFilePath()).toBe(path.join('C:', 'share', 'opencode', 'auth.json'));
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  });

  it('strips ANSI colour codes and CR', () => {
    expect(stripAnsi('[34m●[39m  x\r\n')).toBe('●  x\n');
  });

  it('parses `models` into provider/model ids with prettified labels', () => {
    const models = parseModels(fixture('models.txt'));
    expect(models.length).toBeGreaterThan(50);
    expect(models.map((m) => m.id)).toContain('opencode/claude-sonnet-5');
    expect(models.map((m) => m.id)).toContain('opencode/grok-4.6');
    const sonnet = models.find((m) => m.id === 'opencode/claude-sonnet-5')!;
    expect(sonnet.label).toBe('Claude Sonnet 5');
    expect(sonnet.note).toBe('opencode');
    // Every id keeps its provider prefix: nothing about the model list is hardcoded.
    expect(models.every((m) => m.id.includes('/'))).toBe(true);
    expect(models.filter((m) => m.default)).toHaveLength(1);
  });

  it('ignores CLI chrome that is not a model id', () => {
    expect(parseModels('loading models...\nopencode/gpt-5.4\n\n2 models\n').map((m) => m.id)).toEqual(['opencode/gpt-5.4']);
  });

  it('marks a sensible cheap default, preferring an authenticated first-party provider', () => {
    expect(pickDefault(['opencode/gpt-5.4', 'opencode/claude-sonnet-5', 'opencode/nemotron-3-ultra-free'])).toBe('opencode/claude-sonnet-5');
    expect(pickDefault(['anthropic/claude-sonnet-5', 'opencode/claude-sonnet-5'])).toBe('anthropic/claude-sonnet-5');
    // Nothing preferred available: fall back to the first id in provider order.
    expect(pickDefault(['zed/mystery-1'])).toBe('zed/mystery-1');
    expect(pickDefault([])).toBeUndefined();
  });

  it('splits provider/model ids and defaults a bare id to the OpenCode Zen provider', () => {
    expect(splitModelId('anthropic/claude-sonnet-5')).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5' });
    expect(splitModelId('gpt-5.4')).toEqual({ providerID: 'opencode', modelID: 'gpt-5.4' });
  });
});

describe('OPENCODE_CONFIG_CONTENT', () => {
  const cfg = JSON.parse(buildConfigContent({ mcpUrl: 'http://127.0.0.1:4321/mcp', mcpToken: 'tok123' })) as Record<string, never>;

  it('registers the hub tools as a remote MCP server with a bearer header', () => {
    expect(cfg.mcp).toEqual({
      pocketrocket: {
        type: 'remote',
        url: 'http://127.0.0.1:4321/mcp',
        headers: { Authorization: 'Bearer tok123' },
        enabled: true,
      },
    });
  });

  it('routes every mutating capability through an ask so the hub can decide', () => {
    const p = cfg.permission as unknown as Record<string, string>;
    expect(p.edit).toBe('ask');
    expect(p.bash).toBe('ask');
    expect(p.webfetch).toBe('ask');
    expect(p.websearch).toBe('ask');
    expect(p.external_directory).toBe('ask');
    expect(p.read).toBe('allow');
    expect(p.grep).toBe('allow');
  });

  it('disables instruction files, sharing and self-update', () => {
    expect(cfg.instructions).toEqual([]);
    expect(cfg.share).toBe('disabled');
    expect(cfg.autoshare).toBe(false);
    expect(cfg.autoupdate).toBe(false);
  });
});

describe('serve child spawn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-opencode-'));
  const dump = path.join(dir, 'dump.json');
  const script = path.join(dir, 'fake.mjs');
  const exe = path.join(dir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode.sh');
  const prevExe = process.env.OPENCODE_EXE;

  beforeAll(() => {
    fs.writeFileSync(
      script,
      'import fs from "node:fs";\n' +
        'fs.writeFileSync(' +
        JSON.stringify(dump) +
        ', JSON.stringify({ argv: process.argv.slice(2), env: { OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD, OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT }, cwd: process.cwd() }));\n' +
        'process.exit(3);\n',
    );
    if (process.platform === 'win32') {
      fs.writeFileSync(exe, '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n');
    } else {
      fs.writeFileSync(exe, '#!/bin/sh\nexec "' + process.execPath + '" "' + script + '" "$@"\n', { mode: 0o755 });
    }
    process.env.OPENCODE_EXE = exe;
  });

  afterAll(() => {
    if (prevExe === undefined) delete process.env.OPENCODE_EXE;
    else process.env.OPENCODE_EXE = prevExe;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('spawns `opencode serve` on a loopback port with the inline config and a server password', async () => {
    const server = new OpenCodeServer();
    // The fake exe exits immediately, so booting must fail with the child's exit code.
    await expect(server.ensure('http://127.0.0.1:7788/mcp')).rejects.toThrow(/exited with code 3/);
    await server.stop();

    const got = JSON.parse(fs.readFileSync(dump, 'utf8')) as { argv: string[]; env: Record<string, string>; cwd: string };
    expect(got.argv[0]).toBe('serve');
    expect(got.argv[1]).toBe('--hostname');
    expect(got.argv[2]).toBe('127.0.0.1');
    expect(got.argv[3]).toBe('--port');
    expect(Number(got.argv[4])).toBeGreaterThan(0);
    expect(got.env.OPENCODE_SERVER_PASSWORD).toMatch(/^[\w-]{20,}$/);

    const cfg = JSON.parse(got.env.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, { url: string; headers: Record<string, string> }> };
    // The MCP url is the bridge's, never the hub's per-turn endpoint (OpenCode reads it once, at startup).
    expect(cfg.mcp.pocketrocket.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(cfg.mcp.pocketrocket.url).not.toContain('7788');
    expect(cfg.mcp.pocketrocket.headers.Authorization).toMatch(/^Bearer [\w-]{20,}$/);
  });
});

describe('MCP bridge', () => {
  it('routes a tools/call to the session that has that tool in flight', () => {
    const routes = new Map<string, BridgeRoute>([
      ['ses_a', { token: 'A', startedAt: 1, pending: new Set() }],
      ['ses_b', { token: 'B', startedAt: 2, pending: new Set(['pocketrocket_send_message']) }],
    ]);
    expect(routeToken(routes, 'tools/call', 'pocketrocket_send_message')).toBe('B');
    // Handshake / listing traffic carries no session hint: any live turn serves the same tool schemas.
    expect(routeToken(routes, 'tools/list')).toBe('B');
    expect(routeToken(new Map(), 'tools/list')).toBeUndefined();
    expect(routeToken(new Map([['ses_a', { token: 'A', startedAt: 1, pending: new Set<string>() }]]), 'tools/call', 'pocketrocket_x')).toBe('A');
  });

  let hub: http.Server;
  let seen: Array<{ auth: string | undefined; body: string }> = [];
  let hubUrl = '';
  beforeAll(async () => {
    hub = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      seen.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    });
    await new Promise<void>((r) => hub.listen(0, '127.0.0.1', () => r()));
    const addr = hub.address() as { port: number };
    hubUrl = 'http://127.0.0.1:' + addr.port + '/mcp';
  });
  afterAll(async () => {
    await new Promise<void>((r) => hub.close(() => r()));
  });

  it('forwards under the live turn token, 401s a wrong token and 503s with no turn', async () => {
    seen = [];
    const bridge = new McpBridge(hubUrl);
    const url = await bridge.start();
    const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message' } });

    const noTurn = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' }, body: call });
    expect(noTurn.status).toBe(503);

    bridge.register('ses_1', 'turn-token-1');
    const ok = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' }, body: call });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(seen.at(-1)?.auth).toBe('Bearer turn-token-1');

    const bad = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: call });
    expect(bad.status).toBe(401);

    bridge.unregister('ses_1');
    const gone = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' }, body: call });
    expect(gone.status).toBe(503);
    await bridge.stop();
  });
});

describe('OpenCodeProvider surface', () => {
  it('keeps the registry contract: empty sync model list until the CLI answers', () => {
    const p = new OpenCodeProvider();
    expect(p.id).toBe('opencode');
    expect(p.modelsSync()).toEqual([]);
    expect(p.interrupt('nope')).toBe(false);
    expect(OPENCODE_INFO.permissions).toBe('best-effort');
  });

  it('tells the bot the real, MCP-prefixed hub tool names', () => {
    expect(TOOL_NAMING_NOTE).toContain('pocketrocket_send_message');
  });
});
