// U4: `request_form` cards. A bot's turn waits here for the owner to fill the card in. The card is a message (kind
// 'form') so it survives a reload; the wait itself is in memory, so a card left open when the hub stops is shown as
// expired at the next start (Repos.expirePendingApprovals).
import type { FormAnswer, FormField, FormPayload, Message } from '@pocketrocket/shared';
import { FORM_TIMEOUT_MS, validateAnswers } from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { redact } from '../providers/redact.js';

/** A bot may ask this many forms per window. */
export const FORM_RATE_MAX = 5;
export const FORM_RATE_WINDOW_MS = 60 * 60_000;

export type FormOutcome =
  | { kind: 'submitted'; answers: Record<string, FormAnswer> }
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

interface Open {
  botId: string;
  roomId: string;
  fields: FormField[];
  finish: (o: FormOutcome, status: FormPayload['status'], answers?: Record<string, FormAnswer>) => void;
}

export class FormBroker {
  private open = new Map<string, Open>();
  constructor(private repos: Repos, private timeoutMs: number = FORM_TIMEOUT_MS) {}

  private asked = new Map<string, number[]>();

  /**
   * True (and the ask is NOT counted) when this bot has already asked `max` forms in the last `windowMs`; otherwise
   * counts it. Keeps a looping bot from flooding the owner with cards.
   */
  rateLimited(botId: string, now = Date.now(), max = FORM_RATE_MAX, windowMs = FORM_RATE_WINDOW_MS): boolean {
    const recent = (this.asked.get(botId) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { this.asked.set(botId, recent); return true; }
    recent.push(now);
    this.asked.set(botId, recent);
    return false;
  }

  hasOpen(botId: string): boolean {
    for (const o of this.open.values()) if (o.botId === botId) return true;
    return false;
  }

  /** Posts the card and waits for the owner. Resolves once, however the card ends. */
  ask(a: {
    botId: string; botHandle: string; roomId: string; turnId: string; hop: number; causeId: string;
    form: { title: string; description?: string; fields: FormField[] }; signal: AbortSignal;
  }): Promise<FormOutcome> {
    const payload: FormPayload = { botId: a.botId, ...a.form, status: 'pending' };
    const msg: Message = this.repos.insertMessage({
      roomId: a.roomId, authorType: 'bot', authorId: a.botId, kind: 'form',
      text: '@' + a.botHandle + ' needs a few answers: ' + a.form.title, payload,
      causeId: a.causeId, hop: a.hop, turnId: a.turnId,
    });
    events.emitEvent({ type: 'message.new', message: msg });
    return new Promise<FormOutcome>((resolve) => {
      let done = false;
      const finish: Open['finish'] = (o, status, answers) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.signal.removeEventListener('abort', onAbort);
        this.open.delete(msg.id);
        const next: FormPayload = { ...payload, status, ...(answers ? { answers } : {}) };
        const updated = this.repos.updateMessage(msg.id, { payload: next });
        if (updated) events.emitEvent({ type: 'message.update', id: msg.id, roomId: a.roomId, patch: { payload: next } });
        resolve(o);
      };
      const onAbort = () => finish({ kind: 'aborted' }, 'expired');
      const timer = setTimeout(() => finish({ kind: 'timeout' }, 'timeout'), this.timeoutMs);
      timer.unref?.();
      a.signal.addEventListener('abort', onAbort, { once: true });
      if (a.signal.aborted) return onAbort();
      this.open.set(msg.id, { botId: a.botId, roomId: a.roomId, fields: a.form.fields, finish });
    });
  }

  /** The owner's answers. Returns why they were refused, or null when the card took them. */
  submit(formId: string, answers: Record<string, FormAnswer>): string | null {
    const o = this.open.get(formId);
    if (!o) return 'This form is no longer waiting for an answer.';
    const v = validateAnswers(o.fields, answers);
    if (!v.ok) return v.error;
    // The answers go to the bot, and a form is for plain values: a pasted key or token is refused, not passed on.
    for (const val of Object.values(v.value)) {
      if (typeof val === 'string' && redact(val) !== val) return 'One answer looks like a secret (a key or token). Forms are not for secrets: take it out.';
    }
    o.finish({ kind: 'submitted', answers: v.value }, 'submitted', v.value);
    return null;
  }

  cancel(formId: string): boolean {
    const o = this.open.get(formId);
    if (!o) return false;
    o.finish({ kind: 'cancelled' }, 'cancelled');
    return true;
  }
}
