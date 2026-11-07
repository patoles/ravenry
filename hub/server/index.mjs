// Ravenry server: polls cmux (and iTerm2 or Rex while a session runs there)
// every ~2 s through the terminal interface (server/terminal.mjs), or no
// cmux at all when the board runs in iTerm2 mode or Rex mode (term.BOARD), builds one
// snapshot of every project, serves it to the board (SSE), and carries the
// board's answers back into the right Claude surface.

// First: the start-up record (hub.log: phases, stalls; a CPU profile of a
// new version's first 90 s), so it covers every module's own loading too.
import * as startlog from './startlog.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';

import * as term from './terminal.mjs';
import * as access from './access.mjs';
import * as asst from './assistant.mjs';
import { markEntries, spansGen } from './codespans.mjs';
import * as registry from './registry.mjs';
import { readBrief, appendNote } from './brief.mjs';
import { sessionState, eventState, projectState, describe, plain } from './state.mjs';
import * as handoff from './handoff.mjs';
import { config } from './config.mjs';
import * as create from './create.mjs';
import * as ideas from './ideas.mjs';
import * as rules from './rules.mjs';
import * as repeats from './repeats.mjs';
import * as rulefiles from './rulefiles.mjs';
import { shipView } from './ship.mjs';
import { plansFor, onGitAnswer } from './plans.mjs';
import { ownerOf, repoRoot, isBroadFolder, onFolderScan } from './folders.mjs';
import * as events from './events.mjs';
import * as sess from './sessions.mjs';
import * as phone from './phone.mjs';
import * as phonetls from './phonetls.mjs';
import * as push from './push.mjs';
import * as termproxy from './termproxy.mjs';
import * as pictures from './pictures.mjs';
import * as alerts from './alerts.mjs';
import * as projectsRoot from './projectsroot.mjs';
import { activePlan, proofKind } from './planfmt.mjs';
import * as planner from './planner.mjs';
import * as planrun from './planrun.mjs';
import { HOME_OVERRIDE, SCRATCH_DATA, repoTmpPaths, inRepoTmp } from './home.mjs';
import * as hookinstall from './hookinstall.mjs';
import * as machines from './machines.mjs';
import * as remoteinstall from './remoteinstall.mjs';
import * as checkpoints from './checkpoints.mjs';
import * as gates from './gates.mjs';
import * as person from './person.mjs';
import * as sessionstart from './sessionstart.mjs';
import * as decisions from './decisions.mjs';
import * as worktrees from './worktrees.mjs';
import { projectFiles } from './filesview.mjs';
import * as reviews from './reviews.mjs';
import { paneRequest, paneInfo } from './ravenryd.mjs';
import * as picks from './picks.mjs';
import * as pages from './pages.mjs';
import { sayPath } from '../public/homepath.mjs';
import * as homes from './homes.mjs';

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
const screens = new Map();   // surfaceId -> { text, at, live, okAt, full, prompt, assistant }
// What each tab's prompt holds (Claude Code's suggested reply or typed
// text) is judged by the tab's assistant (server/assistant.mjs, judgeRead),
// which keeps the history of reads per tab.
// The Live screen (docs/design/LiveScreen.dc.html, B): the surfaces a board
// page is showing get 200 lines of scrollback per read; every other surface
// keeps the 40-line read. `text` is always the last 40 lines, so the state
// rules read exactly what they read before.
const LIVE_LINES = 200;
const SCREEN_LINES = 40;
const LIVE_WANT_MS = 10000;
const liveWant = new Map();  // surfaceId -> when a page last asked for it
// Tabs the board just opened for a new session (Revive, New session, a
// plan's words): read every tick until Claude shows in them, so the page
// can move to the new session at once. A plain shell is otherwise read
// every ~10 s, and a tab whose title does not look like Claude yet (Claude
// before it names its tab, Codex, which never does) stayed a shell that
// long.
const OPENING_MS = 60000;
const opening = new Map();   // surfaceId -> until when
function watchOpened(r) {
  if (r && r.ok && r.surfaceId) opening.set(r.surfaceId, Date.now() + OPENING_MS);
}
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
// Tabs of terminals that list their own (iTerm2, Rex), asked only while some
// session's events or some claude process place a session there:
// kind -> { ok, tabs: Map(id -> tab), error, asked }.
const otherTabs = {};
const targets = new Map();   // cwd|workspace -> { value, at }
const starting = new Set();  // sessionIds whose fresh session is being opened
const reserved = new Map();  // workspace name -> count: being opened by the board, never auto-imported
let shipWaiting = null;      // Ship badge: items waiting on the user in the briefs' Ship sections
let lastShip = null;         // the last Ship view (server/ship.mjs), for the pages' git provider
// Sessions page (docs/SESSIONS.md): every claude process, read once a minute.
let procState = { at: null, procs: [], helpers: 0, error: 'starting' };
let procBusy = null;
const extraScreens = new Map(); // surfaceId -> { text, at }: Claude tabs outside the board's projects
let lastWorkspaces = [];
let boardTabs = [];          // this tick's project sessions: { project, s, waitingOn }
let sessRows = [];           // the Sessions page rows, with what a close needs
let closing = false;
const reopening = new Set();
// Continue in Ravenry (POST /api/sessions/resume): sessionIds being resumed,
// and the pane each was resumed in (sessionId -> { at, surfaceId, pane }).
const resumeBusy = new Set();
const resumed = new Map();
// Move here / Keep it in <terminal> (POST /api/sessions/move): a move asked
// while the assistant was mid-turn, done by the tick once the turn ends
// (sessionId -> { body, since, name }), and the last move done for each
// session, shown for a minute (sessionId -> { at, keep, ended, surfaceId }).
const moves = new Map();
const movedLast = new Map();
// The hook pids of sessions in a terminal outside Ravenry that still run,
// asked each tick (server/sessions.mjs alivePids); null before the first.
let outsideAlive = null;
// sessionId -> { pane, pid }: the claude or codex processes that run in a
// ravenryd pane here, by the session each holds (the last process list).
let paneHolders = new Map();
const seenPanes = new Set(); // ravenryd panes listed so far
let procsSoon = null;
let lastResult = null;       // the last close, shown on the page for a while
let picBudget = 0;           // project pictures worked out this tick (server/pictures.mjs)
let loose = [];              // this tick's cards for sessions no project holds, in a too-broad folder
let unowned = [];            // this tick's cmux workspaces no project lists ("Not in a project")

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
  // Plans and Ideas run on the assistant new sessions start with
  // (server/assistant.mjs printWith): `claude -p` as before, or `codex exec`.
  c.printAssistant = asst.printWith(reg ? reg.settings : {});
  c.printSettings = reg ? reg.settings : {};
  return c;
}

// ------------------------------------------------------------ which assistant starts
// docs/ASSISTANTS.md, "Starting sessions".

// What a launch runs for a choice (asst.startChoice, continueChoice).
function launchFor(choice) {
  const settings = reg ? reg.settings : {};
  return { kind: choice.kind, command: asst.startCommand(choice.kind, settings), note: choice.note, short: asst.of(choice.kind).SHORT };
}

// The PATH a session pane starts an assistant with (server/sessionstart.mjs
// binPath): the folder its binary is in, first, then the board's own PATH
// (the service's has the usual install folders), or null when it is not here.
function assistantPath(name) {
  const dirs = [...String(process.env.PATH || '').split(':'), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local')].filter((d) => d && path.isAbsolute(d));
  const dir = dirs.find((d) => { try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return !/\/cmux-cli-shims(\/|$)/.test(d); } catch { return false; } });
  return dir ? [...new Set([dir, ...dirs])].join(':') : null;
}

// A new session for a project (Revive, New session, a plan's start): its
// own assistant, else startWith, else Claude Code, never its newest
// session's. A hand-off's fresh session keeps the assistant of the session
// it hands off from instead (the hand-off, below).
const continueLaunch = (project) => launchFor(asst.continueChoice(reg ? reg.settings : {}, project));

// The Settings view of it: what is set, what runs, what is installed.
function assistantsView() {
  const settings = reg ? reg.settings : {};
  const set = registry.assistantSettings(settings);
  const ch = asst.startChoice(settings);
  return { ...set, starts: ch.kind, installed: ch.installed, fallback: ch.fallback, note: ch.note, print: ch.kind, codex: ch.installed.codex ? asst.codexModel(settings) : null };
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

// The home folder of each machine, "" for this one, from what each remote
// ravenryd says in hello: clients say a machine's folders against its own
// home (public/homepath.mjs), and so do the phone's alerts.
function homesNow() {
  const out = { '': HOME };
  for (const m of machines.connected()) {
    const h = m.c && m.c.hello && m.c.hello.daemon && m.c.hello.daemon.home;
    if (h && !out[m.name]) out[m.name] = h;
  }
  homes.setHomes(out);
  return out;
}

function short(p) {
  return sayPath(p, HOME);
}

async function refreshSidebars(workspaces, force) {
  const due = workspaces.filter((w) => force || !sidebars.has(w.id) || Date.now() - sidebars.get(w.id).at > 6000);
  await term.pool(due, 6, async (w) => { sidebars.set(w.id, { value: await term.cmux.sidebarState(w.id), at: Date.now() }); });
}

function looksLikeClaude(surface, hook) {
  return asst.parseTitle(surface.title, 'claude').claude || !!hook || (bindings.get(surface.id)?.value?.kind === 'claude') || !!screens.get(surface.id)?.live;
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
      // Claude-looking surfaces every tick; plain shells every ~10 s, except
      // a tab just opened for a new session.
      const opened = opening.get(s.id);
      if (opened && (Date.now() > opened || (prev && prev.live))) opening.delete(s.id);
      if (!prev || looksLikeClaude(s, hook) || opening.has(s.id) || Date.now() - prev.at > 10000 || Date.now() - (liveWant.get(s.id) || 0) < LIVE_WANT_MS) jobs.push(['screen', w, s]);
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
  const text = want ? asst.tailLines(raw, SCREEN_LINES) : raw;
  const prev = screens.get(surfaceId);
  const now = Date.now();
  // okAt and full keep the last good read, for the Live screen's freshness;
  // ver changes only when what the Live screen would show changes.
  const full = raw != null ? (want ? raw : null) : prev ? prev.full : null;
  const src = full ?? (raw != null ? text : prev ? prev.text : null);
  const prevSrc = prev ? prev.full ?? prev.text : undefined;
  // Which assistant draws this tab: its session's, when a live session
  // reported from it, else the screen's own (server/assistant.mjs, parseAny;
  // Claude Code's reading first, as before).
  const known = tabAssistant(surfaceId);
  const { kind, screen: parsed } = known ? { kind: known, screen: asst.parseScreen(text, known) } : asst.parseAny(text);
  const prompt = raw != null ? await asst.judgeRead(kind, tab, parsed, now) : prev ? prev.prompt : null;
  screens.set(surfaceId, {
    text, at: now, live: parsed.claudeLive, prompt, assistant: kind,
    okAt: raw != null ? now : prev ? prev.okAt : null,
    full,
    ver: prev ? (src === prevSrc ? prev.ver : prev.ver + 1) : 1,
  });
  if (want && process.env.MC_LIVE_LOG === '1') console.log('live read', JSON.stringify({ surfaceId, lines: LIVE_LINES, ms: +readMs.toFixed(1), bytes: raw ? Buffer.byteLength(raw) : 0 }));
}

// A tab's last read, parsed by its assistant, with `draft` holding only
// typed text (Claude Code's suggestion in `suggestion`). Every state rule
// reads its screen through this. `kind`: the assistant its session names,
// when the read was taken as another's (the read's own verdict is then not used).
function judgedScreen(x, kind = null) {
  if (x && kind && asst.kindOf(kind) !== asst.kindOf(x.assistant)) return asst.judgedScreen(kind, { text: x.text, prompt: null });
  return asst.judgedScreen(x ? x.assistant : null, x);
}

// The assistant of the live session that last reported from a tab, or null.
function tabAssistant(surfaceId) {
  if (term.kindOf(surfaceId) === 'cmux') {
    const e = ev.bySurface.get(surfaceId);
    return e && !e.endedAt ? asst.kindOf(e) : null;
  }
  let best = null;
  for (const e of ev.all.values()) {
    if (e.endedAt || !e.terminal || term.tabIdFor(e.terminal, e.terminalId) !== surfaceId) continue;
    if (!best || e.lastEventAt > best.lastEventAt) best = e;
  }
  return best ? asst.kindOf(best) : null;
}

// GET /api/live?surface=<id>[&v=<ver>]: the Live screen of one surface,
// trimmed (server/assistant.mjs, trimScreen), with the time of its last good
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
  // Code spans come from a Claude Code transcript's text (server/codespans.mjs).
  const tp = (bt && asst.supports(bt.s.assistant, 'codeSpans') && bt.s.transcript && bt.s.transcript.path) || null;
  const vkey = `${x.ver}\u0000${tp}\u0000${spansGen(tp)}`;
  let lvv = liveVers.get(surfaceId);
  if (!lvv || lvv.key !== vkey) { lvv = { key: vkey, ver: lvv ? lvv.ver + 1 : 1 }; liveVers.set(surfaceId, lvv); }
  if (ver && Number(ver) === lvv.ver) return { status: 200, body: { ok: true, surfaceId, at: x.okAt, now, ver: lvv.ver, same: true } };
  const src = x.full ?? x.text;
  const t0 = performance.now();
  if (liveTrim.text !== src || liveTrim.kind !== x.assistant) liveTrim = { text: src, kind: x.assistant, value: asst.trimScreen(src, x.assistant) };
  const mkey = vkey + '\u0000' + surfaceId;
  if (liveMarked.key !== mkey || liveMarked.src !== src) liveMarked = { key: mkey, src, entries: markEntries(liveTrim.value.entries, tp) };
  const trimMs = performance.now() - t0;
  const body = { ok: true, surfaceId, at: x.okAt, now, ver: lvv.ver, lines: src ? src.split('\n').length - 1 : 0, ...liveTrim.value, entries: liveMarked.entries };
  if (process.env.MC_LIVE_LOG === '1') console.log('live trim', JSON.stringify({ surfaceId, ms: +trimMs.toFixed(2), entries: body.entries.length }));
  return { status: 200, body };
}

// Which session of assistant `kind` lives in a surface, and how we know.
function mapSession(surface, hook, binding, folder, taken, kind = 'claude') {
  if (hook && hook.agent === asst.cmuxAgent(kind) && hook.sessionId) {
    const p = hook.transcriptPath && fs.existsSync(hook.transcriptPath) ? hook.transcriptPath : asst.findTranscript(kind, hook.sessionId, hook.cwd);
    return { sessionId: hook.sessionId, path: p, method: 'cmux hook record', cwd: hook.cwd };
  }
  if (binding && binding.kind === asst.cmuxAgent(kind) && binding.sessionId) {
    return { sessionId: binding.sessionId, path: asst.findTranscript(kind, binding.sessionId, binding.cwd), method: 'cmux resume binding', cwd: binding.cwd };
  }
  const g = eventsInFolder(folder, taken, kind);
  if (g) return { sessionId: g.sessionId, path: transcriptOf(g), method: 'hook events in the same folder (guess)', cwd: g.cwd };
  const n = asst.newestTranscriptFor(kind, folder, taken);
  if (n) return { sessionId: n.sessionId, path: n.path, method: 'newest transcript in the folder (guess)', cwd: folder };
  return null;
}

// The transcript a hook event names, else the one found by session id.
function transcriptOf(e) {
  if (e.transcriptPath && fs.existsSync(e.transcriptPath)) return e.transcriptPath;
  return asst.findTranscript(asst.kindOf(e), e.sessionId, e.cwd);
}

// The terminal a session's events place it in: what the hook recorded,
// else cmux when they name a cmux surface (hooks older than `terminal`).
const termOf = (e) => (e ? e.terminal || (e.surfaceId ? 'cmux' : null) : null);

// The board's id of the tab a session's events name, in a terminal the board
// lists itself (iTerm2, Rex, Ravenry, and cmux in Ravenry mode), or null.
function otherTabId(e) {
  const kind = termOf(e);
  if (!kind || !term.OTHER_KINDS.includes(kind)) return null;
  return term.tabIdFor(kind, kind === 'cmux' ? e.surfaceId : e.terminalId);
}

// The open tab of a session its events place in a terminal other than the
// board's cmux (iTerm2, Rex; cmux in Ravenry mode): { id: 'iterm:<UUID>',
// 'rex:<uuid>' or cmux's surface UUID, title, ... }, or null.
function otherTab(e) {
  const id = otherTabId(e);
  const o = id ? otherTabs[termOf(e)] : null;
  return id && o && o.tabs.has(id) ? o.tabs.get(id) : null;
}

// cmux in its default mode lets only programs it started use its socket,
// and launchd, not cmux, starts the app's hub (server/cmux.mjs, DENIED).
const CMUX_DENIED = 'cmux shows its tabs only to programs it started, so Ravenry cannot read this screen (cmux Settings > Automation can allow it).';

// Why the board cannot act on a session it shows from its events only:
// the full reason (the Live screen) and a short one (the composer).
function cannotFor(kind) {
  if (kind === 'cmux' && term.CMUX_OUTSIDE) {
    const o = otherTabs.cmux;
    if (o && !o.ok) return o.denied ? { why: CMUX_DENIED, short: term.cannotType('cmux') } : { why: `Ravenry could not reach cmux: ${String(o.error).replace(/\.?$/, '.')} Until it can, it shows what this session's hook events say.`, short: term.cannotType('cmux') };
    return { why: term.cannotDrive('cmux', { open: false }), short: term.cannotType('cmux') };
  }
  if (kind === 'cmux' && !term.canDrive('cmux')) return { why: term.cannotDrive(kind), short: term.cannotType(kind) };
  if (kind === 'cmux') return { why: "cmux is not answering, so the board only shows what this session's hook events say.", short: 'cmux is not answering, so the board cannot type into this session.' };
  const o = otherTabs[kind];
  if (o && !o.ok) return { why: `The board could not reach ${term.nameOf(kind)}: ${String(o.error).replace(/\.?$/, '.')} Until it can, it only shows what this session's hook events say.`, short: `The board cannot reach ${term.nameOf(kind)} now, so it cannot type into this session.` };
  return { why: term.cannotDrive(kind, { open: false }), short: term.cannotType(kind, { open: false }) };
}

// The tab a board surface id names now, as the terminal interface takes it,
// or null: a cmux surface in the last listing, or an open iTerm2 session or Rex pane.
function tabOf(surfaceId, workspaces = lastWorkspaces) {
  const kind = term.kindOf(surfaceId);
  if (kind === 'cmux') {
    const ws = workspaces.find((w) => w.surfaces.some((x) => x.id === surfaceId));
    if (ws) return { kind, workspaceId: ws.id, surfaceId };
    const t = term.CMUX_OUTSIDE && otherTabs.cmux ? otherTabs.cmux.tabs.get(surfaceId) : null;
    return t ? { kind, workspaceId: t.workspaceId, surfaceId, title: t.title } : null;
  }
  const o = otherTabs[kind];
  return o && o.tabs.has(surfaceId) ? { kind, surfaceId, title: o.tabs.get(surfaceId).title } : null;
}

// A fresh look at one non-cmux tab, right before a write: the terminal is
// asked again, never the tick's cached list.
async function freshTab(surfaceId) {
  const kind = term.kindOf(surfaceId);
  if (kind === 'cmux' && !term.CMUX_OUTSIDE) return tabOf(surfaceId, await term.cmux.listWorkspaces());
  const list = await term.listTabs(kind);
  const t = list.find((x) => x.id === surfaceId);
  return t ? { kind, surfaceId, title: t.title, sessionId: t.sessionId || null, ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}) } : null;
}

