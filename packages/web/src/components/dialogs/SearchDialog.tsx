import { useEffect, useState } from 'react';
import type { SearchHit } from '@pocketrocket/shared';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Dialog, Input } from '../ui';

/** The match inside a snippet, marked. Case-insensitive, like the hub's search. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded-xs bg-[#f5b53d] text-[#1a1200]">{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

/** Finds a message in any chat. Picking one opens that chat at the message, with the words highlighted. */
export function SearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const toast = useStore((s) => s.toast);
  const openHit = useStore((s) => s.openSearchHit);
  const term = query.trim();

  useEffect(() => {
    if (term.length < 2) { setHits(null); return; }
    let stale = false;
    const t = setTimeout(() => {
      api.search(term)
        .then((r) => { if (!stale) setHits(r); })
        .catch((e: Error) => { if (!stale) toast('Search failed: ' + e.message, true); });
    }, 200);
    return () => { stale = true; clearTimeout(t); };
  }, [term, toast]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Search">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search every chat" aria-label="Search every chat" autoFocus />
      <div aria-live="polite" className="mt-3 max-h-[50vh] overflow-y-auto">
        {hits && !hits.length && <p className="px-2 py-3 text-ui text-muted">Nothing found.</p>}
        <ul className="space-y-0.5">
          {hits?.map((h) => (
            <li key={h.id}>
              <button
                className="block w-full min-w-0 rounded-sm px-2.5 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                onClick={() => { openHit(h.roomId, h.seq, term); onClose(); }}
              >
                <span className="flex items-baseline justify-between gap-2 text-hint text-muted">
                  <span className="truncate">{h.roomName}</span>
                  <span className="shrink-0">{new Date(h.createdAt).toLocaleDateString()}</span>
                </span>
                <span className="mt-0.5 block text-ui"><Marked text={h.snippet} query={term} /></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
