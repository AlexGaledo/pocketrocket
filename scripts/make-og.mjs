// Render packages/site/assets/og.png (1200x630) — the social preview card for the site.
//
// Run: node scripts/make-og.mjs
//
// Composed as one SVG and rasterised with @resvg/resvg-js (already a root devDependency, and the
// same renderer scripts/make-icon.mjs uses). The app screenshot is embedded as a data: URI so
// resvg needs no network or file resolution; it is cropped to the left ~62% of the capture — the
// sidebar plus the conversation, which is what reads at thumbnail size — and bled off the right
// edge of the card so the card looks like a window onto the app rather than a boxed thumbnail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'packages', 'site', 'assets');
const SHOT = path.join(ASSETS, 'app.png');
const OUT = path.join(ASSETS, 'og.png');

const W = 1200;
const H = 630;

if (!fs.existsSync(SHOT)) {
  console.error(`[og] ${SHOT} is missing — capture the app screenshot first`);
  process.exit(1);
}
const shot = 'data:image/png;base64,' + fs.readFileSync(SHOT).toString('base64');

// The capture is 2880x1800 (1440x900 @2x). Show the sidebar + chat column, scaled so the panel
// chrome stays crisp, anchored bottom-right and clipped by the card.
const SHOT_W = 1180;
const SHOT_H = (SHOT_W * 1800) / 2880;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fffcf7"/>
      <stop offset="0.55" stop-color="#faf6ef"/>
      <stop offset="1" stop-color="#f1e8dc"/>
    </linearGradient>
    <radialGradient id="wash" cx="0.86" cy="0.1" r="0.75">
      <stop offset="0" stop-color="#d68c5a" stop-opacity="0.20"/>
      <stop offset="1" stop-color="#d68c5a" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="card"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
    <clipPath id="shotClip"><rect x="470" y="250" width="${W - 470}" height="${H - 250}" rx="20"/></clipPath>
  </defs>

  <g clip-path="url(#card)">
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#wash)"/>

    <!-- app screenshot, bleeding off the bottom-right corner -->
    <g clip-path="url(#shotClip)">
      <image xlink:href="${shot}" x="470" y="250" width="${SHOT_W}" height="${SHOT_H}" preserveAspectRatio="xMinYMin slice"/>
    </g>
    <rect x="470" y="250" width="${W - 470}" height="${H - 250}" rx="20" fill="none" stroke="#e4d8c6" stroke-width="1.5"/>

    <!-- mark -->
    <g transform="translate(72 84) scale(0.96)">
      <circle cx="50" cy="50" r="50" fill="#3a2d23"/>
      <g fill="#FFFFFF"><path d="M30 88C30 66 36 52 50 52C64 52 70 66 70 88Z"/><circle cx="50" cy="40" r="16"/><path d="M36 33L37 16L47 26Z"/><path d="M64 33L63 16L53 26Z"/></g>
      <path d="M68 84C82 84 84 72 76 64" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round"/>
      <ellipse cx="44" cy="41" rx="2.4" ry="3" fill="#3a2d23"/><ellipse cx="56" cy="41" rx="2.4" ry="3" fill="#3a2d23"/>
    </g>

    <text x="180" y="140" font-family="Nunito, Segoe UI, sans-serif" font-size="52" font-weight="800" fill="#33291f" letter-spacing="-1.4">Toki</text>
    <text x="72" y="222" font-family="Nunito, Segoe UI, sans-serif" font-size="34" font-weight="700" fill="#33291f" letter-spacing="-0.6">A cozy home for</text>
    <text x="72" y="262" font-family="Nunito, Segoe UI, sans-serif" font-size="34" font-weight="700" fill="#33291f" letter-spacing="-0.6">your AI helpers.</text>
    <text x="72" y="318" font-family="Nunito, Segoe UI, sans-serif" font-size="21" font-weight="400" fill="#675748">Chat one on one or as a group.</text>
    <text x="72" y="350" font-family="Nunito, Segoe UI, sans-serif" font-size="21" font-weight="400" fill="#675748">Lives on your own computer.</text>

    <rect x="72" y="392" width="196" height="46" rx="23" fill="#3a2d23"/>
    <text x="170" y="422" text-anchor="middle" font-family="Nunito, Segoe UI, sans-serif" font-size="18" font-weight="600" fill="#fffaf2">Free &amp; open source</text>
  </g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { loadSystemFonts: true } }).render().asPng();
fs.writeFileSync(OUT, png);
console.log(`[og] wrote ${OUT} (${(png.length / 1024).toFixed(0)} KB, ${W}x${H})`);
