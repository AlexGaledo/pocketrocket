import { useState } from 'react';
import { BUILTIN_TOOLS, MODELS, DEFAULT_MODEL, type Bot, type BotInput } from '@pocketrocket/shared';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Button, Dialog, Input, Label, Select, Textarea, cn } from '../ui';

const PRESETS: { label: string; v: Partial<BotInput> }[] = [
  { label: 'Chief of staff', v: { name: 'Chief', handle: 'chief', title: 'Chief of staff / coordinator', avatar: '🧭', description: 'You coordinate the other bots. Break requests into tasks, hand them off with @handle or the handoff tool, then summarize results for Alex. If a needed role is missing, create it with create_bot (focused role, clear instructions) or add an existing bot with add_to_room. Do not do specialist work yourself when a specialist is in the room.' } },
  { label: 'Researcher', v: { name: 'Researcher', handle: 'researcher', title: 'Web research', avatar: '🔎', description: 'You research using WebSearch/WebFetch and write concise findings with sources into the shared workspace as markdown.', allowedTools: ['Read', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] } },
  { label: 'Developer', v: { name: 'Dev', handle: 'dev', title: 'Software engineer', avatar: '🛠️', description: 'You implement and test code in the shared workspace. Prefer small verified changes; run tests with Bash before reporting done.' } },
  { label: 'Writer', v: { name: 'Writer', handle: 'writer', title: 'Copy & docs', avatar: '✍️', description: 'You write and edit prose: docs, emails, posts. Keep a consistent voice; ask for the audience if unclear.', allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch'] } },
];
const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

export function BotDialog({ bot, onClose }: { bot: Bot | null; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [f, setF] = useState<BotInput>({
    name: bot?.name ?? '', handle: bot?.handle ?? '', title: bot?.title ?? '', description: bot?.description ?? '', avatar: bot?.avatar ?? '🤖',
    model: bot?.model ?? DEFAULT_MODEL, allowedTools: bot?.allowedTools ?? DEFAULT_TOOLS, maxBudgetUsd: bot?.maxBudgetUsd ?? 2,
  });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<BotInput>) => setF({ ...f, ...p });
  const autoHandle = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

  const save = async () => {
    setBusy(true);
    try {
      if (bot) await api.bots.update(bot.id, f); else await api.bots.create(f);
      onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!bot || !confirm('Delete ' + bot.name + '? Rooms keep their history; the bot is removed from them.')) return;
    await api.bots.remove(bot.id);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={bot ? 'Edit ' + bot.name : 'New bot'} wide>
      {!bot && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => <Button key={p.label} size="sm" onClick={() => set({ ...p.v, allowedTools: p.v.allowedTools ?? DEFAULT_TOOLS })}>{p.v.avatar} {p.label}</Button>)}
        </div>
      )}
      <div className="grid grid-cols-[64px_1fr_1fr] gap-3">
        <div><Label>Avatar</Label><Input value={f.avatar} onChange={(e) => set({ avatar: e.target.value })} className="text-center text-lg" maxLength={4} /></div>
        <div><Label>Name</Label><Input value={f.name} onChange={(e) => set({ name: e.target.value, handle: bot ? f.handle : autoHandle(e.target.value) })} placeholder="Researcher" autoFocus /></div>
        <div><Label hint="mention as @handle">Handle</Label><Input value={f.handle} onChange={(e) => set({ handle: e.target.value.toLowerCase() })} placeholder="researcher" className="font-mono" /></div>
      </div>
      <div className="mt-3"><Label>Title</Label><Input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="Web research & summaries" /></div>
      <div className="mt-3">
        <Label hint="becomes the bot's identity (CLAUDE.md)">Role description</Label>
        <Textarea rows={5} value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="What this bot is responsible for, how it should work, what it should avoid." />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div><Label>Model</Label><Select value={f.model} onChange={(e) => set({ model: e.target.value })}>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></div>
        <div><Label hint="stops a runaway turn">Budget per turn (USD)</Label><Input type="number" step="0.5" min="0.05" value={f.maxBudgetUsd} onChange={(e) => set({ maxBudgetUsd: Number(e.target.value) })} /></div>
      </div>
      <div className="mt-3">
        <Label hint="Browser = shared logged-in Chrome · Desktop = see/click the whole screen">Tools</Label>
        <div className="flex flex-wrap gap-1.5">
          {BUILTIN_TOOLS.filter((t) => t !== 'Skill' && t !== 'MultiEdit' && t !== 'NotebookEdit').map((t) => {
            const on = f.allowedTools.includes(t);
            return (
              <button key={t} type="button" onClick={() => set({ allowedTools: on ? f.allowedTools.filter((x) => x !== t) : [...f.allowedTools, t] })}
                className={cn('rounded-md border px-2 py-1 text-xs font-mono', on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line bg-card text-muted')}>{t}</button>
            );
          })}
        </div>
      </div>
      <div className="mt-5 flex items-center justify-between">
        <div>{bot && <Button variant="danger" size="sm" onClick={remove}>Delete bot</Button>}</div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !f.name || !/^[a-z0-9_-]{2,24}$/.test(f.handle)}>{bot ? 'Save' : 'Create bot'}</Button>
        </div>
      </div>
    </Dialog>
  );
}
