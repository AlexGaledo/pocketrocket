// One line per bot turn instead of a row of tool pills. Running: what it is doing, the step and the clock. Done:
// how long and how many. The steps and the bot's narration are in the fold; the answer, cards and any failure that
// was not recovered sit outside it (see ChatPane's MessageGroup).
import { useEffect, useId, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import type { Message, ToolPayload } from '@pocketrocket/shared';
import { useStore } from '../store';
import { isWorking, useBotStatus } from '../lib/botStatus';
import { toolPhrase } from '../lib/toolPhrases';
import { Badge, cn } from './ui';
import { Markdown } from './Markdown';

const payload = (m: Message) => m.payload as ToolPayload;

/** The card stands for this call, so it is not also a step. If the call failed there is no card, and it is one. */
export const isStep = (m: Message) => m.kind === 'tool' && !(payload(m).name.endsWith('request_takeover') && !payload(m).isError);

/**
 * Plain words for a step: "Opened page example.com". What was typed never goes in the label, since it can be a
 * password. It stays in the step's detail, behind two clicks, as it always was.
 */
export function stepText(p: ToolPayload, tense: 'done' | 'now' = 'done'): string {
  const i = (p.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const base = (v: string) => v.split(/[\\/]/).pop() ?? v;
  const n = p.name;
  const target = n.startsWith('mcp__pocketrocket__desktop_') ? s('command') || s('keys')
    : n.startsWith('mcp__pocketrocket__') ? (s('to_bot') ? '@' + s('to_bot').replace(/^@/, '') : s('handle') || s('name'))
    : n.startsWith('mcp__browser__') ? (s('url') ? s('url').replace(/^https?:\/\//, '').slice(0, 40) : s('element').slice(0, 40))
    : n === 'Bash' ? s('command').slice(0, 44)
    : n === 'Glob' || n === 'Grep' ? s('pattern').slice(0, 40)
    : n === 'WebSearch' ? s('query').slice(0, 40)
    : n === 'WebFetch' ? s('url').replace(/^https?:\/\//, '').slice(0, 40)
    : base(s('file_path'));
  return (toolPhrase(n, tense) + ' ' + target).trim();
}

/** A failed step that a later call of the same tool got past. The turn did not end worse for it, so it isn't red. */
function outcomes(steps: Message[]) {
  const failed = steps.filter((m) => payload(m).done && payload(m).isError);
  const recovered = failed.filter((m) => {
    const after = steps.slice(steps.indexOf(m) + 1);
    return after.some((x) => payload(x).name === payload(m).name && payload(x).done && !payload(x).isError);
  });
  return { recovered, unrecovered: failed.filter((m) => !recovered.includes(m)) };
}

function fmtTook(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

/** `items` is the turn's steps and narration, in order. The times are the whole turn's, answer included. */
export function WorkLine({ items, startedAt, endedAt }: { items: Message[]; startedAt: number; endedAt: number }) {
  const steps = useMemo(() => items.filter(isStep), [items]);
  const turnId = items[0].turnId;
  const authorId = items[0].authorId;
  const streaming = useStore((s) => !!turnId && !!s.streaming[turnId]);
  const { statusOf } = useBotStatus();
  // Without the status check, a step cut off by a hub restart would read as running for ever.
  const running = streaming || (steps.some((m) => !payload(m).done) && !!authorId && isWorking(statusOf(authorId)));
  const [open, setOpen] = useState(false);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const listId = useId();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const { recovered, unrecovered } = useMemo(() => outcomes(steps), [steps]);
  const count = steps.length + (steps.length === 1 ? ' step' : ' steps');
  const took = endedAt - startedAt;
  let line: string;
  if (running) {
    const current = [...steps].reverse().find((m) => !payload(m).done);
    line = (current ? stepText(payload(current), 'now') : 'Thinking') + ' · step ' + Math.max(1, steps.length) + ' · ' + fmtClock(now - startedAt);
  } else {
    line = 'Worked' + (took >= 1000 ? ' for ' + fmtTook(took) : '') + ' · ' + count;
    if (recovered.length) line += ' · ' + recovered.length + ' retried';
  }

  return (
    <div className="max-w-[680px] text-ui text-muted">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className={cn('-ml-1.5 inline-flex max-w-full items-start gap-1.5 rounded-xs px-1.5 py-0.5 text-left hover:text-fg', running && 'chip-running')}
      >
        {open ? <ChevronDown size={14} aria-hidden className="mt-[3px] shrink-0" /> : <ChevronRight size={14} aria-hidden className="mt-[3px] shrink-0" />}
        <span className="min-w-0">{line}</span>
      </button>
      {open && (
        <ul id={listId} className="ml-[5px] mt-1.5 flex flex-col gap-1 border-l border-line pl-4">
          {items.map((m) => m.kind === 'text' ? (
            <li key={m.id} className="md text-ui text-muted"><Markdown>{m.text}</Markdown></li>
          ) : (
            <li key={m.id}>
              <button
                type="button"
                aria-expanded={openStep === m.id}
                title={payload(m).name}
                onClick={() => setOpenStep(openStep === m.id ? null : m.id)}
                className="max-w-full truncate rounded-xs text-left hover:text-fg"
              >
                {stepText(payload(m), payload(m).done ? 'done' : 'now')}
                {recovered.includes(m) && <span className="text-dim"> · retried</span>}
                {unrecovered.includes(m) && <span className="text-bad"> · failed</span>}
              </button>
              {openStep === m.id && <StepDetail p={payload(m)} />}
            </li>
          ))}
        </ul>
      )}
      {!running && unrecovered.map((m) => (
        <div key={m.id} className="mt-1 flex items-start gap-1.5 text-bad">
          <AlertCircle size={14} aria-hidden className="mt-[3px] shrink-0" />
          <span className="min-w-0">Failed: {stepText(payload(m))}</span>
        </div>
      ))}
    </div>
  );
}

function StepDetail({ p }: { p: ToolPayload }) {
  return (
    <div className="my-1.5 overflow-hidden rounded-lg bg-card2/60 text-hint">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="min-w-0 truncate font-mono font-medium">{p.name.replace('mcp__pocketrocket__', '').replace('mcp__browser__', 'browser: ')}</span>
        {p.isError ? <Badge tone="bad">failed</Badge> : p.done ? <Badge tone="ok">done</Badge> : <Badge tone="accent">running</Badge>}
      </div>
      <div className="grid gap-0 md:grid-cols-2">
        <div className="min-w-0 p-3 pt-0">
          <div className="mb-1 text-hint text-muted">Input</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-hint leading-relaxed">{fmtInput(p.input)}</pre>
        </div>
        <div className="min-w-0 p-3 pt-0">
          <div className="mb-1 text-hint text-muted">Output</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-hint leading-relaxed text-muted">{p.output === undefined ? (p.done ? '(empty)' : 'Waiting…') : p.output || '(empty)'}</pre>
        </div>
      </div>
    </div>
  );
}

export function fmtInput(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.command === 'string' && Object.keys(i).length <= 2) return i.command;
  return JSON.stringify(i, null, 2);
}
