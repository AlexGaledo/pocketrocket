// Render packages/desktop/icon.svg (espresso disc + white sitting cat) into every app icon:
//  - a 1024² PNG handed to `cargo tauri icon`, which writes the platform set into src-tauri/icons/
//  - the web app's PWA icons in packages/web/public/icons/ (any, maskable, apple-touch)
//
// Run: pnpm desktop:icon   (only when the mark changes — both icon folders are committed)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'packages', 'desktop', 'icon.svg');
const PNG = path.join(ROOT, 'packages', 'desktop', 'icon-src.png');
const ICONS = path.join(ROOT, 'packages', 'desktop', 'src-tauri', 'icons');
const WEB_ICONS = path.join(ROOT, 'packages', 'web', 'public', 'icons');

const source = fs.readFileSync(SVG, 'utf8');
const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

// Full-bleed square for platforms that crop the icon themselves (Android maskable, iOS home
// screen): drop the disc, fill the square, and shrink the drawing into the safe zone.
function fullBleed(scale) {
  const inner = source
    .replace(/<svg[^>]*>/, '')
    .replace('</svg>', '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<circle cx="50" cy="50" r="50"[^>]*\/>/, '');
  const t = 50 - 50 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#3a2d23"/><g transform="translate(${t} ${t}) scale(${scale})">${inner}</g></svg>`;
}

const png = render(source, 1024);
fs.writeFileSync(PNG, png);
console.log(`[icon] ${path.relative(ROOT, PNG)} (${(png.length / 1024).toFixed(0)} KB)`);

const web = [
  ['icon-192.png', source, 192],
  ['icon-512.png', source, 512],
  ['maskable-512.png', fullBleed(0.8), 512],
  ['apple-touch-icon.png', fullBleed(0.9), 180],
];
for (const [name, svg, size] of web) {
  fs.writeFileSync(path.join(WEB_ICONS, name), render(svg, size));
  console.log(`[icon] ${path.relative(ROOT, path.join(WEB_ICONS, name))}`);
}

const r = spawnSync('cargo', ['tauri', 'icon', PNG, '-o', ICONS], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) {
  console.error('[icon] `cargo tauri icon` failed — is tauri-cli installed (`cargo install tauri-cli --locked`)?');
  process.exit(r.status ?? 1);
}
console.log(`[icon] icon set written to ${path.relative(ROOT, ICONS)}`);
