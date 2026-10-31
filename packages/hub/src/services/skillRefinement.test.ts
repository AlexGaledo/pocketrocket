import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Message, ModelInfo, RecordingInfo, TraceEvent } from '@pocketrocket/shared';
import { SKILLS_DIR, botPluginDir } from '../config.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { hasColumn } from '../db/migrations.js';
import { SkillService, withFrontmatter } from './SkillService.js';
import { UsageTracker, type TurnUsage } from './UsageTracker.js';
import { DISTILL_BUDGET_USD, SkillDistiller, extractSkillMd, oneShotOptions, pickName, traceText, type OneShotOptions } from './SkillDistiller.js';
import { REFLECTION_PASS_BUDGET_USD, SkillReflection, parseReflection, skillsUsed } from './SkillReflection.js';
import { lineDiff } from './lineDiff.js';
import type { PassOutcome } from './AutoMemory.js';

/** P6 (6.2, 6.3): skill versions, distilling a recording, corrections, and opt-in reflection. Never applied silently. */

const uniq = 'p6' + process.pid.toString(36);
const names: string[] = [];
const name = (s: string) => { const n = uniq + '-' + s; names.push(n); return n; };
const bots: string[] = [];
afterAll(() => {
  for (const n of names) {
    fs.rmSync(path.join(SKILLS_DIR, n), { recursive: true, force: true });
    fs.rmSync(path.join(SKILLS_DIR, '.versions', n), { recursive: true, force: true });
  }
  for (const b of bots) fs.rmSync(botPluginDir(b), { recursive: true, force: true });
});

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const skills = new SkillService(repos);
  const usage = new UsageTracker(repos);
  const bot = repos.createBot({ name: 'Shopper', handle: 'shopper', title: '', description: 'Buys things', avatar: '🛒', model: 'auto', allowedTools: ['Browser'], maxBudgetUsd: 2 });
  bots.push(bot.id);
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  return { repos, skills, usage, bot, room };
}

const ZERO: TurnUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: undefined, durationMs: 1 };
function fakeLlm(reply: string | ((prompt: string) => string), cost = 0.03) {
  const calls: { prompt: string; o: OneShotOptions }[] = [];
  const run = async (prompt: string, o: OneShotOptions): Promise<PassOutcome> => {
    calls.push({ prompt, o });
    return { ok: true, text: typeof reply === 'function' ? reply(prompt) : reply, usage: { ...ZERO, costUsd: cost, inputTokens: 1000, outputTokens: 200 } };
  };
  return { run, calls };
}

const SKILL_V1 = (n: string) => '---\nname: ' + n + '\ndescription: Export the monthly report\n---\n\n# Export\n\n## Steps\n1. Open https://app.example/reports\n2. Click the "Download" link\n';

describe('migrations 60-63', () => {
  it('add version, parent_id and the reflection tables', () => {
    const db = new Db(':memory:');
    for (const c of ['version', 'parent_id', 'origin', 'note', 'created_at', 'decided_at']) expect(hasColumn(db.raw, 'skills', c)).toBe(true);
    expect(db.all("SELECT name FROM sqlite_master WHERE name IN ('skill_reflection','skill_reflection_runs')")).toHaveLength(2);
  });
});

