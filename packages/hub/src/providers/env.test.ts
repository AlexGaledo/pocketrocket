import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnv } from './env.js';
import { addSecret, clearSecrets, redact } from './redact.js';

/** Audit 2026-09-09, B7: a provider child must never inherit the hub token or a rival provider's key. */

const SOURCE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  PATHEXT: '.COM;.EXE',
  SystemRoot: 'C:\\Windows',
  HOME: '/home/dev',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  XDG_DATA_HOME: '/home/dev/.local/share',
  HTTPS_PROXY: 'http://proxy:8080',
  NODE_NO_WARNINGS: '1',
  // Secrets and noise that must not travel.
  POCKETROCKET_TOKEN: 'hub-token-abcdef0123456789',
  POCKETROCKET_DATA: '/data',
  ANTHROPIC_API_KEY: 'sk-ant-key',
  OPENAI_API_KEY: 'sk-openai-key',
  XAI_API_KEY: 'xai-key',
  CLAUDE_CONFIG_DIR: '/home/dev/.claude',
  CODEX_HOME: '/home/dev/.codex',
  GROK_HOME: '/home/dev/.grok',
  OPENCODE_CONFIG: '/home/dev/opencode.json',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GITHUB_TOKEN: 'ghp_0123456789abcdef',
  SSH_AUTH_SOCK: '/tmp/agent',
};

describe('childEnv', () => {
  it('never forwards POCKETROCKET_TOKEN to any provider', () => {
    for (const p of ['claude', 'codex', 'opencode', 'grok'] as const) {
      expect(childEnv(p, {}, SOURCE).POCKETROCKET_TOKEN, p).toBeUndefined();
      expect(Object.values(childEnv(p, {}, SOURCE)), p).not.toContain('hub-token-abcdef0123456789');
    }
  });

  it('forwards the shared basics every CLI needs', () => {
    const e = childEnv('claude', {}, SOURCE);
    expect(e.PATH).toBe('/usr/bin');
    expect(e.HOME).toBe('/home/dev');
    expect(e.LANG).toBe('en_US.UTF-8');
    expect(e.LC_ALL).toBe('en_US.UTF-8');
    expect(e.XDG_DATA_HOME).toBe('/home/dev/.local/share');
    expect(e.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(e.NODE_NO_WARNINGS).toBe('1');
  });

  it('drops unrelated credentials and environment noise', () => {
    const e = childEnv('claude', {}, SOURCE);
    expect(e.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(e.GITHUB_TOKEN).toBeUndefined();
    expect(e.SSH_AUTH_SOCK).toBeUndefined();
    expect(e.POCKETROCKET_DATA).toBeUndefined();
  });

  it('gives each provider only its own keys', () => {
    const claude = childEnv('claude', {}, SOURCE);
    expect(claude.ANTHROPIC_API_KEY).toBe('sk-ant-key');
    expect(claude.CLAUDE_CONFIG_DIR).toBe('/home/dev/.claude');
    expect(claude.OPENAI_API_KEY).toBeUndefined();
    expect(claude.XAI_API_KEY).toBeUndefined();

    const codex = childEnv('codex', {}, SOURCE);
    expect(codex.OPENAI_API_KEY).toBe('sk-openai-key');
    expect(codex.CODEX_HOME).toBe('/home/dev/.codex');
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codex.XAI_API_KEY).toBeUndefined();

    const grok = childEnv('grok', {}, SOURCE);
    expect(grok.XAI_API_KEY).toBe('xai-key');
    expect(grok.GROK_HOME).toBe('/home/dev/.grok');
    expect(grok.OPENAI_API_KEY).toBeUndefined();
    expect(grok.ANTHROPIC_API_KEY).toBeUndefined();

    // OpenCode is a multi-provider front end and genuinely reads all three vendor keys.
    const oc = childEnv('opencode', {}, SOURCE);
    expect(oc.XAI_API_KEY).toBe('xai-key');
    expect(oc.ANTHROPIC_API_KEY).toBe('sk-ant-key');
    expect(oc.OPENAI_API_KEY).toBe('sk-openai-key');
    expect(oc.OPENCODE_CONFIG).toBe('/home/dev/opencode.json');
    expect(oc.CODEX_HOME).toBeUndefined();
  });

  it('applies extras last and lets an explicit undefined delete a key', () => {
    const e = childEnv('opencode', { OPENCODE_CONFIG: undefined, OPENCODE_SERVER_PASSWORD: 'pw' }, SOURCE);
    expect(e.OPENCODE_CONFIG).toBeUndefined();
    expect(e.OPENCODE_SERVER_PASSWORD).toBe('pw');
  });
});

// ---- the same claim, against a real spawned child ----
describe('a spawned child cannot see the hub token', () => {
  let tmp: string;
  let dumper: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-env-'));
    dumper = path.join(tmp, 'dump-env.mjs');
    fs.writeFileSync(dumper, 'process.stdout.write(JSON.stringify(process.env));\n');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('dumps an environment with no POCKETROCKET_TOKEN and no foreign key', async () => {
    const source: NodeJS.ProcessEnv = {
      ...process.env,
      POCKETROCKET_TOKEN: 'hub-token-should-not-appear',
      XAI_API_KEY: 'xai-should-not-appear',
      AWS_SECRET_ACCESS_KEY: 'aws-should-not-appear',
    };
    const env = childEnv('claude', { ANTHROPIC_API_KEY: 'sk-ant-allowed' }, source);
    const dumped = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [dumper], { env, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const seen = JSON.parse(dumped) as Record<string, string>;
    expect(seen.POCKETROCKET_TOKEN).toBeUndefined();
    expect(seen.XAI_API_KEY).toBeUndefined();
    expect(seen.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(dumped).not.toContain('hub-token-should-not-appear');
    expect(dumped).not.toContain('xai-should-not-appear');
    // The child still gets what it needs to run.
    expect(seen.ANTHROPIC_API_KEY).toBe('sk-ant-allowed');
    expect(seen.PATH ?? seen.Path).toBeTruthy();
  });
});

// ---- audit 2026-09-09, B22 ----
describe('redact', () => {
  it('scrubs bearer headers and vendor key shapes', () => {
    expect(redact('Authorization: Bearer abcdef0123456789xyz')).toBe('Authorization: Bearer [redacted]');
    expect(redact('using bearer eyJhbGciOiJIUzI1NiJ9.payload')).toBe('using bearer [redacted]');
    expect(redact('key=sk-proj-0123456789abcdefghij fails')).toContain('[redacted]');
    expect(redact('key=sk-proj-0123456789abcdefghij fails')).not.toContain('0123456789abcdefghij');
    expect(redact('xai-0123456789abcdefghij')).toBe('[redacted]');
    expect(redact('ghp_0123456789abcdefghij')).toBe('[redacted]');
  });

  it('scrubs registered exact secrets wherever they appear', () => {
    clearSecrets();
    addSecret('per-turn-mcp-token-9f2a');
    expect(redact('spawn failed: token per-turn-mcp-token-9f2a rejected')).toBe('spawn failed: token [redacted] rejected');
    clearSecrets();
    expect(redact('spawn failed: token per-turn-mcp-token-9f2a rejected')).toContain('per-turn-mcp-token-9f2a');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('codex exited with code 1: ENOENT no such file')).toBe('codex exited with code 1: ENOENT no such file');
    expect(redact('')).toBe('');
  });
});
