import type { Bot, BotInput, Room, RoomInput, Message, Skill, Routine, RoutineRun, RoutineInput, UsageTotals, UsageRow, HealthInfo } from '@pocketrocket/shared';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? r.statusText);
  return j as T;
}

export const api = {
  health: () => req<HealthInfo>('GET', '/api/health'),
  screen: () => req<{ screen: boolean; cdp: boolean; url: string }>('GET', '/api/screen'),
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
};
