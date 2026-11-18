import type { IntegrationProvider } from './integrations.js';

/**
 * The one registry of every hub tool the PocketRocket MCP server can register (B3), with how the permission
 * broker treats each. The broker's SILENT/GATED/ASK_EVERY_TIME/SIGN_IN sets are derived from it, so a tool
 * cannot sit in one list and be missing from another. A drift test in the hub fails when a tool the hub
 * registers is missing here; a name that is not here still fails closed in `PermissionBroker.decide()`
 * (an "Unknown hub tool" approval card).
 *
 * Classes, weakest to strictest. Each stricter class is also in every set of the looser ones below it:
 *   silent        needs no card: read-only, or already visible to the user as a room message.
 *   gated         changes the fleet, schedules or reaches outside; the tool handler raises the card itself.
 *   askEveryTime  gated, and answered once per card: no "for this session", no rule can pre-approve it.
 *   signInOnly    askEveryTime, and only a browser signed in with the owner's password may allow it.
 *   unlisted      registered, but not in any broker set today. `decide()` cards it like an unknown tool; the
 *                 Claude provider pre-approves it with `mcp__pocketrocket__*` and other providers reach it over
 *                 MCP without `decide()`. Kept as-is on purpose: classifying one is a behaviour change.
 */
export type HubToolClass = 'silent' | 'gated' | 'askEveryTime' | 'signInOnly' | 'unlisted';

/** Integration hub tools by provider. Reads run silently; writes raise a card on every call (spec §2.5). */
export const INTEGRATION_TOOLS: Record<IntegrationProvider, { read: readonly string[]; write: readonly string[] }> = {
  github: {
    read: ['github_search_issues', 'github_list_issues', 'github_read_issue', 'github_notifications'],
    write: ['github_create_issue', 'github_comment'],
  },
  google: {
    read: ['gmail_search', 'gmail_read', 'calendar_list_events', 'drive_search', 'drive_read'],
    write: ['gmail_send', 'calendar_create_event'],
  },
  slack: {
    read: ['slack_list_channels', 'slack_read_history'],
    write: ['slack_post_message'],
  },
  clickup: {
    read: ['clickup_list_lists', 'clickup_list_tasks', 'clickup_search_tasks', 'clickup_read_task'],
    write: ['clickup_create_task', 'clickup_comment'],
  },
  teams: {
    read: ['teams_list_chats', 'teams_read_chat'],
    write: ['teams_send_chat'],
  },
};

export const INTEGRATION_READ_TOOLS: readonly string[] = Object.values(INTEGRATION_TOOLS).flatMap((t) => t.read);
export const INTEGRATION_WRITE_TOOLS: readonly string[] = Object.values(INTEGRATION_TOOLS).flatMap((t) => t.write);

/** The computer-use tools of a bot's virtual desktop. */
export const DESKTOP_TOOL_NAMES: readonly string[] = [
  'desktop_screenshot', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'desktop_launch',
];

const silent = (names: readonly string[]): [string, HubToolClass][] => names.map((n) => [n, 'silent']);
const gated = (names: readonly string[]): [string, HubToolClass][] => names.map((n) => [n, 'gated']);

/** Every hub tool name, bare (no `mcp__pocketrocket__` prefix), with its class. */
export const HUB_TOOLS: Readonly<Record<string, HubToolClass>> = Object.freeze(Object.fromEntries<HubToolClass>([
  ...silent([
    'send_message', 'handoff', 'update_memory', 'read_memory', 'save_skill', 'list_bots', 'read_room',
    'list_rooms', 'request_approval', 'use_stronger_model',
    'list_routines',
    // Key routing: reads key-registry.json, names only.
    'where_to_run',
    // Machines: the registry with each one's policy, read-only.
    'list_machines',
    // Notes live in the bot's own home.
    'search_notes', 'write_note',
    // G1-G5: tasks only touch the local task table and grant nothing; search and recall are reads over the bot's own
    // rooms and notes; report_blocked posts a room note and send_feedback appends to a local file, both rate limited.
    'create_task', 'update_task', 'list_tasks', 'search_history', 'recall_memory', 'report_blocked', 'send_feedback',
    // U4: a card that asks the owner for a few plain values. It changes nothing and carries no secret (no password
    // field; secret-looking labels and answers are refused), and the owner answers it in the chat, which is the gate.
    'request_form',
    // Bridge P1: log_decision appends to the bot's own room/project folder (the one it may already write); history is
    // a read of that folder's revisions.
    'log_decision', 'file_history',
    // Bridge P5: the repos of this room's project (names, remotes, sync modes), only for a bot on that project.
    'list_repos',
  ]),
  ...silent(DESKTOP_TOOL_NAMES),
  // Integration reads: granted per bot; untrusted output is labelled as such.
  ...silent(INTEGRATION_READ_TOOLS),
  ...gated([
    'create_bot', 'update_bot', 'delete_bot', 'create_room', 'delete_room', 'add_to_room', 'remove_from_room',
    // A routine a bot schedules is autonomous future spend.
    'create_routine', 'update_routine', 'delete_routine',
    // Persona only: posts into a room as the persona and wakes a member; its handler raises the card for a room the persona is not in.
    'dispatch',
  ]),
  // Integration writes; their handlers call askIntegrationWrite.
  ...gated(INTEGRATION_WRITE_TOOLS),
  // Its handler calls askRoutingChange.
  ['propose_routing_change', 'askEveryTime'],
  // A Claude Code job on the owner's PC; its handler calls askFleetChange with evenUnderBypass.
  ['run_on_pc', 'signInOnly'],
  // Bridge P6: proposes moving a PC session to the VPS, or pulling it back. The card is the proposal; only a browser
  // signed in with the owner's password may allow it, and the PC asks again before it runs anything.
  ['propose_move', 'signInOnly'],
  // Types a saved login into the bot's browser; its handler calls askCredentialFill. Asked on every call, under bypass
  // too, and only a signed-in browser may allow it (G4).
  ['fill_credential', 'signInOnly'],
  // Registered by the hub but in no broker set today (see `unlisted` above).
  ['read_owner_messages', 'unlisted'],
  // Bridge P4, @persona only (registered when settings.personaBotId is that bot). The reads quote and redact what they
  // return; dispatch posts as the persona and its handler raises a card for a room the persona is not in.
  ['read_any_room', 'unlisted'],
  ['list_pc_sessions', 'unlisted'],
  ['read_pc_session', 'unlisted'],
  ['search_project_context', 'unlisted'],
  ['view_screen', 'unlisted'],
  ['request_takeover', 'unlisted'],
]));

const where = (pred: (c: HubToolClass) => boolean): ReadonlySet<string> =>
  new Set(Object.entries(HUB_TOOLS).filter(([, c]) => pred(c)).map(([n]) => n));

/** Never need a card. */
export const SILENT_TOOLS: ReadonlySet<string> = where((c) => c === 'silent');
/** Allowed through the broker's gate because the tool handler itself raises the card. */
export const GATED_TOOLS: ReadonlySet<string> = where((c) => c === 'gated' || c === 'askEveryTime' || c === 'signInOnly');
/** Answered once per card: no "for this session", and no rule can pre-approve it. */
export const ASK_EVERY_TIME_TOOLS: ReadonlySet<string> = where((c) => c === 'askEveryTime' || c === 'signInOnly');
/** Cards only a browser signed in with the owner's password may allow. */
export const SIGN_IN_TOOLS: ReadonlySet<string> = where((c) => c === 'signInOnly');
