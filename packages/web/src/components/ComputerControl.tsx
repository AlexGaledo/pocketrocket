// P2: Take over / Hand back / Pause for a bot's computer, the takeover card, and the "make this a rule?" offer.
// One accent (the primary action is the ink button), no new motion; every control is a real button or input.
import { useId, useState } from 'react';
import { Hand, MonitorUp, Pause, Play } from 'lucide-react';
import type { ApprovalPayload, Bot, ComputerControl, ControlStatus, Message, TakeoverPayload } from '@pocketrocket/shared';
import { useStore, botById } from '../store';
import { api } from '../lib/api';
import { Badge, Button, Input } from './ui';

const DEFAULT: Omit<ControlStatus, 'botId'> = { control: 'agent', holder: null, since: 0, takeover: null };

/** This browser's id, sent as the control `holder` so the hub can say who took over. Not a secret. */
function deviceId(): string {
  try {
    let id = localStorage.getItem('prcrew.deviceId');
    if (!id) {
      id = 'web-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('prcrew.deviceId', id);
    }
    return id;
  } catch {
    return 'web';
  }
}

export function useControl(botId: string | undefined): ControlStatus {
  const c = useStore((s) => (botId ? s.control[botId] : undefined));
  return c ?? { botId: botId ?? '', ...DEFAULT };
}

/** True when the bot can use a computer at all (Browser or Desktop). */
export const hasComputer = (b: Bot | undefined) => !!b && (b.allowedTools.includes('Browser') || b.allowedTools.includes('Desktop'));

/** PUT the new state; the store follows the `computer.control` event. Errors become a toast. */
function useSetControl(bot: Bot) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const run = async (control: ComputerControl, note?: string) => {
    setBusy(true);
    try {
      const st = await api.control.set(bot.id, control, { holder: deviceId(), ...(note ? { note } : {}) });
      useStore.setState((s) => ({ control: { ...s.control, [bot.id]: st } }));
    } catch (e) {
      toast("Couldn't change who controls " + bot.name + "'s computer: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

const STATE_TEXT: Record<ComputerControl, string> = { agent: 'Bot has control', user: 'You have control', paused: 'Paused' };

/**
 * The control row: Take over / Pause while the bot drives; a hand-back note and Hand back while the user does;
 * Resume while paused. `compact` drops the note field (chat header), where Hand back goes without a note.
 */
export function ControlBar({ bot, compact = false }: { bot: Bot; compact?: boolean }) {
  const c = useControl(bot.id);
  const { busy, run } = useSetControl(bot);
  const [note, setNote] = useState('');
  const noteId = useId();
  const handBack = async () => {
    await run('agent', note.trim() || undefined);
    setNote('');
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label={bot.name + "'s computer control"}>
      {!compact && (
        <Badge tone={c.control === 'agent' ? 'muted' : c.control === 'user' ? 'accent' : 'warn'}>
          <span role="status" aria-live="polite">{STATE_TEXT[c.control]}</span>
        </Badge>
      )}
      {c.control === 'agent' && (
        <>
          <Button size="sm" variant={compact ? 'ghost' : 'primary'} disabled={busy} onClick={() => void run('user')}
            title={'Take over ' + bot.name + "'s computer: its browser and desktop tools stop until you hand it back"}>
            <MonitorUp size={13} /> Take over
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('paused')} title={'Pause ' + bot.name + ': its turns wait until you resume it'}>
            <Pause size={13} /> Pause
          </Button>
        </>
      )}
      {c.control === 'user' && (
        <>
          {!compact && (
            <>
              <label htmlFor={noteId} className="sr-only">Note for {bot.name} (optional)</label>
              <Input id={noteId} className="h-7 min-w-0 flex-1 text-[12px]" placeholder={'Note for ' + bot.name + ' (optional)'} value={note} maxLength={2000}
                onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void handBack(); }} />
            </>
          )}
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void handBack()} title={'Give ' + bot.name + ' its computer back'}>
            <Hand size={13} /> Hand back
          </Button>
        </>
      )}
      {c.control === 'paused' && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void run('agent')} title={'Resume ' + bot.name}>
          <Play size={13} /> Resume
        </Button>
      )}
    </div>
  );
}

