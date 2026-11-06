import type { BotPreview, SearchHit } from '@pocketrocket/shared';
import type {
  Bot, BotInput, Room, RoomInput, Message, Skill, Routine, RoutineRun, RoutineInput, UsageTotals, UsageRow, HealthInfo,
  Settings, SettingsPatch, ProvidersResponse, ProviderId, ProviderCheck, SecretsStatus, AccountState, UsageGroup,
  ComputerStatus,
  IntegrationsState, IntegrationInfo, IntegrationProvider, OAuthAppInput, OAuthAppStatus, PendingConnect, TokenConnectInput,
} from '@pocketrocket/shared';
import type { AuditEntry, UserSessionInfo } from '@pocketrocket/shared';
import type { KnowledgeStatus, SkillGitImportResult, VoiceProposal } from '@pocketrocket/shared';
import type { Trigger, TriggerFire, TriggerInput, TriggersState, TriggerTestInput } from '@pocketrocket/shared';
import type { ApprovalPolicy, ComputerControl, ControlStatus } from '@pocketrocket/shared';
import type { RecorderStatus, RecordingInfo, SkillReflectionConfig, SkillVersion, SkillVersionDetail } from '@pocketrocket/shared';
import type { TrainingDecision, TrainingPassResult, TrainingProposal, TrainingState } from '@pocketrocket/shared';
import type { FileChangeResult, FileListing, FileUploadInput } from '@pocketrocket/shared';
import type { PcRunnerJob, PcRunnerStatus } from '@pocketrocket/shared';
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

export interface ProjectInfo { slug: string; name: string; dir: string; memberIds: string[]; roomId: string | null; templateVersion: number | null; createdAt: number }
export interface ProjectLint { issues: { kind: string; path: string; detail: string }[]; recentMisses: string[] }

const filesBase = (roomId: string) => '/api/rooms/' + encodeURIComponent(roomId) + '/files';

/** A File as plain base64 (no `data:` prefix), the shape POST /api/rooms/:id/files/upload takes. */
function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.readAsDataURL(file);
  });
}

