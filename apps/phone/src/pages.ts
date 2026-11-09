// The sidebar's pages on the phone, drawn by the desktop's own pages code
// (apps/desktop/src/renderer/pages.ts) inside .pgx, so a page shows, writes
// and asks exactly as on the computer: item buttons and the create form,
// the board as the grouped list on a narrow screen, the problem bar with
// Open file and Ask Claude to fix, the trust bar, Customize and "changed
// since your copy". The phone adds what a finger needs (the pages'
// phone frames, picked: the grouped list):
//
//   - a tap on a note opens it as a sheet with its buttons at the bottom
//     (the desktop's item sheet, drawn from the bottom);
//   - a long press on a note offers Move to, one line per lane;
//   - a page's create button is the round button at the bottom right;
//   - Open file shows the page file's own text, the problem's line marked:
//     the file is on the computer.

import { h, replace, svg } from '../../desktop/src/renderer/dom.ts';
import { Pages } from '../../desktop/src/renderer/pages.ts';
import type { NavRow, PagesHost, PageView } from '../../desktop/src/renderer/pages.ts';
import { capitaliseField } from '../../desktop/src/renderer/pagefmt.ts';
import type { Item, Section } from '../../desktop/src/renderer/pagefmt.ts';
import * as I from './icons.ts';
import { sayPathOn } from '../../../hub/public/homepath.mjs';
import * as hub from './hub.ts';
import { current } from './shell.ts';
import { appBar, views } from './sessions.ts';
import { back, go, sheet, toast } from './main.ts';
import type { Screen } from './main.ts';
import { t } from './strings.ts';

const navRows = (): NavRow[] => ((hub.live.state as unknown as { pages?: NavRow[] } | null)?.pages || []);
let lastProject: string | null = null;
export function sawProject(id: string): void { lastProject = id; }

let pages: Pages | null = null;
let pageEl: HTMLElement | null = null;

function host(): PagesHost {
  return {
    hubUrl: () => 'hub',
    call: async (method, p, body) => { const r = await hub.call(method, p, body); return { status: r.status, body: r.body }; },
    toast: (text: string, undo?: { label: string; run: () => void }) => toast(text, undo),
    pickSession: (key: string) => go(`/s/${encodeURIComponent(key)}`),
    openPage: (key: string) => go(`/p/${encodeURIComponent(key)}`),
    pickProject: (name: string) => {
      const p = (hub.live.state?.projects || []).find((x) => x.id === name || x.name === name);
      const s = p && (p.sessions.find((x) => x.surfaceId === p.primary) || p.sessions[0]);
      if (!p || !s) return false;
      go(`/s/${encodeURIComponent(`${p.id}/${s.surfaceId}`)}`);
      return true;
    },
    lastProject: () => lastProject,
    openBoard: (hash: string) => {
      // The board's own screens: a plan opens the Plans page, an idea the Ideas page.
      const to = /^#\/plan\//.test(hash) ? 'plans' : /#\/ideas/.test(hash) ? 'ideas' : null;
      const r = to ? navRows().find((x) => x.id === to && x.origin !== 'project') : null;
      if (r) go(`/p/${encodeURIComponent(r.key)}`);
      else toast('That opens on the computer.');
    },
    openPath: (p: string) => showFile(p),
    openExternal: (url: string) => { window.open(url, '_blank', 'noopener'); },
    copy: (text: string) => { void navigator.clipboard.writeText(text).catch(() => {}); },
    showCheckpoint: (cp: { id: string }) => go(`/cp/${encodeURIComponent(cp.id)}`),
    rerender: () => { if (pages && pages.open) pages.render(); },
    now: () => Date.now(),
  } as PagesHost;
}

/** The pages, kept for the whole visit so a page's cache, tabs and folded lanes survive. */
function thePages(): Pages {
  if (!pages) {
    pageEl = h('div.pgx.pgphone');
    pages = new Pages(pageEl, host());
    hub.watch(() => pages!.update(navRows()));
  }
  pages.update(navRows());
  return pages;
}

