// The phone button's card (the approved mock, frame c): the switch for phone
// access, the Ravenry app's QR code with its one-time code and check number,
// every device signed in with Sign out, and New key. It reads GET /api/phone
// and writes /api/phone/access, /api/phone/devices/rename (click an app's
// name), /api/phone/devices/revoke and /api/phone/new-key (hub/server/phone.mjs, docs/PHONE.md section 3).

import './phonecard.css';
import { h, replace } from './dom.ts';
import { pairable } from './phonepair.ts';

export interface PhoneDevice { id: string; name: string; platform: string; app?: string | null; created?: string; lastSeen?: string | null }
export interface PhoneCardData {
  access?: boolean; port?: number; phones?: number;
  devices?: PhoneDevice[];
  app?: { name: string; hosts: string[]; port: number; svg: string; code: string; check: string; expires?: string } | null;
}

export interface PhoneCardCtx {
  call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  toast(text: string): void;
  now(): number;
}

/** "now", "2 min ago", "3 h ago", "yesterday", "4 d ago". */
export function seen(iso: string | null | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'not seen yet';
  const m = Math.floor((now - t) / 60000);
  if (m < 1) return 'seen now';
  if (m < 60) return `seen ${m} min ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `seen ${hr} h ago`;
  return hr < 48 ? 'seen yesterday' : `seen ${Math.floor(hr / 24)} d ago`;
}

/** What a device is, for the card's list. */
export function deviceLine(d: PhoneDevice, now: number): { name: string; sub: string } {
  if (d.platform === 'browser') return { name: 'Phone browser', sub: `Signed in with the browser code, ${seen(d.lastSeen, now)}` };
  const what = d.platform === 'android' ? 'Android app' : d.platform === 'ios' ? 'iPhone app' : 'App';
  return { name: d.name || what, sub: `${what}, ${seen(d.lastSeen, now)}` };
}

/** The hub's QR picture, taken only when it is a plain SVG. */
function qr(markup: string): Element | null {
  if (!/^<svg[\s>]/.test(markup) || /<script|on\w+=|href=/i.test(markup)) return null;
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export class PhoneCard {
  private el: HTMLElement | null = null;
  private data: PhoneCardData | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private editing: string | null = null;
  private ctx: PhoneCardCtx;
  constructor(ctx: PhoneCardCtx) { this.ctx = ctx; }

  get open(): boolean { return !!this.el; }

  toggle(anchor: HTMLElement): void {
    if (this.el) { this.close(); return; }
    this.el = h('div.phc', { role: 'dialog', 'aria-label': 'Open on your phone' });
    const r = anchor.getBoundingClientRect();
    this.el.style.left = `${Math.max(8, r.left - 8)}px`;
    this.el.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
    document.body.appendChild(this.el);
    const outside = (e: Event) => { if (this.el && !this.el.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc);
    this.cleanup = () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc); };
    this.paint();
    void this.load();
    // A phone pairing or signing out shows while the card is open.
    this.timer = setInterval(() => void this.load(), 2000);
  }

  private cleanup: () => void = () => {};

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cleanup();
    this.el?.remove();
    this.el = null;
  }

  private async load(): Promise<void> {
    const r = await this.ctx.call('GET', '/api/phone').catch(() => null);
    if (!this.el) return;
    if (r && r.status === 200) this.data = r.body as PhoneCardData;
    else if (r) this.data = { ...(this.data || {}), app: null };
    if (!this.editing) this.paint();
  }

  private async post(p: string, body: unknown, fail: string): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.paint();
    try {
      const r = await this.ctx.call('POST', p, body);
      if (r.status !== 200) this.ctx.toast(String((r.body as { error?: string } | null)?.error || fail));
      else if ((r.body as PhoneCardData).access !== undefined) this.data = r.body as PhoneCardData;
      else if ((r.body as PhoneCardData).devices && this.data) this.data = { ...this.data, devices: (r.body as PhoneCardData).devices };
    } finally { this.busy = false; }
    await this.load();
  }

  // An app's name, which the person can rename here: click it, type, Enter
  // (Escape keeps the old name). The phone's own settings show the new name.
  private nameOf(x: PhoneDevice, name: string): HTMLElement {
    if (x.platform === 'browser') return h('div', name);
    if (this.editing !== x.id) {
      return h('button.phc-nm', { title: 'Rename', disabled: this.busy, on: { click: () => { this.editing = x.id; this.paint(); } } }, name);
    }
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.editing = null;
      const v = input.value.replace(/\s+/g, ' ').trim();
      if (save && v && v !== name) void this.post('/api/phone/devices/rename', { id: x.id, name: v }, 'The name did not change.');
      else this.paint();
    };
    const input = h('input.phc-in', {
      value: name, maxlength: '60', 'aria-label': 'Phone name', spellcheck: 'false',
      on: {
        keydown: (e: Event) => {
          const k = (e as KeyboardEvent).key;
          if (k === 'Enter') { e.preventDefault(); finish(true); }
          else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        },
        blur: () => finish(true),
      },
    }) as HTMLInputElement;
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return input;
  }

  private paint(): void {
    if (!this.el) return;
    const d = this.data;
    const on = !!d?.access;
    const app = pairable(on, d?.app);
    const now = this.ctx.now();
    const code = app ? qr(app.svg) : null;
    replace(this.el,
      h('div.phc-h', h('span', 'Open on your phone'), h('span.sp'),
        h(`button.phc-tg${on ? '' : '.off'}`, { role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': 'Phone access', disabled: !d || this.busy, on: { click: () => void this.post('/api/phone/access', { on: !on }, 'Phone access did not change.') } })),
      !d ? h('div.phc-b.t2', 'Asking the board...')
        : app && code ? h('div.phc-b',
          h('div.phc-q', code),
          h('div.phc-i', h('b', 'Scan with the Ravenry app'),
            h('span.t2', 'On this Mac’s Wi-Fi or Tailscale. The code works once, for 10 minutes.'),
            h('span.t2', 'Or type'), h('span.phc-code', app.code),
            h('span.t2', 'and check the phone shows ', h('b.num', app.check))))
          : h('div.phc-b.t2', on ? 'No Wi-Fi or Tailscale address, so a phone cannot reach this computer.' : 'Phone access is off. Turn it on to pair a phone.'),
      d && d.devices && d.devices.length ? h('div.phc-dev', d.devices.map((x) => {
        const l = deviceLine(x, now);
        return h('div.phc-dr', h('div.phc-dn', this.nameOf(x, l.name), h('div.s', l.sub)),
          h('button.btn.sm', { disabled: this.busy, on: { click: () => void this.post('/api/phone/devices/revoke', { id: x.id }, 'It was not signed out.') } }, 'Sign out'));
      })) : null,
      h('div.phc-f', h('span', on ? 'Phone access on: the phone port listens on the Wi-Fi and Tailscale.' : 'Phone access off: nothing listens for phones.'), h('span.sp'),
        h('button.btn.sm', { title: 'A new key signs every phone out', disabled: !d || this.busy, on: { click: () => void this.post('/api/phone/new-key', {}, 'No new key.') } }, 'New key')));
  }
}
