/**
 * Settings › Bots › Approval rules (P2): the "always" answers the user kept as rules. Each one lets a bot run a
 * matching call without a card, also in routines at 3 a.m. Only the user creates them (from a card's "Make this
 * a rule?" offer) and only here can they be revoked; no bot can write one. Integration writes never become rules.
 */
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ApprovalPolicy } from '@pocketrocket/shared';
import { useStore, botById } from '../../store';
import { api } from '../../lib/api';
import { Avatar, Badge, Button } from '../ui';
import { Card, Group } from './parts';

export function ApprovalRules() {
  const bots = useStore((s) => s.bots);
  const rev = useStore((s) => s.policiesRev);
  const toast = useStore((s) => s.toast);
  const [rules, setRules] = useState<ApprovalPolicy[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.policies.list().then((r) => alive && setRules(r)).catch(() => alive && setRules([]));
    return () => { alive = false; };
  }, [rev]);

  const revoke = async (p: ApprovalPolicy) => {
    setBusy(p.id);
    try {
      await api.policies.revoke(p.id);
      setRules((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
    } catch (e) {
      toast("Couldn't revoke the rule: " + (e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Group title="Approval rules">
      <p className="mb-2 text-[12px] leading-snug text-muted">
        Calls a bot may make without asking, also in routines nobody is watching. Add one from an approval card
        after "Allow for this session". Sending or posting through an integration always asks.
      </p>
      <Card className="py-1">
        {rules === null ? (
          <p className="py-2 text-[12.5px] text-muted" role="status">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="py-2 text-[12.5px] text-muted">No rules. Every risky call asks.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rules.map((p) => {
              const bot = botById(bots, p.botId);
              return (
                <li key={p.id} className="flex items-center gap-3 py-2.5">
                  {bot && <Avatar bot={bot} size={24} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[12.5px]">
                      <span className="font-medium">{bot?.name ?? 'Deleted bot'}</span>
                      <span className="font-mono text-[11.5px] text-muted">{p.tool}</span>
                      {p.decision === 'deny' ? <Badge tone="bad">deny</Badge> : <Badge tone="ok">allow</Badge>}
                    </div>
                    <div className="truncate font-mono text-[11.5px] text-muted" title={p.pattern}>{p.pattern === '*' ? 'any call' : p.pattern}</div>
                  </div>
                  <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => void revoke(p)}
                    aria-label={'Revoke rule: ' + (bot?.name ?? 'bot') + ' ' + p.tool + ' ' + p.pattern}>
                    <Trash2 size={13} /> Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Group>
  );
}
