#!/usr/bin/env node
// The drawn page (server/pagedraw.mjs, docs/PAGES.md "The drawn page"): the
// hub's filters, sorts, limits, groups, tab counts, stats and item buttons
// for a page, which the app and the phone draw instead of running the page
// format themselves.
//   - the same rows, order, groups, counts and stats as the app drew from
//     the items before (the window's code, kept below as `before`), on every
//     shipped page and every valid fixture, each tab, with items made up
//     from each source's fields (some values missing, some repeated);
//   - the playtest board's lanes (empty ones kept), a list's groups (empty
//     ones left out), a document's groups (as seen), a limit, `when` on an
//     item button, and the tab asked for kept inside the page's tabs.
// Pure: no board, no files written.
// Usage: node tools/pagedraw-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pf from '../server/vendor/page-format.mjs';
import { drawPage, changedLines } from '../server/pagedraw.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIX = path.join(ROOT, '..', 'packages', 'page-format', 'fixtures');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// ------------------------------------------------------------ before
// What apps/desktop/src/renderer/pages.ts did with the items until the hub
// drew them (tabItems, itemsOf, list, board, documentView, stats, button).
const before = {
  rows(s, all) {
    const fields = s.source ? s.source.fields : null;
    let list = (all || []).filter((it) => pf.matches(s.where, it));
    list = pf.sortItems(list, s.sort, fields);
    if (s.limit) list = list.slice(0, s.limit);
    return list;
  },
  tabCount(page, items, ti) {
    const t = page.tabs[ti];
    if (!t.count) return null;
    const seen = new Set();
    t.sections.forEach((s, si) => { for (const it of (items.sections[ti] || [])[si] || []) if (pf.matches(s.where, it)) seen.add(it); });
    return pf.countItems([...seen], t.count);
  },
  groups(s, rows) {
    if (s.kind !== 'core' || !s.groupBy) return null;
    const enumOf = s.source && s.source.kind !== 'provider' ? s.source.fields[s.groupBy] || null : null;
    if (s.view === 'board') return pf.groupItems(rows, s.groupBy, enumOf || null);
    if (s.view === 'document') return pf.groupItems(rows, s.groupBy, null);
    if (s.view === 'list') return pf.groupItems(rows, s.groupBy, enumOf).filter((g) => g.items.length);
    return null;
  },
  shown(s, it) { return s.kind === 'core' ? s.item.actions.map((a, i) => (a.when && !pf.matches(a.when, it) ? -1 : i)).filter((i) => i >= 0) : []; },
};

// ------------------------------------------------------------ made-up items
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
function value(f, depth = 0) {
  if (rnd() < 0.15) return undefined; // some items lack it
  switch (f.type) {
    case 'enum': return pick(f.values || ['a', 'b']);
    case 'number': return pick([0, 1, 2, 3, 5, 8, 13, 40]);
    case 'date': return pick(['2026-10-30', '2026-11-01T09:00:00.000Z', '2026-11-06T16:52:00.000Z', '2025-03-02']);
    case 'bool': return rnd() < 0.5;
    case 'list': return f.fields && depth < 2 ? Array.from({ length: Math.floor(rnd() * 4) }, () => obj(f.fields, depth + 1)) : [pick(['x', 'y', 'z'])];
    case 'object': return f.fields && depth < 2 ? obj(f.fields, depth + 1) : {};
    case 'image': return 'shots/a.png';
    default: return pick(['alpha', 'Bravo', 'charlie', 'delta', 'you', 'gate', 'work', 'kite', 'add', 'every', 'reword']);
  }
}
function obj(fields, depth) {
  const o = {};
  for (const [k, f] of Object.entries(fields || {})) { const v = value(f, depth); if (v !== undefined) o[k] = v; }
  return o;
}
const fieldsOf = (src) => (src ? (src.kind === 'provider' ? pf.providerFields(src.provider) : src.fields) : null);
function itemsFor(page) {
  let n = 0;
  const make = (src) => {
    const fields = fieldsOf(src) || { title: { type: 'string' }, state: { type: 'string' } };
    return Array.from({ length: 4 + Math.floor(rnd() * 14) }, () => ({ ...obj(fields, 0), file: `n${++n}.md`, id: `i${n}`, title: `Item ${n}` }));
  };
  return { page: make(page.source), sections: page.tabs.map((t) => t.sections.map((s) => make(s.source))) };
}

// ------------------------------------------------------------ same as before
const pagesToCheck = [];
for (const dir of [path.join(ROOT, 'pages', 'defaults'), path.join(FIX, 'valid')]) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.page.yaml'))) {
    const r = pf.checkPage(fs.readFileSync(path.join(dir, f), 'utf8'), { fileName: f, ravenryVersion: '9.9.9' });
    if (r.ok) pagesToCheck.push([`${path.basename(dir)}/${f}`, r.page]);
  }
}
const pt = pf.checkPage(fs.readFileSync(path.join(FIX, 'playtest', 'playtest.page.yaml'), 'utf8'), { fileName: 'playtest.page.yaml' });
pagesToCheck.push(['playtest', pt.page]);
check('the pages to draw: the shipped five, the valid fixtures and the playtest page', pagesToCheck.length >= 11, pagesToCheck.map((x) => x[0]).join(', '));

