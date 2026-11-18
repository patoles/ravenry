// The demo (docs/PHONE.md, The demo): the app on a phone that has no Mac
// yet, for a store's reviewer or anyone curious, reached from the pairing
// screen's "No Mac yet? Try the demo" and never once a Mac is paired.
//
// It stands in for the Mac: the board is the hub's own page (hub/public,
// carried by the app since its build, apps/phone/build.mjs), and every
// request it would make to the hub is answered here, from a recording of a
// sample board (src/demo/sample.json, tools/demo-sample.mjs): sample
// projects on "Sample Mac" and devbox, sessions at work, their live
// screens, a question, a command to approve and a pick. An answer is taken
// as the hub takes it (the card closes, the session goes on as the
// recording shows) and goes nowhere: nothing in the demo opens a
// connection, the shells answer only from the app's own files.
//
// What the demo has done lives in the page's sessionStorage (`rv-demo`) for
// as long as the visit lasts, so the board and the app's own screens (a
// pick, the settings) see the same answers; leaving the demo clears it, and
// the WebView that held it goes with the screen.

import { deviceWord, t } from './strings.ts';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One recorded answer of the hub: JSON, text, or a file beside the recording. */
interface Got { status: number; json?: Json; text?: string; type?: string; file?: string }

/** What tools/demo-sample.mjs writes. */
export interface Sample {
  capturedAt: number;
  ask: string;
  approve: string;
  pick: string;
  open: { state: Json; live: Record<string, Json> };
  after: Record<string, { answer: Json; first: Json; done: Json; live: Json }>;
  get: Record<string, Got>;
}

/** A visit to the demo: when it began (the recording's times move to it), and what the person did. */
export interface Visit {
  shift: number;
  /** When notes-app's question arrives (a few seconds in, as a real one would). */
  askAt: number;
  /** Whether this visit's alert went (once a visit). */
  alerted: boolean;
  answers: Record<string, { at: number; reply: Json; doneAt?: number }>;
  /** What the person typed into each session, in order. */
  sent: Record<string, string[]>;
}

export const VISIT_KEY = 'rv-demo';
/** The board's own settings (its theme, its last project) for this visit only: never the real board's. */
export const STORE_KEY = 'rv-demo-ls';
/** The question arrives this long after the visit began. */
export const ASK_AFTER_MS = 6000;
/** A command approved runs this long (the recording's command took about as long). */
export const RUN_MS = 3000;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const DAY = 86400000;

/** The recording's times moved by `d` ms: ISO strings, and epoch numbers near the recording. */
export function shifted<T>(o: T, d: number, at: number): T {
  const walk = (v: Json): Json => {
    if (typeof v === 'string') return ISO.test(v) ? new Date(Date.parse(v) + d).toISOString() : v;
    if (typeof v === 'number') return Number.isInteger(v) && v > at - 60 * DAY && v < at + 2 * DAY ? v + d : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const out: Json = {}; for (const k of Object.keys(v)) out[k] = walk(v[k]); return out; }
    return v;
  };
  return walk(o);
}

/** A request's path as the recording keys it: the cache-busting `v` left out. */
export function keyOf(pathAndQuery: string): string {
  const u = new URL(pathAndQuery, 'http://demo');
  u.searchParams.delete('v');
  const q = u.searchParams.toString();
  return u.pathname + (q ? '?' + q : '');
}

export function newVisit(sample: Sample, now: number): Visit {
  return { shift: now - sample.capturedAt, askAt: now + ASK_AFTER_MS, alerted: false, answers: {}, sent: {} };
}

/** A reply as the shells give it to the page. */
export interface Reply { status: number; type: string; json?: Json; text?: string; file?: string }

const json = (status: number, j: Json): Reply => ({ status, type: 'application/json', json: j });

/** The words a session's message box shows, from the shared strings: the demo cannot do what needs a Mac. */
export const cannot = (): string => t('demo.cannot');

export class Demo {
  readonly sample: Sample;
  visit: Visit;
  /** Requests the recording did not have (the demo check fails on any). */
  readonly misses: string[] = [];
  private listeners = new Set<(name: string, data: Json) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private save: (v: Visit) => void;
  private clock: () => number;
  private arrived: (() => void) | null = null;
  /** Which device the demo runs on (the shell's hello `form`): "phone", or "ipad" for its words. */
  form: string | null = null;

  constructor(raw: Sample, visit: Visit | null, save: (v: Visit) => void, clock: () => number = Date.now) {
    this.clock = clock;
    this.visit = visit && typeof visit.shift === 'number' ? visit : newVisit(raw, clock());
    this.sample = shifted(raw, this.visit.shift, raw.capturedAt);
    this.save = save;
    this.save(this.visit);
    this.schedule();
  }

  /** The question's arrival: the page posts its alert then (once a visit). */
  onArrive(fn: () => void): void { this.arrived = fn; if (this.asked()) fn(); }