describe('skill versions', () => {
  it('a proposal is pending and changes nothing until approved; approve applies it, reject keeps it as history', () => {
    const { repos, skills, bot } = setup();
    const n = name('export');
    const live = skills.save(n, 'Export the monthly report', SKILL_V1(n), { source: 'authored' });
    repos.setBotSkills(bot.id, [live.id]);
    skills.materialize(bot.id, bot.handle);
    const pluginMd = path.join(botPluginDir(bot.id), 'skills', n, 'SKILL.md');

    const v2 = skills.proposeVersion(live.id, SKILL_V1(n).replace('Click the "Download" link', 'Click the "Export" button'), { origin: 'correction', note: 'no, use the Export button' });
    expect(v2).toMatchObject({ skillId: live.id, version: 2, status: 'pending', origin: 'correction', note: 'no, use the Export button' });
    // Nothing applied: pool file, DB row and the bot's copy are as they were.
    expect(skills.readMarkdown(repos.getSkill(live.id)!)).toContain('"Download" link');
    expect(fs.readFileSync(pluginMd, 'utf8')).toContain('"Download" link');
    expect(repos.getSkill(live.id)!.version).toBe(1);
    // The pool lists the skill once, with its pending count; the version row is not a pool skill.
    const pool = repos.listSkills().filter((s) => s.name.startsWith(n));
    expect(pool).toEqual([expect.objectContaining({ id: live.id, pendingVersions: 1, version: 1, parentId: null })]);

    const d = skills.versionDetail(live.id, v2.id)!;
    expect(d.diff.filter((l) => l.op !== ' ')).toEqual([
      { op: '-', text: '2. Click the "Download" link' },
      { op: '+', text: '2. Click the "Export" button' },
    ]);
    expect(d.stale).toBe(false);

    const v3 = skills.proposeVersion(live.id, SKILL_V1(n) + '3. Check the file is in Downloads\n', { origin: 'reflection', note: 'add a check' });
    expect(v3.version).toBe(3);

    const out = skills.decideVersion(live.id, v2.id, 'approve');
    expect(out.version.status).toBe('approved');
    expect(out.skill.version).toBe(2);
    expect(skills.readMarkdown(out.skill)).toContain('"Export" button');
    expect(fs.readFileSync(pluginMd, 'utf8')).toContain('"Export" button');
    // v3 was proposed against v1, so it is now stale; rejecting keeps it listed.
    expect(skills.versionDetail(live.id, v3.id)!.stale).toBe(true);
    skills.decideVersion(live.id, v3.id, 'reject');
    expect(skills.listVersions(live.id).map((v) => [v.version, v.status])).toEqual([[3, 'rejected'], [2, 'approved']]);
    expect(() => skills.decideVersion(live.id, v3.id, 'approve')).toThrow(/already rejected/);
    expect(skills.readMarkdown(repos.getSkill(live.id)!)).not.toContain('Check the file');

    skills.remove(live.id);
    expect(skills.listVersions(live.id)).toEqual([]);
    expect(fs.existsSync(path.join(SKILLS_DIR, '.versions', n))).toBe(false);
  });

  it('a bot saving over an existing skill proposes a version instead of rewriting it', () => {
    const { repos, skills, bot } = setup();
    const n = name('saved');
    const live = skills.save(n, 'Export', SKILL_V1(n), { source: 'authored' });
    const again = skills.save(n, 'Export', 'Just click around until it works.', { source: 'bot', createdByBot: bot.id });
    expect(again.id).toBe(live.id);
    expect(again.reviewStatus).toBe('approved');
    expect(skills.readMarkdown(again)).toBe(SKILL_V1(n));
    const [v] = skills.listVersions(live.id);
    expect(v).toMatchObject({ status: 'pending', origin: 'bot', createdByBot: bot.id });
    expect(repos.listSkills().filter((s) => s.name.startsWith(n))).toHaveLength(1);
  });

  it('refuses an unchanged proposal and caps pending versions', () => {
    const { skills } = setup();
    const n = name('capped');
    const live = skills.save(n, 'Export', SKILL_V1(n), { source: 'authored' });
    expect(() => skills.proposeVersion(live.id, SKILL_V1(n), { origin: 'correction' })).toThrow(/same as the live/);
    for (let i = 0; i < 10; i++) skills.proposeVersion(live.id, SKILL_V1(n) + 'step ' + i + '\n', { origin: 'reflection' });
    expect(() => skills.proposeVersion(live.id, SKILL_V1(n) + 'one more\n', { origin: 'reflection' })).toThrow(/10 versions waiting/);
  });

  it('a version can never rename its skill', () => {
    expect(withFrontmatter('---\nname: other-skill\ndescription: d\n---\nbody', 'mine', 'x')).toBe('---\nname: mine\ndescription: d\n---\nbody');
    expect(withFrontmatter('# Title\nbody', 'mine', 'Does it')).toBe('---\nname: mine\ndescription: Does it\n---\n\n# Title\nbody');
  });

  it('lineDiff keeps common lines and marks the rest', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'x' }, { op: ' ', text: 'c' }, { op: '+', text: 'd' },
    ]);
  });
});

