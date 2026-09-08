import type { ModelInfo, ProviderInfo } from '@pocketrocket/shared';
import { StubProvider } from './stub.js';

export const OPENCODE_INFO: Omit<ProviderInfo, 'check' | 'models'> = {
  id: 'opencode',
  label: 'OpenCode',
  blurb: 'OpenCode running as a local server. Brings its own provider logins (ChatGPT, Claude, Copilot, xAI, ...).',
  authModes: ['subscription', 'apiKey'],
  secretKeys: [],
  permissions: 'best-effort',
};

// Empty on purpose: OpenCode model ids depend on which providers the user is logged into, so P2B reads
// them from `opencode models` at runtime instead of hardcoding a list.
export const OPENCODE_MODELS: ModelInfo[] = [];

export const OPENCODE_HINT =
  'Install OpenCode (`npm i -g opencode-ai`) and log a provider in with `opencode auth login`. ' +
  'The adapter itself lands in phase P2B.';

export function createOpenCodeProvider() {
  return new StubProvider(OPENCODE_INFO, OPENCODE_MODELS, OPENCODE_HINT);
}
