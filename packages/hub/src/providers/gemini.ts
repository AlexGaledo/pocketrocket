import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InitializeResponse } from '@agentclientprotocol/sdk';
import type { ModelInfo, ProviderAuth, ProviderCheck, ProviderStaticInfo } from '@pocketrocket/shared';
import { SecretsStore } from '../services/SecretsStore.js';
import { run } from './codex.js';
import { AcpProvider, ACP_START_TIMEOUT_MS, type AcpPreset, type AcpProviderOptions } from './acp/adapter.js';
import { findExe } from './acp/client.js';
import { childEnv } from './env.js';
import type { TurnLimit } from './types.js';

/**
 * Gemini through Google's Antigravity CLI, `agy acp` (spec 01 §4.8, P2-2): the first preset of the generic ACP
 * adapter. PocketRocket never downloads or installs `agy` (it is closed source); it finds the user's own copy and
 * drives it as is, which is the one route a Google AI Pro login allows [G3].
 *
 * Live-tested (P2-4, docs/PRODUCTION-CHECKLIST.md §4a) with agy 1.5.12 on Linux and a Gemini API key: DMs, resume,
 * context size, hub MCP tools, interrupt, a scheduled routine and usage rows work. Still `untested` in the picker:
 * the Google sign-in was not tried, no real limit has been captured, and agy's `default` mode asks before shell but
 * NOT before its own file writes (G6). So strict turns run read-only (`strictReadOnly` below).
 */

export const GEMINI_INFO: ProviderStaticInfo = {
  id: 'gemini',
  label: 'Gemini',
  blurb: "Google Gemini through the Antigravity CLI (agy). Sign in with Google, or use a Gemini API key.",
  authModes: ['subscription', 'apiKey'],
  secretKeys: ['GEMINI_API_KEY'],
  // agy asks through session/request_permission before shell, but not before its own file writes (live G6, 1.5.12).
  permissions: 'best-effort',
  // Not `verified`: writes do not ask, the Google sign-in and a real limit are untried. The picker keeps its warning.
  maturity: 'untested',
  testedVersions: '1.5.12',
};

/** The variable the key is handed to `agy` in. Gemini's documented name; P2-4 confirms `agy` reads it. */
export const GEMINI_KEY_VAR = 'GEMINI_API_KEY';

/** The agy versions run live against PocketRocket (P2-4). `GEMINI_INFO.testedVersions` says the same for the UI. */
export const AGY_TESTED: { min: string; max: string } | null = { min: '1.5.12', max: '1.5.12' };

/**
 * Curated, not discovered: ACP has no model list call. These are the `model` config option values agy 1.5.12 offered
 * live (P2-4, G8); its `models.availableModels` also lists effort variants (`-low`/`-high`), left out here. The bot's
 * model is only applied when agy offers it in that session; otherwise agy keeps its own current one. Bots saved on the
 * pre-live ids (`gemini-default`, `gemini-3-pro`, `gemini-3-flash`) read as these (`RENAMED_MODELS` in shared).
 */
export const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', note: "agy's default", default: true },
  { id: 'gemini-4-neon', label: 'Gemini 4 Neon', note: 'used only if your plan offers it' },
  { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', note: 'used only if your plan offers it' },
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', note: 'used only if your plan offers it' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', note: 'used only if your plan offers it' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'faster' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', note: 'faster' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', note: 'faster' },
];

export const GEMINI_HINT =
  "Install Google's Antigravity CLI (`agy`) from https://antigravity.google, then run `agy` once in a terminal to " +
  'sign in with Google, or set a Gemini API key in Settings. Set `AGY_EXE` if `agy` is not on PATH. ' +
  'On the Google sign-in, Gemini answers only messages a person sends; routines and triggers need the API key.';