// ---- distill (6.2) ----
const REC_ID = '2026-11-01T09-30-00-000Z';
function fakeRecorder(trace: TraceEvent[], state: RecordingInfo['state'] = 'stopped') {
  const linked: string[] = [];
  const info: RecordingInfo = {
    id: REC_ID, botId: 'b', title: 'Export the monthly report', startedAt: 1, endedAt: 2, state,
    events: trace.length, frames: 0, framesDropped: 0, bytes: 0, capped: [], skillId: null,
  };
  return {
    linked,
    get: (_b: string, id: string) => (id === REC_ID ? info : null),
    readTrace: () => trace,
    setSkill: (_b: string, _id: string, skillId: string) => { linked.push(skillId); },
  };
}
const TRACE: TraceEvent[] = [
  { ts: 0, t: 'start', title: 'Export the monthly report' },
  { ts: 100, t: 'nav', url: 'https://app.example/login' },
  { ts: 900, t: 'type', target: { role: 'textbox', label: 'Email', selector: '#email' }, value: 'me@example.com' },
  { ts: 1500, t: 'type', target: { role: 'textbox', label: 'Password', selector: '#pwd' }, value: '«secret»', secret: true },
  { ts: 1900, t: 'click', target: { role: 'button', label: 'Export', selector: '[data-testid="export"]' }, x: 1, y: 2 },
  { ts: 2500, t: 'download', file: 'report-2026-10.csv', url: 'https://app.example/r.csv' },
  { ts: 2600, t: 'frame', file: 'frames/00001.png' },
];
const MODELS: ModelInfo[] = [
  { id: 'claude-opus-5', label: 'Opus 5' }, { id: 'claude-sonnet-5', label: 'Sonnet 5 (default)', default: true }, { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

describe('SkillDistiller', () => {
  it('turns a recording into a pending bot-authored skill with a Sonnet one-shot under $0.25', async () => {
    const { repos, skills, usage, bot } = setup();
    const n = name('monthly-export');
    const llm = fakeLlm('Here you go:\n```markdown\n---\nname: ' + n + '\ndescription: Download the monthly report as CSV\n---\n# Monthly export\n## Parameters\n- `{month}`\n## Steps\n1. Log in (password: use request_takeover)\n2. Click the button named "Export"\n## Checks\n- report-{month}.csv is in Downloads\n```');
    const rec = fakeRecorder(TRACE);
    const d = new SkillDistiller({ repos, skills, recorder: rec, usage, activeProvider: () => 'claude', exeExists: () => true, run: llm.run, models: () => MODELS });
    const out = await d.distill(bot.id, REC_ID);
    expect(out.version).toBeNull();
    expect(out.skill).toMatchObject({ name: n, source: 'bot', reviewStatus: 'pending', createdByBot: bot.id, description: 'Download the monthly report as CSV' });
    expect(skills.readMarkdown(out.skill)).toMatch(/^---\nname: [\s\S]*## Steps/);
    expect(rec.linked).toEqual([out.skill.id]);

    const call = llm.calls[0];
    expect(call.o).toMatchObject({ model: 'claude-sonnet-5', budgetUsd: DISTILL_BUDGET_USD });
    expect(call.o.budgetUsd).toBeLessThanOrEqual(0.25);
    expect(call.prompt).toContain('click button "Export" [[data-testid="export"]]');
    expect(call.prompt).toContain('type into textbox "Password" [#pwd]: "«secret»"');
    expect(call.prompt).not.toContain('frames/');
    // The pass is on the bill.
    expect(repos.usageTotals({ botId: bot.id }).costUsd).toBeCloseTo(0.03);
    // A pending skill is not given to any bot.
    repos.setBotSkills(bot.id, [out.skill.id]);
    expect(skills.materialize(bot.id, bot.handle)).toBeNull();
  });

  it('re-teaching a skill already in the pool proposes a pending version of it', async () => {
    const { repos, skills, usage, bot } = setup();
    const n = name('reteach');
    const live = skills.save(n, 'Export', SKILL_V1(n), { source: 'authored' });
    const llm = fakeLlm('---\nname: ' + n + '\ndescription: Export v2\n---\n# Export\n1. Use the Export button\n');
    const d = new SkillDistiller({ repos, skills, recorder: fakeRecorder(TRACE), usage, activeProvider: () => 'claude', exeExists: () => true, run: llm.run });
    const out = await d.distill(bot.id, REC_ID, { name: n });
    expect(out.skill.id).toBe(live.id);
    expect(out.version).toMatchObject({ status: 'pending', origin: 'demo', version: 2 });
    expect(skills.readMarkdown(repos.getSkill(live.id)!)).toBe(SKILL_V1(n));
  });

  it('turns a correction into a new pending version, never applying it', async () => {
    const { repos, skills, usage } = setup();
    const n = name('corrected');
    const live = skills.save(n, 'Export', SKILL_V1(n), { source: 'authored' });
    const llm = fakeLlm((p) => {
      const cur = p.match(/<current_skill>\n([\s\S]*?)\n<\/current_skill>/)![1];
      return cur.replace('Click the "Download" link', 'Click the "Export" button');
    });
    const d = new SkillDistiller({ repos, skills, recorder: fakeRecorder([]), usage, activeProvider: () => 'claude', exeExists: () => true, run: llm.run });
    const v = await d.correct(live.id, 'no, use the Export button', null);
    expect(v).toMatchObject({ status: 'pending', origin: 'correction', note: 'no, use the Export button', version: 2 });
    expect(llm.calls[0].prompt).toContain('<correction>\nno, use the Export button\n</correction>');
    expect(llm.calls[0].o.budgetUsd).toBeLessThanOrEqual(0.25);
    expect(skills.readMarkdown(repos.getSkill(live.id)!)).toContain('"Download" link');
    expect(skills.versionDetail(live.id, v.id)!.diff.some((l) => l.op === '+' && l.text.includes('"Export" button'))).toBe(true);
    // The same correction again yields the same text: refused, not a duplicate.
    skills.decideVersion(live.id, v.id, 'approve');
    await expect(d.correct(live.id, 'no, use the Export button', null)).rejects.toThrow(/same as the live/);
  });

  it('refuses before spending: not stopped yet, empty trace, other provider, no CLI', async () => {
    const { repos, skills, usage, bot } = setup();
    const llm = fakeLlm('x');
    const mk = (rec: ReturnType<typeof fakeRecorder>, over: Record<string, unknown> = {}) =>
      new SkillDistiller({ repos, skills, recorder: rec, usage, activeProvider: () => 'claude', exeExists: () => true, run: llm.run, ...over });
    await expect(mk(fakeRecorder(TRACE, 'recording')).distill(bot.id, REC_ID)).rejects.toThrow(/Press Done/);
    await expect(mk(fakeRecorder([{ ts: 0, t: 'start' }])).distill(bot.id, REC_ID)).rejects.toThrow(/no steps/);
    await expect(mk(fakeRecorder(TRACE), { activeProvider: () => 'codex' }).distill(bot.id, REC_ID)).rejects.toThrow(/Claude provider/);
    await expect(mk(fakeRecorder(TRACE), { exeExists: () => false }).distill(bot.id, REC_ID)).rejects.toThrow(/CLI/);
    await expect(mk(fakeRecorder(TRACE)).distill(bot.id, 'nope')).rejects.toThrow(/not found/);
    expect(llm.calls).toHaveLength(0);
  });

  it('runs the one-shot with no tools, no settings, no MCP, in a temp folder, under its budget', () => {
    const o = oneShotOptions(new AbortController(), { model: 'claude-sonnet-5', budgetUsd: 0.25, system: 's' });
    expect(o).toMatchObject({ cwd: os.tmpdir(), tools: [], allowedTools: [], mcpServers: {}, settingSources: [], plugins: [], skills: [], maxTurns: 1, maxBudgetUsd: 0.25, model: 'claude-sonnet-5', persistSession: false });
  });

  it('helpers: SKILL.md extraction, names, trace text', () => {
    expect(extractSkillMd('Sure!\n---\nname: a-b\ndescription: d\n---\n# T\nsteps')).toBe('---\nname: a-b\ndescription: d\n---\n# T\nsteps\n');
    expect(extractSkillMd('I cannot help with that.')).toBeNull();
    expect(pickName(undefined, 'Bad Name!', 'x')).toBe('bad-name');
    expect(pickName('-', '')).toBeNull();
    const long = traceText(Array.from({ length: 3000 }, (_, i) => ({ ts: i, t: 'click' as const, target: { role: 'button', label: 'Next page ' + i } })));
    expect(long.length).toBeLessThan(41_000);
    expect(long).toContain('characters of the middle left out');
  });
});

// ---- reflection (6.3) ----
function toolMsg(repos: Repos, roomId: string, botId: string, turnId: string, nameArg: string): Message {
  return repos.insertMessage({ roomId, authorType: 'bot', authorId: botId, kind: 'tool', text: 'Skill', payload: { toolUseId: 't' + Math.random(), name: 'Skill', input: { skill: nameArg }, done: true, output: 'ok' }, causeId: 'c', hop: 0, turnId });
}

describe('SkillReflection', () => {
  function world(opts: { enabled?: boolean; every?: number; cap?: number; reply?: string } = {}) {
    const w = setup();
    const n = name('reflect-' + Math.random().toString(36).slice(2, 6));
    const live = w.skills.save(n, 'Export', SKILL_V1(n), { source: 'authored' });
    w.repos.setBotSkills(w.bot.id, [live.id]);
    if (opts.enabled !== false) w.skills.versionsRepo.setReflection(w.bot.id, { enabled: true, every: opts.every ?? 2, ...(opts.cap ? { dailyCapUsd: opts.cap } : {}) });
    const llm = fakeLlm(opts.reply ?? JSON.stringify({ change: true, reason: 'The Download link is gone; Export works', markdown: SKILL_V1(n).replace('Click the "Download" link', 'Click the "Export" button') }), 0.01);
    const refl = new SkillReflection({ repos: w.repos, skills: w.skills, usage: w.usage, activeProvider: () => 'claude', models: () => MODELS, exeExists: () => true, run: llm.run });
    let turn = 0;
    const runSkill = async () => {
      const turnId = 'turn-' + ++turn;
      w.repos.insertMessage({ roomId: w.room.id, authorType: 'user', authorId: null, kind: 'text', text: 'export the report', payload: null, causeId: 'c', hop: 0, turnId: null });
      toolMsg(w.repos, w.room.id, w.bot.id, turnId, 'bot-shopper:' + n);
      w.repos.insertMessage({ roomId: w.room.id, authorType: 'bot', authorId: w.bot.id, kind: 'text', text: 'Done, saved report.csv', payload: null, causeId: 'c', hop: 0, turnId });
      await Promise.all(refl.afterTurn(w.bot.id, w.room.id, { ok: true, turnId }));
    };
    return { ...w, n, live, llm, refl, runSkill };
  }

  it('is off by default', async () => {
    const w = world({ enabled: false });
    for (let i = 0; i < 6; i++) await w.runSkill();
    expect(w.llm.calls).toHaveLength(0);
  });

  it('every N runs proposes a pending version on Haiku (router causeKind reflection) and never applies it', async () => {
    const w = world({ every: 2 });
    await w.runSkill();
    expect(w.llm.calls).toHaveLength(0);
    await w.runSkill();
    expect(w.llm.calls).toHaveLength(1);
    expect(w.llm.calls[0].o).toMatchObject({ model: 'claude-haiku-4-5-20251001', budgetUsd: REFLECTION_PASS_BUDGET_USD });
    expect(w.llm.calls[0].prompt).toContain('[tool Skill]');
    const [v] = w.skills.listVersions(w.live.id);
    expect(v).toMatchObject({ status: 'pending', origin: 'reflection', createdByBot: w.bot.id, note: 'The Download link is gone; Export works' });
    // Never applied: the live skill and its version are unchanged.
    expect(w.skills.readMarkdown(w.repos.getSkill(w.live.id)!)).toContain('"Download" link');
    expect(w.repos.getSkill(w.live.id)!.version).toBe(1);
    // Spend is recorded as a reflection pass; the room is told a proposal waits.
    expect(w.repos.usageBy('causeKind').find((g) => g.key === 'reflection')?.costUsd).toBeCloseTo(0.01);
    const sys = w.repos.messagesAfter(w.room.id, 0).filter((m) => m.kind === 'system');
    expect(sys.pop()?.text).toMatch(/suggested a change to the skill .* nothing changed yet/);
    // The counter restarted.
    await w.runSkill();
    expect(w.llm.calls).toHaveLength(1);
  });

  it('a "no change" answer proposes nothing', async () => {
    const w = world({ every: 1, reply: '{"change": false}' });
    await w.runSkill();
    expect(w.llm.calls).toHaveLength(1);
    expect(w.skills.listVersions(w.live.id)).toEqual([]);
  });

  it('stops at the daily cap', async () => {
    const w = world({ every: 1, cap: 0.05 });
    await w.runSkill();
    expect(w.llm.calls).toHaveLength(1);
    await w.runSkill(); // 0.01 spent + 0.05 per pass > 0.05 cap
    expect(w.llm.calls).toHaveLength(1);
  });

  it('only counts approved skills assigned to the bot, and only successful turns', async () => {
    const w = world({ every: 1 });
    const res = w.refl.afterTurn(w.bot.id, w.room.id, { ok: false, turnId: 'x', error: 'boom' });
    expect(res).toEqual([]);
    w.repos.setBotSkills(w.bot.id, []);
    await w.runSkill();
    expect(w.llm.calls).toHaveLength(0);
  });

  it('parses replies and finds Skill tool calls', () => {
    expect(parseReflection('```json\n{"change": false}\n```')).toEqual({ change: false });
    expect(parseReflection('{"change": true, "reason": "r", "markdown": "# x"}')).toEqual({ change: true, reason: 'r', markdown: '# x' });
    expect(parseReflection('{"change": true}')).toBeNull();
    expect(parseReflection('nope')).toBeNull();
    const m = (input: Record<string, unknown>, text = 'Skill') => ({ kind: 'tool', text, payload: { input } }) as unknown as Message;
    expect(skillsUsed([m({ skill: 'bot-x:My-Skill' }), m({ command: '/other args' }), m({ skill: 'z' }, 'Bash')])).toEqual(['my-skill', 'other']);
  });
});
