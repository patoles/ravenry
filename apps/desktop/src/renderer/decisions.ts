// The Decisions page (31, variant A) and what the window says about the
// ledger elsewhere: the person's directions, newest first, each in their
// words with when, where and who saved it; a decision that replaced
// another carries the old one crossed out; how often agents read each.
// When an agent saves one, a toast says so with Undo for its minute and
// Show. The ledger is the hub's (hub/docs/DECISIONS.md); the window reads
// it every few seconds (its own reads are not counted).

import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';
import type { HubState } from './model.ts';

export interface Decision {
  id: string;
  quote: string;
  at: string;
  project: string | null;
  scope?: string | null;
  overrides?: string[];
  overridden_by?: string | null;
  overridden_at?: string | null;
  by: 'person' | 'agent' | 'client';
  recorded_by?: { pane?: string; session?: string; assistant?: string } | null;
  edited_at?: string | null;
  reads_today?: number;
  reads_total?: number;
  last_read_at?: string | null;
  undo_until?: string | null;
}

export interface DecisionsHost {
  call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  hub(): HubState | null;
  now(): number;
  /** Shows a toast with links. */
  say(text: string, links: { label: string; run: () => void }[]): void;
  show(): void;
  rerender(): void;
  /** True while the page is on screen. */
  onScreen(): boolean;
}

const POLL_MS = 3000;

type Filter = 'now' | 'replaced' | 'all';

export class Decisions {
  list: Decision[] = [];
  private seen = new Set<string>();
  private first = true;
  private filter: Filter = 'now';
  private project = '';
  private search = '';
  /** The decision a toast's Show points at: lit on the page. */
  private lit: string | null = null;
  private timer: number | undefined;

  private el: HTMLElement;
  private host: DecisionsHost;
  constructor(el: HTMLElement, host: DecisionsHost) { this.el = el; this.host = host; }

