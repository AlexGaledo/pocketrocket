import type { ModelInfo, ProviderInfo } from '@pocketrocket/shared';
import { StubProvider } from './stub.js';

export const GROK_INFO: Omit<ProviderInfo, 'check' | 'models'> = {
  id: 'grok',
  label: 'Grok',
  blurb: 'xAI Grok through the Grok Build CLI, or a direct xAI API loop. Needs a SuperGrok login or an xAI key.',
  authModes: ['subscription', 'apiKey'],
  secretKeys: ['XAI_API_KEY'],
  permissions: 'best-effort',
};

// Placeholder list: P2C confirms the slugs the CLI/API accept.
export const GROK_MODELS: ModelInfo[] = [
  { id: 'grok-code-fast-1', label: 'Grok Code Fast 1', note: 'cheapest, coding', default: true },
  { id: 'grok-4-fast', label: 'Grok 4 Fast', note: 'fast general purpose' },
  { id: 'grok-4.6', label: 'Grok 4.6', note: 'strongest' },
];

export const GROK_HINT =
  'Install the Grok Build CLI (`npm i -g @vibe-kit/grok-cli`) and log in, or paste an xAI API key (XAI_API_KEY) in Settings. ' +
  'The adapter itself lands in phase P2C.';

export function createGrokProvider() {
  return new StubProvider(GROK_INFO, GROK_MODELS, GROK_HINT);
}