/** `x.y.z` from whatever `agy --version` prints ("agy 1.4.2", "Antigravity CLI v1.4.2 (abc123)"), or null. */
export function parseAgyVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? m[1] + '.' + m[2] + '.' + (m[3] ?? '0') : null;
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** A warning when `version` is outside the tested range, or unreadable; null when it is a tested one. Never a refusal. */
export function agyVersionWarning(version: string | null, tested = AGY_TESTED): string | null {
  if (!version) return 'unknown agy version (untested)';
  if (!tested) return 'agy ' + version + ' has not been tested with PocketRocket yet';
  if (cmpVersion(version, tested.min) < 0) return 'agy ' + version + ' is older than the tested versions (' + tested.min + '-' + tested.max + ')';
  if (cmpVersion(version, tested.max) > 0) return 'agy ' + version + ' is newer than the tested versions (' + tested.min + '-' + tested.max + ')';
  return null;
}

/**
 * The auth `agy` says it is using, from its `initialize` answer. ACP has no standard field for the method in use
 * (`authMethods` lists what the agent *can* do), so this looks for a reported one under `_meta` (the response's or
 * `agentInfo`'s). Only an explicit API-key report counts as `apiKey`: the unattended guard (P2-3) lets routines run
 * on that alone, and **unknown counts as the Google login**. Whether `agy` reports it at all is a P2-4 item.
 */
export function parseGeminiAuth(init: Pick<InitializeResponse, '_meta' | 'agentInfo'> | null): { auth: ProviderAuth; method?: string } {
  const metas = [init?._meta, init?.agentInfo?._meta].filter((m): m is Record<string, unknown> => !!m && typeof m === 'object');
  for (const meta of metas) {
    for (const [k, v] of Object.entries(meta)) {
      if (!/auth/i.test(k)) continue;
      const method = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? String((v as { id: string }).id) : null;
      if (!method) continue;
      if (/api.?key/i.test(method)) return { auth: 'apiKey', method };
      if (/oauth|google|login|account|personal|subscription/i.test(method)) return { auth: 'subscription', method };
      return { auth: 'unknown', method };
    }
  }
  return { auth: 'unknown' };
}

/**
 * Gemini's limit matcher. SYNTHETIC: no real `agy` limit has been captured yet (fixture
 * `__fixtures__/gemini/limit-quota.synthetic.json`); it matches Google's API error vocabulary. TODO(P2-4): replace with
 * the owner's captured fixture and tighten.
 */
export function geminiLimit(text: string, now = Date.now()): TurnLimit | null {
  if (/RESOURCE_EXHAUSTED|quota|rate.?limit|usage limit|\b429\b|too many requests/i.test(text)) {
    const secs = /retry (?:in|after) (\d+(?:\.\d+)?)\s*s/i.exec(text) ?? /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(text);
    return { kind: 'usage', ...(secs ? { resetsAt: now + Math.round(Number(secs[1]) * 1000) } : {}) };
  }
  if (/UNAVAILABLE|overloaded|\b503\b|\b529\b/i.test(text)) return { kind: 'overloaded' };
  if (/UNAUTHENTICATED|PERMISSION_DENIED.*(?:login|auth)|not signed in|please (?:log|sign) in|login required/i.test(text)) return { kind: 'auth' };
  return null;
}

/** Where `agy` keeps its settings. Its `modelProvider` decides whether a Gemini API key is used at all. */
export function agySettingsPath(home = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

/** `modelProvider` from agy's settings file, or null when the file is missing, unreadable or has none. */
export function readAgyModelProvider(file = agySettingsPath()): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { modelProvider?: unknown } | null)?.modelProvider;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The auth a turn would actually run on when `agy` does not report one itself (live P2-4: agy 1.5.12 reports none).
 * agy uses the API key only when the key is in the env it is spawned with **and** its settings select
 * `modelProvider: "gemini"`; with either missing it falls back to the Google sign-in. Both are required, so the
 * unattended guard still fails closed on a half-done setup. An explicit report from agy always wins.
 */
