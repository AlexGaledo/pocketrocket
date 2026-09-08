import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
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

  it('mints a fresh token on every start', async () => {
    const a = await probe({ POCKETROCKET_TOKEN: '' });
    const b = await probe({ POCKETROCKET_TOKEN: '' });
    expect(a.token).not.toBe(b.token);
    expect(fs.readFileSync(b.file, 'utf8')).toBe(b.token);
  });

  it('uses POCKETROCKET_TOKEN verbatim when it is set, and writes no file', async () => {
    const dir = path.join(tmp, 'env-data');
    const r = await probe({ POCKETROCKET_TOKEN: 'supplied-by-the-desktop-app', POCKETROCKET_DATA: dir });
    expect(r.token).toBe('supplied-by-the-desktop-app');
    expect(fs.existsSync(path.join(dir, 'hub-token'))).toBe(false);
  });
}, 60_000);
