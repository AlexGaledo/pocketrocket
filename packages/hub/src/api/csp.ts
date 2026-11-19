/**
 * Content-Security-Policy for the web UI the hub serves (the SPA shell and its static assets).
 *
 * File, media and auth-callback responses send their own stricter policy and never pass through here. The
 * `/screen/*` proxy keeps its own headers too (hub.ts); the page inside the Screen iframe is the noVNC
 * viewer, a separate document.
 *
 * POCKETROCKET_CSP picks the mode: `report-only` (default: the same policy, violations are only logged by the
 * browser), `enforce` or `off` (no CSP header; the other two headers stay).
 */
export type CspMode = 'enforce' | 'report-only' | 'off';

export function cspModeFrom(raw: string | undefined): CspMode {
  const v = (raw ?? '').trim().toLowerCase();
  // Report-only until the production build has been run in a browser with no violations; then flip this default.
  return v === 'enforce' || v === 'off' ? v : 'report-only';
}

/** No `unsafe-inline`/`unsafe-eval` in script-src: the theme snippet lives in /theme-init.js. */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' ipc: http://ipc.localhost",
  "frame-src 'self' blob:",
  "object-src blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers for a static web response. Existing hardening on the response is never replaced by the caller. */
export function webSecurityHeaders(mode: CspMode): Record<string, string> {
  const h: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (mode === 'enforce') h['content-security-policy'] = WEB_CSP;
  else if (mode === 'report-only') h['content-security-policy-report-only'] = WEB_CSP;
  return h;
}
