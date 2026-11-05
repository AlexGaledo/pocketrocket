/**
 * Settings › Projects. A project is a shared folder, and this list of who may work in it is the owner's alone: no bot
 * tool reaches it. Creating a project can also clone the development team template, with its own group chat.
 */
import { useCallback, useEffect, useState } from 'react';
import { FolderGit2, Plus, TriangleAlert } from 'lucide-react';
import { useStore } from '../../store';
import { api, type ProjectInfo, type ProjectLint } from '../../lib/api';
import { Badge, Button, Input, Label, Switch } from '../ui';
import { Card, Group, InlineError, SectionHeader } from './parts';

export function ProjectsSection() {
  const toast = useStore((s) => s.toast);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [team, setTeam] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.projects.list().then(setProjects, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.projects.create({ name: name.trim(), team });
      setName('');
      setTeam(false);
      toast(r.bots.length ? r.project.name + ' created with a team of ' + r.bots.length : r.project.name + ' created');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader title="Projects" description="Shared folders. Only the bots you list here can work in a project's folder." />
      <Group title="New project">
        <Card>
          <div className="space-y-3">
            <div>
              <Label htmlFor="project-name">Name</Label>
              <Input id="project-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Wika" />
            </div>
            <label className="flex items-center justify-between gap-3 text-ui">
              <span>
                Add a development team
                <span className="block text-hint text-muted">Three new bots and a group chat, cloned from the template.</span>
              </span>
              <Switch checked={team} onChange={setTeam} aria-label="Add a development team" />
            </label>
            <Button disabled={busy || !name.trim()} onClick={() => void create()}>
              <Plus size={14} aria-hidden /> Create project
            </Button>
          </div>
        </Card>
      </Group>
      {error && <InlineError>{error}</InlineError>}
      {projects?.length === 0 && <p className="text-ui text-muted">No projects yet.</p>}
      {projects?.map((p) => <ProjectCard key={p.slug} project={p} onChanged={load} onError={setError} />)}
    </>
  );
}

function ProjectCard({ project, onChanged, onError }: { project: ProjectInfo; onChanged: () => void; onError: (m: string) => void }) {
  const bots = useStore((s) => s.bots);
  const [lint, setLint] = useState<ProjectLint | null>(null);
  useEffect(() => { api.projects.lint(project.slug).then(setLint, () => setLint(null)); }, [project.slug, project.memberIds.length]);

  const toggle = async (botId: string, on: boolean) => {
    const memberIds = on ? [...project.memberIds, botId] : project.memberIds.filter((id) => id !== botId);
    try {
      await api.projects.setMembers(project.slug, memberIds);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <Group
      title={project.name}
      aside={project.templateVersion ? <Badge>Team template v{project.templateVersion}</Badge> : undefined}
    >
      <Card>
        <p className="flex min-w-0 items-center gap-1.5 text-hint text-muted">
          <FolderGit2 size={13} aria-hidden className="shrink-0" />
          <span className="truncate font-mono" title={project.dir}>{project.dir}</span>
        </p>
        {!!lint?.issues.length && (
          <div className="mt-3 rounded-sm border border-warn/40 p-2 text-hint">
            <p className="mb-1 flex items-center gap-1.5 text-fg"><TriangleAlert size={13} aria-hidden /> Needs a look</p>
            <ul className="space-y-0.5 text-muted">
              {lint.issues.slice(0, 5).map((i) => <li key={i.kind + i.path} className="break-words">{i.path}: {i.detail}</li>)}
              {lint.issues.length > 5 && <li>and {lint.issues.length - 5} more</li>}
            </ul>
          </div>
        )}
        <details className="mt-3 text-ui">
          <summary className="cursor-pointer select-none">
            {project.memberIds.length} {project.memberIds.length === 1 ? 'bot has' : 'bots have'} access
          </summary>
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
            {bots.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{b.name} <span className="text-dim">@{b.handle}</span></span>
                <Switch
                  checked={project.memberIds.includes(b.id)}
                  onChange={(on) => void toggle(b.id, on)}
                  aria-label={b.name + ' can work in ' + project.name}
                />
              </li>
            ))}
          </ul>
        </details>
      </Card>
    </Group>
  );
}
