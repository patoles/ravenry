// The picture gallery (docs/design/Gallery.dc.html, variant B). Clicking the project picture opens the whole window, built like
// the Live screen's full screen: the picture whole (never cropped), previous
// and next, a caption saying who made it and where it is, and the session's
// last 6 along the foot, oldest left to newest right. It opens on the
// picture clicked on the card (the newest when the card has one). Left and right arrows move, Esc closes; on a phone a swipe moves
// and big Previous and Next buttons sit at thumb height.
//
// The picture shown zooms (zoomDown and the rest, below): a pinch, the
// wheel, a double click or tap; a drag pans while zoomed, Fit or the first
// Esc goes back, and each picture opens whole.
//
// A pick's pictures open in the same viewer (openPick, from the answer
// card's tiles; the pickzoom round, 2026-11-15; a video, or a page that
// holds one, plays there with its controls, muted and looping, the
// pickvideo round, 2026-11-16; a page with none shows as the hub draws it): the question in the bar,
// each variant's letter, name and the agent's words under the picture, the
// variants in the strip by letter and name, and no Pick: a browser does not
// answer a checkpoint (server/person.mjs), so the caption says where to.
//
// One video plays at a time (the pickvideo round's fourth part,
// 2026-11-16): the viewer has one player; a move to another picture, the
// close, a new layout let the one left go (paused, its source dropped). The
// thumbnails (the answer card's tiles, the strip) are pictures of each
// video's first frame (frameTag below), drawn once with no player of their
// own: kept as <video> elements, each held a player, loading on even once
// left behind.
//
// The server sends the 6 with the card's picture (brief.pictures[auto]
// .gallery: key, name, url, at, by, made, w, h, rel, path) and serves each
// only while it passes the picture rules (server/pictures.mjs).

const ICON = {
  left: (n) => `<svg width="${n}" height="${n}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"></path></svg>`,
  right: (n) => `<svg width="${n}" height="${n}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"></path></svg>`,
  x: '<svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8"></path></svg>',
  folder: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.6 1.6h5.8a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1z"></path></svg>',
  copy: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="2"></rect><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"></path></svg>',
  pictures: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"></rect><path d="M2 11l3.5-3.5 3 3 2-2L14 12"></path><circle cx="10.5" cy="6" r="1"></circle></svg>',
};

// The session's pictures of a project, oldest first ([] for none).
export function galleryOf(p) {
  const auto = p && p.brief && p.brief.pictures && p.brief.pictures.find((x) => x.auto);
  if (!auto) return [];
  return auto.gallery && auto.gallery.length ? auto.gallery : [{ key: null, name: auto.alt.replace(/^Latest picture: /, ''), url: auto.url, at: null, by: null, made: false, w: null, h: null, rel: auto.path, path: auto.path }];
}

// The closed card (docs/design/GalleryCard.dc.html, variant B). One picture: the whole width, as before, no count.
// Two or more: the newest takes two thirds of the width (top left) and the
// two before it sit stacked on the right, each a third wide and half the
// height, so every tile is 16:9 in a 24:9 card. With two, they sit side by
// side at the same height and the small one is cropped to its middle. The
// count stays on the big tile's bottom-right corner, and each tile opens the
// gallery on its own picture.
export function cardPicture(p, x, { esc, escRaw }) {
  const list = galleryOf(p);
  const n = list.length;
  if (n < 2) return `<button class="picard" data-gallery="${escRaw(p.id)}" aria-label="Open the picture large"><img class="pic" src="${escRaw(x.url)}" alt="${esc(x.alt)}"></button>`;
  const tiles = list.slice(-3).reverse().map((y, k) => {
    const i = n - 1 - k;
    return `<button class="picard pc-tile" data-gallery="${escRaw(p.id)}"${y.key ? ` data-gallery-key="${escRaw(y.key)}"` : ''} aria-label="${esc(`Open picture ${i + 1} of ${n}, ${y.name}`)}"><img src="${escRaw(y.url)}" alt="">${k === 0 ? `<span class="pic-hint">${ICON.pictures}<span class="num">${n}</span></span>` : ''}</button>`;
  });
  return `<div class="pc-b${n === 2 ? ' n2' : ''}">${tiles.join('')}</div>`;
}

