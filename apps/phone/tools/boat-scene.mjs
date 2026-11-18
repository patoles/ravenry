// The phone demo's pick (tools/demo.mjs --sample, tools/demo-sample.mjs):
// three renders of one moment, as a game's agent would show them, a paper
// boat on a big wave at dusk: level, tilted with the slope (spray over the
// bow) and tilted half as much. Drawn here; nothing comes from a game.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The three variants: the label the agent gives each, and its line about it. */
export const BOAT = [
  { file: 'level', tilt: 0, spray: 0, label: 'Level', describe: 'Level, the boat sits flat and the wave moves under it.' },
  { file: 'slope', tilt: -24, spray: 2, label: 'With the slope', describe: 'The hull follows the wave at the bow, with spray.' },
  { file: 'half', tilt: -12, spray: 1, label: 'Half the slope', describe: 'Follows the wave half as much. Less spray.' },
];

export function scene(tilt, spray) {
  const drops = spray === 2 ? [[332, 150, 7], [347, 137, 5], [323, 131, 6], [354, 160, 4], [339, 120, 4], [311, 146, 5], [362, 143, 3], [329, 110, 3], [349, 170, 5]]
    : spray === 1 ? [[330, 172, 4], [342, 163, 3], [319, 165, 3]] : [];
  const y = tilt === 0 ? 200 : 206;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7FB2E0"/><stop offset="1" stop-color="#B9D8F0"/></linearGradient>
<linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2D6C8C"/><stop offset="1" stop-color="#163852"/></linearGradient></defs>
<rect width="640" height="400" fill="url(#s)"/><circle cx="498" cy="118" r="34" fill="#FFF1B8"/>
<path d="M0 302 C82 297 132 291 172 277 C216 262 252 214 301 190 C337 172 373 179 396 201 C432 238 472 287 640 301 L640 400 L0 400Z" fill="url(#w)"/>
<path d="M152 284 C212 261 252 214 301 190 C337 172 373 179 396 201" fill="none" stroke="#DCEFF4" stroke-width="3" opacity=".8"/>
<path d="M0 341 C122 331 222 353 331 339 C441 325 521 347 640 335 L640 400 L0 400Z" fill="#11304A" opacity=".82"/>
<g transform="translate(266 ${y}) rotate(${tilt})"><path d="M-62 -2 L62 -2 L42 24 L-42 24Z" fill="#F4F0E6" stroke="#B8B0A0" stroke-width="2"/><path d="M-40 -2 L-4 -66 L34 -2Z" fill="#FFFFFF" stroke="#B8B0A0" stroke-width="2"/><path d="M-4 -66 L-4 -2" stroke="#D5CEBE" stroke-width="1.5"/></g>
${drops.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#F3FAFC" opacity=".92"/>`).join('')}
</svg>`;
}

/** The three pictures as PNG files in `dir` (headless Chromium), in BOAT's order. */
export async function boatPictures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const { chromium } = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
  const b = await chromium.launch({ headless: true });
  const out = [];
  try {
    const p = await b.newPage({ viewport: { width: 640, height: 400 } });
    for (const v of BOAT) {
      await p.setContent(`<html><body style="margin:0">${scene(v.tilt, v.spray)}</body></html>`);
      const f = path.join(dir, `${v.file}.png`);
      await p.screenshot({ path: f });
      out.push(f);
    }
  } finally { await b.close(); }
  return out;
}
