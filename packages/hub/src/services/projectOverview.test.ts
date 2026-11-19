import { describe, expect, it } from 'vitest';
import { parseProjectOverview } from './projectOverview.js';

describe('parseProjectOverview', () => {
  it('reads the plan, stage, next, done and waiting from a full current.md', () => {
    const md = [
      '---', 'status: current', 'updated: 2026-11-19', '---', '',
      '# Shop', '',
      '## Foundations', '- [x] repo', '- [x] CI', '',
      '## Checkout', '- [x] cart', '- [ ] payments', '- [ ] receipts', '',
      '## Launch', '- [ ] domain', '',
      '## Next', '- Wire the payments provider', '- Then receipts', '',
      '## Done', '- one', '- two', '- three', '- four', '',
      '## Waiting on owner', '- Pick a payments provider', '- Approve the copy', '',
    ].join('\n');
    expect(parseProjectOverview(md)).toEqual({
      updated: '2026-11-19',
      plan: { done: 3, total: 6, stage: 'Checkout' },
      next: 'Wire the payments provider',
      done: ['two', 'three', 'four'],
      waiting: ['Pick a payments provider', 'Approve the copy'],
    });
  });

  it('has no plan without checkboxes, and nothing at all for the starter file', () => {
    const starter = '---\nstatus: current\nupdated: 2026-11-20\n---\n\n# Shop\n\nWhat is true now. Move anything outdated to archive/.\n';
    expect(parseProjectOverview(starter)).toEqual({ updated: '2026-11-20', plan: null, next: null, done: [], waiting: [] });
    expect(parseProjectOverview('')).toEqual({ updated: null, plan: null, next: null, done: [], waiting: [] });
  });

  it('has no stage when every box is ticked', () => {
    expect(parseProjectOverview('## Build\n- [x] a\n- [X] b\n').plan).toEqual({ done: 2, total: 2, stage: null });
  });

  it('takes the nearest ## heading, not a ### under it, and null when the box comes before any ##', () => {
    expect(parseProjectOverview('## Phase 2\n### Detail\n- [ ] x\n').plan?.stage).toBe('Phase 2');
    expect(parseProjectOverview('# Title\n- [ ] x\n## Later\n- [ ] y\n').plan).toEqual({ done: 0, total: 2, stage: null });
  });

  it('matches heading words case-insensitively and accepts other bullet styles', () => {
    const md = [
      '### NEXT STEPS', '* first thing', '',
      '## Shipped this week', '1. alpha', '2. beta', '',
      '## Waiting on you', '+ a decision', '',
      '## Waiting on the vendor', '- not for the owner', '',
    ].join('\n');
    const o = parseProjectOverview(md);
    expect(o.next).toBe('first thing');
    expect(o.done).toEqual(['alpha', 'beta']);
    expect(o.waiting).toEqual(['a decision']);
  });

  it('reads checkbox bullets under Next as plain text and skips nested lines', () => {
    const md = '## Next\n- [ ] ship the map\n  - detail line\n';
    const o = parseProjectOverview(md);
    expect(o.next).toBe('ship the map');
    expect(o.plan).toEqual({ done: 0, total: 1, stage: 'Next' });
  });

  it('ignores code fences, CRLF line ends and a byte order mark', () => {
    const md = '\uFEFF---\r\nupdated: 2026-01-02\r\n---\r\n## Next\r\n```\r\n- [ ] not a box\r\n## Done\r\n```\r\n- real next\r\n';
    expect(parseProjectOverview(md)).toEqual({ updated: '2026-01-02', plan: null, next: 'real next', done: [], waiting: [] });
  });

  it('does not treat words that only start like a heading as one', () => {
    const o = parseProjectOverview('## Nextjs notes\n- a\n## Donation ideas\n- b\n');
    expect(o.next).toBeNull();
    expect(o.done).toEqual([]);
  });

  it('caps long lines and the waiting list', () => {
    const long = 'x'.repeat(500);
    const md = '## Waiting on me\n' + Array.from({ length: 30 }, (_, i) => '- ' + (i === 0 ? long : 'item ' + i)).join('\n');
    const o = parseProjectOverview(md);
    expect(o.waiting).toHaveLength(20);
    expect(o.waiting[0].length).toBe(200);
  });
});
