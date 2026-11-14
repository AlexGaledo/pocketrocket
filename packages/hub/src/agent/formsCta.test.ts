import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bot, CtaPayload, FormPayload, Room } from '@pocketrocket/shared';
import { ClientEventSchema, HUB_TOOLS, SILENT_TOOLS, MAX_FORM_FIELDS, buildCta, buildForm, cleanText, safeHref, validateAnswers } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { FormBroker } from '../services/FormBroker.js';
import { createHubTools, type ToolCtx } from './botTools.js';

function setup(timeoutMs?: number, signal?: AbortSignal) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const forms = new FormBroker(repos, timeoutMs);
  const ctx: ToolCtx = {
    bot, room: room as Room, members: [bot as Bot], turnId: 't1', hop: 0, causeId: 'c1',
    repos, memory: new MemoryService(), skills: new SkillService(repos),
    dispatchFromBot: () => [], setState: () => undefined, models: [], forms, signal,
  };
  const tools = createHubTools(ctx);
  const call = async (name: string, input: unknown) => {
    const r = await tools.find((t) => t.name === name)!.handler(input as Record<string, unknown>);
    return { text: (r.content[0] as { text: string }).text, isError: !!r.isError };
  };
  const pendingForm = () => repos.listMessages(room.id).find((m) => m.kind === 'form')!;
  return { repos, bot, room, forms, call, pendingForm };
}

const ask = { title: 'Site details', fields: [
  { id: 'domain', type: 'text', label: 'Domain' },
  { id: 'plan', type: 'choice', label: 'Plan', choices: ['free', 'pro'] },
  { id: 'live', type: 'yesno', label: 'Go live now?', required: false },
] };

describe('registry', () => {
  it('lists request_form as silent: it changes nothing and the owner answers in the chat', () => {
    expect(HUB_TOOLS.request_form).toBe('silent');
    expect(SILENT_TOOLS.has('request_form')).toBe(true);
  });
});

describe('request_form caps and injection', () => {
  it('refuses more than 8 fields', () => {
    const fields = Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => ({ id: 'f' + i, type: 'yesno', label: 'L' + i }));
    expect(buildForm({ title: 't', fields }).ok).toBe(false);
  });
  it('refuses too-long labels, titles and bad field kinds', () => {
    expect(buildForm({ title: 'x'.repeat(81), fields: [{ id: 'a', type: 'text', label: 'A' }] }).ok).toBe(false);
    expect(buildForm({ title: 't', fields: [{ id: 'a', type: 'text', label: 'x'.repeat(81) }] }).ok).toBe(false);
    expect(buildForm({ title: 't', fields: [{ id: 'a', type: 'password', label: 'A' }] }).ok).toBe(false);
    expect(buildForm({ title: 't', fields: [{ id: 'a', type: 'text', label: 'A', max_length: 501 }] }).ok).toBe(false);
    expect(buildForm({ title: 't', fields: [{ id: 'a', type: 'text', label: 'A' }, { id: 'a', type: 'text', label: 'B' }] }).ok).toBe(false);
  });
  it('refuses forms that ask for secrets', () => {
    for (const label of ['Password', 'Your API key', 'GitHub token', 'Seed phrase', '2FA code', 'Credit card number']) {
      const r = buildForm({ title: 't', fields: [{ id: 'a', type: 'text', label }] });
      expect(r.ok, label).toBe(false);
    }
    expect(buildForm({ title: 'Enter your login password', fields: [{ id: 'a', type: 'text', label: 'Name' }] }).ok).toBe(false);
  });
  it('keeps markup as inert text and strips hidden characters', () => {
    const r = buildForm({ title: '<img src=x onerror=alert(1)>‮evil', fields: [{ id: 'a', type: 'text', label: 'Na​me\u0007' }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe('<img src=x onerror=alert(1)>evil');
      expect(r.value.fields[0].label).toBe('Name');
    }
    expect(cleanText('a\u0000b\nc', 20)).toBe('a b c');
  });
  it('checks answers against the stored fields', () => {
    const f = buildForm(ask);
    if (!f.ok) throw new Error(f.error);
    const fields = f.value.fields;
    expect(validateAnswers(fields, { domain: 'a.com', plan: 'pro' }).ok).toBe(true);
    expect(validateAnswers(fields, { plan: 'pro' }).ok).toBe(false); // required missing
    expect(validateAnswers(fields, { domain: 'a.com', plan: 'gold' }).ok).toBe(false); // not a choice
    expect(validateAnswers(fields, { domain: 'a.com', plan: 'pro', extra: 'x' }).ok).toBe(false); // unknown id
    expect(validateAnswers(fields, { domain: 'a.com', plan: 'pro', live: 'yes' }).ok).toBe(false); // wrong type
    expect(validateAnswers(fields, { domain: 'x'.repeat(201), plan: 'pro' }).ok).toBe(false); // over the cap
  });
  it('the wire schema caps the number of answers', () => {
    const answers = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['k' + i, 'v']));
    expect(ClientEventSchema.safeParse({ type: 'form.submit', formId: 'm', answers }).success).toBe(false);
    expect(ClientEventSchema.safeParse({ type: 'form.submit', formId: 'm', answers: { a: 'v', b: true } }).success).toBe(true);
  });
});

