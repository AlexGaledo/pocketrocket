import { describe, expect, it } from 'vitest';
import { toolAsk } from './toolPhrases';

describe('toolAsk', () => {
  it('reads as a plain verb after "Wants to"', () => {
    expect(toolAsk('Bash')).toBe('run a command');
    expect(toolAsk('WebFetch')).toBe('fetch a page');
    expect(toolAsk('WebSearch')).toBe('search the web');
    expect(toolAsk('Edit')).toBe('edit a file');
    expect(toolAsk('mcp__browser__browser_take_screenshot')).toBe('take screenshot');
    expect(toolAsk('mcp__pocketrocket__desktop_scroll')).toBe('scroll');
    expect(toolAsk('mcp__pocketrocket__create_routine')).toBe('create schedule');
    expect(toolAsk('mcp__pocketrocket__request_takeover')).toBe('ask you to step in');
  });
  it('falls back to "use" for a tool with no phrase', () => {
    expect(toolAsk('mcp__gmail__gmail_search')).toBe('use gmail search');
  });
});
