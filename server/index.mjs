// Ravenry server: polls cmux (and iTerm2 while a session runs there) every
// ~2 s through the terminal interface (server/terminal.mjs), or only iTerm2
// when the board runs in iTerm2 mode (term.BOARD), builds one
// snapshot of every project, serves it to the board (SSE), and carries the
// board's answers back into the right Claude surface.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';

import * as term from './terminal.mjs';
import { parseScreen, parseTitle, trimScreen, tailLines } from './screen.mjs';
import { markEntries, spansGen } from './codespans.mjs';
import { chooseOption } from './choose.mjs';
import { findTranscript, newestTranscriptFor, readTranscript } from './transcript.mjs';
import * as registry from './registry.mjs';
import { readBrief, appendNote } from './brief.mjs';
import { sessionState, eventState, projectState, describe, plain } from './state.mjs';
import * as handoff from './handoff.mjs';
import { config } from './config.mjs';
import * as create from './create.mjs';
import * as ideas from './ideas.mjs';
import * as rules from './rules.mjs';
import * as repeats from './repeats.mjs';
import { shipView } from './ship.mjs';
import { plansFor } from './plans.mjs';
import { sessionFolder, ownerOf, repoRoot, isBroadFolder } from './folders.mjs';
import * as events from './events.mjs';
import * as sess from './sessions.mjs';
import * as phone from './phone.mjs';
import * as pictures from './pictures.mjs';
import * as alerts from './alerts.mjs';
import * as projectsRoot from './projectsroot.mjs';
import { activePlan, proofKind } from './planfmt.mjs';
import * as planner from './planner.mjs';
import * as planrun from './planrun.mjs';
import { HOME_OVERRIDE, SCRATCH_DATA, repoTmpPaths, inRepoTmp } from './home.mjs';
import * as hookinstall from './hookinstall.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4600);
const TICK_MS = 2000;
const HOME = os.homedir();

// ------------------------------------------------------------ polling state

let reg = registry.load();
// The registry as the board last read it from disk: a hand edit or a restore
// made while the board runs is picked up on the next tick, instead of the
// board carrying the copy it loaded at start (on 2026-11-03 it kept showing
// a test's registry after the real file was restored).
const regMtime = () => { try { return fs.statSync(registry.REGISTRY_PATH).mtimeMs; } catch { return 0; } };
let regSeen = regMtime();
function reloadRegistry() {
  const m = regMtime();
  if (!m || m === regSeen) return;
  const r = registry.load();
  if (r) { reg = r; regSeen = m; }
}
// A real board whose registry names a test's scratch folders says so loudly;
// registry.save() refuses to write such a file into the real data folder.
if (reg && !SCRATCH_DATA) {
  const bad = repoTmpPaths(reg);
  if (bad.length) console.error(`registry: ${registry.REGISTRY_PATH} holds ${bad.length} path(s) inside the repo's .tmp (a test's data), first ${bad[0]}. Restore it from a projects.json.bak-* file; the board will not write it until then.`);
}
let snapshot = { generatedAt: null, cmuxOk: false, error: 'starting', projects: [] };
let snapshotJson = JSON.stringify(snapshot);
let tickNo = 0;
let ticking = false;
let wantTick = false;
const screens = new Map();   // surfaceId -> { text, at, live, okAt, full }
// The Live screen (docs/design/LiveScreen.dc.html, B): the surfaces a board
// page is showing get 200 lines of scrollback per read; every other surface
// keeps the 40-line read. `text` is always the last 40 lines, so the state
// rules read exactly what they read before.
const LIVE_LINES = 200;
const SCREEN_LINES = 40;
const LIVE_WANT_MS = 10000;
const liveWant = new Map();  // surfaceId -> when a page last asked for it
let liveTrim = { text: null, value: null }; // the last trim, reused for an unchanged screen
// The Live screen's code spans (server/codespans.mjs) come from the session's
// transcript, so the version a page holds covers both: it moves when the
// screen changes or when a Claude text block lands in the transcript.
const liveVers = new Map();   // surfaceId -> { key, ver }
let liveMarked = { key: null, entries: null }; // the last marked trim, reused while neither changed
const bindings = new Map();  // surfaceId -> { value, at, title }
const sidebars = new Map();  // workspaceId -> { value, at }
const clients = new Set();
let markers = new Map();     // sessionId -> hand-off marker
const gitDirty = new Map();  // folder -> { dirty, at, running }
// Ravenry's own hook events (hooks/events.mjs), rescanned every tick.
let ev = { all: new Map(), bySurface: new Map(), claimed: new Set(), live: new Set(), cmuxOk: true, tabs: {} };
// Tabs of terminals that list their own (iTerm2), asked only while some
// session's events or some claude process place a session there:
// kind -> { ok, tabs: Map(id -> tab), error, asked }.
const otherTabs = {};
const targets = new Map();   // cwd|workspace -> { value, at }
const starting = new Set();  // sessionIds whose fresh session is being opened
const reserved = new Map();  // workspace name -> count: being opened by the board, never auto-imported
let shipWaiting = null;      // Ship badge: items waiting on the user in the briefs' Ship sections
// Sessions page (docs/SESSIONS.md): every claude process, read once a minute.
let procState = { at: null, procs: [], helpers: 0, error: 'starting' };
let procBusy = null;
const extraScreens = new Map(); // surfaceId -> { text, at }: Claude tabs outside the board's projects
let lastWorkspaces = [];
let boardTabs = [];          // this tick's project sessions: { project, s, waitingOn }
let sessRows = [];           // the Sessions page rows, with what a close needs
let closing = false;
const reopening = new Set();
let lastResult = null;       // the last close, shown on the page for a while
let picBudget = 0;           // project pictures worked out this tick (server/pictures.mjs)
let loose = [];              // this tick's cards for sessions no project holds, in a too-broad folder

// Whether this copy's hooks are in ~/.claude/settings.json ('ok', 'missing',
// 'partial', 'stale', or null when the file cannot be read), read at most
// once a minute. Without them the board sees sessions only through cmux, so
// the empty board says to run `ravenry setup`.
let hooksSeen = { at: 0, state: null };
function hooksState() {
  if (Date.now() - hooksSeen.at < 60000) return hooksSeen.state;
  let state = null;
  try { state = hookinstall.status(hookinstall.readSettings().json).state; } catch { /* unreadable: say nothing */ }
  hooksSeen = { at: Date.now(), state };
  return state;
}

function cfg() {
  const c = config(reg ? reg.settings : {}, reg ? reg.projects : []);
  // Where new projects go: MC_PROJECTS_ROOT, the setting, the folder most
  // projects share, else the first-run suggestion (server/projectsroot.mjs).
  c.projectsRoot = projectsRoot.resolve(reg).path;
  return c;
}

