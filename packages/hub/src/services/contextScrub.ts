import { redact } from '../providers/redact.js';

/**
 * What `redact` cannot know: a credential given as `name: value`. A bare password with no label still gets
 * through, which is why imported text is reviewed by the owner before a bot can read it.
 * scripts/context-import.mjs carries the same rules so secrets are gone before anything leaves the PC.
 */
const LABELLED = /\b(pass(?:word|wd|code|phrase)?|pwd|secret|api[_ -]?key|(?:access|auth|refresh)[_ -]?token|client[_ -]?secret|private[_ -]?key)\b(["']?\s*(?:[:=]|\bis\b)\s*["']?)([^\s"',;]{4,})/gi;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Not secrets, but nothing a bot needs: people's addresses and numbers, and identifiers issued by government. */
const PERSONAL: [RegExp, string][] = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi, '[redacted]'],
  [/\b([A-Z][A-Z0-9]*_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|PWD|DSN))\s*=\s*\S+/g, '$1=[redacted]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/(?:\+63[ -]?\d{3}|\b09\d{2})[ -]?\d{3}[ -]?\d{4}\b/g, '[phone]'],
  [/\b(TIN|SSS|PhilHealth|Pag-?IBIG)\b([^\n\d]{0,20})\d[\d -]{6,}\d/gi, '$1$2[id]'],
];

export function scrubContext(text: string): string {
  let out = redact(text).replace(PEM, '[redacted]').replace(LABELLED, (_, name: string, sep: string) => name + sep + '[redacted]');
  for (const [re, to] of PERSONAL) out = out.replace(re, to);
  return out;
}