const ids = (xs) => xs.map((x) => x.file).join(',');
for (const [name, page] of pagesToCheck) {
  const bad = [];
  for (let round = 0; round < 6; round++) {
    const items = itemsFor(page);
    page.tabs.forEach((t, ti) => {
      const d = drawPage(page, items, ti);
      if (d.tab !== ti) bad.push(`tab ${ti} drawn as ${d.tab}`);
      page.tabs.forEach((_, i) => { if (d.tabs[i].count !== before.tabCount(page, items, i)) bad.push(`tab ${i} count ${d.tabs[i].count}`); });
      if (d.pageItems !== items.page.length) bad.push('pageItems');
      t.sections.forEach((s, si) => {
        const was = before.rows(s, items.sections[ti][si]);
        const ds = d.sections[si];
        if (ids(ds.rows) !== ids(was) || ds.count !== was.length) bad.push(`tab ${ti} section ${si} rows ${ids(ds.rows)} were ${ids(was)}`);
        const wg = before.groups(s, was);
        const dg = ds.groups && ds.groups.map((g) => ({ value: g.value, items: g.rows.map((i) => ds.rows[i]) }));
        if (JSON.stringify(wg && wg.map((g) => [g.value, ids(g.items)])) !== JSON.stringify(dg && dg.map((g) => [g.value, ids(g.items)]))) bad.push(`tab ${ti} section ${si} groups`);
        if (ds.groups && ds.groups.some((g) => g.count !== g.rows.length)) bad.push('group count');
        const ws = s.kind === 'core' && s.view === 'stats' ? (s.stats || []).map((st) => pf.statValue(was, st)) : null;
        if (JSON.stringify(ws) !== JSON.stringify(ds.stats && ds.stats.map((x) => x.value))) bad.push(`tab ${ti} section ${si} stats ${JSON.stringify(ds.stats)} were ${JSON.stringify(ws)}`);
        ds.rows.forEach((r, i) => { if (JSON.stringify(r.$actions) !== JSON.stringify(before.shown(s, was[i]))) bad.push(`buttons of ${r.file}`); });
        // The item is the hub's, untouched apart from $actions.
        ds.rows.forEach((r, i) => { const { $actions: _a, ...rest } = r; if (JSON.stringify(rest) !== JSON.stringify(was[i])) bad.push(`fields of ${r.file}`); });
      });
    });
  }
  check(`${name}: the same rows, order, groups, counts, stats and buttons as the app drew, every tab`, !bad.length, bad.slice(0, 4).join('; '));
}

// ------------------------------------------------------------ cases
const at = (file, fields, modified) => ({ file, title: file.replace(/\.md$/, ''), modified, ...fields });
const ptItems = { page: [], sections: [[[
  at('a.md', { status: 'new' }, '2026-11-06'), at('b.md', { status: 'fixed' }, '2026-11-05'), at('c.md', { status: 'new' }, '2026-11-04'), at('d.md', {}, '2026-11-03'),
]]] };
const pd = drawPage(pt.page, ptItems, 0);
const lanes = pd.sections[0].groups.map((g) => `${g.value} ${g.count}`).join(', ');
check('a board: one lane per value, in the enum\'s order, an empty one kept, then None', lanes === 'new 2, fixing 0, fixed 1, null 1', lanes);
check('a lane\'s rows are indexes into the section\'s rows, in their order', JSON.stringify(pd.sections[0].groups[0].rows.map((i) => pd.sections[0].rows[i].file)) === '["a.md","c.md"]');
check('a page with no tabs is drawn at tab 0, whatever is asked', drawPage(pt.page, ptItems, 3).tab === 0 && drawPage(pt.page, ptItems, 'x').tab === 0 && drawPage(pt.page, ptItems, -1).tab === 0 && drawPage(pt.page, ptItems, null).tab === 0);
check('no model, nothing drawn', drawPage(null, ptItems, 0) === null);

