/**
 * Settings › Devices (P9). On the desktop (hub token): pair a phone with a QR code, see paired devices and
 * revoke them. On a paired phone: "This device" and Unpair only — the hub refuses everything else a device
 * may not do. Either way: opt-in, content-free push notifications for this browser.
 *
 * The QR code holds the hub's address and a one-time pairing code (five minutes, single use). It never holds
 * the hub token.
 */
import { useCallback, useEffect, useState } from 'react';
import { BellRing, RefreshCw, Smartphone } from 'lucide-react';
import { useStore } from '../../store';
import { api, type DeviceInfo, type PairingCode } from '../../lib/api';
import { isDevice } from '../../lib/auth';
import { currentSubscription, disablePush, enablePush, pushSupport } from '../../lib/push';
import { Badge, Button, Field, Input, Label, Select, Switch } from '../ui';
import { QrCode } from '../QrCode';
import { Card, Group, InlineError, SectionHeader } from './parts';

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 36) return h + ' h ago';
  return new Date(ts).toLocaleDateString();
}
const fmtCode = (c: string) => c.slice(0, 4) + '-' + c.slice(4);

export function DevicesSection() {
  const device = isDevice();
  return (
    <>
      <SectionHeader
        title="Devices"
        description={device ? 'This browser is paired with the hub as a device.' : 'Pair your phone to chat, answer approvals and watch the Screen from anywhere on your tailnet.'}
      />
      {device ? <ThisDevice /> : <PairAndList />}
      <PushGroup />
    </>
  );
}

// ---------- desktop: pair + list ----------

function PairAndList() {
  const toast = useStore((s) => s.toast);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.devices.list().then((r) => { setDevices(r.devices); setError(null); }, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      <PairPhone onPaired={load} />
      <Group title="Paired devices" aside={<Button size="sm" variant="ghost" onClick={load}><RefreshCw size={13} aria-hidden /> Refresh</Button>}>
        <Card className="py-2">
          {error && <InlineError>{error}</InlineError>}
          {devices && devices.length === 0 && <p className="py-2 text-[12.5px] text-muted">No devices yet.</p>}
          <ul className="divide-y divide-line">
            {devices?.map((d) => (
              <DeviceRow
                key={d.id}
                d={d}
                onRevoked={() => { toast(d.name + ' unpaired'); load(); }}
                onError={(m) => toast(m, true)}
              />
            ))}
          </ul>
        </Card>
      </Group>
    </>
  );
}

