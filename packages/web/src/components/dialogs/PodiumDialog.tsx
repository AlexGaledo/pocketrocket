import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { MAX_PODIUM_BOTS } from '@pocketrocket/shared';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Avatar, Button, Dialog, Field, Label, Select } from '../ui';

/** Which bots sit on the podium, and which one may read the owner's messages across every chat. */
export function PodiumDialog({ onClose }: { onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const settings = useStore((s) => s.settings);
  const openDialog = useStore((s) => s.openDialog);
  const toast = useStore((s) => s.toast);
  const [slots, setSlots] = useState<string[]>(() =>
    Array.from({ length: MAX_PODIUM_BOTS }, (_, i) => {
      const id = settings.podiumBotIds[i];
      return id && bots.some((b) => b.id === id) ? id : '';
    }),
  );
  const [persona, setPersona] = useState(bots.some((b) => b.id === settings.personaBotId) ? settings.personaBotId : '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.settings.update({ podiumBotIds: slots.filter(Boolean), personaBotId: persona });
      onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Podium" description="Your main bots, shown large above the bot list. To change a bot's character, open its settings.">
      {slots.map((id, i) => {
        const bot = bots.find((b) => b.id === id);
        return (
          <Field key={i} className="mb-3">
            <Label>{'Spot ' + (i + 1)}</Label>
            <div className="flex items-center gap-2">
              {bot && <span aria-hidden><Avatar bot={bot} size={32} /></span>}
              <Select value={id} onChange={(e) => setSlots(slots.map((s, j) => (j === i ? e.target.value : s)))}>
                <option value="">Empty</option>
                {bots.filter((b) => b.id === id || !slots.includes(b.id)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
              {bot && <Button variant="ghost" size="icon" aria-label={bot.name + ' settings'} title="Bot settings" onClick={() => openDialog({ kind: 'bot', bot })}><Settings2 size={15} /></Button>}
            </div>
          </Field>
        );
      })}
      <Field className="mt-4">
        <Label hint="It sees what you wrote in every chat">Persona bot</Label>
        <Select value={persona} onChange={(e) => setPersona(e.target.value)}>
          <option value="">None</option>
          {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>Save</Button>
      </div>
    </Dialog>
  );
}
