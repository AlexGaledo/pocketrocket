import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Audit 2026-09-09, B3 / D3: the hub must never run unauthenticated. `config.ts` reads DATA_DIR at import
 * time, so this exercises `ensureHubToken` in a child process with its own POCKETROCKET_DATA rather than
 * trying to re-import the module with different environment.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
let tmp: string;
let script: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-token-'));
  script = path.join(tmp, 'probe.mjs');
  fs.writeFileSync(
    script,
    'const m = await import(' + JSON.stringify(pathToFileURL(path.join(HERE, 'config.ts')).href) + ');\n' +
      'process.stdout.write(JSON.stringify({ token: m.ensureHubToken(), file: m.HUB_TOKEN_PATH, env: m.HUB_TOKEN }));\n',
  );
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function probe(env: NodeJS.ProcessEnv): Promise<{ token: string; file: string; env: string | null }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', script],
      { env: { ...process.env, POCKETROCKET_DATA: path.join(tmp, 'data'), ...env }, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(String(err.message) + stderr)) : resolve(JSON.parse(stdout))),
    );
  });
}

describe('ensureHubToken', () => {
  it('mints a 32-hex token and writes it to <DATA_DIR>/hub-token when none is configured', async () => {
    const r = await probe({ POCKETROCKET_TOKEN: '' });
    expect(r.env).toBe(null);
    expect(r.token).toMatch(/^[0-9a-f]{32}$/);
    expect(r.file).toBe(path.join(tmp, 'data', 'hub-token'));
    expect(fs.readFileSync(r.file, 'utf8')).toBe(r.token);
    if (process.platform !== 'win32') {
      expect((fs.statSync(r.file).mode & 0o777).toString(8)).toBe('600');
    }
  });

  it('reuses the stored token on the next start, so a restart does not lock the open UI out', async () => {
    const a = await probe({ POCKETROCKET_TOKEN: '' });
    const b = await probe({ POCKETROCKET_TOKEN: '' });
    expect(b.token).toBe(a.token);
    expect(fs.readFileSync(b.file, 'utf8')).toBe(a.token);
  });

  it('mints a fresh token every start when POCKETROCKET_ROTATE_TOKEN=1', async () => {
    const dir = path.join(tmp, 'rotate-data');
    const a = await probe({ POCKETROCKET_TOKEN: '', POCKETROCKET_ROTATE_TOKEN: '1', POCKETROCKET_DATA: dir });
    const b = await probe({ POCKETROCKET_TOKEN: '', POCKETROCKET_ROTATE_TOKEN: '1', POCKETROCKET_DATA: dir });
    expect(a.token).not.toBe(b.token);
    expect(fs.readFileSync(b.file, 'utf8')).toBe(b.token);
  });

  it('replaces a corrupt or truncated token file instead of trusting it', async () => {
    const dir = path.join(tmp, 'corrupt-data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hub-token'), 'not-a-token\n');
    const r = await probe({ POCKETROCKET_TOKEN: '', POCKETROCKET_DATA: dir });
    expect(r.token).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readFileSync(r.file, 'utf8')).toBe(r.token);
  });

  it('uses POCKETROCKET_TOKEN verbatim when it is set, and writes no file', async () => {
    const dir = path.join(tmp, 'env-data');
    const r = await probe({ POCKETROCKET_TOKEN: 'supplied-by-the-desktop-app', POCKETROCKET_DATA: dir });
    expect(r.token).toBe('supplied-by-the-desktop-app');
    expect(fs.existsSync(path.join(dir, 'hub-token'))).toBe(false);
  });
}, 60_000);

/**
 * The hub's stdout and stderr land in the journal (systemd) and in hub.log (desktop), so the token must never
 * be in them. This runs the real entry point: the startup lines are only written by a hub that really listens.
 */
describe('hub startup output', () => {
  const ENTRY = path.join(HERE, 'index.ts');

  async function withHub(env: NodeJS.ProcessEnv, fn: (port: number) => Promise<void>): Promise<string> {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      env: { ...process.env, PORT: '0', POCKETROCKET_ROTATE_TOKEN: '', ...env },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise((r) => child.once('exit', r));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const poll = setInterval(() => {
          const m = /\[pocketrocket\] open: http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
          if (m) { clearInterval(poll); resolve(Number(m[1])); }
        }, 50);
        void exited.then(() => { clearInterval(poll); reject(new Error('hub exited early: ' + out)); });
      });
      await fn(port);
    } finally {
      child.kill();
      await exited;
    }
    return out;
  }

  /** Requests that present the token, in the header and in the query, so request logging would show up too. */
  async function touch(port: number, token: string): Promise<number> {
    await fetch('http://127.0.0.1:' + port + '/api/bots?token=' + token);
    const res = await fetch('http://127.0.0.1:' + port + '/api/bots', { headers: { authorization: 'Bearer ' + token } });
    await new Promise((r) => setTimeout(r, 200));
    return res.status;
  }

  it('keeps a minted token out of the logs, names the file, and that file gets you in', async () => {
    const dir = path.join(tmp, 'startup-minted');
    const file = path.join(dir, 'hub-token');
    let token = '';
    const out = await withHub({ POCKETROCKET_TOKEN: '', POCKETROCKET_DATA: dir }, async (port) => {
      token = fs.readFileSync(file, 'utf8').trim();
      expect(await touch(port, token)).toBe(200);
      expect((await fetch('http://127.0.0.1:' + port + '/api/bots')).status).toBe(401);
    });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(out).not.toContain(token);
    expect(out).not.toContain('#token=');
    expect(out).toContain(file);
  });

  it('keeps a reused token out of the logs on the next start too', async () => {
    const dir = path.join(tmp, 'startup-reused');
    const token = 'abcdef0123456789abcdef0123456789';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hub-token'), token);
    const out = await withHub({ POCKETROCKET_TOKEN: '', POCKETROCKET_DATA: dir }, async (port) => {
      expect(await touch(port, token)).toBe(200);
    });
    expect(out).not.toContain(token);
  });

  it('keeps POCKETROCKET_TOKEN out of the logs and points at the variable, not a file that does not exist', async () => {
    const dir = path.join(tmp, 'startup-env');
    const token = 'supplied-by-the-desktop-app-0123456789';
    const out = await withHub({ POCKETROCKET_TOKEN: token, POCKETROCKET_DATA: dir }, async (port) => {
      expect(await touch(port, token)).toBe(200);
    });
    expect(out).not.toContain(token);
    expect(out).not.toContain('#token=');
    expect(out).toMatch(/open: .*POCKETROCKET_TOKEN/);
    expect(fs.existsSync(path.join(dir, 'hub-token'))).toBe(false);
  });

  it('says so when the token cannot be stored, and still does not print it', async () => {
    const dir = path.join(tmp, 'startup-unwritable');
    fs.mkdirSync(path.join(dir, 'hub-token'), { recursive: true }); // a directory: unreadable and unwritable as a file
    const out = await withHub({ POCKETROCKET_TOKEN: '', POCKETROCKET_DATA: dir }, async () => undefined);
    expect(out).toMatch(/could not write .*POCKETROCKET_TOKEN/);
    expect(out).not.toContain('#token=');
    expect(out).not.toMatch(/[0-9a-f]{32}/);
  });
}, 120_000);
