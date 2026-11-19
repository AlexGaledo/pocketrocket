// "Generate map" (docs/specs/toki-ui.md, W8): a small popover that says which bot will be asked, which kind of map,
// and what it costs, then sends one ordinary message to the project's room. Only bots that have the project-map
// skill are offered, since only they know the file the app reads. Nothing is drawn until that bot writes map.json.
import { useEffect, useId, useState, type ReactElement } from 'react';
import type { Bot, Room } from '@pocketrocket/shared';
import { useStore, botById } from '../../store';
import { api } from '../../lib/api';
import { useBotStatus } from '../../lib/botStatus';
import { MAP_KIND_LABEL, generateMessage, type MapKind } from '../../lib/mapLayout';
import { Button, Popover, PopoverClose, PopoverContent, PopoverTrigger, Select, Tooltip } from '../ui';

const SKILL = 'project-map';

/** The room's bots that can draw a map, coordinator first, paused ones left out. `null` while it is being looked up. */
function useMapBots(room: Room, open: boolean): Bot[] | null {
  const bots = useStore((s) => s.bots);
  const { statusOf } = useBotStatus();
  const [able, setAble] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      try {
        const skill = (await api.skills.list()).find((k) => k.name === SKILL);
        if (!skill) { if (live) setAble(new Set()); return; }
        const has = await Promise.all(room.memberIds.map(async (id) => ((await api.bots.skills(id).catch(() => [])) as string[]).includes(skill.id) ? id : null));
        if (live) setAble(new Set(has.filter((x): x is string => !!x)));
      } catch {
        if (live) setAble(new Set());
      }
    })();
    return () => { live = false; };
  }, [open, room.memberIds]);
  if (!able) return null;
  const order = [...room.memberIds].sort((a, b) => Number(b === room.coordinatorBotId) - Number(a === room.coordinatorBotId));
  return order.filter((id) => able.has(id) && statusOf(id) !== 'paused').map((id) => botById(bots, id)).filter((b): b is Bot => !!b);
}

export function GenerateMap({ slug, room, current, trigger, tip }: { slug: string; room: Room; current: MapKind | null; trigger: ReactElement; tip?: string }) {
  const [open, setOpen] = useState(false);
  const able = useMapBots(room, open);
  const askForMap = useStore((s) => s.askForMap);
  const openPage = useStore((s) => s.openPage);
  const [botId, setBotId] = useState<string | null>(null);
  const [kind, setKind] = useState<MapKind | null>(current);
  const ids = { bot: useId(), kind: useId(), note: useId() };

  // The default kind: the map's own, else a system map when the project lists a repo, else a roadmap.
  useEffect(() => {
    if (!open || kind) return;
    let live = true;
    api.projects.repos(slug).then((r) => { if (live) setKind(r.repos.length ? 'architecture' : 'roadmap'); }, () => { if (live) setKind('roadmap'); });
    return () => { live = false; };
  }, [open, kind, slug]);

  const bot = able?.find((b) => b.id === botId) ?? able?.[0] ?? null;
  const coordinator = room.coordinatorBotId ?? room.memberIds[0] ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {tip ? <Tooltip content={tip} side="bottom"><PopoverTrigger asChild>{trigger}</PopoverTrigger></Tooltip> : <PopoverTrigger asChild>{trigger}</PopoverTrigger>}
      <PopoverContent side="bottom" align="center" className="w-80 space-y-3" aria-describedby={bot ? ids.note : undefined}>
        <div className="text-ui font-semibold">{current ? 'Redraw the map' : 'Generate map'}</div>
        {able === null ? (
          <p className="text-ui text-muted" role="status">Checking which bots can draw it…</p>
        ) : !bot ? (
          <>
            <p className="text-ui text-muted">No bot in # {room.name} has the project-map skill yet.</p>
            {coordinator && (
              <PopoverClose asChild>
                <Button size="sm" onClick={() => openPage({ kind: 'bot', botId: coordinator, tab: 'skills' })}>Add it in Skills</Button>
              </PopoverClose>
            )}
          </>
        ) : (
          <>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
              <label htmlFor={ids.bot} className="text-label text-muted">Ask</label>
              <Select id={ids.bot} value={bot.id} onChange={(e) => setBotId(e.target.value)} disabled={able.length < 2}>
                {able.map((b) => <option key={b.id} value={b.id}>@{b.handle}</option>)}
              </Select>
              <label htmlFor={ids.kind} className="text-label text-muted">Kind</label>
              <Select id={ids.kind} value={kind ?? 'architecture'} onChange={(e) => setKind(e.target.value as MapKind)}>
                {(Object.keys(MAP_KIND_LABEL) as MapKind[]).map((k) => <option key={k} value={k}>{MAP_KIND_LABEL[k]}</option>)}
              </Select>
            </div>
            <p id={ids.note} className="text-hint text-muted">Uses one turn of @{bot.handle} in # {room.name}.</p>
            <div className="flex justify-end">
              <Button variant="primary" size="sm" disabled={!kind} onClick={() => {
                askForMap(slug, bot.id, generateMessage(bot.handle, kind ?? 'architecture', !!current));
                setOpen(false);
              }}>
                Ask @{bot.handle}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