// A video this engine cannot decode (the webm round, 2026-11-17: AV1 on an
// Apple chip without its decoder, VP9 on the iOS simulator): the hub's
// `videoType` the engine says it cannot play, a player's decode error, or
// its size read and no frame after 15 s. It shows a still that says so,
// never a blank or a spinner. url -> true.
const cantSet = new Set();
const typeOf = new Map();
let cantWords = "This video can't play here";
export function videoCant(url, type) {
  if (type) typeOf.set(url, type);
  if (cantSet.has(url)) return true;
  const t = type || typeOf.get(url);
  try { if (t && document.createElement('video').canPlayType(t) === '') { cantSet.add(url); return true; } } catch { /* none */ }
  return false;
}
/** The still in a video's place where it cannot play. */
export function cantTag(url, escRaw, words) {
  if (words) cantWords = words;
  return `<span class="pk-cant" data-cant="${escRaw(url)}">${escRaw(cantWords)}</span>`;
}
// A video found unplayable once its thumbnails are on the page: each becomes the still, its play mark gone.
function cantNow(url) {
  cantSet.add(url);
  for (const im of document.querySelectorAll('img[data-frame]')) {
    if (im.dataset.frame !== url) continue;
    const sp = document.createElement('span');
    sp.className = 'pk-cant'; sp.dataset.cant = url; sp.textContent = cantWords;
    const play = im.parentElement && im.parentElement.querySelector('.pk-play');
    if (play) play.remove();
    im.replaceWith(sp);
  }
}

