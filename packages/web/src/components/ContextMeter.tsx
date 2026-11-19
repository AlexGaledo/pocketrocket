import type { ContextUsage } from '@pocketrocket/shared';
import { useStore } from '../store';
import { contextKey, contextMeterProps } from '../lib/context';
import { Meter } from './ui';

/** P4-2: how full a session's context is, with a tick where the next turn starts a fresh session. */
export function ContextMeterView({ usage, className }: { usage: ContextUsage; className?: string }) {
  return <Meter label="Context" {...contextMeterProps(usage)} className={className} />;
}

/** The (bot, room) session's meter, or nothing when the hub has no size for it (never measured, or a provider that does not report it). */
export function ContextMeter({ botId, roomId, className }: { botId: string; roomId: string | undefined; className?: string }) {
  const usage = useStore((s) => (roomId ? s.contexts[contextKey(botId, roomId)] : undefined));
  if (!usage) return null;
  return <ContextMeterView usage={usage} className={className} />;
}
