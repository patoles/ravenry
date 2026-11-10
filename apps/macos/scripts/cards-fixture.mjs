// The checkpoint cards' fixture (sidetest.mjs --screen cards): one open
// checkpoint of each kind, as a daemon reports it (PROTOCOL.md section 4)
// with the hub's words (hub/server/cpwords.mjs withWords) and its project
// and session as the hub's state lists them, each on a session of the demo
// hub. The pick's three pictures are kept in the demo hub's data as the
// hub keeps a pick's copies (hub/server/picks.mjs), so GET
// /api/checkpoints/<id>/variants/<n> serves them.
//
// The same list feeds the Electron reference shots (S.cps.fromDaemon), so
// both apps draw the same cards.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { withWords } from '../../../hub/server/cpwords.mjs';

const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

/** A 320 x 200 PNG of a paper boat on water, its hull tilted by `tilt` and in `hull`'s colour. */
export function boatPng(tilt, hull, sky = [214, 230, 245]) {
  const W = 320, H = 200;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      let c = y > 140 ? [86, 140, 196] : sky;
      // The hull: a trapezoid around (160, 130), tilted.
      const dx = x - 160, dy = y - 128 - dx * tilt;
      if (dy > -14 && dy < 14 && Math.abs(dx) < 90 - (dy + 14) * 1.2) c = hull;
      // The sail: a triangle above it.
      const sy = y - 50 - dx * tilt;
      if (dx > -6 && sy > 0 && sy < 64 && dx < sy * 0.9) c = [250, 250, 248];
      raw.set(c, y * (W * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * The checkpoints, on the demo hub's sessions: `state` is its /api/state,
 * `home` the demo hub's data folder (the pick's pictures go there).
 */
export function cardFixtures(state, home, now = Date.now()) {
  const sessions = [];
  for (const p of state.projects || []) for (const s of p.sessions || []) sessions.push({ p, s });
  const on = (id) => sessions.find((x) => x.p.id === id) || sessions[0];
  const base = (id, kind, at, title, extra) => {
    const { p, s } = on(at);
    return withWords({
      id, kind, state: 'open', title, assistant: 'claude', created_at: iso(now - 3 * MIN), expires_at: iso(now + 57 * MIN),
      pane: null, cwd: p.folder || null, machine: null, projectId: p.id, project: p.name, surfaceId: s.surfaceId, ...extra,
    }, { platform: 'darwin' });
  };
  const cps = [
    base('cpask1', 'ask', 'paper-boat', 'Tilt the hull with the slope too, or keep it level?\nThe slope is 8 degrees on the test pond.', {
      options: ['Tilt it with the slope', 'Keep it level', 'Try both and show me'], free_text: true,
    }),
    base('cpapprove1', 'approve', 'notes-app', 'Run npm publish --tag beta', {
      command: 'npm publish --tag beta', warning: 'This publishes 0.9.0-beta.2 to the registry for the testers.',
      why: 'The settings screen is done and the testers are waiting on the beta.',
      env: { NOTES_CHANNEL: 'beta' },
    }),
    base('cpsecret1', 'secret', 'garden-planner', 'Paste the Cloudflare API token for the map tiles', {
      command: 'npx wrangler secret put TILES_TOKEN', secret: { to: 'env', env: 'TILES_TOKEN' },
    }),
    base('cppick1', 'pick', 'recipe-box', 'Which hull shape for the boat?\nAll three float; B is the fastest on the pond.', {
      variants: [
        { label: 'Flat hull', type: 'image', source: '/tmp/boat-a.png', description: 'Steady, the easiest to make.' },
        { label: 'V hull', type: 'image', source: '/tmp/boat-b.png', description: 'Cuts through the ripples.' },
        { label: 'Round hull', type: 'image', source: '/tmp/boat-c.png' },
      ],
    }),
  ];
  const pick = cps[3];
  const dir = path.join(home, 'projects', pick.projectId, 'picks', pick.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const shapes = [[0, [196, 86, 64]], [0.12, [72, 120, 190]], [-0.08, [90, 160, 96]]];
  const variants = pick.variants.map((v, n) => {
    fs.writeFileSync(path.join(dir, `${n}.png`), boatPng(...shapes[n]));
    return { label: v.label, type: 'image', source: v.source, file: `${n}.png`, size: fs.statSync(path.join(dir, `${n}.png`)).size, ...(v.description ? { description: v.description } : {}) };
  });
  fs.writeFileSync(path.join(dir, 'pick.json'), JSON.stringify({ checkpoint: pick.id, title: pick.title, project: pick.projectId, machine: null, created_at: pick.created_at, variants }, null, 2));
  return cps;
}
