import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { UserSessionInfo } from '@pocketrocket/shared';
import type { Db } from '../db/db.js';

export const SESSION_COOKIE = 'pr_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;
/** How often `last_seen_at` is rewritten. Every request would be a database write. */
const TOUCH_MS = 60_000;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem }, (e, key) => (e ? reject(e) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = await derive(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p), keylen: want.length });
  return got.length === want.length && timingSafeEqual(got, want);
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function checkNewPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new AuthError(400, 'Use at least ' + MIN_PASSWORD + ' characters.');
  }
  if (password.length > MAX_PASSWORD) throw new AuthError(400, 'Use at most ' + MAX_PASSWORD + ' characters.');
  return password;
}

/**
 * The owner's password and browser sessions. A session is a long random token held in an httpOnly cookie; the
 * database keeps only its hash, so a copy of the database cannot sign anyone in. The hub token stays valid for
 * the desktop app and scripts, and is how an owner who forgets the password sets a new one.
 */
export class AuthService {
  private revokeListeners = new Set<(sessionId: string) => void>();
  constructor(private db: Db, private now: () => number = Date.now) {}

  hasPassword(userId: string): boolean {
    return !!this.db.get('SELECT 1 FROM user_credentials WHERE user_id=?', userId);
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const hash = await hashPassword(checkNewPassword(password));
    this.db.run(
      'INSERT INTO user_credentials (user_id, password_hash, updated_at) VALUES (?,?,?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash, updated_at=excluded.updated_at',
      userId, hash, this.now(),
    );
  }

  async verifyPassword(userId: string, password: unknown): Promise<boolean> {
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) return false;
    const row = this.db.get('SELECT password_hash FROM user_credentials WHERE user_id=?', userId);
    return row ? passwordMatches(password, row.password_hash as string) : false;
  }

  createSession(userId: string, meta: { userAgent?: string | null; ip?: string | null } = {}): { token: string; id: string } {
    const t = this.now();
    this.expireDue();
    this.db.run('DELETE FROM user_sessions WHERE expires_at < ?', t);
    const id = nanoid(12);
    const token = randomBytes(32).toString('base64url');
    this.db.run(
      'INSERT INTO user_sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      id, userId, hashToken(token), (meta.userAgent ?? '').slice(0, 200) || null, meta.ip ?? null, t, t, t + SESSION_TTL_MS,
    );
    return { token, id };
  }

  /** The live session behind a cookie value, or null. */
  authenticate(token: string | null): { sessionId: string; userId: string } | null {
    if (!token) return null;
    const row = this.db.get(
      'SELECT id, user_id, last_seen_at FROM user_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at > ?',
      hashToken(token), this.now(),
    );
    if (!row) return null;
    if (this.now() - (row.last_seen_at as number) > TOUCH_MS) this.db.run('UPDATE user_sessions SET last_seen_at=? WHERE id=?', this.now(), row.id);
    return { sessionId: row.id as string, userId: row.user_id as string };
  }

  list(userId: string, current: string | null): UserSessionInfo[] {
    return this.db
      .all('SELECT * FROM user_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC', userId, this.now())
      .map((r) => ({
        id: r.id as string,
        userAgent: (r.user_agent as string) ?? null,
        ip: (r.ip as string) ?? null,
        createdAt: r.created_at as number,
        lastSeenAt: r.last_seen_at as number,
        expiresAt: r.expires_at as number,
        current: r.id === current,
      }));
  }

  /** False when there was no such live session for this user. */
  revoke(userId: string, id: string): boolean {
    const r = this.db.run('UPDATE user_sessions SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at > ?', this.now(), id, userId, this.now());
    if (!Number(r.changes)) return false;
    for (const l of this.revokeListeners) l(id);
    return true;
  }

  /** Signs out everywhere except `except`, when given. Returns how many sessions ended. */
  revokeAll(userId: string, except: string | null = null): number {
    const live = this.db.all('SELECT id FROM user_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at > ?', userId, this.now()).map((r) => r.id as string);
    let n = 0;
    for (const id of live) if (id !== except && this.revoke(userId, id)) n++;
    return n;
  }

  /** Ends sessions past their expiry, so a websocket or Screen opened before then closes too. */
  expireDue(): void {
    const t = this.now();
    const due = this.db.all('SELECT id FROM user_sessions WHERE revoked_at IS NULL AND expires_at <= ?', t).map((r) => r.id as string);
    for (const id of due) {
      this.db.run('UPDATE user_sessions SET revoked_at=? WHERE id=?', t, id);
      for (const l of this.revokeListeners) l(id);
    }
  }

  /** So the hub can hang up a revoked session's open websocket. */
  onRevoke(fn: (sessionId: string) => void): () => void {
    this.revokeListeners.add(fn);
    return () => this.revokeListeners.delete(fn);
  }
}
