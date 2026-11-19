// The map as text (docs/specs/toki-ui.md, W7): the keyboard and screen-reader view, and the default on narrow
// windows. Groups (or milestones in order), each box with its tech and what it links to.
import { MessageSquarePlus } from 'lucide-react';
import { cn } from '../ui';
import type { MapLayout, PlacedNode } from '../../lib/mapLayout';

export function MapList({ layout, roadmap, picked, onAsk }: { layout: MapLayout; roadmap: boolean; picked: string[]; onAsk?: (n: PlacedNode) => void }) {
  const label = new Map(layout.nodes.map((n) => [n.id, n.label]));
  const links = (id: string) => layout.edges.filter((e) => e.from === id).map((e) => label.get(e.to)).filter(Boolean).join(', ');
  const row = (n: PlacedNode) => (
    <li key={n.id} className="flex items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn('font-mono text-label lowercase [overflow-wrap:anywhere]', n.state === 'done' || n.state === 'next' ? 'text-muted' : 'text-fg', picked.includes(n.id) && 'text-accent')}>{n.label}</span>
          {n.state && <span className={cn('font-mono text-hint lowercase', n.state === 'now' ? 'text-accent' : 'text-dim')}>{n.state}</span>}
        </div>
        {n.tech && <div className="text-hint text-muted [overflow-wrap:anywhere]">{n.tech}</div>}
        {links(n.id) && <div className="text-hint text-dim [overflow-wrap:anywhere]"><span className="sr-only">Links to </span><span aria-hidden>→ </span>{links(n.id)}</div>}
      </div>
      {onAsk && (
        <button type="button" aria-label={'Ask about ' + n.label} title="Ask about it" onClick={() => onAsk(n)} className="flex h-8 w-8 shrink-0 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <MessageSquarePlus size={14} aria-hidden />
        </button>
      )}
    </li>
  );

  if (roadmap) {
    return <ol className="divide-y divide-line">{layout.nodes.map(row)}</ol>;
  }
  const groups = layout.groups.length ? layout.groups.map((g) => g.name) : [null];
  const inGroup = (g: string | null) => layout.nodes.filter((n) => g === null || (n.group?.toLowerCase() || 'other') === g);
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g ?? 'all'} aria-label={g ?? undefined}>
          {g && <h3 className="flex items-baseline gap-1.5 font-mono text-label lowercase text-dim">{g}<span className="text-hint">{inGroup(g).length}</span></h3>}
          <ul className="divide-y divide-line">{inGroup(g).map(row)}</ul>
        </section>
      ))}
    </div>
  );
}
