// Shared by context-import.mjs and the PC runner's session mirror (pc-runner/mirror.mjs). Plain Node, no side effects.
// Same rules as packages/hub/src/providers/redact.ts and services/contextScrub.ts; contextImport.test.ts checks them.
const SHAPES = [
  /\b(?:authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|xai|ghp|gho)-?[A-Za-z0-9_-]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[usr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bpk_\d+_[A-Za-z0-9]{16,}/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const LABELLED = /\b(pass(?:word|wd|code|phrase)?|pwd|secret|api[_ -]?key|(?:access|auth|refresh)[_ -]?token|client[_ -]?secret|private[_ -]?key)\b(["']?\s*(?:[:=]|\bis\b)\s*["']?)([^\s"',;]{4,})/gi;
// Not secrets, but nothing a bot needs: people's addresses and numbers, and identifiers issued by government.
const PERSONAL = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi, '[redacted]'],
  [/\b([A-Z][A-Z0-9]*_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|PWD|DSN))\s*=\s*\S+/g, '$1=[redacted]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/(?:\+63[ -]?\d{3}|\b09\d{2})[ -]?\d{3}[ -]?\d{4}\b/g, '[phone]'],
  [/\b(TIN|SSS|PhilHealth|Pag-?IBIG)\b([^\n\d]{0,20})\d[\d -]{6,}\d/gi, '$1$2[id]'],
];
/** Removes what it recognises. A bare password with no label stays, which is why the preview exists. */
export function scrub(text) {
  let hits = 0;
  let out = text;
  for (const re of SHAPES) out = out.replace(re, () => { hits++; return '[redacted]'; });
  out = out.replace(LABELLED, (_, name, sep) => { hits++; return name + sep + '[redacted]'; });
  for (const [re, to] of PERSONAL) {
    hits += (out.match(re) ?? []).length;
    out = out.replace(re, to);
  }
  return { text: out, hits };
}
