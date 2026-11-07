// Who drives a pane, as the window shows it:
// - 6 C: the pane's panel, "Who can type here" (you always; an agent asks
//   each time unless the person let it for its session, which they can
//   take back here) and "Typed here", the pane's input log.
// - 19 A: the strip across the top of a lent pane (who has it since when,
//   who waits, Hand it to... and Take it back), the badge on its tab, and
//   "Panes it uses" in a session's panel.
// The data is the daemons' (panes.ts).

import type { Grant, InputRecord, Source } from '@ravenry/client';
import { h, svg } from './dom.ts';
import * as I from './icons.ts';
import { inputParts, sameSource } from './panes.ts';
import type { Known, PaneStore } from './panes.ts';

export interface Who {
  /** "You", "Claude", "Codex", or a program's name. */
  who: string;
  /** The session it runs in, as the sidebar names it. */
  where: string | null;
  /** Its colour: claude, codex, other; you for the person. */
  cls: string;
}

export interface PaneCtx {
  store: PaneStore;
  now(): number;
  /** Who a Source is, as people know it. */
  source(src: Source): Who;
  /** A pane as the tabs name it ("dev server"). */
  paneName(pane: string): string;
  /** "17:41". */
  time(iso: string | undefined): string;
  /** The agents of the sessions this window shows, by the pane they run in. */
  agents(): { pane: string; who: Who }[];
  /** A drive the person answered that let this input through, said as "You let it, once, at 17:41". */
  letNote(pane: string, r: InputRecord): string | null;
  toast(text: string): void;
  rerender(): void;
}

interface UI { filter: 'all' | 'agents' | 'you'; whole: boolean }
const uis = new Map<string, UI>();
const ui = (pane: string): UI => { let u = uis.get(pane); if (!u) { u = { filter: 'all', whole: false }; uis.set(pane, u); } return u; };

/** "Opened by you, 16:58, in paper-boat". */
export function openedLine(k: Known, ctx: PaneCtx, project: string | null): HTMLElement {
  const c = k.pane.creator;
  const by = !c || c.kind === 'person' ? 'you' : ctx.source(c).who;
  const at = ctx.time(k.pane.created_at);
  return h('div.p-org', svg(I.SHELL), `Opened by ${by}${at ? `, ${at}` : ''}${project ? `, in ${project}` : ''}`);
}

/** 6 C: who can type here. */
export function whoCanType(pane: string, ctx: PaneCtx): HTMLElement {
  const k = ctx.store.get(pane);
  const grants = ctx.store.grantsOf(pane);
  const creator = k?.pane.creator;
  const seen = new Set<string>();
  const rows: HTMLElement[] = [h('span.who-n', h('span.nm', h('span', 'You'))), h('span.who-v', 'Always')];
  const add = (src: Source, who: Who) => {
    const key = src.kind === 'agent' ? `a:${src.pane}` : `c:${src.client}`;
    if (seen.has(key) || src.kind === 'person') return;
    seen.add(key);
    const own = !!creator && sameSource(creator, src);
    const g = grants.find((x) => sameSource(x.agent, src) && (!x.action || x.action === 'input'));
    rows.push(h('span.who-n', h(`span.sd`, { style: { background: `var(--${who.cls === 'claude' || who.cls === 'codex' ? 'work' : 'idle'})` } }), h('span.nm', h('span', who.who), who.where ? h('span', who.where) : null)));
    if (own) rows.push(h('span.who-v', 'Its own pane'));
    else rows.push(choice(pane, g || null, ctx));
  };
  if (creator && creator.kind !== 'person') add(creator, ctx.source(creator));
  for (const g of grants) add(g.agent, ctx.source(g.agent));
  for (const a of ctx.agents()) if (a.pane !== pane) add({ kind: 'agent', pane: a.pane }, a.who);
  return h('div.sec',
    h('div.sec-h', 'Who can type here'),
    h('div.who-g', rows),
    h('p.t3.small', 'Panes an agent opens are its own; it types there without asking.'));
}

function choice(pane: string, g: Grant | null, ctx: PaneCtx): HTMLElement {
  const label = g ? 'Can type' : 'Asks each time';
  const sel = h('select', { 'aria-label': 'Who can type here', on: {
    change: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v === 'ask' && g) void ctx.store.revoke(pane, g.id).then(() => ctx.toast('It asks each time again.'), (err: Error) => ctx.toast(`Could not take it back: ${err.message}`));
    },
  } },
  h('option', { value: 'ask', selected: !g }, 'Asks each time'),
  h('option', { value: 'session', selected: !!g, disabled: !g }, g ? 'Can type until its session ends' : 'Can type (it asks first)')) as HTMLSelectElement;
  return h('span.sel-b', label, svg(I.DOWN), sel);
}

