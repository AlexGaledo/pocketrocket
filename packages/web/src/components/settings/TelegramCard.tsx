/**
 * Settings › Notifications › Telegram: content-free pings through the owner's own Telegram bot. Token (checked,
 * then masked, shows @yourbot) → link a chat with a short code (same pattern as pairing a phone) → "Notify me
 * here". The cloud warning sits above the switch, always, so nobody can turn it on without it on screen.
 * `TelegramView` is the pure view (rendered by tests); `TelegramCard` wires it to the hub.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { ExternalLink, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { LINK_CODE_MINUTES, maskChatName, safeDeepLink, spokenCode, TelegramController, type TelegramView as View } from '../../lib/telegram';
import { Badge, Button, Switch } from '../ui';
import { QrCode } from '../QrCode';
import { ApiKeyField } from './ApiKeyField';
import { Card, Group, InlineError, Private } from './parts';

export interface TelegramActions {
  onSaveToken: (token: string) => Promise<void>;
  onLink: () => void;
  onUnlink: () => void;
  onNotify: (on: boolean) => void;
  onTest: () => void;
}

const mmss = (ms: number) => Math.floor(ms / 60000) + ':' + String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
const LINK = 'inline-flex items-center gap-1 rounded-xs text-accent underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

function BotFather() {
  return <a className={LINK} href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather<ExternalLink size={11} aria-hidden /></a>;
}

export function TelegramView({ view, actions, now }: { view: View; actions: TelegramActions; now: number }) {
  const s = view.state;
  const warnId = useId();
  const notifyId = useId();
  if (!s) {
    return (
      <Group title="Telegram">
        <Card>{view.error ? <InlineError>{view.error}</InlineError> : <p className="text-ui text-muted" role="status">Loading…</p>}</Card>
      </Group>
    );
  }
  const code = s.pendingCode;
  const left = code ? Math.max(0, code.expiresAt - now) : 0;
  const deepLink = code ? safeDeepLink(code.deepLink) : null;
  return (
    <Group title="Telegram" aside={s.configured && s.botUsername ? <Badge tone="ok">@{s.botUsername}</Badge> : undefined}>
      <Card>
        <p className="text-ui leading-snug text-muted">
          Get a ping on your phone, from your own Telegram bot, when a bot needs you. Messages are a fixed sentence and a link to this hub.
        </p>

        <div className="mt-4">
          <ApiKeyField
            keyName="TELEGRAM_BOT_TOKEN"
            isSet={s.configured}
            label="Bot token"
            description={s.configured && s.botUsername
              ? <>Checked. Your bot is <span className="font-mono">@{s.botUsername}</span>.</>
              : <>Message <BotFather />, send <span className="font-mono">/newbot</span>, and paste the token it gives you.</>}
            placeholder="123456:ABC…"
            saveLabel="Check and save"
            onSave={actions.onSaveToken}
          />
        </div>

        {s.configured && (
          <>
            <div id={warnId} className="mt-4 rounded-md border-l-2 border-warn bg-warn/10 px-3 py-2 text-ui leading-snug text-fg">
              Telegram is a cloud service. Messages here never contain bot, room or tool names or any message text, only a fixed sentence and a link, but Telegram can still see that something happened and when.
            </div>

            {!s.linked && !code && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-[46ch] text-ui leading-snug text-muted">Link your Telegram chat to this bot with a short code.</p>
                <Button variant="primary" onClick={actions.onLink} disabled={view.busy}><Send size={14} aria-hidden /> Link Telegram</Button>
              </div>
            )}

            {!s.linked && code && (
              <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
                {deepLink && <div className="shrink-0 self-center sm:self-start"><QrCode value={deepLink} label="Telegram link QR code" size={168} /></div>}
                <div className="min-w-0 flex-1 text-ui">
                  <div className="text-muted">Open your bot and send it this code</div>
                  <div className="mt-0.5 font-mono text-title font-medium tracking-[0.18em]" aria-label={'Link code ' + spokenCode(code.code)}>{code.code}</div>
                  <div className="mt-1 text-muted">
                    Valid {LINK_CODE_MINUTES} minutes{left > 0 && <span role="timer" aria-live="off"> · {mmss(left)} left</span>}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {deepLink && (
                      <a className="inline-flex h-7 items-center gap-1.5 rounded-md bg-card2 px-2.5 text-ui text-fg hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:hover:brightness-110" href={deepLink} target="_blank" rel="noopener noreferrer">
                        Open in Telegram<ExternalLink size={12} aria-hidden />
                      </a>
                    )}
                    <Button size="sm" onClick={actions.onLink} disabled={view.busy}>New code</Button>
                  </div>
                  <p className="mt-2 text-hint text-muted" role="status">Waiting for your message…</p>
                </div>
              </div>
            )}

            {s.linked && (
              <>
                <div className="mt-4 text-ui">
                  Linked to{' '}
                  {s.linkedName ? <Private value={s.linkedName} display={maskChatName(s.linkedName)} label="Telegram chat name" /> : 'your chat'}
                </div>
                <div className="mt-3 flex items-center justify-between gap-4 border-t border-line pt-3">
                  <div>
                    <div id={notifyId} className="text-label">Notify me here</div>
                    <p className="text-hint text-muted">When a bot needs your approval, needs you on its screen, or finishes.</p>
                  </div>
                  <Switch checked={s.notify} disabled={view.busy} aria-labelledby={notifyId} aria-describedby={warnId} onChange={actions.onNotify} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={actions.onTest} disabled={view.busy}>Send a test</Button>
                  <Button size="sm" variant="danger" onClick={actions.onUnlink} disabled={view.busy}>Unlink</Button>
                </div>
              </>
            )}
          </>
        )}

        <div role="status" className="mt-2 text-hint text-ok empty:hidden">{view.notice}</div>
        {(view.error ?? s.error) && <InlineError>{view.error ?? s.error}</InlineError>}

        <ul className="mt-4 list-disc space-y-1 border-t border-line pl-4 pt-3 text-hint text-muted">
          <li>One hub per bot token: two hubs on the same bot would take each other's messages.</li>
          <li>To kill a token for good, message <BotFather /> and send <span className="font-mono">/revoke</span>.</li>
        </ul>
      </Card>
    </Group>
  );
}

export function TelegramCard() {
  const rev = useStore((s) => s.triggersRev); // bumped by the WS event `integrations.changed`
  const [view, setView] = useState<View>({ state: null, busy: false, error: null, notice: null });
  const [now, setNow] = useState(Date.now());
  const ctl = useMemo(() => {
    const c: TelegramController = new TelegramController(api.telegram, () => setView(c.view));
    return c;
  }, []);
  useEffect(() => { void ctl.load(rev > 0); }, [ctl, rev]);

  // While a code is showing: tick the countdown, poll for the link, and drop the code when it runs out.
  const expiresAt = view.state?.pendingCode?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void ctl.load(true), 3000);
    const gone = setTimeout(() => void ctl.codeExpired(), Math.max(0, expiresAt - Date.now()));
    return () => { clearInterval(tick); clearInterval(poll); clearTimeout(gone); };
  }, [ctl, expiresAt]);

  const actions: TelegramActions = {
    // Throwing keeps the pasted token in the field and shows Telegram's words under it.
    onSaveToken: async (token) => {
      await ctl.saveToken(token);
      const err = ctl.view.error;
      if (err) { ctl.clearError(); throw new Error(err); }
    },
    onLink: () => void ctl.startLink(),
    onUnlink: () => void ctl.unlink(),
    onNotify: (on) => void ctl.setNotify(on),
    onTest: () => void ctl.sendTest(),
  };
  return <TelegramView view={view} actions={actions} now={now} />;
}
