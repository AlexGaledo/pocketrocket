// The Bot page: one bot's memory and voice, skills, automations and computer. It takes over the main pane, so
// these get a whole column instead of a 340px tab, and the right side stays the screen only.
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, MessageSquare, Plus, RefreshCw, Save, Settings2, Trash2, X } from 'lucide-react';
import type { Bot, ComputerStatus, Skill } from '@pocketrocket/shared';
import { useStore, botById, selectActiveRoom, type BotTab } from '../store';
import { api, ApiError } from '../lib/api';
import { hasComputer } from '../lib/screenView';
import { Avatar, Badge, Button, Input, Label, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, cn, confirmAction } from './ui';
import { VoicePanel } from './VoicePanel';
import { TrainingSection } from './TrainingSection';
import { SkillGitImport } from './SkillGitImport';
import { TriggersSection } from './TriggersSection';
import { TeachBar } from './TeachControls';
import { avatarStatus, useBotStatus } from '../lib/botStatus';
import { ReflectionSetting, SkillVersionsPanel } from './SkillVersions';
import { PageBody, RoutinesSection } from './FleetPages';

export function BotPage({ botId, tab }: { botId: string; tab: BotTab }) {
  const bot = useStore((s) => botById(s.bots, botId));
  const rooms = useStore((s) => s.rooms);
  const device = useStore((s) => s.device);
  const openPage = useStore((s) => s.openPage);
  const closePage = useStore((s) => s.closePage);
  const openDialog = useStore((s) => s.openDialog);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const { statusOf } = useBotStatus();
  if (!bot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-ui text-muted">
        This bot no longer exists.
        <Button onClick={closePage}><ArrowLeft size={14} aria-hidden /> Back to chat</Button>
      </div>
    );
  }
  const dm = rooms.find((r) => r.kind === 'dm' && r.memberIds[0] === bot.id);
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 px-5 max-md:pl-14">
        <Button variant="ghost" size="icon" title="Back to chat" aria-label="Back to chat" onClick={closePage}><ArrowLeft size={16} /></Button>
        <Avatar bot={bot} {...avatarStatus(statusOf(bot.id))} size={30} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-body font-semibold" title={bot.name}>{bot.name}</h1>
          <div className="truncate text-hint text-muted">{bot.title || '@' + bot.handle}</div>
        </div>
        {dm && <Button size="sm" variant="ghost" title="Open chat" aria-label={'Open chat with ' + bot.name} onClick={() => { closePage(); setActiveRoom(dm.id); }}><MessageSquare size={14} aria-hidden /><span className="@max-[480px]:hidden">Chat</span></Button>}
        {!device && <Button size="sm" variant="ghost" title="Bot settings" aria-label={bot.name + ' settings'} onClick={() => openDialog({ kind: 'bot', bot })}><Settings2 size={14} aria-hidden /><span className="@max-[480px]:hidden">Settings</span></Button>}
      </header>
      <Tabs value={tab} onValueChange={(v) => openPage({ kind: 'bot', botId: bot.id, tab: v as BotTab })} className="flex min-h-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-[var(--page-max)]">
          <TabsList>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="automations">Automations</TabsTrigger>
            <TabsTrigger value="computer">Computer</TabsTrigger>
          </TabsList>
        </div>
        <PageBody>
          <TabsContent value="memory"><MemoryTab botId={bot.id} /><VoicePanel botId={bot.id} /><TrainingSection key={bot.id} botId={bot.id} /></TabsContent>
          <TabsContent value="skills"><SkillsTab botId={bot.id} /></TabsContent>
          <TabsContent value="automations"><RoutinesSection botId={bot.id} /><TriggersSection botId={bot.id} /></TabsContent>
          <TabsContent value="computer"><ComputerTab bot={bot} /></TabsContent>
        </PageBody>
      </Tabs>
    </>
  );
}

const gbText = (b: number) => (b / 1024 ** 3).toFixed(1) + ' GB';

