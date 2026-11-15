// A pick on the phone (the Phase 2 picture's phone frames, 32c; the
// pickzoom round's phone A, picked 2026-11-15): the agent shows 2 to 4
// variants and waits for the person's choice.
//
//   swipe    one picture at a time, full width, with its letter ("B, 2 of
//            3"), its name and the agent's words under it; Circle a part,
//            None of these, and Pick B, which names the one on screen. The
//            track is as tall as the picture on screen (a wide picture
//            leaves no empty band under it); a tall one fits inside.
//   view     a tap on a picture: it fills the screen ("Pick one", "B, 2 of
//            4"), at its fit; a pinch or a double tap zooms, a finger pans
//            while zoomed, a swipe at fit moves to the next, the "% Fit"
//            chip and a double tap go back to fit; the strip of the
//            variants by letter; Circle a part and Pick B.
//   circle   in the viewer: one finger draws around a part, two fingers
//            still move and zoom; the ring is drawn on the picture, so it is
//            kept in fractions of the whole picture at any zoom. Then the
//            note (typed or spoken) pinned beside it, Circle again, and
//            Send B, with the note.
//
// The pictures are the hub's copies in Ravenry's data (GET
// /api/checkpoints/<id>/variants/<n>, through the shell with the device
// token), never the agent's own files. The answer is the person's:
// POST /api/checkpoints/answer { id, pick: { label, region?, note? } }, or a
// decline for None of these.

import { h, replace, svg } from '../../desktop/src/renderer/dom.ts';
import type { CheckpointWords, HubCheckpoint } from '../../desktop/src/renderer/checkpoints.ts';
import * as I from './icons.ts';
import { current, hubUrl } from './shell.ts';
import { regionOf } from './logic.ts';
import { t as say } from './strings.ts';

export interface PickUI {
  /** The picture on screen. */
  i: number;
  mode: 'swipe' | 'view';
  /** In the viewer: a finger draws a ring. */
  circling: boolean;
  /** The finger's path, in fractions of the picture, and the variant it is on (null: none). */
  path: [number, number][];
  circledOn: number | null;
  note: string;
  /** The viewer's zoom: s times the fit, moved (x, y) from the middle, in screen points. */
  zoom: { s: number; x: number; y: number };
  busy: boolean;
  error: string | null;
}

export const newPick = (): PickUI => ({ i: 0, mode: 'swipe', circling: false, path: [], circledOn: null, note: '', zoom: { s: 1, x: 0, y: 0 }, busy: false, error: null });

export interface PickCtx {
  topBar(cp: HubCheckpoint, icon: string): HTMLElement;
  fromLine(cp: HubCheckpoint): HTMLElement[];
  answer(cp: HubCheckpoint, reply: Record<string, unknown>): Promise<void>;
  repaint(): void;
  done(said: string): void;
}

const variantUrl = (cp: HubCheckpoint, n: number): string => hubUrl(`/api/checkpoints/${encodeURIComponent(cp.id)}/variants/${n}`);

