import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PcJobView } from '../lib/pcRun';

let PcRunForm: typeof import('./PcRunForm').PcRunForm;
beforeAll(async () => {
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  ({ PcRunForm } = await import('./PcRunForm'));
});

const base = { prompt: 'go', onPrompt: () => undefined, onSubmit: () => undefined, submitLabel: 'Send to PC', blocked: null as string | null };
const disabledCount = (html: string) => (html.match(/disabled=""/g) ?? []).length;

describe('Continue on PC form', () => {
  it('is ready to send when the PC is online and the browser is signed in', () => {
    const html = renderToStaticMarkup(<PcRunForm {...base} />);
    expect(html).toContain('Send to PC');
    expect(disabledCount(html)).toBe(0);
    expect(html).toContain('Your PC will still ask before it runs.');
  });
  it('is disabled with the offline hint', () => {
    const html = renderToStaticMarkup(<PcRunForm {...base} blocked="Your PC is offline. Start the Toki helper on it." />);
    expect(html).toContain('Your PC is offline');
    expect(disabledCount(html)).toBe(2); // textarea and button
    expect(html).toContain('aria-describedby');
  });
  it('is disabled with the sign-in hint', () => {
    const html = renderToStaticMarkup(<PcRunForm {...base} blocked="Sign in with your password to run things on your PC." />);
    expect(html).toContain('Sign in with your password');
    expect(disabledCount(html)).toBe(2);
  });
  it('keeps send disabled for an empty prompt', () => {
    expect(disabledCount(renderToStaticMarkup(<PcRunForm {...base} prompt="  " />))).toBe(1);
  });
  it('shows the job status and a log link', () => {
    const job = { id: 'j1', status: 'running' } as PcJobView;
    const html = renderToStaticMarkup(<PcRunForm {...base} job={job} onOpenLog={() => undefined} />);
    expect(html).toContain('Running');
    expect(html).toContain('Open job log');
  });
});

describe('Run on PC folder picker', () => {
  it('lists the allowed folders', () => {
    const html = renderToStaticMarkup(<PcRunForm {...base} submitLabel="Run on PC" folders={['site', 'hub']} folder="hub" onFolder={() => undefined} />);
    expect(html).toContain('<option value="site"');
    expect(html).toContain('<option value="hub" selected');
    expect(disabledCount(html)).toBe(0);
  });
  it('explains when the PC has reported no folders', () => {
    const html = renderToStaticMarkup(<PcRunForm {...base} folders={[]} folder="" />);
    expect(html).toContain('not reported any allowed folders');
    expect(disabledCount(html)).toBeGreaterThanOrEqual(2);
  });
});
