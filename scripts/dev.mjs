// Dev launcher: runs the hub (tsx watch) and the Vite UI together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';

function run(name, args, color) {
  const child = spawn(pnpm, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: isWin, env: process.env });
  const tag = '\x1b[' + color + 'm[' + name + ']\x1b[0m ';
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) out.write(tag + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(tag + 'exited with code ' + code + '\n');
    if (!shuttingDown) shutdown(code ?? 1);
  });
  return child;
}

let shuttingDown = false;
const children = [
  run('hub', ['--filter', '@pocketrocket/hub', 'dev'], '34'),
  run('web', ['--filter', '@pocketrocket/web', 'dev'], '35'),
];

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      if (isWin) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(code), 800);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
