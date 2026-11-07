// A project's brief in the window: its Next step as at most three short
// items for the panel's card (H1), and the whole brief as a page in the
// middle (H2), read from the file as written (the hub's /api/brief).
// The design: scratchpad picture ravenry-brief.html, approved 2026-11-07.
//
// A brief's Next step should be at most three short bullets
// (hub/docs/BRIEF-FORMAT.md). An older one is a paragraph that grew a
// dated entry per session ("2026-11-06: Released 0.3.0. ... Next: the
// header, then pricing, then ship 0.3.1. 2026-11-05: ..."): it is split at
// each date, newest first. The card's items come from the newest entry.
//
// The Markdown is drawn as DOM nodes, never as HTML: a brief is text an
// agent wrote.

import { h, svg } from './dom.ts';

const RIGHT = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2l4 4-4 4"/></svg>';
const DOWN = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5l4 4 4-4"/></svg>';
const TICK = '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.2l2 2 4-4.4" stroke="#FFF" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Where a dated entry starts: a date at a line's start or after a sentence, then ":" or ")". */
const DATE_AT = /(^|\n|(?<=[.!?]\s))\s*[-*]?\s*(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2})?\s*[:)–-]\s*/g;

export interface Entry { date: string; text: string }

/** A Next step split at each date, newest first; none when it has fewer than two. */
export function datedEntries(next: string): Entry[] {
  const marks = [...next.matchAll(DATE_AT)];
  if (marks.length < 2) return [];
  const out: Entry[] = [];
  marks.forEach((m, i) => {
    const start = (m.index || 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index || next.length : next.length;
    const text = next.slice(start, end).replace(/\s+/g, ' ').trim();
    if (text) out.push({ date: m[2], text });
  });
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Markdown's marks off a line: what a person reads. */
export function plain(s: string): string {
  return s.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^\[[ xX>?~-]\]\s+/, '').trim();
}

// A sentence ends at . ! or ? followed by a space ("0.3.0" and "lumen.app" are not ends).
const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const tidy = (s: string) => { const t = plain(s).replace(/[.;,]\s*$/, '').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

/** The items after "Next:" in a text: "a, then b, then c" is three. */
function nextList(t: string): string[] | null {
  const m = /\bNext(?: step)?:\s*(.+)$/i.exec(t);
  if (!m) return null;
  return m[1].split(/,?\s+(?:and\s+)?then\s+|;\s+/i).map(tidy).filter(Boolean);
}

/** The panel card's Next: at most three one-line items, and how many older dated entries the brief holds. */
export function nextItems(next: string | null | undefined): { items: string[]; older: number } {
  const text = String(next || '').trim();
  if (!text) return { items: [], older: 0 };
  const entries = datedEntries(text);
  if (entries.length) {
    const top = entries[0].text;
    return { items: (nextList(top) || sentences(top).map(tidy)).slice(0, 3), older: entries.length - 1 };
  }
  const bullets = text.split('\n').filter((l) => /^[-*+]\s+/.test(l)).map((l) => tidy(l.replace(/^[-*+]\s+/, '')));
  if (bullets.length) return { items: bullets.slice(0, 3), older: 0 };
  return { items: (nextList(text.replace(/\s+/g, ' ')) || sentences(text.replace(/\s+/g, ' ')).map(tidy)).slice(0, 3), older: 0 };
}

// ---------------------------------------------------------------- the page

export interface DocOpts {
  /** A link was clicked: an absolute http, https or file URL. */
  onLink(url: string): void;
  /** The brief's folder, for relative links. */
  dir: string;
}

const URL_RE = /\b(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;

/** One line's inline Markdown: `code`, **bold**, *em*, [text](url), bare URLs. */
function inline(s: string, o: DocOpts): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])[*_]([^*_\s][^*_]*)[*_](?![\w*])/g;
  let at = 0;
  const text = (t: string) => {
    // Bare URLs in plain text.
    let rest = t;
    for (;;) {
      const m = URL_RE.exec(rest);
      if (!m) { if (rest) out.push(rest); break; }
      if (m.index) out.push(rest.slice(0, m.index));
      out.push(link(m[1], m[1], o));
      rest = rest.slice(m.index + m[1].length);
    }
  };
  for (const m of s.matchAll(re)) {
    text(s.slice(at, m.index));
    if (m[1] != null) out.push(h('code', m[1]));
    else if (m[2] != null) out.push(h('b', m[2]));
    else if (m[3] != null) out.push(link(m[3], m[4], o));
    else if (m[5] != null) out.push(h('em', m[5]));
    at = (m.index || 0) + m[0].length;
  }
  text(s.slice(at));
  return out;
}

function link(label: string, href: string, o: DocOpts): HTMLElement {
  let url = href;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) url = 'file://' + encodeURI(href.startsWith('/') ? href : `${o.dir.replace(/\/$/, '')}/${href}`);
  const ok = /^(https?|file):\/\//i.test(url);
  return h('a', { href: '#', title: url, on: { click: (e: Event) => { e.preventDefault(); if (ok) o.onLink(url); } } }, label);
}

