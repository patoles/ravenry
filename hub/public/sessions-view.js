// The phone board's New session, Last conversation and Move to Ravenry
// (docs/FEATURES.md SESS-009, SESS-010, SESS-015 to SESS-018, MACH-007),
// without a page: what the person picked turned into the rows to draw and
// the request to send. What each choice says and which one a session or a
// project offers are the hub's (server/phonesessions.mjs, GET
// /api/setup/start `words`, GET /api/project/last `view`, each session's
// `phoneMove`); this only lays them out. Plain ES module, read by app.js and
// by apps/phone/test/sessions.test.ts.

/** A shared string's {name} placeholders filled. */
export function fill(tpl, vars = {}) {
  return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] != null ? String(vars[k]) : m));
}

/** How many of the hub's folders New session lists before All projects. */
export const RECENT = 3;

/**
 * New session's state, from GET /api/setup/start's answer and where it was
 * opened (a project's page gives its folder): the folder picked (its own
 * project first), the first assistant found, signed in first.
 */
export function startState(v, { folder = null, machine = null } = {}) {
  const folders = (v && v.folders) || [];
  const all = (v && v.all) || [];
  const pick = folder && [...folders, ...all].some((f) => f.path === folder) ? folder : (folders[0] && folders[0].path) || null;
  const asst = (v && v.assistants) || [];
  const ready = asst.find((a) => a.found && a.signedIn) || asst.find((a) => a.found) || null;
  return { machine, folder: pick, machineFolder: null, typed: '', assistant: ready ? ready.kind : 'claude', model: null, text: '', inFolder: false, showAll: false };
}

/** The folder rows to draw: the first few, or every project of the board (All projects); on a machine, its projects there. */
export function projectRows(v, st) {
  if (!v) return { rows: [], more: 0 };
  if (st.machine) {
    const m = (v.machines || []).find((x) => x.name === st.machine);
    return { rows: (m ? m.projects : []).map((p) => ({ name: p.name, path: p.path, short: p.short, on: st.machineFolder === p.path && !st.typed })), more: 0 };
  }
  const folders = v.folders || [];
  const all = v.all || [];
  let rows = st.showAll ? all.slice() : folders.slice(0, RECENT);
  // The folder picked stays in sight, whichever list it came from.
  if (st.folder && !rows.some((f) => f.path === st.folder)) {
    const f = [...folders, ...all].find((x) => x.path === st.folder);
    if (f) rows = st.showAll ? [f, ...rows] : [f, ...rows.slice(0, RECENT - 1)];
  }
  // All projects, with their count, while some of them are not listed yet.
  const more = !st.showAll && all.some((f) => !rows.some((r) => r.path === f.path)) ? all.length : 0;
  return { rows: rows.map((f) => ({ name: f.name, path: f.path, short: f.short, on: f.path === st.folder })), more };
}

/** The folder picked, as GET /api/setup/start lists it (this computer), or null. */
export function folderOf(v, st) {
  if (!v || st.machine || !st.folder) return null;
  return [...(v.folders || []), ...(v.all || [])].find((f) => f.path === st.folder) || null;
}

/** Where it starts: { folder, name } (null when nothing is picked yet). */
export function target(v, st) {
  if (st.machine) {
    const typed = String(st.typed || '').trim();
    if (typed) return { folder: typed, name: typed.replace(/\/+$/, '').split('/').pop() || typed };
    const m = (v && v.machines || []).find((x) => x.name === st.machine);
    const p = m && m.projects.find((x) => x.path === st.machineFolder);
    return p ? { folder: p.path, name: p.name, projectId: p.projectId } : null;
  }
  const f = folderOf(v, st);
  return f ? { folder: f.path, name: f.name, projectId: f.projectId || null } : null;
}

/**
 * The assistant cards: one per assistant the hub lists (GET /api/setup/start
 * `assistants`, the registry's order, server/assistants.mjs), each one's
 * name, its line and whether it can be picked. An older hub that sends none
 * gets Claude Code and Codex, not found.
 */
