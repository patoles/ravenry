// A small element builder: h('div.cls', { attrs }, ...children).

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { on?: Record<string, (e: Event) => void>; style?: string | Record<string, string> };

export function h(tag: string, attrs?: Attrs | Child, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs as Child);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class') el.className = [el.className, String(v)].filter(Boolean).join(' ');
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** An SVG icon from its markup (from icons.ts, never from data). */
export function svg(markup: string): Element {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild!;
}

// A press held inside an element puts off drawing that element again until
// the release has given its click. The window is drawn again at each state
// from the hub (about once a second), and a click whose press and release
// land on two drawings never fires: on 2026-11-07 a session's row and Move
// here did nothing, now and then. Drawn as soon as the press ends (or
// after 3 s, or when the window loses focus).
let pressed: Element | null = null;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
const putOff = new Map<Element, Child[]>();
const afterRelease = new Set<() => void>();
function released(): void {
  if (!pressed) return;
  pressed = null;
  clearTimeout(pressTimer);
  // After the click the release gives, which comes in the same task.
  setTimeout(() => {
    for (const [el, ch] of [...putOff]) { putOff.delete(el); el.textContent = ''; append(el, ch); }
    for (const fn of [...afterRelease]) { afterRelease.delete(fn); fn(); }
  }, 0);
}

/**
 * For a drawing that does not go through replace() (the panel patches its
 * sections): true while a press is held inside el, and `redraw` runs once
 * the release has given its click.
 */
export function heldIn(el: Element, redraw: () => void): boolean {
  if (!pressed || !el.contains(pressed)) return false;
  afterRelease.add(redraw);
  return true;
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => { pressed = e.target instanceof Element ? e.target : null; clearTimeout(pressTimer); pressTimer = setTimeout(released, 3000); }, true);
  document.addEventListener('pointerup', released, true);
  document.addEventListener('pointercancel', released, true);
  window.addEventListener('blur', released);
}

export function replace(el: Element, ...children: Child[]): void {
  if (pressed && el.contains(pressed)) { putOff.set(el, children); return; }
  putOff.delete(el);
  el.textContent = '';
  append(el, children);
}

/**
 * replace(), for a page the window draws again at each state from the hub
 * (about once a second): when the drawing is the same as what shows,
 * nothing is touched, so a scroll, a zoom, a selection, the field with the
 * keyboard and what is typed in it all stay; when it differs, what shows is
 * replaced and each scrolled part is put back where it was (by its place in
 * the page), with the focus and the selection of the field that had them.
 */
export function redraw(el: Element, ...children: Child[]): boolean {
  const next = document.createElement('div');
  append(next, children);
  if (next.innerHTML === el.innerHTML) return false;
  const pathOf = (n: Element): string => { const p: number[] = []; let x: Element | null = n; while (x && x !== el) { const par: Element | null = x.parentElement; if (!par) break; p.unshift(Array.prototype.indexOf.call(par.children, x)); x = par; } return p.join('.'); };
  const scrolled: [string, number, number][] = [];
  for (const s of el.querySelectorAll('*')) if (s.scrollTop || s.scrollLeft) scrolled.push([pathOf(s), s.scrollTop, s.scrollLeft]);
  const a = document.activeElement as HTMLInputElement | null;
  const focus = a && el.contains(a) ? { path: pathOf(a), id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  const first = next.firstChild;
  replace(el, ...Array.from(next.childNodes));
  if (first && el.firstChild !== first) return true; // put off while a press is held
  const at = (p: string): Element | null => { let x: Element | null = el; for (const i of p ? p.split('.').map(Number) : []) { x = x ? x.children[i] || null : null; } return x; };
  for (const [p, t, l] of scrolled) { const s = at(p); if (s) { s.scrollTop = t; s.scrollLeft = l; } }
  if (focus) {
    const f = (focus.id && document.getElementById(focus.id)) || at(focus.path);
    if (f && el.contains(f)) { (f as HTMLElement).focus(); try { (f as HTMLInputElement).setSelectionRange(focus.s, focus.e); } catch { /* not a text field */ } }
  }
  return true;
}

// Pictures decoded before a view that shows them is drawn, so a view never
// shows an empty frame where a picture lands a moment later. The Image
// objects are kept (the last 120), which keeps their pixels decoded.
const decodedUrls = new Set<string>();
const decoding = new Map<string, Promise<void>>();
const keptImages: HTMLImageElement[] = [];

/** True when url's picture is loaded and decoded. */
export function pictureReady(url: string): boolean { return decodedUrls.has(url); }

/** Loads and decodes url's picture (once); resolves when it can be drawn, or failed. */
export function preloadPicture(url: string): Promise<void> {
  if (decodedUrls.has(url)) return Promise.resolve();
  const was = decoding.get(url);
  if (was) return was;
  const im = new Image();
  im.decoding = 'async';
  im.src = url;
  const p = im.decode().catch(() => { /* a broken picture draws as one */ }).then(() => {
    decoding.delete(url);
    decodedUrls.add(url);
    keptImages.push(im);
    if (keptImages.length > 120) { const old = keptImages.shift()!; decodedUrls.delete(old.src); }
  });
  decoding.set(url, p);
  return p;
}

/** What still waits among these pictures, or null when all of them can be drawn now. */
export function picturesWait(urls: string[]): Promise<unknown> | null {
  const miss = urls.filter((u) => !decodedUrls.has(u));
  return miss.length ? Promise.all(miss.map(preloadPicture)) : null;
}
