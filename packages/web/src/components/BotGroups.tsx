import * as React from 'react';
import { ChevronRight, GripVertical } from 'lucide-react';
import type { Bot, Room } from '@pocketrocket/shared';
import { cn } from './ui';

/**
 * The sidebar's bot list, grouped by the group chats they belong to.
 *
 * With a handful of bots a flat list is fine; with a fleet it buries the room you actually want. So each
 * group chat becomes a collapsible section, bots in no group fall into "Ungrouped", and both the collapse
 * state and the section order persist per browser. A bot in two rooms appears under both on purpose —
 * that is the truth about the fleet, and hiding it would make a room look emptier than it is.
 */

const ORDER_KEY = 'pocketrocket.botGroupOrder';
const COLLAPSED_KEY = 'pocketrocket.botGroupCollapsed';

/** Browser storage is a convenience here, never a source of truth: a private window or a wiped profile
 *  must degrade to "everything expanded, natural order" rather than throwing. */
function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeList(key: string, v: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable; the UI still works for this session */
  }
}

export const UNGROUPED = '__ungrouped__';

export interface BotGroup {
  key: string;
  label: string;
  bots: Bot[];
}

/** One section per group chat, plus the leftovers. Empty rooms are dropped — a header with nothing under
 *  it is just noise, and the room is still reachable from the Group chats list. */
export function buildGroups(bots: Bot[], groups: Room[]): BotGroup[] {
  const out: BotGroup[] = [];
  for (const room of groups) {
    const members = room.memberIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
    if (members.length) out.push({ key: room.id, label: room.name, bots: members });
  }
  const grouped = new Set(groups.flatMap((r) => r.memberIds));
  const rest = bots.filter((b) => !grouped.has(b.id));
  if (rest.length) out.push({ key: UNGROUPED, label: 'Ungrouped', bots: rest });
  return out;
}

/** Applies the saved order, keeping unknown/new sections in their natural position at the end. */
export function orderGroups(groups: BotGroup[], order: string[]): BotGroup[] {
  const known = new Map(groups.map((g) => [g.key, g]));
  const sorted: BotGroup[] = [];
  for (const k of order) {
    const g = known.get(k);
    if (g) {
      sorted.push(g);
      known.delete(k);
    }
  }
  return [...sorted, ...known.values()];
}

export function useBotGroups(bots: Bot[], groups: Room[]) {
  const [order, setOrder] = React.useState<string[]>(() => readList(ORDER_KEY));
  const [collapsed, setCollapsed] = React.useState<string[]>(() => readList(COLLAPSED_KEY));

  const sections = React.useMemo(() => orderGroups(buildGroups(bots, groups), order), [bots, groups, order]);

  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = c.includes(key) ? c.filter((k) => k !== key) : [...c, key];
      writeList(COLLAPSED_KEY, next);
      return next;
    });

  /** Move `key` to `to`, clamped. Used by both the drag handler and the keyboard shortcut. */
  const move = (key: string, to: number) => {
    const keys = sections.map((s) => s.key);
    const from = keys.indexOf(key);
    if (from < 0) return;
    const target = Math.max(0, Math.min(keys.length - 1, to));
    if (target === from) return;
    keys.splice(target, 0, ...keys.splice(from, 1));
    setOrder(keys);
    writeList(ORDER_KEY, keys);
  };

  return { sections, collapsed, toggle, move };
}

export function BotGroupHeader({
  group, index, count, isCollapsed, onToggle, onMove,
}: {
  group: BotGroup;
  index: number;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  onMove: (key: string, to: number) => void;
}) {
  const [over, setOver] = React.useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', group.key);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const key = e.dataTransfer.getData('text/plain');
        if (key && key !== group.key) onMove(key, index);
      }}
      className={cn(
        'group/hdr mt-2 flex items-center gap-1 rounded-lg px-2 py-1',
        over && 'bg-accent/10 ring-1 ring-accent/40',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        className="flex min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
        // Dragging is mouse-only, so the same reorder is reachable from the keyboard here.
        onKeyDown={(e) => {
          if (!e.altKey) return;
          if (e.key === 'ArrowUp') { e.preventDefault(); onMove(group.key, index - 1); }
          if (e.key === 'ArrowDown') { e.preventDefault(); onMove(group.key, index + 1); }
        }}
        title="Toggle section · Alt+↑/↓ to reorder"
      >
        <ChevronRight size={12} className={cn('shrink-0 text-dim transition-transform', !isCollapsed && 'rotate-90')} />
        <span className="truncate text-[11.5px] font-medium text-dim">{group.label}</span>
        <span className="shrink-0 text-[11px] text-dim/70">{count}</span>
      </button>
      <GripVertical size={12} aria-hidden className="shrink-0 cursor-grab text-dim/0 transition-colors group-hover/hdr:text-dim/60" />
    </div>
  );
}
