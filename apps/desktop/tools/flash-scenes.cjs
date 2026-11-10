// The scenes tools/flash-check.mjs measures, run in the main process by the
// driver's `main` steps: a resize of the window, a split's divider dragged,
// and switches from one view to another, each with every frame kept
// (frames.cjs) and read for a pane gone blank, a half-drawn view or a frame
// that flashes. Never part of the app.
const fs = require('node:fs');
const path = require('node:path');
const F = require('./frames.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (win, code) => win.webContents.executeJavaScript(code, true);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** A rect of an element (CSS pixels), or null. */
async function rectOf(win, sel) {
  return js(win, `(() => { const e = ${sel.startsWith('(') ? sel : `document.querySelector(${JSON.stringify(sel)})`}; if (!e) return null; const b = e.getBoundingClientRect(); return b.width && b.height ? { x: b.x, y: b.y, w: b.width, h: b.height, r: innerWidth - b.right, b: innerHeight - b.bottom } : null; })()`);
}

/**
 * Regions of the frames to read (a function of the window's CSS width at
 * that frame), the frames, and where to put the frames worth seeing.
 * Each region gets: blank (its ink under a third of its median), and
 * one-frame flashes (a frame unlike both its neighbours, which are alike).
 */
function readRegions(rec, regionsAt, dpr) {
  const frames = rec.frames;
  const t0 = rec.marks[0].t;
  const out = {};
  const bad = new Set();
  const names = Object.keys(regionsAt(frames[0].full.width / dpr));
  for (const name of names) {
    const ink = frames.map((f) => { const cw = f.full.width / dpr; return F.inkIn(f, regionsAt(cw)[name], cw); });
    // Its usual ink: the frames before the drag (most frames of a bad drag are blank).
    const med = median(ink.filter((_, i) => frames[i].t < t0));
    const blank = [];
    ink.forEach((v, i) => { if (v < med / 3) { blank.push(i); bad.add(i); } });
    const flash = [];
    for (let i = 1; i < frames.length - 1; i++) {
      const a = frames[i - 1], b = frames[i], c = frames[i + 1];
      if (a.w !== b.w || b.w !== c.w) continue;
      const cw = b.full.width / dpr, rg = regionsAt(cw)[name];
      const ab = F.diffIn(a, b, rg, cw), bc = F.diffIn(b, c, rg, cw), ac = F.diffIn(a, c, rg, cw);
      if (ab > 0.04 && bc > 0.04 && ac < Math.min(ab, bc) / 3) { flash.push(i); bad.add(i); }
    }
    out[name] = { medianInk: +med.toFixed(4), minInk: +Math.min(...ink).toFixed(4), blank: blank.length, flash: flash.length, blankAt: blank.slice(0, 20), flashAt: flash.slice(0, 20) };
  }
  return { regions: out, bad: [...bad].sort((a, b) => a - b) };
}

function saveStrip(rec, idx, dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const i of idx) {
    const f = rec.frames[i];
    if (!f) continue;
    const p = path.join(dir, `${tag}-frame${String(i).padStart(3, '0')}.png`);
    fs.writeFileSync(p, F.png(f));
    files.push(p);
  }
  return files;
}

/** The window from w0 to w1 and back, `steps` sizes each way at 60 Hz. */
exports.resizeWindow = async (win, { name, w0 = 1280, w1 = 900, h = 820, steps = 30, regions, dir }) => {
  const dpr = await js(win, 'devicePixelRatio');
  win.setContentSize(w0, h);
  await sleep(600);
  F.start(win);
  await sleep(200);
  F.mark('drag');
  const sizes = [];
  for (let i = 1; i <= steps; i++) sizes.push(Math.round(w0 + (w1 - w0) * i / steps));
  // Held at the far end for a few frames, as a hand turns round: the one
  // frame there would otherwise be unlike its two (alike) neighbours.
  for (let k = 0; k < 4; k++) sizes.push(w1);
  for (let i = steps - 1; i >= 0; i--) sizes.push(Math.round(w0 + (w1 - w0) * i / steps));
  for (const w of sizes) { win.setContentSize(w, h); await sleep(16); }
  F.mark('end');
  await sleep(500);
  const rec = F.stop(win);
  return report(rec, name, regions, dpr, dir);
};

/** A split's divider dragged by `by` px and back, `steps` moves each way at 60 Hz. */
exports.dragDivider = async (win, { name, by = -200, steps = 30, regions, dir }) => {
  const dpr = await js(win, 'devicePixelRatio');
  const g = await rectOf(win, '#split .gutter');
  if (!g) throw new Error('no divider');
  // Input events are in window pixels: the page's (CSS) times its zoom (a test's Retina scale).
  const x = Math.round((g.x + g.w / 2) * dpr), y = Math.round((g.y + g.h / 2) * dpr);
  by = Math.round(by * dpr);
  const wc = win.webContents;
  F.start(win);
  await sleep(200);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  F.mark('drag');
  const xs = [];
  for (let i = 1; i <= steps; i++) xs.push(Math.round(x + by * i / steps));
  for (let k = 0; k < 4; k++) xs.push(x + by);
  for (let i = steps - 1; i >= 0; i--) xs.push(Math.round(x + by * i / steps));
  for (const px of xs) { wc.sendInputEvent({ type: 'mouseMove', x: px, y, button: 'left' }); await sleep(16); }
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  F.mark('end');
  await sleep(500);
  const rec = F.stop(win);
  return report(rec, name, regions, dpr, dir, { x, by });
};

