// The screen, and nothing else. Memory, Skills and Automations are on the Bot page; Usage has its own page.
// lib/screenView.ts decides whose screen and what size. This draws it.
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
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

/** How long a hidden window keeps its viewer connected. */
const HIDDEN_DROP_MS = 5 * 60_000;

/**
 * noVNC's own side menu slides out over the screen on hover, and its banner says "unencrypted" about the last hop
 * on this machine. Both go in the embedded viewer, where the app has its own controls. Pop-out keeps them, since it
 * has no app around it (and it is where the clipboard and extra keys panels stay reachable). Same origin, as the hub
 * proxies noVNC and sends X-Frame-Options: SAMEORIGIN.
 */
const VNC_EMBED_CSS = '#noVNC_control_bar_anchor,#noVNC_status,#noVNC_hint_anchor{display:none!important}';
function hideVncChrome(e: SyntheticEvent<HTMLIFrameElement>) {
  try {
    const doc = e.currentTarget.contentDocument;
    if (!doc?.head || doc.getElementById('pr-embed')) return;
    const style = doc.createElement('style');
    style.id = 'pr-embed';
    style.textContent = VNC_EMBED_CSS;
    doc.head.append(style);
  } catch { /* not the viewer: nothing to hide */ }
}

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
  // A hidden window lets go of the viewer after a while, or a forgotten tab holds a computer's place for good.
  const [hiddenLong, setHiddenLong] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(t);
      if (document.visibilityState === 'hidden') t = setTimeout(() => setHiddenLong(true), HIDDEN_DROP_MS);
      else setHiddenLong(false);
    };
    document.addEventListener('visibilitychange', onChange);
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', onChange); };
  }, []);
  const [src, setSrc] = useState('');
  const [nonce, setNonce] = useState(0);
  const [wakeError, setWakeError] = useState('');
  const c = info?.computer;
  const state = !perBot ? (info === null ? undefined : info.screen ? 'live' : 'off')
    : waking && c?.state === 'asleep' ? 'starting' : c?.state;
  const live = state === 'live' && !!info?.screen;
  const failure = c?.reason || wakeError;
  const viewerUp = live && !(hiddenLong && !holdsScreen(ctl));

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
  const pushed = useStore((s) => s.computers[bot.id]);
  useEffect(() => { if (pushed) void refresh(); }, [pushed, refresh]);
  // An iframe cannot send an Authorization header, so the hub token used to ride this URL. Instead each viewer load
  // spends the token on a single-use ticket, which /screen/session trades for an httpOnly cookie scoped to /screen.
  // The token never enters an iframe src or a popup URL. A new ticket when control changes, so the viewer switches
  // between view-only and interactive. Size is not a dependency: changing size must not reload the viewer.
  useEffect(() => {
    if (!viewerUp) { setSrc(''); return; }
    let alive = true;
    api.screenTicket(scope).then((t) => alive && setSrc(t.url)).catch(() => alive && setSrc(''));
    return () => { alive = false; };
  }, [viewerUp, nonce, scope, ctl.control]);

  const wake = useCallback(async (auto: boolean) => {
    setWaking(true);
    setWakeError('');
    try {
      await api.computers.wake(bot.id, auto ? { auto } : {});
    } catch (e) {
      setWakeError((e as Error).message);
    } finally {
      setWaking(false);
      void refresh();
    }
  }, [bot.id, refresh]);
  // Looking at a screen starts it. A failed start stays down with its reason and a Retry; it is not retried here.
  const usable = perBot && hasComputer(bot);
  const watching = size !== 'glance';
  const asked = useRef(false);
  useEffect(() => { asked.current = false; setWakeError(''); }, [bot.id]);
  useEffect(() => {
    if (c?.state !== 'asleep') { asked.current = false; return; }
    if (!usable || !watching || failure || asked.current || document.visibilityState !== 'visible') return;
    asked.current = true;
    void wake(true);
  }, [c?.state, usable, watching, failure, wake]);
  const popOut = async () => {
    // Ticket first, then open: the desktop app hands new windows to the default browser by URL, so a blank window
    // that is pointed somewhere afterwards never gets anywhere. The click's user activation outlives the round-trip.
    try { window.open((await api.screenTicket(scope)).url, '_blank', 'width=1320,height=880'); } catch { /* hub unreachable */ }
  };

  const glance = size === 'glance';
  const held = holdsScreen(ctl);
  const recording = recorder?.active ?? null;
  const used = c && c.quotaBytes > 0 ? c.diskBytes / c.quotaBytes : 0;
  const local = !perBot && isDesktopMode();

  const status = held ? 'You have control'
    : ctl.control === 'paused' ? 'Paused'
    : ctl.control === 'user' ? (ctl.holder ? 'Held on another device' : bot.name + ' is waiting for you')
    : state === undefined ? 'Checking…'
    : state === 'starting' ? 'Starting…'
    : state === 'asleep' ? (!hasComputer(bot) ? 'No screen' : failure ? "Didn't start" : 'Starting…')
    : state === 'off' ? (local ? 'No screen here' : 'Screen is off')
    : !info?.screen ? 'Connecting…'
    : !info.cdp ? 'Browser not responding'
    : use ? bot.name + ' is using its screen' : 'Ready';
  const dot = held ? 'bg-accent' : state === 'live' ? 'bg-ok' : state === 'starting' ? 'bg-warn' : (state === 'off' && !local) || (state === 'asleep' && failure) ? 'bg-bad' : 'bg-dim';
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
          src && <iframe key={nonce} title={bot.name + "'s screen"} src={src} onLoad={hideVncChrome} tabIndex={glance ? -1 : undefined} className={cn('block h-full w-full border-0', glance && 'pointer-events-none')} allow="clipboard-read; clipboard-write" />
        ) : !glance && (
          <div className="flex h-full flex-col gap-2 p-1 text-hint text-muted">
            {!perBot ? (
              <>
                <p className="font-medium text-fg">{state === undefined ? 'Checking…' : local ? 'Screen needs a server install.' : 'No screen on this server.'}</p>
                {state !== undefined && (local ? <p>Watch bots use a logged-in browser.</p> : <p>Per-bot computers are off, so Browser and Desktop are refused.</p>)}
              </>
            ) : state === 'starting' ? (
              <p className="font-medium text-fg">Starting. Can take up to 25 seconds.</p>
            ) : state === 'asleep' && !hasComputer(bot) ? (
              <p className="font-medium text-fg">{bot.name} has no Browser or Desktop, so it has no screen.</p>
            ) : state === 'asleep' && failure ? (
              <>
                <p className="font-medium text-fg">{bot.name}'s screen didn't start.</p>
                <p className="text-bad">{failure}</p>
                <div><Button size="sm" onClick={() => void wake(false)} disabled={waking}>{waking ? 'Trying…' : 'Try again'}</Button></div>
              </>
            ) : state === 'asleep' ? (
              <p className="font-medium text-fg">Starting. Can take up to 25 seconds.</p>
            ) : null}
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