// While the board opens a workspace for a project, the tick must not import
// that workspace as a project of its own.
function reserve(name) {
  reserved.set(name, (reserved.get(name) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    // Keep it a moment longer: the registry entry lands right after.
    setTimeout(() => { const n = (reserved.get(name) || 1) - 1; if (n > 0) reserved.set(name, n); else reserved.delete(name); }, 4000);
  };
}

function short(p) {
  return p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

async function refreshSidebars(workspaces, force) {
  const due = workspaces.filter((w) => force || !sidebars.has(w.id) || Date.now() - sidebars.get(w.id).at > 6000);
  await term.pool(due, 6, async (w) => { sidebars.set(w.id, { value: await term.cmux.sidebarState(w.id), at: Date.now() }); });
}

function looksLikeClaude(surface, hook) {
  return parseTitle(surface.title).claude || !!hook || (bindings.get(surface.id)?.value?.kind === 'claude') || !!screens.get(surface.id)?.live;
}

async function refreshSurfaces(workspaces, hooks) {
  const jobs = [];
  for (const w of workspaces) {
    for (const s of w.surfaces) {
      if (s.type !== 'terminal') continue;
      const hook = hooks.find((h) => h.surfaceId === s.id);
      const b = bindings.get(s.id);
      if (!b || Date.now() - b.at > 30000 || b.title !== s.title) jobs.push(['bind', w, s]);
      const prev = screens.get(s.id);
      // Claude-looking surfaces every tick; plain shells every ~10 s.
      if (!prev || looksLikeClaude(s, hook) || Date.now() - prev.at > 10000 || Date.now() - (liveWant.get(s.id) || 0) < LIVE_WANT_MS) jobs.push(['screen', w, s]);
    }
  }
  await term.pool(jobs, 8, async ([kind, w, s]) => {
    if (kind === 'bind') bindings.set(s.id, { value: await term.cmux.resumeBinding(w.id, s.id), at: Date.now(), title: s.title });
    else await readSurface({ kind: 'cmux', workspaceId: w.id, surfaceId: s.id });
  });
}

// One read of a tab's screen (server/terminal.mjs): 200 lines when a page
// shows it, else 40.
async function readSurface(tab) {
  const { surfaceId } = tab;
  const want = Date.now() - (liveWant.get(surfaceId) || 0) < LIVE_WANT_MS;
  const t0 = performance.now();
  const raw = await term.readScreen(tab, want ? LIVE_LINES : SCREEN_LINES);
  const readMs = performance.now() - t0;
  const text = want ? tailLines(raw, SCREEN_LINES) : raw;
  const prev = screens.get(surfaceId);
  const now = Date.now();
  // okAt and full keep the last good read, for the Live screen's freshness;
  // ver changes only when what the Live screen would show changes.
  const full = raw != null ? (want ? raw : null) : prev ? prev.full : null;
  const src = full ?? (raw != null ? text : prev ? prev.text : null);
  const prevSrc = prev ? prev.full ?? prev.text : undefined;
  screens.set(surfaceId, {
    text, at: now, live: parseScreen(text).claudeLive,
    okAt: raw != null ? now : prev ? prev.okAt : null,
    full,
    ver: prev ? (src === prevSrc ? prev.ver : prev.ver + 1) : 1,
  });
  if (want && process.env.MC_LIVE_LOG === '1') console.log('live read', JSON.stringify({ surfaceId, lines: LIVE_LINES, ms: +readMs.toFixed(1), bytes: raw ? Buffer.byteLength(raw) : 0 }));
}

// GET /api/live?surface=<id>[&v=<ver>]: the Live screen of one surface,
// trimmed (server/screen.mjs, trimScreen), with the time of its last good
// read. When the page already has that version, only the time comes back. Asking marks the surface wanted, so the next ticks read 200 lines;
// the first ask reads at once.
async function liveScreen(surfaceId, ver) {
  const tab = tabOf(surfaceId);
  if (!tab) return { status: 404, body: { error: `That tab is not open in ${term.nameOf(term.kindOf(surfaceId))}.` } };
  const first = Date.now() - (liveWant.get(surfaceId) || 0) >= LIVE_WANT_MS || !screens.get(surfaceId)?.full;
  liveWant.set(surfaceId, Date.now());
  if (first) await readSurface(tab);
  const x = screens.get(surfaceId);
  const now = Date.now();
  if (!x || x.okAt == null) return { status: 200, body: { ok: true, surfaceId, at: null, now, live: false, entries: [], status: null } };
  const bt = boardTabs.find((b) => b.s.surfaceId === surfaceId);
  const tp = (bt && bt.s.transcript && bt.s.transcript.path) || null;
  const vkey = `${x.ver}\u0000${tp}\u0000${spansGen(tp)}`;
  let lvv = liveVers.get(surfaceId);
  if (!lvv || lvv.key !== vkey) { lvv = { key: vkey, ver: lvv ? lvv.ver + 1 : 1 }; liveVers.set(surfaceId, lvv); }
  if (ver && Number(ver) === lvv.ver) return { status: 200, body: { ok: true, surfaceId, at: x.okAt, now, ver: lvv.ver, same: true } };
  const src = x.full ?? x.text;
  const t0 = performance.now();
  if (liveTrim.text !== src) liveTrim = { text: src, value: trimScreen(src) };
  const mkey = vkey + '\u0000' + surfaceId;
  if (liveMarked.key !== mkey || liveMarked.src !== src) liveMarked = { key: mkey, src, entries: markEntries(liveTrim.value.entries, tp) };
  const trimMs = performance.now() - t0;
  const body = { ok: true, surfaceId, at: x.okAt, now, ver: lvv.ver, lines: src ? src.split('\n').length - 1 : 0, ...liveTrim.value, entries: liveMarked.entries };
  if (process.env.MC_LIVE_LOG === '1') console.log('live trim', JSON.stringify({ surfaceId, ms: +trimMs.toFixed(2), entries: body.entries.length }));
  return { status: 200, body };
}

// Which Claude session lives in a surface, and how we know.
function mapSession(surface, hook, binding, folder, taken) {
  if (hook && hook.agent === 'claude' && hook.sessionId) {
    const p = hook.transcriptPath && fs.existsSync(hook.transcriptPath) ? hook.transcriptPath : findTranscript(hook.sessionId, hook.cwd);
    return { sessionId: hook.sessionId, path: p, method: 'cmux hook record', cwd: hook.cwd };
  }
  if (binding && binding.kind === 'claude' && binding.sessionId) {
    return { sessionId: binding.sessionId, path: findTranscript(binding.sessionId, binding.cwd), method: 'cmux resume binding', cwd: binding.cwd };
  }
  const g = eventsInFolder(folder, taken);
  if (g) return { sessionId: g.sessionId, path: transcriptOf(g), method: 'hook events in the same folder (guess)', cwd: g.cwd };
  const n = newestTranscriptFor(folder, taken);
  if (n) return { sessionId: n.sessionId, path: n.path, method: 'newest transcript in the folder (guess)', cwd: folder };
  return null;
}

// The transcript a hook event names, else the one found by session id.
function transcriptOf(e) {
  if (e.transcriptPath && fs.existsSync(e.transcriptPath)) return e.transcriptPath;
  return findTranscript(e.sessionId, e.cwd);
}

// The open tab of a session its events place in a terminal other than
// cmux (iTerm2): { id: 'iterm:<UUID>', title, ... }, or null.
function otherTab(e) {
  if (!e || !e.terminal || e.terminal === 'cmux') return null;
  const id = term.tabIdFor(e.terminal, e.terminalId);
  const o = otherTabs[e.terminal];
  return id && o && o.tabs.has(id) ? o.tabs.get(id) : null;
}

// Why the board cannot act on a session it shows from its events only:
// the full reason (the Live screen) and a short one (the composer).
function cannotFor(kind) {
  if (kind === 'cmux' && !term.canDrive('cmux')) return { why: term.cannotDrive(kind), short: term.cannotType(kind) };
  if (kind === 'cmux') return { why: "cmux is not answering, so the board only shows what this session's hook events say.", short: 'cmux is not answering, so the board cannot type into this session.' };
  const o = otherTabs[kind];
  if (o && !o.ok) return { why: `The board could not reach ${term.nameOf(kind)}: ${String(o.error).replace(/\.?$/, '.')} Until it can, it only shows what this session's hook events say.`, short: `The board cannot reach ${term.nameOf(kind)} now, so it cannot type into this session.` };
  return { why: term.cannotDrive(kind, { open: false }), short: term.cannotType(kind, { open: false }) };
}

// The tab a board surface id names now, as the terminal interface takes it,
// or null: a cmux surface in the last listing, or an open iTerm2 session.
function tabOf(surfaceId, workspaces = lastWorkspaces) {
  const kind = term.kindOf(surfaceId);
  if (kind === 'cmux') {
    const ws = workspaces.find((w) => w.surfaces.some((x) => x.id === surfaceId));
    return ws ? { kind, workspaceId: ws.id, surfaceId } : null;
  }
  const o = otherTabs[kind];
  return o && o.tabs.has(surfaceId) ? { kind, surfaceId, title: o.tabs.get(surfaceId).title } : null;
}

// A fresh look at one non-cmux tab, right before a write: the terminal is
// asked again, never the tick's cached list.
async function freshTab(surfaceId) {
  const kind = term.kindOf(surfaceId);
  if (kind === 'cmux') return tabOf(surfaceId, await term.cmux.listWorkspaces());
  const list = await term.listTabs(kind);
  const t = list.find((x) => x.id === surfaceId);
  return t ? { kind, surfaceId, title: t.title } : null;
}

// Lists iTerm2's tabs, but only while a session needs it: an iTerm2
// session in the events that has not ended (seen in the last week), or a
// claude process whose environment names an iTerm2 session. Then reads the
// screen of every open tab such a session reports from.
async function refreshOtherTabs(evAll) {
  const week = Date.now() - 7 * 86400000;
  const kind = 'iterm';
  const wanted = [...evAll.values()].filter((e) => e.terminal === kind && !e.endedAt && Date.parse(e.lastEventAt) > week);
  const procs = procState.procs.filter((p) => p.itermId);
  if (!wanted.length && !procs.length) { otherTabs[kind] = { ok: true, tabs: new Map(), asked: false }; return; }
  try {
    const list = await term.listTabs(kind);
    otherTabs[kind] = { ok: true, tabs: new Map(list.map((t) => [t.id, t])), asked: true };
  } catch (e) {
    otherTabs[kind] = { ok: false, tabs: new Map(), error: String(e.message || e).replace(/^iTerm2: /, ''), asked: true };
    return;
  }
  const ids = [...new Set(wanted.map((e) => term.tabIdFor(kind, e.terminalId)).filter((id) => id && otherTabs[kind].tabs.has(id)))];
  await term.pool(ids, 4, (id) => readSurface({ kind, surfaceId: id }));
}

// A session that reported from this folder but from no tab the board can
// see: the "else cwd" step of mapping a tab to its events.
function eventsInFolder(folder, taken) {
  if (!folder) return null;
  let best = null;
  for (const e of ev.all.values()) {
    if (e.endedAt || taken.has(e.sessionId) || ev.claimed.has(e.sessionId) || !e.cwd) continue;
    if (e.surfaceId && ev.live.has(e.surfaceId)) continue;
    if (e.terminal && e.terminal !== 'cmux') continue; // it says it runs in another terminal
    if (path.resolve(e.cwd) !== path.resolve(folder)) continue;
    if (!best || e.lastEventAt > best.lastEventAt) best = e;
  }
  return best;
}

// The repo a session works in: its tool calls first, then the hook's cwd.
function realFolder(tp, e) {
  const real = tp ? sessionFolder(tp) : null;
  if (real && real.folder) return real;
  const r = e && e.cwd ? repoRoot(e.cwd) : null;
  return r ? { folder: r, share: null, hits: real ? real.hits : 0, repos: real ? real.repos : [], from: 'hook cwd' } : real;
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The projects root as the board resolves it (MC_PROJECTS_ROOT, the
// setting, the folder most projects share), null while it only suggests one.
// Worked out once per registry load (the registry object is new after every change).
let broadCache = { reg: null, root: null, folders: new Map() };
function broadFor() {
  if (broadCache.reg !== reg) {
    const r = reg ? projectsRoot.resolve(reg) : null;
    broadCache = { reg, root: r && r.source !== 'ask' ? r.path : null, folders: new Map() };
  }
  return broadCache;
}
function rootFolder() {
  return broadFor().root;
}

// A project whose folder is too broad to hold a session by folder (the
// projects root, home, ~/Documents, a folder holding other projects): it
// gets sessions only through its workspace ids.
function broadProject(p) {
  if (!p || !p.folder) return false;
  const c = broadFor();
  if (!c.folders.has(p.folder)) c.folders.set(p.folder, isBroadFolder(p.folder, reg ? reg.projects : [], c.root));
  return c.folders.get(p.folder);
}

// The project of a session seen only through its events (no terminal tab),
// in order (docs/STATE-RULES.md, "Which project a session seen only through
// its events is in"):
// 1. its cmux workspace, when a project lists it, exactly as in cmux mode
//    (several projects listing it: ownerOf, by the repo it works in);
// 2. by folder, never through a too-broad folder (so a project whose
//    folder is a mere parent of the cwd never wins): the project closest
//    around its cwd, where Claude was started (a session started in a game's repo
//    that works mostly in another repo stays with that game), unless the project of the
//    repo its tool calls work in sits deeper inside that one; with no
//    project around the cwd (started in the projects root), the project of
//    the repo it works in.
function eventOwner(e, real) {
  if (!reg || !e) return null;
  const root = rootFolder();
  const live = reg.projects.filter((p) => !p.hidden);
  if (e.workspaceId) {
    const owners = live.filter((p) => (p.workspaces || []).includes(e.workspaceId));
    if (owners.length) return ownerOf(owners, e.surfaceId || null, real && real.folder, null, { projects: reg.projects, root });
  }
  const byFolder = live.filter((p) => p.folder && !broadProject(p));
  const closest = (where) => {
    if (!where) return null;
    const near = byFolder.filter((p) => inside(where, p.folder)).sort((a, b) => b.folder.length - a.folder.length);
    if (!near.length) return null;
    const same = near.filter((p) => p.folder === near[0].folder);
    return same.find((p) => p.main) || same[0];
  };
  const a = closest(real && real.folder);
  const b = closest(e.cwd);
  if (a && b && a.folder !== b.folder && inside(a.folder, b.folder)) return a;
  return b || a;
}

// iTerm2 mode has no workspaces to import: a Claude session open in an
// iTerm2 tab whose folder no project holds becomes a project of its repo
// folder, as a new cmux workspace does in cmux mode. A folder some project
// (hidden too) already names is never added again, and a too-broad folder
// (the projects root, home) never: a session started there and working in
// no repo shows on a card of its own instead (looseSessions).
// A session the board can only watch (Terminal, VS Code, tmux...) counts
// while its events are this recent: it has no tab to prove it is open.
const WATCH_ONLY_MS = 7 * 86400e3;
function watchedLive(e) {
  if (e.endedAt || e.terminal === 'cmux') return false;
  if (e.terminal === 'iterm') return !!otherTab(e);
  return Date.now() - Date.parse(e.lastEventAt || 0) < WATCH_ONLY_MS;
}

// Outside cmux mode, a session whose folder no project holds becomes a
// project of its repo folder: an iTerm2 session with an open tab, or a
// session in a terminal the board can only watch (docs/TERMINALS.md: a new
// user sees their sessions from the first minute, whatever the terminal).
function importFolders(evAll) {
  const add = [];
  const root = rootFolder();
  for (const e of evAll.values()) {
    if (!watchedLive(e)) continue;
    const real = realFolder(transcriptOf(e), e);
    const folder = (real && real.folder) || e.cwd;
    if (!folder || path.resolve(folder) === HOME || !fs.existsSync(folder) || add.includes(folder)) continue;
    // A test's scratch folder is never a real board's project.
    if (!SCRATCH_DATA && inRepoTmp(folder)) continue;
    if (isBroadFolder(folder, reg.projects, root)) continue;
    if (eventOwner(e, real) || reg.projects.some((p) => p.folder && path.resolve(p.folder) === path.resolve(folder))) continue;
    add.push(folder);
  }
  if (!add.length) return;
  reg = registry.update((r) => {
    for (const folder of add) {
      if (r.projects.some((p) => p.folder && path.resolve(p.folder) === path.resolve(folder))) continue;
      const name = path.basename(folder);
      r.projects.push({ id: registry.uniqueId(r, name), name, folder, workspaces: [], brief: 'BRIEF.md', waitingOn: null, imported: new Date().toISOString() });
    }
  });
  console.log('registry: added', add.map((f) => path.basename(f)).join(', '));
}

// The sessions importFolders would make a project of, but whose folder is
// too broad (Claude started in the projects root, working in no repo): each
// gets a card of its own for this tick, named from its topic, with no
// folder and nothing written to the registry. It goes when the session does.
function looseSessions(evAll) {
  const out = [];
  if (term.BOARD === 'cmux' || !reg || reg.settings.autoImport === false) return out;
  const root = rootFolder();
  const ids = new Set(reg.projects.map((p) => p.id));
  for (const e of evAll.values()) {
    if (ev.claimed.has(e.sessionId) || !watchedLive(e)) continue;
    const tab = otherTab(e) || {};
    const tp = transcriptOf(e);
    const real = realFolder(tp, e);
    const folder = (real && real.folder) || e.cwd;
    if (!folder || !isBroadFolder(folder, reg.projects, root) || eventOwner(e, real)) continue;
    const t = tp ? readTranscript(tp) : null;
    const name = parseTitle(tab.title || '').topic || (t && t.title) || 'Claude session';
    let id = 'session-' + e.sessionId.slice(0, 8);
    while (ids.has(id)) id += '-s';
    ids.add(id);
    out.push({ id, name, folder: null, workspaces: [], brief: null, waitingOn: null, loose: true, sessionIds: [e.sessionId], cwd: e.cwd || null });
  }
  return out;
}

function briefFor(project) {
  const p = registry.briefPath(project);
  const b = readBrief(p);
  if (!b) return null;
  const dir = path.dirname(p);
  b.pictures = b.pictures
    .map((pic) => ({ ...pic, abs: path.resolve(dir, pic.path) }))
    .filter((pic) => fs.existsSync(pic.abs))
    .map((pic) => ({ path: pic.path, alt: pic.alt || path.basename(pic.path), url: `/api/pic/${encodeURIComponent(project.id)}?p=${encodeURIComponent(pic.path)}` }));
  return b;
}

// The project's picture comes from its current session only (its primary,
// the session the detail view shows first), from its main transcript alone:
// what that session showed the user, never its subagents' shots.
function pictureSession(primary) {
  return primary && primary.sessionId ? { sessionId: primary.sessionId, path: (primary.transcript && primary.transcript.path) || null } : null;
}

function refreshPicture(project, session, now) {
  const r = pictures.refresh(project, session, now);
  // MC_PICTURES_LOG=1: one line per pick, for measuring its cost.
  if (process.env.MC_PICTURES_LOG === '1') console.log('pictures', JSON.stringify({ id: project.id, session: r.sessionId, pickMs: +r.ms.toFixed(1), transcripts: r.transcripts, pick: r.pick ? short(r.pick.abs) : null, size: r.pick ? r.pick.size : null, mtime: r.pick ? new Date(r.pick.mtimeMs).toISOString() : null }));
  return r;
}

function buildProject(project, wsById, hooks, settings, now) {
  const sessions = [];
  const workspaces = [];
  const taken = new Set(hooks.map((h) => h.sessionId));
  for (const wid of project.workspaces || []) {
    const w = wsById.get(wid);
    const sb = sidebars.get(wid)?.value || null;
    workspaces.push({ id: wid, ref: w ? w.ref : null, title: w ? w.title : null, open: !!w, sidebarStatus: sb ? sb.claudeStatus : null, branch: sb ? sb.branch : null, cwd: sb ? sb.cwd : null });
    if (!w) continue;
    for (const s of w.surfaces) {
      if (s.type !== 'terminal') continue;
      const hook = hooks.find((h) => h.surfaceId === s.id) || null;
      const binding = bindings.get(s.id)?.value || null;
      const title = parseTitle(s.title);
      const screen = parseScreen(screens.get(s.id)?.text ?? null);
      const claudeHere = screen.claudeLive || (title.claude && !screen.readable);
      // Events first: the session that last reported from this very tab.
      const evTab = ev.bySurface.get(s.id) || null;
      // Claude still on screen 20 s after its SessionEnd: a session the hook
      // never saw (started before it was installed). Before that the screen
      // may simply not have caught up.
      const seenAfterEnd = (e) => !!(e && e.endedAt && claudeHere && (screens.get(s.id)?.at || 0) > Date.parse(e.endedAt) + 20000);
      let map = null;
      if (evTab && !seenAfterEnd(evTab)) map = { sessionId: evTab.sessionId, path: transcriptOf(evTab), method: 'hook events (surface id)', cwd: evTab.cwd };
      else if (claudeHere) map = mapSession(s, hook, binding, project.folder, taken);
      else if (screen.resumeId) map = { sessionId: screen.resumeId, path: findTranscript(screen.resumeId), method: 'resume line on screen' };
      else if (binding && binding.kind === 'claude') map = { sessionId: binding.sessionId, path: findTranscript(binding.sessionId, binding.cwd), method: 'cmux resume binding' };
      else if (hook) map = { sessionId: hook.sessionId, path: hook.transcriptPath, method: 'cmux hook record' };
      if (!map && !claudeHere) continue; // a plain shell that never ran Claude (that we can see)
      if (map) taken.add(map.sessionId);
      // Its events by session id, unless they came from another open tab.
      let evs = map ? ev.all.get(map.sessionId) || null : null;
      if (evs && evs.surfaceId && evs.surfaceId !== s.id && ev.live.has(evs.surfaceId)) evs = null;
      // Ended, yet Claude is on screen: a session the hook never saw (installed later).
      if (seenAfterEnd(evs)) evs = null;
      const t = map && map.path ? readTranscript(map.path) : null;
      if (!claudeHere && !t && !(evs && !evs.endedAt)) continue;
      // The repo this session really works in, from its tool calls. When a
      // workspace's tabs work in different repos, each tab belongs to the
      // project of its own repo (docs/STATE-RULES.md, Which project a tab is in).
      const real = map ? realFolder(map.path, evs) : null;
      const owners = reg.projects.filter((p) => !p.hidden && (p.workspaces || []).includes(w.id));
      if (owners.length > 1) {
        const own = ownerOf(owners, s.id, real && real.folder, w.surfaces.map((x) => x.id), { projects: reg.projects, root: rootFolder() });
        if (own && own.id !== project.id) continue;
      }
      let st = eventState({ ev: evs, screen, screenAt: screens.get(s.id)?.at || null, title, transcript: t }, settings, now);
      if (!st) st = { ...sessionState({ screen, title, transcript: t, hook }, settings, now), source: 'screen' };
      const marker = map ? markers.get(map.sessionId) || null : null;
      // A session that handed off is done; its "hand-off written" line is
      // not a hand-back to the user.
      if (marker && (marker.state === 'written' || marker.state === 'resumed') && !['working', 'dialog', 'draft', 'none'].includes(st.state)) {
        st = { state: 'handed', since: marker.writtenAt || st.since, reasons: [...st.reasons, 'wrote its hand-off; a fresh session carries on'] };
      }
      sessions.push({
        marker, paneId: s.paneId, cwd: (evs && evs.cwd) || (hook && hook.cwd) || (t && t.cwd) || (map && map.cwd) || project.folder, terminal: true, term: 'cmux', cannot: null,
        surfaceId: s.id, surfaceRef: s.ref, workspaceId: w.id, workspaceRef: w.ref,
        topic: title.topic || (t && t.title) || s.title, live: screen.claudeLive,
        sessionId: map ? map.sessionId : null, method: map ? map.method : null,
        transcript: t, screen, st, hook, real,
        sidebarStatus: sb ? sb.claudeStatus : null,
      });
    }
  }
  // Sessions known from their events: in iTerm2 (read and typed into
  // through its adapter when its tab is open), in a terminal the board has
  // no adapter for (watch only), or every cmux session while cmux does not
  // answer.
  for (const e of ev.all.values()) {
    if (e.endedAt || ev.claimed.has(e.sessionId) || taken.has(e.sessionId)) continue;
    if (e.surfaceId && ev.cmuxOk) continue; // a cmux tab: shown through it, or closed
    const kind = e.terminal || (e.surfaceId ? 'cmux' : null);
    const tab = otherTab(e);
    const x = tab ? screens.get(tab.id) : null;
    const screen = parseScreen(x ? x.text : null);
    const title = parseTitle(tab ? tab.title : '');
    const q = e.last && e.last.event === 'Stop' && e.last.question;
    if (!(tab && screen.claudeLive) && age(now, e.lastEventAt) > (q ? settings.questionHours : settings.handbackHours) * 3600000) continue;
    const tp = transcriptOf(e);
    const real = realFolder(tp, e);
    if (project.loose ? !project.sessionIds.includes(e.sessionId) : (() => { const own = eventOwner(e, real); return !own || own.id !== project.id; })()) continue;
    const t = tp ? readTranscript(tp) : null;
    let st = eventState({ ev: e, screen, screenAt: x ? x.at : null, title, transcript: t }, settings, now);
    if (!st && tab) st = { ...sessionState({ screen, title, transcript: t, hook: null }, settings, now), source: 'screen' };
    if (!st) continue;
    taken.add(e.sessionId);
    const marker = markers.get(e.sessionId) || null;
    sessions.push({
      marker, paneId: null, cwd: e.cwd || (t && t.cwd) || project.folder, terminal: !!tab, term: kind,
      cannot: tab ? null : cannotFor(kind),
      surfaceId: tab ? tab.id : 'ev:' + e.sessionId, surfaceRef: tab ? term.nameOf(kind) + ' tab' : null, workspaceId: e.workspaceId, workspaceRef: null,
      // Never named after a too-broad folder ("projects" for the projects root).
      topic: title.topic || (t && t.title) || [e.cwd, project.folder].filter((f) => f && !isBroadFolder(f, reg.projects, rootFolder())).map((f) => path.basename(f))[0] || 'Session', live: screen.claudeLive,
      sessionId: e.sessionId, method: tab ? `hook events (${term.nameOf(kind)} session id)` : 'hook events, no terminal tab', transcript: t, screen, st, hook: null, real, sidebarStatus: null,
    });
  }
  const brief = briefFor(project);
  const waitingOn = project.waitingOn || (brief && brief.waitingOn) || null;
  for (const s of sessions) boardTabs.push({ project, s, waitingOn });
  const ps = projectState(sessions, waitingOn);
  const primary = ps.primary;
  // At most a few pictures are worked out per tick, each once a minute or
  // when the current session changes. Only for a project with a brief: the
  // board shows pictures from the brief, the latest one after its own list.
  if (brief) {
    const ps0 = pictureSession(primary);
    if (picBudget > 0 && pictures.due(project.id, ps0, now)) {
      picBudget--;
      try { refreshPicture(project, ps0, now); } catch (e) { console.error('pictures:', project.id, e.message); }
    }
    const auto = pictures.current(project.id, ps0);
    // The card's picture carries the session's last 6 (oldest first, itself
    // last) for the gallery (docs/design/Gallery.dc.html, B).
    if (auto) brief.pictures.push({ path: short(auto.abs), alt: auto.alt, url: auto.url, auto: true, gallery: pictures.galleryJson(pictures.gallery(project.id, ps0), short) });
  }
  // The brief's running plan (docs/design/Plans.dc.html). One waiting at a
  // gate, with its session not working, makes the project Needs you, with
  // the gate's question as its line (a dialog on screen still comes first).
  const plan = brief ? activePlan(brief.plan, { working: ps.state === 'work' }) : null;
  const planGate = plan && plan.gate && ps.state !== 'work' && !(primary && primary.st.state === 'dialog') ? plan.gate : null;
  const pstate = planGate ? 'you' : ps.state;
  const words = describe({ ...project, waitingOn }, primary, pstate, now);
  if (planGate) {
    words.line = `Plan gate: ${planGate.short}`;
    words.headline = planGate.question;
    words.quick = [];
    words.question = planGate.question;
  } else if (brief && brief.quickAnswers.length && pstate === 'you' && !(primary && primary.st.state === 'dialog')) {
    words.quick = brief.quickAnswers.map((label) => ({ label }));
  }
  let since = null;
  if (pstate === 'work') since = null;
  else if (planGate) since = (primary && primary.st.since) || planGate.since || null;
  else if (primary) since = primary.st.since || null;
  if (pstate === 'idle') {
    const times = sessions.map((s) => s.transcript && (s.transcript.lastTurnEndAt || s.transcript.lastTextAt)).filter(Boolean).sort();
    since = times.length ? times[times.length - 1] : null;
  }
  const cw = settings.contextWindow;
  const ctx = (s) => (s && s.transcript && s.transcript.contextTokens != null ? { tokens: s.transcript.contextTokens, window: cw, pct: Math.min(100, (s.transcript.contextTokens / cw) * 100), model: s.transcript.model } : null);
  const timeline = [];
  if (brief) for (const h of brief.handoff) timeline.push({ when: h.when, text: plain(h.text), from: 'brief' });
  if (primary && primary.transcript) {
    for (const turn of primary.transcript.turns.slice(0, 4)) {
      const first = plain(turn.text).split(/\n\s*\n/)[0].replace(/\s+/g, ' ');
      timeline.push({ at: turn.at, text: first.length > 220 ? first.slice(0, 217).replace(/\s+\S*$/, '') + '...' : first, from: 'transcript' });
    }
  }
  const shared = registry.sharedWith(reg, project);
  const openNotes = brief ? brief.notes.filter((n) => !n.fixed).length : 0;
  for (const s of sessions) s.handoff = handoffView(project, s, ctx(s), settings, now);
  const flags = [];
  if (openNotes) flags.push({ kind: 'note', title: `${openNotes} open note${openNotes > 1 ? 's' : ''}` });
  const pending = sessions.map((s) => s.handoff).filter((x) => ['queued', 'requested'].includes(x.state));
  const written = sessions.map((s) => s.handoff).filter((x) => x.state === 'written');
  if (written.length) flags.push({ kind: 'hand', title: 'Hand-off written' });
  else if (pending.length) flags.push({ kind: 'hand', title: 'Hand-off after this task' });
  // The last finished hand-off, shown on the sheet for a few hours.
  const recent = sessions.map((s) => s.handoff).filter((x) => x.state === 'resumed' && age(now, x.resumedAt) < 6 * 3600 * 1000)
    .sort((a, b) => Date.parse(b.resumedAt) - Date.parse(a.resumedAt))[0] || null;
  if (shared.length) flags.push({ kind: 'shared', title: 'Shares a folder' });

  return {
    id: project.id, name: project.name, state: pstate, since, loose: !!project.loose,
    plan: plan ? planView(project, plan) : null, planGate,
    planDraft: (() => { try { const d = planner.get(project.id); return d ? { busy: !!d.busy, steps: d.steps.length } : null; } catch { return null; } })(),
    folder: project.folder, folderShort: short(project.folder), shared,
    waitingOn, flags,
    line: words.line, headline: words.headline, quick: words.quick, question: words.question, dialog: words.dialog || null, draft: words.draft || null,
    brief: brief ? { path: short(brief.path), file: brief.path, draft: brief.draft, status: brief.status, goal: brief.goal, doneMeans: brief.doneMeans, kind: brief.kind, stage: brief.stage, plan: brief.plan, next: brief.next, notes: brief.notes, pictures: brief.pictures, parked: brief.parked, rules: brief.rules } : null,
    briefExpected: registry.briefPath(project) ? short(registry.briefPath(project)) : null,
    plans: plansFor(project, reg.projects, now),
    timeline: timeline.slice(0, 5),
    handoffRecent: recent,
    primary: primary ? primary.surfaceId : null,
    workspaces,
    sessions: sessions.map((s) => ({
      surfaceId: s.surfaceId, surfaceRef: s.surfaceRef, workspaceId: s.workspaceId, workspaceRef: s.workspaceRef,
      topic: s.topic, live: s.live, sessionId: s.sessionId, method: s.method,
      workFolder: s.real && s.real.folder ? short(s.real.folder) : null,
      state: s.st.state, since: s.st.since || null, reasons: s.st.reasons, source: s.st.source || 'screen', terminal: s.terminal !== false,
      term: s.term || null, termName: s.term ? term.nameOf(s.term) : null,
      cannot: s.cannot ? s.cannot.why : null, cannotType: s.cannot ? s.cannot.short : null,
      sidebarStatus: s.sidebarStatus, hookLifecycle: s.hook ? s.hook.lifecycle : null,
      ctx: ctx(s), draft: !!s.screen.draft, dialog: !!s.screen.dialog || s.st.state === 'dialog', working: s.st.state === 'working',
      notificationType: s.st.ntype || null,
      words: s === primary ? words : sessionWords(project, waitingOn, s, now),
      screen: s.screen.body.slice(-10),
      screenAt: s.terminal !== false ? screens.get(s.surfaceId)?.okAt ?? null : null,
      handoff: s.handoff,
      // The Sessions card's order: newest first, handed-off ones last.
      startedAt: (s.sessionId && ev.all.get(s.sessionId) && ev.all.get(s.sessionId).startedAt) || null,
      handed: !!(s.marker && (s.marker.state === 'written' || s.marker.state === 'resumed')),
      freshSurface: (s.marker && s.marker.resumeSurfaceId) || null,
      doneWhen: s.screen.done ? s.screen.done.when : null,
    })),
  };
}

// The active plan as the page draws it: proof pictures get a URL that only
// serves them while they pass the picture rules (GET /api/pic/<id>?plan=).
function planView(project, plan) {
  const url = (rel) => `/api/pic/${encodeURIComponent(project.id)}?plan=${encodeURIComponent(rel)}`;
  const pic = (x) => (x.type === 'shot' ? { ...x, url: url(x.path) } : x);
  return { ...plan, refs: (plan.refs || []).map((r) => (r.image ? { ...r, url: url(r.path) } : r)), steps: plan.steps.map((s) => ({ ...s, proofs: s.proofs.map(pic) })) };
}

const SESSION_TO_PROJECT = { dialog: 'you', asked: 'you', draft: 'you', handback: 'you', working: 'work' };
function sessionWords(project, waitingOn, s, now) {
  const st = SESSION_TO_PROJECT[s.st.state] || 'idle';
  const w = describe({ ...project, waitingOn }, s, st, now);
  return { state: st, line: w.line, headline: w.headline, quick: w.quick, question: w.question, dialog: w.dialog || null, draft: w.draft || null };
}

function age(now, iso) {
  return iso ? now - Date.parse(iso) : Infinity;
}

async function tick() {
  if (ticking) { wantTick = true; return; }
  ticking = true;
  try {
    tickNo++;
    reloadRegistry();
    const now = Date.now();
    // Without cmux the board still shows what the hook events say.
    let workspaces = [];
    let cmuxError = null;
    try { workspaces = await term.cmux.listWorkspaces(); } catch (e) { if (!reg) throw e; cmuxError = String(e.message || e); }
    const cmuxOk = !cmuxError;
    // In iTerm2 mode cmux is never asked (term.cmux answers "nothing"), and
    // a read is whole unless iTerm2 could not be asked.
    const driven = term.BOARD === 'cmux';
    const hooks = cmuxOk ? (await term.cmux.listHookSessions()).filter((h) => h.active || h.surfaceId) : [];
    if (cmuxOk) await refreshSidebars(workspaces, !reg);
    const evAll = events.scan();
    await refreshOtherTabs(evAll);
    const fullRead = driven ? cmuxOk : !(otherTabs.iterm && otherTabs.iterm.ok === false);
    if (cmuxOk && (!reg || reg.settings.autoImport !== false)) {
      try {
        const res = registry.importWorkspaces(reg, workspaces, (w) => {
          const sb = sidebars.get(w.id)?.value;
          const hook = hooks.find((h) => h.workspaceId === w.id && h.cwd);
          const e = [...evAll.values()].find((x) => x.workspaceId === w.id && x.cwd);
          return (sb && sb.cwd) || (hook && hook.cwd) || (e && e.cwd) || null;
        }, (w) => reserved.has(w.title));
        reg = res.reg;
        regSeen = regMtime();
        if (res.added.length) console.log('registry: added', res.added.map((p) => p.name).join(', '));
      } catch (e) {
        // A refused save (registry.save) leaves the file as it is; the board
        // keeps going on what it has.
        if (e.code !== 'EREFUSED' || !reg) throw e;
      }
    }
    if (!driven && reg.settings.autoImport !== false) importFolders(evAll);
    // The first look at registered projects with no projects root set: the
    // folder most of them share becomes the setting.
    const adopted = projectsRoot.adopt(reg);
    if (adopted) reg = adopted;
    const mine = workspaces.filter((w) => reg.projects.some((p) => !p.hidden && (p.workspaces || []).includes(w.id)));
    for (const [sid, at] of liveWant) if (Date.now() - at > LIVE_WANT_MS * 6) liveWant.delete(sid);
    await refreshSurfaces(mine, hooks);
    const live = new Set(workspaces.flatMap((w) => w.surfaces.map((x) => x.id)));
    const bySurface = new Map([...events.bySurface(evAll)].filter(([sid]) => live.has(sid)));
    // Sessions some open tab already names, so none shows twice.
    const claimed = new Set([...bySurface.values()].map((e) => e.sessionId));
    for (const h of hooks) if (h.surfaceId && live.has(h.surfaceId) && h.sessionId) claimed.add(h.sessionId);
    for (const [sid, b] of bindings) if (live.has(sid) && b.value && b.value.sessionId) claimed.add(b.value.sessionId);
    // One session per open iTerm2 tab: the newest that reported from it (a
    // /clear starts a new session id in the same tab).
    const newestInTab = new Map();
    for (const e of evAll.values()) {
      const t = otherTab(e);
      if (!t) continue;
      const prev = newestInTab.get(t.id);
      if (!prev || e.lastEventAt > prev.lastEventAt) newestInTab.set(t.id, e);
    }
    for (const e of evAll.values()) { const t = otherTab(e); if (t && newestInTab.get(t.id) !== e) claimed.add(e.sessionId); }
    ev = { all: evAll, bySurface, claimed, live, cmuxOk: driven && cmuxOk, tabs: otherTabs };
    const wsById = new Map(workspaces.map((w) => [w.id, w]));
    const settings = reg.settings;
    markers = handoff.listMarkers();
    boardTabs = [];
    picBudget = 3;
    loose = looseSessions(evAll);
    const build = () => [...reg.projects.filter((p) => !p.hidden), ...loose].map((p) => buildProject(p, wsById, hooks, settings, now));
    let projects = build();
    if (noticeWritten(projects)) { boardTabs = []; projects = build(); }
    if (cmuxOk) lastWorkspaces = workspaces;
    let sessionsView;
    try { sessionsView = buildSessions(cmuxOk ? workspaces : [], hooks, settings, now, projects); } catch (e) {
      console.error('sessions view:', e.message);
      sessionsView = { at: procState.at, error: String(e.message || e), idleHours: Number(settings.idleHours) || 24, totalKb: 0, count: 0, idleCount: 0, idleKb: 0, rows: [], closed: [], result: null, closing };
    }
    const c = cfg();
    // The Rules tab counts the repeats waiting in Suggested.
    const views = { ideas: ideas.count(), rules: repeats.visibleCount(c), ship: shipWaiting };
    // Phone alerts and Mac notifications (server/alerts.mjs): a project that
    // moved into Needs you starts a send that never holds up the tick. Only on a full read: a
    // tick without cmux sees fewer sessions and would make false moves.
    if (fullRead) { try { alerts.observe(projects, { now, boardUrl: boardUrl() }); } catch (e) { console.error('alerts:', e.message); } }
    snapshot = { generatedAt: new Date(now).toISOString(), cmuxOk, board: { kind: term.BOARD, name: term.nameOf(term.BOARD), installed: term.BOARD_INSTALLED }, hooks: hooksState(), error: cmuxError ? 'cmux did not answer: ' + cmuxError : !fullRead ? `${term.nameOf(term.BOARD)} could not be asked: ${otherTabs.iterm.error}` : null, events: evAll.size, registryPath: short(registry.REGISTRY_PATH), settings: registry.handoffSettings(settings), projectsRoot: projectsRoot.view(reg), alerts: alerts.status(), views, sessions: sessionsView, projects };
    if (process.env.MC_NO_AUTOSTART !== '1') autoStarts(workspaces, cmuxOk);
  } catch (e) {
    snapshot = { ...snapshot, cmuxOk: false, error: 'The board could not read its terminals: ' + String(e.message || e), generatedAt: new Date().toISOString() };
    console.error('tick:', e.message);
  } finally {
    ticking = false;
  }
  const j = JSON.stringify(snapshot);
  if (j !== snapshotJson) {
    snapshotJson = j;
    for (const res of clients) res.write(`event: state\ndata: ${j}\n\n`);
  }
  if (wantTick) { wantTick = false; setTimeout(tick, 50); }
}

// ------------------------------------------------------------ sessions and memory
// The Sessions page and the top-bar readout (docs/SESSIONS.md): every claude
// process, the session it holds, its memory, and whether it is idle.

function refreshProcs() {
  if (procBusy) return procBusy;
  procBusy = (async () => {
    try {
      const r = await sess.readProcesses();
      // Screens of Claude tabs the board does not poll (workspaces that are
      // not projects), so a half-typed reply or a dialog shows there too.
      const wsOf = new Map(lastWorkspaces.flatMap((w) => w.surfaces.map((x) => [x.id, w])));
      const want = r.procs.filter((p) => p.surfaceId && wsOf.has(p.surfaceId) && !screens.has(p.surfaceId));
      await term.pool(want, 6, async (p) => { extraScreens.set(p.surfaceId, { text: await term.readScreen({ kind: 'cmux', workspaceId: wsOf.get(p.surfaceId).id, surfaceId: p.surfaceId }, 40), at: Date.now() }); });
      for (const id of [...extraScreens.keys()]) if (!r.procs.some((p) => p.surfaceId === id)) extraScreens.delete(id);
      procState = { ...r, error: null };
    } catch (e) {
      procState = { ...procState, error: String(e.message || e) };
      console.error('sessions:', procState.error);
    } finally {
      procBusy = null;
    }
    wantTick = true;
  })();
  return procBusy;
}

// A tick that has finished by the time this resolves (after a close).
async function freshTick() {
  while (ticking) await new Promise((r) => setTimeout(r, 40));
  await tick();
}

function idleMsFor(id, settings) {
  const o = sess.idleOverrides().get(id);
  return o != null ? o : (Number(settings.idleHours) || 24) * 3600000;
}

// What a session's state rests on, for one process: the board's own reading
// when the session is in a project tab, else read here the same way.
function sessionInfo(sid, p, tab, b, settings, now) {
  const e = ev.all.get(sid) || null;
  if (b) {
    return {
      st: b.s.st, t: b.s.transcript, ev: e, marker: b.s.marker || markers.get(sid) || null, screen: b.s.screen, startedAt: p.startedAt,
      project: b.project, waitingOn: b.waitingOn, words: sessionWords(b.project, b.waitingOn, b.s, now), topic: b.s.topic, cwd: b.s.cwd || p.cwd,
    };
  }
  const tp = e ? transcriptOf(e) : findTranscript(sid, p.cwd);
  const t = tp ? readTranscript(tp) : null;
  const x = tab ? screens.get(p.surfaceId) || extraScreens.get(p.surfaceId) || null : null;
  const screen = parseScreen(x ? x.text : null);
  const title = parseTitle(tab ? tab.s.title : '');
  const st = eventState({ ev: e, screen, screenAt: x ? x.at : null, title, transcript: t }, settings, now)
    || { ...sessionState({ screen, title, transcript: t, hook: null }, settings, now), source: 'screen' };
  const where = e || { cwd: p.cwd };
  const own = eventOwner(where, realFolder(tp, where)) || loose.find((l) => l.sessionIds.includes(sid)) || null;
  return { st, t, ev: e, marker: markers.get(sid) || null, screen, startedAt: p.startedAt, project: own || null, waitingOn: own ? own.waitingOn || null : null, words: null, topic: (t && t.title) || null, cwd: (e && e.cwd) || p.cwd };
}

function mixOf(st, waitingOn) {
  const k = SESSION_TO_PROJECT[st ? st.state : ''];
  return k || (waitingOn ? 'wait' : 'idle');
}

// One row per claude process, grouped the way the Sessions page shows them.
function buildSessions(workspaces, hooks, settings, now, projects) {
  const where = new Map();
  for (const w of workspaces) for (const s of w.surfaces) where.set(s.id, { w, s, kind: 'cmux' });
  // A process in an iTerm2 session (ITERM_SESSION_ID in its environment).
  const it = otherTabs.iterm;
  if (it && it.ok) for (const t of it.tabs.values()) where.set(t.id, { w: { id: null, ref: 'iTerm2', title: 'iTerm2' }, s: { id: t.id, title: t.title, type: 'terminal' }, kind: 'iterm' });
  const boardIterm = process.env.ITERM_SESSION_ID ? term.tabIdFor('iterm', process.env.ITERM_SESSION_ID) : null;
  const boardTab = new Map(boardTabs.filter((b) => b.s.terminal !== false).map((b) => [b.s.surfaceId, { sessionId: b.s.sessionId, method: b.s.method }]));
  const bySid = new Map(boardTabs.filter((b) => b.s.sessionId).map((b) => [b.s.sessionId, b]));
  const rows = [];
  for (let p of procState.procs) {
    const itermTab = !p.surfaceId && p.itermId ? term.tabIdFor('iterm', p.itermId) : null;
    const tab = p.surfaceId ? where.get(p.surfaceId) || null : itermTab ? where.get(itermTab) || null : null;
    if (itermTab) p = { ...p, surfaceId: itermTab };
    const m = sess.mapProcess(p, { evAll: ev.all, hooks, boardTab });
    const base = {
      pid: p.pid, startedAt: p.startedAt, memKb: p.rssKb, cwd: p.cwd, folder: short(p.cwd),
      surfaceId: tab ? p.surfaceId : null, workspaceId: tab ? tab.w.id : null, workspaceRef: tab ? tab.w.ref : null, inCmux: !!tab && tab.kind === 'cmux',
      sessionId: m ? m.sessionId : null, method: m ? m.method : null,
    };
    if (!m) {
      rows.push({ ...base, group: 'unmapped', mix: 'unmapped', label: sess.folderLabel(p.cwd), isFolder: true, projectId: null, state: 'unknown',
        line: `No session found for pid ${p.pid}`, tag: null, since: p.startedAt, closable: false, blocked: 'Not mapped to a session' });
      continue;
    }
    const info = sessionInfo(m.sessionId, p, tab, bySid.get(m.sessionId) || null, settings, now);
    const cls = sess.classify(info, idleMsFor(m.sessionId, settings), now);
    const sc = info.screen && info.screen.readable ? info.screen : null;
    let blocked = null;
    if (!tab) blocked = itermTab ? 'Its iTerm2 tab is gone' : p.surfaceId ? (term.canDrive('cmux') ? 'Its cmux tab is gone' : 'In cmux') : `Outside ${term.nameOf(term.BOARD)}`;
    else if (p.surfaceId === process.env.CMUX_SURFACE_ID || (boardIterm && p.surfaceId === boardIterm)) blocked = 'The tab this board runs in';
    else if (sc && !sc.claudeLive) blocked = 'Claude is not on screen in its tab';
    rows.push({
      ...base, group: cls.group, tag: cls.tag || null, useWhy: cls.why || null, since: cls.since || cls.lastAt,
      label: info.project ? info.project.name : sess.folderLabel(info.cwd), isFolder: !info.project, projectId: info.project ? info.project.id : null,
      line: cls.group === 'use' && info.words && info.words.line ? info.words.line : sess.lastLine({ t: info.t, marker: info.marker, cls, topic: info.topic }),
      state: info.st ? info.st.state : 'unknown', mix: mixOf(info.st, info.waitingOn), closable: !blocked, blocked,
    });
  }
  // Closing a tab ends every Claude in it; two in one tab are left alone.
  for (const r of rows) {
    if (r.surfaceId && r.closable && rows.some((x) => x !== r && x.surfaceId === r.surfaceId)) { r.closable = false; r.blocked = 'Two Claude processes share this tab'; }
  }
  sessRows = rows;
  // Memory per session on the project sheets: by session id, else by tab
  // when that tab's process names no other session.
  const bySession = new Map(rows.filter((r) => r.sessionId).map((r) => [r.sessionId, r]));
  const byTab = new Map(rows.filter((r) => r.surfaceId).map((r) => [r.surfaceId, r]));
  for (const pr of projects) {
    for (const x of pr.sessions) {
      const t = byTab.get(x.surfaceId);
      const r = (x.sessionId && bySession.get(x.sessionId)) || (t && (!t.sessionId || !x.sessionId) ? t : null);
      x.memKb = r ? r.memKb : null;
    }
  }
  const sum = (a) => a.reduce((n, r) => n + r.memKb, 0);
  const idle = rows.filter((r) => r.group === 'handed' || r.group === 'idle');
  return {
    at: procState.at, error: procState.error, idleHours: Number(settings.idleHours) || 24,
    totalKb: sum(rows), count: rows.length, idleCount: idle.length, idleKb: sum(idle),
    rows: rows.map(({ cwd, startedAt, ...r }) => r),
    closed: sess.listClosed(now),
    result: lastResult && now - Date.parse(lastResult.at) < 30 * 60000 ? lastResult : null,
    closing,
  };
}

// Right before closing one session: still that process, in that tab, and
// still idle by a fresh look at its screen, events, transcript and marker.
async function closeOne(id, workspaces, allow, settings) {
  const row = sessRows.find((r) => r.sessionId === id);
  const label = row ? row.label : id.slice(0, 8);
  const fail = (error) => ({ ok: false, id, label, error });
  if (allow && !allow.has(id)) return fail('This test board closes only its own test session.');
  if (!row) return fail('No running Claude process holds that session now.');
  if (!['handed', 'idle', 'left'].includes(row.group)) return fail('It is in use.');
  if (!row.closable) return fail(row.blocked || 'It cannot be closed from here.');
  const kind = term.kindOf(row.surfaceId);
  const name = term.nameOf(kind);
  let ws = null;
  let surface = null;
  if (kind === 'cmux') {
    ws = workspaces.find((w) => w.surfaces.some((x) => x.id === row.surfaceId));
    surface = ws && ws.surfaces.find((x) => x.id === row.surfaceId);
  } else {
    // Another terminal's tab (iTerm2), asked again right now.
    const t = await freshTab(row.surfaceId).catch(() => null);
    surface = t ? { id: t.surfaceId, title: t.title, type: 'terminal' } : null;
    ws = { id: null, ref: name, title: name };
  }
  if (!surface || surface.type !== 'terminal') return fail(`Its ${name} tab is gone.`);
  const still = await sess.stillThere(row.pid, row.startedAt);
  if (!still) return fail('Its Claude process already ended.');
  const stillTab = still.surfaceId || (still.itermId ? term.tabIdFor('iterm', still.itermId) : null);
  if (stillTab !== row.surfaceId) return fail('Its process is not in that tab.');
  const tab = kind === 'cmux' ? { kind, workspaceId: ws.id, surfaceId: row.surfaceId } : { kind, surfaceId: row.surfaceId };
  const screen = parseScreen(await term.readScreen(tab, 40));
  if (!screen.readable) return fail(`${name} could not read its tab, so it was left open.`);
  if (!screen.claudeLive) return fail('Claude is not at its prompt in that tab.');
  if (screen.draft && row.tag !== 'draft') return fail('A reply is half typed in its prompt.');
  const e = events.scan().get(id) || null;
  const tp = e ? transcriptOf(e) : findTranscript(id, row.cwd);
  const t = tp ? readTranscript(tp) : null;
  const now = Date.now();
  const title = parseTitle(surface.title);
  const st = eventState({ ev: e, screen, screenAt: now, title, transcript: t }, settings, now) || sessionState({ screen, title, transcript: t, hook: null }, settings, now);
  const cls = sess.classify({ st, t, ev: e, marker: handoff.readMarker(id), screen, startedAt: row.startedAt }, idleMsFor(id, settings), now);
  if (cls.group === 'use') return fail(`It is in use now (${cls.why}).`);
  // The record first, so a tab that closes always has its Reopen.
  sess.writeClosed({
    id, cwd: row.cwd, workspaceId: ws.id, workspaceRef: ws.ref, workspace: ws.title, surfaceId: row.surfaceId, term: kind,
    project: row.isFolder ? null : row.label, projectId: row.projectId, label: row.label, lastLine: row.line,
    memKb: still.rssKb, pid: row.pid, closedAt: new Date().toISOString(),
  });
  const c = await term.close(tab);
  if (!c.ok) { sess.dropClosed(id); return fail(`${name} did not close the tab: ` + (c.err || 'no answer')); }
  const gone = await sess.waitGone(row.pid, row.startedAt, 6000);
  console.log(`sessions: closed ${id} (${row.label}, pid ${row.pid}, ${Math.round(still.rssKb / 1024)} MB) in ${ws.ref}${gone ? '' : ', process still exiting'}`);
  return { ok: true, id, label: row.label, memKb: still.rssKb, gone };
}

async function closeSessions(body) {
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => String(x).toLowerCase()).filter((x) => sess.UUID.test(x)))];
  if (!ids.length) return { ok: false, status: 400, error: 'Tick a session first.' };
  if (closing) return { ok: false, status: 409, error: 'Already closing.' };
  closing = true;
  try {
    const allow = sess.closeAllow();
    await refreshProcs();
    await freshTick();
    const workspaces = await term.cmux.listWorkspaces();
    const done = [];
    const failed = [];
    for (const id of ids) {
      const r = await closeOne(id, workspaces, allow, reg.settings);
      (r.ok ? done : failed).push(r);
    }
    await refreshProcs();
    await freshTick();
    lastResult = {
      at: new Date().toISOString(), closed: done.length, freedKb: done.reduce((n, r) => n + r.memKb, 0),
      nowKb: snapshot.sessions ? snapshot.sessions.totalKb : null,
      failed: failed.map(({ id, label, error }) => ({ id, label, error })),
    };
    return { ok: true, ...lastResult };
  } finally {
    closing = false;
    wantTick = true;
  }
}

// Reopen: a NEW tab in the closed session's workspace (or the one cmux shows
// now, when that workspace is gone), or in iTerm2 when it was closed there,
// running `cd <cwd> && claude --resume <id>`.
async function reopenSession(body) {
  const id = String(body.id || '').toLowerCase();
  if (!sess.UUID.test(id)) return { ok: false, status: 400, error: 'No such session.' };
  const allow = sess.closeAllow();
  if (allow && !allow.has(id)) return { ok: false, status: 403, error: 'This test board reopens only its own test session.' };
  const rec = sess.readClosed(id);
  if (!rec) return { ok: false, status: 404, error: 'That session is not in Recently closed.' };
  if (reopening.has(id)) return { ok: false, status: 409, error: 'Already reopening.' };
  if (sessRows.some((r) => r.sessionId === id)) { sess.dropClosed(id); return { ok: false, status: 409, error: 'It is running again already.' }; }
  reopening.add(id);
  try {
    const cwd0 = rec.cwd && fs.existsSync(rec.cwd) ? rec.cwd : HOME;
    // Closed in iTerm2, or on a board in iTerm2 mode: a new tab there
    // (iTerm2's current window).
    const k = rec.term && rec.term !== 'cmux' && term.canDrive(rec.term) ? rec.term : term.BOARD;
    if (k !== 'cmux') {
      const name = term.nameOf(k);
      const made = await term.openTab(k, {});
      if (!made.ok) return { ok: false, status: 500, error: `${name} did not open a tab: ` + (made.err || 'no answer') };
      await new Promise((r) => setTimeout(r, 900)); // let the shell draw its prompt
      const tab = { kind: k, surfaceId: made.surfaceId };
      const cmd = `cd ${shellQuote(cwd0)} && ${cfg().launchCommand || 'claude'} --resume ${id}`;
      const a = await term.pasteText(tab, cmd);
      const b = a.ok ? await term.pressKey(tab, 'enter') : a;
      if (!b.ok) return { ok: false, status: 500, error: 'The new tab opened but the command was not typed: ' + (b.err || '') };
      sess.dropClosed(id);
      console.log(`sessions: reopened ${id} in ${name}`);
      setTimeout(refreshProcs, 4000);
      wantTick = true;
      return { ok: true, id, label: rec.label, workspaceRef: name, workspace: name, surfaceRef: made.surfaceRef, same: true };
    }
    const workspaces = await term.cmux.listWorkspaces();
    let ws = workspaces.find((w) => w.id === rec.workspaceId);
    let same = true;
    if (!ws) {
      same = false;
      const cur = await term.cmux.currentWorkspace();
      ws = cur ? workspaces.find((w) => w.id === cur.id) : null;
    }
    if (!ws) return { ok: false, status: 409, error: 'cmux shows no workspace to open it in.' };
    const cwd = cwd0;
    const made = await term.openTab('cmux', { workspaceId: ws.id, paneId: null, cwd });
    if (!made.ok) return { ok: false, status: 500, error: 'cmux did not open a tab: ' + (made.err || 'no answer') };
    await new Promise((r) => setTimeout(r, 900)); // let the shell draw its prompt
    const cmd = `cd ${shellQuote(cwd)} && ${cfg().launchCommand || 'claude'} --resume ${id}`;
    const tab = { kind: 'cmux', workspaceId: ws.id, surfaceId: made.surfaceId };
    const a = await term.pasteText(tab, cmd);
    const b = a.ok ? await term.pressKey(tab, 'enter') : a;
    if (!b.ok) return { ok: false, status: 500, error: 'The new tab opened but the command was not typed: ' + (b.err || '') };
    sess.dropClosed(id);
    console.log(`sessions: reopened ${id} in ${ws.ref} (${made.surfaceRef})`);
    setTimeout(refreshProcs, 4000);
    wantTick = true;
    return { ok: true, id, label: rec.label, workspaceRef: ws.ref, workspace: ws.title, surfaceRef: made.surfaceRef, same };
  } finally {
    reopening.delete(id);
  }
}

// ------------------------------------------------------------ hand-off

// Tracked changes in a folder, refreshed in the background (never blocks a
// tick). Untracked files are left out: shared trees always hold some.
function dirtyOf(folder) {
  if (!folder) return null;
  const c = gitDirty.get(folder);
  if (!c || (Date.now() - c.at > 10000 && !c.running)) {
    const e = c || { dirty: null, at: 0, running: false };
    e.running = true;
    gitDirty.set(folder, e);
    execFile('git', ['-C', folder, 'status', '--porcelain', '--untracked-files=no'], { timeout: 4000 }, (err, out) => {
      e.running = false; e.at = Date.now();
      e.dirty = err ? null : out.trim().length > 0;
    });
  }
  return gitDirty.get(folder).dirty;
}

function targetFor(cwd, workspaceId, projectId) {
  const key = cwd + '|' + workspaceId + '|' + projectId;
  const c = targets.get(key);
  if (c && Date.now() - c.at < 60000) return c.value;
  const value = handoff.resolveHandoffFile({ cwd, workspaceId, projectId, projects: reg ? reg.projects : [], root: rootFolder() });
  targets.set(key, { value, at: Date.now() });
  return value;
}

// What the sheet shows about one session's hand-off: its state and the four
// clean-point checks of the design.
function handoffView(project, s, c, settings, now) {
  const m = s.marker;
  const threshold = settings.handoffThreshold;
  const pct = c ? c.pct : null;
  const enabled = settings.handoffEnabled !== false;
  const past = enabled && pct != null && pct >= threshold;
  let state = m ? m.state : null;
  // Hand-off off: a line crossed earlier asks nothing now (the hook ignores
  // it too), so only a manual request or a written hand-off shows.
  if (!enabled && m && !m.manualAt && (state === 'queued' || state === 'requested')) state = null;
  if (!state && enabled && past && s.live) state = 'queued'; // the hook has not seen a stop past the line yet
  const autoStart = settings.handoffAutoStart !== false;
  if (!state) return { state: 'none', pct, threshold, ceiling: settings.handoffCeiling, autoStart, sessionId: s.sessionId };
  const finished = state === 'written' || state === 'resumed';
  // Until it is written, where the hand-off would go now (the registry may
  // have gained a brief since the hook last stopped); after, where it went.
  const file = (finished && m && m.handoffFile) || targetFor(s.cwd, s.workspaceId, project.id).file;
  const busy = s.st.state === 'working' || s.st.state === 'dialog';
  const jobs = s.screen.agentsRunning > 0 || /background agent/i.test(s.screen.busyLine || '');
  const dirty = dirtyOf((m && m.cwd) || s.cwd);
  const manual = !!(m && m.manualAt);
  const checks = [
    { label: finished ? `Was past ${threshold}%` : (!past && manual ? 'Asked for by you' : `Past ${threshold}%`), ok: finished || past || manual },
    { label: 'Task finished', ok: finished || !busy },
    { label: 'Work committed', ok: finished || dirty === false },
    { label: 'No jobs running', ok: finished || !jobs },
  ];
  return {
    state, pct, threshold, ceiling: settings.handoffCeiling, autoStart, manual,
    sessionId: s.sessionId, surfaceId: s.surfaceId,
    file: short(file), fileName: file ? path.basename(file) : 'BRIEF.md',
    checks, live: s.live, atRest: !busy && s.live,
    lastCheck: m && m.lastCheck ? m.lastCheck : null, asks: (m && m.asks) || 0,
    queuedAt: (m && m.queuedAt) || null, requestedAt: (m && m.requestedAt) || null,
    writtenAt: (m && m.writtenAt) || null, resumedAt: (m && m.resumedAt) || null,
    resumeError: (m && m.resumeError) || null, resumeSurfaceRef: (m && m.resumeSurfaceRef) || null,
    over: enabled && pct != null && pct >= settings.handoffCeiling,
  };
}

// The board's half of "written": a requested marker whose Hand-off section
// changed, once its session is no longer working (the hook records it at
// the next stop too; whichever sees it first).
//
// A queued marker counts too when its session wrote a hand-off before any
// stop was a clean point (on its own, or asked by hand): the hook takes a
// fresh base at every queued stop, so the hash alone never shows it
// (handoff.writtenWhileQueued). A written hand-off whose fresh session is
// already open (the old session opened it itself) becomes resumed on that
// session, so the board never opens a second one.
const queuedSeen = new Map(); // sessionId -> what writtenWhileQueued last said no to
function noticeWritten(projects) {
  const working = new Set();
  for (const p of projects) for (const x of p.sessions) if (x.working && x.sessionId) working.add(x.sessionId);
  let changed = false;
  for (const [sid, m] of markers) {
    if (working.has(sid)) continue;
    let written = false;
    if (m.state === 'requested') written = handoff.handoffWritten(m);
    else if (m.state === 'queued') {
      const tp = m.transcriptPath || (ev.all.get(sid) || {}).transcriptPath || null;
      const key = `${fileStamp(tp)}|${fileStamp(m.handoffFile)}|${m.updatedAt}`;
      if (queuedSeen.get(sid) !== key) {
        written = handoff.writtenWhileQueued(m, tp);
        if (written) queuedSeen.delete(sid); else queuedSeen.set(sid, key);
      }
    }
    if (written) {
      markers.set(sid, handoff.writeMarker(sid, { state: 'written', writtenAt: new Date().toISOString(), writtenSeenBy: 'board' }));
      changed = true;
    }
  }
  for (const [sid, m] of markers) {
    if (m.state !== 'written' || m.resumeStartedAt) continue;
    const fresh = freshSessionFor(sid, m);
    if (!fresh) continue;
    markers.set(sid, handoff.writeMarker(sid, {
      state: 'resumed', resumedAt: fresh.startedAt, resumeSurfaceId: fresh.surfaceId || null,
      resumeSessionId: fresh.sessionId, resumedBy: 'found',
    }));
    console.log(`hand-off: ${sid} was already picked up by ${fresh.sessionId}`);
    changed = true;
  }
  return changed;
}

function fileStamp(f) {
  try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; }
}

