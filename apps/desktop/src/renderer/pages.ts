// The sidebar's pages, drawn from page files (packages/page-format,
// hub/server/pages.mjs). The sidebar's rows come from each page's nav; a
// page opens in the middle and right columns, and picking a session brings
// the terminal back.
//
// What is drawn is the hub's typed model of the page (its last good
// version when the file has a mistake, under the problem) and its drawn
// tab (hub/server/pagedraw.mjs): each section's rows already filtered,
// sorted, limited and grouped, the tabs' counts and the stats, so the app,
// the phone and the Mac app show the same thing and none of them runs the
// format. The tab the person picks is sent to the hub (?tab=) and its
// answer drawn. Every write goes to the hub, field by field, against the
// hash the screen was drawn from.
//
// A page never runs script, loads a remote picture, or types into a
// session without the person seeing it: buttons can only do what the
// format allows, a run always goes through approve-and-run, and a project
// page's buttons stay off until the person trusts it.

import { capitaliseField, fillText, getField, valueText } from './pagefmt.ts';
import type { Action, FieldSpec, Item, ItemSpec, Page, Progress, Section, Source, Tab } from './pagefmt.ts';
import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';

// ---------------------------------------------------------------- the hub's shapes

export interface NavRow {
  key: string; id: string; label: string; icon: string; number: number | null; countLabel: string | null; route: string;
  origin: 'default' | 'global' | 'project'; slot: number | null; project: string | null; projectId: string | null;
  error: boolean; trust: 'trusted' | 'changed' | 'untrusted' | null; defaultChanged: boolean; created: string | null; rev: string;
}

interface Problem { severity: string; code: string; line: number; column: number; message: string; hint: string | null; text: string; lineText: string | null }

export interface PageView {
  key: string; id: string; origin: 'default' | 'global' | 'project'; path: string; file: string; dir: string;
  project: { id: string; name: string; folder: string } | null;
  ok: boolean; stale: boolean; model: Page | null; problems: Problem[];
  trust: { state: 'trusted' | 'changed' | 'untrusted'; actions: { label: string; does: string }[] } | null;
  defaultChanged: { from: number; to: number | null } | null;
  text: string; defaultText: string | null; defaultPath: string | null; historyText: string | null;
  items: { page: Item[]; sections: Item[][][] };
  /** The tab asked for, as the hub drew it (hub/server/pagedraw.mjs); null with no model. */
  drawn: Drawn | null;
}

/** One group of a drawn section: its value and its rows (indexes into the section's rows). */
export interface DrawnGroup { value: string | null; count: number; rows: number[] }
export interface DrawnSection {
  /** Filtered, sorted, limited; `$actions` lists the item buttons that apply. */
  rows: Item[]; count: number;
  groups: DrawnGroup[] | null;
  stats: { label: string; value: number | string | null; note: string | null }[] | null;
}
export interface Drawn { tab: number; tabs: { label: string | null; count: number | null }[]; pageItems: number; sections: DrawnSection[] }

const NO_SECTION: DrawnSection = { rows: [], count: 0, groups: null, stats: null };
/** A drawn group's rows as items. */
const rowsOf = (d: DrawnSection, g: DrawnGroup): Item[] => g.rows.map((i) => d.rows[i]).filter(Boolean);

export interface PagesHost {
  hubUrl(): string;
  call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  toast(text: string, undo?: { label: string; run: () => void }, at?: { page: string; error: boolean }): void;
  pickSession(key: string): void;
  /** Another page in the middle, as its sidebar row opens it. */
  openPage(key: string): void;
  pickProject(id: string): boolean;
  /** The project of the session the person last had open, for Ask Claude to fix. */
  lastProject(): string | null;
  /** A plan, as Ravenry shows it (inapp.ts): by its project and title. */
  openPlan(project: string, title: string | null): void;
  /** An idea's thread (inapp.ts). */
  openIdea(id: string): void;
  openPath(p: string): void;
  openExternal(url: string): void;
  copy(text: string): void;
  /** A checkpoint a run button opened (the hub's view of it): the panel shows it. */
  showCheckpoint(cp: { id: string }): void;
  rerender(): void;
  now(): number;
}

// ---------------------------------------------------------------- icons

const IC = (d: string, extra = '') => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
export const PAGE_ICONS: Record<string, string> = {
  target: I.NAV.Objectives, plans: I.NAV.Plans, idea: I.NAV.Ideas, rules: I.NAV.Rules, ship: I.NAV.Ship,
  flag: IC('<path d="M3 12.8V1.6"/><path d="M3 2.2h7.6L9 4.9l1.6 2.7H3"/>'),
  list: IC('<path d="M5 3.5h7M5 7h7M5 10.5h7M2 3.5h.5M2 7h.5M2 10.5h.5"/>'),
  cards: IC('<rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="1"/><rect x="8" y="8" width="4.5" height="4.5" rx="1"/>'),
  board: IC('<rect x="1.5" y="1.5" width="3" height="11" rx="1"/><rect x="5.5" y="1.5" width="3" height="7" rx="1"/><rect x="9.5" y="1.5" width="3" height="9" rx="1"/>'),
  table: IC('<rect x="1.5" y="1.5" width="11" height="11" rx="1.6"/><path d="M1.5 7h11M7 1.5v11"/>'),
  chart: IC('<path d="M1.5 12.5h11M3.5 10V7M7 10V3.5M10.5 10V5.5"/>'),
  doc: IC('<path d="M3 1.5h5l3 3v8H3z"/><path d="M8 1.5v3h3M5 8h4M5 10.5h3"/>'),
  check: IC('<circle cx="7" cy="7" r="5.5"/><path d="M4.6 7.2l1.7 1.7 3.2-3.4"/>'),
  star: IC('<path d="M7 1.6l1.6 3.4 3.7.5-2.7 2.6.7 3.7L7 10l-3.3 1.8.7-3.7L1.7 5.5l3.7-.5z"/>'),
  bug: IC('<rect x="4" y="4" width="6" height="8" rx="3"/><path d="M4 7H1.5M12.5 7H10M4.5 4.5L3 3M9.5 4.5L11 3M4 10l-2 1.5M10 10l2 1.5M7 4v8"/>'),
  inbox: IC('<path d="M1.5 8.5l2-6h7l2 6v3.5h-11z"/><path d="M1.5 8.5h3l1 1.5h3l1-1.5h3"/>'),
  clock: IC('<circle cx="7" cy="7" r="5.5"/><path d="M7 4v3.2l2 1.3"/>'),
  folder: IC('<path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.3 1.4h4.7a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>'),
  terminal: IC('<rect x="1.5" y="2" width="11" height="10" rx="2"/><path d="M4.2 5.4l2 1.6-2 1.6M7.6 9h2.4"/>'),
  tag: IC('<path d="M1.5 2.5v4l6 6 5-5-6-6h-4a1 1 0 0 0-1 1z"/><circle cx="4.5" cy="4.5" r=".8"/>'),
  heart: IC('<path d="M7 12S1.5 8.8 1.5 5.2A2.8 2.8 0 0 1 7 4a2.8 2.8 0 0 1 5.5 1.2C12.5 8.8 7 12 7 12z"/>'),
  bolt: IC('<path d="M8 1.5L2.5 8H7l-1 4.5L11.5 6H7z"/>'),
  page: IC('<path d="M3 1.5h5l3 3v8H3z"/><path d="M8 1.5v3h3"/>'),
};
const FILE_IC = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3 1.5h5l3 3v8H3z"/><path d="M8 1.5v3h3"/></svg>';
const INFO_IC = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="5.6"/><path d="M7 6.3v3.6M7 4.3v.1" stroke-linecap="round"/></svg>';
const SHIELD_IC = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5l5.5 2v4.2c0 3.2-2.3 5.7-5.5 6.8-3.2-1.1-5.5-3.6-5.5-6.8V3.5z"/><path d="M8 5.5v3.2M8 10.6v.1" stroke-linecap="round"/></svg>';
const CLOCK_S = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="5.5"/><path d="M7 4v3.2l2 1.3" stroke-linecap="round"/></svg>';
const FIX_IC = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.4l2.8 2.8 6.2-6.4"/></svg>';
const FOLD_IC = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2l4 4-4 4"/></svg>';
const OPEN_IC = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5l4 4 4-4"/></svg>';
const RING: Record<string, string> = { you: I.RING_YOU, work: I.RING_WORK, idle: I.RING_IDLE, wait: I.RING_WAIT };

/** The icon of an action: its own, else one by what it does. */
function actionIcon(a: Action): string | null {
  if (a.icon && PAGE_ICONS[a.icon]) return PAGE_ICONS[a.icon];
  switch (a.kind) {
    case 'set': return FIX_IC;
    case 'ask': return I.ASK;
    case 'run': return I.RUN;
    case 'create': return I.PLUS(14);
    default: return null;
  }
}

// ---------------------------------------------------------------- words

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A date as a time: 16:52 today, Yesterday, Mon this week, else Oct 30. */
export function timeText(v: unknown, now: number): string {
  const s = String(v ?? '');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const t = dateOnly ? Date.parse(`${s}T12:00:00`) : Date.parse(s);
  if (Number.isNaN(t)) return s;
  const d = new Date(t);
  const n = new Date(now);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(n) - start(d)) / 86400000);
  if (days === 0 && !dateOnly) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return DAY[d.getDay()];
  return `${MON[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== n.getFullYear() ? `, ${d.getFullYear()}` : ''}`;
}

