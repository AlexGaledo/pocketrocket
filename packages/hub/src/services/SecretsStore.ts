import fs from 'node:fs';
import path from 'node:path';
import type { SecretsStatus } from '@pocketrocket/shared';
import { SECRETS_PATH } from '../config.js';

/** Keys the settings UI offers a field for. Provider adapters read them through SecretsStore.get(). */
export const SECRET_KEYS = ['XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/**
 * API keys for providers that need one. Stored as flat JSON in <DATA_DIR>/secrets.json; an environment
 * variable of the same name always wins, so a machine-level key needs no UI. Values never leave the hub:
 * the REST layer only reports which keys are set.
 */
export class SecretsStore {
  constructor(private file: string = SECRETS_PATH) {}

  private read(): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v;
      return out;
    } catch {
      return {};
    }
  }

  private write(all: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }

  /** Environment variable if set, else the stored value, else null. */
  get(key: string): string | null {
    const env = process.env[key];
    if (env) return env;
    return this.read()[key] ?? null;
  }

  /** Which keys resolve to a value (never the values themselves). */
  status(): SecretsStatus {
    const stored = this.read();
    const keys: Record<string, boolean> = {};
    for (const k of new Set([...SECRET_KEYS, ...Object.keys(stored)])) keys[k] = !!(process.env[k] || stored[k]);
    return { keys };
  }

  /** Set or (with an empty string) delete keys. Returns the new status. */
  set(patch: Record<string, string>): SecretsStatus {
    const all = this.read();
    for (const [k, v] of Object.entries(patch)) {
      if (v === '') delete all[k];
      else all[k] = v;
    }
    this.write(all);
    return this.status();
  }
}