// A video's first frame as a picture: drawn once by a player of its own,
// one video after another, shown over a thumbnail waiting for it while it
// loads, that player let go at once. url -> object URL.
const frames = new Map();
const framing = new Map();
let frameLine = Promise.resolve();
function grabFrame(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.tabIndex = -1;
    for (const a of ['muted', 'playsinline', 'webkit-playsinline']) v.setAttribute(a, '');
    v.setAttribute('aria-hidden', 'true');
    // On the page, where the frame will show (an iPhone loads a video's first frame only for one it draws): over a
    // thumbnail waiting for it, else a speck in a corner.
    // A redraw that takes the thumbnail away moves it to the one that took its place.
    const home = () => {
      const host = [...document.querySelectorAll('img[data-frame]')].find((i) => i.dataset.frame === url && i.parentElement && i.getClientRects().length);
      if (v.isConnected && (host ? v.parentElement === host.parentElement : v.parentElement === document.body)) return;
      Object.assign(v.style, host
        ? { left: '', bottom: '', position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', opacity: '1' }
        : { inset: '', position: 'fixed', left: '0', bottom: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
      (host ? host.parentElement : document.body).appendChild(v);
    };
    home();
    const moving = setInterval(home, 300);
    let over = false, drawn = false, played = false;
    const end = (out) => { if (over) return; over = true; clearTimeout(timer); clearInterval(moving); v.pause(); v.removeAttribute('src'); v.load(); v.remove(); resolve(out); };
    // Its size read and no frame in 15 s: this engine cannot decode it.
    const timer = setTimeout(() => end(v.readyState === 1 ? 'cant' : null), 15000);
    // Drawn: some pixel has colour (an engine that has not decoded the frame draws nothing).
    const draw = () => {
      if (drawn) return true;
      const w = v.videoWidth, h = v.videoHeight;
      if (!w || !h || v.readyState < 2) return false;
      const k = Math.min(1, 1920 / w);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      const g = c.getContext('2d');
      if (!g) { end(null); return true; }
      try {
        g.drawImage(v, 0, 0, c.width, c.height);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        let seen = false;
        for (let i = 3; i < px.length; i += 4 * 97) if (px[i]) { seen = true; break; }
        if (!seen) return false;
        drawn = true;
        c.toBlob((b) => end(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.86);
      } catch { end(null); }
      return true;
    };
    const tryDraw = () => {
      if (over || draw() || played) return;
      // Not decoded until it plays (some engines): a moment of it, muted, then drawn.
      played = true;
      v.addEventListener('timeupdate', () => { if (!over && v.currentTime > 0) { v.pause(); if (!draw()) end(null); } });
      const pl = v.play();
      if (pl && pl.catch) pl.catch(() => end(null));
    };
    v.addEventListener('seeked', tryDraw);
    v.addEventListener('loadeddata', () => { if (!v.seeking) tryDraw(); });
    v.addEventListener('error', () => end(v.error && (v.error.code === 3 || v.error.code === 4) ? 'cant' : null));
    v.src = `${url}#t=0.001`;
  });
}
function frameOf(url) {
  if (frames.has(url)) return Promise.resolve(frames.get(url));
  let p = framing.get(url);
  if (!p) {
    // Asked again (three times in all) while a thumbnail on the page waits for it.
    const waits = () => [...document.querySelectorAll('img[data-frame]')].some((i) => i.dataset.frame === url);
    const tries = async () => { for (let k = 0; k < 3; k++) { if (videoCant(url)) return 'cant'; const u = await grabFrame(url); if (u || !waits()) return u; } return null; };
    p = frameLine.then(tries).then((u) => {
      if (u === 'cant') { cantNow(url); framing.delete(url); return null; }
      // A frame that could not be drawn is asked for again by the next thumbnail drawn.
      if (u) frames.set(url, u);
      framing.delete(url);
      // Every thumbnail of this video on the page now shows it.
      if (u) for (const im of document.querySelectorAll('img[data-frame]')) if (im.dataset.frame === url && im.getAttribute('src') !== u) im.setAttribute('src', u);
      return u;
    });
    frameLine = p.catch(() => null);
    framing.set(url, p);
  }
  return p;
}
// A video's thumbnail: its first frame as a picture (once drawn; asked for now when not).
export function frameTag(url, escRaw, type) {
  if (videoCant(url, type)) return cantTag(url, escRaw);
  const now = frames.get(url);
  if (!now) void frameOf(url);
  return `<img data-frame="${escRaw(url)}"${now ? ` src="${escRaw(now)}"` : ''} alt="">`;
}

export function createGallery(d) {
  // d: { $, esc, escRaw, post, toast, project, ui, serverNow, phone (a MediaQueryList), checkpoint (id -> the open checkpoint) }
  const g = { pid: null, key: null, list: [], phone: null, strip: '', back: null, touch: null, pick: null };
  let layer = null;

  const isOpen = () => !!g.pid;
  const idx = () => Math.max(0, g.list.findIndex((x) => x.key === g.key));
  const cur = () => g.list[idx()] || null;

  // "4 min" in the strip, "4 min ago" in the caption, from the server's clock.
  function age(at) {
    const t = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (d.serverNow() - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' h';
    return Math.round(s / 86400) + ' d';
  }
  const agoWords = (at) => { const a = age(at); return !a ? '' : a === 'now' ? 'just now' : a + ' ago'; };
  const byWords = (x) => (x.by ? (x.made ? `Made by ${x.by}` : 'Read in this session') : '');

  function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'gl-fs';
    layer.className = 'gl-fs';
    layer.hidden = true;
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', 'Pictures from this session');
    layer.tabIndex = -1;
    (document.getElementById('mc') || document.body).appendChild(layer);
    layer.addEventListener('touchstart', (e) => {
      if (!e.target.closest('.gb-stage') || e.touches.length !== 1) { g.touch = null; return; }
      g.touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    layer.addEventListener('touchend', (e) => {
      const t = g.touch; g.touch = null;
      // A finger on a zoomed picture pans it; only a fit picture swipes.
      if (!t || !e.changedTouches.length || z.s > 1 || (onVideo() && e.target.closest('video'))) return;
      const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) step(dx < 0 ? 1 : -1);
    });
    // Zoom: pointers (mouse, finger, pen) on the picture's view pan and
    // pinch; the wheel and a trackpad pinch (ctrl+wheel in Chromium, gesture
    // events in WebKit) zoom around the pointer; a double click or double
    // tap toggles. The view has touch-action: none, so the browser leaves
    // the fingers to this.
    // A pick's caption says the picture's size once it is in.
    layer.addEventListener('load', (e) => { if (g.pick && e.target && e.target.id === 'gl-im') draw(); }, true);
    layer.addEventListener('loadedmetadata', (e) => { if (g.pick && e.target && e.target.id === 'gl-vid') draw(); }, true);
    layer.addEventListener('pointerdown', zoomDown);
    layer.addEventListener('pointermove', zoomMove);
    layer.addEventListener('pointerup', zoomUp);
    layer.addEventListener('pointercancel', zoomUp);
    layer.addEventListener('wheel', zoomWheel, { passive: false });
    layer.addEventListener('dblclick', (e) => {
      if (!e.target.closest('#gl-view') || e.target.closest('[data-gl-fit]') || z.type === 'touch' || onVideo()) return;
      e.preventDefault();
      zoomToggle(e.clientX, e.clientY);
    });
    layer.addEventListener('gesturestart', (e) => {
      if (!e.target.closest || !e.target.closest('#gl-view') || onVideo()) return;
      e.preventDefault();
      z.gs = z.ptrs.size ? null : { s0: z.s }; // fingers on a touch screen pinch through the pointers instead
    });
    layer.addEventListener('gesturechange', (e) => {
      if (!z.gs) { if (e.target.closest && e.target.closest('#gl-view')) e.preventDefault(); return; }
      e.preventDefault();
      const r = viewEl().getBoundingClientRect();
      zoomAt(z.gs.s0 * e.scale, Number.isFinite(e.clientX) ? e.clientX : r.left + r.width / 2, Number.isFinite(e.clientY) ? e.clientY : r.top + r.height / 2);
    });
    layer.addEventListener('gestureend', (e) => { if (z.gs) e.preventDefault(); z.gs = null; });
    window.addEventListener('resize', () => { if (isOpen() && z.s > 1) zoomApply(); });
    return layer;
  }

  // ------------------------------------------------------------ zoom
  // The picture is drawn whole (object-fit: contain) in the view, centred,
  // so its centre is the view's centre and a transform of translate(x, y)
  // scale(s) about that centre moves and grows it. s runs from 1 (fit) to
  // 5, or to the picture's own pixels (one picture pixel per screen pixel)
  // when that is more; the pan is held so the picture always covers the
  // view along a side where it is bigger, and stays centred where it is not.
  const Z_MAX = 5, Z_DOUBLE = 2.5;
  const z = { s: 1, x: 0, y: 0, ptrs: new Map(), pinch: null, pan: null, multi: false, tap: null, down: null, type: null, gs: null };
  const viewEl = () => layer && layer.querySelector('#gl-view');
  const imEl = () => layer && layer.querySelector('#gl-im');

  function fitted() {
    const v = viewEl(), im = imEl();
    const r = v.getBoundingClientRect();
    const nw = (im && im.naturalWidth) || r.width || 1, nh = (im && im.naturalHeight) || r.height || 1;
    const k = Math.min(r.width / nw, r.height / nh) || 1;
    return { r, w: nw * k, h: nh * k, k };
  }
  function zoomMax(f = fitted()) { return Math.min(12, Math.max(Z_MAX, 1 / (f.k * (window.devicePixelRatio || 1)))); }

  function zoomApply({ animate = false } = {}) {
    const im = imEl(), v = viewEl();
    if (!im || !v) return;
    const f = fitted();
    z.s = Math.min(zoomMax(f), Math.max(1, z.s));
    if (z.s < 1.01) { z.s = 1; z.x = 0; z.y = 0; }
    const mx = Math.max(0, (f.w * z.s - f.r.width) / 2), my = Math.max(0, (f.h * z.s - f.r.height) / 2);
    z.x = Math.min(mx, Math.max(-mx, z.x));
    z.y = Math.min(my, Math.max(-my, z.y));
    const on = z.s > 1;
    im.style.transition = animate ? 'transform .18s ease-out' : '';
    im.style.transform = on ? `translate(${z.x}px, ${z.y}px) scale(${z.s})` : '';
    v.classList.toggle('zoomed', on);
    const fit = v.querySelector('[data-gl-fit]');
    if (fit) { fit.hidden = !on; const pct = v.querySelector('#gl-pct'); if (pct) pct.textContent = Math.round(z.s * 100) + '%'; }
  }
  // To scale s, keeping the picture's spot under the screen point (px, py) there.
  function zoomAt(s, px, py, opts) {
    const r = viewEl().getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const s1 = Math.min(zoomMax(), Math.max(1, s));
    const qx = (px - cx - z.x) / z.s, qy = (py - cy - z.y) / z.s;
    z.x = px - cx - s1 * qx; z.y = py - cy - s1 * qy; z.s = s1;
    zoomApply(opts);
  }
  function zoomToggle(px, py) {
    if (z.s > 1) { z.s = 1; zoomApply({ animate: true }); } else zoomAt(Z_DOUBLE, px, py, { animate: true });
  }
  // Back to fit at once, with no gesture in progress (a new picture, a new layout).
  function zoomClear() {
    z.s = 1; z.x = 0; z.y = 0; z.ptrs.clear(); z.pinch = null; z.pan = null; z.multi = false; z.tap = null; z.down = null; z.gs = null;
    zoomApply();
  }

  function pinchStart() {
    const [a, b] = [...z.ptrs.values()];
    const r = viewEl().getBoundingClientRect();
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    z.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: z.s, qx: (mx - r.left - r.width / 2 - z.x) / z.s, qy: (my - r.top - r.height / 2 - z.y) / z.s };
    z.pan = null;
  }
  function panStart(p) { z.pan = { x0: p.x, y0: p.y, tx: z.x, ty: z.y }; }

  // A video plays with its own controls: no zoom, no pan over it.
  const onVideo = () => { const x = cur(); return !!(x && x.video); };
  function zoomDown(e) {
    if (!e.target.closest('#gl-view') || e.target.closest('[data-gl-fit]') || onVideo()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    z.type = e.pointerType;
    z.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { e.target.setPointerCapture(e.pointerId); } catch { /* gone */ }
    if (z.ptrs.size === 1) { z.multi = false; z.down = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false }; }
    if (z.ptrs.size === 2) { z.multi = true; pinchStart(); }
    else if (z.ptrs.size === 1 && z.s > 1) { panStart(z.ptrs.get(e.pointerId)); if (e.pointerType === 'mouse') { e.preventDefault(); viewEl().classList.add('grabbing'); } }
  }
  function zoomMove(e) {
    const p = z.ptrs.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (z.down && Math.hypot(p.x - z.down.x, p.y - z.down.y) > 10) z.down.moved = true;
    if (z.pinch && z.ptrs.size >= 2) {
      const [a, b] = [...z.ptrs.values()];
      const r = viewEl().getBoundingClientRect();
      const s = Math.min(zoomMax(), Math.max(1, z.pinch.s0 * Math.hypot(a.x - b.x, a.y - b.y) / z.pinch.d0));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      z.x = mx - r.left - r.width / 2 - s * z.pinch.qx;
      z.y = my - r.top - r.height / 2 - s * z.pinch.qy;
      z.s = s;
      zoomApply();
    } else if (z.pan) {
      z.x = z.pan.tx + p.x - z.pan.x0;
      z.y = z.pan.ty + p.y - z.pan.y0;
      zoomApply();
    }
  }
  function zoomUp(e) {
    if (!z.ptrs.has(e.pointerId)) return;
    z.ptrs.delete(e.pointerId);
    const v = viewEl();
    if (v) v.classList.remove('grabbing');
    if (z.ptrs.size === 1) {
      // One finger of a pinch lifted: the other pans on from where it is.
      z.pinch = null;
      if (z.s > 1) panStart([...z.ptrs.values()][0]); else z.pan = null;
      return;
    }
    if (z.ptrs.size) return;
    z.pinch = null; z.pan = null;
    // A double tap: two short taps close together, with one finger.
    const dn = z.down; z.down = null;
    if (e.pointerType !== 'touch' || e.type === 'pointercancel' || z.multi || !dn || dn.moved || e.timeStamp - dn.t > 350) { z.tap = null; return; }
    const tp = z.tap;
    if (tp && e.timeStamp - tp.t < 320 && Math.hypot(e.clientX - tp.x, e.clientY - tp.y) < 32) { z.tap = null; zoomToggle(e.clientX, e.clientY); }
    else z.tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  }
  function zoomWheel(e) {
    if (!e.target.closest('#gl-view') || onVideo()) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-300, Math.min(300, e.deltaY * px));
    // A trackpad pinch arrives as ctrl+wheel with small deltas, a wheel notch as about 100.
    zoomAt(z.s * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
  }

  // The viewer's player lets its video go (a picture shown, the close, a new layout): paused, its source dropped.
  function letGo() {
    const vid = layer && layer.querySelector('#gl-vid');
    if (vid && vid.getAttribute('src')) { vid.pause(); vid.removeAttribute('src'); vid.load(); }
  }

  // The skeleton, made again only when the layout (phone or desktop) changes.
  function build() {
    letGo();
    const phone = d.phone.matches;
    g.phone = phone;
    g.strip = '';
    zoomClear();
    // The picture sits in a view that clips it, so a zoomed picture stays
    // inside the picture's own area (never over the arrows or the caption).
    const VIEW = `<div class="gb-view" id="gl-view"><img class="gb-im" id="gl-im" alt="" draggable="false"><video class="gb-im gb-vid" id="gl-vid" controls muted loop playsinline hidden></video><div class="gb-im gb-cant" id="gl-cant" hidden></div><button class="btn sm gb-fit" data-gl-fit hidden aria-label="Back to the whole picture"><span class="num t2" id="gl-pct"></span>Fit</button></div>`;
    layer.classList.toggle('gl-p', phone);
    layer.innerHTML = phone
      ? `<div class="fs-bar" id="gl-bar"></div><div class="gb-stage">${VIEW}</div><div class="gb-cap" id="gl-cap"></div><div class="gb-strip" id="gl-strip"></div><div class="gb-ctl"><button class="btn gb-big" data-gl-step="-1">${ICON.left(18)}Previous</button><button class="btn gb-big" data-gl-step="1">Next${ICON.right(18)}</button></div>`
      : `<div class="fs-bar" id="gl-bar"></div><div class="gb-stage"><span class="gb-gut"><button class="nav-btn" data-gl-step="-1" aria-label="Previous picture">${ICON.left(20)}</button></span>${VIEW}<span class="gb-gut"><button class="nav-btn" data-gl-step="1" aria-label="Next picture">${ICON.right(20)}</button></span></div><div class="gb-cap" id="gl-cap"></div><div class="gb-strip" id="gl-strip"></div>`;
  }

  function setHtml(el, html) { if (el && el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } }

  function draw() {
    if (!isOpen() || !layer) return;
    if (g.phone !== d.phone.matches) build();
    const p = g.pick ? null : d.project(g.pid);
    const name = p ? p.name : '';
    const pw = g.pick ? (g.pick.words || {}) : null;
    const pb = pw ? pw.board || {} : null;
    const x = cur();
    const i = idx();
    const n = g.list.length;
    const { esc, escRaw } = d;
    if (pw) setHtml(layer.querySelector('#gl-bar'), g.phone
      ? `<button class="x-btn" data-gl-close aria-label="${esc(pb.close || 'Close')}">${ICON.x}</button><span class="fs-name" style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${esc(pw.head || '')}</span><span style="flex: 1"></span><span class="num t2" style="font-size: 13px; white-space: nowrap">${esc(x ? x.letter : '')}, ${i + 1} of ${n}</span>`
      : `<span class="fs-name">${esc(pw.head || '')}</span><span class="t2" style="font-size: 13px">${esc(pb.sub || '')}</span><span style="flex: 1"></span><span class="t3" style="font-size: 12px">${esc(pb.keys || '')}</span><button class="btn sm" data-gl-close>${esc(pb.close || 'Close')}</button>`);
    else setHtml(layer.querySelector('#gl-bar'), g.phone
      ? `<button class="x-btn" data-gl-close aria-label="Close the pictures">${ICON.x}</button><span class="fs-name">${esc(name)}</span><span class="t2" style="font-size: 13px">Pictures</span><span style="flex: 1"></span><span class="num t2" style="font-size: 13px">${i + 1} of ${n}</span>`
      : `<span class="fs-name">${esc(name)}</span><span class="t2" style="font-size: 13px">Pictures from this session</span><span style="flex: 1"></span><span class="t3" style="font-size: 12px">Left and right arrows to move, Esc to close</span><button class="btn sm" data-gl-close>Close</button>`);
    const im = layer.querySelector('#gl-im');
    let vid = layer.querySelector('#gl-vid');
    // A video plays in the picture's place, at once, muted and looping, with its controls. Another video gets a
    // player of its own, made then; the one left lets its video go (a player whose source was dropped and set
    // again could load for ever on an iPhone).
    const cantEl = layer.querySelector('#gl-cant');
    // A video this engine cannot play: the still that says so, no player.
    const cant = !!(x && x.video && videoCant(x.video, x.videoType));
    cantEl.hidden = !cant;
    if (cant) {
      im.hidden = true; vid.hidden = true;
      letGo();
      cantEl.textContent = (pb && pb.cantPlay) || cantWords;
    } else if (x && x.video) {
      im.hidden = true; vid.hidden = false;
      if (vid.getAttribute('src') !== x.video) {
        zoomClear();
        letGo();
        const nv = vid.cloneNode(false);
        vid.replaceWith(nv);
        vid = nv;
        vid.muted = true; vid.setAttribute('src', x.video); vid.setAttribute('aria-label', x.name);
        // It cannot decode it after all (no type to ask): the still, at once.
        const url = x.video;
        vid.addEventListener('error', () => { if (vid.error && (vid.error.code === 3 || vid.error.code === 4)) { cantNow(url); draw(); } });
        const pl = vid.play(); if (pl && pl.catch) pl.catch(() => {});
      }
    } else {
      im.hidden = false; vid.hidden = true;
      letGo();
      if (x && im.getAttribute('src') !== x.url) { zoomClear(); im.setAttribute('src', x.url); } // each picture opens whole
    }
    if (x) im.alt = x.name;
    for (const b of layer.querySelectorAll('[data-gl-step]')) b.disabled = Number(b.dataset.glStep) < 0 ? i <= 0 : i >= n - 1;
    if (x && pw) {
      const size = x.video ? (vid.videoWidth ? `${vid.videoWidth} x ${vid.videoHeight}` : '') : im.naturalWidth && im.getAttribute('src') === x.url ? `${im.naturalWidth} x ${im.naturalHeight}` : '';
      setHtml(layer.querySelector('#gl-cap'), g.phone
        ? `<div><span class="ga-file">${esc(x.name)}</span></div>${x.says ? `<div class="t2" style="font-size: 12px">${esc(x.says)}</div>` : ''}<div class="t3" style="font-size: 12px">${esc(pb.elsewhere || '')}</div>`
        : `<span class="ga-file">${esc(x.name)}</span>${x.says ? `<span class="t2">${esc(x.says)}</span>` : ''}${size ? `<span class="t2 num">${size}</span>` : ''}<span style="flex: 1"></span><span class="t2">${esc(pb.elsewhere || '')}</span>`);
    } else if (x) {
      const by = byWords(x);
      const ago = agoWords(x.at);
      setHtml(layer.querySelector('#gl-cap'), g.phone
        ? `<div><span class="ga-file mono-f">${esc(x.name)}</span></div>${by || ago ? `<div class="t2" style="font-size: 12px">${esc([by, ago].filter(Boolean).join(', '))}</div>` : ''}`
        : `<span class="ga-file mono-f">${esc(x.name)}</span>${by ? `<span class="t2">${esc(by)}</span>` : ''}${ago ? `<span class="t2">${esc(ago)}</span>` : ''}${x.w && x.h ? `<span class="t2 num">${x.w} x ${x.h}</span>` : ''}${x.rel ? `<span class="t3 mono-f gb-rel">${esc(x.rel)}</span>` : ''}<span style="flex: 1"></span>${d.ui.local === true && x.key ? `<button class="btn sm ib" data-gl-reveal>${ICON.folder}Show in Finder</button>` : ''}${x.path ? `<button class="btn sm ib" data-copy="${escRaw(x.path)}" data-copy-msg="Copied ${esc(x.path)}">${ICON.copy}Copy path</button>` : ''}`);
    }
    // The strip: the thumbnails are made again only when the 6 change, so a
    // move does not load them again; a move only moves the ring.
    const keys = g.list.map((y) => y.key + '|' + y.url + '|' + (y.video || '')).join(',') + (g.phone ? ':p' : ':d');
    const strip = layer.querySelector('#gl-strip');
    if (g.strip !== keys) {
      g.strip = keys;
      strip.innerHTML = g.pick
        ? g.list.map((y, k) => `<span class="gl-cell"><button class="gl-thumb pk-th" data-gl-go="${k}" aria-label="${esc(y.name)}">${y.video ? frameTag(y.video, escRaw, y.videoType) : `<img src="${escRaw(y.url)}" alt="">`}<span class="pk-lt">${esc(y.letter)}</span></button>${g.phone ? '' : `<span class="gl-time pk-nm">${esc(y.label)}</span>`}</span>`).join('')
        : g.list.map((y, k) => `<span class="gl-cell"><button class="gl-thumb" data-gl-go="${k}" aria-label="${esc(`${y.name}${y.at ? ', ' + agoWords(y.at) : ''}`)}"><img src="${escRaw(y.url)}" alt=""></button>${g.phone ? '' : `<span class="gl-time num"></span>`}</span>`).join('');
    }
    strip.querySelectorAll('.gl-cell').forEach((c, k) => {
      const on = k === i;
      const b = c.querySelector('.gl-thumb');
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      const t = c.querySelector('.gl-time');
      if (t) { t.classList.toggle('on', on); if (g.pick) return; const a = age(g.list[k].at); if (t.textContent !== a) t.textContent = a; }
    });
  }

  // Opens on the picture with that key (a card tile), else the newest.
  function open(pid, key) {
    const p = d.project(pid);
    const list = galleryOf(p);
    if (!list.length) return;
    ensureLayer();
    g.pick = null;
    layer.setAttribute('aria-label', 'Pictures from this session');
    g.pid = pid;
    g.list = list;
    g.key = key && list.some((x) => x.key === key) ? key : list[list.length - 1].key;
    g.back = document.activeElement;
    build();
    layer.hidden = false;
    document.documentElement.classList.add('lv-lock');
    draw();
    try { history.pushState({ glOpen: 1 }, ''); } catch { /* sandboxed */ }
    // Focus goes to the layer itself, so the arrows and Esc work at once
    // without a focus ring drawn on Close.
    layer.focus({ preventScroll: true });
  }

  // A pick's variants as the viewer's list: its letter and name, the agent's words, the hub's copy.
  function pickList(cp) {
    const w = cp.words || {};
    return (cp.variants || []).map((v, k) => {
      const nm = (w.variants || [])[k] || {};
      const letter = nm.letter || String(k + 1);
      return { key: `v${k}`, letter, label: nm.name || v.label || '', name: `${letter}. ${nm.name || v.label || ''}`, says: nm.says || null, url: `/api/checkpoints/${encodeURIComponent(cp.id)}/variants/${k}${v.type === 'html' && !v.video ? '?as=png' : ''}`, video: v.video || null, videoType: v.videoType || null };
    });
  }
  // Opens a pick's picture n up close (a tile on its answer card).
  function openPick(id, n) {
    const cp = d.checkpoint && d.checkpoint(id);
    if (!cp || !(cp.variants || []).length) return;
    ensureLayer();
    g.pick = cp;
    g.pid = `pick:${cp.id}`;
    g.list = pickList(cp);
    g.key = (g.list[n] || g.list[0]).key;
    g.back = document.activeElement;
    build();
    layer.setAttribute('aria-label', (cp.words && cp.words.head) || 'Pictures');
    layer.hidden = false;
    document.documentElement.classList.add('lv-lock');
    draw();
    try { history.pushState({ glOpen: 1 }, ''); } catch { /* sandboxed */ }
    layer.focus({ preventScroll: true });
  }

  function close({ back = true } = {}) {
    if (!isOpen()) return;
    g.pid = null; g.list = []; g.key = null; g.strip = ''; g.pick = null;
    letGo();
    layer.hidden = true;
    layer.innerHTML = '';
    zoomClear();
    document.documentElement.classList.remove('lv-lock');
    if (back && history.state && history.state.glOpen) history.back();
    const b = g.back && g.back.isConnected ? g.back : document.querySelector('.picard');
    if (b && back) b.focus({ preventScroll: true });
    g.back = null;
  }

  function step(dir) {
    if (!isOpen()) return;
    const i = idx() + dir;
    if (i < 0 || i >= g.list.length) return;
    g.key = g.list[i].key;
    draw();
  }

  // A new snapshot: the 6 may have moved on. The picture shown stays, with
  // its zoom and place, at its place in the strip, even once new pictures
  // have pushed it out of the 6 (the next snapshot after a move drops it).
  // None left (another session): closed.
  function sync() {
    if (!isOpen()) return;
    // A pick: open while it is open; answered, gone or cancelled, closed.
    if (g.pick) { const cp = d.checkpoint && d.checkpoint(g.pick.id); if (!cp || cp.state !== 'open') close(); else { g.pick = cp; draw(); } return; }
    const list = [...galleryOf(d.project(g.pid))];
    if (!list.length) { close(); return; }
    const shown = cur();
    if (shown && !list.some((x) => x.key === g.key)) list.splice(Math.min(idx(), list.length), 0, shown);
    g.list = list;
    draw();
  }

  async function reveal() {
    const x = cur();
    if (!x || !x.key) return;
    try { await d.post('/api/project/reveal-picture', { projectId: g.pid, key: x.key }); } catch (e) { d.toast(e.message, 4500); }
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    const card = t.closest('[data-gallery]');
    if (card) { open(card.dataset.gallery, card.dataset.galleryKey); return; }
    const pv = t.closest('[data-pick-view]');
    if (pv) { openPick(pv.dataset.pickView, Number(pv.dataset.n) || 0); return; }
    if (!isOpen()) return;
    if (t.closest('[data-gl-close]')) { close(); return; }
    if (t.closest('[data-gl-fit]')) { z.s = 1; zoomApply({ animate: true }); return; }
    const s = t.closest('[data-gl-step]');
    if (s) { step(Number(s.dataset.glStep)); return; }
    const go = t.closest('[data-gl-go]');
    if (go) { const y = g.list[Number(go.dataset.glGo)]; if (y) { g.key = y.key; draw(); } return; }
    if (t.closest('[data-gl-reveal]')) reveal();
  });
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    // Esc on a zoomed picture goes back to fit first; the next Esc closes.
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (z.s > 1) { z.s = 1; zoomApply({ animate: true }); } else close(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }, true);
  window.addEventListener('popstate', () => { if (isOpen()) close({ back: false }); });
  d.phone.addEventListener('change', () => { if (isOpen()) draw(); });

  return { open, openPick, close, sync, isOpen };
}
