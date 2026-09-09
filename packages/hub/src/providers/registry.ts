import type { ModelInfo, ProviderCheck, ProviderId, ProviderInfo, ProvidersResponse, Settings } from '@pocketrocket/shared';
import { PROVIDER_IDS } from '@pocketrocket/shared';
import { ClaudeProvider } from './claude.js';
import { createCodexProvider } from './codex.js';
import { createOpenCodeProvider } from './opencode.js';
import { createGrokProvider } from './grok.js';
import type { AgentProvider } from './types.js';

const CHECK_TTL_MS = 60_000;

export interface RegistryDeps {
  /** Usually the SettingsStore; only `get()` is used, so tests can pass a literal. */
  settings: { get(): Settings };
}

export interface ProviderRegistry {
  byId: Record<ProviderId, AgentProvider>;
  claude: ClaudeProvider;
  list(): AgentProvider[];
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
  const cache = new Map<ProviderId, { at: number; check: ProviderCheck }>();

  const get = (id: ProviderId) => byId[id] ?? claude;

  const check = async (id: ProviderId, force = false): Promise<ProviderCheck> => {
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
    list: () => PROVIDER_IDS.map((id) => byId[id]),
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
      for (const id of PROVIDER_IDS) {
        const p = get(id);
        providers.push({ ...p.info, check: await check(id), models: await p.models() });
      }
      return { active: deps.settings.get().provider, providers };
    },
    async shutdown() {
      for (const id of PROVIDER_IDS) {
        try {
          await byId[id].shutdown?.();
        } catch {
          /* best effort */
        }
      }
    },
  };
}