export function inferGeminiAuth(
  reported: { auth: ProviderAuth; method?: string },
  spawnEnv: NodeJS.ProcessEnv,
  modelProvider: string | null,
): { auth: ProviderAuth; method?: string; keyIgnored?: boolean } {
  if (reported.auth !== 'unknown') return reported;
  const hasKey = !!spawnEnv[GEMINI_KEY_VAR]?.trim();
  if (hasKey && modelProvider === 'gemini') return { auth: 'apiKey', method: 'gemini-api-key' };
  return hasKey ? { ...reported, keyIgnored: true } : reported;
}

export const GEMINI_KEY_IGNORED_HINT =
  'A Gemini API key is saved, but agy only uses it when ~/.gemini/antigravity-cli/settings.json has ' +
  '"modelProvider": "gemini". Until then it runs on the Google sign-in, so routines and triggers stay off.';

export function findAgyExe(): Promise<string | null> {
  // AGY_EXE first; the default install folder is added once a live install confirms it (spec 01 §4.8); then PATH.
  return findExe('agy', 'AGY_EXE');
}

export interface GeminiProviderOptions extends AcpProviderOptions {
  secrets?: Pick<SecretsStore, 'get'>;
  /** agy's settings file (tests). Default: `agySettingsPath()`. */
  agySettings?: string;
}

export function geminiPreset(opts: GeminiProviderOptions = {}): AcpPreset {
  const secrets = opts.secrets ?? new SecretsStore();
  const findExe = () => (opts.exe ? Promise.resolve(opts.exe) : findAgyExe());
  const env = (): NodeJS.ProcessEnv => {
    const key = secrets.get(GEMINI_KEY_VAR);
    return key ? { [GEMINI_KEY_VAR]: key } : {};
  };
  return {
    info: GEMINI_INFO,
    envKind: 'gemini',
    models: GEMINI_MODELS,
    hint: GEMINI_HINT,
    cliName: 'agy',
    findExe,
    args: ['acp'],
    env,
    limitOf: (text) => geminiLimit(text),
    // Live G6: in agy's `default` mode `write_file` ran outside the workspace with no permission request. A strict turn
    // (routine, trigger, workflow step, failover backup) therefore runs in agy's `plan` mode, or not at all.
    strictReadOnly: true,
    async check(probe): Promise<ProviderCheck> {
      const exe = await findExe();
      if (!exe) return { ok: false, auth: 'none', exePath: process.env.AGY_EXE || 'agy (on PATH)', error: 'agy (the Antigravity CLI) was not found', hint: GEMINI_HINT };
      const v = await run(exe, ['--version'], ACP_START_TIMEOUT_MS);
      const p = await probe();
      if (!p.ok) {
        return {
          ok: false, auth: 'unknown', exePath: exe, version: parseAgyVersion(v.stdout + '\n' + v.stderr) ?? undefined,
          ...(p.timedOut ? { unresponsive: true } : {}), error: 'agy acp did not start: ' + p.error, hint: GEMINI_HINT,
        };
      }
      const version = parseAgyVersion(v.stdout + '\n' + v.stderr) ?? parseAgyVersion(p.init.agentInfo?.version ?? '');
      const warning = agyVersionWarning(version);
      // The same env the turn spawns agy with (AcpProvider.env): the Secrets store's key, or the hub's own variable.
      const spawnEnv = childEnv('gemini', { ...env(), ...opts.env });
      const auth = inferGeminiAuth(parseGeminiAuth(p.init), spawnEnv, readAgyModelProvider(opts.agySettings));
      return {
        ok: true,
        auth: auth.auth,
        ...(auth.method ? { authMethod: auth.method } : {}),
        ...(version ? { version } : {}),
        ...(warning ? { versionWarning: warning } : {}),
        exePath: exe,
        hint: auth.keyIgnored ? GEMINI_KEY_IGNORED_HINT + ' ' + GEMINI_HINT : GEMINI_HINT,
      };
    },
  };
}

export function createGeminiProvider(opts: GeminiProviderOptions = {}): AcpProvider {
  return new AcpProvider(geminiPreset(opts), opts);
}
