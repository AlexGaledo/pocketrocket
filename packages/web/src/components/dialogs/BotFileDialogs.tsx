// U10: bot files. "Export" saves one bot as a .json file; "Import" reads one and makes a NEW bot from it, after
// showing what is in it. The file never carries secrets, logins, approval rules, tool permissions or paths, and an
// imported skill waits for approval on the Skills tab before any bot can use it.
import { useRef, useState } from 'react';
import { Download, FileUp, Upload } from 'lucide-react';
import { BotExportSchema, MAX_BOT_EXPORT_BYTES, type Bot, type BotExport, type BotImportResult } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { Banner, Button, Dialog, Switch } from '../ui';

/** Hands `text` to the browser as a download. */
function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The two export controls shown in a bot's settings. */
export function ExportBotControls({ bot }: { bot: Bot }) {
  const toast = useStore((s) => s.toast);
  const [memory, setMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.bots.export(bot.id, memory);
      saveFile(bot.handle + '.toki-bot.json', JSON.stringify(r.file, null, 2));
      const left = r.skipped ?? [];
      const big = left.filter((k) => k.reason === 'too_big').map((k) => k.name);
      const many = left.filter((k) => k.reason === 'too_many').map((k) => k.name);
      const skippedText = (big.length ? ' Left out because it is over 64 KB: ' + big.join(', ') + '.' : '') +
        (many.length ? ' Left out because a file holds at most 20 skills: ' + many.join(', ') + '.' : '');
      setNote((r.redactions > 0
        ? r.redactions + (r.redactions === 1 ? ' secret or file path was' : ' secrets or file paths were') + ' taken out. Read the file before you share it.'
        : 'Saved. Read the file before you share it.') + skippedText);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="mt-5 rounded-lg bg-card2/40 p-3 ring-1 ring-line">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-ui">
          Share this bot
          <span className="block text-hint text-muted">A file with its name, role, picture and skills. No logins, keys, permissions or paths.</span>
        </div>
        <Button size="sm" disabled={busy} onClick={() => void run()}><Download size={14} aria-hidden /> Export</Button>
      </div>
      <label className="mt-2 flex items-center justify-between gap-3 text-ui">
        <span>Include memory notes<span className="block text-hint text-muted">Off by default. Notes can hold private details.</span></span>
        <Switch checked={memory} onChange={setMemory} aria-label="Include memory notes" />
      </label>
      {note && <p role="status" className="mt-2 text-hint text-muted">{note}</p>}
    </div>
  );
}

/** Pick a file, look at what is in it, then create the bot. */
export function ImportBotDialog({ onClose }: { onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const input = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [file, setFile] = useState<BotExport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [memory, setMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<BotImportResult | null>(null);

  const pick = async (f: File | undefined) => {
    setFile(null); setProblem(null); setRaw(null);
    if (!f) return;
    if (f.size > MAX_BOT_EXPORT_BYTES) { setProblem('That file is over 1 MB, so it is not a bot file.'); return; }
    try {
      const json: unknown = JSON.parse(await f.text());
      const r = BotExportSchema.safeParse(json);
      if (!r.success) { setProblem('This is not a Toki bot file, or it is from a newer version.'); return; }
      setRaw(json);
      setFile(r.data);
    } catch { setProblem('That file is not readable JSON.'); }
  };
  const create = async () => {
    setBusy(true);
    try { setDone(await api.bots.import(raw, memory && !!file?.memory)); }
    catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };
  const openChat = async () => {
    if (!done) return;
    try {
      const room = await api.rooms.create({ kind: 'dm', name: done.bot.name, memberIds: [done.bot.id], coordinatorBotId: null });
      setActiveRoom(room.id);
    } catch (e) { toast("Couldn't open its chat: " + (e as Error).message, true); }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Import a bot" description="Makes a new bot from a file. It never changes a bot you already have.">
      {done ? (
        <div className="space-y-3">
          <Banner tone="info" title={done.bot.name + ' is ready'}>
            {done.handleRenamed ? 'The handle was taken, so it is @' + done.bot.handle + '. ' : ''}
            {done.skills.length > 0 ? done.skills.length + (done.skills.length === 1 ? ' skill is' : ' skills are') + ' waiting for your approval on its Skills tab.' : 'It came with no skills.'}
          </Banner>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" onClick={() => void openChat()}>Open chat</Button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <input ref={input} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-label="Bot file" onChange={(e) => void pick(e.target.files?.[0])} />
          <Button onClick={() => input.current?.click()}><FileUp size={14} aria-hidden /> Choose a file</Button>
          {problem && <Banner tone="error">{problem}</Banner>}
          {file && (
            <div className="rounded-lg bg-card2/40 p-3 text-ui ring-1 ring-line">
              <div className="font-semibold">{file.bot.name} <span className="font-mono text-hint font-normal text-muted">@{file.bot.handle}</span></div>
              {file.bot.title && <div className="text-muted">{file.bot.title}</div>}
              {file.bot.description && <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-hint text-muted">{file.bot.description}</p>}
              <div className="mt-2 text-hint text-muted">
                {file.skills.length === 0 ? 'No skills.' : 'Skills (need your approval): ' + file.skills.map((s) => s.name).join(', ')}
              </div>
              {file.memory && (
                <label className="mt-3 flex items-center justify-between gap-3">
                  <span>Also copy its memory notes<span className="block text-hint text-muted">Notes shape what the bot says. Only import them from someone you trust.</span></span>
                  <Switch checked={memory} onChange={setMemory} aria-label="Also copy its memory notes" />
                </label>
              )}
              <p className="mt-3 text-hint text-dim">Read all of the instructions above: this bot will follow them. It starts with a minimal set of tools (no shell and no page fetching; you can turn those on later in its settings) and the standard budget, whatever the file says.</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!file || busy} onClick={() => void create()}><Upload size={14} aria-hidden /> Create bot</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
