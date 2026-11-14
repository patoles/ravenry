// The gallery's zoom pictures (sidetest.mjs --screen gallery,
// SelfTestGalleryZoom.swift): a tall full-page shot (2880 x 15714, a web
// page's mockup), a very wide strip (6000 x 400) and a small one (120 x 80),
// each drawn with a coloured frame and a different band every few hundred
// rows so a picture shows which part of it is in view. They go in a
// project's folder and its brief's "## Pictures", so the hub lists them in
// its gallery (brief.gallery, from: brief) and serves them (GET /api/pic).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const GALLERY_PICTURES = [
  { file: 'shots/page-tall.png', alt: 'The whole page, tall', w: 2880, h: 15714, dpi: 144 },
  { file: 'shots/strip-wide.png', alt: 'The timeline, wide', w: 6000, h: 400 },
  { file: 'shots/icon-small.png', alt: 'The icon, small', w: 120, h: 80 },
];

/** An RGB PNG of w x h: a frame of 12 px (6 on the small one), bands of colour down the page, a column of blocks; at `dpi` (a Retina screenshot's 144) when given. */
function picturePng(w, h, seed, dpi = 0) {
  const edge = Math.min(w, h) < 200 ? 6 : 12;
  const frame = [232, 92, 64];
  const bands = [[246, 244, 238], [226, 236, 246], [236, 246, 230], [248, 236, 226]];
  const ink = [[60, 86, 140], [70, 140, 96], [150, 90, 140], [180, 130, 50]];
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  // Each row is one of a few kinds; a kind's bytes are made once and copied.
  const made = new Map();
  for (let y = 0; y < h; y++) {
    const inEdgeY = y < edge || y >= h - edge;
    const band = Math.floor(y / 320) % bands.length;
    const blockRow = !inEdgeY && y % 320 > 60 && y % 320 < 220;
    const key = `${inEdgeY}|${band}|${blockRow}`;
    let r = made.get(key);
    if (!r) {
      r = Buffer.alloc(row);
      for (let x = 0; x < w; x++) {
        let c = bands[(band + seed) % bands.length];
        if (inEdgeY || x < edge || x >= w - edge) c = frame;
        else if (blockRow && x > w * 0.1 && x < w * 0.6) c = ink[(band + seed) % ink.length];
        r.set(c, 1 + x * 3);
      }
      made.set(key, r);
    }
    r.copy(raw, y * row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const phys = Buffer.alloc(9);
  if (dpi) { const ppm = Math.round(dpi / 0.0254); phys.writeUInt32BE(ppm, 0); phys.writeUInt32BE(ppm, 4); phys[8] = 1; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...(dpi ? [chunk('pHYs', phys)] : []), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Writes the pictures into `folder` and lists them in its BRIEF.md's "## Pictures". */
export function galleryPictures(folder) {
  GALLERY_PICTURES.forEach((p, i) => {
    const f = path.join(folder, p.file);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, picturePng(p.w, p.h, i, p.dpi));
  });
  const bf = path.join(folder, 'BRIEF.md');
  fs.appendFileSync(bf, '\n## Pictures\n' + GALLERY_PICTURES.map((p) => `- ${p.file} | ${p.alt}`).join('\n') + '\n');
}
