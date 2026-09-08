import { useState } from 'react';
import type { Room } from '@claudebot/shared';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Button, Dialog, Input, Label, Select, cn } from '../ui';

export function RoomDialog({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const toast = useStore((s) => s.toast);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const [name, setName] = useState(room?.name ?? '');
  const [members, setMembers] = useState<string[]>(room?.memberIds ?? []);
  const [coord, setCoord] = useState<string>(room?.coordinatorBotId ?? '');
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setMembers(members.includes(id) ? members.filter((m) => m !== id) : members.length < 6 ? [...members, id] : members);
  const save = async () => {
    setBusy(true);
    try {
      const body = { kind: 'group' as const, name, memberIds: members, coordinatorBotId: coord && members.includes(coord) ? coord : null };
      const r = room ? await api.rooms.update(room.id, body) : await api.rooms.create(body);
      setActiveRoom(r.id);
      onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!room || !confirm('Delete room "' + room.name + '" and its history?')) return;
    await api.rooms.remove(room.id);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={room ? 'Edit room' : 'New group chat'}>
      <div><Label>Room name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="launch-plan" autoFocus /></div>
      <div className="mt-3">
        <Label hint={members.length + '/6'}>Members</Label>
        <div className="grid grid-cols-2 gap-1.5">
          {bots.map((b) => {
            const on = members.includes(b.id);
            return (
              <button key={b.id} type="button" onClick={() => toggle(b.id)} className={cn('flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm', on ? 'border-accent/50 bg-accent/10' : 'border-line bg-card')}>
                <span>{b.avatar}</span><span className="min-w-0 flex-1 truncate">{b.name}</span><span className="text-xs text-muted">@{b.handle}</span>
              </button>
            );
          })}
          {!bots.length && <div className="col-span-2 text-xs text-dim">Create some bots first.</div>}
        </div>
      </div>
      <div className="mt-3">
        <Label hint="handles messages with no @mention">Coordinator</Label>
        <Select value={coord} onChange={(e) => setCoord(e.target.value)}>
          <option value="">None (unaddressed messages are ignored)</option>
          {bots.filter((b) => members.includes(b.id)).map((b) => <option key={b.id} value={b.id}>{b.avatar} {b.name}</option>)}
        </Select>
      </div>
      <div className="mt-5 flex items-center justify-between">
        <div>{room && <Button variant="danger" size="sm" onClick={remove}>Delete room</Button>}</div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !name.trim() || members.length < 1}>{room ? 'Save' : 'Create'}</Button>
        </div>
      </div>
    </Dialog>
  );
}
