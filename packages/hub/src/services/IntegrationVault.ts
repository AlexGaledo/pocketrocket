import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { INTEGRATIONS_PATH, VAULT_KEY_PATH, restrictFile } from '../config.js';
import { addSecret, removeSecret } from '../providers/redact.js';

/**
 * Encrypted store for integration credentials (P4, spec §2.5). Separate from SecretsStore on purpose:
 * provider API keys there are plain JSON an env var can override; these are long-lived account tokens.
 *
 * - `integrations.json` holds one AES-256-GCM blob: `{ v: 1, iv, tag, data }` (base64), with a fixed
 *   associated-data string so a blob from another program never decrypts here. Every write re-encrypts the
 *   whole map with a fresh 96-bit IV.
 * - The 32-byte key lives in `vault.key` (hex, 0600 + owner-only ACL via restrictFile). It is created on the
 *   first write, never at startup, so a hub that never connects anything leaves no key behind.
 * - `deploy/backup.sh` excludes `vault.key`: a backup archive alone holds no usable token.
 * - A blob that fails authentication (tampered, truncated, wrong key) throws VaultError; nothing is
 *   silently reset, because overwriting would destroy the user's tokens.
 * - Every value read or written is registered with `addSecret`, so it is scrubbed from tool output, room
 *   messages and logs wherever it might surface. No method here logs a value.
 *
 * Not done: wrapping the key with DPAPI on Windows (the ACL from restrictFile is the control there).
 */
export class VaultError extends Error {}

const AAD = Buffer.from('pocketrocket/integration-vault/v1');
type Entry = Record<string, string>;

export class IntegrationVault {
  private cache: Record<string, Entry> | null = null;

  constructor(private opts: { file?: string; keyFile?: string } = {}) {}

  private get file() { return this.opts.file ?? INTEGRATIONS_PATH; }
  private get keyFile() { return this.opts.keyFile ?? VAULT_KEY_PATH; }

  /** The key, or null when none exists yet. `create` mints and stores one. */
  private key(create: boolean): Buffer | null {
    try {
      const hex = fs.readFileSync(this.keyFile, 'utf8').trim();
      if (!/^[0-9a-f]{64}$/.test(hex)) throw new VaultError('vault.key is not a 256-bit hex key; refusing to use it');
      return Buffer.from(hex, 'hex');
    } catch (e) {
      if (e instanceof VaultError) throw e;
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new VaultError('Cannot read vault.key');
      if (!create) return null;
      // A blob with no key can never be read again: refuse to mint a new key over it.
      if (fs.existsSync(this.file)) throw new VaultError('integrations.json exists but vault.key is missing; restore the key or delete integrations.json');
      const key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
      fs.writeFileSync(this.keyFile, key.toString('hex'), { mode: 0o600, flag: 'wx' });
      restrictFile(this.keyFile);
      return key;
    }
  }

  private load(): Record<string, Entry> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return (this.cache = {});
      throw new VaultError('Cannot read integrations.json');
    }
    const key = this.key(false);
    if (!key) throw new VaultError('integrations.json exists but vault.key is missing; restore the key or delete integrations.json');
    this.cache = decrypt(raw, key);
    for (const e of Object.values(this.cache)) for (const v of Object.values(e)) addSecret(v);
    return this.cache;
  }

  private save(all: Record<string, Entry>) {
    const key = this.key(true)!;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, encrypt(all, key), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    restrictFile(this.file);
    this.cache = all;
  }

  get(id: string): Entry | null {
    const e = this.load()[id];
    return e ? { ...e } : null;
  }

  /** Replace an entry. Empty-string values are dropped. */
  set(id: string, entry: Entry): void {
    const all = { ...this.load() };
    const clean: Entry = {};
    for (const [k, v] of Object.entries(entry)) if (typeof v === 'string' && v) { clean[k] = v; addSecret(v); }
    all[id] = clean;
    this.save(all);
  }

  /** Merge fields into an entry (an empty string deletes that field). */
  patch(id: string, fields: Entry): void {
    const cur = this.get(id) ?? {};
    for (const [k, v] of Object.entries(fields)) {
      if (v) cur[k] = v;
      else delete cur[k];
    }
    this.set(id, cur);
  }

  delete(id: string): void {
    const all = { ...this.load() };
    const e = all[id];
    if (!e) return;
    delete all[id];
    this.save(all);
    for (const v of Object.values(e)) removeSecret(v);
  }

  ids(): string[] {
    return Object.keys(this.load());
  }
}

function encrypt(all: Record<string, Entry>, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(AAD);
  const data = Buffer.concat([c.update(JSON.stringify(all), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function decrypt(raw: string, key: Buffer): Record<string, Entry> {
  try {
    const blob = JSON.parse(raw) as { v?: number; iv?: string; tag?: string; data?: string };
    if (blob.v !== 1 || !blob.iv || !blob.tag || typeof blob.data !== 'string') throw new Error('shape');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'), { authTagLength: 16 });
    d.setAAD(AAD);
    d.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const out = Buffer.concat([d.update(Buffer.from(blob.data, 'base64')), d.final()]).toString('utf8');
    return JSON.parse(out) as Record<string, Entry>;
  } catch {
    // One message for every failure: which check failed is no business of whoever tampered with the file.
    throw new VaultError('integrations.json failed its integrity check (tampered, truncated or wrong vault.key)');
  }
}
