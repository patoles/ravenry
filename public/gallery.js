// The picture gallery (docs/design/Gallery.dc.html, variant B). Clicking the project picture opens the whole window, built like
// the Live screen's full screen: the picture whole (never cropped), previous
// and next, a caption saying who made it and where it is, and the session's
// last 6 along the foot, oldest left to newest right. It opens on the
// picture clicked on the card (the newest when the card has one). Left and right arrows move, Esc closes; on a phone a swipe moves
// and big Previous and Next buttons sit at thumb height.
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

export function createGallery(d) {
  // d: { $, esc, escRaw, post, toast, project, ui, serverNow, phone (a MediaQueryList) }
  const g = { pid: null, key: null, list: [], phone: null, strip: '', back: null, touch: null };
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
      if (!t || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) step(dx < 0 ? 1 : -1);
    });
    return layer;
  }

  // The skeleton, made again only when the layout (phone or desktop) changes.
  function build() {
    const phone = d.phone.matches;
    g.phone = phone;
    g.strip = '';
    layer.classList.toggle('gl-p', phone);
    layer.innerHTML = phone
      ? `<div class="fs-bar" id="gl-bar"></div><div class="gb-stage"><img class="gb-im" id="gl-im" alt=""></div><div class="gb-cap" id="gl-cap"></div><div class="gb-strip" id="gl-strip"></div><div class="gb-ctl"><button class="btn gb-big" data-gl-step="-1">${ICON.left(18)}Previous</button><button class="btn gb-big" data-gl-step="1">Next${ICON.right(18)}</button></div>`
      : `<div class="fs-bar" id="gl-bar"></div><div class="gb-stage"><span class="gb-gut"><button class="nav-btn" data-gl-step="-1" aria-label="Previous picture">${ICON.left(20)}</button></span><img class="gb-im" id="gl-im" alt=""><span class="gb-gut"><button class="nav-btn" data-gl-step="1" aria-label="Next picture">${ICON.right(20)}</button></span></div><div class="gb-cap" id="gl-cap"></div><div class="gb-strip" id="gl-strip"></div>`;
  }

  function setHtml(el, html) { if (el && el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } }

  function draw() {
    if (!isOpen() || !layer) return;
    if (g.phone !== d.phone.matches) build();
    const p = d.project(g.pid);
    const name = p ? p.name : '';
    const x = cur();
    const i = idx();
    const n = g.list.length;
    const { esc, escRaw } = d;
    setHtml(layer.querySelector('#gl-bar'), g.phone
      ? `<button class="x-btn" data-gl-close aria-label="Close the pictures">${ICON.x}</button><span class="fs-name">${esc(name)}</span><span class="t2" style="font-size: 13px">Pictures</span><span style="flex: 1"></span><span class="num t2" style="font-size: 13px">${i + 1} of ${n}</span>`
      : `<span class="fs-name">${esc(name)}</span><span class="t2" style="font-size: 13px">Pictures from this session</span><span style="flex: 1"></span><span class="t3" style="font-size: 12px">Left and right arrows to move, Esc to close</span><button class="btn sm" data-gl-close>Close</button>`);
    const im = layer.querySelector('#gl-im');
    if (x && im.getAttribute('src') !== x.url) { im.setAttribute('src', x.url); }
    if (x) im.alt = x.name;
    for (const b of layer.querySelectorAll('[data-gl-step]')) b.disabled = Number(b.dataset.glStep) < 0 ? i <= 0 : i >= n - 1;
    if (x) {
      const by = byWords(x);
      const ago = agoWords(x.at);
      setHtml(layer.querySelector('#gl-cap'), g.phone
        ? `<div><span class="ga-file mono-f">${esc(x.name)}</span></div>${by || ago ? `<div class="t2" style="font-size: 12px">${esc([by, ago].filter(Boolean).join(', '))}</div>` : ''}`
        : `<span class="ga-file mono-f">${esc(x.name)}</span>${by ? `<span class="t2">${esc(by)}</span>` : ''}${ago ? `<span class="t2">${esc(ago)}</span>` : ''}${x.w && x.h ? `<span class="t2 num">${x.w} x ${x.h}</span>` : ''}${x.rel ? `<span class="t3 mono-f gb-rel">${esc(x.rel)}</span>` : ''}<span style="flex: 1"></span>${d.ui.local === true && x.key ? `<button class="btn sm ib" data-gl-reveal>${ICON.folder}Show in Finder</button>` : ''}${x.path ? `<button class="btn sm ib" data-copy="${escRaw(x.path)}" data-copy-msg="Copied ${esc(x.path)}">${ICON.copy}Copy path</button>` : ''}`);
    }
    // The strip: the thumbnails are made again only when the 6 change, so a
    // move does not load them again; a move only moves the ring.
    const keys = g.list.map((y) => y.key + '|' + y.url).join(',') + (g.phone ? ':p' : ':d');
    const strip = layer.querySelector('#gl-strip');
    if (g.strip !== keys) {
      g.strip = keys;
      strip.innerHTML = g.list.map((y, k) => `<span class="gl-cell"><button class="gl-thumb" data-gl-go="${k}" aria-label="${esc(`${y.name}${y.at ? ', ' + agoWords(y.at) : ''}`)}"><img src="${escRaw(y.url)}" alt=""></button>${g.phone ? '' : `<span class="gl-time num"></span>`}</span>`).join('');
    }
    strip.querySelectorAll('.gl-cell').forEach((c, k) => {
      const on = k === i;
      const b = c.querySelector('.gl-thumb');
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      const t = c.querySelector('.gl-time');
      if (t) { t.classList.toggle('on', on); const a = age(g.list[k].at); if (t.textContent !== a) t.textContent = a; }
    });
  }

  // Opens on the picture with that key (a card tile), else the newest.
  function open(pid, key) {
    const p = d.project(pid);
    const list = galleryOf(p);
    if (!list.length) return;
    ensureLayer();
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

  function close({ back = true } = {}) {
    if (!isOpen()) return;
    g.pid = null; g.list = []; g.key = null; g.strip = '';
    layer.hidden = true;
    layer.innerHTML = '';
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

  // A new snapshot: the 6 may have moved on. The picture shown stays while
  // it is still one of them; else the newest. None left: closed.
  function sync() {
    if (!isOpen()) return;
    const list = galleryOf(d.project(g.pid));
    if (!list.length) { close(); return; }
    if (!list.some((x) => x.key === g.key)) g.key = list[list.length - 1].key;
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
    if (!isOpen()) return;
    if (t.closest('[data-gl-close]')) { close(); return; }
    const s = t.closest('[data-gl-step]');
    if (s) { step(Number(s.dataset.glStep)); return; }
    const go = t.closest('[data-gl-go]');
    if (go) { const y = g.list[Number(go.dataset.glGo)]; if (y) { g.key = y.key; draw(); } return; }
    if (t.closest('[data-gl-reveal]')) reveal();
  });
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }, true);
  window.addEventListener('popstate', () => { if (isOpen()) close({ back: false }); });
  d.phone.addEventListener('change', () => { if (isOpen()) draw(); });

  return { open, close, sync, isOpen };
}
