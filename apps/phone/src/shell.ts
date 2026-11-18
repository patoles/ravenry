// The page's only way out: the shell (docs/PHONE.md section 7). The Android
// and iOS shells answer over the `ravenryShell` channel and make every hub
// request themselves, over TLS with the pinned key and the device token.
//
// Without a shell (a browser, for development and the screenshots) the
// page is served by tools/serve.mjs, which passes hub/<path> to a hub on
// this machine; then the same ops are done with fetch, EventSource and
// WebSocket, and the shell's own features (push, fingerprint, camera,
// microphone, the private keyboard) are missing, as `features` says.

export interface Hello {
  v: number;
  platform: string;
  /** Which device the shell runs on, where it says: "iphone" or "ipad" (the iOS app). */
  form?: string;
  app: string;
  hub: { name: string; port?: number };
  device: { id: string; name: string } | null;
  features: string[];
  /** The alert that opened the app, if one did. */
  pending?: Alert | null;
  /** The app's launch now: "warm" when the board reloads in a rebuilt activity (the still mark waits, briefly); "ink" for Android 13's shader, which lands on its own clock. */
  launch?: 'cold' | 'warm' | 'ink' | null;
  /** The demo (src/demo.ts): no Mac, the board answered from the app's own files. */
  demo?: boolean;
}

/** A push message's alert (docs/PHONE.md section 5), as far as the page reads it. */
export interface Alert {
  id: string;
  kind?: string;
  project?: { id: string; name: string } | null;
  session?: { surfaceId: string } | null;
  checkpoint?: { id: string; kind: string } | null;
}

import { cannot, fileUrl, forget, loadDemo } from './demo.ts';
import type { Demo } from './demo.ts';

type Fn = (msg: Record<string, unknown>) => void;

export interface Shell {
  hello: Hello;
  call<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T>;
  on(event: string, fn: Fn): () => void;
  has(feature: string): boolean;
}

export const BRIDGE_VERSION = 1;

/** The channel object a shell puts on window (WebMessageListener or a WKScriptMessageHandler wrapper). */
interface Channel {
  postMessage(data: string): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  addEventListener?(type: 'message', fn: (ev: { data: unknown }) => void): void;
}

/** Requests waiting for their reply, and event listeners: the part both shells share. */
export class Wire {
  private next = 1;
  private waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
  private listeners = new Map<string, Set<Fn>>();

  private send: (text: string) => void;
  constructor(send: (text: string) => void) { this.send = send; }

  call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    return new Promise<T>((ok, no) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, no });
      this.send(JSON.stringify({ v: BRIDGE_VERSION, id, op, ...args }));
    });
  }

  /** One message from the shell: a reply to a request, or an event. */
  receive(raw: unknown): void {
    let m: Record<string, unknown>;
    try { m = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (typeof m.id === 'number' && this.waiting.has(m.id)) {
      const w = this.waiting.get(m.id)!;
      this.waiting.delete(m.id);
      if (m.ok) w.ok(m.result);
      else w.no(new Error(String(m.error || 'The app could not do that.')));
      return;
    }
    if (typeof m.event === 'string') this.emit(m.event, m);
  }

  emit(event: string, m: Record<string, unknown>): void {
    for (const fn of this.listeners.get(event) || []) { try { fn(m); } catch (e) { console.error(e); } }
  }

  on(event: string, fn: Fn): () => void {
    let s = this.listeners.get(event);
    if (!s) { s = new Set(); this.listeners.set(event, s); }
    s.add(fn);
    return () => s!.delete(fn);
  }
}

class NativeShell implements Shell {
  hello!: Hello;
  private wire: Wire;
  constructor(ch: Channel) {
    this.wire = new Wire((t) => ch.postMessage(t));
    const take = (ev: { data: unknown }) => this.wire.receive(ev.data);
    if (ch.addEventListener) ch.addEventListener('message', take);
    else ch.onmessage = take;
  }
  async start(): Promise<void> { this.hello = await this.wire.call<Hello>('hello'); }
  call<T>(op: string, args?: Record<string, unknown>): Promise<T> { return this.wire.call<T>(op, args); }
  on(event: string, fn: Fn): () => void { return this.wire.on(event, fn); }
  has(f: string): boolean { return (this.hello.features || []).includes(f); }
}

// ---------------------------------------------------------------- the browser stand-in

const b64 = {
  from(bytes: Uint8Array): string { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); },
  to(s: string): Uint8Array<ArrayBuffer> { const t = atob(s); const out = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; },
};
export { b64 };