  /** Whether notes-app's question has arrived. */
  asked(): boolean { return this.clock() >= this.visit.askAt; }

  private schedule(): void {
    for (const x of this.timers) clearTimeout(x);
    this.timers = [];
    const now = this.clock();
    const at = (when: number, fn: () => void) => { if (when > now) this.timers.push(setTimeout(fn, when - now + 20)); };
    at(this.visit.askAt, () => { this.emitState(); this.arrived?.(); });
    for (const a of Object.values(this.visit.answers)) if (a.doneAt) at(a.doneAt, () => this.emitState());
  }

  on(fn: (name: string, data: Json) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emitState(): void { const s = this.state(); for (const fn of this.listeners) fn('state', s); }

  /** The question, as the demo's alert says it (shared strings demo.alert.*). */
  alert(): Json | null {
    const cp = this.openCheckpoints().find((c: Json) => c.id === this.sample.ask);
    if (!cp) return null;
    const name = cp.project || cp.projectId || '';
    const head = String(cp.title || '').split('\n')[0];
    return {
      v: 1, type: 'alert', id: `demo:${cp.id}`, kind: 'ask', at: new Date(this.clock()).toISOString(),
      title: t('demo.alert.title', { project: name }), body: head, detail: t('demo.alert.detail', { device: deviceWord(this.form) }),
      project: { id: cp.projectId, name }, checkpoint: { id: cp.id, kind: 'ask' }, demo: true,
      actions: [...(cp.options || []).slice(0, 2).map((o: string, i: number) => ({ id: `choice:${i}`, label: o })), { id: 'open', label: 'Open' }],
    };
  }

  /** The question's alert, once a visit: null when it went already or the question is answered. */
  takeAlert(): Json | null {
    if (this.visit.alerted) return null;
    const a = this.alert();
    if (!a) return null;
    this.visit.alerted = true;
    this.save(this.visit);
    return a;
  }

  /** The open cards now: the recording's, less those answered, the question once it arrived, the command while it runs. */
  openCheckpoints(): Json[] {
    const now = this.clock();
    const out: Json[] = [];
    for (const c of this.sample.open.state.checkpoints || []) {
      const a = this.visit.answers[c.id];
      if (c.id === this.sample.ask && now < this.visit.askAt) continue;
      if (!a) { out.push(c.id === this.sample.ask ? { ...c, created_at: new Date(this.visit.askAt).toISOString() } : c); continue; }
      if (a.doneAt && now < a.doneAt) out.push({ ...(this.sample.after[c.id]?.first || c), state: 'running' });
    }
    return out;
  }

  /** The board's state now (GET /api/state and the live stream's `state`). */
  state(): Json {
    const st = JSON.parse(JSON.stringify(this.sample.open.state));
    st.generatedAt = new Date(this.clock()).toISOString();
    st.checkpoints = this.openCheckpoints();
    // Every session takes a message in the demo (the message stays on the phone).
    for (const p of st.projects || []) for (const s of p.sessions || []) if (s.surfaceId) s.live = true;
    // The board opens on paper-boat, whose pick waits (the approved picture).
    const boat = (st.projects || []).find((p: Json) => p.id === 'paper-boat');
    if (boat && boat.primary) st.openOn = { projectId: boat.id, surfaceId: boat.primary, key: `${boat.id}/${boat.primary}`, at: new Date(this.visit.askAt - ASK_AFTER_MS).toISOString(), why: 'typed', device: null };
    return st;
  }

  /** A session's live screen (GET /api/live): the recording's, after its answer when it has one, with what was typed. */
  live(surface: string, v: string | null): Json {
    const now = this.clock();
    const cp = Object.keys(this.visit.answers).find((id) => {
      const c = (this.sample.open.state.checkpoints || []).find((x: Json) => x.id === id);
      const a = this.visit.answers[id];
      return c && c.surfaceId === surface && !(c.kind === 'approve' && (a.reply.decline || (a.doneAt && now < a.doneAt)));
    });
    const base = (cp && this.sample.after[cp]?.live) || this.sample.open.live[surface];
    if (!base) return { ok: true, surfaceId: surface, at: null, now, ver: 1, entries: [], status: null };
    const sent = this.visit.sent[surface] || [];
    const ver = (Number(base.ver) || 1) * 1000 + (cp ? 500 : 0) + sent.length;
    const at = now - 900;
    if (v != null && String(ver) === v) return { ok: true, surfaceId: surface, same: true, at, now, ver };
    const entries = [...(base.entries || []), ...sent.map((text, i) => ({ k: `demo-${i}`, l: ['', `> ${text}`] }))];
    return { ...base, at, now, ver, entries };
  }

  private answered: ((id: string, fromAlert: boolean) => void) | null = null;
  /** Each answer, as it is taken: the page takes the card's alert off the shade unless the answer came from it. */
  onAnswered(fn: (id: string, fromAlert: boolean) => void): void { this.answered = fn; }

  /** The person's answer to a card, from the board, an app screen or the alert's buttons. */
  answer(body: Json, fromAlert = false): Reply {
    const id = body && typeof body.id === 'string' ? body.id : '';
    const cp = this.openCheckpoints().find((c: Json) => c.id === id && c.state === 'open');
    if (!cp) return json(409, { error: 'It closed already: answered somewhere else, cancelled or expired.' });
    const now = this.clock();
    const approve = cp.kind === 'approve' && body.approve === true;
    this.visit.answers[id] = { at: now, reply: body, ...(approve ? { doneAt: now + RUN_MS } : {}) };
    this.save(this.visit);
    this.schedule();
    this.emitState();
    this.answered?.(id, fromAlert);
    const first = this.sample.after[id]?.first || cp;
    return json(200, { ok: true, checkpoint: { ...first, state: approve ? 'running' : body.decline ? 'declined' : 'answered' } });
  }

  /** A request of the board or an app screen, answered as the hub would. */
  request(method: string, pathAndQuery: string, body: Json): Reply {
    const u = new URL(pathAndQuery, 'http://demo');
    const p = u.pathname;
    if (method === 'GET' || method === 'HEAD') {
      if (p === '/api/state') return json(200, this.state());
      if (p === '/api/live') return json(200, this.live(u.searchParams.get('surface') || '', u.searchParams.get('v')));
      if (p === '/api/whoami') return json(200, { local: false });
      const got = this.sample.get[keyOf(pathAndQuery)];
      if (got) return got.file ? { status: got.status, type: got.type || 'application/octet-stream', file: got.file } : got.text != null ? { status: got.status, type: got.type || 'text/plain', text: got.text } : json(got.status, got.json);
      this.misses.push(`GET ${keyOf(pathAndQuery)}`);
      return json(404, { error: cannot() });
    }
    if (p === '/api/checkpoints/answer') return this.answer(body);
    if (p === '/api/opened') return json(200, { ok: true });
    if (p === '/api/send' && body && typeof body.surfaceId === 'string') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text) {
        (this.visit.sent[body.surfaceId] = this.visit.sent[body.surfaceId] || []).push(text.slice(0, 2000));
        this.save(this.visit);
      }
      return json(200, { ok: true });
    }
    this.misses.push(`${method} ${p}`);
    return json(409, { error: cannot() });
  }
}

