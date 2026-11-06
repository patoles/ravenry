// Ravenry board. Plain ES module, no build step.
// Renders the snapshot the server pushes over SSE (/api/events).

import { KIND, glyphKey, rowModel, flowItems, statusWords, gateTiles } from './plan-view.js';
import { createGallery, cardPicture } from './gallery.js';

const $ = (s, el = document) => el.querySelector(s);
let gallery = null; // the picture gallery (public/gallery.js), made once the page's helpers exist
// Every piece of outside text the board shows (git subjects, transcripts,
// screens, memories, briefs, ideas, rules) passes through esc(), so this is
// the one place em dashes become a comma (the rule: none anywhere in the
// UI). A dash next to punctuation or at a line edge just goes away, and
// a run of dashes is one comma. escRaw() keeps text verbatim, for the Live
// screen (it mirrors the terminal) and for values that go back out: ids,
// urls, the copied ship command, chips sent to Claude.
const undash = (s) => (s.includes('\u2014') ? s
  .replace(/[ \t]*\u2014+(?:[ \t]*\u2014+)*[ \t]*/g, '\uE000')
  .replace(/(^|\n)\uE000|\uE000(?=\n|$)/g, '$1')
  .replace(/([,;:.!?])\uE000/g, '$1 ')
  .replace(/\uE000(?=[,;:.!?)])/g, '')
  .replace(/\uE000/g, ', ') : s);
const escRaw = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esc = (s) => escRaw(undash(String(s ?? '')));
// A terminal rule: a line drawn only of dashes or box lines, as wide as the
// terminal (about 200 columns). It is one row clipped to its card, never
// wrapped into rows of dashes or run out past the card's edge (a "Do you
// want to proceed" dialog once ran out of its card).
const SCREEN_RULE = /^\s*[─━╌╍┄┅┈┉═\-_=]{6,}\s*$/;

// ------------------------------------------------------------ constants (from the design)

const ST = {
  you: { c: 'var(--you)', tint: 'var(--you-t)', word: 'Needs you', card: 'Waiting on your answer', dash: '', dot: 2.6, cnt: 'background:var(--you);color:#1A1A1A' },
  work: { c: 'var(--work)', tint: 'var(--work-t)', word: 'Working', card: 'Doing now', dash: '', dot: 3.4, cnt: 'background:var(--work);color:#FFFFFF' },
  wait: { c: 'var(--wait)', tint: 'var(--wait-t)', word: 'Waiting on others', card: 'Waiting on someone else', dash: '2.2 2', dot: 0, cnt: 'background:var(--wait);color:#FFFFFF' },
  idle: { c: 'var(--idle)', tint: 'var(--idle-t)', word: 'Idle', card: 'Idle', dash: '', dot: 0, cnt: 'background:var(--card2);color:var(--tx2)' },
};
// A session the New session switch just started, until its first hook event.
const ST_STARTING = { c: 'var(--work)', dash: '2.2 2', dot: 0 };
const ORDER = ['you', 'work', 'wait', 'idle'];
const FL = { note: 'var(--tx)', hand: 'var(--work)', shared: 'var(--bad)', ship: 'var(--ok)' };
const SESSION_WORD = { dialog: 'Choice open', asked: 'Asked you', draft: 'Half-typed reply', working: 'Working', handback: 'Back to you', stale: 'Idle', handed: 'Handed off', unknown: 'Unknown', none: 'Ended' };
const SESSION_STATE = { dialog: 'you', asked: 'you', draft: 'you', handback: 'you', working: 'work' };
const CHECK = 'M2 5.2l2 2 4-4.4';
// Containers outside #sheet whose last html survives a sheet rebuild.
const KEEP_HTML = ['list', 'views', 'pchips', 'idle-sheet'];

// ------------------------------------------------------------ view state

const ui = {
  snap: null,
  sel: null,
  selSession: {},  // projectId -> surfaceId
  drafts: {},      // projectId -> text
  files: {},       // projectId -> [{ name, path, short, pending }]
  sent: {},        // projectId -> { label, at, delivered }
  ns: false,       // the message box's New session switch; off whenever a project opens
  starting: {},    // projectId -> { surfaceId, before, topic, at }: a session started from the switch
  follow: {},      // projectId -> { surfaceId, workspaceId, before, at, late }: a new session the sheet moves to once it shows
  theme: 'dark',
  alerts: false,
  lastStates: {},
  built: null,     // project id (or view key) the sheet skeleton was built for
  html: {},        // container id -> last html
  view: 'projects',
  ideas: null,     // /api/ideas, kept fresh over SSE
  selIdea: null,
  panelFor: null,
  ideaDrafts: {},
  ideaRefs: {},
  mk: {},          // ideaId -> { round, view, draft, dismissed } for the Mockups card    // ideaId -> [{ file, url }] pictures for the next message
  rules: null,     // /api/rules: the memory suggestions
  mine: null,      // /api/rules/mine: the global CLAUDE.md
  repeats: null,   // /api/rules/repeats: Suggested
  rulesTab: 'mine',
  rulesMore: false,
  openRepeat: null,
  repeatError: null,
  repeatBusy: null,
  ship: null,
  meta: null,
  modal: null,
  tick: {},        // Sessions page: sessionId -> ticked, where the user changed the default
  closedAll: false,
  closingNow: false,
  idleOpen: false, // phone: the idle projects' bottom sheet
};

const store = {
  get(k, d) { try { const v = localStorage.getItem('mc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mc.' + k, JSON.stringify(v)); } catch { /* private window */ } },
};

// ------------------------------------------------------------ time words

function parseT(iso) { return iso ? new Date(iso) : null; }
function clock(d, ampm) {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const pm = h >= 12;
  h = h % 12 || 12;
  return ampm ? `${h}:${m} ${pm ? 'PM' : 'AM'}` : `${h}:${m}`;
}
function rel(d, now = Date.now()) {
  const s = (now - d.getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.round(s / 60) + ' min';
  if (s < 86400) return Math.round(s / 3600) + ' h';
  if (s < 86400 * 14) return Math.round(s / 86400) + ' d';
  if (s < 86400 * 60) return Math.round(s / 86400 / 7) + ' w';
  if (s < 86400 * 365) return Math.round(s / 86400 / 30) + ' mo';
  return Math.round(s / 86400 / 365) + ' y';
}
// "6 days ago", "4 weeks ago": how long since a plan file changed.
function ago(iso, now = Date.now()) {
  const d = parseT(iso);
  if (!d) return '';
  const s = Math.max(0, (now - d.getTime()) / 1000);
  const n = (v, unit) => `${v} ${unit}${v === 1 ? '' : 's'} ago`;
  if (s < 3600) return 'just now';
  if (s < 86400) return n(Math.round(s / 3600), 'hour');
  if (s < 86400 * 2) return 'yesterday';
  if (s < 86400 * 14) return n(Math.round(s / 86400), 'day');
  if (s < 86400 * 60) return n(Math.round(s / 86400 / 7), 'week');
  if (s < 86400 * 365) return n(Math.round(s / 86400 / 30), 'month');
  return n(Math.round(s / 86400 / 365), 'year');
}
// A project's objectives: its brief's plan, then the plan files in its folder
// that carry checkboxes (server/plans.mjs), newest first.
function objectivesOf(p) {
  const fromBrief = p.brief ? p.brief.plan : [];
  const fromFiles = (p.plans || []).map((f) => ({ title: f.title, tasks: [], progress: { done: f.done, total: f.total }, source: f.source, updatedAt: f.updatedAt }));
  return fromBrief.concat(fromFiles);
}
function draftTag(p) {
  if (!p.brief || !p.brief.draft) return '';
  return `<button class="draft-tag" data-copy="${escRaw(p.brief.file || p.brief.path)}" data-copy-msg="Copied ${esc(p.brief.path)}. Review the draft brief there." title="${esc(`A draft written from the project's own files. Review it: ${p.brief.path} (click to copy the path)`)}">Draft</button>`;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function day(d) { return `${MON[d.getMonth()]} ${d.getDate()}`; }
function within24(d) { return Date.now() - d.getTime() < 86400e3; }
function rowSince(p) {
  if (p.state === 'work') return 'now';
  const d = parseT(p.since);
  if (!d) return '';
  if (p.state === 'idle') return rel(d);
  return within24(d) ? clock(d) : rel(d);
}
function longSince(d) { return within24(d) ? clock(d, true) : day(d); }
function whenLabel(t) {
  if (t.when) return t.when.replace(/^\d{4}-/, '');
  const d = parseT(t.at);
  if (!d) return '';
  return within24(d) ? clock(d, true) : day(d);
}
function ctxLabel(ctx) {
  if (!ctx) return 'no session';
  const k = ctx.tokens >= 1e6 ? (ctx.tokens / 1e6).toFixed(2) + 'M' : Math.round(ctx.tokens / 1000) + 'k';
  const w = ctx.window >= 1e6 ? (ctx.window / 1e6) + 'M' : Math.round(ctx.window / 1000) + 'k';
  return `${k} of ${w}`;
}

// ------------------------------------------------------------ small pieces

function stateIcon(t, cls = '') {
  return `<svg ${cls ? `class="${cls}"` : ''} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" style="stroke: ${t.c}" stroke-width="1.7" stroke-dasharray="${t.dash}"></circle><circle cx="7" cy="7" r="${t.dot}" style="fill: ${t.c}"></circle></svg>`;
}
function taskDot(state) {
  const c = { dotStyle: 'border:1.5px solid var(--idle)', check: '', tc: 'var(--tx2)', fw: 400, tag: '', tagC: '' };
  if (state === 'done') Object.assign(c, { dotStyle: 'background:var(--ok)', check: CHECK, tc: 'var(--tx)' });
  if (state === 'you') Object.assign(c, { dotStyle: 'border:2px solid var(--you)', tc: 'var(--tx)', fw: 600, tag: 'You', tagC: 'var(--you)' });
  if (state === 'wait') Object.assign(c, { dotStyle: 'border:2px dashed var(--wait)', tc: 'var(--tx)', tag: 'Someone else', tagC: 'var(--wait)' });
  if (state === 'now') Object.assign(c, { dotStyle: 'background:var(--work)', tc: 'var(--tx)', fw: 600, tag: 'Now', tagC: 'var(--work)' });
  return c;
}
function project(id) { return ui.snap && ui.snap.projects.find((p) => p.id === id); }

// The assistant tag (docs/design/CodexStage2.dc.html, section 2, A): one small
// neutral word on every session, the same style for both. "Claude", not
// "Claude Code", which takes more room.
const AS_WORD = { claude: 'Claude', codex: 'Codex' };
const AS_NAME = { claude: 'Claude Code', codex: 'Codex' };
const asKind = (k) => (k === 'codex' ? 'codex' : 'claude');
function asTag(kind, cls = '') {
  const k = asKind(kind);
  return `<span class="as-tag${cls ? ' ' + cls : ''}" title="${AS_NAME[k]} session">${AS_WORD[k]}</span>`;
}
// A session that is not in a project (section 1, C) is shown by its folder
// name with a folder glyph.
const UN_ICON = '<span class="un-ic"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.6h5.6a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"></path></svg></span>';
// The session a project's row speaks for: its primary, else its first.
function mainSession(p) { return (p.sessions || []).find((x) => x.surfaceId === p.primary) || (p.sessions || [])[0] || null; }
// A chosen session that hands off gives the choice to its fresh session
// (or back to the primary when the fresh one is not on the board yet),
// once: chosen again afterwards, it stays chosen.
const handedMoved = new Set(); // surfaceIds whose hand-off already moved the choice
function selectedSession(p) {
  if (!p) return null;
  let want = ui.selSession[p.id];
  const cur = want && p.sessions.find((s) => s.surfaceId === want);
  if (cur && cur.handed && !handedMoved.has(cur.surfaceId)) {
    handedMoved.add(cur.surfaceId);
    const fresh = cur.freshSurface && p.sessions.find((s) => s.surfaceId === cur.freshSurface);
    if (fresh) ui.selSession[p.id] = want = fresh.surfaceId;
    else { delete ui.selSession[p.id]; want = null; }
  }
  return p.sessions.find((s) => s.surfaceId === want) || p.sessions.find((s) => s.surfaceId === p.primary) || p.sessions.find((s) => s.live) || p.sessions[0] || null;
}
// A session the board just opened (New session, Revive, a plan's start, or
// a plan's words when no session was running): the sheet moves to it as
// soon as it shows on the board, matched by the tab the start call names
// (a cmux surface or an iTerm2 session; a new workspace when Revive had to
// open one). Until then the sheet stays where it was and says it is
// starting; after FOLLOW_MS it says the session did not show and stays
// put. Picking a session in the meantime cancels the move.
const FOLLOW_MS = 30000;
function followStart(pid, r, before) {
  if (!r) return;
  ui.follow[pid] = { surfaceId: r.surfaceId || null, workspaceId: r.surfaceId ? null : r.workspaceId || null, before, at: Date.now(), late: false };
  setTimeout(render, FOLLOW_MS + 100);
}
const sameTab = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();
function followed(p, f) {
  return p.sessions.find((x) => (x.live || x.state !== 'none' || x.source === 'events')
    && (f.surfaceId ? sameTab(x.surfaceId, f.surfaceId) : f.workspaceId ? x.workspaceId === f.workspaceId && !f.before.includes(x.surfaceId) : !f.before.includes(x.surfaceId))) || null;
}
function followNew() {
  for (const [pid, f] of Object.entries(ui.follow)) {
    const p = project(pid);
    if (!p) { delete ui.follow[pid]; continue; }
    const x = followed(p, f);
    // Late: it stayed put; the line goes when the session shows after all,
    // or two minutes on.
    if (f.late) { if (x || Date.now() - f.at > FOLLOW_MS + 120000) delete ui.follow[pid]; continue; }
    // Moved: the "Sent" line was about the session it left.
    if (x) { ui.selSession[pid] = x.surfaceId; delete ui.follow[pid]; delete ui.sent[pid]; continue; }
    if (Date.now() - f.at > FOLLOW_MS) f.late = true;
  }
}
// The line on the message box's card while it waits, or after it gave up.
function followLine(p) {
  const f = ui.follow[p.id];
  if (!f) return '';
  if (!f.late) return `<div class="working" role="status" style="display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--work)">${stateIcon(ST_STARTING)}Starting a new session...</div>`;
  return `<div role="status" style="font-size: 13px; line-height: 1.45; font-weight: 600; color: var(--tx2)">The new session has not shown on the board after ${FOLLOW_MS / 1000} s, so the sheet stays here. Look for its tab in ${esc(boardTerm())}. Once it reports, it shows under Sessions.</div>`;
}

// What the detail sheet shows: the project, seen through the chosen session.
function view(p) {
  const s = selectedSession(p);
  const isPrimary = !s || s.surfaceId === p.primary;
  const w = isPrimary ? { state: p.state, line: p.line, headline: p.headline, quick: p.quick, dialog: p.dialog, draft: p.draft } : s.words;
  return { s, w, state: isPrimary ? p.state : w.state };
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (!el) return;
  if (ui.html[id] === html) return;
  ui.html[id] = html;
  el.innerHTML = html;
}

function toast(msg, ms = 3200, wide = false) {
  const t = $('#toast');
  t.textContent = undash(String(msg ?? ''));
  t.classList.toggle('wide', wide);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// X-Mission-Control is the guard header's name from before the rename, sent
// too so a board started before it still accepts this page's writes.
async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Ravenry': '1', 'X-Mission-Control': '1', ...(body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body instanceof Blob ? body : JSON.stringify(body),
  });
  let j = {};
  try { j = await res.json(); } catch { /* empty */ }
  if (res.status === 401) signedOut();
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ------------------------------------------------------------ left column

// The projects of each state, in the order the list shows them. The phone's
// chips and idle sheet use the same order.
// A session that is not in a project and needs you sits in Needs you; the
// quiet ones (working, idle) go to `un`, the "Not in a project" group under
// Idle (docs/design/CodexStage2.dc.html, section 1, variant C).
function groups(ps) {
  const out = {};
  out.un = ps.filter((p) => p.unowned && p.state !== 'you').sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (Date.parse(b.since || 0) - Date.parse(a.since || 0)) || a.name.localeCompare(b.name));
  for (const k of ORDER) {
    const items = ps.filter((p) => p.state === k && !(p.unowned && k !== 'you'));
    // Needs you: oldest first is not useful; newest ask on top.
    items.sort((a, b) => k === 'work' ? a.name.localeCompare(b.name) : (Date.parse(b.since || 0) - Date.parse(a.since || 0)) || a.name.localeCompare(b.name));
    out[k] = items;
  }
  return out;
}

function rowLabel(p, k) {
  const t = ST[k];
  const idle = k === 'idle';
  const since = rowSince(p);
  return `${p.name}, ${t.word.toLowerCase()}${since && since !== 'now' ? ', ' + (idle ? since + ' ago' : 'since ' + since) : ''}${!idle && p.line ? ': ' + p.line : ''}${p.flags.length ? '. ' + p.flags.map((f) => f.title).join(', ') : ''}`;
}

function rowHtml(p, k) {
  const sel = ui.sel === p.id;
  const idle = k === 'idle';
  const since = rowSince(p);
  const pic = p.brief && p.brief.pictures && p.brief.pictures[0];
  const label = rowLabel(p, k);
  return `<button class="row ${sel ? 'sel' : ''}" data-id="${escRaw(p.id)}" ${sel ? 'aria-current="true"' : ''} aria-label="${esc(label)}" style="${idle ? 'padding: 5px 8px' : ''}">
<span style="display: flex; align-items: center; gap: 8px; width: 100%">
<span style="flex: 1; min-width: 0; font-weight: ${sel ? 650 : idle ? 400 : 550}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: ${idle && !sel ? 'var(--tx2)' : 'var(--tx)'}">${esc(p.name)}</span>
${p.flags.map((f) => `<span title="${esc(f.title)}" style="width: 6px; height: 6px; border-radius: 50%; background: ${FL[f.kind] || 'var(--tx)'}; flex: none"></span>`).join('')}
<span class="num t3" style="font-size: 11.5px">${esc(since)}</span>
</span>
${!idle && p.line ? `<span class="t2" style="font-size: 12px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%">${esc(p.line)}</span>` : ''}
${pic ? `<img class="pic" src="${escRaw(pic.url)}" alt="${esc(pic.alt)}" style="border-radius: 6px" loading="lazy">` : ''}
</button>`;
}

// A row for a session that is not in a project: its folder name, the
// folder glyph, its assistant's tag, the time, and its line.
function unRow(p, k) {
  const sel = ui.sel === p.id;
  const since = rowSince(p);
  const s = mainSession(p);
  const line = p.line || (p.headline || '').replace(/^Last: /, '');
  const word = (ST[p.state] || ST.idle).word.toLowerCase();
  return `<button class="row un-row ${sel ? 'sel' : ''}" data-id="${escRaw(p.id)}" ${sel ? 'aria-current="true"' : ''} aria-label="${esc(`${p.name}, not in a project, ${word}${line ? ': ' + line : ''}`)}">
<span style="display: flex; align-items: center; gap: 8px; width: 100%"><span class="un-name" style="font-weight: ${sel ? 650 : k === 'you' ? 550 : 500}">${UN_ICON}<span style="overflow: hidden; text-overflow: ellipsis">${esc(p.name)}</span></span>${s ? asTag(s.assistant) : ''}<span class="num t3" style="font-size: 11.5px">${esc(since)}</span></span>
${line ? `<span class="t2 un-sub">${esc(line)}</span>` : ''}
</button>`;
}

function renderList() {
  const snap = ui.snap;
  if (!snap) return;
  const ps = snap.projects;
  const counts = { you: 0, work: 0, wait: 0, idle: 0 };
  ps.forEach((p) => { counts[p.state]++; });
  const mixLabel = `${counts.you} need you, ${counts.work} working, ${counts.wait} waiting, ${counts.idle} idle`;
  let h = `<div class="mix"><div class="mix-bar" role="img" aria-label="${esc(mixLabel)}">${ORDER.filter((k) => counts[k]).map((k) => `<span style="flex: ${counts[k]}; background: ${ST[k].c}"></span>`).join('')}</div></div>`;
  const g = groups(ps);
  for (const k of ORDER) {
    const items = g[k];
    if (!items.length) continue;
    const t = ST[k];
    h += `<section class="grp" style="background: ${t.tint}" aria-labelledby="g-${k}">
<h2 class="grp-h" id="g-${k}" style="color: ${t.c}">${stateIcon(t)}<span style="flex: 1">${t.word}</span><span class="cnt num" style="${t.cnt}" aria-label="${items.length} projects">${items.length}</span></h2>`;
    for (const p of items) h += p.unowned ? unRow(p, k) : rowHtml(p, k);
    h += '</section>';
  }
  if (g.un.length) {
    h += `<section class="grp un-grp" aria-labelledby="g-un">
<h2 class="grp-h" id="g-un" style="color: var(--tx2)">${stateIcon({ c: 'var(--tx3)', dash: '2.2 2', dot: 0 })}<span style="flex: 1">Not in a project</span><span class="cnt num" style="background: var(--card2); color: var(--tx2)" aria-label="${g.un.length} sessions">${g.un.length}</span></h2>${g.un.map((p) => unRow(p, p.state)).join('')}</section>`;
  }
  if (!ps.length) h += `<p class="t2" style="padding: 0 8px">No projects yet. ${boardTerm() !== 'cmux' ? 'Start one with New project, or start Claude Code or Codex in a terminal.' : snap.cmuxOk ? 'cmux shows no workspaces.' : 'Waiting for cmux.'}</p>`;
  const focusedId = document.activeElement && document.activeElement.closest && document.activeElement.closest('#list .row') ? document.activeElement.closest('#list .row').dataset.id : null;
  setHtml('list', h);
  if (focusedId) { const el = document.querySelector(`#list .row[data-id="${CSS.escape(focusedId)}"]`); if (el) el.focus(); }
}

// ------------------------------------------------------------ phone chips
// docs/design/PhoneProjects.dc.html, variant C. At phone width the list above
// is hidden: every project that needs you, is working or waits on others
// is a chip in its group colour, in the list's order, and the idle ones fold
// into one "N idle" chip that opens them in a bottom sheet. An idle project
// that is selected gets its own chip at the end, before the idle chip.

const CHEV_DOWN = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5"></path></svg>';

function pchipHtml(p, k) {
  const t = ST[k];
  const sel = ui.sel === p.id;
  // Not in a project: a dashed chip with the folder glyph, in its state's place.
  if (p.unowned) return `<button class="pchip un ${sel ? 'on' : ''}" data-id="${escRaw(p.id)}" style="--c: ${t.c}; --t: var(--card)" ${sel ? 'aria-current="true"' : ''} aria-label="${esc(`${p.name}, not in a project, ${t.word.toLowerCase()}`)}">${k === 'idle' ? '' : stateIcon(t)}${UN_ICON}<span>${esc(p.name)}</span></button>`;
  // The idle tint is nearly clear; a selected idle project's chip sits on the
  // card colour like the idle chip beside it.
  return `<button class="pchip ${sel ? 'on' : ''}" data-id="${escRaw(p.id)}" style="--c: ${t.c}; --t: ${k === 'idle' ? 'var(--card)' : t.tint}" ${sel ? 'aria-current="true"' : ''} aria-label="${esc(rowLabel(p, k))}">${stateIcon(t)}<span>${esc(p.name)}</span></button>`;
}

function renderProjectChips() {
  if (!ui.snap) return;
  const g = groups(ui.snap.projects);
  // On the phone (section 1, as B): a working session not in a project gets
  // its dashed chip after the working ones; an idle one joins the idle chip.
  g.work = [...g.work, ...g.un.filter((p) => p.state === 'work')];
  g.idle = [...g.idle, ...g.un.filter((p) => p.state === 'idle')];
  let h = '';
  for (const k of ['you', 'work', 'wait']) for (const p of g[k]) h += pchipHtml(p, k);
  const selIdle = g.idle.find((p) => p.id === ui.sel);
  if (selIdle) h += pchipHtml(selIdle, 'idle');
  if (g.idle.length) h += `<button class="pchip idle ${ui.idleOpen ? 'on' : ''}" data-idle-open aria-haspopup="dialog" aria-expanded="${ui.idleOpen ? 'true' : 'false'}" aria-label="${g.idle.length} idle projects"><span class="num">${g.idle.length}</span><span>idle</span>${CHEV_DOWN}</button>`;
  const a = document.activeElement;
  const focused = a && a.closest && a.closest('#pchips .pchip');
  const key = focused ? (focused.hasAttribute('data-idle-open') ? null : focused.dataset.id) : null;
  const idleFocused = !!(focused && focused.hasAttribute('data-idle-open'));
  setHtml('pchips', h);
  const back = idleFocused ? $('#pchips [data-idle-open]') : key ? document.querySelector(`#pchips .pchip[data-id="${CSS.escape(key)}"]`) : null;
  if (back && back !== document.activeElement) back.focus();
  renderIdleSheet(g.idle);
}

function renderIdleSheet(idle) {
  if (ui.idleOpen && (!idle.length || ui.view !== 'projects')) ui.idleOpen = false;
  if (!ui.idleOpen) { setHtml('idle-sheet', ''); return; }
  const list = $('#idle-sheet .bs-list');
  const top = list ? list.scrollTop : 0;
  setHtml('idle-sheet', `<div class="scrim" data-idle-close></div><div class="bsheet" role="dialog" aria-modal="true" aria-label="Idle projects"><div class="grab"></div><div class="bs-head"><span class="bs-title">Idle</span><span class="t3 num" style="font-size: 12px; flex: 1">${idle.length}, newest first</span><button class="bs-done" data-idle-close>Done</button></div><div class="bs-list"><section class="grp" style="background: var(--idle-t)" aria-label="Idle projects">${idle.map((p) => (p.unowned ? unRow(p, 'idle') : rowHtml(p, 'idle'))).join('')}</section></div></div>`);
  const again = $('#idle-sheet .bs-list');
  if (again && top) again.scrollTop = top;
}

function openIdleSheet() {
  ui.idleOpen = true;
  renderProjectChips();
  const done = $('#idle-sheet .bs-done');
  if (done) done.focus();
}

function closeIdleSheet({ focus = true } = {}) {
  if (!ui.idleOpen) return;
  ui.idleOpen = false;
  renderProjectChips();
  if (focus) { const c = $('#pchips [data-idle-open]'); if (c) c.focus(); }
}

// ------------------------------------------------------------ detail sheet

// The sheet with no project open. On a board with no projects at all (a
// first run) it says how sessions get here, and what is missing when
// something is: the hooks (`ravenry setup`), or a terminal the board can
// answer in (docs/TERMINALS.md, Unsupported terminals: one line, iTerm2).
function emptyHtml() {
  const s = ui.snap;
  if (s && s.error) return `<div class="empty">${esc(s.error)}</div>`;
  if (!s || !s.generatedAt || (s.projects || []).length) return '<div class="empty">Pick a project on the left.</div>';
  const l = ['<p class="first-h">No sessions yet</p>', '<p>Start <span class="mono">claude</span> or <span class="mono">codex</span> in a project\'s folder, in any terminal, and it shows up here within a few seconds.</p>'];
  if (s.hooks && s.hooks !== 'ok') l.push(`<p>Ravenry's hooks are ${s.hooks === 'stale' ? 'out of date' : 'not installed'}, so it cannot see sessions yet. Run <span class="mono">ravenry setup</span> in a terminal.</p>`);
  if (s.board && s.board.installed === false) l.push('<p>Watch only: answering from the board needs iTerm2 (free), cmux or Rex. <a href="https://iterm2.com" target="_blank" rel="noopener">Get iTerm2</a></p>');
  return `<div class="empty first">${l.join('')}</div>`;
}

function buildSheet(p) {
  if (lv.full) closeFull({ back: false });
  ui.built = p ? p.id : null;
  ui.html = Object.fromEntries(Object.entries(ui.html).filter(([k]) => KEEP_HTML.includes(k)));
  const sheet = $('#sheet');
  if (!p) {
    ui.emptyHtml = emptyHtml();
    sheet.innerHTML = ui.emptyHtml;
    return;
  }
  sheet.innerHTML = `
<div class="strip" id="d-strip"></div>
<div class="body">
  <div class="headbox" id="d-headbox">
    <div id="d-head" style="display: flex; flex-direction: column; gap: 6px"></div>
    <div id="d-meta" class="t2" style="display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px"></div>
  </div>
  <div id="d-handoff"></div>
  <div id="d-shared"></div>
  <div class="cols">
    <div class="col-l">
      <div id="lv-slot-phone" class="lv-slot"></div>
      <div class="card" id="d-ask" style="padding: 18px; display: flex; flex-direction: column; gap: 14px">
        <div id="d-ask-top" style="display: flex; flex-direction: column; gap: 14px"></div>
        <div class="composer" id="composer">
          <textarea id="compose" rows="2" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
          <div id="chips" style="display: flex; flex-wrap: wrap; gap: 6px"></div>
          <div class="t3 ns-hint" id="ns-hint" hidden></div>
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
            <label class="attach"><svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 6.5L7 11.5a3 3 0 0 1-4.2-4.2L8 2.1a2 2 0 0 1 2.8 2.8L5.7 10"></path></svg>Attach<input type="file" multiple id="pick"></label>
            <button class="ns-tg" id="ns" role="switch" aria-checked="false"><span class="ns-sw"><i></i></span><span>New session</span></button>
            <span style="flex: 1"></span>
            <button class="btn sm" id="note">Add as note</button>
            <button class="btn sm pri" id="send">Send</button>
          </div>
        </div>
      </div>
      <div id="d-plan"></div>
      <div id="d-sessions"></div>
      <div id="d-objs" style="display: flex; flex-direction: column; gap: 16px"></div>
      <div class="card" style="overflow: hidden" id="d-timeline"></div>
    </div>
    <div class="col-r col-pin">
      <div id="lv-slot-desk" class="lv-slot"></div>
      <div id="d-pics"></div>
      <div class="card" style="overflow: hidden" id="d-notes"></div>
    </div>
  </div>
</div>`;
  const ta = $('#compose');
  ta.value = ui.drafts[p.id] || '';
  ui.ns = false;
  wireComposer(p.id);
  buildLive();
  pinRo.disconnect();
  pinRo.observe($('.col-pin'));
  pinColumn();
}

// On a desktop the right column (the Live screen, the picture, the notes)
// is pinned as one piece, as docs/design/LiveScreen.dc.html B draws it, so
// the Live screen never slides over the picture under it (it once hid the
// gallery when the page scrolled down). A column
// taller than the window moves with the page as far as it must and no
// further: scrolling down, until its foot is 12 px above the window's
// bottom; scrolling up, until its top is back at 12 px. So every part of
// it can be reached, and the Live screen's head comes back on the way up.
const pin = { top: 12, y: window.scrollY };
const pinRo = new ResizeObserver(() => pinColumn());
function pinColumn() {
  const c = $('.col-pin');
  const y = window.scrollY;
  const dy = y - pin.y;
  pin.y = y;
  if (!c) return;
  const low = Math.min(12, Math.floor(window.innerHeight - c.offsetHeight - 12));
  pin.top = Math.max(low, Math.min(12, pin.top - dy));
  const v = pin.top + 'px';
  if (c.style.top !== v) c.style.top = v;
}
window.addEventListener('resize', pinColumn);
window.addEventListener('scroll', pinColumn, { passive: true });

