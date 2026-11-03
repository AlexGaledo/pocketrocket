// P5: event triggers. Outside events (GitHub, Gmail, Calendar, Drive, Slack, ClickUp, Teams) wake a bot in a
// room. Events arrive by outbound polling plus Slack Socket Mode (decision Q5): there is no inbound webhook.
import { z } from 'zod';
import type { IntegrationProvider } from './integrations.js';

/** Where a trigger listens. Each maps to one integration provider. */
export const TRIGGER_SOURCES = [
  'github.notifications', 'github.repo', 'gmail', 'calendar', 'drive', 'slack', 'clickup', 'teams',
] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const TRIGGER_SOURCE_PROVIDER: Record<TriggerSource, IntegrationProvider> = {
  'github.notifications': 'github', 'github.repo': 'github', gmail: 'google', calendar: 'google', drive: 'google',
  slack: 'slack', clickup: 'clickup', teams: 'teams',
};

export const TRIGGER_SOURCE_LABEL: Record<TriggerSource, string> = {
  'github.notifications': 'GitHub notifications', 'github.repo': 'GitHub repository events', gmail: 'Gmail',
  calendar: 'Google Calendar', drive: 'Google Drive', slack: 'Slack', clickup: 'ClickUp', teams: 'Microsoft Teams',
};

/**
 * Filter fields per source, as the builder offers them. A filter value matches when the event's field contains
 * it (case-insensitive); comma-separated values mean "any of". `required` fields also pick what is polled
 * (the repository, the calendar, the ClickUp workspace).
 */
export const TRIGGER_FILTERS: Record<TriggerSource, ReadonlyArray<{ key: string; label: string; placeholder: string; required?: boolean }>> = {
  'github.notifications': [
    { key: 'repo', label: 'Repository', placeholder: 'owner/name' },
    { key: 'reason', label: 'Reason', placeholder: 'review_requested, mention' },
    { key: 'type', label: 'Type', placeholder: 'PullRequest, Issue' },
    { key: 'title', label: 'Title contains', placeholder: 'release' },
  ],
  'github.repo': [
    { key: 'repo', label: 'Repository', placeholder: 'owner/name', required: true },
    { key: 'type', label: 'Event', placeholder: 'IssuesEvent, PullRequestEvent' },
    { key: 'action', label: 'Action', placeholder: 'opened, labeled' },
    { key: 'labels', label: 'Label', placeholder: 'bug' },
    { key: 'from', label: 'Actor', placeholder: 'octocat' },
  ],
  gmail: [
    { key: 'from', label: 'From', placeholder: 'boss@example.com' },
    { key: 'subject', label: 'Subject contains', placeholder: 'invoice' },
    { key: 'labels', label: 'Label', placeholder: 'INBOX, IMPORTANT' },
  ],
  calendar: [
    { key: 'calendar', label: 'Calendar', placeholder: 'primary' },
    { key: 'title', label: 'Title contains', placeholder: 'interview' },
    { key: 'status', label: 'Status', placeholder: 'confirmed, cancelled' },
  ],
  drive: [
    { key: 'title', label: 'File name contains', placeholder: 'report' },
    { key: 'removed', label: 'Removed', placeholder: 'true' },
  ],
  slack: [
    { key: 'channel', label: 'Channel id', placeholder: 'C0123ABCD' },
    { key: 'from', label: 'User id', placeholder: 'U0123ABCD' },
    { key: 'text', label: 'Text contains', placeholder: 'deploy' },
    { key: 'type', label: 'Event', placeholder: 'message, app_mention' },
  ],
  clickup: [
    { key: 'workspace', label: 'Workspace id', placeholder: 'first workspace' },
    { key: 'list', label: 'List', placeholder: 'Sprint 12' },
    { key: 'status', label: 'Status', placeholder: 'in review' },
    { key: 'assignees', label: 'Assignee', placeholder: 'alex' },
  ],
  teams: [
    { key: 'chat', label: 'Chat topic', placeholder: 'Design' },
    { key: 'from', label: 'From', placeholder: 'Jordan' },
    { key: 'text', label: 'Text contains', placeholder: 'urgent' },
  ],
};

