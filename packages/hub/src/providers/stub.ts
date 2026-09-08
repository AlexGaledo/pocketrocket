import type { ModelInfo, ProviderCheck, ProviderId, ProviderInfo } from '@pocketrocket/shared';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from './types.js';

/**
 * Placeholder for an adapter that lands in a later phase (P2A Codex, P2B OpenCode, P2C Grok). It shows up
 * in the picker with its real metadata and model list so the settings UI can be built against it, but a turn
 * fails immediately; BotRunner turns the error into a system message in the room.
 */
export class StubProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly label: string;
  constructor(
    readonly info: Omit<ProviderInfo, 'check' | 'models'>,
    private staticModels: ModelInfo[],
    private hint: string,
  ) {
    this.id = info.id;
    this.label = info.label;
  }
  async models(): Promise<ModelInfo[]> {
    return this.staticModels;
  }
  modelsSync(): ModelInfo[] {
    return this.staticModels;
  }
  async check(): Promise<ProviderCheck> {
    return { ok: false, auth: 'unknown', error: 'Not implemented yet', hint: this.hint };
  }
  async runTurn(ctx: TurnContext, _sink: TurnSink): Promise<TurnOutcome> {
    void ctx;
    return {
      ok: false,
      error: 'The ' + this.label + ' provider is not implemented yet. Switch the provider in Settings.',
      costUsd: 0,
      usage: { ...EMPTY_USAGE },
      durationMs: 0,
    };
  }
  interrupt(): boolean {
    return false;
  }
}