// Lists iTerm2's and Rex's tabs, each only while a session needs it: a
// session in the events that has not ended (seen in the last week) placed
// there, or a claude process whose environment names a tab there
// (ITERM_SESSION_ID, REX_BLOCK). So a Mac without iTerm2 or Rex never runs
// osascript or rex for them. Then reads the screen of every open tab such
// a session reports from.
const PROC_TAB = { iterm: 'itermId', rex: 'rexId', ravenry: 'ravenryId', cmux: 'surfaceId' };
async function refreshOtherTabs(evAll) {
  for (const kind of term.OTHER_KINDS) await refreshKind(kind, evAll);
}
async function refreshKind(kind, evAll) {
  const week = Date.now() - 7 * 86400000;
  const wanted = [...evAll.values()].filter((e) => termOf(e) === kind && !e.endedAt && Date.parse(e.lastEventAt) > week);
  const procs = procState.procs.filter((p) => p[PROC_TAB[kind]]);
  if (!wanted.length && !procs.length) {
    otherTabs[kind] = { ok: true, tabs: new Map(), asked: false };
    if (kind === 'rex') term.rexWatch([], rexSoon);
    return;
  }
  // cmux refused this board: asked again every 30 s, not every tick.
  const was = otherTabs[kind];
  if (was && was.denied && Date.now() - was.at < 30000) return;
  try {
    const list = await term.listTabs(kind);
    otherTabs[kind] = { ok: true, tabs: new Map(list.map((t) => [t.id, t])), asked: true };
  } catch (e) {
    otherTabs[kind] = { ok: false, tabs: new Map(), error: String(e.message || e).replace(/^(iTerm2|Rex): /, ''), asked: true, denied: !!e.denied, at: Date.now() };
    if (kind === 'rex') term.rexWatch([], rexSoon);
    return;
  }
  const tabs = otherTabs[kind].tabs;
  // A pane not seen before (a session started or resumed, a daemon that
  // appeared): the processes are read again soon, to tie it to its session.
  if (kind === 'ravenry') {
    const fresh = [...tabs.keys()].some((id) => !seenPanes.has(id));
    for (const id of tabs.keys()) seenPanes.add(id);
    if (fresh && !procsSoon) procsSoon = setTimeout(() => { procsSoon = null; refreshProcs(); }, 300);
  }
  // The tabs sessions report from, and the tabs claude processes run in
  // (a session resumed in a Ravenry pane, whose events another terminal's
  // process keeps writing).
  const ids = [...new Set([...wanted.map(otherTabId), ...procs.map((p) => term.tabIdFor(kind, p[PROC_TAB[kind]]))].filter((id) => id && tabs.has(id)))];
  // Rex's events, per Rex session holding a tab the board reads, only make
  // the next refresh come sooner (as cmux's do).
  if (kind === 'rex') term.rexWatch([...new Set(ids.map((id) => tabs.get(id).sessionId).filter(Boolean))], rexSoon);
  await term.pool(ids, 4, (id) => readSurface({ kind, surfaceId: id, ...(tabs.get(id).workspaceId ? { workspaceId: tabs.get(id).workspaceId } : {}) }));
}
let rexTimer = null;
function rexSoon() {
  if (rexTimer) return;
  rexTimer = setTimeout(() => { rexTimer = null; tick(); }, 400);
}

// A session that reported from this folder but from no tab the board can
// see: the "else cwd" step of mapping a tab to its events.
function eventsInFolder(folder, taken, kind = 'claude') {
  if (!folder) return null;
  let best = null;
  for (const e of ev.all.values()) {
    if (e.endedAt || taken.has(e.sessionId) || ev.claimed.has(e.sessionId) || !e.cwd) continue;
    if (asst.kindOf(e) !== kind) continue; // another assistant's session
    if (e.surfaceId && ev.live.has(e.surfaceId)) continue;
    if (e.terminal && e.terminal !== 'cmux') continue; // it says it runs in another terminal
    if (path.resolve(e.cwd) !== path.resolve(folder)) continue;
    if (!best || e.lastEventAt > best.lastEventAt) best = e;
  }
  return best;
}

// The repo a session works in: its tool calls first, then the hook's cwd.
function realFolder(tp, e, kind = asst.kindOf(e)) {
  const real = tp ? asst.workFolder(kind, tp) : null;
  if (real && real.folder) return real;
  const r = e && e.cwd ? repoRoot(e.cwd) : null;
  return r ? { folder: r, share: null, hits: real ? real.hits : 0, repos: real ? real.repos : [], from: 'hook cwd' } : real;
}

// The name a session started in a worktree was given ("Harbour level"
// for ravenry/harbour-level), for a session that names itself nowhere else.
function worktreeName(cwd) {
  if (!cwd) return null;
  const w = worktrees.load().find((x) => x.name && inside(realOr(cwd), realOr(x.folder)));
  if (!w || /^session-[0-9a-f]+$/.test(w.name)) return null;
  const words = w.name.replace(/-\d+$/, '').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A folder's real path when it exists (/var and /private/var are one on macOS), else as it is.
function realOr(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

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
  // A session in one of a project's worktrees (server/worktrees.mjs) is
  // that project's, though its folder is a sibling of the project's.
  const where = [e.cwd, real && real.folder].filter(Boolean).map(realOr);
  // Merged or thrown away, its folder is gone but the session stays the project's.
  const wt = worktrees.load().find((w) => w.projectId && where.some((x) => inside(x, realOr(w.folder))));
  if (wt) { const p = live.find((x) => x.id === wt.projectId); if (p) return p; }
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
  if (term.OTHER_KINDS.includes(e.terminal)) return !!otherTab(e);
  return Date.now() - Date.parse(e.lastEventAt || 0) < WATCH_ONLY_MS;
}

// Outside cmux mode, a session whose folder no project holds becomes a
// project of its repo folder: an iTerm2 or Rex session with an open tab, or a
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
    const kind = asst.kindOf(e);
    const t = tp ? asst.readTranscript(kind, tp) : null;
    const name = asst.parseTitle(tab.title || '', kind).topic || (t && t.title) || `${asst.of(kind).SHORT} session`;
    let id = 'session-' + e.sessionId.slice(0, 8);
    while (ids.has(id)) id += '-s';
    ids.add(id);
    out.push({ id, name, folder: null, workspaces: [], brief: null, waitingOn: null, loose: true, sessionIds: [e.sessionId], cwd: e.cwd || null });
  }
  return out;
}

// The folder a cmux workspace works in: its sidebar's, else a hook's or an
// event's cwd (the same guess that names an imported workspace).
function workspaceCwd(w, hooks, evAll) {
  const sb = sidebars.get(w.id)?.value;
  const hook = hooks.find((h) => h.workspaceId === w.id && h.cwd);
  const e = [...evAll.values()].find((x) => x.workspaceId === w.id && x.cwd);
  return (sb && sb.cwd) || (hook && hook.cwd) || (e && e.cwd) || null;
}

