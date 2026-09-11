/**
 * Settings › Claude: is Claude working, which model new bots start with, and an optional API key.
 * v1 ships one provider (Claude), so there is no picker; the provider radio cards only appear when a
 * developer build enables more than one.
 */
import { useEffect, useState } from 'react';
import { MODELS } from '@pocketrocket/shared';
import type { ModelInfo, ProviderCheck, ProviderId, ProviderInfo } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { Button, Field, Label, Select } from '../ui';
import { ProviderCard } from '../ProviderCard';
import { ApiKeyField } from './ApiKeyField';
import { ConnectionStatus } from './ConnectionStatus';
import { Card, Group, SectionHeader } from './parts';

export function ClaudeSection() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const updateSettings = useStore((s) => s.updateSettings);
  const fetchProviders = useStore((s) => s.fetchProviders);
  const [secrets, setSecrets] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.secrets.get().then((r) => setSecrets(r.keys)).catch(() => setSecrets({}));
  }, []);

  const list = providers?.providers ?? [];
  const active = list.find((p) => p.id === settings.provider) ?? list[0];
  const models: ModelInfo[] = active?.models?.length ? active.models : MODELS.map((m) => ({ id: m.id, label: m.label }));
  const multiple = list.length > 1;

  // Refetch for the source of truth, but patch the check in place now so the card updates at once.
  const patchCheck = (id: ProviderId, check: ProviderCheck) => {
    void fetchProviders();
    useStore.setState((s) => (s.providers ? { providers: { ...s.providers, providers: s.providers.providers.map((p) => (p.id === id ? { ...p, check } : p)) } } : {}));
  };

  return (
    <>
      <SectionHeader
        title={multiple ? 'Connection' : 'Claude'}
        description={multiple ? 'Which service your bots run on, and how it signs in.' : 'How PocketRocket reaches Claude.'}
      />

      <Group>
        {multiple ? (
          <ServicePicker list={list} current={settings.provider} onChecked={patchCheck} />
        ) : active ? (
          <ConnectionStatus info={active} onChecked={(check) => patchCheck(active.id, check)} hasKeyField={active.secretKeys.length > 0} />
        ) : (
          <Card><p className="text-[12.5px] text-muted">Checking Claude…</p></Card>
        )}
      </Group>

      <Group>
        <Card>
          <Field>
            <Label hint="New bots start with this">Default model</Label>
            <Select value={settings.defaultModel} onChange={(e) => void updateSettings({ defaultModel: e.target.value })}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}{m.note ? ' — ' + m.note : ''}</option>
              ))}
              {/* Keep an unknown saved value visible instead of silently showing the first option. */}
              {!models.some((m) => m.id === settings.defaultModel) && <option value={settings.defaultModel}>{settings.defaultModel}</option>}
            </Select>
          </Field>
          <p className="mt-2 text-[12px] text-muted">Each bot can use a different model; change it in the bot's settings.</p>
        </Card>
      </Group>

      {active && active.secretKeys.length > 0 && (
        <Group>
          <Card className="space-y-4">
            {active.secretKeys.map((key) => (
              <ApiKeyField key={key} keyName={key} isSet={!!secrets[key]} onSaved={setSecrets} />
            ))}
          </Card>
        </Group>
      )}
    </>
  );
}

/** Developer builds only (more than one service enabled). Switching asks first, as it resets some bots' models. */
function ServicePicker({ list, current, onChecked }: { list: ProviderInfo[]; current: ProviderId; onChecked: (id: ProviderId, check: ProviderCheck) => void }) {
  const updateSettings = useStore((s) => s.updateSettings);
  const [pending, setPending] = useState<ProviderId | null>(null);

  return (
    <>
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Service">
        {list.map((p) => (
          <ProviderCard key={p.id} info={p} selected={p.id === current} onSelect={() => p.id !== current && setPending(p.id)} onChecked={(check) => onChecked(p.id, check)} />
        ))}
      </div>
      {pending && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warn/10 px-3 py-2 text-[12.5px]">
          <span>
            Bots will switch to <strong>{list.find((p) => p.id === pending)?.label}</strong>; models not available there reset to the default.
          </span>
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={() => { void updateSettings({ provider: pending }); setPending(null); }}>Switch</Button>
          </div>
        </div>
      )}
    </>
  );
}
