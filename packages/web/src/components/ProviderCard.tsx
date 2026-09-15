import { useState } from 'react';
import type { ProviderCheck, ProviderId, ProviderInfo } from '@pocketrocket/shared';
import { api } from '../lib/api';
import { Markdown } from './Markdown';
import { Badge, Button, RadioDot, cn, radioKeyDown } from './ui';

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

/**
 * Re-runs a provider's detection (POST /api/providers/:id/check), e.g. after the user installs or signs
 * in. `onChecked` gets the fresh result; on failure the last known check simply stays in place.
 */
export function useRecheck(id: ProviderId, onChecked?: (check: ProviderCheck) => void) {
  const [checking, setChecking] = useState(false);
  const recheck = async () => {
    setChecking(true);
    try {
      onChecked?.(await api.providers.check(id));
    } catch {
      /* leave the last known check in place */
    } finally {
      setChecking(false);
    }
  };
  return { checking, recheck };
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
  const { checking, recheck } = useRecheck(info.id, onChecked);
  const pill = statusPill(info.check);

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
      onKeyDown={(e) => radioKeyDown(e, onSelect)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <RadioDot checked={selected} />
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
          <Markdown>{info.check.hint}</Markdown>
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
