import type { ContextUsage } from '@pocketrocket/shared';
import { laneKey } from './queue';

/**
 * Context meter (P4-2). The store keeps one {@link ContextUsage} per bot and room, keyed like the queue lanes
 * (`botId:roomId`), fed by `turn.end` and by `GET /api/rooms/:id/context` when a room or bot page opens. The hub only
 * sends it for providers that measure context size, so a missing entry means "nothing to show".
 */
export type Contexts = Record<string, ContextUsage>;

export const contextKey = laneKey;

/** One turn ended: its context, or none (a provider that does not measure it) which drops the old entry. */
export function applyContext(contexts: Contexts, botId: string, roomId: string, usage: ContextUsage | undefined): Contexts {
  const key = contextKey(botId, roomId);
  if (usage) return { ...contexts, [key]: usage };
  if (!(key in contexts)) return contexts;
  const next = { ...contexts };
  delete next[key];
  return next;
}

/** A room's whole snapshot: replaces every entry of that room, other rooms untouched. */
export function replaceRoomContexts(contexts: Contexts, roomId: string, byBot: Record<string, ContextUsage>): Contexts {
  const suffix = ':' + roomId;
  const next: Contexts = {};
  for (const [key, u] of Object.entries(contexts)) if (!key.endsWith(suffix)) next[key] = u;
  for (const [botId, u] of Object.entries(byBot)) next[contextKey(botId, roomId)] = u;
  return next;
}

/** 84_000 -> "84k", 1_000_000 -> "1M", 1_500_000 -> "1.5M", 900 -> "900". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return +(n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(Math.round(n));
}

/** What the Meter shows: the fill, "84k of 200k tokens", and the rotation marker. */
export function contextMeterProps(u: ContextUsage): { value: number; detail: string; marker?: { value: number; label: string } } {
  const pct = (n: number) => (u.window > 0 ? (n / u.window) * 100 : 0);
  return {
    value: pct(u.contextTokens),
    detail: fmtTokens(u.contextTokens) + ' of ' + fmtTokens(u.window) + ' tokens',
    ...(u.rotateAt != null && u.rotateAt < u.window ? { marker: { value: pct(u.rotateAt), label: 'a fresh session starts at ' + fmtTokens(u.rotateAt) } } : {}),
  };
}
