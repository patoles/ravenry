// Every frame the window draws, for tools/flash-check.mjs: loaded in the
// main process by the driver's `main` steps (an offscreen window gives each
// frame it composites through its 'paint' event). Never part of the app.
//
//   start(win, { scale })   keep each frame from now, at scale (0.5: half size)
//   mark(name)              a moment to measure from (a click, a drag's start)
//   stop(win)               the frames kept and the marks
//   inkIn(f, rect, bg)      the share of a rect's pixels that are not the background
//   diffIn(a, b, rect)      the share of a rect's pixels that differ between two frames
//   png(f)                  a frame as PNG bytes
const { nativeImage } = require('electron');

let rec = null;
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

// The last frame drawn, always (a still window draws none while recording:
// the frame it shows is this one).
let last = null;
const watched = new WeakSet();
function keep(image, scale) {
  const full = image.getSize();
  const w = Math.max(1, Math.round(full.width * scale));
  const img = image.resize({ width: w, quality: 'good' });
  const size = img.getSize();
  return { w: size.width, h: size.height, full, bmp: img.toBitmap() };
}

exports.start = (win, opts = {}) => {
  const wc = win.webContents;
  if (!watched.has(wc)) {
    watched.add(wc);
    wc.on('paint', (_e, _dirty, image) => {
      last = { image, t: now() };
      if (!rec) return;
      if (rec.frames.length >= rec.max) { rec.dropped++; return; }
      rec.frames.push({ t: last.t, ...keep(image, rec.scale) });
    });
  }
  rec = { frames: [], marks: [], scale: opts.scale || 0.5, max: opts.max || 900, dropped: 0 };
  if (last) rec.frames.push({ t: now(), ...keep(last.image, rec.scale) });
  wc.invalidate();
  return true;
};

exports.mark = (name, extra = {}) => { if (rec) rec.marks.push({ name, t: now(), ...extra }); return true; };
exports.now = now;

exports.stop = () => {
  if (!rec) return null;
  const r = rec;
  rec = null;
  return r;
};

// A rect in CSS pixels of the window, on the frame's own scale (the frame's
// width over the window's content width at the time).
function box(f, rect, cssW) {
  const k = f.w / cssW;
  const x0 = Math.max(0, Math.floor(rect.x * k)), y0 = Math.max(0, Math.floor(rect.y * k));
  const x1 = Math.min(f.w, Math.ceil((rect.x + rect.w) * k)), y1 = Math.min(f.h, Math.ceil((rect.y + rect.h) * k));
  return { x0, y0, x1, y1 };
}
const lum = (b, i) => (b[i] * 0.114 + b[i + 1] * 0.587 + b[i + 2] * 0.299); // BGRA

exports.inkIn = (f, rect, cssW, bg = null, tol = 40) => {
  const { x0, y0, x1, y1 } = box(f, rect, cssW);
  if (x1 <= x0 || y1 <= y0) return 0;
  const b = f.bmp;
  // The background: the commonest luminance in the rect, unless given.
  let base = bg;
  if (base === null) {
    const hist = new Uint32Array(256);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) hist[Math.round(lum(b, (y * f.w + x) * 4))]++;
    base = hist.indexOf(Math.max(...hist));
  }
  let ink = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; if (Math.abs(lum(b, (y * f.w + x) * 4) - base) > tol) ink++; }
  return n ? ink / n : 0;
};

exports.diffIn = (a, b2, rect, cssW, tol = 40) => {
  if (a.w !== b2.w || a.h !== b2.h) return 1;
  const { x0, y0, x1, y1 } = box(a, rect, cssW);
  let d = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; const i = (y * a.w + x) * 4; if (Math.abs(lum(a.bmp, i) - lum(b2.bmp, i)) > tol) d++; }
  return n ? d / n : 0;
};

exports.png = (f) => nativeImage.createFromBitmap(f.bmp, { width: f.w, height: f.h }).toPNG();
