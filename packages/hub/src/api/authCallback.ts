import type { IncomingMessage, ServerResponse } from 'node:http';
import { clientIp, type AuthRateLimiter } from './guard.js';
import { AccountError, type AccountService } from '../services/AccountService.js';

/**
 * `GET /auth/callback?code=…` (or `?error=…&error_description=…`): the email link or OAuth provider landing in
 * the user's default browser. No hub token rides along (see checkToken), so this proves nothing about the
 * caller: a request with no sign-in waiting, or a code that does not exchange, counts as a failed auth for
 * the limiter. The answer is a self-contained page; every piece of input in it is escaped.
 */
export async function handleAuthCallback(
  req: IncomingMessage, res: ServerResponse, url: URL, deps: { account: AccountService; limiter: AuthRateLimiter },
): Promise<void> {
  const ip = clientIp(req);
  if (!deps.account.pending()) {
    deps.limiter.fail(ip);
    return send(res, 400, failurePage('No sign-in is waiting on this PocketRocket. Start again from Settings → Account.'));
  }
  const supabaseError = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (supabaseError) return send(res, 400, failurePage(supabaseError));
  const code = url.searchParams.get('code');
  if (!code) {
    deps.limiter.fail(ip);
    return send(res, 400, failurePage('This sign-in link has no code in it.'));
  }
  try {
    const state = await deps.account.exchangeCode(code);
    send(res, 200, successPage(state.user?.email ?? ''));
  } catch (e) {
    deps.limiter.fail(ip);
    if (!(e instanceof AccountError)) console.error(e);
    send(res, e instanceof AccountError ? e.status : 500, failurePage(e instanceof AccountError ? e.message : 'Sign-in failed.'));
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function successPage(email: string): string {
  return page('Signed in', '<h1>Signed in to PocketRocket</h1><p>as <strong>' + escapeHtml(email) + '</strong> — you can close this tab.</p>', true);
}

export function failurePage(message: string): string {
  return page(
    'Sign-in failed',
    '<h1>Sign-in failed</h1><p>' + escapeHtml(message.slice(0, 300)) + '</p><p class="hint">Go back to PocketRocket to try again, or enter the code from the email.</p>',
    false,
  );
}

function page(title: string, body: string, ok: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · PocketRocket</title><style>
:root{color-scheme:light dark;--bg:#f5f5f3;--card:#fff;--fg:#1b1b19;--muted:#63635e;--line:#e3e3de;--mark:${ok ? '#15803d' : '#b91c1c'}}
@media (prefers-color-scheme:dark){:root{--bg:#131312;--card:#1c1c1a;--fg:#ececea;--muted:#a1a19b;--line:#2d2d2a;--mark:${ok ? '#4ade80' : '#f87171'}}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:0 16px}
main{box-sizing:border-box;width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-top:3px solid var(--mark);border-radius:12px;padding:1.75rem}
h1{font-size:1.15rem;margin:0 0 .4rem}p{margin:0;color:var(--muted);overflow-wrap:anywhere}strong{color:var(--fg);font-weight:600}.hint{margin-top:.9rem;font-size:.9rem}
</style></head><body><main>${body}</main></body></html>`;
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}
