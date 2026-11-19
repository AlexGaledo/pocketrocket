import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { FormAnswer, FormPayload, Message } from '@pocketrocket/shared';
import { cleanText, displayCta, validateAnswers, MAX_FORM_DESCRIPTION, MAX_FORM_TITLE } from '@pocketrocket/shared';
import { useStore, botById } from '../store';
import { wsSend } from '../lib/ws';
import { displayFields } from '../lib/cardFields';
import { ActionCard, ActionCardHeader, Badge, Button, Field, Input, Label, Select, Textarea } from './ui';

/*
 * U4 form card and U5 buttons. Everything the bot wrote is drawn as plain text through React text nodes (no markdown,
 * no HTML) after being cleaned again here, because a stored row may predate a rule or come from a hand-edited database.
 */

const STATUS_LABEL: Record<FormPayload['status'], string | null> = {
  pending: null, submitted: 'Sent', cancelled: 'Cancelled', timeout: 'No answer in time', expired: 'No longer waiting',
};

const answerText = (v: FormAnswer | undefined) => (v === undefined ? 'No answer' : v === true ? 'Yes' : v === false ? 'No' : v);

export function FormCard({ m }: { m: Message }) {
  const p = m.payload as FormPayload;
  const bots = useStore((s) => s.bots);
  const bot = botById(bots, p.botId);
  const fields = useMemo(() => displayFields(p.fields), [p.fields]);
  const title = cleanText(p.title, MAX_FORM_TITLE);
  const description = p.description ? cleanText(p.description, MAX_FORM_DESCRIPTION, true) : '';
  const open = p.status === 'pending';
  const [values, setValues] = useState<Record<string, FormAnswer>>({});
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const formSent = useStore((s) => s.formSent);
  const refused = useStore((s) => s.formErrors[m.id]);
  // The hub refused what was sent: open the card again and show why, where the button was.
  useEffect(() => { if (refused) setSent(false); }, [refused]);
  const set = (id: string, v: FormAnswer) => { setValues((x) => ({ ...x, [id]: v })); setError(null); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateAnswers(fields, values);
    if (!v.ok) return setError(v.error);
    if (!wsSend({ type: 'form.submit', formId: m.id, answers: v.value })) return setError('Not connected. Try again in a moment.');
    formSent(m.id);
    setSent(true);
  };
  const cancel = () => { if (wsSend({ type: 'form.cancel', formId: m.id })) { formSent(m.id); setSent(true); } };

  const status = STATUS_LABEL[p.status];
  return (
    <ActionCard tone={open ? 'warn' : 'quiet'} className="w-full max-w-[560px]">
      <ActionCardHeader meta={status && <Badge tone={p.status === 'submitted' ? 'ok' : 'muted'}>{status}</Badge>}>
        <span className="min-w-0 flex-1 font-medium">{bot ? bot.name : 'A bot'} {open ? 'asks' : 'asked'}: {title}</span>
      </ActionCardHeader>
      {description && <p className="whitespace-pre-wrap px-4 pt-1 text-ui text-muted">{description}</p>}
      {open ? (
        <form onSubmit={submit} className="flex flex-col gap-3 px-4 pb-4 pt-3" aria-label={title}>
          {fields.map((f) => (
            <Field key={f.id}>
              <Label hint={f.required ? undefined : 'Optional'} {...(f.kind === 'yesno' ? { id: m.id + f.id } : {})}>{f.label}</Label>
              {f.kind === 'text' && (f.maxLength > 120
                ? <Textarea rows={3} maxLength={f.maxLength} value={String(values[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} />
                : <Input maxLength={f.maxLength} value={String(values[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} autoComplete="off" />)}
              {f.kind === 'choice' && (
                <Select value={String(values[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)}>
                  <option value="">Choose…</option>
                  {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              )}
              {f.kind === 'yesno' && (
                <div role="group" aria-labelledby={m.id + f.id} className="flex gap-2">
                  {([true, false] as const).map((b) => (
                    <Button key={String(b)} type="button" variant={values[f.id] === b ? 'primary' : 'outline'} aria-pressed={values[f.id] === b} className="touch-target" onClick={() => set(f.id, b)}>{b ? 'Yes' : 'No'}</Button>
                  ))}
                </div>
              )}
              {f.help && <p className="mt-1 text-hint text-dim">{f.help}</p>}
            </Field>
          ))}
          <p className="text-hint text-dim">Do not type passwords, keys or codes here. Forms are for plain answers.</p>
          {(error ?? refused?.message) && <p role="alert" className="text-ui text-bad">{error ?? refused?.message}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" className="touch-target" disabled={sent}>Send answers</Button>
            <Button type="button" className="touch-target" disabled={sent} onClick={cancel}>Cancel</Button>
          </div>
        </form>
      ) : p.status === 'submitted' && p.answers ? (
        <dl className="flex flex-col gap-1.5 px-4 pb-4 pt-2 text-ui">
          {fields.map((f) => (
            <div key={f.id}><dt className="text-hint text-dim">{f.label}</dt><dd className="whitespace-pre-wrap break-words">{answerText(p.answers?.[f.id])}</dd></div>
          ))}
        </dl>
      ) : <div className="h-3" />}
    </ActionCard>
  );
}

/**
 * Buttons a bot put under a message. A button either sends its text as an ordinary message from you, shown
 * beneath it before you click, or opens an http(s) link in a new tab with the host written next to it.
 */
export function CtaButtons({ payload }: { payload: unknown }) {
  const buttons = useMemo(() => displayCta(payload), [payload]);
  const send = useStore((s) => s.sendMessage);
  const [used, setUsed] = useState<number | null>(null);
  if (!buttons.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {buttons.map((b, i) => (
        <div key={i} className="flex flex-col items-start gap-0.5">
          {b.href ? (
            <a
              href={b.href} target="_blank" rel="noopener noreferrer"
              className="touch-target inline-flex h-8 items-center gap-1.5 rounded-md bg-card2 px-3 text-ui text-fg hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:hover:brightness-110"
            >
              {b.label} <ExternalLink size={13} aria-hidden /> <span className="text-hint text-muted">{b.host}</span>
            </a>
          ) : (
            <>
              {/* The button says what it sends: a label that differs from the message is not shown instead of it. */}
              <Button className="touch-target h-auto max-w-full whitespace-normal break-words py-1.5 text-left" disabled={used !== null} onClick={() => { setUsed(i); send(b.say!); }}>
                {b.say !== b.label ? b.say : b.label}
              </Button>
              {b.say !== b.label && <span className="max-w-full break-words text-hint text-dim">Sends this as you</span>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
