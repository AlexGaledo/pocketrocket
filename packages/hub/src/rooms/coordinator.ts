import type { Bot } from '@pocketrocket/shared';

const LEAD_RE = /(^|-)(lead|chief|coordinator|router|pm)(-|$)/i;

/**
 * The bot that should coordinate a group chat that has none: a member whose handle or title reads as a lead
 * (`wika-lead`, `chief`, "Chief of staff / coordinator"), else the first member. Null for an empty list.
 * Every group chat with two or more bots gets one, so a message with no @mention always reaches someone.
 */
export function pickCoordinator(members: Bot[]): Bot | null {
  return members.find((b) => LEAD_RE.test(b.handle)) ?? members.find((b) => /\b(lead|coordinator|chief)\b/i.test(b.title)) ?? members[0] ?? null;
}
