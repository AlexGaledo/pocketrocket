import type {
  Bot, BotInput, Room, RoomInput, Message, Skill, Routine, RoutineRun, RoutineInput, UsageTotals, UsageRow, HealthInfo,
  Settings, SettingsPatch, ProvidersResponse, ProviderId, ProviderCheck, SecretsStatus, AccountState,
} from '@pocketrocket/shared';
import { getToken, reportAuthFailure, clearAuthFailure } from './auth';

/**
 * A non-2xx answer from the hub. `message` is the hub's own `{ error }` text, ready to show the user;
 * `status` lets callers tell "not there yet" (404) or "locked" (409) apart from a plain failure.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  // Sent on every request (GET included) so mutating routes always carry it — the hub rejects
  // mutating routes without a JSON content type.
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) {
    reportAuthFailure();
    const j = await r.json().catch(() => ({}));
    throw new ApiError((j as { error?: string }).error ?? 'Unauthorized', 401);
  }
  clearAuthFailure();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((j as { error?: string }).error ?? r.statusText, r.status);
  return j as T;
}

/** How many messages one transcript page holds. A page shorter than this means the room's start was reached. */
export const MESSAGE_PAGE = 200;

/** GET /api/health also carries the hub's version and active provider, which HealthInfo leaves out. */
export type HealthResponse = HealthInfo & { version?: string; provider?: ProviderId };

/**
 * What the account POSTs answer. The contract only pins GET /api/account to AccountState, so callers
 * treat any other body as "done, go refetch" (see `store.applyAccountResponse`).
 */
export type AccountActionResponse = AccountState | { ok: boolean } | Record<string, unknown>;

export const api = {
  health: () => req<HealthResponse>('GET', '/api/health'),
  screen: () => req<{ screen: boolean; cdp: boolean; url: string }>('GET', '/api/screen'),
  // Spends the hub token on a single-use ticket so the token itself never reaches an iframe URL.
  screenTicket: () => req<{ url: string }>('POST', '/api/screen/ticket'),
  config: () => req<{ workspaceDir: string; version: string }>('GET', '/api/config'),
  // Opens the shared workspace on whichever computer the hub runs on; `where` says which one it was.
  openWorkspace: () => req<{ ok: boolean; where: 'explorer' | 'finder' | 'screen' | 'file-manager'; path: string; error?: string }>('POST', '/api/workspace/open'),
  bots: {
    list: () => req<Bot[]>('GET', '/api/bots'),
    create: (b: BotInput) => req<Bot>('POST', '/api/bots', b),
    update: (id: string, b: Partial<BotInput>) => req<Bot>('PATCH', '/api/bots/' + id, b),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/bots/' + id),
    memory: (id: string) => req<{ text: string }>('GET', '/api/bots/' + id + '/memory'),
    setMemory: (id: string, text: string) => req<{ ok: true }>('PUT', '/api/bots/' + id + '/memory', { text }),
    skills: (id: string) => req<string[]>('GET', '/api/bots/' + id + '/skills'),
    setSkills: (id: string, skillIds: string[]) => req<{ ok: true }>('PUT', '/api/bots/' + id + '/skills', { skillIds }),
    resetSession: (id: string, roomId: string) => req<{ ok: true }>('POST', '/api/bots/' + id + '/reset-session', { roomId }),
  },
  rooms: {
    list: () => req<Room[]>('GET', '/api/rooms'),
    create: (r: RoomInput) => req<Room>('POST', '/api/rooms', r),
    update: (id: string, r: Partial<RoomInput>) => req<Room>('PATCH', '/api/rooms/' + id, r),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/rooms/' + id),
    // `before` is a message seq (exclusive): the hub returns the page of messages just older than it.
    messages: (id: string, before?: number) => req<Message[]>('GET', '/api/rooms/' + id + '/messages?limit=' + MESSAGE_PAGE + (before ? '&before=' + before : '')),
  },
  skills: {
    list: () => req<Skill[]>('GET', '/api/skills'),
    importable: () => req<{ name: string; description: string }[]>('GET', '/api/skills/importable'),
    import: (names: string[]) => req<Skill[]>('POST', '/api/skills/import', { names }),
    create: (name: string, description: string, markdown: string) => req<Skill>('POST', '/api/skills', { name, description, markdown }),
    get: (id: string) => req<Skill & { markdown: string }>('GET', '/api/skills/' + id),
    review: (id: string, reviewStatus: 'approved' | 'pending') => req<Skill>('PATCH', '/api/skills/' + id, { reviewStatus }),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/skills/' + id),
  },
  routines: {
    list: () => req<Routine[]>('GET', '/api/routines'),
    create: (r: RoutineInput) => req<Routine>('POST', '/api/routines', r),
    update: (id: string, r: Partial<RoutineInput>) => req<Routine>('PATCH', '/api/routines/' + id, r),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/routines/' + id),
    run: (id: string) => req<{ ok: boolean }>('POST', '/api/routines/' + id + '/run'),
    runs: (id: string) => req<RoutineRun[]>('GET', '/api/routines/' + id + '/runs'),
  },
  usage: (q: { botId?: string; roomId?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.botId) p.set('botId', q.botId);
    if (q.roomId) p.set('roomId', q.roomId);
    return req<{ totals: UsageTotals; rows: UsageRow[] }>('GET', '/api/usage?' + p.toString());
  },
  settings: {
    get: () => req<Settings>('GET', '/api/settings'),
    update: (patch: SettingsPatch) => req<Settings>('PUT', '/api/settings', patch),
  },
  providers: {
    list: () => req<ProvidersResponse>('GET', '/api/providers'),
    check: (id: ProviderId) => req<ProviderCheck>('POST', '/api/providers/' + id + '/check'),
  },
  secrets: {
    get: () => req<SecretsStatus>('GET', '/api/secrets'),
    update: (patch: Record<string, string>) => req<SecretsStatus>('PUT', '/api/secrets', patch),
  },
  // Optional PocketRocket account. The hub holds the session; the UI only ever sees AccountState.
  account: {
    get: () => req<AccountState>('GET', '/api/account'),
    magicLink: (email: string) => req<AccountActionResponse>('POST', '/api/account/magic-link', { email }),
    verify: (email: string, code: string) => req<AccountActionResponse>('POST', '/api/account/verify', { email, code }),
    cancel: () => req<AccountActionResponse>('POST', '/api/account/cancel', {}),
    signOut: () => req<AccountActionResponse>('POST', '/api/account/sign-out', {}),
    oauth: (provider: 'google' | 'github') => req<{ url: string }>('POST', '/api/account/oauth', { provider }),
  },
};