/** "2 h ago", "3 days ago". */
export function agoText(v: unknown, now: number): string {
  const t = Date.parse(String(v ?? ''));
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

// A value's tone: words that say a thing is fine, or that it needs you.
// The status_text a provider gives (git's) takes its status's tone.
const OK_WORDS = new Set(['done', 'fixed', 'checked', 'passed', 'clean', 'shipped', 'greenlit', 'merged', 'ok', 'answered', 'pushed']);
const YOU_WORDS = new Set(['out of date', 'ahead', 'failed', 'broken', 'blocked', 'stale', 'urgent', 'you', 'gate', 'needs you']);
export function toneOf(v: unknown): 'ok' | 'you' | 'muted' | 'faint' | null {
  const s = String(v ?? '').toLowerCase();
  if (OK_WORDS.has(s)) return 'ok';
  if (YOU_WORDS.has(s)) return 'you';
  if (s === 'changed') return 'muted';
  if (s === 'no_upstream') return 'faint';
  return null;
}
function fieldTone(item: Item, field: string): ReturnType<typeof toneOf> {
  if (field.endsWith('_text')) { const k = field.slice(0, -5); if (getField(item, k) !== undefined) return toneOf(getField(item, k)); }
  return null;
}

// ---------------------------------------------------------------- markdown (document view)

/** Markdown as elements: headings, lists, checkboxes, quotes, code. Raw
 * HTML stays text, and no image is ever loaded. `onBox` gets a box's place
 * among the text's boxes (the k-th), its text and the state it should take. */
export function markdown(md: string, onBox?: (k: number, text: string, done: boolean) => void): HTMLElement {
  const out = h('div.md');
  const lines = String(md || '').split('\n');
  let list: HTMLElement | null = null;
  let code: string[] | null = null;
  let boxes = 0;
  const inline = (t: string): (Node | string)[] => {
    const parts: (Node | string)[] = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      if (m.index > last) parts.push(t.slice(last, m.index));
      parts.push(m[0].startsWith('`') ? h('code', m[0].slice(1, -1)) : h('b', m[0].slice(2, -2)));
      last = m.index + m[0].length;
    }
    if (last < t.length) parts.push(t.slice(last));
    return parts;
  };
  lines.forEach((raw) => {
    const l = raw.replace(/\r$/, '');
    if (code) {
      if (/^\s*(```|~~~)/.test(l)) { out.appendChild(h('pre.md-code', code.join('\n'))); code = null; } else code.push(l);
      return;
    }
    if (/^\s*(```|~~~)/.test(l)) { list = null; code = []; return; }
    const head = l.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (head) { list = null; out.appendChild(h(`div.md-h${Math.min(head[1].length, 3)}`, inline(head[2]))); return; }
    const box = l.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/);
    const li = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (box || li) {
      if (!list) { list = h('ul.md-ul'); out.appendChild(list); }
      if (box) {
        const done = box[1] !== ' ';
        const k = boxes++;
        list.appendChild(h(`li.md-box${done ? '.on' : ''}`, h(`button.bx${done ? '.on' : ''}`, { disabled: !onBox, 'aria-label': done ? 'Untick' : 'Tick', on: { click: () => onBox?.(k, box[2].trim(), !done) } }, done ? svg(I.CHECK) : null), h('span', inline(box[2]))));
      } else list.appendChild(h('li', inline(li![1])));
      return;
    }
    list = null;
    if (!l.trim()) return;
    if (/^>\s?/.test(l)) { out.appendChild(h('blockquote.md-q', inline(l.replace(/^>\s?/, '')))); return; }
    out.appendChild(h('p.md-p', inline(l)));
  });
  if (code) out.appendChild(h('pre.md-code', (code as string[]).join('\n')));
  return out;
}

// ---------------------------------------------------------------- a line diff

/** The lines of `b` with those not in `a` marked, for See what changed. */
export function diffLines(a: string, b: string): { text: string; add: boolean }[] {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { text: string; add: boolean }[] = [];
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && A[i] === B[j]) { out.push({ text: B[j], add: false }); i++; j++; }
    else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++;
    else { out.push({ text: B[j], add: true }); j++; }
  }
  return out;
}

// ---------------------------------------------------------------- the pages

type Modal =
  | { kind: 'form'; at: Addr; action: Action; section: [number, number] | null; values: Record<string, string>; body: string; error: string | null; busy: boolean }
  | { kind: 'confirm'; text: string; ok: string; run: () => Promise<void> | void }
  | { kind: 'approve'; does: string; run: () => Promise<void> }
  | { kind: 'item'; item: Item; section: [number, number] }
  | { kind: 'changed' }
  | { kind: 'link'; url: string }
  | { kind: 'rule'; item: Item; action: Action };

/** Where an action sits in the page: on the page, a section, or an item. */
export interface Addr { scope: 'page' | 'section' | 'item'; tab?: number; section?: number; index: number }

export class Pages {
  host: PagesHost;
  rows: NavRow[] = [];
  cache = new Map<string, { rev: string; view: PageView }>();
  open: string | null = null;
  tab = new Map<string, number>();
  /** Lanes a person unfolded (grouped list) or folded. */
  folded = new Map<string, boolean>();
  /** Lanes showing all their items. */
  shown = new Set<string>();
  modal: Modal | null = null;
  busy = new Set<string>();
  /** Rows that appeared since the window opened, lit for a few seconds. */
  fresh = new Map<string, number>();
  private seen: Set<string> | null = null;
  private loading = new Map<string, Promise<void>>();
  /** For the screenshots: the card the pointer is on. */
  hover: string | null = null;
  el: HTMLElement;
  private width = 0;

  constructor(el: HTMLElement, host: PagesHost) {
    this.el = el;
    this.host = host;
    new ResizeObserver(() => {
      const w = this.el.clientWidth;
      if (this.open && Math.abs(w - this.width) > 8) { this.width = w; this.render(); }
    }).observe(el);
  }

  // ------------------------------------------------------------ the sidebar

  /** The hub's rows changed: note new ones, and read the open page again when its rev moved. */
  update(rows: NavRow[] | undefined): void {
    this.rows = rows || [];
    // Lit once, the first time a page is seen while the window is open.
    if (this.rows.length) {
      if (this.seen) for (const r of this.rows) if (!this.seen.has(r.key)) this.fresh.set(r.key, this.host.now() + 5000);
      this.seen = new Set([...(this.seen || []), ...this.rows.map((r) => r.key)]);
    }
    if (this.open) {
      const r = this.rows.find((x) => x.key === this.open);
      const c = this.cache.get(this.open);
      if (r && (!c || c.rev !== r.rev || this.otherTab(this.open))) void this.load(this.open);
    }
  }

  /** The sidebar's page rows: the shipped ones, a line, then the added ones and a project's. */
  nav(selected: string | null, open: (key: string) => void): HTMLElement[] {
    const now = this.host.now();
    const row = (r: NavRow) => {
      const fresh = selected !== r.key && (this.fresh.get(r.key) || 0) > now;
      const num = r.number !== null && r.number !== 0 ? `${r.number}${r.countLabel ? ` ${r.countLabel}` : ''}` : null;
      return h(`button.vrow${selected === r.key ? '.sel' : ''}${fresh ? '.fresh' : ''}`, { 'data-page': r.key, title: r.project ? `${r.label}, from ${r.project}` : r.label, on: { click: () => open(r.key) } },
        svg(PAGE_ICONS[r.icon] || PAGE_ICONS.page), h('span.vl', r.label),
        num || r.error || r.project ? h('span.c.num', r.error ? h('span.errdot', { title: 'This page file has a problem' }) : null, r.project ? h('span.pt', r.project) : null, num) : null);
    };
    const shipped = this.rows.filter((r) => r.slot !== null && r.origin !== 'project');
    const added = this.rows.filter((r) => !(r.slot !== null && r.origin !== 'project'));
    if (this.fresh.size && [...this.fresh.values()].some((t) => t > now)) setTimeout(() => this.host.rerender(), 5200);
    return [...shipped.map(row), added.length ? h('div.gap') : null, ...added.map(row)].filter((x): x is HTMLElement => !!x);
  }

  // ------------------------------------------------------------ loading

  /** What the page waits on before the window shows it, or null when it can be drawn now. */
  wait(key: string): Promise<void> | null { return this.cache.has(key) ? null : this.load(key); }

  /** Reads the page again, at the tab the person picked. */
  load(key: string): Promise<void> {
    const tab = this.tab.get(key) || 0;
    const lk = `${key}#${tab}`;
    const was = this.loading.get(lk);
    if (was) return was;
    const p = this.read(key, tab);
    this.loading.set(lk, p);
    return p;
  }

  private async read(key: string, tab: number): Promise<void> {
    try {
      const r = await this.host.call('GET', `/api/pages/page?key=${encodeURIComponent(key)}&tab=${tab}`);
      const v = (r.body as { page?: PageView }).page;
      // An answer for a tab the person has since left is not drawn over the
      // one they are on now (its own read is on its way).
      if (r.status === 200 && v && ((this.tab.get(key) || 0) === tab || !this.cache.has(key))) {
        const row = this.rows.find((x) => x.key === key);
        this.cache.set(key, { rev: row ? row.rev : '', view: v });
        // A tab past the page's last (the file lost one) is the hub's last.
        if (v.drawn && v.drawn.tab !== tab) this.tab.set(key, v.drawn.tab);
      }
    } finally {
      this.loading.delete(`${key}#${tab}`);
    }
    if (this.open === key) this.render();
  }

  /** The person picked tab `i`: the hub draws it, and the tab on screen stays until it answers. */
  pickTab(key: string, i: number): void {
    if ((this.tab.get(key) || 0) === i && !this.otherTab(key)) return;
    this.tab.set(key, i);
    void this.load(key);
  }

  /** The cached view is of another tab than the one picked. */
  private otherTab(key: string): boolean {
    const c = this.cache.get(key);
    return !!c && !!c.view.drawn && c.view.drawn.tab !== (this.tab.get(key) || 0);
  }

  show(key: string): void {
    if (this.open !== key) { this.modal = null; this.hover = null; }
    this.open = key;
    this.width = this.el.clientWidth;
    this.render();
    const row = this.rows.find((x) => x.key === key);
    const c = this.cache.get(key);
    if (!c || (row && c.rev !== row.rev) || this.otherTab(key)) void this.load(key);
  }

  close(): void { this.open = null; this.modal = null; }

