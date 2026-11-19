// The limit card (spec 01 §4.7, P3-2): a bot hit its provider's usage limit and has a backup. The owner may continue the
// request once on the backup, with approvals on, or wait for the reset. Person-only like the workflow approval card: the
// hub refuses a bot, a cta button and chat text, so only these buttons answer it. It shows in the chat it belongs to
// and in Needs you. Nothing switches on its own: a card nobody answers turns quiet at the reset.
import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import type { FailoverCard } from '@pocketrocket/shared';
import { useStore, botById } from '../store';
import { api, ApiError } from '../lib/api';
import { fmtReset, windowLabel } from '../lib/limits';
import { useLimits } from '../lib/useLimits';
import { backupModelLabel, cardsForRoom, continueBlocker, providerLabel } from '../lib/failover';
import { ActionCard, ActionCardActions, ActionCardHeader, Button } from './ui';

/** Re-renders once when `at` passes (the card's expiry), with no ticking while it waits. */
function useNowUntil(at: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const wait = at - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(wait + 250, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [at]);
  return now;
}

export function FailoverCardView({ card, className }: { card: FailoverCard; className?: string }) {
  const bot = useStore((s) => botById(s.bots, card.botId));
  const room = useStore((s) => s.rooms.find((r) => r.id === card.roomId));
  const providers = useStore((s) => s.providers);
  const dropCard = useStore((s) => s.dropFailoverCard);
  const fetchFailover = useStore((s) => s.fetchFailover);
  const limits = useLimits();
  const now = useNowUntil(card.expiresAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = bot?.name ?? 'A bot';
  const from = providerLabel(providers, card.provider);
  const to = providerLabel(providers, card.backup.provider);
  const reset = card.resetsAt ? fmtReset(card.resetsAt, now) : null;
  const expired = card.expiresAt <= now;
  const blocker = expired ? null : continueBlocker(card, { bot, room, providers, limits, now });

  const send = async (decision: 'continue' | 'wait') => {
    setBusy(true);
    setError(null);
    try {
      await api.failover.decide(card.id, decision);
      dropCard(card.id);
    } catch (e) {
      // 409: answered elsewhere, expired, backup changed or limited, bot left. The hub's words say which; the fresh
      // state then drops or keeps the card.
      setError((e as Error).message);
      setBusy(false);
      if (e instanceof ApiError && e.status === 409) void fetchFailover();
    }
  };

  if (expired) {
    // The hub posts its own note and drops the card at its next sweep; until then it reads as settled, not waiting.
    return (
      <ActionCard tone="quiet" role="group" aria-label={name + ': not continued'} className={className ?? 'w-full max-w-[640px]'}>
        <p className="flex items-center gap-2 px-4 py-3 text-ui text-muted">
          <Gauge size={15} aria-hidden className="shrink-0" />
          <span className="min-w-0">Not continued.{reset ? ' ' + from + ' resets at ' + reset + '.' : ''}</span>
        </p>
      </ActionCard>
    );
  }

  return (
    <ActionCard tone="warn-soft" role="group" aria-label={name + ' hit ' + from + "'s " + windowLabel(card.window)} className={className ?? 'w-full max-w-[640px]'}>
      <ActionCardHeader icon={<Gauge size={16} aria-hidden className="mt-0.5 shrink-0 text-warn" />}>
        <span className="min-w-0 flex-1">
          <span className="font-medium">{name} hit {from}'s {windowLabel(card.window)}.</span>
          {reset && <> It resets at {reset}.</>}
        </span>
      </ActionCardHeader>
      <p className="px-4 pt-1 text-ui text-muted">
        {blocker ?? 'Continue runs this request once on ' + to + ' (' + backupModelLabel(providers, card.backup) + '), with approvals on.'}
      </p>
      <ActionCardActions className="pt-3">
        {!blocker && (
          <Button size="sm" variant="primary" className="touch-target" disabled={busy} onClick={() => void send('continue')}>
            Continue on {to}
          </Button>
        )}
        <Button size="sm" className="touch-target" disabled={busy} onClick={() => void send('wait')}>
          {reset ? 'Wait until ' + reset : 'Wait for the reset'}
        </Button>
        {error && <p role="alert" className="basis-full text-hint text-bad">{error}</p>}
      </ActionCardActions>
    </ActionCard>
  );
}

/** Open limit cards for one chat, above the composer. Nothing renders when there are none. */
export function FailoverCardsForRoom({ roomId }: { roomId: string }) {
  const cards = useStore((s) => s.failover.cards);
  const mine = cardsForRoom(cards, roomId);
  if (!mine.length) return null;
  return (
    <div className="mx-auto flex w-full max-w-[var(--page-max)] flex-col gap-2 px-4 pb-2">
      {mine.map((c) => <FailoverCardView key={c.id} card={c} />)}
    </div>
  );
}
