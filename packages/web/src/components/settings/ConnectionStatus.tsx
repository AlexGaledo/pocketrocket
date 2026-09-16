/**
 * Settings › Claude: the "is Claude working?" card. It reads the provider check the hub already runs
 * (installed? version? subscription or API key?), says it in plain words, and when something is wrong
 * shows the steps to fix it plus a "Check again" button that re-runs the check.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { ProviderCheck, ProviderInfo } from '@pocketrocket/shared';
import { Badge, Button, cn } from '../ui';
import { Markdown } from '../Markdown';
import { useRecheck } from '../ProviderCard';
import { Private, maskEmail, shortPath } from './parts';

/**
 * Anthropic's native installer, per platform. Not `npm install -g`: that leaves a claude.cmd shim in
 * %APPDATA%\npm, while the hub looks for the native binary in ~/.local/bin, which is where this installs it.
 */
const INSTALL_COMMANDS = [
  { id: 'windows', label: 'Windows (PowerShell)', command: 'irm https://claude.ai/install.ps1 | iex' },
  { id: 'unix', label: 'macOS or Linux (Terminal)', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
] as const;

/** This browser's platform first. Usually the hub runs on the same computer, so that is the one they need. */
function installCommands() {
  const windows = /Windows/i.test(navigator.userAgent);
  return windows ? INSTALL_COMMANDS : [...INSTALL_COMMANDS].reverse();
}

type Tone = 'ok' | 'warn';

interface Summary {
  ok: boolean;
  tone: Tone;
  badge: string;
  headline: string;
  /** Short facts under the headline: version, how it signs in, which account. */
  facts: ReactNode[];
}

/** The signed-in address, masked until asked for. Settings is a dialog people screen-share. */
export function PrivateEmail({ email }: { email: string }) {
  return <Private value={email} display={maskEmail(email)} label="email address" />;
}

/** Where the CLI was found, with the home directory folded to `~` so it carries no user name. */
function PrivatePath({ path }: { path: string }) {
  return <Private value={path} display={shortPath(path)} label="path" />;
}

/** `claude --version` prints "2.1.3 (Claude Code)"; the parenthetical adds nothing here. */
function cleanVersion(version: string) {
  return version.replace(/\s*\(.*\)\s*$/, '');
}

/** "Using your Claude Max subscription", "Using your API key", or null when the check does not say. */
export function authPhrase(check: ProviderCheck): string | null {
  if (check.auth === 'subscription') return check.plan ? 'Using your Claude ' + check.plan + ' subscription' : 'Using your Claude subscription';
  if (check.auth === 'apiKey') return 'Using your API key';
  return null;
}

function summarize(info: ProviderInfo): Summary {
  const { check } = info;
  const app = info.id === 'claude' ? 'Claude Code' : info.label;
  const facts: ReactNode[] = [];
  if (check.version) facts.push('Version ' + cleanVersion(check.version));
  if (check.ok) {
    const how = authPhrase(check);
    if (how) facts.push(how);
    if (check.account) facts.push(<PrivateEmail email={check.account} />);
    return { ok: true, tone: 'ok', badge: 'Ready', headline: app + ' is connected', facts };
  }
  // The binary is there but did not answer: an install prompt would send the user to reinstall something
  // that is already installed, when checking again after it warms up is all it takes.
  if (check.unresponsive) return { ok: false, tone: 'warn', badge: "Didn't respond", headline: 'Found ' + app + " but it didn't respond", facts };
  // A version without ok means the app answered but is not signed in.
  if (check.version) return { ok: false, tone: 'warn', badge: 'Not signed in', headline: app + ' needs you to sign in', facts };
  return { ok: false, tone: 'warn', badge: 'Not found', headline: app + " isn't set up on this computer yet", facts };
}

export function ConnectionStatus({ info, onChecked, hasKeyField, autoRecheckMs }: {
  info: ProviderInfo;
  /** Gets the fresh check after "Check again". */
  onChecked: (check: ProviderCheck) => void;
  /** Whether an API key field sits below, so the fix-it text can point to it. */
  hasKeyField: boolean;
  /**
   * Check once on mount, then again this often for as long as the check is failing, so a user following
   * the steps in a terminal sees the card turn green without pressing anything. Off when omitted.
   */
  autoRecheckMs?: number;
}) {
  const { checking, recheck } = useRecheck(info.id, onChecked);
  const summary = summarize(info);
  const Icon = summary.ok ? CircleCheck : TriangleAlert;

  // The latest recheck in a ref, so the timers below do not restart on every render.
  const recheckRef = useRef(recheck);
  recheckRef.current = recheck;
  // Bumped when a timer fires while the window is hidden, so the next one gets scheduled anyway.
  const [skipped, setSkipped] = useState(0);
  useEffect(() => {
    if (autoRecheckMs) void recheckRef.current();
  }, [autoRecheckMs]);
  useEffect(() => {
    // Chained rather than an interval: a check can take up to 10s when the CLI is slow, and overlapping
    // ones would only pile more `claude` processes onto a machine that is already struggling.
    if (!autoRecheckMs || summary.ok || checking) return;
    const timer = setTimeout(() => {
      if (document.visibilityState === 'visible') void recheckRef.current();
      else setSkipped((n) => n + 1);
    }, autoRecheckMs);
    return () => clearTimeout(timer);
  }, [autoRecheckMs, summary.ok, checking, info.check, skipped]);

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
            <Badge tone={summary.tone}>{summary.badge}</Badge>
          </div>
          {summary.facts.length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-muted">
              {summary.facts.map((fact, i) => (
                <Fragment key={i}>
                  {i > 0 && <span aria-hidden>·</span>}
                  {fact}
                </Fragment>
              ))}
            </div>
          )}
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

// overflow-wrap:anywhere, not break-all: a narrow window wraps at the spaces first ("… install.ps1 | iex")
// and only splits the URL itself when it cannot fit on a line at all.
const codeLine = 'mt-1 block w-fit max-w-full select-all rounded-md bg-card2 px-2 py-1 font-mono text-[12px] [overflow-wrap:anywhere]';

function FixSteps({ info, check, hasKeyField }: { info: ProviderInfo; check: ProviderCheck; hasKeyField: boolean }) {
  const installed = !!check.version || !!check.unresponsive;
  const hasTechnical = !!(check.error || check.hint);
  return (
    <div className="mt-3 text-[12.5px] leading-relaxed text-fg">
      {info.id === 'claude' && check.unresponsive ? (
        <p>
          It can take a while to start the first time, or while antivirus scans it. Wait a moment and press Check again.
          {check.exePath && <span className="mt-1 block text-muted">Found at <PrivatePath path={check.exePath} /></span>}
        </p>
      ) : info.id === 'claude' ? (
        <ol className="list-decimal space-y-1 pl-5">
          {!installed && (
            <li>
              Install Claude Code. Open a terminal and run the command for your computer:
              {installCommands().map((c) => (
                <div key={c.id} className="mt-1.5">
                  <span className="text-muted">{c.label}</span>
                  {/* Its own line, and one click selects all of it for copying. */}
                  <code className={codeLine}>{c.command}</code>
                </div>
              ))}
              {check.exePath && (
                <span className="mt-1.5 block text-muted">
                  PocketRocket looked for it at <PrivatePath path={check.exePath} />
                </span>
              )}
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
      {hasKeyField && info.id === 'claude' && !check.unresponsive && (
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
