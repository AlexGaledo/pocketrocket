import { MAX_ATTACHMENTS, SEND_MODES, isAttachmentRef, type SendMode } from '@pocketrocket/shared';
import { getJson, setJson, versionedKey } from './persist';

/**
 * The send journal (B5). Every message the user sends is written here first, so closing the tab, a dropped
 * socket or a hub restart cannot lose it. An entry leaves the journal when the hub's copy of the message comes
 * back (matched by `clientId`, which the hub stores as `clientMsgId`).
 *
 * - `sending`: not delivered yet (offline, or waiting its turn behind an earlier entry).
 * - `sent`:    written to the socket; waiting for the hub to echo the message.
 * - `failed`:  the hub refused it, or never answered. Only the user's Retry moves it on.
 */
export type OutboxStatus = 'sending' | 'sent' | 'failed';
export interface OutboxEntry {
  clientId: string; roomId: string; text: string; status: OutboxStatus; createdAt: number;
  /** Media refs of pictures already uploaded (U2a). The upload happens before the entry exists, so a retry only resends refs. */
  attachments?: string[];
  /** Steering: `queue` (Ctrl+Enter or the send menu) or `join`. Left out, the hub's busyMessages setting decides. Kept so a retry sends the same choice. */
  mode?: SendMode;
}

export const OUTBOX_KEY = versionedKey('outbox', 1);
/** Oldest entries go first if a runaway queue ever grows past this. */
const MAX_ENTRIES = 200;

const STATUSES: readonly string[] = ['sending', 'sent', 'failed'];
const isRefs = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= MAX_ATTACHMENTS && v.every(isAttachmentRef);
function isEntry(v: unknown): v is OutboxEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  const hasPics = e.attachments === undefined || isRefs(e.attachments);
  const modeOk = e.mode === undefined || (SEND_MODES as readonly unknown[]).includes(e.mode);
  return typeof e.clientId === 'string' && e.clientId.length > 0 && e.clientId.length <= 64
    && hasPics && modeOk && typeof e.roomId === 'string' && typeof e.text === 'string' && (e.text.length > 0 || e.attachments !== undefined)
    && typeof e.status === 'string' && STATUSES.includes(e.status) && typeof e.createdAt === 'number';
}

/**
 * What a reloaded page finds. An entry that was `sent` when the page closed may or may not have reached the hub,
 * so it goes out again as `sending`; the hub drops the repeat if it did.
 */
export function readJournal(): OutboxEntry[] {
  const raw = getJson(OUTBOX_KEY, Array.isArray as (v: unknown) => v is unknown[], []);
  return raw.filter(isEntry).map((e) => (e.status === 'sent' ? { ...e, status: 'sending' as const } : e)).sort((a, b) => a.createdAt - b.createdAt);
}

export function writeJournal(entries: readonly OutboxEntry[]): void {
  setJson(OUTBOX_KEY, entries.slice(-MAX_ENTRIES));
}

/** A fresh id for one send. Short enough for the hub's 64-character limit. */
export function newClientId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
}
