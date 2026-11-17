#!/usr/bin/env node
// Builds the Tauri updater manifest (latest.json) for one release, from the release's downloaded assets.
// Run once by the `finalize` job in .github/workflows/release.yml, after every platform build has uploaded
// into the draft release. No build job writes latest.json: tauri-action merges it with read-modify-upload and
// no lock, so parallel jobs drop each other's entries (tauri-action #1270).
//
//   node scripts/updater-json.mjs --dir <assets> --repo OWNER/REPO --tag vX.Y.Z \
//     --tauri-conf packages/desktop/src-tauri/tauri.conf.json [--notes-file notes.md] \
//     [--require windows-x86_64,linux-x86_64,darwin-aarch64] [--pub-date ISO] [--out latest.json]
//   node scripts/updater-json.mjs --check-pubkey packages/desktop/src-tauri/tauri.conf.json
//
// Refuses to write anything when a platform is missing, ambiguous, unsigned, or signed by a key other than the
// app's pubkey. Tauri validates the whole file before reading the version, so one bad entry breaks updates
// for every platform.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PUBKEY_PLACEHOLDER = 'OWNER_STEP_PASTE_UPDATER_PUBKEY';
export const DEFAULT_REQUIRED = ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64'];

// Explicit asset -> platform map. Only these bundles carry updates: NSIS setup.exe, AppImage (never the .deb:
// deb users update from the release page) and the macOS .app.tar.gz (never the .dmg).
const RULES = [
  ['windows-x86_64', /_x64-setup\.exe$/],
  ['windows-aarch64', /_arm64-setup\.exe$/],
  ['linux-x86_64', /_(amd64|x86_64)\.AppImage$/],
  ['linux-aarch64', /_(aarch64|arm64)\.AppImage$/],
  ['darwin-x86_64', /_(x64|x86_64)\.app\.tar\.gz$/],
  ['darwin-aarch64', /_(aarch64|arm64)\.app\.tar\.gz$/],
];
const UPDATER_BUNDLE = /(-setup\.exe|\.AppImage|\.app\.tar\.gz)$/;

/** Map asset file names to updater platforms. Throws on an updater bundle with an unknown arch or a duplicate. */
export function classifyAssets(names) {
  const found = {};
  for (const name of names) {
    if (!UPDATER_BUNDLE.test(name)) continue;
    const rule = RULES.find(([, re]) => re.test(name));
    if (!rule) throw new Error(`${name}: updater bundle with no known platform`);
    const [platform] = rule;
    if (found[platform]) throw new Error(`${platform}: more than one bundle (${found[platform]}, ${name})`);
    found[platform] = name;
  }
  return found;
}

/** Decode a base64 minisign file (Tauri's pubkey or .sig format) into its lines. */
function minisignLines(b64, what) {
  const text = Buffer.from(String(b64).trim(), 'base64').toString('utf8');
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith('untrusted comment:')) throw new Error(`${what}: not a base64 minisign file`);
  return lines;
}

/** Parse Tauri's updater pubkey: base64 of a minisign public key file. Returns { keyId, key }. */
export function parsePubkey(b64) {
  const raw = Buffer.from(minisignLines(b64, 'pubkey')[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') throw new Error('pubkey: not an Ed25519 minisign key');
  const x = raw.subarray(10).toString('base64url');
  return { keyId: raw.subarray(2, 10), key: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }) };
}

/**
 * Check a .sig file's contents against the signed file. With a pubkey, verifies both the file signature and the
 * trusted-comment (global) signature; without one, only checks the shape.
 */
