// A page as a client draws it (docs/PAGES.md, "The drawn page"): the hub
// runs the page format's filters, sorts, limits, groups, counts and stats
// over the items it read, so a client (the app, the phone, the Mac app)
// draws rows and numbers and never runs packages/page-format itself.
//
// GET /api/pages/page?key=<key>&tab=<n> answers the page view with
// `drawn`, for the tab asked for (the person's choice of tab is an intent:
// the client sends it and draws the answer):
//
//   drawn = {
//     tab: number,              // the tab drawn: the one asked for, kept
//                               // inside the page's tabs; 0 when not asked
//     tabs: [{ label: string | null, count: number | null }],
//                               // every tab, in order; count is the tab's
//                               // `count:` over the items its sections show
//                               // (each item once), null when it has none
//     pageItems: number,        // items of the page's own source (the head's
//                               // "12 ideas in ideas/")
//     sections: [{              // the drawn tab's sections, in the file's order
//       rows: Item[],           // where, then sort, then limit applied; each
//                               // row is the item with `$actions`: the indexes
//                               // of the section's item actions whose `when`
//                               // holds for it (a button not listed is not drawn)
//       count: number,          // rows.length
//       groups: [{ value: string | null, count: number, rows: number[] }] | null,
//                               // group_by, as the view draws it: indexes into
//                               // rows. board: one lane per enum value, empty
//                               // ones too, then None; list: the groups with
//                               // rows (enum order, then None); document: one
//                               // per value seen, in the order seen, then None.
//                               // null for no group_by or another view
//       stats: [{ label: string, value: number | string | null, note: string | null }] | null,
//                               // a stats view's numbers (min and max of dates
//                               // give the date's text); null for other views
//     }]
//   }
//
// The page view also has `changed` when a default page moved on since a
// person's copy (See what changed): changedLines() below, the lines a
// client shows, `{ gap, n, text, add }` each.
//
// An item keeps every field the hub read ($hash, $base, $boxes, $ravenry
// and the source's fields); the client still reads a field by its path and
// says a value as text (getField, valueText, fillText) to draw it.

import * as pf from './vendor/page-format.mjs';

const sourceFields = (s) => (s && s.source && s.source.kind !== 'provider' ? s.source.fields : null);

/** The items one section shows: where, sort, limit. */
export function sectionRows(s, all) {
  let list = (all || []).filter((it) => pf.matches(s.where, it));
  list = pf.sortItems(list, s.sort || [], s.source ? s.source.fields : null);
  if (s.limit) list = list.slice(0, s.limit);
  return list;
}

/** A tab's count: its `count:` over the items its sections show, each once. */
export function tabCount(t, lists) {
  if (!t.count) return null;
  const seen = new Set();
  t.sections.forEach((s, si) => { for (const it of lists[si] || []) if (pf.matches(s.where, it)) seen.add(it); });
  return pf.countItems([...seen], t.count);
}

function groupsOf(s, rows) {
  if (s.kind !== 'core' || !s.groupBy) return null;
  let spec = null;
  if (s.view === 'board' || s.view === 'list') { const f = sourceFields(s); spec = f ? f[s.groupBy] || null : null; }
  else if (s.view !== 'document') return null;
  const at = new Map(rows.map((r, i) => [r, i]));
  let gs = pf.groupItems(rows, s.groupBy, spec);
  if (s.view !== 'board') gs = gs.filter((g) => g.items.length);
  return gs.map((g) => ({ value: g.value, count: g.items.length, rows: g.items.map((it) => at.get(it)) }));
}

function actionsFor(s, it) {
  if (s.kind !== 'core') return [];
  const out = [];
  s.item.actions.forEach((a, i) => { if (!a.when || pf.matches(a.when, it)) out.push(i); });
  return out;
}

/** The drawn page for `page` (the model) and `items` ({ page, sections }
 * as pages.itemsFor reads them), at the tab asked for. */
export function drawPage(page, items, tab = 0) {
  if (!page) return null;
  const n = page.tabs.length;
  let ti = Number.parseInt(String(tab ?? 0), 10);
  if (!Number.isFinite(ti) || ti < 0) ti = 0;
  if (ti > n - 1) ti = Math.max(0, n - 1);
  const secs = items.sections || [];
  const tabs = page.tabs.map((t, i) => ({ label: t.label, count: tabCount(t, secs[i] || []) }));
  const t = page.tabs[ti];
  const sections = t ? t.sections.map((s, si) => {
    const raw = sectionRows(s, (secs[ti] || [])[si]);
    const rows = raw.map((it) => ({ ...it, $actions: actionsFor(s, it) }));
    const groups = groupsOf(s, raw);
    const stats = s.kind === 'core' && s.view === 'stats' ? (s.stats || []).map((st) => ({ label: st.label, value: pf.statValue(raw, st), note: st.note })) : null;
    return { rows, count: rows.length, groups, stats };
  }) : [];
  return { tab: ti, tabs, pageItems: (items.page || []).length, sections };
}

// ---------------------------------------------------------------- See what changed

/** The lines of `b` with those not in `a` marked (a longest common
 * subsequence of lines). */
export function diffLines(a, b) {
  const A = String(a).split('\n'), B = String(b).split('\n');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && A[i] === B[j]) { out.push({ text: B[j], add: false }); i++; j++; }
    else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++;
    else { out.push({ text: B[j], add: true }); j++; }
  }
  return out;
}

/** What a client shows under "See what changed" (the default page against
 * the revision the person's copy started from): the lines the default
 * added, each with two around it, `{ gap: true }` where lines are left
 * out, else the first six. Each line has its number in the new default;
 * the revision line is never news. */
export function changedLines(old, now) {
  const rows = diffLines(old || '', now || '');
  const news = (r) => r.add && !/^revision:/.test(r.text);
  const keep = new Set();
  rows.forEach((r, i) => { if (news(r)) for (let j = Math.max(0, i - 2); j <= Math.min(rows.length - 1, i + 2); j++) keep.add(j); });
  if (!keep.size) for (let j = 0; j < Math.min(rows.length, 6); j++) keep.add(j);
  const out = [];
  let last = -2;
  for (const j of [...keep].sort((x, y) => x - y)) {
    if (last >= 0 && j > last + 1) out.push({ gap: true, n: null, text: '', add: false });
    out.push({ gap: false, n: j + 1, text: rows[j].text, add: news(rows[j]) });
    last = j;
  }
  return out;
}
