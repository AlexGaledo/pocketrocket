import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../agent/PromptBuilder.js';
import { Db } from './db.js';
import { Repos } from './repos.js';
import { MIGRATIONS } from './migrations.js';

const fresh = () => new Repos(new Db(':memory:'));

describe('owner identity', () => {
  it('keeps the same id through a rename and remembers the old name', () => {
    const r = fresh();
    const id = r.owner().id;
    r.renameOwner('Alex');
    const after = r.renameOwner('Shiroo');
    expect(after).toMatchObject({ id, role: 'owner', displayName: 'Shiroo', previousNames: ['Alex'] });
  });

  it('does not list the current name as a previous one when a name comes back', () => {
    const r = fresh();
    r.renameOwner('Alex');
    r.renameOwner('Shiroo');
    expect(r.renameOwner('Alex')).toMatchObject({ displayName: 'Alex', previousNames: ['Shiroo'] });
  });

  it('migration 112 gives existing human messages the owner id and leaves others alone', () => {
    const m = MIGRATIONS.find((x) => x.version === 112);
    expect(m).toBeDefined();
    const r = fresh();
    const room = r.createRoom({ kind: 'group', name: 'r', memberIds: [], coordinatorBotId: null });
    const user = r.insertMessage({ roomId: room.id, authorType: 'user', authorId: null, kind: 'text', text: 'old', payload: null, causeId: null, hop: 0, turnId: null });
    const sys = r.insertMessage({ roomId: room.id, authorType: 'system', authorId: null, kind: 'system', text: 's', payload: null, causeId: null, hop: 0, turnId: null });
    r.db.run('DROP TABLE users');
    m!.up(r.db.raw);
    const owner = r.owner();
    const read = (id: string) => r.listMessages(room.id, { limit: 10 }).find((x) => x.id === id)!;
    expect(read(user.id).authorId).toBe(owner.id);
    expect(read(sys.id).authorId).toBeNull();
  });
});

describe('prompt', () => {
  const base = {
    bot: { id: 'b', name: 'B', handle: 'b' }, room: { id: 'r', kind: 'group', name: 'R' }, members: [], hop: 0, memory: '', identity: '',
  } as unknown as Parameters<typeof buildSystemPrompt>[0];

  it('says the tag is the owner, with the id and earlier names', () => {
    const p = buildSystemPrompt({ ...base, owner: { id: 'u1', previousNames: ['Alex'] } });
    expect(p).toContain('user id u1');
    expect(p).toContain('earlier names: Alex');
    expect(p).toContain('a message with that tag is from the owner');
  });
});
