// P2: Take over / Hand back / Pause for a bot's screen, the takeover card, and the "make this a rule?" offer.
// One accent (the primary action is the ink button), no new motion; every control is a real button or input.
import { useId, useState } from 'react';
import { Hand, MonitorUp, Pause, Play } from 'lucide-react';
import type { ApprovalPayload, Bot, ComputerControl, ControlStatus, Message, TakeoverPayload } from '@pocketrocket/shared';
import { useStore, botById } from '../store';
import { api } from '../lib/api';
import { deviceId, hasComputer, holdsScreen } from '../lib/screenView';
import { Button, Input, cn } from './ui';

const DEFAULT: Omit<ControlStatus, 'botId'> = { control: 'agent', holder: null, since: 0, takeover: null };

export function useControl(botId: string | undefined): ControlStatus {
  const c = useStore((s) => (botId ? s.control[botId] : undefined));
  return c ?? { botId: botId ?? '', ...DEFAULT };
}

/** True when the bot can use a computer at all (Browser or Desktop). */
export { hasComputer };

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
      toast("Couldn't switch control: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/**
 * The one control bar, on the bot's screen. Take over / Pause while the bot drives; a hand-back note and Hand back
 * while this browser has control; Take over again while control is unclaimed (a bot asked) or held elsewhere;
 * Resume while paused. Handing back is only ever here, so the note can't be skipped by accident.
 */
export function ControlBar({ bot, canTake }: { bot: Bot; canTake: boolean }) {
  const c = useControl(bot.id);
  const { busy, run } = useSetControl(bot);
  const [note, setNote] = useState('');
  const noteId = useId();
  const held = holdsScreen(c);
  const handBack = async () => {
    await run('agent', note.trim() || undefined);
    setNote('');
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-hint" role="group" aria-label={bot.name + "'s screen control"}>
      {c.control === 'agent' && canTake && (
        <>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void run('user')} title="Bot's browser and desktop stop until you return it.">
            <MonitorUp size={13} /> Take over
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('paused')} title="Bot waits until you resume.">
            <Pause size={13} /> Pause
          </Button>
        </>
      )}
      {c.control === 'user' && !held && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void run('user')}>
          <MonitorUp size={13} /> {c.holder ? 'Take here' : 'Take over'}
        </Button>
      )}
      {held && (
        <>
          <label htmlFor={noteId} className="sr-only">Note (never passwords)</label>
          <Input id={noteId} className="h-8 min-w-0 flex-1 basis-40 text-hint" placeholder="Note (never passwords)" value={note} maxLength={2000}
            onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void handBack(); }} />
          <Button variant="primary" disabled={busy} title="Hand back" onClick={() => void handBack()}>
            <Hand size={13} /> Hand back
          </Button>
        </>
      )}
      {c.control === 'paused' && (
        <Button size="sm" variant="primary" disabled={busy} title="Resume" onClick={() => void run('agent')}>
          <Play size={13} /> Resume
        </Button>
      )}
    </div>
  );
}

/** Goes back to the bot as the note a hand-back carries, so a stuck user does not have to fake finishing. */
const CANT_DO = "I can't do this one. Find another way, or tell me what you need from me.";

/**
 * Chat card for `request_takeover`. Take over both claims control and, through that, fills the pane with the
 * screen. The hand-back is on the screen, never here, so this card only says who is driving.
 */
export function TakeoverCard({ m }: { m: Message }) {
  const p = m.payload as TakeoverPayload;
  const bots = useStore((s) => s.bots);
  const bot = botById(bots, p.botId);
  const open = p.status === 'waiting' || p.status === 'parked';
  const outcome = p.status === 'done' ? 'Handed back' : p.status === 'expired' ? 'No longer waiting' : null;
  return (
    <div className={cn('max-w-[640px] overflow-hidden rounded-lg ring-1', open ? 'ring-warn/60' : 'ring-line')}>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1 px-4 pt-3 text-body">
        <span className="min-w-0 flex-1 font-medium">{bot ? bot.name : 'A bot'} {open ? 'needs you' : 'needed you'}: {p.reason}</span>
        {outcome && <span className="pt-0.5 text-hint text-muted">{outcome}</span>}
      </div>
      {p.note && <div className="px-4 pt-1 text-ui text-muted">Your note: {p.note}</div>}
      {open && bot ? <TakeoverActions bot={bot} /> : <div className="h-3" />}
    </div>
  );
}

