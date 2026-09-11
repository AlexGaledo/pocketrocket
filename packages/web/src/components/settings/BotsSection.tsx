/**
 * Settings › Bots: whether bots ask before risky actions (`settings.approvals`, default 'ask').
 * Turning approvals off takes an explicit second step with a plain warning. When the server's
 * environment pins the value (GET /api/health → approvalsLocked) the control shows the value in force,
 * is read-only, and says where it is set; the hub would answer 409 to any change anyway.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import type { Approvals } from '@pocketrocket/shared';
import { useStore } from '../../store';
import type { HealthResponse } from '../../lib/api';
import { Badge, Button, RadioCard } from '../ui';
import { Group, SectionHeader } from './parts';

export function BotsSection({ health, onHealthStale }: {
  /** Latest GET /api/health, or null while loading / if it failed (then we assume "not locked"). */
  health: HealthResponse | null;
  /** Called when a save is refused, so the dialog can refetch health and pick up a lock. */
  onHealthStale: () => void;
}) {
  const stored = useStore((s) => s.settings.approvals);
  const updateSettings = useStore((s) => s.updateSettings);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const titleId = useId();

  const locked = !!health?.approvalsLocked;
  const inForce: Approvals = locked && health ? health.approvals : stored;

  const save = async (next: Approvals) => {
    setSaving(true);
    const ok = await updateSettings({ approvals: next });
    setSaving(false);
    setConfirming(false);
    // The store already rolled back and showed why; a 409 means the environment pinned it meanwhile.
    if (!ok) onHealthStale();
  };

  const choose = (next: Approvals) => {
    if (locked || saving) return;
    if (next === inForce) return setConfirming(false);
    if (next === 'bypass') return setConfirming(true);
    void save(next);
  };

  return (
    <>
      <SectionHeader title="Bots" description="How much your bots can do on their own." />

      <Group title="Approvals" titleId={titleId}>
        <div role="radiogroup" aria-labelledby={titleId} aria-disabled={locked || undefined} className="flex flex-col gap-2">
          <RadioCard checked={inForce === 'ask'} disabled={locked} onSelect={() => choose('ask')} title="Ask before risky actions" badge={<Badge tone="ok">Recommended</Badge>}>
            Bots ask before they run commands, change files outside the shared workspace, or add and change bots and rooms. You allow or deny each request right in the chat.
          </RadioCard>
          <RadioCard checked={inForce === 'bypass'} disabled={locked} onSelect={() => choose('bypass')} title="Run without asking">
            Bots run commands, change files and use the web right away. Only for computers you trust.
          </RadioCard>
        </div>

        {confirming && !locked && <ConfirmBypass saving={saving} onCancel={() => setConfirming(false)} onConfirm={() => void save('bypass')} />}

        {locked ? (
          <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-snug text-muted">
            <Lock size={13} aria-hidden className="mt-0.5 shrink-0" />
            <span>
              Set by the server's environment (<code className="font-mono text-[11.5px]">POCKETROCKET_BYPASS_PERMISSIONS</code>).
            </span>
          </p>
        ) : (
          <p className="mt-3 text-[12px] text-muted">A change applies from each bot's next reply.</p>
        )}
      </Group>
    </>
  );
}

/** The second step before approvals go off. Focus lands on the safe choice so Enter keeps you protected. */
function ConfirmBypass({ saving, onCancel, onConfirm }: { saving: boolean; onCancel: () => void; onConfirm: () => void }) {
  const keepAskingRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  useEffect(() => keepAskingRef.current?.focus(), []);

  return (
    <div role="group" aria-labelledby={headingId} className="mt-3 rounded-2xl bg-warn/10 p-4 ring-1 ring-warn/30">
      <div className="flex gap-3">
        <ShieldAlert size={18} aria-hidden className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0">
          <p id={headingId} className="text-[13.5px] font-semibold">Turn off approvals?</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-fg">
            Bots will act without checking with you first. A web page a bot reads can hide instructions that trick it
            into running commands on this computer, and nothing will stop it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button ref={keepAskingRef} variant="primary" disabled={saving} onClick={onCancel}>Keep asking</Button>
            <Button variant="danger" disabled={saving} onClick={onConfirm}>{saving ? 'Saving…' : 'Run without asking'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
