import { useState } from 'react';
import { Hash, Plus, X } from 'lucide-react';
import { MAX_ROOM_BOTS } from '@pocketrocket/shared';
import type { Bot, Room } from '@pocketrocket/shared';
import { api } from '../../lib/api';
import { isWorking, useBotStatus } from '../../lib/botStatus';
import { useStore } from '../../store';
import { Avatar, Button, Dialog, Field, Input, Label, Select } from '../ui';
import { BotIconPicker } from './BotIconPicker';

/** Starting a group chat, and everything about one later: its name, its picture and its bots. */
export function RoomDialog({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const toast = useStore((s) => s.toast);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  // A bot can change the room while this is open, through add_to_room or remove_from_room.
  const latest = useStore((s) => s.rooms.find((r) => r.id === room?.id));
  const { statusOf } = useBotStatus();
  const [name, setName] = useState(room?.name ?? '');
  const [avatar, setAvatar] = useState(room?.avatar ?? '');
  const [members, setMembers] = useState<string[]>(room?.memberIds ?? []);
  const [coord, setCoord] = useState<string>(room?.coordinatorBotId ?? '');
  const [busy, setBusy] = useState(false);

  const inRoom = members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const others = bots.filter((b) => !members.includes(b.id));
  const full = members.length >= MAX_ROOM_BOTS;
  const onlyOne = members.length === 1;

  const save = async () => {
    setBusy(true);
    try {
      // Only what this dialog changed, on top of the room as it is now, so a bot's change meanwhile survives.
      const base = room?.memberIds ?? [];
      const now = latest?.memberIds ?? base;
      const memberIds = [...now.filter((id) => members.includes(id) || !base.includes(id)), ...members.filter((id) => !base.includes(id) && !now.includes(id))];
      const body = { name: name.trim(), avatar, memberIds, coordinatorBotId: coord && memberIds.includes(coord) ? coord : null };
      const r = room ? await api.rooms.update(room.id, body) : await api.rooms.create({ kind: 'group', ...body });
      setActiveRoom(r.id);
      onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!room || !confirm('Delete ' + room.name + ' and its history?')) return;
    setBusy(true);
    try {
      await api.rooms.remove(room.id);
      onClose();
    } catch (e) {
      // The dialog stays open so the failure is visible next to the button that caused it.
      toast("Couldn't delete the group chat: " + (e as Error).message, true);
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={room ? 'Group details' : 'New group chat'}>
      <Field><Label>Group chat name</Label><Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="launch-plan" autoFocus={!room} /></Field>
      <BotIconPicker botId={null} value={avatar} onChange={setAvatar} label="Group picture" hint="Shown in the sidebar and header" automatic={Hash} />

      <div className="mt-4">
        <Label id="room-members-label" hint={members.length + '/' + MAX_ROOM_BOTS}>Bots in this chat</Label>
        <ul aria-labelledby="room-members-label" className="flex flex-col gap-1">
          {inRoom.map((b) => (
            <li key={b.id} className="flex min-h-9 items-center gap-2 rounded-sm bg-card px-2 py-1 text-ui">
              <span aria-hidden><Avatar bot={b} size={24} /></span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate">{b.name}</span>
                  <span className="min-w-0 truncate text-hint text-muted">@{b.handle}</span>
                </span>
                {room && isWorking(statusOf(b.id)) && <span className="block text-hint text-warn">Working. Removing stops its work here.</span>}
              </span>
              <Button
                variant="ghost" size="icon"
                aria-label={'Remove ' + b.name}
                title={onlyOne ? 'A group needs at least one bot' : 'Remove ' + b.name}
                disabled={onlyOne}
                onClick={() => setMembers(members.filter((id) => id !== b.id))}
              ><X size={14} /></Button>
            </li>
          ))}
          {!inRoom.length && <li className="px-2 py-1 text-hint text-dim">{bots.length ? 'Add at least one bot.' : 'Create some bots first.'}</li>}
        </ul>
        {onlyOne && room && <p className="mt-1 text-hint text-muted">A group needs at least one bot.</p>}
      </div>

      {others.length > 0 && (
        <div className="mt-3">
          <Label id="room-add-label" hint={full ? 'This chat is full' : undefined}>Add a bot</Label>
          <ul aria-labelledby="room-add-label" className="flex max-h-44 flex-col gap-1 overflow-y-auto">
            {others.map((b) => (
              <li key={b.id}>
                <button
                  type="button" disabled={full} onClick={() => setMembers([...members, b.id])}
                  aria-label={'Add ' + b.name}
                  className="flex min-h-9 w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-ui hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <span aria-hidden><Avatar bot={b} size={24} /></span>
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  <span className="min-w-0 truncate text-hint text-muted">@{b.handle}</span>
                  <Plus size={14} aria-hidden className="shrink-0 text-muted" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Field className="mt-3">
        <Label hint="Answers messages with no @mention">Coordinator</Label>
        <Select value={coord && members.includes(coord) ? coord : ''} onChange={(e) => setCoord(e.target.value)}>
          <option value="">None (@mention required)</option>
          {inRoom.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      </Field>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <div>{room && <Button variant="danger" size="sm" onClick={remove} disabled={busy}>Delete group chat</Button>}</div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !name.trim() || members.length < 1}>{room ? 'Save' : 'Create'}</Button>
        </div>
      </div>
    </Dialog>
  );
}
