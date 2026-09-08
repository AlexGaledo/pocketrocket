// Single source of version truth: root package.json.
//
//   node scripts/version.mjs           check mode: verify every file agrees, exit 1 on drift
//   node scripts/version.mjs --check   same as above (explicit)
//   node scripts/version.mjs x.y.z     set mode: write x.y.z to every file below
//
// Files kept in sync:
//   package.json                                        "version"
//   packages/{hub,web,shared,desktop,site}/package.json  "version"
//   packages/desktop/src-tauri/tauri.conf.json           "version"
//   packages/desktop/src-tauri/Cargo.toml                [package] version (regex edit, formatting untouched)
//
// Cargo.lock is NOT touched here — after bumping, run `cargo check` (see docs/RELEASING.md) so
// cargo updates the lockfile's pocketrocket-desktop entry, then commit it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const PACKAGE_JSON_FILES = [
  'package.json',
  'packages/hub/package.json',
  'packages/web/package.json',
  'packages/shared/package.json',
  'packages/desktop/package.json',
  'packages/site/package.json',
];
const TAURI_CONF = 'packages/desktop/src-tauri/tauri.conf.json';
const CARGO_TOML = 'packages/desktop/src-tauri/Cargo.toml';

function readVersionFromPackageJson(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const m = text.match(/"version"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error(`${rel}: no "version" field found`);
  return m[1];
}

function writeVersionToPackageJson(rel, version) {
  const file = path.join(ROOT, rel);
  const text = fs.readFileSync(file, 'utf8');
  let hit = false;
  const next = text.replace(/"version"\s*:\s*"([^"]+)"/, (m) => {
    hit = true;
    return m.replace(/"[^"]+"$/, `"${version}"`);
  });
  if (!hit) throw new Error(`${rel}: no "version" field found`);
  fs.writeFileSync(file, next);
}

function readVersionFromTauriConf() {
  const text = fs.readFileSync(path.join(ROOT, TAURI_CONF), 'utf8');
  const m = text.match(/"version"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error(`${TAURI_CONF}: no "version" field found`);
  return m[1];
}

function writeVersionToTauriConf(version) {
  writeVersionToPackageJson(TAURI_CONF, version);
}

// Cargo.toml: only the `version = "..."` line inside the [package] table, never a dependency's
// `version = "..."` inside `foo = { version = "...", ... }` or a `[dependencies]` table.
function packageSectionRange(text) {
  const lines = text.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\[package\]\s*$/.test(lines[i])) {
      start = i;
      continue;
    }
    if (start >= 0 && i > start && /^\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start < 0) throw new Error(`${CARGO_TOML}: no [package] section found`);
  return { lines, start, end };
}

function readVersionFromCargoToml() {
  const text = fs.readFileSync(path.join(ROOT, CARGO_TOML), 'utf8');
  const { lines, start, end } = packageSectionRange(text);
  for (let i = start; i < end; i++) {
    const m = lines[i].match(/^version\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  throw new Error(`${CARGO_TOML}: no version field in [package] section`);
}

function writeVersionToCargoToml(version) {
  const file = path.join(ROOT, CARGO_TOML);
  const text = fs.readFileSync(file, 'utf8');
  const { lines, start, end } = packageSectionRange(text);
  let hit = false;
  for (let i = start; i < end; i++) {
    if (/^version\s*=\s*"([^"]+)"/.test(lines[i])) {
      lines[i] = lines[i].replace(/"[^"]+"/, `"${version}"`);
      hit = true;
      break;
    }
  }
  if (!hit) throw new Error(`${CARGO_TOML}: no version field in [package] section`);
  fs.writeFileSync(file, lines.join('\n'));
}

function allSources() {
  return [
    ...PACKAGE_JSON_FILES.map((rel) => ({ rel, read: () => readVersionFromPackageJson(rel) })),
    { rel: TAURI_CONF, read: readVersionFromTauriConf },
    { rel: CARGO_TOML, read: readVersionFromCargoToml },
  ];
}

function check() {
  const sources = allSources();
  const readings = sources.map((s) => ({ rel: s.rel, version: s.read() }));
  const authoritative = readings[0].version; // package.json is first and authoritative
  const drift = readings.filter((r) => r.version !== authoritative);
  for (const r of readings) {
    console.log(`  ${r.version === authoritative ? 'ok  ' : 'DRIFT'}  ${r.rel} = ${r.version}`);
  }
  if (drift.length > 0) {
    console.error(`version drift: expected ${authoritative} everywhere, ${drift.length} file(s) disagree`);
    process.exit(1);
  }
  console.log(`version ${authoritative} is consistent across ${readings.length} files`);
}

function set(version) {
  if (!SEMVER_RE.test(version)) {
    console.error(`invalid version "${version}" (expected x.y.z, optionally with -prerelease/+build)`);
    process.exit(1);
  }
  for (const rel of PACKAGE_JSON_FILES) writeVersionToPackageJson(rel, version);
  writeVersionToTauriConf(version);
  writeVersionToCargoToml(version);
  console.log(
    `version set to ${version} in ${PACKAGE_JSON_FILES.length + 2} files (run "cargo check" next to update Cargo.lock)`,
  );
}

const arg = process.argv[2];
if (arg === undefined || arg === '--check') {
  check();
} else {
  set(arg);
}
