import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PROVIDER_IDS, type Settings } from '@pocketrocket/shared';
import { createProviders } from './registry.js';
import { StubProvider } from './stub.js';
import { EMPTY_USAGE, type TurnContext, type TurnSink } from './types.js';

function withProvider(provider: Settings['provider']) {
  return createProviders({ settings: { get: () => ({ ...DEFAULT_SETTINGS, provider }) } });
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
      { id: 'codex', label: 'Placeholder', blurb: '', authModes: ['apiKey'], secretKeys: [], permissions: 'best-effort' },
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
    expect(stub.interrupt()).toBe(false);
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
  });
});