/** Chat card for `request_takeover`: what the bot needs, a way to the screen, and the hand-back. */
export function TakeoverCard({ m }: { m: Message }) {
  const p = m.payload as TakeoverPayload;
  const bots = useStore((s) => s.bots);
  const openPanel = useStore((s) => s.openPanel);
  const bot = botById(bots, p.botId);
  const open = p.status === 'waiting' || p.status === 'parked';
  const outcome = p.status === 'done' ? 'Handed back' : p.status === 'expired' ? 'No longer waiting' : p.status === 'parked' ? 'Waiting for you; resumes on hand-back' : 'Waiting for you';
  return (
    <div className="max-w-[640px] overflow-hidden rounded-2xl bg-panel shadow-[var(--shadow-lg)] ring-1 ring-line">
      <div className="flex items-center gap-2 px-4 pt-3 text-[13px]">
        <MonitorUp size={15} className={open ? 'text-accent' : 'text-muted'} />
        <span className="font-medium">{bot ? bot.name : 'A bot'} needs you on its computer</span>
        <span className="ml-auto text-[12px] text-muted">{outcome}</span>
      </div>
      <div className="px-4 py-1.5 text-[13px]">{p.reason}</div>
      {p.note && <div className="px-4 pb-1.5 text-[12.5px] text-muted">Your note: {p.note}</div>}
      {open && bot && (
        <div className="flex flex-col gap-2 px-4 pb-4 pt-1">
          <p className="text-[12px] text-muted">You have control of its screen. Its browser and desktop tools wait until you hand it back.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => openPanel('screen', bot.id)}>Open screen</Button>
            <ControlBar bot={bot} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * After "Allow for this session": offer to keep it as a rule (Settings › Bots lists and revokes them). The
 * pattern starts as the exact command or path; a trailing * widens it to a prefix.
 */
export function RuleOffer({ p, botName }: { p: ApprovalPayload; botName: string }) {
  const toast = useStore((s) => s.toast);
  const [state, setState] = useState<'offer' | 'saving' | 'saved' | 'dismissed'>('offer');
  const initial = suggestPattern(p);
  const [pattern, setPattern] = useState(initial);
  const id = useId();
  if (p.danger || state === 'dismissed') return null;
  if (state === 'saved') return <div className="px-4 pb-3 text-[12px] text-muted">Saved as a rule. Revoke it in Settings › Bots.</div>;
  const save = async () => {
    setState('saving');
    try {
      // Unchanged: let the hub derive the pattern exactly as it matches calls.
      await api.policies.fromApproval(p.approvalId, pattern.trim() !== initial ? pattern.trim() : undefined);
      setState('saved');
    } catch (e) {
      setState('offer');
      toast("Couldn't save the rule: " + (e as Error).message, true);
    }
  };
  return (
    <div className="flex flex-col gap-1.5 border-t border-line px-4 py-3 text-[12.5px]">
      <label htmlFor={id} className="text-muted">Make this a rule? {botName} would never ask again for</label>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={id} className="h-7 min-w-0 flex-1 font-mono text-[11.5px]" value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={500}
          aria-describedby={id + '-hint'} />
        <Button size="sm" variant="primary" disabled={state === 'saving' || !pattern.trim()} onClick={() => void save()}>Make it a rule</Button>
        <Button size="sm" variant="ghost" onClick={() => setState('dismissed')}>Not now</Button>
      </div>
      <span id={id + '-hint'} className="text-[11px] text-dim">{p.toolName}: exact match; end with * to cover everything that starts the same way, or * for any call.</span>
    </div>
  );
}

function suggestPattern(p: ApprovalPayload): string {
  const i = (p.toolInput ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (p.toolName === 'Bash' || p.toolName === 'request_approval') return s(i.command) || s(i.action) || '*';
  for (const k of ['file_path', 'path', 'notebook_path', 'url', 'query']) if (s(i[k])) return s(i[k]);
  return '*';
}