  // ------------------------------------------------------------ calls

  /** A toast about page `page`: the app shows it only while that page is
   * still the one shown; an error said after the person moved on waits on
   * that page for them (app.ts toast). */
  private say(page: string, text: string, error = false, undo?: { label: string; run: () => void }): void {
    this.host.toast(text, undo, { page, error });
  }

  private async post(p: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await this.host.call('POST', p, body);
    return { status: r.status, body: (r.body || {}) as Record<string, unknown> };
  }

  private async afterWrite(key: string): Promise<void> { await this.load(key); }

  /** Buttons are off on a project page not trusted. A page of yours with a
   * mistake keeps the buttons of its last good version, as it keeps its look. */
  private off(v: PageView): string | null {
    if (v.trust && v.trust.state !== 'trusted') return 'Off until you trust this page';
    if (!v.model) return 'Off until the page file is fixed';
    return null;
  }

  // ------------------------------------------------------------ actions

  /** Does what a button says. `item` is null for a page's or a section's own. */
  async act(v: PageView, a: Action, at: Addr, item: Item | null, sec: [number, number] | null): Promise<void> {
    const key = v.key;
    const ref = item ? (item.$hash ? { file: item.file } : { id: (item.id ?? item.path) as string }) : null;
    const confirmText = a.confirm && item ? fillText(a.confirm, item) : a.confirm ? fillText(a.confirm, {}) : null;
    const go = async () => {
      switch (a.kind) {
        case 'set': {
          if (!item) return;
          const r = await this.post('/api/pages/item/set', { key, at: sec, file: item.file, hash: item.$hash, fields: Object.fromEntries(Object.keys(a.set).map((k) => [k, item[k] ?? null])), patch: a.set });
          if (r.status !== 200) this.say(v.key, String(r.body.error || 'It was not written.'), true);
          await this.afterWrite(key);
          return;
        }
        case 'archive': {
          if (!item) return;
          const r = await this.post('/api/pages/item/archive', { key, at: sec, file: item.file, hash: item.$hash });
          if (r.status !== 200) { this.say(v.key, String(r.body.error || 'It was not archived.'), true); return; }
          this.say(v.key, `Archived ${valueText(item.title)}.`, false, { label: 'Undo', run: () => { void this.post('/api/pages/item/restore', { key, at: sec, file: item.file }).then(() => this.afterWrite(key)); } });
          await this.afterWrite(key);
          return;
        }
        case 'create': {
          const fields = this.formFields(v, sec);
          const values: Record<string, string> = {};
          for (const [k, f] of Object.entries(fields)) values[k] = a.create[k] !== undefined ? String(a.create[k]) : f.default !== undefined ? String(f.default) : '';
          this.modal = { kind: 'form', at, action: a, section: sec, values, body: '', error: null, busy: false };
          this.render();
          return;
        }
        case 'copy': {
          this.host.copy(fillText(a.copy, item || {}));
          this.say(v.key, 'Copied.');
          return;
        }
        case 'open': return this.openTarget(v, a, item, sec);
        case 'ask': return this.ask(v, at, ref);
        case 'run': {
          const r = await this.post('/api/pages/run', { key, at, item: ref });
          if (r.status !== 200) { this.say(v.key, String(r.body.error || 'It did not start.'), true); return; }
          const cp = r.body.checkpoint as { id?: string } | undefined;
          if (cp && cp.id) this.host.showCheckpoint(cp as { id: string });
          return;
        }
        case 'plugin': return this.plugin(v, a, item);
        default: return;
      }
    };
    if (confirmText) { this.modal = { kind: 'confirm', text: confirmText, ok: a.label, run: go }; this.render(); return; }
    await go();
  }

  private async ask(v: PageView, at: Addr, ref: unknown): Promise<void> {
    const r = await this.post('/api/pages/ask', { key: v.key, at, item: ref });
    if (r.status === 409 && r.body.needsApproval) {
      this.modal = {
        kind: 'approve', does: String(r.body.does || ''),
        run: async () => {
          const ap = await this.post('/api/pages/approve', { key: v.key, hash: r.body.hash });
          if (ap.status !== 200) { this.say(v.key, String(ap.body.error || 'Not allowed.'), true); return; }
          await this.ask(v, at, ref);
        },
      };
      this.render();
      return;
    }
    if (r.status !== 200) { this.say(v.key, String(r.body.error || 'Nothing was typed.'), true); return; }
    if (r.body.projectId && r.body.surfaceId) this.host.pickSession(`${r.body.projectId}/${r.body.surfaceId}`);
    this.say(v.key, r.body.sent ? 'Sent to the session.' : 'Typed in the session\'s box. Press Enter to send it.');
  }

