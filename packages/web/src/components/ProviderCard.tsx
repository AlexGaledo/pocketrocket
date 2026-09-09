import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ProviderCheck, ProviderInfo } from '@pocketrocket/shared';
import { api } from '../lib/api';
import { Badge, Button, cn } from './ui';

export function statusPill(check: ProviderCheck): { tone: 'ok' | 'warn' | 'muted'; text: string } {
  if (check.ok) {
    const parts = ['Ready'];
    if (check.version) parts.push('v' + check.version);
    if (check.auth && check.auth !== 'none' && check.auth !== 'unknown') parts.push(check.auth);
    return { tone: 'ok', text: parts.join(' · ') };
  }
  // A detected version means the CLI/SDK is installed but not authenticated.
  if (check.version) return { tone: 'warn', text: 'Not logged in' };
  return { tone: 'muted', text: 'Not installed' };
}

export function ProviderCard({
  info,
  selected,
  onSelect,
  onChecked,
}: {
  info: ProviderInfo;
  selected: boolean;
  onSelect: () => void;
  /** called with the fresh ProviderCheck after a re-check completes */
  onChecked?: (check: ProviderCheck) => void;
}) {
  const [checking, setChecking] = useState(false);
  const pill = statusPill(info.check);

  const recheck = async () => {
    setChecking(true);
    try {
      const check = await api.providers.check(info.id);
      onChecked?.(check);
    } catch {
      /* leave the last known check in place */
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className={cn(
        'cursor-pointer rounded-2xl p-3.5 ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        selected ? 'bg-accent/8 ring-accent/50' : 'bg-card2/40 ring-line hover:bg-card2/70',
      )}
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      // A div with role=radio is invisible to the keyboard unless it is focusable and answers to keys
      // itself. Roving tabindex (only the checked card is tabbable) plus arrows to move between cards,
      // which is what a real radio group does.
      tabIndex={selected ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
          return;
        }
        const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const cards = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
        const next = cards[(cards.indexOf(e.currentTarget) + step + cards.length) % cards.length];
        next?.focus();
        next?.click();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1', selected ? 'bg-ink ring-ink' : 'ring-dim')}>
            {selected && <span className="h-1.5 w-1.5 rounded-full bg-ink-fg" />}
          </span>
          <span className="text-[13.5px] font-medium">{info.label}</span>
          {info.maturity === 'untested' && <Badge tone="warn">Untested</Badge>}
        </div>
        <Badge tone={pill.tone === 'ok' ? 'ok' : pill.tone === 'warn' ? 'warn' : 'muted'}>{pill.text}</Badge>
      </div>
      <div className="mt-1 pl-6 text-[12.5px] text-muted">{info.blurb}</div>
      {info.maturity === 'untested' && (
        <div className="mt-1 pl-6 text-[11.5px] text-warn">
          Built to the CLI's documented contract but never run against a real account. Expect rough edges, and
          check the approval cards before you let a bot touch anything outside the workspace.
        </div>
      )}
      {!info.check.ok && info.check.hint && (
        <div className="md mt-1.5 pl-6 text-[11.5px] text-dim">
          <ReactMarkdown>{info.check.hint}</ReactMarkdown>
        </div>
      )}
      <div className="mt-2 pl-6">
        <Button size="sm" onClick={(e) => { e.stopPropagation(); void recheck(); }} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check'}
        </Button>
      </div>
    </div>
  );
}
