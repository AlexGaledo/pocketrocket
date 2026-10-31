import { createECDH, createPrivateKey, createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { restrictFile } from '../config.js';

/*
 * P9: Web Push without a dependency. Two RFCs, both small:
 *   - RFC 8292 (VAPID): an ES256 JWT signed with a key pair minted on this machine, so the push service knows
 *     which application server is talking. Nothing is registered anywhere.
 *   - RFC 8291 (message encryption, `aes128gcm` from RFC 8188): the payload is encrypted to the browser's own
 *     key, so Apple/Google/Mozilla carry ciphertext only. And PocketRocket's payloads are content-free anyway
 *     (decision Q10): `{"kind":"approval"}` and nothing else.
 */

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: what the browser's `applicationServerKey` wants. */
  publicKey: string;
  privateKey: KeyObject;
}

/** Loads `file` or mints and saves a fresh pair (0600). The JWK is the only thing on disk. */
export function loadOrCreateVapid(file: string): VapidKeys {
  let jwk: JsonWebKey | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonWebKey;
    if (j.kty === 'EC' && j.crv === 'P-256' && j.d && j.x && j.y) jwk = j;
  } catch { /* none yet */ }
  if (!jwk) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = privateKey.export({ format: 'jwk' }) as JsonWebKey;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
      restrictFile(file);
    } catch (e) {
      console.warn('[push] could not save ' + file + ': ' + (e as Error).message);
    }
  }
  return vapidFromJwk(jwk);
}

export function vapidFromJwk(jwk: JsonWebKey): VapidKeys {
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: b64u(pub), privateKey };
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for one push service origin. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const sig = sign('sha256', Buffer.from(header + '.' + claims), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + header + '.' + claims + '.' + b64u(sig) + ', k=' + keys.publicKey;
}

/**
 * RFC 8291 `aes128gcm` body for one subscription: salt(16) | rs(4) | idlen(1) | as_public(65) | ciphertext.
 * `p256dh` and `auth` are the subscription's base64url keys. `salt`/`ecdh` are injectable for tests only.
 */
export function encryptPayload(
  plaintext: Buffer,
  sub: { p256dh: string; auth: string },
  test: { salt?: Buffer; ecdh?: ReturnType<typeof createECDH> } = {},
): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh key');
  if (authSecret.length < 16) throw new Error('bad auth secret');
  const ecdh = test.ecdh ?? createECDH('prime256v1');
  if (!test.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = test.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record; 0x02 marks it as the last one (no padding).
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/**
 * Where a subscription may point. A browser only ever hands out an endpoint at its vendor's push service; any
 * other URL (a LAN address, a webhook, 127.0.0.1) would turn "send a push" into a request this hub makes to a
 * place a phone chose, so it is refused when subscribing.
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const h = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((p) => h === p || h.endsWith('.' + p));
}
