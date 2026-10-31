import { DESKTOP_TOOL_NAMES } from '../agent/desktopTools.js';

/*
 * P2 control interlock (docs/specs/grok-bot-parity.md §2.2). While the user has control of a bot's computer
 * (or the bot is paused) its desktop and Browser tools must not act. This is a safety interlock, not an
 * approval: it holds in bypass mode too, and it is enforced at every layer a tool call passes through
 * (desktop tool handlers, the HTTP MCP endpoint, the Claude PreToolUse hook, PermissionBroker.decide).
 */

/** True for the tools that drive a bot's computer: Playwright MCP (`mcp__browser__*`) and the desktop_* tools. */
export function isComputerTool(name: string): boolean {
  if (name.startsWith('mcp__browser__')) return true;
  const bare = name.startsWith('mcp__pocketrocket__') ? name.slice('mcp__pocketrocket__'.length) : name;
  return DESKTOP_TOOL_NAMES.includes(bare);
}

/** Builds a per-call guard from a "why is this bot blocked" lookup. */
export function computerToolGuard(blockedReason: () => string | null): (toolName: string) => string | null {
  return (toolName) => (isComputerTool(toolName) ? blockedReason() : null);
}