// ---------------------------------------------------------------- the page's own

/** The visit kept in sessionStorage; none when the page has none. */
export function readVisit(): Visit | null {
  try { const v = sessionStorage.getItem(VISIT_KEY); return v ? JSON.parse(v) as Visit : null; } catch { return null; }
}
function writeVisit(v: Visit): void { try { sessionStorage.setItem(VISIT_KEY, JSON.stringify(v)); } catch { /* none */ } }

/** Everything the visit kept, gone (leaving the demo). */
export function forget(): void {
  try { sessionStorage.removeItem(VISIT_KEY); sessionStorage.removeItem(STORE_KEY); } catch { /* none */ }
}

let loading: Promise<Demo> | null = null;
/** The demo, its recording read from the app's own files (`/phone/demo/sample.json`). */
export function loadDemo(): Promise<Demo> {
  if (!loading) {
    loading = (async () => {
      const r = await fetch('/phone/demo/sample.json');
      if (!r.ok) throw new Error('The demo is not in this build.');
      return new Demo(await r.json() as Sample, readVisit(), writeVisit);
    })();
  }
  return loading;
}

/** A picture or file the recording keeps beside it, as the shells serve it. */
export const fileUrl = (file: string): string => `/phone/demo/${file}`;

// ---------------------------------------------------------------- the bar

/**
 * The bar on top of every screen of the demo (A, picked 2026-11-18): it
 * says it is a demo and nothing leaves the phone (the iPad, on an iPad:
 * `form`, the shell's hello), with Pair your Mac.
 */
export function demoBar(onPair: () => void, light: () => boolean, form?: string | null): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rv-demo';
  el.setAttribute('role', 'note');
  const tx = document.createElement('span');
  tx.className = 't';
  const b = document.createElement('b');
  b.textContent = t('demo.bar.lead');
  tx.append(b, ' ', t('demo.bar.text', { device: deviceWord(form) }));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('demo.bar.pair');
  btn.addEventListener('click', onPair);
  el.append(tx, btn);
  const paint = () => el.classList.toggle('light', light());
  paint();
  new MutationObserver(paint).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', paint);
  document.documentElement.classList.add('rv-demo-on');
  document.body.prepend(el);
  // What is under it moves down by its height (src/demo.css), one line or two.
  const measure = () => document.documentElement.style.setProperty('--rv-demo-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
  measure();
  new ResizeObserver(measure).observe(el);
  return el;
}
