// Job handling for the PC runner, split out of runner.mjs so node:test can drive it with stubs (no tunnel, no dialog,
// no claude). runner.mjs wires the real pieces in; importing this file has no side effects.
//
// Two job modes:
//   new     the hub names an allowlisted folder; claude starts a fresh session there (as always).
//   resume  the hub names a mirrored session id and NO folder. The runner finds that session's transcript on this PC,
//           reads the working folder it recorded, and only goes on when that folder is (really) inside an allowlisted
//           folder. That folder's own tools and MCP servers apply, the same as for a new job there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderFor, parseJob, promptPreview, buildMcpConfig, canRunCode, isInside, SESSION_ID_RE, CONFIRM_TIMEOUT_MS } from './lib.mjs';
import { pathInfo, scanHead } from './mirror.mjs';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

export const defaultProjectsDir = (config) => config?.claudeProjectsDir || path.join(os.homedir(), '.claude', 'projects');

/**
 * Finds `<projectsDir>/<project>/<sessionId>.jsonl`. The id must be exactly a main-session id: a subagent id
 * ("<parent>:<agent>") has a colon, fails SESSION_ID_RE and is never looked up. Returns the file path or null.
 */
export function findSessionFile(projectsDir, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  const root = realOf(projectsDir);
  if (!root) return null;
  let dirs;
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
    if (!isFile(file)) continue;
    const info = pathInfo(projectsDir, file);
    if (!info || info.id !== sessionId || info.parentId) continue;
    const real = realOf(file);
    if (real && isInside(real, root)) return file; // a transcript that is really a link to somewhere else is not one
  }
  return null;
}

/**
 * Works out where a resume job may run. Both views of the session's cwd must sit inside the same allowlisted folder:
 * the written path (resolved, so a `..` can't climb out) and its real path (so a junction or symlink can't lead out).
 * Returns { ok: true, folderName, folder, cwd, title } (cwd = the path the session recorded, which is also what
 * `claude --resume` keys on) or { ok: false, why }.
 */
export async function resolveResume({ sessionId, config, projectsDir = defaultProjectsDir(config), scan = scanHead }) {
  const shown = String(sessionId ?? '').slice(0, 60);
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { ok: false, why: `"${shown}" is not a session id this runner can resume (subagent transcripts cannot be resumed).` };
  const file = findSessionFile(projectsDir, sessionId);
  if (!file) return { ok: false, why: `Session ${shown} is not on this PC (no transcript for it under ${projectsDir}).` };
  let head;
  try { head = await scan(file); } catch { return { ok: false, why: `Could not read the transcript of session ${shown}.` }; }
  const cwd = head?.cwd;
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !path.win32.isAbsolute(cwd) || /^\\\\/.test(cwd)) {
    return { ok: false, why: `Session ${shown} does not record a local working folder, so it cannot be resumed.` };
  }
  if (!isDir(cwd)) return { ok: false, why: `The working folder of session ${shown} no longer exists on this PC (${cwd}).` };
  const realCwd = realOf(cwd);
  const lexCwd = path.win32.resolve(cwd);
  if (!realCwd) return { ok: false, why: `The working folder of session ${shown} cannot be resolved (${cwd}).` };

  let best = null;
  for (const [name, f] of Object.entries(config?.folders ?? {})) {
    const realFolder = realOf(f.path);
    if (!realFolder || !isDir(f.path)) continue;
    if (!isInside(lexCwd, f.path) || !isInside(realCwd, realFolder)) continue;
    if (!best || f.path.length > best.folder.path.length) best = { name, folder: f }; // nested folders: the most specific wins
  }
  if (!best) return { ok: false, why: `The working folder of session ${shown} (${cwd}) is not inside any folder in this PC's allowlist.` };
  return { ok: true, folderName: best.name, folder: best.folder, cwd, title: head.title ?? null };
}

/**
 * The lines the Run / Refuse dialog shows above the tool list, as plain text (confirm.ps1 only displays them).
 * `resume` is the resolveResume result for a resume job.
 */
export function confirmInfoLines(job, folderName, folder, resume = null) {
  const lines = [`Bot: @${job.bot.handle}`, `Room: ${job.room.name}`];
  if (job.mode === 'resume') {
    lines.push('Mode: RESUME an existing Claude Code session on this PC');
    lines.push(`Session: ${resume?.title || '(untitled)'}`);
    lines.push(`Session id: ${job.sessionId}`);
    lines.push(`Working folder: ${resume?.cwd ?? '?'}`);
    lines.push(`Allowlist folder: ${folderName}  (${folder.path})`);
    lines.push('The earlier conversation is sent to Claude again, and the new turns are added to that same session.');
  } else {
    lines.push('Mode: start a new session');
    lines.push(`Folder: ${folderName}  (${folder.path})`);
  }
  return lines;
}

