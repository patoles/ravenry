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
// - Run on a command asks for a fingerprint (Face ID on an iPhone) first (as in the shade).
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
//   mark's flight out of the splash: the phone bar's, or the wide board's
//   (an iPad from 1000 pt, where the phone bar is not shown).
// - An iPad (the iOS app's hello says `form`): the board's words for this
//   device (window.ravenryApp.words, from shared/strings device.*), and
//   html[data-form="ipad"] for board.css, which keeps the Mac's own controls
//   off it.
// - An alert tapped opens its checkpoint (the app's full-screen screens
//   for a secret, a pick or a drive) or its project.
// - When the computer cannot be reached, a bar says why in plain words
//   (Tailscale off on this phone, not installed, or the Mac not answering),
//   with a button to open or get Tailscale. It goes by itself as soon as the
//   Mac answers again, by any path: an empty `reach` (any answer of the
//   hub), the connection up (the shell's check, a network change, Reconnect)
//   or the live stream up. The app's own page for a board that did not load
//   (body[data-unreached]) loads the board then; it also has Scan the code
//   again (pair.again: the pairing screen, with Back to this page).
// - The demo (src/demo.ts; the shell's page says so on this script's tag,
//   before the board's own script reads anything): the board's settings
//   kept for the visit only, never in the real board's storage, the demo's
//   bar on top, and the Mac's own controls left off.

import { connect, b64, demoPage } from './shell.ts';
import type { Alert, Shell } from './shell.ts';
import { deviceWord, t } from './strings.ts';
import { STORE_KEY, demoBar } from './demo.ts';

const DEMO = demoPage();
if (DEMO) {
  // The board keeps its theme and its last project in localStorage: in the
  // demo, in this visit's sessionStorage instead, which leaving the demo
  // clears (and the real board, once a Mac is paired, never sees).
  let m: Record<string, string> = {};
  try { m = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}') || {}; } catch { m = {}; }
  const keep = (): void => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* none */ } };
  const store = {
    get length() { return Object.keys(m).length; },
    key: (i: number) => Object.keys(m)[i] ?? null,
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k: string, v: string) => { m[k] = String(v); keep(); },
    removeItem: (k: string) => { delete m[k]; keep(); },
    clear: () => { m = {}; keep(); },
  };
  try { Object.defineProperty(window, 'localStorage', { value: store, configurable: true }); } catch { /* the board keeps its own then */ }
  document.documentElement.classList.add('rv-demo-on');
}

