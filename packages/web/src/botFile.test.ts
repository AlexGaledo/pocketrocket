import { describe, expect, it, vi } from 'vitest';
import { BotExportSchema, type ServerEvent, type Task } from '@pocketrocket/shared';

const good = {
  format: 'pocketrocket.bot', version: 1,
  bot: { name: 'Ada', handle: 'ada', title: '', description: 'Helps.', avatar: 'rocket' },
  skills: [{ name: 'notes', description: 'Take notes', markdown: 'Body' }],
};

describe('the bot file check the import dialog runs before it asks the hub', () => {
  it('accepts a good file', () => {
    expect(BotExportSchema.safeParse(good).success).toBe(true);
  });
  it('refuses unknown fields anywhere, including settings a file might try to carry', () => {
    expect(BotExportSchema.safeParse({ ...good, secrets: {} }).success).toBe(false);
    expect(BotExportSchema.safeParse({ ...good, bot: { ...good.bot, allowedTools: ['Bash'] } }).success).toBe(false);
    expect(BotExportSchema.safeParse({ ...good, skills: [{ ...good.skills[0], approved: true }] }).success).toBe(false);
  });
  it('refuses a picture reference and other versions', () => {
    expect(BotExportSchema.safeParse({ ...good, bot: { ...good.bot, avatar: 'img:' + 'a'.repeat(64) } }).success).toBe(false);
    expect(BotExportSchema.safeParse({ ...good, version: 2 }).success).toBe(false);
  });
});

describe('task.changed', () => {
  it('bumps only that room so an open board refetches', async () => {
    vi.resetModules();
    vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('document', { hasFocus: () => true });
    const { useStore } = await import('./store');
    const ev = { type: 'task.changed', roomId: 'r1', task: { id: 't' } as Task } as ServerEvent;
    useStore.getState().applyEvent(ev);
    useStore.getState().applyEvent(ev);
    expect(useStore.getState().tasksRev).toEqual({ r1: 2 });
  });
});