function renderSheet() {
  const p = project(ui.sel);
  if (!p) { if (ui.built !== null || !$('#sheet').innerHTML || ui.emptyHtml !== emptyHtml()) buildSheet(null); return; }
  if (ui.built !== p.id) buildSheet(p);
  const { s, w, state } = view(p);
  const t = ST[state];

  // Strip: breadcrumb, context, open in cmux
  const ctx = s && s.ctx;
  // The orange tick follows the Settings card's line, and goes when hand-off is off.
  const hc = handoffCfg();
  const past = !!(hc.enabled && ctx && ctx.pct >= hc.threshold);
  setHtml('d-strip', `<span class="t3" style="font-size: 12.5px; flex: 1 1 auto">${p.unowned ? 'Not in a project' : 'Projects'}<span style="padding: 0 6px">/</span><span style="color: var(--tx2)">${esc(p.name)}</span></span>
<span class="t2" style="font-size: 12px" id="ctx-l">Context</span>
<div class="bar" style="width: 150px" role="meter" aria-labelledby="ctx-l" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${ctx ? Math.round(ctx.pct) : 0}" aria-valuetext="${esc(ctxLabel(ctx))}${past ? `, past the ${hc.threshold}% hand-off line` : ''}"><div class="f" style="width: ${ctx ? ctx.pct.toFixed(1) : 0}%; background: ${past ? 'var(--work)' : 'var(--tx)'}"></div>${hc.enabled ? `<div class="m" style="left: ${hc.threshold}%" title="Hand-off line at ${hc.threshold}%"></div>` : ''}</div>
<span class="num" style="font-size: 12px">${esc(ctxLabel(ctx))}</span>
${s && (s.memKb != null || s.live) ? `<span class="strip-sep" aria-hidden="true"></span><span class="t2" style="font-size: 12px">Memory</span><span class="num ${s.memKb != null ? '' : 't3'}" style="font-size: 12px" title="${esc(s.memKb != null ? 'Resident memory of its claude process, read every minute' : 'No claude process is mapped to this session')}">${s.memKb != null ? esc(fmtMem(s.memKb)) : 'not mapped'}</span>` : ''}
${handoffButton(s)}
${openButton(p, s)}`);

  // Hand-off card: the four clean-point checks while queued (the design's
  // "checks" card), then what happened.
  setHtml('d-handoff', handoffCard(p, s));

  // Head: status line, title, meta
  const since = parseT(state === 'idle' ? p.since : (s && s.since) || p.since);
  let statusLine;
  if (state === 'you') statusLine = since ? 'Needs you since ' + longSince(since) : 'Needs you';
  else if (state === 'work') statusLine = 'Working now';
  else if (state === 'wait') statusLine = 'Waiting on someone else' + (since ? ' since ' + longSince(since) : '');
  else if (p.brief && p.brief.parked) statusLine = 'Parked' + (p.brief.parked.since ? ' ' + p.brief.parked.since : '');
  else statusLine = 'Idle' + (since ? ', last touched ' + rel(since) + ' ago' : '');
  // The reason line names where the state came from: Ravenry's hook
  // events first, the screen when a session has none (docs/STATE-RULES.md).
  const SOURCE = { events: 'From hook events', screen: 'Read from the screen' };
  const gateHere = !!(p.planGate && p.plan && (!s || s.surfaceId === p.primary));
  const why = gateHere ? `From the plan: step ${p.planGate.n} is ${p.planGate.unforeseen ? 'not in the plan, so it stopped to ask' : `a gate, "${p.planGate.text.charAt(0).toLowerCase() + p.planGate.text.slice(1)}"`}`
    : s ? `${SOURCE[s.source] || SOURCE.screen}: ${s.reasons.join('; ')}` : `No ${projWho(p)} session in this project`;
  const meta = [];
  // On the Mac the folder opens in Finder; a phone keeps it plain text.
  meta.push(ui.local === true && p.folder ? `<button class="linkish fold-open" data-act="open-folder" data-pid="${escRaw(p.id)}" title="Open in Finder">${esc(p.folderShort || p.folder)}</button>` : `<span>${esc(p.folderShort || 'No folder')}</span>`);
  // Not in a project: its cmux workspace instead of a brief's kind and stage.
  if (p.unowned) meta.push(`<span>cmux workspace ${esc(p.workspaceTitle || p.name)}</span>`);
  else if (p.brief) {
    if (p.brief.kind) meta.push(`<span>${esc(p.brief.kind)}</span>`);
    meta.push(`<span>${esc(p.brief.stage ? p.brief.stage + ' stage' : 'No stage')}</span>`);
  } else meta.push('<span>No brief yet</span>');
  if (s && s.sessionId) meta.push(`<span title="${esc('Found by ' + s.method)}">Session ${esc(s.sessionId.slice(0, 8))}, via ${esc(s.method)}</span>`);
  // Codex reports a session id with its first prompt (docs/ASSISTANTS.md).
  else if (p.unowned && s && asKind(s.assistant) === 'codex' && s.live) meta.push('<span>Session not started yet: Codex reports it with its first prompt</span>');
  else meta.push('<span>No session</span>');
  // "New sessions:" and its Claude / Codex switch, last on the line.
  if (!p.unowned) meta.push(pasHtml(p));
  setHtml('d-head', `<div style="display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; color: ${t.c}" title="${esc(why)}">${stateIcon(t, state === 'you' ? 'pulse' : '')}${esc(statusLine)}<span class="sr-only">. </span></div>
<div class="t3" id="d-why" style="font-size: 12px; line-height: 1.4; overflow-wrap: anywhere">${esc(why)}</div>
<h1 style="margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em">${esc(p.name)}</h1>`);
  setHtml('d-meta', meta.join(''));

  // Shared folder card, or for a session that is not in a project the "Not
  // in a project" card (docs/design/CodexStage2.dc.html, section 1).
  if (p.unowned) setHtml('d-shared', unCardHtml(p));
  else setHtml('d-shared', p.shared.length ? `<div class="card" style="padding: 11px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px">
<span style="width: 8px; height: 8px; border-radius: 50%; background: var(--bad)" aria-hidden="true"></span>
<span style="flex: 1 1 0; min-width: 0">Shares its folder with <b>${esc(joinNames(p.shared))}</b>. Two agents in one folder can overwrite each other's work.</span></div>` : '');

  // Ask card top
  const ask = $('#d-ask');
  ask.style.background = state === 'you' ? 'var(--you-t)' : 'var(--card)';
  ask.classList.toggle('pl-gate', gateHere);
  const sent = ui.sent[p.id];
  const showSent = sent && Date.now() - sent.at < 120000;
  const cardTitle = state === 'idle' && p.brief && p.brief.parked ? 'Parked' : (state === 'you' && s && s.state === 'handback' ? 'Handed back to you' : t.card);
  const live = p.sessions.some((x) => x.live);
  let headline = w.headline || (state === 'idle' ? (p.brief && p.brief.goal ? p.brief.goal : live ? 'At the prompt, nothing pending.' : `No ${projWho(p)} session running.`) : '');
  // While it works, the label carries the working dot, breathing
  // (docs/design/LiveCode.dc.html, S2).
  const doing = state === 'work' && cardTitle === t.card;
  let top = `<h2 style="margin: 0; font-size: 12.5px; font-weight: 600; color: ${t.c}${doing ? '; display: flex; align-items: center; gap: 7px' : ''}">${doing ? stateIcon(t, 'doing') : ''}${esc(cardTitle)}</h2>
<div style="font-size: 16px; line-height: 1.45; font-weight: 500; overflow-wrap: anywhere">${esc(headline)}</div>`;
  if (w.dialog && w.dialog.length) top += `<div class="t2 scr-lines">${w.dialog.slice(0, 8).map((l) => `<div${SCREEN_RULE.test(l) ? ' class="scr-rule"' : ''}>${esc(l)}</div>`).join('')}</div>`;
  if (w.draft) top += `<div class="t2" style="font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere">Typed in its prompt, not sent: "${esc(w.draft.length > 160 ? w.draft.slice(0, 157) + '...' : w.draft)}"</div>`;
  top += followLine(p);
  if (showSent) top += `<div style="font-size: 13px; color: var(--ok); font-weight: 600">Sent "${esc(sent.label)}". ${sent.delivered === 'now' ? "It's back to work." : 'Delivered after its current step.'}</div>`;
  if (state === 'you' && !showSent && w.quick && w.quick.length && s && s.live && !s.draft) {
    top += `<div class="q-opts" style="display: flex; flex-wrap: wrap; gap: 8px">${w.quick.map((o, k) => `<button class="btn ${k === 0 ? 'pri' : ''}" data-act="quick" data-k="${k}">${esc(o.label)}</button>`).join('')}</div>`;
  }
  if (p.brief && p.brief.parked && state === 'idle') {
    const pk = p.brief.parked;
    top += `<div class="t2" style="line-height: 1.5">Parked${pk.since ? ' ' + esc(pk.since) : ''}.${pk.why ? ' Why: ' + esc(pk.why) + '.' : ''}${pk.back ? ' Comes back when: ' + esc(pk.back) + '.' : ''}</div>`;
  }
  if (state === 'idle' && !p.unowned) {
    top += `<div style="display: flex; gap: 8px; flex-wrap: wrap"><button class="btn" data-act="revive" data-pid="${escRaw(p.id)}" ${!p.folder && boardTerm() !== 'cmux' ? `disabled title="${escRaw(p.name)} has no folder, so there is nowhere to start its session"` : p.brief ? `title="Opens a new tab running ${projWho(p)}, which reads the brief (Hand-off section first)"` : 'disabled title="Write the brief first, so the new session has something to read"'}>Revive from the brief</button>${p.brief ? '' : `<button class="btn" data-act="write-brief" data-pid="${escRaw(p.id)}" ${p.folder ? '' : 'disabled title="No folder on disk"'}>Write the brief</button>`}</div>`;
  }
  // A plan waiting at a gate: the answer card becomes the gate card.
  if (gateHere) top = gateTopHtml(p);
  setHtml('d-ask-top', top);

  // Composer state
  const ta = $('#compose');
  const canSend = !!(s && s.live && !s.dialog && !s.draft);
  let label = 'Message';
  const tn = termOf(s);
  if (s && s.terminal === false) label = (s.cannotType || `This session runs outside ${boardTerm()}, so the board cannot type into it`).replace(/\.$/, '');
  else if (!s && boardTerm() !== 'cmux') label = `No ${projWho(p)} session is running here. Revive it from the brief to start one`;
  else if (!s || !s.live) label = `No ${projWho(p)} session is running here. Open it in ${tn} to start one`;
  else if (s.dialog && !(w.quick && w.quick.some((o) => o.choice != null))) label = `A prompt is open in its tab (a permission or a question). Answer it in ${tn}`;
  else if (s.dialog) label = `A choice is open on screen. Pick an option above or answer in ${tn}`;
  else if (s.draft) label = `Its prompt already holds a half-typed reply. Finish or clear it in ${tn} first, so the two are not mixed`;
  else if (gateHere) label = 'Or answer in your own words. The plan carries on from your answer';
  else if (state === 'you') label = 'Write an answer';
  else if (s.working) label = 'Message, delivered after its current step';
  let ph = canSend && !gateHere ? label + '. Paste a path, or drop or paste a file.' : label + '.';
  // The New session switch (docs/design/NewSession.dc.html, D): on, the
  // same box starts a new session in the project's folder.
  const ns = ui.ns;
  const canStart = !!p.folder || boardTerm() === 'cmux';
  if (ns) { label = 'First message of the new session, optional'; ph = label; }
  if (ta.placeholder !== ph) { ta.placeholder = ph; ta.setAttribute('aria-label', label); }
  ta.disabled = ns ? !canStart : !canSend && !p.brief && !gateHere;
  $('#send').disabled = ns ? !canStart : !canSend && !gateHere;
  const sendWord = ns ? 'Start session' : 'Send';
  if ($('#send').textContent !== sendWord) $('#send').textContent = sendWord;
  $('#composer').classList.toggle('ns-mode', ns);
  // In a project that continues on Codex, the switch's line says so.
  const hint = $('#ns-hint');
  const nsCodex = ns && canStart && p.assistant === 'codex';
  const hintHtml = nsCodex ? `Opens a new ${esc(boardTerm())} tab${p.folderShort ? ` in ${esc(p.folderShort)}` : ''} running <span class="as-tag" title="Codex session">Codex</span>, this project's assistant.` : '';
  if (hint.hidden !== !nsCodex) hint.hidden = !nsCodex;
  if (hint.innerHTML !== hintHtml) hint.innerHTML = hintHtml;
  const tg = $('#ns');
  tg.classList.toggle('on', ns);
  tg.setAttribute('aria-checked', ns ? 'true' : 'false');
  tg.title = canStart ? `Send this as the first message of a new session in ${p.name}` : `${p.name} has no folder, so there is nowhere to start a session`;
  // Add as note and the New session switch need a project.
  $('#note').hidden = !!p.unowned;
  tg.hidden = !!p.unowned;
  $('#note').disabled = !p.brief;
  $('#note').title = p.brief ? 'Adds the text to the Notes in ' + p.brief.path : 'This project has no BRIEF.md yet';
  renderChips(p.id);

  // Sessions (only when there is more than one)
  // Newest started first, handed-off sessions below every open one.
  const startMs = (x) => (x.startedAt ? Date.parse(x.startedAt) : 0);
  const many = p.sessions.filter((x) => x.live || x.state !== 'none')
    .sort((a, b) => (a.handed - b.handed) || (startMs(b) - startMs(a)));
  // A session started from the New session switch reads "Starting" (a
  // dashed blue ring) until its first hook event; a row of its own until
  // its tab shows on the board. A minute at most, for boards with no hooks.
  const go = ui.starting[p.id];
  const fresh = go && p.sessions.find((x) => (go.surfaceId ? x.surfaceId === go.surfaceId : !go.before.includes(x.surfaceId)));
  if (go && ((fresh && fresh.source === 'events') || Date.now() - go.at > 60000)) delete ui.starting[p.id];
  const startingId = ui.starting[p.id] && fresh ? fresh.surfaceId : null;
  const pending = ui.starting[p.id] && !(fresh && many.includes(fresh));
  if (many.length + (pending ? 1 : 0) > 1) {
    const memSum = many.reduce((n, x) => n + (x.memKb || 0), 0);
    const startRow = (on) => `${stateIcon(ST_STARTING)}
<span style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: ${on ? 600 : 400}">${esc(go.topic)}</span>
<span style="font-size: 11.5px; font-weight: 600; color: var(--work)">Starting</span>
<span class="num t3" style="font-size: 11.5px; flex: 0 0 auto"></span>
<span class="num" style="font-size: 11.5px; flex: 0 0 52px; text-align: right"></span>`;
    setHtml('d-sessions', `<div class="card" style="overflow: hidden"><h2 class="card-h"><span style="flex: 1">Sessions</span><span class="t2" style="font-weight: 500; font-size: 12px">${many.length + (pending ? 1 : 0)} in ${p.workspaces.length > 1 ? p.workspaces.length + ' workspaces' : 'this workspace'}${memSum ? ', ' + esc(fmtMem(memSum)) : ''}</span></h2>
${many.map((x) => {
  const xs = ST[SESSION_STATE[x.state] || 'idle'];
  const on = s && x.surfaceId === s.surfaceId;
  if (x.surfaceId === startingId) return `<button class="sess card-r ${on ? 'sel' : ''}" data-act="session" data-surface="${escRaw(x.surfaceId)}" ${on ? 'aria-current="true"' : ''} aria-label="${esc(`${go.topic}, Starting`)}">${startRow(on)}</button>`;
  return `<button class="sess card-r ${on ? 'sel' : ''}" data-act="session" data-surface="${escRaw(x.surfaceId)}" ${on ? 'aria-current="true"' : ''} aria-label="${esc(`${x.topic}, ${SESSION_WORD[x.state]}, context ${ctxLabel(x.ctx)}${x.memKb != null ? ', memory ' + fmtMem(x.memKb) : ''}`)}">
${stateIcon(xs)}
<span class="ss-t"><span class="ss-n" style="font-weight: ${on ? 600 : 400}">${esc(x.topic)}</span>${asTag(x.assistant)}</span>
<span style="font-size: 11.5px; font-weight: 600; color: ${xs.c}">${esc(SESSION_WORD[x.state])}</span>
<span class="num t3" style="font-size: 11.5px; flex: 0 0 auto">${esc(x.ctx ? ctxLabel(x.ctx).split(' ')[0] : '')}</span>
<span class="num" style="font-size: 11.5px; flex: 0 0 52px; text-align: right">${x.memKb != null ? esc(fmtMem(x.memKb)) : ''}</span></button>`;
}).join('')}${pending ? `<div class="sess card-r ns-starting" role="status" aria-label="${esc(`${go.topic}, Starting`)}">${startRow(false)}</div>` : ''}</div>`);
  } else setHtml('d-sessions', '');

  // The Plan card (docs/design/Plans.dc.html, A), then the other objectives.
  // A session not in a project has no brief, plan or notes.
  for (const id of ['d-timeline', 'd-notes']) { const el = document.getElementById(id); if (el) el.hidden = !!p.unowned; }
  setHtml('d-plan', p.unowned ? '' : planCardHtml(p));
  let objs = '';
  const allObjs = objectivesOf(p).filter((o) => !(p.plan && o.plan && o.title === p.plan.title));
  if (allObjs.length) {
    for (const o of allObjs) {
      if (o.tasks.length) {
        const n = o.tasks.length;
        const done = o.tasks.filter((x) => x.state === 'done').length;
        objs += `<div class="card" style="overflow: hidden"><h2 class="card-h"><span style="flex: 1">${esc(o.title)}</span><span class="num t2" style="font-weight: 500">${done} of ${n}</span></h2>
<div style="padding: 0 16px 12px"><div class="bar"><div class="f" style="width: ${Math.round(done / n * 100)}%; background: var(--tx)"></div></div></div>
${o.tasks.map((x) => { const c = taskDot(x.state); return `<div class="card-r" style="color: ${c.tc}"><span class="dot" style="${c.dotStyle}"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="${c.check}" stroke="#FFFFFF" stroke-width="2" fill="none"></path></svg></span><span style="flex: 1; font-weight: ${c.fw}">${esc(x.text)}<span class="sr-only">, ${esc(x.state === 'done' ? 'done' : x.state === 'now' ? 'in progress' : x.state === 'you' ? 'waiting on you' : x.state === 'wait' ? 'waiting on someone else' : 'to do')}</span></span>${c.tag ? `<span style="font-size: 11.5px; font-weight: 600; color: ${c.tagC}" aria-hidden="true">${c.tag}</span>` : ''}</div>`; }).join('')}</div>`;
      } else if (o.progress) {
        const pct = o.progress.total ? Math.round(o.progress.done / o.progress.total * 100) : 0;
        objs += `<div class="card" style="overflow: hidden"><h2 class="card-h"><span style="flex: 1">${esc(o.title)}</span><span class="num t2" style="font-weight: 500">${o.progress.done} of ${o.progress.total}</span></h2>
<div style="padding: 0 16px 12px"><div class="bar"><div class="f" style="width: ${pct}%; background: var(--tx)"></div></div></div>
${o.source || o.updatedAt ? `<div class="card-r t2" style="font-size: 12px">${esc([o.source, o.updatedAt ? 'updated ' + ago(o.updatedAt) : ''].filter(Boolean).join(', '))}</div>` : ''}</div>`;
      }
    }
    if (p.brief && p.brief.next) objs += `<div class="card" style="overflow: hidden"><h2 class="card-h">Next step</h2><div class="card-r" style="line-height: 1.45">${esc(p.brief.next)}</div></div>`;
  } else if (p.plan) {
    // Only the running plan: the Plan card above says it all.
    if (p.brief && p.brief.next) objs = `<div class="card" style="overflow: hidden"><h2 class="card-h">Next step</h2><div class="card-r" style="line-height: 1.45">${esc(p.brief.next)}</div></div>`;
  } else {
    const msg = p.brief ? 'The brief has no plan yet' : 'Write the brief to start tracking';
    objs = `<div class="card" style="overflow: hidden"><h2 class="card-h"><span style="flex: 1">${p.brief && p.brief.goal ? esc(p.brief.goal) : 'No objective yet'}</span></h2>
<div style="padding: 0 16px 12px"><div class="bar"><div class="f" style="width: 0%; background: var(--tx)"></div></div></div>
<div class="card-r t2" style="font-size: 12px"><span style="flex: 1">${esc(msg)}</span>${!p.brief && p.folder && state !== 'idle' ? `<button class="btn sm" data-act="write-brief" data-pid="${escRaw(p.id)}">Write the brief</button>` : ''}</div></div>`;
  }
  setHtml('d-objs', p.unowned ? '' : objs);

  // Hand-backs
  const tl = s && !(s.surfaceId === p.primary) ? [] : p.timeline.slice();
  const hr = p.handoffRecent;
  if (hr && (!s || s.surfaceId === p.primary || s.sessionId === hr.sessionId)) tl.unshift({ at: hr.resumedAt, text: `Clean point after the task. Hand-off written to ${hr.fileName}, and a fresh session read it and carried on.` });
  setHtml('d-timeline', `<h2 class="card-h">Hand-backs</h2>${tl.length ? tl.map((x) => `<div class="card-r" style="align-items: flex-start"><span class="num t3" style="flex: 0 0 64px; font-size: 12px">${esc(whenLabel(x))}</span><span style="line-height: 1.45; min-width: 0; overflow-wrap: anywhere">${esc(x.text)}</span></div>`).join('') : `<div class="card-r t2">${s && s.surfaceId !== p.primary ? 'Shown for the main session of this project.' : 'Nothing handed back yet.'}</div>`}`);

  // Pictures (only if any). The session's picture opens the gallery
  // (docs/design/Gallery.dc.html, B).
  const pics = p.brief ? p.brief.pictures : [];
  setHtml('d-pics', pics.length ? `<div class="card" style="overflow: hidden; display: flex; flex-direction: column; gap: 2px">${pics.map((x) => x.auto ? cardPicture(p, x, { esc, escRaw }) : `<img class="pic" src="${escRaw(x.url)}" alt="${esc(x.alt)}">`).join('')}</div>` : '');
  if (gallery) gallery.sync();

  // Notes
  const notes = p.brief ? p.brief.notes.slice().sort((a, b) => a.fixed - b.fixed) : [];
  const open = notes.filter((n) => !n.fixed).length;
  setHtml('d-notes', `<h2 class="card-h"><span style="flex: 1">Notes</span><span class="t2" style="font-weight: 500; font-size: 12px">${notes.length ? `${open} open, ${notes.length - open} fixed` : ''}</span></h2>
${notes.map((n) => `<div class="card-r" style="align-items: flex-start"><span class="dot" style="${n.fixed ? 'background:var(--ok)' : 'border:2px solid var(--you)'}; margin-top: 1px"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="${n.fixed ? CHECK : ''}" stroke="#FFFFFF" stroke-width="2" fill="none"></path></svg></span><span style="flex: 1; line-height: 1.4; min-width: 0; overflow-wrap: anywhere">"${esc(n.text)}"</span><span style="font-size: 11.5px; font-weight: 600; color: ${n.fixed ? 'var(--ok)' : 'var(--you)'}">${n.fixed ? 'Fixed' : 'Open'}</span></div>`).join('')}
${notes.length ? '' : `<div class="card-r t2">${p.brief ? 'None. "Add as note" tracks one until it\'s fixed.' : 'None. Notes live in the brief, and this project has none yet.'}</div>`}`);

  renderLive(p, s, state);
}

// ------------------------------------------------------------ not in a project
// docs/design/CodexStage2.dc.html, section 1: a session in a cmux workspace no
// project lists has no brief, plan or notes, so its sheet carries this card:
// Add to a project (a menu of the projects; the workspace joins the one
// picked, POST /api/project/add-workspace) or New project from this folder
// (the New project form, its name, the folder and the session's assistant
// filled in, and the workspace joining the new project).

function unCardHtml(p) {
  const open = ui.unPick === p.id;
  const list = (ui.snap.projects || []).filter((x) => !x.unowned && !x.loose).sort((a, b) => a.name.localeCompare(b.name));
  const pop = open ? `<div class="un-pop" role="menu" aria-label="Add to a project"><div class="un-ph">Add ${esc(p.name)} to</div>${list.length ? list.map((x) => `<button role="menuitem" data-un-add="${escRaw(x.id)}"><span class="un-dot" style="background: ${(ST[x.state] || ST.idle).c}"></span><span class="ell">${esc(x.name)}</span></button>`).join('') : '<div class="un-pf" style="border-top: 0; margin-top: 0">No project yet. Make one from this folder.</div>'}<div class="un-pf">The workspace joins that project: its sessions show there from now on. The folder stays where it is.</div></div>` : '';
  return `<div class="card un-card"><div class="un-t"><b>Not in a project</b><span class="t2">No project lists this cmux workspace, so it has no brief, plan or notes. Its session answers here like any other.</span></div>
<div class="un-b"><button class="btn sm pri" data-un="pick" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}">Add to a project</button><button class="btn sm" data-un="new" ${p.folder ? '' : 'disabled title="This workspace has no folder of its own, so a project cannot start there"'}>New project from this folder</button></div>${pop}</div>`;
}

async function unAdd(fromId, projectId) {
  const p = project(fromId);
  ui.unPick = null;
  try {
    const r = await post('/api/project/add-workspace', { from: fromId, projectId });
    toast(`${p ? p.name : 'The session'} joined ${r.project}. Its sessions show there from now on.`);
    ui.sel = r.projectId;
    store.set('sel', r.projectId);
    history.replaceState(null, '', '#' + encodeURIComponent(r.projectId));
  } catch (e) { toast(e.message, 4500); }
  render();
}

function unNewProject(p) {
  ui.unPick = null;
  const s = mainSession(p);
  // "kite-tracker" -> "Kite Tracker".
  const name = p.name.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
  openModal({ mode: 'new', prefill: { name }, from: { id: p.id, name: p.name, folder: p.folder, folderShort: p.folderShort, workspaceId: (p.workspaces[0] || {}).id, assistant: s ? asKind(s.assistant) : null } });
}

document.addEventListener('click', (e) => {
  const u = e.target.closest('[data-un], [data-un-add]');
  if (u && u.dataset.unAdd) { unAdd(ui.sel, u.dataset.unAdd); return; }
  if (u && u.dataset.un === 'pick') { ui.unPick = ui.unPick === ui.sel ? null : ui.sel; renderSheet(); const first = $('.un-pop button'); if (first && ui.unPick) first.focus(); return; }
  if (u && u.dataset.un === 'new') { const p = project(ui.sel); if (p) unNewProject(p); return; }
  if (ui.unPick && !e.target.closest('.un-pop')) { ui.unPick = null; if (ui.view === 'projects') renderSheet(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.unPick) { ui.unPick = null; renderSheet(); const b = $('[data-un="pick"]'); if (b) b.focus(); } });

// ------------------------------------------------------------ live screen
// docs/design/LiveScreen.dc.html, variant B, with a shorter default height
// than the design's, as asked when B was picked. The
// server trims the screen (server/screen.mjs, trimScreen) and sends it only
// for the session shown here (GET /api/live); the snapshot carries just the
// time of each read. On a desktop the card leads the right column, pinned
// while the left column scrolls; on a phone it sits under the title. Full
// screen holds the terminal at a reading width with the composer under it.

const LV_ICON = {
  expand: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9"></path></svg>',
  shrink: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" style="vertical-align: -1px; margin-right: 5px"><path d="M13.5 6.5h-4v-4M9.5 6.5L14 2M2.5 9.5h4v4M6.5 9.5L2 14"></path></svg>',
  down: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 1.5v8M2.5 6.5L6 10l3.5-3.5"></path></svg>',
  back: '<svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 2L2 8l6 6"></path></svg>',
};
const LV_PHONE = window.matchMedia('(max-width: 700px)');
const LV_BOX = /^\s*[│├┼┤└┘┌┐╭╮╰╯┃━┏┓┗┛║═╔╗╚╝┬┴]/;
const lv = {
  sid: null,       // surface read (null when there is no screen to read)
  key: null,       // what the card shows: a surface, a watch-only session, or none
  watch: false,    // a watch-only session: the board cannot read its screen
  term: 'cmux',    // the terminal it is in, by name
  at: null,        // server time of its last good read (ms)
  keys: [],        // html of each entry on screen
  base: [],        // each entry without its code spans (lvBase)
  counts: [],      // lines in each entry
  follow: true,    // stuck to the bottom
  fresh: 0,        // lines that arrived while scrolled up
  pending: false,
  full: false,
  empty: '',       // the message shown when there is no screen
};

// Mac time minus the board's time, from each snapshot, so a phone with a
// different clock still ages the read right.
function serverNow() { return Date.now() - (ui.skew || 0); }

function buildLive() {
  if (lv.full) closeFull({ back: false });
  lv.sid = null; lv.key = null; lv.watch = false; lv.at = null; lv.ver = null; lv.keys = []; lv.base = []; lv.counts = []; lv.follow = true; lv.fresh = 0; lv.empty = '';
  const card = document.createElement('div');
  card.className = 'card lv-card';
  card.id = 'lv-card';
  card.innerHTML = `<div class="lv-h"><h2 class="card-h">Live screen</h2><span class="as-tag" id="lv-tag" hidden></span><span class="fresh" data-fresh="card"><i></i><span></span></span><span class="sp"></span><button class="icon-btn lv-exp" id="lv-exp" aria-label="Full screen" title="Full screen">${LV_ICON.expand}</button><button class="lv-tap" id="lv-tap">${LV_ICON.expand}Tap to expand</button></div>
<div class="lv" id="lv">
<div class="lv-scroll" id="lv-scroll" tabindex="0" role="log" aria-label="Live screen: the terminal, trimmed"><div class="measure" id="lv-lines"></div></div>
<button class="lv-jump" id="lv-jump" hidden>${LV_ICON.down}<span></span></button>
<div class="lv-st" id="lv-st" hidden></div>
</div>`;
  placeLive(card);
  const sc = card.querySelector('#lv-scroll');
  sc.addEventListener('scroll', () => {
    const atEnd = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 24;
    if (atEnd) { lv.follow = true; lv.fresh = 0; } else lv.follow = false;
    renderJump();
  }, { passive: true });
  card.querySelector('#lv-jump').addEventListener('click', (e) => { e.stopPropagation(); toBottom(); });
  card.querySelector('#lv-exp').addEventListener('click', openFull);
  card.querySelector('#lv-tap').addEventListener('click', (e) => { e.stopPropagation(); openFull(); });
  // On a phone the whole card opens full screen; a drag still scrolls it.
  card.addEventListener('click', (e) => {
    if (!LV_PHONE.matches || lv.full || e.target.closest('a, button, .cd')) return;
    openFull();
  });
}

function placeLive(card = $('#lv-card')) {
  if (!card) return;
  const slot = $(LV_PHONE.matches ? '#lv-slot-phone' : '#lv-slot-desk');
  if (slot && card.parentElement !== slot) {
    slot.appendChild(card);
    if (lv.follow) toBottom();
  }
}
LV_PHONE.addEventListener('change', () => { placeLive(); if (lv.full) renderFullBar(); });

function toBottom() {
  const sc = $('#lv-scroll');
  if (!sc) return;
  sc.scrollTop = sc.scrollHeight;
  lv.follow = true;
  lv.fresh = 0;
  renderJump();
}

function renderJump() {
  const b = $('#lv-jump');
  if (!b) return;
  const show = !lv.follow && lv.fresh > 0;
  b.hidden = !show;
  if (!show) return;
  b.querySelector('span').textContent = `${lv.fresh} new line${lv.fresh === 1 ? '' : 's'}, jump to latest`;
  const st = $('#lv-st');
  b.style.bottom = (st && !st.hidden ? st.offsetHeight : 0) + 12 + 'px';
}

// Words for the freshness dot, in three lengths: the card, the phone card,
// and the phone's full-screen bar. A watch-only session is never read, so
// it promises no read: "Watch only" in every form.
function freshWords(form) {
  if (lv.watch) return { kind: 'watch', text: 'Watch only' };
  if (lv.at == null) return { kind: 'stale', text: form === 'tiny' ? 'No read' : 'Not read yet' };
  const age = Math.max(0, serverNow() - lv.at) / 1000;
  const n = Math.max(1, Math.round(age));
  const span = n < 120 ? `${n} s` : `${Math.round(n / 60)} min`;
  if (age < 5) return { kind: 'live', text: form === 'tiny' ? 'Live' : form === 'short' ? `Live, ${span} ago` : `Live, read ${span} ago` };
  if (age <= 30) return { kind: 'slow', text: form === 'tiny' ? 'Slow' : form === 'short' ? `Slow, ${span}` : `Slow, last read ${span} ago` };
  return { kind: 'stale', text: form === 'tiny' ? 'Not updating' : form === 'short' ? `Not updating, ${span}` : `Not updating, last read ${span} ago` };
}

function renderFresh() {
  let kind = 'stale';
  for (const el of document.querySelectorAll('[data-fresh]')) {
    const form = el.dataset.fresh === 'bar' ? (LV_PHONE.matches ? 'tiny' : 'long') : (LV_PHONE.matches ? 'short' : 'long');
    const f = freshWords(form);
    kind = f.kind;
    el.className = 'fresh ' + f.kind;
    el.title = lv.watch ? lv.empty : `The board reads ${lv.asst === 'codex' ? "Codex's" : "Claude's"} screen every 2 s`;
    const t = el.querySelector('span');
    if (t.textContent !== f.text) t.textContent = f.text;
    el.hidden = !!lv.empty && !lv.watch;
  }
  const box = $('#lv');
  if (box) box.classList.toggle('stale', kind === 'stale' && !lv.empty);
}
setInterval(() => { if ($('#lv')) renderFresh(); }, 1000);

// A line of terminal text: links made clickable, the rest verbatim.
function lvText(s) {
  const parts = String(s).split(/(https?:\/\/[^\s<>"'`]+)/);
  return parts.map((x, k) => {
    if (k % 2 === 0) return escRaw(x);
    const m = x.match(/^(.*?)([.,;:!?)\]]*)$/);
    return `<a class="lnk" href="${escRaw(m[1])}" target="_blank" rel="noopener noreferrer">${escRaw(m[1])}</a>${escRaw(m[2])}`;
  }).join('');
}
// Code spans (docs/design/LiveCode.dc.html, C): the server marks, in each
// Claude entry, the text its own message had in backticks (server/
// codespans.mjs), as `cs`: [{ t, cmd?, b?, whole?, r: [[line, start, end], ...] }].
// Two kinds, and only the first carries a Copy button:
// - A code block (`b`: a fenced block, or a "! " command alone on its line)
//   is one block of its own, however the terminal wrapped it, copying its
//   whole text: on a desktop with a Copy icon inside the block ("Copy" on
//   hover); on a phone with no button, a tap on the block copies it.
// - Inline code in a sentence is a chip in the text, at the text's line
//   height, with no button in the line (a Copy floats over it on hover, a
//   tap copies it on a phone; see lvChip).
// On a phone nothing on the Live screen is a Copy button: a tap on the
// highlighted code copies, and it rings green with a check for 1.5 s.
// Terminal text is always text: every piece goes through escRaw.
const LV_COPY = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.6"/><path d="M9.5 2.6V2.5A1 1 0 0 0 8.5 1.5H3A1.5 1.5 0 0 0 1.5 3v5.5a1 1 0 0 0 1 1h.1"/></svg>';
const LV_CHECK = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7"/></svg>';
const lvCopyIn = (done) => (done ? `${LV_CHECK}<span>Copied</span>` : `${LV_COPY}<span class="w">Copy</span>`);
// Every other chip copies too: on a desktop a Copy button floats past its
// end while the pointer is on any piece of the span (nothing at rest, so
// prose stays clean, and nothing moves); on a phone a tap on the chip copies
// and rings it green with a check. data-lv-chip carries the whole span's
// text, data-lv-i its place in the entry, so a wrapped span's pieces hover
// and copy as one.
function lvChip(text, span, last, i) {
  const t = escRaw(span.t);
  return `<span class="cd pl${last ? ' lst' : ''}" data-lv-chip="${t}" data-lv-i="${i}">${escRaw(text)}${last ? `<span class="cpa"><button class="cph" data-lv-copy="${t}" aria-label="Copy ${t}" title="Copy">${lvCopyIn(false)}</button></span>` : ''}</span>`;
}
// A code block: its text as one block (pre-wrap, so the screen width wraps
// it, never a split into chips), indented as on screen, the desktop's Copy
// icon at its end.
function lvBlock(shown, span, i, indent) {
  const t = escRaw(span.t);
  return `<div class="cbw"${indent ? ` style="margin-left: ${indent}ch"` : ''}><div class="cd cb" data-lv-chip="${t}" data-lv-i="${i}"><span class="cbt">${escRaw(shown)}</span><button class="cp" data-lv-copy="${t}" aria-label="Copy ${t}" title="Copy">${lvCopyIn(false)}</button></div></div>`;
}
// One line of text from `from` on, with its marks ([start, end, span, last]).
function lvMarked(x, from, marks) {
  if (!marks || !marks.length) return lvText(x.slice(from));
  let out = '';
  let at = from;
  for (const [a0, b, span, last, i] of marks) {
    const a = Math.max(a0, at);
    if (b <= a) continue;
    out += lvText(x.slice(at, a)) + lvChip(x.slice(a, b), span, last, i);
    at = b;
  }
  return out + lvText(x.slice(at));
}
// Logical lines with a hanging indent for list items; tables and frames
// stay as drawn, in a box that scrolls sideways.
function lvLines(l, cs) {
  const byLine = new Map();
  const blocks = new Map(); // first line -> { span, i, hi }
  for (const [i, span] of (cs || []).entries()) {
    if (span.b) {
      const ls = span.r.map(([li]) => li);
      blocks.set(Math.min(...ls), { span, i, hi: Math.max(...ls) });
      continue;
    }
    span.r.forEach(([li, a, b], k) => {
      if (!byLine.has(li)) byLine.set(li, []);
      byLine.get(li).push([a, b, span, k === span.r.length - 1, i]);
    });
  }
  for (const m of byLine.values()) m.sort((x, y) => x[0] - y[0]);
  const out = [];
  let pre = [];
  const flush = () => { if (pre.length) { out.push(`<div class="pre">${pre.map(escRaw).join('\n')}</div>`); pre = []; } };
  const ind = (x) => x.match(/^ */)[0].length;
  for (let li = 0; li < l.length; li++) {
    const x = l[li];
    const blk = blocks.get(li);
    if (blk) {
      // The block's screen lines (the code, as the terminal drew it) give
      // way to its own text when all of it is on screen.
      flush();
      const rows = l.slice(li, blk.hi + 1);
      const indent = Math.min(...rows.filter((r) => r.trim()).map(ind));
      out.push(lvBlock(blk.span.whole ? blk.span.t : rows.map((r) => r.slice(Math.min(indent, ind(r)))).join('\n'), blk.span, blk.i, indent));
      li = blk.hi;
      continue;
    }
    if (SCREEN_RULE.test(x)) { flush(); out.push(`<div class="scr-rule">${escRaw(x)}</div>`); continue; }
    if (LV_BOX.test(x)) { pre.push(x); continue; }
    flush();
    if (!x) { out.push('<div class="ln"></div>'); continue; }
    const m = x.match(/^( *)((?:[-*•]|\d{1,3}[.)])\s+)?/);
    const pad = m[1].length + (m[2] ? m[2].length : 0);
    const hang = m[2] ? m[2].length : 0;
    const marks = byLine.get(li);
    // A "! " command alone on its line is a line to run: a code block too.
    if (!m[2] && marks && marks.length === 1) {
      const [a, b, span, , i] = marks[0];
      if (span.cmd && span.r.length === 1 && a === m[1].length && b === x.length) { out.push(lvBlock(x.slice(a, b), span, i, m[1].length)); continue; }
    }
    out.push(`<div${pad ? ` style="padding-left: ${pad}ch; text-indent: -${hang}ch"` : ''}>${lvMarked(x, m[1].length, marks)}</div>`);
  }
  flush();
  return out.join('');
}
function lvEntry(e) {
  const row = (cls, g, body) => `<div class="e ${cls}"><span class="g">${g}</span><span class="x">${body}</span></div>`;
  if (e.k === 'u') return row('u', '❯', lvLines(e.l));
  if (e.k === 'c') return row('c', e.orphan ? ' ' : '⏺', lvLines(e.l, e.cs));
  if (e.k === 'r') return row('r', '※', lvLines(['recap: ' + (e.l[0] || ''), ...e.l.slice(1)]));
  if (e.k === 's') return row('s', escRaw(e.g || '✻'), escRaw(e.t));
  if (e.k === 'o') return row('s', '⎿', escRaw(e.t));
  if (e.k === 'todo') return row('s', '⎿', lvLines(e.l));
  if (e.k === 't') {
    // A run of the same notice (server/screen.mjs foldNotices): the text
    // gives way to the count, which stays in view.
    if (e.b && e.x > 1) return row('t mini', '⏺', `<span class="tl tn"><span class="tb">${escRaw(e.b)}</span><span class="more">×${e.x}</span></span>`);
    const label = e.b ? escRaw(e.b) : `<b>${escRaw(e.n)}</b> ${escRaw(e.a)}`;
    const more = e.m ? ` <span class="more">+${e.m} line${e.m > 1 ? 's' : ''}</span>` : '';
    return row('t mini', '⏺', `<span class="tl">${label}${more}</span>`);
  }
  return `<div class="e p"><span class="x">${lvLines(e.l || [])}</span></div>`;
}
const lvCount = (e) => (e.l ? e.l.length : 1);
// What an entry is, without its code spans: the entries are matched on this,
// so an entry whose spans change (its transcript message landed after the
// screen showed it) is redrawn in place, not taken for a new one.
const lvBase = (e) => (e.cs ? JSON.stringify({ ...e, cs: undefined }) : JSON.stringify(e));

// Copy on a command's button. navigator.clipboard needs a secure page; the
// phone page on the LAN is plain http, so there a hidden textarea and
// execCommand('copy') do it, inside the tap.
function lvCopyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => lvCopyFallback(text));
  return Promise.resolve(lvCopyFallback(text));
}
function lvCopyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px';
  const back = document.activeElement;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (back && back.focus) back.focus({ preventScroll: true });
  return ok;
}
// "Copied" for 1.5 s, on every button of that command, and again on any
// redrawn in that time.
const lvCopied = { text: null, until: 0, timer: 0 };
function lvShowCopied() {
  const on = Date.now() < lvCopied.until;
  for (const b of document.querySelectorAll('#lv-lines [data-lv-copy]')) {
    const done = on && b.dataset.lvCopy === lvCopied.text;
    if (b.classList.contains('done') === done) continue;
    b.classList.toggle('done', done);
    b.innerHTML = lvCopyIn(done);
  }
  for (const c of document.querySelectorAll('#lv-lines .cd.pl, #lv-lines .cd.cb')) c.classList.toggle('done', on && c.dataset.lvChip === lvCopied.text);
}
document.addEventListener('click', (e) => {
  // A button copies anywhere; on a phone a tap on the chip itself does too
  // (the card's open-full-screen tap leaves chips alone).
  const b = e.target.closest('[data-lv-copy]') || (LV_PHONE.matches && e.target.closest('#lv-lines .cd[data-lv-chip]'));
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const text = b.dataset.lvCopy != null ? b.dataset.lvCopy : b.dataset.lvChip;
  lvCopyText(text).then((ok) => {
    if (!ok) { toast(`Copy did not work; select the ${text.startsWith('! ') ? 'command' : 'text'} instead`); return; }
    lvCopied.text = text;
    lvCopied.until = Date.now() + 1500;
    lvShowCopied();
    clearTimeout(lvCopied.timer);
    lvCopied.timer = setTimeout(lvShowCopied, 1520);
  });
});

// A wrapped span's pieces hover as one, so its Copy shows from any piece; a
// Copy that would run past the screen's right edge sits over the chip's end.
let lvHov = null;
function lvHover(c) {
  const key = c ? c.closest('.e') && c.dataset.lvI : null;
  const group = c && key != null ? Array.from(c.closest('.e').querySelectorAll(`.cd[data-lv-i="${key}"]`)) : [];
  if (lvHov && group[0] === lvHov[0]) return;
  if (lvHov) for (const n of lvHov) n.classList.remove('hov');
  lvHov = group.length ? group : null;
  if (!lvHov) return;
  for (const n of lvHov) n.classList.add('hov');
  const btn = lvHov[lvHov.length - 1].querySelector('.cph');
  const sc = btn && btn.closest('.lv-scroll');
  if (!btn || !sc) return;
  btn.classList.remove('flip');
  if (btn.getBoundingClientRect().right > sc.getBoundingClientRect().right - 4) btn.classList.add('flip');
}
document.addEventListener('mouseover', (e) => { if (!LV_PHONE.matches) lvHover(e.target.closest && e.target.closest('#lv-lines .cd[data-lv-i]')); });
document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) lvHover(null); });

// Puts new entries on screen. Entries that scrolled off the top go, a last
// entry that grew is replaced, new ones are appended; while the user reads
// higher up, the line they are on stays where it is and the new lines are
// counted for the pill.
function applyLive(entries) {
  const box = $('#lv-lines');
  const sc = $('#lv-scroll');
  if (!box || !sc) return;
  const keys = entries.map(lvEntry);
  const base = entries.map(lvBase);
  const counts = entries.map(lvCount);
  const old = lv.base;
  const oldKeys = lv.keys;
  // Where the old entries start in the new list. Every old entry from there
  // on needs a place in the new list: when the last one went (a spinner's
  // task line the next read no longer had), the list is redrawn, since
  // keys[last] would be undefined and replaceWith(null) prints "null".
  let d = -1;
  for (let k = 0; k < old.length && d < 0; k++) {
    if (old[k] !== base[0]) continue;
    let ok = old.length - k <= keys.length;
    for (let j = 1; ok && k + j < old.length - 1; j++) if (old[k + j] !== base[j]) ok = false;
    if (ok) d = k;
  }
  // The first entry in view and how far down the view it starts.
  let anchor = null;
  if (!lv.follow) {
    for (const [k, n] of Array.from(box.children).entries()) {
      if (n.offsetTop + n.offsetHeight > sc.scrollTop) { anchor = { k, off: n.offsetTop - sc.scrollTop }; break; }
    }
  }
  let added = 0;
  if (d >= 0 && old.length) {
    for (let k = 0; k < d; k++) box.firstElementChild.remove();
    const last = old.length - d - 1;
    // A kept entry whose code spans changed is redrawn where it is.
    for (let j = 0; j < last; j++) {
      if (keys[j] === oldKeys[d + j]) continue;
      const t = document.createElement('template');
      t.innerHTML = keys[j];
      box.children[j].replaceWith(t.content.firstElementChild);
    }
    if (keys[last] !== oldKeys[oldKeys.length - 1]) {
      const t = document.createElement('template');
      t.innerHTML = keys[last];
      box.children[last].replaceWith(t.content.firstElementChild);
      added += Math.max(0, counts[last] - lv.counts[lv.counts.length - 1]);
    }
    if (keys.length > last + 1) {
      box.insertAdjacentHTML('beforeend', keys.slice(last + 1).join(''));
      added += counts.slice(last + 1).reduce((a, b) => a + b, 0);
    }
    if (anchor) anchor.k -= d;
  } else {
    box.innerHTML = keys.join('');
    added = old.length ? counts.reduce((a, b) => a + b, 0) : 0;
    anchor = null;
  }
  lv.keys = keys;
  lv.base = base;
  lv.counts = counts;
  if (lvCopied.text && Date.now() < lvCopied.until) lvShowCopied();
  if (lv.follow) { sc.scrollTop = sc.scrollHeight; lv.fresh = 0; }
  else {
    if (anchor && anchor.k >= 0 && box.children[anchor.k]) sc.scrollTop = box.children[anchor.k].offsetTop - anchor.off;
    lv.fresh += added;
  }
  renderJump();
}