// The cmux workspaces no project lists (docs/STATE-RULES.md, "Not in a
// project"; docs/design/CodexStage2.dc.html, section 1, variant C): each is
// a card of its own for this tick, keyed "ws:<workspace id>", named after its
// folder, with no brief and nothing written to the registry. A workspace a
// hidden project lists stays hidden, one in ignoreWorkspaces is never shown,
// one the board is opening right now is left to its project, and a folder
// too broad to hold a project (the projects root, home) is never its
// folder, so no session is guessed into it by folder. A real board leaves
// out the board tests' own mc-test* workspaces, as importing does.
function unownedWorkspaces(workspaces, hooks, evAll) {
  if (!reg) return [];
  const listed = new Set(reg.projects.flatMap((p) => p.workspaces || []));
  const ignored = new Set(Array.isArray(reg.ignoreWorkspaces) ? reg.ignoreWorkspaces : []);
  const root = rootFolder();
  const out = [];
  for (const w of workspaces) {
    if (listed.has(w.id) || ignored.has(w.id) || reserved.has(w.title)) continue;
    if (!SCRATCH_DATA && /^mc-test/.test(w.title || '')) continue;
    const at = workspaceCwd(w, hooks, evAll);
    const folder = at && path.isAbsolute(at) && path.resolve(at) !== HOME && fs.existsSync(at) && !isBroadFolder(at, reg.projects, root) ? at : null;
    const name = folder ? path.basename(folder) : registry.nameFromWorkspace(w, null);
    out.push({ id: 'ws:' + w.id, name, folder, workspaces: [w.id], brief: null, waitingOn: null, unowned: true, workspaceTitle: w.title || w.ref || name });
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
  if (primary && !asst.supports(primary.assistant, 'pictures')) return null;
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
      // The assistant this tab shows: its session's (events), else its screen's.
      const evTab0 = ev.bySurface.get(s.id) || null;
      const liveEv = evTab0 && !evTab0.endedAt ? evTab0 : null;
      const kind = liveEv ? asst.kindOf(liveEv) : asst.kindOf(screens.get(s.id) ? screens.get(s.id).assistant : null);
      const title = asst.parseTitle(s.title, kind);
      const screen = judgedScreen(screens.get(s.id), liveEv ? kind : null);
      const claudeHere = screen.claudeLive || (title.claude && !screen.readable);
      // Events first: the session that last reported from this very tab.
      const evTab = ev.bySurface.get(s.id) || null;
      // Claude still on screen 20 s after its SessionEnd: a session the hook
      // never saw (started before it was installed). Before that the screen
      // may simply not have caught up.
      const seenAfterEnd = (e) => !!(e && e.endedAt && claudeHere && (screens.get(s.id)?.at || 0) > Date.parse(e.endedAt) + 20000);
      let map = null;
      if (evTab && !seenAfterEnd(evTab)) map = { sessionId: evTab.sessionId, path: transcriptOf(evTab), method: 'hook events (surface id)', cwd: evTab.cwd };
      else if (claudeHere) map = mapSession(s, hook, binding, project.folder, taken, kind);
      else if (screen.resumeId) map = { sessionId: screen.resumeId, path: asst.findTranscript(kind, screen.resumeId), method: 'resume line on screen' };
      else if (binding && binding.kind === asst.cmuxAgent(kind)) map = { sessionId: binding.sessionId, path: asst.findTranscript(kind, binding.sessionId, binding.cwd), method: 'cmux resume binding' };
      else if (hook) map = { sessionId: hook.sessionId, path: hook.transcriptPath, method: 'cmux hook record' };
      if (!map && !claudeHere) continue; // a plain shell that never ran Claude (that we can see)
      if (map) taken.add(map.sessionId);
      // Its events by session id, unless they came from another open tab.
      let evs = map ? ev.all.get(map.sessionId) || null : null;
      if (evs && evs.surfaceId && evs.surfaceId !== s.id && ev.live.has(evs.surfaceId)) evs = null;
      // Ended, yet Claude is on screen: a session the hook never saw (installed later).
      if (seenAfterEnd(evs)) evs = null;
      const t = map && map.path ? asst.readTranscript(kind, map.path) : null;
      if (!claudeHere && !t && !(evs && !evs.endedAt)) continue;
      // The repo this session really works in, from its tool calls. When a
      // workspace's tabs work in different repos, each tab belongs to the
      // project of its own repo (docs/STATE-RULES.md, Which project a tab is in).
      const real = map ? realFolder(map.path, evs, kind) : null;
      const owners = reg.projects.filter((p) => !p.hidden && (p.workspaces || []).includes(w.id));
      if (owners.length > 1) {
        const own = ownerOf(owners, s.id, real && real.folder, w.surfaces.map((x) => x.id), { projects: reg.projects, root: rootFolder() });
        if (own && own.id !== project.id) continue;
      }
      let st = eventState({ ev: evs, screen, screenAt: screens.get(s.id)?.at || null, title, transcript: t }, settings, now);
      if (!st) st = { ...sessionState({ screen, title, transcript: t, hook, who: asst.of(kind).SHORT }, settings, now), source: 'screen' };
      const marker = map ? markers.get(map.sessionId) || null : null;
      // A session that handed off is done; its "hand-off written" line is
      // not a hand-back to the user.
      if (marker && (marker.state === 'written' || marker.state === 'resumed') && !['working', 'dialog', 'draft', 'none'].includes(st.state)) {
        st = { state: 'handed', since: marker.writtenAt || st.since, reasons: [...st.reasons, 'wrote its hand-off; a fresh session carries on'] };
      }
      sessions.push({
        marker, paneId: s.paneId, cwd: (evs && evs.cwd) || (hook && hook.cwd) || (t && t.cwd) || (map && map.cwd) || project.folder, terminal: true, term: 'cmux', cannot: null, assistant: kind,
        surfaceId: s.id, surfaceRef: s.ref, workspaceId: w.id, workspaceRef: w.ref,
        topic: title.topic || (t && t.title) || s.title, live: screen.claudeLive,
        sessionId: map ? map.sessionId : null, method: map ? map.method : null,
        transcript: t, screen, st, hook, real,
        sidebarStatus: sb ? sb.claudeStatus : null,
      });
    }
  }
  // Sessions known from their events: in iTerm2 or Rex (read and typed into
  // through its adapter when its tab is open), in a terminal the board has
  // no adapter for (watch only), or every cmux session while cmux does not
  // answer.
  for (const e of ev.all.values()) {
    // One session, one row: a Ravenry pane that runs it comes first, even
    // when another terminal's process on the same session wrote its last
    // events (or ended), and that process is said as alsoOpen.
    const ph = paneHolders.get(e.sessionId);
    const phTab = ph && otherTabs.ravenry ? otherTabs.ravenry.tabs.get(term.tabIdFor('ravenry', ph.pane)) || null : null;
    if ((e.endedAt && !phTab) || ev.claimed.has(e.sessionId) || taken.has(e.sessionId)) continue;
    if (e.surfaceId && ev.cmuxOk && !phTab) continue; // a cmux tab: shown through it, or closed
    const tkind = phTab ? 'ravenry' : termOf(e);
    const tab = phTab || otherTab(e);
    const x = tab ? screens.get(tab.id) : null;
    const kind = asst.kindOf(e);
    const screen = judgedScreen(x, kind);
    const title = asst.parseTitle(tab ? tab.title : '', kind);
    const q = e.last && e.last.event === 'Stop' && e.last.question;
    if (!(tab && screen.claudeLive) && age(now, e.lastEventAt) > (q ? settings.questionHours : settings.handbackHours) * 3600000) continue;
    const tp = transcriptOf(e);
    const real = realFolder(tp, e);
    if (project.loose ? !project.sessionIds.includes(e.sessionId) : (() => { const own = eventOwner(e, real); return !own || own.id !== project.id; })()) continue;
    const t = tp ? asst.readTranscript(kind, tp) : null;
    let st = eventState({ ev: e, screen, screenAt: x ? x.at : null, title, transcript: t }, settings, now);
    if (!st && tab) st = { ...sessionState({ screen, title, transcript: t, hook: null, who: asst.of(kind).SHORT }, settings, now), source: 'screen' };
    if (!st) continue;
    taken.add(e.sessionId);
    const marker = markers.get(e.sessionId) || null;
    sessions.push({
      marker, paneId: null, cwd: e.cwd || (t && t.cwd) || project.folder, terminal: !!tab, term: tkind, assistant: kind,
      // A cmux tab followed from Ravenry mode is shown, never typed into.
      cannot: tab ? (tkind === 'cmux' && !term.canDrive('cmux') ? { why: null, short: term.cannotType('cmux') } : null) : cannotFor(tkind),
      surfaceId: tab ? tab.id : 'ev:' + e.sessionId, surfaceRef: tab ? term.nameOf(tkind) + ' tab' : null, workspaceId: (tab && tab.workspaceId) || e.workspaceId, workspaceRef: (tab && tab.workspaceRef) || null,
      // Never named after a too-broad folder ("projects" for the projects root).
      topic: title.topic || (t && t.title) || worktreeName(e.cwd) || [e.cwd, project.folder].filter((f) => f && !isBroadFolder(f, reg.projects, rootFolder())).map((f) => path.basename(f))[0] || 'Session', live: screen.claudeLive,
      sessionId: e.sessionId, method: tab ? `hook events (${term.nameOf(tkind)} session id)` : 'hook events, no terminal tab', transcript: t, screen, st, hook: null, real, sidebarStatus: null,
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
  // A gate counts as passed only when the person passed it (server/gates.mjs):
  // one the file alone passed waits for the person even while its session
  // works on past it.
  const plan = brief ? activePlan(brief.plan, { working: ps.state === 'work', gatesFor: (o) => gates.forPlan(brief.path, o) }) : null;
  const planGate = plan && plan.gate && (plan.gate.fileOnly || (ps.state !== 'work' && !(primary && primary.st.state === 'dialog'))) ? plan.gate : null;
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
  // The window from the settings, unless the transcript records its own (Codex).
  const winOf = (t) => t.contextWindow || cw;
  const ctx = (s) => (s && s.transcript && s.transcript.contextTokens != null ? { tokens: s.transcript.contextTokens, window: winOf(s.transcript), pct: Math.min(100, (s.transcript.contextTokens / winOf(s.transcript)) * 100), model: s.transcript.model } : null);
  const timeline = [];
  if (brief) for (const h of brief.handoff) timeline.push({ when: h.when, text: plain(h.text), from: 'brief' });
  if (primary && primary.transcript) {
    for (const turn of primary.transcript.turns.slice(0, 4)) {
      const first = plain(turn.text).split(/\n\s*\n/)[0].replace(/\s+/g, ' ');
      timeline.push({ at: turn.at, text: first.length > 220 ? first.slice(0, 217).replace(/\s+\S*$/, '') + '...' : first, from: 'transcript' });
    }
  }
  const shared = project.unowned ? [] : registry.sharedWith(reg, project);
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
  // The machine its folder is on (its own; the registry's folders are this
  // computer's otherwise): it is said against that machine's home. A
  // session's folder goes with the session's machine.
  const where = project.machine || null;

  return {
    id: project.id, name: project.name, state: pstate, since, loose: !!project.loose,
    unowned: !!project.unowned, workspaceTitle: project.unowned ? project.workspaceTitle : undefined,
    plan: plan ? planView(project, plan) : null, planGate,
    planDraft: (() => { try { const d = planner.get(project.id); return d ? { busy: !!d.busy, steps: d.steps.length } : null; } catch { return null; } })(),
    folder: project.folder, folderShort: homes.sayFolder(project.folder, where), shared,
    waitingOn, flags,
    line: words.line, headline: words.headline, quick: words.quick, question: words.question, dialog: words.dialog || null, draft: words.draft || null,
    brief: brief ? { path: homes.sayFolder(brief.path, where), file: brief.path, draft: brief.draft, status: brief.status, goal: brief.goal, doneMeans: brief.doneMeans, kind: brief.kind, stage: brief.stage, plan: brief.plan, next: brief.next, notes: brief.notes, pictures: brief.pictures, parked: brief.parked, rules: brief.rules, ship: brief.ship, waitingOn: brief.waitingOn } : null,
    briefExpected: registry.briefPath(project) ? homes.sayFolder(registry.briefPath(project), where) : null,
    plans: project.unowned ? [] : plansFor(project, reg.projects, now),
    timeline: timeline.slice(0, 5),
    handoffRecent: recent,
    primary: primary ? primary.surfaceId : null,
    // The machine it lives on: its own (a project on a remote machine),
    // else the one all its sessions run on, null for this one.
    machine: projectMachine(project, sessions),
    workspaces,
    sessions: sessions.map((s) => ({
      surfaceId: s.surfaceId, surfaceRef: s.surfaceRef, workspaceId: s.workspaceId, workspaceRef: s.workspaceRef,
      topic: s.topic, live: s.live, sessionId: s.sessionId, method: s.method,
      workFolder: s.real && s.real.folder ? homes.sayFolder(s.real.folder, sessionMachine(s)) : null,
      state: s.st.state, since: s.st.since || null, reasons: s.st.reasons, source: s.st.source || 'screen', terminal: s.terminal !== false,
      term: s.term || null, termName: s.term ? term.nameOf(s.term) : null,
      // The machine it runs on (a remote ravenryd), null on this one.
      machine: sessionMachine(s),
      assistant: asst.kindOf(s.assistant),
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
      // In a terminal outside Ravenry: whether its process still runs
      // there (Move here ends it first).
      outside: outsideOf(s),
      // In a Ravenry pane, and a process in another terminal holds the same
      // session (cmux's restore relaunched it there): both write one
      // transcript. Move here or Keep it there puts it in one place.
      alsoOpen: alsoOpenIn(s),
      // A move waiting for the turn to end, the last one done, and whether
      // this pane's conversation went on in another process (moveOf).
      ...moveOf(s),
      // Its conversation from its transcript, for a session the app shows
      // outside Ravenry: in place of a screen it cannot read, or one that
      // has nothing on it.
      ...(s.transcript && (s.terminal === false || (s.term && s.term !== 'ravenry')) ? { conversation: conversationOf(s.transcript) } : {}),
      ...worktreeOf(s.surfaceId),
    })),
  };
}

// A session's worktree for the board's state (server/worktrees.mjs), as
// { worktree: { branch, folder, base, baseBranch, state, merged? } }, or {}.
function worktreeOf(surfaceId) {
  const w = surfaceId ? worktrees.bySurface(surfaceId) : null;
  if (!w) return {};
  return { worktree: { branch: w.branch, folder: w.folder, base: w.base, baseBranch: w.baseBranch, state: w.state, ...(w.merged ? { merged: w.merged } : {}), ...(w.unmerged_at ? { unmerged_at: w.unmerged_at } : {}), ...(w.branch_deleted_at ? { branch_deleted_at: w.branch_deleted_at } : {}) } };
}

// A session in a terminal outside Ravenry (cmux, iTerm2, Rex, any other),
// on this machine: { name, open, resumable }. `open` is whether its process
// still runs there (its hook's pid, checked each tick; else the last process
// list), so Continue in Ravenry resumes only a session nothing else runs:
// two processes on one session id would write one transcript.
function outsideOf(s) {
  if (!s.sessionId || !s.term || s.term === 'ravenry' || sessionMachine(s)) return null;
  const e = ev.all.get(s.sessionId);
  let open = null;
  if (e && e.pid && outsideAlive) open = outsideAlive.has(e.pid);
  if (open == null) open = !procState.at || sessRows.some((r) => r.sessionId === s.sessionId);
  const kind = asst.kindOf(s.assistant);
  return { name: term.nameOf(s.term), open, resumable: !open && (kind === 'claude' || kind === 'codex') };
}

// Another process on this session, outside Ravenry, while it runs in a
// Ravenry pane: { name, surfaceId } (the processes as last listed).
function alsoOpenIn(s) {
  if (!s.sessionId || term.kindOf(s.surfaceId) !== 'ravenry') return null;
  const r = sessRows.find((x) => x.sessionId === s.sessionId && x.termKind && x.termKind !== 'ravenry');
  return r ? { name: term.nameOf(r.termKind), term: r.termKind, surfaceId: r.surfaceId || null, pid: r.pid } : null;
}

// The last few turns of a transcript, oldest first: what was asked (Claude
// Code's transcripts say) and the answer, each cut to a readable length, and
// a turn still running with what it said so far.
function conversationOf(t) {
  const cut = (x) => { const v = plain(String(x || '')).trim(); return v.length > 1500 ? v.slice(0, 1497).replace(/\s+\S*$/, '') + '...' : v; };
  const out = (t.turns || []).slice(0, 12).reverse().map((x) => ({ at: x.at || null, ask: x.ask ? cut(x.ask) : null, text: cut(x.text) }));
  if (t.inTurn && t.lastPrompt && t.lastPromptAt && !(out.length && out[out.length - 1].at && out[out.length - 1].at >= t.lastPromptAt)) {
    out.push({ at: t.lastPromptAt, ask: cut(t.lastPrompt), text: t.lastText && t.lastTextAt > t.lastPromptAt ? cut(t.lastText) : null, working: true });
  }
  return out;
}

function sessionMachine(s) {
  if (s.surfaceId && term.kindOf(s.surfaceId) === 'ravenry') {
    const m = term.ravenryMachineOf(s.surfaceId);
    if (m) return m;
  }
  const e = s.sessionId ? ev.all.get(s.sessionId) : null;
  return (e && e.machine) || null;
}

function projectMachine(project, sessions) {
  if (project.machine) return project.machine;
  const ms = [...new Set(sessions.map(sessionMachine))];
  return ms.length === 1 ? ms[0] : null;
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

// The folders the board reads: each project's on this computer, and the
// projects root.
function accessFolders() {
  if (!reg) return [];
  return [...reg.projects.filter((p) => !p.hidden && !p.machine).map((p) => p.folder), reg.settings && reg.settings.projectsRoot].filter(Boolean);
}
access.onChange(() => { wantTick = true; setTimeout(tick, 10); });

// The hub's record of plan gates starts from what the briefs say once, the
// first time there is none (server/gates.mjs adopt): at the first tick that
// may read the briefs.
let gatesAdopted = false;
function adoptGates() {
  try {
    const briefs = (reg ? reg.projects : []).map((p) => registry.briefPath(p)).filter((f) => f && fs.existsSync(f)).map((file) => ({ file, plans: (readBrief(file) || { plan: [] }).plan }));
    if (gates.adopt(briefs)) console.log(`plan gates: started the hub's record from ${briefs.length} brief${briefs.length === 1 ? '' : 's'}`);
  } catch (e) { console.error('plan gates:', e.message); }
}

// While macOS has not said whether the board may read a protected folder,
// every request is answered at once with 503 and the folder, never held:
// a handler would read a project's file and wait with it.
function accessWait(req, res, url) {
  const w = access.pending();
  if (!w) return false;
  const words = access.waitingWords(w, homes.sayLocal);
  const body = { starting: true, waitingFor: homes.sayLocal(w), folder: access.label(w), error: words };
  const page = req.method === 'GET' && !url.pathname.startsWith('/api/') && (url.pathname === '/' || url.pathname.endsWith('.html'));
  if (page) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '2' });
    res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Ravenry is starting</title><body style="font:15px -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:34em;padding:0 16px;line-height:1.5"><h1 style="font-size:20px">Ravenry is starting</h1><p>${words.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p></body>\n`);
    return true;
  }
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '2' });
  res.end(JSON.stringify(body));
  return true;
}

async function tick() {
  if (ticking) { wantTick = true; return; }
  ticking = true;
  const tp = startlog.tickPhases(tickNo + 1);
  try {
    tickNo++;
    tp.mark('registry');
    reloadRegistry();
    // Nothing of the projects' folders is read until macOS lets the board
    // read the protected folders they are in (server/access.mjs).
    if (access.waitFor(accessFolders())) return;
    if (!gatesAdopted) { gatesAdopted = true; adoptGates(); }
    const now = Date.now();
    // Without cmux the board still shows what the hook events say.
    let workspaces = [];
    let cmuxError = null;
    tp.mark('cmux workspaces');
    try { workspaces = await term.cmux.listWorkspaces(); } catch (e) { if (!reg) throw e; cmuxError = String(e.message || e); }
    const cmuxOk = !cmuxError;
    // In iTerm2 mode and Rex mode cmux is never asked (term.cmux answers
    // "nothing"), and a read is whole unless the board's terminal could not be asked.
    const driven = term.BOARD === 'cmux';
    tp.mark('cmux hooks');
    const hooks = cmuxOk ? (await term.cmux.listHookSessions()).filter((h) => h.active || h.surfaceId) : [];
    tp.mark('cmux sidebars');
    if (cmuxOk) await refreshSidebars(workspaces, !reg);
    tp.mark('events');
    const evAll = events.scan();
    tp.mark('other terminals');
    await refreshOtherTabs(evAll);
    tp.mark('surfaces');
    const fullRead = driven ? cmuxOk : !(otherTabs[term.BOARD] && otherTabs[term.BOARD].ok === false);
    if (cmuxOk && (!reg || reg.settings.autoImport !== false)) {
      try {
        const res = registry.importWorkspaces(reg, workspaces, (w) => workspaceCwd(w, hooks, evAll), (w) => reserved.has(w.title));
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
    // Workspaces no project lists are read the same way, so a session waiting
    // there (Codex's "Trust this folder?") shows as a folder.
    unowned = unownedWorkspaces(workspaces, hooks, evAll);
    for (const [sid, at] of liveWant) if (Date.now() - at > LIVE_WANT_MS * 6) liveWant.delete(sid);
    await refreshSurfaces([...mine, ...workspaces.filter((w) => unowned.some((u) => u.workspaces[0] === w.id))], hooks);
    const live = new Set(workspaces.flatMap((w) => w.surfaces.map((x) => x.id)));
    const bySurface = new Map([...events.bySurface(evAll)].filter(([sid]) => live.has(sid)));
    // Sessions some open tab already names, so none shows twice.
    const claimed = new Set([...bySurface.values()].map((e) => e.sessionId));
    for (const h of hooks) if (h.surfaceId && live.has(h.surfaceId) && h.sessionId) claimed.add(h.sessionId);
    for (const [sid, b] of bindings) if (live.has(sid) && b.value && b.value.sessionId) claimed.add(b.value.sessionId);
    // One session per open iTerm2 or Rex tab: the newest that reported from it (a
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
    // A Move here that waited for a turn to end (moveSession).
    if (moves.size) runMoves();
    tp.mark('outside alive');
    await refreshOutsideAlive(evAll);
    tp.mark('markers');
    const held = holdersInPanes(evAll);
    // Said once per change: when sessions get tied to their Ravenry panes
    // (how long after the hub started shows how soon a pane shows).
    if ([...held.keys()].some((k) => !paneHolders.has(k))) console.log(`sessions: ${[...held.keys()].filter((k) => !paneHolders.has(k)).map((k) => `${k.slice(0, 8)} in pane ${held.get(k).pane}`).join(', ')}, ${Math.round(process.uptime() * 1000)} ms after start`);
    paneHolders = held;
    const wsById = new Map(workspaces.map((w) => [w.id, w]));
    const settings = reg.settings;
    markers = handoff.listMarkers();
    boardTabs = [];
    picBudget = 3;
    tp.mark('loose sessions');
    loose = looseSessions(evAll);
    tp.mark('work folders');
    // An unowned workspace is on the board only while a session runs in it.
    // Each session's work folder (from its transcript's tool calls; read in
    // full once, then only what was added): read here, one session at a
    // time, giving the event loop back every 50 ms; every project's build
    // below asks for all of them, and the first one used to read them all
    // at once (seconds on big transcripts).
    {
      let slice = Date.now();
      for (const e of evAll.values()) {
        const tp = transcriptOf(e);
        if (tp) { try { realFolder(tp, e); } catch { /* read again in the build */ } }
        if (Date.now() - slice > 50) { await new Promise((r) => setImmediate(r)); slice = Date.now(); }
      }
    }
    // Project by project, giving the event loop back every 50 ms: the
    // board answers HTTP while a big set of projects is read (2026-11-07,
    // a first tick held the main thread for tens of seconds).
    const build = async () => {
      const out = [];
      let slice = Date.now();
      for (const p of [...reg.projects.filter((x) => !x.hidden), ...loose, ...unowned]) {
        out.push(buildProject(p, wsById, hooks, settings, now));
        if (Date.now() - slice > 50) { await new Promise((r) => setImmediate(r)); slice = Date.now(); }
      }
      return out.filter((p) => !p.unowned || p.sessions.length);
    };
    tp.mark('projects');
    let projects = await build();
    if (noticeWritten(projects)) { boardTabs = []; projects = await build(); }
    tp.mark('sessions view');
    if (cmuxOk) lastWorkspaces = workspaces;
    if (tickNo <= 3) console.log(`tick ${tickNo}: ${Date.now() - now} ms, ${Math.round(process.uptime() * 1000)} ms after start`);
    let sessionsView;
    try { sessionsView = await buildSessions(cmuxOk ? workspaces : [], hooks, settings, now, projects); } catch (e) {
      console.error('sessions view:', e.message);
      sessionsView = { at: procState.at, error: String(e.message || e), idleHours: Number(settings.idleHours) || 24, totalKb: 0, count: 0, idleCount: 0, idleKb: 0, rows: [], closed: [], result: null, closing };
    }
    const c = cfg();
    // The Rules tab counts the repeats waiting in Suggested.
    const views = { ideas: ideas.count(), rules: repeats.visibleCount(c), ship: shipWaiting };
    // Phone alerts and Mac notifications (server/alerts.mjs): a project that
    // moved into Needs you starts a send that never holds up the tick. Only on a full read: a
    // tick without cmux sees fewer sessions and would make false moves.
    tp.mark('alerts');
    if (fullRead) { try { alerts.observe(projects, { now, boardUrl: boardUrl() }); } catch (e) { console.error('alerts:', e.message); } }
    // An app's alert for a checkpoint that closed comes off the phone (server/push.mjs).
    try { push.syncCheckpoints(checkpoints.list().filter((c) => c.state === 'open').map((c) => c.id)); } catch (e) { console.error('push:', e.message); }
    // The sidebar's pages (server/pages.mjs): read again when a file
    // changed, with each one's number from its items.
    pagesProjects = projects;
    pagesSessions = sessionsView;
    let pageRows = [];
    tp.mark('pages');
    try { pages.refresh(); pageRows = pages.navRows(); } catch (e) { console.error('pages:', e.message); }
    tp.mark('snapshot');
    if (!snapshot.generatedAt) console.log(`start: first state built, ${Date.now() - startlog.T0} ms after start`);
    snapshot = { generatedAt: new Date(now).toISOString(), pages: pageRows, cmuxOk, board: { kind: term.BOARD, name: term.nameOf(term.BOARD), installed: term.BOARD_INSTALLED }, hooks: hooksState(), error: cmuxError ? 'cmux did not answer: ' + cmuxError : !fullRead ? `${term.nameOf(term.BOARD)} could not be asked: ${otherTabs[term.BOARD].error}` : null, events: evAll.size, registryPath: short(registry.REGISTRY_PATH), settings: registry.handoffSettings(settings), assistants: assistantsView(), projectsRoot: projectsRoot.view(reg), alerts: alerts.status(), views, sessions: sessionsView, projects, machines: remoteinstall.view(), homes: homesNow(), checkpoints: checkpointsView(projects), access: access.view(homes.sayLocal) };
    // The assistant each project's next new session starts (Revive, New
    // session, a plan's start), for the New session switch's line; and the
    // one it is set to (its own, else startWith), for the meta line's "New
    // sessions:" switch, which shows the choice even when the board starts
    // the other because it is not installed (`assistantNote`). Both come
    // from continueChoice, as continueLaunch's do, so the switch shows what
    // the next start runs.
    for (const pv of snapshot.projects) {
      const rp = reg.projects.find((x) => x.id === pv.id);
      if (!rp) continue;
      const ch = asst.continueChoice(settings, rp);
      pv.assistant = ch.kind;
      pv.assistantWants = ch.wanted;
      pv.assistantNote = ch.fallback ? ch.note : null;
    }
    if (process.env.MC_NO_AUTOSTART !== '1') autoStarts(workspaces, cmuxOk);
  } catch (e) {
    snapshot = { ...snapshot, cmuxOk: false, error: 'The board could not read its terminals: ' + String(e.message || e), generatedAt: new Date().toISOString() };
    console.error('tick:', e.message);
  } finally {
    tp.done();
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
      await term.pool(want, 6, async (p) => {
        const tab = { kind: 'cmux', workspaceId: wsOf.get(p.surfaceId).id, surfaceId: p.surfaceId };
        const text = await term.readScreen(tab, 40);
        const now = Date.now();
        const k = asst.kindOf(p.assistant);
        extraScreens.set(p.surfaceId, { text, at: now, assistant: k, prompt: text != null ? await asst.judgeRead(k, tab, asst.parseScreen(text, k), now) : null });
      });
      for (const id of [...extraScreens.keys()]) if (!r.procs.some((p) => p.surfaceId === id)) { extraScreens.delete(id); if (!screens.has(id)) asst.forget(id); }
      if (!procState.at) console.log(`sessions: first process list, ${r.procs.length} session process(es), ${Math.round(process.uptime() * 1000)} ms after start`);
      procState = { ...r, error: null };
    } catch (e) {
      procState = { ...procState, error: String(e.message || e) };
      console.error('sessions:', procState.error);
    } finally {
      procBusy = null;
    }
    // The next tick now, not at the next interval: a fresh process list
    // ties sessions to their panes (2 s sooner after an update).
    wantTick = true;
    if (!ticking) setTimeout(tick, 20);
  })();
  return procBusy;
}

function holdersInPanes(evAll) {
  const out = new Map();
  for (const p of procState.procs) {
    if (!p.ravenryId || endedProcs.has(`${p.pid}@${p.startedAt}`)) continue;
    const m = sess.mapProcess(p, { evAll, hooks: [], boardTab: null });
    if (m && m.sessionId && !out.has(m.sessionId)) out.set(m.sessionId, { pane: p.ravenryId, pid: p.pid });
  }
  return out;
}

// Which sessions in a terminal outside Ravenry still have their process:
// one `ps -p` over their hooks' pids. A process that ended there makes the
// Sessions page read the processes again.
async function refreshOutsideAlive(evAll) {
  const pids = [...evAll.values()].filter((e) => !e.endedAt && e.pid && termOf(e) !== 'ravenry' && !e.machine).map((e) => e.pid);
  const now = await sess.alivePids(pids);
  if (!now) return;
  if (outsideAlive && [...outsideAlive].some((p) => !now.has(p))) refreshProcs();
  outsideAlive = now;
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
  const kind = asst.kindOf(e || p.assistant);
  const tp = e ? transcriptOf(e) : asst.findTranscript(kind, sid, p.cwd);
  const t = tp ? asst.readTranscript(kind, tp) : null;
  const x = tab ? screens.get(p.surfaceId) || extraScreens.get(p.surfaceId) || null : null;
  const screen = judgedScreen(x);
  const title = asst.parseTitle(tab ? tab.s.title : '', kind);
  const st = eventState({ ev: e, screen, screenAt: x ? x.at : null, title, transcript: t }, settings, now)
    || { ...sessionState({ screen, title, transcript: t, hook: null, who: asst.of(kind).SHORT }, settings, now), source: 'screen' };
  const where = e || { cwd: p.cwd };
  const own = eventOwner(where, realFolder(tp, where)) || loose.find((l) => l.sessionIds.includes(sid)) || null;
  return { st, t, ev: e, marker: markers.get(sid) || null, screen, startedAt: p.startedAt, project: own || null, waitingOn: own ? own.waitingOn || null : null, words: null, topic: (t && t.title) || null, cwd: (e && e.cwd) || p.cwd };
}

function mixOf(st, waitingOn) {
  const k = SESSION_TO_PROJECT[st ? st.state : ''];
  return k || (waitingOn ? 'wait' : 'idle');
}

// One row per claude process, grouped the way the Sessions page shows them.
// Async only to give the event loop back every 50 ms: the first read of a
// session's transcripts (its work folder) takes a while on big ones.
async function buildSessions(workspaces, hooks, settings, now, projects) {
  const where = new Map();
  for (const w of workspaces) for (const s of w.surfaces) where.set(s.id, { w, s, kind: 'cmux' });
  // A process in an iTerm2 session or a Rex pane (ITERM_SESSION_ID or
  // REX_BLOCK in its environment).
  for (const kind of term.OTHER_KINDS) {
    const it = otherTabs[kind];
    const name = term.nameOf(kind);
    if (it && it.ok) for (const t of it.tabs.values()) where.set(t.id, { w: kind === 'cmux' ? { id: t.workspaceId, ref: t.workspaceRef, title: t.workspaceTitle } : { id: null, ref: name, title: name }, s: { id: t.id, title: t.title, type: 'terminal' }, kind });
  }
  // The tab this board itself runs in, outside cmux.
  const boardOther = [process.env.ITERM_SESSION_ID ? term.tabIdFor('iterm', process.env.ITERM_SESSION_ID) : null, process.env.REX_BLOCK ? term.tabIdFor('rex', process.env.REX_BLOCK) : null, process.env.RAVENRY_PANE ? term.tabIdFor('ravenry', process.env.RAVENRY_PANE) : null].filter(Boolean);
  const boardTab = new Map(boardTabs.filter((b) => b.s.terminal !== false).map((b) => [b.s.surfaceId, { sessionId: b.s.sessionId, method: b.s.method }]));
  const bySid = new Map(boardTabs.filter((b) => b.s.sessionId).map((b) => [b.s.sessionId, b]));
  const rows = [];
  let slice = Date.now();
  for (let p of procState.procs) {
    if (Date.now() - slice > 50) { await new Promise((r) => setImmediate(r)); slice = Date.now(); }
    // A process a move ended is gone, even before the process list says so.
    if (endedProcs.has(`${p.pid}@${p.startedAt}`)) continue;
    const otherKind = p.surfaceId ? null : p.ravenryId ? 'ravenry' : p.rexId ? 'rex' : p.itermId ? 'iterm' : null;
    const otherId = otherKind ? term.tabIdFor(otherKind, p[PROC_TAB[otherKind]]) : null;
    const tab = p.surfaceId ? where.get(p.surfaceId) || null : otherId ? where.get(otherId) || null : null;
    if (otherId) p = { ...p, surfaceId: otherId };
    const m = sess.mapProcess(p, { evAll: ev.all, hooks, boardTab });
    const base = {
      pid: p.pid, startedAt: p.startedAt, memKb: p.rssKb, cwd: p.cwd, folder: homes.sayLocal(p.cwd), assistant: asst.kindOf(p.assistant),
      surfaceId: tab ? p.surfaceId : null, workspaceId: tab ? tab.w.id : null, workspaceRef: tab ? tab.w.ref : null, inCmux: !!tab && tab.kind === 'cmux',
      // The terminal the process runs in, from its environment (its tab or not).
      termKind: p.ravenryId ? 'ravenry' : p.rexId ? 'rex' : p.itermId ? 'iterm' : (otherId ? null : p.surfaceId) ? 'cmux' : null,
      sessionId: m ? m.sessionId : null, method: m ? m.method : null,
    };
    if (!m) {
      rows.push({ ...base, group: 'unmapped', mix: 'unmapped', label: sess.folderLabel(p.cwd), isFolder: true, unowned: true, projectId: null, state: 'unknown',
        line: `No session found for pid ${p.pid}`, tag: null, since: p.startedAt, closable: false, blocked: 'Not mapped to a session' });
      continue;
    }
    const info = sessionInfo(m.sessionId, p, tab, bySid.get(m.sessionId) || null, settings, now);
    const cls = sess.classify(info, idleMsFor(m.sessionId, settings), now);
    const sc = info.screen && info.screen.readable ? info.screen : null;
    let blocked = null;
    if (!tab) blocked = otherId ? `Its ${term.nameOf(otherKind)} tab is gone` : p.surfaceId ? (term.canDrive('cmux') ? 'Its cmux tab is gone' : 'In cmux') : `Outside ${term.nameOf(term.BOARD)}`;
    else if (p.surfaceId === process.env.CMUX_SURFACE_ID || boardOther.includes(p.surfaceId)) blocked = 'The tab this board runs in';
    else if (tab.kind === 'cmux' && !term.canDrive('cmux')) blocked = 'In cmux';
    else if (sc && !sc.claudeLive) blocked = 'Claude is not on screen in its tab';
    // Close idle ends Claude Code sessions only (docs/SESSIONS.md).
    if (!blocked && base.assistant !== 'claude') blocked = `Close idle ends Claude Code sessions only; end ${asst.nameOf(base.assistant)} in its tab`;
    rows.push({
      ...base, group: cls.group, tag: cls.tag || null, useWhy: cls.why || null, since: cls.since || cls.lastAt,
      // A session in a workspace no project lists is "Not in a project", as
      // on the project list (docs/design/CodexStage2.dc.html, section 2).
      label: info.project ? info.project.name : sess.folderLabel(info.cwd), isFolder: !info.project || !!info.project.unowned, unowned: !info.project || !!info.project.unowned, projectId: info.project ? info.project.id : null,
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
    // Another terminal's tab (iTerm2, Rex), asked again right now.
    const t = await freshTab(row.surfaceId).catch(() => null);
    surface = t ? { id: t.surfaceId, title: t.title, type: 'terminal', sessionId: t.sessionId || null } : null;
    ws = { id: null, ref: name, title: name };
  }
  if (!surface || surface.type !== 'terminal') return fail(`Its ${name} tab is gone.`);
  const still = await sess.stillThere(row.pid, row.startedAt);
  if (!still) return fail('Its Claude process already ended.');
  const stillTab = still.surfaceId || (still.ravenryId ? term.tabIdFor('ravenry', still.ravenryId) : still.rexId ? term.tabIdFor('rex', still.rexId) : still.itermId ? term.tabIdFor('iterm', still.itermId) : null);
  if (stillTab !== row.surfaceId) return fail('Its process is not in that tab.');
  const tab = kind === 'cmux' ? { kind, workspaceId: ws.id, surfaceId: row.surfaceId } : { kind, surfaceId: row.surfaceId };
  // Close idle sessions closes Claude Code processes only (docs/SESSIONS.md).
  let screen = asst.parseScreen(await term.readScreen(tab, 40), 'claude');
  if (!screen.readable) return fail(`${name} could not read its tab, so it was left open.`);
  if (!screen.claudeLive) return fail('Claude is not at its prompt in that tab.');
  // Text in the prompt that the Sessions page did not show as half typed:
  // closing is fine over Claude's suggested reply, never over typed text.
  if (screen.draft && row.tag !== 'draft') {
    const v = await asst.surePrompt('claude', tab, screen);
    if (v.kind === 'draft') return fail('A reply is half typed in its prompt.');
    if (v.kind !== 'suggestion') return fail(`Its prompt holds text the board could not tell from a half-typed reply (${v.error || 'no answer'}), so it was left open.`);
    screen = asst.withPrompt('claude', screen, v);
  }
  const e = events.scan().get(id) || null;
  const tp = e ? transcriptOf(e) : asst.findTranscript('claude', id, row.cwd);
  const t = tp ? asst.readTranscript('claude', tp) : null;
  const now = Date.now();
  const title = asst.parseTitle(surface.title, 'claude');
  const st = eventState({ ev: e, screen, screenAt: now, title, transcript: t }, settings, now) || sessionState({ screen, title, transcript: t, hook: null }, settings, now);
  const cls = sess.classify({ st, t, ev: e, marker: handoff.readMarker(id), screen, startedAt: row.startedAt }, idleMsFor(id, settings), now);
  if (cls.group === 'use') return fail(`It is in use now (${cls.why}).`);
  // The record first, so a tab that closes always has its Reopen.
  sess.writeClosed({
    id, cwd: row.cwd, workspaceId: ws.id, workspaceRef: ws.ref, workspace: ws.title, surfaceId: row.surfaceId, term: kind, termSession: (surface && surface.sessionId) || null,
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
// now, when that workspace is gone), or in iTerm2 or Rex when it was closed
// there (Rex: in the closed tab's Rex session while it is open, else a new
// Rex session), running `cd <cwd> && claude --resume <id>`.
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
    // Closed in iTerm2 or Rex, or on a board in iTerm2 mode or Rex mode: a
    // new tab there (iTerm2's current window; Rex: the old tab's session).
    const k = rec.term && rec.term !== 'cmux' && term.canDrive(rec.term) ? rec.term : term.BOARD;
    if (k !== 'cmux') {
      const name = term.nameOf(k);
      const made = await term.openTab(k, k === 'rex' || k === 'ravenry' ? { near: term.kindOf(rec.surfaceId) === k ? rec.surfaceId : null, session: rec.termSession || null, cwd: cwd0, label: rec.label || null } : {});
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

// Continue in Ravenry (POST /api/sessions/resume { projectId, sessionId,
// cols, rows }): a session in a terminal outside Ravenry is resumed in a
// Ravenry pane, in its folder, with `claude --resume <id>` (`codex resume
// <id>`), through ravenryd as any session the app starts. Never while a
// process still holds that session id, wherever it runs: two processes on
// one session would both write its transcript. While another process
// holds it, the answer says so; Move here (moveSession) ends it first.
// Asked again for a session it resumed, the answer is the same pane.
function procHolding(sid) {
  for (const p of procState.procs) {
    const m = sess.mapProcess(p, { evAll: ev.all, hooks: [], boardTab: null });
    if (((m && m.sessionId === sid) || p.argvSession === sid) && !endedProcs.has(`${p.pid}@${p.startedAt}`)) return p;
  }
  return null;
}

// `fresh` (Move here, never over HTTP): a new pane even when the board's row
// still names an old one, which the move is about to close; the check that
// no process holds the session still applies.
async function resumeSession(body, { fresh = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const sid = String(b.sessionId || '').toLowerCase();
  if (!sess.UUID.test(sid)) return { ok: false, status: 400, error: 'sessionId is a session id.' };
  const project = findProject(b.projectId);
  if (!project) return { ok: false, status: 404, error: 'No such project.' };
  const e = ev.all.get(sid) || null;
  const snap = snapshot.projects.find((x) => x.id === project.id);
  const s = snap ? snap.sessions.find((x) => x.sessionId === sid) || null : null;
  if (!e && !s) return { ok: false, status: 404, error: 'No such session in that project.' };
  if ((e && e.machine) || (s && s.machine) || project.machine) return { ok: false, status: 409, error: 'It runs on another machine; continue it there.' };
  const paneOfTab = (id) => (term.kindOf(id) === 'ravenry' ? id.slice('ravenry:'.length) : null);
  // Already in a Ravenry pane: that pane.
  if (!fresh && s && term.kindOf(s.surfaceId) === 'ravenry') return { ok: true, already: true, surfaceId: s.surfaceId, pane: { id: paneOfTab(s.surfaceId) }, projectId: project.id };
  const done = fresh ? null : resumed.get(sid);
  if (done && (await freshTab(done.surfaceId).catch(() => null))) return { ok: true, already: true, surfaceId: done.surfaceId, pane: done.pane, projectId: project.id };
  if (resumeBusy.has(sid)) return { ok: false, status: 409, error: 'Already starting it.' };
  resumeBusy.add(sid);
  try {
    // A fresh process list, never the minute-old one.
    await refreshProcs();
    if (procState.error) return { ok: false, status: 503, error: `Ravenry could not list the running sessions (${procState.error}), so it started nothing.` };
    const holder = procHolding(sid);
    if (holder && holder.ravenryId) return { ok: true, already: true, surfaceId: term.tabIdFor('ravenry', holder.ravenryId), pane: { id: holder.ravenryId }, projectId: project.id };
    if (holder) {
      const where = term.nameOf((s && s.term) || termOf(e) || (holder.surfaceId ? 'cmux' : holder.itermId ? 'iterm' : holder.rexId ? 'rex' : null));
      return { ok: false, status: 409, open: true, error: `It is still open in ${where}. Close it there first, then continue it here.` };
    }
    const kind = asst.kindOf((e && e.assistant) || (s && s.assistant) || 'claude');
    const cwd = [e && e.cwd, project.folder].find((d) => d && path.isAbsolute(d) && fs.existsSync(d)) || null;
    if (!cwd) return { ok: false, status: 409, error: 'Its folder is gone, so there is nowhere to continue it.' };
    const pl = sessionstart.plan({ projectId: project.id, folder: cwd, assistant: kind, resume: sid, cols: b.cols, rows: b.rows }, {
      project,
      launch: (_p, k) => launchFor({ kind: k, note: null }),
      machines: machines.status().map((m) => m.name),
      binPath: assistantPath,
    });
    if (!pl.ok) return { ok: false, status: pl.status, error: pl.error };
    const r = await term.ravenryStart(pl);
    if (!r.ok) return { ok: false, status: 502, error: `Could not start it: ${r.err}` };
    watchOpened(r);
    resumed.set(sid, { at: Date.now(), surfaceId: r.surfaceId, pane: r.pane });
    console.log(`sessions: ${sid} continues in Ravenry (${r.surfaceId})`);
    wantTick = true; setTimeout(tick, 30);
    setTimeout(refreshProcs, 4000);
    return { ok: true, surfaceId: r.surfaceId, pane: r.pane, machine: r.machine || null, projectId: project.id, command: pl.line, assistant: pl.kind };
  } finally {
    resumeBusy.delete(sid);
  }
}

// ------------------------------------------------------------ Move here
//
// One click puts a conversation in one place (2026-11-07: "So the user
// needs to understand all this by himself?"). POST /api/sessions/move
// { projectId, sessionId, keep: 'ravenry' | 'outside', cols, rows }:
//   keep 'ravenry' (Move here): every process on that session id ends, in
//     the other terminal and in Ravenry, then it resumes in a Ravenry pane:
//     the one it was in when its shell is still there, else a new one. The
//     other terminal's tab is left with its shell.
//   keep 'outside' (Keep it in cmux): the Ravenry copy ends; the other
//     terminal's goes on.
// A process ends only when the session is not mid-turn (its hook state:
// the last event a prompt with no Stop after it); mid-turn, the move waits
// and the tick does it once the turn ends. Each process is checked again
// just before it is signalled: still alive, same start time, and still on
// this session id. SIGTERM, then SIGKILL after 5 s only if it is still
// there. Two processes never run on one session id after it.

const MOVE_KILL_MS = 5000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// The processes a move ended ("<pid>@<startedAt>"): left out of any process
// list read before it caught up.
const endedProcs = new Set();

// Mid-turn, by the hook state.
function busyOn(sid) {
  const e = ev.all.get(sid);
  return !!(e && !e.endedAt && e.last && e.last.event === 'UserPromptSubmit');
}

// The processes on this session id now (a fresh list first): { pid, startedAt, ravenryId, where }.
async function holdersOf(sid) {
  await refreshProcs();
  const out = [];
  for (const p of procState.procs) {
    const m = sess.mapProcess(p, { evAll: ev.all, hooks: [], boardTab: null });
    if (!((m && m.sessionId === sid) || p.argvSession === sid) || endedProcs.has(`${p.pid}@${p.startedAt}`)) continue;
    const kind = p.ravenryId ? 'ravenry' : p.surfaceId ? 'cmux' : p.itermId ? 'iterm' : p.rexId ? 'rex' : termOf(ev.all.get(sid)) || null;
    out.push({ pid: p.pid, startedAt: p.startedAt, ravenryId: p.ravenryId || null, where: kind === 'ravenry' ? 'Ravenry' : term.nameOf(kind) || 'another terminal' });
  }
  return out;
}

// Ends one process of this session: { pid, where, signal, ms } or { pid, skipped }.
async function endHolder(h, sid) {
  const now = (await holdersOf(sid)).find((x) => x.pid === h.pid && x.startedAt === h.startedAt);
  if (!now) { console.log(`sessions: move ${sid}: left ${h.pid} alone (no longer on this session)`); return { pid: h.pid, where: h.where, skipped: true }; }
  const t0 = Date.now();
  try { process.kill(h.pid, 'SIGTERM'); } catch { endedProcs.add(`${h.pid}@${h.startedAt}`); return { pid: h.pid, where: h.where, signal: 'gone', ms: 0 }; }
  while (alive(h.pid) && Date.now() - t0 < MOVE_KILL_MS) await new Promise((r) => setTimeout(r, 100));
  let signal = 'SIGTERM';
  if (alive(h.pid)) { try { process.kill(h.pid, 'SIGKILL'); } catch { /* gone */ } signal = 'SIGKILL'; for (let i = 0; i < 20 && alive(h.pid); i++) await new Promise((r) => setTimeout(r, 100)); }
  const ms = Date.now() - t0;
  if (!alive(h.pid)) endedProcs.add(`${h.pid}@${h.startedAt}`);
  console.log(`sessions: move ${sid}: ended ${h.pid} in ${h.where} with ${signal} in ${ms} ms`);
  return { pid: h.pid, where: h.where, signal, ms };
}

async function moveSession(body) {
  const b = body && typeof body === 'object' ? body : {};
  const sid = String(b.sessionId || '').toLowerCase();
  const keep = b.keep === 'outside' ? 'outside' : 'ravenry';
  if (!sess.UUID.test(sid)) return { ok: false, status: 400, error: 'sessionId is a session id.' };
  const project = findProject(b.projectId);
  if (!project) return { ok: false, status: 404, error: 'No such project.' };
  const e = ev.all.get(sid) || null;
  if ((e && e.machine) || project.machine) return { ok: false, status: 409, error: 'It runs on another machine; move it there.' };
  const snap = snapshot.projects.find((x) => x.id === project.id);
  const s = snap ? snap.sessions.find((x) => x.sessionId === sid) || null : null;
  if (!e && !s) return { ok: false, status: 404, error: 'No such session in that project.' };
  if (resumeBusy.has(sid)) return { ok: false, status: 409, error: 'Already moving it.' };
  const holders0 = await holdersOf(sid);
  const outside = holders0.find((h) => !h.ravenryId);
  const name = outside ? outside.where : termOf(e) ? term.nameOf(termOf(e)) : 'the other terminal';
  if (busyOn(sid)) {
    moves.set(sid, { body: { ...b, keep }, since: Date.now(), name: (holders0.find((h) => (keep === 'ravenry' ? !h.ravenryId : h.ravenryId)) || holders0[0] || { where: name }).where });
    console.log(`sessions: move ${sid} (keep ${keep}): waiting for the turn to end`);
    wantTick = true;
    return { ok: true, waiting: true, name: moves.get(sid).name };
  }
  moves.delete(sid);
  resumeBusy.add(sid);
  try {
    const ended = [];
    const inRavenry = holders0.filter((h) => h.ravenryId);
    if (keep === 'outside') {
      for (const h of inRavenry) ended.push(await endHolder(h, sid));
      const olds = new Set(inRavenry.map((h) => h.ravenryId));
      setTimeout(() => { for (const id of olds) void closeOldPane(sid, id); }, 2000);
      resumed.delete(sid);
      movedLast.set(sid, { at: Date.now(), keep, ended, surfaceId: null, replaced: [...olds] });
      // The rows follow: the process list without the copy that ended.
      await refreshProcs();
      wantTick = true; setTimeout(tick, 30);
      return { ok: true, keep, ended, replaced: [...olds] };
    }
    // The Ravenry pane it was in (its process, else the board's row): never
    // used again. Its shell may carry what the daemon that made it inherited
    // (an older daemon started from a Claude Code shell handed its panes
    // CLAUDECODE and CMUX_*, and a Claude resumed there saved no
    // transcript), so the session resumes in a new pane of the current
    // daemon, clean by construction, and the old pane closes once its
    // assistant has ended. The app puts the new one where the old one was.
    const oldPanes = new Set(inRavenry.map((h) => h.ravenryId));
    if (s && term.kindOf(s.surfaceId) === 'ravenry') oldPanes.add(s.surfaceId.slice('ravenry:'.length));
    for (const h of holders0) ended.push(await endHolder(h, sid));
    resumed.delete(sid);
    const left = await holdersOf(sid);
    if (left.length) return { ok: false, status: 409, error: `It is still running (pid ${left.map((h) => h.pid).join(', ')}), so it was not started again.`, ended };
    resumeBusy.delete(sid);
    const r = await resumeSession({ projectId: project.id, sessionId: sid, cols: b.cols, rows: b.rows }, { fresh: true });
    // Once the app has put the new pane in its place (it answers within a
    // moment); kept when the resume failed, so nothing is lost from view.
    const newPane = r.ok && r.pane ? r.pane.id : null;
    if (newPane) oldPanes.delete(newPane);
    if (r.ok) setTimeout(() => { for (const id of oldPanes) void closeOldPane(sid, id); }, 2000);
    if (r.ok) console.log(`sessions: move ${sid}: resumed in a new pane, ${r.surfaceId}${oldPanes.size ? ` (was ${[...oldPanes].join(', ')})` : ''}`);
    movedLast.set(sid, { at: Date.now(), keep, ended, surfaceId: r.ok ? r.surfaceId : null, replaced: [...oldPanes] });
    wantTick = true; setTimeout(tick, 30);
    setTimeout(refreshProcs, 2000);
    return { ...r, keep, ended, replaced: [...oldPanes] };
  } finally {
    resumeBusy.delete(sid);
  }
}

// An old pane of a move, closed now that its assistant has ended (its
// shell, and whatever else runs in it, with it). Said in the hub's log.
async function closeOldPane(sid, id) {
  if (!id) return;
  const r = await term.ravenryClose(`ravenry:${id}`).catch((e) => ({ ok: false, err: e.message }));
  console.log(`sessions: move ${sid}: closed its old pane ${id}${r.ok ? '' : ` (${r.err || 'not closed'})`}`);
}

// The tick's part: a waiting move goes once its turn has ended.
function runMoves() {
  for (const [sid, m] of moves) {
    if (busyOn(sid)) continue;
    moves.delete(sid);
    moveSession(m.body).then((r) => console.log(`sessions: move ${sid} after its turn: ${r.ok ? 'done' : r.error}`), (err) => console.log(`sessions: move ${sid} after its turn failed: ${err.message}`));
  }
}

// What the session's card and tab show about a move: { waiting, name } while
// one waits for the turn to end; the last move's result for a minute; and,
// for a session in a Ravenry pane whose conversation went on in another
// process, { movedOn: name }.
function moveOf(s) {
  if (!s.sessionId) return {};
  const out = {};
  const w = moves.get(s.sessionId);
  if (w) out.moving = { waiting: true, keep: w.body.keep, name: w.name };
  const last = movedLast.get(s.sessionId);
  if (last && Date.now() - last.at < 60000) out.moved = last;
  if (term.kindOf(s.surfaceId) === 'ravenry') {
    const e = ev.all.get(s.sessionId);
    const mine = paneHolders.get(s.sessionId);
    const p = mine ? procState.procs.find((x) => x.pid === mine.pid) : null;
    // The latest hook came from another process, after this pane's started.
    if (e && e.pid && mine && e.pid !== mine.pid && p && p.startedAt && e.pidAt && e.pidAt > p.startedAt && !busyOn(s.sessionId)) {
      out.movedOn = { name: term.nameOf(termOf(e)) || 'another terminal', pid: e.pid };
    }
  }
  return out;
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
  return cands.find((e) => handoff.isResumePrompt(asst.firstPrompt(asst.kindOf(e), e.transcriptPath))) || null;
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function resumePrompt(m, cwd) {
  const f = m.handoffFile;
  const rel = f && cwd && !path.relative(cwd, f).startsWith('..') ? path.relative(cwd, f) : f;
  const line = decisions.promptLine(m.projectId || null);
  return `Read the Hand-off section of ${rel || 'BRIEF.md (or HANDOFF.md)'} and continue from it.${line ? ' ' + line : ''}`;
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
    // A session on a remote machine hands off there: its folder is checked
    // by that machine's daemon, not here.
    const cwd = m.machine ? m.cwd || m.folder || null : [m.cwd, m.folder].find((d) => d && fs.existsSync(d)) || null;
    // The fresh session opens in the terminal the old one ran in: a new
    // cmux tab next to it, a new iTerm2 tab in its window, or a new Rex tab
    // in its Rex session.
    const where = term.freshTerminal(sessionTerminal(sid, m));
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
      made = await term.openTab(where.kind, { near: where.near, session: where.session || null, cwd, label: cwd ? path.basename(cwd) : null });
      if (!made.ok) return fail(`${term.nameOf(where.kind)} did not open a tab: ` + (made.err || 'no answer'));
      tab = { kind: where.kind, surfaceId: made.surfaceId };
      whereRef = term.nameOf(where.kind);
    } else {
      return fail(`It ran in ${term.nameOf(where.kind)}, where the board cannot open a tab. Start the fresh session there yourself.`);
    }
    await new Promise((r) => setTimeout(r, 900)); // let the shell draw its prompt
    // A hand-off continues the same work, so the fresh session runs the
    // assistant of the session it hands off from, not continueChoice.
    // A plan running in the project's brief: the fresh session reads it
    // first, and the board logs the pick-up at the step it starts from.
    const owner = snapshot.projects.find((x) => x.sessions.some((y) => y.sessionId === sid));
    const runningPlan = owner && owner.plan && owner.plan.state !== 'done' && owner.plan.state !== 'stopped' ? owner.plan : null;
    const prompt = resumePrompt(m, cwd) + (runningPlan ? ` The brief has a running plan, "${runningPlan.title.replace(/'/g, '')}", under ## Plan: read it first${(runningPlan.refs || []).length ? ', and the References listed under its Goal' : ''}, and carry on from the first step not ticked, by the rules written in it.` : '');
    // cmux opens the tab in the folder; another terminal's tab starts where
    // its profile says, so the command goes there first.
    const launch = `${asst.launchCommand(asst.kindOf(ev.all.get(sid) || m), settings)} ${shellQuote(prompt)}`;
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
// (iTerm2 or Rex with its tab as `near`, and Rex's session), else the tab
// its marker names, else cmux as before.
function sessionTerminal(sid, m) {
  const e = ev.all.get(sid);
  if (e && e.terminal && e.terminal !== 'cmux') return { kind: e.terminal, near: term.tabIdFor(e.terminal, e.terminalId), session: e.terminalSession || null };
  if (!(e && e.terminal) && m && m.surfaceId && term.kindOf(m.surfaceId) !== 'cmux') return { kind: term.kindOf(m.surfaceId), near: m.surfaceId };
  if (e && e.terminal === 'cmux') return { kind: 'cmux', near: null };
  // Nothing says where: the board's own terminal.
  return { kind: term.BOARD, near: null };
}

// Each written hand-off gets its fresh session once, when the terminal it
// goes to answers this tick (a cmux hand-off waits while cmux is down, an
// iTerm2 or Rex one while that terminal cannot be asked).
function autoStarts(workspaces, cmuxOk) {
  if (reg.settings.handoffAutoStart === false) return;
  for (const [sid, m] of markers) {
    if (m.state === 'written' && !m.resumeStartedAt && !starting.has(sid)) {
      const k = term.freshTerminal(sessionTerminal(sid, m)).kind;
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
  if (!s || !s.sessionId) return { ok: false, status: 409, error: `No ${asst.of(s ? s.assistant : p.assistant).SHORT} session to hand off here.` };
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

// A tab of the project's in the board's own terminal (iTerm2 mode, Rex
// mode), so a new one opens in the same window (Rex: the same Rex
// session): its primary session's, else any.
function nearTab(projectId) {
  if (term.BOARD === 'cmux') return null;
  const p = snapshot.projects.find((x) => x.id === projectId);
  const mine = p ? p.sessions.filter((x) => x.terminal && x.term === term.BOARD) : [];
  const s = mine.find((x) => x.surfaceId === p.primary) || mine[0];
  return s ? s.surfaceId : null;
}

// A registered project, else this tick's card for a loose session.
// The open checkpoints for the board and the app, each with the project and
// session whose pane asked, when the board knows it.
// Approvals a page's run button opened (the person pressed it, no agent
// asked): checkpoint id -> { page, label, project }.
const pageRuns = new Map();

function checkpointsView(projects) {
  return checkpoints.list().map((cp) => {
    const tab = cp.pane ? term.tabIdFor('ravenry', cp.pane) : null;
    const p = tab ? projects.find((x) => x.sessions.some((y) => y.surfaceId === tab)) : null;
    const { daemon: _d, ...rest } = cp;
    const run = pageRuns.get(cp.id);
    const kept = cp.kind === 'pick' ? picks.record(cp.id) : null;
    const dn = cp.kind === 'drive' && rest.drive ? driveNames.get(cp.id) : null;
    if (dn) rest.drive = { ...rest.drive, name: dn.name || null, session: dn.session || null };
    return { ...rest, projectId: p ? p.id : null, project: p ? p.name : run && run.project ? run.project : null, surfaceId: tab, ...(run ? { page: { title: run.page, label: run.label } } : {}), ...(kept ? { pick_record: { file: path.join(kept.dir, 'pick.json'), variants: kept.variants.map((v, n) => ({ label: v.label, type: v.type, ...(v.description ? { description: v.description } : {}), url: `/api/checkpoints/${encodeURIComponent(cp.id)}/variants/${n}`, kept: !!v.file })) } } : {}) };
  });
}

function onCheckpoint(cp, where) {
  // A pick's pictures are kept with its project in Ravenry's data
  // (server/picks.mjs) as soon as it is seen, and its answer once it closes.
  if (cp && cp.kind === 'pick') keepPick(cp, where);
  if (!checkpoints.take(cp, where)) return;
  const tab = cp.pane ? term.tabIdFor('ravenry', cp.pane) : null;
  const p = tab && snapshot && snapshot.projects ? snapshot.projects.find((x) => x.sessions.some((y) => y.surfaceId === tab)) : null;
  const alert = (names = {}) => { try { alerts.checkpointAlert(cp, { project: p || null, machine: where.machine, boardUrl: boardUrl(), paneName: names.name || null, askerName: names.session || null }); } catch (e) { console.error('alerts:', e.message); } };
  // A drive names the pane it would act on, and the pane that asks, as the
  // sidebar and the tabs do, whether or not a session runs in them.
  if (cp.kind === 'drive' && cp.drive && cp.drive.pane) {
    const asker = cp.pane && !(p && p.sessions.some((y) => y.surfaceId === tab)) ? paneName(cp.pane) : Promise.resolve(null);
    Promise.all([paneName(cp.drive.pane), asker]).then(([name, session]) => {
      const names = { name, session: session || (p && p.sessions.find((y) => y.surfaceId === tab) || {}).topic || null };
      driveNames.set(cp.id, names);
      if (driveNames.size > 200) driveNames.delete(driveNames.keys().next().value);
      alert(names);
    }, () => alert());
  } else alert();
}

// A drive's pane and asker as people know them, by checkpoint id, for the
// board's checkpoints and the phone's alert: { name, session }.
const driveNames = new Map();

// A pane as the sidebar and the tabs name it: the topic of the session that
// runs in it, else its name, its title or its command's program; null when
// no daemon here knows it.
async function paneName(pane) {
  const tab = term.tabIdFor('ravenry', pane);
  for (const p of (snapshot && snapshot.projects) || []) {
    const s = p.sessions.find((x) => x.surfaceId === tab);
    if (s) return s.topic || p.name;
  }
  const x = await paneInfo(pane);
  if (!x) return null;
  return x.name || x.title || (x.command && x.command[0] ? path.basename(x.command[0]) : null);
}

function safe(fn) { try { return fn(); } catch (e) { return { state: 'unreadable', error: e.message }; } }

// The project a reader or an agent names: its id, its name, or a folder in
// it or in one of its sessions' worktrees (server/decisions.mjs).
function projectIdOf(name) {
  const all = [...((reg && reg.projects) || []), ...loose, ...unowned];
  const p = decisions.resolveProject(name, all, worktrees.folders());
  return p ? p.id : null;
}

// A pick checkpoint's variant n, served from the copy kept in Ravenry's
// data (server/picks.mjs), made from the machine that holds the
// checkpoint if it is not kept yet. Only the files the checkpoint names;
// HTML and SVG come sandboxed, so they never run a script on the hub's
// origin.
async function serveVariant(res, id, n) {
  const cp = checkpoints.get(id);
  let k = picks.keptFile(id, n);
  if (!k && cp && cp.kind === 'pick' && Array.isArray(cp.variants) && cp.variants[n]) {
    await picks.keep(cp, { projectId: cp.pane ? projectOfPane(cp.pane) : null, machine: cp.machine || null, read: (f) => term.ravenryReadFile(cp.daemon, f, { max: picks.MAX_FILE }) }).catch(() => null);
    k = picks.keptFile(id, n);
  }
  if (!k) {
    const r = picks.record(id);
    const v = (r && r.variants && r.variants[n]) || null;
    return sendJson(res, v ? 502 : 404, { error: v ? `That picture could not be kept: ${v.error || 'unknown'}.` : 'No such pick, or no such variant.' });
  }
  const type = picks.TYPES[k.ext];
  const sandboxed = k.type === 'html' || k.ext === 'svg';
  const data = fs.readFileSync(k.file);
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': sandboxed ? 'sandbox' : "default-src 'none'",
  });
  res.end(data);
}

// The ledger's writes (server/decisions.mjs). /record is open: an agent
// records the person's words with `ravenry decide`, marked with the pane
// its process runs in (judged by ravenryd peer, never taken from the body)
// and that pane's assistant session; the person is told at once, with
// Undo for a minute. add, edit, undo and remove are person rows.
async function decisionsWrite(req, res, p) {
  let body;
  try { body = await jsonBody(req, 1e5); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
  const b = body && typeof body === 'object' ? body : {};
  const projectOf = (v) => (v == null || v === '' ? { id: null } : { id: projectIdOf(v), bad: !projectIdOf(v) });
  const done = (r, extra = {}) => sendJson(res, r.ok ? 200 : r.status, r.ok ? { ok: true, ...extra } : { error: r.error });
  const fields = { '/api/decisions/record': ['quote', 'project', 'replaces', 'scope'], '/api/decisions/add': ['quote', 'project', 'replaces', 'overrides', 'scope'], '/api/decisions/edit': ['id', 'quote', 'project', 'scope'], '/api/decisions/undo': ['id'], '/api/decisions/remove': ['id'] }[p];
  // A field the ledger does not know is refused, not dropped: who
  // recorded an entry is never taken from the body.
  const unknown = fields ? Object.keys(b).filter((k) => !fields.includes(k)) : [];
  if (unknown.length) return sendJson(res, 400, { error: `The ledger does not take ${unknown.join(', ')}.` });
  if (p === '/api/decisions/record' || p === '/api/decisions/add') {
    if (b.replaces != null && b.overrides != null) return sendJson(res, 400, { error: 'Give replaces or overrides, not both.' });
    const pr = projectOf(b.project);
    if (pr.bad) return sendJson(res, 404, { error: 'No such project.' });
    const replaces = b.replaces != null ? [b.replaces] : b.overrides;
    if (p === '/api/decisions/add') {
      const r = decisions.add({ quote: b.quote, projectId: pr.id, scope: b.scope, overrides: replaces, by: 'person' });
      if (r.ok) broadcast('decision', { type: 'saved', decision: decisions.view(r.entry) });
      return done(r, r.ok ? { decision: decisions.view(r.entry) } : {});
    }
    const { pane } = await person.callerPane(req, term.ravenryBin());
    let recordedBy = null;
    if (pane) {
      const ag = pane !== '?' ? await term.ravenryPaneAgent(pane).catch(() => null) : null;
      recordedBy = { pane, ...(ag && ag.session ? { session: ag.session } : {}), ...(ag && ag.assistant ? { assistant: ag.assistant } : {}) };
    }
    // An agent that names no project records for its own session's.
    const projectId = pr.id || (pane && pane !== '?' ? projectOfPane(pane) : null);
    const r = decisions.add({ quote: b.quote, projectId, scope: b.scope, overrides: replaces, by: pane ? 'agent' : 'client', recordedBy });
    if (!r.ok) return done(r);
    const v = decisions.view(r.entry);
    console.log(`decisions: ${r.entry.id} recorded by ${pane ? `pane ${pane}` : 'a program outside every pane'} for ${projectId || 'every project'}`);
    broadcast('decision', { type: 'saved', decision: v, undo_until: v.undo_until });
    const proj = projectId ? findProject(projectId) : null;
    try { push.fromDecision(r.entry, { project: proj }); } catch (e) { console.error('push:', e.message); }
    return done(r, { decision: v });
  }
  const id = String(b.id || '');
  if (p === '/api/decisions/undo' || p === '/api/decisions/remove') {
    const r = p === '/api/decisions/undo' ? decisions.undo(id) : decisions.remove(id);
    if (r.ok) { broadcast('decision', { type: 'removed', id }); try { push.closeDecision(id); } catch { /* none */ } }
    return done(r, r.ok ? { removed: r.removed } : {});
  }
  if (p === '/api/decisions/edit') {
    const patch = {};
    if (b.quote !== undefined) patch.quote = b.quote;
    if (b.scope !== undefined) patch.scope = b.scope;
    if (b.project !== undefined) {
      const pr = projectOf(b.project);
      if (pr.bad) return sendJson(res, 404, { error: 'No such project.' });
      patch.projectId = pr.id;
    }
    if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'Give the quote, the project or the scope to change.' });
    const r = decisions.edit(id, patch);
    if (r.ok) broadcast('decision', { type: 'edited', decision: decisions.view(r.entry) });
    return done(r, r.ok ? { decision: decisions.view(r.entry) } : {});
  }
  return sendJson(res, 404, { error: 'unknown' });
}

// The review pane's writes on a worktree session (server/worktrees.mjs):
// a comment typed to its agent, the merge (a fast-forward or a merge
// commit, never a squash: the agent's commits stay in the history), or
// throwing it away. Person rows.
async function worktreeWrite(req, res, surfaceId, act) {
  let body;
  try { body = await jsonBody(req, 1e5); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
  const w = worktrees.bySurface(surfaceId);
  if (!w) return sendJson(res, 404, { error: 'That session has no worktree.' });
  if (act === 'comment') {
    const b = body || {};
    if (typeof b.file !== 'string' || !b.file.trim() || b.file.length > 1000) return sendJson(res, 400, { error: 'file is the path the comment is on.' });
    if (b.line != null && !(Number.isInteger(b.line) && b.line >= 1)) return sendJson(res, 400, { error: 'line is a line number, from 1.' });
    if (b.side != null && b.side !== 'old' && b.side !== 'new') return sendJson(res, 400, { error: 'side is old or new.' });
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000) return sendJson(res, 400, { error: 'Type the comment (at most 4000 characters).' });
    if (w.state !== 'open') return sendJson(res, 409, { error: `This session's work was ${w.state} already.` });
    const text = worktrees.commentText({ file: b.file.trim(), line: b.line || null, text: b.text, side: b.side || null });
    // The person's comment, through the composer's send path, tagged as a
    // review comment in the pane's input log.
    const r = await sendMessage({ projectId: w.projectId, surfaceId, text, by: 'review' });
    // Kept with the session's review, as sent (server/reviews.mjs).
    if (r.ok) { try { reviews.add(surfaceId, { file: b.file, line: b.line || null, side: b.side || null, text: b.text, state: 'sent' }); broadcast('review', { surfaceId }); } catch (e) { console.error('reviews:', e.message); } }
    return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? { ok: true, sent: text, delivered: r.delivered } : { error: r.error });
  }
  if (act === 'merge') {
    const mode = (body && body.mode) || 'ff';
    const msg = body && typeof body.message === 'string' ? body.message : null;
    const r = await worktrees.merge(w, { mode, message: msg });
    if (r.ok) { console.log(`worktrees: ${w.branch} merged into ${w.baseBranch} (${mode}, ${r.commit.slice(0, 12)})`); wantTick = true; setTimeout(tick, 30); }
    const { status: _s, ...out } = r;
    return sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { ...out, error: r.error });
  }
  if (act === 'unmerge' || act === 'delete-branch') {
    const r = act === 'unmerge' ? await worktrees.unmerge(w) : await worktrees.deleteBranch(w);
    if (r.ok) { console.log(`worktrees: ${w.branch} ${act === 'unmerge' ? 'unmerged' : 'deleted'}`); wantTick = true; setTimeout(tick, 30); }
    const { status: _s, ...out } = r;
    return sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { ...out, error: r.error });
  }
  const r = await worktrees.discard(w);
  if (r.ok) console.log(`worktrees: ${w.branch} discarded`);
  return sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { error: r.error });
}

// The person's review comments on a worktree session's work, kept by the
// hub (server/reviews.mjs): added pending, taken back, then sent, each
// typed into the session with its id through the composer's send path.
// Person rows.
async function reviewWrite(req, res, surfaceId, act) {
  let body;
  try { body = await jsonBody(req, 1e5); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
  const b = body || {};
  const w = worktrees.bySurface(surfaceId);
  if (!w) return sendJson(res, 404, { error: 'That session has no worktree.' });
  if (act === 'comment') {
    const bad = reviews.problem(b);
    if (bad) return sendJson(res, 400, { error: bad });
    if (w.state !== 'open') return sendJson(res, 409, { error: `This session's work was ${w.state} already.` });
    const r = reviews.add(surfaceId, { file: b.file, line: b.line, side: b.side || null, text: b.text });
    if (r.ok) broadcast('review', { surfaceId });
    return sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { error: r.error });
  }
  if (act === 'remove') {
    if (typeof b.id !== 'string' || !reviews.COMMENT_ID.test(b.id)) return sendJson(res, 400, { error: 'id is the comment\'s id.' });
    const r = reviews.remove(surfaceId, b.id);
    if (r.ok) broadcast('review', { surfaceId });
    return sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { error: r.error });
  }
  // send: the pending ones named (all without ids), in order.
  if (b.ids != null && !(Array.isArray(b.ids) && b.ids.every((x) => typeof x === 'string' && reviews.COMMENT_ID.test(x)))) return sendJson(res, 400, { error: 'ids is a list of comment ids.' });
  if (w.state !== 'open') return sendJson(res, 409, { error: `This session's work was ${w.state} already.` });
  const todo = reviews.pending(surfaceId, b.ids || null);
  if (!todo.length) return sendJson(res, 409, { error: 'There is no comment waiting to be sent.' });
  const sent = [];
  for (const c of todo) {
    const r = await sendMessage({ projectId: w.projectId, surfaceId, text: reviews.sendText(c), by: 'review' });
    if (!r.ok) {
      if (sent.length) broadcast('review', { surfaceId });
      return sendJson(res, r.status || 500, { error: r.error, sent });
    }
    reviews.markSent(surfaceId, c.id);
    sent.push(c.id);
  }
  broadcast('review', { surfaceId });
  return sendJson(res, 200, { ok: true, sent });
}

