import type { ModelInfo, ProviderCheck, ProviderId, ProviderInfo, ProvidersResponse, Settings } from '@pocketrocket/shared';
import { ENABLED_PROVIDERS } from '../config.js';
import { ClaudeProvider } from './claude.js';
import { createCodexProvider } from './codex.js';
import { createOpenCodeProvider } from './opencode.js';
import { createGrokProvider } from './grok.js';
import type { AgentProvider } from './types.js';
import { ProviderHealth } from '../services/ProviderHealth.js';
import { events } from '../events.js';

const CHECK_TTL_MS = 60_000;

export interface RegistryDeps {
  /** Usually the SettingsStore; only `get()` is used, so tests can pass a literal. */
  settings: { get(): Settings };
  /**
   * Providers this hub offers (defaults to ENABLED_PROVIDERS). The others are still constructed — which
   * starts nothing — but are never listed, checked, run or shut down.
   */
  enabled?: readonly ProviderId[];
  /** M5: provider limits in force. Defaults to one that sends each change as the WS `provider.limit` event. */
  health?: ProviderHealth;
}

export interface ProviderRegistry {
  byId: Record<ProviderId, AgentProvider>;
  claude: ClaudeProvider;
  /** The provider ids this hub offers, in PROVIDER_IDS order. Always includes 'claude'. */
  enabled: readonly ProviderId[];
  /** M5: which providers (or models) are held at a usage limit, in memory. */
  health: ProviderHealth;
  list(): AgentProvider[];
  /** A disabled or unknown id resolves to Claude, so nothing disabled can ever run a turn. */
  get(id: ProviderId): AgentProvider;
  /** The provider every bot runs on right now (settings.provider). */
  active(): AgentProvider;
  modelsSync(id: ProviderId): ModelInfo[];
  /** `modelsSync` but willing to wait for a cold cache (OpenCode shells out to `opencode models`). */
  modelsAwaited(id: ProviderId): Promise<ModelInfo[]>;
  /** Cached for 60s; `force` re-runs the detection (used by POST /api/providers/:id/check). */
  check(id: ProviderId, force?: boolean): Promise<ProviderCheck>;
  response(): Promise<ProvidersResponse>;
  shutdown(): Promise<void>;
}

export function createProviders(deps: RegistryDeps): ProviderRegistry {
  const claude = new ClaudeProvider();
  const byId: Record<ProviderId, AgentProvider> = {
    claude,
    codex: createCodexProvider(),
    opencode: createOpenCodeProvider(),
    grok: createGrokProvider(),
  };
  const enabled = deps.enabled ?? ENABLED_PROVIDERS;
  const cache = new Map<ProviderId, { at: number; check: ProviderCheck }>();
  const health = deps.health ?? new ProviderHealth({ onChange: (limits) => events.emitEvent({ type: 'provider.limit', limits }) });

  const get = (id: ProviderId): AgentProvider => (enabled.includes(id) ? byId[id] : undefined) ?? claude;

  const check = async (id: ProviderId, force = false): Promise<ProviderCheck> => {
    // Checking spawns the provider's CLI (`opencode --version`, `codex login status`, ...); a disabled one never runs.
    if (!enabled.includes(id)) return { ok: false, auth: 'unknown', error: id + ' is not enabled on this server' };
    const hit = cache.get(id);
    if (!force && hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.check;
    let result: ProviderCheck;
    try {
      result = await get(id).check();
    } catch (e) {
      result = { ok: false, auth: 'unknown', error: String((e as Error).message ?? e) };
    }
    cache.set(id, { at: Date.now(), check: result });
    return result;
  };

  return {
    byId,
    claude,
    enabled,
    health,
    list: () => enabled.map((id) => byId[id]),
    get,
    active: () => get(deps.settings.get().provider),
    modelsSync: (id) => get(id).modelsSync(),
    modelsAwaited: (id) => {
      const p = get(id);
      return p.modelsAwaited ? p.modelsAwaited() : p.models();
    },
    check,
    async response(): Promise<ProvidersResponse> {
      const providers: ProviderInfo[] = [];
      for (const id of enabled) {
        const p = get(id);
        providers.push({ ...p.info, steer: p.canSteer?.() ?? false, check: await check(id), models: await p.models() });
      }
      return { active: get(deps.settings.get().provider).id, providers, limits: health.list().filter((l) => enabled.includes(l.provider)) };
    },
    async shutdown() {
      // Only enabled providers can have started anything (a disabled one never runs a turn).
      for (const id of enabled) {
        try {
          await byId[id].shutdown?.();
        } catch {
          /* best effort */
        }
      }
    },
  };
}