async function fetchLive(sid) {
  if (lv.pending) return;
  lv.pending = true;
  try {
    const r = await fetch(`/api/live?surface=${encodeURIComponent(sid)}${lv.ver && lv.keys.length ? `&v=${lv.ver}` : ''}`);
    const j = await r.json();
    if (j.now) ui.skew = Date.now() - j.now;
    if (sid !== lv.sid) return;
    if (!r.ok) { lv.empty = j.error || `${lv.term} could not read this tab.`; showEmpty(); return; }
    lv.at = j.at;
    lv.ver = j.ver;
    if (!j.same) {
      lv.status = j.status;
      if (!j.entries.length) { lv.empty = j.at == null ? `${lv.term} has not read this tab yet.` : 'Nothing on screen yet.'; showEmpty(); }
      else { if (lv.empty) { lv.empty = ''; $('#lv-lines').innerHTML = ''; lv.keys = []; lv.base = []; } applyLive(j.entries); }
    }
    const p = project(ui.sel);
    if (p) renderLiveStatus(p);
    renderFresh();
  } catch { /* the board is down; the freshness dot says so */ } finally {
    lv.pending = false;
  }
}

function showEmpty() {
  const box = $('#lv-lines');
  if (!box) return;
  lv.keys = []; lv.base = []; lv.counts = [];
  const html = `<div class="lv-empty">${esc(lv.empty)}</div>`;
  if (box.innerHTML !== html) box.innerHTML = html;
  renderFresh();
  renderJump();
}

// One row: the session's state, what the spinner says or how many agents
// run, then each agent's task and time.
function renderLiveStatus(p) {
  const el = $('#lv-st');
  if (!el) return;
  const { s, state } = view(p);
  const st = lv.status;
  if (!s || lv.empty || !st) { el.hidden = true; el.innerHTML = ''; return; }
  const t = ST[state] || ST.idle;
  const parts = [];
  if (st.busy && !/^Waiting for \d+ background/.test(st.busy)) parts.push(st.busy);
  const busyN = st.busy && st.busy.match(/^Waiting for (\d+) background/);
  const n = st.agents.length || (busyN ? Number(busyN[1]) : 0);
  if (n) parts.push(`${n} background agent${n > 1 ? 's' : ''}`);
  if (!parts.length && st.done && state !== 'work') parts.push(`Done ${st.done.when}, worked ${st.done.took}`);
  const html = `<div class="lv-st-r">${stateIcon(t, state === 'work' ? 'working' : '')}<b>${esc(t.word)}</b>${parts.length ? `<span class="sr-only">, </span><span class="lv-sub">${escRaw(parts.join(', '))}</span>` : ''}</div>${st.agents.map((a) => `<div class="lv-ag"><span>◯ ${escRaw(a.task)}</span><span class="num">${escRaw(a.took || '')}</span></div>`).join('')}`;
  el.hidden = false;
  if (el.innerHTML !== html) { el.innerHTML = html; renderJump(); }
}

function renderLive(p, s, state) {
  if (!$('#lv-card')) buildLive();
  placeLive();
  // The session's assistant: the tag next to "Live screen", and the name in
  // the freshness tooltip.
  lv.asst = s ? asKind(s.assistant) : null;
  const tagEl = $('#lv-tag');
  if (tagEl) {
    tagEl.hidden = !s;
    if (s && tagEl.textContent !== AS_WORD[lv.asst]) { tagEl.textContent = AS_WORD[lv.asst]; tagEl.title = AS_NAME[lv.asst] + ' session'; }
  }
  const sid = s && s.terminal !== false ? s.surfaceId : null;
  const watch = !!s && s.terminal === false;
  const why = watch ? (s.cannot || `This session runs outside ${boardTerm()}, so there is no screen to show.`) : '';
  // Keyed on what is shown, not on the surface read: a watch-only session
  // and a project with no session both read no surface, and the card built
  // fresh starts there too, so a surface alone left the card blank with a
  // "Not read yet" it would never keep.
  const key = sid || (watch ? 'watch:' + (s.sessionId || s.surfaceId) : 'none:' + p.id);
  if (key !== lv.key) {
    lv.key = key; lv.sid = sid; lv.watch = watch; lv.at = null; lv.ver = null; lv.keys = []; lv.base = []; lv.counts = []; lv.follow = true; lv.fresh = 0; lv.status = null; lv.term = termOf(s);
    lv.empty = !s ? 'No live session in this project.' : watch ? why : 'Reading the screen...';
    showEmpty();
  } else if (watch && lv.empty !== why) { lv.empty = why; showEmpty(); }
  if (sid && (s.screenAt !== lv.at || !lv.keys.length)) fetchLive(sid);
  renderLiveStatus(p);
  renderFresh();
  if (lv.full) renderFullBar();
  renderLiveMenu(p);
}

// A menu open on the shown session's screen, in full screen
// (docs/design/LiveMenu.dc.html, V1): its options take the message box's
// place, as the answer card's buttons, sent the same way (sendQuick). After a
// click the panel locks on what was sent until a read shows the menu gone;
// then the box comes back, its draft untouched (it was only hidden). The
// menu lines in the Live screen itself stay plain text.
const LV_OK = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.3l2.2 2.2 4.2-4.6" stroke="#FFFFFF" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// What the menu is about, for the header: "Bash: <command>" from a
// permission prompt ("Bash command", then the command between dashed
// rules), "Question from Claude" for an AskUserQuestion menu.
function lvMenuContext(lines) {
  const l = lines || [];
  const qi = l.findIndex((x) => /\?\s*$/.test(x) && !/^❯?\s*\d+\./.test(x));
  const before = qi >= 0 ? l.slice(0, qi) : l;
  let h = -1;
  for (let i = before.length - 1; i >= 0; i--) if (/^\S+ (command|file)$/.test(before[i])) { h = i; break; }
  if (h >= 0) {
    const head = before[h];
    const tool = / command$/.test(head) ? head.replace(/ command$/, '') : head;
    const rest = before.slice(h + 1);
    const ruled = rest.findIndex((x, i) => i > 0 && SCREEN_RULE.test(rest[i - 1]) && !SCREEN_RULE.test(x));
    const what = ruled >= 0 ? rest[ruled] : rest.find((x) => !SCREEN_RULE.test(x) && !/^Tip:/.test(x));
    return what ? `${tool}: ${what}` : tool;
  }
  return l.some((x) => /Enter to select/.test(x)) ? 'Question from Claude' : '';
}
function renderLiveMenu(p) {
  const comp = $('#composer');
  let panel = $('#lv-menu');
  const body = $('#lv-fs-body');
  const { s, w } = view(p);
  const opts = (w && w.quick) || [];
  const open = lv.full && body && comp && s && s.live && s.dialog && opts.some((o) => o.choice != null);
  if (!open) {
    if (panel) panel.remove();
    if (comp) comp.style.display = '';
    if (!(s && s.dialog)) lv.menuSent = null;
    return;
  }
  const sig = JSON.stringify([s.surfaceId, w.headline, opts.map((o) => o.label)]);
  if (lv.menuSent && lv.menuSent.sig !== sig) lv.menuSent = null;
  const sent = lv.menuSent;
  const ctx = lvMenuContext(w.dialog);
  const btn = (o, k) => {
    const cls = sent ? (k === sent.k ? 'btn chosen' : 'btn dimmed') : k === 0 ? 'btn pri' : 'btn';
    return `<button class="${cls}" data-lv-menu-k="${k}"${sent || lv.menuBusy ? ' disabled' : ''}>${esc(o.label)}</button>`;
  };
  const html = `<div class="lvm-h">${stateIcon(ST.you)}<b>${esc(w.headline)}</b>${ctx ? `<span class="ctx">${escRaw(ctx)}</span>` : ''}</div>
<div class="lvm-o">${opts.map(btn).join('')}</div>
${sent ? `<div class="lvm-sent">${LV_OK}<span>Sent "${esc(sent.label)}"</span></div>` : '<div class="lvm-f">The message box comes back after you answer. Its draft is kept.</div>'}`;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'lv-menu';
    panel.className = 'lvm';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Answer the menu on screen');
    comp.before(panel);
  }
  panel.dataset.sig = sig;
  if (panel.dataset.html !== html) { panel.dataset.html = html; panel.innerHTML = html; }
  comp.style.display = 'none';
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lv-menu-k]');
  if (!b || lv.menuBusy || lv.menuSent) return;
  const p = project(ui.sel);
  const panel = $('#lv-menu');
  if (!p || !panel) return;
  const k = Number(b.dataset.lvMenuK);
  const sig = panel.dataset.sig;
  const label = b.textContent;
  lv.menuBusy = true;
  for (const x of panel.querySelectorAll('button')) x.disabled = true;
  let ok = false;
  try { ok = await sendQuick(k); } finally { lv.menuBusy = false; }
  // Locked on what was sent while that menu is still on screen.
  if (ok) lv.menuSent = { sig, k, label };
  const q = project(ui.sel);
  if (q) renderLiveMenu(q);
});

function renderFullBar() {
  const bar = $('#lv-fs-bar');
  const p = project(ui.sel);
  if (!bar || !p) return;
  const { state } = view(p);
  const t = ST[state] || ST.idle;
  const html = LV_PHONE.matches
    ? `<button class="linkish lv-back" data-lv-close>${LV_ICON.back}Back</button><span class="fs-name lv-mid">${esc(p.name)}</span><span class="lv-end"><span class="fresh" data-fresh="bar"><i></i><span></span></span></span>`
    : `<span class="fs-name">${esc(p.name)}</span><span class="state-c" style="color: ${t.c}">${stateIcon(t, state === 'work' ? 'working' : '')}${esc(t.word)}</span><span class="t3" style="font-size: 12px">Live screen</span><span style="flex: 1"></span><span class="fresh" data-fresh="bar"><i></i><span></span></span><span class="strip-sep" aria-hidden="true"></span>${openButton(p, view(p).s)}<button class="btn sm" data-lv-close>${LV_ICON.shrink}Exit full screen<span class="kbd">esc</span></button>`;
  if (bar.dataset.html !== html) { bar.dataset.html = html; bar.innerHTML = html; }
  renderFresh();
}

// The terminal and the composer move into the full-screen layer and back,
// so the composer keeps its draft, files and behaviour.
function firstInView() {
  const box = $('#lv-lines'); const sc = $('#lv-scroll');
  if (!box || !sc) return null;
  for (const n of box.children) if (n.offsetTop + n.offsetHeight > sc.scrollTop) return { n, off: n.offsetTop - sc.scrollTop };
  return null;
}
function restoreView(a) {
  const sc = $('#lv-scroll');
  if (!sc) return;
  if (lv.follow || !a || !a.n.isConnected) { if (lv.follow) sc.scrollTop = sc.scrollHeight; return; }
  sc.scrollTop = a.n.offsetTop - a.off;
}
function openFull() {
  if (lv.full || !$('#lv')) return;
  const a = firstInView();
  lv.full = true;
  const layer = $('#lv-fs');
  layer.innerHTML = `<div class="fs-bar" id="lv-fs-bar"></div><div class="fs-body" id="lv-fs-body"></div>`;
  layer.hidden = false;
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', 'Live screen, full screen');
  const body = $('#lv-fs-body');
  body.appendChild($('#lv'));
  const comp = $('#composer');
  if (comp) body.appendChild(comp);
  $('#lv').classList.add('flush');
  document.documentElement.classList.add('lv-lock');
  renderFullBar();
  const pm = project(ui.sel);
  if (pm) renderLiveMenu(pm);
  restoreView(a);
  renderJump();
  try { history.pushState({ lvFull: 1 }, ''); } catch { /* sandboxed */ }
  const close = layer.querySelector('[data-lv-close]');
  if (close) close.focus({ preventScroll: true });
}
function closeFull({ back = true } = {}) {
  if (!lv.full) return;
  const a = firstInView();
  lv.full = false;
  const card = $('#lv-card');
  const box = $('#lv');
  if (box) { box.classList.remove('flush'); if (card) card.appendChild(box); else box.remove(); }
  const comp = $('#composer');
  const top = $('#d-ask-top');
  if (comp) comp.style.display = '';
  if (comp && top) top.after(comp);
  lv.menuSent = null;
  const layer = $('#lv-fs');
  layer.hidden = true;
  layer.innerHTML = '';
  document.documentElement.classList.remove('lv-lock');
  restoreView(a);
  renderJump();
  if (back && history.state && history.state.lvFull) history.back();
  const b = $(LV_PHONE.matches ? '#lv-tap' : '#lv-exp');
  if (b && back) b.focus({ preventScroll: true });
}
window.addEventListener('popstate', () => { if (lv.full) closeFull({ back: false }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lv.full) { e.preventDefault(); closeFull(); } });
document.addEventListener('click', (e) => { if (e.target.closest('[data-lv-close]')) closeFull(); });

// ------------------------------------------------------------ hand-off

function handoffButton(s) {
  const h = s && s.handoff;
  if (!s || !s.live || !s.sessionId || !h) return '';
  if (h.state === 'written' && !h.autoStart && !h.resumeError) return '<button class="btn sm pri" data-act="handoff-start">Start fresh session</button>';
  if (h.state === 'written' || h.state === 'resumed') return '';
  if (h.manual) return '<button class="btn sm" disabled title="Asked for. It hands off at the next clean point.">Hand-off queued</button>';
  return `<button class="btn sm" data-act="handoff" title="Hand off at the next clean point: task finished, work committed, nothing running">Hand off now</button>`;
}

function handoffCard(p, s) {
  let h = s && s.handoff && s.handoff.state !== 'none' ? s.handoff : null;
  if (!h && p.handoffRecent) h = p.handoffRecent;
  if (!h) return '';
  const name = h.fileName || 'BRIEF.md';
  let line;
  const notes = [];
  if (h.state === 'queued' || h.state === 'requested') {
    line = h.over ? `Past the ${h.ceiling}% ceiling. It hands off at its next commit:` : 'Hand-off queued. It waits for a clean point:';
    if (h.lastCheck && !h.lastCheck.clean) notes.push(`At its last stop: ${h.lastCheck.why}.`);
    if (h.state === 'requested') notes.push(`Asked at ${h.asks > 1 ? 'its last ' + h.asks + ' stops' : 'its last stop'}. It writes the hand-off to ${name} when the task is done.`);
    else if (h.atRest) notes.push("It asks at this session's next stop. Send it any message to get there sooner.");
  } else if (h.state === 'written') {
    if (h.resumeError) line = `Hand-off written to ${name}, but the fresh session did not start: ${h.resumeError}`;
    else if (h.autoStart) line = `Hand-off written to ${name}. Opening a fresh session in this workspace.`;
    else line = `Hand-off written to ${name}. Start the fresh session when you are ready.`;
  } else {
    const d = parseT(h.resumedAt);
    line = `Handed off cleanly. A fresh session started from ${name}${d ? ' at ' + clock(d, true) : ''}${h.resumeSurfaceRef ? ' (' + h.resumeSurfaceRef + ')' : ''}.`;
  }
  const checks = h.checks.map((k) => `<span style="display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: ${k.ok ? 'var(--tx)' : 'var(--tx2)'}"><span class="dot" style="${k.ok ? 'background:var(--ok)' : 'border:1.5px solid var(--idle)'}; width: 14px; height: 14px"><svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true"><path d="${k.ok ? CHECK : ''}" stroke="#FFFFFF" stroke-width="2" fill="none"></path></svg></span>${esc(k.label)}<span class="sr-only">: ${k.ok ? 'yes' : 'not yet'}</span></span>`).join('');
  return `<div class="card" role="status" style="padding: 12px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px">
<span style="font-weight: 600; flex: 1 1 100%">${esc(line)}</span>
${checks}
${notes.length ? `<span class="t2" style="flex: 1 1 100%; font-size: 12px; line-height: 1.45">${esc(notes.join(' '))}</span>` : ''}</div>`;
}

async function handoffNow() {
  const p = project(ui.sel);
  if (!p) return;
  const { s } = view(p);
  try {
    const r = await post('/api/handoff', { projectId: p.id, surfaceId: s ? s.surfaceId : null });
    toast(r.atRest ? `${p.name}: hand-off queued. It asks at the session's next stop.` : `${p.name}: hand-off queued for the next clean point`);
  } catch (e) {
    toast(e.message);
  }
}

async function handoffStart() {
  const p = project(ui.sel);
  if (!p) return;
  const { s } = view(p);
  try {
    const r = await post('/api/handoff/start', { projectId: p.id, sessionId: s && s.sessionId });
    toast(`Fresh session started in ${r.surfaceRef || 'a new tab'}. It reads the brief first.`);
  } catch (e) {
    toast(e.message);
  }
}

function joinNames(a) {
  return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

// ------------------------------------------------------------ composer

// A file chip, as the composer shows it: the saved path, or "Saving ..."
// while it uploads, with a remove button carrying `attrs`.
function fileChip(f, attrs) {
  return `<span class="chip">${esc(f.pending ? 'Saving ' + f.name + '...' : f.short)}<button ${attrs} aria-label="Remove ${esc(f.name)}"><svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8"></path></svg></button></span>`;
}

function renderChips(pid) {
  const fs = ui.files[pid] || [];
  setHtml('chips', fs.map((f, k) => fileChip(f, `data-act="unfile" data-k="${k}"`)).join(''));
  const chips = $('#chips');
  if (chips) chips.hidden = !fs.length;
}

// Saves files into the project's .inbox (the composer's route, its limits
// and guards), one at a time, each a chip in `list` while it saves.
async function saveToInbox(pid, files, list, redraw) {
  for (const f of files) {
    const entry = { name: f.name || 'pasted', pending: true };
    list.push(entry);
    redraw();
    try {
      const r = await post(`/api/inbox/${encodeURIComponent(pid)}`, f, { 'X-Filename': encodeURIComponent(f.name || 'image.png') });
      Object.assign(entry, { pending: false, path: r.path, short: r.short });
    } catch (e) {
      const k = list.indexOf(entry);
      if (k >= 0) list.splice(k, 1);
      toast('Could not save ' + entry.name + ': ' + e.message);
    }
    redraw();
  }
}

async function addFiles(pid, list) {
  const files = Array.from(list || []);
  if (!files.length) return;
  ui.files[pid] = ui.files[pid] || [];
  await saveToInbox(pid, files, ui.files[pid], () => renderChips(pid));
}

function wireComposer(pid) {
  const ta = $('#compose');
  const box = $('#composer');
  ta.addEventListener('input', () => { ui.drafts[pid] = ta.value; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendCompose(); } });
  ta.addEventListener('paste', (e) => {
    const fs = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (fs.length) { e.preventDefault(); addFiles(pid, fs); }
    // A pasted path is plain text and goes through untouched.
  });
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('over');
    const fs = e.dataTransfer && e.dataTransfer.files;
    if (fs && fs.length) addFiles(pid, fs);
    else {
      const txt = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (txt) { ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + txt; ui.drafts[pid] = ta.value; }
    }
  });
  $('#pick').addEventListener('change', (e) => { addFiles(pid, e.target.files); e.target.value = ''; });
  $('#send').addEventListener('click', sendCompose);
  $('#note').addEventListener('click', addNote);
  $('#ns').addEventListener('click', () => { ui.ns = !ui.ns; render(); });
}

