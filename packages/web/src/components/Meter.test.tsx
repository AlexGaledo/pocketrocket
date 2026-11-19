import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

let Meter: typeof import('./ui').Meter;
beforeAll(async () => {
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  ({ Meter } = await import('./ui'));
});

describe('Meter', () => {
  it('reads as one sentence to a screen reader', () => {
    const html = renderToStaticMarkup(<Meter label="Claude 5-hour limit" value={82} detail="resets 14:00" />);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="82"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuetext="Claude 5-hour limit 82%, resets 14:00"');
  });

  it('uses the accent below 80 %, warn from 80 %, bad at the limit, and always writes the percent', () => {
    expect(renderToStaticMarkup(<Meter label="x" value={79} />)).toContain('bg-accent');
    expect(renderToStaticMarkup(<Meter label="x" value={80} />)).toContain('bg-warn');
    const held = renderToStaticMarkup(<Meter label="x" value={40} atLimit />);
    expect(held).toContain('bg-bad');
    expect(held).toContain('>40%<');
  });

  it('P4-2: reads the marker after the value and draws a tick where it sits', () => {
    const html = renderToStaticMarkup(<Meter label="Context" value={42} detail="84k of 200k tokens" marker={{ value: 60, label: 'a fresh session starts at 120k' }} />);
    expect(html).toContain('aria-valuetext="Context 42%, 84k of 200k tokens; a fresh session starts at 120k"');
    expect(html).toMatch(/data-meter-marker[^>]*left:60%/);
    expect(renderToStaticMarkup(<Meter label="x" value={42} />)).not.toContain('data-meter-marker');
  });

  it('clamps out-of-range values', () => {
    expect(renderToStaticMarkup(<Meter label="x" value={140} />)).toContain('aria-valuenow="100"');
    expect(renderToStaticMarkup(<Meter label="x" value={-3} />)).toContain('aria-valuenow="0"');
  });
});