export const api = {
  /**
   * A room's file folder (hub token only; a paired phone gets 403). Paths are relative to the room's folder with '/'
   * separators, '' being the folder itself. `files.changed` events name the folder whose listing changed.
   */
  files: {
    list: (roomId: string, path = '') => req<FileListing>('GET', filesBase(roomId) + '?path=' + encodeURIComponent(path)),
    /** The raw-bytes URL. It needs the Bearer header, so fetch it with `blob` rather than putting it in an <img>. */
    rawUrl: (roomId: string, path: string, download = false) =>
      filesBase(roomId) + '/raw?path=' + encodeURIComponent(path) + (download ? '&download=1' : ''),
    /** The file's bytes, for a preview (blob URL) or a download. Files over 50 MB are refused with 413. */
    blob: async (roomId: string, path: string, download = false): Promise<Blob> => {
      const token = getToken();
      const r = await fetch(api.files.rawUrl(roomId, path, download), { headers: token ? { authorization: 'Bearer ' + token } : {} });
      if (r.status === 401) reportAuthFailure();
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new ApiError((j as { error?: string }).error ?? r.statusText, r.status);
      }
      return r.blob();
    },
    upload: (roomId: string, input: FileUploadInput) => req<FileChangeResult>('POST', filesBase(roomId) + '/upload', input),
    /**
     * Reads a picked or dropped File and uploads it into the folder `path` (25 MB cap; 409 if the name is taken).
     * `parents` makes any missing folder in `path` first, as a folder upload needs.
     */
    uploadFile: async (roomId: string, path: string, file: File, overwrite = false, parents = false, name = file.name) =>
      api.files.upload(roomId, { path, name, dataBase64: await fileToBase64(file), overwrite, ...(parents ? { parents } : {}) }),
    /** `parents`: mkdir -p, so missing folders in `path` are made and a folder already called `name` is fine. */
    mkdir: (roomId: string, path: string, name: string, parents = false) =>
      req<FileChangeResult>('POST', filesBase(roomId) + '/folder', parents ? { path, name, parents } : { path, name }),
    /** Rename or move: both paths relative to the room's folder. 409 when `to` exists. */
    rename: (roomId: string, from: string, to: string) => req<FileChangeResult>('PATCH', filesBase(roomId), { from, to }),
    /** A folder with anything in it needs `recursive` (409 otherwise). */
    remove: (roomId: string, path: string, recursive = false) =>
      req<FileChangeResult>('DELETE', filesBase(roomId) + '?path=' + encodeURIComponent(path) + (recursive ? '&recursive=true' : '')),
  },
  projects: {
    list: () => req<ProjectInfo[]>('GET', '/api/projects'),
    create: (input: { name: string; team?: boolean }) => req<{ project: ProjectInfo; bots: Bot[] }>('POST', '/api/projects', input),
    setMembers: (slug: string, memberIds: string[]) => req<ProjectInfo>('PUT', '/api/projects/' + encodeURIComponent(slug) + '/members', { memberIds }),
    lint: (slug: string) => req<ProjectLint>('GET', '/api/projects/' + encodeURIComponent(slug) + '/lint'),
  },
  auth: {
    status: () => req<{ passwordSet: boolean; signedIn: boolean }>('GET', '/api/auth/status'),
    /** Sets the session cookie. 403 wrong password, 429 too many tries. Reconnect the socket after, so it carries it. */
    login: (password: string) => req<{ ok: boolean }>('POST', '/api/auth/login', { password }),
    sessions: () => req<{ sessions: UserSessionInfo[]; current: string | null; passwordSet: boolean }>('GET', '/api/auth/sessions'),
    setPassword: (password: string, currentPassword?: string) => req<{ ok: boolean }>('POST', '/api/auth/password', { password, currentPassword }),
    logout: () => req<{ ok: boolean }>('POST', '/api/auth/logout', {}),
    revoke: (id: string) => req<{ ok: boolean }>('DELETE', '/api/auth/sessions/' + encodeURIComponent(id)),
    revokeOthers: () => req<{ ended: number }>('POST', '/api/auth/sessions/revoke-others', {}),
  },
  audit: (opts: { limit?: number; before?: number } = {}) =>
    req<{ entries: AuditEntry[] }>('GET', '/api/audit?limit=' + (opts.limit ?? 50) + (opts.before ? '&before=' + opts.before : '')),
  health: () => req<HealthResponse>('GET', '/api/health'),
  // P1: with a botId, that bot's own computer (`computer` says whether this hub has per-bot computers at all).
  screen: (botId?: string) =>
    req<{ screen: boolean; cdp: boolean; url: string; computer?: ComputerStatus }>('GET', '/api/screen' + (botId ? '?botId=' + encodeURIComponent(botId) : '')),
  // Spends the hub token on a single-use ticket so the token itself never reaches an iframe URL. With a botId
  // the ticket opens that bot's screen only.
  screenTicket: (botId?: string) => req<{ url: string }>('POST', '/api/screen/ticket', botId ? { botId } : undefined),
  computers: {
    get: (botId: string) => req<ComputerStatus>('GET', '/api/computers/' + encodeURIComponent(botId)),
    wake: (botId: string, o: { auto?: boolean } = {}) => req<ComputerStatus>('POST', '/api/computers/' + encodeURIComponent(botId) + '/wake', o),
    keepAwake: (botId: string, on: boolean) => req<ComputerStatus>('PUT', '/api/computers/' + encodeURIComponent(botId) + '/keep-awake', { on }),
  },
  config: () => req<{ workspaceDir: string; version: string }>('GET', '/api/config'),
  // Opens the shared workspace on whichever computer the hub runs on; `where` says which one it was. On a hub
  // with per-bot computers it opens on `botId`'s computer (P1), or `error` says to open its Screen first.
  openWorkspace: (botId?: string | null) =>
    req<{ ok: boolean; where: 'explorer' | 'finder' | 'screen' | 'file-manager'; path: string; error?: string }>('POST', '/api/workspace/open', botId ? { botId } : {}),
  // A picture, base64 in JSON. Reading one back is lib/media.ts, which wants a blob rather than JSON.
  media: {
    upload: (data: string) => req<{ ref: string }>('POST', '/api/media', { data }),
  },
  bots: {
    list: () => req<Bot[]>('GET', '/api/bots'),
    create: (b: BotInput) => req<Bot>('POST', '/api/bots', b),
    update: (id: string, b: Partial<BotInput>) => req<Bot>('PATCH', '/api/bots/' + id, b),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/bots/' + id),
    /** memory.md, its size and cap in bytes, and when auto-memory last wrote to it (null: never). */
    memory: (id: string) => req<{ text: string; bytes: number; limit: number; lastAutoSavedAt: number | null }>('GET', '/api/bots/' + id + '/memory'),
    setMemory: (id: string, text: string) => req<{ ok: true }>('PUT', '/api/bots/' + id + '/memory', { text }),
    skills: (id: string) => req<string[]>('GET', '/api/bots/' + id + '/skills'),
    setSkills: (id: string, skillIds: string[]) => req<{ ok: true }>('PUT', '/api/bots/' + id + '/skills', { skillIds }),
    resetSession: (id: string, roomId: string) => req<{ ok: true }>('POST', '/api/bots/' + id + '/reset-session', { roomId }),
  },
  routing: {
    get: () => req<{ text: string }>('GET', '/api/routing'),
    save: (text: string) => req<{ text: string }>('PUT', '/api/routing', { text }),
  },
  rooms: {
    list: () => req<Room[]>('GET', '/api/rooms'),
    create: (r: RoomInput) => req<Room>('POST', '/api/rooms', r),
    update: (id: string, r: Partial<RoomInput>) => req<Room>('PATCH', '/api/rooms/' + id, r),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/rooms/' + id),
    /** The composer's pick for this chat; null goes back to each bot's own model. */
    setModel: (id: string, model: string | null) => req<Room>('PUT', '/api/rooms/' + id + '/model', { model }),
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
  previews: () => req<Record<string, BotPreview>>('GET', '/api/previews'),
  search: (q: string) => req<SearchHit[]>('GET', '/api/search?q=' + encodeURIComponent(q)),
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
  // The owner's PC as a job runner. Hub principal only; a paired phone and the runner itself get 403.
  pcRunner: {
    status: () => req<PcRunnerStatus>('GET', '/api/pc-runner'),
    jobs: (limit = 50) => req<PcRunnerJob[]>('GET', '/api/pc-runner/jobs?limit=' + limit),
    job: (id: string) => req<PcRunnerJob>('GET', '/api/pc-runner/jobs/' + encodeURIComponent(id)),
    /** Shown once and never stored here: the caller keeps it in component state only. Replaces the old token. */
    mintToken: () => req<{ token: string }>('POST', '/api/pc-runner/token', {}),
    turnOff: () => req<{ ok: true; cancelled: number }>('DELETE', '/api/pc-runner'),
  },
  devices: {
    list:() => req<{ devices: DeviceInfo[]; current: string | null }>('GET', '/api/devices'),
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
  training: {
    get: (botId: string) => req<TrainingState>('GET', '/api/bots/' + encodeURIComponent(botId) + '/training'),
    setEnabled: (botId: string, enabled: boolean) => req<TrainingState>('PUT', '/api/bots/' + encodeURIComponent(botId) + '/training', { enabled }),
    run: (botId: string) => req<TrainingPassResult>('POST', '/api/bots/' + encodeURIComponent(botId) + '/training/run', {}),
    decide: (botId: string, id: string, decision: TrainingDecision) =>
      req<TrainingProposal>('POST', '/api/bots/' + encodeURIComponent(botId) + '/training/proposals/' + encodeURIComponent(id), { decision }),
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