async function sendCompose() {
  const p = project(ui.sel);
  if (!p) return;
  if (ui.ns) { startSession(); return; }
  const { s } = view(p);
  // At a plan gate the composer is the gate card's free answer.
  if (p.planGate && (!s || s.surfaceId === p.primary) && !(ui.files[p.id] || []).length) {
    const text = ($('#compose').value || '').trim();
    if (!text) { toast('Write your answer first, or pick a choice'); return; }
    if (await planAnswer({ text })) { ui.drafts[p.id] = ''; $('#compose').value = ''; }
    return;
  }
  const fs = ui.files[p.id] || [];
  if (fs.some((f) => f.pending)) { toast('Still saving a file, one moment'); return; }
  const text = ($('#compose').value || '').trim();
  if (!text && !fs.length) { toast('Type something or add a file first'); return; }
  if (!s) return;
  const btn = $('#send');
  btn.disabled = true;
  try {
    const r = await post('/api/send', { projectId: p.id, surfaceId: s.surfaceId, text, paths: fs.map((f) => f.path) });
    ui.drafts[p.id] = '';
    ui.files[p.id] = [];
    $('#compose').value = '';
    const n = fs.length;
    ui.sent[p.id] = { label: text ? (text.length > 40 ? text.slice(0, 40) + '...' : text) : `${n} file${n > 1 ? 's' : ''}`, at: Date.now(), delivered: r.delivered };
    toast(`Typed into ${p.name}'s session${n ? ` with ${n} file path${n > 1 ? 's' : ''}` : ''}${r.delivered === 'now' ? '' : ', delivered after its current step'}`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    render();
  }
}

// The New session switch on: Start session opens a new tab running Claude
// in the project's folder through Revive, with the box's words and files
// (the paths Send would type) as its first prompt. Empty, it reads the
// brief as Revive does. The selection stays on the session being watched
// until the new one shows, then moves to it (followStart).
async function startSession() {
  const p = project(ui.sel);
  if (!p) return;
  const fs = ui.files[p.id] || [];
  if (fs.some((f) => f.pending)) { toast('Still saving a file, one moment'); return; }
  const text = ($('#compose').value || '').trim();
  if (!text && !fs.length && !p.brief) { toast('Type the first message, or write the brief first so the new session has something to read'); return; }
  const { s } = view(p);
  const before = p.sessions.map((x) => x.surfaceId);
  const btn = $('#send');
  btn.disabled = true;
  try {
    const r = await post('/api/project/revive', { projectId: p.id, text, paths: fs.map((f) => f.path) });
    if (s) ui.selSession[p.id] = s.surfaceId;
    ui.drafts[p.id] = '';
    ui.files[p.id] = [];
    $('#compose').value = '';
    ui.ns = false;
    ui.starting[p.id] = { surfaceId: r.surfaceId || null, before, topic: text ? text.split('\n')[0] : 'New session', at: Date.now() };
    followStart(p.id, r, before);
    toast(text || fs.length ? `Started a new session in ${p.name} with your first message` : `Started a new session in ${p.name} reading the brief`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    render();
  }
}

async function sendQuick(k) {
  const p = project(ui.sel);
  if (!p) return;
  const { s, w } = view(p);
  const o = w.quick && w.quick[k];
  if (!o || !s) return;
  try {
    const r = await post('/api/send', { projectId: p.id, surfaceId: s.surfaceId, text: o.choice == null ? o.label : undefined, choice: o.choice });
    ui.sent[p.id] = { label: o.label, at: Date.now(), delivered: r.delivered };
    toast(`Sent "${o.label}" to ${p.name}`);
    render();
    return true;
  } catch (e) {
    toast(e.message);
  }
  render();
  return false;
}

async function addNote() {
  const p = project(ui.sel);
  if (!p) return;
  const text = ($('#compose').value || '').trim();
  if (!text) { toast('Type the note first'); return; }
  try {
    await post('/api/note', { projectId: p.id, text });
    ui.drafts[p.id] = '';
    $('#compose').value = '';
    toast('Note tracked in the brief until it is fixed');
  } catch (e) {
    toast(e.message);
  }
}

// The terminal a session runs in, by name ("cmux", "iTerm2", "Rex"), for the words
// that send the user there.
function termOf(s) {
  return (s && s.termName) || boardTerm();
}

// The board's own terminal, by name: where New project, Revive and Reopen
// open their tabs ("cmux", or "iTerm2" or "Rex" when the board runs in that mode).
function boardTerm() {
  return (ui.snap && ui.snap.board && ui.snap.board.name) || 'cmux';
}

// Where Start puts a new project's first session, in words (Rex mode
// opens a Rex session named after the project).
function newPlace() {
  if (boardTerm() === 'Rex') return 'a new Rex session';
  return boardTerm() === 'cmux' ? 'a cmux workspace' : `a new ${boardTerm()} tab`;
}

// "Open in <terminal>": the shown session's own tab when it is in a
// terminal other than cmux the board can reach, else the project's cmux
// workspace as before.
function openButton(p, s) {
  const other = !!(s && s.terminal !== false && s.term && s.term !== 'cmux');
  const on = other || (boardTerm() === 'cmux' && p.workspaces.some((x) => x.open));
  // A watch-only session (another terminal, or one with no adapter) has no
  // tab this board can open, and a greyed "Open in iTerm2" over a cmux
  // session only says the wrong terminal: show no button at all.
  if (s && s.terminal === false) return '';
  if (!on && boardTerm() !== 'cmux') return '';
  return `<button class="btn sm" data-act="open" ${on ? '' : 'disabled'}>Open in ${esc(other ? s.termName : boardTerm())}</button>`;
}

async function openInCmux() {
  const p = project(ui.sel);
  if (!p) return;
  const { s } = view(p);
  try {
    const r = await post('/api/open', { projectId: p.id, surfaceId: s ? s.surfaceId : null });
    toast(r && r.where ? `Brought ${p.name}'s ${r.where} tab forward` : `Switched cmux to ${p.name}`);
  } catch (e) {
    toast(e.message);
  }
}

// ------------------------------------------------------------ views (phase D)

const VIEWS = [['projects', 'Projects'], ['objectives', 'Objectives'], ['ideas', 'Ideas'], ['rules', 'Rules'], ['ship', 'Ship']];
// Pages the URL can name: the five tabs, and Sessions, which the top-bar
// memory readout opens (it has no tab of its own).
const PAGES = [...VIEWS, ['sessions', 'Sessions']];
const IDEA_COLS = [['spark', 'Spark', 'var(--tx2)', 'var(--idle-t)'], ['mock', 'Mockup', 'var(--work)', 'var(--work-t)'], ['green', 'Greenlit', 'var(--ok)', 'rgba(48,209,88,.09)'], ['park', 'Parked', 'var(--idle)', 'var(--idle-t)']];
const STAGE_NAME = { spark: 'Spark', mock: 'Mockup', green: 'Greenlit', park: 'Parked' };
const CHIPS = {
  green: ['Give me 5 names', 'Mock up the first 30 seconds', 'Write the brief'],
  park: ['What would make it fun?', 'Smallest test that proves it', 'Kill or keep?'],
  // "Mock it up" is the Mockups card's button now, which draws pictures.
  other: ['Push this further', 'What is the hook?'],
};
const FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.6h5.6a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"></path></svg>';
// A path that may break after each slash.
const wbr = (s) => esc(s).replace(/\//g, '/<wbr>');
const X_ICON = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8"></path></svg>';

function renderViews() {
  const n = (ui.snap && ui.snap.views) || {};
  const counts = { ideas: n.ideas, rules: n.rules, ship: n.ship };
  const cur = ui.view === 'plan' ? 'projects' : ui.view;
  setHtml('views', VIEWS.map(([k, label]) => `<button class="seg ${cur === k ? 'on' : ''}" data-view="${k}" ${cur === k ? 'aria-current="page"' : ''}>${label}${counts[k] ? `<span class="num" style="font-size: 11.5px; color: var(--tx3); margin-left: 6px">${counts[k]}</span>` : ''}</button>`).join(''));
}

function setView(v, { push = true } = {}) {
  if (v.startsWith('plan/')) { openPlanPage(v.slice(5)); return; }
  if (!PAGES.some(([k]) => k === v)) v = 'projects';
  if (ui.view === v) return;
  ui.view = v;
  ui.built = null;
  ui.idleOpen = false;
  store.set('view', v);
  if (push) history.replaceState(null, '', v === 'projects' ? (ui.sel ? '#' + encodeURIComponent(ui.sel) : '#') : '#/' + v);
  $('#mc').classList.toggle('not-projects', v !== 'projects');
  if (v === 'rules') { ui.rulesTab = 'mine'; ui.openRepeat = null; loadRules(); }
  if (v === 'ship') loadShip();
  if (v === 'ideas' && !ui.ideas) loadIdeas();
  render();
  window.scrollTo(0, 0);
}

function buildView(key, html) {
  if (ui.built === key) return false;
  ui.built = key;
  ui.html = Object.fromEntries(Object.entries(ui.html).filter(([k]) => KEEP_HTML.includes(k)));
  $('#sheet').innerHTML = html;
  return true;
}

// ------------------------------------------------------------ Objectives

function objRow(o) {
  if (o.tasks.length) {
    const n = o.tasks.length;
    const done = o.tasks.filter((x) => x.state === 'done').length;
    const nxt = o.tasks.find((x) => x.state !== 'done');
    const next = !nxt ? 'Done' : nxt.state === 'you' ? 'Next: you' : nxt.state === 'wait' ? 'Next: someone else' : 'Next: ' + nxt.text.charAt(0).toLowerCase() + nxt.text.slice(1);
    const cells = o.tasks.map((x) => { const c = taskDot(x.state); return `<span class="dot" title="${esc(x.text)}" style="${c.dotStyle}; width: 13px; height: 13px"></span>`; }).join('');
    return `<div class="card-r" style="flex-wrap: wrap; gap: 8px 14px">
<span class="obj-title" style="flex: 0 0 240px; min-width: 0">${o.plan ? '<span class="pl-label sm">Plan</span>' : ''}${esc(o.title)}</span>
<div style="display: flex; gap: 4px; flex: 1 1 180px; flex-wrap: wrap" role="img" aria-label="${esc(`${done} of ${n} done`)}">${cells}</div>
<span class="num" style="flex: 0 0 auto; min-width: 56px; white-space: nowrap; text-align: right; font-weight: 600">${done} of ${n}</span>
<span class="t2 obj-next" style="flex: 0 0 170px; font-size: 12px; min-width: 0; overflow-wrap: anywhere">${esc(next)}</span></div>`;
  }
  if (o.progress) {
    const pct = o.progress.total ? Math.round(o.progress.done / o.progress.total * 100) : 0;
    return `<div class="card-r" style="flex-wrap: wrap; gap: 8px 14px">
<span class="obj-title" style="flex: 0 0 240px; min-width: 0">${esc(o.title)}</span>
<div class="bar" style="flex: 1 1 180px"><div class="f" style="width: ${pct}%; background: var(--tx)"></div></div>
<span class="num" style="flex: 0 0 auto; min-width: 56px; white-space: nowrap; text-align: right; font-weight: 600">${o.progress.done} of ${o.progress.total}</span>
<span class="t2 obj-next" style="flex: 0 0 170px; font-size: 12px; min-width: 0; overflow-wrap: anywhere">${o.updatedAt ? `${esc('updated ' + ago(o.updatedAt))}${o.source ? `<span class="obj-src">${esc(o.source)}</span>` : ''}` : esc(o.source || '')}</span></div>`;
  }
  return `<div class="card-r" style="flex-wrap: wrap; gap: 8px 14px">
<span class="obj-title" style="flex: 0 0 240px; min-width: 0">${esc(o.title)}</span>
<span class="t2" style="flex: 1 1 180px; font-size: 12px">Not broken into tasks yet</span></div>`;
}

function renderObjectives() {
  buildView('objectives', `<div class="view" style="max-width: 1100px">
<h1>Objectives</h1>
<div class="t2" style="display: flex; flex-wrap: wrap; gap: 16px; font-size: 12px">
<span style="display: flex; align-items: center; gap: 6px"><span class="dot" style="background: var(--ok); width: 12px; height: 12px"></span>Done</span>
<span style="display: flex; align-items: center; gap: 6px"><span class="dot" style="background: var(--work); width: 12px; height: 12px"></span>In progress</span>
<span style="display: flex; align-items: center; gap: 6px"><span class="dot" style="border: 2px solid var(--you); width: 12px; height: 12px"></span>Waiting on you</span>
<span style="display: flex; align-items: center; gap: 6px"><span class="dot" style="border: 2px dashed var(--wait); width: 12px; height: 12px"></span>Waiting on others</span>
<span style="display: flex; align-items: center; gap: 6px"><span class="dot" style="border: 1.5px solid var(--idle); width: 12px; height: 12px"></span>To do</span>
<span style="display: flex; align-items: center; gap: 6px"><svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.2L15.8 9 9 15.8 2.2 9z" fill="none" style="stroke: var(--you)" stroke-width="2"/></svg>Gate: asks you</span>
<span style="display: flex; align-items: center; gap: 6px"><svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 15V10M9 10L5 4.5M9 10l4-5.5" fill="none" style="stroke: var(--tx2)" stroke-width="2" stroke-linecap="round"/></svg>Branch</span>
</div>
<div id="o-rows" style="display: flex; flex-direction: column; gap: 16px"></div></div>`);
  const ps = ui.snap.projects.filter((p) => !p.unowned).sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
  const nameOf = (p, w = 600) => `<button class="linkish" data-goto="${escRaw(p.id)}" style="font-weight: ${w}">${esc(p.name)}</button>`;
  const without = ps.filter((p) => !p.brief && !(p.plans || []).length);
  // Projects without a brief: one quiet line each, in one card at the end.
  const quiet = without.length ? `<div class="card" style="overflow: hidden"><h2 class="card-h t2" style="font-size: 13px; font-weight: 600">No brief yet<span class="num t3" style="font-weight: 500">${without.length}</span></h2>${without.map((p) => `<div class="card-r" style="padding: 6px 16px">${stateIcon(ST[p.state])}<span style="flex: 1; min-width: 0">${nameOf(p, 500)}</span><button class="btn sm" data-act="write-brief" data-pid="${escRaw(p.id)}" ${p.folder ? '' : 'disabled title="No folder on disk"'}>Write the brief</button></div>`).join('')}</div>` : '';
  const h = ps.filter((p) => p.brief || (p.plans || []).length).map((p) => {
    const t = ST[p.state];
    const name = nameOf(p);
    const list = objectivesOf(p);
    const rows = list.length ? list.map((o) => (p.plan && o.plan && o.title === p.plan.title ? planRow(p) : objRow(o))).join('') : `<div class="card-r t2" style="font-size: 12px">The brief has no plan yet</div>`;
    const goal = p.brief ? (p.brief.goal || 'No goal in the brief yet') : 'No brief yet';
    const write = p.brief ? '' : `<button class="btn sm" data-act="write-brief" data-pid="${escRaw(p.id)}" ${p.folder ? '' : 'disabled title="No folder on disk"'}>Write the brief</button>`;
    return `<div class="card" style="overflow: hidden"><div class="card-h" style="align-items: center">${stateIcon(t)}${name}${draftTag(p)}<span class="t2" style="font-weight: 400; font-size: 13px; flex: 1; min-width: 0">${esc(goal)}</span>${write}</div>${rows}</div>`;
  }).join('');
  setHtml('o-rows', (h + quiet) || '<p class="t2">No projects yet.</p>');
}

// ------------------------------------------------------------ Rules
// docs/design/Repeats.dc.html: a switch between Your rules (the global
// CLAUDE.md, read-only) and Suggested (repeats, then the memory suggestions
// behind "N more from project memory").

async function getJson(url) {
  const r = await fetch(url);
  if (r.status === 401) signedOut();
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

async function loadRules(fresh) {
  const [mine, reps, mem] = await Promise.allSettled([
    getJson('/api/rules/mine'),
    getJson('/api/rules/repeats'),
    getJson('/api/rules' + (fresh ? '?fresh=1' : '')),
  ]);
  ui.mine = mine.status === 'fulfilled' ? mine.value : { error: mine.reason.message, groups: [], count: 0 };
  ui.repeats = reps.status === 'fulfilled' ? reps.value : { error: reps.reason.message, rows: [], count: 0 };
  ui.rules = mem.status === 'fulfilled' ? mem.value : { error: mem.reason.message, rules: [] };
  // First look on a board that never ran the detector: the seed is loading.
  clearTimeout(loadRules._t);
  if (ui.repeats && ui.repeats.seeded === false) loadRules._t = setTimeout(() => { if (ui.view === 'rules') loadRules(); }, 1500);
  if (ui.view === 'rules') render();
}

const COUNT_STYLE = 'font-size: 11.5px; color: var(--tx3); margin-left: 6px';
const codeSpans = (html) => html.replace(/`([^`]+)`/g, '<span class="mono">$1</span>');

function renderRules() {
  buildView('rules', `<div class="view" style="max-width: 1100px">
<h1>Rules</h1>
<nav class="mc-views rs-switch" aria-label="Rules view" id="r-switch"></nav>
<div id="r-body" class="rs-body"></div></div>`);
  const tab = ui.rulesTab === 'sug' ? 'sug' : 'mine';
  const M = ui.mine;
  const P = ui.repeats;
  const seg = (k, label, n) => `<button class="seg ${tab === k ? 'on' : ''}" data-rtab="${k}" ${tab === k ? 'aria-current="page"' : ''}>${label}${n != null ? `<span class="num" style="${COUNT_STYLE}">${n}</span>` : ''}</button>`;
  setHtml('r-switch', seg('mine', 'Your rules', M && !M.error ? M.count : null) + seg('sug', 'Suggested', P && !P.error && P.seeded !== false ? P.count : null));
  if (tab === 'mine') {
    if (!M) { setHtml('r-body', '<p class="t2">Reading your CLAUDE.md...</p>'); return; }
    if (M.error) { setHtml('r-body', `<p class="err-line">${esc(M.error)}</p>`); return; }
    // Each scope (every project, then each project) as two columns: the
    // CLAUDE.md Claude Code reads and the AGENTS.md Codex reads, each whole
    // with its path; on a phone they stack (docs/design/CodexStage2.dc.html,
    // section 4, A).
    if (M.scopes) { setHtml('r-body', M.scopes.map(rulesScope).join('')); return; }
    const cards = M.groups.map((g) => `<div class="card yr-card"><h3 class="card-h ch-s"><span style="flex: 1">${esc(g.heading)}</span></h3>${g.rules.map((r) => `<div class="yr-r">${codeSpans(esc(r))}</div>`).join('')}</div>`).join('');
    setHtml('r-body', `<p class="sec-sub">From <span class="mono">${esc(M.path)}</span>. Every session in every project reads these.</p>
<div class="yr-cols">${cards || '<p class="t2">No rules in it yet.</p>'}</div>`);
    return;
  }
  if (!P) { setHtml('r-body', '<p class="t2">Reading your sessions...</p>'); return; }
  if (P.error) { setHtml('r-body', `<p class="err-line">${esc(P.error)}</p>`); return; }
  if (P.seeded === false) { setHtml('r-body', '<p class="t2">Reading your sessions for the first time...</p>'); return; }
  const rows = P.rows.map((r, k) => repeatRow(r, k)).join('');
  const R = ui.rules;
  const more = R && !R.error ? R.pending : 0;
  setHtml('r-body', `<p class="sec-sub">Things you corrected more than once, from your last ${P.sessions} sessions in ${esc(P.scope)}.</p>
${rows ? `<div class="card" style="overflow: hidden">${rows}</div>` : P.auto === false && !P.lastRun ? '<div class="card"><div class="card-r t2" style="border-top: 0">Suggestions are off. To turn them on, run <span class="mono">ravenry setup</span> in a terminal: once a day the board then sends the messages you typed to ${printWho()}, on your own ${printWho()} login, to find what you keep correcting.</div></div>' : '<div class="card"><div class="card-r t2" style="border-top: 0">Nothing you keep saying is waiting. The board keeps counting.</div></div>'}
<div class="quiet-line"><span>${more} more from project memory</span><button class="linkish" style="color: var(--work)" data-act="rules-more" aria-expanded="${ui.rulesMore ? 'true' : 'false'}">${ui.rulesMore ? 'Hide' : 'Show'}</button></div>
${ui.rulesMore ? '<div id="r-rows"></div>' : ''}`);
  if (ui.rulesMore) renderMemoryRules();
}

function rulesScope(sc) {
  const col = (f, kind) => {
    const name = kind === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
    const none = !f.exists ? (sc.folder ? `No ${name} in this project.` : `No ${f.path} yet.`) : !f.groups.length ? 'No rules in it yet.' : '';
    return `<div class="rl-col"><div class="rl-file"><span class="mono">${esc(f.path)}</span>${asTag(kind)}</div>${none ? `<div class="rl-none">${esc(none)}</div>` : f.groups.map((g) => `<div class="card yr-card rl-card"><h3 class="card-h ch-s"><span style="flex: 1">${esc(g.heading)}</span></h3>${g.rules.map((r) => `<div class="yr-r">${codeSpans(esc(r))}</div>`).join('')}</div>`).join('')}</div>`;
  };
  return `<div class="rl-scope">${esc(sc.name)}<span>${esc(sc.folder || 'read by every session')}</span></div><div class="rl-cols">${col(sc.claude, 'claude')}${col(sc.codex, 'codex')}</div>`;
}

function repeatRow(r, k) {
  const open = ui.openRepeat === r.id;
  const q = r.quote ? `<div class="rp-q"><span class="rp-qt">${esc(r.quote.text)}</span><span class="rp-src">${esc(r.quote.project)}, ${esc(r.quote.date)}</span></div>` : '';
  // The two counts are coloured, so they read in one look.
  // sessionsText names the assistant whose sessions said it ("2 Codex sessions").
  const ev = `Said <span class="sg-n">${r.messages} times</span> in <span class="sg-n">${esc(r.sessionsText || r.sessions + ' sessions')}</span>, last on ${esc(r.last)}.${r.tail ? ' ' + esc(r.tail) : ''}`;
  const head = `<div class="sg-rule">${esc(r.rule)}</div><div class="t2 sg-ev">${ev}</div>${q}`;
  const top = k === 0 ? 'border-top: 0' : '';
  if (!open) {
    return `<div class="card-r sg-row" style="${top}"><div class="sg-main">${head}</div>
<div class="sg-btns"><button class="btn sm pri" data-rep="${escRaw(r.id)}" data-rep-act="open">${esc(r.button)}</button><button class="btn sm" data-rep="${escRaw(r.id)}" data-rep-act="notnow">Not now</button></div></div>`;
  }
  const v = r.preview;
  const err = ui.repeatError && ui.repeatError.id === r.id ? `<p class="err-line" style="margin: 0">${esc(ui.repeatError.text)}</p>` : '';
  const busy = ui.repeatBusy === r.id ? 'disabled' : '';
  return `<div class="card-r sg-row open" style="${top}"><div class="sg-main">${head}
<div class="pv"><div class="pv-h">${v.parts ? v.parts.map((x) => (x.file ? `<span class="mono">${esc(x.file)}</span>` : esc(x.text))).join('') : `${esc(v.lead)} <span class="mono">${esc(v.file)}</span>${esc(v.after)}`}</div>
${v.now ? `<div class="pv-row"><span class="pv-l">${esc(v.nowLabel)}</span><span class="pv-t old">${codeSpans(esc(v.now))}</span></div>` : ''}
<div class="pv-row"><span class="pv-l">${esc(v.nextLabel)}</span><span class="pv-t new">${codeSpans(esc(v.next))}</span></div>${err}
<div class="pv-btns"><button class="btn sm pri" data-rep="${escRaw(r.id)}" data-rep-act="save" ${busy}>Save</button><button class="btn sm" data-rep="${escRaw(r.id)}" data-rep-act="cancel" ${busy}>Cancel</button></div></div></div></div>`;
}

async function repeatAction(id, act) {
  if (act === 'open') { ui.openRepeat = id; ui.repeatError = null; render(); return; }
  if (act === 'cancel') { ui.openRepeat = null; ui.repeatError = null; render(); return; }
  const r = ui.repeats && ui.repeats.rows.find((x) => x.id === id);
  if (!r) return;
  const action = act === 'notnow' ? 'notnow' : r.kind;
  ui.repeatBusy = id;
  render();
  try {
    const j = await post('/api/repeats/' + encodeURIComponent(id), { action });
    ui.openRepeat = null;
    ui.repeatError = null;
    toast(action === 'notnow' ? 'Hidden until you say it again' : `${j.already ? 'Already in' : 'Written to'} ${j.target.join(' and ')}${j.backup.length ? '. Backup first in ' + j.backup[0].replace(/\/[^/]+$/, '') : ''}`);
  } catch (e) {
    if (ui.openRepeat === id) ui.repeatError = { id, text: e.message }; else toast(e.message);
  }
  ui.repeatBusy = null;
  await loadRules(true);
}

// The memory suggestions as they were before Suggested existed, unchanged,
// behind "N more from project memory".
function renderMemoryRules() {
  const R = ui.rules;
  if (!R) { setHtml('r-rows', '<p class="t2">Reading the memory folders...</p>'); return; }
  if (R.error) { setHtml('r-rows', `<p class="err-line">${esc(R.error)}</p>`); return; }
  if (!R.rules.length) { setHtml('r-rows', '<div class="card"><div class="card-r t2" style="border-top: 0">Nothing to suggest. Every feedback memory in scope is already in your global CLAUDE.md.</div></div>'); return; }
  setHtml('r-rows', `<div class="card" style="overflow: hidden">${R.rules.map((r, k) => `<div class="card-r" style="flex-wrap: wrap; gap: 10px 18px; padding: 14px 16px; ${k === 0 ? 'border-top: 0' : ''}">
<div style="flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 3px"><span style="font-weight: 600; font-size: 14.5px; line-height: 1.4">${esc(r.text)}</span><span class="t2" style="font-size: 12.5px; line-height: 1.45">${esc(r.why)}</span></div>
${r.pending ? `<div style="display: flex; gap: 6px; flex-wrap: wrap"><button class="btn sm pri" data-rule="${escRaw(r.id)}" data-action="global">Every project</button><button class="btn sm" data-rule="${escRaw(r.id)}" data-action="local">${esc(r.localLabel)}</button><button class="btn sm" data-rule="${escRaw(r.id)}" data-action="dismiss">Not a rule</button></div>`
    : `<span style="font-size: 12.5px; font-weight: 600; color: ${r.done && r.done.action === 'dismiss' ? 'var(--tx2)' : 'var(--ok)'}">${esc(r.done ? r.done.label : '')}</span>`}
</div>`).join('')}</div>`);
}

async function decideRule(id, action, btn) {
  const row = btn.closest('.card-r');
  row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    const r = await post('/api/rules/' + encodeURIComponent(id), { action });
    toast(action === 'dismiss' ? 'Remembered: not a rule' : `${r.already ? 'Already in' : 'Written to'} ${r.target.join(' and ')}${r.backup.length ? '. Backup first in ' + r.backup[0].replace(/\/[^/]+$/, '') : ''}`);
  } catch (e) {
    toast(e.message);
  }
  await loadRules(true);
}

// ------------------------------------------------------------ Ship

async function loadShip() {
  try {
    const r = await fetch('/api/ship');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    ui.ship = j;
  } catch (e) {
    ui.ship = { error: e.message };
  }
  if (ui.view === 'ship') render();
}

function check(ok, label, warn) {
  const style = ok ? 'background:var(--ok)' : warn ? 'border:2px solid var(--you)' : 'border:1.5px solid var(--idle)';
  return `<span style="display: flex; align-items: center; gap: 8px; color: ${ok || warn ? 'var(--tx)' : 'var(--tx2)'}"><span class="dot" style="${style}"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="${ok ? CHECK : ''}" stroke="#FFFFFF" stroke-width="2" fill="none"></path></svg></span><span style="min-width: 0; overflow-wrap: anywhere">${esc(label)}</span></span>`;
}

function renderShip() {
  buildView('ship', `<div class="view" style="max-width: 1000px">
<h1>Ship</h1>
<div id="s-tiles"></div>
<div id="s-repos" style="display: flex; flex-direction: column; gap: 12px"></div></div>`);
  const S = ui.ship;
  if (!S) { setHtml('s-repos', '<p class="t2">Reading git...</p>'); return; }
  if (S.error) { setHtml('s-repos', `<p class="err-line">${esc(S.error)}</p>`); return; }
  const T = S.totals;
  const tiles = [];
  tiles.push(`<div class="card" style="padding: 14px 16px; display: flex; flex-direction: column; gap: 4px"><span class="t2" style="font-size: 12.5px">Unpushed commits</span><span class="num" style="font-size: 24px; font-weight: 700">${T.unpushed}</span><span class="t3" style="font-size: 12px">${T.reposWithUpstream ? (T.reposAhead ? `In ${T.reposAhead} of ${T.reposWithUpstream} repos with an upstream` : `All ${T.reposWithUpstream} repos with an upstream match it`) : 'No repo has an upstream'}</span></div>`);
  tiles.push(`<div class="card" style="padding: 14px 16px; display: flex; flex-direction: column; gap: 4px"><span class="t2" style="font-size: 12.5px">Uncommitted work</span><span class="num" style="font-size: 24px; font-weight: 700">${T.reposChanged}</span><span class="t3" style="font-size: 12px">${T.reposChanged === 1 ? 'Repo' : 'Repos'} with tracked files changed, of ${T.repos}</span></div>`);
  if (T.waitingYou != null) tiles.push(`<div class="card" style="padding: 14px 16px; display: flex; flex-direction: column; gap: 4px"><span class="t2" style="font-size: 12.5px">Waiting for your call</span><span class="num" style="font-size: 24px; font-weight: 700">${T.waitingYou}</span><span class="t3" style="font-size: 12px">Prod deploys stay yours</span></div>`);
  setHtml('s-tiles', `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px">${tiles.join('')}</div>`);
  setHtml('s-repos', S.repos.map((r) => {
    const pic = r.projects.map((p) => p.picture).find(Boolean);
    let status;
    if (r.ahead > 0) status = [`${r.ahead} commit${r.ahead > 1 ? 's' : ''} to push`, 'var(--you)'];
    else if (r.changed > 0) status = ['Uncommitted changes', 'var(--tx2)'];
    else if (!r.upstream) status = ['No upstream', 'var(--tx3)'];
    else status = ['Pushed and clean', 'var(--ok)'];
    const lc = r.lastCommit;
    const lcAt = lc ? parseT(lc.at) : null;
    const lines = [];
    if (r.upstream) lines.push(r.ahead > 0 ? check(false, `${r.ahead} commit${r.ahead > 1 ? 's' : ''} not pushed to ${r.upstream}`, true) : check(true, `Pushed: ${r.branch || 'HEAD'} matches ${r.upstream}${r.behind ? `, ${r.behind} behind it` : ''}`));
    else lines.push(check(false, `No upstream for ${r.branch || 'HEAD'}, so nothing to compare`));
    if (r.changed != null) lines.push(r.changed ? check(false, `${r.changed} tracked file${r.changed > 1 ? 's' : ''} changed, not committed`, true) : check(true, 'No uncommitted changes to tracked files'));
    const projectBlocks = r.projects.filter((p) => p.ship || p.shipCommand).map((p) => {
      let h = '';
      if (p.ship) h += `<div style="display: flex; flex-direction: column; gap: 7px"><span class="t2" style="font-size: 12px; font-weight: 600">${esc(p.name)}: Ship</span>${p.ship.map((x) => { const c = taskDot(x.state); return `<span style="display: flex; align-items: center; gap: 8px; color: ${c.tc}"><span class="dot" style="${c.dotStyle}"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="${c.check}" stroke="#FFFFFF" stroke-width="2" fill="none"></path></svg></span><span style="flex: 1; min-width: 0; font-weight: ${c.fw}">${esc(x.text)}</span>${c.tag ? `<span style="font-size: 11.5px; font-weight: 600; color: ${c.tagC}">${c.tag}</span>` : ''}</span>`; }).join('')}</div>`;
      if (p.shipCommand) h += `<div style="display: flex; flex-direction: column; gap: 6px"><span class="t2" style="font-size: 12px">${esc(p.name)}: your call. Run it yourself in ${esc(boardTerm())} when you decide.</span><div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap"><code class="cmd">! ${escRaw(p.shipCommand)}</code><button class="btn sm" data-copy="${escRaw('! ' + p.shipCommand)}">Copy</button></div></div>`;
      return h;
    }).join('');
    return `<div class="card" style="overflow: hidden; display: flex; flex-wrap: wrap">
${pic ? `<img src="${escRaw(pic.url)}" alt="${esc(pic.alt)}" style="flex: 0 0 300px; width: 300px; max-width: 100%; display: block; object-fit: cover">` : ''}
<div style="flex: 1 1 300px; min-width: 0; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px">
<span style="font-size: 12.5px; font-weight: 600; color: ${status[1]}">${esc(status[0])}</span>
<span style="font-size: 18px; font-weight: 700">${r.projects.map((p) => `<button class="linkish" data-goto="${escRaw(p.id)}">${esc(p.name)}</button>`).join(', ')}</span>
<span class="t2" style="font-size: 12.5px; overflow-wrap: anywhere">${esc(r.topShort)}${r.branch ? ' on ' + esc(r.branch) : ''}${lc ? `. Last commit ${esc(lc.hash)} ${lcAt ? rel(lcAt) + (rel(lcAt) === 'now' ? '' : ' ago') : ''}: ${esc(lc.subject.length > 140 ? lc.subject.slice(0, 137) + '...' : lc.subject)}` : ''}</span>
<div style="display: flex; flex-direction: column; gap: 7px">${lines.join('')}</div>
${projectBlocks}
</div></div>`;
  }).join('') || '<p class="t2">No project lives in a git repo.</p>');
}

// ------------------------------------------------------------ Ideas

async function loadIdeas() {
  try {
    ui.ideas = await (await fetch('/api/ideas')).json();
  } catch (e) {
    ui.ideas = { ideas: [], error: e.message };
  }
  if (ui.view === 'ideas') render();
}

function ideaById(id) {
  if (!ui.ideas || !id) return null;
  return ui.ideas.ideas.find((x) => x.id === id) || ui.ideas.ideas.find((x) => x.name.toLowerCase() === String(id).toLowerCase()) || null;
}

function renderIdeas() {
  const fresh = buildView('ideas', `<div style="display: flex; flex-wrap: wrap; align-items: flex-start">
<div class="ideas-main" style="flex: 999 1 560px; min-width: 0; padding: 26px 30px 36px; display: flex; flex-direction: column; gap: 16px; box-sizing: border-box">
<h1 style="margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.02em">Ideas</h1>
<div class="card" style="padding: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
<input id="seed" class="field" aria-label="Brainstorm seed, or a new idea" placeholder="Brainstorm with ${printWho()}: a seed, e.g. a cosy co-op game for the TV" style="flex: 1 1 320px; min-width: 0">
<button class="btn" id="add-idea" title="Adds it to Spark as it is">Add idea</button>
<button class="btn pri" id="brainstorm">Get 3 directions</button>
<div id="i-brain" style="flex: 1 1 100%"></div>
</div>
<span class="t3" style="font-size: 12px">Drag a card to another column. Click one to open it. Drop or paste a picture on a card to attach it.</span>
<div id="i-lanes" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; align-items: start"></div>
</div>
<aside id="i-panel" class="ideas-panel" style="flex: 1 1 360px; max-width: 460px; min-width: 0; padding: 26px 24px 36px 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px"></aside>
</div>`);
  if (fresh) { wireIdeas(); ui.panelFor = null; }
  const D = ui.ideas;
  if (!D) { setHtml('i-lanes', '<p class="t2">Loading ideas...</p>'); return; }
  const list = D.ideas;
  setHtml('i-lanes', IDEA_COLS.map(([k, label, c, tint]) => {
    const items = list.filter((x) => x.stage === k);
    return `<div class="lane" data-lane="${k}" style="background: ${tint}" aria-label="${label}, ${items.length} ideas">
<div style="display: flex; align-items: center; gap: 8px; padding: 2px 4px; font-weight: 650; font-size: 12.5px; color: ${c}"><span style="flex: 1">${label}</span><span class="cnt num" style="background:var(--card2);color:var(--tx2)">${items.length}</span></div>
${items.map((it) => `<button class="idea ${ui.selIdea === it.id ? 'sel' : ''}" draggable="true" data-idea="${escRaw(it.id)}" aria-label="${esc(it.name)}: ${esc(it.pitch)}">
${it.img ? `<img class="pic" src="${escRaw(it.img)}" alt="${esc(it.alt)}" draggable="false">` : ''}
<div style="padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 4px">
<span style="font-weight: 600; font-size: 14px">${esc(it.name)}</span>
${it.pitch ? `<span class="t2" style="font-size: 12.5px; line-height: 1.4">${esc(it.pitch)}</span>` : ''}
${it.pending ? `<span class="working" style="font-size: 11.5px; color: var(--work)">${jobWho(it.pending)} is answering...</span>` : mkCardLine(it) || (it.thread.length ? `<span class="t3" style="font-size: 11.5px">${it.thread.length} message${it.thread.length === 1 ? '' : 's'}</span>` : '')}
</div></button>`).join('')}
</div>`;
  }).join(''));
  // Brainstorm state
  let b = '';
  if (D.brainstorm) b = `<span class="working" style="font-size: 12.5px; color: var(--work)">${jobWho(D.brainstorm)} is thinking up 3 directions for "${esc(D.brainstorm.seed)}". ${secs(D.brainstorm.startedAt)} so far; it stops at 3 minutes.</span>`;
  else if (D.brainstormError) b = `<span class="err-line">${esc(D.brainstormError)}</span> <button class="btn sm" id="brain-ok" style="margin-left: 6px">OK</button>`;
  setHtml('i-brain', b);
  // The page is drawn before the board's state names who Ideas run on.
  const sd = $('#seed');
  const sp = `Brainstorm with ${printWho()}: a seed, e.g. a cosy co-op game for the TV`;
  if (sd && sd.placeholder !== sp) sd.placeholder = sp;
  const bb = $('#brainstorm');
  if (bb) bb.disabled = !!D.brainstorm;
  renderIdeaPanel();
}

function secs(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function renderIdeaPanel() {
  const panel = $('#i-panel');
  if (!panel) return;
  const it = ideaById(ui.selIdea);
  if (!it) { panel.hidden = true; ui.panelFor = null; return; }
  if (ui.selIdea !== it.id) { ui.selIdea = it.id; delete ui.html['i-lanes']; renderIdeas(); return; }
  panel.hidden = false;
  if (ui.panelFor !== it.id) {
    ui.panelFor = it.id;
    for (const k of ['i-pic', 'i-stages', 'i-thread', 'i-actions', 'i-refs', 'mk-head', 'mk-body', 'mk-foot']) delete ui.html[k];
    panel.innerHTML = `<div class="card" style="overflow: hidden" id="i-card">
<div id="i-pic"></div>
<div style="padding: 14px 16px; display: flex; flex-direction: column; gap: 12px">
<div style="display: flex; align-items: center; gap: 8px"><input class="name-in" id="i-name" aria-label="Idea name"><button class="x-btn" id="i-close" aria-label="Close idea">${X_ICON}</button></div>
<div id="i-stages" style="display: flex; gap: 4px; flex-wrap: wrap; background: var(--card2); border-radius: 8px; padding: 3px" role="group" aria-label="Stage"></div>
<label class="inp">Pitch<textarea id="i-pitch" style="min-height: 52px"></textarea></label>
<label class="inp">Where it stands<textarea id="i-status" style="min-height: 40px"></textarea></label>
</div></div>
<div class="card mk-card" id="mk-card">
<h2 class="card-h"><span style="flex: 1">Mockups</span><span id="mk-head"></span></h2>
<div id="mk-body"></div>
<div class="mk-pad mk-tail" id="mk-tail"><div class="mk-again"><input class="field" id="mk-note" aria-label="What to change in the next round" placeholder="What to change next" autocomplete="off"><button class="btn" data-mk="again" id="mk-again">Another round</button></div><span class="t3 mk-foot" id="mk-foot"></span></div>
</div>
<div class="card" style="overflow: hidden">
<h2 class="card-h" id="i-talk">Talk it through with ${printWho()}</h2>
<div style="padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px">
<div id="i-thread" style="display: flex; flex-direction: column; gap: 8px" aria-live="polite"></div>
<div id="i-chips" style="display: flex; flex-wrap: wrap; gap: 6px"></div>
<div id="i-compose" style="display: flex; flex-direction: column; gap: 6px; background: var(--input); border: 1px solid var(--sep); border-radius: 10px; padding: 8px 8px 8px 11px">
<div id="i-refs" style="display: flex; gap: 6px; flex-wrap: wrap"></div>
<div style="display: flex; gap: 8px; align-items: flex-end">
<textarea id="idea-msg" aria-label="Message about this idea" placeholder="Ask, push back, drop a reference image" style="all: unset; flex: 1; min-height: 36px; font-size: 13.5px; color: var(--tx); white-space: pre-wrap; word-break: break-word"></textarea>
<button class="btn sm pri" id="idea-send">Send</button></div></div>
</div></div>
<div id="i-actions" style="display: flex; gap: 8px; flex-wrap: wrap"></div>`;
    $('#i-name').value = it.name;
    $('#i-pitch').value = it.pitch;
    $('#i-status').value = it.status;
    $('#idea-msg').value = (ui.ideaDrafts[it.id] || '');
    $('#mk-note').value = (ui.mk[it.id] && ui.mk[it.id].draft) || '';
    wireIdeaPanel(it.id);
  } else {
    // Fresh values from the server, except in a field being edited.
    for (const [sel, k] of [['#i-name', 'name'], ['#i-pitch', 'pitch'], ['#i-status', 'status']]) {
      const el = $(sel);
      if (el && document.activeElement !== el && !el.dataset.dirty && el.value !== it[k]) el.value = it[k];
    }
  }
  // While the idea has mockups, the Mockups card's big picture is the picture.
  const hasRounds = !!(it.mockups && it.mockups.rounds.length);
  setHtml('i-pic', it.img && !hasRounds ? `<img class="pic" src="${escRaw(it.img)}" alt="${esc(it.alt)}">` : '');
  renderMockups(it);
  setHtml('i-stages', IDEA_COLS.map(([k, label]) => `<button class="btn sm" data-stage="${k}" aria-pressed="${it.stage === k}" style="flex: 1; background: ${it.stage === k ? 'var(--btn)' : 'transparent'}">${label}</button>`).join(''));
  const th = it.thread.map((m) => m.who === 'board' ? `<div class="mk-sys">${PICTURE_ICON}<span>${esc(m.text)}</span></div>` : `<div class="msg ${m.error ? 'err' : m.who}">${m.error ? '<b style="color: var(--bad)">Not answered. </b>' : ''}${m.who === 'claude' || m.who === 'codex' ? esc(m.text).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>') : esc(m.text)}${m.images.map((u) => `<img src="${escRaw(u)}" alt="Attached picture">`).join('')}</div>`);
  if (it.pending) th.push(`<div class="msg claude working" id="i-pending">${jobWho(it.pending)} is thinking, ${secs(it.pending.startedAt)}. It stops at 3 minutes.</div>`);
  const tk = $('#i-talk');
  if (tk && tk.textContent !== `Talk it through with ${printWho()}`) tk.textContent = `Talk it through with ${printWho()}`;
  setHtml('i-thread', th.join('') || '<span class="t3" style="font-size: 12px">Nothing said yet. Ask anything, or start from a suggestion.</span>');
  const chips = CHIPS[it.stage === 'green' ? 'green' : it.stage === 'park' ? 'park' : 'other'];
  setHtml('i-chips', chips.map((c) => `<button class="btn sm" data-chip="${escRaw(c)}" ${it.pending ? 'disabled' : ''}>${esc(c)}</button>`).join(''));
  const send = $('#idea-send');
  if (send) send.disabled = !!it.pending;
  const refs = ui.ideaRefs[it.id] || [];
  setHtml('i-refs', refs.map((r, k) => `<span style="position: relative"><img class="thumb" src="${escRaw(r.url)}" alt="Attached picture ${k + 1}"><button class="x-btn" data-unref="${k}" aria-label="Remove picture ${k + 1}" style="position: absolute; top: -6px; right: -6px; width: 20px; height: 20px">${X_ICON}</button></span>`).join(''));
  const rr = $('#i-refs');
  if (rr) rr.hidden = !refs.length;
  setHtml('i-actions', `${it.stage === 'green' ? '<button class="btn pri" id="i-promote">Promote to project</button>' : ''}<button class="btn" id="i-kill" style="color: var(--bad)">Kill</button>`);
}

function imageFiles(dt) {
  return Array.from((dt && dt.files) || []).filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|avif)$/i.test(f.name));
}

async function attachPicture(id, file) {
  try {
    await post(`/api/ideas/${encodeURIComponent(id)}/image`, file, { 'X-Filename': encodeURIComponent(file.name || 'image.png') });
    toast('Picture attached');
  } catch (e) {
    toast(e.message);
  }
}

async function attachRef(id, file) {
  try {
    const r = await post(`/api/ideas/${encodeURIComponent(id)}/ref`, file, { 'X-Filename': encodeURIComponent(file.name || 'image.png') });
    (ui.ideaRefs[id] = ui.ideaRefs[id] || []).push({ file: r.file, url: r.url });
    renderIdeaPanel();
  } catch (e) {
    toast(e.message);
  }
}

function wireIdeas() {
  const lanes = $('#i-lanes');
  lanes.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.idea');
    if (!card) return;
    ui.drag = card.dataset.idea;
    card.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', ui.drag); e.dataTransfer.effectAllowed = 'move'; } catch { /* old browser */ }
  });
  lanes.addEventListener('dragend', (e) => { const c = e.target.closest('.idea'); if (c) c.classList.remove('dragging'); ui.drag = null; lanes.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
  lanes.addEventListener('dragover', (e) => {
    const files = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const target = files ? e.target.closest('.idea') : e.target.closest('.lane');
    if (!target) return;
    e.preventDefault();
    lanes.querySelectorAll('.over').forEach((x) => { if (x !== target) x.classList.remove('over'); });
    target.classList.add('over');
  });
  lanes.addEventListener('dragleave', (e) => { const t = e.target.closest('.over'); if (t && !t.contains(e.relatedTarget)) t.classList.remove('over'); });
  lanes.addEventListener('drop', async (e) => {
    lanes.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
    const imgs = imageFiles(e.dataTransfer);
    if (imgs.length) {
      const card = e.target.closest('.idea');
      if (!card) return;
      e.preventDefault();
      attachPicture(card.dataset.idea, imgs[0]);
      return;
    }
    const lane = e.target.closest('.lane');
    const id = ui.drag || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
    ui.drag = null;
    if (!lane || !id || !ideaById(id)) return;
    e.preventDefault();
    const to = lane.dataset.lane;
    if (ideaById(id).stage === to) return;
    moveIdea(id, to);
  });
  lanes.addEventListener('click', (e) => {
    const card = e.target.closest('.idea');
    if (!card) return;
    ui.selIdea = card.dataset.idea;
    store.set('selIdea', ui.selIdea);
    render();
    if (window.matchMedia('(max-width: 700px)').matches) $('#i-panel').scrollIntoView({ block: 'start' });
  });
  // Paste a picture while a card is focused, or anywhere with one open.
  document.addEventListener('paste', (e) => {
    if (ui.view !== 'ideas') return;
    const imgs = imageFiles(e.clipboardData);
    if (!imgs.length) return;
    if (e.target.id === 'idea-msg') return; // handled by the composer
    const card = document.activeElement && document.activeElement.closest && document.activeElement.closest('.idea');
    const id = card ? card.dataset.idea : ui.selIdea;
    if (!id) return;
    e.preventDefault();
    attachPicture(id, imgs[0]);
  });
  const seed = $('#seed');
  seed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); brainstorm(); } });
  $('#brainstorm').addEventListener('click', brainstorm);
  $('#add-idea').addEventListener('click', addIdea);
  $('#i-brain').addEventListener('click', (e) => { if (e.target.id === 'brain-ok') post('/api/ideas/brainstorm/clear', {}).catch(() => {}); });
}

async function moveIdea(id, to) {
  const it = ideaById(id);
  if (it) it.stage = to; // at once; the server's answer follows over SSE
  render();
  try {
    await post(`/api/ideas/${encodeURIComponent(id)}/update`, { stage: to });
    toast(`Moved to ${STAGE_NAME[to]}`);
  } catch (e) {
    toast(e.message);
    loadIdeas();
  }
}

// The seed box is cleared once the board took what was in it, but only if it
// still holds that: text typed while the answer was on its way stays (an
// Add idea answer that came back late wiped a new seed typed after it, or
// moved the focus to the new idea's pitch in the middle of it, and the next
// Get 3 directions then had nothing to send). A later action in the box
// also wins over an earlier one's selection.
let seedActs = 0;
function clearSeedIf(text) {
  const el = $('#seed');
  if (el && el.value.trim() === text) el.value = '';
}

async function brainstorm() {
  const seed = $('#seed').value.trim();
  if (!seed) { toast('Write a seed first, e.g. a cosy co-op game for the TV'); $('#seed').focus(); return; }
  seedActs++;
  try {
    await post('/api/ideas/brainstorm', { seed });
    clearSeedIf(seed);
    ui.wantBrainstorm = true;
  } catch (e) {
    toast(e.message);
  }
}

async function addIdea() {
  const text = $('#seed').value.trim();
  if (!text) { toast('Type the idea in the box first'); $('#seed').focus(); return; }
  const act = ++seedActs;
  // Where the focus was when Add was pressed: the new idea's pitch takes it
  // only if it is still there (typing a new seed while the answer was on its
  // way went on in the pitch box instead).
  const from = document.activeElement;
  try {
    const r = await post('/api/ideas/add', { name: text });
    clearSeedIf(text);
    toast('Added to Spark');
    if (act !== seedActs) { await loadIdeas(); return; } // something newer was asked from the box meanwhile
    ui.selIdea = r.id;
    await loadIdeas();
    const p = $('#i-pitch');
    const now = document.activeElement;
    if (p && act === seedActs && (now === from || !now || now === document.body)) p.focus();
  } catch (e) {
    toast(e.message);
  }
}

function wireIdeaPanel(id) {
  const save = async (field, el) => {
    const it = ideaById(id);
    if (!it || el.value.trim() === it[field]) { delete el.dataset.dirty; return; }
    try {
      await post(`/api/ideas/${encodeURIComponent(id)}/update`, { [field]: el.value });
      it[field] = el.value.trim();
      delete el.dataset.dirty;
    } catch (e) { toast(e.message); }
  };
  for (const [sel, k] of [['#i-name', 'name'], ['#i-pitch', 'pitch'], ['#i-status', 'status']]) {
    const el = $(sel);
    el.addEventListener('input', () => { el.dataset.dirty = '1'; });
    el.addEventListener('change', () => save(k, el));
    el.addEventListener('blur', () => { if (el.dataset.dirty) save(k, el); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (k === 'name' || e.metaKey || e.ctrlKey)) { e.preventDefault(); el.blur(); } });
  }
  $('#i-close').addEventListener('click', () => { ui.selIdea = null; store.set('selIdea', null); render(); });
  $('#i-stages').addEventListener('click', (e) => { const b = e.target.closest('[data-stage]'); if (b && ideaById(id).stage !== b.dataset.stage) moveIdea(id, b.dataset.stage); });
  $('#i-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-chip]'); if (b) sayIdea(id, b.dataset.chip); });
  const msg = $('#idea-msg');
  msg.addEventListener('input', () => { ui.ideaDrafts[id] = msg.value; });
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sayIdea(id); } });
  msg.addEventListener('paste', (e) => { const imgs = imageFiles(e.clipboardData); if (imgs.length) { e.preventDefault(); imgs.forEach((f) => attachRef(id, f)); } });
  const box = $('#i-compose');
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.style.borderColor = 'var(--work)'; });
  box.addEventListener('dragleave', () => { box.style.borderColor = ''; });
  box.addEventListener('drop', (e) => { e.preventDefault(); box.style.borderColor = ''; imageFiles(e.dataTransfer).forEach((f) => attachRef(id, f)); });
  $('#i-refs').addEventListener('click', (e) => { const b = e.target.closest('[data-unref]'); if (b) { ui.ideaRefs[id].splice(Number(b.dataset.unref), 1); renderIdeaPanel(); } });
  $('#idea-send').addEventListener('click', () => sayIdea(id));
  $('#mk-card').addEventListener('click', (e) => mockupAct(id, e));
  const note = $('#mk-note');
  note.addEventListener('input', () => { mkState(id).draft = note.value; });
  note.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#mk-again').click(); } });
  const card = $('#i-card');
  card.addEventListener('dragover', (e) => { if (Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); card.style.boxShadow = '0 0 0 2px var(--work)'; } });
  card.addEventListener('dragleave', () => { card.style.boxShadow = ''; });
  card.addEventListener('drop', (e) => { const imgs = imageFiles(e.dataTransfer); card.style.boxShadow = ''; if (imgs.length) { e.preventDefault(); attachPicture(id, imgs[0]); } });
  $('#i-actions').addEventListener('click', async (e) => {
    if (e.target.id === 'i-promote') {
      const it = ideaById(id);
      openModal({ mode: 'new', ideaId: id, prefill: { name: it.name, goal: it.pitch, stage: 'Greenlit' } });
    }
    if (e.target.id === 'i-kill') {
      const it = ideaById(id);
      try {
        await post(`/api/ideas/${encodeURIComponent(id)}/kill`, {});
        ui.selIdea = null;
        toast(`${it.name} killed. Kept in the archive.`);
      } catch (err) { toast(err.message); }
    }
  });
}

// ---- Mockups (docs/design/IdeaMockups.dc.html, variant A): a card above
// the thread with one big picture, the round's 3 thumbnails, Pick, a note
// and Another round. The board card shows the cover, the latest round's
// thumbnails and one line.

const PICTURE_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"></rect><path d="M2 11l3.5-3.5 3 3 2-2L14 12"></path><circle cx="10.5" cy="6" r="1"></circle></svg>';
const STOP_ICON = '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor"></rect></svg>';
const CHECK_SVG = (c, sz = 9) => `<svg width="${sz}" height="${sz}" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.2l2 2 4-4.4" stroke="${c}" stroke-width="2" fill="none"></path></svg>`;
const L = (k) => String(k).toUpperCase();

function mkCardLine(it) {
  const m = it.mockups;
  if (!m) return '';
  if (m.job) return `<span class="working" style="font-size: 11.5px; color: var(--work)" data-mk-since="${escRaw(m.job.startedAt)}" data-mk-text="${jobWho(m.job)} is drawing round ${m.job.round}, ">${jobWho(m.job)} is drawing round ${m.job.round}, ${secs(m.job.startedAt)}</span>`;
  if (m.error) return `<span style="font-size: 11.5px; color: var(--bad)">Round ${m.error.round} did not come back</span>`;
  const last = m.rounds[m.rounds.length - 1];
  if (!last) return '';
  const minis = last.variants.map((v) => `<img class="mk-mini${it.img === v.img ? ' on' : ''}" src="${escRaw(v.img)}" alt="" draggable="false">`).join('');
  return `<span class="mk-crow">${minis}<span class="t3">${last.picked ? `Round ${last.n}, ${L(last.picked)} picked` : `Round ${last.n} ready`}</span></span>`;
}

function mkState(id) {
  return (ui.mk[id] = ui.mk[id] || { round: null, view: null, draft: '', dismissed: null });
}

function renderMockups(it) {
  const m = it.mockups || { rounds: [], job: null, error: null };
  const st = mkState(it.id);
  const tail = $('#mk-tail');
  const errKey = m.error ? `${m.error.round}:${m.error.text}` : null;
  const busy = !!it.pending;
  if (m.job) {
    setHtml('mk-head', `<span class="t2 num mk-rl">Round ${m.job.round}</span>`);
    setHtml('mk-body', `<div class="mk-pad mk-col"><div class="mk-strip">${[0, 1, 2].map(() => '<div class="mk-tile working"></div>').join('')}</div>
<div class="mk-workrow"><span class="working" style="flex: 1; font-size: 12.5px; color: var(--work); line-height: 1.4" data-mk-since="${escRaw(m.job.startedAt)}" data-mk-text="${jobWho(m.job)} is drawing 3 variants, " data-mk-after=". It stops at 3 minutes.">${jobWho(m.job)} is drawing 3 variants, ${secs(m.job.startedAt)}. It stops at 3 minutes.</span><button class="btn sm" data-mk="stop">${STOP_ICON}<span style="margin-left: 6px">Stop</span></button></div>
${m.job.note ? `<span class="t3" style="font-size: 12px; line-height: 1.4">Your note: "${esc(m.job.note)}"</span>` : ''}</div>`);
    tail.hidden = true;
    return;
  }
  if (m.error && st.dismissed !== errKey) {
    setHtml('mk-head', `<span class="t2 num mk-rl">Round ${m.error.round}</span>`);
    setHtml('mk-body', `<div class="mk-pad mk-col"><div class="err-line">${esc(m.error.text)}</div>
<div style="display: flex; gap: 8px; flex-wrap: wrap"><button class="btn sm pri" data-mk="retry"${busy ? ' disabled' : ''}>Try again</button>${m.rounds.length ? `<button class="btn sm" data-mk="back">Back to round ${m.rounds[m.rounds.length - 1].n}</button>` : ''}</div></div>`);
    tail.hidden = true;
    return;
  }
  if (!m.rounds.length) {
    setHtml('mk-head', '');
    setHtml('mk-body', `<div class="mk-pad mk-col" style="align-items: flex-start"><span class="t2" style="font-size: 12.5px; line-height: 1.45">${printWho()} draws 3 quick pictures of this idea, side by side, in about a minute and a half. Pick one for the card.</span><button class="btn pri" data-mk="start"${busy ? ' disabled' : ''}>Mock it up</button></div>`);
    tail.hidden = true;
    return;
  }
  const r = m.rounds.find((x) => x.n === st.round) || m.rounds[m.rounds.length - 1];
  const coverIdx = r.variants.findIndex((v) => v.img === it.img);
  const pickedIdx = r.variants.findIndex((v) => v.key === r.picked);
  let view = st.view != null && st.view < r.variants.length && st.viewRound === r.n ? st.view : coverIdx >= 0 ? coverIdx : pickedIdx >= 0 ? pickedIdx : 0;
  const v = r.variants[view];
  const isCover = it.img === v.img;
  setHtml('mk-head', m.rounds.length > 1
    ? `<span class="mk-rounds" role="group" aria-label="Rounds">${m.rounds.map((x) => `<button class="seg ${x.n === r.n ? 'on' : ''}" data-mk-round="${x.n}" aria-pressed="${x.n === r.n}">Round ${x.n}</button>`).join('')}</span>`
    : `<span class="t2 num mk-rl">Round ${r.n}</span>`);
  setHtml('mk-body', `<div class="mk-stage"><img class="mk-big" src="${escRaw(v.img)}" alt="${esc(`${L(v.key)}. ${v.title}`)}">${isCover ? `<span class="mk-badge">${CHECK_SVG('#FFFFFF')}<span>Cover</span></span>` : ''}</div>
<div class="mk-pad mk-col mk-gap12">
<div style="display: flex; gap: 10px; align-items: flex-start"><div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px"><span style="font-weight: 600; font-size: 13.5px">${L(v.key)}. ${esc(v.title)}</span><span class="t2" style="font-size: 12.5px; line-height: 1.4">${esc(v.note)}</span></div>${isCover ? '<button class="btn sm" disabled>Picked</button>' : `<button class="btn sm pri" data-mk="pick" data-key="${escRaw(v.key)}">Pick</button>`}</div>
<div class="mk-strip">${r.variants.map((x, i) => `<button class="mk-th ${i === view ? 'on' : ''}" data-mk-view="${i}" aria-label="Variant ${L(x.key)}: ${esc(x.title)}" aria-pressed="${i === view}"><img class="mk-tile" src="${escRaw(x.img)}" alt=""><span class="mk-thl"><b>${L(x.key)}</b>${x.img === it.img ? `<span class="mk-pk">${CHECK_SVG('var(--ok)')}</span>` : ''}<span class="ell">${esc(x.title)}</span></span></button>`).join('')}</div>
</div>`);
  tail.hidden = false;
  const again = $('#mk-again');
  if (again) again.disabled = busy;
  const model = r.model && !/sonnet/i.test(r.model) ? r.model : 'Sonnet';
  setHtml('mk-foot', `Round ${r.n}: ${r.ms ? `${took(r.ms)}, ` : ''}${esc(model)}. Files in ${esc(m.folder || '')}/${m.dropped ? ` <button class="linkish" data-mk="dropped">Put the dropped picture back on the card</button>` : ''}`);
}

