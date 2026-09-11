// Build the hub into packages/hub/build/ — everything the desktop app ships as a Tauri resource.
//
//   build/
//     hub.mjs        esbuild bundle of src/index.ts (deps external, @pocketrocket/shared inlined)
//     node_modules/  production dependencies (pnpm deploy --prod)
//     package.json   written by pnpm deploy
//     web/           packages/web/dist (the built UI)
//     VERSION        root package.json version + build timestamp
//
// Run: pnpm hub:bundle
//
// The bundle keeps every runtime dep external on purpose (see docs/research/xai-tauri.md):
// `ws` optional native addons, `http-proxy` dynamic requires and the Claude Agent SDK's
// platform-specific optional deps all break when bundled. `@pocketrocket/shared` is the one
// exception — it is a workspace package whose "main" points at TypeScript, which Node cannot
// run, so it is compiled into hub.mjs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'packages', 'hub');
const BUILD = path.join(HUB, 'build');
const WEB_DIST = path.join(ROOT, 'packages', 'web', 'dist');
const SHARED_ENTRY = path.join(ROOT, 'packages', 'shared', 'src', 'index.ts');

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

function run(args, label) {
  console.log(`[hub:bundle] ${label}`);
  const r = spawnSync(pnpm, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`[hub:bundle] failed: pnpm ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

// 0. typecheck the hub before anything expensive — esbuild strips types without checking them,
// so a type error would otherwise sail straight into the installer.
run(['--filter', '@pocketrocket/hub', 'build'], 'typechecking the hub (tsc --noEmit)');

// 1. web UI
run(['--filter', '@pocketrocket/web', 'build'], 'building the web UI (vite)');
if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  console.error(`[hub:bundle] ${WEB_DIST}/index.html missing after the web build`);
  process.exit(1);
}

// 2. production node_modules.
// pnpm 10 refuses `deploy` unless the workspace sets inject-workspace-packages=true, and in
// 10.0.0 it refuses even with --legacy. Turning that setting on in pnpm-workspace.yaml would
// hard-copy @pocketrocket/shared into every package's node_modules and break live editing of
// the workspace sources, so it is forced for this one command instead: --legacy then copies
// straight from the store using the workspace lockfile.
fs.rmSync(BUILD, { recursive: true, force: true });
// node-linker=hoisted matters: pnpm's default layout links every top-level package into
// node_modules/.pnpm with junctions, and Tauri's resource copier drops symlinks silently — the
// shipped node_modules would be empty. Hoisted gives a plain npm-shaped tree of real files.
run(
  [
    '--config.inject-workspace-packages=true',
    '--config.node-linker=hoisted',
    '--filter',
    '@pocketrocket/hub',
    'deploy',
    '--legacy',
    '--prod',
    BUILD,
  ],
  'deploying production dependencies',
);
if (!fs.existsSync(path.join(BUILD, 'node_modules'))) {
  console.error('[hub:bundle] pnpm deploy produced no node_modules');
  process.exit(1);
}
// Every runtime dep is external in the bundle, so a missing one is a crash at first use rather
// than a build error. Assert the ones that are only reached through dynamic paths.
const REQUIRED = [
  '@anthropic-ai/claude-agent-sdk',
  '@modelcontextprotocol/sdk',
  '@opencode-ai/sdk',
  '@playwright/mcp',
  '@supabase/supabase-js',
  'croner',
  'dotenv',
  'http-proxy',
  'nanoid',
  'ws',
  'zod',
];
const missing = REQUIRED.filter((d) => !fs.existsSync(path.join(BUILD, 'node_modules', d, 'package.json')));
if (missing.length) {
  console.error(`[hub:bundle] deployed node_modules is missing: ${missing.join(', ')}`);
  process.exit(1);
}

// The Claude Agent SDK's platform optional dep (@anthropic-ai/claude-agent-sdk-win32-x64) is a
// ~220 MB vendored copy of the Claude CLI that we never execute: providers/claude.ts always
// passes `pathToClaudeCodeExecutable: CLAUDE_EXE`, the user's own claude.exe, which is also what
// check() requires before the provider reports ok. Dropping it roughly halves the installer.
//
// `pnpm deploy --no-optional` cannot do this: the legacy deploy walks every optional dep and the
// workspace lockfile only carries entries for the platform actually installed, so it dies with
// ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY on …-win32-arm64. Prune afterwards instead.
const NM = path.join(BUILD, 'node_modules', '@anthropic-ai');
let pruned = 0;
if (fs.existsSync(NM)) {
  for (const entry of fs.readdirSync(NM)) {
    if (!/^claude-agent-sdk-(linux|darwin|win32)-/.test(entry)) continue;
    const dir = path.join(NM, entry);
    pruned += dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[hub:bundle]   pruned vendored CLI ${entry}`);
  }
}
if (pruned) console.log(`[hub:bundle] pruned ${(pruned / 1024 / 1024).toFixed(0)} MB of vendored Claude CLI binaries`);
const linked = fs
  .readdirSync(path.join(BUILD, 'node_modules'), { withFileTypes: true })
  .filter((e) => e.isSymbolicLink())
  .map((e) => e.name);
if (linked.length) {
  console.error(`[hub:bundle] node_modules still contains symlinks (${linked.slice(0, 3).join(', ')}…).`);
  console.error('[hub:bundle] Tauri drops those when it copies resources — the installed hub would have no dependencies.');
  process.exit(1);
}
// deploy copies the package's own files too (src, tests, tsconfig); hub.mjs replaces all of them,
// so keep only what the app runs. Legacy deploy also drops its .bin shims one level too deep,
// inside packages/hub itself — clean that up as well.
for (const entry of fs.readdirSync(BUILD)) {
  if (entry !== 'node_modules' && entry !== 'package.json') {
    fs.rmSync(path.join(BUILD, entry), { recursive: true, force: true });
  }
}
fs.rmSync(path.join(HUB, 'packages'), { recursive: true, force: true });

// 3. bundle
console.log('[hub:bundle] bundling src/index.ts -> build/hub.mjs');
await esbuild.build({
  entryPoints: [path.join(HUB, 'src', 'index.ts')],
  outfile: path.join(BUILD, 'hub.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
  // Some CJS deps pulled in through the bundle expect `require` to exist in module scope.
  banner: { js: "import{createRequire as __prCreateRequire}from'node:module';const require=__prCreateRequire(import.meta.url);" },
  plugins: [
    {
      // `packages: 'external'` externalises every bare specifier and there is no way to
      // un-externalise one of them from the CLI, so resolve the workspace package by hand.
      name: 'inline-shared',
      setup(build) {
        build.onResolve({ filter: /^@pocketrocket\/shared(\/.*)?$/ }, () => ({ path: SHARED_ENTRY }));
      },
    },
  ],
});

// 4. web dist -> build/web
const webOut = path.join(BUILD, 'web');
fs.rmSync(webOut, { recursive: true, force: true });
fs.cpSync(WEB_DIST, webOut, { recursive: true });

// 5. VERSION stamp
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(BUILD, 'VERSION'), `${version}\n${new Date().toISOString()}\n`);

const size = (p) => (fs.statSync(p).size / 1024).toFixed(0);
console.log(`[hub:bundle] done: ${BUILD}`);
console.log(`[hub:bundle]   hub.mjs ${size(path.join(BUILD, 'hub.mjs'))} KB, web/index.html present: ${fs.existsSync(path.join(webOut, 'index.html'))}, version ${version}`);
