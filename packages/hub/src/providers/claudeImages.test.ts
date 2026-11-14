import { describe, expect, it } from 'vitest';
import { userContent } from './claude.js';

describe('claude user content with pictures (U2a)', () => {
  it('stays the plain string without pictures', () => {
    expect(userContent('hello', [])).toBe('hello');
  });

  it('adds one base64 image block per picture after the text', () => {
    const data = Buffer.from([1, 2, 3, 4]);
    const c = userContent('look', [{ path: '/x/a.png', mediaType: 'image/png', data }]);
    expect(c).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } },
    ]);
  });
});
