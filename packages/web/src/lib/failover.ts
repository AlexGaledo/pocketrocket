// Failover (spec 01 §4.7, P3-2): a bot hit its provider's usage limit and has a backup, so the owner gets a card to
// continue once on the backup or wait for the reset. The hub sends the whole state in GET /api/failover and on every WS
// `failover.changed`: open cards (pending only) and bots whose attended turns run on their backup until `until`.
import type { Bot, BotBackup, FailoverActive, FailoverCard, ProviderId, ProviderLimitState, ProvidersResponse, Room } from '@pocketrocket/shared';
import { fmtReset } from './limits';

/** The provider's display name ("Gemini"), or its id while GET /api/providers has not answered. */
export function providerLabel(providers: ProvidersResponse | null, id: ProviderId): string {
  return providers?.providers.find((p) => p.id === id)?.label ?? id;
}

/** The backup model's display name ("Gemini 3 Pro"), or its id when the provider does not list it. */
export function backupModelLabel(providers: ProvidersResponse | null, b: BotBackup): string {
  return providers?.providers.find((p) => p.id === b.provider)?.models.find((m) => m.id === b.model)?.label ?? b.model;
}

function sameBackup(a: BotBackup | null | undefined, b: BotBackup): boolean {
  return !!a && a.provider === b.provider && a.model === b.model;
}

/**
 * Why the hub would refuse Continue right now (its 409s), from what this page already knows, or null when Continue is
 * fair to offer. The card hides the button rather than offer one the hub would turn down. An expired card is handled
 * apart (it turns quiet), so this does not report it. The hub still has the last word: a refusal it sends is shown.
 */
export function continueBlocker(
  card: FailoverCard,
  ctx: { bot: Bot | undefined; room: Room | undefined; providers: ProvidersResponse | null; limits: readonly ProviderLimitState[]; now: number },
): string | null {
  const { bot, room, providers, limits, now } = ctx;
  const to = providerLabel(providers, card.backup.provider);
  if (!bot || !room || !room.memberIds.includes(bot.id)) return 'That bot is no longer in this chat.';
  if (!sameBackup(bot.backup, card.backup)) return bot.name + "'s backup changed since this card was raised. Send the message again.";
  if (providers && !providers.providers.some((p) => p.id === card.backup.provider)) return to + ' is not enabled on this hub.';
  const held = limits.some((l) => l.status === 'held' && l.until > now && l.provider === card.backup.provider && (!l.model || l.model === card.backup.model));
  if (held) return to + ' is at its own limit right now.';
  return null;
}

/** The bot's running-on-backup entry still in force at `now`, if any. */
export function activeFor(active: readonly FailoverActive[], botId: string, now: number): FailoverActive | null {
  return active.find((a) => a.botId === botId && a.until > now) ?? null;
}

/** "On Gemini until 14:00": the muted badge in the chat header, on the Bot page and in the sidebar row. */
export function onBackupText(a: FailoverActive, providers: ProvidersResponse | null, now = Date.now()): string {
  return 'On ' + providerLabel(providers, a.backup.provider) + ' until ' + fmtReset(a.until, now);
}

/** Open cards for one chat, oldest first. */
export function cardsForRoom(cards: readonly FailoverCard[], roomId: string): FailoverCard[] {
  return cards.filter((c) => c.roomId === roomId).sort((a, b) => a.createdAt - b.createdAt);
}