/** The circle as drawn: the finger's path, closed smoothly, over the picture. */
function circleSvg(path: [number, number][]): SVGElement {
  const pts = path.map(([x, y]) => `${(x * 1000).toFixed(1)},${(y * 1000).toFixed(1)}`).join(' ');
  return svg(`<svg class="ov" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">${path.length > 1 ? `<polyline points="${pts}" fill="none" stroke="#FF9F0A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}</svg>`) as unknown as SVGElement;
}

/** One variant's picture in the swipe track, with its letter; an HTML variant runs sandboxed, with no scripts. */
function slide(cp: HubCheckpoint, w: CheckpointWords, n: number, total: number, open: () => void): HTMLElement {
  const v = (cp.variants || [])[n];
  const letter = w.variants[n]?.letter || String(n + 1);
  const missing = h('div.pmiss', say('phone.pick.missing'));
  missing.hidden = true;
  const media = v && v.type === 'html'
    ? h('iframe.phtml', { src: variantUrl(cp, n), sandbox: '', title: v.label, loading: 'lazy' })
    : h('img', { src: variantUrl(cp, n), alt: v ? v.label : '', draggable: 'false', on: { error: () => { missing.hidden = false; } } });
  return h('div.pimg', { 'data-n': String(n), on: { click: open } }, media, missing, h('span.lt', say('phone.pick.where', { letter, i: n + 1, n: total })));
}

export function pickView(cp: HubCheckpoint, w: CheckpointWords, ui: PickUI, x: PickCtx): HTMLElement {
  const sh = current();
  const vs = cp.variants || [];
  const n = vs.length;
  if (ui.i >= n) ui.i = 0;
  // A variant as the hub words it: its letter, its whole label, the agent's words.
  const nameOf = (i: number) => w.variants[i] || { letter: String(i + 1), name: '', says: null };

  const send = async (reply: Record<string, unknown>, said: string) => {
    if (ui.busy) return;
    ui.busy = true; ui.error = null; x.repaint();
    try { await x.answer(cp, reply); x.done(said); } catch (e) { ui.busy = false; ui.error = (e as Error).message; x.repaint(); }
  };
  // Picks the picture on screen, with its circle and note when it has them.
  const pickNow = () => {
    const v = vs[ui.i];
    if (!v) return;
    const mine = ui.circledOn === ui.i;
    const region = mine ? regionOf(ui.path) : null;
    const note = mine ? ui.note.trim().slice(0, 4000) : '';
    const { letter, name } = nameOf(ui.i);
    void send({ pick: { label: v.label, ...(region ? { region } : {}), ...(note ? { note } : {}) } },
      say(note ? 'phone.pick.sentNote' : region ? 'phone.pick.sentCircle' : 'phone.pick.sent', { letter, name }));
  };
  const openViewer = (i: number, circling = false) => { ui.i = i; ui.mode = 'view'; ui.circling = circling; ui.zoom = { s: 1, x: 0, y: 0 }; ui.error = null; x.repaint(); };

  if (ui.mode === 'view') return viewer(cp, w, ui, x, { nameOf, pickNow, mic: sh.has('speech') ? () => sh.call<{ text: string }>('speech') : null });

  // ------------------------------------------------ swipe
  const cap = h('p.pcap');
  const dots = h('div.dots3');
  const pickLabel = h('span');
  const paintCap = () => {
    const { name, says, letter } = nameOf(ui.i);
    replace(cap, h('b', /[.!?]$/.test(name) ? name : `${name}.`), says ? ` ${says}` : null);
    replace(dots, vs.map((_, i) => h(`i${i === ui.i ? '.on' : ''}`)), n > 1 ? h('span', say('phone.pick.swipe')) : null);
    pickLabel.textContent = say('pick.pickLetter', { letter });
  };
  const track = h('div.ptrack', vs.map((_, i) => slide(cp, w, i, n, () => openViewer(i))));
  // The track is as tall as the picture on screen (between two, as tall as
  // the swipe has got), never taller than 58% of the screen: a wide
  // picture leaves no band under it, a tall one fits inside.
  const fitHeight = () => {
    const tw = track.clientWidth;
    if (!tw) return;
    const hs = [...track.querySelectorAll('.pimg')].map((s) => {
      const im = s.querySelector('img') as HTMLImageElement | null;
      return im && im.naturalWidth ? tw * im.naturalHeight / im.naturalWidth : tw * 10 / 16;
    }).map((v) => Math.min(v, Math.round(window.innerHeight * 0.58)));
    const f = track.scrollLeft / tw, a = Math.max(0, Math.floor(f)), b = Math.min(hs.length - 1, a + 1), k = f - a;
    const want = Math.round((hs[a] ?? hs[0] ?? 200) * (1 - k) + (hs[b] ?? hs[a] ?? 200) * k);
    if (track.style.height !== `${want}px`) track.style.height = `${want}px`;
  };
  for (const im of track.querySelectorAll('img')) im.addEventListener('load', fitHeight);
  // The picture on screen follows the swipe; only its words change, so the
  // track keeps scrolling under the finger.
  track.addEventListener('scroll', () => {
    const tw = track.clientWidth;
    if (!tw) return;
    fitHeight();
    const i = Math.max(0, Math.min(n - 1, Math.round(track.scrollLeft / tw)));
    if (i !== ui.i) { ui.i = i; paintCap(); }
  }, { passive: true });
  requestAnimationFrame(() => { track.scrollLeft = ui.i * track.clientWidth; fitHeight(); });
  paintCap();
  return h('div.pcp.ppick',
    x.topBar(cp, I.PICS), ...x.fromLine(cp),
    h('h2.sm', w.head),
    track, cap, dots,
    ui.error ? h('p.err', ui.error) : null,
    h('div.pcp-b',
      h('div.two',
        h('button.btn', { disabled: ui.busy, on: { click: () => openViewer(ui.i, true) } }, svg(I.CIRCLE), say('pick.circle')),
        h('button.btn', { disabled: ui.busy, on: { click: () => void send({ decline: true }, say('phone.pick.sentNone')) } }, say('pick.none'))),
      h('button.btn.pri.big', { disabled: ui.busy, on: { click: pickNow } }, pickLabel)));
}

interface ViewerCtx {
  nameOf(i: number): { letter: string; name: string; says: string | null };
  pickNow(): void;
  mic: (() => Promise<{ text: string }>) | null;
}

/** The viewer: one picture filling the screen, zoomed and panned by the fingers, the strip, and the pick from there. */
function viewer(cp: HubCheckpoint, w: CheckpointWords, ui: PickUI, x: PickCtx, c: ViewerCtx): HTMLElement {
  const vs = cp.variants || [];
  const n = vs.length;
  const i = ui.i;
  const { letter, name, says } = c.nameOf(i);
  const mine = ui.circledOn === i;
  const v = vs[i];
  const go = (k: number) => { if (k < 0 || k >= n || k === ui.i) return; ui.i = k; ui.zoom = { s: 1, x: 0, y: 0 }; x.repaint(); };

  // The picture in a box at its fit; the box is moved and scaled about the
  // stage's middle, the ring inside it in its own fractions.
  const img = v && v.type === 'html'
    ? h('iframe.phtml', { src: variantUrl(cp, i), sandbox: '', title: v.label })
    : h('img', { src: variantUrl(cp, i), alt: v ? v.label : '', draggable: 'false' }) as HTMLImageElement;
  let ov = circleSvg(mine ? ui.path : []);
  const box = h('div.pzv-box', img, ov);
  const pct = h('span.num');
  const chip = h('button.btn.pzv-fit', { 'aria-label': say('phone.pick.fitLabel'), on: { click: (e: Event) => { e.stopPropagation(); setZoom(1, 0, 0, true); } } }, pct, say('pick.fit'));
  // The note pinned beside the ring, as it is typed.
  const pinText = h('span', ui.note.trim());
  const pin = mine ? h('div.pzv-note', h('b', '1'), pinText) : null;
  if (pin) pin.hidden = !ui.note.trim();
  const stage = h(`div.pzv-stage${ui.circling ? '.drawing' : ''}`, box, pin, chip);
  const z = ui.zoom;

  // The box's place at fit (the whole picture, in the middle), from the stage's size and the picture's.
  const fit = () => {
    const sw = stage.clientWidth, sh2 = stage.clientHeight;
    const nw = (img as HTMLImageElement).naturalWidth || 16, nh = (img as HTMLImageElement).naturalHeight || 10;
    const k = Math.min(sw / nw, sh2 / nh) || 1;
    return { sw, sh: sh2, w: nw * k, h: nh * k, k };
  };
  const zoomMax = (f = fit()) => Math.min(12, Math.max(5, 1 / (f.k * (window.devicePixelRatio || 1))));
  function apply(animate = false) {
    const f = fit();
    if (!f.sw) return;
    z.s = Math.min(zoomMax(f), Math.max(1, z.s));
    if (z.s < 1.01) { z.s = 1; z.x = 0; z.y = 0; }
    const mx = Math.max(0, (f.w * z.s - f.sw) / 2), my = Math.max(0, (f.h * z.s - f.sh) / 2);
    z.x = Math.min(mx, Math.max(-mx, z.x));
    z.y = Math.min(my, Math.max(-my, z.y));
    Object.assign(box.style, { width: `${f.w}px`, height: `${f.h}px`, left: `${(f.sw - f.w) / 2}px`, top: `${(f.sh - f.h) / 2}px`,
      transition: animate ? 'transform .18s ease-out' : '', transform: z.s > 1 ? `translate(${z.x}px, ${z.y}px) scale(${z.s})` : '' });
    chip.hidden = z.s <= 1;
    pct.textContent = `${Math.round(z.s * 100)}%`;
    stage.classList.toggle('zoomed', z.s > 1);
    placePin();
  }
  // The note beside the ring as it shows now.
  function placePin() {
    if (!pin || pin.hidden) return;
    const r = regionOf(ui.path);
    if (!r) return;
    const b = box.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const right = b.left + (r.x + r.w) * b.width - s.left + 10, top = b.top + r.y * b.height - s.top - 6;
    const pw = pin.offsetWidth, ph = pin.offsetHeight;
    pin.style.left = `${Math.max(8, Math.min(right + pw > s.width - 8 ? b.left + r.x * b.width - s.left - pw - 10 : right, s.width - pw - 8))}px`;
    pin.style.top = `${Math.max(8, Math.min(top, s.height - ph - 8))}px`;
  }
  // To scale s, the picture's spot under the screen point (px, py) kept there.
  function zoomAt(s: number, px: number, py: number, animate = false) {
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const s1 = Math.min(zoomMax(), Math.max(1, s));
    const qx = (px - cx - z.x) / z.s, qy = (py - cy - z.y) / z.s;
    z.x = px - cx - s1 * qx; z.y = py - cy - s1 * qy; z.s = s1;
    apply(animate);
  }
  function setZoom(s: number, x0: number, y0: number, animate = false) { z.s = s; z.x = x0; z.y = y0; apply(animate); }

  // The fingers: one pans a zoomed picture, swipes one at fit, or draws
  // while circling; two pinch (and move) at any time; a double tap toggles.
  const ptrs = new Map<number, { x: number; y: number }>();
  let pinch: { d0: number; s0: number; qx: number; qy: number } | null = null;
  let pan: { x0: number; y0: number; tx: number; ty: number } | null = null;
  let down: { x: number; y: number; t: number; moved: boolean } | null = null;
  let multi = false;
  let tap: { x: number; y: number; t: number } | null = null;
  let path: [number, number][] = [];
  // The last pointer's kind: a double tap is the fingers' own (below), never the double click a browser makes of it.
  let lastType = '';
  const frac = (e: PointerEvent): [number, number] => { const r = box.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const drawPath = (p: [number, number][]) => { const o = circleSvg(p); box.replaceChild(o, ov); ov = o; };
  const pinchStart = () => {
    const [a, b] = [...ptrs.values()];
    const r = stage.getBoundingClientRect();
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: z.s, qx: (mx - r.left - r.width / 2 - z.x) / z.s, qy: (my - r.top - r.height / 2 - z.y) / z.s };
    pan = null;
  };
  stage.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('.pzv-fit')) return;
    lastType = e.pointerType;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch { /* gone */ }
    if (ptrs.size === 1) { multi = false; down = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false }; }
    if (ptrs.size === 2) {
      multi = true;
      // A second finger while drawing: the drawing stops, the fingers move and zoom.
      if (path.length) { path = []; drawPath(mine ? ui.path : []); }
      pinchStart();
    } else if (ptrs.size === 1) {
      if (ui.circling) { path = [frac(e)]; drawPath(path); }
      else if (z.s > 1) pan = { x0: e.clientX, y0: e.clientY, tx: z.x, ty: z.y };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (down && Math.hypot(p.x - down.x, p.y - down.y) > 10) down.moved = true;
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const r = stage.getBoundingClientRect();
      const s = Math.min(zoomMax(), Math.max(1, pinch.s0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      z.x = mx - r.left - r.width / 2 - s * pinch.qx;
      z.y = my - r.top - r.height / 2 - s * pinch.qy;
      z.s = s;
      apply();
    } else if (ui.circling && path.length && !multi) {
      path.push(frac(e)); drawPath(path);
    } else if (pan) {
      z.x = pan.tx + p.x - pan.x0; z.y = pan.ty + p.y - pan.y0;
      apply();
    }
  });
  const up = (e: PointerEvent) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size === 1) { pinch = null; const q = [...ptrs.values()][0]; pan = z.s > 1 && !ui.circling ? { x0: q.x, y0: q.y, tx: z.x, ty: z.y } : null; return; }
    if (ptrs.size) return;
    pinch = null; pan = null;
    const dn = down; down = null;
    // A ring drawn with one finger: closed into a loop, as a circle drawn with a finger reads.
    if (ui.circling && path.length && !multi) {
      if (e.type !== 'pointercancel' && regionOf(path)) { ui.path = [...path, path[0]]; ui.circledOn = i; ui.circling = false; x.repaint(); }
      else { path = []; drawPath(mine ? ui.path : []); }
      return;
    }
    if (!dn || multi || e.type === 'pointercancel') { tap = null; return; }
    // A swipe at fit moves to the next or the previous; zoomed, the finger panned.
    const dx = e.clientX - dn.x, dy = e.clientY - dn.y;
    if (z.s <= 1 && !ui.circling && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) { go(i + (dx < 0 ? 1 : -1)); return; }
    if (dn.moved || e.timeStamp - dn.t > 350) { tap = null; return; }
    const tp = tap;
    if (tp && e.timeStamp - tp.t < 320 && Math.hypot(e.clientX - tp.x, e.clientY - tp.y) < 32) { tap = null; if (z.s > 1) setZoom(1, 0, 0, true); else zoomAt(2.5, e.clientX, e.clientY, true); }
    else tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  // A mouse's double click and wheel too (the board in a desktop browser, for a look).
  stage.addEventListener('dblclick', (e) => { if (ui.circling || lastType !== 'mouse') return; if (z.s > 1) setZoom(1, 0, 0, true); else zoomAt(2.5, e.clientX, e.clientY, true); });
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(z.s * Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY); }, { passive: false });
  if (img instanceof HTMLImageElement) img.addEventListener('load', () => apply());
  new ResizeObserver(() => apply()).observe(stage);
  requestAnimationFrame(() => apply());

  // The words under the picture: its name and the agent's words; while drawing, how; once circled, the note.
  let field: HTMLTextAreaElement | null = null;
  const sendLabel = h('span');
  const paintSend = () => { sendLabel.textContent = say(ui.note.trim() ? 'phone.pick.sendNote' : 'phone.pick.sendCircle', { letter }); };
  let capEl: HTMLElement;
  if (ui.circling) capEl = h('p.pzv-hint', say('phone.pick.drawHint'));
  else if (mine) {
    field = h('textarea.f.pnote', { rows: '1', placeholder: say('phone.pick.notePlaceholder'), 'aria-label': say('phone.pick.noteLabel'), enterkeyhint: 'send', autocomplete: 'off', spellcheck: 'true' }) as HTMLTextAreaElement;
    field.value = ui.note;
    const grow = () => { field!.style.height = 'auto'; field!.style.height = `${Math.min(field!.scrollHeight, 110)}px`; };
    field.addEventListener('input', () => { ui.note = field!.value; grow(); paintSend(); pinText.textContent = ui.note.trim(); if (pin) { pin.hidden = !ui.note.trim(); placePin(); } });
    field.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' && !(e as KeyboardEvent).shiftKey) { e.preventDefault(); c.pickNow(); } });
    requestAnimationFrame(grow);
    const mic = c.mic ? h('button.mic', { 'aria-label': 'Speak', on: { click: async () => {
      try { const r = await c.mic!(); if (r && r.text && field) { field.value = (field.value ? field.value.trimEnd() + ' ' : '') + r.text; field.dispatchEvent(new Event('input')); } } catch (e) { ui.error = (e as Error).message; x.repaint(); }
    } } }, svg(I.MIC)) : null;
    capEl = h('div.pfield.pnf.pzv-nf', field, mic);
  } else capEl = h('p.pzv-cap', h('b', `${letter}. ${name}`), says ? h('span', says) : null);

  // The strip: each variant whole, its letter, the one shown ringed, the circled one ticked.
  const strip = h('div.pzv-strip', vs.map((vv, k) => {
    const nm = c.nameOf(k);
    return h(`button.pzv-th${k === i ? '.on' : ''}`, { 'aria-label': `${nm.letter}. ${nm.name}`, 'aria-current': k === i ? 'true' : null, on: { click: () => go(k) } },
      vv.type === 'html' ? null : h('img', { src: variantUrl(cp, k), alt: '', draggable: 'false' }), h('span.pk-lt', ui.circledOn === k ? `${nm.letter} ✓` : nm.letter));
  }));

  paintSend();
  const ctl = ui.circling
    ? [h('button.btn', { disabled: ui.busy, on: { click: () => { ui.circling = false; x.repaint(); } } }, say('phone.pick.cancel')),
      h('button.btn.pri', { disabled: true }, say('pick.pickLetter', { letter }))]
    : mine
      ? [h('button.btn', { disabled: ui.busy, on: { click: () => { ui.circling = true; ui.path = []; ui.circledOn = null; ui.note = ''; x.repaint(); } } }, say('phone.pick.circleAgain')),
        h('button.btn.pri.wide', { disabled: ui.busy, on: { click: c.pickNow } }, sendLabel)]
      : [h('button.btn', { disabled: ui.busy, on: { click: () => { ui.circling = true; ui.error = null; x.repaint(); } } }, svg(I.CIRCLE), say('pick.circle')),
        h('button.btn.pri', { disabled: ui.busy, on: { click: c.pickNow } }, say('pick.pickLetter', { letter }))];

  const close = () => { ui.mode = 'swipe'; ui.circling = false; ui.zoom = { s: 1, x: 0, y: 0 }; x.repaint(); };
  return h('div.pzv',
    h('div.pzv-bar',
      h('button.icon-btn.fg', { 'aria-label': say('phone.pick.closeViewer'), on: { click: close } }, svg(I.X18)),
      h('span.pzv-title', say('phone.pick.title')), h('span.pzv-who', w.who),
      h('span.sp'), h('span.pzv-at.num', say('phone.pick.where', { letter, i: i + 1, n }))),
    stage, capEl,
    ui.error ? h('p.err.pzv-err', ui.error) : null,
    strip,
    h('div.pzv-ctl', ctl));
}
