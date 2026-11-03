/**
 * Settings › Knowledge (P7): one repo every bot reads and none can write. The source is a git URL (cloned
 * to data/knowledge and pulled on a timer) or an absolute folder on the hub's computer (linked there).
 * Saving goes through PUT /api/settings, which validates the source; "Sync now" is POST /api/knowledge/sync.
 * Live status arrives over WS (`knowledge.status`) and lands in the store.
 */
import { useEffect, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { Badge, Button, Field, Input, Label } from '../ui';
import { Card, Group, Private, SectionHeader, shortPath } from './parts';

export function KnowledgeSection() {
  const saved = useStore((s) => s.settings.knowledgeRepo);
  const live = useStore((s) => s.knowledge);
  const updateSettings = useStore((s) => s.updateSettings);
  const toast = useStore((s) => s.toast);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [fetched, setFetched] = useState<typeof live>(null);

  useEffect(() => setDraft(saved), [saved]);
  useEffect(() => {
    api.knowledge.status().then(setFetched).catch(() => undefined);
  }, []);
  const status = live ?? fetched;

  const save = async () => {
    setSaving(true);
    // The store shows the hub's reason (bad URL, missing folder) and rolls back when it is refused.
    const ok = await updateSettings({ knowledgeRepo: draft.trim() });
    setSaving(false);
    if (ok) toast(draft.trim() ? 'Knowledge repo saved; syncing' : 'Knowledge repo turned off');
  };
  const syncNow = async () => {
    try {
      setFetched(await api.knowledge.sync());
    } catch (e) {
      toast("Couldn't sync: " + (e as Error).message, true);
    }
  };

  const dirty = draft.trim() !== saved;
  const syncing = !!status?.syncing;

  return (
    <>
      <SectionHeader title="Knowledge" description="Docs every bot can read but not change." />

      <Group title="Knowledge repo">
        <Card>
          <Field>
            <Label hint="Git URL or server folder">Source</Label>
            <div className="flex gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && dirty) void save(); }}
                placeholder="https://github.com/team/handbook.git"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-ui"
              />
              <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving}>Save</Button>
            </div>
          </Field>
          <p className="mt-2 text-hint leading-snug text-muted" title="A private repo needs git credentials set up on the server.">
            Git pulls hourly. Folders update instantly.
          </p>
        </Card>
      </Group>

      <Group
        title="Status"
        aside={(
          <Button size="sm" variant="ghost" onClick={() => void syncNow()} disabled={!saved || syncing || dirty} title={dirty ? 'Save the source first' : 'Pull the latest now'}>
            <RefreshCw size={13} aria-hidden /> Sync now
          </Button>
        )}
      >
        <Card className="py-3">
          <div role="status" aria-live="polite" className="flex flex-col gap-1.5 text-ui">
            {!status || status.mode === 'off' && !status.lastError ? (
              <p className="flex items-center gap-2 text-muted"><BookOpen size={14} aria-hidden /> No docs connected.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {syncing
                    ? <Badge tone="accent">Syncing…</Badge>
                    : status.lastError ? <Badge tone="bad">Sync failed</Badge> : <Badge tone="ok">{status.mode === 'link' ? 'Linked' : 'Cloned'}</Badge>}
                  {status.head && <span className="font-mono text-hint text-muted">@{status.head}</span>}
                  {status.lastSyncedAt && <span className="text-muted">last synced {new Date(status.lastSyncedAt).toLocaleString()}</span>}
                </div>
                {status.dir && (
                  <div className="text-muted">Bots read it at <Private value={status.dir} display={shortPath(status.dir)} label="knowledge folder path" /></div>
                )}
                {status.lastError && <p className="break-words text-bad">{status.lastError}</p>}
              </>
            )}
          </div>
        </Card>
      </Group>
    </>
  );
}
