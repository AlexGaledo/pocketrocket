import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '@pocketrocket/shared';
import { childEnv } from './env.js';
import { MCP_STDIO_BRIDGE, findExe } from './acp/client.js';
import { GEMINI_INFO, agySettingsPath, agyVersionWarning, createGeminiProvider, geminiLimit, inferGeminiAuth, parseAgyVersion, parseGeminiAuth, readAgyModelProvider } from './gemini.js';
import { unattendedRefusal } from './unattended.js';
import type { Bot } from '@pocketrocket/shared';

/** P2-2: the Gemini preset (`agy acp`). Untested against a real agy; these pin the contract the owner's live test checks. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(HERE, '..', '..', 'test-fixtures', 'acp', 'fake-acp-agent.mjs');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, '__fixtures__', 'gemini', 'limit-quota.synthetic.json'), 'utf8')) as Record<
  string,
  { message?: string; data?: unknown; title?: string; description?: string }
>;

let tmp: string;
const saved = { PATH: process.env.PATH, AGY_EXE: process.env.AGY_EXE, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-gemini-'));
  delete process.env.AGY_EXE;
  delete process.env.GEMINI_API_KEY;
});
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.AGY_EXE === undefined) delete process.env.AGY_EXE;
  else process.env.AGY_EXE = saved.AGY_EXE;
  if (saved.GEMINI_API_KEY !== undefined) process.env.GEMINI_API_KEY = saved.GEMINI_API_KEY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Gemini preset info', () => {
  it('is registered, untested and best-effort, with the key variable as its only secret', () => {
    expect(PROVIDER_IDS).toContain('gemini');
    expect(GEMINI_INFO.maturity).toBe('untested');
    expect(GEMINI_INFO.permissions).toBe('best-effort');
    expect(GEMINI_INFO.secretKeys).toEqual(['GEMINI_API_KEY']);
  });

  it('the child env carries GEMINI_API_KEY and no other provider key, and never the hub token', () => {
    const env = childEnv('gemini', {}, {
      PATH: '/bin', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x', POCKETROCKET_TOKEN: 't', GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
    });
    expect(env).toEqual({ PATH: '/bin', GEMINI_API_KEY: 'g' });
  });
});

describe('versions', () => {
  it('parses whatever agy --version prints, leniently', () => {
    expect(parseAgyVersion('agy 1.4.2')).toBe('1.4.2');
    expect(parseAgyVersion('Antigravity CLI v2.0 (build abc123)')).toBe('2.0.0');
    expect(parseAgyVersion('no digits here')).toBeNull();
  });
  it('warns outside the tested range, never refuses', () => {
    expect(agyVersionWarning(null)).toBe('unknown agy version (untested)');
    expect(agyVersionWarning('1.0.0', null)).toMatch(/not been tested/);
    expect(agyVersionWarning('1.2.5', { min: '1.2.0', max: '1.2.9' })).toBeNull();
    expect(agyVersionWarning('1.3.0', { min: '1.2.0', max: '1.2.9' })).toMatch(/newer than/);
    expect(agyVersionWarning('1.1.9', { min: '1.2.0', max: '1.2.9' })).toMatch(/older than/);
  });
});

describe('reported auth', () => {
  it('counts only an explicit API-key report as apiKey; unknown is the Google login for the guard', () => {
    expect(parseGeminiAuth({ _meta: { authMethod: 'gemini-api-key' } })).toEqual({ auth: 'apiKey', method: 'gemini-api-key' });
    expect(parseGeminiAuth({ agentInfo: { name: 'agy', version: '1', _meta: { auth: { id: 'oauth-personal' } } } })).toEqual({ auth: 'subscription', method: 'oauth-personal' });
    expect(parseGeminiAuth({ _meta: { authType: 'something-new' } })).toEqual({ auth: 'unknown', method: 'something-new' });
    expect(parseGeminiAuth({})).toEqual({ auth: 'unknown' });
    expect(parseGeminiAuth(null)).toEqual({ auth: 'unknown' });
    // A key in the store is not a report: nothing here reads the environment.
    expect(parseGeminiAuth({ _meta: { model: 'gemini-3-pro' } })).toEqual({ auth: 'unknown' });
  });
});

describe('auth agy does not report (live P2-4: agy 1.5.12 reports none)', () => {
  it('a key in the spawn env plus modelProvider "gemini" is API-key auth', () => {
    expect(inferGeminiAuth({ auth: 'unknown' }, { GEMINI_API_KEY: 'k' }, 'gemini')).toEqual({ auth: 'apiKey', method: 'gemini-api-key' });
  });
  it('fails closed: no key, a blank key, or settings that do not select gemini stay the Google login', () => {
    expect(inferGeminiAuth({ auth: 'unknown' }, {}, 'gemini')).toEqual({ auth: 'unknown' });
    expect(inferGeminiAuth({ auth: 'unknown' }, { GEMINI_API_KEY: '  ' }, 'gemini')).toEqual({ auth: 'unknown' });
    expect(inferGeminiAuth({ auth: 'unknown' }, { GEMINI_API_KEY: 'k' }, null)).toEqual({ auth: 'unknown', keyIgnored: true });
    expect(inferGeminiAuth({ auth: 'unknown' }, { GEMINI_API_KEY: 'k' }, 'google')).toEqual({ auth: 'unknown', keyIgnored: true });
  });
  it('an explicit report from agy wins over the key', () => {
    expect(inferGeminiAuth({ auth: 'subscription', method: 'oauth-personal' }, { GEMINI_API_KEY: 'k' }, 'gemini')).toEqual({ auth: 'subscription', method: 'oauth-personal' });
  });
  it('reads modelProvider from agy settings, null when missing or broken', () => {
    expect(agySettingsPath('/h')).toBe(path.join('/h', '.gemini', 'antigravity-cli', 'settings.json'));
    const f = path.join(tmp, 'settings.json');
    expect(readAgyModelProvider(f)).toBeNull();
    fs.writeFileSync(f, '{ "modelProvider": "gemini" }');
    expect(readAgyModelProvider(f)).toBe('gemini');
    fs.writeFileSync(f, '{ not json');
    expect(readAgyModelProvider(f)).toBeNull();
  });
});

describe('limit matcher (synthetic fixture)', () => {
  it('reads a quota error as a usage limit with the retry delay as reset time', () => {
    const now = 1_000_000;
    const f = FIXTURE.promptError;
    expect(geminiLimit(f.message + ' ' + JSON.stringify(f.data), now)).toEqual({ kind: 'usage', resetsAt: now + 3_600_000 });
    expect(geminiLimit(FIXTURE.notice.title + ': ' + FIXTURE.notice.description, now)).toEqual({ kind: 'usage' });
  });
  it('tells overload and sign-out apart, and leaves ordinary failures alone', () => {
    expect(geminiLimit(FIXTURE.overloaded.message!)).toEqual({ kind: 'overloaded' });
    expect(geminiLimit(FIXTURE.signedOut.message!)).toEqual({ kind: 'auth' });
    expect(geminiLimit(FIXTURE.notALimit.message!)).toBeNull();
  });
});

describe('check()', () => {
  it('a missing CLI gives the install hint and downloads nothing', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    process.env.PATH = empty;
    const c = await createGeminiProvider({ secrets: { get: () => null } }).check();
    expect(c.ok).toBe(false);
    expect(c.auth).toBe('none');
    expect(c.error).toMatch(/agy .*was not found/);
    expect(c.hint).toMatch(/antigravity\.google/);
    expect(c.hint).toMatch(/AGY_EXE/);
    expect(fs.readdirSync(tmp)).toEqual(['empty']);
  });

  it('reports version, auth, exePath and a version warning from the agent', async () => {
    const c = await createGeminiProvider({ exe: FAKE, secrets: { get: () => null } }).check();
    expect(c.ok).toBe(true);
    expect(c.version).toBe('0.9.1');
    expect(c.versionWarning).toMatch(/not been tested/);
    expect(c.exePath).toBe(FAKE);
    expect(c.auth).toBe('unknown');
  });

  it('reports apiKey only when the agent itself says so', async () => {
    const c = await createGeminiProvider({ exe: FAKE, env: { FAKE_ACP_META_AUTH: 'gemini-api-key' }, secrets: { get: () => null } }).check();
    expect(c.auth).toBe('apiKey');
    expect(c.authMethod).toBe('gemini-api-key');
  });
});

describe('check() and the unattended guard with a key in the Secrets store', () => {
  const gem = { name: 'Gem', provider: 'gemini' } as Bot;
  function settings(modelProvider?: string) {
    const f = path.join(tmp, 'agy-settings.json');
    if (modelProvider) fs.writeFileSync(f, JSON.stringify({ modelProvider }));
    return f;
  }
  function guardFor(p: ReturnType<typeof createGeminiProvider>) {
    return { forBot: () => p, check: () => p.check() };
  }

  it('a key saved in Secrets (not in the hub env) with agy set to gemini: apiKey, and a routine may run', async () => {
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
    const p = createGeminiProvider({ exe: FAKE, secrets: { get: (k) => (k === 'GEMINI_API_KEY' ? 'AIza-test' : null) }, agySettings: settings('gemini') });
    const c = await p.check();
    expect(c.auth).toBe('apiKey');
    expect(c.authMethod).toBe('gemini-api-key');
    expect(await unattendedRefusal(guardFor(p), gem)).toBeNull();
  });

  it('no key: still the Google login, and a routine is refused', async () => {
    const p = createGeminiProvider({ exe: FAKE, secrets: { get: () => null }, agySettings: settings('gemini') });
    const c = await p.check();
    expect(c.auth).toBe('unknown');
    expect(c.authMethod).toBeUndefined();
    expect(await unattendedRefusal(guardFor(p), gem)).toMatch(/Gem did not run: Gemini on a Google sign-in/);
  });

  it('a key agy would ignore (settings not set to gemini): refused, and the hint says why', async () => {
    const p = createGeminiProvider({ exe: FAKE, secrets: { get: () => 'AIza-test' }, agySettings: settings() });
    const c = await p.check();
    expect(c.auth).toBe('unknown');
    expect(c.hint).toMatch(/"modelProvider": "gemini"/);
    expect(await unattendedRefusal(guardFor(p), gem)).toMatch(/did not run/);
  });

  it('agy reporting the Google login wins over a saved key', async () => {
    const p = createGeminiProvider({ exe: FAKE, env: { FAKE_ACP_META_AUTH: 'oauth-personal' }, secrets: { get: () => 'AIza-test' }, agySettings: settings('gemini') });
    expect((await p.check()).auth).toBe('subscription');
    expect(await unattendedRefusal(guardFor(p), gem)).toMatch(/did not run/);
  });
});

describe('finding agy', () => {
  it('AGY_EXE wins over PATH', async () => {
    process.env.AGY_EXE = path.join(tmp, 'custom', 'agy.exe');
    expect(await findExe('agy', 'AGY_EXE')).toBe(path.join(tmp, 'custom', 'agy.exe'));
  });

  it.runIf(process.platform === 'win32')('on Windows picks the .cmd shim over a .ps1 one (spawned through cmd.exe, never shell: true)', async () => {
    fs.writeFileSync(path.join(tmp, 'agy.ps1'), '');
    fs.writeFileSync(path.join(tmp, 'agy.cmd'), '@echo off\r\n');
    process.env.PATH = tmp + ';' + saved.PATH;
    // Compare real paths: on CI the temp dir is an 8.3 short name (RUNNER~1) and the lookup may return the long form.
    const found = await findExe('agy', 'AGY_EXE');
    expect(found && fs.realpathSync.native(found)).toBe(fs.realpathSync.native(path.join(tmp, 'agy.cmd')));
  });

  it.runIf(process.platform !== 'win32')('elsewhere takes the first agy on PATH', async () => {
    const p = path.join(tmp, 'agy');
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
    process.env.PATH = tmp + ':' + saved.PATH;
    expect(await findExe('agy', 'AGY_EXE')).toBe(p);
  });
});

describe('stdio MCP bridge', () => {
  it('forwards each line to the hub endpoint with the bearer and writes the answer back', async () => {
    const seen: Array<{ auth?: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body });
        const msg = JSON.parse(body) as { id?: number };
        if (msg.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const child = spawn(process.execPath, ['-e', MCP_STDIO_BRIDGE], {
        env: { PATH: process.env.PATH, PR_MCP_URL: 'http://127.0.0.1:' + port + '/mcp', PR_MCP_TOKEN: 'turn-tok' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\n');
      await new Promise((r) => child.on('close', r));
      expect(seen.map((s) => s.auth)).toEqual(['Bearer turn-tok', 'Bearer turn-tok']);
      expect(out.trim().split('\n').map((l) => JSON.parse(l) as unknown)).toEqual([{ jsonrpc: '2.0', id: 7, result: { tools: [] } }]);
    } finally {
      server.close();
    }
  });
});