class BrowserShell implements Shell {
  hello: Hello = { v: 1, platform: 'browser', app: 'dev', hub: { name: 'this computer' }, device: null, features: [] };
  private wire = new Wire(() => {});
  private sockets = new Map<number, WebSocket>();
  private nextSid = 1;
  private es: EventSource | null = null;

  async start(): Promise<void> {
    // ?form=ipad: the iPad's words, for a look at the board as the iPad app has it.
    const form = new URLSearchParams(location.search).get('form');
    if (form) this.hello.form = form;
    if (demoPage()) { this.hello.demo = true; return; }
    try {
      const r = await fetch('hub/api/phone/hello');
      if (r.ok) { const j = await r.json(); if (j && j.name) this.hello.hub = { name: j.name, port: j.port }; }
    } catch { /* an older hub: the name stays generic */ }
    const q = new URLSearchParams(location.search);
    if (q.get('features')) this.hello.features = q.get('features')!.split(',');
  }

  has(f: string): boolean { return this.hello.features.includes(f); }
  on(event: string, fn: Fn): () => void { return this.wire.on(event, fn); }

  async call<T>(op: string, a: Record<string, unknown> = {}): Promise<T> {
    switch (op) {
      case 'hub.call': {
        const method = String(a.method || 'GET');
        const init: RequestInit = { method, headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Ravenry': '1' } : {} };
        if (method === 'POST') init.body = JSON.stringify(a.body ?? {});
        const r = await fetch('hub' + String(a.path), init);
        const text = await r.text();
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: r.status, body } as T;
      }
      case 'hub.events': {
        if (a.on && !this.es) {
          const es = new EventSource('hub/api/events');
          for (const name of ['state', 'phone', 'ideas', 'plan']) es.addEventListener(name, (ev) => this.wire.emit('hub', { event: 'hub', name, data: JSON.parse((ev as MessageEvent).data) }));
          es.onopen = () => this.wire.emit('link', { event: 'link', state: 'up' });
          es.onerror = () => this.wire.emit('link', { event: 'link', state: 'down', error: 'The board did not answer.' });
          this.es = es;
        } else if (!a.on && this.es) { this.es.close(); this.es = null; }
        return undefined as T;
      }
      case 'socket.open': {
        const sid = this.nextSid++;
        const url = new URL('hub' + String(a.path), location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(url.href, String(a.protocol || 'ravenry.v1'));
        ws.binaryType = 'arraybuffer';
        this.sockets.set(sid, ws);
        await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error('Could not open the terminal.')); });
        ws.onmessage = (ev) => this.wire.emit('socket.message', typeof ev.data === 'string' ? { sid, text: ev.data } : { sid, b64: b64.from(new Uint8Array(ev.data as ArrayBuffer)) });
        ws.onclose = (ev) => { this.sockets.delete(sid); this.wire.emit('socket.close', { sid, code: ev.code, reason: ev.reason }); };
        return { sid } as T;
      }
      case 'socket.send': {
        const ws = this.sockets.get(Number(a.sid));
        if (ws) ws.send(typeof a.text === 'string' ? a.text : (b64.to(String(a.b64)) as Uint8Array<ArrayBuffer>));
        return undefined as T;
      }
      case 'socket.close': { this.sockets.get(Number(a.sid))?.close(1000); return undefined as T; }
      case 'alerts.clear': case 'open.settings': return undefined as T;
      // The demo in a browser (tools/serve.mjs --demo): leaving it shows where it went.
      case 'demo.leave': location.replace('/phone/left-demo'); return undefined as T;
      case 'demo.alert': (window as unknown as { rvDemoAlert?: unknown }).rvDemoAlert = a.alert; return { posted: false } as T;
      case 'back.done': return undefined as T;
      default: throw new Error('This needs the Ravenry app.');
    }
  }
}

// ---------------------------------------------------------------- the demo

/**
 * The demo's shell (src/demo.ts): the native shell for what is the phone's
 * own (the system bars, Back, a fingerprint, the alert's permission), and
 * the demo for everything that would reach the Mac, so nothing does. What
 * needs a Mac (the camera, a voice note, a secret, push, a terminal) says the
 * demo cannot.
 */
