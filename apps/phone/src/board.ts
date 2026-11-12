// The app's layer over the hub's own board (docs/PHONE.md section 1). The
// phone app's home is the board the hub serves at phone width (hub/public:
// the approved PhoneProjects C, LiveScreen B and NewSession D), loaded over
// the pinned connection at the app's origin. This script runs first in that
// page, before the board's app.js, and gives it what a browser gets from
// the network:
//
// - fetch('/api/...') and EventSource('/api/events') go through the shell
//   (`http` and `hub.events`), so every byte to the hub has the pinned key
//   and the device token; pictures and the board's own files come through
//   the shell's request handler.
// - Run on a command asks for a fingerprint first (as in the shade).
// - The board's menu gets This phone (the app's own settings: window.ravenryApp);
//   the Mac's bell and phone button are the Mac's and stay hidden.
// - Back goes one level up: the board's own window.ravenryBack (a layer
//   closes with its own close control, a screen goes back to its
//   destination, a destination to Projects); at home the app leaves.
// - The connection (docs/PHONE.md, The connection): the shell's `conn`
//   events (the path in use, up, reconnecting or offline, since when, the
//   round trip) go to the board as window.ravenryApp.conn and the
//   ravenry:conn event, for its chip in the top bar.
// - The launch (docs/PHONE.md, The launch): once the board has drawn its top
//   bar, the shell learns where the bar's mark is (ink.ready), for the
//   mark's flight out of the splash.
// - An alert tapped opens its checkpoint (the app's full-screen screens
//   for a secret, a pick or a drive) or its project.
// - When the computer cannot be reached, a bar says why in plain words
//   (Tailscale off on this phone, not installed, or the Mac not answering),
//   with a button to open or get Tailscale.

import { connect, b64 } from './shell.ts';
import type { Alert, Shell } from './shell.ts';

/** What the shell says about the connection to the Mac (MainActivity's ConnWatch). */
export interface Conn { state: 'up' | 'reconnecting' | 'offline'; via: string; since: number | null; rtt: number | null; reason?: string | null; words?: string | null; mac?: string | null }
declare global {
  interface Window {
    ravenryApp?: { openCheckpoint(id: string): void; openSettings(): void; openTailscale(): void; reconnect(): void; platform: string; conn?: Conn | null };
    ravenryBack?: () => boolean;
  }
}

const ready: Promise<Shell> = connect();

// The app's look over the board, before the board draws anything.
{
  const st = document.createElement('link');
  st.rel = 'stylesheet';
  st.href = '/phone/board.css';
  document.head.appendChild(st);
}

