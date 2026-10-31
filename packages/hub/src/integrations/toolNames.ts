import type { IntegrationProvider } from '@pocketrocket/shared';

/**
 * Integration hub tools by provider. Kept free of imports so the PermissionBroker can read the lists
 * without pulling in the clients.
 *
 * Read tools run silently. Write tools raise an approval card from inside their handler on EVERY call,
 * also when the hub runs with approvals bypassed and also after an "Always" answer: sending mail or
 * posting as the user is never pre-approved (spec §2.5; persisted policies are P2's to add).
 */
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