function took(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

async function mockupAct(id, e) {
  const it = ideaById(id);
  if (!it) return;
  const st = mkState(id);
  const m = it.mockups || { rounds: [] };
  const roundBtn = e.target.closest('[data-mk-round]');
  if (roundBtn) { st.round = Number(roundBtn.dataset.mkRound); st.view = null; renderIdeaPanel(); return; }
  const th = e.target.closest('[data-mk-view]');
  if (th) {
    const r = m.rounds.find((x) => x.n === st.round) || m.rounds[m.rounds.length - 1];
    st.view = Number(th.dataset.mkView); st.viewRound = r && r.n;
    renderIdeaPanel();
    return;
  }
  const b = e.target.closest('[data-mk]');
  if (!b || b.disabled) return;
  const act = b.dataset.mk;
  const base = `/api/ideas/${encodeURIComponent(id)}/mockups`;
  const shown = () => m.rounds.find((x) => x.n === st.round) || m.rounds[m.rounds.length - 1];
  try {
    if (act === 'start') { await post(base, {}); st.round = null; st.view = null; }
    if (act === 'stop') await post(base + '/stop', {});
    if (act === 'retry') { await post(base, { note: m.error.note || '', from: m.error.from || undefined }); st.round = null; st.view = null; }
    if (act === 'back') { st.dismissed = `${m.error.round}:${m.error.text}`; renderIdeaPanel(); }
    if (act === 'pick') await post(base + '/pick', { round: shown().n, key: b.dataset.key });
    if (act === 'dropped') await post(base + '/pick', { dropped: true });
    if (act === 'again') {
      const r = shown();
      const viewed = r.variants[st.view != null && st.viewRound === r.n ? st.view : Math.max(0, r.variants.findIndex((v) => v.img === it.img))];
      const picked = r.variants.find((v) => v.key === r.picked);
      const from = picked || viewed;
      const note = $('#mk-note').value.trim();
      await post(base, { note, from: from ? { round: r.n, key: from.key } : undefined });
      $('#mk-note').value = '';
      st.draft = ''; st.round = null; st.view = null;
    }
  } catch (err) {
    toast(err.message);
  }
}

async function sayIdea(id, chip) {
  const msg = $('#idea-msg');
  const text = chip || (msg ? msg.value.trim() : '');
  const refs = chip ? [] : (ui.ideaRefs[id] || []);
  if (!text && !refs.length) { toast('Type a message first'); return; }
  try {
    await post(`/api/ideas/${encodeURIComponent(id)}/say`, { text, images: refs.map((r) => r.file) });
    if (!chip) { msg.value = ''; ui.ideaDrafts[id] = ''; ui.ideaRefs[id] = []; }
  } catch (e) {
    toast(e.message);
  }
}

// A ticking clock for the working states.
setInterval(() => {
  if (ui.view !== 'ideas' || !ui.ideas) return;
  const it = ideaById(ui.selIdea);
  const el = $('#i-pending');
  if (el && it && it.pending) el.textContent = `${jobWho(it.pending)} is thinking, ${secs(it.pending.startedAt)}. It stops at 3 minutes.`;
  // Mockup rounds being drawn: the card line and the Mockups card count up.
  document.querySelectorAll('[data-mk-since]').forEach((x) => { x.textContent = `${x.dataset.mkText}${secs(x.dataset.mkSince)}${x.dataset.mkAfter || ''}`; });
  if (ui.ideas.brainstorm) { delete ui.html['i-brain']; renderIdeas(); }
}, 1000);

// ------------------------------------------------------------ New project / Write the brief

const KINDS = ['Web game', 'VR', 'Unity', 'Unreal', 'App', 'Website', 'Tool or CLI', 'Research', 'Something else'];

async function loadMeta() {
  if (ui.meta) return ui.meta;
  try { ui.meta = await (await fetch('/api/meta')).json(); } catch { ui.meta = { kinds: KINDS, globalRules: [], projectsRoot: '~/Projects' }; }
  return ui.meta;
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

// `from`: New project from this folder (docs/design/CodexStage2.dc.html,
// section 1): { id, name, folder, folderShort, workspaceId, assistant } of a
// session that is not in a project. The folder row starts on Existing with
// that folder, and the assistant is the session's.
async function openModal({ mode, projectId, ideaId, prefill = {}, from = null }) {
  const meta = await loadMeta();
  const p = projectId ? project(projectId) : null;
  const asDefault = asView().startWith === 'codex' ? 'codex' : 'claude';
  ui.modal = { mode, projectId, ideaId, kind: prefill.kind || (mode === 'new' ? 'Web game' : null), stage: prefill.stage || null, folderMode: from ? 'existing' : 'new', pick: null, finder: [], showAll: false, known: null, choosing: false, parent: null, parentWaiting: false, from, asDefault, assistant: from && from.assistant ? asKind(from.assistant) : asDefault };
  const title = mode === 'brief' ? `Brief for ${p ? p.name : ''}` : 'New project';
  const briefWhere = p ? (p.briefExpected || (p.shared.length ? `${p.folderShort}/BRIEF-${p.id}.md` : `${p.folderShort}/BRIEF.md`)) : '';
  $('#modal').innerHTML = `<div class="modal-back" id="modal-back">
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
<div style="display: flex; align-items: center; padding: 16px 20px 8px"><h2 id="modal-title" style="margin: 0; font-size: 20px; font-weight: 700; flex: 1">${esc(title)}</h2><button class="x-btn" id="modal-close" aria-label="Close">${X_ICON}</button></div>
<form id="modal-form" style="padding: 8px 20px 20px; display: flex; flex-direction: column; gap: 14px">
${mode === 'new' ? `<label class="inp">Name<input name="name" placeholder="e.g. Garden planner" autocomplete="off" required></label>
<div class="inp" id="m-folder-row">Folder<div class="fseg" role="group" aria-label="Folder"><button type="button" class="seg on" data-fmode="new" aria-pressed="true">New folder</button><button type="button" class="seg" data-fmode="existing" aria-pressed="false">Existing</button></div><div id="m-folder" class="fbody"></div></div>
<div class="inp" id="m-asst-row">Assistant<div class="fseg as-f" role="group" aria-label="Assistant">${['claude', 'codex'].map((k) => `<button type="button" class="seg ${ui.modal.assistant === k ? 'on' : ''}" data-asst="${k}" aria-pressed="${ui.modal.assistant === k}">${k === 'codex' ? 'Codex' : 'Claude'}</button>`).join('')}</div><span class="t3 as-hint">${ui.modal.from ? "The session's, from this folder." : 'From Settings (Start new sessions with).'} This project's sessions, Revive and hand-offs use it.</span></div>` : ''}
<div class="inp">Kind
<div style="display: flex; flex-wrap: wrap; gap: 6px" id="kinds" role="group" aria-label="Kind">${(meta.kinds || KINDS).map((k) => `<button type="button" class="btn sm ${ui.modal.kind === k ? 'on' : ''}" data-kind="${escRaw(k)}" aria-pressed="${ui.modal.kind === k}">${esc(k)}</button>`).join('')}</div>
<input name="kindText" aria-label="Describe the kind in your own words" placeholder="Or in your own words, e.g. a Mac menu-bar app, a music practice tool">
</div>
<label class="inp">Goal<textarea name="goal" placeholder="One or two sentences. What are we making and why?" required></textarea></label>
<label class="inp">Done means<textarea name="doneMeans" placeholder="How we'll both know it's finished"></textarea></label>
<label class="inp">First milestones<textarea name="milestones" placeholder="One per line. The agent breaks each into tasks and ticks them as it commits."></textarea></label>
<div class="inp">Rules
${meta.globalRules && meta.globalRules.length ? `<div style="display: flex; flex-wrap: wrap; gap: 5px" title="From ${esc(meta.globalPath || '~/.claude/CLAUDE.md')}. Every session follows these already.">${meta.globalRules.map((r) => `<span style="font-size: 12px; padding: 3px 8px; border-radius: 6px; background: var(--card); color: var(--tx)">${esc(r)}</span>`).join('')}</div>` : ''}
<textarea name="rules" style="min-height: 40px" placeholder="Add project rules, one per line, e.g. Unity batteries run batchmode only"></textarea>
</div>
<div id="m-err" class="err-line" hidden></div>
<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 6px"><span class="t2" id="m-foot" style="flex: 1; font-size: 12.5px; min-width: 200px">${mode === 'new' ? `Writes BRIEF.md, then opens ${newPlace()} with ${modalWho()} reading it` : `Writes ${esc(briefWhere)}. Nothing is started.`}</span><button class="btn pri" type="submit" id="m-go">${mode === 'new' ? `Start in ${esc(boardTerm())}` : 'Write the brief'}</button></div>
</form></div></div>`;
  const f = $('#modal-form');
  for (const [k, v] of Object.entries(prefill)) if (f.elements[k] && v != null) f.elements[k].value = v;
  if (mode === 'new') {
    f.elements.name.addEventListener('input', () => renderFolder());
    $('#m-folder-row').addEventListener('click', onFolderClick);
    $('#m-asst-row').addEventListener('click', (e) => {
      const b = e.target.closest('[data-asst]');
      if (!b) return;
      ui.modal.assistant = b.dataset.asst;
      $('#m-asst-row').querySelectorAll('[data-asst]').forEach((x) => { const on = x.dataset.asst === ui.modal.assistant; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      renderFolder();
    });
    renderFolder();
    loadFolders();
  }
  $('#kinds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    ui.modal.kind = ui.modal.kind === b.dataset.kind ? null : b.dataset.kind;
    $('#kinds').querySelectorAll('[data-kind]').forEach((x) => { const on = x.dataset.kind === ui.modal.kind; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
  });
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-back').addEventListener('mousedown', (e) => { if (e.target.id === 'modal-back') closeModal(); });
  f.addEventListener('submit', (e) => { e.preventDefault(); submitModal(); });
  f.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  setTimeout(() => { const first = f.elements.name || f.elements.goal; first.focus(); }, 0);
}

// ---- The Folder row (docs/design/NewProjectFolder.dc.html, variant A):
// New folder | Existing. New folder is the path the name makes; Existing is
// the folders the board knows, most recently active first, plus any folder
// Finder's own dialog returned (the Mac only).

async function loadFolders() {
  try {
    const r = await fetch('/api/project/folders');
    if (!r.ok) throw new Error();
    if (ui.modal) { ui.modal.known = await r.json(); renderFolder(); }
  } catch { if (ui.modal) { ui.modal.known = { folders: [], ids: [], taken: [], failed: true }; renderFolder(); } }
}

const folderPhone = () => matchMedia('(max-width: 700px)').matches;
const canChoose = () => ui.local === true && !matchMedia('(pointer: coarse)').matches;

function folderList() {
  const m = ui.modal;
  const finder = m.finder;
  const known = ((m.known && m.known.folders) || []).filter((e) => !finder.some((x) => x.folder === e.folder));
  return [...finder, ...known];
}

function folderPicked() {
  const m = ui.modal;
  return m && m.pick ? folderList().find((e) => e.folder === m.pick) || null : null;
}

// The id the server will give this name (registry.uniqueId), for the brief
// file name it will write in a shared folder.
function idFor(name) {
  const ids = new Set((ui.modal.known && ui.modal.known.ids) || []);
  const base = slugify(name);
  let id = base;
  for (let k = 2; ids.has(id); k++) id = base + '-' + k;
  return id;
}

// The assistant the New project form starts, by its short name.
const modalWho = () => (ui.modal && ui.modal.assistant === 'codex' ? 'Codex' : 'Claude');

function renderFolder() {
  const m = ui.modal;
  const f = $('#modal-form');
  const box = $('#m-folder');
  if (!m || !box || !f) return;
  const name = f.elements.name.value.trim();
  const slug = name ? slugify(name) : '';
  const root = (m.known && m.known.projectsRoot) || (ui.meta && ui.meta.projectsRoot) || '~/Projects';
  $('#m-folder-row').querySelectorAll('[data-fmode]').forEach((b) => { const on = b.dataset.fmode === m.folderMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const foot = $('#m-foot');
  if (m.folderMode === 'new') {
    // "Change for this one" (the Mac only): another parent for this
    // project's new folder; the default in Settings stays as it is.
    const parent = m.parent ? m.parent.short : root;
    const takenList = m.parent ? m.parent.taken : (m.known && m.known.taken) || [];
    const taken = slug && takenList.find((t) => t.name === slug);
    const link = canChoose() || m.parent ? `<button type="button" class="linkish fpath-link" data-act="${m.parent ? 'parent-default' : 'parent-choose'}"${m.parentWaiting ? ' disabled' : ''}>${m.parentWaiting ? 'Waiting for Finder...' : m.parent ? 'Back to default' : 'Change for this one'}</button>` : '';
    const hint = m.parent ? `Made in the folder you picked, for this project only. New projects still go in ${esc(root)}.` : 'A new folder, named after the project as you type. Made when you start.';
    box.innerHTML = `<div class="fpath">${FOLDER_ICON}<span><span class="t3">${wbr(parent)}/<wbr></span>${esc(slug || '...')}</span>${link}</div>
${taken ? `<div class="fhint fhint-taken">${esc(slug)} already exists and has files in it. <button type="button" class="linkish" data-act="use-taken">Pick it under Existing</button> to start there.</div>` : `<div class="fhint">${hint}</div>`}`;
    foot.textContent = `Makes ${slug || 'the folder'}, writes BRIEF.md, then opens ${newPlace()} with ${modalWho()} reading it`;
    return;
  }
  const go = $('#m-go');
  if (m.from && go) { const w = m.folderMode === 'existing' ? 'Create project' : `Start in ${boardTerm()}`; if (go.textContent !== w && !go.disabled) go.textContent = w; }
  if (m.from) {
    // From a folder: that folder, whole, and what joining means.
    const fs0 = m.from.folderShort || m.from.folder;
    const cut = fs0.lastIndexOf('/');
    box.innerHTML = `<div class="fpath">${FOLDER_ICON}<span><span class="t3">${wbr(fs0.slice(0, cut + 1))}<wbr></span>${esc(fs0.slice(cut + 1))}</span></div><div class="fhint">The folder of the ${esc(m.from.name)} workspace. The workspace and its session join the project; nothing is moved.</div>`;
    foot.textContent = `Writes the brief in ${m.from.name}. Nothing new is opened: the session already there joins the project`;
    return;
  }
  const all = folderList();
  if (!m.pick && all.length) m.pick = all[0].folder;
  const max = folderPhone() ? 5 : 6;
  const finder = all.filter((e) => e.fromFinder);
  const rest = all.filter((e) => !e.fromFinder);
  let shown = m.showAll ? rest : rest.slice(0, max);
  const pickedHidden = !shown.some((e) => e.folder === m.pick) && rest.find((e) => e.folder === m.pick);
  if (pickedHidden) shown = [...shown, pickedHidden];
  const more = rest.length - shown.length;
  const row = (e) => {
    const on = e.folder === m.pick;
    return `<button type="button" class="frow${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-folder="${escRaw(e.folder)}" title="${escRaw(e.short)}"><span class="radio">${on ? '<i></i>' : ''}</span><span class="fcol"><span class="fname">${esc(e.name)}</span>${on ? `<span class="fsub">in ${wbr(e.parent)}</span>` : ''}</span><span class="fwho${e.fromFinder ? ' t3' : ''}">${esc(e.fromFinder ? 'From Finder' : joinNames(e.projects))}</span></button>`;
  };
  const rows = [...finder, ...shown].map(row).join('');
  const list = !m.known ? '<div class="flist"><div class="fmore t3">Loading the folders the board knows...</div></div>'
    : all.length ? `<div class="flist" role="radiogroup" aria-label="Folders the board knows">${rows}${more > 0 ? `<div class="fmore"><button type="button" class="linkish" data-act="folders-more">${more} more folder${more === 1 ? '' : 's'}</button></div>` : ''}</div>`
    : `<div class="flist"><div class="fmore t3">${m.known.failed ? 'The board could not list its folders.' : 'No project on the board has a folder yet.'}${canChoose() ? ' Choose one in Finder below.' : ''}</div></div>`;
  const choose = canChoose() ? `<div class="fchoose"><button type="button" class="btn sm" data-act="choose-folder"${m.choosing ? ' disabled' : ''}>${m.choosing ? 'Waiting for Finder...' : finder.length ? 'Choose another…' : 'Choose…'}</button><span class="t3">Any folder on this Mac, in Finder's own dialog</span></div>` : '';
  const pick = folderPicked();
  const note = !pick ? '' : pick.projects.length ? `${joinNames(pick.projects)} ${pick.projects.length > 1 ? 'use' : 'uses'} this folder too. This project gets its own brief and hand-off file.` : 'No project on the board uses this folder yet.';
  box.innerHTML = `${list}${choose}${note ? `<div class="fnote">${esc(note)}</div>` : ''}`;
  if (pick) {
    const brief = pick.projects.length || pick.hasBrief ? `BRIEF-${idFor(name || 'project')}.md` : 'BRIEF.md';
    foot.textContent = `Writes ${brief} in ${pick.name}, then opens ${newPlace()} with ${modalWho()} reading it`;
  } else foot.textContent = `Pick a folder, then Start opens ${newPlace()} with ${modalWho()} reading the brief`;
}

async function onFolderClick(e) {
  const m = ui.modal;
  if (!m) return;
  const mode = e.target.closest('[data-fmode]');
  if (mode) { m.folderMode = mode.dataset.fmode; renderFolder(); return; }
  const rowEl = e.target.closest('[data-folder]');
  if (rowEl) { m.pick = rowEl.dataset.folder; renderFolder(); return; }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'folders-more') { m.showAll = true; renderFolder(); return; }
  if (act.dataset.act === 'parent-default') { m.parent = null; renderFolder(); return; }
  if (act.dataset.act === 'parent-choose') {
    m.parentWaiting = true;
    renderFolder();
    try {
      const r = await post('/api/project/choose-folder', { purpose: 'parent' });
      if (ui.modal !== m) return;
      if (!r.cancelled && r.entry) m.parent = { folder: r.entry.folder, short: r.entry.short, taken: r.taken || [] };
    } catch (err) {
      const el = $('#m-err');
      if (el) { el.textContent = err.message; el.hidden = false; }
    } finally {
      m.parentWaiting = false;
      if (ui.modal === m) renderFolder();
    }
    return;
  }
  if (act.dataset.act === 'use-taken') {
    const slug = slugify($('#modal-form').elements.name.value);
    const root = m.parent ? m.parent.short : (m.known && m.known.projectsRoot) || '~/Projects';
    const t = (m.parent ? m.parent.taken : (m.known && m.known.taken) || []).find((x) => x.name === slug);
    const known = folderList().find((x) => x.short === `${root}/${slug}`);
    if (known) m.pick = known.folder;
    else {
      const entry = { folder: `${root}/${slug}`, short: `${root}/${slug}`, name: slug, parent: root, projects: [], hasBrief: !!(t && t.hasBrief) };
      m.known.folders = [entry, ...m.known.folders];
      m.pick = entry.folder;
    }
    m.folderMode = 'existing';
    renderFolder();
    return;
  }
  if (act.dataset.act === 'choose-folder') {
    m.choosing = true;
    renderFolder();
    try {
      const r = await post('/api/project/choose-folder', {});
      if (ui.modal !== m) return;
      if (!r.cancelled && r.entry) {
        m.finder = [r.entry, ...m.finder.filter((x) => x.folder !== r.entry.folder)];
        m.pick = r.entry.folder;
      }
    } catch (err) {
      const el = $('#m-err');
      if (el) { el.textContent = err.message; el.hidden = false; }
    } finally {
      m.choosing = false;
      if (ui.modal === m) renderFolder();
    }
  }
}

function closeModal() {
  ui.modal = null;
  $('#modal').innerHTML = '';
}

async function submitModal() {
  const m = ui.modal;
  if (!m) return;
  const f = $('#modal-form');
  const v = Object.fromEntries(['name', 'kindText', 'goal', 'doneMeans', 'milestones', 'rules'].map((k) => [k, f.elements[k] ? f.elements[k].value : '']));
  const err = $('#m-err');
  const show = (msg) => { err.textContent = msg; err.hidden = !msg; };
  if (m.mode === 'new' && !v.name.trim()) { show('Give it a name first.'); f.elements.name.focus(); return; }
  if (!v.goal.trim()) { show('Write the goal: one or two sentences.'); f.elements.goal.focus(); return; }
  show('');
  const go = $('#m-go');
  const label = go.textContent;
  go.disabled = true;
  go.textContent = m.mode === 'new' ? 'Starting...' : 'Writing...';
  try {
    if (m.mode === 'new') {
      const fromHere = !!(m.from && m.folderMode === 'existing');
      const pick = fromHere ? { folder: m.from.folder } : m.folderMode === 'existing' ? folderPicked() : null;
      if (m.folderMode === 'existing' && !pick) { show('Pick a folder first.'); return; }
      // From a folder the session's assistant is always sent (it starts on
      // the session's); otherwise only when changed for this project.
      const r = await post('/api/project/new', { ...v, kind: m.kind, stage: m.stage, existingFolder: pick ? pick.folder : undefined, parentFolder: !pick && m.parent ? m.parent.folder : undefined, ideaId: m.ideaId, ...(fromHere ? { workspaceId: m.from.workspaceId } : {}), assistant: m.from || m.assistant !== m.asDefault ? m.assistant : undefined });
      closeModal();
      toast(r.partial ? r.error : r.message || `${v.name.trim()} is in ${r.folder}. ${r.assistant === 'codex' ? 'Codex' : 'Claude'} is reading the brief in cmux ${r.workspaceRef}.`);
      ui.sel = r.id;
      store.set('sel', r.id);
      setView('projects');
      history.replaceState(null, '', '#' + encodeURIComponent(r.id));
    } else {
      const r = await post('/api/project/brief', { ...v, projectId: m.projectId, kind: m.kind });
      closeModal();
      toast(`Brief written to ${r.brief}`);
    }
  } catch (e) {
    show(e.message);
  } finally {
    if (go.isConnected) { go.disabled = false; go.textContent = label; }
  }
}

async function revive(pid) {
  const p = project(pid);
  if (!p) return;
  const { s } = view(p);
  const before = p.sessions.map((x) => x.surfaceId);
  try {
    const r = await post('/api/project/revive', { projectId: pid });
    if (s) ui.selSession[pid] = s.surfaceId;
    followStart(pid, r, before);
    render();
    toast(r.message ? r.message : r.where === 'tab' ? `New tab ${r.surfaceRef || ''} in ${r.workspaceRef}. It reads the brief first.` : `New workspace ${r.workspaceRef} for ${p.name}. It reads the brief first.`);
  } catch (e) {
    toast(e.message);
  }
}

// ------------------------------------------------------------ Plans
// docs/design/Plans.dc.html: the Plan card on the project page and the gate
// card (variant A), the full plan, the planning conversation (section 1,
// variant A), and the one-line PLAN row in Objectives (A+). The pure parts
// are in public/plan-view.js.

