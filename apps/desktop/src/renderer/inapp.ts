// Ravenry's own screens for what used to open the board in the browser
// (ravenry-inapp.html, approved 2026-11-08: "Yes they seem correct"):
// a project's pictures (Gallery, one picture large), a plan (its steps
// with their proofs, Pause, a gate's answer), a new plan drafted from the
// brief, an idea's thread, and Alerts. Each is a page in the middle and
// right columns, like Decisions; Close goes back to where it was opened.
//
// The data is the hub's: the state for pictures and plans, /api/plan/draft,
// /api/ideas, /api/alerts/setup, read again every few seconds while a page
// that waits on something shows. What the person types is kept across the
// window's redraws.

import { h, picturesWait, redraw, svg } from './dom.ts';

/** The gallery's first pictures, loaded before it shows (the rest as they scroll in). */
const FIRST_PICS = 24;
import * as I from './icons.ts';
import type { HubProject, HubState } from './model.ts';

export type InView =
  | { kind: 'gallery'; project: string; at?: number | null; lit?: number | null; back: unknown }
  | { kind: 'plan'; project: string; title?: string | null; back: unknown }
  | { kind: 'newplan'; project: string; back: unknown }
  | { kind: 'idea'; id: string; back: unknown }
  | { kind: 'alerts'; back: unknown };

export const IN_KINDS = new Set(['gallery', 'plan', 'newplan', 'idea', 'alerts']);

export interface InAppHost {
  hub(): HubState | null;
  hubUrl(): string;
  call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  go(v: InView): void;
  back(v: InView): void;
  /** The Ideas page, the brief, a project's session. */
  openIdeas(): void;
  openBrief(project: string): void;
  showSession(project: string): boolean;
  pairPhone(): void;
  /** System Settings > Notifications. */
  notificationSettings(): void;
  toast(text: string, error?: boolean): void;
  onScreen(): InView | null;
  now(): number;
}

interface Pic { url: string; name: string; at: string | null; by: string | null; key: string | null }
interface RawStep { kind?: string; mark?: string; text: string; subs?: { k: string; text?: string; list?: string[] }[]; state?: string; proofs?: { text?: string; type?: string; url?: string }[]; n?: number; choices?: string[]; question?: string | null }
interface PlanLike { title: string; plan?: boolean; goal?: string | null; started?: string | null; state?: string | null; steps: RawStep[]; tasks?: { text: string; state?: string }[]; gate?: { question?: string; choices?: string[] } | null }
interface Draft { goal?: string; title?: string | null; steps: { id: string; kind: string; text: string; detail?: string; choices?: string[] }[]; questions: { id: string; text: string; options: string[]; answer: string | null }[]; busy?: { what?: string; who?: string } | null; error?: string | null; canStart?: boolean; openQuestions?: number }
interface Idea { id: string; name: string; stage: string; pitch?: string; thread: { who: string; text: string; at: string; error?: boolean; images?: string[] }[]; pending?: unknown; mockups?: { job?: unknown } | null }
interface AlertsSetup { enabled?: boolean; channel?: string | null; channelLabel?: string | null; last?: { at: string; ok: boolean; error?: string | null } | null; desktop?: { enabled?: boolean; last?: { at: string; ok: boolean; via?: string | null; error?: string | null; denied?: boolean; unconfirmed?: boolean } | null }; ready?: Record<string, boolean>; telegram?: { token?: string | null; bot?: string | null; chat?: string | null }; webhook?: { url?: string | null; kind?: string | null }; ntfy?: { server?: string; topic?: string | null; qr?: string } }

const STAGE: Record<string, string> = { spark: 'Spark', mock: 'Mockup', green: 'Greenlit', park: 'Parked' };
const PLAN_STATE: Record<string, string> = { running: 'Running', gate: 'At a gate', paused: 'Paused', done: 'Done', stopped: 'Stopped' };
const KIND_WORD: Record<string, string> = { do: 'Do', done: 'Done when', branch: 'Branch', gate: 'Gate' };
const BACK = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 2l-4 4 4 4"/></svg>';