// A live session in the old one's cmux workspace, started after the old one
// was queued, whose first prompt is the hand-off's "Read the Hand-off
// section of ...".
function freshSessionFor(sid, m) {
  if (!m.workspaceId) return null;
  const since = Date.parse(m.queuedAt || m.requestedAt || m.writtenAt || '') || 0;
  const cands = [...ev.all.values()]
    .filter((e) => e.sessionId !== sid && e.workspaceId === m.workspaceId && !e.endedAt && e.startedAt && Date.parse(e.startedAt) >= since && e.transcriptPath)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return cands.find((e) => handoff.isResumePrompt(handoff.firstPrompt(e.transcriptPath))) || null;
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function resumePrompt(m, cwd) {
  const f = m.handoffFile;
  const rel = f && cwd && !path.relative(cwd, f).startsWith('..') ? path.relative(cwd, f) : f;
  return `Read the Hand-off section of ${rel || 'BRIEF.md (or HANDOFF.md)'} and continue from it.`;
}

// Opens the fresh session for a written hand-off, ONCE per marker: the
// marker records resumeStartedAt before cmux is asked for anything, so a
// crash or a second board can never open a second one.
async function startFresh(sid, workspaces, { force = false } = {}) {
  const settings = reg.settings;
  if (!force && settings.handoffAutoStart === false) return { ok: false, error: 'Auto-start is off.' };
  if (starting.has(sid)) return { ok: false, error: 'Already starting.' };
  const m = handoff.readMarker(sid);
  if (!m || m.state !== 'written') return { ok: false, error: 'No written hand-off for that session.' };
  if (m.resumeStartedAt) return { ok: false, error: 'A fresh session was already started for this hand-off.' };
  starting.add(sid);
  try {
    const at = new Date().toISOString();
    handoff.writeMarker(sid, { resumeStartedAt: at });
    const fail = (error) => { markers.set(sid, handoff.writeMarker(sid, { resumeError: error })); return { ok: false, error }; };
    const cwd = [m.cwd, m.folder].find((d) => d && fs.existsSync(d)) || null;
    // The fresh session opens in the terminal the old one ran in: a new
    // cmux tab next to it, or a new iTerm2 tab in its window.
    const where = sessionTerminal(sid, m);
    let made, tab, whereRef;
    if (where.kind === 'cmux' && term.canDrive('cmux')) {
      const ws = workspaces.find((w) => w.id === m.workspaceId);
      if (!m.workspaceId) return fail('The hand-off did not record its cmux workspace.');
      if (!ws) return fail('Its cmux workspace is closed.');
      const old = ws.surfaces.find((x) => x.id === m.surfaceId);
      made = await term.openTab('cmux', { workspaceId: ws.id, paneId: old ? old.paneId : null, cwd });
      if (!made.ok) return fail('cmux did not open a tab: ' + (made.err || 'no answer'));
      tab = { kind: 'cmux', workspaceId: ws.id, surfaceId: made.surfaceId };
      whereRef = ws.ref;
    } else if (term.canDrive(where.kind)) {
      made = await term.openTab(where.kind, { near: where.near });
      if (!made.ok) return fail(`${term.nameOf(where.kind)} did not open a tab: ` + (made.err || 'no answer'));
      tab = { kind: where.kind, surfaceId: made.surfaceId };
      whereRef = term.nameOf(where.kind);
    } else {
      return fail(`It ran in ${term.nameOf(where.kind)}, where the board cannot open a tab. Start the fresh session there yourself.`);
    }
    await new Promise((r) => setTimeout(r, 900)); // let the shell draw its prompt
    // A plan running in the project's brief: the fresh session reads it
    // first, and the board logs the pick-up at the step it starts from.
    const owner = snapshot.projects.find((x) => x.sessions.some((y) => y.sessionId === sid));
    const runningPlan = owner && owner.plan && owner.plan.state !== 'done' && owner.plan.state !== 'stopped' ? owner.plan : null;
    const prompt = resumePrompt(m, cwd) + (runningPlan ? ` The brief has a running plan, "${runningPlan.title.replace(/'/g, '')}", under ## Plan: read it first${(runningPlan.refs || []).length ? ', and the References listed under its Goal' : ''}, and carry on from the first step not ticked, by the rules written in it.` : '');
    // cmux opens the tab in the folder; another terminal's tab starts where
    // its profile says, so the command goes there first.
    const launch = `${settings.handoffCommand || 'claude'} ${shellQuote(prompt)}`;
    const cmd = tab.kind !== 'cmux' && cwd ? `cd ${shellQuote(cwd)} && ${launch}` : launch;
    const a = await term.pasteText(tab, cmd);
    const b = a.ok ? await term.pressKey(tab, 'enter') : a;
    if (!b.ok) return fail('The new tab opened but the command was not typed: ' + (b.err || ''));
    markers.set(sid, handoff.writeMarker(sid, { state: 'resumed', resumedAt: new Date().toISOString(), resumeSurfaceId: made.surfaceId, resumeSurfaceRef: made.surfaceRef, resumeCommand: cmd, resumeCwd: cwd }));
    if (runningPlan) {
      try {
        const proj = findProject(owner.id);
        const bp = proj && registry.briefPath(proj);
        const n = bp ? planrun.writePickup(bp, runningPlan.title) : null;
        if (n) console.log(`plans: "${runningPlan.title}" picked up after a hand-off at step ${n}`);
      } catch (e) { console.error('plans: pick-up log:', e.message); }
    }
    console.log(`hand-off: fresh session for ${sid} in ${whereRef} (${made.surfaceRef})`);
    wantTick = true;
    return { ok: true, surfaceRef: made.surfaceRef };
  } finally {
    starting.delete(sid);
  }
}

// The terminal a session ran in, for its fresh session: its events say
// (iTerm2 with its session as `near`), else the tab its marker names, else
// cmux as before.
function sessionTerminal(sid, m) {
  const e = ev.all.get(sid);
  if (e && e.terminal && e.terminal !== 'cmux') return { kind: e.terminal, near: term.tabIdFor(e.terminal, e.terminalId) };
  if (!(e && e.terminal) && m && m.surfaceId && term.kindOf(m.surfaceId) !== 'cmux') return { kind: term.kindOf(m.surfaceId), near: m.surfaceId };
  if (e && e.terminal === 'cmux') return { kind: 'cmux', near: null };
  // Nothing says where: the board's own terminal.
  return { kind: term.BOARD, near: null };
}

// Each written hand-off gets its fresh session once, when the terminal it
// goes to answers this tick (a cmux hand-off waits while cmux is down, an
// iTerm2 one while iTerm2 cannot be asked).
function autoStarts(workspaces, cmuxOk) {
  if (reg.settings.handoffAutoStart === false) return;
  for (const [sid, m] of markers) {
    if (m.state === 'written' && !m.resumeStartedAt && !starting.has(sid)) {
      const k = sessionTerminal(sid, m).kind;
      if (k === 'cmux' && term.canDrive('cmux') ? !cmuxOk : term.canDrive(k) && otherTabs[k] && !otherTabs[k].ok) continue;
      startFresh(sid, workspaces).catch((e) => console.error('hand-off start:', e.message));
    }
  }
}

// "Hand off now": a request marker the hook acts on at the next stop.
function requestHandoff({ projectId, surfaceId }) {
  const p = snapshot.projects.find((x) => x.id === projectId);
  if (!p) return { ok: false, status: 404, error: 'No such project.' };
  const s = p.sessions.find((x) => x.surfaceId === surfaceId) || p.sessions.find((x) => x.surfaceId === p.primary);
  if (!s || !s.sessionId) return { ok: false, status: 409, error: 'No Claude session to hand off here.' };
  const prev = handoff.readMarker(s.sessionId);
  if (prev && (prev.state === 'written' || prev.state === 'resumed')) return { ok: false, status: 409, error: 'This session has already handed off.' };
  const now = new Date().toISOString();
  const m = handoff.writeMarker(s.sessionId, {
    state: prev && prev.state === 'requested' ? 'requested' : 'queued',
    manualAt: now, queuedAt: (prev && prev.queuedAt) || now,
    workspaceId: (prev && prev.workspaceId) || s.workspaceId, surfaceId: (prev && prev.surfaceId) || s.surfaceId,
  });
  markers.set(s.sessionId, m);
  wantTick = true;
  return { ok: true, state: m.state, atRest: !s.working && !s.dialog };
}

// ------------------------------------------------------------ actions

// A tab of the project's in the board's own terminal (iTerm2 mode), so a
// new one opens in the same window: its primary session's, else any.
function nearTab(projectId) {
  if (term.BOARD === 'cmux') return null;
  const p = snapshot.projects.find((x) => x.id === projectId);
  const mine = p ? p.sessions.filter((x) => x.terminal && x.term === term.BOARD) : [];
  const s = mine.find((x) => x.surfaceId === p.primary) || mine[0];
  return s ? s.surfaceId : null;
}

// A registered project, else this tick's card for a loose session.
function findProject(id) {
  return (reg && reg.projects.find((p) => p.id === id && !p.hidden)) || loose.find((p) => p.id === id) || null;
}

function escapePath(p) {
  return /[\s'"\\()&;|<>$`]/.test(p) ? p.replace(/([\s'"\\()&;|<>$`])/g, '\\$1') : p;
}

// Every write into a terminal goes through here.
// Smart punctuation back to what a shell expects: em dash to "--", en dash
// to "-", curly quotes to straight ones, a no-break space to a space.
export function plainCommand(s) {
  return String(s)
    .replace(/—/g, '--').replace(/–/g, '-')
    .replace(/[“”„«»]/g, '"').replace(/[‘’‚]/g, "'")
    .replace(/ /g, ' ');
}

async function sendMessage({ projectId, surfaceId, text, paths, choice }) {
  const project = findProject(projectId);
  if (!project) return { ok: false, status: 404, error: 'No such project.' };
  let tab;
  if (term.kindOf(surfaceId) === 'cmux') {
    const workspaces = await term.cmux.listWorkspaces();
    const ws = workspaces.find((w) => (project.workspaces || []).includes(w.id) && w.surfaces.some((s) => s.id === surfaceId));
    if (!ws) return { ok: false, status: 400, error: "That session is not in this project's workspaces." };
    tab = { kind: 'cmux', workspaceId: ws.id, surfaceId };
  } else {
    // Another terminal's tab (iTerm2): the board must show it in this
    // project, and the terminal must list it now.
    const snap = snapshot.projects.find((x) => x.id === projectId);
    if (!snap || !snap.sessions.some((x) => x.surfaceId === surfaceId && x.terminal)) return { ok: false, status: 400, error: 'That session is not in this project.' };
    let t = null;
    try { t = await freshTab(surfaceId); } catch (e) { return { ok: false, status: 502, error: String(e.message || e) }; }
    if (!t) return { ok: false, status: 409, error: `That ${term.nameOf(term.kindOf(surfaceId))} tab is closed, so nothing was typed.` };
    tab = t;
  }
  const where = term.nameOf(tab.kind);
  // Fresh look at the screen, never the cached one.
  const screen = parseScreen(await term.readScreen(tab, 40));
  const anySurface = project.sendToAnySurface === true; // test registry only
  if (!screen.claudeLive && !anySurface) return { ok: false, status: 409, error: 'No Claude session is running in that tab, so nothing was typed.' };
  if (screen.draft && !anySurface) return { ok: false, status: 409, error: `There is half-typed text in its prompt. Finish it in ${where} so it is not mixed in.` };
  if (screen.dialog && !anySurface) {
    if (choice == null) return { ok: false, status: 409, error: `A choice is open on screen. Pick one of its options, or answer in ${where}.` };
    // Arrow keys to the option, then Enter, each step read back from the
    // screen (server/choose.mjs): some menus ignore the option's digit.
    const r = await chooseOption({
      read: () => term.readScreen(tab, 40),
      key: (k) => term.pressKey(tab, k),
      want: choice,
      where,
    });
    wantTick = true;
    if (!r.ok) {
      console.log(`choose: option ${choice} in ${project.id} not taken (${r.keys.join(' ') || 'no keys'}): ${r.error}`);
      return { ok: false, status: r.status, error: r.error };
    }
    console.log(`choose: "${r.sent}" taken in ${project.id} (${r.keys.join(' ')}; menu ${r.after})`);
    return { ok: true, delivered: 'now', sent: r.sent, after: r.after };
  }
  let msg = String(text || '').trim();
  const ps = (paths || []).map(String).filter(Boolean);
  if (ps.length) msg = (msg ? msg + ' ' : '') + ps.map(escapePath).join(' ');
  if (!msg) return { ok: false, status: 400, error: 'Type something or add a file first.' };
  // "! command" is Claude Code's bash mode. The prompt only enters it on a
  // TYPED "!"; pasted, the "!" stays in the command and the shell reads it as
  // "negate" (`! cd x && gh ...` ran nothing and exited 1). So type the "!",
  // give the prompt a moment to switch, then paste the command after it.
  const asked = msg;
  const bang = /^!\s*/.exec(msg);
  if (bang && msg.length > bang[0].length) {
    const k = await term.typeText(tab, '!');
    if (!k.ok) return { ok: false, status: 500, error: k.err || `${where} refused the text.` };
    await new Promise((r) => setTimeout(r, 150));
    // A shell command must reach the shell as typed. Text fields (macOS
    // smart punctuation, phone keyboards) turn "--" into an em dash and
    // quotes into curly ones, which breaks the command ("—otp=..." was read
    // as a tag name), so put the plain characters back.
    msg = plainCommand(msg.slice(bang[0].length));
  }
  const a = await term.pasteText(tab, msg);
  if (!a.ok) return { ok: false, status: 500, error: a.err || `${where} refused the text.` };
  await new Promise((r) => setTimeout(r, 120));
  const b = await term.pressKey(tab, 'enter');
  if (!b.ok) return { ok: false, status: 500, error: b.err || `${where} refused Enter.` };
  wantTick = true;
  return { ok: true, delivered: screen.working ? 'after its current step' : 'now', sent: asked };
}

function safeName(name) {
  let n = path.basename(String(name || 'file')).replace(/[^\w.@+-]+/g, '-').replace(/^-+/, '').slice(0, 120) || 'file';
  if (/^image\.(png|jpe?g|gif|webp)$/i.test(n)) {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    n = `screenshot-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${path.extname(n)}`;
  }
  return n;
}

function saveToInbox(project, name, buf) {
  if (!project.folder || !fs.existsSync(project.folder)) throw new Error('The project folder does not exist.');
  const dir = path.join(project.folder, '.inbox');
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Files dropped on Ravenry. Kept out of git.\n*\n');
  const base = safeName(name);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let file = path.join(dir, base);
  for (let k = 2; fs.existsSync(file); k++) file = path.join(dir, `${stem}-${k}${ext}`);
  fs.writeFileSync(file, buf, { flag: 'wx' });
  return file;
}

// ------------------------------------------------------------ http

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Only this board may write: a page on another site (or a rebinding DNS
// name) must never be able to type into the user's sessions. The Mac writes
// through a loopback name; a signed-in phone writes through the LAN address
// it opened (the Host check in the request handler already vetted it).
function allowedWrite(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (!req.mcPhone && !new RegExp(`^(localhost|127\\.0\\.0\\.1|\\[::1\\]):${PORT}$`).test(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin.toLowerCase() !== `http://${host}`) return false;
  // X-Mission-Control is the header's name from before the rename (the board
  // was Mission Control): a page opened before it still sends that one.
  return req.headers['x-ravenry'] === '1' || req.headers['x-mission-control'] === '1';
}

async function jsonBody(req, limit = 1e6) {
  return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
}

function broadcast(event, obj) {
  const j = JSON.stringify(obj);
  for (const res of clients) res.write(`event: ${event}\ndata: ${j}\n\n`);
}

ideas.onChange(() => { broadcast('ideas', ideas.view()); wantTick = true; });
alerts.onChange(() => { wantTick = true; setTimeout(tick, 30); });

// Where an alert's tap opens the board: the Mac's Wi-Fi address, where the
// phone's sign-in cookie lives. MC_ALERT_BOARD_URL replaces it in tests.
function boardUrl() {
  if (process.env.MC_ALERT_BOARD_URL) return process.env.MC_ALERT_BOARD_URL;
  const lan = phone.lanAddresses()[0];
  return lan ? `http://${lan.address}:${PORT}/` : null;
}

// Phone alerts' writes. The switch and Send a test are for any signed-in
// page; reading or changing a token, webhook or topic is for the Mac only.
async function alertsWrite(req, res, p) {
  const local = !!req.mcLocal;
  let body = {};
  try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
  const answer = (r) => sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? { ...r, ...alerts.status() } : { error: r.error });
  if (p === '/api/alerts/switch') return answer(alerts.setEnabled(!!body.enabled));
  // The bell: Mac notifications on or off (server/desktop.mjs), from any page.
  if (p === '/api/alerts/desktop') return answer(alerts.setDesktop(!!body.enabled));
  if (p === '/api/alerts/test') return answer(await alerts.sendTest(local ? body.channel || null : null, boardUrl()));
  if (!local) return sendJson(res, 403, { error: alerts.PHONE_REFUSED });
  if (p === '/api/alerts/telegram') return answer(await alerts.saveTelegramToken(body.token));
  if (p === '/api/alerts/telegram/find-chat') return answer(await alerts.findTelegramChat());
  if (p === '/api/alerts/webhook') return answer(alerts.saveWebhook(body.url));
  if (p === '/api/alerts/ntfy') return answer(alerts.setNtfyServer(body.server));
  if (p === '/api/alerts/ntfy/new-topic') return answer(alerts.newTopic());
  if (p === '/api/alerts/ntfy/copy') return answer(await alerts.copyTopic());
  if (p === '/api/alerts/done') return answer(alerts.choose(String(body.channel || ''), !!body.enable));
  return sendJson(res, 404, { error: 'unknown' });
}

const alertsQr = (link) => phone.qrSvg(link, 156, 'QR code that subscribes the ntfy app to your topic');

function shipProjects() {
  return reg.projects.filter((p) => !p.hidden).map((p) => ({ ...p, state: (snapshot.projects.find((x) => x.id === p.id) || {}).state || null }));
}

async function refreshShip() {
  if (!reg) return null;
  try {
    const v = await shipView(shipProjects(), briefFor);
    shipWaiting = v.totals.waitingYou || null;
    return v;
  } catch (e) {
    console.error('ship:', e.message);
    return null;
  }
}

function afterRegistry(r) {
  if (r) reg = r;
  wantTick = true;
  setTimeout(tick, 30);
}

// New project's Folder row: the folders the board knows, most recently
// active first, and which names under the projects root are already taken
// by a folder with files in it (the New folder hint says so).
function projectFolders() {
  const c = cfg();
  const r = registry.load() || reg || { projects: [] };
  const nowIso = new Date().toISOString();
  const lastActive = (p) => {
    const s = snapshot.projects.find((x) => x.id === p.id);
    if (!s) return '';
    return s.state === 'work' ? nowIso : s.since || '';
  };
  return { ...create.knownFolders(r, lastActive), projectsRoot: short(c.projectsRoot), taken: create.takenIn(c.projectsRoot) };
}

// The folder path in a project's header opens the folder in Finder, on the
// Mac only. Only the registered folder of the project named, never a path
// from the page. MC_OPEN_COMMAND (JSON argv, the folder appended) replaces
// `open` in tests; a test board (RAVENRY_HOME or MC_HOME set) never runs the
// real `open` without MC_OPEN_REAL=1, so no test opens a Finder window.
// `pre` goes before the path (["-R"] reveals a file in its folder).
function openFolder(folder, pre = []) {
  const stub = process.env.MC_OPEN_COMMAND ? JSON.parse(process.env.MC_OPEN_COMMAND) : null;
  if (!stub && HOME_OVERRIDE && process.env.MC_OPEN_REAL !== '1') return Promise.resolve({ ok: false, status: 503, error: 'A test board does not open Finder. Set MC_OPEN_COMMAND or MC_OPEN_REAL=1.' });
  const [cmd, ...args] = stub || ['/usr/bin/open'];
  return new Promise((resolve) => {
    execFile(cmd, [...args, ...pre, folder], { timeout: 10000 }, (err, _out, stderr) => {
      resolve(err ? { ok: false, status: 500, error: `Finder did not open it: ${(String(stderr || '').trim().split('\n').pop() || err.message).slice(0, 160)}` } : { ok: true });
    });
  });
}

// The Ideas, project and rules writes. Returns true when it answered.
async function phaseD(req, res, p) {
  const c = cfg();
  const fail = (e) => sendJson(res, e.status || 500, { error: e.message || String(e) });
  if (p === '/api/project/new') {
    const body = await jsonBody(req);
    const r = await create.createProject(body, { cfg: c, settings: reg.settings, reserve });
    if (r.reg) afterRegistry(r.reg);
    if (r.ok && body.ideaId) { try { ideas.promoted(String(body.ideaId), r.id); } catch { /* idea gone */ } }
    const { reg: _r, ...out } = r;
    return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? out : { error: r.error, code: r.code, folder: r.folder });
  }
  if (p === '/api/project/open-folder') {
    // Finder opens on the Mac's screen: never for a phone.
    if (!req.mcLocal) return sendJson(res, 403, { error: 'Only the Mac can open a folder in Finder.' });
    let body = {};
    try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
    const project = findProject(body.projectId);
    if (!project) return sendJson(res, 404, { error: 'No such project.' });
    let isDir = false;
    try { isDir = !!project.folder && path.isAbsolute(project.folder) && fs.statSync(project.folder).isDirectory(); } catch { /* gone */ }
    if (!isDir) return sendJson(res, 409, { error: project.folder ? `${project.name}'s folder is not on disk: ${short(project.folder)}.` : `${project.name} has no folder.` });
    const r = await openFolder(project.folder);
    if (!r.ok) return sendJson(res, r.status || 500, { error: r.error });
    return sendJson(res, 200, { ok: true, folder: short(project.folder) });
  }
  if (p === '/api/project/reveal-picture') {
    // The gallery's Show in Finder (docs/design/Gallery.dc.html, B): `open
    // -R` on one of the project's current pictures, named by its key and
    // re-checked against the picture rules now, never a path from the page.
    if (!req.mcLocal) return sendJson(res, 403, { error: 'Only the Mac can show a picture in Finder.' });
    let body = {};
    try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
    const project = findProject(body.projectId);
    if (!project) return sendJson(res, 404, { error: 'No such project.' });
    const abs = pictures.revealable(project.id, body.key);
    if (!abs) return sendJson(res, 404, { error: 'That is not one of this session\'s pictures now.' });
    const r = await openFolder(abs, ['-R']);
    if (!r.ok) return sendJson(res, r.status || 500, { error: r.error });
    return sendJson(res, 200, { ok: true, path: short(abs) });
  }
  if (p === '/api/project/choose-folder') {
    // Finder's dialog opens on the Mac's screen: never for a phone.
    if (!req.mcLocal) return sendJson(res, 403, { error: 'Only the Mac can open Finder\'s folder dialog.' });
    let body = {};
    try { body = await jsonBody(req, 1e4); } catch { /* no body: a project folder */ }
    const r = await create.chooseFolder({ purpose: body.purpose });
    if (!r.ok) return sendJson(res, r.status || 500, { error: r.error });
    if (r.cancelled) return sendJson(res, 200, { ok: true, cancelled: true });
    const chk = create.checkExistingFolder(r.path);
    if (!chk.ok) return sendJson(res, 400, { error: chk.error });
    const entry = create.folderEntry(chk.folder, (registry.load() || reg).projects, { fromFinder: true });
    // "Change for this one": the names already taken in that parent too.
    return sendJson(res, 200, { ok: true, entry, ...(body.purpose === 'parent' ? { taken: create.takenIn(chk.folder) } : {}) });
  }
  if (p === '/api/project/brief') {
    const body = await jsonBody(req);
    const project = findProject(body.projectId);
    if (!project) return sendJson(res, 404, { error: 'No such project.' });
    const r = create.writeBrief(project, body);
    if (r.ok) afterRegistry(r.reg);
    const { reg: _r, ...out } = r;
    return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? out : { error: r.error });
  }
  if (p === '/api/project/revive') {
    const body = await jsonBody(req);
    const project = findProject(body.projectId);
    if (!project) return sendJson(res, 404, { error: 'No such project.' });
    const r = await create.revive(project, { cfg: c, settings: reg.settings, reserve, near: nearTab(project.id) });
    if (r.ok) afterRegistry(r.reg);
    const { reg: _r, ...out } = r;
    return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? out : { error: r.error });
  }
  if (p === '/api/ideas/add') {
    try { const it = ideas.add(await jsonBody(req)); return sendJson(res, 200, { ok: true, id: it.id }); } catch (e) { return fail(e); }
  }
  if (p === '/api/ideas/brainstorm') {
    try { const b = ideas.brainstorm((await jsonBody(req)).seed, c); return sendJson(res, 200, { ok: true, brainstorm: b }); } catch (e) { return fail(e); }
  }
  if (p === '/api/ideas/brainstorm/clear') {
    ideas.clearBrainstormError();
    return sendJson(res, 200, { ok: true });
  }
  let m;
  if ((m = p.match(/^\/api\/ideas\/([\w-]+)\/(update|kill|say|image|ref)$/))) {
    const [, id, act] = m;
    try {
      if (act === 'update') { ideas.update(id, await jsonBody(req)); return sendJson(res, 200, { ok: true }); }
      if (act === 'kill') { ideas.kill(id); return sendJson(res, 200, { ok: true }); }
      if (act === 'say') { const b = await jsonBody(req); ideas.say(id, b.text, b.images, c); return sendJson(res, 200, { ok: true }); }
      const buf = await readBody(req, 32 * 1024 * 1024);
      const file = ideas.savePicture(id, decodeURIComponent(req.headers['x-filename'] || 'picture'), buf, { asReference: act === 'ref' });
      return sendJson(res, 200, { ok: true, file, url: `/api/ideas/img/${encodeURIComponent(file)}` });
    } catch (e) { return fail(e); }
  }
  if ((m = p.match(/^\/api\/ideas\/([\w-]+)\/mockups(?:\/(stop|pick))?$/))) {
    const [, id, act] = m;
    try {
      const b = await jsonBody(req, 1e5);
      if (act === 'stop') return sendJson(res, 200, { ok: true, stopped: ideas.stopMockups(id) });
      if (act === 'pick') { ideas.pickMockup(id, b); return sendJson(res, 200, { ok: true }); }
      const job = ideas.startMockups(id, { note: b.note, from: b.from }, c);
      return sendJson(res, 200, { ok: true, round: job.round });
    } catch (e) { return fail(e); }
  }
  if ((m = p.match(/^\/api\/repeats\/([\w.-]+)$/))) {
    try {
      const body = await jsonBody(req);
      if (!['reword', 'add', 'every', 'notnow'].includes(body.action)) return sendJson(res, 400, { error: 'Unknown action.' });
      const r = repeats.decide(m[1], body.action, c);
      wantTick = true;
      return sendJson(res, 200, { ok: true, action: r.action, target: (r.target || []).map(short), backup: (r.backup || []).filter(Boolean).map(short), already: !!r.already });
    } catch (e) { return fail(e); }
  }
  if ((m = p.match(/^\/api\/rules\/([\w.-]+)$/))) {
    try {
      const body = await jsonBody(req);
      const r = rules.decide(m[1], body.action, c);
      wantTick = true;
      return sendJson(res, 200, { ok: true, target: (r.target || []).map(short), backup: [].concat(r.backup || []).filter(Boolean).map(short), already: !!r.already });
    } catch (e) { return fail(e); }
  }
  return false;
}