describe('request_form flow', () => {
  afterEach(() => vi.useRealTimers());

  it('posts a card, returns the answers as the tool result and records them on the card', async () => {
    const s = setup();
    const run = s.call('request_form', ask);
    await vi.waitFor(() => expect(s.pendingForm()).toBeTruthy());
    const card = s.pendingForm();
    expect((card.payload as FormPayload).status).toBe('pending');
    expect(s.forms.submit(card.id, { domain: 'a.com', plan: 'pro', live: true })).toBeNull();
    const r = await run;
    expect(r.isError).toBe(false);
    expect(r.text).toContain('{"domain":"a.com","plan":"pro","live":true}');
    expect((s.pendingForm().payload as FormPayload)).toMatchObject({ status: 'submitted', answers: { domain: 'a.com' } });
    expect(s.forms.submit(card.id, { domain: 'b.com', plan: 'pro' })).toMatch(/no longer waiting/);
  });

  it('a bad answer is refused and the card stays open', async () => {
    const s = setup();
    const run = s.call('request_form', ask);
    await vi.waitFor(() => expect(s.pendingForm()).toBeTruthy());
    const id = s.pendingForm().id;
    expect(s.forms.submit(id, { domain: 'a.com', plan: 'gold' })).toMatch(/not one of the choices/);
    expect((s.pendingForm().payload as FormPayload).status).toBe('pending');
    s.forms.cancel(id);
    await run;
  });

  it('refuses a pasted secret in an answer', async () => {
    const s = setup();
    const run = s.call('request_form', ask);
    await vi.waitFor(() => expect(s.pendingForm()).toBeTruthy());
    const id = s.pendingForm().id;
    expect(s.forms.submit(id, { domain: 'sk-ant-api03-' + 'a'.repeat(40), plan: 'pro' })).toMatch(/secret/);
    s.forms.cancel(id);
    await run;
  });

  it('cancel uses the declined wording', async () => {
    const s = setup();
    const run = s.call('request_form', ask);
    await vi.waitFor(() => expect(s.pendingForm()).toBeTruthy());
    expect(s.forms.cancel(s.pendingForm().id)).toBe(true);
    const r = await run;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^The user declined this form\./);
    expect(r.text).toContain('Do not retry it');
    expect((s.pendingForm().payload as FormPayload).status).toBe('cancelled');
  });

  it('timeout uses the timeout wording', async () => {
    const s = setup(20);
    const r = await s.call('request_form', ask);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^No response from the user within 10 minutes/);
    expect((s.pendingForm().payload as FormPayload).status).toBe('timeout');
  });

  it('an interrupted turn closes the card', async () => {
    const ac = new AbortController();
    const s = setup(undefined, ac.signal);
    const run = s.call('request_form', ask);
    await vi.waitFor(() => expect(s.pendingForm()).toBeTruthy());
    ac.abort();
    expect((await run).isError).toBe(true);
    expect((s.pendingForm().payload as FormPayload).status).toBe('expired');
  });

  it('allows one open form per bot', async () => {
    const s = setup();
    const first = s.call('request_form', ask);
    await vi.waitFor(() => expect(s.pendingForm()).toBeTruthy());
    const second = await s.call('request_form', ask);
    expect(second.isError).toBe(true);
    s.forms.cancel(s.pendingForm().id);
    await first;
  });

  it('a form left pending by a restart is expired', async () => {
    const s = setup();
    const run = s.call('request_form', ask);
    await vi.waitFor(() => expect(s.pendingForm()).toBeTruthy());
    const changed = s.repos.expirePendingApprovals();
    expect(changed.some((m) => m.kind === 'form' && (m.payload as FormPayload).status === 'expired')).toBe(true);
    s.forms.cancel(s.pendingForm().id);
    await run;
  });
});

describe('cta', () => {
  it('accepts up to 3 buttons and refuses a 4th', () => {
    const b = { label: 'Yes', say: 'yes please' };
    expect(buildCta([b, b, b]).ok).toBe(true);
    expect(buildCta([b, b, b, b]).ok).toBe(false);
    expect(buildCta([]).ok).toBe(false);
  });
  it('needs exactly one of say or href, and caps lengths', () => {
    expect(buildCta([{ label: 'x', say: 'a', href: 'https://a.com' }]).ok).toBe(false);
    expect(buildCta([{ label: 'x' }]).ok).toBe(false);
    expect(buildCta([{ label: 'x'.repeat(41), say: 'a' }]).ok).toBe(false);
    expect(buildCta([{ label: 'x', say: 'a'.repeat(201) }]).ok).toBe(false);
  });
  it('only http(s) links with no login in them', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://a.com', '//a.com', 'https://user:pw@a.com/', 'https://a.com/ x', 'https://a.com/‮', 'not a url', 'https://']) {
      expect(safeHref(bad), bad).toBeNull();
    }
    expect(safeHref('https://example.com/a?b=1')).toEqual({ href: 'https://example.com/a?b=1', host: 'example.com' });
    expect(safeHref('HTTP://Example.com:8080')).toMatchObject({ host: 'example.com:8080' });
  });
  it('send_message stores the buttons as payload and refuses bad ones before posting', async () => {
    const s = setup();
    const bad = await s.call('send_message', { text: 'hi', cta: [{ label: 'Go', href: 'javascript:alert(1)' }] });
    expect(bad.isError).toBe(true);
    expect(s.repos.listMessages(s.room.id)).toHaveLength(0);
    const ok = await s.call('send_message', { text: 'hi', cta: [{ label: '<b>Go</b>', say: 'turn it on' }, { label: 'Docs', href: 'https://example.com/x' }] });
    expect(ok.isError).toBe(false);
    const m = s.repos.listMessages(s.room.id)[0];
    expect((m.payload as CtaPayload).cta).toEqual([{ label: '<b>Go</b>', say: 'turn it on' }, { label: 'Docs', href: 'https://example.com/x' }]);
  });
});