const when = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString() ? `today, ${t}` : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${t}`;
};
const base = (p: string): string => String(p || '').split('/').pop() || p;

export class InApp {
  private el: HTMLElement;
  private host: InAppHost;
  /** What the person typed, by field. */
  private typed = new Map<string, string>();
  private draft: Draft | null = null;
  private draftFor = '';
  private ideas: Idea[] | null = null;
  private alerts: AlertsSetup | null = null;
  private open: string | null = null; // the alert channel whose setup is open
  private busy = '';
  private timer: number | undefined;
  private shown = '';
  /** One picture large: null fits it to the page, else its width in pixels (a click, a pinch). */
  private zoomW: number | null = null;
  /** The zoomed picture's margins: room on the side it moved off, so a zoom stays around the pointer. */
  private zoomAt = { l: 0, t: 0, r: 0, b: 0 };
  constructor(el: HTMLElement, host: InAppHost) {
    this.el = el; this.host = host;
    // Escape closes what is open in the page: a channel's setup, a picture at its own size.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || el.hidden) return;
      const v = this.host.onScreen();
      if (!v) return;
      if (this.open) { this.open = null; this.draw(v); } else if (this.zoomW) { this.zoomW = null; this.zoomAt = { l: 0, t: 0, r: 0, b: 0 }; this.draw(v); }
    });
  }

  /** Draws the page for v, and reads what it waits on. */
  show(v: InView): void {
    const key = JSON.stringify({ ...v, back: null });
    if (key !== this.shown) { this.shown = key; this.busy = ''; this.open = null; this.zoomW = null; this.zoomAt = { l: 0, t: 0, r: 0, b: 0 }; void this.load(v); }
    clearInterval(this.timer);
    if (v.kind === 'newplan' || v.kind === 'idea' || v.kind === 'alerts') this.timer = window.setInterval(() => { const now = this.host.onScreen(); if (!now || JSON.stringify({ ...now, back: null }) !== this.shown) { clearInterval(this.timer); return; } void this.load(now); }, 2000);
    this.draw(v);
  }

  hide(): void { clearInterval(this.timer); this.shown = ''; }

  /**
   * What the page waits on before it can be drawn whole, or null when it
   * can be now (the window keeps the view before it until then, so a page
   * never shows "Reading..." and fills a moment later, or a picture's
   * empty frame).
   */
  wait(v: InView): Promise<unknown> | null {
    if (v.kind === 'alerts') return this.alerts ? null : this.fetch(v);
    if (v.kind === 'idea') return this.ideas ? null : this.fetch(v);
    if (v.kind === 'newplan') return this.draftFor === v.project ? null : this.fetch(v);
    if (v.kind === 'gallery') {
      const pics = this.pictures(this.project(v.project));
      const at = v.at != null ? Math.min(v.at, Math.max(0, pics.length - 1)) : null;
      const shown = at != null ? [pics[at], ...pics.slice(0, 12)] : pics.slice(0, FIRST_PICS);
      return picturesWait(shown.filter(Boolean).map((x) => this.host.hubUrl() + x.url));
    }
    return null;
  }

  private fetching = new Map<string, Promise<void>>();
  /** Reads what v shows from the hub (once at a time), without drawing. */
  private fetch(v: InView): Promise<void> {
    const k = v.kind === 'newplan' ? `newplan:${v.project}` : v.kind;
    const was = this.fetching.get(k);
    if (was) return was;
    const p = this.read(v).finally(() => this.fetching.delete(k));
    this.fetching.set(k, p);
    return p;
  }

  private async load(v: InView): Promise<void> {
    await this.fetch(v);
    const now = this.host.onScreen();
    if (now && JSON.stringify({ ...now, back: null }) === this.shown) this.draw(now);
  }

  private async read(v: InView): Promise<void> {
    try {
      if (v.kind === 'newplan') {
        const r = await this.host.call('GET', `/api/plan/draft?projectId=${encodeURIComponent(v.project)}`);
        this.draft = r.status === 200 ? ((r.body as { draft?: Draft | null }).draft || null) : null;
        this.draftFor = v.project;
      } else if (v.kind === 'idea') {
        const r = await this.host.call('GET', '/api/ideas');
        if (r.status === 200) this.ideas = (r.body as { ideas?: Idea[] }).ideas || [];
      } else if (v.kind === 'alerts') {
        const r = await this.host.call('GET', '/api/alerts/setup');
        if (r.status === 200) this.alerts = r.body as AlertsSetup;
      }
    } catch { /* drawn with what it had */ }
  }

  private project(id: string): HubProject | null { return (this.host.hub()?.projects || []).find((p) => p.id === id) || null; }

  // ------------------------------------------------------------ drawing

  private draw(v: InView): void {
    // Drawn again only when what it shows changed: a scroll, a zoom, the
    // field with the keyboard and what is typed in it stay (dom.ts redraw).
    const parts = v.kind === 'gallery' ? (v.at != null ? this.viewer(v) : this.gallery(v))
      : v.kind === 'plan' ? this.plan(v)
        : v.kind === 'newplan' ? this.newPlan(v)
          : v.kind === 'idea' ? this.idea(v)
            : this.alertsPage(v);
    redraw(this.el, ...parts);
  }

  /**
   * One picture large: fitted to the page, or zoomed. A click zooms in (to
   * its own size when that is bigger than the page, else twice as big)
   * around the point clicked, and out again; a trackpad pinch (a wheel with
   * Ctrl, or Safari's gesture events) zooms around the pointer; two fingers
   * pan while zoomed. Zoom and scroll stay through the window's redraws.
   */
  private bigPicture(x: Pic): HTMLElement {
    // The same style a zoom writes on the live picture, so the next drawing matches it and redraw leaves it alone.
    const zoomStyle = (): Record<string, string> | undefined => this.zoomW ? { width: `${this.zoomW}px`, margin: `${this.zoomAt.t}px ${this.zoomAt.r}px ${this.zoomAt.b}px ${this.zoomAt.l}px` } : undefined;
    const img = h('img', { src: this.host.hubUrl() + x.url, alt: x.name, decoding: 'sync', role: 'button', title: this.zoomW ? 'Fit it to the page' : 'Zoom in', 'aria-pressed': this.zoomW ? 'true' : 'false', draggable: 'false', style: zoomStyle() }) as HTMLImageElement;
    const frame = h(`div.ia-big${this.zoomW ? '.full' : ''}`, img);
    const fitW = () => { const f = frame.getBoundingClientRect(); return Math.max(1, Math.min(f.width, img.naturalWidth * (f.height / Math.max(1, img.naturalHeight)), img.naturalWidth)); };
    const zoomTo = (w: number | null, cx: number, cy: number) => {
      const live = this.el.querySelector('.ia-big') as HTMLElement | null;
      const im = live ? live.querySelector('img') as HTMLImageElement : null;
      if (!live || !im) return;
      const r = live.getBoundingClientRect();
      const before = im.getBoundingClientRect();
      // The picture's point under the pointer, as a share of its size.
      const fx = (cx - before.left) / Math.max(1, before.width);
      const fy = (cy - before.top) / Math.max(1, before.height);
      const fit = Math.min(r.width, im.naturalWidth * (r.height / Math.max(1, im.naturalHeight)), im.naturalWidth);
      this.zoomW = w && w > fit * 1.02 ? Math.round(Math.min(w, Math.max(im.naturalWidth, fit) * 6)) : null;
      // The point under the pointer stays under it: the picture goes where
      // that puts it, part of it out of the page if need be. Its margins
      // make room on the side it left, the page scrolls the rest, and two
      // fingers pan it back.
      const nw = this.zoomW || 0, nh = nw * (im.naturalHeight / Math.max(1, im.naturalWidth));
      const vw = live.clientWidth, vh = live.clientHeight;
      const left = (cx - r.left - live.clientLeft) - fx * nw, top = (cy - r.top - live.clientTop) - fy * nh;
      const sx = Math.round(Math.max(0, -left)), sy = Math.round(Math.max(0, -top));
      const ml = Math.round(Math.max(0, left)), mt = Math.round(Math.max(0, top));
      this.zoomAt = !nw ? { l: 0, t: 0, r: 0, b: 0 } : { l: ml, t: mt, r: Math.max(0, Math.ceil(vw + sx - ml - nw)), b: Math.max(0, Math.ceil(vh + sy - mt - nh)) };
      live.classList.toggle('full', !!this.zoomW);
      im.removeAttribute('style');
      const st = zoomStyle();
      if (st) Object.assign(im.style, st);
      im.setAttribute('aria-pressed', this.zoomW ? 'true' : 'false');
      im.title = this.zoomW ? 'Fit it to the page' : 'Zoom in';
      if (!this.zoomW) return;
      live.scrollLeft = sx;
      live.scrollTop = sy;
    };
    img.addEventListener('click', (e) => {
      const me = e as MouseEvent;
      if (this.zoomW) { zoomTo(null, me.clientX, me.clientY); return; }
      const fw = fitW();
      zoomTo(img.naturalWidth > fw * 1.2 ? img.naturalWidth : fw * 2, me.clientX, me.clientY);
    });
    frame.addEventListener('wheel', (e) => {
      const we = e as WheelEvent;
      if (!we.ctrlKey) return; // two fingers: the frame pans by itself while zoomed
      we.preventDefault();
      const cur = this.zoomW || fitW();
      zoomTo(cur * Math.exp(-we.deltaY * 0.01), we.clientX, we.clientY);
    }, { passive: false });
    let g0 = 0;
    frame.addEventListener('gesturestart', (e) => { e.preventDefault(); g0 = this.zoomW || fitW(); });
    frame.addEventListener('gesturechange', (e) => { e.preventDefault(); const ge = e as unknown as { scale: number; clientX: number; clientY: number }; zoomTo(g0 * ge.scale, ge.clientX, ge.clientY); });
    return frame;
  }

  private head(v: InView, title: (Node | string | null)[], src: string | null, extra: (HTMLElement | null)[] = [], backTo: { label: string; run: () => void } | null = null): HTMLElement {
    return h('div.pg-h',
      backTo ? h('button.ia-back', { on: { click: backTo.run } }, svg(BACK), backTo.label) : null,
      h('div.tt', title.length ? h('h2', ...title) : null, src ? h('div.pg-src', src) : null),
      ...extra,
      h('button.icon-btn', { title: 'Close', 'aria-label': 'Close', on: { click: () => this.host.back(v) } }, svg(I.CLOSE)));
  }

  private field(id: string, ph: string, area = false): HTMLElement {
    const el = h(area ? 'textarea.field.ta' : 'input.field', { id, placeholder: ph, 'aria-label': ph }) as HTMLInputElement;
    el.value = this.typed.get(id) || '';
    el.addEventListener('input', () => this.typed.set(id, el.value));
    return el;
  }

  /** A click that waits on the hub: off while it runs, and its error said. */
  private async act(name: string, v: InView, fn: () => Promise<{ status: number; body: unknown }>, done?: (b: Record<string, unknown>) => void): Promise<void> {
    if (this.busy) return;
    this.busy = name; this.draw(v);
    try {
      const r = await fn();
      const b = (r.body || {}) as Record<string, unknown>;
      if (r.status !== 200) this.host.toast(String(b.error || 'It did not work.'), true);
      else if (done) done(b);
    } catch (e) { this.host.toast(`It did not work: ${(e as Error).message}`, true); }
    finally { this.busy = ''; await this.load(v); const now = this.host.onScreen(); if (now) this.draw(now); }
  }

  /** An empty field: it gets the keyboard and says what goes in it. */
  private need(id: string, text: string): boolean {
    if ((this.typed.get(id) || '').trim()) return false;
    (document.getElementById(id) as HTMLElement | null)?.focus();
    this.host.toast(text, true);
    return true;
  }

  // ------------------------------------------------------------ pictures

  /** The project's pictures, newest first: its sessions' last ones, then the brief's. */
  pictures(p: HubProject | null): Pic[] {
    const all = (p?.brief?.pictures || []) as { url?: string; alt?: string; path?: string; auto?: boolean; gallery?: { key: string; name: string; url: string; at: string; by?: string | null }[] }[];
    const auto = all.find((x) => x.auto);
    const out: Pic[] = [];
    if (auto && auto.gallery && auto.gallery.length) for (const g of [...auto.gallery].reverse()) out.push({ url: g.url, name: g.name, at: g.at, by: g.by || null, key: g.key });
    else if (auto && auto.url) out.push({ url: auto.url, name: auto.alt || base(auto.path || ''), at: null, by: null, key: null });
    for (const x of all) if (!x.auto && x.url) out.push({ url: x.url, name: x.alt || base(x.path || ''), at: null, by: 'the brief', key: null });
    return out;
  }

  private gallery(v: Extract<InView, { kind: 'gallery' }>): HTMLElement[] {
    const p = this.project(v.project);
    const pics = this.pictures(p);
    const name = p ? p.name : v.project;
    return [this.head(v, ['Gallery'], `${name}, ${pics.length} ${pics.length === 1 ? 'picture' : 'pictures'} its sessions showed, newest first`),
      h('div.pg-b', pics.length
        ? h('div.ia-gal', pics.map((x, i) => h(`button.ia-gc${v.lit === i ? '.lit' : ''}`, { 'aria-label': `Open ${x.name}`, on: { click: () => this.host.go({ ...v, at: i }) } },
          h('img', { src: this.host.hubUrl() + x.url, alt: x.name, decoding: 'sync', ...(i >= FIRST_PICS ? { loading: 'lazy' } : {}) }),
          h('span.cap', h('b', x.name), x.at || x.by ? h('span', (x.by === 'the brief' ? 'From the brief' : when(x.at))) : null))))
        : h('p.t2', 'No pictures yet. When a session shows one, it lands here.'))];
  }

  private viewer(v: Extract<InView, { kind: 'gallery' }>): HTMLElement[] {
    const p = this.project(v.project);
    const pics = this.pictures(p);
    if (!pics.length) return this.gallery({ ...v, at: null });
    const i = Math.max(0, Math.min(pics.length - 1, v.at || 0));
    const x = pics[i];
    const to = (k: number) => this.host.go({ ...v, at: k });
    return [this.head(v, [], `${i + 1} of ${pics.length}`, [], { label: 'Gallery', run: () => this.host.go({ ...v, at: null, lit: i }) }),
      h('div.pg-b.ia-view',
        this.bigPicture(x),
        h('div.ia-vbar',
          h('span.ti', x.name), x.at || x.by ? h('span.t3.small', (x.by === 'the brief' ? 'From the brief' : when(x.at))) : null, h('span.sp'),
          h('button.btn', { disabled: i === 0, on: { click: () => to(i - 1) } }, 'Previous'),
          h('button.btn', { disabled: i === pics.length - 1, on: { click: () => to(i + 1) } }, 'Next'),
          x.key ? h('button.btn', { disabled: this.busy === 'reveal', on: { click: () => void this.act('reveal', v, () => this.host.call('POST', '/api/project/reveal-picture', { projectId: v.project, key: x.key }), (b) => this.host.toast(`Shown in Finder: ${String(b.path || x.name)}`)) } }, 'Show in Finder') : null),
        pics.length > 1 ? h('div.ia-strip', pics.map((y, k) => h(`button${k === i ? '.on' : ''}`, { 'aria-label': `Show ${y.name}`, 'aria-pressed': k === i ? 'true' : 'false', on: { click: () => to(k) } }, h('img', { src: this.host.hubUrl() + y.url, alt: '', decoding: 'sync' })))) : null)];
  }

  // ------------------------------------------------------------ a plan

  /** The plan to show: the running one as the board derives it, else the brief's by title. */
  private planOf(p: HubProject, title: string | null | undefined): { plan: PlanLike; running: boolean } | null {
    const run = p.plan as unknown as PlanLike | null;
    if (run && (!title || run.title === title)) return { plan: run, running: true };
    const list = ((p.brief as { plan?: PlanLike[] } | null)?.plan || []).filter((o) => o.plan);
    const o = title ? list.find((x) => x.title === title) : list[list.length - 1];
    if (!o) return null;
    const steps = o.steps.map((s) => ({ ...s, state: s.mark === 'x' ? 'done' : s.mark === '-' ? 'skip' : 'todo', proofs: (s.subs || []).filter((x) => x.k === 'proof').map((x) => ({ text: x.text })) }));
    const state = o.state || (steps.every((s) => s.state !== 'todo') ? 'done' : 'paused');
    return { plan: { ...o, steps, state }, running: false };
  }

  private plan(v: Extract<InView, { kind: 'plan' }>): HTMLElement[] {
    const p = this.project(v.project);
    const found = p ? this.planOf(p, v.title) : null;
    if (!p || !found) return [this.head(v, ['Plan'], p ? p.name : v.project), h('div.pg-b', h('p.t2', 'This plan is no longer in the brief.'), p ? h('div.acts', h('button.btn', { on: { click: () => this.host.openBrief(p.id) } }, 'Open the brief')) : null)];
    const { plan, running } = found;
    const steps = plan.steps;
    const state = String(plan.state || 'running');
    const done = steps.filter((s) => s.state === 'done' || s.state === 'skip').length;
    const cur = steps.find((s) => s.state !== 'done' && s.state !== 'skip');
    const post = (what: string, body: Record<string, unknown> = {}) => () => this.host.call('POST', `/api/plan/${what}`, { projectId: p.id, ...body });
    const gate = running ? p.planGate as { question?: string; choices?: string[] } | null : null;
    const pill = h(`span.ia-pill.s-${state}`, PLAN_STATE[state] || state);
    const ctl = running && state === 'running' ? h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('pause', v, post('pause')) } }, 'Pause')
      : running && state === 'paused' ? h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('resume', v, post('resume')) } }, 'Resume') : null;
    return [this.head(v, [plan.title, pill], null, [ctl]),
      h('div.pg-b',
        h('div.ia-meta', h('span', p.name), plan.started ? h('span', `Started ${plan.started}`) : null, h('span', `${done} of ${steps.length} done`)),
        plan.goal ? h('div.sec', h('div.sec-h', 'Goal'), h('p', `"${plan.goal}"`)) : null,
        gate ? h('div.sec.ia-gate', h('div.sec-h', 'It waits for you'), h('p', gate.question || ''),
          (gate.choices || []).length
            ? h('div.acts', (gate.choices || []).map((c) => h('button.btn.pri', { disabled: !!this.busy, on: { click: () => void this.act('answer', v, post('answer', { choice: c }), () => this.host.toast(`Sent: ${c}`)) } }, c)))
            : h('div.ia-reply', this.field('ia-gate', 'Your answer'), h('button.btn.pri', { disabled: !!this.busy, on: { click: () => { if (this.need('ia-gate', 'Type your answer first.')) return; const t = this.typed.get('ia-gate') || ''; void this.act('answer', v, post('answer', { text: t }), () => { this.typed.delete('ia-gate'); this.host.toast('Sent.'); }); } } }, 'Send'))) : null,
        h('div.ia-steps', steps.map((s) => h(`div.ia-ps.${s.state === 'done' || s.state === 'skip' ? 'done' : s === cur ? 'now' : 'todo'}`,
          h('span.bx', s.state === 'done' ? svg(I.CHECK) : null),
          h('span.tx', `${KIND_WORD[s.kind || 'do'] || 'Do'}: ${s.text}`),
          ...(s.proofs || []).map((x) => h('span.proof', `Proof: ${x.text || ''}`))))),
        h('div.acts',
          h('button.btn', { on: { click: () => this.host.openBrief(p.id) } }, 'Open in the brief'),
          p.sessions.length ? h('button.btn', { on: { click: () => { if (!this.host.showSession(p.id)) this.host.toast('No session runs in this project now.', true); } } }, 'Show its session') : null))];
  }

  // ------------------------------------------------------------ a new plan

  private newPlan(v: Extract<InView, { kind: 'newplan' }>): HTMLElement[] {
    const p = this.project(v.project);
    const name = p ? p.name : v.project;
    const d = this.draftFor === v.project ? this.draft : null;
    const post = (what: string, body: Record<string, unknown> = {}) => () => this.host.call('POST', `/api/plan/${what}`, { projectId: v.project, ...body });
    const head = this.head(v, ['New plan'], `${name}, from its brief`);
    if (d && d.busy) {
      return [head, h('div.pg-b', h('div.sec', h('p', `${d.busy.who === 'codex' ? 'Codex' : 'Claude'} is drafting the plan. You read it before anything runs.`)),
        h('div.acts', h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('halt', v, post('halt')) } }, 'Stop')))];
    }
    if (d && d.steps && d.steps.length) {
      return [head, h('div.pg-b',
        h('div.sec', h('div.sec-h', 'The draft'), h('p', h('b', d.title || 'Plan')), d.goal ? h('p.t2.small', `"${d.goal}"`) : null),
        h('div.ia-steps', d.steps.map((s) => h('div.ia-ps.todo', h('span.bx'), h('span.tx', `${KIND_WORD[s.kind] || 'Do'}: ${s.text}`), s.detail ? h('span.proof', s.detail) : null))),
        ...d.questions.map((q) => h('div.sec', h('div.sec-h', 'A question first'), h('p', q.text),
          h('div.acts', q.options.map((o) => h(`button.btn${q.answer === o ? '.pri' : ''}`, { 'aria-pressed': q.answer === o ? 'true' : 'false', disabled: !!this.busy, on: { click: () => void this.act('edit', v, post('edit', { answer: { id: q.id, option: o } })) } }, o))))),
        d.error ? h('p.ia-err', d.error) : null,
        h('div.acts',
          h('button.btn.pri', { disabled: !!this.busy || !d.canStart, on: { click: () => void this.act('start', v, post('start'), () => { this.host.toast('The plan is in the brief, and its session has it.'); this.host.go({ kind: 'plan', project: v.project, back: v.back }); }) } }, 'Start the plan'),
          h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('discard', v, post('discard')) } }, 'Discard'),
          d.openQuestions ? h('span.t3.small', 'Answer the questions first.') : null))];
    }
    const objectives = ((p?.brief as { plan?: PlanLike[] } | null)?.plan || []).filter((o) => !o.plan);
    const o = objectives[0];
    const open = o ? (o.tasks || []).filter((t) => t.state !== 'done').slice(0, 4) : [];
    return [head, h('div.pg-b',
      h('div.ia-fieldset', h('label', { for: 'ia-goal' }, 'What it should get done'), this.field('ia-goal', 'Say it in a sentence or two. It runs step by step and stops at the gates you set.', true)),
      h('div.ia-fieldset', h('label', 'It starts from the brief\'s plan'),
        o ? h('div.sec', h('p.t3.small', o.title), ...(open.length ? open.map((t) => h('p', t.text)) : [h('p.t2.small', 'Every item of it is done.')]))
          : h('div.sec', h('p.t2.small', p?.brief?.goal ? `The brief has no plan yet; it starts from its goal: ${p.brief.goal}` : 'The brief has no plan yet.'))),
      d && d.error ? h('p.ia-err', d.error) : null,
      h('div.acts',
        h('button.btn.pri', { disabled: !!this.busy, on: { click: () => { if (this.need('ia-goal', 'Say what it should get done first.')) return; const goal = (this.typed.get('ia-goal') || '').trim(); void this.act('draft', v, post('draft', { goal }), () => this.typed.delete('ia-goal')); } } }, 'Draft the plan'),
        h('button.btn', { on: { click: () => this.host.back(v) } }, 'Cancel'),
        h('span.t3.small', 'You read the draft before anything runs.')))];
  }

  // ------------------------------------------------------------ an idea

  private idea(v: Extract<InView, { kind: 'idea' }>): HTMLElement[] {
    const back = { label: 'Ideas', run: () => this.host.openIdeas() };
    if (!this.ideas) return [this.head(v, [], null, [], back), h('div.pg-b', h('p.t3', 'Reading the idea...'))];
    const it = this.ideas.find((x) => x.id === v.id);
    if (!it) return [this.head(v, [], null, [], back), h('div.pg-b', h('p.t2', 'That idea is no longer on the Ideas page.'))];
    const post = (p: string, body: Record<string, unknown>) => () => this.host.call('POST', `/api/ideas/${encodeURIComponent(it.id)}/${p}`, body);
    const drawing = !!(it.mockups && it.mockups.job);
    return [this.head(v, [], null, [h(`span.ia-pill.st-${it.stage}`, STAGE[it.stage] || it.stage)], back),
      h('div.pg-b',
        h('h2.ia-title', it.name),
        it.pitch ? h('p.t2', it.pitch) : null,
        h('div.ia-thread',
          it.thread.length ? it.thread.map((m) => h(`div.ia-msg.${m.who === 'you' ? 'you' : 'them'}`,
            h('span.who', `${m.who === 'you' ? 'You' : m.who === 'board' ? 'Ravenry' : m.who === 'codex' ? 'Codex' : 'Claude'}, ${when(m.at)}`),
            h(`div.bd${m.error ? '.err' : ''}`, m.text),
            (m.images || []).length ? h('div.ia-imgs', (m.images || []).map((u) => h('img', { src: this.host.hubUrl() + u, alt: '' }))) : null))
            : h('p.t3', 'Nothing said yet. Ask anything about the idea.'),
          it.pending ? h('p.t3.small', 'Claude is answering...') : null,
          drawing ? h('p.t3.small', 'Claude is drawing a mockup round...') : null),
        h('div.ia-reply', this.field('ia-say', 'Reply to Claude about this idea', true),
          h('button.btn.pri', { disabled: !!this.busy || !!it.pending, on: { click: () => { if (this.need('ia-say', 'Type a reply first.')) return; const text = (this.typed.get('ia-say') || '').trim(); void this.act('say', v, post('say', { text }), () => this.typed.delete('ia-say')); } } }, 'Send')),
        h('div.acts',
          h('button.btn', { disabled: !!this.busy || drawing, on: { click: () => void this.act('mock', v, post('mockups', {}), () => this.host.toast('A mockup round is on its way.')) } }, 'Mockup round'),
          it.stage !== 'green' ? h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('green', v, post('update', { stage: 'green' }), () => this.host.toast('Greenlit.')) } }, 'Greenlight') : null,
          it.stage !== 'park' ? h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('park', v, post('update', { stage: 'park' }), () => this.host.toast('Parked.')) } }, 'Park it') : null))];
  }

  // ------------------------------------------------------------ alerts

  private alertsPage(v: Extract<InView, { kind: 'alerts' }>): HTMLElement[] {
    const a = this.alerts;
    const head = this.head(v, ['Alerts'], 'When a session needs you and you are not looking');
    if (!a) return [head, h('div.pg-b', h('p.t3', 'Reading the alerts...'))];
    const post = (p: string, body: Record<string, unknown> = {}) => () => this.host.call('POST', `/api/alerts/${p}`, body);
    const dk = a.desktop || {};
    const dkOn = dk.enabled !== false;
    // What macOS did with the last one, never more: shown (the app posted
    // it and macOS said so), sent but unconfirmed (macOS's script, with the
    // app not open), or not shown and why.
    const dl = dk.last;
    const denied = dkOn && !!dl && !dl.ok && !!dl.denied;
    const dkLine = !dkOn ? 'Off'
      : !dl ? 'On'
        : denied ? 'macOS has not allowed Ravenry\'s notifications. Turn them on in System Settings > Notifications.'
          : dl.ok ? (dl.unconfirmed ? `On. The last one went through macOS's script ${when(dl.at)}, with Ravenry closed: macOS may not have shown it.` : `On. Last shown ${when(dl.at)}.`)
            : `On. The last one was not shown: ${dl.error || 'no answer'}.`;
    const row = (title: string, line: string, on: boolean, ...acts: (HTMLElement | null)[]) => h('div.ia-al', h('div.tx', h('b', title), h(`span${on ? '.on' : ''}`, line)), ...acts);
    const sw = (on: boolean, label: string, run: () => void) => h(`button.ia-sw${on ? '.on' : ''}`, { role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled: !!this.busy, on: { click: run } });
    const ch = (id: 'telegram' | 'webhook' | 'ntfy', title: string, form: () => (HTMLElement | null)[]) => {
      const ready = !!(a.ready && a.ready[id]);
      const active = a.channel === id && !!a.enabled;
      const line = active ? (a.last && !a.last.ok ? `On. The last one failed: ${a.last.error || 'no answer'}` : `On${a.channelLabel ? `: ${a.channelLabel}` : ''}`) : ready ? 'Set up, not in use' : 'Off';
      const opened = this.open === id;
      return h('div.ia-alw',
        row(title, line, active,
          active ? h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('test', v, post('test', { channel: id }), () => this.host.toast('Test sent.')) } }, 'Send a test') : null,
          active ? h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('off', v, post('switch', { enabled: false })) } }, 'Turn off')
            : ready ? h('button.btn.pri', { disabled: !!this.busy, on: { click: () => void this.act('use', v, post('done', { channel: id, enable: true })) } }, 'Use it') : null,
          h('button.btn', { 'aria-expanded': opened ? 'true' : 'false', on: { click: () => { this.open = opened ? null : id; this.draw(v); } } }, opened ? 'Close' : ready ? 'Change' : 'Set up')),
        opened ? h('div.ia-setup', ...form()) : null);
    };
    const tg = a.telegram || {};
    const wh = a.webhook || {};
    const nt = a.ntfy || {};
    return [head, h('div.pg-b',
      row('Mac notifications', dkLine, dkOn && !denied,
        denied ? h('button.btn.pri', { on: { click: () => this.host.notificationSettings() } }, 'Open Notifications settings') : null,
        h('button.btn', { disabled: !!this.busy || !dkOn, on: { click: () => void this.act('dtest', v, post('desktop/test'), (b) => this.host.toast(b.unconfirmed ? 'Sent through macOS\'s script, with Ravenry closed: Ravenry cannot tell whether it showed.' : 'macOS showed the test notification.')) } }, 'Send a test'),
        sw(dkOn, 'Mac notifications', () => void this.act('desk', v, post('desktop', { enabled: !dkOn })))),
      row('Your phone', 'Questions, picks and approvals reach you away from the desk', false,
        h('button.btn.pri', { on: { click: () => this.host.pairPhone() } }, 'Pair your phone')),
      ch('telegram', 'Telegram', () => [
        h('p.t2.small', tg.token ? `Bot ${tg.bot ? '@' + tg.bot : tg.token}${tg.chat ? `, chat ${tg.chat}` : ''}.` : 'Make a bot with @BotFather in Telegram and paste its token here.'),
        h('div.ia-reply', this.field('ia-tg', 'The bot token'), h('button.btn', { disabled: !!this.busy, on: { click: () => { if (this.need('ia-tg', 'Paste the bot token first.')) return; void this.act('tg', v, post('telegram', { token: (this.typed.get('ia-tg') || '').trim() }), () => this.typed.delete('ia-tg')); } } }, 'Save')),
        tg.token ? h('div.acts', h('span.t2.small', `Send any message to ${tg.bot ? '@' + tg.bot : 'the bot'}, then`), h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('chat', v, post('telegram/find-chat')) } }, 'Find the chat')) : null]),
      ch('webhook', 'Discord or Slack webhook', () => [
        h('p.t2.small', wh.url ? `Now: ${wh.url}` : 'Paste the webhook address from the channel\'s settings.'),
        h('div.ia-reply', this.field('ia-wh', 'The webhook address'), h('button.btn', { disabled: !!this.busy, on: { click: () => { if (this.need('ia-wh', 'Paste the webhook address first.')) return; void this.act('wh', v, post('webhook', { url: (this.typed.get('ia-wh') || '').trim() }), () => this.typed.delete('ia-wh')); } } }, 'Save'))]),
      ch('ntfy', 'ntfy', () => [
        h('p.t2.small', `Scan this with the ntfy app to subscribe to your topic${nt.topic ? ` (${nt.topic})` : ''} on ${nt.server || 'ntfy.sh'}.`),
        nt.qr ? h('img.ia-qr', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(nt.qr)}`, alt: 'QR code that subscribes the ntfy app to your topic' }) : null,
        h('div.acts',
          h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('copy', v, post('ntfy/copy'), () => this.host.toast('The subscribe link is copied.')) } }, 'Copy the link'),
          h('button.btn', { disabled: !!this.busy, on: { click: () => void this.act('topic', v, post('ntfy/new-topic'), () => this.host.toast('A new topic: subscribe to it again.')) } }, 'New topic'))]),
      h('p.t3.small', 'Only one way at a time, besides Mac notifications.'))];
  }
}