// An agent answers a review comment (`ravenry review reply <id> "..."`):
// the reply joins the comment's thread. Open to programs, but only from the
// pane of the session the comment is on: the person reads the reply, and
// nothing runs.
async function reviewReply(req, res) {
  let body;
  try { body = await jsonBody(req, 1e5); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
  const b = body || {};
  if (typeof b.id !== 'string' || !reviews.COMMENT_ID.test(b.id)) return sendJson(res, 400, { error: 'id is the review comment\'s id (rc and 7 letters).' });
  if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > reviews.MAX_TEXT) return sendJson(res, 400, { error: `Type the reply (at most ${reviews.MAX_TEXT} characters).` });
  const at = reviews.find(b.id);
  if (!at) return sendJson(res, 404, { error: 'No such review comment.' });
  const w = worktrees.bySurface(at.surfaceId);
  const pane = term.kindOf(at.surfaceId) === 'ravenry' ? at.surfaceId.slice('ravenry:'.length) : (w && w.pane) || null;
  const caller = (await person.callerPane(req, term.ravenryBin())).pane;
  if (!caller || caller !== pane) return sendJson(res, 403, { error: 'Only the session the comment is on can reply to it, from its own pane.' });
  const r = reviews.reply(b.id, b.text, caller);
  if (r.ok) broadcast('review', { surfaceId: at.surfaceId });
  return sendJson(res, r.ok ? 200 : r.status, r.ok ? { ok: true, reply: r.reply } : { error: r.error });
}