/** What is true of the computer whether or not anyone is looking at it. The screen itself stays on the right. */
function ComputerTab({ bot }: { bot: Bot }) {
  const toast = useStore((s) => s.toast);
  const [c, setC] = useState<ComputerStatus | null>(null);
  const [refused, setRefused] = useState('');
  const pushed = useStore((s) => s.computers[bot.id]);
  const load = useCallback(() => {
    api.screen(bot.id).then((s) => setC(s.computer?.perBot ? s.computer : null)).catch(() => undefined);
  }, [bot.id]);
  useEffect(load, [load, pushed]);
  const setAlwaysOn = async (on: boolean) => {
    setRefused('');
    try {
      setC(await api.computers.keepAwake(bot.id, on));
    } catch (e) {
      // The hub's answer says what to do next, and it belongs beside the switch.
      if (e instanceof ApiError && e.status === 409) setRefused(e.message);
      else toast("Couldn't change Always on: " + (e as Error).message, true);
    }
  };
  const used = c && c.quotaBytes > 0 ? c.diskBytes / c.quotaBytes : 0;
  return (
    <div className="flex flex-col gap-3 py-3 text-hint">
      {c ? (
        <div className="flex flex-wrap items-center gap-2 px-3">
          {c.slot !== null && (
            <Badge tone={used >= 1 ? 'bad' : used >= 0.8 ? 'warn' : 'muted'}>
              <span title="Disk used (soft limit)">{gbText(c.diskBytes)} / {gbText(c.quotaBytes)}</span>
            </Badge>
          )}
          {hasComputer(bot) && (
            <>
              <span id="always-on-label" className="ml-auto text-muted">Always on</span>
              <Switch aria-labelledby="always-on-label" checked={c.keepAwake} onChange={(on) => void setAlwaysOn(on)} />
              <p className="w-full text-right text-dim">
                Stays running and restarts with the server{c.alwaysOn ? ' · ' + c.alwaysOn.used + ' of ' + c.alwaysOn.limit + ' in use' : ''}
              </p>
            </>
          )}
          {refused && <p role="alert" className="w-full text-right text-bad">{refused}</p>}
          {c.keepAwake && c.state === 'asleep' && c.reason && <p className="w-full text-right text-bad">{c.reason}</p>}
        </div>
      ) : (
        <p className="px-3 text-muted">This server has no per-bot computers, so Browser and Desktop are off.</p>
      )}
      <TeachBar bot={bot} />
      <p className="px-3 text-dim">Bots with shell access can read each other's files and logins.</p>
    </div>
  );
}

function MemoryTab({ botId }: { botId: string }) {
  const live = useStore((s) => s.memory[botId]);
  const toast = useStore((s) => s.toast);
  // Where "this chat" is for the reset: the open chat if the bot is in it, otherwise the bot's own DM.
  const room = useStore((s) => {
    const open = selectActiveRoom(s);
    return open?.memberIds.includes(botId) ? open : s.rooms.find((r) => r.kind === 'dm' && r.memberIds[0] === botId) ?? null;
  });
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    api.bots.memory(botId).then((r) => { setText(r.text); setDirty(false); }).catch(() => undefined);
  }, [botId]);
  useEffect(() => {
    if (live !== undefined && !dirty) setText(live);
  }, [live, dirty]);
  const save = async () => {
    // On failure the edit stays dirty, so nothing the user typed is lost and Save stays available.
    try {
      await api.bots.setMemory(botId, text);
      setDirty(false);
      toast('Memory saved');
    } catch (e) {
      toast("Couldn't save memory: " + (e as Error).message, true);
    }
  };
  const reset = async () => {
    if (!room) return;
    if (!(await confirmAction({ title: 'Reset chat context?', body: 'The bot forgets this chat. Its memory stays.', confirmLabel: 'Reset' }))) return;
    await api.bots.resetSession(botId, room.id);
    toast('Chat context reset');
  };
  return (
    <div className="flex flex-col gap-2 p-3">
      <Label hint="Only this bot reads it">Memory</Label>
      <Textarea value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} rows={18} className="font-mono text-hint" placeholder="Empty. The bot adds notes, or edit here." />
      <div className="flex items-center justify-between">
        <Button size="sm" variant="ghost" onClick={reset} disabled={!room} title={room ? 'Bot forgets ' + room.name + '. Memory stays.' : 'No chat with this bot yet'}><RefreshCw size={13} /> Reset chat context</Button>
        <Button size="sm" variant="primary" onClick={save} disabled={!dirty}><Save size={13} /> Save</Button>
      </div>
    </div>
  );
}

