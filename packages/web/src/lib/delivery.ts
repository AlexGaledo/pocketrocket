import type { Bot, DeliveryPayload, Message, ProvidersResponse, QueueReason, SendMode, Settings } from '@pocketrocket/shared';

/**
 * Steering (02 task 1.4). What happened to a person's message that reached a busy bot, in words, for the status line
 * under its bubble. Only the hub's answer (`message.update` with a {@link DeliveryPayload}) is described: before it
 * arrives nothing is promised, and a bot that was idle has no entry and no line.
 */
export interface DeliveryLine { botId: string; text: string; steered: boolean }

/** The delivery result on a message, or null when it carries none (a bot's message, or every target was idle). */
export function deliveryOf(m: Pick<Message, 'authorType' | 'payload'>): DeliveryPayload | null {
  if (m.authorType !== 'user' || !m.payload || typeof m.payload !== 'object') return null;
  const p = m.payload as DeliveryPayload;
  const steered = p.steered && typeof p.steered === 'object' ? p.steered : undefined;
  const queued = p.queued && typeof p.queued === 'object' ? p.queued : undefined;
  if (!(steered && Object.keys(steered).length) && !(queued && Object.keys(queued).length)) return null;
  return { ...(steered ? { steered } : {}), ...(queued ? { queued } : {}) };
}

function queuedText(name: string, reason: QueueReason | undefined, providerLabel: string | null): string {
  switch (reason) {
    case 'provider': return 'Queued: ' + (providerLabel ?? name) + " can't take messages mid-task";
    case 'between-runs': return 'Queued: ' + name + ' was between steps';
    case 'requeued': return 'Queued: ' + name + ' answers this next';
    // The queue's pause, not the screen's. Past tense: the payload stays after a resume, as the other reasons do.
    case 'paused': return 'Queued: ' + name + "'s queue was paused";
    // shortcut, setting, and anything a newer hub adds: the plain fact, never a reason we cannot back up.
    default: return 'Queued for after ' + name + "'s reply";
  }
}

/**
 * One line per bot, steered first. A bot both steered and queued (a requeue the hub has not cleaned up) reads as
 * queued, because that is what will happen. `providerLabel` names the provider for the `provider` reason ("Gemini
 * can't take messages mid-task"); without it the bot's name is used.
 */
export function deliveryLines(p: DeliveryPayload, bots: Pick<Bot, 'id' | 'name'>[], providerLabel: string | null = null): DeliveryLine[] {
  const name = (id: string) => bots.find((b) => b.id === id)?.name ?? 'The bot';
  const queued = p.queued ?? {};
  const out: DeliveryLine[] = [];
  for (const id of Object.keys(p.steered ?? {})) if (!queued[id]) out.push({ botId: id, text: 'Joined ' + name(id) + "'s reply", steered: true });
  for (const [id, q] of Object.entries(queued)) out.push({ botId: id, text: queuedText(name(id), q?.reason, providerLabel), steered: false });
  return out;
}

/**
 * Whether a bot's provider can take a message mid-turn. Every bot runs on the active provider today, so this asks that
 * provider; `ProviderInfo.steer` missing (an older hub) or the list not loaded yet means no.
 */
export function canSteer(providers: ProvidersResponse | null, settings: Pick<Settings, 'provider'>): boolean {
  return !!providers?.providers.find((p) => p.id === (settings.provider ?? providers.active))?.steer;
}

/**
 * Which mode a key press in the composer sends with, or null when it does not send. Enter leaves the mode out, so the
 * hub applies Settings > busyMessages; Ctrl+Enter (Cmd+Enter on a Mac) always queues. Alt+Enter is the desktop app's
 * full-screen toggle and Shift+Enter is a new line, so neither sends.
 */
export function sendKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): { mode?: SendMode } | null {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey) return null;
  return e.ctrlKey || e.metaKey ? { mode: 'queue' } : {};
}

/**
 * The send-mode choice (menu beside Send) is offered only while one of the room's bots is busy and its provider can
 * steer. Otherwise every message is simply sent and the composer stays as it always was.
 */
export function showSendChoice(busyBotIds: readonly string[], steerable: (botId: string) => boolean): boolean {
  return busyBotIds.some(steerable);
}

/**
 * For each turn id, whether its work already showed earlier in the transcript: the bot's group was split by a message
 * in between (usually the person's steer), so the WorkLine of the later part is "continued", not a new turn.
 * Returns, per group index, the turn ids seen in earlier groups.
 */
export function earlierTurns(groups: readonly { items: readonly Pick<Message, 'turnId'>[] }[]): Set<string>[] {
  const seen = new Set<string>();
  return groups.map((g) => {
    const before = new Set(seen);
    for (const m of g.items) if (m.turnId) seen.add(m.turnId);
    return before;
  });
}
