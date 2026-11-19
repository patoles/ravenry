// An HTML page drawn as a picture, for a pick's HTML variant (GET
// /api/checkpoints/<id>/variants/<n>?as=png): what the Mac app draws on a
// pick's card and in its picker, and what the board's tiles and Compare show.
//
// Drawn by the Mac's own Quick Look (qlmanage -t, WebKit), which every Mac
// has. It used to be headless Chromium through Playwright, a development
// dependency that the installed app never ships: there every page variant
// failed (501) and the Mac app drew two empty dark wells ("Both are black",
// 2026-11-19), while the same pictures as .jpg showed.
//
// The same protection as before: Quick Look's thumbnailer runs no
// JavaScript and fetches nothing from the network, and the copy it draws
// gets a Content-Security-Policy that lets in only what the page carries
// itself (inline styles, data: images, fonts and media), so a page never
// draws a file of this Mac it names (file://, a path beside it).
//
// Quick Look lays a page out 1024 CSS pixels wide and draws a square; the
// picture is its top, 16:10, as the pick's tiles are (cut here: sips crops
// only around the middle, whatever its --cropOffset says).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { assertDataWrite } from './home.mjs';

export const SIZE = 1600;
export const HEIGHT = Math.round(SIZE * 10 / 16);
export const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:";
const QLMANAGE = '/usr/bin/qlmanage';

const run = (bin, args, ms = 20000) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: ms, maxBuffer: 1 << 20 }, (e, out, err) => (e ? reject(new Error(`${path.basename(bin)}: ${String(err || e.message).trim().split('\n')[0].slice(0, 200)}`)) : resolve(String(out))));
});

// The page with the policy first in its head: after a doctype (a tag before
// it would put the page in quirks mode), before everything else.
export function withPolicy(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  const s = String(html).replace(/^﻿/, '');
  const m = /^\s*<!doctype[^>]*>/i.exec(s);
  return m ? m[0] + meta + s.slice(m[0].length) : meta + s;
}

// Draws the page `src` (an .html or .htm file) to the PNG `png`, SIZE wide
// and HEIGHT tall. Resolves with `png`, or rejects with what failed.
export async function drawPage(src, png) {
  assertDataWrite(png);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenry-page-'));
  try {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, withPolicy(fs.readFileSync(src, 'utf8')), { mode: 0o600 });
    await run(QLMANAGE, ['-t', '-s', String(SIZE), '-o', dir, page]);
    const thumb = `${page}.png`;
    if (!fs.existsSync(thumb)) throw new Error('Quick Look drew no picture of it');
    fs.writeFileSync(png + '.tmp', topOf(fs.readFileSync(thumb), HEIGHT));
    fs.renameSync(png + '.tmp', png);
    return png;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = zlib.crc32 || ((b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; });

// The top `height` rows of a PNG. A row's filter reads only the rows above
// it, so the first rows of the image data are a whole image as they are.
// One it cannot cut (interlaced, already as short, not a PNG) comes back
// unchanged.
export function topOf(buf, height) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return buf;
  const chunks = [];
  for (let p = 8; p + 12 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    chunks.push({ type: buf.toString('latin1', p + 4, p + 8), data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  const ihdr = chunks[0] && chunks[0].type === 'IHDR' ? chunks[0].data : null;
  if (!ihdr) return buf;
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4), depth = ihdr[8], channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr[9]];
  if (ihdr[12] !== 0 || !channels || h <= height) return buf;
  const rowBytes = 1 + Math.ceil((w * channels * depth) / 8);
  const data = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  if (data.length < rowBytes * h) return buf;
  const head = Buffer.from(ihdr);
  head.writeUInt32BE(height, 4);
  const chunk = (type, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(type, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)) >>> 0, 8 + d.length); return b; };
  const out = [buf.subarray(0, 8), chunk('IHDR', head)];
  let wrote = false;
  for (const c of chunks.slice(1)) {
    if (c.type === 'IDAT') { if (!wrote) out.push(chunk('IDAT', zlib.deflateSync(data.subarray(0, rowBytes * height)))); wrote = true; } else out.push(chunk(c.type, c.data));
  }
  return Buffer.concat(out);
}
