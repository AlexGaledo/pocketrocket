import { useState } from 'react';
import type { BotInput, ProviderId } from '@pocketrocket/shared';
import { useStore } from '../store';
import { api } from '../lib/api';
import { play } from '../lib/sounds';
import { Button, Input, cn } from './ui';
import { ProviderCard } from './ProviderCard';

const ROCKET_SVG = (
  <svg viewBox="0 0 1024 1024" width="88" height="88">
    <circle cx="512" cy="512" r="512" fill="#111214" />
    <g transform="translate(512 512) rotate(45) translate(-512 -512)" fill="#FFFFFF">
      <path d="M512 176c96 0 168 128 168 336v168H344V512c0-208 72-336 168-336z" />
      <path d="M344 560l-96 96v128l96-64zM680 560l96 96v128l-96-64z" />
      <circle cx="512" cy="452" r="58" fill="#111214" />
      <circle cx="512" cy="452" r="34" fill="#FFFFFF" />
      <path d="M440 680h144l24 56H416z" />
    </g>
    <circle cx="318" cy="742" r="46" fill="#FFFFFF" opacity="0.9" />
    <circle cx="236" cy="808" r="30" fill="#FFFFFF" opacity="0.6" />
  </svg>
);

const TEMPLATES: { key: string; label: string; v: BotInput & { tools: string[] } }[] = [
  {
    key: 'assistant',
    label: 'Assistant',
    v: {
      name: 'Assistant', handle: 'assistant', title: 'General assistant', avatar: '🙂',
      description: 'You are a helpful general-purpose assistant. Answer questions, draft text, and help plan things.',
      model: 'claude-sonnet-5', allowedTools: ['Read', 'Write', 'WebSearch', 'WebFetch'], maxBudgetUsd: 2,
      tools: ['Read', 'Write', 'WebSearch', 'WebFetch'],
    },
  },
  {
    key: 'coder',
    label: 'Coder',
    v: {
      name: 'Coder', handle: 'coder', title: 'Software engineer', avatar: '🛠️',
      description: 'You implement and test code in the shared workspace. Prefer small verified changes; run tests with Bash before reporting done.',
      model: 'claude-sonnet-5', allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'], maxBudgetUsd: 2,
      tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    },
  },
  {
    key: 'researcher',
    label: 'Researcher',
    v: {
      name: 'Researcher', handle: 'researcher', title: 'Web research', avatar: '🔎',
      description: 'You research using WebSearch/WebFetch and write concise findings with sources into the shared workspace as markdown.',
      model: 'claude-sonnet-5', allowedTools: ['Read', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], maxBudgetUsd: 2,
      tools: ['Read', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    },
  },
];

const STEPS = ['welcome', 'provider', 'name', 'bot', 'done'] as const;
type Step = (typeof STEPS)[number];

export function Onboarding() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const updateSettings = useStore((s) => s.updateSettings);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const toast = useStore((s) => s.toast);

  const [stepIdx, setStepIdx] = useState(0);
  const [providerId, setProviderId] = useState<ProviderId>(settings.provider);
  const [name, setName] = useState(settings.userName === 'you' ? '' : settings.userName);
  const [busy, setBusy] = useState(false);
  const [botCreated, setBotCreated] = useState(false);
  // With one provider (the v1 default: Claude only) there is nothing to choose, so that step is skipped.
  const steps: readonly Step[] = providers && providers.providers.length <= 1 ? STEPS.filter((s) => s !== 'provider') : STEPS;
  const idx = Math.min(stepIdx, steps.length - 1);
  const step: Step = steps[idx];

  const chosenProvider = providers?.providers.find((p) => p.id === providerId);
  const providerReady = !!chosenProvider?.check.ok;

  const goNext = () => setStepIdx((i) => Math.min(steps.length - 1, i + 1));
  const goBack = () => setStepIdx((i) => Math.max(0, i - 1));

  const finish = async () => {
    await updateSettings({ onboarded: true, userName: name.trim() || settings.userName });
    play('connected');
  };

  const createBot = async (tpl: (typeof TEMPLATES)[number]) => {
    setBusy(true);
    try {
      const { tools: _tools, ...input } = tpl.v;
      const bot = await api.bots.create({ ...input, model: settings.defaultModel || input.model });
      const room = await api.rooms.create({ kind: 'dm', name: bot.name, memberIds: [bot.id], coordinatorBotId: null });
      setActiveRoom(room.id);
      setBotCreated(true);
      goNext();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'TEXTAREA') return;
    if (step === 'welcome') { e.preventDefault(); goNext(); }
    else if (step === 'provider' && providerReady) { e.preventDefault(); void updateSettings({ provider: providerId }).then(goNext); }
    else if (step === 'name') { e.preventDefault(); goNext(); }
    else if (step === 'done') { e.preventDefault(); void finish(); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/80 backdrop-blur-sm p-4" onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-label="Set up PocketRocket">
      <div className="panel flex w-[560px] max-w-full flex-col p-8">
        {step === 'welcome' && (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            {ROCKET_SVG}
            <div className="text-[22px] font-semibold tracking-tight">PocketRocket</div>
            <div className="text-[13.5px] font-medium text-muted">Your pocket fleet of AI agents</div>
            <p className="max-w-[42ch] text-[13.5px] leading-relaxed text-muted">
              PocketRocket runs a small team of AI bots on your machine. Message them directly, put a few in a group chat to hand off work, and approve anything risky before it happens.
            </p>
            <Button variant="primary" className="mt-2" autoFocus onClick={goNext}>Get started</Button>
          </div>
        )}

        {step === 'provider' && (
          <div className="flex flex-col gap-3">
            <div className="text-[17px] font-semibold tracking-tight">Choose a provider</div>
            <div className="text-[12.5px] text-muted">Bots run through this provider. You can change it later in Settings.</div>
            <div className="mt-1 flex flex-col gap-2" role="radiogroup" aria-label="Provider">
              {(providers?.providers ?? []).map((p) => (
                <ProviderCard key={p.id} info={p} selected={p.id === providerId} onSelect={() => setProviderId(p.id)} onChecked={() => void useStore.getState().fetchProviders()} />
              ))}
              {!providers?.providers.length && <div className="text-[12.5px] text-muted">Loading providers…</div>}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button className="text-[12.5px] text-muted underline underline-offset-2 hover:text-fg" onClick={() => void updateSettings({ provider: providerId }).then(goNext)}>
                Skip for now
              </button>
              <div className="flex gap-2">
                <Button onClick={goBack}>Back</Button>
                <Button variant="primary" disabled={!providerReady} onClick={() => void updateSettings({ provider: providerId }).then(goNext)}>Continue</Button>
              </div>
            </div>
          </div>
        )}

        {step === 'name' && (
          <div className="flex flex-col gap-3">
            <div className="text-[17px] font-semibold tracking-tight">What should bots call you?</div>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            <div className="mt-3 flex justify-end gap-2">
              <Button onClick={goBack}>Back</Button>
              <Button variant="primary" onClick={goNext}>Continue</Button>
            </div>
          </div>
        )}

        {step === 'bot' && (
          <div className="flex flex-col gap-3">
            <div className="text-[17px] font-semibold tracking-tight">Create your first bot</div>
            <div className="text-[12.5px] text-muted">Pick a template — you can customize it any time.</div>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  disabled={busy}
                  onClick={() => void createBot(t)}
                  className={cn('flex flex-col items-center gap-1.5 rounded-2xl bg-card2/50 p-3 text-center hover:bg-card2 disabled:opacity-50')}
                >
                  <span aria-hidden className="text-2xl">{t.v.avatar}</span>
                  <span className="text-[12.5px] font-medium">{t.label}</span>
                  <span className="text-[11px] text-muted">@{t.v.handle}</span>
                  <span className="text-[11px] leading-snug text-dim">{t.v.title}</span>
                  <span className="mt-1 flex flex-wrap justify-center gap-1">
                    {t.v.tools.slice(0, 4).map((tool) => <span key={tool} className="rounded-full bg-card px-1.5 py-0.5 font-mono text-[9.5px] text-muted">{tool}</span>)}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button className="text-[12.5px] text-muted underline underline-offset-2 hover:text-fg" onClick={goNext}>I'll do it later</button>
              <Button onClick={goBack}>Back</Button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ok/15 text-2xl">🚀</div>
            <div className="text-[17px] font-semibold tracking-tight">You're all set</div>
            <p className="max-w-[38ch] text-[13.5px] text-muted">
              {botCreated ? "Your first bot is ready — say hi." : 'Create a bot whenever you like from the sidebar.'}
            </p>
            <Button variant="primary" autoFocus onClick={() => void finish()}>Start using PocketRocket</Button>
          </div>
        )}

        <div className="mt-6 flex items-center justify-center gap-1.5">
          {steps.map((s, i) => (
            <span key={s} className={cn('h-1.5 rounded-full transition-all', i === idx ? 'w-5 bg-ink' : 'w-1.5 bg-line')} />
          ))}
        </div>
      </div>
    </div>
  );
}
