import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot, ProjectOverview, Room } from '@pocketrocket/shared';
import type { InboxItem } from '../lib/inbox';
import type { ProjectInfo } from '../lib/api';

// Server rendering reads a Zustand store's initial state, so the header's store is a plain object the test fills in.
let state: Record<string, unknown> = {};
let overview: ProjectOverview | null | undefined;
let inbox: InboxItem[] = [];
let wide = true;
vi.mock('../store', () => ({
  useStore: (sel: (s: Record<string, unknown>) => unknown) => sel(state),
  botById: (bots: Bot[], id: string | null) => bots.find((b) => b.id === id),
}));
let drawing: { bot: Bot | null; phase: 'sent' | 'done' | null; running: boolean } = { bot: null, phase: null, running: false };
vi.mock('../lib/useProject', () => ({ useOverview: () => overview, useMapDrawing: () => drawing }));
vi.mock('../lib/useInbox', () => ({ useInbox: () => inbox }));
vi.mock('../lib/useMediaQuery', () => ({ useMediaQuery: () => wide }));
vi.mock('../lib/botStatus', async (orig) => ({ ...(await orig<typeof import('../lib/botStatus')>()), useBotStatus: () => ({ statusOf: () => 'idle', needsYouRoom: () => null }) }));

let ProjectHeader: typeof import('./ProjectHeader').ProjectHeader;
beforeAll(async () => {
  ({ ProjectHeader } = await import('./ProjectHeader'));
}, 60000);

const bots = [{ id: 'b1', name: 'Lead', handle: 'lead', avatar: '🦊' }, { id: 'b2', name: 'Eng', handle: 'eng', avatar: '🐙' }] as Bot[];
const room = { id: 'r1', kind: 'group', name: 'toki', memberIds: ['b1', 'b2'], coordinatorBotId: 'b1' } as Room;
const project = { slug: 'toki', name: 'Toki', dir: 'x', memberIds: ['b1', 'b2'], roomId: 'r1', templateVersion: 2, createdAt: 0 } as ProjectInfo;
const setup = (over: Record<string, unknown> = {}) => {
  state = {
    page: null, device: false, bots, control: {}, queues: {}, failover: { active: [], cards: [] }, providers: null,
    panelOpen: true, panelKind: 'overview', botStates: {}, messages: {}, openApprovals: [], computers: {}, rooms: [room], activeRoomId: 'r1', panelBotId: null,
    openPage: () => undefined, closePage: () => undefined, openDialog: () => undefined, openOverview: () => undefined,
    openFiles: () => undefined, openScreen: () => undefined, closePanel: () => undefined,
    ...over,
  };
};
const render = () => renderToStaticMarkup(<ProjectHeader project={project} room={room} />);

describe('ProjectHeader', () => {
  it('shows the project, its plan and the Chat | Map tabs', () => {
    setup();
    overview = { updated: null, plan: { done: 3, total: 8, stage: 'Build' }, next: null, done: [], waiting: [] };
    const html = render();
    expect(html).toContain('>Toki</h1>');
    expect(html).toContain('aria-label="Build, 3 of 8 done"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Chat</);
    expect(html).toContain('aria-controls="project-panel-map"');
  });

  it('says No plan yet without a plan, and nothing while loading', () => {
    setup();
    overview = null;
    expect(render()).toContain('No plan yet');
    overview = undefined;
    expect(render()).not.toContain('No plan yet');
  });

  it('selects Map while the map page is open', () => {
    setup({ page: { kind: 'map', slug: 'toki' } });
    expect(render()).toMatch(/aria-selected="true"[^>]*>Map</);
  });

  it('keeps the room line: # room, faces, badges, then group details, Files and Screen in that order', () => {
    setup();
    const html = render();
    expect(html).toContain('coordinator @lead');
    const order = ['>toki</button>', 'Open Lead&#x27;s page', 'aria-label="Group details"', 'aria-label="Files"', 'aria-label="Screen"'].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('offers Needs you with a count only where the overview is not on screen', () => {
    setup();
    inbox = [{ key: 'approval:a', kind: 'approval', botId: 'b1', roomId: 'r1', title: 'x', detail: null, since: null }];
    expect(render()).not.toContain('Needs you');
    wide = false;
    setup({ panelOpen: false });
    const html = render();
    expect(html).toContain('aria-label="Needs you, 1"');
    wide = true;
    inbox = [];
  });

  it('hides room editing on a paired phone', () => {
    setup({ device: true });
    expect(render()).not.toContain('Group details');
  });

  it('shows a map chip in the room line only while the asked bot is drawing', () => {
    setup();
    expect(render()).not.toContain('is drawing the map');
    drawing = { bot: bots[0], phase: 'sent', running: true };
    expect(render()).toContain('aria-label="@lead is drawing the map. Open the map"');
    drawing = { bot: bots[0], phase: 'sent', running: false };
    expect(render()).not.toContain('is drawing the map');
    drawing = { bot: null, phase: null, running: false };
  });
});