/** Open file on a phone: the page file's own text, its problem's line marked. */
function showFile(p: string): void {
  const key = pages?.open;
  const v = key ? pages!.cache.get(key)?.view : null;
  if (!v || (p !== v.file && p !== v.defaultPath)) { toast(`That file is on ${current().hello.hub.name}: ${sayPathOn(p, null, hub.live.state?.homes)}`); return; }
  const text = p === v.file ? v.text : v.defaultText || '';
  const err = p === v.file ? v.problems.find((x) => x.severity === 'error') : null;
  const lines = text.split('\n');
  const el = h('div.sheet-bg', { on: { click: (e: Event) => { if (e.target === e.currentTarget) el.remove(); } } },
    h('div.sheet.file',
      h('div.sheet-t', h('span.mono', p.split('/').pop() || p), h('button.icon-btn', { 'aria-label': 'Close', on: { click: () => el.remove() } }, svg(I.X18))),
      h('div.fpath.mono', sayPathOn(p, null, hub.live.state?.homes)),
      h('pre.ftext', lines.map((l, i) => h(`span.r${err && err.line === i + 1 ? '.bad' : ''}`, h('span.n', String(i + 1)), l || ' ')))));
  document.body.appendChild(el);
  const bad = el.querySelector('.r.bad') as HTMLElement | null;
  if (bad) bad.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------- long press: Move to

/** The core board sections of the tab on screen (the one the hub drew), in the order the page draws them. */
function boardSections(v: PageView): { s: Section & { kind: 'core' }; ti: number; si: number }[] {
  const m = v.model;
  if (!m || !v.drawn) return [];
  const ti = Math.min(v.drawn.tab, m.tabs.length - 1);
  const out: { s: Section & { kind: 'core' }; ti: number; si: number }[] = [];
  m.tabs[ti].sections.forEach((s, si) => { if (s.kind === 'core' && s.view === 'board' && s.groupBy) out.push({ s: s as Section & { kind: 'core' }, ti, si }); });
  return out;
}

/** The note under a long press on the grouped list, and where it sits. */
function noteAt(target: HTMLElement): { v: PageView; item: Item; field: string; values: string[]; at: [number, number] } | null {
  const P = pages;
  const key = P?.open;
  const v = key ? P!.cache.get(key)?.view : null;
  const row = target.closest('.gl-r') as HTMLElement | null;
  if (!P || !v || !row) return null;
  const gl = row.closest('.gl')!;
  const lists = [...pageEl!.querySelectorAll('.gl')];
  const secs = boardSections(v);
  const sec = secs[lists.indexOf(gl)];
  if (!sec) return null;
  const g = row.closest('.gl-g')!;
  const gi = [...gl.querySelectorAll('.gl-g')].indexOf(g);
  const ri = [...g.querySelectorAll('.gl-r')].indexOf(row);
  // The lanes as the hub drew them, so the row pressed is the row shown.
  const d = v.drawn!.sections[sec.si];
  const src = sec.s.source && sec.s.source.kind !== 'provider' ? sec.s.source : null;
  const field = src ? src.fields[sec.s.groupBy!] : null;
  const groups = (d && d.groups) || [];
  const at = groups[gi]?.rows[ri];
  const item = at === undefined ? null : d.rows[at];
  if (!item || !field || !item.$hash) return null;
  const values = field.type === 'enum' && field.values ? field.values.map(String) : groups.map((x) => x.value).filter((x): x is string => x !== null);
  return { v, item, field: sec.s.groupBy!, values, at: [sec.ti, sec.si] };
}

function wireLongPress(el: HTMLElement): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let start = { x: 0, y: 0 };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.gl-r')) return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => { fired = true; void moveTo(t); }, 480);
  });
  el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => { if ((e.target as HTMLElement).closest('.gl-r')) e.preventDefault(); });
  // The tap that ends a long press does not open the note too.
  el.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
}

async function moveTo(target: HTMLElement): Promise<void> {
  const n = noteAt(target);
  if (!n) return;
  const { v, item, field } = n;
  if (v.trust && v.trust.state !== 'trusted') { toast('Off until you trust this page.'); return; }
  const now = String(item[field] ?? '');
  const i = await sheet('Move to', n.values.map((x) => ({ label: capitaliseField(x), on: x === now })));
  if (i === null || n.values[i] === now) return;
  const to = n.values[i];
  const r = await hub.call('POST', '/api/pages/item/set', { key: v.key, at: n.at, file: item.file, hash: item.$hash, fields: { [field]: item[field] ?? null }, patch: { [field]: to } });
  if (r.status !== 200) toast(String(r.body.error || t('page.notMoved')));
  else toast(`Moved to ${capitaliseField(to)}.`);
  await pages!.load(v.key);
}

// ---------------------------------------------------------------- the screens

/** The page's own buttons a phone keeps behind the menu (Open file, Customize), then every page. */
async function pageMenu(): Promise<void> {
  const btns = [...pageEl!.querySelectorAll('.pg-h > .btn:not(.pri)')] as HTMLButtonElement[];
  const usable = btns.filter((b) => !b.disabled);
  const i = await sheet(null, usable.map((b) => ({ label: (b.textContent || '').trim() })));
  if (i !== null) usable[i].click();
}

export function pageScreen(key: string): Screen {
  const P = thePages();
  const row = navRows().find((r) => r.key === key);
  if (row && row.projectId) sawProject(row.projectId);
  // A page in the switch keeps the switch above it, as Plans and Ideas do
  // in the picture; one opened before the board said which pages it has
  // (a link) gets the back bar of the page frame until it knows.
  const backBar = () => h('header.sh.pgtop',
    h('button.icon-btn.fg', { 'aria-label': 'Back', on: { click: back } }, svg(I.ARROW_BACK)),
    h('span.pgt', 'Page'), h('span.sp'),
    h('button.icon-btn', { 'aria-label': 'More', on: { click: () => void pageMenu() } }, svg(I.KEBAB)));
  const inSwitch = () => navRows().some((r) => r.key === key);
  const head = h('div.pghead');
  const el = h('div.scr.page', head, pageEl!);
  if (!pageEl!.dataset.wired) { wireLongPress(pageEl!); pageEl!.dataset.wired = '1'; }
  P.show(key);
  const update = () => {
    const r = navRows().find((x) => x.key === key);
    if (r && r.projectId) sawProject(r.projectId);
    el.classList.toggle('backmode', !inSwitch());
    if (inSwitch()) replace(head, appBar(), views(key));
    else if (!head.querySelector('.pgtop')) replace(head, backBar());
  };
  update();
  return { el, update, dispose: () => { P.close(); } };
}