/** 6 C: what was typed here, newest first. */
export function typedHere(pane: string, ctx: PaneCtx): HTMLElement {
  const u = ui(pane);
  const all = ctx.store.inputsOf(pane);
  const list = all.filter((r) => (u.filter === 'all' ? true : u.filter === 'you' ? r.source.kind === 'person' : r.source.kind !== 'person')).slice().reverse();
  const shown = u.whole ? list.slice(0, 200) : list.slice(0, 4);
  const seg = (f: UI['filter'], label: string) => h(`button${u.filter === f ? '.on' : ''}`, { on: { click: () => { u.filter = f; ctx.rerender(); } } }, label);
  return h('div.sec',
    h('div.sec-h', 'Typed here', h('span.sp'), h('div.seg3', seg('all', 'All'), seg('agents', 'Agents'), seg('you', 'You'))),
    shown.length ? h('div.tlog', shown.map((r) => record(pane, r, ctx))) : h('p.t3.small', all.length ? 'Nothing from them yet.' : 'Nothing typed here since it opened.'),
    list.length > 4 ? h('button.lk.self', { on: { click: () => { u.whole = !u.whole; ctx.rerender(); } } }, u.whole ? 'Show the last few' : 'Open the whole log') : null);
}

function record(pane: string, r: InputRecord, ctx: PaneCtx): HTMLElement {
  const person = r.source.kind === 'person';
  const w = person ? { who: 'You', where: null, cls: 'you' } : ctx.source(r.source);
  const note = person ? (r.lease_holder ? `While ${ctx.source(r.lease_holder).who} had it` : null) : ctx.letNote(pane, r);
  const parts = r.masked && !r.text ? [{ kind: 'text' as const, text: 'Hidden: a password or a secret' }] : inputParts(r.text);
  return h('div.tl',
    h('span.tl-t.num', ctx.time(r.at)),
    h('div.wh', h(`span.${w.cls}`, w.who), w.where ? h('span.as-tag', w.where) : null),
    h('div.tx', parts.map((p) => (p.kind === 'key' ? h('span.key', p.text) : h('span', p.text))), r.truncated ? h('span.t3', '...') : null),
    note ? h('div.tl-n', note) : null);
}

/** Who holds a pane and who waits, for people. */
export function leaseWords(pane: string, ctx: PaneCtx): { holder: Who; since: string; waiting: Who[] } | null {
  const l = ctx.store.leaseOf(pane);
  if (!l || l.holder.kind === 'person') return null;
  return { holder: ctx.source(l.holder), since: ctx.time(l.acquired_at), waiting: (l.waiting || []).map((w) => ctx.source(w)) };
}

/** 19 A: the strip across the top of a lent pane. */
export function leaseStrip(pane: string, ctx: PaneCtx): HTMLElement | null {
  const w = leaseWords(pane, ctx);
  if (!w) return null;
  const next = w.waiting[0];
  const busy = { on: false };
  const act = (takeBack: boolean) => async () => {
    if (busy.on) return;
    busy.on = true;
    try {
      await ctx.store.release(pane, takeBack);
      ctx.toast(takeBack ? `${ctx.paneName(pane)} is yours again.` : `${next ? next.who : 'The next one'} has ${ctx.paneName(pane)} now.`);
    } catch (e) { ctx.toast(`Could not do that: ${(e as Error).message}`); } finally { busy.on = false; }
  };
  const waits = w.waiting.length ? ` ${w.waiting.map((x) => x.who).join(' and ')} ${w.waiting.length > 1 ? 'are' : 'is'} waiting for it.` : '';
  return h('div.lstrip', svg(I.HOLDS),
    h('div.lt', h('b', w.holder.who), w.holder.where ? `, in ${w.holder.where},` : '', ` has this pane since ${w.since}.${waits} What you type still goes in, marked as yours.`),
    next ? h('button.btn.sm', { on: { click: act(false) } }, `Hand it to ${next.who}`) : null,
    h('button.btn.sm', { on: { click: act(true) } }, 'Take it back'));
}

/** 19 A: the panes a session's agent uses, its own and the ones lent to it. */
export function panesItUses(agentPane: string, ctx: PaneCtx): HTMLElement | null {
  const used = ctx.store.usedBy(agentPane);
  if (!used.length) return null;
  const rows: HTMLElement[] = [];
  const waits: HTMLElement[] = [];
  for (const { k, how } of used) {
    const name = ctx.paneName(k.pane.id);
    rows.push(h('span.pu-n', svg(I.SHELL), name), how === 'own' ? h('span.pu-v', 'Its own') : h('span.pu-v.lent', 'Yours, lent'));
    const l = how === 'lent' ? ctx.store.leaseOf(k.pane.id) : null;
    const next = l && l.waiting && l.waiting[0] ? ctx.source(l.waiting[0]) : null;
    if (next) {
      waits.push(h('div.pu-w', h('span', `${next.who} is waiting for the ${name}.`), h('button.btn.sm', { on: { click: () => { void ctx.store.release(k.pane.id, false).then(() => ctx.toast(`${next.who} has the ${name} now.`), (e: Error) => ctx.toast(`Could not hand it over: ${e.message}`)); } } }, 'Hand it over')));
    }
  }
  return h('div.sec', h('div.sec-h', 'Panes it uses'), h('div.pu', rows), waits);
}
