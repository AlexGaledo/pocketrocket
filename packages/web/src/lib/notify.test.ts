import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let invoke: ReturnType<typeof vi.fn>;
async function boot(granted: boolean) {
  vi.resetModules();
  invoke = vi.fn(async (cmd: string) => (cmd.endsWith('is_permission_granted') ? granted : undefined));
  vi.stubGlobal('window', { __TAURI__: { core: { invoke } } });
  vi.stubGlobal('document', { hasFocus: () => false });
  return import('./notify');
}
const raised = () => invoke.mock.calls.filter((c) => String(c[0]).endsWith('|notify')).length;
beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe('notify coalescing', () => {
  it('coalesces repeats of one kind in a room but not different kinds', async () => {
    const { notify } = await boot(true);
    expect(await notify({ roomId: 'r', kind: 'turn' })).toBe(true);
    expect(await notify({ roomId: 'r', kind: 'turn' })).toBe(false);
    expect(await notify({ roomId: 'r', kind: 'approval' })).toBe(true);
    expect(raised()).toBe(2);
  });

  it('does not start the window when permission is denied', async () => {
    const { notify } = await boot(false);
    expect(await notify({ roomId: 'r', kind: 'approval' })).toBe(false);
    invoke.mockImplementation(async (cmd: string) => (cmd.endsWith('is_permission_granted') ? true : undefined));
    expect(await notify({ roomId: 'r', kind: 'approval' })).toBe(true);
  });
});
