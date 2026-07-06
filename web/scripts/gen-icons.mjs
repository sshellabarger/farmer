// Regenerates PWA / favicon PNGs from the brand SVG.
// Run from web/: node scripts/gen-icons.mjs
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Leaf mark, centered. Shared between rounded and full-bleed variants.
const leaf = `
  <g transform="translate(256,260)" stroke="#ffffff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M-120 96 C-120 -40 -10 -120 120 -96 C 96 40 -10 120 -120 96 Z"/>
    <path d="M-96 96 C -40 20 40 -40 110 -86"/>
  </g>`;

const gradient = `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2E6B34"/>
      <stop offset="1" stop-color="#4A9B56"/>
    </linearGradient>
  </defs>`;

// Rounded corners + transparent outside — for the "any" purpose icon / browser tab.
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${gradient}
  <rect width="512" height="512" rx="112" fill="url(#g)"/>${leaf}
</svg>`;

// Full bleed: green fills every pixel (rx=0) — for maskable (system masks it)
// and Apple touch icon (iOS rounds it; transparent corners would composite to black).
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${gradient}
  <rect width="512" height="512" fill="url(#g)"/>${leaf}
</svg>`;

const targets = [
  { file: 'icon-192.png', svg: rounded, size: 192 },
  { file: 'icon-512.png', svg: rounded, size: 512 },
  { file: 'icon-512-maskable.png', svg: fullBleed, size: 512 },
  { file: 'apple-touch-icon.png', svg: fullBleed, size: 180 },
];

for (const { file, svg, size } of targets) {
  const png = await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toBuffer();
  await writeFile(join(PUBLIC, file), png);
  console.log(`wrote ${file} (${size}x${size})`);
}
