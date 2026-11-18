import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { claudeConfigDir, encodeProjectDir, projectDirExists, rewriteLine, rewriteSessionFile, rewriteSessionText, sessionFilePath, swapPrefix } from './SessionFile.js';

const PC = 'C:\\Users\\sam\\code\\app';
const VPS = '/srv/pr/projects/acme/repos/app-wt/abcd1234';

// Lines as the CLI writes them: compact JSON.stringify.
const J = (o: unknown) => JSON.stringify(o);
const userLine = J({ type: 'user', uuid: 'u1', cwd: PC, message: { role: 'user', content: 'read C:\\Users\\sam\\code\\app\\x.ts please' } });
const toolLine = J({
  type: 'assistant', uuid: 'a1', cwd: PC + '\\packages\\hub',
  message: { role: 'assistant', content: [
    { type: 'text', text: 'Editing ' + PC + '\\src\\a.ts now' },
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: PC + '\\src\\a.ts', old_string: PC + '\\src\\a.ts', new_string: 'x' } },
    { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'foo', path: PC } },
    { type: 'tool_use', id: 't3', name: 'NotebookEdit', input: { notebook_path: PC + '\\n.ipynb' } },
  ] },
});
const resultLine = J({ type: 'user', uuid: 'u2', cwd: PC, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'edited ' + PC + '\\src\\a.ts' }] } });
const noPathLine = J({ type: 'summary', summary: 'hello', leafUuid: 'x' });

describe('swapPrefix', () => {
  it('swaps a Windows root for a POSIX one and converts the tail separators', () => {
    expect(swapPrefix(PC, PC, VPS)).toBe(VPS);
    expect(swapPrefix(PC + '\\src\\a.ts', PC, VPS)).toBe(VPS + '/src/a.ts');
  });
  it('swaps back, converting the tail to backslashes', () => {
    expect(swapPrefix(VPS + '/src/a.ts', VPS, PC)).toBe(PC + '\\src\\a.ts');
    expect(swapPrefix(VPS, VPS, PC)).toBe(PC);
  });
  it('matches whole path segments only', () => {
    expect(swapPrefix(PC + '2\\x', PC, VPS)).toBe(PC + '2\\x');
    expect(swapPrefix('/a/app2/x', '/a/app', '/b')).toBe('/a/app2/x');
    expect(swapPrefix('/elsewhere/app/x', '/a/app', '/b')).toBe('/elsewhere/app/x');
  });
  it('ignores the case of a Windows drive and folders, but not of a POSIX path', () => {
    expect(swapPrefix('c:\\users\\SAM\\code\\app\\x', PC, VPS)).toBe(VPS + '/x');
    expect(swapPrefix('/A/app/x', '/a/app', '/b')).toBe('/A/app/x');
  });
  it('tolerates a trailing separator on either root', () => {
    expect(swapPrefix(PC + '\\x', PC + '\\', VPS + '/')).toBe(VPS + '/x');
  });
  it('keeps POSIX to POSIX tails as they are', () => {
    expect(swapPrefix('/home/a/app/src/x.ts', '/home/a/app', '/w/wt')).toBe('/w/wt/src/x.ts');
  });
});

describe('rewriteLine', () => {
  it('rewrites cwd and the known path fields of tool_use inputs, and nothing else', () => {
    const o = JSON.parse(rewriteLine(toolLine, PC, VPS));
    expect(o.cwd).toBe(VPS + '/packages/hub');
    const [text, edit, grep, nb] = o.message.content;
    expect(edit.input.file_path).toBe(VPS + '/src/a.ts');
    expect(grep.input.path).toBe(VPS);
    expect(nb.input.notebook_path).toBe(VPS + '/n.ipynb');
    // Free text, other input fields and tool_result bodies stay as they were, even when they name the PC path.
    expect(text.text).toBe('Editing ' + PC + '\\src\\a.ts now');
    expect(edit.input.old_string).toBe(PC + '\\src\\a.ts');
    expect(rewriteLine(userLine, PC, VPS)).toContain('read C:\\\\Users\\\\sam\\\\code\\\\app\\\\x.ts please');
    expect(JSON.parse(rewriteLine(resultLine, PC, VPS)).message.content[0].content).toBe('edited ' + PC + '\\src\\a.ts');
  });

  it('returns the very same string for a line it has nothing to change in', () => {
    expect(rewriteLine(noPathLine, PC, VPS)).toBe(noPathLine);
    expect(rewriteLine('not json {', PC, VPS)).toBe('not json {');
    expect(rewriteLine('', PC, VPS)).toBe('');
    expect(rewriteLine(J({ cwd: '/somewhere/else', x: 1 }), PC, VPS)).toBe(J({ cwd: '/somewhere/else', x: 1 }));
    expect(rewriteLine(J([PC]), PC, VPS)).toBe(J([PC]));
  });

  it('does not touch a path field that is not inside the root', () => {
    const l = J({ cwd: 'D:\\other', message: { content: [{ type: 'tool_use', input: { file_path: 'D:\\other\\a' } }] } });
    expect(rewriteLine(l, PC, VPS)).toBe(l);
  });

  it('survives hostile shapes without throwing', () => {
    for (const l of [J({ cwd: 5 }), J({ message: null }), J({ message: { content: [null, 1, { type: 'tool_use' }, { type: 'tool_use', input: 'x' }] } }), J(null), '"' + PC + '"']) {
      expect(() => rewriteLine(l, PC, VPS)).not.toThrow();
    }
  });
});

