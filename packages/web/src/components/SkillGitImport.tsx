/**
 * Skills tab (P7): import skills from a git repo (a local "marketplace") or a folder on the hub's computer.
 * Every imported skill lands in the pool as pending review, so nothing reaches a bot until it is approved
 * in the list below this form.
 */
import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../lib/api';
import { Button, Input } from './ui';

export function SkillGitImport({ onDone, onClose }: { onDone: () => void | Promise<void>; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([]);

  const run = async () => {
    setBusy(true);
    setSkipped([]);
    try {
      const r = await api.importSkillsFromGit(url.trim());
      setSkipped(r.skipped);
      toast(r.imported.length
        ? 'Imported ' + r.imported.length + ' skill' + (r.imported.length === 1 ? '' : 's') + ' for review'
        : 'No new skills found in that repo');
      await onDone();
    } catch (e) {
      toast("Couldn't import: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-card2/60 p-2">
      <Input
        placeholder="https://github.com/team/skills.git"
        aria-label="Git URL or folder to import skills from"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !busy) void run(); }}
        spellCheck={false}
        className="font-mono text-[12px]"
      />
      <p className="text-[11.5px] text-dim">Every folder with a SKILL.md is copied in as pending. Review each one before assigning it.</p>
      {skipped.length > 0 && (
        <ul className="max-h-28 overflow-y-auto text-[11.5px] text-muted" aria-label="Skipped skills">
          {skipped.map((s) => <li key={s.name}><span className="font-medium">{s.name}</span>: {s.reason}</li>)}
        </ul>
      )}
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        <Button size="sm" variant="primary" onClick={() => void run()} disabled={!url.trim() || busy}>{busy ? 'Importing…' : 'Import'}</Button>
      </div>
    </div>
  );
}