// A pane's last seconds, sent to a session (the filmstrip's Send to
// <agent>): the daemon draws them as an animated GIF, which goes into the
// session's project inbox, and the session is told where it is through
// the composer's send path. A person row: it types into the session.
async function sendFilmstrip(req, res, surfaceId) {
  let body;
  try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
  const b = body || {};
  if (typeof b.pane !== 'string' || !/^p[a-z2-7]{7}$/.test(b.pane)) return sendJson(res, 400, { error: 'pane is the pane whose last seconds to send.' });
  if (b.last_ms != null && !(Number.isInteger(b.last_ms) && b.last_ms >= 1000 && b.last_ms <= 60000)) return sendJson(res, 400, { error: 'last_ms is 1000 to 60000.' });
  const sp = (snapshot.projects || []).find((x) => x.sessions.some((y) => y.surfaceId === surfaceId));
  const wt = worktrees.bySurface(surfaceId);
  const project = findProject(sp ? sp.id : wt && wt.projectId);
  if (!project) return sendJson(res, 404, { error: 'No such session.' });
  const last = b.last_ms || 20000;
  const fr = await paneRequest(b.pane, 'pane.frames', { last_ms: last, format: 'gif', max_frames: 120 }, 30000);
  if (!fr.ok) return sendJson(res, 502, { error: fr.err });
  if (!fr.result || !fr.result.data) return sendJson(res, 409, { error: 'The pane drew nothing in that time.' });
  const name = (await paneName(b.pane)) || b.pane;
  const d = new Date();
  const hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join('');
  let file;
  try { file = saveToInbox(project, `${name}-filmstrip-${hms}.gif`, Buffer.from(fr.result.data, 'base64')); } catch (e) { return sendJson(res, 409, { error: e.message }); }
  const secs = fr.result.from && fr.result.to ? Math.max(1, Math.round((Date.parse(fr.result.to) - Date.parse(fr.result.from)) / 1000)) : Math.round(last / 1000);
  const text = `The ${name} pane's last ${secs} seconds, as an animation: ${escapePath(file)}`;
  const r = await sendMessage({ projectId: project.id, surfaceId, text, by: 'filmstrip' });
  return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? { ok: true, path: file, sent: text } : { error: r.error, path: file });
}

