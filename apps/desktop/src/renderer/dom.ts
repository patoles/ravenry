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