// ------------------------------------------------------------ plans
// docs/design/Plans.dc.html: drafting a plan together (server/planner.mjs),
// writing it into the brief and running it (server/planrun.mjs).

planner.onChange((id) => { broadcast('plan', { projectId: id, draft: planner.view(id) }); });

function planBrief(project) {
  const file = registry.briefPath(project);
  return file && fs.existsSync(file) ? { file, brief: readBrief(file) } : { file: null, brief: null };
}

// Hands words to the project's session: typed into it when it is live at its
// prompt (the composer's send path), else a new session through Revive with
// the words as its prompt. `mode`: 'start' refuses a working session (a plan
// must not land in the middle of other work); 'note' (pause, stop) needs no
// session; 'answer' may queue behind a working step.
async function deliverPlan(project, text, mode) {
  const p = snapshot.projects.find((x) => x.id === project.id);
  const s = p ? p.sessions.find((x) => x.surfaceId === p.primary) || p.sessions.find((x) => x.live) || null : null;
  if (s && s.live && s.terminal !== false) {
    if (s.dialog) return { ok: false, status: 409, error: 'A choice is open in its tab. Answer it first, then try again.' };
    if (s.draft) return { ok: false, status: 409, error: `There is half-typed text in its prompt. Finish or clear it in ${s.termName || term.nameOf(term.BOARD)} first.` };
    if (s.working && mode === 'start') return { ok: false, status: 409, error: 'Its session is working on something else. Start the plan when it is back at its prompt.' };
    const r = await sendMessage({ projectId: project.id, surfaceId: s.surfaceId, text });
    return r.ok ? { ...r, via: 'session', surfaceId: s.surfaceId } : r;
  }
  if (mode === 'note') return { ok: true, via: 'brief' };
  const r = await create.revive(project, { cfg: cfg(), settings: reg.settings, reserve, prompt: text, near: nearTab(project.id) });
  if (r.ok) afterRegistry(r.reg);
  const { reg: _r, ...out } = r;
  return r.ok ? { ...out, via: 'revive' } : out;
}