function report(rec, name, regionsFn, dpr, dir, extra = {}) {
  const regionsAt = typeof regionsFn === 'function' ? regionsFn : new Function('w', `return (${regionsFn})(w);`);
  const r = readRegions(rec, regionsAt, dpr);
  const t0 = rec.marks[0].t, t1 = rec.marks[1].t;
  const during = rec.frames.map((f, i) => [f, i]).filter(([f]) => f.t >= t0 && f.t <= t1 + 300).map(([, i]) => i);
  // A strip from the middle of the drag (and each bad frame, with the one before).
  const mid = during[Math.floor(during.length / 2)] ?? 0;
  const pick = new Set([mid - 2, mid - 1, mid, mid + 1, mid + 2].filter((i) => i >= 0));
  for (const i of r.bad.slice(0, 6)) { pick.add(i - 1); pick.add(i); }
  const strip = saveStrip(rec, [...pick].filter((i) => i >= 0).sort((a, b) => a - b), dir, name);
  return { name, dpr, size0: rec.frames[0].full, region0: (typeof regionsFn === 'function' ? regionsFn : new Function('w', `return (${regionsFn})(w);`))(rec.frames[0].full.width / dpr), frames: rec.frames.length, framesDuringDrag: during.length, dropped: rec.dropped, badFrames: r.bad.length, bad: r.bad.slice(0, 40), regions: r.regions, strip, ...extra };
}

/**
 * Switches: for each, a real click (press, 80 ms, release) on what `at`
 * finds, and every frame from 300 ms before the press to `settle` after. A frame
 * after the click that is like neither the view before nor the one it
 * ends on is a half-drawn or flashed frame; a final view reached, left and
 * reached again is one too.
 */
exports.switches = async (win, { list, dir, settle = 1200, region = null }) => {
  const dpr = await js(win, 'devicePixelRatio');
  const wc = win.webContents;
  const res = [];
  for (const s of list) {
    if (s.before) { await js(win, s.before); await sleep(s.beforeWait ?? 700); }
    const at = await js(win, `(() => { const e = ${s.at}; if (!e) return null; e.scrollIntoView?.({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: Math.round((b.x + b.width / 2) * devicePixelRatio), y: Math.round((b.y + b.height / 2) * devicePixelRatio) }; })()`);
    if (!at) { res.push({ name: s.name, error: `nothing at ${s.at}` }); continue; }
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await sleep(250);
    F.start(win);
    await sleep(300);
    // Frames counted from the press (a row that opens on the press is as
    // quick as it looks); the time to the view, from the release (the click).
    F.mark('press');
    wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await sleep(80);
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    F.mark('click');
    await sleep(s.settle || settle);
    const rec = F.stop(win);
    const tc = rec.marks[0].t, tr = rec.marks[1].t;
    const fr = rec.frames;
    const before = fr.filter((f) => f.t < tc);
    const after = fr.map((f, i) => [f, i]).filter(([f]) => f.t >= tc);
    if (!before.length || !after.length) { res.push({ name: s.name, error: 'no frames', frames: fr.length }); continue; }
    const I = before[before.length - 1], Fin = fr[fr.length - 1];
    const cw = Fin.full.width / dpr;
    const rg = region || { x: 0, y: 0, w: cw, h: Fin.full.height / dpr };
    const tol = s.tol ?? 0.004;
    const rows = after.map(([f, i]) => ({ i, dt: +(f.t - tc).toFixed(1), dI: F.diffIn(f, I, rg, cw), dF: F.diffIn(f, Fin, rg, cw), ink: F.inkIn(f, rg, cw) }));
    const finalInk = F.inkIn(Fin, rg, cw);
    // Settled: the first frame from which every one after is like the last.
    let k = rows.length - 1;
    while (k > 0 && rows[k - 1].dF <= tol) k--;
    const settledAt = rows[k].dt;
    const fromClick = +Math.max(0, rows[k].dt - (tr - tc)).toFixed(1);
    const halfway = rows.slice(0, k).filter((r) => r.dI > tol && r.dF > tol);
    const blank = rows.filter((r) => r.ink < finalInk / 3 && r.ink < F.inkIn(I, rg, cw) / 3);
    const changed = F.diffIn(I, Fin, rg, cw) > tol;
    // A frame unlike both its neighbours, which are alike: a flash.
    const seq = [I, ...after.map(([f]) => f)];
    let flash = 0;
    for (let i = 1; i < seq.length - 1; i++) {
      const ab = F.diffIn(seq[i - 1], seq[i], rg, cw), bc = F.diffIn(seq[i], seq[i + 1], rg, cw), ac = F.diffIn(seq[i - 1], seq[i + 1], rg, cw);
      if (ab > 0.02 && bc > 0.02 && ac < Math.min(ab, bc) / 3) flash++;
    }
    const pick = new Set();
    pick.add(fr.indexOf(I));
    for (const r of rows.slice(0, Math.min(rows.length, k + 2))) pick.add(r.i);
    // And the last: the view it settles on, which the others are compared with.
    const strip = saveStrip(rec, [...[...pick].sort((a, b) => a - b).slice(0, 8), fr.length - 1], dir, s.name.replace(/[^a-z0-9]+/gi, '-'));
    res.push({ name: s.name, changed, framesAfterClick: rows.length, settledMs: settledAt, fromClickMs: fromClick, halfDrawn: halfway.length, blank: blank.length, flash, resize: !!s.resize,
      frames: rows.slice(0, k + 1).map((r) => `${r.dt}ms dI=${r.dI.toFixed(3)} dF=${r.dF.toFixed(3)} ink=${r.ink.toFixed(3)}`), strip });
    if (s.after) { await js(win, s.after); await sleep(s.afterWait ?? 500); }
  }
  return res;
};
