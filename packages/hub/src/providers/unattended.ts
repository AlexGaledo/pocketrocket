import type { Bot, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import type { AgentProvider } from './types.js';

/**
 * Providers whose consumer login allows only turns a person started (spec 01 §2 [G3], 05 §01 #1). On these, routines,
 * triggers, workflow steps and timed retries refuse unless the CLI itself reports API-key auth. A bug here is a terms
 * breach, so the rule fails closed: an unknown or unreadable auth counts as the consumer login.
 */
export const ATTENDED_ONLY_ON_LOGIN: ReadonlySet<ProviderId> = new Set<ProviderId>(['gemini']);

export interface UnattendedDeps {
  forBot(bot: Pick<Bot, 'provider'>): AgentProvider;
  /** M8: the provider a failover item runs on instead of the bot's own. */
  get?(id: ProviderId): AgentProvider;
  /** `force` re-runs the detection: an unattended turn decides on what the CLI says now, not a minute ago. */
  check(id: ProviderId, force?: boolean): Promise<ProviderCheck>;
}

/**
 * The note for a refused unattended turn, or null when `bot` may run one. Used as `RoomRouter.unattendedRefusal`.
 * `provider` (M8): the turn runs on that provider instead of the bot's own (a failover backup).
 */
export async function unattendedRefusal(deps: UnattendedDeps, bot: Bot, provider?: ProviderId): Promise<string | null> {
  const p = provider && deps.get ? deps.get(provider) : deps.forBot(bot);
  if (!ATTENDED_ONLY_ON_LOGIN.has(p.id)) return null;
  const c = await deps.check(p.id, true);
  if (c.auth === 'apiKey') return null;
  return (
    bot.name + ' did not run: ' + p.label + ' on a Google sign-in only answers messages a person sends. ' +
    'Routines, triggers and workflow steps need a Gemini API key (Settings, Providers), or run them yourself with Run now.'
  );
}
