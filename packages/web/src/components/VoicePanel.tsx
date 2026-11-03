/**
 * Bot page, Memory tab, below memory.md (P7): the bot's voice.md (short style notes that ride every prompt, 1 KB),
 * the style notes AutoMemory proposed for it (each waits for Approve / Dismiss), and how many notes the bot
 * keeps in its notes/ folder (searched on demand, never in the prompt).
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Save, X } from 'lucide-react';
import type { VoiceProposal } from '@pocketrocket/shared';
import { useStore } from '../store';
import { api } from '../lib/api';
import { Button, Label, Textarea } from './ui';

/** Matches MAX_VOICE_BYTES on the hub; shown so the cap is not a surprise. */
const VOICE_LIMIT = 1024;

export function VoicePanel({ botId }: { botId: string }) {
  const rev = useStore((s) => s.voiceRev[botId] ?? 0);
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [proposals, setProposals] = useState<VoiceProposal[]>([]);
  const [notes, setNotes] = useState<number | null>(null);

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => { setDirty(false); dirtyRef.current = false; }, [botId]);
  useEffect(() => {
    api.voice.get(botId).then((r) => {
      setProposals(r.proposals);
      // Never overwrite what the user is typing; the proposals list still refreshes.
      if (!dirtyRef.current) setText(r.text);
    }).catch(() => undefined);
    api.notes(botId).then((n) => setNotes(n.length)).catch(() => setNotes(null));
  }, [botId, rev]);

  const save = async () => {
    try {
      const r = await api.voice.set(botId, text);
      setDirty(false);
      toast(r.trimmed ? 'Saved. Oldest lines dropped to fit 1 KB.' : 'Writing style saved');
    } catch (e) {
      toast("Couldn't save writing style: " + (e as Error).message, true);
    }
  };
  const decide = async (p: VoiceProposal, decision: 'approve' | 'dismiss') => {
    try {
      const r = await api.voice.decide(botId, p.id, decision);
      setProposals(r.proposals);
      if (!dirty) setText(r.text);
    } catch (e) {
      toast("Couldn't update the proposal: " + (e as Error).message, true);
    }
  };

  const bytes = new TextEncoder().encode(text).length;
  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      <Label hint={bytes + ' / ' + VOICE_LIMIT + ' bytes'}>Writing style</Label>
      <Textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
        rows={5}
        aria-label="Writing style: how this bot should write"
        className="font-mono text-hint"
        placeholder={'Style notes, one per line. e.g.\n- Lead with the answer\n- No emoji'}
      />
      <div className="flex items-center justify-between">
        <span className="text-hint text-dim">{notes === null ? '' : notes + (notes === 1 ? ' saved note' : ' saved notes')}</span>
        <Button size="sm" variant="primary" onClick={save} disabled={!dirty}><Save size={13} /> Save</Button>
      </div>

      {proposals.length > 0 && (
        <section aria-label="Proposed writing style notes" className="flex flex-col gap-1">
          <div className="text-label text-muted">Proposed from your edits</div>
          <ul className="flex flex-col gap-1">
            {proposals.map((p) => (
              <li key={p.id} className="flex items-center gap-1 rounded-lg border border-warn/40 bg-card2/60 px-2 py-1 text-hint">
                <span className="min-w-0 flex-1">{p.text}</span>
                <Button size="icon" variant="ghost" aria-label={'Add to writing style: ' + p.text} title="Add to writing style" onClick={() => decide(p, 'approve')}><Check size={13} className="text-ok" /></Button>
                <Button size="icon" variant="ghost" aria-label={'Dismiss: ' + p.text} title="Dismiss" onClick={() => decide(p, 'dismiss')}><X size={13} className="text-bad" /></Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