const TASK = /^\[([ xX>?~-]|now|you|wait)\]\s+/;
const DONE = new Set(['x', 'X', '-']);

interface Item { indent: number; text: string }

/** A list's items as nested ul (or a checklist when its items have marks). */
function list(items: Item[], o: DocOpts): HTMLElement {
  const base = items[0].indent;
  const tasks = items.some((x) => x.indent === base && TASK.test(x.text));
  const ul = h(tasks ? 'ul.chkl' : 'ul');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.indent > base) continue;
    const kids: Item[] = [];
    for (let j = i + 1; j < items.length && items[j].indent > base; j++) kids.push(items[j]);
    const m = TASK.exec(it.text);
    const body = m ? it.text.slice(m[0].length) : it.text;
    const mark = m ? m[1] : null;
    const li = h('li', mark != null ? h(`i.cb${DONE.has(mark) ? '.on' : mark === '>' || mark === 'now' ? '.now' : mark === '?' || mark === 'you' ? '.you' : ''}`, DONE.has(mark) ? svg(TICK) : null) : null,
      h(`span${mark && DONE.has(mark) ? '.dn' : ''}`, ...inline(body, o)));
    if (kids.length) li.append(list(kids, o));
    ul.append(li);
  }
  return ul;
}

/** Blocks of Markdown lines: paragraphs, lists, code, ### headings. */
function blocks(lines: string[], o: DocOpts): HTMLElement[] {
  const out: HTMLElement[] = [];
  let para: string[] = [];
  let items: Item[] = [];
  const flush = () => {
    if (para.length) { out.push(h('p', ...inline(para.join(' '), o))); para = []; }
    if (items.length) { out.push(list(items, o)); items = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(h('pre', h('code', code.join('\n'))));
      continue;
    }
    const hd = /^(#{3,6})\s+(.*)$/.exec(l);
    if (hd) { flush(); out.push(h('h3', ...inline(hd[2], o))); continue; }
    const li = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/.exec(l);
    if (li) { if (para.length) { const p = para; para = []; out.push(h('p', ...inline(p.join(' '), o))); } items.push({ indent: li[1].replace(/\t/g, '  ').length, text: li[2] }); continue; }
    if (!l.trim()) { flush(); continue; }
    if (items.length && /^\s{2,}\S/.test(l)) { items[items.length - 1].text += ' ' + l.trim(); continue; }
    if (items.length) flush();
    para.push(l.trim());
  }
  flush();
  return out;
}

const chevron = (open: boolean) => h('span.oe-c', svg(open ? DOWN : RIGHT));

/** A legacy Next step: its dated entries, newest first and open, the others one line each. */
function entries(list: Entry[], o: DocOpts): HTMLElement {
  const box = h('div.olds');
  const row = (e: Entry, open: boolean): HTMLElement => {
    const ss = sentences(e.text);
    const el = h(`div.oe${open ? '.open' : ''}`);
    const head = h('div.oe-r', { role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false', on: { click: () => el.replaceWith(row(e, !open)) } },
      chevron(open), h('span.dt', e.date), h('span.t', ...inline(open ? ss[0] || e.text : e.text, o)));
    el.append(head);
    if (open && ss.length > 1) el.append(h('div.oe-b', h('ul', ...ss.slice(1).map((x) => h('li', ...inline(x, o))))));
    return el;
  };
  list.forEach((e, i) => box.append(row(e, i === 0)));
  return box;
}

const FIELDS: [RegExp, string][] = [[/^goal:\s*/i, 'Goal'], [/^done means:\s*/i, 'Done means'], [/^kind:\s*/i, 'Kind'], [/^stage:\s*/i, 'Stage'], [/^waiting on:\s*/i, 'Waiting on']];

/** The brief as a page: its sections in order, the Next step's dated entries split, the plan's count. */
export function briefPage(md: string, o: DocOpts): HTMLElement {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const page = h('div.md');
  // Before the first section: the Key: value fields (the title and the status line are the header's).
  let i = 0;
  for (; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const l = lines[i].trim();
    const f = FIELDS.find(([re]) => re.test(l));
    if (f) page.append(h('h2', f[1]), h('p', ...inline(l.replace(f[0], ''), o)));
  }
  while (i < lines.length) {
    const name = lines[i].replace(/^##\s+/, '').trim();
    const body: string[] = [];
    for (i++; i < lines.length && !/^##\s/.test(lines[i]); i++) body.push(lines[i]);
    const key = name.toLowerCase();
    const head = h('h2', ...inline(name, o));
    if (key === 'next step' || key === 'next') {
      const es = datedEntries(body.join('\n'));
      if (es.length) { head.append(h('span.c', `split into ${es.length} dated entries, newest first`)); page.append(head, entries(es, o)); continue; }
    }
    if (key === 'plan') {
      const tasks = body.filter((l) => /^\s*[-*+]\s+\[/.test(l));
      const done = tasks.filter((l) => /^\s*[-*+]\s+\[[xX-]\]/.test(l)).length;
      if (tasks.length) head.append(h('span.c', `${done} of ${tasks.length}`));
    }
    page.append(head, ...blocks(body, o));
  }
  return page;
}
