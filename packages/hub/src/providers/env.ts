/**
 * Environment allowlist for provider children (audit 2026-09-09, B7).
 *
 * Every adapter used to spawn its CLI with `{ ...process.env }`, so one prompt injection that got a shell
 * (`env`, `printenv`, `node -e "process.env"`) handed the model the hub's own bearer token — full authority
 * over `/api/*` — plus every other provider's API key. Children now start from a small allowlist of things a
 * CLI genuinely needs to run (PATH, temp dirs, locale, proxies) plus the keys that one provider explicitly
 * owns. `POCKETROCKET_TOKEN` is never on any list, and a provider never sees another provider's key.
 */

export type ProviderKind = 'claude' | 'codex' | 'opencode' | 'grok';

/** Names every child gets when the hub has them. Matched case-insensitively (Windows env is case-blind). */
const BASE_NAMES = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'LANG', 'TERM', 'SHELL', 'DISPLAY', 'NODE_NO_WARNINGS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE',
];
/** Prefixes every child gets: XDG_* (Linux dirs) and LC_* (locale). */
const BASE_PREFIXES = ['XDG_', 'LC_'];

/** Per-provider extras: exactly the keys that provider's CLI documents, and nothing from its neighbours. */
const PROVIDER_NAMES: Record<ProviderKind, string[]> = {
  // The Agent SDK reads ANTHROPIC_API_KEY; CLAUDE_* covers CLAUDE_CODE_*, CLAUDE_CONFIG_DIR, ...
  claude: ['ANTHROPIC_API_KEY'],
  // CODEX_HOME relocates its config; POCKETROCKET_MCP_TOKEN is the per-turn hub MCP bearer.
  codex: ['OPENAI_API_KEY', 'CODEX_HOME', 'POCKETROCKET_MCP_TOKEN'],
  // OpenCode is a multi-provider front end and reads all three vendor keys itself.
  opencode: ['XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  grok: ['XAI_API_KEY'],
};
const PROVIDER_PREFIXES: Record<ProviderKind, string[]> = {
  claude: ['CLAUDE_'],
  codex: [],
  // OPENCODE_SERVER_PASSWORD / OPENCODE_CONFIG_CONTENT are set explicitly by the adapter and covered here.
  opencode: ['OPENCODE_'],
  grok: ['GROK_', 'POCKETROCKET_MCP_'],
};

/** Never forwarded, whatever a prefix would say. The hub token is the crown jewel. */
const DENY = new Set(['pocketrocket_token']);

function allowed(key: string, provider: ProviderKind): boolean {
  const k = key.toLowerCase();
  if (DENY.has(k)) return false;
  if (BASE_NAMES.some((n) => n.toLowerCase() === k)) return true;
  if (BASE_PREFIXES.some((p) => k.startsWith(p.toLowerCase()))) return true;
  if (PROVIDER_NAMES[provider].some((n) => n.toLowerCase() === k)) return true;
  return PROVIDER_PREFIXES[provider].some((p) => k.startsWith(p.toLowerCase()));
}

/**
 * The env a `provider` child should run with: the allowlist filtered out of `source`, then `extra` applied
 * last (an explicit `undefined` in `extra` removes the key, matching the old spread-then-override style).
 */
export function childEnv(
  provider: ProviderKind,
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string' && allowed(k, provider)) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}
