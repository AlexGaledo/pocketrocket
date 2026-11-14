import { describe, expect, it } from 'vitest';
import { displayCta } from '@pocketrocket/shared';
import { displayFields } from './cardFields';

describe('displayCta (browser side)', () => {
  it('caps at 3 before anything else, drops unsafe links and cleans labels again', () => {
    const out = displayCta({ cta: [
      { label: 'A‮', say: 'one' },
      { label: 'Bad', href: 'javascript:alert(1)' },
      { label: 'Link', href: 'https://example.com/p' },
      { label: 'Both', say: 'x', href: 'https://a.com' },
      { label: 'C', say: 'three' },
      { label: 'D', say: 'four' },
    ] });
    expect(out).toEqual([{ label: 'A', say: 'one' }, { label: 'Link', href: 'https://example.com/p', host: 'example.com' }]);
  });
  it('returns nothing for junk payloads', () => {
    expect(displayCta(null)).toEqual([]);
    expect(displayCta({ cta: 'x' })).toEqual([]);
    expect(displayCta({ workRoomId: 'r' })).toEqual([]);
  });
});

describe('displayFields (browser side)', () => {
  it('caps at 8 fields, keeps markup as text and drops unknown kinds', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: 'f' + i, kind: 'yesno', label: 'L' + i, required: true }));
    expect(displayFields(many)).toHaveLength(8);
    const f = displayFields([
      { id: 'a', kind: 'text', label: '<script>x</script>', required: true, maxLength: 9999 },
      { id: 'b', kind: 'password', label: 'Secret', required: true },
      { id: 'c', kind: 'choice', label: 'C', required: true, choices: ['only'] },
    ]);
    expect(f).toEqual([{ id: 'a', kind: 'text', label: '<script>x</script>', required: true, maxLength: 500 }]);
  });
});
