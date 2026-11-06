import { useEffect, useRef, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import type { BotInput, ProviderCheck, ProviderId, ProviderInfo } from '@pocketrocket/shared';
import { useStore } from '../store';
import { api } from '../lib/api';
import { play } from '../lib/sounds';
import { Button, Input, cn } from './ui';
import { ProviderCard } from './ProviderCard';
import { AccountSignIn } from './AccountSignIn';
import { RocketMark } from './RocketMark';
import { botIcon } from '../lib/botIcon';
import { ConnectionStatus, authPhrase } from './settings/ConnectionStatus';

/** A template has no bot id yet, so its key stands in for one. */
function TemplateIcon({ id, icon }: { id: string; icon: string }) {
  const { Glyph, tint } = botIcon({ id, avatar: icon });
  return <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full text-fg" style={{ background: tint }}><Glyph size={18} strokeWidth={1.75} /></span>;
}

const TEMPLATES: { key: string; label: string; v: BotInput & { tools: string[] } }[] = [
  {
    key: 'assistant',
    label: 'Assistant',
    v: {
      name: 'Assistant', handle: 'assistant', title: 'General assistant', avatar: 'smile',
      description: 'You are a helpful general-purpose assistant. Answer questions, draft text, and help plan things.',
      model: 'claude-sonnet-5', allowedTools: ['Read', 'Write', 'WebSearch', 'WebFetch'], maxBudgetUsd: 2,
      tools: ['Read', 'Write', 'WebSearch', 'WebFetch'],
    },
  },
  {
    key: 'coder',
    label: 'Coder',
    v: {
      name: 'Coder', handle: 'coder', title: 'Software engineer', avatar: 'wrench',
      description: 'You implement and test code in the shared workspace. Prefer small verified changes; run tests with Bash before reporting done.',
      model: 'claude-sonnet-5', allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'], maxBudgetUsd: 2,
      tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    },
  },
  {
    key: 'researcher',
    label: 'Researcher',
    v: {
      name: 'Researcher', handle: 'researcher', title: 'Web research', avatar: 'search',
      description: 'You research using WebSearch/WebFetch and write concise findings with sources into the shared workspace as markdown.',
      model: 'claude-sonnet-5', allowedTools: ['Read', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], maxBudgetUsd: 2,
      tools: ['Read', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    },
  },
];

const STEPS = ['welcome', 'provider', 'connect', 'name', 'account', 'bot', 'done'] as const;
type Step = (typeof STEPS)[number];

export function Onboarding() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const account = useStore((s) => s.account);
  const updateSettings = useStore((s) => s.updateSettings);
  const setActiveRoom = useStore((s) => s.setActiveRoom);

  const [current, setCurrent] = useState<Step>('welcome');
  const [providerId, setProviderId] = useState<ProviderId>(settings.provider);
  const [name, setName] = useState(settings.userName === 'you' ? '' : settings.userName);
  const [busy, setBusy] = useState(false);
  const [botCreated, setBotCreated] = useState(false);
  /** Why the last create or finish failed. Shown in the card, where the user is looking, not only as a toast in a corner. */
  const [error, setError] = useState<string | null>(null);
  const steps: readonly Step[] = STEPS.filter((s) => {
    // With one provider (the v1 default: Claude only) there is nothing to choose, so that step is skipped.
    if (s === 'provider') return !providers || providers.providers.length > 1;
    // The account step only exists when this hub can sign people in.
    if (s === 'account') return account.enabled && (account.email || account.oauth.google || account.oauth.github);
    // 'connect' always stays: with the provider step gone, it is the only place anything checks that Claude
    // is installed and signed in before the first bot tries to run.
    return true;
  });
  // The step is tracked by name, not position: providers and account state load after the wizard opens,
  // and a step appearing or vanishing must not move the user to a different screen. If the current step
  // has just vanished, show the next one that still exists.
  const step: Step = steps.includes(current) ? current : (STEPS.slice(STEPS.indexOf(current)).find((s) => steps.includes(s)) ?? 'done');
  const idx = steps.indexOf(step);

  const chosenProvider = providers?.providers.find((p) => p.id === providerId);
  const providerReady = !!chosenProvider?.check.ok;

  const goTo = (next: Step) => { setError(null); setCurrent(next); };
  const goNext = () => goTo(steps[Math.min(steps.length - 1, idx + 1)]);
  const goBack = () => goTo(steps[Math.max(0, idx - 1)]);

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // updateSettings resolves false instead of throwing; the wizard stays open on this step so Finish can be pressed again.
    const saved = await updateSettings({ onboarded: true, userName: name.trim() || settings.userName });
    setBusy(false);
    if (saved) play('connected');
    else setError("Couldn't save. Check PocketRocket is running.");
  };

  const createBot = async (tpl: (typeof TEMPLATES)[number]) => {
    setBusy(true);
    setError(null);
    try {
      const { tools: _tools, ...input } = tpl.v;
      const bot = await api.bots.create({ ...input, model: settings.defaultModel || input.model });
      // Once the bot exists a failed DM is not worth stopping for: pressing the template again would only
      // hit "Handle already taken", and clicking the bot in the sidebar creates the DM anyway.
      const room = await api.rooms.create({ kind: 'dm', name: bot.name, memberIds: [bot.id], coordinatorBotId: null }).catch(() => null);
      if (room) setActiveRoom(room.id);
      setBotCreated(true);
      goNext();
    } catch (e) {
      setError("Couldn't create " + tpl.label + ': ' + (e as Error).message);
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
    <div className="fixed inset-0 z-[60] flex overflow-y-auto overscroll-contain bg-bg/80 backdrop-blur-sm p-4" onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-label="Set up PocketRocket">
      {/* m-auto rather than centring from the overlay: a card taller than a small window can still scroll to its top. */}
      <div className="panel m-auto flex w-[560px] max-w-full flex-col p-6 sm:p-8">
        {step === 'welcome' && (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <RocketMark />
            <div className="text-title">PocketRocket</div>
            <div className="text-ui font-medium text-muted">Your pocket fleet of AI agents</div>
            <p className="max-w-[42ch] text-ui leading-relaxed text-muted">
              AI bots that work for you. You approve risky steps.
            </p>
            <Button variant="primary" className="mt-2" autoFocus onClick={goNext}>Get started</Button>
          </div>
        )}

        {step === 'provider' && (
          <div className="flex flex-col gap-3">
            <div className="text-title-sm">Choose a service</div>
            <div className="text-ui text-muted">You can change this later.</div>
            <div className="mt-1 flex flex-col gap-2" role="radiogroup" aria-label="Service">
              {(providers?.providers ?? []).map((p) => (
                <ProviderCard key={p.id} info={p} selected={p.id === providerId} onSelect={() => setProviderId(p.id)} onChecked={() => void useStore.getState().fetchProviders()} />
              ))}
              {!providers?.providers.length && <div className="text-ui text-muted">Loading…</div>}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button className="text-ui text-muted underline underline-offset-2 hover:text-fg" onClick={() => void updateSettings({ provider: providerId }).then(goNext)}>
                Skip for now
              </button>
              <div className="flex gap-2">
                <Button onClick={goBack}>Back</Button>
                <Button variant="primary" disabled={!providerReady} onClick={() => void updateSettings({ provider: providerId }).then(goNext)}>Continue</Button>
              </div>
            </div>
          </div>
        )}

        {step === 'connect' && <ConnectStep info={chosenProvider} onBack={goBack} onNext={goNext} />}

        {step === 'name' && (
          <div className="flex flex-col gap-3">
            <div className="text-title-sm">What should bots call you?</div>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            <div className="mt-3 flex justify-end gap-2">
              <Button onClick={goBack}>Back</Button>
              <Button variant="primary" onClick={goNext}>Continue</Button>
            </div>
          </div>
        )}

        {step === 'account' && (
          <div className="flex flex-col gap-3">
            <div className="text-title-sm">Create an account</div>
            {account.signedIn && account.user ? (
              <div role="status" className="flex items-center gap-2.5 rounded-lg bg-ok/10 px-3.5 py-3 text-ui">
                <CircleCheck size={18} aria-hidden className="shrink-0 text-ok" />
                <span>You're signed in as <strong className="font-semibold">{account.user.email}</strong>.</span>
              </div>
            ) : (
              <>
                {!account.pendingEmail && (
                  <div className="text-ui leading-relaxed text-muted">
                    Optional. Everything works without an account.
                  </div>
                )}
                <div className="mt-1"><AccountSignIn autoFocus /></div>
              </>
            )}
            <div className="mt-3 flex justify-end gap-2">
              {/* Back is quiet here so "Skip for now" reads as the way forward for most people. */}
              <Button variant="ghost" onClick={goBack}>Back</Button>
              {account.signedIn
                ? <Button variant="primary" autoFocus onClick={goNext}>Continue</Button>
                : <Button onClick={goNext}>Skip for now</Button>}
            </div>
          </div>
        )}

        {step === 'bot' && (
          <div className="flex flex-col gap-3">
            <div className="text-title-sm">Create your first bot</div>
            <div className="text-ui text-muted">You can change it any time.</div>
            <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  disabled={busy}
                  onClick={() => void createBot(t)}
                  className={cn('flex flex-col items-center gap-1.5 rounded-lg bg-card2/50 p-3 text-center hover:bg-hover disabled:opacity-50')}
                >
                  <TemplateIcon id={t.key} icon={t.v.avatar} />
                  <span className="text-label">{t.label}</span>
                  <span className="text-hint text-muted">@{t.v.handle}</span>
                  <span className="text-hint leading-snug text-dim">{t.v.title}</span>
                  <span className="mt-1 flex flex-wrap justify-center gap-1">
                    {t.v.tools.slice(0, 4).map((tool) => <span key={tool} className="rounded-xs bg-card px-1.5 py-0.5 font-mono text-hint text-muted">{tool}</span>)}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button className="text-ui text-muted underline underline-offset-2 hover:text-fg" onClick={goNext}>I'll do it later</button>
              <Button onClick={goBack}>Back</Button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <RocketMark size={56} />
            <div className="text-title-sm">You're all set</div>
            <p className="max-w-[38ch] text-ui text-muted">
              {botCreated ? "Your first bot is ready — say hi." : 'Create a bot whenever you like from the sidebar.'}
            </p>
            <Button variant="primary" autoFocus disabled={busy} onClick={() => void finish()}>
              {busy ? 'Saving…' : error ? 'Try again' : 'Start using PocketRocket'}
            </Button>
          </div>
        )}

        {error && (
          <div role="alert" className="mt-4 rounded-md bg-bad/10 px-3.5 py-2.5 text-ui leading-relaxed text-bad">
            {error}
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

/**
 * "Connect Claude": the provider check as a setup step. It checks again every few seconds while it is
 * failing, so someone following the install steps in a terminal sees it pass without pressing anything.
 * Continue waits for a check made since the step opened: the list's cached answer can be a minute old,
 * or a placeholder when GET /api/providers failed.
 */
function ConnectStep({ info, onBack, onNext }: { info: ProviderInfo | undefined; onBack: () => void; onNext: () => void }) {
  const [fresh, setFresh] = useState(false);
  const continueRef = useRef<HTMLButtonElement>(null);
  const label = info?.label ?? 'Claude';
  const ready = fresh && !!info?.check.ok;

  const onChecked = (check: ProviderCheck) => {
    setFresh(true);
    if (!info) return;
    useStore.setState((s) => (s.providers ? { providers: { ...s.providers, providers: s.providers.providers.map((p) => (p.id === info.id ? { ...p, check } : p)) } } : {}));
  };

  // Keyboard users land on the way forward the moment it opens up.
  useEffect(() => {
    if (ready) continueRef.current?.focus();
  }, [ready]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-title-sm">Connect {label}</div>
      <div className="text-ui text-muted">
        {!info || info.id === 'claude'
          ? 'Checking Claude Code is installed and signed in.'
          : 'Checking ' + label + ' is installed and signed in.'}
      </div>
      {!info ? (
        <div role="status" className="text-ui text-muted">Checking {label}…</div>
      ) : ready ? (
        <div role="status" className="flex items-center gap-2.5 rounded-lg bg-ok/10 px-3.5 py-3 text-ui">
          <CircleCheck size={18} aria-hidden className="shrink-0 text-ok" />
          <span className="min-w-0 break-words">{connectedLine(label, info.check)}</span>
        </div>
      ) : (
        <ConnectionStatus info={info} onChecked={onChecked} hasKeyField={false} autoRecheckMs={4000} />
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        {/* An API key instead of a subscription, or sorting it out later: nothing else in setup depends on this. */}
        <button className="text-ui text-muted underline underline-offset-2 hover:text-fg" onClick={onNext}>
          Skip for now
        </button>
        <div className="flex gap-2">
          <Button onClick={onBack}>Back</Button>
          <Button ref={continueRef} variant="primary" disabled={!ready} onClick={onNext}>Continue</Button>
        </div>
      </div>
    </div>
  );
}

/** "Signed in as alex@example.com · Claude Max", or how it signs in when the provider reports no email. */
function connectedLine(label: string, check: ProviderCheck): string {
  if (check.account) return 'Signed in as ' + check.account + (check.plan ? ' · ' + label + ' ' + check.plan : '');
  return authPhrase(check) ?? label + ' is ready';
}
