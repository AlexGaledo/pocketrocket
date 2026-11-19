import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot, FailoverCard, ProvidersResponse, Room } from '@pocketrocket/shared';

// Server rendering reads a Zustand store's initial state, so the card's store is a plain object the test fills in.
let state: Record<string, unknown> = {};
vi.mock('../store', () => ({
  useStore: (sel: (s: Record<string, unknown>) => unknown) => sel(state),
  botById: (bots: Bot[], id: string | null) => bots.find((b) => b.id === id),
}));

let FailoverCardView: typeof import('./FailoverCard').FailoverCardView;
beforeAll(async () => {
  ({ FailoverCardView } = await import('./FailoverCard'));
}, 60000);

const HOUR = 3_600_000;
const providers = {
  active: 'claude',
  providers: [
    { id: 'claude', label: 'Claude', models: [] },
    { id: 'gemini', label: 'Gemini', models: [{ id: 'gemini-3-pro', label: 'Gemini 3 Pro' }] },
  ],
} as unknown as ProvidersResponse;
const card = (over: Partial<FailoverCard> = {}): FailoverCard => ({
  id: 'c1', botId: 'b1', roomId: 'r1', provider: 'claude', window: 'five_hour', backup: { provider: 'gemini', model: 'gemini-3-pro' },
  resetsAt: Date.now() + 2 * HOUR, expiresAt: Date.now() + 2 * HOUR, createdAt: Date.now(), status: 'pending', ...over,
});
const setup = (botOver: Partial<Bot> = {}) => {
  state = {
    bots: [{ id: 'b1', name: 'Ada', handle: 'ada', backup: { provider: 'gemini', model: 'gemini-3-pro' }, ...botOver } as Bot],
    rooms: [{ id: 'r1', memberIds: ['b1'] } as Room],
    providers,
    limits: [],
    dropFailoverCard: () => undefined,
    fetchFailover: async () => undefined,
  };
};

describe('FailoverCardView', () => {
  it('asks with the warn-soft ring, the Gauge icon, Continue and Wait', () => {
    setup();
    const h = renderToStaticMarkup(<FailoverCardView card={card()} />);
    expect(h).toContain('ring-warn/40');
    expect(h).toContain('lucide-gauge');
    expect(h).toContain('Ada hit Claude&#x27;s 5-hour limit.');
    expect(h).toContain('Continue on Gemini');
    expect(h).toMatch(/Wait until \d/);
    expect(h).toContain('with approvals on');
  });

  it('never offers Continue when the hub would refuse it, and says why', () => {
    setup({ backup: null });
    const h = renderToStaticMarkup(<FailoverCardView card={card()} />);
    expect(h).not.toContain('Continue on Gemini');
    expect(h).toContain('backup changed');
    expect(h).toMatch(/Wait until/);
  });

  it('turns quiet once it expires: no buttons, the reset time in words', () => {
    setup();
    const h = renderToStaticMarkup(<FailoverCardView card={card({ expiresAt: Date.now() - 1, resetsAt: Date.now() - 1 })} />);
    expect(h).toContain('ring-line');
    expect(h).not.toContain('ring-warn');
    expect(h).not.toContain('<button');
    expect(h).toContain('Not continued. Claude resets at');
  });

  it('says "Wait for the reset" when the provider gave no reset time', () => {
    setup();
    const h = renderToStaticMarkup(<FailoverCardView card={card({ resetsAt: undefined })} />);
    expect(h).toContain('Wait for the reset');
    expect(h).not.toContain('It resets at');
  });
});
