import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { cspModeFrom, webSecurityHeaders, WEB_CSP } from './csp.js';
import { createHub, type Hub } from '../hub.js';

describe('web CSP', () => {
  it('defaults to report-only and only accepts the three modes', () => {
    expect(cspModeFrom(undefined)).toBe('report-only');
    expect(cspModeFrom('')).toBe('report-only');
    expect(cspModeFrom('bogus')).toBe('report-only');
    expect(cspModeFrom(' Enforce ')).toBe('enforce');
    expect(cspModeFrom('off')).toBe('off');
  });

  it('never allows inline or eval script, framing by others, or plugins from outside', () => {
    const script = WEB_CSP.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(script).toBe("script-src 'self'");
    expect(WEB_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_CSP).toContain("object-src blob:");
    expect(WEB_CSP).not.toMatch(/unsafe-eval/);
    expect(WEB_CSP).not.toMatch(/https?:\/\/(?!ipc\.localhost)/);
  });

  it('sets the policy header by mode and keeps the other two headers', () => {
    expect(webSecurityHeaders('enforce')['content-security-policy']).toBe(WEB_CSP);
    const ro = webSecurityHeaders('report-only');
    expect(ro['content-security-policy']).toBeUndefined();
    expect(ro['content-security-policy-report-only']).toBe(WEB_CSP);
    const off = webSecurityHeaders('off');
    expect(off['content-security-policy']).toBeUndefined();
    expect(off['content-security-policy-report-only']).toBeUndefined();
    for (const h of [webSecurityHeaders('enforce'), ro, off]) {
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('no-referrer');
    }
  });
});

describe('hub static responses', () => {
  let hub: Hub;
  let port: number;
  beforeAll(async () => {
    hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: 'csp-test-token' });
    port = await hub.listen();
  });
  afterAll(async () => { await hub.shutdown(); });

  it('sends the policy (report-only by default) on the shell, and not on JSON API answers', async () => {
    const get = (p: string) => new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: { host: '127.0.0.1:' + port, authorization: 'Bearer csp-test-token' } }, (res) => {
        res.resume();
        resolve(res.headers);
      }).on('error', reject);
    });
    const shell = await get('/');
    expect(shell['content-security-policy-report-only']).toBe(WEB_CSP);
    expect(shell['content-security-policy']).toBeUndefined();
    expect(shell['x-content-type-options']).toBe('nosniff');
    expect(shell['referrer-policy']).toBe('no-referrer');
    const api = await get('/api/health');
    expect(api['content-security-policy-report-only']).toBeUndefined();
  });
});
