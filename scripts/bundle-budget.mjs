#!/usr/bin/env node
// Guards the web entry chunk after `pnpm -r build`:
//   1. no @xyflow / React Flow code in it (the workflow canvas must stay a lazy chunk),
//   2. its size stays under a budget, so an accidental static import shows up in CI, not on a user's phone.
//
//   node scripts/bundle-budget.mjs [--dist packages/web/dist] [--max-bytes N]
//
// Budget: the entry chunk measured 1,145,879 bytes on main on 2026-11-19; the limit is that + 15%, rounded.
// Raise it deliberately (with a reason in the PR) when the entry legitimately grows.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_BYTES = 1_320_000;
// Strings that survive minification: the package's CSS class prefix and its name in any bundled banner/error text.
export const XYFLOW_MARKERS = ['@xyflow', 'react-flow__', 'xyflow'];

/** The entry chunk is the module script index.html loads. */
export function entryChunk(distDir) {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const m = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/) ?? html.match(/<script[^>]*src="([^"]+)"[^>]*type="module"/);
  if (!m) throw new Error(`no module script in ${path.join(distDir, 'index.html')}`);
  const rel = m[1].replace(/^\/+/, '');
  const file = path.resolve(distDir, rel);
  if (!file.startsWith(path.resolve(distDir) + path.sep)) throw new Error(`entry script escapes the dist folder: ${m[1]}`);
  return file;
}

export function check(distDir, maxBytes = DEFAULT_MAX_BYTES) {
  const file = entryChunk(distDir);
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  const problems = [];
  for (const marker of XYFLOW_MARKERS) {
    if (text.includes(marker)) problems.push(`entry chunk contains "${marker}": the workflow canvas leaked out of its lazy chunk`);
  }
  if (buf.length > maxBytes) problems.push(`entry chunk is ${buf.length} bytes, over the ${maxBytes} budget`);
  return { file, bytes: buf.length, gzip: gzipSync(buf).length, maxBytes, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const dist = path.resolve(arg('--dist') ?? 'packages/web/dist');
  const max = Number(arg('--max-bytes') ?? DEFAULT_MAX_BYTES);
  if (!Number.isFinite(max) || max <= 0) { console.error('bundle-budget: --max-bytes must be a positive number'); process.exit(2); }
  try {
    const r = check(dist, max);
    console.log(`entry chunk ${path.basename(r.file)}: ${r.bytes} bytes (gzip ${r.gzip}), budget ${r.maxBytes}`);
    if (r.problems.length) { for (const p of r.problems) console.error(`bundle-budget: ${p}`); process.exit(1); }
    console.log('bundle-budget: ok');
  } catch (e) {
    console.error(`bundle-budget: ${e.message}`);
    process.exit(2);
  }
}