  private openTarget(v: PageView, a: Action & { kind: 'open' }, item: Item | null, sec: [number, number] | null): void {
    const t = a.open;
    switch (t.kind) {
      case 'item': if (item) this.openItem(v, item, sec); return;
      case 'file': if (item && item.file) this.host.openPath(this.itemPath(v, item, sec)); return;
      case 'folder': this.host.openPath(this.itemPath(v, item, sec).replace(/\/[^/]*$/, '')); return;
      case 'page': { const r = this.rows.find((x) => x.id === t.page || x.route === t.page); if (r) this.host.openPage(r.key); else this.say(v.key, `No page called ${t.page}.`); return; }
      case 'link': { const url = valueText(item ? getField(item, t.field) : ''); if (/^https?:\/\//.test(url)) { this.modal = { kind: 'link', url }; this.render(); } return; }
      case 'project': case 'session': { const name = fillText(t.text, item || {}); if (!this.host.pickProject(name)) this.say(v.key, `No project called ${name}.`); return; }
    }
  }

  private itemPath(v: PageView, item: Item | null, sec: [number, number] | null): string {
    const src = this.sourceOf(v, sec);
    const dir = v.file.replace(/\/[^/]*$/, '');
    const base = v.origin === 'default' ? v.dir.replace(/^~/, this.homeDir()) : dir;
    const folder = src && src.kind === 'folder' ? src.folder.replace(/\/$/, '') : '';
    return item && item.file ? `${base}/${folder}/${item.file}` : `${base}/${folder}`;
  }

  private homeDir(): string { return (window as unknown as { __ravenryHome?: string }).__ravenryHome || ''; }

  private plugin(v: PageView, a: Action & { kind: 'plugin' }, item: Item | null): void {
    const id = item ? String(item.id ?? '') : '';
    switch (a.plugin) {
      case 'ravenry:save-rule':
        if (item) { this.modal = { kind: 'rule', item, action: a }; this.render(); }
        return;
      case 'ravenry:not-now':
        void this.post(`/api/repeats/${encodeURIComponent(id)}`, { action: 'notnow' }).then((r) => { this.say(v.key, r.status === 200 ? 'Hidden until you say it again.' : String(r.body.error || 'Not hidden.'), r.status !== 200); void this.afterWrite(v.key); });
        return;
      case 'ravenry:write-brief': {
        // In the app: the project's session is asked to write it (the
        // message typed in its box, for the person to send); with none
        // running, the project's own page, where one continues or starts.
        const text = "Write this project's BRIEF.md: its goal, what done means, and its plan.";
        void this.post('/api/pages/ask', { key: v.key, kind: 'fix', text, session: id }).then((r) => {
          if (r.status === 200 && r.body.projectId && r.body.surfaceId) { this.host.pickSession(`${r.body.projectId}/${r.body.surfaceId}`); this.say(v.key, 'Typed in the session\'s box. Press Enter to send it.'); return; }
          if (!this.host.pickProject(id)) this.say(v.key, String(r.body.error || 'No session to ask.'), true);
        });
        return;
      }
      default:
        this.say(v.key, `${a.plugin} is not installed.`);
    }
  }

  /** An item opened: Ravenry's own sheet for it, else its fields and text. */
  openItem(v: PageView, item: Item, sec: [number, number] | null): void {
    const s = sec && v.model ? v.model.tabs[sec[0]].sections[sec[1]] : null;
    const detail = s && s.kind === 'core' ? s.item.detail : null;
    if (detail === 'ravenry:plan') { this.openPlan(item); return; }
    if (detail === 'ravenry:session-sheet') { if (!this.host.pickProject(String(item.id))) this.say(v.key, `No project called ${String(item.id)}.`, true); return; }
    // An idea's thread, its reply box and its next steps (inapp.ts).
    if (detail === 'ravenry:idea-thread') { this.host.openIdea(String((item.$ravenry as { id?: string } | undefined)?.id || item.id || '')); return; }
    if (sec) { this.modal = { kind: 'item', item, section: sec }; this.render(); }
  }

  private sourceOf(v: PageView, sec: [number, number] | null): Source | null {
    if (!v.model) return null;
    if (sec) return v.model.tabs[sec[0]].sections[sec[1]].source;
    return v.model.source;
  }

  private formFields(v: PageView, sec: [number, number] | null): Record<string, FieldSpec> {
    const src = this.sourceOf(v, sec);
    if (!src || src.kind !== 'folder') return {};
    const out: Record<string, FieldSpec> = { title: src.fields.title };
    for (const [k, f] of Object.entries(src.fields)) if (!f.builtin && f.type !== 'image' && f.type !== 'object') out[k] = f;
    return out;
  }

  async toggle(v: PageView, item: Item, sec: [number, number] | null, line: number, text: string, done: boolean): Promise<void> {
    const r = await this.post('/api/pages/item/toggle', { key: v.key, at: sec, file: item.file, line, text, done });
    if (r.status !== 200) this.say(v.key, String(r.body.error || 'Not ticked.'), true);
    await this.afterWrite(v.key);
  }

  // ------------------------------------------------------------ drawing

  render(): void {
    const key = this.open;
    if (!key) return;
    const c = this.cache.get(key);
    const row = this.rows.find((x) => x.key === key);
    if (!c) {
      replace(this.el, h('div.pg-h', h('div.tt', h('h2', row ? row.label : 'Page'), h('div.pg-src', 'Reading the page...'))));
      return;
    }
    const v = c.view;
    const scroll = this.el.querySelector('.pg-b')?.scrollTop || 0;
    const body = h('div.pg-b', this.bars(v), this.page(v));
    replace(this.el, this.head(v), body, this.modal ? this.drawModal(v) : null);
    body.scrollTop = scroll;
  }

  private head(v: PageView): HTMLElement {
    const m = v.model;
    const title = m ? m.title : v.id;
    const off = this.off(v);
    const chip = v.origin === 'default' ? h('span.chip', 'Default page') : v.origin === 'project' && v.project ? h('span.chip', v.project.name) : m && m.from ? h('span.chip', 'Your copy') : null;
    const src: (Node | string | null)[] = [];
    if (v.origin === 'default') src.push(h('span', 'Shipped with Ravenry'));
    else {
      if (v.origin === 'project' && v.trust && v.trust.state !== 'trusted') src.push(h('span', 'Read-only'));
      src.push(h('span.mono', v.origin === 'project' && v.project ? v.path.replace(v.project.folder + '/', '') : v.path));
      const ps = m && m.source && m.source.kind === 'folder' ? m.source : null;
      if (ps && !m!.from && v.origin !== 'project') { const n = v.drawn ? v.drawn.pageItems : v.items.page.length; src.push(h('span.pg-n', `${n} ${noun(m!, n)} in ${ps.folder}`)); }
    }
    const right: (HTMLElement | null)[] = [];
    if (v.origin === 'default') right.push(h('button.btn.sm.quiet', { on: { click: () => void this.customize(v) } }, 'Customize'));
    else if (v.origin !== 'project') right.push(h('button.btn.quiet', { on: { click: () => this.host.openPath(v.file) } }, svg(FILE_IC), 'Open file'));
    if (m) m.actions.forEach((a, i) => {
      if (a.kind === 'off') { right.push(h('button.btn.off', { disabled: true, title: a.reason }, a.label)); return; }
      const pri = a.kind === 'create' && !off;
      const ic = off ? I.LOCK : actionIcon(a);
      right.push(h(`button.btn${pri ? '.pri' : off ? '.sm.off' : ''}`, { disabled: !!off, title: off || undefined, on: { click: () => void this.act(v, a, { scope: 'page', index: i }, null, null) } }, ic ? svg(ic) : null, a.label));
    });
    return h('div.pg-h', h('div.tt', h('h2', title, chip), h('div.pg-src', src)), right);
  }

  private async customize(v: PageView): Promise<void> {
    const r = await this.post('/api/pages/customize', { key: v.key });
    if (r.status !== 200) { this.say(v.key, String(r.body.error || 'Not customized.'), true); return; }
    this.host.openPath(String(r.body.file));
    this.say(v.key, `Your copy is ${r.body.path}. It is the one in the sidebar now.`);
    this.cache.delete(v.key);
    await this.load(v.key);
  }

  private bars(v: PageView): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = [];
    const err = v.problems.find((p) => p.severity === 'error');
    if (err) {
      const file = v.path.split('/').pop() || '';
      const line = err.lineText || '';
      const word = (err.message.match(/^'([^']+)'/) || [])[1];
      const at = word ? line.indexOf(word) : -1;
      const code = at >= 0 ? [line.slice(0, at), h('u', word!), line.slice(at + word!.length)] : [line];
      out.push(h('div.nb.bad', svg(I.WARN),
        h('div.nbt', h('b', `${file} line ${err.line}: ${err.message}${v.stale ? ' Showing the last version that worked.' : ''}`),
          line ? h('pre.eline', h('span.ln', String(err.line)), ...code, err.hint ? h('span.eh', `      ${err.hint}`) : null) : (err.hint ? h('span.t2', err.hint) : null)),
        h('div.bb',
          h('button.btn.sm', { on: { click: () => this.host.openPath(v.file) } }, svg(FILE_IC), 'Open file'),
          h('button.btn.sm', { on: { click: () => void this.askFix(v, err) } }, svg(I.ASK), 'Ask Claude to fix'))));
    }
    if (v.trust && v.trust.state !== 'trusted' && v.project) {
      const changed = v.trust.state === 'changed';
      out.push(h('div.nb.you', svg(SHIELD_IC), h('div.nbt',
        h('b', changed ? 'This page changed since you trusted it. Its buttons are off until you trust it again.' : 'This page came with the project. Its buttons stay off until you trust it.'),
        h('span.t2', h('span.mono.tx', `${v.project.folder}/${v.path.replace(v.project.folder + '/', '')}`), changed ? ', changed by a pull, an edit or an agent. ' : ', added by the repo, not by you. ', h('button.lk', { on: { click: () => this.host.openPath(v.file) } }, 'Read the file')),
        v.trust.actions.length ? h('span.t2.would-h', 'What its buttons would do:') : null,
        v.trust.actions.length ? h('ul.would', v.trust.actions.map((a) => [h('li.an', a.label), h('li', wouldText(a.does))])) : null,
        h('div.row.tb', h('button.btn.sm.pri', { on: { click: () => void this.trust(v) } }, 'Trust'), h('button.btn.sm', { on: { click: () => { this.dismissed.add(v.key + v.text.length); this.render(); } } }, 'Keep read-only'),
          h('span.fine', 'Trust is for this version of the file. If it changes, Ravenry asks again.')))));
      if (this.dismissed.has(v.key + v.text.length)) out.pop();
    }
    if (v.defaultChanged) {
      out.push(h('div.nb.info', svg(INFO_IC), h('div.nbt', h('span', 'Default page, changed since your copy.')),
        h('div.bb', h('button.lk', { on: { click: () => { this.modal = { kind: 'changed' }; this.render(); } } }, 'See what changed'),
          h('button.icon-btn.sm', { title: 'Hide until the next change', 'aria-label': 'Hide', on: { click: () => void this.post('/api/pages/dismiss', { key: v.key }).then(() => this.afterWrite(v.key)) } }, svg(I.CLOSE)))));
    }
    return out;
  }

  private dismissed = new Set<string>();

  private async trust(v: PageView): Promise<void> {
    const r = await this.post('/api/pages/trust', { key: v.key, hash: await sha256(v.text) });
    if (r.status !== 200) { this.say(v.key, String(r.body.error || 'Not trusted.'), true); return; }
    this.say(v.key, 'Trusted, for this version of the file.');
    await this.afterWrite(v.key);
  }

  private async askFix(v: PageView, err: Problem): Promise<void> {
    const file = v.file;
    const text = `The Ravenry page file ${file} has a problem: line ${err.line}: ${err.message}${err.hint ? ' ' + err.hint : ''} Fix it, then run ravenry page check ${file}.`;
    const session = v.project ? v.project.id : this.host.lastProject();
    if (!session) { this.host.copy(text); this.say(v.key, 'No session is open to ask. The request is copied: paste it into one.'); return; }
    const r = await this.post('/api/pages/ask', { key: v.key, kind: 'fix', text, session });
    if (r.status !== 200) { this.say(v.key, String(r.body.error || 'Nothing was typed.'), true); return; }
    this.host.pickSession(`${r.body.projectId}/${r.body.surfaceId}`);
    this.say(v.key, 'Typed in the session\'s box. Press Enter to send it.');
  }

  // ------------------------------------------------------------ the page

  private page(v: PageView): (HTMLElement | null)[] {
    const m = v.model;
    if (!m) return [h('p.t2.empty-pg', 'This page file has a problem, and there is no version of it that worked to show meanwhile.')];
    const d = v.drawn;
    const out: (HTMLElement | null)[] = [];
    // The tab the hub drew is the one on: a picked tab turns on with its
    // sections, when the hub answers, never over the last tab's.
    const ti = d ? Math.min(d.tab, m.tabs.length - 1) : 0;
    if (m.tabbed) {
      out.push(h('div.ptabs', m.tabs.map((t, i) => {
        const n = d && d.tabs[i] ? d.tabs[i].count : null;
        return h(`button.seg${i === ti ? '.on' : ''}`, { on: { click: () => this.pickTab(v.key, i) } }, t.label || `Tab ${i + 1}`, n ? h('span.num.t3', ` ${n}`) : null);
      })));
    }
    let legend = false;
    m.tabs[ti].sections.forEach((s, si) => {
      if (!legend && s.kind === 'core' && s.item.place === 'ravenry:objective-rows') { out.push(objectivesLegend()); legend = true; }
      out.push(this.section(v, s, ti, si));
    });
    return out;
  }

  /** A section as the hub drew it: its rows filtered, sorted and limited, its groups, its stats. */
  drawnOf(v: PageView, si: number): DrawnSection {
    return (v.drawn && v.drawn.sections[si]) || NO_SECTION;
  }

  private section(v: PageView, s: Section, ti: number, si: number): HTMLElement | null {
    const d = this.drawnOf(v, si);
    const items = d.rows;
    const sec: [number, number] = [ti, si];
    if (s.kind === 'placeholder') return h('div.ocard.ph-sec', h('div.ocard-h.t2', s.title || s.view), h('div.orow.t2', s.reason));
    if (s.kind === 'plugin') return this.pluginView(v, s, items, sec);
    switch (s.view) {
      case 'board': return this.board(v, s, d, sec);
      case 'cards': return this.cards(v, s, items, sec);
      case 'table': return this.table(v, s, items, sec);
      case 'stats': return this.stats(d);
      case 'document': return this.documentView(v, s, d, sec);
      default: return this.list(v, s, d, sec);
    }
  }

  private sectionActions(v: PageView, s: Section, sec: [number, number]): HTMLElement | null {
    if (!s.actions.length) return null;
    const off = this.off(v);
    return h('div.sec-acts', s.actions.map((a, i) => this.button(v, a, { scope: 'section', tab: sec[0], section: sec[1], index: i }, null, sec, off, false)));
  }

  private button(v: PageView, a: Action, at: Addr, item: Item | null, sec: [number, number] | null, off: string | null, sm = true): HTMLElement | null {
    // The hub says which of an item's buttons apply to it (its `when`).
    if (item && at.scope === 'item' && Array.isArray(item.$actions) && !(item.$actions as number[]).includes(at.index)) return null;
    if (a.kind === 'off') return h(`button.btn${sm ? '.sm' : ''}.off`, { disabled: true, title: a.reason }, a.label);
    const label = a.label;
    const busy = this.busy.has(`${JSON.stringify(at)}|${item ? item.file || item.id : ''}`);
    const ic = off ? I.LOCK : actionIcon(a);
    return h(`button.btn${sm ? '.sm' : ''}${off ? '.off' : ''}`, { disabled: !!off || busy, title: off || undefined, on: { click: (e: Event) => { e.stopPropagation(); void this.act(v, a, at, item, sec); } } }, ic ? svg(ic) : null, label);
  }

  private itemButtons(v: PageView, spec: ItemSpec, item: Item, sec: [number, number]): HTMLElement[] {
    const off = this.off(v);
    return spec.actions.map((a, i) => this.button(v, a, { scope: 'item', tab: sec[0], section: sec[1], index: i }, item, sec, off)).filter((x): x is HTMLElement => !!x);
  }

  // ------------------------------------------------------------ slots

  private image(v: PageView, item: Item, field: string | null, cls: string): HTMLElement | null {
    if (!field) return null;
    const val = valueText(getField(item, field));
    if (!val) return null;
    let src: string;
    if (val.startsWith('/api/')) src = this.host.hubUrl() + val;
    else if (/^[a-z]+:/i.test(val) || val.startsWith('/') || val.includes('..')) return null;
    else src = `${this.host.hubUrl()}/api/pages/img?key=${encodeURIComponent(v.key)}&path=${encodeURIComponent((item.$base as string || '') + val)}`;
    return h(`div.${cls}`, h('img', { src, alt: valueText(item.title), draggable: 'false', loading: 'lazy' }));
  }

  private badges(item: Item, spec: ItemSpec, s: Section): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = [];
    for (const f of spec.badges) {
      const val = getField(item, f);
      if (val === undefined || val === null || val === '' || (Array.isArray(val) && !val.length)) continue;
      if (f === 'machine') { out.push(h('span.mt', svg(I.MACHINE), valueText(val))); continue; }
      const vals = Array.isArray(val) ? val : [val];
      for (const x of vals) {
        const tone = fieldTone(item, f) || (this.isEnum(s, f) ? toneOf(x) : null);
        out.push(h(`span.as-tag${tone ? `.tone-${tone}` : ''}`, valueText(x)));
      }
    }
    return out;
  }

