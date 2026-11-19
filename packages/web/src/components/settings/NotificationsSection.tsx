/**
 * Settings › Notifications, on every client that is not a paired phone. The desktop card (U7) shows only inside the
 * desktop app and its two choices belong to this computer, not the hub, so they live in lib/persist.ts through
 * lib/notifyEvents.ts. A phone gets Web Push from Devices. Telegram pings go through the hub (TelegramCard).
 */
import { useId, useState } from 'react';
import { notificationText, notificationsEnabled, setNotificationText, setNotificationsEnabled } from '../../lib/notifyEvents';
import { canNotify } from '../../lib/notify';
import { Switch } from '../ui';
import { Card, Group, SectionHeader } from './parts';
import { TelegramCard } from './TelegramCard';

export function NotificationsSection() {
  const [enabled, setEnabled] = useState(notificationsEnabled);
  const [text, setText] = useState(notificationText);
  const desktop = canNotify();
  const enabledId = useId();
  const enabledHint = useId();
  const textId = useId();
  const textHint = useId();
  return (
    <>
      <SectionHeader title="Notifications" description="Ways to hear from your bots when you are not looking." />
      <Group title="Phone">
        <Card>
          <p className="text-ui leading-snug text-muted">Phone: Devices › Notifications on this device. Open Settings on the phone itself to turn them on there.</p>
        </Card>
      </Group>
      {desktop && (
        <Group title="Desktop">
          <Card>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div id={enabledId} className="text-label">Desktop notifications</div>
                <p id={enabledHint} className="text-hint text-muted">When a bot needs your approval, needs you on its screen, or finishes. Shown only while PocketRocket is in the background.</p>
              </div>
              <Switch checked={enabled} aria-labelledby={enabledId} aria-describedby={enabledHint} onChange={(next) => { setNotificationsEnabled(next); setEnabled(next); }} />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4 border-t border-line pt-3">
              <div>
                <div id={textId} className="text-label">Include message text</div>
                <p id={textHint} className="text-hint text-muted">Off: a notification only says a bot needs you. The system keeps a history of notifications and shows them on the lock screen, so turn this on only if that is fine.</p>
              </div>
              <Switch checked={text} disabled={!enabled} aria-labelledby={textId} aria-describedby={textHint} onChange={(next) => { setNotificationText(next); setText(next); }} />
            </div>
          </Card>
        </Group>
      )}
      <TelegramCard />
    </>
  );
}
