import { describe, expect, it } from 'vitest';
import { BLOCKED_BROWSER_MATCHER, BLOCKED_BROWSER_TOOLS } from './claude.js';

describe('BLOCKED_BROWSER_TOOLS', () => {
  it('covers every Playwright MCP tool that can read page contents outside a snapshot', () => {
    expect(BLOCKED_BROWSER_TOOLS).toEqual([
      'mcp__browser__browser_evaluate',
      'mcp__browser__browser_run_code_unsafe',
      'mcp__browser__browser_network_request',
    ]);
  });

  it('builds a hook matcher that hits only those tools', () => {
    const re = new RegExp(BLOCKED_BROWSER_MATCHER);
    for (const t of BLOCKED_BROWSER_TOOLS) expect(re.test(t)).toBe(true);
    for (const t of ['mcp__browser__browser_snapshot', 'mcp__browser__browser_network_requests', 'mcp__browser__browser_type', 'mcp__pocketrocket__fill_credential']) {
      expect(re.test(t)).toBe(false);
    }
  });
});