export function assistantCards(v, st, w) {
  const asst = (v && v.assistants) || [];
  const kinds = asst.length ? asst.map((a) => a.kind) : ['claude', 'codex'];
  return kinds.map((kind) => {
    const a = asst.find((x) => x.kind === kind) || { kind, found: false, signedIn: false };
    const name = (w.names && w.names[kind]) || a.name || kind;
    if (st.machine) return { kind, name, sub: fill(w.onMachine, { machine: st.machine }), ok: true, dot: 'ok', on: st.assistant === kind };
    const sub = !a.found ? w.notFound : a.signedIn ? w.signedIn : w.notSignedIn;
    return { kind, name, sub, ok: !!a.found, dot: !a.found ? 'off' : a.signedIn ? 'ok' : 'you', on: st.assistant === kind };
  });
}

/** The Model menu for the assistant picked, and the one picked (the folder's remembered one until the person picks). */
export function modelMenu(v, st) {
  const menu = (v && v.models && v.models[st.assistant]) || [];
  const f = folderOf(v, st);
  const remembered = f && f.models ? f.models[st.assistant] || '' : '';
  const picked = st.model != null ? st.model : remembered;
  return { menu, picked: menu.some((o) => o.id === picked) ? picked : '' };
}

/** The folder's line: another session works there, so it gets its own copy (or works in the folder when asked). */
export function busyLine(v, st, w) {
  const f = folderOf(v, st);
  if (!f || !f.busy) return null;
  const vars = { topic: f.busy.topic, project: f.busy.project };
  return st.inFolder
    ? { bold: w.inFolderB, rest: fill(w.inFolder, vars), link: w.ownCopyLink, worktree: false }
    : { bold: w.ownCopyB, rest: fill(w.ownCopy, vars), link: w.inFolderLink, worktree: true };
}

/** Start's words: "Start Claude Code in paper-boat", or "Start Claude Code on devbox". */
export function goLabel(v, st, w) {
  const assistant = (w.names && w.names[st.assistant]) || st.assistant;
  if (st.machine) return fill(w.goOn, { assistant, machine: st.machine });
  const t = target(v, st);
  return fill(w.go, { assistant, folder: t ? t.name : '' });
}

/** POST /api/sessions/start's body, or { error } when it cannot start yet. */
export function startBody(v, st, { cols = null, rows = null } = {}) {
  const t = target(v, st);
  if (!t) return { error: 'noProject' };
  const body = { folder: t.folder, assistant: st.assistant };
  if (st.machine) body.machine = st.machine;
  if (t.projectId) body.projectId = t.projectId;
  const b = busyLine(v, st, { names: {} });
  if (b && b.worktree && t.projectId) body.worktree = true;
  const m = modelMenu(v, st);
  // The model only when the menu has one: the hub remembers it for the project.
  if (m.menu.length && (st.model != null || m.picked)) body.model = m.picked;
  const text = String(st.text || '').trim();
  if (text) body.text = text;
  if (cols && rows) { body.cols = cols; body.rows = rows; }
  return { body };
}

/**
 * When a conversation stopped, against the phone's clock, in the shared
 * words (psess.*): "20 min ago", "at 3:12 PM", "yesterday at 6:40 PM",
 * "on Tue at 6:40 PM", "on Nov 12". `S(key, vars)` gives a string.
 */
export function stoppedWhen(iso, S, now = Date.now()) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const s = (now - d.getTime()) / 1000;
  if (s < 60) return S('psess.justNow');
  if (s < 3600) return S('psess.minAgo', { n: Math.max(1, Math.round(s / 60)) });
  const h = d.getHours();
  const time = `${(h % 12) || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(d.getTime()).setHours(0, 0, 0, 0)) / 86400e3);
  if (days <= 0) return S('psess.todayAt', { time });
  if (days === 1) return S('psess.yesterdayAt', { time });
  if (days < 7) return S('psess.dayAt', { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()], time });
  return S('psess.onDate', { date: `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}` });
}

/** POST /api/sessions/move's body for a band's button: Move to Ravenry, or keep it in the other terminal. */
export const moveBody = (projectId, sessionId, keep = 'ravenry') => ({ projectId, sessionId, keep: keep === 'outside' ? 'outside' : 'ravenry' });
