// Download the Node 24 LTS win-x64 runtime that the desktop app ships as a Tauri sidecar.
//
//   packages/desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe   (installed as node.exe
//                                                                          next to PocketRocket.exe)
//   packages/desktop/src-tauri/binaries/NODE-LICENSE
//   packages/desktop/src-tauri/binaries/node.version
//
// Run: pnpm desktop:fetch-node   (cached — re-running is a no-op while the version matches)
//
// The major version is pinned below (NODE_MAJOR); the newest vNODE_MAJOR.x.y with an LTS codename
// is resolved at run time and the exact resolved version is logged and stamped to node.version.
// The zip is checked against SHASUMS256.txt for that release via a plain SHA256 comparison —
// nodejs.org does not publish a machine-verifiable signature for that file, so this is integrity
// (tamper-in-transit / bad mirror) checking only, not authenticity (GPG) verification.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'packages', 'desktop', 'src-tauri', 'binaries');
const EXE = path.join(BIN, 'node-x86_64-pc-windows-msvc.exe');
const LICENSE = path.join(BIN, 'NODE-LICENSE');
const STAMP = path.join(BIN, 'node.version');
const DIST = 'https://nodejs.org/dist';
const NODE_MAJOR = 24;

async function text(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

async function latestLtsMajor() {
  const index = JSON.parse(await text(`${DIST}/index.json`));
  const candidates = index
    .filter((r) => r.lts && new RegExp(`^v${NODE_MAJOR}\\.`).test(r.version) && (r.files ?? []).includes('win-x64-zip'))
    .sort((a, b) => cmpSemver(b.version, a.version));
  if (!candidates.length) throw new Error(`no LTS v${NODE_MAJOR}.x win-x64 release found on nodejs.org`);
  return candidates[0].version; // "v24.x.y"
}

function cmpSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Pull two members out of the zip. Windows ships bsdtar, which reads zips; Expand-Archive is the fallback. */
function extract(zip, members, dest) {
  const tar = spawnSync('tar', ['-xf', zip, '-C', dest, ...members], { stdio: 'pipe' });
  if (tar.status === 0) return;
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`],
    { stdio: 'inherit' },
  );
  if (ps.status !== 0) throw new Error(`could not extract ${zip} (tar: ${tar.stderr?.toString().trim()})`);
}

const version = await latestLtsMajor();
console.log(`[fetch-node] resolved latest LTS v${NODE_MAJOR}.x -> ${version}`);
const stamped = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8').trim() : '';
if (stamped === version && fs.existsSync(EXE) && fs.existsSync(LICENSE)) {
  console.log(`[fetch-node] ${version} already in ${path.relative(ROOT, BIN)}`);
  process.exit(0);
}

const dirName = `node-${version}-win-x64`;
const zipName = `${dirName}.zip`;
const url = `${DIST}/${version}/${zipName}`;
console.log(`[fetch-node] downloading ${url}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-node-'));
const zipPath = path.join(tmp, zipName);
try {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  const shasums = await text(`${DIST}/${version}/SHASUMS256.txt`);
  const line = shasums.split(/\r?\n/).find((l) => l.trim().endsWith(` ${zipName}`) || l.trim().endsWith(`*${zipName}`));
  if (!line) throw new Error(`${zipName} missing from SHASUMS256.txt`);
  const expected = line.trim().split(/\s+/)[0];
  const actual = sha256(zipPath);
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${zipName}\n  expected ${expected}\n  got      ${actual}`);
  console.log(`[fetch-node] sha256 ok (${expected.slice(0, 16)}…)`);

  extract(zipPath, [`${dirName}/node.exe`, `${dirName}/LICENSE`], tmp);
  fs.mkdirSync(BIN, { recursive: true });
  fs.copyFileSync(path.join(tmp, dirName, 'node.exe'), EXE);
  fs.copyFileSync(path.join(tmp, dirName, 'LICENSE'), LICENSE);
  fs.writeFileSync(STAMP, `${version}\n`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const check = spawnSync(EXE, ['-v'], { encoding: 'utf8' });
console.log(`[fetch-node] ${path.relative(ROOT, EXE)} -> ${check.stdout?.trim() || 'no output'}`);
