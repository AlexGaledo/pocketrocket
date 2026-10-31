import type { Db } from './db.js';

/** A paired device as the UI sees it. Never carries the token or its hash. */
export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
}

export interface PushSubscriptionRow {
  id: string;
  deviceId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
}

const toDevice = (r: Record<string, unknown>): DeviceInfo => ({
  id: r.id as string,
  name: r.name as string,
  createdAt: r.created_at as number,
  lastSeenAt: (r.last_seen_at as number | null) ?? null,
  revoked: !!r.revoked,
});
const toSub = (r: Record<string, unknown>): PushSubscriptionRow => ({
  id: r.id as string,
  deviceId: (r.device_id as string | null) ?? null,
  endpoint: r.endpoint as string,
  p256dh: r.p256dh as string,
  auth: r.auth as string,
  createdAt: r.created_at as number,
});

/** P9: `devices` and `push_subscriptions` (migrations 90–91). */
export class DevicesRepo {
  constructor(private db: Db) {}

  create(d: { id: string; name: string; tokenHash: string; now: number }): DeviceInfo {
    this.db.run('INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, revoked) VALUES (?, ?, ?, ?, ?, 0)', d.id, d.name, d.tokenHash, d.now, d.now);
    return this.get(d.id)!;
  }
  get(id: string): DeviceInfo | undefined {
    const r = this.db.get('SELECT * FROM devices WHERE id = ?', id);
    return r ? toDevice(r) : undefined;
  }
  list(): DeviceInfo[] {
    return this.db.all('SELECT * FROM devices ORDER BY revoked ASC, created_at DESC').map(toDevice);
  }
  /** id + hash of every device that may still sign in. Read on every request, so a revoke bites at once. */
  activeHashes(): { id: string; tokenHash: string }[] {
    return this.db.all<{ id: string; token_hash: string }>('SELECT id, token_hash FROM devices WHERE revoked = 0').map((r) => ({ id: r.id, tokenHash: r.token_hash }));
  }
  rename(id: string, name: string): DeviceInfo | undefined {
    this.db.run('UPDATE devices SET name = ? WHERE id = ?', name, id);
    return this.get(id);
  }
  touch(id: string, now: number): void {
    this.db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now, id);
  }
  /** Marks the device revoked and drops its push subscriptions in one go. False when there was no live device. */
  revoke(id: string): boolean {
    return this.db.tx(() => {
      const r = this.db.run('UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0', id);
      this.db.run('DELETE FROM push_subscriptions WHERE device_id = ?', id);
      return Number(r.changes) > 0;
    });
  }

  // ---- push subscriptions. device_id NULL = the hub-token holder (the desktop app / a browser on the PC).
  upsertSubscription(s: { id: string; deviceId: string | null; endpoint: string; p256dh: string; auth: string; now: number }): void {
    this.db.run(
      'INSERT INTO push_subscriptions (id, device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth',
      s.id, s.deviceId, s.endpoint, s.p256dh, s.auth, s.now,
    );
  }
  subscriptions(deviceId?: string | null): PushSubscriptionRow[] {
    if (deviceId === undefined) return this.db.all('SELECT * FROM push_subscriptions ORDER BY created_at').map(toSub);
    if (deviceId === null) return this.db.all('SELECT * FROM push_subscriptions WHERE device_id IS NULL ORDER BY created_at').map(toSub);
    return this.db.all('SELECT * FROM push_subscriptions WHERE device_id = ? ORDER BY created_at', deviceId).map(toSub);
  }
  /** Removes one endpoint; `deviceId` (when given) must own it, so a phone cannot unsubscribe another. */
  deleteSubscription(endpoint: string, owner?: { deviceId: string | null }): boolean {
    if (!owner) return Number(this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint).changes) > 0;
    if (owner.deviceId === null) return Number(this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id IS NULL', endpoint).changes) > 0;
    return Number(this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id = ?', endpoint, owner.deviceId).changes) > 0;
  }
}
