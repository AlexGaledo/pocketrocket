import type { ModelInfo, ProviderCheck, ProviderId, ProviderInfo, ProvidersResponse, Settings } from '@pocketrocket/shared';
import { ENABLED_PROVIDERS } from '../config.js';
import { ClaudeProvider } from './claude.js';
import { createCodexProvider } from './codex.js';
import { createOpenCodeProvider } from './opencode.js';
import { createGrokProvider } from './grok.js';
import type { AgentProvider } from './types.js';

const CHECK_TTL_MS = 60_000;

export interface RegistryDeps {
  /** Usually the SettingsStore; only `get()` is used, so tests can pass a literal. */
  settings: { get(): Settings };
  /**
   * Providers this hub offers (defaults to ENABLED_PROVIDERS). The others are still constructed — which
   * starts nothing — but are never listed, checked, run or shut down.
   */
  enabled?: readonly ProviderId[];
}

export interface ProviderRegistry {
  byId: Record<ProviderId, AgentProvider>;
  claude: ClaudeProvider;
  /** The provider ids this hub offers, in PROVIDER_IDS order. Always includes 'claude'. */
  enabled: readonly ProviderId[];
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

  const get = (id: ProviderId): AgentProvider => (enabled.includes(id) ? byId[id] : undefined) ?? claude;

  const check = async (id: ProviderId, force = false): Promise<ProviderCheck> => {
    // Checking spawns the provider's CLI (`opencode --version`, `codex login status`, ...); a disabled one never runs.
    if (!enabled.includes(id)) return { ok: false, auth: 'unknown', error: id + ' is not enabled on this hub' };
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
        providers.push({ ...p.info, check: await check(id), models: await p.models() });
      }
      return { active: get(deps.settings.get().provider).id, providers };
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
