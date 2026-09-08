import { useEffect, useState } from 'react';
import { MODELS } from '@pocketrocket/shared';
import type { ProviderId, ProviderCheck, ModelInfo } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { preview, type Cue } from '../../lib/sounds';
import { Button, Dialog, Input, Label, Select } from '../ui';
import { ProviderCard } from '../ProviderCard';

const CUES: { id: Cue; label: string }[] = [
  { id: 'send', label: 'Send' },
  { id: 'receive', label: 'Reply arrives' },
  { id: 'approvalRequest', label: 'Approval needed' },
  { id: 'approve', label: 'Approve' },
  { id: 'deny', label: 'Deny' },
  { id: 'done', label: 'Turn done' },
  { id: 'error', label: 'Turn error' },
  { id: 'connected', label: 'Connected' },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const updateSettings = useStore((s) => s.updateSettings);
  const fetchProviders = useStore((s) => s.fetchProviders);

  const [pendingProvider, setPendingProvider] = useState<ProviderId | null>(null);
  const [name, setName] = useState(settings.userName);
  const [secretsStatus, setSecretsStatus] = useState<Record<string, boolean>>({});
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});

  useEffect(() => setName(settings.userName), [settings.userName]);
  useEffect(() => {
    api.secrets.get().then((r) => setSecretsStatus(r.keys)).catch(() => setSecretsStatus({}));
  }, []);

  const active = providers?.providers.find((p) => p.id === settings.provider) ?? providers?.providers[0];
  const activeModels: ModelInfo[] = active?.models?.length ? active.models : MODELS.map((m) => ({ id: m.id, label: m.label }));

  const patchCheck = (id: ProviderId, check: ProviderCheck) => {
    void fetchProviders();
    // optimistic local patch so the pill updates before the refetch lands
    useStore.setState((s) => (s.providers ? { providers: { ...s.providers, providers: s.providers.providers.map((p) => (p.id === id ? { ...p, check } : p)) } } : {}));
  };

  const chooseProvider = (id: ProviderId) => {
    if (id === settings.provider) return;
    setPendingProvider(id);
  };
  const confirmProvider = () => {
    if (!pendingProvider) return;
    void updateSettings({ provider: pendingProvider });
    setPendingProvider(null);
  };

  const saveSecret = (key: string) => {
    const value = secretDrafts[key] ?? '';
    void api.secrets.update({ [key]: value }).then((r) => {
      setSecretsStatus(r.keys);
      setSecretDrafts((d) => ({ ...d, [key]: '' }));
    });
  };
  const clearSecret = (key: string) => {
    void api.secrets.update({ [key]: '' }).then((r) => setSecretsStatus(r.keys));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Settings" wide>
      <div className="flex flex-col gap-6">
        <section>
          <div className="mb-2 text-[12.5px] font-semibold text-fg">Provider</div>
          <div className="flex flex-col gap-2" role="radiogroup">
            {(providers?.providers ?? []).map((p) => (
              <ProviderCard key={p.id} info={p} selected={p.id === settings.provider} onSelect={() => chooseProvider(p.id)} onChecked={(check) => patchCheck(p.id, check)} />
            ))}
            {!providers?.providers.length && <div className="text-[12.5px] text-muted">Loading providers…</div>}
          </div>
          {pendingProvider && (
            <div className="mt-2 flex items-center justify-between rounded-xl bg-warn/10 px-3 py-2 text-[12.5px]">
              <span>
                Bots will switch to <strong>{providers?.providers.find((p) => p.id === pendingProvider)?.label}</strong>; models not available there reset to the default.
              </span>
              <div className="flex shrink-0 gap-1.5 pl-3">
                <Button size="sm" variant="ghost" onClick={() => setPendingProvider(null)}>Cancel</Button>
                <Button size="sm" variant="primary" onClick={confirmProvider}>Switch</Button>
              </div>
            </div>
          )}
        </section>

        <section>
          <Label hint="used for new bots">Default model</Label>
          <Select value={settings.defaultModel} onChange={(e) => void updateSettings({ defaultModel: e.target.value })}>
            {activeModels.map((m) => (
              <option key={m.id} value={m.id}>{m.label}{m.note ? ' — ' + m.note : ''}</option>
            ))}
          </Select>
        </section>

        {active && active.secretKeys.length > 0 && (
          <section>
            <div className="mb-2 text-[12.5px] font-semibold text-fg">API keys</div>
            <div className="flex flex-col gap-2">
              {active.secretKeys.map((key) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="w-40 shrink-0 font-mono text-[12.5px] text-fg">{key}</span>
                  <Input
                    type="password"
                    placeholder={secretsStatus[key] ? 'Set — enter a new value to replace' : 'Not set'}
                    value={secretDrafts[key] ?? ''}
                    onChange={(e) => setSecretDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  />
                  <Button size="sm" onClick={() => saveSecret(key)} disabled={!secretDrafts[key]}>Save</Button>
                  {secretsStatus[key] && <Button size="sm" variant="ghost" onClick={() => clearSecret(key)}>Clear</Button>}
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <Label>You</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== settings.userName && void updateSettings({ userName: name.trim() })} placeholder="Your name" />
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12.5px] font-semibold text-fg">Sounds</span>
            <button
              className={`relative h-6 w-10 rounded-full transition-colors ${settings.sounds ? 'bg-ink' : 'bg-card2'}`}
              role="switch"
              aria-checked={settings.sounds}
              onClick={() => void updateSettings({ sounds: !settings.sounds })}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-panel shadow transition-transform ${settings.sounds ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CUES.map((c) => (
              <Button key={c.id} size="sm" onClick={() => preview(c.id)}>{c.label}</Button>
            ))}
          </div>
        </section>

        <section>
          <Label>Theme</Label>
          <div className="flex gap-0.5 rounded-full bg-card2 p-0.5">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                className={`flex-1 rounded-full py-1.5 text-[12.5px] font-medium capitalize ${settings.theme === t ? 'bg-panel text-fg shadow-[var(--shadow)]' : 'text-muted hover:text-fg'}`}
                onClick={() => void updateSettings({ theme: t })}
              >
                {t}
              </button>
            ))}
          </div>
        </section>
      </div>
    </Dialog>
  );
}
