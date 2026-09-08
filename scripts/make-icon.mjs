// Render packages/desktop/icon.svg (black disc + white rocket) to a 1024² PNG and hand it to
// `cargo tauri icon`, which writes the whole platform icon set into src-tauri/icons/.
//
// Run: pnpm desktop:icon   (only when the mark changes — src-tauri/icons is committed)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'packages', 'desktop', 'icon.svg');
const PNG = path.join(ROOT, 'packages', 'desktop', 'icon-src.png');
const ICONS = path.join(ROOT, 'packages', 'desktop', 'src-tauri', 'icons');

const png = new Resvg(fs.readFileSync(SVG, 'utf8'), { fitTo: { mode: 'width', value: 1024 } }).render().asPng();
fs.writeFileSync(PNG, png);
console.log(`[icon] ${path.relative(ROOT, PNG)} (${(png.length / 1024).toFixed(0)} KB)`);

const r = spawnSync('cargo', ['tauri', 'icon', PNG, '-o', ICONS], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) {
  console.error('[icon] `cargo tauri icon` failed — is tauri-cli installed (`cargo install tauri-cli --locked`)?');
  process.exit(r.status ?? 1);
}
console.log(`[icon] icon set written to ${path.relative(ROOT, ICONS)}`);