  private isEnum(s: Section, f: string): boolean {
    const src = s.source;
    const fields = src ? src.fields : null;
    return !!fields && !!fields[f.split('.')[0]] && fields[f.split('.')[0]].type === 'enum';
  }

  private timeEl(item: Item, spec: ItemSpec): HTMLElement | null {
    if (!spec.time) return null;
    const val = getField(item, spec.time);
    if (!val) return null;
    return h('span.tm.num', svg(CLOCK_S), timeText(val, this.host.now()));
  }

  // A progress slot always says its value in words: a list whose entries
  // have text is drawn as the Ship card draws a brief's Ship section (a
  // dot, the entry's text, You, Now or Someone else); dots and a bar get
  // their count beside them. Never a row of bare dots or a bare bar.
  private progress(item: Item, p: Progress | null): HTMLElement | null {
    if (!p) return null;
    let done = 0, total = 0, states: string[] | null = null;
    if (p.kind === 'number') { done = Math.max(0, Math.min(100, Number(getField(item, p.field)) || 0)); total = 100; }
    else if (p.kind === 'ratio') { done = Number(getField(item, p.done)) || 0; total = Number(getField(item, p.total)) || 0; }
    else {
      const list = getField(item, p.list);
      const entries = Array.isArray(list) ? list : [];
      states = entries.map((x) => String((x && typeof x === 'object' && (x as Item).state) || 'todo'));
      done = states.filter((x) => x === 'done').length; total = states.length;
      const texts = entries.map(entryText);
      if (total && p.style === 'dots' && texts.every(Boolean)) {
        return h('div.ptasks', entries.map((_, i) => {
          const t = TASK_TAG[states![i]];
          return h(`div.ptask${t ? '.on' : states![i] === 'done' ? '.done' : ''}`, taskDot(states![i]), h('span.tx', texts[i]), t ? h('span.tg', { style: { color: `var(${t[1]})` } }, t[0]) : null);
        }));
      }
    }
    if (!total) return null;
    const words = p.kind === 'number' ? `${done}%` : `${done} of ${total}`;
    if (p.style === 'count') return h('span.pc-count.num', words);
    if (p.style === 'dots') {
      // A number is ten dots, one for each tenth.
      const marks = states || (p.kind === 'number' ? Array.from({ length: 10 }, (_, i) => (i < Math.round(done / 10) ? 'done' : 'todo')) : Array.from({ length: total }, (_, i) => (i < done ? 'done' : 'todo')));
      return h('span.pdots', h('span.ds', marks.map((st) => taskDot(st))), h('span.pc-count.num', words));
    }
    return h('span.pbarw', h('div.bar.pbar', h('div.f', { style: { width: `${Math.min(100, Math.round((done / total) * 100))}%`, background: 'var(--tx)' } })), h('span.pc-count.num', words));
  }

  private checklistEl(v: PageView, item: Item, spec: ItemSpec, sec: [number, number]): HTMLElement | null {
    if (!spec.checklist) return null;
    const boxes = (item.$boxes as { line: number; text: string; done: boolean }[] | undefined) || [];
    if (!boxes.length) return null;
    const can = spec.actions.some((a) => a.kind === 'toggle') && !this.off(v);
    return h('ul.md-ul.cl', boxes.map((b) => h(`li.md-box${b.done ? '.on' : ''}`,
      h(`button.bx${b.done ? '.on' : ''}`, { disabled: !can, 'aria-label': b.done ? 'Untick' : 'Tick', on: { click: (e: Event) => { e.stopPropagation(); void this.toggle(v, item, sec, b.line, b.text, !b.done); } } }, b.done ? svg(I.CHECK) : null),
      h('span', b.text))));
  }

