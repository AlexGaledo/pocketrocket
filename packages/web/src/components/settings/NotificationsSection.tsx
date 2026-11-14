/**
 * Settings › Notifications: desktop notifications for the PocketRocket app (U7). Only listed inside the desktop
 * app; a browser has none and a phone gets Web Push (Devices). Both choices belong to this computer, not the hub,
 * so they live in lib/persist.ts through lib/notifyEvents.ts.
 */
import { useId, useState } from 'react';
import { notificationText, notificationsEnabled, setNotificationText, setNotificationsEnabled } from '../../lib/notifyEvents';
import { Switch } from '../ui';
import { Card, Group, SectionHeader } from './parts';

export function NotificationsSection() {
  const [enabled, setEnabled] = useState(notificationsEnabled);
  const [text, setText] = useState(notificationText);
  const enabledId = useId();
  const enabledHint = useId();
  const textId = useId();
  const textHint = useId();
  return (
    <>
      <SectionHeader title="Notifications" description="Shown only while PocketRocket is in the background." />
      <Group>
        <Card>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div id={enabledId} className="text-label">Desktop notifications</div>
              <p id={enabledHint} className="text-hint text-muted">When a bot needs your approval, needs you on its screen, or finishes.</p>
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
    </>
  );
}