function preflight(project, mode) {
  const p = snapshot.projects.find((x) => x.id === project.id);
  const s = p ? p.sessions.find((x) => x.surfaceId === p.primary) || null : null;
  if (s && s.live && s.terminal !== false) {
    if (s.dialog) return 'A choice is open in its tab. Answer it first, then start the plan.';
    if (s.draft) return `There is half-typed text in its prompt. Finish or clear it in ${s.termName || term.nameOf(term.BOARD)} first.`;
    if (s.working && mode === 'start') return 'Its session is working on something else. Start the plan when it is back at its prompt.';
  }
  return null;
}

async function planWrite(req, res, p) {
  let body;
  try { body = await jsonBody(req, 2e5); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
  const project = findProject(body.projectId);
  if (!project) return sendJson(res, 404, { error: 'No such project.' });
  const c = cfg();
  const fail = (e) => sendJson(res, e.status || 500, { error: e.message || String(e) });
  const ok = (extra = {}) => sendJson(res, 200, { ok: true, draft: planner.view(project.id), ...extra });
  const { file, brief } = planBrief(project);
  const act = p.slice('/api/plan/'.length);
  try {
    if (act === 'draft') { planner.start(project, brief, { goal: body.goal, files: body.files }, c); return ok(); }
    if (act === 'own') { planner.start(project, brief, { own: body.text, files: body.files }, c); return ok(); }
    if (act === 'revise') { planner.revise(project, brief, { comment: body.comment || null, message: body.message || null, files: body.files }, c); return ok(); }
    if (act === 'edit') { planner.edit(project, brief, { answer: body.answer || null, order: body.order || null, remove: body.remove || null }, c); return ok(); }
    if (act === 'halt') { planner.stop(project.id); return ok(); }
    if (act === 'discard') { planner.discard(project.id); return ok(); }
    if (act === 'change') {
      const live = brief && brief.plan.find((o) => o.plan && o.title === (snapshot.projects.find((x) => x.id === project.id)?.plan?.title));
      if (!live) return sendJson(res, 409, { error: 'No plan is running in this project.' });
      planner.fromPlan(project, live);
      return ok();
    }
    if (act === 'start') {
      const d = planner.get(project.id);
      if (!d || !d.steps.length) return sendJson(res, 409, { error: 'There is no plan to start.' });
      if (d.busy) return sendJson(res, 409, { error: 'Claude is still on the last change.' });
      if (d.questions.some((q) => q.answer == null)) return sendJson(res, 409, { error: 'Answer the open questions first.' });
      let title = d.written;
      if (!title) {
        const why = d.mode === 'change' ? null : preflight(project, 'start');
        if (why) return sendJson(res, 409, { error: why });
        const w = planrun.writeStart(file, d);
        title = w.title;
        d.written = title;
        console.log(`plans: ${d.mode === 'change' ? 'changed' : 'started'} "${title}" for ${project.name} in ${short(file)} (backup ${short(w.backup)})`);
      }
      wantTick = true;
      // The References go with the words, so the session reads them first.
      const refs = planrun.draftRefs(d);
      const text = d.mode === 'change' ? planrun.changedPrompt(project, file, title, refs) : planrun.startPrompt(project, file, title, refs);
      const r = await deliverPlan(project, text, d.mode === 'change' ? 'note' : 'start');
      if (!r.ok) {
        // The plan is in the brief; Start again only delivers it.
        planner.markWritten(project.id, title);
        return sendJson(res, r.status || 500, { error: `The plan is in the brief, but it did not reach the session: ${r.error}`, written: title });
      }
      planner.discard(project.id);
      setTimeout(tick, 30);
      return sendJson(res, 200, { ok: true, title, via: r.via, delivered: r.delivered || null });
    }
    const snapPlan = snapshot.projects.find((x) => x.id === project.id)?.plan;
    if (!file || !snapPlan) return sendJson(res, 409, { error: 'No plan is running in this project.' });
    if (act === 'answer') {
      const msg = planrun.writeAnswer(project, file, snapPlan.title, { choice: body.choice || null, text: body.text || null });
      wantTick = true;
      const r = await deliverPlan(project, msg, 'answer');
      setTimeout(tick, 30);
      if (!r.ok) return sendJson(res, r.status || 500, { error: `Your answer is written in the brief, but it did not reach the session: ${r.error}` });
      return sendJson(res, 200, { ok: true, via: r.via, delivered: r.delivered || null, sent: body.choice || body.text });
    }
    if (act === 'pause' || act === 'stop' || act === 'resume') {
      const msg = planrun.writeState(project, file, snapPlan.title, act === 'pause' ? 'paused' : act === 'stop' ? 'stopped' : 'running');
      wantTick = true;
      const r = await deliverPlan(project, msg, act === 'resume' ? 'start' : 'note');
      setTimeout(tick, 30);
      if (!r.ok) return sendJson(res, r.status || 500, { error: `The plan reads ${act === 'pause' ? 'paused' : act === 'stop' ? 'stopped' : 'running'} in the brief, but the session did not get the message: ${r.error}` });
      return sendJson(res, 200, { ok: true, via: r.via });
    }
    return sendJson(res, 404, { error: 'unknown' });
  } catch (e) { return fail(e); }
}

// A proof's picture: only a path a Proof line of this project's plan names,
// or one of its References (or of the draft being planned), and only while
// it passes the picture rules (the project's folder or its current
// session's scratchpad, 15 MB, 30 days; server/pictures.mjs).
function planPicture(project, rel) {
  const snap = snapshot.projects.find((x) => x.id === project.id);
  if (!snap || !rel) return null;
  const proof = !!snap.plan && snap.plan.steps.some((s) => s.proofs.some((x) => x.type === 'shot' && x.path === rel));
  const ref = (!!snap.plan && (snap.plan.refs || []).some((r) => r.path === rel)) || ((planner.get(project.id) || {}).refs || []).some((r) => r.rel === rel);
  if (!proof && !ref) return null;
  const prim = snap.sessions.find((x) => x.surfaceId === snap.primary);
  const roots = pictures.rootsFor(project.folder, prim && prim.sessionId ? [prim.sessionId] : []);
  const bp = registry.briefPath(project);
  const cands = rel.startsWith('~/') ? [path.join(HOME, rel.slice(2))] : path.isAbsolute(rel) ? [rel] : [project.folder && path.resolve(project.folder, rel), bp && path.resolve(path.dirname(bp), rel)].filter(Boolean);
  for (const abs of cands) { const f = pictures.checkFile(abs, roots); if (f) return f.abs; }
  return null;
}

// Phone access gate (server/phone.mjs). Returns true when it answered.
function gate(req, res, url) {
  if (!phone.hostOk(req.headers.host, PORT)) {
    res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Misdirected request: this board answers only to localhost or its own Wi-Fi address.\n');
    return true;
  }
  if (phone.isLoopback(req)) { req.mcLocal = true; return false; }
  if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('k')) {
    phone.signIn(req, res, url.searchParams.get('k') || '');
    return true;
  }
  const c = phone.check(req);
  if (c.ok) { req.mcPhone = c.hash; return false; }
  const page = req.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('.html'));
  if (page) phone.signedOutPage(res, 401, c.had ? phone.SIGNED_OUT : phone.NOT_SIGNED_IN);
  else sendJson(res, 401, { error: phone.SIGNED_OUT, signedOut: true });
  return true;
}