  start(): void {
    void this.poll();
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void { clearInterval(this.timer); }

  /** The active ones (not replaced). */
  get active(): Decision[] { return this.list.filter((d) => !d.overridden_by); }

  async poll(): Promise<void> {
    let r: { status: number; body: unknown };
    try { r = await this.host.call('GET', '/api/decisions?all=1'); } catch { return; }
    if (r.status !== 200) return;
    const list = ((r.body as { decisions?: Decision[] }).decisions || []).slice();
    const fresh = this.first ? [] : list.filter((d) => !this.seen.has(d.id));
    for (const d of list) this.seen.add(d.id);
    this.first = false;
    const changed = JSON.stringify(list) !== JSON.stringify(this.list);
    this.list = list;
    for (const d of fresh) if (d.by !== 'person') this.saved(d);
    if (changed) { if (this.host.onScreen()) this.render(); this.host.rerender(); }
  }

  /** An agent saved one: said at once, with Undo for its minute. */
  private saved(d: Decision): void {
    const replaced = (d.overrides || []).length > 0;
    const what = d.scope ? `: the ${d.scope}.` : '.';
    const text = replaced ? `Decision replaced${what}` : `Saved your decision${what === '.' ? `: "${short(d.quote, 48)}"` : what}`;
    const links = [] as { label: string; run: () => void }[];
    if (d.undo_until && Date.parse(d.undo_until) > this.host.now()) links.push({ label: 'Undo', run: () => void this.undo(d) });
    links.push({ label: 'Show', run: () => { this.lit = d.id; this.filter = 'now'; this.host.show(); } });
    this.host.say(text, links);
  }

  async undo(d: Decision): Promise<void> {
    const r = await this.host.call('POST', '/api/decisions/undo', { id: d.id });
    if (r.status === 200) { this.host.say('Undone. The decision before it holds again.', []); await this.poll(); this.render(); }
    else this.host.say((r.body as { error?: string }).error || 'The minute to undo it is over; you can still remove it on the Decisions page.', []);
  }

  /** The decisions an agent read just before it asked (a checkpoint opened at `at`), for its card. */
  checkedBefore(projectId: string | null | undefined, at: string): Decision[] {
    const t = Date.parse(at);
    return this.list.filter((d) => d.last_read_at && (d.project === null || !projectId || d.project === projectId)
      && Date.parse(d.last_read_at) <= t + 5000 && Date.parse(d.last_read_at) >= t - 15 * 60000);
  }

  private projectName(id: string | null): string {
    if (!id) return 'Every project';
    return (this.host.hub()?.projects || []).find((p) => p.id === id)?.name || id;
  }

  private sessionName(d: Decision): string | null {
    const rb = d.recorded_by;
    if (!rb) return null;
    for (const p of this.host.hub()?.projects || []) for (const s of p.sessions) {
      if ((rb.session && s.sessionId === rb.session) || (rb.pane && (s.surfaceId === `ravenry:${rb.pane}` || (typeof s.pane === 'string' ? s.pane : s.pane?.id) === rb.pane))) return s.topic || p.name;
    }
    return null;
  }

  render(): void {
    const now = this.host.now();
    const projects = new Map<string, string>();
    for (const d of this.list) if (d.project) projects.set(d.project, this.projectName(d.project));
    const words = this.search.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = this.list.filter((d) => (this.filter === 'now' ? !d.overridden_by : this.filter === 'replaced' ? !!d.overridden_by : true)
      && (!this.project || d.project === this.project || (this.project && d.project === null && false))
      && words.every((w) => `${d.quote} ${d.scope || ''}`.toLowerCase().includes(w)));
    const replaced = this.list.filter((d) => d.overridden_by).length;
    const byId = new Map(this.list.map((d) => [d.id, d]));
    const days: { label: string; items: Decision[] }[] = [];
    for (const d of shown) {
      const label = dayLabel(d.at, now);
      const last = days[days.length - 1];
      if (last && last.label === label) last.items.push(d); else days.push({ label, items: [d] });
    }
    const seg = (f: Filter, label: string) => h(`button.seg${this.filter === f ? '.on' : ''}`, { on: { click: () => { this.filter = f; this.render(); } } }, label);
    const search = h('input', { type: 'search', placeholder: 'Search what you said', value: this.search, 'aria-label': 'Search what you said', on: { input: (e: Event) => { this.search = (e.target as HTMLInputElement).value; this.renderList(); } } }) as HTMLInputElement;
    const sel = h('select', { 'aria-label': 'Project', on: { change: (e: Event) => { this.project = (e.target as HTMLSelectElement).value; this.render(); } } },
      h('option', { value: '', selected: !this.project }, 'All projects'),
      [...projects].map(([id, name]) => h('option', { value: id, selected: this.project === id }, name)));
    this.listEl = h('div.dec-list', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
    this.fill(days, byId, now);
    replace(this.el,
      h('div.pg-h', h('div.tt', h('h2', 'Decisions'), h('div.pg-src', 'What you decided, in your words. Agents read this before they ask you.'))),
      h('div.pg-b',
        h('div.dec-tools',
          h('span.dsel', this.project ? projects.get(this.project) || this.project : 'All projects', svg(I.DOWN), sel),
          h('label.dsearch', svg(I.SEARCH), search),
          h('div.ptabs', seg('now', 'Holds now'), seg('replaced', 'Replaced'), seg('all', 'All')),
          h('span.sp'),
          h('span.t3.small.num', `${this.list.length} decision${this.list.length === 1 ? '' : 's'}${replaced ? `, ${replaced} replaced` : ''}`)),
        this.listEl));
    if (this.lit) {
      const target = this.el.querySelector(`[data-dec="${this.lit}"]`);
      if (target) target.scrollIntoView({ block: 'nearest' });
    }
  }

  private listEl: HTMLElement | null = null;

  private renderList(): void {
    if (!this.listEl) { this.render(); return; }
    const now = this.host.now();
    const words = this.search.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = this.list.filter((d) => (this.filter === 'now' ? !d.overridden_by : this.filter === 'replaced' ? !!d.overridden_by : true)
      && (!this.project || d.project === this.project) && words.every((w) => `${d.quote} ${d.scope || ''}`.toLowerCase().includes(w)));
    const days: { label: string; items: Decision[] }[] = [];
    for (const d of shown) {
      const label = dayLabel(d.at, now);
      const last = days[days.length - 1];
      if (last && last.label === label) last.items.push(d); else days.push({ label, items: [d] });
    }
    this.fill(days, new Map(this.list.map((d) => [d.id, d])), now);
  }

  private fill(days: { label: string; items: Decision[] }[], byId: Map<string, Decision>, now: number): void {
    const el = this.listEl!;
    if (!days.length) {
      replace(el, h('p.t3.empty-pg', this.list.length ? 'Nothing matches.' : 'Nothing decided yet. When you tell an agent how something should be, it saves your words here, and every agent reads them before it asks you.'));
      return;
    }
    replace(el, days.map((g) => [h('div.dec-day', g.label), g.items.map((d) => this.card(d, byId, now))]));
  }

  private card(d: Decision, byId: Map<string, Decision>, now: number): HTMLElement {
    const gone = !!d.overridden_by;
    const undoable = !!d.undo_until && Date.parse(d.undo_until) > now;
    const isNew = undoable || this.lit === d.id;
    const old = (d.overrides || []).map((id) => byId.get(id)).filter((x): x is Decision => !!x);
    const where = this.sessionName(d);
    const reads = d.reads_today ? `Read ${times(d.reads_today)} today` : d.reads_total ? `Read ${times(d.reads_total)}` : null;
    const rep = gone ? byId.get(d.overridden_by!) : null;
    return h(`div.dcard${gone ? '.gone' : ''}${isNew && !gone ? '.new' : ''}`, { 'data-dec': d.id },
      h('div.q', `“${d.quote}”`),
      !gone && old.length ? old.map((o) => h('div.rep', svg(I.UNDO), h('span', `Replaces what you said on ${longWhen(o.at)}: `, h('s', `“${o.quote}”`)))) : null,
      h('div.dmeta',
        undoable ? h('span.badge', 'Just now') : gone ? h('span.badge.g', 'Replaced') : null,
        h('span.num', timeOnly(d.at)),
        h('b', this.projectName(d.project)),
        where ? h('span', `said in ${where}`) : d.by === 'person' ? h('span', 'you added it') : null,
        gone ? h('span.reads', rep ? `Replaced ${dayWord(rep.at, now)} at ${timeOnly(rep.at)}` : 'Replaced')
          : undoable ? h('span.reads', h('button.lk', { on: { click: () => void this.undo(d) } }, 'Undo'))
            : reads ? h('span.reads', svg(I.BOOK), reads) : null));
  }
}

function short(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '...' : s; }
function times(n: number): string { return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`; }
function timeOnly(iso: string): string { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function longWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${timeOnly(iso)}`;
}
function dayWord(iso: string, now: number): string {
  const d = new Date(iso);
  if (d.toDateString() === new Date(now).toDateString()) return 'today';
  if (d.toDateString() === new Date(now - 86400000).toDateString()) return 'yesterday';
  return `on ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (d.toDateString() === new Date(now).toDateString()) return `Today, ${wd} ${md}`;
  if (d.toDateString() === new Date(now - 86400000).toDateString()) return `Yesterday, ${wd} ${md}`;
  return `${wd}, ${md}`;
}
