import {
  DEFAULT_SETTINGS, SettingsSchema, type ModelInfo, type ProviderId, type Settings, type SettingsPatch,
} from '@pocketrocket/shared';
import { osUserName } from '../config.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';

export interface SettingsDeps {
  repos: Repos;
  /**
   * Model list for a provider, read synchronously from the registry cache. Used when the provider changes
   * to re-point bots whose model does not exist in the new provider. Omitted in tests that never switch.
   */
  models?: (provider: ProviderId) => ModelInfo[];
  /**
   * Awaiting variant of `models`, used when the sync cache is still cold: OpenCode reads its model list
   * from `opencode models`, so switching to it right after startup would otherwise leave every bot
   * pointing at a model OpenCode does not offer. Omitted in tests that never switch.
   */
  modelsAsync?: (provider: ProviderId) => Promise<ModelInfo[]>;
}

/** Defaults with the OS account name filled in for `userName`. */
export function defaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS, userName: osUserName() };
}

/**
 * Global hub settings, persisted one row per key in the `settings` table. Values are JSON so a key can
 * hold anything the schema allows; unknown/corrupt rows fall back to the schema default.
 */
export class SettingsStore {
  private cache: Settings | null = null;

  constructor(private deps: SettingsDeps) {}

  get(): Settings {
    if (!this.cache) {
      const stored = this.deps.repos.allSettings();
      const parsed = SettingsSchema.safeParse({ ...stored });
      const base = parsed.success ? parsed.data : defaultSettings();
      // userName defaults to the OS account name rather than the schema's placeholder.
      this.cache = stored.userName === undefined ? { ...base, userName: osUserName() } : base;
    }
    return this.cache;
  }

  /** Validate + persist a partial update. Emits settings.changed (and providers.changed on a switch). */
  patch(p: SettingsPatch): Settings {
    const prev = this.get();
    const next = SettingsSchema.parse({ ...prev, ...p });
    for (const [k, v] of Object.entries(next)) {
      if ((prev as Record<string, unknown>)[k] !== v || (p as Record<string, unknown>)[k] !== undefined) {
        this.deps.repos.setSetting(k, v);
      }
    }
    this.cache = next;
    events.emitEvent({ type: 'settings.changed', settings: next });
    if (next.provider !== prev.provider) {
      if (!this.repointBots(next.provider) && this.deps.modelsAsync) {
        // Cold model cache. Repoint once the real list lands; the events it emits update the UI then.
        void this.deps
          .modelsAsync(next.provider)
          .then((models) => {
            // A second switch may have landed while we waited; only repoint if this is still the provider.
            if (this.get().provider === next.provider) this.repointBots(next.provider, models);
          })
          .catch(() => {
            /* the provider is unreachable; bots keep their model and the turn path resolves it */
          });
      }
      events.emitEvent({ type: 'providers.changed', active: next.provider });
    }
    return next;
  }

  /** Test/CLI helper: drop the memo so the next get() re-reads the table. */
  reload() {
    this.cache = null;
  }

  /**
   * After a provider switch, bots pointing at a model the new provider does not offer are moved to that
   * provider's default model, with a system message in every room the bot is in.
   *
   * Returns false when the provider's model list is not known yet, so the caller can retry asynchronously.
   */
  private repointBots(provider: ProviderId, knownModels?: ModelInfo[]): boolean {
    const models = knownModels ?? this.deps.models?.(provider) ?? [];
    if (!models.length) return false;
    const fallback = models.find((m) => m.default)?.id ?? models[0].id;
    const known = new Set(models.map((m) => m.id));
    let changed = false;
    for (const bot of this.deps.repos.listBots()) {
      if (known.has(bot.model)) continue;
      const from = bot.model;
      this.deps.repos.updateBot(bot.id, { model: fallback });
      changed = true;
      for (const room of this.deps.repos.listRooms()) {
        if (!room.memberIds.includes(bot.id)) continue;
        const msg = this.deps.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: null, kind: 'system',
          text: bot.name + ' switched to ' + fallback + ' (' + from + ' is not available on ' + provider + ').',
          payload: null, causeId: null, hop: 0, turnId: null,
        });
        events.emitEvent({ type: 'message.new', message: msg });
      }
    }
    if (changed) events.emitEvent({ type: 'bots.changed', bots: this.deps.repos.listBots() });
    return true;
  }
}

// ---- ambient accessor -------------------------------------------------------
// PromptBuilder / hub tools / RoomRouter need settings.userName without threading the store through every
// call site. index.ts installs the real store at startup; tests that never install one see the defaults.
let installed: SettingsStore | null = null;
export function installSettings(store: SettingsStore) {
  installed = store;
}
export const settings = {
  get(): Settings {
    return installed ? installed.get() : defaultSettings();
  },
};
