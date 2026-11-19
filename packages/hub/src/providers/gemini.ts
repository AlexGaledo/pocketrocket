import type { InitializeResponse } from '@agentclientprotocol/sdk';
import type { ModelInfo, ProviderAuth, ProviderCheck, ProviderStaticInfo } from '@pocketrocket/shared';
import { SecretsStore } from '../services/SecretsStore.js';
import { run } from './codex.js';
import { AcpProvider, ACP_START_TIMEOUT_MS, type AcpPreset, type AcpProviderOptions } from './acp/adapter.js';
import { findExe } from './acp/client.js';
import type { TurnLimit } from './types.js';

/**
 * Gemini through Google's Antigravity CLI, `agy acp` (spec 01 §4.8, P2-2): the first preset of the generic ACP
 * adapter. PocketRocket never downloads or installs `agy` (it is closed source); it finds the user's own copy and
 * drives it as is, which is the one route a Google AI Pro login allows [G3].
 *
 * UNTESTED: written to the ACP contract and a fake agent, never run against a real `agy` or Google account. The owner's
 * live test (P2-4, docs/PRODUCTION-CHECKLIST.md) confirms the install path, the sign-in, how `agy` reports its auth,
 * the API-key variable, whether it asks before writes and shell, and a real limit message. Until then: `untested`.
 */

export const GEMINI_INFO: ProviderStaticInfo = {
  id: 'gemini',
  label: 'Gemini',
  blurb: "Google Gemini through the Antigravity CLI (agy). Sign in with Google, or use a Gemini API key.",
  authModes: ['subscription', 'apiKey'],
  secretKeys: ['GEMINI_API_KEY'],
  // Parity depends on agy asking through session/request_permission; unverified until P2-4.
  permissions: 'best-effort',
  maturity: 'untested',
};

/** The variable the key is handed to `agy` in. Gemini's documented name; P2-4 confirms `agy` reads it. */
export const GEMINI_KEY_VAR = 'GEMINI_API_KEY';

/**
 * No version has been run against PocketRocket yet. P2-4 records the first one here ({ min: '1.2.0', max: '1.2.9' }),
 * and `testedVersions` on the info follows it.
 */
export const AGY_TESTED: { min: string; max: string } | null = null;

/**
 * Curated, not discovered: ACP has no model list call. The bot's model is only applied when `agy` offers it as a
 * `model` config option; otherwise `agy` keeps its own default. P2-4 replaces these ids with what `agy` offers.
 */
export const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-default', label: 'Gemini (agy default)', note: "whatever agy is set to", default: true },
  { id: 'gemini-3-pro', label: 'Gemini 3 Pro', note: 'strongest; used only if agy offers it' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash', note: 'faster; used only if agy offers it' },
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

export function findAgyExe(): Promise<string | null> {
  // AGY_EXE first; the default install folder is added once a live install confirms it (spec 01 §4.8); then PATH.
  return findExe('agy', 'AGY_EXE');
}

export interface GeminiProviderOptions extends AcpProviderOptions {
  secrets?: Pick<SecretsStore, 'get'>;
}

export function geminiPreset(opts: GeminiProviderOptions = {}): AcpPreset {
  const secrets = opts.secrets ?? new SecretsStore();
  const findExe = () => (opts.exe ? Promise.resolve(opts.exe) : findAgyExe());
  return {
    info: GEMINI_INFO,
    envKind: 'gemini',
    models: GEMINI_MODELS,
    hint: GEMINI_HINT,
    cliName: 'agy',
    findExe,
    args: ['acp'],
    env: () => {
      const key = secrets.get(GEMINI_KEY_VAR);
      return key ? { [GEMINI_KEY_VAR]: key } : {};
    },
    limitOf: (text) => geminiLimit(text),
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
      const auth = parseGeminiAuth(p.init);
      return {
        ok: true,
        auth: auth.auth,
        ...(auth.method ? { authMethod: auth.method } : {}),
        ...(version ? { version } : {}),
        ...(warning ? { versionWarning: warning } : {}),
        exePath: exe,
        hint: GEMINI_HINT,
      };
    },
  };
}

export function createGeminiProvider(opts: GeminiProviderOptions = {}): AcpProvider {
  return new AcpProvider(geminiPreset(opts), opts);
}
