import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PROVIDER_IDS, type ProviderId, type Settings } from '@pocketrocket/shared';
import { ENABLED_PROVIDERS } from '../config.js';
import { createProviders } from './registry.js';
import { ProviderHealth } from '../services/ProviderHealth.js';
import { events } from '../events.js';
import { StubProvider } from './stub.js';
import { EMPTY_USAGE, type TurnContext, type TurnSink } from './types.js';

/** Every adapter enabled, as with POCKETROCKET_PROVIDERS=claude,codex,opencode,grok. */
function withProvider(provider: Settings['provider'], enabled: readonly ProviderId[] = PROVIDER_IDS) {
  return createProviders({ settings: { get: () => ({ ...DEFAULT_SETTINGS, provider }) }, enabled });
}

const sink: TurnSink = {
  onSession: () => undefined, onDelta: () => undefined, onText: () => undefined,
  onToolUse: () => undefined, onToolResult: () => undefined, onState: () => undefined,
};

describe('provider registry', () => {
  it('registers every provider id', () => {
    const reg = withProvider('claude');
    expect(reg.list().map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it('active() follows settings.provider', () => {
    expect(withProvider('claude').active().id).toBe('claude');
    expect(withProvider('grok').active().id).toBe('grok');
  });

  it('exposes model lists synchronously and asynchronously', async () => {
    const reg = withProvider('claude');
    expect(reg.modelsSync('claude').some((m) => m.id === 'claude-sonnet-5' && m.default)).toBe(true);
    expect(reg.modelsSync('grok').map((m) => m.id)).toContain('grok-4.6');
    expect(reg.modelsSync('opencode')).toEqual([]);
    expect(await reg.get('codex').models()).toEqual(reg.modelsSync('codex'));
  });

  it('a not-yet-implemented provider checks as not-ok with a hint and fails a turn', async () => {
    // Tests StubProvider itself rather than a registry slot, so it keeps passing as each P2x adapter lands.
    const stub = new StubProvider(
      { id: 'codex', label: 'Placeholder', blurb: '', authModes: ['apiKey'], secretKeys: [], permissions: 'best-effort', maturity: 'untested' },
      [],
      'install the CLI first',
    );
    const check = await stub.check();
    expect(check).toMatchObject({ ok: false, auth: 'unknown', error: 'Not implemented yet' });
    expect(check.hint).toContain('install the CLI first');

    const outcome = await stub.runTurn({} as TurnContext, sink);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not implemented yet');
    expect(outcome.usage).toEqual(EMPTY_USAGE);
    expect(stub.interrupt('t1')).toBe(false);
  });

  it('caches checks for 60s and re-runs them on force', async () => {
    const reg = withProvider('claude');
    let calls = 0;
    reg.byId.codex.check = async () => { calls++; return { ok: false, auth: 'unknown' as const }; };
    await reg.check('codex');
    await reg.check('codex');
    expect(calls).toBe(1);
    await reg.check('codex', true);
    expect(calls).toBe(2);
  });

  it('builds the ProvidersResponse the web UI reads', async () => {
    const reg = withProvider('grok');
    const res = await reg.response();
    expect(res.active).toBe('grok');
    expect(res.providers.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    const claude = res.providers.find((p) => p.id === 'claude')!;
    expect(claude.permissions).toBe('full');
    expect(res.providers.filter((p) => p.permissions === 'best-effort').map((p) => p.id)).toEqual(['codex', 'opencode', 'grok']);
    expect(claude.models.length).toBeGreaterThan(0);
    // response() probes every provider by spawning its real CLI, so this is genuinely slow; the default
    // 5s is enough alone but not when the suite runs it alongside everything else.
  }, 30_000);
});

describe('provider registry with only Claude enabled (the v1 default)', () => {
  it('ships Claude alone unless POCKETROCKET_PROVIDERS says otherwise', () => {
    // The env var is for development; the suite runs without it.
    if (!process.env.POCKETROCKET_PROVIDERS) expect(ENABLED_PROVIDERS).toEqual(['claude']);
    expect(createProviders({ settings: { get: () => DEFAULT_SETTINGS } }).enabled).toEqual(ENABLED_PROVIDERS);
  });

  it('lists, reports and resolves only enabled providers', async () => {
    const reg = withProvider('codex', ['claude']);
    expect(reg.list().map((p) => p.id)).toEqual(['claude']);
    // A stored provider that is disabled never runs: active() and get() fall back to Claude.
    expect(reg.active().id).toBe('claude');
    expect(reg.get('opencode').id).toBe('claude');
    let checked = 0;
    reg.claude.check = async () => { checked++; return { ok: true, auth: 'subscription' as const }; };
    const res = await reg.response();
    expect(res.active).toBe('claude');
    expect(res.providers.map((p) => p.id)).toEqual(['claude']);
    expect(checked).toBe(1);
  });

  it('never checks, spawns or shuts down a disabled provider', async () => {
    const reg = withProvider('claude', ['claude']);
    const touched: string[] = [];
    for (const id of ['codex', 'opencode', 'grok'] as const) {
      reg.byId[id].check = async () => { touched.push(id + ':check'); return { ok: true, auth: 'unknown' as const }; };
      reg.byId[id].shutdown = async () => { touched.push(id + ':shutdown'); };
    }
    const c = await reg.check('opencode', true);
    expect(c.ok).toBe(false);
    expect(c.error).toContain('not enabled');
    await reg.shutdown();
    expect(touched).toEqual([]);
  });
});

describe('provider limits (M5, spec 01 P0-2)', () => {
  it('GET /api/providers carries the limits in force, for enabled providers only', async () => {
    const health = new ProviderHealth();
    const reg = createProviders({ settings: { get: () => DEFAULT_SETTINGS }, enabled: ['claude'], health });
    expect(reg.health).toBe(health);
    const resetsAt = Date.now() + 60_000;
    health.hold('claude', { kind: 'usage', resetsAt, window: 'five_hour' });
    health.hold('codex', { kind: 'usage', resetsAt });
    const res = await reg.response();
    expect(res.limits).toMatchObject([{ provider: 'claude', status: 'held', window: 'five_hour', resetsAt }]);
  }, 30_000);

  it('the default ProviderHealth sends each change as the WS provider.limit event', () => {
    const reg = createProviders({ settings: { get: () => DEFAULT_SETTINGS }, enabled: ['claude'] });
    const seen: unknown[] = [];
    const off = events.onEvent((ev) => { if (ev.type === 'provider.limit') seen.push(ev.limits); });
    try {
      reg.health.hold('claude', { kind: 'usage', resetsAt: Date.now() + 60_000, window: 'five_hour' });
    } finally {
      off();
    }
    expect(seen).toMatchObject([[{ provider: 'claude', status: 'held', window: 'five_hour' }]]);
  });
});

describe('M6: provider per bot in the registry', () => {
  it('forBot uses the bot\'s own provider, else the default; a disabled one resolves to Claude', () => {
    const reg = createProviders({ settings: { get: () => ({ ...DEFAULT_SETTINGS, provider: 'codex' }) }, enabled: ['claude', 'codex'] });
    expect(reg.forBot({ provider: null }).id).toBe('codex');
    expect(reg.forBot({}).id).toBe('codex');
    expect(reg.forBot({ provider: 'claude' }).id).toBe('claude');
    expect(reg.forBot({ provider: 'grok' }).id).toBe('claude');
  });

  it('claudeReady needs the CLI, a sign-in the last check did not deny, and no whole-login hold', async () => {
    let exe = true;
    const health = new ProviderHealth();
    const reg = createProviders({ settings: { get: () => DEFAULT_SETTINGS }, enabled: ['claude'], health, claudeExe: () => exe });
    expect(reg.claudeReady()).toBe(true);
    exe = false;
    expect(reg.claudeReady()).toBe(false);
    exe = true;

    // A weekly Opus hold covers Opus only: the Haiku passes still run. A five-hour hold stops them until it clears.
    health.hold('claude', { kind: 'usage', window: 'seven_day_opus', resetsAt: Date.now() + 60_000 }, 'claude-opus-5');
    expect(reg.claudeReady()).toBe(true);
    health.hold('claude', { kind: 'usage', window: 'five_hour', resetsAt: Date.now() + 60_000 });
    expect(reg.claudeReady()).toBe(false);

    const fresh = createProviders({ settings: { get: () => DEFAULT_SETTINGS }, enabled: ['claude'], claudeExe: () => true });
    fresh.claude.check = async () => ({ ok: false, auth: 'none', error: 'Claude Code is installed but not signed in.' });
    await fresh.check('claude', true);
    expect(fresh.claudeReady()).toBe(false);
    // A check that timed out says nothing about the login.
    fresh.claude.check = async () => ({ ok: false, auth: 'unknown', unresponsive: true });
    await fresh.check('claude', true);
    expect(fresh.claudeReady()).toBe(true);
  });
});
