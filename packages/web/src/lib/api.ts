import type {
  Bot, BotInput, Room, RoomInput, Message, Skill, Routine, RoutineRun, RoutineInput, UsageTotals, UsageRow, HealthInfo,
  Settings, SettingsPatch, ProvidersResponse, ProviderId, ProviderCheck, SecretsStatus, AccountState, UsageGroup,
  ComputerStatus,
  IntegrationsState, IntegrationInfo, IntegrationProvider, OAuthAppInput, OAuthAppStatus, PendingConnect, TokenConnectInput,
} from '@pocketrocket/shared';
import type { KnowledgeStatus, SkillGitImportResult, VoiceProposal } from '@pocketrocket/shared';
import type { Trigger, TriggerFire, TriggerInput, TriggersState, TriggerTestInput } from '@pocketrocket/shared';
import type { ApprovalPolicy, ComputerControl, ControlStatus } from '@pocketrocket/shared';
import type { RecorderStatus, RecordingInfo, SkillReflectionConfig, SkillVersion, SkillVersionDetail } from '@pocketrocket/shared';
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
  // P1: with a botId, that bot's own computer (`computer` says whether this hub has per-bot computers at all).
  screen: (botId?: string) =>
    req<{ screen: boolean; cdp: boolean; url: string; computer?: ComputerStatus }>('GET', '/api/screen' + (botId ? '?botId=' + encodeURIComponent(botId) : '')),
  // Spends the hub token on a single-use ticket so the token itself never reaches an iframe URL. With a botId
  // the ticket opens that bot's screen only.
  screenTicket: (botId?: string) => req<{ url: string }>('POST', '/api/screen/ticket', botId ? { botId } : undefined),
  computers: {
    get: (botId: string) => req<ComputerStatus>('GET', '/api/computers/' + encodeURIComponent(botId)),
    wake: (botId: string) => req<ComputerStatus>('POST', '/api/computers/' + encodeURIComponent(botId) + '/wake', {}),
    keepAwake: (botId: string, on: boolean) => req<ComputerStatus>('PUT', '/api/computers/' + encodeURIComponent(botId) + '/keep-awake', { on }),
  },
  config: () => req<{ workspaceDir: string; version: string }>('GET', '/api/config'),
  // Opens the shared workspace on whichever computer the hub runs on; `where` says which one it was. On a hub
  // with per-bot computers it opens on `botId`'s computer (P1), or `error` says to open its Screen first.
  openWorkspace: (botId?: string | null) =>
    req<{ ok: boolean; where: 'explorer' | 'finder' | 'screen' | 'file-manager'; path: string; error?: string }>('POST', '/api/workspace/open', botId ? { botId } : {}),
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
    // byModel / byCause arrive from P8 hubs; an older hub leaves them out.
    return req<{ totals: UsageTotals; rows: UsageRow[]; byModel?: UsageGroup[]; byCause?: UsageGroup[] }>('GET', '/api/usage?' + p.toString());
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
  // ---- P7: knowledge repo, voice, notes, skill import from git ----
  knowledge: {
    status: () => req<KnowledgeStatus>('GET', '/api/knowledge'),
    sync: () => req<KnowledgeStatus>('POST', '/api/knowledge/sync', {}),
  },
  voice: {
    get: (botId: string) => req<{ text: string; proposals: VoiceProposal[] }>('GET', '/api/bots/' + botId + '/voice'),
    set: (botId: string, text: string) => req<{ ok: true; trimmed: boolean }>('PUT', '/api/bots/' + botId + '/voice', { text }),
    decide: (botId: string, id: string, decision: 'approve' | 'dismiss') =>
      req<{ text: string; proposals: VoiceProposal[] }>('POST', '/api/bots/' + botId + '/voice/proposals/' + id, { decision }),
  },
  notes: (botId: string) => req<{ name: string; bytes: number; mtime: number }[]>('GET', '/api/bots/' + botId + '/notes'),
  importSkillsFromGit: (url: string) => req<SkillGitImportResult>('POST', '/api/skills/import-git', { url }),
  // P4: integrations. The hub keeps every credential; these answers never carry one.
  integrations: {
    get: () => req<IntegrationsState>('GET', '/api/integrations'),
    setApp: (p: IntegrationProvider, app: OAuthAppInput) => req<OAuthAppStatus>('PUT', '/api/integrations/apps/' + p, app),
    removeApp: (p: IntegrationProvider) => req<OAuthAppStatus>('DELETE', '/api/integrations/apps/' + p),
    // Not under /api: the hub mints state + PKCE and answers the provider's authorize URL.
    startOAuth: (p: IntegrationProvider) => req<{ url: string; redirectUri: string }>('POST', '/oauth/start/' + p, {}),
    startDevice: (p: IntegrationProvider) => req<PendingConnect>('POST', '/api/integrations/device/' + p, {}),
    cancel: (p: IntegrationProvider) => req<{ ok: true }>('POST', '/api/integrations/cancel/' + p, {}),
    connectToken: (p: IntegrationProvider, body: TokenConnectInput) => req<IntegrationInfo>('POST', '/api/integrations/token/' + p, body),
    test: (id: string) => req<IntegrationInfo>('POST', '/api/integrations/' + id + '/test', {}),
    setGrants: (id: string, botIds: string[]) => req<IntegrationInfo>('PUT', '/api/integrations/' + id + '/grants', { botIds }),
    disconnect: (id: string) => req<{ ok: true }>('DELETE', '/api/integrations/' + id),
  },
  // P5: event triggers.
  triggers: {
    get: () => req<TriggersState>('GET', '/api/triggers'),
    create: (t: TriggerInput) => req<Trigger>('POST', '/api/triggers', t),
    update: (id: string, t: Partial<TriggerInput>) => req<Trigger>('PATCH', '/api/triggers/' + id, t),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/triggers/' + id),
    fires: (id: string) => req<TriggerFire[]>('GET', '/api/triggers/' + id + '/fires'),
    test: (id: string, body: TriggerTestInput = {}) => req<TriggerFire>('POST', '/api/triggers/' + id + '/test', body),
  },
  // ---- P9: paired devices and opt-in Web Push ----
  devices: {
    list: () => req<{ devices: DeviceInfo[]; current: string | null }>('GET', '/api/devices'),
    // Hub token only. The answer carries a one-time code, never the hub token.
    pairing: () => req<PairingCode>('POST', '/api/devices/pairing', {}),
    rename: (id: string, name: string) => req<DeviceInfo>('PATCH', '/api/devices/' + encodeURIComponent(id), { name }),
    revoke: (id: string) => req<{ ok: true }>('DELETE', '/api/devices/' + encodeURIComponent(id)),
  },
  push: {
    status: () => req<{ publicKey: string; subscriptions: number }>('GET', '/api/push'),
    subscribe: (sub: PushSubscriptionJSON) => req<{ ok: true }>('POST', '/api/push/subscribe', sub),
    unsubscribe: (endpoint: string) => req<{ ok: boolean }>('POST', '/api/push/unsubscribe', { endpoint }),
    test: () => req<{ sent: number; failed: number }>('POST', '/api/push/test', {}),
  },
  // ---- P2: take over / hand back / pause, approval rules ----
  control: {
    list: () => req<ControlStatus[]>('GET', '/api/control'),
    set: (botId: string, control: ComputerControl, o: { holder?: string; note?: string } = {}) =>
      req<ControlStatus>('PUT', '/api/computers/' + encodeURIComponent(botId) + '/control', { control, ...o }),
  },
  policies: {
    list: (botId?: string) => req<ApprovalPolicy[]>('GET', '/api/approval-policies' + (botId ? '?botId=' + encodeURIComponent(botId) : '')),
    /** From an answered card; `pattern` narrows or widens what it covers. */
    fromApproval: (approvalId: string, pattern?: string) => req<ApprovalPolicy>('POST', '/api/approval-policies', { approvalId, ...(pattern ? { pattern } : {}) }),
    revoke: (id: string) => req<{ ok: true }>('DELETE', '/api/approval-policies/' + encodeURIComponent(id)),
  },
  // ---- P6: teach by demonstration, skill versions, reflection ----
  teach: {
    status: (botId: string) => req<RecorderStatus>('GET', '/api/computers/' + encodeURIComponent(botId) + '/recorder'),
    start: (botId: string, title?: string) => req<RecorderStatus>('POST', '/api/computers/' + encodeURIComponent(botId) + '/recorder/start', title ? { title } : {}),
    stop: (botId: string) => req<{ recording: RecordingInfo | null; status: RecorderStatus }>('POST', '/api/computers/' + encodeURIComponent(botId) + '/recorder/stop', {}),
    recordings: (botId: string) => req<RecordingInfo[]>('GET', '/api/computers/' + encodeURIComponent(botId) + '/recordings'),
    remove: (botId: string, id: string) => req<{ ok: true }>('DELETE', '/api/computers/' + encodeURIComponent(botId) + '/recordings/' + encodeURIComponent(id)),
    distill: (botId: string, id: string, o: { name?: string; hint?: string } = {}) =>
      req<{ skill: Skill; version: SkillVersion | null }>('POST', '/api/computers/' + encodeURIComponent(botId) + '/recordings/' + encodeURIComponent(id) + '/distill', o),
  },
  skillVersions: {
    list: (skillId: string) => req<SkillVersion[]>('GET', '/api/skills/' + encodeURIComponent(skillId) + '/versions'),
    get: (skillId: string, id: string) => req<SkillVersionDetail>('GET', '/api/skills/' + encodeURIComponent(skillId) + '/versions/' + encodeURIComponent(id)),
    decide: (skillId: string, id: string, decision: 'approve' | 'reject') =>
      req<{ skill: Skill; version: SkillVersion }>('POST', '/api/skills/' + encodeURIComponent(skillId) + '/versions/' + encodeURIComponent(id), { decision }),
    correct: (skillId: string, text: string) => req<SkillVersion>('POST', '/api/skills/' + encodeURIComponent(skillId) + '/corrections', { text }),
    reflection: (botId: string) => req<SkillReflectionConfig>('GET', '/api/bots/' + encodeURIComponent(botId) + '/skill-reflection'),
    setReflection: (botId: string, patch: Partial<Omit<SkillReflectionConfig, 'botId'>>) =>
      req<SkillReflectionConfig>('PUT', '/api/bots/' + encodeURIComponent(botId) + '/skill-reflection', patch),
  },
};

// ---- P9 ----
/** A paired device as the hub lists it (never its token or hash). */
export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
}
/** A fresh pairing code; `hosts` are the hub's POCKETROCKET_ALLOWED_HOSTS (where a phone can reach it). */
export interface PairingCode {
  code: string;
  expiresAt: number;
  ttlMs: number;
  hosts: string[];
}