// The QR card and New key: the Mac only, never a phone.
function phoneCard() { return { ok: true, ...phone.card(PORT) }; }

// After New key, live streams held by phones end, so their pages find out.
function dropPhoneStreams() {
  for (const res of clients) if (res.mcPhone) { clients.delete(res); try { res.end(); } catch { /* gone */ } }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (gate(req, res, url)) return;
    if (req.method === 'GET' && p === '/api/whoami') return sendJson(res, 200, { local: !!req.mcLocal });
    if (p === '/api/phone' || p.startsWith('/api/phone/')) {
      if (!req.mcLocal) return sendJson(res, 403, { error: 'Only the Mac shows the phone code.' });
      if (req.method === 'GET' && p === '/api/phone') return sendJson(res, 200, phoneCard());
      if (req.method === 'POST' && p === '/api/phone/new-key') {
        if (!allowedWrite(req)) return sendJson(res, 403, { error: 'Writes are only accepted from the board itself.' });
        phone.rotate();
        dropPhoneStreams();
        return sendJson(res, 200, phoneCard());
      }
      return sendJson(res, 404, { error: 'unknown' });
    }
    if (req.method === 'GET' && p === '/api/state') return sendJson(res, 200, snapshot);
    if (req.method === 'GET' && p === '/api/live') {
      const r = await liveScreen(url.searchParams.get('surface') || '', url.searchParams.get('v'));
      return sendJson(res, r.status, r.body);
    }
    if (req.method === 'GET' && p === '/api/settings/projects-root') return sendJson(res, 200, { ok: true, local: !!req.mcLocal, ...projectsRoot.view(registry.load() || reg) });
    if (req.method === 'GET' && p === '/api/settings/handoff') return sendJson(res, 200, { ok: true, settings: registry.handoffSettings(registry.load()?.settings) });
    if (req.method === 'GET' && p === '/api/alerts') return sendJson(res, 200, { ok: true, local: !!req.mcLocal, ...alerts.status() });
    if (req.method === 'GET' && p === '/api/alerts/setup') {
      if (!req.mcLocal) return sendJson(res, 403, { error: alerts.PHONE_REFUSED });
      return sendJson(res, 200, { ok: true, local: true, ...alerts.setupView(alertsQr) });
    }
    if (req.method === 'GET' && p === '/api/meta') {
      const c = cfg();
      return sendJson(res, 200, { kinds: create.KINDS, globalRules: rules.globalHeadings(c), globalPath: short(c.globalClaudeMd), projectsRoot: short(c.projectsRoot), launchCommand: c.launchCommand });
    }
    if (req.method === 'GET' && p === '/api/project/folders') return sendJson(res, 200, projectFolders());
    if (req.method === 'GET' && p === '/api/plan/draft') {
      const project = findProject(url.searchParams.get('projectId') || '');
      if (!project) return sendJson(res, 404, { error: 'No such project.' });
      return sendJson(res, 200, { ok: true, draft: planner.view(project.id) });
    }
    if (req.method === 'GET' && p === '/api/ideas') return sendJson(res, 200, ideas.view());
    if (req.method === 'GET' && p.startsWith('/api/ideas/img/')) {
      const abs = ideas.picturePath(decodeURIComponent(p.slice(15)));
      if (!abs) return sendJson(res, 404, { error: 'no such picture' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
      return fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/rules/mine') return sendJson(res, 200, repeats.mine(cfg()));
    if (req.method === 'GET' && p === '/api/rules/repeats') {
      const c = cfg();
      // A board that never ran the detector loads the seed on first look
      // (plain reads, no model call).
      if (!repeats.load().state.seeded && !repeats.isSeeding()) repeats.ensureSeed(c).then(() => { wantTick = true; }).catch((e) => console.error('repeats seed:', e.message));
      const v = repeats.view(c);
      return sendJson(res, 200, { ...v, memoryMore: rules.pendingCount(c) });
    }
    if (req.method === 'GET' && p === '/api/rules') return sendJson(res, 200, rules.list(cfg(), { fresh: url.searchParams.has('fresh') }));
    if (req.method === 'GET' && p === '/api/ship') {
      const v = await refreshShip();
      return v ? sendJson(res, 200, v) : sendJson(res, 503, { error: 'Not ready yet.' });
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${snapshotJson}\n\n`);
      res.mcPhone = req.mcPhone || null;
      clients.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => { clients.delete(res); clearInterval(hb); });
      return;
    }
    if (req.method === 'GET' && p.startsWith('/api/pic/')) {
      const project = findProject(decodeURIComponent(p.slice(9)));
      if (url.searchParams.has('plan')) {
        const abs = project ? planPicture(project, url.searchParams.get('plan')) : null;
        if (!abs) return sendJson(res, 404, { error: 'not a picture of this plan' });
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs).toLowerCase()], 'Cache-Control': 'no-cache' });
        return fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
      }
      // The project's latest picture and the gallery's others: only one of
      // the current 6 (the pick without a key), re-checked now.
      if (url.searchParams.has('auto')) {
        const abs = project ? pictures.serveable(project.id, url.searchParams.get('auto'), url.searchParams.get('k')) : null;
        if (!abs) return sendJson(res, 404, { error: 'not the current picture' });
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs).toLowerCase()], 'Cache-Control': 'no-cache' });
        return fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
      }
      const bp = project && registry.briefPath(project);
      if (!bp) return sendJson(res, 404, { error: 'no brief' });
      const brief = readBrief(bp);
      const rel = url.searchParams.get('p');
      // Only pictures the brief lists, nothing else on disk.
      if (!brief || !brief.pictures.some((x) => x.path === rel)) return sendJson(res, 404, { error: 'not listed' });
      const abs = path.resolve(path.dirname(bp), rel);
      const type = TYPES[path.extname(abs).toLowerCase()];
      if (!type || !type.startsWith('image/')) return sendJson(res, 415, { error: 'not an image' });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
    }
    if (req.method === 'POST' && p.startsWith('/api/')) {
      if (!allowedWrite(req)) return sendJson(res, 403, { error: 'Writes are only accepted from the board itself.' });
      if (p.startsWith('/api/alerts/')) return alertsWrite(req, res, p);
      if (p.startsWith('/api/plan/')) return planWrite(req, res, p);
      if (await phaseD(req, res, p) !== false) return;
      if (p === '/api/hook-event') {
        // hooks/events.mjs: the event is on disk already; this makes the
        // board look now instead of at the next tick.
        let e = null;
        try { e = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { /* ignore */ }
        if (!events.ingest(e)) return sendJson(res, 400, { error: 'not a hook event' });
        wantTick = true; setTimeout(tick, 20);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/send') {
        const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
        const r = await sendMessage(body);
        return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? r : { error: r.error });
      }
      if (p.startsWith('/api/inbox/')) {
        const project = findProject(decodeURIComponent(p.slice(11)));
        if (!project) return sendJson(res, 404, { error: 'No such project.' });
        const buf = await readBody(req, 64 * 1024 * 1024);
        const file = saveToInbox(project, decodeURIComponent(req.headers['x-filename'] || 'file'), buf);
        return sendJson(res, 200, { ok: true, path: file, short: short(file) });
      }
      if (p === '/api/note') {
        const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
        const project = findProject(body.projectId);
        if (!project) return sendJson(res, 404, { error: 'No such project.' });
        const bp = registry.briefPath(project);
        if (!bp || !fs.existsSync(bp)) return sendJson(res, 409, { error: `${project.name} has no BRIEF.md yet, so there is nowhere to keep the note.` });
        const text = String(body.text || '').trim();
        if (!text) return sendJson(res, 400, { error: 'Type the note first.' });
        const line = appendNote(bp, text);
        wantTick = true; setTimeout(tick, 30);
        return sendJson(res, 200, { ok: true, line });
      }
      if (p === '/api/sessions/close') {
        const r = await closeSessions(await jsonBody(req, 1e5));
        return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? r : { error: r.error });
      }
      if (p === '/api/sessions/reopen') {
        const r = await reopenSession(await jsonBody(req, 1e5));
        return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? r : { error: r.error });
      }
      if (p === '/api/settings/projects-root') {
        // Where new projects go (server/projectsroot.mjs): Change and the
        // first-run answer, both on the Mac, where Finder's dialog opens.
        if (!req.mcLocal) return sendJson(res, 403, { error: 'Change it on the Mac. The folder dialog opens there.' });
        let body;
        try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        const r = projectsRoot.save(body.path, body.from);
        if (!r.ok) return sendJson(res, r.status || 500, { error: r.error });
        afterRegistry(r.reg);
        return sendJson(res, 200, { ok: true, ...projectsRoot.view(r.reg), backup: r.backup ? short(r.backup) : null });
      }
      if (p === '/api/settings/handoff') {
        // The Settings card. A signed-in phone may change these like any
        // other write; only the phone key stays Mac-only.
        let body;
        try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        const r = registry.saveHandoffSettings(body);
        if (!r.ok) return sendJson(res, r.status, { error: r.error });
        afterRegistry(r.reg);
        return sendJson(res, 200, { ok: true, settings: r.settings, backup: r.backup ? short(r.backup) : null });
      }
      if (p === '/api/handoff') {
        const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
        const r = requestHandoff(body);
        if (r.ok) setTimeout(tick, 30);
        return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? r : { error: r.error });
      }
      if (p === '/api/handoff/start') {
        const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
        const project = findProject(body.projectId);
        const snap = snapshot.projects.find((x) => x.id === body.projectId);
        const own = snap && snap.sessions.some((x) => x.sessionId === body.sessionId);
        if (!project || !own) return sendJson(res, 404, { error: 'No such session in that project.' });
        const r = await startFresh(body.sessionId, await term.cmux.listWorkspaces(), { force: true });
        return sendJson(res, r.ok ? 200 : 409, r.ok ? r : { error: r.error });
      }
      if (p === '/api/open') {
        const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
        const project = findProject(body.projectId);
        if (!project) return sendJson(res, 404, { error: 'No such project.' });
        if (body.surfaceId && term.kindOf(body.surfaceId) !== 'cmux') {
          // A session in iTerm2: bring that tab forward.
          const snap = snapshot.projects.find((x) => x.id === project.id);
          if (!snap || !snap.sessions.some((x) => x.surfaceId === body.surfaceId)) return sendJson(res, 404, { error: 'No such session in that project.' });
          const t = await freshTab(body.surfaceId).catch(() => null);
          if (!t) return sendJson(res, 409, { error: `That ${term.nameOf(term.kindOf(body.surfaceId))} tab is closed.` });
          const r = await term.focus(t);
          return sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, where: term.nameOf(t.kind) } : { error: r.err });
        }
        if (!term.canDrive('cmux')) return sendJson(res, 409, { error: `${project.name} has no open ${term.nameOf(term.BOARD)} tab. Revive it to start one.` });
        const workspaces = await term.cmux.listWorkspaces();
        const ws = workspaces.find((w) => (project.workspaces || []).includes(w.id) && (!body.surfaceId || w.surfaces.some((s) => s.id === body.surfaceId)))
          || workspaces.find((w) => (project.workspaces || []).includes(w.id));
        if (!ws) return sendJson(res, 409, { error: `${project.name} has no open cmux workspace.` });
        const surface = body.surfaceId && ws.surfaces.some((s) => s.id === body.surfaceId) ? body.surfaceId : null;
        const r = await term.focus({ kind: 'cmux', workspaceId: ws.id, surfaceId: surface });
        return sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.err });
      }
      return sendJson(res, 404, { error: 'unknown' });
    }
    if (req.method === 'GET') {
      let rel = p === '/' ? 'index.html' : p.slice(1);
      const abs = path.resolve(PUBLIC, rel);
      if (!abs.startsWith(PUBLIC + path.sep) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return fs.createReadStream(abs).pipe(res);
    }
    sendJson(res, 405, { error: 'method' });
  } catch (e) {
    console.error(req.method, p, e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
  }
});

// cmux reruns `npm start` when it restores this board's terminal, and a
// board may already hold the port (a second tab, a manual start). A board of
// this repo already serving is fine: say so in one line and exit cleanly
// instead of dying on an unhandled EADDRINUSE.
function portHolders() {
  const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch { return ''; } };
  return run('/usr/sbin/lsof', ['-tiTCP:' + PORT, '-sTCP:LISTEN']).split('\n').filter(Boolean).map((pid) => ({
    pid,
    command: run('/bin/ps', ['-o', 'command=', '-p', pid]).trim(),
    cwd: (run('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).split('\n').find((l) => l.startsWith('n')) || '').slice(1),
  }));
}

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  const holders = portHolders();
  const ours = holders.find((h) => h.command.includes(ROOT) || (h.cwd === ROOT && h.command.includes('server/index.mjs')));
  if (ours) {
    console.log(`Ravenry is already running on http://localhost:${PORT} (pid ${ours.pid}); this one exits.`);
    process.exit(0);
  }
  const h = holders[0];
  console.error(`:${PORT} is taken by ${h ? `pid ${h.pid} (${h.command})` : 'another process'}, not this board. Stop it or set PORT.`);
  process.exit(1);
});

// No host: every interface (IPv6 and IPv4), so a phone on the home Wi-Fi can
// open the board and a new DHCP address still works. server/phone.mjs decides
// who gets in.
// A board on a test's data never takes the real board's port: the real one
// would find it there, call it "already running" and exit.
if (SCRATCH_DATA && PORT === 4600) {
  console.error(`Refused: this board's data (${registry.RAVENRY_HOME}) is a test's, and :4600 is the real board's port. Set PORT.`);
  process.exit(1);
}
// The port goes in <RAVENRY_HOME>/board.json so the events hook nudges this
// board wherever it listens (PORT=4700 ravenry); removed when it stops.
const BOARD_FILE = path.join(registry.RAVENRY_HOME, 'board.json');
function forgetPort() { try { if (JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')).pid === process.pid) fs.rmSync(BOARD_FILE, { force: true }); } catch { /* gone */ } }
server.listen(PORT, () => {
  try { fs.mkdirSync(registry.RAVENRY_HOME, { recursive: true }); fs.writeFileSync(BOARD_FILE, JSON.stringify({ port: PORT, pid: process.pid, at: new Date().toISOString() }) + '\n'); } catch (e) { console.error('board.json:', e.message); }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { forgetPort(); process.exit(0); });
  process.once('exit', forgetPort);
  const lan = phone.lanAddresses()[0];
  console.log(`Ravenry on http://localhost:${PORT}${lan ? `, phones on http://${lan.address}:${PORT}` : ''}  (registry ${registry.REGISTRY_PATH})`);
});
tick();
setInterval(tick, TICK_MS);
setTimeout(refreshProcs, 1500);
setInterval(refreshProcs, 60000);
ideas.load();
setTimeout(refreshShip, 3000);
setInterval(refreshShip, 30000);
// The repeats detector (server/repeats.mjs): daily, and at start when the
// last run is older than a day. The real board seeds itself at start.
if (cfg().repeatsAuto) setTimeout(() => repeats.ensureSeed(cfg()).then(() => { wantTick = true; }).catch((e) => console.error('repeats seed:', e.message)), 5000);
repeats.schedule(cfg);

// cmux events only make the next refresh come sooner.
let soon = null;
if (process.env.MC_NO_EVENTS !== '1') {
  term.cmux.watchEvents(() => {
    if (soon) return;
    soon = setTimeout(() => { soon = null; tick(); }, 400);
  });
}

