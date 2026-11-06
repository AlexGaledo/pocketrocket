import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_FILE_MESSAGE, HUB_KEYS_MESSAGE, secretFileAccess } from './secretFiles.js';

/**
 * The hub's key files and projects' .env files are refused to a bot's own tools, in every approvals mode.
 * A temp DATA_DIR stands in for the real one.
 */
function setup() {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secretfiles-')));
  const ws = path.join(data, 'workspace');
  const app = path.join(data, 'projects', 'app');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(data, 'keys-disabled'));
  for (const f of ['hub-token', 'secrets.json', 'mcp-servers.json']) fs.writeFileSync(path.join(data, f), 'k');
  fs.writeFileSync(path.join(data, 'keys-disabled', 'old.json'), 'k');
  fs.writeFileSync(path.join(app, '.env'), 'K=1');
  fs.writeFileSync(path.join(app, '.env.local'), 'K=1');
  fs.writeFileSync(path.join(app, '.env.example'), 'K=');
  const check = (tool: string, input: Record<string, unknown>, cwd = ws) => secretFileAccess(tool, input, cwd, data);
  return { data, ws, app, check };
}

describe('secretFileAccess: file tools', () => {
  it('refuses a plain absolute path to every hub key file, for reads and writes', () => {
    const { data, check } = setup();
    for (const f of ['hub-token', 'secrets.json', 'mcp-servers.json', 'pc-runner.json', 'account.json', 'vapid.json', 'key-registry.json']) {
      expect(check('Read', { file_path: path.join(data, f) })).toBe(HUB_KEYS_MESSAGE);
    }
    expect(check('Write', { file_path: path.join(data, 'mcp-servers.json'), content: '{}' })).toBe(HUB_KEYS_MESSAGE);
    // A bot must not re-tier a key to steer where its job runs.
    expect(check('Write', { file_path: path.join(data, 'key-registry.json'), content: '{}' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'echo {} > ../key-registry.json' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Edit', { file_path: path.join(data, 'secrets.json'), old_string: 'a', new_string: 'b' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Read', { file_path: path.join(data, 'keys-disabled', 'old.json') })).toBe(HUB_KEYS_MESSAGE);
  });

  it('refuses the hub database, its sidecars, the legacy one and any SQLite copy at the top of DATA_DIR', () => {
    const { data, check } = setup();
    for (const f of ['pocketrocket.db', 'pocketrocket.db-wal', 'pocketrocket.db-shm', 'pocketrocket.db-journal', 'claudebot.db', 'claudebot.db-wal', 'copy.db', 'hub.db.bak', 'old.sqlite', 'x.sqlite3']) {
      expect([f, check('Read', { file_path: path.join(data, f) })]).toEqual([f, HUB_KEYS_MESSAGE]);
    }
    expect(check('Write', { file_path: path.join(data, 'pocketrocket.db'), content: 'x' })).toBe(HUB_KEYS_MESSAGE);
    // The shell: a sqlite3 session that could forge a signed-in browser, a python one-liner, a glob.
    expect(check('Bash', { command: "sqlite3 ../pocketrocket.db \"INSERT INTO user_sessions VALUES ('x')\"" })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: "python3 -c \"import sqlite3; sqlite3.connect('../pocketrocket.db')\"" })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cp ../*.db /tmp/' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cat ' + path.join(data, 'backup.db') })).toBe(HUB_KEYS_MESSAGE);
  });

  it('leaves a project\'s own database alone', () => {
    const { app, check } = setup();
    expect(check('Read', { file_path: path.join(app, 'dev.db') })).toBeNull();
    expect(check('Bash', { command: 'sqlite3 dev.db ".tables"' }, app)).toBeNull();
  });

  it('refuses a relative path resolved against the cwd', () => {
    const { check } = setup();
    expect(check('Read', { file_path: '../secrets.json' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Read', { file_path: '../workspace/../hub-token' })).toBe(HUB_KEYS_MESSAGE);
  });

  it('leaves ordinary files alone, including one named like a key file elsewhere', () => {
    const { ws, app, check } = setup();
    expect(check('Read', { file_path: path.join(ws, 'notes.md') })).toBeNull();
    expect(check('Read', { file_path: 'secrets.json' })).toBeNull(); // workspace/secrets.json is the bot's own
    expect(check('Write', { file_path: path.join(app, 'src', 'index.ts'), content: '' })).toBeNull();
  });

  it('refuses a project .env and .env.local but not .env.example', () => {
    const { app, check } = setup();
    expect(check('Read', { file_path: path.join(app, '.env') })).toBe(ENV_FILE_MESSAGE);
    expect(check('Read', { file_path: '.env.local' }, app)).toBe(ENV_FILE_MESSAGE);
    expect(check('Write', { file_path: path.join(app, '.env'), content: 'X=1' })).toBe(ENV_FILE_MESSAGE);
    expect(check('Read', { file_path: path.join(app, '.env.example') })).toBeNull();
  });

  it('only guards .env files under the projects folder', () => {
    const { ws, check } = setup();
    expect(check('Read', { file_path: path.join(ws, '.env') })).toBeNull();
  });

  it('follows a symlink (junction on Windows) into DATA_DIR by realpath', () => {
    const { data, ws, check } = setup();
    const link = path.join(ws, 'up');
    fs.symlinkSync(data, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(check('Read', { file_path: path.join(link, 'secrets.json') })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Read', { file_path: 'up/hub-token' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cat up/mcp-servers.json' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cat up/secret*' })).toBe(HUB_KEYS_MESSAGE);
  });
});

describe('secretFileAccess: Glob and Grep', () => {
  it('refuses a Grep whose path is a key file, or that searches all of DATA_DIR', () => {
    const { data, check } = setup();
    expect(check('Grep', { pattern: 'sk-', path: '../secrets.json' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Grep', { pattern: 'sk-', path: '..' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Grep', { pattern: 'sk-', path: path.parse(data).root })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Grep', { pattern: 'sk-', path: '.', glob: '../secret*' })).toBe(HUB_KEYS_MESSAGE);
  });

  it('refuses a Grep or Glob aimed at a project .env, and allows ordinary searches', () => {
    const { app, check } = setup();
    expect(check('Grep', { pattern: 'KEY', path: app, glob: '.env*' })).toBe(ENV_FILE_MESSAGE);
    expect(check('Glob', { pattern: '../projects/*/.env' })).toBe(ENV_FILE_MESSAGE);
    expect(check('Grep', { pattern: 'TODO', path: app, glob: '*.ts' })).toBeNull();
    expect(check('Grep', { pattern: 'TODO' })).toBeNull();
    expect(check('Glob', { pattern: '**/*.ts' })).toBeNull();
  });
});