const PG = {
  done: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" style="fill: var(--ok)"/><path d="M5.3 9.3l2.4 2.4 5-5.2" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  branch: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" style="fill: var(--ok)"/><path d="M9 14V10M9 10L5.6 5.2M9 10l3.4-4.8" stroke="#FFFFFF" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  branchTodo: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7.3" fill="none" style="stroke: var(--idle)" stroke-width="1.5"/><path d="M9 13.5V10M9 10L6 5.8M9 10l3-4.2" style="stroke: var(--idle)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  now: '<svg class="working" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="none" style="stroke: var(--work)" stroke-width="1.8"/><circle cx="9" cy="9" r="4.2" style="fill: var(--work)"/></svg>',
  you: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7.2" style="fill: var(--sheet); stroke: var(--you)" stroke-width="2"/></svg>',
  gateYou: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 1.6L16.4 9 9 16.4 1.6 9z" style="fill: var(--sheet); stroke: var(--you)" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 5.6L12.4 9 9 12.4 5.6 9z" style="fill: var(--you)"/></svg>',
  gateTodo: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.2L15.8 9 9 15.8 2.2 9z" style="fill: var(--card); stroke: var(--idle)" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  gateDone: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 1.2L16.8 9 9 16.8 1.2 9z" style="fill: var(--ok)"/><path d="M5.8 9.2l2.1 2.1 4.3-4.5" stroke="#FFFFFF" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  todo: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7.3" style="fill: var(--card); stroke: var(--idle)" stroke-width="1.5"/></svg>',
  skip: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" style="stroke: var(--idle)" stroke-width="1.4" stroke-dasharray="2 2"/></svg>',
  armSkip: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" style="stroke: var(--idle)" stroke-width="1.4" stroke-dasharray="2 2"/></svg>',
  taken: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" style="fill: var(--ok)"/><path d="M4.2 7.2l1.9 1.9 3.8-4" stroke="#FFFFFF" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  armTodo: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" style="stroke: var(--idle)" stroke-width="1.4"/></svg>',
  relay: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 5.5A5.5 5.5 0 0 0 3.2 4.3M3 2v2.6h2.6M3 10.5a5.5 5.5 0 0 0 9.8 1.2M13 14v-2.6h-2.6"/></svg>',
  lock: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="5.2" width="8" height="5.6" rx="1.2"/><path d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4"/></svg>',
  mic: '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="4.6" y="1.2" width="4.8" height="7.6" rx="2.4"/><path d="M2.6 6.8a4.4 4.4 0 0 0 8.8 0M7 11.2v1.8"/></svg>',
  test: '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" style="fill: var(--ok)"/><path d="M4.2 7.2l1.9 1.9 3.8-4" stroke="#FFFFFF" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  doc: '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3.5 1.5h4.5l2.5 2.5v8.5h-7z"/><path d="M5.5 7h3M5.5 9.5h3"/></svg>',
  answer: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/></svg>',
  drag: '<svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11" r="1.2"/><circle cx="7" cy="11" r="1.2"/></g></svg>',
  cmt: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/></svg>',
  rule: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 1.5h7v9l-3.5-2-3.5 2z"/></svg>',
  check: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.3l2.3 2.3 4.7-5"/></svg>',
};
const PL_ALWAYS = ["Anything the plan didn't foresee is a gate: it stops and asks you.", 'Each step shows its proof before the next one starts.'];
const plClock = (iso) => { const d = parseT(iso); return d ? (within24(d) ? clock(d, true) : `${day(d)}, ${clock(d, true)}`) : ''; };
const plMins = (iso) => { const d = parseT(iso); if (!d) return ''; const m = Math.max(0, Math.round((serverNow() - d.getTime()) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

// A proof as a line: a screenshot thumbnail, a test line, or text (a path
// at its end in mono).
function proofHtml(x, { big = false, compact = false } = {}) {
  if (x.type === 'shot') {
    const w = big ? 120 : compact ? 72 : 88;
    return `<span class="pl-e pl-shot"><img class="pl-thumb" src="${escRaw(x.url)}" alt="${esc('Screenshot: ' + x.path)}" width="${w}" height="${Math.round(w * 9 / 16)}" loading="lazy" onerror="this.style.visibility='hidden'"><span>${esc(shotLabel(x))}<br><span class="t3">${big ? esc(x.path) + (x.at ? ', ' : '') : ''}${esc(plClock(x.at))}</span></span></span>`;
  }
  if (x.type === 'test') return `<span class="pl-e">${PG.test}<span class="pl-mono">${esc(x.text)}</span></span>`;
  const m = x.text.match(/^(.*?)\s*((?:[\w.-]+\/)+[\w.-]+\.\w+|\b[0-9a-f]{7,40}\b)\s*\.?$/);
  const code = (h) => h.replace(/`([^`]+)`/g, '<span class="pl-mono">$1</span>');
  return `<span class="pl-e">${PG.doc}<span>${m && m[1] ? `${code(esc(m[1]))} <span class="pl-file">${esc(m[2])}</span>` : code(esc(x.text))}</span></span>`;
}

// What a screenshot proof says besides its path ("Screenshot of the trail"),
// or just "Screenshot" when it only says it was looked at.
function shotLabel(x) {
  const rest = x.text.replace(x.path, '').replace(/\(?\s*(?:looked at|seen|checked|viewed)\s*\)?/gi, '').replace(/^[\s,;:.]+|[\s,;:.]+$/g, '');
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : 'Screenshot';
}

function armsHtml(s) {
  if (!s.arms.length) return '';
  const decided = s.arms.some((a) => a.state === 'done');
  return `<div class="pl-opts">${s.arms.map((a) => {
    const on = a.state === 'done';
    const cls = !decided ? '' : on ? 'on' : 'off';
    const note = on ? `Taken${a.note ? ', ' + a.note : ''}` : decided ? 'Not taken' : '';
    return `<div class="pl-opt ${cls}">${on ? PG.taken : decided ? PG.armSkip : PG.armTodo}<span class="pl-ot"><b>If ${esc(a.cond)}</b>: ${esc(a.then)}</span>${note ? `<span class="pl-on">${esc(note)}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

function stepWhen(s) {
  if (s.state === 'you') return { cls: 'you', text: 'Waiting on you' };
  if (s.state === 'now') return { cls: 'now', text: plMins(s.since) };
  return { cls: '', text: s.at ? plClock(s.at) : '' };
}

function planFlow(plan, { compact = false } = {}) {
  let prevAt = plan.startedAt;
  const items = flowItems(plan);
  return `<ol class="pl-flow ${compact ? 'compact' : ''}">${items.map((it) => {
    if (it.type === 'handoff') return `<li class="pl-ho">${PG.relay}<span>Picked up after a hand-off at step ${it.step}${it.at ? ', ' + esc(plClock(it.at)) : ''}</span></li>`;
    const s = { ...it.step, since: prevAt };
    if (s.at) prevAt = s.at;
    const w = stepWhen(s);
    const sub = [];
    if (s.arms.length) sub.push(armsHtml(s));
    const proofs = s.proofs.filter((x) => x.type !== 'shot');
    const shots = s.proofs.filter((x) => x.type === 'shot');
    if (proofs.length || shots.length) sub.push(`<div class="pl-ev">${proofs.map((x) => proofHtml(x)).join('')}${shots.slice(-1).map((x) => proofHtml(x, { compact })).join('')}</div>`);
    if (s.answer) sub.push(`<div class="pl-ev"><span class="pl-e">${PG.answer}<span>You answered: <b>${esc(s.answer.text.replace(/^"|"$/g, ''))}</b></span></span></div>`);
    return `<li class="pl-step ${s.state} k-${s.kind} ${it.first ? 'first' : ''} ${it.last ? 'last' : ''} ${it.ld ? 'ld' : ''}">
<span class="pl-g">${PG[glyphKey(s)]}</span>
<span class="pl-tag ${s.kind === 'gate' ? 'gate' : ''}">${KIND[s.kind]}</span>
<span class="pl-t">${esc(s.text)}<span class="sr-only">, ${esc({ done: 'done', now: 'working on it', you: 'waiting on you', skip: 'not taken', next: 'next', todo: 'to do' }[s.state] || '')}</span></span>
<span class="pl-w ${w.cls}">${esc(w.text)}</span>
${sub.length ? `<div class="pl-sub">${sub.join('')}</div>` : ''}</li>`;
  }).join('')}</ol>`;
}

function planFootHtml(p, plan) {
  const where = p.brief ? p.brief.path.split('/').pop() : 'the brief';
  const st = plan.state === 'paused' ? 'Paused. ' : '';
  return `<div class="pl-foot"><span>${st}Started ${esc(plClock(plan.startedAt))} from your words. In ${esc(where)} under Plan.</span><span class="pl-rulechip">${PG.lock}Not in the plan: stop and ask</span></div>`;
}

// The Plan card under the answer card (A). No plan: the empty card.
function planCardHtml(p) {
  const plan = p.plan;
  if (!plan) {
    if (!p.brief) return '';
    const d = p.planDraft;
    return `<div class="card pl-card"><div class="card-h pl-ch"><span class="pl-label">Plan</span><span style="flex: 1; min-width: 0" class="t2">${d ? (d.busy ? `${jobWho(d.busy)} is drafting a plan` : 'A plan is being drafted') : 'No plan running'}</span><button class="btn sm pri" data-act="plan-new" data-pid="${escRaw(p.id)}">${d ? 'Open the draft' : 'New plan'}</button></div><div class="card-r t2" style="line-height: 1.45">Say what you want done and hand the work over. ${printWho()} drafts the plan and you go over it together.</div></div>`;
  }
  return `<div class="card pl-card"><div class="card-h pl-ch"><span class="pl-label">Plan</span><button class="linkish pl-title" data-act="plan-open" data-pid="${escRaw(p.id)}">${esc(plan.title)}</button><span class="num t2" style="font-weight: 500; font-size: 12px; white-space: nowrap">Step ${plan.current} of ${plan.total}</span><button class="btn sm pl-openbtn" data-act="plan-open" data-pid="${escRaw(p.id)}">Open the plan</button></div>
${planFlow(plan)}
${planFootHtml(p, plan)}</div>`;
}

// A proof tile's text, a path at its end on its own mono line.
function tileText(t) {
  const m = t.match(/^(.*?)\s*((?:[\w.-]+\/)+[\w.-]+\.\w+)\s*\.?$/);
  const code = (h) => h.replace(/`([^`]+)`/g, '<span class="pl-mono">$1</span>');
  return m && m[1] ? `<span>${code(esc(m[1]))}</span><span class="pl-file">${esc(m[2])}</span>` : `<span>${code(esc(t))}</span>`;
}

// The gate card: the answer card while a plan waits at a gate, or the
// "Not in the plan, so I stopped to ask" card. Returns its top half; the
// composer under it is the project's own.
function gateTopHtml(p) {
  const plan = p.plan;
  const g = p.planGate;
  const tiles = gateTiles(plan);
  const tile = (x) => x.type === 'shot'
    ? `<div class="pl-evt evshot"><img class="pl-thumb" src="${escRaw(x.url)}" alt="${esc('Screenshot: ' + x.path)}" width="112" height="63" onerror="this.style.visibility='hidden'"><span class="t3">Screenshot${x.at ? ', ' + esc(plClock(x.at)) : ''}</span></div>`
    : `<div class="pl-evt ${tiles.length === 1 ? 'wide' : ''}"><span class="pl-evk">Step ${x.step}</span>${x.type === 'test' ? `<span class="pl-okline">${PG.test}${esc(x.text)}</span>` : tileText(x.text)}${x.at ? `<span class="t3">${esc(plClock(x.at))}</span>` : ''}</div>`;
  const sent = ui.sent[p.id];
  const showSent = sent && Date.now() - sent.at < 120000;
  return `<div class="pl-gh"><h2 style="margin: 0; font-size: 12.5px; font-weight: 600; color: var(--you); flex: 1">${g.unforeseen ? 'Not in the plan, so I stopped to ask' : `Plan gate, step ${g.n} of ${plan.total}`}</h2>${g.unforeseen ? `<span class="t3" style="font-size: 12px">Step ${g.n} of ${plan.total}</span>` : ''}</div>
<div style="font-size: 16px; line-height: 1.45; font-weight: 500; overflow-wrap: anywhere">${esc(g.question)}</div>
${!g.unforeseen ? `<div class="pl-rule">${g.rule ? `From your rules: "${esc(g.rule)}"` : `Your words: "${esc(g.text.charAt(0).toLowerCase() + g.text.slice(1))}"`}</div>` : ''}
${tiles.length ? `<div class="pl-evs">${tiles.map(tile).join('')}</div>` : ''}
${showSent ? `<div style="font-size: 13px; color: var(--ok); font-weight: 600">Sent "${esc(sent.label)}". The plan carries on.</div>` : ''}
${g.choices.length ? `<div style="display: flex; flex-wrap: wrap; gap: 8px">${g.choices.map((c, k) => `<button class="btn ${k === 0 ? 'pri' : ''}" data-act="plan-choice" data-k="${k}">${esc(c)}</button>`).join('')}</div>` : ''}`;
}

async function planAnswer(body) {
  const p = project(ui.sel);
  if (!p) return;
  try {
    const before = p.sessions.map((x) => x.surfaceId);
    const r = await post('/api/plan/answer', { projectId: p.id, ...body });
    if (r.via === 'revive') followStart(p.id, r, before);
    ui.sent[p.id] = { label: body.choice || body.text, at: Date.now(), delivered: r.delivered };
    toast(r.via === 'revive' ? `Answer written. A new session in ${p.name} reads the plan and carries on.` : `Sent "${body.choice || body.text}" to ${p.name}. The plan carries on.`);
    return true;
  } catch (e) { toast(e.message, 5000, true); return false; } finally { render(); }
}

async function planAct(pid, act) {
  const p = project(pid);
  if (!p) return;
  if (act === 'stop' && !confirm(`Stop the plan "${p.plan ? p.plan.title : ''}"? Its session finishes the step in hand and starts no other.`)) return;
  try {
    const before = p.sessions.map((x) => x.surfaceId);
    const r = await post('/api/plan/' + act, { projectId: pid });
    if (r.via === 'revive') { followStart(pid, r, before); render(); }
    toast({ pause: 'Paused. The session finishes the step in hand, then waits.', stop: 'Stopped. The plan stays in the brief.', resume: 'Resumed. The session carries on from the step it was at.' }[act] + (r.via === 'brief' ? ' No session was running, so only the brief changed.' : ''), 4500, true);
  } catch (e) { toast(e.message, 5000, true); }
}

// ---- Objectives: the one-line PLAN row (A+)

function rowDot(c) {
  if (c === 'b') return '<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" style="fill: var(--ok)"/><path d="M9 14V10M9 10L5.6 5.2M9 10l3.4-4.8" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if (c === 'bt') return '<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 15V10M9 10L5 4.5M9 10l4-5.5" fill="none" style="stroke: var(--idle)" stroke-width="2" stroke-linecap="round"/></svg>';
  if (c === 'g') return '<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.2L15.8 9 9 15.8 2.2 9z" fill="none" style="stroke: var(--idle)" stroke-width="2"/></svg>';
  if (c === 'G') return '<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.2L15.8 9 9 15.8 2.2 9z" style="fill: var(--you-t); stroke: var(--you)" stroke-width="2"/></svg>';
  if (c === 'Gd') return '<svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 1.2L16.8 9 9 16.8 1.2 9z" style="fill: var(--ok)"/></svg>';
  const st = { x: 'background: var(--ok)', n: 'background: var(--work)', y: 'border: 2px solid var(--you)', s: 'border: 1.5px dashed var(--idle)' }[c] || 'border: 1.5px solid var(--idle)';
  return `<span class="dot" style="${st}; width: 13px; height: 13px"></span>`;
}

function planRow(p) {
  const plan = p.plan;
  const m = rowModel(plan);
  return `<div class="card-r pl-row1 ${m.wash}" style="flex-wrap: wrap; gap: 8px 14px">
<span class="obj-title" style="flex: 0 0 240px; min-width: 0"><span class="pl-label sm">Plan</span><button class="linkish pl-open" data-act="plan-open" data-pid="${escRaw(p.id)}">${esc(plan.title)}</button></span>
<div class="pl-dots" role="img" aria-label="${esc(`${m.count}${m.next.text ? '. ' + m.next.text : ''}`)}">${m.dots.map(rowDot).join('')}</div>
<span class="num" style="flex: 0 0 auto; min-width: 56px; white-space: nowrap; text-align: right; font-weight: 600">${esc(m.count)}</span>
<span class="obj-next pl-next t2" style="flex: 0 0 170px; font-size: 12px; min-width: 0; overflow-wrap: anywhere"><span class="${m.next.cls}">${esc(m.next.text)}</span><button class="linkish pl-link" data-act="plan-open" data-pid="${escRaw(p.id)}">Open the plan</button></span></div>`;
}

// ---- The full plan (A): the flow with both branches laid out, your goal,
// the rules for every plan and the log, with Change, Pause and Stop.

function graphNode(s, body = '', cls = '') {
  const w = stepWhen(s);
  return `<div class="pg-n ${s.state} k-${s.kind} ${cls}"><div class="pg-nh"><span class="pl-g">${PG[glyphKey(s)]}</span><span class="pl-tag ${s.kind === 'gate' ? 'gate' : ''}">${KIND[s.kind]}</span><span class="pl-w ${w.cls}">${esc(w.text)}</span></div><div class="pg-t">${esc(s.text)}</div>${body}</div>`;
}

function forkSvg(n, decided, takenIdx, join) {
  const xs = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * 100);
  const path = (x, on) => {
    const d = join ? `M${x} 0 V10 Q${x} 16 ${x < 50 ? x + 6 : x > 50 ? x - 6 : x} 16 H${x < 50 ? 44 : 56} Q50 16 50 22 V32` : `M50 0 V10 Q50 16 ${x < 50 ? 44 : 56} 16 H${x < 50 ? x + 6 : x - 6} Q${x} 16 ${x} 22 V32`;
    const straight = join ? `M${x} 0 V32` : `M50 0 V32`;
    return `<path d="${Math.abs(x - 50) < 1 ? straight : d}" fill="none" style="stroke: var(${on ? '--ok' : '--idle'})" stroke-width="${on ? 2 : 1.5}" ${on ? '' : 'stroke-dasharray="4 4"'} vector-effect="non-scaling-stroke"/>`;
  };
  return `<svg class="pg-fork" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">${xs.map((x, i) => path(x, decided && i === takenIdx)).join('')}</svg>`;
}

function planGraph(p, plan) {
  const out = [];
  let prevAt = plan.startedAt;
  plan.steps.forEach((st, i) => {
    const s = { ...st, since: prevAt };
    if (s.at) prevAt = s.at;
    for (const h of plan.handoffs) if (h.step === s.n && i > 0) out.push(`<div class="pg-ho">${PG.relay}<span>Picked up after a hand-off at step ${h.step}${h.at ? ', ' + esc(plClock(h.at)) : ''}. The plan is in the brief, so the fresh session carried on.</span></div>`, '<div class="pg-v ld"></div>');
    const ev = [];
    const proofs = s.proofs.filter((x) => x.type !== 'shot');
    const shots = s.proofs.filter((x) => x.type === 'shot');
    if (proofs.length || shots.length) ev.push(`<div class="pl-ev">${proofs.map((x) => proofHtml(x)).join('')}${shots.slice(-1).map((x) => proofHtml(x, { big: true })).join('')}</div>`);
    if (s.answer) ev.push(`<div class="pl-ev"><span class="pl-e">${PG.answer}<span>You answered: <b>${esc(s.answer.text.replace(/^"|"$/g, ''))}</b></span></span></div>`);
    if (s.kind === 'branch') {
      const taken = s.arms.findIndex((a) => a.state === 'done');
      if (taken >= 0) ev.push(`<div class="pl-ev"><span class="pl-e">${PG.taken}<span>Taken: ${esc(s.arms[taken].cond)}${s.arms[taken].note ? ' (' + esc(s.arms[taken].note) + ')' : ''}</span></span></div>`);
      out.push(graphNode(s, ev.join('')));
      const decided = taken >= 0;
      out.push(forkSvg(s.arms.length, decided, taken, false));
      out.push(`<div class="pg-lanes" style="--arms: ${s.arms.length}">${s.arms.map((a, k) => {
        const on = decided && k === taken;
        const cls = !decided ? '' : on ? 'on' : 'off';
        const node = { kind: 'do', state: on && st.state === 'done' ? 'done' : 'todo', text: a.then.charAt(0).toUpperCase() + a.then.slice(1), at: on ? a.at : null };
        return `<div class="pg-lane ${cls}"><div class="pg-lh">If ${esc(a.cond)}${decided ? (on ? '<span class="pg-taken">Taken</span>' : '<span class="pg-not">Not taken</span>') : ''}</div>${graphNode(node)}</div>`;
      }).join('')}</div>`);
      out.push(forkSvg(s.arms.length, decided, taken, true));
    } else {
      if (s.state === 'you' && p.planGate) ev.push(`<div class="pg-gq">Waiting for your answer on the project page${p.planGate.choices.length ? ': ' + esc(p.planGate.choices.join(', or ')) : ''}.</div>`);
      out.push(graphNode(s, ev.join(''), s.state === 'you' ? 'you' : ''));
    }
    const nx = plan.steps[i + 1];
    out.push(`<div class="pg-v ${s.state === 'done' && nx && ['done', 'now', 'you'].includes(nx.state) ? 'ld' : ''}"></div>`);
  });
  out.push('<div class="pg-end">End of the plan</div>');
  return `<div class="pg">${out.join('\n')}</div>`;
}

// The plan's References (the files the user attached while planning): a
// picture as a small thumbnail through the picture route, anything else as
// a file chip, each with what it is for in their words.
function planRefsHtml(plan) {
  const refs = plan.refs || [];
  if (!refs.length) return '';
  return `<div class="pl-refs"><div class="pl-refs-h">References</div>${refs.map((r) => `<div class="pl-ref">${r.url ? `<a href="${escRaw(r.url)}" target="_blank" rel="noopener" title="${esc(r.path)}"><img class="thumb" src="${escRaw(r.url)}" alt="${esc('Reference: ' + r.path)}" data-name="${esc(r.path.split('/').pop())}" loading="lazy" onerror="this.closest('a').replaceWith(Object.assign(document.createElement('span'),{className:'chip pl-refchip',textContent:this.dataset.name}))"></a>` : `<span class="chip pl-refchip">${esc(r.path.split('/').pop())}</span>`}<div class="pl-ref-t"><span class="pl-mono">${esc(r.path)}</span>${r.note ? `<span class="t2">"${esc(r.note)}"</span>` : ''}</div></div>`).join('')}</div>`;
}

function renderPlanPage() {
  const p = project(ui.planFor);
  if (!p) { buildView('plan:none', `<div class="view"><h1>Plan</h1><p class="t2">No such project.</p></div>`); return; }
  const plan = p.plan;
  buildView('plan:' + p.id, `<div class="strip" id="pp-strip"></div><div class="body" id="pp-body"></div>`);
  setHtml('pp-strip', `<span class="t3" style="font-size: 12.5px; flex: 1 1 auto"><button class="linkish" data-view="projects">Projects</button><span style="padding: 0 6px">/</span><button class="linkish" data-goto="${escRaw(p.id)}">${esc(p.name)}</button><span style="padding: 0 6px">/</span><span style="color: var(--tx2)">Plan</span></span>${openButton(p, view(p).s)}`);
  if (!plan) {
    setHtml('pp-body', `<h1 style="margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em">No plan running</h1><div class="t2">${esc(p.name)} has no plan running now. Finished and stopped plans stay in its brief as checklists.</div><div>${p.brief ? `<button class="btn pri" data-act="plan-new" data-pid="${escRaw(p.id)}">New plan</button>` : ''}</div>`);
    return;
  }
  const sw = statusWords(plan, plClock);
  const sc = { you: 'var(--you)', work: 'var(--work)', idle: 'var(--tx2)' }[sw.cls];
  const btns = `<div class="pl-full-btns" style="display: flex; gap: 8px; flex-wrap: wrap"><button class="btn sm" data-act="plan-change" data-pid="${escRaw(p.id)}">Change the plan</button>${plan.state === 'paused' ? `<button class="btn sm" data-act="plan-resume" data-pid="${escRaw(p.id)}">Resume</button>` : `<button class="btn sm" data-act="plan-pause" data-pid="${escRaw(p.id)}">Pause</button>`}<button class="btn sm" data-act="plan-stop" data-pid="${escRaw(p.id)}">Stop the plan</button></div>`;
  setHtml('pp-body', `<div style="display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap"><div style="flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 6px"><div style="display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; color: ${sc}">${stateIcon(ST[sw.cls === 'you' ? 'you' : sw.cls === 'work' ? 'work' : 'idle'], sw.cls === 'you' ? 'pulse' : '')}${esc(sw.text)}</div>
<h1 style="margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; overflow-wrap: anywhere">${esc(plan.title)}</h1><div class="t2" style="font-size: 12.5px">${esc(p.name)}. Step ${plan.current} of ${plan.total}. Started ${esc(plClock(plan.startedAt))}.</div></div>
${btns}</div>
${(plan.refs || []).length ? `<div class="card pl-refs-ph">${planRefsHtml(plan)}</div>` : ''}
<div class="cols"><div class="col-l" style="flex: 3 1 560px"><div class="pl-full-graph">${planGraph(p, plan)}</div><div class="card pl-card pl-full-flow">${planFlow(plan, { compact: true })}</div></div>
<div class="col-r pl-full-side" style="flex: 2 1 300px; align-self: flex-start"><div class="card" style="overflow: hidden"><h2 class="card-h">Your goal</h2><div class="card-r" style="line-height: 1.5; align-items: flex-start">"${esc(plan.goal || plan.title)}"</div>${(plan.refs || []).length ? `<div class="card-r" style="align-items: flex-start">${planRefsHtml(plan)}</div>` : ''}</div>
<div class="card" style="overflow: hidden"><h2 class="card-h">Rules for every plan</h2>${PL_ALWAYS.map((r) => `<div class="card-r" style="line-height: 1.45; align-items: flex-start"><span style="color: var(--tx2); margin-top: 2px">${PG.lock}</span><span>${esc(r)}</span></div>`).join('')}</div>
<div class="card" style="overflow: hidden"><h2 class="card-h"><span style="flex: 1">Log</span><span class="t2" style="font-weight: 500; font-size: 12px">from ${esc(p.brief ? p.brief.path.split('/').pop() : 'the brief')}</span></h2>${plan.log.length ? plan.log.map((e) => `<div class="card-r" style="align-items: flex-start"><span class="num t3" style="flex: 0 0 60px; font-size: 12px">${esc(plClock(e.at))}</span><span style="line-height: 1.4; min-width: 0; overflow-wrap: anywhere">${esc(e.text)}</span></div>`).join('') : '<div class="card-r t2">Nothing logged yet.</div>'}</div></div></div>`);
}

function openPlanPage(pid) {
  ui.planFor = pid;
  ui.sel = pid;
  store.set('sel', pid);
  ui.view = 'plan';
  ui.built = null;
  history.replaceState(null, '', '#/plan/' + encodeURIComponent(pid));
  $('#mc').classList.remove('not-projects');
  render();
  window.scrollTo(0, 0);
}

// ---- The planning conversation (section 1, variant A)
// Desktop: a sheet over the board. Phone: a page in place of the project,
// with the chat box and Start pinned at the bottom.

const pl = { pid: null, draft: null, own: false, goal: '', ownText: '', chat: '', cFor: null, cText: '', busy: false, timer: null, rec: null, files: { goal: [], chat: [], comment: [] } };
const plPhone = () => matchMedia('(max-width: 700px)').matches;

async function openPlanSheet(pid, { change = false } = {}) {
  const p = project(pid);
  if (!p) return;
  Object.assign(pl, { pid, draft: null, own: false, goal: '', ownText: '', chat: '', cFor: null, cText: '', busy: false, files: { goal: [], chat: [], comment: [] } });
  try {
    if (change) pl.draft = (await post('/api/plan/change', { projectId: pid })).draft;
    else pl.draft = (await getJson('/api/plan/draft?projectId=' + encodeURIComponent(pid))).draft;
  } catch (e) { toast(e.message, 5000, true); return; }
  drawPlanSheet(true);
}

function closePlanSheet() {
  if (pl.rec) { try { pl.rec.stop(); } catch { /* gone */ } pl.rec = null; }
  pl.pid = null;
  clearInterval(pl.timer);
  pl.timer = null;
  $('#modal').innerHTML = '';
  $('#plan-phone').innerHTML = '';
  $('#mc').classList.remove('planning');
}

// Files in the planning sheet: the goal box, the chat box and a step's
// comment box each take files like the composer (Attach, drop, paste), saved
// into the project's .inbox by the composer's route, shown as its chips.
const CLIP = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 6.5L7 11.5a3 3 0 0 1-4.2-4.2L8 2.1a2 2 0 0 1 2.8 2.8L5.7 10"></path></svg>';
const PL_BOX = { 'pl-goal': 'goal', 'pl-chat': 'chat', 'pl-ctext': 'comment' };
const plAttach = (box, iconOnly = false) => `<label class="attach ${iconOnly ? 'icon' : ''}" ${iconOnly ? 'title="Attach files"' : ''}>${CLIP}${iconOnly ? '' : 'Attach'}<input type="file" multiple data-plfile="${box}" ${iconOnly ? 'aria-label="Attach files"' : ''}></label>`;
const plChips = (box) => {
  const fs = pl.files[box];
  return fs.length ? `<div class="pl-chips">${fs.map((f, k) => fileChip(f, `data-pl="unfile" data-box="${box}" data-k="${k}"`)).join('')}</div>` : '';
};

// The files that go with a message: their saved paths, or null (and a
// toast) while one is still saving.
function plFilesFor(box) {
  const fs = pl.files[box];
  if (fs.some((f) => f.pending)) { toast('Still saving a file, one moment'); return null; }
  return fs.map((f) => f.path);
}

async function plAddFiles(box, list) {
  const files = Array.from(list || []);
  if (!files.length || !pl.pid) return;
  if (box === 'comment' && !pl.cFor) box = pl.draft ? 'chat' : 'goal';
  await saveToInbox(pl.pid, files, pl.files[box], () => { if (pl.pid) drawPlanSheet(); });
}

// Files the user sent, under their message in the thread: pictures as thumbnails
// (through the picture route), anything else as its name.
function plSentFiles(files) {
  if (!files || !files.length) return '';
  return `<div class="cv-files">${files.map((f) => f.url ? `<img src="${escRaw(f.url)}" alt="${esc(f.name)}" title="${esc(f.rel)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'cv-f',textContent:this.alt}))">` : `<span class="cv-f" title="${esc(f.rel)}">${esc(f.name)}</span>`).join('')}</div>`;
}

function plStepHtml(s, n, d) {
  const mark = d.marks && d.marks[s.id];
  const open = pl.cFor === s.id;
  const lock = !!s.locked;
  const sub = [];
  if (s.detail) sub.push(`<div class="cv-sub">${esc(s.detail)}</div>`);
  if (s.kind === 'branch') sub.push(`<div class="wr-opts">${s.arms.map((a) => `<div><b>If ${esc(a.if)}</b>: ${esc(a.then)}</div>`).join('')}</div>`);
  if (s.kind === 'gate' && s.choices && s.choices.length && !s.rule) sub.push(`<div class="cv-sub">Choices: ${esc(s.choices.join(', or '))}</div>`);
  if (s.rule) sub.push(`<div class="cv-rule">${PG.rule}<span>From your rules</span>${lock ? '' : `<button class="cv-rm" data-pl="remove" data-id="${escRaw(s.id)}" aria-label="Remove this gate" title="${esc(s.rule)}">${X_ICON}<span>Remove</span></button>`}</div>`);
  if (lock) sub.push('<div class="cv-sub">Done, so it stays as it is.</div>');
  return `<li class="cv-s ${mark ? 'mk' : ''} ${open ? 'open' : ''} ${lock ? 'lock' : ''}" data-id="${escRaw(s.id)}">
<span class="cv-drag ${lock ? 'lock' : ''}" ${lock ? '' : 'title="Drag to reorder" aria-label="Drag to reorder"'}>${PG.drag}</span>
<span class="cv-n num">${n}</span>
<span class="pl-tag ${s.kind === 'gate' ? 'gate' : ''}">${KIND[s.kind]}</span>
<div class="cv-b"><div class="cv-t">${esc(s.text)}${mark ? `<span class="cv-mk">${mark === 'add' ? 'Added' : 'Updated'}</span>` : ''}</div>${sub.join('')}</div>
${lock ? '<span></span>' : `<button class="cv-c ${open ? 'on' : ''}" data-pl="comment" data-id="${escRaw(s.id)}" aria-label="Comment on step ${n}">${PG.cmt}</button>`}
${open ? `<div class="cv-cbox" data-plbox="comment"><textarea id="pl-ctext" rows="1" placeholder="What should change in this step?" aria-label="Comment on step ${n}">${esc(pl.cText)}</textarea>${plChips('comment')}<div class="cv-cbtns">${plAttach('comment')}<span style="flex: 1"></span><button class="btn sm" data-pl="comment-cancel">Cancel</button><button class="btn sm pri" data-pl="comment-add">Add comment</button></div></div>` : ''}
</li>`;
}

function plThreadHtml(d) {
  const qs = new Map(d.questions.map((q) => [q.id, q]));
  const out = [];
  for (const m of d.thread) {
    if (m.who === 'you') { out.push(`<div class="cv-me">${esc(m.text)}${plSentFiles(m.files)}</div>`); continue; }
    out.push(`<div class="cv-cl">${m.revised ? '<b>Revised.</b> ' : ''}${esc(m.text.replace(/^Revised\.\s*/i, ''))}</div>`);
    for (const id of m.questions || []) {
      const q = qs.get(id);
      if (!q) continue;
      out.push(`<div class="cv-q ${q.answer != null ? 'done' : ''}"><div class="cv-qt">${esc(q.text)}</div><div class="cv-qb">${q.options.map((o) => `<button class="btn sm ${q.answer === o ? 'pick' : ''}" data-pl="answer" data-q="${escRaw(q.id)}" data-o="${escRaw(o)}" ${d.busy ? 'disabled' : ''}>${q.answer === o ? PG.check : ''}${esc(o)}</button>`).join('')}</div></div>`);
    }
  }
  if (d.busy) out.push(`<div class="cv-work" role="status">${PG.now.replace('width="18" height="18"', 'width="14" height="14"')}<span>${jobWho(d.busy)} is ${d.busy.what === 'revise' ? 'revising' : 'drafting'} the plan, <span id="pl-secs" class="num">${secs(d.busy.since)}</span></span><button class="linkish" data-pl="halt">Stop</button></div>`);
  if (d.error) out.push(`<div class="cv-cl err" role="alert">${esc(d.error)}</div>`);
  return out.join('');
}

function plFootNote(d) {
  const open = d.questions.filter((q) => q.answer == null).length;
  if (d.busy) return `${jobWho(d.busy)} is ${d.busy.what === 'revise' ? 'revising' : 'drafting'} the plan.`;
  if (open) return `Answer the ${open === 1 ? 'question' : `${open} questions`} to start.`;
  if (pl.cFor) return `Add comment sends it to ${printWho()}, who revises the plan.`;
  return d.mode === 'change' ? 'Saved in the brief, and the session re-reads it.' : 'Saved in the brief when it starts, so it survives hand-offs.';
}

function plStartBtn(d, cls = '') {
  const can = d.steps.length && !d.busy && !d.questions.some((q) => q.answer == null);
  return `<button class="btn pri ${cls}" data-pl="start" ${can ? '' : 'disabled'}>${d.mode === 'change' ? 'Save the changes' : 'Looks right, start'}</button>`;
}

const plMic = (target, iconOnly = false) => `<button class="btn sm wr-mic ${pl.rec && pl.rec.target === target ? 'on' : ''}" data-pl="dictate" data-target="${target}" ${iconOnly ? 'aria-label="Dictate"' : ''}>${PG.mic}${iconOnly ? '' : (pl.rec && pl.rec.target === target ? 'Listening' : 'Dictate')}</button>`;

function plSheetHtml(p, d, phone) {
  const x = `<button class="x-btn" data-pl="close" aria-label="Close">${X_ICON}</button>`;
  const title = d && d.mode === 'change' ? `Change the plan for ${p.name}` : `New plan for ${p.name}`;
  if (!d) {
    // The goal box (or "Write the plan yourself").
    const own = pl.own;
    const box = own
      ? `<label class="wr-lbl" style="font-size: 14px" for="pl-goal">Your plan, in your words</label>
<div class="composer cv-goal own" data-plbox="goal"><textarea id="pl-goal" rows="6" placeholder="Research how other rhythm games show long notes. If most use a held trail, build the trail; if most use a ribbon, mock up both and ask me. Done when the gesture test passes and a screenshot shows it. Ask me before installing.">${esc(pl.ownText)}</textarea>${plChips('goal')}<div style="display: flex; align-items: center; gap: 6px">${plAttach('goal')}${plMic('pl-goal')}<span style="flex: 1"></span><button class="btn sm pri" data-pl="own">Turn into steps</button></div></div>
<div class="t3" style="font-size: 12px; line-height: 1.45">Say it however you like: "if this then that", "done when", "ask me before". ${printWho()} keeps your words and order, and asks back only where a step could go two ways.</div>`
      : `<label class="wr-lbl" style="font-size: 14px" for="pl-goal">What do you want done?</label>
<div class="composer cv-goal" data-plbox="goal"><textarea id="pl-goal" rows="2" placeholder="Make long notes on the paths feel good">${esc(pl.goal)}</textarea>${plChips('goal')}<div style="display: flex; align-items: center; gap: 6px">${plAttach('goal')}${plMic('pl-goal')}<span style="flex: 1"></span><button class="btn sm pri" data-pl="draft">Draft a plan</button></div></div>
<div class="t3" style="font-size: 12px; line-height: 1.45">A sentence is enough: the outcome you want. ${printWho()} reads the brief and your rules for the rest. Attach a file and say what it is for, like "I like this style".</div>`;
    const sub = `Say what you want; ${printWho()} drafts the plan and you go over it together. Nothing runs until you start it.`;
    const swap = `<button class="linkish cv-own" data-pl="${own ? 'goal-mode' : 'own-mode'}">${own ? `Let ${printWho()} draft it` : 'Write the plan yourself'}</button>`;
    if (phone) {
      return `<div class="strip"><span class="t3" style="font-size: 12.5px; flex: 1 1 auto">${esc(p.name)}<span style="padding: 0 6px">/</span><span style="color: var(--tx2)">New plan</span></span><button class="btn sm" data-pl="cancel">Cancel</button></div>
<div class="body"><h1 style="margin: 0; font-size: 22px; font-weight: 700">New plan</h1><div class="t3" style="font-size: 12px; line-height: 1.45">${esc(sub)}</div>${box}<div>${swap}</div></div>`;
    }
    return `<div class="modal-back" id="pl-back"><div class="modal cv-modal goal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
<div style="display: flex; align-items: center; gap: 10px; padding: 22px 24px 4px"><h2 style="margin: 0; font-size: 20px; font-weight: 700; flex: 1">${esc(title)}</h2>${x}</div>
<div class="t3" style="padding: 0 24px 16px; font-size: 12px; line-height: 1.45">${esc(sub)}</div>
<div style="padding: 0 24px 18px; display: flex; flex-direction: column; gap: 10px">${box}</div>
<div class="sheet-foot">${swap}<span style="flex: 1"></span><button class="btn" data-pl="cancel">Cancel</button></div></div></div>`;
  }
  const marks = Object.keys(d.marks || {}).length;
  const label = marks ? `Revised plan <span class="cv-diff"><i></i>${phone ? 'Changed' : 'Changed in this revision'}</span>` : `${d.mode === 'change' ? 'Plan' : 'Draft plan'} <span class="t3" style="font-weight: 500">${phone ? '' : 'Drag to reorder, or comment on a step'}</span>`;
  const steps = d.steps.length
    ? `<ol class="cv-list" id="pl-list">${d.steps.map((s, i) => plStepHtml(s, i + 1, d)).join('')}</ol>`
    : `<div class="cv-skel" aria-hidden="true"><i style="width: 70%"></i><i style="width: 52%"></i><i style="width: 64%"></i><i style="width: 40%"></i></div>`;
  const always = `<div class="wr-rule">${PG.lock}<span><b>Always on:</b> anything the plan doesn't foresee is a gate. ${projWho(p)} stops and asks.</span></div>`;
  const chatPh = marks || d.mode === 'change' ? 'Anything else to change? Say it here.' : 'Bigger changes: say them here.';
  if (phone) {
    return `<div class="strip"><span class="t3" style="font-size: 12.5px; flex: 1 1 auto">${esc(p.name)}<span style="padding: 0 6px">/</span><span style="color: var(--tx2)">${d.mode === 'change' ? 'Change the plan' : 'New plan'}</span></span><button class="btn sm" data-pl="cancel">Cancel</button></div>
<div class="body ${pl.files.chat.length ? 'has-chips' : ''}"><div class="cv-thread">${plThreadHtml(d)}</div><div class="wr-lbl">${label}</div>${steps}${always}</div>
<div class="cv-pbar">${plChips('chat')}<div class="composer cv-chat" data-plbox="chat"><textarea id="pl-chat" rows="1" placeholder="${marks || d.mode === 'change' ? 'Anything else to change?' : 'Bigger changes: say them here'}" aria-label="Changes to the plan">${esc(pl.chat)}</textarea>${plAttach('chat', true)}${pl.chat.trim() ? `<button class="btn sm pri" data-pl="chat" ${d.busy ? 'disabled' : ''}>Send</button>` : plMic('pl-chat', true)}</div>
<div class="cv-pbtns">${d.questions.some((q) => q.answer == null) || d.busy ? `<span class="t2" style="font-size: 12.5px">${esc(plFootNote(d))}</span>` : '<button class="linkish cv-own" data-pl="own-restart">Write it yourself</button>'}${plStartBtn(d)}</div></div>`;
  }
  return `<div class="modal-back" id="pl-back"><div class="modal cv-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
<div style="display: flex; align-items: center; gap: 10px; padding: 22px 24px 4px"><h2 style="margin: 0; font-size: 20px; font-weight: 700; flex: 1">${esc(title)}</h2>${x}</div>
<div class="cv-cols"><div class="cv-left"><div class="cv-thread">${plThreadHtml(d)}</div><div class="composer cv-chat" data-plbox="chat"><textarea id="pl-chat" rows="1" placeholder="${esc(chatPh)}" aria-label="Changes to the plan">${esc(pl.chat)}</textarea>${plChips('chat')}<div style="display: flex; align-items: center; gap: 6px">${plAttach('chat')}${plMic('pl-chat')}<span style="flex: 1"></span><button class="btn sm pri" data-pl="chat" ${d.busy ? 'disabled' : ''}>Send</button></div></div></div>
<div class="cv-right"><div class="wr-lbl">${label}</div>${steps}${always}</div></div>
<div class="sheet-foot">${d.mode === 'change' ? '<span></span>' : '<button class="linkish cv-own" data-pl="own-restart">Write the plan yourself</button>'}<span style="flex: 1"></span><span class="t2" style="font-size: 12.5px; line-height: 1.4; text-align: right; max-width: 380px">${esc(plFootNote(d))}</span>${plStartBtn(d)}</div></div></div>`;
}

function drawPlanSheet(first = false) {
  const p = project(pl.pid);
  if (!p) { closePlanSheet(); return; }
  const phone = plPhone();
  const host = phone ? $('#plan-phone') : $('#modal');
  const other = phone ? $('#modal') : $('#plan-phone');
  const focus = document.activeElement && document.activeElement.id;
  const caret = focus && document.activeElement.selectionStart;
  const scroller = phone ? null : host.querySelector('.modal-back');
  const top = scroller ? scroller.scrollTop : 0;
  other.innerHTML = '';
  host.innerHTML = plSheetHtml(p, pl.draft, phone);
  $('#mc').classList.toggle('planning', phone);
  const sc = phone ? null : host.querySelector('.modal-back');
  if (sc) sc.scrollTop = top;
  const f = focus && document.getElementById(focus);
  if (f && f.tagName === 'TEXTAREA') { f.focus(); try { f.setSelectionRange(caret, caret); } catch { /* fine */ } }
  else if (first) { const g = $('#pl-goal') || $('#pl-chat'); if (g && !phone) g.focus(); if (phone) window.scrollTo(0, 0); }
  clearInterval(pl.timer);
  pl.timer = pl.draft && pl.draft.busy ? setInterval(() => { const el = $('#pl-secs'); if (el && pl.draft && pl.draft.busy) el.textContent = secs(pl.draft.busy.since); }, 1000) : null;
}

async function plPost(act, body) {
  try {
    const r = await post('/api/plan/' + act, { projectId: pl.pid, ...body });
    if (r.draft !== undefined && pl.pid) pl.draft = r.draft;
    return r;
  } catch (e) {
    toast(e.message, 5000, true);
    return null;
  } finally {
    if (pl.pid) drawPlanSheet();
  }
}

async function plClick(e) {
  const b = e.target.closest('[data-pl]');
  if (!b || b.disabled) return;
  const a = b.dataset.pl;
  const d = pl.draft;
  if (a === 'close') { closePlanSheet(); return; }
  if (a === 'cancel') {
    if (d && d.steps.length && !confirm('Throw this draft away?')) return;
    if (d) await post('/api/plan/discard', { projectId: pl.pid }).catch(() => {});
    closePlanSheet();
    return;
  }
  if (a === 'own-mode' || a === 'goal-mode') { pl.own = a === 'own-mode'; drawPlanSheet(true); return; }
  if (a === 'own-restart') {
    if (d && d.steps.length && !confirm('Start again from your own words? This draft is thrown away.')) return;
    await post('/api/plan/discard', { projectId: pl.pid }).catch(() => {});
    pl.draft = null; pl.own = true; drawPlanSheet(true); return;
  }
  if (a === 'unfile') { pl.files[b.dataset.box].splice(Number(b.dataset.k), 1); drawPlanSheet(); return; }
  if (a === 'draft' || a === 'own') {
    const text = ($('#pl-goal').value || '').trim();
    if (!text) { toast(a === 'own' ? 'Write the plan first' : 'Say what you want done first'); return; }
    const files = plFilesFor('goal');
    if (!files) return;
    const r = await plPost(a, a === 'own' ? { text, files } : { goal: text, files });
    if (r) { pl.files.goal = []; drawPlanSheet(); }
    return;
  }
  if (a === 'answer') { await plPost('edit', { answer: { id: b.dataset.q, option: b.dataset.o } }); return; }
  if (a === 'remove') { await plPost('edit', { remove: b.dataset.id }); return; }
  if (a === 'comment') { pl.cFor = pl.cFor === b.dataset.id ? null : b.dataset.id; pl.cText = ''; pl.files.comment = []; drawPlanSheet(); const t = $('#pl-ctext'); if (t) t.focus(); return; }
  if (a === 'comment-cancel') { pl.cFor = null; pl.cText = ''; pl.files.comment = []; drawPlanSheet(); return; }
  if (a === 'comment-add') {
    const text = ($('#pl-ctext').value || '').trim();
    if (!text) { toast(pl.files.comment.length ? 'Say what the file is for, like "I like this style"' : 'Write the comment first'); return; }
    const files = plFilesFor('comment');
    if (!files) return;
    const step = pl.cFor;
    const keep = { text, files: pl.files.comment };
    pl.cFor = null; pl.cText = ''; pl.files.comment = [];
    const r = await plPost('revise', { comment: { step, text, files } });
    if (!r) { pl.cFor = step; pl.cText = keep.text; pl.files.comment = keep.files; drawPlanSheet(); }
    return;
  }
  if (a === 'chat') {
    const text = ($('#pl-chat').value || '').trim();
    if (!text) { toast(pl.files.chat.length ? 'Say what the file is for, like "I like this style"' : 'Say what to change first'); return; }
    const files = plFilesFor('chat');
    if (!files) return;
    const keep = pl.files.chat;
    pl.chat = ''; pl.files.chat = [];
    const r = await plPost('revise', { message: text, files });
    if (!r) { pl.files.chat = keep; drawPlanSheet(); }
    return;
  }
  if (a === 'halt') { await plPost('halt', {}); return; }
  if (a === 'dictate') { dictate(b.dataset.target); return; }
  if (a === 'start') {
    b.disabled = true;
    const p = project(pl.pid);
    const before = p ? p.sessions.map((x) => x.surfaceId) : [];
    const r = await plPost('start', {});
    if (r && r.ok) {
      if (p && r.via === 'revive') { const { s } = view(p); if (s) ui.selSession[p.id] = s.surfaceId; followStart(p.id, r, before); }
      closePlanSheet();
      render();
      toast(d.mode === 'change' ? `Plan changed. ${p.name}'s session re-reads it.` : r.via === 'revive' ? `"${r.title}" is in the brief. A new session in ${p.name} reads it and starts.` : `"${r.title}" is in the brief and ${p.name}'s session has started it${r.delivered === 'now' ? '' : ', after its current step'}.`, 5000, true);
    }
  }
}

function plInput(e) {
  const t = e.target;
  if (t.id === 'pl-goal') { if (pl.own) pl.ownText = t.value; else pl.goal = t.value; }
  if (t.id === 'pl-chat') {
    const had = !!pl.chat.trim();
    pl.chat = t.value;
    // The phone bar swaps the mic for Send once there is text.
    if (plPhone() && had !== !!pl.chat.trim()) drawPlanSheet();
  }
  if (t.id === 'pl-ctext') pl.cText = t.value;
  if (t.tagName === 'TEXTAREA') { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 240) + 'px'; }
}

function plKey(e) {
  if (e.key === 'Escape') { if (pl.cFor) { pl.cFor = null; drawPlanSheet(); } else closePlanSheet(); return; }
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
  const id = e.target.id;
  const btn = id === 'pl-goal' ? $(pl.own ? '[data-pl="own"]' : '[data-pl="draft"]') : id === 'pl-chat' ? $('[data-pl="chat"]') : id === 'pl-ctext' ? $('[data-pl="comment-add"]') : null;
  if (btn) { e.preventDefault(); btn.click(); }
}

// Dictation through the browser's own speech recognition, where it has one.
function dictate(target) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (pl.rec) { const same = pl.rec.target === target; try { pl.rec.stop(); } catch { /* gone */ } pl.rec = null; drawPlanSheet(); if (same) return; }
  if (!SR) { toast('This browser has no dictation here. Use the keyboard\'s own dictation key instead.', 4500, true); return; }
  const r = new SR();
  r.lang = navigator.language || 'en-US';
  r.interimResults = false;
  r.continuous = true;
  r.target = target;
  r.onresult = (ev) => {
    const el = document.getElementById(target);
    let add = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) add += ev.results[i][0].transcript;
    if (!el || !add) return;
    el.value = (el.value ? el.value.replace(/\s*$/, ' ') : '') + add.trim();
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  r.onend = () => { if (pl.rec === r) { pl.rec = null; if (pl.pid) drawPlanSheet(); } };
  r.onerror = (ev) => { toast(ev.error === 'not-allowed' ? 'The microphone is blocked for this page.' : 'Dictation stopped.'); };
  try { r.start(); pl.rec = r; drawPlanSheet(); } catch (e) { toast('Dictation did not start: ' + e.message); }
}

// Drag a step by its handle (pointer events, so it works with a finger too).
function plDragStart(e) {
  const h = e.target.closest('.cv-drag');
  if (!h || h.classList.contains('lock') || !pl.draft || pl.draft.busy) return;
  const li = h.closest('.cv-s');
  const list = li.parentElement;
  e.preventDefault();
  h.setPointerCapture(e.pointerId);
  li.classList.add('dragging');
  const y0 = e.clientY;
  const move = (ev) => {
    li.style.transform = `translateY(${ev.clientY - y0}px)`;
    const rows = [...list.children].filter((x) => x !== li);
    const before = rows.find((x) => { const r = x.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if (before && before.classList.contains('lock') && [...list.children].indexOf(before) < [...list.children].indexOf(li)) return;
    const shift = li.getBoundingClientRect().top;
    if (before) list.insertBefore(li, before); else list.appendChild(li);
    const moved = li.getBoundingClientRect().top - shift;
    if (moved) { const cur = Number((li.style.transform.match(/-?[\d.]+/) || [0])[0]); li.style.transform = `translateY(${cur - moved}px)`; }
  };
  const up = () => {
    h.removeEventListener('pointermove', move);
    h.removeEventListener('pointerup', up);
    h.removeEventListener('pointercancel', up);
    li.classList.remove('dragging');
    li.style.transform = '';
    const order = [...list.children].map((x) => x.dataset.id);
    if (order.join() !== pl.draft.steps.map((s) => s.id).join()) plPost('edit', { order });
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', up);
  h.addEventListener('pointercancel', up);
}

for (const id of ['modal', 'plan-phone']) {
  const el = document.getElementById(id);
  // Files: dropped on a box go with it; dropped elsewhere on the sheet, with
  // the open comment, else the chat box (the goal box before a draft).
  const boxOf = (e) => { const b = e.target.closest && e.target.closest('[data-plbox]'); return b ? b.dataset.plbox : pl.cFor ? 'comment' : pl.draft ? 'chat' : 'goal'; };
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  el.addEventListener('dragover', (e) => {
    if (!pl.pid || !hasFiles(e)) return;
    e.preventDefault();
    const b = e.target.closest('[data-plbox]');
    el.querySelectorAll('[data-plbox].over').forEach((x) => { if (x !== b) x.classList.remove('over'); });
    if (b) b.classList.add('over');
  });
  el.addEventListener('dragleave', (e) => { const b = e.target.closest && e.target.closest('[data-plbox]'); if (b && !b.contains(e.relatedTarget)) b.classList.remove('over'); });
  el.addEventListener('drop', (e) => {
    if (!pl.pid || !hasFiles(e)) return;
    e.preventDefault();
    el.querySelectorAll('[data-plbox].over').forEach((x) => x.classList.remove('over'));
    plAddFiles(boxOf(e), e.dataTransfer.files);
  });
  el.addEventListener('paste', (e) => {
    const box = pl.pid && PL_BOX[e.target.id];
    const fs = Array.from((e.clipboardData && e.clipboardData.files) || []);
    // A pasted path is plain text and goes through untouched.
    if (box && fs.length) { e.preventDefault(); plAddFiles(box, fs); }
  });
  el.addEventListener('change', (e) => {
    const box = pl.pid && e.target.dataset && e.target.dataset.plfile;
    if (!box) return;
    const fs = Array.from(e.target.files || []);
    e.target.value = '';
    plAddFiles(box, fs);
  });
  el.addEventListener('click', (e) => { if (pl.pid) plClick(e); });
  el.addEventListener('input', (e) => { if (pl.pid) plInput(e); });
  el.addEventListener('keydown', (e) => { if (pl.pid) plKey(e); });
  el.addEventListener('pointerdown', (e) => { if (pl.pid) plDragStart(e); });
  el.addEventListener('mousedown', (e) => { if (pl.pid && e.target.id === 'pl-back') closePlanSheet(); });
}
matchMedia('(max-width: 700px)').addEventListener('change', () => { if (pl.pid) drawPlanSheet(); });

// ------------------------------------------------------------ Sessions
// The top-bar memory readout and the Sessions page it opens (docs/SESSIONS.md,
// design: docs/design/CloseIdle.dc.html, variant C's page from A's readout).

const MEM_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="2"></rect><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2"></path></svg>';
const MIX = [['you', 'Needs you', 'var(--you)'], ['work', 'Working', 'var(--work)'], ['wait', 'Waiting', 'var(--wait)'], ['idle', 'Idle', 'var(--idle)'], ['unmapped', 'Not mapped', 'var(--tx3)']];

// RSS in KB -> "849 MB" or "10.0 GB" (1024-based, like Activity Monitor).
function fmtMem(kb) {
  if (kb == null) return '';
  const mb = kb / 1024;
  return mb < 1000 ? Math.round(mb) + ' MB' : (mb / 1024).toFixed(1) + ' GB';
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : many || one + 's'}`; }

function renderMemchip() {
  const v = ui.snap && ui.snap.sessions;
  const on = ui.view === 'sessions';
  // One readout, drawn twice: in the top bar's tools, and on its own line at
  // phone width (CSS shows one of the two).
  for (const id of ['memchip', 'memchip-m']) {
    const b = document.getElementById(id);
    if (!v || !v.at) { b.hidden = true; continue; }
    b.hidden = false;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    // "Sessions", not "Claude": Codex sessions count too
    // (docs/design/CodexStage2.dc.html, section 2, A).
    b.title = `Memory held by all ${plural(v.count, 'session')}. ${v.idleCount === 1 ? '1 is' : v.idleCount + ' are'} idle and can be closed.`;
    b.setAttribute('aria-label', `Sessions: they use ${fmtMem(v.totalKb)}, ${v.idleCount} idle`);
    setHtml(id, `${MEM_ICON}<span class="t2">Sessions</span><span class="num" style="font-weight: 600">${esc(fmtMem(v.totalKb))}</span><span class="memchip-sep"></span><span class="num t3">${v.idleCount} idle</span>`);
  }
}

function isTicked(r) {
  if (!r.closable || !r.sessionId) return false;
  const k = ui.tick[r.sessionId];
  return k != null ? k : r.group === 'handed' || r.group === 'idle';
}

function idleWord(r) {
  const d = parseT(r.since);
  if (!d) return '';
  return (r.group === 'handed' ? 'handed off ' : '') + rel(d);
}

function crow(r) {
  const on = isTicked(r);
  const can = r.closable && !!r.sessionId;
  const tag = r.tag === 'draft' ? '<span class="crow-tag">Half-typed reply</span>'
    : r.tag === 'asked' ? '<span class="crow-tag">Asked you a question</span>' : '';
  const blocked = !can ? `<span class="crow-tag muted" title="${esc(r.blocked || '')}">${esc(/^(Outside|In) \S+$/.test(r.blocked || '') ? r.blocked : 'Cannot close')}</span>` : '';
  const tip = `${r.folder || ''}${r.sessionId ? `, session ${r.sessionId.slice(0, 8)} via ${r.method}` : ''}, pid ${r.pid}`;
  return `<label class="crow ${can ? '' : 'nohover'}" title="${esc(tip)}">
<input type="checkbox" class="sr-only" data-tick="${escRaw(r.sessionId || 'pid-' + r.pid)}" ${on ? 'checked' : ''} ${can ? '' : 'disabled'} aria-label="${esc(`${r.label}: ${r.line}, idle ${idleWord(r)}, ${fmtMem(r.memKb)}${can ? '' : '. ' + (r.blocked || 'Cannot be closed')}`)}">
<span class="tick ${on ? 'on' : ''} ${can ? '' : 'off'}" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 10 10"><path d="${on ? CHECK : ''}" stroke="#FFFFFF" stroke-width="2" fill="none"></path></svg></span>
<span class="crow-p ${r.isFolder ? 'folder' : ''}" title="${esc(r.isFolder ? 'Folder outside any project: ' + (r.folder || '') : r.label)}">${esc(r.label)}</span>
<span class="crow-t">${esc(r.line)}</span>${tag}${blocked}${asTag(r.assistant)}
<span class="crow-i num">${esc(idleWord(r))}</span>
<span class="crow-m num">${esc(fmtMem(r.memKb))}</span></label>`;
}

function sessCard(title, sub, body) {
  return `<div class="card" style="overflow: hidden"><h3 class="card-h ch-s"><span style="flex: 1">${title}</span><span class="t2 num" style="font-weight: 500; font-size: 12px">${sub}</span></h3>${body}</div>`;
}
function countMem(rows) { return `${plural(rows.length, 'session')}, ${fmtMem(rows.reduce((n, r) => n + r.memKb, 0))}`; }

function renderSessions() {
  buildView('sessions', `<div class="view" id="sessions-view">
<div style="display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap" id="s-head"></div>
<div id="s-result"></div>
<div style="display: flex; flex-direction: column; gap: 8px" id="s-meter"></div>
<div class="t3" style="font-size: 12px; line-height: 1.45" id="s-rule"></div>
<div class="cols" style="gap: 16px"><div class="col-l" style="gap: 12px; flex-basis: 560px" id="s-left"></div><div class="col-r" style="gap: 12px" id="s-right"></div></div>
</div>`);
  const v = ui.snap.sessions;
  if (!v || !v.at) {
    setHtml('s-head', `<div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px"><h1>Sessions</h1><div class="t2" style="font-size: 13px">${v && v.error ? esc('Could not read the claude processes: ' + v.error) : 'Reading the claude processes...'}</div></div>`);
    return;
  }
  const rows = v.rows;
  const ticked = rows.filter(isTicked);
  const tickKb = ticked.reduce((n, r) => n + r.memKb, 0);
  const busy = ui.closingNow || v.closing;
  const btn = busy ? 'Closing...' : ticked.length ? `Close ${plural(ticked.length, 'session')}, frees ${fmtMem(tickKb)}` : 'Nothing ticked';
  setHtml('s-head', `<div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px"><h1>Sessions</h1><div class="t2" style="font-size: 13px">${plural(v.count, 'session')} ${v.count === 1 ? 'holds' : 'hold'} <b class="num" style="color: var(--tx)">${esc(fmtMem(v.totalKb))}</b> of memory. Read from each process every minute.</div></div><button class="btn pri" id="close-idle" ${!ticked.length || busy ? 'disabled' : ''}>${esc(btn)}</button>`);

  const res = v.result;
  let rh = '';
  if (res) {
    if (res.closed) rh += `<div style="font-size: 13px; color: var(--ok); font-weight: 600">Closed ${plural(res.closed, 'session')} and freed ${esc(fmtMem(res.freedKb))}. The sessions now hold ${esc(fmtMem(res.nowKb))}.</div>`;
    for (const f of res.failed || []) rh += `<div class="err-line">Left open: ${esc(f.label)}. ${esc(f.error)}</div>`;
  }
  setHtml('s-result', rh ? `<div style="display: flex; flex-direction: column; gap: 4px">${rh}</div>` : '');

  const by = {};
  for (const r of rows) by[r.mix] = (by[r.mix] || 0) + r.memKb;
  const parts = MIX.filter(([k]) => by[k]);
  setHtml('s-meter', `<div class="mbar" style="height: 8px" role="img" aria-label="${esc(parts.map(([k, w]) => `${w} ${fmtMem(by[k])}`).join(', '))}">${parts.map(([k, , c]) => `<span style="flex: ${by[k]}; background: ${c}"></span>`).join('')}</div>
<div class="legend">${parts.map(([k, w, c]) => `<span><i style="background: ${c}"></i>${w} <span class="num">${esc(fmtMem(by[k]))}</span></span>`).join('')}</div>`);

  setHtml('s-rule', `Listed when there has been no hook activity for ${v.idleHours} h, nothing is mid-turn, and no background task or loop is running. A session that has handed off is listed at any age. Ends Claude in each tab and keeps the transcript. Recently closed can reopen any of them.`);

  const byAge = (a, b) => Date.parse(a.since || 0) - Date.parse(b.since || 0) || b.memKb - a.memKb;
  const handed = rows.filter((r) => r.group === 'handed').sort(byAge);
  const idle = rows.filter((r) => r.group === 'idle').sort((a, b) => b.memKb - a.memKb);
  const left = rows.filter((r) => r.group === 'left').sort((a, b) => b.memKb - a.memKb);
  let lh = '';
  if (handed.length) lh += sessCard('Handed off', countMem(handed), handed.map(crow).join(''));
  if (idle.length) lh += sessCard(`No activity for ${v.idleHours} h or more`, countMem(idle), idle.map(crow).join(''));
  if (left.length) lh += sessCard('Left for you', countMem(left), left.map(crow).join(''));
  if (!lh) lh = sessCard('Nothing idle', '', `<div class="card-r t2" style="font-size: 12.5px; line-height: 1.45">No session has been quiet for ${v.idleHours} h or more. They show up here once one has.</div>`);
  setHtml('s-left', lh);

  // In use, then the ones not in a project in a card of their own
  // (docs/design/CodexStage2.dc.html, section 2, A), each with its tag.
  const byMix = (a, b) => ORDER.indexOf(a.mix) - ORDER.indexOf(b.mix) || b.memKb - a.memKb;
  const use = rows.filter((r) => r.group === 'use' && !r.unowned).sort(byMix);
  const useUn = rows.filter((r) => r.group === 'use' && r.unowned).sort(byMix);
  const useRow = (r) => `<div class="card-r" style="gap: 10px" title="${esc(`${r.folder || ''}, session ${r.sessionId ? r.sessionId.slice(0, 8) : ''} via ${r.method}, pid ${r.pid}`)}">${stateIcon(ST[r.mix] || ST.idle)}<span class="ell" style="flex: 1"><b style="${r.unowned ? 'font-weight: 500; color: var(--tx2)' : 'font-weight: 600'}">${esc(r.label)}</b> <span class="t2">${esc(r.line)}</span></span>${asTag(r.assistant)}<span class="num" style="font-size: 12px; white-space: nowrap">${esc(fmtMem(r.memKb))}</span></div>`;
  let rh2 = sessCard('In use', use.length ? countMem(use) : 'None', use.length ? use.map(useRow).join('')
    : `<div class="card-r t2" style="font-size: 12.5px">${useUn.length ? 'Every session in a project is idle.' : 'Every session is idle.'}</div>`);
  if (useUn.length) rh2 += sessCard('Not in a project', countMem(useUn), useUn.map(useRow).join(''));
  const un = rows.filter((r) => r.group === 'unmapped');
  if (un.length) {
    rh2 += sessCard('Not mapped', countMem(un), un.map((r) => `<div class="card-r" style="gap: 10px" title="${esc(r.folder || '')}"><span class="ell" style="flex: 1"><b style="font-weight: 500; color: var(--tx2)">${esc(r.label)}</b> <span class="t3">pid ${r.pid}, no session found, so it is not closed from here</span></span><span class="num" style="font-size: 12px; white-space: nowrap">${esc(fmtMem(r.memKb))}</span></div>`).join(''));
  }
  const closed = v.closed || [];
  const shown = ui.closedAll ? closed : closed.slice(0, 6);
  const ago = (iso) => { const d = parseT(iso); return d ? (rel(d) === 'now' ? 'closed just now' : `closed ${rel(d)} ago`) : ''; };
  const rc = closed.length
    ? shown.map((c) => `<div class="card-r" style="gap: 10px"><span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px"><span style="display: flex; align-items: baseline; gap: 8px; min-width: 0"><b class="ell" style="font-weight: 600">${esc(c.label || c.project || 'Session')}</b><span class="num t3" style="font-size: 12px; white-space: nowrap">${esc(ago(c.closedAt))}</span><span class="num t3" style="font-size: 12px; white-space: nowrap; margin-left: auto">${esc(fmtMem(c.memKb))}</span></span><span class="t2 ell" style="font-size: 12px">${esc(c.lastLine || '')}</span></span><button class="btn sm" data-reopen="${escRaw(c.id)}" aria-label="${esc('Reopen ' + (c.label || 'session'))}">Reopen</button></div>`).join('')
      + (closed.length > 6 ? `<div class="card-r t2" style="font-size: 12px"><span style="flex: 1">${ui.closedAll ? '' : closed.length - 6 + ' more'}</span><button class="linkish" data-closed-all="1" style="color: var(--work); font-size: 12px">${ui.closedAll ? 'Show fewer' : 'Show all'}</button></div>` : '')
    : '<div class="card-r t2" style="font-size: 12.5px; line-height: 1.45">Closed sessions land here with a Reopen button.</div>';
  rh2 += sessCard('Recently closed', closed.length ? `${plural(closed.length, 'session')}, kept for 14 days` : 'None yet', rc);
  if (closed.length) rh2 += '<div class="t3" style="font-size: 12px; line-height: 1.45">Reopen runs <span class="mono">claude --resume &lt;id&gt;</span> in a new tab, in the same workspace and folder.</div>';
  setHtml('s-right', rh2);
}

async function closeIdle() {
  const v = ui.snap && ui.snap.sessions;
  if (!v || ui.closingNow) return;
  const ids = v.rows.filter(isTicked).map((r) => r.sessionId);
  if (!ids.length) return;
  ui.closingNow = true;
  render();
  try {
    const r = await post('/api/sessions/close', { ids });
    ui.tick = {};
    if (!r.closed && r.failed && r.failed.length) toast('Nothing was closed. Each one says why.');
  } catch (e) {
    toast(e.message);
  } finally {
    ui.closingNow = false;
    render();
  }
}

async function reopenClosed(id, btn) {
  btn.disabled = true;
  try {
    const r = await post('/api/sessions/reopen', { id });
    toast(`Reopened ${r.label || 'the session'} in a new tab in ${r.same ? r.workspace || r.workspaceRef : 'the workspace cmux shows now'}.`);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

// ------------------------------------------------------------ alerts

// For screen readers only. Notifications come from the server (the bell,
// server/desktop.mjs), never from the page, so there are never two.
function announce(prev, snap) {
  const fresh = snap.projects.filter((p) => p.state === 'you' && prev[p.id] && prev[p.id] !== 'you');
  if (!fresh.length) return;
  $('#announce').textContent = fresh.map((p) => `${p.name} needs you`).join('. ');
}

// The bell: Mac notifications on or off, stored on the server
// (alerts.json "desktop"), on unless turned off.
const BELL_ON = 'Mac notifications on: a question, a hand-back, a permission prompt or a plan gate';
function paintBell() {
  const d = ui.snap && ui.snap.alerts && ui.snap.alerts.desktop;
  const on = ui.bellBusy != null ? ui.bellBusy : !d || d.enabled !== false;
  const b = $('#alerts');
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'Mac notifications on' : 'Mac notifications off');
  b.title = on ? BELL_ON : 'Mac notifications off';
  b.classList.toggle('bell-off', !on);
}

// ------------------------------------------------------------ wiring

function render() {
  if (!ui.snap) return;
  if (lv.full && ui.view !== 'projects') closeFull({ back: false });
  const you = ui.snap.projects.filter((p) => p.state === 'you').length;
  document.title = (you ? `(${you}) ` : '') + 'Ravenry';
  renderViews();
  renderMemchip();
  paintBell();
  followNew();
  if (!ui.sel || !project(ui.sel)) {
    const ps = ui.snap.projects;
    const first = ORDER.map((k) => ps.filter((p) => p.state === k)).find((a) => a.length);
    ui.sel = first ? first.slice().sort((a, b) => Date.parse(b.since || 0) - Date.parse(a.since || 0))[0].id : null;
  }
  renderList();
  renderProjectChips();
  if (ui.view === 'objectives') renderObjectives();
  else if (ui.view === 'ideas') renderIdeas();
  else if (ui.view === 'rules') renderRules();
  else if (ui.view === 'ship') renderShip();
  else if (ui.view === 'sessions') renderSessions();
  else if (ui.view === 'plan') renderPlanPage();
  else renderSheet();
}

function select(id) {
  // The phone's planning page stands in for the project; picking another
  // project leaves it (the draft is kept).
  if (pl.pid && pl.pid !== id) closePlanSheet();
  if (ui.view !== 'projects') { ui.sel = id; store.set('sel', id); setView('projects'); return; }
  if (ui.sel === id) return;
  ui.sel = id;
  store.set('sel', id);
  history.replaceState(null, '', '#' + encodeURIComponent(id));
  render();
  // At phone width the detail sits right under the chips and replaces the
  // one before it in place; only when the chips have scrolled away does the
  // page go back up so the new project starts at its header.
  if (window.matchMedia('(max-width: 700px)').matches && $('#pchips').getBoundingClientRect().top < 0) window.scrollTo(0, 0);
}

function applyTheme(theme) {
  ui.theme = theme;
  $('#mc').classList.toggle('light', theme === 'light');
  document.body.classList.toggle('light', theme === 'light');
  document.documentElement.style.colorScheme = theme;
}

document.addEventListener('click', (e) => {
  const row = e.target.closest('.row[data-id], .pchip[data-id]');
  if (row) { if (row.closest('#idle-sheet')) closeIdleSheet({ focus: false }); select(row.dataset.id); return; }
  if (e.target.closest('[data-idle-open]')) { if (ui.idleOpen) closeIdleSheet(); else openIdleSheet(); return; }
  if (e.target.closest('[data-idle-close]')) { closeIdleSheet(); return; }
  const v = e.target.closest('[data-view]');
  if (v) { setView(v.dataset.view); return; }
  const g = e.target.closest('[data-goto]');
  if (g) { select(g.dataset.goto); return; }
  const rb = e.target.closest('[data-rule]');
  if (rb) { decideRule(rb.dataset.rule, rb.dataset.action, rb); return; }
  const rt = e.target.closest('[data-rtab]');
  if (rt) { ui.rulesTab = rt.dataset.rtab; render(); return; }
  const rp = e.target.closest('[data-rep]');
  if (rp) { repeatAction(rp.dataset.rep, rp.dataset.repAct); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { lvCopyText(cp.dataset.copy).then((ok) => { if (!ok) throw new Error('copy'); }).then(() => toast(cp.dataset.copyMsg || `Copied. Paste it into a session's prompt in ${boardTerm()} when you decide.`), () => toast(cp.dataset.copyMsg ? 'Copy did not work. The path is ' + cp.dataset.copy : 'Copy did not work; select the line instead')); return; }
  if (e.target.closest('#memchip, #memchip-m')) { setView('sessions'); return; }
  const ro = e.target.closest('[data-reopen]');
  if (ro) { reopenClosed(ro.dataset.reopen, ro); return; }
  if (e.target.closest('#close-idle')) { closeIdle(); return; }
  if (e.target.closest('[data-closed-all]')) { ui.closedAll = !ui.closedAll; render(); return; }
  const pab = e.target.closest('[data-pas]');
  if (pab) { pasChange(pab.dataset.pid, pab.dataset.pas); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'revive') { revive(a.dataset.pid); return; }
  if (act === 'plan-new') { openPlanSheet(a.dataset.pid); return; }
  if (act === 'plan-open') { openPlanPage(a.dataset.pid); return; }
  if (act === 'plan-change') { openPlanSheet(a.dataset.pid, { change: true }); return; }
  if (act === 'plan-pause' || act === 'plan-stop' || act === 'plan-resume') { planAct(a.dataset.pid, act.slice(5)); return; }
  if (act === 'plan-choice') { const p = project(ui.sel); const c = p && p.planGate && p.planGate.choices[Number(a.dataset.k)]; if (c) planAnswer({ choice: c }); return; }
  if (act === 'rules-more') { ui.rulesMore = !ui.rulesMore; render(); return; }
  if (act === 'write-brief') { openModal({ mode: 'brief', projectId: a.dataset.pid }); return; }
  if (act === 'quick') sendQuick(Number(a.dataset.k));
  if (act === 'open') openInCmux();
  if (act === 'handoff') handoffNow();
  if (act === 'handoff-start') handoffStart();
  if (act === 'session') {
    ui.selSession[ui.sel] = a.dataset.surface;
    // Picked while a new session was starting: theirs, not moved again.
    delete ui.follow[ui.sel];
    // Chose a session that already handed off: keep it chosen.
    const cs = (project(ui.sel) || { sessions: [] }).sessions.find((x) => x.surfaceId === a.dataset.surface);
    if (cs && cs.handed) handedMoved.add(cs.surfaceId);
    render();
  }
  if (act === 'unfile') { const fs = ui.files[ui.sel] || []; fs.splice(Number(a.dataset.k), 1); renderChips(ui.sel); }
  if (act === 'open-folder') openFolder(a.dataset.pid);
});

// The folder path in a project's header: Finder opens it on the Mac.
async function openFolder(pid) {
  try { await post('/api/project/open-folder', { projectId: pid }); } catch (e) { toast(e.message, 4500); }
}

gallery = createGallery({ $, esc, escRaw, post, toast, project, ui, serverNow, phone: LV_PHONE });

// Sessions page: a tick changed.
document.addEventListener('change', (e) => {
  const cb = e.target.closest('[data-tick]');
  if (!cb) return;
  ui.tick[cb.dataset.tick] = cb.checked;
  render();
  const again = document.querySelector(`[data-tick="${CSS.escape(cb.dataset.tick)}"]`);
  if (again) again.focus();
});

// Arrow keys move through the project list.
$('#list').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const rows = Array.from(document.querySelectorAll('#list .row'));
  const i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  select(rows[j].dataset.id);
  const el = document.querySelector(`.row[data-id="${CSS.escape(rows[j].dataset.id)}"]`);
  if (el) el.focus();
});

$('#new-project').addEventListener('click', () => openModal({ mode: 'new' }));
$('#theme').addEventListener('click', () => { const t = ui.theme === 'light' ? 'dark' : 'light'; applyTheme(t); store.set('theme', t); });
$('#alerts').addEventListener('click', async () => {
  if (ui.bellBusy != null) return;
  const on = $('#alerts').getAttribute('aria-pressed') !== 'true';
  ui.bellBusy = on;
  paintBell();
  try {
    const r = await post('/api/alerts/desktop', { enabled: on });
    if (ui.snap) ui.snap.alerts = { ...(ui.snap.alerts || {}), ...r };
    if (pa.status) pa.status = { ...pa.status, desktop: r.desktop };
    toast(on ? 'Mac notifications on. One comes up when a project needs you.' : 'Mac notifications off');
  } catch (e) { toast(e.message); }
  ui.bellBusy = null;
  paintBell();
  if (hs.open) paPaintCard();
});

// ------------------------------------------------------------ phone access
// docs/design/PhoneQR.dc.html, variant A: the phone button (the Mac only)
// drops a card with the QR code a phone scans to open this board.

const PHONE_OFF = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 8.8a14 14 0 0 1 19 0"></path><path d="M5.6 12.1a9.5 9.5 0 0 1 12.8 0"></path><path d="M8.8 15.3a5 5 0 0 1 6.4 0"></path><circle cx="12" cy="18.6" r="0.9" fill="currentColor"></circle><path d="M3.5 3.5l17 17"></path></svg>';
const phoneUi = { open: false, card: null, timer: null, busy: false };

function phonesLine(n) { return `${n} phone${n === 1 ? '' : 's'} signed in`; }

function phoneCardHtml(c) {
  const ok = !!c.address;
  return `<div class="qr-pop" id="phone-pop" role="dialog" aria-label="Open on your phone"><span class="qr-caret" aria-hidden="true"></span>
<div class="qr-head">Open on your phone</div>
<div class="qr-body">
${ok ? `<div class="qr-tile">${c.svg}</div>` : `<div class="qr-tile off">${PHONE_OFF}</div>`}
<div class="qr-line${ok ? '' : ' warn'}">${ok ? 'Scan with your phone on the same Wi-Fi' : 'Not on Wi-Fi, so phones can\'t reach the board'}</div>
<div class="qr-addr mono">${ok ? esc(c.address) + '••••••••' : 'No network address'}</div>
</div>
<div class="qr-foot"><div class="qr-foot-r"><span class="num" id="phone-count" style="flex: 1">${phonesLine(c.phones)}</span><button class="btn sm" id="phone-newkey"${phoneUi.busy ? ' disabled' : ''}>New key</button></div><div class="qr-hint">New key signs every phone out.</div></div>
</div>`;
}

function drawPhoneCard(c) {
  const anchor = $('#phone-anchor');
  const same = phoneUi.card && phoneUi.card.address === c.address && phoneUi.card.svg === c.svg;
  phoneUi.card = c;
  const pop = $('#phone-pop');
  if (pop && same) { $('#phone-count').textContent = phonesLine(c.phones); return; }
  if (pop) pop.remove();
  anchor.insertAdjacentHTML('beforeend', phoneCardHtml(c));
}

async function refreshPhoneCard() {
  try {
    const c = await getJson('/api/phone');
    if (phoneUi.open) drawPhoneCard(c);
  } catch (e) { if (phoneUi.open) { closePhoneCard(); toast(e.message); } }
}

async function openPhoneCard() {
  if (hs.open) closeHs();
  phoneUi.open = true;
  $('#phone').classList.add('open');
  $('#phone').setAttribute('aria-expanded', 'true');
  await refreshPhoneCard();
  // The count follows a phone signing in while the card is open.
  clearInterval(phoneUi.timer);
  phoneUi.timer = setInterval(() => { if (phoneUi.open) refreshPhoneCard(); }, 2000);
}

function closePhoneCard() {
  phoneUi.open = false;
  clearInterval(phoneUi.timer);
  const pop = $('#phone-pop');
  if (pop) pop.remove();
  const b = $('#phone');
  if (b) { b.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); }
}

async function newPhoneKey() {
  phoneUi.busy = true;
  const b = $('#phone-newkey');
  if (b) b.disabled = true;
  try {
    const c = await post('/api/phone/new-key', {});
    phoneUi.card = null;
    if (phoneUi.open) drawPhoneCard(c);
  } catch (e) { toast(e.message); }
  phoneUi.busy = false;
  const b2 = $('#phone-newkey');
  if (b2) b2.disabled = false;
}

$('#phone').addEventListener('click', () => { if (phoneUi.open) closePhoneCard(); else openPhoneCard(); });
document.addEventListener('click', (e) => {
  if (!phoneUi.open) return;
  if (e.target.closest('#phone-newkey')) { newPhoneKey(); return; }
  if (!e.target.closest('#phone-anchor')) closePhoneCard();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && phoneUi.open) { closePhoneCard(); $('#phone').focus(); }
  if (e.key === 'Escape' && ui.idleOpen) closeIdleSheet();
});

// ------------------------------------------------------------ settings
// docs/design/HandoffSettings.dc.html, variant A: the top-bar gear drops a
// card that edits the hand-off settings of every project, plus the on/off
// switch asked for after the mockup, for anyone who wants no hand-off at
// all. Every change saves at once
// through /api/settings/handoff; a failed save says why and puts the
// control back to the stored value.

const HS = { MIN: 10, MAX: 95, GAP: 5, STEP: 5 };
const HS_KEYS = ['handoffEnabled', 'handoffThreshold', 'handoffCeiling', 'contextWindow', 'handoffAutoStart'];
const hs = { open: false, stored: null, cur: null, foot: 'idle', err: '', saving: false, again: false, drag: null, lastTouch: 0 };
const HS_CHECK = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6l4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// The board's hand-off settings, from the live snapshot (defaults until the first one).
function handoffCfg() {
  const s = (ui.snap && ui.snap.settings) || {};
  return {
    enabled: s.handoffEnabled !== false,
    threshold: Number(s.handoffThreshold) || 50,
    ceiling: Number(s.handoffCeiling) || 70,
  };
}

function hsTok(n) { return n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : Math.round(n / 1000) + 'k'; }
const hsUp = (v) => Math.floor(v / HS.STEP) * HS.STEP + HS.STEP;
const hsDown = (v) => Math.ceil(v / HS.STEP) * HS.STEP - HS.STEP;
// Neither value pushes the other: each stops HS.GAP points from the other.
function hsLimits(c) {
  const t = c.handoffThreshold, k = c.handoffCeiling;
  return {
    tMinusOff: hsDown(t) < HS.MIN, tPlusOff: hsUp(t) > k - HS.GAP,
    cMinusOff: hsDown(k) < t + HS.GAP, cPlusOff: hsUp(k) > HS.MAX,
  };
}

function hsStep(k, label) {
  return `<span class="hs-step" role="group" aria-label="${label}"><button class="hs-sb" data-hs="${k}-" aria-label="Lower the ${label}">&#8722;</button><span class="hs-sv num" id="hs-${k}-v"></span><button class="hs-sb" data-hs="${k}+" aria-label="Raise the ${label}">+</button></span>`;
}
function hsSwitch(id) {
  return `<button class="hs-sw" role="switch" id="${id}" aria-labelledby="${id}-l" aria-checked="false"><span></span></button>`;
}

// docs/design/CodexStage2.dc.html, section 3, variant A: an Assistant
// section first, "Start new sessions with" and a two-way switch (short
// labels, Claude and Codex, so it takes less space), saved through
// /api/settings/assistant.
const AS_HINT = 'New project, New session and Revive start it; Plans and Ideas run on it. A project set to the other one, and work carried on (a hand-off, Revive), keep theirs.';
const asView = () => (ui.snap && ui.snap.assistants) || { startWith: 'claude' };
// Who a line names: the assistant Plans, Ideas and rule suggestions run on
// (assistants.print), the one a running job started on (its `who`; none was
// Claude), and a project's own (the one its next session starts).
const printWho = () => (asView().print === 'codex' ? 'Codex' : 'Claude');
const jobWho = (j) => (j && j.who === 'codex' ? 'Codex' : 'Claude');
const projWho = (p) => (p && p.assistant === 'codex' ? 'Codex' : 'Claude');

// A project's own assistant for its NEW sessions (docs/design/
// ProjectAssistant.dc.html, round 2, A1): "New sessions:" and the Settings
// switch at the end of the sheet's meta line, saved at once through POST
// /api/project/assistant. The next New session, Revive and plan start use
// it; running sessions keep theirs. It shows what the project is set to
// (its own, else Settings, never its newest session's), even when the board
// starts the other one because that one is not installed (its note is the
// title). A flip shows at once; a failed save snaps back with the error
// beside the switch. ui.pas: { pid, want, until } while a flip waits for
// the board's state to agree, { pid, err, until } after a failure.
const pasSet = (p) => asKind(p.assistantWants || p.assistant || asView().startWith);
const pasNow = (pid) => (ui.pas && ui.pas.pid === pid && Date.now() < ui.pas.until ? ui.pas : null);
function pasHtml(p) {
  const pa = pasNow(p.id);
  const on = pa && pa.want ? pa.want : pasSet(p);
  const tip = `The assistant ${p.name}'s new sessions start with (New session, Revive, a plan's start). Running sessions keep theirs.${!pa && p.assistantNote ? ' ' + p.assistantNote : ''}`;
  const btn = (k) => `<button type="button" class="seg ${on === k ? 'on' : ''}" data-pas="${k}" data-pid="${escRaw(p.id)}" aria-pressed="${on === k}">${AS_WORD[k]}</button>`;
  return `<span class="pas-meta" title="${esc(tip)}"><span id="pas-l">New sessions:</span><span class="hs-seg" role="group" aria-labelledby="pas-l">${btn('claude')}${btn('codex')}</span></span>${pa && pa.err ? `<span class="pas-err" role="alert">${esc(pa.err)}</span>` : ''}`;
}

async function pasChange(pid, kind) {
  const p = project(pid);
  const pa = pasNow(pid);
  if (!p || (pa && pa.saving)) return;
  if ((pa && pa.want ? pa.want : pasSet(p)) === kind) return;
  ui.pas = { pid, want: kind, saving: true, until: Date.now() + 15000 };
  render();
  try {
    const r = await post('/api/project/assistant', { projectId: pid, assistant: kind });
    // The board's next state carries it too; until then this copy does.
    const q = project(pid);
    if (q) Object.assign(q, { assistantWants: kind, assistant: r.starts || q.assistant, assistantNote: r.note || null });
    ui.pas = { pid, want: kind, until: Date.now() + 4000 };
  } catch (e) {
    ui.pas = { pid, err: `Not saved: ${/\.$/.test(e.message) ? e.message : e.message + '.'}`, until: Date.now() + 8000 };
    setTimeout(() => { if (ui.pas && ui.pas.err && Date.now() >= ui.pas.until) { ui.pas = null; render(); } }, 8100);
  }
  render();
}

function asHtml() {
  return `<div class="hs-sec">Assistant<span>every project</span></div>
<div class="hs-row" style="padding-top: 0"><div class="hs-l"><div id="as-l">Start new sessions with</div><div class="hs-tok">${AS_HINT}</div></div></div>
<div class="as-sw"><span class="hs-seg" role="group" aria-labelledby="as-l"><button class="seg" data-as="claude" aria-pressed="false">Claude</button><button class="seg" data-as="codex" aria-pressed="false">Codex</button></span></div>
<div class="hs-tok as-note" id="as-note" hidden></div>
<div class="as-div"></div>`;
}

function asPaint() {
  const v = asView();
  for (const b of document.querySelectorAll('#hs-pop [data-as]')) {
    const on = b.dataset.as === (v.startWith === 'codex' ? 'codex' : 'claude');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  // The chosen one not installed: the board starts the other, and says so.
  const n = $('#as-note');
  if (n) { n.hidden = !v.fallback; n.textContent = v.fallback ? v.note : ''; }
}

async function asChange(kind) {
  if (asView().startWith === kind || hs.asSaving) return;
  hs.asSaving = true;
  try {
    const r = await post('/api/settings/assistant', { startWith: kind });
    if (ui.snap) ui.snap.assistants = { ...(ui.snap.assistants || {}), ...r };
    hs.foot = 'saved-as';
  } catch (e) {
    hs.foot = 'error';
    hs.err = /\.$/.test(e.message) ? e.message : e.message + '.';
  }
  hs.asSaving = false;
  hsPaint();
  asPaint();
}

function hsHtml() {
  return `<div class="hs-pop" id="hs-pop" role="dialog" aria-label="Settings"><span class="hs-caret" aria-hidden="true"></span>
<div class="hs-head">Settings</div>
<div class="hs-body">
${asHtml()}
<div class="hs-sec">Hand-off<span>every project</span></div>
<div class="hs-row on-row"><div class="hs-l"><div id="hs-on-l">Hand off automatically</div><div class="hs-tok" id="hs-on-sub"></div></div>${hsSwitch('hs-on')}</div>
<div class="hs-auto" id="hs-auto">
<div class="hs-track" id="hs-track"><div class="hs-z1" id="hs-z1"></div><div class="hs-z2" id="hs-z2"></div><span class="hs-th t" data-th="t" role="slider" tabindex="0" aria-label="Clean-point line" aria-valuemin="${HS.MIN}" aria-valuemax="${HS.MAX}"></span><span class="hs-th c" data-th="c" role="slider" tabindex="0" aria-label="Ceiling" aria-valuemin="${HS.MIN}" aria-valuemax="${HS.MAX}"></span></div>
<div class="hs-scale num"><span>0</span><span id="hs-wl"></span></div>
<div class="hs-row"><i class="hs-dot t"></i><div class="hs-l"><div>Hand off at a clean point</div><div class="hs-tok num" id="hs-t-tok"></div></div>${hsStep('t', 'clean-point line')}</div>
<div class="hs-row"><i class="hs-dot c"></i><div class="hs-l"><div>Hand off now, even mid-task</div><div class="hs-tok num" id="hs-c-tok"></div></div>${hsStep('c', 'ceiling')}</div>
<div class="hs-hint" id="hs-hint" hidden>The ceiling stays at least ${HS.GAP} points above the <span style="white-space: nowrap">clean-point line</span>.</div>
</div>
<div class="hs-row sep"><div class="hs-l"><div id="hs-w-l">Context window</div></div><span class="hs-seg" role="group" aria-labelledby="hs-w-l"><button class="seg" data-hs="w200">200k</button><button class="seg" data-hs="w1m">1M</button></span></div>
<div class="hs-row"><div class="hs-l"><div id="hs-fresh-l">Open a fresh session after a hand-off</div><div class="hs-tok">It reads the hand-off and carries on</div></div>${hsSwitch('hs-fresh')}</div>
${paCardHtml()}
${prCardHtml()}
</div>
<div class="hs-foot" id="hs-foot" role="status"></div>
</div>`;
}

// Draws hs.cur into the open card. Called on every change, mid-drag too, so
// it only sets properties and never rebuilds the card under a pointer.
function hsPaint() {
  const pop = $('#hs-pop');
  if (!pop || !hs.cur) return;
  const c = hs.cur, on = c.handoffEnabled, t = c.handoffThreshold, k = c.handoffCeiling, w = c.contextWindow;
  const L = hsLimits(c);
  const sw = (id, v) => { const b = $('#' + id); b.classList.toggle('on', v); b.setAttribute('aria-checked', String(v)); };
  sw('hs-on', on);
  $('#hs-on-sub').textContent = on ? 'Asks a session to hand off past the line below.' : 'Off. No session is asked to hand off. Hand off now still works.';
  $('#hs-auto').classList.toggle('off', !on);
  $('#hs-z1').style.left = t + '%'; $('#hs-z1').style.width = (k - t) + '%';
  $('#hs-z2').style.left = k + '%'; $('#hs-z2').style.width = (100 - k) + '%';
  for (const [key, v, label] of [['t', t, 'clean-point line'], ['c', k, 'ceiling']]) {
    const th = $(`.hs-th[data-th="${key}"]`);
    th.style.left = v + '%';
    th.setAttribute('aria-valuenow', String(v));
    th.setAttribute('aria-valuetext', `${v}%, past ${hsTok(w * v / 100)} of ${hsTok(w)} tokens`);
    th.tabIndex = on ? 0 : -1;
    $(`#hs-${key}-v`).textContent = v + '%';
    $(`#hs-${key}-tok`).textContent = `past ${hsTok(w * v / 100)} of ${hsTok(w)} tokens`;
  }
  $('#hs-wl').textContent = hsTok(w);
  const dis = { 't-': L.tMinusOff, 't+': L.tPlusOff, 'c-': L.cMinusOff, 'c+': L.cPlusOff };
  for (const b of pop.querySelectorAll('.hs-sb')) b.disabled = !on || dis[b.dataset.hs];
  $('#hs-hint').hidden = !on || !(L.tPlusOff || L.cMinusOff);
  for (const b of pop.querySelectorAll('.hs-seg .seg[data-hs]')) {
    const sel = (b.dataset.hs === 'w200' && w === 200000) || (b.dataset.hs === 'w1m' && w === 1000000);
    b.classList.toggle('on', sel);
    b.setAttribute('aria-pressed', String(sel));
  }
  sw('hs-fresh', c.handoffAutoStart);
  const f = $('#hs-foot');
  f.className = 'hs-foot' + (hs.foot === 'saved' || hs.foot === 'saved-as' ? ' ok' : hs.foot === 'error' ? ' bad' : '');
  if (hs.foot === 'saved') f.innerHTML = HS_CHECK + 'Saved. Applies at each session\'s next stop.';
  else if (hs.foot === 'saved-as') f.innerHTML = HS_CHECK + `Saved. New sessions start with ${AS_NAME[asView().startWith] || 'Claude Code'}.`;
  else if (hs.foot === 'error') f.textContent = 'Not saved: ' + hs.err;
  else f.textContent = 'Applies to every project. Saves as you change it.';
}

// Under the gear, kept 16px inside the board, the caret on the gear's
// centre; on a phone it spans the width with 16px margins.
function placeHs() {
  const pop = $('#hs-pop');
  if (!pop) return;
  const mc = $('#mc'), m = mc.getBoundingClientRect(), r = $('#gear').getBoundingClientRect();
  const W = mc.clientWidth, cx = r.left + r.width / 2 - m.left;
  let left;
  if (matchMedia('(max-width: 700px)').matches) { left = 16; pop.style.width = (W - 32) + 'px'; }
  else { pop.style.width = ''; left = Math.max(16, Math.min(W - pop.offsetWidth - 16, cx - pop.offsetWidth / 2)); }
  pop.style.left = left + 'px';
  pop.style.top = (r.bottom - m.top + 10) + 'px';
  pop.querySelector('.hs-caret').style.left = (cx - left) + 'px';
}

async function openHs() {
  if (phoneUi.open) closePhoneCard();
  hs.open = true;
  hs.foot = 'idle';
  const g = $('#gear');
  g.classList.add('open');
  g.setAttribute('aria-expanded', 'true');
  let st = null;
  try { st = (await getJson('/api/settings/handoff')).settings; } catch (e) {
    const s = (ui.snap && ui.snap.settings) || null;
    if (!s) { closeHs(); toast(e.message); return; }
    st = s;
  }
  if (!hs.open) return;
  hs.stored = Object.fromEntries(HS_KEYS.map((k) => [k, st[k]]));
  hs.cur = { ...hs.stored };
  const old = $('#hs-pop');
  if (old) old.remove();
  $('#mc').insertAdjacentHTML('beforeend', hsHtml());
  wireHs();
  hsPaint();
  asPaint();
  asRefresh();
  paPaintCard();
  pr.saved = false;
  pr.err = '';
  prPaint();
  placeHs();
  paRefresh();
  prRefresh();
}

// The assistant settings fresh from the board (the snapshot may be a tick old).
async function asRefresh() {
  try {
    const r = await getJson('/api/settings/assistant');
    if (ui.snap) ui.snap.assistants = { ...(ui.snap.assistants || {}), ...r };
    if (hs.open) asPaint();
  } catch { /* the snapshot's copy stays */ }
}

function closeHs() {
  hs.open = false;
  hs.drag = null;
  const pop = $('#hs-pop');
  if (pop) pop.remove();
  const g = $('#gear');
  if (g) { g.classList.remove('open'); g.setAttribute('aria-expanded', 'false'); }
}

function hsChange(patch) {
  Object.assign(hs.cur, patch);
  hsPaint();
  hsSave();
}

// One save at a time; changes made meanwhile go in the next. Only the keys
// that differ from the stored values are sent.
async function hsSave() {
  if (hs.saving) { hs.again = true; return; }
  const diff = {};
  for (const k of HS_KEYS) if (hs.cur[k] !== hs.stored[k]) diff[k] = hs.cur[k];
  if (!Object.keys(diff).length) return;
  hs.saving = true;
  try {
    const r = await post('/api/settings/handoff', diff);
    hs.stored = Object.fromEntries(HS_KEYS.map((k) => [k, r.settings[k]]));
    hs.foot = 'saved';
    if (ui.snap) { ui.snap.settings = { ...(ui.snap.settings || {}), ...r.settings }; render(); }
  } catch (e) {
    hs.cur = { ...hs.stored };
    hs.again = false;
    hs.foot = 'error';
    hs.err = /\.$/.test(e.message) ? e.message : e.message + '.';
  }
  hs.saving = false;
  if (hs.again) { hs.again = false; return hsSave(); }
  hsPaint();
}

// The value a thumb at clientX would take, held inside its limits.
function hsValueAt(key, clientX) {
  const r = $('#hs-track').getBoundingClientRect();
  let v = Math.round(((clientX - r.left) / r.width) * 100 / HS.STEP) * HS.STEP;
  if (key === 't') v = Math.max(HS.MIN, Math.min(hs.cur.handoffCeiling - HS.GAP, v));
  else v = Math.min(HS.MAX, Math.max(hs.cur.handoffThreshold + HS.GAP, v));
  return v;
}

function wireHs() {
  const pop = $('#hs-pop');
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !hs.cur) return;
    if (b.id === 'pa-on' || b.dataset.pa) return paCardClick(b);
    if (b.dataset.pr) return prChange();
    if (b.dataset.as) return asChange(b.dataset.as);
    const c = hs.cur;
    if (b.id === 'hs-on') return hsChange({ handoffEnabled: !c.handoffEnabled });
    if (b.id === 'hs-fresh') return hsChange({ handoffAutoStart: !c.handoffAutoStart });
    const a = b.dataset.hs;
    if (a === 't-') hsChange({ handoffThreshold: hsDown(c.handoffThreshold) });
    else if (a === 't+') hsChange({ handoffThreshold: hsUp(c.handoffThreshold) });
    else if (a === 'c-') hsChange({ handoffCeiling: hsDown(c.handoffCeiling) });
    else if (a === 'c+') hsChange({ handoffCeiling: hsUp(c.handoffCeiling) });
    else if (a === 'w200') hsChange({ contextWindow: 200000 });
    else if (a === 'w1m') hsChange({ contextWindow: 1000000 });
  });
  // The thumbs: pointer events with capture, one pointer per thumb, and the
  // synthetic mouse events iOS replays after a touch ignored.
  const ghost = (e) => e.pointerType === 'mouse' && performance.now() - hs.lastTouch < 800;
  for (const th of pop.querySelectorAll('.hs-th')) {
    const key = th.dataset.th, field = key === 't' ? 'handoffThreshold' : 'handoffCeiling';
    th.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') hs.lastTouch = performance.now();
      if (ghost(e) || hs.drag || !hs.cur.handoffEnabled) return;
      e.preventDefault();
      th.setPointerCapture(e.pointerId);
      th.classList.add('drag');
      hs.drag = { id: e.pointerId, key, from: hs.cur[field] };
    });
    th.addEventListener('pointermove', (e) => {
      if (!hs.drag || hs.drag.id !== e.pointerId) return;
      if (e.pointerType === 'touch') hs.lastTouch = performance.now();
      e.preventDefault();
      const v = hsValueAt(key, e.clientX);
      if (v !== hs.cur[field]) { hs.cur[field] = v; hsPaint(); }
    });
    const end = (e) => {
      if (!hs.drag || hs.drag.id !== e.pointerId) return;
      if (e.pointerType === 'touch') hs.lastTouch = performance.now();
      th.classList.remove('drag');
      const moved = hs.cur[field] !== hs.drag.from;
      hs.drag = null;
      if (moved) hsSave();
    };
    th.addEventListener('pointerup', end);
    th.addEventListener('pointercancel', end);
    th.addEventListener('lostpointercapture', end);
    th.addEventListener('keydown', (e) => {
      if (!hs.cur.handoffEnabled) return;
      const L = hsLimits(hs.cur);
      const down = ['ArrowLeft', 'ArrowDown'].includes(e.key), up = ['ArrowRight', 'ArrowUp'].includes(e.key);
      if (!down && !up) return;
      e.preventDefault();
      const off = key === 't' ? (down ? L.tMinusOff : L.tPlusOff) : (down ? L.cMinusOff : L.cPlusOff);
      if (!off) hsChange({ [field]: down ? hsDown(hs.cur[field]) : hsUp(hs.cur[field]) });
    });
  }
}

