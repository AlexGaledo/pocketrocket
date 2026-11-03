// The screen, and nothing else. Memory, Skills and Automations are on the Bot page; Usage has its own page.
// lib/screenView.ts decides whose screen and what size. This draws it.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, Maximize2, Minimize2, MonitorPlay, RefreshCw, X } from 'lucide-react';
import type { Bot, ComputerStatus } from '@pocketrocket/shared';
import { useStore, botById, selectActiveRoom } from '../store';
import { api } from '../lib/api';
import { isDesktopMode } from '../lib/auth';
import { computerUse, holdsScreen, selectScreenBotId, selectScreenSize, type ScreenSize } from '../lib/screenView';
import { avatarStatus, useBotStatus } from '../lib/botStatus';
import { Avatar, Button, cn } from './ui';
import { ControlBar, hasComputer, useControl } from './ComputerControl';
import { RecordingBar, useRecorder } from './TeachControls';

export function RightPanel({ inline }: { inline: boolean }) {
  const botId = useStore(selectScreenBotId);
  const size = useStore(selectScreenSize);
  const use = useStore((s) => (botId ? computerUse(botId, s) : null));
  const bot = useStore((s) => botById(s.bots, botId));
  const closePanel = useStore((s) => s.closePanel);
  // Closed for the rest of this bout of use: the thumbnail can sit on text the user is trying to read.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (!use) setDismissed(false); }, [use]);

  if (size === 'glance' && !use) return null;
  if (!bot) {
    return (
      <aside className="panel flex w-full flex-col items-center justify-center gap-3 p-6 text-ui text-muted">
        No bot yet.
        <Button onClick={closePanel}>Close</Button>
      </aside>
    );
  }
  return <ScreenPane bot={bot} size={size} use={use} inline={inline} dismissed={dismissed} onDismiss={() => setDismissed(true)} />;
}

interface PaneProps { bot: Bot; size: ScreenSize; use: string | null; inline: boolean; dismissed: boolean; onDismiss: () => void }

/** Whether this hub has per-bot computers. A hub-wide fact, so it is asked once per page load. */
let perBotHub: boolean | null = null;

function ScreenPane(props: PaneProps) {
  const { bot, size } = props;
  const [perBot, setPerBot] = useState<boolean | null>(perBotHub);
  useEffect(() => {
    if (perBotHub !== null) return;
    let alive = true;
    api.screen(bot.id)
      .then((s) => { perBotHub = !!s.computer?.perBot; if (alive) setPerBot(perBotHub); })
      .catch(() => alive && setPerBot(false));
    return () => { alive = false; };
  }, [bot.id]);
  if (perBot === null) return size === 'glance' ? null : <div className="px-3 py-2 text-hint text-muted">Checking…</div>;
  // Keyed by scope, so one bot's ticket and viewer never carry over to the next bot's screen.
  return <Viewer key={perBot ? bot.id : 'shared'} perBot={perBot} {...props} />;
}

