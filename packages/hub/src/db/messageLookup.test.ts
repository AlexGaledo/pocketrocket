import { describe, expect, it } from 'vitest';
import { Db } from './db.js';
import { Repos } from './repos.js';

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'A', handle: 'aa', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const other = repos.createBot({ name: 'B', handle: 'bb', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const room = repos.createRoom({ kind: 'dm', name: 'Chat', memberIds: [bot.id], coordinatorBotId: null });
  const say = (authorType: 'user' | 'bot', authorId: string | null, text: string, kind: 'text' | 'tool' = 'text') =>
    repos.insertMessage({ roomId: room.id, authorType, authorId, kind, text, payload: null, causeId: null, hop: 0, turnId: null });
  return { repos, bot, other, room, say };
}

describe('botPreviews', () => {
  it("gives each bot's latest text and skips tool calls", () => {
    const { repos, bot, say } = setup();
    say('bot', bot.id, 'first');
    say('bot', bot.id, 'second');
    say('bot', bot.id, 'Bash', 'tool');
    expect(repos.botPreviews()[bot.id].text).toBe('second');
  });

  it('leaves out a bot that has said nothing', () => {
    const { repos, other } = setup();
    expect(repos.botPreviews()[other.id]).toBeUndefined();
  });

  it('keeps a long message short', () => {
    const { repos, bot, say } = setup();
    say('bot', bot.id, 'x'.repeat(5000));
    expect(repos.botPreviews()[bot.id].text.length).toBeLessThanOrEqual(200);
  });
});

describe('searchMessages', () => {
  it('finds text in any case, newest first, with where it was', () => {
    const { repos, bot, room, say } = setup();
    const older = say('user', null, 'the Workflow is ready');
    const newer = say('bot', bot.id, 'I loaded the workflow');
    const hits = repos.searchMessages('WORKFLOW', 10);
    expect(hits.map((h) => h.id)).toEqual([newer.id, older.id]);
    expect(hits[0]).toMatchObject({ roomId: room.id, roomName: 'Chat', seq: newer.seq });
  });

  it('skips tool calls and treats wildcards as plain text', () => {
    const { repos, say } = setup();
    say('user', null, 'plain words');
    say('user', null, '100% done');
    expect(repos.searchMessages('%', 10).map((h) => h.snippet)).toEqual(['100% done']);
    say('bot', null, 'needle', 'tool');
    expect(repos.searchMessages('needle', 10)).toEqual([]);
  });

  it('cuts a snippet around the match', () => {
    const { repos, say } = setup();
    say('user', null, 'a'.repeat(500) + ' needle ' + 'b'.repeat(500));
    const { snippet } = repos.searchMessages('needle', 10)[0];
    expect(snippet).toContain('needle');
    expect(snippet.length).toBeLessThan(200);
  });
});
