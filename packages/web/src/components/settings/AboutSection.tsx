/**
 * Settings › About: version, a couple of facts from GET /api/health and the Claude check, and links out. Deliberately small.
 * Links open with `target="_blank"`; the desktop app hands those to the default browser.
 */
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { HealthResponse } from '../../lib/api';
import { useStore } from '../../store';
import { RocketMark } from '../RocketMark';
import { authPhrase, PrivateEmail } from './ConnectionStatus';
import { Card, Group, SectionHeader } from './parts';

const REPO_URL = 'https://github.com/AlexGaledo/pocketrocket';
const LINKS: { href: string; label: string }[] = [
  { href: REPO_URL + '/releases', label: 'Check for updates' },
  { href: 'https://pocketrocket-chi.vercel.app', label: 'Website' },
  { href: REPO_URL, label: 'GitHub' },
];

export function AboutSection({ health }: { health: HealthResponse | null }) {
  // The account, plan and the path to the CLI come from the provider check, not health: health answers
  // without the hub token, so the hub keeps who is signed in — and where their home directory is — off it.
  const claudeCheck = useStore((s) => s.providers?.providers.find((p) => p.id === 'claude')?.check);
  const signedIn = claudeCheck?.ok ? claudeCheck : undefined;
  const how = signedIn ? authPhrase(signedIn) : null;

  return (
    <>
      <SectionHeader title="About" />

      <Group>
        <div className="flex items-center gap-4">
          <RocketMark size={52} />
          <div>
            <div className="text-[15px] font-semibold tracking-tight">PocketRocket</div>
            <div className="text-[12.5px] text-muted">{health?.version ? 'Version ' + health.version : 'Version unknown'}</div>
            <div className="text-[12.5px] text-muted">Your pocket fleet of AI agents.</div>
          </div>
        </div>
      </Group>

      {health && (
        <Group>
          <Card className="py-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[12.5px]">
              <Fact label="Claude Code">{health.ok ? 'Found' : 'Not found'}</Fact>
              {(signedIn?.account || how) && (
                <Fact label="Claude account">
                  {signedIn?.account ? <PrivateEmail email={signedIn.account} /> : how}
                  {signedIn?.account && how && <span className="text-muted"> · {how}</span>}
                </Fact>
              )}
              <Fact label="Approvals">
                {health.approvals === 'ask' ? 'Ask before risky actions' : 'Run without asking'}
                {health.approvalsLocked && <span className="text-muted"> · set by the server</span>}
              </Fact>
            </dl>
          </Card>
        </Group>
      )}

      <Group>
        <div className="flex flex-wrap gap-2">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-card2 px-3.5 text-[12.5px] font-medium text-fg hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel dark:hover:brightness-110"
            >
              {l.label}
              <ExternalLink size={12} aria-hidden className="text-muted" />
            </a>
          ))}
        </div>
        <p className="mt-4 text-[12px] text-muted">
          Free and open source under the{' '}
          <a href={REPO_URL + '/blob/main/LICENSE'} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
            MIT License
          </a>
          .
        </p>
      </Group>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-fg">{children}</dd>
    </>
  );
}