const yaml = (t) => { const r = pf.checkPage(t, { fileName: 'x.page.yaml' }); if (!r.ok) throw new Error(JSON.stringify(r.problems)); return r.page; };
const listPage = yaml(`version: 1
id: x
title: X
source:
  folder: notes/
  fields:
    status: { type: enum, values: [new, fixing, fixed] }
    size: { type: number }
tabs:
  - label: Open
    count: { status: { not: fixed } }
    sections:
      - view: list
        group_by: status
        where: { status: { not: fixed } }
        sort: [-size]
        item:
          title: title
          actions:
            - { label: Fixed, set: { status: fixed }, when: { status: fixing } }
            - { label: Open, open: file }
  - label: Top two
    count: true
    sections:
      - view: list
        sort: [-size]
        limit: 2
        item: { title: title }
      - view: document
        group_by: status
        item: { title: title }
`);
const li = [at('a.md', { status: 'new', size: 1 }), at('b.md', { status: 'fixing', size: 5 }), at('c.md', { status: 'fixed', size: 9 }), at('d.md', { status: 'new', size: 3 })];
const lv = { page: li, sections: [[li], [li, li]] };
const l0 = drawPage(listPage, lv, 0);
check('a list grouped: where, then sort, its groups with rows only', l0.sections[0].groups.map((g) => `${g.value}:${g.rows.map((i) => l0.sections[0].rows[i].file).join('+')}`).join(' ') === 'new:d.md+a.md fixing:b.md', JSON.stringify(l0.sections[0].groups));
check('an item\'s buttons: only those whose when holds', l0.sections[0].rows.map((r) => `${r.file}:${r.$actions.join('')}`).join(' ') === 'b.md:01 d.md:1 a.md:1', l0.sections[0].rows.map((r) => `${r.file}:${r.$actions.join('')}`).join(' '));
check('the tabs\' counts: a filter, and true over what the tab shows', l0.tabs.map((t) => `${t.label} ${t.count}`).join(', ') === 'Open 3, Top two 4', JSON.stringify(l0.tabs));
check('only the tab asked for is drawn', l0.sections.length === 1 && drawPage(listPage, lv, 1).sections.length === 2);
const l1 = drawPage(listPage, lv, 1);
check('a limit: the first rows after the sort', ids(l1.sections[0].rows) === 'c.md,b.md' && l1.sections[0].count === 2);
check('a document grouped: a group per value seen, in the order seen', l1.sections[1].groups.map((g) => g.value).join(',') === 'new,fixing,fixed');
check('a tab past the last is the last', drawPage(listPage, lv, 7).tab === 1);
check('the head\'s count of the page\'s items', l0.pageItems === 4);

// See what changed (changedLines): what the desktop's drawModal 'changed'
// worked out from diffLines, kept here as it was, on made-up revisions.
function beforeChanged(old, now) {
  const A = old.split('\n'), B = now.split('\n');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && A[i] === B[j]) { rows.push({ text: B[j], add: false }); i++; j++; }
    else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++;
    else { rows.push({ text: B[j], add: true }); j++; }
  }
  const added = rows.map((r, k) => ({ ...r, k })).filter((r) => r.add && !/^revision:/.test(r.text));
  const keep = new Set();
  for (const a of added) for (let k = Math.max(0, a.k - 2); k <= Math.min(rows.length - 1, a.k + 2); k++) keep.add(k);
  if (!keep.size) for (let k = 0; k < Math.min(rows.length, 6); k++) keep.add(k);
  const out = [];
  let last = -2;
  for (const k of [...keep].sort((x, y) => x - y)) {
    if (last >= 0 && k > last + 1) out.push('...');
    out.push(`${k + 1}${rows[k].add && !/^revision:/.test(rows[k].text) ? '+' : ' '}${rows[k].text}`);
    last = k;
  }
  return out.join('\n');
}
const said = (ls) => ls.map((l) => (l.gap ? '...' : `${l.n}${l.add ? '+' : ' '}${l.text}`)).join('\n');
const r1 = ['version: 1', 'id: objectives', 'revision: 1', 'title: Objectives', 'tabs:', '  - sections:', '    - view: cards', '      item:', '        title: name', '        badges: [machine]', '        detail: x', '        place: y', 'a: 1', 'b: 1', 'c: 1', 'end: 1'].join('\n');
const r2 = r1.replace('revision: 1', 'revision: 2').replace('        badges: [machine]\n', '        badges: [machine]\n        time: updated\n').replace('end: 1', 'end: 1\nmore: 2');
const ch = changedLines(r1, r2);
check('see what changed: the hub\'s lines are the ones the desktop worked out', said(ch) === beforeChanged(r1, r2), said(ch));
check('see what changed: added lines marked, two around each, a gap between, the revision line not news', ch.filter((l) => l.add).map((l) => l.text.trim()).join(',') === 'time: updated,more: 2' && ch.some((l) => l.gap) && !ch.some((l) => l.add && /^revision/.test(l.text)), said(ch));
const same = changedLines(r1, r1);
check('see what changed: nothing added shows the first six lines', same.length === 6 && same.every((l) => !l.add && !l.gap) && said(same) === beforeChanged(r1, r1));
const fileShapes = [['', 'a'], ['a\nb\nc', 'a\nx\nb\nc\ny'], ['revision: 1\na', 'revision: 2\na']];
check('see what changed: the same as the desktop on small texts', fileShapes.every(([a, b]) => said(changedLines(a, b)) === beforeChanged(a, b)));

if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
console.log('\nall passed');
