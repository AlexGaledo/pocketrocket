/**
 * Settings › Claude: the "is Claude working?" card. It reads the provider check the hub already runs
 * (installed? version? subscription or API key?), says it in plain words, and when something is wrong
 * shows the steps to fix it plus a "Check again" button that re-runs the check.
 */
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { ProviderCheck, ProviderInfo } from '@pocketrocket/shared';
import { Badge, Button, cn } from '../ui';
import { Markdown } from '../Markdown';
import { useRecheck } from '../ProviderCard';

/** Terminal command that installs Claude Code, split where it may wrap; shown in the fix-it steps. */
const INSTALL_COMMAND_PARTS = ['npm install -g', '@anthropic-ai/claude-code'] as const;

interface Summary {
  ok: boolean;
  badge: string;
  headline: string;
  /** Short facts under the headline: version, how it signs in. */
  facts: string[];
}

/** `claude --version` prints "2.1.3 (Claude Code)"; the parenthetical adds nothing here. */
function cleanVersion(version: string) {
  return version.replace(/\s*\(.*\)\s*$/, '');
}

function summarize(info: ProviderInfo): Summary {
  const { check } = info;
  const app = info.id === 'claude' ? 'Claude Code' : info.label;
  const facts: string[] = [];
  if (check.version) facts.push('Version ' + cleanVersion(check.version));
  if (check.ok) {
    if (check.auth === 'subscription') facts.push('Using your Claude subscription');
    if (check.auth === 'apiKey') facts.push('Using your API key');
    if (check.account) facts.push(check.account);
    return { ok: true, badge: 'Ready', headline: app + ' is connected', facts };
  }
  // A version without ok means the app answered but is not signed in.
  if (check.version) return { ok: false, badge: 'Not signed in', headline: app + ' needs you to sign in', facts };
  return { ok: false, badge: 'Not found', headline: app + " isn't set up on this computer yet", facts };
}

export function ConnectionStatus({ info, onChecked, hasKeyField }: {
  info: ProviderInfo;
  /** Gets the fresh check after "Check again". */
  onChecked: (check: ProviderCheck) => void;
  /** Whether an API key field sits below, so the fix-it text can point to it. */
  hasKeyField: boolean;
}) {
  const { checking, recheck } = useRecheck(info.id, onChecked);
  const summary = summarize(info);
  const Icon = summary.ok ? CircleCheck : TriangleAlert;
  const checkButton = (className: string) => (
    <Button size="sm" className={className} onClick={() => void recheck()} disabled={checking}>
      {checking ? 'Checking…' : 'Check again'}
    </Button>
  );

  return (
    <div className="rounded-2xl bg-card2/40 p-4 ring-1 ring-line">
      <div className="flex items-start gap-3">
        <Icon size={20} aria-hidden className={cn('mt-0.5 shrink-0', summary.ok ? 'text-ok' : 'text-warn')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13.5px] font-medium">{summary.headline}</span>
            <Badge tone={summary.ok ? 'ok' : 'warn'}>{summary.badge}</Badge>
          </div>
          {summary.facts.length > 0 && <div className="mt-0.5 text-[12.5px] text-muted">{summary.facts.join(' · ')}</div>}
          {!summary.ok && <FixSteps info={info} check={info.check} hasKeyField={hasKeyField} />}
          {/* Narrow window: the button goes under the text instead of squeezing it. */}
          {checkButton('mt-3 sm:hidden')}
        </div>
        {/* max-sm:hidden, not "hidden sm:inline-flex": Button already carries inline-flex, and a variant always beats a plain utility. */}
        {checkButton('shrink-0 max-sm:hidden')}
      </div>
    </div>
  );
}

function FixSteps({ info, check, hasKeyField }: { info: ProviderInfo; check: ProviderCheck; hasKeyField: boolean }) {
  const installed = !!check.version;
  const hasTechnical = !!(check.error || check.hint);
  return (
    <div className="mt-3 text-[12.5px] leading-relaxed text-fg">
      {info.id === 'claude' ? (
        <ol className="list-decimal space-y-1 pl-5">
          {!installed && (
            <li>
              Install Claude Code. Open PowerShell or Terminal and run:
              {/* Its own line, and one click selects all of it for copying. Each half is unbreakable, so a narrow
                  window wraps it only at the space, never inside "@anthropic-ai". */}
              <code className="mt-1 block w-fit max-w-full select-all rounded-md bg-card2 px-2 py-1 font-mono text-[12px]">
                <span className="whitespace-nowrap">{INSTALL_COMMAND_PARTS[0]}</span>{' '}
                <span className="whitespace-nowrap">{INSTALL_COMMAND_PARTS[1]}</span>
              </code>
            </li>
          )}
          <li>
            Run <code className="rounded-md bg-card2 px-1.5 py-0.5 font-mono text-[12px]">claude</code> once and sign in with your Claude account.
          </li>
          <li>Come back here and press Check again.</li>
        </ol>
      ) : (
        check.hint && <div className="md"><Markdown>{check.hint}</Markdown></div>
      )}
      {hasKeyField && info.id === 'claude' && (
        <p className="mt-2 text-muted">No Claude subscription? Add an API key below instead.</p>
      )}
      {hasTechnical && info.id === 'claude' && (
        <details className="mt-2 text-muted">
          <summary className="cursor-pointer select-none text-[12px] hover:text-fg">Technical details</summary>
          <div className="mt-1 space-y-1 text-[11.5px] text-dim">
            {/* The error can hold a Windows path; plain text keeps its backslashes intact. */}
            {check.error && <p className="break-all font-mono">{check.error}</p>}
            {check.hint && <div className="md"><Markdown>{check.hint}</Markdown></div>}
          </div>
        </details>
      )}
    </div>
  );
}
