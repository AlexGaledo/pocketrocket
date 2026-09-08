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