$('#gear').addEventListener('click', () => { if (hs.open) closeHs(); else openHs(); });
document.addEventListener('click', (e) => {
  if (!hs.open || hs.drag) return;
  // The path as it was when the click started: a button the card redrew
  // while handling this click (Change) is detached by now, and
  // e.target.closest() would see it as outside the card.
  if (!e.composedPath().some((n) => n.id === 'hs-pop' || n.id === 'gear')) closeHs();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && hs.open) { closeHs(); $('#gear').focus(); }
});
window.addEventListener('resize', () => { if (hs.open) placeHs(); });

// ------------------------------------------------------------ where new projects go
// docs/design/ProjectsRoot.dc.html: a "Projects, this Mac" section at the
// foot of the Settings card ("New projects go in", the path, Change through
// Finder's own dialog on the Mac, read-only on a phone, locked when
// MC_PROJECTS_ROOT set it), and the one-time "Where do your projects live?"
// question on the Mac when the board has nothing to go on.
// server/projectsroot.mjs decides the folder; the page only shows it.

const pr = { view: null, saved: false, waiting: false, err: '', first: { open: false, waiting: false, err: '', answered: false } };
const PR_LOCK = `<span class="pr-lock" title="Set by MC_PROJECTS_ROOT">${'<svg width="11" height="12" viewBox="0 0 11 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.5" y="5.2" width="8" height="5.8" rx="1.4"></rect><path d="M3.3 5.2V3.6a2.2 2.2 0 0 1 4.4 0v1.6"></path></svg>'}</span>`;

