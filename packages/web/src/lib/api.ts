import type {
  Bot, BotInput, Room, RoomInput, Message, Skill, Routine, RoutineRun, RoutineInput, UsageTotals, UsageRow, HealthInfo,
  Settings, SettingsPatch, ProvidersResponse, ProviderId, ProviderCheck, SecretsStatus,
} from '@pocketrocket/shared';
import { getToken, reportAuthFailure, clearAuthFailure } from './auth';

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
    throw new Error((j as { error?: string }).error ?? 'Unauthorized');
  }
  clearAuthFailure();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? r.statusText);
  return j as T;
}

export const api = {
  health: () => req<HealthInfo>('GET', '/api/health'),
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
    messages: (id: string, before?: number) => req<Message[]>('GET', '/api/rooms/' + id + '/messages?limit=200' + (before ? '&before=' + before : '')),
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
};