// The board's theme (hub/public applyTheme, saved as mc.theme): the phone's
// own until the person picks one with the board's switch.
try { if (localStorage.getItem('mc.theme') == null) localStorage.setItem('mc.theme', JSON.stringify(matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')); } catch { /* none */ }
const realFetch = window.fetch.bind(window);

/** Where the app's own screens are (apps/phone): a checkpoint, the settings. */
const PHONE = '/phone/index.html';
const openCheckpoint = (id: string): void => { location.href = `${PHONE}#/cp/${encodeURIComponent(id)}`; };
/** The app's own settings (this phone's pairing, push, Sign out): the board's menu, This phone. */
const openSettings = (): void => { location.href = `${PHONE}#/settings`; };
window.ravenryApp = {
  openCheckpoint, openSettings, platform: 'android', conn: null,
  openTailscale: () => { void ready.then((sh) => sh.call('open.tailscale')).catch(() => {}); },
  reconnect: () => { void ready.then((sh) => sh.call('conn.reconnect')).catch(() => {}); },
};
function setConn(c: Conn | null, mac: string | null): void {
  if (!window.ravenryApp) return;
  window.ravenryApp.conn = c ? { ...c, mac: c.mac || mac } : null;
  window.dispatchEvent(new CustomEvent('ravenry:conn'));
}

async function bodyBytes(input: RequestInfo | URL, init?: RequestInit): Promise<Uint8Array | null> {
  const b = init && 'body' in init ? init.body : input instanceof Request ? await input.clone().arrayBuffer() : null;
  if (b == null) return null;
  if (typeof b === 'string') return new TextEncoder().encode(b);
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (b instanceof Blob) return new Uint8Array(await b.arrayBuffer());
  if (b instanceof URLSearchParams) return new TextEncoder().encode(b.toString());
  return new Uint8Array(await new Response(b as BodyInit).arrayBuffer());
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const h = new Headers(input instanceof Request ? input.headers : undefined);
  if (init && init.headers) new Headers(init.headers).forEach((v, k) => h.set(k, v));
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

/** A command's Run: the fingerprint first, as the shade asks (docs/PHONE.md section 5). */
async function confirmRun(sh: Shell, path: string, bytes: Uint8Array | null): Promise<boolean> {
  if (path !== '/api/checkpoints/answer' || !bytes) return true;
  let b: { approve?: boolean } | null = null;
  try { b = JSON.parse(new TextDecoder().decode(bytes)); } catch { return true; }
  if (!b || b.approve !== true || !sh.has('biometric')) return true;
  try { await sh.call('biometric', { title: 'Run this command?' }); return true; } catch { return false; }
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  const sh = await ready;
  const method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const bytes = method === 'GET' || method === 'HEAD' ? null : await bodyBytes(input, init);
  const path = url.pathname + url.search;
  if (!(await confirmRun(sh, url.pathname, bytes))) {
    return new Response(JSON.stringify({ error: 'Not run: the fingerprint was not confirmed.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  let r: { status: number; type?: string; b64?: string };
  try {
    r = await sh.call('http', { method, path, headers: headersOf(input, init), b64: bytes ? b64.from(bytes) : null });
  } catch (e) {
    // As a browser's fetch: the network failed. The bar says why.
    throw new TypeError((e as Error).message || 'The computer did not answer.');
  }
  const body = r.status === 204 || r.status === 304 ? null : (b64.to(r.b64 || '') as BodyInit);
  return new Response(body, { status: r.status, headers: { 'Content-Type': r.type || 'application/octet-stream' } });
};

// ---------------------------------------------------------------- the live stream

type Listener = (ev: MessageEvent) => void;
const RealES = window.EventSource;

/** EventSource('/api/events') through the shell; anything else as the browser does it. */
class ShellEventSource extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2;
  readyState = 0;
  readonly url: string;
  readonly withCredentials = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: Listener | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private offs: (() => void)[] = [];

  constructor(url: string) {
    super();
    this.url = new URL(url, location.href).href;
    void ready.then((sh) => {
      if (this.readyState === 2) return;
      this.offs.push(sh.on('hub', (m) => {
        const ev = new MessageEvent(String(m.name), { data: JSON.stringify(m.data) });
        this.dispatchEvent(ev);
        if (m.name === 'message' && this.onmessage) this.onmessage(ev);
      }));
      this.offs.push(sh.on('link', (m) => {
        if (m.state === 'up') { this.readyState = 1; const ev = new Event('open'); this.dispatchEvent(ev); this.onopen?.(ev); } else { this.readyState = 0; const ev = new Event('error'); this.dispatchEvent(ev); this.onerror?.(ev); }
      }));
      void sh.call('hub.events', { on: true });
    });
  }

  close(): void {
    this.readyState = 2;
    for (const off of this.offs.splice(0)) off();
    void ready.then((sh) => sh.call('hub.events', { on: false })).catch(() => {});
  }
}

window.EventSource = function EventSource(url: string | URL, init?: EventSourceInit) {
  const u = new URL(String(url), location.href);
  if (u.origin === location.origin && u.pathname === '/api/events') return new ShellEventSource(u.href);
  return new RealES(url, init);
} as unknown as typeof EventSource;

// ---------------------------------------------------------------- the app around the board

// The app's look over the board (src/board.css, with the agents' glyph font): built into board.css.


/** Words for why the computer cannot be reached, from the shell (docs/PHONE.md, Reaching the Mac). */
interface Reach { reason?: string | null; words?: string | null }

let reachBar: HTMLElement | null = null;
function showReach(sh: Shell, r: Reach | null): void {
  if (!reachBar) {
    reachBar = document.createElement('div');
    reachBar.className = 'rv-reach';
    reachBar.setAttribute('role', 'status');
    reachBar.hidden = true;
    document.body.appendChild(reachBar);
  }
  if (!r || !r.words) { reachBar.hidden = true; return; }
  const btn = r.reason === 'tailscale-off' ? 'Open Tailscale' : r.reason === 'tailscale-missing' ? 'Get Tailscale' : null;
  reachBar.replaceChildren();
  const p = document.createElement('div');
  p.textContent = r.words;
  reachBar.appendChild(p);
  const row = document.createElement('div');
  row.className = 'rv-row';
  if (btn) {
    const b = document.createElement('button');
    b.textContent = btn;
    b.addEventListener('click', () => { void sh.call('open.tailscale').catch(() => {}); });
    row.appendChild(b);
  }
  const again = document.createElement('button');
  again.className = btn ? 'q' : '';
  again.textContent = 'Try again';
  again.addEventListener('click', () => { reachBar!.hidden = true; void sh.call('reach.retry').catch(() => {}); });
  row.appendChild(again);
  reachBar.appendChild(row);
  reachBar.hidden = false;
}

function toast(text: string): void {
  const t = document.createElement('div');
  t.className = 'rv-toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

/** An alert tapped: its checkpoint's screen, else its project on the board. */
function openAlert(a: Alert | null | undefined): void {
  if (!a) return;
  if (a.checkpoint && a.checkpoint.id) { openCheckpoint(a.checkpoint.id); return; }
  if (a.project) location.hash = a.session ? `#${encodeURIComponent(a.project.id)}/${encodeURIComponent(a.session.surfaceId)}` : `#${encodeURIComponent(a.project.id)}`;
}

/**
 * Back: the full-screen live screen, the menu, a sheet, a page (back to
 * Pages), search; then another bar destination goes home to Projects;
 * at home the app leaves.
 */
function goBack(): boolean {
  // The board's own (hub/public/app.js phoneBack): any layer, any screen.
  if (typeof window.ravenryBack === 'function') return window.ravenryBack();
  // An older board: what it had.
  if (history.state && (history.state as { lvFull?: number }).lvFull) { history.back(); return true; }
  const close = document.querySelector('#pmenu [data-act="pn-menu-close"], #idle-sheet [data-idle-close], #modal [data-close], #modal .x, #pbar [data-act="pn-back"]') as HTMLElement | null;
  if (close) { close.click(); return true; }
  const on = document.querySelector('#bnav .pn-d.on') as HTMLElement | null;
  if (on && on.dataset.pnav !== 'projects') { (document.querySelector('#bnav [data-pnav="projects"]') as HTMLElement).click(); return true; }
  return false;
}

function start(sh: Shell): void {
  document.documentElement.dataset.app = sh.hello.platform;
  sh.on('back', () => { const handled = goBack(); void sh.call('back.done', { handled }).catch(() => {}); });
  sh.on('open', (m) => openAlert(m.alert as Alert));
  sh.on('reach', (m) => showReach(sh, m as Reach));
  sh.on('link', (m) => { if (m.state === 'up') showReach(sh, null); });
  // The system bars take the board's background and its light or dark.
  let bars = '';
  const paintBars = () => {
    const light = document.body.classList.contains('light');
    const bg = getComputedStyle(document.getElementById('mc') || document.body).backgroundColor;
    const key = `${light}|${bg}`;
    if (key === bars) return;
    bars = key;
    void sh.call('bars', { light, color: bg }).catch(() => {});
  };
  new MutationObserver(paintBars).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('load', paintBars);
  paintBars();
  // The connection, for the board's chip.
  const mac = sh.hello.hub && sh.hello.hub.name ? sh.hello.hub.name : null;
  sh.on('conn', (m) => setConn(m as unknown as Conn, mac));
  void sh.call<Conn | null>('conn.now').then((c) => setConn(c, mac)).catch(() => {});
  // The launch: where the top bar's mark is, once the board drew it.
  const mark = () => document.querySelector('#pbar .pn-ttl svg') as SVGElement | null;
  const tellMark = (): boolean => {
    const el = mark();
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width) return false;
    void sh.call('ink.ready', { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio, dark: !document.body.classList.contains('light') }).catch(() => {});
    return true;
  };
  // Once the page is idle after its first draw (its first layout is the
  // heaviest frame; the mark's flight goes after it), at most 400 ms later.
  const whenIdle = (f: () => void): void => { const w = window as unknown as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => void }; if (w.requestIdleCallback) w.requestIdleCallback(f, { timeout: 400 }); else setTimeout(f, 120); };
  const tryMark = (): boolean => { if (!mark()) return false; whenIdle(() => { if (!tellMark()) requestAnimationFrame(() => tellMark()); }); return true; };
  if (!tryMark()) {
    const mo = new MutationObserver(() => { if (tryMark()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (sh.hello.pending) openAlert(sh.hello.pending);
  try { const t = sessionStorage.getItem('rv-toast'); if (t) { sessionStorage.removeItem('rv-toast'); toast(t); } } catch { /* none */ }
  void sh.call<Reach | null>('reach.now').then((r) => { if (r) showReach(sh, r); }).catch(() => {});
}

void ready.then((sh) => {
  if (document.body) start(sh);
  else document.addEventListener('DOMContentLoaded', () => start(sh), { once: true });
});
