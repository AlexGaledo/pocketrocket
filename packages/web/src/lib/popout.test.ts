import { describe, expect, it } from 'vitest';
import { parsePopout } from './popout';

describe('parsePopout', () => {
  it('reads the query and the hash route', () => {
    expect(parsePopout('?desktop=1&popout=bot_1', '')).toEqual({ botId: 'bot_1', roomId: null });
    expect(parsePopout('?popout=b&room=r-2', '')).toEqual({ botId: 'b', roomId: 'r-2' });
    expect(parsePopout('', '#/popout/abc-9')).toEqual({ botId: 'abc-9', roomId: null });
  });
  it('rejects anything but a plain id', () => {
    expect(parsePopout('?popout=../x', '')).toBeNull();
    expect(parsePopout('?popout=a b', '')).toBeNull();
    expect(parsePopout('?popout=', '')).toBeNull();
    expect(parsePopout('', '#/popout/a%20b')).toBeNull();
    expect(parsePopout('', '#/popout/%E0%A4%A')).toBeNull();
    expect(parsePopout('?popout=b&room=../x', '')).toEqual({ botId: 'b', roomId: null });
    expect(parsePopout('', '')).toBeNull();
  });
});