function SkillsTab({ botId }: { botId: string }) {
  const toast = useStore((s) => s.toast);
  // P6: refetch when a version is proposed or decided (also from another window or a reflection pass).
  const skillsRev = useStore((s) => s.skillsRev);
  const bots = useStore((s) => s.bots);
  const [pool, setPool] = useState<Skill[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [importable, setImportable] = useState<{ name: string; description: string }[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [view, setView] = useState<(Skill & { markdown: string }) | null>(null);
  const [nw, setNw] = useState({ name: '', description: '', markdown: '' });

  const load = async () => {
    try {
      const [p, a, i] = await Promise.all([api.skills.list(), api.bots.skills(botId), api.skills.importable()]);
      setPool(p); setAssigned(new Set(a)); setImportable(i);
    } catch (e) {
      toast("Couldn't load skills: " + (e as Error).message, true);
    }
  };
  useEffect(() => { void load(); }, [botId, skillsRev]);

  const toggle = async (id: string) => {
    const prev = assigned;
    const next = new Set(assigned);
    if (next.has(id)) next.delete(id); else next.add(id);
    setAssigned(next);
    try {
      await api.bots.setSkills(botId, [...next]);
    } catch (e) {
      // The checkbox flipped optimistically; put it back so it matches what the hub actually has.
      setAssigned(prev);
      toast("Couldn't update skills: " + (e as Error).message, true);
    }
  };
  const doImport = async (names: string[]) => {
    await api.skills.import(names);
    toast('Imported ' + names.length + ' skill' + (names.length === 1 ? '' : 's'));
    setShowImport(false);
    await load();
  };
  const review = async (s: Skill, status: 'approved' | 'pending') => { await api.skills.review(s.id, status); await load(); };
  const remove = async (s: Skill) => { if (await confirmAction({ title: 'Delete ' + s.name + '?', body: 'It is removed for all bots.', confirmLabel: 'Delete', danger: true })) { await api.skills.remove(s.id); await load(); } };
  const createSkill = async () => {
    try { await api.skills.create(nw.name, nw.description, nw.markdown); setShowNew(false); setNw({ name: '', description: '', markdown: '' }); await load(); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-y-1">
        <Label hint={assigned.size + " assigned to this bot"}>Skills</Label>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => setShowNew(!showNew)}><Plus size={13} /> New</Button>
          <Button size="sm" variant="ghost" onClick={() => setShowImport(!showImport)} disabled={!importable.length} title={importable.length ? 'Import from ~/.claude/skills' : 'Nothing left to import'}>Import ({importable.length})</Button>
          <Button size="sm" variant="ghost" onClick={() => setShowGit(!showGit)} aria-expanded={showGit} title="Imported skills wait for your review.">From git</Button>
        </div>
      </div>
      {showGit && <SkillGitImport onDone={load} onClose={() => setShowGit(false)} />}

      {showNew && (
        <div className="flex flex-col gap-2 rounded-lg bg-card2/60 p-2">
          <Input placeholder="name-like-this" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />
          <Input placeholder="description: when to use it" value={nw.description} onChange={(e) => setNw({ ...nw, description: e.target.value })} />
          <Textarea placeholder="Instructions (markdown)" rows={6} value={nw.markdown} onChange={(e) => setNw({ ...nw, markdown: e.target.value })} className="font-mono text-hint" />
          <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button><Button size="sm" variant="primary" onClick={createSkill} disabled={!nw.name || !nw.markdown}>Create</Button></div>
        </div>
      )}
      {showImport && (
        <div className="max-h-64 overflow-y-auto rounded-lg bg-card2/60 p-1">
          <div className="flex justify-end px-1 py-1"><Button size="sm" variant="ghost" onClick={() => doImport(importable.map((i) => i.name))}>Import all</Button></div>
          {importable.map((i) => (
            <div key={i.name} className="flex items-center gap-2 rounded-sm px-2 py-1 text-hint hover:bg-hover">
              <div className="min-w-0 flex-1"><div className="font-medium">{i.name}</div><div className="truncate text-muted">{i.description}</div></div>
              <Button size="sm" onClick={() => doImport([i.name])}>Import</Button>
            </div>
          ))}
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {pool.map((s) => (
          <li key={s.id} className={cn('rounded-lg bg-card2/60 p-2 text-hint', s.reviewStatus === 'pending' && 'border border-warn/40')}>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={assigned.has(s.id)} onChange={() => toggle(s.id)} disabled={s.reviewStatus === 'pending'} aria-label={'Assign ' + s.name + ' to this bot'} title={s.reviewStatus === 'pending' ? 'Approve first' : 'Assign to this bot'} />
              <button className="min-w-0 flex-1 text-left" onClick={async () => setView(await api.skills.get(s.id))}>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5"><span className="min-w-0 truncate font-medium">{s.name}</span>
                  {s.source === 'bot' && <Badge tone={s.reviewStatus === 'pending' ? 'warn' : 'accent'}>{s.reviewStatus === 'pending' ? 'review' : 'by ' + (botById(bots, s.createdByBot)?.handle ?? 'bot')}</Badge>}
                  {s.source === 'imported' && (s.reviewStatus === 'pending' ? <Badge tone="warn">review</Badge> : <Badge>imported</Badge>)}
                  {!!s.pendingVersions && <Badge tone="warn">{s.pendingVersions === 1 ? '1 version to review' : s.pendingVersions + ' versions to review'}</Badge>}
                </div>
                <div className="truncate text-muted">{s.description}</div>
              </button>
              {s.reviewStatus === 'pending' ? (
                <>
                  <Button size="icon" variant="ghost" title="Approve" onClick={() => review(s, 'approved')}><Check size={13} className="text-ok" /></Button>
                  <Button size="icon" variant="ghost" title="Reject & delete" onClick={() => remove(s)}><X size={13} className="text-bad" /></Button>
                </>
              ) : (
                <Button size="icon" variant="ghost" title="Delete for all bots" onClick={() => remove(s)}><Trash2 size={13} /></Button>
              )}
            </div>
          </li>
        ))}
        {!pool.length && <li className="py-4 text-center text-hint text-dim">No skills yet. Import or create one.</li>}
      </ul>
      {/* P6: opt-in post-run reflection for this bot */}
      <ReflectionSetting botId={botId} />

      {view && (
        <div className="rounded-lg bg-card2/60 p-2">
          <div className="mb-1 flex items-center justify-between text-hint"><span className="font-medium">{view.name}/SKILL.md</span><Button size="sm" variant="ghost" onClick={() => setView(null)}>Close</Button></div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-hint text-muted">{view.markdown}</pre>
          {/* P6: versions with a diff, Approve / Reject, and corrections */}
          <SkillVersionsPanel skill={view} onChanged={async () => { await load(); setView(await api.skills.get(view.id)); }} />
        </div>
      )}
    </div>
  );
}