describe('round trip', () => {
  const file = [userLine, toolLine, resultLine, noPathLine, '', 'a line that is not json'].join('\n') + '\n';

  it('PC -> VPS -> PC gives back the exact file', () => {
    const there = rewriteSessionText(file, PC, VPS);
    expect(there).not.toBe(file);
    expect(rewriteSessionText(there, VPS, PC)).toBe(file);
  });

  it('VPS -> PC -> VPS is the identity too', () => {
    const vpsFile = rewriteSessionText(file, PC, VPS);
    expect(rewriteSessionText(rewriteSessionText(vpsFile, VPS, PC), PC, VPS)).toBe(vpsFile);
  });

  it('a POSIX PC path round-trips', () => {
    const l = J({ cwd: '/home/sam/app/pkg', message: { content: [{ type: 'tool_use', input: { file_path: '/home/sam/app/pkg/a.ts' } }] } });
    expect(rewriteSessionText(rewriteSessionText(l, '/home/sam/app', VPS), VPS, '/home/sam/app')).toBe(l);
  });

  it('keeps lines the VPS turns added: their paths come home too', () => {
    const added = J({ type: 'assistant', cwd: VPS, message: { content: [{ type: 'tool_use', input: { file_path: VPS + '/src/new.ts' } }] } });
    const back = rewriteSessionText(rewriteSessionText(file, PC, VPS) + added + '\n', VPS, PC);
    const last = JSON.parse(back.trimEnd().split('\n').pop()!);
    expect(last.cwd).toBe(PC);
    expect(last.message.content[0].input.file_path).toBe(PC + '\\src\\new.ts');
  });

  it('leaves unrelated text exactly alone, including odd whitespace and unicode', () => {
    const l = J({ type: 'user', message: { content: 'tab\there \u00e9 \ud83d\ude80 ' + PC + ' and ' + VPS } });
    expect(rewriteSessionText(l, PC, VPS)).toBe(l);
    expect(rewriteSessionText(l + '\n\n\n', PC, VPS)).toBe(l + '\n\n\n');
  });
});

describe('rewriteSessionFile', () => {
  it('streams to the same bytes as the in-memory rewrite, for a file bigger than one chunk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sf-'));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 6000; i++) lines.push(i % 3 === 0 ? toolLine : i % 3 === 1 ? userLine : J({ type: 'system', n: i, pad: 'x'.repeat(200) + '\u00e9' }));
      const text = lines.join('\n') + '\n';
      expect(text.length).toBeGreaterThan(1 << 20);
      fs.writeFileSync(path.join(dir, 'in.jsonl'), text);
      const r = await rewriteSessionFile(path.join(dir, 'in.jsonl'), path.join(dir, 'out.jsonl'), PC, VPS);
      const out = fs.readFileSync(path.join(dir, 'out.jsonl'), 'utf8');
      expect(out).toBe(rewriteSessionText(text, PC, VPS));
      expect(r.bytes).toBe(Buffer.byteLength(out));
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      // And without a trailing newline.
      fs.writeFileSync(path.join(dir, 'in2.jsonl'), userLine + '\n' + toolLine);
      await rewriteSessionFile(path.join(dir, 'in2.jsonl'), path.join(dir, 'out2.jsonl'), PC, VPS);
      expect(fs.readFileSync(path.join(dir, 'out2.jsonl'), 'utf8')).toBe(rewriteSessionText(userLine + '\n' + toolLine, PC, VPS));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('where the CLI looks for a session', () => {
  it('encodes every non-alphanumeric character as a dash (the CLI rule)', () => {
    expect(encodeProjectDir('C:\\Users\\alex\\desktop\\claude-grokbot')).toBe('C--Users-alex-desktop-claude-grokbot');
    expect(encodeProjectDir('/home/pocketrocket/data/projects/acme/repos/app-wt/abcd1234')).toBe('-home-pocketrocket-data-projects-acme-repos-app-wt-abcd1234');
    expect(encodeProjectDir('/a b/c.d_e')).toBe('-a-b-c-d-e');
  });

  it('puts the file at <config>/projects/<encoded cwd>/<id>.jsonl', () => {
    const cfg = path.join(os.tmpdir(), 'cfg-x');
    const cwd = path.resolve('/srv/wt/abcd1234');
    expect(sessionFilePath(cwd, 'sess-1', cfg)).toBe(path.join(cfg, 'projects', encodeProjectDir(cwd), 'sess-1.jsonl'));
  });

  it('refuses a session id that is a path, and a worktree path the CLI would hash', () => {
    expect(() => sessionFilePath('/a', '../x', '/c')).toThrow();
    expect(() => sessionFilePath('/' + 'a'.repeat(250), 'sess', '/c')).toThrow(/too long/);
  });

  it('honours CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/cfg' })).toBe('/x/cfg');
    expect(claudeConfigDir({})).toBe(path.join(os.homedir(), '.claude'));
  });

  // Ground truth on a machine that has run the CLI: the folder it made for this checkout is the one we compute. Skipped
  // where the CLI never ran in this folder (CI, a fresh machine).
  it("matches a project folder the real CLI created under this machine's Claude projects dir", () => {
    const cfg = claudeConfigDir();
    let top = '';
    try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
    const candidates = [top, path.resolve(top, '..'), process.cwd()].filter(Boolean).map((p) => path.normalize(p));
    const known = candidates.filter((p) => encodeProjectDir(p).length <= 200 && projectDirExists(p, cfg));
    if (known.length === 0) return;
    for (const p of known) expect(fs.statSync(path.join(cfg, 'projects', encodeProjectDir(p))).isDirectory()).toBe(true);
  });
});
