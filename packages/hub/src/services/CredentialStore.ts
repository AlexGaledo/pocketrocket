import { nanoid } from 'nanoid';
import { MAX_CREDENTIALS, type CredentialCreate, type CredentialInfo, type CredentialPatch } from '@pocketrocket/shared';
import type { Db, Row } from '../db/db.js';
import { CREDENTIALS_PATH, VAULT_KEY_PATH } from '../config.js';
import { IntegrationVault } from './IntegrationVault.js';

/** A refusal the REST layer turns into a status; the message is safe to show. */
export class CredentialError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * The owner's saved logins (G4). Name, origin and username are rows in `credentials` (migration 210); the secret is
 * AES-256-GCM encrypted in data/credentials.json under the integration vault's key, keyed by the row id.
 *
 * The secret has exactly one way out: `readSecret`, called by the fill tool at the moment it types into the page.
 * Nothing else here returns it, and `list`/`get` build `CredentialInfo`, which has no secret field.
 */
export class CredentialStore {
  private vault: IntegrationVault;

  constructor(private db: Db, opts: { file?: string; keyFile?: string } = {}) {
    this.vault = new IntegrationVault({ file: opts.file ?? CREDENTIALS_PATH, keyFile: opts.keyFile ?? VAULT_KEY_PATH });
  }

  private rowTo(r: Row): CredentialInfo {
    return {
      id: r.id as string,
      name: r.name as string,
      origin: r.origin as string,
      username: (r.username as string) ?? '',
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      lastUsedAt: (r.last_used_at as number) ?? null,
    };
  }

  list(): CredentialInfo[] {
    return this.db.all('SELECT * FROM credentials ORDER BY name COLLATE NOCASE').map((r) => this.rowTo(r));
  }
  get(id: string): CredentialInfo | undefined {
    const r = this.db.get('SELECT * FROM credentials WHERE id=?', id);
    return r ? this.rowTo(r) : undefined;
  }
  /** Case-insensitive, the way the unique index compares. */
  byName(name: string): CredentialInfo | undefined {
    const r = this.db.get('SELECT * FROM credentials WHERE name=? COLLATE NOCASE', name.trim());
    return r ? this.rowTo(r) : undefined;
  }

  create(input: CredentialCreate): CredentialInfo {
    if (this.byName(input.name)) throw new CredentialError('A login named "' + input.name + '" already exists', 409);
    if (this.list().length >= MAX_CREDENTIALS) throw new CredentialError('At most ' + MAX_CREDENTIALS + ' saved logins', 400);
    const id = nanoid(10);
    const t = Date.now();
    // The secret first: a row without one would be a login that cannot be filled; a secret without a row is only dead weight.
    this.vault.set(id, { secret: input.secret });
    try {
      this.db.run('INSERT INTO credentials (id, name, origin, username, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, input.name, input.origin, input.username, t, t);
    } catch (e) {
      this.vault.delete(id);
      throw e;
    }
    return this.get(id)!;
  }

  update(id: string, patch: CredentialPatch): CredentialInfo {
    const cur = this.get(id);
    if (!cur) throw new CredentialError('No such saved login', 404);
    if (patch.name !== undefined) {
      const other = this.byName(patch.name);
      if (other && other.id !== id) throw new CredentialError('A login named "' + patch.name + '" already exists', 409);
    }
    if (patch.secret !== undefined) this.vault.set(id, { secret: patch.secret });
    this.db.run(
      'UPDATE credentials SET name=?, origin=?, username=?, updated_at=? WHERE id=?',
      patch.name ?? cur.name, patch.origin ?? cur.origin, patch.username ?? cur.username, Date.now(), id,
    );
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const had = this.db.run('DELETE FROM credentials WHERE id=?', id).changes > 0;
    this.vault.delete(id);
    return had;
  }

  markUsed(id: string): void {
    this.db.run('UPDATE credentials SET last_used_at=? WHERE id=?', Date.now(), id);
  }

  /** The only way the secret leaves the store. For the fill tool; never serialise the result. */
  readSecret(id: string): string | null {
    return this.vault.get(id)?.secret ?? null;
  }
}