function prCardHtml() {
  return `<div class="hs-row sep pa-top"><div class="hs-l"><div class="hs-sec" style="padding: 0 0 6px">Projects<span>this Mac</span></div></div></div>
<div class="pr-lbl" id="pr-l">New projects go in</div>
<div id="pr-body"></div>`;
}

function prView() { return pr.view || (ui.snap && ui.snap.projectsRoot) || null; }

// The line under the path: where the folder came from, or what is happening.
function prLine(v) {
  if (v.locked) return 'Set by MC_PROJECTS_ROOT when the board started.';
  if (v.from === 'chosen') return 'Projects already on the board stay where they are.';
  if (v.from === 'shared') return v.total === 1 ? 'Picked from where your one project lives. Existing folders can be anywhere.' : `Picked from where ${v.count} of your ${v.total} projects live. Existing folders can be anywhere.`;
  if (v.from === 'first-run') return 'Picked when the board first asked. Existing folders can be anywhere.';
  if (v.ask) return 'Not picked yet, so new projects go here. Existing folders can be anywhere.';
  return 'Set in projects.json. Existing folders can be anywhere.';
}

function prPaint() {
  const el = $('#pr-body');
  if (!el) return;
  const v = prView();
  if (!v) { el.innerHTML = '<div class="hs-tok pr-tok">Loading</div>'; return; }
  const mac = canChoose();
  const ro = !mac || v.locked;
  const tail = v.locked ? PR_LOCK : pr.saved && mac ? `<span class="pa-ok">${HS_CHECK}Saved</span>` : '';
  const field = `<div class="pa-field mono pr-field${ro ? ' ro' : ''}" aria-labelledby="pr-l" title="${escRaw(v.path)}">${FOLDER_ICON}<span class="pa-val pr-val">${esc(v.path)}</span>${tail}</div>`;
  if (!mac) {
    el.innerHTML = `<div class="pa-frow pr-frow">${field}</div>`
      + (v.locked ? `<div class="hs-tok pr-tok">${esc(prLine(v))}</div>` : `<div class="pa-note pr-note">${PA_DESK}<span>Change it on the Mac. The folder dialog opens there.</span></div>`);
    return;
  }
  const line = pr.err || (pr.waiting ? 'Waiting for Finder\'s folder dialog on this Mac.' : prLine(v));
  el.innerHTML = `<div class="pa-frow pr-frow">${field}<button class="btn sm" data-pr="change"${v.locked || pr.waiting ? ' disabled' : ''}>Change</button></div>
<div class="hs-tok pr-tok${pr.err ? ' pa-bad' : ''}" role="status">${esc(line)}</div>`;
}

async function prRefresh() {
  try { const j = await getJson('/api/settings/projects-root'); pr.view = j; if (!pr.waiting) prPaint(); } catch { /* the snapshot's copy stands */ }
}

// Finder's dialog through the same endpoint as New project's Choose…, then
// the folder it returned saved as the setting. Returns the saved view, null
// when cancelled; throws with the reason.
async function prPickAndSave(from) {
  const r = await post('/api/project/choose-folder', { purpose: 'root' });
  if (r.cancelled || !r.entry) return null;
  return post('/api/settings/projects-root', { path: r.entry.folder, from });
}

async function prChange() {
  if (pr.waiting) return;
  pr.waiting = true;
  pr.err = '';
  pr.saved = false;
  prPaint();
  try {
    const v = await prPickAndSave('chosen');
    if (v) { pr.view = v; pr.saved = true; }
  } catch (e) { pr.err = 'Not saved: ' + (/\.$/.test(e.message) ? e.message : e.message + '.'); }
  pr.waiting = false;
  prPaint();
}

// ---- the first-run question: on the Mac, only while nothing is set.

function prFirstRun() {
  const v = prView();
  const f = pr.first;
  const want = !!(v && v.ask && v.suggestion && canChoose() && !f.answered);
  if (want && !f.open) { f.open = true; prDrawFirst(); }
  else if (!want && f.open && !f.waiting) prCloseFirst();
}

function prDrawFirst() {
  const v = prView();
  const f = pr.first;
  if (!v || !v.suggestion) return;
  const s = v.suggestion;
  let root = $('#pr-first-root');
  if (!root) { root = document.createElement('div'); root.id = 'pr-first-root'; $('#mc').appendChild(root); }
  root.innerHTML = `<div class="modal-back pa-back" id="pr-back"><div class="modal pa-sheet pr-first" role="dialog" aria-modal="true" aria-labelledby="pr-h" tabindex="-1">
<div class="pa-sh-h"><h2 id="pr-h">Where do your projects live?</h2><button class="x-btn" data-prf="close" aria-label="Close">${X_ICON}</button></div>
<div class="pa-sh-b"><div class="pr-lead t2">New projects get their own folder in here. A project can still use any folder you already have.</div>
<div class="pa-field mono pr-field big">${FOLDER_ICON}<span class="pa-val pr-val">${esc(s.path)}</span><span class="pr-tag">${s.exists ? 'Found on this Mac' : 'Made when you need it'}</span></div>${f.err ? `<div class="pa-res bad">${esc(f.err)}</div>` : ''}</div>
<div class="pa-sh-f"><span class="t3 pr-later">${f.waiting ? 'Waiting for Finder\'s folder dialog on this Mac.' : 'You can change it later in Settings.'}</span><button class="btn" data-prf="choose"${f.waiting ? ' disabled' : ''}>Choose…</button><button class="btn pri" data-prf="use"${f.waiting ? ' disabled' : ''}>Use this</button></div>
</div></div>`;
  root.querySelector('#pr-back').addEventListener('click', prFirstClick);
  root.querySelector('#pr-back').addEventListener('keydown', (e) => { if (e.key === 'Escape') prFirstAnswer('use'); });
  // Focus the dialog itself, so Escape and Tab work without a ring on Use this.
  if (!f.waiting) setTimeout(() => { const d = root.querySelector('.pr-first'); if (d) d.focus({ preventScroll: true }); }, 0);
}

function prCloseFirst() {
  pr.first.open = false;
  const el = $('#pr-first-root');
  if (el) el.remove();
}

function prFirstClick(e) {
  const b = e.target.closest('[data-prf]');
  if (!b || b.disabled) return;
  // Closing keeps the suggestion, as Use this does.
  prFirstAnswer(b.dataset.prf === 'choose' ? 'choose' : 'use');
}

async function prFirstAnswer(how) {
  const f = pr.first;
  const v = prView();
  if (f.waiting || !v || !v.suggestion) return;
  f.err = '';
  if (how === 'choose') { f.waiting = true; prDrawFirst(); }
  try {
    const saved = how === 'choose' ? await prPickAndSave('first-run') : await post('/api/settings/projects-root', { path: v.suggestion.path, from: 'first-run' });
    f.waiting = false;
    if (!saved) { prDrawFirst(); return; }
    pr.view = saved;
    f.answered = true;
    prCloseFirst();
    toast(`New projects go in ${saved.path}. Change it in Settings.`);
  } catch (e) {
    f.waiting = false;
    f.err = 'Not saved: ' + e.message;
    prDrawFirst();
  }
}

// ------------------------------------------------------------ phone alerts
// docs/design/PhoneAlerts.dc.html, variant B: the card gets a switch, one
// status line and Set up (or Change and Send a test); Set up opens a sheet,
// centred on a desktop and rising from the bottom on a phone, with the
// channel picker, each channel's steps, Send a test, the privacy line and
// Done (blue once a test has gone through). Secrets never reach this page:
// the sheet shows them masked, and a phone gets a 403 for the sheet's data
// and says so. server/alerts.mjs and server/channels.mjs do the work.

const PA_TABS = [['telegram', 'Telegram'], ['webhook', 'Discord or Slack'], ['ntfy', 'ntfy']];
const pa = {
  status: null, sheet: false, fromCard: false, tab: 'telegram', view: null, refused: null, loading: false,
  edit: { telegram: false, webhook: false }, msg: {}, busy: {}, test: { state: 'idle', text: '' }, testOk: false,
  card: { state: 'idle', text: '' },
};
const PA_DESK = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1" y="2" width="10" height="6.6" rx="1.2"></rect><path d="M4 10.5h4"></path></svg>';
const PA_LOCK = '<svg width="11" height="12" viewBox="0 0 11 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.5" y="5.2" width="8" height="5.8" rx="1.4"></rect><path d="M3.3 5.2V3.6a2.2 2.2 0 0 1 4.4 0v1.6"></path></svg>';
const paPhone = () => matchMedia('(max-width: 700px)').matches;

function paCardHtml() {
  return `<div class="hs-row sep pa-top"><div class="hs-l"><div class="hs-sec" style="padding: 0 0 6px">Phone alerts<span>this board</span></div></div></div>
<div class="hs-row on-row"><div class="hs-l"><div id="pa-on-l">Alert my phone when a project needs me</div><div class="hs-tok" id="pa-status" role="status"></div></div>${hsSwitch('pa-on')}</div>
<div class="pa-btns" id="pa-btns"></div>
<div class="pa-note">${PA_DESK}<span id="pa-desk"></span></div>`;
}

function paStatus() { return pa.status || (ui.snap && ui.snap.alerts) || null; }
const paNow = () => Date.now() - (ui.skew || 0);

function paResHtml(r) {
  if (!r || r.state === 'idle') return r && r.text ? `<span class="pa-res t3">${esc(r.text)}</span>` : '';
  if (r.state === 'sending') return '<span class="pa-res t3">Sending</span>';
  if (r.state === 'ok') return `<span class="pa-res ok">${HS_CHECK}${esc(r.text)}</span>`;
  return `<span class="pa-res bad">${esc(r.text)}</span>`;
}

// The card's three rows from the status the server pushes.
function paPaintCard() {
  const el = $('#pa-status');
  if (!el) return;
  const s = paStatus() || { enabled: false, configured: false };
  const b = $('#pa-on');
  b.classList.toggle('on', !!s.enabled);
  b.setAttribute('aria-checked', String(!!s.enabled));
  const last = s.last;
  el.className = 'hs-tok';
  if (!s.configured) el.textContent = 'Not set up';
  else if (s.enabled && last && !last.ok) {
    el.className = 'hs-tok pa-bad';
    el.textContent = `Last alert failed: ${last.error || 'no answer'}${last.retrying ? '. Trying again in 30 s' : ''}`;
  } else if (s.enabled) {
    el.className = 'hs-tok pa-on';
    const when = last ? (rel(new Date(last.at), paNow()) === 'now' ? 'Last alert just now' : `Last alert ${rel(new Date(last.at), paNow())} ago`) : 'No alert yet';
    el.innerHTML = `<i class="pa-live"></i>${esc(`On, ${s.channelLabel}. ${when}`)}`;
  } else el.textContent = `Off. ${s.channelLabel} is set up`;
  // The bell's own line: Mac notifications, separate from the phone.
  const dk = s.desktop || { enabled: true };
  const dl = dk.last;
  $('#pa-desk').textContent = dk.enabled && dl && !dl.ok ? `The bell also sends these as Mac notifications. The last one failed: ${dl.error || 'no answer'}.`
    : `The bell also sends these as Mac notifications. ${dk.enabled ? 'On now.' : 'Off now.'}`;
  $('#pa-desk').classList.toggle('pa-bad', !!(dk.enabled && dl && !dl.ok));
  $('#pa-btns').innerHTML = s.configured
    ? `<button class="btn sm" data-pa="setup">Change</button><button class="btn sm" data-pa="card-test"${pa.card.state === 'sending' ? ' disabled' : ''}>Send a test</button>${paResHtml(pa.card)}`
    : '<button class="btn sm" data-pa="setup">Set up</button>';
}

async function paRefresh() {
  try { pa.status = await getJson('/api/alerts'); paPaintCard(); } catch { /* the snapshot's copy stands */ }
}

async function paCardClick(b) {
  const s = paStatus() || {};
  if (b.id === 'pa-on') {
    if (!s.configured) return paOpen(true);
    const on = !s.enabled;
    pa.status = { ...s, enabled: on };
    paPaintCard();
    try { pa.status = await post('/api/alerts/switch', { enabled: on }); } catch (e) { pa.status = { ...s }; toast(e.message); }
    return paPaintCard();
  }
  if (b.dataset.pa === 'setup') return paOpen(true);
  if (b.dataset.pa === 'card-test') {
    pa.card = { state: 'sending' };
    paPaintCard();
    try { await post('/api/alerts/test', {}); pa.card = { state: 'ok', text: 'Sent. Check your phone.' }; } catch (e) { pa.card = { state: 'bad', text: 'Not sent: ' + e.message }; }
    paPaintCard();
  }
}

// ---- the sheet

async function paOpen(fromCard) {
  pa.fromCard = !!fromCard;
  if (hs.open) closeHs();
  pa.sheet = true;
  pa.test = { state: 'idle', text: '' };
  pa.testOk = false;
  pa.msg = {};
  pa.edit = { telegram: false, webhook: false };
  pa.loading = true;
  paDrawSheet();
  await paLoad(true);
}

async function paLoad(first) {
  try {
    const r = await fetch('/api/alerts/setup');
    if (r.status === 401) signedOut();
    const j = await r.json().catch(() => ({}));
    if (r.status === 403) { pa.refused = j.error || 'Set this up on the Mac.'; pa.view = null; }
    else if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    else {
      pa.refused = null;
      pa.view = j;
      pa.status = { enabled: j.enabled, configured: j.configured, channel: j.channel, channelLabel: j.channelLabel, last: j.last };
      if (first) pa.tab = j.channel || 'telegram';
    }
  } catch (e) { pa.refused = null; pa.view = null; pa.msg.load = e.message; }
  pa.loading = false;
  if (pa.sheet) paDrawSheet();
}

function paClose() {
  pa.sheet = false;
  const el = $('#pa-root');
  if (el) el.remove();
  // After this click is done, or the document's outside-click rule would
  // close the card again at once.
  if (pa.fromCard) setTimeout(openHs, 0);
}

const paErr = (k) => (pa.msg[k] ? `<div class="pa-res bad">${esc(pa.msg[k])}</div>` : '');
const paSaved = (val, link, act, extra = '') => `<div class="pa-frow"><div class="pa-field saved ${extra}"><span class="pa-val">${val}</span><span class="pa-ok">${HS_CHECK}Saved</span></div><button class="pa-link" data-pa="${act}">${link}</button></div>`;
const paInput = (id, ph, act, label) => `<div class="pa-frow"><input class="field pa-in mono" id="${id}" placeholder="${ph}" aria-label="${label}" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn sm" data-pa="${act}"${pa.busy[act] ? ' disabled' : ''}>Save</button></div>`;
const paStep = (n, title, body) => `<div class="pa-step"><span class="pa-n num">${n}</span><div class="pa-sb"><div>${title}</div>${body}</div></div>`;

function paSteps() {
  const v = pa.view;
  if (pa.tab === 'telegram') {
    const t = v.telegram;
    const tokenSaved = t.token && !pa.edit.telegram;
    const s1 = (tokenSaved ? paSaved(esc(t.token), 'Replace', 'tg-replace', 'mono') : paInput('pa-tg-token', '123456789:AAH...', 'tg-save', 'Bot token')
      + '<div class="pa-help">Send it /newbot and pick a name; it answers with the token.</div>') + paErr('tg');
    const s2 = (t.chat ? paSaved(`Chat found <span class="t3 mono">${esc(t.chat)}</span>`, 'Find again', 'tg-find')
      : `<div class="pa-frow"><button class="btn sm" data-pa="tg-find"${!t.token || pa.busy['tg-find'] ? ' disabled' : ''}>Find my chat</button></div>`) + paErr('chat');
    return paStep(1, 'Message <b class="pa-at">@BotFather</b>, paste the token', s1) + paStep(2, 'Send your bot a message, then Find my chat', s2);
  }
  if (pa.tab === 'webhook') {
    const w = v.webhook;
    const saved = w.url && !pa.edit.webhook;
    const s1 = (saved ? paSaved(esc(w.url), 'Replace', 'wh-replace', 'mono') : paInput('pa-wh-url', 'https://discord.com/api/webhooks/...', 'wh-save', 'Webhook URL')) + paErr('wh')
      + '<div class="pa-help">Discord: channel settings, Integrations, Webhooks, Copy URL. Slack: add the Incoming Webhooks app to a channel.</div>';
    return paStep(1, 'Paste a webhook URL', s1);
  }
  const n = v.ntfy;
  const s2 = `<div class="qr-tile pa-qr-tile">${n.qr}</div>
<div class="pa-topic"><span class="mono t3 pa-tv">${esc(n.topic)}</span><button class="pa-link" data-pa="nt-new">New topic</button></div>${paErr('nt')}
<div class="pa-help">On Android, ntfy opens on the topic and subscribes by itself.</div>
<div class="pa-help">On an iPhone, ntfy opens no codes: <button class="pa-link pa-inline" data-pa="nt-copy">Copy topic</button>, then in ntfy tap +, paste it and Subscribe.${pa.msg.copied ? ` <span class="pa-ok">${HS_CHECK}Copied</span>` : ''}</div>
<div class="pa-help">If the topic leaks, New topic cuts off every phone on the old one.</div>`;
  return paStep(1, 'Install ntfy (Android or iPhone)', '<div class="pa-help">From Google Play, F-Droid or the App Store.</div>') + paStep(2, 'Scan this code with the camera', s2);
}

function paSheetHtml() {
  const lead = '<div class="pa-help pa-lead">When a project starts needing you: a question, a hand-back, or a permission prompt.</div>';
  const privacy = `<div class="pa-note">${PA_LOCK}<span>Alerts say only which project needs you and why, never the session's text.</span></div>`;
  const ready = pa.view && pa.view.ready && pa.view.ready[pa.tab];
  const idle = !pa.refused && pa.tab === 'ntfy' && pa.test.state === 'idle' ? { state: 'idle', text: 'Subscribed? Send one to check.' } : pa.test;
  const test = `<div class="pa-test"><button class="btn sm" data-pa="test"${pa.test.state === 'sending' || (!pa.refused && !ready) ? ' disabled' : ''}>Send a test</button>${paResHtml(idle)}</div>`;
  let body;
  if (pa.loading) body = lead + '<div class="pa-help">Loading</div>';
  else if (pa.refused) body = lead + `<div class="pa-note pa-refused">${PA_LOCK}<span>${esc(pa.refused)}</span></div>` + test;
  else if (!pa.view) body = lead + `<div class="pa-res bad">${esc(pa.msg.load || 'Could not load the setup.')}</div>`;
  else {
    body = lead + `<div class="pa-lbl" id="pa-lbl">Send alerts to</div><div class="hs-seg pa-seg" role="group" aria-labelledby="pa-lbl">${PA_TABS.map(([k, l]) => `<button class="seg${pa.tab === k ? ' on' : ''}" data-pa-tab="${k}" aria-pressed="${pa.tab === k}">${l}</button>`).join('')}</div>`
      + paSteps() + test + privacy;
  }
  const foot = pa.testOk ? 'Arrived? Then you are set.' : pa.refused ? 'Tokens stay on the Mac.' : 'Saves as you go.';
  return `<div class="modal-back pa-back" id="pa-back"><div class="modal pa-sheet" role="dialog" aria-modal="true" aria-labelledby="pa-h">
<div class="pa-sh-h"><h2 id="pa-h">Set up phone alerts</h2><button class="x-btn" data-pa="close" aria-label="Close">&#215;</button></div>
<div class="pa-sh-b">${body}</div>
<div class="pa-sh-f"><span class="t3 pa-foot">${foot}</span><button class="btn sm${pa.testOk ? ' pri' : ''}" data-pa="done">Done</button></div>
</div></div>`;
}

// Redraws the sheet, keeping what is typed in a field and the focus.
function paDrawSheet() {
  let root = $('#pa-root');
  const keep = {};
  let focus = null;
  if (root) {
    for (const i of root.querySelectorAll('input')) keep[i.id] = i.value;
    focus = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id || document.activeElement.dataset.pa || document.activeElement.dataset.paTab : null;
  } else {
    root = document.createElement('div');
    root.id = 'pa-root';
    $('#mc').appendChild(root);
    root.addEventListener('click', paSheetClick);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('#pa-tg-token')) paSave('tg-save');
      if (e.key === 'Enter' && e.target.matches('#pa-wh-url')) paSave('wh-save');
    });
    focus = 'first';
  }
  root.innerHTML = paSheetHtml();
  $('#pa-back').classList.toggle('bottom', paPhone());
  for (const [id, v] of Object.entries(keep)) { const i = $('#' + id); if (i) i.value = v; }
  if (focus === 'first') { const f = root.querySelector('input') || root.querySelector('.x-btn'); if (f && !paPhone()) f.focus(); }
  else if (focus) { const f = $('#' + focus) || root.querySelector(`[data-pa="${focus}"],[data-pa-tab="${focus}"]`); if (f) f.focus(); }
}

async function paSave(act) {
  const map = { 'tg-save': ['#pa-tg-token', '/api/alerts/telegram', 'token', 'tg', 'telegram'], 'wh-save': ['#pa-wh-url', '/api/alerts/webhook', 'url', 'wh', 'webhook'] };
  const [sel, url, key, mk, ek] = map[act];
  const v = ($(sel) || {}).value || '';
  if (!v.trim()) { pa.msg[mk] = 'Paste it first.'; return paDrawSheet(); }
  pa.busy[act] = true;
  pa.msg[mk] = '';
  paDrawSheet();
  try {
    const r = await post(url, { [key]: v });
    pa.edit[ek] = false;
    if (r.note) pa.msg[mk] = r.note;
    $(sel) && ($(sel).value = '');
    await paLoad(false);
  } catch (e) { pa.msg[mk] = e.message; }
  pa.busy[act] = false;
  paDrawSheet();
}

async function paAct(act, url, mk) {
  pa.busy[act] = true;
  pa.msg[mk] = '';
  paDrawSheet();
  try { await post(url, {}); await paLoad(false); } catch (e) { pa.msg[mk] = e.message; }
  pa.busy[act] = false;
  paDrawSheet();
}

async function paSheetClick(e) {
  if (e.target.id === 'pa-back') return paClose();
  const t = e.target.closest('[data-pa-tab]');
  if (t) { pa.tab = t.dataset.paTab; pa.test = { state: 'idle', text: '' }; pa.testOk = false; pa.msg = {}; return paDrawSheet(); }
  const b = e.target.closest('[data-pa]');
  if (!b || b.disabled) return;
  const a = b.dataset.pa;
  if (a === 'close') return paClose();
  if (a === 'tg-save' || a === 'wh-save') return paSave(a);
  if (a === 'tg-replace') { pa.edit.telegram = true; paDrawSheet(); return $('#pa-tg-token') && $('#pa-tg-token').focus(); }
  if (a === 'wh-replace') { pa.edit.webhook = true; paDrawSheet(); return $('#pa-wh-url') && $('#pa-wh-url').focus(); }
  if (a === 'tg-find') return paAct(a, '/api/alerts/telegram/find-chat', 'chat');
  if (a === 'nt-new') {
    if (!confirm('A new topic cuts off every phone on the old one. Make a new topic?')) return;
    return paAct(a, '/api/alerts/ntfy/new-topic', 'nt');
  }
  if (a === 'nt-copy') {
    try { await post('/api/alerts/ntfy/copy', {}); pa.msg.copied = true; } catch (err) { pa.msg.nt = err.message; }
    return paDrawSheet();
  }
  if (a === 'test') {
    pa.test = { state: 'sending' };
    paDrawSheet();
    try {
      const r = await post('/api/alerts/test', pa.refused ? {} : { channel: pa.tab });
      pa.test = { state: 'ok', text: 'Sent. Check your phone.' };
      pa.testOk = true;
      pa.status = { ...(pa.status || {}), ...r };
    } catch (err) { pa.test = { state: 'bad', text: 'Not sent: ' + err.message }; }
    return paDrawSheet();
  }
  if (a === 'done') {
    if (!pa.refused && pa.view) {
      try { pa.status = await post('/api/alerts/done', { channel: pa.tab, enable: pa.testOk }); } catch (err) { toast(err.message); }
    }
    return paClose();
  }
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pa.sheet) paClose(); });
window.addEventListener('resize', () => { const b = $('#pa-back'); if (b) b.classList.toggle('bottom', paPhone()); });

// A phone whose key was replaced on the Mac: a plain screen, not a broken board.
function signedOut() {
  if (signedOut.done) return;
  signedOut.done = true;
  if (ui.es) ui.es.close();
  $('#mc').innerHTML = '<div class="signed-out" role="status"><p>Signed out. Scan the code on the Mac again.</p></div>';
}

async function checkSignedIn() {
  try { const r = await fetch('/api/whoami'); if (r.status === 401) signedOut(); } catch { /* the board is down; EventSource retries */ }
}

function connect() {
  const es = new EventSource('/api/events');
  ui.es = es;
  es.addEventListener('state', (ev) => {
    const snap = JSON.parse(ev.data);
    const prev = ui.lastStates;
    ui.snap = snap;
    if (snap.generatedAt && ui.skew == null) ui.skew = Date.now() - Date.parse(snap.generatedAt);
    ui.lastStates = Object.fromEntries(snap.projects.map((p) => [p.id, p.state]));
    if (Object.keys(prev).length) announce(prev, snap);
    render();
    if (hs.open && snap.alerts) { pa.status = snap.alerts; paPaintCard(); }
    if (snap.projectsRoot) { pr.view = snap.projectsRoot; if (hs.open && !pr.waiting) prPaint(); prFirstRun(); }
  });
  es.addEventListener('plan', (ev) => {
    const m = JSON.parse(ev.data);
    if (pl.pid && m.projectId === pl.pid) { pl.draft = m.draft; drawPlanSheet(); }
  });
  es.addEventListener('ideas', (ev) => {
    const prev = ui.ideas;
    ui.ideas = JSON.parse(ev.data);
    // Open the first of 3 new directions when they land.
    const lb = ui.ideas.lastBrainstorm;
    if (ui.wantBrainstorm && lb && (!prev || !prev.lastBrainstorm || prev.lastBrainstorm.at !== lb.at)) { ui.wantBrainstorm = false; ui.selIdea = lb.ids[0]; toast('3 directions in Spark'); }
    if (ui.view === 'ideas') render();
  });
  // EventSource reconnects by itself; a phone signed out by New key gets 401.
  es.onerror = () => { checkSignedIn(); };
}

// Boot
const q = new URLSearchParams(location.search);
applyTheme(q.get('theme') || store.get('theme', 'dark'));
paintBell();
const h0 = decodeURIComponent(location.hash.slice(1));
ui.view = h0.startsWith('/') ? h0.slice(1) : (q.get('view') || (h0 ? 'projects' : store.get('view', 'projects')));
// #/plan/<project>: the full plan of that project.
if (ui.view.startsWith('plan/')) { ui.planFor = ui.view.slice(5); ui.view = 'plan'; }
else if (!PAGES.some(([k]) => k === ui.view)) ui.view = 'projects';
$('#mc').classList.toggle('not-projects', ui.view !== 'projects' && ui.view !== 'plan');
ui.sel = ui.planFor || (!h0.startsWith('/') && h0) || q.get('p') || store.get('sel', null);
ui.selIdea = q.get('idea') || store.get('selIdea', null);
if (ui.view === 'ideas') loadIdeas();
if (ui.view === 'rules') loadRules();
if (ui.view === 'ship') loadShip();
connect();
if (q.get('modal') === 'new') openModal({ mode: 'new' });
// Only the Mac shows the phone button. A phone just signed in gets one toast.
fetch('/api/whoami').then((r) => r.json()).then((w) => { ui.local = !!w.local; $('#phone-anchor').hidden = !w.local; if (ui.modal && ui.modal.mode === 'new') renderFolder(); prFirstRun(); if (ui.snap) render(); }).catch(() => {});
if (/(?:^|;\s*)mc_new=1/.test(document.cookie)) {
  document.cookie = 'mc_new=; Max-Age=0; Path=/; SameSite=Strict';
  toast('Signed in. This phone stays signed in until you press New key on the Mac.', 7000, true);
}

// A typed or linked #/view or #project switches without a reload.
window.addEventListener('hashchange', () => {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('/')) setView(h.slice(1), { push: false });
  else if (h) { if (ui.view !== 'projects') { ui.sel = h; setView('projects', { push: false }); } else select(h); }
});