function Viewer({ bot, size, use, inline, dismissed, onDismiss, perBot }: PaneProps & { perBot: boolean }) {
  const toast = useStore((s) => s.toast);
  const room = useStore(selectActiveRoom);
  const rooms = useStore((s) => s.rooms);
  const page = useStore((s) => !!s.page);
  const expanded = useStore((s) => s.panelExpanded);
  const togglePanelExpanded = useStore((s) => s.togglePanelExpanded);
  const closePanel = useStore((s) => s.closePanel);
  const openScreen = useStore((s) => s.openScreen);
  const openPage = useStore((s) => s.openPage);
  const bots = useStore((s) => s.bots);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const { statusOf } = useBotStatus();
  const ctl = useControl(bot.id);
  const recorder = useRecorder(bot.id);
  const scope = perBot ? bot.id : undefined;

  const [info, setInfo] = useState<{ screen: boolean; cdp: boolean; computer?: ComputerStatus } | null>(null);
  const [waking, setWaking] = useState(false);
  const [src, setSrc] = useState('');
  const [nonce, setNonce] = useState(0);
  const c = info?.computer;
  const state = !perBot ? (info === null ? undefined : info.screen ? 'live' : 'off')
    : waking && c?.state === 'asleep' ? 'starting' : c?.state;
  const live = state === 'live' && !!info?.screen;

  const refresh = useCallback(async () => {
    try {
      const s = await api.screen(scope);
      setInfo({ screen: s.screen, cdp: s.cdp, computer: s.computer });
    } catch {
      // Hub unreachable: a shared screen reads as off, a per-bot one keeps its last state.
      if (!scope) setInfo({ screen: false, cdp: false });
    }
  }, [scope]);
  // Poll faster while a start is in flight, so "starting" turns into the live screen promptly.
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, state === 'starting' ? 1500 : 10000);
    return () => clearInterval(id);
  }, [refresh, state]);
  // An iframe cannot send an Authorization header, so the hub token used to ride this URL. Instead each viewer load
  // spends the token on a single-use ticket, which /screen/session trades for an httpOnly cookie scoped to /screen.
  // The token never enters an iframe src or a popup URL. A new ticket when control changes, so the viewer switches
  // between view-only and interactive. Size is not a dependency: changing size must not reload the viewer.
  useEffect(() => {
    if (!live) { setSrc(''); return; }
    let alive = true;
    api.screenTicket(scope).then((t) => alive && setSrc(t.url)).catch(() => alive && setSrc(''));
    return () => { alive = false; };
  }, [live, nonce, scope, ctl.control]);

  const wake = async () => {
    setWaking(true);
    try {
      const s = await api.computers.wake(bot.id);
      if (s.reason && s.state === 'asleep') toast("Couldn't wake " + bot.name + "'s screen: " + s.reason, true);
    } catch (e) {
      toast("Couldn't wake " + bot.name + "'s screen: " + (e as Error).message, true);
    } finally {
      setWaking(false);
      void refresh();
    }
  };
  const popOut = async () => {
    // Ticket first, then open: the desktop app hands new windows to the default browser by URL, so a blank window
    // that is pointed somewhere afterwards never gets anywhere. The click's user activation outlives the round-trip.
    try { window.open((await api.screenTicket(scope)).url, '_blank', 'width=1320,height=880'); } catch { /* hub unreachable */ }
  };

  const glance = size === 'glance';
  const focus = size === 'focus';
  const held = holdsScreen(ctl);
  const recording = recorder?.active ?? null;
  const used = c && c.quotaBytes > 0 ? c.diskBytes / c.quotaBytes : 0;
  const local = !perBot && isDesktopMode();

  const status = held ? 'You have control'
    : ctl.control === 'paused' ? 'Paused'
    : ctl.control === 'user' ? (ctl.holder ? 'Held on another device' : bot.name + ' is waiting for you')
    : state === undefined ? 'Checking…'
    : state === 'starting' ? 'Starting…'
    : state === 'asleep' ? 'Asleep'
    : state === 'off' ? (local ? 'No screen here' : 'Screen is off')
    : !info?.screen ? 'Live, connecting'
    : !info.cdp ? 'Live, browser not responding'
    : use ? bot.name + ' is using its screen' : 'Live';
  const dot = held ? 'bg-accent' : state === 'live' ? 'bg-ok' : state === 'starting' ? 'bg-warn' : state === 'off' && !local ? 'bg-bad' : 'bg-dim';
  const hint = held ? "You're in control. Type secrets on its screen only."
    : ctl.control === 'user' ? 'Take over to click.'
    : live ? 'View only. Take over to click.' : '';

  const followsChat = !room || room.memberIds.includes(bot.id);
  const ownChat = ctl.takeover?.roomId ?? rooms.find((r) => r.kind === 'dm' && r.memberIds[0] === bot.id)?.id;
  const switchable = room?.kind === 'group' && !held ? room.memberIds.map((id) => botById(bots, id)).filter((b): b is Bot => !!b) : [bot];

  return (
    <aside
      aria-label={bot.name + "'s screen"}
      hidden={glance && (dismissed || page || !live)}
      className={cn('@container flex min-w-0 flex-col overflow-hidden', glance
        ? 'fixed right-5 top-[60px] z-20 aspect-[16/10] w-[240px] rounded-lg bg-black shadow-[var(--shadow-overlay)] ring-1 ring-line max-sm:right-3 max-sm:w-[136px]'
        : 'panel w-full')}
    >
      <div hidden={glance} className="flex h-14 shrink-0 items-center gap-2 px-3">
        <div className="flex shrink-0 items-center gap-1">
          {switchable.map((b) => switchable.length === 1
            ? <Avatar key={b.id} bot={b} {...avatarStatus(statusOf(b.id))} size={28} />
            : (
              <button key={b.id} type="button" aria-pressed={b.id === bot.id} aria-label={'Show ' + b.name + "'s screen"} title={b.name} onClick={() => openScreen(b.id)} className={cn('rounded-full', b.id !== bot.id && 'opacity-50 hover:opacity-100', b.id === bot.id && 'ring-2 ring-accent')}>
                <Avatar bot={b} {...avatarStatus(statusOf(b.id))} size={24} />
              </button>
            ))}
        </div>
        <div className="min-w-0 flex-1 text-hint">
          <button type="button" className="block max-w-full truncate rounded-xs text-ui font-medium hover:underline" title={'Open ' + bot.name + "'s page"} onClick={() => openPage({ kind: 'bot', botId: bot.id, tab: 'computer' })}>{bot.name}</button>
          <div className="flex min-w-0 items-center gap-1.5 text-muted">
            <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
            <span className="min-w-0 truncate" role="status" aria-live="polite" title={status}>{status}</span>
          </div>
        </div>
        {perBot && state !== 'live' && !glance && (
          <Button size="sm" onClick={wake} disabled={state === 'starting' || state === undefined}>{state === 'starting' ? 'Waking…' : 'Wake'}</Button>
        )}
        {live && <Button size="icon" variant="ghost" title="Reload viewer" aria-label="Reload viewer" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={14} /></Button>}
        {inline && size === 'watch' && <Button size="icon" variant="ghost" aria-pressed={expanded} aria-label="Expand screen" title={expanded ? 'Restore' : 'Expand'} onClick={togglePanelExpanded}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</Button>}
        {live && <Button size="icon" variant="ghost" title="Pop out" aria-label="Pop out" onClick={popOut}><ExternalLink size={14} /></Button>}
        {size === 'watch' && <Button size="icon" variant="ghost" title="Close screen" aria-label="Close screen" onClick={closePanel}><X size={16} /></Button>}
      </div>

      {!followsChat && !glance && (
        <div role="status" className="mx-3 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-warn/10 px-3 py-1.5 text-hint text-fg">
          <AlertTriangle size={13} aria-hidden className="shrink-0 text-warn" />
          <span className="min-w-0 flex-1 basis-48">This is {bot.name}'s screen. The chat beside it is {room?.name}.</span>
          {ownChat && <Button size="sm" onClick={() => { useStore.getState().closePage(); setActiveRoom(ownChat); }}>Open {bot.name}'s chat</Button>}
        </div>
      )}

      <div className={cn('relative min-h-0 flex-1', !glance && 'mx-3 rounded-lg', live && !glance && 'overflow-hidden bg-black', held && 'ring-2 ring-accent')}>
        {live ? (
          src && <iframe key={nonce} title={bot.name + "'s screen"} src={src} tabIndex={glance ? -1 : undefined} className={cn('block h-full w-full border-0', glance && 'pointer-events-none')} allow="clipboard-read; clipboard-write" />
        ) : !glance && (
          <div className="flex h-full flex-col gap-2 p-1 text-hint text-muted">
            {!perBot ? (
              <>
                <p className="font-medium text-fg">{state === undefined ? 'Checking…' : local ? 'Screen needs a server install.' : 'No screen on this server.'}</p>
                {state !== undefined && (local ? <p>Watch bots use a logged-in browser.</p> : <p>Set it up with <code className="font-mono">bash deploy/setup-vps.sh</code>.</p>)}
              </>
            ) : state === 'starting' ? (
              <p className="font-medium text-fg">Starting. Takes a few seconds.</p>
            ) : state === 'asleep' ? (
              <>
                <p className="font-medium text-fg">{bot.name}'s screen is asleep.</p>
                <p>{hasComputer(bot) ? 'Wakes when needed. Logins are kept.' : 'Not used yet. Wake to log in.'}</p>
              </>
            ) : null}
            {c?.reason && <p className="text-bad">{c.reason}</p>}
            {used >= 0.8 && <p className="text-warn">Disk {Math.round(used * 100)}% full. Won't start at 100%.</p>}
          </div>
        )}
        {glance && (
          <>
            {/* Over the iframe, which would otherwise take the click. The viewer is not interactive at this size. */}
            <button type="button" className="absolute inset-0 flex items-end text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" aria-label={'Watch ' + bot.name + "'s screen. " + (use ?? '')} onClick={() => openScreen(bot.id)}>
              <span className="flex w-full items-center gap-1.5 truncate bg-black/65 px-2 py-1 text-hint text-white">
                <MonitorPlay size={12} aria-hidden className="shrink-0" /><span className="truncate">{use}</span>
              </span>
            </button>
            <button type="button" className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-sm bg-black/65 text-white hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" title="Hide" aria-label="Hide thumbnail" onClick={onDismiss}><X size={13} /></button>
          </>
        )}
      </div>

      {/* Hidden rather than unmounted: a note being typed lives in here. */}
      <div hidden={glance} className="flex shrink-0 flex-col gap-2 px-3 pb-3 pt-2 text-hint text-muted">
        {recording ? <RecordingBar bot={bot} recording={recording} /> : (
          <>
            {ctl.takeover && <p className="text-ui text-fg">{bot.name} asked: {ctl.takeover.reason}</p>}
            {hint && <p>{hint}</p>}
            {(live || ctl.control !== 'agent') && <ControlBar bot={bot} canTake={live} />}
          </>
        )}
      </div>
    </aside>
  );
}
