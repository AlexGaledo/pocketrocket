import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretsStore } from './SecretsStore.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-secrets-'));
const file = path.join(dir, 'secrets.json');

afterEach(() => {
  delete process.env.XAI_API_KEY;
  fs.rmSync(file, { force: true });
});

describe('SecretsStore', () => {
  it('stores, reads and deletes a key', () => {
    const s = new SecretsStore(file);
    expect(s.get('XAI_API_KEY')).toBeNull();
    s.set({ XAI_API_KEY: 'xai-123' });
    expect(s.get('XAI_API_KEY')).toBe('xai-123');
    expect(s.status().keys.XAI_API_KEY).toBe(true);
    expect(s.status().keys.OPENAI_API_KEY).toBe(false);
    s.set({ XAI_API_KEY: '' });
    expect(s.get('XAI_API_KEY')).toBeNull();
    expect(s.status().keys.XAI_API_KEY).toBe(false);
  });

  it('lets an environment variable win over the file', () => {
    const s = new SecretsStore(file);
    s.set({ XAI_API_KEY: 'from-file' });
    process.env.XAI_API_KEY = 'from-env';
    expect(s.get('XAI_API_KEY')).toBe('from-env');
    expect(s.status().keys.XAI_API_KEY).toBe(true);
  });

  it('reports a key set only in the environment', () => {
    const s = new SecretsStore(file);
    process.env.XAI_API_KEY = 'env-only';
    expect(s.status().keys.XAI_API_KEY).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  // ---- audit 2026-09-09, B17 ----
  it('re-applies owner-only permissions on every write, including over an existing file', () => {
    // The bug: `writeFileSync({ mode })` is ignored when the file already exists, so a secrets.json
    // created loosely (or inheriting DATA_DIR's ACL) stayed loose for the rest of its life.
    fs.writeFileSync(file, '{}', { mode: 0o666 });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o666);
    const s = new SecretsStore(file);
    s.set({ XAI_API_KEY: 'xai-123' });
    if (process.platform === 'win32') {
      // POSIX bits are a fiction on Windows; the real control is the icacls pass, which is
      // fire-and-forget. Assert the write itself still worked.
      expect(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>).toEqual({ XAI_API_KEY: 'xai-123' });
    } else {
      expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    }
  });

  it('survives a missing or corrupt file', () => {
    fs.writeFileSync(file, 'not json');
    const s = new SecretsStore(file);
    expect(s.get('XAI_API_KEY')).toBeNull();
    expect(s.status().keys.XAI_API_KEY).toBe(false);
  });
});
