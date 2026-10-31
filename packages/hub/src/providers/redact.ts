/**
 * Secret scrubbing for anything a child process says (audit 2026-09-09, B22).
 *
 * Provider stderr/stdout tails end up in room messages and in the SQLite `messages` table. OpenCode's inline
 * config carries an `Authorization: Bearer <per-turn MCP token>` line, a CLI can echo an API key back in an
 * error, and a bot can `echo $XAI_API_KEY`. Everything on its way to the room goes through `redact()` first.
 *
 * Two layers: shape-based patterns (bearer headers, vendor key formats) and an exact-value registry the hub
 * fills in with the tokens it minted itself (hub token, per-turn MCP tokens, bridge token, server password).
 */

const known = new Set<string>();

/** Register an exact secret value so it is scrubbed wherever it appears. Values shorter than 8 chars are ignored. */
export function addSecret(value: string | null | undefined): void {
  if (typeof value === 'string' && value.length >= 8) known.add(value);
}
export function removeSecret(value: string | null | undefined): void {
  if (typeof value === 'string') known.delete(value);
}
/** Test helper. */
export function clearSecrets(): void {
  known.clear();
}

const PATTERNS: RegExp[] = [
  // `Authorization: Bearer xyz`, `authorization=Bearer xyz`, and bare `Bearer xyz`.
  /\b(authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Vendor key shapes: sk-…, sk_live_…, xai-…, ghp_…, gho_… (also matches the `-`-less spellings).
  /\b(sk|xai|ghp|gho)-?[A-Za-z0-9_-]{16,}/g,
  // P4 integration credentials. The vault also registers every stored value exactly (addSecret); these
  // catch the same shapes when a provider echoes a token the hub never stored (a refreshed one, a typo'd one).
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bgh[usr]_[A-Za-z0-9]{20,}/g, // GitHub user-to-server, server-to-server, refresh tokens
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g, // Slack bot / user / refresh tokens
  /\bxapp-[A-Za-z0-9-]{10,}/g, // Slack app-level token
  /\bpk_\d+_[A-Za-z0-9]{16,}/g, // ClickUp personal token
  /\bya29\.[A-Za-z0-9._-]{20,}/g, // Google access token
  /\b1\/\/[A-Za-z0-9_-]{20,}/g, // Google refresh token
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT (Microsoft access tokens)
];

/** Replace every known secret and secret-shaped token in `text` with `[redacted]`. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const s of known) {
    if (out.includes(s)) out = out.split(s).join('[redacted]');
  }
  for (const re of PATTERNS) out = out.replace(re, (m) => (m.toLowerCase().startsWith('bearer') || /authorization/i.test(m) ? m.replace(/(bearer\s+)[^\s]+/i, '$1[redacted]') : '[redacted]'));
  return out;
}

/** `redact` for values that may not be strings (tool output, error objects). */
export function redactUnknown(v: unknown): string {
  return redact(typeof v === 'string' ? v : String(v ?? ''));
}

/** Exported for tests: the exact-secret registry size. */
export function knownSecretCount(): number {
  return known.size;
}

/**
 * Hardening pass: log an error through `redact`. Errors from integrations, triggers, pairing and providers can
 * carry a token-bearing URL, header or response body; this is the one way the hub prints a caught error.
 */
export function logError(prefix: string, e: unknown): void {
  const text = e instanceof Error ? e.stack ?? e.message : typeof e === 'string' ? e : JSON.stringify(e) ?? String(e);
  console.error(prefix, redact(text));
}