function DeviceRow({ d, onRevoked, onError }: { d: DeviceInfo; onRevoked: () => void; onError: (m: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    setBusy(true);
    try {
      await api.devices.revoke(d.id);
      onRevoked();
    } catch (e) {
      onError("Couldn't unpair: " + (e as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <Smartphone size={16} aria-hidden className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <span className="truncate">{d.name}</span>
          {d.revoked && <Badge tone="bad">Revoked</Badge>}
        </div>
        <div className="text-[12px] text-muted">
          Paired {new Date(d.createdAt).toLocaleDateString()} · last seen {ago(d.lastSeenAt)}
        </div>
      </div>
      {!d.revoked && (confirming ? (
        <div className="flex items-center gap-1.5" role="group" aria-label={'Unpair ' + d.name + '?'}>
          <span className="text-[12px] text-muted">Unpair now?</span>
          <Button size="sm" variant="danger" onClick={() => void revoke()} disabled={busy} autoFocus>Unpair</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
        </div>
      ) : (
        <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>Revoke</Button>
      ))}
    </li>
  );
}

function PairPhone({ onPaired }: { onPaired: () => void }) {
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [host, setHost] = useState('');
  const [manualUrl, setManualUrl] = useState(() => (typeof location === 'undefined' ? '' : location.origin));
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.devices.pairing();
      setPairing(p);
      setHost((h) => (h && p.hosts.includes(h) ? h : p.hosts[0] ?? ''));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const left = pairing ? Math.max(0, pairing.expiresAt - now) : 0;
  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairing]);
  // A code that ran out is useless: drop it, and refresh the list in case the phone paired with it.
  useEffect(() => {
    if (pairing && left === 0) { setPairing(null); onPaired(); }
  }, [pairing, left, onPaired]);

  const base = pairing?.hosts.length ? 'https://' + host : manualUrl.trim().replace(/\/+$/, '');
  const validBase = /^https?:\/\/[^\s/#?]+(:\d+)?$/i.test(base);
  // The fragment never reaches a server or its logs; the phone strips it the moment the page loads.
  const url = pairing && validBase ? base + '/#pair=' + pairing.code : '';
  const mmss = Math.floor(left / 60000) + ':' + String(Math.floor((left % 60000) / 1000)).padStart(2, '0');

  return (
    <Group title="Pair a phone">
      <Card>
        {!pairing ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-[46ch] text-[12.5px] leading-snug text-muted">
              Shows a QR code with this hub's address and a one-time code that works for five minutes. Scan it with the phone's camera.
            </p>
            <Button variant="primary" onClick={() => void mint()} disabled={busy}><Smartphone size={14} aria-hidden /> Pair a phone</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="shrink-0 self-center sm:self-start">
              {url ? <QrCode value={url} label="Pairing QR code" /> : (
                <div className="flex size-[208px] items-center justify-center rounded-xl bg-card2 p-4 text-center text-[12px] text-muted">Enter the address the phone uses to reach the hub</div>
              )}
            </div>
            <div className="min-w-0 flex-1 text-[12.5px]">
              <div className="text-muted">Or type this code on the phone</div>
              <div className="mt-0.5 font-mono text-[22px] font-medium tracking-[0.12em]" aria-label={'Pairing code ' + pairing.code.split('').join(' ')}>{fmtCode(pairing.code)}</div>
              <div className="mt-1 text-muted" role="timer" aria-live="off">Expires in {mmss}</div>

              {pairing.hosts.length > 1 && (
                <Field className="mt-3">
                  <Label>Address</Label>
                  <Select value={host} onChange={(e) => setHost(e.target.value)}>
                    {pairing.hosts.map((h) => <option key={h} value={h}>https://{h}</option>)}
                  </Select>
                </Field>
              )}
              {pairing.hosts.length === 0 && (
                <Field className="mt-3">
                  <Label hint="where the phone reaches this hub">Hub address</Label>
                  <Input value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} placeholder="https://myhub.tail1234.ts.net" spellCheck={false} autoComplete="off" className="font-mono text-[12.5px]" />
                  <p className="mt-1.5 leading-snug text-muted">
                    No tailnet name is set on this hub. Put it behind Tailscale Serve and set <code className="font-mono text-[11.5px]">POCKETROCKET_ALLOWED_HOSTS</code> to
                    its name (see docs/SERVER.md). The phone can only reach a hub on 127.0.0.1 through that.
                  </p>
                </Field>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void mint()} disabled={busy}><RefreshCw size={13} aria-hidden /> New code</Button>
                <Button size="sm" variant="ghost" onClick={() => { setPairing(null); onPaired(); }}>Done</Button>
              </div>
            </div>
          </div>
        )}
        {error && <InlineError>{error}</InlineError>}
      </Card>
    </Group>
  );
}

// ---------- phone: this device ----------

function ThisDevice() {
  const [me, setMe] = useState<DeviceInfo | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    api.devices.list().then((r) => setMe(r.devices.find((d) => d.id === r.current) ?? null), () => undefined);
  }, []);
  const unpair = async () => {
    if (!me) return;
    await disablePush().catch(() => undefined);
    // The hub revokes the token, and the next request it refuses clears it here and asks to pair again.
    await api.devices.revoke(me.id).catch(() => undefined);
    location.reload();
  };
  return (
    <Group title="This device">
      <Card className="flex flex-wrap items-center gap-3">
        <Smartphone size={16} aria-hidden className="text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{me?.name ?? 'Paired device'}</div>
          {me && <div className="text-[12px] text-muted">Paired {new Date(me.createdAt).toLocaleDateString()}</div>}
        </div>
        {confirming ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="danger" onClick={() => void unpair()} autoFocus>Unpair</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)} disabled={!me}>Unpair this device</Button>
        )}
      </Card>
      <p className="mt-2 text-[12px] leading-snug text-muted">
        From a paired device you can chat, answer approval cards (once at a time), watch a Screen and run routines. Settings, keys,
        integrations and "always allow" stay on the desktop app.
      </p>
    </Group>
  );
}

// ---------- push (both) ----------

function PushGroup() {
  const support = pushSupport();
  const toast = useStore((s) => s.toast);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void currentSubscription().then((s) => setOn(!!s), () => undefined);
  }, []);

  const toggle = async (next: boolean) => {
    if (support !== 'ok' || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (next) await enablePush();
      else await disablePush();
      setOn(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      const r = await api.push.test();
      toast(r.sent ? 'Test notification sent' : "The push service didn't accept the test", !r.sent);
    } catch (e) {
      toast("Couldn't send a test: " + (e as Error).message, true);
    }
  };

  const why = support === 'insecure' ? 'Notifications need HTTPS (Tailscale Serve) or localhost.'
    : support === 'ios-not-installed' ? 'On iPhone, add PocketRocket Crew to the Home Screen first (Share › Add to Home Screen), then open it from there.'
    : support === 'unsupported' ? "This browser doesn't support push notifications." : null;

  return (
    <Group title="Notifications">
      <Card>
        <div className="flex items-start gap-3">
          <BellRing size={16} aria-hidden className="mt-0.5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <div id="push-label" className="text-[13px] font-medium">Notifications on this device</div>
            <p id="push-desc" className="mt-0.5 text-[12.5px] leading-snug text-muted">
              Off unless you turn it on. Pushes say only "A bot needs your approval" or "Routine finished" — never what the bot said
              or did. They pass through your browser maker's push service.
            </p>
          </div>
          <Switch checked={on} onChange={(v) => void toggle(v)} aria-labelledby="push-label" aria-describedby="push-desc" className={support !== 'ok' || busy ? 'pointer-events-none opacity-40' : undefined} />
        </div>
        {why && <p className="mt-2 text-[12px] text-muted">{why}</p>}
        {on && (
          <div className="mt-3">
            <Button size="sm" onClick={() => void test()}>Send a test</Button>
          </div>
        )}
        {error && <InlineError>{error}</InlineError>}
      </Card>
    </Group>
  );
}