function TakeoverActions({ bot }: { bot: Bot }) {
  const c = useControl(bot.id);
  const { busy, run } = useSetControl(bot);
  if (holdsScreen(c)) return <p className="px-4 pb-3 pt-1 text-ui text-muted">You have control. Hand back from the screen.</p>;
  const take = () => {
    useStore.setState({ panelBotId: bot.id });
    void run('user');
  };
  return (
    <div className="flex flex-col gap-2.5 px-4 pb-4 pt-1">
      <p className="text-ui text-muted">The bot can't act while you have control. It can read the page after you hand back.</p>
      {c.holder && <p className="text-ui text-muted">Held on another device.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" className="touch-target" disabled={busy} onClick={take}><MonitorUp size={14} aria-hidden /> {c.holder ? 'Take here' : 'Take over'}</Button>
        <Button className="touch-target" disabled={busy} onClick={() => void run('agent', CANT_DO)}>I can't do this</Button>
      </div>
    </div>
  );
}

/** How many identical approvals earn the offer: a one-off should not lead to a standing permission. */
const RULE_OFFER_AFTER = 3;

/** Approved cards for the same bot, tool and subject, across every loaded room. */
function approvedCount(messages: Record<string, Message[]>, botId: string | null, toolName: string, pattern: string): number {
  let n = 0;
  for (const list of Object.values(messages)) {
    for (const m of list) {
      if (m.kind !== 'approval' || m.authorId !== botId) continue;
      const a = m.payload as ApprovalPayload;
      if ((a.status === 'allow' || a.status === 'always') && a.toolName === toolName && suggestPattern(a) === pattern) n++;
    }
  }
  return n;
}

/**
 * After the third identical approval: offer to keep it as a rule (Settings › Bots lists and revokes them). The
 * pattern starts as the exact command or path, and a trailing * widens it to a prefix. There is no offer at all
 * for a call with no narrow pattern, since the only rule it could become is "any call" of that tool.
 */
export function RuleOffer({ p, botId, botName }: { p: ApprovalPayload; botId: string | null; botName: string }) {
  const toast = useStore((s) => s.toast);
  const [state, setState] = useState<'offer' | 'saving' | 'saved' | 'dismissed'>('offer');
  const initial = suggestPattern(p);
  const [pattern, setPattern] = useState(initial ?? '');
  const count = useStore((s) => (initial ? approvedCount(s.messages, botId, p.toolName, initial) : 0));
  const id = useId();
  if (p.danger || !initial || count < RULE_OFFER_AFTER || state === 'dismissed') return null;
  if (state === 'saved') return <div className="px-4 pb-3 text-hint text-muted">Rule saved. Revoke in Settings.</div>;
  const anyCall = pattern.trim() === '*';
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
    <div className="flex flex-col gap-1.5 border-t border-line px-4 py-3 text-ui">
      <label htmlFor={id} className="text-muted">Never ask {botName} again for:</label>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={id} className="h-7 min-w-[160px] flex-1 font-mono text-hint" value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={500}
          aria-describedby={id + '-hint'} />
        <Button size="sm" variant={anyCall ? 'outline' : 'primary'} disabled={state === 'saving' || !pattern.trim()} onClick={() => void save()}>{anyCall ? 'Allow every ' + p.toolName + ' call' : 'Make it a rule'}</Button>
        <Button size="sm" variant="ghost" onClick={() => setState('dismissed')}>Not now</Button>
      </div>
      <span id={id + '-hint'} className="text-hint text-dim">Exact match. End with * to widen; * allows all.</span>
    </div>
  );
}

/** Tools whose subject is one path. Glob and Grep are left out: the hub folds their search pattern into the subject. */
const SINGLE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * The narrow pattern for a card, or null when it has none. Follows the hub's approvalSubject, which answers `*`
 * for every other tool and for an empty subject. Sending no pattern lets the hub derive that same subject, so
 * this must return null wherever the hub would land on `*`. A subject ending in * is also null, because the
 * hub would read it as a prefix match rather than the exact call the user approved.
 */
function suggestPattern(p: ApprovalPayload): string | null {
  const i = (p.toolInput ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const subject = p.toolName === 'Bash' ? s(i.command)
    : p.toolName === 'request_approval' ? s(i.command) || s(i.action)
    : p.toolName === 'WebFetch' ? s(i.url)
    : p.toolName === 'WebSearch' ? s(i.query)
    : SINGLE_PATH_TOOLS.has(p.toolName) ? s(i.file_path) || s(i.path) || s(i.notebook_path)
    : '';
  return subject && !subject.endsWith('*') ? subject : null;
}
