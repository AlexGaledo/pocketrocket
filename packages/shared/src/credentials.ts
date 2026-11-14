import { z } from 'zod';

/**
 * Saved logins a bot can type into a page with `fill_credential` (G4). The owner stores a name, the site's origin,
 * a username and a secret. The secret is write-only: it goes in over REST and is read back only by the hub, at the
 * moment it is typed into the page. No type here has a field that could carry it out.
 */
export const MAX_CREDENTIALS = 50;
export const MAX_CREDENTIAL_NAME = 40;
export const MAX_CREDENTIAL_USERNAME = 200;
export const MAX_CREDENTIAL_SECRET = 1024;

/** What a bot calls it: letters, digits, space, dot, dash, underscore; starts with a letter or digit. */
export const CREDENTIAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/** What listings, the REST API and Settings show. There is deliberately no `secret` here. */
export interface CredentialInfo {
  id: string;
  name: string;
  /** Exact origin the login belongs to, e.g. `https://github.com`. A page elsewhere is refused. */
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The exact origin (`scheme://host[:port]`, lowercase, default port dropped) a page URL belongs to, or null when a
 * login must not be bound to it: not https (plain http only for localhost), embedded user:password, or no host.
 * The same form the browser reports as `location.origin`, so the two compare with `===`.
 */
export function normalizeCredentialOrigin(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.username || u.password || !u.hostname) return null;
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)) return u.origin;
  return null;
}

const name = z.string().trim().min(1).max(MAX_CREDENTIAL_NAME).regex(CREDENTIAL_NAME_RE, 'use letters, digits, spaces, dots, dashes or underscores');
const origin = z.string().trim().min(1).max(300).transform((s, ctx) => {
  const o = normalizeCredentialOrigin(s);
  if (!o) ctx.addIssue({ code: 'custom', message: 'must be an https:// address (http only for localhost) without a user name or password' });
  return o ?? z.NEVER;
});
const username = z.string().max(MAX_CREDENTIAL_USERNAME).refine((s) => !/[\r\n\0]/.test(s), 'no line breaks');
const secret = z.string().min(1).max(MAX_CREDENTIAL_SECRET).refine((s) => !/\0/.test(s), 'no null characters');

export const CredentialCreateSchema = z.object({ name, origin, username: username.default(''), secret }).strict();
export type CredentialCreate = z.infer<typeof CredentialCreateSchema>;
/** Every field optional; an absent `secret` keeps the stored one. */
export const CredentialPatchSchema = z.object({ name: name.optional(), origin: origin.optional(), username: username.optional(), secret: secret.optional() }).strict();
export type CredentialPatch = z.infer<typeof CredentialPatchSchema>;