const DEMO_NATIVE = new Set(['bars', 'back.done', 'biometric', 'alerts.state', 'alerts.settings', 'alerts.clear', 'ink.ready', 'open.settings', 'demo.alert', 'demo.leave']);
class DemoShell implements Shell {
  hello: Hello;
  private inner: Shell;
  private demo: Demo;
  private wire = new Wire(() => {});
  private off: (() => void) | null = null;
  constructor(inner: Shell, demo: Demo) {
    this.inner = inner;
    this.demo = demo;
    demo.form = inner.hello.form ?? null;
    // Only what the phone can do without a Mac.
    const keep = new Set(['biometric', 'alerts.state']);
    this.hello = { ...inner.hello, demo: true, hub: { name: String(demo.sample.get['/api/phone/me']?.json?.hub?.name || 'Sample Mac') }, device: null, pending: inner.hello.pending ?? null, features: inner.hello.features.filter((f) => keep.has(f)) };
    // For the demo check (tools/demo-check.mjs): what the recording did not answer.
    (window as unknown as { ravenryDemo?: Demo }).ravenryDemo = demo;
    // The alert's buttons, from the native shell (Notifier's demo alert).
    inner.on('demo.action', (m) => { if (typeof m.checkpoint === 'string') this.demo.answer({ id: m.checkpoint, by: 'phone', ...(m.answer as Record<string, unknown>) }, true); });
    // Answered on the board or a screen of the app: its alert leaves the shade, as a hub's close takes it off.
    demo.onAnswered((id, fromAlert) => { if (!fromAlert) void inner.call('alerts.clear', { id: `demo:${id}` }).catch(() => {}); });
    // The question arrives: the phone posts its alert itself, once a visit,
    // when the phone shows Ravenry's alerts (it never asks for them here).
    demo.onArrive(() => {
      const alert = demo.takeAlert();
      if (alert) void inner.call('demo.alert', { alert }).catch(() => {});
    });
  }
  has(f: string): boolean { return this.hello.features.includes(f); }
  on(event: string, fn: Fn): () => void {
    if (event === 'hub' || event === 'link') return this.wire.on(event, fn);
    return this.inner.on(event, fn);
  }
  async call<T>(op: string, a: Record<string, unknown> = {}): Promise<T> {
    const d = this.demo;
    switch (op) {
      case 'hub.call': {
        const r = d.request(String(a.method || 'GET'), String(a.path || '/'), a.body ?? null);
        return { status: r.status, body: r.json ?? r.text ?? null } as T;
      }
      case 'http': {
        const bytes = typeof a.b64 === 'string' && a.b64 ? b64.to(a.b64) : null;
        let body: unknown = null;
        if (bytes) { try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; } }
        const r = d.request(String(a.method || 'GET').toUpperCase(), String(a.path || '/'), body);
        if (r.file) { const f = await fetch(fileUrl(r.file)); return { status: r.status, type: r.type, b64: b64.from(new Uint8Array(await f.arrayBuffer())) } as T; }
        const text = r.json !== undefined ? JSON.stringify(r.json) : r.text ?? '';
        return { status: r.status, type: r.type, b64: b64.from(new TextEncoder().encode(text)) } as T;
      }
      case 'http.part': return undefined as T;
      case 'hub.events': {
        if (a.on && !this.off) {
          this.off = d.on((name, data) => this.wire.emit('hub', { event: 'hub', name, data }));
          setTimeout(() => { this.wire.emit('link', { event: 'link', state: 'up' }); d.emitState(); }, 0);
        } else if (!a.on && this.off) { this.off(); this.off = null; }
        return undefined as T;
      }
      // No chip, no reach bar: the bar on top says it is a demo.
      case 'conn.now': case 'reach.now': return null as T;
      case 'conn.reconnect': case 'reach.retry': return undefined as T;
      case 'push.status': return { distributors: [], current: null, off: true } as T;
      case 'connection.get': return { on: false } as T;
      // Sign out leaves the demo.
      case 'pair.reset': forget(); return this.inner.call<T>('demo.leave');
      case 'demo.leave': forget(); return this.inner.call<T>('demo.leave');
      default:
        if (DEMO_NATIVE.has(op)) return this.inner.call<T>(op, a);
        throw new Error(cannot());
    }
  }
}

let shell: Shell | null = null;

/** Whether this page is the demo's, said by the shell's page before any script asked (the demo board's script tag, the browser stand-in). */
export const demoPage = (): boolean => document.documentElement.hasAttribute('data-demo') || !!document.querySelector('script[data-demo]');

/** The shell this page runs in, once it said hello. */
export async function connect(): Promise<Shell> {
  if (shell) return shell;
  const ch = (globalThis as unknown as { ravenryShell?: Channel }).ravenryShell;
  let s: Shell;
  if (ch) { const n = new NativeShell(ch); await n.start(); s = n; }
  else { const b = new BrowserShell(); await b.start(); s = b; }
  if (s.hello.demo || (!ch && demoPage())) s = new DemoShell(s, await loadDemo());
  shell = s;
  return shell;
}

export function current(): Shell {
  if (!shell) throw new Error('not connected');
  return shell;
}

/** A hub resource for an <img src>: the shell serves hub/<path> beside the page. */
export const hubUrl = (p: string): string => 'hub' + p;