describe('secretFileAccess: Bash', () => {
  it('refuses plain, relative and cd-then-read forms', () => {
    const { data, check } = setup();
    expect(check('Bash', { command: 'cat ' + path.join(data, 'secrets.json') })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cat ../secrets.json' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cd .. && cat hub-token' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cd ..; head -c 40 "mcp-servers.json"' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'ls && cat < ../hub-token' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: "python3 -c \"print(open('../secrets.json').read())\"" })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'echo {} > ../mcp-servers.json' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'ls ../keys-disabled' })).toBe(HUB_KEYS_MESSAGE);
  });

  it('refuses globs that reach a key file', () => {
    const { check } = setup();
    expect(check('Bash', { command: 'cat ../secrets*' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cat ../*.json' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cd .. && cat hub-*' })).toBe(HUB_KEYS_MESSAGE);
  });

  it('refuses a recursive search over DATA_DIR', () => {
    const { check } = setup();
    expect(check('Bash', { command: 'grep -rn sk- ..' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'cd .. && rg sk-' })).toBe(HUB_KEYS_MESSAGE);
    expect(check('Bash', { command: 'tar czf /tmp/x.tgz ..' })).toBe(HUB_KEYS_MESSAGE);
  });

  it('refuses reading a project .env, but not .env.example or running the app', () => {
    const { app, check } = setup();
    expect(check('Bash', { command: 'cat .env' }, app)).toBe(ENV_FILE_MESSAGE);
    expect(check('Bash', { command: 'cat .env*' }, app)).toBe(ENV_FILE_MESSAGE);
    expect(check('Bash', { command: 'source .env && echo $KEY' }, app)).toBe(ENV_FILE_MESSAGE);
    expect(check('Bash', { command: 'cat ../projects/app/.env.local' })).toBe(ENV_FILE_MESSAGE);
    expect(check('Bash', { command: 'cat .env.example' }, app)).toBeNull();
    expect(check('Bash', { command: 'cp .env.example .env.example.bak' }, app)).toBeNull();
    expect(check('Bash', { command: 'pnpm dev' }, app)).toBeNull();
    expect(check('Bash', { command: 'pnpm test -- --run && npm run build' }, app)).toBeNull();
    expect(check('Bash', { command: 'node --env-file=.env server.js' }, app)).toBeNull();
  });

  it('sees through shell syntax that hides a command or a path', () => {
    const { check } = setup();
    const refused = [
      'ls\ncat ../hub-token',
      'cd ..\ncat hub-token',
      'sleep 1 & cat ../secrets.json',
      'echo $(cat ../secrets.json)',
      'echo `cat ../mcp-servers.json`',
      'cat ~/../hub\\-token',
      'cat ../secr\\ets.json',
      'cat ../"secrets".json',
      "cat ../'hub'-token",
      '(cd .. && cat hub-token)',
      'f=hub-token; cat ../$f',
      'ls ../keys-disabled',
      'cat ../vault.key',
      'cat ../integrations.json',
      'cat ../account.json',
      'cat ../vapid.json',
      'cat ../pc-runner.json',
    ];
    for (const command of refused) expect(check('Bash', { command }), command).toBe(HUB_KEYS_MESSAGE);
  });

  it('sees a project .env behind shell syntax too', () => {
    const { app, check } = setup();
    expect(check('Bash', { command: 'true & cat .env' }, app)).toBe(ENV_FILE_MESSAGE);
    expect(check('Bash', { command: 'echo $(cat .env)' }, app)).toBe(ENV_FILE_MESSAGE);
    expect(check('Bash', { command: 'cat .e\\nv' }, app)).toBe(ENV_FILE_MESSAGE);
    expect(check('Bash', { command: 'ls\ncat .env.local' }, app)).toBe(ENV_FILE_MESSAGE);
    expect(check('Bash', { command: 'cp .env.example .env.example.bak && pnpm test 2>&1 | tail' }, app)).toBeNull();
  });

  it('known gap: a name assembled at run time still passes', () => {
    const { check } = setup();
    // Documented in secretFiles.ts: neither the path checks nor the backstop see "hub-token" here.
    expect(check('Bash', { command: 'h=hub; cat ../$h-token' })).toBeNull();
  });

  it('refuses any command naming a key file, even a harmless one (the backstop has no context)', () => {
    const { check } = setup();
    expect(check('Bash', { command: 'grep -rn secrets.json src' })).toBe(HUB_KEYS_MESSAGE);
  });

  it('leaves everyday commands alone', () => {
    const { check } = setup();
    expect(check('Bash', { command: 'ls -la .. && git status' })).toBeNull();
    expect(check('Bash', { command: 'npm run build > out.log 2>&1 && echo done &> /dev/null' })).toBeNull();
    expect(check('Bash', { command: 'cat README.md | head -20 2>/dev/null' })).toBeNull();
    expect(check('Bash', { command: 'cd ../projects/app && ls *.ts' })).toBeNull();
  });
});
