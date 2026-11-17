// node --test scripts/*.test.mjs  (also part of `pnpm test`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildUpdaterJson, classifyAssets, readPubkey, PUBKEY_PLACEHOLDER } from './updater-json.mjs';

// Minisign keys and signatures in Tauri's format (base64 of the whole minisign text file), so the fixtures
// exercise the same verification the release runs against real `cargo tauri signer` output.
function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = crypto.randomBytes(8);
  const pk = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const keyLine = Buffer.concat([Buffer.from('Ed'), keyId, pk]).toString('base64');
  const pubkey = Buffer.from(`untrusted comment: minisign public key: TEST\n${keyLine}\n`).toString('base64');
  const sign = (bytes, name) => {
    const sig = crypto.sign(null, crypto.createHash('blake2b512').update(bytes).digest(), privateKey);
    const trusted = `timestamp:1763400000\tfile:${name}`;
    const globalSig = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
    const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64')}\ntrusted comment: ${trusted}\n${globalSig.toString('base64')}\n`;
    return Buffer.from(text).toString('base64');
  };
  return { pubkey, sign };
}

const KEY = makeKey();
const BUNDLES = ['PocketRocket_0.4.0_x64-setup.exe', 'PocketRocket_0.4.0_amd64.AppImage', 'PocketRocket_aarch64.app.tar.gz'];
const OTHERS = ['pocket-rocket_0.4.0_amd64.deb', 'PocketRocket_0.4.0_aarch64.dmg'];

/** A release-assets dir like the finalize job downloads: bundles, their .sig files, and non-updater assets. */
function fixture({ bundles = BUNDLES, key = KEY, skipSig = [], extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-json-'));
  for (const name of [...bundles, ...OTHERS]) {
    const bytes = Buffer.from(`fake ${name}`);
    fs.writeFileSync(path.join(dir, name), bytes);
    if (!skipSig.includes(name)) fs.writeFileSync(path.join(dir, `${name}.sig`), key.sign(bytes, name));
  }
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const base = (dir) => ({ dir, repo: 'AlexGaledo/pocketrocket', tag: 'v0.4.0', notes: '  Fixes.\n', pubDate: '2026-11-17T00:00:00Z', pubkey: KEY.pubkey });

test('builds one manifest with the three platform keys', () => {
  const dir = fixture();
  const m = buildUpdaterJson(base(dir));
  assert.equal(m.version, '0.4.0');
  assert.equal(m.notes, 'Fixes.');
  assert.equal(m.pub_date, '2026-11-17T00:00:00.000Z');
  assert.deepEqual(Object.keys(m.platforms), ['darwin-aarch64', 'linux-x86_64', 'windows-x86_64']);
  assert.equal(m.platforms['windows-x86_64'].url, 'https://github.com/AlexGaledo/pocketrocket/releases/download/v0.4.0/PocketRocket_0.4.0_x64-setup.exe');
  assert.equal(m.platforms['linux-x86_64'].url.endsWith('.AppImage'), true, 'linux never points at the .deb');
  assert.equal(m.platforms['darwin-aarch64'].url.endsWith('.app.tar.gz'), true, 'macOS never points at the .dmg');
  assert.equal(m.platforms['windows-x86_64'].signature, fs.readFileSync(path.join(dir, `${BUNDLES[0]}.sig`), 'utf8').trim());
});

test('a missing .sig fails the whole manifest', () => {
  const dir = fixture({ skipSig: [BUNDLES[1]] });
  assert.throws(() => buildUpdaterJson(base(dir)), /linux-x86_64: .*\.AppImage\.sig is missing/);
});

test('an empty or garbage .sig fails', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, `${BUNDLES[0]}.sig`), '\n');
  assert.throws(() => buildUpdaterJson(base(dir)), /windows-x86_64: .* is empty/);
  fs.writeFileSync(path.join(dir, `${BUNDLES[0]}.sig`), 'bm90IGEgc2ln');
  assert.throws(() => buildUpdaterJson(base(dir)), /not a base64 minisign file/);
});

test('a required platform with no bundle fails', () => {
  const dir = fixture({ bundles: BUNDLES.slice(0, 2) });
  assert.throws(() => buildUpdaterJson(base(dir)), /missing updater bundle for darwin-aarch64/);
  assert.equal(Object.keys(buildUpdaterJson({ ...base(dir), required: ['windows-x86_64'] }).platforms).length, 2);
});

test('a signature from another key, or over other bytes, fails', () => {
  const other = makeKey();
  assert.throws(() => buildUpdaterJson(base(fixture({ key: other }))), /signed by a different key/);
  const dir = fixture();
  fs.writeFileSync(path.join(dir, BUNDLES[2]), 'tampered');
  assert.throws(() => buildUpdaterJson(base(dir)), /darwin-aarch64: .*signature does not match the file/);
});

test('ambiguous or unknown bundles are refused', () => {
  assert.throws(() => classifyAssets(['A_0.4.0_x64-setup.exe', 'B_0.4.0_x64-setup.exe']), /more than one bundle/);
  assert.throws(() => classifyAssets(['A_0.4.0_riscv64.AppImage']), /no known platform/);
  assert.deepEqual(classifyAssets([...OTHERS, 'A_0.4.0_aarch64.AppImage', 'A_x64.app.tar.gz', 'SHA256SUMS.txt']), {
    'linux-aarch64': 'A_0.4.0_aarch64.AppImage',
    'darwin-x86_64': 'A_x64.app.tar.gz',
  });
});

test('bad tag or repo is refused', () => {
  const dir = fixture();
  assert.throws(() => buildUpdaterJson({ ...base(dir), tag: 'latest' }), /--tag/);
  assert.throws(() => buildUpdaterJson({ ...base(dir), repo: 'nope' }), /--repo/);
});

test('readPubkey refuses a missing key or the placeholder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-conf-'));
  const conf = path.join(dir, 'tauri.conf.json');
  fs.writeFileSync(conf, JSON.stringify({ plugins: {} }));
  assert.throws(() => readPubkey(conf), /pubkey is not set/);
  fs.writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: PUBKEY_PLACEHOLDER } } }));
  assert.throws(() => readPubkey(conf), /still the placeholder/);
  fs.writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: KEY.pubkey } } }));
  assert.equal(readPubkey(conf), KEY.pubkey);
});
