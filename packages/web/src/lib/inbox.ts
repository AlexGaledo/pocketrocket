/**
 * The "Needs you" inbox (U3): everything waiting on the user across every bot and room, derived on the client from
 * data it already holds. Approvals come from `hello.openApprovals` plus pending cards in loaded rooms, takeovers
 * from the control status, and skills from GET /api/skills (reviewStatus / pendingVersions). No hub endpoint is
 * added; a source that would need one is listed in the changelog notes instead.
 */
import { ASK_EVERY_TIME_TOOLS, SIGN_IN_TOOLS, type ApprovalPayload, type ControlStatus, type FormPayload, type Message, type OpenApproval, type Skill, type WorkflowApprovalCard } from '@pocketrocket/shared';
import { toolPhrase } from './toolPhrases';

export type InboxKind = 'approval' | 'takeover' | 'skill' | 'form' | 'workflow';

/** How long a workflow approval card waits (the hub's 24 h park limit), to work back from `expiresAt` to when it began. */
const WORKFLOW_CARD_WAIT_MS = 24 * 3_600_000;

export interface InboxItem {
  /** Stable across renders: `approval:<id>`, `takeover:<messageId>`, `skill:<id>`. */
  key: string;
  kind: InboxKind;
  botId: string | null;
  /** The room to open; null for a skill, which is reviewed on its bot's page. */
  roomId: string | null;
  /** Plain words, no tool identifiers. */
  title: string;
  /** The bot's own reason, when its card is loaded. */
  detail: string | null;
  /** Epoch ms it started waiting, or null when the data in hand does not say. */
  since: number | null;
  approvalId?: string;
  /** Workflow approval steps only: the card itself, answered right on the row (it is person-only, and the row is that surface). */
  workflowCard?: WorkflowApprovalCard;
  /** Approvals only, when the card is loaded: which tool is waiting and its input. Context for the row, never a consent surface. */
  approval?: Pick<ApprovalPayload, 'toolName' | 'toolInput'>;
  /**
   * Approvals only: Deny may be offered on the row (denying is always safe, and uses the same `decide` as the card).
   * Allowing is never offered here: it goes through Open, to the full card.
   */
  canDeny?: boolean;
}

export interface InboxInput {
  openApprovals: OpenApproval[];
  messages: Record<string, Message[]>;
  control: Record<string, ControlStatus>;
  skills: Skill[] | null;
  /** Open workflow approval cards, each with the room its workflow runs in. */
  workflowCards?: { card: WorkflowApprovalCard; roomId: string | null }[];
}

/** Cards that are yes-or-no proposals rather than a tool call; ApprovalCard words them differently. */
const PROPOSAL_TOOLS: ReadonlySet<string> = new Set(['handoff', 'propose_routing_change']);

/** Only an ordinary gated tool call may be denied from the inbox row; every other class is Open only. */
export function rowMayDeny(p: ApprovalPayload): boolean {
  return !p.danger && !p.once && !p.signInRequired
    && !ASK_EVERY_TIME_TOOLS.has(p.toolName) && !SIGN_IN_TOOLS.has(p.toolName) && !PROPOSAL_TOOLS.has(p.toolName);
}

const isPendingApproval = (m: Message): m is Message & { payload: ApprovalPayload } =>
  m.kind === 'approval' && (m.payload as ApprovalPayload | null)?.status === 'pending';

const isPendingForm = (m: Message): m is Message & { payload: FormPayload } =>
  m.kind === 'form' && (m.payload as FormPayload | null)?.status === 'pending';

export function selectInbox({ openApprovals, messages, control, skills, workflowCards }: InboxInput): InboxItem[] {
  const items: InboxItem[] = [];

  // A workflow's approval step: person-only, so the row carries the whole card and nothing else answers it.
  for (const { card, roomId } of workflowCards ?? []) {
    items.push({
      key: 'workflow:' + card.runId + ':' + card.nodeId,
      kind: 'workflow',
      botId: null,
      roomId,
      title: 'Approval needed',
      detail: card.workflowName + ': ' + card.title,
      since: card.expiresAt - WORKFLOW_CARD_WAIT_MS,
      workflowCard: card,
    });
  }

  // Approvals: the hello list knows every open card; loaded rooms add detail (and any card the list missed).
  const cards = new Map<string, { m: Message & { payload: ApprovalPayload }; roomId: string }>();
  for (const [roomId, list] of Object.entries(messages)) {
    for (const m of list) if (isPendingApproval(m)) cards.set(m.payload.approvalId, { m, roomId });
  }
  const seen = new Set<string>();
  const add = (approvalId: string, botId: string | null, roomId: string) => {
    if (seen.has(approvalId)) return;
    seen.add(approvalId);
    const card = cards.get(approvalId);
    const p = card?.m.payload;
    items.push({
      key: 'approval:' + approvalId,
      kind: 'approval',
      botId,
      roomId,
      title: p ? 'Wants to ' + toolPhrase(p.toolName, 'now').toLowerCase() : 'Needs your approval',
      approval: p ? { toolName: p.toolName, toolInput: p.toolInput } : undefined,
      detail: p?.reason ? p.reason : null,
      since: card?.m.createdAt ?? null,
      approvalId,
      canDeny: !!p && rowMayDeny(p),
    });
  };
  for (const a of openApprovals) add(a.approvalId, a.botId, a.roomId);
  for (const [approvalId, { m, roomId }] of cards) add(approvalId, m.authorId, roomId);

  // Open request_form cards (a bot asked for a few values). Counted like approvals, but there is nothing to answer on
  // the row: Open goes to the card, where the fields are. The hub's hello does not list forms, so only loaded rooms show.
  for (const [roomId, list] of Object.entries(messages)) {
    for (const m of list) {
      if (!isPendingForm(m)) continue;
      items.push({
        key: 'form:' + m.id,
        kind: 'form',
        botId: m.payload.botId || m.authorId,
        roomId,
        title: 'Asked you for some details',
        detail: m.payload.title || null,
        since: m.createdAt,
      });
    }
  }

  for (const c of Object.values(control)) {
    const t = c.takeover;
    if (!t) continue;
    const card = messages[t.roomId]?.find((m) => m.id === t.messageId);
    items.push({
      key: 'takeover:' + t.messageId,
      kind: 'takeover',
      botId: c.botId,
      roomId: t.roomId,
      title: 'Needs you on its screen',
      detail: t.reason || null,
      since: card?.createdAt ?? c.since ?? null,
    });
  }

  for (const s of skills ?? []) {
    const n = s.pendingVersions ?? 0;
    if (s.reviewStatus !== 'pending' && n === 0) continue;
    items.push({
      key: 'skill:' + s.id,
      kind: 'skill',
      botId: s.createdByBot,
      roomId: null,
      title: s.reviewStatus === 'pending' ? 'New skill to review' : n === 1 ? 'Skill change to review' : n + ' skill changes to review',
      detail: s.name,
      since: null,
    });
  }

  // Oldest first (it has waited longest); items with no known age go last, in the order found.
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (a.it.since ?? Infinity) - (b.it.since ?? Infinity) || a.i - b.i)
    .map((x) => x.it);
}

/** "3m", "2h", "5d" for a wait; "just now" under a minute. */
export function fmtAge(since: number | null, now: number): string | null {
  if (since === null) return null;
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

/** Tab title with a count in front: `(2) PocketRocket`. The base is whatever the title was before. */
export function titleWithCount(base: string, count: number): string {
  const bare = base.replace(/^\(\d+\)\s*/, '');
  return count > 0 ? '(' + count + ') ' + bare : bare;
}