  private excerpt(item: Item, field: string | null): HTMLElement | null {
    if (!field) return null;
    const t = valueText(getField(item, field)).replace(/^---[\s\S]*?---\n/, '').split('\n').map((l) => l.trim()).filter((l) => l && !/^#/.test(l)).slice(0, 3).join(' ');
    return t ? h('span.ex.t2', t.length > 220 ? t.slice(0, 217) + '...' : t) : null;
  }

  private subtitle(item: Item, spec: ItemSpec): HTMLElement | null {
    if (!spec.subtitle) return null;
    const t = valueText(getField(item, spec.subtitle));
    if (!t) return null;
    const tone = fieldTone(item, spec.subtitle);
    return h(`span.sub${tone ? `.tone-${tone}` : '.t2'}`, t);
  }

  private place(v: PageView, item: Item, spec: ItemSpec, sec: [number, number]): HTMLElement | null {
    const p = spec.place;
    if (!p) return null;
    const r = item.$ravenry as Record<string, unknown> | undefined;
    if (p === 'ravenry:plan-row' && r && r.row) return planRowEl(item, r.row as PlanRow, () => this.openItem(v, item, sec));
    if (p === 'ravenry:mockup-rounds') {
      const mk = r && (r.mockups as { round: number; picked: string | null; variants: { key: string; title: string; img: string }[] } | null);
      if (!mk) return r && r.job ? h('span.t3.small', `Drawing round ${r.job}...`) : null;
      return h('div.mk', mk.variants.map((x) => h(`div.mk-v${mk.picked === x.key ? '.on' : ''}`, { title: `Round ${mk.round}, ${x.key.toUpperCase()}: ${x.title}` }, h('img', { src: this.host.hubUrl() + x.img, alt: x.title, loading: 'lazy' }))));
    }
    return null;
  }

  // ------------------------------------------------------------ views

  private list(v: PageView, s: Section & { kind: 'core' }, d: DrawnSection, sec: [number, number]): HTMLElement {
    const spec = s.item;
    const items = d.rows;
    const objRows = spec.place === 'ravenry:objective-rows';
    const rowOf = (it: Item) => {
      const st = it.state && ['you', 'work', 'idle'].includes(String(it.state)) && !it.$hash ? String(it.state) : null;
      const pg = this.progress(it, spec.progress);
      const block = !!pg && pg.classList.contains('ptasks');
      return h('div.orow.lrow', { role: spec.detail || it.$hash ? 'button' : undefined, on: { click: () => this.openItem(v, it, sec) } },
        st ? ring(st) : null,
        h('div.lt', h('span.lti', valueText(getField(it, spec.title))), this.subtitle(it, spec), this.excerpt(it, spec.excerpt), block ? pg : null, this.checklistEl(v, it, spec, sec), objRows ? null : this.place(v, it, spec, sec)),
        this.badges(it, spec, s), block ? null : pg, this.timeEl(it, spec),
        h('div.ra', this.itemButtons(v, spec, it, sec)));
    };
    const head = s.title ? h('div.ocard-h.sec-t', s.title, h('span.num.t3', String(items.length))) : null;
    if (!items.length) return h('div.ocard', head, h('div.orow.t2.empty', s.empty || 'Nothing here.'), this.sectionActions(v, s, sec));
    if (s.groupBy && d.groups) {
      return h('div.lgroups', head, d.groups.map((g) => h('div.ocard', h('div.ocard-h.sec-t', g.value === null ? 'None' : String(g.value), h('span.num.t3', String(g.count))), rowsOf(d, g).map(rowOf))), this.sectionActions(v, s, sec));
    }
    return h('div.ocard', head, items.map(rowOf), this.sectionActions(v, s, sec));
  }

  private cards(v: PageView, s: Section & { kind: 'core' }, items: Item[], sec: [number, number]): HTMLElement {
    const spec = s.item;
    if (!items.length) return h('div.ocard', s.title ? h('div.ocard-h.sec-t', s.title) : null, h('div.orow.t2.empty', s.empty || 'Nothing here.'));
    if (spec.place === 'ravenry:objective-rows') {
      // Objectives' cards (the board's renderObjectives): one per project,
      // its goal on the line, then its objectives as rows.
      return h('div.ocards', items.map((it) => {
        const r = it.$ravenry as { rows?: ObjRow[] } | undefined;
        const st = String(it.state || 'idle');
        return h('div.ocard',
          h('div.ocard-h', ring(RING[st] ? st : 'idle'),
            h('button.linkish', { on: { click: () => this.openItem(v, it, sec) } }, valueText(getField(it, spec.title))),
            this.badges(it, spec, s), h('span.g', valueText(spec.subtitle ? getField(it, spec.subtitle) : '') || 'No goal in the brief yet'),
            this.itemButtons(v, spec, it, sec)),
          (r && r.rows && r.rows.length ? r.rows : null)?.map((row) => objRowEl(row, this.host.now(), () => this.openPlan(it))) || h('div.orow.t2.small', 'The brief has no plan yet'));
      }));
    }
    return h('div.pcards', s.title ? h('div.sec-title', s.title) : null, h('div.pgrid', items.map((it) => h('div.pcard', { on: { click: () => this.openItem(v, it, sec) } },
      this.image(v, it, spec.image, 'pimg'),
      h('div.pc-b',
        h('div.pc-t', h('span.ti', valueText(getField(it, spec.title))), this.timeEl(it, spec)),
        this.subtitle(it, spec),
        h('div.mr', this.badges(it, spec, s)),
        this.progress(it, spec.progress), this.excerpt(it, spec.excerpt), this.checklistEl(v, it, spec, sec), this.place(v, it, spec, sec),
        h('div.pc-a', this.itemButtons(v, spec, it, sec)))))), this.sectionActions(v, s, sec));
  }

  private openPlan(it: Item): void {
    // A plans item is "<project>/<title>" with both as fields; a projects item is the project.
    const project = String(it.project || String(it.id || '').split('/')[0] || '');
    const title = it.title != null && it.project ? valueText(it.title) : null;
    this.host.openPlan(project, title);
  }

  private board(v: PageView, s: Section & { kind: 'core' }, d: DrawnSection, sec: [number, number]): HTMLElement {
    const spec = s.item;
    const items = d.rows;
    const field = s.source && s.source.kind !== 'provider' ? s.source.fields[s.groupBy!] : null;
    const groups = (d.groups || []).map((g) => ({ value: g.value, items: rowsOf(d, g) }));
    const width = this.el.clientWidth - 44;
    const narrow = width > 0 && width / Math.max(1, groups.length) < 240;
    const label = (g: { value: string | null }) => (g.value === null ? 'None' : capitaliseField(g.value));
    const off = this.off(v);
    const meta = (it: Item) => h('div.mr', this.badges(it, spec, s), this.timeEl(it, spec));
    const lkey = (g: { value: string | null }) => `${v.key}|${sec.join('.')}|${g.value}`;
    if (narrow) {
      // Below about 240 px a lane: a list grouped by lane, the last folded.
      return h('div.gl', groups.map((g, i) => {
        const k = lkey(g);
        const folded = this.folded.has(k) ? this.folded.get(k)! : i === groups.length - 1 && groups.length > 1;
        return h('section.gl-g',
          h('button.gl-h', { on: { click: () => { this.folded.set(k, !folded); this.render(); } } }, label(g), h('span.cnt.num', String(g.items.length)), h('span.tg', folded ? ['Show ', svg(FOLD_IC)] : svg(OPEN_IC))),
          folded ? null : g.items.map((it) => h('div.gl-r', { role: 'button', on: { click: () => this.openItem(v, it, sec) } },
            h('div.tx', h('div.ti', valueText(getField(it, spec.title))), this.subtitle(it, spec), meta(it)),
            this.image(v, it, spec.image, 'th'))));
      }), this.sectionActions(v, s, sec));
    }
    const dragging = { file: '' };
    return h('div.lanes', groups.map((g, gi) => {
      const k = lkey(g);
      const cap = this.shown.has(k) ? Infinity : gi === groups.length - 1 && groups.length > 1 ? 3 : 12;
      const vis = g.items.slice(0, cap);
      const lane = h('section.lane', {
        'data-lane': g.value ?? '',
        on: {
          dragover: (e: Event) => { if (!off && field && g.value !== null) { e.preventDefault(); lane.classList.add('drop'); } },
          dragleave: () => lane.classList.remove('drop'),
          drop: (e: Event) => {
            e.preventDefault(); lane.classList.remove('drop');
            const it = items.find((x) => x.file === dragging.file);
            if (it && g.value !== null && String(it[s.groupBy!]) !== g.value) void this.moveTo(v, it, s.groupBy!, g.value, sec);
          },
        },
      },
      h('div.lane-h', label(g), h('span.cnt.num', String(g.items.length))),
      vis.map((it) => {
        const hov = this.hover === it.file;
        return h(`div.nt${hov ? '.hov' : ''}`, {
          draggable: !off && !!it.$hash && !!field ? 'true' : undefined, role: 'button',
          on: { click: () => this.openItem(v, it, sec), dragstart: () => { dragging.file = String(it.file); } },
        },
        this.image(v, it, spec.image, 'shot'),
        h('div.bd', h('div.ti', valueText(getField(it, spec.title))), this.subtitle(it, spec), this.excerpt(it, spec.excerpt), this.progress(it, spec.progress), meta(it), this.place(v, it, spec, sec), this.checklistEl(v, it, spec, sec),
          spec.actions.length ? h('div.acts2', this.itemButtons(v, spec, it, sec)) : null));
      }),
      g.items.length > vis.length ? h('button.more', { on: { click: () => { this.shown.add(k); this.render(); } } }, `${g.items.length - vis.length} more`) : null);
      return lane;
    }), this.sectionActions(v, s, sec));
  }

  private async moveTo(v: PageView, it: Item, field: string, value: string, sec: [number, number]): Promise<void> {
    const r = await this.post('/api/pages/item/set', { key: v.key, at: sec, file: it.file, hash: it.$hash, fields: { [field]: it[field] ?? null }, patch: { [field]: value } });
    if (r.status !== 200) this.say(v.key, String(r.body.error || 'It was not moved.'), true);
    await this.afterWrite(v.key);
  }

  private table(v: PageView, s: Section & { kind: 'core' }, items: Item[], sec: [number, number]): HTMLElement {
    const spec = s.item;
    const cols = s.columns || [{ field: spec.title, label: 'Title', align: 'start' as const }];
    const fields = s.source ? s.source.fields : null;
    const cell = (it: Item, c: { field: string }) => {
      const val = getField(it, c.field);
      const f = fields ? fields[c.field.split('.')[0]] : null;
      if (val === undefined || val === null || val === '') return '';
      if (f && f.type === 'enum') { const t = toneOf(val); return h(`span.as-tag${t ? `.tone-${t}` : ''}`, valueText(val)); }
      if (f && f.type === 'date') return timeText(val, this.host.now());
      if (typeof val === 'number') return val.toLocaleString('en-US');
      return valueText(val);
    };
    const hasActs = spec.actions.length > 0;
    return h('div.ocard', s.title ? h('div.ocard-h.sec-t', s.title) : null,
      h('table.ptable', h('thead', h('tr', cols.map((c) => h(`th${c.align === 'end' ? '.end' : ''}`, c.label)), hasActs ? h('th') : null)),
        h('tbody', items.length ? items.map((it) => h('tr', { on: { click: () => this.openItem(v, it, sec) } },
          cols.map((c, i) => h(`td${c.align === 'end' ? '.end.num' : ''}${i === 0 ? '.first' : ''}${fields && fields[c.field] && fields[c.field].type === 'date' ? '.t2.num' : ''}`, cell(it, c))),
          hasActs ? h('td.acts', this.itemButtons(v, spec, it, sec)) : null)) : h('tr', h('td.t2', { colspan: String(cols.length + 1) }, s.empty || 'Nothing here.')))),
      this.sectionActions(v, s, sec));
  }

  private stats(d: DrawnSection): HTMLElement {
    return h('div.pstats', (d.stats || []).map((st) => {
      const val = st.value;
      const shown = val === null ? 'None' : typeof val === 'string' ? timeText(val, this.host.now()) : String(val);
      return h('div.pstat', h('span.t2.l', st.label), h('span.num.v', shown), st.note ? h('span.t3.n', st.note) : null);
    }));
  }

  private documentView(v: PageView, s: Section & { kind: 'core' }, d: DrawnSection, sec: [number, number]): HTMLElement {
    const spec = s.item;
    const items = d.rows;
    if (!items.length) return h('div.ocard', h('div.orow.t2.empty', s.empty || 'Nothing here.'));
    const doc = (it: Item) => {
      const can = spec.actions.some((a) => a.kind === 'toggle') && !this.off(v);
      // The k-th box of the text is the k-th of the file (its line there).
      const boxes = (it.$boxes as { line: number }[] | undefined) || [];
      const pg = this.progress(it, spec.progress);
      const block = !!pg && pg.classList.contains('ptasks');
      return h('div.ocard.pdoc',
        h('div.ocard-h', h('span', valueText(getField(it, spec.title))), this.badges(it, spec, s), block ? null : pg, h('span.sp'),
          it.$hash || it.done !== undefined ? h('button.btn.sm.quiet', { on: { click: () => this.host.openPath(this.itemPath(v, it, sec)) } }, svg(FILE_IC), 'Open') : null),
        block ? h('div.pdoc-t', pg) : null,
        h('div.pdoc-b', markdown(valueText(it.body), can ? (k, text, done) => void this.toggle(v, it, sec, boxes[k] ? boxes[k].line : 0, text, done) : undefined)),
        h('div.pc-a', this.itemButtons(v, spec, it, sec)));
    };
    if (s.groupBy && d.groups) {
      return h('div.lgroups', d.groups.map((g) => h('div.dgroup', h('div.sec-title', g.value === null ? 'Other' : String(g.value)), rowsOf(d, g).map(doc))));
    }
    return h('div.lgroups', items.map(doc));
  }

  // ------------------------------------------------------------ Ravenry's own views

  private pluginView(v: PageView, s: Section & { kind: 'plugin' }, items: Item[], sec: [number, number]): HTMLElement {
    switch (s.view) {
      case 'ravenry:brainstorm': return this.brainstorm(v);
      case 'ravenry:memory-rules': return this.memoryRules(v, s);
      case 'ravenry:sessions': return this.sessions(v, items);
      default: return h('div.ocard', h('div.ocard-h.t2', s.title || s.view), h('div.orow.t2', `${s.view} is not something this Ravenry draws here.`));
    }
  }

  private seed = '';
  private brainstorm(v: PageView): HTMLElement {
    const off = this.off(v);
    const input = h('input.field.seed', { placeholder: 'Brainstorm: a seed, e.g. a cosy co-op game for the TV', value: this.seed, 'aria-label': 'Brainstorm seed, or a new idea' }) as HTMLInputElement;
    input.addEventListener('input', () => { this.seed = input.value; });
    // With nothing typed, the field gets the keyboard and says what goes in it (never a button that does nothing).
    const empty = () => { input.focus(); this.say(v.key, 'Type an idea, or a seed for 3 directions, first.', true); };
    const add = async () => {
      if (!this.seed.trim()) { empty(); return; }
      const r = await this.post('/api/ideas/add', { name: this.seed.trim(), stage: 'spark' });
      if (r.status !== 200) { this.say(v.key, String(r.body.error || 'Not added.'), true); return; }
      this.seed = ''; await this.afterWrite(v.key);
    };
    const go = async () => {
      if (!this.seed.trim()) { empty(); return; }
      const r = await this.post('/api/ideas/brainstorm', { seed: this.seed.trim() });
      this.say(v.key, r.status === 200 ? 'Thinking up 3 directions. They land in Spark.' : String(r.body.error || 'Not started.'), r.status !== 200);
      if (r.status === 200) this.seed = '';
    };
    return h('div.ocard.bs', h('div.bs-r', input, h('button.btn', { disabled: !!off, on: { click: () => void add() } }, 'Add idea'), h('button.btn.pri', { disabled: !!off, on: { click: () => void go() } }, 'Get 3 directions')));
  }

  private memory: { at: number; rules: { id: string; text: string; why: string; pending: boolean; localLabel: string; done?: { label: string } }[] } | null = null;
  private memoryRules(v: PageView, s: Section): HTMLElement {
    if (!this.memory || this.host.now() - this.memory.at > 60000) {
      this.memory = { at: this.host.now(), rules: this.memory ? this.memory.rules : [] };
      void this.host.call('GET', '/api/rules').then((r) => { const b = r.body as { rules?: [] }; this.memory = { at: this.host.now(), rules: b.rules || [] }; if (this.open === v.key) this.render(); });
    }
    const rules = this.memory.rules.filter((r) => r.pending);
    const decide = async (id: string, action: string) => {
      const r = await this.post(`/api/rules/${encodeURIComponent(id)}`, { action });
      this.say(v.key, r.status === 200 ? (action === 'dismiss' ? 'Remembered: not a rule.' : 'Saved.') : String(r.body.error || 'Not saved.'), r.status !== 200);
      this.memory = null; this.render();
    };
    return h('div.ocard', h('div.ocard-h.sec-t', s.title || 'From project memory', h('span.num.t3', String(rules.length))),
      rules.length ? rules.map((r) => h('div.orow.lrow', h('div.lt', h('span.lti', r.text), h('span.sub.t2', r.why)),
        h('div.ra', h('button.btn.sm.pri', { on: { click: () => void decide(r.id, 'global') } }, 'Every project'), h('button.btn.sm', { on: { click: () => void decide(r.id, 'local') } }, r.localLabel || 'This project'), h('button.btn.sm', { on: { click: () => void decide(r.id, 'dismiss') } }, 'Not a rule'))))
        : h('div.orow.t2.empty', 'Nothing to suggest from project memory.'));
  }

  private sessions(v: PageView, items: Item[]): HTMLElement {
    const idle = items.filter((x) => x.closable && ['idle', 'handed', 'left'].includes(String(x.group)));
    const close = async () => {
      const r = await this.post('/api/sessions/close', { sessionIds: idle.map((x) => x.id) });
      this.say(v.key, r.status === 200 ? `Closed ${idle.length}.` : String(r.body.error || 'Not closed.'), r.status !== 200);
    };
    return h('div.ocard', h('div.ocard-h.sec-t', 'Sessions', h('span.num.t3', String(items.length)), h('span.sp'), idle.length ? h('button.btn.sm', { on: { click: () => void close() } }, `Close idle (${idle.length})`) : null),
      items.map((it) => h('div.orow.lrow', h('div.lt', h('span.lti', valueText(it.project_name)), h('span.sub.t2', valueText(it.line))), h('span.as-tag', valueText(it.assistant)), h('span.t3.num.small', `${Math.round(Number(it.memory_kb || 0) / 1024)} MB`))));
  }

  // ------------------------------------------------------------ sheets over the page

  private drawModal(v: PageView): HTMLElement {
    const m = this.modal!;
    const shut = () => { this.modal = null; this.render(); };
    const wrap = (...c: (HTMLElement | null | (HTMLElement | null)[])[]) => h('div.pmodal', { on: { click: (e: Event) => { if (e.target === e.currentTarget) shut(); } } }, h('div.msheet', c));
    switch (m.kind) {
      case 'confirm': return wrap(h('p.mq', m.text), h('div.mb', h('button.btn', { on: { click: shut } }, 'Cancel'), h('button.btn.pri', { on: { click: () => { this.modal = null; this.render(); void m.run(); } } }, m.ok)));
      case 'link': return wrap(h('h3', 'Open this address?'), h('p.mono.url', m.url), h('div.mb', h('button.btn', { on: { click: shut } }, 'Cancel'), h('button.btn.pri', { on: { click: () => { this.host.openExternal(m.url); shut(); } } }, 'Open in the browser')));
      case 'approve': return wrap(h('h3', 'Let this page ask an agent on its own?'), h('p.mq', m.does), h('p.t2.small', 'It types and sends without showing you first. Ravenry asks again whenever the page file changes.'),
        h('div.mb', h('button.btn', { on: { click: shut } }, 'Not now'), h('button.btn.pri', { on: { click: () => { this.modal = null; this.render(); void m.run(); } } }, 'Allow for this version')));
      case 'rule': {
        const p = ((m.item.$ravenry as { preview?: Record<string, string> } | undefined)?.preview) || {};
        const save = async () => {
          const r = await this.post(`/api/repeats/${encodeURIComponent(String(m.item.id))}`, { action: String(m.item.kind) });
          this.say(v.key, r.status === 200 ? `Written to ${((r.body.target as string[]) || []).join(' and ')}.` : String(r.body.error || 'Not saved.'), r.status !== 200);
          this.modal = null; await this.afterWrite(v.key);
        };
        return wrap(h('h3', m.action.label), p.now ? h('div.pv', h('span.t3.small', p.nowLabel || 'Now'), h('p.mq.old', p.now)) : null, h('div.pv', h('span.t3.small', p.nextLabel || 'It will say'), h('p.mq', p.next || valueText(m.item.rule))),
          h('p.t2.small', `Into ${valueText(m.item.targets)}. A backup is made first.`), h('div.mb', h('button.btn', { on: { click: shut } }, 'Cancel'), h('button.btn.pri', { on: { click: () => void save() } }, 'Save')));
      }
      case 'changed': {
        const old = v.historyText || v.text;
        const rows = diffLines(old, v.defaultText || '');
        // The lines the default added, each with two around it; its
        // revision line is not news.
        const added = rows.map((r, i) => ({ ...r, i })).filter((r) => r.add && !/^revision:/.test(r.text));
        const keep = new Set<number>();
        for (const a of added) for (let j = Math.max(0, a.i - 2); j <= Math.min(rows.length - 1, a.i + 2); j++) keep.add(j);
        if (!keep.size) for (let j = 0; j < Math.min(rows.length, 6); j++) keep.add(j);
        const shown: (HTMLElement)[] = [];
        let last = -2;
        for (const j of [...keep].sort((a, b) => a - b)) {
          if (last >= 0 && j > last + 1) shown.push(h('span.r.gap', h('span.n', ''), '...'));
          shown.push(h(`span.r${rows[j].add && !/^revision:/.test(rows[j].text) ? '.add' : ''}`, h('span.n', String(j + 1)), rows[j].text || ' '));
          last = j;
        }
        const name = v.model ? v.model.title : v.id;
        const dc = v.defaultChanged!;
        const ask = async () => {
          const text = `The default ${name} page Ravenry ships changed (revision ${dc.from} to ${dc.to}). Bring its changes into my copy ${v.file}, keeping my own edits: the new default is ${v.defaultPath}. Then run ravenry page check ${v.file}.`;
          const session = this.host.lastProject();
          if (!session) { this.host.copy(text); this.say(v.key, 'No session is open to ask. The request is copied: paste it into one.'); return; }
          const r = await this.post('/api/pages/ask', { key: v.key, kind: 'merge', text, session });
          if (r.status !== 200) { this.say(v.key, String(r.body.error || 'Nothing was typed.'), true); return; }
          this.modal = null;
          this.host.pickSession(`${r.body.projectId}/${r.body.surfaceId}`);
        };
        return wrap(h('h3', `What changed in the default ${name} page`),
          h('p.t2.mq', `Your copy started from revision ${dc.from}. The default is now revision ${dc.to}. Your copy stays as it is until you change it.`),
          h('div.code', h('div.code-h', svg(FILE_IC), h('b', `ravenry/${v.id}, ${dc.from} to ${dc.to}`)),
            h('pre', shown)),
          h('div.mb', h('button.lk', { on: { click: () => { this.host.openPath(v.file); if (v.defaultPath) this.host.openPath(v.defaultPath); } } }, 'Open both files'), h('span.sp'),
            h('button.btn', { on: { click: shut } }, 'Not now'), h('button.btn.pri', { on: { click: () => void ask() } }, 'Ask Claude to bring these in')));
      }
      case 'item': {
        const s = v.model!.tabs[m.section[0]].sections[m.section[1]];
        const spec = s.kind === 'core' ? s.item : null;
        const src = s.source;
        const fields = src && src.kind !== 'provider' ? Object.values(src.fields).filter((f) => !f.builtin && f.type !== 'image') : [];
        const it = m.item;
        return wrap(h('h3', valueText(it.title || (spec ? getField(it, spec.title) : ''))),
          fields.length ? h('div.kv.ikv', fields.map((f) => [h('span', f.label), h('span', valueText(it[f.name]) || '-')])) : null,
          spec ? this.image(v, it, spec.image, 'iimg') : null,
          it.body ? h('div.pdoc-b', markdown(valueText(it.body))) : null,
          h('div.mb', it.$hash ? h('button.lk', { on: { click: () => this.host.openPath(this.itemPath(v, it, m.section)) } }, 'Open file') : null, h('span.sp'),
            spec ? this.itemButtons(v, spec, it, m.section) : null, h('button.btn', { on: { click: shut } }, 'Close')));
      }
      case 'form': {
        const fields = this.formFields(v, m.section);
        const save = async () => {
          m.busy = true; m.error = null; this.render();
          const out: Record<string, unknown> = {};
          for (const [k, f] of Object.entries(fields)) {
            const raw = m.values[k];
            if (raw === undefined || raw === '') continue;
            out[k] = f.type === 'number' ? Number(raw) : f.type === 'bool' ? raw === 'true' : f.type === 'list' ? raw.split(',').map((x) => x.trim()).filter(Boolean) : raw;
          }
          const r = await this.post('/api/pages/item/create', { key: v.key, at: m.section, action: m.at, fields: out, body: m.body });
          m.busy = false;
          if (r.status !== 200) { m.error = String(r.body.error || 'Not made.'); this.render(); return; }
          this.modal = null;
          await this.afterWrite(v.key);
        };
        return wrap(h('h3', m.action.label),
          h('div.form', Object.entries(fields).map(([k, f]) => {
            let input: HTMLElement;
            if (f.type === 'enum') input = h('select.field', { on: { change: (e: Event) => { m.values[k] = (e.target as HTMLSelectElement).value; } } }, h('option', { value: '' }, ''), (f.values || []).map((x) => h('option', { value: x, selected: m.values[k] === x }, capitaliseField(x))));
            else if (f.type === 'bool') input = h('select.field', { on: { change: (e: Event) => { m.values[k] = (e.target as HTMLSelectElement).value; } } }, h('option', { value: '' }, ''), h('option', { value: 'true', selected: m.values[k] === 'true' }, 'Yes'), h('option', { value: 'false', selected: m.values[k] === 'false' }, 'No'));
            else input = h('input.field', { type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text', value: m.values[k] || '', placeholder: f.type === 'list' ? 'Comma separated' : '', on: { input: (e: Event) => { m.values[k] = (e.target as HTMLInputElement).value; } } });
            return h('label.fr', h('span', f.label, f.required || k === 'title' ? h('span.t3', ' (needed)') : null), input);
          }),
          h('label.fr', h('span', 'Text'), h('textarea.field.ta', { on: { input: (e: Event) => { m.body = (e.target as HTMLTextAreaElement).value; } } }, m.body))),
          m.error ? h('p.err', m.error) : null,
          h('div.mb', h('span.sp'), h('button.btn', { on: { click: shut } }, 'Cancel'), h('button.btn.pri', { disabled: m.busy, on: { click: () => void save() } }, m.action.label)));
      }
    }
  }
}

// ---------------------------------------------------------------- Objectives' pieces (the board's objRow, planRow)

interface PlanRow { dots: string[]; count: string; next: { cls: string; text: string }; wash: string }
type ObjRow =
  | ({ kind: 'plan'; title: string } & PlanRow)
  | { kind: 'tasks'; title: string; plan: boolean; tasks: { text: string; state: string }[]; count: string; next: string }
  | { kind: 'file'; title: string; done: number; total: number; count: string; updated: string | null; source: string | null }
  | { kind: 'none'; title: string; plan: boolean };

// The words beside a task's dot (public/app.js taskDot's tag).
const TASK_TAG: Record<string, [string, string]> = { you: ['You', '--you'], now: ['Now', '--work'], wait: ['Someone else', '--wait'] };
const entryText = (x: unknown): string => (x && typeof x === 'object' ? valueText((x as Item).text ?? (x as Item).title ?? (x as Item).name) : typeof x === 'string' ? x : '');

// An item's state ring says its state when pointed at and to a screen
// reader, in the sidebar's words for the same ring.
const RING_WORD: Record<string, string> = { you: 'Needs you', work: 'Working', idle: 'Idle', wait: 'Waiting on others' };
function ring(st: string): HTMLElement {
  return h('span.sti', { class: `c-${st}`, title: RING_WORD[st], role: 'img', 'aria-label': RING_WORD[st] }, svg(RING[st]));
}

function taskDot(st: string): HTMLElement {
  const style = { done: 'background:var(--ok)', now: 'background:var(--work)', you: 'border:2px solid var(--you)', wait: 'border:2px dashed var(--wait)' }[st] || 'border:1.5px solid var(--idle)';
  return h('span.dot', { style });
}

/** A plan step's mark in the row (public/plan-view.js rowModel dots). */
function rowDot(c: string): HTMLElement | Element {
  if (c === 'g') return svg('<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.2L15.8 9 9 15.8 2.2 9z" fill="none" style="stroke:var(--idle)" stroke-width="2"/></svg>');
  if (c === 'G') return svg('<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.2L15.8 9 9 15.8 2.2 9z" style="fill:var(--you-t);stroke:var(--you)" stroke-width="2"/></svg>');
  if (c === 'Gd') return svg('<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 1.2L16.8 9 9 16.8 1.2 9z" style="fill:var(--ok)"/></svg>');
  if (c === 'b' || c === 'bt') return svg(`<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 15V10M9 10L5 4.5M9 10l4-5.5" fill="none" style="stroke:var(${c === 'b' ? '--ok' : '--idle'})" stroke-width="2" stroke-linecap="round"/></svg>`);
  return taskDot({ x: 'done', n: 'now', y: 'you', s: 'skip' }[c] || 'todo');
}

function objRowEl(r: ObjRow, now: number, openPlan: () => void): HTMLElement {
  if (r.kind === 'plan') {
    return h(`div.orow${r.wash ? '.gate' : ''}`, h('span.ot', h('span.pl-label', 'Plan'), h('span', r.title)), h('div.ds', r.dots.map(rowDot)), h('span.cn.num', r.count),
      h('span.nx', h(`span.${r.next.cls || 'n0'}`, r.next.text), h('button.lk', { on: { click: openPlan } }, 'Open the plan')));
  }
  if (r.kind === 'tasks') {
    return h('div.orow', h('span.ot', r.plan ? h('span.pl-label', 'Plan') : null, h('span', r.title)), h('div.ds', r.tasks.map((t) => { const d = taskDot(t.state); d.title = t.text; return d; })), h('span.cn.num', r.count), h('span.nx', r.next));
  }
  if (r.kind === 'file') {
    const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    return h('div.orow', h('span.ot', h('span', r.title)), h('div.bar', h('div.f', { style: { width: `${pct}%`, background: 'var(--tx)' } })), h('span.cn.num', r.count), h('span.nx', r.updated ? `updated ${agoText(r.updated, now)}` : r.source || ''));
  }
  return h('div.orow', h('span.ot', h('span', r.title)), h('span.t2.small', 'Not broken into tasks yet'));
}

// The row's own buttons (the page's Open the plan) open it.
function planRowEl(_item: Item, r: PlanRow, _open: () => void): HTMLElement {
  return h(`div.prow${r.wash ? '.gate' : ''}`, h('div.ds', r.dots.map(rowDot)), h('span.cn.num', r.count), h('span.nx', h(`span.${r.next.cls || 'n0'}`, r.next.text)));
}

function objectivesLegend(): HTMLElement {
  const it = (dot: HTMLElement | Element, t: string) => h('span', dot, t);
  return h('div.legend2',
    it(taskDot('done'), 'Done'), it(taskDot('now'), 'In progress'), it(taskDot('you'), 'Waiting on you'), it(taskDot('wait'), 'Waiting on others'), it(taskDot('todo'), 'To do'),
    it(rowDot('G'), 'Gate: asks you'), it(svg('<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 15V10M9 10L5 4.5M9 10l4-5.5" fill="none" style="stroke:var(--tx2)" stroke-width="2" stroke-linecap="round"/></svg>'), 'Branch'));
}

/** What a page's items are called: its New button's word (New note: notes), else files. */
function noun(m: Page, n: number): string {
  const make = m.actions.find((a) => a.kind === 'create');
  const w = make ? (make.label.match(/^New (\w+)$/i) || [])[1] : null;
  if (!w) return n === 1 ? 'file' : 'files';
  const one = w.toLowerCase();
  return n === 1 ? one : one.endsWith('s') ? one : `${one}s`;
}

// "Runs npm run build:tiles in ~/code/trail-map, ..." with the command set apart.
function wouldText(does: string): (string | HTMLElement)[] {
  const m = does.match(/^Runs (.+?) in (.+)$/);
  return m ? ['Runs ', h('span.mono', m[1]), ` in ${m[2]}`] : [does];
}

async function sha256(text: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export type { Tab };