function keepPick(cp, where) {
  const kept = picks.record(cp.id);
  const finalState = ['answered', 'declined', 'cancelled', 'expired'].includes(cp.state);
  const go = kept && kept.variants.every((v) => v.file) ? Promise.resolve(kept)
    : picks.keep(cp, { projectId: cp.pane ? projectOfPane(cp.pane) : null, machine: where.machine || null, read: (f) => term.ravenryReadFile(where.daemon, f, { max: picks.MAX_FILE }) });
  go.then(() => { if (finalState) picks.closed(cp); }).catch((e) => console.error('picks:', e.message));
}

// The project whose session runs in a pane of this hub's daemons.
function projectOfPane(pane) {
  const tab = term.tabIdFor('ravenry', pane);
  const wt = tab ? worktrees.bySurface(tab) : null;
  if (wt && wt.projectId) return wt.projectId;
  const p = tab && snapshot && snapshot.projects ? snapshot.projects.find((x) => x.sessions.some((y) => y.surfaceId === tab)) : null;
  return p ? p.id : null;
}

function findProject(id) {
  return (reg && reg.projects.find((p) => p.id === id && !p.hidden)) || loose.find((p) => p.id === id) || unowned.find((p) => p.id === id) || null;
}

function escapePath(p) {
  return /[\s'"\\()&;|<>$`]/.test(p) ? p.replace(/([\s'"\\()&;|<>$`])/g, '\\$1') : p;
}

// The words Send types: the text, then each attached file's path, escaped.
// The New session switch gives a new session the same words.
function withPaths(text, paths) {
  let msg = String(text || '').trim();
  const ps = (Array.isArray(paths) ? paths : []).map(String).filter(Boolean);
  if (ps.length) msg = (msg ? msg + ' ' : '') + ps.map(escapePath).join(' ');
  return msg;
}

// Every write into a terminal goes through here.
// The assistant of the session the board shows in that tab, else the one
// its screen shows (Claude Code when neither says).
function assistantOf(projectId, surfaceId, raw) {
  const snap = snapshot.projects.find((x) => x.id === projectId);
  const s = snap && snap.sessions.find((x) => x.surfaceId === surfaceId);
  if (s && s.assistant) return asst.kindOf(s.assistant);
  return asst.parseAny(raw).kind;
}

// `prefill`: types the text into the prompt and leaves it there for the
// person to send (a page's ask button), never pressing Enter.
// `by` says who typed it, for the pane's input log (server/ravenryd.mjs):
// the composer, the phone, a page's button, a plan's answer, a review
// comment. Every caller relays a person's own words or answer.
async function sendMessage({ projectId, surfaceId, text, paths, choice, prefill = false, by = null }) {
  const project = findProject(projectId);
  if (!project) return { ok: false, status: 404, error: 'No such project.' };
  let tab;
  if (String(surfaceId || '').startsWith('ev:')) return { ok: false, status: 409, error: 'That session has no tab Ravenry can type into.' };
  if (term.kindOf(surfaceId) === 'cmux' && term.CMUX_OUTSIDE) return { ok: false, status: 409, error: term.cannotType('cmux') };
  if (term.kindOf(surfaceId) === 'cmux') {
    const workspaces = await term.cmux.listWorkspaces();
    const ws = workspaces.find((w) => (project.workspaces || []).includes(w.id) && w.surfaces.some((s) => s.id === surfaceId));
    if (!ws) return { ok: false, status: 400, error: "That session is not in this project's workspaces." };
    tab = { kind: 'cmux', workspaceId: ws.id, surfaceId };
  } else {
    // Another terminal's tab (iTerm2, Rex): the board must show it in this
    // project, and the terminal must list it now.
    const snap = snapshot.projects.find((x) => x.id === projectId);
    // A session the hub started in a worktree of this project is the
    // project's whether or not its hooks reported yet (server/worktrees.mjs).
    const wt = worktrees.bySurface(surfaceId);
    const ours = wt && wt.projectId === projectId && wt.state === 'open';
    if (!ours && (!snap || !snap.sessions.some((x) => x.surfaceId === surfaceId && x.terminal))) return { ok: false, status: 400, error: 'That session is not in this project.' };
    let t = null;
    try { t = await freshTab(surfaceId); } catch (e) { return { ok: false, status: 502, error: String(e.message || e) }; }
    if (!t) return { ok: false, status: 409, error: `That ${term.nameOf(term.kindOf(surfaceId))} tab is closed, so nothing was typed.` };
    tab = t;
  }
  if (by) tab = { ...tab, by: String(by).slice(0, 64) };
  const where = term.nameOf(tab.kind);
  // Fresh look at the screen, never the cached one, read as its session's
  // assistant (else as the screen shows).
  const raw = await term.readScreen(tab, 40);
  const kind = assistantOf(projectId, surfaceId, raw);
  const screen = asst.parseScreen(raw, kind);
  const anySurface = project.sendToAnySurface === true; // test registry only
  if (!screen.claudeLive && !anySurface) return { ok: false, status: 409, error: `No ${asst.of(kind).SHORT} session is running in that tab, so nothing was typed.` };
  // Text in the prompt: a half-typed reply is never mixed in; what else it
  // can be is the assistant's to say (Claude Code's suggested reply,
  // server/suggestion.mjs).
  let bashOn = false;
  if (screen.draft && !anySurface) {
    const v = await asst.checkPrompt(kind, tab, screen, { text, choice, where, project: project.id });
    if (!v.ok) return v;
    bashOn = !!v.bashOn;
  }
  if (screen.dialog && !anySurface) {
    if (prefill) return { ok: false, status: 409, error: `A choice is open on screen in ${where}, so nothing was typed. Answer it, then press the button again.` };
    if (choice == null) return { ok: false, status: 409, error: `A choice is open on screen. Pick one of its options, or answer in ${where}.` };
    // Arrow keys to the option, then Enter, each step read back from the
    // screen (server/choose.mjs): some menus ignore the option's digit.
    const r = await asst.chooseOption(kind, {
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
  const msg = withPaths(text, paths);
  if (!msg) return { ok: false, status: 400, error: 'Type something or add a file first.' };
  if (prefill) {
    const a = await term.pasteText(tab, msg.replace(/[\r\n]+/g, ' '));
    if (!a.ok) return { ok: false, status: 502, error: `Could not type it into ${where}: ${a.err || 'no answer'}` };
    wantTick = true;
    return { ok: true, delivered: 'typed', sent: msg };
  }
  const asked = msg;
  const typed = await asst.typeMessage(kind, tab, msg, { bashOn, where });
  if (!typed.ok) return typed;
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
  if (!req.mcPhone && !req.mcTls && !new RegExp(`^(localhost|127\\.0\\.0\\.1|\\[::1\\]):${PORT}$`).test(host)) return false;
  // An app on the phone port (docs/PHONE.md) sends no Origin; a page there
  // would be https.
  const origin = req.headers.origin;
  if (origin && origin.toLowerCase() !== `${req.mcTls ? 'https' : 'http'}://${host}`) return false;
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
  if (!reg || access.pending()) return null;
  try {
    const v = await shipView(shipProjects(), briefFor);
    shipWaiting = v.totals.waitingYou || null;
    lastShip = v;
    return v;
  } catch (e) {
    console.error('ship:', e.message);
    return null;
  }
}

// ------------------------------------------------------------ pages
// The sidebar's pages (server/pages.mjs, docs/PAGES.md). The providers read
// this tick's projects and sessions, the last Ship view, and the rules
// files and suggested rules (each kept a few seconds).

let pagesProjects = [];
let pagesSessions = null;
let scopesKept = { at: 0, value: [] };
function pageScopes() {
  if (Date.now() - scopesKept.at > 10000) {
    try { scopesKept = { at: Date.now(), value: rulefiles.scopes(cfg(), reg ? reg.projects : [], { root: rootFolder() }) }; } catch (e) { console.error('pages: rules files:', e.message); }
  }
  return scopesKept.value;
}
const expand = (p) => (p && p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);
pages.setContext(() => {
  const c = cfg();
  return {
    projects: pagesProjects, regProjects: reg ? reg.projects : [], ship: lastShip, sessions: pagesSessions,
    get scopes() { return pageScopes(); },
    get repeats() { try { return repeats.view(c); } catch { return null; } },
    gatesFor: (file, o) => gates.forPlan(file, o),
    read: (p) => { try { return fs.readFileSync(expand(p), 'utf8'); } catch { return null; } },
  };
});
let pagePoke = null;
pages.onChange(() => { wantTick = true; setTimeout(tick, 30); });
// The shipped Ideas page's items carry what ravenry:mockup-rounds and
// ravenry:idea-thread draw, from the board's Ideas code.
pages.setDecorate((e, src, items) => {
  if (e.id !== 'ideas' || e.origin === 'project' || src.folder.replace(/\/$/, '') !== 'ideas') return items;
  const byId = new Map(ideas.view().ideas.map((x) => [x.id, x]));
  return items.map((it) => {
    const x = byId.get(it.id || String(it.file || '').replace(/\.md$/, ''));
    if (!x) return it;
    const rounds = (x.mockups && x.mockups.rounds) || [];
    const last = rounds[rounds.length - 1] || null;
    return { ...it, $ravenry: { id: x.id, messages: (x.thread || []).length, pending: !!x.pending, mockups: last ? { round: last.n, picked: last.picked, rounds: rounds.length, variants: last.variants.map((v) => ({ key: v.key, title: v.title, img: v.img })) } : null, job: x.mockups && x.mockups.job ? x.mockups.job.round : null } };
  });
});
pages.watch(() => { if (pagePoke) return; pagePoke = setTimeout(() => { pagePoke = null; wantTick = true; tick(); }, 60); });

// The session an ask button types into: the project named (its id or its
// name), its main session, live in its tab.
function askTarget(name) {
  const n = String(name || '').trim().toLowerCase();
  const snap = (snapshot.projects || []).find((p) => !p.unowned && (p.id.toLowerCase() === n || String(p.name).toLowerCase() === n));
  if (!snap) return { error: `No project called ${name || '(none)'} is on the board.`, status: 404 };
  const live = snap.sessions.filter((s) => s.terminal !== false && !s.cannot && !s.cannotType);
  const s = live.find((x) => x.surfaceId === snap.primary) || live[0];
  if (!s) return { error: `No ${snap.name} session is open to type into. Start one, then press the button again.`, status: 409 };
  return { project: snap, session: s };
}

async function pagesWrite(req, res, p) {
  let body;
  try { body = await jsonBody(req, 1e6); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
  const key = String((body && body.key) || '');
  const ok = (v) => { wantTick = true; setTimeout(tick, 30); return sendJson(res, 200, { ok: true, ...v }); };
  try {
    switch (p) {
      case '/api/pages/check': return sendJson(res, 200, { ok: true, ...pages.check(body.text, body.path ? expand(String(body.path)) : null) });
      case '/api/pages/item/set': return ok(pages.setFields(key, body));
      case '/api/pages/item/toggle': return ok(pages.toggleBox(key, body));
      case '/api/pages/item/create': return ok(pages.createItem(key, body));
      case '/api/pages/item/archive': return ok(pages.archive(key, body));
      case '/api/pages/item/restore': return ok(pages.restore(key, body));
      case '/api/pages/trust': return ok(pages.trust(key, body));
      case '/api/pages/approve': return ok(pages.approve(key, body));
      case '/api/pages/dismiss': return ok(pages.dismiss(key));
      case '/api/pages/customize': return ok(pages.customize(key));
      case '/api/pages/ask': {
        // A page's ask button, or the app's own (Ask Claude to fix, Ask
        // Claude to bring these in: { key, kind, text, session }).
        let plan;
        if (body.kind === 'fix' || body.kind === 'merge') {
          const e = pages.get(key);
          if (!e) return sendJson(res, 404, { error: 'No such page.' });
          plan = { text: String(body.text || '').slice(0, 4000), session: e.project ? e.project.id : String(body.session || ''), background: false };
        } else {
          plan = pages.askPlan(key, body.at, body.item);
          if (plan.background && !plan.approved) {
            return sendJson(res, 409, { error: 'This page asks an agent to work on its own. Allow it first.', needsApproval: true, does: plan.does, hash: plan.page.hash });
          }
        }
        const t = askTarget(plan.session);
        if (t.error) return sendJson(res, t.status, { error: t.error });
        const r = await sendMessage({ projectId: t.project.id, surfaceId: t.session.surfaceId, text: plan.text, prefill: !plan.background, by: 'page' });
        if (!r.ok) return sendJson(res, r.status || 500, { error: r.error });
        return ok({ projectId: t.project.id, surfaceId: t.session.surfaceId, typed: plan.text, sent: !!plan.background });
      }
      case '/api/pages/run': {
        const plan = pages.runPlan(key, body.at, body.item);
        const r = await term.ravenryApprove({ title: plan.title, command: plan.command, cwd: plan.cwd, env: plan.env });
        if (!r.ok) return sendJson(res, r.status || 502, { error: r.error });
        pageRuns.set(r.checkpoint.id, { page: plan.page.page.title, label: plan.action.label, project: plan.page.project ? plan.page.project.name : null });
        if (pageRuns.size > 200) pageRuns.delete(pageRuns.keys().next().value);
        // Known now, before (or without) the daemon's event: the phone and
        // the app see it as the page's.
        onCheckpoint(r.checkpoint, { machine: null, daemon: r.daemon });
        return ok({ checkpoint: (({ daemon: _d, ...c }) => ({ ...c, page: { title: plan.page.page.title, label: plan.action.label } }))(r.checkpoint) });
      }
      default: return sendJson(res, 404, { error: 'unknown' });
    }
  } catch (e) {
    if (!e.status) console.error('pages:', p, e);
    const { status: _s, message: _m, stack: _t, ...extra } = e;
    return sendJson(res, e.status || 500, { error: e.message || String(e), ...extra });
  }
}

function afterRegistry(r) {
  if (r) reg = r;
  wantTick = true;
  setTimeout(tick, 30);
}
remoteinstall.onRegistryChange(afterRegistry);

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

// An app brought forward by its bundle id (`open -b`), on the Mac only, with
// the same stand-in rules as openFolder.
function openApp(bundle) {
  const stub = process.env.MC_OPEN_COMMAND ? JSON.parse(process.env.MC_OPEN_COMMAND) : null;
  if (!stub && HOME_OVERRIDE && process.env.MC_OPEN_REAL !== '1') return Promise.resolve({ ok: false, status: 503, error: 'A test board does not open apps. Set MC_OPEN_COMMAND or MC_OPEN_REAL=1.' });
  const [cmd, ...args] = stub || ['/usr/bin/open'];
  return new Promise((resolve) => {
    execFile(cmd, [...args, '-b', bundle], { timeout: 10000 }, (err, _out, stderr) => {
      resolve(err ? { ok: false, status: 500, error: `It did not open: ${(String(stderr || '').trim().split('\n').pop() || err.message).slice(0, 160)}` } : { ok: true });
    });
  });
}

// The Ideas, project and rules writes. Returns true when it answered.
async function phaseD(req, res, p) {
  const c = cfg();
  const fail = (e) => sendJson(res, e.status || 500, { error: e.message || String(e) });
  if (p === '/api/project/new') {
    const body = await jsonBody(req);
    // New project from this folder: the workspace must still be one no
    // project lists, and the folder its own, so nothing else is taken over.
    let adopt = null;
    if (body.workspaceId != null && body.workspaceId !== '') {
      const u = unowned.find((x) => x.workspaces[0] === String(body.workspaceId));
      if (!u) return sendJson(res, 409, { error: 'That workspace is in a project now, or closed. Nothing was made.' });
      const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
      if (!u.folder || !body.existingFolder || real(String(body.existingFolder)) !== real(u.folder)) return sendJson(res, 400, { error: `A project made from ${u.name} starts in its folder. Pick Existing.` });
      adopt = u.workspaces[0];
    }
    const r = await create.createProject(body, { cfg: c, settings: reg.settings, reserve, adopt, launch: launchFor(asst.startChoice(reg.settings, asst.isKind(body.assistant) ? body.assistant : null)) });
    if (r.reg) afterRegistry(r.reg);
    if (r.ok && body.ideaId) { try { ideas.promoted(String(body.ideaId), r.id); } catch { /* idea gone */ } }
    const { reg: _r, ...out } = r;
    return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? out : { error: r.error, code: r.code, folder: r.folder, assistant: r.assistant, assistantNote: r.assistantNote });
  }
  if (p === '/api/project/add-workspace') {
    // Add to a project: the cmux workspace of a session that is not in a
    // project joins the project picked (docs/design/CodexStage2.dc.html,
    // section 1). Only a workspace the board shows as Not in a project now.
    let body = {};
    try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
    const u = unowned.find((x) => x.id === body.from || x.workspaces[0] === body.workspaceId);
    if (!u) return sendJson(res, 409, { error: 'That session is in a project now, or its workspace is closed.' });
    const r = registry.addWorkspace(String(body.projectId || ''), u.workspaces[0]);
    if (!r.ok) return sendJson(res, r.status || 500, { error: r.error });
    afterRegistry(r.reg);
    console.log(`registry: workspace ${u.workspaceTitle} (${u.name}) added to ${r.project.id}`);
    return sendJson(res, 200, { ok: true, projectId: r.project.id, project: r.project.name, workspace: u.workspaceTitle, backup: r.backup ? short(r.backup) : null });
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
    if (!isDir) return sendJson(res, 409, { error: project.folder ? `${project.name}'s folder is not on disk: ${homes.sayFolder(project.folder, project.machine)}.` : `${project.name} has no folder.` });
    const r = await openFolder(project.folder);
    if (!r.ok) return sendJson(res, r.status || 500, { error: r.error });
    return sendJson(res, 200, { ok: true, folder: homes.sayFolder(project.folder, project.machine) });
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
  if (p === '/api/project/assistant') {
    // A project's own assistant after it was created (docs/ASSISTANTS.md,
    // "Starting sessions"): { projectId, assistant: 'claude' | 'codex' | null }.
    // The next New session, Revive and plan start use it; running sessions
    // are not touched. The page's switch is the sheet's "New sessions:"
    // (docs/design/ProjectAssistant.dc.html, round 2, A1).
    let body;
    try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
    if (!body || typeof body.projectId !== 'string' || !('assistant' in body)) return sendJson(res, 400, { error: 'Send { projectId, assistant }.' });
    const r = registry.saveProjectAssistant(body.projectId, body.assistant);
    if (!r.ok) return sendJson(res, r.status, { error: r.error });
    afterRegistry(r.reg);
    const launch = continueLaunch(r.project);
    return sendJson(res, 200, { ok: true, projectId: body.projectId, assistant: r.assistant, starts: launch.kind, note: launch.note || null, backup: r.backup ? short(r.backup) : null });
  }
  if (p === '/api/project/revive') {
    const body = await jsonBody(req);
    const project = findProject(body.projectId);
    if (!project) return sendJson(res, 404, { error: 'No such project.' });
    // The message box's New session switch sends its text and files here:
    // they become the new session's first prompt. With neither, Revive.
    const firstMessage = withPaths(body.text, body.paths) || null;
    const r = await create.revive(project, { cfg: c, settings: reg.settings, reserve, firstMessage, near: nearTab(project.id), launch: continueLaunch(project) });
    watchOpened(r);
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
    const r = await sendMessage({ projectId: project.id, surfaceId: s.surfaceId, text, by: 'plan' });
    return r.ok ? { ...r, via: 'session', surfaceId: s.surfaceId } : r;
  }
  if (mode === 'note') return { ok: true, via: 'brief' };
  const r = await create.revive(project, { cfg: cfg(), settings: reg.settings, reserve, prompt: text, near: nearTab(project.id), launch: continueLaunch(project) });
  watchOpened(r);
  if (r.ok) afterRegistry(r.reg);
  const { reg: _r, ...out } = r;
  return r.ok ? { ...out, via: 'revive' } : out;
}

// The tab a plan's words opened a new session in (deliverPlan through
// Revive): the page selects the session whose tab it is once it shows on
// the board, as it does after New session and Revive.
function opened(r) {
  return r.via === 'revive' ? { surfaceId: r.surfaceId || null, workspaceId: r.workspaceId || null } : {};
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
      if (d.busy) return sendJson(res, 409, { error: `${planner.busyWho(d.busy)} is still on the last change.` });
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
      return sendJson(res, 200, { ok: true, title, via: r.via, delivered: r.delivered || null, ...opened(r) });
    }
    const snapPlan = snapshot.projects.find((x) => x.id === project.id)?.plan;
    if (!file || !snapPlan) return sendJson(res, 409, { error: 'No plan is running in this project.' });
    const by = req.mcPhone ? 'phone' : 'board';
    if (act === 'answer') {
      if (snapPlan.gate && snapPlan.gate.fileOnly) return sendJson(res, 409, { error: 'This gate was passed in the file, not by you: confirm it or reopen it first.' });
      const msg = planrun.writeAnswer(project, file, snapPlan.title, { choice: body.choice || null, text: body.text || null, by });
      wantTick = true;
      const r = await deliverPlan(project, msg, 'answer');
      setTimeout(tick, 30);
      if (!r.ok) return sendJson(res, r.status || 500, { error: `Your answer is written in the brief, but it did not reach the session: ${r.error}` });
      return sendJson(res, 200, { ok: true, via: r.via, delivered: r.delivered || null, sent: body.choice || body.text, ...opened(r) });
    }
    // A gate the file alone passed (ticked, or taken out): the person
    // confirms it, or reopens it and the session is told to stop at it.
    if (act === 'confirm') {
      const g = planrun.writeConfirm(project, file, snapPlan.title, { by });
      wantTick = true;
      setTimeout(tick, 30);
      return sendJson(res, 200, { ok: true, confirmed: g.fileOnly, step: g.n });
    }
    if (act === 'reopen') {
      const msg = planrun.writeReopen(project, file, snapPlan.title);
      wantTick = true;
      const r = await deliverPlan(project, msg, 'answer');
      setTimeout(tick, 30);
      if (!r.ok) return sendJson(res, r.status || 500, { error: `The gate is open again in the brief, but the session did not get the message: ${r.error}` });
      return sendJson(res, 200, { ok: true, via: r.via, delivered: r.delivered || null, ...opened(r) });
    }
    if (act === 'pause' || act === 'stop' || act === 'resume') {
      const msg = planrun.writeState(project, file, snapPlan.title, act === 'pause' ? 'paused' : act === 'stop' ? 'stopped' : 'running');
      wantTick = true;
      const r = await deliverPlan(project, msg, act === 'resume' ? 'start' : 'note');
      setTimeout(tick, 30);
      if (!r.ok) return sendJson(res, r.status || 500, { error: `The plan reads ${act === 'pause' ? 'paused' : act === 'stop' ? 'stopped' : 'running'} in the brief, but the session did not get the message: ${r.error}` });
      return sendJson(res, 200, { ok: true, via: r.via, ...opened(r) });
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

// Who acts as the person (server/person.mjs): a request that stands for a
// person's decision, from a program inside a ravenryd pane or in an ssh
// session on this machine, gets 403 and changes nothing. Returns true when
// it answered.
async function refusedAsPerson(req, res, p) {
  const r = person.personRoute(req.method, p);
  if (!r) return false;
  const who = await person.fromPerson(req, term.ravenryBin(), { strict: !!r.strict, daemons: term.ravenryDaemonsHere });
  if (who.ok) return false;
  console.log(`refused ${r.strict ? 'a checkpoint answer' : `${req.method} ${p}`}: ${who.why}`);
  sendJson(res, 403, { error: `${person.refusal(r)} This request was refused: ${who.why}.`, notPerson: true });
  return true;
}

// Phone access gate (server/phone.mjs). Returns true when it answered.
// On the phone port (server/phonetls.mjs, docs/PHONE.md section 2) every
// request is a phone's: it carries a device token, except the pairing and
// hello, and nothing there is ever the Mac, loopback included.
const PHONE_OFF = 'Phone access is off on the computer. Turn it on there, then scan the code again.';
function gate(req, res, url) {
  if (req.mcTls) {
    const open = (req.method === 'POST' && url.pathname === '/api/phone/pair') || (req.method === 'GET' && url.pathname === '/api/phone/hello');
    const c = phone.check(req);
    if (c.ok) { req.mcPhone = c.hash; req.mcDevice = c.id; return false; }
    if (open) { req.mcPairing = req.method === 'POST'; return false; }
    sendJson(res, 401, { error: c.had ? phone.SIGNED_OUT : phone.NOT_SIGNED_IN, signedOut: true });
    return true;
  }
  if (!phone.hostOk(req.headers.host, PORT)) {
    res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Misdirected request: this board answers only to localhost or its own Wi-Fi address.\n');
    return true;
  }
  if (phone.isLoopback(req)) { req.mcLocal = true; return false; }
  // From the Wi-Fi, the browser path (the QR's `/?k=` sign-in, then its
  // cookie or a Bearer token) opens only while phone access is on, the
  // switch the phone port follows (docs/PHONE.md section 2).
  if (!phone.access()) {
    const page = req.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('.html'));
    if (page) phone.signedOutPage(res, 403, PHONE_OFF);
    else sendJson(res, 403, { error: PHONE_OFF });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('k')) {
    phone.signIn(req, res, url.searchParams.get('k') || '');
    return true;
  }
  const c = phone.check(req);
  if (c.ok) { req.mcPhone = c.hash; req.mcDevice = c.id; return false; }
  const page = req.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('.html'));
  if (page) phone.signedOutPage(res, 401, c.had ? phone.SIGNED_OUT : phone.NOT_SIGNED_IN);
  else sendJson(res, 401, { error: phone.SIGNED_OUT, signedOut: true });
  return true;
}

// The QR card and New key: the Mac only, never a phone. While phone
// access is on it also pairs the app (docs/PHONE.md section 3).
const PHONE_PORT = phonetls.phonePort(PORT);
function phoneApp() { return { port: PHONE_PORT, pin: phonetls.identity().pin, hosts: phone.phoneHosts(phonetls.tailscaleAddresses()) }; }
function phoneCard(opts = {}) { return { ok: true, ...phone.card(PORT, phone.access() ? phoneApp() : null, opts), port: PHONE_PORT }; }

// After New key, live streams held by phones end, so their pages find out;
// with a device id, only that device's (revoked, or signed out).
function dropPhoneStreams(device = null) {
  for (const res of clients) if (res.mcPhone && (!device || res.mcDevice === device)) { clients.delete(res); try { res.end(); } catch { /* gone */ } }
}

// The phone port follows the phone access switch.
function syncPhonePort() {
  if (phone.access()) phonetls.start(PHONE_PORT, handleRequest, handleUpgrade);
  else phonetls.stop();
}

// An app's alerts reach its live streams too (server/push.mjs).
push.onLive((device, msg) => {
  const j = JSON.stringify(msg);
  for (const res of clients) if (res.mcDevice === device) res.write(`event: phone\ndata: ${j}\n\n`);
});

// The phone's own routes (docs/PHONE.md section 3): hello and pairing on
// the phone port, then what a signed-in device asks about itself. Returns
// true when it answered.
async function phoneDeviceRoute(req, res, p) {
  if (req.method === 'GET' && p === '/api/phone/hello') return sendJson(res, 200, { ok: true, name: phone.hubName(), api: 1, port: PHONE_PORT }), true;
  if (req.method === 'POST' && p === '/api/phone/pair') {
    if (await refusedAsPerson(req, res, p)) return true;
    if (!req.mcTls) return sendJson(res, 404, { error: `Pair on the phone port (${PHONE_PORT}).` }), true;
    let body;
    try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }), true; }
    const r = phone.pair({ ...body, ua: req.headers['user-agent'] });
    if (!r.ok) return sendJson(res, r.status, { error: r.error }), true;
    console.log(`phone: paired ${r.device.name} (${r.device.id})`);
    return sendJson(res, 200, { ok: true, device: r.device, token: r.token, hub: { name: phone.hubName(), pin: phonetls.identity().pin, port: PHONE_PORT, api: 1 } }), true;
  }
  if (req.method === 'GET' && p === '/api/phone/me') {
    if (!req.mcDevice) return sendJson(res, 401, { error: phone.NOT_SIGNED_IN, signedOut: true }), true;
    return sendJson(res, 200, { ok: true, device: phone.device(req.mcDevice), hub: { name: phone.hubName(), port: PHONE_PORT, api: 1 }, access: phone.access() }), true;
  }
  if (req.method === 'POST' && (p === '/api/phone/unpair' || p === '/api/phone/push')) {
    if (!allowedWrite(req)) return sendJson(res, 403, { error: 'Writes are only accepted from the board itself.' }), true;
    if (await refusedAsPerson(req, res, p)) return true;
    if (!req.mcDevice) return sendJson(res, 401, { error: phone.NOT_SIGNED_IN, signedOut: true }), true;
    let body;
    try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }), true; }
    if (p === '/api/phone/unpair') {
      phone.revoke(req.mcDevice);
      console.log(`phone: ${req.mcDevice} signed itself out`);
      setTimeout(() => dropPhoneStreams(req.mcDevice), 0);
      return sendJson(res, 200, { ok: true }), true;
    }
    const t = push.checkTarget(body);
    if (!t.ok) return sendJson(res, t.status, { error: t.error }), true;
    phone.setPush(req.mcDevice, t.target);
    return sendJson(res, 200, { ok: true, push: t.target ? t.target.kind : 'none' }), true;
  }
  return false;
}