/** One event, normalised across providers. All of it is third-party text: never instructions. */
export interface TriggerEvent {
  source: TriggerSource;
  /** Provider event id (the dedupe key is built from it). */
  id: string;
  title: string;
  text: string;
  from: string;
  url: string;
  /** ISO time the provider gave the event. */
  at: string;
  /** Flat fields filters match on (repo, labels, channel, ...). */
  fields: Record<string, string>;
}

export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  source: TriggerSource;
  filter: Record<string, string>;
  botId: string;
  roomId: string;
  /** Prompt template; `{{event.title}}`, `{{event.from}}`, `{{event.fields.repo}}` … are filled in as quoted data. */
  prompt: string;
  /** Fires per rolling hour; more are recorded as skipped. */
  maxPerHour: number;
  /** USD this trigger may spend per rolling 24 hours (its turns and the hops they cause). */
  budgetUsd: number;
  createdAt: number;
  updatedAt: number;
  lastFiredAt: number | null;
}

export type TriggerFireStatus = 'running' | 'success' | 'error' | 'skipped';
export interface TriggerFire {
  id: string;
  triggerId: string;
  /** events_inbox row, or null for a test fire. */
  eventId: string | null;
  title: string;
  status: TriggerFireStatus;
  /** Why it was skipped or failed (rate limit, budget, no access ...). */
  note: string | null;
  messageId: string | null;
  costUsd: number | null;
  test: boolean;
  startedAt: number;
  endedAt: number | null;
}

/** Message payload of a `kind: 'trigger'` message. */
export interface TriggerPayload {
  triggerId: string;
  fireId: string;
  name: string;
  source: TriggerSource;
  eventId: string | null;
}

/** One poll stream's health, for the builder ("last checked 2 min ago", errors). */
export interface TriggerPollStatus {
  key: string;
  source: TriggerSource;
  lastPolledAt: number | null;
  nextPollAt: number | null;
  failures: number;
  lastError: string | null;
}

/** GET /api/triggers */
export interface TriggersState {
  triggers: Trigger[];
  /** Sources whose provider is connected, so the builder offers only those. */
  available: TriggerSource[];
  polls: TriggerPollStatus[];
  /** Fires and spend per trigger in the last 24 h. */
  stats: Record<string, { firesLastHour: number; spentLastDayUsd: number }>;
}

export const TriggerInputSchema = z.object({
  name: z.string().min(1).max(60),
  enabled: z.boolean().default(true),
  source: z.enum(TRIGGER_SOURCES),
  filter: z.record(z.string(), z.string().max(200)).default({}),
  botId: z.string().min(1),
  roomId: z.string().min(1),
  prompt: z.string().min(1).max(4000),
  maxPerHour: z.number().int().min(1).max(60).default(6),
  budgetUsd: z.number().min(0.05).max(100).default(2),
});
export type TriggerInput = z.infer<typeof TriggerInputSchema>;

/** PATCH body: any subset, with no defaults (zod's `.partial()` would still fill them in and reset fields). */
export const TriggerPatchSchema = z.object({
  name: z.string().min(1).max(60),
  enabled: z.boolean(),
  source: z.enum(TRIGGER_SOURCES),
  filter: z.record(z.string(), z.string().max(200)),
  botId: z.string().min(1),
  roomId: z.string().min(1),
  prompt: z.string().min(1).max(4000),
  maxPerHour: z.number().int().min(1).max(60),
  budgetUsd: z.number().min(0.05).max(100),
}).partial();

/** POST /api/triggers/:id/test: an optional sample event; a default one for the source otherwise. */
export const TriggerTestSchema = z.object({
  event: z.object({
    id: z.string().max(200).optional(),
    title: z.string().max(500).optional(),
    text: z.string().max(10_000).optional(),
    from: z.string().max(200).optional(),
    url: z.string().max(1000).optional(),
    fields: z.record(z.string(), z.string().max(500)).optional(),
  }).optional(),
});
export type TriggerTestInput = z.infer<typeof TriggerTestSchema>;
