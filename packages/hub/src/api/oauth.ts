import type { IncomingMessage, ServerResponse } from 'node:http';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '@pocketrocket/shared';
import { OAUTH_CALLBACK_PREFIX, clientIp, type AuthRateLimiter } from './guard.js';
import { escapeHtml, page, send } from './authCallback.js';
import { label, type IntegrationService } from '../services/IntegrationService.js';
import { IntegrationError } from '../integrations/http.js';
import { VaultError } from '../services/IntegrationVault.js';

export const OAUTH_START_PREFIX = '/oauth/start/';

const providerFrom = (pathname: string, prefix: string): IntegrationProvider | null => {
  const p = pathname.slice(prefix.length).replace(/\/$/, '');
  return (INTEGRATION_PROVIDERS as readonly string[]).includes(p) ? (p as IntegrationProvider) : null;
};

/**
 * `POST /oauth/start/<provider>`: the Settings UI (with the hub token, like every non-exempt route) asks for
 * the provider's authorize URL. The hub mints `state` and a PKCE verifier, keeps both, and the UI opens the
 * URL in the user's browser. JSON content type required, as on `/api/*`, so a cross-site form cannot start one.
 */
export async function handleOAuthStart(req: IncomingMessage, res: ServerResponse, url: URL, deps: { integrations: IntegrationService }): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if ((req.method ?? 'GET') !== 'POST') return json(405, { error: 'Use POST' });
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return json(415, { error: 'Content-Type must be application/json' });
  const provider = providerFrom(url.pathname, OAUTH_START_PREFIX);
  if (!provider) return json(404, { error: 'Unknown provider' });
  try {
    return json(200, deps.integrations.startBrowser(provider, req.headers.host));
  } catch (e) {
    if (e instanceof IntegrationError) return json(400, { error: e.message });
    if (e instanceof VaultError) return json(500, { error: e.message });
    throw e;
  }
}

/**
 * `GET /oauth/callback/<provider>?code=…&state=…`: the provider sending the user's browser back. Token-exempt
 * (guard.ts), so it proves nothing by itself: with no sign-in pending, or a state that does not match one,
 * it is refused and counts as a failed auth for the rate limiter. The answer is a self-contained page.
 */
export async function handleOAuthCallback(
  req: IncomingMessage, res: ServerResponse, url: URL, deps: { integrations: IntegrationService; limiter: AuthRateLimiter },
): Promise<void> {
  const ip = clientIp(req);
  const provider = providerFrom(url.pathname, OAUTH_CALLBACK_PREFIX);
  if (!provider || !deps.integrations.hasPendingBrowser()) {
    deps.limiter.fail(ip);
    return send(res, 400, failure('No sign-in is waiting on this PocketRocket. Start again from Settings → Connections.'));
  }
  const r = await deps.integrations.completeBrowser(provider, url.searchParams);
  if (!r.ok) {
    if (r.unsolicited) deps.limiter.fail(ip);
    return send(res, r.status, failure(r.message));
  }
  send(res, 200, page(
    'Connected',
    '<h1>' + escapeHtml(label(provider)) + ' is connected</h1><p>Go back to PocketRocket and choose which bots may use it. You can close this tab.</p>',
    true,
  ));
}

function failure(message: string): string {
  return page(
    'Connection failed',
    '<h1>Connection failed</h1><p>' + escapeHtml(message.slice(0, 300)) + '</p><p class="hint">Go back to PocketRocket → Settings → Connections to try again.</p>',
    false,
  );
}
