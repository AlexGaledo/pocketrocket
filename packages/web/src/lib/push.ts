/**
 * P9: Web Push on this browser. Opt-in only: nothing here runs until the user flips the switch in
 * Settings › Devices. The hub's pushes are content-free ({"kind":"approval"}); sw.js turns the kind into
 * fixed wording, so no bot output ever passes through Apple's or Google's push service.
 */
import { api } from './api';

export type PushSupport = 'ok' | 'insecure' | 'unsupported' | 'ios-not-installed';

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iOS only offers Web Push to a web app added to the Home Screen.
    return ios && !standalone ? 'ios-not-installed' : 'unsupported';
  }
  return 'ok';
}

/** The service worker (registered at startup in production; registered here in dev). */
export async function swRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Asks for permission, subscribes with the hub's VAPID key and registers the subscription with the hub. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications blocked in browser settings.' : 'Notifications were not allowed.');
  const { publicKey } = await api.push.status();
  const reg = await swRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.push.subscribe(sub.toJSON());
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await api.push.unsubscribe(endpoint).catch(() => undefined);
}
