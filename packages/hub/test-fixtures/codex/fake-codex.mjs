#!/usr/bin/env node
// Stand-in for the real `codex` binary, used by providers/codex.test.ts.
// It records how it was invoked and replays a fixture JSONL stream, so the adapter can be tested
// end-to-end (argv, stdin, env, stream -> sink) without a Codex install or a ChatGPT login.
//
// Env knobs:
//   FAKE_CODEX_RECORD  path to write {argv, stdin, cwd, token, apiKey} as JSON
//   FAKE_CODEX_STREAM  path to a .jsonl fixture to echo on stdout
//   FAKE_CODEX_EXIT    exit code for `exec` (default 0)
//   FAKE_CODEX_STDERR  text to write on stderr
//   FAKE_CODEX_HANG    "1" -> never exit (interrupt / abort tests)
//   FAKE_CODEX_LOGIN   "chatgpt" | "apikey" | "none" -> shapes `login status`
//   FAKE_CODEX_VERSION version string (default "codex-cli 0.153.2")
import fs from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write((process.env.FAKE_CODEX_VERSION ?? 'codex-cli 0.153.2') + '\n');
  process.exit(0);
}

if (argv[0] === 'login' && argv[1] === 'status') {
  const mode = process.env.FAKE_CODEX_LOGIN ?? 'chatgpt';
  if (mode === 'none') {
    process.stdout.write('Not logged in\n');
    process.exit(1);
  }
  process.stdout.write(mode === 'apikey' ? 'Logged in using an API key\n' : 'Logged in using ChatGPT\n');
  process.exit(0);
}

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const record = {
    argv,
    stdin: Buffer.concat(chunks).toString('utf8'),
    cwd: process.cwd(),
    token: process.env.POCKETROCKET_MCP_TOKEN ?? null,
    apiKey: process.env.OPENAI_API_KEY ?? null,
  };
  if (process.env.FAKE_CODEX_RECORD) fs.writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify(record, null, 2));
  if (process.env.FAKE_CODEX_STREAM) process.stdout.write(fs.readFileSync(process.env.FAKE_CODEX_STREAM, 'utf8'));
  if (process.env.FAKE_CODEX_STDERR) process.stderr.write(process.env.FAKE_CODEX_STDERR);
  if (process.env.FAKE_CODEX_HANG === '1') {
    setInterval(() => undefined, 1000); // hold the event loop open until we are killed
    return;
  }
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0));
});
