/**
 * Settings › Reports. What bots said when a site stopped them (a captcha, a login, a block), newest first. Resolve a
 * report once you have dealt with it, or dismiss one that does not matter. Nothing here leaves this computer.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Flag, Undo2, X } from 'lucide-react';
import { useStore, botById } from '../../store';
import { api, type BotReportRow } from '../../lib/api';
import { Badge, Banner, Button, EmptyState, Skeleton, SkeletonGroup, fmtTime } from '../ui';
import { Card, Group, SectionHeader } from './parts';

const KIND: Record<BotReportRow['kind'], string> = { captcha: 'Captcha', login: 'Needs a login', blocked: 'Blocked', other: 'Other' };

export function BotReportsSection() {
  const bots = useStore((s) => s.bots);
  const toast = useStore((s) => s.toast);
  const [rows, setRows] = useState<BotReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.botReports.list().then((r) => { setRows(r); setError(null); }, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const set = async (r: BotReportRow, status: BotReportRow['status']) => {
    try {
      const next = await api.botReports.set(r.id, status);
      setRows((cur) => cur && cur.map((x) => (x.id === r.id ? next : x)));
    } catch (e) { toast((e as Error).message, true); load(); }
  };
  const pending = rows?.filter((r) => r.status === 'pending') ?? [];
  const closed = rows?.filter((r) => r.status !== 'pending') ?? [];

  const card = (r: BotReportRow) => (
    <li key={r.id}>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-ui font-semibold">{botById(bots, r.botId)?.name ?? 'A bot'} <Badge tone={r.status === 'pending' ? 'warn' : 'muted'}>{r.status === 'pending' ? KIND[r.kind] : r.status === 'resolved' ? 'Resolved' : 'Dismissed'}</Badge></div>
            {r.site && <div className="mt-0.5 break-all text-hint text-muted">{r.site}</div>}
          </div>
          <div className="flex gap-1.5">
            {r.status === 'pending' ? (
              <>
                <Button size="sm" onClick={() => void set(r, 'resolved')}><Check size={13} aria-hidden /> Resolve</Button>
                <Button size="sm" variant="ghost" onClick={() => void set(r, 'dismissed')}><X size={13} aria-hidden /> Dismiss</Button>
              </>
            ) : <Button size="sm" variant="ghost" onClick={() => void set(r, 'pending')}><Undo2 size={13} aria-hidden /> Reopen</Button>}
          </div>
        </div>
        {r.reason && <p className="mt-2 whitespace-pre-wrap text-ui">{r.reason}</p>}
        <div className="mt-2 text-hint text-dim">{fmtTime(r.createdAt)}</div>
      </Card>
    </li>
  );

  return (
    <>
      <SectionHeader title="Reports" description="Where bots told you a site stopped them." />
      {error && <Banner tone="error" className="mb-4" action={<Button size="sm" onClick={load}>Retry</Button>}>{error}</Banner>}
      {rows === null && !error && <SkeletonGroup label="Loading reports…" className="space-y-2"><Skeleton className="h-20 w-full rounded-lg" /><Skeleton className="h-20 w-full rounded-lg" /></SkeletonGroup>}
      {rows?.length === 0 && <EmptyState icon={<Flag size={18} />} title="No reports">When a bot hits a captcha or a login wall it can tell you here.</EmptyState>}
      {pending.length > 0 && <Group title={'Waiting (' + pending.length + ')'}><ul className="space-y-3">{pending.map(card)}</ul></Group>}
      {closed.length > 0 && <Group title="Done"><ul className="space-y-3">{closed.map(card)}</ul></Group>}
    </>
  );
}
