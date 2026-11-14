import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCredentialOrigin, CredentialCreateSchema } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { CredentialStore, CredentialError } from './CredentialStore.js';
import { clearSecrets } from '../providers/redact.js';

const SECRET = 'vault-test-SECRET-value-77';
let dir: string;
let db: Db;
const open = () => new CredentialStore(db, { file: path.join(dir, 'credentials.json'), keyFile: path.join(dir, 'vault.key') });

beforeEach(() => {
  clearSecrets();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-credstore-'));
  db = new Db(':memory:');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('CredentialStore', () => {
  it('keeps the secret encrypted on disk and out of every listing', () => {
    const s = open();
    const c = s.create({ name: 'gh', origin: 'https://github.com', username: 'alex', secret: SECRET });
    expect(JSON.stringify([c, s.list(), s.get(c.id), s.byName('GH')])).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')).not.toContain(SECRET);
    expect(JSON.stringify(db.all('SELECT * FROM credentials'))).not.toContain(SECRET);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'credentials.json')).mode & 0o077).toBe(0);
    expect(open().readSecret(c.id)).toBe(SECRET);
  });

  it('keeps the secret on a patch without one, replaces it with one, and erases it on delete', () => {
    const s = open();
    const c = s.create({ name: 'gh', origin: 'https://github.com', username: '', secret: SECRET });
    s.update(c.id, { username: 'x' });
    expect(s.readSecret(c.id)).toBe(SECRET);
    s.update(c.id, { secret: 'another-secret-99' });
    expect(s.readSecret(c.id)).toBe('another-secret-99');
    s.delete(c.id);
    expect(s.readSecret(c.id)).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it('refuses a duplicate name, any case', () => {
    const s = open();
    s.create({ name: 'gh', origin: 'https://github.com', username: '', secret: SECRET });
    expect(() => s.create({ name: 'GH', origin: 'https://github.com', username: '', secret: SECRET })).toThrow(CredentialError);
  });

  it('is created by migration 210 only', () => {
    expect(db.schemaVersions()).toContain(210);
  });
});

describe('credential origins', () => {
  it.each([
    ['https://GitHub.com/login?a=1#x', 'https://github.com'],
    ['https://github.com:443/', 'https://github.com'],
    ['https://example.com:8443/x', 'https://example.com:8443'],
    ['http://localhost:3000/a', 'http://localhost:3000'],
  ])('normalises %s', (input, out) => expect(normalizeCredentialOrigin(input)).toBe(out));

  it.each(['http://github.com', 'ftp://x.com', 'https://user:pw@x.com', 'javascript:alert(1)', 'not a url', 'about:blank', ''])('refuses %s', (input) => {
    expect(normalizeCredentialOrigin(input)).toBeNull();
  });

  it('rejects unknown fields and echoes no value in an issue', () => {
    const r = CredentialCreateSchema.safeParse({ name: 'a', origin: 'https://a.com', secret: SECRET, extra: SECRET });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain(SECRET);
  });
});
