import { useState } from 'react';
import { MAX_ROOM_BOTS } from '@pocketrocket/shared';
import type { Room } from '@pocketrocket/shared';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Button, Dialog, Field, Input, Label, Select, cn } from '../ui';

export function RoomDialog({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const toast = useStore((s) => s.toast);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const [name, setName] = useState(room?.name ?? '');
  const [members, setMembers] = useState<string[]>(room?.memberIds ?? []);
  const [coord, setCoord] = useState<string>(room?.coordinatorBotId ?? '');
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setMembers(members.includes(id) ? members.filter((m) => m !== id) : members.length < MAX_ROOM_BOTS ? [...members, id] : members);
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
    setBusy(true);
    try {
      await api.rooms.remove(room.id);
      onClose();
    } catch (e) {
      // The dialog stays open so the failure is visible next to the button that caused it.
      toast("Couldn't delete the room: " + (e as Error).message, true);
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={room ? 'Edit room' : 'New group chat'}>
      <Field><Label>Room name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="launch-plan" autoFocus /></Field>
      <div className="mt-3">
        <Label id="room-members-label" hint={members.length + '/' + MAX_ROOM_BOTS}>Members</Label>
        <div role="group" aria-labelledby="room-members-label" className="grid grid-cols-2 gap-1.5">
          {bots.map((b) => {
            const on = members.includes(b.id);
            return (
              <button key={b.id} type="button" aria-pressed={on} onClick={() => toggle(b.id)} className={cn('flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60', on ? 'border-accent/50 bg-accent/10' : 'border-line bg-card')}>
                <span aria-hidden>{b.avatar}</span><span className="min-w-0 flex-1 truncate">{b.name}</span><span className="text-xs text-muted">@{b.handle}</span>
              </button>
            );
          })}
          {!bots.length && <div className="col-span-2 text-xs text-dim">Create some bots first.</div>}
        </div>
      </div>
      <Field className="mt-3">
        <Label hint="handles messages with no @mention">Coordinator</Label>
        <Select value={coord} onChange={(e) => setCoord(e.target.value)}>
          <option value="">None (unaddressed messages are ignored)</option>
          {bots.filter((b) => members.includes(b.id)).map((b) => <option key={b.id} value={b.id}>{b.avatar} {b.name}</option>)}
        </Select>
      </Field>
      <div className="mt-5 flex items-center justify-between">
        <div>{room && <Button variant="danger" size="sm" onClick={remove} disabled={busy}>Delete room</Button>}</div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !name.trim() || members.length < 1}>{room ? 'Save' : 'Create'}</Button>
        </div>
      </div>
    </Dialog>
  );
}
