import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntegrationVault, VaultError } from './IntegrationVault.js';
import { clearSecrets, redact } from '../providers/redact.js';

let dir: string;
let file: string;
let keyFile: string;
const vault = () => new IntegrationVault({ file, keyFile });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-vault-'));
  file = path.join(dir, 'integrations.json');
  keyFile = path.join(dir, 'vault.key');
  clearSecrets();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('IntegrationVault', () => {
  it('round-trips entries through a fresh instance and keeps no plaintext on disk', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    vault().set('conn:a', { accessToken: secret, refreshToken: 'refresh-value-123456' });
    const again = vault();
    expect(again.get('conn:a')).toEqual({ accessToken: secret, refreshToken: 'refresh-value-123456' });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('refresh-value');
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
    expect(fs.readFileSync(keyFile, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates no key until something is stored', () => {
    const v = vault();
    expect(v.get('x')).toBeNull();
    expect(v.ids()).toEqual([]);
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it('writes vault.key owner-only', () => {
    vault().set('a', { t: 'value-12345678' });
    if (process.platform !== 'win32') expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('patch merges and empty deletes; delete removes the entry', () => {
    const v = vault();
    v.set('a', { x: '1', y: '2' });
    v.patch('a', { y: '', z: '3' });
    expect(v.get('a')).toEqual({ x: '1', z: '3' });
    v.delete('a');
    expect(vault().get('a')).toBeNull();
  });

  it('refuses a tampered blob instead of resetting it', () => {
    vault().set('a', { token: 'tamper-target-123456' });
    const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = Buffer.from(blob.data, 'base64');
    data[0] ^= 0xff;
    blob.data = data.toString('base64');
    fs.writeFileSync(file, JSON.stringify(blob));
    expect(() => vault().get('a')).toThrow(VaultError);
    // still there for the user to restore, not overwritten
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses a truncated auth tag', () => {
    vault().set('a', { token: 'tamper-target-123456' });
    const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
    blob.tag = Buffer.from(blob.tag, 'base64').subarray(0, 4).toString('base64');
    fs.writeFileSync(file, JSON.stringify(blob));
    expect(() => vault().get('a')).toThrow(VaultError);
  });

  it('refuses the wrong key, and refuses to mint a new key over an existing blob', () => {
    vault().set('a', { token: 'value-12345678' });
    fs.writeFileSync(keyFile, 'ab'.repeat(32));
    expect(() => vault().get('a')).toThrow(VaultError);
    fs.rmSync(keyFile);
    expect(() => vault().set('b', { t: 'value-12345678' })).toThrow(/vault.key is missing/);
  });

  it('registers stored values for redaction, and forgets them on delete', () => {
    const v = vault();
    v.set('a', { accessToken: 'opaque-oauth-token-value-42' });
    expect(redact('echo opaque-oauth-token-value-42')).toBe('echo [redacted]');
    clearSecrets();
    vault().get('a'); // loading from disk registers them too
    expect(redact('x opaque-oauth-token-value-42')).toBe('x [redacted]');
    v.delete('a');
  });
});

describe('redaction of integration token shapes', () => {
  it.each([
    'ghp_0123456789abcdefghijABCDEFGHIJ0123',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'xoxb-1234567890-abcdefghij',
    'xapp-1-A0123456789-0123456789-abcdef0123',
    'pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'ya29.a0AfH6SMBx-abcdefghijklmnopqrstuvwxyz',
    '1//0gabcdefghijklmnopqrstuvwxyz0123',
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl',
  ])('scrubs %s', (tok) => {
    expect(redact('token=' + tok + ' end')).toBe('token=[redacted] end');
  });
});