/** What goes into the confirm dialog's job file. Data only; the dialog never executes any of it. */
export function confirmPayload(job, folderName, folder, resume = null) {
  return {
    infoLines: confirmInfoLines(job, folderName, folder, resume),
    handle: job.bot.handle, room: job.room.name, folderName, folderPath: folder.path,
    mode: job.mode, prompt: job.prompt, tools: folder.allowedTools, mcpServers: folder.mcpServers, runsCode: canRunCode(folder.allowedTools),
    timeoutSec: CONFIRM_TIMEOUT_MS / 1000,
  };
}

/**
 * Handles one job from GET /jobs/next. `d` carries the real or stubbed pieces:
 *   loadConfig, mcpDefinitions(config), claudePath, confirm(payload) -> bool, startJob(id), run({folder, cwd, mcpDefs, prompt,
 *   resumeSessionId}) -> { ok, output, costUsd?, durationMs?, sessionId? }, postResult(id, result), log(event, fields).
 */
export async function handleJob(d, raw) {
  const job = parseJob(raw);
  if (!job) { d.log('job_malformed', { id: typeof raw?.id === 'string' ? raw.id.slice(0, 80) : null }); return; }
  const meta = { jobId: job.id, mode: job.mode, bot: job.bot.handle, room: job.room.name, folder: job.folder, sessionId: job.sessionId, prompt: promptPreview(job.prompt), promptChars: job.prompt.length };
  d.log('job_received', meta);
  let resolvedFolder;
  const refuse = async (why) => {
    d.log('job_refused_locally', { jobId: job.id, why });
    await d.postResult(job.id, { ok: false, refusedLocally: true, output: why, ...(resolvedFolder ? { resolvedFolder } : {}) });
  };

  // Re-read config so removing a folder takes effect right away, then re-check the allowlist.
  const fresh = d.loadConfig();
  if (!fresh.ok) return refuse('The PC runner config is invalid right now; job refused.');
  const config = fresh.config;

  let folder, cwd, resume = null;
  if (job.mode === 'resume') {
    resume = await resolveResume({ sessionId: job.sessionId, config, projectsDir: d.projectsDir?.(config) });
    if (!resume.ok) return refuse(resume.why);
    folder = resume.folder; cwd = resume.cwd; resolvedFolder = resume.folderName;
  } else {
    folder = folderFor(config, job.folder);
    if (!folder) return refuse(`Folder "${String(job.folder).slice(0, 60)}" is not in this PC's allowlist.`);
    if (!isDir(folder.path)) return refuse(`Folder "${job.folder}" does not exist on this PC.`);
    cwd = folder.path;
  }
  const folderName = resolvedFolder ?? job.folder;
  // claude.exe was resolved at start; a folder added since must not contain it.
  if (Object.values(config.folders).some((f) => isInside(d.claudePath, f.path))) {
    return refuse('claude.exe now sits inside an allowlisted folder; restart the runner after fixing config.json.');
  }
  const mcpDefs = d.mcpDefinitions(config);
  const { missing } = buildMcpConfig(folder.mcpServers, mcpDefs);
  if (missing.length) return refuse(`MCP server(s) ${missing.join(', ')} are not set up on this PC (run: node runner.mjs check).`);

  const approved = await d.confirm(confirmPayload(job, folderName, folder, resume));
  if (!approved) return refuse('Refused on the PC (Refuse pressed, dialog closed, or no answer in 10 minutes).');
  d.log('job_approved_locally', { jobId: job.id });

  try { await d.startJob(job.id); } catch (e) {
    d.log('job_start_failed', { jobId: job.id, error: e.message });
    return; // the hub didn't accept the start (cancelled, expired); don't run
  }
  const r = await d.run({ folder, cwd, mcpDefs, prompt: job.prompt, resumeSessionId: job.mode === 'resume' ? job.sessionId : undefined });
  d.log('job_finished', { jobId: job.id, ok: r.ok, costUsd: r.costUsd ?? null, durationMs: r.durationMs ?? null, outputBytes: Buffer.byteLength(r.output) });
  const result = { ok: r.ok, output: r.output };
  if (r.costUsd !== undefined) result.costUsd = r.costUsd;
  if (r.durationMs !== undefined) result.durationMs = r.durationMs;
  if (job.mode === 'resume') {
    result.resolvedFolder = resolvedFolder;
    // `claude --resume` appends to the same transcript (checked on claude 2.1.327). If a version ever forks, say so.
    if (typeof r.sessionId === 'string' && r.sessionId && r.sessionId !== job.sessionId) result.newSessionId = r.sessionId;
  }
  await d.postResult(job.id, result);
}
