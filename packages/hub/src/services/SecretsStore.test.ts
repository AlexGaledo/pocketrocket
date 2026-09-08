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

  it('survives a missing or corrupt file', () => {
    fs.writeFileSync(file, 'not json');
    const s = new SecretsStore(file);
    expect(s.get('XAI_API_KEY')).toBeNull();
    expect(s.status().keys.XAI_API_KEY).toBe(false);
  });
});
