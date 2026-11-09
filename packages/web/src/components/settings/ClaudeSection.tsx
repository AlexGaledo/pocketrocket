/**
 * Settings › Claude: is Claude working, which model new bots start with, and an optional API key.
 * v1 ships one provider (Claude), so there is no picker; the provider radio cards only appear when a
 * developer build enables more than one.
 */
import { useEffect, useState } from 'react';
import { AUTO_MODEL_INFO, HEAVY_MODEL_HINT, MAX_ROUTING_BYTES, MODELS, isHeavyModel, modelOptionLabel } from '@pocketrocket/shared';
import type { ModelInfo, ProviderCheck, ProviderId, ProviderInfo } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { Button, Field, Label, Select, Textarea } from '../ui';
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
  const models: ModelInfo[] = [AUTO_MODEL_INFO, ...(active?.models?.length ? active.models : MODELS.map((m) => ({ id: m.id, label: m.label })))];
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
        description={multiple ? 'Which service your bots use.' : undefined}
      />

      <Group>
        {multiple ? (
          <ServicePicker list={list} current={settings.provider} onChecked={patchCheck} />
        ) : active ? (
          <ConnectionStatus info={active} onChecked={(check) => patchCheck(active.id, check)} hasKeyField={active.secretKeys.length > 0} />
        ) : (
          <Card><p className="text-ui text-muted">Checking Claude…</p></Card>
        )}
      </Group>

      <Group>
        <Card>
          <Field>
            <Label hint="New bots start with this">Default model</Label>
            <Select value={settings.defaultModel} onChange={(e) => void updateSettings({ defaultModel: e.target.value })}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{modelOptionLabel(m)}</option>
              ))}
              {/* Keep an unknown saved value visible instead of silently showing the first option. */}
              {!models.some((m) => m.id === settings.defaultModel) && <option value={settings.defaultModel}>{settings.defaultModel}</option>}
            </Select>
          </Field>
          <p className="mt-2 text-hint text-muted">
            Each bot can override this.{isHeavyModel(settings.defaultModel) && ' This model ' + HEAVY_MODEL_HINT + '; Sonnet or Auto suits most bots.'}
          </p>
        </Card>
      </Group>

      <RoutingRulesGroup />

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
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-warn/10 px-3 py-2 text-ui">
          <span>
            Switch to <strong>{list.find((p) => p.id === pending)?.label}</strong>? Unavailable models reset to default.
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

/** The owner's routing.md. Bots read it every turn and can only propose a line, on a card. */
function RoutingRulesGroup() {
  const toast = useStore((s) => s.toast);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.routing.get().then((r) => { setSaved(r.text); setDraft(r.text); }).catch(() => undefined);
  }, []);
  if (saved === null) return null;
  const size = new TextEncoder().encode(draft).length;
  const tooLong = size > MAX_ROUTING_BYTES;
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.routing.save(draft);
      setSaved(r.text);
      toast('Routing rules saved');
    } catch (e) {
      toast("Couldn't save the rules: " + (e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Group>
      <Card>
        <Field>
          <Label hint="Bots follow these; they can only propose changes">Routing rules</Label>
          <Textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-hint" aria-invalid={tooLong} />
        </Field>
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className={tooLong ? 'text-hint text-bad' : 'text-hint text-muted'}>{size} of {MAX_ROUTING_BYTES} bytes</p>
          <Button size="sm" disabled={saving || tooLong || draft === saved} onClick={() => void save()}>Save rules</Button>
        </div>
      </Card>
    </Group>
  );
}
