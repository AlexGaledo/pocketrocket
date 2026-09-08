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
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#f7f7f8"/>
      <stop offset="1" stop-color="#eceef3"/>
    </linearGradient>
    <radialGradient id="wash" cx="0.86" cy="0.1" r="0.75">
      <stop offset="0" stop-color="#4f7df3" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#4f7df3" stop-opacity="0"/>
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
    <rect x="470" y="250" width="${W - 470}" height="${H - 250}" rx="20" fill="none" stroke="#dcdfe5" stroke-width="1.5"/>

    <!-- mark -->
    <g transform="translate(72 84) scale(0.0938)">
      <circle cx="512" cy="512" r="512" fill="#111214"/>
      <g transform="translate(512 512) rotate(45) translate(-512 -512)" fill="#FFFFFF">
        <path d="M512 176c96 0 168 128 168 336v168H344V512c0-208 72-336 168-336z"/>
        <path d="M344 560l-96 96v128l96-64zM680 560l96 96v128l-96-64z"/>
        <circle cx="512" cy="452" r="58" fill="#111214"/>
        <circle cx="512" cy="452" r="34" fill="#FFFFFF"/>
        <path d="M440 680h144l24 56H416z"/>
      </g>
      <circle cx="318" cy="742" r="46" fill="#FFFFFF" opacity="0.9"/>
      <circle cx="236" cy="808" r="30" fill="#FFFFFF" opacity="0.6"/>
    </g>

    <text x="180" y="140" font-family="Geist, Segoe UI, sans-serif" font-size="52" font-weight="700" fill="#111214" letter-spacing="-1.4">PocketRocket</text>
    <text x="72" y="232" font-family="Geist, Segoe UI, sans-serif" font-size="34" font-weight="500" fill="#3b4048" letter-spacing="-0.6">Your pocket fleet of AI agents.</text>
    <text x="72" y="300" font-family="Geist, Segoe UI, sans-serif" font-size="21" font-weight="400" fill="#6e7681">Claude · Codex · OpenCode · Grok</text>
    <text x="72" y="336" font-family="Geist, Segoe UI, sans-serif" font-size="21" font-weight="400" fill="#6e7681">Runs on your machine. Windows installer.</text>

    <rect x="72" y="392" width="196" height="46" rx="23" fill="#111214"/>
    <text x="170" y="422" text-anchor="middle" font-family="Geist, Segoe UI, sans-serif" font-size="18" font-weight="600" fill="#ffffff">Free &amp; open source</text>
  </g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { loadSystemFonts: true } }).render().asPng();
fs.writeFileSync(OUT, png);
console.log(`[og] wrote ${OUT} (${(png.length / 1024).toFixed(0)} KB, ${W}x${H})`);
