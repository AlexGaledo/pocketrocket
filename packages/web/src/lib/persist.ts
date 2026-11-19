/**
 * The one place the web app touches `localStorage` / `sessionStorage`.
 *
 * Storage can be missing or throw (a blocked-cookies browser, a sandboxed iframe, a full quota, private mode),
 * so every read and write is guarded here and callers never write their own try/catch. When a write fails the
 * value is kept in memory, so the page still behaves for the rest of the session; when a read fails the answer
 * is `null`/the fallback.
 *
 * Existing keys keep their exact names and stored formats: this module only wraps access. New keys made with
 * {@link versionedKey} carry a version, so a later change of shape can read the old one or ignore it.
 */
export type Area = 'local' | 'session';

/** Values that could not be written (or removed), so reads keep returning what the page last set. */
const shadow: Record<Area, Map<string, string | null>> = { local: new Map(), session: new Map() };

function store(area: Area): Storage | null {
  try {
    return (area === 'local' ? globalThis.localStorage : globalThis.sessionStorage) ?? null;
  } catch {
    return null; // even touching the property can throw
  }
}

/** `pocketrocket.<name>.v<version>`, for keys created from now on. */
export function versionedKey(name: string, version: number): string {
  return 'pocketrocket.' + name + '.v' + version;
}

export function getItem(key: string, area: Area = 'local'): string | null {
  const held = shadow[area];
  if (held.has(key)) return held.get(key) ?? null;
  try {
    return store(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when the value only lives in memory. */
export function setItem(key: string, value: string, area: Area = 'local'): boolean {
  try {
    const s = store(area);
    if (!s) throw new Error('no storage');
    s.setItem(key, value);
    shadow[area].delete(key);
    return true;
  } catch {
    shadow[area].set(key, value);
    return false;
  }
}

export function removeItem(key: string, area: Area = 'local'): void {
  try {
    const s = store(area);
    if (!s) throw new Error('no storage');
    s.removeItem(key);
    shadow[area].delete(key);
  } catch {
    shadow[area].set(key, null);
  }
}

/** The stored JSON when it parses and `ok` accepts it; otherwise `fallback` (empty, blocked, junk or wrong shape). */
export function getJson<T>(key: string, ok: (v: unknown) => v is T, fallback: T, area: Area = 'local'): T {
  const raw = getItem(key, area);
  if (raw === null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown, area: Area = 'local'): boolean {
  try {
    return setItem(key, JSON.stringify(value), area);
  } catch {
    return false; // not serialisable: nothing to keep
  }
}

/** Test helper: forget what could not be written. */
export function resetPersistMemory(): void {
  shadow.local.clear();
  shadow.session.clear();
}
