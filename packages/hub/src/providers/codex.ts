import type { ModelInfo, ProviderInfo } from '@pocketrocket/shared';
import { StubProvider } from './stub.js';

export const CODEX_INFO: Omit<ProviderInfo, 'check' | 'models'> = {
  id: 'codex',
  label: 'OpenAI Codex',
  blurb: 'The Codex CLI in headless mode (`codex exec`). Sign in with ChatGPT or an OpenAI API key.',
  authModes: ['subscription', 'apiKey'],
  secretKeys: ['OPENAI_API_KEY'],
  permissions: 'best-effort',
};

// Placeholder list: P2A replaces this with the ids the installed CLI actually accepts.
export const CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', note: 'balanced, default', default: true },
  { id: 'gpt-5.5-codex-mini', label: 'GPT-5.5 Codex mini', note: 'cheapest, fastest' },
  { id: 'gpt-5.5', label: 'GPT-5.5', note: 'general purpose' },
];

export const CODEX_HINT =
  'Install the Codex CLI (`npm i -g @openai/codex`) and run `codex login` (ChatGPT) or `codex login --with-api-key`. ' +
  'The adapter itself lands in phase P2A.';

export function createCodexProvider() {
  return new StubProvider(CODEX_INFO, CODEX_MODELS, CODEX_HINT);
}