export function verifySignature(sigB64, fileBytes, pubkey, what = 'signature') {
  const lines = minisignLines(sigB64, what);
  const sig = Buffer.from(lines[1] ?? '', 'base64');
  const alg = sig.subarray(0, 2).toString();
  if (sig.length !== 74 || (alg !== 'Ed' && alg !== 'ED')) throw new Error(`${what}: malformed minisign signature`);
  const trusted = lines[2]?.startsWith('trusted comment: ') ? lines[2].slice('trusted comment: '.length) : null;
  const globalSig = Buffer.from(lines[3] ?? '', 'base64');
  if (trusted === null || globalSig.length !== 64) throw new Error(`${what}: missing trusted comment`);
  if (!pubkey) return;
  if (!sig.subarray(2, 10).equals(pubkey.keyId)) throw new Error(`${what}: signed by a different key than the app's pubkey`);
  const message = alg === 'ED' ? crypto.createHash('blake2b512').update(fileBytes).digest() : fileBytes;
  if (!crypto.verify(null, message, pubkey.key, sig.subarray(10))) throw new Error(`${what}: signature does not match the file`);
  const globalMsg = Buffer.concat([sig.subarray(10), Buffer.from(trusted, 'utf8')]);
  if (!crypto.verify(null, globalMsg, pubkey.key, globalSig)) throw new Error(`${what}: trusted comment signature is invalid`);
}

/** Read plugins.updater.pubkey from tauri.conf.json; refuses a missing key or the A0 placeholder. */
export function readPubkey(confPath) {
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  const pubkey = conf?.plugins?.updater?.pubkey;
  if (typeof pubkey !== 'string' || !pubkey.trim()) throw new Error(`${confPath}: plugins.updater.pubkey is not set`);
  if (pubkey.includes(PUBKEY_PLACEHOLDER)) throw new Error(`${confPath}: plugins.updater.pubkey is still the placeholder ${PUBKEY_PLACEHOLDER}`);
  parsePubkey(pubkey);
  return pubkey;
}

/**
 * Build the manifest object. `dir` holds the release assets; every included platform needs its bundle and the
 * bundle's .sig. Throws (and writes nothing) on any gap.
 */
export function buildUpdaterJson({ dir, repo, tag, notes = '', pubDate = new Date().toISOString(), required = DEFAULT_REQUIRED, pubkey }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`--repo must be OWNER/REPO, got ${repo}`);
  const version = String(tag ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`--tag must be vX.Y.Z, got ${tag}`);
  if (Number.isNaN(Date.parse(pubDate))) throw new Error(`invalid pub_date ${pubDate}`);
  const key = pubkey ? parsePubkey(pubkey) : null;

  const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
  const bundles = classifyAssets(names);
  const missing = required.filter((p) => !bundles[p]);
  if (missing.length) throw new Error(`missing updater bundle for ${missing.join(', ')}`);

  const errors = [];
  const platforms = {};
  for (const [platform, name] of Object.entries(bundles).sort(([a], [b]) => a.localeCompare(b))) {
    const sigPath = path.join(dir, `${name}.sig`);
    try {
      if (!fs.existsSync(sigPath)) throw new Error(`${platform}: ${name}.sig is missing`);
      const signature = fs.readFileSync(sigPath, 'utf8').trim();
      if (!signature) throw new Error(`${platform}: ${name}.sig is empty`);
      verifySignature(signature, fs.readFileSync(path.join(dir, name)), key, `${platform}: ${name}.sig`);
      const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
      platforms[platform] = { signature, url };
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { version, notes: notes.trim(), pub_date: new Date(pubDate).toISOString(), platforms };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`unexpected argument ${flag}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    args[flag.slice(2)] = value;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['check-pubkey']) {
    readPubkey(args['check-pubkey']);
    console.log('updater pubkey is set');
    return;
  }
  for (const k of ['dir', 'repo', 'tag', 'tauri-conf']) if (!args[k]) throw new Error(`--${k} is required`);
  const manifest = buildUpdaterJson({
    dir: args.dir,
    repo: args.repo,
    tag: args.tag,
    notes: args['notes-file'] ? fs.readFileSync(args['notes-file'], 'utf8') : '',
    pubDate: args['pub-date'],
    required: args.require ? args.require.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_REQUIRED,
    pubkey: readPubkey(args['tauri-conf']),
  });
  const out = args.out ?? 'latest.json';
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${out}: ${manifest.version}, ${Object.keys(manifest.platforms).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    for (const line of String(err.message).split('\n')) console.error(`::error::${line}`);
    process.exit(1);
  }
}
