// Runs deploy/backup.sh against a fake data/ tree and checks what ends up in the archive.
// Needs bash, tar and (for the database snapshot) python3; skips itself when bash or tar is missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'backup.sh')
const has = (cmd, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0
const haveBash = has('bash')
const haveTar = haveBash && spawnSync('bash', ['-c', 'tar --version'], { stdio: 'ignore' }).status === 0
const haveZstd = haveBash && spawnSync('bash', ['-c', 'command -v zstd'], { stdio: 'ignore' }).status === 0
const havePython = has('python3') || has('python3', ['-V'])
// Git Bash on Windows wants /c/... paths (a drive letter reads as a remote host to tar).
const posix = (p) => (process.platform === 'win32' ? spawnSync('cygpath', ['-u', p], { encoding: 'utf8' }).stdout.trim() : p)

const FILES = {
  real: [
    'data/workspace/notes.txt',
    'data/workspace/app/package.json',
    'data/workspace/app/dist/bundle.js', // dist and build are kept on purpose
    'data/workspace/app/build/out.txt',
    'data/projects/p1/src/index.ts',
    'data/workspace/other/target/real.txt', // a target/ with no Cargo.toml beside it is not Rust output
    'data/workspace/rs/Cargo.toml',
    'data/computers/c1/home/doc.md',
  ],
  excluded: [
    'data/workspace/node_modules/a/index.js',
    'data/projects/p1/node_modules/b/index.js',
    'data/projects/p1/packages/x/node_modules/c/index.js',
    'data/computers/c1/home/deep/er/node_modules/d/index.js',
    'data/workspace/app/.next/cache.bin',
    'data/workspace/app/.nuxt/x.js',
    'data/workspace/app/.turbo/log',
    'data/workspace/app/.parcel-cache/x',
    'data/projects/p1/.venv/lib/x.py',
    'data/projects/p1/venv/lib/y.py',
    'data/projects/p1/pkg/__pycache__/m.pyc',
    'data/projects/p1/.pytest_cache/v',
    'data/projects/p1/.mypy_cache/v',
    'data/workspace/rs/target/debug/bin',
    'data/vault.key',
    'data/hub-token',
  ],
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'pr-backup-'))
  const root = join(base, 'root')
  for (const f of [...FILES.real, ...FILES.excluded]) {
    mkdirSync(dirname(join(root, f)), { recursive: true })
    writeFileSync(join(root, f), 'x')
  }
  return { base, root, out: join(base, 'out') }
}

function run({ base, root, out }, env = {}) {
  return spawnSync('bash', [posix(script)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      POCKETROCKET_ROOT: posix(root),
      POCKETROCKET_BACKUPS: posix(out),
      POCKETROCKET_CLAUDE_HOME: posix(join(base, 'no-claude')),
      ...env,
    },
  })
}

function list(archive) {
  const flags = archive.endsWith('.tar.zst') ? ['-I', 'zstd'] : ['-z']
  const r = spawnSync('bash', ['-c', 'tar "$@"', 'tar', ...flags, '-tf', posix(archive)], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter(Boolean)
}

function check(env, ext) {
  const t = setup()
  try {
    if (havePython) {
      const mk = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table t(a)"); c.commit()', join(t.root, 'data', 'pocketrocket.db')])
      assert.equal(mk.status, 0, String(mk.stderr))
    }
    const r = run(t, env)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const files = readdirSync(t.out)
    assert.equal(files.length, 1, files.join(','))
    assert.ok(files[0].endsWith(ext) && !files[0].endsWith('.partial'), files[0])
    const names = list(join(t.out, files[0]))
    for (const f of FILES.real) assert.ok(names.includes(f), `missing ${f}`)
    for (const f of FILES.excluded) assert.ok(!names.some((n) => n === f || n.startsWith(f + '/')), `should be excluded: ${f}`)
    for (const dir of ['node_modules', '.next', 'venv', '__pycache__']) assert.ok(!names.some((n) => n.split('/').includes(dir)), `${dir} leaked`)
    if (havePython) {
      assert.ok(names.includes('db-snapshot/pocketrocket.db'))
      assert.ok(!names.includes('data/pocketrocket.db'))
    }
  } finally {
    rmSync(t.base, { recursive: true, force: true })
  }
}

test('gzip archive keeps real files and drops rebuildable dirs', { skip: !haveTar }, () => {
  check({ POCKETROCKET_COMPRESS: 'gzip' }, '.tgz')
})

test('zstd archive keeps real files and drops rebuildable dirs', { skip: !haveTar || !haveZstd }, () => {
  check({}, '.tar.zst')
})

test('without zstd on PATH it falls back to gzip', { skip: !haveTar || haveZstd }, () => {
  check({}, '.tgz')
})

test('rotation and cleanup treat .tgz and .tar.zst alike', { skip: !haveTar }, () => {
  const t = setup()
  try {
    mkdirSync(t.out)
    const old = (name, daysAgo) => {
      const p = join(t.out, name)
      writeFileSync(p, 'old')
      const when = new Date(Date.now() - daysAgo * 86400e3)
      utimesSync(p, when, when)
    }
    old('data-2026-01-01-0300.tgz', 4)
    old('data-2026-01-02-0300.tar.zst', 3)
    old('data-2026-01-03-0300.tgz', 2)
    old('data-2026-01-04-0300.tar.zst.partial', 1)
    const r = run(t, { KEEP: '2', POCKETROCKET_COMPRESS: 'gzip' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const files = readdirSync(t.out).sort()
    assert.equal(files.length, 2, files.join(','))
    assert.ok(files.includes('data-2026-01-03-0300.tgz'), files.join(','))
    assert.ok(!files.some((f) => f.endsWith('.partial')))
    assert.ok(existsSync(join(t.out, files.find((f) => f !== 'data-2026-01-03-0300.tgz'))))
  } finally {
    rmSync(t.base, { recursive: true, force: true })
  }
})
