import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { CredentialStore } from '../services/CredentialStore.js';
import { fillActivePage } from '../services/browserFill.js';
import type { CdpConnection } from '../services/cdpClient.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { credentialTools } from './credentialTools.js';
import { events } from '../events.js';
import { listAudit } from '../services/AuditLog.js';
import { clearSecrets } from '../providers/redact.js';

const SECRET = 'correct-horse-BATTERY-staple-9';
const SITE = 'https://github.com';

interface FakePage { url: string; origin: string; visible: boolean; hasPassword?: boolean }

/** A browser as the CDP client sees it. `written` is what the page ended up holding; `log` is every command sent. */
function fakeBrowser(pages: FakePage[], onWrite?: () => void) {
  const written: string[] = [];
  const log: string[] = [];
  const conn: CdpConnection = {
    async send(method, params = {}, sessionId) {
      log.push(JSON.stringify({ method, params: method === 'Runtime.callFunctionOn' ? { ...params, arguments: '[hidden]' } : params }));
      const page = sessionId ? pages[Number(sessionId.slice(1))] : undefined;
      if (method === 'Target.getTargets') return { targetInfos: pages.map((p, i) => ({ targetId: 't' + i, type: 'page', url: p.url })) };
      if (method === 'Target.attachToTarget') return { sessionId: 's' + String(params.targetId).slice(1) };
      if (method === 'Runtime.evaluate') {
        const e = String(params.expression);
        if (e === 'document.visibilityState') return { result: { value: page!.visible ? 'visible' : 'hidden' } };
        if (e === 'location.origin') return { result: { value: page!.origin } };
        return page!.hasPassword === false ? { result: { subtype: 'null' } } : { result: { subtype: 'node', objectId: 'o1' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        const [exp, , value] = (params.arguments as { value: string }[]).map((a) => a.value);
        onWrite?.();
        if (page!.origin !== exp) return { result: { value: 'origin' } };
        written.push(value);
        return { result: { value: 'filled' } };
      }
      throw new Error('unexpected ' + method);
    },
    onEvent() {}, onClose() {}, close() {},
  };
  return { conn, written, log };
}

describe('fillActivePage', () => {
  const run = (b: ReturnType<typeof fakeBrowser>, origin = SITE, field: 'password' | 'username' = 'password') =>
    fillActivePage({ cdpUrl: 'http://127.0.0.1:1', origin, field, secret: SECRET, connect: async () => b.conn });

  it('fills the front tab on the exact origin', async () => {
    const b = fakeBrowser([{ url: SITE + '/login', origin: SITE, visible: true }]);
    expect(await run(b)).toEqual({ ok: true });
    expect(b.written).toEqual([SECRET]);
    expect(b.log.join('\n')).not.toContain(SECRET);
  });

  it.each([
    ['another site', 'https://evil.example', 'https://evil.example/login'],
    ['a look-alike host', 'https://github.com.evil.example', 'https://github.com.evil.example/'],
    ['a subdomain', 'https://gist.github.com', 'https://gist.github.com/'],
    ['plain http', 'http://github.com', 'http://github.com/'],
    ['another port', 'https://github.com:8443', 'https://github.com:8443/'],
    ['an opaque page', 'null', 'about:blank'],
  ])('refuses %s and writes nothing', async (_n, origin, url) => {
    const b = fakeBrowser([{ url, origin, visible: true }]);
    const r = await run(b);
    expect(r).toMatchObject({ ok: false, reason: 'origin' });
    expect(b.written).toEqual([]);
  });

  it('judges the page it ended up on after a redirect, not the one it started on', async () => {
    const page: FakePage = { url: SITE + '/login', origin: SITE, visible: true };
    const b = fakeBrowser([page]);
    page.url = 'https://evil.example/phish';
    page.origin = 'https://evil.example';
    expect(await run(b)).toMatchObject({ ok: false, reason: 'origin' });
    expect(b.written).toEqual([]);
  });

  it('refuses when the tab URL and the page origin disagree', async () => {
    const b = fakeBrowser([{ url: 'https://evil.example/', origin: SITE, visible: true }]);
    expect(await run(b)).toMatchObject({ ok: false, reason: 'origin' });
  });

  it('refuses when the origin changes between the check and the write (atomic check in the page)', async () => {
    const page: FakePage = { url: SITE + '/', origin: SITE, visible: true };
    const b = fakeBrowser([page], () => { page.origin = 'https://evil.example'; });
    expect(await run(b)).toMatchObject({ ok: false, reason: 'origin' });
    expect(b.written).toEqual([]);
  });

  it('is not fooled by a background tab on the right site', async () => {
    const b = fakeBrowser([
      { url: SITE + '/', origin: SITE, visible: false },
      { url: 'https://evil.example/', origin: 'https://evil.example', visible: true },
    ]);
    expect(await run(b)).toMatchObject({ ok: false, reason: 'origin' });
    expect(b.written).toEqual([]);
  });

  it('refuses two front tabs, no page and no field', async () => {
    expect(await run(fakeBrowser([{ url: SITE, origin: SITE, visible: true }, { url: SITE, origin: SITE, visible: true }]))).toMatchObject({ reason: 'ambiguous' });
    expect(await run(fakeBrowser([]))).toMatchObject({ reason: 'no_page' });
    expect(await run(fakeBrowser([{ url: SITE, origin: SITE, visible: true, hasPassword: false }]))).toMatchObject({ reason: 'no_field' });
  });

  it('says unreachable when the browser cannot be reached', async () => {
    const r = await fillActivePage({ cdpUrl: 'http://127.0.0.1:1', origin: SITE, field: 'password', secret: SECRET, connect: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('fill_credential tool', () => {
  let dir: string;
  let db: Db;
  let store: CredentialStore;
  beforeEach(() => {
    clearSecrets();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-fillcred-'));
    db = new Db(':memory:');
    store = new CredentialStore(db, { file: path.join(dir, 'credentials.json'), keyFile: path.join(dir, 'vault.key') });
    store.create({ name: 'github', origin: SITE, username: 'alex', secret: SECRET });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  type Confirm = (a: unknown) => Promise<{ allowed: boolean; message: string }>;
  function tool(page: FakePage, confirm?: Confirm) {
    const b = fakeBrowser([page]);
    const asked: unknown[] = [];
    const t = credentialTools({
      store, db, bot: { id: 'bot1' }, roomId: 'room1', cdpUrl: 'http://x',
      confirm: async (a) => { asked.push(a); return confirm ? confirm(a) : { allowed: true, message: 'Approved by the user.' }; },
      fill: (r) => fillActivePage({ ...r, connect: async () => b.conn }),
    })[0];
    return { t, b, asked };
  }
  const out = (r: unknown) => JSON.stringify(r);

  it('fills, answers only "filled", and the secret is in no output, card input or audit line', async () => {
    const { t, b, asked } = tool({ url: SITE + '/login', origin: SITE, visible: true });
    const r = await t.handler({ name: 'github' });
    expect(r).toEqual({ content: [{ type: 'text', text: 'filled' }] });
    expect(b.written).toEqual([SECRET]);
    for (const s of [out(r), JSON.stringify(asked), JSON.stringify(listAudit(db, { limit: 20 })), t.description]) expect(s).not.toContain(SECRET);
    expect(asked).toEqual([{ credential: 'github', site: SITE, field: 'password', page: SITE }]);
    expect(store.get(store.byName('github')!.id)!.lastUsedAt).not.toBeNull();
  });

  it('refuses on another origin without asking the owner and without a write', async () => {
    const { t, b, asked } = tool({ url: 'https://evil.example/', origin: 'https://evil.example', visible: true });
    const r = await t.handler({ name: 'github' });
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('Do not retry it');
    expect(out(r)).not.toContain(SECRET);
    expect(asked).toEqual([]);
    expect(b.written).toEqual([]);
  });

  it('refuses when the page moves to another site while the card is open', async () => {
    const page: FakePage = { url: SITE + '/', origin: SITE, visible: true };
    const { t, b } = tool(page, async () => { page.url = 'https://evil.example/'; page.origin = 'https://evil.example'; return { allowed: true, message: 'ok' }; });
    const r = await t.handler({ name: 'github' });
    expect(r.isError).toBe(true);
    expect(b.written).toEqual([]);
  });

  it('writes nothing when the owner declines, and passes the refusal through', async () => {
    const { t, b } = tool({ url: SITE, origin: SITE, visible: true }, async () => ({ allowed: false, message: 'The user declined this sign-in. Do not retry it; x.' }));
    const r = await t.handler({ name: 'github' });
    expect(r.isError).toBe(true);
    expect(b.written).toEqual([]);
  });

  it('fails closed with no way to ask, and for an unknown login', async () => {
    const b = fakeBrowser([{ url: SITE, origin: SITE, visible: true }]);
    const t = credentialTools({ store, db, bot: { id: 'b' }, roomId: 'r', cdpUrl: 'x', fill: (r) => fillActivePage({ ...r, connect: async () => b.conn }) })[0];
    expect((await t.handler({ name: 'github' })).isError).toBe(true);
    expect(b.written).toEqual([]);
    const { t: t2 } = tool({ url: SITE, origin: SITE, visible: true });
    const r = await t2.handler({ name: 'nope' });
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('github');
    expect(out(r)).not.toContain(SECRET);
  });
});

describe('askCredentialFill (the card)', () => {
  const signal = new AbortController().signal;
  function setup(bypass: boolean) {
    const db = new Db(':memory:');
    const repos = new Repos(db);
    const broker = new PermissionBroker(repos, { store: new ApprovalStore(db), bypass: () => bypass });
    const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    return { db, broker, ctx: { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined } };
  }
  const input = { credential: 'github', site: SITE, field: 'password', page: SITE };

  it('asks under bypass, offers no "for this session", and only a signed-in browser can allow it', async () => {
    const s = setup(true);
    const cards: ApprovalPayload[] = [];
    const answers: boolean[] = [];
    const off = events.onEvent((ev) => {
      if (ev.type !== 'approval.request') return;
      cards.push(ev.approval);
      setTimeout(() => {
        answers.push(s.broker.resolve(ev.approval.approvalId, 'allow', { signedIn: false }));
        answers.push(s.broker.resolve(ev.approval.approvalId, 'always', { signedIn: true }));
      }, 0);
    });
    const r = await s.broker.askCredentialFill(s.ctx, input, signal);
    off();
    expect(r.allowed).toBe(true);
    expect(answers).toEqual([false, true]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ toolName: 'fill_credential', signInRequired: true, once: true });
    expect(JSON.stringify(cards)).not.toContain(SECRET);
    // "Always" counted as one allow: no rule was stored, so the next call asks again.
    expect(s.broker.matchPolicy(s.ctx.bot.id, 'fill_credential', '*')).toBeNull();
  });

  it('refuses with the three-part wording when declined', async () => {
    const s = setup(false);
    const off = events.onEvent((ev) => { if (ev.type === 'approval.request') setTimeout(() => s.broker.resolve(ev.approval.approvalId, 'deny'), 0); });
    const r = await s.broker.askCredentialFill(s.ctx, input, signal);
    off();
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/declined/);
    expect(r.message).toContain('Do not retry it');
  });
});