// A WebSocket upgrade: the terminal on the phone (server/termproxy.mjs,
// docs/PHONE.md section 6), a person row. On the board's own port only
// from this machine, judged like any other caller.
async function handleUpgrade(req, sock, head) {
  sock.on('error', () => {});
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const no = (status, text) => { try { sock.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`); } catch { /* gone */ } };
  if (p !== '/api/term') return no('404 Not Found', 'No such stream.');
  if (req.mcTls) {
    const c = phone.check(req);
    if (!c.ok) return no('401 Unauthorized', phone.SIGNED_OUT);
    req.mcPhone = c.hash; req.mcDevice = c.id;
  } else if (!phone.isLoopback(req)) return no('403 Forbidden', 'The terminal stream is on the phone port.');
  const r = person.personRoute('GET', p);
  const who = await person.fromPerson(req, term.ravenryBin(), { daemons: term.ravenryDaemonsHere });
  if (!who.ok) {
    console.log(`refused GET ${p}: ${who.why}`);
    return no('403 Forbidden', `${person.refusal(r)} This request was refused: ${who.why}.`);
  }
  return termproxy.handle(req, sock, head, url);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (gate(req, res, url)) return;
    if (accessWait(req, res, url)) return;
    if (req.method === 'GET' && p === '/api/whoami') return sendJson(res, 200, { local: !!req.mcLocal });
    if (p === '/api/phone' || p.startsWith('/api/phone/')) {
      if (await phoneDeviceRoute(req, res, p)) return;
      if (!req.mcLocal) return sendJson(res, 403, { error: 'Only the Mac shows the phone code.' });
      if (req.method === 'POST' && !allowedWrite(req)) return sendJson(res, 403, { error: 'Writes are only accepted from the board itself.' });
      if (await refusedAsPerson(req, res, p)) return;
      if (req.method === 'GET' && p === '/api/phone') return sendJson(res, 200, phoneCard({ fresh: url.searchParams.get('code') === 'new' }));
      if (req.method === 'GET' && p === '/api/phone/devices') return sendJson(res, 200, { ok: true, devices: phone.devices() });
      if (req.method === 'POST' && p === '/api/phone/new-key') {
        phone.rotate();
        dropPhoneStreams();
        return sendJson(res, 200, phoneCard());
      }
      let body;
      try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
      if (p === '/api/phone/devices/revoke') {
        const id = String((body && body.id) || '');
        if (!phone.revoke(id)) return sendJson(res, 404, { error: 'No such device.' });
        console.log(`phone: revoked ${id}`);
        dropPhoneStreams(id);
        return sendJson(res, 200, { ok: true, devices: phone.devices() });
      }
      if (p === '/api/phone/devices/rename') {
        if (!phone.rename(String((body && body.id) || ''), body && body.name)) return sendJson(res, 404, { error: 'No such device, or no name.' });
        return sendJson(res, 200, { ok: true, devices: phone.devices() });
      }
      if (p === '/api/phone/access') {
        phone.setAccess(!!(body && body.on === true));
        syncPhonePort();
        if (!phone.access()) dropPhoneStreams();
        return sendJson(res, 200, phoneCard());
      }
      return sendJson(res, 404, { error: 'unknown' });
    }
    if (p === '/api/term') {
      // The terminal stream is a WebSocket (handleUpgrade); a plain request
      // is still judged first, as every person row is.
      if (await refusedAsPerson(req, res, p)) return;
      return sendJson(res, 426, { error: 'Open /api/term as a WebSocket with the subprotocol ravenry.v1.' });
    }
    // Before its first state is built (a second or two, whatever the data):
    // 503 "starting", at once, never a held request (the app counts any
    // answer as the hub being up; docs in server/access.mjs's 503 too).
    if (req.method === 'GET' && p === '/api/state') return snapshot.generatedAt ? sendJson(res, 200, snapshot) : sendJson(res, 503, { ...snapshot, starting: true, waitingFor: null, folder: null, error: 'Ravenry is starting: reading your projects.' });
    if (req.method === 'GET' && p === '/api/brief') {
      // A project's brief as written, for the app's Brief tab: its text,
      // when it last changed, and the assistant of the project's session
      // then (a brief is written by its sessions). project: an id, a name
      // or a folder.
      const id = projectIdOf(url.searchParams.get('project') || '');
      const project = id && findProject(id);
      const file = project && registry.briefPath(project);
      if (!file || !fs.existsSync(file)) return sendJson(res, 404, { error: 'No brief for that project.' });
      let st;
      try { st = fs.statSync(file); } catch { return sendJson(res, 404, { error: 'No brief for that project.' }); }
      if (st.size > 1024 * 1024) return sendJson(res, 413, { error: 'The brief is over 1 MB.' });
      const view = (snapshot.projects || []).find((x) => x.id === id);
      const writer = (view && view.sessions || []).find((x) => x.assistant && Date.parse(x.startedAt || x.since || 0) <= st.mtimeMs) || (view && view.sessions || [])[0] || null;
      const by = writer ? ({ claude: 'Claude', codex: 'Codex' }[writer.assistant] || null) : null;
      return sendJson(res, 200, { project: id, file, path: homes.sayLocal(file), text: fs.readFileSync(file, 'utf8'), updatedAt: new Date(st.mtimeMs).toISOString(), by });
    }
    if (req.method === 'GET' && p === '/api/decisions') {
      // The ledger, newest first (server/decisions.mjs): an open read, so an
      // agent checks it before asking. project: an id, a name or a folder.
      const pq = url.searchParams.get('project');
      let projectId;
      if (pq != null && pq !== '') {
        projectId = projectIdOf(pq);
        if (!projectId) return sendJson(res, 404, { error: 'No such project.' });
      }
      const list = decisions.query({ projectId, search: url.searchParams.get('search') || '', all: url.searchParams.has('all') && url.searchParams.get('all') !== '0' });
      // An agent's read counts ("Read 5 times today"): agent=1 (what
      // `ravenry decisions` sends), or a caller inside a pane. The board's
      // and the app's own looks do not.
      const agent = url.searchParams.get('agent') === '1' || (!req.mcPhone && list.length && (await person.callerPane(req, term.ravenryBin())).pane);
      if (agent && list.length) { try { decisions.countReads(list.map((d) => d.id)); } catch (e) { console.error('decisions:', e.message); } }
      const fresh = agent ? decisions.query({ projectId, search: url.searchParams.get('search') || '', all: true }) : list;
      return sendJson(res, 200, { ok: true, project: projectId || null, decisions: list.map((d) => decisions.view(fresh.find((x) => x.id === d.id) || d)) });
    }
    {
      const m = req.method === 'GET' && /^\/api\/checkpoints\/([a-z0-9]{1,16})\/variants\/(\d)$/.exec(p);
      if (m) return serveVariant(res, m[1], Number(m[2]));
    }
    {
      // A worktree session's review comments (server/reviews.mjs), oldest
      // first: an open read.
      const m = req.method === 'GET' && /^\/api\/sessions\/([^/]+)\/review$/.exec(p);
      if (m) return sendJson(res, 200, { ok: true, comments: reviews.list(decodeURIComponent(m[1])) });
    }
    {
      // What each session of a project changed (server/filesview.mjs): an
      // open read, for a session's panel and the project's grid.
      const m = req.method === 'GET' && /^\/api\/projects\/([^/]+)\/files$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const project = findProject(id);
        const sp = (snapshot.projects || []).find((x) => x.id === id);
        if (!project || !sp) return sendJson(res, 404, { error: 'No such project.' });
        const sessions = sp.sessions.filter((x) => !x.handed).map((x) => {
          const w = worktrees.bySurface(x.surfaceId);
          return { surfaceId: x.surfaceId, topic: x.topic, assistant: x.assistant, machine: x.machine || null, pane: term.kindOf(x.surfaceId) === 'ravenry' ? x.surfaceId.slice('ravenry:'.length) : null, worktree: w && w.projectId === id ? w : null };
        });
        // A session the hub started in a worktree of this project is the
        // project's whether or not its hooks reported yet.
        for (const w of worktrees.load()) {
          if (w.projectId === id && w.state === 'open' && w.pane && !w.machine && !sessions.some((x) => x.surfaceId === w.surfaceId)) sessions.push({ surfaceId: w.surfaceId, topic: w.name, assistant: null, machine: null, pane: w.pane, worktree: w });
        }
        const filesOf = async (pane) => { const r = await paneRequest(pane, 'pane.files', { no_git: true }, 5000); return r.ok ? r.result.files : null; };
        try {
          return sendJson(res, 200, await projectFiles({ projectId: id, folder: project.folder, sessions, filesOf }));
        } catch (e) { return sendJson(res, 500, { error: `Could not read the files: ${e.message}` }); }
      }
    }
    {
      const m = req.method === 'GET' && /^\/api\/sessions\/([^/]+)\/(diff|worktree)$/.exec(p);
      if (m) {
        const w = worktrees.bySurface(decodeURIComponent(m[1]));
        if (!w) return sendJson(res, 404, { error: 'That session has no worktree.' });
        if (m[2] === 'worktree') return sendJson(res, 200, { ok: true, worktree: w });
        const d = await worktrees.diff(w);
        return sendJson(res, d.ok ? 200 : d.status, d.ok ? { ...d, worktree: w } : { error: d.error });
      }
    }
    if (req.method === 'GET' && p === '/api/machines') {
      // Each machine with its version beside this hub's build, and the last
      // install or uninstall (server/remoteinstall.mjs); on the Mac, the
      // hosts of ~/.ssh/config and the builds it can install.
      const b = req.mcLocal ? remoteinstall.builds() : null;
      return sendJson(res, 200, { ok: true, machines: remoteinstall.view(), ...(req.mcLocal ? { hosts: machines.sshHosts(), builds: b ? { version: b.version, systems: Object.keys(b.systems), source: b.source } : null } : {}) });
    }
    if (req.method === 'GET' && p === '/api/checkpoints') return sendJson(res, 200, { ok: true, checkpoints: checkpointsView(snapshot.projects || []).concat(url.searchParams.has('all') ? checkpoints.list({ all: true }).filter((c) => !['open', 'running'].includes(c.state)).map(({ daemon: _d, ...c }) => c) : []) });
    if (req.method === 'GET' && p === '/api/setup/hooks') return sendJson(res, 200, { ok: true, claude: safe(() => hookinstall.status(hookinstall.readSettings().json)), codex: hookinstall.codexInstalled() ? safe(() => hookinstall.codexStatus()) : null });
    if (req.method === 'GET' && p === '/api/live') {
      const r = await liveScreen(url.searchParams.get('surface') || '', url.searchParams.get('v'));
      return sendJson(res, r.status, r.body);
    }
    if (req.method === 'GET' && p === '/api/settings/projects-root') return sendJson(res, 200, { ok: true, local: !!req.mcLocal, ...projectsRoot.view(registry.load() || reg) });
    if (req.method === 'GET' && p === '/api/settings/handoff') return sendJson(res, 200, { ok: true, settings: registry.handoffSettings(registry.load()?.settings) });
    if (req.method === 'GET' && p === '/api/settings/assistant') return sendJson(res, 200, { ok: true, ...assistantsView() });
    if (req.method === 'GET' && p === '/api/alerts') return sendJson(res, 200, { ok: true, local: !!req.mcLocal, ...alerts.status() });
    if (req.method === 'GET' && p === '/api/alerts/setup') {
      if (!req.mcLocal) return sendJson(res, 403, { error: alerts.PHONE_REFUSED });
      if (await refusedAsPerson(req, res, p)) return;
      return sendJson(res, 200, { ok: true, local: true, ...alerts.setupView(alertsQr) });
    }
    if (req.method === 'GET' && p === '/api/meta') {
      const c = cfg();
      return sendJson(res, 200, { kinds: create.KINDS, globalRules: rules.globalHeadings(c), globalPath: short(c.globalClaudeMd), projectsRoot: short(c.projectsRoot), launchCommand: c.launchCommand, assistants: assistantsView() });
    }
    if (req.method === 'GET' && p === '/api/project/folders') return sendJson(res, 200, projectFolders());
    if (req.method === 'GET' && p === '/api/plan/draft') {
      const project = findProject(url.searchParams.get('projectId') || '');
      if (!project) return sendJson(res, 404, { error: 'No such project.' });
      return sendJson(res, 200, { ok: true, draft: planner.view(project.id) });
    }
    if (req.method === 'GET' && p === '/api/pages') return sendJson(res, 200, { ok: true, pages: snapshot.pages || [] });
    if (req.method === 'GET' && p === '/api/pages/page') {
      const v = pages.view(url.searchParams.get('key') || '');
      return v ? sendJson(res, 200, { ok: true, page: v }) : sendJson(res, 404, { error: 'No such page.' });
    }
    if (req.method === 'GET' && p === '/api/pages/img') {
      const pic = pages.picture(url.searchParams.get('key') || '', url.searchParams.get('path') || '');
      if (!pic) return sendJson(res, 404, { error: 'not a picture of this page' });
      res.writeHead(200, { 'Content-Type': pic.type, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(pic.file).on('error', () => res.end()).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/pages/docs') {
      const t = pages.docs(url.searchParams.get('topic') || '');
      return t ? sendJson(res, 200, { ok: true, text: t }) : sendJson(res, 404, { error: `No topic called ${url.searchParams.get('topic')} in the page docs. Run ravenry page docs for all of them.` });
    }
    if (req.method === 'GET' && p === '/api/ideas') return sendJson(res, 200, ideas.view());
    if (req.method === 'GET' && p.startsWith('/api/ideas/img/')) {
      const abs = ideas.picturePath(decodeURIComponent(p.slice(15)));
      if (!abs) return sendJson(res, 404, { error: 'no such picture' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
      return fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
    }
    // Your rules: the global CLAUDE.md as before (its count is the tab's),
    // and every scope's CLAUDE.md beside its AGENTS.md (server/rulefiles.mjs).
    if (req.method === 'GET' && p === '/api/rules/mine') { const c = cfg(); return sendJson(res, 200, { ...repeats.mine(c), scopes: rulefiles.scopes(c, reg ? reg.projects : [], { root: rootFolder() }) }); }
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
      res.mcDevice = req.mcDevice || null;
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
      // A person's decision (server/person.mjs ROUTES, docs/PERSON.md):
      // never from a program inside a pane or in an ssh session.
      if (await refusedAsPerson(req, res, p)) return;
      if (p.startsWith('/api/alerts/')) return alertsWrite(req, res, p);
      if (p.startsWith('/api/plan/')) return planWrite(req, res, p);
      if (p.startsWith('/api/pages/')) return pagesWrite(req, res, p);
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
        // The person's own words: from the composer, or the phone.
        const r = await sendMessage({ ...body, by: req.mcPhone ? 'phone' : 'composer' });
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
      if (p === '/api/checkpoints/answer') {
        // A person's answer (the app, the phone), never a program inside a
        // pane: refusedAsPerson above. The body may hold a secret: it is
        // parsed here, never echoed in an error or a log, and goes only to
        // the daemon that holds the checkpoint.
        let body = null;
        try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        const by = typeof body.by === 'string' && body.by ? body.by : req.mcPhone ? 'phone' : 'desktop';
        const r = await checkpoints.answer({ ...body, by }, term.ravenryAnswer);
        body = null;
        if (r.ok) { wantTick = true; setTimeout(tick, 30); }
        return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? { ok: true, checkpoint: (({ daemon: _d, ...c }) => c)(r.checkpoint) } : { error: r.error });
      }
      if (p === '/api/sessions/move') {
        let body;
        try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        const r = await moveSession(body);
        return sendJson(res, r.ok ? 200 : r.status || 500, r);
      }
      if (p === '/api/sessions/resume') {
        let body;
        try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        const r = await resumeSession(body);
        return sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? r : { error: r.error, ...(r.open ? { open: true } : {}) });
      }
      if (p === '/api/sessions/start') {
        const t0 = Date.now();
        // A session in a ravenryd pane, here or on a machine
        // (server/sessionstart.mjs): the app's first-launch "Start" and its
        // New session call this instead of pane.new.
        let body;
        try { body = await jsonBody(req, 1e5); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        const project = body && body.projectId != null ? findProject(body.projectId) : null;
        // worktree: true, a parallel session on its own branch in a sibling
        // folder (server/worktrees.mjs). This computer only for now.
        let made = null;
        if (body && body.worktree === true) {
          if (!project) return sendJson(res, 400, { error: 'A worktree session belongs to a project: give projectId.' });
          if ((body.machine != null && body.machine !== '') || project.machine) return sendJson(res, 409, { error: 'Worktree sessions run on this computer only for now; this project is on another machine.' });
          if (body.name != null && (typeof body.name !== 'string' || body.name.length > 100)) return sendJson(res, 400, { error: 'name is the session\'s name, at most 100 characters.' });
          const tw = Date.now();
          made = await worktrees.create(typeof body.folder === 'string' && body.folder.trim() ? body.folder.trim() : project.folder, { name: body.name || null });
          if (made) made.ms = Date.now() - tw;
          if (!made.ok) return sendJson(res, made.status, { error: made.error });
        } else if (body && body.worktree != null && body.worktree !== false) return sendJson(res, 400, { error: 'worktree is true or false.' });
        const pl = sessionstart.plan(made ? { ...body, folder: made.cwd } : body, {
          project,
          launch: (proj, kind) => (kind ? launchFor({ kind, note: null }) : proj ? continueLaunch(proj) : launchFor(asst.startChoice(reg ? reg.settings : {}))),
          briefPath: (proj) => registry.briefPath(proj),
          briefExists: (f) => fs.existsSync(f),
          machines: machines.status().map((m) => m.name),
          binPath: assistantPath,
          worktree: made ? { branch: made.branch, folder: made.folder } : null,
          decisions: project ? decisions.promptLine(project.id) : '',
        });
        if (!pl.ok) {
          if (made) await worktrees.removeTree(made, { force: true });
          return sendJson(res, pl.status, { error: pl.error });
        }
        if (made) pl.labels = { ...pl.labels, 'ravenry.worktree': made.branch.slice(0, 256) };
        const r = await term.ravenryStart(pl);
        if (!r.ok) {
          if (made) await worktrees.removeTree(made, { force: true });
          return sendJson(res, 502, { error: `Could not start it: ${r.err}` });
        }
        if (made) worktrees.remember(made, { surfaceId: r.surfaceId, pane: r.pane && r.pane.id, projectId: project.id });
        watchOpened(r);
        // How long each part took (a slow start shows where in the log).
        console.log(`sessions: started ${r.surfaceId} in ${Date.now() - t0} ms${made ? ` (worktree in ${made.ms} ms)` : ''}: ${Object.entries(r.timing || {}).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        if (project && pl.machine && project.machine !== pl.machine) afterRegistry(registry.update((rg) => { const x = rg.projects.find((y) => y.id === project.id); if (x) x.machine = pl.machine; }));
        wantTick = true; setTimeout(tick, 30);
        return sendJson(res, 200, { ok: true, surfaceId: r.surfaceId, pane: r.pane, machine: r.machine || null, projectId: project ? project.id : null, command: pl.line, assistant: pl.kind, ...(made ? { worktree: { branch: made.branch, folder: made.folder, base: made.base, baseBranch: made.baseBranch } } : {}) });
      }
      if (p.startsWith('/api/decisions/')) return decisionsWrite(req, res, p);
      {
        const m = /^\/api\/sessions\/([^/]+)\/(comment|merge|discard|unmerge|delete-branch)$/.exec(p);
        if (m) return worktreeWrite(req, res, decodeURIComponent(m[1]), m[2]);
        const rv = /^\/api\/sessions\/([^/]+)\/review\/(comment|remove|send)$/.exec(p);
        if (rv) return reviewWrite(req, res, decodeURIComponent(rv[1]), rv[2]);
        if (p === '/api/review/reply') return reviewReply(req, res);
        const f = /^\/api\/sessions\/([^/]+)\/filmstrip$/.exec(p);
        if (f) return sendFilmstrip(req, res, decodeURIComponent(f[1]));
      }
      if (p === '/api/machines/add' || p === '/api/machines/remove' || p === '/api/machines/retry') {
        // The machines the hub reaches over ssh (server/machines.mjs).
        // Added and removed on the Mac only: it runs ssh with the Mac's keys.
        if (!req.mcLocal && p !== '/api/machines/retry') return sendJson(res, 403, { error: 'Add and remove machines on the Mac.' });
        let body;
        try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        if (p === '/api/machines/retry') return sendJson(res, 200, { ok: machines.retry(String(body.name || '')), machines: remoteinstall.view() });
        const r = p === '/api/machines/add' ? machines.add(body || {}) : machines.remove(String((body && body.name) || ''));
        if (!r.ok) return sendJson(res, r.status || 500, { error: r.error });
        afterRegistry(r.reg);
        wantTick = true; setTimeout(tick, 30);
        return sendJson(res, 200, { ok: true, machines: remoteinstall.view() });
      }
      if (p === '/api/machines/install' || p === '/api/machines/uninstall') {
        // ravenryd and the hooks put on a machine over ssh, or taken off it
        // (server/remoteinstall.mjs). On the Mac only: it runs ssh with the
        // Mac's keys. Answers at once; GET /api/machines shows the steps.
        if (!req.mcLocal) return sendJson(res, 403, { error: 'Install and uninstall on the Mac.' });
        let body;
        try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        const name = String((body && body.name) || '');
        const r = p === '/api/machines/install'
          ? remoteinstall.install(name, { replaceHooks: !!body.replaceHooks })
          : remoteinstall.uninstall(name, { endSessions: !!body.endSessions });
        if (!r.ok) return sendJson(res, r.status || 500, { error: r.error });
        wantTick = true; setTimeout(tick, 30);
        return sendJson(res, 200, { ok: true, job: r.job, machines: remoteinstall.view() });
      }
      if (p === '/api/setup/hooks') {
        // The app's first-launch setup: Ravenry's hooks in Claude Code's and
        // Codex's settings, with `ravenryd hook` (the app gives its path).
        if (!req.mcLocal) return sendJson(res, 403, { error: 'Set up the hooks on the Mac.' });
        let body;
        try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        const r = hookinstall.setupWithRavenryd({ ravenryd: body.ravenryd, dry: !!body.dry, remove: !!body.remove });
        return sendJson(res, r.ok ? 200 : 400, r.ok ? { ...r, claude: r.claude && { ...r.claude, backup: r.claude.backup ? short(r.claude.backup) : null } } : { error: r.error });
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
      if (p === '/api/settings/assistant') {
        // Start new sessions with: Claude Code or Codex, and the model Codex
        // runs when its configured one is refused. Any signed-in page.
        let body;
        try { body = await jsonBody(req, 1e4); } catch { return sendJson(res, 400, { error: 'Send JSON.' }); }
        const r = registry.saveAssistantSettings(body);
        if (!r.ok) return sendJson(res, r.status, { error: r.error });
        afterRegistry(r.reg);
        return sendJson(res, 200, { ok: true, ...assistantsView(), backup: r.backup ? short(r.backup) : null });
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
        // The cmux app itself (a session's other process runs there, in a tab the board does not know).
        if (body.app === 'cmux' && !body.surfaceId) { const a = await openApp('com.cmuxterm.app'); return sendJson(res, a.ok ? 200 : 500, a.ok ? { ok: true, where: 'cmux', app: true } : { error: a.error }); }
        if (body.surfaceId && (term.kindOf(body.surfaceId) !== 'cmux' || term.CMUX_OUTSIDE)) {
          // A session in iTerm2 or Rex (or cmux, followed from Ravenry
          // mode): bring that tab forward.
          const snap = snapshot.projects.find((x) => x.id === project.id);
          const isCmux = term.kindOf(body.surfaceId) === 'cmux';
          // A session's tab, or a cmux tab where one of its sessions also runs.
          const twin = isCmux && snap && snap.sessions.some((x) => x.alsoOpen && x.alsoOpen.surfaceId === body.surfaceId);
          if (!snap || (!snap.sessions.some((x) => x.surfaceId === body.surfaceId) && !twin)) return sendJson(res, 404, { error: 'No such session in that project.' });
          // cmux refused this board its socket: the cmux app comes forward
          // (`open -b`), which needs no socket, and the person picks the tab.
          const cmuxApp = async () => { const a = await openApp('com.cmuxterm.app'); return sendJson(res, a.ok ? 200 : 500, a.ok ? { ok: true, where: 'cmux', app: true } : { error: a.error }); };
          let denied = false;
          const t = String(body.surfaceId).startsWith('ev:') ? null : await freshTab(body.surfaceId).catch((e) => { denied = !!e.denied; return null; });
          if (!t && isCmux && (denied || (otherTabs.cmux && otherTabs.cmux.denied))) return cmuxApp();
          if (!t) return sendJson(res, 409, { error: `That ${term.nameOf(term.kindOf(body.surfaceId))} tab is closed.` });
          const r = await term.focus(t);
          if (!r.ok && isCmux && term.CMUX_DENIED.test(r.err || '')) return cmuxApp();
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
}

const server = http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);

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
startlog.watchStalls();
void startlog.profileStart();
console.log(`start: modules loaded, ${Math.round(process.uptime() * 1000)} ms after start`);
startlog.phase('listen');
server.listen(PORT, () => {
  try { fs.mkdirSync(registry.RAVENRY_HOME, { recursive: true }); fs.writeFileSync(BOARD_FILE, JSON.stringify({ port: PORT, pid: process.pid, at: new Date().toISOString() }) + '\n'); } catch (e) { console.error('board.json:', e.message); }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { forgetPort(); process.exit(0); });
  process.once('exit', forgetPort);
  const lan = phone.lanAddresses()[0];
  console.log(`Ravenry on http://localhost:${PORT}${lan ? `, phones on http://${lan.address}:${PORT}` : ''}  (registry ${registry.REGISTRY_PATH})`);
  // Phone access on: the phone port opens with the board (docs/PHONE.md).
  void startlog.step('phone port', () => syncPhonePort());
  // The desktop app's hub after an update: its hooks follow it to this
  // version's folder (server/hookinstall.mjs refreshAppHooks).
  if (process.env.RAVENRY_HUB_SERVICE === '1') {
    void startlog.step('hooks refresh', () => {
      const r = hookinstall.refreshAppHooks();
      for (const [who, ch] of Object.entries(r)) if (ch.length) console.log(`hooks: ${who}'s moved to this version: ${ch.join('; ')}`);
    });
  }
});
tick();
setInterval(tick, TICK_MS);
// A plan file's git facts came in (server/plans.mjs reads them in the background).
let gitSoon = null;
onGitAnswer(() => { if (!gitSoon) gitSoon = setTimeout(() => { gitSoon = null; wantTick = true; void tick(); }, 600); });
// A session's work folder came in (server/folders.mjs scans transcripts in the background).
onFolderScan(() => { if (!gitSoon) gitSoon = setTimeout(() => { gitSoon = null; wantTick = true; void tick(); }, 600); });
// The processes at once, so a session in a pane (one made before an update
// too) is tied to it in the first seconds, not at the minute's refresh.
void startlog.step('first process list', () => refreshProcs());
setInterval(refreshProcs, 60000);
void startlog.step('ideas', () => ideas.load());
setTimeout(() => void startlog.step('ship', () => refreshShip()), 3000);
setInterval(refreshShip, 30000);
// The repeats detector (server/repeats.mjs): daily, and at start when the
// last run is older than a day. The real board seeds itself at start.
if (cfg().repeatsAuto) setTimeout(() => (access.pending() ? Promise.resolve() : repeats.ensureSeed(cfg())).then(() => { wantTick = true; }).catch((e) => console.error('repeats seed:', e.message)), 5000);
repeats.schedule(cfg);

// cmux events only make the next refresh come sooner.
let soon = null;
if (process.env.MC_NO_EVENTS !== '1') {
  term.cmux.watchEvents(() => {
    if (soon) return;
    soon = setTimeout(() => { soon = null; tick(); }, 400);
  });
}

// ravenryd's agent status channel: what its panes' hooks report reaches the
// sessions as hook records, a pane change makes the next refresh come
// sooner, and a hook that waits (a Stop) gets the hand-off's answer.
if (process.env.MC_NO_EVENTS !== '1') {
  term.ravenryStatus({
    onRecord: (rec) => { events.ingestDaemon(rec); },
    onChange: () => {
      if (soon) return;
      soon = setTimeout(() => { soon = null; tick(); }, 400);
    },
    onCheckpoint,
    onLost: (daemon) => checkpoints.dropDaemon(daemon),
    decide: term.ravenryDecider,
  });
}