/** What the shell says about the connection to the Mac (MainActivity's ConnWatch). */
export interface Conn { state: 'up' | 'reconnecting' | 'offline'; via: string; since: number | null; rtt: number | null; reason?: string | null; words?: string | null; mac?: string | null }
declare global {
  interface Window {
    ravenryApp?: { openCheckpoint(id: string): void; openSettings(): void; openTailscale(): void; reconnect(): void; platform: string; conn?: Conn | null; alerts?: { on: boolean } | null; openAlertSettings?(): void; form?: string; words?: { thisDevice: string } };
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

// The board's theme (hub/public applyTheme, saved as mc.theme): Auto, which
// follows the phone's light or dark as it switches, until the person picks
// Light or Dark in the menu. The app up to 0.1.43 saved the phone's theme of
// the first load as if picked, so the board kept it after the phone
// switched; that saved theme goes back to Auto once (mc.themeV).
try {
  if (localStorage.getItem('mc.themeV') !== '2') {
    localStorage.setItem('mc.theme', JSON.stringify('auto'));
    localStorage.setItem('mc.themeV', '2');
  }
} catch { /* none */ }
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
  // This phone's own alerts, as Android has them (the board's Settings, hub/public/app.js paPaintApp).
  alerts: null,
  openAlertSettings: () => { void ready.then((sh) => sh.call('alerts.settings')).catch(() => {}); },
};
/** Whether Android shows Ravenry's alerts, read again each time the board comes back (from Android's settings too). */
function readAlerts(sh: Shell): void {
  if (!sh.has('alerts.state')) return;
  void sh.call<{ on: boolean }>('alerts.state').then((a) => {
    if (!window.ravenryApp) return;
    window.ravenryApp.alerts = a;
    window.dispatchEvent(new CustomEvent('ravenry:alerts'));
  }).catch(() => {});
}
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

// A file the board attaches (POST /api/inbox/<project>, the Mac's route and
// its limit: 64 MB a file, hub/server/index.mjs) goes to the shell in parts
// of PART bytes (`http.part`), read from the file a part at a time: one
// message of a whole file in base64 ran the WebView out of memory (Android,
// a 60 MB file, 2026-11-16: the page crashed and the file was lost). A shell
// without `http.parts` (an older app) gets the body in one message.
const PART = 512 * 1024;
const INBOX_MAX = 64 * 1024 * 1024;
const blobOf = (init?: RequestInit): Blob | null => (init && init.body instanceof Blob ? init.body : null);
const jsonError = (status: number, error: string): Response => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  const sh = await ready;
  const method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const blob = method === 'GET' || method === 'HEAD' ? null : blobOf(init);
  // Over the hub's limit, said before a byte goes (the hub would cut the upload off, which reads as a Mac not answering).
  if (blob && url.pathname.startsWith('/api/inbox/') && blob.size > INBOX_MAX) return jsonError(413, t('phone.fileTooBig'));
  const parts = !!blob && blob.size > PART && sh.has('http.parts');
  const bytes = method === 'GET' || method === 'HEAD' || parts ? null : await bodyBytes(input, init);
  const path = url.pathname + url.search;
  if (!(await confirmRun(sh, url.pathname, bytes))) {
    return jsonError(403, t(sh.hello.platform === 'ios' ? 'phone.bioNotConfirmed.ios' : 'phone.bioNotConfirmed.android'));
  }
  let r: { status: number; type?: string; b64?: string };
  try {
    if (parts && blob) {
      const upload = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      for (let at = 0; at < blob.size; at += PART) {
        await sh.call('http.part', { upload, b64: b64.from(new Uint8Array(await blob.slice(at, at + PART).arrayBuffer())) });
      }
      r = await sh.call('http', { method, path, headers: headersOf(input, init), upload });
    } else {
      r = await sh.call('http', { method, path, headers: headersOf(input, init), b64: bytes ? b64.from(bytes) : null });
    }
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
  // The app's own page for a board that did not load: no board, so no menu
  // to sign out from. Scan the code again opens the pairing screen, whose
  // Back comes back here (the pairing kept until a new one is made).
  if (document.body && document.body.dataset.unreached != null) {
    const out = document.createElement('div');
    out.className = 'rv-row';
    const pair = document.createElement('button');
    pair.className = 'q';
    pair.textContent = 'Scan the code again';
    pair.addEventListener('click', () => { void sh.call('pair.again').catch(() => {}); });
    out.appendChild(pair);
    reachBar.appendChild(out);
  }
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

/** The Mac answers again: the bar goes, and a page that is only the bar becomes the board. */
let reloading = false;
function reached(sh: Shell, now = false): void {
  showReach(sh, null);
  // Not on the page's own first look (`now`): the page was made just after
  // that failed, so only news of an answer reloads it, never in a loop.
  if (!now && document.body && document.body.dataset.unreached != null && !reloading) { reloading = true; location.reload(); }
}

function start(sh: Shell): void {
  document.documentElement.dataset.app = sh.hello.platform;
  if (sh.hello.demo) {
    // The bar on top: Pair your Mac leaves the demo for the pairing screen.
    demoBar(() => { void sh.call('demo.leave').catch(() => {}); }, () => document.body.classList.contains('light'), sh.hello.form);
  }
  // The board reads which app it is in (its words for Run's check, this phone's alerts).
  if (window.ravenryApp) window.ravenryApp.platform = sh.hello.platform;
  // Which device: "This phone" or "This iPad" in the board's menu and top bar.
  document.documentElement.dataset.form = sh.hello.form || 'phone';
  if (window.ravenryApp) {
    window.ravenryApp.form = sh.hello.form || 'phone';
    window.ravenryApp.words = { thisDevice: t('device.this', { device: deviceWord(sh.hello.form) }) };
  }
  sh.on('back', () => { const handled = goBack(); void sh.call('back.done', { handled }).catch(() => {}); });
  sh.on('open', (m) => openAlert(m.alert as Alert));
  sh.on('reach', (m) => { if ((m as Reach).words) showReach(sh, m as Reach); else reached(sh); });
  sh.on('link', (m) => { if (m.state === 'up') reached(sh); });
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
  readAlerts(sh);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') readAlerts(sh); });
  // The app back in front (from Android's notification settings too) says it itself.
  sh.on('alerts', (m) => { if (window.ravenryApp && typeof m.on === 'boolean') { window.ravenryApp.alerts = { on: m.on }; window.dispatchEvent(new CustomEvent('ravenry:alerts')); } });
  // The connection, for the board's chip.
  const mac = sh.hello.hub && sh.hello.hub.name ? sh.hello.hub.name : null;
  sh.on('conn', (m) => { setConn(m as unknown as Conn, mac); if ((m as unknown as Conn).state === 'up') reached(sh); });
  // The launch: where the top bar's mark is, once the board drew it (its bar
  // is filled from its first state): the phone bar's, or at the board's wide
  // width (an iPad) the wide top bar's, whichever is on the screen.
  const mark = (): SVGElement | null => {
    if (!document.querySelector('#pbar > *')) return null;
    for (const sel of ['#pbar .pn-ttl svg', '.mc-top .mc-mark']) {
      const el = document.querySelector(sel) as SVGElement | null;
      if (el && el.getBoundingClientRect().width) return el;
    }
    return null;
  };
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
  // A warm start (the board reloading in a rebuilt activity): no flight to
  // smooth, the board as soon as its bar is laid out. The same for Android
  // 13's shader Ink: it lands on its own clock, and while it draws every
  // frame the page is never idle, so waiting for idle held the board back
  // by up to the 400 ms.
  const warm = sh.hello.launch === 'warm' || sh.hello.launch === 'ink';
  const tryMark = (): boolean => { if (!mark()) return false; if (warm) requestAnimationFrame(() => { if (!tellMark()) requestAnimationFrame(() => tellMark()); }); else whenIdle(() => { if (!tellMark()) requestAnimationFrame(() => tellMark()); }); return true; };
  if (!tryMark()) {
    const mo = new MutationObserver(() => { if (tryMark()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (sh.hello.pending) openAlert(sh.hello.pending);
  try { const t = sessionStorage.getItem('rv-toast'); if (t) { sessionStorage.removeItem('rv-toast'); toast(t); } } catch { /* none */ }
  // How it is now: the bar only while the connection is not up.
  void sh.call<Conn | null>('conn.now').then((c) => {
    setConn(c, mac);
    if (c && c.state === 'up') { reached(sh, true); return; }
    void sh.call<Reach | null>('reach.now').then((r) => { if (r && r.words) showReach(sh, r); }).catch(() => {});
  }).catch(() => {});
}

void ready.then((sh) => {
  if (document.body) start(sh);
  else document.addEventListener('DOMContentLoaded', () => start(sh), { once: true });
});
